import '../test-support/no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unwrapSuspendedUrl, effectiveTab, skippedKind } from '../lib/suspended.js';
import { isInternalTab } from '../lib/core.js';
import { runCluster } from '../lib/backends.js';
import { redactRecord } from '../lib/diagnostics.js';

// Regression: a tester with Tab Suspender had 18 of 22 tabs skipped as "internal" pages.
test('suspended tabs: real URL recovered from query or hash; real internal pages stay internal', () => {
  const q =
    'chrome-extension://fiabciakcmgepblmdkmemdbbkilneeeh/park.html?title=Inbox&url=https%3A%2F%2Fmail.google.com%2Fmail%2Fu%2F0';
  const h =
    'chrome-extension://noogafoofpebimajpfpamcfhoaifemoa/suspended.html#ttl=Docs&pos=0&uri=https://developer.mozilla.org/en-US/docs/Web';
  assert.equal(unwrapSuspendedUrl(q), 'https://mail.google.com/mail/u/0');
  assert.equal(unwrapSuspendedUrl(h), 'https://developer.mozilla.org/en-US/docs/Web');
  assert.equal(unwrapSuspendedUrl('chrome-extension://abc/options.html'), null);
  assert.equal(unwrapSuspendedUrl('chrome-extension://abc/x.html?url=javascript:alert(1)'), null);
  assert.equal(unwrapSuspendedUrl('https://example.com/?url=https://a.com'), null);

  const t = effectiveTab({ id: 7, index: 3, url: q, title: 'Inbox (3) - Gmail' });
  assert.equal(t.id, 7);
  assert.equal(t.url, 'https://mail.google.com/mail/u/0');
  assert.equal(t.title, 'Inbox (3) - Gmail');
  assert.equal(t.suspended, true);
  assert.equal(isInternalTab(t), false);
  assert.equal(effectiveTab({ id: 8, url: q, title: '' }).title, 'Inbox');

  const settings = { id: 9, url: 'chrome://settings/' };
  assert.equal(effectiveTab(settings), settings);
  assert.equal(isInternalTab(effectiveTab(settings)), true);
  assert.equal(skippedKind(settings), 'chrome://settings');
  assert.equal(skippedKind({ url: 'chrome-extension://abc/options.html?x=1' }), 'chrome-extension://abc');
});

test('runCluster records the exact prompt and raw answer; redactRecord hides them unless debug', async () => {
  const tabs = [
    { id: 1, url: 'https://a.com/1', title: 'Alpha one' },
    { id: 2, url: 'https://a.com/2', title: 'Alpha two' },
  ];
  const answer = JSON.stringify({ groups: [{ label: 'Alpha', tabIds: [0, 1] }], ungrouped: [] });
  const nativeSend = async () => ({ ok: true, content: answer, model: 'claude-haiku-5-5', timing: {} });
  const res = await runCluster(
    tabs,
    { backend: 'claude-haiku', strategy: 'single-pass', timeoutMs: 5000 },
    { nativeSend },
  );
  assert.equal(res.exchanges.length, 1);
  assert.match(res.exchanges[0].user, /Alpha one/);
  assert.ok(res.exchanges[0].system);
  assert.equal(res.exchanges[0].response, answer);

  const failing = await runCluster(
    tabs,
    { backend: 'claude-haiku', strategy: 'single-pass', timeoutMs: 5000 },
    { nativeSend: async () => ({ ok: false, error: 'boom' }) },
  );
  assert.match(failing.exchanges[0].error, /boom/);

  const rec = { llm: res.exchanges, groups: [] };
  assert.equal(typeof redactRecord(rec).llm, 'string');
  assert.doesNotMatch(JSON.stringify(redactRecord(rec)), /Alpha one/);
  assert.equal(redactRecord(rec, { debugLogging: true }).llm, res.exchanges);
});

test('runTidy: suspended tabs reach the model and get grouped; settings page is skipped and reported', async () => {
  const sus = (id, title, url) => ({
    id,
    title,
    url: `chrome-extension://fiabciakcmgepblmdkmemdbbkilneeeh/park.html?title=${encodeURIComponent(title)}&url=${encodeURIComponent(url)}`,
  });
  const { fakeTabs } = await import('../test-support/fake-tabs.js');
  const ft = fakeTabs([
    sus(1, 'Bread recipe', 'https://en.wikipedia.org/wiki/Bread'),
    { id: 2, title: 'Settings', url: 'chrome://settings/' },
    sus(3, 'Sourdough', 'https://en.wikipedia.org/wiki/Sourdough'),
    { id: 4, title: 'Array.map - MDN', url: 'https://developer.mozilla.org/map' },
    sus(5, 'Array.filter - MDN', 'https://developer.mozilla.org/filter'),
  ]);
  let sentUser = '';
  globalThis.navigator ??= {};
  globalThis.chrome = {
    runtime: {
      id: 'test',
      getManifest: () => ({ version: '0.0.0' }),
      lastError: null,
      sendNativeMessage: (host, msg, cb) => {
        sentUser = msg.user;
        const ids = [...msg.user.matchAll(/^(\d+)\b/gm)].map((m) => Number(m[1]));
        cb({
          ok: true,
          model: 'm',
          timing: {},
          content: JSON.stringify({
            groups: [
              { label: 'Bread', tabIds: ids.slice(0, 2) },
              { label: 'JS', tabIds: ids.slice(2) },
            ],
            ungrouped: [],
          }),
        });
      },
    },
    windows: { getLastFocused: async () => ({ id: 1 }), getAll: async () => [{ id: 1 }] },
    tabs: { query: () => ft.query(), move: ft.move, get: ft.get, onMoved: ft.onMoved },
  };
  const { runTidy } = await import('../lib/tidy-run.js');
  const rec = await runTidy({
    windowId: 1,
    settings: { backend: 'claude-haiku', strategy: 'single-pass', timeoutMs: 5000, createTabGroups: false },
    trigger: 'test',
  });
  assert.equal(rec.counts.internal, 1);
  assert.equal(rec.counts.suspended, 3);
  assert.deepEqual(rec.skipped, { 'chrome://settings': 1 });
  assert.match(sentUser, /Sourdough/);
  assert.match(sentUser, /wikipedia/);
  assert.equal(rec.llm.length, 1);
  assert.deepEqual(
    rec.groups.map((g) => g.tabs.length),
    [2, 2],
  );
  assert.equal(ft.order().at(-1), 2, 'settings page ends up last');
});
