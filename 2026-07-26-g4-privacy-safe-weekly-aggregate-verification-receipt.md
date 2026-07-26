---
title: G4 Privacy-Safe Weekly Aggregate Verification Receipt
date: 2026-07-26
type: verification
status: passed-development
---

# Result

The local development backend now accepts encrypted, privacy-safe contribution
files, validates and ingests them into D1, retains opaque envelopes in R2,
computes participant-isolated statistics, and publishes only delayed immutable
weekly community snapshots. No route computes a live public aggregate.

This receipt does not authorize deployment or participant collection. The
Worker remains unrouted, preview URLs remain disabled, and no Cron trigger is
configured.

# Automated verification

`npm run product:check` passed:

- browser/UI contract: 18 tests;
- local companion and contribution materializer: 10 tests;
- Worker runtime: 27 tests;
- local grant command: 1 test;
- TypeScript and generated Worker types;
- script syntax checks; and
- Wrangler deployment dry run.

The Worker tests now cover:

- a fixed no-snapshot response with no cohort count;
- a sealed generic suppression response;
- the actual `scheduled()` entry point and its event time;
- concurrent builders producing one stored row;
- exact stored payload bytes and SHA-256;
- per-participant clipping above token and tool caps;
- exact-cutoff contribution exclusion;
- explicit zero as support and `null` as missing support;
- metric-level suppression;
- late source changes not changing sealed bytes;
- direct payload update/delete rejection;
- contribution deletion withdrawal;
- contribution R2 failure after the retryable D1 deletion transition;
- participant withdrawal before an injected R2 failure;
- withdrawn snapshots refusing republication; and
- the public path never falling back to the old live diagnostic.

# Real loopback HTTP verification

A fresh isolated local D1/R2 state was migrated through
`0005_community_weekly_snapshots.sql`. Twenty owner-only invitation files were
issued and redeemed without printing their contents.

The real HTTP smoke used one current, owner-only
`telemetry-contribution-v0.1` file per participant:

- participants: 20;
- accepted records per participant: 200;
- accepted records exercised: 4,000;
- idempotent replay: passed;
- personal statistics recomputation: passed;
- unavailable snapshot before scheduling: passed;
- scheduled weekly publication at K=20: passed;
- byte-identical public aliases: passed;
- contribution deletion and snapshot withdrawal: passed;
- cookie/upload authority separation: passed;
- recovery rotation and bounded retry: passed;
- security reset and pending-upload revocation: passed;
- logout cookie clearing: passed; and
- participant deletion cleanup: 20 of 20.

The scheduled event was invoked through Wrangler's documented local scheduled
handler with an explicit millisecond event time. No custom operator endpoint
was added.

# Post-deletion storage receipt

After the Worker stopped:

| Store | Retained count |
| --- | ---: |
| participants | 0 |
| telemetry contributions | 0 |
| telemetry records | 0 |
| web sessions | 0 |
| upload authorizations | 0 |
| recovery retry receipts | 0 |
| snapshot builders | 0 |
| weekly snapshot rows | 1 |
| withdrawn weekly snapshot rows | 1 |
| R2 blobs | 0 |

The one withdrawn row is an intentional immutable tombstone. Removing it would
permit the historical week to be rebuilt and compared after deletion.

# Rendered product QA

The Worker-served portal was inspected in the in-app browser using real local
API responses.

- Published state rendered the UTC week, cutoff, release time, fixed K=20
  disclosure, released metrics, and independently suppressed metrics.
- Withdrawn state returned no historical cells and rendered the withdrawal
  explanation.
- Desktop had no document-level horizontal overflow.
- A narrow mobile viewport had no document-level horizontal overflow; the
  wide metric table remained locally horizontally scrollable.
- Automated normalizer tests cover published, partial, suppressed, unavailable,
  withdrawn, legacy-unsafe, and unsupported-schema responses.

# Remaining G4 follow-ups

The development milestone is usable, but the parent plan remains in progress
until the less likely adversarial cases also have dedicated tests:

- deterministic bytes across different physical insertion orders;
- a controlled mutation injected between aggregation and finalization;
- candidate-cell overflow (currently unreachable with the reviewed
  provider/model vocabulary); and
- browser-driven rendering of every non-value state rather than normalizer
  coverage plus rendered published/withdrawn checks.

Production HTTPS, remote operator authorization, a real Cron schedule,
server-side historical repricing, retention operations, incident drills, and
external privacy/security review remain separate release gates.
