# Chrome Web Store submission kit: Tidy Tabs AI

Developer dashboard item: `ponmidmoanddncagjfeegheonbgpeahe`
(<https://chrome.google.com/webstore/devconsole/4ab0c2ff-f14f-411e-90bb-8cae2b9dd710/ponmidmoanddncagjfeegheonbgpeahe/edit>).
Upload file: `dist/tidy-tabs-ai-<version>.zip` from `npm run package`.

---

## Tab: Store listing

**Name / Summary:** from the manifest (`Tidy Tabs AI`; summary = manifest description, ≤132 chars).

**Description:**

```
Tidy Tabs AI groups the tabs in your window by the task you're working on, then turns each task into a named, colored tab group with related tabs side by side.

HOW IT WORKS
• Click the toolbar icon and "Tidy now", or press Alt+Shift+T
• An AI model reads each tab's title and website and groups them by task ("Lisbon trip", "Python asyncio"), not just by website
• Tabs are reordered and grouped; tabs that don't belong anywhere are left alone
• Tidy again any time: it reuses its own groups and never renames yours

CHOOSE YOUR MODEL
• Claude (default), through Claude Code on your computer, using your own Claude subscription: Haiku, Sonnet, Opus or any model ID. No API key. Needs a small helper, installed once with one command on macOS or Linux: https://sanchitsharma.github.io/tidy-tabs/setup.html
• Ollama: a local model, or your own server
• Gemini Nano: Chrome's built-in model, where available
Without any model, it groups tabs by website.

PRIVACY
Only each tab's title (up to 80 characters) and hostname are sent, and only to the model you choose, when you start a tidy. No server of ours, no analytics, no tracking.
Privacy policy: https://sanchitsharma.github.io/tidy-tabs/privacy.html

OPEN SOURCE
https://github.com/sanchitsharma/tidy-tabs

Tidy Tabs AI is an independent project and is not affiliated with Anthropic or Google.
```

**Category:** `Tools` (Productivity) · **Language:** `English`

**Graphic assets** (`store/build/`): store icon `extension/icons/icon128.png`; screenshots in order
`screenshot-1-hero.png`, `screenshot-2-popup.png`, `screenshot-3-models-privacy.png`; small promo tile
`promo-small-440x280.png`; marquee: none.

**Homepage URL:** `https://sanchitsharma.github.io/tidy-tabs/` · **Support URL:**
`https://github.com/sanchitsharma/tidy-tabs/issues` · **Mature content:** No

---

## Tab: Privacy

**Single purpose description:**

```
Tidy Tabs AI has one purpose: organizing the tabs in the current browser window into named tab groups by task. When the user starts a tidy, it sends each tab's title and hostname to the AI model the user has chosen (Claude via the user's own Claude Code, a local or self-hosted Ollama model, or Chrome's built-in Gemini Nano), then reorders the tabs and creates one tab group per task.
```

**tabs:**

```
Reads the title and URL of the tabs in the window being tidied, so they can be grouped by task (only the title and hostname are sent to the user's chosen model), and moves tabs so each group's tabs sit next to each other.
```

**tabGroups:**

```
Creates, names and colors one tab group per task (optionally collapsed), and finds the groups it created earlier so tidying again reuses them instead of adding duplicates. The user's own groups are never renamed.
```

**storage:**

```
Stores the user's settings (model choice, Ollama endpoint, options) in chrome.storage.sync, a short history of recent runs (status, counts, group names; no tab titles unless the user enables debug logging) in chrome.storage.local, and the last run's full diagnostics in memory-only chrome.storage.session for the "Copy diagnostics" button.
```

**notifications:**

```
Shows a notification when a tidy run had to fall back (the model failed) or tabs could not be reordered, so the user knows the result without opening the popup. It can be turned off in Options.
```

**nativeMessaging:**

```
Talks to the optional Tidy Tabs AI helper that the user installs on their own computer (macOS or Linux, documented at https://sanchitsharma.github.io/tidy-tabs/setup.html). The helper runs the user's own Claude Code CLI to group tab titles with the Claude model the user picked, and writes run logs to a local folder. The extension works without it (Ollama, Gemini Nano, or grouping by website).
```

**Host permission justification:**

```
http://localhost:11434/* is the default address of a local Ollama server, used only when the user picks the Ollama backend. Access to any other address is an optional permission requested at runtime only when the user saves a custom Ollama endpoint in Options. The extension has no content scripts and never reads or modifies web pages.
```

**Remote code:** No (if asked).

**Data usage:** tick **Web history** only (titles and hostnames of the open tabs being tidied, sent to the user's chosen
model; the Chrome Web Store definition of web history includes page titles). Website content is not collected (page
content is never read). Then tick all three certifications (the transfer to the user's chosen model provider is the
user-facing feature itself).

**Privacy policy URL:** `https://sanchitsharma.github.io/tidy-tabs/privacy.html`

---

## Tab: Distribution

Free · Public · All regions.

---

## Tab: Test instructions (Additional instructions)

```
No account is needed to review the basic flow. The Claude backend needs Claude Code plus a helper installed on macOS or Linux, so reviewers will most likely test without it:
1. Install the extension and open about 8 tabs where at least two websites have two or more tabs each (e.g. two Wikipedia articles, two GitHub pages, plus a few others).
2. Click the toolbar icon. Because the Claude helper isn't installed, the popup shows "Set up the Claude helper" with the one-line install command and a setup guide link.
3. Press "Tidy now": the model is unavailable, so tabs are grouped by website into named tab groups, with an explanation in the popup.
4. To see AI grouping without Claude: Options → Backend → Gemini Nano (Chrome with built-in AI enabled) or Ollama (with a local Ollama server), Save, then Tidy now.
Full Claude setup (optional): https://sanchitsharma.github.io/tidy-tabs/setup.html
```
