---
title: Repository Architecture Stabilization and Completion Goal
date: 2026-07-30
type: goal
status: archived
archived: 2026-07-31
extends: 2026-07-30-repository-architecture-completion-goal.md
---

# Repository Architecture Stabilization and Completion Goal

> **Archived 2026-07-31.** The owner decided to ship v0.1.0 from the current
> verified state rather than complete the S0–S6 sequence. The architecture work
> recorded here landed in commit `00c7e70` with zero approved debt edges; the
> root suite, aggregate product gate, and local-review runtime gate were
> verified green on the development Mac on 2026-07-31. The remaining S2 flat
> root migration, S4 tooling relocation, and S5 gate-command items are optional
> post-release maintenance, not release blockers. This document's
> commit/publish prohibition is superseded by the owner's release
> authorization.

## Purpose

Stabilize the current Usage Monitor architecture migration, then finish the
repository-hardening work in a controlled sequence without changing product
behavior or weakening any privacy, accounting, quota, recovery, packaging, or
contribution contract.

This goal refines the existing
[repository architecture completion goal](./2026-07-30-repository-architecture-completion-goal.md)
after the July 30 current-state audit. It does not narrow or replace that
goal's final requirements. It defines the immediate order, evidence, and
stopping conditions needed to reach them safely.

The work is complete only when the repository is stable from a clean
checkout-equivalent source tree, all production ownership is explicit,
delivery entry points are composition roots, tooling is isolated, the shipped
closure is the tested closure, one aggregate command proves the system, and
the final dual-runtime R7 evidence validates the frozen source.

## Audited starting point

The July 30 audit established this baseline:

- `npm run architecture:check` passes over 210 production files and 911
  imports with ten exact approved local-review migration edges;
- `npm run product:check` passes the browser, release-site, local, Worker,
  Cloud Run, and macOS surface gates;
- `npm test` runs 1,303 tests, of which 1,299 pass and four fail;
- two failures are ordinary integration drift from the participant-identity
  move and tool-inventory caller coverage;
- two failures are the intentionally stale Node 24/26 R7 evidence boundary;
- the root contains 114 flat JavaScript files, while the reviewed application,
  export, platform, and provider owners contain 36 JavaScript files;
- `src/contribution/` and `src/reporting/` do not yet exist;
- only three of 41 canonical tool entry points live under `tools/**`, while 30
  remain under `scripts/**` and eight remain under `src/**`;
- the principal CLI, local, Worker, browser, and macOS entry points remain
  implementation-heavy; and
- the required root formatting, linting, JavaScript type, build, runtime-smoke,
  and aggregate architecture-completion commands do not exist.

This baseline is evidence of partial progress, not a release-readiness claim.

## Coordination rule

Until Stabilization Gate S0 is green:

1. use at most one implementation worker at a time;
2. give that worker an exact file-ownership boundary;
3. do not start another architecture move while tests or documentation are
   inconsistent with the current move;
4. do not regenerate R7 evidence; and
5. do not interpret a green `product:check` as a substitute for the full root
   suite.

After S0, parallel work is allowed only for demonstrably disjoint files and
must converge through one sequential integration gate before another slice
starts.

## Permanent invariants

Every gate below must preserve all of these conditions:

1. No prompt, response, code, path, file name, command, argument, URL,
   repository, email, provider account identifier, credential, or raw device
   or session identity may enter telemetry, logs, errors, browser responses,
   product state, reports, snapshots, envelopes, or uploads.
2. API-price-equivalent accounting remains exact and keeps uncached input,
   cache read, cache write, output text, reasoning output, context, model,
   subscription speed, and API service tier distinct.
3. Unknown models, tiers, speeds, surfaces, accounts, plans, and token
   components remain explicit unknowns rather than inferred defaults.
4. Quota tracks, resets, account and plan continuity, calibration uncertainty,
   and held-out error behavior do not change without a separately authorized
   product decision.
5. Replay safety, no-clobber publication, owner-only state, bounded resource
   use, restart recovery, and fail-closed deletion remain intact.
6. Useful local analysis remains available offline and without contribution.
7. Contribution stays off by default; exact review and an accepted explicit
   first send remain prerequisites for optional foreground recurrence.
8. Browser, loopback, native, Worker, and Cloud Run trust boundaries remain
   explicit.
9. Branding, semantic-open target, updater, and packaging behavior remain
   package-tested.

## S0 — Stabilize the current worktree

### Required work

- Repair the reviewed platform-export assertion after the participant-identity
  owner move without weakening the exact public-API contract.
- Add the omitted static caller to the tool inventory without relaxing caller
  completeness.
- Record the participant-identity owner move and the current architecture
  counts in the hardening plan and completion checkpoint.
- Reconcile any generated or documented counts that describe the preceding
  source graph rather than the current graph.
- Diagnose the reproducible macOS recursive-watcher `EMFILE` condition without
  broad process termination. Distinguish repository lifecycle leaks from
  host-level FSEvents exhaustion, record the exact evidence, and require a
  clean retry after any explicitly identified repo-owned process is closed or
  the host task runtime is restarted.
- Preserve the expected R7 provenance invalidation until source freeze; do not
  regenerate retained evidence incrementally merely to make the suite green.

### Exit evidence

- focused platform and tool-inventory tests pass;
- `npm run tools:inventory:check` passes;
- `npm run architecture:check` passes with exactly ten named migration edges;
- `npm test` has no unexplained application or test-isolation failure. Any
  retained failure must be classified as either expected pre-freeze R7
  provenance invalidation or a capability the managed runner demonstrably
  denies, with its focused logic test green and an exact clean-host rerun in
  the release handoff;
- `npm run product:check` has no unexplained repository failure. A runner that
  permits loopback, native compilation, and process inspection must pass it in
  full before release; a restricted runner must record the exact denied stage
  and keep the clean-host rerun open;
- `npm run docs:links:check` passes; and
- `git diff --check` passes; and
- the persistent recursive-watcher probe result is recorded. When the host can
  allocate recursive watchers it passes normally; when the host emits
  asynchronous `EMFILE`, the collector closes the failed watchers, records only
  a fixed error code, wakes bounded reconciliation, and its focused foreground
  suite passes twice without post-test asynchronous activity.

### Current managed-runner evidence

- The post-stabilization full root run executed 1,304 tests: 1,286 passed and 18
  failed before the final test-isolation repair.
- The one ordinary failure was a Claude callback test that accidentally wrote
  to the user's default state root. It now uses its owner-only fixture and
  passes 8/8 twice.
- Of the remaining output set, two failures are the expected pre-freeze R7
  provenance receipts and fifteen require compiler cache, loopback/socket, or
  process/RSS capabilities denied by this managed runner. This is classified
  evidence, not a green root-suite claim; a clean-host rerun remains mandatory.
- `product:check` currently proves architecture, inventory, telemetry mirrors,
  80/80 web tests, and 10/10 release-site tests. Its local-server stage passes
  97/120; all 23 failures originate at the runner's denied `127.0.0.1` listen
  capability (including one downstream readiness timeout), so Worker, Cloud
  Run, and macOS stages require an explicit clean-host continuation.

S0 is therefore **code-stable with capability-dependent evidence open**. It is
not a release-ready or clean-host-green claim, and the external reruns remain
mandatory in S6.

No new ownership move may begin before this gate is recorded.

## S1 — Close standalone packaging and runtime proof

### Required work

- Finish the local-review dependency graph so it contains the exact static and
  reviewed dynamic production closure.
- Validate exact external packages and versions, including native Keychain
  dependencies, while excluding unreachable packages from the distributable.
- Replace the broken native-network-audit npm alias with a command that supplies
  an explicit bounded output path.
- Add one orchestrator that builds the local-review artifact, validates its
  receipt, safely inspects and extracts the archive, and runs the smoke suite
  against the extracted tree rather than a sibling build directory.
- In release mode, build twice with the same declared source epoch and require
  byte-identical archives and manifests.
- Keep extraction owner-only and fail closed on absolute paths, traversal,
  duplicates, links, unexpected roots, unsupported entry types, or unbounded
  entry counts.
- Produce a content-free aggregate runtime receipt containing source, archive,
  manifest, native-audit, and smoke hashes.

### Exit evidence

- focused graph and packaging-policy tests pass;
- a current archive contains no unreachable RunCost payload;
- two current archives are byte-identical;
- all 12 required packaged lifecycle invocations pass from the extracted tree;
- JavaScript and native network attempts are zero in offline mode;
- privacy canaries are absent;
- identity remains stable across commands; and
- the new runtime gate is available through a stable npm alias.

### Current managed-runner evidence

- The graph now uses the repository's ESM parser, rejects non-literal dynamic
  imports, resolves 97 current first-party files, and requires the exact
  external set `@github/keytar` plus `ajv`.
- The reviewed runtime closure is Node 26.2.0, Keytar 7.10.6, Ajv 8.20.0, and
  Ajv's four pinned transitives. RunCost is no longer copied or licensed into
  the artifact.
- `product:native-network-audit:build` now supplies an explicit reserved output,
  and `product:local-review:runtime` is the stable aggregate gate.
- The aggregate gate performs two same-epoch builds, validates both closed
  receipts, compares archive and manifest bytes, safely extracts the selected
  ustar archive, revalidates every extracted file and package identity, builds
  the native audit interposer, and runs the existing 12-invocation smoke only
  against that extracted tree.
- Focused graph, hostile-archive, runtime-contract, CLI, install, JavaScript
  network-audit, signing-readiness, and inventory coverage currently pass
  35/35 (30 local-review tests plus five inventory tests). The archive-focused
  contract includes adversarial manifest mutations for both the packaged Node
  binary and the Keytar native binding; each is rejected even when the altered
  manifest hash is paired with the matching altered receipt hash.
- The real managed-runner build produced two byte-identical 146,191,872-byte
  archives with SHA-256
  `758493bb3a2b39d688a435f0989d5a952ee3f41c6db5de6088c9b47d90964208`,
  byte-identical manifests with SHA-256
  `9ee8cc2702e0e3e6621dc655f8a49e7c3836159483bb6c32bd53a825f5a894d9`,
  and source-input SHA-256
  `2f27a66e3784e2b37e0dac644f7dae9ac23b0265b3c03305756d22bd5d2ea4fb`.
  The safely extracted 267-file tree contains no RunCost payload.
- Against a same-day owner-only native interposer already present locally, the
  extracted tree passed all 12 lifecycle invocations with zero covered
  JavaScript attempts, zero covered native-libc attempts, zero canary hits,
  and participant identity preserved when enforcement was observation-only.
  This is supporting evidence, not a substitute for rebuilding the interposer.
- The managed runner denies Clang temporary-file creation and denies
  `sandbox-exec` policy application. Therefore the current-source native build,
  network-denied smoke, and final aggregate receipt remain mandatory clean-host
  evidence in S6; S1 is not yet claimed end-to-end green.

## S2 — Finish semantic source ownership

### Required work

Eliminate these ten exact approved local-review edges by semantic owner:

1. `src/claude-callback-lifecycle.js`;
2. `src/export-deletion-executor.js`;
3. `src/export-deletion.js`;
4. `src/export-set-controller.js`;
5. `src/export-set-materializer.js`;
6. `src/export-set-verifier.js`;
7. `src/export-workspace-discard-executor.js`;
8. `src/export-workspace-discard.js`;
9. `src/metadata-exporter.js`; and
10. `src/storage.js`.

Then:

- create reviewed `src/contribution/index.js` and `src/reporting/index.js`
  owners;
- migrate remaining flat contribution, reporting, export, application,
  provider, and platform consumers through reviewed public entry points;
- remove the Codex scanner, tier, accounting, quota, export-contract,
  bundle-verifier, callback, identity, Keychain, and tool forwarding shims when
  their callers are migrated;
- retain a compatibility surface only when it is deliberately declared as a
  permanent public contract with direct tests and documentation; and
- keep every source-owner dependency aligned with the final matrix in the
  original completion goal.

### Slice rule

Each owner move must:

1. characterize the existing API and failure behavior;
2. move one cohesive responsibility;
3. preserve binding identity where a temporary shim is necessary;
4. remove the exact architecture allowance in the same slice;
5. run owning, privacy, architecture, import-closure, and affected runtime
   tests; and
6. update the remaining-debt ledger before another move starts.

### Current debt ledger

The first S2 slice is complete. Claude callback lifecycle ownership now lives
in `src/platform/claude-callback-lifecycle.js`. It receives the reviewed
application capability error class, four application-owned capability
operations, and exact runtime-script path through
`createClaudeCallbackLifecycleContext()`, owns the settings, state, lock,
recovery, and durability implementation, and imports neither application code
nor flat storage. The flat `src/claude-callback-lifecycle.js` module is a
composition-only 12-binding compatibility shim for callers that have not yet
migrated. Local-review composes the reviewed application and platform facades
directly, and its exact legacy lifecycle edge and allowance are removed.

The second S2 slice is complete. Export-set manifest schema and semantic
verification now live in `src/export/set-schema.js` and
`src/export/set-verification.js`; owner-safe filesystem reads, bounded
enumeration, streaming SHA-256, temporary SQLite uniqueness indexing, and
cleanup live behind `src/platform/export-set-verification-storage.js`; and
`src/application/local-export-set-verification.js` binds those reviewed ports
to the existing compatibility and bundle-verification contexts. The shared
gzip primitive moved intact to `src/export/compression.js`, avoiding duplicate
compression behavior. The flat schema, verifier, and compression modules are
exact implementation-free compatibility shims. Local-review now
composes the application and platform verifier facades and no longer imports
the flat verifier. The verification boundary also snapshots injected config,
ports, canonical artifacts, and verified bundle results before use; preserves
reviewed bundle, compression, resource, and set-verification failures; maps
unreviewed filesystem and port failures to fixed content-free codes; owns
partial SQLite setup cleanup; and preserves a primary verification failure when
index cleanup also fails. Callable ports are captured without attacker-visible
`.bind` access, public option objects are read only inside guarded snapshots,
and reviewed failures require exact prototypes plus canonical own name, code,
and message data. Adversarial coverage includes schema proxies, hostile config
and storage getters, callable proxies, forged and subclassed errors, raw
file-handle read faults, nested bundle proxies, setup failures, and cleanup
failures with path canaries.

One approved local-review edge remains after the deletion, materializer/runtime,
and workspace-discard slices:

1. `src/export-set-controller.js`.

The materializer-owner S2 slice is accepted. Runtime-neutral chunk packing,
set identifiers, logical-record commitments, source-plan commitments, and
manifest semantics now live in `src/export/`; application orchestration binds
only reviewed workspace, opaque destination, identity, resource, and bundle
verification ports. The flat `src/export-set-materializer.js` surface is an
exact seven-binding composition shim, and local-review no longer imports it.
Source-plan and supplemental-plan summaries reject nested Proxies, accessors,
hostile arrays, forged reviewed errors, and private canaries without executing
attacker code. Public materialization options are snapshotted before lease
acquisition; Buffer, ordinary Uint8Array, SharedArrayBuffer-backed Uint8Array,
and hostile typed-array subclasses are copied without aliasing or species
access; and every representation constant is pinned to the frozen contract
before any lease, destination open, or artifact write. Cleanup always attempts
close, preserves object and primitive primary failures, and maps standalone
finish, close, or durable-snapshot failures to a fixed content-free error.

The final affected lifecycle replay passed 308/308 tests. The architecture
ratchet passes over 236 production files and 986 imports with the five exact
edges above; documentation links and `git diff --check` pass. A final
independent adversarial audit reports zero findings after reproducing the
SharedArrayBuffer and typed-array-species cases. No R7 evidence was regenerated
or reinterpreted; it remains intentionally stale until the S6 source freeze.

The fourth S2 slice is complete. Runtime-neutral safe-record and checkpoint
state logic now live under `src/export/`; Node filesystem and line-reader
bindings for the provider scanner live in `src/platform/local-codex-log-ports.js`;
and `src/application/local-metadata-export.js` owns bundle orchestration.
`local-review/cli.js` composes only the reviewed application and platform
facades for its metadata commands. The exact metadata exporter, safe-record,
checkpoint, and scanner root modules remain compatibility composition shims.
The collector candidate version has one export-version owner. This removes
only the `local-review/cli.js -> src/metadata-exporter.js` allowance, reducing
approved local-review debt from seven to six; no collector, workspace,
deletion, discard, or Claude-storage subsystem moved.

The final fourth-slice owner/API, provider, privacy, platform, inventory, and
architecture verification passes 153/153, with a separate 48/48 Codex pricing
and privacy set. An independent integration replay passes 196/196. The
boundary graph now covers 225 production files and 958 imports with six
approved local-review migration edges. Adversarial review caught and closed
three parity/privacy defects before acceptance: the legacy pricing scanner
binding is restored by identity, nested scanner-port failures are content-free,
and `CODEX_HOME` retains per-call legacy observation semantics. A follow-up
architecture review also removed hidden Node runtime discovery from the
provider. Native proxy validation and scanner composition now have one
application owner in `src/application/local-codex-log-scanner.js`; the provider
receives only its reviewed runtime-neutral port snapshot. The final dedicated
audit reports zero findings across those boundaries.

The local-review runtime command again reaches the native network-audit
compilation gate, where this managed host denies Clang temporary-file creation;
clean-host runtime qualification remains an S6 requirement. The full suite was
also exercised before the final adversarial refinements: its three stale
S2 API/debt/inventory ratchets were repaired and are covered by the green
focused and independent integration sets. The retained macOS-native and R7
receipt/benchmark failures remain outside this source move and require the
already-recorded clean-host or frozen-receipt evidence paths.

The lifecycle boundary admits only the exact injected application capability
error. It rejects proxy-wrapped classes, ports, errors, and result records;
collapses every other thrown, thenable, getter, or result-shape failure to the
fixed content-free lifecycle configuration error; returns only closed validated
result shapes; and zeroizes verified returned Buffers through an intrinsic
captured before calling an injected port, even when another result field is
malformed or the Buffer shadows its public `fill` method.

Current verification passed 156/156 focused schema, compression, verifier,
materializer, deletion-preflight, resource, CLI, owner-boundary, and
architecture tests. Local-review build-policy, archive, and aggregate
runtime-gate contract tests passed 13/13. Architecture covers 216 production
files and 924 imports with eight approved debt edges. Static closure inspection
found 103 local-review files and 103 macOS runtime files, both including the
new export, application, and platform owners. All existing R7 artifacts remain
intentionally stale until the final source freeze; this slice did not regenerate
or reinterpret them. The real aggregate local-review runtime command reached
the native network-audit build but the managed host denied Clang temporary-file
creation; that clean-host release receipt remains deferred.

The third S2 slice is complete. Durable receipt-first pair publication,
destination leasing, stale-lock handoff, transaction-journal recovery, and
their owner-only filesystem checks now live behind
`src/platform/owner-only-export-artifact-storage.js`; shared directory,
inode, and durability primitives have one narrow home in
`src/platform/owner-only-filesystem.js`; and
`src/platform/local-state-paths.js` owns the activity-marker default. The
application facade in `src/application/local-export-artifact-storage.js`
binds export canonical JSON, resource ceilings, and resource errors into the
platform factory. Local-review composes that facade with the reviewed platform
factory and no longer imports `src/storage.js`.

`src/storage.js` remains an explicit compatibility facade for the still
unmigrated generic, reporting, and destructive callers. Its frozen, checked
`LEGACY_STORAGE_DIRECT_IMPORTERS` ledger in the architecture ratchet rejects
both new direct storage callers and an unrecorded caller removal. This slice
removed exactly the `local-review/cli.js -> src/storage.js` allowance,
reducing the approved local-review debt from eight to seven without changing
journal bytes, failpoint names or order, receipt-first publication, no-clobber
rules, stale-lock recovery, or crash cleanup.

Focused owner/API, export allowlist, durable publication, pair-recovery,
local-review CLI, and architecture coverage passed 114/114. Architecture now
passes over 220 production files and 937 imports with seven approved debt
edges. Local-review archive/build-policy/runtime-gate contracts passed 13/13;
the wider macOS packaging suite passed 30/32, with the two remaining checks
blocked by this managed runner denying the Swift/Clang module-cache write and
loopback listen respectively. The actual aggregate local-review runtime command
again reached the native audit build and was denied Clang temporary-file
creation. Those are clean-host S6 receipts, not source regressions. R7
artifacts remain intentionally stale until final source freeze.

The reporting-owner S2 slice is complete. The complete, runtime-neutral
monitoring-quality and weekly-calibration implementations now live at
`src/reporting/monitoring-quality.js` and
`src/reporting/weekly-calibration.js`; their SHA-256 bytes match their retired
flat predecessors exactly (`133673bf36407d1226063391581d3a71d03432dd0df4d34135a5428944aa3e2d`
and `f81d1ca7c174e7309e4994fb66146e75cb7c80b9aca4da2cdc34cf1ca179e2d4`).
`src/reporting/index.js` is the exact reviewed public API for monitoring
classification/projection/rendering and weekly calibration, bounded summary,
and candidates. CLI, local-companion, replay-cache, minimization, tests, and
calibration provenance now enter through that index; the two flat source paths
are retired with no compatibility shim. Focused monitoring, calibration,
caller, owner-boundary, and architecture coverage passed 109/109. An
independent integration replay caught and repaired the new boundary test's
missing exact tool-inventory caller, then passed 147/147. A dedicated
code-quality audit reports zero findings and independently confirmed byte
identity, exact eight-binding public API identity, complete caller/provenance
migration, safe flat-path retirement, and no-look-ahead preservation. The
architecture check passes 226 production files and 959 imports with six
pre-existing approved local-review debt edges; tool inventory and documentation
link checks pass. R7 artifacts were not regenerated. The macOS runtime-graph
test remains blocked outside this slice by unallowlisted pre-existing runtime
closure packages and the managed host's denied loopback bind.

The workspace-owner prerequisite slice is complete. Runtime-neutral workspace
descriptor, checkpoint, canonicalization, and hash semantics now have one owner
in `src/export/workspace-contract.js`; the reviewed application facade composes
that contract with separate owner-only SQLite/filesystem and lease adapters.
The flat workspace and lock modules are composition-only compatibility shims
with exact 11-binding and three-binding surfaces. Their public mappings are
directly ratcheted, and the platform owners import neither higher-level owners
nor legacy storage.

The final root acceptance replay passed 212/212 architecture, workspace,
checkpoint, heap/SIGKILL, controller/materializer, deletion/discard, resource,
local-review, and supplemental-source tests. Independent audits found and
closed nested Proxy/accessor execution and duplicate contract-semantics paths;
the repaired boundary rejects hostile nested values without trap execution and
snapshots mutable resource data. Architecture now covers 230 production files
and 967 imports with the same six approved local-review debt edges. Only the
workspace and lock composition shims were removed from the exact legacy-storage
caller ledger. The six remaining debt targets are unchanged, and R7 artifacts
remain intentionally stale until source freeze.

The July 31 artifact-storage prerequisite keeps the existing receipt-first pair
engine as the only writer while adding an opaque destination handle for the
later materializer move. Opening is non-creating and distinguishes absence;
enumeration, bounded defensive reads, recovery, no-clobber pair publication,
and fixed-basename legacy projection require the unforgeable handle. Existing
destinations are pinned by device/inode and revalidated before and after the
operation; absent handles pin their parent and become destination-pinned only
after a successful first write. Public configuration, request, option, and
storage-port values use own data descriptors without accessor or Proxy-trap
execution. The application facade preserves exact callback throws (including
primitive values) only through a private marker and normalizes platform/I/O
failures. File reads/writes now verify regular-file, device, inode, size,
link-count, uid, and mode at path/descriptor snapshots and post-operation.
Focused artifact-owner plus pair-recovery replay passed 37/37; the six debt
edges, materializer/controller/deletion/discard implementations, and R7 state
remain unchanged.

The pinned-path checks are not presented as same-UID sandboxing. The OS user is
the local trust boundary: without a portable `openat`-style directory
descriptor API in Node, malicious code already running as that user can evade
path observations and already has access to local logs, Keychain, and available
APIs. The contract remains strict for other-UID access, symlink/hardlink and
detectable replacement, bounded descriptor reads, and cooperative-process
races mediated by the existing leases and receipt-first transactions. This is
aligned with the README's local-deletion trust-boundary statement.

The follow-up storage audit also replaced recovery's EOF read with an exact
positioned descriptor-size loop and one-byte overflow probe, so a concurrent
append cannot force an allocation beyond the validated bound. Descriptor-close
failures after a successful read surface only a fixed content-free error while
primary read failures remain primary. The deterministic test seam is only a
zero-argument post-close failpoint; native close stays internal and no live
descriptor, path, bytes, stats, or label reaches the hook. Focused serial artifact, pair recovery,
resource, workspace, and architecture tests passed 123/123; the six debt edges
and R7 state remain unchanged.

### Exit evidence

- architecture reports zero approved debt edges and zero cycles;
- `src/contribution/` and `src/reporting/` have narrow reviewed entry points;
- no cross-owner deep import remains;
- no prefix-based pseudo-namespace remains in flat root source;
- no unexplained compatibility shim remains; and
- the full root and product suites pass apart from intentionally stale R7.

### July 31 deletion-owner evidence

The deletion preflight/executor pair is now a completed S2 ownership slice.
`src/export/deletion-schema.js` and `src/export/deletion-contract.js` hold the
runtime-neutral schema and fixed names; `src/application/local-export-deletion.js`
owns the two-step plan/orchestration facade; and the two narrow platform owners
hold owner-only inspection and durable lease/journal/quarantine/recovery
mechanics. The application receives all workspace, verifier, and platform
capabilities as guarded ports; it imports no legacy workspace or concrete
platform module. The historical flat deletion modules are compatibility-only
bindings, while both root and local-review CLIs compose the reviewed facade.

The migration removed exactly the two deletion entries from the local-review
and direct-storage ledgers, leaving controller plus the workspace-discard pair:
three approved debt edges. Focused schema, preflight, executor/SIGKILL,
supplemental-lifecycle, local-review, owner-boundary, architecture, inventory,
and diff checks passed; no R7 artifact was regenerated.

### July 31 export-source controller evidence and current S2 residual

The final approved controller edge is removed. The ten source-plan, scanner,
checkpoint, supplemental-workspace, bundle, and controller implementations now
belong to `src/application/export-sources/`; their concrete Node capabilities
come from `src/platform/local-export-source-ports.js`. Application ownership
under `src/application/export-sources/**` has no direct `node:` or flat legacy
import. Its composition index deliberately reaches the existing local runtime
owner in `src/application/local-codex-log-scanner.js`, which uses
`node:util/types` to authenticate the explicitly supplied proxy detector before
any caller capability is invoked. This is not a claim that the transitive
application closure is Node-free. Platform ownership imports no application,
export, or provider implementation. The application and platform public
indices expose the two composition factories.

The platform owner retains frozen own-data snapshots of only the Claude-state
environment fields `LOCALAPPDATA` and `XDG_STATE_HOME`, plus a separate
one-field `CODEX_HOME` snapshot for exact Codex-root compatibility. It neither
exposes nor later dereferences the caller's environment object.

One internal compatibility singleton supplies the ten historical root modules,
and every historical binding is an exact alias. The singleton performs no
source discovery or local-state read during import. Local-review composes the
same application/platform machinery directly and injects its default
controller into `runLocalReview`. The local-review allowance and eight obsolete
storage-ledger entries were deleted rather than replaced.

The combined affected replay passed 119/119 and the expanded owner-boundary
matrix passed 14/14.
Architecture now passes over 263 production files and 959 imports with zero
approved debt and zero reported cycles. Tool inventory, documentation links,
and diff checks pass. R7 was deliberately not regenerated.

The architecture allowance ledger is now empty, but S2 remains open until
semantic ownership is complete. Current source inventory contains 111 flat
root JavaScript files and 25 frozen production callers under `src/**` that
directly import `src/storage.js`:

- product/application callers: `automatic-contribution`, `cli`,
  `contribution-sync-queue`, `local-analysis-index`, `local-companion-data`,
  `local-contribution-preparation`, `metadata-exporter`, `passive-collector`,
  `replay-safe-accounting-cache`, and `telemetry-prepared-set`;
- analysis/migration callers: `build-weekly-calibration-audit`,
  `correction-migration`, `corrections`, `experiment-harness`,
  `minimization-ablation`, `real-local-backend-acceptance`, and
  `verify-weekly-calibration`; and
- deferred R7 callers: `r7-materialized-boundary-benchmark`,
  `r7-real-history-benchmark`, `r7-release-evidence-schema`,
  `r7-release-synthetic-evidence`, `r7-release-workload-fixture`,
  `r7-resource-benchmark-fixture`, `r7-resource-benchmark-schema`, and
  `r7-resource-benchmark`.

Six additional non-test tooling callers remain outside that production count:
`apps/worker/scripts/smoke-sync-queue-http.mjs`,
`scripts/minimization-ablation.js`,
`scripts/r7-materialized-boundary-worker.js`,
`scripts/r7-resource-benchmark-worker.js`,
`scripts/regenerate-r7-release-evidence.js`, and
`tools/reports/build-prospective-collector-transitions.js`. S4 must put those
six paths in an explicit tooling storage-dependency ledger, then migrate or
permanently justify each reviewed public-product API dependency. They must not
be hidden by the 25-production-caller headline.

The next S2 slice must choose one cohesive group above, establish its reviewed
owner, preserve or retire its public root intentionally, remove its exact
storage-ledger entries, and keep the allowance count at zero. A zero-debt graph
is therefore a ratchet, not a declaration that the remaining 111 flat roots
are finished.

### July 31 telemetry shipping-integrity prerequisite

The browser telemetry mirror now has one capture-once shipping contract. The
mirror verifier returns an immutable text, byte-length, and SHA-256 record;
public release builds exclude the live source from their tree copy, stage only
that verified record, and verify the resulting manifest row. The macOS module
graph retains the exact source text it parsed, stages those captured records,
uses the same bytes for its source-input digest, and requires the final bundle
inventory to match every captured module.

Adversarial tests replace the source mirror after verification and prove that
the release site and native staging paths still ship and hash the pre-mutation
capture. The alternate-repository-root path verifies the mirror selected from
that root rather than silently reading the default checkout. Focused browser,
release, and serving coverage passes 28/28; focused macOS capture, staging,
digest, and inventory coverage passes 2/2. Both independent final audits report
zero critical, high, or medium findings. At that checkpoint, the wider macOS
test exposed the next real S2 prerequisite: its runtime graph reached
`@app-usagemonitor/accounting` before the packager admitted the exact package
closure. The checkpoint immediately below resolves that prerequisite. The
separate loopback test remains denied by the managed runner and stays open for
S6 clean-host replay.

### July 31 accounting-package closure and forwarder retirement

The macOS runtime now admits the reviewed
`@app-usagemonitor/accounting` package and stages its exact five-file runtime
closure alongside the nine-file telemetry-contract closure. Both workspace
packages use one immutable capture per UTF-8 source file; staging, the manifest
source-input digest, and final bundle inventory all consume that same capture.
A portable mutation regression changes a physical source in each package after
capture and proves that shipped bytes and provenance retain the captured
snapshot. A separate sensitivity assertion proves a valid one-byte capture
change changes the digest, and corruption of each of all 14 inventory rows is
rejected individually.

All six remaining production/tool accounting consumers now use the bare
workspace-package API. The three transitional quota forwarders and six flat
accounting, tier, and export-metadata forwarders are deleted. The architecture
checker owns an exact permanent retired-path ledger; either recreating one of
those nine files or importing its absent path is a non-baselinable structural
failure. Flat `src/**` production callers must also use workspace packages
through their public package roots.

The independent affected replay passed 195/195 accounting, quota, tier,
export, transition, cache, contribution, experiment, companion, tool-parity,
and architecture assertions. Architecture now covers 254 production files and
945 imports with zero approved debt. Tool inventory, documentation links,
browser-mirror verification, syntax, and diff checks pass. The full macOS file
passes 19/21; the two remaining failures are the managed runner's denied Swift
module-cache write and loopback bind, both retained for S6 clean-host replay.
Final code and test re-audits report zero critical, high, or medium findings.
No R7 artifact was regenerated.

### July 31 contribution owner and identity-core shipping closure

The pure contribution contract now belongs to the reviewed
`src/contribution/index.js` facade. Account-track derivation, v0.1 and v0.2
content-free projections, batching, and prepared-set naming and manifest rules
are implemented under that owner. Historical telemetry roots retain exact
binding aliases, while `src/telemetry-contribution-builder.js` is now only the
filesystem materialization composition root. The remaining prepared-set I/O,
automatic recurrence, queueing, and local preparation roots have deliberately
not been mixed into this slice; `src/telemetry-prepared-set.js` remains the one
direct-storage compatibility root for this area and is deferred to C2.

Participant pseudonym derivation is shared through the private, Node-only
`@app-usagemonitor/identity-core` workspace package. Its public API is exactly
the v1 and v2 derivation functions; only contribution and platform ownership
may import its bare package root. It rejects non-string prefixes without
coercion, wipes its internal decoded-secret and HKDF-domain-key copies in a
`finally` block, and preserves caller-owned secret bytes and the frozen output
vectors.

Both shipped Node closures now bind that package rather than following a live
workspace link. The macOS packager and local-review artifact pin version 0.1.0,
verify the resolved package root and manifest, and capture exactly `index.js`,
`package.json`, and `src/pseudonym.js` through one shared descriptor-bound
reader. That reader requires `O_NOFOLLOW`, one regular-file link, stable
device/inode identity, size, mode, and nanosecond modification/change times
before and after a bounded handle read, plus fatal and byte-round-trip UTF-8
decoding. Both packagers stage only the captured bytes, include the capture
helper and package bytes in the source-input digest, and reject inventory drift.
Resolver mismatch, missing-file, initial symlink, hard-link, invalid UTF-8,
post-open pathname replacement by both a symlink and a different regular file,
concurrent growth beyond the pre-open allocation bound, source-mutation, and
row-corruption regressions exercise those boundaries. Two real same-epoch
local-review builds from the final source produced byte-identical archives and
receipts with archive SHA-256
`bbb2eee2eda3bddf18438861c976b529552b8d87a0561b82b6ed9bf4e521b9dd`;
owner-only archive extraction verified 282 files, eight component digests, and
seven runtime packages.

The mechanically verified current residual is 111 flat `src/*.js` roots and
25 exact production `src/**` direct-storage callers. This slice removed only
`src/telemetry-contribution-builder.js` from that ledger. Focused identity,
contribution, queue, application, and architecture replay passed 120/120;
focused local-review policy, archive, and runtime-gate replay passed 15/15;
the direct descriptor helper replay passed 2/2; and focused macOS
captured-package replay passed 2/2. Architecture covers 261 production files
and 962 imports with zero approved debt and zero reported cycles. Tool
inventory, telemetry mirror/schema checks, documentation links, and diff checks
pass. An attempted full local-review runtime run completed two
same-epoch builds, byte-identity comparison, safe extraction, and extracted
artifact validation, then failed when the managed runner denied `xcrun`/Clang
temporary-file creation for the native network-audit library. This is not a
green runtime result. The full macOS file retains the previously recorded
managed-runner Swift-cache and loopback-bind restrictions. Those native checks
remain for the S6 clean-host replay. No R7 artifact was regenerated.

### July 31 prepared-contribution storage and preparation ownership

The C2 contribution-storage slice is complete. Prepared-set schema and privacy
semantics remain in `src/contribution/index.js`; canonical parsing, digest and
record-count reconciliation, exact manifest membership, and the five public
prepared-set operations now live in
`src/application/local-prepared-contribution.js`; and owner-only descriptor
reads, no-clobber publication, manifest-last linking, directory durability,
and preparation-directory lifecycle mechanics live in
`src/platform/owner-only-prepared-contribution-storage.js`.

`src/telemetry-prepared-set.js` is now an exact 12-binding compatibility
surface. Its seven domain bindings remain direct contribution aliases and its
five I/O bindings are exact aliases of the configured application context.
`src/telemetry-contribution-builder.js` consumes the same private composition
singleton, avoiding a builder-to-compatibility cycle. Local preparation policy
and orchestration moved to
`src/application/local-contribution-preparation.js`; the historical
`src/local-contribution-preparation.js` root now supplies only Node defaults,
concrete ports, and its exact 13-binding compatibility surface.

The storage adapter requires canonical owner-only 0700 directories and 0600
single-link regular files, `O_NOFOLLOW`/`O_EXCL`, stable path and descriptor
device, inode, size, mode, link-count, owner, modification, and change-time
snapshots, bounded exact reads with an EOF probe, fixed content-free platform
errors, buffer wiping, fsync-backed no-clobber publication, and the existing
manifest failpoint order. Application decoding is fatal, round-trip UTF-8 and
canonical JSON. The adversarial replay covers symlink and hard-link
substitution, invalid UTF-8, digest/schema tampering, unexpected directory
membership, pre-manifest interruption, durable review recovery, and
post-publication recovery.

The exact legacy storage ledger falls from 25 to 23 production callers by
removing only `src/telemetry-prepared-set.js` and
`src/local-contribution-preparation.js`; queue and real-local storage remain
for their own future slices. The combined architecture, recurrence,
preparation, builder, device, queue, and acceptance replay passes 181/181.
Architecture covers 266 production files and 970 imports with zero approved
debt edges and zero reported cycles. The macOS runtime-closure assertion
passes and contains all three new owners plus the private composition module;
the unused local-review closure does not expand. Tool inventory, documentation
links, and diff checks pass. A wider macOS replay passes 27/29, with only the
already-recorded managed-runner Swift cache and loopback-listen denials. No R7
artifact was regenerated.

### July 31 canonical JSON and metadata-storage follow-on

The next bounded cleanup removes six more transitional storage-facade callers
without introducing a replacement generic storage API. The metadata-export
compatibility root now composes the reviewed application export-artifact
storage context with the reviewed owner-only platform adapter. Correction
migration, corrections, experiment manifests, minimization receipts, and the
persistent local-analysis index obtain canonical JSON from the existing export
owner instead of from `src/storage.js`; no serialization implementation or
artifact representation changed.

The exact production direct-storage ledger falls from 23 to 17 callers. The
metadata/export/bundle/preparation replay passes 139/139, the correction,
experiment, minimization, reporting, and architecture replay passes 105/105,
and the persistent-index plus architecture replay passes 72/72. Architecture
continues to cover 266 production files and 969 imports with zero approved debt
edges and zero reported cycles. Diff checks pass, and no R7 artifact was
regenerated.

### July 31 automatic-contribution application and storage ownership

The automatic-contribution slice is complete. Recurrence and consent
transitions remain in the contribution owner; scheduling, write-ahead recovery,
runner fencing, bounded timeouts, and status orchestration now live in
`src/application/local-automatic-contribution.js`; and owner-only settings,
atomic replacement, process-lifetime locking, stale-lock recovery, and
directory durability now live in
`src/platform/owner-only-automatic-contribution-storage.js`. The historical
`src/automatic-contribution.js` path is a thin Node composition root retaining
its exact 12-binding public surface and direct policy alias identities.

The platform adapter preserves 0700 parent and owner-only single-link file
requirements, `O_NOFOLLOW`/`O_EXCL`, stable descriptor identity and size
checks, fsync-backed publication, lock ownership validation, bounded settings
and lock bytes, content-free reviewed failures, stale-process probing, and
idempotent release. The application owner imports only the contribution public
facade and receives canonical path, UUID, and captured storage ports from the
root.

The production direct-storage ledger falls from 17 to 16 callers. Automatic
contribution, recurrence, owner-boundary, and architecture replay passes
128/128; the macOS exact runtime-closure test passes 1/1; tool inventory passes
5/5 and reports 44 records, 46 executable paths, and 30 npm aliases.
Architecture covers 268 production files and 976 imports with zero approved
debt edges and zero reported cycles. Three selected local-server scheduler and
lock lifecycle tests reach the managed runner's pre-existing
`listen EPERM: operation not permitted 127.0.0.1` restriction before their
assertions; clean-host loopback replay remains an S6 receipt. No R7 artifact was
regenerated.

### July 31 contribution-sync queue application and platform ownership

The contribution-sync queue slice is complete. Validation, projection,
selection, retry, lease, bandwidth, prepared-set retirement policy, and watch
orchestration now live in
`src/application/local-contribution-sync-queue.js`. Owner-only queue-file
creation, SQLite schema and transactions, lease and status queries, prepared
root discovery, and artifact filesystem retirement now live in
`src/platform/local-contribution-sync-queue-storage.js`. The historical
`src/contribution-sync-queue.js` path is a thin composition root that injects
Node path resolution, reviewed prepared-set verification, device sync, and the
platform storage factory while retaining its exact public bindings.

The application owner imports only the contribution and export public
facades. The compatibility root imports no filesystem or SQLite module, and
the platform owner imports no application or contribution implementation.
Boundary tests pin those exact import sets. Queue privacy and lifecycle
behavior remains covered by path-free persisted rows, exact-review binding,
deduplication, bounded retries, revoked-device pause, lease recovery,
post-enqueue substitution rejection, upload reservation limits,
crash-resumable retention, and owner-only database-location tests.

The production direct-storage ledger falls from 16 to 15 callers. Queue replay
passes 21/21; the combined contribution owner and queue replay passes 26/26.
Architecture covers 270 production files and 982 imports with zero approved
debt edges and zero reported cycles. Syntax and diff checks pass, and no R7
artifact was regenerated.

## S3 — Make delivery entry points composition roots

### Local companion

Separate bootstrap and shutdown, route registration, request and response
translation, static/report assets, refresh orchestration, central proxy,
contribution scheduling, and diagnostics. Preserve the loopback integration
suite as the executable contract.

### Worker

Reduce `apps/worker/src/index.ts` to environment validation, middleware, route
registration, dependency construction, and bounded dispatch. Move route
handlers into controllers that call existing repositories and domain owners.

### Browser

Separate application state, data access, timeline and chart projection,
contribution flow, navigation, and rendering. Preserve one coherent user
journey and the exact asset/ESM closure served by loopback and shipped in the
app.

### macOS

Separate lifecycle, companion supervision, onboarding, updater, branding,
semantic-open target, menu/status UI, diagnostics, and Keychain adapters into
reviewed Swift/native sources discovered by the packager.

### CLI

Replace the high-fan-out root CLI implementation with bounded command
composition and command-specific use-case construction without changing public
command names or output contracts.

### Exit evidence

- entry points contain composition and translation rather than core
  algorithms;
- startup, shutdown, restart, watchdog, updater, offline, refresh,
  contribution, and crash-recovery tests pass;
- browser, Node, package, and Swift closures shipped by the bundle equal the
  closures exercised by tests; and
- real loopback and packaged-app QA finds no behavior regression.

## S4 — Enforce and complete tooling isolation

### Required work

- Extend the architecture/tooling checks to scan `tools/**` as importers and
  require reviewed public product APIs.
- Freeze and enforce the six-entry non-test tooling ledger for direct
  `src/storage.js` imports separately from the 25-entry production `src/**`
  migration ledger; any addition or unrecorded removal must fail the tooling
  gate.
- Detect literal executable dependencies such as `new URL()`, `fork`, `spawn`,
  and resolved script paths so product-to-tooling edges cannot evade the
  architecture graph.
- Retire forwarding shims only after code, tests, documentation, package
  scripts, release automation, and provenance references are searched.
- Move test-only helper processes under explicit test support.
- Move report builders to `tools/reports/`, benchmarks to
  `tools/benchmarks/`, release machinery to `tools/release/`, and operations to
  `tools/operations/`.
- Preserve the provenance-bound minimization command until an archival design
  can retain its dated command exactly.
- Rehome the shipped contribution command into a product composition root; it
  must not be mislabeled as a tool.
- Move or reclassify the two R7 worker executables immediately before final R7
  regeneration.

### Exit evidence

- all canonical retained tools live under their declared final owners, except
  an explicitly provenance-bound archival path;
- stable npm aliases preserve behavior;
- no product module imports or executes a tool;
- no tool reaches a private/deep product module;
- retired paths are mechanically prevented from reappearing; and
- the inventory names every static, executable, documented, and automated
  caller.

## S5 — Establish one complete engineering gate

Add and document these root commands:

1. `npm run format:check`;
2. `npm run lint:check`;
3. `npm run types:check`;
4. `npm run architecture:check`;
5. `npm test`;
6. `npm run product:check`;
7. `npm run product:build:check`;
8. `npm run product:runtime:smoke`; and
9. `npm run architecture:complete`.

The aggregate command must execute the first eight gates in a deterministic
order, fail for a missing, skipped, filtered, or zero-test child, and print a
content-free deterministic summary.

Formatting, linting, and typing must publish their exact production scopes.
Generated or vendored exclusions require an exact owner, rationale, and
removal condition. JavaScript typing should expand incrementally from packages
and reviewed owner APIs; strict Worker TypeScript remains mandatory.

### Exit evidence

- every constituent command passes independently;
- `architecture:complete` proves that every child actually ran;
- adapter contracts and structured boundary errors are covered;
- privacy, canonicalization, and accounting property/adversarial tests pass;
- clean frozen root, Worker, and Cloud Run installs pass; and
- no unexplained scope exemption remains.

## S6 — Freeze, qualify, and hand off external gates

After S0–S5 are green:

1. freeze the exact covered source inventory;
2. build and hash the browser, release-site, Worker, Cloud Run, local-review,
   and unsigned macOS artifacts;
3. rehearse fresh-state local analysis, manual contribution, optional
   recurrence, offline behavior, restart, crash recovery, updater controls,
   rollback, hosted deletion, and uninstall;
4. record elapsed time to first useful result, completion or pause state,
   recovery guidance, source/artifact hashes, and the absence of raw content or
   non-loopback browser traffic;
5. run focused code-quality, test/documentation, performance, and
   plan-completeness audits and close every critical/high or
   invariant-breaking medium finding;
6. update README, ownership documentation, package-generation instructions,
   runbooks, and receipts to the frozen code; and
7. regenerate the exact Node 24.14.0 and Node 26.2.0 R7 matrix once, then
   revalidate every retained receipt.

Only after all repository-local and dry-run work is green may external human
gates be treated as the sole remaining conditions. Those may include staging
resource identifiers and cloud authority, Developer ID signing and
notarization, a live signed updater feed, public download hosting, and a clean
Mac Gatekeeper/update rehearsal.

An external blocker record must name the human owner, exact action or
credential, why local work cannot satisfy it, all green prerequisites and
hashes, the resume command or click path, expected verification, and rollback
or containment steps.

## Definition of done

This goal is achieved only when all of the following are true together:

- S0 through S6 have recorded current evidence;
- `npm run architecture:complete` exits zero from a clean
  checkout-equivalent source tree;
- architecture has zero approved debt, zero cycles, zero cross-owner deep
  imports, and zero product-to-tooling edges;
- the tested source and dependency closure is exactly the shipped closure;
- all user journeys and privacy boundaries pass from fresh state;
- all compatibility shims are removed or justified as permanent public APIs;
- documentation describes the implemented system rather than an earlier
  checkpoint;
- the exact Node 24/26 R7 evidence validates the frozen source; and
- no critical/high or invariant-breaking medium audit finding remains.

No commit, push, publish, deployment, cloud provisioning, repository-visibility
change, signing, notarization, DNS mutation, production credential issuance, or
participant contact is authorized by this goal.
