---
title: GCP indexed graph readback at 100,000 synthetic members
date: 2026-09-25
type: receipt
status: snapshot
---

# GCP indexed graph readback at 100,000 synthetic members

This is a 2026-09-25 result for the IAM-private `tibotattle` **test project**
in `us-east1`. A fresh synthetic schema completed the 100,000-member graph
benchmark with the same workload, source, and output digests as the local
PostgreSQL 17 run. It removes the earlier 120-second hosted readback timeout.
It does not establish a tenfold speedup against hosted Cloudflare or qualify a
production cutover. Production Cloudflare continued serving, the test
maintenance Scheduler remained paused, and this run did not change the A2
application schema or service.

## Source and target

The clean detached source was commit `23e06b4346b6dd8383bf017b31ab8878a4d519c4`.
Its allowlisted Cloud Run archive had source-content digest
`153efb515ef3beb66f5aeb6d3d5f606b8f44b9cead92612c8ad6d97f07862ce0`
and archive SHA-256
`4712ad4d01ca30f5188ea91d1be7e603be1ea07cb1d404145558365149be2f58`.
The create-only build-bucket object generation was `1790346464472784`.
Regional Cloud Build `b00c7c42-5c42-4041-b3e2-8c3d20dbce26` succeeded
and produced the immutable image
`sha256:e0fdc168948ce87d4186172fdf6c34f8233ccef2e0667aa24e02359a705ed619`.

The existing single-task graph migration Job was pinned to that image.
Execution `tibotattle-public-graph-benchmark-migrate-2k4hc` succeeded and
read back six isolated graph schemas at 39/39 primary migrations. The new
`tibotattle_graph_benchmark_100k_readindexed_20260925` schema ended at
`0039_analytics_applied_projection_v1.sql` with migration checksum
`5750810077d5a9124e8605007b514e841136177f88db473905cec289ff833ecc`.
The migration manifest digest was
`f211a4186f1b8a3adbf6ee4957afdb3b069718816ec18fc2be7907ca1b0fac25`.

## Hosted execution

The benchmark Job used that same image, profile `100k-readindexed`, the new
schema, one task, zero retries, and the zonal `db-g1-small` Cloud SQL 17 test
primary. Execution `tibotattle-public-graph-benchmark-ttfv5` succeeded in
5 minutes 12.78 seconds of Cloud Run elapsed time. Its own phase timer
reported 285.425 seconds:

| Phase | Milliseconds |
| --- | ---: |
| Setup and preflight | 509 |
| Seed 100,000 synthetic members | 49,325 |
| Publish graph | 186,273 |
| Read back and verify graph | 47,278 |
| Other harness time | 2,040 |
| Total measured workload | 285,425 |

The exact workload digest was
`7b3199c3da470fd8c55806f275f4f3094cb5be4fff7158aa1d07bcfc7a27f5fc`,
source digest
`c90d7927e4444ccb53db17822d5c11fa42adfd933854fbc50123a70cc9dde934`,
and output digest
`4025b72539599beb754fb0b3a476203d05b2c0ff07fb824f9287656b40f7b10f`.
All matched the local synthetic profile. The Job reported 864 SQL calls,
100,000 rows across 25 bounded readback pages, one connection created, a
maximum of one connection checked out, zero checked out at completion, and
peak resident memory of 165,660 KiB.

The largest measured SQL categories were 100 publication-member write calls
(57.4 seconds), 195 publication update calls (56.6 seconds), 195 owner-result
page calls (28.4 seconds), and 25 member readback page calls (36.7 seconds).
These are category timings from one run, not a latency distribution or a
capacity forecast. They point to roundtrip and per-page work as the next
optimization target; the whole readback phase includes work beyond its SQL
category.

The separate read-only diagnostic execution
`tibotattle-public-graph-readback-diagnostic-b9jgd` succeeded on this exact
seeded schema and image. Its plain `EXPLAIN` took 17 ms and reported a
13-node plan with four index nodes and no sort. The member page uses the
publication-members primary-key index, followed by indexed authority lookups
and memoization. This is a plan estimate, not an `EXPLAIN ANALYZE` execution
time; the benchmark above supplies the actual hosted timing.

## Remaining gate

The earlier hosted readback cursor timed out after 120 seconds on the same
100,000-member synthetic workload; this fresh indexed run completed readback
in 47.3 seconds. It used a different fresh schema and a newer source image,
so the result demonstrates successful completion and query-shape improvement,
not a controlled speed ratio. There is no matched hosted Cloudflare run, and
the benchmark's own `hostedTenfoldClaimQualified` flag remained `false`.
Publication still takes 186.3 seconds; further bounded batching and a matched
comparison are needed before any tenfold claim. This isolated graph result
does not qualify live route parity, source transfer, scheduled publication,
failback, or production traffic migration.
