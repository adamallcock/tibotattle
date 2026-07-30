---
title: Usage Monitor macOS Release Runbook
date: 2026-07-29
type: runbook
status: implemented-foundation
---

# Usage Monitor macOS release runbook

This directory contains the native foreground launcher and the release
contracts for a self-contained Usage Monitor app. The ordinary developer build
is usable locally but is not a public installer. The external-distribution path
fails closed unless production service configuration, approved artwork,
Developer ID signing, Apple notarization, stapling, Gatekeeper assessment, and
a clean-profile smoke all succeed.

## Consumer lifecycle in the app

1. Launch **Usage Monitor.app**.
2. On the first launch, review the one-time **Get Started** disclosure. It
   explains exactly which Codex metadata can be read after an explicit Analyze
   action, what owner-only local state is retained, which content is excluded,
   how optional contribution stays off, and what happens when the browser or
   app closes. The acknowledgement is an owner-only local receipt; moving local
   app data to Trash makes the disclosure appear again.
3. The native window starts one private loopback companion on an ephemeral
   port. Nothing is scanned or uploaded merely because the app launched.
4. Choose **Open Dashboard** and explicitly start local analysis.
5. If the companion fails or exits, choose **Retry**. The app does not require
   a relaunch for ordinary recovery.
6. Choose **Data & Diagnostics…** to see and copy a fixed, path-free diagnostic
   receipt. Startup and lifecycle failures include a stable `UM_MACOS_*` code
   and a fixed recovery action.
7. Choose **Codex Source…** to select a custom `CODEX_HOME` with the native
   folder picker, or restore `~/.codex`. The selection is revalidated at every
   launch and stored only in the owner-only app state; copied diagnostics expose
   only `default` or `custom`, never the path.
8. Choose **Open Codex** to open Codex in the ChatGPT desktop app. If the app is
   unavailable, Usage Monitor offers the official help page.
9. Choose **Version & Updates…** to check a signed production appcast. Developer
   and ad-hoc builds contain no updater framework and perform no update
   networking.
10. A trusted website or browser bookmark may use `usagemonitor://open` to
   activate the app and open its loopback dashboard. All other hosts, paths,
   credentials, queries, and fragments in that custom scheme are rejected.
11. Closing or quitting the native app stops the companion. No daemon or login
   item is installed. After an explicit reviewed first contribution, the user
   may enable six-hour contribution while the app remains open.

Keep the app open while local analysis runs. Closing only the dashboard tab
hides progress; reopen it from the app. Quitting the app stops the current pass,
while already published checkpoints remain available on the next launch.

The troubleshooting-only local erase action moves only
`~/Library/Application Support/Usage Monitor` to Trash after the companion has
stopped. It does not modify Codex logs, revoke already-sent community data, or
remove a pseudonymous identity stored in Keychain.

The separate **Identity & Device Reset…** diagnostic action remains available
for support cases. It has two native confirmation steps and targets exactly two
local Keychain capabilities:

- the pseudonymous export identity; and
- the paired contribution-device credential.

Before touching Keychain, it stops the companion and validates the two exact
local residue files. Other indexes, cached analysis, prepared contributions,
settings, account-observation keys, Claude-session pseudonym keys, and Codex
logs remain. The action does not revoke a hosted device or delete hosted data;
those require the hosted privacy workflow. It does not claim secure erasure.
After the reset, future contribution activity uses a new identity and requires
pairing again.

The ordinary uninstall journey is simply: quit Usage Monitor and move
**Usage Monitor.app** to Trash. Advanced local cleanup is kept under
**Data & Diagnostics…** rather than presented as part of normal onboarding.

## Developer build

The current bundle is pinned to Node 26.2.0 and Apple silicon:

```bash
npm run product:macos:build
npm run product:macos:validate:development
open ".release-build/macos/Usage Monitor.app"
```

Create a deterministic-layout developer DMG:

```bash
npm run product:macos:dmg
node ./scripts/validate-macos-install.js \
  --dmg ".release-build/macos/UsageMonitor-0.0.1-macOS-arm64.dmg" \
  --development
```

The DMG command fixes its volume name, layout, HFS+ filesystem, compression
level, file ordering inputs, and timestamps. A Developer ID timestamp and
Apple's disk-image tooling make byte-for-byte identity across release machines
an invalid promise; the command records the resulting SHA-256 instead.

## External-distribution build gate

External builds require an approved `AppIcon.icns` and a provenance file as
described in [Assets/README.md](./Assets/README.md). No placeholder artwork is
accepted.

Prepare the pinned official Sparkle 2.9.3 binary framework. The command
downloads only the official release archive, checks its pinned SHA-256,
extracts the framework with its required symlinks, validates the exact
framework-tree digest and link targets, and checks the complete license notice:

```bash
npm run product:macos:updater:prepare
```

Build the release candidate with a fixed, real HTTPS service origin and a
monotonic Apple bundle version. The appcast public key is public; the matching
private update-signing key must not enter the repository or release host:

```bash
node ./scripts/build-macos-app.js \
  --output ".release-build/macos-production/Usage Monitor.app" \
  --central-origin "https://REPLACE-WITH-APPROVED-HOST" \
  --external-distribution \
  --bundle-version 1 \
  --sparkle-framework ".release-deps/Sparkle.framework" \
  --sparkle-appcast-url "https://REPLACE-WITH-APPROVED-HOST/appcast.xml" \
  --sparkle-public-ed-key "REPLACE_WITH_32_BYTE_BASE64_PUBLIC_KEY="
```

The command rejects a missing origin, HTTP, loopback, credentials, paths,
queries, fragments, missing artwork, missing provenance, placeholder
provenance, invalid bundle versions, an unpinned framework tree, unsafe
framework symlinks, a non-HTTPS appcast, or a malformed Ed25519 public key.
Developer builds reject all updater inputs. The candidate remains ad-hoc signed
until the release command completes.

## Developer ID and notarization

The release operator must first make a `Developer ID Application` identity
available in the login Keychain and store notarization credentials in Keychain
without writing them to the repository:

```bash
xcrun notarytool store-credentials usage-monitor-notary
```

Then set only the identity label and Keychain profile name in the release
process environment:

```bash
export USAGE_MONITOR_DEVELOPER_ID_APPLICATION='Developer ID Application: APPROVED OWNER (TEAMID1234)'
export USAGE_MONITOR_NOTARY_PROFILE='usage-monitor-notary'
export USAGE_MONITOR_PRODUCTION_ORIGIN='https://REPLACE-WITH-APPROVED-HOST'
export USAGE_MONITOR_BUNDLE_VERSION='1'
export USAGE_MONITOR_SPARKLE_FRAMEWORK="$PWD/.release-deps/Sparkle.framework"
export USAGE_MONITOR_SPARKLE_APPCAST_URL='https://REPLACE-WITH-APPROVED-HOST/appcast.xml'
export USAGE_MONITOR_SPARKLE_PUBLIC_ED_KEY='REPLACE_WITH_32_BYTE_BASE64_PUBLIC_KEY='
npm run product:macos:release
```

The release command:

1. requires the operator to repeat the exact approved origin and monotonic
   bundle version independently of the candidate;
2. verifies every regular candidate payload file, mode, size, and digest against the
   build inventory, rejects unlisted entries and symbolic links, and
   normalizes only the three expected Mach-O signature envelopes;
3. rebuilds into an isolated directory from the checked-out source and approved
   inputs, requires the fresh source and payload digests to match the reviewed
   candidate, and discards the candidate bytes;
4. signs Sparkle's Installer XPC, Downloader XPC (preserving its entitlement),
   Autoupdate helper, Updater app, and framework in the upstream-documented
   inside-out order, followed by keytar, embedded Node, the native launcher,
   and the outer app;
5. applies hardened runtime and a minimal, reviewed Node runtime entitlement
   file;
6. verifies the complete Developer ID signature;
7. submits an app archive to Apple's notary service and staples the accepted
   ticket to the app;
8. creates the DMG with an exact `/Applications` link;
9. submits and staples the DMG;
10. mounts and copies the app into an isolated Applications-shaped directory;
11. runs strict signature, stapler, Gatekeeper, and clean-profile companion
   smokes; and
12. writes a content-free release manifest beside the DMG.

The command never prints or records the identity, notary profile, Apple
credential, or submission identifier. It refuses existing outputs unless the
operator explicitly supplies `--replace`.

## Signed replacement and rollback contract

Production Usage Monitor builds use the pinned Sparkle 2.9.3 framework. Sparkle
checks one exact HTTPS appcast automatically and exposes a user-initiated
**Check for Updates** action. Every published artifact must carry an Ed25519
signature made by the offline update key as well as the existing Developer ID
and notarization assurances. Automatic download and install-on-quit are off by
default. **Version & Updates… → Automatic Updates…** offers the user an
explicit opt-in that enables both; the user can decline or later turn it off
and continue with visible update prompts. A manual signed-DMG replacement
remains the fallback.

Every new `usage-monitor-macos-release-v0.2` manifest records the fixed
`usage-monitor-macos-signed-replacement-v1` contract:

- quit Usage Monitor before replacing the app in `/Applications`;
- require the candidate bundle version to be strictly newer;
- require both candidate and rollback DMGs to have complete Developer ID,
  hardened-runtime, notarization, stapling, Gatekeeper, and clean-profile
  release assurances;
- retain the same owner-only Application Support root and local Keychain items;
- forbid destructive state migration under this contract;
- require a pre-replacement state backup and explicit compatibility work before
  any future schema change; and
- keep the previous signed/notarized DMG and release manifest as the manual
  rollback artifact.

Before publishing a replacement, retain both DMGs beside their release
manifests and run:

```bash
node ./scripts/validate-macos-replacement.js \
  --previous "/path/to/previous.dmg.release.json" \
  --candidate "/path/to/candidate.dmg.release.json"
```

The validator checks both artifact sizes and SHA-256 values, re-runs notarized
DMG, Gatekeeper, Developer ID, and clean-profile validation on both actual
artifacts, and checks the complete release assurances, fixed signed-updater
contract, bundle identity, and monotonic bundle version. Then rehearse the
candidate against a copy of existing app state. To roll back, quit the candidate
and manually reinstall the retained previous signed/notarized DMG. If a future
candidate ever needs a state schema change, restore the pre-replacement state
backup before launching the previous version unless that exact existing-state
rollback has been rehearsed.

## Automated validation

Run the focused suite:

```bash
npm run product:macos:test
```

Validate a completed production artifact:

```bash
npm run product:macos:validate:release
```

The automated validator proves the bundle and Gatekeeper contract on the build
Mac with an empty temporary home. It is not a substitute for a truly clean
machine.

Before sending the DMG to any external user, perform a human clean-Mac or
disposable-VM rehearsal:

1. transfer the DMG through the intended download channel so quarantine
   metadata is present;
2. confirm the browser-reported checksum against the release manifest;
3. open the DMG and drag the app to `/Applications`;
4. launch it without Terminal, Control-click bypasses, or privacy-setting
   exceptions;
5. verify the calm Ready state, Retry path, diagnostics copy and failure code,
   default/custom Codex source selection, Open Codex/help action, exact
   configured app-open link, first scan, first reviewed contribution,
   opt-in six-hour contribution schedule, **Check for Updates**, quit,
   relaunch, and uninstall journey;
6. verify no Login Item, LaunchAgent, daemon, unexpected network connection, or
   orphan companion remains; and
7. retain the macOS version, hardware architecture, artifact SHA-256, elapsed
   onboarding times, and observed failures in the release receipt.

## Human-only gates

The repository cannot complete these without an authorized person:

- approve final icon artwork and its distribution rights;
- supply and authorize an Apple Developer Program team and Developer ID
  Application certificate;
- create the `notarytool` Keychain credential profile;
- approve the production HTTPS service origin;
- create and protect a Sparkle Ed25519 update-signing key outside the
  repository and hosting environment;
- approve and publish the exact HTTPS appcast URL;
- publish an Ed25519-signed, Developer ID-signed, notarized update artifact and
  rehearse both an update and rollback;
- accept any Apple or hosting legal/billing terms;
- run the quarantine-preserving clean-Mac rehearsal;
- approve consumer privacy, consent, support, update, and incident-response
  copy; and
- authorize external distribution.

The repository implements and tests the fail-closed updater build boundary, but
cannot claim a live update until an authorized operator supplies the appcast,
public key, matching private signing key, Developer ID identity, notarization
profile, and a previously installed signed release for an update rehearsal.
