---
title: Effective quota-day production deployment
date: 2026-09-27
type: receipt
status: production-canary-verified
---

# Effective quota-day production deployment

Production analytics migration and initial activation completed on September 27
EDT (September 28 UTC). The first candidate was subsequently rolled back after
the online test found a mixed-version cleanup compatibility defect. The repaired
candidate was activated at 100% and verified at 02:52:43 UTC. Natural scheduled
work advanced, but its first long pass exposed a separate concurrency inefficiency.
The bounded retry follow-up passed all 2,075 Worker tests and was activated at
100%, verified at 03:30:20 UTC. The subsequent 15-run canary completed with
two graph results, three handled checkpoint advances and no reported failures
or exceptions. This receipt covers the analytics Worker only. It does not
establish a tenfold production speedup. The maintained authority is
[Production service operations](../runbooks/production-operations.md); source
qualification and synthetic comparisons are in the
[throughput investigation](../research/2026-09-27-analytics-throughput-options.md).

## Initial deployment

| Item | Verified value |
| --- | --- |
| Candidate source | `10ce797d317c0aea7787331daa8dee4accb75306` |
| Previous source | `31a32281c1224b63de45b55b14e44b66357ce321` |
| Initial candidate version | `37f7e394-0a6e-49a3-aa52-f21947119936`, initially 100%, subsequently rolled back |
| Previous Worker version | `dbdd0a32-2d28-4de4-9faf-85e38203ccf2` |
| Migration | `0028_graph_day_effective_quota.sql` |
| Migration completed | 2026-09-28 02:11:30 UTC |
| Activation started | 2026-09-28 02:15:04 UTC |
| Active-version verification | 2026-09-28 02:15:21 UTC |
| D1 statement cap | 950 per scheduled invocation |
| Schedule | Every minute; existing long-pass selection preserved |

The candidate is based directly on the preceding production source. Its runtime
modules and migration match the locally qualified implementation. Unrelated
website, client and newer admin-metrics changes are excluded. The candidate is
a local committed source artifact; this operation did not push or merge it.

Live version resources, bindings, runtime settings and schedule were compared
with the predecessor. Only the source revision binding changed. The existing
fold switch remains enabled. Delivery catch-up remains absent from the runtime
and its bindings; the earlier temporary boost was not restored.

The version was uploaded inactive, then activated after guarded readback.
Cloudflare's script settings showed the uploaded candidate's source binding
before deployment activation, while the deployments API still reported the
old version at 100%. This was reconciled against the immutable candidate and
active-version resources before activation; the upload was not repeated.
The shared production deployment lock was released after successful activation
and exact schema verification.

## Migration preservation

The deployed ledger contained exactly analytics migrations 0001–0026, with
matching source hashes. The complete pre-migration schema matched a local
rehearsal, including Cloudflare's internal table. Migration 0028 and its ledger
receipt were submitted together as one file. Migration 0027 was not part of
this production baseline or operation.

Afterward, all 189 schema objects and the complete ledger matched the rehearsed
result. Foreign-key checks returned zero violations. Before/after metadata
fingerprints matched for all 1,995 existing prepared-day values and all 8,064
payload pages, covering their stored content digests, counts and page ordering.
The migration did not rewrite payload pages. A D1 Time Travel recovery point
was obtained before the write; its provider details remain private.

Artifact SHA-256 identities:

- Migration: `7b83ecee7ad08506c636598b3e6ddb11894066dcc706474f8013bb8ea65a5b90`.
- Uploaded JavaScript: `8b9c32554fa59e3d66f4e6642d6e5290de1b7a39721cfe163ed510eba2010c6a`.
- Private upload configuration: `b3625b3a0c55400186d4ddd1f9473f4715534073a55ce2ec6b03cff84143ed07`.

## Natural workload observation

At 02:15:13 UTC, immediately after activation, the baseline was:

- 272 daily-publication days queued, oldest 2025-12-29.
- 2,062 stored graph results; 17 computed in the preceding hour and one in
  the preceding ten minutes.
- Latest model-publication day: 2026-09-25.
- 1,995 older typed-v1.1 prepared days and no effective prepared days yet.

The observed daily queue had already declined from 274 at 02:07:36 UTC, before
this activation. That earlier movement is not attributed to the new code.

The 02:16 scheduled pass ended at its deadline after 202 statements. The 02:17,
02:18, 02:19 and 02:20 passes reported a contained `graph_checkpoint_save` /
`checkpoint_unavailable` failure, with no completed graph result and no uncaught
Worker exception. The long pass ended after only 133 statements because this
was a checkpoint validity problem rather than a query-cap problem.

A read-only census at 02:19:41 found 761 active checkpoints with complete part
counts, and migration capability checks passed. At 02:20:41, the prepared
September 27 model key had a permanent retired head with no remaining stage.
Its original paged key remained intact. The independently deployed publication
Worker still used an older seven-method cleanup allowlist. Its shared runtime
runs graph retirement even in publication-only mode, so it selected the new
`:quota-days-1` format as obsolete. No tombstone was removed.

The analytics Worker was restored to version
`dbdd0a32-2d28-4de4-9faf-85e38203ccf2`, source `31a32281`, at 100%. Immutable
version resources and schedule were verified. Migration 0028 remains applied.
The original September 27 model cursor subsequently advanced from occurrence
24,274 to 24,874. At 02:24:35 the daily queue was 270; these observations do not
qualify the rolled-back optimization.

## Compatibility recovery

The repair retains the old effective fits/model method names and derives a
separate prepared storage dependency with the `effective-quota-days-2` domain.
Original readers still construct the original key and cannot interpret the
new payload. Older cleanup recognizes the method and metric. The prepared
reader explicitly adopts the original key; it never reuses the abandoned
`:quota-days-1` key or clears its tombstone.

After a completed or reused result passes source validation and readback, the
new code retires the exact prepared key opportunistically with eight statements
reserved and a two-write page limit. The first page marks the head retired;
existing cleanup then drains the rest. Age and erased-owner cleanup remain
unchanged.

The recovery is committed as `93dcecea800ba630b4261f91ce5f1acaef7db300`.
TypeScript, seven compatibility cases, 39 graph/prepared-fold cases and an
independent eight-case compatibility/adoption/cleanup pass succeeded. The
runtime modules and migration match the main qualified worktree byte for byte.
The production-config analytics dry build passed. Documentation governance
and preflight (20 tests) passed. The complete Worker command passed package-copy,
endpoint, generated-type, TypeScript and operations-script checks. All 163
Vitest files and all 2,062 tests passed. Its subsequent generic website dry
deployment stopped at the required clean, committed release-tree check; that
separate website gate remains unqualified. The analytics deployment uses the
clean, committed production candidate and its verified production configuration.

On the exact production-based recovery candidate, a selected eight-test run
passed against its own analytics migration set. The dense fixture compared
identical results using 6,001 quota observations, five days and 120 usage events:

| Calculation | Paged baseline | Recovery | Source / target | Invocations |
| --- | ---: | ---: | ---: | ---: |
| Cold model, including preparation and cleanup | 1,925 | 941 | 698 / 243 | 3 → 2 |
| Warm fits | 1,926 | 185 | 142 / 43 | 3 → 1 |
| Warm adjacent model day | 1,925 | 184 | 142 / 42 | 3 → 1 |

All three outputs matched exactly. Warm quota source page counts remained zero;
the cold calculation read 44, versus 124 in each baseline. Total statements
fell from 5,776 to 1,310 (77.3% fewer); warm calculations used about 10.4 times
fewer statements. These counts include the recovery's bounded completion
cleanup. They do not measure production elapsed throughput.

## Recovery activation and observation

| Item | Verified value |
| --- | --- |
| Recovery source | `93dcecea800ba630b4261f91ce5f1acaef7db300` |
| Active Worker version | `df7c087a-4393-4e21-8c3a-b895bd16a9d1`, 100% |
| Active-version and schema verification | 2026-09-28 02:52:43 UTC |
| Statement cap | 950, unchanged |
| Schedule and other runtime settings | Preserved from the previous active version |

The shared deployment lock was released after verification. No other Worker was
deployed. The recovered analytics JavaScript SHA-256 is
`af935e0c230fcd097b1354c346dede39b81dc0fea78d6c21fa4de4b79eadde2e`;
the private upload configuration SHA-256 is
`d8431d1685feabedce1e33b6fa7bfd063b46c772a2911c4083e29e2349a812d7`.

The 02:51:01 UTC baseline had 264 daily-publication days queued and 2,068 stored
graph results. The original September 27 model checkpoint was in the clusters
phase at occurrence 40,089; the prepared key did not yet exist. The 02:56:39
readback found the prepared key active at occurrence 43,869, with both expected
parts. The abandoned first candidate's key remained retired. The recovery's
02:53, 02:54 and 02:55 scheduled runs had no exceptions or checkpoint-save errors;
they ended at their normal deadline after 196, 137 and 236 statements.

At 02:56:37 the daily queue was 263 and stored graph results were 2,069. These
aggregate changes cannot yet be attributed solely to the recovery: the previous
version's 02:50 long invocation could still have been running after activation,
and daily publication has its own Worker. Subsequent ordinary and long passes
must establish durable progress and completed results before assigning a live
throughput gain. No effective prepared cache days had been published at this
readback; the adopted job was already beyond quota preparation's plan phase.

The 03:00 long run ended at 03:02:48 UTC with 408 statements and a contained
`graph_checkpoint_save` / `checkpoint_unavailable` failure. It overlapped the
03:01 ordinary pass. At 03:03:35 the same prepared head remained active, with
complete parts, and had advanced out of clusters into fitability at occurrence
442. At 03:02:21 the daily queue was 261. There were no uncaught exceptions in
the observed eight ordinary runs and one long run. No completed graph result
was attributed to this recovery by those invocation logs.

Source review found that effective owners do not use the existing v1.1 work
selection lease. A save that loses its exact-head comparison explicitly reads
back a newer active head, but still returns a failure field. The runtime then
abandons the remaining graph window. This mechanism is consistent with the
observed overlap and surviving, advancing checkpoint; the filtered live logs
do not identify the exact throwing branch.

The bounded follow-up distinguishes a verified newer active head as
`checkpoint_advanced`, allowing the scheduler to reload within its existing
query, time and step limits. Unchanged, missing, retired or malformed heads
remain failures. At that investigation checkpoint, source `93dcecea` remained
active; the subsequent qualification and activation are recorded below.

The follow-up is committed as `42e649333dcc04050214841089736692ac36d87b`.
It permits one contention retry and reports `graphCheckpointAdvances` only
when a newer exact head was observed. A second contention stops further graph
attempts in that invocation. Sixteen focused cases passed on this exact
production-based candidate: eight integration cases, including forced
different-successor races with preparation on/off and unavailable-head negative
cases; and eight runtime cases covering successful retry, repeated contention,
query/deadline/step limits and genuine failures. TypeScript, independent
source/test review and the production-config analytics build passed. The full
Worker command then passed package, endpoint, generated-type, TypeScript and
script checks, followed by all 163 Vitest files and all 2,075 tests, with no
test exclusions. The Vitest run took 899.80 seconds. The later generic website
dry-deployment step stopped at its clean release-tree requirement; this does
not qualify that separate website gate. Ten runtime, migration and regression
files match the main test worktree byte for byte.

At 03:09:15 UTC, the first effective prepared day existed in production.
At 03:19:07, one effective prepared day remained, the daily queue was 258, and
stored graph results were 2,070. The September 27 model checkpoint had advanced
through fitability to occurrence 10,960. These observations confirm continuing
work and live cache preparation; complete-window warm reuse and its elapsed
throughput gain remain unmeasured.

## Contention follow-up activation

| Item | Verified value |
| --- | --- |
| Source | `42e649333dcc04050214841089736692ac36d87b` |
| Active version | `6f675340-66e4-4344-abab-ee0072f3bd86`, 100% |
| Activation started | 2026-09-28 03:30:06 UTC |
| Version/resources/schema verified | 2026-09-28 03:30:20 UTC |
| Shared deployment lock released | 2026-09-28 03:30:25 UTC |
| JavaScript SHA-256 | `a8544988903db42e276669ed23e148e06f7025fed522f53b4d244c48f122e025` |
| Private upload configuration SHA-256 | `85edec1d4add0f7694f2f1d0bab46ad3876c128b3ab4687afb106a72b5249026` |

No further migration or other Worker deployment was performed. The 950 cap,
bindings, runtime settings, enabled fold switch and minute schedule remain
unchanged. The previous immutable version is `df7c087a-4393-4e21-8c3a-b895bd16a9d1`.

At 03:29:01 UTC, immediately before this activation, the daily queue was 257,
stored graph results were 2,070, and one effective prepared day existed. The
prepared September 27 model checkpoint was active in fitability at occurrence
17,200. The prepared September 28 model checkpoint was active in plan at
occurrence 924. The original keys and abandoned first-format tombstone were
preserved.

### Completed natural-workload canary

The observer captured 14 ordinary invocations and the 03:40 long invocation,
all on version `6f675340-66e4-4344-abab-ee0072f3bd86`. Their summaries arrived
between 03:32:03 and 03:46:06 UTC. All provider outcomes were `ok`; there were
zero exceptions, zero graph-failure fields and zero lane-failure events. The
ordinary runs completed two graph results. Across all runs, three verified
checkpoint advances by competing writers were handled without a failure.

The long pass handled one such advance, continued within the same invocation,
and ended on `query_budget` after 844 statements (24 delivery, 820 public work).
Its admission and save reserves explain stopping below the 950 hard application
cap. It did not complete a graph result itself. This verifies the retry behavior
on natural production work; different inputs and competing work prevent a
controlled elapsed-time comparison with the earlier failed pass.

Final readback at 03:47:43–44 UTC found:

- Daily queue: 254 days, down from the pre-follow-up baseline of 257. Publication
  runs in its separate Worker, so this is continuing service progress rather
  than a causal speedup measurement for the analytics patch.
- Stored graph results: 2,072, up from 2,070, agreeing with the two completed
  results in the candidate's invocation logs.
- Busy prepared model checkpoint: active, all three parts present, fitability
  occurrence 30,264 versus 17,200 before activation. The old original key and
  abandoned first-format tombstone remained unchanged.
- Effective prepared cache: one day. Complete-window warm reuse and its elapsed
  throughput gain remain unmeasured. Latest model-publication day remains
  2026-09-25; the overall rebuild is still in progress.
- Active version/source, bindings, runtime, schedule, schema and migration
  ledger reverified. The bounded tail observer finished and the shared deployment
  lock had already been released.

The next local experiment is preparing missing complete days during later
acquisition phases, followed by batching day-dependency checks. These are not
included in this deployment; the research record defines their boundaries.
