---
title: GCP source integration and production cutover gates
date: 2026-09-24
type: plan
status: in-progress
---

# GCP source integration and production cutover gates

## Boundary

This integration worktree started at remote `main`
`d7186a61b006b2d873139cc0821371276763ec3f`. The earlier PostgreSQL/GCS
worktree starts at divergent commit `c4e16ab030ead9cbec0e00da42d83582d1f0fc86`
and contains uncommitted implementation and synthetic test evidence. Port its
reviewed behavior against this worktree's newer contracts; do not merge its
whole tree or present its private test image as a production build.
The branch later merged remote `main` at `db470190`; the exact private test
image and receipt described below apply only to the allowlisted Cloud Run
source archive, not to a production Worker build.

### Latest test-project checkpoint: 2026-09-25

#### Cutover gate board

This is an implementation and test-project checkpoint, not a production
activation decision. The following gates must be satisfied against the exact
candidate revision and source snapshot before moving live traffic:

| Gate | Evidence now | Still required |
| --- | --- | --- |
| Private GCP data plane | Zonal Cloud SQL primary and independent erasure ledger, GCS, IAM-private Cloud Run, and a cleaned-up synthetic v1.2 journey at primary 44/44 and ledger 6/6, most recently for [candidate `9c2a5861`](../receipts/2026-09-25-gcp-reconciled-candidate-journey.md) | Requalify each later integrated revision; preserve exact-owner erasure and restore behavior |
| Application routes and identity | The separate narrow test OAuth gateway is deployed and public, invokes the IAM-private backend, and passed synthetic callback-log probes; the private host serves sessions, logout, pairing mint, Google handoff and enrollment in addition to the v1.2 path | Register a dedicated test OAuth client and user, prove browser sign-in/enrollment and device claim, then complete or retire remaining Worker routes and the production composition root |
| Historical source transfer | Sealed local rehearsals cover several typed source, journal, correction, and ledger families | Export and reconcile the real D1/R2 snapshot under a source fence, import exact history and objects, and prove no admitted writes are lost or duplicated |
| Public analytics and maintenance | Read-only daily preflight is fail-closed; 100,000-member graph publishes in the isolated benchmark | Complete daily source/claim/cursor/publication lifecycle, full scheduled maintenance and public reads, then rehearse replay, rollback, and recovery |
| Performance and cost | One 100,000-member hosted graph run completed in about 284 seconds; batching preserved output but did not materially improve time | Run a matched Cloudflare workload and sustained GCP load, measure database saturation and cost, and decide the acceptable throughput target |
| Traffic switch | Production Cloudflare remains serving; private GCP test Scheduler is paused | Source-pinned deployment and full journey, controlled shadow/reconciliation window, explicit production authorization, cutover and rollback proof |

The route, transfer, and analytics rows are material blockers. A private test
service that accepts one synthetic upload is useful evidence but cannot serve
the complete application yet. The
[GCP handover readiness catalog](../reviews/2026-09-25-gcp-handover-readiness.md)
lists the requirements and owner decisions behind every row.

At this checkpoint, the Worker route registry defines 50 exact `/api/` paths.
A source-level comparison with the Cloud Run host and gateway finds 21 paths
without a corresponding literal host path, including Apple sign-in, v1.1 and
performance telemetry, export/security reset, release readiness, and the admin
surface. This is an inventory aid, not a runtime parity test: the test gateway
also intentionally withholds the public community-daily read even though the
private host has a handler. Before a traffic switch, classify each route as
ported, deliberately retained on a separate service, or retired under an
explicit contract, then exercise every client-visible path against the chosen
ingress. The [route parity review](../reviews/2026-09-25-gcp-route-parity-review.md)
makes that classification for all 51 registry contracts at candidate
`c388769b` (the 50 `/api/` paths plus the retired Apple association file),
confirms that the public test gateway forwards 18 of them, and ranks the
remaining work into five batches. It is a source review, not a live route test.

The [migration-41 A2 v1.2 journey](../receipts/2026-09-25-gcp-a2-v12-migration41-journey.md)
records clean-candidate qualification, a successful pre-migration backup,
41/41 primary and 6/6 ledger migrations, an exact-image IAM-private service,
and a fresh upload, activation, rotation and readback journey. Its one-owner
cleanup completed and replayed as `already_complete`; the isolated bucket
has no live or versioned objects. The serving image predates later integration
commits and does not qualify them.

The [migration-42 private journey](../receipts/2026-09-25-gcp-a2-migration42-journey.md)
records a successful pre-migration backup, 42/42 primary and 6/6 ledger
receipts, exact-image IAM-private revision `tibotattle-test-app-00038-qh2`,
fresh synthetic v1.2 upload and readback, and exact-owner cleanup with an
empty all-versions bucket. Migration 42's retention permit accepts only a
synthetic source; it does not import production D1 history.

The [migration-44 and gateway journey](../receipts/2026-09-25-gcp-migration44-gateway-journey.md)
records the exact-source test build, a successful pre-migration backup,
44/44 primary and 6/6 ledger receipts, a new IAM-private backend revision,
a public narrow gateway with callback request-log exclusion, fresh synthetic
v1.2 readback, and exact-owner erasure with an empty all-versions bucket.
Google OAuth client credentials and a real browser journey remain open.

The [restored-control gateway journey](../receipts/2026-09-25-gcp-restored-control-gateway-journey.md)
records a later exact image on both test services. A smoke rule tied to old
control revision numbers was corrected to check the exact synthetic upload-only
state after a publication rehearsal restored revision 4. The public-gateway
v1.2 upload/readback, exact-owner cleanup and idempotent replay passed, and
the isolated bucket again had no object generations. This remains a scoped
test journey, not browser sign-in or production route parity.

Source integration after that journey merges the migration-41 integration
line (`1470f041`) and the live-tested A2 retry (`8c8eead6`) into this
candidate; the A2 activation sources are byte-identical to `8c8eead6`. The
candidate also adds PostgreSQL analytics owner retirement and completes the
internal social owner eraser, which revokes authority, records the ledger
tombstone and pinned-secret identity cooldowns, deletes exact stored objects,
removes the participant, and then retires the owner's derived analytics, all
resumably. The internal accountless owner eraser now takes the same final
step: after its primary deletion commits it records a `primary_deleted` ledger
phase and retires the owner's derived analytics, and a retry after a refusal
or interruption resumes retirement from an `objects_deleted` or
`primary_deleted` receipt before recording completion. These are local
PostgreSQL 17 source results. None is routed, deployed, or live-qualified: no
Worker route, admin action, or Job invokes them; participants holding a
redeemed community grant are refused pending a grant-retention decision; and
retirement's owner-digest discovery and residual scans still need
qualification against a real transferred snapshot on the test primary. In
both erasers, a retirement refused while re-erasing a restored primary cannot
be recorded in the terminal ledger receipt, so a later retry for the absent
participant checks for remaining owner-scoped analytics and completes
retirement before reporting `already_complete`.

The test project's live cleanup Job, `tibotattle-v12-synthetic-cleanup`, is
built from `apps/worker/cloud-run/synthetic-v12-cleanup.mjs`, which calls the
separate synthetic v1.2 eraser rather than the accountless eraser; that eraser
does not retire analytics. Its recorded executions qualify only their pinned
earlier images, so requalify the Job against the exact candidate image before
any redeploy.

The deployed OAuth gateway is isolated to a small explicit route allowlist. It
pins the IAM-private backend URL and
ID-token audience, preserves the application `Authorization` header separately
from Cloud Run's `X-Serverless-Authorization`, ignores caller-supplied forwarded
and Cloudflare identity headers, limits request/response bodies and timeouts,
rejects redirects, and logs only a route enum, method, status, and duration.
The private host rebases only those four paths to its configured HTTPS
`PUBLIC_ORIGIN`; its service URL remains the only accepted incoming backend
authority. The gateway now has a dedicated runtime identity with backend-only
invocation permission and public test-service ingress. The live gate still needs
an exact OAuth callback registration, same-origin or API-base wiring from the
existing browser UI to this exact-route gateway, and an end-to-end journey
against the test backend. That UI wiring is a separate integration gate; this
gateway does not proxy unrelated paths. Before any real OAuth credential was
configured, an enabled, full-sample Cloud Logging request-log exclusion was
created and read back for the deployed gateway. A synthetic callback query
then left no request entry or fake marker in the project's logs; only the
content-free route event was retained. The project has no folder or
organization ancestor and only its built-in sinks. Recheck the logging route
if this configuration changes; any retained fake code or state blocks test
OAuth. The gateway sends callback parameters over the private hop in a
dedicated header, reconstructs the application callback URL inside the private
host, and strips that handoff header before dispatch; therefore the private
backend request URL stays query-free.
Cloud Run creates request logs automatically and directs operators to Cloud
Logging exclusions ([Cloud Run logging](https://docs.cloud.google.com/run/docs/logging)).
The exclusion API applies exclusions to the `_Default` sink and cannot exclude
entries from `_Required`
([Cloud Logging exclusion API](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/exclusions));
project and aggregated sinks or exported destinations must also be checked for
query persistence. Confirm the enabled filter matches 100% of Cloud Run request
logs for the exact deployed gateway service using
`resource.type="cloud_run_revision"`, its exact `resource.labels.service_name`,
and `log_id("run.googleapis.com/requests")`; inspect any returned request-log
entry's `httpRequest.requestUrl` field for the synthetic query markers
([Cloud Logging HTTP request fields](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry)).
If that readback cannot establish that callback query values will not persist,
keep test OAuth disabled. The backend remains IAM-private throughout this gate.

The [source-pinned private route candidate journey](../receipts/2026-09-25-gcp-private-route-candidate-journey.md)
now records exact-image revision `tibotattle-test-app-00035-ws7`, a passing full
Worker gate, a fresh synthetic v1.2 journey, and exact-owner cleanup. It
includes some recently committed private route work, but remains a partial
private host; later disconnect and transfer commits are not in that image.

The [migration-39 A2 v1.2 journey](../receipts/2026-09-25-gcp-a2-v12-migration39-journey.md)
now proves a fresh synthetic upload, exact replay, domain activation,
PostgreSQL/GCS readback, and exact-owner cleanup against the current private
test service. One pre-seed harness failure exposed a stale migration-version
assertion; the corrected smoke passed and the isolated bucket returned to
empty. The test Scheduler remains paused and production Cloudflare serves.

The [batched hosted graph receipt](../receipts/2026-09-25-gcp-graph-batched-hosted.md)
records a second exact-digest 100,000-member run on a fresh schema. Batching
cut SQL calls from 864 to 325, but measured workload time was 284.0 seconds
versus 285.4 seconds in the preceding single run. This does not qualify a
material hosted speedup or a tenfold Cloudflare comparison. Statement-level
PostgreSQL work is under investigation.

The [indexed hosted graph receipt](../receipts/2026-09-25-gcp-graph-readindexed-hosted.md)
records a completed, exact-digest 100,000-member synthetic run on the zonal
test primary: 186.3 seconds to publish and 47.3 seconds to read back, with
one checked-out database connection. Its read-only hosted plan uses indexed
bounded pages and no sort, resolving the earlier 120-second readback timeout
described in the [plan diagnosis](../receipts/2026-09-25-gcp-graph-readback-plan.md).
Publication batching was tested in the newer receipt above. A matched hosted
Cloudflare comparison remains open; neither run qualified a tenfold speedup.

The [A2 preflight-v2 receipt](../receipts/2026-09-25-gcp-a2-daily-preflight-v2.md)
records a source-pinned private image deployed after primary migration 38/38,
with independent ledger 6/6 and HTTP health current. The read-only daily
preflight identified absent source state, cursor, v1/v1.1 admission, and
selected-day records, plus disabled publication controls; the daily route
remained fail-closed. A synthetic activation and publication proof are the
next test-only gates.

The [A2 synthetic daily publication review](./2026-09-25-a2-synthetic-daily-publication-review.md)
defines the exact private fixture and temporary collection-control transition.
Automatic approval review initially blocked its write-capable runner. The
owner subsequently approved the exact test-only effect recorded in that
review. Execution required an exact-image qualification, live
preconditions, and a fresh backup; approval alone is not an activation or
publication receipt. The [A2 private daily read retry](../receipts/2026-09-25-gcp-a2-private-daily-read-retry.md)
then records a prewrite backup, immutable synthetic aggregate revision 2, an
authenticated IAM-private read of that exact day and revision, and controls
restored to revision 6 with publication and enrollment off. It is one
synthetic read, not public daily parity or a production test.

The private Cloud Run dispatch recognizes at most 16 of the 51 exact Worker
registry paths, plus one private test-only effective-page path. The other 35
registry paths include six identity handoff, six admin, nine session, and
eight device routes. The normal Worker request path still explicitly rejects
the PostgreSQL backend (`isPostgresWorkerRequestPathSupported()` returns
`false`). A complete traffic cutover therefore requires the remaining route
contracts, authentication and authorization, and public/admin ingress to be
ported and tested; private test health and a synthetic upload do not qualify
that switch. This is a source inventory at commit `b2dea68a`, not a live
public deployment observation.
Commit `26cdb519` subsequently adds private-host participant device
revocation with focused PostgreSQL 17 tests; it has not been deployed to the
test service. Commits `5beddc9c` and `a5531287` add the legacy device
sync-capabilities route and D1-equivalent PostgreSQL accountless participant
defaults, respectively, with local PostgreSQL 17 tests; they are not yet in
the serving test revision. The inventory above remains its named earlier
snapshot.

The subsequent [private daily and readpaged graph receipt](../receipts/2026-09-25-gcp-a2-daily-and-readpaged-graph.md)
records ready private revision `tibotattle-test-app-00031-lg7`, current
37/37 primary and 6/6 ledger migration health, and a guarded daily preflight
blocked by `SOURCE_FENCE_UNAVAILABLE`; no daily revision was published. A
fresh 100,000-member graph schema migrated to 38/38, but its exact-image
hosted run still timed out during a 4,096-row readback cursor fetch. The
publisher write timeout was resolved; hosted readback and a matched
Cloudflare speed comparison remain open gates.

The later [A2 rotation and graph diagnostics receipt](../receipts/2026-09-25-gcp-a2-v12-rotation-and-graph-diagnostics.md)
records primary migration 37/37, a source-pinned private v1.2 journey through
device credential rotation, exact-owner discovery/cleanup/retry, and an empty
isolated bucket after cleanup. It also records a completed 10,000-member GCP
graph benchmark and two separate 100,000-member hosted runs that each hit a
120-second timeout on the same publication insert. A bounded transactional
insert rewrite and fresh-schema hosted proof are in progress. No matched
hosted Cloudflare comparator or 10-times speedup has been established.

The earlier [A2 isolated v1.2 test-journey receipt](../receipts/2026-09-25-gcp-a2-v12-test-journey.md)
records a new primary schema, independent ledger schema, and bucket with a
recorded birth state, exercised through a source-pinned private Cloud Run
image. The real Cloud SQL
and GCS path passed synthetic v1.2 admission, replay, domain activation,
effective-record and exact-object read-back, then exact-owner discovery and
one-owner erasure. The owner-erasure result was checked against primary and
ledger state; a separate post-cleanup discovery found the owner absent, and
the bucket has no live or versioned objects. A retry returned
`already_complete`. A one-off maintenance probe completed its supported
identity-expiry and object-reconciliation scans but deliberately reported
unsupported lifecycle and analytics phases as incomplete; its run gate was
disabled again after the probe. The older
[migration 36 and hosted v1.2 receipt](../receipts/2026-09-25-gcp-test-graph36.md)
remains a separate earlier test snapshot for different schemas and bucket.
This A2 proof does not qualify public/admin ingress, scheduled work, general
owner erasure, production data transfer or a hosted graph speedup. The test
maintenance Scheduler remains paused; production Cloudflare remains the
serving system.

The sealed analytics applied-event v1 rehearsal can now write exact event
tuples to PostgreSQL's main `analytics_applied_events` table after the matching
sealed ingestion journal is imported. It binds the applied artifact's snapshot,
source ID, namespace digest, and source-cursor metadata to a resumable run;
before writing, it verifies the completed journal transfer receipt and compares
every shared D1 tuple field and checkpoint page hash. PostgreSQL 17 coverage
proves rollback/resume, changed-artifact refusal, incomplete or mismatched
journal refusal, and preservation of version-0 receipts. The PostgreSQL cursor,
owner state, and publications remain empty, so this is source-history staging,
not analytics activation or cutover. The journal artifact has no namespace
field: the namespace is pinned to the applied artifact but cannot be compared
across both sealed files under the current contract. No production D1 export or
remote write is part of this rehearsal.

The streamed PostgreSQL graph publisher, PostgreSQL accountless v1.2
enrollment/grant adapter, migration 36 and exact-owner discovery family
checks are integrated in this worktree. The accountless adapter is still
disabled in the hosted test service; opt-out/public-history parity and most
routes remain absent. The local 1,025-member graph regression is a bounded
correctness test, not a 10-times hosted throughput claim. The earlier
checkpoint narrative below is retained for source and recovery context;
this section supersedes its then-current deployment statements.

### 2026-09-25 integration checkpoint

At this earlier checkpoint the local integration had 35 primary and six
independent erasure-ledger PostgreSQL migrations. Primary migration 0035 closes
the direct ready-v1.2
mutation/deletion gap and permits a terminal owner-erasure cascade only when
that participant's owner link transitions to erased and its matching receipt
is inserted in the same transaction. PostgreSQL 17 regressions cover both a
linkless owner and a previously erased link trying to borrow another owner's
fresh receipt in a mixed deletion; both fail closed. A ready
v1.2 owner without that link still fails closed during deletion;
ledger migration 0006 adds D1-shaped authority guards and sealed, restartable
transfer evidence. Both passed disposable PostgreSQL 17 regressions. A
proposed named-target ledger migration 0007 remains outside the executable
migration chain: automatic approval review rejected the proposed wrapper for
reading a private sealed ledger export and sending its rows to the named GCP
test database. No private ledger rows were transferred, and no dedicated
transfer identity was provisioned. The
generated runtime schema, migration runner, and reviewed build contexts
agreed on those migration tails. The newer migration 36 and private test
deployment are recorded above.

Local sealed-source transfer coverage now includes typed v1/v1.1 base rows,
event-source memberships, admission/proof families, usage-correction history,
analytics owner-state/source cursors, and the independent erasure ledger.
The typed-only effective reader has a PostgreSQL 17 fixture with no obsolete
raw-record rows. Analytics transfer is deliberately partial: event history,
results, work, and publications are not representable and remain blocked.
No live D1 export, R2 object copy, source freeze, or end-to-end production
reconciliation has occurred. The test-only transfer importers do not by
themselves establish a production activation path.

The Worker registry has 51 exact routes. At this checkpoint the deployed
private GCP host served health and three v1.2 upload routes. The local source
added bounded
device sync-state, v1.2 sync-capability, envelope-key and day-manifest reads,
which were subsequently deployed to the test service. The full public,
desktop, admin, scheduled, and owner-erasure application path is still absent.
The earlier exact-image hosted v1.2 synthetic journey applied only to
its older 30-primary/five-ledger image. On-demand backups completed for
the named GCP test primary (`1790311919040`) and ledger (`1790312021531`)
before the pending forward migration. The live Cloudflare Worker still serves.

The Cloudflare scheduled path is a cutover gate, not a background detail. Its
one-minute maintenance lease runs required identity, retention, restore and
object reconciliation phases before optional analytics. The analytics path
delivers ordered source journal entries, then calculates and publishes public
days and graph work with durable claims, checkpoints and authority rechecks.
The PostgreSQL graph module then stored and read supplied precomputed
model-day cohorts. The later streamed publisher adds bounded selection and
calculation, but scheduled delivery and the complete public serving path
remain unqualified. A successful GCP synthetic upload cannot qualify a public
graph or a complete application cutover.

The local private host now routes
`POST /api/v1/me/telemetry-v12/domain-predecessor` and
`POST /api/v1/me/telemetry-v12/domain-activate` through the PostgreSQL domain
adapter. The disposable PostgreSQL 17 HTTP test covers predecessor creation,
ready-day activation, replay, active-head read-back and tombstone refusal.
These routes were later deployed to the private GCP test service; the latest
hosted smoke also proves effective-record read-back. Legacy v1/v1.1
writers and authority transfer remain separate follow-on work.

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
of this source integration. Synthetic GCS transfer-rehearsal objects in the
private test bucket were removed. Later hosted v1.2 smokes retained tagged
synthetic database and object fixtures for exact owner-erasure validation;
that earlier bucket retained those fixtures. The isolated A2 bucket in the
latest checkpoint above was created empty and returned to empty after its
exact-owner cleanup.

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
the older raw-only representation, and refuses mixed raw/typed storage. The
later 0035 upgrade audits existing ready days with that validator, then guards
ready headers, chunks, records and children against direct changes or deletion.
Its PostgreSQL 17 tests cover exact replay and terminal owner-erasure cascade;
it was subsequently applied to the GCP test database.
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
v1 and v1.1 memberships while retaining the digest-only receipt. A local
typed-only reader now exists, but no live source rows have been migrated or
hosted legacy route qualified.
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
exists is also blocked, preserving the optional authority mapping. Subsequent
migrations and adapters add admission/proof transfer, a typed-only effective
reader and an explicit owner-erasure path. Linkless owner authority still
requires exact transferred evidence; a typed record alone never grants
permission to purge it. Automatic approval review had rejected an implicit
broad participant-delete purge because it could irreversibly remove retained
typed source rows before the owner-erasure workflow was settled.
The remaining typed v1/v1.1 authority family is material: live D1 reports
5,122,773 v1 record-admission rows, 4,329,999 v1.1 record proofs,
27,577/22,823 format-specific chunk allocations, and 1,035 v1.1 manifest
memberships. Preservation proofs and authority requests also need mapping.
The 0033 migration and sealed local importer now represent and rehearse these
families with bounded checkpoints and exact source/destination receipts. They
have not consumed a live, consistently frozen D1 export. The importer must
preserve the exact source participant-to-owner mapping and leave missing owner
links unknown; local fixture parity is not live reconciliation.

The generated PostgreSQL runtime receipt, migration runner, local Cloud Run
host and database build-context checks now agree on 36 primary migrations and
six ledger migrations. The focused 0029 through 0036 tests applied the full
stream against disposable PostgreSQL 17. The private loopback host suite
passes 15/15 with PostgreSQL 17 and the synthetic cutover rehearsal passes
13/13. The 25-to-26
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
undeclared chunks. It used to reject empty manifests, as D1 did before
isolation `0012`; it now
registers an empty day as ready, because a complete v1.2 domain includes days
without records (see the v1.2-only follow-up below). A PostgreSQL
17 regression test passes for those cases. The PostgreSQL effective reader now
also exposes bounded candidate paging, occurrence expansion and active-head
day enumeration. A PG17 test scans 2,049 records with repeated timestamps and
a cursor split, verifies successor-generation selection and refuses oversize
occurrence/day requests. These are v1.2 source primitives: the v1/v1.1 union,
mixed-format precedence, owner-revision checkpointing and full analytics
orchestration remain unported. The 0035 retention guard closes the direct
ready-header mutation path locally.
Migration 0029 introduces `typed_v1_event_sources` and
`storage_v11_event_sources` membership tables needed to prove which legacy
records are effective. The focused PostgreSQL 17 tests cover its receipt,
lock-order and participant-cascade safeguards. A typed-only local effective
reader now requires 0031/0033 lineage proof and rejects old raw-record-only
fixtures. Live source rows are still untransferred; merely scanning all typed
records without the exact D1 membership rows could resurrect superseded
evidence.
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
An independent [Cloudflare R2 List Objects API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/list/)
provides paged key, size, ETag, HTTP and custom metadata, but no object
version. A new read-only REST inventory command accepts an injected scoped API
token, bounds each page and the whole sweep, and emits only counts, byte totals,
metadata exception counts and a metadata digest. Four synthetic tests pass.
This can discover all prefixes without a Worker binding; it cannot supply the
version-pinned object-copy receipt or a consistent snapshot of a moving bucket.
The Wrangler OAuth session was refreshed with the previously approved D1
scope and verified against read-only D1 metadata. It does not have R2 bucket
access; a read-only R2 bucket-list attempt returned Cloudflare authorization
error `10000`. No scoped R2 token is currently available to run this inventory
live. A separate bucket-scoped read token is needed before listing or copying
quarantine objects.
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
`0013_v12_quarantine_admission.sql`: a new v1.2 chunk requires an exact pending
object registration still in `registered` state. It was numbered `0010` on this
line until the 2026-09-25 merge with `main`, whose owner-authorized
`0010_accountless_v12_renewal.sql` and `0011_v12_public_eligibility.sql` keep
their numbers; this line's own v1.2 renewal-trigger migration (then `0011`)
was dropped in favour of `main`'s `0010`. It was then `0012` until the
2026-09-26 merge of `main`'s production hotfix
`0012_v12_empty_day_manifests.sql`, when it and the retained-history transfer
migration were renamed byte-identically to `0013` and `0014` so both run after
the hotfix re-creates the v1.2 tables. Seven focused tests cover
admission, missing/mismatched/deleting registrations and transaction rollback.
Usage activation pins the migration ledger hash and trigger. The historical
source-pinned migration operator ends at `0009`; `0013` needs a separately
reviewed forward application and receipt after `0009`–`0012` in the ordered D1
stream. `0014` also needs baseline `0063`, which GitHub `main` does not carry.
Once any of `0063`, `0013` or `0014` is applied, `main`'s guarded typed deploy
refuses the schema; the
[production operations runbook](../runbooks/production-operations.md) sets the
order. This line has not changed the production D1 schema.

The v1.2-only follow-up to that merge (local source and tests, 2026-09-25)
drove the shipped client over the real D1 routes and the PostgreSQL dispatch
for a never-uploaded accountless install:

- The domain predecessor refused a device with no ready day, and its
  fingerprint moved when the client's own days became ready, so such an
  install never staged anything. Both D1 and PostgreSQL now seed the first
  range with the current UTC day and pin only the prior head and input
  revision. PostgreSQL also registers an empty day as ready. D1 refused one
  through its `0008` schema until `main`'s production hotfix (isolation
  `0012_v12_empty_day_manifests.sql`, PR #226, merged into this line on
  2026-09-26) re-created the manifest table with the v1.1 bound; registration
  now marks an idle day ready on both backends. A real-client D1 journey
  (`apps/worker/test/telemetry-v12-empty-day-journey.spec.ts`) activates a
  domain across an idle day with the quarantine fence applied.
- The PostgreSQL v1.2 capability read required the v1.2 grant it reports on,
  so an ungranted accountless install got `401 DEVICE_AUTH_INVALID` and the
  desktop never requested the grant. It now authenticates the base lease graph
  and reports the grant as not current, as D1 does. A grant behind the lease is
  reported as not current and a repeated grant request catches it up.
- PostgreSQL opt-out now revokes the v1.2 grant with the lease graph and, with
  primary migration `0045`, retains an eligible v1.2-only head. The daily
  publisher still reads only v1/v1.1 records, so it counts no v1.2 evidence.
- D1 isolation migration `0014` lets the retained-history transfer capture a
  v1.2-only opt-out marker instead of refusing every capture; the PostgreSQL
  importer refuses that lineage by name until a reviewed import path exists.

PostgreSQL still mints no analytics owner link for a new participant, so a
v1.2-only install that first uploads to PostgreSQL does not become an
effective or graph owner. None of this has been applied to GCP or Cloudflare.
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
14/14, including real PG17 health, manifest replay, grant issuance/revocation,
one-use claim refusal and negative auth, body, control and host checks. Both
local partial modes require `127.0.0.1`. A separately selected
`cloud-run-iam` mode admits the same limited v1.2 routes only on the named
`tibotattle-test-app` service, its pinned reported HTTPS origin, port 8080,
and Cloud Run's `0.0.0.0` listener. Startup requires the `K_SERVICE` identity
and rejects alternate authorities, public/admin origins, and unsupported
routes; Cloud Run IAM enforcement is checked outside the process. This is
source qualification for the named private GCP test service running this
exact mode. Rechecking both
migration receipts on each partial-route POST is a local correctness gate, not a
production throughput design. An independent route review found that the
PostgreSQL v1.2 authority check initially omitted D1's base-consent gate.
It now requires social `privacy-safe-telemetry-v0.1` consent or null
accountless consent, with D1's `400 TELEMETRY_REQUIRED` response. A real
PostgreSQL 17 regression checks grant issuance and chunk persistence while
the v1.2 device capability remains accepted. The focused test passes.

The current source candidate additionally dispatches Google handoff
`start`/`callback`/`result` and `POST /api/v1/enroll` to PostgreSQL. Its local
PostgreSQL 17 qualification uses injected synthetic provider exchange and
verification; it checks PKCE binding, proof consumption/replay, enrollment,
session-cookie authentication, social-owner continuity, consent controls,
cooldowns, and concurrent races. This code has not been built into or deployed
to the current GCP image, and the tests do not contact Google. The private
Cloud Run service cannot receive Google's browser redirect directly, and a
browser also cannot call its start/result/enrollment paths without an
IAM-authenticated proxy. Keep the service IAM-private. The smallest test-only
path is a separate, narrowly allowlisted public gateway with no database access
or Google client secret; it should call the existing service with a dedicated
Cloud Run service identity granted only `roles/run.invoker`, and avoid logging
callback query strings. Route all four browser-facing paths through it, then
configure the OAuth web client with the exact HTTPS gateway URI
`/api/v1/identity/google/callback`. Before that can work, source/configuration
must allow the external callback origin to be configured independently from
the private service origin: `cloud-run-iam` currently rejects `PUBLIC_ORIGIN`,
and the Google adapter requires the request origin to equal it. Keep the
backend's IAM policy unchanged. Cloud Run's service-to-service contract
requires a Google-signed ID token whose audience identifies the receiving
service ([Cloud Run authentication](https://docs.cloud.google.com/run/docs/authenticating/service-to-service));
Google requires the OAuth `redirect_uri` to exactly match a URI registered on
the client ([OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server)).

This is a local v1.2 admission slice, not the complete application. Device
enrollment/refresh, v1/v1.1 contributions, effective mixed-format reads,
analytics publication, and owner erasure still have D1-owned routes or missing
PostgreSQL adapters. Scheduled maintenance and public graph publication also
use separate D1 ingestion/analytics roles. The Cloud Run service is
IAM-private. The test deployment gate pins the
`tibotattle` `us-east1` service and image repository, checks the local source
context and read-only Cloud Run/IAM state, and rejects public invoker bindings,
a disabled Invoker IAM check, or traffic not wholly on the latest ready and
created revision. Its dedicated tests pass. A read-only live check found
the service Ready with no public invoker and unauthenticated GET denied with
HTTP 403. An independent audit showed that a Cloud
Build tag and service environment digest do not prove the built bytes came
from the reviewed local context. The gate now reports
`SOURCE_PROVENANCE_UNQUALIFIED` and refuses deploy without an exact archive,
Cloud Build source-generation/hash receipt and image digest. The final archive,
verified Build, image and hosted smoke supplied that proof for the test source
only. The earlier loopback-only gate was superseded by the user's
explicit approval for the exact IAM-only named test host mode.
The verified image now runs on the named private service with the pinned
`HOST_ORIGIN` and `POSTGRES_TEST_HTTP_MODE=cloud-run-iam`. Exact-image, origin,
IAM-policy, source provenance, latest-revision traffic, and anonymous-denial
read-back pass. The successful hosted synthetic journey below additionally
qualifies the scoped authenticated v1.2 route and storage read-back.
The reviewed source context was packaged as one deterministic archive and
uploaded create-only to the named test build bucket at generation
`1790296412253434`. Its SHA-256 is
`085aca9e08b86dd02803ab39ae0c64a84c42f12e120e55b8bd9588b9a31d9288`;
the canonical source-content digest is
`0545fb1206f3f3dd0f8a615b936f8e77ad0c5c3ad87c1c808934c3e63e25458e`.
The archive contains the 296 allowlisted source files and its marker, with no
private environment or key files. `gcloud builds submit` copied those bytes to
its default staging bucket, which the pinned builder service account cannot
read; that attempt failed before creating a Build. A regional Build API request
must refer to the original named object and generation. The fixed build
request specifies a pinned builder and service account, SHA-256 source hash,
and verified provenance. The [Cloud Build API](https://docs.cloud.google.com/build/docs/api/reference/rest/v1/projects.builds)
exposes the resolved storage source and source-file hash; compare both against
the local archive, then use the build result's immutable image digest for
Cloud Run read-back. Recompute the canonical source-content digest from the
same archive before submission. The [provenance guide](https://docs.cloud.google.com/build/docs/securing-builds/generate-validate-build-provenance)
describes verified provenance for Artifact Registry images. The first
verified-provenance build failed after its Docker step because Container
Analysis API was disabled. That API was enabled on the test project; the
repeated exact-source Build `87472dc5-ad6c-4091-939d-6211788f6d78`
succeeded with image digest
`sha256:4d7109e470f2f54693c7d27c92fa4d1a5af47d967ea6e576c846ebb8d3ba8626`.
The source-generation, SHA-256, pinned builder, service account and digest
passed the independent gate. The test migration job on that image completed as
`tibotattle-test-database-migrate-thr4d`; its Cloud Logging receipt read back
all 30 primary and five ledger migration checksums. The service retained an
explicit traffic pin to its prior revision after deployment. Routing only the
named test service to `LATEST` produced 100% traffic on
`tibotattle-test-app-00020-kr8`; the read-only deployment gate then returned
`verified` with no blockers, including anonymous health HTTP 403.

The first hosted synthetic v1.2 Job,
`tibotattle-v12-smoke-xf8qj`, stopped before fixture seeding with
`SMOKE_RUNTIME_CONTROLS_NOT_READY`. The separate test-only activation job,
rather than the synthetic smoke, established and changed the actual live
runtime/control state as described below. The
second source archive has content digest
`645397855a7d5f052c230db269414f5ccea948f8052ffdd67d0facba93ef9170`,
archive SHA-256
`d6561f0f879677e24fb8f1c0d9524f055372165598f2f66ac857a845aab070a4`,
and named build-bucket generation `1790298530391406`. Verified Build
`32b314b9-9633-4e78-8ea6-78a325286a7c` produced image
`sha256:c189c55029806f62b89b7bb0f2c88122b6db56c4be123154fca924c672fb5bd6`.
The exact-image, source-generation, verified provenance, private IAM and
anonymous-denial gate passed after deploying that image to the named test
service; 100% of its traffic is on the latest revision. The named test
migrator on the same image completed as
`tibotattle-test-database-migrate-qzrms`, reading back all 30 primary and five
ledger migration checksums. The first activation execution,
`tibotattle-v12-test-activate-f4w2s`, refused with
`POSTGRES_TEST_ACTIVATION_STATE_UNEXPECTED` before any update committed.
Later bounded diagnostics and the exact compare-and-set transition below
resolved that test-only state mismatch.

A third verified test Build, `780651f1-2982-4095-b381-1f88d6366700`, used
source generation `1790299458480293` and produced diagnostic image
`sha256:85a4c9091605aaa1db1a7b9eb69c642c69ff9ad76b64875946f97dc699f5d13b`.
The diagnostic activation execution `tibotattle-v12-test-activate-296bc`
again refused without an update. Its allowlisted field-name receipt shows that
the live test rows are closer to a previously activated legacy runtime and
operational collection controls than to migration defaults: the typed runtime
is not active, and collection-control state, revision, enrollment, and
publication differ from the narrow target. A fourth verified Build,
`df5434c6-50f6-490a-ae89-de49cfaa62cc`, used source generation
`1790299903184451` and produced image
`sha256:1f0e6844fb14d0048b91fd6ab3f6420154e22aa09a763342c25c320ecdb7fe5f`.
Its activation execution `tibotattle-v12-test-activate-gqzqp` again refused
without an update and returned only bounded nonsecret singleton values:
legacy runtime active/revision 1, typed runtime staged, collection controls
operational/revision 14 with enrollment, upload registration, processing, and
publication all enabled. The next transition must accept exactly that test
prestate, activate typed v1.2, and advance controls to revision 15 with only
upload registration and processing enabled. In-memory comparison confirmed
that the test service private envelope JWK and the smoke job public JWK are a
matching pair; both use their pinned Secret Manager version 1. The runtime
service account has object access on the named test app bucket.

The exact test-only recovery source was built with verified Build
`fef857a5-4af4-4d6e-816b-5c45e8ec3bef` from source generation
`1790301010600342` as image
`sha256:01bdb65fb477cc5dd003f480f59999033c02bf19d8088a6021398128b7ee7712`.
The private service's final-image and IAM gate passed. Activation execution
`tibotattle-v12-test-activate-mczrg` succeeded with a transactional read-back:
legacy and typed v1.2 runtimes active; controls degraded/revision 15, with
upload registration and processing enabled and enrollment and publication
disabled. The first post-activation synthetic journey,
`tibotattle-v12-smoke-qpw6m`, reached the service: anonymous health was
denied, authenticated health returned 200, manifest/grant calls returned 201,
and both chunk calls returned 202. It then failed its own PostgreSQL read-back
assertion with `SMOKE_POSTGRES_READBACK_MISMATCH`, leaving a tagged synthetic
fixture. Local PostgreSQL 17 confirmed the cause of the first assertion:
`pg` decodes a `date` column to a JavaScript `Date`, while the smoke compared
the first ten characters of `String(date)` with an ISO calendar day. The
read-back now selects `chunk_day::text` and reports a fixed mismatch stage.
That failed run retained a tagged synthetic fixture and referenced GCS object;
the successful run below retained a separate tagged fixture. Neither can be
removed through the current private test host because owner erasure is not yet
routed. A participant cascade alone would leave the independent erasure ledger
and object journal without an end-to-end proof. Keep the fixtures until an
exact-owner cleanup path is implemented and reviewed.

The final allowlisted archive contains 298 source files plus its marker.
Its canonical source digest is
`5393a857ec32bc8d3e1573ab1b1b391535b363d4204c2d40a154b926aacfb93f`;
the archive SHA-256 is
`2a8c768d959b10bdd4869a44b30186977c3537cee6a37cfe665370a5baafb41c`.
The create-only build-bucket object is
`source/cloud-run-host-5393a857ec32bc8d3e1573ab1b1b391535b363d4204c2d40a154b926aacfb93f-2a8c768d959b10bdd4869a44b30186977c3537cee6a37cfe665370a5baafb41c.tar.gz`
at generation `1790301596100551`. Verified Build
`f817c07c-ed47-4a52-8b27-429f1d49e5ec` produced and deployed image
`us-east1-docker.pkg.dev/tibotattle/tibotattle-test/tibotattle-host@sha256:b7f4a2339965e5773e1dd786f356c345f8b1be2710f9c9e676188159c66103d2`.
The exact-image and IAM deployment gate passed with 100% traffic on its latest
revision and anonymous health denied. The named smoke Job uses that same image.
Its execution `tibotattle-v12-smoke-wv52n` completed on
2026-09-25 at 02:03:19 UTC. The sanitized Cloud Logging receipt reports
`status=ok`, anonymous denial, authenticated health, staged and exactly replayed
manifest and encrypted chunk, `postgresReadback=true`, and `gcsReadback=true`.
This is a real, hosted, scoped v1.2 admission/storage journey, not an effective
read/analytics/erasure test or a complete application replacement.

The separate typed legacy transfer rehearsal now pages the 14 D1-shaped base
tables from a cloned synthetic in-memory fixture into PostgreSQL 17, including
v1 and v1.1 owner memberships and D1 BLOB byte-array conversion. It uses a
dedicated rehearsal control schema, transactional checkpoints, rollback/resume
and source/destination count and digest read-back. Eight focused tests pass,
including linkless v1.1 membership, repeated participant identity,
changed-source refusal and bounded page behavior. The transfer runner accepts
the private synthetic-fixture source or an owner-owned, read-only, hash-sealed
SQLite rehearsal artifact. A generic D1 adapter or caller-built export
descriptor cannot label itself as immutable. The SQLite reader checks exact
bytes and file identity before and after transfer and reads bounded keyset
pages. A PostgreSQL 17 rehearsal transfers the synthetic 14-table source
through that file, compares source/destination digests, and refuses a changed
artifact on retry. This proves the offline file path, not that any file is a
complete or consistent production D1 export. The runner also requires a dedicated rehearsal
target schema and refuses ordinary application schemas before any destination
query; this protects against accidental targeting, not deliberate use of that
prefix in a production database. Dictionary parity is explicitly scoped to
source keys, so a preexisting destination dictionary row does not masquerade
as whole-table equality. Live mutable D1 and an unverified remote export are refused:
the source still needs a verifiable frozen export, and the other legacy
admission/proof/effective-reader families remain untransferred. The rehearsal
is not production cutover authorization. Automatic approval review rejected
the proposed read-only export of the unbound 10 GB legacy production D1 into
a private local artifact because that database contains sensitive telemetry
and Cloudflare warns that large exports can pause queries. No export was
created; exact approval for that source and operation remains pending. This
does not block local synthetic transfer work.
Cloudflare documents that a large [D1 export can make the database unavailable
for queries](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/)
while it runs, and [Time Travel cannot yet clone a database into a new
copy](https://developers.cloudflare.com/d1/reference/time-travel/). The final
source export therefore needs an explicit maintenance/freeze window and a
write-delta policy. Do not run a large export against the serving ingestion D1
as an ordinary read-only inventory command.

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

### Typed legacy source-shape correction

The source D1 typed-admission migrations block insertion into
`telemetry_v1_records` and `telemetry_v11_records` after typed admission is
active. The original PostgreSQL reader fixture populated those obsolete raw
tables and therefore could not qualify a real typed owner. The corrected
PostgreSQL reader now joins typed allocation, admission/proof,
owner-membership and event-source lineage. A PostgreSQL 17 fixture with no raw
record rows passes. This is still local structural proof: no sealed live D1
export has been transferred and reconciled with the PostgreSQL target, so the
production path remains closed.

## Observed GCP test boundary

A read-only Google Cloud Console inspection on 2026-09-24 found one healthy
Cloud Run service, `tibotattle-test-app`, in `us-east1`. Its ingress is `All`
and it requires Google IAM authentication; no anonymous or all-authenticated
invoker binding appeared. A service-level `roles/run.invoker` grant was added
for only `tibotattle-test-runtime@tibotattle.iam.gserviceaccount.com` so a
single-task synthetic Cloud Run Job can call the named service with an IAM ID
token; the policy was read back, and anonymous health remained HTTP 403.
Project Owner and Editor roles remain inherited invocation paths. The latest
verified private test image is
`sha256:aa512247592a44dcf376b6612b2fa13551374aa7ff838b6ca7d25ba49dd2094e`,
as recorded in the linked 2026-09-25 receipt. The service uses 1 vCPU and
1 GiB RAM.

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
The earlier destination-transfer smoke cleaned up its objects. The hosted v1.2
journeys have since retained tagged synthetic fixtures and their referenced
objects in the test bucket. It has not been populated with the 7.92 GB
production quarantine set.
A read-only bucket metadata sweep on 2026-09-24 counted two test object
generations totaling 4,674 bytes, with no noncurrent generation listed. The
IAM-private synthetic discovery Job was subsequently deployed and ran
read-only against the migrated test databases. It found four exact synthetic
UUIDv4 owner tags, four referenced GCS objects and zero unattributable pending
references. Its database counts cannot by themselves prove that specific GCS
keys and generations match. Exact-owner cleanup still requires independent
bucket-history proof and a hosted read-back before deleting any retained
fixture. The current bucket's creation-to-present soft-delete history cannot
be established from its current metadata alone.

The local `gcloud` CLI has an active account and can read the test service
when commands specify `--project tibotattle`; its default project is unrelated.
The CLI initially returned ready revision `tibotattle-test-app-restore20260924`
in `us-east1`; the final image is routed entirely to its latest ready revision.
The integration also uploaded the reviewed source archive to the
named test build bucket. The failed `gcloud builds submit` attempt left a
same-byte 1.2 MB source object in the default Cloud Build staging bucket; no
Build record was created. The IAM-private test service now has exact-image
deployment, infrastructure and scoped v1.2 authenticated application/storage
readback. The `cloud-run-iam` mode permits only the named
IAM-private test service and the limited v1.2 route set; it does not turn the
partial host into a complete Worker replacement.

## Release and activation gates

1. Reconcile current-main v1.2, effective-reader, analytics and erasure
   contracts with the PostgreSQL implementation. Preserve closed schemas,
   replay safety, owner authority and fail-closed forward migrations.
2. Build and test a clean integrated revision. Worker, PostgreSQL,
   portable-contract, architecture and documentation checks passed for the
   private v1.2 slice, and its exact-image hosted journey passed. The complete
   application, installed-client and release-stage checks remain separate
   gates after the missing routes and transfer are implemented.
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
5. Port the required one-minute maintenance phases and ordered analytics
   delivery to PostgreSQL/GCS, then the public graph's selection, calculation,
   claim/checkpoint, publication and serving path. Test crash/retry, authority
   change, owner erasure and stale-source refusal. Confirm that any optional
   catch-up queue or prepared-data builder is disabled or ported before its
   Cloudflare owner is stopped.
6. Size separate zonal production databases and storage from measured data;
   qualify public/admin ingress, Access assertions, direct-origin refusal,
   client callbacks, rate limits and production costs. The small IAM-private
   test deployment does not qualify public ingress or the 100,000-member graph
   throughput target. Diagnose the timed-out publication insert, prove a
   bounded version on a pristine hosted schema, and measure against a matched
   hosted Cloudflare workload before claiming a speed ratio.
7. Only after an exact rollback point, writer freeze, final delta and complete
   read-back should production routing or client configuration change. Account
   for writes accepted on GCP before any reversal.

**Production decision: no-go.** The clean source integration and the complete
live transfer/reconciliation do not yet have receipts. The previous Worker and
its data remain the serving system.
