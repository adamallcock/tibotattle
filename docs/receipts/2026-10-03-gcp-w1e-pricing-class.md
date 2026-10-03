---
title: GCP analytics refresh pricing class and proof skip (W1E)
date: 2026-10-03
type: receipt
status: snapshot
---

# GCP analytics refresh pricing class and proof skip (W1E)

This is a 2026-10-03 receipt for lane W1E of the refresh optimization program
(`design/refresh-optimization-program-2026-10-03.md` in the parity home,
section 3.2.1, rank 4) on branch `claude/gcp-fp-opt-1e-priceclass`, built on
the fast-path final line at `b8864974` (kernel 4). It implements owner
decision round 18 ("price each row exactly once and cache it forever against
a version") as far as the version key and the kernel-transition proof. It
records **local, synthetic** evidence only: one macOS arm64 workstation
shared with other agents, and the local PostgreSQL 17 fan-out cluster
(private Unix socket, port 55433) in uniquely named databases, all dropped
afterwards. Nothing ran in the cloud and no migration was applied anywhere
else.

## What is built

- **The pricer and its digest** (`apps/worker/cloud-run/analytics-kernel-closure.mjs`).
  The build runs a second esbuild pass whose only entry exports the pricing
  functions (`analyticsV2PriceInput`, `priceAnalyticsV2Input`,
  `sameAnalyticsV2Price` and the vendored `priceChunkUsageRecord`), with every
  module marked side-effect free, so a module is in the pricer only when a
  pricing function reaches its code. `pricerSha256` hashes the inputs with
  `bytesInOutput > 0` by their closure names and digests (the facade masked
  as in the compute class; the price registry included) and the third-party
  `runcost` package whole, by every file it installs. The pricing method
  version is the vendored `SERVER_PRICING_METHOD_VERSION`, read from the
  pricer's own source. Both are stamped through two new esbuild defines.
  - Every pricer input must be a compute-closure input
    (`ANALYTICS_PRICER_OUTSIDE_CLOSURE`), so a kernel-registry entry pins its
    pricing class. A pricer that still reaches a dynamic import is refused
    (`ANALYTICS_PRICER_DYNAMIC_IMPORT_REACHED`).
  - On kernel 4 the pricer is 16 inputs out of the closure's 164: the price
    attribution, the vendored `quota-analysis-v1.ts`, `server-pricing.ts`,
    the accounting package's price registry, cost ledger and subscription
    speed, six other vendored helpers they reach, and `runcost@0.2.1`. It
    excludes, among others, `compute-owner.ts`, `crypto.ts`,
    `canonical-json.ts`, the facade, `quota-analysis-v11.ts` and
    `v11-daily-projection-values.ts` (REFRESH-OPT d1's and d5's patch targets).
- **The pricing class** (`apps/worker/src/analytics-v2/kernel.ts`
  `analyticsV2PricingClass`): sha256 over (`analytics-v2-pricing-class-v1`,
  pricer digest, pricing method version, price-input projection version,
  cards digest). A bundle without the defines (sources run unbundled) has an
  unknown class.
- **Staged migration** `apps/worker/postgres/staged-migrations/primary/0961_analytics_v2_pricing_classes.sql`
  (placeholder number; found by its name suffix). Additive, needs primary
  0072, creates nothing on an earlier schema. Three append-only tables, none
  owner-scoped:
  - `analytics_v2_pricing_classes`: one row per class digest with its four
    components;
  - `analytics_v2_kernel_pricing_classes`: each kernel's class, held by a
    trigger to the kernel's own registered cards and projection;
  - `analytics_v2_transition_proofs`: per recorded transition, method 1
    (full reprice) or method 2 (pricing-class identity with a sampled
    reprice), the shared class, the sample divisor and what was repriced. A
    trigger refuses method 2 unless both kernels are in that class.
- **The proof skip** (`apps/worker/src/analytics-v2/store-price.ts`). A run's
  first write registers its kernel's class. The transition proof from an
  older kernel uses method 2 only when both kernels' classes are known and
  equal; it then reads every owner-day's row metadata (the same counts,
  price-unknown stale owner-days and stored-kernel checks as method 1) and
  fetches, decodes and reprices only a deterministic sample of about 1 in 100
  owner-days (keyed by class, kernels and owner-day; the first priced
  owner-day always). A sampled owner-day that does not price exactly as
  stored ends the run (`ANALYTICS_V2_PRICING_CLASS_SAMPLE_MISMATCH`). An
  unknown class on either side, or two different classes, reprices in full
  (fail closed, M4). Both methods yield the same verdict, counts and stale
  set, so the recorded transition is the same; the method row is the only
  difference.
- **No kernel id.** No compute-closure module changed: the build still
  resolves kernel 4 (`computeClosureSha256` `febd0ae0…`). The lane's owned
  `price-transition.ts` was left unchanged for that reason.

## Evidence

- `apps/worker/scripts/analytics-v2-pricing-class.check.mjs`, 7 tests, pass:
  - the pricer's input set is pinned for review;
  - a comment edit of any pricer input, of `runcost`'s bundled file or of its
    unbundled `README.md`, or a changed method version, changes the class;
  - an edit of `compute-owner.ts`, `occurrence-source.ts`, `native-path.ts`,
    `crypto.ts`, `quota-analysis-v11.ts`, `v11-daily-projection-values.ts`,
    `effective-usage-day.ts` or the facade moves the compute closure but not
    the class, and so does a re-vendor that moves only the provenance
    commit;
  - coverage: every module the pure pass drops was audited statement by
    statement in the real-semantics bundle (parsed with rolldown's
    `parseAst`) and runs only declarations whose initializers call builtins,
    read-only methods or one reviewed call, and writes only its own bindings
    (the audit is shown to catch foreign writes, foreign calls, top-level
    callbacks and static class initializers); and the pure pricer bundle
    prices a 3,579-record synthetic battery identically to the full module
    graph through both entry points, the battery selecting every card the
    projection can reach (all 178 but the Anthropic batch/fast and
    provider-tool cards);
  - the defines stamp the pricer and `kernel.ts` reads it back.
- `apps/worker/postgres-test/analytics-v2-pricing-classes.spec.mjs`, 6 tests,
  pass: the migration's prior-schema refusal, closed columns and keys,
  append-only refusals and both triggers; registration idempotence and
  conflict; on 242 stored owner-days, method 2 (about 1% of owner-days repriced),
  method 1 for an unknown older class, and method 1 for another class all
  give the same transition, and a run recorded each way leaves every
  `analytics_v2` contract table byte-identical; a drifted sampled reprice
  fails the run while a full reprice reports it as a violation; a forged
  identity establishment is refused atomically.
- Regressions, pass: `analytics-v2-kernel-registry.check.mjs` (8),
  `analytics-v2-price-cards.spec.mjs`, `analytics-v2-refresh.spec.mjs` (with
  `cloud-run/dist` built), `analytics-v2-owner-sets.spec.mjs`, the
  analytics-v2 Vitest gate (21 files, 230 tests), `tsc --noEmit`, root
  `architecture:check` and `test:preflight`.

## Parity

Baseline: a detached checkout of `b8864974`, same dependencies, its own
`cloud-run/dist`. Both builds resolve kernel 4.

- **Q-1 rehearsal** (`gcp-fastpath-rehearsal.mjs --golden
  analytics-v2-test/golden --per-date-expected
  analytics-v2-test/golden-q1-node/per-date-expected.json`, the branch with
  `--staged-primary 0961_analytics_v2_pricing_classes.sql`): both pass every
  gate (parity with the golden, per-date equality, second run with no new
  revision). All 19 baseline `analytics_v2` table digests (measure-local's
  digest, volatile stamps excluded) are equal, as are the published payloads
  with their revisions and the preview. The branch adds
  `analytics_v2_pricing_classes` and `analytics_v2_kernel_pricing_classes`
  (one row each) and an empty `analytics_v2_transition_proofs`.
- **320k slice** (`s004`, sealed corpus `b3aa132a…`, imported once and
  cloned for each run; the branch's template had the staged migration
  applied): all 19 baseline table digests equal, the same three new tables.
  Refresh wall 385.4 s baseline, 386.2 s branch (noise).

## Measurement: run-start time on a kernel bump

The transition proof runs serially at run start, before any owner is read.
Measured with the spec's opt-in bench
(`ANALYTICS_V2_PRICING_CLASS_BENCH=<owner-days>x<events>`), median of three
alternated runs, synthetic stored owner-days:

| Stored state | Full reprice (method 1) | Class identity (method 2) | Saved |
|---|---:|---:|---:|
| 2,000 owner-days x 684 events (1.37 M) | 43.6 s (31.9 µs/event) | 0.51 s (20 owner-days repriced) | 43.1 s |
| 10,000 owner-days x 100 events (1.0 M) | 32.1 s (32.1 µs/event) | 0.66 s (106 owner-days repriced) | 31.5 s |

Projected onto the full synthetic corpus (6.86 M usage events, 10,025
owner-days): a full reprice is about 220 s local; the identity proof is about
2.5–3 s (the 1% sample dominates). That saves about **0.22 ks local per
non-pricing kernel bump**, about 0.5 ks cloud at the program's 2.4 ratio.
These are projections from the two bench points, not a full-corpus run.

## Open items for the integrator

- **Promote the migration** with the next primary number; the store requires
  it once a bundle states a pricer. The refresh spec's table-set check then
  needs the three tables (exported as `ANALYTICS_V2_PRICING_CLASS_TABLES`,
  `_COLUMNS` and `_PRIMARY_KEYS` from `store-price.ts`; re-export them from
  `store.ts` as REV-SEED's tables are).
- `store.ts` `writeRunOutputs` reports `AnalyticsV2PricingClassError` as
  `ANALYTICS_V2_WRITE_FAILED`; adding it to the pass-through list beside
  `AnalyticsV2PriceError` would keep its closed code (the Job's read-snapshot
  proof already surfaces it).
- `cloud-run/build.mjs --kernel-closure` does not print the pricer; the check
  computes it directly.
- Wave 3b keys persisted priced days by the class
  (`analytics_v2_kernel_pricing_classes`); kernels registered before this
  change have no class and always reprice in full.
