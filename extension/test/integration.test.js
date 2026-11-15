// Live single-pass test. Gated: runs only with TIDY_LIVE=1 (and a reachable server).
// Env: TIDY_OLLAMA_URL (default http://localhost:11434), TIDY_MODEL (default qwen3:1.7b).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, checkSchema, repairGroups } from '../lib/core.js';
import { callOllama } from '../lib/ollama-request.js';
import { liveSkip, endpoint, model, tabs, purity, summarize } from '../test-support/live.js';

const skip = await liveSkip();

test(`live single-pass clustering of 30 tabs via ${model} @ ${endpoint}`, { skip }, async () => {
  const prompt = buildPrompt(tabs);
  const t0 = performance.now();
  const { content, timing } = await callOllama(prompt, { endpoint, model, timeoutMs: 180000 });
  const wallMs = Math.round(performance.now() - t0);
  const strict = checkSchema(content, tabs.length);
  const { groups, stats } = repairGroups(content, prompt.idMap);
  console.log(JSON.stringify({
    wallMs, timing, strictValid: strict.ok, strictErrors: strict.errors, repair: stats,
    purity: purity(groups), groups: summarize(groups),
  }, null, 2));
  assert.equal(groups.flatMap((g) => g.tabIds).length, tabs.length);
  assert.ok(groups.length >= 2);
});
