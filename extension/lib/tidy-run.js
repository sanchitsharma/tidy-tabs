// One tidy run against the real browser: query -> cluster -> plan -> move+verify -> (tab groups).
// Produces a diagnostics record (see lib/diagnostics.js). Uses chrome.* directly.
import { computeMovePlan, isInternalTab, realGroups } from './core.js';
import { runCluster } from './backends.js';
import { probeSettles } from './timeout.js';
import { applyGroups } from './tab-groups.js';
import { applyWithVerification } from './move-strategies.js';
import { effectiveTab, skippedKind } from './suspended.js';
import { guessBrowser, describeGroups, classify, summarize, tabSummary, errorEntry, hintsFor } from './diagnostics.js';

let tabGroupsProbe = null; // cached per service-worker lifetime

/** Feature detection is not enough (some Chromium forks stub the API and never settle). Probe once. */
export function probeTabGroups() {
  if (!tabGroupsProbe) {
    const exists = !!(chrome.tabGroups?.query && chrome.tabGroups?.update && typeof chrome.tabs.group === 'function');
    tabGroupsProbe = probeSettles(() => chrome.tabGroups.query({}), { exists, ms: 500, label: 'tabGroups.query' });
  }
  return tabGroupsProbe;
}

/** Create/reuse named groups; group ids we own are persisted per window so re-tidy reuses them. */
async function tabGroupsStep(windowId, clusters, settings, fallback) {
  const probe = await probeTabGroups();
  if (!probe.usable) return { skipped: probe.reason, errors: [probe.reason] };
  const { ownedGroups = {} } = await chrome.storage.local.get('ownedGroups');
  const tabs = await chrome.tabs.query({ windowId });
  const res = await applyGroups({
    windowId, clusters, tabs, ownedIds: ownedGroups[windowId] || [], collapsed: !!settings.collapseGroups, fallback,
    api: {
      queryGroups: (w) => chrome.tabGroups.query({ windowId: w }),
      group: (opts) => chrome.tabs.group(opts),
      update: (id, props) => chrome.tabGroups.update(id, props),
      ungroup: (ids) => chrome.tabs.ungroup(ids),
    },
  });
  // Keep only windows that still exist, so the map doesn't grow forever.
  const live = new Set((await chrome.windows.getAll()).map((w) => String(w.id)));
  const next = Object.fromEntries(Object.entries(ownedGroups).filter(([w]) => live.has(w)));
  next[windowId] = res.ownedIds;
  await chrome.storage.local.set({ ownedGroups: next });
  return res;
}

export async function environment() {
  const probe = await probeTabGroups();
  const brands = navigator.userAgentData?.brands || [];
  return {
    extensionVersion: chrome.runtime.getManifest().version,
    extensionId: chrome.runtime.id,
    userAgent: navigator.userAgent,
    brands: brands.map((b) => `${b.brand} ${b.version}`),
    tabGroupsProbe: probe.reason,
    tabGroupsUsable: probe.usable,
    browserGuess: guessBrowser({ brands, tabGroupsUsable: probe.usable, tabGroupsReason: probe.reason }),
  };
}

async function resolveWindowId(windowId) {
  if (Number.isInteger(windowId) && windowId >= 0) return windowId;
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
  return win.id;
}

/** Run once. Never throws: errors land in record.error / record.errors. */
export async function runTidy({ windowId: hint, settings, onProgress = () => {}, trigger = 'unknown' }) {
  const t0 = Date.now();
  const rec = { id: `${t0}-${Math.random().toString(36).slice(2, 7)}`, at: new Date(t0).toISOString(), trigger, progress: [], errors: [] };
  const step = (s) => { rec.progress.push({ ms: Date.now() - t0, step: s }); onProgress(s, rec); };
  try {
    step('starting');
    rec.env = await environment();
    const windowId = await resolveWindowId(hint);
    rec.windowId = windowId;
    const windowTabs = await chrome.tabs.query({ windowId });
    // Suspended tabs (Tab Suspender & co.) get their real URL back so they are clustered like any page.
    const tabs = windowTabs.filter((t) => !t.pinned).sort((a, b) => a.index - b.index).map(effectiveTab);
    rec.counts = { total: windowTabs.length, pinned: windowTabs.length - tabs.length, unpinned: tabs.length };
    rec.before = tabs.map(tabSummary);
    // Internal pages (new tab, extensions, settings) are left out; the move plan puts them at the end.
    const clusterable = tabs.filter((t) => !isInternalTab(t));
    rec.counts.internal = tabs.length - clusterable.length;
    rec.counts.suspended = tabs.filter((t) => t.suspended).length;
    // What was skipped, as scheme://host counts only (no paths/titles), so a bad skip is visible.
    rec.skipped = {};
    for (const t of tabs) if (isInternalTab(t)) rec.skipped[skippedKind(t)] = (rec.skipped[skippedKind(t)] || 0) + 1;
    if (clusterable.length < 2) {
      rec.status = 'noop';
      step('nothing to tidy (fewer than 2 regular unpinned tabs)');
      return finish(rec, t0);
    }

    step(`calling backend (${settings.backend})`);
    const result = await runCluster(clusterable, settings);
    rec.backend = {
      name: result.backend, attempted: result.attemptedBackend, strategy: result.strategy, fallback: result.fallback,
      fallbackReason: result.fallbackReason, labels: result.labels, timings: result.timings, repair: result.stats,
      strictErrors: result.strictErrors?.slice(0, 10),
    };
    // Exact prompt + raw model answer per call. Contains tab titles: kept out of disk/storage.local
    // unless Debug logging is on (see redactRecord); always available to "Copy diagnostics".
    rec.llm = result.exchanges || [];
    if (result.fallback) rec.errors.push({ where: 'backend', message: result.fallbackReason });
    rec.groups = describeGroups(result.groups, tabs);
    step(`backend done: ${result.groups.length} groups via ${result.backend}`);
    if (result.fallback && realGroups(result.groups).length < 2) {
      rec.noChanges = true;
      step('domain fallback found nothing to group; no changes made');
      return finish(rec, t0);
    }

    const plan = computeMovePlan(windowTabs, result.groups);
    rec.plan = { startIndex: plan.startIndex, plannedMoves: plan.moves.length, order: plan.order };
    const api = {
      query: () => chrome.tabs.query({ windowId }),
      move: (ids, props) => chrome.tabs.move(ids, props),
      get: (id) => chrome.tabs.get(id),
      onMoved: chrome.tabs.onMoved,
    };
    step('moving tabs');
    rec.moves = await applyWithVerification(plan, api, { onProgress: step });
    for (const r of rec.moves.results) for (const t of r.threw) rec.errors.push({ where: `move:${r.name}`, message: t.error });
    step(`verification: ${rec.moves.message}`);
    try {
      rec.after = (await chrome.tabs.query({ windowId })).filter((t) => !t.pinned).sort((a, b) => a.index - b.index).map((t) => t.id);
    } catch { /* ignore */ }

    if (settings.createTabGroups) {
      step('creating tab groups');
      rec.tabGroups = await tabGroupsStep(windowId, result.groups, settings, result.fallback);
      for (const m of rec.tabGroups.errors || []) rec.errors.push({ where: 'tabGroups', message: m });
      step(rec.tabGroups.skipped ? `tab groups skipped: ${rec.tabGroups.skipped}`
        : `tab groups: ${rec.tabGroups.created} created, ${rec.tabGroups.reused} reused, ${rec.tabGroups.renamed} renamed`);
    }
  } catch (e) {
    rec.error = String(e?.message || e);
    rec.errors.push(errorEntry('runTidy', e));
  }
  return finish(rec, t0);
}

function finish(rec, t0) {
  rec.elapsedMs = Date.now() - t0;
  const c = classify(rec);
  rec.status = c.status;
  rec.badge = c.badge;
  rec.summary = summarize(rec);
  rec.hints = hintsFor(rec);
  rec.ok = c.status === 'verified' || c.status === 'noop';
  return rec;
}
