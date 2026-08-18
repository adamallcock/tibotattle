---
title: Windows readiness milestone receipt
date: 2026-08-17
type: receipt
status: complete-portable-core-windows-qualified
---

# Windows readiness milestone receipt

## Claim boundary

TiboTattle's selected portable core passed macOS, network-isolated Linux, and
native Windows x64 qualification. A disposable Credential Manager probe also
passed. This is not evidence that TiboTattle supports Windows and is not a
Windows release candidate. The production client remains macOS-only.

Still deferred to issue #3 are the Windows desktop shell, four production
Credential Manager capabilities, owner-DACL and reparse-point enforcement,
adversarial file identity, provider-source acceptance, installer choice,
signing, installed-app QA, upgrade/rollback, and uninstall behavior.

## Revision and authority

- Qualified source/evidence revision: `64989c5fffdfc22c5d33238a5c346f8288164d8b`.
- Task branch: `codex/windows-readiness`.
- Base revision: `f118947`.
- Work was performed in an isolated external worktree. The maintainer checkout
  and its pre-existing dirty state were not staged, reverted, or incorporated.
- The maintainer explicitly authorized task-branch pushes and a temporary
  branch-only workflow trigger. No pull request, merge, issue post, release, or
  artifact publication was authorized or performed.
- The later receipt/workflow-restoration commit changes documentation and the
  trigger surface only; qualification remains bound to `64989c5`.

## Implemented controls

- Explicit portable manifest grouped by shared contracts,
  accounting/analysis, providers/privacy, storage/companion, and web.
- Exact Windows branch ledger plus a drift-failing test.
- Pinned Debian Bookworm container with network disabled during tests.
- Native Windows x64 workflow with pinned action revisions, read-only
  repository permission, locked dependencies, environment evidence, and a
  tracked-file cleanliness gate.
- Windows paths covering spaces, Unicode, drive roots, default/custom homes,
  cleanup, and a synthetic real child-process companion.
- Hash-pinned disposable Windows Credential Manager round-trip probe.
- Portable filesystem repairs for Windows directory fsync, writable-handle
  flushes, CRLF normalization, native separators, and large Windows file IDs.
- Exactly one whole-file Windows deferral: `test/export-identity.test.js`, whose
  production file-identity guarantees require the deferred ACL, reparse-point,
  and hard-link contract.

## Final validation ledger

| Lane | Revision/environment | Result |
|---|---|---|
| Portable macOS | macOS 26.5.2 arm64; Node 26.2.0; pnpm 11.9.0 | 932 tests: 930 passed, 0 failed, 2 native-Windows skips |
| Portable Linux | pinned Debian Bookworm arm64 container; `--network none` | 932 successful test results; same 2 native-Windows skips |
| Root Node suite | macOS arm64; regenerated R7 evidence installed | 2,219 tests: 2,213 passed, 0 failed, 6 explicit skips |
| macOS source lane | macOS arm64 | 45 tests: 42 passed, 0 failed, 3 artifact-only exclusions |
| macOS launcher smoke | development-only compiler profile | 1 passed, 0 failed |
| R7 source-bound evidence | exact Node 24.14.0 and 26.2.0 arm64 | 10 receipts regenerated; both runtimes revalidated 2/2 |
| Workflow/docs/governance | actionlint 1.7.12; link and inventory checks | Passed; 0 failures |
| Secret scan | gitleaks 8.30.1; candidate versus clean baseline | Exact 20-finding path/rule parity; 0 branch-introduced findings |
| Native Windows normal cache | job `95387488689` | 910 tests: 904 passed, 0 failed, 6 explained skips; tracked diff clean |
| Native Windows clean cache | job `95387488776` | 910 tests: 904 passed, 0 failed, 6 explained skips; tracked diff clean |

The two final Windows jobs ran in
[GitHub Actions run 32029951441](https://github.com/adamallcock/tibotattle/actions/runs/32029951441)
against the same commit. Normal-cache completed in 3m26s; clean-cache completed
in 2m46s.

## Native Windows environment and probes

- Operating system: Microsoft Windows Server 2025 x64.
- Runner image: `windows-2025-vs2026`, version `20260810.198.2`.
- Runner version: `2.336.0`.
- Node: `v26.2.0`; Corepack: `0.34.0`; pnpm: `11.9.0`.
- Audited native-binary digest (SHA-256):
  `b82625e7c713fd20b5cb57993e073076c87660652202893fad39d874d77169fc`.
- In both jobs, the binding integrity check, random write/read round trip,
  deletion, and post-delete absence check passed.
- In both jobs, native roots with spaces and Unicode, custom `CODEX_HOME`, and
  cleanup passed.

The six Windows skips are explicit and explained:

1. Development file identity awaits owner-DACL enforcement.
2. `O_NOFOLLOW` symlink refusal awaits native reparse-point enforcement.
3. Active rollout replacement refusal awaits Windows handle identity.
4. Queue owner/symlink refusal awaits ACL and reparse-point enforcement.
5. Killed-writer hot-journal recovery needs a native Windows abrupt-process
   fixture.
6. Prospective CLI POSIX mode/symlink policy awaits its Windows equivalent.

## Diagnostic evidence

The temporary trigger was used as a bounded native feedback loop before final
qualification. The important reductions were:

- [Run 32019489388](https://github.com/adamallcock/tibotattle/actions/runs/32019489388):
  137 failures exposed CRLF and filesystem assumptions.
- [Run 32019748108](https://github.com/adamallcock/tibotattle/actions/runs/32019748108):
  81 failures after line-ending and collector-flush repairs.
- [Run 32020295754](https://github.com/adamallcock/tibotattle/actions/runs/32020295754):
  16 failures after shared fsync/path and bounded deferral work.
- [Run 32020775946](https://github.com/adamallcock/tibotattle/actions/runs/32020775946):
  4 failures, isolating participant-secret modes and SQLite teardown.
- [Run 32021109703](https://github.com/adamallcock/tibotattle/actions/runs/32021109703):
  2 failures, exposing Windows SQLite/file-ID behavior.
- [Run 32021609548](https://github.com/adamallcock/tibotattle/actions/runs/32021609548):
  first green single-mode diagnostic, 910/904/0/6.

No failing diagnostic run is presented as qualification evidence.

## Source-bound and container evidence

The retained R7 evidence contains 10 validated receipts covering 307 source
files with source SHA-256
`ff5c72d2748537d24b12f721f87b8a65f50e8cd4100224aaad0d4b25dbcd4cf5`.
Node 24.14.0 and Node 26.2.0 independently revalidated the full set and exactly
rebuilt their decision receipts.

The Linux base manifest digest is
`sha256:e89172f5e6154ba212269866bf3fbadbca8eb7901e10c0eccf08f2147bfae505`.
The final locally built arm64 image is
`sha256:68dd7062098166f1055c60e3994ca1e78041d9d6860570ac9846eedd8611edf7`.
This is local rebuild evidence, not a published artifact.

## Local environment

UTM 4.7.5 is installed and signed at `/Applications/UTM.app`; `utmctl` is at
`/opt/homebrew/bin/utmctl`. No Windows guest or installation media was
downloaded. About 30 GiB remained free, and Windows media or activation was not
within the installation authorization.

## Handoff

- The issue #3 comment is complete in
  [`docs/plans/2026-08-17-windows-issue-3-update.md`](../plans/2026-08-17-windows-issue-3-update.md)
  and remains unposted.
- The workflow is restored to manual-only after the final matrix.
- Integration, a pull request, issue posting, and any Windows product work
  require separate maintainer decisions.
