---
title: Model-block deadline qualification and publication repair
date: 2026-09-28
type: receipt
status: verified-local
---

# Model-block deadline qualification and publication repair

Local follow-up to the [durable model-block experiment](./2026-09-28-durable-model-blocks.md).
The preceding checkpoint passed all 2,292 Worker tests. Its sparse benchmarks
used a 60-second deadline; they did not qualify a populated 101-day reload under
the runner's normal 20-second deadline. The
[redesign plan](../plans/2026-09-28-analytics-redesign.md) records scope and gates;
the [production runbook](../runbooks/production-operations.md) remains operational
authority. No remote migration, deployment or scheduler activation has occurred.

## Reproduced deadline failure

The new synthetic fixture populates all 130 input calendar days with quota and
usage and adds 220 usage rows on one output day, crossing the 200-row page
boundary. The focused test requests two adjacent model dates. Each fresh call
uses the default 20-second deadline and a deterministic clock that adds 50 ms
per measured source or target D1 statement. This is an injected elapsed-time
scenario, not measured network latency or CPU.

Before the repair, acquisition completed, then at least four fresh invocations
left the same durable state: `phase=emit`, `selected=102`, `acquired=102`,
`outputs=0`, returning `deferred/deadline`. The uncheckpointed window reload
repeated without producing a model date. All observed invocations stayed within
950 measured statements and partial outputs remained unreadable. A compliant
statement budget alone therefore did not prove forward progress.

## Reload repair and deadline result

The runner now uses the existing bulk quota/usage head readers. Each invocation
loads their bounded metadata, selects exact immutable day keys and price
identities, and passes a fresh validated cursor to the ordinary payload reader.
This removes the individual metadata query for every payload. Selected payload
bytes and part counts are checked before a full reload, and the decoded window
retains its 8 MiB limit. Headers are refreshed after newly prepared days are
stored; missing present-stream heads never become inferred empty days.

With the same 50 ms clock and default deadline, the focused qualification passes:
**17 fresh work invocations, 6,207 work statements, 396 peak statements in one
invocation, and 15 deadline yields**. Both final model dates are READY and match
independent current graph calculations on a separate analytics database. A signal
cancellation after database work preserves resumability; every deferred result
remains private. The statement totals here measure the work invocations; the
larger paired benchmark also includes the separate final visibility read.

## Effective-source publication repair

The historical publisher validated effective-source READY results against the
native-v1 attribution method. The effective writer and reader use the v1.1
attribution adapter. The publisher now chooses that same method for effective
results. A regression creates a genuine READY effective model, publishes it
through the existing cohort path and asserts nonempty published values; the
focused test passed. This repairs existing publication and does not activate
the experimental model-block runner.

## Paired measurements

All three paired benchmarks passed using separate, initially empty reference
and candidate analytics databases. Source admission/setup is excluded; candidate
cost includes durable writes, fresh resumes and a separate final visibility read.
Each run compares every analytical field after validating the method-specific
private fingerprint. No scheduler or cohort publication cost is included.

### Fully populated input: 130 calendar days, 30 output dates

Every input day has quota and usage. One day includes 401 extra accepted usage
rows, forcing multiple pages. The candidate uses its normal 20-second deadline;
the independent per-date reference retains its 60-second benchmark deadline.
Both are limited to 950 measured statements per invocation.

| Phase | Reference / candidate statements | Reference / candidate rows read | Reference / candidate rows written | Reference / candidate local elapsed ms |
| --- | ---: | ---: | ---: | ---: |
| Cold | 95,551 / 7,289 | 100,844,447 / 2,743,097 | 10,521 / 3,017 | 155,983 / 3,897 |
| Unchanged replay | 540 / 36 | 360,239 / 4,952 | 0 / 0 | 495 / 9 |
| One corrected day | 17,975 / 684 | 79,575,150 / 464,569 | 1,117 / 36 | 86,177 / 607 |

The candidate uses **13.1 times fewer statements cold, 15 times fewer on replay,
and 26.3 times fewer after correction**. Rows read fall 36.8 times cold and
171.3 times after correction. Its busiest invocation uses **801 statements**.
Cold work takes ten work invocations plus the final visibility read and prepares
130 days. Correction takes one 667-statement work invocation plus the 17-statement
visibility read, rebuilds one day and reuses 129 prepared days. All 30 results are
READY in every phase and match the independent reference.

Local elapsed ratios are 40.0 times cold and 142.0 times after correction.
Reference-first execution, local storage, fixture structure and missing remote
CPU/heap/latency measurements prevent treating these as production forecasts.
The correction changes the exact accepted dependency; this fixture's fitted
coefficients remain unchanged. The separate integration regression proves stale
identity refusal and rebuild, so unchanged coefficients are not treated as proof
of invalidation by themselves.

### Sparse and small controls

| Workload and phase | Reference / candidate statements | Candidate before bulk heads |
| --- | ---: | ---: |
| 130-day sparse, cold | 15,750 / 2,348 | 2,575 |
| 130-day sparse, correction | 5,879 / 296 | 442 |
| 14-day small, cold | 1,032 / 547 | 568 |
| 14-day small, correction | 307 / 175 | 201 |

The sparse 30-date workload saves 6.7 times the cold statements and 19.9 times
the correction statements relative to independent per-date jobs. Both controls
retain exact output parity. Small unchanged replay still uses 36 statements on
either path; its candidate reads 4,952 rows versus 4,039 for the reference.
The bulk-header change reduces statements while sometimes reading more metadata
rows; no universal improvement in every resource dimension is claimed.

The dense correction still spends 542 of 684 statements on prepared-day target
access. Its nine dependency-link statements account for 122 of 177 measured D1
milliseconds and read 165,801 rows; prepared-day access accounts for 18 D1
milliseconds. Batched payload reads and dependency-query work therefore address
different costs. Native graph adoption and bounded scheduling remain the next
integration step before another optimization experiment.

### Evidence and reproduction

- [Dense report](./2026-09-28-model-block-deadline-dense.json), recorded
  September 28, 2026 at 18:09:57 UTC; SHA-256
  `7848dd571fd96c6cec192a2f2a486d39cbac946d65eb59c1368677f17d8312a7`.
- [Small report](./2026-09-28-model-block-deadline-small.json), 18:10:20 UTC.
- [Sparse report](./2026-09-28-model-block-deadline-sparse.json), 18:11:29 UTC.

All use Node.js 26.2.0, base commit
`d4c1f19228da8da3fec2e638052184f961b66795` plus the preserved working-tree changes,
and the same 646-file Worker fingerprint:
`81787c32b98ffba0d0c5cd7e8c5ba15fcafed27ab993a2420d59c2e9f115a37c`.
The CLI verifies source/config/test/migration/script inputs and installed
workspace package copies before and after the run. It writes reports exclusively
and refuses failed tests, changed inputs or incomplete D1 cost metadata.

Run from `apps/worker` using a new output path:

```sh
npm run analytics:shared:benchmark -- --model-block --full --dense --output /tmp/model-block-dense.json
```

Omit `--dense` for the sparse comparison; omit both `--dense` and `--full` for
the small control. The deterministic deadline regression is
`test/analytics-model-block-deadline.spec.ts`.

## Validation and remaining release gate

The focused deadline and publication regressions, all three paired benchmarks,
TypeScript and CLI checks passed. The final September 28 Worker run passed
**182 files and 2,294 tests** in 972.57 seconds against the frozen inputs above.
Workspace-copy guards, endpoint checks, generated types and operations/script
checks also passed. Architecture validation passed with 663 production files,
2,772 imports and no approved debt edges. Documentation checks and all 20 root
preflight tests passed.

The umbrella `pnpm run product:worker:check` then stopped at
`production:stage-assets`, which requires a clean, committed release tree.
The existing working-tree changes were preserved. Wrangler dry deployment and
staging checks were not reached, so the complete release gate remains open.
No remote migration, deployment or production activation occurred.

Scheduled block creation additionally needs graph-native fingerprint bridging,
fixed block boundaries and bounded retirement of superseded private jobs.
Production workload/CPU qualification, migration and activation remain separate
gates. This receipt makes no production speedup claim.
