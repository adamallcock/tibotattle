---
title: G4 Privacy-Safe Weekly Aggregate Plan
date: 2026-07-26
type: plan
status: in_progress
---

# Outcome

Replace the live cumulative community diagnostic with a separate, immutable
weekly publication ledger. Public community reads must never execute aggregate
SQL over mutable participant telemetry.

This is a development and verification slice. The Worker remains unrouted,
external collection remains unauthorized, and completing this plan does not
authorize a participant pilot or public deployment.

# Threats closed by this slice

- polling a changing total to isolate one participant's contribution;
- allowing one high-volume participant to dominate a cohort;
- counting a participant as support for a metric they did not report;
- including a backdated upload after the fixed ingestion cutoff;
- revealing a suppressed cell by subtracting an exact total;
- rebuilding a historical week after deletion and exposing the removed delta;
- publishing from a mixed source view while deletion races the builder;
- allowing two builders to seal different payloads for one week; and
- silently falling back to the old live aggregate when no snapshot exists.

# Fixed pilot policy

- Policy version: `community-weekly-v0.1`.
- Window: non-overlapping Monday 00:00 UTC through Monday 00:00 UTC.
- Ingestion cutoff and release time: 48 hours after the window closes.
- Publication eligibility: invite-issued community eligibility only.
- Public minimum: 20 independent eligible participants, distinct from the
  three-participant development diagnostic threshold.
- Usage cell dimensions: provider and recognized model ID; unrecognized models
  share the literal `unknown` label and never expose their fingerprints.
- Per-participant, per-cell caps:
  - 1,000 usage events;
  - 5,000,000 tokens for each independently reported token component; and
  - 1,000 provider tool units.
- Rounding after clipping and cohort summation:
  - usage events down to a multiple of 10;
  - each token component down to a multiple of 100,000; and
  - tool units down to a multiple of 10.
- Client-declared API cost is excluded until server repricing exists.
- No exact participant count or exact metric support is published.
- No exact global total is published beside the cell breakdown.
- At most 100 released candidate cells. Exceeding that bound seals a suppressed
  snapshot rather than truncating an apparently exhaustive result.

# Storage and concurrency

## Mutation control

A singleton mutation epoch changes when participant or contribution deletion
first enters its retryable `deleting` state, before R2 removal can run. The
same database mutation:

- cancels active builders; and
- withdraws every published or suppressed snapshot.

Participant withdrawal happens when deletion first enters `deleting`, before
R2 removal. A failed object deletion therefore cannot leave a public snapshot
available.

## Builder leases

A bounded builder row holds an opaque owner nonce, captured mutation epoch, and
lease expiry. Only the current owner may finalize. A stale lease may be claimed
again because it has never been public.

Final publication succeeds only when:

- the owner and lease still match;
- the mutation epoch has not changed;
- the deterministic week has no sealed snapshot; and
- the canonical payload hash matches the bytes being stored.

Concurrent or repeated builders converge on the one stored payload. A
different payload for a sealed week is an error, not a replacement.

## Sealed snapshots

The final table stores the deterministic snapshot ID, week bounds, cutoff,
policy version, immutable payload JSON, payload SHA-256, release state, and
withdrawal metadata.

Database triggers:

- prohibit payload, policy, window, cutoff, release-time, and hash changes;
- prohibit deleting a sealed snapshot;
- allow only `published|suppressed` to `withdrawn`; and
- prohibit republishing the same historical week under another policy version.

# Source qualification

A record qualifies only when:

1. `observed_at` is inside `[window_start, window_end)`;
2. the participant has invite-issued community eligibility;
3. at least one surviving contribution occurrence links that logical record to
   a server-ingested contribution created before the fixed cutoff; and
4. the record is a usage event with a reviewed provider and either a reviewed
   model ID or the literal public `unknown` bucket.

The occurrence join is an `EXISTS`, not a direct join, so overlapping uploads
cannot multiply one canonical record.

# Public response

`GET /api/v1/stats/aggregate` and its existing alias read only the latest sealed
snapshot row.

- No row: fixed `stable_snapshot_unavailable` response.
- Sealed but not releasable: one generic stored `suppressed` response with no
  participant count, exact cause, or distance to threshold.
- Published: exact stored payload bytes, including policy, week, cutoff,
  clipping, rounding, and released/suppressed metric states.
- Withdrawn: fixed withdrawal response; the historical payload is not returned.

All responses remain `Cache-Control: no-store` during the pilot. The old live
query has no HTTP route.

# UI contract

The central panel becomes “Published weekly snapshot” and distinguishes:

- checking;
- no stable snapshot;
- suppressed without an exact cohort count;
- published or partially published;
- withdrawn;
- unsupported schema; and
- service unavailable.

The UI rejects the old
`development_diagnostic_not_publication_safe` response and never falls back to
the live alias after a missing snapshot endpoint.

# Operator path

The Worker implements a `scheduled()` handler using the scheduled event time.
No custom operator HTTP endpoint or remote publication command is added.
Local verification invokes the standard Wrangler scheduled-handler route.

The deployment configuration remains without a Cron trigger until a later
release gate approves remote operation. A future reviewed deployment can add a
daily UTC trigger without changing snapshot semantics.

# Verification

Automated tests must prove:

1. no snapshot returns a fixed body without participant count;
2. overall cohort support cannot release a metric supported by fewer than `k`;
3. explicit zero counts as reported support while `null` does not;
4. per-participant clipping occurs before cohort summation;
5. changes within one rounding bin produce byte-identical payloads;
6. insertion order does not affect bytes or hash;
7. cutoff boundaries and late ingestion behave exactly;
8. overlapping contribution occurrences do not duplicate a record;
9. concurrent builders converge on one sealed row;
10. a mutation race prevents finalization;
11. direct payload updates and sealed-row deletion fail;
12. contribution deletion withdraws snapshots atomically;
13. participant deletion withdraws before R2 retry;
14. withdrawn weeks cannot be republished under any policy version;
15. public payloads contain no participant, capability, eligibility, occurrence,
    fingerprint, raw record, exact support, or client-declared cost value;
16. invite-only/public paths cannot reach the live aggregate query; and
17. the browser renders every fixed state without exposing exact suppressed
    cohort counts.

# Exit gate

This slice passes when schema, builder, scheduled handler, endpoint, UI, tests,
local D1 migration, scheduled-event smoke, deletion withdrawal, and a dated
verification receipt all agree on the stored snapshot bytes and leave the
Worker unrouted.
