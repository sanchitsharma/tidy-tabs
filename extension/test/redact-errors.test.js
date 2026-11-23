// Regression (privacy policy): without Debug logging, stored run records must not keep model-reply
// text inside error messages, because a failed reply can quote tab titles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactRecord } from '../lib/diagnostics.js';

const SECRET = 'Quarterly salary review - Confidential';
const failures = [
  `claude host: claude output is not JSON: Sure! Your tabs: "${SECRET}" and more (exit 1; stderr text)`,
  `claude host: claude returned no structured_output (result: I grouped "${SECRET}" under Work)`,
  `claude host: claude error (error_during_execution): cannot group "${SECRET}"`,
  `Ollama HTTP 500: {"error":"failed on ${SECRET}"}`,
];

function failedRun(message) {
  return {
    status: 'backend-failed',
    summary: `Backend failed (${message}); grouped by domain.`,
    error: message,
    errors: [{ where: 'backend', message }],
    backend: { attempted: 'claude-haiku', fallbackReason: message },
    groups: [],
  };
}

for (const message of failures) {
  test(`redactRecord drops model-reply text from errors: ${message.slice(0, 40)}…`, () => {
    const out = JSON.stringify(redactRecord(failedRun(message), { debugLogging: false }));
    assert.ok(!out.includes(SECRET), `reply text leaked: ${out}`);
    assert.match(out, /reply omitted/);
  });
}

test('redactRecord keeps which failure happened and the exit code', () => {
  const out = redactRecord(failedRun(failures[0]), { debugLogging: false });
  assert.match(out.errors[0].message, /claude output is not JSON/);
  assert.match(out.errors[0].message, /exit 1/);
});

test('Debug logging keeps the full error text', () => {
  const out = JSON.stringify(redactRecord(failedRun(failures[0]), { debugLogging: true }));
  assert.ok(out.includes(SECRET));
});

test('errors without reply text are left alone', () => {
  const msg = 'claude timed out after 60000 ms';
  const out = redactRecord(failedRun(msg), { debugLogging: false });
  assert.equal(out.errors[0].message, msg);
  assert.equal(out.backend.fallbackReason, msg);
});
