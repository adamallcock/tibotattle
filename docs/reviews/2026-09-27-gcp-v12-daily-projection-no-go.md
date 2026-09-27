---
title: GCP v1.2 public daily projection no-go
date: 2026-09-27
type: review
status: snapshot
---

# GCP v1.2 public daily projection no-go

## Decision and scope

Do not add v1.2 records to the PostgreSQL daily publisher in a publisher-only
change. The accepted public-source policy includes accountless v1.2, but the
immutable daily revision does not persist enough authority state to decide
whether an existing revision is still `unchanged`. A forward schema and
publisher change is required. This is a source-level no-go for this scoped
change; it says nothing about live GCP activation or readiness.

Reviewed branch: `codex/gcp-v12-daily-publisher`, based on `5a0e7ddb195d7337c316442501e0a035ef98894d`.

## Accepted source and typed-record semantics

D1 ingestion-isolation migrations 0011 and 0012 admit accountless v1.2 through
the exact active owner, enrollment, device, successor authorization, and accepted
v1.2 head. They exclude a device with any v1.1 domain from the v1.2 branch. The
retained branch requires the exact prospective opt-out marker and accepted v1.2
head. PostgreSQL primary migration 0046 identifies its
`community_public_source_owners` view as the line-by-line D1 port and lists five
disjoint branches: social, v1.1 active, v1.1 retained, v1.2 active, and v1.2
retained (`apps/worker/ingestion-isolation-migrations/0011_v12_public_eligibility.sql:98-174`,
`apps/worker/ingestion-isolation-migrations/0012_v12_empty_day_manifests.sql:177-355`,
`apps/worker/postgres/migrations/primary/0046_owner_journal_authority.sql:486-490,491-654`).

The typed schema has no `record_json` column. Usage records store provider and
occurrence on `telemetry_v12_typed_records`; model, context, token components,
and explicit five-minute and one-hour cache-write buckets live in
`telemetry_v12_typed_usage` (`apps/worker/postgres/migrations/primary/0025_typed_v12_normalized.sql:128-175`).
A direct typed pricing adapter can use those values with the shared
`priceTelemetryUsageEvent` path. The current `priceChunkUsageRecord` adapter
accepts JSON and sets both cache-write TTL inputs to unknown except when
aggregate cache writes are known zero; synthesizing legacy JSON for v1.2 would
lose an explicitly stored split (`apps/worker/src/postgres-community-daily-publisher.ts:99-107,504-526`,
`apps/worker/src/quota-analysis-v1.ts:742-804`). The shared
`priceTelemetryUsageEvent` pricer is available for a typed adapter
(`apps/worker/src/server-pricing.ts:221-255`). Preserve the typed split in the
follow-up; this pricing concern is separable from the decisive fence gap.

## Decisive fence gap

The current publisher's CTE explicitly omits v1.2 and reads only v1/v1.1
(`apps/worker/src/postgres-community-daily-publisher.ts:144-153`). More
importantly, `captureFence()` locks and captures the source epoch, analytics
cursor, v1 and v1.1 admission versions, global publication revision, and
collection revision. It does not read either v1.2 runtime row or the current
v1.2 authorization-expiry boundary (`apps/worker/src/postgres-community-daily-publisher.ts:559-617`).

The same-day `unchanged` check compares only source epoch/cursor, global policy
revision, collection revision, and the stored payload digest. Its insert
persists only those four source/policy fence values. The immutable
`community_daily_aggregates` schema has no v1.2 runtime or authorization-window
columns (`apps/worker/src/postgres-community-daily-publisher.ts:668-684,742-758`,
`apps/worker/postgres/migrations/primary/0037_community_daily_publications.sql:6-26`).
Consequently, adding v1.2 rows to the CTE would allow changed v1.2 eligibility
to reuse a daily row under the same persisted fence. Repurposing
`policy_revision` or `source_cursor_sequence` would conflate independent
contracts and is not a safe repair.

The missing inputs are real authority state. PostgreSQL stores
`telemetry_v12_runtime.state/revision` and
`telemetry_v12_typed_runtime.state/policy_revision` separately
(`apps/worker/postgres/migrations/primary/0006_telemetry_v12_usage_quota_session.sql:6-13`,
`apps/worker/postgres/migrations/primary/0025_typed_v12_normalized.sql:10-32`).
The typed active-authorization view also depends on both runtimes and filters
accountless grants and enrollment leases by `expires_at > now()`; the retained
authorization view has a separate expired-active and explicit-opt-out path
(`apps/worker/postgres/migrations/primary/0025_typed_v12_normalized.sql:45-112`).
Thus v1.2 eligibility can change as time advances even when stored telemetry,
source cursor, global publication policy, and collection revision do not.

The existing graph publisher treats these as independent pins: it captures
both runtime states and revisions, plus the count of active unexpired
accountless authorizations and their next expiry, then rechecks them while
holding the runtime rows `FOR SHARE` (`apps/worker/src/postgres-community-graph-stream-publisher.ts:56-72,193-219,364-394`).
The daily publisher has no equivalent durable pin. Primary migrations define no
trigger coupling updates to either runtime row to the daily row or ingestion
cursor; the v1.2 head journal does not turn runtime policy transitions into
source-record events.

## Required additive contract for the follow-up

Add nullable legacy-compatible fields to `community_daily_aggregates` for:

- `telemetry_v12_runtime_state` and `telemetry_v12_runtime_revision`;
- `telemetry_v12_typed_runtime_state` and `telemetry_v12_typed_runtime_policy_revision`;
- the active unexpired v1.2 authorization count and the next active
  authorization expiry timestamp.

For a pre-migration revision, both runtime-state columns and all four other
pin values must be null. For a new revision, persist both runtime states,
both revisions, and the authorization count; the next-expiry value is null
exactly when the count is zero. A publication that selects any v1.2 record must
have both runtimes active; otherwise it must select no v1.2 records. Do not
backfill historical rows from today's runtime or authorization state; their
publication-time values are unknown, so the first post-migration build must
create a new immutable revision.

The publisher must select and lock both runtime rows, read the same active
authorization count/next-expiry pair used by the graph source pin, and include
all six values in the daily fence, previous-revision comparison, and insert.
Runtime state or policy updates must advance their respective revision in the
same atomic operation; otherwise an active-to-blocked-to-active transition can
escape a value-only fence. Keep these fields separate from the global policy
revision and ingestion cursor. Retain the five-branch public-owner view,
exact opt-out head marker, same-device v1.1 exclusion, source-cursor/terminal
fences, and typed cache-write split.

The follow-up should prove with synthetic PostgreSQL 17 tests that identical
pinned inputs return `unchanged`, runtime or authorization-expiry pin changes
produce a new revision or fail closed even when the source cursor is unchanged,
and typed v1.2 usage/quota/session data is included once with exact spend fields.
It should also cover same-device v1.1 exclusion, active and exact-retained v1.2
eligibility, opt-out and erasure fences, and the typed Anthropic cache-write
TTL split. No code or PostgreSQL tests were changed or run for this no-go
review; no live GCP or Cloudflare operation was performed.
