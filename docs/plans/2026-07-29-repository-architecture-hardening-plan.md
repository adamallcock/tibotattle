---
title: Repository Architecture Hardening Plan
date: 2026-07-29
type: plan
status: in_progress
---

# Repository Architecture Hardening Plan

## Outcome

Evolve Usage Monitor from a fast-growing proof of concept into a maintainable
product repository with explicit ownership, one-way dependencies, shared
contracts, small composition roots, and enforceable engineering standards.
The durable finish criteria and authority boundary are recorded in the
[repository architecture completion goal](../goals/2026-07-30-repository-architecture-completion-goal.md).
That goal also owns the mechanically enforceable source-owner dependency
matrix, consumer behavior baseline, clean-user journey, tool-inventory gate,
staged HTTPS lifecycle gate, and exact external-blocker handoff contract.
The audited July 30 stabilization order and current evidence gates are recorded
in the
[repository architecture stabilization and completion goal](../goals/2026-07-30-repository-architecture-stabilization-and-completion-goal.md).

This is not a cosmetic folder reorganization. Code moves are justified only
when they establish a real module boundary, remove duplicated behavior, or make
an existing dependency rule enforceable. Every migration must preserve the
local-first privacy boundary and pass behavior-parity tests before old entry
points are removed.

## Current architecture, based on repository evidence

The premise that `src/` contains about 30 one-off files is incorrect:

| Area | First-party code files | Approximate lines | Current role |
| --- | ---: | ---: | --- |
| `src/` | 114 JavaScript files | 56,700 | Main local/domain implementation |
| `scripts/` | 27 JavaScript files | 9,500 | Build, release, benchmark, migration, and operations tooling |
| `apps/local/` | 2 JavaScript files | 5,400 | Loopback companion and its large integration test |
| `apps/macos/` | 2 source files | 2,800 | Native launcher, lifecycle, onboarding, and updater shell |
| `apps/worker/` | 64 TypeScript/JavaScript files | 41,900 | Central API, persistence, ingestion, aggregation, and operations |
| `apps/cloud-run/` | 8 code files | 1,300 | Cloud Run runtime adapter |
| `packages/accounting/` | 5 runtime/type files | 1,500 | Runtime-neutral exact API-price-equivalent accounting |
| `test/` | 122 test files | 41,100 | Root behavior, integration, privacy, and release tests |

`src/` is therefore production core code. The applications are also production
code, but mostly serve as delivery and runtime surfaces around that core. Some
research report builders and release-evidence generators do sit beside product
modules and should eventually move to purpose-specific tooling folders.

The flat `src/` directory currently uses filename prefixes as implicit
namespaces. Its major clusters include export handling, contribution sync,
Codex and Claude ingestion, pricing, quota analysis, local-companion
projection, report generation, account identity, experiments, and platform
storage. That convention was workable early on but no longer communicates
ownership or protects dependency direction.

## Highest-risk findings

### 1. Shared logic had the wrong owner

The two known ownership inversions are now closed:

- local and Worker accounting both use the one-export
  `@app-usagemonitor/accounting` package;
- legacy root accounting paths are identity-preserving compatibility shims,
  not separate implementations;
- canonical runtime-neutral telemetry behavior lives in
  `packages/telemetry-contract`; the browser consumes a deterministic
  generated compatibility module; and
- the architecture baseline contains no approved dependency violations.

The former root/browser and Worker telemetry validators now use one package
contract. Trust-boundary adapters still own encryption, transport, persistence,
authorization, and UI behavior rather than pushing runtime-specific behavior
into the package.

The desired direction is:

```text
apps and commands
    -> application use cases
        -> shared domain packages
            -> explicit platform adapters
```

No shared or server-side module should import a browser application asset.

### 2. Several composition roots have become implementation modules

- `src/cli.js` imports about 41 internal modules.
- `apps/local/server.js` is roughly 2,500 lines and owns HTTP routing, static
  assets, refresh orchestration, contribution scheduling, queueing, device
  capabilities, diagnostics, identity, and central-service proxying.
- `apps/worker/src/index.ts` is roughly 1,600 lines and imports about 17
  internal modules.
- `apps/macos/UsageMonitorApp.swift` is roughly 2,500 lines and owns branding,
  process launch, updater integration, onboarding, status, lifecycle, and UI.
- The browser application has similar hotspots in `public/app.js` and
  `public/data-client.js`.

These files should become small composition roots after their responsibilities
have tested homes.

### 3. Build assumptions previously prevented safe decomposition

The macOS builder now discovers the complete static browser import closure and
all supported Swift production sources, and its bundle tests reject unsafe or
undiscovered additions. Further macOS or browser decomposition must preserve
those discovery and bundle-parity gates.

### 4. Engineering controls still vary by surface

The Worker has strict TypeScript settings and a broad check pipeline. Root
JavaScript now has an architecture-boundary ratchet in addition to its
extensive tests, but still lacks repository-wide type checking, linting, and
dependency-cycle enforcement.

The root pnpm workspace owns `packages/*`. The independently deployed Worker
retains its npm lockfile and consumes accounting through a copied `file:`
dependency with `install-links=true`; a byte-parity gate rejects stale installed
package contents. This hybrid install model is explicit and tested rather than
an accidental parent-workspace dependency.

### 5. Duplication needs semantic review, not blind deduplication

Repeated implementations include stable JSON serialization, SHA-256 helpers,
exact-key validation, argument parsing, owner-only filesystem checks,
quantiles/rounding, HTTP smoke helpers, telemetry constants, and benchmark
resource accounting.

Some are true shared primitives; others deliberately enforce different trust
boundaries. An extraction is valid only when fixtures prove equivalent inputs,
outputs, failure behavior, and runtime compatibility.

## Target repository shape

The near-term target deliberately uses a small number of cohesive packages:

```text
apps/
  local/                 loopback delivery adapter and composition root
  macos/                 native delivery adapter and Swift package
  web/                   browser UI only
  worker/                edge API delivery adapter and infrastructure
  cloud-run/             Cloud Run delivery adapter

packages/
  accounting/            price registry and exact cost calculation
  telemetry-contract/    runtime-neutral schemas, constants, and validators
  quota-analysis/        rolling movement and calibration domain logic

src/
  application/           local use cases and orchestration
  providers/
    codex/                Codex log ingestion and normalization
    claude/               paused but isolated Claude ingestion
  export/                privacy-safe materialization and inspection
  contribution/          preparation, queueing, and device sync
  platform/              storage, keychain, filesystem, and process adapters
  reporting/             product-facing local projections only

tools/
  reports/               one-off and historical report builders
  benchmarks/            R7 and resource benchmark machinery
  release/               packaging and release tooling
  operations/            migrations, smoke clients, and maintenance commands
```

This is a migration destination, not permission for a repository-wide move in
one change. Compatibility entry points may remain temporarily while imports and
documentation are migrated.

### July 31 workspace-owner evidence

The SQLite export workspace and exclusive lease now have separate contract,
application, storage, and lease owners; the former flat modules are
composition-only shims. Focused workspace, checkpoint/SIGKILL,
deletion/discard, controller/materializer, resource-policy, local-review,
owner-canary, and architecture tests passed on July 31, 2026 (165 behavior
tests plus 68 owner/architecture tests). At that historical workspace-owner
checkpoint, the architecture check reported 230 production files, 967 imports,
and six approved debt edges.

The retained local-review migration target is now only
`src/export-set-controller.js`. The deletion, materializer, workspace, and
workspace-discard operations are reviewed-owner composition paths; their
compatibility shims no longer appear in `LEGACY_STORAGE_DIRECT_IMPORTERS`.

### July 31 workspace-discard owner evidence

Workspace-discard schemas and fixed protocol filenames now live under
`src/export/`. Owner-only directory inspection, bounded hashing, quarantine,
no-clobber controls, recovery, and durable unlinking live in dedicated
`src/platform/` factories. `src/application/local-export-workspace-discard.js`
pins reviewed semantic constants and injects the workspace and filesystem
ports. The two historical root entrypoints retain their exact named bindings
through a shared compatibility singleton; root CLI and local-review now compose
only the reviewed application/platform facades. The legacy migration ledger
therefore contains just the controller edge. Focused discard schema, crash
recovery, CLI privacy, supplemental lifecycle, local-review, owner-boundary,
and architecture checks passed on July 31, 2026. The repair pass snapshots
composition ports and public options through own data descriptors, retains only
a freshly branded canonical directory-limit error, and exercises a real
child-process SIGKILL after the durable commit marker plus interruption at
receipt/journal/marker cleanup before verified local recovery. This is focused
owner evidence, not a claim that the full repository suite ran green.

The July 31 second repair/re-audit pass adds constructor-provenance branding
for resource-limit errors, descriptor-only contiguous array snapshots,
schema validation of sanitized preview/journal values before durable writes,
and the same validation on pristine recovery. The expanded owner matrix covers
ordinary accessors, callable Proxies, nested roles and arrays, malformed ports,
forged/subclassed/proxied errors, hostile state/preview/build/journal/lease
values, exact facade identity, real SIGKILL termination, and explicitly
identified intermediate filesystem-failure states. The architecture ratchet
currently passes over 249 production files and 1,001 imports with one approved
controller debt edge. Tool inventory and documentation-link checks also pass;
R7 and the full repository suite were intentionally not regenerated or claimed.

### July 31 export-source controller owner evidence

The controller migration closes the last approved architecture edge. Ten
implementations now live together under `src/application/export-sources/`:
Codex source planning, collector planning/scanning, checkpoint population,
Claude status/transcript planning and workspace population, combined source
bundling, and the local export-set controller. Their direct imports are
same-owner modules, the reviewed export/provider facades, and the existing
local Codex-log runtime owner described below. Concrete
Node filesystem, process, crypto, path, bounded-reader, and Claude-ledger
directory mechanics are supplied by `src/platform/local-export-source-ports.js`.
More precisely, `src/application/export-sources/**` contains no direct `node:`
import. Its composition index uses the existing
`src/application/local-codex-log-scanner.js` local runtime owner, whose
`node:util/types` intrinsic authenticates the explicitly supplied proxy
detector; the broader transitive application closure is therefore not claimed
to be Node-free.

The platform owner snapshots `LOCALAPPDATA` and `XDG_STATE_HOME` as the only
Claude-state environment fields and snapshots `CODEX_HOME` separately for
Codex-root parity. All are own-data reads performed at composition; the source
ports expose and retain no caller environment object.

`src/export-source-pipeline-compatibility-internal.js` constructs one
process-wide compatibility pipeline without source discovery or filesystem I/O
at import. Each of the ten historical root modules is a direct alias over that
singleton and retains its exact named exports and binding identities.
`local-review/cli.js` independently composes the application and platform
facades and receives its default controller through `runLocalReview`; it no
longer imports `src/export-set-controller.js`. The architecture baseline and
the eight obsolete `src/storage.js` ledger entries were removed in the same
slice.

The combined affected replay passed 119/119, including source mutation,
checkpoint equivalence, workspace resume, and real supplemental-source
SIGKILL recovery. The expanded owner-boundary matrix passed 14/14 across all ten
public namespaces, exact singleton identities, hostile Proxy/accessor/callable
and thenable inputs, owner closure, and import without local state. The current
architecture graph is 263 production files and 959 imports with zero approved
debt edges; inventory, documentation-link, and diff checks pass. This is a
focused source-owner checkpoint, not a claim that the full repository or stale
R7 receipts are green.

Zero approved architecture debt does not mean semantic migration is finished.
There are still 117 JavaScript entry points in flat `src/`; many are public
compatibility shims or composition roots, but others still mix application,
reporting, contribution, or platform responsibilities. The frozen direct
production `src/storage.js` migration ledger contains 26 callers under
`src/**`. Six non-test tooling callers are tracked separately:
`apps/worker/scripts/smoke-sync-queue-http.mjs`,
`scripts/minimization-ablation.js`,
`scripts/r7-materialized-boundary-worker.js`,
`scripts/r7-resource-benchmark-worker.js`,
`scripts/regenerate-r7-release-evidence.js`, and
`tools/reports/build-prospective-collector-transitions.js`. S4 must freeze that
six-entry tooling ledger and reject both additions and unrecorded removals.
The next S2 work should
classify those 117 roots, retire or permanently document each compatibility
surface, and move the 26 storage callers through reviewed owners without adding
allowances.

### July 31 artifact-storage materializer prerequisite evidence

The durable pair engine remains the sole writer. Its reviewed application and
platform storage contexts now also expose an opaque destination capability:
`openOwnerOnlyExportDestination` reports present versus absent without creating
the destination; list, bounded read-if-present, recovery, pair publication,
and legacy-only fixed-basename projection require that unforgeable capability.
An absent capability pins its owner-only parent and becomes pinned to the
created destination only after the first successful no-clobber pair write.

Every public configuration, request, option, and returned storage-port value is
read only through an own data descriptor. Accessors, callable Proxies, and a
Proxy prototype's `has` trap are never invoked. The application lease facade
uses an unforgeable private callback marker so it preserves the exact value
(including primitives) thrown by user callbacks, while platform failures remain
the fixed content-free application error. Owner-only reads and staging writes
now compare regular-file, device, inode, size, link-count, uid, and mode at
path/descriptor snapshots and again after the read or write.

Focused artifact-owner and pair-recovery replay passed 37/37 tests after this
slice. The materializer, controller, deletion, discard, delivery, and six debt
edges remain deliberately unchanged; a later materializer migration must use
only the opaque destination ports and retain workspace-lease then per-pair
destination-lease ordering.

### July 31 materializer-owner evidence

The materializer migration now uses that opaque destination boundary. Pure
packing, identifiers, logical and source-plan commitments, and manifest
semantics live under `src/export/`; application orchestration receives reviewed
workspace, destination, identity, resource, and verification ports. The flat
materializer is an exact seven-binding composition shim, and local-review's
materializer allowance is removed. Five approved local-review migration edges
remain: controller, the deletion preflight/executor pair, and the workspace
discard preflight/executor pair.

Public options are synchronously snapshotted before lease acquisition, binary
secrets are copied without SharedArrayBuffer aliasing or typed-array species
execution, and all representation constants are pinned before side effects.
Nested source-plan inputs, reviewed errors, gzip metadata, and cleanup failures
have direct adversarial coverage. The final affected replay passed 308/308;
architecture passes at 236 production files, 986 imports, and five debt edges;
and an independent final audit reports zero findings. R7 remains deferred until
the final source freeze.

The owner-only filesystem boundary is intentionally **not** a sandbox against
malicious code already executing as the same OS user. Node exposes no portable
directory-descriptor/openat-style primitive for that stronger claim. The
contract instead protects against other-UID access, symlink/hardlink and
replacement attacks detectable through path/descriptor identity checks, and
cooperative application-process races through the durable transaction and
lease engines. This matches the local trust-boundary statement in the README;
same-UID hostile code can already access the user's local logs, Keychain, and
available APIs.

Follow-up audit hardening replaced `FileHandle.readFile()` in recovery reads
with an exact positioned descriptor-size loop and a one-byte overflow probe;
an append can no longer turn a bounded prevalidated read into an EOF-sized
allocation. A successful read whose descriptor close fails now returns only a
fixed content-free close error, while a primary read failure remains primary.
The close seam is a zero-argument post-close failpoint: native descriptor close
always happens internally, and the hook receives no handle, path, bytes, stats,
or label. No injected read-result object crosses the boundary. The serial artifact, pair-recovery, resource,
workspace, and architecture focused replay passed 123/123 on July 31, 2026.

## Dependency rules

1. `apps/**` may depend on `packages/**` and explicitly exported application
   modules.
2. `packages/**` may not depend on `apps/**`, `scripts/**`, or browser globals.
3. Browser code may not be the canonical implementation of a server or local
   contract.
4. Provider adapters normalize evidence; they do not own pricing, quota fitting,
   storage, or UI formatting.
5. Domain packages may not perform filesystem, Keychain, HTTP, database, or
   process I/O.
6. Infrastructure adapters implement narrow ports owned by the use case or
   domain that consumes them.
7. CLI, HTTP, Worker, and Swift entry points perform composition and translate
   errors; they do not contain core algorithms.
8. `tools/**` may consume product packages, but product code may not import
   tooling.
9. Shared test fixtures live in an explicit test-support module only after at
   least two suites need them.
10. Cross-package public APIs use package exports; deep imports are forbidden.

## Phased implementation

### Phase 0 — Establish a measurable baseline

Status: complete on July 29, 2026.

- Add an architecture-boundary check that inventories current violations,
  rejects new violations, and becomes stricter as migrations land.
- Record import fan-in, fan-out, cycles, file size, and duplicate-helper
  candidates as diagnostics rather than arbitrary quality scores.
- Add the check to a repository-level `check` command without weakening any
  existing test command.
- Document package ownership and the allowed dependency direction.

Exit criteria:

- current debt is explicit and reviewable;
- new app-to-browser and Worker-to-root dependencies fail locally and in CI;
- the check itself has fixtures proving allowed and forbidden cases.

### Phase 1 — Extract the shared accounting kernel

Status: implementation complete on July 29, 2026; full repository and release
evidence gates are recorded in the checkpoint below.

Create `packages/accounting` from the edge-safe accounting kernel.

The package must be runtime-neutral, have one public export map, preserve exact
money arithmetic, and retain registry provenance. Local and Worker adapters
must consume the same package and pass frozen parity fixtures. This completes
the still-partial architectural intent already recorded in the G5 repricing
plan.

Exit criteria:

- neither Worker nor another app imports pricing code from root `src/`;
- local and Worker results are byte-for-byte equivalent on supported fixtures;
- unsupported models, tiers, and long-context ambiguity still fail closed.

### Phase 2 — Establish one telemetry contract

Status: complete on July 30, 2026. The exact R7 matrix remains intentionally
stale until the next covered source set is frozen.

Create `packages/telemetry-contract` for runtime-neutral:

- schema and consent versions;
- field allowlists and exact-key checks;
- canonical normalization;
- contribution and envelope validation;
- stable error codes; and
- generated JSON Schema artifacts where needed.

Keep browser interaction, cryptography, transport, D1 persistence, and
participant authorization in their respective adapters. Run the current
privacy, adversarial, browser, and Worker suites against the shared contract
before removing duplicated validators.

Exit criteria:

- root and local production code no longer import `apps/web/public/lib.js`;
- browser and Worker validators pass the same golden and adversarial fixtures;
- content-bearing and unknown fields remain rejected at every boundary.

### Phase 3 — Turn flat root source into owned modules

Move one cluster at a time, starting with the lowest-coupled modules:

1. provider ingestion;
2. export materialization;
3. contribution preparation and sync;
4. platform adapters;
5. local application use cases; and
6. product reporting.

Use temporary re-export shims only when they reduce migration risk, and put a
removal issue or plan checkpoint beside every shim. Move matching tests and
fixtures only when doing so improves ownership; do not hide end-to-end tests
inside packages.

The R7 release-evidence schema currently hashes the root `src/*.js` inventory.
Any relocation of R7 or other root source therefore requires a dedicated
evidence-regeneration and requalification change; it must not be bundled into a
routine folder move.

Exit criteria:

- `src/` has no prefix-based pseudo-namespaces;
- each folder has an explicit public entry point;
- cyclic dependencies and cross-feature deep imports are absent.

### Phase 4 — Decompose delivery surfaces

#### Local companion

Split `apps/local/server.js` into:

- bootstrap and shutdown;
- route table and request/response adapters;
- static/report asset serving;
- local refresh orchestration;
- central-service proxy;
- contribution scheduling; and
- diagnostics and health.

The existing server integration suite remains the contract during extraction.

#### Worker

Reduce `apps/worker/src/index.ts` to environment validation, route
registration, middleware, and dependency construction. Move request handling
into bounded controllers that call existing domain and repository modules.

#### Browser

Split state, data access, chart projection, contribution flow, navigation, and
rendering. First replace the macOS builder's hard-coded asset list with an
import-aware manifest or build output.

#### macOS

First teach the build to compile an explicit Swift source manifest or Swift
package. Then separate app lifecycle, local-companion process supervision,
onboarding, updater, branding, status/menu UI, and Keychain operations.

Exit criteria:

- entry points are small composition roots;
- the release bundle includes the same dependency closure tested in
  development;
- startup, shutdown, updater, crash recovery, contribution, and offline
  behavior pass packaged-app tests.

### Phase 5 — Separate product code from tools

Classify every current `scripts/` and root report-builder entry point as:

- shipped product operation;
- build/release operation;
- reusable benchmark;
- historical/research report; or
- obsolete.

Move retained tools to the matching `tools/**` owner and keep stable npm aliases
for user-facing commands. Archive historical generators with their provenance
rather than converting them into product packages. Remove code only after
searching docs, package scripts, CI, and release automation for consumers.

### Phase 6 — Raise repository-wide quality gates

- Add formatting and linting with narrow, reviewed rules.
- Add JavaScript type checking incrementally, beginning with shared packages.
- Keep Worker strict TypeScript settings as the minimum for new TypeScript.
- Add dependency-cycle and public-export checks.
- Add coverage reporting as a diagnostic, then set thresholds per package only
  after a trustworthy baseline exists.
- Add structured error taxonomies at HTTP, CLI, storage, and contribution
  boundaries.
- Add contract tests for every adapter and property tests for canonicalization,
  repricing, and privacy allowlists.
- Split very large tests by behavior while preserving end-to-end scenarios.

## Completed initial implementation slice

The first change was deliberately small and durable:

1. add a tested architecture-boundary checker;
2. baseline only the known current violations;
3. reject any new dependency inversion;
4. add a root `architecture:check` command; and
5. extract `packages/accounting` as the first behavior-preserving package.

This gives the repository an enforceable ratchet before the first move and
targets a package boundary already required by the repricing plan.

## Phase 0 hardening checkpoint

The first repository ratchet is now implemented:

- `npm run architecture:check` scans production JavaScript and TypeScript under
  `apps/`, `packages/`, `shared/`, and `src/`, and has fixture coverage for
  package direction, browser/server inversions, cross-application imports,
  product-to-tooling imports, computed dynamic imports, CommonJS production
  modules, ESM `createRequire` and computed-`require` loader escapes, and
  production imports hidden behind test-named modules;
- the initial baseline named only the two exact Worker pricing imports from
  root `src/`; Phase 1 removed both and the current baseline is empty;
- canonical runtime-neutral telemetry behavior now lives under
  `packages/telemetry-contract`, eliminating the root/local dependency on
  browser application code;
- the browser compatibility module is deterministic, generated, parity-tested,
  published atomically and durably, and checked by the macOS packaging path;
- macOS packaging discovers the complete static browser module closure and all
  supported Swift production sources, while failing closed for unsafe imports
  or Swift code placed in an unknown source tree; and
- R7 workload provenance recursively binds the new shared runtime source so a
  shared-contract change cannot retain stale release evidence.

The former `shared/telemetry/` transitional implementation was removed after
root, local, browser, and Worker consumers passed the same frozen golden and
adversarial fixtures. The package owns runtime validation; platform adapters
retain their intentionally different trust-boundary work.

### Checkpoint verification

- Root suite: 1,145 tests passed with no failures or skips.
- Product gate: architecture and generated-contract checks passed; browser
  73/73, release-site 9/9, local companion 118/118, Worker scripts 68/68,
  Worker runtime 93/93, Cloud Run 13/13, and macOS 23/23 passed, including
  dry-deploy and packaged-app watchdog checks.
- Independent focused reviews found no critical issues. Their dynamic-import,
  excluded-module, CommonJS, directory-durability, Swift-discovery, and
  standalone-release findings were converted into implementation changes and
  regression tests.
- The complete dual-runtime R7 matrix was regenerated after the hashed source
  set was frozen: 10 content-free receipts now bind 167 source files at
  workload SHA-256
  `864c8bd41c9889cf9bf8787d308b045301b8a1f91a0ea2497e7c04409d39a8bc`
  and revalidate against the current contract.
- R7 publication uses a generation-scoped exclusive journal. Recovery verifies
  same-user process ownership with PID, kernel start time, process group,
  session, and full-command digest; it refuses an exact live owner, rejects
  automatic cross-generation recovery, and removes a losing contender's draft
  only by its bound inode identity. A complete dead-owner draft is recoverable;
  an incomplete or unverifiable draft is retained for manual inspection
  without mutating release receipts.

## Phase 1 accounting checkpoint

- `packages/accounting` owns the exact ledger, official registry, and local
  pricing adapters behind one reviewed package export. Root compatibility
  modules re-export those same function and object identities.
- The root pnpm workspace resolves the package directly. The separately locked
  Worker uses a copied `file:` dependency and fails its check when the installed
  inventory or any byte differs from the source package.
- One frozen fixture matrix covers subscription Fast with Standard API
  counterfactual pricing, explicit API Priority, the exact 272,000-token
  context boundary, sub-micro fixed-scale arithmetic, and Anthropic cache/output
  semantics. The package and Worker project the same exact supported results.
- Local and Worker adapters intentionally retain different missing-context and
  coverage policies outside that common supported fixture set. Those trust
  boundary semantics are not falsely normalized as package parity.
- R7 workload provenance recursively binds the accounting runtime source,
  package manifest, root workspace policy, shared runtime source, and lockfiles.
- `npm run architecture:check` currently reports zero approved debt edges.

Phase 2, the telemetry contract, is closed. Larger flat-source and
composition-root moves remain gated on preserving its package, parity, and
macOS bundle-discovery guarantees.

## Phase 2 telemetry-contract checkpoint

- `packages/telemetry-contract` now owns v0.1/v0.2 telemetry validation,
  normalization, closed allowlists, envelope validation, fixed content-free
  errors, and canonical v0.2 JSON Schemas behind one reviewed package export.
- Root, local, browser, Worker, and contained Cloud Run compatibility tests use
  the same frozen golden, legacy-ID, malformed, hostile-object, and
  content-bearing fixtures. Cryptography, HTTP, participant authorization,
  persistence, and filesystem behavior remain in their runtime adapters.
- The browser module is generated atomically from the package and is required
  by local, release-site, and macOS package discovery. Browser file review
  rejects duplicate raw JSON object keys before native parsing can erase an
  earlier privacy-forbidden field.
- The package runtime and JSON Schemas deliberately agree on historical
  base64url-43 event, snapshot, marker, and model identifiers. Canonical
  emitters plus new dataset/account-track identifiers remain hex-64.
- The former `shared/telemetry/` runtime and roughly 900 lines of duplicate
  root validation were removed. The Node envelope adapter exposes only
  validated real encryption, and v0.2 canonicalization validates hostile input
  before dereferencing it.
- Package-owned schemas generate the legacy root mirrors. Root tests and the
  product gate reject a partial or stale mirror; no runtime consumes those
  compatibility copies.
- The independently locked Worker verifies exact installed bytes for both
  workspace packages before every dev, account-scoped dev, lab, acceptance,
  dry-deploy, staging-check, and disabled-staging deployment route. Decrypted
  JSON rejects duplicate keys before parsing.
- R7 source provenance now binds the package runtime, manifest, and canonical
  schema tree instead of the removed transitional implementation.

### Phase 2 verification

- Architecture: 165 production files, 806 parsed imports, zero approved debt
  edges.
- Product gate: browser 77/77, release site 10/10, local companion 118/118,
  Worker 100/100 plus type and script checks, Cloud Run 15/15, and packaged
  macOS 23/23 passed. Worker dry-deploy and contained staging dry-run passed
  without an external deployment.
- The broad root suite passed every non-R7 assertion. Its only two failures are
  the retained generated-R7 receipts rejecting the changed schema-module hash,
  workload hash, and file count as designed.
- Exact Node 24.14.0 and Node 26.2.0 focused package, adapter, Worker,
  deployment-guard, and parity checks passed.
- A focused phase-boundary re-audit found no remaining critical, high, or
  medium issue.

## Phase 3 owned-source checkpoint

The first bounded Phase 3 slice is complete:

- `src/providers/codex/account-scope.js` and
  `src/providers/codex/app-server.js` now have one reviewed public facade at
  `src/providers/codex/account.js`;
- all five production consumers use that facade, the two former flat source
  files were removed, and no compatibility shim remains;
- the facade has an exact export allowlist and identity-parity test;
- the local-review artifact policy excludes the provider-owned app-server by
  semantic path rather than a fragile basename, with direct and transitive
  regression coverage; and
- current governance paths now identify the new owner.

Independent verification passed 105 focused account, normalization, capture,
experiment, passive-collector, and crosscheck assertions; 18 architecture
checker assertions; the local-review ownership regression; syntax checks; and
`git diff --check`. The architecture scan covers 166 production files and 807
imports with zero approved debt edges. The owning agent additionally passed
17/17 local-review tests, 19/19 macOS bundle tests, and a real unsigned
local-review artifact build.

The second bounded Phase 3 slice is also complete:

- the architecture checker detects deterministic production cycles across
  static, export-from, literal dynamic, and workspace-package imports;
- source-owner direction, exact public-facade use, workspace-package public-root
  use, cross-package isolation, product-to-tooling isolation, and applicable
  app rows are structural and cannot be baselined;
- absolute paths, `file:` URLs, symlinks, extensionless excluded modules,
  CommonJS loaders, and workspace-named tools cannot bypass the scan;
- the Claude statusline sanitizer/parser/formatter contract now lives in
  `src/providers/claude/statusline.js`, while the stable flat entrypoint is only
  CLI/storage composition and re-exports the exact provider bindings; and
- the former Claude statusline/storage production cycle is gone rather than
  accepted as debt.

Independent verification passed 53/53 architecture fixtures and scanned 167
production files with 810 imports, zero cycles, and zero approved debt edges.
The Claude provider/storage/callback suite passed 49/49, the macOS closure and
runtime suite passed 19/19, syntax checks passed, documentation links are
normalized, and `git diff --check` passed.

The third bounded Phase 3 slice is complete:

- `src/codex-local-usage-analysis.js` exclusively owns the pricing and
  application projection over content-free Codex scan events;
- `src/codex-log-scan.js` no longer imports accounting, API pricing, the price
  registry, or RunCost, and does not re-export the removed analysis function;
- all production analysis callers import the new owner directly, while the root
  workspace declares `@app-usagemonitor/accounting` explicitly;
- exact boundary tests reject every direct or subpath accounting/pricing import
  back into the scanner;
- raw callback and source-fingerprint tests prove prompts, responses, paths,
  session IDs, tool inputs, tool IDs, rollout names, and other raw metadata do
  not escape; and
- the weekly calibration audit has an isolated real-rollout subprocess test for
  exact recognized-model pricing, owner-only output, bounded stdout, and
  private-data exclusion.

Verification passed 184 focused assertions, 24/24 accounting/local-review/
packaged-macOS closure assertions, syntax, and `git diff --check`. The
architecture scan covers 168 production files and 813 imports with zero
approved debt. The most recent full root suite passed 1,201/1,203 assertions;
only the two intentionally stale generated-R7 receipts failed. A focused
quality audit reported no finding, and the test/documentation audit's three
medium gaps are closed.

The next Phase 3 slice must move Codex rollout parsing and normalization behind
a reviewed provider facade with explicit bounded-reader and source-verification
ports. Provider-owned surface and tier normalization must be separated from
application-owned quota sensitivity. Callback shapes, replay protection,
source consistency, path-free fingerprints, and the explicit local-only
`includeSourcePaths` escape hatch remain exact contracts. Mixed export,
pricing, quota-analysis, callback, or storage modules still must not be
mechanically relocated merely because their filenames contain a provider name.

The fourth bounded Phase 3 slice is complete:

- Codex rollout discovery, frozen-prefix verification, parsing, normalization,
  surface classification, and provider-tier normalization now live under
  `src/providers/codex/`;
- `src/providers/codex/logs.js` is the only reviewed provider entry point and
  exposes an exact 20-name public API plus an injected scanner factory with
  exactly eight operations;
- the provider accepts explicit filesystem and bounded-line-reader ports and
  has no Node, pricing, accounting, quota-analysis, application, export,
  contribution, reporting, platform, app, script, or tool dependency;
- `src/codex-log-scan.js` is a temporary, explicitly named Node
  composition/compatibility facade that preserves the exact 21-name legacy
  surface while callers move to application composition roots;
- surface classification and provider-tier normalization moved behind the
  facade, while quota-weight sensitivity remains outside provider ingestion;
- source identity, descriptor verification, active-append proof, error object
  identity, callback shape, diagnostics, replay behavior, path-free default
  fingerprints, and the local-only `includeSourcePaths` option remain exact;
  and
- the historical discovery-lineage byte policy deliberately remains unchanged.
  The proposed bounded-read behavior change was rejected because this
  architecture slice has no authority to alter product semantics.

Independent verification passed 199 provider boundary, port, source,
normalization, privacy, and architecture assertions, plus 116 indirect export,
collector, transition, replay-accounting, and local-analysis assertions.
The full root suite passed 1,220/1,222 assertions; only the two intentionally
stale R7 receipts failed on their current-source provenance invariants. The
complete product gate passed browser 77/77, release site 10/10, local 118/118,
Worker scripts and type checks, Worker runtime 100/100, Worker dry-deploy and
contained staging dry-run, Cloud Run 15/15, and packaged macOS 23/23. The
architecture scan covers 174 production files and 828 imports with zero
approved debt, and the read-only provider quality audit found no issue.

The temporary root scanner facade must be removed before the final R7 source
freeze. The next Phase 3 checkpoint is to migrate consumers by real semantic
owner, beginning with the smallest export/application boundary identified by
the current dependency audit; it must not turn the provider facade into a
general application service merely to eliminate the compatibility file.

The fifth bounded Phase 3 slice is complete:

- application-owned subscription-speed sensitivity now lives behind
  `src/application/index.js`;
- provider tier validation and normalization remain behind
  `src/providers/codex/logs.js`; the temporary `src/tier-semantics.js` path
  has been retired;
- all seven production sensitivity consumers use the application public entry
  point, while the Codex provider exports no application policy;
- export compatibility versions and reviewed model, limit, and diagnostic
  registries now live behind `src/export/index.js`;
- every production metadata consumer uses that export public entry point, and
  the two former flat metadata modules have been retired; and
  and
- the local-review CLI parser is a pure independently tested module rather than
  command-dispatch implementation.

Focused application, export, and local-review tests passed 13/13. A twice-built
unsigned local-review artifact was byte reproducible at SHA-256
`b14537975171f014160c045308aabcf1760b87b6a76cbd8adab00c2917209969`,
and its 12-command offline/network/identity smoke passed with zero JavaScript
or native network attempts and zero privacy-canary hits.

Two Phase 4 enabling ratchets are also complete. The architecture checker now
scans the distributable `local-review/**` application and names each of its 16
pre-existing flat-source imports as an exact temporary migration edge. A 17th
edge, cross-application import, product-to-tool import, owner deep import, or
cycle fails the checker. Separately, one executable parity test derives the
transitive browser module graph from the macOS packager and compares it in both
directions with the loopback server's exported static-module routes. Current
verification passed 109/109 architecture, loopback, local-review, browser
closure, and packaged-macOS assertions. The architecture scan covers 182
production files and 864 imports; the only 16 approved edges are that exact,
named local-review migration set.

The Phase 5 inventory foundation is complete. A machine-checked
`tools/tool-inventory.json` classifies 41 logical records covering 43 physical
script, tool, report-builder, verifier, and product-contribution paths, with 29
tracked npm aliases. Canonical implementations now live under
`tools/operations/` and `tools/reports/`, stable npm aliases target them, and
legacy paths are behavior-identical forwarders. Inventory, alias
mutation/check parity, normalized-link, syntax, architecture, and
`git diff --check` gates pass.

No compatibility path described in this checkpoint is a final-state
exception. The tier, export-metadata, Codex scanner, retained tool shims, and 13
local-review migration paths must either be removed after all callers migrate
or be justified as permanent public contracts before the final source freeze.

The runtime-neutral quota kernel is now a third reviewed workspace package:

- `@app-usagemonitor/quota-analysis` owns quota-track/reset evidence,
  calibration and prior-reset forecasting, and one-, two-, and three-hour
  rolling comparisons behind one exact ten-binding public root;
- the package has no runtime dependency and its three implementation files
  retain the exact pre-extraction SHA-256 bytes;
- complete TypeScript declarations replace the Worker's former suppression,
  and the Worker consumes only the package root under strict type checking;
- the root workspace uses `workspace:*`, while the independently locked Worker
  uses `file:../../packages/quota-analysis` and its generic byte-exact guard now
  verifies accounting, telemetry-contract, and quota-analysis before every
  Wrangler entry point; and
- the three former `shared/quota-*` paths are exact identity shims and are
  explicit pre-freeze removal work.

Independent verification passed 91/91 root quota, application, package, and
architecture assertions; 27/27 Worker workspace-package guard assertions;
Worker strict TypeScript; and 4/4 private quota-backend runtime assertions.
The checked package bytes match the three files from the pre-move Git tree.
At that checkpoint, architecture covered 187 production files and 870 imports.

The first local-companion implementation seam is also explicit:
`apps/local/static-assets.js` owns the frozen browser asset table and pure
report-route construction, while the server remains the composition point for
the product report manifest. Browser serving parity imports that leaf directly,
so it no longer evaluates the 2,500-line server merely to inspect asset
metadata. Loopback and browser-closure verification passed 26/26.

The second local-companion seam is also explicit:
`apps/local/transport/participant-relay-routes.js` owns one frozen,
enumerable 16-entry path-and-method policy. Its matcher derives from that exact
policy, while `server.js` retains origin selection, authorization, bounded-body
handling, transport, and response translation. Exact policy and integration
checks passed 2/2 and 4/4; the full local suite passed 120/120; and browser plus
macOS closure checks passed 20/20.

The first browser composition seam is also complete:
`apps/web/public/navigation.js` owns intersection observation, hash
synchronization, active-link and ARIA state, disclosure opening, and teardown
through injected browser dependencies. `app.js` mounts that behavior before
bootstrap, and the loopback asset table, release-site closure, and macOS
import-aware bundle all discover the module. Focused navigation passed 3/3,
the browser suite passed 80/80, closure plus release passed 11/11, the local
suite passed 120/120, and the macOS bundle suite passed 19/19. A real Chromium
pass over static loopback verified direct `#data`, `#community`, and `#history`
state, including exact active/ARIA and disclosure behavior; its only console
errors were expected missing-companion API responses.

The sixth bounded Phase 3 slice is complete:

- `src/export/resource-policy.js` owns the deterministic resource-limit
  contract and requires explicit clock and RSS ports;
- `src/platform/` owns bounded JSONL and streaming-directory adapters without
  importing export policy;
- `src/application/local-export-resource-context.js` binds export errors,
  limits, and marker-reading semantics behind the application public entry
  point;
- `local-review/cli.js` composes the application context with reviewed platform
  adapters and no longer imports the two flat resource modules directly; and
- the old resource-policy and bounded-JSONL paths remain tested compatibility
  shims for other callers, with removal deferred until those callers migrate.

Real command characterizations exercise successful `inspect-export`,
`export-local`, and `export-set` paths and exact covered-duration/source-byte
failures. Focused behavior and architecture checks passed 112/112, macOS
closure passed 4/4, and architecture now covers 192 production files and 878
imports with exactly 14 approved local-review migration edges. Two unsigned
artifact builds were byte-identical at SHA-256
`84e4051ddf9235b038b710d73c53e3c57c7a09b985f9cbae2a1603d2a57de235`,
and the packaged doctor reported networking absent.

The seventh bounded Phase 3 slice is complete:

- the byte-identical Keychain implementation is owned by
  `src/platform/export-identity-keychain.js` and exposed only through the
  reviewed platform facade;
- `src/application/production-participant-identity.js` owns pure,
  port-driven backend selection and collapses adapter failures without
  importing a concrete platform implementation;
- the old Keychain path remains an exact five-binding identity shim, and the
  old production-identity path remains a four-binding compatibility
  composition module for consumers not yet migrated;
- local-review composes the application selector with the platform adapter and
  owns only closed-vocabulary identity presentation; and
- the exact local-review edge to the flat production-identity module is gone.

Focused identity, callback, Keychain, local-review, and architecture checks
passed 81/81. The independently rerun architecture and ownership suite passed
74/74, and the current scan covers 197 production files and 884 imports with
exactly 13 approved local-review migration edges.

The second delivery-root extraction is complete. A pure Worker route registry
owns all 23 exact paths, aliases, and route classes. `apps/worker/src/index.ts`
matches a request once and dispatches through an exhaustive route-ID switch;
middleware, dependency construction, failure logging, and asset fallback
remain composition-root responsibilities. Focused route tests passed 3/3,
the request pipeline passed 66/66, and the owning Worker verification passed
103 runtime assertions, 72 script assertions, 27 package-guard assertions,
strict TypeScript, and local plus contained-staging dry deploys.

One additional reports-tool relocation was intentionally rejected. The
historical minimization evaluator's dated receipt records its direct script
path, while the tool inventory correctly rejects documented legacy paths.
Rewriting the receipt or adding a broad exception would weaken provenance.
The executable therefore remains classified as a
`historical_research_report` with a provenance-bound canonical path until a
separate archival design can preserve that immutable command history.

The eighth bounded Phase 3 slice owns bundle verification and compatibility
composition:

- `src/export/` owns runtime-neutral canonical JSON, schema, privacy, semantic
  bundle verification, and pure compatibility-tuple assembly;
- `src/platform/` owns owner-only bundle/receipt reads, SHA-256, and exact
  repository artifact reads;
- `src/application/` binds those ports into bundle-verification and
  compatibility contexts;
- local-review composes only reviewed application and platform public entries,
  so its flat bundle-verifier edge is removed; and
- `src/bundle-verifier.js` retains the four legacy bindings, including Buffer
  return compatibility, while `src/export-contract.js` retains its exact
  three-binding composition API for unmigrated callers. Both are explicit
  pre-R7 removal checkpoints.

The compatibility context has no generated-only default: callers must inject a
current tuple function, and the application composition recomputes the tuple
from exact schema, field-contract, consent, and contract bytes plus the
reviewed registry snapshot and package identity before comparing it with the
generated manifest. The filesystem adapter validates
positive safe maxima before any I/O, bounds allocation to the opened
descriptor size, probes only one additional byte for growth, and revalidates
artifact and canonical-parent identity around every read. Exact date-time
validation rejects normalized impossible dates.

Legacy/canonical byte parity now covers successful results and fixed malformed,
noncanonical, oversized, and privacy-gate failures. Deterministic platform
tests cover size, owner, adjacency, open/read replacement, same-inode mutation,
and parent replacement. The real local-review `verify-bundle` route is
characterized after `export-local`, and the retained packaged artifact smoke
already includes that launcher command. Focused verification passed 67/67;
architecture covers 208 production files and 909 imports with exactly 12
approved local-review migration edges.

The fourth delivery-root seam is the macOS semantic-open target. One injected
value object is used by both application URL delivery and launcher smoke
handling. Runtime cases reject port, non-root, doubled, percent-encoded,
credentialed, query, fragment, and empty-delimiter variants. The macOS bundle
suite passed 19/19.

The browser navigation seam now retains visibility state across incremental
`IntersectionObserver` callback batches. A sequential-callback test closes the
former delta-as-snapshot bug while retaining the already verified hash,
disclosure, active-link, and ARIA behavior.

The ninth bounded Phase 3 slice moves Claude callback capability policy into
`src/application/` while retaining concrete Keychain capabilities and backend
construction in `src/platform/`. Local-review composes both reviewed facades;
the flat callback path is now an exact seven-binding compatibility shim for
unmigrated callers. This removes one approved edge without pulling the larger
callback lifecycle, export identity, or storage clusters into the slice.

The compatibility platform port no longer exposes mutable parsed JSON and
returns defensive byte views. The export owner snapshots and parses each
artifact once before using its values and hashes. Freshness tests mutate every
bound file input and the reviewed registry snapshot. Both runtime packaging
graphs now accept trailing-comma `new URL(..., import.meta.url,)` syntax and
assert the complete 11-file compatibility closure. Focused graph and
compatibility tests passed 10/10, the callback slice passed 101/101, the macOS
bundle suite passed 19/19, and architecture covers 209 production files and
910 imports with exactly 11 approved local-review migration edges.

The prior local-review artifact hashes no longer describe the current source
after this hardening. Reproducible rebuild, packaged 12-command smoke, broad
product gates, and final R7 regeneration remain post-freeze work.

The tenth bounded Phase 3 slice moves participant-identity ownership into
`src/platform/participant-identity.js` as one cohesive 24-binding owner. The
flat `src/export-identity.js` path is an exact named compatibility facade for
unmigrated callers, while local-review consumes identity inspection, rotation,
lease, and default-path behavior through the reviewed platform entry point.
This removed one exact allowance without splitting credential validation,
retirement controls, or secret-zeroization behavior. Focused identity,
application, local-review, and architecture verification passed 109/109; the
macOS suite passed 19/19; and architecture covered 210 production files and
911 imports with ten approved local-review migration edges.

The eleventh bounded Phase 3 slice moves Claude callback lifecycle ownership into
`src/platform/` without moving application policy or unrelated legacy callers:

- `src/platform/claude-callback-lifecycle.js` owns the owner-only Claude
  settings, lifecycle state, operation lock, stale-lock recovery, crash
  recovery, exact coexistence restoration, and directory durability behavior;
- `createClaudeCallbackLifecycleContext()` requires the reviewed application
  capability error class, four injected capability operations, and an
  absolute runtime-script path, and returns the exact eleven lifecycle methods
  and default builders;
- `src/claude-callback-lifecycle.js` composes the application capability
  context and platform lifecycle context as an exact 12-binding compatibility
  shim, with no lifecycle implementation of its own;
- local-review composes the same reviewed contexts with the exact packaged
  `src/claude-callback-runtime.js` URL and no longer imports the flat lifecycle
  module; and
- exactly one architecture allowance is removed, leaving nine approved
  local-review migration edges.

The platform context passes through only the exact reviewed capability error
class. Proxy-wrapped classes, ports, errors, and result records are rejected;
raw thrown errors, hostile thenables and getters, and malformed result shapes
collapse to a fixed content-free lifecycle configuration error. Ensure results
always zeroize a verified Buffer through an intrinsic captured before calling
an injected port, even if another field is invalid or the Buffer shadows its
public `fill` method, and rotate, plan, and remove results are reconstructed
from exact closed shapes before crossing the boundary.

Behavioral and boundary verification passed 118/118. Local-review
build-policy and aggregate runtime-gate contracts passed 9/9. Architecture
passes over 211 production files and 912 imports. The local-review and macOS
runtime closures contain 98 and 96 files respectively and both include the new
platform owner. Of 19 macOS bundle tests, 17 passed; the remaining two
are clean-host capability evidence because the managed runner denies both the
external Swift/Clang module-cache write and loopback listen. No R7 evidence was
regenerated, and all pre-freeze R7 receipts remain intentionally stale.

The twelfth bounded Phase 3 slice moves export-set verification into reviewed
owners while preserving every v0.1 and v0.2 contract:

- `src/export/set-schema.js` owns the exact 26-binding manifest schema API,
  uses runtime-neutral JSON imports and reviewed fixed schema digests, and
  preserves the current v0.2 schema-object alias identity;
- `src/export/set-verification.js` owns the fixed verification error taxonomy,
  manifest/receipt precedence, compatibility checks, chunk ordering and
  maximality, logical framing digest, byte totals, and summary projection;
- `src/platform/export-set-verification-storage.js` owns owner/link/mode checks,
  no-follow reads, bounded directory enumeration, SHA-256 mechanics, temporary
  SQLite uniqueness indexing, transaction batching, and cleanup behind narrow
  injected ports;
- `src/application/local-export-set-verification.js` binds the export semantics
  to reviewed storage, compatibility, and bundle-verification contexts;
- hostile schema, configuration, storage, artifact, bundle, index, and cleanup
  boundaries collapse to fixed content-free failures, while reviewed bundle,
  compression, resource, and set-verification errors retain their exact class
  and identity only when their exact prototype and canonical own fields match;
  callable ports avoid attacker-controlled `.bind` lookup, public option
  objects are snapped inside guarded bodies, partial SQLite setup is always
  removed, and cleanup cannot mask an already-propagating primary verification
  failure;
- the gzip implementation moves intact to `src/export/compression.js` as one
  shared primitive, and `src/export-compression.js` becomes an exact four-name
  identity shim; and
- the flat schema and verifier modules remain exact implementation-free
  compatibility shims, while local-review composes reviewed application and
  platform facades and removes exactly one allowance, leaving eight approved
  migration edges.

The exact 142-test pre-move baseline passed. Post-move behavioral and boundary
verification passed 156/156, and local-review build-policy, archive, and
aggregate runtime-gate contracts passed 13/13. Architecture passes over 216
production files and 924 imports with eight approved edges. The local-review
and macOS runtime closures each contain 103 files and include every new owner.
No R7 evidence was regenerated; retained pre-freeze receipts remain
intentionally stale. The real aggregate local-review runtime command reached
the native network-audit build, where the managed host denied Clang
temporary-file creation; that clean-host release receipt remains deferred.

The thirteenth bounded Phase 3 slice removes only the legacy
`local-review/cli.js -> src/storage.js` dependency:

- `src/platform/owner-only-export-artifact-storage.js` now owns the complete
  receipt-first pair transaction and recovery lifecycle, including canonical
  journal serialization through an injected reviewed serializer;
- `src/platform/owner-only-filesystem.js` owns the shared no-follow owner,
  directory-sync, and absent-path primitives used by both the pair owner and
  surviving single-file compatibility path;
- `src/platform/local-state-paths.js` owns the activity-marker default;
- `src/application/local-export-artifact-storage.js` binds resource limits,
  the resource-error class, and canonical JSON into the injected platform
  factory, while retaining the exact operation names for composition clients;
- `src/storage.js` keeps the stable compatibility bindings, generic storage,
  and the separate single-file no-clobber publication behavior; and
- the architecture checker holds a frozen exact ledger of every remaining
  direct `src/storage.js` source caller so a new caller or an undocumented
  migration is a failure.

The focused 114-test owner, API, crash-recovery, local-review, and architecture
suite passed. The actual architecture graph is 220 production files, 937
imports, and seven approved local-review edges. Local-review packaging
contracts passed 13/13. Two macOS package tests remain clean-host-only because
this managed runner denies Swift/Clang cache writes and loopback listening; the
aggregate local-review runtime gate likewise reaches the native audit build
before Clang temporary-file creation is denied. This is not release evidence
and does not change the S6 clean-host requirement.

## Verification strategy

### July 31 deletion-owner migration evidence

Deletion is now split across runtime-neutral export schema/contract ownership,
an injected application plan facade, and two owner-only platform adapters for
preflight inspection and durable deletion recovery. The old deletion modules
retain only compatibility bindings. Both command roots use the application
facade, and the architecture ledger now has three remaining approved edges
(controller and workspace-discard pair). The focused deletion and
supplemental-lifecycle replay passed 43/43; the added owner-boundary coverage
proves exact legacy binding identity and rejects proxy/getter configuration
without executing canaries. `architecture:check`, `tools:inventory:check`, and
`git diff --check` passed. R7 remains intentionally unregenerated until the
final frozen source boundary.

For every slice:

1. run the smallest owning test suite before and after the move;
2. run import/export and build-discovery checks;
3. run parity fixtures for shared behavior;
4. run the affected packaged/runtime smoke test;
5. run the full product check when a shared package or composition root changes;
6. inspect the real local web and packaged macOS flows when UI or asset
   discovery changes; and
7. record remaining compatibility shims and architecture debt in this plan.

No phase is complete merely because files moved or imports compile.

## Non-goals

- A single large rename or “clean architecture” rewrite.
- Converting all JavaScript to TypeScript before boundaries are stable.
- Centralizing helpers solely because their names match.
- Moving privacy validation into a generic utility layer.
- Combining local and central persistence behind an abstraction that hides
  their different trust and lifecycle requirements.
- Replacing extensive integration tests with isolated unit tests.

## Completion definition

Repository hardening is complete when:

- all product surfaces depend on shared behavior through reviewed package APIs;
- shared packages have no app/runtime dependencies;
- app entry points are composition roots rather than feature implementations;
- provider, export, contribution, platform, and reporting ownership is visible
  in the tree;
- browser and packaging builds discover their complete dependency closure;
- one root quality command runs architecture, types, lint, tests, builds, and
  runtime smokes at the appropriate levels;
- no unexplained compatibility shims or baselined boundary violations remain;
- the packaged macOS app and real local/hosted contribution journeys still pass
  end to end; and
- the privacy-safe telemetry contract continues to reject all user content.
