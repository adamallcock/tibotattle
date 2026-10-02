---
title: Maintained analytics capacity review
date: 2026-10-01
type: review
status: partial
---

# Scope and result

Read-only source review of G06/G04/H04 and framework R04 on the shared local
candidate based on `f056940fefabed0c7f0e88353cf54845b077f0c8`. This is a
point-in-time review of the uncommitted implementation, not a storage benchmark,
combined correctness result, cloud-capacity check or rollout qualification.
The initial review performed no tests, remote requests or production changes.
The authorized local repair and focused validation are recorded in the addendum
below. Miniflare validation was serialized with P0/P11; the lane is released.

The 17 new migration files declare **72 analytics-target tables and 11 source
tables**. Their ordered path/NUL/content/NUL SHA256 at 2026-10-01 10:29 UTC was
`0b62fb90bc69d2e40e2b8aaa6fd83ac24e5a3fcd96ee8c38404957dd4db5a744`.
Terminal-erasure inventory is present for these families. That inventory does
not establish ordinary capacity or row/byte-bounded retirement.

At 23:38 UTC, the current inventory has **18 pending migration files and 84 new
tables**: 73 analytics tables in 0034–0048 and 11 source tables in 0014–0016.
The added 0048 source-backed cache-preparation receipt is one target table.
The 83-table family review below describes the earlier snapshot; its capacity
qualification remains open with 0048 included in the current inventory.

The October2 daily-prefix repair adds one subject-free source/day cursor to
pending0034: the current inventory is85 tables (74 analytics and11 source),
with the same18 pending files. Each row stores only a numeric incarnation,
position and revision; there are no owner IDs or readiness values. Existing
retirement removes at most16 eligible metadata rows per opportunity, retaining
queued/incomplete days. That page bound does not prove a total day/storage cap.
Exact empty-table AUTOINCREMENT high-water restore and stale-CAS refusal remain
new qualification gates; source-role authority restore does not cover this
derived target metadata. The existing family table below remains dated evidence.

At October 2, 06:47 UTC, the applied cache date cursor brings the current
inventory to **86 new tables (75 analytics target and 11 source)**, still in
18 pending migration files. It stores scheduling coordinates only: numeric
incarnation, fixed cycle upper day, next day/ordinal, slot limit and revision.
Six installed guards cover active-owner insertion/update, terminal transition,
fence INSERT/UPDATE replay and owner DELETE. Cleanup visits at most 16 eligible
rows and preserves the AUTOINCREMENT sequence. Native empty-table logical
transfer controls and three physical restore controls pass; four other native
cases fail during fixture setup. Original same-owner fairness and final populated
restore remain open. The earlier family counts below retain their dated scope.

**G06/R04 remain open.** Pending queue capacity and the recently added
publication/cohort/rolling child pages are concrete local bounds. Current
normalized evidence and source provenance still require capacity qualification.
The four identified unbounded/replay cleanup defects are locally repaired and
covered by the focused synthetic tests in the addendum. G04 also needs measured
*admitted* concurrency; configured degree alone is insufficient. H04 needs
complete equal-output mutation runs before storage/performance results can
qualify the composition.

Current authority: the [redesign plan](../plans/2026-09-28-analytics-redesign.md)
and [execution ledger](../plans/2026-09-30-maintained-analytics-framework.md).
The [artifact inventory](../../apps/worker/src/storage-erasure-artifacts.ts)
provides the exact table list and terminal/FK contract.

## All new families

Counts below cover all 83 tables. A bounded page is distinct from a total-store
ceiling. Statements, row writes, logical payload bytes, allocated database pages
and isolate memory are distinct resources.

| Family | Tables | Retained cardinality and ordinary lifecycle | Capacity qualification still needed |
|---|---:|---|---|
| Target0034 preparation | 2 | One source cursor and owner/range state; owner terminal hooks. | Full-history/skewed range progress and stable post-drain counts. |
| Target0035 dependency summaries | 1 | At most1024 scopes per owner; payload up to256KiB; save removes at most8 oldest scopes when count exceeds1000. This is a memo with native-proof fallback. | Aggregate bytes, ceiling refusal/fallback and large payloads; owner row ceiling is not a target byte reservation. |
| Target0036 canonical facts/input | 14 | Current facts/heads retain normalized accepted evidence; variants/days/tools hang from facts. Manifests hold at most128 rows; retirement now limits nonempty manifest deletion to one root. Input scope/work and seen sets remain as current replay proof; seen is replaced on source stamp change. | Full current evidence footprint; old-generation churn; skewed seen-set reset; fact child fanout and pinned rolling references. No total fact/head/seen byte ceiling. |
| Target0037 contributions | 4 | One quantity per fact; prices and memberships use dependency-specific immutable generations; activity head follows manifest. Successful materialization removes old requested dependencies. | Interrupted price cleanup and unbounded cleanup row fanout, described below; payload/index storage per selected/effective view. |
| Target0038 scheduling/reverse links | 11 | Pending jobs have reserved admission via0043. Completed/refused rows retire after the caller's age cutoff and only after descendants retire. Ranges/global effects require completion and exact ACK. | Retained completed/refused backlog, incoming lineage fanout, effect/subject reverse rows and physical cascade cost. |
| Target0039 rolling | 4 | Segment/window roots are current or pinned native inputs; obsolete children drain in128-member and128-row pages. Source-stamp supersession requires a sealed replacement. | Total current rows/window memberships and concurrent generation high-water footprint; last-good/checkpoint pin preservation under other family retirement. |
| Target0040 cache | 14 | Current fact slots/logical nodes, adjacent pairs and compact counters; bounded stale slot/empty-day/partition retirement. Current source-backed historical facts remain. | Total lifetime slot/node storage, mutation pair/neighbor fanout, group/session refusal parity and empty evidence continuity. Output-window size does not bound all input metadata. |
| Target0041 publication/cohort | 12 | Current part heads and last-good cache pins remain; old unpinned closures/parts/cohorts drain children first under source-wide live-lease guard. | Many simultaneous pinned revisions/closure populations; maximum65536 expected/member bound and exact refusal behavior for denser date populations. |
| Target0043 counts/controls | 2 | Queue populations have at most7 stages×4 states per source;3 role control rows. Pending admission thresholds65280 background,65472 new,65536 withdrawal. | Backlog at the ceiling with heterogeneous descendants and storage exhaustion, not only slot exhaustion. |
| Target0045 maintained graph work | 6 | Subjects at most2 selection methods per owner; refs follow input scopes; demand days retire outside current fits/70 model dates; source controls/policy state are compact. Old graph-dirty dates retire in16-row pages when no ready/leased fits/publication work holds them. | Input/ref scope growth and drain cost across retained source days; daily rollover churn. |
| Target0046 empty outcomes | 1 | Exact absent/withdrawn delivery receipts; acknowledged outcomes retire in16-row pages. | Large empty/moved-range churn and exact source ACK before receipt disappearance. |
| Target0047 maintenance | 1 | One source cadence row; due-time/revision CAS; empty sweep is paced for one minute; productive child pages stay due. | Cleanup service rate versus arrivals/backlog, including all cascade writes. |
| Source0014 mutations | 2 | One global counter and one participant counter. Counter updates replace previous values; terminal hooks remove owner rows. | Admission-trigger write amplification and terminal removal at skew. |
| Source0015 selective catalog | 9 | Global runtime/bootstrap; per-owner bootstrap; bounded work and reverse-work draining; variant locations and day/range stamps retain invalidation evidence. Source effects require exact row/stamp ACK. | Historical variants and distinct interval stamps lack an independently proven capacity/compaction bound. Their age is not proof of obsolescence. |

Target0042/0044 and source0016 add contract/terminal hooks, not tables.
The older native checkpoint, feature-part, model-block and public stores also
consume target space; an83-table incremental inventory does not measure total
installed database capacity.

## Gaps recorded at the initial review snapshot

Items 1–4 describe the pre-repair implementation. Their local resolution is
recorded below; items 5–6 and aggregate capacity qualification remain open.

1. **A skewed source-stamp reset clears the entire input seen set in one SQL
   batch.** [Input reset](../../apps/worker/src/storage-canonical-analytics-input.ts)
   deletes all `analytics_canonical_input_seen` rows for the scope before
   returning to reading. A128-row acquisition page does not bound that deletion.
   The reset is transactional and lease guarded; replacing it with LIMIT alone
   would break the reset contract. Qualify it with a skewed scope first, then
   consider an explicit staged reset/drain if the resource bound is exceeded.

2. **Fact retirement bounds parent count, not every child write.**
   [Ordinary fact retirement](../../apps/worker/src/storage-canonical-analytics-facts.ts)
   requires no heads, effects, manifest rows, publication part links or active
   consumers. Valid fact provenance can contain many variant/day/tool rows and
   contributions can contain multiple retained generations. Their cascades are
   not separately paged or included in the returned fact count. The predicate
   also does not exclude rolling-row references; verify that this cannot undo
   the rolling adapter's current checkpoint pin protection.

3. **Pending queue reserve is not a lineage/storage reserve.**
   [Queue lifecycle](../../apps/worker/src/storage-analytics-partition-work.ts)
   admits at most32 successors per call and rejects cycles. Many completed
   parents can converge on one child. Deleting that terminal child can cascade
   an arbitrarily large incoming `analytics_partition_work_links` set, even
   when the pending population is below65536. Completed/refused arrivals and
   one-day caller retention are not covered by the pending-slot ceiling.
   Preserve incomplete descendants and exact effect lineage when qualifying
   a bounded link drain.

4. **Interrupted repricing can retain old price generations indefinitely.**
   [Contribution cleanup](../../apps/worker/src/storage-canonical-feature-contributions.ts)
   writes new prices, then rechecks currency, then deletes old price rows only
   when `priceWrites.length>0`. If currency fails after the write, a subsequent
   same-dependency replay reuses the saved prices and skips that deletion. The
   old dependencies then persist unless a later new price is written or the
   fact disappears. Both price and membership cleanup DELETEs have no row LIMIT.
   Current-generation retention needs a drain independent of whether new rows
   were written, with the same authority and pin contracts.

5. **83-store footprint and source provenance retention remain unmeasured.**
   Source0015 catalog variants keep unique `(participant,family,source_row,
   variant_digest)` locations, including historical corrections. Day stamps
   replace one `(participant,day,stream)` value, while interval stamps retain
   distinct `(participant,from_day,through_day)` keys. This is required
   invalidation evidence, not disposable old cache data. Work/reverse-work
   draining and effect ACK do not by themselves prove historical locations can
   be discarded. A compaction design needs a complete source/target dependency
   closure or must retain the evidence and establish admissible storage capacity.

6. **Degree1/2/4/8 does not establish useful heavy-work concurrency.**
   The dispatcher shares one actual950-query meter and caps estimated residency
   at32MiB in the runtime composition. Most feature/graph/publication requests
   reserve600 queries; two such jobs cannot be admitted in one wave. Canonical
   requests reserve160 and can have a different admitted degree. Record claimed,
   admitted and completed counts by stage, collision/defer reasons, actual CPU/
   sampled heap and same-primary SQL time. These estimates are not measured peak
   heap, and cooperative jobs do not imply parallel D1 primary SQL execution.

## Capacity evidence and estimates

### Existing measurements

The redesign plan records a September30 read-only source allocation of
**9,811,828 typed v1/v1.1 records**,54 physical typed owners and57 devices; the
largest device has2,521,345 records. This is retained allocation, not the active
output census. V1.2 and correction archives are excluded. No live inventory was
refreshed here.

The [separate synthetic shard storage receipt](../receipts/2026-09-30-analytics-shards-storage.json)
records1,268,297,728 allocated bytes for9,811,828 narrow synthetic headers
(129.26 bytes/header), with indexes created before loading. It does **not**
include the full telemetry source or any of the83 maintained stores. Its storage
slope cannot be reused as a normalized analytics bytes/record estimate.

P11 diagnostic8 returned the small candidate lane with final guards but did not
persist its complete paired profile after the native peer failed. Diagnostics
6/7/8 incomplete JSON artifacts contain no database footprint observation.
The current profile now records local D1 `meta.size_after` first/latest/maximum
samples, but this review has no complete dense all-store receipt to consume.
Logical JSON bind/result sizes, cumulative rows written and the two legacy
checkpoint payload counters are not retained physical storage.

### Explicit sensitivity only

Let `F` be retained normalized facts, `H` current heads, `V` canonical variant
links, `D` canonical day links, `S` input seen rows, `Q` quantity rows, `P` price
rows, `M` membership rows, `MR` manifest links and `R` rolling rows. The following
is a conservative sum of required text keys in table rows only:

```
logical_key_bytes >= 448F +146H +128V +74D +128S +128Q +256P +192M +128MR +128R
```

It excludes values/JSON, other columns, other stores, indexes, SQLite page
slack, transient generations and public/native stores. It is not a measured
physical database size. Under the illustrative all-usage shape
`F=H=V=D=S=Q=M=MR=R=N` and `P=2N`, the sum is2012 key bytes per fact;
for `N=9,811,828` it is19.74 decimal GB. That shape is **not** the observed live
population: selected/effective duplication, formats, horizons and source
eligibility must be measured separately. Its purpose is to show why a
129-byte synthetic-header slope cannot establish this design's capacity.

| Assumed total incremental bytes per allocated record |9,811,828-record sensitivity |
|---:|---:|
|500 |4.91GB |
|1000 |9.81GB |
|2000 |19.62GB |
|4096 |40.19GB |

These are assumptions, not measured rates or a proposed cloud layout.
The summary memo's declared maximum alone is1024×256KiB per owner, or
14,495,514,624 payload bytes for54 owners; actual summaries are commonly much
smaller or null. Existing model-block bounds allow40MiB committed payload per
owner plus a save successor. Neither maximum is an observed footprint.

The repository configures a9,000,000,000-byte source operating budget in
[analytics delivery](../../apps/worker/src/analytics-delivery.ts), with typed
admission headroom. No current provider maximum, available target capacity,
index-build memory feasibility or cloud storage duration was checked here.
The historical6.76GB source allocation is not a present remaining-space result.

## Smallest useful qualification slices

These are proposals. P0 must assign test/source ownership and P11 must release
the Miniflare lane before any execution. No production composition or SQL
change is needed to demonstrate the current gaps.

| Priority | Synthetic slice | Meaningful assertions/evidence |
|---|---|---|
|1 | One current fact,16 interrupted price changes, same-dependency reuse after each save | Current price rows converge after replay; exact price/output parity; no old dependency growth; record actual cleanup row writes and retain current publication pins. This directly reproduces gap4 cheaply. |
|1 | One terminal child with2048 incoming completed parents, plus a pending descendant control | Retirement keeps the control ancestry; terminal cleanup converges; per-page physical writes are bounded independently of parent count. Include duplicate/lost-response admission and FK checks. |
|1 | One retired fact with2048 provenance variants and linked days; pinned checkpoint/publication controls | Measure physical cascade fanout and prove pin/lease exclusion. Count child writes independently of `factsRetired`; keep erasure hooks unchanged. |
|2 | One source/day scope with32768 then65536 seen occurrences; mutate source stamp after sealing and during interrupted acquisition | Exact reset/replay convergence and no stale head loss; actual largest SQL row writes/time, query budget and sampled heap; decide whether a staged reset is required. Same record count spread over many days is the control. |
|2 | Fresh1k/10k/100k dense fixture through actual public adapters, separately for selected/effective and mixed formats | Baseline and steady/high-water source/target/ledger allocated bytes; count all83 tables and older native stores; retained logical payload bytes by family; cold→warm→correction/reprice→retirement footprint. Report slope, intercept and temporary multiplier; extrapolate only after shapes and doubling slopes stabilize. |
|2 |65536 expected closure/member rows, cold and superseded, with pinned/live-lease controls | Closure/member bound and explicit refusal at65537; bounded128-child pages, actual marker/header/cascade writes, drain service rate and physical absence. A130-child test proves paging but not maximum-population storage/drain time. |
|3 | Uniform versus concentrated hash prefixes and dense single-day populations, equal total rows | Complete split convergence, leaf sizes≤128, finite empty-leaf overhead, no starvation at reserved queue capacity, explicit outcome at closure ceiling. Use staged10k/100k fixtures rather than immediately loading9.81m full records. |
|3 | Actual degree1/2/4/8 runs over the same stage mix and skew | Measure admitted concurrency and complete outputs under one actual meter; serialize output heads; preserve withdrawal capacity and same-owner fairness. Adopt useful degree or record an evidence-backed single-executor decision. |

For the storage slice, collect table counts and `sum(length(CAST(payload AS
BLOB)))` only on disposable synthetic databases after each acknowledged phase.
Treat those aggregate inventory probes as explicitly separate measurement
operations, not free product work. Local allocated pages are not wire bytes,
WAL/fsync, cloud replicas, GB-month billing or exact isolate heap.

Use the9.81-million cardinality only as a later extrapolation target until a
full-format eligible census and measured bytes/fanout matrix exist. A target
storage refusal must preserve the native/reference result or an explicit
unknown/last-good outcome; no count reduction, missing evidence converted to
zero, or weakened publication gate can qualify capacity.


## Authorized local repair and validation addendum

P0 authorized four source repairs after the read-only review. They preserve
schema, admission caps, the safety query reserves, current provenance and
producer eligibility. Production composition and migration SQL were unchanged
by this repair slice.

| Repair | Per-invocation progress and deletion proof | Negative/replay fixture |
|---|---|---|
| Input source-stamp reset | An exact live claim/version CAS places work in `draining`; at most128 seen rows and one pending receipt are removed. The old stamp stays until both child stores are empty, then the reset adopts the fresh stamp and resumes acquisition. | 2048 stale seen entries; a competing live claim preserves them; a lost reset response resumes another128-entry page; accepted current heads stay exact; the final seal and warm replay match. |
| Obsolete canonical facts | After bounded metadata/page retirement, one eligible obsolete fact drains at most128 total variant/day/tool/price/membership/quantity rows. Every child write rechecks absence of heads, effects, manifests, publication part facts, rolling rows, cache slots/nodes and ready/leased consumers. Quantity deletion proves no price/membership dependents; fact roots delete only after all child families are empty. | 2048 complete variants plus a linked day; a current survivor head remains readable; cache slot and rolling row/window membership independently prevent fact-child retirement until the owning adapter releases them. |
| Terminal queue lineage | One old terminal leaf drains at most128 total effect refs, incoming lineage links and subject refs. Subjects drain last. Root deletion proves absence of outgoing/incoming links, effects and subjects. Existing bounded range/global/dirty/schedule cleanup is retained. | 2048 completed parents converge on one terminal child; each invocation removes128 links while retaining the child until its final link disappears; a completed parent with a ready child remains linked. |
| Reused contribution cleanup | Requested families drain at most128 stale price rows and128 stale membership rows, even when the current price was reused. A bounded residual probe keeps the producer deferred until stale rows are gone. Current requested dependencies and omitted families remain intact. | New price/membership save succeeds before currency interruption; replay reuses the saved price with zero pricing calls, drains200 old price and200 old membership generations over two invocations, and preserves the omitted fit family. |

`factChildrenRetired` is an additive public retirement result field. The
maintenance scheduler includes it in productive progress immediately; terminal
queue retirement also returns child progress. The existing0047 due-time/version
CAS, counted response statement and one-minute empty-sweep pacing remain intact.
The128 child bound is distinct from already bounded metadata/page operations in
the same invocation. Returned row-family counts do not represent index bytes or
the total physical database footprint.

A contribution producer may need additional scheduled invocations before it
returns `complete` when stale generations exceed a cleanup page. Saved current
results are reused on those turns. Publication of the new completed product may
therefore be delayed by cleanup backlog; complete unaffected output remains
available. No new hidden cleanup state or truncated complete product is used.

Validation on the shared candidate:

- `npx tsc --noEmit` in the Worker app passed after source/test preparation and
  again after the final focused run.
- `npx vitest run test/canonical-analytics-facts.spec.ts test/storage-canonical-analytics-input.spec.ts test/storage-analytics-partition-work.spec.ts test/canonical-feature-contributions.spec.ts -t 'G06 bounds'`
  passed **4/4 selected tests**, with46 unrelated tests skipped, in5.15s.
- The synthetic tests assert actual local D1 `rows_written` metadata, including
  trigger/index writes, per invocation: reset≤512; fact retirement≤700;
  convergent lineage≤600; contribution cleanup/replay≤512. These are fixture
  ceilings that would fail the previous unpaged deletes; they are not universal
  caps for every other operation in those adapters.
- The initial run exposed two new-fixture defects (SQLite UPSERT parse ambiguity
  and an interruption hook observing read batches). Both were corrected; the
  two affected tests passed their focused retry before the final four-test run.
- All four fixtures use synthetic content-free evidence and finish with an
  empty `PRAGMA foreign_key_check` result. No full suite, benchmark, remote call,
  cloud-capacity test or real-history experiment was run.

**Remaining acceptance:** whole-candidate owning correctness qualification;
83-store logical and allocated-page footprint at representative cardinality and
skew; source-provenance capacity with legitimate history preserved; arrival vs
retirement service rate; equal-output full mutation profiles; and measured
admitted concurrency under the existing safety reserves. The9.81m-record byte
scenarios above remain extrapolations, and the narrow shard receipt remains a
measurement of that fixture only. These local cleanup repairs do not establish
G06/R04 aggregate capacity, G04 performance or H04 mutation qualification.

## Completed sparse diagnostic footprint — read-only addendum

P0 and the capacity lead inspected the completed `-10` paired candidate receipt
after the initial review. It predates the latest producer index/admission,
retirement and optimized-baseline repairs. Its190 current canonical heads, two
owners and ten cache dates are a sparse diagnostic population, not a production
slope or a dense capacity qualification.

| Family | Rows | Logical row bytes |
| --- | ---: | ---: |
| Source selective catalog and mutations |237|90,447|
| Target dependency summaries |160|171,957|
| Canonical facts/input/provenance |1,994|778,830|
| Feature contributions |820|617,237|
| Queue/effects/reverse links |3,203|1,332,014|
| Canonical cache |636|435,733|
| Publication/cohort |1,818|1,184,796|
| Counts, graph work and maintenance |300|108,577|
| Preparation, rolling and empty outcomes |0|0|
| All83 new source and target tables |9,168|4,719,591|
| Older target stores |483|869,756|

The whole target contains9,414 rows /5,498,900 logical bytes; its new tables are
8,931 rows /4,629,144 bytes. The separate source metadata inventory is254 rows
/92,073 bytes and excludes accepted core telemetry. Thus the83-table total
includes237 source rows; it must not be added to the older target stores and
called the whole target. Payload bytes overlap the logical row totals.

Local target allocated bytes were10,952,704 last /12,021,760 maximum. Per-table
physical/index bytes, wire/WAL costs, storage duration and true peak heap are
unavailable. The initial and after-cleanup logical inventories are equal.
Missing age/state/pin aggregates prevent treating the1,332 work rows as pending,
completed or obsolete, and256 price rows include independent daily/fit families.
Neither count is evidence that retained generations are orphaned.

The next capacity slice remains1k and10k measured current heads, at fixed
calendar/output scope with accepted mixed formats and uniform/skewed controls.
It must distinguish admitted records, logical occurrences, current heads, pins,
superseded generations and queue states; measure temporary growth and guarded
drainage before extrapolating. The existing600-row per-call corpus limit is not
an authorized test bypass.

P0 refreshed [Cloudflare's D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
on2026-10-01: Workers Paid permits1,000 queries per invocation and10GB per
database; one D1 instance executes SQL serially. The database size maximum
cannot be increased. Cloudflare also documents a30-second query/API-batch
limit. These provider limits do not establish current account plan, free target
space, hosted index-build feasibility or measured workload capacity. Source0015
contains large index builds; local transactional rollback of130 statements
does not qualify their hosted duration.

Current production composition still selects degree1. An isolated actual-consumer
fixture for degrees1/2/4/8 is being implemented separately, with one950-query
meter, production residency/release reserves and identical ready-job snapshots.
Publication remains one writer. It will report actual admitted degree, not infer
parallel primary SQL or close whole-workload10× from a component result.

## Additional small-corpus footprint observation — October 1, 23:30 UTC

P0 inspected the preserved aggregate cold evidence from the first retained
functional-branch attempt, whose five branch actions did not execute. This is
one exact ten-day / one-requested-date / seventy-retained-model-date corpus,
with genuine accountless secondary input. Both lanes completed the same eight
public families before a private publication-counter comparison refused base
capture. The full log SHA-256 is
`fc8954474f3578235d32ece6c4f98b0eca4ba3fef44dd7f51f37072e919c1e52`.
Its input pins and execution boundary remain in the integration ledger; this
observation does not transfer to later code or establish a complete mutation
receipt.

| Observed target dimension | Candidate | Pinned native |
| --- | ---: | ---: |
| First D1 `meta.size_after` | 1,306,624 bytes | 589,824 bytes |
| Latest D1 `meta.size_after` | 12,091,392 bytes | 2,899,968 bytes |
| Maximum observed D1 `meta.size_after` | 12,181,504 bytes | 3,248,128 bytes |
| Retained rows in the inventoried target stores after cleanup | 9,886 | 782 |
| Logical SQLite value bytes after cleanup | 6,125,074 | 1,355,841 |
| Inventoried payload-column bytes after cleanup | 1,816,465 | 756,438 |
| Canonical facts | 190 | Store absent |

Candidate source observations were first 3,416,064, latest 3,547,136 and maximum
3,567,616 bytes; native source remained 2,904,064 bytes. Both ledgers remained
53,248 bytes. Every reported size sample was available. These are local SQLite
footprints; they exclude physical wire transfer, cloud storage duration,
WAL/fsync and unsampled peaks. Logical inventories cover their declared stores,
not an independent page allocation per table.

The candidate's largest inventoried retained target stores by logical value
bytes were work (1,046,104), publication parts (579,166), canonical facts
(370,786), dependency summaries (365,324) and shared-feature parts (326,436).
No candidate inventoried rows were retired in this particular final cleanup;
the native lane retired rows. This alone neither proves a leak nor adequate
cleanup service rate. Current pins, active publications and the actual age
cutoff must be checked before retirement is expected.

A 190-fact measurement does not qualify ten-million-record capacity or provide
an admissible linear storage slope. Full retained-history/skewed footprint,
transient generations, source provenance, total-store bounds and safe capacity
refusal remain open, even though the owner deferred the tenfold speed target.
