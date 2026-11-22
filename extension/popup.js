// Action popup: "Tidy now", live progress, groups, and a red error panel with full diagnostics.
// Shows a setup panel when Claude is the backend but its helper (native host) isn't installed.
import { NATIVE_HOST, HELPER_INSTALL_CMD, SETUP_URL, isHelperMissing } from './lib/claude-native.js';
import { loadSettings } from './lib/settings.js';
import { chromeNativeSend } from './lib/backends.js';
import { withTimeout } from './lib/timeout.js';

const $ = (id) => document.getElementById(id);
let current = null; // last record shown
let statusInfo = null; // {env, swErrors} from the service worker

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function addProgress(step) {
  const li = el('li', step);
  $('progress').append(li);
  li.scrollIntoView({ block: 'nearest' });
}

function renderGroups(rec) {
  const box = $('groups');
  box.replaceChildren();
  if (rec.noChanges) {
    box.append(el('span', 'No changes made.', 'host'));
    return;
  }
  if (!rec.groups?.length) {
    box.append(el('span', rec.status === 'noop' ? 'Nothing to tidy.' : 'No groups.', 'host'));
    return;
  }
  for (const g of rec.groups) {
    const d = el('div', null, 'group');
    d.append(el('b', `${g.label} (${g.tabs ? g.tabs.length : g.size})`));
    const ul = el('ul');
    for (const t of g.tabs || []) {
      const li = el('li', `${t.title || '(untitled)'} `);
      li.append(el('span', t.host, 'host'));
      li.title = `${t.title} — ${t.host}`;
      ul.append(li);
    }
    d.append(ul);
    box.append(d);
  }
}

function renderStrategies(rec) {
  const box = $('strategies');
  box.replaceChildren();
  const results = rec.moves?.results || [];
  if (!results.length) return;
  box.append(el('h2', 'Move strategies'));
  const table = el('table');
  const head = el('tr');
  for (const h of ['strategy', 'calls', 'threw', 'ignored', 'onMoved', 'verified', 'ms']) head.append(el('th', h));
  table.append(head);
  for (const r of results) {
    const tr = el('tr');
    for (const v of [
      r.name,
      r.calls,
      r.threwCount,
      r.ignored,
      `${r.onMovedEvents} (missing ${r.onMovedMissing})`,
      r.verified ? 'yes' : 'NO',
      r.ms,
    ])
      tr.append(el('td', String(v)));
    table.append(tr);
  }
  box.append(table);
}

function render(rec) {
  current = rec;
  const st = $('status');
  st.className = rec.status || '';
  st.textContent = rec.summary || rec.error || 'Done.';
  if (rec.progress?.length && !$('progress').children.length) for (const p of rec.progress) addProgress(p.step);
  renderGroups(rec);
  renderStrategies(rec);
  const errs = [
    ...(rec.errors || []),
    ...(rec.swErrors || []).map((e) => ({ where: `sw:${e.where}`, message: e.message })),
  ];
  if (rec.moves && !rec.moves.verified) errs.unshift({ where: 'verify', message: rec.moves.message });
  const list = $('errorList');
  list.replaceChildren(
    ...(rec.hints || []).map((h) => el('li', `→ ${h}`, 'hint')),
    ...errs.map((e) => el('li', `[${e.where}] ${e.message}`)),
  );
  if (rec.nativeLog && !rec.nativeLog.ok)
    list.append(el('li', `[nativeLog] diagnostics file NOT written: ${rec.nativeLog.error}`));
  const env = {
    ...(rec.env || statusInfo?.env || {}),
    counts: rec.counts,
    tabGroups: rec.tabGroups,
    backend: rec.backend?.name,
    attemptedBackend: rec.backend?.attempted,
    strategy: rec.backend?.strategy,
    nativeLog: rec.nativeLog,
  };
  $('envBox').textContent = JSON.stringify(env, null, 2);
  const show =
    errs.length > 0 ||
    (rec.nativeLog && !rec.nativeLog.ok) ||
    (rec.status && rec.status !== 'verified' && rec.status !== 'noop');
  $('errors').style.display = show ? 'block' : 'none';
}

async function tidyNow() {
  $('tidy').disabled = true;
  $('progress').replaceChildren();
  $('status').className = '';
  $('status').textContent = 'Running…';
  try {
    const win = await chrome.windows.getCurrent();
    const rec = await chrome.runtime.sendMessage({ type: 'tidy', windowId: win.id, trigger: 'popup' });
    if (rec?.status === 'busy') addProgress('another run is in progress; showing it when done');
    else if (rec) render(rec);
  } catch (e) {
    render({
      status: 'error',
      error: String(e?.message || e),
      summary: `Popup error: ${e?.message || e}`,
      errors: [{ where: 'popup', message: String(e) }],
    });
  } finally {
    $('tidy').disabled = false;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'progress') addProgress(msg.step);
  if (msg?.type === 'done' && msg.record) {
    render(msg.record);
    $('tidy').disabled = false;
  }
});

$('tidy').addEventListener('click', tidyNow);
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('copy').addEventListener('click', async () => {
  let record = current;
  try {
    const { lastRunFull } = await chrome.storage.session.get('lastRunFull');
    if (lastRunFull && (!current || lastRunFull.id === current.id)) record = lastRunFull;
  } catch {
    /* session storage unavailable: copy what is shown */
  }
  const payload = JSON.stringify({ record, status: statusInfo, popup: { ua: navigator.userAgent } }, null, 2);
  try {
    await navigator.clipboard.writeText(payload);
    $('copied').textContent = 'Copied.';
  } catch (e) {
    $('envBox').textContent = payload;
    $('errors').style.display = 'block';
    $('copied').textContent = `Clipboard blocked (${e.message}); diagnostics shown above. The log file also has them.`;
  }
});

/** Show the setup panel when the Claude backend is selected and its helper can't be reached. */
async function checkHelper() {
  const settings = await loadSettings();
  if (settings.backend !== 'claude-haiku') return;
  try {
    const r = await withTimeout(() => chromeNativeSend(NATIVE_HOST, { type: 'ping' }), 4000, 'helper ping');
    if (r?.ok) return;
  } catch (e) {
    if (!isHelperMissing(e?.message)) return; // other failures show up in the run's error panel
  }
  $('setupCmd').textContent = HELPER_INSTALL_CMD;
  $('setupGuide').href = SETUP_URL;
  $('setup').hidden = false;
}

$('copyCmd').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(HELPER_INSTALL_CMD);
    $('cmdCopied').textContent = 'Copied.';
  } catch {
    $('cmdCopied').textContent = 'Select the command above and copy it.';
  }
});

checkHelper().catch(() => {});

(async () => {
  try {
    statusInfo = await chrome.runtime.sendMessage({ type: 'status' });
    if (statusInfo?.running) {
      $('status').textContent = 'A run is in progress…';
      $('tidy').disabled = true;
    }
  } catch {
    /* service worker starting */
  }
  const { lastRun } = await chrome.storage.local.get('lastRun');
  if (lastRun) render(lastRun);
})();
