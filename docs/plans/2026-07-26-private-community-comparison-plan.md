---
title: Private Community Comparison Plan
date: 2026-07-26
type: plan
status: verified-local
---

# Private community comparison

## Outcome

Give an authenticated participant a useful, same-period comparison between
their own contribution and a released privacy-safe weekly community snapshot.
The comparison must reuse the exact publication period, cutoff, eligibility,
model normalization, and clipping rules without exposing a cohort count,
average, percentile, suppressed total, or another participant's row.

## Current gap

The central portal renders private participant totals and the delayed public
community snapshot as separate panels. A participant can see both, but the
private totals cover all retained time while the public snapshot covers one
fixed week. Comparing them directly would be invalid, and the product currently
does not provide a valid alternative.

## Safety contract

1. The comparison is returned only inside the authenticated participant
   statistics response.
2. It uses the exact active published snapshot revision and its fixed period
   and ingestion cutoff.
3. Participant values are restricted to accepted contributions that were
   eligible for that snapshot and are clipped using the same per-cell caps.
4. Community values are copied only from already released metrics in the
   immutable public payload.
5. Suppressed community metrics never gain a derived value in the private
   comparison.
6. No participant count, average, percentile, threshold distance, eligibility
   identifier, account track, pseudonym, or contribution identifier is added.
7. The UI explicitly says the comparison is not an average, percentile, bill,
   or provider allowance.
8. A withdrawn, suppressed, malformed, or unavailable snapshot produces a
   fixed not-testable result.

## Implementation

- Add a bounded `participant-community-comparison-v0.1` projection beside the
  existing `participant-stats-v0.2` response.
- Reuse the public snapshot's provider/model cells and fixed metric vocabulary.
- Compute each participant value from canonical D1 records using the same
  period, cutoff, active-participant, accepted-contribution, and invite
  eligibility predicates as the aggregate builder.
- Normalize unknown models into the same public `unknown` bucket.
- Render a compact comparison table in the private participant panel with clear
  clipped-versus-rounded labels and honest unavailable states.

## Verification

- A 20-participant snapshot exposes the authenticated participant's clipped
  value beside the released rounded total.
- The public snapshot bytes and schema remain unchanged.
- A suppressed public metric remains unavailable in the private comparison.
- Contribution deletion immediately changes the comparison to not testable
  when the active snapshot is withdrawn.
- Cross-tenant and unauthenticated requests cannot read the comparison.
- Browser normalization rejects malformed cells and unknown fields by
  projection.
- The live encrypted HTTP smoke and rendered portal QA pass.

## Release boundary

This is a local production-shaped G8 product slice. It does not authorize
external participants, public deployment, or G9 aggregate release.

## Result

Implemented and verified locally on July 26, 2026. The authenticated
`participant-stats-v0.2` response now includes the bounded comparison, the
portal renders it without viewport overflow, and the 20-participant encrypted
HTTP smoke proves both its released and post-withdrawal states. The public
snapshot contract and bytes remain unchanged.
