// Diagnostics log: ~/Library/Logs/tidy-tabs/last-run.json (overwritten) + runs.jsonl (appended,
// rotated to runs.1.jsonl at ~1 MB). Never calls claude.
import { mkdirSync, writeFileSync, renameSync, appendFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const ROTATE_BYTES = 1024 * 1024;
export const MAX_RECORD_BYTES = 2 * 1024 * 1024;

export function logDir(env = process.env) {
  return env.TIDY_LOG_DIR || join(env.HOME || homedir(), 'Library', 'Logs', 'tidy-tabs');
}

/** Defensive scrub: drop any url-ish fields so only titles/hosts are persisted. */
export function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^(url|pendingUrl|favIconUrl)$/i.test(k)) continue;
      out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

/** Write one run record. Returns { ok, path, jsonl, rotated }. Throws on bad input / IO errors. */
export function writeRunLog(record, { dir = logDir(), rotateBytes = ROTATE_BYTES } = {}) {
  if (!record || typeof record !== 'object') throw new Error('log record must be an object');
  const entry = { loggedAt: new Date().toISOString(), ...scrub(record) };
  const pretty = JSON.stringify(entry, null, 2);
  if (pretty.length > MAX_RECORD_BYTES) throw new Error(`log record too large: ${pretty.length} bytes`);
  mkdirSync(dir, { recursive: true });
  const last = join(dir, 'last-run.json');
  const tmp = `${last}.tmp`;
  writeFileSync(tmp, `${pretty}\n`);
  renameSync(tmp, last);
  const jsonl = join(dir, 'runs.jsonl');
  let rotated = false;
  if (existsSync(jsonl) && statSync(jsonl).size >= rotateBytes) {
    renameSync(jsonl, join(dir, 'runs.1.jsonl'));
    rotated = true;
  }
  appendFileSync(jsonl, `${JSON.stringify(entry)}\n`);
  return { ok: true, path: last, jsonl, rotated };
}
