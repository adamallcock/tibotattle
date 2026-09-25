---
title: GCP hosted graph readback plan diagnosis
date: 2026-09-25
type: receipt
status: snapshot
---

# GCP hosted graph readback plan diagnosis

This 2026-09-25 read-only diagnosis applies to the existing, seeded
100,000-member synthetic schema in the IAM-private `tibotattle` test project,
not to production. It follows the timed-out
[readpaged graph run](./2026-09-25-gcp-a2-daily-and-readpaged-graph.md).
Production Cloudflare remained the serving system.

Commit `feff8762` added a Job that verifies its named test target, runtime
identity, migration receipt and 100,000-member publication before asking
PostgreSQL for a plain `EXPLAIN (FORMAT JSON)` of the exact member-readback
query. It does not run the query or expose SQL, relation names, identifiers or
rows in its receipt. The clean source archive had content digest
`c18c58b7bd0436905e8d8dd4899e8639c7bb1d2e01d0d90e89261809a35dab92`
and SHA-256
`42bf663631193caed87685cd16e0449b497511ed9dd15e1e5686c9dc60a93c18`.
Build-bucket generation `1790344739288424` was submitted as regional Cloud
Build `59f57842-f1e7-4864-b87d-7acc6f7b88fa`, which succeeded and produced
image `sha256:a855eefdf77ed56040714288c7b244a054b00eae269149832af3732fca4f80ac`.

The single-task, zero-retry diagnostic execution
`tibotattle-public-graph-readback-diagnostic-fk4db` succeeded on the existing
38/38 migrated schema. Its bounded plan receipt reported a `Gather Merge`
root, one `Sort`, three left hash joins, sequential scans and **zero index
scan nodes**. The estimated root cost was 33,688.87 and the sort startup cost
was 22,965.86. The plan request completed in 34 ms; that is planning time,
not readback time. The statement digest was
`eb7ef506c43d83e297e54c3a98889b115209c13fc6fa3662184562754dae5ee3`.

The plan is consistent with the prior 120-second cursor fetch timeout and
3,776,512-byte temporary file: a cursor page cannot arrive until the ordered
join result has been produced. That causal explanation is an inference, not a
measured `EXPLAIN ANALYZE` result. The next gate is an indexed, bounded page
query that preserves the complete member-count and hash proof, followed by a
new pristine-schema hosted benchmark with matching output digest.
