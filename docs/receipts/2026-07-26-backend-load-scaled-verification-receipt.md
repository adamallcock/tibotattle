---
title: Backend Load Scaled Verification Receipt
date: 2026-07-26
type: verification
status: verified-scaled
---

# Backend load scaled verification

## Outcome

The production-shaped Worker now has an executable, loopback-only load harness
that exercises real client encryption, HTTP authorization, D1/R2 processing,
deduplication, private results, disclosure-controlled aggregation, and
deletion. The representative scaled run passed. This is not the literal
1,000-user capacity gate and does not authorize cloud deployment or external
participants.

## Full-profile contract

The checked profile derives the literal workload from current transport and
participant ceilings:

```json
{
  "participants": 1000,
  "attemptsPerParticipant": 100,
  "recordsPerAttempt": 200,
  "bundleAttempts": 100000,
  "expandedRecords": 20000000,
  "enrollmentSpacingMilliseconds": 3100,
  "minimumEnrollmentDurationMilliseconds": 3096900
}
```

The 20-million-record requirement cannot be met by only 10,000 current-format
bundles. It requires 100,000 maximum-size bundles. The runner rejects a literal
full-profile execution without `--allow-full-profile`.

The current enrollment binding permits twenty global attempts per sixty
seconds. A same-origin 100-participant probe correctly reached `429` after the
first twenty admissions. The final runner therefore separates enrollment from
active-user load and rejects more than twenty participants unless enrollment
is paced by at least 3.1 seconds. A literal 1,000-user run has at least
3,096,900 milliseconds of admission setup before the concurrent workload.

## Privacy and eligibility findings

A local-open aggregate probe accepted and deleted twenty maximum-size
contributions but correctly produced a suppressed snapshot. This was not a
capacity defect: local-open development participants intentionally have no
independently issued eligibility units and cannot satisfy the public threshold.

The final runner requires exactly one owner-only invitation file per
participant whenever aggregate evidence is requested. It reads those files
without following symlinks, rejects non-regular or non-owner-only files, never
prints their values, and verifies that the Worker is in `invite_only` mode.

The emitted receipt contains only aggregate counters, fixed failure codes,
latency summaries, workload dimensions, and closed privacy assertions. It
contains no participant identifiers, cookies, CSRF values, recovery codes,
upload authorities, ciphertext, event identifiers, or response bodies.

## Passing real-HTTP run

The final run used a fresh migrated Worker state and:

- 20 independently invited participants;
- 160 short-lived upload registrations and encrypted uploads;
- 4 normal attempts per participant;
- 20 attempts for each of 5 hot participants;
- 200 records per attempt, the current contribution ceiling;
- 32,000 expanded records;
- 4,000 accepted canonical records;
- 28,000 deliberately deduplicated records; and
- concurrency 10.

The aggregate-only receipt reported:

```json
{
  "status": "passed",
  "bundleAttempts": 160,
  "expandedRecords": 32000,
  "acceptedRecords": 4000,
  "deduplicatedRecords": 28000,
  "bundleAttemptsPerSecond": 10.094,
  "expandedRecordsPerSecond": 2018.731,
  "uploadMedianMs": 569.661,
  "uploadP95Ms": 1017.278,
  "uploadMaximumMs": 1075.025,
  "privateResultsP95Ms": 349.346,
  "deletionP95Ms": 761.48
}
```

The first scheduled snapshot was `published` at revision 1. Deleting two
participants withdrew it and produced a privacy-suppressed revision 2 because
only eighteen independent eligibility units remained. Deleting the remaining
participants produced privacy-suppressed revision 3.

## Deletion verification

After the runner completed, direct local D1 inspection returned zero:

- participants;
- telemetry contributions;
- canonical telemetry records;
- contribution-occurrence links;
- web sessions; and
- participant-to-eligibility links.

The Miniflare R2 object table also contained zero encrypted quarantine objects.
The immutable aggregate ledger retained revision 1 as withdrawn, revision 2 as
withdrawn, and revision 3 as the current suppressed artifact, matching the
documented project-controlled publication history.

All disposable D1, R2, invitation, session, and receipt state was moved to
macOS Trash after the Worker stopped. It remains locally recoverable and was
not committed or uploaded.

## Automated evidence

The load-profile tests prove:

- exact 1,000-user arithmetic;
- explicit full-run opt-in;
- participant, attempt, record, concurrency, timeout, and pacing ceilings;
- hot-participant accounting;
- loopback-only HTTP;
- deterministic nearest-rank latency summaries;
- bounded concurrency; and
- a network-free profile inspection command.

The encompassing product checks passed:

- 27 browser/data-boundary tests;
- 33 local companion, prepared-set, queue, and device tests;
- 13 Worker operational-script tests, including 10 load-profile tests;
- 65 Cloudflare-runtime Worker tests;
- generated Worker type verification and TypeScript checking; and
- a Worker deployment dry run with no deployment.

The full product check remains the encompassing code gate. The literal
1,000-user/100,000-bundle run, 30-day soak, distributed admission behavior,
Cloudflare production resource metrics and cost, decompression attacks, and
named-human release approval remain open.
