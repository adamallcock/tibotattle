---
title: GCP source integration and production cutover gates
date: 2026-09-24
type: plan
status: in-progress
---

# GCP source integration and production cutover gates

## Boundary

This clean worktree starts at remote `main`
`d7186a61b006b2d873139cc0821371276763ec3f`. The earlier PostgreSQL/GCS
worktree starts at divergent commit `c4e16ab030ead9cbec0e00da42d83582d1f0fc86`
and contains uncommitted implementation and synthetic test evidence. Port its
reviewed behavior against this worktree's newer contracts; do not merge its
whole tree or present its private test image as a production build.

The accepted local PostgreSQL graph optimization improved the 10,000-record
synthetic median from 12,280.94 ms to 4,326.49 ms (2.84 times faster within
that local lane). Equal hosted Cloudflare and GCP work has not been timed.
The runtime-neutral quota hot-path optimization has been ported to this clean
checkout with independent legacy-result oracles; 125 focused quota tests pass.
The PostgreSQL reader/graph path remains subject to this checkout's runtime
port and has not inherited that benchmark result merely through the package
change.
An isolated, IAM-private GCP test image completed v1/v1.1/v1.2 processing,
publication, owner erasure, primary-only backup and restore, with the separate
ledger preserving erasure after restore. That receipt qualifies its exact
private test source, not this integration checkout or a live cutover.

## Integration work

| Area | Owner | Completion evidence |
| --- | --- | --- |
| PostgreSQL v1.2 reader and object transfer | Luna reader/object agent | Bounded v1.2 candidate, occurrence and day reads with real PG17 tests; synthetic object inventory/copy/checkpoint proof |
| Cloud Run host and generic transport authorization | Luna route agent | Exact-source build allowlist, loopback-only partial HTTP checks, grant issue/claim and format policy proof |
| Synthetic transfer and authority reconciliation | Luna transfer agent | Streaming/checkpoint/restart, table digests, rollback and fail-closed unmapped authority |
| Integration and release decision | Parent | Independent reruns, Worker/architecture/docs checks, exact-image test gate and explicit go/no-go |

Agents own disjoint files. The parent reviews their combined work and runs one
integrated gate after focused checks, so concurrent edits do not cause
repeated broad-suite runs. No production data, DNS or route changes are part
of this source integration. Synthetic GCS smoke objects in the private test
bucket were removed and the bucket returned to zero aggregate bytes.

The normalized v1.2 PostgreSQL extension uses the existing primary database,
schema and forward migration history. Migrations 0025 through 0030 follow the
24 previous primary migrations; the independent erasure ledger stays in its
separate database. Migration 0026 adds the current v1.2 domain day-list
representation while preserving older prototype winner bytes. Its deferred
foreign key retains a referenced day and permits full owner erasure in one
transaction. Migration 0027 blocks direct deletion of published normalized
records while the owner is active. This keeps the small zonal test topology and
does not imply that the new v1.2 path is routed or ready. Migration 0028 checks
declared chunk and record completeness when a manifest enters `ready`, permits
the older raw-only representation, and refuses mixed raw/typed storage. It
does not protect later ready-header changes, ready-to-staged transitions, or
deletion of a ready but unpublished manifest, chunk, record or child. A broader
persistent guard was rejected by automatic approval review because of possible
cleanup-workflow impact without validating tests; the remaining mutation
paths are a separate cutover review gate.
Migration 0029 adds D1-shaped v1 and v1.1 effective-source membership tables
with identity, lineage and retention guards. A PG17 regression proves
forward application and owner-erasure behavior. A follow-up review closed the
retention bypass, ordered publication locks participant, owner link, then head,
and tested the publication/erasure race against PostgreSQL 17. The immutable
terminal receipt retains only `owner_digest`. Migration 0029 refuses to apply
over a preexisting PostgreSQL owner link already marked `erased`, because the
older schema did not prove that state was terminal; such a target needs a
separately reviewed reconciliation. Direct owner-link deletion is refused
while its participant exists. A real participant cascade test removes both
v1 and v1.1 memberships while retaining the digest-only receipt. These tables
still have no migrated rows, effective reader or hosted route.
Migration 0030 adds a PostgreSQL base shape for the bound D1 typed legacy
v1/v1.1 family: source-keyed namespaces, owners, devices, manifests, chunks,
records, dictionary-backed identifiers and attributions, and usage/quota/
session children. It reuses the v1.2 dictionary and preserves source row IDs,
format, owner and manifest lineage. A live aggregate join exposed a critical
source-shape correction: 30 of 38 active v1.1 typed-owner memberships have no
`storage_v11_owner_links` row and account for 1,353,873 typed records. The
first PostgreSQL draft required that publication link for every typed owner;
the final base shape separates typed source identity from the optional owner
link, so it can represent live v1.1 owners without inventing publication or
erasure authority. A focused PG17 round trip admits
synthetic records in both formats and rejects cross-owner or malformed child
rows. It includes a linkless v1.1 record and verifies that one linked v1
receipt cannot release a shared owner while its v1.1 membership lacks proof.
Participant deletion with retained typed rows is deliberately blocked and
rolls back without losing those rows. Owner-link deletion while the participant
exists is also blocked, preserving the optional authority mapping. It has no
admission/proof transfer, effective reader, or explicit typed-owner erasure
adapter; linkless owner erasure has no qualified authority policy. Automatic
approval review rejected an implicit broad
participant-delete purge because it could irreversibly remove retained typed
source rows before the owner-erasure workflow was settled.
The remaining typed v1/v1.1 authority family is material: live D1 reports
5,122,773 v1 record-admission rows, 4,329,999 v1.1 record proofs,
27,577/22,823 format-specific chunk allocations, and 1,035 v1.1 manifest
memberships. Preservation proofs and authority requests also need mapping.
None has a PostgreSQL transfer or reconciliation receipt. A future importer
must preserve the exact source participant-to-owner mapping, leave missing
owner links unknown, and use a separately reviewed policy for linkless owner
erasure.

The generated PostgreSQL runtime receipt, migration runner, local Cloud Run
host and database build-context checks now agree on 30 primary migrations and
five ledger migrations. The focused 0029 and 0030 tests each applied the full
stream against disposable PostgreSQL 17. The private loopback host suite
passes 12/12 and the synthetic cutover rehearsal passes 13/13. The 25-to-26
forward test preserves legacy rows and admits the new day
representation. A local v1.2 round trip admits 2,049 normalized usage records
in bounded scans, pages effective usage without duplicates, reads quota and
session children, activates and replays a domain, checks an additive same-day
successor against the active head, refuses incomplete replacement and
published-row deletion, and verifies owner cascade erasure. Device bearer and
one-use upload-grant tests pass on PostgreSQL 17, including rejection when the
shared accountless v1.1 grant is revoked but its v1.2 grant remains active.
The independent PostgreSQL ledger adapter passes a PostgreSQL 17 test for
active and expired deletion tombstones, pending erasure-job authority,
monotonic retries, digest-only rows and sanitized failure responses. It is an
adapter, not a routed owner-erasure workflow.
PostgreSQL upload-authorization issuance now mints a five-minute,
digest-and-size-bound one-use credential after a locked device/participant
authority recheck. A PG17 round trip covers issue/claim, concurrent claim
refusal, expiry, revocation and the shared accountless v1.1 grant requirement.
The loopback-only v1.2 HTTP grant route now composes format authorization,
upload-registration control, independent-ledger tombstones and participant
rate limits. The generic v1/v1.1 issuance route and chunk-body ingress budget
remain unqualified.
The legacy transport audit found a v1.0 floor mismatch: D1 lets a device floor
override the participant floor, while PostgreSQL migration 0013's write trigger
uses the greater floor. A divergent floor must not mint a grant that its writer
will later reject; the trigger and authorization contract need a forward parity
decision and a real PostgreSQL test before v1.0 routing.
The local generic format-authority adapter now checks legacy lifecycle,
participant/device floors, v1.1 consent or shared accountless grant, v1.1
incompatible v0.2 history and v1.2 successor authority. A PG17 negative test
refuses the divergent v1.0 floor case before grant issuance. This is a policy
adapter only: there are no PostgreSQL v0.1 or v1.1 writer adapters, v0.2 is
policy-blocked, and none of those formats has a qualified hosted route.
The v1.2 parity audit found that PostgreSQL had rejected an exact chunk retry
after the manifest became ready, while D1 returned a replay receipt. The
admission adapter now accepts that exact replay and still refuses changed or
undeclared chunks; it also rejects empty manifests as D1 does. A PostgreSQL
17 regression test passes for those cases. The PostgreSQL effective reader now
also exposes bounded candidate paging, occurrence expansion and active-head
day enumeration. A PG17 test scans 2,049 records with repeated timestamps and
a cursor split, verifies successor-generation selection and refuses oversize
occurrence/day requests. These are v1.2 source primitives: the v1/v1.1 union,
mixed-format precedence, owner-revision checkpointing and full analytics
orchestration remain unported. The narrower migration 0028 guard leaves ready
manifest headers mutable by direct SQL, as noted above.
Migration 0029 introduces `typed_v1_event_sources` and
`storage_v11_event_sources` membership tables needed to prove which legacy
records are effective. The focused PostgreSQL 17 tests cover its receipt,
lock-order and participant-cascade safeguards; the source rows and reader are
still absent. Legacy candidate/occurrence/day readers remain unavailable
until the D1 membership rows are transferred and reconciled; merely scanning
raw v1/v1.1 records could resurrect superseded evidence.
The bounded synthetic transfer rehearsal passes 13/13 tests. It imports 14
normalized v1.2 tables: dictionary, manifests, chunks, attributions, records,
three child tables, runtime, device capability and four domain tables. Source
and destination counts and digests match; restart, injected-batch rollback,
foreign-key and authority refusal checks pass. A failure between the typed
runtime and legacy runtime mirror updates rolls back both changes and retains
an empty checkpoint. Accountless v1.2 authorizations remain explicitly
refused until their parent authority families can transfer. A source-side
preflight checks the enrollment, participant, device, owner, shared v1.1
grant, v1.2 grant, floor and issuance-counter chain before obtaining a
PostgreSQL connection; it distinguishes broken and revoked chains from an
otherwise-valid chain that still lacks PostgreSQL trigger parity. The
empty-parent case also requires the global issuance singleton to exist and
show no prior issues; an orphaned issue counter or token is refused. The
host still refuses startup because the complete Worker request path is not
bound to PostgreSQL. These checks do not qualify or update the deployed
private GCP test image.

A separate synthetic-only R2-to-GCS object-transfer rehearsal now tests
bounded chunk streams, create-only destination writes, generation-pinned
read-back, checkpoint resume, retry and uncertain-commit adoption. Six focused
tests pass, including regressions for literal `__proto__` metadata, truncated
source streams, inventory drift before an early checkpoint and immutable
generation checks on resume. A provider bridge now exposes a Workers R2
binding source and a generation-pinned, create-only GCS destination. After an
independent review found a large-object progress gap, the bridge gained an
idle read deadline, resumable Range recovery within an 8 MiB block, and an
8 KiB metadata limit; 20 mock-provider checks pass. A live synthetic GCS
test in the private app bucket wrote and read generation-pinned bytes,
verified create-only conflict preserved the first object, accepted then
cancelled an 8 MiB incomplete upload without creating an object, and recovered
a deliberately lost 308 upload response through a real GCS status query before
finishing and reading back an 8 MiB-plus object. Every synthetic object was
deleted and the bucket returned to zero aggregate bytes. The live smoke also
found and fixed a Fetch 308 redirect-handling defect in the bridge. This
qualifies only those narrow destination operations. Real R2 reads,
multi-object GCS paging, large/slow live transfers,
source write freeze/snapshot, database-reference mapping, and a copied-object
receipt remain unqualified. The core adapter's immutable generation behavior
under concurrent replacement remains mock-tested.
An [R2 API review](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
found that list results include HTTP and custom metadata only when those
fields are explicitly requested. The R2 binding adapter and local source
harness now request both fields, and focused provider checks assert that
request. The local harness starts a loopback-only Wrangler Worker with a
[remote R2 binding](https://developers.cloudflare.com/workers/local-development/bindings-per-env/),
uses a short-lived local bearer, validates version-pinned list/read responses,
and composes the existing transfer with a private crash-durable checkpoint
store and an optional content-free receipt. Its synthetic HTTP/composition,
provider and rehearsal checks pass 32/32. No live R2 object has been listed,
read or copied, so the 57,300-object production bucket still has aggregate
statistics but no copied-object reconciliation receipt. A read-only live
launch attempt found that Wrangler remote bindings require
`CLOUDFLARE_API_TOKEN` in this non-interactive harness; the approved Wrangler
OAuth session alone did not launch it. [Cloudflare's Wrangler authorization
guide](https://developers.cloudflare.com/workers/authorization/) says its
login OAuth flow does not support granular authorization; a separately scoped
account-owned API token is the supported way to grant narrow permissions.
The harness therefore still needs a qualified credential path and a live read
smoke before a transfer run. The
existing transfer accepts one
slash-terminated prefix per run. Current object producers use at least
`synthetic/` and `telemetry/`, so a full sweep must discover every prefix and
reconcile the union of database object references with the complete R2
inventory. The [GCP Storage Transfer Service S3-compatible path](https://docs.cloud.google.com/storage-transfer/docs/create-transfers/agent-based/s3-compatible)
is a possible
bulk-copy alternative but lacks this bridge's R2 version-pinned per-object
receipt and needs a separate freeze/reconciliation design.
An audit found that quarantine orphan reconciliation omitted
`telemetry_v12_chunks` from both its reference read and atomic orphan claim.
The local source now includes that reference, with synthetic regressions for
an already committed chunk and a reference inserted between the preliminary
read and claim. The retention sweep still excludes v1.2 chunks: there is no
approved age-based deletion policy or `quarantine_deleted_at` state for that
format. No live reconciliation or copy has run.
The inverse race is now fenced locally by forward D1 migration
`0010_v12_quarantine_admission.sql`: a new v1.2 chunk requires an exact pending
object registration still in `registered` state. Seven focused tests cover
admission, missing/mismatched/deleting registrations and transaction rollback.
Usage activation pins the migration ledger hash and trigger. The historical
source-pinned migration operator ends at `0009`; `0010` needs a separately
reviewed forward application and receipt after `0009` in the ordered D1
stream. The production D1 schema has not been changed.
The PostgreSQL pending-object journal now has a separate, source-only
reconciler. A focused PostgreSQL 17 test passes for committed-reference
preservation, exact journal cleanup, late object creation, a lost delete
acknowledgement, legacy or null leases, and competing reconcilers. It scans at most
100 aged registrations per call and waits two safety windows before deleting
an unreferenced object; the default window is 24 hours and the minimum is one
hour. No host invokes or schedules it yet, and it has not run against live GCS.

A newly ported GCP fixture requires Node filesystem access, so it has a
separate Node gate; its two tests pass with
the provider-effective analytics finish functions ported to current main.
Four focused source-continuity tests, Worker typecheck and architecture checks
also pass. These tests are not a hosted GCP qualification.
After the local admission-guard edits, six Worker failures exposed two v1.2
synthetic fixtures that staged chunks without registering their quarantine
objects. Those fixtures now register the exact object before chunk admission.
The full Worker rerun passes 1,987/1,987 tests across 156 files. Separate
PostgreSQL 17 domain, transfer, and object-reconciliation checks also pass
after their synthetic fixtures were updated for the current consent and
quarantine-admission contracts.
The broad root suite is not green: it reports reviewed-model catalog assertion
failures in untouched files, and the protected R7 release receipt is stale
against the changed quota workload source. The focused PostgreSQL and Worker
checks must remain separate from that release gate.

The request router remains the principal application gap. Cloud Run currently
provides PostgreSQL primary and erasure-ledger pools plus GCS objects, but its
normal startup and Worker dispatch both deliberately return unsupported. An
explicit `health-only` mode starts a loopback-only local host and dispatches
only `GET /api/health` to both PostgreSQL pools. A second explicit
`health-and-v12-day-manifest` mode permits that health route,
`POST /api/v1/device/telemetry/v1.2/day-manifests`, and v1.2-only
`POST /api/v1/device/upload-authorizations`, and v1.2-only
`POST /api/v1/contributions`. It checks both PG17 migration
receipts and composes PostgreSQL rate limits, device authentication,
independent-ledger tombstones, current v1.2 authority and collection controls
before issuing a digest-and-size-bound grant. The manifest route bounds the
body and returns the staged-chunk vector. The contribution route validates the
encrypted envelope, claims the one-use grant, registers its pending GCS object,
stores the encrypted bytes, and commits the typed chunk. It reads back exact
replays without another object write and keeps registered objects available
for reconciliation when a GCS acknowledgement is lost. Every other route
fails closed before Worker or D1 access. The local host suite passes
12/12, including real PG17 health, manifest replay, grant issuance/revocation,
one-use claim refusal and negative auth, body, control and host checks. Both
partial modes require `127.0.0.1`; neither can listen on Cloud
Run's `0.0.0.0` interface or qualifies a hosted GCP service. Rechecking both
migration receipts on each partial-route POST is a local correctness gate, not a
production throughput design. An independent route review found that the
PostgreSQL v1.2 authority check initially omitted D1's base-consent gate.
It now requires social `privacy-safe-telemetry-v0.1` consent or null
accountless consent, with D1's `400 TELEMETRY_REQUIRED` response. A real
PostgreSQL 17 regression checks grant issuance and chunk persistence while
the v1.2 device capability remains accepted. The focused test passes.

This is a local v1.2 admission slice, not the complete application. Device
enrollment/refresh, v1/v1.1 contributions, effective mixed-format reads,
analytics publication, and owner erasure still have D1-owned routes or missing
PostgreSQL adapters. Scheduled maintenance and public graph publication also
use separate D1 ingestion/analytics roles. The existing Cloud Run service is
IAM-private but runs an older image. The test deployment gate pins the
`tibotattle` `us-east1` service and image repository, checks the local source
context and read-only Cloud Run/IAM state, and rejects public invoker bindings,
a disabled Invoker IAM check, or traffic not wholly on the latest ready and
created revision. Its dedicated tests pass 10/10. A read-only live check found
the service Ready with no public invoker and unauthenticated GET denied with
HTTP 403; it did not deploy an image. An independent audit showed that a Cloud
Build tag and service environment digest do not prove the built bytes came
from the reviewed local context. The gate now reports
`SOURCE_PROVENANCE_UNQUALIFIED` and refuses deploy before any `gcloud` write;
read-only preflight/verify cannot claim exact-image success or run the hosted
smoke until that proof exists. The host also remains loopback-only. Automatic
approval review rejected the proposed `cloud-run-iam` mode that would bind
`0.0.0.0` and accept its HTTPS origin without sufficient IAM-enforcement
proof. No network boundary was broadened.
To clear the provenance blocker, package the already validated source context
as one archive, hash its exact bytes, and upload it to a create-only GCS object
with a pinned generation. Submit a fixed Cloud Build request using that
generation, a pinned builder and service account, requested SHA-256 source
hash, and verified provenance. The [Cloud Build API](https://docs.cloud.google.com/build/docs/api/reference/rest/v1/projects.builds)
exposes the resolved storage source and source-file hash; compare both against
the local archive, then use the build result's immutable image digest for
Cloud Run read-back. Recompute the canonical source-content digest from the
same archive before submission. The [provenance guide](https://docs.cloud.google.com/build/docs/securing-builds/generate-validate-build-provenance)
describes verified provenance for Artifact Registry images. No such build or
archive upload has run for this integration revision.

The separate typed legacy transfer rehearsal now pages the 14 D1-shaped base
tables from a cloned synthetic in-memory fixture into PostgreSQL 17, including
v1 and v1.1 owner memberships and D1 BLOB byte-array conversion. It uses a
dedicated rehearsal control schema, transactional checkpoints, rollback/resume
and source/destination count and digest read-back. Six focused tests pass,
including linkless v1.1 membership, repeated participant identity,
changed-source refusal and bounded page behavior. The transfer runner accepts
only the private synthetic-fixture source; a generic D1 adapter cannot label
itself as an immutable source. The runner also requires a dedicated rehearsal
target schema and refuses ordinary application schemas before any destination
query; this protects against accidental targeting, not deliberate use of that
prefix in a production database. Dictionary parity is explicitly scoped to
source keys, so a preexisting destination dictionary row does not masquerade
as whole-table equality. Live mutable D1 and an unverified export are refused:
the source still needs a verifiable frozen export, and the other legacy
admission/proof/effective-reader families remain untransferred. The rehearsal
is not production cutover authorization.

The shared quota hot-path change touches the R7 workload source set. Its
retained release receipt was already stale at this branch's base revision;
the new source changes its hash again. The focused quota suite passes, but
R7 release evidence remains a separate protected qualification gate. Do not
rewrite its receipt or weaken its tests as part of this GCP integration.

## Observed production boundary

The active Worker deployment list and version view show 100% traffic on
`a2c8a0c4-bedc-48fd-8b01-345b316c02a2` (version 152, created
2026-09-23T17:08:35Z). Its opaque script ETag is
`5da4105966d5035d3820e08ed0070984325c828276436a7453106b9cf2782052`.
The version-specific bindings include ingestion D1 (`USAGE_MONITOR_DB`),
analytics D1 (`ANALYTICS_DB`), independent deletion-ledger D1
(`DELETION_LEDGER`), quarantine R2 (`QUARANTINE`) and release-artifact R2
(`SPARKLE_RELEASES`); the legacy primary D1 is not bound. Live settings select
typed telemetry. The declared source commit is
`5038123904196de675bdc9482acf026cad5038bf`, but the opaque ETag and manual
Wrangler upload do not prove that this source commit produced the script. The
live settings and bindings differ from checked-in Wrangler configuration.
After explicit user approval, Wrangler OAuth was refreshed with D1 write
scope to access the inventory. Only read-only metadata and `SELECT` queries
were run; every reported query had `rows_written=0`. Public health returned
HTTP 200 and reported the same source commit with reachable primary,
deletion-ledger and quarantine dependencies; that self-report does not replace
a script build receipt or content-free database/object reconciliation.

Read-only schema inspection found 326 tables across four D1 databases, with 93
application names occurring in more than one. Aggregate source inventory on
2026-09-24 found the bound ingestion D1 at about 6.12 GB with 9,452,772
`typed_telemetry_records`: 5,122,773 format 10 (v1) and 4,329,999 format 11
(v1.1). Its normalized v1.2 manifests, chunks, records and domain heads are
all empty. The same source has 1,035 legacy typed manifests, 50,315 legacy
typed chunks, 27,577 v1 effective-source memberships, 10 v1.1 memberships,
69 participants, 73 device credentials and five accountless v1.2 device
authorizations. Counts are a moving, non-atomic observation, not a snapshot or
reconciliation receipt. A matching typed v1.2 PostgreSQL adapter exists
locally, alongside an older raw prototype; the 9.45-million-row legacy typed
family still lacks a complete transfer and effective reader.
The legacy typed family also has 4,117,373 usage rows, 5,335,245 quota rows,
163 session-tool rows, 34,597 dictionary-backed identifiers, and one-to-one
v1 record-admission and v1.1 record-proof rows. This is a multi-table
lineage-preserving migration, not a single record copy.

The active analytics D1 is about 667 MB and has 1,703 graph result rows, 296
daily publications, one source cursor and 26 owner-state rows at inventory
time. The independent ledger has five tombstones and two storage-erasure jobs.
The bound production quarantine R2 bucket reports 57,300 objects and 7.92 GB;
these aggregate bucket statistics do not identify the referenced object set
or prove a stable copy. The release-artifact bucket has 196 objects and 12.7 GB
and needs a separate hosting decision rather than automatic inclusion in
the telemetry object transfer.
The unbound legacy primary D1 is about 10.0 GB and retains 4,107,535 raw v1
records and 1,655,554 raw v1.1 records. Its latest observed v1/v1.1 timestamps
were 2026-09-08 and 2026-08-24, respectively, versus 2026-09-24 and
2026-09-23 in the bound typed source. This suggests a historical role but does
not establish complete overlap or authorize omission. Its rows need a
content-free lineage comparison and an explicit retention decision.
For v1, the old raw table has 4,107,535 rows through ID 5,352,417, while the
bound typed table has 4,104,654 v1 `source_row_id` values in that numeric
range. The 2,881-row count difference is not an identity comparison, but it
rules out treating matching ID ranges and later typed timestamps as proof of
a complete copy. Cross-database observations were not atomic.
Cloudflare's documented [10 GB per-database D1 limit](https://developers.cloudflare.com/d1/platform/limits/)
means the legacy primary is approximately at that ceiling; the bound ingestion
database is already about 61% of it. The `file_size` metadata is a capacity
signal, not a live-data or export-size measurement.

Identity, grants, retained telemetry, corrections, analytics cursors and
publication, owner erasure and tombstones, and referenced quarantine objects
all require explicit source-to-destination mapping and reconciliation. The
bounded synthetic importer covers seven v1/v1.1 tables, 14 v1.2
normalized/runtime/domain tables and selected pending-object references. In
this checkout, a local PostgreSQL 17 rehearsal transferred 1,256 synthetic
source rows (78,757,502 source bytes) in 41 committed batches, including an
interrupted-batch rollback, checkpoint resume, persisted read-back, repeat
refusal and one eligible active domain head. Accountless v1.2 authorization
remains untransferred, as do other identity, analytics, ledger and object
families.
PostgreSQL lacks the D1 admission/floor triggers for that accountless chain,
and the global enrollment-issuance singleton requires its own qualified
cross-backend transfer. A synthetic valid chain is still refused with
`CUTOVER_ACCOUNTLESS_AUTHORITY_SCHEMA_PARITY_UNQUALIFIED` rather than copied.
The importer reports `fullCutoverReady=false` and cannot import production.

## Observed GCP test boundary

A read-only Google Cloud Console inspection on 2026-09-24 found one healthy
Cloud Run service, `tibotattle-test-app`, in `us-east1`. Its ingress is `All`
and it requires Google IAM authentication; no anonymous or all-authenticated
invoker binding appeared. It has no direct service-level IAM grants; project
Owner and Editor roles remain inherited invocation paths. The deployed image
digest is `sha256:5706640597336e002b49919b920017d08f9b39b4de2644e1cee4de012557a188`,
not a receipt for this worktree. The service uses 1 vCPU and 1 GiB RAM.

The test primary and independent ledger are PostgreSQL 17.11 Cloud SQL
Enterprise instances in the single `us-east1-c` zone. Both have 10 GiB SSD;
the primary has 1 vCPU and about 1.7 GiB RAM, and the ledger has 1 vCPU and
about 0.63 GiB RAM. IAM database authentication, backups, point-in-time
recovery and deletion protection are enabled. Public IP is enabled and
private IP is not configured. The three inspected GCS buckets are in
`us-east1`, Standard class, uniform access, and not public. This is test
infrastructure and does not qualify production cost, traffic or failover.
The primary has automatic storage growth disabled. With a 6.12 GB active
ingestion D1 source plus indexes, analytics, and any retained legacy-primary
lineage, the existing 10 GiB test disk is not a qualified full-corpus target.
Measure PostgreSQL expansion during a bounded rehearsal before increasing it;
no Cloud SQL storage setting changed in this pass.
The test app GCS bucket reports zero aggregate object bytes after the synthetic
destination smoke cleanup. It has not been populated with the 7.92 GB
production quarantine set.

The local `gcloud` CLI has an active account and can read the test service
when commands specify `--project tibotattle`; its default project is unrelated.
The CLI returned ready revision `tibotattle-test-app-restore20260924` in
`us-east1`. No cloud setting was changed in this source-integration pass.
The existing IAM-private test service still requires an exact-image deployment
and hosted readback for this source. The partial PostgreSQL host remains
loopback-only and cannot be deployed to Cloud Run.

## Release and activation gates

1. Reconcile current-main v1.2, effective-reader, analytics and erasure
   contracts with the PostgreSQL implementation. Preserve closed schemas,
   replay safety, owner authority and fail-closed forward migrations.
2. Build and test a clean integrated revision. Run Worker, PostgreSQL,
   portable-contract, architecture, documentation and release-stage checks,
   plus the full private GCP journey on the exact new image.
3. Pin the deployed Cloudflare artifact/configuration, finish a content-free
   table and object inventory, then obtain a consistent source snapshot and
   digest evidence for every active D1 source. Determine the unbound legacy
   primary's lineage and disposition before omitting it. The current aggregate
   counts are a first inventory, not snapshot proof.
4. Implement and rehearse complete v1/v1.1/v1.2, identity, analytics and
   independent-ledger transfer with bounded streaming, checkpoint/restart,
   source/destination reconciliation and rollback. Copy the classified R2
   object set to GCS, compare bytes and metadata, and remap read-back GCS
   generations. Do not treat a copied object set as database-reference proof.
5. Size separate zonal production databases and storage from measured data;
   qualify public/admin ingress, Access assertions, direct-origin refusal,
   client callbacks, rate limits and production costs. The small IAM-private
   test deployment does not qualify public ingress or a hosted 10,000-record
   graph throughput target.
6. Only after an exact rollback point, writer freeze, final delta and complete
   read-back should production routing or client configuration change. Account
   for writes accepted on GCP before any reversal.

**Production decision: no-go.** The clean source integration and the complete
live transfer/reconciliation do not yet have receipts. The previous Worker and
its data remain the serving system.
