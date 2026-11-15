// Settings stored in chrome.storage.sync.
import { DEFAULT_ENDPOINT, DEFAULT_MODEL } from './ollama-request.js';
import { DEFAULT_CLAUDE_MODEL } from './claude-native.js';

export const DEFAULTS = {
  endpoint: DEFAULT_ENDPOINT,
  model: DEFAULT_MODEL,
  backend: 'claude-haiku', // 'claude-haiku' | 'ollama' | 'gemini-nano'
  claudeModel: DEFAULT_CLAUDE_MODEL, // claude CLI --model (alias or full name)
  strategy: 'auto', // 'auto' (single-pass for Claude, two-pass otherwise) | 'two-pass' | 'single-pass'
  timeoutMs: 120000, // whole run (both passes), not per request
  idEnum: true, // pass 2: constrain ids with an enum in the schema
  createTabGroups: true, // named + colored groups per cluster (Chrome/Dia)
  collapseGroups: false, // collapse the groups after creating them
  notify: true,
  debugLogging: false, // include tab titles/hosts in stored run history and the disk log
};

export async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(patch) {
  await chrome.storage.sync.set(patch);
}
