---
title: Implemented typed storage synthetic measurement
date: 2026-09-11
type: research
status: measured-local
---

## Result and scope

The actual typed repository at commit
`62516e878197ec9c1524a8c8a87c0344e2277677` stored the same 100,000 synthetic
records per scenario using 81–83% less incremental allocation than the baseline
raw record tables and indexes. No records were deduplicated or discarded.

| Scenario | Typed bytes/record | Baseline bytes/record | Reduction | Typed file | Baseline file |
|---|---:|---:|---:|---:|---:|
| Shared sessions | 319.86 | 1,833.86 | 82.56% | 32.24 MB | 183.44 MB |
| Distinct sessions | 352.91 | 1,845.49 | 80.88% | 35.54 MB | 184.60 MB |

Bytes per record subtract the measured empty database allocation. Whole-file
sizes use decimal MB. This supports the direction of the compact-schema design;
it does not establish production contributor capacity or whole-system storage.

## Method

- Each scenario contains 25,000 records in each of v1 quota, v1 usage, v1.1
  quota and v1.1 usage. Both retain 100,000 records in 500 chunks of 200.
- Shared sessions uses 17 owners and 1,250 scoped session identifiers; distinct
  sessions uses 125 owners and 50,000 session identifiers. Session identifiers
  are part of usage records; these fixtures contain no session/tool summary rows.
- The typed measurement uses the implemented repository and migrations
  `0001`–`0004`, with all maps, subtype tables, indexes, triggers and empty
  delivery/copy state. The baseline uses exact raw-record table definitions,
  five explicit indexes and three implicit scoped uniqueness indexes.
- Baseline parent, authority and analytics allocation is excluded. The new live
  authority/admission schema is not yet integrated, so its eventual additional
  allocation is also unmeasured. Future transactional proof indexes/digests can
  change these results.
- Empty and populated `dbstat`/page allocation were captured. Two hundred sampled
  rows per scenario reconstructed to the original canonical and legacy bytes.
  Complete preservation is separately covered by codec/copy tests; this sample
  is not an exhaustive production migration verification.
- Node 26.2.0 and SQLite 3.53.1 used 4,096-byte pages through a local D1-shaped
  adapter. Local synchronous writes were disabled for the disposable synthetic
  measurement. No durability, remote D1 throughput or latency claim follows.

The run completed September 11, 2026, 9:44 p.m. Eastern. Ignored local evidence is
retained under `.release-build/typed-storage-measurement/` in the implementation
worktree: `receipt.json`, `measure.mjs`, `typed-runtime.mjs` and
`baseline-record-layout.sql`, plus the disposable databases. The receipt pins
the source and artifact hashes and records per-table/index allocation. No
production data, external model, or remote operation was used.

The [implementation plan](../plans/2026-09-11-d1-typed-storage-isolation.md)
keeps complete runtime, migration and production qualification separate.
