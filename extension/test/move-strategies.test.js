import '../test-support/no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyOrder,
  strategySteps,
  runStrategy,
  applyWithVerification,
  STRATEGY_NAMES,
  DEFAULT_STRATEGIES,
} from '../lib/move-strategies.js';
import { computeMovePlan } from '../lib/core.js';
import { fakeTabs } from '../test-support/fake-tabs.js';
import { classify, pushRecent, guessBrowser, describeGroups, summarize } from '../lib/diagnostics.js';

// Window: 2 pinned, then 6 unpinned interleaved across 2 topics.
const SPEC = [
  { id: 1, pinned: true },
  { id: 2, pinned: true },
  { id: 10 },
  { id: 20 },
  { id: 11 },
  { id: 21 },
  { id: 12 },
  { id: 22 },
];
const GROUPS = [
  { label: 'A', tabIds: [10, 11, 12] },
  { label: 'B', tabIds: [20, 21, 22] },
];
const TARGET = [1, 2, 10, 11, 12, 20, 21, 22];
async function setup(mode) {
  const api = fakeTabs(SPEC, mode);
  const plan = computeMovePlan(await api.query(), GROUPS);
  return { api, plan };
}

test('verifyOrder: exact match, mismatch list, tolerates closed/new tabs', () => {
  const tabs = (ids, pinned = []) => ids.map((id, index) => ({ id, index, pinned: pinned.includes(id) }));
  assert.equal(verifyOrder(tabs([1, 10, 11]), [10, 11]).ok, true);
  const v = verifyOrder(tabs([1, 11, 10, 12], [1]), [10, 11, 12]);
  assert.equal(v.ok, false);
  assert.deepEqual(v.misplaced, [10, 11]);
  assert.deepEqual(v.actual, [11, 10, 12]);
  assert.equal(verifyOrder(tabs([10, 99, 12]), [10, 11, 12]).ok, true, 'closed tab 11 and new tab 99 ignored');
});

test('strategySteps shapes', async () => {
  const { plan } = await setup('works');
  assert.equal(plan.startIndex, 2);
  assert.deepEqual(strategySteps('single-call', plan), [
    { ids: [10, 11, 12, 20, 21, 22], index: 2, tabIds: [10, 11, 12, 20, 21, 22] },
  ]);
  assert.ok(strategySteps('append-each', plan).every((s) => s.index === -1));
  assert.deepEqual(
    strategySteps('sequential-delay', plan).map((s) => s.index),
    [2, 3, 4, 5, 6, 7],
  );
  assert.deepEqual(
    strategySteps('batch-plan', plan),
    plan.moves.map((m) => ({ ids: m.tabId, index: m.index, tabIds: [m.tabId] })),
  );
  assert.throws(() => strategySteps('nope', plan));
});

test('works: first strategy verifies, onMoved fired for every moved tab', async () => {
  const { api, plan } = await setup('works');
  const r = await applyWithVerification(plan, api);
  assert.equal(r.verified, true);
  assert.equal(r.winner, 'batch-plan');
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].onMovedMissing, 0);
  assert.ok(r.results[0].onMovedEvents >= 1);
  assert.deepEqual(api.order(), TARGET);
});

test('already ordered: no moves at all', async () => {
  const api = fakeTabs(TARGET.map((id) => ({ id, pinned: id < 10 })));
  const plan = computeMovePlan(await api.query(), GROUPS);
  const r = await applyWithVerification(plan, api);
  assert.equal(r.winner, 'none-needed');
  assert.equal(api.calls.length, 0);
});

test('ignores: every strategy runs, none verifies, "Browser ignored tab moves", ignored counts + missing onMoved', async () => {
  const { api, plan } = await setup('ignores');
  const r = await applyWithVerification(plan, api, { strategies: STRATEGY_NAMES });
  assert.equal(r.verified, false);
  assert.equal(r.winner, null);
  assert.deepEqual(
    r.results.map((x) => x.name),
    STRATEGY_NAMES,
  );
  assert.match(r.message, /Browser ignored tab moves/);
  for (const x of r.results) {
    assert.equal(x.threwCount, 0);
    assert.ok(x.ignored > 0, `${x.name} ignored`);
    assert.equal(x.onMovedEvents, 0);
    assert.ok(x.onMovedMissing > 0);
  }
  const seq = r.results.find((x) => x.name === 'sequential-delay');
  assert.ok(seq.perMoveIgnored.length > 0, 'per-move check catches ignored moves');
  assert.deepEqual(api.order(), [1, 2, 10, 20, 11, 21, 12, 22]);
});

test('throws: errors recorded per call with messages, distinct failure message', async () => {
  const { api, plan } = await setup('throws');
  const r = await applyWithVerification(plan, api);
  assert.equal(r.verified, false);
  assert.match(r.message, /failed with every strategy/);
  assert.equal(r.results[0].threwCount, plan.moves.length);
  assert.match(r.results[0].threw[0].error, /cannot be edited/);
  assert.deepEqual(
    r.results.map((x) => x.name),
    DEFAULT_STRATEGIES,
  );
  assert.equal(r.results[1].threw[0].tabIds, '6 tabs');
});

test('default strategies: batch plan then one single-call retry', () => {
  assert.deepEqual(DEFAULT_STRATEGIES, ['batch-plan', 'single-call']);
});

test('only-minus-one (opt-in strategies): falls through to append-each and verifies', async () => {
  const { api, plan } = await setup('only-minus-one');
  const r = await applyWithVerification(plan, api, { strategies: STRATEGY_NAMES });
  assert.equal(r.verified, true);
  assert.equal(r.winner, 'append-each');
  assert.deepEqual(
    r.results.map((x) => x.verified),
    [false, false, true],
  );
  assert.deepEqual(api.order(), TARGET);
});

test('only-array: default retry (single-call) verifies', async () => {
  const { api, plan } = await setup('only-array');
  const r = await applyWithVerification(plan, api);
  assert.equal(r.winner, 'single-call');
  assert.deepEqual(api.order(), TARGET);
});

test('hangs: each move times out instead of blocking forever', async (t) => {
  const { api, plan } = await setup('hangs');
  const t0 = Date.now();
  const r = await runStrategy('single-call', plan, api);
  assert.equal(r.threwCount, 1);
  assert.match(r.threw[0].error, /did not settle within 1500 ms/);
  assert.ok(Date.now() - t0 < 3000);
  t.diagnostic(`single hung move took ${Date.now() - t0} ms`);
});

test('diagnostics: classify -> status + badge', () => {
  assert.equal(classify({ moves: { verified: true }, backend: {} }).badge.text, '✓');
  assert.deepEqual(classify({ moves: { verified: false }, backend: {} }), {
    status: 'moves-failed',
    badge: { text: '!', color: '#d97706' },
  });
  assert.equal(classify({ backend: { fallback: true }, moves: { verified: true } }).badge.text, '✗');
  assert.equal(classify({ error: 'x' }).status, 'error');
  assert.equal(classify({ status: 'noop' }).status, 'noop');
  assert.match(
    summarize({
      status: 'moves-failed',
      groups: [{}, {}],
      backend: { name: 'claude:haiku' },
      moves: { message: 'Arc ignored tab moves' },
    }),
    /2 groups via claude:haiku, but Arc ignored/,
  );
});

test('diagnostics: recent runs capped at 10, newest first', () => {
  let list = [];
  for (let i = 0; i < 13; i++) list = pushRecent(list, { id: String(i), status: 'verified', errors: [] });
  assert.equal(list.length, 10);
  assert.equal(list[0].id, '12');
});

test('diagnostics: browser guess + groups carry titles/hosts but no URLs', () => {
  assert.equal(guessBrowser({ brands: [{ brand: 'Google Chrome' }], tabGroupsUsable: true }), 'chrome');
  assert.equal(
    guessBrowser({ brands: [{ brand: 'Chromium' }], tabGroupsReason: 'tabGroups.query: hangs' }),
    'unsupported (tabGroups hangs)',
  );
  assert.equal(guessBrowser({ brands: [{ brand: 'Chromium' }, { brand: 'Brave' }] }), 'chromium-based (unknown)');
  const d = describeGroups(
    [{ label: 'A', tabIds: [5] }],
    [{ id: 5, title: 'Doc', url: 'https://x.example.com/secret?q=1' }],
  );
  assert.deepEqual(d, [{ label: 'A', tabs: [{ id: 5, title: 'Doc', host: 'x.example.com' }] }]);
  assert.ok(!JSON.stringify(d).includes('secret'));
});
