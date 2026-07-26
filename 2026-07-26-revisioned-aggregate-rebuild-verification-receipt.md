---
title: Revisioned Aggregate Rebuild Verification Receipt
date: 2026-07-26
type: verification
status: passed-local
---

# Revisioned aggregate rebuild verification receipt

## Scope

This receipt verifies the local production-shaped backend path for accepting
privacy-safe encrypted contributions, publishing disclosure-controlled weekly
statistics, withdrawing affected output before deletion, rebuilding from the
remaining sources, and completing participant deletion. It does not authorize
external participants, production deployment, or public publication.

## Implementation under test

- D1 migration `0012_revisioned_aggregate_rebuild.sql`
- immutable `(week_start, revision)` aggregate rows
- source mutation epochs and persistent per-week rebuild queue
- active-participant and accepted-contribution rebuild filtering
- bounded scheduled rebuild processing
- latest-revision public reads
- generated content-free HTTP smoke input, with the existing owner-only real
  contribution-file mode retained

## Automated verification

From `apps/worker`:

```text
npm test
5 test files passed
65 tests passed

npm run typecheck
passed

npm run check
passed generated-type verification, TypeScript, script checks, 65 Worker
runtime tests, and deployment dry run

npm run product:check
passed 25 browser/UI tests, 33 local companion/transport tests, the Worker
check, and deployment dry run

npm test
passed the serial root repository suite
```

The aggregate regression creates 20 independently grant-eligible
participants, publishes a clipped weekly result, deletes one accepted
contribution, verifies immediate public withdrawal, runs the queued rebuild,
and proves:

- revision 1 remains byte- and hash-identical while marked withdrawn;
- revision 2 excludes the deleted source;
- 19-source output is suppressed instead of releasing an undersized cohort;
- the rebuild queue clears only after the new revision is committed; and
- repeating the normal builder returns the active revision idempotently.

## Real loopback HTTP verification

The Worker was started on loopback with a fresh isolated D1/R2 state,
invite-only enrollment, 20 one-use owner-only grants, the scheduled-handler
test route, and a generated closed-schema content-free contribution. The smoke
used real client envelope encryption and the public HTTP routes.

The content-free result was:

```json
{
  "status": "passed",
  "participants": 20,
  "acceptedRecordsPerParticipant": 2,
  "personalStatisticsRecomputed": true,
  "aggregatePublishedAtTwenty": true,
  "aggregateWithdrawnOnContributionDeletion": true,
  "aggregateRebuiltAfterDeletion": true,
  "aggregateRevisionAfterDeletion": 2,
  "aggregateRebuiltAfterParticipantDeletion": true,
  "aggregateFinalRevision": 3,
  "participantsDeleted": 20
}
```

The same smoke also passed authorization isolation, one-use upload,
idempotent replay, device pairing/revocation, recovery rotation, security
reset, logout, participant export, and complete deletion checks.

## Final database evidence

After stopping the Worker, a direct read-only local D1 inspection found:

| Revision | State | Source mutation epoch | Payload bytes |
|---:|---|---:|---:|
| 1 | withdrawn | 0 | 1,429 |
| 2 | withdrawn | 1 | 795 |
| 3 | suppressed | 21 | 795 |

The same inspection found:

- pending aggregate rebuilds: 0
- participants: 0
- telemetry contributions: 0
- telemetry records: 0

Revision 1 was the 20-participant publication. Revision 2 was rebuilt after the
first contribution deletion and then withdrawn when full participant deletion
began. Revision 3 was rebuilt after all participant deletions and remained
privacy-suppressed.

## Residual risks and release boundary

- This proof uses local Wrangler, D1, and R2, not deployed cloud
  infrastructure.
- It does not yet cover mass deletion across hundreds of historical weeks,
  worker failure injection at every queue boundary, or a long-running
  production soak.
- No external security/privacy review or G9 disclosure approval has occurred.
- Historical project-controlled URL/cache policy and production cache purge
  behavior remain to be frozen.
- Public deployment, external participant enrollment, and volunteer upload
  remain disabled.

The verified conclusion is narrow: the local backend can safely withdraw and
revision-rebuild centralized statistics after deletion without retaining
deleted participant data or releasing an undersized cohort.
