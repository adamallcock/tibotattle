---
title: Backend Retention and Restore Verification Receipt
date: 2026-07-26
type: verification-receipt
status: passed-local-gate
---

# Backend retention and restore verification receipt

## Scope

This receipt covers a local development gate for the central contribution
service. It does not authorize production deployment, a public route, external
participants, or real-user collection.

The verified slice adds:

- a second independent D1 deletion ledger;
- fail-closed participant tombstone creation before R2/primary deletion;
- request-time denial for tombstoned browser/device/upload authority;
- hourly restore suppression and seven-day encrypted-quarantine cleanup;
- retryable R2 cleanup state;
- content-free lifecycle health; and
- a safe local migration runner that applies the same state directory to both
  D1 databases.

The implementation contract is recorded in
`docs/plans/2026-07-26-backend-retention-and-restore-safety-plan.md`.

## Automated Worker evidence

Command:

```sh
cd apps/worker
npm run check
```

Result:

- generated Worker bindings current;
- TypeScript passed;
- operator script syntax and checks passed;
- 4 Worker test files passed;
- 60 of 60 Worker tests passed;
- dry deployment packaging passed;
- dry deployment exposed both D1 bindings, R2, assets, rate limits, and no
  route;
- no deployment occurred.

The focused lifecycle tests prove:

- an accepted object older than seven days is deleted from R2 while canonical
  participant statistics remain available;
- an R2 deletion failure leaves `quarantine_deleted_at` unset, records a fixed
  lifecycle failure state, and succeeds on retry;
- participant deletion cannot remove R2 or primary rows when the independent
  deletion ledger is unavailable;
- retry after ledger recovery completes deletion;
- a tombstoned participant in a simulated pre-deletion primary restore is
  denied before replay;
- 101 restored participants are suppressed in explicit bounded 100-plus-1
  passes, with aggregate publication blocked while replay is incomplete;
- replay removes participant, session, upload authorization, contribution,
  occurrence, canonical event, and R2 state;
- replay withdraws the sealed aggregate snapshot; and
- the independent ledger contains no participant ID, only a 64-character
  domain-separated digest, fixed schema version, deletion time, and bounded
  retention time.

## Live loopback HTTP evidence

Environment:

- loopback Worker: `http://127.0.0.1:8793`;
- isolated Wrangler state under a fresh `/private/tmp` directory;
- invite-only admission;
- local D1 and R2 bindings;
- one existing owner-only 213 KB privacy-safe v0.1 contribution;
- 20 one-use owner-only invitation files; and
- no remote binding or external network destination.

The first migration attempt exposed an operator defect: npm forwarded
`--persist-to` only to the second command in a chained migration script. No
participant was enrolled. The command was replaced by
`scripts/migrate-local.mjs`, which rejects `--remote`, accepts only an optional
state directory, and invokes both D1 migrations with the exact same resolved
path.

The corrected migration applied:

- all 10 primary D1 migrations to the isolated state; and
- the independent deletion-ledger migration to the same isolated state.

The real HTTP smoke then passed with this content-free result:

```json
{
  "status": "passed",
  "enrollmentMode": "invite_only",
  "participants": 20,
  "acceptedRecordsPerParticipant": 200,
  "idempotentReplay": true,
  "personalStatisticsRecomputed": true,
  "aggregateUnavailableBeforeSchedule": true,
  "aggregatePublishedAtTwenty": true,
  "aggregateStoredBytesStableAcrossAliases": true,
  "aggregateWithdrawnOnContributionDeletion": true,
  "authorityIsolation": true,
  "devicePairingAndUpload": true,
  "deviceRevocation": true,
  "recoveryRotated": true,
  "securityResetRevokedUpload": true,
  "logoutClearedCookie": true,
  "participantsDeleted": 20
}
```

The smoke exercised actual HTTP enrollment, client-side envelope encryption,
one-use device/session upload registration, strict server validation,
server-side repricing, D1 canonical ingest, R2 quarantine, idempotent replay,
private stats/export, scheduled aggregate publication, recovery, security
reset, logout, contribution deletion, participant deletion, and tombstone
creation.

Post-smoke primary state:

```json
{
  "participants": 0,
  "contributions": 0,
  "records": 0,
  "sessions": 0,
  "uploads": 0,
  "devices": 0,
  "withdrawn_snapshots": 1,
  "retention_state": "completed"
}
```

Post-smoke independent ledger state:

```json
{
  "tombstones": 20,
  "distinct_digests": 20,
  "schema_valid": 1,
  "retention_valid": 1
}
```

The isolated R2 blob count was zero.

## Rendered product evidence

A fresh local Worker and empty isolated state were opened through the in-app
browser at `http://127.0.0.1:8794/`. The Data & privacy view rendered:

- backend ready;
- primary database connected;
- independent digest-only deletion ledger reachable;
- encrypted quarantine reachable;
- retention and restore replay awaiting its first scheduled pass;
- all four collection controls operational;
- participant view/export/delete rights available; and
- `telemetry-contribution-v0.1` as the accepted upload contract.

The eight-step lifecycle layout rendered without browser console warnings or
errors. The temporary server and state were stopped and removed after review.

## Live restore-suppression evidence

With the service stopped, the drill inserted one fixed synthetic active
participant into the already-clean primary D1 and inserted only its
domain-separated deletion digest into the independent ledger. This represents
an older primary backup being restored while the independent post-deletion
ledger survives.

The loopback scheduled lifecycle handler was invoked before any participant
route. After the pass:

```json
{
  "participants": 0,
  "retention_state": "completed",
  "restored_participants_suppressed": 1
}
```

This is a real cross-binding D1 replay, not an in-memory mock. The richer
canonical/R2 resurrection matrix is covered by the Worker integration test.

The implementation was also checked against the current official Cloudflare
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and
[R2 Worker API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/):
D1 permits 1,000 queries per paid Worker invocation (50 on Free), and R2
permits up to 1,000 keys per multi-delete. One pass scans at most 100,000
primary/tombstone rows in 1,000-row pages, suppresses at most 100 restored
participants, and removes at most 100 quarantine objects. Incomplete work is
explicit and publication remains blocked until a later pass completes. This
architecture therefore assumes a paid Worker; Free-tier operation remains
unsupported.

All isolated state and invitation files were moved to macOS Trash after the
postconditions were recorded. They are recoverable until Trash is emptied.

## Residual gates

This passed local gate does not settle:

- production Cloudflare account/region/project selection;
- production backup, point-in-time recovery, and R2 soft-delete horizons;
- the final tombstone duration (400 days is development-only);
- exact-event coarsening/deletion after 180 days;
- participant-feature retirement after 24 months;
- rejected/quarantined object lifecycle if rejected payload persistence is
  later introduced;
- a stopped-service production restore operator;
- infrastructure-as-code and least-privilege service identities;
- production monitoring, paging, budgets, and key rotation;
- external privacy/security review;
- load/soak evidence at 1,000 users; or
- named-human G3/G4 release approval.

No production gate advances from this receipt alone.
