---
title: macOS native-to-Electron guided handover
date: 2026-09-07
type: runbook
status: draft
---

# Status and boundary

This is the source contract for moving a supported native TiboTattle install
(`0.1.17` or `0.1.18`) to a later signed Electron candidate. It is not an
installed-update procedure and does not qualify a direct Sparkle replacement.
The released native applications do not include a general handover command.

The selected route is a **guided signed install**. It keeps the production
bundle identifier, `com.usagemonitor.local`, and leaves the retired native app
available at a deterministic backup location. A source build, a development
package, copied profile, `app.isPackaged`, or a passing contract test does not
qualify a signed artifact, Keychain continuity, replacement, or update.

# Fixed discovery and install route

The macOS coordinator probes only these locations. It does not scan an
Applications directory or infer the old state from Electron `userData`.

| Purpose | Exact location |
| --- | --- |
| Native stable state | `~/Library/Application Support/Usage Monitor` |
| Guided-handover backup root | `~/Library/Application Support/TiboTattle Native Handover` |
| Preserved native bundle | `~/Library/Application Support/TiboTattle Native Handover/native-app/TiboTattle.app` |
| Native source candidates | preserved bundle, `/Applications/TiboTattle.app`, then `~/Applications/TiboTattle.app` |
| Final same-identity Electron location | the native source's `TiboTattle.app` location |
| Handover bridge resource | `TiboTattle.app/Contents/MacOS/TiboTattleNativeHandover` |
| Main-process credential adapter | `TiboTattle.app/Contents/Resources/native/macos-keychain.node` |

[`scripts/plan-macos-native-electron-guided-handover.mjs`](../../scripts/plan-macos-native-electron-guided-handover.mjs)
returns this concrete route for an exact old bundle and home directory. It is a
planning interface only: it does not move an app, replace a bundle, modify a
profile, sign code, or invoke the handover bridge.

# Runtime decision contract

Production startup first validates the signed enclosing app and loads its
fixed credential adapter. Before invoking any handover operation, it reads and
discards the active account-observation and contribution-device credentials.
Optional legacy export and reserved Claude credentials retain migration guards
when first used; they do not block an unrelated handover. Accountless installation
credentials remain main-process-only and are accessed on demand. Missing modern credentials are accepted
only after a fixed, attribute-only legacy lookup also proves absence. Locked,
denied, indeterminate or legacy-only credentials stop startup without modifying
the predecessor, credentials or data. This preflight also runs after a completed
handover and on fresh installations; an absent migration helper is distinct
from missing credential authority. No legacy ACL is broadened and no identity
is replaced to avoid a security prompt.

[`runProductionNativeMacHandover`](../../apps/electron/desktop-native-migration-macos.js)
runs before Electron opens companion or settings state. It has three normal
results:

| Result | Runtime behavior |
| --- | --- |
| `no_legacy_state` | Start normally. This is returned before bridge or signature checks, so a fresh Electron profile is never blocked by an absent migration resource. |
| `migrated` | Start with the published `companion-state` and `desktop-settings` roots. |
| `already_migrated` | Start normally. A valid durable completion marker is checked before predecessor discovery, so later Electron updates do not require the retired native app. |

For an existing native state root, `bridge_unavailable`,
`no_supported_predecessor`, `signature_or_build_mismatch`,
`signature_unverified`, and `migration_blocked` stop startup with the guided
migration message. They never fall back to an empty Electron state. A malformed
completion marker also blocks startup.

Before calling the bridge, the coordinator performs read-only local inspection:

1. It verifies the old app, Electron app, and future bundled helper with
   `/usr/bin/codesign --verify --deep --strict`.
2. It reads each code signature's identifier, Team ID, CDHash, and designated
   requirement, plus the app bundles' numeric version and build values.
3. It requires the production identifier, native `0.1.17` or `0.1.18`, equal
   designated-requirement digest and Team ID for the two apps, a helper signed
   by that Team ID, and a strictly greater Electron build.

These are runtime checks of installed local code. They do not assert that a
future archive, notarization, or updater payload is qualified.

# State transaction and recovery

[`runNativeElectronHandover`](../../apps/electron/desktop-native-migration.js)
first recognizes a valid completed profile without reading the old state. For a
new handover it rejects an unsafe or missing native root before it creates a
control directory, backup, or Electron target. It then takes an exclusive
private lease and writes a bounded, content-free journal.

The native root must be owner-private. Older owned files and subdirectories
inside it may retain read permission for other users, but must reject external
write access, links, and unexpected owners. The backup and Electron copies use
private file and directory permissions; migration does not change permissions
on the native source.

The helper in
[`NativeElectronHandoverHelper.swift`](../../apps/macos/Helpers/NativeElectronHandoverHelper.swift)
accepts one operation only: `--prepare --native-app <absolute bundle path>`.
It verifies the enclosing Electron app identity and selected old app, asks
`NSRunningApplication` to terminate only processes with the exact old bundle
URL, unregisters the same-identity native login item and confirms removal, and
returns bounded language, appearance, refresh, and login-preference values. It
does not accept arbitrary commands, kill by name, receive state paths, query
Keychain, copy credentials, reset credentials, or enable sharing.

After that result, the coordinator:

1. Copies the stopped native root to a no-clobber private backup and verifies a
   stable inventory digest.
2. Requires the local unified-index device salt whenever the native index
   exists.
3. Stages a `companion-state` copy and `desktop-settings` snapshot. It retains
   all legacy history, salt, contribution/sharing records, and private state;
   it does not invent an accountless-sharing preference. It maps the launcher
   Codex home, language, appearance, refresh interval, login preference, and a
   valid first-run acknowledgement.
4. Atomically publishes both roots with journal checkpoints, then uses
   Electron's normal login-item API and confirms Electron owns the requested
   setting.
5. Writes `completed-v1.json` only after both roots validate and Electron owns
   the login item.

The journal checkpoints are `started`, `prepared`, `backed_up`, `staged`,
`published_state`, `published`, `electron_login_owned`, and `completed`. A
restart resumes only the matching candidate and journal. It removes only
private staging or backup trees bound to that exact operation. The native
source state, old bundle, credentials, consent, and backup are never deleted by
this path.

Every incomplete retry stops the native writer and withdraws its login
registration again; a saved checkpoint is not evidence that the native app
stayed stopped. The original preference snapshot remains authoritative. If
the native history changed after interruption, the earlier backup is retained
under a separate snapshot name and verified, unchanged migration outputs are
rebuilt from the newer history. Independently changed Electron outputs block
recovery instead of being overwritten. A late retry also reclaims Electron's
login registration before recording completion.

# Source and installed qualification

[`scripts/build-electron-native-handover-helper.mjs`](../../scripts/build-electron-native-handover-helper.mjs)
compiles the bridge into a caller-selected, previously absent output and can
run only `--contract-smoke-test`. This is safe source evidence; it does not
sign, install, replace, or mutate a profile. A future macOS production package
must compile that executable into the fixed resource location before signing
the complete app.

The required installed rehearsal remains native `0.1.17` and released
`0.1.18`, on Apple Silicon and Intel, to a signed Electron candidate and then
to a newer signed Electron candidate. It must verify retained history, identity
salt, settings, sharing choice, one writer/login owner, Keychain continuity,
restart, interrupted recovery, signing/notarization, and updater behavior.

The updater part has two independent ordering requirements. Pinned
`electron-updater` compares the installed app's semantic version with the
candidate feed's `latest*.yml` semantic version; it does not compare
`buildNumber`, `CFBundleVersion`, or PE file-version metadata. The later signed,
feed-isolated rehearsal candidate must therefore have both a semantic version
greater than the installed candidate and a strictly greater `buildNumber` for
the native handover check. A higher `buildNumber` while both package and feed
versions remain `0.1.18` is not an Electron update rehearsal. This source
version remains unchanged: a rehearsal supplies its two candidate versions as
closed preparation inputs rather than allocating a future stable release in
source control.

## Source-only isolated updater rehearsal

The source selector accepts exactly two macOS versions with this grammar:

```text
M.m.p-native-to-electron-handover.N
```

`M`, `m`, `p`, and `N` are bounded non-negative decimal components, `N` is
positive, both versions have the same `M.m.p` core, the current candidate's
`N` is lower than the next candidate's, and that core is newer than the checked
out `RELEASE_VERSION`. It accepts no preview labels, a different prerelease
name, Windows/Linux target, feed hostname, feed path, or unpaired version.

For a clean, frozen checkout, prepare the two source candidates with the same
ordered pair and distinct disposable build numbers:

```sh
CURRENT_VERSION='<M.m.p-native-to-electron-handover.lower-positive-N>'
NEXT_VERSION='<the-same-M.m.p-native-to-electron-handover.higher-positive-N>'
SOURCE_REVISION='<the-clean-40-character-commit>'

node scripts/package-electron-production.mjs \
  --target darwin-arm64 \
  --source-revision "$SOURCE_REVISION" \
  --build-number 2026090701 \
  --rehearsal-candidate current \
  --rehearsal-current-version "$CURRENT_VERSION" \
  --rehearsal-next-version "$NEXT_VERSION"

node scripts/package-electron-production.mjs \
  --target darwin-arm64 \
  --source-revision "$SOURCE_REVISION" \
  --build-number 2026090702 \
  --rehearsal-candidate next \
  --rehearsal-current-version "$CURRENT_VERSION" \
  --rehearsal-next-version "$NEXT_VERSION"
```

The pair's shared updater endpoint is fixed to
`https://updates.tibotattle.com/electron/rehearsal/native-to-electron-handover-v1/darwin-arm64`.
The stable endpoint remains
`https://updates.tibotattle.com/electron/stable/darwin-arm64`; neither command
changes it. The current and next source receipts are separately written to:

```text
.release-build/electron-production/rehearsal/native-to-electron-handover-v1/current/darwin-arm64/production-source-candidate.json
.release-build/electron-production/rehearsal/native-to-electron-handover-v1/next/darwin-arm64/production-source-candidate.json
```

Each receipt names a distinct `app/`, `native/`, and planned `artifacts/`
directory. The staged `package.json`, distribution metadata, and
`electron-runtime-manifest.json` carry the same candidate semantic version.
The builder independently checks that staging metadata and package version
before it could create an installer. For macOS, the package and updater retain
the full prerelease semantic version; the builder writes its numeric `M.m.p`
core to `CFBundleShortVersionString` and the candidate build number to
`CFBundleVersion`, which is what the guided native handover compares.

Rehearsal metadata uses the fixed channel
`native-to-electron-handover-rehearsal-v1` and contribution policy
`disabled-for-native-to-electron-handover-rehearsal-v1`. It enables prerelease
comparison only for that exact packaged metadata shape. It does not set a feed
URL at runtime, enable accountless production uploads, upload a generic feed,
or claim a released/supported installer. It disables automatic download: the
current candidate may manually download only the metadata-named next version,
and the next candidate accepts no later feed entry.

This source stage remains short of the protected exercise. Before any private
feed is authorized, independently sign and notarize both exact candidate
builds; inspect their identities, plist fields, package/runtime manifests, and
target artifacts; publish a private target-scoped generic feed with a receipt;
then test native `0.1.18` to current and current to next on Apple Silicon and
Intel. Verify the live updater response, retained history and salt, settings,
sharing choice, Keychain continuity, one writer/login owner, restart, and
interrupted recovery. Public downloads and the stable feed are separate rollout
gates.

Keep the native Sparkle routes for users who do not take the guided handover
until that rehearsal and rollout are complete.
