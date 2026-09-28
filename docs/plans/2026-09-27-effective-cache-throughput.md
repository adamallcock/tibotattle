---
title: Effective cache throughput follow-up
date: 2026-09-27
type: plan
status: production-observed-coordination-follow-up
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
- Full Worker regression passed: 164 files, 2,105/2,105 tests, 921.17 seconds.
  Workspace-copy, endpoint, generated-type, TypeScript and operations-script
  checks also passed. The combined command then stopped at the generic website
  packaging requirement for a clean committed release tree; website/staging
  asset gates remain unqualified. The command is not reported all-green.
- The clean local analytics candidate is commit
  `214a6d390c78aab1e6bac2d0edf627750fee4f7b`, based
  on production source `42e64933`; its four changed runtime and four test files
  are byte-identical to the qualified workspace. The candidate branch has not
  been pushed; production activation is recorded below.
- The analytics dry build using verified production bindings/settings passed.
  The pinned JavaScript is 1,367,754 bytes, SHA-256
  `e69863db6f35c9491cb18b4dc7503e3b84e0497dbf343f4c653bb26185966678`.
  Its upload configuration SHA-256 is
  `1cca72c2327c8dd4d7c505cdd035eb122498f301111c2060c02df19a402e4fc2`.
  Configuration values remain in private local operation files. This dry build
  confirms compilation, not live execution.
- The production canary must measure completed results, cache coverage,
  statements, duration and failures; advancing a checkpoint alone is not a
  completed result.

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

## Production activation on 2026-09-28

The owner authorized proceeding after the exact candidate deployment request.
Under the shared production coordination lock, fresh checks verified source
`42e64933`, the pinned artifact, bindings, runtime settings, cron and complete
analytics schema/migration ledger before upload and activation. No migration
was applied. The preceding version remains the rollback target listed above.

- Activation began at 04:42:03.356 UTC for source
  `214a6d390c78aab1e6bac2d0edf627750fee4f7b`.
- Version `599bad71-a603-493a-9d0b-27d77d283862` was confirmed active at 100%.
- Independent readback at 04:43:33.432 UTC confirmed source, version, bindings,
  runtime settings, every-minute schedule and schema preservation.
- The pre-activation aggregate at 04:40:15.555 UTC had 247 daily days queued,
  2,080 stored graph results and two effective prepared day entries.
- A bounded observer recorded 15 natural scheduled runs from 04:44:57 through
  04:58:57 UTC: 14 ordinary and one longer pass, zero exceptions, zero failed
  outcomes and zero reported lane failures. These logs contain no completed
  graph calculations or daily publications; they do contain three verified
  checkpoint advances by another invocation. No manual workload was submitted.
- The longer pass stopped after two checkpoint conflicts, using 751 statements.
  The counters do not establish how much work was duplicated or which run won.
- Readback at 05:01:42 UTC reconfirmed the exact version at 100%, source, bindings,
  runtime settings, cron and schema. The aggregate now had 244 daily days queued,
  2,081 stored graph results and 14 effective prepared day entries. This includes
  one more completed graph result than the pre-activation baseline, observed
  after the bounded tail ended. It is not a comparable throughput benchmark.
- The operation released its own shared production coordination lock at
  05:02:18.963 UTC after independently matching the active version and resources.
  A further bounded, read-only observer continues while the next local increment
  is developed; no production operation is left holding that lock.
- The extended observation detected failures after the clean initial sample:
  a 05:12 UTC checkpoint-load failure, a 05:13 scope failure, and exceptions in
  the 05:10 longer pass and the 05:14 ordinary pass. The longer pass reported
  `graph_model_compute / d1_other`, then `COLLECTION_CONTROL_UNAVAILABLE`.
  The exact deployed version, bindings and schema still matched at 05:15:56.
  Read-only probes at 05:16 returned successfully from both databases (analytics
  348 ms; ingestion 5,724 ms, including API transport). The 05:15 and 05:16
  scheduled runs subsequently reported no failures. The underlying error is
  not yet identified; neither the short clean sample nor resumed progress
  establishes sustained production reliability.
- The combined bounded observation ended at 05:24:52: 36 invocation records
  for 35 distinct scheduled times, with 33 `ok`, two `exception` and one
  `canceled` outcome. Four records reported a lane failure or exception.
  The canceled 05:19 slot later also produced an `ok` record. The last reported
  failure was at 05:14:01; the 05:20 longer pass finished with 836 statements,
  a normal query-budget deferral and no reported failure. No complete graph
  calculation was present in the captured logs. Both observers have stopped.
- At 05:23:40 the aggregate had 241 daily days queued, 2,081 graph results and
  24 effective prepared day entries. At 05:26:27 the exact format-3 checkpoint
  for the September 27 model had finished quota acquisition (48,291 observations)
  and entered usage processing. This is intermediate progress, not publication.
- At 05:36:48 the queue had fallen to 239 daily days (oldest January 31),
  with 2,083 stored graph results and 25 effective prepared day entries. The
  latest public model publication remained September 25. This is eight fewer
  queued days and three more stored results than the pre-activation baseline;
  it does not establish a comparable throughput multiplier.
- A temporary, non-persisted query of retained Cloudflare logs recovered the
  three content-free failure fingerprints. Static local matching identifies
  the scope failure as `ApiError:COLLECTION_CONTROL_UNAVAILABLE` and confirms
  the checkpoint-unavailable error. The `d1_other` model-compute fingerprint
  is unmatched; the original provider cause remains unconfirmed. No raw log
  message or participant identifier was retained in this evidence.

## Next increment: coordinate effective graph calculations

Source inspection of the deployed commit confirms that the existing graph work
lease is acquired only for owners with v1.1 history and no effective history.
Effective owners bypass selection and claim, so ordinary and longer invocations
can compute the same owner/day/metric concurrently. Checkpoint comparison still
protects promotion, but a losing invocation can spend statements before that
comparison refuses it. The 570-second longer-pass lease does not cover this path.

Extend the existing bounded work-selection envelope with a closed effective
variant and use the same claim, release and expiry lifecycle. Preserve legacy
v1.1 envelopes, full effective source recapture, correction and erasure checks,
and checkpoint comparisons. The existing table can hold the bounded envelope;
no new migration is planned. Qualify overlapping scheduler calls, a busy
contender doing no quota-page work, expiry/release, source changes, erasure and
v1.1 compatibility before preparing another production candidate.

The implementation also fences delayed inserts against erasure and stale
claims against deleted/recreated selections. Bounded graph retirement removes
old or erased-owner selections; both graph and final erasure completion require
their absence. The scheduler supplies the actual remaining statement allowance
after selection work so compute preserves its release reserve. Keep the
950-statement cap, schedule and analytical result/checkpoint identities.

### Lease qualification

- New effective-selection cases: 14/14 passed. Existing graph publication cases:
  35/35 passed. Retirement: 6/6 passed; erasure: 11/11 passed, including a
  delayed older writer leaving 33 selection rows across multiple cleanup pages.
- The waiting contender uses exactly nine actual D1 statements and reads zero
  quota pages while the winning invocation holds its lease. Selection creation,
  claim and release use five, four and two statements respectively. Fresh
  current-work setup uses 38 statements before compute.
- Synthetic 1,200-row cases with 950- and 560-statement allocations preserve a
  durable checkpoint and release the claim with at least 38 statements left.
  They prove the bounded lifecycle, not saturation of the outer cap or an
  elapsed-time speedup. Repeated busy-cohort scheduling cost is unmeasured.
- Review found no remaining source-fence, deadline or release-budget blocker.
  TypeScript, whitespace, documentation and preflight (20/20) checks passed.
- The full Worker command ran all 2,126 tests across 166 files: 2,123 passed;
  three exact-count assertions failed because bounded selection cleanup adds
  one statement to the existing retirement batch. No runtime source changed
  after this run. The two affected test files now expect 82, 160 and 79
  statements respectively (the grouped path still uses 41 round trips and
  retains its 840-statement bound); all 67 tests in those files pass on rerun.
  The original full command is not reported all-green.
- Workspace-copy, endpoint, generated-type, TypeScript and operations-script
  gates passed before the full regression. The eight original source/test
  files remain byte-identical in the candidate checkout. The candidate retains
  its deployed admin-cache compatibility variant and excludes migration 0027;
  only the three new accounting expectations are applied to its two existing
  test files. The exact candidate's five focused suites then passed 98/98 tests,
  covering claims, retirement, erasure and both affected projection pathways.
  Its analytics dry build remains pending. Production activation of this lease
  increment has not occurred.
- Read-only production verification at 05:44:27 UTC reconfirmed source
  `214a6d3` at 100%, with the existing bindings, runtime, schedule and schema.
