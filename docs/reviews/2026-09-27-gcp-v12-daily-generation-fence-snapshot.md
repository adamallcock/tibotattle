---
title: GCP daily public-source generation fence snapshot
date: 2026-09-27
type: review
status: snapshot
---

# GCP daily public-source generation fence snapshot

## Result and boundary

The daily publisher now has a synthetic PostgreSQL 17 source-generation fence
for its mutable public-source and eligibility inputs. It still reads only v1
and v1.1 records. No v1.2 record is added to published totals by this change.
This is source-level test evidence; it does not establish migration promotion,
GCP runtime qualification, or service deployment.

Migration `0095_community_daily_v12_authority_generation.sql` remains in the
staged primary directory. It adds nullable `public_source_generation` to
immutable daily revisions without a default or historical backfill, and creates
a monotonic singleton generation row. BEFORE STATEMENT DML triggers advance
that row for every covered relation. Separate BEFORE TRUNCATE triggers refuse
truncation without touching the generation row: PostgreSQL obtains
ACCESS EXCLUSIVE before invoking a TRUNCATE trigger, so advancing the generation
there could invert the publisher's generation-before-source lock order. The
focused PG spec compares both trigger inventories against the reviewed table
list, verifies the generation DML trigger sorts before other statement DML
triggers, and races TRUNCATE with a publisher holding the generation pin. Old daily
rows keep a null generation; the publisher cannot reuse them as `unchanged` and
writes a new immutable revision.

The generation inventory is:

- **Owner and eligibility:** `participants`, `accountless_upload_owners`,
  `accountless_enrollment_ledger`, `device_credentials`,
  `accountless_v11_device_authorizations`,
  `accountless_v12_device_authorizations`,
  `accountless_public_history_retention`, `telemetry_v12_device_capabilities`,
  `storage_v11_owner_links`.
- **Selected and candidate typed source:** `telemetry_v1_chunks`,
  `telemetry_v1_records`, `telemetry_v11_chunks`, `telemetry_v11_records`,
  `telemetry_v11_domains`, `telemetry_v11_domain_heads`,
  `telemetry_v11_domain_days`, `telemetry_v12_domains`,
  `telemetry_v12_domain_heads`, `telemetry_v12_domain_days`,
  `telemetry_v12_day_manifests`, `telemetry_v12_chunks`,
  `telemetry_v12_typed_records`, `telemetry_v12_typed_usage`,
  `telemetry_v12_typed_quota`, `telemetry_v12_typed_session_tools`,
  `telemetry_v12_typed_attributions`, `typed_telemetry_dictionary`.
- **Publication and runtime fence:** `storage_source_state`,
  `analytics_source_cursors`, `storage_ingestion_changes`,
  `typed_v1_admission_state`, `typed_v11_admission_state`,
  `publication_state`, `collection_controls`, `telemetry_v12_runtime`,
  `telemetry_v12_typed_runtime`.

The publisher sets a 40-second PostgreSQL `transaction_timeout`, takes its
same-day advisory lock as the first SELECT in its REPEATABLE READ transaction,
then takes `FOR SHARE` on the generation row before reading source inputs. A
source mutation committed after the transaction snapshot but before the
generation lock causes a serialization failure. A mutation started after that
lock waits until publication commits. The source reads take no row locks, which
avoids reversing this order against writers that already hold owner or journal
rows. The publisher fails closed if the staged generation relation is absent.

Active accountless v1.2 grant count and earliest expiry remain separate from
the stored runtime pins. The publisher reads them against
`transaction_timestamp()`, rejects an active grant expiring within 45 seconds
of transaction start, and bounds the transaction at 40 seconds. The five-second
margin is intentionally conservative. This bounds stale lease publication;
it does not qualify daily throughput.

## Validation

On 2026-09-27, the focused PostgreSQL 17 spec passed 33/33 against the private
fanout socket. The command ran from `apps/worker/`:

```sh
PG_TEST_SOCKET=/private/tmp/tibotattle-pg-fanout-20260926/socket \
PG_TEST_PORT=55433 npx vitest run --configLoader runner --config \
  vitest.postgres.config.ts postgres-test/postgres-community-daily-publisher.spec.mjs
```

It covers unchanged revision idempotence, legacy
null-generation refusal, missing-generation refusal, full DML and TRUNCATE
trigger inventories, refusal of a concurrent TRUNCATE while publication holds
the pin, a runtime change after snapshot, an accountless authorization change
after snapshot, refusal of runtime state/policy changes without their local
revision increment, acceptance with a strict increment, same-value DML
generation invalidation, owner-erasure blocking behind the generation lock,
and close-to-expiry fail-closed behavior. The publisher's v1/v1.1 projection
checks remain in the same spec. Worker typecheck, `npm run docs:check`,
`npm run test:preflight` (20/20), and `git diff --check` passed.

## Remaining gate

The typed v1.2 usage/quota/session projection is still not implemented in the
daily source CTE. The accepted five-branch D1 eligibility contract, same-device
v1.1 precedence, exact retained opt-out, terminal erasure behavior, and direct
typed cache-TTL pricing therefore remain publication gates. Keep v1.2 excluded
until those source mappings and their positive/negative PG17 tests are reviewed.

The source authority is defined by the [accepted public-source decision](../decisions/2026-09-11-public-contribution-sources.md), D1 eligibility and manifest migrations ([0011](../../apps/worker/ingestion-isolation-migrations/0011_v12_public_eligibility.sql), [0012](../../apps/worker/ingestion-isolation-migrations/0012_v12_empty_day_manifests.sql)), and the [PostgreSQL five-branch owner view in 0046](../../apps/worker/postgres/migrations/primary/0046_owner_journal_authority.sql). Typed usage and TTL field locations are defined in [PostgreSQL migration 0025](../../apps/worker/postgres/migrations/primary/0025_typed_v12_normalized.sql). The earlier [daily projection no-go snapshot](2026-09-27-gcp-v12-daily-projection-no-go.md) records why row projection and pricing remain disabled.

The generation is schema-wide and invalidates on zero-row or no-op DML as a
safe false positive. This can create extra immutable revisions and serializes
daily publishers with source mutations. Neither cost has been throughput-
qualified. The lock proof covers DML and refuses TRUNCATE; privileged DDL or
trigger-disabling operations remain outside ordinary publisher permissions and
need operational controls. Migration 0095 is staged only; do not run this
publisher against a schema where the staged pin is absent.
