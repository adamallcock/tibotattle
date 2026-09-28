---
title: Effective cache throughput follow-up
date: 2026-09-27
type: plan
status: in-progress
---

# Effective cache throughput follow-up

The owner requested further performance work after the production canary for
source `42e649333dcc04050214841089736692ac36d87b`. The read-only observation at
2026-09-28 03:53 UTC confirms that version remains active: 253 daily days queued,
2,073 stored graph results, and only one prepared effective quota day. The
current operational authority is [Production service operations](../runbooks/production-operations.md).
The previous optimization is described in the [analytics qualification](../research/2026-09-27-analytics-throughput-options.md).

A later read-only sample at 2026-09-28 04:22 UTC still verified source
`42e64933` at 100%: 249 daily days queued, 2,079 stored graph results, nine
results in the preceding hour and two effective cache days. This is progress
on the previous deployment, before the increment described below.

## Scope and acceptance

1. Prepare missing quota days alongside the existing later acquisition scans,
   starting only at a day boundary and storing only complete days. Avoid
   repeating preparation for an exact valid cached day. Retry the whole-window
   fold when this scan completes cache coverage, within the existing budget.
2. Isolate the expanded pending-checkpoint format with storage digest domain 3,
   retaining recognized method names. Adopt domain 2 before original checkpoints;
   preserve prior heads and tombstones for rollback.
3. Benchmark identical synthetic inputs starting mid-plan, in fitability and
   in endpoints. Count source/target statements, checkpoint work and completed
   results, including preparation cost. Require exact result equality,
   bounded memory, source/owner fences, and the existing 950-statement cap.
4. Batch bounded source dependency headers across the selected window. Preserve
   exact per-day occurrence links, dependency digests and fallback bounds.
5. Run focused regressions, then the owning Worker validation and an analytics
   dry build. Record a concrete candidate and measured limitations before any
   further protected production operation.

## Main risks

- An adopted checkpoint can begin midway through a day; a partial prefix must
  never become a complete cache day.
- Pending preparation adds checkpoint bytes and writes; late preparation may
  cost more than it saves for the current result. Measure adjacent-result reuse.
- Old Workers must keep recognizing the method names without reading the new
  pending format. No tombstone or prior head may be overwritten for migration.
- Cache availability may change during retries. Exact-head promotion and
  interrupted-save recovery must remain authoritative.

## Implemented increment

- Prepare complete missing days in every quota acquisition phase. Reuse exact
  valid days and refuse preparation from an adopted partial-day suffix.
- Read the schema and source header vectors once per window, with a shared
  30,000-row / 4 MiB bound. Keep occurrence links as exact lazy day queries;
  whole-window links cannot safely be split into equivalent day identities.
  Check deadlines before each shared query and preserve the paged fallback.
- After successful preparation completes validated coverage, allow the current
  invocation to fold its remaining quota phases. Normal misses are not probed
  again after every page.
- Write digest format 3; adopt format 2 before original checkpoints. Existing
  method names, source/result identities, rollback heads, erasure and retention
  rules remain compatible. No new migration or Worker is required.

## Measured local results

The dense synthetic corpus contains 6,001 quota observations across five days
and 120 usage events. Both revisions use the 950-statement cap. Counts include
source validation, cache preparation, checkpoint work and result publication;
fixture setup is excluded. Outputs are exactly equal.

| Calculation | Deployed-source benchmark (`42e64933`) | New candidate | Change |
| --- | ---: | ---: | ---: |
| Cold model | 941 statements, 2 invocations | 725 statements, 1 invocation | 23.0% fewer statements |
| Warm fits | 185 | 166 | 10.3% fewer |
| Adjacent-day model | 184 | 165 | 10.3% fewer |
| Total | 1,310 | 1,056 | 19.4% fewer |

The original paged baseline uses 5,776 statements across these three jobs.
The new candidate uses 81.7% fewer; its warm jobs use about 11.6 times fewer
statements. These are database-work ratios, not measured production speedups.
Cold quota source pages fall from 44 in the deployed-source benchmark to 31;
both warm jobs read zero quota source pages.

The synthetic 101-day cache-load test passes a 230-statement upper bound
(at least 720 left), compared with the earlier measured 711. A stale final day
is detected within 120 statements (at least 830 left), versus the earlier 609,
before reading any cached payload or source payload. Rebuilding that day while
retaining both immutable heads again passes the 230-statement bound. This
fixture uses 100 empty prepared dates and one populated v1.2 day to isolate
validation overhead; it is not a dense production-window benchmark. The final
run retained passing assertions, not the exact printed counters.

Separate interrupted-job comparisons isolate preparation in later phases.
Both controls use the new dependency batching and same-invocation loader;
only the allowed preparation phases differ. Each uses 1,201 quota observations
over five days, identical staged format-2 seeds and exact output comparisons.
The current-job count includes the interrupted pass and its completion.

| Starting phase | Current job: plan-only / all phases | Next job: plan-only / all phases | Combined saving |
| --- | ---: | ---: | ---: |
| Mid-plan | 751 / 404 | 730 / 165 | 61.6% |
| Fitability | 430 / 415 | 393 / 165 | 29.5% |
| Endpoints | 293 / 388 | 393 / 165 | 19.4% |

Late preparation has a real cost. Starting in endpoints adds 95 statements and
393,825 attempted checkpoint payload bytes to that current job, then saves
228 statements on the adjacent job. In the dense cold case, attempted checkpoint
payload bytes total 3,023,155 versus 360,966 for the original pager, while part
INSERTs fall from 105 to 56. This write amplification and production latency
must be observed during a canary; statement savings alone do not settle them.

## Qualification and remaining gate

- Compatibility and codec tests: 18/18 passed. Dependency tests: 25/25 passed.
- Final selected integration cases: 6/6 passed, including dense and interrupted
  phase comparisons, immediate reuse and a successor exceeding 30 parts.
- Independent source review found no remaining blocker. The deadline gap found
  during review was fixed and covered before the runtime was frozen.
- TypeScript, documentation checks, preflight (20/20), diff checks and the
  disabled, unbound analytics example dry build passed.
- Full Worker regression is running against the frozen runtime. The existing
  analytics candidate is based on production source `42e64933`; runtime and test
  files are byte-identical to the qualified workspace. Its commit and exact
  production-configuration dry artifact remain to be recorded.
- No new production change has been made in this follow-up. A production canary
  must measure completed results, cache coverage, statements, duration and
  failures; advancing a checkpoint alone is not a completed result.

## Online comparison after authorization

Use the existing analytics Worker, 950-statement cap and every-minute schedule.
Preserve the current bindings, runtime settings and database schema. The rollback
target is version `6f675340-66e4-4344-abab-ee0072f3bd86`, source `42e64933`.
Pin the exact candidate artifact and recheck the live predecessor before any
upload or activation. No migration or manual production workload is needed.

Observe natural scheduled work through at least one longer graph pass. Separate
cold cache preparation from reuse: record complete result counts, exact
checkpoint movement, prepared day coverage, query counts, duration and failure
counts. A short cold sample can establish safety and preparation progress;
claim a throughput multiplier only from comparable completed work after reuse.
