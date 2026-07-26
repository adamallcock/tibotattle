---
title: Private Community Comparison Verification Receipt
date: 2026-07-26
type: verification
status: passed-local
---

# Private community comparison verification receipt

## Scope

This receipt verifies a local production-shaped participant result: an
authenticated participant can compare their own clipped contribution for one
released week with the already-public rounded community total for that same
week. It does not authorize external participants, cloud deployment, or public
aggregate release.

## Privacy and interpretation contract

- The result is nested only in authenticated `participant-stats-v0.2`.
- It reuses the active immutable snapshot's period, ingestion cutoff,
  eligibility predicates, model normalization, and clipping caps.
- Community values are copied only from metrics already present in the public
  snapshot.
- A suppressed metric exposes neither a public total nor a participant value.
- No cohort count, average, percentile, threshold distance, eligibility
  identifier, account track, share, bill, or allowance conversion is returned.
- Withdrawn, suppressed, malformed, and unavailable snapshots fail closed as
  not testable.

## Automated verification

The Worker runtime test creates twenty independently invited participants,
publishes a weekly snapshot, authenticates one participant, and verifies:

- one private usage event beside twenty public rounded events;
- private clipped token/tool components beside released rounded totals;
- a private cache-read value of `900` beside public rounded `0`, without
  calculating a share;
- a suppressed reasoning metric remains unreleased in both columns;
- forbidden cohort, account, average, and percentile fields are absent; and
- contribution deletion synchronously withdraws the snapshot and changes the
  private comparison to not testable.

Browser contract tests reject malformed or negative comparison values, project
away unknown fields, cap the response at 100 cells, and verify the explanatory
language in the participant portal.

The complete product check passed 26 browser/UI tests, 33 local
companion/transport/queue tests, 65 Worker runtime tests, generated Worker type
verification, TypeScript, script checks, and the Worker deployment dry run.
The broad serial root suite passed 863 of 865 tests. Its only two failures were
the retained source-bound R7 release receipts, whose workload provenance hash
and file count intentionally become stale when product source changes. They
were not regenerated or weakened here; the exact-runtime R7 regeneration
workflow remains a separate release checkpoint.

## Real loopback HTTP verification

A fresh isolated Wrangler D1/R2 state was migrated, twenty one-use invitation
grants were issued, and the generated content-free fixture was encrypted and
submitted through the real HTTP routes for every participant. The smoke
verified:

```json
{
  "status": "passed",
  "participants": 20,
  "authenticatedWeeklyComparison": true,
  "comparisonAvoidsAverageAndPercentile": true,
  "aggregatePublishedAtTwenty": true,
  "aggregateWithdrawnOnContributionDeletion": true,
  "aggregateRebuiltAfterDeletion": true,
  "aggregateFinalRevision": 3,
  "participantsDeleted": 20
}
```

The same smoke covered session/CSRF isolation, one-use upload authorization,
client envelope encryption, strict server validation, deduplication, private
statistics, participant export, recovery rotation, device pairing/revocation,
security reset, logout, deletion, and revisioned aggregate rebuilding.

## Final database evidence

After the Worker stopped, a direct read-only SQLite inspection found three
immutable revisions:

| Revision | State | Source mutation epoch | Payload bytes |
|---:|---|---:|---:|
| 1 | withdrawn | 0 | 1,429 |
| 2 | withdrawn | 1 | 795 |
| 3 | suppressed | 21 | 795 |

The same inspection found zero pending rebuilds, participants, telemetry
contributions, and telemetry records. The isolated state directory, including
the one-use local invitation files, was then moved to the user's Trash and is
recoverable until the Trash is emptied.

## Rendered portal verification

The portal was served from the same loopback Worker and reviewed in the in-app
browser with fixed local API fixtures matching the live-tested contracts. The
rendered private table showed all five columns, including the interpretation
column, at the desktop viewport without page-level horizontal overflow. It
visibly distinguished:

- private clipped values from public rounded totals;
- public zero caused by coarse rounding from a meaningful participant share;
- a suppressed metric as `Not shown` / `Not released`; and
- the result from an average, percentile, bill, or provider allowance.

This fixture-based rendered check verifies presentation only; the separate
encrypted HTTP smoke above verifies the backend data flow.

## Residual risks and release boundary

- The live proof uses local Wrangler, D1, and R2 rather than deployed cloud
  infrastructure.
- Secure-cookie behavior still needs a staged same-origin HTTPS browser pass.
- Mobile and cross-browser interaction, accessibility review, load/soak, abuse
  controls, and disclosure attack review remain open.
- No G9 named-human approval or external security/privacy review has occurred.
- Public deployment and external participant enrollment remain disabled.
