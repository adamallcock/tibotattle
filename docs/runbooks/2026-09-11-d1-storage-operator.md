---
title: Wrangler typed storage operator
date: 2026-09-11
type: runbook
status: local-implementation-only
---

## Boundary

These commands operate the new typed-storage workstream. They do not replace
the [production operations authority](production-operations.md), migrate existing
production data automatically, or certify the application cutover. Follow the
[implementation plan](../plans/2026-09-11-d1-typed-storage-isolation.md) and the
[schema boundary inventory](../research/2026-09-11-ingestion-analytics-schema-map.md).

Every database has a **9,000,000,000-byte operating budget**. The operator checks
measured bytes plus the approved migration growth allowance before admission,
and rechecks actual size afterwards. This is an operational budget, not a
Cloudflare-enforced quota or a guarantee against concurrent growth. Resource
creation, schema migration, evidence copy and runtime activation remain separate.

## Local checks

From `apps/worker`:

```sh
npm run storage:scripts:check
npm run storage:test
npm run typecheck
```

The tests use disposable local D1 databases. They exercise exact typed/legacy
record reconstruction, owner-scoped private dictionaries, replay, copy into a
nonempty namespace, atomic copy checkpoints, isolated analytics delivery and
owner-move write fences. The fresh-target composition also exercises accountless
HTTP enrollment/ownership, upload claims, typed staging and exact domain closure,
isolated analytics outage/recovery, opt-out and owner erasure. This composition
uses the optional `ingestion-bridge-migrations` and
`typed-v11-admission-migrations` after the baseline and typed layouts; it is not
the final role-specific schema accepted by the remote operator. Tests do not
qualify production HTTP admission, distributed erasure, or a full restored
analytical publication.

The source-copy fixture uses the existing full `0001`–`0060` schema and actual
credential/chunk repositories. It retains staged v1.1 records and all three
streams. A second pass compares exact records and membership; changed source
evidence refuses verification. Neither a checkpoint nor an end-of-page result
asserts that a mutable source was a consistent snapshot. The final operator must
hold the source write fence through complete copy and verification, including
authority, manifests, receipts and deletion-ledger reconciliation.

## Plan inspection

```sh
npm run storage:plan -- \
  --plan /absolute/private/storage-plan.json \
  --worker-root /absolute/checkout/apps/worker
```

This default path performs no remote operation, authentication or lock mutation.
The closed `d1-storage-plan-v1` input identifies the exact account, environment,
reviewed source commits, operation UUID, expiry, phase and target set. Its maximum
32 targets each have a role, name, binding, database ID, qualification hash and
growth budget. Creation can use a null ID only for the exact operation-specific
new name. Migration requires the ID returned by the provider; names alone never
authorize an existing database.

Role directories are:

| Role | SQL directory | Runtime purpose |
|---|---|---|
| ingestion | `typed-ingestion-migrations` | Typed evidence and ingestion-local journal; authority integration remains required |
| analytics | `analytics-migrations` | Independent delivery state; analytical projection integration remains required |
| control | `routing-migrations` | Owner placement and move catalog; never an authorization substitute |

Each directory must have source-bound `qualification.json` and
`qualification-evidence.json` generated after the reviewed source is frozen.
Qualification pins every ordered SQL file, before/after schema fingerprints and
evidence hash. These receipts must describe completed qualification; do not write
`qualified` merely because empty tables can be created. They are deliberately
absent while runtime integration is incomplete.

## Authorized execution and uncertain outcomes

Execution requires `--execute`, `--confirmation EXECUTE_REVIEWED_D1_STORAGE_PLAN`,
the exact `--approved-plan-sha256` printed for the reviewed plan, the repository
root, a private operation directory and the pinned Wrangler CLI path. The
maintainer's authorization must cover the exact environment and operation.

The operator takes the existing shared production deployment lock and writes a
durable intent before each external action. It records provider-assigned resource
IDs and schema results. An unclear response retains ownership and the journal;
it does not issue another create or migration blindly. An explicit `--resume`
reconciles exact resource identity and before/after schema receipts. Unexpected
IDs, hashes, capacity, SQL or owner state stop execution. There is no automatic
database deletion or automatic application cutover.

An expired exact plan can still reconcile observations and release ownership
after verified completion. It cannot authorize another database write. Likewise,
an unexpectedly oversized completed migration can be inspected and reported as
`completed-over-budget`; the tool refuses further migration admission rather
than hiding the bytes or making recovery impossible. The migration ledger's
own schema and attached objects are verified before receipt writes, and API
origin/environment overrides are rejected by the fixed Cloudflare transport.

To continue an expired partial operation, obtain approval for a separate
`d1-storage-approval-extension-v1` document and pass it with `--resume`,
`--extension /absolute/private/extension.json` and
`--approved-extension-sha256 <approved canonical digest>`. Its fields are
`schema`, `planSha256`, `previousExtensionSha256` (null for the first extension),
`approvedAt` and `expiresAt`. The renewed window is at most 24 hours. Each
extension links to the previous approved digest and stays in the original
journal; it cannot change the operation, owner, source, target IDs or schemas.
The tool reconciles a pending effect before issuing further writes. Replaying
an old extension does not reset its deadline, and renewal never reacquires a
missing lock. No extension is generated or approved automatically.

Provision replacement ingestion and analytics separately. Keep the original
full database and independent deletion ledger. Activate the new binding only
after complete preservation, public withdrawal fences, retry/erasure tests and
the live canary are proven. Later ingestion shards need stable owner placement
and fenced whole-owner moves; filling a database does not authorize redirecting
individual records to the next one.
