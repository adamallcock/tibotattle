---
title: Cloudflare production source schema inventory for GCP transfer
date: 2026-09-27
type: receipt
status: snapshot
---

# Cloudflare production source schema inventory for GCP transfer

This is a metadata-only read of the configured production D1 bindings, the
account-wide D1 database list, and the R2 bucket listing on 2026-09-27 EDT.
It establishes observed schema names at that instant, not which database the
live Worker currently uses. It is not a source fence, snapshot, export, row
count, import, application-route test, or production migration authorization.
No user rows or R2 objects were read or changed.

A previously stored Cloudflare token was injected from macOS Keychain into the
read-only Wrangler child process. The token value was not printed or saved.
The unaided Wrangler CLI had no usable authentication in this checkout; the
injected credential successfully read the D1 database metadata.

## Observed source layout

- The production primary D1 binding `USAGE_MONITOR_DB` resolves to the
  configured `app-usagemonitor-production` database. Its latest row in
  `d1_migrations`, ordered by migration ID, is
  `0060_public_contribution_sources.sql`.
- A `sqlite_master` table-name query found no table with a `storage_` prefix,
  including no `storage_legacy_event_sources`, in that primary D1 database.
  Separate exact queries found no `telemetry_v12%` or `accountless_v12%`
  tables. The existing table list includes legacy participants, contributions,
  telemetry v1/v1.1, controls, publication, and related state.
- The first inventory was incorrectly narrowed to `app-usagemonitor` names.
  An account-wide `wrangler d1 list` check then found separate production
  `tibotattle-production-ingestion-*` and
  `tibotattle-production-analytics-*` databases. The production ingestion
  database has `storage_ingestion_changes`, `storage_legacy_event_sources`,
  `storage_owner_revisions`, `storage_v12_event_sources`,
  `telemetry_v12_*`, and `accountless_v12_device_authorizations` tables.
  Its `d1_storage_migrations` names include
  `0012_v12_empty_day_manifests.sql`, `0061_accountless_history_retention.sql`,
  and `0062_v1_acquisition_vocabulary.sql`. The separate analytics database
  has `analytics_*` tables and its own `d1_storage_migrations` history.
- The production `DELETION_LEDGER` D1 binding has latest migration
  `0003_storage_erasure_jobs.sql`. Its table list includes
  `deletion_tombstones`, `identity_reenrollment_cooldowns`, and
  `storage_erasure_jobs`.
- Metadata-only R2 bucket inventory confirms that the configured production
  quarantine and release-update buckets exist. No object listing or content
  read was performed.

## Transfer implication

The current PostgreSQL social v0.2 receipt importer can be validated against a
synthetic sealed source. Its proposed D1 `storage_legacy_event_sources` table
exists in the separately named production ingestion database; it is absent only
from the older configured `USAGE_MONITOR_DB` binding. Real transfer still needs
proof that the live Worker uses that ingestion database, a consistent source
fence/snapshot, a reviewed exporter of the complete receipt and authority
evidence, and reconciliation with the target. Table presence alone cannot
establish whether any individual has v1.2 data or whether receipts are
complete. Do not promote local transfer tests to live source reconciliation.

## Reproduction boundary

Read-only `wrangler d1 info` matched the configured older primary database
identity. `wrangler d1 execute --env production --remote --command` queried
only `sqlite_master` table names and the latest `d1_migrations.name` on each
named older binding. An account-wide `wrangler d1 list` located the separate
ingestion and analytics databases; `d1 info` matched their listed identities,
and `d1 execute --remote --command` queried only `sqlite_master` table names,
`PRAGMA table_info(d1_storage_migrations)`, and migration names on the
ingestion database. `wrangler r2 bucket list` was metadata-only. Future
inventory must re-read source state because this receipt is not a durable
source snapshot or write fence.
