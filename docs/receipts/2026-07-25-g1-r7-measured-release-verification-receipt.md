---
title: G1 R7 Measured Release Verification Receipt
date: 2026-07-25
type: verification-receipt
status: complete
---

# G1 R7 Measured Release Verification Receipt

## Verdict

The complete R7 evidence package has been executed and retained for the exact macOS arm64 comparison runtimes: Node 24.14.0 as the pinned candidate and Node 26.2.0 as the compatibility cross-check. The ten release receipts are independently schema-valid, self-hashed, content-free, owner-only, and bound to the current implementation, policy, and schema source set.

This verifies the measurement package. It does **not** promote the candidate resource policy. The paired decision receipts correctly return `release_open`; see the [R7 release-ceiling decision](../decisions/2026-07-25-g1-r7-release-ceiling-decision.md).

This receipt supersedes the earlier [synthetic smoke verification receipt](./2026-07-25-g1-r7-smoke-verification-receipt.md). The smoke artifacts remain useful historical evidence but are outside the ten-file release matrix.

## Retained release matrix

| Profile | Node 24 semantic receipt SHA-256 | Node 26 semantic receipt SHA-256 | Result |
|---|---|---|---|
| [Synthetic semantics](../../generated/r7-release-synthetic-semantics-node24.14.0-v0.1.json) | `f3fb2deb59cef1448530b0b9507428ecb5dc2cd98ab24b83f2bd17dabe78ccb5` | `0fc7d3bf0f4be9c0381483c6ef26db73e06875521bc91b1630ed3a947aff8279` | Partial profile; two-pass determinism passed |
| [Synthetic pressure](../../generated/r7-release-synthetic-pressure-node24.14.0-v0.1.json) | `c281312672052f9e02c0a8937e60d70c639ee7b23f7df84df14acabd650b9b16` | `b06f8a933188aabb2e427a79e6521b2e2a435874fde45fe113ab4bfb94f6519d` | Partial profile; two-pass determinism passed |
| [Materialized boundaries](../../generated/r7-release-materialized-boundaries-node24.14.0-v0.1.json) | `1fc38a56ae672bac2e58b7336ad0abc74d6279d323affe08c5a594e57cb98892` | `8566a396307158169b6defc6e65858ce555651616e80275e306fadcd8c99d1a8` | Partial profile; material cases passed, candidate boundaries unidentified |
| [Real local history](../../generated/r7-release-real-local-history-node24.14.0-v0.1.json) | `eb7441c8493c695be4c80e690f20333d3ef6174936df79fe101212ff20caad3a` | `ce643bd0bc94cdd5321284098170fe89165731d59eb6fc11656136bc35d0eff7` | Partial profile; two-pass determinism passed |
| [Decision](../../generated/r7-release-decision-node24.14.0-v0.1.json) | `43b967ecd1965aa5a996d1e029f6cce046a1ba178e5d49e2cd6b54f98e0f523b` | `9959bd29f622a65a1295a345f715037f26d77856462ef5cbe0917d52e93fd30f` | `release_open`; all 19 dimensions unresolved |

The Node 26 files use the same profile basename with `node26.2.0-v0.1.json`. `test/r7-generated-release-evidence.test.js` requires exactly these ten release files, revalidates each against the current source-bound contract, and exactly rebuilds the decision receipt from the eight non-decision inputs on each qualified runtime.

All twelve retained R7 JSON files, including the two historical smoke receipts, have mode `0600`.

## Profile coverage

### Synthetic semantics

Both runtimes ran all ten lifecycle operations twice. The fixed semantic fixture passed every declared case: Codex root, fork replay, subagent delta, primary and secondary windows; scoped and unattributed accounts; Claude root and subagent events; five-hour and seven-day windows present and absent; fallback iterations; and unrecognized models. Source plan, logical records, chunk boundaries, canonical artifacts, verifier results, fixed failure codes, preservation, and cleanup projections matched between passes.

### Synthetic pressure

Both runtimes used the preregistered fixed shapes: 4,096 source files, 25,000 dense records, a 128-chunk target, 64 KiB and 64 KiB + 1 lines, and separate 8 MiB compressible and seeded incompressible payloads. All ten lifecycle operations completed or recovered as intended in each of two passes, with matching deterministic projections.

### Materialized boundaries

Both runtimes exercised real pathways at smaller injected limits:

- the metadata-bundle producer accepted a 65,536-byte line and rejected 65,537 bytes with `export_resource_line_bytes`;
- compressible and incompressible 8 MiB decoded artifacts passed producer, verifier, and file-control checks;
- decoded and encoded plus-one cases rejected with their fixed compression codes; and
- a workspace file accepted 8 MiB and rejected 8 MiB + 1 through the file-stat resource guard.

The 18 direct candidate-value guard rows accepted the value and rejected value plus one, but remain `synthetic_counter` / `not_identified`. The SQLite batch seam remains explicitly `not_run`. The 100 ms filesystem result is a sampled lower bound and cannot prove 20% headroom.

### Real local history

One frozen 31-day source-prefix plan was used for two fresh passes on each runtime. No durable raw-log or private plan copy was retained.

| Observation | Measured value |
|---|---:|
| Frozen interval | 2,678,400,000 ms (31 days) |
| Codex sources | 1,469 files / 22,452,934,723 bytes |
| Claude sources | 1,147 files / 822,894,699 bytes |
| Combined sources | 2,616 files / 23,275,829,422 bytes |
| Exported metadata records | 441,290 |
| Decoded export-set bytes | 525,861,636 |
| Encoded export-set bytes | 29,509,559 |
| Worst parent operation elapsed | 472,414 ms |
| Worst observed RSS | 836,255,744 bytes |
| Largest sampled task-root bytes | 1,270,520,316 bytes |

The four measured real-history operations were source scan, export-set materialization, independent verification, and complete-set deletion. Their deterministic evidence projections matched between passes on each runtime. The source prefixes were reopened and rehashed after all four passes, and the exact temporary-tree inventory was cleaned.

Both runtimes recorded zero external RSS-sampling failures. Every completed worker also supplied a mandatory terminal lifetime RSS high-water mark, which is enforced even when periodic sampling misses a short-lived peak. Neither runtime retains the private 100 ms sample series.

Compared with the immediately preceding fixed-interval run, discovery found six additional Codex source files and 5,818,444 additional prefix bytes, while the exported logical record count remained exactly 441,290. The release evidence therefore records the larger physical source set without inflating canonical usage events from duplicate/replay-bearing files.

## Privacy and integrity findings

- Export-facing HMAC and random identifiers use 64-character lowercase hex. Stored participant secrets remain 32-byte base64url values, and local source identifiers are re-HMACed before export.
- Every exported string remains subject to the credential/content scanner. There is no derived-identifier exemption.
- A credential-shaped ID fails both schema validation and sensitive-string scanning without echoing its value.
- All old 43-character base64url forms are explicitly rejected at every telemetry, privacy-receipt, bundle, and manifest binding.
- Workload provenance binds 122 executable source, worker, schema, contract-state, package/lock, and generated telemetry-contract inputs. Runtime-loaded JSON changes invalidate retained receipts even when JavaScript is unchanged.
- Real-history receipts retain no paths, timestamps, identifiers, row-level data, raw content, arbitrary errors, private RSS samples, or source-plan digest.
- The terminal zero-link filesystem race is accepted only when transient hardlinks are explicitly enabled, ownership is confirmed, an immediate second lookup returns `ENOENT`, and the task root remains bound. The already observed bytes are conservatively counted; persistent, replaced, unowned, and greater-than-two-link cases still fail closed.
- Network activity remains `not_measured`; transport is disabled and no upload code was introduced.

## Verification commands and results

- Node 24.14.0 complete serial suite: 721 passed, 0 failed.
- Node 26.2.0 complete serial suite: 721 passed, 0 failed.
- Exact ten-receipt matrix and decision rebuild: 2 passed, 0 failed on each runtime.
- Telemetry contract generation check: current at 178 fields on each runtime.
- `git diff --check`: passed.
- Independent code/privacy and performance audits drove final fail-closed fixes before release evidence was regenerated.
- Independent test/documentation audit requires the supported default test command to run serially; `npm test` is pinned to `--test-concurrency=1` and guarded by regression.

## Remaining release boundary

R7 measurement implementation is complete, but the resource-policy release remains open. No current candidate ceiling has been promoted or lowered. Required future evidence is enumerated in the paired decision record and must be collected under a new preregistered amendment rather than inferred from these observations.
