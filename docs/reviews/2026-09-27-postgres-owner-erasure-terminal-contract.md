---
title: PostgreSQL owner-erasure terminal contract review
date: 2026-09-27
type: review
status: snapshot
source_commit: c3749d4b5656a057384fa39d3ce6debec68bc450
---

# PostgreSQL owner-erasure terminal contract review

**Decision:** no-go for adding a PostgreSQL `owner-erased` writer or `0053`
fence/receipt writer to the current social or accountless erasers. D1 has an
exact source recipe, but PG permits owner links without a journal head, lacks
an immutable independent-ledger terminal tuple, and blocks retirement until
the analytics cursor catches up.

**Reviewed:** commit `c3749d4b5656a057384fa39d3ce6debec68bc450`, 2026-09-27.

## D1 source contract

D1 keeps the latest published source identity on the opaque owner link: v1.1
stores the event digest as `object_digest` and manifest digest as
`content_digest`; typed v1 stores the event digest and chunk digest
(`apps/worker/ingestion-bridge-migrations/0001_v11_delivery_bridge.sql:37-45,
65-69`; `apps/worker/typed-v1-admission-migrations/0001_typed_v1_chunk_admission.sql:120-129`).

The participant `BEFORE DELETE` trigger sets the link to `erased`; the terminal
trigger appends a fresh `lower(hex(randomblob(32)))` event digest with the
link's last `object_digest` and `manifest_digest`. It advances owner revision,
owner epoch, and source epoch by one. Sequence is assigned by the journal's
integer primary key. Validation and commit triggers enforce those revisions
and epochs and make the terminal state/source epoch update part of the same D1
transaction (`apps/worker/ingestion-bridge-migrations/0001_v11_delivery_bridge.sql:85-96,
135-136`; `apps/worker/typed-ingestion-migrations/0002_delivery_journal.sql:18-30,
33-63`).

The D1 erasure worker reads and validates that exact terminal; it does not
create one (`apps/worker/src/storage-erasure.ts:95-118`). A pending independent
job exists before participant deletion; afterward the worker saves the exact
terminal JSON once and reads it back (`apps/worker/src/storage-erasure.ts:36-51,
119-127`; `apps/worker/deletion-ledger-migrations/0003_storage_erasure_jobs.sql:14-18`).
Ordered analytics delivery requires a contiguous next sequence and records the
exact applied event with its projection (`apps/worker/src/analytics-delivery.ts:132-159,
193-212`). Erasure advances independently of that cursor, writes a fence from
the exact terminal, and adds its payload receipt only after bounded retirement
and payload-absence readback (`apps/worker/src/storage-erasure.ts:67-93,
128-163, 165-179`). This contains a terminal without skipping or falsely
acknowledging the ordered journal.

## PostgreSQL gap

PostgreSQL `0046` derives sequence, revision, epochs, and time in
`storage_journal_append`, but requires caller-supplied event/object/content
digests. It refuses `owner-erased` when no owner head exists and refuses any
append after the head is erased (`apps/worker/postgres/migrations/primary/0046_owner_journal_authority.sql:348-420`).
For an owner with an exact prior journal head, its object/content tuple is a
possible source for the terminal; a fresh random event digest follows D1's
recipe. But this is not true for every current owner link.

`storage_owner_link_ensure` can mint a link without a journal head, and the
link's object/manifest digests are nullable (`apps/worker/postgres/migrations/primary/0046_owner_journal_authority.sql:425-454`;
`apps/worker/postgres/migrations/primary/0009_owner_scoped_analytics.sql:5-13`).
The PG17 social-erasure fixture has analytics owner state/results but no source
journal event, yet expects erasure completion
(`apps/worker/postgres-test/postgres-social-owner-erasure.spec.mjs:134-150,
295-310`). There is no source tuple from which to create a valid `owner-erased`
event in that case; the append function must refuse rather than synthesize one.

The social and accountless erasers set the link to erased, delete source rows,
then read only the owner digest from `storage_owner_erasure_receipts`
(`apps/worker/src/postgres-social-owner-erasure.ts:535-566`;
`apps/worker/src/postgres-accountless-owner-erasure.ts:751-792`). That receipt
has only owner digest and timestamp (`apps/worker/postgres/migrations/primary/0029_legacy_source_membership.sql:125-167`).
The independent operation receipt records phase, owner digest, object count,
and cooldown status, not the exact journal tuple
(`apps/worker/src/postgres-social-owner-erasure.ts:98-119, 160-197`). Neither
is a replayable source terminal.

PG publication invalidation and retirement exist, but do not write the terminal
or a `0053` payload receipt. The erased-link trigger invalidates publication
members (`apps/worker/postgres/migrations/primary/0032_analytics_publication_fences.sql:74-97`);
retirement marks owner state erased and removes derived rows
(`apps/worker/src/postgres-analytics-owner-retirement.ts:521-545, 568-650`).
Before that, its gate requires cursor = journal maximum and an exact last
applied tuple (`apps/worker/src/postgres-analytics-owner-retirement.ts:308-381`).
Appending a terminal during the current delete leaves the cursor behind, with
no eraser step to apply and advance it.

Staged `0053` stores the seven-field fence and a keyed payload receipt; its
guards preserve supplied values and fence insertion advances a watermark
(`apps/worker/postgres/staged-migrations/primary/0053_community_publication_authority.sql:187-241,
257-314`). They do not prove journal provenance or payload absence. A writer
must verify the exact journal row and immutable readback; the payload receipt
must remain absent until all owner payload and stale-publication checks pass.

## Safe implementation order

1. Define which erasure-eligible owner links require source terminals. A
   headless owner must remain incomplete for `0053`; do not create a synthetic
   `owner-active` or `owner-erased` event to manufacture a head.
2. With a reviewed lock order across participant, owner link, source, cursor,
   analytics owner, and terminal watermark, append the terminal while the
   source head is active/withdrawn. Use its exact latest object/content tuple,
   a fresh random event digest, `storage_journal_append`, and exact row readback
   before changing the owner link or deleting source rows.
3. Persist the full tuple immutably in the independent ledger and define retry
   and restore behavior. A missing or conflicting tuple must leave erasure
   incomplete.
4. Apply the terminal in sequence and retain its exact analytics receipt.
   Retirement stays blocked until cursor and source head agree on that tuple.
5. Insert/read back the `0053` fence; retire owner payload, stale publication
   generations, and derived caches under publication locks; prove absence;
   then insert/read back the payload receipt and complete the ledger.

Focused PG17 tests should cover source-head derivation, headless refusal,
rollback on append/readback failure, cursor-behind refusal and ordered apply,
exact/idempotent fence versus conflict, publication invalidation, and receipt
absence while payload remains. Social and accountless tests must both cover
these cases; tests must not fabricate a journal terminal.

## Scope boundary

The reviewed PostgreSQL erasure path has no `0057` migration. Later integration
stages `0058` while `0057` is absent; this review does not claim behavior for
that later migration. Canonical D1 `0057_accountless_enrollment_ledger.sql` is
explicitly enrollment-only and creates no participant, owner link, upload
authority, or community eligibility (`apps/worker/migrations/0057_accountless_enrollment_ledger.sql:3-10`).
It supplies no terminal evidence. Accountless terminal qualification depends
on the ownership/source contract and must use the same proof as social
erasure. GCP routing and activation are outside this review.
