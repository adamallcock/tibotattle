---
title: Admin database health
date: 2026-09-21
type: plan
status: implemented
---

Add an independent owner-only database read probe to the admin page. Show each
configured D1 role, read availability, response time, reported size and observation
time. Isolate partial failures and preserve explicitly stale results on refresh
failure. Distinguish JSON storage from the separate typed analytics database.

Use constant read-only queries, a bounded response deadline and existing owner
Access authentication. Never expose database IDs, raw errors or participant rows.
No migration, settings change, data write or production deployment is required.
A successful probe does not establish write capacity, schema compatibility,
backup health or end-to-end readiness.

Validate the API, authentication, browser contract and failure/recovery rendering;
regenerate bundled assets and run the scoped gates. Record remaining deployment
and broad-suite limitations honestly.

## Validation and claim boundary

Implemented with an additive owner-only endpoint and independent browser lane.
Validated against current main with 104 focused Worker tests, 989 UI tests,
TypeScript, generated-asset, API-inventory, documentation, preflight, architecture
and production-deployment script checks. Rendered desktop and narrow layouts,
stale evidence and recovery were inspected using isolated synthetic fixtures.
Local D1 connectivity was exercised by Worker tests; live production connectivity
has not been checked by this new endpoint. No deployment or migration occurred.

The full Worker gate was also started; its broad suite and release-asset dry-run
are separate from the scoped evidence above. Consult the PR validation record
for that run's final outcome before treating the whole Worker as qualified.
