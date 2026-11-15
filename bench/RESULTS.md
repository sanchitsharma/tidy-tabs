# Tidy Tabs backend bench: VM pipeline vs Claude Haiku

Run on 2026-11-15, 14:18–14:25 UTC. Everything ran sequentially and both backends got the same inputs.

- **VM:** `v2/tidy_service.py` (embeddinggemma, then silhouette k from 2..8, then qwen3:1.7b with naming v2). It ran in the foreground on `<VM_TAILSCALE_IP>:11500` and was stopped afterwards. It was not installed as a service.
- **Haiku:** the installed native host, called with the extension's own `buildPrompt`, `GROUPS_SCHEMA`, `buildNativeRequest` and `repairGroups`. That is **extension 0.2.3** (`core.js` sha1 `5bd336e67b`), which uses the task-oriented prompt with an `ungrouped` field. The single-pass path and the 120 s deadline match the extension.
- **Cold run:** on the VM, models were unloaded first (`keep_alive:0`). On Haiku, every call is a fresh CLI process.
- **Contention:** the Ollama log for the window shows only the VM itself (the service) and the Mac (unload and `ps` calls). There were no foreign clients.

## Comparison (median of 3, cold run 1 in parentheses)

| Backend | Dataset | Valid | Purity | Cohesion | Groups | 1-tab groups | Wall s | Breakdown |
|---|---|---|---|---|---|---|---|---|
| VM | vm-8 | 3/3 | 1.00 | 1.00 | 3 | 0 | 5.6 (5.9) | embed 1.4 (load 1.1) + name 4.1 (load 1.8) |
| Haiku | vm-8 | 3/3 | 1.00 | 1.00 | 3 | 0 | **3.6** (6.3) | API 2.1 + CLI 1.4 |
| VM | vm-40 | 3/3 | 1.00 | **1.00** | 8 | 1 | 9.2 (9.2) | embed 2.4 + name 6.6 |
| Haiku | vm-40 | 3/3 | 1.00 | 0.95 | 8 | 0 | **8.2** (8.0) | API 7.0 + CLI 1.1 |
| VM | vm-120 | 3/3 | 1.00 | **1.00** | 7 | 0 | **12.1** (11.4) | embed 5.5 + name 6.3 |
| Haiku | vm-120 | 3/3 | 1.00 | 0.94 | 8 | 0 | 12.9 (14.4) | API 11.8 + CLI 1.0 |
| VM | haiku-40 | 3/3 | 0.97 | 0.95 | 7 | 0 | 8.9 (8.5) | embed 2.4 + name 6.2 |
| Haiku | haiku-40 | 3/3 | **1.00** | 0.95 (0.84 in run 2) | 8 | 0 | **7.7** (8.5) | API 6.6 + CLI 1.1 |
| VM | sample-10 | 3/3 | – | – | 2 | 1 | **4.3** (4.3) | embed 1.4 + name 2.8 |
| Haiku | sample-10 | 3/3 | – | – | 2–3 | 0 | 7.0 (7.0) | API 5.9 + CLI 1.0 |
| VM | **messy-55** | 3/3 | **0.36** | 0.94 | **2** | 0 | 7.0 (7.0) | embed 3.0 + name 3.8 |
| Haiku | **messy-55** | 3/3 | **0.96** | 0.88 | 8 | 0 | 11.3 (11.3) | API 10.0 + CLI 1.3 |
| VM, MAX_LOADED=2 | vm-40 | 3/3 | 1.00 | 1.00 | 8 | 1 | **5.2** (8.9) | embed 1.4 (load 0) + name 3.6 (load 0) |
| VM, MAX_LOADED=2 | vm-120 | 3/3 | 1.00 | 1.00 | 7 | 0 | **7.5** (11.4) | embed 4.1 + name 3.0 |

Every run was valid on both backends. The VM was deterministic: all 3 runs were identical. Haiku's `repairGroups` folds single-tab groups into "Other" by design, so its 1-tab count is always 0.
The per-run group lists are in `runs/*.json`.

## Group names (median run)

| Dataset | VM | Haiku |
|---|---|---|
| vm-40 | Code Review & CI/CD · Travel & Tourism · Cloud & Infrastructure · Video & Music · Email & Messaging · Python & Development · News & Entertainment · Misc | Vietnam trip · Tidytabs extension · Code review · Python research · Cloud infrastructure · Email and meetings · Music listening · Other |
| vm-120 | GitHub Extensions · Azure Management · Gmail and News · Booking and Travel · YouTube Music · "Python Documentation and" · Misc | Vietnam trip · Extension PRs · API code review · Cloud infrastructure · Email triage · Python research · Music and videos · Other |
| haiku-40 | Calendar & Email · Vietnam Travel · Cloud Infrastructure (+1 PR) · Python Development · GitHub Reviews · Music & Streaming · Misc | Token refresh fix · Code review · Async Python study · Vietnam trip · Inbox and calendar · Focus music · Cloud infrastructure · Other |
| sample-10 | **Browser Extension Setup (9) · Misc (the GitHub release)**, which is the ideal | Extension setup (7–8) · Extension development (2–3: Page Edit, the release, sometimes octotree). One run split into 3 groups. |

Haiku's lower cohesion on the synthetic sets comes from splitting GitHub into "Tidytabs extension" and "acme API review". That is a real task split, which the labels don't capture. VM names describe sites and categories ("Azure Management", "GitHub Extensions"). Haiku names describe tasks.

## Messy set (55 tabs, 6 tasks and 5 vague strays, overlapping hosts)

The fixture is in `fixtures/messy-55.json`. Docs, Sheets, GitHub, YouTube, Reddit, LinkedIn, Amazon and NYTimes tabs each appear in 2–3 different tasks.

- **VM: collapses.** Silhouette picks k=2: "Web Development" (46 tabs, 7 topics) and "Web Security & Auth" (9). I swept k offline (`vm_kdiag.py`):
  - No k fixes it. At k=8, purity is 0.76 with one 24-tab blob plus 3 singletons. At k=12, purity is 0.88 but cohesion drops to 0.74.
  - The `host | title` embeddings don't separate tasks that share hosts and vocabulary. This is a representation limit, not a k-selection bug.
- **Haiku: near task-perfect.** Purity is 0.96–0.98 and the groups are Japan trip (10/10), Refresh token fix (9–10/10), Backend hiring, Standing desk shopping (8/8), Tax filing and Reading.
  - It kept "Flights" with the trip, "best standing desk" with shopping and "HRA" with taxes, all three on google.com, and it placed each Docs/Sheets tab by its task.
  - "Other" caught all 5 vague strays, plus "Dashboard", "Hacker News" and levels.fyi.

## MAX_LOADED_MODELS=2

Warm runs drop from 9.2 to 5.2 s (−43%) on tabs-40 and from 12.1 to 7.5 s (−38%) on tabs-120. The model swap is gone, and the naming call also got faster (6.5 → 3.3 s). Cold runs don't change. Both models fit with about 2.6 GB of RSS.
The setting was then reverted. The override file is byte-identical to the original, `systemctl show` reports `OLLAMA_MAX_LOADED_MODELS=1`, and the service listens on `<VM_TAILSCALE_IP>:11434` only.

## Recommendation

- **Keep Haiku as the default.** It is the only backend that groups by *task* rather than by site or topic. Real windows are mixed tasks on shared hosts, and the VM scored 0.36 there. Latency is a wash at 40 tabs (8 s each) and Haiku is about 1 s slower at 120.
- **Use the VM only when tabs must not leave your network.** Examples are confidential client work, or Claude being down or rate-limited. Use it for windows that hold a few distinct topics rather than interleaved tasks. If you adopt it, set `MAX_LOADED_MODELS=2` (5–7.5 s).
- **A "VM (private)" backend in the extension: yes, but as an opt-in fallback, not the default.**
  - Label it honestly, for example "groups by topic/site".
  - Port the clustering to JS and call Ollama directly, per the v2 contract. That avoids a new VM process.
  - Guard against collapse: if silhouette is below 0.25 or the largest group holds more than 60% of tabs, fall back to domain grouping or say "low confidence".
  - Don't sink more time into improving the embedding path. The messy set shows its ceiling.

## Files

- `bench.mjs`, `metrics.mjs`, `report.mjs`, `prepare.mjs`, `vm_kdiag.py`
- `datasets/`, `fixtures/`, `runs/`
- `snapshot/`: the extension `core.js` and `claude-native.js` as they were at run time
- VM copy (on the VM): `~/tidy-tabs-llm/v3/` holds `service.log`, `override.conf.orig`, `runs/` and this file
