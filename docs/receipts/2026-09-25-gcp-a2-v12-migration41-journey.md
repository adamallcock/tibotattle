---
title: GCP A2 v1.2 private journey after PostgreSQL migration 41
date: 2026-09-25
type: receipt
status: snapshot
---

# GCP A2 v1.2 private journey after PostgreSQL migration 41

On 2026-09-25, a source-pinned IAM-private test service in GCP project
`tibotattle`, region `us-east1`, migrated its isolated PostgreSQL primary to
41/41 and independent erasure ledger to 6/6. One synthetic v1.2 upload,
activation, credential-renewal and readback journey then passed against real
Cloud SQL and GCS. Exact-owner cleanup removed its one object and verified
replay safety. Production Cloudflare remained serving, the test maintenance
Scheduler remained paused, and no public daily aggregate was published.

## Source and qualification

The clean build candidate was commit `ad03eaed` on 2026-09-25. Its
allowlisted Cloud Run source-content digest was
`6516a4f087525c8571e6add54507879e202237290795f0cfcba95f18f4590108`;
the source archive SHA-256 was
`a9ce8822c7897e57b466405e8dcd142484227818a3a82296556ae42738bf5363`.
The create-only source object had generation `1790355264577481`. Cloud Build
`5d22f7d5-f680-443f-9fdc-30be83d19500` succeeded and produced immutable
image `sha256:95c15fa41597c1d676aa78bcc2b28dd4bb7289cd8db32acf4839fd0d40d2e665`.

From this clean candidate, `npm run architecture:check`,
`npm run product:worker:check`, `npm --prefix apps/worker run deploy:dry`,
`npm --prefix apps/worker run staging:check`, and
`npm --prefix apps/worker/cloud-run run check` passed. The Worker dry-run
required the canonical local public-release-site build to produce an ignored
manifest; it did not deploy a Worker or release artifact. These gates qualify
the named source candidate, not the integration worktree's later commits.

## Test database and private service

The successful primary backup was `1790355594358`, completed at
`2026-09-25T17:01:25Z`, before migration. Migration Job execution
`tibotattle-test-database-migrate-ptncm` succeeded on the pinned image with
one task and zero retries. Its content-free readback reported primary 41/41,
latest migration `0041` with checksum
`19c1f19a1ec333012c70334bf8ac8f6c1ca5b2a2c9e67d3b716eaa81dcbcd45b`,
and independent erasure ledger 6/6. The exact test schemas were
`tibotattle_v12_a2_20260925` and
`tibotattle_ledger_v12_a2_20260925`.

The guarded deployment verified service revision
`tibotattle-test-app-00037-4tl` receiving 100% of the IAM-private test
traffic from the pinned image. Read-only verification returned no blockers;
an unauthenticated request was denied. This was a private test deployment,
not a public ingress or production traffic switch.

## Synthetic journey and erasure

The one-task, zero-retry `tibotattle-v12-smoke-z7fnc` execution succeeded.
Its content-free receipt reported a staged and exactly replayed day manifest
and chunk, domain activation and exact replay, credential rotation and renewal,
rejection of the prior secret, PostgreSQL/GCS/effective-record readback, and
publication withheld by degraded controls. The test bucket was empty before
this run.

Read-only discovery `tibotattle-v12-synthetic-discovery-rm95j` found exactly
one synthetic owner, one referenced GCS object, one registered pending
reference, and zero unattributable pending references. The cleanup Job was
read back with the same image, exact synthetic target, bucket-history proof,
one task and zero retries. Execution
`tibotattle-v12-synthetic-cleanup-dxz5r` returned `status=complete` and
`objectsDeleted=1`. Its implementation verifies primary completion before
writing the completed independent-ledger receipt. An exact-target retry,
`tibotattle-v12-synthetic-cleanup-jtlwp`, returned `already_complete`.
Independent all-version GCS listing found no remaining object versions.

## Remaining gate

This receipt proves one private synthetic v1.2 journey and exact-owner
cleanup on the named image and test resources. It does not prove the real
D1/R2 source snapshot and fence, all application routes, public OAuth or
admin ingress, scheduled daily publication, a matched Cloudflare performance
comparison, production deployment, or cutover. The daily publication runner
remained in read-only `--preflight` mode; a proposed revised test control
transition is separately approval-gated.
