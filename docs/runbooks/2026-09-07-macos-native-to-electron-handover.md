---
title: macOS native-to-Electron guided handover
date: 2026-09-07
type: runbook
status: draft
---

# Status and boundary

The automatic replacement path is implemented for the 0.1.20 candidate. Signed
installed qualification and publication must complete before presenting it as
available. Released 0.1.19 requires the earlier guided procedure; it is not proof
of ordinary replacement compatibility.

The required user journey is: quit the old app, replace TiboTattle in Applications
with the new signed app, and open it. The app transfers compatible retained state
and settings automatically. No manual directory creation or saved predecessor
bundle is required. Users who already replaced the old app use the same path.

# Runtime decision contract

Startup verifies the current signed Electron app and bundled helper, silently
preflights existing credential access, and inspects the retained native state in
`~/Library/Application Support/Usage Monitor`. Missing old app code is expected.
No predecessor version or signature is fabricated to authorize migration.

A verified preserved 0.1.17/0.1.18 bundle may still use the compatible guided
journal route. Without that bundle, compatibility is determined from the retained
data's actual supported schema, including supported older native schemas. Unknown
or newer schemas preserve the source and refuse migration rather than starting
an empty profile. No intermediate native app update is required for a compatible
schema.

The retained-state helper authenticates its current signed Electron parent and
stops only a running predecessor at the same bundle path whose running code
matches the parent's designated signing requirement. It refuses other same-ID
application paths, unregisters the old startup item and reads existing preferences.
It never copies or resets credentials, broadens Keychain access, or enables sharing.

A verified private backup is checked using the index owner's existing migration
compatibility policy. SQLite inspection uses a disposable clone so retained WAL
or shared-memory files cannot change the backup. The normal transaction below
publishes the copied state and preferences, preserves opt-outs, and claims startup
ownership. Completed profiles bypass predecessor discovery on subsequent launches.

The normal outcomes remain `no_legacy_state`, `migrated`, and `already_migrated`.
Unknown data, unavailable credentials, signature failures and incomplete unsafe
state stop startup with a recoverable error; they never discard history. An
interrupted transaction resumes only when bound to its verified journal and
candidate. Changing builds during an incomplete prior transaction is not an
automatically approved journal rebind.

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
accepts the legacy `--prepare --native-app <absolute bundle path>` operation and
the pathless `--prepare-retained-state` replacement operation.
It verifies the enclosing Electron app identity and selected old app, asks
`NSRunningApplication` to terminate only processes with the exact old bundle
URL, unregisters the same-identity native login item and confirms removal, and
returns bounded language, appearance, refresh, and login-preference values. It
does not accept arbitrary commands, kill by name, receive state paths, query
Keychain, copy credentials, reset credentials, or enable sharing.

The diagnostic `--prepare-preflight --native-app <absolute bundle path>` checks
the helper's bundle context, predecessor, login-item status, preference validity
and writer absence without stopping apps, changing registration or writing state.
Its closed result is a point-in-time observation, not permission or proof that
preparation will succeed. A running selected predecessor blocks this read-only
probe even though the mutating preparation is designed to stop that predecessor.
Preparation rechecks its prerequisites and validates preferences before any
termination or login-item change. Private failures retain only fixed stage codes;
approval-pending, service-not-found and unknown service states remain distinct.
Another running bundle with the same identity blocks preparation; the helper
never terminates it by name or bundle identifier alone.
The user-facing recovery message remains generic. Nonzero helper exits cannot
be accepted as success, even when their output resembles a successful reply.

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

### Rehearsal generic-feed operator boundary

`publish-electron-handover-rehearsal-feed.mjs` accepts only the closed
handover pair and the two macOS target paths. Its default mode validates local
proposal, receipt, manifest, archive hash, and size bindings without invoking
Wrangler. It must be run against an owner-prepared local proposal and artifact
root:

```sh
node scripts/publish-electron-handover-rehearsal-feed.mjs \
  --artifact-root '<approved-artifact-root>' \
  --proposal '<approved-local-proposal.json>' \
  --stage initial
```

A protected publication additionally requires `--publish`, a new local
receipt path, and `--confirm-exclusive-rehearsal-control`. The receipt is
created as a local phase journal before any remote operation and retained on
partial failure. Wrangler exposes no
conditional R2 write, so that flag is an operational assertion: the tool reads
the target feed before and immediately before replacement, then reads it back;
it does not claim a cross-writer atomic update. The historical source family
accepts only an absent or known `.11` feed for initial publication, advances
`.11` to `.12`, and rolls `.12` back to `.11`.

The corrected source family `9be7da8d` accepts exactly `.13` and `.14`. Initial
publication binds the exact historical proposal and completed `.12` advance
receipt (or an explicitly selected completed `.11` rollback receipt) before
replacing those known predecessor bytes with `.13`. A target already at the
exact `.13` bytes is a safe retry. Advance replaces only `.13` with `.14`;
rollback replaces only `.14` with `.13`, or leaves a target already at `.13`
unchanged. Both families refuse arbitrary versions, source revisions, feed
paths and unknown remote bytes. Immutable archives are verified before a feed
is replaced, and a new journal records each attempt.

The follow-up source family `dcf2d6ca` accepts exactly `.15` and `.16`.
It uses the same predecessor proposal shape and permits only the corrected
family's completed `.14` advance as its predecessor. The static lineage
validator checks both predecessor proposals and their completed receipts.
Initial publication moves exact `.14` bytes to `.15`; an already verified
`.15` target is a safe retry. Advance and rollback operate only between `.15`
and `.16`. Historical archives and stable feed paths remain untouched.

The rehearsal namespace is isolated from stable paths, but it is not evidence
that `updates.tibotattle.com` is access-controlled. Confirm the route and R2
ACL separately before treating a rehearsal asset as private. Never use the
Sparkle appcast publisher for this YAML feed.
