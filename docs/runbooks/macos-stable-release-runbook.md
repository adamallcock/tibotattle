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

## Current Electron production-update acceptance

After the exact 0.1.28 GitHub artifacts and ordinary Electron stable feeds are
published, run `electron-macos-production-update.yml` in `plan` then `execute`
mode for **both** `darwin-arm64` and `darwin-x64`. Use
`tibotattle-production-electron-update-intake-v3` in `identity_json`, together
with the unchanged candidate `sourceCandidate` receipt. Its closed fields are
`schemaVersion`, `target`, `sourceRevision`, `buildNumber`, `version`,
`bundleVersion`, `dmgSha256`, `asarSha256`, `zipSha256`, `feedSha256`, and
`predecessorAsarSha256`; the workflow supplies `directory`. V3 admits only
0.1.26 → 0.1.28 (bundle 1034 → 1036), with provenance build `2026100901`.
The source receipt independently binds 0.1.28's source and that build. No
predecessor or feed URL override is accepted. Execute retains
`RUN_DISPOSABLE_PRODUCTION_ELECTRON_UPDATE`. Historical v2 remains exclusively
0.1.26 → 0.1.27; its artifacts and receipts do not qualify the replacement.

The immutable [0.1.26 manifest](https://github.com/adamallcock/tibotattle/releases/download/v0.1.26/release-manifest.json)
(SHA-256 `be65a83f8c1f060b7c5cf6141b6332c02df730dc1a2aac696442e4e433c123cc`)
binds source `acfc385c95b49b8e1040cedfa857659b49a61d8d` and these predecessor
DMGs:

| Architecture | DMG SHA-256 |
| --- | --- |
| Apple silicon | `7b5f66d91c9f1b8c1537505da860c67177d2b489ee6fb90d445d97c7e46cc9ec` |
| Intel | `3806a1ce2650350b69faff759287c08a5f146acfb9c26e3b3b04abb5cf8896c3` |

The runner verifies those downloaded bytes, signed bundle, architecture,
0.1.26 package/source, provenance build `2026092701`, and bundle version `1034`
before launching the predecessor. The public manifest does not publish an ASAR
hash: derive `predecessorAsarSha256` from the exact pinned DMG and retain that
inspection; the runner compares the installed archive with it. A supplied hash
or planned receipt alone is not artifact verification.

Before launching the predecessor, the runner snapshots that verified archive
into private scratch and uses its public local-index API to create synthetic
retained state and read the baseline. This keeps 0.1.26 state at format 11 until
the installed successor performs the real forward migration to format 12.
Post-update continuity reads use the current API; neither database version labels nor the
signed application are modified to make the predecessor accept newer state.
The scratch snapshot is removed after baseline inspection, including on failure.

For v3, the verified predecessor's normal ingestion API builds the retained
index from a synthetic usage source. The fixture then retires only that owned
source and keeps a separate metadata-only rollout discoverable. This makes
ordinary startup refresh eligible without adding usage or quota observations.
The artifact regression checks repeated predecessor and successor refreshes,
including retained rows and the explicit partial-provenance state. This journey
qualifies an upgrade with a discoverable source; profiles with no surviving
source files require separate qualification.

For v3, the runner passively waits for the updater-created successor to publish
format 12 before checking first-launch continuity. An intact format-11 baseline
can remain visible while ordinary refresh migrates a staging copy. Each poll
checks the same successor process identity; current-format read failures, an
invalid predecessor index, a changed process or an expired deadline fail the
check. The runner never migrates the database, forces refresh, or restarts the
app to manufacture first-launch readiness.

The ordinary Settings check/download/install/restart path must replace the
app with the exact published candidate and preserve rows, settings, salt and
recorded opt-out. V2 and V3 require every captured predecessor process identity,
including an orphaned companion, to exit before accepting the updater-created
successor; later cleanup cannot satisfy that observation. Capture binds each
process command and start time from one bounded inventory sample. The complete
predecessor snapshot must validate before Install is invoked; an unresolved
live identity fails closed and cannot overwrite a previously verified identity.
Retain the separate
`tibotattle-signed-macos-production-update-v3` receipt for each architecture.
It keeps `existingCredentialFixture: false`: the signed credential fixture is
still a distinct gate. The historical intake/receipt v1 (0.1.20 predecessor)
and v2 (0.1.26 → 0.1.27) retain their existing meanings.

This is post-activation acceptance of the real production feed. It does not
create a prepublication updater lane, rewrite signed apps, change feed URLs,
or substitute plan/source tests for installed evidence. The workflow runner
revision must descend from the frozen application source at the same package
version; the app source and original candidate receipt are never rewritten.

## Native Keychain migration gate

The [handover runbook](./2026-09-07-macos-native-to-electron-handover.md) owns
state recovery, helper behavior and preserved sharing choice. The
[synthetic credential fixture](../../test/fixtures/macos-keychain-migration/README.md)
and `electron-macos-credentials.yml` exercise existing credentials on a signed
installed Electron replacement. A passing synthetic journey does not prove all
failure paths or every user Keychain state. Unexpected Keychain prompts block
release; do not broaden key access or automate approval. The 0.1.28 credential
journey retains the synthetic historical unknown → Sol 6.1 repair, repeat and
restart checks introduced for 0.1.27. It uses the existing disposable credential
predecessor and requires new receipts for the exact replacement bytes; the
production-update predecessor above does not change that fixture contract.
The nested historical repair receipt is `tibotattle-historical-sol-installed-v2`
with `parser18To20Repair: true`: historical unknown/parser18 evidence must
become exact current/parser20 evidence while preserving occurrence identity,
tokens and the known fixture. Stale, future and partial parser stamps refuse
qualification. Frozen v1/parser18-to-19 receipts retain their old meaning and
cannot qualify the replacement.
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
