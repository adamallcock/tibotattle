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
- Corrected application source is frozen at
  dd9e99f38b3802746de88b76160fdbb56051edeb, version 0.1.21,
  provenance build 2026091106, Mac bundle version 1028. Previous signed
  0.1.21 candidates remain historical evidence; they will not be published.
- Both final Mac applications and outer disk images are signed, notarized and
  stapled. The final Windows installer passed its hosted install, processing,
  restart and uninstall journey (run 34559592872). Linux packaging passed
  (run 34559594120); this is not a new installed Linux acceptance run.
- Both installed Mac update runners are prepared: native 0.1.18 through Sparkle,
  and released Electron 0.1.20 through its unchanged production updater.
  Their contract tests passed; actual installed execution remains below.

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
