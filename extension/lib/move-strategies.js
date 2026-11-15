// Apply a move plan, verify the real order afterwards, and fall through several move strategies
// until one verifies. Pure: the tabs API is injected (chrome.tabs in the extension, a fake in tests).
//
// api = { query(): Promise<Tab[]> (all tabs of the window), move(ids, {index}): Promise,
//         get?(id): Promise<Tab>, onMoved?: {addListener, removeListener}, sleep?(ms): Promise }
import { withTimeout } from './timeout.js';

export const MOVE_CALL_MS = 1500;
export const STRATEGY_NAMES = ['batch-plan', 'sequential-delay', 'append-each', 'single-call'];
// Default: the planned per-tab moves, then one cheap retry as a single array move. The other
// strategies stay available (and tested) but are not run by default.
export const DEFAULT_STRATEGIES = ['batch-plan', 'single-call'];

const errMsg = (e) => String(e?.message || e);
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Current unpinned order (ids sorted by index). */
export function unpinnedOrder(windowTabs) {
  return windowTabs.filter((t) => !t.pinned).sort((a, b) => a.index - b.index).map((t) => t.id);
}

/**
 * Compare the actual unpinned order to the planned order, over ids present in both (tabs may be
 * opened or closed mid-run). Returns { ok, mismatches, misplaced:[id], expected, actual }.
 */
export function verifyOrder(windowTabs, plannedOrder) {
  const actualAll = unpinnedOrder(windowTabs);
  const present = new Set(actualAll);
  const planned = new Set(plannedOrder);
  const expected = plannedOrder.filter((id) => present.has(id));
  const actual = actualAll.filter((id) => planned.has(id));
  const misplaced = expected.filter((id, i) => actual[i] !== id);
  return { ok: misplaced.length === 0 && expected.length === actual.length, mismatches: misplaced.length, misplaced, expected, actual };
}

async function callMove(api, ids, index) {
  return withTimeout(() => api.move(ids, { index }), MOVE_CALL_MS, `tabs.move(${Array.isArray(ids) ? `[${ids.length}]` : ids}, ${index})`);
}

/** Build the list of move calls for a strategy. Each step = { ids, index, tabIds }. */
export function strategySteps(name, plan) {
  const { order, startIndex, moves } = plan;
  switch (name) {
    case 'batch-plan': return moves.map((m) => ({ ids: m.tabId, index: m.index, tabIds: [m.tabId] }));
    case 'sequential-delay': return order.map((id, i) => ({ ids: id, index: startIndex + i, tabIds: [id], delay: true, check: true }));
    case 'append-each': return order.map((id) => ({ ids: id, index: -1, tabIds: [id] }));
    case 'single-call': return [{ ids: [...order], index: startIndex, tabIds: [...order] }];
    default: throw new Error(`unknown strategy ${name}`);
  }
}

/** Run one strategy; returns its result record (never throws). */
export async function runStrategy(name, plan, api, { delayMs = 75, settleMs = 150 } = {}) {
  const sleep = api.sleep || defaultSleep;
  const t0 = Date.now();
  const steps = strategySteps(name, plan);
  const fired = new Set();
  let events = 0;
  const onMoved = (tabId) => { events++; fired.add(tabId); };
  try { api.onMoved?.addListener(onMoved); } catch { /* ignore */ }
  const threw = [];
  const perMoveIgnored = [];
  let calls = 0;
  try {
    for (const s of steps) {
      calls++;
      try {
        await callMove(api, s.ids, s.index);
      } catch (e) {
        threw.push({ tabIds: s.tabIds.length > 3 ? `${s.tabIds.length} tabs` : s.tabIds, index: s.index, error: errMsg(e) });
        continue;
      }
      if (s.delay) await sleep(delayMs);
      if (s.check && api.get) {
        try {
          const t = await withTimeout(() => api.get(s.ids), MOVE_CALL_MS, 'tabs.get');
          if (t.index !== s.index) perMoveIgnored.push({ tabId: s.ids, wanted: s.index, got: t.index });
        } catch (e) { perMoveIgnored.push({ tabId: s.ids, wanted: s.index, error: errMsg(e) }); }
      }
    }
    await sleep(settleMs); // let onMoved events arrive before verifying
  } finally {
    try { api.onMoved?.removeListener(onMoved); } catch { /* ignore */ }
  }
  let verify;
  try {
    verify = verifyOrder(await api.query(), plan.order);
  } catch (e) {
    verify = { ok: false, error: `re-query failed: ${errMsg(e)}`, mismatches: -1, misplaced: [] };
  }
  const threwIds = new Set(threw.flatMap((t) => (Array.isArray(t.tabIds) ? t.tabIds : [])));
  const movedIds = steps.flatMap((s) => s.tabIds).filter((id) => !threwIds.has(id));
  const misplacedSet = new Set(verify.misplaced || []);
  const ignored = [...new Set(movedIds)].filter((id) => misplacedSet.has(id)).length;
  return {
    name,
    calls,
    threwCount: threw.length,
    threw: threw.slice(0, 20),
    okCalls: calls - threw.length,
    ignored, // moved without error but not where planned
    perMoveIgnored: perMoveIgnored.slice(0, 20),
    onMovedEvents: events,
    onMovedMissing: [...new Set(movedIds)].filter((id) => !fired.has(id)).length,
    verified: !!verify.ok,
    mismatches: verify.mismatches,
    verifyError: verify.error,
    ms: Date.now() - t0,
  };
}

/**
 * Try strategies in order until the window order verifies. Returns
 * { verified, winner, alreadyOrdered, results, message }.
 */
export async function applyWithVerification(plan, api, { strategies = DEFAULT_STRATEGIES, onProgress, ...opts } = {}) {
  const initial = verifyOrder(await api.query(), plan.order);
  if (initial.ok) return { verified: true, winner: 'none-needed', alreadyOrdered: true, results: [], message: 'Tabs already in order' };
  const results = [];
  for (const name of strategies) {
    onProgress?.(`moving tabs: ${name}`);
    const r = await runStrategy(name, plan, api, opts);
    results.push(r);
    if (r.verified) {
      return { verified: true, winner: name, alreadyOrdered: false, results, message: `Reordered via ${name}` };
    }
  }
  const allIgnored = results.every((r) => r.threwCount === 0);
  return {
    verified: false,
    winner: null,
    alreadyOrdered: false,
    results,
    message: allIgnored ? 'Browser ignored tab moves (no errors, order unchanged)' : 'Tab moves failed with every strategy',
  };
}
