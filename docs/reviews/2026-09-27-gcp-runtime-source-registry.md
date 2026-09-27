---
title: PostgreSQL runtime source registry gap
date: 2026-09-27
type: review
status: snapshot
---

# PostgreSQL runtime source registry gap

**Status:** source-only review of integration base `3f74d2eb94e115c04da09e5452261ad2c8970b2c` on 2026-09-27. No live GCP database or D1 snapshot was inspected. This review does not qualify deployment, transfer, or cutover.

Worker file citations below are relative to `apps/worker/`; `docs/` citations are repository-relative.

## Decision

**Hard no-go for PostgreSQL runtime-source registry import/readback and PT-8 eligibility.** The PostgreSQL schema has source identifiers and typed namespaces in separate contracts; no existing table preserves the D1 tuple, immutability, retention, and foreign-key role losslessly. The sealed analytics transfer validates the registry but does not page, import, or read it back. Completion needs an explicitly owned forward-only PostgreSQL migration and exact sealed import/readback. This review assigns neither an owner nor a migration number.

## Verified facts

### D1 registry contract and consumers

`analytics-migrations/0006_runtime_source_contract.sql:1-11` defines `analytics_runtime_sources` with `source_id` as the primary key, non-null `source_namespace`, and `contract_version = 1`; unconditional triggers refuse every update and delete. The migration comment says the analytics database may consume several registered sources. Runtime initialization inserts the exact `(source_id, source_namespace, 1)` tuple, then independently reads it back. Its source check requires the same namespace in both typed-v1 and typed-v1.1 source identities (`src/storage-analytics-runtime.ts:101-123, 201-210`). Ordinary admission also requires the registry namespace and version to match (`storage-analytics-runtime.ts:138-148`).

Later D1 analytics migrations use `source_id` as a foreign key to this registry: `0016_admin_metrics_history.sql:9,16`, `0017_graph_work_selection.sql:20`, `0019_graph_day_projection.sql:31`, `0020_cache_retention_day.sql:91,163`, `0021_cache_retention_bands_v2.sql:116,188`, `0022_cache_retention_root_scope_v3.sql:124,196`, `0023_cache_retention_v1_layout.sql:115`, `0026_cache_retention_effective_layout.sql:127,223`, and `0027_admin_metrics_history_publications.sql:16`.

Runtime readers use the row for namespace- or version-scoped graph publication, daily publication readiness, erasure, cache retention, admin metrics, and admin overview: `src/storage-community-daily.ts:97`; `src/storage-community-graph-publication.ts:58,89`; `src/storage-community-graph.ts:445`; `src/storage-erasure.ts:107,191`; `src/storage-admin-overview.ts:131`; `src/cache-retention-day.ts:155,1706,1740`; `src/admin-metrics-history.ts:816,935,1393`. `src/telemetry-runtime-activation.ts:764` includes it in the required analytics schema inventory. This is a runtime identity and referential-integrity contract, not transfer-only metadata.

Worker tooling also reads and writes the registry: production maintenance registration reads and inserts it (`scripts/production-maintenance-analytics-registration.mjs:18-19`); production preflight, cutover proof, and the contribution funnel query or guard it (`scripts/production-typed-preflight.mjs:30`, `scripts/production-maintenance-cutover-proof.mjs:53`, `scripts/contribution-completion-funnel.mjs:52-53`); forward-migration checks seed it and verify its FK behavior (`scripts/typed-forward-migration.mjs:102,551,633,1231`). Synthetic runtime and migration tests also insert it (`test/last-good-publication-migration.spec.ts:24`, `test/cache-retention-day.spec.ts:117`, `test/graph-day-projection.spec.ts:63`).

### PostgreSQL candidates do not form that contract

PostgreSQL `analytics_owner_state` carries `source_id` with an owner key; `analytics_source_cursors` carries `source_id` with sequence and authority epoch; and singleton `storage_source_state` carries `source_id` with authority epoch. None has `source_namespace` or `contract_version` (`postgres/migrations/primary/0007_analytics_lifecycle.sql:8-15,183-192`). These definitions do not make the source identifier a foreign key to a registry.

The closest namespace candidates are separate `typed_v1_admission_state` and `typed_v11_admission_state` rows. Each has its own `source_namespace` and its own `runtime_contract_version`, which may be `0` or `1` (`postgres/migrations/primary/0033_legacy_admission_proofs.sql:9-23`). The typed-storage migration explicitly says v1 and v1.1 have independent namespaces and owner history (`postgres/migrations/primary/0030_legacy_typed_telemetry.sql:47-52`). Consequently, these rows cannot prove D1's one namespace and one version-1 registration. Their separate values also cannot be collapsed into one namespace without a source-backed equality proof and a contract decision. The PostgreSQL table `analytics_owner_results` stores a namespace on result rows, not a registry tuple or parent identity (`postgres/migrations/primary/0020_analytics_results_and_delivery.sql:9-36`).

### The current sealed transfer omits the registry

`scripts/postgres-analytics-history-transfer.mjs:30-49` validates the D1 registry's column names and types and validates its row values. `:364-383` reads registrations for a content-free identity manifest, but replaces each raw namespace with only its SHA-256. `:464-492` requires exactly one registry row paired with one cursor and checks version 1. The pageable/importable `SPECS` and the scan/readback manifest include only owner state and cursors; the event journal has a separate lane (`:51-75,618-621`). The transfer result explicitly reports `sourceNamespaceRegistryTransferred: false` and `runtimeSourceRegistryTargetDdlOwned: false` (`:1218-1228`). It therefore has no exact raw-namespace target import or readback proof. The transfer-target acceptance test also states that it runs no importer and proves no `analytics_runtime_sources` transfer or PT-8 eligibility (`postgres-test/postgres-transfer-target.spec.mjs:48-55`).

## Inference and gate effect

The sealed namespace hash binds identity for the current receipt, but cannot supply the raw namespace that runtime readers compare and retain. The PostgreSQL source tables do not independently prove that raw value or a version-1 registry row. A source ID present in a cursor or event row therefore cannot stand in for registration, and a complete transfer-control receipt cannot fill this gap.

This leaves the plan's **Historical source transfer** gate open: it still requires a fenced real D1/R2 export, exact history/object import, and proof that admitted writes are neither lost nor duplicated (`docs/plans/2026-09-24-gcp-source-integration.md:30-39`). It also blocks parent-tracked **HX-2** evidence to the extent that gate requires runtime-source transfer. PT-8 is independently blocked because the transfer target requires source import/readback evidence before flip readiness; control receipts alone expressly do not satisfy it (`scripts/postgres-transfer-target.mjs:23-27,2068-2077`).

## Acceptance boundary for a future owned implementation

Before either gate can count this family:

1. Assign a DDL owner and name a forward-only PostgreSQL migration in the existing primary-schema migration lane. Preserve the three D1 fields, source-id key, version-1 restriction, no-update/no-delete behavior, and registry-parent foreign-key semantics. Tests must show update/delete refusal and rejection of source-bearing rows with an unregistered ID.
2. Extend the sealed source page, import, and destination readback contract to carry every required registry tuple with the raw namespace. Bind source and destination row counts and exact values to the sealed snapshot; reject absent, extra, conflicting, or changed rows before recording transfer completion. Preserve the existing fail-closed singleton check unless and until a multi-source transfer contract is implemented and tested.
3. Prove namespace continuity against the source identity used by the imported analytics state. Do not derive one namespace from the separate PostgreSQL v1/v1.1 admission rows unless their equality is explicitly proven for that sealed source; the PostgreSQL schema currently permits and documents independent namespaces.
4. Exercise fresh import, retry after a committed page, exact readback, orphan-FK refusal, namespace mismatch, unsupported contract version, and source mutation during transfer. Only this importer/readback evidence can unblock the historical-transfer input to HX-2 and PT-8; it does not by itself qualify live data, deployment, or cutover.
