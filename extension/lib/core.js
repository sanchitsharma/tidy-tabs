// Pure logic for Tidy Tabs. No chrome.* calls: unit-testable under node.

export const TITLE_MAX = 80;
export const OTHER_LABEL = 'Other';
export const MIN_GROUPS = 2;
export const MAX_GROUPS = 8;
export const LABEL_MAX = 40;

export const GROUPS_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          tabIds: { type: 'array', items: { type: 'integer' } },
        },
        required: ['label', 'tabIds'],
      },
    },
    ungrouped: { type: 'array', items: { type: 'integer' } },
  },
  required: ['groups'],
};

/** Hostname of a URL, or the scheme for non-http URLs (chrome:, file:). */
export function hostOf(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.hostname) return u.hostname.replace(/^www\./, '');
    return u.protocol.replace(/:$/, '');
  } catch {
    return '';
  }
}

// Common second-level public suffixes; a full PSL is overkill for tab grouping.
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'edu.in',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'co.kr', 'or.kr',
  'co.nz', 'org.nz', 'co.za', 'org.za', 'com.br', 'com.mx', 'com.ar',
  'com.cn', 'com.hk', 'com.sg', 'com.tw', 'com.tr', 'com.vn', 'edu.vn',
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev',
  'herokuapp.com', 'appspot.com', 'azurewebsites.net', 'cloudfront.net',
  'blogspot.com', 'substack.com', 'ts.net',
]);

/** Approximate registrable domain (eTLD+1). IPs, localhost, single labels pass through. */
export function registrableDomain(host) {
  if (!host) return '';
  const h = host.toLowerCase().replace(/\.$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':') || !h.includes('.')) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const last2 = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(last2)) return parts.slice(-3).join('.');
  return last2;
}

function cleanTitle(title) {
  return String(title ?? '').replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function truncate(s, max = TITLE_MAX) {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join('');
}

/**
 * Assign short ids 0..n-1 to tabs. Returns { lines, idMap } where idMap[shortId] = real tab id.
 * Each line: "id|host|title" with title truncated to TITLE_MAX chars.
 */
export function buildTabLines(tabs, maxTitle = TITLE_MAX) {
  const idMap = [];
  const lines = tabs.map((tab, i) => {
    idMap.push(tab.id);
    const host = hostOf(tab.url || tab.pendingUrl || '');
    const title = truncate(cleanTitle(tab.title || host || 'Untitled'), maxTitle);
    return `${i}|${host}|${title}`;
  });
  return { lines, idMap };
}

/** Target group count: about one group per 4 tabs, between 1 and MAX_GROUPS. */
export function targetGroups(n) {
  return Math.max(1, Math.min(MAX_GROUPS, Math.round(n / 4)));
}

/** Task-oriented clustering prompt (one group per thing the user is in the middle of). */
export function systemPrompt(n) {
  return [
    'You tidy a browser window. Group the tabs by the task or activity the user is in the middle of:',
    'one group per thing they are working on, not one group per website, product, or brand.',
    `Prefer fewer, broader groups: aim for about ${targetGroups(n)} groups, never more than ${MAX_GROUPS}.`,
    'Every group must contain at least 2 tabs. Put tabs that do not share a task with any other tab in "ungrouped".',
    'Every tab id must appear exactly once: in one group or in "ungrouped". Use only the ids given.',
    'Labels are at most 3 words and name the task (e.g. "Extension setup", "Vietnam trip", "Code review"),',
    'not a product or site (not "Password Management", not "GitHub Tools").',
    'Input: one tab per line as id|host|title.',
    'Reply with JSON: {"groups":[{"label":string,"tabIds":[int]}],"ungrouped":[int]}.',
  ].join(' ');
}

export const SYSTEM_PROMPT = systemPrompt(20);

export function buildPrompt(tabs, maxTitle = TITLE_MAX) {
  const { lines, idMap } = buildTabLines(tabs, maxTitle);
  return { system: systemPrompt(tabs.length), user: `Tabs:\n${lines.join('\n')}`, idMap };
}

function parseMaybeJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') throw new Error('response is not JSON');
  let text = raw.trim();
  // Tolerate code fences or leading chatter from models without format support.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error('response is not valid JSON');
  }
}

/** Strict check of the raw model output against the contract. Returns { ok, errors }. */
export function checkSchema(raw, n) {
  const errors = [];
  let data;
  try {
    data = parseMaybeJson(raw);
  } catch (e) {
    return { ok: false, errors: [e.message] };
  }
  if (!data || !Array.isArray(data.groups)) return { ok: false, errors: ['missing groups array'] };
  const seen = new Map();
  data.groups.forEach((g, gi) => {
    if (!g || typeof g !== 'object') return errors.push(`group ${gi} is not an object`);
    if (typeof g.label !== 'string' || !g.label.trim()) errors.push(`group ${gi} has empty label`);
    if (!Array.isArray(g.tabIds)) return errors.push(`group ${gi} has no tabIds array`);
    for (const id of g.tabIds) {
      if (!Number.isInteger(id)) errors.push(`group ${gi} has non-integer id ${JSON.stringify(id)}`);
      else if (id < 0 || id >= n) errors.push(`unknown id ${id}`);
      else if (seen.has(id)) errors.push(`duplicate id ${id}`);
      else seen.set(id, gi);
    }
  });
  for (const id of Array.isArray(data.ungrouped) ? data.ungrouped : []) {
    if (!Number.isInteger(id) || id < 0 || id >= n) errors.push(`unknown ungrouped id ${JSON.stringify(id)}`);
    else if (seen.has(id)) errors.push(`duplicate id ${id}`);
    else seen.set(id, -1);
  }
  data.groups.forEach((g, gi) => {
    if (Array.isArray(g?.tabIds) && g.tabIds.length === 1) errors.push(`group ${gi} has a single tab`);
  });
  if (data.groups.length > MAX_GROUPS) {
    errors.push(`group count ${data.groups.length} above ${MAX_GROUPS}`);
  }
  const missing = [];
  for (let i = 0; i < n; i++) if (!seen.has(i)) missing.push(i);
  if (missing.length) errors.push(`missing ids ${missing.join(',')}`);
  return { ok: errors.length === 0, errors };
}

function toIntId(v) {
  if (Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return Number(v);
  return null;
}

/**
 * Lenient repair: drop unknown ids, keep the first occurrence of duplicates, drop empty groups.
 * Leftovers ("ungrouped", the model's own "Other", single-tab groups, ids the model left out) go into
 * one "Other" at the end, which is never turned into a tab group. Maps short ids to real tab ids.
 * Returns { groups: [{label, tabIds:[realId]}], stats: {unknown, duplicates, missing} }.
 */
export function repairGroups(raw, idMap) {
  const data = parseMaybeJson(raw);
  const groupsIn = Array.isArray(data?.groups) ? data.groups : [];
  const n = idMap.length;
  const used = new Set();
  const stats = { unknown: [], duplicates: [], missing: [], singletons: [] };
  const out = [];
  groupsIn.forEach((g, gi) => {
    const ids = [];
    for (const v of Array.isArray(g?.tabIds) ? g.tabIds : []) {
      const id = toIntId(v);
      if (id === null || id < 0 || id >= n) { stats.unknown.push(v); continue; }
      if (used.has(id)) { stats.duplicates.push(id); continue; }
      used.add(id);
      ids.push(id);
    }
    if (!ids.length) return;
    const label = typeof g.label === 'string' && g.label.trim() ? g.label.trim() : `Group ${gi + 1}`;
    out.push({ label, ids });
  });
  // Leftovers: the model's "ungrouped" list, its own "Other" group, single-tab groups, missing ids.
  const leftovers = [];
  for (const v of Array.isArray(data?.ungrouped) ? data.ungrouped : []) {
    const id = toIntId(v);
    if (id === null || id < 0 || id >= n) { stats.unknown.push(v); continue; }
    if (used.has(id)) { stats.duplicates.push(id); continue; }
    used.add(id);
    leftovers.push(id);
  }
  const isOther = (g) => g.label.toLowerCase() === OTHER_LABEL.toLowerCase();
  const kept = [];
  for (const g of out) {
    if (isOther(g)) leftovers.push(...g.ids);
    else if (g.ids.length < 2) { stats.singletons.push(...g.ids); leftovers.push(...g.ids); }
    else kept.push(g);
  }
  for (let i = 0; i < n; i++) if (!used.has(i)) { stats.missing.push(i); leftovers.push(i); }
  if (leftovers.length) kept.push({ label: OTHER_LABEL, ids: leftovers.sort((x, y) => x - y) });
  return {
    groups: capGroups(kept.map((g) => ({ label: g.label, tabIds: g.ids.map((i) => idMap[i]) }))),
    stats,
  };
}

/** Fallback: group by registrable domain, in order of first appearance; singletons go to "Other". */
export function groupByDomain(tabs) {
  const byDomain = new Map();
  for (const tab of tabs) {
    const host = hostOf(tab.url || tab.pendingUrl || '');
    const key = registrableDomain(host) || OTHER_LABEL;
    if (!byDomain.has(key)) byDomain.set(key, []);
    byDomain.get(key).push(tab.id);
  }
  const groups = [];
  const other = [];
  for (const [domain, ids] of byDomain) {
    if (ids.length > 1 && domain !== OTHER_LABEL) groups.push({ label: domain, tabIds: ids });
    else other.push(...ids);
  }
  if (other.length) groups.push({ label: OTHER_LABEL, tabIds: other });
  return capGroups(groups);
}

/**
 * Compute moves. `windowTabs` = all tabs in the window (any order, with .index and .pinned).
 * `groups` = [{label, tabIds}] covering unpinned tabs. Returns
 * { startIndex, order: [tabId], moves: [{tabId, index, group}] } with no-op moves skipped,
 * simulated so that applying moves sequentially with chrome.tabs.move yields `order`.
 */
export function computeMovePlan(windowTabs, groups) {
  const sorted = [...windowTabs].sort((a, b) => a.index - b.index);
  const unpinned = sorted.filter((t) => !t.pinned);
  const startIndex = unpinned.length ? unpinned[0].index : sorted.length;
  const valid = new Set(unpinned.map((t) => t.id));
  const placed = new Set();
  const order = [];
  const groupOf = new Map();
  for (const g of groups) {
    for (const id of g.tabIds) {
      if (!valid.has(id) || placed.has(id)) continue;
      placed.add(id);
      order.push(id);
      groupOf.set(id, g.label);
    }
  }
  // Unpinned tabs not covered by any group keep relative order at the end.
  for (const t of unpinned) if (!placed.has(t.id)) { order.push(t.id); groupOf.set(t.id, OTHER_LABEL); }

  const sim = unpinned.map((t) => t.id);
  const moves = [];
  order.forEach((id, i) => {
    const cur = sim.indexOf(id);
    if (cur === i) return;
    sim.splice(cur, 1);
    sim.splice(i, 0, id);
    moves.push({ tabId: id, index: startIndex + i, group: groupOf.get(id) });
  });
  return { startIndex, order, moves };
}

const INTERNAL_RE = /^(chrome|chrome-extension|chrome-untrusted|devtools|edge|brave|about|view-source|chrome-search):/i;

/** Browser-internal pages (new tab, settings, extensions) are never clustered or grouped. */
export function isInternalTab(tab) {
  return INTERNAL_RE.test(tab.url || tab.pendingUrl || '');
}

/** Domain groups worth acting on: real (non-"Other") groups with 2+ tabs. */
export function realGroups(groups) {
  return groups.filter((g) => g.label !== OTHER_LABEL && g.tabIds.length >= 2);
}

/** Labels capped at LABEL_MAX chars; at most MAX_GROUPS groups (largest kept), overflow into "Other". */
export function capGroups(groups, max = MAX_GROUPS) {
  const isOther = (g) => g.label.trim().toLowerCase() === OTHER_LABEL.toLowerCase();
  const real = groups.filter((g) => !isOther(g)).map((g) => ({ ...g, label: truncate(g.label.trim(), LABEL_MAX).trim() || 'Group' }));
  let other = groups.filter(isOther).flatMap((g) => g.tabIds);
  let kept = real;
  if (real.length + (other.length ? 1 : 0) > max) {
    const keepN = max - 1;
    const keepSet = new Set([...real].sort((a, b) => b.tabIds.length - a.tabIds.length).slice(0, keepN));
    kept = real.filter((g) => keepSet.has(g));
    other = [...other, ...real.filter((g) => !keepSet.has(g)).flatMap((g) => g.tabIds)];
  }
  return other.length ? [...kept, { label: OTHER_LABEL, tabIds: other }] : kept;
}
