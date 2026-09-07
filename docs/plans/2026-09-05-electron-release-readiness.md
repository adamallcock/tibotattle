---
title: Electron readiness after the native 0.1.18 release
date: 2026-09-05
type: plan
status: in-progress
---

# Objective and current position

Updated 2026-09-07. Deliver one primary Electron application for Apple Silicon
Mac, Intel Mac, Windows x64 and Linux x64, with one shared product and release
process. Provider support stays inside that app. The accepted
[sharing policy](../decisions/2026-09-04-accountless-sharing-policy.md) remains
fresh-install automatic sharing, persistent opt-out, no sign-in, and three
visible notices before activation for existing undecided installations.

The latest four-target successful development build is
`d5dc802575b6b6a0ad0faee26c05fd50778b77e1`. Its unsigned packages passed
[CI run 34151603489](https://github.com/adamallcock/tibotattle/actions/runs/34151603489),
including native Windows protected-child binding tests. It includes upstream
changes through `11276bb84793b273276a3026029d3a8efb99467e` and the new Mac
credential-broker, renewable accountless upload leases, closed Mac update
rehearsal and production-disclosure source. The inspected local Mac
candidate at that same `d5dc8025` revision runs against a private
copied profile with hosted contributions disabled and repairs the accounting
compatibility defect found in the earlier package. Both include the latest
shared model-attribution and retained-view fixes.
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
sharing still off. Actual tray interaction still needs its final check because the native
menu-bar automation surface is unavailable. The earlier production updater and
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
durable launcher. Sharing remained off after restart. The launcher now selects
this package; the previous `aead5d00` package/profile/launcher are preserved.
All 180 active-refresh samples in 45 seconds passed: health and status p95 were
1 ms, maxima 28 ms, with no failures and the unchanged 250 ms p95 budget.
Settings remained interactive during the same refresh. Parent task URLs are
present; the external Codex navigation postcondition remains unqualified.

# Workstreams and completion evidence

| Workstream | Remaining work | Required demonstration |
| --- | --- | --- |
| 1. Product and background parity | Finish a fixed page/action matrix against native 0.1.18: overview, allowance, trends, usage/cost/cache, community, settings/about and tray. Compare accounting, quota, refresh, retry/cancel, persistence and relevant hosted/admin behavior on the same evidence. Record intentional visual differences. | Exact packaged candidate passes journeys, with no unexplained data/behavior differences or unresolved blocking interaction defects. Cold, active-refresh and recovery behavior remain usable. |
| 2. Native Mac handover | Implement production state/credential migration, stable app identity, exclusive writer ownership and old login-item handover. Preserve history, identity salt, settings and sharing choices; test interrupted migration and recovery. | Supported native predecessor upgrades to signed Electron without loss, duplicate writers/uploads or reset choices; restart and interrupted migration recover. Cover both Mac architectures. A copied development profile does not satisfy this gate. |
| 3. Accountless contributions | Implement the reviewed ownership/schema bridge; connect enrollment, private credentials, authorization and the existing encrypted upload pipeline. Preserve old social clients. Complete disclosure/reminder delivery and production activation controls. | Fresh automatic sharing; three actual notices for existing undecided installs; persistent explicit opt-out; usage/quota linkage across provider/account changes; deduplicated lost-response retries; bounded abuse; revocation/expiry and no unexpected public aggregate admission. Test first against disposable synthetic Worker databases, then an authorized controlled hosted rehearsal. |
| 4. Production packaging and updates | Turn the four-target development pipeline into one production pipeline: final app identity, signing/trust, compatible pinned updater, architecture-correct feeds, protected release metadata and safe interrupted-update handling. | A signed/trusted Electron candidate updates to a subsequent signed/trusted Electron candidate on each claimed target. Installers, update payloads, checksums and support/download metadata identify the same frozen source/version. |
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
   visible, and the original installation is preserved. This is the next
   short completion target; it can precede hosted contribution activation.
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
startup still needs its actual storage/binding qualification and entry wiring;
its development CI receipts cannot satisfy that gate.

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
is included in the 445-test Electron pass. Linux still needs an OS-held
credential mutation lease, abandoned-operation recovery and the production
identity adapter. Local containers are ARM or emulated x64 at older source
revisions, so neither qualifies the proposed Ubuntu 24.04/GNOME target.

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
paths before activation.

The larger [desktop convergence plan](2026-09-04-desktop-convergence.md) and
[contribution integration plan](2026-09-04-accountless-integration-and-responsiveness.md)
retain the detailed design history. This document coordinates the remaining
work and exit criteria for the current candidate.
