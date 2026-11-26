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
