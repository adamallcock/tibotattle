---
title: TiboTattle macOS Release Runbook
date: 2026-07-29
type: runbook
status: implemented-foundation
---

# TiboTattle macOS release runbook

This directory contains the native foreground launcher and the release
contracts for a self-contained Usage Monitor app. The ordinary developer build
is usable locally but is not a public installer. The external-distribution path
fails closed unless production service configuration, approved artwork,
Developer ID signing, Apple notarization, stapling, Gatekeeper assessment, and
a clean-profile smoke all succeed.

For the native/loopback launch contract, fixed URL scheme, WKWebView messages,
Keychain broker, Codex subprocess protocol, platform APIs, and system diagram,
see the canonical
[TiboTattle API surface reference](../../docs/reference/2026-08-26-api-surface-reference.md).

The packaged companion reaches Keychain only through the app's private
protocol-v2 socket broker. Its closed capability enum covers export identity,
account observation, Claude-session pseudonym, and contribution device; no
service/account string crosses the wire. The current packaged-companion graph
uses the export-identity, account-observation, and contribution-device
mappings; the Claude callback remains a standalone CLI/local-review
composition. A legacy `.v1` item is copied to the app-owned `.app.v1` item,
read back, and only then deleted. A denied prompt returns
`migration_required` and preserves the legacy item. The packaged runtime will
not prompt for that capability again in the same app process. Quit and reopen
TiboTattle before repeating the initiating action; restart is the only retry
boundary, and reset or deletion is not recovery for this condition. All four
adapters retain a content-free migration-required diagnostic. The packaged
runtime excludes `@github/keytar`; standalone CLI/local-review tooling retains
that compatibility backend.

## Consumer lifecycle in the app

1. Launch **TiboTattle.app**.
2. On the first launch, review the one-time **Get Started** disclosure. It
   explains exactly which Codex metadata can be read after an explicit Analyze
   action, what owner-only local state is retained, which content is excluded,
   how optional contribution stays off, and what happens when the browser or
   app closes. The accessible native **Start TiboTattle at login** control is
   visibly preselected. Choosing **Get Started** is the affirmative action
   that may register the native Login Item; clearing it continues without a
   Login Item. The acknowledgement is an owner-only local receipt; moving
   local app data to Trash makes the disclosure appear again.
3. The native window starts one private loopback companion on an ephemeral
   port and performs its existing bounded local refresh while the normal app
   remains open. The Login Item adds no separate scanner; raw logs and prompts
   are never uploaded by the launch itself, and optional contribution keeps its
   separate review and consent controls.
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
10. **Settings…** → **Notifications** contains **Local allowance
   notifications**. It is off by default; enabling it is the only action that
   may request macOS notification permission. The first opt-in visibly selects
   80% and 90% usage alerts. Reset alerts use the provider-reported reset time
   and notify once when the next foreground refresh arrives at or after that
   time. A provider-reported reset identity strengthens dedupe when available;
   a schedule change before the old due time replaces the baseline without
   alerting. TiboTattle evaluates threshold and reset alerts only after the
   existing foreground refresh receives a fresh direct
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
12. Closing the primary window leaves the regular menu-bar app available;
   **Quit TiboTattle** stops the companion. If the person accepted the
   first-run default or later enables it in Settings, the app uses one native
   Login Item to launch this normal app at login. It never installs a daemon,
   LaunchAgent, privileged helper, or separately persistent worker. After an
   explicit reviewed first contribution, the user may enable six-hour
   contribution while the app remains open.

Keep the app open while local analysis runs. Closing the TiboTattle window
hides that window; the menu-bar item can reopen it. Explicit Quit stops the
current pass; completed checkpoints remain available on the next launch.
**Open in Browser** is a separate optional control in the app, not the primary
dashboard destination.

### Launch-at-login lifecycle

TiboTattle supports macOS 14 or later and uses Apple's
`ServiceManagement` `SMAppService.mainApp` API directly. A fresh install does
not register during launch or status refresh: the first-run checkbox is only a
preselected choice. On first run, its **Get Started** action is the sole point
that may request registration. Existing installs that completed the earlier
first-run receipt are never registered by an update; they can opt in from
**Settings…** → **General**.

The Settings control reads the service's reported state rather than treating a
stored preference as proof. It refreshes when Settings opens, when the app
becomes active again after System Settings, after an explicit **Refresh Login
Item Status** action, and after every requested change. A non-throwing request
is not treated as proof: TiboTattle reads the status again and says whether
enable/disable was confirmed, needs approval, was not confirmed, or is
unavailable. If approval is pending, the toggle is disabled rather than shown
as a misleading off state; **Remove Pending Login Item** can explicitly
withdraw it. The setting affects app launch at login only: it does not add a
separate scan, keep a companion process alive after Quit, send a contribution,
or permit a silent background upload. The existing bounded refresh remains a
normal-app, while-running behavior.

The ordinary regular window remains visible when the app launches. The product
does not use an undocumented heuristic to guess whether a particular startup
came from login versus a person opening the app, because that could hide a
manual launch. Closing the window is the explicit way to leave the regular
menu-bar companion running; **Quit TiboTattle** still stops it.

## Report and native-toolbar boundary

The primary in-app experience remains the rich local WebKit report: its charts,
tables, text, and existing share card are not replaced with a sparse native
dashboard. The regular AppKit window keeps the usual close, minimise, and
resize controls. Its unified toolbar adds only the native affordances that are
better outside the report: local status, **Refresh usage**, **Share**, and
**Settings**. **Share** opens the report's existing local share card; it does
not create a second report or sharing service.

The toolbar has no independent data authority. **Refresh usage** reuses the
already-running loopback Node companion and its existing local refresh route.
There is still one companion child while the app is open; the in-app refresh
timer is only foreground scheduling, not a daemon, login item, LaunchAgent, or
background URL session. The separate Keychain-reset helper remains available
only after its explicit diagnostic confirmation and is unrelated to the
toolbar or usage accounting.

The troubleshooting-only local erase action moves only
`~/Library/Application Support/Usage Monitor` to Trash after the companion has
stopped, and clears the app's persistent WebKit cookies, caches, and bounded
sign-in recovery state. It does not modify Codex logs, revoke already-sent
community data, or remove a pseudonymous identity stored in Keychain.

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
**TiboTattle.app** to Trash. Advanced local cleanup is kept under
**Data & Diagnostics…** rather than presented as part of normal onboarding.

## Developer build

The current bundle is pinned to Node 26.2.0 and Apple silicon:

```bash
npm run product:macos:build
npm run product:macos:validate:development
open ".release-build/macos/TiboTattle.app"
```

Create a deterministic-layout developer DMG:

```bash
npm run product:macos:dmg
node ./scripts/validate-macos-install.js \
  --dmg ".release-build/macos/TiboTattle-0.1.0-macOS-arm64-development.dmg" \
  --development
```

The DMG command fixes its volume name, layout, HFS+ filesystem, compression
level, file ordering inputs, and timestamps. A Developer ID timestamp and
Apple's disk-image tooling make byte-for-byte identity across release machines
an invalid promise; the command records the resulting SHA-256 instead. Its
explicit `--development` mode only packages an updater-disabled development
bundle, requires a `-development.dmg` filename, and reports the artifact as
ad-hoc, non-notarized, and not update-ready.

## Localization and regionalization

TiboTattle ships English (`en-US`), Simplified Chinese (`zh-Hans`), and
Spanish (`es`) for product-owned native and browser copy. General settings has
a persisted **Language** picker; it defaults to the Mac's preferred language
and falls back safely to English. `zh-TW`, `zh-Hant`, and an ambiguous `zh`
request do not select the Simplified Chinese catalog.

Native strings live under stable `menu.*`, `settings.*`, and `notification.*`
keys. Add another locale only when its native catalog and dashboard copy are
complete together.

Native resources live in `Resources/{en,zh-Hans,es}.lproj/Localizable.strings`.
The build records them in the source digest and copies them both to the app
bundle root and to `Contents/Resources/app/localization/`. The WebKit host
injects the versioned `window.__TIBOTATTLE_LOCALIZATION__` handoff and accepts
only a closed language-preference message; a selection updates the loaded
dashboard without resetting its local/hosted sign-in state.

Before each later loopback-document load, the host refreshes its document-start
handoff so the newly loaded dashboard receives the current native choice. The
browser surface confines legacy exact-text translation to explicit product
roots and marks provider, report, identity, JSON, file, SVG, and diagnostic
values as raw. A language choice never reinterprets those values as UI copy.
The picker announces changes to assistive technology; pseudo-localization is a
test-only expansion fixture, not a shipped language.

Launcher recovery, first-run updater disclosures, Codex-source summaries,
menu-bar unavailable states, and the native status-icon accessibility label
use the same closed catalog. A missing companion therefore has the same
selected-language behavior as the ordinary dashboard and settings controls.

Language choice never changes event time zones, pricing/accounting values, or
provider data: native formatting follows `Locale.current`, and web formatting
uses `Intl` with the regional locale. Translation provenance, contributor
workflow, test requirements, and the future-locale checklist are in
[`docs/decisions/2026-08-03-localization-system.md`](../../docs/decisions/2026-08-03-localization-system.md).

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
  --channel preview_distribution \
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

The generic builder rejects `--external-distribution` entirely, including when
the old environment marker is supplied or a similar CLI marker is attempted.
Build the release candidate only through `product:macos:release`, which performs
the continuity and source-provenance checks before calling the external-build
API. The appcast public key is public; the matching private update-signing key
must not enter the repository or release host:

```bash
npm run product:macos:release -- \
  --channel stable \
  --prepare-candidate \
  --stable-bootstrap
```

`--stable-bootstrap` is an explicit first-stable-release decision. For every
later stable release, replace it with the manifest from the immediately
previous stable release so the gate can prove version continuity:

```bash
npm run product:macos:release -- \
  --channel stable \
  --prepare-candidate \
  --previous-stable-manifest "/path/to/previous-stable-release.json"
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
export USAGE_MONITOR_BUNDLE_VERSION='1'
export USAGE_MONITOR_SPARKLE_FRAMEWORK="$PWD/.release-deps/Sparkle.framework"
export USAGE_MONITOR_SPARKLE_PUBLIC_ED_KEY='REPLACE_WITH_32_BYTE_BASE64_PUBLIC_KEY='
npm run product:macos:release -- \
  --channel stable \
  --prepare-candidate \
  --stable-bootstrap
```

For a later stable release, use `--previous-stable-manifest` in place of
`--stable-bootstrap`, as shown above. The two options are mutually exclusive;
the release command refuses to guess which continuity policy applies.

`config/deployment-endpoints.js` is the reviewed source for the public origin
and Sparkle appcast. Legacy `USAGE_MONITOR_PRODUCTION_ORIGIN` and
`USAGE_MONITOR_SPARKLE_APPCAST_URL` values are accepted only when they exactly
match that manifest, so an independent release-time endpoint cannot slip in.

The release command:

1. derives the exact approved origin and appcast from the reviewed deployment
   endpoint manifest and requires a monotonic bundle version independently of
   the candidate;
2. verifies every regular candidate payload file, mode, size, and digest against the
   build inventory, rejects unlisted entries and symbolic links, and
   normalizes only the three expected Mach-O signature envelopes;
3. rebuilds into an isolated directory from the checked-out source and approved
   inputs, requires the fresh source and payload digests to match the reviewed
   candidate, and discards the candidate bytes;
4. signs Sparkle's Installer XPC, Downloader XPC (preserving its entitlement),
   Autoupdate helper, Updater app, and framework in the upstream-documented
   inside-out order, followed by embedded Node, the native launcher, and the
   outer app;
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
Mac with an empty temporary home. It also runs the packaged Login Item contract
smoke against an injected fake manager; that check makes zero real
ServiceManagement calls. It is not a substitute for a truly clean machine.

Before sending the DMG to any external user, perform a human clean-Mac or
disposable-VM rehearsal:

1. transfer the DMG through the intended download channel so quarantine
   metadata is present;
2. confirm the browser-reported checksum against the release manifest;
3. open the DMG and drag the app to `/Applications`;
4. launch it without Terminal, Control-click bypasses, or privacy-setting
   exceptions;
5. verify the calm Ready state, Retry path, diagnostics copy and failure code,
   default/custom Codex source selection, exact configured app-open link,
   first scan, first reviewed contribution, opt-in six-hour contribution
   schedule, **Check for Updates**, close/reopen from the menu bar, explicit
   quit, relaunch, and uninstall journey; and verify the notification Settings
   contract: off by default; permission requested only after opting in; one
   controlled fresh direct-provider threshold crossing; no alert for first,
   stale, inferred, mixed, unknown, unobserved, or failed refresh evidence;
   one scheduled reset alert on the next eligible refresh at or after the
   provider-reported due time, with dedupe across relaunches;
   and opt-out stops future alerts without erasing accounting evidence;
6. on a disposable clean macOS user profile, verify that first-run visibly
   preselects **Start TiboTattle at login** but does not create a Login Item
   until **Get Started** is chosen; then verify the Settings status, explicit
   status refresh after returning from System Settings, disable/re-enable, and
   the approval/System Settings/**Remove Pending Login Item** recovery paths.
   Sign out/in once to prove automatic launch; then rehearse signed upgrade,
   move/reinstall, uninstall/reinstall, and an attempted second launch to
   confirm one normal-app Login Item and no stale duplicate. Confirm that the
   only possible Login Item is TiboTattle's native app registration, and that
   there is no LaunchAgent, LaunchDaemon, daemon, privileged helper,
   unexpected network connection, autonomous raw-log scan, background upload,
   or orphan companion; and
7. retain the macOS version, hardware architecture, artifact SHA-256, elapsed
   onboarding times, and observed failures in the release receipt; then run
   the receipt gate without changing Login Items:

   ```bash
   npm run product:macos:validate:login-item-release -- \
     --app "/Applications/TiboTattle.app" \
     --rehearsal "docs/receipts/YYYY-MM-DD-macos-login-item-release-rehearsal.json"
   ```

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
