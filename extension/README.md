# Tidy Tabs extension

The Manifest V3 extension. Setup, architecture, privacy notes and tests are in the
[top-level README](../README.md).

- `background.js`: service worker (triggers, badge, run history, native log)
- `popup.*`, `options.*`: UI
- `lib/`: clustering (`core.js`, `strategies.js`, `two-pass.js`), backends (`backends.js`,
  `claude-native.js`, `ollama-request.js`), moves and verification (`move-strategies.js`), tab groups
  (`tab-groups.js`), diagnostics and privacy redaction (`diagnostics.js`), the run orchestrator
  (`tidy-run.js`)
- `test/`: `node --test` (unit); live tests are gated behind `TIDY_LIVE=1`
