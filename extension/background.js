// Service worker: wires triggers (popup, command, options) to runTidy, then publishes the record to
// the badge, chrome.storage.local (lastRun + last 10), the popup (progress messages) and the native
// host log file (~/Library/Logs/tidy-tabs on macOS, ~/.local/state/tidy-tabs on Linux). Every handler is wrapped; unhandled errors are recorded.
import { loadSettings } from './lib/settings.js';
import { runTidy, environment } from './lib/tidy-run.js';
import { pushRecent, errorEntry, hintsFor, redactRecord } from './lib/diagnostics.js';
import { chromeNativeSend } from './lib/backends.js';
import { NATIVE_HOST } from './lib/claude-native.js';
import { withTimeout } from './lib/timeout.js';

let running = null; // promise of the in-flight run
let swErrors = []; // extension-side exceptions since the last run

function recordSwError(where, e) {
  swErrors.push(errorEntry(where, e));
  swErrors = swErrors.slice(-20);
  chrome.storage.local.set({ swErrors }).catch(() => {});
}
self.addEventListener('unhandledrejection', (ev) => recordSwError('unhandledrejection', ev.reason));
self.addEventListener('error', (ev) => recordSwError('error', ev.error || ev.message));

/** Wrap a listener so exceptions are recorded instead of vanishing. */
const safe = (where, fn) => (...args) => {
  try {
    const r = fn(...args);
    if (r && typeof r.catch === 'function') r.catch((e) => recordSwError(where, e));
    return r;
  } catch (e) {
    recordSwError(where, e);
    return undefined;
  }
};

async function setBadge({ text, color }, title) {
  try {
    await chrome.action.setBadgeText({ text });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
    if (title) await chrome.action.setTitle({ title: `Tidy Tabs AI\n${title}`.slice(0, 500) });
  } catch (e) { recordSwError('setBadge', e); }
}

function notify(settings, title, message) {
  if (!settings.notify || !chrome.notifications?.create) return;
  try {
    chrome.notifications.create({
      type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message: message.slice(0, 400),
    }, () => void chrome.runtime.lastError);
  } catch { /* notifications unsupported: badge + popup are enough */ }
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => { /* popup closed: fine */ });
}

/** Write the record to the helper's log folder via the native host. Returns {ok, error?, path?}. */
async function nativeLog(record) {
  try {
    const resp = await withTimeout(() => chromeNativeSend(NATIVE_HOST, { type: 'log', record }), 5000, 'native log');
    return resp?.ok ? { ok: true, path: resp.path } : { ok: false, error: resp?.error || 'no response' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function tidy(windowId, trigger) {
  if (running) return { ok: false, status: 'busy', summary: 'A tidy run is already in progress', error: 'already running' };
  running = (async () => {
    const settings = await loadSettings();
    await setBadge({ text: '…', color: '#666666' }, 'Tidying…');
    const rec = await runTidy({
      windowId, settings, trigger,
      onProgress: (step) => broadcast({ type: 'progress', step }),
    });
    rec.swErrors = swErrors;
    swErrors = [];
    rec.nativeLog = await nativeLog(redactRecord(rec, settings));
    if (!rec.nativeLog.ok) rec.errors.push({ where: 'nativeLog', message: rec.nativeLog.error });
    rec.hints = hintsFor(rec);
    await setBadge(rec.badge, rec.summary);
    if (rec.status === 'moves-failed') notify(settings, 'Tidy Tabs AI: tabs not reordered', rec.summary);
    else if (rec.status === 'backend-failed' || rec.status === 'error') notify(settings, 'Tidy Tabs AI: backend failed', rec.summary);
    try {
      const { recentRuns } = await chrome.storage.local.get('recentRuns');
      const stored = redactRecord(rec, settings);
      await chrome.storage.local.set({ lastRun: stored, recentRuns: pushRecent(recentRuns, stored), swErrors: [] });
    } catch (e) { recordSwError('storage', e); }
    // Full record (prompt + answer, titles) kept in memory-only session storage for "Copy diagnostics".
    try { await chrome.storage.session.set({ lastRunFull: rec }); } catch (e) { recordSwError('storage.session', e); }
    broadcast({ type: 'done', record: rec });
    return rec;
  })();
  try {
    return await running;
  } catch (e) {
    recordSwError('tidy', e);
    return { ok: false, status: 'error', error: String(e?.message || e), summary: `Error: ${e?.message || e}` };
  } finally {
    running = null;
  }
}

chrome.commands.onCommand.addListener(safe('onCommand', (command, tab) => {
  if (command === 'tidy-tabs') return tidy(tab?.windowId, 'shortcut');
  return undefined;
}));

chrome.runtime.onMessage.addListener(safe('onMessage', (msg, _sender, sendResponse) => {
  if (msg?.type === 'tidy') {
    tidy(msg.windowId, msg.trigger || 'message').then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === 'status') {
    environment().then((env) => sendResponse({ running: !!running, env, swErrors }),
      (e) => sendResponse({ running: !!running, envError: String(e), swErrors }));
    return true;
  }
  return false;
}));
