---
title: Security findings triage, remediation and handoffs
date: 2026-10-12
type: review
status: implemented
---

# Security findings triage, remediation and handoffs

The [October 13 continuation](2026-10-13-security-remediation-closeout.md) records
the later ordered review, Linux qualification follow-up and authorized R7 refresh
attempt. The evidence below retains its October 12 boundary.

All nine findings in the [October 11 security scan][scan] were confirmed at
triage and now have source fixes, regression coverage and independent review.
Seven implementation owners delivered the work, with the two local authorization
findings kept together and the two Worker admission findings kept together.
Integrated testing also exposed and corrected a pre-existing collector file
creation race. None of the reviewed evidence establishes an observed compromise.

Implementation is complete at source scope. Protected R7 receipt regeneration
awaits the owner's specific authorization, and native qualification, production
trust provisioning, deployment and publication remain separate gates. The
numbered handoff drafts below preserve the original dispatched briefs; they are
not instructions to repeat the completed implementation.

The scan examined `94ba7c8b502af4b16f3939ae46e1b57684d64e6e`. This review examined
the initially clean checkout at `d6df06572aafbeea0258e96c58ca488e2025567c` on
2026-10-12. The intervening diff contains GitHub action pin updates and associated
tests; the reported vulnerable logic remained at triage. The user subsequently
authorized coordinated implementation of all nine findings. The handoffs below
preserve the reviewed problem and acceptance boundary. Implementation status is
tracked separately below; source completion will not imply signing, deployment,
publication, scan-status changes, or installed-release qualification.

## Implementation coordination

Acceptance requires a source fix for every finding, meaningful negative and
positive tests, current first-party caller compatibility, and independent review.
Production keys, signing, deployments, publication and real target-platform
qualification remain separate gates. No production operation is authorized by
this implementation record.

| Findings | Assigned owner | Status | Verification |
|---|---|---|---|
| 1 | Windows signing trust | Implemented; independent review passed | Independent Windows checks: 81 passed; final changed suites: 43 passed, including bounded-download regression independently rechecked; release trust: 87 passed; workflow policy: 24 files; production signing-tool trust unprovisioned |
| 2 | Linux update authenticity | Implemented; independent review passed | Independent runtime/signing/publication: 38 passed; publication renewal: 33 passed including 6 independently rechecked renewal regressions; production trust unprovisioned |
| 3, 4 | Local authorization and relay | Implemented; independent review and caller integration passed | Local suite: 420 passed; UI suite: 1,016 passed; independent boundary checks: 53 passed; qualification callers: 100 passed; native GUI gate remains |
| 5, 7 | Worker admission protections | Implemented; independent review and retained dry gates passed | Independent checks: 94 passed; full Worker suite: 2,042 passed, one default-timeout failure; complete unchanged 47-test file retry passed; type/configuration/deploy:dry/staging:check passed |
| 6 | Provider error privacy | Implemented; independent review passed | Provider, CLI and collector: 92 passed; final independent provider/CLI/lane contracts: 24 passed; architecture check passed |
| 8 | Linux artifact extraction isolation | Implemented; independent review passed | 6 extraction tests; 134 owning tests; release trust 87 tests; native Docker confinement remains a hosted qualification gate |
| 9 | Documentation path privacy | Implemented; independent review passed | Independent documentation/public-site/release checks: 72 passed; 9 boundary probes; documentation and preflight passed |

The final independent completeness review found no remaining source blockers or
unhandled first-party companion HTTP callers. The nine-finding implementation is
retained in local commit `9037353a164455477cfeeaca435ca7d9eba63ec0` on
`codex/security-findings-2026-10-12`. Integrated testing subsequently identified
the additional collector-creation race corrected in the follow-up below.

The coordinator owns this record and integration validation. Implementers own
their scoped code, tests and maintained documentation. Shared runtime staging
lists and release configuration require narrow coordinated edits. No agent may
discard another owner's work or independently stage, commit or push the shared
checkout.

## Implemented behavior and remaining gates

| Finding | Source result | Separate operational qualification |
|---|---|---|
| 1 | Four isolated OIDC signing passes consume exact-stage subjects; build, NSIS execution and installed checks run without OIDC. Node/pnpm bootstrap bytes are pinned and verified before execution; signer tools require a reviewed full-file and publisher manifest. | Provision the real signing-tool manifest; qualify Windows extraction, Dlib/OIDC, enforced egress, signature transfer and installation. The unprovisioned lane refuses before acquiring tools or signing. |
| 2 | Embedded Ed25519 roots authenticate closed Linux metadata; persistent sequence/expiry checks, canonical names and final-byte checks protect download and installation. Publication supports exact same-version metadata renewal. | Provision production trust and sign metadata; qualify a real Linux update. Empty production roots disable updating truthfully. Existing older clients cannot gain roots retroactively. |
| 3 | The relay no longer borrows a captured session globally. A caller/session/ceremony-bound, single-use continuation permits only the immediate pairing operation. | Qualify the real legacy browser ceremony if that optional mode is deployed. |
| 4 | Per-launch capability gates private HTTP reads; mutations additionally require one-use method/path grants. Electron transports authority over FD5; first-party browser, tray, reports, diagnostics and qualification callers use authorized paths. | Qualify real Electron frame behavior. POSIX standalone browser access uses an explicit owner-only file; same-user unrestricted filesystem access is outside this boundary. Windows standalone unlock stays unavailable pending ACL qualification. |
| 5 | Cheap appcast authentication screening precedes bounded body reads. Dedicated operational leases bound admission; authenticated replay/CAS checks remain, with corrected nonce lifetime and freshness recheck. | Provision and read back the required production bindings before activation, then qualify signed publication. |
| 6 | Untrusted provider error text never enters the adapter error; the CLI uses fixed Codex messages and bounded numeric RPC codes. Collector/checkpoint canaries and real CLI subprocess tests cover propagation. | Packaged-platform qualification remains separate; unrelated CLI error handling is unchanged. |
| 7 | Public health/readiness consume dedicated edge and authoritative budgets, bound backend work, suppress diagnostic D1 amplification, and return monitor-recognized throttling. | Provision/read back bindings, deploy and observe real operational behavior. Already-issued provider calls cannot be cancelled; lease retention is bounded by the documented expiry. |
| 8 | Downloaded AppImage extraction runs in a credential-free, network-free constrained container; only two bounded, hash-checked framed outputs cross to the host. Both downloaded-artifact workflows enforce this path. | Native Docker containment and real Linux lifecycle remain unrun here. Same-host source packaging has a separately documented trusted-build boundary. |
| 9 | Six private documentation references were removed. Documentation and public-site generation reject direct/encoded private paths with redacted diagnostics. | Public deployment was not performed. |

Root integration retains the new desktop authorization, browser request,
Linux updater and CLI privacy tests in the appropriate default/portable/platform
lanes. Tool inventory has 186 records, 185 discovered executable paths and
59 aliases; its exact-count and caller checks pass. Documentation preflight,
architecture and generated i18n checks pass.

On the clean implementation commit, both retained Worker `deploy:dry` and
`staging:check` passed after canonical local social-preview and public-site
generation. The generated site had no installer release evidence
(`installer: null`). These were local builds and dry bundles, not publication
or deployment. The full Worker run executed 2,043 tests: 2,042 passed and one
unchanged projection test exceeded its default five-second timeout. The entire
47-test projection file then passed with the same defaults, without source,
assertion or timeout changes. Final architecture inspection covered 663
production files and 2,721 imports with zero approved debt edges.

The first broad root run executed 6,152 tests: 6,090 passed, 14 failed and
48 platform-gated tests skipped. Four source/integration failures were repaired
and their owning focused tests passed (Linux container helper admission,
Windows final blockmap/artifact retention, API route count, and the exact serial
test-command contract). Eight environment failures passed unchanged in a
permitted OS execution context: the managed sandbox denied process-identity/RSS
queries and nested sandbox setup. The remaining two failures are the retained
R7 receipts' expected source-digest freshness checks after the source fixes.

All ten R7 receipts match the original baseline but are now stale. Their refresh
reads private local histories and requires the specific owner authorization in
the [maintained R7 runbook](../runbooks/2026-08-19-r7-release-evidence-receipt-maintenance.md).
The required Node 24.14.0 and 26.2.0 runtime identities were checked read-only.
Authorization has been requested; no private-history regeneration has run.
This evidence gate remains open and must not be represented as a green root
suite or release qualification.

The final permitted root run on `9037353a164455477cfeeaca435ca7d9eba63ec0`
executed 6,181 tests: 6,131 passed, three failed and 47 skipped, with no
cancellations (752.45 seconds). All eight previously environment-blocked cases
passed in this full run. Two failures were the expected R7 freshness checks.
The remaining failure occurred while a foreground test polled the collector's
initial state, before notification coalescing assertions. The unchanged full
collector test file passed 76/76 on retry, but a deterministic synthetic probe
confirmed an underlying first-creation permission race.

### Integration-discovered collector creation race

The baseline `src/local-collector-state.js` created the SQLite file at its final
path before asynchronously applying mode `0600`. With the normal `022` umask,
the synthetic boundary probe observed mode `0644`, and the existing strict
reader correctly returned `local_collector_state_unavailable`; after the chmod,
the reader succeeded. This is a file-permission invariant and startup-availability
defect. The probe does not establish access by another user through the private
parent directory or an observed privacy compromise.

The correction exclusively reserves an owner-only file before SQLite opens it
and initializes the schema without yielding. Valid concurrent creators reuse an
initialized winner; unsafe, empty and incompatible winners are preserved and
rejected. Failure cleanup removes only the caller's unchanged empty reservation;
nonempty partial state remains private for diagnosis. Reader assertions, schema
versions and recovery contracts are unchanged.

The five owning state suites passed 58/58. The complete foreground/passive
collector file also passed 76/76 after the fix, including the originally failing
startup scenario, with no timing or assertion changes. Independent review passed
nine checks (eight new regressions and existing hot-rollback recovery), plus adversarial
link, replacement, shared-mode and future-schema probes. Actual first-write
inspection confirmed both the main database and live `DELETE` rollback journal
were `0600`, with no WAL/SHM. Syntax, architecture and whitespace checks passed.
These checks validate the bounded follow-up to the full-root run above; they do
not establish new Windows ACL, packaged-platform or release qualification.

## Decisions and implementation order

Priority is implementation urgency, separate from the scanner's severity.
P1 means prioritize now or before the next affected release operation; P2 means
schedule a bounded follow-up; P3 means routine privacy hygiene.

| # | Finding | Triage | Priority and owner |
|---|---|---|---|
| 1 | Windows signing tooling | Confirmed source trust gap; requires a compromised executable dependency supply chain | P1 before next signing run; Windows release owner |
| 2 | Linux update authenticity | Confirmed; feed/publication control can supply both executable and accepted checksum | P1 before next Linux updater release; desktop updater owner |
| 3 | Participant relay session inheritance | Confirmed; requires an enabled legacy relay and captured session; production accountless profile disables it | P2, after #4; same local authorization owner |
| 4 | Forgeable loopback authorization | Confirmed, including synthetic HTTP behavior; ordinary foreign browser origins remain restricted | P1; local authorization owner |
| 5 | Appcast guard body lifetime | Confirmed source availability gap when guard enabled; release mutation remains authenticated | P2; Worker admission owner |
| 6 | Provider error disclosure | Confirmed adapter reproduction and CLI source trace; privacy and terminal-output risk | P2, suitable quick independent fix; provider/CLI owner |
| 7 | Public probe amplification | Confirmed backend fan-out without consuming route admission; operational impact unmeasured | P2; same Worker admission owner |
| 8 | Linux qualification host execution | Confirmed; malicious artifact must pass the admitted package identity checks | P2 before next qualification; Linux qualification owner |
| 9 | Local paths in documentation | Confirmed six non-generic occurrences; no credential disclosure established | P3; documentation hygiene owner |

Assign seven owners, with separate reviewable changes for #4 then #3 and #5 then
#7. The local pair shares `apps/local/server.js`; the Worker pair shares dispatch
and admission policy. Avoid concurrent patches to those shared contracts. Other
tasks proceed independently, coordinating changes to shared release policy and
documentation. The ownership table above records the subsequent assignments.

## 1. Windows signing tooling

[Original finding][f1] — High, accepted with supply-chain prerequisites.

The signing job has `id-token: write` from its start
(`.github/workflows/electron-windows-signing.yml:44–67`). It globally installs
Corepack and activates pnpm by version at lines 100–112. The builder patch at
`config/patches/app-builder-lib@26.15.7.patch:5–10` constrains TrustedSigning to
version 0.5.0, but still installs it from PSGallery. The finalizer initializes and
imports that module before checking command parameter shape
(`scripts/finalize-electron-windows-signing.mjs:160–190`).

Exact versions, frozen workspace dependencies, ignored lifecycle scripts, pinned
actions, source checks, and environment protection are meaningful controls. They
do not bind every privileged bootstrap executable to reviewed bytes. Moving
Azure login later in the same job does not isolate earlier executable code from
the job's OIDC authority. The report's broad registry-response threat should be
qualified: upstream signature/integrity checks may constrain particular download
paths; this review has not demonstrated bypassing Corepack's own protections.
There is no evidence that an actual signing run was compromised.

**Proposed handoff draft**

```text
Implement the TiboTattle Windows signing-tool integrity fix (finding 1).
Baseline reviewed: d6df06572aafbeea0258e96c58ca488e2025567c. Recheck status and
source drift, and read root, .github, scripts, and Electron AGENTS.md guidance.
Own electron-windows-signing.yml, the Windows finalizer, relevant builder patch
and tool manifests, signing tests, and affected release documentation. You are
not alone in the codebase; preserve other agents' changes and coordinate shared
release policy edits.

Inventory every executable bootstrap input, including Corepack, pnpm,
TrustedSigning and its transitive/NuGet inputs, and executable downloads inside
pinned signing actions. Verify existing upstream controls before claiming they
are absent. Bind the admitted tool closure to reviewed digests and available
publisher evidence; verify before execution/import and reject missing or extra
inputs. Prevent builder initialization from silently reinstalling modules.
Separate dependency construction from a minimal signer with fixed digest-bound
subjects. Give OIDC only to the signer; exclude registry/gallery access there
while preserving necessary signing/timestamp traffic. Retain native-module
rebinding and final-byte provenance across the stages.

Prove tampered, missing, wrong-version and transitive inputs fail before import
or signing, and unexpected subjects cannot be signed. Run the Windows signing
workflow/finalizer tests, release-workflow policy check and release:trust:check.
Describe the separate real-Windows/OIDC qualification gate. Deliver source and
tests plus an operations plan; do not dispatch, sign, change credentials,
publish, or weaken existing release gates.
```

## 2. Linux update authenticity

[Original finding][f2] — High, accepted.

`config/electron-production-distribution.cjs:122–126` enables the Linux stable
feed. The wrapper delegates download and installation in
`apps/electron/desktop-updater.js:612–633` and `681–705`. The installed, lockfile
selected `electron-updater@6.8.9` takes checksums from the feed in
`out/AppUpdater.js:559–565`; `out/AppImageUpdater.js:30–46` downloads/chmods the
payload and `72–113` replaces/runs it. No independent Linux signature policy is
interposed by the application.

The fixed HTTPS origin, disabled downgrade policy, and explicit installation
action narrow exploitation. An arbitrary network observer cannot simply replace
a payload while leaving authenticated metadata unchanged. The finding requires
control of the trusted feed/publication path or an equivalent compromise. A new
verifier will protect updated clients; it cannot retroactively give old clients
a trust root they do not possess.

**Proposed handoff draft**

```text
Implement independent Linux update authentication for TiboTattle (finding 2).
Baseline reviewed: d6df06572aafbeea0258e96c58ca488e2025567c. Recheck status/drift
and root, Electron and scripts AGENTS.md. Own desktop-updater.js, its runtime
composition, production distribution/build policy, Linux update tests and
affected release instructions. You are not alone; preserve other work and
coordinate shared distribution-policy edits with the Windows release owner.

Add a fail-closed Linux verification boundary using a public trust key embedded
in the installed application, independent of the update host. Authenticate a
closed metadata contract binding product, channel, target, version, digest and
size, then verify the exact downloaded bytes before the downloaded state or any
install/restart action. Cover automatic downloads, restored cache entries,
differential downloads, and revalidation immediately before installation.
Define replay/rollback, key rotation, and failure behavior. Recommend keeping
Linux in-app updating unavailable until this boundary is qualified, with truthful
UI; record that availability change as an explicit product decision. Preserve
Windows/macOS behavior and offline analysis.

Test matching attacker-chosen checksums with no valid signature, wrong key,
wrong target/channel/version/size, replay, altered cached bytes, and a valid
update. Use synthetic keys only. Run desktop updater and Linux real-AppImage
qualification contracts; leave real Linux GUI/install qualification explicit.
Provide a separate migration plan for already installed unsigned-trust clients.
Do not provision production keys, sign releases, change feeds, or publish.
```

## 3. Participant relay session inheritance

[Original finding][f3] — High for affected configurations; narrower deployment
scope than a general production-session takeover claim.

`apps/local/transport/participant-session-cookie-bridge.js:115–121` returns the
captured cookie even when the caller supplied none, and overrides another jar's
cookie too. `apps/local/server.js:1710–1718` forwards it, while the relay GET
dispatch at `4930–4943` has no caller capability. The hosted session response
exposes the CSRF token for the retained session-owner route set. Existing tests
explicitly require the captured-cookie preference.

This is a compatibility workaround for enrollment followed immediately by
pairing before the embedded browser cookie jar commits. Removing it without a
replacement risks breaking that ceremony. Production accountless composition
sets `centralOrigin` to null (`apps/local/server.js:3262`); the finding applies
to retained relay-enabled configurations, not every installation.

**Proposed handoff draft**

```text
Fix TiboTattle participant relay session inheritance (finding 3), after the
finding 4 caller-capability contract is settled. Baseline reviewed:
d6df06572aafbeea0258e96c58ca488e2025567c. Read root/local/web/Electron AGENTS.md
as applicable. Own participant-session-cookie-bridge.js, participant relay
integration in server.js, associated browser ceremony and tests. You are not
alone: use the same owner as finding 4 or coordinate its integration first;
preserve unrelated work.

Never supply a process-global hosted session to a cookie-less or different
caller. Require the shared launch capability on every relay route, including
GET session. Preserve the enrollment-to-pairing cookie-commit workaround only
through a short-lived, one-use continuation bound to the initiating authorized
caller, ceremony and exact next operation. Consume it atomically, expire it on
failure/restart/logout as appropriate, and keep raw cookies outside renderer
state. Ordinary session reads and consent/logout requests must not inherit the
continuation. Preserve accountless-profile relay closure and retired routes.

Replace tests that mandate the unsafe global fallback with regressions for
cookie-less probes after enrollment, another caller/session, wrong operation,
expiry, replay, concurrent consumption and restart. Preserve delayed-cookie
enrollment/pairing success and legitimate persisted-session resume. Run bridge,
relay and real-loopback tests, then product:local:test and product:ui:test when
the browser contract changes. Qualify the embedded legacy ceremony separately.
Do not enroll real accounts, revoke credentials, or change hosted state.
```

## 4. Forgeable loopback authorization

[Original finding][f4] — High, accepted; local caller prerequisite.

The global peer/Host checks (`apps/local/server.js:1545–1562`, `4872–4880`) restrict
network reachability and DNS rebinding. They do not establish the caller's
identity. Private reads either require no additional credential, as overview
does at `5146–5152`, or accept the constant local header. Disconnect accepts that
header, matching Origin, and a public confirmation literal (`2040–2061`).
Existing isolated HTTP tests demonstrate these accepted requests, including a
mocked disconnect runner. They do not mutate real credentials.

Ordinary foreign-origin browser JavaScript is constrained by Origin/CORS checks.
A raw local process can supply the same headers. This is not evidence of remote
Internet access or an OS sandbox escape. Legacy disconnect is closed in the
production accountless profile; private reads and refresh still matter.

**Proposed handoff draft**

```text
Implement authentic local caller authorization for TiboTattle (finding 4).
Baseline reviewed: d6df06572aafbeea0258e96c58ca488e2025567c. Recheck status and
read root/local/Electron/web AGENTS.md; read native guidance if touching native
clients. Own the companion authorization boundary, trusted launch/bootstrap,
affected first-party clients, route tests and API/privacy documentation. You are
not alone; coordinate finding 3 with the same owner and preserve other changes.

Inventory every private read and privileged mutation, including auxiliary
reports, diagnostics, refresh, contribution, relay and work-usage routes. Mint
an unguessable per-launch capability at the trusted composition root. Deliver
it through a private inherited channel/main-process bridge or an equally
protected owner bootstrap for supported standalone/native clients. Do not
expose it through an unauthenticated HTTP bootstrap, static HTML, URL, logs,
browser storage or broadly readable files. Keep the renderer bridge narrow.
Bind destructive authorization to the exact operation/lifecycle and prevent
replay. Preserve loopback, Host, Origin, content-type and body limits. Document
the threat boundary: this does not isolate fully compromised same-user code
that can already inspect the trusted application's memory.

Use actual isolated HTTP tests: a caller with perfect public headers but no,
wrong, expired or prior-launch capability must fail before private reads or
side effects. Test authorized clients, concurrent/replayed destructive requests,
restart and zero credential/sync mutation on denial. Run product:local:test,
affected Electron/web tests and architecture:check. Verify rendered/packaged
clients separately; do not access or mutate the user's live profile or release.
```

## 5. Appcast guard body lifetime

[Original finding][f5] — Medium, accepted as source availability/cost exposure.

The enabled guard reads the body before authentication
(`apps/worker/src/sparkle-appcast-guard.ts:992–999`). Its reader limits bytes but
not elapsed time and awaits cancellation on overflow (`245–280`). The existing
`apps/worker/src/bounded-body.ts` already enforces total/idle deadlines and
nonblocking cancellation. Reading the body is necessary to verify the body-bound
HMAC; cheap header screening can precede it, but cannot replace authentication.

Disabled/misconfigured guards return 404. HMAC, nonce, artifact signature,
version and conditional-write controls remain intact. No service saturation,
billing impact, or unauthorized appcast write was demonstrated.

**Proposed handoff draft**

```text
Bound unauthenticated appcast guard work in TiboTattle (finding 5).
Baseline reviewed: d6df06572aafbeea0258e96c58ca488e2025567c. Read root/Worker
AGENTS.md. Own sparkle-appcast-guard.ts, its tests, and the narrow admission
integration/configuration required. You are not alone; coordinate shared Worker
dispatch/admission changes with finding 7 and preserve other work.

After preserving disabled-route and method behavior, reject missing, malformed
or stale authentication header shapes before acquiring the body. Use the shared
bounded-body reader with explicit byte, total and idle limits; never await
untrusted cancellation. Add dedicated pre-body request/concurrency admission
with bounded lifecycle and release on every exit. Avoid turning the admission
check itself into an unbounded stateful fan-out. Retain complete body-bound HMAC
verification, nonce consumption ordering, target signatures and conditional
publication. Do not weaken authentication to make it run earlier.

Test withheld bodies, slow drip below the idle limit but beyond the total limit,
overflow with non-settling cancel, missing/malformed headers with zero body
reads, concurrent rejection, cancellation/error lease cleanup, and valid signed
requests. Preserve disabled 404, replay and cross-target refusal cases. Run
sparkle-appcast-guard, bounded-body and admission tests, then
product:worker:check. Give an explicit deployment/configuration plan; do not run
live exhaustion tests, deploy, migrate, or publish an appcast.
```

## 6. Provider error disclosure

[Original finding][f6] — Medium, accepted and locally reproduced at the adapter.

`src/providers/codex/app-server.js:243–245` constructs an error from the provider's
untrusted message. Failed account reads bypass success-payload sanitization
(`src/cli.js:637–641`), and the executable's catch prints `error.message`
(`1635–1638`). A synthetic injected app-server preserved both a privacy canary
and an escape character; only booleans and fixed codes were printed by this
review. No real provider output was used. The CLI sink was source-traced rather
than exercised with the installed provider.

**Proposed handoff draft**

```text
Prevent provider-controlled error text escaping TiboTattle diagnostics (finding
6). Baseline reviewed: d6df06572aafbeea0258e96c58ca488e2025567c. Read root/src,
Codex provider and SECURITY.md guidance. Own the app-server error boundary,
relevant CLI error rendering, provider/CLI regression tests and affected docs.
You are not alone; preserve unrelated edits.

Map JSON-RPC failures to fixed local error messages/codes immediately at the
provider boundary. Retain only a validated bounded integer RPC code needed for
existing compatibility behavior. Do not retain the raw message in cause, stack
annotations, structured output or debug state. At the CLI boundary, distinguish
reviewed local user-facing errors from arbitrary dependency/provider messages
and use a safe fixed fallback; avoid a blanket rewrite of unrelated commands.
Preserve the existing unsupported-parameter retry semantics and cancellation.

Add synthetic end-to-end CLI tests with private-path/prompt/token canaries,
ANSI/OSC/control characters, oversized text, object/null messages and invalid
RPC codes. Assert absence from stdout, stderr and serialized diagnostics, not
just the success payload. Assert recognized compatibility codes still produce
exactly one permitted retry and unknown errors do not retry. Run
test/codex-account-provider.test.js, owning CLI tests, architecture:check and
the affected local gate. Never invoke a real provider session or weaken privacy
assertions to test this fix.
```

## 7. Public health and readiness amplification

[Original finding][f7] — Medium, accepted with unmeasured operational impact.

Public readiness invokes a Durable Object and D1 work
(`apps/worker/src/index.ts:4168–4227`). Health also touches the deletion-ledger D1
and R2 (`4458–4499`). `assertAdmissionBindings` checks binding presence, not
consumption (`apps/worker/src/admission.ts:281–290`). Even the non-consuming
ingress probe executes a storage transaction and write
(`apps/worker/src/ingress-budget.ts:259–271`). Normal responses are no-store.

Work is bounded per request and responses are content-free. Applicable live
edge/WAF controls and practical saturation thresholds were not inspected. The
source gap warrants a fix without implying a demonstrated outage.

**Proposed handoff draft**

```text
Bound TiboTattle public health/readiness backend work (finding 7).
Baseline reviewed: d6df06572aafbeea0258e96c58ca488e2025567c. Read root/Worker
AGENTS.md. Own health/ready dispatch, dedicated admission, related configuration,
tests and operational API docs. You are not alone: use the finding 5 Worker
owner or integrate its admission contract first; preserve other edits.

Consume route-specific admission before any D1/R2/ingress-Durable-Object probe.
Avoid sharing an exhaustible participant-upload budget or making rejected probes
perform equivalent backend work. Prefer a bounded first patch retaining the
existing health/readiness contract. Inventory monitoring/release consumers
before choosing a later cheap public-liveness/authenticated deep-readiness
split or a short-lived snapshot. Any cache must preserve degraded/stale states
and must not claim fresh readiness from old success. Missing/failing required
admission must fail closed with content-free bounded responses.

Use local instrumented bindings to assert denied requests make zero downstream
probe calls, accepted requests stay bounded, concurrent cache misses are
controlled if caching is used, and genuine backend failures remain observable.
Cover migration-barrier behavior, missing bindings, retry-after semantics and
monitor compatibility. Run worker, admission, ingress-budget and route-registry
tests, then product:worker:check. Propose exact deployment/config changes but
do not deploy, change WAF rules, or load-test the live service.
```

## 8. Linux qualification executes before isolation

[Original finding][f8] — Medium, accepted; admitted artifact prerequisite.

The workflow invokes `--prepare` before building its isolation environment
(`.github/workflows/electron-linux-final-qualification.yml:77–89`). Preparation
checks identities, then executes each candidate's own runtime with
`--appimage-extract` on the host
(`scripts/qualify-electron-linux-installed-lifecycle.mjs:153–184`). Artifact
hashes bind selection but do not make executable bytes safe to inspect.

This is not arbitrary public artifact intake: source/run/receipt identities must
match, the workflow is manual, and it has read-only GitHub permissions with no
signing/publication step. Nevertheless, a malicious admitted build can tamper
with its own qualification evidence before the intended boundary exists.

**Proposed handoff draft**

```text
Move all untrusted AppImage execution behind isolation in TiboTattle Linux final
qualification (finding 8). Baseline reviewed:
d6df06572aafbeea0258e96c58ca488e2025567c. Read root/.github/scripts AGENTS.md.
Own electron-linux-final-qualification.yml, prepare/intake tooling, affected
container definitions and Linux qualification tests/docs. You are not alone;
coordinate updater/release documentation with finding 2 and preserve other work.

Do not invoke an artifact's extraction, offset, version or other executable
entrypoint on the host. Prefer passive extraction with a reviewed pinned parser,
itself isolated for hostile filesystem input, or build a disposable extraction
boundary before executing the AppImage. Use no network or credentials, a
read-only source/input mount, bounded resources and a narrow output directory.
Keep extraction separate from the later FUSE-enabled lifecycle environment.
Validate traversal, symlink/hardlink and output type/size constraints, and bind
the exact input plus extracted ASAR/executable identities outside the untrusted
boundary. Recompute receipts outside it without trusting artifact-written code.

Test a synthetic artifact that would write a host marker if invoked: preparation
must not create it outside isolation. Test malformed/traversing extraction,
tampered output and interrupted cleanup, plus a valid exact-byte intake. Run
Linux installed-lifecycle/intake tests and release workflow policy checks.
Describe native Linux/VM runtime evidence separately. Do not dispatch protected
workflows, execute real untrusted artifacts on the host, sign or publish.
```

## 9. Maintainer-local paths in documentation

[Original finding][f9] — Low, accepted as privacy hygiene.

Six reported occurrences remain: operational command examples in
`docs/runbooks/production-operations.md:1044,1059` and local file links in
`docs/research/2026-09-05-electron-real-history-control-plane-measurement.md:103,129,150,151`.
This review deliberately does not repeat their values. A broader pattern check
also matched three harmless prose phrases containing `index/home/secret` or
`root/home/loss`; a regression guard needs path-aware boundaries, not a naive
substring rule. Nothing reviewed establishes a leaked secret or a need to rotate
credentials or rewrite repository history.

**Proposed handoff draft**

```text
Remove private absolute paths from TiboTattle documentation and prevent recurrence
(finding 9). Baseline reviewed: d6df06572aafbeea0258e96c58ca488e2025567c. Read
root/docs AGENTS.md and docs/README.md. Own the six reported documentation
occurrences, tools/operations/validate-documentation.mjs or its existing owning
privacy guard, and documentation-governance tests. You are not alone; preserve
other agents' docs changes and coordinate shared release/runbook edits.

Replace operational absolute paths with portable, clearly defined placeholders.
Use repository-relative links only when the target actually exists in the repo;
for private receipts outside it, retain a truthful description of privately held
evidence rather than inventing a link or importing private artifacts. Preserve
historical evidence dates and meaning. Scan tracked docs and generated public
documentation for non-generic macOS/Linux/Windows home paths and local file URLs.
Use narrow explicit synthetic-example allowances and redact matched values from
guard failure output. Do not flag ordinary index/home/secret prose as a path.

Add negative fixtures with invented usernames and positive portable/synthetic
cases. Verify links, docs:check and test:preflight. Search for old references
without printing private matches. No history rewrite, credential rotation,
receipt publication or deletion of private evidence is part of this task.
```

## Initial triage evidence and completion boundary

The following checks describe the initial baseline investigation, before the
user authorized implementation. The coordination section above records later
fixes and validation.

- Reviewed every finding's full report, affected code, relevant caller/dispatch
  path and counterevidence. Inspected the lockfile-selected updater implementation.
- Installed the frozen root dependencies with lifecycle scripts disabled; no
  tracked dependency/lockfile change resulted at that stage. The first offline attempt lacked
  a cached package; the subsequent ordinary frozen install succeeded.
- Participant relay/bridge tests: **11 passed**. These confirm current behavior,
  including the unsafe fallback, rather than prove remediation.
- Provider account and desktop updater tests: **22 passed**.
- Three selected real-loopback tests: **3 passed**, exercising overview,
  participant relay and mocked disconnect acceptance.
- Synthetic provider-error probe: raw canary and escape character both retained
  in `error.message`; local code remained `request_failed`, RPC code `-32000`.
- Confirmed six non-generic documentation path occurrences without recording
  their private values in this review.
- Documentation governance and preflight passed; the latter included 20
  documentation/guidance tests. Only this review document was an untracked change
  at that initial triage checkpoint.

The tests used synthetic fixtures. No live accounts, real credentials, production
load, signing authority, installed-app update, Windows runner or Linux AppImage
execution was used in that initial investigation. Worker findings were then
source-traced, with runtime regression tests specified for their implementers.
Passing baseline tests was not a security closure signal: several preserved
the reported behavior and were replaced by regression assertions during the
subsequently authorized implementation.

Each implementing agent should return the exact revision/diff, regression proof,
affected client/contract coverage and the strongest completed gate. Source,
CI, packaged/installed behavior, deployment and publication remain separate.

[scan]: https://chatgpt.com/mcp-app/connector_openai_defense_factory/open_defense_factory#/runs/wfr_d2c639136a046d2df083991efec961d2257fcb691a98b71ceb777ab496cc501e
[f1]: https://chatgpt.com/mcp-app/connector_openai_defense_factory/open_defense_factory#/findings/rf_wfr_d2c639136a046d2df083991efec961d2257fcb691a98b71ceb777ab496cc501e%3Awfo_1a50a32101c8106edd4b96517e4e38e08a4160073ac6236e13e711676284b653%3Aocc_104dabc9a9f0c5c09516b474?source=repository_scan&status=&limit=50&repo=https%3A%2F%2Fgithub.com%2Fadamallcock%2Ftibotattle&repo_id=github-1311335567
[f2]: https://chatgpt.com/mcp-app/connector_openai_defense_factory/open_defense_factory#/findings/rf_wfr_d2c639136a046d2df083991efec961d2257fcb691a98b71ceb777ab496cc501e%3Awfo_1a50a32101c8106edd4b96517e4e38e08a4160073ac6236e13e711676284b653%3Aocc_3c49ca6c45f5d1afa98cfaa0?source=repository_scan&status=&limit=50&repo=https%3A%2F%2Fgithub.com%2Fadamallcock%2Ftibotattle&repo_id=github-1311335567
[f3]: https://chatgpt.com/mcp-app/connector_openai_defense_factory/open_defense_factory#/findings/rf_wfr_d2c639136a046d2df083991efec961d2257fcb691a98b71ceb777ab496cc501e%3Awfo_1a50a32101c8106edd4b96517e4e38e08a4160073ac6236e13e711676284b653%3Aocc_4b7179f55708989912f133fe?source=repository_scan&status=&limit=50&repo=https%3A%2F%2Fgithub.com%2Fadamallcock%2Ftibotattle&repo_id=github-1311335567
[f4]: https://chatgpt.com/mcp-app/connector_openai_defense_factory/open_defense_factory#/findings/rf_wfr_d2c639136a046d2df083991efec961d2257fcb691a98b71ceb777ab496cc501e%3Awfo_1a50a32101c8106edd4b96517e4e38e08a4160073ac6236e13e711676284b653%3Aocc_e183aca13d54c1ccc6929146?source=repository_scan&status=&limit=50&repo=https%3A%2F%2Fgithub.com%2Fadamallcock%2Ftibotattle&repo_id=github-1311335567
[f5]: https://chatgpt.com/mcp-app/connector_openai_defense_factory/open_defense_factory#/findings/rf_wfr_d2c639136a046d2df083991efec961d2257fcb691a98b71ceb777ab496cc501e%3Awfo_1a50a32101c8106edd4b96517e4e38e08a4160073ac6236e13e711676284b653%3Aocc_11cb9c5d83ed3f3fcf804513?source=repository_scan&status=&limit=50&repo=https%3A%2F%2Fgithub.com%2Fadamallcock%2Ftibotattle&repo_id=github-1311335567
[f6]: https://chatgpt.com/mcp-app/connector_openai_defense_factory/open_defense_factory#/findings/rf_wfr_d2c639136a046d2df083991efec961d2257fcb691a98b71ceb777ab496cc501e%3Awfo_1a50a32101c8106edd4b96517e4e38e08a4160073ac6236e13e711676284b653%3Aocc_19a1aa4325bcf4c6b1332873?source=repository_scan&status=&limit=50&repo=https%3A%2F%2Fgithub.com%2Fadamallcock%2Ftibotattle&repo_id=github-1311335567
[f7]: https://chatgpt.com/mcp-app/connector_openai_defense_factory/open_defense_factory#/findings/rf_wfr_d2c639136a046d2df083991efec961d2257fcb691a98b71ceb777ab496cc501e%3Awfo_1a50a32101c8106edd4b96517e4e38e08a4160073ac6236e13e711676284b653%3Aocc_6d5c21fca90ae269b2c927ec?source=repository_scan&status=&limit=50&repo=https%3A%2F%2Fgithub.com%2Fadamallcock%2Ftibotattle&repo_id=github-1311335567
[f8]: https://chatgpt.com/mcp-app/connector_openai_defense_factory/open_defense_factory#/findings/rf_wfr_d2c639136a046d2df083991efec961d2257fcb691a98b71ceb777ab496cc501e%3Awfo_1a50a32101c8106edd4b96517e4e38e08a4160073ac6236e13e711676284b653%3Aocc_f268b428266bf7129dd40e6b?source=repository_scan&status=&limit=50&repo=https%3A%2F%2Fgithub.com%2Fadamallcock%2Ftibotattle&repo_id=github-1311335567
[f9]: https://chatgpt.com/mcp-app/connector_openai_defense_factory/open_defense_factory#/findings/rf_wfr_d2c639136a046d2df083991efec961d2257fcb691a98b71ceb777ab496cc501e%3Awfo_1a50a32101c8106edd4b96517e4e38e08a4160073ac6236e13e711676284b653%3Aocc_6ee14e41748755aea81489fe?source=repository_scan&status=&limit=50&repo=https%3A%2F%2Fgithub.com%2Fadamallcock%2Ftibotattle&repo_id=github-1311335567
