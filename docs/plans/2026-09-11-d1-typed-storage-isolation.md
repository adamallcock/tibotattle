---
title: Typed D1 storage and isolated analytics implementation
date: 2026-09-11
type: plan
status: implementation-in-progress
---

## Scope and boundary

Implement the accepted complete typed-storage redesign using existing Wrangler
tooling, with a 9,000,000,000-byte operating budget per database. Preserve both
upload formats, all original evidence and identities, authority, durable opt-outs,
duplicate prevention and deletion-safe replay. Analytics failures must not block
accepted uploads. This plan records implementation progress, not production
migration or deployment evidence.

The initial recovery uses a fresh ingestion replacement and a separate analytics
database; keep the old source and independent deletion ledger. Normal routing
initially resolves to one ingestion database. Qualify owner-scoped placement and
fenced moves before activating additional ingestion shards. A separate catalog
is required for that later fleet; it is not an authorization substitute.

## Implementation lanes

| Lane | Responsibility | State |
|---|---|---|
| Typed raw storage | Complete codecs, typed fields/maps, original source-row namespace, indexes and bounded repository | Local implementation and tests pass |
| Delivery | Ingestion-local transactional journal, independent idempotent analytics application and snapshot-bound withdrawal fences | Local real-v1.1 activation, bounded daily projection, discard and retirement tests pass; production composition pending |
| Routing | Single-shard adapter, explicit owner catalog, capacity reservations and fenced whole-owner moves | Local tests pass, including a typed batch and racing move |
| Wrangler operations | Exact resource/schema plans, uncertainty reconciliation, per-database migration receipts and explicitly approved deadline extensions | Local implementation and 27 focused checks pass |
| Raw evidence copy | Bounded old-schema reads, atomic typed copy/checkpoints, exact second-pass verification | Local populated-source tests pass; authority copy and source freeze still pending |
| Integration | Existing admission, domain closure, readers, scheduling, erasure and public eligibility | Fresh-target typed v1.1 staging, exact domain closure and isolated daily projection pass locally; full role/runtime integration pending |
| Qualification | Local D1 failure tests, complete evidence copy, query/runtime checks, protected staging and production gates | Pending |

## Required proofs

- Every accepted current/legacy canonical record reconstructs from complete typed
  fields, with NULL, zero, unknown and unavailable preserved. Keep original row,
  owner, device, chunk, manifest and source-version membership.
- Record acceptance and its journal event commit in one ingestion database batch.
  Queue notification is optional; the journal remains replayable after a crash.
- Analytics applies immutable source revisions idempotently and resumes from
  committed checkpoints. Failed writes do not acknowledge unprocessed evidence.
- Withdrawal/erasure remain authoritative during analytics failure; late delivery
  cannot resurrect revoked evidence or publish stale eligible-owner state.
- Stale routes cannot write to an owner after source fencing. Preserve credentials,
  replay receipts and source identities across moves, including into a nonempty
  shard. Catalog generations do not replace source or authority revisions.
- A migration copy is verified before switching writes. Unknown remote outcomes
  require reconciliation. Keep the source; rollback after new writes requires
  reconciling those writes. Never use owner erasure to retire a migration copy.
- Use bounded batches and independent shard budgets. New-owner placement alone
  does not prevent existing contributors growing; prepare movement capacity early.

## Execution order

1. Implement and verify local codecs, schemas, routing and delivery primitives.
2. Integrate the existing ingestion and analytical readers with those boundaries.
3. Rehearse populated old-to-new copies and failure cases with synthetic data.
4. Prepare exact replacement resource IDs, schema hashes, a consistent copy/final
   delta or pause protocol, and a durable operation journal through Wrangler.
5. Copy and verify all evidence and authority before a guarded cutover; retain
   the previous database and replay the independent deletion ledger.
6. Verify real enrollment/upload/retry, opt-out, analytics rebuilding and public
   eligibility as distinct live gates. Record resource creation, migration and
   deployment separately.

The source implementation remains disabled for production until these gates are
met. A storage model or green primitive test is not full migration qualification.

## Current local evidence

The work is isolated on `codex/d1-typed-storage-isolation`, based on
`3de7ccd0a293e1d9b95ce14b591dbf5f1c2d1f2b`. No production resource, binding,
deployed schema, or release has changed in this implementation stage.

- Typed tests cover all admitted streams in both formats, exact canonical and
  legacy round trips, owner-scoped private maps and cascade removal, all quota
  null combinations, incompatible layouts, and bounded 200-record batches.
- Copy tests exercise the existing fully migrated source and real local
  credential/chunk repositories, including staged evidence, nonempty destination
  namespaces, concurrent retries, response loss after commit, rollback, changed
  source evidence and inadmissible original row IDs. No source is deleted.
- Delivery primitives prove separate database failures, committed checkpoints,
  duplicate and out-of-order events, terminal-state refusal and snapshot-bound
  authority checks. The additional optional v1.1 bridge uses real admitted
  domain activation and accountless revocation in local D1. It preserves every
  baseline admission/analytics guard, journals head replacement as a hard
  authority change, and pins older referenced source evidence until erasure.
- The v1.1 daily projection processes at most 200 records per step, stages all
  days before acknowledging a generation, and prices through the current
  accounting code. It stores repeatable aggregate counters/model cells, not
  copies of raw records. Withdrawn or erased old events receive an explicit
  source-proven discard receipt so an ordered consumer cannot stall behind
  deleted evidence. Head removal is immediate; physical cleanup is separately
  bounded to four days and 200 page receipts per call, with retirement receipts.
- Projection regressions cover response loss, rollback, multiple days, multiple
  owners, withdrawal during a page, and delayed initialization after physical
  retirement. Internal reads check the captured consumer authority against the
  source. No production public route or scheduler selects this new projection.
- Typed SQL views retain original row identities and fields. The bounded reader
  reconstructs canonical/legacy JSON with the maintained JavaScript codec:
  SQLite JSON numeric formatting cannot preserve every admitted binary64 value.
  Precision, extended dates, private identifier tags, indexed cursors and
  session pagination are checked. Active-domain authority is a separate join.
- Routing tests include asynchronous preparation of actual typed records and
  same-batch rejection of a move racing that preparation. The shared transaction
  limit is 900 statements, leaving invocation headroom for routing/admission.

Commands and exact operation boundaries are in the
[Wrangler operator runbook](../runbooks/2026-09-11-d1-storage-operator.md).
The [schema map](../research/2026-09-11-ingestion-analytics-schema-map.md) inventories
all 94 baseline tables and identifies the guards that must survive integration.

Foundation validation on September 11: the full Worker Vitest run passed **1,110 tests in
84 files**. The final focused storage run passed **62 tests**, and the final
Wrangler operator run passed **27 checks**. TypeScript, workspace-copy guards,
generated types, endpoint checks, documentation governance and 20 preflight
tests passed. Guarded development and staging dry builds then passed from the
clean committed foundation `672043033fda15c0e3d0ed15bda5122458cac24a` using
manifest- and source-verified existing public assets. This does not provision or
deploy these databases. The subsequent integration adds 39 focused storage
tests. Its complete `npm run check` passed at frozen source
`62516e878197ec9c1524a8c8a87c0344e2277677`: **1,149 tests in 88 files**, the
27 operator checks, all script/type/package/endpoint checks, and guarded
development/staging dry builds. The focused storage command passes 101 tests;
architecture and the 20 documentation/preflight tests also pass.

An [actual-layout synthetic measurement](../research/2026-09-11-typed-storage-measurement.md)
at the same source revision measured **320–353 incremental bytes per record**
against **1,834–1,845 bytes** in the baseline raw record tables and indexes. It
preserved all rows and includes the new dictionaries/indexes. This is an
81–83% reduction for those two fixtures, not a production capacity forecast.

## Next implementation boundary

The optional bridge and daily projection are connected in local tests. The
fresh-target typed admission slice now also uses actual manifest/chunk,
consent, upload-grant, predecessor and head authority in the same ingestion DB.
It allocates original numeric row IDs inside the chunk transaction, stores
typed records without either raw JSON copy, and uses exact base/legacy digests
for domain preservation. Attribution-only refinement remains permitted; changed
numbers, NULLs, session maps or missing occurrences fail closure. Existing v1
evidence needs a bounded proof tied to its exact still-current raw row.

The local accountless journey exercises HTTP enrollment/ownership, claimed
uploads, typed staging, real activation, a journal, isolated 200-record
projection pages, analytics failure, withdrawal and owner erasure. Pending work
pins its source layout and original namespace, and typed reads never fall back
to an empty JSON table. This is a new-target local composition; the deployed
HTTP upload route and scheduler still select the original implementation.

The final focused run for this slice passed **137 storage tests in 12 files**,
including the maximum 200 distinct session records with attribution inside the
900-statement and 4 MiB transaction limits. Independent review confirmed that
admitted subtype deletion and added session-tool entries cannot invalidate a
saved preservation proof; ordinary owner/chunk cleanup remains possible.
The complete Worker `npm run check` then passed against clean frozen source
`28a0f44f82d7afccce392a3f9f708090acb755bb`: **1,185 tests in 92 files**, all
27 Wrangler operator checks, package/endpoint/script/type checks, and guarded
development/staging dry builds. Architecture (528 production files, 2,071
imports, no approved debt) and all 20 documentation/preflight tests passed.
The final documentation-only receipt commit does not change that tested source.

Apply the authority check to **every** public daily/weekly, allowance and history
response, and journal policy/exclusion/source withdrawal before changing any
production read binding. Retain synchronous guards until the full replacement passes.
Legacy weekly exclusions and policy have period-specific semantics; they are
not new global v1.1 opt-outs. Their eventual split needs a separate scoped
policy fence, without owner-wide fanout or changing existing eligibility rules.

Finish the compact ingestion authority schema, production typed admission,
remaining indexed analytical read adapters, authority/receipt copy and multi-store erasure/restore. Rehearse
the complete source freeze, copy, verification and cutover before marking any
new target schema qualified. The raw-copy API alone cannot switch production.

The optional bridge layers on the old full authority schema. Fresh typed mode
refuses existing unqualified v1.1 JSON/typed history and does not import or delete
it. Its proof/membership bridge adds allocation beyond the frozen raw-storage
measurement; that overhead needs measurement and compact parent/identifier
integration before a whole-database capacity claim. The retained
source fences currently release only for explicit owner erasure; a separately
acknowledged source-retirement protocol must precede routine copy retirement.
Analytics retirement receipts also do not by themselves complete the existing
independent deletion-ledger workflow. One narrow live-path correction replaces
trigger-inflated `meta.changes === 1` with exact enrollment `RETURNING` evidence
when acknowledging accountless revocation.

Implementation is published as draft [PR #124](https://github.com/adamallcock/tibotattle/pull/124),
stacked on #123. Publication of source does not qualify a database or deployment.
