---
title: A2 synthetic daily publication review
date: 2026-09-25
type: plan
status: partially-executed-private-read-failed
---

# A2 synthetic daily publication review

## Status and boundary

The approved A2 test was partially executed on 2026-09-25. The prepare Job
committed the synthetic fixture and advanced collection controls from revision
2 to 3. The publisher committed immutable daily aggregate revision 1 with
`usageEvents: 1`. The authenticated private HTTP verification failed: its
validator returned `RESPONSE_INVALID`, and the service request returned HTTP
503. The independent restore Job then succeeded and returned controls to
revision 4, with enrollment and publication disabled. The retained synthetic
fixture and aggregate remain in the test schema. This is not a successful
private-read journey.

The service and Job source identities differed: the Jobs used
`synthetic-community-source` / `synthetic-community-namespace`, while the
private service was configured with `canonical-v1-primary` / `telemetry-v1`.
The route reads using the service-configured identity. This mismatch is a
code-supported likely explanation for the HTTP 503, but the request log did not
emit a separate root-cause code. Production Cloudflare was unchanged. See the
[partial-run receipt](../receipts/2026-09-25-gcp-a2-daily-publication-partial.md)
for execution IDs and retained database evidence.

Service revision `00041-7wg` and all three daily Jobs used the same immutable
migration-44 test image. The [partial-run receipt](../receipts/2026-09-25-gcp-a2-daily-publication-partial.md)
records its complete source, archive, build, and image identities. A fresh
database backup succeeded as ID `1790364143226` before fixture and control
writes. The current migrated schema is primary 44/44 and independent erasure
ledger 6/6. The test publication policy was
`publication_state=updating`, `policy_revision=1`; the publisher receipt's
`allowanceState=updating` is a separate output field. Revised local PostgreSQL
17 checks passed 11/11.

A second private-read proof was later completed under the separately approved
[retry review plan](./2026-09-25-a2-private-daily-read-retry-review.md). Its
[receipt](../receipts/2026-09-25-gcp-a2-private-daily-read-retry.md) records
the successful authenticated read and controls restored to revision 6. The
first test's fixture and aggregate remain retained; no GCS object was created,
and no Cloudflare resource or production data was changed. The original
15→16→17 proposal remains historical only.

## Fixed target and current evidence

The test target was project `tibotattle`, region `us-east1`, Cloud SQL primary
`tibotattle-test-primary-20260922`, database `tibotattle`, schema
`tibotattle_v12_a2_20260925`. The private service is
`tibotattle-test-app`; the daily Jobs are
`tibotattle-community-daily-prepare-test`,
`tibotattle-community-daily-publish-test`, and
`tibotattle-community-daily-restore-test`. Production Cloudflare remained the
serving system, and the maintenance Scheduler was paused during the test.

Before the first A2 write, the read-only preflight found all 16 fixture
preconditions empty. Controls matched revision 2: degraded, enrollment off,
upload registration on, processing on, publication off, reason
`synthetic_v12_test_upload_only`. The publication policy was
`publication_state=updating`, `policy_revision=1`. The A2 candidate's revised
preflight accepts `updating` or `ready` at exact policy revision 1; the
publisher receipt reports `allowanceState=updating`. These are separate policy
and output fields.

At 18:51 UTC, migration execution
`tibotattle-test-database-migrate-mnrrn` completed primary migrations 44/44
through `0044_accountless_import_claim_erasure.sql` and independent ledger
migrations 6/6. The successful fresh backup before the A2 fixture/control write
was `1790364143226`. Service revision `00041-7wg` and all three daily Jobs used
the same immutable image. The [partial-run receipt](../receipts/2026-09-25-gcp-a2-daily-publication-partial.md)
records the complete source digest, archive SHA-256, Cloud Build ID, and image
digest. The Jobs used the exact A2 synthetic source pair and day `2026-09-25`.

An independent read-only probe after restore found exactly one retained
aggregate for the synthetic source and day: revision 1,
`collection_revision=3`, `policy_revision=1`, release state `published`, source
authority epoch 0, cursor sequence 0, and a payload digest present. Controls
were at revision 4, degraded, with publication off. The private service's
runtime source identity was `canonical-v1-primary` / `telemetry-v1`. The private
daily route reads the source selected by these service environment values.
This mismatch and the HTTP 503 are consistent with the route's source read
fence, but the request log did not report a separate root-cause code. The
synthetic aggregate itself was committed successfully. The later migration-41 receipt
and earlier Job image readbacks are historical and do not supersede the
migration-44 or A2 execution evidence.

## Approved synthetic fixture and publication result

The source identity is the configured synthetic pair
synthetic-community-source / synthetic-community-namespace, used only in this
private schema. It is test data, not production source authority, owner
history, or evidence of a Cloudflare transfer. The requested day is exactly
2026-09-25; no range or other source is eligible.

Before the first write, the read-only preflight found all 16 fixture
preconditions empty, including the source/admission/cursor fences and the
selected-day publication inputs. The successful prepare execution committed
this minimal insert set, shaped after the passing local PostgreSQL 17 fixture:

| Table family | Rows | Purpose |
|---|---:|---|
| typed_telemetry_namespaces | 1 | Synthetic namespace shared by both admission fences. |
| typed_v1_admission_state, typed_v11_admission_state | 1 each | Current v1 and v1.1 contract-version-1 fences for that namespace; next source-row ID is 1 in both. No v1.1 records are seeded. |
| storage_source_state | 1 singleton | Configured synthetic source ID at authority epoch 0; singleton must be absent beforehand. |
| analytics_source_cursors | 1 | Same source ID at sequence 0 and authority epoch 0. No ingestion-change or applied-event history is invented; sequence 0 is caught up only because this exact source journal is empty. |
| Social owner/device: participants, web_sessions, device_pairings, device_credentials, device_upload_authorizations | 1 each | One active synthetic social owner and device, plus a consumed synthetic upload authorization, matching the local fixture. No accountless owner, enrollment, or authorization row is created or changed. |
| pending_objects | 1 metadata row | Content-free synthetic object key matching the v1 chunk metadata. This is a database reference only; no GCS object is created. Scheduler pause prevents unrelated reconciliation against it. |
| telemetry_v1_chunks, telemetry_v1_records | 1 each | One active usage chunk and one content-free usage event dated 2026-09-25; one record with synthetic provider/model labels and fixed token counts. No prompt, response, command, or session content. |

No telemetry_v11 day data was added. No v1.2 table was seeded, relabeled,
reused, or included in the daily result. This direct synthetic fixture
qualifies only the v1 daily projection; it does not qualify that v1 event's
authenticated upload or Cloud Storage ingestion journey. A separate v1.2
upload, activation, renewal, readback, and cleanup journey is recorded in the
[migration-41 journey receipt](../receipts/2026-09-25-gcp-a2-v12-migration41-journey.md);
that is separate evidence and does not change this fixture's provenance. The
first test opened the revised temporary gate at revision 3:
operational state, enrollment off, upload registration and processing on,
publication on, and reason `synthetic_daily_publication_test`. This enabled
publication in the database while enrollment remained off; the private read
still failed because the service identity did not match. The revision-2
degraded baseline is fail-closed for ordinary dispatch; the temporary gate does not
enable enrollment. The synthetic rows are inserted directly and bypass the
upload journey. The daily publisher and private reader use their separate
publication checks.

The publisher committed immutable daily aggregate revision 1 for this
synthetic source and day. Its receipt reported `usageEvents: 1`,
`activityState: partial_v1_v1_1_only`, projection scope
`v1_v1_1_only_v1_2_excluded`, and `allowanceState: updating`. The private HTTP
verifier did not confirm the publication: it returned `RESPONSE_INVALID`, and
the service request log showed HTTP 503. The identity mismatch is a code-supported likely explanation for the failure;
no separate logged root-cause code or successful private read is claimed.

## Historical and executed controls

The following table preserves the original proposal based on revision 15. It
is historical and was not used by this test:

| Revision | control_state | Enrollment | Upload registration | Processing | Publication | Reason |
|---:|---|---|---|---|---|---|
| 15 baseline | degraded | off | on | on | off | synthetic_v12_test_upload_only |
| 16 temporary test gate | operational | **off** | on | on | on | synthetic_daily_publication_test |
| 17 restored | degraded | off | on | on | off | synthetic_v12_test_upload_only |

The approved control sequence was executed as follows:

| Revision | control_state | Enrollment | Upload registration | Processing | Publication | Reason |
|---:|---|---|---|---|---|---|
| 2 baseline | degraded | off | on | on | off | `synthetic_v12_test_upload_only` |
| 3 temporary test gate | operational | **off** | on | on | on | `synthetic_daily_publication_test` |
| 4 restored | degraded | off | on | on | off | `synthetic_v12_test_upload_only` |

The prepare Job committed the approved fixture and opened revision 3 from the
exact revision-2 baseline. Enrollment stayed disabled. After publication and
the failed HTTP read, the independent restore Job succeeded and returned
controls to revision 4. Its readback confirmed enrollment and publication were
disabled. The durable fixture and aggregate remain for this private test.
An independent read-only database probe found exactly one aggregate for this
source/day: revision 1, collection revision 3, policy revision 1, release
state `published`, source authority epoch 0, cursor sequence 0, and payload
digest present. The same probe confirmed controls at revision 4, degraded,
with publication off.

## Execution record and failure boundary

Before the first write, the run verified the approved target and source/day,
the empty 16-item fixture preflight, the exact revision-2 controls, migration
44/44 plus ledger 6/6, the immutable image shared by service and all three
Jobs, and the successful fresh backup. The publisher Job had its write-capable
mode for this single approved invocation. The live steps then returned:

1. Prepare execution `b82lw` committed the listed synthetic fixture and
   advanced collection controls from revision 2 to revision 3.
2. Publisher execution `cz662` committed immutable daily aggregate revision 1
   with `usageEvents: 1` and `allowanceState: updating`.
3. The authenticated private daily HTTP verifier failed with
   `RESPONSE_INVALID`; the corresponding service request returned HTTP 503.
   The service used `canonical-v1-primary` / `telemetry-v1`, while the Job
   queried `synthetic-community-source` / `synthetic-community-namespace`.
4. Independent restore execution `pcthl` succeeded and returned controls to
   revision 4, with enrollment and publication disabled. The synthetic fixture
   and immutable aggregate remain retained.

No successful private daily read was observed in this first run. Its publisher
receipt alone did not prove the journey. The separately approved
[private-read retry](./2026-09-25-a2-private-daily-read-retry-review.md) later
completed that proof.

## Failure, restore, and retained data

The initial preconditions passed, the prepare and publisher transactions
committed, the private HTTP verification failed, and the independent restore
completed. Restore advanced controls to revision 4; it did not rewind the
revision or enable enrollment. The immutable daily publication row and tagged
synthetic fixture remain in the A2 test schema; no source-withdrawal or other
cleanup mutation was performed.

Any further attempt must stop if controls, service identity, migration
manifest, or fixture/publication state differs from its separately approved
plan. Restore must be independently invokable after preparation, publication,
or HTTP verification failure or timeout. It may change only the exact temporary
state to its next specified degraded/publication-disabled revision; an
unexpected revision or field must stop for owner review.

## Exposure and likely cost

The test service remained IAM-private throughout. While revision 3 was active,
the synthetic aggregate was present in the private database, but the only
authenticated `GET /api/v1/community/daily` verification returned HTTP 503.
The service identity mismatch prevented a successful response; no user-facing
read success is claimed. Restore returned collection controls to revision 4
with publication and enrollment disabled. No public Cloudflare endpoint or
production route was involved.

No new Cloud Run service, Cloud SQL instance, or bucket was provisioned. The
test used one prepare Job, one publisher Job, one restore Job, and an
authenticated HTTP check. No GCS object was created. Incremental Cloud Run
charges should be small for these short tasks; Cloud SQL compute was already
running and the added rows/WAL are tiny. Exact billing depends on configured
Job CPU/memory and current regional rates, so this remains a small-order
estimate, not a billing quote.

## Approval history and next gate

The initial 2026-09-25 approval described the historical 15→16→17 control
sequence. The owner later approved the exact test-only 2→3→4 effect used in
this partial run. That first approved effect is now spent: it created one
synthetic fixture and one immutable daily aggregate, then restored publication
to off. Its private HTTP verification failed while service and Job source
identities differed. The route read fence supports this as the likely cause,
but no separate root-cause code appeared in the request log.

The owner separately approved the later private-read proof: temporary service
source selection, controls 4→5→6, and immutable aggregate revision 2. The
[retry receipt](../receipts/2026-09-25-gcp-a2-private-daily-read-retry.md)
records its successful read and restored controls. This
[partial-run receipt](../receipts/2026-09-25-gcp-a2-daily-publication-partial.md)
remains the evidence for the first run's writes, failed HTTP read, and restore.
Production Cloudflare remains unchanged.
