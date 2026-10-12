---
title: A2 private daily read retry review
date: 2026-09-25
type: plan
status: completed
---

# A2 private daily read retry review

## Status and approval boundary

The owner approved this additional private test attempt on 2026-09-25 after
the first A2 run published a synthetic daily aggregate but failed its
authenticated private HTTP read. The first attempt used controls 2→3→4,
retained its fixture and aggregate revision 1, and restored publication off.
The service environment selected the canonical source while the daily Jobs
used the synthetic identity. Together with the route's code-level source read
fence and the HTTP 503, this supported the identity mismatch as the likely
cause; the request log did not provide a separate root-cause code.

The approved retry completed on 2026-09-25. It temporarily selected the
synthetic source identity for the IAM-private service, advanced controls 4→5→6,
appended immutable aggregate revision 2, verified its authenticated private
read, and restored publication off and the canonical service identity. The
exact live evidence is in the [retry receipt](../receipts/2026-09-25-gcp-a2-private-daily-read-retry.md).
This test authorization covered only the effects recorded here. Production
Cloudflare remains unchanged. The tested m44 source is committed as
`8c8eead6f9d7bc4269f0f59ff94e9b080015122c` on isolated branch
`codex/gcp-a2-daily-retry-20260925`. This documentation worktree remains at
m41; the m44 branch has not been merged into it.

## Verified starting state

The isolated target is GCP project `tibotattle`, region `us-east1`, Cloud SQL
primary `tibotattle-test-primary-20260922`, database `tibotattle`, schema
`tibotattle_v12_a2_20260925`, source
`synthetic-community-source` / `synthetic-community-namespace`, and day
`2026-09-25`.

A read-only probe after the first attempt found collection controls at revision
4, degraded, with enrollment and publication disabled. It found exactly one
retained daily row for the synthetic source and day: immutable revision 1,
`collection_revision=3`, `policy_revision=1`, release state `published`, source
authority epoch 0, cursor sequence 0, and a payload digest present. The
content-free synthetic fixture also remains. No GCS object was created.

The private service initially used `canonical-v1-primary` / `telemetry-v1`,
while the daily Jobs used the synthetic pair. The route reads using the service
environment identity. The retry preflight re-read the service IAM policy,
environment values, Job targets and modes, controls, migration receipts,
fixture, and aggregate rows before opening controls. The service and Jobs used
the reviewed immutable image and matching migration manifest. The tested
preflight accepted `publication_state=updating` or `ready` only at policy
revision 1.

## Execution result

Successful prewrite backup `1790367493471` was confirmed. Cloud Build
`a2108f42-0fc5-4f94-ad84-089ed4161a18` built image
`sha256:ba8d37c599eb587ea98d081423ad86ca0d04c58cfb096f4fdcd0607770d83833`
from source digest
`3c466e0df2bc7435b248567dadc1e5d31519078e4ef4f87a700499a4d60ac52a`.

Prepare execution `xsn72` moved controls from revision 4 to 5 without inserting
another fixture and confirmed retained aggregate revision 1. Publisher
execution `qcx27` appended immutable revision 2 for the same synthetic day and
source, with `usageEvents: 1`, `collection_revision=5`, `policy_revision=1`,
`allowanceState=updating`, and the v1/v1.1-only projection scope. The
authenticated private daily read returned HTTP 200 for the exact day and
revision 2 on service revision `tibotattle-test-app-00044-ktp`, using the
reviewed image digest above. The read verified the readback and no-store
behavior and included no source identity. Restore execution `lrkl6` advanced
controls to revision 6 with publication and enrollment off. Independent
read-only probe `tmdqj` confirmed
exactly revisions 1 and 2, with collection revisions 3 and 5 respectively,
policy revision 1, source authority epoch and cursor sequence both zero, and
revision-6 publication disabled.

After the successful private read, a separate service image deployment created
revision `00045`. Revision `00046-64g` restored
`canonical-v1-primary` / `telemetry-v1` while preserving that newer image.
IAM remained private: unauthenticated `/api/health`
returned 403 and authenticated `/api/health` returned 200. Post-test health
reported primary migration 44/44 and ledger migration 6/6. The maintenance
Scheduler remained paused. All three daily Jobs were restored to their
pre-retry image and arguments, including publisher preflight mode.

## Proposed exact additional effect

The approved and completed test followed these exact steps:

1. Take a fresh successful backup of the exact test database. Confirm the
existing synthetic fixture is present exactly once and daily aggregate
revision 1 is the only publication for this source and day. Stop on any extra,
missing, or changed row; do not reseed the fixture or overwrite revision 1.
2. Temporarily change only the private service's
`POSTGRES_SOURCE_ID` and `POSTGRES_SOURCE_NAMESPACE` to the synthetic pair.
Keep the service IAM-private and preserve its ingress, traffic, service
account, secrets, and other environment values. Read back the serving revision
and verify anonymous invocation remains denied.
3. Through a reviewed conditional control-only operation, transition controls
from exact revision 4 to revision 5:

   | Revision | State | Enrollment | Upload registration | Processing | Publication | Reason |
   |---:|---|---|---|---|---|---|
   | 4 baseline | degraded | off | on | on | off | `synthetic_v12_test_upload_only` |
   | 5 temporary test gate | operational | off | on | on | on | `synthetic_daily_publication_test` |
   | 6 restored | degraded | off | on | on | off | `synthetic_v12_test_upload_only` |

   The operation must not modify fixture rows, admission state, source
   cursors, or enrollment. Do not reuse a fixture-seeding path unless it has
   been reviewed to accept the exact retained state and change only controls.
4. Run the one-task, zero-retry daily publisher once. It must read the current
   service/Job identity and publication fences and append exactly immutable
   aggregate revision 2 for the same day and source. Expected output is
   `usageEvents: 1`, `collection_revision=5`, `policy_revision=1`,
   `allowanceState=updating`, and the existing v1/v1.1-only projection scope.
   No second fixture, GCS object, or other day may be created.
5. While revision 5 and the synthetic service identity are active, make the
   authenticated private daily read using the publisher receipt. Require HTTP
   200, no-store protections, exactly the requested day and aggregate revision
   2, `usageEvents: 1`, and no source ID or namespace in the response.
6. Invoke the independent restore path after publication and HTTP verification
   regardless of success, failure, timeout, or uncertain result. It must
   compare the exact revision-5 gate and advance controls to revision 6, then
   read back the full degraded, publication-disabled state with enrollment
   off. Restore the service source environment to
   `canonical-v1-primary` / `telemetry-v1` and read back the expected private
   serving revision and unchanged IAM policy.

The fixture and both immutable publication revisions remain retained. No
delete, withdrawal, public route, Cloudflare change, or production data access
is part of this retry.

## Fail-closed gates and recovery

Immediately before the first retry write, the following were verified:

- Primary and ledger migration receipts are exactly 44/44 and 6/6; the
  service and all three Jobs use the same immutable reviewed image and
  migration manifest.
- The service is IAM-private, the maintenance Scheduler is paused, and the
  exact current environment is `canonical-v1-primary` / `telemetry-v1`.
- Controls are exactly revision 4 with publication and enrollment off; the
  fixture exists once; exactly one published aggregate exists for the target
  source/day, at revision 1 with the recorded collection and policy revisions.
- The Jobs still target this project, database, schema, source, and day; each
  has one task and zero retries. Prepare/control-only, publisher, and restore
  invocations are independently identified and read back.
- A fresh database backup succeeded and the restore operation can run
  independently of publisher or HTTP-verifier success.

Any mismatch would stop the test before changing service configuration or
controls. If the temporary service update were uncertain, its exact original
identity had to be inspected and restored before opening publication. If
preparation, publication, or HTTP verification failed after revision 5 opened,
the independent control restore and service-identity restore had to run even
when another step failed. The retry completed after controls read back at
revision 6 with publication off, the service identity read back as canonical,
and private IAM remained unchanged.
