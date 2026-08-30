---
title: Local unified index v11 cleanup indexes
date: 2026-08-28
type: decision-record
status: accepted
---

# Local unified index v11 cleanup indexes

## Context

The 0.1.17 schema-10 candidate completed an artifact-bound rebuild of the
retained local corpus with SQLite integrity and foreign-key checks passing. The
run processed 7,107 discovered sources, 678,163 usage events, and 887,133 quota
occurrences in 10,471,984 ms. That proves the parser and schema can produce a
valid database, but it leaves too little margin beneath the four-hour cold-build
safety bound to qualify the path.

The measured hot path was a late runtime quarantine. Fresh staged builds defer
secondary indexes until parsing finishes, but quarantine cleanup previously ran
before those indexes existed. Cleanup by `usage_event.source_local` and orphan
checks by `usage_event.quota_observation_id` therefore scanned the growing usage
table, while quota replacement and tool cleanup also ran before their deferred
indexes were available. A large invalid source could multiply those scans by
its distinct quota observations.

## Decision

### Schema 11 is the 0.1.17 physical format

The current physical `PRAGMA user_version`, minimum reader version, and minimum
writer version are 11. The logical marker remains `local-unified-index-v2`. At
adoption the parser remained `unified-rollout-typed-v10`; this physical change
affected database layout and cleanup ordering, not provider parsing semantics.

Schema 11 adds required indexes for:

- `usage_event(source_local)`; and
- `usage_event(quota_observation_id)`.

Existing schema-8, schema-9, and schema-10 databases are recognized transition
inputs. Normal ingestion rebuilds schema 8/9 on a staged schema-11 database from
readable raw history because those versions predate the current source-identity
contract. It clones schema 10, creates the required index set, and stamps schema
11 in the same migration transaction without a source rescan. A read-only open
never migrates. An older compatibility-aware build refuses schema 11 as newer
state; shipped 0.1.16 remains outside that byte-preserving guarantee and must
not reopen any migrated 0.1.17 index.

### Runtime-quarantine cleanup follows index construction

A fresh staged rebuild may continue deferring secondary-index maintenance while
it parses. If a source becomes invalid after emitting derived facts, the builder
immediately removes those facts from its in-memory totals, marks the source and
its dependants unavailable, and records only a bounded pending-cleanup entry.
It does not publish the stage.

After all parser lanes settle, the builder flushes fact writes, creates and
validates the complete required index set, deletes every queued source's facts,
restores its quarantine cursor, and flushes again before generation
attestation, integrity checks, and atomic publication. Quarantined facts can
therefore never become authoritative, while cleanup uses indexed plans.

### Timeout and channel boundaries do not substitute for qualification

The four-hour fresh-build timeout remains a safety ceiling, not evidence that a
path completing just beneath it is healthy. Release qualification requires a
bounded regression for late quarantine plus a real-data rebuild receipt with
adequate margin.

Preview remains isolated from stable state. A new Preview creates schema 11
directly from independently readable raw history. Migration is rehearsed on a
consistent disposable stable-state copy; the later signed same-identity
internal dogfood proves the installed upgrade path.

## Consequences

- The schema-9-to-10 rehearsal remains valid evidence that the earlier direct
  migration preserved rows, but it does not qualify the final 0.1.17 app path.
  The release rehearsal must prove a schema-8/9 staged rebuild or a schema-10
  additive migration to schema 11, matching the state actually under test.
- Adding the required indexes without changing `user_version` is prohibited:
  index presence is already part of schema validation, so changing that set
  under version 10 would make compatibility depend on which build created it.
- A successful clean Preview rebuild still does not prove stable-state migration,
  signing, notarization, installation, updater acceptance, or rollback.

## Parser follow-up on 2026-08-29

Parser `unified-rollout-typed-v11` now changes source interpretation without a
second physical schema change. It omits an invalid quota window at record level
instead of quarantining unrelated valid facts from the entire rollout, and it
resets lineage snapshots for a selected paginated replacement that starts with
no `history_base`. The parser stamp makes still-present sources rescan after an
additive schema-10-to-11 migration; rotated rows keep their older recorded
provenance. The schema-11 cleanup-index decision and migration transaction are
otherwise unchanged.

## Related documents

- [Local state schema and macOS release-channel isolation](./2026-08-27-local-state-schema-and-release-channel-isolation.md)
- [Local unified-index recovery](../runbooks/unified-index-recovery.md)
- [macOS stable release runbook](../runbooks/macos-stable-release-runbook.md)
