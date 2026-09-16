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
