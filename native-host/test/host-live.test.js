// Live: real `claude -p` (Haiku, cloud, user's subscription) through the installed host wrapper,
// launched with a stripped env like Chrome does. Gated: TIDY_CLAUDE_LIVE=1. Never touches the VM.
// Env: TIDY_RUNS (default 3), TIDY_CLAUDE_MODEL (default haiku).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildPrompt, checkSchema, repairGroups, GROUPS_SCHEMA } from '../../extension/lib/core.js';
import { runHost } from '../test-support/helpers.js';

const LIVE = process.env.TIDY_CLAUDE_LIVE === '1';
const RUNS = Number(process.env.TIDY_RUNS || 3);
const MODEL = process.env.TIDY_CLAUDE_MODEL || 'haiku';
// Where install.sh puts the helper: Application Support on macOS (TCC blocks browser-spawned reads of
// ~/Documents), $XDG_DATA_HOME or ~/.local/share on Linux.
const WRAPPER =
  process.platform === 'darwin'
    ? join(homedir(), 'Library/Application Support/tidy-tabs/native-host/tidy-tabs-host')
    : join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'tidy-tabs/native-host/tidy-tabs-host');
const tabs = JSON.parse(readFileSync(new URL('./fixtures/tabs-40.json', import.meta.url)));
const expected = JSON.parse(readFileSync(new URL('./fixtures/expected-40.json', import.meta.url)));
const skip = !LIVE
  ? 'set TIDY_CLAUDE_LIVE=1 (calls Claude Haiku via your subscription)'
  : !existsSync(WRAPPER)
    ? 'run ../install.sh first'
    : false;
// Chrome launches hosts with a near-empty environment.
const chromeEnv = {
  env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, USER: process.env.USER, TMPDIR: process.env.TMPDIR },
};
const viaWrapper = { cmd: WRAPPER, args: [], ...chromeEnv };

/** Majority-topic accuracy over non-stray tabs. */
export function purityExclStrays(groups) {
  let pure = 0;
  let total = 0;
  for (const g of groups) {
    const topics = g.tabIds.map((id) => expected[String(id)]).filter((t) => t !== 'stray');
    total += topics.length;
    const counts = {};
    for (const t of topics) counts[t] = (counts[t] || 0) + 1;
    pure += Math.max(0, ...Object.values(counts));
  }
  return total ? +(pure / total).toFixed(3) : 0;
}

/** Topic completeness: per non-stray topic, the largest share of its tabs sitting in one group. Penalizes splits. */
export function completeness(groups) {
  const byTopic = {};
  for (const [gi, g] of groups.entries()) {
    for (const id of g.tabIds) {
      const t = expected[String(id)];
      if (t === 'stray') continue;
      byTopic[t] ??= {};
      byTopic[t][gi] = (byTopic[t][gi] || 0) + 1;
    }
  }
  let best = 0;
  let total = 0;
  for (const counts of Object.values(byTopic)) {
    best += Math.max(...Object.values(counts));
    total += Object.values(counts).reduce((a, b) => a + b, 0);
  }
  return total ? +(best / total).toFixed(3) : 0;
}

async function hostChat(prompt, schema) {
  const t0 = performance.now();
  const { replies } = await runHost(
    [{ type: 'chat', id: 1, model: MODEL, system: prompt.system, user: prompt.user, schema, timeoutMs: 120000 }],
    { ...viaWrapper, cleanEnv: true },
  );
  return { reply: replies[0], wallMs: Math.round(performance.now() - t0) };
}

test('sample-10 titles (over-split regression), one run', { skip }, async () => {
  const sample = JSON.parse(readFileSync(new URL('../../extension/test/fixtures/sample-10.json', import.meta.url)));
  const prompt = buildPrompt(sample);
  const { reply, wallMs } = await hostChat(prompt, GROUPS_SCHEMA);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const { groups, stats } = repairGroups(reply.content, prompt.idMap);
  const title = new Map(sample.map((t) => [t.id, t.title.slice(0, 40)]));
  console.log(
    'SAMPLE10',
    JSON.stringify(
      {
        wallMs,
        raw: JSON.parse(reply.content),
        singletons: stats.singletons,
        groups: groups.map((g) => ({ label: g.label, tabs: g.tabIds.map((id) => title.get(id)) })),
      },
      null,
      2,
    ),
  );
  assert.equal(groups.flatMap((g) => g.tabIds).length, sample.length);
});

test('custom grouping instructions change the grouping (Options > Prompt)', { skip }, async () => {
  const sample = JSON.parse(readFileSync(new URL('../../extension/test/fixtures/sample-10.json', import.meta.url)));
  const instructions = 'Split the tabs into exactly two groups labelled "Work" and "Personal". Use no other labels.';
  const prompt = buildPrompt(sample, undefined, instructions);
  const { reply, wallMs } = await hostChat(prompt, GROUPS_SCHEMA);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const { groups } = repairGroups(reply.content, prompt.idMap);
  const labels = groups.map((g) => g.label).filter((l) => l !== 'Other');
  console.log('CUSTOM', JSON.stringify({ wallMs, labels, raw: JSON.parse(reply.content) }));
  assert.ok(labels.length >= 1, 'at least one group');
  assert.ok(
    labels.every((l) => l === 'Work' || l === 'Personal'),
    `labels follow the instructions: ${labels}`,
  );
});

test('claude -p startup overhead (trivial prompt, same flags)', { skip }, async () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const { reply, wallMs } = await hostChat({ system: 'Reply with JSON.', user: 'Return ok=true.' }, schema);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    runs.push({ wallMs, apiMs: reply.timing.apiMs, overheadMs: wallMs - reply.timing.apiMs, model: reply.model });
  }
  console.log('STARTUP', JSON.stringify(runs));
});

test(`40-tab fixture through the host x${RUNS}`, { skip, timeout: 600000 }, async () => {
  const prompt = buildPrompt(tabs);
  const results = [];
  for (let i = 0; i < RUNS; i++) {
    const { reply, wallMs } = await hostChat(prompt, GROUPS_SCHEMA);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const strict = checkSchema(reply.content, tabs.length);
    const { groups, stats } = repairGroups(reply.content, prompt.idMap);
    const ids = groups.flatMap((g) => g.tabIds);
    assert.equal(ids.length, tabs.length);
    assert.equal(new Set(ids).size, tabs.length);
    results.push({
      run: i + 1,
      wallMs,
      apiMs: reply.timing.apiMs,
      turns: reply.timing.turns,
      model: reply.model,
      strictValid: strict.ok,
      strictErrors: strict.errors,
      repair: stats,
      purity: purityExclStrays(groups),
      completeness: completeness(groups),
      groups: groups.map(
        (g) => `${g.label} (${g.tabIds.length}): ${[...new Set(g.tabIds.map((id) => expected[String(id)]))].join('/')}`,
      ),
    });
  }
  console.log('RESULTS', JSON.stringify(results, null, 2));
});
