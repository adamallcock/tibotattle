---
title: GCP model residue source and synthetic proof
date: 2026-10-03
type: receipt
status: source-implemented-refresh-measurement-pending
---

# Scope and claim boundary

MODEL-RESIDUE removes repeated quota mapping and whole-state JSON sizing on the coordinator-approved `48c26716a478bf92a830c27ea9c8ab7a90a0d929` base. The quota change is commit `1d7896374`; the independent byte-accounting change is `264b8020`. Existing prerequisite assertion corrections `28c2c1cb` and `c63ebd48` were reused, rather than duplicated. No registry entry, resource budget, cloud setting, corpus import, private PostgreSQL cluster or external write was changed. Full refresh parity, performance targets and combined memory admission remain unqualified.

The complete model-residue brief and performance brief index govern the remaining measurements. This receipt does not prove the L2 refusal-inclusion contract. Its fixture is private to MODEL-RESIDUE.

## Implementation

[The quota helper](../../apps/worker/src/analytics-v2/native-path.ts) stores a flat primitive template in a WeakMap keyed by the occurrence object. A hit requires unchanged record JSON, event time and day, compatible quota status, and a positive safe ordinal. Every hit constructs fresh unfrozen outer/active objects in the vendored key order. Every miss executes the original mapper; throwing calls create no template. Repeated vocabulary strings are value-interned in a table capped at 4,096 entries. Dropped row/template objects can be collected; bounded interned strings can remain.

Only the two quota mapping sites and new helper changed in native-path. The shared preparer still makes its own original-map call. Reader parsing and acquisition phase/page grouping are unchanged. Model-block clones rebuild their own memo; the parent may retain a separate memo while holding its horizon rows.

[The generator](../../apps/worker/scripts/vendor-analytics-kernels.mjs) applies exactly one new named `reduction-payload-bytes` SOURCE_PATCH. The generated vendor source and manifest were regenerated with that generator. A tracked Map captures an entry before its first get/set in a check interval, then counts only touched entries. This covers scalar/model in-place mutations through get. Hazards first walk the exact snapshot, then account each pushed/popped interval and structural comma. The tracked Set accounts newly admitted numbers. Each rebuilt call starts with a fresh exact Map/Hazards walk. The production page size, predicate text, call signature, refusal order, finalized-hazard throw and checkpoint serializer remain unchanged.

The JSON counter handles UTF-8, escaping, lone surrogates, finite/non-finite numbers, -0, omitted object values and null array entries. Non-plain entries use JSON.stringify themselves. The tracked structures contain the closed data constructed by the kernel; reducer writes were audited through get/set/add. Arbitrary external mutation bypassing those entry points is not an admitted kernel path.

## Focused proof

[Quota specs](../../apps/worker/analytics-v2-test/quota-row-memo.spec.ts) passed 4/4. They cover 4,200 synthetic rows across the intern bound and four ordinals, key-order equality, fresh mutable objects, primitive fields, changed keys, invalid ordinals/days, guard failures/retries, and WeakRef collection.

The map-count proof calls the original mapper once as a preparation surrogate, then drives 128 occurrence objects through the helper directly across 71 windows × four phases. Each object's instrumented original-map count is exactly two. This is a helper mechanism proof; actual native preparation/acquisition and all reader parse counts remain corpus instrumentation gates.

[Vendor source specs](../../apps/worker/analytics-v2-test/vendor-source-patches.spec.ts) passed 16/16 in 33.12 seconds under Node 22.16.0. New cases cover all controls, 2/3/4-byte UTF-8, quotes/backslashes, lone surrogates, U+2028/U+2029, DEL, special/unsafe numbers, fullyPriced flips, get-only bucket updates, replacement session scopes, extra hazard properties/pop merges and finalized hazards. The first check after more than 4,096 entries is compared through the actual production predicate, including resumed calls. A large-cost partial refusal is counted before its bucket is omitted from the successor.

[The harness](../../apps/worker/scripts/gcp-model-residue-check-lib.mjs) exports internals and injects per-page oracle comparisons only in its own esbuild invocation. The oracle reverses only the named patch. Production imports/builds do not reach it. Raw/prepared scalar/model fixtures resume with maxPages 1, 2 and 3; B−1/B/B+1 limits refuse on the same resumed page. JSON checkpoint SHA256 values match at every returned call, with no payload emitted or retained as evidence.

The private fixture crosses the actual default 8,388,608-byte bound:

| Path | Refusal rows | Page | Previous-page bytes | Refusal-page bytes | Checked pages |
| --- | ---: | ---: | ---: | ---: | ---: |
| Raw usage | 40,600 | 203 | 8,363,622 | 8,405,022 | 203 |
| Prepared feature keys | 43,800 | 219 | 8,372,022 | 8,410,422 | 219 |

All 422 default-bound page integers matched the stringify-and-encode oracle. Both refusals were complete and occurred on resumed calls. This is MODEL-RESIDUE parity within each path, not an L2 raw/prepared inclusion claim.

## Bounded micro measurements

[The benchmark](../../apps/worker/scripts/gcp-model-residue-benchmark.mjs) uses synthetic rows only, Node 22.16.0 and forced GC. Its quota differential compared 4,000 results with zero mismatches and one memo miss per successfully mapped row. It can also read every quota occurrence through the real GCP reader using a coordinator-supplied read-only synthetic context module; that corpus mode has not run.

With 100,000 calls and corpus-width synthetic quota identifiers, vendored mapping took 10.4305 µs/call and memo hits 0.05770 µs/call. The one-minute load was 7.11 → 7.11. Measured scavenges were 1,120 versus 10 per million calls. A separate GC-trace run bracketed each phase with forced collections: allocated bytes/call were 15,163.66 for the vendored map and 276.90 for hits over 100,000 calls, including small phase-marker overhead. Its one-minute load was 5.75; scavenges were 1,240 versus 10 per million. Net heap differences are not allocation totals.

After the first exact walk, 20 evaluations touching one existing entry each gave:

| Entries | Stringify/encode ms | Incremental ms | One-minute load |
| ---: | ---: | ---: | ---: |
| 1,000 | 4.6101 | 0.1801 | 11.80 |
| 10,000 | 43.0570 | 0.0787 | 11.80 |
| 50,000 | 230.1716 | 0.0643 | 11.80 |
| 100,000 | 484.7861 | 0.0676 | 11.80 |

These isolate subsequent delta checks; they do not include call construction or the first exact walk. The separate first exact walk took 1.714 ms at 1,000 entries, 7.216 ms at 10,000, 28.610 ms at 50,000 and 51.204 ms at 100,000, with one-minute load 5.85. It remains linear in the current state, once per rebuilt call. A whole 200,000-row synthetic window with 20,000 retained sessions and 200-row pages ran in one call: oracle 11.8354 s, candidate 7.9835 s. Both finished without refusal and returned checkpoint SHA256 `2a7af252831887599036780ed141a89625b284820629ff0b12bf4a26544b73e1`. One-minute loads were 11.80 → 10.87 and 10.87 → 10.48 respectively. Minor collections were 1,375/1,241 and observed GC time 523.27/315.58 ms. This is one loaded-host synthetic run, not refresh A/B or a production speed claim.

## Material memory risk

Forced-GC retained-size tests over 100,000 rows measured:

| Identifier shape | Retained bytes | Bytes/row | Largest-owner projection |
| --- | ---: | ---: | ---: |
| Short synthetic identifier | 31,554,000 | 315.54 | 107.17 MiB |
| quota-occurrence:v1 prefix and 64 hex characters | 37,952,920 | 379.5292 | 128.91 MiB |

Existing full/probe synthetic manifests agree that the largest quota owner has 356,146 quota rows and 2,500,708 total records. Full aggregate quota count is 1,145,502; the two-owner probe contains 356,195 quota rows. Only aggregates were read/emitted. The projections multiply the sample bytes/row by the largest-owner count; they are not actual owner-retained measurements. Identifier mix, reset strings, intern occupancy and horizon selection can change the real footprint.

A parent retaining horizon occurrences while a model-block child maps cloned occurrences may hold two independent caches. The 128.91 MiB estimate per isolate materially exceeds the historical 42 MiB headroom cited by the brief. No dense-workers success or admission-budget sufficiency is claimed. KPAR/model-block owners received both measurements; resource estimates were not edited.

## Validation and remaining gates

Part A alone, frozen at `41e19cc9871478a125f510949fd59e575b8e36aa` (approved base plus both existing prerequisite fixes and A, without B), passed 25 files/258 analytics tests under Node 22.16.0 in 332.71 seconds. Vendor, typecheck, root preflight and architecture passed. Part B alone, frozen at `bd19a13eb2ae06e29f40a80d882ae2f31f7082af` (approved base plus both prerequisite fixes and B, without A), passed 24 files/261 analytics tests in 315.21 seconds. Its vendor, typecheck, preflight and architecture gates passed. Independent review verified B source equality with `264b8020`, found no actionable source defect and independently passed all 16 vendor-source specs in 20.93 seconds.

The earlier A runs stopped on known pricer/plugin assertion prerequisites; the earlier mixed-snapshot combined attempt remains failed/unqualified history. Both fixes were applied before either final standalone gate began; neither source tree changed during its gate. Complete combined analytics qualification is pending; no assertions were weakened.

Closure registration, Cloud Run build/check and gcp:fastpath:scripts-check are deferred to the integrator's combined registry/pin fold. No local provisional entry is left behind.

Remaining scheduled evidence:

1. Run the real-reader quota differential over full/o01 clones and count actual map/reader parse calls, preserving the existing two reader parses separately.
2. Run check-mode scalar/model windows on o01, s015, Q-1 and dense; compare window table row SHA256 and masked full output digests.
3. CPU-profile o01 mapping/reduction, recording inclusive helper/original time, model wall, GC and heap/RSS. Run s015/o05 ABBA with host load.
4. Confirm allocation and first-walk costs with the corpus mix; measure combined parent/child dense-workers heap peaks against unchanged budgets.
5. After measured local savings, project with the program's model factor 2.51 and labelled owner/total-work bounds. No cloud saving is inferred from these micro measurements.

No private PostgreSQL cluster was created, so none required teardown. Validation worktrees are local throwaway copies; the implementation branch is preserved. No corpus disk footprint or private session data was created.

## Reproduction commands

Use Node 22.16.0 and the lane's refreshed dependencies. The bounded synthetic harness has no database dependency:

```sh
cd apps/worker
node --expose-gc scripts/gcp-model-residue-benchmark.mjs --quota-only
node --expose-gc scripts/gcp-model-residue-benchmark.mjs --bytes-only
node --expose-gc scripts/gcp-model-residue-benchmark.mjs --proof-only
node --expose-gc scripts/gcp-model-residue-benchmark.mjs --first-walk-only
node --expose-gc scripts/gcp-model-residue-benchmark.mjs --allocation-only
```

The scheduled corpus checker accepts `node scripts/gcp-model-residue-quota-check.mjs --fixture=/absolute/coordinator-context.mjs`. The context module exports `context`, `owners`, `fromDay`, `throughDay`, and optional `close`; it must use coordinator-owned read-only synthetic sources. It emits aggregate counts and digests only.
