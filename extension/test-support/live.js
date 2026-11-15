// Shared gate for live tests. Nothing here touches the network unless TIDY_LIVE=1.
import { readFileSync } from 'node:fs';
import { DEFAULT_ENDPOINT, DEFAULT_MODEL } from '../lib/ollama-request.js';

export const LIVE = process.env.TIDY_LIVE === '1';
export const endpoint = process.env.TIDY_OLLAMA_URL || DEFAULT_ENDPOINT;
export const model = process.env.TIDY_MODEL || DEFAULT_MODEL;
export const tabs = JSON.parse(readFileSync(new URL('../test/fixtures/tabs-30.json', import.meta.url)));

/** Skip reason, or false if live tests should run. Only probes the server when TIDY_LIVE=1. */
export async function liveSkip() {
  if (!LIVE) return 'live test: set TIDY_LIVE=1 to run (hits the Ollama server)';
  try {
    const res = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(5000) });
    return res.ok ? false : `server answered HTTP ${res.status}`;
  } catch {
    return `server not reachable at ${endpoint}`;
  }
}

/** Share of tabs whose group's majority fixture topic equals their own. */
export function purity(groups) {
  const topicOf = new Map(tabs.map((t) => [t.id, t.topic]));
  let pure = 0;
  for (const g of groups) {
    const counts = {};
    for (const id of g.tabIds) counts[topicOf.get(id)] = (counts[topicOf.get(id)] || 0) + 1;
    pure += Math.max(...Object.values(counts));
  }
  return +(pure / tabs.length).toFixed(2);
}

export function summarize(groups) {
  const topicOf = new Map(tabs.map((t) => [t.id, t.topic]));
  return groups.map((g) => ({ label: g.label, n: g.tabIds.length, topics: [...new Set(g.tabIds.map((id) => topicOf.get(id)))] }));
}
