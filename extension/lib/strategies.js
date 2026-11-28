// Clustering strategies on top of an injected `chat(prompt, schema) -> {content, timing}`.
// Pure: no chrome.*, no fetch. Backends (Ollama, Gemini Nano) supply `chat`.
import { GROUPS_SCHEMA, buildPrompt, checkSchema, repairGroups, groupByDomain, normalizeLimits } from './core.js';
import {
  labelsSchema,
  assignSchema,
  buildLabelsPrompt,
  buildAssignPrompt,
  normalizeLabels,
  assignmentsToGroups,
} from './two-pass.js';

export const STRATEGIES = ['two-pass', 'single-pass'];
export const DEFAULT_STRATEGY = 'two-pass';

export async function singlePass(tabs, chat, { instructions = '', limits } = {}) {
  const { maxGroups } = normalizeLimits(limits);
  const prompt = buildPrompt(tabs, undefined, instructions, limits);
  const r = await chat(prompt, GROUPS_SCHEMA);
  const check = checkSchema(r.content, tabs.length, maxGroups);
  const { groups, stats } = repairGroups(r.content, prompt.idMap, maxGroups);
  return { groups, stats, strictErrors: check.errors, timings: [r.timing] };
}

export async function twoPass(tabs, chat, { idEnum = true, instructions = '', limits } = {}) {
  const { maxGroups } = normalizeLimits(limits);
  const p1 = buildLabelsPrompt(tabs, undefined, instructions, limits);
  let r1;
  try {
    r1 = await chat(p1, labelsSchema(maxGroups));
  } catch (e) {
    throw new Error(`pass 1 (labels) failed: ${e.message}`, { cause: e });
  }
  const labels = normalizeLabels(r1.content, maxGroups);
  const p2 = buildAssignPrompt(p1.lines, labels, instructions, limits);
  let r2;
  try {
    r2 = await chat(p2, assignSchema(labels, tabs.length, { idEnum }));
  } catch (e) {
    throw new Error(`pass 2 (assign) failed: ${e.message}`, { cause: e });
  }
  const { groups, stats } = assignmentsToGroups(r2.content, labels, p1.idMap, maxGroups);
  return { groups, stats, labels, strictErrors: [], timings: [r1.timing, r2.timing] };
}

/**
 * Cluster tabs with the chosen strategy; on any error or an unusable result, fall back to domain
 * grouping. Returns { groups, fallback, fallbackReason?, stats?, labels?, strictErrors?, timings? }.
 */
export async function clusterTabs(
  tabs,
  { chat, strategy = DEFAULT_STRATEGY, idEnum = true, instructions = '', limits },
) {
  try {
    const run = strategy === 'single-pass' ? singlePass : twoPass;
    const result = await run(tabs, chat, { idEnum, instructions, limits });
    if (!result.groups.length) {
      throw new Error('model returned no usable groups');
    }
    return { ...result, fallback: false };
  } catch (e) {
    return {
      groups: groupByDomain(tabs, normalizeLimits(limits).maxGroups),
      fallback: true,
      fallbackReason: String(e?.message || e),
    };
  }
}
