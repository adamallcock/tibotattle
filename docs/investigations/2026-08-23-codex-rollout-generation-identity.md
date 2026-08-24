---
title: Codex multi-rollout thread identity investigation
date: 2026-08-23
type: investigation
status: implemented-local-verified
---

# Codex multi-rollout thread identity

## Outcome

The reported failure is real and reproducible. Its root cause is a storage-contract
mismatch:

- Codex now permits one stable thread ID to own more than one immutable rollout
  file.
- TiboTattle still enforces a one-thread-ID-to-one-rollout-file invariant.
- The second valid rollout therefore triggers
  `Ambiguous duplicate Codex session identity across distinct rollout files`
  before any requested time-window filtering occurs.
- The unified-index failure is then nested inside a refresh result that the
  controller labels `succeeded`. The page sees stale incomplete coverage and
  can immediately start another pass, up to 40 times per page load. The native
  foreground scheduler tries again on its ordinary cadence. This is why the
  incident can look endless even though an individual refresh is bounded.

The screenshot's explanation is therefore substantially right about the two
filenames carrying one `session_meta.id`. The unverified part is the proposed
trigger. Current public Codex source documents the underscore filename as the
result of `thread/revert`, not as a size-triggered split. A long or large thread
may correlate with a revert, or the reporter may have used another Codex build,
but file size alone is not supported as the cause by current public main.

This should be fixed in TiboTattle. Moving one file away, choosing the newest
file, or silently dropping the second file would avoid the exception but would
produce incomplete or incorrect spend accounting.

## Evidence status

| Finding | Status | Evidence |
| --- | --- | --- |
| Two distinct files with one `session_meta.id` abort discovery | Confirmed | Existing focused test plus a canonical `<thread>_<rollout>` synthetic reproduction |
| The duplicate check precedes date-window selection | Confirmed | `src/providers/codex/log-sources.js:400-413` |
| Current Codex deliberately creates `<thread>_<rollout>` files | Confirmed | Current Codex filename and recorder source |
| `session_meta.id` remains the stable thread ID | Confirmed | Current Codex recorder source |
| Current public trigger is `thread/revert` | Confirmed | Current Codex source and durable-revert history |
| The reporter's file was created by size or compaction rotation | Unconfirmed | The screenshot has no `cli_version`, metadata, or file receipt; current public main does not implement that path |
| One failed index pass can be presented as overall refresh success | Confirmed | Runtime stub and `src/local-companion-refresh.js` control flow |
| The apparent endless behavior is repeated bounded work | Confirmed | 40 browser continuations plus recurring native cadence; each controller run itself has a timeout |
| The exact reporter corpus is recovered | Not yet | The sanitized pair requested in the reply has not been supplied |

## What current Codex writes

The source snapshot used for this investigation is OpenAI Codex commit
[`2161ec272a7d6b775c9c721e6206f4fe63e383f2`](https://github.com/openai/codex/commit/2161ec272a7d6b775c9c721e6206f4fe63e383f2),
current on 2026-08-23.

### Thread identity and rollout identity are now different concepts

Codex's canonical filename parser says that an ordinary file has one identifier,
while a reverted thread appends a distinct rollout identifier after an underscore.
It parses and renders these forms:

```text
rollout-<timestamp>-<thread-id>.jsonl
rollout-<timestamp>-<thread-id>_<rollout-id>.jsonl
```

The first identifier is the stable logical thread. The second, when present, is
the immutable physical rollout. See
[`rollout_file_name.rs`](https://github.com/openai/codex/blob/2161ec272a7d6b775c9c721e6206f4fe63e383f2/codex-rs/rollout/src/rollout_file_name.rs#L10-L74).

The recorder keeps `SessionMeta.id` equal to `conversation_id` while allowing a
separate `rollout_id_override` in the filename. It also writes `history_mode`
and `history_base` into the metadata. See
[`recorder.rs` parameters](https://github.com/openai/codex/blob/2161ec272a7d6b775c9c721e6206f4fe63e383f2/codex-rs/rollout/src/recorder.rs#L94-L115),
[`SessionMeta` construction](https://github.com/openai/codex/blob/2161ec272a7d6b775c9c721e6206f4fe63e383f2/codex-rs/rollout/src/recorder.rs#L845-L897),
and
[`precompute_new_rollout_path`](https://github.com/openai/codex/blob/2161ec272a7d6b775c9c721e6206f4fe63e383f2/codex-rs/rollout/src/recorder.rs#L1607-L1628).

This is not an accidental duplicate. It is a stable-thread/multiple-generation
contract.

### Why Codex keeps both files

For a paginated thread revert, Codex leaves the old immutable rollout intact,
creates a new rollout ID, retains a bounded reference to the history prefix, and
changes the selected rollout path. See
[`revert_thread.rs`](https://github.com/openai/codex/blob/2161ec272a7d6b775c9c721e6206f4fe63e383f2/codex-rs/thread-store/src/local/revert_thread.rs#L1-L155).

Codex cannot derive the selected file from the thread ID after this operation.
Its resolver checks the live writer, then SQLite's selected rollout path, then a
restricted filesystem fallback. For a paginated reverted thread, SQLite is
authoritative because an older immutable file may still exist. See
[`thread_rollout_resolver.rs`](https://github.com/openai/codex/blob/2161ec272a7d6b775c9c721e6206f4fe63e383f2/codex-rs/thread-store/src/local/thread_rollout_resolver.rs#L1-L108).

Paginated history is a chain of rollout ranges, not a chain keyed only by logical
thread IDs. Codex resolves `history_base` by rollout ID, detects missing sources
and cycles, and applies ordinal/byte cutoffs. See
[`rollout_lineage.rs`](https://github.com/openai/codex/blob/2161ec272a7d6b775c9c721e6206f4fe63e383f2/codex-rs/thread-store/src/local/rollout_lineage.rs#L14-L157).
The `thread_id` field inside `HistoryPosition` is historically named but denotes
the referenced rollout and need not equal `SessionMeta.id`; see
[`protocol.rs`](https://github.com/openai/codex/blob/2161ec272a7d6b775c9c721e6206f4fe63e383f2/codex-rs/protocol/src/protocol.rs#L2862-L2875).

There is an additional accounting subtlety. When Codex reconstructs a resumed or
referenced-fork history, it seeds its in-memory token state from the final
`TokenCount` in that reconstructed history before appending later provider usage.
See
[`session/mod.rs` history restoration](https://github.com/openai/codex/blob/2161ec272a7d6b775c9c721e6206f4fe63e383f2/codex-rs/core/src/session/mod.rs#L1315-L1417),
[`last_token_info_from_rollout`](https://github.com/openai/codex/blob/2161ec272a7d6b775c9c721e6206f4fe63e383f2/codex-rs/core/src/session/mod.rs#L1558-L1563),
and
[`record_token_usage_info`](https://github.com/openai/codex/blob/2161ec272a7d6b775c9c721e6206f4fe63e383f2/codex-rs/core/src/session/mod.rs#L3945-L3975).
Consequently, a replacement file can contain only new physical event rows while
its first cumulative `total_token_usage` already includes the retained base. A
consumer must seed its previous-total baseline at the exact `history_base`
cutoff; “the file contains only a delta” does not mean its counters restart at
zero.

### Contract-change timeline

TiboTattle's duplicate-session guard landed on 2026-07-31 in
[`00c7e70be`](https://github.com/adamallcock/tibotattle/commit/00c7e70be6b589a01d3070b52fd4afb262680805).
At that time it was a reasonable fail-closed defense against copied files: two
independent files claiming one identity otherwise risked double counting.

Codex then changed the contract in three public commits:

1. 2026-08-12:
   [`4ef836f883`](https://github.com/openai/codex/commit/4ef836f883c38ba6d39e6920f335ce6452b7de33)
   distinguished rollout IDs from thread IDs.
2. 2026-08-12:
   [`8d4d57387a`](https://github.com/openai/codex/commit/8d4d57387a90635d1033eeae70105465ae9f96d0)
   resolved paginated history by rollout ID.
3. 2026-08-13:
   [`b1373b74a2`](https://github.com/openai/codex/commit/b1373b74a27d1d9b65074a873202683355cae772)
   added durable paginated-thread reverts.

That ordering explains why TiboTattle's integrity guard became incompatible
without either project necessarily having had a bug when the guard was written.

### Why “Codex split a large file” is not yet established

A historical Codex commit named
[`Rotate rollout segments after compaction`](https://github.com/openai/codex/commit/36cae7deae7d9bd610d6561db5db71b7b0c66892)
exists, but it is not an ancestor of current public main. In the fetched source
it is contained only by two feature branches. Current main's underscore format
is explicitly tied to revert. The supplied screenshot alone therefore cannot
distinguish among:

- a current paginated `thread/revert`;
- an internal, feature-branch, or short-lived Codex build;
- an older format that is no longer on public main;
- a genuinely copied or renamed file.

The TiboTattle fix should recognize the current documented contract and still
fail safely for unexplained duplicates. It should not assume every underscore
file is valid merely because its name has the expected shape.

## Where TiboTattle breaks

The line references in this section describe the pre-fix checkout at
[`4cb5c48955c2a49861927ef51d6738eab0ef7763`](https://github.com/adamallcock/tibotattle/commit/4cb5c48955c2a49861927ef51d6738eab0ef7763).
The implementation described at the end of this record replaces those paths.

### 1. Discovery collapses two identities into one

`readRolloutLineage` in `src/providers/codex/log-sources.js:299-335` reads only:

- `session_meta.id` or `session_id`;
- `forked_from_id` or `parent_thread_id`;
- surface classification.

It does not parse the canonical filename into `threadId` and `rolloutId`, and it
does not retain `history_mode` or `history_base`.

`discoverCodexRolloutInfos` then constructs a single `bySessionId` map. At
`src/providers/codex/log-sources.js:400-408`, any second physical file with the
same stable thread ID throws the generic error reported in the screenshot.

This check happens before the requested date filter at lines 410-413. A synthetic
case with two old duplicate files and one unrelated recent file still fails the
recent scan. One out-of-window thread can therefore block all in-window work.

Active/archive de-duplication at lines 388-390 is narrower and correct for a
move: the same basename is represented once, with the active copy winning. It
does not solve multiple immutable rollout IDs for one thread because those have
different basenames by design.

### 2. Removing the exception would still be wrong

The one-to-one assumption continues downstream. In
`src/local-unified-index-ingest.js:511-530`, both source lookup and carried state
are keyed only by session ID. Allowing multiple inputs without redesigning this
map would overwrite one generation with another and could seed the wrong state.

There is also a latent identity collision in
`src/local-unified-index-build.js:242-253` and `:362-378`. A usage event key is
derived from:

```text
(stable session-local ID, source byte offset, observed timestamp)
```

It omits the physical source/rollout ID even though `usage_event.event_key` is a
primary key. Two rollout generations for one stable thread can therefore collide
if an event has the same offset and timestamp. Tool facts already include
`sourceLocal`, which is the safer model.

Finally, `src/local-unified-index-extract.js:289-310` documents and implements
the older inline-fork contract: a child file begins by replaying its parent's
records, so inherited snapshots suppress already-counted usage. A paginated
`history_base` instead references a prior rollout range and the new file holds a
physical event delta whose cumulative counter may already include the retained
base. Treating a reference-backed child or replacement as an inline replay can
discard real new spend; starting its counter at zero can count the retained base
again.

### 3. The failure is swallowed into an apparent success

At `src/local-companion-refresh.js:1103-1128`, the unified-index exception is
caught. Because the duplicate error has no allowlisted `code`, the public result
becomes:

```json
{
  "status": "failed",
  "errorCode": "local_unified_index_refresh_failed"
}
```

Accounting becomes unavailable, but the runner resolves. At
`src/local-companion-refresh.js:1942-1956`, any resolved runner is normalized to
top-level `status: "succeeded"`, `errorCode: null`. A runtime stub reproduced
exactly this combination: failed unified index and unavailable accounting inside
an overall successful controller state.

### 4. Stale coverage re-arms work with no progress

After an apparent success, the page reloads the retained dashboard and calls
`scheduleReindexAutoContinuation`. If retained coverage still says, for example,
`730 / 731`, `historyIndexIncomplete()` remains true. The page then starts a new
refresh after 1.5 seconds, up to 40 times (`apps/web/public/app.js:224-233` and
`:10082-10118`). There is no generation/progress comparison, so identical failed
passes consume the whole retry budget.

The macOS foreground scheduler defaults to five minutes and schedules another
refresh while the app remains open (`apps/macos/UsageMonitorApp.swift:296-307`
and `:4592-4603`). This can continue indefinitely across bounded individual
runs. The accurate description is therefore:

- not one unbounded Promise;
- a bounded but aggressive browser loop;
- followed by recurring native attempts against an unchanged fatal input;
- with a success label that conceals the terminal index condition.

If the input is large, repeatedly rescanning it amplifies the elapsed time and
I/O cost, but large size is not required to trigger the loop.

## Reproduction receipts

### Existing regression test

The repository already contains a deliberate fail-closed test at
`test/metadata-exporter.test.js:248-273`. Re-run on 2026-08-23:

```text
node --test --test-concurrency=1 \
  --test-name-pattern='distinct rollout files claiming one session identity' \
  test/metadata-exporter.test.js

tests 1; pass 1; fail 0
```

This proves the screenshot's error is current intended behavior under the old
invariant, rather than a guessed failure message.

### Canonical current-format fixture

A privacy-safe synthetic fixture used valid UUID-shaped identities and two
canonical basenames:

```text
rollout-<timestamp>-<thread>.jsonl
rollout-<timestamp>-<thread>_<rollout>.jsonl
```

Both metadata records carried `id: <thread>`; the second used paginated history
metadata. Discovery threw the exact generic error and exposed no machine code.
Moving the two files outside the requested time window while adding an unrelated
recent file produced the same error, confirming the ordering defect.

### Current local-corpus census

A content-free scan of only filenames and the first `session_meta` record under
the current Codex home found:

| Measure | Count |
| --- | ---: |
| JSONL rollout files | 5,491 |
| Compressed `.jsonl.zst` files | 0 |
| Parseable `session_meta` records | 5,491 |
| Missing `history_mode` | 1,469 |
| Legacy mode | 3,975 |
| Paginated mode | 47 |
| `history_base` present | 0 |
| Canonical underscore filenames | 0 |
| Duplicate stable-thread groups | 0 |

The local `state_5.sqlite` had 5,430 thread rows, including 47 paginated rows;
every selected rollout path existed and none used the underscore form. This
confirms that the new mode is present locally but the exact incident condition
is not currently in this machine's corpus. It is not evidence about prevalence
on other installations.

No raw paths, IDs, prompts, responses, or event content were retained in this
census.

## Correct accounting semantics

TiboTattle measures actual token spend, not merely the history currently visible
at the head of a Codex thread. That distinction controls the fix.

Suppose a rollout contains turns A, B, C, and C is reverted. Codex can retain the
old immutable rollout, create a new rollout that references the retained A/B
prefix, and append D. The new file need not copy the A/B event rows, but its
first cumulative total can start from the A/B boundary. The actual billed work
is A + B + C + D. Selecting only the current visible head would tend toward
A + B + D and erase the real spend on C. Conversely, treating the new file's
first cumulative total as zero-based would charge A + B again before D.

The index therefore needs two separate graphs:

1. **Logical graph:** stable thread ID plus `forked_from_id` /
   `parent_thread_id`. This answers thread ownership and logical ancestry.
2. **Physical history graph:** immutable rollout ID plus `history_base` rollout
   ID and cutoffs. This answers which stored range a source references.

All valid physical rollout deltas should remain spend sources. Codex's SQLite
selected path is useful for validating the current head and resolving ambiguous
paginated history, but it must not be used to erase superseded physical spend.

## Recommended fix

### P0: stop the non-progress loop and contain one bad thread

This can ship before the full identity migration.

1. Give discovery/lineage failures fixed, allowlisted codes such as
   `codex_rollout_generation_ambiguous` and
   `codex_rollout_lineage_invalid`. Keep paths and IDs out of public results.
2. Do not label a refresh with an unusable unified index as an unqualified
   success. Preserve successful quota/headline evidence, but expose a terminal
   `degraded` result, or a failed `unified_index` step if the protocol cannot add
   a degraded state.
3. Make browser continuation contingent on both a successful index result and
   monotonic progress: generation/fingerprint changed, indexed-source count
   advanced, bytes advanced, or a cursor receipt advanced. Stop on the first
   identical terminal result; do not re-arm until the source corpus changes or
   the user explicitly retries.
4. Apply the same retry suppression/backoff to the native cadence. A known
   unchanged source-integrity failure should not be retried every five minutes.
5. Quarantine only the invalid logical thread/source group and continue indexing
   unrelated sources into an explicitly partial generation. Surface fixed
   `skippedThreadCount`, `skippedSourceCount`, and reason counts. Never call this
   generation complete.
6. Until partial publication is implemented safely, retain the last complete
   published generation and terminate honestly rather than repeatedly rebuilding
   it or publishing zero.

P0 prevents a single source from monopolizing refresh without making a risky
choice about which ambiguous file contains truth.

### P1: model stable threads and immutable rollouts separately

1. Parse canonical Codex basenames into `threadId` and `rolloutId`, including
   compressed siblings. Validate that filename `threadId` agrees with
   `session_meta.id`.
2. Read and retain `history_mode`, `history_base`, `forked_from_id`, and
   `parent_thread_id` from the first metadata record.
3. Replace one-to-one `bySessionId` maps with:
   - `byRolloutId: rolloutId -> one physical source`;
   - `byThreadId: threadId -> ordered physical generations[]`;
   - distinct logical-fork and physical-history edges.
4. Classify source groups explicitly:
   - same basename in active/archive: one moved representation;
   - same thread, distinct canonical rollout IDs with consistent metadata:
     valid generations;
   - same rollout ID and same content digest: duplicate representation, retain
     one deterministic physical source;
   - same rollout ID with divergent content, or unexplained noncanonical files:
     integrity failure, quarantine that thread only.
5. Keep one `sessionLocal` for stable-thread aggregation, but derive and retain a
   stable `sourceLocal` from the immutable rollout ID. Include `sourceLocal` or
   `rolloutId` in usage event keys and boundary keys.
6. Distinguish extraction modes:
   - legacy inline fork: retain snapshot-based replay suppression;
   - paginated reference-backed fork/revert: process only local physical event
     rows and do not suppress them as inline replay;
   - resolve the exact `history_base` cutoff to seed carried model, effort, tier,
     snapshots, and cumulative token totals;
   - subtract that boundary total from the first compatible local cumulative
     total so the referenced prefix is not charged twice; if the counter
     regresses or resets, re-anchor locally with an explicit diagnostic rather
     than manufacturing a negative delta.
7. Read `state_5.sqlite` in read-only mode when available to validate the selected
   head and paginated lineage. Fall back to the canonical metadata graph. If the
   fallback has cycles, missing bases, conflicting rollout IDs, or multiple
   unexplained heads, quarantine that logical thread instead of guessing.
8. Bump the parser/index identity version and perform a cold, transactional
   rebuild. The event-key change means old and new identities must not coexist in
   one supposedly complete generation.

The proposed minimum internal shape is:

| Field | Meaning | Cardinality |
| --- | --- | --- |
| `threadId` / `sessionLocal` | Stable logical Codex thread | One per logical thread |
| `rolloutId` / `sourceLocal` | Immutable physical rollout | One per source generation |
| `forkedFromThreadId` | Logical parent thread | Optional |
| `historyBaseRolloutId` | Referenced physical source | Optional |
| `historyEndOrdinalExclusive` | Referenced item boundary | Optional |
| `historyEndByteOffsetExclusive` | Referenced byte boundary | Optional |
| `historyMode` | Legacy inline or paginated reference | One per rollout |
| `selectedHead` | Current Codex UI head, from live/SQLite evidence | At most one per thread; not an accounting exclusion rule |

### P2: truthful partial coverage and diagnostics

1. Publish partial/gapped totals with skipped-source counts and fixed reason
   codes. Do not render the missing portion as zero or silently imply complete
   coverage.
2. Keep detailed basename/hash diagnostics local and owner-directed. Remote
   telemetry should contain only allowlisted code/count data.
3. Add a local diagnostic receipt that can identify the exact invalid group
   without including IDs, paths, prompts, responses, or raw rollout lines.
4. Teach the UI the difference among advancing, partial-terminal, and
   retryable-transient states. Only an advancing state should auto-continue.

## Acceptance matrix

The implementation should not be considered complete until these paths pass:

| Scenario | Required result |
| --- | --- |
| Ordinary one-file thread | Existing totals and incremental cursor behavior unchanged |
| Valid `<thread>_<rollout>` replacement | Both physical deltas indexed once under one logical thread |
| Revert with removed old suffix and new branch | Actual spend includes old removed work and new work once; referenced retained prefix is not charged twice |
| First replacement counter includes retained base | Boundary total is subtracted and only post-revert increments are charged |
| First replacement counter restarts below retained base | Counter is re-anchored once with an explicit regression receipt; no negative or missing spend |
| Two and three successive generations | Deterministic lineage and stable rebuild result |
| Two rollouts with identical timestamp and byte offset | Two distinct usage event keys |
| Paginated `history_base` chain | Exact rollout IDs and ordinal/byte bounds honored |
| Missing base, cycle, or out-of-bounds cutoff | Only affected logical thread quarantined; partial coverage explicit |
| Legacy inline fork | Existing replay suppression remains correct |
| Paginated fork | Delta is not mistaken for inline replay |
| Active/archive same basename | Counted once after move |
| Exact copied duplicate | Deterministic duplicate handling without double count |
| Divergent files claiming one rollout ID | Thread quarantined; unrelated sources continue |
| Old ambiguous group outside requested window | Does not block unrelated recent scan |
| SQLite head present, stale, or missing | Validated head when present; safe metadata fallback otherwise |
| New generation added incrementally | New facts appended/rebuilt without retaining stale incompatible facts |
| Restart during rebuild | Last complete generation retained or new generation published atomically |
| Inner index failure | Top-level terminal/degraded state; no browser 40-pass loop |
| Unchanged native retry | Backoff/suppression prevents indefinite five-minute rescans |
| Partial UI | Gap and skipped counts shown; never complete or zero-by-default |
| `.jsonl.zst` source | Either supported equivalently or rejected once with an explicit bounded code |

Validation should include focused source-discovery/index tests, full unified-index
and accounting suites, restart/replay-safe tests, and rendered browser/native QA.
The parser/index version bump should also be tested against an existing pre-fix
database to prove that migration cannot mix old event keys with new ones.

## Evidence needed from the reporter

The fix does not depend on obtaining private content, but the exact trigger does.
A sufficient sanitized receipt for both files would contain only:

- basename shape with IDs consistently replaced by `THREAD`, `ROLLOUT_A`, and
  `ROLLOUT_B`;
- byte size and modification time;
- whether locally computed whole-file SHA-256 values are equal; the hashes
  themselves need not be shared;
- `session_meta` keys and non-sensitive values: `cli_version`, `history_mode`,
  presence/shape of `history_base`, and whether parent/fork fields are present;
- whether `history_base.thread_id` resolves to `ROLLOUT_A`, plus its ordinal and
  byte-cutoff shape after numeric values are bucketed or withheld;
- whether the first replacement cumulative token total is reset, unchanged, or
  greater than the final total at the referenced cutoff, without sharing the
  totals themselves;
- counts of record types and elapsed duration, with all absolute timestamps,
  payload text, paths, IDs, commands, prompts, responses, and tool arguments
  removed.

If the `cli_version` predates or differs from the public durable-revert commits,
the matching Codex tag/commit should be inspected before attributing the file to
revert. The raw rollout files should remain private unless the owner explicitly
chooses otherwise.

## Decision

Implement, in this order:

1. P0 termination, typed failure, no-progress fencing, and per-thread quarantine.
2. P1 rollout-aware identity and event-key migration with a cold rebuild.
3. P2 truthful partial UX and privacy-safe diagnostics.

Do not implement a “newest file wins,” “drop the underscore file,” or global
skip-on-error shortcut. Those approaches hide the loop but violate actual-spend
and coverage guarantees.

## Implementation outcome

All three recommendation groups are implemented in the local task branch:

- discovery now distinguishes stable thread IDs from immutable rollout IDs,
  retains logical and physical lineage separately, validates canonical names,
  consults owner-controlled SQLite state read-only, and quarantines only the
  affected thread with fixed content-free reason codes. Quarantine also
  propagates through physical-history dependencies, so a valid-looking child
  cannot escape containment when its referenced base is invalid;
- the unified index uses rollout-local source/event identities, parser schema
  version 10, exact paginated-history boundary seeding, local counter re-anchoring,
  transactional cold rebuilds for incompatible identities, and incremental
  ingestion of second and later generations. The carried replay snapshot set is
  replaced by the exact referenced prefix, including in the rebuild worker, so
  snapshots from a reverted suffix cannot suppress coincidentally equal new
  work on a later branch;
- accounting publishes verified partial totals with explicit skipped coverage,
  while refresh, web, and native surfaces use a terminal `degraded` state and
  suppress automatic retries for an unchanged integrity receipt. The browser
  boundary validates the terminal receipt before admitting it; the normal
  return-visit refresh is suppressed for that state as well as the 40-pass
  continuation, while the explicit update button remains available.

SQLite selected-head evidence wins only when it names a unique physical leaf.
A stale, missing, or unreadable selection falls back to a unique metadata leaf;
multiple unresolved leaves quarantine the affected thread instead of selecting
the newest file. Prefix-cutoff I/O is limited to requested-window sources and
their logical or physical dependencies, so unrelated old history is not reread.

The synthetic acceptance suite covers canonical replacements, exact and
divergent duplicates, active/archive moves, old out-of-window ambiguity,
two- and three-generation chains, exact ordinal/byte cutoffs, removed old work
plus new branch spend, counter resets, event-key collisions, restart/migration,
partial accounting, unchanged no-progress passes, browser continuation, and
native retry suppression. Unsupported `.jsonl.zst` inputs are rejected once
with `codex_rollout_compression_unsupported` and explicit partial coverage; they
are not silently skipped.

### Post-implementation red-team outcome

A second adversarial pass treated every rollout path as untrusted local input
and every partial publication as a potential non-termination trigger. It found
and closed the following additional high- or medium-severity seams:

- immutable rollout identity is now globally unique across logical threads;
  two threads cannot silently derive the same cursor and fact keys;
- active and archived representations with the same basename are retained until
  byte comparison. Only byte-identical copies collapse; divergent copies
  quarantine the affected thread;
- failed active/archive attestations use distinct path-HMAC representation keys,
  while successful facts continue to use the immutable rollout identity. No raw
  path is persisted;
- malformed token counters, rate-limit payloads, speed settings, unfinished
  tails, and unsalvageable oversized accounting records roll back that source's
  staged facts and publish one terminal content-free quarantine cursor;
- runtime-damaged parents and discovery-damaged parents quarantine every
  dependent physical-history or inline-fork descendant. This includes a
  canonical filename whose metadata claims a different parent identity; the
  claimed identity remains a dependency alias and cannot be mistaken for an
  absent legacy parent;
- changing a damaged source retries only its lineage component. If it is still
  damaged, the component returns to the same terminal partial state; if repaired,
  that component heals without rebuilding unrelated multi-gigabyte history;
- a changed discovery quarantine similarly removes stale facts and heals
  incrementally instead of forcing a full cold rebuild;
- terminal tool-provenance gaps are recognized as stable terminal partials, so
  an unchanged oversized tool record or rotated pre-tool source does zero work
  on the next pass;
- invalid-lineage propagation and incremental ancestry planning use iterative
  adjacency queues rather than recursive or repeated fixed-point scans. Deep
  128-level quarantine and 96-level incremental fork regressions terminate
  deterministically;
- caller-owned FileHandles are read positionally and remain open for final
  snapshot verification. Only an unterminated chunk tail is copied across a
  scratch-buffer refill, preserving exact records without copying every byte;
- a simultaneous parser failure can no longer mask a failed post-read source
  attestation. The retryable source-change verdict wins, preventing a writer
  race from being persisted as terminal content damage;
- the provider/export scanner now uses physical rollout occurrence scope,
  exact paginated counter/model/tier seeds, and demand-driven history
  snapshots. Ordinary large continuations retain constant-size carried state;
  exact snapshot keys are collected only when a later inline fork needs them;
- the resumable export scanner now persists counter re-anchor state across
  batches and rejects duplicate session metadata. Its checkpoint format still
  cannot prove ordinal-aware paginated snapshot cutoffs, so that lane stops
  once with `codex_rollout_checkpoint_history_unsupported` instead of silently
  double-counting; the local index and direct bounded scanner retain full
  paginated-history support;
- the public-client allow-list, parser-v10 diagnostic expectations, retirement
  parity fixture, transition duplicate fixture, and R7 materialized-boundary
  fixtures were updated to exercise the hardened contract rather than assert
  the superseded active-file-wins or empty-rollout behavior.

No open high- or medium-severity rollout finding remains in this review. The
remaining accepted low-risk limitation is deliberate: a same-user process that
rewrites an already-open prefix in place and appends bytes before final
verification can evade the append-only snapshot proof. Codex's recorder is an
append-only trusted local writer, and hashing every large frozen prefix twice
would roughly double normal index I/O without providing authenticity against a
same-user adversary who can also alter the source before discovery. Same-size
rewrites, replacement, truncation, link changes, incomplete tails, and ordinary
mid-pass mutations are detected. If Codex ever adopts in-place rewriting, this
assumption must be revisited.

Post-red-team local validation receipts:

| Validation | Result |
| --- | --- |
| Affected discovery, provider, index, accounting, refresh, export, transition, R7 harness, retirement, and web-boundary suite | 623 passed, 0 failed |
| Shipped web UI suite | 328 passed, 0 failed |
| macOS localization source lane | 6 passed, 0 failed |
| macOS app source-contract lane | 46 passed, 0 failed, 3 artifact-only tests intentionally excluded |
| Real loopback companion plus isolated R7 materialized-boundary benchmark | 51 passed, 0 failed; includes degraded rollout coverage and real socket/process-sampling paths |
| Rendered in-app-browser QA against a real synthetic corpus/index/cache/server | Fresh load made 0 refresh calls; one explicit update made exactly 1 call; no follow-up call appeared; terminal badge, gap copy, verified totals, and singular/plural copy rendered; browser console had 0 warnings/errors |
| Static gates | telemetry mirrors/contracts, browser i18n mirror, architecture boundaries, tool inventory, documentation links, and `git diff --check` passed |

The monolithic release gate is not claimed green. Its post-change run exposed
the integration fixtures fixed above, then continued into environment- and
release-only lanes that cannot be made meaningful in this isolated mirror:
sandboxed loopback and Unix-socket creation were denied, the mirror deliberately
had no Git metadata, prepared/signed macOS artifacts were absent, and retained
R7 release receipts correctly became stale after the source graph changed.
Focused loopback and R7 materialized-boundary validation was rerun outside the
sandbox and passed. A prior isolated macOS smoke rerun reached its dependency-
provenance guard and stopped before building; the guard was not weakened. R7
release provenance was not regenerated because that is a separate release
authorization, not part of this local bug fix.

No issue, pull request, release, installed app, or external system was changed by
this implementation.
