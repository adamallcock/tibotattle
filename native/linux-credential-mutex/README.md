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
- fixed accountless operation journal:
  `XDG_STATE_HOME/app-usagemonitor/linux-credential-mutex-v1/accountless-operation-4-v2`
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

Kernel `mkdirat` applies the process umask. An uncommon umask that masks an
owner permission bit can leave a newly created component below `0700`; the
immediate validation fails closed, and a later preparation refuses that unsafe
partial component unchanged rather than chmod-repairing it. This is an
availability limitation for such a process configuration. It creates no
credential, journal, or record before that refusal.

Each inherited generic `0..3` lease pins one journal file descriptor and
fsyncs its `active` state before returning to JavaScript. A normal, explicitly
settled release writes and fsyncs `normal` through that same descriptor. A
callback failure, process exit, or hard kill preserves `active`. The next
acquirer receives an opaque lease with `abandoned: true`; the JavaScript lease
layer releases only the socket and reports `recovery_required`. It never clears
the active state. Before every journal transition, the binding compares the
pinned descriptor with the fixed directory entry; a replacement fails closed
without writing or unlinking the replacement.

Slot four retains `journal-4-v1` only as its legacy compatibility fence. It
must be absent or exactly `normal` before a fixed operation starts; legacy
`active`, malformed, replaced, or otherwise invalid v1 state is a permanent
`recovery_required` refusal. A fully settled v2 transaction never changes v1 to
`active`, so the next holder can replay its exact v2 intent. The binding writes
v1 `active` only for an unsafe record, malformed/unbound v2 state, an orphaned
fixed residue, or an uncertain v2 settlement. It never clears that legacy
fence. A future explicit recovery workflow must bind any clearing action to a
durable credential-operation journal.

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

Before a slot-four create or delete can mutate the record, the binding creates
the owner-only `accountless-operation-4-v2` file with `O_EXCL`, pins and
rechecks that descriptor and directory entry, writes and fsyncs its entire
fixed 64-byte value, then fsyncs the pinned mutex directory. Its bytes are:

- `0..15`: exact `TIBOTATTLE-FD3\0\0` byte array
- `16`: version `2`
- `17`: operation `1` (create) or `2` (delete)
- `18..31`: zero reserved bytes
- `32..63`: the exact 32-byte create candidate or delete expectation

The candidate is therefore retained in an owner-only `0600` journal under the
same unencrypted-at-rest permission boundary as the fixed record. It is never
logged or exported. Its deterministic, no-clobber residues are
`.accountless-create-4-v2` and `.accountless-delete-4-v2`. With no valid v2
intent, either residue is an orphan: the binding writes the legacy v1 refusal
fence and never adopts or deletes it.

Under the slot-four abstract socket, a valid create intent may replay only its
stored candidate: an absent final and absent create residue creates that exact
residue, an exact residue is published with `renameat2(RENAME_NOREPLACE)`, and
an exact final settles the intent. A valid delete intent may remove only its
stored expected bytes: it moves an exact final to the fixed delete residue,
then validates and unlinks that exact residue; an absent final and absent
residue settles it. Every replay mutation rechecks the pinned owner-only
directory, journal identity, source identity, mode, and fixed pathname. Any
different, malformed, replaced, cross-operation, or both-present state fails
closed without journal cleanup.

An observed create final or delete absence does not by itself settle a prior
transaction: recovery first fsyncs the pinned credential directory and
revalidates the exact final/residue postcondition both before and after that
fsync. A failed prior record-directory fsync therefore cannot be followed by a
state-directory-only journal removal.

Only after the intended final postcondition has been directory-fsynced and
exactly read back does the binding unlink the pinned v2 journal and fsync its
directory. If that unlink, its directory fsync, or the journal descriptor close
is uncertain, the binding returns `recovery_required` and writes legacy v1
`active` before releasing the socket. It does not claim that the v2 name was
retained and does not recreate an intent from observed record state. A later
call therefore remains refused even if it observes an exact final record and no
v2 name.

Focused native tests use controlled valid on-disk modeled interruption states
(before/after temporary creation or rename, after publication or unlink). They
do not simulate an actual process kill, kernel crash, storage loss, or power
failure; native Linux x86_64 CI remains the required runtime qualification.

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
