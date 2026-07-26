# app-usagemonitor

Local-only proof of concept for comparing provider-reported coding-agent quota with usage reconstructed at standard API prices from local logs.

This is an experiment harness, not another quota dashboard. It records privacy-minimized snapshots, preserves pricing warnings, and estimates a quota capacity only when the observations identify one.

## Current multi-surface and account-aware outcome

The monitor now combines replay-safe local rollout receipts with read-only Codex app-server accounting and privacy-minimized observations from the authenticated **Codex and Work Analytics** page.

The living [coverage gaps register](./2026-07-24-coverage-gaps-register.md) separately tracks unobserved shared-pool surfaces such as ChatGPT Work, Workspace Agents, ChatGPT for Excel, Codex Cloud, other Codex devices, Work Voice task activity, image generation, third-party authenticated apps, and Claude clients. Ordinary Chat conversations and ordinary Chat Voice are explicitly excluded from the Codex/Work shared agentic pool; Spark is tracked as a separate limit.

The log-derived [monitoring quality report](./2026-07-24-monitoring-quality-report.html) and its [source notes](./2026-07-24-monitoring-quality-source-notes.md) add an operational observability layer. The new `quality` command measures collector/app-server freshness, fixed-reset jitter versus moving reset families, integer-display censoring, regressions, account/plan/speed/snapshot-age coverage, and parser loss. It emits owner-only JSON plus a dated Markdown diagnostic rather than silently fitting weak intervals.

The [seven-day calibration report](./2026-07-24-weekly-7-day-calibration-report.html) and [source notes](./2026-07-24-weekly-7-day-calibration-source-notes.md) provide the predictive and reset-level view. The `calibrate-weekly` command selects among Standard and speed-aware API-price ledgers using an earlier-70%/later-30% chronological split, then tests lag, forecast, regime, and within-reset update candidates without look-ahead. Fourteen stable windows imply a median $1,878.75 API-price-equivalent seven-day value and a central 80% reset-to-reset range of $1,640.96–$2,280.38. Conservative captured-speed weighting reduces pooled holdout MAE from 2.25 to 2.16 displayed percentage points (4.1%); the no-look-ahead prior-reset error is 3.95 points and 80% of individual errors are bounded explicitly in the report. All 5–60 point online updates and 5–60 second display-lag corrections are currently rejected because they worsen untouched later-period prediction. These are behavioral calibration values, not a provider-published allowance or cash entitlement.

- The retained May 17–July 24 interval contains 2,366 classified rollouts, 295,681 request-like usage events, 55.68B tokens, and $51,671.51 at Standard OpenAI API-price-equivalent rates. Another 585,778 fork-replay events are excluded.
- Codex task surfaces are explicit: 33 scheduled-task rollouts contribute 673 usage events and 44.58M tokens; 1,821 subagent rollouts contribute 58,948 events and 7.09B tokens. Provider-side Cloud or Work activity without a local rollout remains unallocated.
- The current pseudonymous account reports 37.06B lifetime tokens. The account-unattributed local/current-account lifetime ratio is 1.502, which rejects treating the whole local corpus as one current-account history under equal token semantics. The user's known account switching is a likely candidate, but historical metric differences or residual duplication remain possible.
- On matched provider days, the unmatched-scope local/provider coverage diagnostic is 1.765x for May 29–July 8, 0.901x for July 9–15, and 0.924x for July 16–24. The post–July 9 agreement is much better, but July 9 remains a plausible boundary rather than a proven accounting-effective date.
- The visible provider page explicitly says Work and Codex share one usage limit and exposes coarse Desktop, CLI, Extension, Cloud, Mobile, Code review, Desktop App, Web, and Exec categories. It does not expose a Work-only allocation. A 1,569-turn gap between its model and surface totals is retained as unclassified, not relabeled as Work.
- The original conditional weekly ballpark remains $1.9k–$2.3k in Standard-API-equivalent / tier-weighted units. It is still not the actual weekly allowance because the older history cannot be partitioned by account and all shared-pool activity is not observable at per-turn precision.

The current provider `planType: pro` field does not distinguish the $100 5x and $200 20x variants. The owner-only plan timeline records the user's normal 20x state only from the July 24 account registration onward and keeps the brief 5x episode unresolved until its approximate dates and account alias are known. Earlier rows remain `unknown` rather than inheriting today's plan.

OpenAI's April 9 release note described the newly launched $100 option as temporarily up to 10x, increased from its normal 5x level; current pricing again lists $100 as 5x and $200 as 20x. The monitor therefore models `pro-5x` and `pro-10x-promo` separately and will not guess which applied to the unresolved episode.

## Current v0.3 outcome

The seven evidence gates are implemented. The live result is deliberately **non-identifiable**, not a guessed weekly limit:

- 20,195 fixed-window request-like usage events are fully priced at standard OpenAI API rates after 35,181 fork-history replay exclusions;
- 284 displayed-percentage transitions and 19,977 adjacent snapshot intervals are retained;
- the provisional robust statistic is `$1,886.70`, but exact constraints conflict, held-out error is 1.918 percentage points, and control state is unknown, so it is not reported as a capacity estimate;
- two bounded Terra pilots completed but each was contaminated by separate Sol activity;
- all 19,979 contamination intervals remain unknown, with zero strict controlled references;
- 17,552 relevant client tool observations contain zero matching provider-billed units, so no separate API tool price or incremental quota effect is inferred; and
- one append-only correction removes 71,060,499 replayed unknown-model tokens from the effective legacy baseline while preserving the original observation byte-for-byte.

Codex token-count records do not expose a per-request API service tier or Fast-mode marker. Parser `0.3.2` now joins the nearest preceding privacy-safe `thread_settings_applied.service_tier` event within the same rollout. The local protocol persists subscription Standard as `default` and the current Fast UI tier as `priority`; these normalize to `codexSpeedMode` without treating Fast as API Priority. Events before a setting, after a clear, or without a defensible join remain `unknown`.

[Codex Fast mode](https://developers.openai.com/codex/speed) and API Priority processing are separate mechanisms. For ChatGPT-authenticated Codex, the official Fast-mode schedule is 2.5 times Standard credit consumption for GPT-5.6/GPT-5.5 and 2 times for GPT-5.4, while preserving standard API-priced USD as the base comparison series. API Standard, Priority, Flex, and Batch remain explicit taxonomy values, but this subscription monitor does not apply a non-Standard API price unless a future API-billed event actually exposes its billing surface and tier. Historical rows with no observed speed mode remain `unknown` and receive Standard/Fast sensitivity views rather than an imputed multiplier.

The retained June 11–July 23 rollout history contains 1,743 Standard/default and 89 Fast/priority setting events. The parser persists only canonical mode, safe raw classification, source, and timestamp—never thread IDs or log bodies. This is a session-setting timeline, not exact per-turn tier attribution; omitted settings leave prior state unchanged and an explicit clear returns attribution to `unknown`.

New passive-collector records carry the same timestamp-safe, privacy-minimized tier semantics. Direct captures summarize tier coverage across their local usage events: only an all-Standard or all-Fast window receives a known mode; mixed or incomplete windows remain `unknown`. Neither path claims an API service tier for ChatGPT-subscription usage.

The compact historical diagnostic prices 222,525 usage events and 4,177 weekly-window transitions. Fourteen reset groups meet descriptive quality thresholds. Their median Standard API-price-equivalent slope is `$1,890.63`, with a central 80% reset-to-reset spread of `$1,724.09–$2,286.48`. The last three usable groups imply a conditional `$1,871.18` Standard-only ballpark or `$1,892.15–$2,327.06` under captured/unknown tier sensitivity. This is not an identified allowance: all 4,177 transitions have unknown control state and missing shared-pool activity is unbounded.

The missing evidence is a repeated, uncontaminated panel spanning multiple displayed transitions and more than one reset window, with provider-unit telemetry for any hosted tool being tested.

The complete live-tested quota adapter is currently Codex. Claude Code exposes the required plan-limit fields through its official [status-line input](https://code.claude.com/docs/en/statusline) and has compatible local usage logs. On 2026-07-23, the Keychain-backed Claude.ai Pro OAuth completed a live one-turn smoke and returned `usage.service_tier: standard`, `usage.speed: standard`, and `fast_mode_state: off`. By the 2026-07-25 managed-callback test, that OAuth grant had been revoked: the provider returned 401 before a response could expose non-null five-hour/seven-day windows. The local usage adapter is verified, but the authoritative quota smoke therefore remains authentication-blocked until `/login` is completed.

`src/claude-statusline.js` is a privacy-minimized status-line tap whose quota snapshots can now be explicitly included in a local export set. Its owner-only ledger stores the exact capture time, recognized model/version, Fast-mode state, a secret-derived session pseudonym, and independently present five-hour/seven-day percentages and reset times. These exact timestamps and pseudonyms are restricted local-review metadata pending the preregistered minimization decision. It deliberately drops raw session IDs, transcript paths, working directories, and content. The installer provisions a distinct 32-byte Claude-session pseudonym capability in macOS Keychain; the callback retrieves it directly in-process and never carries it in settings, environment variables, arguments, or shell text. Windowless pre-response records are ignored by export, while a record containing a quota window but no session pseudonym fails closed rather than being pooled across unknown accounts.

The callback lifecycle is local-only and preserves an existing supported Claude status line. Because Claude accepts one `statusLine` object, installation supports either no existing value or the exact documented `{ "type": "command", "command": "..." }` shape. The managed runner streams the complete input to that command with backpressure while retaining at most 64 KiB for the private collector, reproduces bounded existing output even when monitor capture fails, and stores the prior object only in owner-only recovery state for exact uninstall restoration. Other shapes fail preflight without changing settings or creating a credential. Installation, inspection, recovery, rotation, uninstall, and permanent capability removal perform no network activity. Uninstall deliberately retains the Keychain capability; permanent removal is a separate target-bound two-step operation and does not claim secure erasure.

## Quick start

The legacy monitoring commands require Node.js 20 or newer and an authenticated Codex CLI/app installation. The SQLite-backed `export-set` path is release-qualified only on Node.js 24.14.0 and 26.2.0.

```bash
pnpm install --ignore-workspace
pnpm --ignore-workspace doctor
pnpm --ignore-workspace capture --label baseline --controlled
# Run a declared Codex workload, with other shared-pool activity paused.
pnpm --ignore-workspace capture --label after-task --controlled
pnpm --ignore-workspace report # descriptive snapshot summary; never reports a capacity
# Mine a fixed historical interval reproducibly.
pnpm --ignore-workspace transitions --since 2026-07-21T17:06:03.000Z --until 2026-07-23T16:15:40.974Z --offline
pnpm --ignore-workspace infer
# Mine weekly history without storing all adjacent snapshots, then diagnose reset-to-reset movement.
pnpm --ignore-workspace transitions --since 2026-06-11T00:00:00.000Z --until 2026-07-23T23:59:59.000Z --offline --compact --window-minutes 10080 --output .usage-monitor/transitions-history-2026-06-11-to-2026-07-23-v0.3.2.json
pnpm --ignore-workspace history --input .usage-monitor/transitions-history-2026-06-11-to-2026-07-23-v0.3.2.json
# Select the best accounting basis on chronological holdout data and emit reset-by-reset seven-day values.
pnpm --ignore-workspace calibrate:weekly -- --input .usage-monitor/transitions-history-2026-06-11-to-2026-07-23-v0.3.2.json
# Mark a bounded unlogged surface or quiet period without storing content or URLs.
pnpm --ignore-workspace mark:activity -- --surface chatgpt_web --state start
pnpm --ignore-workspace mark:activity -- --surface chatgpt_web --state end
pnpm --ignore-workspace collect-once
# Inspect or install the privacy-minimized Claude status-line callback.
node ./src/cli.js inspect-claude-callback
node ./src/cli.js install-claude-callback
# Recovery is idempotent after an interrupted settings update.
node ./src/cli.js recover-claude-callback
# Rotation changes only future Claude session pseudonyms and requires confirmation.
node ./src/cli.js rotate-claude-callback-identity
node ./src/cli.js rotate-claude-callback-identity --confirm
# Uninstall restores the previous status line exactly and retains the capability.
node ./src/cli.js uninstall-claude-callback
# Permanent removal is a separate two-step action valid only after uninstall.
node ./src/cli.js remove-claude-callback-identity
node ./src/cli.js remove-claude-callback-identity --confirm-removal TOKEN_FROM_PREFLIGHT
# Profile monitorability from a full-grain transition dataset and the passive ledger.
pnpm --ignore-workspace quality -- --input .usage-monitor/transitions-simple-current-2026-07-24-v0.3.2.json
# Reuse the cached replay-safe history for a fast provider/account crosscheck.
# On supported macOS arm64 systems, account scoping uses its dedicated Keychain item automatically.
node ./src/cli.js crosscheck \
  --since 2026-05-17T00:00:00.000Z \
  --until 2026-07-24T04:15:00.000Z \
  --input .usage-monitor/local-history-v0.1.json \
  --plan-timeline .usage-monitor/account-plan-timeline-v0.1.json \
  --provider-ui .usage-monitor/provider-ui-observations-v0.1.jsonl
# Foreground mode remains opt-in and exits cleanly on Ctrl-C.
pnpm --ignore-workspace collect-foreground
# Dry-run the first controlled pair; add --execute-live only after preflight headroom is safe.
pnpm --ignore-workspace experiment --manifest experiments/manifests/terra-low-no-tool-uncached.json --offline
# Analyze all adjacent intervals, including repeated integer displays.
pnpm --ignore-workspace contamination
# Inventory client tool observations versus official provider units.
pnpm --ignore-workspace tools --since 2026-07-21T17:06:03.000Z --until 2026-07-23T16:15:40.974Z
# Append and resolve the deterministic schema-0.1 replay correction.
pnpm --ignore-workspace migrate-corrections
# Preview a bounded metadata-only export. This writes no bundle; first use creates an owner-only identity secret.
pnpm --ignore-workspace inspect:export -- --since 2026-07-24T18:00:00.000Z --until 2026-07-24T19:00:00.000Z
# Write an owner-only local-review bundle and separate privacy receipt. No upload exists.
pnpm --ignore-workspace export:local -- --since 2026-07-24T18:00:00.000Z --until 2026-07-24T19:00:00.000Z --output exports/local-review.umx.json
# Independently verify the exact local bundle/receipt bytes and closed contract tuple.
node ./src/cli.js verify-bundle --input exports/local-review.umx.json
# Create a resumable disk-backed export set, then verify the complete set.
node ./src/cli.js export-set --since 2026-07-24T18:00:00.000Z --until 2026-07-24T20:00:00.000Z --workspace .usage-monitor/export-workspace --directory exports/local-set
node ./src/cli.js verify-export-set --directory exports/local-set
# Explicitly include the local Codex collector ledger and Claude's default status state.
node ./src/cli.js export-set --since 2026-07-24T18:00:00.000Z --until 2026-07-24T20:00:00.000Z --workspace .usage-monitor/export-workspace-with-quota --directory exports/local-set-with-quota --collector-file .usage-monitor/collector-events.jsonl --claude-status
# Resume must repeat the same supplemental source selection; an explicit Claude directory overrides the default.
node ./src/cli.js export-set --resume --workspace .usage-monitor/export-workspace-with-quota --directory exports/local-set-with-quota --collector-file .usage-monitor/collector-events.jsonl --claude-status
# Include privacy-minimized Claude Code transcript usage from the default local projects directory.
node ./src/cli.js export-set --since 2026-07-01T00:00:00.000Z --until 2026-07-25T23:59:59.999Z --workspace .usage-monitor/export-workspace-with-claude --directory exports/local-set-with-claude --claude-usage
# An explicit projects directory both selects Claude usage and overrides the default location.
node ./src/cli.js export-set --since 2026-07-01T00:00:00.000Z --until 2026-07-25T23:59:59.999Z --workspace .usage-monitor/export-workspace-with-claude --directory exports/local-set-with-claude --claude-projects-dir /absolute/path/to/claude/projects
# Replay any durable receipt-first transaction left by a process or power failure.
node ./src/cli.js recover-exports --directory exports
# Inspect identity rotation state without changing files, then explicitly rotate if intended.
node ./src/cli.js rotate-local-identity
node ./src/cli.js rotate-local-identity --confirm
```

`--ignore-workspace` is needed on this machine because the home directory contains an unrelated pnpm workspace. It can be omitted elsewhere.

Observations are appended to `.usage-monitor/observations.jsonl`, which is ignored by Git. Override it with `--data-file /absolute/path/observations.jsonl`.

Historical transition mining writes the current parser-`0.3.2`, owner-only dataset to `.usage-monitor/transitions-v0.3.2.json` and a versioned dated audit beside it. Supply an explicit `--since` and `--until`; this prevents a moving “now” boundary from making otherwise unchanged runs incomparable. Use `--compact --window-minutes 10080` for bounded weekly-history research. Parser `0.3.1` and the original frozen `0.3.0` artifact remain untouched; the legacy correction migration explicitly uses `0.3.0`.

The collector does not save prompts, responses, credentials, account identifiers, repository paths, filenames, or tool arguments. It saves aggregate token components, model names, quota window snapshots, official daily token totals, and pricing provenance/warnings. Each Codex capture reports two API-price estimates: a request-aware RunCost ledger as the primary series and the ccusage baseline used by the linked Reddit experiment. It does not use the Codex subscription credit rate card.

Local rollout logs normally retain the last provider-reported `used_percent`, window length, and reset time on token-count events. This is a last-known integer snapshot: it may be stale until another Codex response arrives and it does not contain the absolute allowance. The `doctor` and `capture` commands use the app-server account endpoint to refresh quota without generating a model turn.

## Commands

- `usage-monitor doctor`: verify the local Codex app-server, ccusage, and RunCost integration.
- `usage-monitor benchmark-r7 --profile PROFILE --output PATH`: write an owner-only, self-hashed R7 receipt. `smoke` runs the small lifecycle harness; `release_synthetic_semantics`, `release_synthetic_pressure`, and `release_materialized_boundaries` run the separate preregistered release evidence profiles. These receipts remain `partial` while network activity and literal candidate-scale boundaries are unmeasured. The internal real-history and decision builders produced the reviewed dual-runtime ten-receipt matrix, but the public CLI deliberately refuses them because real history requires one explicit frozen interval plus both exact runtime executables, and a decision must consume the complete eight-receipt input matrix. No profile uploads data.
- `usage-monitor capture [--label TEXT] [--controlled] [--plan-timeline PATH]`: append one aligned observation partitioned by pseudonymous account scope and the dated specific plan variant when known.
- `usage-monitor report [--json]`: group observations by reset window as a descriptive diagnostic. It always returns `non_identifiable` and suppresses fit/capacity output; use `transitions` plus `infer` for gated capacity inference.
- `usage-monitor transitions --since ISO_TIMESTAMP --until ISO_TIMESTAMP [--offline] [--compact] [--window-minutes N]`: reconstruct request-priced usage, collapse repeated integer quota displays into transition boundaries, and emit the normalized dataset plus privacy audit. Compact mode omits the large adjacent-snapshot stream.
- `usage-monitor infer [--input PATH] [--output PATH] [--report-file PATH]`: compare floor, nearest-integer, one-event-delay, and 30-second-delay observation models; compute exact feasible ranges, a robust pairwise estimate, deterministic bootstrap uncertainty, holdout error, residual slices, and identifiability gates.
- `usage-monitor history [--input PATH] [--output PATH] [--report-file PATH]`: compare privacy-safe within-reset slopes over time, deduplicate near-identical reset identities, apply Standard/Fast sensitivity, and refuse a policy-change claim while shared-pool usage is unbounded.
- `usage-monitor calibrate-weekly [--input PATH] [--output PATH] [--report-file PATH]`: reproduce the frozen baseline; choose a Standard or speed-aware API-price basis; compare no-delay, forecast-window, regime, and online checkpoint candidates chronologically; audit reset-level error concentration; and emit the current ballpark plus empirical error. It never reports an identified provider allowance.
- `usage-monitor mark-activity --surface SURFACE --state start|end|pulse [--experiment-id ID] [--activity-file PATH]`: append an owner-only low-cardinality marker. Explicit surfaces include ordinary Chat, Work, Workspace Agents, Excel, Codex Cloud/other devices, ordinary or Work Voice, image generation, Spark, dictation, third-party clients, quiet periods, and controlled experiments. Each marker carries a fixed policy classification such as `shared_agentic_pool`, `excluded_ordinary_chat`, `shared_agentic_pool_feature_multiplier`, `separate_demand_adjusted_model_limit`, or `mixed_task_shared_voice_time_separate`; it stores no content, URL, credential, or free text.
- `usage-monitor inspect-export --since ISO_TIMESTAMP --until ISO_TIMESTAMP [--codex-home PATH] [--activity-file PATH] [--secret-file PATH]`: construct and privacy-check one resource-bounded metadata-only single bundle, then print only coverage, counts, resource-policy version, check results, and size. It never writes a bundle or contacts a server. Histories that exceed a single-bundle ceiling fail explicitly; use `export-set` for deterministic bounded chunking and restart-safe replay.
- `usage-monitor export-local --since ISO_TIMESTAMP --until ISO_TIMESTAMP --output PATH [--receipt PATH] [--codex-home PATH] [--activity-file PATH] [--secret-file PATH]`: write the same validated bundle and its SHA-256 privacy receipt as a recoverable no-clobber owner-only transaction in one destination directory. A durable manifest and exact staged digests are synced before the receipt is published; the bundle is published last as the commit point. If the process stops after that durable boundary, the transaction remains explicitly recoverable rather than being guessed or silently discarded. The v0.1 bundle is forced to `transportReady: false`; no upload command, endpoint, or network transport is implemented.
- `usage-monitor verify-bundle --input PATH [--receipt PATH]`: verify canonical bytes, owner-only regular-file and directory controls, schema validity, the exact generated compatibility tuple, record counts, provider declarations, ordering, unique occurrence IDs, coverage bounds, privacy checks, and receipt hash/size equality. Output is a bounded content-free summary and never includes paths or pseudonyms.
- `usage-monitor export-set --workspace PATH --directory PATH [--resume] [--since ISO_TIMESTAMP --until ISO_TIMESTAMP] [--codex-home PATH] [--collector-file PATH] [--claude-status | --claude-state-dir PATH] [--claude-usage | --claude-projects-dir PATH] [--activity-file PATH] [--secret-file PATH] [--max-records-per-chunk N] [--max-bundle-bytes N] [--max-artifact-bytes N]`: freeze complete Codex rollout prefixes and, only when explicitly selected, the Codex collector ledger, Claude status snapshot inventory, and/or Claude Code transcript usage; stream validated safe records through an owner-only SQLite workspace; resume without duplicate logical records; materialize deterministic bounded gzip bundle/receipt chunks; and publish the complete manifest last. `--claude-status` selects the default local status state directory, while `--claude-state-dir PATH` explicitly includes and overrides it. `--claude-usage` selects the default local Claude projects directory, while `--claude-projects-dir PATH` explicitly includes and overrides it. Creation requires `--since` and `--until`; `--resume` rejects new bounds and requires the same supplemental-source selections so the controller can rebind and revalidate the descriptor-bound sources. No option installs a callback, contacts a network service, uploads data, or exposes private source plans in CLI output.
- `usage-monitor inspect-export-workspace --workspace PATH`: print only bounded workspace status (`scan_complete`, resumable `incomplete`, or discard-only `poisoned_source_integrity`), coverage, source counts/bytes, safe-record counts, and disk bytes. It never prints source paths, record values, or pseudonyms.
- `usage-monitor verify-export-set --directory PATH`: independently verify the canonical manifest and its receipt, every inferred fixed-name compressed chunk pair, encoded hashes and byte limits before bounded decompression, decoded canonical hashes/bytes/counts/shared contract, cross-chunk ordering and occurrence-ID uniqueness using a temporary disk-backed index, greedy packing boundaries, and the chunk-independent logical-record digest. Output is content-free.
- `usage-monitor delete-local-export --workspace PATH --directory PATH [--confirm-deletion TOKEN]`: without a token, independently verify and bind one complete export set to its workspace, then print only bounded file/byte counts and a short target-specific confirmation token without changing files. With that exact token, acquire the workspace and destination leases, durably commit a content-free exact-inventory journal, and move each candidate through same-directory quarantine, re-verification, and durable unlink. Source logs, identity state, unrelated destination siblings, and both directories are retained. No participant secret or network access is used, and secure SSD erasure is not claimed. The OS user account is the local trust boundary; this is not a sandbox against malicious code already running as that same user.
- `usage-monitor recover-local-export-deletion --workspace PATH --directory PATH`: resume an already committed local deletion journal. Each still-present row must match its recorded inode, link count, size, and hash; an absent row is already complete, while a changed, replaced, symlinked, or hardlinked row stops recovery without deleting the replacement. A fixed no-clobber receipt remains after completion.
- `usage-monitor recover-exports --directory PATH`: validate and replay durable local pair transactions in receipt-first order. Recovery accepts only exact staged inode/hash/size evidence, never replaces a foreign destination file, and removes its private transaction directory after a complete pair is durable.
- `usage-monitor rotate-local-identity [--secret-file PATH] [--confirm]`: without confirmation, report only `ready`, `missing`, `external_override`, or `conflict` and change nothing. With `--confirm`, rotate the production Keychain identity on supported macOS arm64 systems; an explicit `--secret-file` rotates only that development override. Migration retirement prevents an older file identity from being reused. Rotation breaks linkability for every future participant/session/event/snapshot/account/model pseudonym but does not change existing bundles; environment-provided secrets are refused, secure storage erasure is not claimed, and no network activity occurs.
- `usage-monitor crosscheck --since ISO_TIMESTAMP --until ISO_TIMESTAMP [--input LOCAL_HISTORY_PATH] [--allow-stale-cache] [--plan-timeline PATH] [--provider-ui PATH] [--output PATH] [--report-file PATH]`: compare the fixed 69-day replay-safe interval to the current account's official daily token buckets, account-level quota, optional visible-UI observation, and prospective same-scope collector records. Historical local rows stay account-unattributed. Cached input is accepted only for unchanged sources or when every appended complete record is proven later than the fixed end; stale override is explicit and retained in output.
- `usage-monitor quality [--input TRANSITIONS_PATH] [--collector-file PATH] [--output PATH] [--report-file PATH]`: profile monitorability before interpreting a gradient. It selects the dominant exact reset series, evaluates independent interval coverage dimensions, measures integer-display lag, distinguishes fixed-reset timestamp jitter from moving/high-churn limit families, checks collector freshness, and prioritizes remediation.
- `usage-monitor register-account --alias LOCAL_ALIAS --default-plan PLAN_VARIANT [--plan-timeline PATH]`: register the currently signed-in account under a low-cardinality local alias and a plan assumption effective from the registration time. It never saves the email or rewrites an existing account's earlier plan history.
- `usage-monitor collect-once [--stale-after-ms N] [--no-refresh] [--backfill]`: tail complete new rollout lines from atomic byte checkpoints, optionally refresh a stale rate-limit snapshot through the read-only app-server account endpoint, flush owner-only records/checkpoint, and exit.
- `usage-monitor collect-foreground [--stale-after-ms N] [--reconciliation-ms N]`: hold one app-server connection, consume rate-limit notifications, watch active/archive rollout directories, reconcile periodically, reconnect with bounded backoff, and exit cleanly on `SIGINT`/`SIGTERM`.
- `usage-monitor experiment --manifest PATH [--execute-live] [--offline]`: validate and API-price a content-free experiment manifest. Live execution requires the explicit flag and is refused before spawning Codex when price warnings, projected cost, quota availability, or minimum headroom fail.
- `usage-monitor contamination [--transitions PATH] [--inference PATH] [--experiments PATH] [--observations PATH]`: preserve every adjacent snapshot interval, classify contamination/control state, calculate sensitivity residuals, and report change-point and lagging daily-bucket signals without forcing local cost to match quota.
- `usage-monitor tools --since ISO_TIMESTAMP --until ISO_TIMESTAMP`: classify privacy-safe client tool observations separately from typed Responses/provider units and apply standard API tool prices only to an exact provider unit.
- `usage-monitor migrate-corrections [--observations PATH] [--transitions PATH] [--corrections PATH]`: append the deterministic legacy replay correction once, resolve effective derived observations, and emit the visible audit trail without rewriting the source observation.

Use `--offline` on `capture` to keep ccusage and RunCost on their local price caches. Online capture resolves current RunCost price sources and retains source freshness/provenance in the observation.

## Functional local product

The loopback companion is now the default product preview. It reads the
privacy-minimized collector ledger and verified report artifacts locally, then
serves only a closed dashboard projection:

```bash
USAGE_MONITOR_PORT=8791 npm run product:local
```

Open `http://127.0.0.1:8791/`. The dashboard shows current retained quota
windows, API-price-equivalent activity, one/two/three-hour observed-versus-
expected movement, residuals, weekly calibration and error, monitoring
coverage, blind spots, and links to the detailed reports. Values are labelled
with their observation age; stale evidence is not presented as live.

Raw Codex logs never enter the browser. The server binds only to loopback,
accepts a fixed host, serves fixed assets/reports, and exposes no source-path
parameter. Refresh is an explicit same-origin action and remains single-flight
until the collector finishes.

To exercise both product surfaces, start the central Worker on a separate port
and optionally let the companion read its health and delayed weekly community
snapshot:

```bash
npm --prefix apps/worker run migrate:local
npm --prefix apps/worker run dev -- --port 8792
USAGE_MONITOR_PORT=8791 \
  USAGE_MONITOR_CENTRAL_ORIGIN=http://127.0.0.1:8792 \
  npm run product:local
```

The relay accepts only the reviewed central API routes and cannot proxy a
request-selected URL. Specifically, it forwards only unauthenticated `GET`
requests for health, the envelope key, and stored aggregate snapshots. It cannot
forward enrollment, recovery, uploads, personal sessions, personal statistics,
exports, security controls, deletion, authorization headers, cookies, CSRF
values, or upstream cookies.

Open `http://127.0.0.1:8792/` to inspect the Worker-served portal and exercise
its public central API. The rendered controls make the intended same-origin
personal journey visible, but a browser cannot complete that Secure-cookie
journey over this loopback HTTP preview. Use the documented cookie-jar HTTP
smoke for the complete local backend lifecycle; a staged same-origin HTTPS
preview must repeat the real browser interaction before any participant pilot.
The production portal owns enrollment, recovery, one-use upload authorization,
personal results, export, and deletion. This separation prevents tunneling a
Secure cookie through plain HTTP loopback. The central service remains
local-development-only and is not deployed.

### Preparing a contribution

The hosted service does not read a user's log directory. First produce a
current privacy-verified local bundle and receipt. Then convert that reviewed
bundle into bounded `telemetry-contribution-v0.1` files:

```bash
npm run product:prepare-contribution -- \
  --bundle /absolute/path/to/review.umx.json \
  --receipt /absolute/path/to/review.umx.json.privacy-receipt.json \
  --output /absolute/path/to/contribution-batches
```

The converter re-verifies the canonical source and privacy receipt, drops
participant/account/session scopes from transport rows, normalizes API-price
components, and writes owner-only no-clobber files of at most 200 rows and
1.25 MB each. Select those files in the dashboard's Data & privacy section.
Open the Worker-served portal, select one of those prepared files, and confirm
the contribution. The browser validates the closed shape again, encrypts it,
registers that exact envelope digest and byte size, and sends it with a
separate one-use upload authorization. The upload carries no personal session
cookie. Overlapping batches deduplicate by participant-scoped occurrence ID at
the server.

`npm run product:check` runs the functional UI, loopback server, transport
builder, Cloudflare-runtime ingestion/lifecycle tests, generated types, and a
Worker dry deployment. It does not deploy or upload data.

For a real HTTP backend smoke using an actual prepared contribution, run the
Worker in invite-only mode. Issue twenty invitation grants so the smoke can
exercise the production-shaped public support threshold. Build the repeated
arguments as shown in the Worker runbook, then use:

```bash
npm run product:backend:smoke -- \
  --origin http://127.0.0.1:8792 \
  --file /absolute/path/to/telemetry-contribution-000001.json \
  "${INVITE_ARGS[@]}"
```

The [Worker runbook](./apps/worker/README.md) contains the full migration,
owner-only invitation, server-start, smoke, and cleanup sequence. The smoke
exercises Secure/HttpOnly session issuance, CSRF, authority isolation,
one-use upload registration, client encryption, strict server validation, D1
ingest, opaque R2 retention, idempotent replay with a new upload
authorization, personal statistics, scheduled immutable snapshot publication,
stable public bytes, recovery rotation, security reset, logout, participant
export, snapshot withdrawal, complete deletion, and post-deletion cleanup. It
prints no participant or credential values and leaves external deployment
disabled.

The [functional end-to-end verification
receipt](./2026-07-25-functional-product-e2e-verification-receipt.md) records a
fresh real-data local smoke: two encrypted batches, personal-stat updates,
idempotent replay, aggregate suppression, server-side privacy-canary rejection,
participant export, browser-driven complete deletion, and zero retained local
D1/R2 records afterward.

The [privacy-safe weekly aggregate verification
receipt](./2026-07-26-g4-privacy-safe-weekly-aggregate-verification-receipt.md)
records the current 20-participant scheduled-publication smoke, immutable
snapshot/deletion lifecycle, post-cleanup D1/R2 counts, and rendered
published/withdrawn UI checks.

## Local metadata exporter privacy boundary

The multi-user research path starts with a local-review-only exporter. It constructs a new allowlisted dataset from raw Codex rollouts and explicitly selected Claude Code transcripts; it does not redact or copy log records. Claude transcript rows are canonicalized by logical provider message before export so streaming partials and cross-file copies are counted once. When Claude supplies an iteration ledger, each provider attempt becomes one cost event and the top-level total is not emitted again; this preserves mixed-model fallback attempts without double counting. Versioned JSON Schemas in `schemas/telemetry-v0.1/` set `additionalProperties: false` at every object boundary. Unknown upstream fields are therefore omitted, and unknown model strings become secret-keyed fingerprints rather than exported names.

Telemetry v0.1 is explicitly an unfrozen, local-only draft: it has never authorized external participants or transport, and old local review artifacts have no compatibility promise and must be regenerated after a schema-hash change. `contracts/telemetry-v0.1/contract-status.json` and `contracts/telemetry-v0.1/consent-status.json` make that state machine-checkable. The generated compatibility tuple hashes all six schemas, the generated field dictionary, reviewed registry snapshot, consent status, and contract status; it also pins the package/exporter and executed provider parser/adapter versions. Claude remains an overall `partial` adapter, but both canonical status-line quota snapshots and bounded Claude Code transcript usage events are implemented source formats. The first volunteer or upload-capable contract will use a new frozen version; once frozen, a schema version is immutable and all changes require a new version plus migration tests.

Allowed data is limited to exact event/snapshot timestamps, available cached and uncached input components, Claude five-minute and one-hour cache-write splits when internally consistent, either disjoint text/reasoning output or a provider-reported combined output total, recognized model IDs or opaque model fingerprints, fixed subscription speed and API tier enums, fixed surface/agent/lineage classes, coarse tool-class counts, quota percentages/window/reset timing, plan classes, and domain-separated participant/session/event/snapshot/account pseudonyms. Claude's combined output is never invented as visible text or hidden reasoning. Missing source token components remain `null`, never an invented observed zero. Claude `server_tool_use` remains an explicit open G2 accounting field: it is not exported or priced until its provider-billable unit semantics receive a separate strict schema. Prompt and response content, tool names and arguments, commands, URLs, paths, repositories, filenames, branches, geography, account emails, raw account/session/device/request identifiers, credentials, hostnames, usernames, arbitrary labels, and unknown fields are excluded.

On supported macOS arm64 systems, the separate exporter identity defaults to the dedicated `app-usagemonitor.export-identity.v1` Keychain item. Migration first verifies the Keychain readback, durably commits owner-only retirement markers, and then removes the exact revalidated prior app-state or legacy working-directory secret file. A crash after retirement but before removal is recovered on the next identity operation; a replaced or unverifiable file is retained and reported rather than deleted. Retirement prevents an old file from resurrecting an identity even when cleanup cannot complete. Canonical/legacy disagreement fails closed instead of silently choosing one. No secure storage erasure is claimed. `APP_USAGEMONITOR_EXPORT_SECRET` and `--secret-file` remain explicit development overrides, and the account-observation credential uses a different Keychain capability.

Codex usage and physical quota occurrence IDs are keyed to the privacy-safe source-session scope plus the physical JSONL record ordinal, so parser enrichment, model-registry changes, tool attribution, and export bounds do not re-key those source events. Claude transcript usage instead derives a logical message occurrence from the secret-keyed provider message identity, then derives one occurrence per provider iteration; raw provider IDs never enter the plan or bundle. Quota records also carry a separate provider-state ID; unattributed state is session-scoped so two unknown accounts are never collapsed. Reviewed model, limit, and diagnostic vocabularies fail closed. `pnpm telemetry:check` verifies that every one of the 178 properties across all six schemas has exactly one reviewed privacy/retention/publication/provider-provenance row in `generated/telemetry-v0.1-field-dictionary.json`, that all references resolve, and that both the field dictionary and compatibility manifest match the live checked-in inputs. The compatibility tuple also binds the candidate G1 resource-policy version.

The export privacy gate validates the complete bundle schema, requires the live compatibility tuple and an implemented adapter for every declared or observed provider, recursively scans forbidden keys and sensitive string shapes outside the closed protocol tuple, verifies record counts, and emits a SHA-256 receipt. The scanner bounds allocation for one JSONL line at 16 MiB. A structural-marker streaming classifier recognizes canonical compact JSONL discriminators such as `"type":"token_count"`; it may discard an oversized line only when none of the fixed session, context, tier, usage, task, or tool discriminators occur. A relevant or ambiguous oversized line fails closed while physical line ordinals remain stable. Frozen prefixes are checked before reading and rehashed on the same open descriptor after parsing before scan completion. Export discovery/runtime/output uses versioned candidate policy `g1-r3-candidate-0.5`: 31 covered days, 20,000 streamed directory entries, 5,000 source files, 32 GiB frozen source bytes, 2,000,000 safe records/2 GiB expanded safe-record bytes per set, 100,000 records/32 MiB decoded canonical bytes and 34 MiB encoded bytes per chunk, 4 GiB independent decoded and encoded set ceilings, 512 chunks, a 1 MiB manifest, a 4 GiB workspace or verifier uniqueness index, 1,000-row SQLite transactions, ten elapsed minutes per invocation, and a 1.5 GiB RSS kill switch. Directory enumeration has its own fixed failure code, and activity-marker collections are bounded before map allocation. Those are preliminary single-machine safety ceilings, not final p95 volunteer limits. Direct guard probes are not treated as producer or verifier integration evidence; actual boundary identification remains an open measured-release task. The single-bundle and set verifiers independently enforce their serialized and semantic boundaries. Source-value canaries remain fixture/export-time evidence only when explicitly supplied; a verifier cannot reconstruct discarded raw source values. Any failure stops or rejects the export without echoing private values. `exports/`, `*.umx`, privacy receipts, and `.usage-monitor/` state are ignored by Git as local safeguards.

The export-set path requires a Node runtime exposing `node:sqlite`; current qualification covers Node 24.14.0 and Node 26.2.0. Compressed manifests record the producing Node and zlib versions as representation provenance, while verification authenticates stored artifact bytes and never requires runtime equality or recompression. Plain v0.1 filename/manifest dispatch remains isolated, but this unfrozen telemetry contract explicitly has no backward compatibility: local artifacts carrying an earlier resource-policy tuple are rejected and must be regenerated. Other older supported runtimes can continue using the legacy local commands, but are not release-qualified for export sets.

Real-data transport is implemented only as a local development proof of
concept. The browser accepts only a prepared
`telemetry-contribution-v0.1` file; the central Worker performs authenticated
envelope decryption, exact-shape and semantic validation, privacy-canary
rejection, participant-scoped occurrence deduplication, deterministic
server-side API repricing, D1 ingest, opaque R2 quarantine, personal statistics,
thresholded development community statistics, export,
recovery, individual contribution deletion, and complete participant deletion.
The canonical personal cost ignores the uploaded cost declaration and is
derived from validated token components using the reviewed, versioned API price
registry. Exact price-card IDs, method/registry versions and hashes, coverage,
and unpriced reason codes are retained. Standard, Batch, Flex, and Priority are
API tiers; Codex Standard/Fast is a separate subscription-speed observation and
never silently selects Priority. GPT-5.6, GPT-5.5, and GPT-5.4 use the exact
272,000-token long-context boundary where official rates exist.
Personal results also expose bounded one-, two-, and three-hour UTC
observed-versus-cost-implied machinery. Because the v0.1 contribution
projection deliberately removes account scope, the server currently fails
that conversion closed with `account_continuity_not_transmitted` rather than
publishing a participant-wide estimate. The local analyzer retains
account-partitioned rolling views.
Personal web access uses a short-lived, hash-only D1 session exposed only in a
Secure, HttpOnly, SameSite=Strict `__Host-` cookie. Browser storage contains no
reusable personal credential. Uploads use a distinct five-minute, one-use
authorization bound to the exact encrypted body digest, byte length, and
content type; that authority cannot read or delete personal data.
The original fixed synthetic walkthrough remains available for regression
testing but is no longer the product home.

The live community totals are not publication-safe merely because three
participants unlock them: a changing total can still expose a participant by
differencing. They remain local-development diagnostics until replaced by
delayed immutable weekly snapshots with per-cell support, clipping, rounding,
and a fixed ingestion cutoff.

There is still no public deployment, production route, background
transmission, public bucket, or authorized volunteer collection. Production
requires admission controls and rate limiting, production key rotation,
consent/version governance, privacy/security review, and a staged release
decision. See the [local companion and central product plan](./2026-07-25-local-companion-app-plan.md),
the [G3 session/upload capability plan](./2026-07-25-g3-session-capability-separation-plan.md),
its [verification receipt](./2026-07-25-g3-session-capability-separation-verification-receipt.md),
and the [Worker runbook](./apps/worker/README.md). The earlier
[synthetic vertical-slice plan](./2026-07-25-synthetic-consumer-vertical-slice-plan.md)
is retained only as a superseded historical record.

The [G1 resource-bounded export-set plan](./2026-07-24-g1-resource-bounded-export-set-plan.md) defines the local milestone; the [measured R7 verification](./2026-07-25-g1-r7-measured-release-verification-receipt.md) records the completed dual-runtime evidence package, while the [R7 ceiling decision](./2026-07-25-g1-r7-release-ceiling-decision.md) explains why policy promotion remains open. The [compressed export-set receipt](./2026-07-24-g1-compressed-export-set-verification-receipt.md) and [local deletion receipt](./2026-07-24-g1-local-export-deletion-verification-receipt.md) record the verified representation and lifecycle boundaries; and the earlier [disk-backed](./2026-07-24-g1-disk-backed-export-set-receipt.md) and [resource/identity](./2026-07-24-g1-resource-identity-protection-receipt.md) receipts preserve prior checkpoints. The [complete end-to-end goal](./2026-07-24-end-to-end-multi-user-usage-monitor-goal.md) defines the critical path and production finish criteria; the [multi-user privacy expansion plan](./2026-07-24-multi-user-privacy-expansion-plan.md) contains the supporting architecture.

## Account switching and local secret handling

Account separation uses an HMAC-SHA-256 pseudonym derived at runtime from the signed-in account email. On supported macOS arm64 systems, the CLI creates or reads a distinct 32-byte credential from the `app-usagemonitor.account-observation.v1` Keychain item automatically. The email, provider account ID, HMAC key, credit balance, and reset-credit identifiers are never persisted. There is no account-HMAC environment-variable fallback in production.

Run account-aware commands directly; no secret wrapper or manual credential setup is required:

```bash
node ./src/cli.js doctor
```

`doctor` does not register an account or write monitoring observations. On first use it may create the dedicated Keychain credential, then reports the current pseudonymous scope. After intentionally switching ChatGPT accounts, register the current account with a non-identifying alias, then force one fresh collection:

```bash
node ./src/cli.js register-account --alias account-secondary --default-plan pro-20x
node ./src/cli.js collect-once --stale-after-ms 0
```

This creates a different stable pseudonymous scope for future observations. The collector provisionally assigns the scope only to new rollout receipts within five minutes of a fresh account marker; it does not backfill identity across older rollouts. Historical account attribution therefore remains unavailable rather than silently assigning all old data to whichever account is currently signed in. If Keychain is actively locked, `doctor` reports `credential_locked`; if the credential backend is denied, malformed, or otherwise unavailable, it reports `credential_unavailable`. Collection still records the quota snapshot safely as unattributed and increments the matching content-free diagnostic; it never invents an account scope or falls back to a process environment secret. `register-account` fails safely until the credential is available.

Snapshot reports, interval inference, and weekly reset history include pseudonymous account scope and specific plan variant in their grouping keys. Known accounts and plan eras therefore cannot be pooled. Raw historical transition rows explicitly remain `unattributed` / `unknown`; prospective collector crosschecks accept only records matching the current pseudonymous scope and label their partial-marker time coverage.

The owner-only files `.usage-monitor/account-plan-timeline-v0.1.json`, `.usage-monitor/provider-ui-observations-v0.1.jsonl`, `.usage-monitor/local-history-v0.1.json`, and `.usage-monitor/provider-crosscheck-v0.1.json` are mode `0600`. These account-observation commands never upload. The separate central contribution path remains an explicit, local-development-only action using prepared privacy-safe files.

`.usage-monitor/local-history-cache-validation-v0.1.json` is an owner-only, cache-digest-bound sidecar containing only hashed source keys and filesystem size/time metadata. It advances after a proven after-end suffix so subsequent cached crosschecks inspect only new bytes; it never stores rollout paths. Collector ingestion likewise streams file growth in 256 KiB chunks, caps one buffered JSONL line at 16 MiB, writes safe output in batches of at most 1,000 records, bounds its recent-key window at 5,000, and uses a path-free digest journal so an appended batch is either retained with its committed checkpoint or truncated and replayed. Transaction payloads and metadata are fsynced in commit order, including parent-directory metadata after atomic rename/removal. Oversized lines remain diagnostic, and idle reconciliation does not rewrite the checkpoint every cycle.

## Rebuilding the portable report

`artifact.json` is extended idempotently from the prior weekly-history artifact, so all earlier sections, data, sources, and caveats remain present.

```bash
pnpm --ignore-workspace build:report-data
node /Users/adamallcock/.codex/plugins/cache/openai-curated-remote/data-analytics/0.2.8-13ceeea1f599/skills/build-report/scripts/build_portable_artifact.mjs \
  --input artifact.json \
  --output 2026-07-24-codex-work-account-usage-report.html
pnpm --ignore-workspace fix:report-width -- 2026-07-24-codex-work-account-usage-report.html
node /Users/adamallcock/.codex/plugins/cache/openai-curated-remote/data-analytics/0.2.8-13ceeea1f599/skills/build-report/scripts/verify_portable_artifact.mjs \
  --html 2026-07-24-codex-work-account-usage-report.html \
  --artifact artifact.json
```

The width fix is a narrow packaging workaround for the portable reader's `100vw` header when a classic vertical scrollbar is present; it does not modify report content or embedded artifact data.

## Method boundary

A capacity estimate means only that observed quota changes are consistent with the chosen API price mapping. It does not prove OpenAI's internal quota formula. See [the validation report](./2026-07-23-local-usage-limit-validation.md) for the experiment protocol and stop gate.

Historical transitions preserve regressions, skipped display values, incomplete local-window coverage, unknown models, pricing warnings, and snapshot-age uncertainty as evidence rather than silently cleaning them. Quota snapshots contain only integer percentages; neither rollout logs nor the app-server endpoint currently exposes an absolute remaining allowance or sub-percent precision.

Inference allows a separate hidden-usage offset for every reset window, so its primary capacity slope does not require local cost to begin at exactly zero. This makes floor and nearest-integer rounding observationally equivalent for the slope; origin alignment is reported only as a sensitivity test. A live result remains `non_identifiable` when shared-pool/control state is unknown, exact interval constraints conflict, holdout error is too large, a change point is suspected, or the range is too wide.

The token-count schema still has no per-request tier field. RunCost ledgers set `service_tier: standard` only to answer the counterfactual “what would these components cost at Standard API prices?” Long-context selection remains per event. `codexSpeedMode` and `apiServiceTier` are independent: on the ChatGPT subscription surface the app protocol's raw `priority` currently names Fast, while on the API surface `priority` means the API processing tier. Billing surface is therefore mandatory context. Controlled experiment manifests explicitly declare Standard or Fast and pass the matching provider setting to the spawned workload.

The passive collector does not install a daemon or modify Codex settings. On first start it checkpoints existing rollout files at EOF and obtains a fresh quota snapshot only if no sufficiently fresh observation exists. Use `--backfill` only for an explicit isolated replay test; historical research should normally use `transitions`. Operational checkpoints store byte offsets, cumulative token/model cursor state, filesystem inode/birth-time cursor keys, and hashes of privacy-sanitized events—not rollout paths or session IDs.

Raw privacy-minimized collector records are deliberately append-only during this proof of concept. No automatic retention or deletion is enabled because losing reset/account evidence would be harder to repair than excess local disk use. File size should be monitored and old closed periods should eventually be archived into owner-only monthly partitions with a manifest and digest before any source records are removed.

`quality` treats collector state as operational evidence. Fresh means the newest collector or app-server record is no more than five minutes old, delayed means five to thirty minutes, and stale means more than thirty minutes. A one-time refresh does not establish continuous coverage: long gaps and the absence of live app-server notifications remain P0 findings even when the newest poll is fresh.

Controlled manifests declare the hypothesis, model, effort, context band, cache state, permitted aggregate tool class, one-turn limit, elapsed/API-price/quota budgets, minimum quota headroom, a preflight quiet period, before/after captures, and no-concurrency requirement. A pilot is controlled only when the quiet-period scan finds no recent local use and exactly one rollout contributes measured usage afterward. The stable workload prompt lives in the local implementation and is never copied into experiment result records. Seven dry manifests cover cache, reasoning effort, Terra/Sol/Luna, and below/above-272k context comparisons; live execution remains opt-in and preflight-refused whenever headroom or isolation is unsafe.

Two live Terra pilots were eventually run after reset. They were bounded and aligned, but a separate Sol rollout contributed during each interval, so both remain `controlledState: unknown`. Later attempts were correctly refused when active/recent work made isolation unsafe. No causal model, cache, effort, context, or tool multiplier is claimed.

Tool counts are explanatory client features unless the transcript exposes an exact server unit. A local web wrapper is not automatically a Responses `web_search_call`; local shell and Apply Patch are not Hosted Shell container sessions; MCP and subagent orchestration have no separate standard API per-call price. See [the Milestone 6 decision](./2026-07-23-milestone-6-tool-mechanism-decision.md).

Corrections are append-only derived records. Duplicate records collapse idempotently, while branches, cycles, missing targets, digest mismatches, and incompatible schemas are errors. The legacy correction changes neither provider quota fields nor raw/local evidence. See [the Milestone 7 decision](./2026-07-23-milestone-7-correction-provenance-decision.md).

The collector's first 22 pre-seeding usage records remain `unknown` and total 3,714,307 tokens. They are operational collector provenance, not inputs to `report`, `transitions`, `infer`, contamination, or the observation correction ledger; their model cannot be reconstructed safely from the retained privacy-minimized fields. They are therefore retained—not relabelled or rewritten.

The full implementation goal and all gate receipts are in [the v0.3 goal](./2026-07-23-usage-monitor-v03-goal.md).
