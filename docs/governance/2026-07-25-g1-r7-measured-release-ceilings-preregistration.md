---
title: G1 R7 Measured Release Ceilings Preregistration
date: 2026-07-25
type: plan
status: active
---

# G1 R7 Measured Release Ceilings Preregistration

## Decision to be made

Select and promote a reproducible macOS arm64 local-release resource policy for the metadata-only Codex and Claude exporter. The evidence must show which histories complete safely, which inputs stop at an exact fixed code, how much CPU, wall time, memory, and disk each lifecycle stage consumes, and whether cleanup preserves private sources and identity state.

This study may promote, lower, or leave the current candidate ceilings unchanged. It may not raise any compatibility-bound ceiling without a separately reviewed contract migration. Until evidence spans enough representative machines, results are a **conservative tested heavy-history envelope**, not a population p95.

## Frozen scope

The measured lifecycle is:

1. source discovery and scan for Codex rollout, passive quota ledger, Claude status ledger, and Claude transcript sources;
2. interruption after a committed source checkpoint and exact resume;
3. export-set materialization and canonical compression;
4. independent export-set verification;
5. complete-set deletion and failed-workspace discard, including recovery from selected interruption points; and
6. Claude callback uninstall and restoration of pre-existing configuration.

The first release target is macOS arm64. Node 24.14.0 is the pinned-candidate runtime; the current Node 26 runtime remains a compatibility crosscheck until packaging freezes the bundled runtime.

No network transport, enrollment, upload, raw-content persistence, or external participant data is part of R7.

## Current candidate policy

The source of truth is `src/export-resource-policy.js`. The preregistered study records, but does not silently rewrite, these candidate maxima:

| Dimension | Candidate ceiling |
|---|---:|
| Covered duration | 31 days |
| Directory entries | 20,000 |
| Source files | 5,000 |
| Source bytes | 32 GiB |
| Physical line bytes | 16 MiB |
| Single-bundle output records | 100,000 |
| Single-bundle expanded record bytes | 32 MiB |
| Canonical bundle bytes | 32 MiB |
| Encoded artifact bytes | 34 MiB |
| Export-set records | 2,000,000 |
| Export-set expanded record bytes | 2 GiB |
| Export-set decoded bytes | 4 GiB |
| Export-set encoded bytes | 4 GiB |
| Workspace high-water bytes | 4 GiB |
| SQLite batch records | 1,000 |
| Manifest bytes | 1 MiB |
| Chunks | 512 |
| Cumulative elapsed time | 10 minutes |
| Peak RSS | 1.5 GiB |

## Measurement definitions

- **Wall time:** monotonic elapsed nanoseconds around one named operation, converted to integer milliseconds by ceiling. It is not part of deterministic receipt identity.
- **CPU time:** process user plus system CPU microseconds observed immediately before and after the operation. It is converted to integer milliseconds by ceiling and is not part of deterministic identity.
- **Peak RSS:** the maximum sampled resident-set size during the operation, combined with the operation's durable resource high-water value where available. Sampling interval and source are recorded.
- **Bytes and counts:** exact integer values from frozen source plans, workspace state, manifests, filesystem metadata, and verifier results. Decimal display conversions are never authoritative.
- **Operation outcome:** `completed`, `rejected_at_limit`, `interrupted_recovered`, or `not_run`, with one reviewed fixed reason code. Arbitrary exception strings, paths, source names, pseudonyms, or payload fragments are prohibited.
- **Deterministic identity:** SHA-256 over the canonical workload and logical-result projection. Runtime timings, CPU, RSS, machine label, and receipt creation time are excluded and listed explicitly.

## Scenario matrix

### A. Synthetic exact-boundary matrix

For every enforced dimension with a producer/verifier path:

1. run at the exact selected boundary and require success;
2. run at boundary plus one unit and require the documented fixed failure code;
3. exercise both producer and verifier when both accept that dimension;
4. avoid allocating GiB-scale buffers by using deterministic sparse/control fixtures or injected exact counters where the implementation boundary is itself a counter; and
5. separately retain at least one materialized byte-level case for compression, decompression, line length, manifest size, and workspace/file controls so counter-only tests cannot substitute for parser/filesystem enforcement.

Dimensions that cannot physically be exercised at the literal candidate ceiling on the release machine must be labeled `synthetic_boundary_only`. They cannot alone justify keeping that ceiling.

### B. Deterministic lifecycle fixtures

Use generated, content-free fixtures representing:

- Codex root and fork/subagent rollouts, including inherited replay that must not count twice;
- passive quota snapshots with recognized and unknown account scope;
- Claude root and subagent transcripts with fallback iterations, cache reads, five-minute/one-hour cache writes, combined output, tools, and known/unknown models;
- Claude five-hour and seven-day status windows independently present and absent;
- many small files, one near-limit line, dense records, incompressible and highly compressible payload shapes, maximum chunk pressure, and near-limit manifest growth; and
- incomplete workspaces and deletion/uninstall interruption points.

Fixture generation is seeded, produces only structural synthetic values, and emits a manifest hash. It must not inspect or copy local user logs.

### C. Real local heavy-history envelope

Run the current local Codex and Claude history using the privacy-safe exporter without retaining a new raw copy. The receipt may contain only aggregate counts, byte totals, durations, CPU, RSS, policy/runtime/contract hashes, operation states, and fixed diagnostics. It must not contain paths, filenames, account/session/event pseudonyms, model fingerprints, timestamps of user activity, or row-level values.

The previously observed 21.56 GiB Codex corpus and 1,139-file Claude corpus are comparison points, not frozen expected results. Source growth is recorded as a new workload hash rather than treated as nondeterminism.

### D. Cleanup and preservation

For complete-set deletion, failed-workspace discard, and callback uninstall:

- hash or structurally attest independent source logs and identity/capability state before the operation;
- run success plus selected interruption/recovery cases;
- require the exact deletion/discard/uninstall inventory to be exhausted;
- require source logs and unrelated output to remain byte-identical;
- require local identity state to follow the documented preserve/remove choice; and
- make no secure-erasure claim.

## Two-run determinism rule

Run every deterministic fixture lifecycle twice from fresh directories under the same runtime and policy. Require equality for:

- source-plan and fixture-manifest hashes;
- logical record hashes and counts;
- chunk boundaries, canonical artifact hashes, receipt hashes, and verifier results;
- fixed failure codes; and
- cleanup inventories and preservation results.

The following may differ and must be excluded from the deterministic projection: receipt creation time, wall time, CPU time, sampled peak RSS, process identifier, temporary directory identity, filesystem inode/device values, and machine label.

Any other difference is a failed scenario, not noise.

## Ceiling-selection rule

For each dimension, choose the lowest of:

1. the current compatibility-bound candidate ceiling;
2. the largest exact boundary that passes all applicable producer/verifier/lifecycle tests with at least 20% headroom below the selected RSS, workspace, and elapsed-time hard stops; and
3. the largest real heavy-history observation that completes twice plus a documented headroom factor, rounded down to a stable engineering boundary.

Do not infer an independent ceiling from a correlated workload if another resource stopped first. Record that dimension as `not_identified` and retain or lower the candidate only through a named conservative judgment.

Promotion requires:

- no failed deterministic or privacy scenario;
- every selected limit enforced by the relevant producer and verifier path;
- the real local heavy-history run completing without swap-driven instability, unbounded growth, or cleanup loss;
- Node 24 and current-Node contract/test parity;
- a focused performance, code-quality, and tests/docs audit with no unresolved blocking issue; and
- a dated decision receipt naming every retained, lowered, unresolved, or deferred ceiling.

## Privacy and safety constraints

The benchmark receipt is deny-unknown and content-free. It may contain only reviewed enums, versions, hashes of public code/contracts or generated fixtures, aggregate integer metrics, bounded machine/runtime classes, operation outcomes, and fixed diagnostics.

It must never contain:

- prompts, responses, code, tool arguments/results, commands, URLs, paths, filenames, repository details, branch names, or arbitrary errors;
- raw or pseudonymous participant, account, session, event, snapshot, marker, device, model-fingerprint, or enrollment identifiers;
- exact user-activity timestamps or source modification times;
- credentials, Keychain service/account identifiers, environment values, hostnames, usernames, or network addresses; or
- row-level telemetry.

All generated temporary fixtures and artifacts are placed under an exact task-owned temporary directory. Cleanup is exact-inventory and recoverable; broad recursive deletion targets are prohibited.

## Stop conditions

Stop and leave R7 open if:

- any receipt or diagnostic contains prohibited data or unknown fields;
- boundary plus one succeeds, the exact boundary fails unexpectedly, or producer/verifier codes disagree;
- a resumed run changes logical records or hides earlier resource use;
- two deterministic runs disagree outside the explicit exclusion set;
- deletion/discard/uninstall changes a protected source or independent state;
- CPU, RSS, disk, or wall growth is unbounded or cannot be measured credibly;
- the current policy permits an input the verifier cannot safely bound; or
- evidence supports only a smaller release policy and the implementation is not lowered accordingly.

## Required receipt and decision artifacts

R7 exits only with:

1. a versioned JSON Schema for the content-free benchmark receipt;
2. a deterministic fixture generator and workload manifest;
3. a runner/CLI producing schema-valid receipts;
4. exact-boundary and boundary-plus-one tests for every declared limit;
5. two-run deterministic lifecycle evidence;
6. a real local heavy-history receipt;
7. a promoted, versioned resource policy or a dated decision to retain/lower each candidate value;
8. dual-runtime full-test and telemetry-contract receipts;
9. focused independent audit closure; and
10. an update to the live G1 route linking the evidence and preserving all remaining external gates.

This preregistration freezes the rules before the new benchmark results are inspected. Amendments require a dated change record and may not retroactively change the interpretation of already observed results.
