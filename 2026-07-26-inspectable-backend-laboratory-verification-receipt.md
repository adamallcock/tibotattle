---
title: Inspectable Backend Laboratory Verification Receipt
date: 2026-07-26
type: verification-receipt
status: development-verified
---

# Inspectable backend laboratory verification

## Outcome

The production-shaped central service can now be started, seeded, inspected,
restarted, and viewed through one bounded local-development command:

```bash
npm run product:backend:lab
```

This proves the local Cloudflare Worker, D1, R2, HTTP, encryption, validation,
projection, and browser contracts. It does not authorize public collection or
claim that remote Cloudflare infrastructure is provisioned.

## Live end-to-end result

The laboratory ran on loopback against a newly created owner-only state tree.
It:

- applied all 12 primary D1 migrations and the independent deletion-ledger
  migration;
- issued 20 independent, one-use local invitation capabilities;
- enrolled 20 isolated participants through the real HTTP API;
- envelope-encrypted and uploaded one generated content-free contribution for
  each participant;
- accepted 20 contributions and persisted 40 canonical records plus 40
  contribution-occurrence rows;
- retained 20 encrypted-quarantine references and directly counted 20 local R2
  objects without returning their keys;
- rejected a separately encrypted payload containing a forbidden `prompt`
  canary with `PRIVACY_CANARY_DETECTED`;
- proved that the rejected payload did not enter the primary participant's
  canonical history;
- proved exact replay idempotency and one-use authority separation;
- recomputed private participant statistics using canonical server pricing;
- published one immutable, thresholded weekly community snapshot;
- returned a ready private clipped-versus-public-rounded comparison;
- verified the participant export contract;
- stopped the Worker, inspected bounded counts directly from both local D1
  bindings, and restarted the Worker against the same persisted state; and
- wrote the participant recovery capability only to a mode-0600 file.

The bounded database summary after restart was:

| Measure | Count |
|---|---:|
| Active participants | 20 |
| Accepted contributions | 20 |
| Canonical records | 40 |
| Contribution occurrences | 40 |
| Retained quarantine references | 20 |
| Direct local R2 objects | 20 |
| Published community snapshots | 1 |
| Deletion tombstones | 0 |

The state directory, participant-access file, and receipt file were all
owner-only.

## Browser verification

The Codex in-app browser loaded the Worker-served portal over loopback. It
rendered:

- `Backend ready`;
- connected D1 and deletion-ledger states;
- reachable encrypted quarantine;
- operational enrollment, registration, processing, and publication controls;
- the accepted `telemetry-contribution-v0.1` contract;
- the released July 20–27 community snapshot; and
- the clipped and rounded `openai_codex / gpt-5.6-sol` community cell.

Using the owner-only recovery capability restored the seeded primary
participant in the browser and rotated the capability. The replacement was
written back to the owner-only access file and hidden from the page. The
private UI then rendered:

- one safe usage event and one quota snapshot;
- `$0.0032` of server-repriced API-price-equivalent activity;
- 100% server pricing coverage;
- explicit separation of Codex Fast observations from API Priority pricing;
- a not-testable account conversion because account continuity was not
  transported;
- the participant's clipped values versus the already-public rounded community
  total;
- canonical contribution history and seven-day quarantine timing;
- participant export, access reset, sign-out, contribution deletion, and full
  participant deletion controls.

The browser accepted the `Secure`, `HttpOnly`, `SameSite=Strict`, `__Host-`
session cookie under its localhost development behavior. A staged HTTPS route
must repeat this test across target browsers.

## Automated verification

`npm run product:worker:check` passed:

- generated Worker type verification;
- TypeScript checking;
- 30 operator-script checks;
- 65 Cloudflare-runtime Worker tests;
- a top-level Worker deployment dry run; and
- the contained staging configuration and deployment dry run.

`npm run product:ui:test` passed all 28 consumer contract and UI tests.

The laboratory itself provided the live HTTP, persistence, restart, direct D1,
privacy-canary, aggregate, and rendered-browser evidence that the isolated test
suites do not provide alone.

The destructive invite-only HTTP smoke was then repeated against a second
fresh database after the privacy-canary change. It passed the complete
enrollment, encrypted upload, idempotent replay, private read, aggregate
publication, recovery rotation, security reset, logout, contribution deletion,
aggregate withdrawal and revisioned rebuild, and 20-participant deletion
journey. Direct post-smoke inspection found:

- zero active or deleting participants;
- zero accepted contributions;
- zero canonical records and contribution-occurrence rows;
- zero retained quarantine references;
- zero active sessions and devices;
- zero live local R2 objects;
- two withdrawn historical snapshot revisions and one final
  privacy-suppressed revision; and
- 20 digest-only deletion tombstones in the independent deletion ledger.

## Supported testing boundary

The backend can now be tested locally in three complementary ways:

1. `npm run product:backend:test` for isolated Worker integration tests;
2. the destructive invite-only HTTP smoke for upload, recovery, security reset,
   contribution deletion, aggregate withdrawal/rebuild, participant deletion,
   D1 cleanup, and R2 cleanup; and
3. `npm run product:backend:lab` for an inspectable seeded database and rendered
   individual/community portal.

The laboratory retains its disposable state on shutdown so the operator can
inspect it. That exact directory must be moved to Trash after use because it
contains development credentials and encrypted objects.

## Remaining gates

- The Cloudflare account still has no enabled R2 staging resource.
- Named staging D1/R2 resources, secrets, migrations, contained deployment, and
  HTTPS browser QA remain uncompleted.
- External participant collection remains disabled and unauthorized.
- The server accepts only closed privacy-safe contribution contracts; the
  participant-side packaged installer and clean-machine distribution route
  remain separate work.
- Production backup, restore, alerting, key rotation, abuse response, privacy
  review, and pilot consent are not established by this local proof.
