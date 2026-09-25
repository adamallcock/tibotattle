---
title: GCP A2 daily preflight and readpaged graph test
date: 2026-09-25
type: receipt
status: snapshot
---

# GCP A2 daily preflight and readpaged graph test

This is a 2026-09-25 snapshot of the IAM-private `tibotattle` **test project**
in `us-east1`. It extends the earlier [A2 journey](./2026-09-25-gcp-a2-v12-test-journey.md)
and [graph diagnostic](./2026-09-25-gcp-a2-v12-rotation-and-graph-diagnostics.md)
receipts. Production Cloudflare remained the serving system. The test
maintenance Scheduler was paused, and no production data was transferred.

## Private daily route and publication preflight

Commit `1b38b867` supplied the private PostgreSQL daily route and guarded
single-day Job. Cloud Build `4affc158-f402-47aa-8926-79c2cbf98ee5` built
source digest `3f536868f8b79b832f5567a582c25d3e799df14ec6ab9625309781044fcbdbc7`
into image
`sha256:76a9efb460b7187911ff29af6b69a4fe40311cdeaa44e4787c2a3de95f973cc6`.
The private test service reached ready revision `tibotattle-test-app-00031-lg7`;
the exact-source post-deploy verifier passed and anonymous invocation was
denied. An authenticated `/api/health` read returned primary 37/37 and
independent ledger 6/6, both current.

An authenticated `GET /api/v1/community/daily` for 2026-09-25 returned HTTP
503 `BACKEND_STORAGE_UNAVAILABLE`. This is the route's fail-closed behavior
while the A2 source/publication fence is not ready. The isolated
`tibotattle-community-daily-publish-test` Job was created from the same image
with one task, zero retries, and `--preflight` only. Its first execution
stopped at configuration because `GOOGLE_CLOUD_PROJECT` had not been set
explicitly; no database access occurred. After correcting that setting,
execution `tibotattle-community-daily-publish-test-w4sc8` returned the
read-only receipt `status: blocked`, with sole code
`SOURCE_FENCE_UNAVAILABLE`. This code means the required source, cursor,
v1/v1.1 admission, policy, and controls join did not yield a row; the receipt
does **not** identify which component is absent. No daily revision was
published. An invalid empty request to the private accountless enrollment
route returned `COLLECTION_ENROLLMENT_DISABLED` without creating an owner.

## Fresh 100,000-member graph test

The readpaged source commit `9cdb1c1c` passed a local PostgreSQL 17 run with
all 100,000 members and unchanged workload, source and output digests. Local
readback took 1,963 ms across 25 pages of at most 4,096 rows, using one
connection. That local result is not a hosted performance claim.

The clean source archive had content digest
`516df569a521d253ded544f4edc77cc6094310f27d58f97740eb83a3c773b2d4`
and archive SHA-256
`1655eaf80819feb3699f43ea09122b18b14a592234d5e4980b2400e31e2a1354`.
GCS object generation `1790342202973354` was submitted as regional Cloud
Build `5fb6275c-a250-4b36-ad7c-8bf818bf196e`; its successful image was
`sha256:edaa702dcc0cd15fd742833e144559357162f5288882d03cfc330b446e0746ea`.
On-demand test-primary backup `1790342260460` completed before the migration.
Migration execution `tibotattle-public-graph-benchmark-migrate-7r2hp`
read back 38/38 primary migrations, ending in
`0038_analytics_event_tuple_versions.sql`, across the five isolated graph
schemas including the new
`tibotattle_graph_benchmark_100k_readpaged_20260925` schema.

The benchmark Job was pinned to that image and fresh schema with one task
and zero retries. Execution `tibotattle-public-graph-benchmark-vrfqt`
(13:21:48–13:26:00 UTC) reached readback but failed. Cloud SQL logged a
120-second statement timeout on
`FETCH FORWARD 4096 FROM postgres_community_graph_member_readback` at
13:25:47 UTC, with a 3,776,512-byte temporary file. The structured Job
receipt reported `phase: readback`; it did not report a completed publish
time or output digest. This schema is now seeded and cannot serve as a
pristine retry target. The prior paged-write test had also failed in
readback, but on its initial publication SELECT rather than this cursor
fetch. The hosted 100,000-member readback remains a cutover blocker.

## Boundary and next evidence

The test primary is PostgreSQL 17, zonal `db-g1-small`, with a fixed 10 GB
disk and no storage auto-resize. The independent ledger is zonal
`db-f1-micro`. These test resources and local proofs do not qualify the
complete application, production transfer, public ingress, or a 10-times
Cloudflare comparison. Next evidence needs a read-only exact A2 source-fence
diagnostic, a guarded synthetic daily publication and HTTP readback, and a
hosted graph query-plan diagnosis followed by a fresh-schema benchmark.
