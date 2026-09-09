---
title: Publication reconciliation and early admission validation
date: 2026-09-08
type: review
status: complete-with-baseline-failures
---

# Result and scope

Recommendations 4–5 are implemented locally in `c44f41f9`, with the calendar-safe
Worker fixture follow-up in `d3d98e58`, on `codex/release-agent-tooling`.
Recommendations 1–3 were pushed and read back
at `1b0f2f04c8a67c2df2277005372b779e38edb27d`. This is tooling validation,
not approval of a release candidate or a fully green repository release gate.

Maintained interfaces: [publication reconciliation](../runbooks/release-publication-reconciliation.md),
[early admission](../runbooks/release-qualification-admission.md), and
[migration rehearsal](../runbooks/release-migration-rehearsal.md).
The [implementation plan](../plans/2026-09-08-agent-release-tooling.md) defines
the unchanged acceptance and authorization boundaries.

Environment: macOS arm64, Node.js 26.2.0. Tests used synthetic records, temporary
databases, local Git remotes and development artifacts. No Apple submission,
signing, installed-app replacement, release publication, workflow dispatch,
live coordination-ref mutation, remote migration or deployment was performed.

## Test run report

| Gate | Observed result | Evidence boundary |
| --- | --- | --- |
| Final publication adapter/recovery suite | 22 passed, zero skipped | Canonical seven-asset contract, byte/attestation checks, immutable conflicts, older-release refusal, lost responses, partial success, async tap, shared ownership and stale website bytes |
| Final qualification/cache/input/lane/inventory group | 37 passed, zero skipped | Includes real stuck-child termination, output overflow, spawn failure and unconfirmed termination; reviewed runtime/dependency/input invalidation |
| Native journal, updater and web-lane integration | 56 passed, zero skipped | Overlaps publication tests; native phase recovery and existing guarded adapter contracts |
| Doctor/shared operation/cache/input group | 31 passed, zero skipped | Closed operation kinds, private summaries, ownership and refusal paths; overlaps later qualification tests |
| Migration admission and containment | 22 passed, zero skipped | Populated preservation, rollback/reopen, page ceiling, resource watchdog, receipt binding and remote-target refusal |
| Worker owning checks | 27 workspace checks, 236 operation checks, 22 migration checks passed | Endpoints, generated types and TypeScript also passed |
| Initial Worker Vitest | 957 passed, one failed out of 958 | Calendar-dependent HTTP re-pair fixture exhausted the native request budget; repaired below |
| Repaired telemetry-v1.1 suite | 23 passed, zero skipped | Complete file after the bounded-date fixture fix; no admission-limit changes |
| Final full Worker Vitest | 958 passed across 71 files, zero failed | Complete rerun after `d3d98e58`; 366.86 seconds |
| Worker dry builds | Development, production and staging passed | Clean `c44f41f9` source, staged assets and staging configuration; no upload |
| Root broad suite | 4,023 passed, four failed, 17 skipped out of 4,044 | 533.7 seconds; ran during implementation, before the final focused corrections below |
| Export closure | Three passed, zero skipped | Restores the existing native release entrypoint's explicit helper dependencies |
| Governance | Documentation, preflight, architecture and inventory passed | 20 preflight tests; 407 production files, 1,660 imports, zero architecture debt; 101 tool records / 103 paths |

Counts overlap and must not be added together. Root baseline skips do not qualify
the new features; the dedicated new-feature groups had zero skips. The broad
root suite was not rerun after the narrow export/inventory fixes and final
recovery test additions. Their complete owning groups were rerun successfully.

## Measured work avoided

The actual early-admission command ran all 166 selected tests successfully:
10,287 ms of test execution and 11,177 ms total. An unchanged invocation verified
the inputs and reused the proof in 608 ms, without running those tests again.
Read-only inspection took 277 ms. These are observed local timings, not benchmark
or future latency guarantees.

The reviewed profile covers 963 files and seven installed dependency packages,
with zero unknown dependency edges. Its executable digest is
`d3b11534e34f8853f7a3bc628d3d7f511c92c917bbff5a132c0542995c4f4fc6`;
the controlled-environment input digest was
`5eba019695d6f193d2e4bb7a1f55accb1a4d48bc4883abc3d9ee9263079dfa7b`.
The checked-in review digest was deliberately frozen after input-boundary and
executor review, not generated to bless an arbitrary passing test run.
Changing code/runtime/dependency bytes disables reusable proof until review.
Changing included data invalidates the ordinary cache key. Hosted/docs changes
alone do not invalidate these local analytical tests.

A contained populated rehearsal passed with 1,000 synthetic accounts,
100,000 records in each of the two telemetry tables, half the records on one
account, and a 336-day observation span. It rehearsed the 14 primary migrations
after 0042 through 0056, including interrupted transactions and forward replay.
An independent final implementation rerun took 34.115 seconds, used
145,211,392 bytes peak process memory and a 109,481,984-byte primary database.
External sampling observed 144,769,024 bytes and confirmed child termination.
The external watchdog and
database page ceiling remained enabled. This is local SQLite admission, not
Cloudflare parser, memory-limit or production-load qualification.

## Findings and disposition

1. **Export regression from recommendations 1–3:** the existing exported native
   finalizer acquired two helper imports without adding those exact helper files
   to the client allowlist. Broad testing failed with
   `CLIENT_EXPORT_IMPORT_NOT_ALLOWLISTED`. Both generic helper sources were
   already public in the authorized push. The reviewed two-file allowlist repair
   and assertions are pushed in `1b0f2f04`; no journals, credentials, private
   operation directories or broad export patterns were added. The earlier
   [1–3 report](2026-09-08-agent-release-tooling-validation.md) did not identify
   this failure; this record corrects that incomplete failure accounting.
2. **Inventory integration:** the publication tests' new release-evidence import
   needed explicit caller registration. Added it and reran all six inventory
   checks. These two corrections explain two of the four broad-root failures.
3. **Pre-existing R7 evidence mismatch:** both retained-R7 tests still fail at
   `contractProvenance.workloadCodeSha256`. The exact workload and retained
   receipt mismatch documented in the 1–3 report remains unchanged. A dedicated
   final rerun reproduced both failures. No protected receipt was edited,
   regenerated, relabeled or waived. The new synthetic cache does not change
   R7's acceptance schema or claim equivalent release qualification.
4. **Date-dependent Worker fixture repaired:**
   `telemetry-v11.spec.ts` / “fresh HTTP re-pair renews an expired active device
   without changing attribution enrollment, floor or staged history” fails at
   its final complete-sync assertion with `ATTEMPT_LIMIT_REACHED` (HTTP 429 on
   domain activation). The full file reproduces it (22 passed, one failed), as
   did that scenario alone. This is not recorded as a flaky passing retry.
   Worker runtime, test files, Wrangler configuration and lockfile are byte
   unchanged between pushed `1b0f2f04` and implementation `c44f41f9`; this task
   added operational tooling and its check registration. At the observed UTC
   date of September 9 (still September 8 locally), the permanently fixed
   August 28 fixture required 13 daily manifests. The partial/expired/recovery
   sequence therefore reached 21 requests against the unchanged 20/minute
   budget; the preceding UTC day needed 20. This explains a new failure without
   source changes. The fixture now uses the preceding UTC day consistently and
   keeps quota reset offsets relative to that day. All 23 tests pass after the
   change; the full Worker rerun then passed all 958 tests across 71 files.
   No rate limiter was mocked, disabled or enlarged, and no recovery
   assertion was weakened. This does not fix or certify production pacing for
   arbitrarily long historical syncs; that transport concern remains separate.
5. **Review fixes before final qualification:** parent rehearsal output is bound
   to exact admitted migration bytes, fixture size, limits and runtime; SQLite
   page ceilings are reapplied after every reopening. Publication refuses older
   latest-version promotion and recovers a lost lock-release acknowledgment
   without replaying uncertain actions. Child timeouts and output limits have
   actual-process regression coverage.

## Verification result: conditional pass for tooling

New commands are registered, linked from maintained runbooks, reachable through
their explicit inspection/mutation modes, and covered by focused passing tests.
Unknown inputs, malformed records, source drift, missing proof, conflicting
owners, immutable byte conflicts and uncertain external outcomes fail closed.

The repository-wide release gate is **not green**: retained R7 evidence still
fails its unchanged acceptance checks. Current remote permissions,
actual signed/installed artifacts, physical Intel behavior and a disposable D1
parser run remain separate authorized gates. Stable dual-macOS publication is
the implemented scope; other channels/platforms are not implied. R7 schema
narrowing/calculation resume is not smuggled into this synthetic admission cache.
