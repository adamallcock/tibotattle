# Windows native security adapter

This is a fail-closed capability boundary. The published Electron application
has a Windows x64 release, but this binding's general production/path-walk
policy remains disabled. Its narrow source-reader is enabled in this unreleased
source candidate, with native and packaged qualification pending. Source
compilation, native unit tests, or a valid sidecar do not establish that the
candidate works in the installed app. See the
[current status matrix](../../docs/current-status.md).

This directory contains the reviewed Windows-only filesystem and credential
mutex boundary for private TiboTattle state. The binding is deliberately a
small C N-API module;
it does not depend on a JavaScript filesystem path check being equivalent to a
Windows ACL or reparse-point check.

Build it on native Windows x64 with the repository's pinned Node toolchain:

```text
npm exec -- node-gyp rebuild --directory native/windows-filesystem
node ./scripts/build-windows-filesystem-manifest.mjs
```

The resulting `build/Release/windows_filesystem.node` and its adjacent
`windows_filesystem.node.manifest.json` are loaded only on native
Windows x64 by `src/platform/windows-filesystem.js`. macOS, Linux, Windows
ARM64, and missing/invalid bindings fail closed. The source contains a
qualification-only accountless upload-credential backend, separate from the
legacy Credential Manager capability boundary and its four logical IDs. It is
not a selected production credential backend.

The loader reads the fixed sidecar manifest, verifies the binary byte count and
SHA-256 before loading it, and cross-checks the binding's contract and native
capability claims against the manifest. The manifest has an explicit
`approvedPolicy`. Overall production and path-walk policy remain `false`; only
the narrow `credentialMutexSafe` contract is approved after native
qualification. This prevents self-reported booleans from enabling a production
path. The sidecar digest is
an integrity/mismatch check, not a provenance signature: a production release
must authenticate the manifest through a signed installer, signed manifest, or
equivalent allowlist before enabling Windows behavior.

The native methods are intentionally small and content-free on failure. The
binding still advertises `productionSafe: false` and
`pathWalkRaceSafe: false`, so the participant-identity integration refuses to
use it on a real Windows host. The path walker now uses `NtCreateFile` with a
held `RootDirectory` handle for every component; it no longer performs a
path-based validation pass followed by a second path-based open. The flag is
kept false until native Windows qualification proves the exact OS/build and
adversarial filesystem matrix, resolves the cross-session scope, and supplies
the remaining protected-state, audit, and binding-integrity evidence. This is
an intentional fail-closed gate, not a Windows support claim.

Intermediate components are opened as existing directories with
directory-safe access/share flags and `FILE_OPEN`; final-object access and
disposition are selected independently. Missing directories are created one
component at a time relative to the held parent handle. Creation requests
`WRITE_DAC`, supplies the protected descriptor, reapplies that DACL through
the handle, and marks a newly-created object delete-on-close if any validation
step fails.

- `inspectPath(path)` opens the final object without following a reparse point,
  records volume/file identity, link count, owner/DACL facts, and final-path
  resolution, and returns a metadata object for diagnostics.
- `ensureDirectory(path)` creates a missing directory with a protected,
  non-inheriting owner DACL and validates an existing directory.
- `readFile(path)` opens and validates a regular file through its handle,
  flushes no state, and returns bytes plus the handle identity.
- `createFile(path, bytes)` uses exclusive creation, an explicit protected DACL,
  `FlushFileBuffers`, close/reopen, and identity/security revalidation.
- `deleteFile(path, identity)` reopens the expected file, compares its handle
  identity and security, and marks that exact handle for deletion.
- `replaceFile(path, expectedIdentity, bytes)` creates a protected temporary
  file in the already-open parent directory, flushes and validates it, and
  atomically renames it over the target with `NtSetInformationFile` using the
  parent handle as `RootDirectory`. It reopens the destination and verifies
  the replacement handle identity, canonical final path, and bytes before
  returning. Expected paths are normalized through `GetLongPathNameW`, so a
  valid 8.3 short-name spelling can be compared with the normalized handle
  path. This is a qualification-only primitive; no production selector uses
  it today. Its ordinary race guarantee applies only to cooperating writers
  holding the opaque per-capability mutation lease across the operation. That
  lease is a `Local\` named mutex, so the guarantee is limited to one
  interactive Windows session. A deliberate same-UID process can bypass that
  lease and replace a name; that hostile case is outside this cooperation
  contract and is not a generic conditional-replacement/CAS gate.
- `inspectProtectedChild(root, rootIdentity, child)`,
  `readProtectedChild(root, rootIdentity, child, maximumBytes)`,
  `createProtectedChild(root, rootIdentity, child, bytes)`,
  `deleteProtectedChild(root, rootIdentity, child, expectedIdentity)`, and
  `replaceProtectedChild(root, rootIdentity, child, expectedIdentity, bytes)`
  first reopen and authenticate `root`, compare its handle identity with the
  caller-supplied identity, then resolve each child component relative to that
  held root handle. Child input is parsed again natively, so a JavaScript path
  check cannot redirect the operation. The read variant rejects a file larger
  than `maximumBytes` before allocating the returned byte vector.
- `acquireCredentialMutex(capabilityId)` accepts only one of four fixed numeric
  capability IDs, derives a per-user `Local\` kernel-object name from the
  current SID, applies and revalidates a protected owner-only DACL, and performs
  a non-blocking wait. It returns an opaque native lease only after a normal
  acquisition. An abandoned-owner result is released and closed, then surfaced
  as a fixed error so the JavaScript lease layer can retry once before any
  credential mutation begins. It serializes cooperating processes per
  capability in one interactive session only; the current manager deliberately
  reports `crossSessionSafe: false`.
- `releaseCredentialMutex(lease)` accepts only that opaque lease, verifies
  same-thread ownership and active state, releases exactly once, and closes the
  non-inheritable handle. The native issued-token registry is protected against
  concurrent Node worker-thread calls. JavaScript retains an in-process guard
  because Win32 mutex acquisition is recursive on one thread.

## Fixed accountless installation credential

The separate
[`windows-accountless-installation-credential-v1`](../../src/platform/windows-accountless-installation-credential.js)
backend owns one fixed, upload-only accountless installation secret. It is
exactly 32 bytes and is neither a provider, social, participant, nor legacy
Credential Manager credential. Its public backend surface has only `read`,
`createIfMissing`, and `deleteExact`; callers cannot choose a capability, record
name, or path. The fixed record
`accountless-installation-credential-v1.bin` and its fixed
`.accountless-installation-credential-v1.journal` live below the authenticated,
owner-private protected-state root selected by the main-owned composition.

The binding supplies
`acquireAccountlessInstallationCredentialMutex()` and
`releaseAccountlessInstallationCredentialMutex(lease)` for that record alone.
They have no capability parameter and are separate from the four generic IDs
`0..3` and the legacy FD4 broker. The native mutex is a per-current-owner
`Local\` object: it serializes cooperating processes in one interactive Windows
session, not every session for that owner.

This is an owner-private filesystem-permission boundary, not encryption at
rest. A backup policy can copy the plaintext secret, and a process acting as the
same Windows owner can alter the protected state outside the cooperating-writer
contract. The `Local\` mutex does not provide a cross-session guarantee. This
backend makes no lock-screen availability guarantee: it is a filesystem record,
not a Credential Manager lock-state boundary. These limits are deliberate
source-boundary facts, not a shipping Windows credential-store claim.

Before create or exact-delete can mutate the record, the backend durably writes
the journal's `active` state. An uncertain mutation, unsafe/malformed fixed
record, failed exact readback, failed release, or interrupted operation attempts
to retain that state; after it is verified, later calls return the fixed
`recovery_required` result rather than silently minting or replacing an
installation identity. If the backend cannot retain and verify that marker, it
returns a fixed operation failure without claiming restart-persistent recovery.
A known pre-mutation failure does not poison a previously normal journal, so a
later retry can safely proceed. Only the main-owned accountless adapter can
compose this secret into the existing private FD3 companion channel; it is not
exposed through FD4, renderer IPC, or HTTP.

The binding and backend deliberately remain `productionSafe: false`, and runtime
selection remains dormant. Native Windows x64 build, sidecar-manifest,
protected-state/mutex security, physical runner, installed lifecycle, signing,
and release qualification remain separate gates.

The protected DACL is deliberately strict: only the current user
SID is an allow principal. Inherited SYSTEM/Administrators/user-group allows
are not treated as an acceptable owner-only substitute; the later production
milestone must decide whether to retain this strict policy or document and
prove a narrower service-account exception.

The native implementation resolves `NtCreateFile`, `NtSetInformationFile`, and
`RtlNtStatusToDosError` from the Windows system `ntdll.dll`; no third-party
runtime or package is introduced. The native binding remains Windows x64-only.
Credential mutation audit durability is provided separately by the fixed
SQLite prepared/settled/recovered journal; neither the mutex nor audit enables
the still-disabled Windows production selectors.

The protected-child operations are real binding exports, but the v1 manifest
does not yet require them and the public protected-state readiness facts remain
false. Native Windows x64 CI must build this source, execute the protected-child
security tests, and retain its receipt before an installed Electron path can
rely on root-binding or bounded-read claims. A same-UID process that deliberately
bypasses the cooperation contract is not a conditional-replacement gate. The
disabled production flags, native Windows x64 physical and adversarial
qualification, cross-session decision, protected-state and audit lifecycle,
and authenticated installer/binding provenance remain separate production
gates.


## Shared source handles (pending native qualification)

The `windows-source-read-v1` extension supplies `openSourceFile(path)`,
`statSourceFile(lease)`, `readSourceFile(lease, offset, length)` and
`closeSourceFile(lease)`. It accepts ordinary inherited source ACLs only when the
current user owns the regular, single-link file. It does not change Codex source
permissions. Components are traversed relative to held handles with reparse
rejection; ancestors and source remain open without delete sharing until close.
Each native read is capped at 64 KiB before allocation. Source leases share the
bounded 64-slot guard registry, with source-only validation at their public close
entrypoint. The common JavaScript source-file adapter splits larger buffer reads
and exposes a FileHandle-like interface to the existing readers.

Timing and credential audit use `windows-protected-sqlite.js` for protected
owner-only database/journal creation and the existing native guard lifecycle.
Before any schema query, it enters EXCLUSIVE locking, selects PERSIST journaling,
forces recovery, then returns to NORMAL locking and releases the temporary lock
with a read. PERSIST alone does not prevent journal deletion during hot-journal
recovery. The shared sequence has portable SQLite crash/reopen coverage; native
Windows recovery remains a qualification gate. SQLite closes before guards
release. Timing refuses WAL/SHM residue and non-rollback headers without deletion;
no schema migration is introduced.

An optional closed `sourceRead` manifest capability binds the generic methods and
contract to the native digest. Existing manifests remain compatible for their
existing consumers. Source-read approval is separate from the still-disabled
general production/path-walk policies and requires the approved audit guard.
`WINDOWS_SOURCE_READ_APPROVED` is true in the unreleased source candidate; the
loader still rejects a missing or mismatched binding, manifest, contract, or
audit guard. A sidecar-only approval edit is rejected. Run the native security
suite against a rebuilt exact binary and manifest on Windows x64, then the
packaged worker smoke before merging this candidate. See the
[implementation and qualification plan](../../docs/plans/2026-09-13-windows-model-performance.md).

The native and packaged timing qualifications use disposable synthetic Codex
sources. On elevated hosted runners a new file can take the Administrators
group as its default owner. Fixture setup gives its isolated child process a
current-user default owner before creating the source, so Windows assigns its
ordinary inherited/default DACL at creation. Real Codex sources are never
modified by this setup; the native reader still refuses a foreign owner.

Projects & threads also uses these source leases for local display metadata.
Selected rollout-head hints use the same leases, without reading titles, so
paginated replacement histories and inline children resolve across platforms.
The main SQLite database and existing sidecars remain leased through connection
close. With no sidecars, an immutable read avoids creating coordination files
and rejects main-file or sidecar-presence changes. Live WAL reads require both
existing WAL and SHM files; SQLite may update existing SHM coordination bytes,
but the reader does not write database/WAL content or change journal mode or
source permissions. A transient create/remove of an absent sidecar by a hostile
same-owner process is outside the lease guarantee. Unsafe metadata retains the
anonymous fallback. Native metadata tests and the packaged project/task journey
are required in addition to model-performance qualification; see the
[issue #208 plan](../../docs/plans/2026-09-22-windows-project-task-names.md).
The shared `test/work-usage-platform-parity.test.js` runs identical metadata
assertions against the real macOS and Windows adapters. A macOS result does not
qualify the native Windows binding.
