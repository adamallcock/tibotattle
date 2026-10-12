---
title: GCP A2 credential-rotation cleanup and isolated graph diagnostics
date: 2026-09-25
type: receipt
status: snapshot
---

# GCP A2 credential-rotation cleanup and graph diagnostics

This is a 2026-09-25 snapshot of the named `tibotattle` **test project** in
`us-east1`. It extends the earlier
[A2 test-journey receipt](./2026-09-25-gcp-a2-v12-test-journey.md); it does not
replace that receipt's exact source or prove a production cutover. Production
Cloudflare continued serving throughout these tests. The test maintenance
Scheduler remained paused.

## Forward migration and v1.2 test journey

- The A2 primary schema `tibotattle_v12_a2_20260925` reached 37/37 forward
  migrations. The independent erasure ledger remained at 6/6. The primary
  migration tail was 0037, checksum
  `885add3276a9f3e41a9a528854b9ff3dade842ce0546503c525ce1501d1d77c3`.
- The private Cloud Run service's source-pinned image was
  `sha256:ada7db297c9e4a430b4f8847ce0a344640ef16752e6b7e066d804905940b852c`,
  revision `tibotattle-test-app-00030-5x4`, serving 100% of **private test**
  traffic. Its deploy gate and independent read-back passed. This image came
  from the reviewed source slice through commit `16a0a1f0`, not the later
  cleanup fix below.
- Synthetic smoke execution `tibotattle-v12-smoke-v9bbx` completed staging
  and exact replay of a v1.2 manifest and chunk, domain activation and exact
  replay, device credential rotation and exact replay, refusal of the old
  credential, and PostgreSQL effective-record and exact GCS-object read-back.
  Publication remained disabled by the test runtime controls.
- The first exact-owner discovery failed safely because its allowlist did not
  yet include rotation state. Commit `81f8c5a6` added the bounded rotation
  family to discovery and cleanup, with local PostgreSQL 17 regression tests.
  A source archive with content digest
  `d178c4e751a58b5d7812b180ae36e835bde272de571f84e2f50a4810c5d1a5d8`
  was built by Cloud Build `5d186ac1-a0dd-4e54-be5b-ad209e73c5cc` into
  image
  `sha256:baeea67f23b133b6afa709630faa074d1b79a1298e72afb53a95648d7441fa44`.
  Only the discovery and cleanup test Jobs were updated to that image.
- Read-only discovery `tibotattle-v12-synthetic-discovery-6q5ds` returned
  `ready`: one exact owner, one referenced GCS object, one registered pending
  reference, and zero unattributable pending references. Exact-owner cleanup
  `tibotattle-v12-synthetic-cleanup-b86hw` returned `complete` with one object
  deleted. Retry `...-tk5w2` returned `already_complete`. A later discovery
  `...-r6q9h` failed with the expected owner-inventory mismatch because the
  owner was absent. The isolated A2 bucket had no live or versioned objects
  after cleanup. These observations apply only to this one synthetic owner.

## Hosted public-graph measurements

The 10,000-member isolated GCP benchmark completed with matching source and
output digests. Its measured phases were seed 3,838.45 ms, publish 6,593.18
ms, read-back 2,029.43 ms, and total 13,397.01 ms. It recorded 129 database
calls, one maximum checked-out connection, one created pool connection, and
151 MB peak process RSS. This is one synthetic run, not a matched hosted
Cloudflare comparison or a 10-times speedup claim.

Two separate 100,000-member schemas each reached the graph publication phase
but failed on a single `INSERT ... SELECT ... ON CONFLICT DO NOTHING` from
staged graph members into `analytics_publication_owner_members`. PostgreSQL's
120-second statement timeout ended the statement in each run. The first run
used `tibotattle_graph_benchmark_100k_20260925`; the second used the newly
migrated `tibotattle_graph_benchmark_100k_insights_20260925` with exact
`100k-insights` profile and image
`sha256:46aec127b3580bef08e0f739dc756da1e36a1feea4898370f96f45baffe81c9c`.
The latter migration Job `tibotattle-public-graph-benchmark-migrate-25bdl`
read back 37/37 migrations in each of three isolated graph benchmark schemas.
The second benchmark execution was
`tibotattle-public-graph-benchmark-22v42`, from 12:18 to 12:21 UTC.

Standard Cloud SQL Query Insights was enabled on the zonal PostgreSQL 17 test
primary for the second run with zero query plans per minute and client IP and
application tags disabled. Completed seed queries appeared in Insights; the
failed publication statement did not appear in that completed-query view.
Cloud Monitoring minute aggregates around the failure showed active CPU,
hundreds of MB of disk writes and WAL, and temporary-relation reads and
writes. Memory utilization stayed around 48–51%; the sampled wait series
showed no lock wait. Those aggregates do not isolate one query's dominant
cost. Local PostgreSQL 17 execution of the exact 100,000-member insert took
about 1.9–2.7 seconds, so local timing does not explain the hosted timeout.
Both hosted schemas are now seeded and must not be reused as pristine
benchmark targets.

## Qualification boundary

The private v1.2 test path is proven for this source, image, synthetic owner,
database schema and bucket. It does not prove complete route coverage,
scheduled analytics or lifecycle parity, a complete production-data transfer,
public ingress, failback, or graph throughput at 100,000 members. The
120-second publication failure is a cutover blocker until a bounded rewrite
passes locally and on a **new** isolated hosted schema. Do not raise the
statement timeout as a substitute for profiling and a bounded work unit.
