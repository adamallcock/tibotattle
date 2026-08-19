# Design note: the first-pairing Keychain prompt

Date: 2026-08-19. Status: option 3 implemented — copy and ordering fixes
shipped on `fix/first-pairing-keychain-ux`; the structural elimination
(Swift-app credential minting over a spawn-time broker channel) is built on
`feat/swift-keychain-broker` and documented in "Implementation" below. The
fresh-account zero-dialog proof remains a release-gate observation (see the
checklist at the end).

## What was observed

On a tester's fresh Mac (dogfood 0.1.13 build 1015), the first
Review-and-approve ceremony raised the raw macOS dialog:

> node wants to access key "app-usagemonitor.contribution-device.v1" in your
> keychain — password field, Always Allow / Deny / Allow

with zero in-app preparation. Two linked harms:

1. Nothing explains why a process named `node` wants a key, why a password is
   being asked, or which button keeps the product working. Deny breaks the
   pairing with no recovery guidance; plain Allow grants one access and lets
   a background pass re-raise the same dialog later.
2. The same ceremony recorded `Last error: device unavailable` on the sync
   status line before self-healing (two fresh Macs) — a separate ordering
   defect fixed alongside this note (see "Shipped in this change").

## Verified trigger chain

The prompt is raised by the packaged Node runtime
(`Contents/Resources/runtime/bin/node`, the companion process — the reader
whose codesign identity is `node` / team `43RTH622SB`,
src/platform/export-identity-keychain.js:40-41) performing the read-back of
the credential it just minted through the `security` CLI:

1. Dashboard ceremony, pairing step —
   apps/web/public/app.js `approveIncrementalContribution`, step
   `device_pairing` → `finishCommunityDevicePairing` →
   `localClient.pairContributionDevice`.
2. Companion route `POST /api/local/contribution/device-pair` —
   apps/local/server.js:4077 → `pairContributionDevice` (wiring at
   apps/local/server.js:2815) → `claimContributionDevicePairing`
   (src/contribution-device-client.js:89) → `ensureContributionDeviceCapability`.
3. Fresh mint — src/contribution-device-capability.js:586 invokes the
   backend's `createIfMissing`.
4. Durable-ACL mint — src/platform/export-identity-keychain.js:447-473
   `writeSecret` runs `security add-generic-password -U -s
   app-usagemonitor.contribution-device.v1 -a installation -T <node> -w …`
   (arguments constructed at :199-223). This succeeds silently.
5. **The prompt** — src/platform/export-identity-keychain.js:507: the
   mandatory read-back (`readInternal` → keytar `getPassword` →
   `SecItemCopyMatching`) is the first decrypt of an item the `security` tool
   created. macOS treats the creating tool, not node, as the item's original
   partition holder, so node's first read needs user confirmation even though
   `-T` put node's designated requirement in the item's trusted-application
   list. The password field is that partition/ACL confirmation — entering the
   login password with Always Allow durably records node's authority on the
   item; plain Allow grants one access; Deny fails the read as
   `errSecAuthFailed` → `credential_denied`.

So on 0.1.10+ (the durable mint shipped in e92b0fb, tagged v0.1.10-v0.1.13)
the first pairing on a fresh Mac is *expected* to raise exactly one dialog.
The pre-0.1.10 keytar-only mint was silent at first pairing (the creating
app is auto-trusted) and instead broke on the first re-signed update — the
2026-08-10 sign-in chain incident: an ad-hoc/updated re-sign invalidated the
default ACL, reads failed `errSecAuthFailed`/`errSecInteractionNotAllowed`,
sync paused `device_unavailable`, and the cure was the device-credential
reset plus a re-pair. The durable mint traded "break silently on every
update" for "one explained-nowhere dialog at first pairing" — this note and
the shipped copy make that dialog explained.

## Do signed updates re-prompt?

- **Items minted by 0.1.9 and earlier (keytar default ACL):** yes, or worse —
  the update invalidates access outright (observed live 2026-08-10). The
  recovery classifier and reset ceremony remain the net for these.
- **Items minted by 0.1.10+ (`-T` designated-requirement mint), after the
  user chose Always Allow once:** no re-prompt is expected across same-team,
  same-identifier updates. Both the `-T` trusted-application entry and the
  grant Always Allow records match the reader by its designated requirement
  (`anchor apple generic` + team `43RTH622SB` + identifier `node`,
  src/platform/export-identity-keychain.js:153-157), which a Sparkle re-sign
  preserves. `contributionDeviceReaderRequirementVerificationArguments`
  (:166-174) pins the codesign check a release runs against the installed
  `runtime/bin/node`. The definitive live proof remains what the sign-in-once
  design (docs/design/2026-08-11-sign-in-once-durability.md, acceptance) says
  it is: a real signed 0.1.x → 0.1.y update cycle against a credential minted
  by the durable path — that stays a release-gate observation, not something
  this note can assert from code alone.
- **Plain Allow instead of Always Allow:** the grant is per-access, so a
  later background pass re-raises the dialog at an arbitrary moment (or, when
  no UI is attachable, fails `errSecInteractionNotAllowed` → the honest
  `device_unavailable` pause). This is why every piece of shipped copy says
  Always Allow specifically.

## Structural options to eliminate the prompt

### 1. Keep the `security -T` mint (status quo, shipped copy explains it)

One dialog, once per Mac, durable afterwards. Cost: the dialog itself, the
Deny hazard (now explained and recoverable in-product), and the raw `node`
process name. No further engineering. This is what ships today.

### 2. Mint with a `SecAccess` carrying the Team-ID designated requirement

What the `-T` flag already approximates. Doing it properly means calling
`SecAccessCreate` + `SecTrustedApplicationCreateFromPath` (or a crafted
requirement string) at item creation — API that keytar does not expose
(`kSecAttrAccess`/`SecAccessRef` are unreachable through it,
src/platform/export-identity-keychain.js:29-39). It would need a patched
keytar fork or a purpose-built native addon, i.e. re-auditing the one native
binding this product byte-pins and signature-verifies. Even then, an item
created *by node* with a custom SecAccess keeps node as partition holder, so
it eliminates the first-read prompt only if creation happens in the same
process that reads — which it would. Feasible, but it concentrates risk in
exactly the audited-native-binding surface the repo works hardest to keep
frozen. Not contained; deferred.

### 3. Move the mint (or all Keychain access) into the signed Swift app

The TiboTattle.app main executable creates the item via `SecItemAdd` with an
ACL trusting both itself and the node helper's designated requirement, then
the companion reads it as today. An item created by a Developer ID-signed
app gets that app's team as partition holder, and node is same-team, so the
first companion read matches both the partition and the `-T`-equivalent
trusted-application entry — **no dialog at mint, no dialog at first read, and
designated-requirement durability across updates**. This is the genuine
structural fix. Cost: a new native surface (Swift ↔ companion IPC for
"mint now", or a small signed helper binary the companion spawns), plus the
ceremony currently mints lazily inside the pairing HTTP request — the app
process is not in that path today. Clearly not contained in this change;
**recommended direction** if the one-dialog experience is judged not good
enough after this change's copy ships.

### 4. `kSecUseDataProtectionKeychain` with proper entitlements

The iOS-style keychain has no per-item ACL dialogs at all: access is decided
by code signature + `keychain-access-groups` entitlement. Eliminates every
prompt permanently and is the App Store-compatible destination (the MAS
compatibility workstream already exists, d22a6bd). Cost: the entitlement
requires provisioning-profile-backed signing for the *reader*; the reader
today is a bare `node` binary inside Resources, which cannot carry
entitlements of its own — this option only works combined with option 3
(Swift-side access) or by promoting the companion into an entitled,
bundled helper app. Also a data-protection item is a different storage class,
so shipping it means a one-time migration for existing credentials (the
lazy-migration pattern from `migrateLegacyContributionDeviceCapability`
applies). Largest change, best end state; defer until option 3's IPC
boundary exists, then reassess.

### 5. Repair the partition list after the CLI mint

`security set-generic-password-partition-list -S teamid:43RTH622SB …`
requires the login keychain password as input — it raises the same
interaction it would remove. Rejected.

## Recommendation

Ship the copy + ordering fixes now (done, this branch). Adopt option 3 as
the structural fix when native effort is next scheduled, with option 4 as its
follow-on once the Swift-side Keychain boundary exists. Options 2 and 5 are
rejected. Until then, the one first-pairing dialog is a prepared, explained,
recoverable moment instead of a raw OS interruption.

## Implementation (feat/swift-keychain-broker)

Option 3, with the boundary drawn slightly stricter than sketched above: the
live companion never touches the Keychain for the new credential generation
at all — not even reads. Every touch happens inside the signed app.

### The broker channel

At companion spawn, `CompanionProcess.launch` creates a
`socketpair(AF_UNIX, SOCK_STREAM)` and hands the child end to the companion
as its standard input (previously the unused null device); the environment
carries only `USAGE_MONITOR_KEYCHAIN_BROKER_FD=0` — the descriptor number,
which is not a secret. This shape was chosen over the alternatives because:

- **No credential exists to leak.** The kernel-held socket end *is* the
  authority: only the spawned child owns the peer. A loopback listener or a
  companion HTTP route would need endpoint discovery plus a bearer token,
  both new secrets with new lifetimes; the socketpair needs neither, and
  nothing crosses argv, the environment, or the filesystem.
- **It matches the existing process relationship.** The app already owns the
  companion's stdio; the broker adds a fourth stream to an existing spawn
  rather than a first-ever app-serves-node network surface.
- **Single-purpose by construction.** The wire protocol
  (`apps/macos/Sources/KeychainBroker.swift`,
  `src/platform/contribution-device-keychain-broker.js`) is newline-framed
  JSON with three operations (get/set/delete), bounded frames, strict
  in-order ids, and no service/account addressing — the companion cannot
  name any other Keychain item through it. Any protocol deviation fails the
  channel closed on both sides.

### Storage generations

New credentials live under a new service,
`app-usagemonitor.contribution-device.app.v1`
(`EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDeviceApp`), minted by
the app via `SecItemAdd` into the login keychain. A different service
string — not a marker attribute — separates the generations, so app-side
code can never accidentally decrypt a `security`-CLI-minted `.v1` item;
that read is exactly the partition prompt this work eliminates. Each item
carries a `SecAccessCreate` object trusting the app and the bundled Node
runtime by designated requirement (the `-T` semantics the durable mint
already relied on): the app's own reads are silent as creator, and the
one-shot Identity & Device Reset helper — a separate node process with no
broker channel — keeps its silent keytar read + exact-delete over the new
item. `kSecUseDataProtectionKeychain` was re-assessed and stays rejected
for now: it requires provisioning-profile-backed entitlements the Developer
ID app does not carry (option 4 remains the follow-on once it does).

### Companion-side composition

`createAppBrokeredContributionDeviceBackend`
(src/contribution-device-capability.js) implements the existing backend
contract: the broker binding is keytar-shaped, so the audited
export-identity backend logic (compare-and-swap, read-back, zeroization,
locked/denied classification) runs unchanged over the wire; the legacy
generation keeps its exact keytar read/delete paths, loaded lazily so a
fresh install never depends on the native binding for brokered operations.
Reads prefer the app generation, then fall through to legacy.

### Migration

- **Fresh install (app-spawned):** the pairing mint goes straight to the
  broker. No dialog at mint, none at read-back, none at upload auth or
  rotation. Nothing is ever written to the legacy service.
- **Existing install:** reads, uploads, disconnect, reset — all unchanged
  against the legacy item. The migration point is the next silent ~25-day
  rotation (`replaceExact` with the credential still legacy-resident): the
  service-committed replacement is minted app-side, read back through the
  broker, and the legacy item is then retired through the existing
  attribute-addressed deletion path (never decrypted, never prompting). A
  crash between the two steps leaves the valid new credential shadowing the
  stale legacy item, which the next rotation, disconnect, or reset sweeps.
- **Reset / disconnect:** the credential-reset route's attribute delete and
  the Identity & Device Reset helper now clear both generations; disconnect
  exact-deletes whichever generation holds the credential.
- **Downgrade after migration:** an older build cannot see the app
  generation, reads `credential_missing` against the still-present binding
  file, and lands in the existing recovery ceremony — honest and curable by
  re-pairing.
- **Development / standalone companion:** no broker announcement means the
  production keytar + durable-CLI mint path is byte-for-byte today's
  behavior.

### Failure semantics

A broker that is announced but unusable — malformed announcement, dead
socket, timeout, protocol violation — fails every credential operation with
the coded `ExportIdentityKeychainError` family, which the capability layer
reports as the same recoverable `contribution_device_credential_*` errors
the pairing path uses today (`contribution_device_recovery_required` /
`contribution_device_keychain_access_denied` at the route). It never falls
back to a companion-side mint: that fallback would silently resurrect the
dialog. Every broker await is timeout-bounded; there is no state that
hangs. Broker *creation* failure at spawn (descriptor exhaustion) degrades
to a broker-less companion where the shipped, explained pairing copy
remains the net.

## Release-gate checklist (fresh-account zero-dialog proof)

The acceptance this worktree cannot run: on a **real fresh macOS account**
(no prior TiboTattle Keychain items, no Always Allow grants) running a
signed build that includes `feat/swift-keychain-broker`:

1. Install, launch, sign in, and complete the Review-and-approve ceremony
   end to end. **Zero Keychain dialogs** may appear at pairing, at first
   sync, and across an app restart plus a second sync pass.
2. `security find-generic-password -s app-usagemonitor.contribution-device.app.v1 -a installation`
   shows the item; the `.v1` service has none.
3. Identity & Device Reset on that account completes with status `reset`
   and removes the `.app.v1` item (verify with the same probe), still with
   zero dialogs.
4. Migration leg, on a Mac holding a 0.1.10+ durable-mint `.v1` credential:
   after the next credential rotation (or a forced renewal), the `.app.v1`
   item exists, the `.v1` item is gone, and sync continues without a
   dialog and without a re-pair.
5. Update-durability leg (extends the sign-in-once acceptance): a signed
   0.1.x → 0.1.y update over an `.app.v1` credential keeps uploading with
   no dialog and no `device_unavailable` pause — the app's designated
   requirement, not a code snapshot, must be what the ACL matched.
6. Deny-hazard regression: on the fresh account, the pairing step's
   in-ceremony guidance should now be unreachable (no dialog to answer);
   confirm the ceremony copy still renders correctly for legacy installs.

## Shipped in this change (for reference)

- Pairing-step guidance in the ceremony status area and a static approve-card
  annotation (apps/web/public/app.js `CONTRIBUTION_CONNECT_STEPS.device_pairing`,
  apps/web/public/index.html; trilingual via localization.js).
- Deny recovery: `contribution_device_credential_denied` at pairing now
  answers `contribution_device_keychain_access_denied`
  (apps/local/server.js:4157), which the dashboard routes into the existing
  credential-reset ceremony with dialog-specific copy (Always Allow on the
  retry).
- Ordering: an approval with no credential binding on disk defers the first
  sync attempt to the pairing cure
  (`approve({ awaitingDevicePairing })`,
  src/application/local-incremental-contribution-sync.js), and `resume()`
  clears a cured pause's own `lastOutcome` record — the ordinary first run
  records no `device_unavailable` error, while real device loss pauses and
  surfaces exactly as before.
