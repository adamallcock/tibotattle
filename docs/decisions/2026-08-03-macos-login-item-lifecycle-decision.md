---
title: TiboTattle macOS Login Item lifecycle
date: 2026-08-03
type: decision-record
status: complete
---

# TiboTattle macOS Login Item lifecycle

## Decision

TiboTattle is a persistent, regular macOS menu-bar companion. A new install
defaults to **Start TiboTattle at login**, but the default is a visibly
preselected first-run choice rather than a silent installation. The user must
choose the affirmative **Get Started** action before the app asks macOS to
register a Login Item. They can clear the choice before continuing and can
enable or remove the Login Item later in **Settings…** → **General**.

The Login Item launches the normal application at login. It does not turn the
product into a daemon or independently persistent service.

## User lifecycle and consent

1. On a fresh launch, the native disclosure explains local data boundaries and
   presents an accessible, localized **Start TiboTattle at login** control in
   its enabled/preselected state.
2. Before **Get Started**, the app may read the service status to describe the
   state, but it must not call registration.
3. Choosing **Get Started** with the control on requests registration. Choosing
   it with the control off records the completed first-run acknowledgement
   without registering anything.
4. If registration is denied or requires approval, the app retains a truthful
   status, explains the next step, and offers the relevant Login Items page in
   System Settings. It does not claim that startup at login is enabled.
5. The Settings control reflects the current service status as far as macOS
   exposes it. The display is refreshed when Settings opens, on return from
   System Settings, on an explicit **Refresh Login Item Status** action, and
   after a request. A user can request registration, unregister the item, or
   open System Settings for intervention.
6. An approval-pending state is not rendered as a normal off switch. The
   toggle is disabled, the status explains the intervention, and a distinct
   **Remove Pending Login Item** action can withdraw the pending request.
   Every non-throwing register/unregister request is followed by a fresh
   status read; a request is called successful only when that status confirms
   the requested state.
7. Closing the primary window hides it while the regular menu-bar app remains
   available. Opening from the menu bar reconstructs the window. Explicit
   **Quit TiboTattle** stops the companion and ends the app process.

The first-run receipt is migration-safe: an earlier acknowledgement is not a
new permission grant, so updating an existing install must not register a
Login Item automatically. Existing users can opt in from Settings.

## Implementation boundary

The supported bundle target is macOS 14.0 on Apple silicon. The implementation
uses Apple's `ServiceManagement` framework and `SMAppService.mainApp` directly;
it introduces neither a third-party login-item dependency nor legacy
`SMLoginItemSetEnabled` plumbing.

`SMAppService` status is the source of truth for the UI, with explicit handling
for the enabled, unregistered, approval-required, unavailable, and error
states. ServiceManagement calls sit behind an injectable native protocol so
focused tests can use a fake service and never mutate the developer's real
Login Items.

The application must not add any of the following:

- a LaunchAgent, LaunchDaemon, privileged helper, or root process;
- a second hidden process that survives explicit Quit;
- a raw-log scan mechanism outside the ordinary app lifecycle; or
- automatic contribution preparation or upload caused solely by login
  registration.

Normal launch behavior remains truthful: the menu-bar app may be present after
login, and its existing bounded refresh continues only while the ordinary app
is running. The Login Item itself adds no separate scanner; optional
contribution retains its existing explicit-consent boundary.

## Hardening decisions (2026-08-04)

### Status, recovery, and overlap

The native layer now has a small pure Login Item state policy, exercised with
an injected fake manager. It distinguishes confirmed enable/disable,
approval-required, not-confirmed, unavailable, and thrown-error outcomes. A
single in-flight guard prevents conflicting keyboard or accessibility actions
from racing register and unregister while a recovery alert is active.

The path-free diagnostic receipt records only fixed values for the most
recent observed Login Item status and outcome. It deliberately excludes OS
errors, settings URLs, paths, and account identifiers.

### Startup presentation

The ordinary TiboTattle window remains visible on normal app startup. The app
is a regular application with a primary window, Dock presence, and menu-bar
affordance; it is not a menu-bar-only agent. Apple's documented
[`SMAppService.mainApp`](https://developer.apple.com/documentation/servicemanagement/smappservice/mainapp)
API configures the main application to launch at login, but does not expose a
documented launch-cause signal that would reliably distinguish a login launch
from a person opening the app. TiboTattle therefore does not guess from
arguments or process state and accidentally hide a person-requested launch.

The existing initial bounded local refresh remains ordinary-app behavior. It
is neither delayed nor made autonomous just because the app is registered at
login; the existing overlap guard reports an already-running companion rather
than starting a second scanner.

### Release lifecycle gate

Every installed-app and DMG validation now runs the packaged
`--login-item-contract-smoke-test`. That smoke constructs only a fake manager,
asserts the full status/outcome policy, and reports zero real ServiceManagement
calls. It never changes an operator's Login Items.

Except for an explicit release-specific exception recorded below, before
publishing a signed build a human must complete a disposable-profile
rehearsal on the Developer-ID-signed app installed at
`/Applications/TiboTattle.app`. The machine-checkable, privacy-safe receipt
schema was originally `usage-monitor-macos-login-item-release-rehearsal-v1`.
The current gate uses v2 under the 2026-09-04 amendment below and rejects a
receipt unless it records all of these verified checks:

- first-run consent is visibly preselected and remains affirmative-only;
- Settings reconciles after an external System Settings change, including the
  approval-pending removal route;
- automatic launch after sign-in works;
- upgrade, move/reinstall, and uninstall/reinstall leave no stale duplicate
  main-app Login Item;
- a duplicate launch tells the person to use or quit the existing app;
- closing the window keeps the menu-bar app available while explicit Quit
  stops it and its companion; and
- no LaunchAgent, LaunchDaemon, daemon, privileged helper, autonomous scan,
  or background upload was added.

The gate command validates production signing/Gatekeeper assurances and the
receipt without invoking `register()` or `unregister()`:

```bash
npm run product:macos:validate:login-item-release -- \
  --app "/Applications/TiboTattle.app" \
  --rehearsal "docs/receipts/YYYY-MM-DD-macos-login-item-release-rehearsal.json"
```

### 2026-09-04 two-architecture receipt amendment

Current qualification requires
`usage-monitor-macos-login-item-release-rehearsal-v2`, with
`evidenceKind: "manual_observation"`. V1 records remain historical; the current
gate rejects them rather than inferring missing architecture or source proof.
All ten lifecycle checks and the disposable-profile/Applications requirements
remain mandatory for a passing manual-observation receipt.

The receipt's `application` binds bundle identifier, build, short version,
`architecture`, `channel`, `sourceCommit` and `payloadSha256` to the inspected
signed installed app. The last field is its verified normalized payload digest,
not the final DMG or signature digest. Exact DMG evidence still comes from
separate checksum/finalizer and installed-artifact qualification.

The closed `environment` also records `hardwareArchitecture`, `macosVersion`
and `rosetta: false`. Hardware must match the app architecture; the reported OS
must meet the inspected minimum (at least macOS 14). These are explicit human
observations, not facts inferred from cross-compilation or automated smoke
tests. A matching schema cannot establish that a human performed the rehearsal.
Do not manufacture those observations or reuse ARM receipts for Intel.

The CLI defaults to `--architecture arm64 --channel stable`. Intel RC2 uses
`--architecture x64 --channel internal-dogfood`, with its own matching receipt.
Both native validators receive the exact selection. The gate still makes no
real ServiceManagement changes and does not install the app.

### 2026-09-05 release-specific 0.1.18 exception

The owner's [0.1.18 manual qualification
waiver](./2026-09-05-release-0-1-18-manual-qualification-waiver.md) accepts the
unavailable disposable clean-profile/manual Login Item matrix and physical Intel
qualification as release risks for 0.1.18 only. This is an authorization decision,
not manual-observation evidence. No v2 receipt is manufactured and its validator
is not changed or reported as passing for unperformed checks. The owner's report
that other testers are running the app is not independently verified hardware or
exact-artifact evidence.

The actual automated fake-manager/isolated smoke, native signing and final-byte
checks, data preservation, updater integrity and unexpected-Keychain-prompt stop
conditions remain unchanged. Historical receipts retain their original scope;
this exception neither qualifies physical Intel nor waives a later release's
manual requirements.

## Privacy and removal

The Login Item stores no raw Codex data and sends no network request by itself.
It changes only whether macOS launches TiboTattle after the user signs in.
Removing the setting unregisters the application; it does not erase local
TiboTattle state, revoke an already reviewed contribution, or alter Codex
source data. Uninstall remains: explicitly quit TiboTattle, remove it from
Applications, and use the existing optional local-state cleanup flow if
desired.

## Validation and release rehearsal

Focused tests inject fake ServiceManagement behavior and cover the preselected
first-run choice, affirmative registration, unregistration, denied and
approval-required states, and the no-daemon boundary. The source/bundle
contracts also assert that the app does not create a LaunchAgent or
LaunchDaemon.

Implementation validation on 2026-08-03:

- `node --test --test-concurrency=1 test/macos-localization.test.js` passed
  (2 tests).
- `node --test --test-concurrency=1 test/macos-app-bundle.test.js` passed
  (26 tests; one expected distribution-validation skip because the pinned
  Sparkle framework is not prepared in this checkout). Its packaged
  `--login-item-contract-smoke-test` uses only the fake manager and reports
  `real_service_calls=0`.
- `npm run product:macos:build` and
  `npm run product:macos:validate:development` both passed.
- A final combined rerun of those focused Node suites passed 28 tests with the
  same one expected Sparkle-framework skip.

### Hardening validation (2026-08-04)

- `node --test --test-concurrency=1 test/macos-localization.test.js` passed
  (2 tests).
- `npm run product:macos:test` prepared the pinned Sparkle 2.9.3 framework and
  passed all 35 macOS tests with no skips. This includes the compiled fake
  ServiceManagement contract, receipt-schema failures, signed replacement
  checks, and packaged app/DMG smokes.
- `npm run product:macos:build` and
  `npm run product:macos:validate:development` passed. The validation executes
  the fake Login Item contract only; no real Login Item is registered or
  removed.
- The rendered development Settings window was inspected with its actual
  ServiceManagement status unavailable: the disabled switch, truthful recovery
  summary, **Open Login Items Settings**, and **Refresh Login Item Status**
  controls were all visible and accessible. The approval-pending visual branch
  remains protected by the fake-manager state contract because this developer
  account did not expose it in the read-only check.
- The release-gate command was given a development bundle path and refused it
  before reading a receipt, confirming that it only accepts
  `/Applications/TiboTattle.app` for a signed-release rehearsal.

An earlier visual attempt was blocked by an already-active companion and did
not change any Login Item. The isolated rehearsal below superseded that
limitation.

### End-to-end rehearsal (2026-08-03)

A fresh development bundle was rebuilt, copied to a temporary uniquely
identified and ad-hoc-signed application, and given an isolated state directory
plus an empty custom Codex folder. This kept the installed TiboTattle app and
its source data out of the rehearsal.

1. With no temporary Login Item present, the native first-run alert visibly
   showed the checked, accessible **Start TiboTattle at login** checkbox and
   its consent copy.
2. Choosing **Get Started** registered the temporary app. The app's Settings
   switch reported enabled, and its **Open Login Items Settings** action opened
   macOS **Login Items & Extensions**, where the temporary app appeared under
   **Open at Login**.
3. Turning the switch off removed that row from System Settings. Turning it on
   again restored it, proving both the unregister and re-register paths.
4. Closing the regular window left the app and its loopback companion process
   alive. The next activation visibly reopened the window; explicit **Quit**
   stopped both the app and companion.
5. The final disable removed the System Settings row again. The temporary app,
   isolated state, empty Codex fixture, and probe data were moved to Trash;
   no temporary rehearsal process remained.

The account did not surface a macOS denial or approval-required state during
this successful registration, so that UI remains covered by the injected fake
manager tests. The recovery route itself was visually exercised. A real
sign-out/sign-in was intentionally not performed because it would disrupt the
active desktop session; release acceptance should still rehearse automatic
launch in a disposable macOS profile.

Before release, perform the user-visible Login Item rehearsal only in a
disposable clean macOS profile: confirm no Login Item before first-run
confirmation; confirm the status after enable, disable, and re-enable; test
the System Settings recovery route where available; close/reopen from the menu
bar; explicitly quit; and verify no LaunchAgent, daemon, orphan companion,
separate raw-log scan mechanism, or background upload was introduced. Source
tests must not use the operator's real Login Item registration.
