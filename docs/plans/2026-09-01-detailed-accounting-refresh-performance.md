---
title: Detailed accounting refresh performance handoff
date: 2026-09-01
type: plan
status: proposed
---

# Detailed accounting refresh performance handoff

## Status and claim boundary

This is a source-level handoff for a follow-up performance task. It does not
claim that the detailed-accounting path has been optimized, qualified on real
history, or released. It must be rebound to the exact merged source revision
that follows the 0.1.17 refresh-policy and mixed-plan correctness fixes before
implementation begins.

PR #94's formal account/plan-attribution empirical gate remains **OPEN / NOT
RUN** unless its separately reviewed cross-revision comparator and sanitizer
produce the required attribution and eligibility reconciliation. This plan's
profiling receipts, synthetic comparisons, R7 results, and native/dogfood QA do
not close that gate or authorize hosted methodology activation.

Draft source boundary: branch `codex/refresh-accounting-progress-rc9`, based on
`35802d21ede67d362533f4e2be6b38041ece1cda` (PR #101). This is not the final
optimization baseline: the refresh, snapshot, and plan-scope corrections are
still under integration review. Wait for the coordinator's exact merged SHA.

The reference dogfood observation was content-free and owner-local: a changed
generation took approximately 7 minutes 13 seconds to complete detailed
accounting over roughly 730,858 usage events, 958,509 quota occurrences,
907,314 tool facts, and 7,217 sources. The unified index was approximately
1.6 GB and collector state approximately 1.5 GB. Those figures characterize one
Mac and one corpus; they are a baseline for profiling, not a support promise.

## Objective

Make an explicit detailed-accounting refresh fast, bounded, cancellable, and
visibly progressive enough that users do not experience a long opaque
"Calculating accounting" state. Optimize the changed-generation path first,
because the light refresh path is deliberately separate and must never launch
detailed accounting.

The work is successful only if it preserves every accounting, attribution,
privacy, and generation-binding invariant. A faster plausible result is a
failure if it loses events, crosses plan populations, substitutes missing
evidence with zero, reuses stale work as current, or can publish after cancel.

## Product contract to preserve

The refresh-policy change preceding this task establishes three distinct user
intents:

- ordinary Refresh is light and updates quota/headline evidence without
  rebuilding detailed accounting;
- automatic refreshes are light except for a bounded, at-most-hourly detailed
  attempt after the app is otherwise idle;
- `Recalculate detailed accounting…` is an explicit deep operation.

Performance work must not collapse those operations back into a single route or
make an ordinary refresh pay for speculative detailed work. It may make the
explicit deep operation dramatically cheaper.

The mixed-plan correction preceding this task also requires a selected-plan
timeline. A current Pro, Plus, or ProLite fit may use only compatible evidence
from that plan population. Unresolved speed within an admitted plan population
uses the existing Standard scenario; the Fast scenario remains a separate
sensitivity. All-plan Usage-and-costs totals remain unchanged.

The correction also separates plan-preserving quota observations from the
generic quota timeline and publishes comparable intervals. Rolling windows and
cumulative drift cannot bridge another plan or an ambiguous bucket. The new
comparison cache and companion transport use compact `plan_bucket_v1` rows, with decoding
only at the browser boundary, and explicit resource
refusal (100,000 rows / 4 MiB), never a convenience-sized history cutoff.
Performance changes must preserve those interval, quota-conflict, and refusal
semantics. A timestamped `same_record` plan label alone does not prove a discrete
reported usage increment.

## Current pipeline

The deep path is composed through
[`createLocalCollectorRefreshRunner`](../../src/local-companion-refresh.js).
At a high level it:

1. captures fresh quota/headline evidence in the collector;
2. incrementally advances the unified index;
3. validates the authoritative unified generation;
4. attempts an exact same-generation accounting-cache reuse;
5. on a miss, calls
   [`refreshReplaySafeAccountingCache`](../../src/replay-safe-accounting-cache.js);
6. reloads and publishes the full local companion projection only after the
   generation-bound cache is durable.

The accounting rebuild itself scans the unified source, extracts bounded
accounting facts, derives transition/calibration evidence, computes reporting
projections, validates the closed cache schema and source descriptor, and
atomically writes the cache. It already has AbortSignal checks, child-process
settlement, memory ceilings, a deferred-over-budget outcome, and strict source
generation/fingerprint checks. Those are safety controls, not optional
overhead.

The reusable aggregate benchmark is
[`scripts/benchmark-local-index-retirement.mjs`](../../scripts/benchmark-local-index-retirement.mjs).
It reports useful counts, wall times, disk bytes, generation fingerprints,
cache behavior, and phase-boundary RSS. It is not yet a complete performance
receipt: it does not report true peak RSS or child CPU, and its legacy comparison
is not a comparison between two Git revisions. It also injects an in-process
counted scanner into the cache refresh, so it does not exercise the production
isolated accounting child or its canonical result transport. A
production-shaped child benchmark is required before ranking bottlenecks.

The current public accounting progress contract accepts only the single
count-free marker `{ kind: "accounting", status: "calculating" }`, emitted
immediately before a rebuild. The child reports no internal phase or bounded
progress, so a long opaque state is expected behavior rather than evidence that
the UI simply failed to render richer progress.

### Verified source-level optimization candidates

The first source audit found three high-confidence candidates that should be
measured before attempting incremental accounting:

- [`createLocalUnifiedAccountingSource`](../../src/local-unified-accounting-source.js)
  constructs a usage-attribution reader whenever a usage callback is present.
  That reader performs membership, same-record plan, source-predecessor, and
  often session-predecessor SQLite queries for each usage row. The initial
  windowed aggregate pass and full-history aggregate pass receive those enriched
  rows even though their period aggregation does not consume plan-attribution
  or usage-interval metadata. Attribution is required later for the compact
  calibration/selected-plan corpus, so the safe candidate is callback-aware
  stream selection or an explicit no-attribution aggregate reader—not removal
  of attribution from the calibrated pass.
- The full-history aggregate scan supplies no quota callback, but the unified
  accounting source currently still iterates and materializes admitted quota
  rows. At the reference scale that can mean walking roughly 958,509 quota
  occurrences for a consumer that discards them. Make source iteration
  callback-aware and prove that consumers which need quota evidence retain it.
- The unified scanner awaits every callback even when the consumer is
  synchronous, while several accounting consumers only need to yield and check
  cancellation at a bounded row cadence. A synchronous-callback path with
  explicit cooperative yields may remove hundreds of thousands of unnecessary
  promise continuations, but it must preserve row order, fixed error mapping,
  cancellation latency, and RSS checks exactly.

These are verified control-flow observations, not measured attribution of the
seven-minute wall time. Add phase/query instrumentation, then take them in this
order if the profile confirms material cost. They are lower-risk than a new
generation-delta algorithm because they remove unused work while preserving the
existing full recomputation.

## Hard invariants and non-goals

Do not weaken or bypass any of these to obtain a better timing:

- The cache must match the exact authoritative unified-index generation and
  fingerprint before it is called current.
- Cancellation and timeout must fence durable publication. Late child work may
  not overwrite a newer generation or a retained good cache.
- Replay, retry, restart, source duplication, forks, and corrections must not
  double count.
- Token components, event-time prices, speed provenance, Standard fallback,
  Fast sensitivity, quota occurrences, plan attribution, switch boundaries,
  and warning/provenance totals must remain exactly conserved.
- Unknown, unavailable, stale, partial, and unattributed evidence stays explicit;
  it is never converted to zero or silently borrowed from another plan.
- Resource ceilings and owner-only state permissions remain hard gates.
- No real history, paths, filenames, account identifiers, prompts, responses,
  or raw event objects may enter logs, profiles, fixtures, receipts, commits, or
  pull requests.
- Do not reduce retained history or calibration range merely to improve speed.
- Do not change R7 receipts, run R7, install an app, or publish a release until
  the release coordinator explicitly owns that protected step on frozen source.

## Questions the first profiling pass must answer

Treat the following as hypotheses until measured:

1. How much wall time and CPU belongs to unified-index ingest versus accounting
   extraction, transition derivation, weekly calibration, projection assembly,
   schema validation, serialization, and SQLite publication?
2. Does a changed generation re-read or materialize the same usage/quota rows
   multiple times for the all-plan ledger and selected-plan timeline?
3. Are large compact arrays copied or JSON-serialized repeatedly between the
   parent and accounting child?
4. Are SQL scans using the intended indexes and bounded ordering, or are they
   spilling/sorting large intermediate sets?
5. Does worker parallelism shorten extraction or merely increase memory
   pressure, garbage collection, and parent/child transfer cost?
6. Which portions are generation-invariant and can be reused by a validated
   content-addressed intermediate receipt?
7. For a one-file append, what fraction of the seven-minute run is logically
   unchanged work?

## Work plan

### 1. Freeze a reproducible, private benchmark protocol

Use one immutable owner-only corpus snapshot and fresh empty mode-0700 state
directories. Run revisions sequentially on a quiescent Mac with the same exact
Node 26.2.0 binary, worker count, time range, price registry, plan selection,
and environment. Never benchmark against the installed app's live writable
state.

Capture three workload classes:

- cold build from empty derived state;
- no-source-change detailed refresh;
- small append that advances exactly one generation.

Run at least three measured repetitions after one warm-up. Preserve only an
allowlisted, content-free receipt containing source revision, workload digest,
runtime identity, aggregate counts, phase wall time, user/system CPU, true peak
RSS, result/cache/index bytes, and pass/fail states. Fail closed if source
inventory or generation changes during a run.

Three repetitions provide an initial median and range, not a defensible p95.
Use a larger predeclared sample for percentile qualification; report the raw
sample count, values, and percentile method rather than labeling the maximum of
three runs as p95. For the append case, keep the source snapshot immutable and
use two fixed snapshots that differ by one reviewed synthetic or owner-approved
append, applied identically for every baseline/candidate repetition.

The existing benchmark can seed this work, but extend or wrap it through a
reviewed repository entrypoint before treating the result as canonical. Do not
use the CLI `transitions --codex-home` path for corpus selection without first
fixing and testing its current forwarding gap.

### 2. Add phase instrumentation before optimizing

Emit monotonic, content-free timing and count markers at these boundaries:

- unified-index preflight and ingest;
- accounting child startup;
- source descriptor and resource preflight;
- usage/accounting fact scan;
- compact calibration-corpus scan;
- transition derivation;
- weekly/plan calibration;
- timeline and report projection assembly;
- validation and serialization;
- durable cache write and final companion reload.

Measure CPU and true peak RSS for the accounting child, not only the parent or
phase-boundary snapshots. Instrumentation must be bounded and disabled or cheap
in ordinary production use. It must never include identifiers or row samples.

### 3. Make the existing fast paths provably fast

Before designing incremental accounting, verify and improve these lower-risk
paths:

- A no-change unified-index preflight should scan zero source bytes and reuse the
  exact same-generation accounting cache.
- Cache validation should avoid deserializing or cloning large projections more
  than once.
- The final companion reload should receive the reusable unified projection
  directly rather than recomputing it.
- A light refresh must never start index ingest or accounting and should retain
  the last authoritative detailed figures with explicit freshness truth fields.

Add tests that count calls and bytes, not merely elapsed time, so the fast path
cannot regress silently on a faster CI host.

### 4. Remove duplicate full-corpus work

Use profiles and query plans to identify repeated scans and materializations.
Prefer a single streaming fold that feeds both all-plan accounting and the
selected-plan timeline where their inputs are identical. Keep their outputs and
admission policies separate; sharing a scan is not permission to mix plan
populations.

Candidate improvements, in descending safety order:

- expose a generation-bound read session that validates the immutable index
  once, serves separate usage, quota, aggregate, and calibration streams, and
  revalidates the generation before publication;
- project only required columns from SQLite and add/revise indexes when an
  actual query plan proves a full sort or redundant lookup;
- fuse compatible aggregation passes while retaining independent conservation
  counters;
- replace large intermediate object graphs with typed compact rows or bounded
  iterators;
- avoid structured clones and parent/child JSON round trips for data that can be
  reconstructed from a durable generation-bound intermediate;
- cache deterministic, generation-invariant reference data such as validated
  price/normalization tables once per child.

The calibration-discovery query is another measured-next candidate: it selects
wider rows than its light filter needs and builds an in-memory timestamp/order
structure. Do not rewrite it from intuition. Capture `EXPLAIN QUERY PLAN`, then
test a minimal-column keyset-ordered query against timestamp ties, clock
reversals, range cutoffs, and identical canonical output.

Every optimization needs an exact before/after semantic digest plus focused
tests that perturb ordering, duplicates, corrections, plan switches, unknown
speed, and cancellation.

### 5. Introduce incremental accounting only behind a closed receipt

If full-corpus pass fusion cannot meet the target, design a generation-delta
path. Do not update the final cache in place. A safe shape is:

1. validate the previous cache and its generation/fingerprint;
2. read the unified index's closed delta from that generation to the candidate;
3. apply additive/retractive corrections to a staged intermediate;
4. recompute boundary-sensitive regions affected by ordering, reset, plan, or
   lineage changes;
5. independently reconcile the staged result against source conservation
   counters;
6. atomically publish only after the candidate generation is still current.

The delta receipt must name its parent and child generations, parser/physical
schema, price registry, accounting-cache version, plan-attribution method, and
all algorithm versions that affect output. Any missing receipt, schema drift,
non-append correction, ambiguous ordering, or reconciliation mismatch falls
back to the full path rather than guessing.

Build this in stages: shadow-compute and compare first; then opt into the delta
result for synthetic fixtures; finally qualify it on the fixed private corpus.

### 6. Tune parallelism only after allocation behavior is visible

Sweep supported worker counts on the same workload and record wall time, CPU,
peak RSS, garbage-collection time, and failure/deferral state. Select a bounded
default based on the slowest supported Mac class, not the fastest local result.
Avoid overlapping full-corpus worker phases if their combined resident sets can
cross the accounting ceiling. More workers are not an improvement if they make
the operation less cancellable or trigger memory deferral.

### 7. Make progress truthful and actionable

The explicit deep operation should publish a phase change within two seconds
and periodic aggregate progress while active. A phase may show counts already
available from a closed source descriptor, but must not invent a percentage when
the denominator is unknown. Cancellation should become visible immediately and
settle within the existing bounded watchdog.

The terminal state must distinguish success, retained/deferred evidence,
resource limit, cancellation, and failure. Do not leave the native toolbar
showing accounting after the companion has returned a terminal receipt.

## Acceptance criteria

### Semantic and safety gate

- Exact equality of every deterministic accounting/projection digest between
  baseline and candidate for the fixed corpus.
- Compare a reviewed semantic projection with injected identical clocks. Keep
  execution timings, process IDs, and revision metadata in a separate receipt;
  never strip accounting fields opportunistically to make digests match.
- Exact conservation of admitted events, token components, event-time decimal
  ledger totals, quota occurrences, plan populations, speed-provenance counts,
  warnings, and exclusions.
- Zero unexplained residue, duplicate primaries, cross-plan borrowing, legacy/raw
  fallback, or publication after cancel.
- Identical retry/restart result and no-change/relaunch behavior.
- Existing memory, input-size, SQLite, timeout, and cache-size ceilings pass
  unchanged.

### Performance target for the reference workload

Use these as an initial product target, then report raw values and deltas so the
owner can adjust them from evidence:

- ordinary light refresh: no detailed-accounting child and no unified-index
  scan;
- unchanged explicit detailed refresh: p95 at or below 15 seconds;
- one-small-append detailed refresh: p50 at or below 60 seconds and p95 at or
  below 90 seconds;
- cold full detailed rebuild: at least 2x faster than the approximately
  433-second reference, with a stretch target at or below 180 seconds;
- first truthful progress within 2 seconds and no unexplained progress silence
  longer than 10 seconds;
- no increase in true peak RSS or durable derived-state bytes unless separately
  justified and approved.

If the data shows these targets conflict with correctness or supported-hardware
ceilings, do not weaken the gate. Present the measured bottleneck and the next
architectural choice to the owner.

### Validation ladder

1. focused unit/property tests for each changed fold, query, and cache receipt;
2. replay/correction/plan-switch/cancellation/resource-limit integration tests;
3. owning local companion and browser suites;
4. architecture, documentation, preflight, and changed-source gates;
5. exact baseline-versus-candidate private-corpus comparison;
6. installed native artifact verification with a light refresh, unchanged deep
   refresh, changed-generation deep refresh, cancel/retry, sleep/wake, and
   relaunch;
7. protected R7 regeneration only after source is frozen and explicitly
   authorized by the release coordinator.

R7 is a release-evidence workload, not a profiler. Do not run noisy profiling
concurrently with it, and do not claim that a faster synthetic test proves the
real-history path.

## Required deliverables

- a concise source-backed bottleneck report with phase timings, CPU, peak RSS,
  query plans, allocation findings, and confidence labels;
- the reviewed content-free benchmark schema and comparator;
- small, independently reviewable optimization commits;
- exact semantic before/after receipts for synthetic and private fixed-corpus
  workloads;
- tests for every new cache, delta, fallback, cancellation, and generation-fence
  path;
- an installed-artifact QA receipt and explicit remaining risks;
- updated maintained documentation only where the operational contract changes.

## Ready-to-send agent brief

> Work in an isolated worktree based on the exact merged 0.1.17 refresh-policy
> and mixed-plan-correctness source. First verify the revision and read the root,
> `src`, `apps/local`, `packages/accounting`, `packages/quota-analysis`, `scripts`,
> and `docs` guidance that applies. Do not touch live application state, run R7,
> install an app, publish, or expose private corpus data.
>
> Profile the explicit detailed-accounting refresh end to end. Establish a
> content-free fixed-corpus baseline for cold, unchanged, and one-small-append
> workloads, with per-phase wall time, child CPU, true peak RSS, aggregate counts,
> bytes, generation fingerprints, and exact semantic digests. Identify the
> dominant measured bottleneck before editing. Treat repeated scans,
> materialization, serialization, SQLite query plans, and worker/GC pressure as
> hypotheses until the profile proves them.
>
> Implement the smallest high-confidence optimization first. Preserve strict
> same-generation publication, replay safety, corrections, cancellation,
> resource ceilings, selected-plan separation, Standard fallback, Fast
> sensitivity, unavailable-not-zero behavior, and owner-only privacy. Add call/
> byte-count regression assertions so fast paths are structural, not timing-only.
> If a generation-delta path is necessary, shadow it against the full result and
> fail closed to the full path on any ambiguous receipt or reconciliation
> mismatch.
>
> Validate in the ladder above and hand back exact commits, commands, raw
> content-free performance deltas, semantic comparison results, and unresolved
> risks. Do not merge until CI and the coordinator's final-source gate are clear;
> leave protected R7 and installed-release work to the release coordinator.
