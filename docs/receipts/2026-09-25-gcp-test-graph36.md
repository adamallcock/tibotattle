---
title: GCP private test migration 36 and v1.2 journey
date: 2026-09-25
type: receipt
status: snapshot
---

# GCP private test migration 36 and v1.2 journey

This is a 2026-09-25 receipt for the named `tibotattle` **test** project in
`us-east1`. It proves a limited IAM-private application journey and a forward
database migration. It does not qualify production routing, full route parity,
source transfer, graph throughput, or owner erasure.

## Source and database

- Integration branch `codex/gcp-cutover-integration-20260924` included the
  streamed PostgreSQL graph publisher and migration
  `0036_streamed_publication_proofs.sql` at commit `2a2292e8`.
- The Cloud Run source archive had content digest
  `82f3c4b3cce8ff10921b03e6d729fc510c9999f8a2eabdca7e7d6ad6fd1e545e`,
  archive SHA-256
  `ea02d6e648463b9d7ae8281f14359697024e5d81882b5b50515d8c51e7c4ead3`,
  and create-only GCS generation `1790325034855533`. Regional Build
  `35c1b11d-7bea-4668-ba5a-adea40f1c36e` succeeded and returned image
  `sha256:aa512247592a44dcf376b6612b2fa13551374aa7ff838b6ca7d25ba49dd2094e`.
- The primary test Cloud SQL PostgreSQL 17 instance had a successful on-demand
  backup `1790325203645` before the migration. Execution
  `tibotattle-test-database-migrate-f8cfj` completed. Its structured receipt
  read back **36/36** primary migrations, ending at migration 0036 with checksum
  `136645a7a262d756813c43f305930c8cf5435ab5415ef8bad3c38a6c3e07dee8`,
  and **6/6** separate ledger migrations.

## Hosted behavior

- The source-provenance deploy and an independent verification passed for the
  IAM-private `tibotattle-test-app` service at the image above. An anonymous
  request was denied.
- Synthetic execution `tibotattle-v12-smoke-hjjzz` completed against that
  image. Its content-free receipt reports staged and exactly replayed v1.2
  manifest and encrypted chunk, activated and exactly replayed domain,
  `postgresReadback=true`, `effectiveRecordReadback=true`, and
  `gcsReadback=true`. Publication was withheld by the verified degraded test
  controls. This is real test-project PostgreSQL and GCS read-back, not a
  production traffic test.
- Read-only discovery execution `tibotattle-v12-synthetic-discovery-d96v2`
  returned `ready`: four tagged synthetic owners, four referenced GCS objects,
  four registered pending references, and zero unattributable pending
  references. It did not delete anything.
- Test Scheduler job `tibotattle-test-maintenance-hourly` was confirmed
  `PAUSED`. The old test ledger's 15 unproven completion rows had previously
  been reopened as pending/unverified under an exact-source guarded Job; no
  erasure completion receipt was created. The current test bucket has no
  provable birth-to-present soft-delete history, so an exact-owner cleanup Job
  must not be run with an invented bucket-history proof.

## Local validation and remaining gate

Cloud Run checks, Worker typecheck, architecture and documentation preflight,
the complete Worker product gate, PostgreSQL 17 private-host HTTP tests
(15/15), and the focused graph cohort Vitest test (3/3) passed on this
integration revision. The local 1,025-member graph regression covers bounded
streaming, rollback, replay and tamper refusal; it is not a matched hosted
Cloudflare-versus-GCP benchmark.

**Production cutover remains no-go.** A frozen, reconciled transfer of active
D1/R2/ledger and legacy lineage, complete application and scheduled paths,
public/admin ingress qualification, graph workload benchmark, restore and
rollback exercise, and exact-owner erasure are still separate gates. The
production Cloudflare deployment continues to serve.
