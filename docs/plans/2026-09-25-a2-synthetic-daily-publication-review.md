---
title: A2 synthetic daily publication review
date: 2026-09-25
type: plan
status: blocked
---

# A2 synthetic daily publication review

## Status and boundary

Current status: blocked pending explicit approval of a revised control-revision
sequence and a matching daily Job configuration. The project owner approved the
exact test-only effect recorded below on 2026-09-25, scoped to the reported
collection-controls transition 15→16→17. The later live readback found
revision 2 instead. The corrected preparation attempt stopped on that baseline
mismatch before inserting the fixture. The original approval does not authorize
a changed 2→3→4 sequence.

The later A2 v1.2 journey migrated this same primary schema to 41/41 and the
independent erasure ledger to 6/6, and deployed the private service from image
`sha256:95c15fa41597c1d676aa78bcc2b28dd4bb7289cd8db32acf4839fd0d40d2e665`.
That receipt reports no daily aggregate; the daily publication runner remained
in read-only `--preflight` mode. The daily preparation attempts committed no
daily-publication fixture or aggregate, and no daily publisher run or daily
route readback occurred. The maintenance Scheduler remains paused. See the
[daily live-attempt receipt](../receipts/2026-09-25-gcp-a2-daily-live-attempt.md)
and [later migration-41 journey receipt](../receipts/2026-09-25-gcp-a2-v12-migration41-journey.md).
The latter does not record a fresh collection-controls revision readback.
The daily prepare, publisher, and restore Jobs still use the earlier
39-migration image; only the private service uses the 41-migration image. The
publisher Job is still configured for `--preflight`, not publication. Rebuild
or repin and read back the exact Job images before any Job run. This plan is not
an execution receipt.

An earlier automatic approval review rejected the initial write-capable
activation attempt because it could insert rows into the shared A2 Cloud SQL
schema and change collection controls to operational with publication enabled.
The project owner later approved the exact test-only effect below. After the
live revision-2 readback, a revision-only 2→3→4 amendment was proposed and
automatic review rejected that changed control mutation. It remains pending
explicit owner approval, conditional on all other target and data-effect
preconditions matching. The historical table below does not approve that
amendment.

## Fixed target and current evidence

The only proposed target is project tibotattle, region us-east1, Cloud SQL
primary tibotattle-test-primary-20260922, database tibotattle, schema
tibotattle_v12_a2_20260925. The private service is tibotattle-test-app; the
existing single-task publication Job is
tibotattle-community-daily-publish-test. The A2 maintenance Scheduler must
remain paused; the 2026-09-25 read-only Scheduler describe confirmed
`tibotattle-test-maintenance-hourly` is `PAUSED`. Production Cloudflare remains
the serving system.

The original approval was based on collection-controls revision 15. The latest
explicit daily-control readback recorded revision 2, degraded state, enrollment
off, upload registration on, processing on, and publication off. The corrected
daily preparation attempt stopped at its revision-15 precondition before
fixture inserts. A later v1.2 journey receipt says publication remained withheld
by degraded controls but gives no control revision; a fresh exact revision
readback is required before any future preparation.

The 2026-09-25 read-only Cloud Run readback found all three daily Jobs targeting
project `tibotattle`, schema `tibotattle_v12_a2_20260925`, source
`synthetic-community-source` / `synthetic-community-namespace`, and day
`2026-09-25`. Prepare uses
`node dist/postgres-community-daily-prepare-test.mjs`; publish uses
`node dist/postgres-community-daily-publish-test.mjs --preflight`; restore uses
`node dist/postgres-community-daily-restore-test.mjs`. Each has one task and
zero retries, but all three still use the old 39-migration image with digest
prefix `sha256:a5c5dd5…`. The private service separately receives 100% of
traffic on revision `00037-4tl` with 41-migration image
`sha256:95c15fa…`. No daily Job was run in this read-only inspection. The
publisher's current `--preflight` invocation cannot publish; these Job image
and mode mismatches are execution blockers.

The earlier daily attempt receipt records an image with 39/39 primary
migrations through `0039_analytics_applied_projection_v1.sql` and 6/6
independent-ledger migrations. This is historical and superseded by the later
v1.2 journey receipt, which records the same primary schema at 41/41 through
`0041_accountless_history_retention.sql`, with the latest-migration checksum
`19c1f19a1ec333012c70334bf8ac8f6c1ca5b2a2c9e67d3b716eaa81dcbcd45b`, and the
independent ledger at 6/6. The current source guard also expects 41 primary
migrations through 0041. Before a newly approved database write, match each Job
image's complete canonical migration manifest to the database, freshly read
controls, and take a new backup immediately before the write. The earlier
backup is not a substitute for that gate.

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
qualify that v1 event's authenticated upload or Cloud Storage ingestion
journey. A separate v1.2 upload, activation, renewal, readback, and cleanup
journey is recorded in the [migration-41 journey receipt](../receipts/2026-09-25-gcp-a2-v12-migration41-journey.md);
it does not prove that this v1 fixture entered through that flow or that a daily
aggregate was published. The temporary gate enables publication for the
private daily read while enrollment remains off. The observed revision-2
degraded baseline was already fail-closed for ordinary dispatch; the temporary
gate does not enable enrollment, so ordinary enrollment and ingestion dispatch
remain fail-closed. The synthetic rows are inserted directly and bypass that
journey. The daily publisher and private reader use their separate publication
checks.

The publisher is expected to add one immutable row to
community_daily_aggregates for this synthetic source and day. Its Job receipt
must state one exact revision, usageEvents: 1, and
activityState: partial_v1_v1_1_only, with projection scope
v1_v1_1_only_v1_2_excluded. Allowance remains updating; this test does not
establish allowance readiness. The private HTTP verifier must read exactly
that day and revision, return one day without source identity, and confirm
usageEvents: 1 before controls are restored.

## Original approved controls and ordered execution

The following table preserves the original owner-approved control proposal,
which assumed revision 15. The live readback later found revision 2, so this is
historical and cannot be executed against the current baseline. A proposed
revision-only 2→3→4 amendment is still awaiting explicit owner approval; the
table remains unchanged until that approval is given:

| Revision | control_state | Enrollment | Upload registration | Processing | Publication | Reason |
|---:|---|---|---|---|---|---|
| 15 baseline | degraded | off | on | on | off | synthetic_v12_test_upload_only |
| 16 temporary test gate | operational | **off** | on | on | on | synthetic_daily_publication_test |
| 17 restored | degraded | off | on | on | off | synthetic_v12_test_upload_only |

Under the original proposal, revision advances monotonically. One preparation
transaction would lock and compare the exact revision-15 baseline, insert the
fixture, then conditionally set only the temporary revision-16 fields above.
Enrollment stays disabled at every point. Any changed baseline field, existing
source/admission/cursor row, selected-day v1/v1.1 record, or publication
conflict stops the transaction before commit. These steps remain the approved
effect's historical specification, not authorization for the changed live
baseline.

The sequence below preserves the original approved design. It does not
describe the current Job configuration: the publisher currently runs only
`--preflight`. The publishing step requires a reviewed write-capable Job
configuration under the revised approval, and all three Jobs must first use an
image matching the migrated 41/41 schema. After preparation commits:

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

## Original approved test-only proposal and current execution gate

The project owner approved this exact 15→16→17 effect in the private A2 schema
on 2026-09-25, based on the revision-15 baseline. That approval is historical
and does not authorize execution against the live revision-2 baseline:

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

The proposed minimal amendment would change only the control revisions to
2→3→4, retaining the same exact target, source, day, one-task/zero-retry Job,
publisher receipt, private HTTP readback, and retained fixture and aggregate,
provided every non-revision precondition still matches. This amendment remains
blocked pending explicit owner approval after automatic review rejected it.
The current Jobs also fail the non-revision image and mode preconditions: all
three use the old 39-migration image, and the publisher remains `--preflight`.
No daily-publication fixture or aggregate has been committed. Approval of the
revision-only amendment would not make these Jobs eligible to run. Before any
later execution, obtain that approval, rebuild or repin all three Jobs to the
image matching the migrated 41/41 schema. Under that approval, configure the
publisher from `--preflight` to the single write-capable invocation in the
approved effect. Then freshly read back exact immutable images, task counts,
retry counts, invocation modes, source, day, target, and private HTTP readback
contract. Verify live controls and all other preconditions, match the database
receipt to the current 41-migration manifest, and take a fresh backup
immediately before the database write. The v1.2
journey's private-service image does not by itself qualify any of those Jobs.
Local tests do not prove Cloud Run job configuration, live migration match, GCP
execution, or private daily HTTP readback. Production Cloudflare remains
unchanged.
