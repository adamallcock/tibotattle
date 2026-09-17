---
title: Restore graph progress and retain history after opt-out
date: 2026-09-16
type: plan
status: in-progress
---

# Restore graph progress and retain history after opt-out

The objective is a working public graph that retains completed history while
new contributions arrive. This plan records the repair being qualified on
2026-09-16; it is not evidence of deployment or restored public graphs.
The [production operations runbook](../runbooks/production-operations.md) and
the [accepted opt-out decision](../decisions/2026-09-15-opt-out-stops-future-uploads.md)
remain the operational and product authorities.

## Confirmed causes and repair

| Cause | Repair | Acceptance |
|---|---|---|
| An ordinary v1 upload from another device on an already represented day was classified as a global authority change. Old public dates became ineligible and were rebuilt behind the later-date queue. | Isolation migration `0004` classifies only this already-authorized append as a source update. Correction and containment checks remain. | Existing records remain unchanged; the append queues affected source work without changing the global history authority. |
| The scheduler's public phase repeated upload-journal delivery and consumed graph time. | Make the second phase public-only under the same shared deadline and statement budget. | A pending delivery event remains pending while a graph checkpoint advances; logs distinguish the two phases. |
| Completed public dates were repaired after the entire new-date queue. | Reserve three of four selection slots for stale published dates, with a bounded daily batch and graph budget reserve. | Old published dates recover while later queued dates continue to receive service. |
| Large v1 current-fit usage calculations could reach a deadline before saving their usage cursor. | Persist bounded usage-reduction state and every deferred phase transition. | Resume after a full page without rereading it and produce the same fit as the direct calculation, including equal-time boundaries. |
| Ordinary accountless opt-out was coupled to historical withdrawal. | Add a prospective exact-head retention marker and separate revoked upload permission from retained-history eligibility. | Refuse later uploads; retain accepted records, calculation progress, source eligibility and completed publication. |

Combined validation also found two integration gaps: the default 20-second
analytics pass could never enter a daily batch after initialization had spent
any of its deadline, and the restore tool did not classify the new retention
table as durable source state. Short passes now admit one bounded day per
public iteration; a populated restore regression checks the exact retention
record and its guards after restoration. Longer runs retain the bounded batch
and graph query reserve.

The v1 reducer must also return a valid bounded refusal when row or checkpoint
limits are reached. Checkpoint validation and synthesis must avoid repeated
scope-by-bucket scans. No raw telemetry is mirrored into analytics by these
changes.

## Delivery sequence

1. Complete focused tests and the full Worker gate on one clean combined source.
2. Rehearse the exact forward schema changes against populated synthetic data.
   Keep schema application and code deployment as separate recorded steps.
3. Renew the existing Cloudflare CLI login after the pending explicit approval.
   Automatic approval review rejected the earlier renewal; no alternate login
   or credential-refresh route is authorized by this plan.
4. Apply the prepared `0004` trigger repair to the current ingestion database.
   Then apply the qualified retention table and isolation changes before
   enabling code that writes the new retention marker.
5. Deploy the qualified analytics and main Worker source with existing routes,
   bindings and public assets preserved. Retain the active operation's lock and
   reconcile uncertain acknowledgements before sending any replacement write.
6. Inspect natural scheduled runs, saved graph checkpoints, published date ranges
   and the rendered public page. A successful scheduled invocation alone does
   not complete this plan.

Do not reset historical cursors or delete accepted telemetry. Preserve the
original database and all previous operation receipts. The current credential
renewal block affects remote execution; it does not prevent local qualification.

## 2026-09-16 root cause and repair (last-good publication)

Live inspection on 2026-09-16 (analytics cursor 26,981 delivered at public epoch
23,928) established that the daily series collapse was not a rebuild-speed
problem but a validity-model problem: 23,924 of 26,981 journal events were
classified as hard `owner-active` changes, every one advanced the global public
epoch, and every daily, model and preview publication pinned that exact epoch.
`readPublishedStorageCommunityDaily` hid every day after any hard upload and
`retireStorageCommunityDailyPage` deleted four such publications per minute
without a queue row, leaving 133 heads with neither a publication nor a queue
entry. Isolation migration `0004` stopped the multi-device classification (all
1,871 post-classifier hard revision-1 uploads had another device on the same
day), but same-day revision-2 corrections remain hard by design and still reset
the whole series under the previous readers.

The repair follows the accepted
[published analytics continuity](../decisions/2026-09-16-published-analytics-continuity.md)
contract:

| Change | Where | Effect |
|---|---|---|
| Analytics migration `0018` | `apps/worker/analytics-migrations/0018_last_good_publication_containment.sql` | Terminal watermark and per-day containment captured in the same transaction as any delivered or fenced withdrawal/erasure; backfill retires only contaminated or unprovable old publications |
| Visibility predicate | `storageCommunityPublicationVisible` in `storage-community-authority.ts` | Hard authority (source, namespace, policy, collection) plus pin epoch not below the applicable containment epoch; older public epochs alone never hide a completed result |
| Daily reader, selector, retirement, builder | `storage-community-daily.ts` | Last-good day stays visible during rebuild; retirement deletes only superseded, incompatible or contained revisions; an undelivered source terminal withholds everything pinned below it until delivery narrows it to the affected days |
| Graph preview and model days | `storage-community-graph-publication.ts`, `storage-community-graph-work.ts`, `storage-community-progress.ts` | Same predicate with the larger of the source and delivered terminal epochs; stale owner fits remain the last completed result with `inputs_current=0` |
| Erasure completion | `storage-erasure.ts` | Completion requires no daily publication pinned below the containment epoch of a day that folded the erased owner, instead of no publication pinned below the erasure epoch anywhere |
| Scheduler lane isolation | `storage-analytics-runtime.ts`, `storage-analytics-worker.ts` | A daily or graph lane failure is recorded with a closed stage and the pass continues; the scheduler log names closed internal error codes |
| Retained V11 model fingerprint | `97f14ae3` | Completes the resumed v1.1 model composition that failed every minute on the newest history day |

Acceptance is the focused Worker suites plus the populated `0018` rehearsal,
then the full Worker gate. Production acceptance additionally requires the
migration applied before the code deploy, both Workers deployed, and observing
the 245 daily heads and the 69 model days regrow without any published day
disappearing across a new upload.

## 2026-09-16 evening: graph lane checkpoint starvation

With the daily queue drained (332 days published), the history lane still
published no model day. Live inspection showed model day 2026-09-15 at 18 of 19
owner results; the missing owner is a v1.1 owner with a year of history whose
shared acquisition checkpoint head holds 235 parts (30.4 MB), re-selected every
pass (selection revision climbing by two per minute) with two abandoned partial
successor stages. The cause is input/output volume against D1 round-trip
latency, not the analysis kernel: loading paged 8 parts per statement with a
head and stage read per page (about 90 statements), the page group was cut by
the remaining budget so every pass produced a different successor generation,
and the 6-second save headroom could not finish eight 30-part batches. A pass
therefore made no durable progress, and `publishStorageCommunityModelDay`
withholds a day while any owner result is missing.

| Change | Where | Effect |
|---|---|---|
| Load pages carry the promoted stage | `loadStorageHistoryCheckpoint` | 16 parts per statement by default (32 at most); resumed pages issue one read each and the final head/stage fence still authorizes the assembly |
| Save resume cursor and memoized frame | `saveStorageHistoryCheckpoint`, `persistCheckpoint` in `storage-community-graph.ts` | Later writes of one generation issue one part batch and one head read; the frame of an immutable checkpoint is computed once per invocation; the part-insert trigger and head CAS remain the durable fences |
| Whole deterministic page groups | `advanceStorageV11Analysis` | An acquisition or usage group cut by the budget or deadline returns the prior checkpoint marked `cut`; the graph kernel stages nothing (`v11_checkpoint_group_budget`), so the next pass reproduces the identical generation and resumes its staged parts |
| Save headroom | `STORAGE_GRAPH_CHECKPOINT_SAVE_HEADROOM_MS` | 12 seconds reserved for the resumable save batches |
| Lane order | `runStorageAnalyticsPass` (`graphLaneFirst`) | The public phase alternates by minute which lane opens, so a live daily queue and a resumable graph checkpoint share the scheduled windows instead of one starving the other |
| Abandoned successor sweep | existing `retireStorageGraphPage` | Verified by test: once a different successor promotes, partial stages that expected the old head are removed in bounded pages |

Once loads completed, the same owner failed every pass with
`graph_model_compute`/`application`. A one-way token of the wrapped error in
the new `storage_analytics_lane_failure` log line resolved it to
`STORAGE_GRAPH_RESULT_UNAVAILABLE`: the owner's acquisition exceeds the kernel's
60,000 downsampled quota rows and is refused, but `advanceStorageV11Analysis`
returned every refusal in the scalar-analysis shape, which the cached
composition validator rejects for a model day. The model history now receives
the bare composition refusal (`status`, `reason`, `tracks`) that the maintained
finisher returns, so the day publishes with that owner as a refusal count.

With the refusal shape fixed, 2026-09-15 published as the first model day, but
two of the next six passes ended in `exceededMemory` on that owner's other days:
staging a near-limit acquisition held the decoded checkpoint, a defensive deep
copy of it, its part payloads, a second deep copy for framing, the round-trip
decode and two full canonical serializations at once. The load now hashes the
stage row instead of re-framing the decoded object and releases the part
payloads, the advance and the frame no longer deep-copy the checkpoint (the
encoders only read it; a cut group returns no checkpoint and the input is
consumed), and the frame round-trip compares digests one serialization at a
time.

## 2026-09-16 night: long-window graph pass

With every blocker cleared, throughput was the remaining problem. One owner's
device reports quota roughly every seven seconds with a fresh `resets_at` on
most observations (52,000 distinct values in 30 days), so the kernel's lossless
run collapse cannot shrink it: 1.15 million quota rows and 0.95 million usage
rows per 100-day window, refused at the 60,000 downsampled-row bound only after
the whole fold. At 1,024 rows per page, one 32-page group per 55-second claim
and ~300 ms per D1 round trip, one day-window cost about 40 minutes and the
70-day preview window about two days.

| Change | Where | Effect |
|---|---|---|
| Quota page 1,024 → 4,096 rows | `TYPED_V11_QUOTA_PAGE_SIZE` | Four times fewer round trips per fold; a page stays at 1–2 MB |
| Partial groups for cheap successors | `advanceStorageV11Analysis({partialGroup})`, `advanceV11QuotaAcquisition({stopAtEndpoints})`, `storageGraphV11GroupMode` | While the head stages in one save batch (≤ 30 parts) and the acquisition is not in its `endpoints` sub-phase, a budget-cut group stages its partial successor; a partial group always ends at the deterministic transition into `endpoints`, and a partial successor is staged only when its whole save fits the remaining statements and time (`STORAGE_GRAPH_V11_GROUP_QUERY_COSTS`), otherwise nothing is staged; `endpoints` and multi-batch checkpoints keep the fixed, reproducible 32-page whole group |
| Adaptive group size | `storageGraphV11PartialGroupPages`, `storageGraphV11SaveAffordable` | A partial group spends the window that remains before the checkpoint work deadline, sized from this compute's measured D1 latency (clamped 150–3,000 ms, default 400 ms), never more pages than the meter still owes after a reserve for an eight-batch save; a meter too small for any partial group falls back to the reproducible whole group |
| Many groups per claim | `computeV11` loop | After each promoted successor the claim continues from the object in memory while the meter and deadline allow; each phase successor is still promoted before more work |
| Long-window pass | `STORAGE_ANALYTICS_LONG_CRON` (`*/10 * * * *`), `runStorageAnalyticsPass({graphOnly, graphLeaseMs})` | A graph-only pass with a nine-minute deadline, a 900-statement meter and a twelve-minute claim lease; it skips delivery, erasure jobs, retirement pages and the daily lane, which the per-minute pass keeps; owner-day claims exclude each other, so the two passes work different owner-days |

The private production config for the analytics Worker must carry both crons
(`* * * * *` and `*/10 * * * *`) and `limits.cpu_ms` 300000; the in-repo
example config stays as the maintenance provider's strict-JSON contract expects
(an empty `triggers.crons`, no `limits`; the provider itself pins the minute
cron), so that provider does not yet deploy the long pass. The binding constraint of a long pass is the 1,000-statement invocation
cap, not wall time: about 860 statements reach one claim, roughly four minutes
of reads at production latency.

Still open: the acquisition checkpoint itself (up to 60,000 quota rows per
owner) is the structural cost; a compact representation, or a `resets_at`
jitter-tolerant collapse (a fit method change), is the next step.
