---
title: Engineering simplification evaluation
date: 2026-09-13
type: decision-record
status: complete
---

# Engineering simplification evaluation

## Status and claim boundary

This record evaluates the seven proposals in the 2026-09-12 engineering
simplification brief against source revision `f2b3a5d`. It authorizes only the
source changes named below. It does not retire a supported migration route,
delete retained state, build or install an application, sign or notarize an
artifact, publish an updater, or deploy a service.

The source brief was prepared over an uncommitted working state that included
usage-explainer and allowance-history work. This branch deliberately starts
from the clean revision and does not copy those user-owned edits. A proposal
that depends on those files therefore remains pending rather than being
re-created from an incomplete snapshot.

## Decision rule

A change qualifies as a simplification only when it:

- gives one semantic contract a clear owner;
- removes a real duplicate or misleading dependency;
- preserves observable outputs, missingness, privacy, allowlists, recovery,
  cancellation, and release boundaries;
- reduces future change surface without introducing a generic framework; and
- can be proved with exact inventory or behavior parity plus negative tests.

Line-count reduction alone is not sufficient. Moving a duplicate, broadening
an allowlist, or hiding policy behind an abstraction does not qualify.

## Decisions

| Brief | Decision | Current delivery boundary |
|---|---|---|
| 1. Shared runtime closure | Accept with changes | Extract neutral graph, package-pin, digest, and capture ownership; retain native build and release policy; do not move shared branding or the handover helper in the same change |
| 2. Canonical localization | Accept with changes | Consolidate the JavaScript package, generated browser mirror, and Electron main-process slice; keep native Swift localization independent |
| 3. Work-usage aggregation | Defer pending prerequisite | Consolidate after the untracked usage-explainer work is integrated; do not add an unused abstraction or expose model grouping publicly now |
| 4. Read-only unified-index adapter | Accept narrowly | Share only the existing open/begin/generation/callback/rollback/close lifecycle; keep classification and long-reader revalidation with callers |
| 5. Exact accounting arithmetic | Accept | Replace weekly calibration's duplicate implementation with the accounting facade and preserve exact output/error behavior |
| 6. Surface manifests | Accept as staged projections | Use explicit positive selectors and exact projections; keep route behavior, forbidden paths, native scans, release exclusions, and test lanes separate |
| 7. Legacy index retirement | Defer | Retain the legacy recovery mode until evidence semantics and all production/recovery consumers have migrated |

## 1. Shared runtime closure

The proposal identifies a real ownership error. Electron and public-site
tooling import reusable graph and package-capture behavior from
`scripts/build-macos-app.js`, making deletion of the native builder appear to
remove Electron dependencies.

The original extraction boundary is too broad. The macOS static inventory
contains a native-only Keychain reset asset, and the runtime graph embeds
macOS-specific policy. The neutral owner must therefore accept explicit policy
inputs and own only source graphing, browser graphing, package pins and tree
digests, and reviewed package capture. Native source discovery, bundle
assembly, Keychain, preview, signing, updater, and release behavior stay in the
native builder.

The icon is shared by the native and Electron builders; moving it beneath one
surface would invert the dependency or duplicate authenticated bytes. The
native-to-Electron handover helper is Electron-transition code, but relocating
it changes migration and export contracts. Both moves are separate follow-ups
after closure parity, not part of this extraction.

## 2. Canonical localization

The package already owns three locales, catalogs, negotiation, and language
preference. Its browser file is already a deterministic generated mirror. The
remaining duplicate is policy and catalog selection in browser and Electron
adapters, not the browser's DOM/legacy bridge.

At the evaluated revision, the browser contains 1,300 message entries: 482 are
exact canonical duplicates and 818 are browser-only. Electron contains 128
entries: 39 exact canonical duplicates, 86 Electron-only entries, and three
intentional overrides. The overrides are:

- `electron.settings.codexFolder.title`;
- `electron.settings.codexFolder.useDefault`; and
- `electron.menu.refresh`.

The safe change reuses generated canonical locale policy in the browser while
preserving its exported aliases, direction calculation, interpolation
semantics, local storage, DOM mutation, and exact-text migration catalog.
Electron receives a deterministic main-process-safe shared slice, plus a
hand-maintained overlay and named overrides. Electron does not import browser
files, and native Swift/AppKit localization remains an independent delivery
contract.

## 3. Work-usage aggregation

The design principle is correct: model totals, exact cost, missingness,
assumptions, and price status must come from the reporting owner. The current
clean revision already owns these rules in `src/reporting/work-usage.js`.

The duplicate `summarizeModels` named by the brief exists only in the
uncommitted usage-explainer work, not in this branch. Adding a second public
projection now would increase surface area without removing a duplicate. It
would also risk accidentally making `grouping: "model"` part of the application
API, which currently rejects it.

When the explainer lands, it should consume an internal reporting projection
that reuses the existing merge and DTO rules. Before removal, parity must cover
unknown and zero tokens, contradictory output representations, partial and
unpriced cost, assumed-zero cache write, overflow, filters, pagination, exact
cost, component conservation, and deterministic ordering. Period comparisons
must not coerce unknown token totals to zero.

## 4. Read-only unified-index adapter

Repeated transactional lifecycle code exists in the compatibility work-usage
and cache-drop readers, and in the pending explainer. A small helper is useful,
but a universal repository or ORM would hide important differences between
short transactional reads and long readers that revalidate publication
identity without holding a transaction.

The accepted helper opens with `readOnly: true`, begins one transaction, reads
one generation descriptor, awaits a bounded callback, attempts rollback on
every exit, and closes the handle. Callback and cancellation errors take
precedence over cleanup errors. Missing, unavailable, schema, recovery-lock,
and generation-status classification remain caller-owned. Nontransactional
accounting and companion readers are not migrated merely for consistency.

## 5. Exact accounting arithmetic

Weekly calibration and `packages/accounting` contain the same non-negative
decimal normalization and `BigInt` addition policy. Reporting already has an
approved dependency on the accounting package, which is the semantic owner of
API-price-equivalent cost.

The accepted change imports `addUsdStrings` through the package root and
deletes the reporting copy. Exact multi-scale sums, leading zeros, exponent
forms, empty accumulation, malformed values, non-finite values, and bounded
exponent/precision behavior must remain unchanged. Floating-point conversion
or a new decimal package would be a regression.

## 6. Surface manifests

The current inventories overlap, but they are not one contract. Local route
aliases and MIME types, Electron shell/native staging, native bundle scans,
public-site absence rules, client-export privacy allowlists, and test-lane
selection have distinct security meanings.

The accepted design is a data-only positive declaration with explicit surface
selectors and repository-relative paths. Build and validation code may derive
or check exact projections from it, but forbidden/private paths and behavior
adapters remain explicit. It must not walk directories, infer membership, or
automatically include a newly discovered file. The same source may
intentionally belong to multiple projections, and `/` plus `/index.html` must
continue to alias the same local HTML file.

Delivery is incremental: prove Electron/native shared inventory first, then
export and local-route membership. Remove a duplicated array only when exact
old/new parity and negative collision/path tests pass.

## 7. Legacy index retirement

Retirement is not safe at this revision. The default companion uses the
unified index, but the legacy index remains an explicit replay, rebuild,
archive-accounting, diagnostics, benchmark, export, and recovery mode.

More importantly, the shadow-parity suite records a semantic mismatch: the
legacy reader materializes missing token context as zero while the unified
index preserves missing evidence as `NULL`. A compatibility projection can
reproduce legacy output, but doing so is not proof that the canonical nullable
contract is equivalent.

Retirement requires an explicit decision on that semantic difference, parity
for real supported projections, and removal of every production, recovery,
build, and export import. Rebuild, retry, cancellation, staged publication,
identity scope, and no-double-counting must remain proven. Even after source
retirement, old SQLite files remain untouched unless a separate exact-target,
receipt-backed deletion workflow is authorized.

## Delivery order and validation

The implementation order is:

1. exact accounting and the narrow read-only lifecycle;
2. JavaScript localization ownership;
3. neutral runtime closure extraction;
4. exact positive surface projections;
5. work-usage consolidation after its feature prerequisite;
6. legacy-index retirement only after its semantic and recovery gates.

Focused tests run before broader architecture, preflight, package, local,
browser, Electron, native-source, and export gates. Source parity does not
qualify a packaged app, signed artifact, updater, installed app, or deployment.

## Implementation result

Five proposals were implemented at their accepted boundaries:

- Brief 1 now has a delivery-neutral owner in
  `scripts/lib/runtime-closure.mjs`. Electron and public-site builders no
  longer import the native builder for graph or package capture. The macOS
  builder retains compatibility exports for its existing release callers, but
  native discovery, signing, Keychain, updater, preview, and bundle policy did
  not move.
- Brief 2 now exposes `canonicalizeLocale` from `@app-usagemonitor/i18n`.
  Browser code consumes the generated canonical catalog and policy while
  preserving its DOM and legacy-text adapter. Electron copy is deterministically
  generated from 39 shared messages, 86 overlay messages, and three exact,
  documented overrides. Both generators are routine product and i18n gates.
- Brief 4 adds `withReadOnlyUnifiedIndex` and migrates the two matching short
  readers. The helper owns only the read-only transaction lifecycle; each
  caller still owns availability and publication classification.
- Brief 5 removes the reporting-local decimal implementation. Weekly
  calibration now imports `addUsdStrings` through the accounting package root.
- Brief 6 adds an exact, data-only positive manifest and derives the
  history-free export plus Electron web staging from its named projections.
  Local, native, and export parity checks bind all four current inventories;
  route behavior and negative security policy remain with their owners.

Briefs 3 and 7 received no product-source implementation. That is the
simplifying outcome at this revision: the first duplicate exists only in an
uncommitted feature checkout, and the second remains a supported recovery mode
with a known nullable-evidence mismatch. Creating an unused projection or
deleting a non-equivalent recovery path would increase complexity or lose
function.

The implementation also records all three new executable-adjacent helpers in
the reviewed tool inventory. It intentionally makes no net line-count claim:
extracted owners, tests, and generated localization ownership add explicit
reviewed files even as duplicate implementations and cross-surface imports are
removed. The architectural gain is clearer ownership and a smaller future
change surface, not fewer lines in this migration diff.

## Validation result

The following gates establish source behavior in this checkout:

- architecture: 526 production files and 2,088 imports, with zero approved
  debt edges;
- reviewed tool inventory: 159 records, 160 executable paths, and 72 npm
  aliases;
- documentation governance and API-surface reference: passed;
- browser UI: 725 passed;
- local companion: 351 passed;
- public release site: 36 passed;
- macOS source lane: 161 passed and three artifact tests correctly excluded;
- selectable localization lane: 22 focused localization/Electron tests and
  725 browser UI tests passed after both generated-copy checks;
- isolated real macOS ad-hoc bundle smoke: one passed;
- process-observation-dependent R7 tests outside the managed sandbox: 44
  passed;
- Worker package, source, migration, and Vitest checks: 1,001 Vitest tests
  passed, after the Worker-owned lockfile was installed; and
- focused localization, runtime-closure, manifest, unified-index, accounting,
  reporting, Electron, export, and negative-policy tests: passed.

The final root `npm test` run executed 5,188 tests outside the managed sandbox:
5,139 passed, 46 were platform- or artifact-gated skips, and the only three
failures were the two protected R7 receipt checks and the pre-existing root
workspace-policy issue listed below. The native runtime-closure compatibility
mapping, explicit `i18n` lane, expanded locale vectors, and final manifest
cleanup were then revalidated through their focused owning gates.

Three broader gates remain deliberately unqualified rather than being
papered over:

- `test:preflight` stops on the pre-existing tracked root file `design-qa.md`,
  which is outside this change and is not silently moved or allowlisted;
- Worker production/staging dry-run asset generation requires a clean,
  committed release tree, so the comprehensive Worker check stops after its
  green test suites while this implementation is uncommitted; and
- retained R7 release receipts fail closed against changed workload source
  hashes. Regeneration is protected, environment-specific release work and was
  not authorized by this simplification request.

No packaged, installed, signed, notarized, updater, deployment, or public
release claim follows from these source gates.
