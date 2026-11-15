import { DEFAULTS, loadSettings, saveSettings } from './lib/settings.js';
import { nanoAvailable, chromeNativeSend } from './lib/backends.js';
import { NATIVE_HOST } from './lib/claude-native.js';
import { probeSettles } from './lib/timeout.js';

const $ = (id) => document.getElementById(id);
const FIELDS = ['backend', 'claudeModel', 'endpoint', 'model', 'strategy', 'timeoutMs', 'createTabGroups', 'collapseGroups', 'debugLogging', 'notify'];

function status(msg) { $('status').textContent = msg; }

function readForm() {
  const out = {};
  for (const f of FIELDS) {
    const el = $(f);
    if (el.type === 'checkbox') out[f] = el.checked;
    else if (el.type === 'number') out[f] = Math.max(2000, Number(el.value) || DEFAULTS[f]);
    else out[f] = el.value.trim() || DEFAULTS[f];
  }
  out.endpoint = out.endpoint.replace(/\/+$/, '');
  return out;
}

async function ensureOriginPermission(endpoint) {
  let origin;
  try { origin = `${new URL(endpoint).origin}/*`; } catch { throw new Error('endpoint is not a valid URL'); }
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  return chrome.permissions.request({ origins: [origin] });
}

async function init() {
  const s = await loadSettings();
  for (const f of FIELDS) {
    const el = $(f);
    if (el.type === 'checkbox') el.checked = !!s[f]; else el.value = s[f];
  }
  const env = {
    userAgent: navigator.userAgent,
    tabGroupsApi: !!(chrome.tabGroups && chrome.tabs.group),
    tabGroupsSettles: (await probeSettles(() => chrome.tabGroups.query({}), { exists: !!chrome.tabGroups?.query, label: 'tabGroups.query' })).reason,
    languageModelApi: typeof globalThis.LanguageModel !== 'undefined',
    languageModelAvailable: await nanoAvailable(),
    notificationsApi: !!chrome.notifications,
  };
  $('env').textContent = JSON.stringify(env, null, 2);
  await showReport();
}

async function showReport() {
  const { lastRun, recentRuns = [] } = await chrome.storage.local.get(['lastRun', 'recentRuns']);
  if (lastRun) $('report').textContent = JSON.stringify(lastRun, null, 2);
  const table = $('recent');
  while (table.rows.length > 1) table.deleteRow(1);
  for (const r of recentRuns) {
    const tr = table.insertRow();
    const cells = [new Date(r.at).toLocaleString(), r.status, r.backend || '', r.winner || '—', String(r.errors), r.summary || ''];
    cells.forEach((v, i) => {
      const td = tr.insertCell();
      td.textContent = v;
      if (i === 1) td.className = r.status;
    });
  }
}

$('save').addEventListener('click', async () => {
  try {
    const s = readForm();
    if (s.backend === 'ollama' && !(await ensureOriginPermission(s.endpoint))) {
      return status('Permission for that endpoint was denied.');
    }
    await saveSettings(s);
    status('Saved.');
  } catch (e) { status(`Error: ${e.message}`); }
});

$('test').addEventListener('click', async () => {
  const { backend, endpoint, model } = readForm();
  status('Testing…');
  const t0 = performance.now();
  if (backend === 'claude-haiku') {
    try {
      const r = await chromeNativeSend(NATIVE_HOST, { type: 'ping' });
      const ms = Math.round(performance.now() - t0);
      return status(r?.ok ? `Native host OK in ${ms} ms (v${r.version}, claude: ${r.claudeBin})` : `Host error: ${r?.error}`);
    } catch (e) { return status(`${e.message}. Run ./install.sh and reload the extension.`); }
  }
  if (backend === 'gemini-nano') return status(`LanguageModel available: ${await nanoAvailable()}`);
  try {
    const res = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const json = await res.json();
    const names = (json.models || []).map((m) => m.name);
    const ms = Math.round(performance.now() - t0);
    status(`OK in ${ms} ms. Models: ${names.join(', ') || 'none'}${names.includes(model) ? '' : ` (warning: ${model} not pulled)`}`);
  } catch (e) { status(`Unreachable: ${e.message}`); }
});

$('run').addEventListener('click', async () => {
  status('Running…');
  const report = await chrome.runtime.sendMessage({ type: 'tidy', trigger: 'options' });
  status(report?.summary || report?.error || 'Done.');
  await showReport();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.lastRun || changes.recentRuns)) showReport();
});

init();
