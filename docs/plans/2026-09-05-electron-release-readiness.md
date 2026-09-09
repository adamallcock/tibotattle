---
title: Electron readiness after the native 0.1.18 release
date: 2026-09-05
type: plan
status: in-progress
---

# Objective and current position

Updated 2026-09-09. Deliver one primary Electron application for Apple Silicon
Mac, Intel Mac, Windows x64 and Linux x64, with one shared product and release
process. Provider support stays inside that app. The accepted
[sharing policy](../decisions/2026-09-04-accountless-sharing-policy.md) remains
fresh-install automatic sharing, persistent opt-out, no sign-in, and three
visible notices before activation for existing undecided installations.

Current checkpoint, 2026-09-09 (supersedes the historical entries below):


Latest continuation, 2026-09-09:

- Live `main` was checked at `77317f9f` (PR #114) and is an ancestor of both
  the installed Mac source `7293828a` and current integration source. There are
  no unseen main-branch commits to port at this observation; ancestry alone
  does not replace feature/runtime acceptance.

- Source `c0c98040` now includes the stale tray percentage correction and
  the signed automatic-contribution execution workflow. Its Windows normal
  journey passed real synthetic ingestion (one event, 120 tokens), retained
  totals and zero duplicate insertion after restart. The NSIS lifecycle passed
  both native Credential Manager acknowledgements across top-level app launches.
  Both Mac package targets and Windows packaging also passed in
  [34372667438](https://github.com/adamallcock/tibotattle/actions/runs/34372667438).
  These are synthetic native checks, not real user-credential evidence.
- **Genuine Linux AppImage replacement passed** on `fa712b23` in
  [34377227344](https://github.com/adamallcock/tibotattle/actions/runs/34377227344):
  normal automatic discovery/download, actual Install-button action, exact next
  image replacement, automatic restart with matching ASAR and healthy companion,
  and retained refresh settings/opt-out. Normal startup and native credential
  checks also passed. This uses isolated local HTTPS at the production hostname
  and extraction mode; ordinary FUSE/desktop behavior and notification banners
  remain user-test coverage. No public Linux feed was changed.
- The isolated staging Mac app from `c0c98040`, build `2026090917`, is Developer
  ID signed, notarized and stapled. Signature, Gatekeeper and immutable transport
  hashes are verified. It is bound to the disposable runner account and staging
  origin, with updater disabled. This is not a replacement for installed `.16`.
  The first hosted intake hit HTTP403 from Python's downloader; the corrected
  system downloader passes exact transport verification. The second execution
  exposed rejection of Node's native environment/account object prototypes in
  the profile helper, before app launch. Source `ed00bdae` normalizes only those
  defaults, with real native-object regression tests. The third signed run is
  [34375748352](https://github.com/adamallcock/tibotattle/actions/runs/34375748352),
  using reviewed runner `7293828a` and unchanged signed app `c0c98040`.
  **Signed execution passed:** automatic accepted upload, unchanged credential
  binding after authenticated restart, persistent opt-out after another restart,
  and owned process cleanup all passed. The profile explicitly seeds the policy's
  default-on state; untouched first-install classification and migration-notice
  delivery are not asserted by this test. Staging was restored to revision 14,
  contained with all collection flags off and accountless runtime modes disabled.
  Public publication stayed disabled throughout. A bounded source/test audit also
  found no missing fresh-classification or three-visible-notice integration; those
  remain focused component/composition evidence rather than a signed seven-day run.
  A separate hosted native-UI feasibility probe passed in `34385565580` without
  reading app data. The signed untouched first-launch then passed in
  [34386204318](https://github.com/adamallcock/tibotattle/actions/runs/34386204318),
  runner `e33c6b37`, unchanged signed app `c0c98040`: no seeded preference or
  acknowledgement, actual native Continue/login-checkbox interaction, app-created
  acknowledgement and `default_on` observed through normal Settings, with owned
  processes stopped. This single-launch proof correctly claims no restart/upload
  of its own. No staging activation or new signing was required.
- Normal Mac `.17`/`.18` candidates are staged from frozen source `7293828a`
  for both architectures, builds `2026090919`/`2026090920`. All four apps and
  disk images are signed, notarized and stapled; final archive, updater metadata,
  architecture and mounted-image verification passed. They include the latest
  dashboard, history and tray fixes;
  `.17` test-feed publication completed for both architectures with exact `.16`
  predecessor checks and R2 readback. Receipt `initial-publication-20260909-v2.json`
  is retained; independent public HTTPS verification of both manifests and all
  four current ZIP/DMG bodies passed exact hashes, sizes and MIME types. The
  earlier pre-write local-tool failure is retained as v1.
  **Installed `.17` now passes normal launch and dashboard rendering.** R13
  retained a fresh stopped `.16` app/profile snapshot, then manually exchanged
  only the signed app bundle while preserving current profile, salt, opt-out
  and the original `.16` app. General settings and explicit sharing-off text
  were observed in `.17`; About shows `content-03c983798dec`. The attempted
  `.16`→`.17` updater edge was correctly refused by `.16`'s immutable `.15`/`.16`
  test-pair restriction. No unsupported update success is claimed. The valid
  **`.17`→`.18` automatic update now passed.** Same-scope Cloudflare renewal
  was explicitly approved and completed after browser verification. The `.18`
  test-feed advance completed for both architectures with exact predecessor
  and R2 readback; independent public HTTPS verification passed both manifests
  and all four archive bodies. The ordinary Check/Download/Install and Restart
  controls replaced the installed app and restarted it automatically. R13
  verified the `.18` signature/ASAR/build, old PIDs absent and new app already
  running before GUI inspection, plus preserved salt and opt-out. The dashboard
  rendered; General settings and sharing-off text were retained; About shows
  `content-afb24c32c23d`. The normal startup refresh subsequently completed:
  the dashboard reports FRESH, local metadata readable and private state writable.
  R13 retains `one-click-17-to-18-refresh-complete.json` separately from the
  earlier running observation. Earlier expired-login/pre-write and
  public-verifier input-shape failures are retained. The stable feed is unchanged.
- Windows run [34392192849](https://github.com/adamallcock/tibotattle/actions/runs/34392192849)
  at `6dbd7eae` now identifies the actual blocker: the patched builder rejects
  its signing-operation ledger evidence root. Authenticated owner-only encrypted
  diagnostics isolate this error. A separate Windows Authenticode probe of the
  retained final EXE reports valid signature, expected publisher and timestamp.
  The build still fails and the installed journey did not run; this narrow
  signature result is not a finalizer or signed-installed pass. Source review
  found the successful path never creates the required evidence
  directory. The ledger also precedes universal NSIS finalization; the current
  non-universal configuration had already signed its installer. Both defects
  are corrected in source without relaxing path or signature validation. The direct
  evidence-directory fix is committed as `09436501`; 14 focused and 78 release-
  trust tests pass. Signed hosted run
  [34394658343](https://github.com/adamallcock/tibotattle/actions/runs/34394658343)
  passed installer signing, final installer/evidence verification, actual install,
  installed signed-closure verification, uninstall and cleanup on that exact
  source, build `2026090931`. It stopped before normal app launch because our
  updater verifier required an optional size field. Both retained SHA-512 fields
  match the final EXE; the non-differential NSIS manifest legitimately omits size.
  Commit `57165992` corrects this with 13 tests, preserving both mandatory hash
  checks and rejecting any incorrect supplied size. Exact-source run
  [34396583241](https://github.com/adamallcock/tibotattle/actions/runs/34396583241),
  build `2026090932`, is now executing the corrected flow. The broader lifecycle correction is
  committed separately as `72f357e2`. Five tests against a fresh isolated
  installation of the patched builder pass, including once-only emission after
  deferred final signing and no emission after failure/cancellation. It was not
  included in the first signed run and is included in the `57165992` retry.
- Windows native modules have passed Azure signing, strict Authenticode
  verification and integrity rebinding. The latest run has passed final
  installer/evidence verification and installation/cleanup. Normal signed app
  startup remains open until the metadata-corrected retry passes.
  Earlier failures are retained in runs
  `34373775022`, `34374830275`, `34376745223`, `34378235956`, `34379698420`
  and `34382343677`; these exposed native-path, read-only-file, PowerShell
  invocation and source-check output defects, now repaired.
  Run `34383208839` passed source verification but failed the Azure CLI probe.
  Source `bd937eef` repairs its Windows `.cmd` launch through a fixed system
  interpreter, with 23 focused tests and release-policy/trust checks passing.
  Run `34384799570` then reached Azure but reported missing login context.
  The Pro consultation independently identified Windows runner provisioning
  of `AZURE_CONFIG_DIR` outside the user profile. Source `64cda924` preserves
  only that verified fixed directory. Run `34385603744` rejected an abbreviated
  source input before staging or signing; corrected exact-source run
  [34385889388](https://github.com/adamallcock/tibotattle/actions/runs/34385889388)
  passed native signing, rebinding and Azure authentication on `88156c30`,
  build `2026090928`, then failed inside electron-builder. The old finalizer
  discarded its useful output, so a bounded diagnostic and actual signing-host
  preparation check were added before the later runs. Its retained installer
  has a certificate table, but that is not signature validity or installed-runtime
  evidence. Existing protected-environment approval was used without rule changes.
  Exact-source retry [34389121508](https://github.com/adamallcock/tibotattle/actions/runs/34389121508)
  passed the actual builder signing host/module, native signing and rebinding
  on `2be8b282`, build `2026090929`, then failed inside the installer builder.
  The bounded diagnostic remained insufficient to identify the cause. The subsequent
  encrypted owner-only capture isolated the failure as recorded above;
  that historical run claims no finalizer or signed-installed success.
  Source `ac50a1d9` also adds the approved TiboTattle ICO to the Windows installer
  configuration; seven decoded frames and the actual builder converter passed.

Production activation preparation: [the exact proposal](2026-09-09-production-accountless-activation-proposal.md)
now separates read-only remote intake, migration rehearsal, deployment,
private collection canary and public-sample admission. Production migration
metadata confirms only primary migrations 0057–0059 are pending; the populated
local rehearsal passed with 100,000 synthetic records in each telemetry table.
Required secret names are present, live accountless modes remain disabled, and
both D1 Time Travel bookmarks were retrieved read-only. These are recovery
inputs, not a tested production restore. A bounded ordinary signed-app canary
wrapper and dispatch-only workflow are prepared. Hosted plan-only verification
passed in [34391083322](https://github.com/adamallcock/tibotattle/actions/runs/34391083322),
runner `a76c11ff`, checking the exact normal signed `.18` artifact without
launch/upload. Production metadata subsequently reported a 5,328,384,000-byte
primary database, about 35.2 times the local fixture. The migration scale and
provider execution/temporary-space limits require investigation before approval;
the small rehearsal does not establish production admission. A subsequent tiny
synthetic staging file-import test passed late-failure rollback, successful
linked-row/schema restoration and exact owned-object cleanup. Its three rows
prove import transaction semantics only, not the full migration or resource scale.
The first approved exact-migration test stopped at 0057 with its synthetic rows
intact. A documented read-only import poll confirmed no current import, permitting
verified cleanup and recreation of the same approved disposable names. The
repeat adds bounded owner-private failure capture (`26974199`); the initial
unsuccessful attempt and recovery evidence remain preserved. No production
operation occurred.
Updated public privacy,
Docs and translated homepage copy are prepared and locally verified, not deployed.
Production accountless modes remain disabled in source.

## Earlier checkpoints (historical; latest continuation above takes precedence)

- User acceptance update: the user confirms Mac tray dismissal works and accepts
  physical Intel acceptance as an assumption for this cutover. Signing is
  authorized on both Mac and Windows. Do not describe assumed Intel testing as
  measured hardware evidence. Current source `46a5fad7` passed all six jobs in
  [34363070167](https://github.com/adamallcock/tibotattle/actions/runs/34363070167).
- Release scope is frozen to the remaining delivery tracks: latest signed Mac
  candidate and signed staging contributions; Windows credential/ingestion and
  signing integration; genuine Linux AppImage replacement. Tray quota retention
  is a correctness fix: unexpired last-known readings remain visibly stale,
  while notification authority still requires fresh evidence.

- Source `2bb58b5c02bf6e7ba4ab6ce69e5c201e44054f9f` passed all six
  jobs in [34356903351](https://github.com/adamallcock/tibotattle/actions/runs/34356903351):
  both Mac packages, Windows and Linux packages, Windows normal startup, and
  Windows NSIS installation/restart/uninstall. The independent
  [Linux run](https://github.com/adamallcock/tibotattle/actions/runs/34356902549)
  also passed packaged Secret Service, normal startup, and the pinned updater
  adapter exercise. The adapter exercise uses synthetic executables and a
  disposable profile; it does not establish real AppImage replacement or native
  notification display.
- Installed Mac test version `.16` remains available for user testing. It is
  based on `dcf2d6ca`; subsequent source changes are not yet installed there.
- The temporary integration checkout was no longer present when work resumed.
  Committed source was restored at the exact `2bb58b5c` revision into a durable
  ignored project worktree. Uncommitted edits from the missing checkout are not
  counted as delivered and are being reconstructed where still required.
- Current parallel tasks: compact overhead/model copy and model icons; investigate
  all-history coverage, observation labels, detail-list limits and the community
  link; complete Windows post-sign native-manifest rebinding. Cosmetic requests
  do not trigger another broad test run. Functional fixes receive focused checks.
- Dashboard copy/icons, truthful capped-list captions, correct classified chart
  hit targets, and fixed desktop community navigation are committed as `18079fd3`.
  Focused UI/localization/assets checks passed; isolated rendered previews at
  1100, 900 and 540 pixels showed no card overflow. The installed `.16` is unchanged.
- Full-history calibration now streams the complete indexed corpus in bounded
  reset batches rather than discarding rows beyond the global 750,000 ceiling.
  An isolated real-index copy retained 829,532 admitted events, recovered Pro
  fits back to May 31, and completed in 42.6 seconds under the unchanged RSS guard.
  Exact usage metadata occupied 25.34 MB; peak process RSS was 1.626 GB, a separate
  measurement. All 80 owning cache tests and 30 resource/shell checks passed.
- Windows native-integrity rebinding has 14 focused passing tests and an
  independent source review. It preserves exact candidate/inventory bindings
  and required qualification; signature algorithms, final installer verification
  and Windows power-loss durability remain unqualified. A complete pre-sign
  journal is required for interrupted metadata-write recovery.
- Tray source `eb92b7d4` reserves hover readout space, uses a compact Customize
  button between Open and Refresh, and uses a focusable Mac window for the
  existing blur-dismissal behavior. The read-only real-data projection now
  reports 29 complete days and only the current day partial for the 30-day view;
  incomplete typed-tool history no longer contaminates independently verified
  token coverage. All 55 focused tray tests passed. Native outside-click and
  tray-toggle event ordering were subsequently accepted by the user above.
- The earlier local-only Windows signing limitation is superseded by the
  protected remote signing workflow above; final signed runtime evidence remains
  separate from configuration and dispatch.

Latest test-feed and platform continuation:

- Desktop integration is now being completed as independent engineering and
  user-acceptance tracks. Windows notification identity is implemented: verify
  the installed Start Menu shortcut's executable and AppUserModelID before
  configuring Electron's fixed toast activator. Both delivery construction
  paths use that verified result, including a language change. Development or
  missing/mismatched shortcut identities still refuse delivery.
- Settings > Notifications now has **Send test notification**. It accepts no
  renderer-supplied content, is restricted to the live Settings frame, uses the
  same main-process delivery adapter as quota alerts, and changes neither alert
  preferences nor quota history/deduplication. It reports a request, not proof
  that the operating system displayed a banner. Repeated requests are bounded.
  The full web suite passed 658 tests; 128 focused contract/controller/delivery,
  preload and localization tests passed. A synthetic rendered interaction at
  1000px and 540px widths confirmed the request and preserved alerts off, with
  no horizontal overflow. The static preview's sole missing resource was the
  optional favicon; there were no application exceptions.
- Remaining native banner/tray appearance and notification-center behavior are
  user acceptance checks, not reasons to stop implementation or packaging.
  Automatic-update correctness remains an executable engineering check: actual
  current-to-next replacement, restart, and settings/opt-out preservation.
  The shared updater checks on startup and every four hours, supports automatic
  downloading, and installs through **Install and Restart**.
- Windows signing integration and native Linux AppImage updater qualification
  are in progress in parallel. No Windows signer is provisioned in the current
  environment. Existing unsigned development artifacts remain development
  artifacts; Linux's AppImage distribution does not require adding a new
  detached-signing authority merely to complete its selected update path.
- Latest pre-change source `bd60e686` passed both Mac packages, Linux package/
  runtime, and Windows package/normal-app jobs in run `34348058918`, but its
  Windows NSIS installer did not settle within 180 seconds before first launch.
  The unchanged-source retry subsequently passed installation, two launches,
  uninstall and cleanup with the same installer digest. Both the first failure
  and retry receipts are preserved; the timeout was not loosened.
- Follow-up `.15`/`.16` candidates from frozen runtime `dcf2d6ca` are now
  signed, notarized, stapled and finalized for both Mac architectures. All 24
  retained files and four ZIP-contained ASARs were independently checked;
  `signed-handover-dcf2d6ca/retention-verification.json` has SHA-256
  `3c4a39e9a98e02a060fcadbc04f48a28a2d37ffe4e1ece5036a896ec08255f6b`.
- R12 preserved a fresh stopped `.14` app/profile snapshot and the moved original,
  installed signed `.15`, and verified exact archived ASAR, signature, unchanged
  installation salt and scheduler preference. The ordinary app launched, About
  shows `.15` / `content-2d027b25648a`, General settings persist, and Data & privacy
  explicitly shows sharing off with the previous choice preserved. No unexpected
  credential prompt was observed. **The one-click `.15` to `.16` update passed:**
  normal About discovery/download and Install and Restart replaced the app and
  relaunched it without a manual Quit or launch. Installed `.16` ASAR matches
  the signed ZIP, native signature/Gatekeeper checks pass, all observed old
  process IDs are absent and the exact new main binary is running. Installation
  salt, scheduler opt-out and settings remain unchanged; About identifies `.16`
  / `content-10b0c4144ac8` and the dashboard returns FRESH. Process/trust and GUI
  receipts are retained under `mac-native-event-installed-rehearsal-dcf2d6ca-r12`.
- Both `.15` initial and `.16` advance feed publications completed with R2
  readbacks. Independent public HTTPS verification matched all eight archives
  and both `.16` manifests by size, MIME type and SHA-256. Exact proposal
  `b28cbdd870744f0701d364b9b46db1b48cdaca8e462e70137710501b8ff9e587`
  and new receipts are retained under `mac-updater-publication-proposal-dcf2d6ca`.
  Stable feed paths and historical immutable archives were not modified.
- Reviewed tooling and platform evidence `a6bff54e` passed all six jobs in
  [34339617379](https://github.com/adamallcock/tibotattle/actions/runs/34339617379),
  along with contract, documentation, release-trust and dependency workflows.
  Windows/Linux automated candidate qualification is complete; production trust,
  upgrades and desktop integration remain unqualified.
- Approved corrected publication completed: all eight `.13`/`.14` Mac ZIP/DMGs
  and both `.14` test manifests were verified in R2, then independently streamed
  through public HTTPS and matched against expected size, MIME type and SHA-256.
  Private publication and public-readback receipts are retained under
  `mac-updater-publication-proposal-9be7da8d`. Stable feeds remain unchanged.
- R11 independently backed up the stopped `.13` app and complete profile. Normal
  About-page discovery and download of `.14` passed. **Install and Restart did
  not terminate `.13`.** A normal menu Quit released ShipIt; the updater then
  installed `.14` and relaunched it automatically. The installed ASAR matches
  the signed `.14` ZIP, signature/Gatekeeper checks pass, installation salt and
  scheduler opt-out are unchanged, About identifies `.14` /
  `content-6c9e5f12ea46`, and refresh completed FRESH. Both failure and manual-Quit
  recovery receipts are retained under `mac-updater-installed-rehearsal-9be7da8d-r11`.
  This closes archive replacement and relaunch, not the one-click update gate.
- The R11 update failure was native event ordering: Electron emits
  `autoUpdater.before-quit-for-update` before window closes, and `app.before-quit`
  afterward. Source now forwards the earlier native signal into prepared
  lifecycle shutdown. Recovery/dashboard/Settings and production-composition
  regression coverage passes; 73 focused tests pass. A new signed sender had to
  prove the corrected one-click path; R12 above now supplies that proof for Apple Silicon.
- All six CI jobs for `fb19164f` passed in run
  [34335037428](https://github.com/adamallcock/tibotattle/actions/runs/34335037428).
  Linux includes disposable Secret Service and normal packaged runtime checks;
  Windows includes normal UI behavior and NSIS installation/two launches/uninstall.
- Linux follow-on `5c2724cb` adds a real cold process restart with one retained
  disposable profile: change refresh interval and save opt-out through the
  ordinary bridge, cleanly stop, relaunch, then verify both persisted choices.
  `bbbddb4a` preserves a specific persistence failure code through the runner.
  Existing operation deadlines remain unchanged; only the total session budget
  grows to cover the additional launch. The real new journey passed on
  `dcf2d6ca` in [34337369739](https://github.com/adamallcock/tibotattle/actions/runs/34337369739),
  as did all other five jobs. Linux receipt SHA-256:
  `437665f84ef4aee27dbf2ed1e618156fdd3717a779c1a3a65a140530f9eef2b1`.
- Windows follow-on `b0c1ddf2` records synthetic account-observation credential
  reads across two top-level launches without claiming retained application
  credentials. Full descendant ownership still needs a launch-before-resume
  Windows Job Object boundary; existing snapshot checks do not prove that.
  Windows signing and genuine desktop integration remain separate gates.
  The new Windows NSIS receipt passed on `dcf2d6ca` and explicitly confirms
  both synthetic credential acknowledgements; receipt SHA-256:
  `517af6a07fba1ebe6af8376b0fa72513ace07089a4f966c1b9d25276f77cbc86`.
  The separate normal UI/restart/opt-out receipt has SHA-256:
  `3799ad1963a5ce1db3b629100f44ae2ce353322918c1e1c0f2dfa6fc4a0835c4`.
- Both Windows and Linux development distributions were downloaded and checked
  against the exact packaging manifests, including installer/archive bytes,
  launchers, main executables and ASARs. A private test handoff under
  `platform-test-installers-dcf2d6ca` explains the retained 0.1.18 filename,
  exact newer source revision, launchers, isolated profiles and unavailable
  hosted uploads. The Windows installer hash matches the successful NSIS
  receipt. The Linux normal-runtime receipt belongs to a separately prepared
  candidate and is not substituted for physical AppImage lifecycle evidence.

The earlier `.13` installation and pending-feed checkpoint below is retained as
stage history; this continuation supersedes its installed-version/publication
status. Platform development evidence does not establish public release support.

Latest continuation checkpoint (frozen candidate and installed signed Mac source `9be7da8d`; updater tooling `8a70e38c`):

- **The frozen source now passes all six development CI jobs.** Run
  [34328830735](https://github.com/adamallcock/tibotattle/actions/runs/34328830735)
  passed both Mac package targets, Linux packaging/runtime, Windows packaging,
  the Windows normal dashboard/refresh/Settings/opt-out journey, and the Windows
  NSIS installed restart/uninstall lifecycle. Exact content-free receipts are
  retained privately under `windows-normal-9be7da8d`, `linux-normal-9be7da8d`
  and `windows-nsis-9be7da8d`. These receipts explicitly remain candidate-only;
  Windows signing, persistent application-credential continuity and full owned
  descendant cleanup are not established by the NSIS receipt.
- **The complete local Worker gate passes on the same source.** All 77 test
  files / 989 tests passed, followed by production and staging dry deploys.
  A missing generated catalog was resolved through the prescribed public-site
  builder. Root compared all 17 public source-file hashes against the frozen
  commit and verified identical source/staged manifests. The local build used
  unavailable-installer assets; it makes no live site or installer claim. No
  remote migration, deployment, binding or admission-control change occurred.
- **All four corrected private Mac artifacts are finalized.** `.13` and `.14`
  for arm64 and x64 are signed, notarized, stapled and independently hash-checked
  under `signed-handover-9be7da8d`. Root verified all four ZIPs have no
  owner-read-only regular files and both native modules use 0755. Signed `.13`
  companion startup, loopback health and clean exit pass natively on arm64 and
  on x64 under Rosetta; the latter is not physical Intel GUI proof.
- **Corrected `.13` is installed and usable.** R10 preserved `.11`, both native
  and Electron state snapshots, and the completed migration journal before
  replacement. All five dashboard pages and five Settings tabs render; About
  identifies `.13` / `content-7868f47147bb` and its alignment is visually checked.
  The first refresh reached FRESH. Allowance range changes/restoration, Trends
  cost expansion, cache disclosure/pagination, Settings-to-Community navigation,
  and tray-cache preview toggle/undo work. Normal quit removes the installed
  bundle's processes; restart renders the dashboard and preserves opt-out. The
  actual scheduler preference (`desktop-settings/accountless-sharing-v1.json`)
  and installation salt match the pre-install snapshot; the legacy retirement
  record is checked separately. Start-at-login remains off. No unexpected
  Keychain prompt was observed. R10 content-free receipts retain these results.
- During `.13` active refresh, both endpoints passed 180/180 samples over
  45 seconds: health p95 1 ms / maximum 19 ms; refresh status p95 1 ms / maximum
  9 ms; zero failures. The original 250 ms p95 and 3,000 ms individual limits
  are unchanged. This is an observed active-companion bound, not renderer or
  all-cold-start latency qualification. Actual tray-popup selection remains
  unavailable through the UI tool; the Settings preview is not substituted.
- The corrected `.13` → `.14` installed updater rehearsal is prepared but has
  not run. Its exact eight-object/two-feed proposal has SHA-256
  `c712e0b39378fca24a0cd78c998e816965e2d1315c31158b702ab7248b180205`;
  all three local-only stages pass. New explicit publication approval is pending
  and supersedes the earlier `.12` → `.11` rollback request. No corrected feed
  or artifact is published; the isolated feed still points to `.12`.
- The rehearsal publisher now supports the exact corrected source and `.13` /
  `.14` pair while preserving the historical `.11` / `.12` rollback path.
  Corrected initial publication binds a completed historical receipt and exact
  predecessor bytes; a mixed-target retry accepts already-verified `.13` without
  rewriting it. Eight focused tests, the real historical rollback dry run and
  20 preflight tests pass. No corrected artifact or feed has been published.

- Signed staging consumer review narrowed this delivery to read-only artifact
  intake and canonical fail-closed profile preparation. The prototype launch
  mode was removed after review found missing process ownership, timeout and
  debugger-target guarantees. Execution flags are refused; partial preparation
  is preserved and subsequent reuse refused. A separately reviewed launch
  consumer and real signed scheduler/enrollment/upload evidence remain open.
  Independent review and root verification resolved the intermediate-symlink
  preseed gap; 15 focused consumer/inventory tests and 20 preflight tests pass,
  with architecture and inventory checks clean.
  See the [draft staging rehearsal boundary](../runbooks/2026-09-08-signed-staging-scheduler-rehearsal.md).

Historical open-gate snapshot (superseded by the current checkpoint above):
R7 regeneration, signed scheduling, tray acceptance, Intel acceptance and Windows
production signing were open at this point. Do not use this historical list as
the current release decision. Production activation and stable cutover remain
separate from private test qualification.

Earlier `.11` qualification and recovery history follows; the `.13` checkpoint
above supersedes its installed-version and open-state claims.

- **Installed Mac launch, refresh and restart pass.** R8 completed the native
  migration; r9 launched signed `.11` from that completed profile after fresh,
  verified APFS copies of both native and Electron state. The corrected app
  rendered all five dashboard pages and all five Settings tabs, completed its
  automatic full refresh, quit normally with installed-bundle processes absent,
  and reopened successfully. A tray preference persisted across restart and was
  then restored; the previous contribution opt-out and login-item off state
  persisted. No unexpected Keychain prompt was observed during these actions.
  Receipts remain private under `mac-installed-rehearsal-20260908-r9`.
- Installed interaction checks cover the Allowance range selector, Trends
  per-model cost expansion, cache chart/table disclosure and pagination, and
  Settings-to-Community navigation. About alignment and the `.11` version display
  are verified. Cache thread labels were unavailable during retained-projection
  recalculation, then populated after refresh; all 20 continuity rows resolved,
  and all 15 auto-review rows had verified parent links. Actual tray-popup
  rendering is still open because the UI automation could not select the status
  icon. The exact installed `.11` then passed a 45-second active-refresh
  responsiveness probe: 45 samples per endpoint, zero failures, health p95
  0.68 ms (maximum 14.29 ms) and refresh-status p95 0.40 ms (maximum 0.45 ms),
  with the original 250 ms p95 and 3,000 ms individual limits unchanged.
  `active-status.json` retains every sample. This covers the observed active
  phase, not every cold-start phase or a renderer latency bound. The restarted
  app also completed its refresh in 151 seconds; its index skipped 8,659 of
  8,666 sources, resumed seven and rescanned none. The remaining work was
  generation-bound indexed-history accounting, not a full raw-log rescan.
- **All four corrected private Mac archives are finalized.** Current `.11` and
  next `.12`, for arm64 and x64, are signed, notarized, stapled and independently
  hash-verified under `signed-handover-c938a654`. Their canonical source release
  remains 0.1.18. The exact signed companion starts, returns health HTTP 200 and
  exits cleanly on arm64 and on x64 under Rosetta. Rosetta is not physical Intel
  GUI qualification. The isolated rehearsal feeds and all eight signed ZIP/DMG
  objects are now published; independent HTTP downloads match the recorded
  hashes, sizes and content types. Installed `.11` correctly showed current,
  detected the `.12` advance, and returned to current with its download button
  removed after exact feed rollback. No update was installed during that
  rollback proof. Initial, advance and rollback receipts are complete for both
  architectures. The subsequent installed update **failed**: close-to-tray
  handlers blocked native exit. Native-menu Quit released the handoff, but
  ShipIt then refused quarantine removal from the read-only packaged keytar
  module (POSIX error 13). After its bounded retries, `.11` relaunched unchanged.
  Its ASAR, installation salt and sharing-choice hashes match the snapshot;
  refresh reached FRESH and sharing remained off. The lifecycle correction
  `c8a6d4bc` passes 102/102 shell/updater/recovery tests. Packaging correction
  `204269c6` preserves exact native bytes and sets Darwin native modules to
  owner-writable 0755 before signing; all 13 package-layout tests pass. Windows
  and Linux retain their prior mode policy. Both archived .12 ZIPs have only
  one owner-read-only regular member, Keytar, and a synthetic quarantine test
  reproduces the 0555 refusal and 0755 success. A fresh signed .13/.14 pair is
  required; no successful installed-version update is claimed.
  Automatic approval review rejected the second rollback request and requires
  exact destination/file confirmation. The test feed still offers `.12` pending
  that response, with automatic downloads disabled in these test builds.
  The publisher requires exclusive operator control and before/after byte
  checks; it does not claim atomic compare-and-swap. This namespace is publicly
  readable but isolated from stable routing. Public stable release remains
  outside the user's 2026-09-09 rehearsal approval.
- **All six CI jobs pass at `9d07534d`.** Run
  [34326477259](https://github.com/adamallcock/tibotattle/actions/runs/34326477259)
  **passed all six jobs**: all four package targets, the Windows normal app
  journey and the Windows NSIS installed lifecycle. The retained
  Windows receipt proves packaged dashboard rendering, successful refresh,
  Settings persistence through restart, durable opt-out, outbound block and
  cleanup; its terminal phase is process absence. Receipt SHA-256 is
  `819962b0c1ac697743468ad4c4fedc242444a6b4f145378c7d334e83974b51b9`.
  This is development evidence with `productionReady=false`, not signed Windows
  installer or production qualification. The previous `d70e99ed` run passed
  Mac/Linux but failed Windows: one simulated Darwin storage expectation and
  a Settings target timeout whose original error was hidden by cleanup.
  `590a99dc` asserts the real Windows storage refusal; `9d07534d` awaits the
  PID-tree terminator and retains the primary error/phase. Their owning local
  suites pass 77/77 and 32/32 respectively. The prior complete six-job pass
  remains `4b32c7e6` in
  [34303173582](https://github.com/adamallcock/tibotattle/actions/runs/34303173582).
  Source changes do not update the installed `c938a654` app.
- **Signed contribution staging source is integrated** at `bdfce5a3` with
  163/163 focused tests passing. The private profile uses the native accountless
  backend through FD3, omits the production FD4 broker, fixes the staging origin,
  disables updates, and isolates both Electron `userData` and `sessionData`
  before native setup. Its account/profile tuple is an accidental-launch guard
  for a disposable OS account, not GitHub attestation. No signed fixture or
  packaged scheduler end-to-end result exists yet. The duplicate host-preflight
  CLI was excluded from integration. Automatic approval review rejected GitHub
  receipt egress; no upload workflow or alternate transport was executed. Before
  signing this fixture, the actual-ready ordering issue was repaired at
  `f3bf7a53` and verified through the real entry point; this does not qualify a
  signed fixture or its packaged scheduler. The probe explicitly redirects
  appData and blocks native work at the readiness promise.
- **PR #114 reconciliation is merged locally** through `2f77628`, preserving
  branch-only Electron work and canonical production migrations 0046–0056.
  Accountless migrations append at 0057–0059. Legacy staging 0046–0048 is
  explicitly replacement-required; its database remains preserved and no
  remote migration, binding or deployment has changed. Focused migration,
  readiness, ownership and social-only public/scheduler checks pass. Integrated
  full Worker testing found a real parent-delete cascade defect: child triggers
  could no longer see the deleted owner. Repair `51a61dd2` preserves social
  graph invalidation/progress cleanup and accountless exclusion. All 989 tests
  in 77 Worker files, the 95-case focused regression suite and 54 readiness
  tests pass. The final production and staging dry packaging stages also pass
  on clean `9be7da8d` after prescribed local asset generation. Accountless public
  aggregate inclusion stays disabled.
- **The 11 missing native quota observations are recovered.** Private-copy
  reconciliation passed, then the normally stopped live Electron database was
  proven identical to the baseline before the guarded append-only replacement.
  The collector grew from 649,071 to 649,082 observations. Full-field comparison
  found zero changes to pre-existing records and zero metadata differences.
  The previous database remains available for rollback. Signed `.11` reopened,
  its automatic refresh reached the rendered FRESH state, and the existing
  contribution opt-out remained off. Private r9 receipts bind the replacement,
  rollback copy and installed ASAR. Do not repeat the no-clobber operator or
  restore an old migration journal over completed Electron state.
  The r9 rollback operator preserves newer Electron state as well as native
  state. Historical r1/r3/r4 archives retain verified bytes, metadata and tested
  `tar --fflags -p` recovery; newer backups remain.

Broader integrated source regression result: 4,814 cases, 4,763 passed,
45 skipped and six failures. The two missing public API declarations and one
missing tool caller entry are corrected (44/44 boundary tests and 6/6 inventory
tests pass). R7 workload coverage now includes deployment endpoint policy in
both digests (`82da1373`; focused checks pass). The two remaining generated R7
receipt validations correctly reject old workload evidence. No protected receipt
was regenerated or relabelled. A private proposal binds pinned Node 24.14.0 and
26.2.0, the existing frozen 31-day interval and a 45–60 minute local regeneration.

Latest CI receipt SHA-256 values (private files, not public artifacts):

- `windows-normal-9be7da8d`: `6d82a1b0dcb4ae41d2d464229fc8e0618cde9ec46b6986fcd000eb5c69d45e6e`.
- `linux-normal-9be7da8d`: `6d1eeca8b46474fe8abc6510ff9f76ce5307a68f0451a5e3e06dcb335667e014`.
- `windows-nsis-9be7da8d`: `4a1fda20c3df046c5399a7189357529752fadfeea846d96f96bba653b613e2c9`.

Prior source receipts retained:

- `windows-nsis-9d07534d`: `b08189e64b1f0eb24d4ed7e7a8e6bfccb8c54c580f94427f5232d1f28cc3c8fc`.
- `linux-normal-9d07534d`: `26e8f58c619b0393645a56de4c0e9221c0a7021b594ba6373c98ddba655777f3`.


- `windows-normal-4b32c7e6`: `08b110a7a03c3c1bcb814a6962bb853938b4a06117c3560e0f2d87fb1c1acf4f`.
- `linux-normal-4b32c7e6`: `7391b9fbd6e43ffa8df4deaf8dd050004dd00a4d97223f2d334865bd6e84d916`.
- `windows-nsis-4b32c7e6`: `746b5b459a065507d394d7d5bc927d892c1ed3030950459ff876aea0423fb7ac`.

Earlier diagnostic history follows; the checkpoint above supersedes its open-state claims.

- Linux targeted run [34288818674](https://github.com/adamallcock/tibotattle/actions/runs/34288818674)
  passed at `34087112`. Its normal packaged receipt verifies package execution,
  account-observation lifecycle, unavailable-service response and cleanup;
  `productionReady` remains false. The receipt is preserved under ignored
  `linux-normal-34087112`, SHA-256
  `8530f087a3b964383c2db4c87b3e10a7b17ab74bb95c3445020e1a47ea19483f`.
- Windows targeted run [34288805086](https://github.com/adamallcock/tibotattle/actions/runs/34288805086)
  passed the preload gate but failed automatic refresh observation. A reproduced
  race discarded the one startup pass while the primary dashboard load owned
  its busy lock. The pushed repair defers that pass until the owner releases
  the lock, preserves the manual refresh requirement, and adds staged/ASAR
  preload-manifest integrity checks. Integrated UI tests pass 574/574; focused
  platform/refresh checks pass 39/39. A new targeted dispatch was rejected by
  automatic approval review because the account usage limit was reached; no new
  targeted run was created by that call. Work subsequently resumed with explicit
  approval. Full run `34290262917` passed Linux and all four development package
  targets, but still failed Windows automatic observation. The observer counted
  only the detailed route, missing the legitimate quick route used after a
  projection exists. The closed route-set repair passes 40 focused tests;
  targeted run `34290975094` still failed. Expanded fixed-field receipt from
  `34291528984` identifies the immediate blocker: first launch, zero requests,
  idle controller, onboarding needs attention, source unreadable, no rollout,
  writable state, Electron marker present. The test seeded the development
  override while ordinary settings selected `HOME/.codex`. The normal fixture
  and environment now match that actual default; 30 focused checks pass.
  Targeted run `34292088445` at `1ff67d51` now passes startup acceptance,
  confirming the source-discovery blocker is cleared, but fails refresh
  completion. Its receipt confirms firewall removal and owned-profile cleanup.
  Completion classifier failures now leave polling immediately and retain a
  fixed phase/status/reason/controller-step diagnostic, including when cleanup
  overrides the top-level error. The 28 focused tests pass; deadlines and
  accepted terminal states are unchanged. Run `34293724035` at `ffeec20c`
  reports one request and a degraded unified-index result rejected as
  `degraded_invalid`; this is an indexing contract failure, not an unobserved
  request or simple timeout. The next diagnostic retains only the reviewed
  unified-index failure vocabulary and the precise unmet degraded-contract
  checks; 28 focused tests include coherent degraded success plus all 20
  individual contract violations. Full run `34293690719` passes Linux, both
  Mac package targets, Windows development packaging and the NSIS lifecycle;
  ordinary Windows indexing is its sole failing job. Run `34295189921`
  identifies `local_unified_index_publication_durability_uncertain`: the index
  was renamed, then the private directory-fsync operation failed on Windows.
  Fix `102a3dbe` uses the existing public platform filesystem contract, retaining
  POSIX directory sync and the staged/published file flushes on Windows. Tests
  prove exact flush order and preserve the failure receipt when the published
  file itself cannot sync. Unified-index tests pass 134/134, companion refresh
  96/96, and integrated architecture checks retain zero debt. Full run [34296247128](https://github.com/adamallcock/tibotattle/actions/runs/34296247128)
  at `a1b838f1` now reports `SETTINGS_UNAVAILABLE` instead of the publication
  failure. That receipt alone does not close the refresh gate; the exact settings
  failure is under investigation. Both Mac targets, Windows development packaging
  and the Linux job pass in this run; NSIS installed lifecycle also passes.
  Source inspection identifies a deterministic settings observer mismatch: the
  app emits `#general`, while the harness rejects every nonempty hash. Repair `fdd7ebde` selects the exact expected
  route without changing the app route or weakening origin/path checks. Its
  receipt also retains completed dashboard/refresh evidence when a later
  settings step fails. Its native qualification subsequently passes as recorded above. The earlier full `34290262917` NSIS installed
  lifecycle subsequently passed.
- Corrected Mac `.5` arm64/x64 and `.6` arm64 from frozen `ba1e7cba` have complete
  signing, notarization and artifact receipts. `.6` x64 subsequently completed;
  all four final archives were independently hash-verified and preserved under
  ignored `signed-handover-ba1e7cba`.
  The signed `.5` read-only active-credential probe passes. Guarded installed
  rehearsal r4 passed backup, signature and installation checks, then stopped
  with a migration warning at journal phase `started`, before state copying or
  publication. Read-only installed inspection returns `ready`; the helper's
  contract and bundle-context checks also pass under its exact scrubbed environment.
  The remaining failure is inside helper preparation or reply validation;
  helper preparation may have changed login-item registration before failing.
  Rollback restored native 0.1.18 and verified state against the stopped backup.
  The blocked candidate and started journal are preserved. Do not remove the
  journal or assume a changed candidate digest can resume it automatically.
  Read-only helper preparation and fixed private failure stages are integrated
  at `7083d719`, with 16 helper/adapter and 46 migration/credential/distribution
  tests passing. Review caught and fixed acceptance of success JSON with a
  nonzero helper exit. ServiceManagement status categories are now separate;
  other same-identity writers block preparation without being terminated.
  Frozen `2c70efa4` stages `.7/.8` for both architectures; 17 focused helper
  checks and 38 staging/finalization checks pass. Root independently verified
  clean source plus all eight receipt/wrapper hashes. `.7` arm64 is signed,
  notarized and final-verified, with both archive hashes independently checked.
  Installed read-only probe r6 passes bundle and initial login-item status
  checks, then reports the closed failure stage `preferences`. The probe took
  a full stopped-state backup and automatically restored native 0.1.18 with
  verified state equality. No Electron GUI was launched and the existing `.5`
  journal is unchanged. The prior r5 attempt stopped before bundle exchange
  on its full-migration space reserve; r6 is a distinct read-only transaction
  with a backup plus full-restore reserve. Full migration keeps its original
  capacity guard. A disposable same-identity Foundation bundle reproduced the
  preference failure: a named suite cannot be opened using the current app ID.
  Repair `1a9e8913` uses `UserDefaults.standard`, preserving strict value
  validation. Integrated tests pass 19/19. Private `.9` arm64 from frozen
  `1a9e8913` is signed, notarized and independently archive-verified. Installed
  read-only r7 passes `preflight_ready`, leaves the journal unchanged, and
  restores native 0.1.18 with verified equality to its fresh APFS-cloned backup.
  The clone has an independent inode, no fallback and full content verification;
  this remains preparation proof, not a completed state migration. Full migration additionally
  needs disk headroom: approximately 36 GiB is free against a 105 GiB reserve after archive preparation.
  Historical backup archive verification found omitted filesystem flags in two
  early generated archives; those archives are being regenerated before replacement.
  No original backup has been removed. The frozen journal recovery tool passes
  all nine synthetic tests with process-table access;
  originals remain preserved and no capacity rule has been relaxed.
- The signed staging scheduler remains unqualified. Source review confirms the
  unsigned hosted profile uses generic safeStorage; reusing the production native
  binary would share fixed production identity/services. Two unimplemented
  options remain: a separately signed accountless-only staging identity/namespace,
  or a disposable OS user with the existing native adapter and a fixed signed
  staging package policy. The latter avoids a second adapter but still requires
  transport-policy work; no existing profile can safely select it today. These
  are design options, not completed qualification or production changes.
- Agent execution and privileged approval review temporarily stopped at the
  account usage limit. No usage-reset credit was requested or consumed. The
  user approved continuation; privileged tools and both Mac investigation agents
  resumed. The Windows agent remained unavailable, so root implemented and
  validated the quick-route observer and default-source fixes directly. Mac
  read-only preparation diagnostics and preference-validation ordering are now
  implemented; installed verification remains open.

- Hosted client qualification passed against isolated staging, including real
  enrollment, ownership, encrypted upload, activation, deliberately lost-response
  recovery, duplicate-free repeated synchronization, confirmed disconnect and
  zero-request opt-out. Five synthetic authorities are revoked; three contributing
  installations retained nine chunks/fifteen records across preserved attempts.
  Usage/quota installation, provider, time and available plan context match;
  unknown accounts remain unknown and quotas have no invented session UUID.
  There are zero public aggregates. Final deployed source is `4bb08ca6`; collection
  revision 8 has all four controls off, accountless runtime disabled and v1.1
  format restored to staged. Root independently checked live health and preserved
  redacted receipts under the project's ignored `hosted-staging-4bb08ca6` directory.
  Production is unchanged. The packaged scheduler remains open: the unsigned
  isolated rehearsal app could not create its encrypted safeStorage record.
- The staging preparation omissions are repaired: all three independent test
  secrets are required, the exact staging public origin is pinned, and temporary
  v1.1 admission/restoration is explicit. The combined source, including the
  parallel dependency security patch, passes 197 script checks and 581 Worker
  tests plus both dry-deployment/staging checks. An initial local dry-run failure
  was stale generated public assets; rebuilding those assets resolved it.
- Linux ordinary packaged startup, credential lifecycle and cleanup passed at
  `3485a504` in [34283753736](https://github.com/adamallcock/tibotattle/actions/runs/34283753736).
  The `ab59d4c0` rerun timed out during reload refresh, so current qualification
  remains open. Source-smoke timeouts had lost the acceptance/completion subphase
  before the outer wrapper. The integrated diagnostic retains only phase, bounded
  request count and closed status through every wrapper, with unchanged limits.
- Windows development packaging and installed NSIS lifecycle passed at `3485a504`.
  Normal startup now requires observed automatic refresh followed by a separate
  manual refresh. An exact smoke-only preload barrier and bounded bridge wait
  prevent the automatic request outrunning observation. The affected shell/runtime
  suites pass 98/98; [targeted run 34286896264](https://github.com/adamallcock/tibotattle/actions/runs/34286896264)
  at `196931d0` still fails and is being diagnosed. No normal Windows pass is claimed.
- Manual Windows/Linux diagnostics reuse the exact existing jobs with separate
  concurrency groups. Every push/default manual run still selects all six jobs,
  including NSIS. Workflow lint and selector truth-table tests pass. Integrated
  Linux, Mac policy/dual-architecture compilation and staging-plan checks pass
  89/89; architecture boundaries pass with zero approved debt.
- All four private Mac `.3`/`.4` installers from frozen `82122044` have Apple
  acceptance, stapling and finalization receipts. Final DMG/ZIP bytes and
  metadata are preserved under the project's ignored `signed-handover-82122044`
  directory. Strict verification failures were caused by the restricted
  execution context: controls, predecessor and candidate pass outside it.
  After a shutdown-settling backup failure, two matching inventories allowed the
  guarded r3 installation. The candidate exited before migration; rollback
  restored native 0.1.18/build1026 and verified state against the fresh backup.
  An observed HTTPS attempt is not evidence of usage upload; its historical
  destination remains unclassified. A no-GUI probe identified a false lock guard:
  the readable standard System keychain lacks the unlock bit. The reviewed fix
  exempts it only from post-not-found absence proof; new credential creation still
  requires an unlocked, readable default keychain. The repaired probe then found
  legacy export/Claude capabilities blocking an overbroad startup preflight,
  while current account/contribution capabilities were present. Required-capability
  composition now preflights only current account/contribution capabilities,
  retaining optional export/Claude migration guards at actual use and accountless
  main-only access on demand. The integrated Mac suite passes 68/68, including
  both architecture builds. A corrected private handover pair is being prepared;
  these source checks do not qualify installation. The released native
  secure-upgrade UI exists but exposes only actually
  pending broker requests; no approval or credential write was performed through
  that UI. Installed handover and subsequent signed update remain unqualified.
- The daily Mac tester still uses `98a5256d`; the signed migration fixtures and
  latest source are distinct artifacts. No public feed or release was changed.

Historical integration update: native run
[34276107974](https://github.com/adamallcock/tibotattle/actions/runs/34276107974)
passes both Mac packaging jobs, Windows development packaging and the Windows
NSIS installed lifecycle. Linux now passes initial dashboard readiness: the
shared updater repair removed the premature quit. Its remaining failure is
`SOURCE_SMOKE_RELOAD_REFRESH_FAILED`; packaged credential checks still pass.
The next run preserves the existing fixed inner refresh failure code to identify
the reload issue without capturing response content. Windows now passes strict
COM firewall setup/removal but its empty synthetic Codex root keeps Refresh
disabled. The integrated fixture repair adds one content-free session metadata
record before launch. Combined owning Windows/Linux checks pass 45/45.
These followups preserve the newer parallel tray commits through `a60b5fa1`.
The user has now authorized signing/notarizing Mac `.3`/`.4` from frozen source
`82122044` for both architectures. Signing is underway; the first Apple Silicon
candidate is Apple-accepted and stapled, with final metadata verification still
in progress. These migration candidates do not include subsequent tray-only
refinements. Installed migration and update proof remain open.

Followup native run `34279624092` still failed Windows refresh and Linux reload.
The causes are now covered by concrete local regressions: Linux switches to the
quick-refresh endpoint after creating its trusted projection, but the observer
watched only the detailed endpoint. Windows needs a canonical discoverable
rollout, not merely a readable JSONL file. The corrected Windows fixture passes
actual discovery, normalized onboarding, authorized companion refresh, terminal
completion and restart; its old fixture is proved undiscoverable. The Linux
observer accepts only the two legitimate refresh routes with unchanged origin
and document binding. Linux checks pass 57/57 and Windows checks pass 22/22.
Both fixes are batched for the next native run, preserving safety assertions.

The Worker development-only Vitest security patch is integrated at `216502c6`:
Vitest and its sibling packages are pinned to 4.1.11. All 581 Worker tests and
193 script checks pass, as do type/configuration checks. An initial dry-run
failure identified stale generated public assets; after rebuilding those local
assets, both remaining dry-deployment and staging checks pass. No hosted service
was deployed. Read-only inspection confirms the two planned staging databases
do not yet exist.

Cutover focus as of 2026-09-08: freeze the tested feature set at `98a5256d`.
Do not add cosmetic work, optional platform abstractions, or broader audits.
Change only a reproduced cutover blocker or the smallest test needed to resolve
one. The Mac daily-use tester is available; that is not full cutover readiness.

Earlier native candidate: `d523068d`,
[run 34258700354](https://github.com/adamallcock/tibotattle/actions/runs/34258700354).
Both Mac package/artifact jobs pass. Windows development packaging and a fourth
fresh NSIS lifecycle pass. The normal Windows candidate builds, but package
verification fails before app launch; closed package-stage diagnostics are now
integrated. Linux passes the exact packaged startup-store probe, including its
persistence attempt (the probe does not independently verify saved bytes), then
still fails ordinary dashboard readiness. Its last observed snapshot state is
`building`. The preserved failed Linux receipt has SHA-256
`a319496152dd39ba76dc0a08c35bf4d586534d542cd9363d2d3f1612724aae74`.
The next candidate retains a bounded server-minted startup failure in the
existing local journal and exports only its fixed step/detail in the test
receipt. These diagnostic changes do not close either normal-app gate.

The following native candidate, `b5c112e8` in
[run 34263864178](https://github.com/adamallcock/tibotattle/actions/runs/34263864178),
narrows Windows to the native-member verifier. Pinned ASAR source and a local
reproduction establish that the virtual sidecar is addressed with host path
separators; the runner incorrectly supplied a POSIX member path on Windows.
That verifier-only repair is integrated at `5cb6b760`. Linux repeats its
dashboard readiness failure with no exported startup note; receipt SHA-256
`e6e17730562e841663dc5647a1502bd42e12e0aab51cf2efa30527d79b8fd53b`.
Absence is inconclusive: the reader discarded multiple notes even though the
normal lifecycle may retry once. It now retains the latest fixed note and
reports whether the journal was absent, unreadable, invalid, empty of startup
failures, or contained a failure. The next workflow also retains the same
closed Linux receipt separately, avoiding a large development-package download
for every diagnosis. No normal candidate binaries are added to artifact upload.

Earlier native candidate: `610bc97c`,
[run 34266665792](https://github.com/adamallcock/tibotattle/actions/runs/34266665792).
Both Mac package/artifact jobs, Windows development packaging and a sixth
fresh Windows NSIS lifecycle pass. The normal Windows package now verifies,
confirming the ASAR path repair, but preparation of its synthetic durable
opt-out fails before firewall setup or app launch. The next runner classifies
that setup boundary and only known fixed adapter/store/settings error codes.
Its failed receipt SHA-256 is
`e480b9cd79c4446e346cfc07a38baea455ac5195c2687888cef1160f0a6fff48`.
Linux repeats the renderer-readiness failure; the corrected reader reports
the startup journal is absent. There is no recorded handled snapshot exception
to fix. Its receipt SHA-256 is
`41d0e28a7ab5b3279462420c78206122152d0370dce73287a33e98dc6fbec4ff`.
The next isolated Linux run observes closed companion start/exit categories,
preserving the first unexpected exit across automatic retries. Observation is
scoped to the existing Linux/x64 quit-only smoke control and captures no raw
process output, paths or credentials. It does not change startup or success
criteria. Neither normal application journey is qualified yet.

Earlier native candidate: `5d0774fb`,
[run 34269016362](https://github.com/adamallcock/tibotattle/actions/runs/34269016362).
Both Mac package/artifact jobs, Windows development packaging and a seventh
fresh Windows NSIS lifecycle pass. Normal Windows again passes package
verification, then fails the runner's opt-out assertion. Source inspection
finds a concrete test contract mismatch: `readAuthorization()` returns raw
policy state, while `inspect()` provides `transportStatus`. The runner now
checks current/available/disabled authorization separately from the projected
off state; a regression uses the real sharing coordinator for seed and reread.
The failed Windows receipt SHA-256 is
`784bd0f70a0c413e9fe2365ee0118cc80a28b538840353ea6a07f271c54f5d4c`.
Linux records `exited/stopping/exit_zero` with no unexpected companion exit.
This precedes harness cleanup and identifies an app-requested stop, while the
startup journal remains absent. Its receipt SHA-256 is
`e0f169bafb29ede23442d77e6714da2b60a96bc1a70238d6adeccea41b009abf`.
The next isolated diagnostic distinguishes dashboard load rejection,
main-frame load failure and renderer-process loss using fixed categories;
these currently converge on the same startup recovery handler. The renderer
crash/shared-memory explanation remains a hypothesis until that test runs.

Latest completed native candidate: `90991288`,
[run 34271211699](https://github.com/adamallcock/tibotattle/actions/runs/34271211699).
Both Mac package/artifact jobs, Windows development packaging and an eighth
fresh Windows NSIS lifecycle pass. The Windows sharing-test repair is confirmed:
normal setup now reaches outbound firewall preparation, which exceeds its
20-second command bound. The runner gives only firewall create/readback and
remove/readback a separate 60-second bound; exact rule verification remains
mandatory before launch. That adjustment still requires native verification.
The Windows receipt SHA-256 is
`ec6adc43fb2d6a995f8ba6177a9fb65d32d1535a051d418e87422a1082ca5979`.
Linux again stops its companion cleanly and records no dashboard load failure;
receipt SHA-256
`583d8148d7f47dad1d9f5c5e550b66083a0a93cabec6e502937eded6622d1d0f`.
Source inspection identifies a separate post-window startup defect: the runtime
selects Electron's built-in `autoUpdater` ahead of `electron-updater`, then
requires `downloadUpdate`, which the built-in adapter does not provide. The
resulting exception reaches the main entry's quit handler. The shared repair
must select the bundled updater library explicitly on every production target;
the Windows/Linux native journeys must then be rerun. Corrected unsigned Mac
handover fixtures must also include this repair before signing. The older
`19c63f7b` unsigned candidates are superseded for readiness purposes; they must
not be signed on the basis of their pending request.

The updater selection repair is integrated and frozen at `d8845172`. Its new
runtime regression fails against the preceding source at the real updater
contract check and passes with the fix. Four later accountless child-readiness
failures were traced to the synthetic fixture's unused loopback listener:
the sandbox rejects its bind with `EPERM` before scheduler IPC starts. The same
failure reproduces on the older `d5dc8025` source. The fixture-only repair at
`82122044` removes that unnecessary listener; all 44 runtime tests now pass
under pinned Node 26.2.0, preserving the five-second readiness assertions.
Corrected unsigned Mac source candidates for `.3`/`.4` on both Mac
architectures are prepared from `d8845172`. All 49 focused Mac tests pass;
root independently verifies all four receipt hashes, staged updater/verifier
source, candidate versions and thin native helper/adapter architectures.
Signing/notarization of this corrected source remains a separate pending step.
Windows firewall preparation now uses the direct COM API at `17807be8`, retaining
strict rule ownership, outbound blocking and readback requirements. Its 20
focused checks pass; native proof is pending. Mac preparation proceeds
independently while native Windows/Linux tests qualify the shared application.
A harness failure is recorded separately from an app defect; neither is
silently relabelled as a successful release gate.

The latest user-requested tray corrections from the parallel task (`c1c83618`)
are merged with both startup repairs at `3eb09cc5`; all 34 focused tray tests
pass. Its native qualification is
[run 34276107974](https://github.com/adamallcock/tibotattle/actions/runs/34276107974).
The run has started after the preceding tray-only run's NSIS lifecycle. The newer
`82122044` changes only the test fixture described above. Mac source candidates
are refreshed from that integrated source with the tray corrections included.
All 49 focused Mac checks pass again. Root independently verifies the staged
updater, verifier and tray files, candidate versions, thin native architectures,
disabled hosted uploads and unsigned boundaries. Exact-source authorization
for signing/notarizing these `.3`/`.4` replacements has been requested. The existing daily-use
tester at `98a5256d` and earlier unsigned source receipts remain preserved.

Refreshed source receipt SHA-256 values at `82122044`:

| Candidate | Target | Receipt SHA-256 |
| --- | --- | --- |
| `.3` / `2026090803` | darwin-arm64 | `41cec175b94193cd6f2537efd5ab8457042db4ad40397656c356d395eb4616ca` |
| `.3` / `2026090803` | darwin-x64 | `55c39b03cf8b1ba9f395c50bd6235e1a01339324bb03895b54c17d055894a586` |
| `.4` / `2026090804` | darwin-arm64 | `1c9bbb427777dc9096ede09d80ee9dbd12456da5eb5b20a48eab2956b1f9f73d` |
| `.4` / `2026090804` | darwin-x64 | `218fc1238008ad43496081aad93ff9d1bbcaaf00345ebd77442f4da18af42445` |

1. Close the real native Mac -> signed Electron -> next signed Electron
   installed rehearsal. The original signed private fixtures exposed the
   startup verifier defect; corrected unsigned replacements are prepared.
   The user approved the backed-up installed Mac rehearsal on 2026-09-08;
   the signed current fixture reached the installed startup gate but stopped
   before migration because the credential verifier supplied a signing rule as
   a filename. Native 0.1.18 has been restored and reopened; its stopped-state
   backup matches all original files. Repair and rebuild this exact blocker,
   then resume data/choice preservation, single ownership, startup and
   credential continuity checks.
2. Finish the integrated disposable Windows installer journey, then complete
   required production credential/trust composition and installed updates.
   Linux's packaged native credential journey now passes, including its read
   deadline and fixed observation IPC. Its normal packaged production launch
   is next. Windows now passes guarded artifact transfer, both installed
   launches under a fresh account, synthetic credential checks, settled
   uninstall and verified app-root/registry removal. Normal Windows app
   behavior and signed installed updates remain separate gates.
3. Complete one authorized hosted contribution rehearsal and explicit
   accountless public-sample/overlapping-history decisions. Preserve accepted
   automatic-sharing and persistent opt-out behavior throughout.

Windows normal candidate composition is integrated at `d23f17e9`: exact stable
Windows/x64 metadata selects the fixed FD3 installation credential, fixed FD4
account-observation broker and existing protected settings/notification stores.
The native production-safety flags remain false and legacy ciphertext still
requires explicit recovery. Source/facade tests pass; normal packaged startup
has not been exercised natively. The current native sidecar does not establish
authenticated signed provenance. Preserve those limits; do not manufacture a
full-readiness attestation or select legacy identity/device routes.

The maintained native binding contract limits replacement safety to cooperating
writers holding the capability lease; deliberate same-owner mutation is outside
that contract (`native/windows-filesystem/README.md`). Do not expand this into
a privileged service or claim a hostile-writer atomic replacement guarantee.
The fixed normal Windows composition stays within that existing contract;
qualify actual startup separately from release trust.

Across these three streams, freeze release candidates, verify four-target
installation/update evidence, then request the concrete staged
publication/activation decision.

Planning estimate, not a release commitment: 1–3 focused working days for a Mac
cutover candidate if migration reveals no major defect; approximately 1–2
working weeks for the complete four-target cutover, conditional on platform
access, trust material, activation decisions and no major new runtime defects.
Re-estimate after the first installed migration and Windows installer results.

Earlier combined result: `57e82e63` in
[run 34249261605](https://github.com/adamallcock/tibotattle/actions/runs/34249261605)
passes both Mac package jobs, the Windows producer and the fresh Windows NSIS
installed lifecycle. The exact unsigned installer completes installation, two
distinct app launches and uninstall. The documented in-place command leaves
only its unchanged uninstaller; the strictly bounded residue removal succeeds,
and independent checks confirm both the app root and uninstall registrations
are absent. Receipt SHA-256:
`7db8283d97abd9f519dfa8c36878be5cb8e990b22554babf59f9893597bcddf7`.
This closes the development-installer cleanup blocker. It does not qualify
normal Windows dashboard/refresh/settings, general credential persistence,
all descendant-process cleanup, signed releases or installed updates.

Linux again passes native credentials and normal-candidate preparation. Its
retained normal-app receipt confirms every allowlisted renderer module loaded
with a successful response. The readiness marker remains false; no JavaScript
exception is observed, no primary local API response is observed, and four
bounded direct probes return `request_failed`. Source inspection subsequently
finds that the diagnostic observer may retain the same target's initial
`about:blank` origin after it navigates to loopback. That possibility limits
companion-liveness inference from unobserved APIs; correct the observer before
changing product behavior. Failed receipt SHA-256:
`b9b6b8573e8a38fa69b54ef617e7e66b413a42645721e4b04e19a370a9307527`.
Both exact receipts are privately retained. Normal Linux startup is still open.

The corrected selected-origin observer is pushed at `cbddccb8` in
[run 34252011615](https://github.com/adamallcock/tibotattle/actions/runs/34252011615).
All 31 owning Linux harness tests pass. Its native normal-app receipt still
reports the same readiness failure and failed direct probes, so the observer
repair is not a product fix. The old receipt's successful asset responses also
mean an opaque origin was only a possible flaw, not the established cause.
The corrected receipt is privately retained with SHA-256
`d112846d0ce9790605bbc8d882b6e3a5c8214a7f33cd91d902603da8edff9344`.
The next diagnostic at `6d78d4dc` polls the existing snapshot-independent
health route during the unchanged readiness window. It retains only the last
validated snapshot state and bounded machine-readable error code, with a new
versioned receipt. This is diagnostic instrumentation, not a startup fix.
The same run's Mac arm64 build and validation pass, but GitHub refuses artifact
finalization with HTTP 403; that is an artifact-retention failure, not an app
build failure.

The first normal Windows run at `e2c4836a`,
[34255349512](https://github.com/adamallcock/tibotattle/actions/runs/34255349512),
passes both Mac package/artifact jobs, the Windows producer and a third fresh
NSIS lifecycle. Normal Windows source staging and native binding compilation
pass, but electron-builder treats the short dotted signing override as a
configuration filename; the app has not launched. Replace those two candidate
arguments with the documented long `--config` forms and exercise the actual CLI
entrypoint in the contract test. Release signing remains required.

The same run's Linux receipt observes snapshot `building` with no error code,
then the same renderer-readiness failure and failed direct read probes. Receipt
SHA-256: `a4494ca73c0954b6a6cf87769a80e7b709aa2a19d040316553ddf77705aa19c6`.
It does not prove whether snapshot construction threw or the child terminated
for another reason. A separate fixture review at `bc5a16f8` corrects the raw
session to the app's selected disposable `HOME/.codex` and removes the erroneous
extra `.usage-monitor` segment from the expected state-file path. These are
post-readiness test corrections, not a claimed fix for the current startup
failure. Local offline emulation builds a fresh snapshot under plain Node, but
the emulated Electron invocation exits 137 without a result; neither qualifies
native Linux. The existing Mac tester's exact Electron/ASAR snapshot build
succeeds with an isolated empty synthetic profile. Native packaged Linux needs
its own fixed snapshot-build error before application behavior is changed. The next
native candidate therefore runs a 15-second exact-Electron/ASAR startup-store
probe against a separate empty tmpfs fixture before the unchanged normal UI
journey. It includes snapshot persistence, exports only a closed failure code,
and retains its private fixture if child shutdown cannot be proved. It has no
credential or hosted service access; passing it will not replace the normal
render/refresh/observation requirements. Owning Linux contracts pass 35 tests.

The next Windows test uses a separate disposable runner account and an unpacked
unsigned candidate with the exact normal distribution metadata. It must prove
rendered dashboard, refresh, protected setting persistence and restart after
seeding a synthetic durable sharing opt-out and enforcing a per-app outbound
block. Candidate bytes stay on the runner; only a closed receipt is retained.
The harness is integrated at `618f9064`: both launches verify the running app's
sharing opt-out, visible Data & privacy settings persist across restart, refresh
reaches a bounded terminal result, and the ordinary quit path finishes before
exact-process absence allows firewall/profile cleanup. Source preparation and
local tests are not passing native runtime or release evidence.
The fixed Windows parent-pipe quit control is implemented at `c59e7a98`:
one exact message and flushed acknowledgement call the ordinary lifecycle quit
path. It requires explicit `quit-v1`, a primary Windows instance and an inherited
connected pipe; qualification lanes and all other messages are refused. It adds
no renderer, storage or HTTP command. Four owning cases plus the shell suite
pass 70 cases. The isolated workflow/parser checks pass 24 cases and release
trust passes 78 cases; the normal native Windows journey is still untested. The combined
Linux/Windows harness, quit-control, workflow and production-distribution check
passes 108 tests with five expected Windows-only cases skipped locally.
Architecture, documentation and preflight checks pass. The new Windows job
runs its portable contracts before building any native credential binding.

Previous combined result: `c70b5af7` in
[run 34245534377](https://github.com/adamallcock/tibotattle/actions/runs/34245534377)
passes both Mac package jobs and the Windows producer. Windows again proves
installation, two launches and credential persistence. The longer registry
budget resolves the unavailable probe; its final cleanup result now reports
`both_predicates_present` after a settled uninstaller exit. Installation-root
and uninstall-registration absence are not established. Inspect the actual
uninstaller invocation and bounded observation before changing another limit.

Linux normal startup reaches the correct title and overview heading, but the
first dashboard readiness marker remains false for the full thirty-second
wait (`SOURCE_SMOKE_RENDERER_READINESS_MARKER_FALSE_TITLE_TRUE_HEADING_TRUE_FAILED`).
The exact ASAR contains the primary web assets. The remaining distinction is
module/bootstrap evaluation versus the initial split local API reads, which
wait for the startup data snapshot. Preserve unavailable evidence; do not turn
the static heading into a successful app-load claim.

Next repairs are integrated at `f4ba5f96` (Windows) and `de27af48`/`a87c346b`
(Linux). The Windows harness now invokes the uninstaller in NSIS's documented
in-place mode with the validated installation root as the final argument. It
may remove only the unchanged, digest-bound uninstaller after registry removal
and proof that no other entries remain; directory removal is non-recursive and
the final independent absence checks remain authoritative. Linux's failed
readiness receipt now includes only allowlisted asset/API response classes,
completion states and exception location, plus four concurrent read-only local
API probes under a shared two-second diagnostic deadline. Existing readiness
and success predicates remain unchanged. Integrated source, staging, verifier,
gate and credential tests pass 119 cases with seven native/artifact-only cases
deferred. Architecture, documentation and preflight checks pass. The owning
runtime suite separately passes 43 cases with synthetic loopback enabled.
The later `57e82e63` result above proves the Windows cleanup repair; Linux
normal startup remains open.

Previous combined result: `b356656c` in
[run 34242621490](https://github.com/adamallcock/tibotattle/actions/runs/34242621490)
passes both Mac package jobs and the Windows producer. Windows again completes
installation, both app launches, FD3/FD4 credential continuity and uninstaller
settlement. The remaining cleanup failure is now specifically the uninstall
registry read deadline (`POST_UNINSTALL_REGISTRY_PROBE_TIMED_OUT`), not evidence
of a remaining installation or failed restart. The total post-uninstall budget
currently leaves less than ten seconds for a registry read whose own cap is
twenty seconds, because ten seconds are reserved for process termination. Give
that existing probe its full bounded budget while retaining absence predicates
and strict failure on an unavailable read.

Linux again passes normal candidate preparation and packaged native credential
checks. Its normal app receipt now preserves `SOURCE_SMOKE_RENDERER_FAILED`
after verified artifact binding; it does not prove initial refresh or the normal
credential lifecycle. Identify the specific renderer assertion before changing
product behavior. Preserve all earlier failed receipts and the distinction
between source, packaged credential and whole-app evidence.

The next candidate integrates `11330adf` (the bounded Windows cleanup repair)
and `d1ceaaef` (closed Linux readiness, origin, health, resource, navigation and
late network diagnostics). Linux startup waits and renderer predicates remain
unchanged. Readiness failures retain only three boolean results, never page
content. The source harness also validates its container before resolving a
default Electron executable (`8ed1346e`). The integrated owning tests pass 58
cases with five Windows-only cases deferred. Native results remain required.

Previous combined result: `0fc262cf` in
[run 34239981348](https://github.com/adamallcock/tibotattle/actions/runs/34239981348)
passes both Mac package jobs and the Windows producer. The fresh Windows
receipt proves successful installation, both complete app launches, FD3/FD4
credential continuity and successful uninstaller settlement. Only the final
cleanup proof is unavailable (`POSTCONDITION_PROBE_UNAVAILABLE`); distinguish
which predicate failed before changing behavior or time limits. The preceding
installer timeout did not repeat, and this result proves the restart repair.
Linux normal candidate preparation and the packaged Secret Service tests pass.
The normal Electron journey returns `SESSION_OUTPUT_INVALID` after verified
artifact binding, without a usable inner phase. Add bounded phase diagnostics
for actual startup/renderer/refresh/shutdown and session output; retain strict
success, networking and cleanup requirements. Those diagnostics are integrated
at `628279fb` (Linux) and `6b0ed7c4` (Windows); 77 focused tests pass with five
Windows-only cases deferred. The Windows receipt distinguishes registry
timeout, unsettled/start failure, nonzero exit and invalid output as well as
filesystem/poll failures. The Linux receipt preserves the app phase and
distinguishes execution, invalid receipt and stderr-only rejection. No
existing timeout or success assertion was relaxed.

Previous combined result: `7ee7b9b9` in
[run 34238600250](https://github.com/adamallcock/tibotattle/actions/runs/34238600250)
passes both Mac package jobs and the Windows producer. The fresh Windows NSIS
journey fails before installation completes: `INSTALLER_UNSETTLED`, no app
launches and no uninstall attempt. Its bounded receipt is retained. This run
cannot assess the restart repair. Linux's development distribution builds
successfully, but normal
candidate preparation rejects the 11-digit GitHub run ID against the bounded
build-number contract. The workflow now uses its shorter workflow run number
for both preparation and builder metadata. The regression expands the actual
workflow command and passes its arguments through the real production parser;
34 parser/distribution/workflow tests and 78 release-trust tests pass. The
Windows journey has terminated. The Linux correction is pushed at `0fc262cf`
in [run 34239981348](https://github.com/adamallcock/tibotattle/actions/runs/34239981348),
which also provides another observation of the unchanged Windows installer
path before any installer-timeout source change.

Previous combined result: `921e9ea8` in
[run 34238242221](https://github.com/adamallcock/tibotattle/actions/runs/34238242221)
stops at the package/verifier closure equality check before any app journey.
The independent verifier and its synthetic fixture also need the same two
module entries. Those exact entries are now updated; the complete CI packaging
contract command passes locally (41 tests, two optional native-artifact skips).
The preceding repair also completes a local unsigned Mac distribution build.

Preceding combined result: `8b84e971` in
[run 34236634828](https://github.com/adamallcock/tibotattle/actions/runs/34236634828)
fails all four distribution builds at `ELECTRON_RUNTIME_STAGED_MODULE_LINKAGE`.
The new Linux candidate contract checks pass, but normal Linux startup and
Windows installed relaunch are not reached. A local staged import reproduces
the cause: the Linux handover imports the fixed accountless backend, but the
shared shell staging inventory omits that module and its backing implementation.
The two-file inventory repair is integrated at `c9d5ddde`; actual staged linkage
and the 13 owning package tests pass. This result does not invalidate or extend
the earlier installed evidence; native packaging and app journeys need a new run.

Previous native results: `e65aacac` in
[run 34232097779](https://github.com/adamallcock/tibotattle/actions/runs/34232097779)
pass all four package jobs, including the repaired Windows artifact transfer.
The fresh Windows installed job completes installation, exact-byte checks and
its first whole-app launch, both credential checks and clean exit. The second
launch fails; cleanup runs but its postconditions are not verified. Source
inspection shows the harness generated a new test identity and repeated an
empty-store/create check on that restart. The integrated repair retains one
identity and checks the first launch's exact existing credential without
adopting or deleting an unknown record. Its focused checks pass (32 tests,
five Windows-only cases deferred). Preserve the failed receipt until a new
native run proves the repaired restart and uninstall boundaries.

The approved Linux normal candidate is integrated with fixed credential
adapters and strict stable Linux/x64 metadata selection. Its packaged harness
reuses the existing renderer, refresh, reload and clean-quit checks; it adds
fresh and unavailable Secret Service journeys using raw synthetic input. The
combined harness and workflow checks pass 63 local tests. The normal candidate
stays on the disposable runner with external networking disabled; only its
bounded receipt joins the existing development artifact. Actual normal Linux
execution remains pending a new combined CI run after the staging repair.

Preceding native results: `f09e504e` in
[run 34229064795](https://github.com/adamallcock/tibotattle/actions/runs/34229064795)
pass both Mac jobs and Linux. Linux now proves the new fixed observation
parent/child IPC route against the native store inside the packaged artifact,
after the separate legacy credential lifecycle. No earlier native test shares
that container's disposable credential store. Windows passes all native,
package and packaged-credential tests; its new artifact-transfer guard rejects
an unexpected hidden entry (`WINDOWS_RETAINED_ARTIFACT_HIDDEN_PATH_INVALID`).
No artifact is uploaded and the fresh installed job is skipped. Diagnose the
closed entry category without weakening the exact-content transfer guard.

The unsigned hosted rehearsal at `3136144f` now also has a private raw-session
fixture that classifies as fresh and produces two usage plus two quota records
in two v1.1 chunks. No indexed databases or real session data are pre-seeded,
and no app launch or hosted request has occurred. Actual hosted scheduling
still awaits the already-requested staging provisioning/deployment approval.

The preceding four-target results: `3136144f` in
[run 34225779614](https://github.com/adamallcock/tibotattle/actions/runs/34225779614)
pass both Mac jobs and Linux. Windows reaches its first installed launch and
fails specifically during the account-observation credential check over the
private parent/child channel. Installation, file verification, startup and the
separate accountless credential check precede that failure. The closed phase
is `ACCOUNT_OBSERVATION_STORAGE_PRIVATE_IPC`; uninstall runs but both recorded
postconditions remain false. The retained receipt identifies an existing
record at the initial observation read: the earlier packaged smoke intentionally
leaves its synthetic record until the disposable runner account is destroyed.
Both tests ran under that same account. Run the installed journey on a separate
fresh hosted runner using the exact retained artifact; preserve both tests and
their refusal to accept an unknown existing credential.

The unsigned installed-scheduler rehearsal is frozen at `3136144f` and built
for Mac arm64 using the existing TiboTattle Dev identity. Its compiled profile
fixes the staging destination and confines settings, sources and installation
credentials to a separate subtree. No app launch or hosted request has occurred.
Its package verifier passes; focused runtime, scheduler and packaging checks
pass, as do all 333 owning companion tests. The staging Worker is separately
frozen at `086ae315`, with a source-only plan and no remote provisioning.
This keeps hosted approval concrete while leaving normal development packages
and the separately prepared signed Mac migration pair unchanged.

Linux observation composition now reuses the fixed Windows read/create IPC
mechanics. The explicit Linux qualification entrypoint, companion selector and
packaging inventories are connected; normal production selection stays closed.
Local validation passes 333 companion tests, 108 focused contracts, 24 inventory
checks (two artifact-only exclusions), and a real Linux child/accountless IPC
coexistence check. The packaged native observation journey now passes at
`f09e504e`; normal production composition and an ordinary packaged Electron
launch remain the next gates. No source or native-only result establishes
installed Linux readiness.

The user explicitly approved the isolated Linux candidate work on 2026-09-08,
resolving the earlier automatic-review refusals. This covers connecting the
fixed credential adapters, replacing the unconditional startup block with
strict stable Linux/x64 validation, and running the candidate in disposable CI
with external networking disabled. Malformed metadata, other targets,
rehearsal selections and mixed test/qualification lanes remain refused.
The source change and ordinary packaged launch harness are being integrated;
no candidate runtime result, release or public update-feed change is implied.

The preceding four-target results: `a648cf2b` in
[run 34222727976](https://github.com/adamallcock/tibotattle/actions/runs/34222727976)
passes both Mac jobs and the complete Linux job. The Linux packaged Secret
Service gate now passes its real native read deadline and cleanup. Windows
passes both process probes, native contracts, packaging and packaged credential
journeys. Its NSIS receipt proves installation and the first installed-byte
check, then records failure during the first launch before a completed launch
is counted. Cleanup ran the uninstaller, but its two postconditions remain
false. Preserve those separate failures and add a closed phase diagnostic to
identify the first-launch cause. Production composition and installed updates
are not qualified by these development checks.

The preceding four-target results: `45d5ec15` in
[run 34219167483](https://github.com/adamallcock/tibotattle/actions/runs/34219167483)
passes both Mac builds, including the real startup-verifier regression. Windows
still times out in both the exact-executable and Toolhelp native probes, before
the installed lifecycle. Removing WMI did not resolve the common cause. The
passing registry probe uses only .NET APIs; the failing probes also require
PowerShell utility-module loading under the closed child environment. That is
the next causal check, not yet a verified fix. The prerequisite test now runs
before native compilation and installer packaging to shorten feedback.
Linux reports `SERVICE_DEADLINE_NATIVE_READ`: the separate diagnostic reaches
the read boundary on the native runner and returns before the required wait.
The original read operation remains the qualification criterion; a successful
create diagnostic cannot satisfy it. Both original failures and logs remain
retained. Neither installed Windows lifecycle nor the full Linux credential
journey is qualified.

The `a648cf2b` native rerun includes the fixed system PowerShell module path and
explicit Utility import used by both Windows process probes. Linux now runs
its original read against the standard no-response test service on a new
private D-Bus session, verifies the spawned service owner's PID, and measures
the native read separately from fixture setup and cleanup. The read must still
fail as unavailable after at least four seconds and before nine seconds.
The combined local contracts pass 61 tests, with eight native-only exclusions.
Native CI now passes these repaired prerequisites as described above.

The preceding four-target results: `611200c7` in
[run 34215345667](https://github.com/adamallcock/tibotattle/actions/runs/34215345667)
passes both Mac builds. Windows's new native empty-result process regression
uses WMI and fails after its settlement deadline, before the installer
journey. The name filter did not resolve that dependency; both process-inspection
paths need one bounded native replacement. Linux again fails the service-deadline
fixture in about one second. The nested-runner environment defect was real but
was not the only cause. Preserve the failure while obtaining the actual nested
child boundary on the native runner; emulation is diagnostic only. The local
emulator cannot acquire the abstract Unix credential lease, so it cannot
establish the cause of this native failure.
No installed Windows lifecycle or complete Linux credential journey is qualified.

The integrated Windows repair at `146ece1a` removes WMI from both process
proofs. A fixed Toolhelp query supplies real parent PIDs and process creation
identities; the post-exit proof rechecks only retained PIDs. The early Windows
regression now exercises this actual helper in the lifecycle's closed child
environment, including a real child and its exit. Both native probes still
fail at `45d5ec15`; the API replacement does not close their common failure.

Hosted preparation at `086ae315` fixes the rehearsal target to the isolated
staging Worker and leaves checked-in accountless admission disabled. The
source-only plan names the two staging databases, quarantine bucket, fresh
migrations, isolated envelope keys, temporary accountless admission and final
containment restoration. The hosted client uses only synthetic records and
retains private recovery state if disconnect is uncertain. Integrated client,
endpoint and Windows tests pass 92 cases with five native/hosted exclusions;
the staging plan/readiness checks pass 27 cases. Remote provisioning,
deployment, migrations and the synthetic hosted run await explicit approval.
This is client preparation, not installed background-scheduler proof, and
accountless records remain excluded from public aggregates.

The Mac verifier correction is frozen at `19c63f7b`. Its native regression
uses a canonical-path disposable bundle and bounded real `codesign` calls;
twelve credential tests and four focused handover/runtime tests pass. Both Mac
CI lanes now include that native regression. Replacement source candidates
`0.1.19-native-to-electron-handover.3` and `.4`, build numbers `2026090803` and
`2026090804`, are staged for Apple Silicon and Intel. All four staged manifests,
changed app files, helper contracts and compiled adapter targets are verified.
They are unsigned; explicit approval for the corrected signing/notarization
submission is pending. Contributions remain disabled in this private pair.
The previous signed fixtures and the failed installed attempt remain retained.

The preceding four-target results: `45fde21e` in
[run 34206887816](https://github.com/adamallcock/tibotattle/actions/runs/34206887816)
passes both Mac builds. Linux now passes observation creation, readback,
no-replace and recovery/refusal phases; its terminal service-deadline fixture
fails before reaching the expected five-second wait. Windows passes installation,
paired registry inspection, uninstaller availability and the first installed-byte
identity check, then its exact-process pre-launch probe fails. No installed app
launch or restart is qualified. These findings led to the subsequent
fixture/probe repair and native rerun above. Hosted
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

The preceding Windows process repair used a fixed executable-name filter before its
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
