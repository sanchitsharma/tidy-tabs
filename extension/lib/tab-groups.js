// Named, colored tab groups (primary UX on Chrome/Dia). Re-tidying reuses the extension's own groups
// (same title first, then any leftover owned group, renamed) instead of piling up duplicates.
// planGroups is pure; applyGroups takes an injected API so it can be tested with a fake.
import { withTimeout } from './timeout.js';
import { OTHER_LABEL } from './core.js';

export const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange', 'grey'];
export const GROUP_CALL_MS = 1500;
export const MIN_GROUP_SIZE = 2;

/**
 * Which clusters become tab groups. Never: single-tab clusters, "Other" (leftovers), one group holding
 * every tab, or (in domain-fallback mode) anything unless 2+ real domain groups exist.
 */
export function selectGroupable(clusters, { fallback = false } = {}) {
  const nonEmpty = clusters.filter((c) => c.tabIds.length > 0);
  if (nonEmpty.length < 2) return [];
  const isOther = (c) => c.label.trim().toLowerCase() === OTHER_LABEL.toLowerCase();
  // "Other" = leftovers / single-tab tasks: never a tab group, in any mode.
  const out = nonEmpty.filter((c) => c.tabIds.length >= MIN_GROUP_SIZE && !isOther(c));
  if (fallback && out.length < 2) return [];
  const total = nonEmpty.reduce((n, c) => n + c.tabIds.length, 0);
  if (out.length === 1 && out[0].tabIds.length === total) return []; // one group of everything
  return out;
}

/**
 * clusters: [{label, tabIds}] in display order. owned: [{id, title}] = groups this extension created
 * earlier that still exist in the window. tabGroupOf: Map(tabId -> groupId) for current membership.
 * Returns { actions: [{label, tabIds, color, groupId|null, action:'reuse'|'rename'|'create'}],
 *           ungroup: [tabId] (tabs left in an owned group but not grouped now) }.
 */
export function planGroups(clusters, owned = [], tabGroupOf = new Map(), { fallback = false } = {}) {
  const free = [...owned];
  const take = (pred) => {
    const i = free.findIndex(pred);
    return i < 0 ? null : free.splice(i, 1)[0];
  };
  const groupable = selectGroupable(clusters, { fallback });
  // Pass 1: exact title matches keep their group (and its color); pass 2: rename leftovers.
  const matched = new Map();
  for (const c of groupable) {
    const g = take((o) => (o.title || '').trim().toLowerCase() === c.label.trim().toLowerCase());
    if (g) matched.set(c, g);
  }
  const actions = groupable.map((c, i) => {
    const color = GROUP_COLORS[i % GROUP_COLORS.length];
    if (matched.has(c)) return { label: c.label, tabIds: c.tabIds, color, groupId: matched.get(c).id, action: 'reuse' };
    const g = take(() => true);
    return g ? { label: c.label, tabIds: c.tabIds, color, groupId: g.id, action: 'rename' }
      : { label: c.label, tabIds: c.tabIds, color, groupId: null, action: 'create' };
  });
  const ownedIds = new Set(owned.map((o) => o.id));
  const grouped = new Set(actions.flatMap((a) => a.tabIds));
  const ungroup = clusters.flatMap((c) => c.tabIds).filter((id) => !grouped.has(id) && ownedIds.has(tabGroupOf.get(id)));
  return { actions, ungroup };
}

/**
 * api = { queryGroups(windowId) -> [{id,title}], group({tabIds, groupId?, createProperties?}) -> groupId,
 *         update(groupId, props), ungroup(tabIds) }. ownedIds: group ids created earlier.
 * Returns { ownedIds (to persist), created, reused, renamed, ungrouped, errors, actions }.
 */
export async function applyGroups({ windowId, clusters, tabs, ownedIds = [], collapsed = false, fallback = false, api }) {
  const errors = [];
  const call = (fn, label) => withTimeout(fn, GROUP_CALL_MS, label);
  let existing = [];
  try {
    existing = await call(() => api.queryGroups(windowId), 'tabGroups.query');
  } catch (e) {
    return { ownedIds, created: 0, reused: 0, renamed: 0, ungrouped: 0, errors: [String(e?.message || e)], actions: [] };
  }
  const ownedSet = new Set(ownedIds);
  const owned = existing.filter((g) => ownedSet.has(g.id)).map((g) => ({ id: g.id, title: g.title }));
  const tabGroupOf = new Map(tabs.map((t) => [t.id, t.groupId]));
  const plan = planGroups(clusters, owned, tabGroupOf, { fallback });
  const counts = { created: 0, reused: 0, renamed: 0, ungrouped: 0 };
  const nowOwned = [];
  if (plan.ungroup.length) {
    try {
      await call(() => api.ungroup(plan.ungroup), 'tabs.ungroup');
      counts.ungrouped = plan.ungroup.length;
    } catch (e) { errors.push(`ungroup: ${e?.message || e}`); }
  }
  for (const a of plan.actions) {
    try {
      const opts = a.groupId != null ? { tabIds: a.tabIds, groupId: a.groupId } : { tabIds: a.tabIds, createProperties: { windowId } };
      const groupId = await call(() => api.group(opts), 'tabs.group');
      await call(() => api.update(groupId, { title: a.label, color: a.color, collapsed }), 'tabGroups.update');
      nowOwned.push(groupId);
      counts[a.action === 'create' ? 'created' : a.action === 'reuse' ? 'reused' : 'renamed']++;
    } catch (e) {
      errors.push(`${a.action} "${a.label}": ${e?.message || e}`);
      if (/did not settle/.test(String(e?.message))) break; // API hangs: stop trying
    }
  }
  return { ownedIds: nowOwned, ...counts, errors, actions: plan.actions.map(({ label, action, groupId, tabIds }) => ({ label, action, groupId, size: tabIds.length })) };
}
