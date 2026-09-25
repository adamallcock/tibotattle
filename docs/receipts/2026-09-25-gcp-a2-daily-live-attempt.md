---
title: GCP A2 daily publication live attempt
date: 2026-09-25
type: receipt
status: snapshot
---

# GCP A2 daily publication live attempt

This receipt records the 2026-09-25 test-project attempt in `tibotattle`,
`us-east1`. PostgreSQL migrations and private-service deployments succeeded,
but the approved synthetic fixture was not committed to the database and no
daily aggregate was published. The maintenance Scheduler remains paused, and
the daily Job remains in `--preflight` mode. Production Cloudflare was
unchanged. This is a
point-in-time record, not cutover or publication qualification.

## Initial image, database migration, and failed preparation

- The clean source export was pinned to commit `98d769f0`. Cloud Build
  `09f93e7b` succeeded and produced the immutable image with digest prefix
  `sha256:057c82…`.
- Successful Cloud SQL backup `1790350666037` preceded the database migration
  execution `hh2l6`. Its readback reported 39/39 primary migrations and 6/6
  independent-ledger migrations. Migration application is a durable test
  database write; it remains applied even though the later fixture transaction
  rolled back.
- The IAM-private test service was deployed from that image. An unauthenticated
  request was denied.
- Initial A2 preparation execution `2xmzw` failed with
  `MIGRATION_RECEIPT_READ_FAILED`. Its transaction rolled back. The subsequent
  daily preflight `q4h57` independently confirmed that the synthetic source was
  absent and publication remained disabled.

## Corrected image and guarded retry

- Commit `b7ba3198` corrected the A2 migration privilege check; smoke contract
  `790606df` was also included in the corrected source. The clean export had
  source-digest prefix `8ad23d8e…` and archive SHA-256 prefix `052e698f…`.
  Cloud Build `9ccb2832` succeeded and produced image digest prefix
  `sha256:a5c5dd5…`. The private service was redeployed from this image.
- Successful backup `1790353172997` was taken before the guarded retry.
  Corrected-image daily preflight `l5vzj` again found the synthetic source
  absent and publication disabled.
- Preparation execution `vndt4` failed with
  `CONTROLS_BASELINE_MISMATCH` before fixture inserts. A separate read-only
  execution `2sbpq` read the actual controls: revision 2, degraded state,
  enrollment off, upload registration on, processing on, publication off, and
  reason `synthetic_v12_test_upload_only`.

After these attempts, corrected-image daily preflight execution `kpdcr` exited
2 with the expected blockers `SOURCE_STATE_UNAVAILABLE`,
`V1_ADMISSION_UNAVAILABLE`, `V11_ADMISSION_UNAVAILABLE`, and
`PUBLICATION_CONTROLS_DISABLED`. Its readback found no selected-day v1 or v1.1
records and publication disabled. This was read-only confirmation of the
fail-closed state; it made no fixture or publication writes.

## Result and authorization boundary

No synthetic source, owner, device, usage event, or daily aggregate was
committed by either preparation attempt. No daily publisher run or published
HTTP readback occurred. The test database does contain the successfully applied
migrations described above. The maintenance Scheduler
`tibotattle-test-maintenance-hourly` remains paused, and
`tibotattle-community-daily-publish-test` remains configured for read-only
`--preflight`. No Cloudflare resource or production data was changed.

The [approved test plan](../plans/2026-09-25-a2-synthetic-daily-publication-review.md)
specified controls revision 15 as its exact starting state and transitions
15→16→17. Live readback instead found revision 2. The proposed replacement
transition 2→3→4 is a changed control mutation and remains pending explicit
owner approval after automatic review rejected that changed baseline. The
revision-2 mismatch correctly stopped before fixture inserts; do not treat the
original approval as approval for the changed revision sequence.

Relevant implementation is in the [A2 activation guard](../../apps/worker/cloud-run/postgres-community-daily-activation.mjs),
its [focused checks](../../apps/worker/cloud-run/postgres-community-daily-activation.check.mjs),
the [prepare entrypoint](../../apps/worker/cloud-run/postgres-community-daily-prepare-test.mjs),
the [restore entrypoint](../../apps/worker/cloud-run/postgres-community-daily-restore-test.mjs),
and the [daily publisher](../../apps/worker/src/postgres-community-daily-publisher.ts).
The earlier [read-only daily preflight receipt](./2026-09-25-gcp-a2-daily-preflight-v2.md)
and [A2 v1.2 test journey](./2026-09-25-gcp-a2-v12-test-journey.md) describe
separate evidence; neither supplies the missing revision-2 authorization or
proves a daily publication.
