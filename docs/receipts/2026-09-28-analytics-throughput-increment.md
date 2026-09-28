---
title: Analytics dependency and cache throughput increment
date: 2026-09-28
type: receipt
status: deployed-initial-canary-complete
---

# Analytics dependency and cache throughput increment

This receipt records the September 28 analytics-only deployment and its bounded
qualification. It does not establish a sustained processing multiplier. Current
operations remain governed by the [production runbook](../runbooks/production-operations.md).
The [implementation plan](../plans/2026-09-27-effective-cache-throughput.md)
retains the prior investigations, rejected SQL candidate and deferred work.

## Exact candidate and deployment

- Source: `15a5907ec784b1137242fd2d30cc7447a6010242`, a clean local commit based
  on deployed source `32bd409178ab6b0bca6588afeef4385449132459`.
- Worker: `tibotattle-analytics-recovery-20260914`.
- Version: `b38bdda0-0013-4d99-ad06-a414e90da3b2`, activated at 100% on
  September 28 at 11:26 UTC under the owner's existing production authorization.
- Analytics artifact: 1,391,095 bytes; SHA-256
  `b8d71d50e3fff4a36032432f53aa1b22d20a111704d05c5bb4384a35eebaaafa`.
- Independent readback at 11:26:55 UTC verified exact version resources, bindings,
  runtime, the minute schedule, complete schema and migration ledger. No
  migration or topology change was made. The query cap remains 950 and the
  delivery catch-up boost remains absent.
- Rollback is pinned to version `b488c666-0903-448d-a178-066cd9d8d9fd` and
  source `32bd4091`. The initial canary completed and its exact coordination
  lock was subsequently released.

## Changes

1. Compare canonical stored occurrence BLOBs before decoding in dependency SQL,
   preserving the existing admission, completeness and cross-day conflict checks.
2. Stop retrying empty retirement lanes within the same pass until useful work
   rearms them; retain independent erasure/capacity cleanup. Start v1 retirement
   from terminal owner fences. Let empty history slots select pending current work.
3. Fill a known missing effective quota day with one bounded page between
   analytical steps. Persist a complete reduced day before optional cache writes,
   memoize only fenced invocation-local dependency identities, and allow one
   coverage recheck. Checkpoint format 4 adopts 3, 2 and the original format.

## Qualification

- Full Worker Vitest: **2,176/2,176 passed across 168 files**.
- Workspace-copy, endpoint, generated-type, TypeScript and operations-script
  gates passed. Documentation and preflight checks passed before deployment.
- The umbrella `product:worker:check` command exited 1 after those tests at the
  general website asset stage: the isolated checkout lacks its generated public
  release manifest. The exact analytics-only dry build passed separately; its
  verified resources have no website assets binding. General website deployment
  is not qualified by this receipt.
- No push or merge occurred. The main checkout's existing changes were preserved.

## Measured costs

| Comparison | Baseline | Candidate | Boundary |
| --- | ---: | ---: | --- |
| Live single-day dependency query | 3,031,824 rows / 1,734 ms | 1,123,324 rows / 355 ms | One paired read-only probe, identical dependency output and stable owner revision |
| Live 100-day dependency query | 3,734,682 rows / 2,037 ms | 3,571,266 rows / 1,477 ms | Same paired-probe boundary |
| Empty retirement SELECT | 27,518 rows / 115.90 ms | 2 rows / 0.47 ms | Selection only; no remote DELETE |
| Synthetic repeated empty core sweeps | 256 statements | 8 statements | 32 busy-work attempts |
| Dense cold plus two warm results | 1,056 statements | 1,097 statements | Exact source `32bd4091` comparison; 3.9% increase from durability writes |
| One-gap current plus three following results | 842 statements | 795 statements | Same candidate with optional gap filling disabled/enabled; exact result parity |

These measurements support lower validation and idle-work costs. They do not
establish a 10-times end-to-end improvement. The dense fixture's statement
regression is retained explicitly.

## Production observation

The pre-activation aggregate at 11:26:14 UTC recorded 148 publication dates
queued, 2,098 stored graph results, 70 effective cached days and latest public
model day September 27. No graph result had completed in the preceding hour.
Publication runs in a separate Worker; queue movement is system progress during
the observation window, not an isolated benchmark of this analytics change.

The old version had already filled June 21 before deployment. At 11:10 UTC,
sampled 69-day scopes had no absent cache heads; newer 71-day scopes still lacked
September 27 and 28. Cache presence does not prove exact dependency validity,
and this deployment cannot receive credit for the earlier June 21 repair.

### Initial canary completed

The version-filtered observer captured 18 distinct scheduled invocations from
11:28:32 through 11:45:32 UTC: 16 ordinary runs and two long passes. All reported
`ok`, with zero uncaught exceptions, emitted lane failures or graph-failure
fields. Statement counts ranged from 428 to 879, below the unchanged 950 cap.
The observer completed successfully and stopped.

The two long passes used 856 and 879 statements and ended with controlled
`query_budget` deferrals; they were not provider errors. The first completed
four graphs and the second none. Across all 18 runs the new version reported
nine completed graph calculations. Database readback at 11:46:21 UTC confirmed
nine results since activation: one effective model and eight v1.1 models, all
for September 28. This is a bounded recovery/throughput observation, not a
sustained speed multiplier or proof that every large effective job has completed.

| Aggregate | 11:26:14 UTC baseline | 11:46:19 UTC sample |
| --- | ---: | ---: |
| Publication dates queued | 148 | 144 |
| Oldest queued publication | May 4 | May 8 |
| Stored graph results | 2,098 | 2,107 |
| Effective cached owner-days | 70 | 71 |
| Latest public model day | September 27 | September 27 |

A lookup derived from each active selection's exact checkpoint dependency
confirmed adoption and advancement under format 4. At 11:46:18 UTC:

| Active effective job | Retained format 3 | Format 4 |
| --- | --- | --- |
| Fits | plan / July 10 / ordinal 4,022 | plan / August 11 / ordinal 13,577 |
| Model | plan / June 29 / ordinal 2,082 | plan / August 29 / ordinal 24,688 |

These cursor dates describe acquisition of source history, not completed result
dates or a completion percentage. Both large jobs remain pending. A bounded
cache inventory at 11:37:38 UTC found the largest retained cache contained 70
days, 4,918,880 bytes and 246 fit fragments, below the 8 MiB and 4,096-fragment
admission limits; that does not establish validity or coverage of every newly
arriving day.

Final deployment readback at 11:46:18 UTC verified source `15a5907e` at 100%
with unchanged resources, bindings, runtime, schedule, schema and migration
ledger. The operation released its exact deployment lock at
`2026-09-28T11:46:52.787Z`. No rollback, forced run, manual lease deletion,
cache reset or migration was performed.

## Deferred enhancements

User-facing option 3, bounded parallel Queue jobs, and option 4, D1 replica
reads, remain recorded for subsequent enhancement. Neither is enabled here.
