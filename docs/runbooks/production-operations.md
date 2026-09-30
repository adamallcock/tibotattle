---
title: Production service operations
date: 2026-08-27
type: runbook
status: operational
---

# Production service operations

This is the current service-operations runbook for the Cloudflare Worker behind
`tibotattle.com` and `admin.tibotattle.com`. It covers observation, deployment,
schema gates, private owner erasure, incident containment, and recovery. It does
not authorize credentials, remote writes, migrations, releases, or updater
publication; those remain explicit owner operations.

The Sparkle artifact/publication sequence is separate and remains governed by
the [macOS stable release runbook](./macos-stable-release-runbook.md).

For a release containing schema changes, use
[release migration admission and rehearsal](./release-migration-rehearsal.md)
before expensive candidate qualification: observe the deployed prefix and test
the pending migrations on populated synthetic data. Its local receipt neither
authorizes remote writes nor replaces the live schema and recovery checks below.
For release-site coordination with GitHub, architecture feeds and Homebrew, use
[publication reconciliation](./release-publication-reconciliation.md); it delegates
website writes to this runbook's existing guarded deployment path.


## Temporary migration liveness

An explicitly enabled migration-only source snapshot fences dynamic HTTP and
scheduled maintenance before storage access. Its public `GET /api/health`
returns source-bound liveness with `mode: migration-mutation-barrier` and
`maintenance.storageQualified: false`; it does not probe D1, R2 or Durable
Objects. Missing exact source provenance returns 503. Other dynamic requests,
including admin-host requests, remain fenced. Normal health behavior is unchanged
when the source flag is disabled; its ingress-budget probe performs lease
housekeeping and is not a storage-free read.

A successful fenced health response proves the deployed source is reachable,
not that the database migration completed. Keep exact schema/ledger/checkpoint
readbacks and the subsequent ordinary health/canary as separate gates. The
standard deployment wrapper can acknowledge the exact pending migrations
without applying them; never substitute its health receipt for migration proof.

## Production topology

| Surface | Authority and boundary |
|---|---|
| Public and `www` hosts | One production Worker and manifest-verified static release-site assets |
| Admin host | Same Worker, but admin routes exist only on `admin.tibotattle.com`, behind Cloudflare Access and a Worker-side owner check |
| Primary durable state | `USAGE_MONITOR_DB` D1 binding; checked-in migrations through `0053_refresh_lane_watermarks.sql`; this is a source inventory, not proof of remote application |
| Deletion ledger | Separate `DELETION_LEDGER` D1 binding and migration ledger |
| Encrypted/quarantined objects | Production `QUARANTINE` R2 binding with explicit deletion/reconciliation and deletion-safe restore rules; automatic age-based deletion is disabled in this source snapshot |
| Upload admission | `UPLOAD_INGRESS_BUDGET` Durable Object plus explicit rate-limit bindings |
| Updates | Separate `SPARKLE_RELEASES` R2 binding and `updates.tibotattle.com`; the owner-only atomic guard is the only appcast writer |
| Scheduled work | Production cron each minute; code must keep work replay-safe and bounded |

The exact binding names, routes, required secret names, controls, and limits live
in `apps/worker/wrangler.jsonc`; [api-surface.md](../reference/api-surface.md)
owns the route inventory.

### Bounded allowance reconstruction

`ALLOWANCE_RECONSTRUCTION_MODE` controls optional calculation only. Explicit
`resumable` uses the restartable lookup/checkpoint path; `paused` leaves
required lifecycle, retention, deletion-safe restore, upload reconciliation
and weekly publication running. Missing or unrecognized production values
fail closed. The compatibility `enabled` value selects the old direct path;
it is not an incident-recovery fallback.

The resumable path requires migrations `0046` and `0047`. The first adds an
initially empty quota lookup with a finite, restartable historical backfill;
triggers maintain later source corrections and erasure. The second stores
bounded source-pinned acquisition checkpoints. Neither rewrites telemetry.
Preserve their source and migration ledgers; do not clear a checkpoint or cache
to conceal a source mismatch.

Migration `0048` adds an isolated historical model acquisition/result namespace,
an explicit retrospective day marker, and correction/withdrawal invalidation
guards. It does not rewrite source telemetry or change the deletion ledger.
Historical reconstruction works latest-first on missing closed UTC days, using
the same statement meter, lease and deadline as current calculations. Every
third minute it receives first use of the optional budget; other minutes offer
remaining resources after daily publication. It retains the existing 100-day model
lookback and never fills missing evidence with today's fit. Publish only a
complete eligible cohort; unsupported or unidentified history remains absent.
Content-free `scheduled_model_history` events report this separate backfill;
the existing admin reconstruction counters do not measure its completion.
Up to sixteen account attempts may use available resources in one run. Rotate
the first account by three-minute priority round so large accounts cannot alias
with the schedule. When the last account finishes, re-read the same complete
cohort once for source-fenced publication within the same budget. Keep a healthy
preview; a bounded date-index check lets newly completed model dates trigger
publication without clearing the cache. See the
[allowance diagnosis runbook](2026-08-13-community-allowance-band-diagnosis.md)
for historical interpretation and gap semantics.

`MAINTENANCE_IN_PROGRESS` acknowledges an existing maintenance lease; it is not
proof that the skipped invocation performed lifecycle or reconstruction work.
An abruptly canceled invocation may leave the existing 20-minute lease until
expiry. Inspect only the last-run and lease-expiry metadata, preserve saved
checkpoints, and verify that a natural scheduled run resumes after expiry.
Do not clear the lease, force maintenance, or delete caches to manufacture a
successful recovery observation. A `canceled` outcome without an exception does
not establish a database, memory or application-level cause.

One physical-statement meter covers both D1 bindings and all scheduled phases
(900 statements, with lease-release headroom). Required maintenance runs first.
Weekly publication then attempts the current period and at most one queued period,
reserving statement headroom for graph work. Weekly failures are reported
independently and leave their queue and source/privacy fences intact. The graph's
40-second admission window starts only after those earlier phases return; slow
housekeeping cannot exhaust that window before calculation starts. The statement
meter is never reset. The deadline stops admission and checkpoint work; it cannot
cancel a database statement already in progress. `scheduled_graph_admission`
separates the earlier phase durations from the new graph window; existing phase `elapsedMs` fields still
measure total invocation time. Verify checkpoint changes and publication times,
not merely a successful maintenance event. Calculation yields durable progress
when it cannot finish. Migration 0054 replaces the current lane's
whole-account polling and four-attempt cap with an indexed, coalescing dirty
queue. Claiming moves an account to the back before work begins; revision,
window and lease checks make completion restart-safe. The actual remaining
statement/time budget governs attempts. An unchanged completed lane performs
one metadata read and no source scan or write. This does not add parallel
database or pricing work. A completed
head is admitted before rehydration only if its entire read and the shared
usage-finishing reserve fit. Sustained required-work saturation may defer
large accounts; it is not permission to lower evidence caps.

Public and admin graph rebuilds consume only complete, source-authorized caches.
The minute cron rotates optional priority over three UTC-minute slots: shared
preview first, current-account reconstruction first, then historical models first.
This gives ready graphs an early refresh opportunity without letting a large
incomplete cohort repeatedly crowd out the calculations needed to repair it.
An unavailable early preview retries after reconstruction and before daily
reconciliation. Migration 0050 extends preserved publication to validated v1
corrections and newly elected devices, using a one-use marker inside the same
atomic upload transaction. The hard-invalidation epoch still excludes
withdrawals, erasure, source-format transitions, policy changes and unrecognized
direct mutations. With migration 0055, new previews pin an immutable captured
generation and its hard-invalidation epoch, not a globally quiet upload epoch.
Each captured member must supply a complete cache revision at least as new as
its captured requirement. The source epoch identifies capture start; it must
not be relabelled as the latest live revision. Ordinary later uploads queue the
next generation while the complete captured one can publish. Daily activity
and spend retain their separate exact source/revision guards.
Elapsed time alone does not rebuild or expire an allowance preview. Changed
inputs, UTC days and newly completed model dates trigger a successor. A replacement
cannot drop model dates still awaiting reconstruction. Public aggregate/plan/
model charts use one snapshot, separate from immutable activity/spend revisions.

Claimed pure-v1 account caches are checked through one indexed joined read
per account, using the existing work fingerprint, current journal revision,
method/window keys and strict payload validation. Only changed accounts enter
source-vector acquisition and calculation. Legacy/mixed/successor and unfinished
work retain the exact-source path. Final medians still recombine compact cohort
fits; this is not additive billing math or permission to parallelize unbounded
database work. Migration and deployment are separate owner-authorized gates.

Migration 0051 tracks exact historical-window dependencies separately from
participant write revisions. An out-of-window upload may rebind unchanged
work/results under the current revision and live maintenance lease; it does
not restart acquisition. Old revision-dependent fingerprints are adopted only
after recomputing their exact prior digest from the current bounded source
vector. A changed dependency, authority, method or raced lease refuses reuse.

Migration 0052 stores restartable, elected-day quota summaries and already-priced
usage. Overlapping windows reuse these inputs and the unchanged estimator.
Raw and prepared physical readers have separate persisted policies and replay
versions; never reinterpret an old in-flight page as a new one. Migration 0053
stores exact epoch/day/method completion receipts for current and daily lanes.
An unchanged completed lane needs one metadata lookup, not a fresh account or
raw-evidence scan. Queued corrections prevent a daily receipt from being reused.
Preparation, reconstruction and publication still share the existing budget.

Migration 0055 freezes publication membership behind a finite queue watermark,
then copies validated cache payloads in restartable 64-member, byte-bounded
pages. A complete authorized capture promotes atomically; unfinished captures
never replace saved graphs. Retirement deletes derived members in bounded
pages, not telemetry. Capture and direct cohort readers batch payload reads
instead of issuing one query per contributor. Final exact medians still require
the complete captured cohort; they are not additive per-account totals.

The isolated `npm --prefix apps/worker run test:scale` qualification measures
100/500/1,000 synthetic contributors without hosted traffic. Read its receipt
for workload-specific throughput: local drain time omits scheduled waiting and
is not production CPU or latency. The unchanged one-minute cron and shared
mandatory-work budget limit cold-start catch-up. History still enumerates a
bounded complete eligible cohort (at most 1,024 contributors, excluding empty
or inactive registrations), and its final exact-date epoch check can defer on
concurrent mutation. Do not infer sustained 1,000-user upload throughput from
a population-scale or two-date history test. More parallel D1 calls do not
remove these bottlenecks; qualify arrival rate and background scheduling before
claiming that capacity.

Preview-first passes also admit owner gauge capture and growth-history cache
refresh after the allowance preview but before reconstruction. Each retains its
55-minute self-throttle and runs at most once per invocation; other priority slots
and other reconstruction modes retain the late fallback. GitHub synchronization
remains late. Required lifecycle work still comes first, and every optional
admission uses the same statement meter and deadline.
Content-free preview/analysis phase logs include elapsed time, remaining time
and actual statement counts. The lifecycle `last_completed_at` stamp precedes
optional work and must not be mistaken for the whole invocation duration.
Calculation failures also expose a closed `failureReason`: prepared-source
revision, saved-control or day-count validation, other unavailable evidence,
source change, query budget, database or account storage full, database
constraint/error, type error, or unknown
error. These labels never include error messages, stack traces or identifiers.
Use the classified failure and saved checkpoint movement together; a successful
maintenance result does not prove that its calculations succeeded.
A cache miss, stale source, deadline or malformed value defers the whole
cohort. New unpublished activity days may publish token/spend totals without
an allowance; their rebuild queue stays pending, and existing published
allowance days are preserved until a complete replacement is available.

Resume only after the approved migration set, full validation and recovery
review pass, through the normal guarded deploy wrapper. Verify natural
scheduled progress, cache source identity, public/admin responses and the
rendered graph independently. See the
[recovery decision](../decisions/2026-09-06-hosted-calculator-recovery.md).

The admin allowance section reads independent owner-only progress from
`GET /api/v1/admin/reconstruction-progress`. Its closed response separates
requested, prepared and published generations, exact historical date/account
completion, recorded trigger/restart reason and observation time. Unknown
counts stay null; it never estimates an unmeasured completion time. This GET
does not start work. Overview, allowance, growth and progress use independent
single-flight browser request lanes with a 15-second request timeout, not a
15-second polling interval. Automatic polling retains the owner's existing
cadence and pauses when hidden/offline. Temporary storage/network failure
preserves the prior validated graph; confirmed invalidation or lost owner
access clears it. A retained graph after a failed refresh is explicitly marked
as previous dated evidence, and the attention list reports unavailable history,
allowance and reconstruction sources. Growth snapshots have no age-only read expiry.

The **Database health** section independently calls owner-only
`GET /api/v1/admin/database-health` (`admin-database-health-v0.1`, no query
parameters). It performs one constant `SELECT 1` per API-bound D1 role: primary
service/telemetry, deletion ledger, and the separate analytics database in typed
storage mode. JSON mode explicitly marks separate analytics as not applicable.
Other Workers' databases, including the catchup control journal, are outside this
probe's coverage. The page is explicit that this is not an account-wide database
inventory; retained recovery copies, staging databases, R2 and Durable Objects
are not covered by the D1 read check. The existing Access owner pin protects the route; the public
hostname returns 404 and responses are never cached.

Each check reports read availability, elapsed round-trip milliseconds, D1-reported
size in bytes (displayed as MiB), and the observation timestamp. Missing size
metadata remains unavailable. Individual failure, missing binding, invalid
storage configuration or a five-second deadline degrades the result while
preserving the other roles. The deadline stops waiting; it cannot cancel an
already admitted D1 query. Temporary endpoint failure retains dated results with
a stale label; lost owner access clears them. Old Workers lacking this additive
endpoint display unavailable. No migration or production binding changes are
needed. The route does not write data, run maintenance, scan tables, or verify
schema compatibility, backup health, remaining capacity or write availability.
For failed reads, inspect Cloudflare D1 availability and deployed bindings, then
refresh. Review Cloudflare D1 storage trends and configured limits separately.

The owner page is an observation surface, not an uptime monitor: automatic reads
pause when its tab is hidden or offline, and browser alerts depend on those reads.
The attention list checks retention completion freshness against the service's
two-hour policy, incomplete maintenance cycles, admission saturation, bounded
analytics and recently retained 5xx error groups. Sampled diagnostics are not a
complete error rate. Consult `/ready` for the service's authoritative readiness
checks rather than treating the page's absence of warnings as proof.

Growth headlines count retained identities/events, with recent UTC-day charts;
legacy web sign-in, pairing and consent counters do not measure accountless
Electron enrollment. Accepted-data counters follow the active storage mode: legacy whole
contributions/v1.0 chunks, or typed v1/v1.1 upload headers. Distribution separates
native and Electron manifest checks by OS and reported version. The version table
includes per-OS and overall seven-day totals. The Worker unions addresses across
apps, versions and query segments before applying the displayed version-row cap;
never add version-row address counts in the browser. Older overview snapshots
without `observedTotals` show totals as unavailable. Unknown versions mean the
request lacked a usable `TiboTattle/<version>` token, not that the client uses the
latest feed version. Address reach can overlap between rows and OS totals, and a latest-GitHub-tag match does not establish that
each platform is on its own current feed version. GitHub download counters cover
macOS DMG assets only, not Windows/Linux adoption or completed installations.

Cloudflare's sampled results carry `≈`; distinct addresses represent the returned
sample, not an extrapolated device census. A query row cap adds `+`. Incomplete
traffic coverage suppresses sparklines, with one explanation above the cards.
The source-quality card keeps failures and staleness visible while detailed
freshness and provenance are expandable. Failure groups remain visible; individual
retained request IDs are an expandable drill-down into the same sampled events.
The section navigator appears before the page heading and stays visible while
scrolling, with horizontal scrolling on narrow screens.

Collection drafts survive refreshes and retain the revision on which editing
started. A conflicting revision must be discarded and reviewed before saving.
Actions require a usable overview; a bounded maintenance pass can return
incomplete or already-running rather than completed. Ordinary maintenance never
initiates participant erasure.

The admin client requests `?detail=preparation` for the backward-compatible
version-2 progress view. Query-free version 1 remains unchanged. Retained
prepared-source metadata shows completed/building/retiring days, saved steps,
quota observations and usage events. Preparation can advance before a legacy
account checkpoint resumes, so a fixed account-completion count does not imply
stalled work. Counts are not a total-work denominator and may change after
replacement or retirement. Migration 0056 initializes one aggregate row from
the existing head ledger, then maintains exact counters on head transitions.
The progress read touches that row, not every account/day. Missing migration,
an unavailable row, or an inexact/unsafe counter produces unknown counters
without hiding the graph; there is no 10,000-head preparation reporting ceiling.
The older overview checkpoint census below is separate. No source record is read,
no calculation is triggered, and no throughput or ETA is inferred.

The existing overview's optional compatibility `reconstruction` block reads bounded derived
metadata: lookup position, acquisition phases, invalidated sources, maintenance
lease state, last cached-result time, and the daily publication/price backlog.
The display survives an unavailable allowance preview; a failed overview refresh
labels its last observation stale. Missing diagnostics do not take Operations
down or become zero work. Refresh never starts a calculation.

Admin overview v0.5 identifies JSON or typed storage explicitly in
`service.telemetryStorageMode` and adds native/Electron distribution by OS.
The Worker and bundled admin client must be deployed together; older open tabs
reject the new schema and need a reload. The prior v0.3/v0.4 schema identifiers
are not repurposed. In typed-storage mode, the overview keeps operational authority in the
ingestion source and reads derived publication state only from that source's
registered analytics target. Current account, upload, chunk and stored-record
counts come from compact v1/v1.1 upload headers; the interactive route never
counts `typed_telemetry_records`. Header record counts therefore remain exact
when the physical typed corpus is much larger than the 10,000-row safety bound
used for raw operational samples. Daily publication and queue state come from
the source-keyed analytics tables. The old weekly rebuild queue has no typed
equivalent and is reported as unavailable, while retained dated model
publications and graph-preview freshness are shown separately. Do not replace
that unavailable state with zero or read legacy source-side derived tables as a
fallback.

For typed graph catch-up, distinguish result rows from publishable evidence.
The graph panel's “complete, awaiting publication” count means every active
owner has a stored result row for that day. The publisher additionally checks
the owner's current source family, exact closed-window dependencies, authority
and payload before releasing the day. A transition to effective history can
leave a previously stored v1.1 row counted while its replacement calculation
is still checkpointed. The current allowance preview separately needs a result
for every owner's current-day fit; completing a historical model day does not
refresh that preview by itself. Check the checkpoint phases and the actual
model-day and preview timestamps before treating a low completed-results rate
as a stopped scheduler. The failure list is a bounded retained sample of API
requests, not a census of scheduled calculation failures.

The effective-history graph runner groups up to four 200-occurrence pages
between checkpoint promotions, stopping at quota acquisition phase boundaries.
Every page still verifies its source and owner authority. Whole groups can
reproduce an interrupted multi-batch checkpoint save. A group cut short by its
query budget or work deadline can promote only when its successor fits one
atomic part-and-head batch and leaves enough save time; larger cut groups
resume from the preceding durable head. The checkpoint format and analytical
result identities are unchanged, so previously saved one-page checkpoints can
resume under grouped processing. This groups acquisition work; it does not
prepare reusable effective-day summaries or increase the invocation query cap.
Verify the deployed revision before assuming this source behavior is active.

Effective graph work uses the existing owner/day/metric selection lease with a
closed version-2 effective envelope. A busy contender checks owner and target
authority before yielding without reading quota pages. The claimant recaptures
the complete effective scope; a lease never substitutes for source, correction,
erasure or checkpoint validation. Version-1 v1.1 selections retain their pinned
generation contract. Both source families use the caller's lease duration,
including the longer scheduled pass's 570-second lease.

The selection write rechecks target erasure and authority in the same SQL
statement. Discard and claim predicates match the selected envelope so a stale
invocation cannot act on a replacement row that happens to reuse its revision.
Ordinary graph retirement removes at most 32 obsolete selection rows per pass,
preserving in-horizon pending work and unexpired claims except for erased owners.
Erasure completion requires selection metadata to be absent as well.

Within one analytics pass, a retirement lane that reports no work is not polled
again until a producing lane makes progress. Each new invocation probes it again;
productive sweeps continue draining bounded pages. Delivery progress rearms the
ordinary sweeps, while erasure and capacity recovery keep their independent
mandatory checks. The v1 sweep starts with terminal owner fences before looking
up their retained chunks. Sweep counters measure actual executed rounds and
statements, including a round that finds nothing.

When all historical model days are published, a historical scheduling slot can
serve missing or pending current fits/model work. Selection remains bounded by
the existing cohort and round-robin cursor; completed selection rows do not make
an already-cached result pending. Scope, authority, scan revision and claim leases
still gate the work. Normal current slots continue checking for changed inputs.

Overlapping effective calculations still use an exact checkpoint-head comparison.
When a save confirms that another writer has promoted a newer active head for
the same key, `checkpoint_advanced` is a normal deferral. The scheduler may
reload from that head within the same query, deadline and step limits. A second
such conflict exhausts the graph lane for that invocation. It never saves the
losing payload against a substituted head. Missing, unchanged, retired or
malformed heads remain failures; a trigger or provider error is not reclassified
merely because another invocation is running.

Verify the deployed revision before assuming effective leases are active. A
rollback to source `214a6d3` ignores effective selection rows and cannot run their
new horizon cleanup. Checkpoint comparisons still protect result promotion, but
duplicate computation can recur and abandoned selections can remain in the
diagnostic census until forward cleanup resumes. Do not clear checkpoint heads
or bypass erasure to make those counts fall.

Effective candidate and inventory reads constrain the physical owner/stream/time
index before decoding records. Cross-day source expansion retains all dates.
The compact v1.1 completeness check uses namespace, format and original chunk
identity together, retaining its admission proofs and manifest membership.
Occurrence dependency matching compares the complete canonical stored ID,
including its encoding tag, before compatibility decoding. It retains the
original chunk completeness gates and outside-day/correction expansion; the
returned dependency headers and calculation identities are unchanged.
These query changes use existing indexes and do not require a migration.

The typed reader preserves an internal, non-enumerable error cause. The graph
boundary uses only recognized causes to retain budget/deadline deferrals or
emit the existing closed provider classification and digest. Never log the raw
cause: provider messages can contain SQL and identifiers. The older generic
`818d3d27` token identifies `TYPED_TELEMETRY_UNAVAILABLE` but cannot distinguish
a database interruption, missing evidence or a masked budget refusal.

With `GRAPH_DAY_PROJECTION_FOLD=enabled` and analytics migration
`0028_graph_day_effective_quota.sql` present, effective-history calculations also
prepare missing quota days during any of their four quota acquisition passes.
Inline preparation starts only at a complete day boundary. An adopted mid-day
cursor or earlier missing day can instead be filled by one independent, resumable
preparation cursor under the same graph claim. It reads at most 200 occurrences
per step and alternates with analytical progress. Only an absent day or an exact
dependency mismatch can start this work; a budget or size refusal cannot.
Exact already-prepared days are skipped. A deterministic preparation limit
records that day as refused for this checkpoint identity and leaves the ordinary
calculation available.

The checkpoint holds at most one preparation buffer. A completed day is saved as
a closed reduced value before attempting its cache write, and remains resumable
until the day manifest is promoted. Budget exhaustion cannot silently drop that
completed preparation. These preparation boundaries also stop the normal page
group so interrupted multi-batch saves reproduce the same successor.
Once preparation completes the whole window, the same job can retry the fold
within its remaining query and time budget.
Both fits and model results
can reuse those inputs for overlapping windows. Missing migration support or incomplete cache coverage uses
the paged calculation. This flag does not increase the 950-statement invocation
cap or start additional writers.

With analytics migration `0029_graph_day_effective_usage.sql`, model calculations
also prepare reusable usage days through the existing correction-aware effective
reader. Fits retains its scalar usage traversal. Model preparation reads at most
200 reconciled occurrences per step and saves a compact day summary and cursor;
the cumulative preparation count cannot exceed the existing one-million-row
window limit. Small reading steps share at most four pages per save. A completed
day, fold, refusal, or first successor exceeding 30 checkpoint parts ends that
group, keeping larger interrupted saves reproducible. It never copies raw usage
records or raw session IDs into the checkpoint. A
completed summary remains durable until its immutable cache value is stored.
Adopted partial model reductions remain available for the paged fallback, while
independent preparation starts at each missing day's beginning.

Only complete, source-validated coverage can replace the model usage traversal.
The existing model fold combines daily cost cells, session openers and session
tails, preserving cross-day account changes. Each prepared day is bounded to
4 MiB and each loaded window to 8 MiB. A conservative union of at most 4,096
session, model-cost and poisoned-bin entries preserves the paged model's
checkpoint refusal boundary. Exceeding a preparation bound disables preparation
for that checkpoint and retains the ordinary calculation; it does not turn a
cache limit into a published analytical refusal.

Usage values have a distinct `effective-usage` layout. Their manifest ID includes
a digest of the composition pricing and method contract; their manifest digest
is the same session-inclusive, correction-aware day dependency used by daily
retirement. Reuse requires both identities and current source/owner authority.
Migration 0029 preserves existing quota and legacy keys, metadata, page bytes,
and immutable/erasure guards. Older Workers ignore this layout in quota readers
and still remove it during owner erasure. Production migration and code
activation remain separate gates; source implementation alone does not establish
that this path is enabled in production.

Effective prepared keys include the exact correction-aware day dependency and
linked occurrences on other days. Every reuse verifies current source and
owner authority. An unrelated later upload can reuse a closed day; a changed
dependency cannot. Preparation is bounded to 12,800 quota occurrences and 4 MiB
per day. A fold admits at most 8 MiB of encoded prepared input and conservatively
keeps the existing 4,096-reset-cluster bound. Whole-window query admission
preserves a fallback calculation or checkpoint save; exceeding a preparation
bound does not publish an analytical refusal.

Complete-window validation shares a bounded header read across the selected
days, then checks occurrence links separately for each exact day. The shared
headers admit at most 30,000 rows and 4 MiB; overflow selects the paged fallback.
The loader stops at the first stale day and verifies every dependency before
decoding cached payloads. It preserves query reserves for an ordinary page or
checkpoint save. Exact day digests may be reused within the same owner-bound
invocation, with source-owner checks around their use and the target authority
check before storage. A changed owner revision cannot reuse that memo. No digest
memo persists across invocations. This batching does not weaken source or owner
fences.

Retirement also bounds the effective prepared cache to the input horizon of
the scheduled graph: the oldest retained result day plus its existing model
lookback (currently 170 inclusive UTC input days). It deletes obsolete derived
values before their pages. This does not change source or daily-publication
retention.

Prepared effective checkpoints retain the original effective method names and
isolate their storage dependency digest with the `effective-quota-days-4`
format domain for quota-only work. Model usage preparation uses
`effective-quota-days-5` and adopts format 4 first. Older independently deployed
cleanup Workers recognize the unchanged methods. The prepared reader then adopts `effective-quota-days-3`, then
`effective-quota-days-2`, then the original paged key, and advances only the new key. The previous
keys remain for rollback until ordinary horizon or erasure cleanup; disabling
the flag resumes the original unwrapped key. Completed result identities remain
unchanged. After validated result readback, the analytics Worker marks the
prepared checkpoint retired with a bounded page; existing cleanup drains its
remaining parts. The abandoned `:quota-days-1` keys and their permanent
tombstones must not be reused or cleared. The forward migration preserves
legacy prepared values and immutable/erasure triggers. Apply and verify the
analytics migration separately from deploying this code, then confirm source
scan counts, checkpoint movement, completed results and publication. The local
comparison is recorded in [Analytics throughput options](../research/2026-09-27-analytics-throughput-options.md);
its statement reduction is not a production elapsed-time measurement.

Acquisition completion is not a finished allowance estimate. The account census
is capped at 10,000 tracked checkpoints and explicitly indicates truncation.
Publication coverage uses 366 indexed day lookups; a day with known price data
may still be partially priced. Neither account progress nor queued-day counts
is an estimate of remaining time. Parallelizing days alone does not remove the
complete-account-cache prerequisite; source fencing and shared resource budgets
must remain intact in any later concurrency change.

### Opt-in durable batches and shared analytical features

The local redesign adds three forward analytics migrations: `0030` stores
resumable historical model batches, `0031` admits clipped ranges across the
entire retained graph window, and `0032` stores shared day features. These are
separate from migration `0027` and require an exact ledger inspection before
application. Do not apply an unreviewed missing migration as a side effect of
deploying these Workers. The [redesign checklist](../plans/2026-09-28-analytics-redesign.md)
records qualification and the remaining online gate.

| Control | Consumer | Default |
|---|---|---|
| `STORAGE_ANALYTICS_MODEL_BLOCKS=enabled` | Analytics Worker: historical model-date batches adopted into the existing publisher | Off |
| `STORAGE_ANALYTICS_SHARED_FEATURES=enabled` | Analytics and publication Workers: shared daily, API-value, scalar and model inputs | Off |
| `CACHE_RETENTION_SHARED_FEATURES=enabled` | Cache Worker: shared usage events and seven-day continuity inputs | Off |

The shared feature path uses the effective reader for admitted v1, v1.1 and
v1.2 evidence. Owner selection enters that path for an eligible retained v1.2
domain, or for v1/v1.1 evidence when the separately qualified correction runtime
is active. Enabling these performance controls does not activate that ingestion
contract; with it inactive, v1/v1.1-only owners retain their existing paths.
Correction-runtime activation changes admission and retained correction facts
and is a separate, forward-only operation under the
[occurrence-reader contract](../reference/system-architecture.md).
Shared features are keyed by source namespace, opaque owner, UTC day, exact dependency
digest and producer methods, including pricing registries. Owner metadata
provides deduplication and authority fences. An unchanged day can be reused
after an unrelated upload; a changed day or method receives a new value.
Daily activity/API value, ordered scalar usage, quota evidence, model usage and
cache continuity share that preparation. Scalar timing and attribution hazards
remain explicit. Public reducers, contributor counts, fingerprints and serving
contracts remain authoritative.

Features are private derived data. Completed features contain hashed session
references and day-local ordering ordinals, with no source record JSON or raw
session identifiers. A pending source page retains only its admitted opaque
pagination cursor, under the existing checkpoint privacy contract; completion
removes it. Atomic head promotion prevents incomplete values from being read.
Current source and target authority are checked before use. Erasure completion
proves physical absence of feature heads and parts, model heads/parts and owner
model-policy rows as well as existing outputs. A partially installed schema
fails closed; pre-feature schemas remain supported.

The initial feature representation admits at most 6,000 source rows and 4 MiB
per day; a complete scalar/model window admits at most 8 MiB. Capacity and
representation refusal use the existing bounded calculation. They do not
publish missing evidence as zero or turn a cache limit into a statistical
refusal. Model blocks retain at most four admitted jobs per owner and preserve
the existing 950-statement analytics invocation cap. Shared daily preparation
uses a larger bounded slice while respecting the graph reserve and both the
inner and outer statement meters. Publication and cache Workers retain their
independent existing invocation caps.

The analytics scheduler normally gives ordered delivery ten seconds and 175
statements before public work. A verified public-authority epoch gap admits up
to 850 delivery statements on ordinary minutes, ending by the earlier of 45
seconds after isolate startup or the scheduled tick. Both metadata probes and
delivery share the invocation's 950-statement cap. Missing or invalid probe
metadata keeps the ordinary allowance; every tenth-minute graph window remains
unchanged. After expanded delivery, public work requires completed delivery and
at least 140 remaining statements. A slow in-flight query can overrun the
cooperative deadline, so replay safety still depends on the durable cursor and
receipt checks. Equal authority epochs do not prove all source updates delivered.
Use the journal cursor and complete published outputs to assess recovery.

Cleanup advances bounded cursor pages, preserves complete current-method
features and active claims, removes obsolete method generations and abandoned
pending work, and remains available at the operating capacity guard. Per-day
cleanup bounds replaced dependency generations. Source data retention is
unchanged.

Roll out schema, code and activation as separate steps. Initially deploy all
three Workers with these controls disabled, preserving the live configuration
and previous serving payloads. Activate shared publication, cache, graph and
finally model batches in measured stages; compare complete output identities,
failure counts, queue drainage, statements and elapsed time at each stage.
Before activation, inventory every deployed role bound to the target. Every
Worker that can complete a typed erasure must have the new absence checks,
including the analytics and publication schedulers. A separate preparer or
JSON-mode public Worker does not acquire this responsibility merely because it
shares a repository. Confirm actual bindings and call paths.

Disabling the corresponding control restores the existing calculation path.
Keep the erasure-aware code when disabling work; do not restore an older writer
that can attest completion without checking the new private tables. Rollback
does not reverse migrations or delete published data. Stop rollout on
output mismatch, recurring failure, stalled durable progress, or an erasure
completion regression. Local throughput is not a production latency claim.

## All-format correction activation

The owner action `telemetryRuntimeActivation` accepts target `usage_correction`,
expected revision `0`, confirmation `activate_telemetry_usage_correction_runtime`
and a fresh deployment/schema reconciliation proof. The immutable runtime has
no revision column: staged and active are represented by revisions 0 and 1.
Only the exact owner audit operation attributes success. Activation and its
terminal audit commit in one primary D1 transaction; retries reconcile that
operation rather than infer success from an already-active runtime.

Qualify the writer and null/known correction archive, v1.1 predecessor closure,
effective reader, erasure and restore on the exact candidate before activation.
The reconciliation operator requires a private
`usage-correction-activation-readiness-v1` receipt with the deployed
source/version/configuration and the reviewed writer, online, erasure and
restore evidence digests. Pin its `readinessSha256` separately using
`--approved-correction-readiness-sha256`. A receipt records reviewed evidence;
its digest alone does not prove a test passed.

Use the existing `telemetry-runtime-reconciliation.mjs` operator with
`--mode browser-arm` for a same-origin authenticated Chrome handoff, or
`--mode activate` with an owner-private admin session file. Both hold the
production coordination lock and journal the exact request before the action.
`--mode reconcile` reads the exact audit operation and releases the lock only
on verified completion. Never manufacture owner audit records through D1 SQL.

Correction state is a calculation-method stamp. Activation invalidates private
reusable dependencies, daily owner methods and graph result eligibility, and
schedules older daily/history publications for refresh. Last-good public
snapshots remain visible until complete replacements publish; policy,
collection and terminal privacy fences are unchanged. In-flight calculations
must re-prove the method before publishing. The admin pending-day census
includes method refreshes even when they have no ingestion queue entry.

The transition is one-way. The recovery disposition is forward fix; retain
correction-aware admission and erasure checks when disabling shared performance
controls. Do not restore a writer that predates correction archival.

### Effective-history lookup and cache scheduling prerequisites

The effective dependency reader's metadata fallback requires typed-ingestion
migration `0005_owner_occurrence_lookup.sql`. Its `typed_telemetry_device_owner`
and `typed_telemetry_manifest_owner` indexes scope the small dictionaries before
format-specific device/manifest occurrence seeks. A missing metadata index
refuses that fallback. Date restrictions must not replace cross-day links: they
carry correction and conflict dependencies outside the requested output window.

Optional typed-ingestion migration `0006_direct_owner_occurrence.sql` adds one
non-unique record index on owner, encoded occurrence, format, stream and observed
day. When present, the reader seeks v1/v1.1 variants directly while retaining
namespace, admission, complete-chunk, source, correction and outside-day proofs.
Dependency v3 bytes and source statement counts remain unchanged; missing this
optional index retains the metadata fallback. SQLite maintains index entries
atomically with source admission, replacement and erasure. Its production
migration and deployment remain separate from local qualification. Building it
scans retained typed records, consumes storage and adds a write per future typed
record.

The same maintained forward operator admits the index through the separate
`direct-occurrence-forward-plan-v1` profile (`prepare --profile direct-occurrence`).
It pins migration 0006's reviewed bytes and one primary-role target, plus all four
Workers at predecessor `d43c8f92a059d9c577776f7eca8a331eb305b8a6`.
Preparation uses `direct-occurrence-index-only-v1` schema expectations: exactly
hash-pinned catalog migration 0013 is held; every other canonical/restored object
and every analytics/deletion-ledger role remains required. Missing or altered
catalog source bytes, or any installed catalog object, refuse this index-only
profile. Default canonical
preflight remains unchanged and continues to require the complete source tree.
Do not use a general migration runner to apply the held catalog inadvertently.

Before writing, require the primary to be below 8 GB (at least 1 GB beneath the
9 GB operating cap), a verified Time Travel bookmark, exact source/schema/ledger
and Worker configuration pins, and the owning Worker gate. The index DDL and
custom ledger entry share one atomic request. Preserve the coordination lock and
journal on an unknown outcome; reconcile read-only before an explicitly approved
retry. No automatic SQL replay is permitted.

After the migration receipt is verified, the scheduled rollout's `index-refresh`
stage deploys all three lanes against the unchanged analytics schema. It binds
the exact predecessor operation, migration receipt, bundles, resources, controls,
schedules and resulting primary schema/ledger. Normal upload/deploy journals and
lost-response recovery remain in force. The older two-role migration and
`refresh-enabled` contracts retain their original source pins and targets.
Production migration, deployment, pauses and live measurement require their
existing explicit authorization. Rollback deploys the reviewed predecessor code
while retaining this additive index; it does not drop data, roll schema back or
restore an older correction-unaware writer. Measure source work, completed/current
results and public publication independently.

Analytics migration `0033_cache_retention_owner_cursor.sql` must also precede
the new cache Worker. Its table stores a numeric position and revision for each
source/shard configuration, with no participant or owner identity. The cache
lane advances this cursor before source work and uses compare-and-swap to
reject a competing cursor update. A crash, slow skipped owner or invocation
deadline therefore permits another owner to receive the next turn. The
selection wraps against the current active, unfenced owner order; completed
owners are skipped with bounded probes. An empty pass limited to 12 owner
probes reports deferred, with at most 36 target statements and no source
reads; only a full observed wrap proves idle for that pass.

Within an owner, pending days remain oldest first. A transient source mismatch
leaves that day unbuilt and unmarked until daily projection supplies a current
fingerprint. Owner rotation improves fairness; it does not prove source
availability or authorize publishing a stale cache result. Measure completed,
current, nonempty cache output and public publication separately from cursor
movement, skips and staged feature preparation.

Both schema changes are additive. Applying them is a separately authorized
production operation against the existing source and analytics roles. Preserve
the complete deployed schema, runtime state and `d1_storage_migrations`
ledger; do not replay a fresh restore package or substitute Wrangler's
`d1_migrations` ledger. Rehearse populated upgrades, retain pre-write backup
evidence, verify the exact resulting canonical schema, and only then deploy the
qualified successor. A timeout with an unknown outcome requires read-only
reconciliation before any further write.

The narrow `apps/worker/scripts/existing-role-forward-migration.mjs` operator
owns this two-role update. Its `prepareExistingRoleForwardPlan` API pins a
clean candidate, Wrangler bytes, the four exact predecessor Workers, both role
bindings, complete schema/ledger prefixes, stable runtime controls and Time
Travel bookmarks. It projects only the three reviewed additions through the
unchanged canonical preflight. `runExistingRoleForwardMigration` defaults to
plan validation; execution requires the exact plan digest and confirmation.

Each role's DDL and custom-ledger entry form one atomic request. The operation
records intent before that request, verifies the resulting schema and ledger,
and holds the shared production lock until final preflight and receipt checks.
An uncertain request is reconciled without remote writes. A proved-applied
result resumes after that role; a proved-not-applied result additionally needs
explicit retry confirmation. Expired approvals permit inspection but no new
DDL. If a partial operation expires, preserve its journal and obtain a
separately reviewed recovery plan; do not replay it through a fresh migration
package or edit the recorded approval.

## Scheduled analytics rollout operator

For the already enabled September 29 deployment, the guarded `refresh-enabled`
stage replaces all three bundles while preserving enabled shared processing.
It requires predecessor source `3216e225`, a qualified successor, the 32-entry
analytics ledger ending in 0033, and the completed two-role forward migration
above. The stage adds `forwardMigration` with its private operation directory
and exact raw `plan.json`/`receipt.json` hashes; `disabledOperation` is null.
The operator checks the complete migration journal, candidate and SQL hashes,
both live database schemas and ledgers, retained predecessor deployment
receipts, exact versions, bindings, settings, schedules and ingress. This path
uses no disable/reactivate sequence. Its normal upload/deploy journal and
uncertain-outcome recovery rules below still apply.

`apps/worker/scripts/production-scheduled-analytics-deploy.mjs` guards the
retained analytics, publication and cache bundles. Its private plan pins the
candidate and predecessor commits, account and analytics database, complete
schema and migration ledger, package manifest, Wrangler CLI, exact per-role
bundle/configuration hashes, and each active predecessor version, bindings,
settings and schedule. Every activation or fallback plan also pins the
completed operation that deployed each current predecessor version and bundle.
The command defaults to local plan validation:

```sh
node apps/worker/scripts/production-scheduled-analytics-deploy.mjs \
  --plan "$PRIVATE_STAGE_PLAN" --package "$RETAINED_PACKAGE"
```

After reviewing that plan digest, an authorized operation adds `--execute
--approved-plan-sha256 "$PLAN_SHA256" --confirmation
DEPLOY_REVIEWED_SCHEDULED_ANALYTICS`, together with `--operation
"$PRIVATE_OPERATION" --repository-root "$CLEAN_CANDIDATE" --cli
"$PINNED_WRANGLER_DIST_CLI"`. Use a new private operation directory for each
stage. The fixed stages are `deploy-disabled`, `shared-publication`,
`shared-cache`, `shared-graph`, then `model-batches`. The first deploys all
three exact prebuilt modules with controls off. Each later stage changes only
the named role's closed feature controls; both erasure-aware analytics and
publication versions must already be deployed. Before every mutation the
operator rechecks the shared production lock, retained bytes, live predecessor,
schema/ledger and role bindings. It journals upload and deployment intents,
discovers the uniquely tagged uploaded version, verifies bindings, then checks
the active 100% version after deployment. Cloudflare's service settings can describe an uploaded draft before
that version is activated. Before upload, the complete predecessor settings hash
must still match. After the operation's journaled upload, the guard accepts only
the exact uploaded bindings and message/tag, reconstructs the original settings
with the pinned predecessor version, and requires the original complete hash.
Active version, runtime, ingress, schedules and unrelated settings remain fenced.
A journal already at `uploaded` resumes with `--execute --resume
--executor-stopped`; it verifies and deploys that version without uploading again.

An uncertain lock acquisition, upload or deployment retains the journal and
never repeats the mutation. After proving the original executor stopped, use
the same inputs with
`--reconcile --resume --executor-stopped --confirmation
RECONCILE_SCHEDULED_ANALYTICS` to read back the exact tagged version and active
deployment. Reconciliation performs no upload or deployment. Continue only
from a verified journal state with an explicit `--execute --resume
--executor-stopped` invocation. If the plan has expired, this resumption needs
a newly reviewed `scheduled-analytics-approval-extension-v1` JSON file binding
the original plan SHA-256, plus `--extension "$PRIVATE_EXTENSION"
--approved-extension-sha256 "$EXTENSION_SHA256"`. An extension lasts at most
24 hours and authorizes only exact-bound resumption; a fresh stage needs a
fresh plan. A different owner, unmatched version, changed
predecessor or incomplete schema remains a stop. Each stage still requires
measured useful work, output comparison and erasure checks before the next
stage. For an activated stage that completed and released its lock, the separate
`disable-model`, `disable-graph`, `disable-cache` and `disable-publication`
stages upload the same retained candidate modules with the named controls off.
Disable in reverse dependency order: model batches, graph, cache, publication.
The operator refuses to disable a producer while its downstream consumers are
active.
Use a fresh reviewed plan and current predecessor versions; do not restore an
older erasure writer or reverse the schema. The ordinary public Worker deploy
wrapper does not deploy these roles.

## Read-only observation

Start without credentials or mutations:

1. Confirm the exact checkout and clean/dirty state. Record `git rev-parse HEAD`.
2. Read `https://tibotattle.com/api/health` and record its deployment source
   commit, collection-control state, storage checks, and contribution contracts.
3. Check the affected public route directly. Health alone is not route proof.
4. For admin-only symptoms, confirm the request is on the admin hostname and
   distinguish Access refusal, Worker owner refusal, missing optional analytics,
   and application errors. Never move admin routes onto the public host.
5. For updater symptoms, inspect the public appcast and immutable enclosure
   separately; do not infer updater state from Worker health.

Do not log credentials, cookies, Access assertions, raw participant identifiers,
private payloads, or session content in an incident note.

## Local validation before an owner deploy

From the repository root, with the pinned root and Worker dependencies already
installed:

```bash
npm run docs:check
npm run test:preflight
npm run product:worker:check
npm run architecture:check
```

From `apps/worker`, the maintained aggregate gate is `npm run check`. The
production dry bundle is `npm run production:deploy:dry`; it does not mutate
production and does not authorize a later deploy. Resolve every unexplained
failure before proceeding.

The production deploy wrapper itself rechecks endpoint configuration, workspace
package copies, generated assets, release preflight, source cleanliness,
dependency-tree integrity, public surface, pre-deploy health, post-deploy health,
and exact source identity. Do not replace it with raw `wrangler deploy`.

### Disposable local HTTP acceptance

`pnpm run product:backend:acceptance` from the repository root creates fresh
local D1/R2 state, separate synthetic owners for lifecycle and retained-state
runs, and isolated envelope keys. It starts Wrangler with generated local
configuration and `owner.env`, and supplies `--owner-access-file` to its smoke
child. No workspace `.dev.vars` is required; ordinary participants are never
promoted. This remains a local test, not production Access or deployment proof.
The synthetic-only fixture serves `apps/web/public` directly under `--local`;
no production asset staging or clean/committed release tree is required. This
exception does not change production/staging asset paths, guarded wrappers,
or release requirements.

Direct network commands from `apps/worker` — `smoke:http`,
`smoke:account-scoped:http`, `smoke:queue:http`, `smoke:incident:http`, and
`load:http` — require a caller-supplied `--owner-access-file`. They validate its
dedicated owner session and existing admin overview authorization before
participant enrollment, ingestion, or incident-control writes. Missing owner
access is a configuration failure (`LOCAL_OWNER_ACCESS_REQUIRED`), never
successful cleanup. `npm run load:profile` / `--profile-only` remains offline
and requires no owner file.

For standalone setup, migrate fresh owner-only state with
`npm run migrate:local -- --persist-to /absolute/private-lab/state`, then use
the [local owner fixture generator](../../apps/worker/scripts/local-owner-fixture.mjs)
with `--origin http://127.0.0.1:8792`,
`--persist-to /absolute/private-lab/state`, and
`--directory /absolute/private-lab/owner-fixture`. It refuses nonempty
participant state or an existing fixture directory and emits only file paths.
Start local Wrangler with `--local --env ''`, the returned `--config` and
`--env-file` paths, `--ip 127.0.0.1 --port 8792`, and the same `--persist-to`.
The generated configuration is `local_open`; account-scoped smoke also needs
`--var ACCOUNT_SCOPED_INGEST_MODE:local_preview`.

With that dedicated local-open fixture running, these command templates show
the required owner file (replace the absolute placeholder with its actual path):

```bash
npm run smoke:http -- --origin http://127.0.0.1:8792 \
  --owner-access-file /absolute/private-lab/owner-fixture/owner-access.json \
  --generated-content-free-fixture
npm run load:http -- --origin http://127.0.0.1:8792 \
  --owner-access-file /absolute/private-lab/owner-fixture/owner-access.json
```

Keep each tool's existing source, mode, and invitation requirements. The
standard full lab instead uses `invite_only` and issues its own cohort grants;
its redeemed invitation files cannot authorize another cohort.

Owner access uses the closed `local-backend-owner-access-v0.1` file: an
unexpired owner-only regular file bound to the exact loopback origin, distinct
from `participantAccessFile`. The development seam uses the dedicated owner's
cookie and session-bound CSRF with `ADMIN_IDENTITY_LINK_KEY`; it does not bypass
production Cloudflare Access. Keep credentials out of output, shell arguments,
and receipts. Generated-fixture lab receipt v0.4 reports `ownerAccessFile` and
`ownerAccessFileContainsSecret: true`; prepared-file receipts omit private paths.
Require `ownerErasureLifecycle` / `ownerErasureVerified` evidence, not a retired
`DELETE` response treated as deletion. The default lab companion is not an
isolated browser fixture; use backend-only mode unless the
[local source and credential boundaries](../../apps/local/README.md#test)
have been separately isolated.

## Schema migration gate

Production has two independent D1 migration ledgers. The deployment wrapper
performs read-only ledger inspection and fails closed on missing, malformed,
nonsequential, divergent, or unknown state.

- A normal deploy with no unapplied migrations needs no migration token.
- If migrations are pending, the wrapper reports exact
  `BINDING:filename.sql` tokens and refuses to continue unless the owner names
  exactly that set with `--confirm-migrations`.
- The deploy wrapper **does not apply migrations**. Applying remote migrations
  is a separate reviewed owner write, with backup/rollback analysis and an
  observed post-migration check before code that depends on it is deployed.
- A confirmation when nothing is pending also fails; this protects against an
  operator model that disagrees with production.

The underlying policy and failure modes are retained in
[the production migration gate](../governance/2026-08-07-production-deploy-migration-gate.md).

The [2026-09-04 lineage review](../reviews/2026-09-04-hosted-migration-lineage-reconciliation.md)
records why the source preserves the historical
`0041_community_model_composition_cache.sql` and moves the separate, unapplied
model-composition and attribution sequence to `0042`–`0045`. The historical
`0041` and the former `0041_community_model_composition.sql` have different SQL
and are not aliases. Do not edit an applied ledger, ignore an unknown name, or
apply this sequence to an alternative history. Stop and review that exact
environment before proceeding; the ordered-prefix guard remains unchanged.

### Typed v1.2 existing-role forward migration

The typed v1.2 successor has a separate existing-role operator. It is a
forward-only, populated-schema operation for the exact predecessor source
`eaf6f521fb9842399da512fd1ad5020c7b706f5b`. It applies the four primary
`ingestion-isolation-migrations/0006`–`0009` files, then the three analytics
`analytics-migrations/0024`–`0026` files, in that order. The operator binds each
SQL digest, the candidate clean `HEAD`, the exact database IDs and names, the
prior schema/data/ledger receipts, the reviewed canonical inventory digest, a 9 GB
capacity budget, and a rehearsal receipt. It never creates or repairs a
missing prior ledger. The active Worker predecessor, version, canonical live
configuration fingerprint, contained collection hold, and reviewed D1
Time Travel receipt are re-read under the shared production lock before the
first D1 write and before every later write. The plan's `inventorySha256` is
the canonical digest of the embedded inventory object, so execution also
detects an edited or internally inconsistent plan.

Run the local populated rehearsal from the repository root. It uses
synthetic content-free rows, enables foreign-key checks, verifies every mapped
column and staged/default value, and proves the carried analytics columns with
per-column aggregate invariants. This mode never reads credentials or performs
remote work:

```sh
mkdir -m 700 /absolute/private/typed-forward-rehearsal
node apps/worker/scripts/typed-forward-migration.mjs --mode rehearse \
  --worker-root apps/worker \
  --output /absolute/private/typed-forward-rehearsal/rehearsal.json
```

The explicit output is a mode-0600 private artifact written atomically; use
its path in prepare rather than relying on terminal output.

Capture the reviewed D1 Time Travel receipt separately before preparing the
plan. The targets file must be a mode-0600 JSON array in this exact order,
containing only the reviewed `role`, binding, database `name`, and
`databaseId` for `primary` then `analytics`. The capture uses one timestamp,
the pinned Wrangler CLI, and read-only `time-travel info` calls; it never
restores or mutates a database. The output is a mode-0600
`typed-forward-backup-receipt-v2` artifact with one exact bookmark per target
and a digest:

```sh
node apps/worker/scripts/typed-forward-migration.mjs --mode capture-backup \
  --targets /absolute/private/typed-forward-target-identities.json \
  --operation /absolute/private/typed-forward-backup-capture \
  --cli /absolute/wrangler-dist/cli.js \
  --account-id ACCOUNT_ID --wrangler-sha256 WRANGLER_SHA256 \
  --captured-at 2026-09-22T12:00:00.000Z \
  --expires-at 2026-09-23T12:00:00.000Z \
  --output /absolute/private/typed-forward-backup-receipt.json
```

A maintained read-only capture brackets the active Worker and the two target
roles, checks that collection is already contained, and writes three new
mode-0600 artifacts: the enriched `inventory.json`, the exact ordered
`targets.json` with populated schema/data/ledger receipts, and the v2 Time
Travel backup receipt. It performs no remote writes. The growth budget is an
explicit reviewed number and must leave the 9 GB operating cap below its
limit:

```sh
mkdir -m 700 /absolute/private/typed-forward-capture
node apps/worker/scripts/typed-forward-migration.mjs --mode capture-inventory \
  --operation /absolute/private/typed-forward-capture \
  --cli /absolute/wrangler-dist/cli.js \
  --account-id ACCOUNT_ID --worker-name WORKER_NAME \
  --wrangler-sha256 WRANGLER_SHA256 --growth-budget-bytes 1000000000 \
  --inventory-output /absolute/private/typed-forward-capture/inventory.json \
  --targets-output /absolute/private/typed-forward-capture/targets.json \
  --backup-output /absolute/private/typed-forward-capture/backup-receipt.json
```

The capture preflights all three destination parents before any Worker or D1
read. It stages the three files and publishes each with a no-clobber commit;
`typed-forward-inventory-publication.json` is a private durable journal in the
operation directory bound to the account, Worker, CLI path and digest, growth
budget, exact output paths, and explicit capture-time inputs. If a later destination fails, stop with the journal in
`partial` state and rerun the exact command with the same operation and output
paths. The operator resumes the staged local publication after checking the
journal and does not repeat the remote reads. A destination created or changed
while publication is in progress is refused and remains untouched.

The capture does two canonical Worker/config reads and rechecks both target
binding IDs/names, the contained control revision, and the exact prior
schema/data/ledger observations for both roles after the backup and hold edge.
Any source,
version, configuration, role, hold, or backup drift leaves no newly written
artifact. Prepare then writes a mode-0600 closed plan only from a clean
checkout whose `HEAD` equals the candidate source pin:

```sh
node apps/worker/scripts/typed-forward-migration.mjs --mode prepare \
  --worker-root apps/worker --repository-root /absolute/candidate-checkout \
  --inventory /absolute/private/inventory.json \
  --targets /absolute/private/targets.json \
  --rehearsal /absolute/private/typed-forward-rehearsal/rehearsal.json \
  --candidate-source CANDIDATE_COMMIT --account-id ACCOUNT_ID \
  --worker-name WORKER_NAME --wrangler-sha256 WRANGLER_SHA256 \
  --output /absolute/private/typed-forward-plan.json
```

Inspecting a plan is read-only and does not acquire the shared production
deployment lock. The remote path is a separate explicitly confirmed command.
It first rechecks the pinned clean source, canonical embedded inventory digest, prior
receipt, schema prefix and content-free invariants. Each migration file is
split using the pinned Wrangler splitter. A durable intent is written before
each bounded mutation request, and the migration ledger insert is its own
final statement checkpoint. Former foreign-key-off rebuild regions are
rehearsed and coalesced into one atomic request containing
`PRAGMA defer_foreign_keys = ON` followed by the complete rebuild region; D1
runs that request in one implicit transaction and the transport decodes the
exact result count with every result successful. User `PRAGMA foreign_keys`
changes and standalone deferral requests are never sent. After every mutation
it reads the exact schema and ledger/progress checkpoint, and after each ledger
checkpoint it runs a bounded remote foreign-key check. The shared lock remains
held on any failure or uncertain response:

```sh
node apps/worker/scripts/typed-forward-migration.mjs --mode execute \
  --plan /absolute/private/typed-forward-plan.json \
  --worker-root apps/worker --repository-root /absolute/candidate-checkout \
  --operation /absolute/private/typed-forward-operation \
  --cli /absolute/wrangler-dist/cli.js \
  --confirmation EXECUTE_REVIEWED_TYPED_FORWARD_MIGRATION \
  --approved-plan-sha256 PLAN_SHA256
```

After an uncertain result, stop and rerun the same plan with `--resume`. Resume
reads first and accepts only the exact before or after state recorded by the
durable intent; it never blindly retries a provider operation. A completed
release-intent resumes by observing lock ownership and releases only the
original owner. An expired plan can only resume reads/reconciliation. A write
extension is admitted only on that existing expired operation, with an
`approvedAt` at or after the prior deadline, the exact previous-extension
digest, and a new window of at most 24 hours. Verify the private artifacts and
their canonical digests before the explicitly protected resume command:

An active chained extension renews the write approval for the original
contained hold and captured Time Travel bookmarks. It does not replace those
recovery anchors: each write re-reads the exact control revision and resolves
the original bookmark at its original capture timestamp. Their capture
timestamps may be older than the new boundary only while that extension is
active; any control or bookmark drift still refuses the write.

```sh
test -f /absolute/private/typed-forward-plan.json \
  && test "$(stat -f '%Lp' /absolute/private/typed-forward-plan.json)" = 600
test -f /absolute/private/typed-forward-extension.json \
  && test "$(stat -f '%Lp' /absolute/private/typed-forward-extension.json)" = 600
PLAN_SHA256="$(node --input-type=module -e 'import { readFileSync } from "node:fs"; import { identityDigest } from "./scripts/lib/release-operation.mjs"; process.stdout.write(identityDigest(JSON.parse(readFileSync(process.argv[1], "utf8"))))' /absolute/private/typed-forward-plan.json)"
EXTENSION_SHA256="$(node --input-type=module -e 'import { readFileSync } from "node:fs"; import { identityDigest } from "./scripts/lib/release-operation.mjs"; process.stdout.write(identityDigest(JSON.parse(readFileSync(process.argv[1], "utf8"))))' /absolute/private/typed-forward-extension.json)"
node apps/worker/scripts/typed-forward-migration.mjs --mode execute --resume \
  --plan /absolute/private/typed-forward-plan.json \
  --worker-root apps/worker --repository-root /absolute/candidate-checkout \
  --operation /absolute/private/typed-forward-operation \
  --cli /absolute/wrangler-dist/cli.js \
  --confirmation EXECUTE_REVIEWED_TYPED_FORWARD_MIGRATION \
  --approved-plan-sha256 "$PLAN_SHA256" \
  --extension /absolute/private/typed-forward-extension.json \
  --approved-extension-sha256 "$EXTENSION_SHA256"
```

The concrete transport also rechecks the active Worker through the canonical
read-only production inventory provider and verifies a Time Travel bookmark at
the receipt capture time for each exact database. Typed deployment, client
rollout and staged activation remain separate gates after both ledgers have
been read back.

## Owner deployment

### Attribution successor cutover and rollback

The account/plan changes separate analytical correction from new consented
transport. `0043` fences legacy analytical inputs/caches and publication;
`0044` adds explicit consent, enrollment namespaces, admission floors and
immutable staged day transport; `0045` adds complete-domain activation. Local
schema 11 is not renamed, downgraded or wiped. Applying migrations or enabling
the staged v1.1 format remains a separately authorized production operation.

The release rehearsal and staging readiness probe check both the exact migration
inventory and the attribution tables, columns, indexes, integrity triggers and
source-selection views. A complete ledger with missing schema guards fails the
readiness check. These schema-only probes do not transmit contribution content
and do not authorize migration application or format activation.

Before cutover, run the synthetic transport, domain, re-pair, erasure, source-pin
and public publication tests. Verify the actual pending migration set, owner
rollback authority, backup/deletion-ledger posture and consent UI. Code or a
successful development upload does not prove any existing person has consented.
New consent requires the exact schema/dictionary/privacy triple, explicit
ongoing-upload intent and hosted personal-session CSRF. Capability reads and
device credentials cannot grant it. Existing v1 uploads remain valid until
that participant explicitly raises its minimum write rank.

Check for accepted v0.2 history before offering an upgrade. Such participants
have an effectively blocked v1.1 capability; both consent and activation refuse
the transition, including disjoint-day candidates. This prevents loss of an
otherwise valid legacy fit. Do not delete old contributions or bypass the floor
guard to force cutover; a reviewed semantic replacement adapter is required.

Activation requires a contiguous full-domain manifest, a current predecessor
token/fingerprint, ready chunks and exact semantic predecessor coverage. Its
limit is 4,096 days and 30,000 chunks; over-limit or unproven replacement stays
staged without discarding history. An unchanged vector acknowledges the actual
active generation without republishing; a source correction forces revalidation.
Read back the selected generation and public readiness independently. Never
infer complete cutover from successful chunk delivery alone.

For an explicitly authorized write-floor rollback, use the existing
`POST /api/v1/admin/action` with `action: "run_maintenance"` and one closed
`transportRollback` object containing `participantId`, `expectedRevision`,
`fromRank`, `toRank` and
`confirmation: "lower_transport_admission_preserving_analytical_source"`.
The exact target and current revision must be inspected first. The Access owner
and admin CSRF gates still apply. The result reports the new write floor,
policy revision and `activeAnalyticalSourcePreserved: true`; the audit stores
a purpose-separated participant digest, not the raw target. A stale revision
is a conflict, never permission to retry with an invented one. Lowering a floor
does not unpin the active analytical history, delete consent, reactivate erased
data or authorize a different cross-format join.

### Adopting stranded accountless v1.1 uploads

A v1.1 day is public only once a domain generation covers it. Some accountless
devices upload complete days but never activate one: a first sync is cut off by
the client's pass budget, or a newer build re-emits an accepted day without one
of its records, so the device's own activation fails the preservation proof.
The owner can activate such uploads from the admin console's **Activate
stranded v1.1 uploads** card. **Preview** pages through every device without
changing anything and shows the counts. **Activate N devices** is enabled only
by a successful preview from the last 15 minutes, runs once per preview, and
reports what it activated, including after a partial failure. Activation is a
production write and needs explicit authorization.

Both buttons use the existing `POST /api/v1/admin/action` with
`action: "run_maintenance"` and one closed `v11EvidenceAdoption` object
containing `dryRun` (boolean), `maxDevices` (1–25, default 10) and
`afterParticipantId` (`null`, then each returned `nextAfterParticipantId` until
it is `null`). The Access owner and admin CSRF gates still apply. Always run the
dry run first.

For each device, the action uses only that device's own complete uploads. With
no head, it takes the longest contiguous run of ready days (the latest run on a
tie). With a head, it keeps the head's range and adds the contiguous ready days
after it. For a covered day, it takes a newer upload only when every accepted
record survives. It then activates through the ordinary predecessor and
activation path, so every database proof still applies.

It skips a device when any of these hold:

- it lacks current v1.1 upload authority, for example after an opt-out;
- it holds an active v1.2 authorization, so its client re-uploads through v1.2;
- its client issued a predecessor in the last 10 minutes, so a pass may be in flight;
- it has v1 or v0.2 history, or a head from another device;
- it has no contiguous complete day.

The `run_maintenance` audit (`task: "v11_evidence_adoption"`) holds only
outcome counts, refusal codes, days covered, new days and accepted days kept.
The owner's response adds one identifier: when more devices remain,
`nextAfterParticipantId` is the last examined pseudonymous participant, used as
the paging cursor. Keep it out of notes, issues and receipts. A rerun with
nothing new returns `unchanged`.

Adoption does not unblock the client. A device whose build dropped an accepted
record keeps being refused, so later runs extend its head over newer complete
days until it moves to v1.2. Adoption never fills gaps, invents days or changes
consent. Read back public eligibility and analytics delivery independently; the
action result alone does not prove publication.

Follow the catch-up on the admin console's **Processing pipeline** panel. It
shows the ingestion journal, the delivery backlog with the device currently
being folded, the daily queue and the allowance graph. Delivery folds about one
bounded step a minute. A day republishes only after every public owner's latest
change has been delivered, so a large activation holds the whole daily queue
until delivery catches up.

### Guarded deployment wrapper

Without inventory flags, the routine wrapper below uses the checked-in JSON
database layout. For typed storage, a different primary database, or a separate
`ANALYTICS_DB`, use the pinned typed path below. It reconstructs the live
configuration inside a disposable source snapshot and qualifies each database
role. A migration confirmation cannot repair a binding mismatch.

The read-only reconciliation command accepts an owner-private Cloudflare
inventory containing account/Worker identity, active version, settings,
schedules, ingress, domains, and Durable Object namespace metadata. Pin the
inventory bytes and the observed deployed source. Supply an existing
`CLOUDFLARE_API_TOKEN` through the approved credential mechanism; the command
does not discover credentials, log tokens, or obtain broader permissions.

```bash
npm run production:reconcile -- \
  --inventory <private-inventory.json> \
  --inventory-sha256 <reviewed-inventory-sha256> \
  --expected-previous-source <reviewed-full-deployed-source-sha> \
  --output-directory <new-private-output-directory>
```

It re-reads production before and after its fixed schema/contract SELECTs,
derives expected schemas from local canonical migrations, and writes a private
candidate configuration plus a sanitized report. It never deploys or applies
remote migrations. Dirty source or a schema mismatch remains blocked. Even a
`compatible` result is inspection evidence; deploy through the wrapper's
immutable snapshot, coordination, owning-surface and post-deployment gates.
Do not pass the generated configuration to raw Wrangler as a shortcut. Keep
database identifiers and plain-variable values private.

For an admin-only typed deployment, retain the exact current public release
tree in `.release-build/public-release-site`. Pin its live manifest bytes and
the full Git commit whose public source files produced it. The wrapper checks
the retained source directly from Git, verifies the complete local asset tree,
and rechecks the live manifest before and after deployment:

```bash
npm run production:deploy -- --confirm DEPLOY_PRODUCTION \
  --expected-previous-source <reviewed-full-deployed-source-sha> \
  --inventory <private-inventory.json> \
  --inventory-sha256 <reviewed-inventory-sha256> \
  --retained-public-source <reviewed-full-public-source-sha> \
  --expected-live-manifest-sha256 <reviewed-live-manifest-sha256>
```

The typed path preserves the live bindings, settings and ingress, and rechecks
all three database contracts at the deployment boundary. It refuses migration
confirmations and never applies database migrations. Schema differences require
independent diagnosis and, if needed, an explicitly authorized forward repair.
Schema qualification derives restored-role SQL from `authorityRoleFinalSchema`.
It also supports the forward migration 0061 extension of an already restored
role. These exact source-derived variants require the complete, unchanged
restore metadata group; arbitrary SQL normalization is not accepted.
`production-trigger-repair-rehearsal.mjs` locally exercises migration-order guard
preservation; it is not a remote repair command.

Only after explicit authorization and green preflight, use the wrapper from
`apps/worker`:

```bash
npm run production:deploy -- --confirm DEPLOY_PRODUCTION \
  --expected-previous-source <reviewed-full-deployed-source-sha>
```

If and only if the wrapper reports a reviewed pending set and the separate
migration operation has been handled, append its exact comma-separated tokens:

```bash
npm run production:deploy -- --confirm DEPLOY_PRODUCTION \
  --expected-previous-source <reviewed-full-deployed-source-sha> \
  --confirm-migrations BINDING:0000_name.sql
```

Capture the structured result. Success means the wrapper observed its named
pre/post conditions; it is not a release, appcast publication, identity-flow,
participant-deletion, or admin-UI end-to-end receipt. Compare the health
`deployment.sourceCommit` with the intended commit and probe the affected route.

The wrapper now makes the exact source comparison itself and requires the
reviewed predecessor to be an ancestor of the candidate. Both direct and
web-only deployment participate in a shared, non-expiring Git coordination ref.
The Git remote must allow that exact coordination branch to be created/deleted;
the wrapper does not change repository rules. A lock retained after an uncertain
provider response is a stop, not permission to retry raw Wrangler.

Private operation records default to
`.release-build/production-operations/<candidate-sha>` in the repository.
Inspect them using `node scripts/release-agent.mjs status --operation <directory>`
from the repository root. Only after establishing that the old executor cannot
still run, use the explicit reconciliation path:

```bash
npm run production:deploy -- --confirm RECONCILE_PRODUCTION_DEPLOYMENT \
  --operation <private-operation-directory> --executor-stopped
```

Reconciliation does not deploy. It verifies the intended source and public
surface, then releases only the exact recorded owner. If verification is
unavailable or the old executor might still run, retain the lock and investigate.
This generic reconciliation command refuses operations carrying typed deployment
pins. Preserve their journal and lock for a separately reviewed recovery that
revalidates the pinned configuration, schemas and public manifest; legacy
health checks alone cannot qualify them.
A proven pre-mutation failure with no retained lock can be retried using a new
`--operation <fresh-private-directory>`, preserving the old evidence. Cleanup
warnings do not erase a verified deployment outcome. These are cooperative
guards: raw Wrangler, old checkouts and privileged manual provider actions are
not fenced and must not be used concurrently. See
[agent release operations](agent-release-operations.md) for recovery boundaries.

## Private owner participant erasure

The [2026-08-30 retirement decision](../decisions/2026-08-30-self-service-deletion-retirement.md)
retires self-service `DELETE /api/v1/me` as `404 NOT_FOUND`, without participant
mutation or D1 access; individual-contribution deletion stays retired. Health
declares `participantDeletion: false` and `deletionSafeRestoreReplay: true`.
These are source contracts, not a claim that production has changed. Old installed apps
may still offer the former control; refusal must never be reported as erasure.

This is a destructive, private owner operation, never routine support cleanup:

1. Obtain explicit authorization for the exact environment and participant.
   Resolve the exact opaque `participant:<UUID>` through private, verified
   records; do not guess a target or put identifiers/request evidence in public
   issues.
   Verify the deployed revision supports this procedure. Before a retirement
   cutover, record aggregate counts of active/deleting participants and retained
   tombstones, and a completion path for every interrupted deletion.
2. Authenticate on the configured admin host through Cloudflare Access with the
   pinned owner identity, independently of the affected participant's session.
   Confirm primary D1, the independent deletion ledger, R2, and pinned identity
   configuration are available. Never bypass Access or use the participant relay.
3. Send `POST /api/v1/admin/action` from the exact admin origin with JSON content
   type and `x-usage-monitor-admin: 1`. The body is closed and explicitly targeted:

   ```json
   {
     "action": "run_maintenance",
     "participantErasure": {
       "participantId": "participant:00000000-0000-4000-8000-000000000000",
       "confirmation": "erase_hosted_participant"
     }
   }
   ```

   The participant identifier above is synthetic, not a target. Keep the real
   body out of shell history, logs, and receipts.
   `{ "action": "run_maintenance" }` without
   `participantErasure` performs ordinary maintenance only; it must never start
   a participant erasure.
4. Require `schemaVersion: "admin-action-v0.1"`, `action: "run_maintenance"`,
   and `result` with `task: "participant_erasure"`, `operationId` (UUID),
   `deleted: true`, `alreadyDeleted: false`, and numeric `contributionsDeleted`.
   An ordinary maintenance result, timeout, or error is not completion. Record
   only the operation reference and bounded outcome. The existing
   `run_maintenance` audit retains `task: "participant_erasure"`,
   `participantDigest = SHA256('app-usagemonitor/admin-participant-erasure/v1\0' + participantId)`,
   and outcome/code/count, never the raw participant identifier or identity.
5. A failed or interrupted operation remains incomplete. Diagnose its fixed
   failure code and retry the same verified target through this owner boundary
   when safe. A fresh started attempt returns `409 PARTICIPANT_DELETING`:
   wait/recheck instead of issuing concurrent erasures. A new attempt uses its
   audited operation UUID as the deletion fence; it may take over a non-null
   legacy deletion fence with no matching audit, a failed owner attempt, or a
   started owner attempt older than five minutes. Final database removal is
   conditionally fenced so a stale attempt cannot complete after takeover.
   No live participant session or schema migration is needed.
6. A missing participant is already erased only with an unexpired tombstone in
   the independent ledger: that success has
   `deleted: true`, `alreadyDeleted: true`, and `contributionsDeleted: null`
   (unknown historical count, not zero), with the same response envelope and
   task. Without that proof the response is `404 NOT_FOUND`, not success.

Social restore replay owns `state: 'deleting'` with `deletion_session_id: null`.
Accountless restore replay instead owns the deterministic
`restore-replay:<participantDeletionDigest>` fence. An owner request against
either restore state also returns `409 PARTICIPANT_DELETING`;
let maintenance finish or retry the restore instead of taking it over. Cron
must not resume non-null owner or legacy deletion fences: those require the
private owner path, even when an old session fence has no matching audit.

The operation must preserve the upload fence, aggregate withdrawal/rebuild,
independently verified tombstone, identity cooldown, bounded R2 cleanup, race
checks, and final database removal. It does not erase local history or provider
records. Do not substitute ad-hoc D1/R2 deletion, remove old tombstones, or
change migrations/retention as part of this retirement. Restore/reconciliation
and normal expiry safeguards remain required. Actual production retention and
backup horizons still need owner verification; a source constant is not proof.

Privacy-request intake and identity verification are separate from technical
authority to execute erasure. No new contact channel, deadline, or legal
conclusion is established here; see [SUPPORT.md](../../SUPPORT.md#hosted-history-and-privacy-requests).

## Incident containment

Classify before mutating:

| Class | First action |
|---|---|
| Public availability or bad deploy | Preserve health/error evidence; assess a source rollback through the same protected deploy path |
| Privacy, authorization, abuse, or cost risk | Stop or narrow the affected collection stage using the production control mechanism; preserve the control revision and reason |
| Data integrity or schema mismatch | Stop dependent writes, preserve the original state, inspect ledgers/backups, and rehearse forward recovery on a copy |
| Updater publication risk | Stop the atomic appcast publication path; do not overwrite or hand-edit signed feed bytes |
| Admin-only failure | Keep public/admin host segregation intact; diagnose Access, owner pin, optional analytics, and route behavior separately |

The checked-in `collection-control.mjs` command is intentionally local-only and
must not be repurposed for production. Collection-control containment uses a
reviewed, revision-checked D1 operation and a valid reason code. It does not stop
all lifecycle, request, scheduled, or Durable Object writers. Restoration is a
separate decision; never treat “contain” as permission to “restore.”

### Production collection-control operator

`apps/worker/scripts/production-collection-control.mjs` is the only maintained
production collection-control wrapper. It targets the already deployed owner
route `POST https://admin.tibotattle.com/api/v1/admin/action` and acquires the
same shared production deployment lock used by typed-forward operations. The
operator always reads the live source, version, and configuration identity at
the lock boundary and reads the exact `collection_controls` row from the
canonical primary D1. A scripted session transport also performs the exact
owner overview GET before and after the action; browser handoff requires the
owner to perform those overview checks in the authenticated admin tab because
Access cookies and JWTs must remain inside that browser.

The default invocation is read-only inspection. `contain` requires
`CONTAIN_PRODUCTION_COLLECTION`; `restore` requires
`RESTORE_PRODUCTION_COLLECTION`. Containment always targets all four flags
false with reason `maintenance` and records the complete original tuple and
revision. Restoration uses that recorded tuple and the verified contained
revision; it never assumes that the original state was all enabled. Before
restoration, the operator also requires the typed usage runtime to remain
`staged`.

The cutover sequence is strictly ordered: contain and reconcile first, then run
the reviewed migration and deploy the successor while collection remains
contained. After the successor is live, run the read-only
`--mode prepare-successor --successor-output <private-0600-successor.json>`
capture. It records the successor source commit, version, configuration digest,
the contained revision, and proof that `telemetry_v12_runtime` is staged. The
artifact is private, mode `0600`, and no-clobber; a reviewer approves its exact
`approvedSuccessorSha256` digest. Restore then requires that artifact and digest
alongside `RESTORE_PRODUCTION_COLLECTION`. Restore is bound to the approved
successor identity and rechecks it before the owner action and before terminal
reconciliation, so it does not require the pre-containment deployment identity.
If the successor changes, prepare a new artifact and obtain a new review; do
not reuse the old one.

The browser transport is the preferred path when the owner already has a live
Access session. The command acquires the lock, writes the action intent, and
prints only the expected revision, target flags, reason, and fixed route. It
does not POST or ask for cookies. In the exact owner-only admin tab, refresh
the overview, verify the displayed revision and original/target state, submit
the matching collection-controls form with reason `maintenance`, then run
read-only reconciliation. Use the same tab for restoration after the typed
runtime and contained revision have been independently verified. The browser
action is a separately authorized owner action; an action-required receipt is
not proof that the mutation happened.

The session transport is available only when a fresh owner Access session has
already been exported into a mode-0600 owner-private JSON file. The file is
validated for exact admin origin, `CF_Authorization` cookie, owner-only mode,
regular-file identity, and no hard links. It is never copied into the journal,
receipt, shell arguments, or output. The owner-local credential helper example
for the Cloudflare provider is:

```sh
/Users/adamallcock/.codex/bin/secret run cloudflare \
  --service cloudflare.api_token \
  --env CLOUDFLARE_API_TOKEN -- \
  node apps/worker/scripts/production-collection-control.mjs \
  --mode inspect --transport session \
  --account-id <private-account-id> --worker-name <production-worker> \
  --repository-root <clean-checkout> \
  --operation-directory <new-private-operation-directory> \
  --admin-session-file <private-0600-session.json>
```

For a post-deploy successor capture, use the same owner-local helper without an
admin session export when the read-only canonical provider path is sufficient:

```sh
/Users/adamallcock/.codex/bin/secret run cloudflare \
  --service cloudflare.api_token \
  --env CLOUDFLARE_API_TOKEN -- \
  node apps/worker/scripts/production-collection-control.mjs \
  --mode prepare-successor \
  --account-id <private-account-id> --worker-name <production-worker> \
  --repository-root <clean-checkout> \
  --successor-output <private-0600-successor.json>
```

Use the approved digest from that receipt with the restore operation:

```sh
node apps/worker/scripts/production-collection-control.mjs \
  --mode restore --transport browser \
  --account-id <private-account-id> --worker-name <production-worker> \
  --repository-root <clean-checkout> \
  --operation-directory <private-containment-operation-directory> \
  --successor-artifact <private-0600-successor.json> \
  --approved-successor-sha256 <reviewed-artifact-digest> \
  --confirm RESTORE_PRODUCTION_COLLECTION
```

The helper and the session file are owner-local inputs, not repository
authority. Keep the account and session paths private. Add the explicit
confirmation and `--mode contain` only after the live inventory and source
bracket have been reviewed.

Every mutation writes a durable private journal before the external POST and a
no-clobber receipt for each intent and terminal result. A 409 is a stop; the
operator never retries it blindly. A lost response is classified only by a
fresh exact read: the original tuple at revision `R` remains pending and can
be retried only by an explicit `--resume` under the same lock, the exact target
at `R+1` is committed, and any other tuple or revision is ambiguous and keeps
the lock. `--mode reconcile` is read-only and never posts. Reconciliation
releases the shared lock only after stable source/version/config identity and
the exact target readback; uncertainty, drift, or missing evidence keeps it.
Receipt publication also records the exact private temporary path, destination,
byte length, and digest in that journal before linking. Recovery removes or
adopts only that exact journal-bound inode after matching its bytes; arbitrary
hard links remain refused. If a process stops before the initial containment
preimage is saved, only the same confirmed `contain --resume` path may finish
the original-owner live/D1 bracket. Reconcile and restore remain refused until
that preimage exists.

Containment is a collection-control fence, not a global drain. It does not
cancel already-running requests, scheduled work, Durable Object alarms, or
other writers. Preserve the journal and perform a separately reviewed restore
after the typed-forward operation is complete.

### Journaled maintenance version

`apps/worker/scripts/production-maintenance.mjs` is a distinct maintenance
operation using the existing release journal and shared production lock. It
never relaxes `runProductionDeployment` or its normal healthy-predecessor gate.
The generated version retains the exact 24 public asset bytes, public domains
and Durable Object class/migration identity, serves content-free 503 responses
with `Retry-After: 300` for dynamic requests, and has no D1, R2, service, queue,
or Durable Object binding. The retained class has inert methods and alarms.
Existing secret names are explicitly inherited without reading their values;
old plain-text variables are not retained.

Prepare a private 0600 JSON plan and a 0700 directory containing exactly its
24 listed 0600 assets. `validateMaintenancePlan` defines the closed contract:
exact tooling commit, pinned Wrangler 4.114.0 CLI digest, account/Worker/source
D1 identity, canonical origin, deadline within 24 hours, predecessor version
and source commit, canonical binding and writer-inventory digests, original cron, Durable Object
namespace/migration tag, secret names, every asset length/hash, and the exact
pre-maintenance source schema digest. Compute the binding digest with
`maintenanceBindingDigest`; compute the schema digest with `identityDigest`
over the exact ordered result of `MAINTENANCE_SCHEMA_QUERY`. Preserve the
filtered current writer inventory beside the plan. All identifiers and live
receipts stay private. Do not substitute an earlier release's source or assets.

Use an exact clean tooling checkout. These commands name private prepared
inputs through shell variables; they are not permission to operate production:

```sh
node apps/worker/scripts/production-maintenance.mjs \
  --plan "$MAINTENANCE_PLAN" --assets "$MAINTENANCE_ASSETS" \
  --operation "$MAINTENANCE_OPERATION" --repository "$MAINTENANCE_TOOLING" \
  --wrangler-cli "$MAINTENANCE_WRANGLER" --action inspect
node apps/worker/scripts/production-maintenance.mjs \
  --plan "$MAINTENANCE_PLAN" --assets "$MAINTENANCE_ASSETS" \
  --operation "$MAINTENANCE_OPERATION" --repository "$MAINTENANCE_TOOLING" \
  --wrangler-cli "$MAINTENANCE_WRANGLER" --action dry-run
```

The dry run creates the immutable operation package but acquires no remote
owner and uses no credential. Review it and retain its receipt before approval.
An explicitly approved `--action enter --resume
--confirm ENTER_PRODUCTION_MAINTENANCE` uses the existing injected
`CLOUDFLARE_API_TOKEN`, reacquires no existing owner, rechecks the exact
predecessor and bounded sole-writer inventory, then journals version upload,
100% activation, and removal of the pinned cron separately. Wrangler and API
failures stop that operation; command diagnostics contain hashes and closed
status metadata, never raw credential-bearing output. Provider reads reject
incomplete inventories. Candidate readback requires no D1 binding, exact
operation-tag/plan marker, inherited secret names, static bytes and 503s.
Public-host admin-path checks avoid treating an unauthenticated Access redirect
as proof of the Worker handler; the generated handler's admin-host refusal is
covered locally.

The shared owner remains held after verified containment. The receipt explicitly
reports `drainProven: false`: existing requests, scheduled invocations and alarms
need a separate drain observation before a source freeze. Do not release the
owner merely to start another operation. Fresh target schema preparation can
finish and release its owner before maintenance; the fixed-contract copy Worker
uses its own D1 journal/CAS and can run while maintenance retains this owner.
Maintenance-owned cutover into the qualified typed role remains a separate
required gate: the ordinary deploy path expects healthy 200, a new owner and
its baseline schema contract. It cannot be used as the exit from this operation.

After confirming the executor and all children stopped, use `--action reconcile
--executor-stopped --confirm RECONCILE_PRODUCTION_MAINTENANCE` with the same
inputs and directory. It only reads provider state and updates the existing
journal. Exact tagged uploads or completed activations can be acknowledged;
unknown or conflicting results remain pending and cannot be replayed. A
release intent can reconcile either exact-owner-still-held or absent-after-
verified-restoration; an unrelated owner is never adopted. If it remains held,
a separately approved restore call performs the final release after fresh checks.

Restoration requires `--action restore
--confirm RESTORE_PRODUCTION_FROM_MAINTENANCE`. It remains available after
entry expiry, but requires exact original source schema with no authority freeze,
old version/bindings, healthy secure JSON/source and static/cron/domain readback.
It never rolls back after an unqualified schema/cutover change. Source or target
migration/cutover approvals do not authorize restoring the old writer after
new-target acceptance. A pre-activation operation can instead use `--action abort
--executor-stopped --confirm ABORT_UNACTIVATED_MAINTENANCE` after exact unchanged
predecessor/schema proof; this only releases its own lock. Preserve all journals,
including uploaded but inactive versions. Do not retry an uncertain mutation or
edit its intent by hand.

The provider contracts follow Cloudflare's [versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
and [namespace inventory](https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/methods/list/).
Versions do not roll back associated storage state. Run `npm --prefix apps/worker run maintenance:scripts:check` plus the shared
release-operation and existing production-deploy checks before qualifying new
tooling. Local tests
and dry builds do not prove a production transition or drain.

### Maintenance-owned typed cutover

`apps/worker/scripts/production-maintenance-cutover.mjs` continues the exact
maintenance journal and owner. Ordinary production deployment remains unchanged.
The separate closed cutover plan pins that journal UUID/owner/maintenance version,
its deadline, clean candidate source and dependency digest, all three destination
D1 UUIDs/names, lossless namespace, independent journal source ID, the analytics
Worker name and the exact typed-copy/role/ledger proof descriptor. Original source,
ingestion, analytics and independent deletion ledger must be distinct databases;
the ledger must be the predecessor's existing binding, never a fresh substitute.

Prepare and finish target schemas before maintenance acquires the shared owner.
The fixed-copy Worker uses its own CAS journal while containment retains that
owner. Before cutover, stop its Queue/cron and replace or remove its old-source
binding; the sole-writer check refuses any remaining Worker capable of writing the
old source. Pin the post-preparation writer inventory. Its canonical digest uses
the maintained inventory representation and omits only the named analytics
Worker's changing version row; that Worker is independently checked for exact
source/config/database bindings, no HTTP ingress and its intended schedule.
All other Workers and Queue consumers remain pinned.

The qualification mirror must retain all source-bound ingestion role inputs,
analytics qualification, and the exact `deletion-ledger-migrations` directory.
The independent ledger schema and full ordered tombstone/cooldown/job snapshot
are separately pinned. Pending jobs, a restored tombstoned participant, missing
cooldown coverage, foreign source registration, unverified copy/bootstrap, or
schema drift refuse admission. If pending deletion work exists, first complete
ordinary ledger-proven source-side suppression and existing erasure reconciliation
while public traffic is contained, then pin the completed ledger snapshot. The
analytics scheduler does not create missing source-side erasure jobs. This
operator does not authorize that additional mutation through a readiness flag.

```sh
node apps/worker/scripts/production-maintenance-cutover.mjs \
  --plan "$MAINTENANCE_PLAN" --cutover-plan "$CUTOVER_PLAN" \
  --operation "$MAINTENANCE_OPERATION" --repository "$MAINTENANCE_TOOLING" \
  --candidate-worker "$CANDIDATE_WORKER" --qualification-root "$QUALIFIED_MIRROR" \
  --restore-contract "$RESTORE_CONTRACT" --ledger-schema "$LEDGER_SCHEMA" \
  --wrangler-cli "$MAINTENANCE_WRANGLER" --action dry-run
```

Dry preparation uses the immutable source snapshot and exact retained 24-asset
public tree, reruns source-owned workspace/endpoint/release checks, and pins the
same dependency tree before/after commands. It builds the main app and both
analytics modes locally with no credentials or external writes. Retained public
release provenance is checked against the candidate's public source bytes; never
rewrite the release manifest to make a backend candidate pass.

After reviewing the concrete inputs, the same command with `--action apply
--confirm CUT_OVER_QUALIFIED_TYPED_PRODUCTION` creates a disabled analytics Worker
through one journaled deployment (Wrangler cannot upload a first version to an
absent Worker). It verifies no HTTP/cron, admits the copy/role/ledger proof, and
uploads the main and enabled analytics versions separately. The immutable
analytics registration uses the maintained initializer through a closed SQL
adapter and its own intent. Before the first target write the journal durably
forbids old-source restoration. Neither response loss nor expiry clears that
latch. Enabled analytics activation and its cron installation have separate
intents and exact provider readback.

The command deliberately retains the owner and returns
`MAINTENANCE_ANALYTICS_NATURAL_PROOF_REQUIRED` until given a private bounded
Wrangler JSON tail capture from a real scheduled invocation:

```sh
node "$MAINTENANCE_WRANGLER" tail "$ANALYTICS_WORKER" --format json > "$ANALYTICS_TAIL"
```

Stop only that capture process after the next ordinary cron. Do not invoke the
scheduler manually or edit the capture. Restrict the retained file to mode 0600.
Continue the same approved command with `--analytics-tail "$ANALYTICS_TAIL"`.
The proof checks actual Worker version, schedule time after enablement, successful
bounded scheduler result and untruncated exception-free output. Full source,
copy, ledger and analytics catch-up admission must then pass before main-app
activation. A capacity/deadline deferral is not proof of completed catch-up.

After exact new app health/security/static/binding checks, a separate intent
restores the main lifecycle cron on new ingestion. Capture its next ordinary
scheduled invocation in the same manner and continue with
`--lifecycle-tail "$LIFECYCLE_TAIL"`. The final proof requires successful complete
maintenance with analytics explicitly delegated; HTTP200 alone cannot finish the
operation. Only both real schedule proofs plus fresh new app/analytics readbacks
permit release of the same original owner.

For an unknown outcome, stop the executor and use the same inputs with
`--action reconcile --executor-stopped
--confirm RECONCILE_TYPED_PRODUCTION_CUTOVER`. Reconciliation reads first and
never submits a provider mutation. An exact before-effect activation observation
can permit a separately approved forward retry of the same candidate; it never
clears the old-restore prohibition or repeats pristine copy counts after possible
new-target acceptance. Duplicate/foreign versions or unknown ownership remain
pending. Preserve both failed and successful receipts.

Before the first target-write latch, use the closed sibling
`production-maintenance-source-recovery.mjs` to undo an exact source pause. Its
private recovery plan pins the original maintenance journal/owner/version,
restore contract file and canonical digest, original complete source schema,
original `sqlite_sequence` rows, and optional archived cache file. The latter is
only the exact `{singleton,generated_at,payload_json}` row previously archived
from `admin_metrics_history_cache`; its immutable hash must come from the
reviewed archive/delete operation, not a reconstructed replacement. An absent
archive means this recovery never writes the cache.

Stop the copy executor and its Queue/cron, and close/remove temporary copy
resources until the original pinned sole-writer inventory is restored. A
remotely created cutover analytics resource also requires its separately reviewed
closure before this predecessor-only recovery can proceed. Keep the maintenance
owner held and confirm the original drain proof still excludes old in-flight
writers. The recovery checks actual maintenance version/503/static bytes and
writer inventory before each bounded call; the caller's stopped-executor flag
alone cannot replace those provider readbacks.

```sh
node apps/worker/scripts/production-maintenance-source-recovery.mjs \
  --plan "$MAINTENANCE_PLAN" --recovery-plan "$SOURCE_RECOVERY_PLAN" \
  --operation "$MAINTENANCE_OPERATION" --repository "$MAINTENANCE_TOOLING" \
  --contract "$RESTORE_CONTRACT" --source-schema "$ORIGINAL_SOURCE_SCHEMA" \
  --sequences "$ORIGINAL_SOURCE_SEQUENCES" --cache-archive "$EXACT_CACHE_ARCHIVE" \
  --wrangler-cli "$MAINTENANCE_WRANGLER" --action inspect
```

Omit `--cache-archive` only when the plan pins no archived row. After reviewing
these exact inputs, use `--action apply --executor-stopped
--confirm RECOVER_FROZEN_PRODUCTION_SOURCE`. Each call removes at most 16 exact
source-freeze triggers/metadata statements with individual durable intents;
repeat the same approved command while it reports progress. It does not delete
raw rows or baseline schema objects. It removes the final temporary snapshot
page before restoring an archived cache, so the original full database can reuse
that page. The original writer remains blocked by the held recovery journal until
schema, sequences and exact cache bytes are all verified.

An uncertain statement requires `--action reconcile --executor-stopped
--confirm RECONCILE_FROZEN_SOURCE_RECOVERY`. This only reads and distinguishes
exact before/after states. It neither resubmits SQL nor clears an unrelated
intent. Only after `MAINTENANCE_SOURCE_RECOVERED` may the normal separately
approved maintenance restore action reactivate the pinned predecessor. This
recovery never activates a Writer or releases the shared owner itself. After any
target-write latch it refuses unconditionally: recovery is forward-only, and a
typed cutover is not a database rollback.

## Recovery and rollback

- Prefer forward-compatible repair. Never relabel a D1 or local SQLite schema,
  delete a migration ledger, or let older code mutate newer state.
- Before any destructive data operation, identify exact rows/objects, retention
  and tombstone effects, replay behavior, deletion-ledger impact, and the backup
  from which recovery was rehearsed.
- Quarantine retention and restore replay must remain deletion-safe. A deleted
  participant or tombstoned resource must not reappear through backup restore,
  delayed processing, or object replay.
- For tombstoned participants, restore replay atomically claims only active
  rows or interrupted restores with the exact same fence. Social owners retain
  the NULL restore fence; accountless owners use the deterministic
  `restore-replay:<participantDeletionDigest>` fence after revoking their
  enrollment, before changing participant state. Accountless replay resumes only
  that exact reserved fence and refuses other reserved or owner UUID fences.
  Final removal must match the exact claimed fence: the social NULL restore
  fence, the accountless reserved restore fence, or the owner operation UUID.
  Concurrent maintenance cannot finish an owner's unrelated in-flight erasure.
- A Worker rollback must still understand the live schemas and current durable
  state. If it cannot, contain the affected path and deploy a forward repair.
  After migrations 0049–0053, preserve their ledger entries, columns, triggers,
  prepared/raw reader policies and schema inventory when preparing a rollback
  repair; an untouched older checkout's
  migration gate rejects the newer ledger. Do not reverse the schema to make
  that old checkout deployable.
- Do not roll back appcast bytes by ordinary R2 overwrite. The signed feed,
  immutable enclosure, version ordering, and atomic guard are one release
  contract.

## Closeout evidence

Record exact UTC time, source commit, affected surface, read-only observations,
authorized mutations, migration tokens, control revisions, deploy result,
post-change health identity, targeted route result, and remaining risks. Keep
private identifiers and secrets out. Add a dated receipt only when the evidence
has enduring audit or recovery value; otherwise use the issue/incident record
and remove superseded procedural notes from the repository.
