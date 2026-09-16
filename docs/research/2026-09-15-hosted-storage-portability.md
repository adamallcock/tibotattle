---
title: Hosted storage scalability and cloud portability investigation
date: 2026-09-15
type: research
status: proposed
---

# Hosted storage scalability and cloud portability

## Recommendation

Start extracting narrow, behavior-defined storage and execution interfaces now.
Keep Cloudflare as the first implementation. Prioritize the analytical work path
and object storage; migrate transactional authority only after its atomicity and
recovery contracts have executable tests against a second database.

The present shared-primary-D1 layout has finite headroom. Moving HTTP execution
to GCP alone would not solve its growth, contention, or repeated analytical work.
The promising future GCP shape is Cloud Run services/jobs, PostgreSQL on Cloud
SQL, Cloud Storage, and durable task delivery. It is a candidate architecture,
not a selected provider or an implemented migration.

Do not build a universal cloud SDK, replace D1 with a generic `query(sql)` wrapper,
or translate every SQLite statement through a compatibility layer. Define the
operations the product needs, including the conditions under which they may
commit. Different providers can then implement those operations differently.

## Evidence boundary

- Source reviewed: `main`, `9385bad260698814cc2a4a6c685575a3fd63811a`.
  The tracked Worker subtree was unchanged at inspection. Unrelated dirty files
  elsewhere in the shared checkout were preserved.
- Separately reviewed: typed-storage snapshot
  `c3f01b42fce7b778c060487690a4cd82be61b0e1`. It is not the main baseline.
  Live GitHub metadata on September 15 showed [PR #150](https://github.com/adamallcock/tibotattle/pull/150)
  open and draft, with head `codex/d1-promotion-index-recovery-20260914` and base
  `codex/d1-typed-storage-isolation`. That PR is an index-recovery fix into the
  typed-storage branch, not evidence that the entire architecture is merged.
- Three Luna Max investigators independently reviewed storage, runtime, and
  provider options. Conclusions below combine their findings with direct source
  inspection and official documentation.
- No live database inventory, payload reads, load tests, remote mutations, or
  deployment inspection were performed. Current production utilization, growth,
  monthly cost, throughput, and time to exhaustion remain unknown.
- This is a proposal. Maintained authorities remain the
  [architecture](../reference/system-architecture.md),
  [privacy inventory](../reference/local-data-and-privacy.md), and
  [production operations runbook](../runbooks/production-operations.md).

## 1. Where the coupling actually lives

| Area | Current source evidence | Consequence |
|---|---|---|
| Composition and configuration | [index.ts](../../apps/worker/src/index.ts), [wrangler.jsonc](../../apps/worker/wrangler.jsonc) | HTTP, assets, scheduled maintenance, provider bindings, and orchestration are composed together. Runtime configuration is not an application dependency contract. |
| Operational database | [repository.ts](../../apps/worker/src/repository.ts), [telemetry-v1-repository.ts](../../apps/worker/src/telemetry-v1-repository.ts), [telemetry-v11-repository.ts](../../apps/worker/src/telemetry-v11-repository.ts) | Domain operations accept D1 handles; schema-specific SQL implements authority, deduplication, ingest, and lifecycle. |
| Analytical read protocol | [quota-analysis-v1-reader.ts](../../apps/worker/src/quota-analysis-v1-reader.ts), [prepared-v1-evidence.ts](../../apps/worker/src/prepared-v1-evidence.ts) | Existing bounded page-reader interfaces are useful seams. Cursor order, source pins, checkpoints, and physical-page behavior must remain explicit. |
| Publication | [community-publication.ts](../../apps/worker/src/community-publication.ts) | Publication depends on generation, method, completeness, source epoch, and immediate privacy invalidation. One helper returns a D1 prepared statement for composition into a batch. |
| Maintenance | [index.ts](../../apps/worker/src/index.ts), [d1-invocation-budget.ts](../../apps/worker/src/d1-invocation-budget.ts) | One global maintenance lease, a 40-second optional-work deadline, and a shared 900-statement allowance constrain lifecycle and analytics. A batch is charged by its statement count. |
| Independent erasure authority | [participant-erasure.ts](../../apps/worker/src/participant-erasure.ts), [retention.ts](../../apps/worker/src/retention.ts) | Primary D1, deletion-ledger D1, and object storage already require resumable cross-store operations. They are not one transaction. |
| Ingress pressure | [ingress-budget.ts](../../apps/worker/src/ingress-budget.ts), [upload-ingress-admission.ts](../../apps/worker/src/upload-ingress-admission.ts) | A Durable Object enforces shared concurrency/start budgets. Per-instance counters in Cloud Run would change the guarantee. |
| Object storage | [sparkle-appcast-guard.ts](../../apps/worker/src/sparkle-appcast-guard.ts), [retention.ts](../../apps/worker/src/retention.ts) | Quarantine cleanup and release-feed conditional replacement have different authority and retention requirements. |
| Test runtime | [vitest.config.ts](../../apps/worker/vitest.config.ts) | The current suite is coupled to the Cloudflare test runtime. Provider-neutral interfaces need independent contract tests as well as these integration tests. |

A textual census found 45 Worker TypeScript files containing `D1Database`,
`D1PreparedStatement`, or `D1Result`, and 19 containing `Env`. These counts measure
surface area, not independent dependencies or required pull requests. Generated
Worker declarations were excluded.

## 2. Scaling risks, ordered by architectural significance

### Shared database capacity and execution

D1 Paid has a non-increasable 10 GB per-database limit. Individual databases
execute queries one at a time; read replicas can distribute reads but do not
remove the primary write boundary. D1 documents 1,000 queries per paid Worker
invocation, 100 bound parameters per query, and a 30-second query/batch duration
limit. These are platform limits, not measured TiboTattle capacity.
[Official D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/).

The checked-in baseline uses one primary D1 for operational and analytical work,
plus a separate deletion ledger. Indexes, retained history, prepared data,
checkpoints, and cached publications all contribute to the primary's footprint.
Read replication does not remove that footprint or speed up writes. It also
requires an explicit consistency design for source pins and revocations.

Quarantine storage also accumulates: `QUARANTINE_RETENTION_MILLISECONDS` is
`null` in [constants.ts](../../apps/worker/src/constants.ts), so accepted envelopes
have no age-based deletion in this source. R2 growth is a separate cost and
erasure/recovery concern from D1 capacity; a migration cannot silently introduce
TTL deletion. The source deletion-tombstone lifetime is 400 days, so any future
backup/restore horizon must be reconciled with that protection window.

### Write amplification and trigger work

A full 200-record v1 chunk builds 203 D1 statements for a new chunk and 205 for a
superseding chunk in `insertTelemetryV1Chunk`, before work performed by triggers.
Batching makes the operation atomic; it does not make this one statement or
remove index/trigger writes. The admission constants permit up to 2,000 chunks
per device-day normally and 20,000 in the initial week, subject to other controls.
These are policy maxima, not observed demand or achieved throughput.

The latest checked-in definitions in
[migration 0058](../../apps/worker/migrations/0058_accountless_upload_ownership.sql)
retain admission-counter triggers and social-owner daily rebuild triggers. Social
participant erasure withdraws all published daily aggregates and enqueues their
rebuild. Accountless ownership has distinct guards; do not generalize the older
0031 trigger definitions to every owner. Measure this write/rebuild amplification
under mixed ingest and erasure, and include it in PostgreSQL transaction design.

### Competing background work and freshness

The scheduled path has bounded work and recoverable progress, which are strengths.
However, a global lease and shared invocation allowance make task priority and
service time part of public freshness. More HTTP capacity cannot drain analytical
backlogs faster. Raising a Worker CPU ceiling does not raise database capacity,
remove statement limits, or automatically change application deadlines.

Separate required lifecycle work, current analysis, historical backfill,
publication, and diagnostics into independently budgeted work classes. Do this
without letting publication bypass the lifecycle/privacy checks it currently
requires. Measure backlog age and drain rate, not only successful cron runs.

One operational assumption needs live verification: the production config sets
`cpu_ms: 300000` and runs cron every minute, but current Cloudflare documentation
lists 30 seconds of CPU for cron intervals below one hour. The 40-second
application deadline measures wall time, which is different from CPU time.
Verify deployed invocation limits and CPU/wall-time traces before treating the
configuration comment as five minutes of scheduled CPU headroom.
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

### Bounded pages do not guarantee bounded total processing

`readCapturedCommunityPublication` pages through data but still accumulates the
cohort fits/compositions in memory. The source caps total model-cache payloads at
16 MiB and separately bounds participant metadata. This is a deliberate refusal
boundary, not indefinite scalability. A larger database alone would not remove
it. Incremental aggregation, partitioned immutable results, or a reviewed change
to the analytical algorithm would be needed when the result approaches the cap.

### Global mutation coordination remains a portability constraint

`insertTelemetryV1Chunk` creates a singleton `community_graph_update_scope`
marker, supersedes the old chunk, inserts records, and removes the marker in one
D1 batch. Its triggers distinguish normal updates from privacy invalidation.
That is stronger than a series of generic CRUD calls. A PostgreSQL copy that
retains a global singleton can still serialize unrelated owners; removing it
requires an equivalent transaction-scoped/per-owner authority design and tests,
not just changing SQL syntax.

### Layout compression helps but is not a migration strategy

The typed-storage branch separates roles and introduces routing, delivery,
recovery, and erasure protocols. Its frozen synthetic raw-table measurement
reports approximately 320–353 bytes per record versus 1,834–1,845 in the baseline.
The report explicitly excludes later authority/admission overhead and uses local
SQLite with synchronous writes disabled. Do not extrapolate its 81–83% reduction
to complete production storage or remote throughput.

The branch's `OwnerStorageRouter.write` still accepts a builder of
`D1PreparedStatement[]` and returns `D1Result[]`. It is a useful D1 routing seam,
not a PostgreSQL adapter contract. Preserve its generation fences, copy receipts,
and recovery semantics; put a domain-operation boundary above it.

Its typed page reader also performs a multi-join reconstruction, a schema read,
and up to three additional session-tool queries for a 200-row page. Compact
allocation does not establish cheaper reads. Its analytics runtime separately
reads ingestion journals and updates the analytical store, with an observed
`size_after` guard rather than an atomic distributed capacity reservation.
Shard moves fence the source, verify a destination copy, commit the catalog, and
activate the destination in separate steps. Those are resumable cross-store
protocols, which any replacement must preserve. Qualify the separate analytics
Worker and its ingestion/analytics/ledger bindings explicitly; the baseline main
configuration is not evidence that those roles are deployed.

Branch evidence: `apps/worker/src/storage-routing.ts` and
`docs/research/2026-09-11-typed-storage-measurement.md` at the separate snapshot
listed above. Those files are not asserted to exist on main.

## 3. Proposed adapter contracts

These names are proposed responsibilities, not new implemented APIs. Initially
keep interfaces with their owning Worker modules. Extract a runtime-neutral
workspace package only when a second runtime genuinely consumes them; do not make
Cloud Run import private files from the Worker app.

| Port | Operations and required semantics | Cloudflare implementation | Candidate GCP implementation |
|---|---|---|---|
| Contribution store | Accept a validated chunk under current authority; return durable receipt; duplicate/conflict distinctions; fence expired or revoked grants; resume incomplete work | Existing D1 repository/journals | PostgreSQL transaction and durable journal/outbox |
| Analytical source reader | Read bounded ordered pages under a source revision; explicit incomplete/stale result; stable resume identity | Raw/prepared/typed D1 readers | Indexed PostgreSQL pages, later immutable analytical partitions |
| Analytical work store | Claim, checkpoint, renew, complete, or defer with lease token and revision; fair current/backfill scheduling | Existing D1 queue/checkpoints | PostgreSQL work rows; Cloud Tasks delivery may wake workers |
| Publication store | Atomically publish only a complete expected generation with a current privacy fence; read with provenance and freshness | D1 conditional batch | PostgreSQL conditional transaction; optional versioned object payload |
| Quarantine object store | Bounded read/write/list/delete; opaque cursor/version; checksums and metadata; resumable reconciliation | R2 | Cloud Storage |
| Release object store | Read an exact version; create-if-absent; replace-if-version; explicit precondition conflict | R2 conditional operations | Cloud Storage generation preconditions |
| Ingress admission | Acquire/release shared expiring permits; distinguish throttling from unavailable authority | Durable Object plus existing controls | Transactional shared coordinator; not container-local memory |
| Deletion authority and erasure journal | Append/check tombstones; fence writers; checkpoint every store; restore replay; auditable completion | Independent D1 ledger and current erasure machinery | Separately protected durable authority with independent recovery policy |
| Admin identity verifier | Verify assertion into a minimal owner principal; preserve audience/issuer/expiry and owner pin; enforce route/CSRF separately | Cloudflare Access verification | Retain Access or implement an independently tested IAP verifier |
| Work runner | Execute one bounded work unit; deadline/cancellation; receipt-backed completion; safe duplicate delivery | Scheduled invocation | Authenticated Cloud Run task handler or job |

An object version is opaque. Do not name it `etag` in the portable contract or
assume an ETag is a content hash. A publication result should distinguish
`published`, `stale-source`, `privacy-fenced`, `incomplete`, and retryable storage
failure rather than flatten them into a boolean.

A contribution operation must own all the statements that establish its atomic
acceptance boundary. Splitting it into generic `get`, `insert`, and `update`
methods would move concurrency policy into callers and permit partial acceptance.
If a provider cannot implement the required atomic unit, use an explicit journal
with tested recovery rather than silently weakening the port.

Budget contracts should express deadline, bounded pages/bytes, cancellation, and
reserved finalization work. D1's adapter additionally enforces real statement
counts. Do not relabel 900 statements as a universal cloud capacity limit.

## 4. What must survive a PostgreSQL port

- Normalize provider errors into closed domain outcomes inside each adapter.
  Current v1 error mapping parses SQLite/D1 trigger and uniqueness messages;
  PostgreSQL SQLSTATE/constraint handling must map to the same public conflict,
  admission, and revoked-authority outcomes without leaking driver details.
- Rewrite SQL inside each adapter. SQLite parameter conventions, JSON functions,
  schema inspection, date functions, triggers, migration syntax, and result
  metadata are not a portable SQL contract.
- Preserve exact integer accounting and ordering. Database driver mappings for
  64-bit IDs/counters must not silently become unsafe JavaScript numbers;
  explicitly validate ranges or use exact representations at the boundary.
- State the isolation needed by each operation. PostgreSQL supports concurrency
  that a single-threaded D1 database serializes; use conditional updates, locks,
  constraints, and bounded retries where required. A read-then-write check is
  not equivalent to an atomic guarded statement.
- Preserve uniqueness scope across participant, device, stream, record, and
  generation. Match null and conflict behavior with adversarial tests.
- A cursor must include deterministic tie-breakers and a pinned source revision.
  Avoid offset paging; concurrent inserts and source replacement must not skip
  or duplicate accepted evidence. Version the checkpoint encoding and reader
  policy. Do not reuse a D1 row-ID checkpoint in PostgreSQL unless migration
  preserves its ordering/mapping and proves equivalence; otherwise restart the
  derived work under a new generation without discarding accepted evidence.
- There is no transaction spanning SQL and object storage. Record durable intent,
  verify the object, finalize acceptance, and reconcile interrupted steps using
  the existing lifecycle model.
- Keep deletion authority recoverable independently from older operational
  backups. Replaying an old database must never reactivate erased participants
  or republish withdrawn derived results.
- Migration manifests must identify schema/method versions, mappings, exact
  record counts and canonical digests, object checksums, and deletion coverage.
  A database dump alone is not a product-preserving migration receipt.

## 5. First implementation sequence

| Step | Scope | Acceptance boundary |
|---|---|---|
| 0. Establish evidence | Reconcile main, typed-storage branch, and deployed layout; repair dependencies in an isolated checkout; collect content-free capacity/work metrics | Exact source/runtime identities; no inferred production headroom |
| 1. Object contract pilot | Add separate quarantine and release-object interfaces, implemented by R2; migrate one flow at a time | Existing behavior unchanged; missing object, failed precondition, pagination, timeout, and retry tests; no leaked R2 types |
| 2. Analytical vertical slice | Reuse existing bounded readers; extract one current-analysis work unit and its checkpoint/publication dependencies from scheduled orchestration | Same synthetic inputs produce the same fits/provenance; stale or erased inputs cannot publish; bounded replay and cancellation |
| 3. Second local adapter | Implement PostgreSQL for that analytical slice in a disposable database, with a Node runner | Same contract suite passes on D1 and PostgreSQL; no Cloudflare globals in the runner/domain path; query-plan and resource measurements |
| 4. Operational ports | Extract contribution acceptance, authority, admission, and erasure in coherent transactional units | Crash/retry/concurrency tests plus deletion-safe restore tests for both implementations |
| 5. Hosted rehearsal | Provision only after a deployment decision; rehearse bounded backfill, change replay, shadow comparisons, and cutover | Full reconciliation and owner-approved cutover/rollback procedure |

Steps 1 and 2 can be independently reviewed. Step 2 is the highest-value
scalability slice; step 1 is the smaller way to establish adapter conventions.
Avoid rewriting the whole Worker or implementing every GCP service first.

Reuse the accounting, identity, telemetry-contract, and quota-analysis package
facades. SQL remains provider-owned. A query builder may help parameter binding
once dialect behavior is known, but is not evidence of portability. An ORM
migration would expand this project's scope without resolving its key guarantees.

## 6. Measurement and decision gates

Collect these metrics before choosing a migration date. Use aggregate operational
statistics and synthetic representative distributions; do not copy private
session content into fixtures or external analysis tools.

| Question | Evidence to collect | Decision it informs |
|---|---|---|
| When does each store fill? | Allocated bytes by table/index, daily growth, owner-size distribution, prepared/cache overhead, migration temporary space | Compact/split D1 versus moving storage |
| Is the bottleneck contention or application work? | Query-duration distribution, rows scanned/written per accepted chunk, overload/busy errors, transaction retry rate, CPU and heap | Index/query fix, work separation, or database migration |
| Can processing keep up? | Arrivals and completions by work class; oldest pending item; current-publication age; retries; lease contention | Dedicated workers, fair scheduling, or algorithm changes |
| How expensive is invalidation? | Work for a single append, replacement, late record, method change, and erasure at increasing histories/cohort sizes | Incremental projections versus repeated reconstruction |
| What does recovery cost? | Checkpoint replay, backfill rate under normal intake, oldest restore point, erasure-ledger replay, reconciliation duration | Required recovery window and operational headroom |
| Is GCP economical? | Region, HA/backup policy, SQL CPU/RAM/storage/IO, connections, Cloud Run active time, tasks, object operations, egress, logs | Provider comparison using the same workload and durability target |

Use `time-to-capacity = usable headroom / measured net growth` only when both
inputs are measured. Usable headroom must reserve space for indexes, backfill,
rebuild, and recovery; a display window does not authorize deletion of retained
evidence. Compare time-to-capacity with measured migration/rehearsal lead time
plus contingency. The typed branch's 9 GB operating cap is an application policy,
not a separately measured safe limit for every future workload.

For backlog stability, sustained completion rate must exceed arrivals, with
headroom for bursts and rebuilds. Benchmark cold and warm paths at increasing
synthetic volumes, skewed owners, and concurrent uploads plus erasure. Record
p95/p99 latency, rows scanned, bytes, and backlog drain; do not infer capacity
from a single contributor or an empty database.

Suggested decision rule: stay on optimized Cloudflare while measured headroom,
freshness, recovery, and cost meet agreed targets. Start migration before the
forecasted safe operating boundary is closer than its delivery lead time. Choose
workload separation first when freshness fails while storage remains healthy.
Numerical SLOs and capacity forecasts need measurements and a product decision;
none are fabricated here.

## 7. Migration and rollback protocol

1. Establish one source of write authority per owner/workload and pin the source
   and schema versions. Preserve public endpoints and installed-client contracts.
2. Make target schemas and transformations deterministic. Export bounded pages
   with canonical digests, identity mappings, method versions, and resume cursors.
3. Capture changes that occur during backfill through a durable journal/outbox,
   or use a reviewed write pause. Independent best-effort dual writes are unsafe.
4. Reconcile object versions/checksums and ledger state as well as SQL rows.
   Shadow reads compare receipts, accounting, projections, unknown states, and
   deletion fences; HTTP 200 and equal row counts are insufficient.
5. Drain or fence work, replay the final changes, verify tombstones, and switch
   routing under a new generation. Old workers and queued deliveries must be
   unable to commit under the previous generation.
6. Keep the old store read-only for a bounded rollback window. A rollback after
   new writes requires replaying those writes and all deletions back first, or
   forward recovery. Simply pointing DNS at the old store can lose accepted
   contributions and resurrect erased data.
7. Rehearse primary restore plus independent deletion-authority replay, and
   partial object-store recovery. Retire old resources only with separate exact
   deletion authorization and a reconciliation receipt.

A mixed-provider period adds network latency, egress, two failure domains, and
more operational state. Migrate by coherent workload/owner authority rather than
placing sequential row-level calls across clouds. Keep the app offline-capable
throughout; the hosted service remains optional.

## 8. Contract and failure-injection test matrix

| Boundary | Required scenarios |
|---|---|
| Acceptance | Duplicate identical chunk; conflicting digest; expired one-use authority; revocation racing commit; timeout after commit before response; retry after partial staging |
| Reads and accounting | Equal-time records; numeric cursor order; late arrivals; changing winner/source generation; exact integer totals; missing pricing and sparse evidence remain explicit |
| Work | Duplicate/out-of-order delivery; crash after claim; expired lease; stale worker finalization; cancellation; bounded retry; poison work isolation; current/backfill fairness |
| Publication | Incomplete capture; ordinary append during capture; hard erasure during load; method change; stale generation; failed final conditional write; retained last valid result where still authorized |
| Objects | Missing object; absent-create race; stale replace/delete version; checksum mismatch; partial listing; retry after successful write with lost response; orphan reconciliation |
| Authority | Wrong issuer/audience/owner; unsigned headers; direct-origin bypass; missing configuration; CSRF refusal; no participant enumeration |
| Recovery | SQL and object partial failure; stale backup with newer tombstones; revoked credentials after restore; resumed cross-store erasure; rollback with post-cutover writes |
| Resources | Query/page/byte/deadline cap; finalization reserve; per-instance scaling cannot multiply global permits; cancellation never reports completion |

Run provider-neutral tests outside workerd, plus D1 integration tests and a real
local PostgreSQL suite. In-memory fakes alone cannot prove constraints,
transaction isolation, or conditional writes. GCS/IAP/Cloud Run semantics need a
separately authorized hosted rehearsal; a local substitute is not that proof.

## 9. Additional runtime findings

The runtime audit identified contracts beyond SQL and object CRUD:

| Finding | Evidence | Adapter consequence |
|---|---|---|
| Health probes write housekeeping state | [ingress-budget.ts](../../apps/worker/src/ingress-budget.ts), `probe` and `status`; [index.ts](../../apps/worker/src/index.ts), health route | Readiness needs authority to normalize token/lease state. A cache or read-only database user is not equivalent. Document these as non-admitting operations that can still write. |
| Rate admission is ordered | [admission.ts](../../apps/worker/src/admission.ts), `assertUploadIngressRequestAllowed` | Coarse check precedes client check; a client denial does not refund the earlier consumption. Preserve purpose-separated HMAC keys and inject a trusted client-address resolver. |
| Ingress permits require one shared authority | [ingress-budget.ts](../../apps/worker/src/ingress-budget.ts), `acquire`, `renew`, `release`; [upload-ingress-admission.ts](../../apps/worker/src/upload-ingress-admission.ts) | Preserve atomic token/lease decisions, expiry, bounded renewal lifetime, and retry-after. Independent container/region counters would multiply capacity. |
| Quarantine records intent before the object write | [quarantine-reconciliation.ts](../../apps/worker/src/quarantine-reconciliation.ts), `putTrackedQuarantineObject` | Keep a pending-object journal. Cleanup must recheck references and hold its lease before deleting an orphan; a failed upload is not proof that an object is unreferenced. |
| Release publication has two persistence contracts | [sparkle-appcast-guard.ts](../../apps/worker/src/sparkle-appcast-guard.ts) | Preserve atomic nonce consumption as well as conditional object replacement. Add a narrow replay-nonce port; a blob adapter alone is insufficient. |
| Assets and admin routing are security boundaries | [index.ts](../../apps/worker/src/index.ts), [admin-access.ts](../../apps/worker/src/admin-access.ts) | API failures must not become SPA success pages. Keep admin-host isolation, bounded JWKS/token parsing, owner pinning, and unavailable-versus-denied failures. |

Cloudflare rate-limit bindings are **location-local and eventually consistent**.
The code's coarse key named `global` does not make that binding a globally exact
budget. The Durable Object is the separate shared concurrency/start authority.
A portable `RateAdmission` contract must distinguish approximate edge abuse
controls from exact permits; moving the same numeric limit to one central counter
would change effective admission. That is a policy decision, not an invisible
adapter implementation detail.
[Cloudflare rate-limit locality and accuracy](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

Deployment remains provider-specific initially. The
[production deployment tool](../../apps/worker/scripts/production-deploy.mjs)
checks migration inventories separately from deploying source, while
[disabled staging deployment](../../apps/worker/scripts/deploy-disabled-staging.mjs)
checks containment and binding readiness. A GCP deployment needs equivalent
migration/provenance/containment evidence, not a generic success boolean.
Keep Cloudflare integration tests and build an independent second-provider gate.
There is no need to abstract the deployment scripts before the runtime ports work.

## 10. Provider choices and semantic differences

### Preferred candidate to evaluate

Cloud Run can host the existing TypeScript/domain code through a Node composition
root; Cloud SQL PostgreSQL can own transactional and initially analytical tables;
Cloud Storage can hold quarantined envelopes and immutable result objects.
Cloud Tasks is a candidate for directed background work, with Scheduler as a
wake-up source. These services should remain adapters behind the contracts above.
Co-locate database-heavy workers and their database. Limit instance count and
connection pools as part of admission, because autoscaling compute does not
create database capacity.

### Options decision

| Option | Recommendation | Reason and remaining work |
|---|---|---|
| Compact/split D1 | Continue evaluating the existing branch | Can improve headroom while retaining current runtime; each database remains bounded, and cross-role recovery adds complexity. |
| Cloudflare edge plus PostgreSQL | Keep as a credible intermediate option | Hyperdrive pools connections to an existing database; it does not translate SQLite or make the database infinitely scalable. Prove query consistency, network/auth topology, and latency. |
| Cloud Run plus Cloud SQL PostgreSQL | Preferred full-GCP candidate for a local proof | Natural transactional fit and separately scalable background execution; still requires connection/admission limits, regional planning, HA/backups, and workload sizing. |
| Cloud Tasks | Prefer for directed bounded jobs | Queue rate control and retries fit analytical work units. Durable application receipts remain necessary because delivery can repeat. |
| Pub/Sub | Defer until fanout is needed | Useful for multiple independent projections. At-least-once/unordered delivery is the default; exactly-once features do not make external SQL/object effects transactional. |
| BigQuery | Defer; derived analytics only | Evaluate when measured analytical scans justify a warehouse. Keep receipts, authorization, leases, and erasure authority in transactional storage; reconcile deletion into every projection. |
| Universal ORM/cloud wrapper | Reject as the first step | SQL syntax abstraction does not encode the project's acceptance, fencing, and recovery guarantees. |

Sources: [Hyperdrive](https://developers.cloudflare.com/hyperdrive/),
[Cloud Run and Cloud SQL connections](https://docs.cloud.google.com/sql/docs/postgres/connect-run),
[Cloud Run Jobs](https://docs.cloud.google.com/run/docs/create-jobs),
[Cloud Tasks behavior](https://docs.cloud.google.com/tasks/docs/dual-overview),
[Pub/Sub delivery](https://docs.cloud.google.com/pubsub/docs/subscription-overview),
[BigQuery overview](https://docs.cloud.google.com/bigquery/docs/introduction).

The source currently disables queue ingress and exports no queue handler. Its
approximately 2 MiB envelope must not become a queue body: Cloudflare Queues
allows 128 KiB messages and Cloud Tasks limits task size to 1 MiB. Use a bounded
object reference, digest, schema version, and receipt key, with authorization
and erasure rechecked by the consumer. Enqueue only after durable acceptance,
or record pending dispatch transactionally and retry it. A consumer acknowledges
after its durable receipt, not after merely starting work.
[Queues limits](https://developers.cloudflare.com/queues/platform/limits/),
[Cloud Tasks quotas](https://docs.cloud.google.com/tasks/docs/quotas).

### Object semantics deserve an early proof

Cloud Storage supports generation-match preconditions and creation only when
there is no live object using generation zero. Use those through an opaque version
contract; preserve a separate content checksum. A precondition failure is a
concurrency result, not an instruction to retry an unconditional overwrite.
[Cloud Storage preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions).

Cloud Storage normally enables seven-day soft deletion for supporting buckets.
Deleting a live object can therefore leave a recoverable copy, and disabling the
policy later does not retroactively remove already soft-deleted objects. Review
soft deletion, versioning, holds, lifecycle rules, backup retention, and erasure
receipts before migrating quarantine storage. Do not report physical removal
merely because normal object lookup returns missing.
[Cloud Storage soft deletion](https://docs.cloud.google.com/storage/docs/soft-delete).

### Identity and runtime

Retaining Cloudflare at the edge while moving an origin is viable as a design,
but origin access must remain authenticated. Hostname checks and forwarded
identity headers are not sufficient authority. If replacing Access with IAP,
prove issuer/audience/owner validation and protect every ingress path, including
the default Cloud Run hostname. Keep admin separate from public API access and
preserve CSRF checks. IAP on Cloud Run and IAP at a load balancer have different
coverage; select and test the actual deployment arrangement.
[Cloud Run IAP](https://docs.cloud.google.com/run/docs/securing/identity-aware-proxy-cloud-run).

Do not translate `waitUntil` into an untracked Node promise. Work that must survive
request completion or instance termination needs a durable dispatch/receipt and
checkpoint protocol. Preserve bounded work even when a new runtime allows longer
execution.

## 11. Validation of this investigation

- Repository documentation governance passed. The new report was also explicitly
  included with tracked Markdown in a direct validator run; no failures.
- Root `test:preflight` passed root-layout and tracked whitespace checks, then
  stopped on a pre-existing nested `packages/accounting/accounting` symlink
  during untracked-file whitespace inspection.
- A focused Worker probe of `d1-invocation-budget`, `community-publication`, and
  `quota-analysis-v1-reader` did not pass: two suites could not load, and 14 of 15
  discovered reader tests failed with missing `PLAN_ATTRIBUTION_POLICY` fields.
  The independent workspace-package guard reported `ACCOUNTING_PACKAGE_STALE`
  for installed `index.d.ts`; guard self-tests also rejected existing nested
  package symlinks. Wrangler additionally could not write its default log path
  under the sandbox. These are an unqualified local baseline, not evidence that
  a new adapter implementation failed or passed.
- No product source, dependencies, schemas, migrations, cloud resources, or
  existing user changes were modified for the investigation. The report is the
  only intended deliverable. No commit or push was performed.
