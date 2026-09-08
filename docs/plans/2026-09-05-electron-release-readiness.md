---
title: Electron readiness after the native 0.1.18 release
date: 2026-09-05
type: plan
status: in-progress
---

# Objective and current position

Updated 2026-09-08. Deliver one primary Electron application for Apple Silicon
Mac, Intel Mac, Windows x64 and Linux x64, with one shared product and release
process. Provider support stays inside that app. The accepted
[sharing policy](../decisions/2026-09-04-accountless-sharing-policy.md) remains
fresh-install automatic sharing, persistent opt-out, no sign-in, and three
visible notices before activation for existing undecided installations.

Cutover focus as of 2026-09-08: freeze the tested feature set at `98a5256d`.
Do not add cosmetic work, optional platform abstractions, or broader audits.
Change only a reproduced cutover blocker or the smallest test needed to resolve
one. The Mac daily-use tester is available; that is not full cutover readiness.

1. Close the real native Mac -> signed Electron -> next signed Electron
   installed rehearsal. Four signed private fixtures are prepared. The user
   approved proceeding with the backed-up installed Mac rehearsal on 2026-09-08;
   the signed current fixture reached the installed startup gate but stopped
   before migration because the credential verifier supplied a signing rule as
   a filename. Native 0.1.18 has been restored and reopened; its stopped-state
   backup matches all original files. Repair and rebuild this exact blocker,
   then resume data/choice preservation, single ownership, startup and
   credential continuity checks.
2. Finish the Linux native deadline fixture and the integrated disposable
   Windows installer journey. Observation creation/recovery now passes; the
   remaining failures are a nested-test environment and a process query.
   Fix and rerun these observed failures, then complete
   required production credential/trust composition and installed updates.
3. Complete one authorized hosted contribution rehearsal and explicit
   accountless public-sample/overlapping-history decisions. Preserve accepted
   automatic-sharing and persistent opt-out behavior throughout.

Across these three streams, freeze release candidates, verify four-target
installation/update evidence, then request the concrete staged
publication/activation decision.

Planning estimate, not a release commitment: 1–3 focused working days for a Mac
cutover candidate if migration reveals no major defect; approximately 1–2
working weeks for the complete four-target cutover, conditional on platform
access, trust material, activation decisions and no major new runtime defects.
Re-estimate after the first installed migration and Windows installer results.

Latest four-target results: `45fde21e` in
[run 34206887816](https://github.com/adamallcock/tibotattle/actions/runs/34206887816)
passes both Mac builds. Linux now passes observation creation, readback,
no-replace and recovery/refusal phases; its terminal service-deadline fixture
fails before reaching the expected five-second wait. Windows passes installation,
paired registry inspection, uninstaller availability and the first installed-byte
identity check, then its exact-process pre-launch probe fails. No installed app
launch or restart is qualified. Each platform owner is repairing the reproduced
fixture/probe failure while root executes the Mac installed rehearsal. Hosted
work is confined to preparing a fixed nonproduction synthetic rehearsal;
no remote deployment or public aggregate-policy change is authorized by this
source preparation.

Installed Mac rehearsal on 2026-09-08: the exact signed `d5dc8025` current
fixture was placed at the native application path after a stopped, verified
backup. Its bundle, archive identity and Gatekeeper checks pass. The startup
verifier invokes `codesign -R` with an unprefixed requirement, which Apple's
tool interprets as a filename; the same exact app passes when the inline
requirement uses the `=` prefix. This rejects the app before the Keychain
preflight and before a migration journal or working profile is created. No
credential continuity or installed migration is qualified. Native `0.1.18`
build `1026` is restored, its signature and all original state files match the
preserved stopped backup, and its actual dashboard has reopened. The failed
Electron bundle and private receipts are retained. The source repair and a
replacement signed pair are the next Mac gate; no update feed changed.

The Windows process probe now uses a fixed executable-name filter before its
exact installed-path comparison. Nineteen focused tests pass locally, with
three native-only exclusions. Linux's nested `node --test` child inherited
`NODE_TEST_CONTEXT` and exited successfully before executing the required
wait; a portable reproduction distinguishes that immediate exit from the
actual delayed child. The fixture now removes that variable and completes
D-Bus authentication before deliberately withholding service responses.
Twenty-three integrated Linux tests pass, with three native-only exclusions.
The five-second native deadline and production policies are unchanged; neither
repair closes its platform until the native CI journey passes.

The preceding four-target results: `40c21ade` in
[run 34204270030](https://github.com/adamallcock/tibotattle/actions/runs/34204270030)
passes both Mac builds. Windows passes native, companion, packaging, packaged
credential and installer-contract checks, then the actual NSIS journey fails
with `ELECTRON_WINDOWS_NSIS_LIFECYCLE_REGISTRY_UNAVAILABLE`. The installer
completes and settles, then the first post-install registry inspection fails.
Installed-byte validation, app launch/restart and owned uninstall are not reached;
this does not establish an installed app failure or qualify the lifecycle.
Linux compiles and packages, then the direct native diagnostic reports
`CREATE_MUTATION_NATIVE_COLLECTION_NULL_UNAVAILABLE`: collection resolution
returns no object or error before intent or credential mutation. Both failures
remain open pending native reruns. The Linux repair at `214b953f` explicitly
acquires and retains the default service proxy through collection lookup and
creation; 21 local focused tests pass, with two native-only exclusions, and
architecture checks pass. It retains the diagnostic categories until native
verification. The Windows repair at `db621767` selects the pinned install-registration key
for `InstallLocation`; absence covers both install and uninstall records, and
orphaned records are refused. Twenty-three integrated Windows/workflow tests
pass locally, with two native-only exclusions. This fixes test inspection and
does not itself qualify app launch or restart.

The preceding `43c59fdd`
[run 34202605849](https://github.com/adamallcock/tibotattle/actions/runs/34202605849)
passes both Mac builds and Windows packaged credential checks. Windows's native
PowerShell contract passes, but two portable contract cases fail before
installation: relative NSIS targets were resolved into valid-looking Windows
paths, and the template fixture assumed slash separators. Both repairs pass in
the subsequent native run. The original failure remains preserved.

The preceding direct Linux diagnostic run: `7731a6e3` in
[run 34200413924](https://github.com/adamallcock/tibotattle/actions/runs/34200413924)
passes both Macs and Windows. Linux compiles and packages, then refuses
account-observation creation with `CREATE_MUTATION_UNAVAILABLE`. Both read
boundaries and the read-only default-collection probe pass: the collection
exists and is unlocked at that snapshot. The remaining failure lies inside
the native pre-intent creation path. The five-second service-deadline fixture
is later in the journey and has not yet executed. Its original failure log and
source-bound fixed receipt remain preserved; the probe adds no product API or
credential mutation. Temporary fixed native error categories now identify the
actual lease/read/collection boundary in the isolated test lane. Public failures
and mutation safeguards remain the same. Remove this diagnostic seam after the
concrete cause and its regression are verified. The preceding `bff275fb` run fails at the same creation
boundary before this additional prerequisite evidence existed.

The preceding `b103ef6d` run stopped at compilation because the timeout watchdog
used C++ exceptions under the existing no-exceptions build. The GLib repair keeps
that build policy, anchors the deadline to operation start and checks expiry
before normal settlement. `bff275fb` verifies native compilation of that repair.
The original compiler failure remains preserved.

The preceding native run: `90486dc6` in
[run 34194270068](https://github.com/adamallcock/tibotattle/actions/runs/34194270068)
passes both Macs and Windows, including the repaired packager's real runtime
configuration tests. Linux compiles and packages successfully, then fails the new
fixed account-observation test in its first `CREATE` phase, after initial read,
absent-intent refusal and the separate default-state marker pass. The preceding
`5d57f4e3` failure remains preserved with exact package hashes; the newer fixed
diagnostic localizes the failure without printing native errors or weakening
the success marker. A separate reviewed five-second aggregate service deadline
is integrated at `c6c03866`, with a native blackhole-service test, but is not yet
qualified on Linux. The previous all-four baseline
remains `de8965d5` in
[run 34189342330](https://github.com/adamallcock/tibotattle/actions/runs/34189342330).
The downloaded Windows and Linux apps, distributions and launchers match their
receipts. Linux's fixed-record v2 recovery compiles and passes native tests;
Windows passes both credential channels and retained records in new children.
Production selection, installed lifecycle and release remain separate gates.
The newer frozen Mac app `e2c4a784` passes full copied-history refresh and,
with independently reviewed harness fixes, synthetic tray/settings restart and
copied-history cancellation/retry. A separate copied-history relaunch run fails
a startup control-plane request at the existing three-second ceiling. Its
receipt is preserved. A consistent disposable copy isolates the blocker to the
synchronous post-write SQLite `PRAGMA quick_check`: a cold scan blocks the event
loop for 8,545 ms, while open, mutation commit, ordinary reads, projection and
publication do not reproduce that stall. The repair moves only the
read-only integrity scan into a worker and retains the collector lock and success
gate. The repair is integrated at `dd7058e9`, with export closure at `ad0e1333`.
It passes 195 focused collector tests and 149 integrated worker, refresh, export
and packaging tests (two artifact exclusions), plus architecture and preflight.
A real read-only scan over the disposable copied-state database takes 8,794 ms
with a 12 ms maximum main-loop gap. The frozen unsigned Mac `ad0e1333` package
matches ASAR `dd21fc6ed3824a13113b161478e2f5e51c1f2bbf1013d58c0aa4c6677cdabff0`.
Its synthetic UI/tray/settings restart and separate copied-profile full refresh,
cancellation/retry and relaunch journeys all pass. All runs quit cleanly. Status
and health requests reach maxima of 1–2 ms; timers advance. Cancellation is
acknowledged in 3 ms and settles after mandatory integrity verification in
5,162 ms. Relaunch retains the dashboard and starts a new successful automatic
refresh. These fixed receipts bind source and ASAR and contain no session data.
At that point the regular test launcher selected `ad0e1333`. It now selects the
qualified UI update described below. Its versioned launcher and the earlier
`1f74bbb6` launcher/profile remain preserved.

A supplemental `ad0e1333` packaged page pass verifies Overview, Allowance,
Trends and Usage routes and visible states, normal cache-link ingestion and
rendering, Spanish selection/system restoration, and General/Notifications/About
content. All eight screenshot hashes match the retained v2 receipt. The ordinary
and worker links keep canonical targets; verified auto-review rows target the
parent, and unresolved rows stay unavailable. Synthetic links were not opened.
The receipt remains incomplete only for native menu-bar interaction. Two separate
native automation attempts timed out; their original failure receipts remain
unchanged. The exact owned candidate processes were subsequently stopped and
absence verified. Neither attempt qualifies tray icon appearance or physical
primary/secondary-click behavior. A zero-comparison cache card also displayed
misleading 0% metrics. The shared-UI correction at `abbb9323` keeps the heading
and explicit empty state while hiding unsupported percentages and interpretation;
observed zero-percent reuse with a positive denominator remains visible. All 565
web UI tests pass. The fresh frozen `98a5256d` arm64 app binds ASAR
`d3f2a643824e0a3ab9e199b949d7d1d25a6d6075e2abd02c9631775984eedd24`.
Its packaged page/cache/settings checks and synthetic tray/settings/restart smoke
pass; the page receipt remains incomplete only for physical native tray evidence.
The corrected empty-state screenshot visibly retains the heading and no-eligible
message and removes the unsupported metrics. Root independently verifies ASAR,
source receipts and all eight page screenshots. The regular tester launcher now
selects `98a5256d` with the validated separate copied profile, uploads/updater off.
Copied-history full/cancel/relaunch receipts remain explicitly `ad0e1333` evidence:
the only newer Mac product change is this rendering correction; no new history
journey is claimed. The old launcher remains available. No system installation
was performed.

The actual accountless client-to-disposable-Worker journey is reverified at
`5d57f4e3`: enrollment, encrypted upload, renewal, retained identity, no duplicate
uploads after restart, disconnect and persistent opt-out all pass. This uses
synthetic data and loopback only; it is not a hosted or installed-app receipt.

The next native candidate adds the fixed Linux account-observation credential
facade and its libsecret implementation at `547d4467`. Its read/create-only
contract uses a digest-only intent and refuses ambiguous recovery. The CI
harness runs its exact native test in a separate disposable Secret Service
container and requires the success marker after assertions; a skipped test
cannot qualify it. Portable integration passes 46 tests with one native-only
exclusion, 32 packaging tests with two artifact exclusions, and architecture
checks. Native compilation passes; `34194270068` localizes the fixed observation
execution failure to its first creation phase, which also contains a preliminary
read. The remaining repair must pass that
native journey before any runtime-readiness claim.

Windows signing configuration is repaired at `48da8404` and `261bfa83`. The
pinned packager previously rejected the configured Azure boolean switches and
ledger fields. Its schema, types and runtime now agree; native `.node` signing
refusal applies to the configured release ledger, preserving ordinary development
behavior. Nineteen tests pass against the actual installed patch, including real
configuration validation, target-completion ordering, cancellation and the
non-Windows path. All four development runners now execute these tests. This
uses no signing credentials and does not qualify Authenticode or installation.

The integrated Windows qualification slice is an actual unsigned NSIS install,
two independent top-level launches in one synthetic profile, and owned uninstall
with a registry cleanup check on the disposable native runner. It must distinguish
whole-app restart from retained credential or data continuity. The existing
credential journey deletes its synthetic installation record before exit.
The runner verifies installer and installed executable/ASAR identity, snapshots
process absence immediately before both launches, fences mutation/quit behind a
ready-time process snapshot, checks shutdown, and runs the owned uninstaller only
once. A failed or unsettled installer/uninstaller cannot trigger a competing
cleanup mutation. Read-only PowerShell queries take one fixed child-only path;
registry absence is explicit. Thirty-six focused tests pass on macOS with two
Windows-only exclusions, and 78 release-trust tests pass. The actual PowerShell
contract and installer lifecycle are now wired into disposable Windows CI; native
execution is pending. Receipt fields keep retained application credential state
and complete arbitrary-descendant cleanup unqualified.
Production finalization also needs a signed-resource composition: the development
loader pins unsigned native hashes and the development product identity. A signer
alone cannot activate that loader. The source preparer uses `win32-x64` paths and
target metadata, while the separate Windows signing configuration uses
`windows-x64` paths and the `win32` target selector. Those inputs need an explicit
checked mapping in the future finalizer, using existing release-evidence trust
contracts; no duplicate readiness authority or permissive production flag.

The earlier all-four development packaging baseline passes at
`f26146aaf7fe34845ed7192ae0100e88b9d9b660` in
[run 34179604251](https://github.com/adamallcock/tibotattle/actions/runs/34179604251):
Apple Silicon Mac, Intel Mac, Windows x64 and Linux x64. Windows passes the
actual packaged accountless credential journey: create/read, retained record in
a separate child, deletion, status and clean quit. Linux now passes its actual
packaged two-capability Secret Service journey over the inherited channel,
including conditional mutations, final absence and owned process cleanup.
These are development runtime receipts, not installer, whole-application
restart, trust, updater or production-selection qualification.

The Linux failure at `1f74bbb6` was narrowed to credential creation. The native
mutex requires an existing safe XDG state base, but the fresh disposable home
had no default `.local/state`. The harness now explicitly uses its already
verified owner-private home tmpfs as `XDG_STATE_HOME`; the session passes that
value and rejects any other state root before native access. Native filesystem
checks and isolation remain intact. All 30 focused tests and 78 release-trust
tests pass. Earlier archive-identity, generic-round-trip and create-stage failure
receipts remain preserved. The successful native rerun establishes this test
fixture repair; normal Linux first-launch/state setup is still a separate gate.

The follow-up Linux production review identifies three remaining source gates:
secure native setup when the selected XDG state base does not yet exist;
durable reconciliation of interrupted required credential mutations before
clearing abandoned markers; and a production composition that supplies the
reviewed parent-side credential factories. The current container
receipt proves none of those gates. The native first-run setup is now implemented at `58f1aafb`, with an isolated
umask-refusal regression at `0a0560a0`. It uses the binding's existing XDG/passwd
resolution, creates only fixed missing components, refuses unsafe existing
paths without chmod repair, and changes no credential or recovery state. The
main-only facade now runs before qualified backend construction. The next CI
lane uses separate disposable homes for the absent passwd-home native test
and packaged credential journey; its v2 receipt requires absent default state
before the app and a verified protected tree afterward. All 32 focused
composition/smoke tests and 52 packaging/native contracts pass locally (six
expected native/optional skips), plus 78 release-trust tests. The first native run at `993a711b`,
[run 34183824959](https://github.com/adamallcock/tibotattle/actions/runs/34183824959),
catches one C++ call passing a string where a character pointer is required.
That call is corrected. The next native run at `eeb74786762ae2127f5d1a49efbaaf751802f6cc`,
[run 34184192713](https://github.com/adamallcock/tibotattle/actions/runs/34184192713),
passes native compilation, explicit-XDG and umask tests, the separate absent
passwd-home test, and the packaged first-run Secret Service journey. The downloaded ASAR matches both package and smoke receipts at
`5dc652fef50c4713655e15c0c0c44b14655f2b98b3455bf4fd74fce5f6f7f506`. The actual
default native test log records one pass and zero skips. Its standalone
workflow now requires a fixed success marker emitted after all assertions.
An executed-program regression verifies real TAP line endings and rejects
skips, duplicate or absent markers, nonzero exits and process failures; a zero
exit alone cannot qualify the check. The marker is subsequently verified in the `793f6ed9` and `82cd7a1f` native runs. The repaired source-level Linux guard
now checks the exact qualification dependency closure and proves that ordinary
launch options expose no broker while production Linux selection stays closed;
all 119 portable foundation tests pass (five expected native/optional skips). An owner-bit-masking umask deliberately
fails closed and can leave a refused partial directory; the native child test
verifies that edge without changing the parent umask. Production flags remain closed. Real installed desktop
session, locked collection, lifecycle and updater evidence remains separate.

The accountless profile permits a smaller Linux production scope: the fixed
installation credential for enrollment/upload and one read/create-only account
observation credential for stable forward account/quota linkage. The uploader
uses an existing observation root only; unavailable roots retain explicit
account-unknown evidence. Legacy export-identity, Claude callback and paired
device credentials are not required by this profile and must stay unselected.
A dedicated observation facade and create/readback recovery can therefore be
qualified without activating or claiming recovery for the generic four-capability
backend. The Linux observation selector now accepts the actual narrow contract at
`2b4e3464`: read-only for existing-only loads, read/create for collection. All
22 observation tests pass, including refusal and existing generic compatibility.
No default backend or production platform selection is enabled. The separate
installation record still needs its own interruption/recovery proof. This scope
reduction is a source-backed implementation plan, not production activation.

The later dormant Windows account-observation foundation is integrated at
`f94161f4`, with packaging/source-export separation at `209a545e`. Its fixed
read/create-only channel uses the main-owned legacy observation capability and
mutation lease; production selection is unchanged. The main wrapper can reuse
the generic manager's journal recovery, so its narrow wire does not imply that
manager startup has only one capability's audit scope. Portable client exports
include only the child communication module; the native wrapper has its own
reviewed platform entrypoint. The agent's 87 focused tests, root's 84 shell/
observation tests, 35 packaging/broker tests (two optional skips), and 75
architecture/export tests pass. Native Windows Credential Manager continuity
and activation of this channel remain unqualified: the later `f26146aa` run
packages the dormant foundation but does not execute its new channel. The
subsequent local `0e553fb9` change includes its complete native-manager module
closure and checks every declared shell module's static dependencies. All 33
focused packaging tests pass, with two optional skips.

The later `1d631abf` source adds the actual qualification-only Windows
observation composition: an authenticated packaged context constructs the fixed
Credential Manager facade with its native mutex, durable audit and completed
startup recovery. At that revision the packaged smoke runs FD3 upload storage
followed by FD4 observation create/read and a fresh child reading the retained record.
The new v2 receipt separates their results and fixed failure stages. This is
confined to a disposable CI account; the fixed observation wire has no delete
operation, so that synthetic record's cleanup boundary is the runner account's
lifetime. All 90 integrated shell/credential/runner tests pass (one native-only
skip), plus 73 resource-authority/shell tests and 36 packaging/export tests
(two optional skips). Its first native run at `c5fe88f5`,
[run 34181867605](https://github.com/adamallcock/tibotattle/actions/runs/34181867605),
passes the FD3 journey but fails observation startup before child readiness.
The failed v2 receipt and exact ASAR digest are preserved. Source review finds
the audit guard trying to validate the launcher's ordinary inherited-ACL state
container as an owner-only final directory. The next candidate uses a fixed
new protected child root for the observation audit, preserving all ACL checks.
Fourteen focused tests pass, including a regression through the real audit
guard facade that rejects the old inherited-ACL parent. The native rerun at
`0ca67d425a5e21fa5b504e0975a5d423cadf581f`,
[run 34182650103](https://github.com/adamallcock/tibotattle/actions/runs/34182650103),
passes both Macs and Linux. Windows still passes FD3 and now reaches the
observation child, failing at `child_initial_read`; the protected-root repair
clears startup but does not yet qualify the full observation journey. The
content-free failed receipt is preserved. The later Windows diagnostic patch
at `eeb74786` distinguishes existing records from fixed trusted broker failure
categories. Its native run stops in the new composition tests before packaging;
the failing child/broker test exposes a duplex-transport mismatch. The extra
Windows pipe supports child-to-parent traffic, while this protocol requires
replies. The repair replaces that Windows-only channel with a fixed observation
protocol on the already-owned Node IPC channel, preserving independent upload
messages and parent-owned credentials. The replacement is integrated at
`cc15807d`. A real child-process test exercises both protocols together, with
bounded ordered requests, delivery callbacks that handle backpressure, and
independent listener disposal. Local integration passes 94 tests with one
Windows-only exclusion, 62 packaging/platform regression tests with two optional
artifact exclusions, and all 78 release-trust checks. The independent review
identified a pre-disconnected-child startup race, corrected at `b28d0cda` before
native backend construction and independently checked with 71 passing IPC/shell
tests. The unchanged qualification-authority marker retains its older FD4 name;
the wire has a distinct IPC announcement/schema. Linux foundation now passes
120 tests with five expected native/optional exclusions, and all 20 preflight
checks pass. Native Windows validation is pending. No native credential safety
check, deadline or production selector has been relaxed.

The native `2abe5448` run
[34186569809](https://github.com/adamallcock/tibotattle/actions/runs/34186569809)
passes the Windows channel tests but catches an integration regression in the
new supervisor guard: a live Linux FD4-only child reports `connected: false`
because it has no Node IPC channel. The correction at `394996f5` applies that
connection requirement only when Node IPC is selected, while refusing an
actually exited child on every transport. All 123 integrated cross-platform
broker/shell/runner tests pass with one native-only exclusion, including real
POSIX child journeys. The failed Linux job is retained; it produced no package.
Windows builds its package but the ordinary development companion is also
rejected before readiness by that same unconditional check. Its main process
continues answering status, so the outer rehearsal times out without requesting
either storage operation. The downloaded failed receipt is independently bound
to ASAR `ced4962677a95fd7b56ff12f709cd4ab87d5d89493d5998a9b073f343f77004b`.
The further regression at `3bddf9a8` spawns a real plain child without IPC,
observes `connected: false`, reaches readiness and stops it cleanly. Windows CI
now runs the full shell-core suite before packaging, so ordinary companion
startup is tested alongside the credential channels. Native rerun is pending.

The corrected `793f6ed9` run
[34187366354](https://github.com/adamallcock/tibotattle/actions/runs/34187366354)
passes both Mac packages and Linux. Linux's exact native success marker is
observed once and its downloaded ASAR matches the package and passed v2 smoke
receipt at `ceed9ff1f63ac5f300ef59b41c881e691f3b38f13f5d8b8c34e82724ab58ba06`.
Windows passes the real ordinary-child startup and shared credential IPC tests.
The newly included full shell suite exposes one older fixture expecting a
literal Mac path on a Windows host. `82cd7a1f` supplies a native absolute fixture
path and preserves the exact final `app.asar/package.json` assertion; all 63
shell tests pass locally. The `82cd7a1f` rerun passes all four targets.
The downloaded Windows ASAR is
`61d9f19dd9edeae7bd8b805cb3f7ee04eb7dd4ad49c7580b7f8d0073fa09d345`;
both packaged credential journeys, child retention, status and owned-process
cleanup pass. Its receipt explicitly leaves whole-application restart,
installation, hosted upload and production readiness unqualified. The Linux
ASAR remains `ceed9ff1f63ac5f300ef59b41c881e691f3b38f13f5d8b8c34e82724ab58ba06`,
with matching passed default-bootstrap/credential-lifecycle/cleanup evidence.

The fresh unsigned Mac package from frozen `793f6ed9` is independently bound to
ASAR `514228a25e373c1b74acde83253711b3bd749c993a4c6971d06759d37caed771`.
Its v5 synthetic smoke passes startup refresh, Usage/Community presentation,
five Settings tabs, persisted sharing/refresh controls, tray customize/preview/
undo/default/reopen/process relaunch, Share and clean quit. The dashboard and
tray captures were visually inspected. Its copied-history run fails the timer
gate: once file counting starts, the product label omits elapsed time. The failed
receipt is retained. `e2c4a784` adds elapsed time to both loaded-summary and
file-count progress labels and preserves completed startup/control-plane
probe evidence when another probe fails. All 280 focused and 564 UI tests pass.

The new frozen `e2c4a784` Mac app has ASAR
`2681d9547e4980932539ee35bc78121c5ff8df851c23c8d4d8d82ca58329ea05`.
Its full copied-history run passes with an advancing rendered timer, one
successful startup refresh, Usage/Community parity, and clean quit. Both
endpoints pass 20 active samples each with p95 1 ms; their maxima are 455 and
456 ms, retained against the existing 3,000 ms per-request and 250 ms p95 gates.
Cancellation mode separately accepts both cancel requests and a new refresh
on retry, but the overall run fails its timer gate; its original receipt is
preserved. The sampler remains active across cancellation and the retry's
reset elapsed counter; that run alone cannot qualify cancellation end to end.
Copied-history relaunch is a separate mode. The fresh synthetic test passes initial settings, persisted controls, and tray editing,
but its restart fails at `settings_target`. Review finds the test invokes the
settings bridge before lifecycle startup finishes; the first-launch test already
waits for the app-owned rendered-ready marker. The correction uses
that same predicate before the one relaunch invocation, without retries or
changed deadlines. The failed receipt is preserved. The correction at
`d4aa4bee` passes all 31 smoke contracts and a fresh native synthetic run against
identical `e2c4a784` bytes, including tray process relaunch and clean quit. The
rendered dashboard/tray captures are inspected, with separate harness provenance.

The cancellation sampler is subsequently bounded to its initial refresh at
`985459c3`. It stops as soon the unchanged four-distinct-values/three-second
span is demonstrated, refuses decreasing counters, and discards CDP snapshots
that resolve after cancellation closes that sampling window. No extra status
poll, delayed cancel, timeout change or product behavior is introduced. All
33 focused contracts and independent review pass. A fresh native cancel/retry
run against the same app passes: advancing timer, 20 active samples per
endpoint at p95 1 ms/max 441 ms, acknowledged cancellation, accepted retry with
a new refresh identity, second cancellation, and clean quit. A separate original
harness relaunch run fails during its first refresh: one request exceeds the
3,000 ms per-request ceiling (serialized as the bounded 3,001 marker), although
refresh later succeeds. That failure remains preserved; it does not qualify
relaunch or clean quit. Launcher promotion waits for diagnosis of this stall.

The Windows production observation selector at `8789b50c` now accepts only the
explicit parent-owned read/create IPC adapter in the accountless companion.
Existing-only upload reads cannot create a root, unavailable adapters retain
unknown attribution, and no legacy fallback is activated. All 32 selector and
332 local companion tests pass. Production platform selection remains closed.

Linux fixed-installation-record recovery at `c1a07397` uses a canonical fixed
v2 intent, exact candidate/expected bytes, no-replace create publication,
exact-value delete quarantine, pinned directory checks, durable reconciliation,
and the legacy refusal latch for unsafe or uncertain states. Independent review
found and resolved intent-removal and credential-directory durability gaps.
Recovery-state tests cover interrupted create/delete and malformed, mismatched,
or unsafe residues. These model on-disk interruption states, not actual power
loss. All 120 portable foundation tests pass with six expected native exclusions,
plus 36 packaging tests with two optional artifact exclusions and architecture
checks. Native compilation and recovery execution pass at `de8965d5` in run
`34189342330`, followed by isolated default-state and packaged Secret Service
journeys. The downloaded Linux ASAR is
`ab8a64210660710fbe474477278400360f36a2c928555729902f8c0eb18466ca`;
Windows ASAR is
`f61fa088aa9669945216c865cc095dd11b12ba9174624d962916b2c61a2de8cd`.
Both independently match package/smoke receipts; each target's two distributions
and three launcher/handoff files also match sizes and hashes. Linux's narrow
observation adapter and final production composition remain open.

The accountless production companion profile is now integrated at `b3643991`.
It requires the exact production mode/origin and a connected private IPC
channel, closes legacy sign-in and contribution routes, and avoids constructing
legacy queue/preparation/participant controllers. Current account observations
and the shared companion single-writer lock remain intact. All 332 local
companion tests pass, including the new profile's route, startup-failure,
observation and ownership checks. This is source/local-runtime evidence;
hosted activation remains separate. The new Mac daily tester below also
qualifies the current packaged Community/accountless-profile presentation.

The previous daily Mac tester was frozen `1f74bbb68f8c0ea88f1610e2da02cee4524f3c86`,
with ASAR `771c0f16a9936737eb62d249e13c6e4e67d852139447d1b0b8573ba4351ff357`.
Its synthetic rendered journeys and copied-history Usage/Community, timer,
active-refresh responsiveness and clean-quit qualification pass. Both endpoints
have p95 and maximum 1 ms over 20 active samples each against the unchanged
250 ms limit. All 157 focused tests pass. The first synthetic attempt completed
its page/settings checks but did not qualify the separate-process tray relaunch;
its failure receipt is retained. An isolated retry against identical source and
ASAR passed every check. Harness `e9ab4eb69def92589df7d99ae7e53818a6080af5`
(integrated as `35787e68`) adds a pre-exit descendant barrier, an exit observer
registered before signaling, fail-closed PID probes and fixed relaunch-stage
diagnostics. Its 33 focused tests and a fresh native synthetic run against the
same `1f74bbb6` app pass with clean quit and tray relaunch. The first receipt
does not establish the underlying cause; it remains preserved.
The default durable launcher selected that
package with hosted contributions disabled and a separate copied profile; the
opening status records its qualified `ad0e1333` successor. Its
previous `0f03c121` launcher and app/profile are preserved, as is the older d5
backup. The earlier 0f run's 524 ms response remains in its original receipt.
No installed native app
has been replaced. No current source is yet a production replacement.

The earlier four-target successful development build
`ae8f5bb60f011d3d14300beb026560d417eb2370` remains historical evidence. Its unsigned packages passed
[CI run 34163441097](https://github.com/adamallcock/tibotattle/actions/runs/34163441097),
including Linux native lock/crash-recovery and fixed accountless-record
qualification, the maintained Mac packaging regressions, and the Windows
protected-child binding lane. The separately approved Mac signing source remains
`d5dc802575b6b6a0ad0faee26c05fd50778b77e1`, whose four development jobs passed
[run 34151603489](https://github.com/adamallcock/tibotattle/actions/runs/34151603489).
The integrated source includes upstream
changes through native `dffe64d60c3ea6de985c697c31678bdf22feb815` and Electron
tray PR113 `23a506dd2fcccf05be56868b7e1cb400ec6715fd`, and the new Mac
credential-broker, renewable accountless upload leases, closed Mac update
rehearsal and production-disclosure source. The inspected local Mac
candidate at that same `d5dc8025` revision runs against a private
copied profile with hosted contributions disabled and repairs the accounting
compatibility defect found in the earlier package. Both include the shared
model-attribution and retained-view fixes. The sealed `d5dc8025` installers and
successful `ae8f5bb6` four-target build predate these new tray changes and the
Windows accountless storage integration; they do not qualify the current
combined source.
Native 0.1.18 is the predecessor baseline, whose tag resolves to
`55c813a1bf7e67c00e47410b760104c0d9fbc0ea`.

This establishes a development candidate, not a production replacement.
The accounting reader now accepts only the exact compatible base/parent-model
parser pair, retaining generation checks and rejecting other mixed versions.
The packaged `49d84a33` refresh rebuilt complete, replay-safe accounting and
restored cache-task links, including Auto Review parent links. Settings/About
and the shared contribution-settings destination were inspected; sharing stayed
off. The subsequent `aead5d00` candidate passed the same page/control checks,
active-refresh responsiveness, cancellation and a durable-launcher restart with
sharing still off. PR113 subsequently recorded a packaged ARM tray smoke and
visual inspection. The current combined candidate and physical platform tray
behavior still need qualification. The earlier production updater and
native migration source at `91355893` had a
[four-target CI run 34137413523](https://github.com/adamallcock/tibotattle/actions/runs/34137413523)
failure at shared packaging contracts before installer creation. The repaired
inventory, independent verifier and platform staging passed the subsequent
four-target run at `aead5d00`; the failed run remains preserved. Physical
platform, credential continuity and installed
upgrade evidence remain incomplete.

The exact `d5dc8025` Mac package subsequently passed settings/About and shared
sharing-destination inspection, both cache-table pages, refresh cancellation
with completed results retained, native-menu Quit and restart through the
durable launcher. Sharing remained off after restart. At that stage the launcher selected
this package; it now selects the qualified `ad0e1333` package described above.
The earlier packages, profiles and versioned launchers remain preserved.
All 180 active-refresh samples in 45 seconds passed: health and status p95 were
1 ms, maxima 28 ms, with no failures and the unchanged 250 ms p95 budget.
Settings remained interactive during the same refresh. Parent task URLs are
present; the external Codex navigation postcondition remains unqualified.

# Workstreams and completion evidence

| Workstream | Remaining work | Required demonstration |
| --- | --- | --- |
| 1. Product and background parity | Finish a fixed page/action matrix against native 0.1.18: overview, allowance, trends, usage/cost/cache, community, settings/about and tray. Compare accounting, quota, refresh, retry/cancel, persistence and relevant hosted/admin behavior on the same evidence. Record intentional visual differences. | Exact packaged candidate passes journeys, with no unexplained data/behavior differences or unresolved blocking interaction defects. Cold, active-refresh and recovery behavior remain usable. |
| 2. Native Mac handover | Exercise the prepared signed private handover installers against the supported native predecessor after installation authorization. Verify the implemented migration, exclusive ownership, login-item handover, silent credential continuity and interrupted recovery on both Mac architectures. | Supported native predecessor upgrades to signed Electron without loss, duplicate writers/uploads or reset choices; restart and interrupted migration recover. Cover both Mac architectures. A copied development profile does not satisfy this gate. |
| 3. Accountless contributions | Complete production platform credential selection and an authorized controlled hosted rehearsal of the locally verified enrollment, encrypted upload, renewal, replay and opt-out paths. Resolve public sample admission and overlapping-history policy; verify rendered production disclosures and three-notice delivery. | Fresh automatic sharing; three actual notices for existing undecided installs; persistent explicit opt-out; usage/quota linkage across provider/account changes; deduplicated lost-response retries; bounded abuse; revocation/expiry and no unexpected public aggregate admission. Test first against disposable synthetic Worker databases, then an authorized controlled hosted rehearsal. |
| 4. Production packaging and updates | Extend the prepared Mac private signing/update rehearsal to Windows and Linux production trust/finalization; verify installed current-to-next updates and interruption on each claimed target. Keep final identity, feeds, release metadata and payloads bound to one source/version. | A signed/trusted Electron candidate updates to a subsequent signed/trusted Electron candidate on each claimed target. Installers, update payloads, checksums and support/download metadata identify the same frozen source/version. |
| 5. Platform runtime qualification | Finish Windows/Linux production adapter composition where still gated. Exercise actual credentials, filesystem permissions, tray, notifications, login startup, sleep/resume, install/upgrade/uninstall and recovery on declared environments. | Reproducible native runtime/lifecycle receipts for Apple Silicon, Intel, Windows x64 and the explicitly supported Linux environment(s). A build or container pass alone is insufficient. |
| 6. Rollout and native retirement | Integrate through one source/release line; prepare compatible backend rollout, tester cohorts, support/privacy copy, recovery instructions and a defined observation window. Retain long-tail native migration access. | Controlled rollout succeeds, subsequent Electron update succeeds, all advertised targets qualify, and the observation/recovery gate passes before the active native feature/build lane retires. |

# Execution order

The earliest decisive milestone is **native 0.1.18 -> Electron candidate ->
next Electron candidate**, preserving data and choices throughout. Prioritize
streams 2 and 4 together; this tests the most consequential unproven part of
the transition. Test supported 0.1.17 upgrade paths as well, or provide a
qualified bridge rather than silently excluding users who skipped a release.

Run product parity, accountless integration and Windows/Linux preparation in
parallel. The user requested completion of every stage after reviewing this
roadmap, authorizing the reviewed accountless source migration and disposable
synthetic rehearsal. This work is now assigned alongside migration and updater
implementation. Hardware or visible-inspection gaps do not stop independent work.

Use three explicit readiness milestones:

1. **Daily-use tester:** product journeys pass on the packaged Mac candidate,
   copied-profile refresh/cancel/restart are reliable, known limitations are
   visible, and the original installation is preserved. The `98a5256d` tester
   satisfies the core runtime journeys and is available now; physical menu-bar
   parity remains unqualified. Hosted contribution activation is separate.
2. **Release candidate:** real native migration, accountless end-to-end tests,
   production updater/signing and required native platform journeys pass on
   frozen candidates. The next Electron update is part of this milestone.
3. **Primary public app:** authorize compatible server preparation and staged
   client rollout, verify live delivery and updates, then retire native feature
   development after the agreed observation/recovery gate. Four-platform
   support requires all four platform gates; earlier previews are labelled.

One programme and one intended app release do not require one simultaneous
production switch. Prepare backward-compatible server changes before client
activation. Test local app migration while contribution sending is held, then
test the full enabled policy before its release. A temporary hold must be
explicit in tester copy; it must not silently become a change to the accepted
fresh/existing-install sharing policy.

# Scope and ownership that keep this bounded

- Assign narrow owners for product parity, migration, contribution ownership,
  and distribution/platform adapters. Use one integration owner and one
  acceptance ledger. Parallel agents can implement and review isolated pieces;
  physical-device and signing evidence still requires the actual environments.
- Reconcile the released base once, then bring necessary shared fixes through
  the integration line. Keep native-shell changes to urgent fixes and migration
  support; new features target the shared app. Do not create another detached
  "latest features" product or competing release manifest.
- Keep current primary package formats: two thin Mac packages, Windows NSIS,
  and Linux AppImage with its declared support environment. Additional stores,
  Linux formats, universal Mac packaging and more CPU targets are outside the
  initial cutover. One source can still produce platform-specific binaries.
- Reuse electron-builder and a compatible pinned electron-updater behind the
  existing release trust policy. [Official updater documentation](https://www.electron.build/docs/features/auto-update/)
  confirms the existing Mac/NSIS/AppImage direction; it does not qualify this
  repository's pinned versions. Sign early in migration/update experiments:
  [Electron documents](https://www.electronjs.org/docs/latest/tutorial/code-signing)
  that Mac key storage, login registration and updating depend on app signing.
- Keep Claude off the initial shell migration critical path. Enable it later
  through the same shared provider interface and the same four packages.
- Timebox the direct native-updater-to-Electron handover experiment. If it is
  not viable, select a minimal bridge or a guided signed install with the same
  data-preservation checks. Do not build a general migration framework.
- Set a short initial budget for that handover/updater spike and product QA,
  then estimate the release date from its results and confirmed hardware/
  signing access. A calendar promise before those checks would be speculative.

# Evidence and outstanding access

The previous candidate `88245f7d` passed CI but failed actual startup because
its Electron inventory omitted the credential adapter. It remains rejected;
its failure evidence and disabled launcher are preserved. Candidate `65a1132b`
adds both the missing file and a mandatory staged module-linkage check, including
an isolated plain-Node load before package staging completes. This failure is
why artifact execution is a required gate in addition to source tests.

Relevant affected suites passed: 542 web, 315 local-companion, 437 combined
Electron/contribution security checks, 24 final desktop-runtime checks, 66 Auto
Review checks, and 570 Worker tests plus its script/package/type checks. The
Worker's dry-deployment/staging portions passed locally after preparing the
required generated site artifact. This is component-wise gate evidence; the
full root/native artifact suite is not claimed green.

The corrected Mac candidate's 45-second active interval had 180 successful
rounds, per-endpoint p95 1 ms, and maxima of 22 ms (health) and 7 ms (refresh
status), within the unchanged 250 ms p95 budget. This does not cover every cold
or quick-publication phase, renderer responsiveness or UI Quit. Keep those
qualification cases in the product journey ledger.

On 2026-09-06 the unlocked Mac allowed packaged inspection: Settings navigation,
About alignment in light and dark, persistent sharing off, responsive Settings
during cancellation, and completed cancellation preserving prior results were
observed on candidate `65a1132b`. The 7-day allowance control exposed misleading
minimum-span wording: short ranges deliberately include every fit, so source
now labels the slider as observation classification and explains that behavior.
The correction was subsequently checked in packaged candidate `259d6d8d`.

On 2026-09-07, the same retained `65a1132b` package completed its analysis and
resolved cache-drop task links, including Auto Review rows pointing at their
parent task. Sidebar hide/show and the rendered share-card preview worked.
Choosing Quit produced an `exited_cleanly` receipt and a process check confirmed
the package and owned launcher/companion were gone. A second 45-second status
probe collected only idle samples (180 successful rounds, p95 1 ms); its
`active_insufficient_samples` result is preserved and does not replace the
earlier active-refresh evidence. The wording/layout correction is committed as
`d6b9214d` and is rendered correctly in `259d6d8d`.

The `259d6d8d` Mac build has ASAR SHA-256
`cb8e67148ad729663b02fdc28504f5239d789ccbdc97e79b588bb7537fbdf979`.
Overview, 7-day allowance classification, full-width Community, persistent
sharing off, retained expanded Trends charts, Astra labels, and cache-table
pagination were inspected. The cache-task failure was diagnosed through
read-only index and refresh metadata, preserving the original databases and
generation checks. Its 45-second responsiveness probe caught idle samples only
(p95 2 ms for each endpoint), so it is explicitly not active-refresh proof.

The integration source now binds production contribution and update selection
to the packaged app's own validated distribution manifest. Development and QA
launches retain their disabled hosted transports. The production client uses
the existing v1.1 usage/quota transport with accountless upload authorization;
it explicitly rejects borrowing social consent as that authorization. The
owned-companion tests cover encrypted installation-credential reuse, persistent
opt-out/restart and cancellation. Updater composition tests cover protected
preferences and child shutdown before installation. Native handover runs after
primary-instance ownership and readiness, before settings writes, and blocks
startup if existing data cannot be transferred. The combined root-owned
integration suite passes 154 tests; architecture checks pass with no debt.
The subsequent 101-test composition gate also covers failed update-install
recovery and migration retry. An actual compiled Swift helper regression test
proved it must be placed in `Contents/MacOS` to see the enclosing app identity;
the production staging configuration now uses that location. These are source
and synthetic-composition results, not installed migration,
hosted service activation or signed update receipts.

The `49d84a33` Mac candidate has ASAR SHA-256
`8e561614c2fbc0f8de80febe9a4149fd1f900f7654ac53fe937669da9941fee1`.
Its active-refresh qualification collected 180 active rounds in 45 seconds,
zero failures, and p95 1 ms for both endpoints; maximum health/status response
times were 22/8 ms. The original 250 ms p95 budget remains unchanged. The
accounting repair passed 206 related tests and independent review.
Choosing the native menu's Quit action returned an `exited_cleanly` receipt
with artifact verification; a separate process check found no remaining owned
candidate or companion process.
The durable launcher was then exercised again: the app reopened with sharing
off, an active refresh accepted cancellation and returned to the available
refresh control, and a second normal Quit produced the same clean receipt.

The `aead5d00` candidate has ASAR SHA-256
`6a7a0694b6cdb25d19f2485d8b0dd4cf1c38e4c6274db009a0719a2097d61a6a`.
Its confirmed owned-companion port was bound to the actual process before the
final UI and responsiveness checks. An earlier ambiguous development-window
observation is excluded from this proof. The confirmed pass inspected About,
General, Notifications, Data & privacy, Community, cache-table pagination,
daily Trends and the seven-day allowance explanation. All 180 active-refresh
rounds succeeded in 45 seconds, with p95 1 ms for both endpoints and maxima
19/7 ms for health/status. Cancellation retained the prior view and restored the
refresh control. The durable launcher now selects this exact artifact and a
separate copied profile; the previous app, profile and launcher remain available.

Credential review found a separate production blocker: the old native
Keychain broker terminates with the native app, while Electron's legacy
fallback cannot establish continuity with app-owned credentials and refuses
Intel. A fixed-capability, main-process macOS adapter now composes the existing
companion protocol over a separate owned-child pipe. Read-only preflight runs
before predecessor or data mutation. Modern absence requires a separate
attribute-only legacy check; locked, denied and legacy-only state never become
new identities. Existing values are updated without deleting the old item or
changing its ACL. The main/transport tests pass 62 cases and the separate
runtime suite passes 28 outside the loopback-restricting sandbox. The complete
Electron source suite subsequently passed all 430 tests. Combined native helper,
adapter compilation and packaging checks passed 45 tests with two expected
platform skips. Both thin Mac adapter binaries compile; only the host module's
constants are loaded, without accessing real Keychain items. Independent review
also tightened absence checks to the exact readable, unlocked Keychain search
list, while preserving successful reads from available stores. Signed prompt-free continuity
still requires actual qualification. Linux's
account-observation/identity adapter and Windows's production composition,
binding provenance and actual desktop qualification remain explicit gates.
A successful installer build does not
activate those production selectors.

First-launch disclosure now selects production copy from the validated
distribution metadata. Production explains automatic sharing, persistent
opt-out and available update controls; development retains its unavailable
upload/update disclosure. All three desktop languages are covered. The
disclosure tests pass 10 cases and the runtime suite passes 28, including the
production composition. The acknowledgement still grants no upload authority.
Rendered production-dialog qualification remains outstanding.

A separate accountless credential review found that Electron's async
safeStorage availability probe initializes its Keychain provider; it does not
guarantee noninteractive access. A main-owned native accountless credential
backend now operates separately from the four legacy capabilities; production
macOS never initializes safeStorage. Existing encrypted installation credentials
fail closed for explicit recovery rather than silently rotating an identity.
Locked native storage can retry after unlock. The complete integrated Electron
suite passes 445 tests, and both thin native adapter architectures compile.
Signed runtime qualification and the explicit legacy-ciphertext recovery
journey remain gates; automatic setup is not yet claimed prompt-free.

Source lifecycle review found that the accountless enrollment lease expires
after 30 days and replay does not renew it. A same-secret authenticated renewal
route and client now extend the existing installation/owner graph within seven
days of expiry or after an offline period. The client recovers once from expiry
between enrollment and ownership verification, without creating a replacement
identity or resetting upload history. Its 32 focused tests and 89 related
client/scheduler/transport tests pass. Worker renewal and migration focused
tests pass 27 cases, including due and expired leases, concurrent requests,
revocation, erasure and transaction rollback. The actual client also passes the
local HTTP Worker journey with the new renewal route and rejects renewal after
disconnect. The clean frozen `d5dc8025` source passes all 581 Worker tests
and 190 script checks, including package/type guards and generated assets.
Dry-deployment checks pass; staging remains unconfigured with collection
unauthorized. The renewal-enabled actual-client/local-Worker journey also
passes from that frozen source. No remote migration or deployment occurred.

Updater source review also confirmed that a higher build number alone cannot
trigger an Electron update: the successor needs a higher semantic app version.
The production source now supports a closed, explicitly supplied pair of later
Mac prerelease versions on a fixed isolated feed. Automatic download is disabled
for this exercise; only the first candidate can manually download its exact
named successor. The 27 focused updater/distribution/manifest tests pass,
including rejection of unrelated feed versions. Both Mac architectures have
clean frozen source stages for versions
`0.1.19-native-to-electron-handover.1` and `.2`, builds `2026090701` and
`2026090702`. Every stage's 693 files and package/runtime metadata were verified.
The user approved private signing and Apple notarization of these exact
`d5dc8025` candidates on 2026-09-07. Installation, update-feed publication and
public release remain separate operations; no feed was published.

The first Apple Silicon `.1` candidate is signed, notarized and stapled, with
strict app/DMG Gatekeeper checks, the final app verified inside both ZIP and
read-only mounted DMG, and all 18 Mach-O files verified as ARM64. Its final DMG
SHA-256 is `d807fd92092153b4fbe2ae5c72487b3f8e6bd021f00ce721146aedaaa8f24f65`;
the ZIP is `23b11db5f65d74ecfb666f84a4fd47f1ef7d12ef5b7062be2f52186ee99229d9`.
Finalization signs/notarizes/staples the outer DMG before regenerating its
blockmap and rebinding updater digests to the final bytes. The updater's
transport channel is `native-to-electron-handover`, distinct from the logical
product rehearsal channel. Read-only comparison with installed native 0.1.18
build 1026 confirms matching designated requirements, signing team and bundle
identity; candidate build 2026090701 is higher. Installed handover approval is
pending. The Apple Silicon `.2` successor is also signed, notarized and stapled,
with the same final signature, Gatekeeper, enclosed-app and metadata checks.
Its DMG SHA-256 is
`002136a5b826b24bbf9cff34993e10017e9b79dd50f7d0479a456518419faa5f`;
the ZIP is `8682be7aa39497fa93431a4cf52be824ed9a0ea87685fd72b53997149c305c07`.
Both finalization receipts and independent artifact digests are retained under
the frozen source's private build tree. The Intel builder has failed during
signing, despite a valid configured identity and successful signing of a
disposable bundle copy. The exact failure is now reproduced and repaired on a
disposable app: the pinned signer visits the real `CFBundleExecutable` before
the unsigned handover helper in the same `Contents/MacOS` directory. Signing
that helper first lets the full pinned signer finish its strict verification.
The upstream [inside-out signing order](https://github.com/electron/osx-sign/blob/main/src/sign.ts)
explains the bundle-sealing constraint; this app needs the actual plist-named
main executable distinguished from its same-directory helper. Intel finalization uses isolated signing orchestration with the frozen
source/dependencies unchanged. The first Intel `.1` installer subsequently
passed all app/DMG signing, notarization, staple, strict Gatekeeper, enclosed-app
and final-byte metadata checks. All 18 native objects are thin `x86_64`; the
private verifier was corrected to map the target label `x64` to that canonical
Mach-O name. Its DMG SHA-256 is
`de4267bd04a657c875036242e101cc4fca8b9439c1b88cc8d5d0563164fc01d2`;
the ZIP is `0d45e15ea386137cb9ad40e2c6018b64d67b87946a4f819615dde7341e7f42e2`.
The second Intel `.2` candidate passed the same signing, notarization, staple,
Gatekeeper, architecture, enclosed-app and final-metadata checks. Its DMG SHA-256
is `bdabc861c6496f3a3501770627f39cc1e77b29ec6b929eb931e78d838c8c3397`;
the ZIP is `074e549649329eb98e9f5fc1abaea8fc05a21d3540fc1676b4337bb959953365`.
Independent final verification checked all four finalization receipts and all
eight installer/archive sizes and SHA-256 digests. The private receipt
`approved-four-mac-installers-verification.json` records the complete approved
signing stage. No candidate has been installed and no update feed was published.
The exact private feed bundle is also staged locally for both architectures:
18 files spanning the two versions' installers/blockmaps and one `.2` transport
manifest per architecture. Every copied payload matches its sealed finalization
receipt, each manifest's size/SHA-512 binds the exact successor payloads, and the
target directories contain only the expected files. The private
`feed-staging-verification.json` records this local preparation; no hosting or
publication request was made, and the stable feed remains untouched.
The signing-order repair and final-byte updater metadata generation are now
incorporated into maintained packaging tooling; those source changes do
not alter the four sealed `d5dc8025` candidates.

The maintained metadata finalizer is now integrated at `a0ac852c`. It accepts
only the fixed rehearsal source receipt through
`node scripts/finalize-electron-macos-update-metadata.mjs --candidate-receipt <candidate>/production-source-candidate.json`.
After separately authorized signing, notarization and stapling finish, it
preserves the original manifest and DMG blockmap without clobbering, verifies
the unchanged ZIP, regenerates the DMG blockmap, and binds the fixed transport
manifest to the final files. Its receipt explicitly proves metadata binding
only; it does not prove signing, notarization, installation or publication.
Root verification passed 22 focused metadata/distribution tests and ran the
CLI on disposable mirrors of the real sealed ARM `.1` and Intel `.2` payloads,
then rehashed those payloads against the untouched sealed originals. That
real-artifact check found and fixed a mismatch between the planned receipt and
the native-helper statuses added by actual source staging. Failed pre-fix
runs and the successful corrected receipts are retained separately.

Commit `a84729bf` adds explicit, journal-bound recovery for interrupted metadata
replacement. It preserves the exact candidate, payload and pre/final sidecar
bindings before either replacement, serializes stale-lock recovery, and refuses
live owners, changed payloads, damaged backups, unrecognized states and already
completed finalization. Recovery restores the original sidecars and verifies
them before removing the journal; normal finalization can then run again.
The integrated metadata/signing/distribution suite passes all 37 tests.
Pre-journal crashes and unverifiable recovery claims deliberately require
separate investigation rather than guessed cleanup.
Fresh disposable mirrors of the real sealed ARM `.1` and Intel `.2` installers
also pass an actual process-termination rehearsal: kill after the first sidecar
replacement, observe partial state and normal-retry refusal, run explicit CLI
recovery, verify exact prior bytes, then complete normal finalization. All four
copied payload hashes and their sealed originals remained unchanged. The
private `real-artifact-recovery-verification.json` receipt records this check;
the completed original installer directories were never recovery targets.

The maintained signing hook is integrated at `040f8c7d` with concurrency and
dependency-pin checks at `f4acabc7`. The production builder resolves its
`mac.sign` hook without invoking signing in tests. It temporarily orders the
pinned signer's child list using each app's actual `CFBundleExecutable`, then
uses the same builder signing options and retry route. Concurrent hook calls
serialize the temporary change and restore the original function on success
or failure. A disposable copy of the sealed Intel `.2` bundle reproduced the
original main-before-helper order across 727 discovered code objects; the
maintained comparator preserved that complete set and repaired the order.
The 30 focused signing/metadata/distribution tests pass. Both Mac development
jobs and production-source preparation jobs now include the credential-free
signing-order and metadata regressions. No workflow token, signing authority,
publication permission or automatic release action was added. Release trust
checks pass 78 tests, and the tooling inventory now covers these entrypoints
and the earlier source-preparation/native-build helpers.

Accountless synthetic enrollment/upload/deduplication/disconnect tests have
run against disposable Worker databases. Independent review identified two
additional release blockers: accountless chunks consumed the public source
selection budget before filtering, and accountless lifecycle triggers could
withdraw social public aggregates. Both fixes now pass targeted regressions,
including 30,001 private source chunks without exhausting the public selector's
budget. Independent review then added an exact enrollment/device ID invariant and its
negative SQL test. The frozen integration commit `86062adc` passed all 576
Worker tests and 190 script checks, including generated types and package-copy
guards. Its dry-deployment checks initially stopped because the clean checkout
had no generated public-site assets. After generating the exact source tree
with installer links disabled, both remaining dry-deployment and staging
configuration checks passed. No service was deployed; staging still reports
unconfigured resource identifiers and no collection authority.

The actual Node accountless client now passes a disposable local Worker
journey using the default rate limits: enrollment, direct upload ownership,
capabilities, three encrypted objects containing five synthetic usage/quota/
session records, restart with no duplicate uploads, disconnect fencing and
persistent opt-out with no requests. The later renewal-enabled journey also
passes with the same installation identity and unchanged history. This test
exposed and fixed a missing
authorization-shape validator in the real incremental dispatcher. The related
40-test client suite passes. A Miniflare migration rehearsal also preserved
10,001 social participant rows plus the complete dense descendant fixture in
796 ms, with matching digests/counts, no foreign-key violations and no leftover
snapshot tables. This is a bounded local scale sample, not a production-size
history or a hosted migration receipt.

Read-only signing access checks found a valid local Developer ID Application
identity. The repository-level GitHub Actions secret list is empty; environment
secrets and Windows signing access are not yet established. Windows production
startup still needs its actual storage/binding qualification and production
composition. The main-owned factory guard and qualification-only accountless
wrapper now exist; a successful development test does not activate either
platform's production selector.

A bounded Windows review separated the qualification-only file replacement
primitive from credential writes, which already hold a per-capability native
mutex throughout their mutation callback. The normal concurrency contract is
cooperating processes in one interactive Windows session; the `Local` mutex
does not establish cross-session exclusion. A hostile same-user final-name swap
is not an achievable expected-file-identity guarantee of the current rename
API and is not a generic prerequisite for every production consumer. The
readiness flags remain false pending actual applicable composition, audit,
binding trust and native desktop tests; no Windows support claim is enabled.

Linux review found a production-entry bypass: valid stable metadata could start
credential, upload and updater composition despite the unqualified platform.
The entrypoint now refuses that selection before composing these services,
while preserving the existing development launch. Its entry-level regression
is included in the 445-test Electron pass. The OS-held Linux credential lease
and abandoned-operation refusal are now implemented and independently reviewed
at `8b616616`, with 108 foundation tests passing and two expected native-host
skips on macOS. [Run 34155547489](https://github.com/adamallcock/tibotattle/actions/runs/34155547489)
compiled the Ubuntu x64 addon but its loader rejected node-gyp's hardlinked
output before native recovery tests. Commit `d531d478` adds explicit single-link
staging without relaxing the loader contract; the manifest, loader and qualifier
share its fixed path. The staging regression uses an actual hard link and proves
identical bytes in a separate single-link file. Routine node-gyp rebuild removes
the old build tree before staging. Foundation tests pass 111 cases with two
expected native-host skips on macOS; the actual Ubuntu execution subsequently
passed in run 34157482667 as detailed below.
Commit `68bd5695` also requires a main-owned Linux native accountless factory,
keeps the companion credential channel separate, and rejects an existing or
unreadable legacy encrypted record before native access. Its focused runtime
and credential tests pass 45 cases. The production identity adapter remains
separate source work; the accountless backend is now implemented as recorded
below. The installed keytar
wrapper's synchronous libsecret calls supply no cancellation object; upstream
documents that [password lookup may block indefinitely](https://gnome.pages.gitlab.gnome.org/libsecret/func.password_lookup_sync.html).
Keytar is not selected for the new Linux accountless credential. The engineering
decision on 2026-09-07 is a separate owner-private XDG-state file for this
upload-only secret, with fd-pinned access, private ownership/modes, atomic
no-clobber publication, durable readback, exact deletion and an independent
mutation journal. It must never reuse a telemetry/provider secret or enter the
legacy four-capability FD4 map; only the existing main-owned FD3 bridge may
serve it to the companion. Existing ciphertext still requires recovery rather
than identity rotation. No production selector changes until native validation.

This choice follows the [accepted sharing decision](../decisions/2026-09-04-accountless-sharing-policy.md),
which requires protected state and identity continuity without prescribing a
Linux store. The selected filesystem threat boundary does not claim encryption
at rest or protection from same-user malware,
manual access or copied home backups. It remains available to an authorized
process while the screen is locked; it does not emulate a locked keyring.
Revocation remains server-authoritative, and local deletion cannot remove
copies from backups. Known failures before mutation may retry; an uncertain
write/delete must preserve recovery state. This engineering choice is distinct
from an explicit user statement selecting the storage mechanism. The legacy
Linux identity/credential production composition and physical Ubuntu 24.04/GNOME
qualification still remain separate work.

The fixed Linux accountless backend is now implemented at `06bd987c`, with
production selection still disabled. It stores only the new 32-byte upload
credential in an owner-private file, exposes no caller-selected path or generic
capability, and preserves the separate FD3/FD4 boundary. Independent source
review corrected a failed-cleanup dangling pointer, nonblocking refusal of
FIFO records, serialization of reads, and durable recovery after an invalid
record is observed. A read of an already-normal journal now verifies and
closes it without creating a new truncate/fsync crash window. The integrated
adapter/API/architecture checks pass 79 tests; the Linux foundation suite
passes 111 with two expected native-host skips on macOS. Actual Ubuntu x64
compilation and native fixed-record qualification pass in run `34162180263` at
`677c5e2b`. The retained receipt records synthetic installation-record tests and
no production credential access. The generic lease test uses actual process
termination; the accountless abandonment case injects a durable active marker,
so it does not establish a kill-during-write accountless test. These tests use
disposable synthetic credentials;
no production credential or runtime selector was changed.
All 453 Electron tests also pass with owned companion IPC available. The
restricted-sandbox run's three companion-startup failures remain retained;
no timeout or assertion was weakened.

The earlier source-only migration approval request is superseded by the user's
explicit request to complete every stage. Source implementation and disposable
synthetic migration/upload rehearsals are proceeding. Hosted activation and
migration, installed replacement and publication remain bound to the concrete
qualified candidate and exact target operation. Private Mac signing/notarization
is now approved as recorded above. An escalated, redacted Keychain probe confirms
a valid Developer ID Application identity; a sandboxed zero-identity result was
an environment limitation. Actual target desktop/update qualification remains
outstanding.

The public-sample decision remains pending explanation and confirmation.
Current social sign-in establishes continuity of a Google/Apple identity, not
a unique person or ownership of an OpenAI account. Accountless uploads are
currently private and excluded from public figures. The proposed common sample
would use contribution sources as its unit and retain suppression, bounded
influence, deduplication and revocation controls; it requires an explicit
versioned public-use policy and consistent eligibility across all aggregate
paths before activation. Controls must remain metric-specific: daily activity
currently publishes accepted totals without a per-day suppression threshold,
whereas weekly cohort snapshots apply maturity, suppression and clipping.
Do not silently clip all-token/API-equivalent activity totals when limiting
per-source influence on statistical estimates. An installation credential proves
continuity and authenticated retries, not a unique person or measurement truth;
independent reinstallations are not automatically cross-source deduplicated.

The earlier integrated `a3458668` source passed all 450 Electron tests, 111 Linux
foundation tests with two expected native-host skips, and architecture checks
(457 production files, 1,804 imports, no approved debt). The 55 focused
Linux/runtime/packaging tests also pass with the owned local companion IPC
available. The earlier restricted-environment failures remain in their separate
log; no assertion was weakened. That earlier four-target run is
[34157482667](https://github.com/adamallcock/tibotattle/actions/runs/34157482667),
completed successfully on all four targets with retained unexpired artifacts.
The Ubuntu qualifier runs the actual native SIGKILL/fresh-runtime/persisted-marker
recovery test and emits success only after that test subprocess exits zero. Its
receipt establishes cooperating-process exclusion in the same Linux network
namespace and durable abandonment detection; `productionSafe` remains false.
All four target archives/installers and their testing handoffs are also retained
in the private durable build directory. Source/version/target metadata and all
16 listed installer/handoff checksums were independently verified after download.
These remain unsigned development packages with hosted contributions and
updating disabled, not installed-production qualification.

The subsequent four-target run `34162180263` also completed successfully at
`677c5e2b`; all four target packages and handoffs are privately retained, with
their source/version/target identities, eight primary payload metadata entries
and all 16 listed checksums independently verified after download. Its Linux
native receipt adds `syntheticAccountlessInstallationRecordTested: true` while
retaining `productionSafe: false`. This expands native test evidence without
activating the backend or claiming physical desktop qualification.
Run `34163441097` subsequently passes all four targets at `ae8f5bb6`, including
the newly integrated Mac interruption/recovery tests. Its packages are separate
from the previously retained `677c5e2b` development packages and the sealed
`d5dc8025` signed Mac installers. Local recovery validation additionally passes
74 release workflow/evidence tests and the 20-test documentation preflight.

The combined source at `b20d0b21` merges native PR112 and Electron PR113 and adds
the Windows fixed accountless credential backend plus its Electron guard and
real FD3 storage smoke. All 478 Electron tests pass with owned companion IPC.
The new outer Windows runner verifies the package's source revision, EXE and
ASAR hashes and exact staged/archive closure before launching a disposable
profile. It tests synthetic create/read, a second child reading the retained
record, exact deletion and absence, then clean app quit. It sends no real
credential or upload request, exposes no run identifier or record bytes, and
does not claim a full app restart, installation or production readiness.
The existing four-target workflow now compiles and runs the native Windows
accountless tests and this packaged IPC journey, retaining its content-free
receipt even on failure. [Run 34166503438](https://github.com/adamallcock/tibotattle/actions/runs/34166503438)
at `48a234f2` passes the Windows native binding/record tests and package build,
but the packaged IPC journey fails before its first status reply with
`ELECTRON_WINDOWS_ACCOUNTLESS_SMOKE_SEND_FAILED`. The failed receipt is retained;
this does not qualify Windows runtime storage. The outer runner now records
only allowlisted IPC error classes, a fixed startup-failure marker and numeric
exit status to distinguish startup failure from channel failure on the retry.
It never retains arbitrary Electron/native stderr.

The same `48a234f2` source produced a fresh ARM development package with ASAR
`a82c0c4271e8303f80b70b77017c3e1a31de1a92b979afee263e36cbd2e5292a`.
Its identity-bound rendered smoke passes startup refresh, usage and Community,
sharing/settings persistence, tray save/preview/undo/defaults/reopen/relaunch,
and clean quit. Dashboard and tray screenshots were inspected. This is
disposable synthetic-profile evidence; uploads, signing and updating remain
disabled and the original `d5dc8025` user-test profile is preserved.

Combining the tray and Windows changes exposed a missing tray-preferences entry
in the independent packaging verifier. The reviewed file list and its separate
test fixture now include that module, matching the actual runtime closure.
The repaired package/runner suite passes 26 tests with two explicit optional
artifact/host exclusions; 78 release-trust checks, architecture and tool inventory
checks also pass. The failed closure check remains in its separate local log.

The subsequent Windows diagnostic run `34167184722` preserved the same startup
failure. The actual generator omitted the development binding provenance that
the app's qualification context requires. The repaired producer and loader
agree on a closed, explicitly unqualified provenance object. Run `34167627725`
then exposed the independent artifact verifier's older exact-key list; that
consumer is now repaired too. Both app-context and artifact-verifier tests
consume the actual generator output and reject missing, broadened or falsely
qualified provenance. The cross-boundary suite passes 82 tests with two optional
artifact exclusions. These repairs are source evidence until a fresh packaged
Windows smoke passes; prior failing runs remain preserved.

The fresh `48a234f2` Mac app is also retained in a durable frozen source tree,
with independently verified archive closure and the same ASAR hash above. A
new copied profile preserves the earlier profile and disables hosted sharing.
Its real-history qualification completed refresh, populated the product pages,
advanced the timer and quit cleanly, but active control-plane p95 measurements
of 261 ms and 305 ms fail the unchanged 250 ms limit. Those failures are retained.
The QA harness now distinguishes this completed latency-budget failure from
an unresponsive or incomplete run, and retains functional and clean-quit
receipts before returning failure. All 33 owning QA/profile tests pass. The
older 45-second, 180-sample `d5dc8025` result is not performance evidence for
this candidate. The default user launcher still selects that previously
qualified version while the new candidate's startup delay is investigated.

The source now includes the two-capability Linux Secret Service FD4 broker and
explicit export-identity/account-observation selectors. Main-owned conditional
mutations retain the native lease boundary, while the companion receives no
native binding or generic credential-store access. The three server consumers
share one transport; malformed configuration refuses fallback. Forty-three
focused broker/selector tests and the architecture gate pass (468 production
files, 1,834 imports, no approved debt). Packaging inventories include both new
broker modules. The integrated source also passes all 487 Electron tests, 329 local companion
checks, 78 release-trust checks and 20 documentation preflight checks. The local
companion suite requires permission to bind its disposable loopback servers;
the earlier restricted-environment `listen EPERM` failures are retained, and no
assertion was changed. Main-process native composition and actual Linux runtime
smoke remain the next gate; no production capability is enabled by these source
tests.

The Linux archive check exposed a concrete packaging omission: CI compiled the
credential mutex, but the app did not contain its binary or manifest. Linux
shell staging now requires that exact pair, validates the actual manifest
producer's closed claims against captured binary bytes, and records both files
in the ordinary runtime inventory. Both development and production packaging
place the pair physically beside Keytar outside ASAR. The loader resolves only
those fixed packaged paths. Independent archive checks reject missing, altered,
extra or falsely qualified inputs; other platforms cannot receive the Linux
pair. Focused packaging checks pass (53 passes, two optional artifact exclusions),
production configuration checks pass 14/14, and the subsequent verifier check
passes 20 with the same two exclusions. Documentation, architecture, 78 release
trust checks and 20 documentation preflight checks pass. These are package
contract checks; native ABI and isolated Secret Service execution remain separate.

Run [34169033358](https://github.com/adamallcock/tibotattle/actions/runs/34169033358)
at `ee930083` builds and verifies Windows packaging, but its packaged storage
smoke times out: the empty disposable profile waits at the normal first-run
dialog before installing status IPC. The runner now writes and reads back the
ordinary first-run acknowledgement using the exact verified staged native
binding and a protected store bound to its disposable user-data root. The app's
normal startup path is unchanged. This also exposed legacy qualification
predicates absent from the real binding. Consumers now require the producer's
actual four verified claims; production and path-walk claims remain false.
The owning regression composes the real manifest producer through the adapter,
qualification context, protected store and acknowledgement backend. The private
writer uses the containing profile root for TEMP; the launched environment keeps
its original separate temporary directory. Actual Windows execution is still
required to close this gate.

The measured Mac startup cause was a synchronous collector summary/projection:
two read-only database traversals took about 2.7 seconds without letting a timer
run. Collector projection now uses the same read-only worker on every platform,
with a closed protocol marker, cancellation and bounded fixed-error settlement.
The extracted reader preserves the previous calculation. Seventy owning tests
pass, including 80,000-record heartbeat/parity and unrelated-worker IPC isolation.
A bounded copied-history source probe at `998958e5` completes the collector in
557 ms with a 12 ms maximum heartbeat gap; the complete quick-style snapshot
takes 785 ms with a 100 ms maximum gap. Those are source-level observations,
not a packaged-app performance pass. The 250 ms app qualification limit remains
unchanged, and all previous failures and profiles are preserved.

Linux qualification now composes the main-owned native lease/backend with the
FD4 broker and a fixed two-capability synthetic storage child. Its smoke requires
an authenticated isolated-store context, but the outer harness must independently
prove disposable D-Bus/tmpfs containment before constructing that context. A
child that exits before READY now settles immediately instead of waiting the
shutdown timeout. No normal Linux production selector is enabled. Combined
source validation passes 495 Electron tests, 329 local companion tests, 29 focused
Windows/worker tests, 60 package checks with two optional artifact exclusions,
78 release-trust checks, and architecture validation. Explicit runtime and
independent verifier inventories include all new modules.

The packaged Linux smoke now independently binds the selected distribution,
executable, ASAR and physical native files to the staged source. Its outer process
proves the reviewed container marker and distinct owner-private tmpfs roots
before process enumeration or creation. Only then does it start a disposable
D-Bus session and run the packaged Electron executable in Node mode. The inner
process repeats the existing full isolation/daemon proof before constructing the
branded context and loading the fixed two-capability FD4 journey from ASAR.
The thin container preserves root ownership and immutable readable modes for
the exact copied app/staging trees; it admits no profiles or signing inputs.
The workflow runs with no network, no user directory bind mounts and a bounded,
content-free receipt retained on failure. Thirty-one harness/qualification tests
and 20 container/package/workflow checks pass. Actual container/native ABI,
credential execution and cleanup remain pending a fresh CI run; normal Linux
production selection is unchanged.

The `0f03c121` ARM app passes its synthetic rendered/relaunch smoke with ASAR
`2216a54ddf6315fcc52c4982542e12ffa5406ce4520c3842b92774054245a3db`.
Its first real-history attempt fails before performance sampling because the
test accepted an incomplete Usage DOM snapshot immediately. The harness now
waits for the existing full parity predicate within the original 30-second
timeout. All 34 owning profile/QA tests pass. A separate fresh retry profile and
provenance record bind the unchanged app to the reviewed `feac3e67` harness;
the original failed profile and receipt remain intact.

That retry passes the full real-history gate: all Usage/Community parity checks,
5/5 timer advancement, clean quit and 20/20 active responses for each endpoint.
Both health and refresh-status p95 are 1 ms against the unchanged 250 ms budget.
One active 524 ms outlier is retained; the separate 3,000 ms request ceiling is
also unchanged. Two warm-up samples per endpoint have maxima of 1 and 2 ms.
The identity-bound receipt has SHA-256
`2593b1bdaf0df74e94d6907ed98e00bcabce050677ef77354d322794abac0f9f`.
This qualifies the copied-profile ARM tester journey, not a production install
or the other operating systems.

The Windows storage failure in `0f03c121` was independently traced to the same
sibling-profile mismatch inside the actual accountless qualification factory.
It now verifies every fixed launcher profile path before deriving a private
context rooted at that profile. The launched app environment is unchanged, and
malformed or unrelated paths are refused. Seventy focused checks pass with one
explicit non-Windows host exclusion; that actual-launcher producer test runs in
the existing Windows CI smoke suite. The next native run must verify the repair.

The larger [desktop convergence plan](2026-09-04-desktop-convergence.md) and
[contribution integration plan](2026-09-04-accountless-integration-and-responsiveness.md)
retain the detailed design history. This document coordinates the remaining
work and exit criteria for the current candidate.

## 2026-09-07 current native evidence and launcher handoff

- Windows `a17d235f`: the retained package manifest, storage smoke and independent
  hash proof are under `.release-build/electron-readiness-20260907/windows-a17d235f-evidence/`
  in the original project. The synthetic smoke passes, confirms its owned process
  stopped, and explicitly records `fullAppRestart: false`. The executable and
  ASAR hashes match the native CI package; no production credential was used.
- Mac `0f03c121`: the default and versioned launcher are byte-identical, private
  executable files; the previous d5 launcher has a separate verified backup.
  The transition receipt confirms the copied profile, no hosted origin and
  disabled contributions. The original failed Usage-readiness receipt remains
  alongside the fresh retry receipt; polling now waits for the same full
  readiness predicate within the original 30-second budget.
- Linux `a17d235f`: the packaged session failure is retained. New diagnostics
  distinguish runtime identity, artifact identity, isolation, module load and
  native round-trip failures. Only a fixed vocabulary can leave the child. A
  genuine post-cleanup failure retains authenticated cleanup proof; fabricated
  error properties cannot assert cleanup. The receipt now calls the success
  fact `packagedElectronExecutionVerified`, avoiding an implication that a
  failed child was never launched.
- Source readiness remains separate: Windows/Linux stable composition gates
  are still closed. A read-only review found the Windows global gate also
  requires legacy sign-in storage not used by the fixed accountless credential.
  Any simplification must close those reachable legacy routes and preserve
  observed-account linkage, protected settings, authenticated native bindings
  and recovery; changing readiness booleans is not sufficient.

## 2026-09-07 public-sample decision and verified identity limits

The owner requested an explanation before deciding whether accountless
measurements should join the public sample. Eligibility remains unchanged.
Social sign-in proves control of that login; neither it nor an installation
credential proves one unique person, a provider account, or measurement truth.
The proposed label is **contribution sources**, with metric-specific source
influence limits for allowance estimates and existing suppression/revocation.
Those limits must not silently clip accepted token and API-equivalent totals.

The current replay guarantee is narrower than global deduplication. An
accountless installation retains its backend secret and
`accountless-device-binding-v1.json`; the retained unified index/device salt
also preserves event anchors. Retries and lease renewal keep that graph and
accepted history. The legacy `contribution-device-binding-v1.json` is a different
binding and is not a substitute. A clean reinstall without retained state or a
second device creates another source. Event and quota anchors include local
salt/source scope, and server uniqueness is scoped to participant/device.
Two independent installations reading the same cloud-synced history therefore
can both submit it. The shared session UUID alone is not an authenticated
identity and currently does not merge those records across sources.

Before public admission, choose and test an overlapping-history policy as well
as the source label. A protected profile restore can preserve one installation's
continuity; it does not solve separately-created sources. Comparing content-free
session/occurrence evidence at aggregation time is a possible follow-up design,
not an implemented guarantee, and must preserve conflicting/partial evidence
and avoid merging separate provider accounts. Enrollment/upload budgets and
revocation address abuse independently of this good-faith duplicate case.

The accountless Electron companion will close legacy sign-in, pairing and
manual-preparation entrypoints while keeping observed-account secrets and
usage/quota linkage. No-social composition must not make historical markers
unattributed merely to pass a platform readiness gate.
