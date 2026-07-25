---
title: G1 Compressed Export Set Verification Receipt
date: 2026-07-24
type: verification-receipt
status: verified
---

# G1 compressed export-set verification receipt

## Decision

Gate C, the local compressed export-set representation, is accepted for the current unfrozen local-only draft. This is not an upload or volunteer-release approval. Gate D crash-recoverable deletion and every consented network stage remain closed.

## Verified contract

- The current emitter produces `usage-export-set-manifest-v0.2` and fixed `.bundle.json.gz` chunks.
- Canonical decoded JSON supplies semantic identity (`bundleSha256`, `bundleBytes`, bundle IDs, ordering, and logical-record digest).
- Stored gzip bytes supply representation identity (`artifactSha256`, `artifactBytes`) under `gzip-level-6-v1`.
- The manifest records bounded producing `nodeVersion` and `zlibVersion`. Verification authenticates the stored representation and does not require runtime equality or recompression.
- Packing is greedy over decoded canonical bytes and record count only. Compression is performed once for the selected chunk; encoded overflow fails before workspace planning or destination publication.
- Resource policy `g1-r3-candidate-0.4` independently caps one decoded bundle at 32 MiB, one encoded artifact at 34 MiB, and cumulative decoded and encoded set bytes at 4 GiB each.
- The durable pair transaction and recovery path admits the complete 34 MiB first-artifact range while retaining the 1 MiB receipt cap.
- Plain v0.1 structure remains explicitly dispatched only under the current compatibility tuple. Earlier draft tuples are rejected and must be regenerated, consistent with `backwardCompatibility: none_regenerate_local_review_artifacts`.
- Mixed plain and compressed chunk representations fail closed. Transport remains disabled.

## Automated evidence

Executed from the repository root on Node 26.2.0 with zlib 1.3.1-e00f703:

```text
npm run telemetry:check
9 passed, 0 failed

node --test --test-concurrency=1
370 passed, 0 failed
```

The suite includes:

- normalized deterministic gzip and a Node 20.0.0/zlib 1.2.13 foreign-runtime fixture;
- binary/NUL fidelity, pre-copy limit rejection, corrupt/truncated streams, bombs, concatenated-member rejection, and a same-output empty second-member regression;
- binary pair publication/recovery at every transaction failpoint plus a 32 MiB + 1 byte first artifact;
- v0.2 and current-tuple v0.1 round trips, old-policy rejection, mixed-representation rejection, on-disk oversize rejection before decompression, decoded hash mismatch, permission failures, and content-free CLI corruption output;
- deterministic repeated materialization, exact interrupted-artifact adoption, encoded overflow before plan/publication, decoded privacy-canary scans, and all set-level failpoints; and
- independent cumulative decoded/encoded ceilings and disk-backed uniqueness cleanup.

## Real local round trip

The final implementation was exercised over local Codex logs from `2026-07-24T22:00:00.000Z` through `2026-07-25T01:28:00.000Z`:

```text
chunks: 1
usage records: 2,488
quota snapshots: 2,578
activity markers: 0
decoded canonical bytes: 5,643,451
encoded artifact bytes: 334,815
manifest bytes: 5,584
schema: usage-export-set-manifest-v0.2
packing: greedy-canonical-bundle-v1
producer: Node 26.2.0, zlib 1.3.1-e00f703
independent verification: passed
transportReady: false
```

The temporary smoke workspace and output were moved to the user's Trash after verification. No source log, participant identity state, collector history, or report was changed.

## Audit closure

Independent code, performance, and test/documentation reviews found four material blockers in the first green implementation:

1. the v0.1 test did not state the draft compatibility boundary;
2. transaction recovery still hid a 32 MiB first-artifact cap;
3. mixed representations were not rejected; and
4. gzip-prefix binary search assumed compressed sizes were monotonic.

A final re-audit also found that Node's default gunzip behavior accepts multiple concatenated members. The decompressor now parses the fixed normalized header, inflates exactly one raw deflate stream, requires its trailer to end at the artifact boundary, and validates CRC32 plus decoded length. A valid payload followed by an empty second member is rejected.

The final implementation closes all four: old draft artifacts are intentionally rejected and documented, transaction admission/recovery is 34 MiB-aligned, opposite representations fail closed, and packing is decoded-only with one post-packing compression check. The reviews also prompted runtime provenance, a disk-only workspace-size probe, actual on-disk oversize coverage, decoded canary inspection, and content-free CLI corruption coverage.

## Remaining gates

- Gate D exact-inventory, journaled, crash-recoverable local deletion is not implemented.
- Clean-machine signed packaging, supported-runtime qualification, native Windows secret storage, Claude parity, two local volunteer reviews, and pilot-derived resource ceilings remain open G1 requirements.
- Enrollment, consent, encryption, upload, server ingestion, participant deletion, private results, aggregate analysis, public reporting, ongoing collection, and incident operations remain unimplemented and unauthorized.
