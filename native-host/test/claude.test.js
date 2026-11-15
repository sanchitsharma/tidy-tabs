import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeRequest, buildClaudeArgs, buildEnv, mapClaudeResult } from '../claude.js';
import { extensionIdFromKey } from '../extension-id.js';
import { runHost } from '../test-support/helpers.js';

const schema = { type: 'object', properties: { groups: { type: 'array' } }, required: ['groups'] };

test('normalizeRequest validates and defaults', () => {
  const r = normalizeRequest({ type: 'chat', system: 'S', user: 'U', schema });
  assert.deepEqual(r, { system: 'S', user: 'U', schema, model: 'haiku', timeoutMs: 60000 });
  assert.equal(normalizeRequest({ type: 'chat', system: '', user: 'U', schema, timeoutMs: 999999 }).timeoutMs, 300000);
  assert.throws(() => normalizeRequest({ type: 'nope' }), /chat/);
  assert.throws(() => normalizeRequest({ type: 'chat', system: 'S', user: ' ', schema }), /strings/);
  assert.throws(() => normalizeRequest({ type: 'chat', system: 'S', user: 'U' }), /schema/);
  assert.throws(() => normalizeRequest({ type: 'chat', system: 'S', user: 'U', schema, model: 'haiku; rm -rf /' }), /invalid model/);
  assert.throws(() => normalizeRequest({ type: 'chat', system: 'S', user: 'U', schema, model: '--dangerously-skip-permissions' }), /invalid model/);
  assert.throws(() => normalizeRequest({ type: 'chat', system: 'S', user: 'U', schema, model: '-x' }), /invalid model/);
  assert.equal(normalizeRequest({ type: 'chat', system: 'S', user: 'U', schema, model: 'claude-haiku-5-5' }).model, 'claude-haiku-5-5');
});

test('buildClaudeArgs: one-shot, structured, no tools/MCP/settings/session, never --bare', () => {
  const a = buildClaudeArgs({ model: 'haiku', schema, system: 'SYS' });
  const val = (flag) => a[a.indexOf(flag) + 1];
  assert.equal(a[0], '-p');
  assert.ok(a.includes('--model=haiku'), 'model passed as a single --model=<value> arg');
  assert.equal(val('--output-format'), 'json');
  assert.deepEqual(JSON.parse(val('--json-schema')), schema);
  assert.equal(val('--system-prompt'), 'SYS');
  assert.equal(val('--tools'), '');
  assert.equal(val('--mcp-config'), '{"mcpServers":{}}');
  assert.equal(val('--setting-sources'), '');
  for (const f of ['--strict-mcp-config', '--safe-mode', '--no-session-persistence', '--disable-slash-commands']) assert.ok(a.includes(f), f);
  assert.ok(!a.includes('--bare'), '--bare would require an API key');
});

test('buildEnv drops API keys and other env so the subscription login is used', () => {
  const env = buildEnv({ HOME: '/h', USER: 'u', ANTHROPIC_API_KEY: 'sk-x', CLAUDE_CODE_SIMPLE: '1', CMUX_X: '1', PATH: '/weird' });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_SIMPLE, undefined);
  assert.equal(env.HOME, '/h');
  assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
});

test('mapClaudeResult uses structured_output, reports resolved model, errors when absent', () => {
  const ok = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ignored', structured_output: { groups: [] },
    duration_api_ms: 2000, duration_ms: 2400, num_turns: 2, modelUsage: { 'claude-haiku-5-5': {} } });
  assert.deepEqual(mapClaudeResult(ok, 5000), {
    ok: true, content: '{"groups":[]}', model: 'claude-haiku-5-5',
    timing: { totalMs: 5000, apiMs: 2000, claudeMs: 2400, turns: 2 },
  });
  const missing = JSON.stringify({ subtype: 'success', is_error: false, result: 'free text' });
  assert.throws(() => mapClaudeResult(missing, 1), /no structured_output \(result: free text\)/);
  assert.throws(() => mapClaudeResult(JSON.stringify({ subtype: 'error_max_turns', is_error: true }), 1), /claude error \(error_max_turns\)/);
  assert.throws(() => mapClaudeResult('Not logged in', 1), /not JSON/);
});

test('extension id derivation matches the Chrome algorithm (known vector)', () => {
  // sha256 of empty input starts e3b0c442 98fc1c14 9afbf4c8 996fb924 -> nibbles mapped 0-f -> a-p
  assert.equal(extensionIdFromKey(''), 'odlameecjipmbmbejkplpemijjgpljce');
  assert.equal(extensionIdFromKey('').length, 32);
  assert.match(extensionIdFromKey('AAAA'), /^[a-p]{32}$/);
});

test('installed host manifests (Chrome + Dia) allow exactly the manifest-key extension id; none left in Arc', (t) => {
  const key = JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url))).key;
  const id = extensionIdFromKey(key);
  const file = (d) => join(homedir(), 'Library/Application Support', d, 'NativeMessagingHosts/dev.tidytabs.claude.json');
  const dirs = ['Google/Chrome', 'Dia/User Data'].map(file);
  const present = dirs.filter((f) => existsSync(f));
  if (!present.length) return t.skip('install.sh not run');
  assert.equal(existsSync(file('Arc/User Data')), false, 'our Arc manifest was removed');
  for (const f of present) {
    const m = JSON.parse(readFileSync(f, 'utf8'));
    assert.deepEqual(m.allowed_origins, [`chrome-extension://${id}/`], f);
    assert.equal(m.name, 'dev.tidytabs.claude');
    assert.ok(existsSync(m.path), `host path exists: ${m.path}`);
  }
});

test('host end-to-end with a fake claude: framing, args, cwd isolation, errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tidy-fake-claude-'));
  const fake = join(dir, 'claude');
  // Echo argv, cwd, and stdin back inside a valid structured result.
  writeFileSync(fake, `#!${process.execPath}
const args = process.argv.slice(2); let input = '';
process.stdin.on('data', d => input += d).on('end', () => {
  if (input.includes('FAIL')) { console.log(JSON.stringify({ subtype: 'success', is_error: false, result: 'oops' })); return; }
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_api_ms: 1, duration_ms: 2, num_turns: 1,
    modelUsage: { 'claude-haiku-5-5': {} },
    structured_output: { args, cwd: process.cwd(), input, hasKey: 'ANTHROPIC_API_KEY' in process.env } }));
});`);
  chmodSync(fake, 0o755);
  try {
    const { replies, code } = await runHost([
      { type: 'ping', id: 1 },
      { type: 'chat', id: 2, system: 'SYS', user: 'Tabs:\n0|a.com|A', schema, model: 'haiku' },
      { type: 'chat', id: 3, system: 'SYS', user: 'FAIL', schema },
      { type: 'bogus', id: 4 },
    ], { env: { TIDY_CLAUDE_BIN: fake, ANTHROPIC_API_KEY: 'sk-should-not-leak', PATH: `${process.env.PATH}` } });
    assert.equal(code, 0);
    const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
    assert.equal(byId[1].ok, true);
    assert.equal(byId[1].claudeBin, fake);
    assert.equal(byId[2].ok, true, JSON.stringify(byId[2]));
    assert.equal(byId[2].model, 'claude-haiku-5-5');
    const echoed = JSON.parse(byId[2].content);
    assert.equal(echoed.input, 'Tabs:\n0|a.com|A');
    assert.equal(echoed.hasKey, false);
    assert.match(echoed.cwd, /tidy-tabs-claude-/);
    assert.deepEqual(JSON.parse(echoed.args[echoed.args.indexOf('--json-schema') + 1]), schema);
    assert.equal(byId[3].ok, false);
    assert.match(byId[3].error, /no structured_output/);
    assert.equal(byId[4].ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host reports a missing claude binary', async () => {
  const { replies } = await runHost([{ type: 'chat', id: 1, system: 'S', user: 'U', schema }],
    { env: { TIDY_CLAUDE_BIN: '/nonexistent/claude' } });
  assert.equal(replies[0].ok, false);
  assert.match(replies[0].error, /cannot start claude/);
});
