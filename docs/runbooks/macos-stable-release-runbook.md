---
title: macOS Electron release and native upgrade feeds
date: 2026-09-28
type: runbook
status: maintained
---

# macOS release and incoming native upgrades

Electron owns new macOS application builds. The native AppKit source and its
builder have been retired. Existing native 0.1.18 installations still receive
Electron through their signed Sparkle feeds. This runbook covers the macOS
qualification boundary; follow [cross-platform publication](./2026-08-18-cross-platform-release-publication.md)
and [exact publication reconciliation](./release-publication-reconciliation.md)
for the complete release and its remote surfaces. Source checks, signed
artifacts, installed journeys and public readback are separate evidence.

Secrets and exact retrieval commands stay in the private release-machine
runbook. Never place credentials, private paths, signing logs or staging
journals in a public manifest or updater receipt.

## Separate Apple silicon and Intel candidates

Freeze one reviewed source and two architecture-specific signed Electron DMGs.
Each target needs its own artifact digest, trust inspection, installed evidence
and publication receipt. The ordinary GitHub installer name and the legacy
Sparkle enclosure alias can differ, but their bytes and digest must match.

| Target | Feed retained for native installations | Installed qualification |
| --- | --- | --- |
| Apple silicon (`arm64`) | `/appcast.xml` | Native 0.1.18 to signed Electron on Apple silicon |
| Intel (`x64`) | `/intel/appcast.xml` | Native 0.1.18 to signed Electron on Intel |

Both feeds retain their stable signing key and atomic publication guard. The
Electron app also has its separate outgoing updater feeds. Do not substitute an
Electron YAML feed for either native Sparkle feed. The signed Electron
`Info.plist` retains native 0.1.18's public `SUPublicEDKey` as a passive
compatibility value; it does not run a second updater.

## Native Sparkle to Electron transition

1. Prepare the signed, notarized and stapled Electron candidate and its updater
   ZIPs using the Electron release path. Verify its exact bundle version,
   architecture, ASAR digest, native handover helper, public key, code signature
   and outgoing updater configuration. The reviewed bundle allocation is in
   [the decision record](../decisions/2026-09-11-electron-macos-bundle-version-allocation.md).
2. Run `npm run product:macos:transition:test` for the retained source contracts.
   It prepares pinned Sparkle tools and checks historical predecessor manifests,
   key continuity, signed feeds, publisher rules and Electron transition logic.
   This is not installed-app evidence.
3. Generate isolated signed incoming appcasts with
   `scripts/generate-sparkle-appcast.js --electron-transition` and
   `--electron-transition-test-source` for the exact candidate. The test
   namespace is `electron/test/native-sparkle/<source>/<bundleVersion>/<dmgSha256>/`.
   The production publisher refuses that namespace.
4. Dispatch `electron-macos-sparkle-transition.yml` on both hosted Mac
   architectures, binding its closed release identity to the exact source,
   signed installer, ASAR and test feed hashes. Use the immutable signed native
   0.1.18 predecessor. Its real Check for Updates and Install controls must
   install Electron and preserve rows, settings, device salt and recorded
   opt-out across relaunch and restart. The workflow's test-feed override is
   confined to its disposable account. An ARM receipt does not qualify Intel.
5. Attach both passing, exact-byte receipts to the
   `tibotattle-electron-sparkle-transition-v1` publisher receipt. Revalidate
   the signed mounted DMGs, predecessor manifests, source tag and incoming key
   before preparing final appcasts. The signed native 0.1.18 DMG and its
   published manifest are predecessor inputs; rebuilding the retired app is
   neither possible nor necessary.
6. Coordinate the final GitHub release, Electron feeds, both guarded Sparkle
   feeds, Homebrew cask and website through the cross-platform runbook. After
   publication, read back each public surface and rerun the native journeys
   with `production_feed` and no test override. Separately run
   `electron-macos-production-update.yml` from the pinned released Electron
   predecessor. Keep test and production receipts distinct.

## Native Keychain migration gate

The [handover runbook](./2026-09-07-macos-native-to-electron-handover.md) owns
state recovery, helper behavior and preserved sharing choice. The
[synthetic credential fixture](../../test/fixtures/macos-keychain-migration/README.md)
and `electron-macos-credentials.yml` exercise existing credentials on a signed
installed Electron replacement. A passing synthetic journey does not prove all
failure paths or every user Keychain state. Unexpected Keychain prompts block
release; do not broaden key access or automate approval.
Signing-key access on the release machine is a separate owner provisioning
step; it does not authorize routine app Keychain prompts.

## Current-candidate admission

The Mac qualification workflows admit an exact source candidate before
installing verification dependencies or downloading artifacts. Supply the
unchanged `production-source-candidate.json` receipt as the `sourceCandidate`
member of the workflow identity. The shared
[`electron-macos-qualification-identity.mjs`](../../scripts/lib/electron-macos-qualification-identity.mjs)
checks source, runner, package version, bundle allocation and provenance build
against the selected target. It does not allocate a version or mark an
installed test as passed. Keep predecessor pins unchanged unless their separate
compatibility contract is reviewed.

Run `node --test test/electron-macos-qualification-identity.test.mjs` for admission
regressions. The two installed transition receipts, clean-profile receipts,
existing-credential result and Electron-to-Electron updater receipts remain
separate gates, each bound to signed candidate bytes.

## Publication and readback

The final appcasts use the pinned official Sparkle `generate_appcast` and
`sign_update` tools. `scripts/publish-sparkle-update.js` validates the
transition receipt, exact predecessor manifest, signed feed, enclosure,
source provenance and stable key. Publish only after the corresponding
protected release and exact candidate have qualified. The publisher uses
architecture-specific immutable R2 keys and an authenticated atomic appcast
guard. The public appcast must be re-fetched and verified after a write.

`scripts/reconcile-release-publication.mjs` compares the canonical manifest,
GitHub assets, both native appcasts, Electron feeds, tap and website. Its default
mode is read-only; remote writes remain separate protected operations. A
successful source test, prepared plan or saved operation journal is not proof
that those surfaces are live or synchronized.
