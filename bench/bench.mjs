// Head-to-head: VM pipeline (tidy_service.py on <VM_TAILSCALE_IP>:11500) vs Claude Haiku via the installed native host.
// The VM backend needs TIDY_VM_OLLAMA_URL (e.g. http://<VM_TAILSCALE_IP>:11434) and TIDY_VM_SERVICE_URL
// (e.g. http://<VM_TAILSCALE_IP>:11500/tidy). The haiku backend needs neither.
// Usage: node bench.mjs <vm|haiku> <dataset,...> [runs=3] [tag]
// Sequential only. Writes runs/<backend>[-tag]-<dataset>.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { encodeMessage, createDecoder } from '../native-host/framing.js';
import { metrics } from './metrics.mjs';

const [backend, dsArg, runsArg = '3', tag = ''] = process.argv.slice(2);
const RUNS = Number(runsArg);
const OLLAMA = process.env.TIDY_VM_OLLAMA_URL || '';
const SERVICE = process.env.TIDY_VM_SERVICE_URL || '';
if (backend === 'vm' && (!OLLAMA || !SERVICE)) {
  console.error('vm backend: set TIDY_VM_OLLAMA_URL and TIDY_VM_SERVICE_URL');
  process.exit(2);
}
const WRAPPER = `${homedir()}/Library/Application Support/tidy-tabs/native-host/tidy-tabs-host`;
const EXT = new URL('../extension/', import.meta.url);
mkdirSync(new URL('./runs/', import.meta.url), { recursive: true });

// Use the extension's lib exactly as it is right now (snapshotted per run for provenance).
const coreSrc = readFileSync(new URL('lib/core.js', EXT), 'utf8');
const coreUrl = new URL('./snapshot/core.js', import.meta.url);
writeFileSync(coreUrl, coreSrc);
writeFileSync(
  new URL('./snapshot/claude-native.js', import.meta.url),
  readFileSync(new URL('lib/claude-native.js', EXT)),
);
const core = await import(coreUrl.href);
const { buildNativeRequest, parseNativeResponse } = await import(
  new URL('./snapshot/claude-native.js', import.meta.url).href
);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', EXT), 'utf8'));
const provenance = {
  extVersion: manifest.version_name || manifest.version,
  coreSha1: createHash('sha1').update(coreSrc).digest('hex').slice(0, 10),
  systemPrompt: core.SYSTEM_PROMPT,
};

async function postJson(url, body, timeoutMs = 300000) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${await r.text()}`);
  return r.json();
}

async function unloadVm() {
  for (const model of ['embeddinggemma', 'qwen3:1.7b'])
    await postJson(`${OLLAMA}/api/generate`, { model, keep_alive: 0 }).catch(() => {});
  const ps = await fetch(`${OLLAMA}/api/ps`).then((r) => r.json());
  return ps.models.map((m) => m.name);
}

async function runVm(ds) {
  const t0 = performance.now();
  const r = await postJson(SERVICE, { tabs: ds.tabs, name: true });
  return { groups: r.groups, wallMs: Math.round(performance.now() - t0), timing: r.timing, namedBy: r.named_by };
}

// Chrome launches hosts with a near-empty environment; mirror host-live.test.js.
function nativeSend(msg, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(WRAPPER, [], {
      env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, USER: process.env.USER, TMPDIR: process.env.TMPDIR },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const dec = createDecoder();
    const out = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('host timeout'));
    }, timeoutMs);
    child.stdout.on('data', (c) => out.push(...dec.push(c)));
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out[0]);
    });
    child.stdin.write(encodeMessage(msg));
    child.stdin.end();
  });
}

async function runHaiku(ds) {
  // Same path as backends.js runCluster('claude-haiku', auto => single-pass) with the default 120 s run deadline.
  const prompt = core.buildPrompt(ds.tabs);
  const t0 = performance.now();
  const msg = buildNativeRequest(prompt, core.GROUPS_SCHEMA, { model: 'haiku', timeoutMs: 120000 });
  let resp;
  try {
    resp = parseNativeResponse(await nativeSend(msg));
  } catch (e) {
    const groups = core.groupByDomain(ds.tabs);
    return { groups, wallMs: Math.round(performance.now() - t0), error: String(e.message), fallback: true };
  }
  const strict = core.checkSchema(resp.content, ds.tabs.length);
  let { groups, stats } = core.repairGroups(resp.content, prompt.idMap);
  let fallback = false;
  if (!groups.length || (groups.length === 1 && ds.tabs.length > 3)) {
    groups = core.groupByDomain(ds.tabs);
    fallback = true;
  }
  return {
    groups,
    wallMs: Math.round(performance.now() - t0),
    timing: resp.timing,
    strictErrors: strict.errors,
    repair: stats,
    fallback,
  };
}

for (const name of dsArg.split(',')) {
  const ds = JSON.parse(readFileSync(new URL(`./datasets/${name}.json`, import.meta.url)));
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    let pre;
    if (backend === 'vm' && i === 0) pre = { loadedAfterUnload: await unloadVm() };
    const startedAt = new Date().toISOString();
    let r;
    try {
      r = backend === 'vm' ? await runVm(ds) : await runHaiku(ds);
    } catch (e) {
      r = { error: String(e.message), groups: [], wallMs: null };
    }
    const m = metrics(r.groups, ds);
    runs.push({ run: i + 1, cold: i === 0, startedAt, ...pre, ...r, metrics: m });
    console.log(
      `${backend}${tag} ${name} run${i + 1}: ${r.wallMs} ms valid=${m.valid} purity=${m.purity} cohesion=${m.cohesion} groups=${m.groupCount} singles=${m.singletons} ${r.error || ''}`,
    );
    console.log('   ', m.names.join(' · '));
  }
  writeFileSync(
    new URL(`./runs/${backend}${tag ? `-${tag}` : ''}-${name}.json`, import.meta.url),
    JSON.stringify(
      { backend, tag, dataset: name, provenance: backend === 'haiku' ? provenance : undefined, runs },
      null,
      1,
    ),
  );
}
