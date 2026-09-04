---
title: Unified Local Index Schema
date: 2026-08-27
type: reference
status: maintained
last_verified_commit: 52399658
---

# Unified local index schema

The unified local index is TiboTattle's canonical replay-safe projection of
Codex usage, quota, tool, lineage, source, and generation provenance. It is a
content-free SQLite database: its schema deliberately has no column for prompt,
response, reasoning, command, repository, filename, or arbitrary free text.

The installed macOS path is
`~/Library/Application Support/Usage Monitor/local-unified-index-v1.sqlite`.
The `v1` filename is a stable machine identifier and is **not** the current
SQLite schema version.

## Version identifiers

Four identifiers answer different questions and must not be substituted for
one another:

| Identifier | Current value | Meaning |
| --- | --- | --- |
| Stable filename | `local-unified-index-v1.sqlite` | Machine path continuity across app releases. |
| Schema-family metadata | `local-unified-index-v2` | Logical family stored in `meta.schema_version`. |
| SQLite `PRAGMA user_version` | `11` | Physical table/index/migration generation. |
| Parser version | `unified-rollout-typed-v13` | Meaning and provenance of facts extracted from rollout sources, including ordinal-bearing compaction headers. |
| Source identity version | `codex-immutable-rollout-v1` | Rules for physical rollout identity/generation. |

The application id is a separate SQLite format guard. A file with the wrong
application id, family, or non-migratable `user_version` fails with
`local_unified_index_schema_invalid`; the reader must not relabel it to force an
open.

## Physical version history

| `user_version` | Added meaning | Compatibility behavior |
| ---: | --- | --- |
| 1 | Initial typed usage/quota dimensions and facts. | Legacy family; readable as partial evidence by compatible readers. |
| 2 | Incremental source cursors and lineage snapshots. | Additive migration; still-present sources can be rescanned. |
| 3 | Provider-issued session identity beside irreversible local join keys. | Additive; needed because a local HMAC cannot reconstruct an authorized raw transport identity. |
| 4 | Content-free turn/compaction boundaries and relations. | Parser rescan distinguishes a real absence from old unobserved state. |
| 5 | Exact content-free source order for timestamp ties. | Still-present sources are rescanned. |
| 6 | Interned source dimension plus compact source id/offset/ordinal on usage facts. | Additive columns; older rows without order are withheld from adjacency analysis. |
| 7 | Staged generation-bound usage/quota provenance and source attestation. | Incomplete legacy provenance triggers staged rebuild before becoming authoritative. |
| 8 | Source-scoped, generation-bound tool facts and wider closed diagnostic vocabulary. | Still-present sources rescan so current-looking empty tool projections are impossible. |
| 9 | Stable thread identity separated from immutable rollout identity; rollout-scoped keys and paginated history-base boundaries. | Primary-key semantics changed, so ingest performs a cold staged rebuild rather than mixing v8/v9 facts. |
| 10 | One opened physical source snapshot per scan; source dev/inode/time identity and quarantine of malformed accounting or unfinished tails. | Changed damaged sources retry from byte zero; unchanged quarantined sources terminate cheaply. |
| 11 | Required source- and quota-keyed usage indexes. | Schema 10 migrates additively on a staged copy; the indexes bound late source quarantine and orphan quota cleanup. |

The format layer can migrate physical versions 1 through 10 forward to 11.
Normal ingestion cold-rebuilds versions through 9 because their fact or source
identity semantics differ; schema 10 can take the additive staged migration.
A newer version is not safe for an older reader. Migrations are transactional
and forward-only; there is no supported in-place downgrade.

Account/plan attribution does not require a new physical schema or relabeling
an existing database. Current writable v11 opens also ensure compatible read
indexes for exact source/offset/time quota lookup and same-session counter
predecessors. Read-only v11 inspection never adds indexes or mutates the file.
These indexes change query cost, not retained fact meanings or parser identity.

Parser v11 is independent of the physical v11 index layout. It withholds an
invalid provider quota window at record level while retaining unrelated valid
usage, tool, and quota facts from that source. It also treats a selected
paginated replacement with no `history_base` as a segment-start lineage reset,
so descendants do not inherit snapshots from the replaced physical branch.

Parser v13 recognizes the current `timestamp, ordinal, type` compaction header
alongside both legacy header orders. It validates the bounded unsigned ordinal
without decoding replacement history. The version change reparses present
sources so earlier missed compaction boundaries can be recovered safely.

Parser v12 additionally preserves omitted or null usage counters as SQL NULL,
including the cumulative cursor carried across refreshes. Explicit zero remains
observed zero. A derived component requires all its input counters and consistent
totals; an incomplete cache vector cannot manufacture a measured cache miss.
This is an interpretation change, not a physical schema migration. The parser
stamp forces still-present older sources to rescan; rotated rows retain their
recorded parser provenance and are not silently relabeled as complete evidence.

### Codex response usage and effective effort boundaries

The supported offline accounting source remains legacy `event_msg.token_count`.
Codex [#41912](https://github.com/openai/codex/pull/41912) still emits that stream
and also persists top-level `token_usage_record` containing overlapping response,
turn and thread totals. Its `compacted.latest_token_usage_record` is a checkpoint
copy, not fresh consumption. Unified, provider, passive and export-checkpoint
readers deliberately do not add these records. A response-record-only source has
no supported measured usage, not an observed zero-token request. Adopting those
records requires a separate response identity, replay and overlap reconciliation
contract; this release does not claim record-only accounting support.

The index's `reasoning_effort` remains the observed turn/request setting. The
upstream [#42328](https://github.com/openai/codex/pull/42328) marker
`metadata.harness_authored_configuration` proves that a durable
`configuration_update` was authored by the harness; it is not a backend
acknowledgement that the update applied. Such controls, including custom/unknown
efforts, do not overwrite the observed setting or create an inferred effective
effort. No effective-effort carry is inferred across compaction, fork or resume.
Actual application/eligible-mode and installed-client evidence remains a
qualification gate, separate from catalogue recognition.

The foreground companion treats verified published v10/v11/v12-to-v13 parser
upgrades as cold work even when the physical schema is already 11. The target
and predecessor set are deliberately closed; current, unknown, malformed and
future parser evidence cannot obtain a longer deadline. That run receives the
same bounded four-hour deadline as an absent or supported older-schema index;
subsequent current-parser refreshes retain the normal five-minute deadline.
Only the published generation selects this budget. Older parser rows retained
for rotated sources do not keep extending ordinary refreshes. This metadata-only
decision does not replace the worker's full compatibility, integrity, or
publication checks.

Index and accounting validity are separate. After indexing, the authoritative
accounting cache reader may determine that no current generation-bound cache is
reusable (for example after a reviewed accounting-semantics version change).
Only when the runner actually enters that full rebuild does its exact,
count-free accounting marker extend the same run to the four-hour total bound.
A cache hit, malformed progress, or repeated marker cannot extend the ordinary
deadline or re-arm it indefinitely.

## Current table groups

| Group | Tables | Purpose |
| --- | --- | --- |
| Format and parser | `meta`, `parser_version`, `ingest_run` | Family, parser semantics, and run receipts. |
| Publication generation | `index_generation`, `generation_source`, `generation_issue`, `generation_issue_group` | Complete/partial staged generation, exact source coverage, and fixed issue vocabulary. |
| Dimensions | `model`, `tier_semantics`, `surface_class`, `account_scope`, `source_dimension` | Interned closed or pseudonymous dimensions. |
| Quota | `quota_observation`, `quota_occurrence` | Sanitized provider quota evidence and deduplicated occurrences. |
| Usage | `usage_event`, `usage_event_boundary` | Typed token/cost/outcome facts and content-free boundaries/order. |
| Tools | `tool_class_count`, `tool_class_fact` | Closed tool-category counts/facts; no command or tool payload. |
| Incremental ingest | `source_cursor`, `source_boundary_state`, `lineage_snapshot`, `session_identity` | Exact source snapshot/cursor, boundary carry-forward, lineage, and authorized identity continuity. |
| Diagnostics | `source_diagnostic` | Closed counters/codes about parse and source quality. |

## Identity and privacy invariants

- `session_local` is HMAC(device salt, provider session identity) and remains on
  the machine.
- Upload pseudonyms are derived at send time from the export/contribution secret
  and local identity; they are not stored back into the index.
- `scope_local` uses the same local-only construction for account scope.
- Raw session identity is stored only where the authorized telemetry contract
  needs it; it is a validated provider UUID, never a rollout-path fallback.
- Source keys/filenames are represented by HMAC/interned identity and fixed
  provenance, not by private absolute paths.
- Closed enums append but do not reorder. Their ordinal is part of the on-disk
  format.
- Missing account/model/speed/coverage remains an explicit unavailable or
  unknown state.

## Generation and publication

Every rebuild or refresh writes a staged generation. A generation records exact
source counts/bytes, indexed/skipped sources, diagnostics completion, and
complete/partial status. Sources with ambiguous lineage, malformed accounting,
unfinished tails, or other closed source-level issues are quarantined rather
than guessed. A malformed quota observation is omitted with a closed diagnostic
without discarding other valid facts from that source.

Historical usage plan attribution joins admitted `quota_occurrence` facts on
source, byte offset, ordinal and observation time inside the published
`generation_source` membership and scanned-byte boundary. The canonical
`quota_observation` winner is not account/plan provenance. A copied-forward fact
may retain an earlier row generation while belonging to the current publication.
Offsets record the end of a JSONL record, so the final complete record can be
exactly at `scanned_bytes`. Published source states `complete`, `rescanned`,
`resumed`, `touched` and `skipped` are eligible only with completed diagnostics;
unfinished or failed source state is not membership proof.

Plan-era discovery precedes fit/window filtering and includes short-window,
zero-token, tied and conflicting quota observations. Usage quantity intervals
start at the previous retained same-session counter, otherwise the previous
same-source counter; missing or contradictory order remains unresolved. This
does not retroactively attach today's logged-in account to historical events.

Contribution hydration and full-history calibration refuse an in-progress newer
generation or a physical fact/count/source-boundary mismatch. The multi-pass
calibration reader also fences SQLite `data_version` and publication identity
through completion, including same-count corrections. A refusal preserves the
previous usable cache and source history; it is not a repair-by-deletion request.

The low-level rebuild primitive creates a separate
`.building-<pid>-<timestamp>` database, performs integrity checks, fsyncs it,
and atomically renames it over the selected destination. A crash leaves either
the previous live database or the new one, not a torn mixture. The supported
recovery CLI wraps that primitive in a copy-first prepare/apply workflow,
creates a bound backup, and provides a non-writing `--dry-run`; follow the
maintained recovery runbook rather than invoking the primitive as a recovery
rehearsal.

## Reader and writer rules

- Read-only inspection may recognize a migratable legacy family as partial
  evidence.
- A writable open must finish a supported forward migration before use.
- Old or incomplete generation provenance is never silently promoted to
  current authority.
- An older reader must refuse a newer database rather than mutate it.
- Migration/schema failure preserves the original transaction state.
- A successful physical migration does not prove source coverage; generation
  completeness and parser provenance remain separate.

## Compressed Codex histories

Cold `.jsonl.zst` histories use read-only native streaming decompression. No
source is rewritten and no decoded transcript is persisted to a temporary file.
Canonical thread/rollout identity is independent of compression. Discovery keeps
the real physical path and filesystem identity; `physicalSize` is the compressed
file length while `size`, history-base cutoffs, event offsets, and persisted
cursors use uncompressed JSONL bytes. Byte-identical decoded plain/compressed
siblings collapse to one source, preferring the plain representation; divergent
representations quarantine the logical thread. A representation change forces a
safe source rescan, never an append into compressed bytes.

The shared adapter is used by direct provider scans, single/worker rebuilds,
incremental refresh, and supported checkpoint exports. The live passive collector
continues its plain-JSONL capture path; cold compressed history belongs to the
unified/scanner path. Compression alone does not delete or reset its previously
retained live cursors or usage. Checkpoint export accepts paginated resets with
an absent/null physical history base and an explicit valid start ordinal zero.
Logical parents do not imply copied inline history; physical generations have
distinct export occurrence identities while retaining logical session scope.
Creation freezes the discovered parent selection into the source-plan digest;
verification and resume validate those edges against frozen source metadata,
without retargeting them to a later selected head. Malformed bases fail closed.
Actual physical-base continuations remain explicitly unsupported because the
checkpoint state cannot represent an exact ordinal cutoff; direct scans and
the unified index do support that history. Scanner v9, metadata adapter v6 and
checkpoint scan v0.5 fence incompatible prior export workspaces before mutation.

Native support is capability-detected. Node's streaming Zstd APIs were introduced
in Node 22.15.0 and 23.8.0; the project's minimum Node 22.13.0 remains importable
but reports `codex_rollout_compression_unsupported` for compressed source groups.
The packaged Node 26.2.0 runtime exposes these APIs. This is source/runtime
compatibility, not installed-artifact qualification. [Node Zstd API](https://nodejs.org/api/zlib.html#zlibcreatezstddecompressoptions)

Each stream is bounded to 2 GiB compressed, 16 GiB decoded, a 128 MiB native
decoder window, and 120 seconds. Decoded expansion is further limited to the
larger of 64 MiB or 4,096 times the physical length; caller line/resource limits
and cancellation remain active. Discovery permits at most two decoders at once
and retains only a 1 MiB metadata-search prefix. These are refusal ceilings, not
performance targets or evidence that large histories were qualified.

The adapter validates frame/header/block boundaries independently of native EOF:
synthetic Node 26.2.0 probes showed that truncated native Zstd input can end with
empty output instead of an error. It also validates concatenated/skippable frames,
checksums through the decoder, and complete JSONL tails. Unsupported runtimes,
corrupt/truncated data, unsafe sources, and resource limits stay explicit and
content-free. The framing implementation follows the [Zstandard format](https://github.com/facebook/zstd/blob/dev/doc/zstd_compression_format.md).

## Change contract

A schema or parser change requires, in one change:

- a new parser version when extraction meaning changes, and a new
  `user_version` when the physical format changes;
- transactional migration and forward/older-reader failure tests;
- schema, writer, reader, projection, generated contract, and fixture updates;
- exact recovery implications in
  [`../runbooks/unified-index-recovery.md`](../runbooks/unified-index-recovery.md);
  and
- updates to privacy/API/architecture documentation if fields or sources cross
  those boundaries.

Do not revive the deleted dated v2-era design as current documentation. This
maintained reference is the authority and must move with the implementation.
