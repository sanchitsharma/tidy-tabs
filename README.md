# Tidy Tabs AI

A Chrome extension that tidies the current window. It groups your tabs by the **task you're in the middle of**,
puts related tabs next to each other, and turns each group into a named, colored tab group.

## Overview

Click the toolbar icon and **Tidy now**, or press **Alt+Shift+T**. Tidy Tabs AI reads the title and site of each tab
in the window, asks an AI model to group them by task ("Lisbon trip", "Python asyncio", "Code review"), then reorders
the tabs and creates one tab group per task. Tabs that don't belong anywhere are left alone.

Pick the model in Options:

- **Claude** (default): uses **your own Claude subscription** through the Claude Code CLI on your computer. Choose
  Haiku (fastest), Sonnet, Opus, or any model ID Claude Code accepts. There's no API key and no server of ours.
  Needs a small helper, installed once (macOS or Linux, see below).
- **Ollama**: a local or self-hosted model (`http://localhost:11434` by default, or any endpoint you approve).
- **Gemini Nano**: Chrome's built-in model, where your Chrome has it.

If the model fails, it falls back to grouping by website, and only when that finds at least 2 real groups.

## Install

1. Install **Tidy Tabs AI** from the Chrome Web Store:
   https://chromewebstore.google.com/detail/ponmidmoanddncagjfeegheonbgpeahe
2. For the Claude backend, install the helper once. You need the
   [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and logged in (run `claude` once) and
   Node.js 18 or newer. Then, in a terminal:

   ```sh
   curl -fsSL https://github.com/sanchitsharma/tidy-tabs/releases/latest/download/install.sh | bash
   ```

3. **Fully quit and reopen** the browser so it picks up the helper.

The installer works for Chrome, Chromium, Brave, Edge and Vivaldi on macOS and Linux (plus Dia and Phi on macOS). It
installs only into your user folders; no `sudo`. To remove the helper:

```sh
curl -fsSL https://github.com/sanchitsharma/tidy-tabs/releases/latest/download/uninstall.sh | bash
```

Windows isn't supported for the Claude helper yet; use Ollama or Gemini Nano there. Arc isn't supported: its tab
moves and tab-group APIs don't work for extensions.

Setup guide: https://sanchitsharma.github.io/tidy-tabs/setup.html · Privacy policy:
https://sanchitsharma.github.io/tidy-tabs/privacy.html

## Implementation Notes

```
extension (service worker)
   │  chrome.runtime.sendNativeMessage("dev.tidytabs.claude", {type:"chat", model, system, user, schema})
   ▼
helper (node; macOS ~/Library/Application Support/tidy-tabs, Linux ~/.local/share/tidy-tabs)
   │  claude -p --model=<your choice> --output-format json --json-schema … (tools off, MCP off, safe mode)
   ▼
Claude (your Claude subscription)  →  {groups:[{label, tabIds}], ungrouped:[…]}
```

- **Strategies:** single-pass for Claude, where one call returns the groups. Two-pass for small local models: first
  propose labels, then assign every tab against a per-run enum schema.
- **Safety net on every path:** unknown or duplicate ids are dropped; single-tab groups and leftovers go to "Other",
  which is never made a tab group; labels are capped at 40 chars; at most 8 groups. Browser-internal pages
  (`chrome://`, `chrome-extension://`, …) are never sent or grouped. Tabs parked by a suspender extension are grouped
  by their real URL.
- **Moves are verified:** after reordering, the extension re-reads the window and compares it with the plan,
  retrying once with a single array move. The popup shows exactly what happened.
- **Tab groups are reused:** re-tidying keeps or renames the groups it created earlier. Your own groups are never
  renamed.
- **No helper?** The popup shows a "Set up the Claude helper" panel with the install command, and Tidy falls back to
  grouping by website.
- **Extension ID:** `manifest.json` carries the Chrome Web Store item's public key, so an unpacked copy of
  `extension/` has the same ID as the store build (`ponmidmoanddncagjfeegheonbgpeahe`), which the helper allows.

### Privacy and security

- **What leaves your machine:** each tab's **title (max 80 chars) and hostname**, not the full URL or page content.
  With Claude it goes to Anthropic through your Claude Code CLI, under your own account and terms. With Ollama it goes
  only to the endpoint you configure; Gemini Nano runs on-device. The developer receives nothing.
- **Claude is sandboxed:** `claude -p` runs with all tools disabled, no MCP servers, `--safe-mode` (no CLAUDE.md,
  hooks, plugins or skills), no settings sources, no session persistence, and in an empty temp dir. The helper strips
  `ANTHROPIC_API_KEY`, so your subscription login is used. Model IDs are validated (letters, digits, `. _ : - [ ]`).
- **Logs keep no titles by default:** run history (last 10) and the helper's log folder (`~/Library/Logs/tidy-tabs`
  on macOS, `~/.local/state/tidy-tabs` on Linux) keep status, errors, timings, counts and group labels. Titles and
  hosts are stored only with **Debug logging** on. **Copy diagnostics** copies the last run in full from memory only.
- **Permissions:** `tabs`, `tabGroups`, `storage`, `nativeMessaging`, `notifications`, and host access to
  `http://localhost:11434` only (Ollama). Any other Ollama endpoint is an optional permission you grant when you click
  Save. The extension is disabled in incognito.

Full policy: [PRIVACY.md](PRIVACY.md).

### Troubleshooting

Start with the popup's red error panel, or `last-run.json` in the helper's log folder.

- **"The Claude helper isn't installed for this browser"**: run the installer above, then fully quit and reopen the
  browser.
- **"…installed, but not for this extension id"**: re-run the installer (it allows the store ID).
- **Badge `!` / "Browser ignored tab moves"**: `moves.results` shows, per strategy, which calls threw or were ignored.
- **"Claude unavailable → domain fallback found nothing to group; no changes made"**: the model failed, and no two
  websites had 2+ tabs each.

## Running this extension

1. Clone this repository.
2. Load the [`extension/`](extension/) directory in Chrome as an
   [unpacked extension](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked).
3. Run `./install.sh` from the clone (same options as the one-liner: `--claude`, `--node`, `--extension-id`), then
   fully restart the browser.

### Tests

```sh
npm install && npx playwright install chromium
npm run lint          # ESLint + Prettier (config modelled on GoogleChrome/chrome-extensions-samples)
npm run test:unit     # extension + helper unit tests (node --test; live tests skip)
npm run test:e2e      # real extension in Chromium + real helper installed by install.sh, fake claude CLI
TIDY_E2E_LIVE=1 node --test --test-name-pattern=LIVE tests/e2e/tidy.test.mjs   # real Claude (your subscription)
npm run package       # dist/: store zip (no tests, no key), native-host.tar.gz, installers
```

Live backend tests: `cd extension && TIDY_LIVE=1 node --test test/integration.test.js` (Ollama) and
`cd native-host && TIDY_CLAUDE_LIVE=1 node --test test/host-live.test.js` (Claude).

### Benchmark summary

`bench/RESULTS.md` has the full run: 3 runs each, cold and warm, the same inputs for both backends.

| | Claude Haiku (default) | Local VM (embeddings + qwen3:1.7b) |
|---|---|---|
| Groups by | task ("Vietnam trip", "Code review") | site/topic ("Azure Management") |
| Messy 55-tab window (tasks sharing hosts) | purity **0.96** | 0.36 (collapsed to 2 groups) |
| Clean 40-tab window | purity 1.00, ~8 s | purity 1.00, ~9 s (~5 s with 2 models loaded) |
| 120 tabs | ~13 s | ~12 s |

Haiku is the default because real windows mix tasks across the same sites. Use a local model when tabs must not
leave your network.

## License

MIT; see [LICENSE](LICENSE). Not affiliated with Anthropic, Google, or the makers of other browsers.
