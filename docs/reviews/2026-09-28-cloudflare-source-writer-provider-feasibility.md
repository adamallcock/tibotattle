---
title: Cloudflare source-writer provider feasibility review
date: 2026-09-28
type: review
status: reviewed-no-go
---

# Cloudflare source-writer provider feasibility review

**Decision:** do not add a Cloudflare metadata collector to the current v1
assessor contract. A collector could call some read-only APIs, but it cannot
preserve all currently documented queue and binding variants without widening
the schema. No Cloudflare API was called for this review. This review does not
authorize a live read, source freeze, export, write, deploy, or cutover.

The maintained [supplied inventory assessor](../runbooks/2026-09-28-source-writer-inventory-assessor.md)
remains local-only, caller-supplied review evidence. The broader source-freeze
and transfer blockers remain as described in the [production D1/R2 transfer
lane](../plans/2026-09-28-gcp-production-d1-r2-source-transfer-lane.md).

## Verified local boundary

- [`production-source-writer-inventory.mjs`](../../apps/worker/scripts/production-source-writer-inventory.mjs)
  accepts only a closed v1 binding schema: `type`, `name`, `target`, and
  `role`, plus `transferDisposition` for R2. A service binding is reduced to a
  Worker-name `target`. A queue producer must be `{ worker, binding }`; a
  consumer must be `{ worker, settingsDigest }`. Unknown fields and variants
  refuse.
- [`production-maintenance-transport.mjs`](../../apps/worker/scripts/production-maintenance-transport.mjs)
  fixes the API host/account path, bounds reads, and writes hash-only private
  receipts. It refuses responses advertising more than one page, a continuation
  cursor, or an incomplete total. It is not a pagination collector.
- [`production-maintenance-provider.mjs`](../../apps/worker/scripts/production-maintenance-provider.mjs)
  reads only `page=1&per_page=100` for queues and limits that list to 20 entries;
  it then lists consumers per queue. It is an operation-specific inventory
  guard, not an account-wide queue export. Do not reuse that result as the
  source-freeze graph.

## Current Cloudflare API contract gaps

These endpoint shapes were checked against the official Cloudflare API and
Workers documentation on 2026-09-28:

1. **Queue pagination and edge types.** [List Queues](https://developers.cloudflare.com/api/resources/queues/methods/list/)
   returns paginated queue records with `result_info` and exposes producers as
   either Worker (`script`) or R2 bucket (`bucket_name`). Its consumers include
   Worker and HTTP Pull variants, with type-specific settings, retry behavior,
   and dead-letter queue fields. The current assessor cannot encode the R2
   producer or HTTP Pull consumer as an edge. Its consumer shape would also lose
   the consumer type and dead-letter reference. The current API documentation's
   example includes a Worker consumer while setting `consumers_total_count` to
   zero; do not use those totals as a completeness check until their semantics
   are verified with a supported fixture or clarified by Cloudflare.

2. **R2 event-notification producers.** Queue metadata reports an R2 bucket
   producer, but not the full notification rules that connect it to a queue.
   [R2 bucket listing](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/list/)
   is cursor-paginated by jurisdiction. The separate [R2 event-notification
   listing](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/event_notifications/methods/list/)
   returns queue associations and rules, including actions, prefixes, and
   suffixes, for one bucket. A complete relationship inventory therefore needs
   a full bucket walk for every supported jurisdiction followed by a read of
   every bucket's notification configuration, then exact reconciliation with
   the Queue producer edges. The v1 producer schema cannot represent these
   bucket-origin edges or rule details.

3. **Worker binding fields and classifications.** [Worker version reads](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/)
   expose `resources.bindings`; the [binding metadata reference](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/)
   documents types beyond the v1 allowlist (including browser rendering,
   mutual-TLS certificate, and version-metadata bindings) and service binding
   configuration such as `environment`. The v1 service tuple has no environment
   field; its exact-key validator correctly refuses extra fields rather than
   preserving them. A collector must preserve the full documented resource
   target tuple and fail on new/unknown fields or types. It must not encode
   missing dimensions into concatenated strings.

4. **Writer roles and R2 disposition are not API facts.** The Workers API
   returns configured binding metadata, not a reviewed classification of
   whether the application code uses a D1/R2 binding to write, read, or both,
   nor whether a bucket is in scope for transfer. The v1 `role` and
   `transferDisposition` are supplied annotations. A future provider must join
   live metadata to an independently reviewed code-derived classification by
   an exact tuple (Worker, active version, binding type/name, every target and
   environment dimension). Missing, duplicate, unmatched, or stale
   classifications must refuse.

5. **Worker enumeration needs a documented completeness boundary.** [List
   Worker Scripts](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/)
   documents an account list and the official TypeScript client describes it as
   single-page; the endpoint documentation does not expose `result_info` or a
   result count. A future collector must establish that this endpoint covers
   every relevant Worker namespace and named environment and is not truncated
   for the account. It must not interpret a missing pagination field as proof
   that omitted Workers cannot exist. For each enumerated Worker, use the
   [deployment list](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/)
   contract that the first deployment is latest and require exactly one 100%
   version before reading its configuration. A stable two-pass metadata digest
   can detect observed drift but cannot replace a write fence or prove an atomic
   cross-service snapshot.

## Smallest future contract before implementation

Widen the assessor to a new, versioned graph schema before writing an API
adapter. The new schema should:

- Preserve provider binding types and all documented target dimensions as
  typed fields. Require an explicit, independently reviewed classifier record
  for code-level writer role and R2 transfer disposition, joined by the exact
  live tuple; do not infer either from the API response.
- Model Queue producers as a discriminated union for Worker bindings and R2
  notification rules. Model Worker and HTTP Pull consumers as separate
  variants. Preserve or canonically hash every queue, producer, rule, and
  consumer setting that affects capture, routing, retries, retention, or
  disposal. Unknown fields remain a hard refusal until explicitly classified.
- Implement bounded pagination: validate stable page totals and unique IDs for
  Queues; follow R2 bucket cursors to termination for each jurisdiction; reject
  repeated cursors, incomplete pages, contradictory counts, duplicate/missing
  resources, or budget exhaustion. Resolve the Queue count/example discrepancy
  before using totals as a proof. Reconcile R2 notification rules with Queue
  producer metadata in both directions.
- Keep identifiers only in owner-private mode-0600 input/output files and emit
  status and digests only. Use synthetic transport fixtures to test multi-page
  completeness, truncation, cursor loops, unknown variants, conflicting
  metadata, exact classification joins, and identifier-free output before any
  live metadata-read review.
- State clearly that provider collection is still metadata evidence, not a
  source-wide fence. It cannot enumerate direct operator/API writers that do
  not appear as Worker bindings or prove requests, Cron/Queue consumers, or
  already-started storage operations have drained.

## Remaining cutover gates

Even after that provider exists, the [source transfer plan](../plans/2026-09-28-gcp-production-d1-r2-source-transfer-lane.md)
remains blocked on the production-wide admission fence and in-flight drain
across every D1 binding, R2 mutation path, ledger writer, Worker request, Cron,
Queue producer/consumer, and direct operator/API writer. The full source capture
must then be rehearsed and measured, sealed to one freeze identity, encrypted
and stored privately, imported without serving traffic, and reconciled by
readback. A point-in-time metadata digest cannot authorize export, import, or
cutover. The plan's separate approval boundaries still apply.
