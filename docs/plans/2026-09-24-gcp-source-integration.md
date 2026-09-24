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
repeated broad-suite runs. No production data, DNS, route or resource changes
are part of this source integration.

The normalized v1.2 PostgreSQL extension uses the existing primary database,
schema and forward migration history. Migrations 0025 through 0028 follow the
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

The local Cloud Run host and database build-context checks now include 28
primary migrations and five ledger migrations. Host boundary tests pass 6/6;
the generated PostgreSQL migration receipt and runner checks pass. The full
ordered 28-migration primary stream was applied against disposable PostgreSQL
17. The 25-to-26 forward test preserves legacy rows and admits the new day
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
The generic HTTP issuance route still needs v1/v1.1/v1.2 format authorization,
collection control, independent-ledger, rate and ingress-budget composition.
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
The PostgreSQL schema also lacks the D1 `typed_v1_event_sources` and
`storage_v11_event_sources` membership tables needed to prove which legacy
records are effective. Legacy candidate/occurrence/day readers must remain
unavailable until those memberships have a forward schema and transfer proof;
merely scanning raw v1/v1.1 records could resurrect superseded evidence.
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
generation checks on resume. Its adapters are injected test doubles: real R2
and GCS API behavior, source write freeze/snapshot, database-reference mapping
and the copied-object receipt remain unqualified. The destination adapter
contract requires atomic rejection of a short staged stream and immutable
generation semantics; neither is proven against cloud APIs here.

The Worker Vitest lane completed 1,975 passing tests in 155 files after the
v1.2 and analytics port. A newly ported GCP fixture requires Node
filesystem access, so it has a separate Node gate; its two tests now pass with
the provider-effective analytics finish functions ported to current main.
Four focused source-continuity tests, Worker typecheck and architecture checks
also pass. These tests are not a hosted GCP qualification.
The broad root suite is not green: it reports reviewed-model catalog assertion
failures in untouched files, and the protected R7 release receipt is stale
against the changed quota workload source. The focused PostgreSQL and Worker
checks must remain separate from that release gate.

The request router remains the principal application gap. Cloud Run currently
provides PostgreSQL primary and erasure-ledger pools plus GCS objects, but its
normal startup and Worker dispatch both deliberately return unsupported. An
explicit `health-only` mode starts a loopback-only local host and dispatches
only `GET /api/health` to both PostgreSQL pools. A second explicit
`health-and-v12-day-manifest` mode permits that health route and one scoped
`POST /api/v1/device/telemetry/v1.2/day-manifests` route. It checks both PG17
migration receipts, uses PostgreSQL attempt limits, device authentication,
independent-ledger tombstones and processing controls, bounds the body, and
returns the staged-chunk vector. Every other route fails closed before Worker
or D1 access. The local host suite passes 12/12, including real PG17 health
and manifest registration/replay with negative auth, body, control and host
checks. Both partial modes require `127.0.0.1`; neither can listen on Cloud
Run's `0.0.0.0` interface or qualifies a hosted GCP service. Rechecking both
migration receipts on each manifest POST is a local correctness gate, not a
production throughput design.

Current v1.2 domain and chunk-upload handlers still call D1 authentication,
collection controls, typed transport, one-use upload grants, quarantine
journals and receipts. The underlying PostgreSQL bearer, grant, typed
admission, effective-reader and domain functions are local adapters; most are
not yet bound to HTTP routes. Scheduled maintenance and public graph
publication also use the separate D1 ingestion/analytics roles. A hosted,
IAM-private route needs its own ingress/invoker check and exact-image test. A
real contribution journey additionally needs the device routes, GCS journal,
owner-erasure authority and receipts wired through the PostgreSQL/GCS
adapters.

The shared quota hot-path change touches the R7 workload source set. Its
retained release receipt was already stale at this branch's base revision;
the new source changes its hash again. The focused quota suite passes, but
R7 release evidence remains a separate protected qualification gate. Do not
rewrite its receipt or weaken its tests as part of this GCP integration.

## Observed production boundary

The active Worker deployment dashboard showed 100% traffic on version label
`a2c8a0c4`. Its bindings include ingestion D1, analytics D1, independent
deletion ledger D1 and quarantine R2; the legacy primary D1 is not visibly
bound. Live settings select typed telemetry. A configured source-commit value
points to `5038123904196de675bdc9482acf026cad5038bf`, but manual Wrangler
upload and absent build history do not prove the uploaded script came from that
commit. The live settings and bindings also differ from the checked-in Wrangler
configuration. Obtain an exact deployed artifact/configuration receipt before
assigning source authority.
Wrangler CLI authentication was unavailable in this pass. Public health
returned HTTP 200 and reported source commit
`5038123904196de675bdc9482acf026cad5038bf` with reachable primary,
deletion-ledger and quarantine dependencies, but that self-report does not
prove the uploaded script digest or current binding topology.

Read-only schema inspection found 326 tables across four D1 databases, with 93
application names occurring in more than one. The live ingestion v1.2 schema
uses normalized child tables and dictionary IDs. A matching typed PostgreSQL
adapter now exists locally, alongside an older raw prototype. Neither table
presence nor the configured
typed mode proves row volume. Identity, grants, retained telemetry,
corrections, analytics cursors and publication, owner erasure and tombstones,
and referenced quarantine objects all require explicit source-to-destination
mapping and reconciliation. The bounded synthetic importer covers seven
v1/v1.1 tables, 14 v1.2 normalized/runtime/domain tables and selected
pending-object references. In this checkout, a local PostgreSQL 17 rehearsal
transferred 1,256 synthetic source rows (78,757,502 source bytes) in 41
committed batches, including an interrupted-batch rollback, checkpoint
resume, persisted read-back, repeat refusal and one eligible active domain
head. Accountless v1.2 authorization remains untransferred, as do other
identity, analytics, ledger and object families.
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

The local `gcloud` CLI has no active account and defaults to an unrelated
project. Browser Console read-only inspection was possible; no cloud setting
was changed in this source-integration pass. A new IAM-private test service
requires a verified service-level invoker policy, exact-image deployment and
hosted readback. The loopback-only health mode cannot be deployed to Cloud Run.

## Release and activation gates

1. Reconcile current-main v1.2, effective-reader, analytics and erasure
   contracts with the PostgreSQL implementation. Preserve closed schemas,
   replay safety, owner authority and fail-closed forward migrations.
2. Build and test a clean integrated revision. Run Worker, PostgreSQL,
   portable-contract, architecture, documentation and release-stage checks,
   plus the full private GCP journey on the exact new image.
3. Pin the deployed Cloudflare artifact/configuration and obtain content-free
   row counts and digest/snapshot evidence for every active D1 source. Determine
   the legacy primary's disposition before omitting it.
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
