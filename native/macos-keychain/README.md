# macOS app-owned Keychain adapter

`macos-keychain.node` is a narrow N-API adapter intended for Electron's signed
main process. It has no automatic loader and does not claim that a source build
is an installed or qualified production artifact.

The module accepts only these logical capabilities:

- `export_identity`
- `account_observation`
- `claude_session_pseudonym`
- `contribution_device`
- `accountless_installation` (main process only)

Each maps internally to the stable `app-usagemonitor.*.app.v1` service and the
fixed `installation` account. Service names, accounts, paths, commands, and
Keychain queries are never supplied by JavaScript. The first four capabilities
are the fixed FD4 broker list. `accountless_installation` never crosses that
pipe, is unavailable through FD4, and is not a synonym for
`contribution_device`. When explicitly enabled in the stable desktop profile,
its 32-byte value can travel only over the private inherited FD3 channel to the
owned upload companion; it never reaches a renderer, UI IPC, or an HTTP route.

The binding exports contract version `tibotattle-macos-keychain-v3`, the ordered
capability list, and these methods:

| Method | Result |
| --- | --- |
| `identityStatus()` | synchronous `valid` or `invalid` main-bundle preflight |
| `inspect(capability)` | Promise of `absent`, `present`, `locked`, `denied`, `migration_required`, or `unknown` |
| `read(capability)` | Promise of `{ status, value }`; `value` is a 32-byte Buffer only when present; malformed stored data is `invalid` |
| `store(capability, Buffer32)` | Promise of `stored`, `locked`, `denied`, `migration_required`, or `unknown` |
| `remove(capability)` | Promise of `deleted`, `absent`, `locked`, `denied`, or `unknown` |
| `createIfMissing(accountless_installation, Buffer32)` | Promise of `created`, `existing`, `locked`, `denied`, `migration_required`, or `unknown` |
| `deleteExact(accountless_installation, Buffer32)` | Promise of `deleted`, `missing`, `mismatch`, `locked`, `denied`, `migration_required`, or `unknown` |

The main-thread preflight checks the fixed bundle identifier before work is
queued. The worker verifies the production code-signing requirement immediately
before every Keychain operation. It serializes the process-wide Security
interaction setting, disables interaction, and restores the prior setting. New
items use the existing app-only `SecAccess` policy. An existing modern item is
updated only through `kSecValueData`, retaining its original ACL. A duplicate
add after an absence preflight fails closed and preserves the item; this adapter
never deletes a credential as part of `store`.

Electron startup preflights `account_observation` and `contribution_device`,
the currently active desktop paths. `export_identity` remains an on-demand
legacy path and `claude_session_pseudonym` remains reserved for the optional
Claude provider. They retain the same read, store, and migration-required
guards at first use: a required export migration must be approved through the
released native application's local approval flow. The main-only
`accountless_installation` path is checked only when sharing requires it.

Startup maps credential readiness to fixed, content-free reasons: locked,
denied, migration required, timeout, invalid credential, adapter-integrity
failure, or Security-framework unavailability. A blocked launch offers a
user-driven Retry and the safe Quit default. Retry repeats the silent read; it
does not enable Keychain interaction, create a replacement, change an ACL, or
start the companion. When accountless sharing is active, Electron also reads
and immediately clears the main-only `accountless_installation` value before
the companion can start. A saved opt-out performs no accountless credential
read.

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

`createIfMissing` never updates an existing item. Its checked add is serialized
with interaction disabled; a duplicate is returned as `existing` and the item
is preserved. `deleteExact` compares the 32-byte secret then deletes only the
returned persistent Keychain reference, so a replacement between that read and
delete cannot be selected through a stale service/account query. This is
in-process serialization for Electron's single installed instance, not an
OS-wide compare-and-swap claim across independently launched processes. Both
operations accept only the main-only `accountless_installation` capability.
The generic `store` and `remove` calls reject that capability, leaving these
conditional operations as its only mutation surface.

A locked accountless item is reported as explicitly retryable availability and
does not create, replace, or delete an identity. Denial and required legacy
recovery remain terminal until the owner takes the corresponding local action.

The Electron production composition reads the old encrypted
`accountless-installation-credential-v1.json` only as bounded ciphertext
metadata. It never calls Electron `safeStorage` for macOS production. A present
or unreadable legacy ciphertext blocks accountless use for explicit recovery;
it is not decrypted, rewritten, deleted, or replaced with a new Keychain
identity automatically.

`binding.gyp` and
[`scripts/build-electron-macos-keychain-adapter.mjs`](../../scripts/build-electron-macos-keychain-adapter.mjs)
provide source-only per-architecture compilation. They do not sign, package,
install, or exercise Keychain data. A signed Electron candidate must separately
prove that its actual main-process identity can read a disposable native-style
`.app.v1` item before any production composition uses this adapter.
