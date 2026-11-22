// Map extension requests to `claude -p` invocations and claude's JSON result back to responses.
// Pure except runClaude (spawn).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_MODEL = 'haiku';
export const DEFAULT_TIMEOUT_MS = 60000;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/; // must not start with '-'

/** Validate an inbound chat request. Returns a normalized request or throws. */
export function normalizeRequest(msg) {
  if (!msg || msg.type !== 'chat') throw new Error('expected {type:"chat"}');
  const { system, user, schema } = msg;
  if (typeof system !== 'string' || typeof user !== 'string' || !user.trim()) throw new Error('system/user must be strings');
  if (!schema || typeof schema !== 'object') throw new Error('schema must be an object');
  const model = msg.model == null || msg.model === '' ? DEFAULT_MODEL : String(msg.model);
  if (!MODEL_RE.test(model)) throw new Error(`invalid model name: ${model}`);
  const t = Number(msg.timeoutMs);
  const timeoutMs = Number.isFinite(t) && t > 0 ? Math.min(t, 300000) : DEFAULT_TIMEOUT_MS;
  return { system, user, schema, model, timeoutMs };
}

/** argv for claude: one-shot, structured output, no tools/MCP/hooks/settings/session, own system prompt. */
export function buildClaudeArgs(req) {
  return [
    '-p',
    `--model=${req.model}`,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(req.schema),
    '--system-prompt', req.system,
    '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '',
    '--safe-mode',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--no-chrome',
  ];
}

/** Minimal env: no API key (forces the logged-in subscription), no project/cmux leakage. */
export function buildEnv(base = process.env) {
  const env = { HOME: base.HOME, USER: base.USER, LOGNAME: base.LOGNAME, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: base.LANG || 'en_US.UTF-8' };
  if (base.TMPDIR) env.TMPDIR = base.TMPDIR;
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

/** claude --output-format json result -> host response. */
export function mapClaudeResult(stdout, wallMs) {
  let r;
  try {
    r = JSON.parse(stdout);
  } catch {
    throw new Error(`claude output is not JSON: ${String(stdout).slice(0, 200)}`);
  }
  if (r.is_error || r.subtype !== 'success') {
    throw new Error(`claude error (${r.subtype || 'unknown'}): ${String(r.result || r.api_error_status || '').slice(0, 300)}`);
  }
  // With --json-schema the validated object is in structured_output; it is absent on failure.
  if (r.structured_output === undefined || r.structured_output === null) {
    throw new Error(`claude returned no structured_output (result: ${String(r.result ?? '').slice(0, 200)})`);
  }
  const content = JSON.stringify(r.structured_output);
  return {
    ok: true,
    content,
    model: Object.keys(r.modelUsage || {})[0],
    timing: { totalMs: wallMs, apiMs: r.duration_api_ms, claudeMs: r.duration_ms, turns: r.num_turns },
  };
}

/** Spawn claude in an empty temp dir; resolves to the mapped response. */
export function runClaude(req, { claudeBin, env = buildEnv() }) {
  const cwd = mkdtempSync(join(tmpdir(), 'tidy-tabs-claude-'));
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin, buildClaudeArgs(req), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, req.timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const done = (fn) => { clearTimeout(timer); rmSync(cwd, { recursive: true, force: true }); fn(); };
    child.on('error', (e) => done(() => reject(new Error(`cannot start claude at ${claudeBin}: ${e.message}`))));
    child.on('close', (code, signal) => done(() => {
      const wall = Date.now() - t0;
      if (signal === 'SIGKILL') return reject(new Error(`claude timed out after ${req.timeoutMs} ms`));
      try {
        resolve(mapClaudeResult(out, wall));
      } catch (e) {
        reject(new Error(`${e.message}${code ? ` (exit ${code}; ${err.trim().slice(0, 200)})` : ''}`));
      }
    }));
    child.stdin.end(req.user);
  });
}
