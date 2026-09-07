# macOS app-owned Keychain adapter

`macos-keychain.node` is a narrow N-API adapter intended for Electron's signed
main process. It has no automatic loader and does not claim that a source build
is an installed or qualified production artifact.

The module accepts only these logical capabilities:

- `export_identity`
- `account_observation`
- `claude_session_pseudonym`
- `contribution_device`

Each maps internally to the stable `app-usagemonitor.*.app.v1` service and the
fixed `installation` account. Service names, accounts, paths, commands, and
Keychain queries are never supplied by JavaScript.

The binding exports contract version `tibotattle-macos-keychain-v1`, the ordered
capability list, and these methods:

| Method | Result |
| --- | --- |
| `identityStatus()` | synchronous `valid` or `invalid` main-bundle preflight |
| `inspect(capability)` | Promise of `absent`, `present`, `locked`, `denied`, `migration_required`, or `unknown` |
| `read(capability)` | Promise of `{ status, value }`; `value` is a 32-byte Buffer only when present |
| `store(capability, Buffer32)` | Promise of `stored`, `locked`, `denied`, `migration_required`, or `unknown` |
| `remove(capability)` | Promise of `deleted`, `absent`, `locked`, `denied`, or `unknown` |

The main-thread preflight checks the fixed bundle identifier before work is
queued. The worker verifies the production code-signing requirement immediately
before every Keychain operation. It serializes the process-wide Security
interaction setting, disables interaction, and restores the prior setting. New
items use the existing app-only `SecAccess` policy. An existing modern item is
updated only through `kSecValueData`, retaining its original ACL. A duplicate
add after an absence preflight fails closed and preserves the item; this adapter
never deletes a credential as part of `store`.

Each operation captures the user's Keychain search list and binds its modern
and legacy queries to that exact list. A not-found result is trusted only when
every member is unlocked and readable. A successful modern read remains usable
if another listed keychain is locked. A new item goes explicitly into an
unlocked default keychain from the captured list.

When a modern lookup is absent, the adapter makes a fixed **attribute-only**
probe for the corresponding legacy `.v1` pair. A present or indeterminate legacy
probe returns `migration_required`; a proven absent legacy item returns
`absent`. It never reads legacy secret bytes, changes a legacy ACL, deletes a
legacy item, prompts, logs Keychain data, or mints a modern identity over a
legacy-only profile. `store` repeats that probe before every first modern add.
The composed Electron bridge loads this module only from a verified production
resource and maps its fixed capabilities to the existing keytar-shaped channel.
Signed-candidate identity continuity remains a separate qualification gate.

`binding.gyp` and
[`scripts/build-electron-macos-keychain-adapter.mjs`](../../scripts/build-electron-macos-keychain-adapter.mjs)
provide source-only per-architecture compilation. They do not sign, package,
install, or exercise Keychain data. A signed Electron candidate must separately
prove that its actual main-process identity can read a disposable native-style
`.app.v1` item before any production composition uses this adapter.
