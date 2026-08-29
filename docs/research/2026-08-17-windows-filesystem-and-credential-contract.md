---
title: Windows filesystem and credential security contract
date: 2026-08-17
type: research
status: active
---

# Windows filesystem and credential security contract

## Decision boundary

This document defines what Windows production storage must prove before the
current macOS-only identity fail-closed guard may change. The four-day
readiness milestone adds path tests and a disposable Credential Manager probe;
it does not implement or approve production Windows identity storage.

The first native adapter slice now exists for Windows x64 qualification, but it
advertises `productionSafe: false`. It proves handle-based identity, strict
owner-DACL construction, protected-DACL inspection, reparse-point refusal,
single-link refusal, flush/reopen validation, and exact-handle deletion. The
participant identity integration deliberately refuses that adapter on a real
Windows host. The current slice walks components with `NtCreateFile` relative
to held parent directory handles and includes a same-directory replacement
primitive, but the final destination check and replacement are not one atomic
compare-and-swap operation. Native compilation, adversarial coverage, and that
last replacement race remain open. This is an intentional fail-closed state,
not a production Windows support claim.

The native build now emits a content-free sidecar manifest containing the exact
binary byte count, SHA-256, fixed contract/method set, native capability claims,
and an explicit `approvedPolicy` that remains false. The loader verifies the
manifest and binary digest before loading the binding and cross-checks the
native claims; self-reported booleans alone cannot enable production. This is
an integrity/mismatch anchor, not a cryptographic provenance signature. A
future signed installer or separately authenticated manifest/allowlist remains
required before any Windows production promotion.

## Filesystem contract

POSIX owner/mode checks do not have a safe one-line Windows substitute. A
Windows implementation must satisfy all of the following on native Windows:

1. Open the state root and sensitive file by handle. Inspect security through
   the handle, not only a path string. `GetSecurityInfo` can retrieve owner and
   DACL data but Microsoft explicitly notes that it does not itself handle race
   conditions; callers must design around that limitation.
2. Reject a NULL DACL and reject an owner other than the expected current-user
   SID. Evaluate effective access for broad principals such as Everyone,
   Authenticated Users, Users, and unrelated local users. Inherited default
   permissions are evidence to inspect, not proof of owner-only storage.
3. Walk every existing component from the trusted root to the sensitive file
   and reject reparse points. Use `FILE_FLAG_OPEN_REPARSE_POINT` where the
   implementation needs a handle to the link itself; without that flag,
   `CreateFile` follows a symbolic-link target.
4. Record handle identity using volume serial number plus file identifier, and
   compare before/after critical operations. Resolve and inspect the final path
   from the open handle rather than trusting a pre-open normalized string.
5. Reject a sensitive file whose native link count is not exactly one on a
   filesystem that reports link counts. On NTFS a value above one indicates a
   hard-linked file; on ReFS use the 128-bit `FILE_ID_INFO` identity because the
   older 64-bit value is not guaranteed unique.
6. Create new files with an explicit protected DACL, exclusive creation, and
   non-inheriting owner-only access. Flush, close, reopen, and revalidate the
   handle identity and security descriptor before considering the write
   committed.
7. Test case-insensitive collisions, reserved device names, trailing dots and
   spaces, long paths, drive roots, UNC/network locations, junctions, symlinks,
   mount points, hard links, concurrent replacement, sharing violations,
   interrupted writes, and delete/rename behavior.
8. Fail closed with fixed, content-free error classifications. Never include a
   user path, SID, credential, prompt, response, or raw account identifier in a
   diagnostic receipt.

Primary Microsoft references:

- [GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo)
- [File security and access rights](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights)
- [Security descriptor operations](https://learn.microsoft.com/en-us/windows/win32/secauthz/security-descriptor-operations)
- [CreateFileW symbolic-link behavior](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
- [Reparse points and file operations](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points-and-file-operations)
- [BY_HANDLE_FILE_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/ns-fileapi-by_handle_file_information)
- [GetFinalPathNameByHandleW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew)

## Credential Manager probe contract

The fixed-capability production adapter now exists as a dormant qualification
primitive. All four product selectors remain unavailable on Windows because
their surrounding lock, metadata, and lifecycle files have not yet passed the
Windows filesystem contract. Native qualification may use disposable hosted
runner entries; this does not enable production behavior.

The mutation lease introduced for portable qualification is deliberately
in-process, synchronous, and non-durable. It rejects forged lease objects and
coordinates backend instances within one Node process, but it is not a
production concurrency primitive. A named Win32 mutex or equivalent must span
the full read/expected-check/write/readback transaction before any selector is
enabled.

The milestone probe is intentionally narrower than a production backend:

- It runs only on native Windows x64.
- It selects the reviewed `@github/keytar` Windows x64 binding by exact path and
  verifies SHA-256 `b82625e7c713fd20b5cb57993e073076c87660652202893fad39d874d77169fc`
  before loading it.
- It generates a random service, account, and value, writes a generic
  credential, reads it back, deletes it, and confirms it is absent.
- It emits only platform, architecture, binding hash, pass/fail class, and
  cleanup confirmation. Secret values and identifiers are never logged.
- Cleanup failure is a failed test, even if write/read succeeded.
- It does not use any production service/account identifier and does not alter
  the macOS keychain-backed capability split.

Microsoft defines generic credentials as application-defined and provides the
CredRead/CredWrite/CredDelete APIs through WinCred. A production TiboTattle
backend must preserve four separate capabilities, fixed service/account names,
create-if-missing/readback/replace/delete semantics, concurrency behavior, and
bounded failures. It must also define upgrade and uninstall retention before
release qualification.

Primary Microsoft references:

- [Windows Credentials Management API](https://learn.microsoft.com/en-us/windows/win32/api/wincred/)
- [CREDENTIALW structure](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw)
- [Handling passwords](https://learn.microsoft.com/en-us/windows/win32/secbp/handling-passwords)

## Deferred acceptance tests

The following remain mandatory in issue #3 and are not waived by a passing
portable lane: adversarial DACL fixtures, malicious junction/symlink/mount
point traversal, hard-link replacement, concurrent handle substitution,
SQLite locking and recovery, long-path installation, the four production
Credential Manager capabilities, installed shell lifecycle, signed installer,
upgrade, rollback/failure, and uninstall behavior.
