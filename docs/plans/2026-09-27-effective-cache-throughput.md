---
title: Effective cache throughput follow-up
date: 2026-09-27
type: plan
status: next-throughput-increment-in-progress
---

# Effective cache throughput follow-up

Latest state (September 28): corrected analytics source `32bd4091` is deployed
at 100%. The 10:10 UTC follow-up confirms advancing effective checkpoints and a
shrinking daily queue; completed graph throughput remains low. The retry and
follow-up evidence and the proposed next experiments are recorded at the end of
this plan. Earlier sections preserve preceding experiments and rollback evidence.

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
  Production activation after this qualification is recorded below.
- Read-only production verification at 05:44:27 UTC reconfirmed source
  `214a6d3` at 100%, with the existing bindings, runtime, schedule and schema.
- The 05:48:08 UTC aggregate recorded 237 daily days queued (oldest February 2),
  2,084 stored graph results and 25 effective prepared day entries. This is ten
  fewer queued days and four additional stored results than before activation.
  The latest model publication still remained September 25.

### Concrete lease candidate

The clean local candidate is commit `7cf653eea2ef778ecb8ff410d98375e7c4a69b45`,
based on deployed source `214a6d3`. It contains five runtime files, five test
files and the updated plan/runbook. The branch has not been pushed. All ten
runtime/test files are hash-pinned to the qualified candidate checkout.

The analytics-only dry build passed using the verified production configuration.
It contains the effective lease, live remaining-budget getter, 40-statement
release reserve and erasure-selection fence. The JavaScript is 1,373,406 bytes,
SHA-256 `1ea6ec023b6be1164b91131175e10d799a6c51f3700c4c96acc977e1aee6e78a`;
upload configuration SHA-256 is
`2f9b2f9f68074ad7c0f51a1c73546f9091dbb575d383d89c912680b6dfcd5cd0`.
These checks qualify this analytics artifact, not website or staging release
gates skipped after the original full command's count-assertion failures.

Read-only preflight matched the pinned artifact and live predecessor, complete
schema/ledger, bindings, settings and schedule. Rollback for this candidate is
version `599bad71-a603-493a-9d0b-27d77d283862`, source `214a6d3`. No migration,
new resource, schedule change or manual workload is planned. Additional
production deployment authorization was requested for this exact candidate
before the activation recorded below.

## Lease production activation on 2026-09-28

The owner explicitly approved deployment of `7cf653ee`. A fresh preflight
matched the clean candidate and pinned artifact, active predecessor, complete
schema/ledger, bindings, settings and cron before acquiring the shared
production coordination lock. No migration or manual workload was submitted.

- The pre-activation aggregate at 06:42:14.989 UTC recorded 228 daily days
  queued, 2,087 stored graph results and 44 effective prepared day entries.
  Public model publication had advanced to September 27 on the previous build.
- Activation began at 06:42:56.679 UTC for source
  `7cf653eea2ef778ecb8ff410d98375e7c4a69b45`.
- Version `c4a3cc05-a0ce-411c-a608-72fa37a05434` was activated at 100%.
- Independent readback at 06:43:14.657 UTC confirmed the exact active version,
  source, bindings, runtime settings, every-minute schedule and schema.
- Bounded observation of natural scheduled work began, including at least one
  longer pass. The shared operation lock was held during these checks;
  completed-result throughput and failure counts were initially unqualified.
- At 06:47:22 UTC the queue had 227 daily days and the effective cache had
  48 prepared dates, with 2,087 stored graph results. The first six captured
  runs were clean, without reported checkpoint conflicts. A lease observation
  at 06:49:48 found all effective selections pending, showing no active claim
  remained at that instant; at 06:51:53 one effective long-pass claim was active
  with 513,586 ms remaining. No leases were manually released or cleared.
- An aggregate-only, temporary Cloudflare telemetry query at 06:51:15 covered
  eight completed invocations of this exact version. Mean wall time was
  57,301.375 ms versus 950.875 ms of CPU; maxima were 62,044 ms and 1,831 ms
  respectively. This points to external-work waiting as a performance limit;
  it does not identify individual slow queries or prove D1 is the sole cause.
- At 06:53:37 two invocations reported lane failures while their outer outcomes
  remained `ok`: the longer pass reported `graph_model_compute / application`
  (fingerprint `818d3d27`), and a nearby minute pass reported
  `graph_scope / d1_cpu_limit` (`61b3db2c`). The longer pass used 683 statements
  and completed no graph result. These are failures even without an uncaught
  exception. The two fingerprints were absent from a retained-log query of the
  predecessor's 04:42–06:42 window; that does not establish a code regression
  because the underlying provider messages and individual queries are unknown.
- Independent readback at 06:55:39 again matched the exact active version,
  bindings, runtime, schedule and schema. Subsequent minute runs recovered
  without reported failures. At 06:56:54 the daily queue was 223, effective
  prepared dates 57 and stored graph results still 2,087. The September 26
  endpoint checkpoint advanced from ordinal 19,886 at 06:52:30 to 24,342,
  confirming further intermediate work after the burst. At that point the
  deployment remained active; no rollback or additional code change had been made.

### Failed canary and verified rollback

The initial observation ended at 06:58:42 with 15 invocations and two reported
lane failures. A bounded follow-up was started to check a second longer pass.
At 07:00:07 the model-compute failure `818d3d27` repeated, followed by
`COLLECTION_CONTROL_UNAVAILABLE` and an uncaught exception. This failed the
canary before a second longer pass could qualify it. The original provider
cause remains unidentified; no claim that the lease code caused it is made.

- The combined captured sample contains 17 distinct scheduled times: 16 `ok`
  outcomes and one `exception`, with three lane-failure records across three
  invocations. It contains no completed graph calculation or daily publication,
  and no reported checkpoint contention. Successful outer outcomes do not
  erase the caught lane failures.
- The last pre-rollback aggregate at 06:59:52 had 222 daily days queued,
  2,087 stored graph results and 57 effective prepared dates. The September 26
  endpoint checkpoint had reached ordinal 27,964. These are queue/cache and
  intermediate-checkpoint gains, not a completed-result throughput result.
- Rollback began at 07:02:17.904 UTC and verified at 07:02:19.818 UTC.
  Production again uses version `599bad71-a603-493a-9d0b-27d77d283862`, source
  `214a6d390c78aab1e6bac2d0edf627750fee4f7b`, at 100%.
- Independent verification at 07:04:04.479 UTC matched the active predecessor's
  exact version resources, binding identities, runtime, cron and complete
  schema/ledger. Cloudflare's latest-uploaded settings still label `7cf653ee`;
  the deployment and active version resources identify `214a6d3`. The earlier
  generic verifier's settings-source assertion therefore fails after rollback;
  no metadata write was used to manufacture a match.
- The operation released its exact shared production lock at 07:04:10.119 UTC.
  Both candidate observers have stopped. No migration, cache reset or manual
  lease deletion was performed; previous checkpoints and prepared data remain.
  Candidate `7cf653ee` remains a clean local, unpushed commit for diagnosis.
- A temporary, version-filtered retained-log query at 07:06:02 found two
  restored-version scheduler logs reporting completion without lane failures.
  One recorded one completed graph calculation and 615 statements; the other
  recorded zero calculations and 286 statements. This confirms resumed work,
  not sustained reliability or a comparable performance benchmark.
- The final aggregate at 07:06:42 UTC showed 220 daily days queued, 2,088 stored
  graph results and 60 effective prepared dates. Public model publication
  remained September 27. The stored-result count independently confirms one
  additional result since the deployment baseline; it arrived after rollback.

The next performance gate is to identify the failing query or provider operation
and qualify it on representative data before another deployment. The measured
CPU/wall-time split supports reducing external waits, but no production
throughput multiplier or sustained-reliability improvement is established.

## Investigation and authorized retry (September 28)

The owner explicitly requested investigation followed by another production
deployment. A read-only check at 08:24 UTC confirmed restored source `214a6d3`
at 100%, with unchanged bindings, runtime, cron and schema. At 08:23 UTC the
queue contained 204 daily dates and 2,094 stored graph results.

- The `818d3d27` token exactly matches
  `TypedTelemetryError:TYPED_TELEMETRY_UNAVAILABLE`. The same token occurred six
  times in retained logs from the restored version after rollback. It is not
  specific to the lease candidate. The typed reader discarded the underlying
  cause, so historical logs cannot distinguish a provider failure from an
  intentional inner query-budget refusal.
- Local tests reproduced that masking through all three typed-reader entrypoints
  using a real invocation meter. The correction preserves the private,
  non-enumerable cause and lets the graph boundary retain budget/deadline
  deferrals and closed provider classifications. Outward error codes and privacy
  remain unchanged; raw provider messages are not logged.
- `61b3db2c` exactly matches the documented D1 CPU-limit/reset error. D1 query
  Insights for 06:00–08:00 UTC showed the dependency query averaging 6.12 seconds
  and 33.46 million rows read. Effective candidate/source queries averaged
  1.3–2.1 seconds and 19–29 million rows read.
- Live `EXPLAIN QUERY PLAN` identified owner-only record scans before decoding,
  plus a repeated compact-admission completeness lookup using only namespace
  from the `(namespace_id, format, original_id)` chunk index. The candidate adds
  physical stream/time bounds, collapses outside-window dependency rows to the
  required chunk headers, and includes the proven `format=11` constraint in the
  shared completeness lookup. Original admission, owner, decoded-source and
  cross-day conflict checks remain. No migration is needed.
- A paired read-only query at 08:39 UTC returned identical dependency rows under
  an unchanged owner revision: 3,734,682 rows read and 1,985 ms for the proposed
  SQL versus 33,521,609 rows and 6,217 ms for the old SQL. This is one measured
  query comparison (8.98 times fewer rows, 3.13 times faster), not end-to-end
  production throughput. Worker validation, exact analytics artifact
  qualification and a natural scheduled canary remain required before declaring
  this retry successful.

### Qualified retry candidate

- Isolated candidate: `32bd409178ab6b0bca6588afeef4385449132459`, based on the
  rolled-back lease candidate and retaining the production schema compatibility
  adapter. The main checkout's unrelated changes were preserved.
- Focused validation: 42 error/typed-reader cases and 33 integrated dependency,
  effective-reader and compact-proof cases passed. Independent source review
  found no concrete semantic or schema-boundary blockers.
- The final source-derived query comparison at 08:40 UTC returned identical
  dependency bytes under an unchanged owner revision: 3,734,682 rows / 1,870 ms
  versus 33,521,609 rows / 5,912 ms. Synthetic tests independently cover
  nonempty outside-day conflict headers and partial/missing proof refusal.
- Exact analytics dry-build artifact: 1,376,916 bytes, SHA-256
  `809a80faef905ac00211222cabc2f893f4fb3d78d1247e5dde472eded067d69c`.
  Read-only production preflight matched the active predecessor, bindings,
  runtime, cron, complete schema and migration ledger. The query cap remains
  950 and the delivery catch-up boost remains absent.
- Subsequent validation and production activation are recorded below; the
  website artifact gap remains distinct from the qualified analytics build.

### Retry activation and verification

- The full Worker Vitest run passed all 2,138 cases across 167 files. Workspace
  package, endpoint, generated-type, TypeScript and script checks passed. The
  umbrella command then stopped at the unrelated website asset stage because
  the isolated checkout lacks the generated public release manifest. General
  website/staging dry builds remain unqualified. The exact analytics dry build
  passed and its active/configured resources have no website assets binding.
- Under the owner's retry authorization, activation began at
  2026-09-28 09:04:51.973 UTC. Version
  `b488c666-0903-448d-a178-066cd9d8d9fd`, source `32bd4091`, is active at 100%.
  Independent readback at 09:05:06.857 UTC matched its exact version resources,
  bindings, runtime, minute schedule, complete schema and migration ledger.
- The pre-activation aggregate at 09:04:07 UTC contained 195 queued daily dates,
  2,096 stored graph results and 65 prepared effective dates. Public model
  publication remained September 27.
- Natural-run observation targeted at least 16 ordinary invocations and two
  completed long-pass logs, with rollback source `214a6d3` pinned. No migration,
  forced run, cache reset or manual lease deletion was performed.

### Initial retry canary completed

- The version-filtered observer captured 18 distinct scheduled invocations
  between 09:05:50 and 09:22:49 UTC: 16 ordinary runs and two long passes. All
  reported `ok`; there were zero uncaught exceptions, emitted lane failures or
  scheduler graph-failure fields. Statement counts ranged from 42 to 707,
  below the unchanged 950 cap. The observer exited successfully and stopped.
- One graph calculation completed, independently confirmed by the stored-result
  count. It was a current-day v1 fit. The long passes at 09:10 and 09:20 both
  ended successfully; only the first produced a new graph result. These short,
  mostly idle runs do not qualify sustained effective-data processing.
- Aggregate observations bracketed the deployment as follows. Publication runs
  in its separate Worker, so the daily-queue change is system progress during
  the observation window, not an isolated benchmark of this analytics change.

| Aggregate | 09:04:07 UTC baseline | 09:23:37 UTC final sample |
| --- | ---: | ---: |
| Daily dates queued | 195 | 189 |
| Oldest queued date | March 16 | March 22 |
| Stored graph results | 2,096 | 2,097 |
| Effective prepared dates | 65 | 65 |
| Latest public model day | September 27 | September 27 |

- The sampled effective checkpoint cursors did not advance. A bounded aggregate
  check found 52 eligible public owners, two with effective inputs. The existing
  pending effective selections belong to one currently eligible public owner;
  their age cannot be dismissed as work for an ineligible owner. This remains a
  concrete performance gap to investigate through selection/deferral evidence.
- Final active-version verification at 09:23:38.264 UTC matched version
  `b488c666-0903-448d-a178-066cd9d8d9fd`, source `32bd4091`, at 100%, with the
  same bindings, runtime, schedule, complete schema and migration ledger.
- The operation released its exact deployment coordination lock at
  09:24:06.981 UTC. The candidate remains a clean local commit. The main
  checkout retains the implementation and this updated evidence.

The authorized deployment retry is complete and its initial stability sample is
clean. The paired query is approximately 3.16 times faster, but this canary does
not establish an end-to-end speedup or reliable completion of the heavy effective
path. The remaining performance gate is observed effective checkpoint advancement
and completed results under representative scheduled work.

## Follow-up progress and proposed next steps (10:10 UTC)

This is a read-only assessment requested by the owner. Version `b488c666`,
source `32bd4091`, was reverified at 10:10:43 UTC with unchanged bindings,
runtime, schedule and schema. No implementation or production setting changed
for this assessment.

| Signal | Previous sample, 09:23 UTC | Follow-up, 10:10 UTC |
| --- | ---: | ---: |
| Daily dates queued | 189 | 169 |
| Stored graph results | 2,097 | 2,098 |
| Effective prepared dates | 65 | 69 |
| Current effective fits source cursor | July 10 / ordinal 4,422 | August 15 / ordinal 15,385 |
| Current effective model source cursor | July 27 / ordinal 9,422 | August 21 / ordinal 17,014 |
| Latest public model day | September 27 | September 27 |

The queue contracted by 20 dates in approximately 47 minutes (about 25 per hour
in this interval). This is an observed rate, not a completion forecast. The
checkpoint dates describe source-history acquisition, not completed graph dates
or a percentage complete. A 10:16 UTC result census identifies both graph results
created since activation as v1 fits; no new effective graph completion is proven.

Retained logs for 09:23:38–10:12:25 contain 44 ordinary and five long schedule
records, with zero recorded lane failures or matches for the prior collection
control, generic typed-unavailable and D1 CPU-limit error signatures. Samples
include ordinary query-budget deferrals and many idle completions. This log
query is not a claim that every service or exception type was exhaustively audited.

### Measured remaining costs

- D1 Insights for the elapsed portion of the 10:00 UTC hour show the effective
  dependency query averaging 1,517 ms and 3,055,313 rows read over 108 calls,
  with about 164 seconds of aggregate SQL time. The query is substantially
  improved but still dominates the sampled source query costs. These database
  statistics include all callers, rather than a per-Worker CPU profile.
- The leading sampled analytics query is the v1 retirement delete: 171 calls,
  99 ms and 27,521 rows read per call, with zero rows written. Separately,
  schedule logs show 174–210 statements spent on sweeps in some runs with no
  graph completion. The runtime repeats those sweeps inside its iteration loop.
- Some long passes used only 125–135 total statements, while others used
  737–748. Selection records and cursor movement show pending work still exists.
  The exact reason each pass ends must be distinguished before changing
  scheduling; an idle outer result is not proof that the entire backlog is empty.
- Both source and analytics D1 databases report read replication disabled. The
  deployed source calls `withSession` only through its forwarding adapter, not
  from a reader, so enabling replication alone would not route current reads.

### Recommended experiments, in order

1. **Reduce repeated dependency validation.** Profile the remaining completeness
   and linked-source lookup, then compare improved indexed SQL and reuse of
   immutable dependency evidence within one invocation. Retain fresh owner,
   correction, erasure and publication checks. Require exact dependency hashes,
   source-change refusal and lower rows/time on the same corpus.
2. **Remove repeated idle cleanup and selection work.** Bound retirement per
   pass and stop retrying a cleanup lane after it reports no work, while keeping
   erasure and capacity cleanup live. Record closed graph selection/deferral
   reasons and test whether an empty history selection can safely yield to
   pending current work in the same pass. Measure saved statements and durable
   progress, including protection against starvation and competing claims.
3. **Complete effective-day preparation deliberately.** Existing page grouping,
   all-phase quota preparation, batched dependency headers and effective leases
   are already deployed. The next experiment is bounded preparation of missing
   exact owner-days, potentially extending the existing builder to effective
   inputs, then a warm calculation of adjacent result days. Include preparation
   cost; a larger cache alone does not prove a faster completed result.
4. **Dispatch independent jobs with bounded concurrency.** Use explicit
   owner/day/metric/dependency jobs, initially compare concurrency 1, 2 and 4,
   and preserve one writer per mutable checkpoint. A durable dispatcher must
   recover missing, expired and duplicate deliveries. Judge completed outputs,
   database latency and public-service health. Queue consumer instances provide
   concurrency without requiring a separate deployed script per job.
   [Cloudflare Queues concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/).
5. **Trial replica reads when query demand justifies them.** Integrate Sessions
   for stable pinned input reads and retain fresh authority/final checks. Verify
   actual routing and compare throughput. Replicas forward writes to the primary
   and do not raise the invocation query allowance.
   [D1 replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
   and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Keep the analytics cap at 950 for these comparisons. Publication and the v1.1
prepared-day builder already have separate Workers. R2 checkpoint storage,
database sharding and a separate batch service remain later options if measured
storage or primary-database capacity dominates after these changes. The next
bounded implementation should combine dependency-query profiling with the
cleanup/selection experiment before multiplying concurrent database demand.

## Authorized implementation scope (September 28, 10:22 UTC)

The owner approved proceeding with the first two options in the user-facing
recommendation: reduce repeated database/cleanup/scheduling work, then complete
effective-day cache coverage. Queue-based parallel jobs (option 3) and D1 read
replicas (option 4) are explicitly retained as later enhancements. This increment
keeps the existing single-checkpoint writer, deployment topology and 950 cap.

Acceptance for the current increment:

1. Compare dependency SQL against source `32bd4091` on identical synthetic
   inputs, including incomplete admissions and cross-day conflicts; preserve
   exact dependency output and reduce physical rows read.
2. Bound repeated idle retirement and improve selection of runnable work without
   starving cleanup, erasure, current results or historical results. Preserve
   lease and checkpoint head fences and expose only closed aggregate diagnostics.
3. Identify the smallest bounded way to complete missing effective days, measure
   its preparation cost and prove a subsequent complete warm calculation. Retain
   source/correction/authority invalidation and interrupted-write recovery.
4. Run focused regressions, then the owning Worker gate and exact analytics dry
   build. Keep source, artifact and production qualification separate.

Implementation ownership is split across dependency SQL, runtime/selection and
effective cache coverage; tests run serially. The deployed `32bd4091` commit is
the comparison baseline, and existing main-checkout changes are preserved.

### Measurements during implementation

- At 10:32 UTC, the existing production version had 161 publication days queued,
  2,098 completed graph results and 69 effective prepared owner-days. The fits
  acquisition cursor had reached August 23 and the model cursor August 31.
  These are baseline observations while the new increment is local.
- The first dependency-query rewrite reduced rows in a small synthetic fixture
  but regressed in paired, read-only production queries under an unchanged owner
  revision. The 100-day query read 4,135,580 rows versus 3,734,682 on `32bd4091`;
  the single-day query read 3,270,950 versus 3,031,824. All returned dependency
  rows matched. That rewrite was rejected and its source changes removed.
- At 10:37 UTC, the read-only selection portion of the v1 retirement query found
  zero candidates in both versions. Starting with terminal owner fences read two
  rows in 0.47 ms; the deployed join read 27,518 in 115.90 ms. No deletion was
  executed remotely. Full deletion semantics and scheduler effects require local
  tests; this is not an end-to-end production throughput measurement.
- At 10:42 UTC, a read-only comparison of effective checkpoint inventories and
  cache-head presence found the same missing input date, June 21, in every
  sampled active effective scope. The September 28 window has 69 quota dates,
  one absent date already behind the active cursors, and 4,858,856 bytes of
  retained cached payloads. The September 27 window has 70 dates, the same hole
  and 4,881,738 bytes. These byte counts are below the 8 MiB admission bound;
  head presence alone does not establish current dependency validity. The
  missing date is the adopted mid-day cursor in the original model checkpoint,
  making targeted prefix preparation a concrete recovery opportunity.
- The second query candidate retains deployed completeness/admission checks and
  compares full canonical occurrence BLOBs before compatibility decoding. At
  10:48 UTC, a paired read-only probe under an unchanged owner revision returned
  identical dependency bytes. A single-day query read 1,123,324 rows in 355 ms
  versus 3,031,824 in 1,734 ms; the 100-day query read 3,571,266 in 1,477 ms
  versus 3,734,682 in 2,037 ms. These are one paired observation per scope,
  not an overall processing multiplier. The dependency/completeness suite passes
  34/34, including every source family, correction links, incomplete proofs and
  compact/raw identifier distinctions.
- The complete cleanup/selection test set passes 134/134. Its repeated busy-work
  scenario reduces empty core sweeps from 256 to eight statements over 32
  attempts. A synthetic v1 empty deletion reads five rows versus 27,530 under
  the old SQL, with one statement and zero writes in both cases. Useful erasure
  drains remain bounded to 200 rows; withdrawal/source isolation, mandatory
  capacity and ledger cleanup, round-robin selection, live leases and scan CAS
  remain covered. TypeScript also passes at this checkpoint.

### Local qualification of the next increment

The final cache implementation independently fills a known missing prefix with
one bounded page between analytical steps. It checkpoints a completed reduced
day before an optional cache write; interrupted or budget-deferred writes retain
that ready value. Format 4 adopts formats 3, 2 and the original checkpoint while
leaving the older heads available for rollback. Owner authority, dependency
identity, result identity, the 950 cap and deployment topology are unchanged.

- Codec and compatibility checks pass 29/29; cache checks pass 10/10. All 42
  graph integration cases were verified: the combined run passed 51/52, and the
  sole forced-CAS test required its old four-page expectation to reflect the
  new one-page independent preparation boundary. Both CAS variants pass on
  rerun, retaining their competing-head and final-result assertions. The full
  candidate Worker gate is running; this focused result is not that gate.
- The exact deployed-source dense benchmark uses 6,001 quota records over five
  days plus 120 usage records. Cold plus two warm results cost 1,056 statements
  on source `32bd4091` and 1,097 on the candidate, a 3.9% increase. The cold
  result costs 725 versus 764; warm results cost 166/165 versus 167/166. Cold
  source reads remain 31 quota pages. The added durable preparation boundaries
  cost writes; no end-to-end speedup is claimed from this fixture.
- A separate missing-prefix experiment compares the same candidate with optional
  gap filling disabled and enabled, not the deployed source. Exact outputs are
  equal. The current result costs 290 versus 295 statements, the following fit
  219 versus 167, and two adjacent results remain 166 and 167. The four-result
  total falls from 842 to 795 (5.6%); the current quota page count falls from
  eight to six and all three following results need zero quota pages. The
  synthetic one-gap shape matches the observed missing June 21 prefix, but its
  timing is not a production forecast.
- The small cold fixture uses 380 statements with preparation versus 405 without
  it. Ready-cache writes resume without source rescans; many-part interrupted
  successors, response loss, bounded refusals and exact source-fence changes
  pass. Unfinished optional preparation may be dropped when analytical
  acquisition completes; completed ready values remain durable.
- Independent reviews found no actionable correctness issues in the SQL,
  scheduler, retirement or cache changes. Source review and synthetic tests
  remain separate from production verification.

Queue-based parallel jobs (user-facing option 3) and D1 replica reads (option 4)
remain explicitly deferred until this increment has a measured production result.
