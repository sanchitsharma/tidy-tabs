// Backends: Claude (native messaging -> local Claude Code CLI), Ollama, built-in LanguageModel
// (Gemini Nano). One deadline (settings.timeoutMs) covers the whole run: every pass shares it.
import { ollamaChat } from './ollama-request.js';
import { claudeChat } from './claude-native.js';
import { clusterTabs } from './strategies.js';
import { normalizeInstructions, normalizeLimits } from './core.js';

export const BACKENDS = ['claude-haiku', 'ollama', 'gemini-nano'];
export const DEFAULT_BACKEND = 'claude-haiku';

/** 'auto' strategy: one call for Claude (fast, smart), two passes for small local models. */
export function resolveStrategy(strategy, backend) {
  if (strategy === 'single-pass' || strategy === 'two-pass') return strategy;
  return backend === 'claude-haiku' ? 'single-pass' : 'two-pass';
}

function languageModelApi() {
  return typeof globalThis.LanguageModel !== 'undefined' ? globalThis.LanguageModel : null;
}

export async function nanoAvailable() {
  const LM = languageModelApi();
  if (!LM || typeof LM.availability !== 'function') return false;
  try {
    return (await LM.availability()) === 'available';
  } catch {
    return false;
  }
}

function nanoChat(signal) {
  return async (prompt, schema) => {
    const LM = languageModelApi();
    const t0 = Date.now();
    const session = await LM.create({
      initialPrompts: [{ role: 'system', content: prompt.system }],
      temperature: 0,
      topK: 1,
      signal,
    });
    try {
      const content = await session.prompt(prompt.user, { responseConstraint: schema, signal });
      return { content, timing: { totalMs: Date.now() - t0 } };
    } finally {
      session.destroy?.();
    }
  };
}

/** chrome.runtime.sendNativeMessage as a promise, with lastError surfaced. */
export function chromeNativeSend(host, msg) {
  return new Promise((resolve, reject) => {
    if (!globalThis.chrome?.runtime?.sendNativeMessage) {
      reject(new Error('native messaging unavailable (missing nativeMessaging permission?)'));
      return;
    }
    chrome.runtime.sendNativeMessage(host, msg, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(`native messaging: ${err.message}`));
      else resolve(resp);
    });
  });
}

/**
 * Cluster `tabs` (unpinned, in tab order). Never throws for backend failures: falls back to domain
 * grouping. `deps` lets tests inject fetchImpl / nativeSend. Returns clusterTabs' result plus
 * { backend, strategy }.
 */
export async function runCluster(tabs, settings, deps = {}) {
  const backendName = BACKENDS.includes(settings.backend) ? settings.backend : DEFAULT_BACKEND;
  const strategy = resolveStrategy(settings.strategy, backendName);
  const timeoutMs = settings.timeoutMs || 120000;
  const signal = AbortSignal.timeout(timeoutMs);
  const deadline = Date.now() + timeoutMs;
  let chat;
  let label;
  if (backendName === 'claude-haiku') {
    chat = claudeChat({ model: settings.claudeModel, signal, deadline, send: deps.nativeSend || chromeNativeSend });
    label = `claude:${settings.claudeModel || 'haiku'}`;
  } else if (backendName === 'gemini-nano') {
    chat = (await nanoAvailable())
      ? nanoChat(signal)
      : async () => {
          throw new Error('LanguageModel API unavailable');
        };
    label = 'gemini-nano';
  } else {
    chat = ollamaChat({ endpoint: settings.endpoint, model: settings.model, signal, fetchImpl: deps.fetchImpl });
    label = `ollama:${settings.model}`;
  }
  const exchanges = [];
  const recorded = async (prompt, schema) => {
    const ex = { system: prompt.system, user: prompt.user };
    exchanges.push(ex);
    try {
      const r = await chat(prompt, schema);
      ex.response = String(r.content).slice(0, 20000);
      return r;
    } catch (e) {
      ex.error = String(e?.message || e);
      throw e;
    }
  };
  const instructions = normalizeInstructions(settings.groupingInstructions);
  const res = await clusterTabs(tabs, {
    chat: recorded,
    strategy,
    idEnum: settings.idEnum !== false,
    instructions,
    limits: normalizeLimits(settings),
  });
  return {
    ...res,
    exchanges,
    backend: res.fallback ? 'domain-fallback' : label,
    attemptedBackend: label,
    strategy,
    customInstructions: !!instructions,
  };
}
