---
title: Incremental graph refresh production publication
date: 2026-09-08
type: receipt
status: verified
source_commit: 080142f65918b7abdd6e346332cbad42bcb31fbc
---

# Result and boundary

The owner-authorized hosted graph refresh repair is published and verified.
Public and authenticated admin graphs remain available while historical work
continues. The admin now shows reusable-source preparation independently of
completed accounts, so a flat historical-day counter no longer hides saved work.
This receipt proves deployment and the observations below, **not completion of
historical backfill**, a production speed multiplier, or a desktop release.

Current operational authority is [production operations](../runbooks/production-operations.md).
The [investigation](../research/2026-09-07-refresh-performance-investigation.md)
and [local qualification](../reviews/2026-09-07-incremental-refresh-qualification.md)
retain the original findings, parity measurements and independent reviews.

## Source, migrations and deployment

| Boundary | Verified identity or result |
| --- | --- |
| Core source | `2e3fbdc75c08476a012f2b12822f773810acd58a` |
| Core deployment | `397ff2aa-0b9f-4576-a27b-1d7cb27db473`, created 02:27:50 UTC |
| Core Worker version | `80f8aa4c-6060-42f3-b27f-0ac488ed51f5`, 100% |
| Final source, including progress detail | `080142f65918b7abdd6e346332cbad42bcb31fbc` |
| Final deployment | `06aeb36d-d3b3-402e-bc3c-725ae3933fd3`, created 02:52:46 UTC |
| Final Worker version | `e8e2429f-2a45-42b5-aec3-52a1d1d5e937`, 100% |
| Exact-source health | HTTP 200, `status: ok`, final SHA at 02:53:12 UTC |

Read-only recovery inspection confirmed Time Travel availability for both the
primary database and deletion ledger at 02:21 UTC. No restore was executed or
claimed tested. Reviewed forward migrations 0050–0053 were applied successfully;
the exact post-migration schema probe passed and both migration ledgers had no
pending migrations. The former production source remained healthy after the
migrations and before the core code deployment. The progress follow-up required
no migration.

Both deployments used `production:deploy -- --confirm DEPLOY_PRODUCTION` from a
clean committed source through the immutable-snapshot wrapper. Source,
dependency, schema, asset, immediate-health, post-health and public-only checks
passed. No emergency health exception or raw deployment shortcut was used.
The wrapper's `collectionAuthorized: false` means the deployment did not grant
collection authority; existing operational collection controls remained enabled.

No telemetry was deleted or rewritten, no lease was cleared, and no manual
maintenance was triggered. Consent, retention, v1.1 activation, resource limits,
desktop artifacts, release tags and update feeds were unchanged. Old code is
not automatically a safe rollback writer for the prepared-work protocol; use
the maintained compatibility and recovery checks.

## Implemented refresh behavior

- Preserve an authorized publication during appends and narrowly accepted
  same-device corrections; publish a verified successor atomically. Withdrawal,
  erasure, changed authority and policy invalidation still revoke immediately.
- Prepare exact daily quota/plan and server-priced usage inputs once, retain
  restartable checkpoints, and reuse unchanged inputs in overlapping windows.
  Unrelated contributions do not force all historical work to restart.
- Skip raw acquisition, recalculation and publication for unchanged completed
  current/daily lanes. Semantic cache damage still schedules repair.
- Preserve graphs through classified temporary read failures. Admin reads have
  independent lanes, so an overview failure does not cancel the graph/progress
  reads. No age-only expiration or additional "last good" label was introduced.
- Preserve query-free progress schema v1. Exactly `?detail=preparation` opts into
  closed schema v2 with seven content-free counters. One read-only metadata
  query examines at most 10,001 heads; oversized, unsafe or unavailable totals
  become explicit unknown, not zero. No raw records or identifiers are returned.
- Keep the selected admin polling interval and hidden/offline pauses. The
  15-second request timeout is not a 15-second polling interval. Preparation
  counts describe retained work, not the remaining window or an ETA.

## Validation

The final clean source passed the complete Worker check: **915 tests in 67 files**,
**213 operations-script tests**, workspace-copy/endpoint/type checks, generated
admin-asset parity, and local/staging dry bundles. The production dry bundle
also passed. The full Web suite passed **578 tests**, with **57 focused admin
tests** and **4 generated-asset tests**. Counts overlap and must not be summed.
Documentation governance, all **20 preflight tests**, and the architecture
boundary check (405 production files, 1,653 imports, zero approved debt edges)
also passed.

Core qualification additionally exercised populated migration upgrades through
0053, exact raw/prepared arithmetic parity, replay and interruption, source and
lease races, erasure, no-op invalidation, maximum query fan-out, independent
failure lanes, and a disposable local HTTP acceptance run with 20 synthetic
participants. No private usage history was used. The initial core dry bundle
correctly rejected stale public-source provenance; regenerating the public site
from the clean core source fixed that artifact mismatch, after which all
remaining gates passed. No check was weakened.

The broad root run's two pre-existing R7 desktop freshness failures remain
outside this hosted release: baseline and candidate had the same 362-file
workload digest. The qualification record retains exact counts and digests.
No private-history regeneration or desktop rebuild was performed to change
those unrelated evidence results.

Synthetic rendered desktop/mobile checks showed counters advancing while
account completion stayed flat. Repeated injected progress failures preserved
the exact graph node and previously observed counters. There was no horizontal
overflow at 1440 or 390 pixels. Live authenticated rendering then verified the
new card alongside the actual production aggregate and per-model graphs.

## Live performance and progress observations

Three natural scheduled invocations observed at 02:33–02:35 UTC on the core
deployment completed without exceptions. Each skipped unchanged current
calculations (`visited: 0`, `published: 0`) and used one query for daily
publication checks. History phases used 216–230 queries and 16.201–17.773 seconds.

A final-deployment invocation observed at 02:56:04 UTC also completed without
exceptions: unchanged current work was skipped, daily publication took one
query, and historical preparation took 225 queries in 17.027 seconds. The
optional phases together used 268 queries and 20.693 seconds, leaving 19.307
seconds within the existing 900-statement/40-second budget. These are bounded
observations, not measured CPU, peak heap or whole-backfill throughput.

| UTC observation | Complete / tracked source days | Saved steps | Quota observations | Usage events |
| --- | ---: | ---: | ---: | ---: |
| 02:35:10, bounded metadata read | 13 / 14 | 448 | 72,536 | 31,941 |
| 02:43:34, bounded metadata read | 25 / 26 | 960 | 155,702 | 77,037 |
| 02:53, live admin detail | 34 / 35 | 1,600 | 268,010 | 126,676 |
| 03:00, live admin detail | 42 / 43 | 2,048 | 338,920 | 168,418 |

Historical completion still read 11 of 69 days, with 14 of 15 accounts complete
for August 27. The advancing preparation counters establish durable work while
that account result is pending; they do not establish that the day has finished.

## Public delivery and rendering

At 02:54 UTC the public daily endpoint returned HTTP 200,
`allowanceReadState: confirmed` and `Cache-Control: public, max-age=300`.
The requested June 1–September 7 window had 99 activity rows and the preserved
69-day allowance snapshot (July 1–September 7), generated at 02:02:43 UTC.
Preserving that publication across both deployments is intentional, not proof
that unfinished historical calculations have already been incorporated.

Public Aggregate, By plan and By model all rendered. Aggregate was USD 1,925;
model cards included Astra. The exact public response at 02:56 UTC contained
11 model-history days for GPT-5.5/Sol/Terra/Luna (August 28–September 7) and three
for Astra (September 5–7). Unsupported or unstable periods remain absent.
The authenticated admin aggregate/per-model graph and preparation card rendered;
the owner detail path returned 404 on the public host.

Deployed public bytes matched the generated candidate exactly:

- `community-data.js`: SHA-256 `be1fb58b5ce13bca02e5ed0c91d9a354e2d004ab3f2ebea62196ec013b4c557e`.
- `community.js`: SHA-256 `b7facd0f48d02d70f7e8541d7cfe6c0f1c349818b2f10929895aa4fba6873c31`.
- `release-site-manifest.json`: SHA-256 `1cfabbb8c44072524a4debb0d36751f1d0043ad5fe5052f4120c75869d7f6645`.

Canonical/Open Graph/Twitter metadata and crawler access were checked against
the live generated page. The retained social image remains a 1200×630 PNG,
served as `image/png`, digest
`eb3be41317460b924350e187de2aa4bd6fed3d015213db1cb814bd2225b1ea75`.
It is the existing preview, not a newly generated image. Both existing 0.1.18
Mac installer bytes and native-trust evidence were reverified by the site
builder and preserved. The live first-party cask was independently read back:
0.1.18 selects each architecture's matching public URL and exact release hash.

The completed implementation plan was retired after this receipt and the
maintained API, operations, status and installation guidance captured its result.
