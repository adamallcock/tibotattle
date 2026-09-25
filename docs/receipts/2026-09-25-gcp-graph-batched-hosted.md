---
title: GCP batched graph publication at 100,000 synthetic members
date: 2026-09-25
type: receipt
status: snapshot
---

# GCP batched graph publication at 100,000 synthetic members

On 2026-09-25, the IAM-private `tibotattle` **test project** in `us-east1`
completed a fresh 100,000-member graph benchmark on zonal Cloud SQL 17. The
batched publisher produced the same workload, source and output digests as the
[preceding indexed-reader run](./2026-09-25-gcp-graph-readindexed-hosted.md).
It reduced SQL calls substantially, but the measured end-to-end time changed
by only 1.45 seconds on two separate fresh schemas. This is not evidence of a
material hosted speedup or the requested tenfold gain over Cloudflare.
Production Cloudflare continued serving; this job did not change the A2
application schema or private service.

## Pinned source and isolated schema

The clean source was commit `c04cea6f349f4f6431b3793445623c7132ad502b`.
The allowlisted archive had source-content digest
`db42d22ac3a305cddcc02d307a0bd18086df162b19cffbeec08490fb3e5e5a0d`
and SHA-256
`7280634ee6499d22b81eac7a44866d0970ea84f64b05efd7841822a98f516277`.
Its create-only GCS object generation was `1790348279777110`. Regional build
`1a67afb4-08da-427a-bd18-96ce00ee2d4a` succeeded and produced image
`sha256:d54bc6fc63006650203420cb956a7dac556089244e8d8b442c9607306e4a3be5`.
Focused local graph and Cloud Run checks passed. Worker typecheck passed in a
clean detached checkout of this commit, separate from concurrent integration
edits.

Migration job `tibotattle-public-graph-benchmark-migrate-zsnmp` succeeded on
that image. Its structured receipt read back seven isolated graph schemas at
39/39 primary migrations, including fresh
`tibotattle_graph_benchmark_100k_batched_20260925`. The tail was
`0039_analytics_applied_projection_v1.sql` with checksum
`5750810077d5a9124e8605007b514e841136177f88db473905cec289ff833ecc`;
the migration manifest digest was
`f211a4186f1b8a3adbf6ee4957afdb3b069718816ec18fc2be7907ca1b0fac25`.

## Hosted benchmark

The benchmark Job used profile `100k-batched`, the exact image and fresh schema
above, one task, zero retries and one database connection. Execution
`tibotattle-public-graph-benchmark-lxwpq` succeeded in 5 minutes 2.64 seconds
of Cloud Run elapsed time. The in-process workload timer recorded:

| Phase | Batched run | Preceding indexed-reader run |
| --- | ---: | ---: |
| Setup and preflight | 461 ms | 509 ms |
| Seed 100,000 synthetic members | 47,278 ms | 49,325 ms |
| Publish graph | 183,658 ms | 186,273 ms |
| Read back and verify | 50,498 ms | 47,278 ms |
| Other harness time | 2,078 ms | 2,040 ms |
| Total measured workload | 283,973 ms | 285,425 ms |

Both runs reported workload digest
`7b3199c3da470fd8c55806f275f4f3094cb5be4fff7158aa1d07bcfc7a27f5fc`,
source digest
`c90d7927e4444ccb53db17822d5c11fa42adfd933854fbc50123a70cc9dde934`,
and output digest
`4025b72539599beb754fb0b3a476203d05b2c0ff07fb824f9287656b40f7b10f`.
The local synthetic run had these same digests. The hosted Job recorded 325
SQL calls versus 864 in the preceding profile, one connection created, a
maximum of one checked out, zero checked out at completion, and peak resident
memory of 156,940 KiB.

The dominant batched SQL categories remained publication-member writes
(25 calls, 56.8 seconds), combined result-page application (98 calls,
60.0 seconds), owner-result pages (98 calls, 31.0 seconds), and member
readback pages (25 calls, 40.3 seconds). These one-run category totals do not
separate server execution from network transfer. Fewer round trips alone did
not remove the dominant work; a statement-level execution-plan and buffer
diagnosis is the next performance gate.

## Boundary

The total difference is about 0.5% across two single runs on different fresh
schemas, within plausible run-to-run variation. The benchmark itself reported
`hostedTenfoldClaimQualified=false`. There is no matched hosted Cloudflare
comparison, and no production-size graph or sustained-load result. This graph
job does not prove scheduled delivery, source transfer, public serving route
parity, failback, or a production cutover. The test maintenance Scheduler was
read back as `PAUSED` after this run.
