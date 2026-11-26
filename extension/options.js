import { DEFAULTS, loadSettings, saveSettings } from './lib/settings.js';
import { nanoAvailable, chromeNativeSend, resolveStrategy } from './lib/backends.js';
import {
  NATIVE_HOST,
  CLAUDE_MODEL_ALIASES,
  CLAUDE_MODEL_RE,
  HELPER_INSTALL_CMD,
  SETUP_URL,
  isHelperMissing,
} from './lib/claude-native.js';
import { probeSettles } from './lib/timeout.js';
import { DEFAULT_INSTRUCTIONS, INSTRUCTIONS_MAX, normalizeInstructions, systemPromptFor } from './lib/core.js';
import { labelsSystemFor } from './lib/two-pass.js';

const $ = (id) => document.getElementById(id);
const FIELDS = [
  'backend',
  'claudeModel',
  'endpoint',
  'model',
  'strategy',
  'timeoutMs',
  'createTabGroups',
  'collapseGroups',
  'debugLogging',
  'notify',
  'saveLogFile',
];

function status(msg) {
  $('status').textContent = msg;
}

function readForm() {
  const out = {};
  for (const f of FIELDS) {
    const el = $(f);
    if (el.type === 'checkbox') out[f] = el.checked;
    else if (el.type === 'number') out[f] = Math.max(2000, Number(el.value) || DEFAULTS[f]);
    else out[f] = el.value.trim() || DEFAULTS[f];
  }
  out.endpoint = out.endpoint.replace(/\/+$/, '');
  const choice = $('claudeModelChoice').value;
  out.claudeModel = choice === 'custom' ? $('claudeModel').value.trim() : choice;
  // Another backend in use: don't let an unfinished custom Claude ID block saving the rest.
  if (out.backend !== 'claude-haiku' && !CLAUDE_MODEL_RE.test(out.claudeModel)) out.claudeModel = DEFAULTS.claudeModel;
  // The default text is stored as '' so future improvements to the built-in prompt still reach you.
  out.groupingInstructions = normalizeInstructions($('groupingInstructions').value);
  return out;
}

function syncInstructions() {
  const text = $('groupingInstructions').value;
  const custom = !!normalizeInstructions(text);
  $('instructionsCount').textContent =
    `${text.length}/${INSTRUCTIONS_MAX} characters${custom ? ' (custom)' : ' (default)'}.`;
  if (!$('promptPreview').hidden) showPromptPreview();
}

/** The system prompt the model gets for a 20-tab window with the current text and strategy. */
function showPromptPreview() {
  const { backend, strategy } = readForm();
  const twoPass = resolveStrategy(strategy, backend) === 'two-pass';
  const text = $('groupingInstructions').value;
  $('promptPreview').textContent = twoPass
    ? `Two-pass, pass 1 (labels), for a 20-tab window:\n\n${labelsSystemFor(20, text)}`
    : `Single-pass, for a 20-tab window:\n\n${systemPromptFor(20, text)}`;
  $('promptPreview').hidden = false;
}

/** Show the custom model field only for "Custom model ID…". */
function syncModelChoice() {
  $('claudeModel').hidden = $('claudeModelChoice').value !== 'custom';
}

function showClaudeModel(model) {
  const known = CLAUDE_MODEL_ALIASES.includes(model);
  $('claudeModelChoice').value = known ? model : 'custom';
  $('claudeModel').value = known ? '' : model;
  syncModelChoice();
}

async function ensureOriginPermission(endpoint) {
  let origin;
  try {
    origin = `${new URL(endpoint).origin}/*`;
  } catch {
    throw new Error('endpoint is not a valid URL');
  }
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  return chrome.permissions.request({ origins: [origin] });
}

async function init() {
  const s = await loadSettings();
  for (const f of FIELDS) {
    const el = $(f);
    if (el.type === 'checkbox') el.checked = !!s[f];
    else el.value = s[f];
  }
  showClaudeModel(s.claudeModel || DEFAULTS.claudeModel);
  $('groupingInstructions').value = s.groupingInstructions || DEFAULT_INSTRUCTIONS;
  syncInstructions();
  $('installCmd').textContent = HELPER_INSTALL_CMD;
  $('setupLink').href = SETUP_URL;
  const env = {
    userAgent: navigator.userAgent,
    tabGroupsApi: !!(chrome.tabGroups && chrome.tabs.group),
    tabGroupsSettles: (
      await probeSettles(() => chrome.tabGroups.query({}), {
        exists: !!chrome.tabGroups?.query,
        label: 'tabGroups.query',
      })
    ).reason,
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
    const cells = [
      new Date(r.at).toLocaleString(),
      r.status,
      r.backend || '',
      r.winner || '—',
      String(r.errors),
      r.summary || '',
    ];
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
    if (s.backend === 'claude-haiku' && !CLAUDE_MODEL_RE.test(s.claudeModel)) {
      return status(`"${s.claudeModel}" isn't a valid Claude model ID (letters, digits, . _ : - [ ]; max 64).`);
    }
    if (s.backend === 'ollama' && !(await ensureOriginPermission(s.endpoint))) {
      return status('Permission for that endpoint was denied.');
    }
    await saveSettings(s);
    status('Saved.');
  } catch (e) {
    status(`Error: ${e.message}`);
  }
});

$('test').addEventListener('click', async () => {
  const { backend, endpoint, model } = readForm();
  status('Testing…');
  const t0 = performance.now();
  if (backend === 'claude-haiku') {
    try {
      const r = await chromeNativeSend(NATIVE_HOST, { type: 'ping' });
      const ms = Math.round(performance.now() - t0);
      return status(
        r?.ok ? `Native host OK in ${ms} ms (v${r.version}, claude: ${r.claudeBin})` : `Host error: ${r?.error}`,
      );
    } catch (e) {
      return status(
        isHelperMissing(e.message)
          ? `The Claude helper isn't installed for this browser. Run: ${HELPER_INSTALL_CMD} then restart the browser.`
          : `${e.message}`,
      );
    }
  }
  if (backend === 'gemini-nano') return status(`LanguageModel available: ${await nanoAvailable()}`);
  try {
    const res = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const json = await res.json();
    const names = (json.models || []).map((m) => m.name);
    const ms = Math.round(performance.now() - t0);
    status(
      `OK in ${ms} ms. Models: ${names.join(', ') || 'none'}${names.includes(model) ? '' : ` (warning: ${model} not pulled)`}`,
    );
  } catch (e) {
    status(`Unreachable: ${e.message}`);
  }
});

$('run').addEventListener('click', async () => {
  status('Running…');
  const report = await chrome.runtime.sendMessage({ type: 'tidy', trigger: 'options' });
  status(report?.summary || report?.error || 'Done.');
  await showReport();
});

$('claudeModelChoice').addEventListener('change', syncModelChoice);
$('groupingInstructions').addEventListener('input', syncInstructions);
$('resetInstructions').addEventListener('click', () => {
  $('groupingInstructions').value = DEFAULT_INSTRUCTIONS;
  syncInstructions();
  status('Default instructions restored. Click Save to keep them.');
});
$('previewPrompt').addEventListener('click', () => {
  if ($('promptPreview').hidden) showPromptPreview();
  else $('promptPreview').hidden = true;
  $('previewPrompt').textContent = $('promptPreview').hidden ? 'Show full prompt' : 'Hide full prompt';
});
$('strategy').addEventListener('change', () => !$('promptPreview').hidden && showPromptPreview());
$('backend').addEventListener('change', () => !$('promptPreview').hidden && showPromptPreview());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.lastRun || changes.recentRuns)) showReport();
});

init();
