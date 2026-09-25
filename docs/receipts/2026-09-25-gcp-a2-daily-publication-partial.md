---
title: GCP A2 daily publication partial result
date: 2026-09-25
type: receipt
status: snapshot
---

# GCP A2 daily publication partial result

This receipt records a partial test-only A2 run in GCP project `tibotattle`,
region `us-east1`, on 2026-09-25. The synthetic fixture and one immutable daily
aggregate were committed, but the authenticated private HTTP read failed. The
independent restore succeeded. This does not prove a complete daily read
journey, production migration, or Cloudflare cutover.

## Prewrite evidence

The target was Cloud SQL primary `tibotattle-test-primary-20260922`, database
`tibotattle`, schema `tibotattle_v12_a2_20260925`, day `2026-09-25`, and source
`synthetic-community-source` / `synthetic-community-namespace`. The read-only
preflight found all 16 fixture preconditions empty. Collection controls were
revision 2, degraded, with enrollment off, upload registration on, processing
on, publication off, and reason `synthetic_v12_test_upload_only`. The live
publication policy was `publication_state=updating`, `policy_revision=1`;
this is distinct from the publisher receipt's `allowanceState=updating`.

At 18:51 UTC, migration execution
`tibotattle-test-database-migrate-mnrrn` succeeded with primary migrations
44/44 through `0044_accountless_import_claim_erasure.sql` and independent
erasure-ledger migrations 6/6. Fresh backup `1790364143226` succeeded before
fixture and control writes. The source digest was
`64f3fa339ea86b884a87923b41588f35fe84eece67edef4189bed93f8be01d18`; archive
SHA-256 was
`9f9112fabe0a771bff26b1718d12575fc634dde6523a38856234231cc1073d01`. Cloud
Build `00bd0926-7ce8-4eaa-89a9-abb15ff61a16` produced immutable image digest
`sha256:5637ab40789abf13e251e8deac8a38f1807349b2155402745f98c646e7459fa1`.
Private service revision `00041-7wg` and all three daily Jobs used that image.
The Jobs targeted the synthetic source pair and selected day. The private
service remained IAM-restricted.

## Executions and result

- Prepare execution `tibotattle-community-daily-prepare-test-b82lw` committed
  the reviewed content-free synthetic fixture and advanced controls from
  revision 2 to revision 3.
- Publisher execution `tibotattle-community-daily-publish-test-cz662` succeeded
  and committed immutable daily aggregate revision 1 with `usageEvents: 1`,
  `activityState: partial_v1_v1_1_only`, projection scope
  `v1_v1_1_only_v1_2_excluded`, and `allowanceState: updating`.
- The authenticated private daily HTTP verifier failed with
  `RESPONSE_INVALID`. The service request log showed HTTP 503, so no successful
  readback is claimed.
- Independent restore execution
  `tibotattle-community-daily-restore-test-pcthl` succeeded and returned
  controls to revision 4, with enrollment and publication disabled.
- Independent read-only probe `fp8hh` found exactly one retained aggregate for
  the synthetic day: revision 1, `collection_revision=3`, `policy_revision=1`,
  release state `published`, source authority epoch 0, cursor sequence 0, and a
  payload digest present. It confirmed controls at revision 4, degraded, with
  publication off.

## Observed identity mismatch and boundary

The daily Jobs used `synthetic-community-source` /
`synthetic-community-namespace`. The private service environment used
`canonical-v1-primary` / `telemetry-v1`, and the daily route reads using the
service-configured source identity. This mismatch plus the HTTP 503 is
consistent with the route's code-level source read fence, but the request log
did not report a separate root-cause code. The publisher had committed the
synthetic aggregate. The fixture and aggregate remain retained; no GCS object
was created. The maintenance Scheduler remained paused. Production Cloudflare and its data were
not changed.

The owner subsequently approved and completed a private-read retry with a
temporary service identity change, controls revision 4→5→6, and immutable
aggregate revision 2. Its gates are in the
[retry review plan](../plans/2026-09-25-a2-private-daily-read-retry-review.md),
and the successful read and restored state are in the
[retry receipt](./2026-09-25-gcp-a2-private-daily-read-retry.md).
