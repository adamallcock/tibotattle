---
title: Device Sync and Backend End-to-End Verification Receipt
date: 2026-07-26
type: verification-receipt
status: development-verified
---

# Device sync and backend end-to-end verification

## Decision

The privacy-safe contribution path is verified for local and invite-only
development testing. It is not approved for a public deployment or outside
participants.

The verified path is:

1. read raw Codex logs only on the participant's computer;
2. produce content-free `telemetry-contribution-v0.1` batches;
3. publish a manifest last, after every batch is durable;
4. securely reopen and verify the committed set;
5. envelope-encrypt each batch in memory;
6. register an exact digest-and-byte-bound, one-use upload authorization;
7. validate, deduplicate, reprice, and persist accepted metadata;
8. recompute participant-private statistics;
9. publish an aggregate only after the configured participant threshold and
   scheduled-build boundary; and
10. delete participant data and withdraw affected aggregate snapshots.

## Real local evidence used

A current local export covering `2026-07-26T00:00:00Z` through
`2026-07-26T11:00:00Z` was prepared from the local ledger.

- Usage events: 4,979
- Quota snapshots: 5,213
- Activity markers: 0
- Privacy verdict: passed
- Closed-export bytes: 12,487,696
- Committed v0.1 batches: 51

No raw prompts, responses, commands, arguments, paths, email addresses, or
account names were sent to the backend.

## Invite-only HTTP lifecycle

The production-shaped Worker was run on loopback with isolated local D1 and R2
state. Twenty one-use invitations enrolled twenty independent participants.
Each participant submitted 200 accepted records from the closed contribution
format.

The smoke verified:

- exact secure session-cookie and same-origin CSRF behavior;
- session, device, upload, recovery, and invitation authority separation;
- one-use upload registration bound to encrypted digest and byte size;
- server-side schema validation and content-like field rejection;
- canonical server repricing rather than trusting client-declared cost;
- participant-scoped overlap deduplication and idempotent replay;
- private participant statistics recomputation;
- aggregate unavailability before the scheduled threshold build;
- aggregate publication at twenty eligible participants;
- byte-stable public aggregate reads;
- participant export isolation;
- local-device pairing and exact-scope upload registration;
- device revocation;
- recovery rotation and security-reset revocation;
- snapshot withdrawal when deletion begins; and
- deletion of all twenty participants.

After cleanup, D1 contained zero participants, contributions, telemetry
records, web sessions, browser upload authorizations, device pairings, devices,
device upload authorizations, eligibility rows, recovery receipts, and active
snapshot builders. One immutable community snapshot tombstone remained in the
`withdrawn` state. R2 contained zero blobs. The isolated local smoke directory
was moved to Trash.

## Local dashboard verification

The loopback companion was started against the current 291,495,453-byte
collector ledger. Startup previously failed at the old 64 MiB ceiling.
The loader now projects bounded summaries in one streaming pass rather than
retaining every ledger row in memory.

Rendered browser verification at a 1,440 by 1,000 desktop breakpoint confirmed:

- two observed seven-day allowance cards;
- API-price-equivalent usage and token-component accounting;
- measured-versus-calculated movement;
- interactive one-, two-, and three-hour rolling windows;
- residuals and exact UTC periods;
- week-by-week seven-day estimates and uncertainty;
- validation-error measures;
- coverage and known blind spots;
- local report links;
- the privacy boundary diagram and safe-export controls; and
- centralized-backend readiness and lifecycle explanations.

Switching the timeline from three hours to one hour updated the rendered chart
heading and matched-window statistics.

## Automated validation

- Worker check: passed, 52 of 52 Worker tests.
- Product local tests: passed, 14 of 14.
- Device capability, client, CLI, and sync tests: passed.
- Participant web UI tests: passed, 20 of 20.
- Root suite: 844 of 846 passed.

The two root failures are retained R7 provenance-receipt checks whose recorded
code and workload hashes predate the current source state. They were not
regenerated or weakened because they are evidence receipts, not product
behavior tests.

## Remaining release gates

The following remain intentionally outside this verification:

- a durable crash-safe background scheduler and retry queue;
- packaged desktop installation and automatic updates;
- production operator invitation issuance;
- production infrastructure, monitoring, rate limits, and incident response;
- a completed privacy and security review;
- explicit production consent copy and withdrawal operations; and
- activation of the account-scoped v0.2 telemetry lane.

Until those gates pass, the supported product boundary is local analysis,
loopback backend testing, and controlled invite-only development smoke testing.
