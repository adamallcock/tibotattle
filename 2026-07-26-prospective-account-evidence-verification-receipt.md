---
title: Prospective Account Evidence Verification Receipt
date: 2026-07-26
type: verification-receipt
status: verified-local-checkpoint
---

# Prospective account evidence verification receipt

## Outcome

The project can now build a deterministic, local-only, account-partitioned
transition dataset from the passive collector without returning to raw prompt,
response, code, path, or tool payload content.

This closes the missing prospective-evidence plumbing but does not authorize
the account-track transport or a quota-capacity claim. The first real-data
minimization rerun remains correctly inconclusive because no qualifying reset
has completed since the preregistration cutoff.

## Implemented

- A strict collector-v0.3 transition builder that accepts only the reviewed
  closed metadata shapes.
- Account/provider/plan/limit/slot/duration/reset partitioning with no
  cross-account cost pooling.
- Deterministic event-key deduplication and adjacent quota-transition
  construction.
- Marginal Standard API-price-equivalent cost, token components, Standard/Fast
  counts, and coarse tool counts.
- Explicit aggregate exclusions for unattributed, stale, malformed, duplicate,
  reset-boundary, regression, and non-movement records.
- An owner-only bounded command that reads the privacy-reduced collector ledger
  and writes a local ignored evidence file.
- A participant-scoped third account-track derivation with a frozen test vector.
  It is not connected to transport.
- A dated minimization and threat-model decision that keeps `v0.2` disabled.

## Focused verification

Command:

```sh
node --test \
  test/prospective-collector-cli.test.js \
  test/prospective-collector-transitions.test.js \
  test/minimization-ablation.test.js \
  test/telemetry-account-track.test.js
```

Result:

```text
19 tests passed
0 tests failed
```

The adversarial cases cover account switching, duplicate event keys, reset
boundaries, unavailable account scope, stale records, regression, non-movement,
plan mismatch, unknown fields, path and email canaries, invalid prices,
participant/provider unlinkability, malformed local scopes, foreign-account
event-key reuse, conflicting same-track keys, cross-limit usage, slot movement,
and conflicting simultaneous slots.

## Real local evidence build

Command:

```sh
npm run build:prospective-transitions
```

Content-free result:

```text
input privacy-reduced records: 243930
eligible account-scoped records: 10
emitted transitions: 2
window durations: 10080 minutes
local account tracks represented: 1
unattributed exclusions: 243916
malformed exclusions: 4
non-movement exclusions: 2
reset-boundary exclusions: 3
stale exclusions: 0
regression exclusions: 0
duplicate exclusions: 0
conflicting-key exclusions: 0
slot-conflict exclusions: 0
unsupported-policy-epoch exclusions: 0
```

The 278 MB input and both generated receipts were mode `0600`. Account-track
values and exact transition rows remain only in ignored local artifacts.

## Preregistered minimization rerun

Command:

```sh
node scripts/minimization-ablation.js \
  --input .usage-monitor/prospective-account-transitions-v0.1.json \
  --output .usage-monitor/prospective-minimization-ablation-v0.1.json \
  --prospective-after 2026-07-24T00:00:00.000Z \
  --fixture test/fixtures/minimization-codex-shaped-v1.json \
  --fixture test/fixtures/minimization-claude-shaped-v1.json
```

Result:

```text
decision: inconclusive
prospective qualifying completed resets: 0
eligible holdout records: 0
reference primary metric: unavailable
blockers: 3
```

The two recovered weekly transitions belong to a reset that began before the
prospective cutoff. They therefore cannot be used to retain a new restricted
field. Every A1-A7 family remains at its preregistered insufficient-evidence
default, and public aggregation remains prohibited.

## Full repository suite

Command:

```sh
npm test
```

Result:

```text
797 tests
795 passed
2 failed
```

Both failures are the already-known stale checked-in R7 release provenance
receipts. The receipts remain bound to an older source-set hash and file count;
the R7 contract correctly rejects them after the repository changed. They
require complete dual-runtime evidence regeneration and are not attributable to
an account-transition assertion failure. No R7 receipt was rewritten or
re-sealed.

## Privacy assertions

- The central `v0.1` contribution builder remains unchanged and continues to
  reject/strip local account and session scopes.
- The candidate account-track function accepts only
  `account:v1:<64 lowercase hex>`, a canonical central participant UUID, and a
  reviewed provider enum.
- It emits only `unattributed` or
  `account-track:v1:<64 lowercase hex>`.
- A different account, participant, or provider produces a different track.
- No raw email or local account scope is returned or printed.
- The candidate module is unused by upload, browser, Worker validation, D1, R2,
  exports, or community APIs.

## Remaining release gates

1. Continue prospective collection until at least three full eligible resets
   have completed.
2. Prove account scope on both usage and quota rows throughout each eligible
   interval.
3. Rerun the frozen minimization and accept only a passing deterministic
   receipt.
4. Freeze the `v0.2` schema and renewed consent separately from `v0.1`.
5. Add dataset completeness and part-membership semantics.
6. Add participant/account predicates to all private calibration queries.
7. Share one duration-generic 300/10,080-minute estimator between local and
   Worker adapters.
8. Prove deletion, HTTP lifecycle, local/Worker parity, and rendered private UI
   before an invite-only pilot.
