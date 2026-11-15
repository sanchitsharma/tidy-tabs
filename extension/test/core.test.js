import '../test-support/no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GROUPS_SCHEMA, TITLE_MAX, buildPrompt, buildTabLines, checkSchema, repairGroups,
  groupByDomain, registrableDomain, hostOf, computeMovePlan,
} from '../lib/core.js';
import { buildChatBody, chatUrl, extractChatResult, callOllama } from '../lib/ollama-request.js';

const tabs30 = JSON.parse(readFileSync(new URL('./fixtures/tabs-30.json', import.meta.url)));
const mk = (id, index, url, title = `T${id}`, pinned = false) => ({ id, index, url, title, pinned });

// Apply moves the way chrome.tabs.move does, to verify plans end-to-end.
function simulate(windowTabs, moves) {
  const arr = [...windowTabs].sort((a, b) => a.index - b.index).map((t) => t.id);
  for (const m of moves) {
    arr.splice(arr.indexOf(m.tabId), 1);
    arr.splice(m.index, 0, m.tabId);
  }
  return arr;
}

test('schema has the contract shape', () => {
  assert.deepEqual(GROUPS_SCHEMA.required, ['groups']);
  assert.deepEqual(GROUPS_SCHEMA.properties.groups.items.required, ['label', 'tabIds']);
  assert.equal(GROUPS_SCHEMA.properties.groups.items.properties.tabIds.items.type, 'integer');
});

test('checkSchema accepts a valid response', () => {
  const raw = JSON.stringify({ groups: [{ label: 'A', tabIds: [0, 1] }], ungrouped: [2] });
  assert.deepEqual(checkSchema(raw, 3), { ok: true, errors: [] });
  const single = checkSchema({ groups: [{ label: 'A', tabIds: [0, 1] }, { label: 'B', tabIds: [2] }] }, 3);
  assert.deepEqual(single.errors, ['group 1 has a single tab']);
  const nine = { groups: Array.from({ length: 9 }, (_, i) => ({ label: `G${i}`, tabIds: [2 * i, 2 * i + 1] })) };
  assert.ok(checkSchema(nine, 18).errors.includes('group count 9 above 8'));
});

test('checkSchema reports missing, duplicate, unknown, bad count, empty label, bad JSON', () => {
  const r = checkSchema({ groups: [{ label: '', tabIds: [0, 0, 9, 'x'] }] }, 3);
  assert.equal(r.ok, false);
  const s = r.errors.join(' | ');
  for (const frag of ['empty label', 'duplicate id 0', 'unknown id 9', 'non-integer', 'missing ids 1,2']) {
    assert.ok(s.includes(frag), `expected "${frag}" in ${s}`);
  }
  assert.equal(checkSchema('not json', 2).ok, false);
  assert.equal(checkSchema('{"foo":1}', 2).errors[0], 'missing groups array');
});

test('repairGroups maps short ids to real tab ids', () => {
  const idMap = [101, 202, 303, 404];
  const { groups, stats } = repairGroups('{"groups":[{"label":"X","tabIds":[3,0]},{"label":"Y","tabIds":[1,2]}]}', idMap);
  assert.deepEqual(groups, [{ label: 'X', tabIds: [404, 101] }, { label: 'Y', tabIds: [202, 303] }]);
  assert.deepEqual(stats, { unknown: [], duplicates: [], missing: [], singletons: [] });
});

test('repairGroups drops unknown ids, keeps first duplicate, adds Other at end', () => {
  const idMap = [10, 11, 12, 13, 14];
  const raw = { groups: [
    { label: 'A', tabIds: [0, 1, 99, -1] },
    { label: 'B', tabIds: [1, 2, '3'] }, // "3" as a numeric string is accepted
    { label: 'Empty', tabIds: [42] },
  ] };
  const { groups, stats } = repairGroups(raw, idMap);
  assert.deepEqual(groups, [
    { label: 'A', tabIds: [10, 11] },
    { label: 'B', tabIds: [12, 13] },
    { label: 'Other', tabIds: [14] },
  ]);
  assert.deepEqual(stats.unknown, [99, -1, 42]);
  assert.deepEqual(stats.duplicates, [1]);
  assert.deepEqual(stats.missing, [4]);
});

test('repairGroups: model Other, ungrouped, singletons and missing all become one Other at the end', () => {
  const raw = { groups: [{ label: 'other', tabIds: [0] }, { label: '  ', tabIds: [1, 2] }, { label: 'Solo', tabIds: [3] }], ungrouped: [5, 99, 1] };
  const { groups, stats } = repairGroups(raw, [10, 11, 12, 13, 14, 15]);
  assert.deepEqual(groups, [{ label: 'Group 2', tabIds: [11, 12] }, { label: 'Other', tabIds: [10, 13, 14, 15] }]);
  assert.deepEqual(stats.singletons, [3]);
  assert.deepEqual(stats.missing, [4]);
  assert.deepEqual(stats.unknown, [99]);
  assert.deepEqual(stats.duplicates, [1]);
});

test('repairGroups tolerates fenced JSON and garbage group entries', () => {
  const raw = 'Sure!\n```json\n{"groups":[null,{"label":"A","tabIds":[0,1]},{"label":"B"}]}\n```';
  const { groups } = repairGroups(raw, [1, 2]);
  assert.deepEqual(groups, [{ label: 'A', tabIds: [1, 2] }]);
});

test('repairGroups throws on non-JSON so caller can fall back', () => {
  assert.throws(() => repairGroups('no json here', [1]));
});

test('prompt lines use short ids, host, truncated title, and strip separators', () => {
  const long = 'x'.repeat(200);
  const { lines, idMap } = buildTabLines([
    mk(555, 0, 'https://www.example.com/a', long),
    mk(777, 1, 'chrome://extensions/', 'Ext | with\npipes'),
    mk(888, 2, 'not a url', ''),
  ]);
  assert.deepEqual(idMap, [555, 777, 888]);
  assert.equal(lines[0], `0|example.com|${'x'.repeat(TITLE_MAX)}`);
  assert.equal(lines[1], '1|extensions|Ext with pipes');
  assert.equal(lines[2], '2||Untitled');
});

test('truncation counts characters, not UTF-16 units', () => {
  const emoji = '😀'.repeat(100);
  const { lines } = buildTabLines([mk(1, 0, 'https://a.com', emoji)]);
  assert.equal(Array.from(lines[0].split('|')[2]).length, TITLE_MAX);
});

test('buildPrompt on 30-tab fixture', () => {
  const p = buildPrompt(tabs30);
  const lines = p.user.split('\n').slice(1);
  assert.equal(lines.length, 30);
  assert.equal(p.idMap.length, 30);
  assert.ok(lines.every((l, i) => l.startsWith(`${i}|`)));
  assert.ok(lines.every((l) => l.split('|')[2].length <= TITLE_MAX));
  assert.match(p.system, /exactly once/);
  assert.match(p.system, /aim for about 8 groups/); // round(30/4) capped at 8
  assert.match(buildPrompt(tabs30.slice(0, 10)).system, /aim for about 3 groups/);
});

test('ollama body matches the planned contract', () => {
  const body = buildChatBody({ system: 'S', user: 'U' }, 'qwen3:1.7b');
  assert.equal(body.stream, false);
  assert.equal(body.think, false);
  assert.deepEqual(body.options, { temperature: 0, num_ctx: 8192 });
  assert.equal(body.format, GROUPS_SCHEMA);
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(chatUrl('http://h:11434///'), 'http://h:11434/api/chat');
  const r = extractChatResult({ message: { content: '{"groups":[]}' }, total_duration: 2_500_000_000 });
  assert.equal(r.timing.totalMs, 2500);
  assert.throws(() => extractChatResult({ message: { content: '' } }));
});

test('callOllama surfaces HTTP errors and timeouts', async () => {
  const bad = async () => ({ ok: false, status: 404, text: async () => 'model not found' });
  await assert.rejects(callOllama({ system: '', user: '' }, { fetchImpl: bad }), /HTTP 404: model not found/);
  const hang = (_u, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => {
    const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
  }));
  await assert.rejects(callOllama({ system: '', user: '' }, { fetchImpl: hang, timeoutMs: 20 }), /timed out/);
});

test('registrableDomain heuristics', () => {
  assert.equal(registrableDomain('mail.google.com'), 'google.com');
  assert.equal(registrableDomain('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(registrableDomain('acme.github.io'), 'acme.github.io');
  assert.equal(registrableDomain('192.0.2.10'), '192.0.2.10');
  assert.equal(registrableDomain('localhost'), 'localhost');
  assert.equal(registrableDomain(''), '');
  assert.equal(hostOf('https://www.github.com/x'), 'github.com');
  assert.equal(hostOf('arc://settings'), 'settings');
});

test('groupByDomain clusters by registrable domain, singletons to Other at end', () => {
  const tabs = [
    mk(1, 0, 'https://mail.google.com/'), mk(2, 1, 'https://github.com/a'),
    mk(3, 2, 'https://docs.google.com/'), mk(4, 3, 'https://example.org/'),
    mk(5, 4, 'https://github.com/b'), mk(6, 5, 'chrome://newtab/'),
  ];
  assert.deepEqual(groupByDomain(tabs), [
    { label: 'google.com', tabIds: [1, 3] },
    { label: 'github.com', tabIds: [2, 5] },
    { label: 'Other', tabIds: [4, 6] },
  ]);
});

test('groupByDomain on fixture covers every tab once', () => {
  const groups = groupByDomain(tabs30);
  const ids = groups.flatMap((g) => g.tabIds);
  assert.equal(ids.length, 30);
  assert.equal(new Set(ids).size, 30);
  assert.equal(groups.at(-1).label, 'Other');
});

test('move plan starts after pinned tabs and yields grouped order', () => {
  const win = [
    mk(1, 0, 'a', 'p1', true), mk(2, 1, 'a', 'p2', true),
    mk(10, 2, 'x'), mk(11, 3, 'y'), mk(12, 4, 'x'), mk(13, 5, 'y'), mk(14, 6, 'z'),
  ];
  const groups = [{ label: 'X', tabIds: [10, 12] }, { label: 'Y', tabIds: [11, 13] }, { label: 'Z', tabIds: [14] }];
  const plan = computeMovePlan(win, groups);
  assert.equal(plan.startIndex, 2);
  assert.deepEqual(plan.order, [10, 12, 11, 13, 14]);
  assert.ok(plan.moves.every((m) => m.index >= 2));
  assert.deepEqual(simulate(win, plan.moves), [1, 2, 10, 12, 11, 13, 14]);
  assert.equal(plan.moves.length, 1); // only tab 12 needs to move
  assert.deepEqual(plan.moves[0], { tabId: 12, index: 3, group: 'X' });
});

test('move plan: already-ordered window needs no moves; unsorted input ok', () => {
  const win = [mk(3, 2, 'c'), mk(1, 0, 'a', 'p', true), mk(2, 1, 'b')];
  const plan = computeMovePlan(win, [{ label: 'A', tabIds: [2, 3] }]);
  assert.equal(plan.startIndex, 1);
  assert.deepEqual(plan.moves, []);
});

test('move plan ignores pinned/unknown ids in groups and appends uncovered tabs', () => {
  const win = [mk(1, 0, 'a', 'p', true), mk(2, 1, 'b'), mk(3, 2, 'c'), mk(4, 3, 'd')];
  const plan = computeMovePlan(win, [{ label: 'G', tabIds: [1, 999, 4, 4] }]);
  assert.deepEqual(plan.order, [4, 2, 3]);
  assert.deepEqual(simulate(win, plan.moves), [1, 4, 2, 3]);
});

test('move plan on shuffled 30-tab fixture with pinned tabs reaches target order', () => {
  const pinned = [mk(1, 0, 'https://a.com', 'pin', true), mk(2, 1, 'https://b.com', 'pin', true)];
  const win = [...pinned, ...tabs30.map((t, i) => ({ ...t, index: i + 2 }))];
  const groups = groupByDomain(tabs30);
  const plan = computeMovePlan(win, groups);
  assert.equal(plan.startIndex, 2);
  assert.deepEqual(simulate(win, plan.moves), [1, 2, ...groups.flatMap((g) => g.tabIds)]);
});
