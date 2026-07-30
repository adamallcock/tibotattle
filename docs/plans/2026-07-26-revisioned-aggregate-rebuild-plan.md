---
title: Revisioned Aggregate Rebuild Plan
date: 2026-07-26
type: plan
status: verified
---

# Revisioned aggregate rebuild

## Outcome

Make centralized community statistics update safely after contribution or
participant deletion. Public reads must stop serving a snapshot before the
deletion can continue, then a bounded scheduled rebuild must create a new
immutable revision that excludes the withdrawn source.

## Current defect

The existing database triggers correctly withdraw all published or suppressed
weekly snapshots when a participant or contribution enters deletion. However:

- `week_start` is unique in the snapshot table;
- the builder treats any existing row as final; and
- no rebuild job is recorded.

Consequently, one deletion can leave every historical aggregate permanently
withdrawn. That is safe against disclosure but does not satisfy the product
requirement that centralized statistics be updated after deletion.

## Safety contract

1. Withdrawal remains synchronous with the first deletion state transition.
2. A withdrawn payload is never changed or re-published.
3. Every replacement is a separately hashed immutable revision.
4. Rebuild queries exclude participants not in `active` state and contributions
   not in `accepted` state.
5. Public reads select only the latest revision for the latest period.
6. A failed, interrupted, or racing rebuild leaves the public state withdrawn,
   never stale-published.
7. Rebuild work is bounded per scheduled pass and can resume later.
8. No participant, account-track, eligibility, exact support count, or
   client-declared cost is added to public output.

## Implementation

### Database

- Replace the one-row-per-week uniqueness constraint with
  `(week_start, revision)`.
- Preserve existing rows as revision 1.
- Record the source mutation epoch on each sealed revision.
- Add a bounded rebuild queue keyed by week.
- Update deletion triggers to enqueue every active period before withdrawing
  its current revision.

### Builder and reader

- Refactor the builder around an explicit weekly period.
- Reuse an active revision only when no newer mutation invalidates it.
- Generate the next immutable revision under the existing lease and mutation
  epoch guard.
- Clear only the rebuild request covered by the committed revision.
- Serve the newest revision of the newest week.

### Scheduled lifecycle

- Preserve retention and restore-suppression checks.
- Preserve the no-redeploy publication control.
- Build the normal completed week and process a small bounded number of queued
  historical rebuilds.

## Verification

- Migration preserves a legacy snapshot as revision 1.
- Deletion synchronously changes public output to `withdrawn`.
- A scheduled rebuild creates revision 2 without the deleted participant.
- The old revision remains withdrawn and byte-identical.
- A now-undersized cohort becomes suppressed rather than leaking 19-person
  totals.
- Concurrent mutation/build tests continue to fail closed.
- Full Worker and product checks pass.

## Release boundary

This is local development and production-shape evidence only. It does not
authorize public publication, external participants, or production deployment.

## Verification result

Implemented and verified on July 26, 2026. The Worker runtime suite passes 65
of 65 tests. A fresh invite-only loopback smoke accepted encrypted,
content-free contributions from 20 independent grant holders, published
revision 1, withdrew it on contribution deletion, rebuilt revision 2 as
privacy-suppressed from 19 remaining contributors, withdrew it during full
participant deletion, and rebuilt revision 3 as privacy-suppressed from zero
remaining contributors. Final D1 inspection showed an empty rebuild queue and
zero participants, contributions, and telemetry records. See the
[verification receipt](../receipts/2026-07-26-revisioned-aggregate-rebuild-verification-receipt.md).
