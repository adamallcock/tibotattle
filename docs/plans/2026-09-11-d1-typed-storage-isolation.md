---
title: Typed D1 storage and isolated analytics implementation
date: 2026-09-11
type: plan
status: implementation-in-progress
---

## Status and accepted design

Implementation is on `codex/d1-typed-storage-isolation`, draft
[PR #124](https://github.com/adamallcock/tibotattle/pull/124), based on
`3de7ccd0a293e1d9b95ce14b591dbf5f1c2d1f2b`.
September 12 integration, independent source review and clean-source local
qualification are complete at `edb6cbcb04509ab1ca26f92e1215bfc41055348f`.
The owning Worker gate passed all 1,396 tests across 120 files, the script and
contract checks, and both development/staging dry builds. All three role
qualifications and all 17 effective migration schema comparisons passed.
The exact source, commands and hashes remain in the owning-gate and role receipts.

The approved isolated cloud copy also completed, using the separately frozen
predecessor `5ff56ab76c36da344132002979102f8b6362e6e4`. It completed 183
checkpoints, independently verified all 35 retained authority rows, installed
the typed role and completed bootstrap. Full before/after readback preserved
all 95 source tables and 50 synthetic rows, including storage types, row IDs
and sequence state. The temporary source, Queue and migration Worker were
deleted after verification; the new ingestion and analytics databases remain.
Cloudflare required detaching the Queue consumer before Worker deletion.
This copy did not change production or pre-existing staging resources.

The isolated encrypted cloud application canary also passed at the separately
sealed `5ff56ab7` source. It proved accountless enrollment, five exact ciphertext
objects containing 206 typed records, contribution and domain replay prevention,
separate-process credential reuse, an upload accepted after an injected analytics
failure, exact catch-up in one pass, disconnect and immediate authority withdrawal.
The two private test Workers were disabled and verified closed, with no cron.
The synthetic databases, bucket and encrypted objects remain retained as approved.

The original failed attempts remain evidence. Wrangler's administrative migration
ledger required an exact separate schema/row proof; the application schema was
unchanged. One initial closed-endpoint read returned 500 before later successful
readback. The protocol stopped at a confirmed 429, then resumed the exact saved
manifest after cooldown using the same credential and unchanged rate limits.
This is cloud protocol proof, not a signed desktop scheduler, natural cron,
hosted Access-owner erasure or production activation claim.

The dense v1.1 cloud baseline completed on frozen `edb6cbcb`: 210 distinct
checkpoints, 256 typed records and admission proofs, exact stream totals, final
role/schema/bootstrap and zero foreign-key errors. Full source readback preserved
94 application tables and 297 rows, including types, row IDs and sequences. Its
fresh Worker, Queue and two databases were removed after verification. One
acknowledged duplicate and four scheduled wakeups overlapping successful queue
pages remain explicit evidence. Full 32-row phase means were 1.41–1.87 seconds;
these small pages need optimization before a production maintenance window is
chosen. A 200/100/200/100 bounded-page candidate is under independent review;
its local tests do not establish cloud throughput. Legacy v1 cloud timing is
running separately against its sealed baseline.

The existing production deletion ledger now has migration
`0003_storage_erasure_jobs.sql`. Exact before/native-replay/after readback
preserved all three tombstones and the two prior migration records, including
values/types/row IDs/timestamps; the sequence advanced from two to three. The new
job table is empty and foreign-key checks pass. The main production D1 and upload
routing are unchanged. This completed ledger upgrade does not establish final
source suppression or privacy readiness for the replacement ingestion database.

Remaining execution is ordered as follows:

1. Finish legacy v1 cloud timing and qualify the bounded throughput improvement
   against fresh cloud resources; choose the production window from measured
   throughput and a reviewed production-volume model.
2. Complete independent review and combined-source qualification of the
   maintenance-owned cutover/recovery operator, explicit analytics registration,
   natural scheduling and exact source/role/copy/bootstrap/ledger admission.
3. Prepare the production target schemas; contain source writers; preserve and
   verify any derived-cache archive needed for freeze headroom; freeze and copy.
4. Independently verify authority, typed records, deletion-ledger reconciliation
   and analytics coverage, then activate under the same maintenance owner.
5. Verify uploads, rebuilding and public/admin reads on the actual production
   targets, retaining the legacy source and independent deletion ledger.

The user's September 12 approval covers the remaining actions, including isolated
resources and test keys. It does not waive verification, preservation, the fixed
per-database operating budget, or refusal of an ambiguous outcome.

Use a fresh compact ingestion database and an independent analytics database,
with a **9,000,000,000-byte operating budget for each**. Keep the original source
and the independent deletion ledger. Both v1 and v1.1 uploads retain their
existing admission, consent and replay contracts and enter complete typed
storage. Legacy v0.2 evidence remains preserved for its existing allowance use.

Initial recovery routes to one replacement ingestion database. The implemented
catalog/fencing primitives are preparation for later owner-scoped shards; they
do not yet make automatic shard rollover an activated production feature.
Whole-owner movement must be qualified before an existing owner outgrows its
assigned database. New-owner placement alone cannot prevent that growth.

## Integration evidence and remaining gates

Local qualification, isolated cloud copy and the cloud application canary are
distinct evidence. Counts overlap and are not additive; none alone qualifies
production activation.

| Lane | Verified behavior | Remaining gate |
|---|---|---|
| Ingestion | Actual local v1/v1.1 HTTP admission and replay; all streams; exact typed/export reads; isolated encrypted accountless cloud protocol | Production target upload canary |
| Restore | Qualified local restored-account runtime plus isolated cloud copy, authority verification, sequence high-water, final guards and bootstrap | Dense-page cloud throughput and production-specific operation |
| Independent computation | Qualified local daily values, source-only allowance fits, resumable v1 history, immutable v1.1 day reuse; isolated cloud failure with continued ingestion and exact catch-up | Production independent scheduling and rebuilding |
| Publication | Qualified local daily endpoint and maintained graph DTO; continuous-append historical completion; honest completed-fit snapshots; 401-cell totals without prefix publication | Production target rebuilding and public/admin read verification |
| Erasure | Qualified local retry mapping, offline-analytics refusal, terminal fence, bounded cleanup and late-write refusal | Production deletion-ledger reconciliation and hosted owner-route proof |
| Operations | Exact role qualification, full-file imports, bounded journal recovery and completed isolated remote copy/cleanup | Production freeze headroom, maintenance window and reviewed cutover |

An earlier 10,000-row local rehearsal completed 1,435 bounded restore steps in
102.8 seconds, followed by actual restored-target runtime verification in 4.6
seconds. Copied accountless credentials, exact replay, new upload, analytics,
retained tombstones, opt-out, physical erasure and original-source preservation
all passed. Its dirty-source receipt is explicitly **not qualified** and does
not authorize activation. Source-bound evidence must be regenerated after freeze.
These local timings are not a remote migration throughput forecast.

Additional current receipts include:

- Actual independent scheduling through daily and graph publication, plus
  ingestion readiness with analytics unavailable. Ingestion readiness explicitly
  delegates aggregate rebuilding and does not claim it completed.
- 82 publication/maintained DTO and endpoint tests, including paused-publication
  cleanup and delayed-writer fences. A 16-owner typed fixture published a graph
  with 13 statements; a separate 1,000-owner metadata/cache fixture used 74.
  The latter is not 1,000 complete upload or calculation journeys.
- A 5,003-row typed v1.1 reader returns the first 5,000 rows in one indexed query
  and the remaining three with exact reconstructed values.
- Actual typed v1 historical reduction and its checkpoint fallback return the
  same nonzero result. Materializing a narrow, bounded quota input removed a
  reproducible SQLite query-planner memory failure.
- More than 200 model cells in one day retain complete totals and pricing;
  display truncation remains explicit. Obsolete checkpoint generations retire
  without deleting the current or partially staged successor.
- At the analytics operating cap, a bounded cleanup pass still runs; new
  calculation remains refused. A full derived database cannot trap itself by
  disabling the cleanup that would reclaim space.
- Repeated uploads from two owners no longer prevent closed historical results
  from publishing. Current previews retain completed calculations under unchanged
  hard authority, while separate freshness fields keep refresh work queued.
  In-window changes, correction, deletion, source-format changes, future inputs
  and malformed freshness remain refused.
- Corrupt completed model points are counted as unfinished and repaired, including
  an invalid payload with its own matching hash. Progress requires the explicit
  current-input flag as well as the input epoch.
- New uploads check the ingestion operating budget after exact replay detection;
  accepted retries remain available. A consumer refuses a rolled-back or diverged
  source journal instead of silently advancing over mismatched history.

Independent cross-review and the owning gate are complete at the revision above.
The owning-gate receipt binds qualification to the exact tested source and
commands. The private migration
Queue advances one verified bounded page per message; duplicate and delayed
wakeups converge by checkpoint identity. Uncertain writes remain stopped.

## Required migration proofs

1. Reconstruct every admitted canonical/legacy record, preserving NULL, zero,
   unknown, exact numeric values, original identities and source membership.
2. Preserve all retained non-derived authority: enrollment, credentials, grants,
   consumed/revoked receipts, manifests, consent, exclusions and operational
   state. A data-only copy is insufficient.
3. Freeze source writes under an exact operation identity, copy in bounded
   pages, and independently compare every required retained row. Unknown write
   outcomes stop for reconciliation; retries must not assume failure.
4. Install and verify final guards only after legacy authority and typed
   evidence adoption. The restore-base schema alone is not a writable app role.
5. Reconcile the independent deletion ledger before activation. Erasure must
   cover both ingestion and derived payloads; a source-only deletion is not a
   completed privacy receipt.
6. Initialize separate analytics with the exact source identity and namespace,
   then qualify enrollment, upload, replay, opt-out, erasure, rebuilding and
   public/admin reads against the prepared target.
7. Review the exact configuration and cutover, retain the old source, and verify
   the live result. Once the target accepts new writes, rollback requires their
   reconciliation; simply switching the old binding back is unsafe.

The current restore operator supports **raw legacy to fresh typed storage**.
Rolling a typed source backward behind a consumer checkpoint is a different
recovery operation. It requires verified journal reconciliation or a distinct
source incarnation and fresh consumer, with deletion-ledger replay before
activation. Raising an epoch alone cannot repair sequence/event divergence.

## Qualification and execution order

1. Finish independent review fixes and focused regressions.
2. Freeze the complete source. Run the owning Worker check, architecture,
   documentation/preflight checks, and disabled-role dry builds.
3. Generate source-bound restore-base, final-role and analytics qualification
   artifacts. Preserve hashes, exact migration order and runtime-ready boundary.
4. Present the concrete staging resource/configuration/copy operation for the
   exact approval required by `apps/worker/AGENTS.md`.
5. Execute and verify staging; prepare the corresponding production operation.
   Resource creation, schema migration, data migration, deployment and cutover
   remain separate evidenced steps.

Read-only staging inspection on September 12 found a retained divergent
48-migration accountless lineage, not the canonical 60-migration restore source.
Keep that existing staging database intact; do not apply same-numbered canonical
migrations to it. Qualify the initial remote restore against a fresh synthetic
source with the canonical schema before planning the real-data operation. Both
observed remote D1 stores also contain Cloudflare's exact `_cf_KV` metadata table.
Schema normalization excludes exact reviewed provider shapes with no attached SQL;
unknown provider-prefix tables and altered definitions remain drift.

See the [operator runbook](../runbooks/2026-09-11-d1-storage-operator.md) for the
maintained commands and the [schema map](../research/2026-09-11-ingestion-analytics-schema-map.md)
for the baseline 94-table inventory.

## Storage measurement boundary

The latest qualified 10,000-record complete-role fixture at `1a2d8a36`
measured **28,352,512 bytes before versus 10,485,760 bytes after**, about a
63% whole-file reduction. It includes authority, admission proofs, indexes and
restore metadata, and excludes the separate analytics database. The restore
and actual restored-account runtime completed in 73.1 seconds locally. Neither
the storage ratio nor that timing is a production capacity or duration forecast.
The measurements below preserve earlier implementation-stage provenance.

The [earlier synthetic measurement](../research/2026-09-11-typed-storage-measurement.md)
at frozen source `62516e878197ec9c1524a8c8a87c0344e2277677` measured
320–353 incremental bytes per record versus 1,834–1,845 in the two raw-record
fixtures, an 81–83% reduction. It includes typed dictionaries and indexes but
**excludes later authority, admission, proof, journal and analytics overhead**.
It must not be used as a whole-database saving or contributor-capacity claim.
The first complete-role 10,000-row v1.1 usage rehearsal measured **28,348,416
bytes before versus 15,003,648 bytes after**, a 47.1% whole-file reduction. After
subtracting empty-schema overhead, this was 2,672.2 versus 1,287.8 bytes per
record. It is a one-owner synthetic fixture, includes restore receipts and
excludes the separate analytics database; it is not a production forecast.

Inspection identified 902.8 bytes per record in the permanent admission proof
table and indexes, chiefly repeated textual chunk/manifest/occurrence keys.
The compact proof migration removes the repeated parent keys and redundant
uniqueness indexes, preserving indexed lexical cursors through its compatibility
view. The final complete-role 10,000-row remeasurement is **28,348,416 bytes before
versus 10,481,664 bytes after**, a **63.03% whole-file reduction**. After empty
schema overhead, this is **2,672.23 versus 832.72 bytes per record**, a 68.84%
reduction. It includes complete authority, admission proofs, indexes and restore
metadata; the separate analytics database is excluded. It is a synthetic usage
fixture, not an observed contributor mix. The receipt is
`/private/tmp/tibotattle-storage-compact-10000-20260912/qualification-evidence.json`
(SHA-256 `d189d5f5d1240c14869c1fb187faa51ae35e6a079523c0d0710a1146b7c788ee`).
The first receipt
is preserved at `/private/tmp/tibotattle-operator-full-role-10000-20260912-c/qualification-evidence.json`
(SHA-256 `ae32e55737945ef247af1c9350aab726614b63b566bf08c3c35218b2c73410e9`);
it explicitly records unfrozen source and does not qualify deployment.

## Prior qualification provenance

| Frozen source | Complete Worker evidence |
|---|---|
| `672043033fda15c0e3d0ed15bda5122458cac24a` | 1,110 tests / 84 files; 27 operator checks; types, packages, endpoints, development/staging dry builds |
| `62516e878197ec9c1524a8c8a87c0344e2277677` | 1,149 tests / 88 files; 27 operator checks; complete owning gate |
| `28a0f44f82d7afccce392a3f9f708090acb755bb` | 1,185 tests / 92 files; 27 operator checks; complete owning gate; 528 production files / 2,071 imports / no architecture debt; 20 documentation/preflight tests |

These are retained source receipts, not proof of the current integration or any
production database. Git history retains the superseded implementation notes.
