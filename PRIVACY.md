# Tidy Tabs AI privacy policy

_Last updated: 22 November 2026_

Tidy Tabs AI groups the tabs in your browser window by task. The developer runs no server and receives no data from
the extension. This page explains exactly what the extension reads, where it sends it, and what it keeps.

## What the extension reads

When you click **Tidy now** (or press the shortcut), it reads the **title and web address** of each tab in that
window, so it can group and reorder them. Browser-internal pages (`chrome://`, extension pages and similar) are
skipped. It does not read page content, form data, cookies, passwords or your browsing history.

## What is sent, and where

Only each tab's **title (cut to 80 characters) and hostname** (for example `docs.python.org`) are sent, never the full
web address or page content. Where they go depends on the backend you choose in Options:

- **Claude (default):** sent to the small helper program on your own computer, which passes them to the Claude Code
  CLI you installed. Claude Code sends them to **Anthropic** under **your own Claude account** to get the grouping
  back, subject to Anthropic's terms and privacy policy. The developer of Tidy Tabs AI never sees them.
- **Ollama:** sent only to the Ollama address you configure (by default `http://localhost:11434` on your computer).
- **Gemini Nano:** processed by Chrome's built-in model on your device.

Nothing is sent until you start a tidy.

## What is stored

- **Settings** (backend, model, options) in `chrome.storage.sync`. If you use Chrome Sync, Chrome syncs them between
  your own browsers.
- **Run history** (last 10 runs) in `chrome.storage.local` on your device: status, errors, timings, counts and group
  names. Tab titles and hosts are stored only if you turn on **Debug logging**.
- **The full last run** (including the titles sent and the model's answer) in memory only (`chrome.storage.session`),
  for the **Copy diagnostics** button. It is cleared when the browser closes.
- **Log files**, if the Claude helper is installed, in a folder on your computer (`~/Library/Logs/tidy-tabs` on
  macOS, `~/.local/state/tidy-tabs` on Linux), with the same content rules as run history.

## What the extension does not do

- No analytics, tracking, advertising or third-party code; no data is sold or shared.
- No remote code: all code ships in the extension package.
- It is disabled in incognito windows.

Removing the extension deletes its settings and run history. The helper's uninstaller removes the helper; its log
folder can be deleted by hand.

## Contact

Questions or problems: open an issue at <https://github.com/sanchitsharma/tidy-tabs/issues>.
