---
title: GCP kernel vendoring finished at d43c8f92
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP kernel vendoring finished at d43c8f92

This is a 2026-10-02 receipt for stream K-VENDOR2, which finishes checklist item
K-VENDOR (build order step 3 of `design/wave5-critic-2026-10-02.json`, and its
vendoring-order issue). It continues branch `claude/gcp-fp-v-tool` from
`a0327b56`, whose tool half is recorded in
[2026-10-02-gcp-v-tool](./2026-10-02-gcp-v-tool.md). That receipt's per-commit
directory layout (`vendor/analytics-<8 hex>`, `kernel-parity-<8 hex>`) and its
`VENDOR_DIR_COMMIT_MISMATCH` refusal are superseded here. The branch is not
merged into any other branch.

The evidence is **local and synthetic**. It ran on one macOS arm64 workstation
under Node 26.2.0, with Node 22.16.0 where noted, while other build streams
were running on the same machine. Nothing was deployed, pushed or read from a
GCP or Cloudflare project. The only inputs were git objects already in the
repository and the committed Q-1 golden.

## Claim boundary

Proven here:

- The vendored tree has one **stable path**, `apps/worker/vendor/analytics-d43c8f92`,
  for every commit. Vendoring another commit rewrites that directory in place.
  Its consumers are not edited, and nothing about their import paths changes.
- The **`buildPricingEvent` export patch** is located by symbol. Re-running the
  generator at `d43c8f92` reproduces the committed tree byte for byte, apart from
  that one declared `export ` token and the manifest entries that record it.
- The **GCP-only vocabularies** are generated from the vendored kernel into
  `apps/worker/src/analytics-v2/kernel-vocabularies.generated.ts`. These are
  the 70 model dates, the refusal reasons, the cache band ids and counters, and
  `community-daily-read-v1.0`. Two checks fail on drift: one between the module
  and the vendored tree, and one between the module and every GCP copy,
  including the primary 0059 CHECK sets.
- `vendor:kernels:check`, `analytics-v2:check` and the Q-1 rehearsal pass.

Not proven, and not done here:

- No commit other than `d43c8f92` is committed. Other commits ran only in
  scratch directories.
- The GCP copies still hold their own literals. They are checked against the
  generated module, but they do not import it, because they sit in files that
  build wave 4 owns. See [Hand-offs](#hand-offs).
- K-STAMP's kernel registry is not seeded here.

## Decisions

### The stable path is the existing directory

The critic's issue is that a vendor directory named after its commit makes every
re-vendor rewrite every import path and KM-4's plugin path map. There were two
ways to give the tree a path that does not move:

1. Move the tree to a neutral name, such as `vendor/analytics-kernels`, and keep
   the old path resolvable as an alias.
2. Fix the existing path for all commits.

Option 1 cannot keep the old path working without editing files outside this
stream:

- The Cloud Run build context refuses symlinks (`CLOUD_RUN_CONTEXT_SOURCE_UNSAFE`).
- esbuild and Vite resolve real paths, so `vitest.analytics-v2.config.mjs`
  would stop recognising vendored importers. The kernels would then silently
  run against this checkout's packages.
- `native-parity.spec.ts` mocks a vendored module by path, and a forwarding
  module cannot carry that mock.
- Seven files in `src/analytics-v2/**` import the tree by relative path, and
  build wave 4 owns them.

So the generator now writes every commit into `STABLE_VENDOR_RELATIVE =
"vendor/analytics-d43c8f92"`, and the parity specs into
`analytics-v2-test/kernel-parity`. The directory name is a fixed path, not a
provenance claim:

- The vendored commit is recorded in `MANIFEST.json` `sourceCommit`.
- The reviewed `entry.ts` must name the same commit. The generator enforces
  this.
- The facade header says so in words that do not spell the directory name,
  because the provenance guard would read that name as a commit.

There are two benefits:

- A re-vendor at P is an in-place diff, so `git diff` shows the kernel change
  itself.
- `cloud-run/build.mjs`, `vitest.analytics-v2.config.mjs` and every importer
  are left alone.

A one-time rename to a neutral name is still possible. It would be one
constant, a `git mv` and a mechanical edit to the consumers, made after wave 4
merges and before P. It is optional, and it is not done here.

### Replacing the vendored commit is a reviewed transition

The stable directory holds one commit at a time. When the target commit differs
from the one `MANIFEST.json` records, the generator replaces it only if the
in-place `entry.ts` already names the target commit. It refuses in two cases:

- A facade that names no commit at all: `VENDOR_TRANSITION_FACADE_UNREVIEWED`.
- A facade that still names the old commit: `AUTHORED_PROVENANCE_MISMATCH`, as
  before.

A manifest of an unknown schema is never replaced (`MANIFEST_SCHEMA_UNKNOWN`).
The run log records `replaced: <old commit>`. The old tree stays reproducible
from git with `--out-root` for any harness that needs both kernels side by
side.

### How the vocabularies are derived

Nothing is listed by hand. `apps/worker/scripts/analytics-kernel-vocabularies.mjs`
is a pure module, given the generator's lexer and esbuild. Each derivation
fails closed:

| Vocabulary | Source | Method |
|---|---|---|
| `KERNEL_MODEL_DATES` (70) | `admin-community-allowance.ts` `ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS` | Runtime value. The vendored module is bundled on its own, with packages resolved inside the tree, and then loaded |
| `KERNEL_SHARED_ANALYTICS_REFUSAL_REASONS` (18) | Every vendored Worker source | String literals passed to `new SharedAnalyticsUnavailable(...)`. A non-literal argument or a subclass refuses |
| `KERNEL_CACHE_RETENTION_REFUSAL_REASONS` (2) | `cache-retention-values.ts` | Literals passed to `new CacheRetentionRefusedError(...)`. The derivation first confirms that `evaluateSharedCacheDay` calls exactly `reduceCacheRetentionDay` from the cache-retention modules. Any other route refuses rather than under-reporting |
| `KERNEL_CACHE_RETENTION_BAND_IDS` (10) | `CACHE_RETENTION_BAND_IDS` | Runtime value |
| `KERNEL_CACHE_BAND_COUNTERS` (7) | `CacheRetentionBandCounters` | Interface members in declaration order, snake-cased. The bands that the loaded `reduceCacheRetentionDay` returns for a synthetic two-event session must carry exactly these keys |
| `KERNEL_COMMUNITY_DAILY_READ_SCHEMA_VERSION` | The commit's `apps/worker/src/index.ts`, which is not vendored and is read from git | The single `schemaVersion: "community-daily-read-v<m>.<n>"` literal. A second version, or the literal in any other position, refuses |

The generator derives the vocabularies from the **staged** tree after verifying
it, and before it replaces any output. A refusal therefore leaves everything
untouched.

`--report` also names the generated vocabularies that a commit would change
(`generation.vocabularies.changed`). Each one is a GCP copy that the re-vendor
must port, and possibly a 0059 CHECK set as well. At `d43c8f92` and at
`d43c8f92~25` the list is empty.

### `buildPricingEvent` and the facade

The patch is `{ path: "apps/worker/src/quota-analysis-v1.ts", symbol:
"buildPricingEvent", declaration: "function" }`, found at line 735. `entry.ts`
re-exports:

- `buildPricingEvent`;
- `priceTelemetryUsageEvent`;
- the types `ServerPricingResult` and `TelemetryUsageEvent`;
- `APP_OFFICIAL_PRICE_CARDS` and `APP_PRICE_REGISTRY_MANIFEST`, from the vendored
  accounting package.

All of them were already in the facade's closure, so the vendored file set,
reach and type stubs are unchanged.

## What changed

| File | Change |
|---|---|
| `apps/worker/scripts/vendor-analytics-kernels.mjs` | Stable layout; the sixth patch; the transition rule replaces `VENDOR_DIR_COMMIT_MISMATCH`; vocabularies derived from the staged tree and written; the report lists vocabulary drift |
| `apps/worker/scripts/analytics-kernel-vocabularies.mjs` | New: the derivation and the renderer |
| `apps/worker/src/analytics-v2/kernel-vocabularies.generated.ts` | New and generated. Do not hand-edit it |
| `apps/worker/vendor/analytics-d43c8f92/apps/worker/src/quota-analysis-v1.ts` | One `export ` token, written by the generator |
| `apps/worker/vendor/analytics-d43c8f92/MANIFEST.json` | The sixth `exportPatches` entry; `exportPatched` 5 to 6; `exportPatchedFiles` 2 to 3; that file's `sha256` and `patch` |
| `apps/worker/vendor/analytics-d43c8f92/entry.ts` | Reviewed facade: the pricing re-exports, six tokens, and the fixed-path note |
| `apps/worker/scripts/vendor-analytics-kernels.check.mjs` | From 49 to 57 tests |
| `apps/worker/analytics-v2-test/kernel-vocabularies.spec.ts` | New: 7 tests of the GCP copies against the generated module |
| `docs/plans/2026-10-01-gcp-fastpath.md` | The bullet that said the patches are line-pinned now names this branch |

For K-STAMP, the vendored `MANIFEST.json` sha256 is now `b40d075f…6eb6e`. At
`a0327b56` it was `97acb9af…f66`. Kernel 1 should be seeded from this
manifest, as the critic's vendoring-order issue requires.

## Proof: `d43c8f92` reproduces

- **In place.** `node scripts/vendor-analytics-kernels.mjs`, with no arguments,
  then `git diff` over `vendor/` and `analytics-v2-test/` shows two generated
  changes. The first is `-function buildPricingEvent(` becoming
  `+export function buildPricingEvent(`. The second is the `MANIFEST.json` lines
  listed above. No parity spec changed, and `entry.ts` changed only by the
  reviewed edit. The run took about 1.1 s.
- **Into scratch.** The check regenerates the committed commit with
  `--out-root`, compares the vendor tree, the parity specs and the vocabulary
  module byte for byte, and then runs a second time over its own output.
- **Round trip.** In one scratch stable directory the check vendors
  `d43c8f92`, then `d43c8f92~25` after the facade review, then `d43c8f92`
  again. The final output equals the committed tree, specs and vocabularies
  byte for byte, and nothing is left over from `~25`.

## Gates

| Command (in `apps/worker` unless noted) | Result |
|---|---|
| `npm run vendor:kernels:check` | 57 of 57, about 19 s |
| `npm run analytics-v2:check` under Node 22.16.0 | 13 files, 128 of 128, 454 s on the loaded machine. The 7 new tests are included |
| `npx tsc --noEmit` | Exit 0 |
| `cloud-run`: `node ./build.mjs --check`, `node ./build.mjs`, `node ../scripts/cloud-run-build-context.mjs --check` | ok, ok, ok. This rebuilt `cloud-run/dist`, which the rehearsal executed |
| Q-1 rehearsal: `npm run gcp:fastpath:rehearsal` with `PG_TEST_SOCKET=/private/tmp/tibotattle-pg-fanout-20260926/socket`, `PG_TEST_PORT=55433`, `PG_TEST_DATABASE=kvendor2_q1` | `status: pass`, 65 s, with every gate true. See below |
| Root `npm run test:preflight` | Pass |
| Root `npm run architecture:check` | Pass |

**Q-1 rehearsal.**

- The schema was `typed_legacy_transfer_rehearsal_target_fastpath_f48367be`,
  with 63 primary and 7 ledger migrations.
- Parity matched, with every family equal:

  | Family | Equal / compared |
  |---|---|
  | `daily-totals`, `daily-cells`, `spend`, `daily-other` | 168 / 168 each |
  | `allowance-breakdowns` | 71 / 71 |
  | `model-days` | 120 / 120 |

- `model-days-per-date` has 21 accepted differences. All 14 withheld dates are
  held to `gcp-fastpath-dense-per-date-v1`, and `perDateEqual` is true.
- `cache-counts` stays the declared informational family, with 395
  differences.
- The second run created no new revision.

These are the same family figures as the
[final-merge receipt](./2026-10-02-gcp-fastpath-final-merge.md#q-1-rehearsal).
The rehearsal dropped its three schemas. The database `kvendor2_q1` was
created for this run only and dropped afterwards.

**Mutation checks.** Each of these deliberate weakenings was caught, and the
file was restored afterwards:

| Weakening | Caught by |
|---|---|
| Generator does not write the vocabulary module | 2 check tests (reproduction, round trip) |
| Transition guard off | 2 check tests |
| A hand edit to the generated module (`day_bytes_limit`) | 5 check tests |
| `evaluateSharedCacheDay` route guard off | The cache-route refusal test |
| Counter runtime confirmation off | The counter refusal test |
| `buildPricingEvent` patch removed from the list | 9 check tests |
| Generated module altered for each vocabulary: model dates, a new kernel reason, a dropped kernel reason, a cache reason, a band, a counter, the read version | `kernel-vocabularies.spec.ts` fails on every one |

## Hand-offs

1. **Make the GCP copies import the generated module.**
   - The copies, all under `apps/worker/src/analytics-v2/`:
     - `ANALYTICS_V2_MODEL_DATES` in `compute.ts`;
     - the kernel part of `ANALYTICS_V2_REFUSAL_REASONS` and
       `ANALYTICS_V2_CACHE_ONLY_REFUSAL_REASONS`, and
       `ANALYTICS_V2_CACHE_BAND_COUNTERS`, in `contract.ts`;
     - `ANALYTICS_V2_CACHE_BANDS` in `store.ts`;
     - `ANALYTICS_V2_COMMUNITY_DAILY_SCHEMA_VERSION` in
       `community-daily-route.ts`.
   - Wave 4 owns all of these files. After C-SIMP and C-REFRESH merge, the
     integrator can replace the literals with imports from
     `kernel-vocabularies.generated.ts`. The spec keeps holding the 0059 CHECK
     sets, which stay literal SQL.
   - The fast path's own reasons are pinned in the spec as
     `GCP_OWN_REFUSAL_REASONS`: `non_effective_source_unported`,
     `day_occurrences_exceeded` and `memory_budget`.
2. **C-IPR adds more copies.** `claude/gcp-fastpath-final` (C-IPR) adds two:
   `INTERIM_PUBLIC_READ_SCHEMA_VERSION = "community-daily-read-v1.0"`, and a
   private `CACHE_BANDS` list in the interim public read. They are not on this
   branch. When the branches meet, add them to `kernel-vocabularies.spec.ts`,
   or import them from the generated module.
3. **Transition at P.**
   - Edit `entry.ts`: its provenance text must name P, and its header count of
     export tokens must be correct. Then run
     `node scripts/vendor-analytics-kernels.mjs --commit=<P>`.
   - `--report --commit=<P>` lists the patches, the facade imports and the
     vocabularies to port beforehand.
   - The check pins `d43c8f92`'s six patch lines and some `d43c8f92` reports.
     The tests that depend on the committed commit read it from `MANIFEST.json`.
     The transition round-trip test asserts that the committed commit is
     `d43c8f92`, and says what to change when it is not. Edit the check in the
     same commit as the re-vendor.
   - Comments in the consumers that say "the vendored d43c8f92 kernels" become
     stale at P. The re-vendor should update them.
4. **K-STAMP** seeds kernel 1 from this `MANIFEST.json`. Its
   `vendor_manifest_sha256` is the `b40d075f…` value above.
5. **The vocabulary rules are written for `d43c8f92`'s shapes.** For example, a
   counter typed `number | null`, or a cache family routed through
   `cache-retention-day.ts`, refuses rather than being read. That is
   deliberate. A refusal at P means the rule needs review, not that P is wrong.
