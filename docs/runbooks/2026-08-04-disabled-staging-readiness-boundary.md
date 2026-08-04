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

Preparation is the only migration/containment mutation in this boundary and
requires the exact confirmation before any Wrangler command:

```sh
npm --prefix apps/worker run staging:prepare -- \
  --confirm PREPARE_DISABLED_STAGING
```

Preparation refuses unsafe configuration, missing resources, remote migration
inventory drift, and unverified migration application. On a fresh D1, the
explicitly confirmed migration apply may create the migration ledger; the
preparation then proves the exact remote inventory again before issuing the
containment update and rechecks containment. Its receipt is fixed-shape,
content-free, and always records `collectionAuthorized: false` and
`activationState: not_authorized`.

No production custom domain, production resource identifier, arbitrary origin,
or unreviewed Workers host is a staging proof. Deployment/rehearsal may only
continue after the owner supplies and reviews the exact staging origin in its
separate deployment lane; this record does not assert that origin or report a
deployment.
