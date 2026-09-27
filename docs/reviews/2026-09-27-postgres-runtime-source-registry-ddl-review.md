---
title: PostgreSQL runtime source registry DDL candidate
date: 2026-09-27
type: review
status: snapshot
---

# PostgreSQL runtime source registry DDL candidate

**Scope:** source-only review of candidate work based on revision c34bbafd1cc3cfabb0e0dc4d7e02efb4d6675d51. No production PostgreSQL or D1 database was inspected.

## Candidate state

Staged primary migration 0092_runtime_source_registry.sql preserves the D1 identity tuple as source_id, raw source_namespace, and contract_version = 1. It rejects bounded-value violations and every row update or delete, plus table truncation.

The migration adds validated source_id foreign keys only to the existing PostgreSQL analytics_admin_metric_snapshots and analytics_admin_metrics_history_cache tables. These are the current PostgreSQL relations with direct D1 counterparts whose D1 definitions reference analytics_runtime_sources. The D1 graph-work, graph-day, cache-retention, and history-publication FK families do not have matching current PostgreSQL relations.

## Gate boundary

The focused PostgreSQL 17 spec verifies application on a fresh schema, multiple exact registrations, duplicate/conflicting IDs, validation failures, FK orphan refusal, and update/delete/truncate refusal. A populated-schema rehearsal confirms an existing unregistered admin-history row makes the migration fail with the registry and both FKs rolled back; the legacy row remains. Therefore the candidate cannot apply to populated analytics state until every existing row in those two FK-backed relations has an exact source-backed registration.

No registry importer, raw-namespace readback, or backfill is implemented. The namespace hash in existing transfer evidence and the separate v1/v1.1 admission rows do not supply the raw D1 namespace. Do not derive a registration from either. Historical source transfer and PT-8 remain no-go; this staged DDL and its synthetic PG17 tests do not qualify import, deployment, or cutover.
