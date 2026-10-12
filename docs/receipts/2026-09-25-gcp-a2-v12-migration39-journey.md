---
title: GCP A2 v1.2 journey after PostgreSQL migration 39
date: 2026-09-25
type: receipt
status: snapshot
---

# GCP A2 v1.2 journey after PostgreSQL migration 39

On 2026-09-25, one synthetic v1.2 upload, replay, domain activation and
readback completed against the IAM-private `tibotattle` **test project** in
`us-east1`. Exact-owner cleanup then removed its one GCS object. This
requalifies the isolated test journey after primary migration 39. Production
Cloudflare continued serving. The A2 maintenance Scheduler remained paused,
and this test did not enable public collection or daily publication.

## Source, deployment and preflight

The A2 service remained revision `tibotattle-test-app-00033-clg`, receiving
100% of its private test traffic from image
`sha256:b3da8f89b7958312620fc82fc1f7f01a5488694ea896151cb785b169ca97c9fd`.
Its authenticated health was ready with 39/39 primary and 6/6 ledger
migrations; the public application-ready flag remained false. An anonymous
request was denied. The isolated primary schema was
`tibotattle_v12_a2_20260925`, the separate ledger schema was
`tibotattle_ledger_v12_a2_20260925`, and the bucket was
`tibotattle-gcs-test-cleanup-20260925-a2`. The bucket listed empty before the
smoke.

The first smoke execution, `tibotattle-v12-smoke-jftnp`, failed **before
fixture seeding** with `SMOKE_HEALTH_CONTRACT_INVALID`: its test harness
required migration 38 exactly, while the correctly migrated A2 schema was at
39. Commit `0fa647a3b100dd3318e6215bec3c8f008d7c14bf` changed the
harness to require a current health receipt with safe-integer primary version
at least 39 and ledger version at least 6. Focused smoke tests passed 14/14,
including rejection of pre-39 and malformed versions and acceptance of a
newer current version. The fix changed the smoke harness, not the serving
application.

That clean commit produced allowlisted source-content digest
`86b2b3848531dd3a44af9d3eab82fadac5e9da751d4584bbfce45ccfcb2d3a89`
and archive SHA-256
`76ea91e60ff63672976bb44082f73edddd90232674c919e6ad6d31c813fa7906`.
The create-only source object had generation `1790348878055155`. Regional
Cloud Build `75adedb0-4e6a-4bfa-b4de-f6e0b8c79f60` succeeded and
produced immutable image
`sha256:a08c6a0eaff23ad3a559388b082e8b2e8a37d0542a2e9553d7ccdb2babb7fce4`.
The smoke, discovery and cleanup Jobs were pinned to this image. Each had one
task and zero retries.

## Journey and cleanup

Smoke execution `tibotattle-v12-smoke-4mb8b` succeeded. Its content-free
receipt reported staged and exactly replayed day manifest and chunk, domain
activation and exact replay, credential rotation with the old secret rejected,
PostgreSQL and GCS readback, and one effective record readback. Publication
remained withheld by verified degraded controls.

Read-only discovery `tibotattle-v12-synthetic-discovery-dzkfn` found exactly
one synthetic owner, one referenced GCS object, one registered pending
reference and zero unattributable pending references. The cleanup Job was then
set to that exact synthetic owner. Execution
`tibotattle-v12-synthetic-cleanup-zs4s5` succeeded with `status=complete`
and `objectsDeleted=1`. Its bucket birth proof remained present in the Job
configuration. A post-cleanup discovery of the same target,
`tibotattle-v12-synthetic-discovery-h6cnz`, returned the expected
`SYNTHETIC_DISCOVERY_TARGET_OWNER_INVENTORY_MISMATCH`; the target owner was
absent. Independent GCS listing found no live or versioned objects.

## Boundary

This proves one isolated synthetic v1.2 journey and exact-owner cleanup on
the named private service and test resources. It does not prove production
source transfer, all Worker routes, scheduled publication, public ingress,
general owner erasure, or a complete cutover. The daily publication fence
remained absent, and the private daily endpoint continued to fail closed.
