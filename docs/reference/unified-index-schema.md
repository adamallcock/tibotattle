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
| SQLite `PRAGMA user_version` | `10` | Physical table/index/migration generation. |
| Parser version | `unified-rollout-typed-v10` | Meaning and provenance of facts extracted from rollout sources. |
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

Current source can migrate physical versions 1 through 9 forward to 10. A
newer version is not safe for an older reader. Migrations are transactional and
forward-only; there is no supported in-place downgrade.

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
complete/partial status. Sources with ambiguous lineage, invalid content,
unfinished tails, or other closed issues are quarantined rather than guessed.

The full rebuild command creates a separate
`.building-<pid>-<timestamp>` database, performs integrity checks, fsyncs it,
and atomically renames it over the selected destination. A crash leaves either
the previous live database or the new one, not a torn mixture. There is no
automatic backup and no dry-run mode; therefore recovery rehearsal must target
a separate explicit path.

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

## Change contract

A schema change requires, in one change:

- a new `user_version` and parser version when meanings change;
- transactional migration and forward/older-reader failure tests;
- schema, writer, reader, projection, generated contract, and fixture updates;
- exact recovery implications in
  [`../runbooks/unified-index-recovery.md`](../runbooks/unified-index-recovery.md);
  and
- updates to privacy/API/architecture documentation if fields or sources cross
  those boundaries.

Do not revive the deleted dated v2-era design as current documentation. This
maintained reference is the authority and must move with the implementation.
