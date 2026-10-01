---
title: Trends cache refusal diagnosis and repair options
date: 2026-09-21
type: research
status: implemented-source
---

# Trends cache refusal diagnosis and repair options

This records an investigation and the selected source repair, not a released
fix. It explains an installed 0.1.23 incident using source inspection and a
private, generation-pinned replay. The installed application, source database,
and observation history are unchanged. Validation of the selected repair is
recorded below; broader UI recommendations remain separate follow-up work.

## Selected implementation

The user selected a **128 MiB complete-cache ceiling and whitespace removal**
on 2026-09-21, superseding the initial 32 MiB recommendation below.

- The complete-cache producer and publication checks measure compact JSON.
- The child emits the same compact encoding and its transport ceiling is also
  128 MiB. The parent checks actual file size before buffering, then verifies
  the envelope byte count and digest before parsing.
- Only the SQLite `accounting_cache` metadata value uses this serializer.
  Shared canonical serialization, source records, checkpoint hashes, schemas,
  calibration values, observations and retention are unchanged.
- The current benchmark verifier admits the new ceiling. Historical PR94
  verification explicitly retains its original 64/16 MiB bounds; historical
  receipts and the benchmark's exact byte-equivalence requirement are unchanged.
- The independent scoped-lane, retained snapshot, and RSS limits are unchanged.
  The earlier UI/diagnostic recommendations are not part of this selected patch.

128 MiB is a hard artifact ceiling, not a preallocation or a target cache size.
Compatibility remains JSON-based and needs no schema bump. Full-size cache
rendering is not implied by the larger storage/transport policy; the independent
UI and snapshot bounds still apply.

Source changes are in the investigation checkout; no installed application or
live database has been replaced. Completed validation:

- 163 focused cache, collector-state, subprocess, stale-serve and retained
  snapshot tests passed. This includes a compact cache above the old 16 MiB
  boundary retaining its small valid Pro comparison despite substantial older
  Plus history, exact 128 MiB transport acceptance, oversized/misreported result
  refusal, old-cache reads, and unchanged canonical record/checkpoint bytes.
- 18 current benchmark and 24 historical PR94 tests passed. The synthetic
  benchmark test required an unsandboxed rerun because macOS `time -l` cannot
  read `kern.clockrate` in the sandbox. No private benchmark input was used by
  those tests and no historical receipt was regenerated.
- All 20 preflight tests, documentation governance, syntax checks, whitespace
  checks and architecture checks passed.
- The three production source-file changes applied cleanly to the extracted
  installed 0.1.23 source. An isolated production-child rebuild of the pinned
  private copy completed in 187.3 seconds, producing a 10,764,834-byte compact
  cache with all 5,328 scoped usage rows and 25,061 quota readings restored.
  The entire scoped lane matches the earlier replay exactly. Every other cache
  field matches the original; the SQLite read-back matches the complete result.
  This elapsed time is an observation, not an uncontended performance comparison.
- The resulting authoritative dashboard snapshot wrote and read successfully
  at 11,557,346 bytes under the unchanged 16 MiB bound. The exact installed web
  assets rendered populated Trends charts from that snapshot in a temporary
  loopback preview. Switching seven-day to thirty-day view worked; the captured
  browser error/warning log was empty. The preview tab and server were closed.

The 128 MiB transport boundary is tested; rendering a genuinely 128 MiB decoded
cache is not qualified by that test. Packaged/installed-app update and native
restart verification remain separate gates.

## Finding and recommendation

The selected-plan Trends data passes its own row and byte limits. Adding it
to the accounting cache exceeds the separate 16 MiB whole-cache ceiling by
**8,154 bytes**. Production then discards the optional Trends lane, preserves
ordinary accounting, and publishes a generic resource-limit reason. The UI
mistakes the missing comparison lane for missing usage.

There is **no 600,000-observation limit**. The earlier investigation counted
603,996 raw canonical Pro weekly observations and incorrectly treated that as
evidence that the scoped-lane limit fired. The calibration input already
collapses repeated readings before constructing the scoped lane. That earlier
root-cause interpretation and proposed observation compaction are superseded
by the replay below.

The initial recommendation was a 32 MiB complete-cache budget, existing lane
formats and values, a useful refusal reason, and ordinary usage display that
survives comparison unavailability. The user instead selected the 128 MiB
budget plus lossless whitespace removal implemented above. Observation
reduction, shortened history and schema migration remain unnecessary; the UI
and diagnostic recommendations below remain follow-up options.

## Evidence boundary

- Installed application: 0.1.23, bundle build 1030, packaged source revision
  `dd4ca80510ddf0834baa55294ce1b2487cd473b7` (`v0.1.23`). The accounting producer,
  companion projection, browser normalizer, and app renderer matched that
  revision byte-for-byte before temporary diagnostic exports were added to an
  extracted private copy.
- Installed ASAR SHA-256:
  `3e058106d41b34fc630efb845a3052e4569dba8dd012309cd493281ba6fbfeba`.
- Investigation checkout: `9385bad260698814cc2a4a6c685575a3fd63811a`.
  `origin/main` inspected at `e89b34dba1fdaa54f56e050d51b062fa76eaf651`
  retained the same relevant limits and comparison dependency. These are
  point-in-time source claims, not a claim about future main.
- Replay: copied SQLite index, existing cache clock
  `2026-09-21T15:46:16.236Z`, source generation 240, exact installed corpus and
  composition functions. Additional exports made internal functions callable;
  the functions and their guards were not changed.
- Private records stayed outside the repository. This document contains only
  aggregate counts, sizes, source identities, and conclusions.

| Measurement | Result | Applicable limit |
|---|---:|---:|
| Selected-plan usage buckets | 5,328 | 100,000 |
| Selected-plan quota observations | 25,061 | 100,000 |
| Comparison intervals | 473 | 100,000 |
| Standalone scoped lane, production serialization | 2,712,519 bytes | 4,194,304 bytes |
| Existing cache with unavailable lane | 13,627,126 bytes | 16,777,216 bytes |
| Same cache with valid reconstructed lane | 16,785,370 bytes | 16,777,216 bytes |
| Excess at the actual failing boundary | 8,154 bytes | — |
| Same complete cache, compact JSON | 10,764,834 bytes | Measurement only |
| Whitespace bytes removable without changing values | 6,020,536 bytes | Measurement only |

The lane's contribution inside the pretty-printed cache is larger than its
standalone size because nesting adds indentation. The whole-cache measurement
includes that difference; adding standalone sizes would miss the actual cliff.

The reconstructed complete cache passes `assertReplaySafeAccountingCache`.
Compact and pretty JSON parse to deeply equal values. The installed companion
projection preserves every usage tuple, quota tuple, and interval. The installed
browser normalizer accepts the projected lane and retains all 5,328 usage rows
and 25,061 quota rows; every quota timestamp, reset timestamp, and percentage
was checked for exact equality.

The scoped replay took 37.7 seconds with approximately 751 MiB observed peak
RSS. This was a partial diagnostic replay, not the complete production child,
end-to-end refresh, or a performance qualification of a larger cache limit.

During investigation, the live app independently refreshed to generation 241
at `2026-09-21T16:21:37.683Z`. Its 13,630,750-byte published cache again contained
an unavailable lane with `plan_scoped_resource_limit`. No live refresh was
triggered by this investigation.

## What the limits protect

| Boundary | Purpose and behavior | Relevance to this incident |
|---|---|---|
| Scoped lane: 100,000 rows per array | Bounds construction and browser decoding; refuses the whole optional lane | Passed |
| Scoped lane: 4 MiB | Bounds its serialized representation; refuses the whole optional lane | Passed |
| Accounting cache: 16 MiB | Bounds the complete durable artifact; drops the optional lane first, rejects the complete cache if still too large | Actual failure |
| Retained dashboard snapshot: 16 MiB | Bounds retained dashboard file reads and writes | Separate gate |
| Accounting child result: 64 MiB | Bounds child result-file transport and parent parsing | Separate gate |
| Legacy accounting-file migration: 64 MiB | Bounds reading an older file format | Not the active cache boundary |

The producer owns the first three boundaries in
[`replay-safe-accounting-cache.js`](../../src/replay-safe-accounting-cache.js).
The browser independently repeats the 100,000-row bound in
[`data-client.js`](../../apps/web/public/data-client.js).
The retained snapshot has its own guard in
[`local-authoritative-dashboard-snapshot.js`](../../src/local-authoritative-dashboard-snapshot.js).
There is no corresponding 4 MiB HTTP response limit on local overview;
the local server's similarly named HTML report-file limit is unrelated.

Finite bounds have a legitimate purpose: the system builds, sorts, serializes,
parses, validates, copies, and renders these objects. Serialized size is not
peak memory. Electron explicitly recommends avoiding long work on the main
and renderer threads. See [Electron performance guidance](https://www.electronjs.org/docs/latest/tutorial/performance).

The exact values are application policy. SQLite's documented string/blob
default limit is much larger; there is no SQLite requirement for a 4 or 16 MiB
cap here. See [SQLite implementation limits](https://www.sqlite.org/limits.html).
Unlimited payloads would remove useful protection, but the reviewed history
does not establish 4 or 16 MiB as uniquely safe numbers.

The 16 MiB cache ceiling dates to commit `26050e3b` on 2026-07-29, before the
current retained-history and comparison design. The scoped limits were added
in `cd428e55` on 2026-09-02 to refuse an optional comparison rather than truncate
history or break ordinary accounting. The
[September 3 qualification receipt](../receipts/2026-09-03-pr94-account-plan-attribution-qualification.md)
already measured a 15,511,261-byte artifact, leaving only 1,265,955 bytes of
headroom. That receipt explicitly did not promise capacity for larger corpora.
This was a foreseeable growth boundary, not evidence of corrupted observations.

## Options and tradeoffs

| Option | Data/format impact | Complexity | Assessment |
|---|---|---|---|
| Raise whole-cache budget | No row, value, schema, export, or projection changes | Smallest | Selected at 128 MiB, combined with compact cache JSON |
| Use compact JSON only for local accounting cache | Every JSON value preserved; serialized bytes change | Small, but more paths than a constant | Good optional optimization; measured cache becomes 10.27 MiB |
| Raise only the scoped 4 MiB or row limit | No semantic change by itself | Small, but multiple validators for rows | Does not repair this incident; can increase later whole-cache pressure |
| Add lossless compression or new tuple/delta encoding | Potentially exact after decoding; storage/wire contract changes | Moderate | Unnecessary here; adds compatibility, corruption, expansion and resource checks |
| Reduce displayed observations | Changes the available presentation evidence | Moderate to high | No current need; requires explicit equivalence and boundary proofs |
| Fetch generation-pinned ranges on demand | Preserves evidence while bounding individual reads | High | Appropriate if profiling shows sustained payload/renderer growth; excessive for this incident |
| Remove all bounds or shorten history | Unbounded resource use or changed history availability | Misleadingly small | Reject; neither addresses the fault with an acceptable contract |

### Lossless whitespace removal

The existing shared `stableJson` recursively sorts and pretty-prints JSON in
[`canonical-json.js`](../../src/export/canonical-json.js). It participates in
exports, comparisons, hashes, and other integrity contracts. **Do not change
that global function to fix the cache.**

A cache-only compact serializer can preserve the logical format. The producer's
size calculations, durable accounting-cache writer, and any relevant transport
measurement must agree on the bytes being limited. Audit the writer's generic
`writeMeta` use in
[`local-collector-state.js`](../../src/local-collector-state.js) so other metadata
does not silently change. Test reads of both pretty and compact existing JSON,
rollback reads, and migration comparisons. No general serializer framework or
new binary format is needed.

Whitespace removal saves storage/serialization bytes; it does not remove the
decoded object graph or guarantee proportional memory or rendering improvement.
The HTTP DTO already uses compact JSON. This option also eventually reaches a
finite cap as history grows. It can stand alone as an immediate byte-budget
repair, but is a larger review surface than raising the existing constant.

### Why further observation reduction is not justified now

The raw index is distinct from calibration inputs and the scoped presentation
lane. The scoped quota array is produced alongside a separate full calibration
array. A narrowly confined display reducer could leave fits unchanged, but it
would still change which timestamped readings the UI can consult.

First/last readings and exact state transitions are more defensible than
arbitrary sampling, but require proofs for grid bracketing, arbitrary Horizon
cursor positions, reset boundaries, freshness, same-timestamp contradictions,
and diagnostics. Keeping every transition is not itself a bound: every reading
could change. The generic quota timeline's existing stratified fallback is
lossy and must not be reused as an exact comparison reducer.

Nothing in this finding calls for changing source observation storage,
calibration formats, weekly fits, model performance, or hosted contributions.
Do not shorten the accounting window or repurpose a UI period as retention.

## Complete repair boundary

1. Change the whole-cache budget in its existing owner. Preserve independent
   row bounds, lane byte limits, memory limits, cancellation and atomic writes.
   Do not blindly raise all similarly named constants. The snapshot and child
   transport boundaries require separate measurements.
2. Preserve bounded diagnostic distinctions between row limit, scoped-lane
   bytes, and complete-cache bytes through companion and browser normalization.
   Optional actual/limit counts must remain allowlisted and content-free.
   Update closed schemas, validators and localization only where affected;
   no raw payload or path belongs in diagnostics. The user-facing explanation
   should say that the allowance comparison is unavailable, not suggest that
   no local usage has been loaded.
3. Let ordinary recorded activity remain visible when comparison is unavailable.
   The current selected-plan selector gates usage on both the scoped lane and
   fitted capacity. A fallback can use the established all-plan usage ledger,
   explicitly labeled as all-plan activity. It must not feed the expected
   allowance line or masquerade as selected-plan usage. Audit the Horizon rate,
   chart bars, labels, legend, summaries and tooltips together. Separating valid
   selected-plan usage from fit availability is another option, but requires
   deeper producer/projection changes and is not needed for this incident.
4. Recover with one normal supported accounting rebuild after the repaired
   version is active. Preserve the prior cache until atomic replacement.
   Ordinary reuse already expires after 30 minutes; no schema bump or database
   migration is required. Do not make every scheduler tick reject a genuinely
   resource-limited cache and trigger a rebuild loop.
5. Measure growth and actual decoded resource cost before a later redesign.
   The chosen budget is headroom, not an unlimited-history guarantee. If limits recur or
   parse/render work becomes material, prefer bounded generation-pinned range
   queries with boundary observations, cancellation, stale-response rejection,
   and restart behavior over silently dropping readings. Date ranges alone do
   not guarantee a row bound.

Budget-only changes retain the cache schema. Current SQLite cache readers
validate the shape without reapplying the producer's 16 MiB gate; an older
version can read the same-shaped larger cache, but can drop the lane again on
its next rebuild. Older snapshot readers enforce their own size ceiling.

The current live DTO fragment sizes plus the reconstructed compact lane and
envelope allowance give a size-only snapshot estimate of 11,593,440 bytes,
below its independent 16 MiB cap. The live generation changed during analysis,
so this is not a persisted same-generation snapshot qualification. No evidence
currently calls for increasing that separate limit.

## Required acceptance evidence before release

- A synthetic complete cache just above the former 16 MiB boundary retains its
  independently valid lane. New-limit overflow still preserves ordinary
  accounting or the prior valid cache according to the existing contract.
- Exact row/value conservation through build, serialization, SQLite round trip,
  companion projection and browser normalization. Use synthetic test fixtures;
  any private-corpus comparison remains private and reports aggregate results.
- Scope, plan, generation, fingerprint, reset cohort, unknown attribution,
  malformed rows and conflicting readings still prevent false comparisons.
- When comparison is refused or a fit is unavailable, valid activity is visible
  with the correct scope and explanation. No all-plan value leaks into a
  selected-plan comparison. Usage/cost totals and other pages are unchanged.
- One rebuild repairs an affected cache without a schema change, deletion,
  polling loop or repeated expensive work. Failed/cancelled publication retains
  the previous cache. Check pretty/compact old-cache compatibility if selecting
  the whitespace option.
- Complete production-child elapsed time and peak RSS; companion response size
  and latency; renderer normalization and interaction latency; actual retained
  snapshot write/read below its own limit. Compare the same corpus and clock.
- Render the repaired Trends view using real-system evidence, then separately
  qualify the packaged/installed artifact and restart behavior. Passing the
  diagnostic validators does not prove a native UI or a release.

The selected cache repair has the source, copied-data, snapshot and browser
evidence recorded above. The broader UI/diagnostic changes are not implemented,
and native installed-artifact and release gates remain open.
