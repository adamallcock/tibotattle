---
title: G3 Invite Admission and Abuse-Control Plan
date: 2026-07-25
type: plan
status: implemented-development
---

# G3 Invite Admission and Abuse-Control Plan

## Decision

The next production dependency is bounded invite admission, not background
upload or public aggregation. The functional local Worker currently permits
anonymous development enrollment. If exposed publicly, one actor could create
unlimited participants, consume D1/R2 resources, and manufacture the three
participant identities needed to unsuppress development community results.

The Worker therefore remains unrouted. This slice adds a production-shaped,
single-use invitation boundary while retaining a clearly labelled
`local_open` mode for loopback testing.

This is progress toward G3, not a G3 pass. Short-lived HttpOnly web sessions,
device-scoped upload credentials, complete recovery/rotation/revocation UX,
operator/jurisdiction approval, and independent review remain required before
real participant upload.

## Threats addressed

- unlimited anonymous enrollment;
- invite replay and concurrent double redemption;
- expired or fabricated invitations;
- brute-force pressure against enrollment and recovery;
- local-development participants being counted as independent pilot
  eligibility units;
- invitation or eligibility secrets entering logs, responses, exports, or
  public aggregates; and
- accidental production startup with open or missing admission configuration.

## Contract

### Enrollment modes

- `local_open`: development-only compatibility mode. No invitation is required,
  and resulting participants are ineligible for invite-only aggregate counts.
- `invite_only`: enrollment requires one active, unexpired, single-use grant.
- `disabled`: no new participant can enroll.

Unknown or absent production-like configuration fails closed. No route or
public deployment is added by this slice.

### Invitation grants

- The operator creates a random invitation capability locally.
- The human-facing capability contains a random identifier and at least 256
  bits of independent secret material.
- D1 stores only a domain-separated digest, expiry, state, and a separate opaque
  eligibility-unit identifier.
- Successful enrollment atomically links one participant to that eligibility
  unit and consumes the grant.
- Invalid, missing, expired, malformed, and replayed grants create no
  participant and return fixed non-reflective error codes.
- Invitation values and eligibility-unit identifiers are absent from logs,
  participant exports, contribution objects, personal results, and aggregate
  output.

### Attempt limits

The development Worker uses separate fixed-window enrollment and recovery
bindings, each with one explicit shared global key. No client IP, network
identifier, invitation identifier, or recovery identifier is persisted by the
application. This deliberately simple global bound limits work but is neither
participant-fair nor availability-safe; one actor can consume the shared
window. Rate-limit responses contain no credential or database detail.

An edge admission layer remains required before production exposure so invalid
traffic can be rejected before D1/cryptographic work.

### Aggregate eligibility

When the service runs in `invite_only`, community participant counts, totals,
and slices include only participants linked to independently issued eligibility
units. `local_open` participants cannot raise the invite-only threshold.

The current minimum of three is a development suppression test, not a public
research threshold. G8/G9 must set the real independence threshold,
contribution clipping, dominance limits, complementary suppression, and filter
lattice.

## Operator flow

The local grant-issuance command must:

1. generate the invitation with a cryptographically secure generator;
2. write only its digest and bounded metadata to local D1;
3. either display the invitation once in the terminal or, when explicitly
   requested, place it in a new owner-only no-clobber file for immediate use;
4. never write the plaintext invitation to Git, application logs, or a durable
   receipt; and
5. require a separate explicit production command and approval before any
   remote write is supported.

## Test matrix

- Local-open enrollment remains compatible and produces no eligibility unit.
- Invite-only enrollment rejects missing, malformed, invalid, expired, and
  replayed grants.
- Two concurrent redemptions of one valid grant create exactly one participant.
- Failed admission leaves participant, grant, and aggregate state consistent.
- Enrollment and recovery paths call their separate limit bindings and honor
  allow/deny decisions without persisting client identifiers. The exact
  platform boundary and window recovery remain a pre-pilot HTTP drill.
- Errors and captured logs contain no invitation, recovery capability,
  eligibility identifier, hash, or arbitrary thrown value.
- Three local-open participants cannot unsuppress invite-only community output.
- Three distinct redeemed eligibility units can satisfy the development
  threshold without exposing their identifiers.
- Participant export and complete deletion omit and remove the private
  eligibility relation as documented.
- Disabled and invalid deployment modes fail closed.

## Exit from this slice

This development slice is complete when its implementation and adversarial
tests pass against local D1/R2 emulation, the consumer UI accepts an invitation
without persisting it, the risk/traceability documents describe the actual
development-versus-production boundary, and the Worker remains undeployed.
The platform boundary/window drill is intentionally retained as a production
gate below.

## Still blocking G3/G4

- replace browser `sessionStorage` bearer access with short-lived Secure,
  HttpOnly, SameSite personal-web sessions;
- separate access, recovery, upload, device, pairing, and notification
  capabilities with rotate/revoke flows;
- freeze a successor upload-capable telemetry/consent contract;
- add edge rate limiting and production environment/IaC separation;
- implement envelope-key rotation and retired-key handling;
- define retention, backup, deletion tombstones, restore suppression, and
  aggregate rebuild behavior;
- add enrollment/upload/processing kill switches and incident drills;
- complete consent, operator, jurisdiction, processor, and contact decisions;
  and
- complete the required targeted external privacy/security review.

## Verified development checkpoint

Implemented on 2026-07-25 without a deployment or route:

- explicit fail-closed `local_open`, `invite_only`, and `disabled` modes;
- 256-bit one-time invitation capabilities stored only as
  domain-separated hashes;
- atomic D1 invitation redemption and opaque eligibility relations;
- fixed invalid/expired/replay responses with no failed participant creation;
- separate enrollment/recovery attempt-limit bindings without application IP
  retention;
- invite-only aggregate filtering that excludes local-open participants;
- a password-style browser invitation field cleared immediately after the
  enrollment attempt and never saved in session storage;
- owner-only local invitation issuance; and
- a repeatable HTTP smoke using a real prepared contribution file.

The issuer is deliberately local-only: `--remote` fails before Wrangler is
invoked. A no-clobber owner-only output file is reserved and synced before its
matching local grant is inserted.

The fresh HTTP smoke accepted 200 records (99 usage and 101 quota), recognized
an encrypted replay, returned participant and suppressed-community results,
exported one content-free contribution, deleted the participant, rejected the
old capability with `401`, and left zero participant, contribution, telemetry,
eligibility, and R2 object rows. See the
[verification receipt](./2026-07-25-g3-invite-admission-verification-receipt.md).

The current Rate Limit bindings use a shared global key so the development
service retains no client network identifier. This bounds work but is not a
participant-fair production defense and can be used for denial of service.
Production still requires an edge strategy with a reviewed privacy/availability
tradeoff and an exact boundary/recovery-window drill.
