// Live two-pass test. Gated: runs only with TIDY_LIVE=1 (and a reachable server).
// Env: TIDY_OLLAMA_URL, TIDY_MODEL, TIDY_ID_ENUM=0 to drop the id enum from the pass-2 schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { twoPass } from '../lib/strategies.js';
import { ollamaChat } from '../lib/ollama-request.js';
import { liveSkip, endpoint, model, tabs, purity, summarize } from '../test-support/live.js';

const skip = await liveSkip();

test(`live two-pass clustering of 30 tabs via ${model} @ ${endpoint}`, { skip }, async () => {
  const chat = ollamaChat({ endpoint, model, signal: AbortSignal.timeout(300000) });
  const t0 = performance.now();
  const res = await twoPass(tabs, chat, { idEnum: process.env.TIDY_ID_ENUM !== '0' });
  const wallMs = Math.round(performance.now() - t0);
  console.log(JSON.stringify({
    wallMs, timings: res.timings, labels: res.labels, repair: res.stats,
    purity: purity(res.groups), groups: summarize(res.groups),
  }, null, 2));
  const ids = res.groups.flatMap((g) => g.tabIds);
  assert.equal(ids.length, tabs.length);
  assert.equal(new Set(ids).size, tabs.length);
  assert.ok(res.groups.length >= 2);
});
