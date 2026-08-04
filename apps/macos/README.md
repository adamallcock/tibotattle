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
4. A menu-bar status item appears alongside the window and the Dock icon. It is
   an additional affordance, not a replacement: the app stays a regular
   foreground application and installs no `LSUIElement` agent. The compact
   title shows the primary observed quota lane only while the companion reports
   fresh verified evidence; stale, unobserved, starting, and failed states all
   show a neutral `–`, and an in-progress pass shows `…`. The menu lists every
   supported observed quota lane. It hides stale percentages and reset times,
   and shows a reset countdown only for fresh verified evidence. Its disabled
   rows name the observation and freshness state, so the menu bar never
   displays a number it cannot justify. The item offers one primary **Open
   TiboTattle** destination, state-aware **Analyze/Update Local Usage**, and
   **Quit TiboTattle**; Quit uses the same graceful shutdown as the window's own
   Quit control.
5. Choose **Open TiboTattle** and explicitly start local analysis.
6. If the companion fails or exits, choose **Retry**. The app does not require
   a relaunch for ordinary recovery.
7. Choose **Data & Diagnostics…** to see and copy a fixed, path-free diagnostic
   receipt. Startup and lifecycle failures include a stable `UM_MACOS_*` code
   and a fixed recovery action.
8. Choose **Codex Source…** to select a custom `CODEX_HOME` with the native
   folder picker, or restore `~/.codex`. The selection is revalidated at every
   launch and stored only in the owner-only app state; copied diagnostics expose
   only `default` or `custom`, never the path.
9. Choose **About TiboTattle** → **Check for Updates** to check a signed
   production appcast. Automatic update downloads are controlled by one native
   switch in **Settings…** → **General**. Developer and ad-hoc builds contain
   no updater framework and perform no update networking.
10. **Settings…** → **General** also contains **Local allowance
   notifications**. It is off by default; enabling it is the only action that
   may request macOS notification permission. The first opt-in visibly selects
   80% and 90% usage alerts. The new-window control remains visibly unavailable
   because the current provider receipt supplies a reset schedule, not an
   explicit reset identity; schedules and percentage drops never alert.
   TiboTattle evaluates threshold alerts only
   after the existing foreground refresh receives a fresh direct
   `account/rateLimits/read` observation. Stale, inferred, mixed-source,
   unobserved, unknown, forecast, time-only, and log-derived state never
   alerts. Turn the same switch off to immediately stop future alerts and
   clear only their local notification baseline, pending-request, and dedupe
   state; it does not erase accounting evidence. This feature adds no daemon,
   login item, timer, network polling, push service, or account identity that
   leaves this Mac.
11. A trusted website or browser bookmark may use `usagemonitor://open` to
   activate the app and open its loopback dashboard. All other hosts, paths,
   credentials, queries, and fragments in that custom scheme are rejected.
12. Closing or quitting the native app stops the companion. No daemon or login
   item is installed. After an explicit reviewed first contribution, the user
   may enable six-hour contribution while the app remains open.

Keep the app open while local analysis runs. Closing the TiboTattle window
exits the app and stops the current pass; completed checkpoints remain
available on the next launch. **Open in Browser** is a separate optional
control in the app, not the primary dashboard destination.

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

## Localization and regionalization foundation

Native strings live in `Resources/en.lproj/Localizable.strings` under stable
`menu.*`, `settings.*`, and `notification.*` keys. `Sources/Localization.swift` follows the
macOS preferred-language list, falls back to the English catalog when a locale
or key is unavailable, and uses `Locale.current` for dates and numbers. Add a
complete sibling locale such as `fr.lproj` only when its catalog and dashboard
copy are ready together.

The build records these resources in the source digest and copies them both to
the app bundle root and to `Contents/Resources/app/localization/`, where the
embedded loopback dashboard can consume the same catalog later. At document
start, the WebKit host also exposes the versioned
`window.__TIBOTATTLE_LOCALIZATION__` handoff with the preferred-language list
and resource root; the current dashboard leaves it unused until its resolver
is ready. The current release intentionally has no language picker: English is
the only shipped translation, so the effective preference remains **System
default** with a safe English fallback. The implementation/next-locale gate
is recorded in
[`docs/decisions/2026-08-03-macos-localization-foundation.md`](../../docs/decisions/2026-08-03-macos-localization-foundation.md).
General settings exposes this current behavior as a read-only **Language —
System** row; it has no picker or override while English is the only shipped
translation.

## Preview distribution build

Use the explicit preview channel when a local test client must exercise an
approved deployed HTTPS central service while retaining the normal
`com.usagemonitor.local` bundle identity for OAuth callbacks. It is not a
production release. The command stages the bundle at
`.release-build/macos-preview/current/TiboTattle.app`, validates it, and
reports its local path, integrity information, channel, and updater mode.

The preview command prepares the pinned framework and, by default, uses the
same public central-service origin, signed-feed URL, and Sparkle public key as
the installed TiboTattle client. That makes the ordinary local QA build a real
client of the deployed service rather than a no-service development bundle.
No private release credential is embedded or read.

An operator may override those **public** values only when deliberately testing
another reviewed deployed environment:

```bash
export USAGE_MONITOR_PREVIEW_CENTRAL_ORIGIN='https://APPROVED-DEPLOYED-HOST'
export USAGE_MONITOR_PREVIEW_SPARKLE_APPCAST_URL='https://APPROVED-DEPLOYED-HOST/appcast.xml'
export USAGE_MONITOR_PREVIEW_SPARKLE_PUBLIC_ED_KEY='BASE64_32_BYTE_PUBLIC_KEY='
npm run product:macos:preview
```

To run the two bounded steps separately, use
`npm run product:macos:preview:build` and then
`npm run product:macos:preview:validate`. Preview output is deliberately fixed
to the reviewed staging path; it cannot be redirected with an environment
variable or `--output`. A different Sparkle framework can be supplied with
`USAGE_MONITOR_PREVIEW_SPARKLE_FRAMEWORK`. The build rejects HTTP, IP-literal
and loopback origins, credentials and URL decorations,
malformed public keys, unverified Sparkle trees, and `/Applications` output
paths. The private Sparkle update-signing key is not an input to this build and
must never be placed in the repository or bundle.

The resulting marker is `preview_distribution` in both the build manifest and
`UsageMonitorBuildChannel`, with `UsageMonitorPreviewDistribution=true` and
`externalDistributionRequested=false`. The central-service runtime key remains
`production_https` so the existing launcher accepts the approved deployed
origin; the separate channel marker prevents the artifact from being treated
as a production release. Preview builds make **manual** updater checks only:
they never automatically check, download, or install an update.

After validation, install it only through the guarded replacement command:

```bash
npm run product:macos:preview:install
```

That command accepts only `/Applications/TiboTattle.app` (or an explicit
per-user Applications target), validates the staged preview before and after
copying it, and moves an existing app to a timestamped sibling backup rather
than deleting it. It requires the explicit `--replace` flag; no preview build
or validation command copies into `/Applications` on its own.

Validate the staged preview without network access by default:

```bash
npm run product:macos:preview:remote
```

The opt-in live check is still credential-free and read-only: it GETs the
configured public health, readiness, and appcast URLs with a five-second bound,
does not follow redirects, and never starts, downloads, or installs an update.
Run it only when checking the published service boundary:

```bash
npm run product:macos:preview:remote:live
# or verify the installed preview directly
node ./scripts/verify-macos-preview-remote.js \
  --app "/Applications/TiboTattle.app" \
  --live
```

If the central service is healthy but the appcast is not yet published, the
command exits non-zero and says so plainly. That is an external release-input
gap, not a claim that Sparkle has updated the preview client.

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
and notarization assurances. Automatic update downloads are on by default in a
signed release. The user can turn them off with the native **Automatic
updates** switch in **Settings…** → **General** and can always use **Check for
Updates** from About. A manual signed-DMG replacement remains the fallback.

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
   default/custom Codex source selection, exact
   configured app-open link, first scan, first reviewed contribution,
   opt-in six-hour contribution schedule, **Check for Updates**, and the
   notification Settings contract: off by default; permission requested only
   after opting in; one controlled fresh direct-provider threshold crossing;
   no alert for first, stale, inferred, mixed, unknown, unobserved, or failed
   refresh evidence; confirm reset remains suppressed for the current
   schedule-only provider receipt; and
   opt-out stops future alerts without erasing accounting evidence; then quit,
   relaunch, and complete the uninstall journey;
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
