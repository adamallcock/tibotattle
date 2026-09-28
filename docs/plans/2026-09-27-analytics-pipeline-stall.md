---
title: Diagnose stalled daily publication and allowance graph
date: 2026-09-27
type: plan
status: progress-restored
---

# Analytics pipeline stall

This is a point-in-time production observation and an investigation plan. The
maintained operational authority is [Production service operations](../runbooks/production-operations.md).
The owner subsequently authorized end-to-end repair on 2026-09-27. This record
does not establish a completion estimate.

## Initial observations on 2026-09-27

- Ordered delivery had caught up in the owner dashboard after the temporary
  delivery catch-up setting was disabled. The local rollback is commit
  `e6700871` on an unpushed branch; this investigation made no further code or
  production changes.
- The separate publication Worker was enabled. A read-only analytics database
  query found 363 queued days, from 2025-09-22 through 2026-09-26. Its latest
  publication timestamp was 2026-09-26T02:36:40.842Z.
- Across 18 observed publication schedules from 16:47:54Z through 17:04:54Z,
  none reported a published day. One reported `daily_publish` failure classified
  as `d1_cpu_limit`; the others reported unavailable without a classified cause.
- Across 61 observed analytics schedules from 16:03:54Z through 17:03:54Z,
  one graph result completed. Repeated graph failures were classified as
  `d1_cpu_limit`, predominantly during `graph_scope`. The failure correlation
  token matched the publication lane's classified failure, but the exact SQL
  statement has not been identified.
- A separate read-only ingestion database metadata query returned provider error
  7429. A simple constant query succeeded. Cloudflare describes the CPU-limit
  error and recommends smaller queries or reduced work per query in its
  [D1 debugging guide](https://developers.cloudflare.com/d1/observability/debug-d1/).
- D1 query insights for successful calls in the same hour showed the retained
  v1.1 quota page query in
  [typed-v11-quota-reader.ts](../../apps/worker/src/typed-v11-quota-reader.ts)
  averaged about 275,000 rows read and 316 ms across ten calls. Insights did
  not identify the statement that failed with error 7429, so this is a
  performance lead rather than the established cause of either lane's failure.

The dashboard's “Publishing” badge expresses queued work after delivery; it is
not a publisher-health signal. Its abbreviated day range omits years. The graph
counter measures completed results, so it cannot by itself show checkpoint
progress.

## Next investigation

1. Correlate read-only D1 query insights and bounded metadata with the failing
   lane and database. Keep raw rows, identities, query bindings, and full
   provider errors out of reports. Check the retained quota page and the
   common owner-selection path without assuming either caused the failures.
2. Reproduce the identified path with synthetic, production-shaped data; inspect
   its query plan and size. Change only the proven expensive query or its index,
   preserving owner authority, retention, replay, and source-change checks.
3. Run focused Worker tests and the retained Worker gate. Treat code deployment
   and any forward-only D1 migration as separate approval gates.
4. After an authorized production change, verify consecutive scheduled passes:
   the daily queue shrinks, graph results complete, and CPU-limit failures stop.
   Check publication freshness independently of completion counts.

No throughput estimate is justified while the failures recur.

## Authorized repair, 2026-09-27

- Preserved and temporarily removed the analytics and publication minute
  schedules at 17:22Z to stop overlapping failing retries. Both schedules must
  be restored and verified before the repair is complete.
- Once in-flight work cleared, owner selection completed in 14 ms. There are
  52 eligible owners; two use the effective-history reader.
- A sequential, read-only reproduction of the daily dependency reader found
  its first five metadata statements completed in under 3 ms of database time
  each. The occurrence-link statement then exceeded the 35-second request
  limit. No record bodies or owner identities were exported.
- Repair the query while preserving exact retained-history dependencies,
  validate its synthetic correctness and read cost, then deploy scoped
  scheduled-worker bundles. Verify live daily and graph progress after
  restoring both schedules.

## Repair prepared and validated

- Candidate commit `ba7f00b28a32cc839f420db32dec7009b31e884b` is on
  `codex/analytics-pipeline-repair`, based on the deployed analytics source
  `960f75ab55d29fc866be32e81f83feba77b944e0`. It includes the delivery boost
  rollback and the effective-history query repair. The candidate was committed
  with a clean tree and has not been pushed. Production activation is recorded
  below.
- The dependency and effective-page readers now select the requested owner
  before reading typed records through the owner index. Complete chunks are
  materialized once per scoped owner instead of counted repeatedly per record.
  Retained-generation, authority, conflict, and publication-fence checks remain
  intact. No database migration is required.
- A synthetic regression adds 600 unrelated-owner records and bounds the extra
  read cost of dependency, usage, quota, session, and inventory reads. It also
  preserves the outside-day occurrence link and explicit conflict behavior.
- Read-only production reproductions of the repaired dependency query completed
  in approximately 0.1 to 8.4 seconds; the previous query exceeded 35 seconds.
  Repaired page reads also completed. These measurements do not establish
  scheduled-worker throughput.
- The complete Worker suite passed all 2,000 tests. The original checkout's
  broader Worker command then stopped at the generic web-asset deployment dry
  run because that checkout was dirty. In the clean candidate, TypeScript,
  generated-type and workspace-copy checks, 111 focused reader/scheduler tests,
  and both exact scheduled-worker bundle dry runs passed.
- After committing the repair locally, the generic web-asset dry run remained
  blocked by this checkout's missing generated public release manifest. The
  complete retained command is therefore not reported as passing. The two
  asset-free scheduled-worker bundles passed their separate dry runs and were
  deployed as recorded below; the public website was not deployed.
- A build comparison against the older deployed publication source verified
  that unrelated intervening source changes do not enter its compiled bundle.

## Authentication interruption, 18:07 UTC

- Wrangler's saved OAuth credential could no longer refresh. Version upload
  stopped before creating or deploying a repaired Worker version.
- Both original `* * * * *` schedules were restored through the authenticated
  Cloudflare dashboard before 18:07 UTC. The diagnostic pause is over. The
  analytics delivery boost remained disabled; the query repair was not yet live.

## Production activation and verification, 18:44 UTC onward

- An existing Keychain API credential resolved the authentication interruption.
  Both pinned scheduled-worker bundles were uploaded and activated at 100%,
  with source revision `ba7f00b28a32cc839f420db32dec7009b31e884b`:
  - Analytics version `7b4fff1a-7128-4bc3-aaa3-4ac5acd2e51b`, activated
    at 2026-09-27T18:44:29.772Z.
  - Publication version `d1c3360a-1708-49bd-bb87-19bd3ea8a609`, activated
    at 2026-09-27T18:44:56.841Z.
- Verified unchanged resource bindings, runtime settings, and both minute
  schedules. The delivery boost remains disabled. No migration or data reset
  was performed.
- Initial observed scheduled runs completed without exceptions or the previous
  CPU-limit failure. Some reached their cooperative deadline; that alone is
  not proof of recovered output.
- A new daily publication completed at 2026-09-27T18:49:29.682Z, confirmed by
  both the analytics database and the authenticated owner dashboard in Chrome.
  The queue still contained 363 days at 18:52 UTC.
- At 18:52 UTC no new graph result had completed. Checkpoint stages and parts
  had advanced, but the graph completion gate remained open at that point.
- By 18:58 UTC two daily publications and one new graph result had completed.
  The Chrome dashboard showed the graph backlog falling from 1,860 to 1,859,
  with two daily publications and one graph completion in the last hour.
  The daily queue still contained 363 days; its oldest day's completed owner
  folds advanced from 43 at 18:55 UTC to 46 at 18:59 UTC. A whole day must
  complete before its queue entry is removed.
- By 19:04 UTC four daily publications and two graph results had completed.
  The daily queue had decreased from 363 to 362. The authenticated Chrome
  dashboard independently confirmed backlogs of 362 days and 1,858 graph results,
  fresh publication timestamps, and delivery still caught up through 27,653.
  Both repaired versions remained at 100% with their minute schedules active.
- Bounded log observation through 19:05 UTC recorded no further CPU-limit
  failure. Two contained daily-lane errors were classified as `application`
  at 19:01 and 19:04 UTC. The first invocation still published a day; the second
  matched the closed `TYPED_TELEMETRY_UNAVAILABLE` error. One analytics pass
  reported `checkpoint_unavailable` at 19:05 UTC. Subsequent publication work
  continued. These remaining errors have not been diagnosed, so this evidence
  establishes restored progress, not a zero-error service or a backlog
  completion estimate.

The original stall is resolved: both downstream stages have completed work,
and both displayed backlogs have decreased. Substantial queued work remains.
The source repair and this production record are committed locally; they have
not been pushed or merged into the repository's main branch.

## Follow-up observation, 2026-09-27 21:20–21:52 UTC

- The owner's Chrome dashboard and separate read-only D1 aggregates showed
  ordered delivery still caught up. The daily queue fell from 361 days at
  19:39 UTC to 342 at 21:20 UTC and 339 at 21:35 UTC. The publication worker
  logged a successful day publication during the observation. These numbers
  establish continuing daily progress, not a stable throughput forecast.
- The allowance graph showed 1,854 result slots remaining, with one completed
  result in the previous hour and eight in six hours at 21:20 UTC. Checkpoints
  held 710 stages, 4,185 parts and about 379 MiB. A read-only census found 675
  of 679 v1.1 usage-stage checkpoints marked complete; completed result counts
  can therefore lag substantial saved intermediate work.
- The separate prepared-day builder was enabled and scheduled every minute.
  Its observed runs were idle with zero candidates; 1,995 completed prepared
  days were already stored. The analytics worker's ordinary passes reached
  their cooperative deadline without exceptions or a classified CPU-limit
  failure during this follow-up window.
- September 26 had 51 model-result rows for 51 active owners but no model-day
  publication. A read-only rehearsal of the publisher returned `cache_pending`
  before any write. One result still used the previous source family for an
  owner now requiring effective-history calculation. Its active checkpoint
  moved from the August 14 to August 22 source day between 21:31 and 21:36
  UTC. The dashboard's “complete, awaiting publication” label counts stored
  rows and does not prove the source-family and input-fence checks needed to
  publish. Publishing that stale row would be incorrect.
- The sampled `community_daily` 503s in the owner's screenshot were last seen
  at 09:05 UTC, before the 18:44 UTC repair activation. The live retained
  failure table still showed no later event at 21:38 UTC. This is not evidence
  that all service requests since then succeeded; it is a bounded sample.
- One 21:43 UTC analytics pass reported a contained `graph_checkpoint_load`
  `checkpoint_unavailable` lane failure. All 709 active checkpoint stages in a
  read-only integrity census had their expected part counts and contiguous
  indices. This excludes a persistently missing part in that census, not a
  concurrent head change or a payload-validation failure during the pass.
  Other scheduled passes continued. The effective-history cursor reached
  August 26 by 21:42 UTC.
- At 21:47 UTC the eight-minute graph pass deferred on `query_budget` after
  785 metered statements, with no exception or CPU-limit classification. It
  saved intermediate work but completed no result in that invocation; adding
  wall-clock time alone would not increase that pass's statement allowance.
  At 21:52 UTC the daily queue was 335 days (oldest October 27, 2025), graph
  results totaled 2,011 (one completed in the previous hour), and the active
  September 26 effective model checkpoint had advanced to the August 29 source
  day and occurrence ordinal 24,942. September 25 remained the latest model
  day published. The retained API failure sample still had no event after the
  repair activation.

The graph's current limiting work is a resumable effective-history calculation,
not an observed replay of the original D1 CPU-limit failure. Keep the existing
source and publication fences. The effective checkpoint and daily queue are
advancing, but the graph's completed-result rate is still low and its preview
is stale. Keep checking the checkpoint and actual model-day release; do not
infer a completion time from the source-day cursor or simply expand the
eight-minute pass without addressing its statement budget.

## Budget investigation, 2026-09-27 22:20 UTC

- Cloudflare documents a 1,000-D1-query limit per paid Worker invocation in its
  [D1 limits](https://developers.cloudflare.com/d1/platform/limits/). The
  analytics scheduler deliberately meters 900 executed statements across its
  source, target and erasure databases. It counts each statement in a batch.
- The 21:47 UTC long pass used 785 statements, leaving 115. The graph-only
  admission threshold is 120, while the effective-history kernel requires 200
  remaining before another page. If the same work consumed the same first 785
  statements under a 950 cap, the extra 50 would leave 165: enough to enter
  the graph lane, but still below that page threshold. A 950 cap therefore does
  not establish another completed page, much less a 5% throughput gain.
  Time and D1 query cost may bind independently.
- A read-only aggregate at 22:20 UTC found the active September 26 effective
  model checkpoint at source day September 18 and ordinal 41,357. Its promoted
  generation had two parts totaling 1,873 bytes. It had advanced from source
  day August 29 and ordinal 24,942 at 21:52 UTC. This is continuing work, not
  a forecast of completion across later acquisition and usage phases.
- The shared checkpoint writer reread an immutable stage immediately after
  D1 reported that the writer itself inserted it. A local source change skips
  that one statement only for a confirmed fresh insert. Existing-stage replays
  still read and validate the retained row and parts; all authority, head CAS,
  part and final-head checks remain. A focused test measured one fewer metered
  statement and verified staged replay. At 22:20 UTC this source change was
  local. Its later production activation, together with the owner-requested
  950-statement cap, is recorded in the
  [analytics budget deployment receipt](../receipts/2026-09-27-analytics-query-budget-deployment.md).
  Its effect on end-to-end throughput remains unmeasured.
