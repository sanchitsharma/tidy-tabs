import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRunLog, scrub, logDir } from '../logfile.js';
import { runHost } from '../test-support/helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'tidy-log-'));

test('logDir defaults to ~/Library/Logs/tidy-tabs, overridable', () => {
  assert.equal(logDir({ HOME: '/Users/x' }), '/Users/x/Library/Logs/tidy-tabs');
  assert.equal(logDir({ HOME: '/Users/x', TIDY_LOG_DIR: '/tmp/l' }), '/tmp/l');
});

test('scrub drops url fields at any depth, keeps titles/hosts', () => {
  const out = scrub({ a: [{ title: 'T', host: 'h.com', url: 'https://h.com/secret', favIconUrl: 'x' }], pendingUrl: 'p' });
  assert.deepEqual(out, { a: [{ title: 'T', host: 'h.com' }] });
});

test('writeRunLog: last-run.json overwritten, runs.jsonl appended', () => {
  const dir = tmp();
  try {
    writeRunLog({ id: 'a', status: 'verified' }, { dir });
    const r = writeRunLog({ id: 'b', status: 'moves-failed', moves: { results: [{ name: 'batch-plan', ignored: 3 }] } }, { dir });
    assert.equal(r.ok, true);
    assert.equal(r.path, join(dir, 'last-run.json'));
    const last = JSON.parse(readFileSync(join(dir, 'last-run.json'), 'utf8'));
    assert.equal(last.id, 'b');
    assert.equal(last.moves.results[0].ignored, 3);
    assert.ok(last.loggedAt);
    const lines = readFileSync(join(dir, 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.id), ['a', 'b']);
    assert.ok(!existsSync(join(dir, 'last-run.json.tmp')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeRunLog rotates runs.jsonl at the size limit', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'runs.jsonl'), 'x'.repeat(200));
    const r = writeRunLog({ id: 'c' }, { dir, rotateBytes: 100 });
    assert.equal(r.rotated, true);
    assert.equal(readFileSync(join(dir, 'runs.1.jsonl'), 'utf8'), 'x'.repeat(200));
    assert.equal(JSON.parse(readFileSync(join(dir, 'runs.jsonl'), 'utf8')).id, 'c');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeRunLog rejects non-objects', () => {
  assert.throws(() => writeRunLog(null, { dir: tmp() }), /must be an object/);
});

test('host handles {type:"log"} without calling claude', async () => {
  const dir = tmp();
  try {
    const { replies } = await runHost([
      { type: 'log', id: 1, record: { id: 'run-1', status: 'moves-failed', groups: [{ label: 'A', tabs: [{ title: 'T', host: 'h', url: 'https://h/x' }] }] } },
      { type: 'log', id: 2 },
    ], { env: { TIDY_LOG_DIR: dir, TIDY_CLAUDE_BIN: '/nonexistent/claude-must-not-run' } });
    const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
    assert.equal(byId[1].ok, true, JSON.stringify(byId[1]));
    assert.equal(byId[1].path, join(dir, 'last-run.json'));
    const last = JSON.parse(readFileSync(join(dir, 'last-run.json'), 'utf8'));
    assert.equal(last.id, 'run-1');
    assert.equal(last.groups[0].tabs[0].url, undefined);
    assert.equal(byId[2].ok, false);
    assert.match(byId[2].error, /log write failed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
