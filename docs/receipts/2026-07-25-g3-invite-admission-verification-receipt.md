---
title: G3 Invite Admission Verification Receipt
date: 2026-07-25
type: verification
status: passed-development
---

# G3 Invite Admission Verification Receipt

## Scope and decision

This receipt verifies a local development admission and backend lifecycle
slice. It does not pass G3/G4, authorize volunteers, create a public route, or
deploy a Worker.

The verified path is:

1. migrate a fresh isolated local D1 state through migration 0003;
2. issue one 256-bit, hash-only, expiring invitation into that state;
3. start the Worker on `127.0.0.1` with `invite_only`;
4. read a mode-0600 prepared `telemetry-contribution-v0.1` file;
5. enroll, encrypt, upload, ingest, replay, inspect, export, and delete over
   HTTP; and
6. inspect local D1/R2 state after deletion.

## Automated evidence

`npm run product:check` passed:

- 17/17 browser/UI contract tests;
- 10/10 local companion and contribution-builder tests;
- generated Worker types current;
- TypeScript clean;
- 16/16 Cloudflare-runtime Worker tests; and
- Worker deployment dry run with D1, R2, Assets, enrollment Rate Limit, and
  recovery Rate Limit bindings.

The Worker tests cover:

- disabled, absent, invalid, and production-open configurations failing closed;
- missing, malformed, expired, replayed, and concurrently redeemed invitations;
- no participant creation on failed admission;
- fixed non-reflective errors and canary-free captured warnings;
- bounded enrollment and recovery attempts without application IP storage;
- local-open identities not counting toward invite-only aggregation;
- three distinct eligibility units satisfying only the development threshold;
- eligibility/grant values absent from personal export and community output;
- participant isolation, replay, deletion, and retained-object cleanup; and
- percent-encoded contribution resource IDs used by the browser client.

The local operator smoke also proved that an existing invitation output file
is not overwritten and creates no second grant, and that `--remote` is rejected
before any D1 command. The issuer reserves and syncs an owner-only output file
before creating the matching local grant; remote issuance is not implemented.

## Fresh HTTP result

The loopback smoke command returned:

| Check | Result |
|---|---:|
| Enrollment mode | `invite_only` |
| Accepted records | 200 |
| Usage events in personal statistics | 99 |
| Quota snapshots in personal statistics | 101 |
| Encrypted replay | recognized |
| Community output | suppressed at one eligible participant |
| Participant export | one content-free contribution |
| Participant deletion | passed |
| Old access capability after deletion | HTTP 401 |

Direct post-deletion D1 inspection returned zero:

- participants;
- telemetry contributions;
- telemetry records; and
- participant eligibility relations.

Direct local R2 inspection returned zero retained objects. The isolated
temporary state and its invitation files were then deleted; that temporary
state is not recoverable through this project.

## Defect found by the HTTP smoke

The first smoke exposed a real client/server integration defect: the browser
correctly percent-encoded `contribution:<uuid>` in a path, while the Worker and
loopback relay matched only a literal colon. Both now decode one bounded path
segment, validate the exact contribution-ID grammar, and have regression
coverage for the browser-produced URL.

The smoke also verifies the actual response shape (`recordCounts` and
`replayed`) instead of relying on an assumed contract.

The final security audit additionally found and closed:

- request-failure logs previously included raw URL paths; they now contain only
  a fixed route-class enum, with path and authorization canary coverage;
- malformed stored invitation expiry text could bypass a `NaN` comparison; the
  repository now requires a canonical future ISO instant and tests corrupted
  D1 state; and
- the first smoke checked status only; it now asserts input-derived record
  counts, replay identity, contribution detail, personal totals, suppressed
  invite-only cohort state, participant export contents, deletion counts, and
  credential invalidation before printing `passed`.

## Privacy evidence

- Invitation, access, recovery, participant, contribution, and eligibility
  values were not printed in the smoke summary or this receipt.
- The invitation was held in a mode-0600 temporary file and deleted after use.
- The contribution was already a closed privacy-safe projection; the smoke
  revalidated it before encryption.
- The Worker revalidated the decrypted plaintext and retained only an opaque
  encrypted R2 envelope plus closed D1 metadata.
- No remote command, public route, external model, or third-party upload was
  used.

## Residual blockers

This is not production-ready. At minimum, G3/G4 still require:

- short-lived Secure, HttpOnly, SameSite personal-web sessions instead of a
  browser-stored bearer;
- separated device/upload/pairing/notification capabilities and complete
  revoke/rotation UX;
- a frozen upload-capable telemetry and consent version;
- participant-fair edge abuse controls and a measured boundary/recovery drill;
- production key rotation and retired-key behavior;
- retention, deletion tombstones, backup restore suppression, and aggregate
  rebuild;
- independent kill switches, alerts, budgets, and incident drills;
- named backup incident ownership and operator/jurisdiction/processor/contact
  decisions; and
- targeted external privacy/security review.
