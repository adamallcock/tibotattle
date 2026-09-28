---
title: GCP test primary 46 and private backend upgrade
date: 2026-09-27
type: receipt
status: recorded
---

# GCP test primary 46 and private backend upgrade

This records a 2026-09-27 EDT change to the isolated `tibotattle` test project
in `us-east1`. The production Cloudflare service and data were not changed.
It proves a migrated, healthy IAM-private test backend; an authenticated
device journey through the public test gateway remains a separate gate.

## Source and pre-migration proof

The exact Cloud Run source context checked clean with 450 files, 46 primary
migrations, six ledger migrations, and content digest
`8c882d7a7519565cf40c078ffbe8cb4ff739912664801f00a5d2f73fb948be08`.
The previously built immutable image was
`us-east1-docker.pkg.dev/tibotattle/tibotattle-test/tibotattle-host@sha256:7913cec341f72acc6d14b9bf8520f9df58729c2f926da536096fef9405fdbc9e`.
Its source archive SHA-256 was
`aa7dd181a284593d78368aa70aa2903ac5250b390f922c5239354fe88301be00`,
create-only source generation `1790555018627958`, and successful regional
Cloud Build `92465ed3-bd1f-4220-8a8d-73771bbc91e0`. The
[test gateway receipt](./2026-09-27-gcp-test-gateway-tagged-retry.md) records
that image's public gateway deployment separately.

The migration manifest check passed. Local PostgreSQL 17 qualification passed
30/30 focused owner-journal and v1.2 owner-bridge tests, including 0046
backfill refusal for tampered history, exact journal append, concurrency,
v1.2 publication-chain membership, and owner-erasure races. The approved
static single-producer guard passed 2/2, and documentation governance and
preflight passed on integration commit `1b3ae65d` before this receipt.

Before the test write, on-demand Cloud SQL primary backup `1790560393967`
completed successfully at 2026-09-28 01:54:45 UTC. Restore was not tested.
The previous automated backup was also successful; the on-demand backup was
the recovery point for this migration.

## Test-only migration and service readback

The fixed `tibotattle-test-database-migrate` Job changed only its image to the
digest above. Readback showed generation 17 observed, the same test migrator
service account, `node dist/test-migrations.mjs`, one task, parallelism one,
zero retries, and a 300-second timeout. Execution
`tibotattle-test-database-migrate-9lh6c` succeeded. Its structured Cloud
Logging receipt reported primary **46/46**, ending at
`0046_owner_journal_authority.sql` with SHA-256
`ca26390533fdc9a053319a9e128ef94a074a44037e9e581f56b2a1f4e90be062`,
and independent erasure ledger **6/6**, ending at
`0006_erasure_ledger_transfer_receipts.sql`. The receipt included a matching
manifest digest; no private row data was read for this record.

The fixed-target private deploy guard returned `deployed` with no blockers and
then `verified` with no blockers on the same archive, build, and image. It
confirmed anonymous invocation denied. Independent Cloud Run readback showed
service `tibotattle-test-app` generation 50 observed, revision
`tibotattle-test-app-00048-99m` ready and receiving 100% of traffic under the
test runtime service account. An authenticated `/api/health` request returned
HTTP 200, `status=ready`, primary migration receipt `current` at 46, and ledger
receipt `current` at 6. It still reported `workerApplicationReady=false`.

The image deploy and database migration qualify the isolated test service's
schema and runtime pairing. They do not prove the new authenticated device
GET routes, browser OAuth sign-in, production source extraction or replay,
full application parity, or a production traffic switch. The test gateway's
anonymous route probes are recorded in its separate receipt.
