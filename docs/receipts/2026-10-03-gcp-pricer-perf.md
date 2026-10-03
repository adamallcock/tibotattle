---
title: GCP per-event pricer performance
date: 2026-10-03
type: receipt
status: verified
---

Local source and synthetic proof on `claude/gcp-fp-pricer-perf`, based on
`779eb4d1254a8fd3abafb72bfb3bd324d307c28a` (`claude/gcp-fastpath-final`).
The dirty main checkout, sibling worktrees and cutover checklist were untouched.
No push, deployment, gcloud, Wrangler or remote operation was performed.

The GCP Node 22 pricer compiles component rates and scalar audit metadata through
nine original-pricer probes per model/provider/surface/tier/speed/time/context
cell. Its bounded structural cache holds at most 16,384 plans and retains no
input row or priced event result. Ordinary integer-token events use exact
integer nanousd arithmetic, one USD formatting pass and the original BigInt
coverage division. Large, malformed, inherited, accessor-bearing, proxy or
unsupported inputs execute the unchanged oracle. Result arrays remain fresh.

K-PERCARD calls the fast pricer directly. The Cloud Run esbuild plugin binds
only the vendored quota-analysis-v1 import of `./server-pricing`, accelerating
record pricing, daily folds, shared reducers and native V11 reduction without
editing a vendor byte. The vendor facade still exports the independent oracle;
Vitest's original vendor resolution remains intact. Bound/unbound esbuild
composition checks prove that daily, effective and scalar/model paths execute
the binding and return identical JSON.

Proof on Node `v22.16.0`, macOS arm64, Apple M5 Max:

- 3,000,000 deterministic generated events plus 81,122 exhaustive boundary/shape
  cases: zero differences in JSON bytes or exception class/message; 128,841
  matching exceptions. Covers 58 model/catalog identities, 53 time cases,
  11 context cases, 17 reason codes and all three coverage statuses.
- Every synthetic usage row: 6,857,851 event comparisons plus 6,857,851
  bound/unbound record-adapter comparisons; zero differences. Format counts:
  v1.0 738,860; v1.1 5,151,789; v1.2 967,202. Combined total: 16,796,824
  differential comparisons. Full proof wall time: 548.29 seconds.
- Focused GCP pricing/composition checks: 8 passed. Complete analytics gate:
  20 files / 215 tests passed, including all kernel-parity specs.
- Vendor gate: 57 passed. Accounting core, API adapter, speed and package gates:
  83 passed. Kernel registry: 9 passed. Typecheck, architecture, root preflight,
  documentation and audited Cloud Run context checks passed.
- Existing accounting tests had omitted four previously added Anthropic cards.
  Updated counts/source coverage, added exact rate/validity assertions and kept
  both original legacy-card hashes. No accounting source or price changed.

The compute closure gained exactly kernel 4; entries 1–3 and their pins remain
unchanged. Binding policy bytes participate in its identity and an unbound
import graph is rejected. Registry v0.8 remains unchanged at
`48119389ecbcaced58837bc24fa852c3c4a99835289b417e69f34fb0166a63b9`.

- Compute closure: `ea61ae40ae050fe1285c856beab4cf6d6f51d2a837b4b55a53ca1a390b95fd6a`
- Compute class: `ad14b8811cdaaf545424b4c2eaf1c543aec86cbd93aa7d1c667cfa91e4dd2949`
- Vendor manifest: `b40d075f06380d6a83ac0dbf77183c90ce7e522e6613048c966860394ef6eb6e`

Benchmark: 6,890 corpus-shaped records (758 v1.0 / 5,168 v1.1 / 964 v1.2),
200,000 calls per batch, three separate untraced CPU runs per configuration
(median); separate GC-traced allocation run. CPU includes user and system time.

| Entry / state | CPU µs before → after | CPU factor | Bytes allocated before → after | Allocation factor | Scavenges/million before → after |
|---|---:|---:|---:|---:|---:|
| Event / cold | 26.5033 → 1.1502 | 23.04× | 82,954.39 → 2,540.09 | 32.66× | 5,060 → 160 |
| Event / warm | 26.3153 → 1.0049 | 26.19× | 83,307.22 → 2,444.32 | 34.08× | 5,060 → 145 |
| Stored record / cold | 30.0492 → 2.1363 | 14.07× | 83,263.34 → 3,293.14 | 25.28× | 5,060 → 200 |
| Stored record / warm | 26.8629 → 2.2316 | 12.04× | 84,617.23 → 3,193.60 | 26.50× | 5,140 → 190 |

At 115–130 million stored-record calls, the warm figures project savings of
2,832.60–3,202.07 CPU seconds and 9,363.72–10,585.07 decimal GB of allocation
volume. Cold batches project 3,209.98–3,628.67 CPU seconds and
9,196.57–10,396.13 GB saved. This assumes the same mix and call count.
Allocation is V8 `trace-gc-nvp` allocation volume plus the uncollected heap tail.
Cold means an empty plan cache and no pricer/JIT warm-up at batch start;
compilation is amortized across that batch. An individual new-cell miss executes
nine probes; fallback cases retain reference-pricer cost. These are local
per-call measurements; full-refresh wall time, cloud charges and deployed
behavior remain unmeasured.

Separate `--cpu-prof --heap-prof` runs were collected for both warm record paths.
The reference CPU profile's largest self-time sites include `parseDecimal`,
`calculateCost`, `priceUsageEvent`, decimal formatting and GC; the fast profile
is concentrated in `fastPrice` and the unchanged stored-JSON parser.

Reproduce from `apps/worker/` with Node 22.16.0 and the manifest-asserted full
synthetic corpus as `$PRICER_SYNTHETIC_CORPUS`:

```sh
npm run analytics-v2:pricer:fuzz -- --events=3000000 --corpus="$PRICER_SYNTHETIC_CORPUS"
npm run analytics-v2:pricer:benchmark -- --corpus="$PRICER_SYNTHETIC_CORPUS" --calls=200000 --repeats=3
npm run vendor:kernels:check
npm run analytics-v2:check
npm run typecheck
node --test scripts/analytics-v2-kernel-registry.check.mjs
node scripts/cloud-run-build-context.mjs --check
```

From the repository root:

```sh
node --test --test-concurrency=1 test/cost-ledger.test.js test/price-registry.test.js test/local-api-pricing.test.js test/fast-mode-accounting.test.js test/fast-mode-priority-eligibility.test.js test/fast-mode-speed-precedence.test.js test/accounting-package-parity.test.js test/accounting-package-boundary.test.js
npm run test:preflight
npm run architecture:check
npm run docs:check
```
