---
title: Shared analytics online qualification and rollout
date: 2026-09-29
type: receipt
status: deployed
---

# Shared analytics online qualification and rollout

This records the owner-authorized online qualification and staged production
rollout, beginning with candidate `4ac0b999b68a4c6ce6974fcb6ba7f311bba173c7`
and ending with corrected analytics `e0bd9b9f9755358b4119509cf5bbb0b472edba18`.
All planned controls were enabled by 15:28 UTC on September 29; exact live
versions, flags and schedules were verified at 15:30 UTC. Production performance
qualification and the separate all-format ingestion transition remain bounded
as described in the closeout below.
The [local qualification receipt](2026-09-28-durable-shared-analytics-local.md)
holds the completed local gates. The maintained procedure is
[production operations](../runbooks/production-operations.md#scheduled-analytics-rollout-operator).

## Initial production observation

At 02:21 UTC, analytics remained on `75a9b7ef`, publication on `ba7f00b28`,
and cache on `0fb6a5e6`. The analytics database contained 28 recorded
migrations and occupied 1,096,814,592 bytes. The schema matched the qualified
pre-migration prefix. Migrations 0030–0032 and new controls were absent.

At 02:27 UTC, daily publication had 107 queued days. The previous hour had
completed 10 scalar results and seven model results. These are completed
calculation counts, not a whole-pipeline throughput measurement. Cache had a
pre-existing scheduled exception, also observed before any candidate deploy;
its original cause was not exposed by the existing error wrapper.

The separate website deployment released its coordination lock before this
rollout acquired it. The lock must be freshly checked before any write.

## Isolated online qualification

Four separately identified D1 databases hold synthetic source, reference,
candidate and deletion-ledger state. They have no production bindings. The
authenticated, unscheduled qualification Worker imports the exact candidate
source, with aggregate-only responses and no generic SQL endpoint.

The initial deployed harness bundle was
`f4ab0bed9066491ee560610fbc390f1a51769ec8f04b39286441669650f34344`.
Authenticated inspection returned 200; unauthenticated inspection returned
404. Source migrations, recorded migration provenance, runtime initialization
and typed admission activation were verified in the isolated environment.

The initial admission attempt stopped because Node lacks Workerd's
`crypto.subtle.timingSafeEqual`. The Node-only fixture adapter now uses the
native Node constant-time implementation. The interrupted attempt left one
synthetic participant, session and unused pairing, with zero devices, uploaded
telemetry or analytics outputs. Its bounded cleanup and restarted comparison
are tracked in private operation receipts.

The first admitted run matched both historical model publications, with two
model values each, and observed two deferred candidate calls followed by a
completed durable block adopting 15 dates. The preview comparison then stopped
because its payload included independently generated timestamps. Read-only
comparison showed `generatedAt` was the only differing field. This is partial
evidence, not a completed qualification. The first corpus and report are retained;
a fresh isolated resource set is initialized for the corrected harness.

An independent harness review additionally requires completed publication states,
observable warm reuse, the intended numerical model correction, completed cache
work, positive pre-erasure derivative counts and a public-read erasure check.

Complete cold, warm, correction, publication and erasure results remain pending. No
production migration, candidate deployment or feature activation has occurred
at this checkpoint.

The second isolated Worker bundle is
`7d7b603abe1a86ba7c4dd9897ccf44d10e673164ec6b68ddcd3369a0c6766b1d`.
It adds a closed public-preview read action for erasure verification; the
product candidate is unchanged. Its fresh bindings, authenticated 200 and
unauthenticated 404 were verified before admission.

At 03:09 UTC, unchanged production had 105 queued daily publications, down
from 107 at 02:27. It recorded one scalar completion in the latest ten minutes
and no model completions in the latest hour. Cache mark counts were unchanged.
These measurements provide the rollout baseline, not candidate performance.

The second comparison exposed two harness prerequisites in the cache phase.
Every synthetic history day needs its completed daily-owner contribution before
cache reconstruction can use it; the harness had published only the correction
and graph dates. After all 14 history dates were published, the reference lane
completed 28 owner-day cache results with 14 nonempty value rows. The candidate
then exposed a budget mismatch: the harness allowed 300 source statements,
whereas the production cache lane allows 350. At 350, the same candidate
completed all 28 owner-day results and reached idle. Its 14 nonempty value rows
matched the reference digest exactly. This repaired-prerequisite probe is
partial evidence; it does not substitute for the full fresh-corpus comparison.

The cache-budget harness revision was
`e384a2aaf50351b38494d6ed8339b89a0bf8c44d9de1974fd5610438929b0dfd`.
These are harness changes; the qualified product commit remains `4ac0b999`.
A third isolated resource set is bound and initialized for a complete
cold, warm, correction and erasure comparison. The Node runner now retains a
bounded local resume channel if its terminal input closes.

The fresh third run exposed a separate reporting defect before its cold-phase
acceptance check: the Worker response's generic action name overwrote the
runner's primary/other label. The analytical comparisons had passed up to that
point, but the labelled durable-adoption assertion could not read that evidence.
The harness fix preserves the caller's action label. The cold phase completed
all analytical comparisons, including 28 cache owner-days and 14 value rows per
lane, before stopping at that reporting assertion.

A proposed reset of the third corpus was not executed. Automatic approval
review rejected deleting retired checkpoint heads without surviving source
metadata, including an exact-key proposal. These heads are durable write fences,
so retaining them would not give a reliable cold replay. The third corpus and
report remain intact, and a fourth fresh resource set is used instead. Its
results will be measured separately from earlier attempts.

The fourth run began its cold calculation at 04:09 UTC with Worker bundle
`c10fe6ba341dc75dc4e6606008159063f1db36e6c670c056921ec06c8e5e9abb`
and Node runner
`4634b6e00350f33a557c4d873db1e0f27da0503547993a84fb98ab2f5b62e032`.
Fresh bindings, empty initial owner state, authenticated inspection and
unauthenticated refusal were checked before its single admission pass.

The fourth run passed cold parity, durable model resumption/adoption and warm
output equality with model-batch reuse. At 04:24 UTC it paused during the
reference cache's correction phase, after eight successful checkpoint advances.
One explicit isolated diagnostic retry reproduced an HTTP 500 inside the Worker;
the error was not a Node transport timeout. The source correction and live
runner state are retained. This extra probe is separate from performance totals.
Production rollout remains gated on resolving the failure and completing erasure.

The closed diagnostic subsequently identified a SQLite `UNIQUE` constraint
failure in the atomic cache-result promotion batch. Source inspection identifies
the mismatch: corrected own-day input changes the mark and value identities,
but the older values-table uniqueness rule includes the lookback identity and
omits the own-day revision. With unchanged lookback, a corrected value collides
with the retained previous result. The failed batch wrote zero rows.

Review rejected the initial proposed uniqueness migration because that rule
also prevents duplicate legacy-device results. The selected fix wires existing
bounded stale-result retirement into ordinary cache processing and defers work
while conflicting obsolete rows await cleanup. It preserves schema, identities
and legacy deduplication. An own-day correction regression and updated candidate
qualification are in progress. The original `4ac0b999` package is retained;
production still requires only migrations 0030–0032.

The corrected analytics candidate is
`32689f12492788d0e70d745f1b1dae9086b2395b`, a two-file successor to `4ac0b999`.
Its 65 focused cache tests and TypeScript checks passed. The bounded collision
probe uses the complete existing uniqueness key, including model and effort;
disjoint legacy groups still publish, overlapping current groups remain protected,
and the selected result's unfinished staging survives cleanup. Independent review
passed. The full owning Worker gate is running against the clean commit.

The isolated Worker was updated to this candidate for recovery, with bundle
`847397c5310b050931e64ee6a23f2b9e097f20c103a72112d2dcb3d9b7cccc40`.
The resumed fourth run stopped before cache at a substantive cached-preview
model-value difference. Its cold/warm evidence remains valid for the original
revision; recovery and preview diagnosis are recorded separately. A fresh
complete comparison remains required for the corrected release.

At 04:35 UTC, unchanged production had 103 queued daily publications, 404 scalar
results and 1,790 model results. The latest hour contained three scalar and one
model completions; a new model publication date was present. Cache mark counts
were still unchanged. The isolated correction failure does not by itself prove
the cause of the separately observed production cache scheduler failures.

Two explicit recovery invocations on the fourth corpus then confirmed the cache
fix: the first retired conflicting obsolete rows and deferred; the second built
one completed day without a SQLite error. These probes are excluded from timing
comparisons. The mixed-revision runner was stopped with its report, logs,
diagnostics and recovery evidence retained; none of its database state was reset.

The preview difference has a separate source cause. A reference model result
was completed before the v1.2 correction, while the candidate completed it after.
Both recorded input revision 2, but source journal sequence advanced from 4 to 5.
The publisher used revision equality to skip exact closed-window dependencies,
allowing the old result into a new preview. This is a correctness defect rather
than serialization or numerical tolerance. A focused publication regression and
bounded validation fix are in progress, including the final publication fence.
The fifth isolated corpus has been created and initialized for a fresh full run;
it has not yet been seeded or deployed.

At 11:33 UTC, a fresh production observation found 88 queued publication days,
405 scalar results and 1,790 model results. Daily publication had continued,
but scalar/model/cache completion counts had not advanced since the 05:13 UTC
observation. Public health still identified source `9985c1af`; both public checks
returned HTTP 200. No production changes from this rollout had occurred.

The local machine hibernated from 05:15:38 to 11:24:48 UTC while both owning
Worker suites were running. The analytics scale case spanning that interval
reported a failure; its final diagnostic is being retained and classified. This
interrupted run does not qualify a candidate. The publisher correction and
final source package require an uninterrupted owning gate before rollout.

The publisher correction was frozen as
`9a590a4a248afe3e9e891ecf488b83e1bbb7f5dc`, successor to `32689f12`.
It probes the retained owner journal through its existing owner/sequence index,
with at most 32 owners and 65 bindings per query. Changed historical inputs must
match exact dependencies before reuse. Scalar snapshots retain their completed
payload while reporting stale inputs accurately; unchanged closed-window inputs
can remain current. Initial and final source reads bracket corrections, and an
unsuccessful journal query fails closed. No migration was added.

The complete publisher spec passed 44 tests, with an amended race-hook test
subsequently passing separately. TypeScript and independent source review passed.
The new populated 1,000-owner/365-day migration rehearsal preserved all retained
rows, proved rollback on interruption, and reported no foreign-key violations.
The full owning gate started at 11:39 UTC; source and test evidence are separate
from pending online qualification and production deployment. The superseded
`32689f12` gate was explicitly interrupted after hibernation, with exit 130 and
logs retained; it produced no qualified package.

## Deployment preparation

The public Worker can also complete typed erasure. Its existing finalizer omits
the new model and shared-feature tables from its absence proof. Exact schema
triggers normally delete those rows, but a missing-trigger regression shows that
this is not equivalent to checking physical absence before completion. Activation
therefore also requires a minimal public backend erasure backport. Fresh public
health and provider inventory identify source `9985c1af0335d0bc18124ccf5fc6c8636a50ef6e`;
the backport is prepared against that revision with existing website assets
preserved. The earlier `2df5b839` public-source observation has been superseded by
the separately completed website release.

The public backend backport is frozen at
`de675230e31313ef7f786aad57bbaea6c19bb98e` (successor to `bcddd7eb`). Its erasure implementation and copied
0030–0032 migration bytes match the analytics candidate. Twelve focused erasure
tests, twenty projection tests and TypeScript checks passed. All 38 retained
website asset hashes were verified against manifest
`759027726ddf60f0711412eda385d8fbf4fbd38a02f26a8bc28a5b7f6d728a30`;
the full Worker check is running. Its first attempts exposed a missing local
dependency and a test expectation still counting 28 migrations. The dependency
was restored and the exact expected count updated to 31; no test was skipped or
weakened. No production deployment has occurred.

The scheduled-role operator pins bundles, configurations, predecessors,
schema and ledger; preserves secret bindings and ingress; journals mutations;
and verifies exact active versions. The review added recovery for interrupted
lock acquisition, reviewed expiry extension, current-version provenance for
activation and reverse-order fallback checks.

Live read-only provider checks verified all three predecessor versions and
their closed ingress, plus the complete migration ledger and schema. These
checks caught two provider-shape differences before mutation: routes/domains
are direct arrays, and deployment history needs an explicit bounded page size.

Private operation evidence remains under the ignored release-build directory.
It includes recovery bookmarks and exact resource identifiers; those are not
reproduced here.

## Fresh isolated qualification completed

The fifth isolated run passed on exact source
`9a590a4a248afe3e9e891ecf488b83e1bbb7f5dc` from 11:48:06 to 12:03:42 UTC.
The qualification Worker version was `079e23f1-f930-4504-93bc-b4a6d3e7c1e0`,
with bundle SHA-256
`05f23d8e0b852d5ce3b3101ce88be8772e793917734fa32535ad4c180fbaae55`.
The complete report hash is
`830196a013bee72941a89ee96797122f186fae3285cfed9c95dcf4096d00fd02`.
An independent proof verified all four phases and the exact source.

Cold and warm processing produced matching complete model, scalar, daily,
API-value, cache and preview outputs. The accepted correction changed the intended
model and API values, converged the additional published date, and rebuilt eight
cache owner-days in each lane. Erasure made the previously available preview
unavailable and left every owned private derived table empty. This run had one
admission pass, no retries, no failed statements and no capacity refusals. Its
maximum candidate invocation used 918 statements against the 950 limit.

For the correction workload, candidate database reads were 871,245 versus
1,834,991 in the reference, with 5,205 versus 7,769 statements. The cache portion
needed 10 invocations versus 74. The cold candidate calculated additional
historical dates; warm candidate scheduling also did more work. These totals
therefore establish correctness and bounded completion, not an overall 10x
performance improvement. Production remains unchanged at this checkpoint.

The uninterrupted analytics gate started at 11:48 UTC with write permission for
its managed checkout and an idle-sleep inhibitor. The preceding attempt failed
before tests because Vite could not write its temporary configuration directory.
The public backport's third full run did not pass: one five-second test exceeded
its deadline under concurrent local suites, and two tests spanned the verified
hibernation interval. The five-second case passed in isolation on unchanged
source. A fourth uninterrupted public gate is prepared to run after the analytics
suite, avoiding concurrent heavy suites; neither failed run is release proof.

At 12:12 UTC, fresh production reconciliation again matched all four scheduled
role versions and the exact 28-migration prefix. The schema digest remained
`fa355093db39b408a56a70415ccbad84c49d66b684ce7fec8128e45abbf74ee6`;
database size was 1,104,683,008 bytes, a fresh recovery bookmark was captured and
the shared coordination lock was free. Daily queue depth was 87; scalar, model
and cache completion counts remained unchanged. These were read-only checks.

The uninterrupted analytics run passed all 191 Vitest files / 2,365 tests, plus
its preceding types and script gates, but the final dry deployment stopped
because the clean checkout lacked generated public release assets. The canonical
local generator restored that prerequisite and `npm run deploy:dry` then passed
on unchanged source. The strict owning-gate receipt still records the failed
whole command; a complete rerun is required. No test result or receipt was
rewritten. The public backport suite runs first to avoid concurrent heavy tests.

The 12:15–12:20 UTC baseline tail again observed a cache scheduled exception
and publication invocations with zero completed days. A separately retained
closed diagnostic captured daily failure fingerprint `818d3d27`, matching
`TypedTelemetryError:TYPED_TELEMETRY_UNAVAILABLE` in the deployed source.
That wrapper covers multiple causes, including hidden meter/provider errors
and missing physical input rows; the fingerprint is not an exact root cause.
Candidate `9a590a4a` preserves recognized inner causes so controlled budget
exhaustion remains deferred and provider failures retain a closed classification.
Shared daily preparation also has a larger bounded slice when enabled. These
changes still need completed production work to establish their live effect.

At 12:28:56 UTC, the public erasure backport `de675230` passed the complete
`npm run check`: 160 Vitest files / 1,998 tests, production dry deployment and
staging checks. Both retained and staged website manifests still matched
`759027726ddf60f0711412eda385d8fbf4fbd38a02f26a8bc28a5b7f6d728a30`.
The checkout remained clean. The analytics owning rerun started only after this
completed, preserving serial use of the heavy test environment.

At 12:50:23 UTC, exact analytics candidate `9a590a4a` passed its full owning
command: 191 files / 2,365 tests, script/type gates and both dry builds. Native
D1 qualification, private artifact retention and the maintained local migration
plan review then passed. Migration plan digest:
`ddc97d834f917fba37a9a7fdddb3ea47d3044d13a1ca6508301cc8a1a3d7bcad`.
Only 0030, 0031 and 0032 are pending against the verified 28-entry prefix.

## Production migration completed

Fresh reconciliation at 12:50 UTC confirmed unchanged role versions/bindings,
exact 28-entry ledger/schema, 1,105,158,144 database bytes, a recovery bookmark
and free deployment lock. Public health and community daily returned HTTP 200.
The maintained operator applied exactly 0030–0032 from 12:51:18 to 12:52:00 UTC,
verified the schema/ledger after each transition, and completed successfully.
The new feature and model-block tables were empty in the subsequent observation.
Existing published days, model publications and cache values remained present.
At this point the daily queue had 85 days; new controls were still disabled.

## Disabled deployment paused at its guard

Independent post-migration verification found all 31 ledger entries and schema
`8fa1f3bafb1368a701027babf191a30aa3ba944309f98a8c76cf083140cce781`.
The disabled deployment uploaded the exact analytics bundle, then stopped before
activation with `SCHEDULED_ANALYTICS_PREDECESSOR_CHANGED`. Its journal remains
`uploaded`, index zero, with no deployed roles and the owned lock retained.
Read-only reconciliation proved every active version, source, binding, runtime
and ingress unchanged. Only the analytics service's settings metadata changed:
its message/tag and bindings now describe the exact newly uploaded version.
Stable settings still match. The other two roles are unchanged. This is a
provider metadata transition the guarded operator must validate explicitly;
no blind upload/deployment retry or manual journal edit was performed.

## Reviewed deployment recovery

The operator now verifies the exact settings rewrite caused by its own journaled
upload: uploaded bindings, message and tag must match that version; restoring
the pinned predecessor fields must reproduce the original settings digest.
Unrelated settings drift still refuses. Deployment-intent reconciliation also
requires the exact journaled version ID. Independent review found no remaining
blocker and the final focused suite passed 25/25. Reviewed operator source hash:
`803c069a0f35af98e607e7009ad3a19670c0b2eb9c614f80b90e160da65f118c`.
The existing operation resumed its recorded upload without uploading it again.
Application bundles and the approved deployment plan were unchanged.

At 13:12 UTC, the disabled deployment completed for all three exact `9a590a4a`
bundles. Final live checks passed and the owned coordination lock was released.
Active versions were analytics `97d171c5-dfbb-4a37-a950-b28b7eb747f4`, publication
`b560bb19-c3c4-481e-a50a-828c90bdd08e`, and cache
`2311a921-af48-46f6-bb44-cd4924f7a897`. New feature controls remained disabled.

The subsequent public erasure backport attempt stopped at
`PRODUCTION_SOURCE_SNAPSHOT_UNAVAILABLE`, before acquiring coordination or
starting deployment. Its failed attempt log is retained. Public production
remained on `9985c1af`; activation waits for the erasure-aware backport.

The public snapshot prerequisite was an ignored Worker dependency symlink.
The qualified dependency tree was copied into a real directory, preserving the
original link. Before/copy/after content-and-structure digests all matched
`3eeb2b6af3209bc31df4ef5348bd9426cfe40e509504ad07ff822c6ce5c6d763`
and the candidate source remained clean. The original journal explicitly records
`not_started` / `not_acquired`; it was retained. A new guarded operation uses
the same source, inventory and unchanged live website manifest.

## Public erasure backport deployed

At 13:17:37 UTC, the guarded public operation completed `PRODUCTION_DEPLOYED`,
with healthy immediate/post-deploy checks, exact typed schemas, the retained
public manifest, and a released coordination lock. Independent HTTP health
readback returned 200 and exact source `de675230e31313ef7f786aad57bbaea6c19bb98e`.
All three scheduled roles now use the qualified analytics candidate; the public
backend has its matching erasure absence checks. No real-owner erasure was run.

## Shared publication activation and open production gate

The shared-publication stage completed at 13:19:03 UTC with version
`658a1d24-7fe3-4f2e-bed0-d52b3330264b`; live configuration/version checks passed
and coordination was released. The public daily endpoint returned HTTP 200 with
confirmed allowance data and cache-retention content after the backend update.

Seven activated publication invocations through scheduled 13:25:37 UTC returned
`ok` with no lane failures, but all deferred at their deadline with zero newly
published days. Aggregate samples at 13:13, 13:19, 13:20 and 13:23 retained the
same 85-day queue and oldest date; shared-feature tables remained empty. These
observations do not qualify shared publication. Remaining activations are held
while the selected owner/day admission state is diagnosed. Source publication
and processing controls are enabled; the optional correction runtime's active
probe returned zero. No correction-runtime or eligibility-policy change was made.

Three cache invocations on the disabled shared-cache configuration had no
exception; one completed an empty effective mark, and the others deferred at
the 350-query source allowance. This is neither shared-cache adoption nor a
completed useful cache-value improvement.

## Authority delivery prerequisite identified

Bounded read-only inspection found one pending owner-activation event. Its
92-day, 66,282-record typed-v1.1 delivery was still building while source public
authority was one epoch ahead of the analytics cursor. The first pending daily
owner therefore failed the existing freshness/projection admission checks.
At 13:36:47 UTC the delivery had at most 56,756 records left; at 13:49:32 UTC
the upper bound was 55,382. The public queue remained blocked. The two reads
are progress samples, not a completion forecast.

This explains why publication can execute successfully while producing no
complete days: the ten-second delivery slice makes slow durable progress and
the later public phase cannot yet admit that authority generation. No query
limit or freshness fence was relaxed. The optional correction runtime remains
inactive and eligibility policy remains unchanged.

Candidate `e0bd9b9f9755358b4119509cf5bbb0b472edba18` is a two-file scheduler
follow-up to `9a590a4a`. Two metered metadata reads admit expanded delivery only
for a verified source/target authority gap. Its delivery allowance is at most
850 statements and ends by the earlier of 45 seconds after startup or the
scheduled tick. The total invocation stays at 950. Missing or invalid metadata
falls back to the ordinary ten-second/175-statement path; every tenth-minute
graph pass is unchanged. Completion with sufficient time and query headroom
can still open the public phase. These are cooperative deadlines, not a
cross-invocation exclusion guarantee; existing durable replay checks remain.

Independent review found no blocker; 26 focused scheduling tests, type checking
and whitespace validation passed. The clean candidate's complete owning gate
started at 13:50 UTC. The scheduler change has not yet been deployed at this
checkpoint. Existing isolated online parity evidence covers the unchanged
calculation kernels; the new scheduling behavior requires its own live proof.

At 14:13:05 UTC, `e0bd9b9f` passed the complete owning command: 191 Vitest
files / 2,375 tests, all earlier script/type checks and both dry builds. Native
qualification reproduced the existing 31-migration schema. Three disabled
bundles and their fresh live configuration basis were verified and retained;
there are no pending migrations. The owner renewed publication approval during
qualification. A fresh guarded deployment plan was validated with digest
`a9a69ad02bb46556c7999fe87a59637dcd6282505c4c4b63d8c53be33a7c889a`.
The pre-deployment sample at 14:14:35 UTC still had one pending activation and
at most 51,767 records to deliver. The public backend and its website assets
are unchanged by this scheduled-worker follow-up.

The guarded disabled deployment completed at 14:18:02 UTC, verified all roles
and released coordination. Versions: analytics
`aca1e2ee-32fc-4211-81f8-f350db2423f6`, publication
`f241c2fa-2dcc-4910-9dc8-1ba41da6c43a`, cache
`16e897f6-f1b9-40a0-ba34-036739eb041d`. All use exact source `e0bd9b9f`.
The first captured new analytics invocation admitted authority recovery,
completed three delivery steps, read 1,309 records and used 175 total queries,
with no exception. Its delivery elapsed time was 32,995 ms; startup delay left
less than the full 45 seconds before the scheduled-time deadline. At 14:18 UTC
the remaining-record upper bound was 50,204. These prove resumed work, not yet
delivery completion or a newly published result.

Shared publication was restored on `e0bd9b9f` at 14:19:23 UTC, version
`f3f9724b-6410-421e-a376-185c7609268f`, with verified configuration and a
released lock. Public health and daily endpoints returned HTTP 200; retained
allowance/cache content remained available. At 14:24:57 UTC the activation's
remaining-record upper bound was 46,120. The public epoch still lagged, so this
was durable delivery progress rather than completed new publication.

Source review confirmed a separate all-format integration boundary: inactive
correction runtime leaves v1/v1.1-only owners on existing analytical paths.
Eligible retained v1.2 owners can use effective/shared preparation independently.
Correction activation changes admission and source retention and is one-way at
the database guard; it was not changed to manufacture positive stage evidence.
Current output rows also carry no shared-feature/block consumer provenance:
feature completion plus later graph/publication overlap is observational
evidence, not an exact causal adoption marker.

## Delivery recovery observations

Read-only samples of the same pending activation showed its remaining-record
upper bound falling from 51,767 at 14:14:35 UTC to 26,110 at 14:44:45,
12,798 at 14:52:35 and 4,916 at 14:57:14. The last sample had reached
September 23 of the September 28 range, with progress revision 410.
Recent sampled analytics and publication invocations returned `ok` without
exceptions. The source/target authority epochs were still 24033/24032.
This is durable recovery progress; the changing day sizes make it unsuitable
as a controlled throughput comparison or completion forecast.

At 14:54:38 UTC, the daily queue still contained 85 days and no new daily
publication had completed since shared publication was restored. Shared
feature and model-block tables were empty. Ten effective cache marks were
complete but contained zero events and zero values; these do not demonstrate
a useful cache throughput improvement. Shared cache, shared graph and model
batches remained disabled while the publication prerequisite completed.

At 15:00:53 UTC, delivery completed. Source and target both held sequence 27662
and public authority epoch 24033; there were no pending events and no building
projections. This closes the authority-recovery gate. Shared-publication result
verification and the remaining three activation stages follow separately.

## Shared publication resumed

The publication invocation observed at 15:02:35 UTC completed one new daily
publication without an exception. At 15:03:13 UTC, aggregate readback showed
two completed shared feature days and two new daily publications, latest release
15:02:50 UTC. Completing delivery had queued the activation's full affected
range: 153 days at 15:01 UTC, decreasing to 151 with the oldest queued day now
May 1. This increase from the earlier 85-day queue reflects newly admitted work.
Public health and daily endpoints both returned HTTP 200; existing allowance
and cache-retention output remained available.

This closes the first stage's publication progress check alongside the retained
isolated parity/erasure proof. It does not establish a controlled production
speedup or exact shared-feature consumer provenance. The reviewed shared-cache
activation was then started with plan digest
`5ebbbc5ffdc4cbbf59b349fe90bbda68034bcc3d2fa63a422c0be5bbdfd1e62e`.

## Shared cache activation and cold preparation

Shared cache activation completed at 15:04:31 UTC, exact version
`a15aad46-ad7d-4a7f-98d6-8df409a43202`; the operator verified the role and
released coordination. The first two scheduled runs returned `ok` without
exceptions and deferred at the preparation allowance before producing a mark.
They used 281/273 preparation statements and 283/275 total statements.
Aggregate feature-day readback at 15:14:26 UTC showed their progress:
September 16–18, 2025 completed in the first tick, then September 19–20 in the
second. These five empty historical days are distinct from the publisher's
April/May 2026 feature days. They prove durable cold preparation, not a completed
cache result or a performance improvement.

A bounded source/target inventory at 15:10:55 UTC found three effective-eligible
owners and 24 completed effective owner-days with positive usage in the inspected
May–September window. The oldest queued day's effective folds were empty.
Thus later positive work exists, but the currently selected historical work can
legitimately be empty. The public API separately returned all seven refreshed
April 29–May 5 days with release timestamps after 15:00 UTC, confirming serving
of newly completed publications rather than only retained content.

The 15:20 UTC shared-cache invocation completed at 15:23:03 UTC with one built
result, no refusal or exception, 339 preparation statements and 355 total
statements. Aggregate readback confirmed effective marks increased from 11 to
12. The selected historical input was empty, and the mark correctly retained
zero events/values. This demonstrates completion after cold preparation; it
does not qualify nonempty production throughput. The unchanged kernels already
have nonempty mixed-format cache parity in the isolated online qualification.

The regular graph path also resumed after delivery: its 15:10 UTC pass completed
two calculations with 766 total statements, then a model-day publication and
preview revision 24 / model revision 262 appeared with `inputs_current=1` at
15:15:34 UTC. These were v1.1 calculations with shared graph still disabled.
The next long pass returned idle/complete without an exception. A reviewed
shared-graph activation was started after cache completion; later shared-path
adoption must be distinguished from these existing-path results.

## Completed activation and production readout

Shared graph activation completed at 15:24:45 UTC, version
`cdbcebdf-efbd-45a7-a26c-e6c3ea368268`. A read-only helper bundled from exact
`e0bd9b9f` then used the maintained authority and publication validators to
check actual eligibility. At 15:27:17 UTC all 69 prior-day model publications
in the active 70-day window validated. All three effective owners had today's
exact-method scalar and model results; there were no pending or claimed
effective selections and no pending or complete model blocks. Thus there was
no unfinished historical date for the model-block selector. Enabling flags
does not invalidate these unchanged results or manufacture new work.

Model-batch activation completed at 15:28:34 UTC. Every activation released
its production coordination lock. Independent live readback at 15:30:08 UTC
confirmed these 100% active versions and controls, all on source `e0bd9b9f`:

| Role | Version | Enabled controls | Schedule |
|---|---|---|---|
| Analytics | `b9e33d80-8d89-401f-9380-64c9b0e06c9c` | Shared features, model blocks | Every minute, preserving the tenth-minute long pass |
| Publication | `f3f9724b-6410-421e-a376-185c7609268f` | Shared features | Every minute |
| Cache | `a15aad46-ad7d-4a7f-98d6-8df409a43202` | Shared features | Every five minutes |

The public backend remained `de675230`, with the retained website manifest.
At 15:29 UTC, source and analytics still agreed on sequence 27662 / authority
epoch 24033, with no pending event or building delivery. Public health and
daily endpoints returned HTTP 200; allowance state was `ready`, read state
`confirmed`, with cache-retention content present.

At 15:30:52 UTC, aggregate readback showed:

- 30 newly published daily dates since delivery completed; 123 dates remained
  queued, oldest May 29. The queue had decreased from the 153 dates admitted
  when delivery committed.
- 41 completed reusable feature days and one building feature day.
- One additional completed effective cache mark after shared-cache activation;
  its empty historical input produced zero events/values. Existing 6,907 cache
  value rows remained available.
- One refreshed scalar result, one model result and one model-day publication
  from the existing v1.1 path; preview revision 24 / model revision 262 had
  current inputs.
- Zero durable model blocks, consistent with the exact no-eligible-work check.

The locally qualified release and isolated online comparison passed. Production
deployment, configured activation, resumed publication, public serving and
cache completion are proven separately. New shared graph computation and model
block adoption have not yet been exercised by eligible production work. Nonempty
production cache throughput and an overall speedup remain unmeasured. Controlled
isolated correction-cache work used 2,396 versus 5,461 statements with matching
outputs; this is not an overall production performance claim.

The correction runtime remains staged. v1/v1.1-only owners continue on their
existing paths; completing this rollout is not the separate, one-way all-format
ingestion activation. That transition requires the writer/rollback, erasure,
restore and occurrence-reader qualification described in the plan. No real-owner
erasure, forced production recalculation, website-content release, branch push
or merge was performed as part of this rollout.

The next performance experiment should reduce repeated validation of the eight
cache input days and avoid reconstruction for a day proven empty under an exact
current dependency. This is a proposed follow-up, not a deployed shortcut or
permission to interpret missing input as zero. Natural nonempty work and a new
historical model date should supply the remaining production adoption evidence.

The first captured long pass after model-batch activation completed at
15:31:31 UTC on exact version `b9e33d80-8d89-401f-9380-64c9b0e06c9c`.
It returned idle/complete with 38 total statements, no new calculations and no
exception, consistent with the independently verified completed graph window.
