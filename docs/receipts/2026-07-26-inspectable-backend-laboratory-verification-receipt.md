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

## Fresh product rerun

The laboratory was repeated from a new empty state at
`2026-07-26T23:08:14Z`. The live portal remained available on loopback after
the following results were independently observed:

- 20 anonymous participants enrolled through the invite-only HTTP path;
- 20 encrypted contributions accepted;
- 40 canonical D1 records and 40 contribution-occurrence mappings retained;
- 20 encrypted R2 quarantine objects retained;
- one privacy-thresholded weekly snapshot published;
- the fixed forbidden-`prompt` canary rejected before canonical ingest; and
- one participant recovered in the browser with private server-repriced
  statistics, canonical contribution history, quarantine timing, and a
  private clipped-versus-public-rounded comparison.

The portal header now separates `Backend ready` from `Companion offline` and
provides a direct Backend navigation target. A missing loopback collector can
therefore no longer visually imply that the central service, database, or
participant result APIs are unavailable.

The complete product check passed in the same source state: 28 consumer
contract tests, 41 loopback companion and foreground-delivery tests, 30
operator-script tests, 65 Cloudflare-runtime Worker tests, generated type and
TypeScript checks, and both development and contained-staging deployment dry
runs. No deployment occurred.

## UTC-week-boundary rerun and corrected retention invariant

A third clean laboratory run completed at approximately
`2026-07-27T01:25:00Z`, after the source usage event crossed into a new UTC
week. It again enrolled 20 participants through the invite-only HTTP route,
accepted 20 encrypted contributions, stored 40 canonical records, published
one delayed privacy-safe snapshot, rejected the forbidden-content canary, and
restarted against the same D1 state.

This run exposed an incorrect laboratory assertion. Publishing the weekly
snapshot advances the scheduled clock to the fixed post-week ingestion cutoff.
For an event near the beginning of its UTC week, that clock is more than seven
days after contribution receipt. The retention lifecycle therefore correctly
deleted all 20 encrypted R2 objects and marked all 20 canonical quarantine
references as deleted while preserving the accepted canonical metadata and
personal results.

The laboratory had incorrectly required the live R2 count to equal the number
of accepted contributions. It now requires the live R2 count to equal the
canonical references still marked as retained. The current rerun passed with:

| Measure | Count |
|---|---:|
| Active participants | 20 |
| Accepted contributions | 20 |
| Canonical records | 40 |
| Contribution occurrences | 40 |
| Retained quarantine references | 0 |
| Direct local R2 objects | 0 |
| Published community snapshots | 1 |
| Deletion tombstones | 0 |

The portal showed the retained canonical contribution as accepted, displayed
its encrypted object as deleted, and still returned the participant's private
server-repriced result. The README now distinguishes accepted canonical data
from the temporary encrypted quarantine.

The same verification pass found that an operator could let Wrangler create a
new persistence directory with group/world-readable mode before the
privacy-safe inspector rejected it. The migration wrapper now creates a new
state directory as mode `0700` and refuses existing directories that are
symlinks, non-directories, or group/world readable. The operator-script test
proves both safe creation and fail-closed refusal.

The destructive second-state HTTP smoke independently completed the full
upload, deduplication, private read, aggregate publication, contribution
withdrawal, revisioned aggregate rebuild, and 20-participant deletion journey.
Its final direct state was zero active participants, contributions, canonical
records, sessions, devices, retained quarantine references, and R2 objects,
with 20 digest-only deletion tombstones.

## Current rendered product verification

The central Worker portal was loaded against the retained 20-participant
laboratory state. Anonymous users saw connected D1, the independent deletion
ledger, reachable encrypted quarantine, operational invite-only collection,
and the released clipped/rounded community snapshot. Recovering the seeded
participant through the owner-only capability displayed one safe usage event,
one quota snapshot, `$0.0032` of server-repriced API-price-equivalent usage,
100% pricing coverage, canonical contribution history, the deleted-quarantine
state, and the private clipped-versus-public-rounded comparison.

The loopback companion was then started against that public backend. It loaded
the real retained local monitoring artifacts, exposed both locally observed
account windows without account identifiers, rendered 823 matched rolling
windows and 14 qualifying weekly reset series, and showed the public central
snapshot alongside the local analysis. Its real foreground refresh completed
in under the one-minute UI timeout and advanced the latest local observation
from `2026-07-26T08:30:00Z` to approximately
`2026-07-27T01:29:00Z`; the header changed from stale to live without sending
raw logs to the central service.

The complete product gate passed after the fixes:

- 28 browser/UI contract tests;
- 41 local companion, prepared-set, and foreground-delivery tests;
- 30 operator-script checks;
- 65 Cloudflare-runtime Worker tests;
- generated Worker type and TypeScript checks; and
- development and contained-staging deployment dry runs.

No external deployment, enrollment, or data transfer occurred.

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
