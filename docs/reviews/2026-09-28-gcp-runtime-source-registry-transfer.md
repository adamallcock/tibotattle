---
title: GCP runtime source registry transfer slice
date: 2026-09-28
type: review
status: staged-source-only
---

# GCP runtime source registry transfer slice

**Scope:** source-only review from integration base `f706555b`. This qualifies a
single sealed analytics registry transfer into an isolated staged PostgreSQL
schema. It is not production D1 evidence, a stock migration, or cutover proof.

## Verified slice

Staged primary migration
[`0092_runtime_source_registry.sql`](../../apps/worker/postgres/staged-migrations/primary/0092_runtime_source_registry.sql)
preserves `source_id`, the raw `source_namespace`, and `contract_version = 1`.
The sealed SQLite importer validates the staged target's constraints, foreign
keys, and immutability triggers; serializes transfers; inserts exact registry
tuples; reads each page back; and verifies final source and target row counts
and manifests before commit. The receipt exposes hashes and counts only. The
result marks raw namespace transfer/readback and staged DDL validation
separately from receipt disclosure, stock-migration readiness, and production
promotion readiness.

Focused PostgreSQL 17 qualification used synthetic SQLite fixtures and
disposable schemas over a private local Unix socket. It passed 3/3 tests with
zero skips. The registry case covers Unicode namespace readback, source rows
without a matching registration, a source registry changed after sealing, a
conflicting target registration, extra target rows, and immutable-target
refusal. Worker analytics-transfer script checks, migration checks, and
TypeScript typecheck also passed in this checkout.

## Remaining gates

Migration 0092 remains in the staged lane and is not in the stock primary
manifest. Promotion into that manifest, the corresponding Cloud Run build
context and migration-tail pins, a rebuilt test-gateway image, and any database
apply remain separate work. The importer accepts only its declared source-id
and namespace subset; it refuses wider D1-valid tuples and does not establish
full registry parity. It does not transfer analytics history, enable readers
or publication, qualify namespace continuity against production data, or
authorize PT-8 or cutover. No remote resources or source rows were inspected.

This updates the earlier source-level registry gap only for the isolated
staged tuple import/readback. The production migration and transfer gates
remain open.
