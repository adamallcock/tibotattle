# Linux credential mutex

This directory contains a small Linux x86_64 N-API boundary for the existing
`linux-credential-mutex-v1` contract and one fixed accountless installation
record. It remains a source-qualification component, not a selected credential
backend, production backend, or Linux support claim.

The binding holds its primary lease by binding a fixed Linux abstract AF_UNIX
socket name. It records a durable operation journal in the persistent XDG state
tree:

- socket namespace: `app-usagemonitor/linux-credential-mutex-v1/<effective-uid>/<capability>`
- persistent journal: `XDG_STATE_HOME/app-usagemonitor/linux-credential-mutex-v1`
- accountless record:
  `XDG_STATE_HOME/app-usagemonitor/linux-accountless-installation-credential-v1/accountless-installation-credential-v1`

When `XDG_STATE_HOME` is unset, the persistent base follows the XDG fallback
under the current account's home directory. The binding reopens roots with
Linux handle-based no-symlink checks, validates owner and mode constraints, and
refuses unsafe roots. Credential and journal operations still refuse a missing
root. Before those operations, the Electron main process may call the fixed,
zero-argument `prepareLinuxCredentialState` authority. It resolves the same
native XDG state base: for the passwd-record fallback it may create only the
known `.local` and `state` components beneath the validated account home; for
a configured absolute `XDG_STATE_HOME`, it requires a safe existing direct
parent and may create only that final base. It never reads `HOME` for the
fallback and never recursively creates arbitrary configured ancestors.

Preparation preflights every existing fixed descendant before it creates any
new sibling: `app-usagemonitor`, `linux-credential-mutex-v1`, and
`linux-accountless-installation-credential-v1`. It creates only an absent
fixed directory with mode `0700`, fsyncs its parent, then reopens and validates
the full tree through the same no-symlink, owner, and mode checks. An unsafe
pre-existing base or descendant is rejected without chmod repair, credential
access, socket acquisition, journal transition, record mutation, or a returned
path. A process interruption can leave an incomplete directory tree; a later
preparation reopens and completes only its still-absent fixed components. This
is not a credential-operation recovery protocol.

Each inherited generic `0..3` lease pins one journal file descriptor and
fsyncs its `active` state before returning to JavaScript. A normal, explicitly
settled release writes and fsyncs `normal` through that same descriptor. A
callback failure, process exit, or hard kill preserves `active`. The next
acquirer receives an opaque lease with `abandoned: true`; the JavaScript lease
layer releases only the socket and reports `recovery_required`. It never clears
the active state. The fixed accountless operations hold the same private socket
while they preflight, but do not mark `active` until their mutation boundary
described below. Before every journal transition, the binding compares the
pinned descriptor with the fixed directory entry; a replacement fails closed
without writing or unlinking the replacement. A future explicit recovery
workflow must bind any clearing action to a durable credential-operation
journal.

The abstract socket claim covers ordinary desktop application and companion
processes in the **same Linux network namespace**. It does not claim
cross-network-namespace exclusion, hostile same-UID filesystem tamper
resistance, Secret Service support, or production safety. Persistent
same-UID journal substitution is treated as unsafe and rejected when observed;
protecting a user-owned state tree against a hostile process with that same UID
is outside this qualification boundary.

The native lease is an external object with no enumerable authority fields.
The binding maintains an issued-lease registry, so forged, foreign, or
double-release tokens fail with fixed content-free codes. There is no JavaScript
or lockfile fallback.

The inherited generic lease API remains exactly the four legacy slots `0..3`.
The accountless installation credential uses native-private slot `4`, exposed
only through three fixed methods with no capability or pathname argument:
`readAccountlessInstallationCredential`,
`createAccountlessInstallationCredentialIfMissing`, and
`deleteAccountlessInstallationCredentialExact`. It contains exactly 32 raw
bytes, is not encrypted at rest, and is a distinct upload-only pseudonymous
credential. It is never a provider, social, participant, or FD4 credential.
The Electron main process can pass it only through its existing private FD3
companion channel; this module has no renderer surface.

Create validates an absent record under the private socket, marks the journal
`active` immediately before an `O_EXCL` temporary file can appear, fsyncs the
fixed-size value, publishes with `renameat2(RENAME_NOREPLACE)`, fsyncs the
directory, and performs exact pinned readback. Delete compares the exact
32-byte record, moves it only to a random no-clobber quarantine name, verifies
the pinned identity and bytes, unlinks that verified quarantine, fsyncs, and
checks that the fixed name is absent. A failure before a temporary inode or
rename can occur settles `normal` after rechecking that no record changed.
After any possible record mutation, interruption, malformed or unsafe fixed
record, or failed readback, the durable journal remains `active` and later calls
return `recovery_required`; it is never silently cleared.

This owner-private file is an operating-system file-permission boundary, not a
claim of encryption at rest or protection from a hostile process under the
same UID. It may therefore be exposed by the user's backup policy. A locked
desktop session does not make this file unavailable. Those limits are part of
why `productionSafe` remains false pending separate installed-artifact,
physical-desktop, and release qualification.

Build and create the adjacent sidecar only on native Linux x86_64:

```text
node "$(npm root --global)/npm/node_modules/node-gyp/bin/node-gyp.js" rebuild --directory native/linux-credential-mutex
node scripts/stage-linux-credential-mutex-binding.mjs
node scripts/build-linux-credential-mutex-manifest.mjs
node scripts/qualify-linux-credential-mutex.mjs
```

The manifest checks exact bytes and closed native claims before the loader
requires the module. It is an integrity/mismatch check, not signing or source
provenance. `productionSafe` is deliberately false in both the binding and
manifest. Source tests, native Ubuntu x86_64 qualification, or this README do
not select this backend, Secret Service, participant identity, Electron
composition, packaging, update feeds, or Linux support.

Linux Electron shell staging requires the qualified `.node` and its adjacent
manifest at the fixed `build/qualification` paths. The development and
production builder configurations place both physical files in
`app.asar.unpacked`; the loader derives that sibling path only from its own
`app.asar` module location. Normal source-checkout paths are unchanged. The
sidecar remains subject to the same descriptor, inode, no-symlink and digest
checks. The public pure `validateLinuxCredentialMutexBindingManifest` function
shares the closed schema with staging and artifact verification without loading
native code or asserting provenance. Packaging rejects a missing/mismatched
pair and does not include these files on other targets. This source contract
does not establish an installed native or Secret Service runtime result.
