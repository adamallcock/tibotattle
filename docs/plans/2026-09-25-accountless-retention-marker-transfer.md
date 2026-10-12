---
title: Transfer opted-out accountless public-history retention markers
date: 2026-09-25
type: plan
status: in-progress
---

# Transfer opted-out accountless public-history retention markers

## Status and boundary

This is an implementation design, not a transfer receipt, migration approval, or
cutover proof. No source data, PostgreSQL schema, Cloud Run service, or GCP
resource has been changed for this plan. The marker carries no telemetry, but
its opaque participant, device, generation, and credential-hash evidence is
private authority data; keep snapshots, row manifests, and diagnostics private.

The source-side implementation is now present locally in Worker migration 0063
and `apps/worker/src/accountless-retention-transfer-source.ts`. Synthetic D1
coverage exercises one real opt-out marker through capture, keyset extraction,
and invalidation on owner erasure. The PostgreSQL permit/import path, source to
target identity mapping, final reconciliation, and any cutover remain unbuilt.

The current D1 contract is prospective. Migration 0061 pins the exact accepted
v1.1 head during ordinary `user_opt_out`; ingestion isolation migration 0005
then permits only that retained source tuple through the public-owner view.
PostgreSQL migration 0041 has the same prospective intent: its insertion guard
requires active authority, and it has no historical backfill. Existing opted
out owners therefore remain excluded from PostgreSQL until their original D1
marker is transferred with its proof. Never manufacture that proof from a
current PostgreSQL head.

This lane transfers retention metadata only. It does not copy telemetry,
create enrollment or owner authority, restore upload permission, or carry v1.2
data.

Since D1 isolation migration 0011 an ordinary opt-out may pin an accepted
v1.2 head for a device with no v1.1 domain. Migration 0063 alone proved every
marker through the v1.1 grant, head and domain, so one such marker made every
capture refuse with `SOURCE_MARKER_INELIGIBLE`. Isolation migration 0014 now
re-creates the candidate view with a separate v1.2 lineage, proved like 0011's
retained v1.2 public-source branch (revoked successor grant, the device's v1.2
head and domain, no v1.1 domain), and adds v1.2 invalidation triggers. A v1.2
row keeps the same columns; its `grant_*` fields carry the successor grant, so
`grant_telemetry_schema_version` names the lineage. The PostgreSQL importer
does not yet prove that lineage and refuses such a row by name
(`ACCOUNTLESS_RETENTION_SUCCESSOR_MARKER_UNSUPPORTED`), stopping the whole run.
Until a reviewed successor import path exists, any D1 v1.2-only opt-out
therefore blocks the import and cutover. PostgreSQL migration 0045 separately
lets a PostgreSQL opt-out retain an eligible v1.2 head prospectively; it does
not admit imported v1.2 markers.

## Source contract to preserve

For each D1 marker, preserve this exact six-field tuple:

`participant_id, enrollment_device_id, device_credential_id, generation_id,
head_revision, retained_at`.

Bind it to the source-side proof fields used by the final D1 eligible-owner
predicate: participant state and owner kind; owner, enrollment ledger, device,
and v1.1 grant identity and revocation state; opt-out reason and equal
revocation instants; enrollment, policy, authorization-basis, telemetry schema,
field-dictionary, and privacy-contract versions; all four equal expiries;
device-to-ledger identity and secret-hash equality; and the exact head
generation/revision and domain participant/device link. The marker itself is
not sufficient evidence of current eligibility.

Retain the existing exact D1 rules:

- The participant remains active and accountless.
- Ledger, owner, grant, and device are all revoked for `user_opt_out`, with
  each `revoked_at` equal to `retained_at`.
- The v1.1 head still matches the marker's `generation_id` and
  `head_revision`; the domain belongs to that participant and device.
- Version, expiry, device, enrollment, and secret-hash relations match exactly.
  Compare hashes as bytes and never place their values in receipts or logs.
- A v1.2 marker is captured with its own successor proof (isolation 0014) and
  is never relabelled as, or imported into, v1.1 retained history.

Map source identities to PostgreSQL identities with an explicit one-to-one
mapping manifest. Do not infer an ID, head, revision, version, expiry, or hash
when either side is missing. Preserve D1's timestamp instant exactly at its
stored precision; reject non-canonical or lossy timestamp conversions.

## Source-sealed snapshot

The existing generic transfer code correctly warns that independently paged
live D1 reads do not form a consistent snapshot. A production marker transfer
must therefore consume an immutable source snapshot, not page directly from a
live D1 binding.

Add a source-side export/fence step after D1 migration 0061. It must capture,
from one consistent D1 state, the marker rows and every field needed to
re-evaluate the eligibility predicate above. Use a supported consistent
database export or an immutable D1-side snapshot materialization created under
a transaction and a narrow retention-authority mutation fence. The fence must
cover marker, participant, owner, enrollment ledger, device, v1.1 grant, domain,
and head changes that can alter this predicate. Record the source migration
receipts, snapshot ID/time, source revision or fence token, ordered row count,
and canonical ordered manifest digest. If the export path cannot prove a
single state or the fence/revision changes while pages are read, discard the
artifact and restart; do not call a before/after hash alone a snapshot.

### Verified D1 mechanism and current source implementation

The canonical D1 chain now includes `0062_v1_acquisition_vocabulary.sql`, so
the source-transfer objects are installed by forward-only migration
`0063_accountless_history_transfer_source.sql`. The capture path uses a single
Worker `D1Database.batch()` transaction to read the authority revision, count
all markers and ineligible proofs, record the exact source migration receipts,
and materialize eligible marker-plus-proof rows. Cloudflare documents D1 batch
statements as sequential, non-concurrent, and atomic: if a statement fails, the
batch is rolled back. That supports one consistent materialization on the
source database. [D1 Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/)

The snapshot module reads only that immutable materialization, in binary
participant-key order and pages of at most 500 rows. It persists per-row hashes,
page hashes, and an ordered manifest chain. Source triggers advance a
revision and invalidate the run when any marker is added or removed, or when a
participant, owner, enrollment ledger, device, v1.1 grant, head, or domain row
that can change an eligible marker is mutated. Invalidated or aborted runs
automatically purge copied proof fields, identifiers, page cursors, digests,
and migration receipts while retaining a count-only disposition. The code has
no HTTP route; rows and hashes are returned only to its privileged caller and
must not enter logs or ordinary job output.

D1 Sessions provide sequential consistency, not a frozen read transaction, so
they are not a substitute for the materialized snapshot. The database `dump()`
API remains legacy-alpha-only. Remote SQL export supports a bookmark-pinned
full-database export, but it is a broader data artifact than this marker-only
transfer needs. [D1 consistency and export guidance](https://developers.cloudflare.com/d1/best-practices/import-export-data/),
[D1 export API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/)

This mechanism proves that the captured D1 rows belonged to one source state
and that relevant source mutations invalidate the receipt. It cannot keep a
D1 transaction or write fence open across PostgreSQL import and reconciliation.
An importer must recheck the live source revision at its checkpoints and must
still perform the final exact reconciliation under a fenced cursor or complete
source change journal. A source mutation after an earlier target page was
committed requires target-side terminal withdrawal/reconciliation; it cannot
be made atomic by D1 alone. A still-valid extracted artifact remains private
until the importer and final cutover workflow provide a verified release point.

After extraction, page only from that immutable artifact, in key order and
bounded batches (default 200, hard maximum 500 rows, matching the existing
typed-transfer bounds). Hash each canonical page and the complete ordered
manifest. Keep the artifact and per-row hashes in private storage; public job
output reports counts and opaque status codes only. Before final cutover, hold
the same narrow source fence through exact set reconciliation, or consume a
complete source change/tombstone journal through a final fenced cursor. Any
unreconciled source change invalidates the transfer receipt.

## PostgreSQL import permit and ordering

Do not loosen or disable migration 0041's trigger. Add a forward migration
0042 (or the next unused primary version) that creates a dedicated,
append-only retention-import run and per-owner claim ledger, and extends the
0041 insert-guard function with a second, narrowly validated import path.
The existing active-source insert path stays unchanged. The import path may
insert a marker only when all of the following hold in the same PostgreSQL
transaction:

1. The permit names the exact target schema, source snapshot ID and digest,
   source migration receipts, primary target migration receipt, row count, and
   ordered manifest digest.
2. A one-time per-owner claim matches every marker tuple field and its
   source-to-target identity mapping. The claim is unconsumed and belongs to
   the open import run.
3. The already-transferred PostgreSQL participant, owner, ledger, device,
   grant, v1.1 domain, and head satisfy the revoked-user-opt-out predicate,
   exact version/expiry/hash parity, and exact marker head. The marker import
   does not create or repair these rows.
4. Marker insertion, claim consumption, page checkpoint, and page receipt
   commit atomically. The trigger remains active; arbitrary direct inserts,
   an expired/closed permit, another schema, another snapshot, or a changed
   tuple are rejected.

Seal the run before loading: bind its identity to a fresh source artifact and
target migration receipt. Use a unique transfer ID and advisory lock. Replay
with the same transfer ID and byte-identical snapshot is idempotent: compare
every existing marker field and return the existing completed receipt. Reuse
with a different snapshot, manifest, target schema, mapping, or row is a hard
conflict. A completed or aborted permit cannot be reopened. Keep checkpoints
and page digests in the same transaction as marker rows so interrupted bounded
loads resume without duplicate authority or skipped pages.

Schema and code order:

1. Qualify current primary migration 0041 and its canonical manifest locally.
2. Add a source-side, forward-only snapshot/fence mechanism after the current
   D1 migration 0062, with focused D1 tests. Migration 0063 now implements this
   source half; the importer and final fence/reconciliation are still required.
3. Add PostgreSQL migration 0042 after 0041 for the import permit, claims, and
   guarded trigger extension; regenerate the canonical runtime schema and
   update migration gates through their generators.
4. Implement a private importer that accepts only the sealed artifact and
   exact target schema, then add PG17 integration tests.
5. Load identity, enrollment, grants, v1.1 data, and the exact head/domain
   first using the existing transfer lanes. Import markers last.
6. Compare source and target eligible sets under the final fence. Only then
   can a separate cutover review consider enabling the PostgreSQL reader.

If the current A2 image qualifies migration 0041 before step 3 is deployed,
make no direct A2 marker writes. Locally, the export parser, synthetic fixture,
and PG17 permit tests can proceed after 0041. A2 remains unchanged until a
source-pinned image containing the forward permit migration and importer is
qualified and separately authorized. Do not hand-edit A2 migration receipts or
generated schema output.

## Reset, containment, and failure behavior

Ordinary user opt-out retains the exact v1.1 marker and historical head while
future uploads stay revoked. Security reset, operator containment, owner
erasure, participant/head removal, or any non-opt-out authority change is
terminal: D1 must withdraw the source and remove the retention marker under its
existing lifecycle rules. The importer must not translate those states into
retained history.

A source terminal change before import invalidates the snapshot or appears as
a terminal tombstone in the fenced delta; abort that run and do not insert the
marker. If terminal change is discovered after an imported marker exists, the
PostgreSQL lifecycle must delete/retire that marker and withdraw the owner link
in the same transaction. Record the terminal disposition in the private
transfer receipt so a retry cannot resurrect it. An identity mismatch,
missing head, version drift, expiry/hash mismatch, malformed source marker,
unknown status, changed snapshot, or partial page rolls back that page and
leaves the run incomplete. Recovery resumes only from a verified checkpoint;
otherwise abort the run and start a new snapshot/permit.

Do not preserve a D1 marker that is no longer eligible as a public owner merely
because it remains in a damaged or inconsistent source table. Treat such a
row as an integrity mismatch and refuse the run for review; never silently
skip it or convert unknown eligibility into false.

## Reconciliation and cutover refusal

The source snapshot must produce an exact, sorted set and counts for:
all marker rows, rows satisfying the final D1 retained-source predicate,
invalid/inconsistent markers, and any terminal tombstones. The PostgreSQL
readback must compute the same set using the matching PostgreSQL eligibility
predicate and exact identity mapping.

Cutover is refused unless, at one shared source fence:

- Every D1-eligible retained owner has exactly one byte/field-equivalent
  PostgreSQL marker and eligible v1.1 source owner.
- Source and destination counts and ordered set digests match exactly.
- Unrepresented, ambiguous, mismatched, malformed, unknown, skipped, or
  uncheckpointed eligible rows are all zero; an unavailable count is a refusal,
  not zero.
- No post-snapshot source mutation, new eligible marker, terminal change, or
  transfer page remains unreconciled.
- The private daily reader's exact CTE confirms the retained source set; daily
  publication is a separate lifecycle gate and must not be inferred from
  marker parity.

If any D1-eligible owner has no exact PostgreSQL identity/head proof, or any
eligible source owner is not represented, keep Cloudflare authoritative and
refuse cutover. Do not manufacture a replacement marker from PostgreSQL state.

## Acceptance tests

The implementation is ready for review only when focused tests prove:

- A sealed source snapshot preserves exact marker tuple, participant/device
  mapping, revocation reason/time, schema and policy versions, expiry values,
  secret-hash equality, and generation/revision; content and hashes remain
  absent from ordinary logs/receipts.
- Mutation of a fenced authority row during extraction invalidates the
  snapshot; immutable artifact reads are keyset-paged and stay within the hard
  page limit.
- A valid pre-existing D1 user-opt-out marker imports after 0041 only through a
  live exact permit and appears in the PostgreSQL retained-source CTE.
- Direct insertion for a revoked owner without a permit fails. Wrong schema,
  source digest, mapping, head, version, expiry, hash, reason, or timestamp;
  reused/closed permits; and changed replay tuples all fail closed.
- An interrupted transfer resumes from the atomically committed page
  checkpoint. Exact replay does not add markers; changed snapshot reuse is a
  conflict.
- Missing or mismatched head, malformed marker, unknown source eligibility,
  reset/containment tombstone, and target identity drift cannot create or
  restore public membership.
- A deliberate missing eligible marker, extra target marker, or changed source
  set makes the final reconciliation/cutover gate refuse.
- v1.2-only history never creates a v1.1 marker or becomes daily v1.1 data.

Until that source snapshot, forward permit, importer, and exact set comparison
exist and pass against a source-pinned candidate, historical opted-out
accountless v1.1 owners are an explicit cutover blocker. Migration 0041 and
current local tests establish prospective behavior only; they do not establish
that any historical D1 marker has been copied.
