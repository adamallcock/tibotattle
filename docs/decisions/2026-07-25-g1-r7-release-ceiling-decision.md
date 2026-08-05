---
title: G1 R7 Release Ceiling Decision
date: 2026-07-25
type: decision-record
status: open
---

# G1 R7 Release Ceiling Decision

## Decision

Do **not** promote or change the `g1-r3-candidate-0.5` resource policy from the current R7 evidence. Both exact-runtime decision receipts return `release_open`, and every one of the 19 dimensions remains `unresolved` / `not_set`.

The real-history run gives useful ballpark observations. It does not independently identify safe ceilings, prove 20% filesystem headroom, define a stable engineering rounding grid, or establish population p95 behavior. Retaining the current implementation as a local-only development candidate is reasonable; labeling its limits as measured release ceilings is not.

## Promotion gates

| Gate | Status | Reason |
|---|---|---|
| Exact runtime pairs | Open | Each runtime is exact and independently valid, but privacy-minimized receipts retain no machine/run identifier proving paired execution on one host. |
| Input outcomes | Open | The four evidence profiles intentionally report `partial`; no profile overclaims another profile's coverage. |
| Lifecycle operations | Open | Synthetic profiles cover all ten lifecycle operations, while real-history and materialized profiles intentionally cover narrower operations. |
| Determinism | Open | Synthetic and real-history projections pass; the materialized profile honestly reports partial comparisons. |
| Preservation | Passed | Source logs, identity state, independent outputs, and callback settings were preserved; cleanup was exact where run. |
| Privacy | Passed | All receipts are content-free and pass prohibited-data scans. |
| Network isolation | Open | Network activity is `not_measured`, not proven absent. |
| Engineering rounding | Open | No stable rounding grid was preregistered for observed value plus 20% headroom. |
| Ceiling selection | Open | No dimension has complete independent boundary and headroom inputs. |

## Per-dimension record

`Observed` is the maximum independently retained real-history aggregate across the two runtimes. A blank observation means this profile did not identify that dimension. None is a selected ceiling.

| Dimension | Candidate | Observed | Decision |
|---|---:|---:|---|
| Covered duration | 2,678,400,000 ms | 2,678,400,000 ms | Unresolved; no rounded independent headroom value |
| Directory entries | 20,000 | — | Unresolved |
| Source files | 5,000 | 2,616 | Unresolved; one correlated history only |
| Source bytes | 34,359,738,368 | 23,275,829,422 | Unresolved; one correlated history only |
| Line bytes | 16,777,216 | — | Unresolved; 64 KiB injected pathway is not the candidate boundary |
| Single-bundle output records | 100,000 | — | Unresolved |
| Single-bundle expanded record bytes | 33,554,432 | — | Unresolved |
| Canonical bundle bytes | 33,554,432 | — | Unresolved |
| Encoded artifact bytes | 35,651,584 | — | Unresolved; 8 MiB material case is not the candidate boundary |
| Export-set output records | 2,000,000 | 441,290 | Unresolved; one correlated history only |
| Export-set expanded record bytes | 2,147,483,648 | — | Unresolved |
| Export-set decoded bytes | 4,294,967,296 | 525,861,636 | Unresolved; sampled disk is not enforced maximum |
| Export-set encoded bytes | 4,294,967,296 | 29,509,559 | Unresolved; sampled disk is not enforced maximum |
| Workspace bytes | 4,294,967,296 | — | Unresolved; 8 MiB file-stat case is not the candidate boundary |
| SQLite batch records | 1,000 | — | Unresolved; no injectable seam, explicitly not run |
| Manifest bytes | 1,048,576 | — | Unresolved |
| Chunk count | 512 | — | Unresolved |
| Elapsed time | 600,000 ms | 472,414 ms | Unresolved; one correlated history and no rounding rule |
| RSS | 1,610,612,736 bytes | 836,255,744 bytes | Unresolved; single machine despite terminal high-water enforcement |

## What is established

- The candidate policy's direct guards accept all 18 runnable values and reject value plus one with fixed codes.
- Real producer/verifier pathways pass the injected 64 KiB line, 8 MiB workspace, and 8 MiB compressible/incompressible artifact cases and reject their plus-one controls.
- A 31-day, 23.28 GB, 2,616-source history completed twice on each exact runtime and produced 441,290 metadata records deterministically.
- The worst retained real-history parent operation was 472.414 seconds, below the 600-second candidate operation limit.
- The worst retained RSS was about 836 MB, below the 1.5 GiB candidate limit; mandatory worker lifetime RSS and external sampling both enforce the ceiling.
- These are single-machine observations, not independent limit measurements or user-population percentiles.

## Required evidence before promotion

1. Freeze a stable engineering rounding grid before looking at the next measurements.
2. Add producer-enforced filesystem high-water accounting; a 100 ms sample can remain diagnostic but cannot prove headroom.
3. Add an injectable SQLite batch pathway and run value/plus-one evidence.
4. Add actual candidate-scale producer/verifier cases, or explicitly lower the candidates to independently exercised boundaries under a new preregistration.
5. Measure and retain a bounded proof of absent network activity.
6. Add a privacy-safe paired-run attestation if exact same-machine pairing is a required promotion gate.
7. Run at least one additional bounded RAM/machine class before making any cross-machine claim; do not claim p95 from this host.
8. Repeat the eight-input matrix and rebuild both decision receipts. Promotion is permitted only if every gate passes and every dimension resolves to `retain` or `lower`.

## Bound decision artifacts

- [Node 24.14.0 decision receipt](../../generated/r7-release-decision-node24.14.0-v0.1.json): `43b967ecd1965aa5a996d1e029f6cce046a1ba178e5d49e2cd6b54f98e0f523b`
- [Node 26.2.0 decision receipt](../../generated/r7-release-decision-node26.2.0-v0.1.json): `9959bd29f622a65a1295a345f715037f26d77856462ef5cbe0917d52e93fd30f`
- [Measured release verification receipt](../receipts/2026-07-25-g1-r7-measured-release-verification-receipt.md)

Any future source, schema, policy, workload, or decision-rule change invalidates these mutable generated receipts and requires complete regeneration before a new decision.
