---
title: GCP MODEL-BLOCKS source proof and pending measurements
date: 2026-10-03
type: receipt
status: source-validated-qualification-pending
---

MODEL-BLOCKS is implemented against coordinator-approved base
`48c26716a478bf92a830c27ea9c8ab7a90a0d929`, containing FINAL, REFRESH, corrected
KPAR, SEMI and W1E. Inline stage checkpoint `9521de35` preceded Worker dispatch;
`08d2aff8` bounded the sequence observer; `d974ead7` added dispatch and the
independent observer oracle; `f1e0e5ca` repaired child termination rejection and
proved earlier output-budget refusal takes precedence over a speculative later
terminal error. Worktree: `/private/tmp/tibotattle-perf-model-blocks-20261003`,
branch `codex/perf-model-blocks-20261003`. No deployed, production-qualified or
registered serving artifact is claimed.

The owner recomposes pure prepare/cache/scalar/model stages, preserving its
public signature, emitted row/refusal sequence, progress and phase clocks.
`--model-block-size` defaults to 10 (1–70), `--model-fanout` to `auto`
(`auto|all|off`); auto uses exact maximum 101-day usage evidence >120,000. Each
owner retains its final block. Requests are immediately granted or refused;
refused blocks evaluate locally. Granted inputs are window-trimmed full prepared
shapes, serialized once and transferred on a direct MessageChannel. All results
replay by date before the existing owner-digest merge. Per-date, per-phase quota
acquisition stays unchanged. The rolling sequence digest is diagnostic only,
retains one digest/current canonical row, and exposes only 64 hex characters.

Admission preserves the accepted owner heap model and output resource verdicts.
A child conservatively receives the full owner's estimated heap plus 512 bytes
per copied quota row; pre-serialization admission additionally reserves twice the
closed input graph bound plus twice an 8 MiB/date result envelope. The result
graph is bounded before serialization, and actual input/result backing-buffer
sizes are checked before transfer. Transferred input/output native memory remains
charged until consumption and confirmed child termination. A live or retiring
child occupies its slot; unconfirmed termination remains charged and refuses the
run. The parent is charged throughout. The pool retains the existing bounded
main-thread read admission/drain. No shared ArrayBuffer or shared acquisition
checkpoint is introduced. Worker young-generation limit remains 192 MiB; no
process-wide V8 heap flag or Cloud Run memory tier is changed.

Child OOM discards its whole owner attempt, drains every sibling, and delegates
to the existing exactly-once owner-alone retry with fan-out off. A repeated OOM
fails closed. Other child failures abort the run; neither partial emissions nor
partial publication escape. The committed protocol tests cover immediate denial,
two owners/one spare slot, deferred termination, rejected termination in both
result/consume orders, sibling OOM, repeated OOM, invalid/duplicate/oversized
metadata, premature parent result, grant-transfer failure, delayed read abort,
and original owner cancellation/retry behavior. Independent control review of
`f1e0e5ca` accepted the termination repair; independent observer/order review
accepted the frozen-oracle digest and date3-budget/date5-terminal proof.

Validation held before this receipt:

- Initial inline stage/native parity/compute selection: 31/31, with independent
  frozen pre-refactor owner outputs and exact tiny-budget account crossing.
- Final focused model stage/observer: 4/4. Includes reverse and shuffled 70 dates,
  reversed asynchronous b=1/5/14/70 completion, forced native paged fallbacks,
  structuredClone and V8 serialize/deserialize strict payload/key-order equality,
  earlier refusal and terminal precedence, and earlier finite-budget refusal.
- Final pool protocol: 25/25. Real-isolate matrix: 14/14 (12 W/b combinations,
  closed-graph serialization bound and first-child OOM parity); the combined
  final combined selection was 39/39. Rehearsal flag tests: 7/7.
- W=2/4/8 × b=1/5/14/70 real synthetic Workers exactly match inline output and
  rolling merge digest
  `88531ec49e282a28efb3b71a7a8ae7fdf0ceb83bd241a199a64d1ead198b781e`.
  W8 b=1/5/14 granted five children in each tiny fixture; b70 granted none. The
  brief's request for a b70 child conflicts with the mandatory owner-last-block
  rule: its sole block stays with the owner, as coordinator explicitly accepted.
- Typecheck passed. Root preflight passed 21/21; architecture passed 970
  production files/4,164 imports after moving the unchanged emission type into
  existing contract.ts and preserving compute-owner.ts public re-export.
  Kernel-closure generation passed with 167 inputs,
  compute closure `0a9abae8d98199c8540c5fd02a77f0f4b918ad4ff2de5a263d7e3b8c000fb56f`,
  unchanged vendor manifest
  `85e919a6f439ff351c37d5df373d2d7299dafa1d4cac2359de9b580f151d7241`.
  This closure is deliberately unregistered; consolidated registration/build
  verification belongs to the coordinator after the other lanes fold.
- Small private PG17 matrix passed before the final store-comparison expansion:
  inline plus all 12 W/b combinations, two real refreshes each, actual readers,
  kernels, writer, stored refusals and real refresh→rehearsal block-metrics
  projection. It used an explicitly unstamped test Worker bundle and the
  existing injected test kernel identity; it does not qualify a serving image.
  The final expanded comparison passed 1/1 in 38.45 seconds: inline plus all
  12 pooled pairs, price rows/card bases, daily owner sets/contributions, journal
  cursor, preview/stamps/refusals and both refreshes. Private PG17.10 used locale
  C, UTF-8, loopback127.0.0.1:55545, 128 MiB shared buffers, 40 connections,
  4 MiB work memory/32 MiB maintenance memory; its owned cluster is stopped.
  An initial restart omitted explicit pg_ctl runtime options and yielded a
  connection refusal; that setup was stopped and corrected before the passing
  run. No import/template/corpus benchmark was performed.
- Benchmark helper syntax and 97 tiny synthetic samples passed for b=1/5/10/14/70;
  maximum serialized input 625,826 bytes. It emits counts, clone timings/bytes,
  cold/warm evaluation, digest, sampled heap, CPU and process peak RSS, never
  source path or row content. A benchmark-only esbuild transform times exact d1
  attribution-cache miss and price-memo rebuild work, with row counts and
  cold/warm counters; it refuses source-boundary drift and changes no vendored
  source/production artifact. `quotaMemoRebuildMs:null` remains explicit until
  the separately owned memo is folded. The small prepared-day fixture needed
  no d1 misses (zero counters); o01 instrumentation still needs qualification.

`gcp-model-blocks-benchmark.mjs --synthetic-input <file>` accepts a local V8
serialized synthetic owner compute input `{context,owner,evidence:Map,
occurrences:Map,load:null}` (at most 2 GiB), captures its reviewed model-stage
payload, then benchmarks one fresh isolate per block sequentially. It makes no
DB read or persistent prepared artifact. The coordinator's o01 probe adapter and
scheduled run are pending; exact quota-memo attribution requires the combined fold. The committed script
supplies clone costs, synchronous d1 miss attribution/pricing and combined
cold-cache costs; cold-minus-warm includes other caches/JIT and must not stand
in for memo timing. Instrumented timings include clock/counter overhead, so
the production CPU-growth cap must use uninstrumented refresh runs. Its fixed 8 GiB old-space cap/192 MiB young
cap are benchmark-only maxima, not an admission proof for the 16 GiB task.

Module-state audit of the model-only esbuild graph, using the production host and
fast-pricer bindings on this checkpoint:

| Cross-call mutable state | Classification and date/clone consequence |
| --- | --- |
| `quota-analysis-v11.ts`: `usageRowEvidenceMemos` WeakMap | Pure row-identity pricing/attribution memo; validates `record_json` and `observed_at`. Each clone rebuilds; eviction changes cost, not output. |
| Same module: `usageRowAttributions`, `usageRowModels` Maps | Pure string interning, capped at 4,096 each. Values do not depend on date order; no cross-date checkpoint. |
| `fast-pricer.ts`: `initialized`, `TIME_BOUNDARIES`, `CONTEXT_BOUNDARIES`, `modelProviders`, `contextModels` | Lazily initialized once from immutable reviewed price cards; subsequently read. |
| `fastPriceTelemetryUsageEvent` retained closure: `plans`, inner `byCell`, `planCount` | Pure compiled pricing-plan cache, bounded at 16,384; cell identity includes provider/tier/context/date boundary. Fallback oracle unchanged. |
| Accounting `cost-ledger.js`: `COMPILED_TIER_CATALOGS` WeakMap and its tier Maps | Pure compiled price catalog keyed by immutable card array/service tier; values reflect the same oracle cards. |
| Telemetry `primitives.js`: `TELEMETRY_HASH_ID_PATTERNS` Map | Pure validated regular-expression cache keyed by pattern source, no date state. Included by the facade/barrel; no row content is logged. |

Initialization-only collection tables (`reviewedModelById`,
`performanceV1ReviewedModelPairs`, `PERFORMANCE_MODELS_BY_PROVIDER`, registered
subscription-speed `REGISTERED_MODEL_NAMES`, `REGISTERED_STANDARD_CARDS`,
`REGISTERED_STANDARD_CARDS_BY_MODEL`, `REGISTERED_PRIORITY_CARDS`, validation
sets/contract-key arrays, and native reason sets) are lookup policy, never changed
by model evaluation. Runcost's `priceLookupCache`, warning sets and compiled
catalog indexes are call-local, not cross-date state. Kernel quota acquisition,
usage reduction, fitting and composition Maps/Sets/checkpoints are call-local.
Cache preparation's `frames` WeakMap is outside the model evaluator; its cache
stage remains owner-local. Portable `crypto.ts`'s timing-safe adapter setter is
removed from the production model graph by the reviewed Node host alias. The
clone audit found no model evaluation dependence on freezing, class prototypes,
getters, Symbol keys or shared cross-date acquisition: Map membership and plain
row fields carry the input; strict equality/key-order tests include real V8
transport. MODEL-RESIDUE's separately owned quota-row memo is not on this base;
its final folded graph needs this audit rerun.

Capacity and measurement limits remain material. MODEL-RESIDUE measured quota
memo retention at 315.54 bytes/row for short identifiers and 379.5292 bytes/row
for corpus-width identifiers; 356,146 largest-owner rows project 107.17–128.91 MiB
per isolate. Parent and children can each retain it. The 512-byte child allowance
is conservative, not measured combined RSS. Full-owner child estimates plus
payload reservations may refuse useful o01 fan-out at the unchanged configured
16 GiB tier. No tighter estimate is authorized without isolated block peaks and
dense concurrent-worker memory evidence. The small fixture's grants do not prove
o01 capacity. GC-callback/sampled heap is not live post-GC heap; profiler main
isolate CPU does not measure child CPU. `/usr/bin/time -l` could not collect peak
RSS (`sysctl kern.clockrate` sandbox restriction); PG parity passed independently
of that host measurement wrapper.

Remaining coordinator-scheduled matrix (no large import or long benchmark run
was launched by this lane):

| Gate | Required comparison/evidence |
| --- | --- |
| Combined source/build | Fold other lanes and prerequisite fixes `28c2c1cb`, `c63ebd48`, `87b6dac6`; rerun analytics-v2, vendor, complete PG/domain, fastpath scripts, closure registration/build verification and output bundle identity. |
| Q-1, dense, s015 PG parity | W1 inline vs W2/4/8 × b1/5/14/70, fanout all; complete stored rows/price/cursor/stamps/preview/refusal bytes, real read branch, second idempotent run, tiny budget and injected child/repeat OOM with no writes. |
| o01 isolated blocks | b1/5/10/14/70: serialize/deserialize bytes/times, exact d1 and quota memo rebuild attribution, per-isolate live post-GC heap and native buffer lifetime, parent+child RSS; tighten estimates only from evidence. |
| o01 critical path | W1/4/7/8 auto and W7 off: grants/refusals/owner blocks, model phase at least 20% lower at W7, CPU growth at most 5%, host 5-second busy-core samples, last-owner tail and process RSS under retained 16 GiB tier. |
| Full synthetic | W8 auto vs inline, exact outputs, total wall/CPU/busy cores/RSS, whether o01 remains last and admission behavior. |
| Projection | Only after measured gates: local W7 critical path and program set-A model/prepare/scalar ratios 2.51/2.13/2.63 for 8-vCPU and current 4-vCPU tasks; state total-bound point and sequential read/prepare residue. |

The reduction/CPU/RSS targets and cloud projections have no measured result yet.
