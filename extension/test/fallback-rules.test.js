import '../test-support/no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByDomain, realGroups, isInternalTab, computeMovePlan } from '../lib/core.js';
import { selectGroupable, applyGroups } from '../lib/tab-groups.js';
import { classify, summarize, hintsFor, guessBrowser } from '../lib/diagnostics.js';

const C = (label, ...tabIds) => ({ label, tabIds });
const tab = (id, url, i = id) => ({ id, index: i, url, title: `T${id}`, pinned: false });

function recordingApi() {
  const calls = [];
  return {
    calls,
    queryGroups: async () => [],
    group: async (o) => { calls.push(['group', o]); return 1; },
    update: async (...a) => { calls.push(['update', ...a]); },
    ungroup: async (ids) => { calls.push(['ungroup', ids]); },
  };
}

test('fallback, 15 tabs on 15 distinct domains: one Other group, nothing worth doing', async () => {
  const tabs = Array.from({ length: 15 }, (_, i) => tab(i + 1, `https://site${i}.example${i}.com/`));
  const groups = groupByDomain(tabs);
  assert.deepEqual(groups.map((g) => [g.label, g.tabIds.length]), [['Other', 15]]);
  assert.equal(realGroups(groups).length, 0, 'tidy-run treats this as no-op: no moves, no groups');
  assert.deepEqual(selectGroupable(groups, { fallback: true }), []);
  const api = recordingApi();
  const r = await applyGroups({ windowId: 1, clusters: groups, tabs, fallback: true, api });
  assert.equal(r.created, 0);
  assert.deepEqual(api.calls, [], 'no tab group created');
  // And the plan for those groups would not reorder anything either.
  assert.equal(computeMovePlan(tabs, groups).moves.length, 0);
});

test('no-op fallback message is explicit', () => {
  const rec = { backend: { fallback: true, attempted: 'claude:haiku', fallbackReason: 'host not found' }, noChanges: true, errors: [] };
  const c = classify(rec);
  rec.status = c.status;
  assert.equal(c.badge.text, '✗');
  assert.equal(summarize(rec), 'Claude unavailable → domain fallback found nothing to group; no changes made');
});

test('single resulting group never becomes a tab group (LLM or fallback)', () => {
  assert.deepEqual(selectGroupable([C('Code', 1, 2, 3)]), []);
  assert.deepEqual(selectGroupable([C('Other', 1, 2, 3)]), []);
  assert.deepEqual(selectGroupable([C('Code', 1, 2, 3), C('Empty')]), []);
});

test('"Other" (leftovers) is never a tab group, in any mode', () => {
  assert.deepEqual(selectGroupable([C('Other', 1, 2, 3, 4), C('Solo', 5)]).map((c) => c.label), []);
  assert.deepEqual(selectGroupable([C('Code', 1, 2), C('Other', 3, 4)]).map((c) => c.label), ['Code']);
});

test('fallback: needs 2+ domain groups of size 2; Other and single-tab domains stay ungrouped', async () => {
  assert.deepEqual(selectGroupable([C('github.com', 1, 2), C('Other', 3, 4, 5)], { fallback: true }), []);
  const groups = [C('github.com', 1, 2), C('google.com', 3, 4), C('Other', 5, 6)];
  assert.deepEqual(selectGroupable(groups, { fallback: true }).map((c) => c.label), ['github.com', 'google.com']);
  const api = recordingApi();
  const r = await applyGroups({ windowId: 1, clusters: groups, tabs: [1, 2, 3, 4, 5, 6].map((id) => ({ id })), fallback: true, api });
  assert.equal(r.created, 2);
  assert.deepEqual(api.calls.filter((c) => c[0] === 'group').map((c) => c[1].tabIds), [[1, 2], [3, 4]]);
});

test('internal pages are detected (kept out of clusters and groups)', () => {
  for (const u of ['chrome://newtab/', 'chrome://extensions/', 'chrome-extension://abc/popup.html', 'about:blank', 'devtools://devtools/x']) {
    assert.equal(isInternalTab({ url: u }), true, u);
  }
  assert.equal(isInternalTab({ url: 'https://github.com/' }), false);
  assert.equal(isInternalTab({ pendingUrl: 'chrome://newtab/' }), true);
  // Not covered by any group -> move plan appends them at the end, ungrouped.
  const win = [tab(1, 'chrome://newtab/', 0), tab(2, 'https://a.com/x', 1), tab(3, 'https://b.com/', 2), tab(4, 'https://a.com/y', 3)];
  assert.deepEqual(computeMovePlan(win, [C('a.com', 2, 4), C('Other', 3)]).order, [2, 4, 3, 1]);
});

test('hint for "native messaging host not found" names the browser', () => {
  const rec = { env: { browserGuess: 'chromium fork (unknown; e.g. Phi)' },
    errors: [{ where: 'backend', message: 'native messaging: Specified native messaging host not found.' }] };
  const [h] = hintsFor(rec);
  assert.match(h, /^The Claude helper isn't installed for this browser \(chromium fork \(unknown; e\.g\. Phi\)\)\. Install it with the command under "Set up the Claude helper" \(macOS\/Linux\), then fully quit and restart the browser\. Or pick Ollama \/ Gemini Nano in Options\.$/);
  assert.deepEqual(hintsFor({ errors: [] }), []);
});

test('browser guess: Chromium-only brands -> fork; Phi brand; GREASE ignored', () => {
  assert.equal(guessBrowser({ brands: [{ brand: 'Chromium' }, { brand: 'Not=A?Brand' }] }), 'chromium fork (unknown; e.g. Phi)');
  assert.equal(guessBrowser({ brands: [{ brand: 'Phi' }, { brand: 'Chromium' }] }), 'phi');
  assert.equal(guessBrowser({ brands: [{ brand: 'Chromium' }, { brand: 'Google Chrome' }], tabGroupsUsable: true }), 'chrome');
});
