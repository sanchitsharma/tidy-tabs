// Claude backend via Chrome native messaging -> local Claude Code CLI (user's subscription, no API key).
// Pure: the `send` function (chrome.runtime.sendNativeMessage) is injected.

export const NATIVE_HOST = 'dev.tidytabs.claude';
export const DEFAULT_CLAUDE_MODEL = 'haiku';
/** Claude model aliases offered in Options; any other model id the Claude Code CLI accepts also works. */
export const CLAUDE_MODEL_ALIASES = ['haiku', 'sonnet', 'opus'];
/** Same rule the native host enforces (must not start with '-'). */
export const CLAUDE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;
/** One-line helper installer (macOS and Linux) and the setup guide. */
export const HELPER_INSTALL_CMD =
  'curl -fsSL https://github.com/sanchitsharma/tidy-tabs/releases/latest/download/install.sh | bash';
export const SETUP_URL = 'https://sanchitsharma.github.io/tidy-tabs/setup.html';

/** True when an error means the Claude helper isn't installed/registered for this browser + extension. */
export function isHelperMissing(message) {
  return /native messaging host not found|access to the specified native messaging host is forbidden/i.test(
    String(message || ''),
  );
}

/** Request message for the native host. `timeoutMs` = time left in the run, enforced host-side too. */
export function buildNativeRequest(prompt, schema, { model = DEFAULT_CLAUDE_MODEL, timeoutMs } = {}) {
  return {
    type: 'chat',
    model: model || DEFAULT_CLAUDE_MODEL,
    system: prompt.system,
    user: prompt.user,
    schema,
    ...(timeoutMs ? { timeoutMs: Math.max(1000, Math.round(timeoutMs)) } : {}),
  };
}

/** Host response -> { content, timing } (the chat() contract), or throw. */
export function parseNativeResponse(resp) {
  if (!resp) throw new Error('native host returned nothing (is the Tidy Tabs AI helper installed?)');
  if (!resp.ok) throw new Error(`claude host: ${resp.error || 'unknown error'}`);
  if (typeof resp.content !== 'string' || !resp.content.trim()) throw new Error('claude host: empty content');
  return { content: resp.content, timing: { ...(resp.timing || {}), model: resp.model } };
}

function abortError(signal) {
  const r = signal?.reason;
  return r?.name === 'TimeoutError' ? new Error('claude timed out (run deadline)') : new Error('claude call aborted');
}

/**
 * chat(prompt, schema) bound to a run. `send(host, msg) -> Promise<resp>`; `signal` = run deadline;
 * `deadline` = epoch ms when the run expires (used to tell the host how long it may take).
 */
export function claudeChat({ model, signal, deadline, send }) {
  return async (prompt, schema) => {
    if (signal?.aborted) throw abortError(signal);
    const timeoutMs = deadline ? deadline - Date.now() : undefined;
    if (timeoutMs !== undefined && timeoutMs <= 0) throw new Error('claude timed out (run deadline)');
    const msg = buildNativeRequest(prompt, schema, { model, timeoutMs });
    const call = Promise.resolve().then(() => send(NATIVE_HOST, msg));
    if (!signal) return parseNativeResponse(await call);
    let onAbort;
    const aborted = new Promise((_, rej) => {
      onAbort = () => rej(abortError(signal));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return parseNativeResponse(await Promise.race([call, aborted]));
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };
}
