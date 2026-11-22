// End-to-end harness: the real extension in Chromium, with the real helper installed by the real
// install.sh into a throwaway HOME whose Chromium profile is the test browser's profile. Only the
// Claude Code CLI is replaced (fake-claude.mjs), unless TIDY_E2E_LIVE=1 uses the real one.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '../..');
export const EXT = join(ROOT, 'extension');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(fn, { timeout = 10000, interval = 100, msg = 'condition' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${msg} (last=${JSON.stringify(last)})`);
}

/** Tabs for a "messy window": two tasks spread over several sites, plus a stray tab. */
export const SITES = [
  ['https://docs.python.org/3/library/asyncio.html', 'asyncio — Asynchronous I/O — Python docs'],
  ['https://www.lisbon-hotels.example/alfama', 'Hotels in Alfama, Lisbon'],
  ['https://stackoverflow.com/questions/1/asyncio-timeout', 'python - asyncio wait_for timeout - Stack Overflow'],
  ['https://flights.example/lis', 'Cheap flights to Lisbon (LIS)'],
  ['https://pypi.org/project/aiohttp/', 'aiohttp · PyPI (python)'],
  ['https://news.example/today', 'Morning news'],
  ['https://www.booking.example/lisbon', 'Lisbon apartments · booking'],
  ['https://stackoverflow.com/questions/2/python-gather', 'python - asyncio.gather order - Stack Overflow'],
];

/**
 * Launch Chromium with the extension. `helper: 'fake' | 'live' | 'none'`.
 * Returns { ctx, sw, extId, home, claudeLog, close }.
 */
export async function launch({ helper = 'fake', deviceScaleFactor = 1 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'tidy-e2e-home-'));
  const profile = join(home, '.config', 'chromium'); // Chromium reads NativeMessagingHosts/ from here
  mkdirSync(profile, { recursive: true });
  const claudeLog = join(home, 'claude-args.jsonl');

  if (helper !== 'none') {
    let claudeBin;
    if (helper === 'live') {
      claudeBin = execFileSync('bash', ['-lc', 'command -v claude']).toString().trim();
    } else {
      // The helper runs claude with PATH=/usr/bin:/bin and a scrubbed env, so bake in absolute paths.
      claudeBin = join(home, 'fake-claude');
      writeFileSync(
        claudeBin,
        `#!/bin/bash\nexport FAKE_CLAUDE_LOG=${JSON.stringify(claudeLog)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(here, 'fake-claude.mjs'))} "$@"\n`,
      );
      chmodSync(claudeBin, 0o755);
    }
    execFileSync(join(ROOT, 'install.sh'), ['--claude', claudeBin, '--node', process.execPath], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: '', XDG_DATA_HOME: '', XDG_STATE_HOME: '' },
      stdio: 'pipe',
    });
    if (!existsSync(join(profile, 'NativeMessagingHosts', 'dev.tidytabs.claude.json'))) {
      throw new Error('install.sh did not register the helper in the test profile');
    }
  }

  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;

  // Serve every https test site locally so no real network is used.
  await ctx.route(/^https:\/\//, (route) => {
    const url = route.request().url();
    const title = (SITES.find(([u]) => u === url) || [url, url])[1];
    return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><title>${title}</title><h1>${title}</h1>`,
    });
  });

  return {
    ctx,
    sw,
    extId,
    home,
    claudeLog,
    claudeCalls: () =>
      existsSync(claudeLog)
        ? readFileSync(claudeLog, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [],
    close: () => ctx.close(),
  };
}

/** Open all SITES as tabs in one window (plus whatever tab the context started with). */
export async function openSites(ctx) {
  const pages = [];
  for (const [url] of SITES) {
    const p = await ctx.newPage();
    await p.goto(url);
    pages.push(p);
  }
  return pages;
}

/** Window tabs as seen by the extension: [{title, groupId}], in tab-strip order. */
export function tabState(sw) {
  return sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const groups = await chrome.tabGroups.query({});
    const title = new Map(groups.map((g) => [g.id, g.title]));
    return tabs
      .sort((a, b) => a.windowId - b.windowId || a.index - b.index)
      .map((t) => ({ title: t.title, url: t.url, group: t.groupId === -1 ? null : title.get(t.groupId) }));
  });
}

/** Open the popup page as a tab in the same window and click "Tidy now". Resolves with the popup page. */
export async function tidyFromPopup(ctx, extId) {
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.click('#tidy');
  await waitFor(() => popup.evaluate(() => !document.getElementById('tidy').disabled), {
    timeout: 60000,
    msg: 'tidy run to finish',
  });
  return popup;
}
