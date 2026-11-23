// "Save run logs to a file" needs the Claude helper: off by default for store installs (they have an
// update_url), on for unpacked development copies.
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function defaultsWithManifest(manifest) {
  const saved = globalThis.chrome;
  globalThis.chrome = { runtime: { getManifest: () => manifest } };
  try {
    // A fresh module instance per case, so DEFAULTS is computed with this manifest.
    const mod = await import(`../lib/settings.js?case=${encodeURIComponent(JSON.stringify(manifest))}`);
    return mod.DEFAULTS;
  } finally {
    globalThis.chrome = saved;
  }
}

test('store install (has update_url): saveLogFile defaults to off', async () => {
  const d = await defaultsWithManifest({
    version: '0.3.0',
    update_url: 'https://clients2.google.com/service/update2/crx',
  });
  assert.equal(d.saveLogFile, false);
});

test('unpacked copy (no update_url): saveLogFile defaults to on', async () => {
  const d = await defaultsWithManifest({ version: '0.3.0' });
  assert.equal(d.saveLogFile, true);
});
