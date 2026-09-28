---
title: Clipped model blocks and unchanged replay qualification
date: 2026-09-28
type: receipt
status: verified-local
---

# Clipped model blocks and unchanged replay qualification

Local follow-up to the [publication integration experiment](./2026-09-28-model-block-publication.md)
and its [architecture plan](../plans/2026-09-28-analytics-redesign.md#current-local-slice-native-graph-adoption).
The user authorized continuing the implementation. Production routing remains
off; no remote migration, deployment or live load test is included.

## Scope

- Partition all 69 completed preview dates into intersections with UTC-aligned
  32-date blocks. The three or four ranges contain one to 32 dates each. Today's
  model result retains its native path.
- Add forward analytics migration 0031 for four exact admitted ranges. Preserve
  the previous 0030 schema and retained data during migration. Keep four stored
  jobs per source/owner, including obsolete leased jobs, and explicit cleanup
  before replacement work.
- Reuse a complete native result before private-block admission. The ordinary
  graph reader still validates its exact dependency, hash, method and source
  authority. The adapter additionally requires exact target owner revision,
  epoch, namespace and absence of erasure before returning. The graph-owned
  reuse helper refreshes an older input-revision proof and retires the matching
  completed prepared checkpoint, preserving native cache-hit housekeeping.
  An unchanged revision needs no update. A hit opens no block policy, job or
  claim. Existing bounded block cleanup runs before new work and in the capacity
  branch.

## Acceptance and measurement

Require coverage without overlap across all 32 alignment offsets, unchanged
input retention, bounded UTC-rollover recovery with old leases, revoked tokens,
and physical erasure. Real scheduled tests exercise both clipped edges and
all-contributor publication. Independent native/candidate targets must produce
identical serialized model-day and graph-preview outputs for cold, unchanged
replay and a correction that changes a published numeric value.

The paired performance harness includes scope capture, compute, adoption,
publication and cleanup in individual invocations capped at 950 statements.
Its controlled date order excludes the scheduler's fair-selection scan and
claim cost; real scheduled correctness is a separate test. Source admission
and fixture construction are excluded. CPU/heap are unavailable in the local
harness. Local timing is not production throughput evidence.

## Measurements

The [70-date paired profile](./2026-09-28-model-block-edges-window.json) uses
independent native and candidate targets with the same synthetic mixed-format
input. All 70 model-day publications and the complete preview matched exactly
in cold, replay and correction phases. The correction changed a published
numeric result. The candidate adopted all 69 historical dates into three
completed jobs; today remained native. Four-range alignments are covered by
the contract/store tests, not this particular profile date.

| Phase | Native statements | Candidate statements | Reduction |
|---|---:|---:|---:|
| Cold | 130,441 | 23,822 | 81.7% (5.48 times fewer) |
| Unchanged replay | 3,496 | 3,496 | Equal |
| Corrected input | 96,556 | 15,490 | 84.0% (6.23 times fewer) |

The previous full-preview candidate used 83,462 / 4,488 / 62,725 statements.
This slice removes its replay penalty and lowers its cold and correction work
by 71.5% and 75.3%, respectively. The
[one-date native control](./2026-09-28-model-block-edges-small.json) remains
identical between lanes: 1,568 cold, 115 replay and 1,229 correction statements.

Candidate invocations peaked at 927 statements cold and after correction,
and 18 on replay, within the 950 cap. No measured statement failed. Repeated
checkpoint payload submissions fell from 317.4 MB to 24.8 MB cold and from
316.4 MB to 24.6 MB after correction: about 12.8 times fewer submitted payload
bytes. These are cumulative payload bytes, not peak retained storage or network
transfer totals. Replay wrote zero rows and no checkpoint payloads in both lanes.

Observed local wall times were 214.2 s to 32.2 s cold, 153.0 s to 15.9 s after
correction, and 4.25 s to 4.60 s on replay (native to candidate). The concurrent
Worker gate can affect these timings; they are not a production speed estimate.
The profile does not measure ingestion, erasure cost, fair scheduling scans,
production D1 latency, CPU or peak memory.

## Source identity

- Local branch: `codex/reset-analytics-delivery`, base HEAD
  `d4c1f19228da8da3fec2e638052184f961b66795`, with the preserved uncommitted
  analytics work. This is a working-tree qualification, not a commit or release.
- Worker snapshot frozen at `2026-09-28T22:08:57Z`: 666 tracked or non-ignored
  Worker files, SHA-256
  `350fa6eebf5aa495a6daf922c4443449c3bc6191eef230678e6a737f08c4241e`.
  The digest is SHA-256 of sorted `path + NUL + file-sha256 + newline` records.
  Migration 0030's bytes match the preceding publication qualification.
- Node `26.2.0`, Vitest `4.1.11`, Wrangler `4.114.0`, local Workers test pool
  `0.18.8`. No dependency or lockfile change was needed for this slice.

## Validation

- Contract and durable-store tests: 52 passed, including all 32 alignments,
  populated 0030-to-0031 preservation, clipped rollover, old claims at the job
  ceiling, stale admission tokens and retirement.
- Scheduler tests: 8 passed, including both clipped edges, complete contributor
  publication, default-off behavior, today on the native path and bounded
  native fallback before migration 0031.
- Runner, deadline and publication tests after cache-helper extraction:
  42 passed. The adoption suite passed 4 tests, including the accepted
  outside-window upload, unchanged analytical bytes, monotone native proof
  refresh and rejection after target revision advance.
- Paired small and window benchmarks passed. The final frozen Worker snapshot
  passed all 2,327 Vitest tests across 186 files (1,073.17 seconds), along with
  workspace-copy guards, endpoint checks, generated types, TypeScript and the
  operational script tests in `pnpm run product:worker:check`.
- The encompassing command exited 1 at `deploy:dry`: `production:stage-assets`
  requires a clean, committed release tree. It stopped before Wrangler bundling;
  the subsequent staging check did not run. No source test failed, and no guard
  was bypassed. Artifact, staging and production deployment remain unqualified.
- A post-gate fingerprint check confirmed that all 666 Worker files still
  match the frozen snapshot. `git diff --check` passed. No commit, push, remote
  migration, deployment or activation occurred.
- Architecture passed: 664 production files, 2,784 imports, zero approved debt
  edges. Documentation governance passed across 287 Markdown and 1,147
  source/config files. All 20 preflight tests passed.

## Review correction

The first fast-path draft omitted the native input-revision refresh. A historical
value can remain numerically correct after an upload outside its window while
its cached input-revision proof needs to advance. Leaving that proof stale forces
extra model-cohort dependency revalidation. The preview freshness flag is based
on its separate current-fit cohort; no model-only freshness-flag regression was
established. The final path shares graph-owned proof refresh and
prepared-checkpoint retirement. The earlier
interrupted broad run and superseded small comparison are not final evidence.

## Qualification boundaries

The scheduled edge tests use 60-second pass deadlines, one 950-statement meter,
and two synthetic contributors. They select and publish both real edge cohorts.
Valid synthetic publications for intervening dates steer the fair selector to
the oldest edge; those intervening dates were not calculated by that scheduled
test. The separate paired harness computes all requested dates.

Next, exercise the scheduled path with the production entrypoint's 55-second
minute and eight-minute long-pass windows, plus the lower-level 20-second
default, and accepted new input between resumptions. These windows were clarified
during the subsequent source review; the test observations above are unchanged.
The completed-row append regression
does not prove that an unfinished block makes progress while its own source
keeps receiving uploads. Current job identity includes owner and input revision,
so a new owner snapshot can replace private work even when the selected window
has unchanged dependencies. Prepared days can be reused, but completion under
repeated appends remains unmeasured. Compare that workload with the already
covered other-owner freshness tick, recording job identity, retained progress,
retirement, statements and completed publications. Keep production disabled
until that liveness boundary and the concrete migration/deployment candidate
are qualified.
