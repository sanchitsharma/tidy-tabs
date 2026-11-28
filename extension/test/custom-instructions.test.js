// Options > Prompt: the user's grouping instructions replace the "how to group" part of the prompt;
// the rules the parser relies on are always added, and the default text keeps the built-in prompt.
import '../test-support/no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_INSTRUCTIONS,
  INSTRUCTIONS_MAX,
  normalizeInstructions,
  systemPrompt,
  systemPromptFor,
  buildPrompt,
} from '../lib/core.js';
import { labelsSystem, buildLabelsPrompt, buildAssignPrompt, ASSIGN_SYSTEM } from '../lib/two-pass.js';
import { normalizeLimits, targetGroups, checkSchema, repairGroups, groupByDomain } from '../lib/core.js';
import { labelsSchema, normalizeLabels, assignmentsToGroups } from '../lib/two-pass.js';
import { clusterTabs } from '../lib/strategies.js';
import { runCluster } from '../lib/backends.js';
import { DEFAULTS } from '../lib/settings.js';

const mk = (id, url, title) => ({ id, url, title, pinned: false });
const tabs = [
  mk(7, 'https://github.com/a/pull/1', 'PR 1'),
  mk(8, 'https://mail.google.com/', 'Inbox'),
  mk(9, 'https://github.com/a/pull/2', 'PR 2'),
  mk(10, 'https://mail.google.com/x', 'Re: invoice'),
];
const CUSTOM = 'Keep work and personal tabs apart.\nLabel groups in Spanish. Aim for {groups} groups, max {maxGroups}.';
const reply = (o) => ({ content: JSON.stringify(o), timing: {} });

test('default: empty or unchanged default text gives the built-in prompts, byte for byte', () => {
  assert.equal(DEFAULTS.groupingInstructions, '');
  for (const text of ['', '   ', DEFAULT_INSTRUCTIONS, `  ${DEFAULT_INSTRUCTIONS}\n`, undefined]) {
    assert.equal(normalizeInstructions(text), '');
    assert.equal(systemPromptFor(12, text), systemPrompt(12));
    assert.equal(buildLabelsPrompt(tabs, undefined, text).system, labelsSystem(tabs.length));
    assert.equal(buildAssignPrompt(['0|a|b'], ['X'], text).system, ASSIGN_SYSTEM);
  }
});

test('default textarea text matches the guidance in the built-in prompt', () => {
  const builtIn = systemPrompt(12);
  for (const line of DEFAULT_INSTRUCTIONS.split('\n')) {
    assert.ok(builtIn.includes(line.replace('{groups}', '3').replace(/\.$/, '')), `missing: ${line}`);
  }
});

test('custom: the text is used, placeholders filled, and the fixed rules always appended', () => {
  const sys = systemPromptFor(12, CUSTOM);
  assert.match(sys, /Keep work and personal tabs apart\.\nLabel groups in Spanish\. Aim for 3 groups, max 8\./);
  assert.doesNotMatch(sys, /\{groups\}|\{maxGroups\}/);
  assert.doesNotMatch(sys, /not a product or site/, 'built-in guidance replaced');
  assert.match(sys, /exactly once/);
  assert.match(sys, /at least 2 tabs/);
  assert.match(sys, /"ungrouped"/);
  assert.match(sys, /id\|host\|title/);
  assert.match(sys, /Reply with JSON: \{"groups"/);
  assert.equal(buildPrompt(tabs, undefined, CUSTOM).system, systemPromptFor(tabs.length, CUSTOM));
});

test('custom: two-pass gets the instructions in both passes', () => {
  const p1 = buildLabelsPrompt(tabs, undefined, CUSTOM);
  assert.match(p1.system, /Label groups in Spanish\. Aim for 1 groups/);
  assert.match(p1.system, /Reply with JSON: \{"labels"/);
  const p2 = buildAssignPrompt(p1.lines, ['Código'], CUSTOM);
  assert.ok(p2.system.startsWith(ASSIGN_SYSTEM));
  assert.match(p2.system, /Keep work and personal tabs apart/);
});

test('custom text is capped and line endings normalized', () => {
  assert.equal(normalizeInstructions('x'.repeat(INSTRUCTIONS_MAX + 500)).length, INSTRUCTIONS_MAX);
  assert.equal(normalizeInstructions('a\r\nb\rc'), 'a\nb\nc');
});

test('clusterTabs passes the instructions to every call (single- and two-pass)', async () => {
  const systems = [];
  const single = async (p) => {
    systems.push(p.system);
    return reply({ groups: [{ label: 'Code', tabIds: [0, 2] }], ungrouped: [1, 3] });
  };
  const r1 = await clusterTabs(tabs, { chat: single, strategy: 'single-pass', instructions: CUSTOM });
  assert.equal(r1.fallback, false);
  const answers = [
    reply({ labels: ['Code', 'Mail'] }),
    reply({
      assignments: [
        { id: 0, group: 'Code' },
        { id: 1, group: 'Mail' },
        { id: 2, group: 'Code' },
        { id: 3, group: 'Mail' },
      ],
    }),
  ];
  const two = async (p) => {
    systems.push(p.system);
    return answers.shift();
  };
  const r2 = await clusterTabs(tabs, { chat: two, strategy: 'two-pass', instructions: CUSTOM });
  assert.equal(r2.fallback, false);
  assert.equal(systems.length, 3);
  for (const s of systems) assert.match(s, /Keep work and personal tabs apart/);
});

test('runCluster reads groupingInstructions from settings and reports it', async () => {
  const sent = [];
  const nativeSend = async (host, msg) => {
    sent.push(msg);
    return {
      ok: true,
      content: JSON.stringify({ groups: [{ label: 'Code', tabIds: [0, 2] }], ungrouped: [1, 3] }),
      model: 'fake',
      timing: { totalMs: 1 },
    };
  };
  const res = await runCluster(tabs, { ...DEFAULTS, groupingInstructions: CUSTOM }, { nativeSend });
  assert.match(sent[0].system, /Label groups in Spanish/);
  assert.equal(res.fallback, false);
  assert.equal(res.customInstructions, true);
  assert.match(res.exchanges[0].system, /Label groups in Spanish/);

  const def = await runCluster(tabs, { ...DEFAULTS }, { nativeSend });
  assert.equal(sent[1].system, systemPrompt(tabs.length));
  assert.equal(def.customInstructions, false);
});

// ---- Group-count settings (Options > Prompt: "1 group per N tabs", "Maximum groups") ----

test('normalizeLimits clamps and defaults the group-count settings', () => {
  assert.deepEqual(normalizeLimits(), { tabsPerGroup: 4, maxGroups: 8 });
  assert.deepEqual(normalizeLimits({ tabsPerGroup: '1', maxGroups: '50' }), { tabsPerGroup: 2, maxGroups: 16 });
  assert.deepEqual(normalizeLimits({ tabsPerGroup: '', maxGroups: 'x' }), { tabsPerGroup: 4, maxGroups: 8 });
  assert.equal(targetGroups(20, { tabsPerGroup: 2, maxGroups: 16 }), 10);
  assert.equal(targetGroups(40, { tabsPerGroup: 2, maxGroups: 6 }), 6);
});

test('default limits keep the built-in prompts byte for byte', () => {
  assert.equal(systemPrompt(20, { tabsPerGroup: 4, maxGroups: 8 }), systemPrompt(20));
  assert.equal(labelsSystem(20, { tabsPerGroup: 4, maxGroups: 8 }), labelsSystem(20));
});

test('custom limits fill {groups}/{maxGroups} and the fixed rules, built-in and custom prompts', () => {
  const limits = { tabsPerGroup: 2, maxGroups: 12 };
  assert.match(systemPrompt(20, limits), /aim for about 10 groups, never more than 12\./);
  assert.match(labelsSystem(20, limits), /about 10, at most 12\./);
  const sys = systemPromptFor(20, CUSTOM, limits);
  assert.match(sys, /Aim for 10 groups, max 12\./);
  assert.match(sys, /never more than 12 groups/);
  assert.match(buildLabelsPrompt(tabs, undefined, CUSTOM, limits).system, /at most 12 labels/);
});

test('maxGroups is enforced on every path', () => {
  const many = Array.from({ length: 12 }, (_, g) => ({ label: `G${g}`, tabIds: [g * 2, g * 2 + 1] }));
  const idMap = Array.from({ length: 24 }, (_, i) => 100 + i);
  assert.ok(checkSchema({ groups: many }, 24, 10).errors.includes('group count 12 above 10'));
  assert.deepEqual(checkSchema({ groups: many }, 24, 12).errors, []);
  assert.equal(repairGroups({ groups: many }, idMap, 5).groups.length, 5);
  assert.equal(repairGroups({ groups: many }, idMap, 16).groups.length, 12);
  assert.equal(labelsSchema(12).properties.labels.maxItems, 12);
  const labels = many.map((g) => g.label);
  assert.equal(normalizeLabels({ labels }, 10).length, 10);
  const assignments = idMap.map((_, i) => ({ id: i, group: `G${Math.floor(i / 2)}` }));
  assert.equal(assignmentsToGroups({ assignments }, labels, idMap, 4).groups.length, 4);
  const domainTabs = idMap.map((id, i) => ({ id, url: `https://site${Math.floor(i / 2)}.com/` }));
  assert.equal(groupByDomain(domainTabs, 3).length, 3);
  assert.equal(groupByDomain(domainTabs, 16).length, 12);
});

test('runCluster passes the saved limits to the model and the safety net', async () => {
  const sent = [];
  const nativeSend = async (_host, msg) => {
    sent.push(msg);
    const groups = Array.from({ length: 6 }, (_, g) => ({ label: `G${g}`, tabIds: [g * 2, g * 2 + 1] }));
    return { ok: true, content: JSON.stringify({ groups }), model: 'haiku', timing: {} };
  };
  const twelve = Array.from({ length: 12 }, (_, i) => ({ id: 500 + i, url: `https://a${i}.com/`, title: `T${i}` }));
  const res = await runCluster(
    twelve,
    { ...DEFAULTS, backend: 'claude-haiku', strategy: 'single-pass', tabsPerGroup: 2, maxGroups: 3 },
    { nativeSend },
  );
  assert.match(sent[0].system, /aim for about 3 groups, never more than 3\./);
  assert.equal(res.groups.length, 3);
});
