---
title: Windows credential audit guard qualification receipt
date: 2026-08-17
type: receipt
status: complete
---

# Windows credential audit guard qualification receipt

## Claim boundary

The qualification-only Windows credential backend now protects its durable
SQLite mutation audit with repository-owned native Windows handles. The fixed
database, persistent rollback journal, private audit directory, and application
state root are held without delete sharing while SQLite is active. Credential
mutations are serialized per fixed capability across processes within one
interactive logon session, and startup recovery sweeps every capability while
its matching mutex is held.

This is not Windows product support or a production promotion. The four
Windows production selectors remain disabled. The general filesystem adapter
still reports `productionSafe: false` and `pathWalkRaceSafe: false`; the
OS-managed parent of the application state root remains a trust anchor;
binding provenance is not authenticated; and several consumer state paths,
export locking, packaging, signing, installation, update, rollback, and
uninstall work remain deferred.

## Qualified revision and run

- Source revision: `b8811349b5b38df0319684ebc0b4377f9d404c94`.
- Task branch: `codex/windows-security-credentials`.
- Manual workflow:
  [GitHub Actions run 32085366833](https://github.com/adamallcock/tibotattle/actions/runs/32085366833).
- Restored/primed-store job:
  [95556686783](https://github.com/adamallcock/tibotattle/actions/runs/32085366833/job/95556686783),
  passed in 3m41s. The cache restored successfully and the second dependency
  installation ran offline.
- Clean-store job:
  [95556687033](https://github.com/adamallcock/tibotattle/actions/runs/32085366833/job/95556687033),
  passed in 4m18s without restoring the pnpm store cache.
- Both jobs checked out the exact revision with persisted credentials
  disabled, built the repository-owned native add-on, generated and verified
  its adjacent manifest, passed the portable Windows lane, passed the exact
  native security qualification, cleaned disposable credentials and state,
  and finished with no tracked, staged, or untracked checkout changes.

No pull request, merge, release, installer, or production selector promotion
was performed.

## Native qualification result

Each matrix job ran the same exact 16-file qualification set:

- 95 tests passed.
- 0 tests failed.
- 0 tests were skipped, cancelled, or marked todo.
- The fixed audit database and journal remained usable by SQLite while native
  guards blocked rename or deletion of both files and their owned directories.
- Hard-linked and reparse-point audit files were rejected.
- Same-capability processes contended; different capabilities proceeded
  independently; ordinary release and worker termination allowed
  reacquisition; abrupt child-process exit recovered conservatively.
- A durable prepared row left by abrupt termination was recovered as
  `unknown_after_crash` before a later mutation proceeded.
- Manager startup swept all four fixed capabilities under their matching
  native mutexes and kept readiness false if recovery could not complete.
- The four fixed Credential Manager entries completed disposable create,
  read, replace, delete, conflict, readback, restart, and cleanup exercises.
- Audit retention, exact schema behavior, refusal of future schema markers,
  and restart reopening were exercised without migrating or rewriting an
  unsupported database.
- The loader verified the manifest byte count, SHA-256, native method set,
  mutex contract, audit-guard contract, and still-disabled production policy.
- The shared readiness gate remained closed for export identity, account
  observation, Claude callback, and contribution-device selection because
  complete consumer-state and authenticated-provenance facts are not yet
  qualified.

The qualification harness captured detailed test output and emitted only
fixed status classes and aggregate metadata. Successful completion requires
zero test skips.

## Environment and binding identity

- Microsoft Windows Server 2025 x64, runner `2.336.0`.
- Runner image `windows-2025-vs2026`, version `20260810.198.2`.
- Node `v26.2.0`; Corepack `0.34.0`; pnpm `11.9.0`.
- Native binding size in both jobs: 334,336 bytes.
- Restored-store binding SHA-256:
  `903749f55cd9dc8174ab72c58178acae8aa783ab013d5b04634d2a769707dfde`.
- Clean-store binding SHA-256:
  `44c190df4afce1153ed26f2890d6596858fc0dec1a5cbd26dcd01ce2c5d18df3`.

The two source-identical builds have different hashes. Each job verified its
own binary against its own generated manifest, so this qualification is valid,
but it is not a reproducible-build or authenticated-provenance claim. A
production package must sign or otherwise authenticate the binding and its
approved manifest.

## Mac-side validation

- The final portable lane passed 1,023 tests: 1,006 passed, 17 native-Windows
  cases skipped as declared, and 0 failed.
- The exact 16-file native set registered 95 tests on macOS: 78 portable
  contracts passed and the same 17 native-Windows cases skipped.
- Focused architecture, exporter allowlist, public platform API, and readiness
  integration tests passed after narrowing the public surface.
- `git diff --check`, documentation-link validation, and `actionlint` passed.
- The broader root suite found three integration regressions, which were fixed
  before the final portable run. Its remaining failures were two intentionally
  stale generated R7 release-evidence checks and two resource benchmarks that
  passed 10/10 when rerun alone. Historical release evidence was not
  regenerated for this unpublished checkpoint.

## Remaining production gates

- Keep all four Windows production capability selectors disabled.
- Authenticate the native binding and approved manifest through the signed
  installer or a separately trusted release digest.
- Finish native protection for the account-observation lock, contribution
  queue/preparation state, export storage and locking, remaining SQLite and
  collector stores, and deletion/discard paths.
- Complete atomic compare-and-swap replacement and the remaining general
  DACL/path/concurrency matrix before changing `pathWalkRaceSafe` or
  `productionSafe`.
- Decide whether the supported desktop contract remains one interactive logon
  session (`Local\\`) or requires separately qualified cross-session
  coordination.
- Qualify packaging, signing, installer/updater, upgrade/rollback, retention,
  and uninstall policy.

The GitHub annotation about `actions/cache` being forced from its deprecated
Node 20 runtime to Node 24 did not fail either job. The SHA-pinned action should
be upgraded in a separate workflow-maintenance change.
