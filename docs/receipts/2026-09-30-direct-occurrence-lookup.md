---
title: Direct occurrence lookup local qualification
date: 2026-09-30
type: receipt
status: experimental
---

# Direct occurrence lookup local qualification

## Status and scope

This is a local synthetic qualification on the isolated
`codex/analytics-dependency-day-summary` candidate, based on deployed
`d43c8f92a059d9c577776f7eca8a331eb305b8a6`. The prior source-day catalog is
retained as an independently optional component. No remote index, catalog,
deployment, schedule change or publication is recorded by this receipt.

The target is the positive-range lookup: selected occurrences previously
multiplied by every owned device/manifest. Typed-ingestion migration
`0006_direct_owner_occurrence.sql` adds one non-unique index on owner, full
reversible occurrence bytes, format, stream and observed day. The existing
schema statement discovers it. The exact query uses direct seeks when present
and retains its original metadata/format-index path when absent.

All namespace, owner, admission, complete-chunk, retained-domain, correction,
session selection and outside-day checks remain. v1.2 and correction expansion
retain their native indexes. The dependency is still byte-identical
`effective-history-dependency-v3`; this is acquisition optimization rather
than a new authority, result cache or job boundary.

## Complete-phase measurements

Native Miniflare D1, identical content-free admitted inputs before/after the
index, measured with the existing analytics profiler. The 101-day fixture has
166 retained manifests, 2,000 selected usage IDs, 2,000 matching quota IDs outside
the range and 164 unrelated admitted usage rows: 4,164 raw typed records.
All outside variants remain present; the output contains ten exact chunk-header
links. Seven source statements are retained in every singleton measurement.

| Scope | Before rows | After rows | Read reduction | Before local elapsed | After local elapsed |
|---|---:|---:|---:|---:|---:|
| Positive 101 days, usage/quota | 1,123,971 | 86,471 | 13.0 times | 91 ms | 38 ms |
| Positive 101 days, sessions enabled | 1,472,571 | 88,571 | 16.6 times | 114 ms | 38 ms |
| One day, 166 manifests / 200 matches | 107,929 | 9,129 | 11.8 times | 29 ms | 13 ms |
| Sixteen target-day digests, 166 manifests / 200 matches | 222,522 | 17,992 | 12.4 times | 36 ms | 16 ms |

The sixteen-target measurement includes all digests and the staged correction
runtime rechecks: 22 statements both before and after. The local elapsed values
are single observations. The large read savings do **not** imply a matching
latency or whole-pipeline improvement. Production routing, CPU contention,
scheduler completion, adoption and publication remain unmeasured for this
candidate. The dense fixture matches the order of the earlier live scan cost;
it is synthetic, not a replay of private production records.

## Index costs and migration boundary

In the 4,164-record populated fixture, index creation read 8,429 rows, wrote
4,165 rows and allocated an additional 212,992 bytes (about 51 bytes per indexed
record at this fixture's key sizes). Local creation elapsed was 1 ms; this must
not be extrapolated into a production duration. SQLite maintains one extra
index entry per raw typed record. No telemetry payload or analytical result is
copied, and replacement/erasure use their native lifecycle.

Migration SHA-256:
`30988aa2d95498000a4a6e5352551a9695f667f4cefca63cf80c5657bcb4f70f`.
Runtime `storage-effective-history.ts` SHA-256:
`83daa404792d058cdf04146bfc5ee11c50ae1901d4dba9328125a4a9d26b0149`.

This additive index can be trialled independently of the source-day catalog.
A code rollback can use the original query while leaving the additive index in
place; no index deletion or schema downgrade is part of rollback. The existing
closed forward operator still admits only its previously reviewed pair of
migrations. Exact target admission, current version/schema/ledger/binding
fences, capacity/backup evidence, interruption reconciliation and a guarded
production rollout remain separate required work.

## Validation

- Complete affected dependency file: **104/104 pass**, exercising the native
  metadata and direct routes, all three versions, both dependency modes,
  correction activation, cross-day links, incomplete chunks, authority changes,
  sessions, malformed schema/runtime evidence, bounded overflow and deadlines.
- Populated index build, index shape, unchanged seven-statement budget,
  replacement, erasure and optional-index fallback pass.
- Both full positive-range and 16-target fixtures require at least tenfold fewer
  complete-phase reads, unchanged statement counts and exact results/digests.
- TypeScript and **21** canonical-schema / existing-forward-operator tests pass.
  These existing operator tests do not qualify execution of the new target.
- New schema expectations require six typed-ingestion inputs and the exact
  owner-occurrence index; catalog and analytics requirements are retained.

All **195 tests in ten affected consumer files** also pass, covering graph
history, shared-feature consumers, scheduled model blocks, cache retention,
usage/quota preparation, erasure, correction admission, compact proofs and
checkpoint compatibility. Documentation governance and all 20 root preflight
tests pass. Root pnpm initially proposed reinstalling the shared dependency
symlink; the gates ran with dependency-state warnings while preserving that
existing tree. No dependency or lockfile changed.

The complete 17-minute Worker suite is reserved for the final deployment
candidate under the owner's requested targeted iteration strategy; it has not
been rerun for this experimental index. This receipt therefore does not claim a
fresh complete owning gate or production readiness. The production pipeline/
admin UI is unchanged by this local candidate.

## Private evidence

Local logs contain synthetic fixtures only. The complete dependency run is
`tibotattle-direct-occurrence-complete-20260930.log`; schema/operator checks are
`tibotattle-direct-occurrence-schema-20260930.log`. The earlier populated-budget
fixture initially compared different session selections; its options were
aligned and all assertions retained. No source or gate was weakened to repair
that fixture.
