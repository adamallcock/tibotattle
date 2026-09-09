---
title: Historical model allowance deployment
date: 2026-09-07
type: receipt
status: deployed-awaiting-historical-progress
---

# Boundary

The owner authorized production migration 0048 and the guarded Worker deployment
for historical per-model allowance points. Clean source
`0207a3c1f728ae6682d4423cf31540f72cc4d19c` deployed at 00:08:54 UTC on
2026-09-07, extending the live repair at
`daa82a939020cb74ad5054c4ee7e6091019502be`. This receipt distinguishes the
successful deployment from the unfinished historical reconstruction.

# Qualification and preservation

- Implementation `e35008d5` passed 790 Worker tests across 61 files, 202 Worker
  script checks, TypeScript, package-copy and generated-source guards, and all
  three dry bundles. The final migration readiness suite passed 35 checks.
  The deployment source differs from that implementation only in documentation.
- Synthetic desktop/mobile browser checks verified multi-day model segments,
  honest gaps and no backward-carried Astra points. They are not live evidence.
- The broad root suite reported 3,886 passes, two pre-existing retained desktop
  R7 receipt failures and 21 skips. The unchanged baseline and candidate share
  the exact 362-file R7 workload; those receipt failures remain open for future
  desktop qualification and are not part of the maintained Worker deploy gate.
- Both production migration ledgers matched their ordered source prefix;
  only `USAGE_MONITOR_DB:0048_community_model_history.sql` was pending.
  Both database recovery bookmarks and primary storage size were checked before
  mutation. No database restore was authorized or performed.
- Migration 0048, SHA-256
  `5b772c33723e2dd2d9f992738c731efea12831ba774806859ce6d16d481ceb29`,
  applied at 00:06:57 UTC. Its 20 statements completed in 13.07 ms of database
  execution; that is not the backfill duration. Exact stored schema and column
  probes passed, including all 17 new history objects. No migrations remained
  pending in either ledger.
- Before/after reads preserved 23,997 retained v1 chunks, the one forward model
  day dated September 6, and the existing admin preview row. New history work
  and result tables were empty before the new Worker began running. These are
  bounded preservation checks, not a full source-telemetry re-export.

# Deployment and live checks

The normal protected deployment wrapper returned `PRODUCTION_DEPLOYED`, with
no unapplied migrations, healthy immediate/post health checks and a public-only
asset surface. No emergency exception, alternate deploy route or validation
bypass was used. At 00:10:30 UTC, independent health returned HTTP 200, `ok`,
and the exact source above. Worker version
`00e1a895-6641-4386-b113-9931288ad1f8` served the observed scheduled runs.

Collection remained operational with enrollment, registration, processing and
publication unchanged. Lifecycle, retention, deletion-ledger, object storage and
deletion-safe replay health checks passed. Consent, transport activation,
desktop artifacts, release tags, installers, update feeds and Homebrew were not
changed or republished.

Authenticated Chrome rendered the new retrospective-history explanation and
the existing five model series, including Astra. The chart still contained
September 6 only during the first observation. The public all-token activity
chart rendered 317 shared days and honestly labeled USD 101,954.04 as the priced
portion across 262 days. The separate public allowance graph reported
"Merged history updating" rather than a completed curve.

Both macOS download tabs still showed 0.1.18 with their own architecture. The
live HTML exactly matched the approved public assets. Canonical, Open Graph
and Twitter metadata were checked; the unchanged approved social image was
crawler-accessible as PNG at 1200 by 630 pixels. This is not a new social image
or a fresh installer trust qualification.

# Backfill observation

Initial natural schedules completed required maintenance without runtime
exceptions and advanced current-account calculation results. The historical
worker selected September 5, the latest missing closed UTC day, then deferred
within the shared budget. At 00:17:59 UTC, ten current-account acquisition heads
were complete, three were finalizing, one was scanning and one was preparing;
no historical acquisition heads or account results existed yet.

A schedule at 00:15:59 UTC returned `canceled` without a recorded exception or diagnostic
explaining the cancellation. Following invocations returned
`MAINTENANCE_IN_PROGRESS`, respecting the existing lease through 00:36:05 UTC.
The exact live source and health were independently reconfirmed at 00:19 UTC.
No lease override, manual maintenance request or cache deletion was performed.

Natural schedules resumed after lease expiry, successfully finishing required
maintenance and advancing saved current-account work without exceptions. At
00:38:03 UTC, the lease was clear and the last recorded run was 00:37:11 UTC;
11 current-account heads were complete, two were finalizing, one was scanning
and one was preparing. No historical heads or terminal historical account
results existed, and the model-day table still held September 6 only. This
verifies automatic lease recovery, not historical reconstruction completion.
Historical checkpoints, whole-day publication and the resulting rendered
series remain open verification gates; no continuous curve is claimed here.

An independent read-only comparison against the prior live repair found the
scheduled promise registration and lease lifecycle unchanged. The new history
call is awaited and its publications are lease-fenced. No concrete new
premature-completion defect was found. This does not diagnose the cancellation:
the 40-second admission deadline is cooperative, and an admitted shared usage
scan/solver can run beyond it. Source review cannot certify total production
CPU/memory use. Cloudflare documents distinct resource-exhaustion outcomes in
its [Worker limits](https://developers.cloudflare.com/workers/platform/limits/);
the observed `canceled` event alone does not establish either exhaustion cause.

The [production runbook](../runbooks/production-operations.md) owns the scheduler
and rollout boundaries; the [allowance diagnosis runbook](../runbooks/2026-08-13-community-allowance-band-diagnosis.md)
owns the 100-day lookback, UTC cutoff, identification and gap interpretation.
The [current status](../current-status.md) owns later live observations.
