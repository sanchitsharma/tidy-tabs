# Tidy Tabs

A Chrome extension (Manifest V3, plain JS, no build step) that tidies the current window. It groups
your tabs by the **task you're in the middle of**, puts related tabs next to each other, and turns each
group into a named, colored tab group. It's a take on Arc's "Tidy Tabs" for browsers that still have
tab groups.

By default the grouping runs on **Claude Haiku through your own Claude subscription**, using the Claude
Code CLI already on your Mac. There's no API key and no server of ours. A local Ollama model is an
optional alternative.

## Architecture

```
extension (service worker)
   │  chrome.runtime.sendNativeMessage("dev.tidytabs.claude", {type:"chat", system, user, schema})
   ▼
native host (node, ~/Library/Application Support/tidy-tabs/native-host/)
   │  claude -p --model=haiku --output-format json --json-schema … (tools off, MCP off, safe mode)
   ▼
Claude Haiku (your Claude subscription)  →  {groups:[{label, tabIds}], ungrouped:[…]}
```

- **Backends:** Claude Haiku (default), Ollama (`http://localhost:11434` by default, or any endpoint you
  grant at Save), or Chrome's built-in Gemini Nano where available. If the backend fails, it falls back
  to grouping by domain, and only when that finds at least 2 real groups.
- **Strategies:** single-pass for Claude, where one call returns the groups. Two-pass for small local
  models: first propose labels, then assign every tab against a per-run enum schema.
- **Safety net on every path:**
  - Unknown or duplicate ids are dropped. Single-tab groups and leftovers go to "Other", which is never
    made a tab group.
  - Labels are capped at 40 chars and there are at most 8 groups.
  - Browser-internal pages (`chrome://`, `chrome-extension://`) are never grouped. Tabs parked by a
    suspender extension (Tab Suspender, Marvellous Suspender, …) are grouped by their real URL.
- **Moves are verified:** after reordering, the extension re-reads the window and compares it with the
  plan, retrying once with a single array move. The popup shows exactly what happened.
- **Tab groups are reused:** re-tidying keeps or renames the groups the extension created earlier
  rather than piling up duplicates. Your own groups are never renamed.

Layout: `extension/` (the MV3 extension), `native-host/` (the messaging host and its tests), `bench/`
(the backend benchmark), `vm-setup/` (the optional private Ollama VM guide), `install.sh` /
`uninstall.sh`.

## Install (macOS)

Requirements: Node 20+, and the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
installed and logged in to your Claude subscription (run `claude` once interactively).

1. Run `./install.sh`. It finds absolute paths to `claude` and `node`, copies the host to
   `~/Library/Application Support/tidy-tabs/native-host/` (macOS privacy rules block browser-spawned
   helpers from reading `~/Documents`), and writes the `dev.tidytabs.claude.json` host manifest for each
   browser it finds: Chrome, Dia, Phi (`com.phibrowser.Mac`) and Chromium. Pass `--claude` / `--node`
   to override the detected paths.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick
   `extension/`. The extension ID is fixed by the `key` in `manifest.json`, so the host manifest's
   `allowed_origins` matches.
3. **Fully quit and restart** the browser so it picks up the host manifest.
4. Click the toolbar icon, then **Tidy now**. **Alt+Shift+T** tidies without opening the popup.

To remove it, run `./uninstall.sh`. It deletes only our host manifests and the runtime copy, and keeps
your logs.

**Supported browsers:** Chrome, Dia, Phi, Chromium, and other Chromium browsers if you add their
`NativeMessagingHosts` dir to `install.sh`. **Arc is not supported:** its tab moves and tab-group APIs
don't work for extensions, and Arc is being discontinued.

## Privacy and security

- **What leaves your machine:** each tab's **title and hostname** (not the full URL or page content)
  go to Anthropic through your Claude Code CLI, under your own account and terms. With Ollama they go
  only to the endpoint you configure.
- **Claude is sandboxed:** `claude -p` runs with all tools disabled (`--tools ''`), no MCP servers,
  `--safe-mode` (no CLAUDE.md, hooks, plugins or skills), no settings sources, no session persistence,
  and in an empty temp dir. The host strips `ANTHROPIC_API_KEY`, so your subscription login is used.
  The model name is validated and must start with a letter or digit.
- **Logs keep no titles by default:** run history (the last 10 runs) and the disk log
  (`~/Library/Logs/tidy-tabs/last-run.json`, plus `runs.jsonl` rotated at about 1 MB) keep status,
  errors, timings, counts, backend, move results and group labels with sizes. Tab titles and hosts are
  stored only if you turn on **Debug logging** in Options. The wrapper's `host-*.log` files are capped.
- **Copy diagnostics** (popup) copies the last run in full: the exact prompt sent to the model, its raw
  answer, and which kinds of tabs were skipped (`scheme://host` counts). That full copy lives only in
  memory (`storage.session`) and never goes to disk unless Debug logging is on.
- **Permissions:** `tabs`, `tabGroups`, `storage`, `nativeMessaging`, `notifications`, and host access
  to `http://localhost:11434` only. Any other Ollama endpoint is an optional permission you grant when
  you click Save. The extension is disabled in incognito.

## Options

Backend (`claude-haiku` / `ollama` / `gemini-nano`), Claude model (`haiku`), Ollama endpoint and model,
strategy (`auto`), whole-run timeout (120 s), tab groups (on), collapse groups (off), debug logging
(off), notifications (on).

## Troubleshooting

Start with the popup's red error panel, or `~/Library/Logs/tidy-tabs/last-run.json`.

- **"Specified native messaging host not found"**: the popup shows "Helper not registered for this
  browser". Run `./install.sh` (add your browser's Application Support dir if it's missing), then fully
  quit and restart the browser.
- **Badge `!` / "Browser ignored tab moves"**: `moves.results` shows, per strategy, which calls threw,
  which were silently ignored, and the `onMoved` events.
- **"Claude unavailable → domain fallback found nothing to group; no changes made"**: the backend
  failed, and no two domains had 2+ tabs each.
- **No log file**: the popup says "diagnostics file NOT written"; fix the host install as above.

## Tests

```
cd extension && node --test       # unit tests (fetch stubbed); live Ollama tests skip unless TIDY_LIVE=1
TIDY_LIVE=1 TIDY_OLLAMA_URL=http://localhost:11434 node --test test/integration.test.js test/integration-two-pass.test.js

cd native-host && node --test     # framing, claude args/env/result mapping, fake-claude end-to-end, log files
TIDY_CLAUDE_LIVE=1 node --test test/host-live.test.js   # real Haiku via the installed host (uses your subscription)
```

Development: after changing `native-host/*.js`, re-run `./install.sh`. After changing the extension, run
`./bump.sh`, and the open popup reloads itself in unpacked dev installs.

## Benchmark summary

`bench/RESULTS.md` has the full run: 3 runs each, cold and warm, the same inputs for both backends.

| | Claude Haiku (default) | Local VM (embeddings + qwen3:1.7b) |
|---|---|---|
| Groups by | task ("Vietnam trip", "Code review") | site/topic ("Azure Management") |
| Messy 55-tab window (tasks sharing hosts) | purity **0.96** | 0.36 (collapsed to 2 groups) |
| Clean 40-tab window | purity 1.00, ~8 s | purity 1.00, ~9 s (~5 s with 2 models loaded) |
| 120 tabs | ~13 s | ~12 s |

Haiku is the default because real windows mix tasks across the same sites. Use the local backend when
tabs must not leave your network.

## License

MIT; see [LICENSE](LICENSE).
