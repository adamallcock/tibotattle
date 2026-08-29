---
title: Windows credential coordination qualification receipt
date: 2026-08-17
type: receipt
status: complete
---

# Windows credential coordination qualification receipt

## Claim boundary

The qualification-only Windows credential backend now passes its documented
native Windows x64 coordination and durability contract. Separate processes
cannot concurrently mutate the same fixed credential capability within one
interactive logon session, and an abrupt process exit leaves a durable,
content-free prepared record that the next holder recovers conservatively.

This is not Windows product support and is not a production promotion. All
Windows production selectors remain disabled. The audit database path still
needs native ACL and reparse-point race protection, `Local\` mutexes do not
coordinate different logon sessions, binary provenance is not authenticated,
and packaging, signing, installation, update, rollback, and uninstall work is
deferred.

## Qualified revision and run

- Source revision: `2d171410c333bd9c0c001a1f2a879995d3e6623f`.
- Task branch: `codex/windows-security-credentials`.
- Manual workflow:
  [GitHub Actions run 32066242226](https://github.com/adamallcock/tibotattle/actions/runs/32066242226).
- Clean-store job: `95498936452`, passed in 3m10s.
- Restored/primed-store job: `95498936576`, passed in 3m17s; the pnpm cache
  was restored successfully and the second dependency install ran offline.
- Both jobs checked out the exact revision with persisted credentials disabled,
  compiled the repository-owned native add-on, passed the portable Windows
  lane, passed the fixed native security qualification, cleaned disposable
  credentials/state, and finished with no tracked or untracked checkout
  changes.

No pull request, merge, release, installer, or production selector change was
performed.

## Native qualification result

Each matrix job ran the same exact 14-file qualification set:

- 79 tests passed.
- 0 tests failed.
- 0 tests were skipped, cancelled, or marked todo.
- Four fixed Credential Manager capabilities completed create/read/replace/
  delete, conflict, readback, and cleanup exercises using disposable entries.
- Same-capability processes contended; a different capability proceeded
  independently; release allowed reacquisition.
- Node worker threads exercised the process-global native lease registry.
- A child process exited abruptly while holding the native mutex and a durable
  prepared audit row; the next normally acquired holder recovered that row as
  `unknown_after_crash` before settling its own operation.
- The binding loader verified the adjacent manifest byte count, SHA-256,
  method set, mutex contract, and still-disabled production policy.

The qualification harness captured test output and emitted only fixed status
classes and aggregate counts. Successful completion requires zero skips.

## Environment and binding identity

- Microsoft Windows Server 2025 x64, runner `2.336.0`.
- Runner image `windows-2025-vs2026`, version `20260810.198.2`.
- Node `v26.2.0`; Corepack `0.34.0`; pnpm `11.9.0`.
- Native binding size in both jobs: 329,728 bytes.
- Clean-store binding SHA-256:
  `025c8f9fac7866de542ba609739c48ac92c5dd0ee7889221f8f9956d6f2cde49`.
- Restored-store binding SHA-256:
  `312b816b062d14e17593337a251918845862c54dc1267cd1503fc71654f25f2f`.

The two source-identical builds have different hashes. Each job verified its
own built binary against its own generated manifest, so the qualification is
valid, but this is not a reproducible-build or authenticated-provenance claim.
A production package must sign or otherwise authenticate the binding and its
approved manifest.

## Mac-side validation

- Focused credential, mutex, audit, loader, manifest, and workflow-governance
  tests passed on macOS; only explicitly native-Windows cases skipped.
- The complete portable lane passed after the final worker-thread and ledger
  changes.
- `git diff --check`, documentation-link validation, JavaScript syntax checks,
  and `actionlint` passed.
- The broader root suite had already been run for this greater-than-20-file
  change: its only durable failures were the expected source-bound generated
  release-receipt mismatch; one unrelated legacy-migration concurrency test
  was intermittent and passed when rerun alone.

## Remaining production gates

- Keep all four Windows production capability selectors disabled.
- Give the SQLite audit location the same native owner-DACL, reparse-point,
  handle-identity, and race protections required for other private state.
- Decide and qualify the supported logon-session scope before considering a
  namespace wider than `Local\`.
- Add a startup maintenance sweep if eager recovery is required; recovery is
  currently safe and lazy per capability.
- Qualify schema migration before changing the initial audit schema after
  deployment.
- Complete authenticated binding provenance, remaining filesystem/state
  integrations, export locking, packaging, signing, installer/updater,
  upgrade/rollback, and uninstall policy.

The GitHub annotation about `actions/cache` being forced from its deprecated
Node 20 runtime to Node 24 did not fail either job, but the pinned action should
be updated in a later workflow-maintenance change.
