---
title: Telemetry v1.2 implementation and compatibility plan
date: 2026-09-20
type: plan
status: in-progress
---

# Telemetry v1.2 implementation and compatibility plan

Implementation is continuing in `codex/telemetry-v12-integration` from freshly
fetched `origin/main` at `ecf1b31e` (2026-09-21). The original foundation was
preserved as local commit `fb778d17` in `codex/telemetry-v12-foundation`; the dirty
local main checkout remains untouched. Remote main already contains parser v16
for the approved missing-cache-write assumption, so exact-total capture now
uses parser v17 and preserves that predecessor's behavior and provenance.
Remote main advanced to `c9dab823` (PR #185) during implementation; its recovered
tool-free speed behavior is integrated in source. A later read-only fetch found
`6f3a35ea` (PRs #187–#190: Electron tray/startup diagnostics, allowance animation
and admin database health). Git ancestry is not yet advanced to those commits;
a local checkpoint and merge remain required.

**Client release remains blocked until the gates below pass.** The integration
must preserve all supported client versions and current cache calculations.
Source qualification, installed-client qualification, publication and hosted
activation remain separate; no deployment or remote migration is authorized.

## Current completion work — 2026-09-21

1. Reconcile the foundation onto the current remote base, preserving newer
   model-performance/tool-free reporting and runtime packaging. Qualify parser
   v17 against retained v15/v16 evidence and current behavior.
2. Implement correction-safe v1/v1.1 admission and a bounded occurrence-preserving
   reader. Wire effective facts into every daily, quota, graph, history and
   publication pathway; preserve unique older-client observations.
3. Connect independent v1.2 capability/authorization, prepared upload, typed
   storage and readers while leaving legacy capability responses frozen.
4. Persist full-turn duration and event-time mode through a forward migration.
   Qualify late-evidence revisions, overlap handling and independent performance
   transport, lifecycle and authorization.
5. Complete restore/erasure inventory, synthetic mixed-client end-to-end
   qualification, focused and owning gates, and local candidate qualification.
   Record any genuinely unavailable native or protected release gate explicitly.

The dated checkpoints below describe their original foundation revision; they
are not evidence that the rebased integration candidate has passed those gates.

## Fixed decisions

- Performance remains daily-only. The owner accepted possible cross-device
  history overlap on 2026-09-21; use reported-sample labels and ordinary replay/
  revision deduplication, without a new per-turn membership artifact. Usage
  occurrence reconciliation remains strict.
- V1 and v1.1 remain closed, independently valid contracts. Introduce v1.2 with
  fresh version, dictionary and privacy tuples; legacy grants do not authorize
  it. Keep all supported installed-client versions operating concurrently.
- Negotiate per client. No owner-wide write floor, fleet cutover date or
  mandatory history deletion can make an old client obsolete implicitly.
- Preserve raw input/output totals already present in the existing contract.
  Missing or contradictory evidence remains null. Cache-write zero and unknown
  remain distinct; outcome remains unknown without a qualified source.
- Keep `cache-retention-v2` and its public output unchanged during collection.
  Do not implement a turn-scoped reducer, shadow calculation, UI selector or
  new cache method until a separate decision after significant collected
  history. Migration history already reserves v3; do not reuse that identity.
- V1.2 remains provider-neutral. Collect compact continuity and non-additive
  cache-write TTL detail. Latency remains a separately qualified daily stream
  under an independent capability; its readiness must not delay continuity.

## Integration qualification checkpoint — 2026-09-21

The integration now includes real v1.2 local dispatch with a separate progress
journal, accountless successor-policy negotiation and a social field review,
fresh hosted grant and exact local approval. A read-only review keeps a stable
field/count sample across grant creation; actual upload projection separately
pins the server-issued activation instant. Legacy local flows remain covered.
The social flow passes 14 loopback/transport tests and 292 browser/projection
checks. The owning browser suite passed 975 tests before the latest PR #185
port, and the local suite passed 378 before final performance composition. The successor review explicitly names continuity and cache detail, with 21
focused browser/localization checks passing. Its production markup and render
function were inspected in an isolated synthetic browser fixture in English,
Spanish and Simplified Chinese, including a narrow layout without horizontal
overflow and disabled approval while signed out. This component check does not
qualify a real account, the full installed application or native rendering.
Native and installed-client qualification have not been established.

Typed restore preserves dictionary identifiers and active correction facts
through an interrupted/resumed copy. All current migrations are covered. The
operator adapters pass 28 checks, including direct and placed queue execution,
unknown-response refusal and the distinct typed restore sequence. Populated
v1.2/performance copy, idempotent replay, owner erasure, R2 cleanup and late-retry
refusal passed together with correction admission and domain closure: 33 tests
across four Worker files. This is local synthetic evidence only.

The database transport fence now scopes v1/v1.1 upgrades per device, including
an actual v1 insertion after a sibling device upgrades: 30 v1.1/v1.2 transport
tests pass. The effective graph path uses the existing quota/model reducers,
separate durable checkpoints and bounded occurrence pages. A correction-active
v1 owner produces a ready model result, resumes/replays safely within the
900-statement budget, and refuses a changed owner revision. A 3,400-row archive
is read in five-occurrence pages without materializing the whole day.

Timing-store schemas advance from 2/3 to 4/5, preserving old measurements and
refusing older writers. Independent mutation counters advance on ordinary
appends and replay corrections; file cursors are not uploaded as revisions.
Performance capability explicitly negotiates receipt and tool-free methods.
The production dispatcher now forwards the local continuity callback: a real
synthetic index-to-upload test proves a post-cutoff boundary mask and tie order,
with pre-cutoff values remaining null. The latest focused client/parser suite
passes 68 tests. V1.2 quota, session and usage all pass through typed and shared
effective readers; chunk-local record indexes cannot collide across chunks.

The Worker workspace package, generated binding, TypeScript and operational
script gates pass (785 assertions across the script suites). Architecture passes
with 642 production files, 2,635 imports and no approved debt edges; preflight
passes 20 tests. The synthetic accounting benchmark passes outside the restricted
sandbox. Dense effective cache-day resumption, bounded historical dependency
identity and final social-performance qualification remain under completion.
Checkpoint persistence must respect the [D1 row and string limits](https://developers.cloudflare.com/d1/platform/limits/).
The broad root run recorded 5,826 tests: 5,754 passed, 24 failed and 48 skipped.
The twelve browser harness failures were subsequently fixed and the full browser
suite passed; the synthetic accounting benchmark passed outside the restricted
sandbox. Eleven native/release checks remain unqualified: a Keychain migration
UI subprocess timeout, a nested network-sandbox failure, two retained R7 receipt
source-hash mismatches, and seven R7 resource/process-monitor checks. The UI
subprocess timeout is unresolved, not established as an environmental failure.
Protected receipts were not regenerated and no test assertions were weakened.

These checks do not establish installed-client, protected release or deployment
qualification and do not authorize activation.

## Historical foundation scope — 2026-09-20

This section records the original slice and its then-open work. The integration
checkpoint above supersedes its implementation status.

The foundation consists of parser-v17 raw-total capture, its compatibility
checks, dormant v1.2 package contracts, local continuity evidence and pure day
preparation. The source integration adds usage reconciliation and a v1 archive
behind an inactive runtime. Neither slice connects a v1.2 writer or makes a hosted
analytical reader v1.2-capable.

1. Preserve selected `input_tokens` and `output_tokens` in the existing typed
   index columns. Keep cumulative-delta selection, replay admission and split
   components unchanged. Reject totals contradicted by known components.
2. Bump parser provenance, not physical schema. Rescan available v15 sources;
   retain unavailable sources with their actual parser and null totals. Keep
   v15 boundary interpretation intact and explicitly qualify the v16 cold
   refresh deadline.
3. Add staged records, chunks, manifests, domains, envelopes, consent constants,
   TypeScript declarations and generated package/root/browser mirrors.
4. Prepare immutable v1.2 days using an explicit cutoff and supplied continuity
   evidence. Validate ranks over the whole day, including groups crossing a
   chunk boundary. This pure API does not persist or grant policy authority.
5. Verify exact totals through v1/v1.1 exports and measure before/after effective
   totals and pricing. All cache-v2 results must remain invariant. Sparse rows
   can become measurable; measure and review those restatement differences.

The local application gate passes 336 tests. Focused parser/replay, attribution,
legacy projection, v1.2 contract/preparation, schema mirror, browser parity,
pricing and cache-v2 regression checks pass. The Worker suite passes 1,854 tests;
the complete owning command stops at the later clean-release-tree prerequisite
for asset staging. Its deployment dry runs remain unqualified.

The local evidence path is now available through opt-in
`readDayWithV12Evidence(day)`. It shares the reviewed boundary parser predicate,
joins exact event keys within the published-generation snapshot and qualifies
order using source generation/cursor coordinates. Missing/ambiguous evidence
stays null. The selector ranks final emitted records after exclusions; normal
v1.1 `readDay(day)` keeps its original query and result shape. Synthetic
index-to-preparation tests cover all four masks, clock ties, activation cutoff
and unchanged v1.1 output. Policy persistence and uploader wiring remain open.

### Pricing and reader findings

The Worker context adapter in `quota-analysis-v1.ts` already reconstructs a
missing total from three complete input components. Complete short- and
long-context rows should therefore retain their price after raw-total capture.
Sparse input vectors can gain partial pricing when the total becomes known.
The local `legacy_zero` compatibility path deliberately treats a missing total
as zero and can change context bands after capture; it must be measured
separately from the Worker.

The Worker pricing adapter also needs to recognize a combined output that
exactly matches the known text/reasoning split. Otherwise its accounting mapper
classifies that same output twice, with the combined copy unpriced, and wrongly
downgrades coverage. Normalize only an exact redundant alias for pricing, retain
the raw stored total, and leave incomplete/conflicting evidence explicit.
Deploy this adapter support and the correction admission described below before
repaired clients or historical restatement.
The cache-v2 mapper reads none of the raw totals or output counters.

### Existing-family correction gate

The parser repair preserves occurrence IDs but changes canonical record bytes
and day/chunk digests. Current source behavior is:

- V1 sync compares chunk digests and submits the next revision. The Worker
  atomically replaces the old chunk and queues a day rebuild. This permits
  null-to-known repair while v1 remains authorized, but also permits a later
  old-client null to overwrite the new evidence.
- V1.1 can stage the changed day, but complete-domain closure requires an
  existing occurrence's base record to match exactly. Null-to-known totals
  fail with `TELEMETRY_COMPATIBILITY_PROOF_UNAVAILABLE`; the previous head
  remains active and the candidate remains staged.
- The exact v1-to-v1.1 preservation check also refuses a candidate whose totals
  are repaired while the v1 source still contains nulls.

These findings come from `telemetry-v1-chunks.js`,
`telemetry-v1-repository.ts`, `telemetry-v11-domain.ts`, and the preservation
triggers in `migrations/0058_accountless_upload_ownership.sql`. Focused parser
and sync tests pass (52), as do typed v1.1 closure (13) and v1 preservation (8).
The current guards are functioning as designed; those passing tests do not
qualify repaired-byte correction across the guards.

Add an explicit, bounded correction proof and occurrence-level preservation
rule before releasing parser v17. A formerly null exact total may become known
only with qualified source provenance and consistent shared components. Later
older uploads must remain admissible for their unique occurrences without
erasing known evidence. Contradictory known totals cannot be silently preferred.
This requires forward-only admission/storage changes and synthetic alternating
old/new-client tests. An owner-wide minimum version or repair ordering promise
does not meet the concurrent-client requirement. V1.2 remains staged until its
own reconciliation also handles these corrected overlaps.

Retain the existing v1.1 canonical and attribution-free base digests. A
two-total correction needs a separate proof over authenticated immutable source
rows; it must not redefine general base identity. Typed closure, legacy JSON
closure, v1 preservation and append classification each enforce their own exact
proof today. Qualify each lane explicitly before relaxing it. The analytical
reconciler drops attribution when projecting to v1, so it cannot by itself
authorize an attribution or continuity change during admission.

Existing owner-level `hasV11` choices in `storage-community-daily.ts` and
`storage-community-authority.ts` are protected by current transition rules.
The exact preservation triggers in
`typed-v1-admission-migrations/0002_typed_v1_domain_preservation.sql` and
`typed-v11-admission-migrations/0003_typed_domain_closure.sql` are useful
precedent, but do not solve continuing mixed-version complementary history.
V1.2 readers must replace the binary owner-wide choice under the reconciliation
requirements below.

## V1.2 field contract

| Field | Exact meaning | Bound and missing evidence |
| --- | --- | --- |
| `boundaryFlags` | Bit 0: top-level user turn before this accepted usage; bit 1: compaction since the previous accepted positive-input usage. Both can be set. | Integer 0–3 or null. Zero proves both false; null means shared coverage is unreported. |
| `tieOrder` | Rank among emitted usage with the same session and millisecond. It is not an offset, session-wide ordinal or turn index. | Integer 0–819,199 or null, derived from 4,096 chunks × 200 records minus one. Each complete group is all null or exactly 0 through n−1; a reported singleton is zero. |
| `cacheWriteTtl` | Closed `{ fiveMinuteTokens, oneHourTokens }` subdivision of aggregate cache writes. | Null, or both bounded integer counts with a sum equal to non-null `inputCacheWriteTokens`. Never add these counts to the aggregate again. Codex emits null. |

A client persists its first effective v1.2 policy activation instant. Historical
restatement remains allowed; earlier records carry null continuity. Later
records also carry null whenever parser or source-order proof is unavailable.
The whole-day canonical byte ceiling remains 64,000,000. The compact mask and
rank use constrained nullable integers in future typed storage. Do not pack
rank into the mask because they can be independently unavailable.

No turn ID, raw account identifier, source path, offset, whole-session event
index, prompt, response, command or compaction payload is added to telemetry.

### Model latency and tokens per second: independent staged contract

The detailed measurement, histogram precision, overlap and independent-delivery
requirements are in the [daily performance specification](../design/2026-09-20-performance-telemetry-contract.md).

The staged v1.2 contract currently permits only usage, quota and session
streams. It contains no timing measurements or performance histograms. Raw
output totals, boundary flags and tie order cannot supply response durations
or time to first token. The completed correction/archive work therefore does
not qualify hosted model latency or output speed.

The main checkout has a separate local diagnostic timing parser, store and
model-performance projection. The foundation now includes the qualified
parser and a bounded content-free daily projector; retained-store/application
integration remains open. Preserve its quality exclusions and distinguish
receipt-derived from legacy timing methods. Local model speed uses qualified
sample output tokens divided by matched response duration; TTFT uses its
separate measured milliseconds. Neither inter-request gaps nor full-turn
duration can substitute for those measurements. Reasoning output must not be
added again to an output total that already includes it.

Qualify a separate daily performance stream under its own capability and
activation gate. It must not widen per-event usage or delay continuity
collection. The staged `model-performance-daily-v1` record and
`performance-histogram-v1` helper now define closed, versioned bucket edges
with overflow handling, integer counts and milliseconds, and bounded
fixed-point extrema. They retain day, provider, model, reasoning effort, method and
bucket-scheme versions; speed-mode attribution stays unavailable without
qualified per-turn evidence. The new parser and daily cohort key retain
event-time mode with explicit source, and keep API tier separate. Carry
qualifying/total sample counts, speed token and duration sums, and separate
speed, TTFT and full turn completion histograms. Merge histogram
counts before computing percentile bands; a ratio of total tokens to total
duration is a different statistic from median per-turn speed. Do not average
client percentiles or conflate the two statistics.

Daily aggregates have no occurrence IDs, so the usage reconciler cannot dedupe
their overlapping turn samples. The owner accepted this limitation on
2026-09-21: pool compatible reported samples, label possible cross-device
history overlap, and deduplicate ordinary retries and per-device revisions.
Do not add per-turn membership telemetry. Revisions, replay, partial days,
method changes, erasure and restore
must invalidate the same aggregate dependencies. Older clients remain valid
without timing capability; absence is unreported coverage, never zero speed
or latency. The schema, public types and browser mirror cover measurement
validation only. Add privacy/policy, negotiation, prepared-set, typed storage,
reader, publication and UI qualification for this stream. It remains separate
from the unchanged cache-v2 calculations.

## Mixed-version reconciliation: required before reader implementation

The earlier proposal to select the highest complete family for an owner-day
was insufficient. Complete upload proves receipt of that client's day, not
coverage of another client's history. Compatible overlaps alone do not prove
that unique older occurrences have been preserved.

The final design must produce one authoritative analytical result per owner-day
while preserving every admitted unique occurrence. A single newer source can
replace an older source only when its coverage and shared-field reconciliation
prove that replacement safe. Where devices have complementary history, the
reader design needs a normalized occurrence set with explicit source provenance,
or another proven complete representation. It cannot silently discard the
nonwinning family or blindly sum overlapping families.

- Usage identities and session identities must remain stable across versions.
  Verify these identities against actual stored layouts before deriving joins.
  Current unified-index identities are device-salted; stability across versions
  on one device does not establish cross-device identity for copied history.
  The performance timing store has a separate store-local key and no reviewed
  join to those usage occurrences. Resolve identity scope before claiming
  cross-device deduplication for either stream.
- V1 quota observation IDs use a lossy legacy projection; v1.1 uses exact
  source-occurrence IDs. Time/slot equality is not proof of one-to-one identity.
  An ambiguous mapping remains explicit and must not be deduplicated by guess.
- Late old-client uploads can introduce unique evidence and must invalidate
  coverage proof. Retaining the row while leaving a supposedly complete
  selected result unchanged is insufficient.
- Persist source references, generation/fingerprint and reconciliation status
  together. Replacement, restatement and erasure invalidate the same dependent
  results. Readers cannot independently choose version precedence.
- Until reconciliation succeeds, preserve recoverable source data and last-good
  results with their actual freshness/coverage. Never present ambiguous pooled
  data as complete or treat incomplete evidence as zero.

V1.2 stays unadvertised while this design and mixed-device tests are completed.
Existing legacy consent, historical v0.2 restrictions and erasure contracts must
also be preserved; a new successor is not permission to delete old history.

### Staged usage correction primitive

`apps/worker/src/telemetry-usage-reconciliation.ts` now validates usage records
through their frozen v1/v1.1 or staged v1.2 parser. It retains the original
canonical record digest and separately hashes a reviewed shared projection with
only the two total fields removed from comparison. The source upload is never
rewritten. All other shared usage fields must agree for total enrichment.

The bounded primitive preserves distinct occurrence IDs and is independent of
arrival order and replay. A null cannot erase a reported total. Conflicting
known totals, inconsistent splits and differing shared fields remain explicit.
No effective analytical record is emitted for a conflicted occurrence.
Complete component vectors require equality; partial vectors provide only a
lower bound. Missing totals are never inferred. Inputs are scoped to one owner,
limited to 200 records and 1,250,000 bytes, with a 16 KiB per-record bound.

A per-occurrence streaming accumulator now applies those same page limits
while retaining constant-size state across pages. It snapshots each page
before hashing, merges it atomically, rejects concurrent append/close calls,
and emits only when the caller explicitly closes the group. Later nulls cannot
erase known totals or conflicts. Conflicting timestamps produce a null time
and no effective record, independent of arrival order. Nineteen focused tests
cover the page primitive and accumulator, including 205 pages; the source
reader must still prove that all authoritative variants were enumerated before
closing a group.

This is derived usage evidence, not source authority or a complete owner-day
result. Attribution, boundary masks, relative tie ranks and TTL subdivisions
remain attached to their original source digests; this primitive does not join
them. In particular, a relative tie rank can change when two clients emit
different subsets of the same timestamp group. Quota observations cannot enter
this usage join because their legacy identity projection is lossy.

The next integration milestone must bind the reconciled occurrence-set digest
to exact device/chunk/domain dependencies, source generations and explicit
coverage/conflict status. Late unique legacy evidence must invalidate that
result and queue its owner/day. Start with one daily projection pathway, then
extend the same dependency model to graph, history, quota and publication.
Current `hasV11` selection and one-device v1 selection are not coverage proofs.
The bounded source reader should select day candidate IDs first, then expand
every authoritative owner-scoped variant of each occurrence, including variants
whose timestamps fall on other days. Existing uniqueness is per v1 device or
v1.1 manifest, not per owner; filtering variants to the requested day could
price a conflicting occurrence twice. Complete a group before advancing its
output cursor. A group with more than 200 historical sources needs bounded
pages and constant-size conflict/total state, never silent truncation.

For current v1, start from the owner/time index and verify the complete admitted
chunk and exact ingestion event before decoding bounded storage IDs. Include
all devices. For retained v1.1, reuse immutable manifest proofs and retained
generation snapshots without a current-head restriction, but pin the full
event/generation/manifest tuple and active authority. Staged manifests are not
sources. Correction history needs a day-candidate index in addition to its
occurrence-leading index, and reconstruction must continue to rehash both
original and comparison digests. Fence owner revision/epoch, analytical input
revision and public authority before pages and completion. Legacy JSON remains
a separately qualified layout; it cannot fall through typed proof readers.

Add archive/reconciliation tables to their owning database's erasure and
absence checks, restore manifests and readiness before enabling durable
capture. The correction archive belongs to the source database; adding it to
analytics-database payload checks would query the wrong storage role.

### Dormant source archive

The staged `0006_usage_correction_facts.sql` migration and
`telemetry-usage-correction-repository.ts` preserve typed v1 usage before a
replacement retires its source row. The real typed v1 writer now captures the
complete prior usage chunk atomically with replacement when that runtime is
active. Absent or staged runtimes retain the existing writer behavior. V1.1
already retains its source
generations, so this first archive refuses v1.1 and v1.2 capture. The pure
reconciliation primitive above still validates all three wire families.

History stores typed dictionary references, integer counters and timestamps,
and binary occurrence/digest values. It retains immutable source chunk and
event digests as well as the original record digest; internal row IDs alone
are insufficient replay provenance. A thin fact references each history row
without duplicating its counters or storing a JSON payload. Each reader
reconstructs and hashes both the original record and shared comparison base;
SQL source admission alone cannot validate the method-specific base hash.

The repository exposes a bounded preparation/commit API that captures history
and its fact atomically with supplied source-retirement statements. Current
source authority and owner revision/epoch fence capture. Historical owner
revision remains recorded on the archive while reads require current owner
authority. Each read snapshots its owner, revision, epoch and pagination once,
then checks that authority before and after the page query and after digest
reconstruction. The runtime starts staged and effective-fact reads require
active state. The typed v1 writer uses the capture API; no production analytical
reader consumes the archive yet, so capture activation remains blocked.
An owner can have several current chunks: its latest journal event is not a
coverage proof for all of them. Capture checks each chunk's own complete,
unsuperseded admission and immutable digests under the current owner revision.

A correction-owned participant-erasure trigger is part of the migration.
The protected owner-erasure path now passes a populated, active-archive test:
history and facts are removed while global dictionary rows are retained.
Role qualification checks the complete correction schema. Legacy-to-new-role
restore seeds a valid staged runtime; correction-source restore is explicitly
unqualified pending preservation of typed references. This archive is
recoverable evidence, not a replacement for current-family correction
admission or owner-day reconciliation.

Capture budgeting must include the enclosing upload transaction, source reads
and verification, not just the archive writes. D1 currently permits 100 bound
parameters per query and 1,000 queries per paid Worker invocation; individual
query limits also apply inside a batch. Qualify the maximum 200-record page
against those bounds. [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Archive insertion now uses one bounded bulk statement, with positional binary
digests and per-row provenance triggers. Query accounting includes that
statement, the CAS, caller statements and fixed capture/ingress reads within
the conservative 900-query budget. Triggered row work is separately bounded by
the 200-record page; it is not counted as separate prepared D1 requests. The
real writer passes a replacement test with 200 distinct sessions/models.

## Remaining implementation work

Capture is connected to the real typed v1 replacement transaction and its
erasure/schema inventory is covered. Typed-source restore and effective
readers remain prerequisites before enabling the runtime. Admission must
continue accepting useful older-client records;
rejecting a whole upload because an overlap has null totals would also discard
its new occurrences. Reader qualification must therefore precede relaxation of
v1.1 closure guards. Existing per-chunk arithmetic summaries, single-device
selection and owner-wide v1/v1.1 choice cannot establish the required
occurrence-preserving result. Keep this source integration staged until those
dependencies are implemented and tested together.

Active capture has database guards on chunk, record, admission and allocation
retirement.
They require exact retained usage evidence before ordinary typed v1 retirement,
including when an older Worker bypasses the new JavaScript hook. Authorized
owner erasure remains available, and staged or absent correction runtimes
preserve legacy behavior. No client version floor is introduced by this
storage safeguard.

The allocation remains until its matching typed usage chunk has been retired
through those guards. Deleting that proof anchor first is refused even after
the header is marked superseded. Normal parent deletion retires the typed
chunk before its allocation cascade, so no missing-parent exception is needed.

Before activating capture, qualify every deployed writer and rollback target
against the archive transaction. Supported older clients can keep uploading
through upgraded Workers; an older Worker that lacks capture will be refused
when it tries to retire unarchived evidence. That database refusal prevents
loss, but does not qualify a mixed-Worker deployment for normal traffic.

The existing authority-restore path converts legacy JSON records into a new
typed namespace. That does not establish restore support for a source already
containing correction history: its integer dictionary, namespace, owner,
device and session references may outlive the retired source records. A
qualified restore must preserve those references exactly or verify an explicit
mapping, then rehash the reconstructed archive. Merely retaining the four
correction tables is insufficient. Keep unsupported typed-source restores
fail-closed rather than classifying their durable evidence as disposable
analytics.

| Area | Required work and qualification |
| --- | --- |
| Integration base | Reconcile this feature branch with the intended release base and migration inventory. A feature-branch head does not identify the live deployment. |
| Current-family correction | Qualify null-to-known total repair through v1/v1.1 admission and domain closure. Preserve repaired evidence against later older uploads while continuing to admit their unique occurrences; do not ship parser v17 before this gate. |
| Local source proof | Opt-in index evidence and day preparation are implemented and tested. Qualify installed-client source lifecycle and persisted activation before enabling collection; retain explicit unknowns for unsupported evidence. |
| Client authority | Persist activation cutoff across restart; update field inventory, visible review, privacy copy and accountless-policy migration. Preserve pause, disconnect and durable opt-out. Negotiate the highest mutually supported authorized version for each client. |
| Preparation and transport | Add v1.2 prepared-set identity, envelopes, manifests, receipt types, retry/recovery, explicit capability advertisement and admission. A v1.1 grant cannot authorize v1.2. |
| Typed ingress | Add forward-only format-12 migration, mask/rank/TTL columns, dictionaries, codec, admission/copy verification, manifests, readiness and provider schema generation. Retain old layouts and frozen decoding. |
| Reconciliation | Implement the occurrence-preserving mixed-version model above, including complementary histories, partial candidates, conflicting overlaps and late legacy arrivals. |
| Ordered delivery | Classify v1.2 explicitly. Replace default-to-v1.1 branches and owner-wide booleans; include exact reconciled source dependencies in delivery and projection keys. |
| Daily and publication | Normalize v1/v1.1/v1.2 into the existing analytical fields. Preserve effective totals and current pricing semantics; report measured restatement deltas. Never add TTL detail twice. |
| Model latency and TPS | Add and qualify the separate daily performance stream above. The current v1.2 schema carries no timing. Preserve timing method/quality, histogram merge semantics, sample coverage and honest reported-sample overlap semantics; qualify local-to-hosted parity before publishing charts. |
| Quota and allowance | Replace direct v1.1 snapshot/head assumptions with reconciled evidence. Preserve provisional/unavailable attribution and avoid lossy quota identity assumptions. |
| Graph and history | Add v1.2 to reconstruction, carry, history and admin readers; retain one coherent result per owner-day without hiding older unique occurrences. |
| Cache-v2 | Feed reconciled existing request fields only. Mask/rank cannot affect the algorithm, gaps, ties, public method identity or current output. |
| Restore and erasure | Update restore manifests, storage-mode/adoption checks, participant erasure, backups and every derived invalidation path. Partial restore cannot advertise readiness. |
| Operations | Extend local lab, migration rehearsal, cold/warm workers, bounded queues, fairness and progress counters. Source statements and events matter as well as completed marks. |
| Readiness | Count coverage, owners, days, null/known boundaries and resolved/unresolved tie groups, admin-only and tied to source erasure/restatement. Do not calculate new cache rates. |

## Acceptance matrix

Use synthetic, content-free fixtures for:

- V1-only, v1.1-only, v1.2-only, and multiple versions from the same owner/device
  population; disjoint days, complementary same-day history, exact overlap,
  conflicting overlap, partial upload and late old-client arrivals.
- Every new nullable state, boundary mask 0/1/2/3, tied groups crossing chunks,
  rank gaps/duplicates/mixed nulls, source/clock ambiguity and pre-cutoff history.
- Exact totals with complete splits, partial splits, contradiction, explicit
  zero, positive synthetic cache writes and output-only usage. Compare pricing
  both below and above the context-band boundary.
- Timing with receipt and legacy methods, missing or invalid durations, sparse
  percentile coverage, histogram edge/overflow values, identical bucket ranges across clients,
  full completion versus response duration, event-time Fast/standard settings,
  mid-turn changes, resumed parsers, overlapping device history, and old clients
  or rows that report no new fields. Compare daily/weekly pooled
  histograms against exact synthetic local samples with explicit error bounds.
- Restart, retry, replay, same-size replacement, source rotation, partial
  generation, failed activation, erasure, restore and disabled rollout.
- Strict privacy canaries, unknown keys, malformed versions, bounded errors,
  immutable deterministic bytes, and stale consent rejection.

Run focused tests, then owning root/package/local/Worker checks. Run architecture,
documentation and preflight checks after integration. Do not regenerate protected
R7 receipts to hide a pre-existing release-evidence failure.

## Client-version rollout

Roll out by each client's mutually supported, authorized capability. Maintain
v1, v1.1 and v1.2 readers together; do not set a fleet-wide client floor or a
calendar date that discards older traffic. A new client cannot replace an
owner's older clients or hide their unique observations.

| Client capability | Required behavior |
| --- | --- |
| Usage v1 only | Continue frozen v1 admission and reads. New continuity/timing fields remain unavailable. |
| Usage v1.1 only | Continue frozen v1.1 authorization, admission and reads; its existing Fast/standard labels remain meaningful. |
| Usage v1.2, authorized and mutually supported | Prepare and send v1.2 with persisted activation and independent manifests; retain predecessor evidence and deduplicate by qualified occurrence rules. |
| No performance capability | Keep supported usage streams running; skip unsupported performance without changing usage receipts or retry budgets. |
| Performance capability once qualified | Negotiate the independent exact dictionary/method/bucket tuple; keep per-device report revisions, permission and receipts separate. |

Every contributor uses the same fixed TPS histogram ranges. Numerical merging
adds corresponding counts; overlapping devices may report the same turns,
so pooled percentiles describe reported samples rather than unique turns.
Never average personal percentiles or choose ranges
from each person's observed minimum and maximum. Fast/standard, unknown and
mixed cohorts are separated before aggregation. Full turn completion time
has an independent positive-millisecond histogram alongside TTFT and TPS.

## Rollout gates

1. Foundation source tests and generated mirrors pass.
2. Current-family correction admission, dormant successor migrations and all
   readers rehearse on disposable state while old traffic remains supported.
   Mixed-version reconciliation and non-regression of repaired evidence are proved.
3. Review complete field inventory, policy migration and visible client copy.
4. Qualify an installed client: cutoff persistence, negotiation, old-format
   fallback, v1.2 upload, retry, revocation and continued old-client operation.
5. Separately authorize deployment, remote migrations and client publication.
6. Collect a significant back catalog and review duration, volume, continuity
   coverage, tie resolution and contributor concentration. A provisional floor
   such as 30 days/10,000 turns/95% coverage is a discussion aid, not automatic
   authorization to introduce a new cache calculation.

Rollback may stop new v1.2 advertisement and writes. Once successor data exists,
its readers, provenance and deletion/restore paths must remain available;
rollback cannot relabel or destructively downgrade stored evidence.

## Foundation validation checkpoint — 2026-09-20

Evidence applies to the uncommitted foundation candidate based on `0fb6a5e6`,
using Node.js 26.2.0. All new fixtures are synthetic and content-free. No real
contribution, production migration, deployed Worker or installed client was
changed or qualified.

| Check | Result |
| --- | --- |
| `pnpm run product:local:test` | 336 passed. |
| Local evidence ownership, selector, reader and cache checks | 55 focused tests passed after sharing the exact parser predicate through the local facade. The final local reader suite passes 15 tests, including positive masks and tied-order propagation through v1.2 preparation. |
| Parser, cache-boundary and unified-index focused tests | 7, 25 and 134 tests passed respectively; includes reparse, rotated history and replay preservation. |
| Unified accounting source and attribution tests | 54 passed. |
| Worker pricing and total-capture regressions | 24 passed; complete short/long prices and coverage remain equal, while newly measurable sparse evidence remains partially priced. |
| Existing Worker cache-v2 and daily projection regressions | 61 passed. |
| Publication-reader correction | 15 focused tests passed; 121 related publication, warming, accountless and recovery tests passed after the fix. |
| Final Worker dependency copy and TypeScript | Package guard and typecheck passed after the final validator and reader changes; pricing regressions passed again. |
| Contract/preparation, schema and browser parity | 27 contract/preparation tests passed; 36 schema copies checked, including frozen predecessors. |
| API reference check | Passed. |
| Correction and reconciliation foundation | The initial 29 tests passed: 16 archive/repository and 13 pure reconciliation cases. Includes 200 distinct sources, multiple current chunks, forged digests, owner read races, immutable read options, bounded retirement, and retained-source reconstruction after same-transaction typed v1 replacement. The source integration checkpoint below supersedes these counts. |
| Migration/rehearsal tooling | 52 tests passed. This is local tooling qualification, not a remote migration or restore rehearsal. |
| Final archive migration compatibility | 46 tests passed across existing v1 admission, append classification, owner erasure, ownership and restore/adoption suites. Populated correction-archive operational allowlists and restore qualification remain separate gates. |
| Architecture, documentation and preflight | Passed. |
| Full Worker check before publication-reader correction | 1,773 tests passed and 33 failed across nine files; the owning gate did not pass. Later dry-run stages were not reached. |
| Worker rerun after reader and fixture corrections | All 1,819 tests passed across 140 files. The command then stopped at asset staging because the candidate is uncommitted; production and staging dry runs remain open. The later archive changes are qualified by the separate correction and storage regression rows above. |
| Worker source integration checkpoint | All 1,854 tests passed across 144 files, including the real v1 writer archive hook, streaming reconciliation, protected owner erasure and typed-source restore refusal. Workspace-copy guards, generated types, TypeScript and script checks passed earlier in the same command. The owning command again stopped at the clean, committed release-tree prerequisite for asset staging; neither deployment dry run was qualified. This run preceded the final allocation-deletion fence, qualified separately below. |
| Final allocation fence | 34 focused Worker tests passed across writer, archive/repository, admission and operational erasure coverage; Worker typecheck passed. The superseded-header test proves allocation deletion and subsequent unarchived typed-chunk retirement are both refused. Independent review found no remaining blocker in this bounded area. |
| Final correction schema inventory and restore checks | Both inventories contain all 25 migration objects. Storage script groups passed 42, 2, 10 and 31 tests; authority restore role passed 6 tests, including complete/partial/view-only correction-source refusal before any restore mutation. |
| Daily performance measurement foundation | Closed staged record, fixed sparse histograms, safe arithmetic, approximate Type-7 bounds, public types and schema/browser mirrors implemented. Final focused suites pass 42 tests, with 600 seeded numerical cohorts. The [performance checkpoint](../design/2026-09-20-performance-telemetry-contract.md#qualification-checkpoint--2026-09-20) records packaging repairs, the 1,855-test Worker run and the non-green full-root boundary. At the September 20 checkpoint no local timing adapter or upload authority was connected; the September 21 follow-through below adds the parser and daily projection while retaining the activation gates. |

Two time-dependent baseline fixture failures were reproduced independently:

- The metrics-history test uses a fixed `2026-08-21T11:00:00.000Z` gauge
  fixture. By the 2026-09-20 validation run it is outside the reader's 30-day
  window, so the expected nonempty series failed at that checkpoint. This
  fixture is now relative to the run time; the reader's retention is unchanged.
- The dormant-owner publication test activates a domain using yesterday's
  noon. Its predecessor token expires 24 hours later, while the D1 admission
  view checks the actual current time. Afternoon runs correctly refuse that
  expired token with `TELEMETRY_MANIFEST_CONFLICT`. The same failure occurs
  on clean `0fb6a5e6`.

A representative deferred-publication failure also reproduces on clean HEAD.
Its cache writer uses the full `V1_FIT_CACHE_KEY`, including fit-gate and cycle
versions, but the publication reader checks only `V1_FIT_CACHE_KEY_SUFFIX`.
The exact suffix comparison therefore rejects a valid cached member. The
foundation corrects the reader and source-family-change check to use the full
writer key. It changes no cache calculation, method identity or pricing rate.
Focused validation after that correction is recorded separately from the
earlier full run; it cannot retroactively make that run pass.

Both time-dependent fixtures are now repaired with scenario-relative times;
their focused tests pass. Production expiry and retention guards are unchanged.
The three calculator scale cases now pass for 100, 500 and 1,000 contributors.
The staged usage reconciliation primitive and streaming accumulator pass 19
tests, including alternating family order, late nulls, conflicts, disjoint
occurrences, multi-page groups, bounds and owner isolation. The later full
Worker test suite passed as recorded above. The earlier
broad run also preceded the final
dormant v1.2 timestamp/envelope hardening, which was checked separately through
contract tests, generated mirrors, the refreshed Worker package and TypeScript.

The next integration step is current-family correction admission and the
mixed-version reconciliation/storage/reader work listed above. The new
preparation API is not connected to production transport. Both pricing support
and correction admission must precede any repaired client or restatement, even
while the v1.2 contract stays staged.


## Initial performance follow-through — 2026-09-21

This checkpoint preceded the transport and timing-store integration described
above; the remaining work listed here records that earlier boundary.

The staged performance stream now has per-turn Fast/standard/unknown/mixed
cohorts with explicit evidence source, plus an independent full-completion
histogram and count. Its parser and pure daily projector are qualified through
synthetic end-to-end evidence; old timing rows retain TPS/TTFT without invented
new fields. Fixed TPS ranges remain identical for every contributor. See the
[September 21 performance checkpoint](../design/2026-09-20-performance-telemetry-contract.md#qualification-checkpoint--2026-09-21).

The remaining performance integration is a forward timing-store migration and
source replay, independent client-version capability/preparation/receipts,
source-coverage reconciliation, hosted storage/readers/erasure/restore and
approximation-aware presentation. These do not add timing fields to usage
v1.2 or block continuity collection. Current-family total correction and
mixed-version usage readers remain the immediate usage release gates above.
