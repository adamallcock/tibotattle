---
title: Disabled staging readiness boundary
date: 2026-08-04
type: decision-record
status: static-only-unprovisioned
---

# Disabled staging readiness boundary

Decision: keep hosted staging owner-only, disabled, and unprovisioned until an
owner reviews the live Cloudflare account and supplies an exact staging target.
This worktree does not invent a staging host and does not claim that any
remote migration is applied.

## Static configuration proof

The local configuration check is evidence about checked-in files only:

```sh
npm --prefix apps/worker run staging:check
```

The staging gate requires the exact staging Worker/database/bucket names,
`workers_dev: true`, no staging routes or `PUBLIC_ORIGIN`, disabled enrollment
and ingestion variables, contained collection controls, and the exact local
migration inventory. The primary D1 inventory is 0001–0028, including the
reviewed identity-protection tail:

- `0023_community_aggregate_safety.sql`
- `0024_apple_signin_nonce_binding.sql`
- `0025_device_lifecycle.sql`
- `0026_signin_start_admission.sql`
- `0027_identity_reenrollment_cooldown_guard.sql`
- `0028_identity_link_secret_configuration.sql`

The deletion ledger inventory is `0001_deletion_tombstones.sql` and
`0002_identity_reenrollment_cooldown.sql`. Any missing, extra, malformed,
production-named, or otherwise unreviewed target fails closed with a fixed
blocker. Static output has `liveProof: false` and must not be described as a
remote readiness or migration result.

## Live read-only proof

Only an owner-authorized rehearsal may run:

```sh
npm --prefix apps/worker run staging:ready
```

The live probe uses Wrangler metadata operations without reading or printing
credential values, plus the read-only SQL query
`SELECT name FROM d1_migrations ORDER BY id`. It does not use Wrangler's
`d1 migrations list` command, because that command can initialize the migration
table. A newly created D1 without that table is reported as uninitialized, not
as current. A
current result requires the remote applied-name sequence to match the
checked-in inventory for both D1 bindings, including the identity-link secret
configuration and re-enrollment-cooldown protections, followed by the existing
schema and containment checks. Live output has `liveProof: true`, but it
remains a readiness observation rather than authorization to collect data.

## Explicit mutation gate

The pre-migration compatibility deploy is the only Worker deploy before schema
mutation. It performs local checks, then the existing Wrangler deploy, and
does not create live-proof evidence:

```sh
npm --prefix apps/worker run staging:deploy -- \
  --origin https://EXACT-STAGING-HOST-SUPPLIED-BY-OWNER \
  --phase pre_migration_compatibility \
  --identity-receipt-file /owner-only/staging-deployment-identity.json \
  --confirm DEPLOY_COMPATIBLE_DISABLED_STAGING
```

The owner must observe the active disabled revision and create the bounded
local proof receipt. Only then can preparation reach remote containment or
migration mutation, and it requires the exact confirmation plus that receipt:

```sh
npm --prefix apps/worker run staging:prepare -- \
  --origin https://EXACT-STAGING-HOST-SUPPLIED-BY-OWNER \
  --receipt-file /owner-only/staging-disabled-worker-proof.json \
  --identity-receipt-file /owner-only/staging-deployment-identity.json \
  --confirm PREPARE_DISABLED_STAGING
```

Preparation refuses absent, stale, malformed, open, or mismatched compatible
Worker proof before migration. It also refuses unsafe configuration, missing
resources, remote migration inventory drift, and unverified migration
application. On a fresh D1, the
preparation refuses to run any migration command when both D1 migration ledgers
are uninitialized and `collection_controls` is absent. Wrangler applies the
whole pending migration chain, and migration `0009_collection_controls.sql`
creates an operational row, so containment cannot safely be established after
that command. The failure is
`STAGING_FRESH_BOOTSTRAP_REQUIRES_OWNER_CONTAINMENT`, with no operation receipt
or operational claim.

Fresh bootstrap therefore has an owner-only external prerequisite: the owner
must use a separately reviewed Cloudflare D1 bootstrap protocol that establishes
the exact staging migration state and a verified `collection_controls` row in
the `contained` state before any arbitrary pending migration chain is run. That
protocol is intentionally not invented in this worktree because it would need
to coordinate D1 migration bookkeeping with the pre-control schema safely. The
owner must re-run `npm --prefix apps/worker run staging:ready` and confirm live
`collectionControlState: "contained"` before retrying preparation. If that
protocol is unavailable, staging remains blocked.

For an already-initialized but uncontained target, preparation still issues the
containment update and verifies live containment before applying either
migration stream. Once all migrations and schema protections are verified, its
receipt is fixed-shape, content-free, and always records
`collectionAuthorized: false` and `activationState: not_authorized`.

The identity-link secret configuration proof uses semantic PRAGMA and
`sqlite_master` evidence rather than comparing the serialized full DDL. It
requires the exact four-column shape, singleton primary key, required
non-null/type invariants, SQLite `STRICT`, exactly the three expected CHECK
clauses (including the singleton, key-version, and lowercase fingerprint
constraints), and no table-bound extra indexes, triggers, or foreign keys. This
tolerates harmless SQLite layout serialization differences while blocking
altered or extra schema evidence. Any mismatch blocks readiness.

No production custom domain, production resource identifier, arbitrary origin,
or unreviewed Workers host is a staging proof. Deployment/rehearsal may only
continue after the owner supplies and reviews the exact staging origin in its
separate deployment lane; this record does not assert that origin or report a
deployment.
