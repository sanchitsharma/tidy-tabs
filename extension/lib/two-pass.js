// Two-pass clustering, pure logic (no chrome.*, no fetch).
// Pass 1 proposes labels; pass 2 assigns every tab id to one label via an enum-constrained schema.
import { OTHER_LABEL, buildTabLines, TITLE_MAX, targetGroups, capGroups, LABEL_MAX, truncate } from './core.js';

export const LABELS_MIN = 2;
export const LABELS_MAX = 8;

export const LABELS_SCHEMA = {
  type: 'object',
  properties: {
    labels: { type: 'array', items: { type: 'string' }, minItems: LABELS_MIN, maxItems: LABELS_MAX },
  },
  required: ['labels'],
};

export function labelsSystem(n) {
  return [
    'You tidy a browser window. Propose short labels (at most 3 words) for the tasks or activities the',
    'user is in the middle of: one label per thing they are working on, not per website, product, or brand.',
    `Prefer fewer, broader labels: about ${targetGroups(n)}, at most ${LABELS_MAX}. Each label must fit at least 2 tabs.`,
    'Name the task (e.g. "Extension setup", "Vietnam trip"), not a product. Do not include "Other".',
    'Input: one tab per line as id|host|title.',
    'Reply with JSON: {"labels":[string]}.',
  ].join(' ');
}
export const LABELS_SYSTEM = labelsSystem(20);

export const ASSIGN_SYSTEM = [
  'You organize browser tabs. Assign every tab id exactly once to exactly one of the given labels.',
  'Use "Other" for tabs that share no task with another tab. Input: the labels, then one tab per line as id|host|title.',
  'Reply with JSON: {"assignments":[{"id":int,"group":label}]} with one entry per tab, in id order.',
].join(' ');

/** Pass-2 schema: group constrained to labels + Other; exactly n assignments; ids optionally enum'd. */
export function assignSchema(labels, n, { idEnum = true } = {}) {
  const groupEnum = [...labels.filter((l) => l !== OTHER_LABEL), OTHER_LABEL];
  const id = idEnum ? { type: 'integer', enum: Array.from({ length: n }, (_, i) => i) } : { type: 'integer' };
  return {
    type: 'object',
    properties: {
      assignments: {
        type: 'array',
        minItems: n,
        maxItems: n,
        items: {
          type: 'object',
          properties: { id, group: { type: 'string', enum: groupEnum } },
          required: ['id', 'group'],
        },
      },
    },
    required: ['assignments'],
  };
}

export function buildLabelsPrompt(tabs, maxTitle = TITLE_MAX) {
  const { lines, idMap } = buildTabLines(tabs, maxTitle);
  return { system: labelsSystem(tabs.length), user: `Tabs:\n${lines.join('\n')}`, idMap, lines };
}

export function buildAssignPrompt(lines, labels) {
  const all = [...labels.filter((l) => l !== OTHER_LABEL), OTHER_LABEL];
  return { system: ASSIGN_SYSTEM, user: `Labels: ${JSON.stringify(all)}\nTabs:\n${lines.join('\n')}` };
}

export function parseJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw ?? '')
    .trim()
    .replace(/^```(?:json)?\s*|```$/g, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('response is not valid JSON');
  return JSON.parse(text.slice(start, end + 1));
}

/** Trim, drop empties, cap at 3 words, de-dupe case-insensitively, drop "Other", cap count. */
export function normalizeLabels(raw) {
  const data = parseJson(raw);
  const seen = new Set();
  const out = [];
  for (const l of Array.isArray(data?.labels) ? data.labels : []) {
    if (typeof l !== 'string') continue;
    const label = truncate(l.replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' '), LABEL_MAX).trim();
    const key = label.toLowerCase();
    if (!label || key === OTHER_LABEL.toLowerCase() || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  if (!out.length) throw new Error('pass 1 returned no usable labels');
  return out.slice(0, LABELS_MAX);
}

function toIntId(v) {
  if (Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return Number(v);
  return null;
}

/**
 * Pass-2 output -> groups of real tab ids. Unknown ids dropped, first occurrence of duplicates
 * wins, unknown labels and missing ids go to Other, empty groups dropped. Groups are ordered by the
 * first appearance of their tabs in the current tab order (short id order), with Other last. Single-tab
 * groups always merge into Other (never a tab group).
 */
export function assignmentsToGroups(raw, labels, idMap) {
  const data = parseJson(raw);
  const n = idMap.length;
  const canon = new Map(labels.map((l) => [l.toLowerCase(), l]));
  const groupOfId = new Array(n).fill(null);
  const stats = { unknown: [], duplicates: [], missing: [], unknownLabels: [] };
  for (const a of Array.isArray(data?.assignments) ? data.assignments : []) {
    const id = toIntId(a?.id);
    if (id === null || id < 0 || id >= n) {
      stats.unknown.push(a?.id);
      continue;
    }
    if (groupOfId[id] !== null) {
      stats.duplicates.push(id);
      continue;
    }
    const g = typeof a.group === 'string' ? a.group.trim() : '';
    let label = canon.get(g.toLowerCase());
    if (!label) {
      if (g.toLowerCase() !== OTHER_LABEL.toLowerCase()) stats.unknownLabels.push(g);
      label = OTHER_LABEL;
    }
    groupOfId[id] = label;
  }
  for (let i = 0; i < n; i++)
    if (groupOfId[i] === null) {
      stats.missing.push(i);
      groupOfId[i] = OTHER_LABEL;
    }
  return {
    groups: capGroups(orderAndMerge(groupOfId).map((g) => ({ label: g.label, tabIds: g.ids.map((i) => idMap[i]) }))),
    stats,
  };
}

/** groupOfId[shortId] = label -> [{label, ids}] in first-appearance order; singletons + Other last. */
export function orderAndMerge(groupOfId) {
  const byLabel = new Map();
  groupOfId.forEach((label, id) => {
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(id);
  });
  const groups = [...byLabel].map(([label, ids]) => ({ label, ids })).filter((g) => g.ids.length);
  const leftovers = groups.filter((g) => g.label === OTHER_LABEL || g.ids.length < 2).flatMap((g) => g.ids);
  const kept = groups.filter((g) => g.label !== OTHER_LABEL && g.ids.length >= 2);
  return leftovers.length ? [...kept, { label: OTHER_LABEL, ids: leftovers.sort((a, b) => a - b) }] : kept;
}
