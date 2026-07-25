---
title: G1 R7 Synthetic Smoke Verification Receipt
date: 2026-07-25
type: verification-receipt
status: partial
---

# G1 R7 Synthetic Smoke Verification Receipt

## Verdict

The R7 measurement machinery has a verified, privacy-safe synthetic smoke checkpoint on the two preregistered comparison runtimes for macOS arm64. It is **not measured release-ceiling evidence**, does not select a release policy, and does not close R7.

The accurate label is: **Node 24.14.0 and Node 26.2.0 macOS-arm64 synthetic lifecycle smoke plus direct resource-guard boundary checks**.

## Bound artifacts

- Receipt schema: `r7-resource-benchmark-receipt-v0.1`
- Receipt schema SHA-256: `116a60aa5ab79d8c6b91dcde5b054da4f3ef1f55c01251f12a47df01fc9fcbf8`
- Benchmark protocol: `g1-r7-resource-benchmark-v0.1`
- Selection rule: `g1-r7-ceiling-selection-v0.1`
- Candidate resource policy: `g1-r3-candidate-0.5`
- Deterministic projection: `g1-r7-deterministic-projection-v0.1`
- Bound implementation source set: all 84 `src/*.js` modules, the benchmark worker, `package.json`, and `pnpm-lock.yaml` (87 files total)
- Ad hoc local receipts are owner-only and Git-ignored under `.usage-monitor/`. The two reviewed synthetic, content-free receipts for this checkpoint are durably retained in `generated/` so either runtime claim can be revalidated.

| Runtime | Runtime class | Machine-readable artifact | Semantic receipt SHA-256 (`receiptSha256`) | File-byte SHA-256 | Validation |
|---|---|---|---|---|---|
| Node 24.14.0 | pinned candidate | [`generated/r7-resource-benchmark-smoke-node24.14.0-v0.1.json`](./generated/r7-resource-benchmark-smoke-node24.14.0-v0.1.json) | `14d1959f888202f98cc447a3399c60528d430af48d4449a2d517c0458b9afac6` | `1124a70de557c6826e645ef626ddad2d99a1a6c4fe7e5611809df6734ae2d619` | Schema pass; 8 checks matched |
| Node 26.2.0 | compatibility cross-check | [`generated/r7-resource-benchmark-smoke-node26.2.0-v0.1.json`](./generated/r7-resource-benchmark-smoke-node26.2.0-v0.1.json) | `de86805c79ba113a2ddcf633d319465b32ebf604e18982ae4a440b3714da1c0c` | `d8f59c9d81fd54629cb3cd6a44661f34f364eca37aca2246d5f64450db3f1284` | Schema pass; 8 checks matched |

Arbitrary Node 24 or Node 26 versions cannot be labeled qualified. The strict contract accepts exactly Node 24.14.0 or Node 26.2.0 and checks that the runtime class matches the exact version.

## What was exercised

Each runtime executed two fresh lifecycle passes over the same immutable structural fixture. All ten named operations ran; the three recovery operations are explicitly labeled `interrupted_recovered`, not ordinary completion.

- source scan;
- checkpoint resume;
- export-set materialization;
- independent export-set verification;
- complete-set deletion;
- committed deletion recovery;
- failed-workspace discard;
- committed discard recovery;
- Claude callback uninstall; and
- Claude callback recovery.

The receipt binds two evidence SHA-256 values for every operation. Separate comparisons cover fixture manifest, source plan, logical records, chunk boundaries, canonical artifacts, the deterministic lifecycle projection, mapped operation/recovery and boundary failure codes, and cleanup inventory structure. Timing, CPU, and RSS are deliberately excluded from deterministic equality. The semantic validator independently requires matching hashes whenever a receipt claims matched deterministic evidence.

The harness independently rehashed the synthetic input fixture, identity sentinel, unrelated output sentinel, and original Claude settings. All were preserved. Child workers inherit only fixed locale/time-zone variables, not the parent environment. The temporary benchmark tree is deleted only after a bounded exact inventory is re-enumerated and every regular single-link file is revalidated; symlinks, hardlinks, unsupported entries, replacements, and inventory drift stop cleanup. Broad recursive deletion is not used.

## Observed smoke envelope

These figures describe a 5-source, 10-record, 4-chunk synthetic smoke. They are measurements of the harness, not selected ceilings and not representative-user percentiles.

| Operation | Worst wall ms | Worst CPU ms | Worst peak RSS bytes | Durable elapsed ms | Workspace high-water bytes | Output/affected evidence |
|---|---:|---:|---:|---:|---:|---|
| Source scan | 63 | 51 | 120,307,712 | 52 | 1,237,512 | 10 records |
| Checkpoint resume | 37 | 32 | 131,334,144 | 53 | 1,237,512 | 10 records |
| Materialize | 263 | 68 | 120,766,464 | 300 | 1,237,512 | 10 records, 4 chunks |
| Verify | 18 | 24 | 122,454,016 | 0 | 0 | 10 records, 4 chunks |
| Complete delete | 212 | 80 | 125,960,192 | 0 | 0 | 11 files, 198,977 bytes |
| Delete recovery | 130 | 20 | 117,997,568 | 0 | 0 | 11 files, 198,977 bytes |
| Workspace discard | 65 | 18 | 118,456,320 | 0 | 0 | 1 file, 143,360 bytes |
| Discard recovery | 56 | 14 | 118,816,768 | 0 | 0 | 1 file, 143,360 bytes |
| Callback uninstall | 36 | 6 | 112,263,168 | 0 | 0 | settings and capability preserved |
| Callback recovery | 28 | 6 | 116,031,488 | 0 | 0 | settings and capability preserved |

`peakRssBytes` conservatively takes the maximum of the isolated worker process high-water and durable workspace RSS evidence. Durable elapsed and durable RSS remain separate receipt fields rather than being hidden by a fresh resume worker.

## Boundary evidence

The direct guard matrix covers all 19 policy dimensions:

- 18 guard methods accept the candidate value and reject candidate plus one with a fixed resource code;
- none of those 18 is labeled an identified producer or verifier ceiling, because an actual near-limit producer/verifier pathway was not run;
- encoded-artifact and workspace ceilings remain independently unidentified;
- the SQLite batch-record boundary remains not run; and
- all producer and verifier integration surfaces remain `not_run` in this smoke receipt.

This corrects the earlier overstatement that 16 direct guard probes established integrated enforcement.

## Privacy and validation evidence

- The receipt schema recursively denies unknown fields and has a semantic self-hash.
- Receipt content contains only fixed enums, counts, resource values, and hashes.
- Privacy scans found no content canary, participant/account/session pseudonym, username, or local home path.
- `networkActivity` is `not_measured`, not falsely claimed absent.
- `transportReady` is false and no upload path was introduced.
- `secureErasureClaimed` is false.
- Focused R7 tests: 17 passed, 0 failed on Node 26.2.0, including root-replacement refusal, semantic hash-mutation cases, and revalidation of both checked-in runtime receipts.
- Full serial suite: 632 passed, 0 failed on Node 26.2.0.
- Full serial suite: 632 passed, 0 failed on Node 24.14.0.
- Telemetry contract check: current at 178 fields; 10 passed, 0 failed.
- `git diff --check`: pass at this checkpoint.

## Explicit non-claims and open R7 work

R7 remains open because this checkpoint does not provide:

- a release/heavy-history profile—the CLI deliberately refuses `--profile release`;
- a real local heavy-history run over Codex and Claude logs;
- the preregistered fork/replay, unknown account/model, missing quota-window, fallback-iteration, many-file, long-line, dense-record, compression-extreme, chunk-pressure, or near-limit-manifest cases;
- materialized producer and verifier value/plus-one evidence per applicable dimension;
- an exercised SQLite batch boundary;
- independently selected retain/lower decisions for all ceilings;
- a promoted release-policy version;
- external RSS sampling, a parent RSS watchdog, or a measured zero-network trace;
- elapsed/RSS policy enforcement for deletion, discard, and callback cleanup through a shared parent watchdog—the smoke harness currently has a bounded worker timeout and post-operation RSS measurement;
- output/transient filesystem high-water measurement for every lifecycle stage;
- multi-machine or bounded RAM-class evidence;
- population p95 evidence; and
- final independent audit closure after the release workload exists.

The next R7 checkpoint must implement the refused release profile, execute the complete preregistered workload and real heavy-history cases on both runtimes, enforce materialized boundaries at producer and verifier surfaces, make per-dimension decisions, and only then promote a release policy.
