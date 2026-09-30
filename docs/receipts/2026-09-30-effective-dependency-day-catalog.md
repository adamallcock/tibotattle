---
title: Effective dependency source-day catalog local qualification
date: 2026-09-30
type: receipt
status: local-provisional
---

# Effective dependency source-day catalog

Snapshot: September 30, 2026, 17:20 UTC. Isolated branch
`codex/analytics-dependency-day-summary`, based on deployed
`d43c8f92a059d9c577776f7eca8a331eb305b8a6`. This candidate is local and
uncommitted. No remote migration, deployment or measured production speedup
is claimed. The complete owning Worker gate remains pending.

## Implemented scope

- One append-only presence row per participant, stream and source day, shared
  across v1, v1.1 and v1.2. Participant is a conservative lookup key; devices,
  generations and record counts do not multiply these summaries.
- Forward source migration `0013_effective_dependency_day_catalog.sql` adds
  two tables and 12 triggers. It backfills all chunk headers and correction
  history before writing its completed-backfill seal. Existing analytics and
  deletion-ledger schemas are unchanged.
- Source insertion maintains presence transactionally. Staged chunks, retired
  chunks and staged correction history remain candidates. Replacement does
  not remove presence; participant erasure cascades it away. Direct updates
  and premature deletion of presence are refused.
- Two indexed outside-range existence probes run inside the original link
  statement. A negative catalog empties its materialized selection scope,
  avoiding occurrence acquisition. The original final correction-runtime
  fence also validates the backfill seal. Every dependency byte remains v3.
- Positive lookups and multi-target batches retain the exact original scan.
  Another target inside a batch remains outside each individual day.
- Before the optional migration, the existing path remains available. Missing
  catalog guards or an unsealed catalog cannot authorize the shortcut. Owner,
  authority, consent, cohort, erasure and publisher checks are retained.

## Measurements and validation

Real Miniflare D1, identical synthetic inputs, seven statements in both paths:

| Input | Before rows read | After rows read | Before SQL ms | After SQL ms | Before wall ms | After wall ms |
|---|---:|---:|---:|---:|---:|---:|
| v1 with a correction | 930 | 918 | 22 | 21 | 23 | 23 |
| v1.1, 2,000 usage records | 25,254 | 917 | 12 | 11 | 14 | 12 |
| v1.2, one usage record | 929 | 926 | 10 | 11 | 12 | 12 |

The dense v1.1 dependency phase reads **27.5 times fewer rows**. Its 14-to-12 ms
local wall observation is not a 27.5 times latency gain. Small inputs do not
show a substantial saving. Production acquisition, scheduling, calculation,
publication and public freshness still require separate measurement.

- 52 dependency tests pass. One new benchmark test fails solely on its
  100-times whole-phase read-saving requirement; its exact-byte, migration,
  catalog-granularity and statement assertions pass before that assertion.
- All 67 tests in nine affected integration files pass: v1/v1.1 admission,
  corrections, erasure, shared-feature consumers and batched readers.
- All 18 schema-builder and existing forward-operator tests pass. These
  qualify the existing operator contracts, not a new catalog migration target.
- Worker TypeScript and generated binding checks pass.
- Production dry build passes using the retained parent public asset archive.
  No assets or resources were published.
- Derived full schemas add exactly the reviewed 14 primary objects, remove
  none, and retain the analytics and deletion-ledger schema digests.

Automatic approval review rejected lowering the new performance assertion to
10 times, citing the repository rule against weakening tests. The assertion
remains unchanged. The owner has been asked whether a 10-times minimum is
acceptable for this first slice; no approval has been inferred.

## Remaining gates

1. Resolve the benchmark requirement and qualify its final test.
2. Run one final owning Worker gate on the frozen candidate, reusing the
   focused evidence while iterating.
3. Extend the reviewed migration operator to admit exactly this primary-only
   catalog migration. The current existing-role operator admits only its two
   earlier closed index/cursor migration files; its green tests do not admit
   this new operation.
4. Prepare exact live version/schema fences, backup, migration, rollout,
   pause/restore and rollback evidence, then obtain the applicable production
   authorization for that concrete package.
5. Measure the identical dense production scope and newly completed public
   outputs. Investigate positive-range summaries after this bounded slice.

Migration SHA-256: `a0f955007ed725bdd7206753b8deea3f1e9b0786267a46c88c6b8639dbb04a3d`.

## Private evidence digests

The named files are retained in private local temporary storage. Logs are not
published and may contain operational configuration. No private source rows,
identities, bindings or credentials are copied into this receipt.

| Artifact | SHA-256 |
|---|---|
| tibotattle-dependency-catalog-contracts-20260930.log | `b511ab34f3bf930716b7ce0a82095faae3bfb9b3401e2133cd62b4a7cc045381` |
| tibotattle-dependency-catalog-integration-20260930.log | `197a698c68f23be3064a47bb45a4f594a62062677b816009c756fa67cf250948` |
| tibotattle-dependency-catalog-types-qualified-20260930.log | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| tibotattle-dependency-catalog-generated-types-20260930.log | `022def97fdc659f253622dd1542d3747b6fdb6f71dc46e2f9abfcdc2344427c5` |
| tibotattle-dependency-catalog-schema-tooling-20260930.log | `af2d6b3de900b9b2b9da27eaf21dfe975773a6bff722e73b8a54fb5970ee4ce2` |
| tibotattle-dependency-catalog-schema-20260930.json | `c070e554548883b6677d3944d799b30f755daac4d0b965813e905cf82b64ca1e` |
| tibotattle-dependency-catalog-dry-production-20260930.log | `e340a18fb11fc9ce6fab2df158556c4e4627890ff83a17f1a60d30031c8e30d4` |

## Owner-approved acceptance update

September 30, 2026, 17:40 UTC: the owner explicitly approved a **10-times
minimum** for this first slice. Read-only provenance checks showed that the
100-times assertion was newly introduced in the uncommitted experiment and
was absent from deployed parent `d43c8f92`. Automatic review accepted the
exact requirement update after those checks. Exact-byte parity, the seven-
statement budget and every correctness assertion are retained.

The complete dependency file now passes **all 53 tests**. The earlier 67
integration tests and 18 schema/operator tests remain unchanged passing
evidence; a final owning Worker qualification and migration operator remain
pending. The historical failed benchmark above is retained as the earlier
snapshot, not the current acceptance result. No production change occurred.

Approved dependency log SHA-256: `287b7e6ceaed959caf4e4e5f4427dd661fffd03ebe29a83c3f47a6de50eff074`.

## Qualification closure and production hold

Snapshot: 2026-09-30T18:28:19+00:00. Runtime and migration bytes remain identical
to `26b21fd1`; the source was frozen at `3686c56a` after test-only repairs.
Changes since the runtime commit are the schema-count fixture and two
historical-schema fixtures. No source, migration, package or lockfile changed
while the broad runtime suite ran.

The owning qualification was completed by retaining unchanged passing steps
and repairing only the failing fixtures:

- Workspace guards, endpoint checks, generated bindings and TypeScript passed
  in the initial owning run. The schema test's count was corrected to 91
  primary inputs and now explicitly requires both catalog tables and 12 guards.
- All script checks passed in the continuation. The full runtime run covered
  191 files / 2,440 tests: 2,431 passed and nine failed during fixture migration.
  Those two files intentionally omit correction or v1.2 prerequisites but had
  unintentionally selected the dependent catalog migration.
- The two fixtures now omit the catalog only in those historical schema cases.
  Every assertion is retained. Both complete files passed all 26 tests, covering
  the nine failures and their 17 previously passing cases. There was no new
  single all-green full-suite run; this is combined broad and focused evidence.
- Final default and staging dry builds passed on the clean frozen source.
  The earlier explicit production dry build retains unchanged runtime-code
  evidence. No resources, assets or schedules were published.

A version/binding-fenced read-only live check sampled the eligible source with
the largest retained header volume in a 101-day usage/quota window. It returned
outside-day v1.1 and v1.2 candidates; v1 and correction candidates were absent.
The owner/source revisions and deployed Worker version remained unchanged
across the read. The negative shortcut is **ineligible for that sampled scope**.
This one sample does not estimate coverage for other sources or dates.

The catalog is therefore retained as a qualified local component. The approved
10-times minimum applies to its eligible dense local benchmark, not a measured
production speedup. A production rollout is held while the positive-range path
is investigated. The next bounded comparison should avoid manifest/device
fanout when seeking exact encoded occurrence IDs, retain all native admission,
namespace, correction and outside-header proofs, and measure complete phase
rows/time plus any new index/storage cost.

The local migration review package is non-executable. It contains the exact
19-statement catalog migration and its atomic 20-result ledger envelope, plus
all-role before/after schema evidence. The existing closed forward operator
does not admit this new file. Fresh production fences, a guarded execution
operator and post-migration rollback qualification remain pending.

| Additional private evidence | SHA-256 |
|---|---|
| tibotattle-dependency-catalog-owning-gate-26b21fd1-20260930.log | `3bf909dd44c99f7cedd61e3be1595463f4ef9b103bfb529f5b178436059a445f` |
| tibotattle-dependency-catalog-owning-continuation-20260930.log | `d074209bb0931a39f64ae9b49ab24939ec47f9a78eabdd35d715a80b05924f73` |
| tibotattle-dependency-catalog-preflight-fixture-20260930.log | `2638cc83ca8ad8ce8f2b6f322081958b44b7ad8a651a975d57f3ba56a2e4b8ee` |
| tibotattle-dependency-catalog-historical-fixtures-20260930.log | `fc000e8b673bc234ad580fc9ecd4b9ee17b6fb6cf38e8affe3e3af4cb71d14c0` |
| tibotattle-dependency-catalog-final-builds-20260930.log | `593407f8501b2d56828f61239663a3a204ee9bcd09c73d94bbede86cb2fd8a3e` |
| tibotattle-dependency-catalog-live-eligibility-20260930.jsonl | `cbd3fed67a6092f410cc354faffe5278abeafbff23f8295e67b7c1dba90560d5` |
