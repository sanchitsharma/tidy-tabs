// install.sh / uninstall.sh in throwaway HOMEs: success, failure exits, the one-line download mode, a
// cut-off download, uninstall; plus the values that must stay in sync across extension and helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionIdFromKey } from '../native-host/extension-id.js';
import { MODEL_RE } from '../native-host/claude.js';
import { CLAUDE_MODEL_RE } from '../extension/lib/claude-native.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = join(ROOT, 'install.sh');
const UNINSTALL = join(ROOT, 'uninstall.sh');
const STORE_ID = /STORE_EXTENSION_ID="([^"]*)"/.exec(readFileSync(INSTALL, 'utf8'))[1];
const HOST = 'dev.tidytabs.claude.json';

function home({ browsers = ['google-chrome'] } = {}) {
  const h = mkdtempSync(join(tmpdir(), 'tidy-installer-'));
  for (const b of browsers) mkdirSync(join(h, '.config', b), { recursive: true });
  const fake = join(h, 'claude');
  writeFileSync(fake, '#!/bin/bash\necho fake\n');
  chmodSync(fake, 0o755);
  return { h, fake };
}
const envFor = (h, extra = {}) => ({
  ...process.env,
  HOME: h,
  XDG_CONFIG_HOME: '',
  XDG_DATA_HOME: '',
  XDG_STATE_HOME: '',
  ...extra,
});
const run = (cmd, args, h, opts = {}) =>
  spawnSync(cmd, args, { env: envFor(h, opts.env), input: opts.input, cwd: opts.cwd || ROOT, encoding: 'utf8' });
const manifestIn = (h, browser = 'google-chrome') => join(h, '.config', browser, 'NativeMessagingHosts', HOST);

test('store ID in install.sh matches the ID from extension/manifest.json key', () => {
  const { key } = JSON.parse(readFileSync(join(ROOT, 'extension/manifest.json'), 'utf8'));
  assert.equal(extensionIdFromKey(key), STORE_ID);
});

test('extension and helper validate Claude model IDs with the same rule', () => {
  assert.equal(CLAUDE_MODEL_RE.source, MODEL_RE.source);
});

test(
  'checkout install: registers every found browser, allows only valid deduped IDs, exits 0',
  { skip: process.platform !== 'linux' && 'browser dirs below are Linux paths' },
  () => {
    const { h, fake } = home({ browsers: ['google-chrome', 'chromium'] });
    const r = run(
      INSTALL,
      ['--claude', fake, '--node', process.execPath, '--extension-id', 'not-an-id', '--extension-id', STORE_ID],
      h,
    );
    assert.equal(r.status, 0, r.stderr);
    for (const b of ['google-chrome', 'chromium']) {
      const m = JSON.parse(readFileSync(manifestIn(h, b), 'utf8'));
      assert.deepEqual(m.allowed_origins, [`chrome-extension://${STORE_ID}/`]);
      assert.ok(existsSync(m.path));
    }
    assert.match(r.stderr, /ignoring invalid extension id: not-an-id/);
  },
);

test('no supported browser profile: exits 1 with a clear message', { skip: process.platform !== 'linux' }, () => {
  const { h, fake } = home({ browsers: [] });
  const r = run(INSTALL, ['--claude', fake, '--node', process.execPath], h);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No supported browser profile found/);
});

test('Node older than 18 is refused', () => {
  const { h, fake } = home();
  const oldNode = join(h, 'node');
  writeFileSync(oldNode, '#!/bin/bash\necho 16\n');
  chmodSync(oldNode, 0o755);
  const r = run(INSTALL, ['--claude', fake, '--node', oldNode], h);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Node 16 is too old/);
});

test('missing Claude Code CLI is reported', () => {
  const { h } = home();
  const r = run(INSTALL, ['--claude', join(h, 'nope'), '--node', process.execPath], h);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Claude Code CLI \('claude'\) not found/);
});

/** A local "release": native-host.tar.gz as scripts/package.mjs builds it. */
function fakeRelease() {
  const dir = mkdtempSync(join(tmpdir(), 'tidy-release-'));
  const files = ['host.js', 'claude.js', 'framing.js', 'logfile.js', 'package.json', 'extension-id.js'];
  execFileSync('tar', ['-czf', join(dir, 'native-host.tar.gz'), '-C', ROOT, ...files.map((f) => `native-host/${f}`)]);
  return dir;
}

test(
  'one-line mode (curl | bash, no checkout): downloads the helper and allows the store ID',
  {
    skip: process.platform !== 'linux',
  },
  () => {
    const { h, fake } = home();
    const rel = fakeRelease();
    const r = run('bash', ['-s', '--', '--claude', fake, '--node', process.execPath], h, {
      input: readFileSync(INSTALL, 'utf8'),
      cwd: tmpdir(),
      env: { TIDY_RELEASE_BASE: `file://${rel}` },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Downloading the helper/);
    const m = JSON.parse(readFileSync(manifestIn(h), 'utf8'));
    assert.deepEqual(m.allowed_origins, [`chrome-extension://${STORE_ID}/`]);
    assert.deepEqual(readdirSync(dirname(m.path)).sort(), [
      'claude.js',
      'framing.js',
      'host.js',
      'logfile.js',
      'package.json',
      'tidy-tabs-host',
    ]);
  },
);

test('a cut-off download runs nothing (script body is inside main)', () => {
  const { h, fake } = home();
  const script = readFileSync(INSTALL, 'utf8');
  const r = run('bash', ['-s', '--', '--claude', fake, '--node', process.execPath], h, {
    input: script.slice(0, Math.floor(script.length * 0.6)),
    cwd: tmpdir(),
  });
  assert.notEqual(r.status, 0);
  assert.equal(existsSync(join(h, '.local')), false, 'no helper files written');
  assert.equal(existsSync(manifestIn(h)), false, 'no browser registration');
});

test('uninstall removes the registration and helper, keeps logs', { skip: process.platform !== 'linux' }, () => {
  const { h, fake } = home();
  assert.equal(run(INSTALL, ['--claude', fake, '--node', process.execPath], h).status, 0);
  mkdirSync(join(h, '.local/state/tidy-tabs'), { recursive: true });
  writeFileSync(join(h, '.local/state/tidy-tabs/last-run.json'), '{}');
  const r = run(UNINSTALL, [], h);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(manifestIn(h)), false);
  assert.equal(existsSync(join(h, '.local/share/tidy-tabs')), false);
  assert.ok(existsSync(join(h, '.local/state/tidy-tabs/last-run.json')), 'logs kept');
});
