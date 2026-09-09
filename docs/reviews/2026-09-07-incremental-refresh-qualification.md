---
title: Incremental graph refresh qualification
date: 2026-09-07
type: review
status: candidate-validated
source_base: 1b44f9ea
---

# Scope and boundary

This records local qualification of the hosted-only incremental refresh repair
on `codex/incremental-graph-cache`. It does not attest a production deployment,
desktop build, or completed live historical backfill. Production observations
and deployment identity belong in a separate receipt.

The owner authorized implementation and publication following the
[performance investigation](../research/2026-09-07-refresh-performance-investigation.md).
Consent, v1.1 activation, retention policy, published desktop releases and
resource ceilings are unchanged. Migrations 0050–0053 are forward-only.

## Implemented contracts

- An accepted append or exact same-device correction preserves an authorized
  publication. The correction capability exists only inside its upload batch.
  Withdrawal, erasure, policy changes, changed source authority and unknown
  mutations still invalidate immediately. No invalidation floor is restored.
- Historical dependencies use elected analytical days rather than incidental
  account revisions. Out-of-window or losing-device changes can rebind an
  unchanged checkpoint/result under the new write fence, without reacquisition.
- Prepared days retain exact plan/quota boundaries and server-priced usage.
  Adjacent windows reuse these immutable inputs. They do not average existing
  capacities or replace the estimator. Unknown prices and conflicts stay unknown.
- Existing raw-page work retains its original replay protocol. New prepared
  work has an explicit 128-row protocol, including staged write/verify/promotion
  and bounded retirement. Missing or retired data cannot be mistaken for EOF.
- Unchanged current/daily lanes take one metadata query each and no raw reads,
  calculation or publication. Material cache damage revokes completion in the
  same transaction; identical writes and timestamp-only touches do not.
- Public and owner graphs survive classified temporary failures. Owner overview,
  growth, allowance and progress requests are independent. The new owner-only
  progress route distinguishes requested, prepared and published generations;
  it does not claim an unmeasured ETA or expose participant identifiers.

## Performance evidence

Real local Workerd/D1, synthetic dense history: 6,061 quota observations and
12,120 usage events. Exact raw/prepared acquisition and final calculation results
were compared, including counts and integer prices.

| Measured operation | Raw | Prepared |
| --- | ---: | ---: |
| Acquisition queries | 18 | 3 |
| Returned acquisition rows | 18,183 | 134 |
| Largest returned acquisition page | 430,550 bytes | 26,762 bytes |
| Historical finish queries, including source fences | 10 | 6 |
| Reused adjacent-day preparation | Full physical reader needed | 0 pages, 1 metadata query |

The 12,120 usage events produced 106 bounded integer-cost fragments. One observed
acquisition timing was 227 ms raw versus 10 ms prepared, after preparation. This
is local synthetic wall time, not CPU, peak heap, end-to-end backfill or production
latency. No production speed multiplier or completion time is claimed.

Worst-case prepared reset merge is capped at 128 selected days × 128 narrow keys,
then 128 final rows. A populated maximum-fan-out regression verifies indexed
seeks, fewer than 100,000 D1 rows read and fewer than 65,536 returned bytes.
Time-ordered readers use exact selected-day seeks rather than scanning retired
or future-only prefixes. The existing shared query/deadline limits remain intact.

## Test run report

Focused tests passed after implementation:

- 115 real D1 tests covering current warming, work replay and graph preservation.
- 140 combined history, selected-source, scheduler, prepared and work tests.
- 91 prepared, shared-finisher, physical-reader, projection and staged-work tests.
- 19 owner cache-label and generation-race tests.
- Final focused rerun: 52 cache-publication and owner-access tests, including
  trigger-aware publication acknowledgements and zero-write storage failures.
- 573 Web tests; 127 focused browser contract tests; 36 release-site tests.
- 69 schema/deploy-guard tests and 15 release-preflight tests, including isolated
  local Wrangler application of the complete schema and populated 0049 upgrade.
- Local HTTP acceptance: 20 synthetic participants, idempotent uploads,
  server repricing, privacy/schema rejection, export, owner-only deletion and
  restart preservation. No real contribution history was used.

These groups overlap; their counts must not be summed as unique tests.
The final full Worker gate is recorded separately at publication time.

The full root suite ran 3,962 tests: 3,937 passed, 21 skipped, four failed.
Two route-inventory expectations were stale after the new owner endpoint; the
complete eight-test documentation contract rerun passed after updating the
inventory and both references. The other two failures are pre-existing R7 desktop
receipt freshness failures: both baseline HEAD and this candidate have identical
362-file workload digest
`b91df4fcacffc39f5ec60d4e318bb98d55f35eecb3207beecdaf931d49911f06`, while the retained
receipt contains `7b441df76b2f045c4bf22506dd990e9aa182414f00dba518c99cfe17f257cc54`.
None of the workload source closure changed here. Receipts were not relabelled,
tests were not skipped, and no private desktop-history regeneration was performed.

### Failures diagnosed and fixed

- Actual regression: a refresh receipt could hide corrupted cache content.
  Transactional semantic cache invalidators now make repair necessary again;
  no-op, deletion and failed-batch rollback are covered.
- Actual integration issue: D1 total change counts include trigger effects.
  Cache publication now requires exactly one matching `RETURNING` row from each
  guarded write and the final atomic authority assertion, rather than treating
  extra receipt updates as failure. Source/lease race and rollback tests remain.
- Compatibility issue: pre-0052 lifecycle maintenance must not touch a nonexistent
  prepared store. An indexed schema-presence check skips only genuine absence;
  errors from an existing store remain errors.
- Time-dependent fixture: an age-preservation test selected yesterday, which
  could equal an older generation's own UTC date near midnight. The fixture now
  selects a day preceding both generations; the publication date boundary is
  unchanged.
- Stale assertions: unchanged refreshes now avoid the account census, and age
  alone no longer forces a rebuild. Tests now assert the stronger one-query,
  zero-write contract while retaining changed-source and incomplete-cohort cases.

## Independent review and rendered proof

Separate reviewers checked historical rebinding, prepared-reader exactness,
generation/retention races, source-day cursor bounds, upload preservation,
owner access, frontend cancellation and deployment schema expectations. All
identified release blockers were corrected before the final integration gate.

Synthetic rendered desktop/mobile checks retained the exact graph during
overview/history/allowance storage failures while progress advanced independently;
confirmed invalidation cleared allowance but retained independent daily activity.
No horizontal overflow was observed at 1440 or 390 pixels. Live rendering and
the exact new asset/source identity must still be checked after deployment.
