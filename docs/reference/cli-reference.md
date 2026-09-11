---
title: Command-Line Reference
date: 2026-08-27
type: reference
status: maintained
last_verified_commit: 52399658
---

# Command-line reference

`usage-monitor` is the repository's research, export, collection, and local
contribution CLI. The installed TiboTattle app does not require users to run
these commands. Command coverage is checked against `src/cli.js` by
`test/cli-reference.test.js`; the CLI's own usage output remains the authority
for exact flags.

Commands operate on local files unless a documented `--origin` or explicit
live-experiment flag is supplied. Paths can contain sensitive derived evidence:
keep them out of commits, issues, logs, and documentation.

## Read and analysis

| Command | Purpose | Durable effect |
| --- | --- | --- |
| `doctor` | Inspect local source/tool readiness without exposing content. | None. |
| `capture` | Capture one bounded account observation. | Appends to the selected local observation file. |
| `report` | Summarize captured observations and corrections. | None unless output is redirected by the caller. |
| `transitions` | Mine bounded Codex quota transitions. | Writes only explicitly selected output/audit paths. |
| `infer` | Infer capacity from a transition artifact. | Writes selected JSON/Markdown outputs. |
| `history` | Build weekly-limit history from an input artifact. | Writes selected JSON/Markdown outputs. |
| `crosscheck` | Compare local history with provider UI evidence. | Writes selected JSON/Markdown outputs. |
| `quality` | Evaluate monitoring quality. | Writes selected JSON/Markdown outputs. |
| `calibrate-weekly` | Calibrate the rolling seven-day model. | Writes selected JSON/Markdown outputs. |
| `contamination` | Analyze experiment/observation contamination. | Writes selected JSON/Markdown outputs. |
| `tools` | Analyze bounded tool-mechanism observations. | Writes selected JSON/Markdown outputs. |
| `migrate-corrections` | Plan and materialize additive correction state. | Writes selected correction/report outputs; does not rewrite source evidence. |

## Local activity and export

| Command | Purpose | Safety boundary |
| --- | --- | --- |
| `mark-activity` | Record a fixed-vocabulary surface activity marker. | Appends a content-free local marker. |
| `inspect-export` | Preview the exact allowlisted metadata for a time range. | Read-only. Run before export. |
| `export-local` | Write one reviewed local metadata bundle. | Requires an explicit output path; excludes prompt/response content. |
| `verify-bundle` | Verify a bundle and optional receipt. | Read-only. |
| `export-set` | Create or resume a resource-bounded export workspace/set. | Staged, locked, replay-safe writes to explicit workspace/directory paths. |
| `inspect-export-workspace` | Inspect workspace state and pending actions. | Read-only. |
| `verify-export-set` | Verify manifests, chunks, hashes, and boundaries. | Read-only. |
| `delete-local-export` | Delete an exact verified export set. | Two-step confirmation token and journaled recovery contract. |
| `recover-local-export-deletion` | Complete or recover an interrupted export-set deletion. | Acts only on the explicit journaled workspace/directory pair. |
| `discard-export-workspace` | Discard an exact export workspace. | Two-step confirmation token and recoverable discard transaction. |
| `recover-export-workspace-discard` | Complete or recover an interrupted workspace discard. | Acts only on the explicit workspace transaction. |
| `recover-exports` | Recover incomplete export transactions in one directory. | Bounded to the explicit directory. |
| `rotate-local-identity` | Rotate the export pseudonym secret. | Requires confirmation; does not rewrite the local unified index. |

Never use deletion or discard commands against an unresolved path, an only copy
of evidence, or a workspace owned by another running process. Inspect first and
retain the generated receipt.

## Claude callback lifecycle

| Command | Purpose | Safety boundary |
| --- | --- | --- |
| `inspect-claude-callback` | Inspect the managed Claude callback capability. | Read-only, content-free status. |
| `install-claude-callback` | Install the managed callback capability. | Changes only the reviewed local Claude integration boundary. |
| `uninstall-claude-callback` | Remove the installed callback while retaining recoverable identity state. | Scoped lifecycle operation. |
| `recover-claude-callback` | Forward-recover an interrupted callback lifecycle. | Uses the managed journal/state. |
| `rotate-claude-callback-identity` | Rotate the callback identity. | Explicit confirmation required. |
| `remove-claude-callback-identity` | Remove retained callback identity state. | Two-step removal token required. |

These callback commands manage an explicit optional local integration. They do
not enable a Claude source, quota route, dashboard, or upload surface in the
installed companion; the shipping boundary is recorded in
[`local-data-and-privacy.md`](./local-data-and-privacy.md).

## Contribution device and delivery

| Command | Purpose | Network/durable effect |
| --- | --- | --- |
| `pair-contribution-device` | Claim a reviewed hosted pairing. | Contacts only the explicit HTTPS/loopback origin and stores the device credential in the platform credential store. |
| `sync-contributions-inspect-next` | Inspect the exact next queued contribution. | Read-only local review. |
| `sync-contributions-once` | Deliver a bounded queue pass. | Contacts only the explicit origin; replay-safe queue state is updated. |
| `sync-contributions-watch` | Run bounded periodic delivery for an explicit duration. | Same fixed origin and queue contract; no daemon installation. |
| `sync-contributions-status` | Read queue status. | Read-only. |
| `sync-contributions-pause` | Pause queue delivery. | Updates the explicit queue file. |
| `sync-contributions-resume` | Resume queue delivery. | Updates the explicit queue file; does not itself grant consent. |

Hosted contribution is optional and consent-gated. Inspect the payload before
first delivery. Device disconnect preserves hosted/local history; private owner
erasure is separate and has no self-service contribution CLI command. Neither
operation should be inferred from a local queue command. See the
[owner procedure](../runbooks/production-operations.md#private-owner-participant-erasure).

## Collector lifecycle

| Command | Purpose | Durable effect |
| --- | --- | --- |
| `collect-once` | Run one replay-safe local collection pass. | Updates the selected collector state and derived local evidence. |
| `collect-foreground` | Reconcile on a bounded foreground cadence. | Updates the selected collector state until duration/cancellation. |
| `collector-state-status` | Inspect collector state and staleness. | Read-only. |
| `plan-collector-retention` | Plan what a retention cutoff would remove. | Read-only plan; it does not delete retained evidence. |

Display horizons are not retention policy. No collector command in this list
authorizes wiping Application Support or deleting the unified index.

## Experiments and release evidence

| Command | Purpose | Safety boundary |
| --- | --- | --- |
| `experiment` | Validate or run a manifest-defined experiment. | Dry by default; live execution requires `--execute-live`, and the manifest still bounds every action. |
| `benchmark-r7` | Run a named synthetic R7 benchmark profile. | Release profiles are protected evidence workflows; normal development uses the smoke profile only. |

## Exact invocation synopsis

```text
usage-monitor doctor
usage-monitor capture [--label TEXT] [--controlled] [--offline] [--data-file PATH]
usage-monitor report [--json] [--data-file PATH] [--corrections PATH]
usage-monitor transitions --since ISO_TIMESTAMP --until ISO_TIMESTAMP [--offline] [--compact] [--window-minutes N] [--output PATH] [--audit-file PATH]
usage-monitor infer [--input PATH] [--output PATH] [--report-file PATH]
usage-monitor history [--input PATH] [--output PATH] [--report-file PATH]
usage-monitor crosscheck --since ISO_TIMESTAMP --until ISO_TIMESTAMP [--input LOCAL_HISTORY_PATH] [--allow-stale-cache] [--offline] [--provider-ui PATH] [--output PATH] [--report-file PATH]
usage-monitor quality [--input TRANSITIONS_PATH] [--collector-file PATH] [--output PATH] [--report-file PATH]
usage-monitor calibrate-weekly [--input TRANSITIONS_PATH] [--output PATH] [--report-file PATH]
usage-monitor mark-activity --surface SURFACE --state start|end|pulse [--experiment-id ID] [--activity-file PATH]
usage-monitor inspect-export --since ISO_TIMESTAMP --until ISO_TIMESTAMP [--codex-home PATH] [--activity-file PATH] [--secret-file PATH]
usage-monitor export-local --since ISO_TIMESTAMP --until ISO_TIMESTAMP --output PATH [--receipt PATH] [--codex-home PATH] [--activity-file PATH] [--secret-file PATH]
usage-monitor verify-bundle --input PATH [--receipt PATH]
usage-monitor export-set --workspace PATH --directory PATH [--resume] [--since ISO_TIMESTAMP --until ISO_TIMESTAMP] [--codex-home PATH] [--collector-file PATH] [--claude-status | --claude-state-dir PATH] [--claude-usage] [--claude-projects-dir PATH] [--activity-file PATH] [--secret-file PATH] [--max-records-per-chunk N] [--max-bundle-bytes N] [--max-artifact-bytes N]
usage-monitor inspect-export-workspace --workspace PATH
usage-monitor verify-export-set --directory PATH
usage-monitor delete-local-export --workspace PATH --directory PATH [--confirm-deletion TOKEN]
usage-monitor recover-local-export-deletion --workspace PATH --directory PATH
usage-monitor discard-export-workspace --workspace PATH [--confirm-discard TOKEN]
usage-monitor recover-export-workspace-discard --workspace PATH
usage-monitor recover-exports --directory PATH
usage-monitor rotate-local-identity [--secret-file PATH] [--confirm]
usage-monitor inspect-claude-callback
usage-monitor install-claude-callback
usage-monitor uninstall-claude-callback
usage-monitor recover-claude-callback
usage-monitor rotate-claude-callback-identity [--confirm]
usage-monitor remove-claude-callback-identity [--confirm-removal TOKEN]
usage-monitor benchmark-r7 --profile smoke|release_synthetic_semantics|release_synthetic_pressure|release_materialized_boundaries --output PATH
usage-monitor pair-contribution-device --origin HTTPS_OR_LOOPBACK_ORIGIN
usage-monitor sync-contributions-inspect-next --directory PREPARED_DIRECTORY_OR_SPOOL [--queue-file PATH]
usage-monitor sync-contributions-once --directory PREPARED_DIRECTORY_OR_SPOOL --origin HTTPS_OR_LOOPBACK_ORIGIN [--queue-file PATH] [--max-uploads-per-pass N] [--max-upload-bytes-per-pass N]
usage-monitor sync-contributions-watch --directory PREPARED_SPOOL --origin HTTPS_OR_LOOPBACK_ORIGIN [--queue-file PATH] [--interval-seconds N] [--duration-ms N] [--max-uploads-per-pass N] [--max-upload-bytes-per-pass N]
usage-monitor sync-contributions-status [--queue-file PATH]
usage-monitor sync-contributions-pause [--queue-file PATH]
usage-monitor sync-contributions-resume [--queue-file PATH]
usage-monitor collect-once [--stale-after-ms N] [--no-refresh] [--backfill] [--state-file PATH]
usage-monitor collect-foreground [--stale-after-ms N] [--reconciliation-ms N] [--duration-ms N] [--state-file PATH]
usage-monitor collector-state-status [--state-file PATH] [--json]
usage-monitor plan-collector-retention --before ISO_TIMESTAMP [--state-file PATH] [--json]
usage-monitor experiment --manifest PATH [--execute-live] [--offline] [--result-file PATH]
usage-monitor contamination [--transitions PATH] [--inference PATH] [--experiments PATH] [--observations PATH] [--output PATH] [--report-file PATH]
usage-monitor tools --since ISO_TIMESTAMP --until ISO_TIMESTAMP [--output PATH] [--report-file PATH]
usage-monitor migrate-corrections [--observations PATH] [--transitions PATH] [--corrections PATH] [--output PATH] [--report-file PATH]
```

The removed `register-account` package script was a dead entrypoint and is not
part of the CLI. Enrollment is performed through the reviewed hosted or
loopback contribution flow.
