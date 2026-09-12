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
September 12 integration and independent source review are complete. Final
clean-source qualification is the next gate; its exact tested revision and logs
are recorded in the generated owning-gate and role receipts, not inferred from
the earlier revision receipts below.
**No remote resource, schema, binding, deployment or data has changed.**

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

All results below are synthetic local checks. Counts overlap and are not additive.

| Lane | Verified behavior | Remaining gate |
|---|---|---|
| Ingestion | Actual v1/v1.1 HTTP admission and replay; all three streams; exact typed canonical/export reads; no raw JSON fallback | Complete frozen-source gate |
| Restore | Bounded copy of retained evidence and authority, independent verification, original row-ID high-water, final guards, bootstrap, successful successor upload | Source-bound package |
| Independent computation | Actual daily values, source-only allowance fits, resumable v1 history, immutable v1.1 day reuse | Final combined qualification |
| Publication | Daily endpoint and maintained graph DTO; continuous-append historical completion; honest completed-fit snapshots; 401-cell totals without prefix publication | Final combined gate |
| Erasure | Durable independent retry mapping; offline analytics prevents false completion; prioritized terminal fence; bounded payload cleanup; late writes rejected even with publication paused | Complete frozen-source gate |
| Operations | Disabled migration/analytics Workers build; bounded journal runner preserves uncertain outcomes | Reviewed clean-source role packages, exact staging operation |

The final 10,000-row local rehearsal completed 1,435 bounded restore steps in
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

Independent cross-review is complete. The final owning-gate receipt must bind
all qualification to the exact tested source and commands. The private migration
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

See the [operator runbook](../runbooks/2026-09-11-d1-storage-operator.md) for the
maintained commands and the [schema map](../research/2026-09-11-ingestion-analytics-schema-map.md)
for the baseline 94-table inventory.

## Storage measurement boundary

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
