---
title: Account-Scoped Local Ingest Verification Receipt
date: 2026-07-26
type: verification
status: passed-local-only
---

# Account-scoped local ingest verification receipt

## Decision

The `telemetry-contribution-v0.2` account-scoped path is verified for isolated
loopback development use. It is not authorized for production deployment or
external participants.

Checked-in configuration remains fail-closed:

- `ACCOUNT_SCOPED_INGEST_MODE=disabled`;
- `workers_dev=false`;
- no production route;
- `externalParticipantsAuthorized=false`.

## Verified HTTP lifecycle

The real Worker boundary completed:

1. fresh v0.2 consent and participant enrollment;
2. one-use upload authorization;
3. client-side envelope encryption;
4. bounded envelope parsing and server decryption;
5. closed-schema and privacy-canary validation;
6. opaque R2 quarantine;
7. canonical D1 ingestion with account and complete-dataset scope;
8. server-side API repricing;
9. private participant calibration;
10. community-field isolation;
11. participant export; and
12. participant deletion from primary D1 and R2.

The route rejected disabled/invalid configuration and non-loopback hosts.
Duplicate envelope/occurrence replay remained idempotent, while conflicting
occurrence reuse failed without partial canonical writes. A v0.2 paired device
could upload under the participant's consent but could not read private
statistics.

## Automated evidence

Focused account-scoped HTTP suite:

```text
npx vitest run test/account-scoped-http.spec.ts
4 tests passed
```

Complete Worker suite at the implementation checkpoint:

```text
npm test
5 files passed
64 tests passed
```

Consumer UI suite:

```text
npm run product:ui:test
25 tests passed
```

Script syntax/helper checks:

```text
npm run scripts:check
3 helper tests passed
all checked scripts parsed successfully
```

Complete product check:

```text
npm run product:check
25 UI tests passed
33 local client, prepared-set, queue, and loopback tests passed
64 Worker tests passed
generated Worker types current
TypeScript passed
Worker dry deployment passed with ACCOUNT_SCOPED_INGEST_MODE=disabled
```

The broad root suite passed 862 of 864 tests. Its only two failures were the
retained source-bound R7 release receipts, whose workload provenance hash and
file count intentionally become stale when product source changes. They were
not regenerated or weakened in this slice; the exact-runtime R7 regeneration
workflow remains a separate release checkpoint.

## Live isolated smoke

The Worker ran on `http://127.0.0.1:8794` with all primary and deletion-ledger
migrations applied to one disposable local persistence directory. The smoke
submitted four generated, content-free contributions containing 36 usage events
and 40 quota snapshots.

Receipt:

```json
{
  "schemaVersion": "account-scoped-http-smoke-receipt-v0.1",
  "status": "passed",
  "contributions": 4,
  "usageEvents": 36,
  "quotaSnapshots": 40,
  "qualifiedResetEstimates": 4,
  "rollingComparisonStatus": "conditional_comparison",
  "serverRepriced": true,
  "participantExportVerified": true,
  "communityFieldExclusionVerified": true,
  "participantDeleted": true,
  "externalParticipantsAuthorized": false
}
```

Client diagnostics deliberately claimed `$999` per contribution and `$8991`
overall. Private server statistics did not reproduce those values, proving that
the canonical result was repriced from validated token metadata.

After the smoke deleted its participant:

- primary participants: 0;
- primary contributions: 0;
- canonical records: 0;
- paired devices: 0;
- encrypted R2 objects: 0; and
- independent deletion-ledger tombstones: 1.

## Rendered portal evidence

The in-app browser loaded the same live Worker and selected a generated
account-scoped fixture. The page:

- changed to the fresh account-track consent disclosure;
- accepted the encrypted contribution;
- showed server-repriced personal usage;
- rendered a private seven-day calibration card with sensitivity and evidence
  gates;
- omitted the raw account-track pseudonym; and
- produced no browser console errors or warnings.

The browser fixture and smoke state contained no user logs or content. The
isolated preview state was stopped and moved to Trash after verification.

## Remaining gates

This receipt does not satisfy:

- three completed prospective provider/account/plan reset observations;
- accepted preregistered minimization evidence;
- external-participant consent approval;
- independent security and privacy review;
- production infrastructure, secrets, monitoring, or recovery;
- load, soak, and 1,000-user tests;
- notification or ongoing background collection; or
- named-human release authorization.

The account-scoped contract therefore remains local-preview-only. Any external
activation requires a separate dated decision receipt.
