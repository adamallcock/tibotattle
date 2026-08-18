---
title: Repository Quality Sweep
date: 2026-08-18
type: audit
status: complete
---

# Repository Quality Sweep

## Outcome

The current repository has strong dependency, privacy, and regression controls,
but several composition roots, browser modules, and test suites have outgrown
their original ownership boundaries. The sweep found no P0 issue and no
confirmed unbounded cache or lifecycle leak. It did find a small set of P1
correctness and maintenance-gate issues, plus high-confidence opportunities to
reduce database work, allocations, duplication, and refactor friction without
adding features or changing product mechanisms.

The safest path is not a repository-wide reorganization. First reconcile the
current dirty release stack, then land small parity-proven changes, and only
then split the large composition roots behind direct module contracts.

## Scope and constraints

Six read-only Luna audits covered:

- core log processing and shared packages;
- Worker and Cloud Run backends;
- browser/public/admin clients;
- native macOS code;
- local runtime and operational tooling; and
- tests, documentation, and repository organization.

The parent pass mapped repository state, ran current checks, spot-verified the
highest-ranked evidence, and reconciled findings. No feature, policy, protocol,
privacy boundary, deployment, publication, framework migration, or broad
compatibility retirement was authorized or proposed as cleanup.

## Audited snapshot

The audit examined the working tree as it existed on August 18, 2026:

| Field | Observed state |
|---|---|
| Branch | `ship/v0.1.11` |
| HEAD | `992acc2de2466d2dd11fae0c6fe792af7f3dd7e2` |
| Relative to local `origin/main` | 3 commits ahead, 10 behind |
| Existing tracked changes | 59 files |
| Existing untracked files | 13 files |
| Architecture graph | 360 production files, 1,376 imports, zero approved debt edges |

All source findings therefore describe the current working tree, including
in-flight work. An item marked **active overlap** must not be implemented by
editing this checkout until its owning change is integrated or isolated.

## Current validation baseline

| Check | Result | Interpretation |
|---|---|---|
| `npm run architecture:check` | Pass | Dependency direction and cycle ratchet are healthy. |
| `git diff --check` | Pass | Existing changes have no whitespace-error finding. |
| Worker typecheck | Pass | Current Worker sources typecheck. |
| Cloud Run tests | 15/15 pass | Current Cloud Run behavior is green. |
| Core focused tests | 83/83 pass | Audited index/accounting paths pass their focused replay. |
| Quota-analysis package tests | 23/23 pass when invoked directly | These tests are not in a normal repository gate. |
| Public preview tests | 4/4 pass | Current loopback preview behavior is green. |
| Local server tests | 54/55 pass | The remaining assertion omits the current `claudeDesktopQuota` field. |
| Root `npm test` | Fail, reproduced twice | Failures cluster in current source-shape/API parity, macOS pinning, stale R7 receipts, quota parity, and tool-inventory drift. |
| `npm run docs:links:check` | Fail | The walker enters ignored `.release-archive` output and rejects a Sparkle symlink. |
| `npm run tools:inventory:check` | Fail | The untracked public-preview script is intentionally discovered but not yet classified. |

The root failures are a prerequisite gate, not evidence that the whole codebase
is unstable. They currently include:

- a brittle installer source-shape assertion;
- export and platform public-API identity expectations;
- three macOS artifact tests blocked by the current `fast-uri` pin;
- quota package byte parity and one fail-closed quota assertion;
- two stale R7 evidence assertions; and
- two tool-inventory assertions for the untracked preview script.

## Priority and disposition

- **P0**: data loss, privacy breach, or production correctness failure. None found.
- **P1**: correctness boundary, missing normal gate, or deterministic maintenance blocker.
- **P2**: high-confidence simplification or likely performance win.
- **P3**: useful cleanup whose payoff should be measured or deferred.
- **Ship first**: small, behavior-preserving, and independent of active edits.
- **Good next**: worthwhile after the baseline is green.
- **Measure first**: plausible hot-path win that needs a benchmark before code change.
- **Active overlap**: strong finding in a currently modified file; defer or isolate.

## Ranked opportunities

### P1: correctness and gate integrity

| ID | Disposition | Opportunity and evidence | Safe change | Required proof |
|---|---|---|---|---|
| Q1 | Ship first | Token normalization accepts fractional and unsafe numeric counters in both `src/providers/codex/log-normalization.js:47-55` and `src/local-unified-index-extract.js:55-64`, while the SQLite schemas require strict integers. | Centralize a `Number.isSafeInteger(value) && value >= 0` token primitive; preserve null/diagnostic behavior for malformed input. | Fractional and unsafe fixtures; parser/index parity; focused index replay. |
| Q2 | Ship first | `tools/operations/fix-doc-links.mjs:6-17` omits `.release-archive`, then the root walk at lines 47-60 rejects a generated Sparkle symlink before checking docs. | Exclude the generated archive while preserving symlink refusal in scanned source/docs; add a fixture. | Docs-link check and focused regression test. |
| Q3 | Active overlap | `packages/quota-analysis/test/**` has 23 passing tests but neither `package.json` nor the package scripts include them in a normal gate. | Add a package/root test lane and include it in `product:check`; do not weaken existing parity tests. | Direct package test plus lane-plan and product-check validation. |
| Q4 | Active overlap | Worker JSON parsing accepts `application/json; charset=utf-8`, but upload authorization receives the raw header at `apps/worker/src/index.ts:2534-2551` and compares it with stored canonical `application/json`. | Canonicalize once and pass the canonical value through authorization. | Charset upload tests for session and device authorization; Worker suite and typecheck. |
| Q5 | Active overlap | Native English authorities disagree: the resource catalog points to `Settings -> About`, while `apps/macos/Sources/Localization.swift:868-871` says `Settings -> General`. | Generate or parity-test fallback English values without removing fallback behavior. | Localization parity and degraded-resource tests. |
| Q6 | Good next | Current documentation presents historical D1 correlated scans as current, despite the bounded-query receipt and query-plan tests; current version examples also drift from package version. | Mark the cost reference historical and link the completion receipt. Add a current-version consistency check after active README/template edits settle. | Docs-link check and version-contract test. |

### P2: duplication, module boundaries, and allocation reduction

| ID | Disposition | Opportunity and evidence | Safe change | Required proof |
|---|---|---|---|---|
| Q7 | Measure first | Lineage snapshot keys are persisted before in-memory `Set` deduplication in `src/local-unified-index-build.js:218-225` and again for worker batches at lines 569-573. | Persist/HMAC only newly added keys; retain database conflict handling for cross-pass idempotency. | Duplicate-heavy fork fixture; identical digests/rows; commit-count and corpus benchmark. |
| Q8 | Active overlap | `apps/web/test/lib.test.mjs` is 10,410 lines and repeatedly slices `app.js` by `indexOf` and executes it with `Function`; it reads/parses the source about 66 times. | Cache source reads immediately, then extract pure production functions into direct-import modules and split tests by domain. Keep source-shape assertions only for intentional artifact contracts. | Full UI suite, gesture/render checks, and before/after suite timing. |
| Q9 | Active overlap | Usage and calibration charts duplicate gesture binders at `apps/web/public/app.js:3735-3803` and `4004-4073`; primary/secondary drawing loops duplicate another roughly 200 lines at `5450-5647`. | Extract explicit gesture and series helpers while preserving chart-specific policy, ARIA text, and reset behavior. | Both charts' wheel, pointer, cancel, keyboard, tooltip, and raster/DOM parity. |
| Q10 | Active overlap | Pan/zoom schedules a frame but rebuilds complete SVGs and unrelated summary DOM. Formatter construction and localization mutation handling add repeated allocations. | First cache `Intl` formatters and batch one legacy-localization refresh per mutation batch. Separately benchmark viewport-only redraw before changing render ownership. | Constructor-count tests, mutation tests, browser gesture profiling, rendered comparison. |
| Q11 | Good next | `apps/local/server.js:881-1357` repeats bounded JSON parsing, origin/header authorization, and route error/status mapping across mutation handlers. | Extract one bounded-body helper and one authorization wrapper with route-specific validators and exact error codes. | Full local route matrix, malformed/oversize bodies, privacy/error assertions. |
| Q12 | Ship first | The i18n and telemetry browser-mirror generators duplicate the complete temp/open/write/fsync/rename/directory-fsync/cleanup protocol. | Add one parameterized atomic generated-file writer; preserve modes, fsync order, no-clobber behavior, and cleanup. | Both mirror suites including injected failure cleanup. |
| Q13 | Active overlap | `MenuBarStatus.swift:1101-1140` and `1606-1659` duplicate analysis-result state transitions, rendering, and polling. | Apply results through one private helper parameterized by manual/automatic context; retain generation and menu-tracking guards. | Menu automatic/manual refresh and tracking tests. |
| Q14 | Good next | `QuotaNotifications.swift` repeatedly constructs ISO formatters and expected-key sets and reparses one observation timestamp inside each window. | Use scoped immutable formatter/key sets and parse the timestamp once; retain canonical round-trip validation. | Notification contracts and a small decode/evaluation allocation benchmark. |
| Q15 | Active overlap | Worker contribution success clones and reparses its own `Response` at `apps/worker/src/index.ts:2569-2591` just to recover an already-known contribution ID. | Return an internal `{ response, contributionId }` result and materialize the public response at the HTTP boundary. | All envelope versions, replay, device/session receipt persistence, byte-identical response. |
| Q16 | Active overlap | `personalStats` runs seven queries and then unconditionally performs account-scoped analysis at `apps/worker/src/telemetry-repository.ts:1513-1616`, including for participant contracts that cannot use it. | Pass an explicit eligibility flag and return the existing `not_testable` shape without the two inapplicable queries. | Legacy, synthetic, empty-v0.2, and ready-v0.2 response parity plus query counts. |
| Q17 | Good next | Worker test harness bindings/API factories and secret-hash helpers are copied across at least five suites; two hash copies omit buffer zeroing. | Create a narrow typed test-support module for exact shared primitives, preserving suite-specific overrides. | Full Worker suite and typecheck; zeroization assertions. |
| Q18 | Measure first | Quota rolling/tracks repeatedly parse dates and rescan full usage series; replay accounting creates per-event maps/copies; local analysis prepares some statements per source. | Benchmark separately, then use numeric timestamps/prefix sums, fixed component lookups, and refresh-scoped statements only where parity is exact. | Golden byte parity, dense-history benchmark, RSS/GC measurements, current quota failures resolved first. |

### P2/P3: staged organization

| ID | Disposition | Opportunity and evidence | Safe change | Required proof |
|---|---|---|---|---|
| Q19 | Good next | Major composition roots remain oversized: web `app.js` 10,169 lines; macOS `UsageMonitorApp.swift` 8,180; local `server.js` 4,205; Worker `index.ts` 3,977. | Split by stable responsibility only after direct tests exist. Keep entrypoints as composition roots and preserve generated/source ownership. | Architecture gate, route/source inventories, focused behavior suites, rendered/runtime smoke. |
| Q20 | Good next | Settings construction occupies roughly 500 lines inside `AppDelegate` at `UsageMonitorApp.swift:5370-5835`. | Extract a narrow `SettingsWindowController` before broader Swift file movement. | Settings layout, localization, notification, login-item, and first-run contracts. |
| Q21 | Good next | Giant tests mix unrelated concerns: web 10,410 lines, macOS bundle 6,324, Worker 5,753, replay accounting 2,617. | Split by behavior domain and extract only truly shared fixtures. Update explicit lane manifests in the same change. | Each extracted suite plus full lane-plan parity. |
| Q22 | Good next | Documentation navigation is manually curated and omits recent active plans; the architecture plan still describes a roughly 2,500-line/two-file macOS surface. | Add an active-plan index or frontmatter/index consistency check and label old size snapshots as historical. | Docs-link check and status/index validation. |
| Q23 | Defer | Root tests are flat and glob-driven across 236 files, but mass movement would create review noise and lane risk. | Move one subsystem at a time only when its production owner is being changed; centralize discovery without hiding lane membership. | Root tests, product checks, and `test-lanes` plan parity after every slice. |

## Hot-path and memory assessment

Likely hot paths worth measuring:

- lineage snapshot HMAC/SQL persistence on fork-heavy histories;
- quota rolling/tracks on dense seven-day histories;
- Worker participant stats and accepted contribution requests;
- full SVG/dashboard replacement during pointer/wheel chart interaction;
- local polling projections and repeated route parsing; and
- native quota decoding and companion-output parsing during refresh/startup.

No current evidence justifies another broad local-analysis rewrite. The existing
pipeline already has bounded workers, streaming reads, batching, exact-parity
receipts, RSS guards, and a recent real-corpus performance baseline. Preserve
those gates and benchmark each candidate against the production path.

The audit did not confirm an unbounded listener, process, or cache leak.
Existing cleanup is generally strong: browser resize observers are disconnected,
native menu polling/monitors are torn down, companion readability handlers are
cleared, Worker maintenance uses leases/fences, and local/server shutdown closes
connections and sensitive state. The retained `DashboardWebHost` and its script
handlers share an intentional application lifetime; it is not a leak unless
that lifetime contract changes.

## Recommended implementation order

### Wave 0: reconcile the active stack

Before refactoring, integrate or isolate the current 59-file/13-untracked-file
work and restore the intended gates. Resolve source/API parity expectations,
the current quota drift, macOS dependency pinning, R7 receipt freshness, the
local `claudeDesktopQuota` fixture, and the preview script's inventory record if
that script is retained. Do not regenerate evidence merely to silence an
unexplained semantic failure.

### Wave 1: small independent corrections

1. Q2: exclude `.release-archive` from docs-link traversal and add the fixture.
2. Q1: centralize safe-integer token normalization.
3. Q12: extract the atomic generated-file writer.
4. Q6: label the stale D1 reference as historical.
5. Q3: place the 23 quota package tests in a normal gate after `package.json`
   ownership is clear.

Each item should be its own narrow, reviewable change.

### Wave 2: helper extraction without entrypoint movement

1. Q11: local bounded-body/authorization helpers.
2. Q17: typed Worker test support.
3. Q13 and Q14: native menu-result and quota-decoding cleanup after active
   macOS changes settle.
4. Q8's low-risk first step: cache web source reads, then establish direct
   module contracts.
5. Q4 and Q15: Worker upload canonicalization and internal receipt result after
   the current Worker stack lands.

### Wave 3: measured and structural work

1. Benchmark Q7 and Q18 on the existing real corpus and retain exact output.
2. Profile Q10 under real chart gestures before changing redraw ownership.
3. Extract Q20 Settings, then split the native composition root.
4. Split web, Worker, and local composition roots only behind the tests created
   in prior waves.
5. Reorganize giant tests alongside their owner modules, not as one mass move.

## Explicit non-opportunities

The following were considered and rejected for this cleanup scope:

- deleting compatibility shims without the separately approved retirement plan;
- broad CSS splitting or a browser framework migration;
- parallelizing destructive Worker maintenance phases;
- globally unifying provider/domain fixtures with intentionally different edge
  semantics;
- editing generated browser mirrors or `admin-ui.generated.ts` directly;
- changing sync-manifest range/continuation policy as a refactor;
- treating an intentionally retained session-lifetime native web host as a
  leak; and
- optimizing cold release/signing paths without measured build pain.

## Strengths to preserve

- Zero approved dependency debt and explicit architecture direction.
- Strong fail-closed privacy, error-shape, and resource-bound assertions.
- Shared telemetry vectors across root, Worker, web, and Cloud Run.
- Streaming/keyset/batched I/O on large or sensitive pathways.
- Explicit release, signing, deployment, and publication boundaries.
- Generated-file ownership and parity checks.
- Recent real-corpus performance and exact-output gates for local analysis.

## Summary

- P0: 0
- P1: 6 grouped opportunities
- P2/P3: 17 grouped opportunities
- Overall engineering quality: good foundations with concentrated composition,
  test-architecture, and active-branch hygiene debt
