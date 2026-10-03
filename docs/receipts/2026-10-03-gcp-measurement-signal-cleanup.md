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

The wrapper now freezes each owned parent before enumerating and freezing its
children. It sends TERM and CONT to that captured tree and reaps the direct
child before clearing its PID. Signal handling and normal sampler completion
use the same cleanup. Teardown semantics, exit 130, existing timing assertions,
measurement profiles, provider guards and task timeouts are unchanged.

The test records only its own child PIDs and starts each harness in a dedicated
process group. It proves those processes are visible and belong to that group
before cleanup. Final safety cleanup targets that exact group; command-pattern
searches and broad process kills were removed. Process visibility refusals do
not count as successful cleanup.

Validation:

- `zsh -n apps/worker/scripts/gcp-fastpath-prod-shape/run-prodtier-measurement.sh`
  passed.
- `node --test apps/worker/scripts/gcp-fastpath-prod-shape/prod-shape.check.mjs`
  passed 13/13 local fixture tests.
- Five additional bounded signal-test runs passed, each covering TERM/INT/HUP,
  active sampler, the controlled spawn race and normal sampler completion.
- The final strengthened visibility/group-ownership regression passed.

Actual subprocess checks ran with permitted process visibility. No unrelated
process was signalled. Independent exact-head review and integration remain
separate gates.
