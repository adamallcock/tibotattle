---
title: Backend Load Profile Plan
date: 2026-07-26
type: plan
status: verified-scaled
---

# Backend load profile

## Outcome

Create an executable, privacy-safe capacity harness for the production-shaped
Cloudflare Worker boundary. The harness must exercise anonymous enrollment,
short-lived upload registration, client-side encryption, strict server
validation, D1 canonical writes, R2 quarantine, deduplication, private results,
aggregate publication, and participant deletion through real loopback HTTP.

This slice does not authorize cloud deployment or claim that the full
1,000-user release gate has passed.

## Frozen full-profile arithmetic

The initial research-release profile in the end-to-end goal requires at least:

- 1,000 active participants;
- 10,000 bundle attempts per modeled day; and
- 20,000,000 expanded records per modeled day.

The current transport accepts at most 200 records per contribution and the
server accepts at most 100 telemetry contributions per participant. Reaching
20,000,000 expanded records therefore requires exactly:

```text
1,000 participants × 100 attempts × 200 records = 20,000,000 records
```

That is 100,000 bundle attempts, ten times the stated minimum attempt count.
The harness must reject any purported full-profile configuration below these
dimensions rather than extrapolating a smaller run into a pass.

## Runner contract

- Accept only `http://127.0.0.1` or `http://localhost`; never send test
  credentials or ciphertext to a non-loopback origin.
- Require the Worker to report `local_open` for private-ingestion load or
  `invite_only` when one owner-only invitation is supplied per participant;
  aggregate exercise is allowed only in the latter mode.
- Generate content-free telemetry records with reviewed closed-schema fields
  and deterministic synthetic occurrence identifiers.
- Fetch the live wrapping key and use the browser's RSA-OAEP/AES-GCM envelope
  implementation.
- Use a fresh short-lived, object-bound upload authorization for every attempt.
- Create distinct plaintext batches that deliberately repeat occurrence IDs so
  the canonical deduplication path is exercised without inventing user data.
- Bound participants, attempts, records, concurrency, request duration, and
  retained diagnostics before any request is sent.
- Never print participant IDs, cookies, CSRF values, recovery codes, upload
  authorities, ciphertext, event IDs, or response bodies.
- Record only aggregate counts, fixed error classes, elapsed time, bounded
  latency summaries, and the declared workload dimensions.
- Delete every created participant in a `finally` cleanup path. Report cleanup
  failures as a failed run.
- Require a separate explicit flag for the full 20-million-record profile.

## Evidence ladder

1. Pure contract tests prove arithmetic, loopback restrictions, percentile
   calculation, configuration ceilings, and full-profile opt-in.
2. A small HTTP smoke proves the complete encrypted lifecycle and cleanup.
3. A scaled local run measures concurrency and latency with at least twenty
   participants, deliberate deduplication, aggregate publication, and mass
   deletion.
4. The literal 1,000-participant, 100,000-attempt, 20-million-expanded-record
   run is executed only in an isolated capacity environment with measured
   storage, CPU, memory, latency, error rate, cleanup, and estimated platform
   cost.

Only step 4 can satisfy the numerical load component of the broader release
gate. A local scaled run is implementation evidence, not an extrapolated pass.

## Failure policy

Any unexpected status, malformed fixed contract, privacy-sensitive diagnostic,
participant cleanup failure, or aggregate inconsistency fails the run. The
runner may continue bounded cleanup after failure, but it must not convert
partial success into a capacity claim.

## Result

The contract, loopback runner, owner-only receipt path, and scaled evidence are
implemented and verified locally. The runner now distinguishes three cases
that a generic request benchmark would conflate:

- local-open participants can test private ingestion but cannot count toward a
  community release;
- independently invited participants can exercise the anti-Sybil aggregate
  path; and
- more than twenty enrollments must be paced at no less than 3.1 seconds each
  under the current global 20-per-minute abuse-control binding.

The passing scaled run used twenty independently invited participants, 160
encrypted maximum-size contribution attempts, 32,000 expanded records,
deliberate cross-contribution duplicates, private result checks, publication,
mass deletion, aggregate revision rebuilding, and complete cleanup. Its
[verification receipt](./2026-07-26-backend-load-scaled-verification-receipt.md)
records the exact aggregate metrics and the limitations that keep the
1,000-user gate open.
