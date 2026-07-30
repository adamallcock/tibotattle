---
title: Participant-Scoped Account Track Transport Minimization Decision
date: 2026-07-26
type: decision-record
status: implementation-disabled
---

# Participant-scoped account track transport minimization decision

## Decision

Do not enable account-continuity upload or account-specific server calibration
yet.

The minimum technically credible central design is now specified, but the
existing frozen minimization decision remains inconclusive. The current local
evidence contains no three completed prospective account/provider/plan-scoped
reset windows, and transported usage events do not yet carry defensible account
scope. Enabling only quota scope would therefore make the product look more
precise while still allowing cost from one account to be assigned to quota from
another.

Implementation may proceed behind a disabled `v0.2` contract and renewed
consent boundary. Production acceptance, real participant solicitation, and
numeric account-specific calibration remain prohibited until the prospective
evidence and verification gates in this record pass.

## Why a track is needed

The participant may switch between multiple provider accounts. One exported
bundle can span such a switch. The server currently receives neither account
scope on quota snapshots nor account scope on usage events, so its correct
behavior is:

```text
account_continuity_not_transmitted
```

This cannot safely be replaced with a contribution-level flag. Every quota
snapshot and every usage event used in its cost interval must carry the same
private track. Unattributed events remain unallocated and cannot be assigned to
the nearest quota track.

## Rejected designs

The following are rejected:

1. Uploading `openai-account:v1:*` directly. It is stable at the local
   observation layer and would permit unnecessary linkage.
2. Uploading the local export `account:v1:*` value directly. It is stable across
   exports and central re-enrollment while the local export identity remains
   unchanged.
3. Hashing either local value without a central-participant scope. A plain hash
   preserves cross-enrollment linkability.
4. Sending the local value to the Worker and transforming it there. The
   linkable local pseudonym would already exist in decrypted plaintext and the
   retained encrypted envelope.
5. Putting one track on the whole contribution. A contribution may contain an
   account switch.
6. Tracking only quota snapshots. Account-specific cost-to-quota conversion
   also requires account-scoped usage events.
7. Treating provider account scope as authentication, eligibility, unique-human
   proof, or anti-Sybil evidence. It proves none of those things.

## Candidate `v0.2` derivation

The client derives a third, domain-separated pseudonym before envelope
encryption:

```text
deriveAccountTrackId(localAccountScopeId, centralParticipantId, provider)
```

Inputs:

- `localAccountScopeId` must be `unattributed` or
  `account:v1:<64 lowercase hex>`;
- `centralParticipantId` must be the canonical anonymous central participant
  identifier returned during enrollment; it is an identifier, not an
  authentication capability; and
- `provider` must be a reviewed provider enum.

For an attributed scope, decode the 32-byte local digest and use the existing
export pseudonym HKDF/HMAC framing with:

```text
prefix: account-track
subject: provider + NUL + centralParticipantId
```

The only transported forms are:

```text
unattributed
account-track:v1:<64 lowercase hex>
```

The same local account produces a different track for a different central
participant, provider, export identity, account-observation secret, or device.
It remains stable across upload batches, logout, recovery, and security reset
for one central participant. Re-enrollment changes the central scope and breaks
the link.

The local account scope and the central track are telemetry partition keys only.
Neither may authorize a server operation.

## Contract boundary

Do not mutate the existing local or transport `v0.1` contract in place. Create a
new closed contract family:

- `telemetry-contribution-v0.2`;
- `privacy-safe-telemetry-v0.2`;
- `usage-event-v0.2`;
- `quota-snapshot-v0.2`;
- `export-activity-marker-v0.2`; and
- `telemetry-envelope-v0.2`.

Every transported usage, quota, and activity record contains an
`accountTrackId`. Legacy `v0.1` data is treated as `unattributed`. Existing
participants retain export and deletion access, but cannot upload `v0.2`
without accepting the new consent text.

The contribution builder requires the central participant identifier explicitly
and must prove that serialized output contains no `accountScopeId`,
`sessionScopeId`, raw account subject, email, provider account ID, or
authentication capability.

## Consent disclosure

The renewed consent must say, in plain language, that:

- a device-derived pseudonymous account track is uploaded;
- it links only records for the same provider account inside that anonymous
  participant;
- it survives logout, account recovery, and security reset;
- it changes after central re-enrollment or local export-identity rotation;
- it does not provide cross-device continuity;
- it is used only for private calibration and integrity checks;
- it is never included in community output; and
- it is deleted with the participant's central data.

Deleting local bundles alone does not rotate the local export identity. The
local UI must disclose that separately and retain the existing explicit
identity-rotation control.

## Server partition and query contract

Server analysis must partition by:

```text
participant
+ account track
+ provider
+ plan type and variant
+ limit
+ window duration
+ provider policy epoch
```

The exact reset timestamp adds the reset-group boundary. Slot is observation
metadata, not the semantic identity of a five-hour or seven-day window, because
a provider may move a duration between primary and secondary.

Usage assigned to a quota interval must match the same participant, track,
provider, compatible billing/shared-pool surface, and policy epoch. The server
must emit an explicit `account_scoped_usage_unavailable` result if quota is
tracked but usage is not. Unattributed usage is reported as unallocated cost and
never silently pooled.

The upload-set contract must also identify a complete dataset, immutable covered
interval, part index and count, and known source gaps. A partial set is useful
for general cost totals but not eligible for a calibrated allowance estimate.

## Initial private calibration policy

One framework-free estimator must serve both 300-minute and 10,080-minute
windows:

1. Build reset evidence only within one full partition.
2. Refuse stale receipts over five minutes, backward movement, ambiguous reset
   identity, conflicting simultaneous slot observations, incomplete upload
   sets, unattributed usage, mixed policy epochs, or non-fully-priced scored
   intervals.
3. Keep only positive displayed movement with positive canonical server-priced
   usage.
4. Require at least eight unique quota boundaries and five displayed percentage
   points.
5. Fit on the earlier 70% and score the later 30%, with at least five training
   and two held-out points.
6. For a reset-start forecast, use only the median of up to three earlier
   completed resets on the same track, requiring at least two.
7. Use Standard API-price-equivalent cost initially. Codex Fast remains a
   separate observed dimension and never selects API Priority or an invented
   multiplier.
8. Build one-, two-, and three-hour comparisons only from real quota
   observations bracketing both endpoints, never across a reset.

Participant language is limited to:

- observed quota movement;
- expected movement from API-price-equivalent cost;
- estimate from earlier observed quota boundaries;
- within-reset sensitivity range; and
- historical forecast error.

No UI or API calls an empirical range a confidence interval, calls an API-price
equivalent the provider's rate card, or exposes the internal word `pairwise`.

## Uncertainty and result states

The private result states are:

- `conditional_estimate`;
- `descriptive_only`;
- `not_testable`; and
- `non_identifiable`.

Show a within-reset sensitivity range only as sensitivity. Show a middle-80%
range across completed resets only with at least three independent resets.
Show empirical 80th/90th-percentile absolute forecast error only from
no-look-ahead predictions. Any bootstrap operates on whole reset units and
remains unavailable below its sample gate.

## Threat model and privacy properties

The design protects against:

- accidental upload of raw account subjects or stable local pseudonyms;
- cross-participant and cross-re-enrollment linkage by the retained track;
- account pooling caused by time proximity;
- client-declared cost tampering;
- public disclosure of account tracks; and
- orphaned private derivatives after deletion.

It does not protect against:

- a participant deliberately creating multiple central identities;
- correlation using exact private timestamps combined with outside knowledge;
- a compromised client before minimization;
- missing usage on another device or shared agentic surface; or
- provider-side changes to quota accounting.

These limitations remain visible as coverage or contamination warnings rather
than being absorbed into a numeric estimate.

## Evidence gate

The frozen minimization decision still controls activation. The following are
required:

1. At least three newly completed prospective reset windows with usable
   provider/account/plan scope.
2. Account scope on both usage events and quota observations throughout the
   eligible intervals.
3. A deterministic minimization receipt with the reference primary metric
   available.
4. Every frozen identity, collision, partition, reset-assignment, component,
   contamination, determinism, and privacy gate passing.
5. Exact-versus-ablated equivalence within the registered 0.25-point absolute
   and 5% relative degradation bounds.
6. Renewed consent and a separate security/privacy review of the `v0.2`
   transport.

Synthetic fixtures can prove implementation correctness but cannot authorize
retaining the field.

## Implementation order

1. Continue prospective local collection and build an account-scoped,
   content-free transition evidence adapter.
2. Add adversarial account-switch, stale-marker, reset-boundary, duplicate,
   partial-set, and foreign-track fixtures.
3. Implement the pure participant-scoped derivation and frozen `v0.2` schemas
   behind a disabled feature gate.
4. Add D1 columns and participant/account predicates without making the result
   reachable from `v0.1`.
5. Extract shared duration-generic reset calibration and strict rolling
   comparison modules.
6. Prove local/Worker parity and complete deletion of all track-bearing and
   derived records.
7. Rerun the preregistered minimization after every completed eligible reset.
8. Only after all gates pass, activate renewed consent for an invite-only local
   pilot and perform real HTTP and rendered UI verification.

## Required verification

- Known derivation vectors and unlinkability across participant/provider/secret
  changes.
- Rejection of direct local scopes, malformed tracks, unknown fields, old
  consent, and mixed schema versions.
- Foreign-account insertion cannot change another account's result.
- `unattributed` usage cannot be assigned to an attributed quota track.
- Five-hour and seven-day fixtures exercise the same estimator.
- Future resets cannot change an earlier forecast.
- Partial or missing upload parts cannot produce calibrated results.
- Local and Worker outputs are byte-equivalent on frozen safe fixtures.
- Participant export includes only its restricted track; community APIs include
  none.
- Contribution and participant deletion remove track rows, derived calibration,
  and R2 envelopes while preserving required withdrawn public tombstones.

## Current status

Local collection can now obtain short-lived, prospective account scope from a
fresh app-server account marker, and recent safe collector rows demonstrate
that path. The first bounded real-data build examined 243,930 already
privacy-reduced collector records, accepted 10 account-scoped records, and
produced two account-partitioned weekly transitions for one local account
track. It rejected 243,916 unattributed records, four malformed records, two
non-movement observations, and three reset-boundary adjacencies without
retaining their values in the human receipt.

The deterministic preregistered rerun remains inconclusive: neither transition
belongs to a reset whose full 10,080-minute window began after the July 24
cutoff, so there are zero qualifying completed prospective resets. Its three
blockers remain insufficient completed resets, unavailable eligible holdout
scope, and unavailable reference primary metric. The historical transition
artifact remains unattributed. Therefore:

```text
candidate contract: specified
local evidence path: in implementation
transport: disabled
private account calibration: disabled
public account-derived aggregate: prohibited
```
