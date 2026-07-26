---
title: Disabled v0.2 Backend and Calibration Verification Receipt
date: 2026-07-26
type: verification
status: verified-with-open-gates
---

# Disabled v0.2 backend and calibration verification receipt

## Scope

This receipt covers two distinct backend paths:

1. the active local-development `telemetry-contribution-v0.1` HTTP path, which
   accepts only encrypted, privacy-safe contribution files; and
2. the repository-only `telemetry-contribution-v0.2` shadow path, which adds
   participant-scoped account tracks and five-hour/seven-day analysis but
   remains `implementation_disabled` and has no HTTP route.

No public deployment or external upload was performed.

## Verified outcomes

### Active v0.1 HTTP backend

A fresh loopback Worker was started with isolated local D1/R2 state in
`invite_only` mode. All seven migrations were applied, twenty one-time
owner-only invitation grants were issued, and an actual prepared
`telemetry-contribution-v0.1` file containing 99 usage events and 101 quota
snapshots was submitted through the encrypted HTTP path.

The smoke verified:

- twenty independently admitted participants;
- 200 accepted records per participant;
- browser-compatible envelope encryption and one-use upload authorization;
- strict server validation, D1 persistence, and opaque R2 quarantine;
- idempotent replay without duplicate records;
- personal-stat recomputation from server-derived API-price-equivalent costs;
- unavailable aggregate output before scheduled publication;
- delayed aggregate publication at the twenty-participant support threshold;
- byte-stable aggregate reads;
- participant authority isolation;
- bounded recovery rotation, security reset, revoked upload authority, and
  logout cookie clearing;
- aggregate withdrawal after privacy-affecting deletion; and
- complete deletion of all twenty participants.

Post-smoke D1 counts were zero for participants, contributions, telemetry
records, sessions, upload authorizations, and recovery receipts. R2 retained
zero blobs. One immutable aggregate snapshot tombstone remained in the
`withdrawn` state as designed. The temporary state and invitation files were
moved to Trash after inspection.

### Disabled v0.2 repository backend

The shadow lane now:

- validates the renewed `privacy-safe-telemetry-v0.2` closed contract;
- bounds a dataset to 100 parts and requires complete part membership before
  calibration;
- derives participant-bound account tracks without transmitting local account
  identifiers;
- stores dataset, part, policy-epoch, and account-track membership in D1;
- rejects conflicting occurrence reuse before any contribution row is written;
- ignores untrusted client cost declarations and performs canonical server
  repricing;
- partitions analysis by participant, account track, provider, plan,
  plan variant, limit, duration, and policy epoch;
- uses one shared duration-generic core for five-hour and seven-day resets;
- fits on the first 70 percent and scores the later 30 percent without
  look-ahead;
- forecasts only from completed prior resets;
- builds exact one-, two-, and three-hour endpoint-bracketed rolling
  comparisons; and
- removes account-scoped evidence before recomputing personal statistics after
  deletion.

The v0.2 modules are not imported by the HTTP router. The public route still
accepts only `telemetry-contribution-v0.1`.

## Repeatable checks

The following commands passed:

```sh
npm run product:backend:test
# 4 test files, 50 tests passed

npm run product:ui:test
# 20 tests passed

node --test test/telemetry-contribution-v0.2.test.js test/shared-quota-*.test.js
# 23 tests passed

npm run product:worker:check
# generated types current
# TypeScript passed
# local scripts passed
# 4 Worker test files passed (49 tests at the recorded full check;
# the later bounded-record regression raises the current total to 50)
# Worker deployment dry run passed
```

The complete root suite ran 825 tests: 823 passed and two retained R7
release-receipt tests failed because their stored workload-code provenance no
longer matches the current repository. Those failures predate and are unrelated
to the contribution backend; the retained receipts were not silently
regenerated or weakened.

## Rendered portal check

The Worker-served portal was inspected at `http://127.0.0.1:8793/`. Its live
Data & privacy section reported:

- backend state: `Backend ready`;
- database: `Connected`;
- encrypted quarantine: `Bound`;
- enrollment: `Open for local testing`;
- accepted upload contract: `telemetry-contribution-v0.1`; and
- `telemetry-contribution-v0.2` account-scoped ingest: implemented and testable
  in the repository but disabled on the HTTP route.

The same section makes the seven server stages visible: browser validation,
encrypted transport, server validation, transactional ingest, private
analysis, delayed aggregation, and user-controlled export/reset/deletion.

## Open gates

- v0.2 needs fresh explicit consent and at least three completed prospective
  reset windows before activation can be considered.
- The current Worker has no production route and must not receive external
  participants.
- A browser cannot exercise the production-shaped Secure-cookie journey over
  plain loopback HTTP. The cookie-jar HTTP smoke covers that lifecycle now; a
  same-origin HTTPS staging environment must repeat real browser interaction
  before a pilot.
- The live health check proves D1 reachability and R2 binding presence, not the
  complete ingest lifecycle. The test suite and HTTP smoke are the deeper
  evidence.
- Production key rotation, retention operations, abuse controls, alerting,
  backup/recovery, privacy review, and security review remain release gates.
