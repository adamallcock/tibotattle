---
title: GCP measurement subprocess cleanup repair
date: 2026-10-03
type: receipt
status: snapshot
---

Local synthetic evidence only, from base `cc447d55064cf1bb84f36dfc62697f801aa579ab`
on macOS with Node 26.2.0 and zsh. No provider reads, writes, cloud commands,
database tasks or benchmarks ran. Existing READ-EXPANSION and L2 wrapper
failures remain historical failed gates; this receipt does not qualify a cloud
measurement or reinterpret those runs as passing.

The unchanged wrapper enumerated a sampler's descendants while the sampler
could still finish sleeping and create another snapshot child. A bounded
synthetic test widened precisely that enumeration-to-signal interval. The
ordinary TERM/INT/HUP step and already-active sampler scenarios passed; the
racing sampler left two exact-owned descendants running. The preserved failing
transcript has SHA256
`e2c4bb9a3db08d7772072b6054c1df10d04432a1772ddb5176b8a88b0ae1a4ab`.

The initial checkpoint `7b45338861aace2c991b051d1839873f8c32f6aa` was
requested-changes in independent review: TERM followed by CONT reopened forks,
and its direct-child wait could block indefinitely when TERM was ignored. Its
passing ordinary-child tests did not establish resistant-child cleanup.

The revised wrapper freezes each owned parent before enumerating its children,
queues TERM and immediately disposes the still-frozen tree with SIGKILL,
descendants before parents. It never resumes the captured tree or waits
indefinitely on it. This is explicit forced cancellation of disposable local
drivers; the independent EXIT `meas-teardown` remains authoritative for remote
cancellation and cleanup. Frozen identities are not signalled again after an
unfreeze/grace interval. No shared production process group is signalled.

The next checkpoint `12c3aabff0f95aa20f9363b87d8f1f0c8fb707b0` fixed
resistant-process disposal but was also requested-changes: the real guarded
and uncapped callers treat refresh exit codes as data, so a generic nonzero
`sampled` return did not stop them from using existing receipts.

Cleanup failure now emits the separate `MEAS_LOCAL_PROCESS_CLEANUP_FAILED`
marker and exits the wrapper from `sampled`, triggering EXIT teardown before
either maintained caller can read or qualify an existing receipt. Successful
cleanup still returns the original refresh exit code unchanged.

A capture error still disposes every already-frozen PID and reports
`MEAS_LOCAL_PROCESS_CAPTURE_FAILED`; normal sampler cleanup exits the wrapper on failure.
It does not claim undiscovered descendants were proved absent. Teardown, exit
130, measurement profiles and task timeouts are unchanged.
The test records only its own child PIDs and starts each harness in a dedicated
process group. It proves those processes are visible and belong to that group
before cleanup. Final safety cleanup targets that exact group; command-pattern
searches and broad process kills were removed. Process visibility refusals do
not count as successful cleanup.

Validation:

- `zsh -n apps/worker/scripts/gcp-fastpath-prod-shape/run-prodtier-measurement.sh`
  passed.
- `node --test apps/worker/scripts/gcp-fastpath-prod-shape/prod-shape.check.mjs`
  passed 14/14 local fixture tests.
- The revised regression covers TERM/INT/HUP, active sampler, controlled spawn
  race, normal completion, TERM-resistant root, TERM-resistant descendants,
  resistant sampler completion, capture refusal and normal-cleanup capture-error
  propagation. Exit and inherited output
  pipes must close within the existing five-second bound; all recorded owned
  processes must be gone.
- A regression executes the real guarded/uncapped caller loop verbatim with
  synthetic command adapters and already-written receipts. Cleanup failures
  exit 1 and run teardown without metrics or continuation; ordinary guarded
  and uncapped refusal codes 7 and 9 remain data and continue normally.
- An unrelated exact-owned sentinel in a separate group survives every case.
- The revised visibility/group-ownership and resistant-child regression passed,
  including three repeated extended runs. Earlier five ordinary-child repetitions
  remain historical evidence only.

Actual subprocess checks ran with permitted process visibility. No unrelated
process was signalled. Independent exact-head review and integration remain
separate gates.
