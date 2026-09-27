---
title: PostgreSQL owner-erasure fence source review
date: 2026-09-27
type: review
status: snapshot
---

# PostgreSQL owner-erasure fence source review

**Status:** no-go for writing a `0053` erasure fence or payload receipt from
the current PostgreSQL social-erasure terminal. Reviewed source is commit
`4b865e9c8246da9eaed84c59b3b3a6305bc80f36` on
`codex/gcp-erasure-fence-writer`. The current owner-erasure proof does not
contain the exact source journal tuple that the fence must retain. Do not
derive a synthetic terminal from the owner digest, current state, or wall-clock
time, and do not mark the `0053` receipt complete from the existing owner
receipt.

## Required terminal evidence

The D1 implementation obtains its terminal from the exact source event. It
joins the erased owner revision to an `owner-erased` change and uses that
change's sequence (`apps/worker/src/storage-erasure.ts:111-118`). Its terminal
validator requires the closed event shape, matching source and owner, event
digest, sequence, revision, authority epoch, and public authority epoch
(`apps/worker/src/storage-erasure.ts:95-103`). The fence is then bound to those
values (`apps/worker/src/storage-erasure.ts:128-141`). D1 inserts the payload
receipt only after retirement and a complete payload-absence predicate, then
reads it back before completing the independent job
(`apps/worker/src/storage-erasure.ts:67-93, 142-163`).

Staged PostgreSQL migration `0053` has the same seven-part fence tuple:
`source_id`, `owner_digest`, `terminal_event_digest`, `terminal_sequence`,
`terminal_revision`, `authority_epoch`, and `public_authority_epoch`. Its
receipt is keyed by source and owner and references the fence
(`apps/worker/postgres/staged-migrations/primary/0053_community_publication_authority.sql:187-210`).
The guards make fence values immutable and receipts append-only
(`apps/worker/postgres/staged-migrations/primary/0053_community_publication_authority.sql:212-241`); a fence also advances
the source containment watermark in the same transaction
(`apps/worker/postgres/staged-migrations/primary/0053_community_publication_authority.sql:257-314`). Those constraints
preserve supplied values. They do not prove that the values came from the
owner's source terminal or that owner payload is absent.

## PostgreSQL gap

The social eraser's first transaction marks the participant `deleting` and
revokes credentials, but does not append an owner event
(`apps/worker/src/postgres-social-owner-erasure.ts:270-400`). Its primary delete
transaction changes `storage_v11_owner_links.state` to `erased`, deletes source
rows, and reads back only the owner digest from
`storage_owner_erasure_receipts`
(`apps/worker/src/postgres-social-owner-erasure.ts:535-566`). The receipt
schema itself contains only `owner_digest` and `recorded_at`; its trigger
creates that pair on the owner-link state transition
(`apps/worker/postgres/migrations/primary/0029_legacy_source_membership.sql:125-167`).
It has no source, event digest, sequence, revision, or authority epochs.

The later analytics retirement marks `analytics_owner_state` erased and
recreates publication invalidations, but does not append an `owner-erased`
source change (`apps/worker/src/postgres-analytics-owner-retirement.ts:521-545`).
Its caught-up check compares the existing maximum journal sequence with the
cursor and verifies the last applied row; it does not establish that this row
is the owner's erasure terminal
(`apps/worker/src/postgres-analytics-owner-retirement.ts:308-381`).

PostgreSQL does have a single journal append procedure that can derive the
next sequence, revision, authority epoch, and public epoch from locked source
state (`apps/worker/postgres/migrations/primary/0046_owner_journal_authority.sql:348-420`).
However, the caller must supply event, object, and content digests already
proved by that caller; this is explicit in the journal facade
(`apps/worker/src/postgres-owner-journal.ts:171-203`). The social eraser has no
canonical source for an erasure event digest or a rule proving the terminal
object/content digests. Adding a call with invented or reused values would
create a plausible-looking but ungrounded event. Appending after the current
caught-up check would also leave the analytics cursor behind; the present
retirement path has no apply-and-contain step for that new terminal.

The existing PostgreSQL 17 social-erasure fixture demonstrates the gap: it
seeds an active analytics owner and result without an ingestion change
(`apps/worker/postgres-test/postgres-social-owner-erasure.spec.mjs:134-150`),
then expects erasure to complete and verifies the owner state and old receipt
(`apps/worker/postgres-test/postgres-social-owner-erasure.spec.mjs:295-310`). That proves the current
owner-erasure workflow can finish without an exact `owner-erased` event. It
does not qualify a `0053` fence or payload receipt.

## Decision and next gate

Do not add a fence writer to this path yet. A safe implementation first needs
an accepted source contract for a canonical `owner-erased` event and its three
digests, an ordering that applies that event and advances the analytics cursor,
and a publication-retirement proof tied to its public authority epoch. Then the
fence writer can read back the exact retained event, refuse any immutable
conflict, and insert a receipt only after owner payload absence is established
under the appropriate source and publication locks.

The accountless PostgreSQL eraser has the same gap: it sets the owner link to
`erased` and verifies only the two-column owner receipt before completion
(`apps/worker/src/postgres-accountless-owner-erasure.ts:751-792`). This review
does not change or qualify that path. GCP owner-action routing and operational
activation also remain outside this source slice.
