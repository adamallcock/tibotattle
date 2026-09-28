---
title: GCP primary social identity transfer audit fixes
date: 2026-09-28
type: review
status: snapshot
---

# GCP primary social identity transfer audit fixes

This review records local, synthetic PostgreSQL 17 evidence for the audit fixes
to the [social identity transfer slice](./2026-09-27-gcp-primary-social-identity-transfer-slice.md).
It does not establish a live Cloudflare export, GCP service readiness, complete
database parity, or cutover authorization.

## Implemented safeguards

- A session advisory lock is scoped to the target schema in the current
  PostgreSQL database. A target schema and control schema must use the same
  suffix, and the durable run table has a unique target-schema index. This
  preserves a single run claim even when a source has zero rows. A different
  transfer ID or alternate control schema cannot claim the same target.
- The source must contain exactly one `identity_link_secret_configuration`
  row. The importer copies and compares `singleton`, `key_version`,
  `secret_fingerprint`, and `recorded_at`; the timestamp is compared as a UTC
  instant. An absent source pin or any pre-existing target mismatch fails
  closed. The fingerprint never appears in transfer receipts or diagnostics.
- A participant whose state is `deleting` is refused because this transfer does
  not include the erasure ledger needed to preserve its deletion guarantee.
- After hashing while copying, the importer opens SQLite from a private
  temporary snapshot in a mode-0700 directory with a mode-0400 file. Replacing
  the caller's source path afterward does not change the opened source. File
  identity is checked around the copy and again before/after scans.

The source identity pin is non-secret metadata. Transferring it does not prove
that the GCP service's configured identity-link secret has the matching version
and fingerprint. That runtime configuration must be checked separately before
identity routes open; the receipt reports that this check has not occurred.

## Temporary storage and recovery limit

The private SQLite snapshot needs temporary disk space up to the sealed source
artifact size, currently capped at 100 GB, in addition to the original file.
Normal source close removes the private directory. A process crash can leave a
randomly named directory under the operating system's temporary root. It is
restricted to the current user, but this rehearsal does not implement stale
snapshot discovery or cleanup. Inspect and remove only confirmed abandoned
`tibotattle-identity-authority-snapshot-*` directories. Use synthetic fixtures
for this rehearsal; it has not qualified private-data handling, crash recovery,
or production export operations.

## Verification

The focused check passed on 2026-09-28 with PostgreSQL 17 over the local Unix
socket at `/private/tmp/tibotattle-pg-fanout-20260926/socket`:

```sh
PG_TEST_SOCKET=/private/tmp/tibotattle-pg-fanout-20260926/socket \
PG_TEST_PORT=55433 \
node --test apps/worker/scripts/postgres-identity-authority-transfer.check.mjs
```

All 15 checks passed. The PG17 race test runs two different source snapshots
and transfer IDs against one initially empty target, including an empty data
family. Exactly one run completes and claims the target. The test also rejects
an alternate control schema. The other PG17 test covers target pin mismatches,
the `deleting` refusal, page failure and retry, consent/hash/timestamp
preservation, and idempotent retries. No live Cloudflare or GCP API was called.
