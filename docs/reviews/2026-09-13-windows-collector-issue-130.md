---
title: Windows collector issue 130 diagnosis
date: 2026-09-13
type: review
status: implemented-locally
---

The reported large file identity and a collector lock cleanup defect form a
credible, independently reproduced explanation for issue 130. This is source
and synthetic runtime evidence, not qualification of an installed Windows binary.
The collector repair is committed locally as `6c8e68c0`; coordinated integration
and validation evidence are recorded below.

## Evidence boundary

- [Issue and diagnostic comment](https://github.com/adamallcock/tibotattle/issues/130#issuecomment-5653915907): the issue form reports v0.1.22, a fresh Windows 10 22H2 x64 installation, and a collector lock error. The comment reports an unsafe numeric file identity and an unavailable error shortly after lock acquisition. These are reporter-supplied observations; the original diagnostic capture and installed artifact were not independently inspected.
- Local checkout: `9385bad260698814cc2a4a6c685575a3fd63811a`.
- Release tag v0.1.22 resolves locally to `49db9eac36ee0f385e5ede6deee90c030decf84e`.
- GitHub main observed through the API: `9abc3d619c4cb19d295df5880c7a39a01fba48df`.
- The four reviewed files are byte-identical between local HEAD and remote main; a local Git comparison also finds no changes from v0.1.22: `src/local-collector-state.js`, `src/passive-collector.js`, `src/local-collector-state-integrity-off-main.js`, and `src/local-collector-state-integrity-off-main-worker.js`.

## Confirmed mechanism

`runCollectorOnce()` acquires the SQLite `instance_locks` row before opening its
pooled state session. That opening occurs before the cleanup `try/finally`.
`assertSafeStateFile()` obtains ordinary Number-valued `lstat()` metadata;
`stateFileIdentity()` then requires safe integer device and inode values.
A legitimate identifier beyond the safe integer range therefore causes
`local_collector_state_unavailable` before the session opens its write connection.

The lock has already committed, but its release callback is never reached.
Subsequent collection attempts reject any existing row whose PID is alive,
including a row owned by the same process. This is an application-level SQLite
row, not evidence of SQLite database-engine lock contention. It requires neither
a second application instance nor a provider executable problem.

## Independent reproduction

A disposable synthetic SQLite database was exercised with the actual local
`runCollectorOnce()` implementation under macOS Node v26.2.0. A Node module mock
changed only that synthetic file's `lstat().ino` to the Number representation of
the reported large identifier. All other metadata and database operations were
real. Two consecutive runs returned, in order:

1. `local_collector_state_unavailable`.
2. `local_collector_state_lock_held`.

Assertions confirmed that the retained row belonged to the test process and
that the provider factory was never called. The numerical check also confirmed
that converting the reported identifier through Number loses precision and
that adjacent identifiers can collapse to the same Number.

The checkout had no installed dependencies. The temporary harness resolved local
workspace packages through their declared public exports and missing third-party
dependencies through the existing primary checkout installation. No product
source was changed for this reproduction. It did not run a corrected worker,
Windows filesystem, Electron binary, or full regression suite.

## Additional findings and repair requirements

- Preserve exact identity at the filesystem boundary using BigInt stats. Never
  recover identity by converting an already rounded Number. Node documents the
  [BigInt stat option](https://nodejs.org/api/fs.html#fspromiseslstatpath-options).
- Update the state validator, wrapper validator, worker validator, and all
  comparisons together. Worker structured cloning can carry BigInt; any JSON
  boundary needs an explicit exact representation instead.
- Retain regular-file, symlink, ownership, link-count and mode checks. Switching
  all metadata to BigInt without adapting Number comparisons and masks breaks
  those checks.
- Move session acquisition inside the lock cleanup scope. Ensure client cleanup,
  session settling and lock release each receive their cleanup opportunity even
  when another cleanup operation throws. Current synchronous `client.close()`
  can skip session cleanup and release.
- Acquisition commits the row before syncing and returning the release callback.
  A post-insert close or sync exception can strand that acquisition too. Recovery
  must match its own acquisition, preserve another owner's row, and preserve the
  primary failure when cleanup also fails.
- Existing examined tests exercise ordinary identities, contention, stale locks,
  cancellation and worker identity mismatch. They do not supply the reported
  large-ID/session-opening failure combination.
- Regression proof needs exact large IDs through the real worker boundary,
  unequal adjacent large identities, security rejection cases, setup and cleanup
  failure recovery, post-insert failure recovery, and genuine concurrent-owner
  exclusion. Installed Windows startup and repeated refresh remain a separate gate.

## Practical interpretation

The diagnosis is high confidence conditional on the reported metadata belonging
to the affected collector state file. The source defects and synthetic failure
sequence are independently confirmed. The comment alone does not certify
database integrity or identify every running process. The issue form supplies
an application version even though the diagnostic excerpt itself does not.

Restarting can clear the stale-owner condition after its process exits, but an
unchanged file identity recreates the original failure and lock. Changing
`CODEX_BIN` cannot correct this earlier failure. Deleting state or weakening
identity validation is not a justified remedy. A fix should retain existing
evidence and qualify recovery on the affected Windows platform.

## Authorized implementation plan

The user authorized implementation on 2026-09-13 using Luna subagents at maximum
reasoning. The original diagnosis above describes the pre-change source.

1. Preserve exact filesystem identities across session creation, comparisons and
   the integrity worker, retaining closed contracts and filesystem protections.
2. Guarantee cleanup after session-opening and client/session cleanup failures;
   recover an acquisition that fails after inserting its own lock row.
3. Add synthetic regressions for large IDs, substitution, active locks and each
   failure boundary, then independently review the combined changes.
4. Run focused tests, architecture and documentation gates, then the applicable
   broader source validation. Record installed Windows verification separately.

Acceptance requires successful repeated collection on a synthetic large-identity
fixture, exact worker transport, failure recovery without deleting another
acquisition, and unchanged ownership/link/substitution protections. No database
schema change, state deletion, release publication or remote mutation is needed
for this source repair. A corrected installed Windows artifact remains an
environment-dependent follow-up gate.

## Reporter follow-up

The [15:33:22 UTC follow-up](https://github.com/adamallcock/tibotattle/issues/130#issuecomment-5654227544)
reports local recovery after replacing the stopped application's database with
a byte-identical copy whose filesystem identifier is within the existing safe
Number range. The reporter says the helper preserved permissions, checked hashes
and SQLite integrity, and retained a backup and receipt. These are reported
observations; this review has not inspected the helper or receipt. The opening
reports that the app now works, while the detailed evidence explicitly stops
at successful file replacement rather than completed application analysis.

This strengthens the original diagnosis and leaves the authorized source repair
unchanged. Reallocation is a temporary environmental workaround, not a product
repair or an automatic startup step. The permanent fix must accept the existing
valid large identity and preserve the database in place.

## Coordinated integration

The user also requested integration with the task “Assess logs for latency
metrics.” That task confirmed and froze its clean Windows model-performance
branch at `c43b41597316b7ea1a8cc57ce1b75b9c17e53ba3`, based on the same
`9385bad2` revision. This worktree fast-forwarded through its complete sequence
`c94e0c1f`, `96ce84c2`, `c43b4159` without overwriting the collector edits.
The combined branch is `codex/issue-130-windows-integration`.

Its 29-file delta has no direct collector-file overlap, but changes shared
source readers, Windows guarded SQLite, timing orchestration and packaging
allowlists. The independent combined-tree run of its 92 focused tests passed
with no skips on macOS Node v26.2.0. See its
[implementation and native qualification boundaries](../plans/2026-09-13-windows-model-performance.md).
The reviewed source-read approval remains disabled. Neither integration nor
portable tests establish Windows native or installed-app readiness.

The portable/Windows test manifest now includes collector identity, session,
worker and cleanup regressions plus the new source-handle, guarded-SQLite and
Windows timing tests. The dirty primary checkout was not imported or modified.

## Implementation result

The collector now reads exact identity-bearing metadata as BigInt, normalizes
only already-safe Number callers, and preserves exact equality through the
integrity worker. State, migration-lease and legacy-stream identity checks use
consistent metadata types; the file, link, owner and permission protections
remain in place. Session statement preparation is inside connection cleanup.

Run-once session opening and foreground setup are inside lock cleanup coverage.
Client, session, signal and watcher cleanup cannot prevent the final release
attempt. Lock rollback and release match the acquisition's PID and monotonic
ISO timestamp, including same-process retries under a fixed clock. A transient
release failure can be retried; post-insert sync or close failure attempts to
remove only that acquisition. Existing databases and schemas are preserved.

Integration review found additional timing-store cleanup errors. SQLite guards
now stay held if a failed close leaves the connection open, and close can retry.
If SQLite closed before reporting failure, guard cleanup is still attempted.
Startup and ingestion preserve primary errors and attempted-byte accounting
when secondary cleanup fails. No native approval is enabled by these repairs.

The client-source exporter also needed the three new shared filesystem/SQLite
modules in its explicit allowlist; its regression now verifies their inclusion.
The development-artifact verifier now accepts the builder's optional, closed
`sourceRead` manifest entry while rejecting malformed fields and self-enabled
approval. Existing sidecars remain compatible; source-read approval stays false.

## Validation result

All commands ran on macOS arm64 with Node v26.2.0. Root dependencies were installed
with `pnpm install --frozen-lockfile --ignore-scripts`; Worker dependencies used
their independent npm lockfile. Native Windows behavior was not simulated as
passing evidence.

| Scope | Result |
| --- | --- |
| Collector identity, lock, session, worker, CLI and passive suites | 118 passed, no skips |
| Original coordinated Windows/timing focused suite | 92 passed, no skips |
| Final timing cleanup, shared SQLite, source handle and model-performance suites | 27 passed, no skips |
| Local companion (`npm run product:local:test`) | 356 passed, no skips |
| Source exporter and portable/Windows manifest contract checks | 6 passed |
| Final portable lane (`pnpm test:portable`) | 1,407 passed, 20 platform skips, no failures |
| Development-artifact verifier | 22 passed, 2 platform skips, no failures |
| Architecture and preflight | Passed; 20 preflight tests |

The initial full `npm test` run completed 5,245 tests: 5,180 passed, 17 failed,
48 skipped. That run preceded the final integration corrections. Failure triage:

- Three test files required missing Worker dependencies; all passed after the
  independent locked install.
- The client-source exporter exposed the genuine missing-module allowlist gap;
  it passed after the scoped correction.
- The detailed-accounting fixture, native deny-network audit, and macOS synthetic
  app UI/watchdog smoke passed outside the outer sandbox. The native audit's own
  deny-network policy remained enforced; the app smoke used no real Keychain
  access or system installation.
- All 44 synthetic R7 tests across materialized boundaries, synthetic history,
  journal ownership, release semantics and resource measurements passed outside
  the sandbox. Their earlier failures lacked process-liveness/RSS observations.
- Two retained R7 receipt tests still reject outdated workload source hashes/file
  counts. Protected retained receipt regeneration was not performed.
- The reporting facade's expected-export test still lists an older API. Both its
  test and facade are unchanged from integration base `9385bad2`; it is an
  inherited unrelated mismatch, not a passing gate or an integration fix.

The full-suite command therefore remains non-green; focused reruns must not be
represented as a fresh complete green run. Windows native binding/build, kernel
security, packaged large-ID startup and repeated refresh, signing, updater and
publication remain separate gates. No private state was reset or replaced.
