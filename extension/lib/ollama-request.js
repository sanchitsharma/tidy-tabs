// Ollama request building + response extraction. Pure (no chrome.*); only this file needs
// changing to align with the VM's client-contract.md.
import { GROUPS_SCHEMA } from './core.js';

export const DEFAULT_ENDPOINT = 'http://localhost:11434';
export const DEFAULT_MODEL = 'qwen3:1.7b';
export const NUM_CTX = 8192;

export function chatUrl(endpoint) {
  return `${String(endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '')}/api/chat`;
}

/** Body for POST /api/chat. `prompt` = { system, user }; `format` = JSON schema to constrain output. */
export function buildChatBody(prompt, model = DEFAULT_MODEL, format = GROUPS_SCHEMA) {
  return {
    model,
    stream: false,
    think: false,
    format,
    options: { temperature: 0, num_ctx: NUM_CTX },
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
  };
}

/** Pull the model's JSON text plus timing out of an /api/chat response. */
export function extractChatResult(json) {
  const content = json?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('empty model response');
  const ns = (v) => (typeof v === 'number' ? Math.round(v / 1e6) : undefined);
  return {
    content,
    timing: {
      totalMs: ns(json.total_duration),
      loadMs: ns(json.load_duration),
      promptEvalMs: ns(json.prompt_eval_duration),
      evalCount: json.eval_count,
    },
  };
}

/**
 * One /api/chat call. `timeoutMs` bounds this call; `signal` (optional) is an outer abort, e.g. the
 * whole-run deadline shared by both passes. `fetchImpl` is injectable for node tests.
 */
export async function callOllama(prompt, {
  endpoint, model, format = GROUPS_SCHEMA, timeoutMs, signal, fetchImpl = fetch,
} = {}) {
  const signals = [];
  if (signal) signals.push(signal);
  if (timeoutMs) signals.push(AbortSignal.timeout(timeoutMs));
  const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  try {
    const res = await fetchImpl(chatUrl(endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildChatBody(prompt, model || DEFAULT_MODEL, format)),
      signal: combined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return extractChatResult(await res.json());
  } catch (e) {
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
      throw new Error(`Ollama timed out${timeoutMs ? ` after ${timeoutMs} ms` : ''}`);
    }
    throw e;
  }
}

/** Adapter: a `chat(prompt, schema)` function bound to settings + a shared run signal. */
export function ollamaChat({ endpoint, model, signal, fetchImpl }) {
  return (prompt, format) => callOllama(prompt, { endpoint, model, format, signal, fetchImpl });
}
