// Regression: sample-10 (ten public extension welcome/help pages + one GitHub release) once over-split
// into 6 groups, 3 of them single-tab.
import '../test-support/no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runCluster } from '../lib/backends.js';
import { DEFAULTS } from '../lib/settings.js';
import { computeMovePlan, buildPrompt } from '../lib/core.js';
import { selectGroupable } from '../lib/tab-groups.js';

const tabs = JSON.parse(readFileSync(new URL('./fixtures/sample-10.json', import.meta.url)));
const reply = (obj) => async () => ({ ok: true, content: JSON.stringify(obj), model: 'claude-haiku-5-5', timing: {} });

test('prompt for the sample-10 tabs asks for task groups, ~3 groups, >=2 tabs each, ungrouped leftovers', () => {
  const { system, user } = buildPrompt(tabs);
  assert.match(system, /task or activity the user is in the middle of/);
  assert.match(system, /aim for about 3 groups/);
  assert.match(system, /at least 2 tabs/);
  assert.match(system, /"ungrouped"/);
  assert.match(user, /^Tabs:\n0\|mybrowseraddon\.com\|Page Edit \(Design Mode\) :: MyBrowserAddon/);
});

test('over-split model reply: single-tab groups end up ungrouped (no tab groups), at the end', async () => {
  // Shape of the real bad run: 6 groups, 3 of them single-tab.
  const nativeSend = reply({
    groups: [
      { label: 'Browser Extensions', tabIds: [0, 3, 5, 6] },
      { label: 'Productivity Tools', tabIds: [7, 9] },
      { label: 'Dev Workflow', tabIds: [2] },
      { label: 'GitHub Tools', tabIds: [4] },
      { label: 'Dev Security Extensions', tabIds: [1] },
      { label: 'Password Management', tabIds: [8] },
    ],
  });
  const res = await runCluster(tabs, { ...DEFAULTS }, { nativeSend });
  assert.equal(res.fallback, false);
  assert.deepEqual(res.stats.singletons, [2, 4, 1, 8]);
  assert.deepEqual(
    res.groups.map((g) => [g.label, g.tabIds]),
    [
      ['Browser Extensions', [500, 503, 505, 506]],
      ['Productivity Tools', [507, 509]],
      ['Other', [501, 502, 504, 508]],
    ],
  );
  assert.deepEqual(
    selectGroupable(res.groups).map((g) => g.label),
    ['Browser Extensions', 'Productivity Tools'],
  );
  const win = tabs.map((t, i) => ({ ...t, index: i }));
  const order = computeMovePlan(win, res.groups).order;
  assert.deepEqual(order.slice(-4), [501, 502, 504, 508], 'leftovers sit at the end, ungrouped');
});

test('good reply with "ungrouped": one task group + leftovers, no "Other" tab group', async () => {
  const nativeSend = reply({
    groups: [{ label: 'Extension setup', tabIds: [0, 1, 2, 3, 5, 6, 7, 8, 9] }],
    ungrouped: [4],
  });
  const res = await runCluster(tabs, { ...DEFAULTS }, { nativeSend });
  assert.deepEqual(
    res.groups.map((g) => [g.label, g.tabIds.length]),
    [
      ['Extension setup', 9],
      ['Other', 1],
    ],
  );
  assert.deepEqual(
    selectGroupable(res.groups).map((g) => g.label),
    ['Extension setup'],
  );
});

test('model puts everything in one group: no tab group, nothing moves, no domain fallback', async () => {
  const nativeSend = reply({ groups: [{ label: 'Extension setup', tabIds: [...tabs.keys()] }] });
  const res = await runCluster(tabs, { ...DEFAULTS }, { nativeSend });
  assert.equal(res.fallback, false);
  assert.deepEqual(selectGroupable(res.groups), []);
  assert.equal(computeMovePlan(tabs, res.groups).moves.length, 0);
});
