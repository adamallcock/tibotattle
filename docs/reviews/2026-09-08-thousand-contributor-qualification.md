---
title: Thousand-contributor calculator qualification
date: 2026-09-08
type: review
status: locally-qualified-with-limits
source_base: f7e39920
source_commit: 690ab6c0e5f2f9f79fb17017b9244f996e1e9845
---

# Scope and claim boundary

This records isolated local Workers/D1 qualification on
`codex/scale-1000-contributors`, based on `f7e39920`. The qualified implementation
and clean-source dry builds are commit `690ab6c0e5f2f9f79fb17017b9244f996e1e9845`;
the following documentation-only commit records the final evidence. This is not
a production deployment, desktop release, completed live backfill or
traffic-capacity SLA.
Migrations 0054–0056 are prepared and tested locally; none was applied remotely.
No production data, consent, retention or v1.1 activation setting was changed.

The target is 1,000 contributing accounts, not 1,000 simultaneous HTTP uploads.
The maintained operational authority is the
[production runbook](../runbooks/production-operations.md).

## Implemented contracts

- Migration 0054 adds durable, coalesced dirty-account work. Indexed queue
  admission replaces repeated whole-population current-cache scans. Claims move
  an account behind its peers before expensive work, and acknowledgements require
  the exact claimed generation, source revision, day, method and maintenance
  lease. New input during work remains pending. Completed unchanged accounts
  are not reconstructed.
- Migration 0055 captures finite publication membership and complete authorized
  cache versions in restartable pages. Ordinary new uploads request a successor
  without restarting an unfinished capture or removing the saved graph. The
  capture is acknowledged only with actual publication. Erasure, consent and
  source-policy changes still fence both reading and promotion immediately.
  A captured generation is not misrepresented as the latest live source epoch.
- Cohort payload reads are batched. Captured-member and JSON-size queries use
  selected-member/key lookups rather than repeated scans of the remaining
  cohort. Publication remains bounded by its existing payload and query limits.
- Migration 0056 maintains exact preparation totals transactionally. The admin
  detail reads one aggregate row instead of scanning up to 10,001 account/day
  heads. Missing, unsafe or inexact counts remain unavailable, never invented
  zero. The browser accepts valid counts above 10,000.
- Historical work now uses its actual shared budget instead of stopping after
  16 cheap account attempts. Its optional final reread reserves the full bounded
  census so a nearly exhausted pass cannot replace completed progress with zero.
  Historical source/publication guards and the 1,024-eligible-account ceiling
  remain unchanged.

## Reproducible workload

From `apps/worker`, run `npm run test:scale`. The opt-in reporter emits one
content-free JSON record after each profile passes. Qualification requires exit
zero **and all three** contributor records: 100, 500 and 1,000. An earlier
successful profile is not evidence that a later profile succeeded.

The runtime is Node 26.2.0, Wrangler 4.114.0, Vitest 4.1.10 and the repository's
locked local Workers/D1 dependencies. Each profile starts with a freshly migrated
isolated database. Reviewed synthetic device, authorization and journal fixtures
contain real server-priced usage and quota curves, not precomputed fit caches.

Each account contributes five source days: 61 quota observations and 120 usage
events. The 1,000-account profile therefore starts with 181,000 source rows and
adds 200 inactive/source-empty registrations to test eligibility filtering beyond
1,024 physical registrations. Synthetic model capacities are $2,500 for Sol and
$900 for Terra; these are test inputs, not observed production allowances.

The harness checks:

- Full cold preparation and exactly one current publication per contributor.
- Scalar fits for every account against the unchanged raw-reference result,
  and every model composition against the reference and known capacities.
- Full-cohort preview publication and exact public daily allowance values
  recomputed from the independently checked scalar corpus.
- Three idle passes with zero source reads, zero writes and no reconstruction.
- Two adjacent closed historical dates, September 6–7, with all contributors,
  exact model values, no unstable/refused/stale accounts and no raw-record
  reacquisition. This is not a full 69-date backfill benchmark.
- A single accepted update recalculating only its account while preserving the
  saved preview; a further 10,000-event busy-account update and a small peer
  update completing without reconstructing the other 998 accounts.
- A new 1,000-member capture completing despite 32 interleaved accepted updates,
  including actual preview publication with the captured epoch older than the
  live epoch. The saved preview remains readable throughout. This is controlled
  interleaving, not simultaneous HTTP-load qualification.

Focused real-D1 suites separately cover replay, interrupted claims/checkpoints,
changed source and lease races, hard invalidation, populated migrations and
rollback, counter overflow, unavailable schema and refusal of a truncated cohort.

## Measurements

The final exact-assertion run passed all three profiles, with exit zero and
three measurement records, in 250.99 seconds including fixtures and assertions.

| Measured operation | 100 accounts | 500 accounts | 1,000 accounts |
| --- | ---: | ---: | ---: |
| Cold current preparation: passes | 10 | 50 | 100 |
| Cold current preparation: statements | 8,750 | 43,750 | 87,500 |
| Full-cohort publication: statements | 34 | 100 | 190 |
| Full-cohort publication: rows read | 9,764 | 53,092 | 106,450 |
| One saved public graph read: statements | 2 | 2 | 2 |
| One unchanged current pass: statements | 1 | 1 | 1 |
| One small account correction: statements | 75 | 75 | 75 |
| Two historical dates: passes | 10 | 48 | 97 |
| Two historical dates: statements | 8,134 | 40,973 | 82,058 |

At 1,000 accounts, cold preparation read 4,041,600 rows and wrote 582,003;
each pass used at most 875 statements. Two historical dates read 5,483,021 rows,
wrote 34,004 and used no raw-record queries. Their largest pass used 871
statements. Daily publication used three passes and 786 statements; the saved
public read used 25 rows, two statements and no writes or raw-record queries.

The small correction read 3,501 rows, wrote 205 and used two raw-record queries.
The busy-account plus small-peer work completed in one 301-statement pass,
reading 193,612 rows and writing 20,594. Its largest returned result was
1,387,251 serialized bytes. The continuous-arrival capture/publication used
317 statements over 50 deliberately one-page calls; none reconstructed raw
records. All scenarios retained the same authorized saved preview while work
was pending. Numerical busy-account correction results are not separately
oracle-checked by this scenario.

The largest reported database size was 438,640,640 bytes (about 418 MiB),
including the busy-account scenario. This is total fixture storage, not memory
usage or a full-retention capacity forecast. At 1,000 accounts, the measured
calculator calls totaled 44.589 seconds for cold current preparation and
35.604 seconds for the two historical dates. The longest measured current pass
was 4.379 seconds; the small correction was 21 ms. These local wall times do not
establish a production CPU, latency or catch-up-time claim.

Statement counts include every executed batch member. D1 metadata supplies rows
read/written and the peak reported database `size_after`. Result bytes count the
serialized returned rows, not network payloads or JavaScript heap. Measured
elapsed time covers calculator calls only: fixture insertion, oracle checks,
interleaved uploads and the wait between scheduled invocations are excluded.
Concurrent local test processes also affect elapsed time. No bindings, source
payloads, participant identifiers or real credentials enter the report.

## Validation and review

The final full Worker test run passed all 958 tests in 71 files, with no skips,
in 534.19 seconds. Package integrity (27 tests), endpoint/type checks, TypeScript
and all 220 operational-script tests also passed. Its following dry bundle step
correctly refused the uncommitted checkout. After the local commit, all remaining
segments passed separately: `npm run deploy:dry`, `npm run staging:check` and
the additional `npm run production:deploy:dry`. These are local default,
staging-configured and production-configured bundles, not deployments. The
staging configuration remains intentionally unprovisioned. No check was bypassed.
The strengthened exact-assertion scale run passed separately after its final
additional assertions.

The new worktree initially lacked generated public assets. The normal stager
verified and reused the prior 23-file generated site after all 17 public-source
file hashes matched the new clean source. Both existing 0.1.18 installer entries
and the social image were retained. The private admin bundle comes from the
current generated source, not that public asset tree. No renewed installer
native-trust verification is claimed. Each dry bundle reported 1,755.74 KiB
uncompressed and 367.66 KiB gzip.

Test verdict: **PASS WITH FIXES for the hosted scale scope**, with the explicit
production-capacity limits below. No success depends on dismissing a flaky
assertion or skipping a changed-code test. The broad root suite remains failed
on the two independently reproduced baseline desktop receipt checks below.

Completed supporting checks include:

- 81 combined historical/scheduler tests after the final budget-boundary fix.
- 67 publication/admin/preservation tests and 15 graph-recovery tests.
- 29 preparation-counter/prepared-reader tests and 50 queue/warmer/lane tests.
- 220 Worker operational-script tests, including real local migration streams,
  exact schema probes and populated forward/rollback rehearsals.
- 578 browser contract tests, architecture checks and TypeScript checks.
- Documentation/link governance and all 20 preflight tests.
- Synthetic admin rendering at desktop and 390-pixel width, with 169,000 tracked
  source days and independently preserved saved graphs. The actual client showed
  the large counts without horizontal overflow; this was not a live-site check.

These groups overlap and must not be summed as unique tests. Independent review
checked queue/invalidation, captured-publication complexity and authority,
counter/migration safety, and the scale harness's measurement and claim boundaries.

The complete root suite ran 3,967 tests: 3,944 passed, 21 existing platform-gated
tests skipped and two failed. Both failures are retained R7 desktop receipt
freshness checks and reproduce on the clean `f7e39920` baseline. Baseline and
candidate have the same 362-file workload digest:
`b91df4fcacffc39f5ec60d4e318bb98d55f35eecb3207beecdaf931d49911f06`.
No R7 receipt was rewritten and no test was disabled to make this change pass.
This does not claim a green desktop release gate.

### Failures found and corrected

- Counter triggers made D1 `meta.changes` unsuitable for acknowledging one
  prepared-head write. Three guarded mutations now use their own `RETURNING`
  row; exact transaction/authority tests still apply.
- Capture progress had repeated broad correlated JSON scans. Selected-member
  and exact-key queries remove that growth. A separate 1,025-member regression
  measured 100,768 rows read for capture and 2,135 for its progress-size query;
  assertions bound these below 120 and four rows per member respectively.
- The scale test exposed a historical final-census reread with insufficient
  budget. It preserved stored results but returned zero progress. The fix
  requires 20 query slots plus the existing 12-query final reserve. Both 16- and
  31-query-remaining regressions preserve completed progress and publish next
  pass without new analysis. No resource budget or source fence was relaxed.
- Scheduler/publication expectations and operational fixture metadata were
  updated for the new captured-generation/schema contracts. Authority, rollback,
  incomplete-cohort and no-op protections were retained rather than skipped.

## Capacity limits and next qualification gate

The 900-statement shared budget, 40-second optional-work admission deadline and
one-minute scheduled cadence are unchanged. A 1,000-account cold preparation
needs 100 dedicated passes in this workload. At one pass each minute that alone
is approximately 100 minutes, before competing maintenance, history and
publication work. Directly draining local calls does not measure that delay.
Saved authorized graphs remain available while successors are built; no initial
answer is fabricated when no valid publication exists.

Only five source days per account and two historical output dates were qualified.
Larger retained histories, different source mixes and sustained arrival rates
need separate tests. Historical final publication still requires its exact
global source fence, so continuous writes can defer a historical date even
though captured current publication continues. The historical eligible-account
ceiling remains 1,024; this work does not qualify larger cohorts.

D1 executes work within one database serially; adding parallel day workers is
not evidence of proportional throughput. Hosted query latency, Worker CPU/heap,
database growth over full retention, concurrent upload traffic and backlog
drain under the real schedule remain unmeasured. Cloudflare currently documents
a 10 GB maximum database size for the paid plan and 1,000 queries per paid
Worker invocation; this project retains its stricter 900-query budget.
See [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Before production activation, recheck the exact live schema/recovery position,
qualify the frozen source and both generated asset bundles, then apply only the
reviewed forward migrations through the normal deployment gate. Verify live
public/admin reads, saved-graph preservation and backlog progress separately.
A bounded continuation/queue scheduling design could reduce cadence waiting,
but is not implemented or qualified by this change.
