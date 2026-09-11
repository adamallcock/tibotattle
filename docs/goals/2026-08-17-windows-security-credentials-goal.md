---
title: Windows security and production credentials milestone
date: 2026-08-17
type: goal
status: active
---

# Windows security and production credentials milestone

## Outcome

Replace TiboTattle's deliberate Windows security deferrals with a small,
reviewable Windows security kernel that can safely protect the private state
root and the four production credential capabilities. Preserve the qualified
portable core and all existing macOS behavior.

Completion of this milestone means the engine has a credible Windows storage
foundation. It does not mean TiboTattle is a Windows product: the desktop
shell, installer, signing, updater, installed-app lifecycle, and release gates
remain separate work.

## Workstreams

### 1. Native filesystem security primitive

- Add a platform-owned Windows native adapter rather than parsing localized
  `icacls` or PowerShell output.
- Open and inspect sensitive paths by handle.
- Validate the current-user owner SID and a protected owner-only DACL; reject
  NULL DACLs and access granted to broad or unrelated principals.
- Reject reparse points in every existing path component.
- Identify an open file with volume serial number plus native file ID, using
  the 128-bit identity form where available.
- Read the native link count and reject sensitive final files with more than
  one link.
- Resolve the final path from the approved handle.
- Support secure exclusive creation with an explicit, non-inheriting DACL,
  followed by flush, close, reopen, and security/identity revalidation.
- Return fixed, content-free error classes. Do not expose paths, SIDs, account
  names, or data in logs and receipts.

### 2. First filesystem integration slice

- Protect the private state root.
- Protect participant identity secret files, migration/retirement control
  files, and the rotation lock.
- Preserve explicit development-only file/environment overrides.
- Keep unsupported or unverified Windows paths fail-closed.
- Do not globally reject reparse points in export storage until its intentional
  symlink lock has a Windows regular-file lock or native-mutex equivalent.

### 3. Production Credential Manager backend

- Add a production adapter that implements `read`, `createIfMissing`,
  `replaceExact`, and `deleteExact`.
- Use fixed, separately scoped service/account identifiers for export identity,
  account observation, Claude callback, and contribution device capabilities.
- Reuse the audited, hash-pinned Windows x64 keytar binding loader, but do not
  call the disposable probe from production.
- Verify create and replacement operations by readback.
- Preserve caller-held operation leases and deterministic conflict behavior.
- Use fixed, content-free errors and never log secret values or identifiers.
- Define and test upgrade retention. Uninstall deletion remains a release
  policy decision and must not happen implicitly in this milestone.

### 4. Production selector and packaging integration

- Enable each of the four Windows production capability selectors only after
  its backend contract and every associated state/lease path pass the Windows
  filesystem contract. The current checkpoint deliberately keeps all four
  production selectors unavailable on Windows.
- Preserve macOS Keychain behavior and compatibility exports exactly.
- Extend artifact/package validation for the reviewed Windows native binding.
- Keep unsupported architectures fail-closed.

### 5. Qualification

- Run focused portable loader and credential-contract tests on macOS.
- Run the complete portable lane and relevant macOS product regressions.
- Run native Windows x64 tests for DACLs, owner SID, reparse points, hard
  links, handle replacement, sharing violations, long/case-insensitive paths,
  and all four credential lifecycles.
- Exercise both normal and clean dependency caches on the same revision.
- Confirm tracked files remain clean after every qualification job.
- Record exact revision, runner/runtime versions, commands, pass/fail/skip
  counts, binding hashes, and every remaining deferral in a dated receipt.

## Acceptance criteria

- [ ] Windows filesystem decisions are based on approved handles, not only path
  strings or POSIX-style metadata.
- [ ] Owner-only DACL creation and validation pass adversarial native fixtures.
- [ ] Junctions, symlinks, mount points, hard links, and concurrent replacement
  are rejected at the private-state and participant-identity boundary.
- [ ] Sensitive file identity remains stable through write, flush, reopen, and
  post-write validation.
- [x] The four production credentials pass create/read/replace/delete,
  conflict, concurrency, restart, and upgrade-retention tests.
- [ ] No macOS capability or existing portable behavior regresses.
- [x] Native Windows x64 qualification passes twice, including a clean-cache
  run, with no unexplained skip or failure.
- [x] The receipt contains no secret, path, SID, account, or user-data content.

## Current checkpoint

- The fixed-capability Credential Manager adapter and its portable contract
  tests exist, but production Windows selectors remain fail-closed.
- The first native filesystem adapter and participant-identity injection seam
  exist. Component traversal is rooted on held directory handles and a
  same-directory replacement primitive exists, but the final identity check
  and replacement are not yet an atomic compare-and-swap. The native binding
  therefore advertises `productionSafe: false` and `pathWalkRaceSafe: false`.
- Credential mutations require opaque, capability-bound leases. The current
  native-Windows lease combines an in-process recursion guard with one
  current-user, owner-only `Local\` Win32 named mutex per fixed capability.
  It prepares and settles a bounded SQLite journal around the complete
  read/compare/write-or-delete/readback transaction and reports
  `crossProcessSafe: true`, `auditDurable: true`, and
  `productionSafe: false`. Injected portable bindings remain explicitly
  qualification-only and do not acquire these claims.
- An abandoned mutex is released and rejected before mutation. The lease then
  reacquires normally and recovers only that capability's durable prepared
  rows as `unknown_after_crash`; it never retries, overwrites, or deletes a
  credential automatically. A child-process fixture also leaves a real
  prepared SQLite row through abrupt termination for the next holder to
  recover.
- The audit schema stores only fixed owner/capability/operation/result/failure
  vocabularies and a random lease ID. It retains 256 terminal rows, never
  prunes prepared rows, allows at most 16 unresolved rows, rejects mismatched
  owner/capability pairs, and exposes an owned close boundary.
- Native Windows now holds opaque no-delete handles for the fixed audit
  database, its persistent rollback journal, and the two owned ancestor
  directories for the lifetime of SQLite. This blocks path replacement while
  the store is active and is a separate narrow contract from the still-false
  general `pathWalkRaceSafe` claim. The supported guard boundary begins at the
  application state root; its OS-managed parent remains a trust anchor and is
  not claimed as guarded by this milestone.
- Manager construction performs a startup sweep across all four capability
  mutexes before reporting recovery complete. Prepared rows are recovered only
  while their matching named mutex is held; contention leaves readiness false.
- One shared readiness gate now fronts export identity, account observation,
  Claude callback, and contribution-device composition roots. It requires the
  mutex, durable audit, guarded audit filesystem, completed startup recovery,
  protected consumer state paths, and authenticated binding provenance. All
  four selectors remain deliberately disabled.
- The native build emits a fixed sidecar manifest and the loader verifies the
  binary byte count, SHA-256, contract, and native claims before loading it.
  The manifest's approved production policy remains false; signing or another
  authenticated release allowlist is still required before promotion.
- Native qualification may exercise these dormant primitives on a disposable
  hosted runner. It may not promote them into product behavior until the open
  race, integrity, state/lease, and atomic-replacement gates are complete.
- The mutex/audit extension passed on exact revision
  `2d171410c333bd9c0c001a1f2a879995d3e6623f` in both the restored/offline and
  explicitly empty dependency-store lanes. Native compilation, per-build
  manifest verification, the portable lane, all 79 fixed native qualification
  tests with zero skips, disposable cleanup, and the clean-checkout gate passed
  in [run 32066242226](https://github.com/adamallcock/tibotattle/actions/runs/32066242226).
  The [dated credential-coordination receipt](../receipts/2026-08-17-windows-credential-coordination-receipt.md)
  records the runner, toolchain, both binding digests, and remaining production
  gates.
- The audit-guard, startup-recovery, mutex-lifecycle, four-consumer readiness,
  and schema/retention extension passed on exact revision
  `b8811349b5b38df0319684ebc0b4377f9d404c94` in both the restored/offline and
  explicitly empty dependency-store lanes. Each job passed all 95 native
  qualification tests with zero skips in
  [run 32085366833](https://github.com/adamallcock/tibotattle/actions/runs/32085366833).
  The [dated audit-guard receipt](../receipts/2026-08-17-windows-credential-audit-guard-receipt.md)
  records the exact claim boundary and remaining production gates.

## Deferred follow-on work

- Replace the export destination symlink lock on Windows and integrate the
  security adapter into export artifact storage.
- Extend the adapter to queue, prepared-contribution, SQLite workspace,
  metadata bundle, collector, deletion/discard, and source-reader stores.
- Authenticate the binding manifest through the signed installer or another
  separately trusted release digest before creating a readiness attestation.
- Decide whether the supported desktop contract remains one interactive logon
  session (`Local\`) or requires separately qualified cross-session
  coordination. Do not change to `Global\` without that decision and ACL tests.
- Build and qualify the Windows desktop shell, installer, signing, updater,
  upgrade/rollback, and uninstall policy.
- Build and qualify the Linux shell and distribution formats.

## Stop conditions

Stop rather than weaken a check if the native binding cannot prove handle
identity, owner/DACL state, or reparse-point absence; if Credential Manager
cleanup or readback is ambiguous; if a test would require real user data; or
if qualification would require publishing, merging, or releasing without
separate authorization.

## Permitted completion claim

“TiboTattle's private state and four production credential capabilities pass
the documented native Windows x64 security contract.”

The prohibited claim remains: “TiboTattle supports Windows.”
