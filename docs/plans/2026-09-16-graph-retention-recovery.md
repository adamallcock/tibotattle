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
