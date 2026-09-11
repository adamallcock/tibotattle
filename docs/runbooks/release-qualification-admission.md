---
title: Early release admission and trusted local evidence reuse
date: 2026-09-08
type: runbook
status: maintained
---

# Early release admission

Use this before expensive R7 or native finalization. It runs a fixed synthetic
profile covering paginated reset/ancestry and local index preservation/upgrade:
the complete `export-paginated-reset`, `export-paginated-ancestry` and
`local-unified-index` test files. It is not installed-app qualification or a
replacement for the existing R7 receipt contract.

```bash
node scripts/qualify-release.mjs inspect
node scripts/qualify-release.mjs run
node scripts/qualify-release.mjs run --refresh
```

Inspection reads inputs and existing records only. `run` writes private local
evidence under `.release-build/qualification` and runs tests only if required.
`--cache <directory>` selects owner-controlled local storage; `--timeout-ms`
may lower the default 180,000 ms ceiling. Keep this outside published artifacts.
No remote operations, Keychain access, R7 generation or signing occur.

## Reuse contract

The key binds the complete reviewed source/data/test/runner profile, installed
dependency bytes, lockfiles, Node executable and runtime components, operating
system/architecture and controlled test settings. Both explicit worker entrypoints
are included. It deliberately over-includes local source instead of pretending
to infer every possible JavaScript input. Hosted app and documentation edits
alone do not invalidate this local analytical proof.

The versioned reviewed executable profile is an additional trust boundary.
Changed executable/test/runner/dependency bytes must be reviewed before they can
mint reusable evidence; merely passing tests cannot silently authorize a new
filesystem or subprocess dependency. A changed or unknown profile can run fresh,
but reports `passed_not_reusable`. Review the exact input/runtime dependencies
and the synthetic-only execution boundary before deliberately updating the
reviewed profile. Never automate its digest update as a test-failure repair.

Only a completed run with a complete TAP summary, nonzero test count, all tests
passed and zero skips/cancellations/todos qualifies. A failed, interrupted,
tampered or unrelated receipt never becomes a hit. Exact inputs are rechecked
under exclusive cache ownership and after execution. Do not edit the source or
dependencies during qualification; pre/post hashes detect drift but cannot
prove that temporarily changed bytes were never restored between observations.

The child receives private synthetic HOME/scratch directories, fixed locale,
timezone and umask, no inherited Node hooks or credentials, a bounded output
budget and a hard wall-clock timeout. Native Zstd support is required. Native
worker threads are still synthetic tests, not physical hardware evidence.
Private scratch data is retained for review; no broad automatic cleanup occurs.

The returned timing is observed work avoided, not a performance benchmark or
proof of current host capacity. `releaseReady` always remains false. The status
command in [agent release operations](agent-release-operations.md) can inspect
the journal, but only qualification input inspection can establish current reuse.

## Earlier hosted admission

Use [migration rehearsal](release-migration-rehearsal.md) to observe the exact
deployed migration prefix and rehearse it against populated synthetic data.
Supplied prefix snapshots do not prove current production state. Disposable
remote syntax checks require their own explicit authorization and cannot target
the production or staging databases. Synthetic historical local-index tests do
not substitute for the exact deployed D1 prefix or an installed predecessor.

## Scoped iteration and final qualification

The test planner now has `worker` and `public-site` lanes. Each runs the complete
owning Worker gate, including its clean-source dry builds; the public-site lane
also runs all UI and public-release-site tests. Only reviewed hosted source,
migrations/configuration and public builder paths select them. Shared browser
assets, unfamiliar scripts and shared configuration still fall back to the full
gate. Both hosted lanes together run the Worker gate once.

```bash
node scripts/test-lanes.mjs plan --path apps/worker/src/index.ts
node scripts/test-lanes.mjs changed --base <reviewed-base>
node scripts/test-lanes.mjs changed --base <reviewed-base> --full
```

`--full` always runs the integrated gate without synthetic-cache reuse. Keep
final release checks, signed trust, exact predecessor evidence, current remote
state and public readback separate. Existing R7 v0.1 receipts retain their full
fingerprint and schema: this cache never reinterprets an old receipt under a
smaller key. A narrower R7 acceptance schema and resumable R7 calculations remain
separate qualification work.
