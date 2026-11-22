// Run records for the popup, options page and the native log file. Pure (no chrome.*).
// Records contain tab titles + hosts only, never full URLs or page content.
import { hostOf } from './core.js';

export const RECENT_MAX = 10;

/** Guess the browser from UA brands + whether tabGroups calls settle. */
export function guessBrowser({ brands = [], tabGroupsUsable, tabGroupsReason = '' } = {}) {
  const names = brands.map((b) => b.brand || b).filter((n) => !/not.?a.?brand/i.test(n));
  if (/hangs/.test(tabGroupsReason)) return 'unsupported (tabGroups hangs)';
  if (names.some((n) => /\bdia\b/i.test(n))) return 'dia';
  if (names.some((n) => /\bphi\b/i.test(n))) return 'phi';
  if (names.includes('Google Chrome')) return tabGroupsUsable ? 'chrome' : 'chrome (tabGroups unusable)';
  if (names.includes('Microsoft Edge')) return 'edge';
  if (names.length === 1 && names[0] === 'Chromium') return 'chromium fork (unknown; e.g. Phi)';
  return names.includes('Chromium') ? 'chromium-based (unknown)' : 'unknown';
}

export function tabSummary(tab) {
  return { id: tab.id, index: tab.index, title: String(tab.title || '').slice(0, 120), host: hostOf(tab.url || tab.pendingUrl || '') };
}

/** Groups with titles for display: [{label, tabs:[{id,title,host}]}]. */
export function describeGroups(groups, tabs) {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  return groups.map((g) => ({
    label: g.label,
    tabs: g.tabIds.map((id) => byId.get(id)).filter(Boolean).map(tabSummary).map(({ id, title, host }) => ({ id, title, host })),
  }));
}

/** Overall status + badge from a finished record. */
export function classify(rec) {
  if (rec.error) return { status: 'error', badge: { text: '✗', color: '#dc2626' } };
  if (rec.status === 'noop') return { status: 'noop', badge: { text: '', color: '#666666' } };
  if (rec.backend?.fallback) return { status: 'backend-failed', badge: { text: '✗', color: '#dc2626' } };
  if (!rec.moves?.verified) return { status: 'moves-failed', badge: { text: '!', color: '#d97706' } };
  return { status: 'verified', badge: { text: '✓', color: '#16a34a' } };
}

/** One-line summary for badge tooltips and notifications. */
export function summarize(rec) {
  const g = rec.groups?.length ?? 0;
  const b = rec.backend?.name || 'no backend';
  switch (rec.status) {
    case 'verified': return `${g} groups via ${b}; ${rec.moves.message}`;
    case 'moves-failed': return `${g} groups via ${b}, but ${rec.moves?.message || 'moves failed'}`;
    case 'backend-failed':
      if (rec.noChanges) return `${backendName(rec)} unavailable → domain fallback found nothing to group; no changes made`;
      return `Backend failed (${rec.backend.fallbackReason}); grouped by domain. ${rec.moves?.message || ''}`.trim();
    case 'noop': return 'Nothing to tidy';
    default: return `Error: ${rec.error}`;
  }
}

function backendName(rec) {
  const a = rec.backend?.attempted || '';
  if (a.startsWith('claude')) return 'Claude';
  if (a.startsWith('ollama')) return 'Ollama';
  return a || 'Backend';
}

/** Actionable hints for known failure messages. */
export function hintsFor(rec) {
  const msgs = [...(rec.errors || []).map((e) => e.message), rec.backend?.fallbackReason, rec.nativeLog?.error, rec.error]
    .filter(Boolean).join('\n');
  const hints = [];
  if (/native messaging host not found/i.test(msgs)) {
    hints.push(`The Claude helper isn't installed for this browser (${rec.env?.browserGuess || 'unknown browser'}). `
      + 'Install it with the command under "Set up the Claude helper" (macOS/Linux), then fully quit and restart the browser. '
      + 'Or pick Ollama / Gemini Nano in Options.');
  }
  if (/Access to the specified native messaging host is forbidden/i.test(msgs)) {
    hints.push(`The Claude helper is installed, but not for this extension id (${rec.env?.extensionId || '?'}). `
      + 'Re-run the helper installer, then restart the browser.');
  }
  return hints;
}

/** Newest first, capped. */
export function pushRecent(list, rec, max = RECENT_MAX) {
  const slim = { id: rec.id, at: rec.at, status: rec.status, summary: rec.summary, elapsedMs: rec.elapsedMs,
    backend: rec.backend?.name, winner: rec.moves?.winner ?? null, errors: (rec.errors || []).length };
  return [slim, ...(Array.isArray(list) ? list : [])].slice(0, max);
}

/** Normalize an error / rejection reason into a serializable entry. */
export function errorEntry(where, e) {
  return { where, at: new Date().toISOString(), message: String(e?.message || e), stack: e?.stack ? String(e.stack).slice(0, 800) : undefined };
}

/**
 * Privacy: unless debug logging is on, stored history and disk logs keep status, errors, timings,
 * counts, backend, move results and group labels + sizes, but no tab titles or hosts.
 */
export function redactRecord(rec, { debugLogging = false } = {}) {
  if (debugLogging) return rec;
  const { before: _before, llm, ...rest } = rec; // titles/hosts in `before` are dropped
  return {
    ...rest,
    llm: llm ? `${llm.length} model call(s) omitted (Copy diagnostics includes them; or enable Debug logging)` : undefined,
    groups: (rec.groups || []).map((g) => ({ label: g.label, size: g.tabs ? g.tabs.length : g.size })),
    redacted: 'tab titles/hosts omitted (enable Debug logging to include them)',
  };
}
