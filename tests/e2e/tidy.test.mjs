// End-to-end: real extension + real helper (installed by install.sh) + real tab groups in Chromium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openSites, tabState, tidyFromPopup, waitFor, sleep } from './harness.mjs';

/** Group titles and, for each group, whether its tabs sit next to each other. */
function summarize(state) {
  const byGroup = new Map();
  state.forEach((t, i) => {
    if (!t.group) return;
    if (!byGroup.has(t.group)) byGroup.set(t.group, []);
    byGroup.get(t.group).push(i);
  });
  const contiguous = [...byGroup.values()].every((idx) => idx.every((v, k) => k === 0 || v === idx[k - 1] + 1));
  return { titles: [...byGroup.keys()].sort(), sizes: Object.fromEntries(byGroup), contiguous };
}

test('Claude backend: groups the window by task into real, contiguous tab groups', async () => {
  const b = await launch({ helper: 'fake' });
  try {
    await openSites(b.ctx);
    const popup = await tidyFromPopup(b.ctx, b.extId);
    const status = await popup.textContent('#status');
    const s = summarize(await tabState(b.sw));
    assert.deepEqual(s.titles, ['Python debugging', 'Trip to Lisbon'], `status: ${status}`);
    assert.equal(s.sizes['Python debugging'].length, 4);
    assert.equal(s.sizes['Trip to Lisbon'].length, 3);
    assert.ok(s.contiguous, 'tabs of each group sit next to each other');
    // The helper ran claude once, sandboxed, with the default model and only titles/hosts on stdin.
    const calls = b.claudeCalls();
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('--model=haiku'));
    for (const flag of ['--safe-mode', '--no-session-persistence', '--strict-mcp-config']) {
      assert.ok(calls[0].includes(flag), `claude started with ${flag}`);
    }
    assert.equal(await popup.isHidden('#setup'), true, 'no setup panel when the helper is installed');
  } finally {
    await b.close();
  }
});

test('Model picker: Sonnet, then a custom model ID, are passed to claude', async () => {
  const b = await launch({ helper: 'fake' });
  try {
    const options = await b.ctx.newPage();
    await options.goto(`chrome-extension://${b.extId}/options.html`);
    await options.selectOption('#claudeModelChoice', 'sonnet');
    assert.equal(await options.isHidden('#claudeModel'), true, 'custom field hidden for aliases');
    await options.click('#save');
    await waitFor(async () => (await options.textContent('#status')) === 'Saved.', { msg: 'saved' });
    await openSites(b.ctx);
    await tidyFromPopup(b.ctx, b.extId);
    assert.ok(b.claudeCalls().at(-1).includes('--model=sonnet'));

    await options.reload();
    await options.selectOption('#claudeModelChoice', 'custom');
    assert.equal(await options.isVisible('#claudeModel'), true, 'custom field shown');
    await options.fill('#claudeModel', 'claude-sonnet-4-5');
    await options.click('#save');
    await waitFor(async () => (await options.textContent('#status')) === 'Saved.', { msg: 'saved custom' });
    await tidyFromPopup(b.ctx, b.extId);
    assert.ok(b.claudeCalls().at(-1).includes('--model=claude-sonnet-4-5'));

    // Reopening Options shows the custom ID, and invalid IDs are refused.
    await options.reload();
    assert.equal(await options.inputValue('#claudeModelChoice'), 'custom');
    assert.equal(await options.inputValue('#claudeModel'), 'claude-sonnet-4-5');
    await options.fill('#claudeModel', '--dangerous');
    await options.click('#save');
    await waitFor(async () => /isn't a valid Claude model ID/.test(await options.textContent('#status')), {
      msg: 'validation message',
    });
    const stored = await b.sw.evaluate(() => chrome.storage.sync.get('claudeModel'));
    assert.equal(stored.claudeModel, 'claude-sonnet-4-5', 'invalid model not saved');
  } finally {
    await b.close();
  }
});

test('Prompt: custom grouping instructions reach claude; the default text and Reset keep the built-in prompt', async () => {
  const b = await launch({ helper: 'fake' });
  const systemOf = (argv) => argv[argv.indexOf('--system-prompt') + 1];
  try {
    const options = await b.ctx.newPage();
    await options.goto(`chrome-extension://${b.extId}/options.html`);
    const def = await options.inputValue('#groupingInstructions');
    assert.match(def, /^Group the tabs by the task/, 'textarea shows the default instructions');
    assert.match(await options.textContent('#instructionsCount'), /\(default\)/);

    // Saving the untouched default stores '' so the built-in prompt is used.
    await options.click('#save');
    await waitFor(async () => (await options.textContent('#status')) === 'Saved.', { msg: 'saved' });
    assert.equal((await b.sw.evaluate(() => chrome.storage.sync.get('groupingInstructions'))).groupingInstructions, '');
    await openSites(b.ctx);
    await tidyFromPopup(b.ctx, b.extId);
    assert.match(systemOf(b.claudeCalls().at(-1)), /not a product or site/);

    const custom = 'Keep work and personal tabs apart. Label groups in Spanish, about {groups} groups.';
    await options.fill('#groupingInstructions', custom);
    assert.match(await options.textContent('#instructionsCount'), /\(custom\)/);
    await options.click('#previewPrompt');
    const preview = await options.textContent('#promptPreview');
    assert.match(preview, /Label groups in Spanish, about 5 groups\./, 'preview fills {groups} for 20 tabs');
    assert.match(preview, /exactly once/, 'preview shows the fixed rules');
    await options.click('#save');
    await waitFor(async () => (await options.textContent('#status')) === 'Saved.', { msg: 'saved custom' });
    await tidyFromPopup(b.ctx, b.extId);
    const sys = systemOf(b.claudeCalls().at(-1));
    assert.match(sys, /Keep work and personal tabs apart\. Label groups in Spanish, about \d groups\./);
    assert.doesNotMatch(sys, /not a product or site/);
    assert.match(sys, /Reply with JSON/);
    const { lastRun } = await b.sw.evaluate(() => chrome.storage.local.get('lastRun'));
    assert.equal(lastRun.backend.customInstructions, true, 'run record notes custom instructions');

    // Reopening shows the saved text; Reset + Save goes back to the built-in prompt.
    await options.reload();
    assert.equal(await options.inputValue('#groupingInstructions'), custom);
    await options.click('#resetInstructions');
    assert.equal(await options.inputValue('#groupingInstructions'), def);
    await options.click('#save');
    await waitFor(async () => (await options.textContent('#status')) === 'Saved.', { msg: 'saved reset' });
    assert.equal((await b.sw.evaluate(() => chrome.storage.sync.get('groupingInstructions'))).groupingInstructions, '');
  } finally {
    await b.close();
  }
});

test('No helper installed: popup shows setup instructions; Tidy falls back to grouping by website', async () => {
  const b = await launch({ helper: 'none' });
  try {
    await openSites(b.ctx);
    const popup = await b.ctx.newPage();
    await popup.goto(`chrome-extension://${b.extId}/popup.html`);
    await waitFor(() => popup.isVisible('#setup'), { msg: 'setup panel' });
    assert.match(await popup.textContent('#setupCmd'), /^curl -fsSL https:\/\/github\.com\/.+\/install\.sh \| bash$/);
    assert.match(await popup.getAttribute('#setupGuide', 'href'), /^https:\/\/sanchitsharma\.github\.io\/tidy-tabs\//);

    // Fallback groups by website only when 2+ websites each have 2+ tabs. Here only
    // stackoverflow.com repeats, so the documented outcome is "no changes".
    const runTidy = async () => {
      await popup.click('#tidy');
      await waitFor(() => popup.evaluate(() => !document.getElementById('tidy').disabled), { timeout: 60000 });
    };
    await runTidy();
    assert.match(await popup.textContent('#status'), /no changes/i);
    assert.deepEqual(summarize(await tabState(b.sw)).titles, []);

    // A second repeated website: now the fallback makes real website groups, without Claude.
    const extra = await b.ctx.newPage();
    await extra.goto('https://docs.python.org/3/library/typing.html');
    await popup.bringToFront();
    await runTidy();
    const s = summarize(await tabState(b.sw));
    assert.equal(s.titles.length, 2, `website groups: ${JSON.stringify(s.titles)}`);
    assert.ok(s.contiguous);
    assert.equal(b.claudeCalls().length, 0);
    const hints = await popup.textContent('#errorList');
    assert.match(hints, /Claude helper isn't installed/);
    assert.doesNotMatch(hints, /tidy-tabs\/install\.sh/, 'no repo-relative instructions for store users');
  } finally {
    await b.close();
  }
});

test('"Save run logs to a file" off: no helper log attempt, so no helper error after a tidy', async () => {
  const b = await launch({ helper: 'none' });
  try {
    await openSites(b.ctx);
    const errorsAfterTidy = async (saveLogFile) => {
      await b.sw.evaluate((v) => chrome.storage.sync.set({ saveLogFile: v }), saveLogFile);
      const popup = await tidyFromPopup(b.ctx, b.extId);
      const text = await popup.textContent('#errorList');
      await popup.close();
      return text;
    };
    assert.match(await errorsAfterTidy(true), /nativeLog/, 'on: the helper log is attempted (and fails here)');
    assert.doesNotMatch(await errorsAfterTidy(false), /nativeLog/, 'off: no helper log attempt');
  } finally {
    await b.close();
  }
});

test('Re-tidy reuses its own groups instead of piling up duplicates', async () => {
  const b = await launch({ helper: 'fake' });
  try {
    await openSites(b.ctx);
    await tidyFromPopup(b.ctx, b.extId);
    const first = await b.sw.evaluate(async () => (await chrome.tabGroups.query({})).length);
    await sleep(300);
    await tidyFromPopup(b.ctx, b.extId);
    const second = await b.sw.evaluate(async () => (await chrome.tabGroups.query({})).map((g) => g.title).sort());
    assert.equal(first, 2);
    assert.deepEqual(second, ['Python debugging', 'Trip to Lisbon']);
  } finally {
    await b.close();
  }
});

test(
  'LIVE: real Claude Haiku through the installed helper (TIDY_E2E_LIVE=1)',
  { skip: process.env.TIDY_E2E_LIVE !== '1' && 'set TIDY_E2E_LIVE=1 (uses your Claude subscription)' },
  async () => {
    const b = await launch({ helper: 'live' });
    try {
      await openSites(b.ctx);
      const popup = await tidyFromPopup(b.ctx, b.extId);
      const status = await popup.textContent('#status');
      const s = summarize(await tabState(b.sw));
      console.log(`    live status: ${status}`);
      console.log(`    live groups: ${JSON.stringify(s.titles)}`);
      assert.ok(s.titles.length >= 2, `real Claude grouped the window (${status})`);
      assert.ok(s.contiguous);
    } finally {
      await b.close();
    }
  },
);
