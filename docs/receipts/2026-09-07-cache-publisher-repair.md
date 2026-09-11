---
title: Scheduled graph cache recovery and combined deployment
date: 2026-09-07
type: receipt
status: deployed-verified
---

# Scheduled graph cache recovery and combined deployment

Final production source: `14af4ed160e618751c20a4a33a3c9ff0d8a5af6d`,
independently verified healthy at 16:41 UTC on 2026-09-07. Public allowance,
plan/model charts and authenticated admin allowance/growth-history views render.
This closes the live-data gate in the preserved
[presentation receipt](./2026-09-07-plan-values-admin-graph-parity.md).
The maintained operational entrypoint is [current status](../current-status.md).

## Cause and repair

The shared allowance preview expired at 15:05:41 UTC despite complete current
account caches and an empty daily rebuild queue. A natural invocation at
15:44:35 took 41,463ms: account checks reached 33,591ms/143 statements and
preview publication was refused at 41,166ms, beyond the existing 40-second
optional admission deadline. Lifecycle's earlier completion timestamp did not
measure this optional work. There was no evidence of database corruption or
missing account inputs.

The separate admin growth-history cache also expired: its generation was
13:20:23 UTC, size 227,912 bytes, and latest gauge was 13:20:22 UTC. Its
scheduled admission followed the same exhausted deadline. The authenticated
route returned `ADMIN_METRICS_HISTORY_CACHE_UNAVAILABLE` until recovery.

- Required lifecycle and weekly publication retain priority.
- Even UTC minutes give the complete, validated allowance preview an early
  cache-only publication attempt. Missing inputs retry after reconstruction,
  before daily reconciliation.
- Odd minutes preserve reconstruction's original full admission budget. This
  prevents a large incomplete preview cohort from repeatedly crowding out the
  calculations needed to repair it.
- Even minutes also admit owner gauge capture and growth-history refresh after
  the allowance preview. Each cache is attempted at most once per invocation;
  late fallback remains available. GitHub synchronization stays late.
- The shared 900-statement meter, 40-second admission deadline, source-epoch
  fences, atomic publication, 55-minute self-throttling and two-hour cache
  validity remain unchanged. Content-free timing and count logs distinguish
  refresh, failure and budget deferral. No raw analysis runs on browser reads.

The Cloudflare deployment guidance kept source qualification, guarded
publication and live runtime recovery separate. No schema migration, source
telemetry rewrite, consent/pricing change or manual maintenance invocation was
used. Derived caches refreshed through the ordinary minute cron.

## Combined source and deployment coordination

Initial repair `d46084ed` naturally restored the allowance preview at 16:18:35.
A concurrent website deployment at `9ae9be5c` then replaced that scheduler.
After owner-authorized coordination, that task paused further deployments.
Both Intel website commits, `e5a4fff8` and `9ae9be5c`, were merged without
rewriting them. Final source includes those changes, both cache repairs and
their tests. Future deployments must preserve this combined baseline; this
receipt does not claim that a cross-task deployment lock was implemented.

The final clean-source production wrapper returned `PRODUCTION_DEPLOYED`,
`no_unapplied_migrations`, healthy pre/post checks and public-only routing.
No direct deploy, health exception or migration bypass was used.

## Qualification

- 806 Worker runtime tests across 62 files, 202 operations tests, workspace
  guards, generated-source/types and TypeScript checks passed. Default,
  staging and production dry deployments passed on the final clean source.
- 545 web tests, 36 release-site tests, 20 preflight tests, documentation and
  architecture checks passed. A release-site test initially needed loopback
  permission; its authorized rerun passed. The full suite also caught the old
  single-log expectation; the updated test strictly checks both new diagnostic
  log shapes and the unchanged maintenance record.
- Original-order regressions failed before the repair; the repaired scheduler
  tests cover expired previews, missing-input retry, both priority paths,
  expired owner caches, no duplicate attempts, shared budgets, paused mode,
  pre-migration refusal, source races and lifecycle priority. The odd-minute
  maximum-checkpoint setup remains 49 statements: 46 primary plus 3 ledger.
- The normal site generator rebuilt the merged public assets and independently
  reverified both unchanged signed 0.1.18 DMGs. All 22 generated files passed
  staging; public source-closure SHA-256 is
  `15b72c47b8c842c917742ec814d634f11c49f59e8acf5a541f981d5203edcba0`.

## Independent live evidence

Natural publication and identifier-free metadata, not manual cache writes:

| Surface | Verified result |
|---|---|
| Shared allowance preview | Generated 16:18:35 UTC, 43,418 bytes, source epoch 2688; initial refresh completed before analysis in 16,331ms using 27 phase statements |
| Owner gauge snapshot | Captured 16:38:44.956 UTC on final source; early phase used 5 statements |
| Admin growth history | Generated 16:38:46.266 UTC, 226,424 bytes; early refresh completed after 14,021ms using 18 phase statements |
| Daily rebuild queue | Zero pending days; final metadata SELECTs wrote zero rows |
| Public deployment | Exact final source, nine asset hashes matched, five private routes denied, canonical docs route and 1200x630 PNG/social/crawler metadata verified |
| Authenticated admin | Overview, allowance preview and metrics/history returned HTTP 200; Growth & activity sparklines and allowance cards rendered, with no uncaught runtime exceptions during verification |

Chrome exercised public and admin plan/model views, public expanded All-history,
and the Intel download tab. Public cards show the closed September 6 values:
Pro 5x `$1,916` normalized / `$479` actual and Plus `$2,257` / `$113`.
Admin includes September 7: Pro 5x `$1,893` / `$473`, Plus `$2,277` / `$114`.
Dates explain the difference; no rounded display value is used for conversion.
Astra appears first in both model views. Intel retains its Homebrew command,
0.1.18 installer, checksum control and architecture-specific assurance.

The public all-token activity view also remains available: 180.3B tokens and
USD 100,671.8 priced portion across 279 of 318 days at this observation. That
amount is not complete historical spend or an actual bill. Public breakdowns
contain 69 closed dates; identified model history currently starts September 1
(Astra September 5). Historical reconstruction remains low priority and was not
proven to advance during this repair. Deadline-limited passes can still defer
optional work; a later observed pass completed daily reconciliation with `OK`.
No unlimited history or guaranteed throughput under saturation is claimed.

Only task-owned diagnostic tails were stopped. Existing desktop installers,
update feeds and cask artifacts were not changed. Ignored local qualification
logs use `.release-build/cache-publisher-repair-`; the superseded active plan is
retired in favour of this receipt and the maintained runbooks.
