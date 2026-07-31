---
title: Repository Architecture Completion Goal
date: 2026-07-30
type: goal
status: active
---

# Repository Architecture Completion Goal

## Goal

Complete the repository hardening defined in the
[architecture hardening plan](../plans/2026-07-29-repository-architecture-hardening-plan.md)
without changing the product's privacy, accounting, quota, recovery, packaging,
or contribution behavior.

The work is complete only when the repository has explicit owners and one-way
dependencies, every shared contract has one canonical implementation, delivery
entry points perform composition rather than domain work, product code cannot
depend on tooling, and the complete tested source closure is the closure shipped
to a new user.

Moving files, reducing line counts, or passing isolated unit tests is not
completion.

The consumer behavior baseline is the
[consumer contribution and updater verification report](../reports/2026-07-29-consumer-contribution-and-updater-verification-report.md).
An architectural change must preserve the responsibilities and omissions in
that report. Superseding any baseline behavior requires the user's explicit
approval in this thread and a linked, measured product-decision artifact before
implementation. This architecture goal cannot approve its own semantic change.

## Required order

### 1. Finish the telemetry contract boundary

- `packages/telemetry-contract` is the sole runtime-neutral owner of telemetry
  versions, allowlists, normalization, validation, stable safe errors, and
  canonical contribution schemas.
- Browser, Node, Worker, and Cloud Run pathways consume the same reviewed
  contract and golden/adversarial fixtures.
- Cryptography, transport, participant authorization, persistence, filesystem
  access, and UI stay in runtime-specific adapters.
- Runtime and JSON Schema acceptance agree.
- Raw JSON with duplicate keys fails before parsing can erase a forbidden field.
- Transitional validator implementations are removed only after parity passes.
- Worker installs fail before Wrangler starts if copied workspace-package bytes
  differ from the reviewed source package.

### 2. Rehome root product code by semantic ownership

Migrate one bounded cluster at a time into:

- `src/providers/{codex,claude}` for provider evidence ingestion and
  normalization;
- `src/export` for privacy-safe export contracts, workspaces, materialization,
  verification, and lifecycle;
- `src/contribution` for contribution preparation, review, queueing, and device
  synchronization;
- `src/platform` for filesystem, Keychain, process, crypto, and storage
  adapters;
- `src/application` for use cases and orchestration; and
- `src/reporting` for product-facing projections.

Each folder must have a deliberately narrow public entry point. Provider
modules must not own pricing, quota fitting, persistence, or UI behavior.
Compatibility shims must be named, tested, time-bounded, and deleted before the
final R7 source freeze. Mechanical prefix-based moves are prohibited.

The final allowed production dependency matrix is:

| Importer | May import | Must not import |
| --- | --- | --- |
| `packages/accounting/**` | its declared third-party arithmetic dependency only | another workspace package, product source, apps, tools, platform I/O, or browser globals |
| `packages/telemetry-contract/**` | no runtime dependency outside its own package | another workspace package, product source, apps, tools, platform I/O, crypto adapters, or browser globals |
| `packages/quota-analysis/**` | no workspace-package dependency unless this matrix is first amended with parity evidence | product source, apps, tools, platform I/O, browser globals, or undeclared cross-package imports |
| `src/providers/**` | its own provider subtree and `@app-usagemonitor/telemetry-contract` only when emitting that contract | accounting, quota-analysis, another provider, `application`, `export`, `contribution`, `platform`, `reporting`, apps, or tools |
| `src/export/**` | its own public modules, reviewed provider public entry points, and `@app-usagemonitor/telemetry-contract` | accounting, quota-analysis, application, contribution, reporting, concrete platform adapters, apps, or tools |
| `src/contribution/**` | its own public modules, the export public entry point, `@app-usagemonitor/telemetry-contract`, and `@app-usagemonitor/accounting` | providers, quota-analysis, application, reporting, concrete platform adapters, apps, or tools |
| `src/reporting/**` | its own public modules, `@app-usagemonitor/accounting`, and `@app-usagemonitor/quota-analysis` | providers, export, contribution, application, concrete platform adapters, apps, or tools |
| `src/application/**` | reviewed public entry points from providers, export, contribution, reporting, accounting, telemetry-contract, and quota-analysis | concrete platform implementations, apps, tools, or another owner's private module |
| `src/platform/**` | its own modules, Node/platform APIs, and `@app-usagemonitor/telemetry-contract` where a boundary adapter must validate it | accounting, quota-analysis, application, providers, export, contribution, reporting, apps, or tools |
| `apps/local/**` and local commands | application use cases, platform adapters, accounting, telemetry-contract, and quota-analysis | private/deep modules in an owner folder or another app's implementation |
| `apps/worker/**` | its own modules plus public accounting, telemetry-contract, and quota-analysis exports | root product source, private package modules, or another app's implementation |
| `apps/web/**` | its own browser modules and the checked generated telemetry-contract mirror | Node/platform modules, direct package deep imports, root product source, or another app's implementation |
| `apps/cloud-run/**` | its own modules and the telemetry-contract public export | root product source, private package modules, or another app's implementation |
| `apps/macos/**` | its own reviewed Swift/native modules and the packaged loopback executable boundary | JavaScript implementation deep imports or another app's implementation |
| `tools/**` | reviewed product/package public entry points | private/deep product modules unless an exact release-only exception is documented and mechanically checked |

Ports are owned by the use case or domain that consumes them; concrete platform
adapters are injected at a composition root. Every owner-to-owner import must
use an explicitly registered public entry point. The architecture checker must
contain positive and negative fixtures for every row above and finish with
zero production cycles, zero cross-owner deep imports, zero product-to-tooling
imports, and zero unexplained dependency edges.

The matrix is the final state, not permission to hide migration debt. As each
owner folder is introduced, its applicable rows are ratcheted immediately.
Any temporarily co-located process, filesystem, or storage behavior must have
an exact checked edge, an owner, and a named removal slice; no such exception
may survive the final source freeze.

The first bounded move is the Codex account/quota ingress:
`account-scope.js` and `codex-app-server.js`, followed by their known consumers.
Mixed-responsibility log, export-workspace, callback, and storage modules are
split before they are rehomed.

The export-workspace prerequisite is complete as of July 31, 2026: contract,
application composition, platform storage, and platform lease have distinct
owners while legacy public entry points remain composition-only shims. The
workspace-runtime/materializer slice also moves source-plan summaries and the
supplemental-plan contract behind the export owner; five local-review migration
targets remain: `export-deletion-executor`, `export-deletion`,
`export-set-controller`, `export-workspace-discard-executor`, and
`export-workspace-discard`.

### 3. Turn delivery surfaces into composition roots

- Split the local companion into lifecycle, routes, assets, refresh,
  contribution, central proxy, and diagnostics modules.
- Reduce the Worker entry point to environment validation, middleware, route
  registration, and dependency construction.
- Split browser state, data access, chart projection, contribution, navigation,
  and rendering while retaining one coherent user journey.
- Split macOS lifecycle, companion supervision, onboarding, updater, branding,
  semantic-open target, status UI, and Keychain adapters.

The packaged app must discover the same browser, Node, package, and Swift source
closure exercised by tests. Startup, shutdown, updater, restart, crash recovery,
offline analysis, manual contribution, and foreground automatic contribution
must still work in the packaged app.

The surface contract remains:

- the native app owns disclosure, local-source access, lifecycle, diagnostics,
  updater controls, and opening the loopback experience;
- the loopback dashboard owns personal analysis, contribution review, the
  explicit first send, receipts/status, and delayed personal/community
  comparison;
- the hosted site owns acquisition, verified downloads, documentation, and
  delayed public aggregates, and can never read local Codex files;
- the Worker owns disabled-first contribution ingestion, private calculation,
  delayed aggregation, retention, and deletion; and
- Cloud Run remains a contained, collection-disabled operational experiment
  until it implements the same isolation and lifecycle contract.

The first contribution remains off by default and requires current-contract
consent, bounded content-free preparation, exact local review, an explicit
send, and at least one accepted upload from that exact prepared set. Only then
may the user opt into the six-hour, foreground-only recurrence. The ordinary
journey must continue to omit recovery codes, account reset, personal
server-side export, and multi-device management while retaining quiet hosted
deletion and local troubleshooting controls.

### 4. Separate product code from retained tools

Classify every root script and report builder as product operation, release
operation, benchmark, historical report, or obsolete. Move retained tooling to
`tools/{reports,benchmarks,release,operations}` while preserving stable public
npm aliases and dated provenance. Search code, tests, docs, CI, and release
automation before removing an entry point.

Product code may never import `tools/**`.

Phase 5 must produce a machine-checked tool inventory containing every
executable under the former and current script/tool roots. Each record names
its classification, owner, canonical path, stable npm/CLI alias, callers,
retention or removal decision, and provenance artifact where applicable.
Completion requires zero unclassified entry points, zero missing aliases, zero
stale documented paths, and a fixture proving alias behavior is unchanged.

### 5. Raise and enforce the quality floor

- Keep the architecture baseline at zero unexplained dependency edges.
- Add cycle detection, public-export enforcement, source-owner isolation, and
  product-to-tooling checks.
- Remove the existing production cycle rather than normalizing it as permanent
  debt.
- Add narrow formatting, linting, and incremental JavaScript type checks.
- Keep new Worker TypeScript strict.
- Add adapter contracts, structured boundary errors, diagnostics, and
  adversarial/property tests for privacy, canonicalization, and exact
  accounting.
- Prefer a tested small module over an abstract layer that hides materially
  different trust boundaries.

Formatting, linting, and type-check commands must publish their exact
machine-checked production file scopes. They cover non-generated production
files under `apps/**`, `packages/**`, and `src/**`, plus retained
`tools/release/**` and `tools/operations/**` executables. Generated and vendored
files may be excluded only by an exact exemption record with an owner,
rationale, and removal condition. Completion requires zero unexplained
exemptions.

Phase 6 must add one root orchestration command named
`npm run architecture:complete`. It must run these exact constituent commands
in order and exit nonzero if any child fails:

1. `npm run format:check` for the published non-generated production and
   retained operational-tool scope;
2. `npm run lint:check` for that same scope;
3. `npm run types:check` for the declared incremental JavaScript and strict
   TypeScript projects;
4. `npm run architecture:check`;
5. `npm test`;
6. `npm run product:check`;
7. `npm run product:build:check`, which builds the browser assets, public
   release site, independently locked Worker and Cloud Run bundles, and unsigned
   macOS artifact without publishing or network mutation; and
8. `npm run product:runtime:smoke`, which starts isolated loopback services,
   exercises local, Worker, Cloud Run, packaged-app, restart, offline, and crash
   pathways, and always tears them down.

The aggregate command must print a deterministic child-command summary. A
missing, skipped, filtered, or zero-test child is a failure, not a successful
completion.

## Permanent product invariants

Throughout every migration:

1. The local collector may make bounded, transient reads of user-owned provider
   source logs solely to derive safe records. Prompts, responses, code, source
   paths, commands, arguments, URLs, repositories, emails, provider account
   identifiers, credentials, and raw device/session identities never enter
   derived telemetry, product logs/errors, browser responses, persisted product
   state, reports, snapshots, encryption envelopes, or uploads. Byte-level
   privacy canaries must test each emission, persistence, browser, encryption,
   and transport boundary.
2. Accounting remains exact and keeps uncached input, cache read/write, output,
   reasoning, context, model, subscription speed, and API tier semantics
   distinct.
3. Unknown models, tiers, surfaces, accounts, plans, and component availability
   remain explicit unknowns.
4. Quota tracks, reset identity, account/plan continuity, calibration
   uncertainty, and held-out error behavior remain unchanged. Any measured
   behavior change requires the user's explicit approval in this thread and a
   linked decision artifact before implementation.
5. Replay safety, no-clobber publication, crash recovery, bounded resources,
   owner-only state, and fail-closed deletion remain intact.
6. Useful local analysis remains available offline and without contribution.
7. Manual review precedes the first contribution; recurring contribution keeps
   its explicit consent and bounded foreground-only behavior.
8. Browser, local companion, packaged app, Worker, and Cloud Run trust
   boundaries stay explicit rather than being collapsed into a generic service
   abstraction.
9. Updater, configurable brand, and semantic-open-target behavior remain
   package-tested.

## Verification required for every slice

1. Run the smallest owning tests before and after the change.
2. Run shared golden, adversarial, identity-canary, malformed, oversized, and
   content-bearing parity fixtures where a contract moves.
3. Run architecture, import/export, cycle, and package-closure checks.
4. Run the affected runtime or packaged smoke test.
5. Update this goal's plan checkpoint with completed ownership, remaining shims,
   and exact evidence.
6. Preserve unrelated work and inspect the narrow diff.

## Final completion gate

Before this goal can be marked complete:

- `npm run architecture:complete` exits zero from a clean checkout-equivalent
  source tree and its summary proves that every required child command ran;
- clean frozen installs pass for the root workspace and independently locked
  Worker;
- root, package, architecture, telemetry, browser, local, Worker, Cloud Run,
  release-site, and macOS suites pass;
- type, lint, cycle, import, dry-deploy, packaging, and `git diff --check`
  gates pass;
- actual loopback browser QA and a built macOS app verify the fresh-install,
  local-analysis, manual-contribution, recurring-contribution, offline,
  restart, crash-recovery, and updater journeys;
- the clean-user rehearsal starts from an empty app state and follows the
  documented clicks from source/download verification through quarantine
  preservation, Gatekeeper launch, first-run disclosure, local-source access,
  useful-headline progress, bounded deep-analysis cancellation/resume, personal
  dashboard, reviewed first contribution, recurrence opt-in, updater from the
  immediately previous version, rollback, hosted deletion, and uninstall;
- each journey records elapsed time to first useful result, completion or pause
  state, visible recovery guidance, exact artifact/source hashes, and expected
  absence of raw content or non-loopback browser traffic;
- a disabled-first staged HTTPS exercise verifies readiness, upload
  registration, encrypted upload, validation, idempotent deduplication,
  participant-private result, delayed aggregate publication, deletion ledger,
  R2 reconciliation, invitation/admission and rate-limit enforcement,
  collection-control containment, backup plus deletion-ledger restore replay,
  key rotation and emergency containment, restart/recovery, operational
  ownership, and post-deletion readiness before any real participant or
  collection activation is authorized;
- privacy adversarial tests prove that all content-bearing shapes are rejected
  before storage or transport;
- focused code-quality, test/documentation, performance, and
  plan-completeness audits have no critical/high or invariant-breaking medium
  finding;
- README, ownership guidance, runbooks, package-generation instructions, and
  receipts match the implemented system;
- all compatibility shims and architecture baselines are either removed or
  explicitly justified as permanent public contracts; and
- the complete exact Node 24.14.0 and Node 26.2.0 R7 evidence matrix is
  regenerated only after the final covered source set is frozen and every
  retained receipt revalidates.

## Current checkpoint

Phase 2 is complete. The telemetry package and its Node, browser, Worker, local,
Cloud Run, packaging, and deployment-path adapters pass their complete product
gate. The first Phase 3 slice is also complete: Codex account scope and
app-server ingress now live behind `src/providers/codex/account.js`; all
production consumers use that public facade; the old flat paths and all shims
are gone; and the local-review artifact policy follows the new semantic owner.
Focused behavior, architecture, local-review, macOS bundle, syntax, and
artifact-build gates passed.

The second Phase 3 slice is complete. The architecture ratchet now enforces
cycles, owner direction, reviewed owner and workspace-package entry points,
package/app isolation, product-to-tooling separation, and bypass resistance
with zero approved debt. The Claude provider contract is separated from its
CLI/storage composition, and the former statusline/storage production cycle is
gone. Current verification passed 53 architecture fixtures over 167 production
files and 810 imports, 49 Claude provider/storage/callback assertions, 19 macOS
closure/runtime assertions, syntax, normalized documentation links, and
`git diff --check`.

The broad root suite still has only the two expected generated-R7 failures
because retained receipts correctly reject the changed source inventory. Those
receipts are not to be regenerated until the covered source set is frozen.

The third Phase 3 slice is complete. `src/codex-local-usage-analysis.js` is now
the sole application/pricing projection over the content-free Codex scanner,
and the scanner no longer imports accounting, API pricing, the price registry,
or RunCost. All production callers use the new analysis owner directly and no
reverse compatibility shim was added. The root workspace declares the
accounting package explicitly rather than reaching into its implementation.

The split is guarded by exact export and forbidden-import assertions, raw
scanner callback allowlists, source-fingerprint path-containment coverage, and
real-rollout canaries for prompts, responses, paths, session IDs, tool inputs,
tool IDs, and rollout names. The weekly calibration audit now has its own
isolated subprocess regression proving exact recognized-model pricing,
owner-only output, bounded content-free stdout, and no private rollout
retention.

Current verification passed 184 focused scanner, analysis, source-consistency,
normalization, export, collector, transition, capture, accounting, and
architecture assertions; 24/24 accounting, local-review, and packaged-macOS
closure assertions; and an architecture scan of 168 production files and 813
imports with zero approved debt. The most recent full root run passed
1,201/1,203 assertions; its only failures were the two intentionally stale R7
receipts. A focused quality audit found no critical, high, medium, or low
finding. The test/documentation audit's pricing-import blind spot, missing
weekly-audit owner test, and stale checkpoint are now closed.

The next implementation checkpoint is:

1. use the completed dependency audits to choose the smallest real
   export/application owner boundary and migrate its callers through a reviewed
   public facade;
2. remove the temporary root Codex scanner composition/compatibility facade
   only after every delivery and application caller receives explicit platform
   ports through its composition root;
3. continue export, contribution, platform, application, reporting, and
   delivery-root moves in bounded behavior-preserving slices;
4. complete the machine-checked tool inventory before relocating script entry
   points; and
5. freeze and regenerate R7 only after the covered source paths stop moving.

The fourth Phase 3 slice is complete. Codex rollout discovery, parsing,
normalization, source verification, surface classification, and provider-tier
normalization now live under `src/providers/codex/` behind one exact public
facade and an eight-operation scanner factory with injected filesystem and
bounded-reader ports. The provider has no Node, pricing, accounting,
quota-analysis, higher-level feature, app, script, or tool dependency.

The temporary `src/codex-log-scan.js` Node facade preserves all 21 legacy
exports while consumers are migrated; it is a removal checkpoint, not a
permanent namespace. The move preserves source identity, append verification,
error identity, callback and diagnostic shapes, replay behavior, privacy-safe
fingerprints, and the explicit local-only source-path option. The unbounded
historical lineage-read behavior was intentionally retained because changing
it requires a separate semantic decision.

Independent provider, boundary, and port validation passed 199 assertions; 116
indirect export, collector, transition, replay-accounting, and local-analysis
assertions also passed. The full root suite passed 1,220/1,222 assertions, with
only the two expected stale-R7 provenance failures. The complete product gate
passed browser 77/77, release site 10/10, local 118/118, Worker type/script and
100/100 runtime checks, Worker dry-deploy and contained staging dry-run, Cloud
Run 15/15, and packaged macOS 23/23. Architecture covers 174 production files
and 828 imports with zero approved debt. The provider quality audit reported
zero findings.

The fifth bounded ownership slice is complete. Subscription Fast quota
sensitivity is application policy behind the application public API;
provider tier semantics remain provider-owned; and the old mixed six-binding
tier path is only an identity shim. Export versions and reviewed registries are
owned behind the export public API, with the two old metadata paths
reduced to identity shims and no production consumer bypassing the facade.
Local-review argument parsing is now a pure shipped module. Focused tests passed
13/13, and two independent local-review artifact builds produced the same
SHA-256
`b14537975171f014160c045308aabcf1760b87b6a76cbd8adab00c2917209969`;
the artifact smoke exercised 12 commands with no JavaScript/native network
attempt or privacy-canary hit.

The delivery and tooling preconditions are now mechanically visible. The
architecture scanner treats `local-review/**` as a first-class application and
tracks its remaining flat-source imports individually; any additional
edge, product-to-tool dependency, owner bypass, app crossing, or cycle fails.
Browser packaging discovery and loopback JavaScript serving are compared from
their exported runtime tables rather than duplicated test lists. The combined
architecture, loopback, local-review, browser-closure, and packaged-macOS
verification passed 109/109 at that checkpoint.

The machine-checked tooling inventory now contains 41 logical records covering
43 physical executable or executable-adjacent paths and tracks 29 npm aliases.
Canonical tools now live under both `tools/operations/` and `tools/reports/`,
while their legacy script paths are behavior-identical forwarders. Inventory
completeness, fail-closed ownership fixtures, npm alias parity,
documentation-link checks, architecture, syntax, and `git diff --check` pass.

`@app-usagemonitor/quota-analysis` is now the single runtime-neutral owner of
track/reset evidence, calibration, prior-reset forecasting, and rolling
comparison. Its exact ten-binding public root has complete declarations and no
runtime dependency. Root and independently locked Worker installs resolve only
that root; the Worker has no quota type suppression, and its generic package
guard byte-verifies all three workspace packages before Wrangler. The three
former shared paths are identity-only removal shims. Independent verification
passed 91 root package/application/architecture assertions, 27 Worker package
guard assertions, strict TypeScript, and 4 private quota-backend assertions;
the package kernels match the pre-move Git bytes exactly.

The first local delivery extraction is also complete:
`apps/local/static-assets.js` owns the frozen static asset table and pure report
route construction. The server composes it with the product report manifest,
and browser serving parity can inspect the leaf without evaluating the server.
The loopback and browser-closure suite passed 26/26.

The local companion's participant relay policy is now a second pure delivery
leaf under `apps/local/transport/`. One frozen, enumerable 16-entry policy owns
the exact paths and methods, the private matcher derives from that same object,
and the server retains origin, authorization, bounded-body, transport, and
response responsibilities. Exact-policy, integration, full-local, and
browser/macOS closure checks passed 2/2, 4/4, 120/120, and 20/20 respectively.

Browser navigation is now a third bounded delivery seam. A dependency-injected
browser module owns intersection observation, hash synchronization, active-link
ARIA state, disclosure opening, and teardown; `app.js` only mounts it before
dashboard bootstrap. The loopback asset table, import-aware browser closure,
release-site build, and macOS bundle all include the module. Focused navigation,
full browser, closure/release, local, and macOS checks passed 3/3, 80/80,
11/11, 120/120, and 19/19. A real Chromium check over a temporary static
loopback server confirmed `#data` and `#community` active/ARIA state and the
intentional `#history` no-primary-link state; `#community` and `#history`
opened the contribution disclosure. The console contained only the expected
missing-companion API responses from the deliberately static server and no
module-load failure.

The sixth bounded ownership slice removes two more local-review legacy edges.
The export resource guard and limits now live in a deterministic,
platform-free export policy that requires explicit clock and RSS ports. Bounded
JSONL and directory enumeration are Node platform adapters, and the
local-review composition root injects them into one application-owned resource
context. Compatibility paths retain the old six-binding resource-policy and
three-binding JSONL APIs for unmigrated callers. Real command
characterizations cover successful `inspect-export`, `export-local`, and
`export-set` runs plus exact covered-duration and source-byte limit codes.
Focused behavior and boundary checks passed 112/112, macOS closure passed 4/4,
and the architecture scan covers 192 production files and 878 imports with
exactly 14 approved local-review edges. Two fresh unsigned artifact builds were
byte-identical at SHA-256
`84e4051ddf9235b038b710d73c53e3c57c7a09b985f9cbae2a1603d2a57de235`;
the packaged doctor completed locally with networking absent.

The seventh bounded ownership slice removes the local-review dependency on the
flat production-identity composition module. The Keychain implementation now
lives under `src/platform/` behind the reviewed platform facade, while
application-owned identity selection accepts explicit environment, runtime,
backend, and capability ports. The legacy Keychain path is an exact
five-binding identity shim, the legacy production-identity path retains its
four-binding compatibility API for unmigrated consumers, and local-review owns
only its closed-vocabulary presentation. Identity, callback, Keychain,
architecture, and local-review checks passed 81/81; the focused boundary suite
passed 74/74; and the architecture scan now covers 197 production files and
884 imports with exactly 13 approved local-review migration edges.

The Worker now has one pure route registry for all 23 exact API paths, aliases,
and route classes. Its entry point matches each request once and dispatches
through an exhaustive route-ID switch, leaving route definition outside the
composition root without changing middleware, error translation, or asset
fallback behavior. The focused route registry passed 3/3, the request pipeline
passed 66/66, and the owning Worker verification passed 103 runtime assertions,
72 script checks, 27 workspace-package checks, strict type checking, and local
plus contained-staging dry deploys.

The tooling inventory deliberately leaves the provenance-bound historical
minimization evaluator at its recorded script path. Moving it would require
rewriting a dated receipt or weakening the exact stale-path check; neither is
an acceptable architecture improvement. It remains classified as historical
research work pending an archival design that preserves immutable command
provenance.

The eighth bounded ownership slice is complete in current source:

- runtime-neutral bundle parsing, schema validation, privacy checks,
  canonical JSON, and fixed verification errors are owned under `src/export/`;
- owner-only path, descriptor, parent-directory, hashing, and bounded-read
  behavior are owned under `src/platform/`;
- application composition requires explicit file-reader, hash, and current
  compatibility-tuple ports;
- local-review no longer imports the four-binding flat bundle verifier;
- compatibility assembly is export-domain code, artifact reads are a platform
  adapter, and application composition checks the generated manifest against
  exact schema, field-contract, consent, and contract bytes plus the reviewed
  registry snapshot and package identity before verification; and
- the flat `src/bundle-verifier.js` and `src/export-contract.js` paths are
  tested composition shims for unmigrated callers and must be removed before
  the final R7 source freeze.

The filesystem adapter rejects invalid maxima before I/O, reads only the
validated descriptor size plus a one-byte growth probe, and revalidates file
and canonical-parent identity around each artifact read. Differential tests
cover legacy and runtime-neutral valid, malformed, noncanonical, oversized,
and privacy-rejected byte paths. Date-time schema validation now rejects
calendar normalization such as February 31 rather than accepting `Date.parse`
coercion. Focused bundle, export, local-review, checkpoint, and platform
verification passed 67/67, and architecture passes over 208 production files
and 909 imports with exactly 12 approved local-review migration edges.

The macOS semantic-open predicate is now a product-configured value object
shared by lifecycle URL delivery and the launcher smoke path. Runtime tests
accept only the exact case-insensitive scheme/host with an empty or root path
and reject ports, extra and doubled paths, percent-encoded paths, credentials,
queries, fragments, and empty delimiters. The current macOS bundle suite passed
19/19.

The earlier browser-navigation audit also exposed an inherited
`IntersectionObserver` delta bug. The navigation owner now retains current
visibility ratios across callbacks rather than treating each callback as a
complete snapshot, and a sequential-callback regression proves a lower-ratio
newcomer cannot displace a still-visible higher-ratio section.

The ninth bounded ownership slice is also complete in current source:

- Claude callback credential policy is application-owned and binds an opaque
  capability supplied by a composition root;
- concrete Keychain capability and backend construction remain platform-owned;
- the flat callback module is an exact seven-binding compatibility shim; and
- local-review no longer imports that flat module, removing one additional
  approved migration edge.

Compatibility artifact reads now expose fresh defensive byte copies rather
than mutable parsed JSON. The export owner snapshots and parses those bytes
once before deriving identifiers and hashes. Mutation tests prove that schema
bytes and IDs, the field contract, package name and version, consent, contract,
and reviewed registry snapshot all invalidate a stale generated manifest.
Both packaging scanners recognize trailing-comma `new URL(...,
import.meta.url,)` inputs, and graph tests prove that all 11 live compatibility
inputs are included. Focused compatibility and graph checks passed 10/10, the
callback extraction passed 101/101, the macOS bundle suite passed 19/19, and
architecture now covers 209 production files and 910 imports with exactly 11
approved local-review migration edges.

The previously built local-review archive predates the compatibility and
bounded-read hardening above. It is not current evidence for this checkpoint.
Reproducible artifact build and the 12-command offline/network smoke must be
rerun after the next source freeze; R7 receipts remain intentionally stale.

### July 31 export-source ownership checkpoint

The local export-set source pipeline is now an owned application capability.
Ten former flat implementations live under `src/application/export-sources/`,
while Node filesystem, crypto, process, path, bounded-reader, and Claude-ledger
directory behavior lives in `src/platform/local-export-source-ports.js`. The
application facade accepts an explicit proxy detector authenticated by the
local runtime intrinsic, rejects the source-port object before reading a
member, and then descriptor-snapshots exact frozen top-level and nested
Codex-log port contracts before it reads configuration. Hostile accessors,
callable Proxies, thenables, missing fields, and extras are rejected without
executing canaries. `src/application/export-sources/**` has no direct `node:`
import; the existing `src/application/local-codex-log-scanner.js` runtime owner
does use `node:util/types`, so this is intentionally narrower than a transitive
Node-free-closure claim. Concrete platform discovery remains outside the
export-source owner.

The platform owner keeps frozen own-data snapshots of `LOCALAPPDATA` and
`XDG_STATE_HOME` for Claude state selection and a separate `CODEX_HOME`
snapshot for Codex-root parity. The caller's environment object is neither
exposed nor retained for later reads.

All ten historical root modules are exact aliases over one compatibility
singleton. Local-review composes the reviewed application and platform facades
directly and injects the default controller. The final architecture allowance
and eight obsolete direct-storage ledger entries are removed. The combined
affected behavior, crash/recovery, and owner-boundary replay passed 119/119;
the public-identity, hostile-boundary, import-time, owner-closure matrix itself
passed 14/14; and architecture
reports 263 production files, 959 imports, and zero approved debt. R7 remains
intentionally stale pending the final source freeze.

This completes the approved-edge migration, not the whole architecture goal.
The current tree still contains 117 flat root JavaScript entry points, including
deliberate compatibility surfaces and unclassified mixed-responsibility files,
and the exact production `src/**` direct-`src/storage.js` ledger contains 26
callers. Those roots,
S3 delivery composition, S4 tooling isolation, the S5 aggregate gate, and the
S6 clean-host/frozen-artifact work remain required before this goal can be
complete.

That 26-entry figure covers production importers under `src/**` only. Six
non-test tooling importers remain separately:
`apps/worker/scripts/smoke-sync-queue-http.mjs`,
`scripts/minimization-ablation.js`,
`scripts/r7-materialized-boundary-worker.js`,
`scripts/r7-resource-benchmark-worker.js`,
`scripts/regenerate-r7-release-evidence.js`, and
`tools/reports/build-prospective-collector-transitions.js`. S4 must freeze and
enforce that tooling ledger independently before the architecture goal can be
complete.

## Authority and blockers

This goal authorizes local code, tests, documentation, dry-runs, local browser
QA, and unsigned/ad-hoc development packaging inside this repository.

It does not authorize committing, pushing, publishing, deploying, provisioning
cloud resources, changing repository visibility, issuing production
credentials, code signing, notarization, DNS changes, or contacting users.

If final completion requires one of those human-only actions, complete every
local and dry-run prerequisite, record the exact command/action and evidence,
and report the external permission as the remaining blocker. Do not mark the
goal complete merely because a human-only gate remains.

Every external blocker record must name:

1. the human owner and exact permission, credential, billing acceptance,
   resource, or policy decision required;
2. why repository-local work cannot satisfy it;
3. every already-green prerequisite and its artifact or receipt hash;
4. the exact resume command or click path;
5. the expected result and independent verification command;
6. rollback or containment instructions; and
7. the repository-controlled work, if any, still remaining.

Before blocked status is eligible, create one dated
`docs/receipts/YYYY-MM-DD-repository-architecture-local-completion-receipt.md`
recording the source-inventory hash, every locally green gate and artifact hash,
and the sole remaining external condition. The same human-only condition must
then remain the blocker for three consecutive goal turns, counting the
user-triggered turn and automatic continuations. If a blocked goal is resumed,
that three-turn audit restarts at one. Only after this threshold may the goal be
marked blocked. A locally emulated backend, ad-hoc app build, or dry deploy
cannot be reported as the completed staged, signed, notarized, Gatekeeper,
update, deletion, or clean-machine journey.
