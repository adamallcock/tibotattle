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
[2026-10-02-gcp-v-tool](./2026-10-02-gcp-v-tool.md). The stream landed in
`6c3fcd0b`; a review of that commit was then verified and its fixes landed
on top (see [Review of 6c3fcd0b](#review-of-6c3fcd0b)). That receipt's per-commit
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
- A refusal class reached under another name (an import alias, a namespace
  import, a local alias, a re-export) refuses the derivation instead of
  under-reporting, and the cache family follows every call path from the
  facade, however many modules it crosses.
- The spec now also refuses any later or staged (`NNNN_`) primary migration
  that touches a closed `analytics_v2` set, and it scans the GCP code for
  copies it does not name, so a copy that arrives with another branch is
  checked when the branches meet.
- `vendor:kernels:check`, `analytics-v2:check` and the Q-1 rehearsal pass.

Not proven, and not done here:

- No commit other than `d43c8f92` is committed. Other commits ran only in
  scratch directories.
- The GCP copies still hold their own literals. They are checked against the
  generated module, but they do not import it, because they sit in files that
  build wave 4 owns. See [Hand-offs](#hand-offs).
- K-STAMP's kernel registry is not seeded here.
- The copy scan finds a band or counter that P adds or renames in a copy the
  spec does not name. It does not find one that P removes.

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
| `KERNEL_SHARED_ANALYTICS_REFUSAL_REASONS` (18) | Every vendored Worker source | String literals passed to `new SharedAnalyticsUnavailable(...)`. A non-literal argument, a subclass, or any other way of naming the class refuses (see below) |
| `KERNEL_CACHE_RETENTION_REFUSAL_REASONS` (2) | The code the facade reaches | Literals passed to `new CacheRetentionRefusedError(...)` that survive in the tree-shaken esbuild bundle of `entry.ts`, in vendored source order. Each must also be a construction the source scan read. The D1 day lanes in `cache-retention-day.ts` construct four more reasons, which the facade does not reach |
| `KERNEL_CACHE_RETENTION_BAND_IDS` (10) | `CACHE_RETENTION_BAND_IDS` | Runtime value |
| `KERNEL_CACHE_BAND_COUNTERS` (7) | `CacheRetentionBandCounters` | Interface members in declaration order, snake-cased. The bands that the loaded `reduceCacheRetentionDay` returns for a synthetic two-event session must carry exactly these keys |
| `KERNEL_COMMUNITY_DAILY_READ_SCHEMA_VERSION` | The commit's `apps/worker/src/index.ts`, which is not vendored and is read from git | The single `schemaVersion: "community-daily-read-v<m>.<n>"` literal. A second version, or the literal in any other position, refuses |

Both refusal classes are read under one naming rule. A vendored source may
name the class only as `new <class>(<one literal>)`, `instanceof <class>`, its
one declaration in its defining module, a plain unaliased import, or a local
export in the defining module. An alias in an import or export clause, a
re-export, a member reference, a value use such as `const E = <class>`, and a
namespace, `export *` or dynamic import of the defining module could construct
the class under a name the scan does not read, so each refuses with
`VOCABULARY_REFUSAL_CLASS_ALIASED`.

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
| `apps/worker/scripts/vendor-analytics-kernels.check.mjs` | From 49 to 57 tests. The review fixes replace the cache-route test with a bundle-reason test and extend the reason and kernel-change tests |
| `apps/worker/analytics-v2-test/kernel-vocabularies.spec.ts` | New: 10 tests of the GCP copies against the generated module, including the later-migration guard, the parity compare and the copy scan |
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
- **In place, for the review fixes.** The same run changed only the generated
  comment above `KERNEL_CACHE_RETENTION_REFUSAL_REASONS`. `vendor/` and the
  parity specs were untouched, and the run took about 1.7 s.
- **Into scratch.** The check regenerates the committed commit with
  `--out-root`, compares the vendor tree, the parity specs and the vocabulary
  module byte for byte, and then runs a second time over its own output.
- **Round trip.** In one scratch stable directory the check vendors
  `d43c8f92`, then `d43c8f92~25` after the facade review, then `d43c8f92`
  again. The final output equals the committed tree, specs and vocabularies
  byte for byte, and nothing is left over from `~25`.

## Gates

These were re-run on the review fixes, before they were committed on top of
`6c3fcd0b`. The earlier figures for `6c3fcd0b` itself are in brackets.

| Command (in `apps/worker` unless noted) | Result |
|---|---|
| `npm run vendor:kernels:check` (Node 26.2.0) | 57 of 57, about 28 s (57 of 57, about 19 s) |
| `npm run analytics-v2:check` under Node 22.16.0 | 13 files, 131 of 131, 504 s on the loaded machine. The 10 tests of `kernel-vocabularies.spec.ts` are included (13 files, 128 of 128, 454 s) |
| The same spec on a scratch trial merge with `claude/gcp-fastpath-final` | 10 of 10 at `0d3f73c8`, and again at `95c158ba` (T-REDTESTS merged) after the final line moved. `git merge-tree` reports no conflicts at either |
| `npx tsc --noEmit` | Exit 0 |
| `cloud-run`: `node ./build.mjs --check`, `node ../scripts/cloud-run-build-context.mjs --check` | ok, ok. The fixes change nothing the Cloud Run bundle contains, so `cloud-run/dist` was not rebuilt. It is the build the earlier rehearsal executed |
| Q-1 rehearsal: `npm run gcp:fastpath:rehearsal` with `PG_TEST_SOCKET=/private/tmp/tibotattle-pg-fanout-20260926/socket`, `PG_TEST_PORT=55433`, `PG_TEST_DATABASE=kvendor2fix_q1` | `status: pass`, 47 s, with every gate true (`kvendor2_q1`, 65 s). See below |
| Root `npm run test:preflight` | 20 of 20 |
| Root `npm run architecture:check` | Pass: 927 production files, 3964 imports, 0 debt edges |

**Q-1 rehearsal.**

- The schemas were `typed_legacy_transfer_rehearsal_target_fastpath_6b9c0e92`
  for the fixes and `…_f48367be` for `6c3fcd0b`. Each held 63 primary and 7
  ledger migrations.
- Parity matched, with every family equal, in both runs:

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
Each rehearsal dropped its three schemas. The databases `kvendor2_q1` and
`kvendor2fix_q1` were created for one run each and dropped afterwards.
`pg_database` lists no `kvendor2%` database.

**Mutation checks.** Each of these deliberate weakenings was caught, and the
file was restored afterwards:

| Weakening | Caught by |
|---|---|
| Generator does not write the vocabulary module | 2 check tests (reproduction, round trip) |
| Transition guard off | 2 check tests |
| A hand edit to the generated module (`day_bytes_limit`) | 5 check tests |
| Cache reasons read from `cache-retention-values.ts` only, as before the review | The kernel-change test (transitive helper) |
| Naming rule off: aliases in clauses and other references allowed | The reason test and the kernel-change test |
| Namespace, `export *` and dynamic loads of the defining module allowed | The reason test |
| Counter runtime confirmation off | The counter refusal test |
| The spec's later-migration guard set back to `refusal\|band IN (` and numbered names | The guard self-test |
| A staged `NNNN_` migration adding a band counter column | The 0059 test |
| A stray copy with a stale read version, two of ten bands, the bands out of order, or three of seven counters | The copy-scan test, once for each |
| `buildPricingEvent` patch removed from the list | 9 check tests |
| Generated module altered for each vocabulary: model dates, a new kernel reason, a dropped kernel reason, a cache reason, a band, a counter, the read version | `kernel-vocabularies.spec.ts` fails on every one |

## Review of 6c3fcd0b

A review of `6c3fcd0b` raised seven findings. Each was checked against the
code before anything changed. None was rejected.

| # | Severity | Finding | Verified by | Outcome |
|---|---|---|---|---|
| 1 | info | The gates pass when re-run independently | The fixes commit re-ran every gate (below) | No change needed |
| 2 | info | The vendored files equal `d43c8f92` apart from the six export tokens; `MANIFEST.json` is `b40d075f…` | The in-place regeneration for the fixes leaves `vendor/` and the parity specs untouched, so the digest stands | No change needed |
| 3 | info | The scope is clean and the branch merges into the final line | The final line has moved to `0d3f73c8` (C-REFRESH merged). `git merge-tree --write-tree` still reports no conflicts | No change needed |
| 4 | low | The reason scan misses an aliased construction | A probe of `constructedReasons` returned `[]` for an import alias, a namespace import and a local alias | Fixed |
| 5 | low | The cache family follows only direct calls | Cache reasons were read from `cache-retention-values.ts` alone, after a direct-callee check filtered to `./cache-retention-` imports | Fixed |
| 6 | low | The later-migration guard is narrow and skips staged `NNNN_` files | The guard matched only `refusal IN (` or `band IN (` and only `^\d{4}_` names | Fixed |
| 7 | low | Some vocabulary copies are outside the drift check | Confirmed for the owner parity compare, the dense oracle, and (on the final line) the interim public read | Fixed as far as this branch can reach; see below |

**4. Aliased constructions.** `constructedReasons` now classifies every code
reference to the class instead of searching for `new <class>(`. The allowed
forms and the refusals are in [How the vocabularies are
derived](#how-the-vocabularies-are-derived). At `d43c8f92` every vendored
Worker source passes. `SharedAnalyticsUnavailable` is declared once and only
constructed with literals. `CacheRetentionRefusedError` is declared once,
imported plainly by `cache-retention-day.ts`, constructed with literals and
tested with `instanceof`. The check adds 18 refusing forms and the allowed
ones, plus two cases in vendored files: an import alias in
`cache-retention-day.ts` and a local alias in `analytics-shared-reducers.ts`.

**5. Transitive cache refusals.** The cache family is now read from the
tree-shaken esbuild bundle of the reviewed facade:

- The facade is the right boundary. `refusals.ts` `kernelRefusalReason` maps a
  `CacheRetentionRefusedError` from any kernel call, and the GCP path also calls
  `cacheRetentionEventFromRecord` and `cacheRetentionSessionDigest`, not only
  `evaluateSharedCacheDay`.
- Function-level reachability is needed, not module-level.
  `cache-retention-day.ts` contributes about 8.9 kB to the facade bundle, so
  reading whole modules would add its four D1 day-lane reasons.
- esbuild resolves import names to the declared class, and the naming rule
  above leaves no other route. A bundler-renamed class (`<class>2`) refuses,
  and so does a bundled reason the source scan did not read. The check tests
  that with a construction placed in the facade itself.
- At `d43c8f92` the bundle keeps 3 of the 6 constructions in
  `cache-retention-values.ts`, which carry exactly `session_limit_exceeded` and
  `group_limit_exceeded`. The generated values are unchanged; only the
  generated comment changed.
- The old direct-callee route check (`importedCallees`) is removed.
- The check proves three cases. A helper in `cache-retention-events.ts` that
  `reduceCacheRetentionDay` calls adds its reason. Exposing
  `createCacheRetentionDayReader` from the facade adds the day-lane reasons.
  An unreachable construction is left out.

**6. Later migrations.** The spec now applies `touchesClosedSet` to every
primary migration after 0059, numbered or staged, including `NNNN_`
placeholders and any other name. It fails when a later migration does any of
these:

- names `analytics_v2_cache_bands`;
- names `analytics_v2_owner_day` together with its refusal column or
  constraint;
- restates a `refusal` or `band` set as `IN`, `NOT IN`, `= ANY` or `<> ALL`,
  with or without casts.

A self-test holds eight forms that must trip the guard and four that must not.
A read-only scan of every `claude/gcp-*` branch found no later migration that
trips it. That includes the final line's staged `0065_interim_public_read.sql`.

**7. Copies outside the drift check.**

- The owner parity compare is now checked exactly. Its exported
  `ANALYTICS_V2_CACHE_COUNTERS` must equal the kernel counters in camelCase,
  and every reason in its `REFUSAL_REASONS` mapping must be a closed
  analytics-v2 reason.
- The spec also scans GCP code for copies it does not name. The scan covers
  `src/analytics-v2`, `cloud-run`, `scripts` and `postgres`, and leaves out
  tests, checks, `dist` and `node_modules`. Three rules apply:
  - every `community-daily-read-v…` must be the kernel's;
  - a file that names one cache band names all ten, first mentions in kernel
    order;
  - a file that names one distinctive counter names all seven, in snake_case
    or camelCase.
  A file that names the checked constant (`ANALYTICS_V2_CACHE_BAND_COUNTERS`,
  `ANALYTICS_V2_CACHE_BANDS` or `ANALYTICS_V2_CACHE_RETENTION_BAND_IDS`) is
  exempt from the band or counter rule. These are the files the spec already
  compares exactly, and the files that derive from them. Without the
  exemption only `store.ts` would fail, because its invariant checks name five
  counters.
- The scan holds the dense oracle's two hard-coded SQL column lists
  (`oracle.mjs`, `settled-cache.mjs`) and its `cache-days.mjs` mapping. They
  are not derived from `KERNEL_CACHE_BAND_COUNTERS`. They belong to the
  dense-oracle stream, and they run as plain Node scripts, which would need
  type stripping to import the generated `.ts`. The SQL lists also alias two
  counters (`band_adjacencies`, `band_sessions`).
- The interim public read copies are not on this branch, so they could not be
  named. The scan picks them up when the branches meet. A trial merge of the
  fixes with `claude/gcp-fastpath-final` at `0d3f73c8` was built in a scratch
  directory from `git merge-tree`, with no ref or worktree created, and the
  spec passed there (10 of 10). It scanned `interim-public-read.ts`,
  `gcp-interim-public-read-load.mjs` and staged 0065. Renaming one band in the
  interim `CACHE_BANDS`, or bumping `INTERIM_PUBLIC_READ_SCHEMA_VERSION`, failed
  the spec there.
- Limit: the "names all" rules catch a band or counter that P adds or renames
  in a copy the spec does not name. They do not catch one that P removes,
  which leaves a stale extra entry.

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
   - Wave 4 owns all of these files. C-REFRESH has merged into the final line
     (`0d3f73c8`). After C-SIMP merges too, the integrator can replace the
     literals with imports from `kernel-vocabularies.generated.ts`. The spec keeps holding the 0059 CHECK
     sets, which stay literal SQL.
   - The fast path's own reasons are pinned in the spec as
     `GCP_OWN_REFUSAL_REASONS`: `non_effective_source_unported`,
     `day_occurrences_exceeded` and `memory_budget`.
2. **C-IPR adds more copies.** `claude/gcp-fastpath-final` (C-IPR) adds two:
   `INTERIM_PUBLIC_READ_SCHEMA_VERSION = "community-daily-read-v1.0"`, and a
   private `CACHE_BANDS` list in the interim public read. They are not on this
   branch, but the spec's copy scan checks them as soon as the branches meet,
   as the trial merge showed. `interim-public-read.ts` has no imports by design,
   because its loader runs it under plain Node type stripping. Keeping its
   literals under the scan may therefore be the right end state, rather than
   importing them from the generated module.
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
5. **The vocabulary rules are written for `d43c8f92`'s shapes.** Some shapes
   refuse rather than being read: a counter typed `number | null`, a type
   annotation that names a refusal class, or a type-position `import()` of a
   class's defining module. That is deliberate. A refusal at P means the rule
   needs review, not that P is wrong. A cache refusal routed through another
   module is now read rather than refused.
