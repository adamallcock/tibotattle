---
title: Published analytics remain visible during recalculation
date: 2026-09-16
type: decision-record
status: accepted
---

# Published analytics remain visible during recalculation

Accepted product contract: ordinary contributions and corrections enqueue
background calculation. They do not withdraw previously published results.
This decision records the user's September 16 instruction; it does not establish
that the production service already implements the contract.

## Reader experience

- Keep the last completed result visible while an affected day is queued,
  processing, retrying, or awaiting delivery of new input.
- Publish a complete replacement atomically. A reader sees the old completed
  revision or the new completed revision, never an intermediate result or a gap
  caused by rebuilding.
- Preserve other published days. A correction to one day must not shorten the
  public history or reset progress for unrelated work.
- Keep the existing publication date truthful. Pending work may be indicated
  without presenting the older result as newly calculated.
- Failed or interrupted work retains its checkpoint and the last publication.
  A deployment, new contribution, or retry must not erase completed history.

## Calculation and publication

Queue state expresses work to do, not permission to display a result. Data
freshness and publication withdrawal need distinct meanings and evidence.
Ordinary append, corrected input, parser or attribution updates, and transition
between supported telemetry formats follow the same background replacement
contract.

A calculation uses an identified, coherent input snapshot. Additional input
queues subsequent work rather than repeatedly restarting that snapshot. The
publication transaction verifies the completed result and advances its head
atomically. It acknowledges only the work revision it completed; a later queued
revision remains pending. Replayed or concurrent attempts cannot double count,
overwrite a newer publication, or acknowledge unprocessed input.

Retirement may remove superseded derived revisions after a replacement is
published. The latest completed revision must not be retired merely because
input changed, a queue entry exists, or another calculation has started.
Display ranges are not retention instructions.

## Separate containment boundary

Explicit owner erasure, security withdrawal, and an intentional publication
disable remain separate privileged actions. The service must enforce those
actions without treating ordinary contributions as withdrawals. An opt-out
stops future uploads and retains already accepted history, as specified by the
[opt-out decision](2026-09-15-opt-out-stops-future-uploads.md).

Containment evidence must survive cleanup of owner or queue rows and delayed
delivery. Absence of those rows alone cannot prove an old publication is safe.
No previous publication may reappear after an applicable explicit withdrawal.

## Required evidence

Synthetic integration checks must exercise ordinary append and correction,
both telemetry formats and a format transition, source delivery lag, failed or
deferred computation, concurrent publication, newer work arriving during a
build, retirement before and after replacement, and multi-page owner erasure.
They must assert visible payloads and preserved queue revisions, not merely
successful calls.

Production acceptance separately requires observing retained historical dates
through new contributions and a completed atomic replacement. Local green
tests, an uploaded Worker version, and a deployed Worker are distinct gates.
