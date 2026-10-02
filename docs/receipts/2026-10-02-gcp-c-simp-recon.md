---
title: GCP C-SIMP-RECON reconciling C-SIMP with the fast-path final line
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP C-SIMP-RECON reconciling C-SIMP with the fast-path final line

This is a 2026-10-02 receipt for stream C-SIMP-RECON on branch
`claude/gcp-fp-c-simp-recon`. The branch starts at `0d3f73c8` (the fast-path
final line after C-REFRESH) and has two commits:

1. `ecd2c3f9` merges `claude/gcp-fp-c-simp` at `1b48da3c` and resolves the
   seven text conflicts exactly as the C-SIMP integrator did, keeping both
   sides. On its own, this commit does not pass the append-only gates.
2. The commit that adds this receipt fixes the semantic clashes between
   C-SIMP and the work merged after C-SIMP's base `afd865a0`: C-ADMIN,
   C-MAINT and C-REFRESH.

It is **not merged** into `claude/gcp-fastpath-final`. The integrator owns
that merge, the `CUTOVER-CHECKLIST.md` update, and the promotion of C-IPR's
staged `0065_interim_public_read.sql`. `0064_append_only_residue.sql` is
final (OD-1) and this stream did not change it.

All evidence is **local and synthetic**: one macOS arm64 workstation, Node
26.2.0 for tooling, Node 22.16.0 for the dist and the analytics-v2 suite, and
the local PostgreSQL 17 fan-out cluster on a private Unix socket (port
55433). Nothing was built in the cloud, deployed, migrated or read in any GCP
or Cloudflare project. No push ran. Every bucket, proof, schema and owner in
the tests is synthetic.

## Authority

- The owner's answers of 2026-10-02, rounds 1 to 8. Two are applied here:
  - Round 8 (OWN-19): C-MAINT's in-transaction receipt reader becomes ONE
    named, counted exception, pinned until CR phase B.
  - Round 1 OD-2: the single quarantine bucket-birth proof.
- The C-SIMP integrator's failed-merge report, for the four clashes and the
  seven text-conflict resolutions.
- The [C-SIMP receipt](./2026-10-02-gcp-c-simp.md),
  [C-ADMIN receipt](./2026-10-02-gcp-c-admin.md) and
  [C-MAINT receipt](./2026-10-02-gcp-c-maint.md). The C-ADMIN and C-MAINT
  receipts each gain a dated supersession note that points here.

## Clashes and fixes

| # | Clash | Fix |
|---|---|---|
| 1 | C-ADMIN's admin console read a deletion ledger. `routes/admin-console.mjs` took an optional `pools.ledger` and `schemaOptions.ledgerSchema` and defaulted `deletionLedger` to `readPostgresAdminDeletionLedger`. That gave the ledger-absence gate 11 unpinned `ledgerPool`/`ledgerSchema` tokens there and 4 in `src/postgres-admin-overview.ts`. | The reader and both options are removed. `pools` accepts only `{primary, analytics}` and `schemaOptions` only `{primarySchema}`, so a stale root that passes a ledger pool or schema is refused (`ADMIN_ROUTE_CONFIGURATION_INVALID`), with negative cases in `admin-console.check.mjs`. `deletionLedger` has no default: like the other two unsourced blocks, it is served only by an injected source, and until one exists the overview is the Worker's 503. It is never reported as zero. Database health passes no ledger pool, so `deletion_ledger` reports `not_configured` and the status stays `degraded`. The closed DTO is unchanged. |
| 2 | `postgres-admin-console.spec.mjs` set up with `applyPostgresMigrations({role:"ledger"})`, which C-SIMP's migrator refuses (`POSTGRES_MIGRATION_ROLE_INVALID`). | The spec uses the primary chain only. It injects a synthetic `deletionLedger` source: the Worker's own block, read over the D1 SQLite fixture, which the Worker parity side still carries. The composed-console case now expects `deletion_ledger: not_configured` and `degraded`. The spec had never run on the merged tree, so running it here exposed a fifth interaction: 0064 pins `restored_participants_suppressed = 0`, and C-ADMIN's `retention_state` fixture held `1`. The fixture now holds `0` on both sides. Result: 10/10. |
| 3 | `src/postgres-lifecycle-pass.ts` reads `_tibotattle_migration_history` itself (`assertReceipt`, inside its transaction). The single-reader guard refused it. | Per OWN-19, `scripts/ledger-absence.check.mjs` gains `RECEIPT_READER_EXCEPTIONS`: exactly one entry, `src/postgres-lifecycle-pass.ts`, named `OWN-19`, until `CR phase B (D-CRB)`, pinned at its 4 history references. The guard refuses the following: growth past the pin; any `readSchemaReceipt` declaration in the excepted file; a stale entry whose references fall (shrink or remove it); and, with the exception in place, any third reader in src or cloud-run. A new test proves each of these and also checks the pin against the module's real count. The pass's source comment names the exception. |
| 4 | Two OD-2 proof parsers ran in the maintenance Job. C-MAINT's `readPostgresMaintenanceJobHistoryProof` accepted a `{proof}` receipt wrapper and reported `_BUCKET_MISMATCH`. CR-3 had already parsed the same variable with closed keys inside `readProductionConfiguration`. | The Job's parser, its `POSTGRES_MAINTENANCE_JOB_HISTORY_PROOF_VARIABLE` export and its `createGcsErasureBucketHistoryProof` import are removed. The Job now takes CR-3's `resources.bucketHistoryProof`, which is one parse with one set of codes: `_MISSING` for absent or empty, `_INVALID` for anything else, a bucket mismatch included. The check asserts that the Job's proof equals CR-3's. It also refuses a wrapper, an extra key, generation `0` and a staging-bucket mismatch, all as `_INVALID`. **Root cause of CR-3's `_INVALID`:** the check's synthetic proof itself was valid. The failing case was the check's `{schemaVersion, proof}` wrapper, which only C-MAINT's parser unwrapped. CR-3 and `parseGcsQuarantineBucketHistoryProof` deliberately accept only the closed four-key record, which is exactly what OPS-2 renders, and the OPS-2 service invariant checks the same shape. The second failure was the retired `_BUCKET_MISMATCH` code. C-MAINT's lifecycle-pass spec passed the same wrapper to the Job and is corrected. |

Other fixes the merged tree needed:

- **C-REFRESH vs C-SIMP** (merged after the integrator's attempt):
  - `analytics-refresh.mjs` still named `FASTPATH_TEST_CLOUD_TARGET.ledgerSchema`. C-SIMP removed that field, so the value was `undefined` in the refused-identity set. The reference is removed.
  - Its 3 `LEDGER_*` tokens are the mirror of CR-3's forbidden variables, which is refusal code, and are now pinned in `REFUSAL_SITES`.
  - Its spec's CR-3 parity case now supplies the OD-2 proof that CR-3's analytics-job profiles require. The full `analytics-v2-refresh.spec.mjs` run gives 44/44.
- **C-MAINT vs 0064:**
  - With 0064 promoted, the database's CHECK constraints refuse a state that violates the restore pins before the pass sees it.
  - The conflict spec now asserts the database refusal (23514). It then lifts the two constraints in its disposable schema to prove the pass's own `LIFECYCLE_RESTORE_PIN_CONFLICT`, and restores them exactly as 0064 defines them. Result: 9/9.
- **Unpinned `LEDGER_*` in the Job check:** `cloud-run/postgres-maintenance-job.check.mjs` (`LEDGER_*`: 1, the negative test of `LEDGER_SCHEMA_FORBIDDEN`) is now in `REFUSAL_SITES`.
- **Root `test/tool-inventory.test.js`:** the `scripts/lib/release-operation.mjs` record now names its four missing static callers:
  - `apps/worker/scripts/cloudflare-writer-fence.mjs` (the known failure);
  - `edge-mode-configuration.mjs`, `production-edge-mode.mjs` and its check, which the edge work added after that failure was recorded.

  Result: 6/6.

## Migrations

None was added or renumbered. The primary chain is still 0001 to 0064, with
`0064_append_only_residue.sql` (C-SIMP, final). C-IPR's
`staged-migrations/primary/0065_interim_public_read.sql` stays staged for the
integrator to promote. Its spec passes against this tree with 0064 applied
(18/18).

## Gates

All gates ran on the working tree that this commit records. Each broad suite
ran once. PG env means `PG_TEST_SOCKET=/private/tmp/tibotattle-pg-fanout-20260926/socket`,
`PG_TEST_PORT=55433` and `PG_TEST_TCP_HOST/PORT=127.0.0.1:55433`.

| Gate | Result |
|---|---|
| `apps/worker`: `tsc --noEmit -p .` | pass |
| `npm run scripts:check` (PG env) | pass: 1059/1059 node tests |
| `npm --prefix cloud-run run check` (PG env) | pass: 312 pass, 0 fail, 1 skip (the env-gated A2 daily-activation case). Includes `admin-console.check` 24/24 and `postgres-maintenance-job.check` 15/15 |
| `postgres:domain:check`, vitest half | pass: 14 files, 84/84 |
| `postgres:domain:check`, node half (one run) | 394 tests: 392 pass, 1 fail, 1 skip (Q-1 dump not set). The failure was the C-REFRESH CR-3 parity case (missing OD-2 proof). After the fix, its spec file passed in full: 44/44. The admin-console (10/10), lifecycle-pass (9/9), interim-public-read (18/18) and append-only-residue (15/15) specs also passed individually |
| `npm run analytics-v2:check` (Node 22.16.0, PG env) | pass: 13 files, 155/155 |
| `npm run gcp:fastpath:scripts-check` (PG env) | pass: 81/81 |
| `npm run gcp:production-tooling:local-check` (PG env) | pass: 34 + 5, 19, 197, 32; none skipped |
| `npm run edge:e2e:check` | pass: 18/18, with the worker, fenced and gcp overlays rendered |
| `npm run append-only:absence:check` | pass: 19/19 (ledger absence, online-erasure absence, the OWN-19 exception test) |
| `node scripts/ci-postgres-suite.mjs --plan`; `node --test scripts/ci-postgres-suite.check.mjs` | planned, `failures: []`; 43/43 |
| `npm run postgres:migrations:check` | pass (11/11, 2/2; runtime schema `--check` clean) |
| `node --test scripts/migration-numbering.check.mjs` | pass: 7/7 |
| `node scripts/cloud-run-build-context.mjs --check` | pass |
| Root: `node --test test/hosted-backend-workflow.test.js test/release-workflow-policy.test.js test/tool-inventory.test.js` | pass: 37/37 |
| Root: `npm run architecture:check` | pass: 932 production files, 3968 imports, 0 debt edges |
| Root: `npm run test:preflight` | pass: 20/20 |
| Q-1 rehearsal (`gcp-fastpath-rehearsal.mjs --golden analytics-v2-test/golden --per-date-expected … --owner-reference analytics-v2-test/golden-q1-node`; Node 26 runner, Node 22.16.0 dist and refresh) | pass, every gate true. See [Q-1 rehearsal](#q-1-rehearsal) |

## Q-1 rehearsal

**`status: pass`**. Every gate was true: importers completed, the first
refresh completed, the read returned 200, the second run created 0 new
revisions, parity had 0 unexpected differences, per-date was equal, and
owner parity had 0 unexpected differences. The dist was rebuilt from this
tree with Node 22.16.0 before the run.

- Migrations: primary applied 64 of 64 expected, tail
  `0064_append_only_residue.sql`. No ledger schema.
- Importers: identity, typed-legacy, legacy transport, v1.2 (510 day
  streams, 0 union-divergent), usage-correction and ingestion journal all
  complete. The roster, public source owners and owner revisions are all
  equal: 4 owners each.
- Read: 200, 396,337 bytes (the same size as C-REFRESH's Q-1 body), from
  the `fastpath-test` origin on Node v22.16.0.
- Parity:
  - 168 of 168 days; 0 unexpected families or differences.
  - The 14 withheld model dates were published and held to the per-date
    expectation; none is unverified.
  - The per-date preview and allowance breakdowns are equal.
- Owner parity:
  - 4 owners; 0 unexpected families or differences.
  - Refusals by reason: 2 for `cache:incomplete_cache_day`, 7 for
    `cache:incomplete_cache_lookback`, 2 for
    `daily:source_conflict_or_order` and 4 for
    `model:incomplete_window`. That is 15 in all, as on the final line.
- Refresh: both runs `ok`, 4 owners, 680 owner-days, 15 refusals. The
  second run published 168 days before and 168 after, with 0 new revisions.
- Cleanup: both created schemas were dropped. A read-only check afterwards
  found no leftover `c_admin*`, `c_maint*` or rehearsal schema. Only the
  `tibotattle_dense_parity` and `tibotattle_q1_parity` databases remain,
  untouched.

## Open items

- **OWN-17** is still open:
  - question 1: what serves `deletionLedger`, `historicalPublication` and `counts.contributions.synthetic`;
  - question 3: how the retired `deletion_ledger` role appears in database health.

  This stream removed the impossible ledger default and invents no source and no new DTO value. The overview therefore stays 503 until a root injects all three sources, as before. The other five admin routes work as they did.
- **D-CRB (CR phase B)** must do two things:
  - consolidate `readSchemaReceipt` and the lifecycle pass's reader into one shared reader, and delete the `RECEIPT_READER_EXCEPTIONS` entry;
  - move `cloud-run/server.mjs`'s test-host proof read (it calls `parseGcsQuarantineBucketHistoryProof` in src, the grammar CR-3 mirrors and is pinned equal to, with the same `_MISSING`/`_INVALID` codes) onto CR-3 when the production host composes through `readProductionConfiguration`.
- **MAINT-PURGE** is unchanged: the pass still leaves out the scheduled purges.
