---
title: Complete the native and Electron update paths
date: 2026-09-11
type: plan
status: complete
---

Electron 0.1.21 is published for macOS Apple silicon, macOS Intel, Windows x64
and Linux x86_64. Both native Sparkle feeds and all four Electron feeds now
serve it. Normal updates from native 0.1.18 and Electron 0.1.20 passed on both
Mac architectures, preserving history, settings and opt-out. The approved empty
website-journal recovery is complete; its original evidence remains retained.

## Final checkpoint: 2026-09-11

- Frozen application source: `a651ea130dd1460e4443a037c4434f57b911fec4`;
  version 0.1.21, provenance build `2026091107`, Mac bundle version `1028`.
  Annotated tag object `bdeb3770c065e2c4c2901a8ddae909a1c15550b5` points to
  that source. Release-tooling changes do not alter the signed app bytes.
- [GitHub release](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.21)
  `386805979` is public and immutable. All 20 assets were freshly downloaded and
  verified before and after publication, including final reconciliation.
- Both native feeds and all four Electron feeds match their exact prepared
  bytes. Final Electron readback reports four targets verified, with no upload.
- [Homebrew PR4](https://github.com/adamallcock/homebrew-tap/pull/4) merged as
  `9b5547c56997eb5d2fd9251b51fc5b817ecafc66` after both native architecture
  audit/install/uninstall jobs passed. Main's cask and workflow match the
  reviewed bytes.
- [Website](https://tibotattle.com/) source
  `9accd6f08a8bc519868f24a970b619e5e0e2a5f0` is live. All 24 public files
  match the prepared bytes. All four GitHub download links and 24 actual
  checksum-copy interactions passed across three languages and two widths;
  documentation, community rendering and social metadata checks passed.
- The canonical coordinator resumed the original operation from matching public
  state and finished with `complete: true`, `writesAttempted: false`, all five
  surfaces matching and `coordination: released`. Every journal step is verified.
  The separate website and Electron feed owners are also released.
- Isolated native upgrade and empty-profile signed installation checks passed
  before publication. Fresh-install sharing defaults and persistent opt-out
  passed on both Macs; these fixtures do not claim existing-credential migration
  or a new live upload rehearsal.
- Windows signed install, processing, restart and uninstall passed in
  [run 34561980268](https://github.com/adamallcock/tibotattle/actions/runs/34561980268).
  Linux packaging passed in
  [run 34561981708](https://github.com/adamallcock/tibotattle/actions/runs/34561981708).
  Retained physical Intel and Windows/Linux acceptance remains owner accepted;
  it is not additional executed test evidence.

### Actual production updates

| Unchanged predecessor | Apple silicon | Intel |
| --- | --- | --- |
| Native 0.1.18 using its bundled Sparkle feed | [34568465222](https://github.com/adamallcock/tibotattle/actions/runs/34568465222) passed | [34569099253](https://github.com/adamallcock/tibotattle/actions/runs/34569099253) passed |
| Electron 0.1.20 using its bundled Electron feed | [34568883471](https://github.com/adamallcock/tibotattle/actions/runs/34568883471) passed | [34568884736](https://github.com/adamallcock/tibotattle/actions/runs/34568884736) passed |

All four receipts bind the final source, installer, ASAR and live feed. They
verify actual updater replacement/relaunch, retained rows, salt, preferences,
opt-out, duplicate-free restart and owned-process cleanup. No feed override or
runner copy installed the successor. Existing credentials were absent from these
synthetic accounts, so that separate claim is deliberately excluded.

The following sections preserve earlier findings and failed-run provenance.
The checkpoint above is the final release status.

## Earlier qualification

- Published website source 7b6cfdc9aef269ffc27885d02e8c75e7ff88bdcd restores
  compact download controls and exact GitHub 0.1.20 asset links. Live desktop,
  mobile, locale, checksum and metadata checks passed. The approved empty
  deployment-journal recovery preserved the original journal; deployment
  completed and released its shared owner.
- Manual native-state replacement with signed 0.1.20 passed. This does not
  establish delivery through Sparkle.
- The canonical incoming Sparkle generator and publisher now have an explicit
  Electron transition receipt, separate from embedded application updater
  metadata. Native receipt validation, key continuity, artifact validation and
  atomic feed replacement remain in use.
- The first Sparkle candidate used application source
  dd9e99f38b3802746de88b76160fdbb56051edeb, version 0.1.21,
  provenance build 2026091106, Mac bundle version 1028. It is superseded by the
  public-key compatibility correction below and will not be published.
- That candidate's Mac applications and outer disk images are signed, notarized
  and stapled. Its Windows installer passed the hosted install, processing,
  restart and uninstall journey (run 34559592872). Linux packaging passed
  (run 34559594120); this is not a new installed Linux acceptance run.
- Both installed Mac update runners are prepared: native 0.1.18 through Sparkle,
  and released Electron 0.1.20 through its unchanged production updater.
  Their contract tests passed; actual installed execution remains below.

## Installed findings and correction

Apple Silicon run 34561060979 reached the actual Check and Install controls,
then Sparkle rejected the successor. Pinned Sparkle 2.9.3 forbids removing the
predecessor's public update key; the signed Electron bundle omitted it. Both
old and new signing identities match and their signatures are valid. The
correction retains the exact public SUPublicEDKey as passive signed metadata.
Electron remains the only outgoing updater. No signature checks are relaxed.

Intel run 34561079561 stopped at the About menu; no update was attempted. Its
runner now opens the app menu once and waits for its item, with bounded
diagnostics from only the synthetic process. Repeated clicks previously could
toggle the menu while accessibility information was still arriving.

The corrected application source is
a651ea130dd1460e4443a037c4434f57b911fec4, provenance build 2026091107.
Both Mac applications and disk images are signed, notarized, stapled and retain
the verified native public key. Windows run 34561980268 passed signing and
the installed processing/restart/uninstall journey. Linux packaging run
34561981708 passed; it does not add a new installed Linux acceptance claim.

The corrected isolated feeds and their exact installers were uploaded with
all four R2 and public readbacks verified; the shared owner was released.
Native ARM run 34562927824 passed actual Check, Install, updater relaunch and
first migration, then stopped because the runner misclassified the signed
same-executable companion as a second independent app. The runner now selects
the unique process-tree root, retains descendant ownership checks and still
refuses independent app roots. Restart and final preservation remain unproven.
Intel run 34562929758 lost its accessibility menu before Check; the prior
diagnostic reached Check but lost all accessibility windows afterwards.
Bounded direct Accessibility and window-count diagnostics now distinguish API
failure from an empty UI. Neither failed run is a release qualification.

Apple Silicon run 34563532865 subsequently passed the complete actual native
update, migration, repeated restart, preservation and owned-process cleanup.
Its source, build, DMG, ASAR and isolated feed are the corrected identities
above. This fixture does not contain an existing credential and does not prove
the later production-feed path.

Intel macOS 26 run 34563534703 reported Accessibility `cannot_complete` despite
permission being present. The isolated macOS 15 comparison, run 34564076590,
reached Check and Install before the UI reader failed during installation.
The runner now tolerates a closing window during a read, while refusing to
repeat a click whose outcome is unknown. Run 34564895606 tests that correction
against the same signed Intel artifact. No app rebuild or security change is
part of this test-tool correction.

Fresh-install qualification is separate from the native upgrade fixture. Its
manual workflow starts the exact signed app without predecessor, Codex home,
usage records or credentials, checks first-run sharing and Settings controls,
then verifies default and opt-out persistence across controlled restarts. It
does not claim native quit, credential persistence or successful uploads.
At that checkpoint publication was held for Intel and clean-install receipts;
the successful later receipts are recorded above.

The publication coordinator now reuses the established release-evidence
contract from the website verifier and reconciles the exact four-target
Electron inventory plus incoming native feeds. Its 24 owning tests pass.
The native runner and diagnostic fixes pass 25 tests. These are tooling
checks; the frozen application artifacts remain unchanged.
All failed receipts and superseded installers remain preserved. Publication
was held until the corrected installed journeys succeeded; the exact tag and
immutable release are now recorded above.

## Activation and recovery evidence

The closed coordinator plan digest is
`e29f8af53adcb551a3b70ec1910eb6e9b08b27f46017c3c1d69d7ec9dbb44b87`.
Its original operation `bc850ff6-1ac1-4ac1-b9b5-01e16463ef9d` is reconciled with
all steps verified and its owner released. Website operation
`dbcf451c-237d-41ee-9583-daa8913736f2` reports `PRODUCTION_DEPLOYED`, verified and
released. Electron feed operation `a85485b8-fa1c-4a52-b611-1d4fe6015df7`
completed all 14 object writes and a subsequent read-only four-target check.
No production database migration was repeated during this release closure.

Two release-tool defects were corrected without changing application artifacts:

- The first native feed publication consumed the environment credential, leaving
  none for the second architecture. The Intel attempt stopped before any local
  input or provider I/O. One explicit canonical-provider recovery published
  Intel, and ordinary reconciliation closed its original intent. The coordinator
  now consumes the credential once into a private guard reused for both targets.
- The website deployed successfully, but the coordinator rejected the host's
  normal `.html` redirects. It now checks canonical routes directly, retains
  strict redirect refusal, and requires exact bytes without normalization. The
  original website intent closed from matching live state; no redeployment ran.

The real Electron update test also exposed two verifier defects: selection of
an already running companion and a cached ASAR header after same-path archive
replacement. The runner now identifies the actual new process and invalidates
only the library's archive cache. Both failed runs per architecture remain
retained; the subsequent production runs in the table passed. The tested
Intel Accessibility runner is macOS 15. Application security and updater
validation were not weakened.

[PR119](https://github.com/adamallcock/tibotattle/pull/119) retains these release
and test-tool corrections. Validation includes the 123-pass integrated owning
suite (one existing pinned-tool skip), 82 release-trust checks, 27 final
publication tests and the four real Mac production-update runs. Private release
staging retains the operation records, failed attempts, final reconciliation,
website verification and individually hashed installed receipts.

## Version and qualification boundaries

The Mac bundle allocation follows the existing
[decision](../decisions/2026-09-11-electron-macos-bundle-version-allocation.md).
Electron update selection uses the marketing version; timestamp provenance
does not become a new Apple bundle-version grammar.

The public signed 0.1.20 app disables Node CLI inspection through its Electron
fuses. Its main process cannot be redirected through an inspector without
altering the signed artifact. We will not weaken that fuse or present a
modified fixture as the released app. Its unchanged production update was
therefore verified by the post-activation acceptance runs above.

The incoming native test uses the documented Sparkle UserDefaults feed override
only on disposable accounts. Its receipt labels that scope explicitly;
its `productionFeedVerified` remains false. The later bundled-feed runs above
carry their own true production-feed receipts.
See the [Sparkle customization documentation](https://sparkle-project.org/documentation/customization/)
and [Electron fuse documentation](https://www.electronjs.org/docs/latest/tutorial/fuses).

Operational owners remain the
[Mac stable release runbook](../runbooks/macos-stable-release-runbook.md) and
[cross-platform publication runbook](../runbooks/2026-08-18-cross-platform-release-publication.md).
