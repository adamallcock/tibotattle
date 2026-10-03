---
title: Telemetry bounds byte-length investigation
date: 2026-10-03
type: receipt
status: prototype-measured-host-binding-pending
---

# Recommendation and scope

Keep `JSON.stringify` and replace only UTF-8 buffer construction with `Buffer.byteLength(serialized, "utf8")` at an explicitly Node-only composition boundary if the coordinator accepts the measured scope. Do not import Node into the runtime-neutral telemetry package. The portable UTF-8 scan is exact but slower on Unicode and large ASCII strings; it is not recommended as a general package change. Descriptor-derived JSON counting is rejected for arbitrary admitted inputs because it changes serialization effects.

This investigation uses clean Wave26 `e5710f174e38d5ac8c710bcde428aebf17500b2e` in the isolated `codex/byte-bounds-20261003` worktree. [The private benchmark](../../apps/worker/scripts/telemetry-byte-bounds-benchmark.mjs) transforms canonical primitives only in its own esbuild invocation. No production package, facade, vendor, mirror, generator, build binding, registry, resource budget or candidate checkout changed. No corpus import, database, cloud operation or network request ran. All fixtures are synthetic.

## Semantics

The unchanged descriptor walk rejects non-JSON primitives, nonfinite numbers, hidden/accessor fields, sparse or extra-field arrays, non-ordinary objects, excessive depth/arrays, cycles and repeated shared references. Its exact error order remains before serialization. It does not make every admitted object a pure immutable JSON tree: ordinary-prototype Proxies can return different values during JSON property reads, and inherited `toJSON` can transform input, run side effects, throw or return undefined/BigInt.

Both exact variants retain the original complete `JSON.stringify` call, exception sanitization, string-type check and strictly-greater-than byte threshold. Neither stops early at a limit. The portable counter scans UTF-16 with replacement of lone surrogates; its ASCII fast path uses a regex. The Node-only research bundle imports `node:buffer`; no runtime-neutral source imports Node.

The research descriptor comparator is explicitly ineligible for arbitrary bounds inputs. It skips full string materialization but ignores inherited serialization hooks. Tests prove mismatches in byte acceptance and/or observable read/hook traces for both accepted Proxy and inherited-toJSON inputs. MODEL-RESIDUE's closed reducer-entry byte counter does not establish a general public JSON serializer contract here.

## Differential proof

[The focused test](../../test/telemetry-byte-bounds.test.js) compares the portable scan with TextEncoder for every one of the 65,536 UTF-16 single units, their JSON-escaped forms, sampled supplementary pairs, and 1,000 deterministic 64-unit fuzz strings plus escaped forms. It covers control escapes, quote/backslash, U+2028/U+2029, surrogate pairs and lone surrogates.

There are 334 stringify-preserving comparisons across success/return values, B−1/B/B+1 thresholds, -0, finite exponent/digit cases, null-prototype objects, invalid options, depth/array errors, hidden/accessor/symbol fields, sparse arrays, nonfinite/BigInt/function/symbol values, shared/cyclic input, inherited object/array-toJSON and inherited-accessor effects/failures, serialization-introduced cycles and Proxy reads. Compared failures include error class name, message, code and detailCode; side-effect traces match. The two exact variants have zero mismatches. The restricted descriptor comparator deliberately demonstrates semantic mismatches and is never production-bound.

## Synthetic measurements

Node 22.16.0 on the local macOS host. Whole-validator timings use three symmetric six-phase cycles: oracle, portable scan, Buffer, Buffer, portable scan, oracle. Small records use 100,000 calls per phase; arrays use 1,000. Table values are the six-phase medians per variant. One-minute host load ranges were 4.55–4.62. These are bounded local synthetic results, not a full-refresh speed claim.

| Shape | Serialized UTF-8 bytes | Original µs/call | Portable scan µs/call | Node Buffer µs/call |
| --- | ---: | ---: | ---: | ---: |
| ASCII record | 197 | 1.3180 | 1.2664 | 1.1626 |
| Unicode record | 202 | 1.4902 | 1.6219 | 1.3299 |
| 200-entry ASCII array | 41,903 | 276.7317 | 288.1629 | 276.3830 |

Buffer improved the small records by approximately 11.8% and 10.8%; the array's 0.13% change is not a meaningful whole-validator CPU win. The portable scan regressed the Unicode/array cases.

For a pre-serialized 41,903-byte array, an isolated length-only symmetric probe at 10,000 calls per phase measured medians of 2.1197 µs for TextEncoder, 19.6387 µs for the portable scan and 0.8386 µs for Buffer. This removes stringify and validation from the measured section.

Managed V8 heap allocation was separately counted from GC trace `allocated` fields between forced collections, including small phase-marker overhead. The raw trace's allocation total excludes the UTF-8 backing store, so it must not be presented as total allocated bytes:

| Shape | Original managed bytes/call | Portable managed bytes/call | Buffer managed bytes/call | UTF-8 backing bytes eliminated/call |
| --- | ---: | ---: | ---: | ---: |
| ASCII record | 2,597.25 | 2,437.22 | 2,382.33 | 197 |
| Unicode record | 2,797.81 | 2,638.35 | 2,582.10 | 202 |
| 200-entry array | 514,995.36 | 514,995.84 | 514,995.74 | 41,903 |

Allocation probes used 10,000/10,000/1,000 calls respectively, at one-minute load 5.24–5.26. Each original successful call constructs a fresh Uint8Array of exactly the serialized UTF-8 byte length; both exact replacements construct none. The backing-byte column is this exact removed allocation from source semantics, separate from the measured managed-heap figures. Descriptor validation allocation dominates the large array, and managed-heap differences there are noise.

## Validation and remaining admission

The exact checkpoint will be reviewed for scan correctness, transform scope, error/effect parity and allocation accounting. Run the focused test, root preflight and architecture at the committed checkpoint. Production closure registration, canonical/mirror handling and any Node facade binding are coordinator decisions; none are pre-authorized by this synthetic result.

A Node-only production composition must bind the same exact byte-length operation without changing the descriptor walk or stringify, preserve the portable fallback in Worker/browser builds, and prove resolution/closure hashing with its owning gates. It needs a combined analytics/full-refresh check and measured memory/CPU impact after any privacy-walk optimization. No general incremental JSON serializer should be admitted without a separately closed stable-data contract or a complete semantic proof for inherited hooks and Proxies.

Reproduction from the repository root:

```sh
node --test test/telemetry-byte-bounds.test.js
node --expose-gc apps/worker/scripts/telemetry-byte-bounds-benchmark.mjs --kind=ascii --calls=100000 --timing-only
node --expose-gc apps/worker/scripts/telemetry-byte-bounds-benchmark.mjs --kind=unicode --calls=100000 --timing-only
node --expose-gc apps/worker/scripts/telemetry-byte-bounds-benchmark.mjs --kind=array --calls=1000 --timing-only
node --expose-gc apps/worker/scripts/telemetry-byte-bounds-benchmark.mjs --kind=array --calls=10000 --length-only
node --expose-gc apps/worker/scripts/telemetry-byte-bounds-benchmark.mjs --kind=ascii --calls=10000
```

Content-free logs and aggregate JSONL measurements remain under `/private/tmp/tibotattle-byte-bounds-evidence-20261003/` until the coordinator archives this checkpoint. Dependencies reuse this agent's stable completed MODEL-RESIDUE dependency trees; no other agent's files were changed.
