---
title: Cloudflare production source schema inventory for GCP transfer
date: 2026-09-27
type: receipt
status: snapshot
---

# Cloudflare production source schema inventory for GCP transfer

This is a metadata-only read of the configured production D1 bindings and R2
bucket listing on 2026-09-27 EDT. It establishes the deployed source layout at
that instant. It is not a source fence, snapshot, export, row count, import,
application-route test, or production migration authorization. No user rows or
R2 objects were read or changed.

A previously stored Cloudflare token was injected from macOS Keychain into the
read-only Wrangler child process. The token value and account details were not
printed or saved. The unaided Wrangler CLI had no usable authentication in this
checkout; the injected credential successfully read the exact configured
production D1 database metadata.

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
- The `app-usagemonitor`-named D1 inventory lists the configured production
  and staging primary and deletion-ledger databases, with no separately named
  storage-ingestion D1 database in that filtered listing.
- The production `DELETION_LEDGER` D1 binding has latest migration
  `0003_storage_erasure_jobs.sql`. Its table list includes
  `deletion_tombstones`, `identity_reenrollment_cooldowns`, and
  `storage_erasure_jobs`.
- Metadata-only R2 bucket inventory confirms that the configured production
  quarantine and release-update buckets exist. No object listing or content
  read was performed.

## Transfer implication

The current PostgreSQL social v0.2 receipt importer can be validated against a
synthetic sealed source, but its proposed D1 0002
`storage_legacy_event_sources` source table is not present in this deployed
primary D1 layout. Real transfer requires either a separately reviewed source
migration/bridge and its authority proof, or a reviewed extraction from the
actual legacy tables. The same source inventory cannot establish whether an
individual has v1.2 data; it only establishes that the named v1.2 tables are
absent from this database. Do not promote local transfer tests to live source
reconciliation.

## Reproduction boundary

Read-only `wrangler d1 info` matched the configured primary database identity.
`wrangler d1 execute --env production --remote --command` then queried only
`sqlite_master` table names and the latest `d1_migrations.name` on each named
binding. `wrangler d1 list` and `wrangler r2 bucket list` were metadata-only.
Future inventory must re-read source state because this receipt is not a durable
source snapshot or write fence.
