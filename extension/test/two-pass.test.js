import '../test-support/no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LABELS_SCHEMA,
  assignSchema,
  buildLabelsPrompt,
  buildAssignPrompt,
  normalizeLabels,
  assignmentsToGroups,
  orderAndMerge,
} from '../lib/two-pass.js';
import { clusterTabs, twoPass, singlePass } from '../lib/strategies.js';
import { runCluster } from '../lib/backends.js';
import { GROUPS_SCHEMA, groupByDomain } from '../lib/core.js';

const tabs30 = JSON.parse(readFileSync(new URL('./fixtures/tabs-30.json', import.meta.url)));
const mk = (id, url, title = `T${id}`) => ({ id, url, title, pinned: false });
const tabs5 = [
  mk(50, 'https://github.com/a/pull/1', 'PR 1'),
  mk(51, 'https://mail.google.com/', 'Inbox'),
  mk(52, 'https://github.com/a/pull/2', 'PR 2'),
  mk(53, 'https://booking.com/h', 'Hotel'),
  mk(54, 'https://mail.google.com/x', 'Re: invoice'),
];
const json = (o) => JSON.stringify(o);

// Mock fetch: returns queued /api/chat responses and records request bodies.
function mockFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), signal: init.signal });
    const r = responses[calls.length - 1];
    if (!r) throw new Error('unexpected extra call');
    if (r.status) return { ok: false, status: r.status, text: async () => r.text || '' };
    return { ok: true, json: async () => ({ message: { content: json(r) }, total_duration: 1e9 }) };
  };
  return { impl, calls };
}
const settings = {
  backend: 'ollama',
  endpoint: 'http://mock:11434',
  model: 'm',
  strategy: 'two-pass',
  timeoutMs: 5000,
};

test('labels schema: array of strings, 2..8', () => {
  const l = LABELS_SCHEMA.properties.labels;
  assert.deepEqual([l.type, l.items.type, l.minItems, l.maxItems], ['array', 'string', 2, 8]);
  assert.deepEqual(LABELS_SCHEMA.required, ['labels']);
});

test('assign schema: group enum = labels + Other once, min=max=n, id enum 0..n-1', () => {
  const s = assignSchema(['Code', 'Mail', 'Other'], 4);
  const arr = s.properties.assignments;
  assert.equal(arr.minItems, 4);
  assert.equal(arr.maxItems, 4);
  assert.deepEqual(arr.items.properties.group.enum, ['Code', 'Mail', 'Other']);
  assert.deepEqual(arr.items.properties.id, { type: 'integer', enum: [0, 1, 2, 3] });
  assert.deepEqual(arr.items.required, ['id', 'group']);
  const loose = assignSchema(['A'], 2, { idEnum: false });
  assert.deepEqual(loose.properties.assignments.items.properties.id, { type: 'integer' });
});

test('normalizeLabels trims, caps words, de-dupes, drops Other, caps count', () => {
  const raw = json({
    labels: [
      '  GitHub  PRs ',
      'github prs',
      'Other',
      '',
      7,
      'A Very Long Label Here',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
      'i',
    ],
  });
  assert.deepEqual(normalizeLabels(raw), ['GitHub PRs', 'A Very Long', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.throws(() => normalizeLabels(json({ labels: ['Other', ' '] })), /no usable labels/);
  assert.throws(() => normalizeLabels('garbage'), /not valid JSON/);
});

test('prompts: pass 2 reuses the same tab lines and lists labels + Other', () => {
  const p1 = buildLabelsPrompt(tabs5);
  assert.deepEqual(p1.idMap, [50, 51, 52, 53, 54]);
  assert.match(p1.system, /fewer, broader labels: about 1,/); // 5 tabs -> ~1 label
  const p2 = buildAssignPrompt(p1.lines, ['Code', 'Mail']);
  assert.ok(p2.user.startsWith('Labels: ["Code","Mail","Other"]\nTabs:\n0|github.com|PR 1'));
  assert.match(p2.system, /exactly once/);
});

test('assignments -> groups maps short ids to real ids', () => {
  const raw = json({
    assignments: [
      { id: 0, group: 'Code' },
      { id: 1, group: 'Mail' },
      { id: 2, group: 'Code' },
      { id: 3, group: 'Travel' },
      { id: 4, group: 'Mail' },
    ],
  });
  const { groups, stats } = assignmentsToGroups(raw, ['Code', 'Mail', 'Travel'], [50, 51, 52, 53, 54]);
  assert.deepEqual(groups, [
    { label: 'Code', tabIds: [50, 52] },
    { label: 'Mail', tabIds: [51, 54] },
    { label: 'Other', tabIds: [53] },
  ]); // single-tab "Travel" -> Other
  assert.deepEqual(stats, { unknown: [], duplicates: [], missing: [], unknownLabels: [] });
});

test('repair: unknown ids dropped, first duplicate wins, missing/unknown labels -> Other, empty groups dropped', () => {
  const raw = json({
    assignments: [
      { id: 0, group: 'mail' }, // case-insensitive label match
      { id: 0, group: 'Code' }, // duplicate: ignored
      { id: 9, group: 'Code' },
      { id: -1, group: 'Code' },
      { id: 'x', group: 'Code' },
      { id: '2', group: 'Ghost' }, // numeric string ok; unknown label -> Other
      { id: 1, group: 'Mail' },
    ],
  });
  const { groups, stats } = assignmentsToGroups(raw, ['Code', 'Mail'], [10, 11, 12, 13]);
  assert.deepEqual(groups, [
    { label: 'Mail', tabIds: [10, 11] },
    { label: 'Other', tabIds: [12, 13] },
  ]);
  assert.deepEqual(stats.unknown, [9, -1, 'x']);
  assert.deepEqual(stats.duplicates, [0]);
  assert.deepEqual(stats.missing, [3]);
  assert.deepEqual(stats.unknownLabels, ['Ghost']);
  // "Code" got no tabs: dropped.
  assert.ok(!groups.some((g) => g.label === 'Code'));
});

test('groups ordered by first appearance in tab order regardless of label/assignment order', () => {
  const raw = json({
    assignments: [
      { id: 3, group: 'Z' },
      { id: 2, group: 'Y' },
      { id: 1, group: 'Other' },
      { id: 0, group: 'Y' },
      { id: 4, group: 'Z' },
    ],
  });
  const { groups } = assignmentsToGroups(raw, ['Z', 'Y'], [0, 1, 2, 3, 4]);
  assert.deepEqual(
    groups.map((g) => g.label),
    ['Y', 'Z', 'Other'],
  );
  assert.deepEqual(groups[0].tabIds, [0, 2]);
});

test('single-tab groups always merge into Other (last, in tab order)', () => {
  assert.deepEqual(orderAndMerge(['A', 'B', 'A', 'C', 'Other']), [
    { label: 'A', ids: [0, 2] },
    { label: 'Other', ids: [1, 3, 4] },
  ]);
  assert.deepEqual(orderAndMerge(['A', 'A', 'B', 'B']), [
    { label: 'A', ids: [0, 1] },
    { label: 'B', ids: [2, 3] },
  ]);
});

test('mocked two-call flow: pass-1 then pass-2 bodies are correct', async () => {
  const { impl, calls } = mockFetch([
    { labels: ['Code', 'Mail', 'Travel'] },
    {
      assignments: [
        { id: 0, group: 'Code' },
        { id: 1, group: 'Mail' },
        { id: 2, group: 'Code' },
        { id: 3, group: 'Travel' },
        { id: 4, group: 'Mail' },
      ],
    },
  ]);
  const res = await runCluster(tabs5, settings, { fetchImpl: impl });
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.url, 'http://mock:11434/api/chat');
    assert.equal(c.body.model, 'm');
    assert.equal(c.body.stream, false);
    assert.equal(c.body.think, false);
    assert.deepEqual(c.body.options, { temperature: 0, num_ctx: 8192 });
    assert.ok(c.signal, 'shared run deadline signal passed');
  }
  assert.equal(calls[0].signal, calls[1].signal, 'one deadline covers both passes');
  assert.deepEqual(calls[0].body.format, LABELS_SCHEMA);
  assert.match(calls[0].body.messages[1].content, /^Tabs:\n0\|github.com\|PR 1/);
  assert.deepEqual(calls[1].body.format, assignSchema(['Code', 'Mail', 'Travel'], 5));
  assert.match(calls[1].body.messages[1].content, /^Labels: \["Code","Mail","Travel","Other"\]/);
  assert.equal(res.fallback, false);
  assert.equal(res.backend, 'ollama:m');
  assert.deepEqual(res.labels, ['Code', 'Mail', 'Travel']);
  assert.deepEqual(
    res.groups.map((g) => g.tabIds),
    [[50, 52], [51, 54], [53]],
  );
});

test('idEnum=false setting drops the id enum from pass 2', async () => {
  const { impl, calls } = mockFetch([
    { labels: ['A', 'B'] },
    {
      assignments: [
        { id: 0, group: 'A' },
        { id: 1, group: 'B' },
      ],
    },
  ]);
  await runCluster(tabs5.slice(0, 2), { ...settings, idEnum: false }, { fetchImpl: impl });
  assert.deepEqual(calls[1].body.format.properties.assignments.items.properties.id, { type: 'integer' });
});

test('pass 1 failure (HTTP 500) falls back to domain grouping without calling pass 2', async () => {
  const { impl, calls } = mockFetch([{ status: 500, text: 'boom' }]);
  const res = await runCluster(tabs5, settings, { fetchImpl: impl });
  assert.equal(calls.length, 1);
  assert.equal(res.fallback, true);
  assert.equal(res.backend, 'domain-fallback');
  assert.match(res.fallbackReason, /pass 1 \(labels\) failed: Ollama HTTP 500: boom/);
  assert.deepEqual(res.groups, groupByDomain(tabs5));
});

test('pass 1 unusable labels and pass 2 failure also fall back', async () => {
  let r = await runCluster(tabs5, settings, { fetchImpl: mockFetch([{ labels: ['Other'] }]).impl });
  assert.equal(r.fallback, true);
  assert.match(r.fallbackReason, /no usable labels/);
  r = await runCluster(tabs5, settings, { fetchImpl: mockFetch([{ labels: ['A', 'B'] }, { status: 503 }]).impl });
  assert.equal(r.fallback, true);
  assert.match(r.fallbackReason, /pass 2 \(assign\) failed: Ollama HTTP 503/);
});

test('whole-run timeout aborts across passes', async () => {
  let n = 0;
  const impl = (_u, { signal }) => {
    n++;
    if (n === 1)
      return Promise.resolve({ ok: true, json: async () => ({ message: { content: json({ labels: ['A', 'B'] }) } }) });
    return new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason)));
  };
  const t0 = Date.now();
  const r = await runCluster(tabs5, { ...settings, timeoutMs: 60 }, { fetchImpl: impl });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(n, 2);
  assert.equal(r.fallback, true);
  assert.match(r.fallbackReason, /pass 2 .*timed out/);
});

test('single-pass strategy still works through clusterTabs', async () => {
  const chatCalls = [];
  const chat = async (prompt, schema) => {
    chatCalls.push(schema);
    return {
      content: json({
        groups: [
          { label: 'Code', tabIds: [0, 2] },
          { label: 'Mail', tabIds: [1, 4] },
        ],
      }),
    };
  };
  const res = await clusterTabs(tabs5, { chat, strategy: 'single-pass' });
  assert.equal(chatCalls.length, 1);
  assert.equal(chatCalls[0], GROUPS_SCHEMA);
  assert.deepEqual(res.groups, [
    { label: 'Code', tabIds: [50, 52] },
    { label: 'Mail', tabIds: [51, 54] },
    { label: 'Other', tabIds: [53] },
  ]);
  assert.ok(res.strictErrors.some((e) => e.includes('missing ids 3')));
  assert.equal(typeof singlePass, 'function');
});

test('two-pass on the 30-tab fixture with a perfect mock covers every tab once', async () => {
  const topics = [...new Set(tabs30.map((t) => t.topic))].slice(0, 8);
  const chat = async (_p, schema) =>
    schema === LABELS_SCHEMA
      ? { content: json({ labels: topics }) }
      : {
          content: json({
            assignments: tabs30.map((t, i) => ({ id: i, group: topics.includes(t.topic) ? t.topic : 'Other' })),
          }),
        };
  const res = await twoPass(tabs30, chat);
  const ids = res.groups.flatMap((g) => g.tabIds);
  assert.equal(ids.length, 30);
  assert.equal(new Set(ids).size, 30);
  assert.deepEqual(
    res.groups.map((g) => g.label),
    topics,
  );
});
