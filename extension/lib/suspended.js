// Tab-suspender extensions (Tab Suspender, The Marvellous Suspender, Tiny Suspender, ...) replace a
// tab's URL with chrome-extension://<id>/<page>?...url=<real url>. Those tabs are real pages, so we
// recover the original URL (and title, when the suspender passes one) before clustering.
const PARAM_KEYS = ['url', 'uri', 'u', 'target'];

function paramsOf(u) {
  const hash = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash;
  return [u.searchParams, new URLSearchParams(hash)];
}

/** Original http(s) URL hidden in a chrome-extension:// suspender URL, or null. */
export function unwrapSuspendedUrl(raw) {
  if (!raw || !/^chrome-extension:/i.test(raw)) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  for (const params of paramsOf(u)) {
    for (const k of PARAM_KEYS) {
      const v = params.get(k);
      if (v && /^https?:\/\//i.test(v)) return v;
    }
  }
  return null;
}

/** Title the suspender passed along (`title=` / `ttl=`), or null. */
function suspendedTitle(raw) {
  try {
    const u = new URL(raw);
    for (const params of paramsOf(u)) {
      const t = params.get('title') || params.get('ttl');
      if (t) return t;
    }
  } catch { /* ignore */ }
  return null;
}

/** The tab as the clusterer should see it: suspended tabs get their real URL back (same id). */
export function effectiveTab(tab) {
  const raw = tab.url || tab.pendingUrl || '';
  const real = unwrapSuspendedUrl(raw);
  if (!real) return tab;
  const title = tab.title && !/^chrome-extension:/i.test(tab.title) ? tab.title : (suspendedTitle(raw) || real);
  return { ...tab, url: real, pendingUrl: undefined, title, suspended: true };
}

/** "scheme://host" of a skipped tab: enough to see *what* was skipped without paths or titles. */
export function skippedKind(tab) {
  const raw = tab.url || tab.pendingUrl || '';
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return raw ? raw.split(/[/?#]/)[0] : '(no url)';
  }
}
