// Promise timeout helpers. Pure (no chrome.*). Some Chromium forks expose chrome.tabs.group /
// chrome.tabGroups.* but their promises never settle, so every such call goes through withTimeout.

export class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label} did not settle within ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

/** Race `promiseOrFn` (a promise, or a function returning one) against a timer. */
export function withTimeout(promiseOrFn, ms, label = 'call') {
  let timer;
  const p = Promise.resolve().then(() => (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn));
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new TimeoutError(label, ms)), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/**
 * Probe whether an API call actually settles (Chrome/Dia) or hangs (stubbed API). Returns
 * { usable, reason }. `call` returns a promise; `exists` short-circuits when the API is missing.
 */
export async function probeSettles(call, { exists = true, ms = 500, label = 'probe' } = {}) {
  if (!exists) return { usable: false, reason: `${label}: API missing` };
  try {
    await withTimeout(call, ms, label);
    return { usable: true, reason: `${label}: resolved` };
  } catch (e) {
    return { usable: false, reason: e instanceof TimeoutError ? `${label}: hangs` : `${label}: ${e.message}` };
  }
}
