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

YOUR OWN PROMPT
Rewrite the grouping instructions in Options, e.g. "Keep work and personal tabs apart" or "Label groups in Spanish", and set how many groups you want (about 1 per N tabs, and a maximum). Preview the full prompt, or reset to the default any time.

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
Required to read tab.title and tab.url. The extension's single purpose is grouping the tabs of the current window by task: it calls chrome.tabs.query for that window and reads the title and URL of every tab (Chrome only fills in these two fields when the tabs permission is granted; the extension has no host permissions for websites). Only the title and hostname are sent to the user's chosen model. Without this permission every tab comes back without a title or URL and nothing can be grouped. activeTab would only cover one tab, and host access to all sites would be broader. Tabs are then moved with chrome.tabs.move so each group's tabs sit together.
```

**tabGroups:**

```
Creates, names and colors one tab group per task (optionally collapsed), and finds the groups it created earlier so tidying again reuses them instead of adding duplicates. The user's own groups are never renamed.
```

**storage:**

```
Stores the user's settings (model choice, Ollama endpoint, optional custom grouping instructions, options) in chrome.storage.sync, a short history of recent runs (status, counts, group names; no tab titles unless the user enables debug logging) in chrome.storage.local, and the last run's full diagnostics in memory-only chrome.storage.session for the "Copy diagnostics" button.
```

**notifications:**

```
Shows a notification when a tidy run had to fall back (the model failed) or tabs could not be reordered, so the user knows the result without opening the popup. It can be turned off in Options.
```

**nativeMessaging:**

```
Talks to the optional Tidy Tabs AI helper that the user installs on their own computer (macOS or Linux, documented at https://sanchitsharma.github.io/tidy-tabs/setup.html). The helper runs the user's own Claude Code CLI to group tab titles with the Claude model the user picked, and, only if the user turns on "Save run logs to a file", writes run logs to a local folder. The extension works without it (Ollama, Gemini Nano, or grouping by website).
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

Max 500 characters.

```
No account needed. Claude needs a local helper (macOS/Linux), so test without it:
1. Open ~8 tabs where 2+ sites have 2+ tabs each (e.g. 2 Wikipedia, 2 GitHub pages).
2. Click the toolbar icon: the popup shows "Set up the Claude helper" with the install command.
3. Press "Tidy now": tabs are grouped by website into named tab groups.
4. AI grouping without Claude: Options > Backend > Gemini Nano or Ollama, Save, Tidy now.
Setup: https://sanchitsharma.github.io/tidy-tabs/setup.html
```
