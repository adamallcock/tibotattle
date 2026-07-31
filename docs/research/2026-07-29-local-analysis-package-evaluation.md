---
title: Local Analysis Package Evaluation
date: 2026-07-29
type: research
status: completed
---

# Local Analysis Package Evaluation

## Decision

Use Node's built-in `node:sqlite`, `node:worker_threads`, bounded file reads,
and native `JSON.parse`. Add no new runtime package.

This is a measured decision. In the final virgin receipt, ten workers scanned
30.39 GB in 6.53–6.81 seconds. SQLite fact-index construction took
0.17–0.40 seconds. The changes that materially reduced wall time were removing
repeated source passes, compacting replay state, fusing projection, and caching
the pricing plan—not substituting the JSON parser or SQLite binding.

## Candidate screening

| Candidate | Current package evidence | Fit and measured decision |
|---|---|---|
| [`node:sqlite`](https://nodejs.org/api/sqlite.html) | Bundled with the supported Node 22.13+ runtime; prepared statements, synchronous iteration, defensive mode, timeouts, and read-only opens | **Use.** No ABI, signing, notarization, or supply-chain addition. Existing repository code already depends on it. |
| [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) | npm 13.0.2, Node 22+, MIT, 27.35 MB unpacked | **Do not add.** It is a strong SQLite binding, but measured secondary-index construction is below 0.4 seconds and replacing the binding cannot materially improve the achieved 18.89-second median. It would add a native binary and packaging surface. |
| [`Piscina`](https://github.com/piscinajs/piscina) | npm 5.3.0, Node 20+, MIT, 431 KB unpacked | **Do not add.** Built-in workers already provide fixed resource limits, source-affine scheduling, cancellation, and backpressure. Extraction is not the remaining bottleneck. |
| [`stream-json`](https://github.com/uhop/stream-json) | npm 3.5.0, Node 22+, BSD-3-Clause, 390 KB unpacked | **Do not add.** It is designed to stream one large JSON document. The source is independent JSONL records, already bounded by complete-line framing; token-stream reconstruction would add work without removing a measured pass. |
| [`everything-json`](https://www.npmjs.com/package/everything-json) | npm 1.2.1, Node 18+, ISC, 7.76 MB unpacked, last modified 2025-05-17 | **Do not add.** Its SIMD two-stage parser is attractive for selective large-document access, but relevant Usage Monitor records still require object conversion and most JSONL lines are rejected by a byte-level type prefix. The whole extraction stage is already about 6.6 seconds. |
| [`lmdb`](https://github.com/kriszyp/lmdb-js) | npm 3.5.6, MIT, 2.54 MB unpacked, modified 2026-06-18 | **Do not add.** LMDB is an excellent ordered key/value engine, but lineage joins, interval facts, quota tracks, schema validation, and projection rows map directly to SQLite. Reimplementing those contracts would raise correctness and migration risk without a measured I/O bottleneck. |
| [`simdjson`](https://www.npmjs.com/package/simdjson) | npm 0.9.2, Apache-2.0, 39.24 MB unpacked, last modified 2022-05-17 | **Reject.** The Node package is stale and large, with native build/ABI risk. |

## Why the selected stack wins here

The final phase distribution is approximately:

- discovery and boundary proof: 0.34–0.38 seconds;
- bounded JSONL extraction: 6.53–6.81 seconds;
- exact replay derivation plus fused projection: 9.83–10.24 seconds;
- fact-index construction: 0.17–0.40 seconds; and
- calibration, serialization, integrity check, sync, and publication:
  roughly 1.5 seconds.

Even a hypothetical zero-cost parser would not replace the exact replay,
pricing, quota, and publication work. The dependency decision should therefore
be revisited only if a future receipt shows extraction dominating again, or if
a package can demonstrate at least a two-second end-to-end median improvement
on this corpus while meeting the same privacy, crash, memory, and packaging
constraints.
