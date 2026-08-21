# Windows native security adapter

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
ARM64, and missing/invalid bindings fail closed. The source is not a production
credential backend: Credential Manager storage remains a separate capability
boundary, while this binding supplies its cross-process mutation lock.

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
kept false until the native Windows qualification proves the exact OS/build
matrix and the remaining replacement and binding-integrity gates. This is an
intentional fail-closed gate, not a Windows support claim.

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
  replaces the target with `NtSetInformationFile` using the parent handle as
  `RootDirectory`. The expected destination handle is held with read and
  delete sharing (and without write sharing), as required by POSIX replacement,
  from identity validation through the rename. Every renameable ancestor from
  the state root through that parent is held without delete sharing for the
  same transaction, pinning the state-root boundary even though the final
  destination deliberately permits delete sharing. The binding
  uses the Windows 10 1709+ `FileRenameInformationEx` class with
  `FILE_RENAME_REPLACE_IF_EXISTS | FILE_RENAME_POSIX_SEMANTICS`, which permits
  replacement while that identity-bound handle remains open. A final-target
  rename or delete can therefore be admitted by the OS sharing policy; the
  qualification pause deliberately exercises that case. The operation repeats
  security, identity, and canonical-path validation for the destination and
  temporary handle immediately before the rename, but Windows' rename API has
  no expected-file-ID argument, so a permitted or privileged final-target
  mutation remains a residual TOCTOU boundary. Existing hard-link aliases are
  rejected by the link-count validation, and the replacement is created and
  revalidated as a single-link object. This revalidation is qualification-only,
  not a production race-proof claim: unsupported OS/filesystem combinations
  fail closed, and the binding continues to advertise `productionSafe: false`
  and `pathWalkRaceSafe: false` until the supported Windows/filesystem matrix
  and remaining binding-integrity gates are proven. It reopens the destination
  and verifies the replacement handle identity, canonical final path, and
  bytes before returning. Expected paths are normalized through
  `GetLongPathNameW`, so a valid 8.3 short-name spelling can be compared with
  the normalized handle path.
- `acquireCredentialMutex(capabilityId)` accepts only one of four fixed numeric
  capability IDs, derives a per-user `Local\` kernel-object name from the
  current SID, applies and revalidates a protected owner-only DACL, and performs
  a non-blocking wait. It returns an opaque native lease only after a normal
  acquisition. An abandoned-owner result is released and closed, then surfaced
  as a fixed error so the JavaScript lease layer can retry once before any
  credential mutation begins.
- `releaseCredentialMutex(lease)` accepts only that opaque lease, verifies
  same-thread ownership and active state, releases exactly once, and closes the
  non-inheritable handle. The native issued-token registry is protected against
  concurrent Node worker-thread calls. JavaScript retains an in-process guard
  because Win32 mutex acquisition is recursive on one thread.
- `acquireCompanionInstanceMutex()` accepts no arguments. It derives one fixed
  per-user `Local\` kernel-object name from the current SID, applies and
  revalidates the protected owner-only DACL, and performs a non-blocking wait.
  A live contender receives a fixed contention error. An abandoned owner is
  transferred to the caller and surfaced only as `abandoned: true`; no stale
  PID, path, label, or other content is returned. The native registry rejects
  recursive same-process acquisition even though Win32 mutexes are recursive
  on one thread. `releaseCompanionInstanceMutex(lease)` verifies the opaque
  token, same-thread ownership, and active state before releasing exactly once.
  The binding remains development-only until the native Windows qualification
  proves child-process contention, crash recovery, and clean reacquisition.

## Prepared-artifact contract

The `windows-prepared-artifact-v1` methods are a separate, still-unqualified
surface for staged contribution and review artifacts. Every call repeats the
absolute state-root path and its expected single-link root identity. Native
code opens the root and each descendant with `NtCreateFile` relative to held
handles; it rejects absolute/UNC/traversal/reserved names, reparse points,
regular-file hard links, owner/DACL drift, and final-path changes. Directory
enumeration is capped at 256 entries and returns only validated names, types,
and identities. Directory removal requires the expected identity and an empty
directory. Directory renames and staged-file publication require same-parent
relative names and use `FileRenameInformationEx` without
`FILE_RENAME_REPLACE_IF_EXISTS`, so an existing destination is never clobbered.

Prepared files are created exclusively with an owner-only DACL, read back only
through a validated handle, and may be explicitly removed with an expected
identity through `deletePreparedFile`; no future caller is permitted to fall
back to path-based JavaScript unlink. Native reads and writes use fixed 1 MiB
chunks. The total binding ceiling is 34 MiB, which covers the current
1,310,720-byte contribution payload and the review-bundle ceiling without an
unbounded native allocation. File contents are flushed with
`FlushFileBuffers` before create or publication completes. Windows has no
portable directory-entry fsync equivalent: the binding attempts
`FlushFileBuffers` on the held parent directory and treats the documented
unsupported-directory results (`ERROR_INVALID_HANDLE` or
`ERROR_ACCESS_DENIED`) as the explicit metadata-durability boundary.
Callers must retain and recover a staged directory if a process exits after a
file deletion/rename but before the parent-directory metadata boundary can be
observed.

The native and adapter `preparedArtifactSafe` claims remain `false` until the
Windows x64 qualification proves child-process cleanup, crash/reopen behavior,
ancestor and destination races, size limits, ACL/hard-link rejection, and the
supported filesystem matrix. The contract is therefore usable for adapter and
qualification tests now, but it is not a production storage selector.

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

`acquireSqliteStateLease(rootPath, expectedRootIdentity, databaseName)` is a
purpose-limited protected SQLite boundary. It accepts one basename, derives
the rollback journal, and returns validated database/journal identities plus
an opaque lease. A freshly created database or journal is first flushed and
validated through its cleanup-capable handle, then reopened relative to the
already-held protected root with SQLite-compatible sharing; the reopened
security, canonical path, and exact file identity must still match before the
lease is exposed. A failed first-time acquisition can therefore leave only a
validated, owner-only empty bootstrap file for a later retry; the binding does
not delete by pathname after relinquishing the identity-bound creation handle.
After the identity mutex is acquired, the native boundary
creates owner-only delete-on-close placeholders for the derived `-wal` and
`-shm` names and holds exclusive handles to them for the complete lease
lifetime. A SQLite writer therefore receives a sharing violation instead of
creating either sidecar; the placeholders disappear when the last native
handle closes, including after an abrupt process termination. The lease holds
the root/ancestor, database, journal, and sidecar-reservation handles with
read/write sharing but without delete sharing, and coordinates duplicate
acquisition with a current-user owner-only named mutex derived from the
validated root/database identities. An abandoned mutex is retained by the
new owner so SQLite can perform bounded hot-journal recovery before the
session is exposed. `releaseSqliteStateLease` releases that mutex and every
handle exactly once. The binding still advertises `sqliteStateLeaseSafe:
false`: native Windows qualification must prove the reservation,
identity-binding, recovery, and supported filesystem matrix before any
production selector can rely on it.
