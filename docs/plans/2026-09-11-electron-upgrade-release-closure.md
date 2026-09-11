---
title: Complete the native and Electron update paths
date: 2026-09-11
type: plan
status: in-progress
---

The public Electron 0.1.20 release did not complete the native update path:
both native Sparkle feeds still advertise 0.1.18. The owner approved correcting
the established release process and qualifying the installed update before
another app publication. This plan records remaining work, not completed
installed evidence.

## Completed

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

The publication coordinator now reuses the established release-evidence
contract from the website verifier and reconciles the exact four-target
Electron inventory plus incoming native feeds. Its 24 owning tests pass.
The native runner and diagnostic fixes pass 25 tests. These are tooling
checks; the frozen application artifacts remain unchanged.
All failed receipts and superseded installers remain preserved. The local
annotated v0.1.21 tag has not been pushed, and public publication remains held
until the corrected installed journeys succeed.

## Isolated Intel host comparison

The comparison branch changes only the Intel workflow host to
`macos-15-intel`, which remains an available x64 image in
[GitHub's runner inventory](https://github.com/actions/runner-images#available-images).
The Apple Silicon host remains `macos-26`. Signed native 0.1.18 and Electron
0.1.21 artifacts, source binding, exact UI actions, deadlines, permission
policy and preservation checks remain unchanged.

Intel macOS 26 run 34563534703 is retained as a failure: the owned app was
running, active and regular, and the accessibility client was trusted, but
both menu and window requests returned `cannot_complete`. Core Graphics
reported five owned windows; that does not establish a usable update UI.
A successful macOS 15 comparison would qualify only that observed host and
would not fix or erase the unresolved macOS 26 Intel result. The comparison
has not yet run. The later Apple Silicon run 34563532865 passed its complete
installed transition; this is separate from the Intel comparison.

## Remaining sequence

1. Collect the finalized four-target artifact receipts from the completed
   packaging and signing jobs. Keep the resulting artifact identities immutable.
2. Generate isolated Sparkle test feeds with the existing native stable key
   and pinned official Sparkle tools. Only the disposable hosted accounts
   receive a test-feed preference; signed application bundles remain unchanged.
3. On Apple Silicon and Intel, install the exact native 0.1.18 predecessor,
   retain synthetic records, language, appearance and contribution opt-out,
   click its actual Check for Updates and Install controls, and verify the
   updater-created Electron launch, migration and repeated restart.
   A manual candidate copy, missing safety field or mismatched artifact
   cannot qualify publication. Existing-credential coverage is recorded
   separately and is not claimed by this fixture.
4. Complete canonical publication preflight and coordinate GitHub assets,
   native Sparkle feeds, Electron stable feeds, Homebrew and website.
   The previous owner approvals remain applicable; no publication happens
   merely because a source test or signing step passes.
5. Immediately after activation, run two production acceptance paths using
   unchanged signed predecessors: native 0.1.18 with its bundled Sparkle URL,
   and Electron 0.1.20 with its bundled Electron update URL. Verify the actual
   replacement and retained state. Record these separately from test-feed proof.

## Version and qualification boundaries

The Mac bundle allocation follows the existing
[decision](../decisions/2026-09-11-electron-macos-bundle-version-allocation.md).
Electron update selection uses the marketing version; timestamp provenance
does not become a new Apple bundle-version grammar.

The public signed 0.1.20 app disables Node CLI inspection through its Electron
fuses. Its main process cannot be redirected through an inspector without
altering the signed artifact. We will not weaken that fuse or present a
modified fixture as the released app. Its unchanged production update is
therefore a post-activation acceptance step.

The incoming native test uses the documented Sparkle UserDefaults feed override
only on disposable accounts. Its receipt labels that scope explicitly;
productionFeedVerified remains false until the later bundled-feed test passes.
See the [Sparkle customization documentation](https://sparkle-project.org/documentation/customization/)
and [Electron fuse documentation](https://www.electronjs.org/docs/latest/tutorial/fuses).

Operational owners remain the
[Mac stable release runbook](../runbooks/macos-stable-release-runbook.md) and
[cross-platform publication runbook](../runbooks/2026-08-18-cross-platform-release-publication.md).
