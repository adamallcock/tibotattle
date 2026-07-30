---
title: Participant Contribution History Verification Receipt
date: 2026-07-26
type: verification
status: verified-local
---

# Participant contribution history verification

## Outcome

The local production-shaped portal now displays the authenticated
participant's accepted contribution batches from canonical Worker state and
supports exact contribution deletion. This is a verified G8 product milestone,
not approval for external participants or cloud deployment.

## Implemented contract

- `GET /api/v1/me` returns `participant-profile-v0.2` with at most 101
  summaries.
- A summary contains only a private contribution identifier, closed status and
  provenance fields, covered/received timestamps, accepted/deduplicated counts,
  server-pricing state, and encrypted-quarantine lifecycle.
- The browser projects unknown fields away and fails closed on malformed
  schemas, counts, timestamps, retention intervals, statuses, lifecycle states,
  duplicate identifiers, or oversized arrays.
- The response omits R2 keys, digests, dataset/account pseudonyms, eligibility
  identifiers, recovery/session/CSRF/upload authority, IP data, source paths,
  prompts, responses, commands, and arbitrary diagnostics.
- Encrypted-object deletion after seven days is described separately from
  canonical metadata retention.
- Exact contribution deletion is participant-scoped, CSRF-protected,
  explicitly confirmed, and followed by a private/public-results refresh.

## Automated evidence

`npm run product:check` passed:

- 27 browser/data-boundary tests;
- 33 local-companion, builder, queue, and device tests;
- 65 Cloudflare-runtime Worker tests;
- generated Worker type verification;
- TypeScript type checking;
- operational-script syntax/tests; and
- a Worker deployment dry run with no deployment.

The Worker tests cover authenticated history, accepted and overlap-deduplicated
counts, cross-tenant read/delete denial, exact deletion, and the transition from
retained encrypted quarantine to deleted encrypted quarantine while canonical
metadata remains.

The broader root `npm test` run completed 866 tests: 864 passed and two
pre-existing R7 provenance-receipt assertions failed because their frozen
`workloadCodeSha256` and file-count inputs no longer match the current
repository. Those release-receipt failures are outside this product slice and
were not weakened or regenerated. The exact product gate above, including all
new contribution-history tests, passed.

## Real encrypted HTTP evidence

An isolated invite-only Wrangler server used fresh D1 migrations, R2 state,
deletion-ledger state, and twenty owner-only one-use enrollment grants. The
generated content-free transport fixture passed the real client encryption and
HTTP path. The smoke reported:

```json
{
  "status": "passed",
  "participants": 20,
  "acceptedRecordsPerParticipant": 2,
  "authenticatedContributionHistory": true,
  "historyUpdatedAfterContributionDeletion": true,
  "personalStatisticsRecomputed": true,
  "aggregatePublishedAtTwenty": true,
  "aggregateWithdrawnOnContributionDeletion": true,
  "aggregateRevisionAfterDeletion": 2,
  "aggregateFinalRevision": 3,
  "participantsDeleted": 20
}
```

The complete smoke also re-proved one-use upload authority, replay idempotency,
device pairing/revocation, private weekly comparison, recovery rotation,
security reset, logout, aggregate revision rebuild, and complete participant
cleanup. The disposable database and invitation state were moved to macOS
Trash after the server stopped.

## Rendered product evidence

A second isolated local-open Worker was exercised through the rendered portal,
not by injecting response fixtures. The browser:

1. selected a generated content-free `telemetry-contribution-v0.1` file;
2. accepted the explicit privacy consent;
3. used the portal's client-side RSA/AES envelope flow and one-use upload
   registration;
4. received a real `202 Accepted` ingest result;
5. displayed one canonical history card with two accepted records, zero
   duplicates, `macos` provenance, a `$0.0032` server-repriced API-price
   equivalent, and the seven-day quarantine date;
6. deleted the exact contribution and observed the empty-history state; and
7. deleted the anonymous participant and observed the private history and
   controls become hidden.

The first complete-participant deletion pass found a UI lifecycle defect:
`deleteParticipantData` and `logoutParticipant` called a nonexistent
`renderStats` function. The backend deletion succeeded, but the catch path left
stale history visible. Both call sites now use `renderPersonalStats`; a source
regression assertion and a second live portal pass confirmed the history is
hidden after deletion.

## Cleanup and boundary

Both temporary servers were stopped. Both isolated state directories,
including the content-free browser fixture and one-use invitation files, were
moved to macOS Trash and are recoverable.

This receipt does not authorize a route, external enrollment, real-user
collection, public aggregate release, background installation, or a production
retention policy. Cross-browser HTTPS session QA, security/privacy review,
load/soak testing, infrastructure provisioning, and named-human gate approval
remain open.
