---
title: GCP primary social identity transfer slice
date: 2026-09-27
type: review
status: snapshot
---

# GCP primary social identity transfer slice

This review records one locally testable transfer family. It is not a complete
database migration, live-source export, service cutover, or production-readiness
claim.

## Source boundary

The rehearsal reads only a sealed SQLite reconstruction explicitly labeled
`USAGE_MONITOR_DB`. That label selects one source binding in the importer; it
does not prove the artifact's origin or prove a Cloudflare-wide source fence.
The source must be content-free synthetic data for local checks. No live
Cloudflare or GCP API is called.

The copied family is limited to these primary D1 social identity and device
authority tables, in foreign-key dependency order:

1. `participants`
2. `identity_reenrollment_cooldowns`
3. `enrollment_grants`
4. `web_sessions`
5. `participant_community_eligibility`
6. `device_pairings`
7. `device_credentials`
8. `upload_authorizations`
9. `device_upload_authorizations`
10. `recovery_retry_receipts`
11. `device_credential_rotations`
12. `device_pairing_events`

The importer rejects source column, nullability, primary-key, foreign-key, or
timestamp drift. It preserves consent-version strings and credential/hash BLOB
bytes. Each table is paged in binary key order and each committed page writes
its rows and checkpoint in one PostgreSQL transaction. Completion requires a
second source scan and per-table count/digest parity against a disposable
PostgreSQL 17 schema with the exact primary migration history.

The D1 cooldown table's `schema_version` must equal
`identity-reenrollment-cooldown-v0.1`. The importer maps `deleted_at` to
PostgreSQL `created_at`, and `retain_until` to `expires_at`, preserving each UTC
instant. It sets PostgreSQL `participant_id` to `NULL` because D1 intentionally
does not retain a participant association for this anti-reissue marker.
Missing cooldown tables, duplicate marker layouts, wrong marker versions, and
pre-existing rows in the target authority family fail closed.

## Explicit exclusions

- Any nonempty accountless participant, device, enrollment ledger, upload-owner,
  or v1.1 authorization state is refused. The singleton issuance counter must
  remain at its exact initial seed; this slice does not import or reset it.
- Analytics `storage_v11_owner_links`, owner-link registries, and journal-derived
  `storage_owner_revisions` are separate transfer families and are not read or
  written here.
- Deletion ledgers, telemetry/storage rows, object storage, live credentials,
  in-flight sign-in handoffs, and other D1 bindings are outside this contract.
- The source binding label is caller supplied. Production use still needs a
  separately verified D1 export, cross-binding consistency fence, complete
  dependency plan, operational rehearsal, and explicit cutover gates.

## Local verification

Run from `apps/worker`:

```sh
node --check scripts/postgres-identity-authority-transfer.mjs
node --check scripts/postgres-identity-authority-transfer.check.mjs
node --test scripts/postgres-identity-authority-transfer.check.mjs
```

The PG17 integration test runs only when `PG_TEST_SOCKET` is explicitly set to
a disposable local Unix-socket test server. It creates uniquely named target
and control schemas and removes those exact schemas after the test. The test
uses synthetic fixture values only.
