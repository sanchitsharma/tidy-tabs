import '../test-support/no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNativeRequest, parseNativeResponse, claudeChat, NATIVE_HOST } from '../lib/claude-native.js';
import { runCluster, resolveStrategy, DEFAULT_BACKEND } from '../lib/backends.js';
import { DEFAULTS } from '../lib/settings.js';
import { GROUPS_SCHEMA, groupByDomain } from '../lib/core.js';
import { LABELS_SCHEMA } from '../lib/two-pass.js';
import { withTimeout, probeSettles, TimeoutError } from '../lib/timeout.js';

const mk = (id, url, title) => ({ id, url, title, pinned: false });
const tabs = [
  mk(7, 'https://github.com/a/pull/1', 'PR 1'), mk(8, 'https://mail.google.com/', 'Inbox'),
  mk(9, 'https://github.com/a/pull/2', 'PR 2'), mk(10, 'https://mail.google.com/x', 'Re: hi'),
];
const ok = (obj) => ({ ok: true, content: JSON.stringify(obj), model: 'claude-haiku-5-5', timing: { totalMs: 5 } });

test('defaults: Claude Haiku backend, auto strategy', () => {
  assert.equal(DEFAULT_BACKEND, 'claude-haiku');
  assert.equal(DEFAULTS.backend, 'claude-haiku');
  assert.equal(DEFAULTS.claudeModel, 'haiku');
  assert.equal(resolveStrategy('auto', 'claude-haiku'), 'single-pass');
  assert.equal(resolveStrategy('auto', 'ollama'), 'two-pass');
  assert.equal(resolveStrategy('two-pass', 'claude-haiku'), 'two-pass');
});

test('buildNativeRequest maps prompt + schema + model + remaining time', () => {
  const m = buildNativeRequest({ system: 'S', user: 'U' }, GROUPS_SCHEMA, { model: 'haiku', timeoutMs: 4321.7 });
  assert.deepEqual(m, { type: 'chat', model: 'haiku', system: 'S', user: 'U', schema: GROUPS_SCHEMA, timeoutMs: 4322 });
  assert.equal(buildNativeRequest({ system: '', user: 'U' }, {}, { model: '' }).model, 'haiku');
  assert.equal('timeoutMs' in buildNativeRequest({ system: '', user: 'U' }, {}), false);
});

test('parseNativeResponse: ok, error, empty, missing', () => {
  assert.deepEqual(parseNativeResponse(ok({ a: 1 })), { content: '{"a":1}', timing: { totalMs: 5, model: 'claude-haiku-5-5' } });
  assert.throws(() => parseNativeResponse({ ok: false, error: 'boom' }), /claude host: boom/);
  assert.throws(() => parseNativeResponse({ ok: true, content: '' }), /empty content/);
  assert.throws(() => parseNativeResponse(undefined), /install\.sh/);
});

test('runCluster default (Claude, auto -> single call) sends one native message', async () => {
  const sent = [];
  const nativeSend = async (host, msg) => {
    sent.push({ host, msg });
    return ok({ groups: [{ label: 'Code', tabIds: [0, 2] }, { label: 'Mail', tabIds: [1, 3] }] });
  };
  const res = await runCluster(tabs, { ...DEFAULTS }, { nativeSend });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].host, NATIVE_HOST);
  assert.equal(sent[0].msg.model, 'haiku');
  assert.deepEqual(sent[0].msg.schema, GROUPS_SCHEMA);
  assert.ok(sent[0].msg.timeoutMs > 0 && sent[0].msg.timeoutMs <= DEFAULTS.timeoutMs);
  assert.match(sent[0].msg.user, /^Tabs:\n0\|github\.com\|PR 1/);
  assert.equal(res.backend, 'claude:haiku');
  assert.equal(res.strategy, 'single-pass');
  assert.deepEqual(res.groups, [{ label: 'Code', tabIds: [7, 9] }, { label: 'Mail', tabIds: [8, 10] }]);
});

test('Claude works with two-pass too', async () => {
  const schemas = [];
  const nativeSend = async (_h, msg) => {
    schemas.push(msg.schema);
    return schemas.length === 1
      ? ok({ labels: ['Code', 'Mail'] })
      : ok({ assignments: [{ id: 0, group: 'Code' }, { id: 1, group: 'Mail' }, { id: 2, group: 'Code' }, { id: 3, group: 'Mail' }] });
  };
  const res = await runCluster(tabs, { ...DEFAULTS, strategy: 'two-pass' }, { nativeSend });
  assert.equal(schemas.length, 2);
  assert.deepEqual(schemas[0], LABELS_SCHEMA);
  assert.deepEqual(schemas[1].properties.assignments.items.properties.group.enum, ['Code', 'Mail', 'Other']);
  assert.equal(res.fallback, false);
  assert.deepEqual(res.groups.map((g) => g.label), ['Code', 'Mail']);
});

test('host missing -> domain fallback', async () => {
  const nativeSend = async () => { throw new Error('native messaging: Specified native messaging host not found.'); };
  const res = await runCluster(tabs, { ...DEFAULTS }, { nativeSend });
  assert.equal(res.fallback, true);
  assert.equal(res.backend, 'domain-fallback');
  assert.equal(res.attemptedBackend, 'claude:haiku');
  assert.match(res.fallbackReason, /host not found/);
  assert.deepEqual(res.groups, groupByDomain(tabs));
});

test('run deadline aborts a hanging native call', async () => {
  const nativeSend = () => new Promise(() => {});
  const t0 = Date.now();
  const res = await runCluster(tabs, { ...DEFAULTS, timeoutMs: 50 }, { nativeSend });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(res.fallback, true);
  assert.match(res.fallbackReason, /timed out/);
});

test('claudeChat refuses to start after the deadline passed', async () => {
  const chat = claudeChat({ deadline: Date.now() - 1, send: async () => ok({}) });
  await assert.rejects(chat({ system: '', user: 'u' }, {}), /timed out/);
});

test('withTimeout: resolves, rejects passthrough, times out on a never-settling promise', async () => {
  assert.equal(await withTimeout(Promise.resolve(3), 50), 3);
  assert.equal(await withTimeout(() => Promise.resolve(4), 50), 4);
  await assert.rejects(withTimeout(Promise.reject(new Error('nope')), 50), /nope/);
  await assert.rejects(withTimeout(() => { throw new Error('sync'); }, 50), /sync/);
  const t0 = Date.now();
  await assert.rejects(withTimeout(new Promise(() => {}), 30, 'tabs.group'), (e) => {
    assert.ok(e instanceof TimeoutError);
    assert.match(e.message, /tabs\.group did not settle within 30 ms/);
    return true;
  });
  assert.ok(Date.now() - t0 < 500);
});

test('probeSettles: resolves, hangs (stubbed API), missing API, throwing API', async () => {
  assert.deepEqual(await probeSettles(() => Promise.resolve([]), { ms: 30, label: 'q' }), { usable: true, reason: 'q: resolved' });
  assert.deepEqual(await probeSettles(() => new Promise(() => {}), { ms: 30, label: 'q' }), { usable: false, reason: 'q: hangs' });
  let called = false;
  assert.equal((await probeSettles(() => { called = true; }, { exists: false })).usable, false);
  assert.equal(called, false);
  assert.match((await probeSettles(() => Promise.reject(new Error('x')), { ms: 30, label: 'q' })).reason, /q: x/);
});
