// Regression: the helper runs claude with a minimal PATH. An npm-installed Claude Code is a
// `#!/usr/bin/env node` script, so node must be findable; and a claude that dies before reading
// its stdin must produce an error reply, not crash the helper with an unhandled EPIPE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHost, HOST } from '../test-support/helpers.js';

const schema = { type: 'object', properties: { groups: { type: 'array' } }, required: ['groups'] };
const chat = (user) => ({ type: 'chat', id: 1, model: 'haiku', system: 'sys', user, schema });

function fakeClaude(source) {
  const dir = mkdtempSync(join(tmpdir(), 'tidy-fake-claude-'));
  const bin = join(dir, 'claude');
  writeFileSync(bin, source);
  chmodSync(bin, 0o755);
  return bin;
}

// Launch the helper the way the browser does: no PATH from the caller, only HOME and the claude path.
const launch = (claudeBin, messages) =>
  runHost(messages, {
    cmd: process.execPath,
    args: [HOST],
    cleanEnv: true,
    env: { HOME: process.env.HOME, TIDY_CLAUDE_BIN: claudeBin, TIDY_LOG_DIR: mkdtempSync(join(tmpdir(), 'tl-')) },
    timeoutMs: 30000,
  });

test(
  'npm-style claude (#!/usr/bin/env node) runs even when node is not in /usr/bin',
  { skip: existsSync('/usr/bin/node') && 'node is in /usr/bin here, so the PATH problem cannot reproduce' },
  async () => {
    const bin = fakeClaude(`#!/usr/bin/env node
let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '',
    structured_output: { groups: [], ungrouped: [0] }, modelUsage: { 'fake-haiku': {} } }));
});
`);
    const r = await launch(bin, [chat('0|a.com|A tab')]);
    assert.equal(r.replies.length, 1, `helper replied (exit ${r.code}; stderr: ${r.stderr.slice(0, 300)})`);
    assert.equal(r.replies[0].ok, true, `reply: ${JSON.stringify(r.replies[0])}`);
    assert.equal(r.code, 0);
  },
);

test('claude that exits before reading stdin gives an error reply, and the helper does not crash', async () => {
  const bin = fakeClaude('#!/bin/sh\necho "boom" >&2\nexit 3\n');
  // A prompt larger than the pipe buffer guarantees the write hits a closed pipe (EPIPE).
  const r = await launch(bin, [chat(`0|a.com|${'x'.repeat(512 * 1024)}`)]);
  assert.equal(r.replies.length, 1, `helper replied (exit ${r.code}; stderr: ${r.stderr.slice(0, 300)})`);
  assert.equal(r.replies[0].ok, false);
  assert.match(r.replies[0].error, /exit 3/);
  assert.equal(r.code, 0, 'helper exits normally');
});
