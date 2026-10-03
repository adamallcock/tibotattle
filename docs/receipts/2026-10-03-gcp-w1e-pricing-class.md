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
  pricing function reaches its code or its re-exports. `pricerSha256`
  (method `analytics-v2-pricer-v2`) hashes **every** input the pass's output
  lists, by its closure name and the digest the compute class hashes it by:
  the modules that contribute code, and the re-export barrels that
  contribute none but decide which declaration a pricing import binds (the
  facade `entry.ts`, with only its provenance commit masked, and the vendored
  packages' `index.js` files). The price registry is included, and
  `runcost` is hashed by its bundled file, as the closure names it. The
  pricing method version is the vendored `SERVER_PRICING_METHOD_VERSION`,
  read from the pricer's own source. Both are stamped through two new esbuild
  defines.
  - Every pricer input must be a compute-closure input
    (`ANALYTICS_PRICER_OUTSIDE_CLOSURE`) and is hashed by its closure digest,
    so the class is a function of the closure's digests and the module set
    esbuild's tree shaking selects from them: no file outside the closure
    moves it, and two builds of one registry entry from the same lockfile
    state one class. A build that still stated another class for a
    registered kernel (another esbuild, say) is refused at its first write
    with `ANALYTICS_V2_PRICING_CLASS_CONFLICT`, which now reaches the Job as
    that closed code.
  - A module the pass loads but its output does not list could still decide
    a binding through a star re-export, or a value through a TypeScript enum
    (esbuild inlines those across modules). The pass refuses either
    (`ANALYTICS_PRICER_UNTRACKED_BINDING`); none exists today. A pricer that
    still reaches a dynamic import is refused
    (`ANALYTICS_PRICER_DYNAMIC_IMPORT_REACHED`).
  - On kernel 4 the pricer is 20 inputs out of the closure's 164, 16 with
    code: the price attribution, the vendored `quota-analysis-v1.ts`,
    `server-pricing.ts`, the accounting package's price registry, cost
    ledger and subscription speed, six other vendored helpers they reach and
    `runcost@0.2.1/browser.js`, plus the four barrels. It excludes, among
    others, `compute-owner.ts`, `crypto.ts`, `canonical-json.ts`,
    `quota-analysis-v11.ts` and `v11-daily-projection-values.ts` (REFRESH-OPT
    d1's and d5's patch targets).
  - **Cost of the barrels (over-inclusion).** Any facade edit is now a new
    pricing class, including one that moves no pricing export. REFRESH-OPT d1
    and d5 both edit the facade, so merging either is one full reprice at
    the next kernel bump (about 0.22 ks local, below). Narrowing it later
    needs `price-attribution.ts` to import its two pricing functions and the
    cards from a pricing-only facade, which is a compute-closure change.
  - *Correction to the first version of this receipt (`b49961f2`)*: it
    hashed only inputs with `bytesInOutput > 0` and said the facade was in
    the pricer "masked as in the compute class". It was not: the facade and
    the three package barrels have no bytes, so an export-alias swap in any
    of them changed which function the pricer called without moving the
    class (reproduced on that commit: an `entry.ts` swap of
    `buildPricingEvent` and `priceTelemetryUsageEvent` moved the closure and
    left the pricer digest unchanged). It also hashed `runcost` by every
    installed file, so a file outside the bundle moved the class without
    moving the closure, and two builds of one kernel could disagree.
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
  (fail closed, M4). For well-formed stored state both methods yield the
  same verdict, counts and stale set, so the recorded transition is the
  same; the method row is the only difference.
  - **Method 2 narrows the integrity checks to its sample.** On every priced
    owner-day it checks, from the row alone, what the decoder checks before
    it inflates (projection, codec, digest form, event count and bound,
    non-empty bytes) and fails with the same
    `ANALYTICS_V2_PRICE_INPUTS_CORRUPT` as method 1; the migration's
    constraints already hold all of these. The body (inflation, the
    canonical text's sha256, the closed document, its event count against
    `input_events`) is checked only on sampled owner-days: a body corrupted
    under a sound header fails method 1 and passes method 2 unless sampled,
    and method 2 counts the stored `input_events`. The spec pins both.
- **No kernel id.** No compute-closure module changed: the build still
  resolves kernel 4 (`computeClosureSha256` `febd0ae0…`). The lane's owned
  `price-transition.ts` was left unchanged for that reason.

## Evidence

- `apps/worker/scripts/analytics-v2-pricing-class.check.mjs`, 9 tests, pass:
  - the pricer's input set (barrels included) is pinned for review;
  - a comment edit of any pricer input (the four barrels included) or of
    `runcost`'s bundled file, or a changed method version, changes the class;
  - an export-alias swap in the accounting barrel
    (`fastModeModelFamilyKey`/`fastModeQuotaMultiplier`) or in the facade
    (`buildPricingEvent`/`priceTelemetryUsageEvent`) changes the pure pricer
    bundle's code and moves both the closure and the class;
  - an edit of `runcost`'s `README.md`, `package.json` or unbundled
    `index.js` moves neither the closure nor the class;
  - an edit of `compute-owner.ts`, `occurrence-source.ts`, `native-path.ts`,
    `crypto.ts`, `quota-analysis-v11.ts`, `v11-daily-projection-values.ts`
    or `effective-usage-day.ts` moves the compute closure but not the class,
    and so does a re-vendor that moves only the provenance commit; any other
    facade edit moves the class;
  - the pass refuses a star re-export or an enum in a loaded but unlisted
    module;
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
- `apps/worker/postgres-test/analytics-v2-pricing-classes.spec.mjs`, 8 tests,
  pass: the migration's prior-schema refusal, closed columns and keys,
  append-only refusals and both triggers; registration idempotence and
  conflict, the conflict reaching `writeRunOutputs`'s caller as its closed
  code with nothing written; on 242 stored owner-days, method 2 (about 1% of
  owner-days repriced), method 1 for an unknown older class, and method 1
  for another class all give the same transition, and a run recorded each
  way leaves every `analytics_v2` contract table byte-identical; a drifted
  sampled reprice fails the run while a full reprice reports it as a
  violation; a forged or malformed identity establishment is refused
  atomically; a corrupted stored body outside the sample fails method 1
  and passes method 2 with the clean state's exact proof, inside the sample
  fails both, and a corrupted header (the codec constraint dropped) fails
  every method.
- **End to end with built bundles** (the same spec, under Node v22.16.0):
  the refresh Job is built three times as `cloud-run/build.mjs` builds it,
  real pricer digest included: the registry's kernel 4; a kernel 5 whose
  only change is a comment in `compute-owner.ts` (registered for the test
  through the bundled registry: the closure moves, the pricer does not);
  and the same kernel 5 stamped with another pricer. Over the synthetic
  direct-seed fixture (with 30 dense legacy days: 31 priced owner-days, 601
  stored events after one price row is deleted to make a price-unknown
  stale owner-day), kernel 4 writes, then kernel 5 writes by method 2 (2
  owner-days, 21 events repriced) in one schema and by method 1 (all 31,
  601) in the other. Every one of the 19 `analytics_v2` tables, with only
  uuids, timestamps and timings left out, is identical between the two,
  the stale owner-day included.
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
- **Rerun after the review fixes** (pricer `d68046fa…`, method
  `analytics-v2-pricer-v2`; still kernel 4), compared with the same
  baseline reports: the Q-1 rehearsal passes every gate (zero unexpected
  differences, per-date equal, no new revision on the second run) and all 19
  table digests, the published payloads and the preview equal the
  baseline's; the 320k slice, re-imported from the same sealed corpus, has
  all 19 table digests equal (refresh wall 406.1 s on a shared, busier host;
  not a timing claim). Each holds only kernel 4, so neither exercises a
  transition: `analytics_v2_transition_proofs` stays empty in both. The
  transition evidence is the built-bundle case above.

## Measurement: run-start time on a kernel bump

The transition proof runs serially at run start, before any owner is read.
Measured with the spec's opt-in bench
(`ANALYTICS_V2_PRICING_CLASS_BENCH=<owner-days>x<events>`), median of three
alternated runs, synthetic stored owner-days:

| Stored state | Full reprice (method 1) | Class identity (method 2) | Saved |
|---|---:|---:|---:|
| 2,000 owner-days x 684 events (1.37 M) | 43.6 s (31.9 µs/event) | 0.51 s (20 owner-days repriced) | 43.1 s |
| 10,000 owner-days x 100 events (1.0 M) | 32.1 s (32.1 µs/event) | 0.66 s (106 owner-days repriced) | 31.5 s |
| *Rerun with method 2's per-row header checks:* 2,000 x 684 | 43.3 s | 0.53 s | 42.7 s |
| *Rerun:* 10,000 x 100 | 38.1 s (busier host) | 0.82 s | 37.3 s |

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
- `store.ts` now passes `AnalyticsV2PricingClassError` through
  `writeRunOutputs` beside `AnalyticsV2PriceError` (one line; watch for a
  merge conflict there).
- `cloud-run/build.mjs --kernel-closure` does not print the pricer; the check
  computes it directly.
- **Wave 3b cache key.** A price cached under a pricing class must be keyed
  by the class and a digest of the exact pricer arguments, never the raw
  stored row: the code that derives `priceChunkUsageRecord`'s arguments
  (`v11-daily-projection-values.ts`'s canonical record and ISO time,
  `quota-analysis-v11.ts`'s row fields) is outside the class by design, and
  REFRESH-OPT d5 patches one of them. Kernels registered before this change
  have no class and always reprice in full.
- No kernel id: the compute closure is unchanged (kernel 4, `febd0ae0…`).
