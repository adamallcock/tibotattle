---
title: A2 synthetic daily publication review
date: 2026-09-25
type: plan
status: approved-test-only
---

# A2 synthetic daily publication review

## Status and boundary

This is the exact-effect review for one private, test-only daily publication in
the existing A2 PostgreSQL schema. The project owner approved this effect on
2026-09-25 through the A2 synthetic-publication approval prompt. Test-only
preparation and independent restore commands are now implemented and locally
qualified against disposable PostgreSQL 17 schemas. This is not an execution
receipt: this workstream has made no GCP writes or deployment changes.

An earlier automatic approval review rejected the initial write-capable
activation attempt because it could insert rows into the shared A2 Cloud SQL
schema and change collection controls to operational with publication enabled.
The project owner later explicitly approved the exact test-only effect below.
The implementation remains pinned to this effect and cannot select another
schema, day, source, project, or Cloud Run job.

## Fixed target and current evidence

The only proposed target is project tibotattle, region us-east1, Cloud SQL
primary tibotattle-test-primary-20260922, database tibotattle, schema
tibotattle_v12_a2_20260925. The private service is tibotattle-test-app; the
existing single-task publication Job is
tibotattle-community-daily-publish-test. The A2 maintenance Scheduler must
remain paused. Production Cloudflare remains the serving system.

The 2026-09-25 read-only preflight for day 2026-09-25 found PostgreSQL 17 and
a ready publication policy, but no singleton source-state row, analytics
cursor, v1 admission state, or v1.1 admission state. Its exact publisher CTE
found no selected v1 or v1.1 records for that day. Collection controls were
publication-disabled. The authenticated private daily GET therefore returned
503, the expected fail-closed result while the fence is absent. See the [A2
daily preflight receipt](../receipts/2026-09-25-gcp-a2-daily-preflight-v2.md).

The current source tree has 39 primary migrations ending in
0039_analytics_applied_projection_v1.sql. Any eventual Job and service must
use the same pinned source and its migration receipt must match that build's
complete canonical primary manifest. This count and tail describe this source
revision; future images must use their own current manifest. A fresh backup
and readback are required immediately before any approved database write; the
older backup in the receipt is not a substitute for that gate.

## Exact proposed data effect

The source identity is the configured synthetic pair
synthetic-community-source / synthetic-community-namespace, used only in this
private schema. It is test data, not production source authority, owner
history, or evidence of a Cloudflare transfer. The requested day is exactly
2026-09-25; no range or other source is eligible.

The preparation transaction must first read back an empty source fence and no
conflicting selected-day records. Its minimal insert set is shaped after the
passing local PostgreSQL 17 publisher fixture:

| Table family | Rows | Purpose |
|---|---:|---|
| typed_telemetry_namespaces | 1 | Synthetic namespace shared by both admission fences. |
| typed_v1_admission_state, typed_v11_admission_state | 1 each | Current v1 and v1.1 contract-version-1 fences for that namespace; next source-row ID is 1 in both. No v1.1 records are seeded. |
| storage_source_state | 1 singleton | Configured synthetic source ID at authority epoch 0; singleton must be absent beforehand. |
| analytics_source_cursors | 1 | Same source ID at sequence 0 and authority epoch 0. No ingestion-change or applied-event history is invented; sequence 0 is caught up only because this exact source journal is empty. |
| Social owner/device: participants, web_sessions, device_pairings, device_credentials, device_upload_authorizations | 1 each | One active synthetic social owner and device, plus a consumed synthetic upload authorization, matching the local fixture. No accountless owner, enrollment, or authorization row is created or changed. |
| pending_objects | 1 metadata row | Content-free synthetic object key matching the v1 chunk metadata. This is a database reference only; no GCS object is created. Scheduler pause prevents unrelated reconciliation against it. |
| telemetry_v1_chunks, telemetry_v1_records | 1 each | One active usage chunk and one content-free usage event dated 2026-09-25; one record with synthetic provider/model labels and fixed token counts. No prompt, response, command, or session content. |

No telemetry_v11 day data is added. No v1.2 table is seeded, relabeled,
reused, or included in the daily result. This direct synthetic fixture
qualifies the v1 daily projection and private read path only; it does not
qualify the authenticated upload or Cloud Storage ingestion journey.

The publisher is expected to add one immutable row to
community_daily_aggregates for this synthetic source and day. Its Job receipt
must state one exact revision, usageEvents: 1, and
activityState: partial_v1_v1_1_only, with projection scope
v1_v1_1_only_v1_2_excluded. Allowance remains updating; this test does not
establish allowance readiness. The private HTTP verifier must read exactly
that day and revision, return one day without source identity, and confirm
usageEvents: 1 before controls are restored.

## Controls and ordered execution

The observed A2 baseline is collection-controls revision 15:

| Revision | control_state | Enrollment | Upload registration | Processing | Publication | Reason |
|---:|---|---|---|---|---|---|
| 15 baseline | degraded | off | on | on | off | synthetic_v12_test_upload_only |
| 16 temporary test gate | operational | **off** | on | on | on | synthetic_daily_publication_test |
| 17 restored | degraded | off | on | on | off | synthetic_v12_test_upload_only |

Revision advances monotonically. One preparation transaction would lock and
compare the exact revision-15 baseline, insert the fixture, then conditionally
set only the temporary revision-16 fields above. Enrollment stays disabled at
every point. Any changed baseline field, existing source/admission/cursor row,
selected-day v1/v1.1 record, or publication conflict stops the transaction
before commit.

After preparation commits:

1. Run the existing daily Job with one task, zero retries, the exact A2 target,
   source identity, and day. It repeats the publisher fence inside its write
   transaction and verifies its own database readback.
2. Run the existing private HTTP verifier with the exact Job receipt while
   revision 16 is active. Require HTTP 200, no-store headers, one exact
   day/revision, partial v1/v1.1 activity, and no source-identity fields.
3. Run a separate, independently invokable restore operation whether either
   prior step succeeds, fails, times out, or has an uncertain result. Restore
   reads controls first and may change only the exact revision-16 test-gate
   state to revision 17. It must read back the full degraded,
   publication-disabled baseline with enrollment still off.

## Failure, restore, and retained data

Any failed precondition means no writes. If preparation fails before commit,
one database transaction rolls back both fixture inserts and the revision-16
control change. After preparation commits, any publisher or HTTP-smoke failure
requires the independent restore path; it cannot depend on a success receipt
from the publisher. A retry may report already_restored only after reading
revision 17 and confirming every baseline field. An unexpected revision or
field value must stop without overwriting it and return a safe mismatch for
owner review.

Restore never rewinds the revision or enables enrollment. The immutable daily
publication row and tagged synthetic fixture remain in the A2 test schema;
the publication table rejects deletion. This proposal does not include a
source-withdrawal event or other cleanup mutation. Thus the control transition
is reversible, while the published test evidence is intentionally retained.
The HTTP readback occurs before restore because the private reader should fail
closed after publication is disabled.

## Exposure and likely cost

The test service remains Cloud Run IAM-private throughout; changing this
database publication gate does not change service ingress or grant public
invocation. The only HTTP check is authenticated
GET /api/v1/community/daily on the private A2 service. Its response must not
contain the synthetic source ID or namespace. IAM-authorized callers of that
private test service could see the one synthetic aggregate while revision 16
is active. After restore reads back revision 17 with publication disabled,
the same private daily route must fail closed again. No public Cloudflare
endpoint or production route is involved.

No new Cloud Run service, Cloud SQL instance, or bucket is provisioned. One
single-task Job and one authenticated HTTP read should take seconds to a few
minutes. The incremental Cloud Run charge should be negligible for one short
task; Cloud SQL compute is already running and the added rows/WAL are tiny.
There is no GCS byte charge because no object is written. Exact billing depends
on configured Job CPU/memory and current regional rates, so this is a
small-order estimate, not a billing quote.

## Approved test-only effect and remaining execution gates

The project owner approved this exact effect in the private A2 schema on
2026-09-25:

- Seed the single synthetic social v1 owner/device/usage fixture and empty
  source/cursor/admission fence listed above.
- Publish one immutable daily revision for synthetic source
  synthetic-community-source on 2026-09-25, then read it through the
  IAM-private A2 route.
- Temporarily transition controls from the exact revision-15 degraded state
  to revision 16 with publication enabled and enrollment disabled, then run an
  independent restore to revision 17 and verify all baseline fields.
- Retain the content-free fixture and aggregate in the private test schema,
  with no GCS object, bucket mutation, or production authority inferred.

Execution still requires review of the exact source image, live preconditions,
and a fresh backup immediately before the database write. The local tests do
not prove Cloud Run job configuration, migration application, GCP execution, or
the private HTTP readback. Production Cloudflare remains unchanged.
