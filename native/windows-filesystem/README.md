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
  `RootDirectory`. The expected destination handle is held with write/delete
  sharing disabled from identity validation through the rename, and every
  renameable ancestor from the state root through that parent is held without
  delete sharing for the same transaction. The binding
  uses the Windows 10 1709+ `FileRenameInformationEx` class with
  `FILE_RENAME_REPLACE_IF_EXISTS | FILE_RENAME_POSIX_SEMANTICS`, which permits
  replacement while that identity-bound handle remains open; a same-user
  rename/delete of the held destination or ancestors therefore fails the
  sharing check instead of racing the identity check. Existing hard-link
  aliases are rejected by the link-count validation, and the replacement is
  created and revalidated as a single-link object. This is an OS sharing and
  identity boundary, not a claim that a pre-existing privileged handle or
  every filesystem-specific hard-link operation is impossible; the native
  production flags remain false until the supported Windows/filesystem matrix
  proves that race explicitly. Unsupported OS/filesystem combinations fail
  closed. It reopens the destination and verifies the replacement handle
  identity, canonical final path, and bytes before returning. Expected paths are
  normalized through `GetLongPathNameW`, so a valid 8.3 short-name spelling can
  be compared with the normalized handle path. The binding still advertises
  `productionSafe: false` until native Windows qualification proves the exact
  OS/filesystem matrix and the remaining replacement and binding-integrity
  gates.
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
an opaque lease. After the identity mutex is acquired, the native boundary
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
