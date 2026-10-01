---
title: GCP fast-path final integration
date: 2026-10-01
type: receipt
status: snapshot
---

# GCP fast-path final integration

This is a 2026-10-01 receipt for branch `claude/gcp-fastpath-final` at code
commit `298afb15`, built on the frozen `claude/gcp-fastpath` `f0b6158a`
(whose [local rehearsal receipt](./2026-10-01-gcp-fastpath-local-rehearsal.md)
stays the record for that commit). A later section,
[Intake merge and primary 0062](#intake-merge-and-primary-0062), records code
commit `0fea08b0`, which merges the IN-2/IN-3 intake composition on top. The
section [Cloud SQL seed preparation](#cloud-sql-seed-preparation) records code
commit `6850ba06`, which prepares the seed for a non-superuser Cloud SQL
session. It records **local, synthetic** evidence
only: one macOS arm64 workstation, a local PostgreSQL 17 cluster on a private
Unix socket and the Q-1 oracle's content-free four-owner corpus. Nothing was
pushed, deployed or seeded; no GCP or Cloudflare resource was read or
written; no production data was read. It does not qualify a Cloud Run image,
the GCP test project, the edge or production.

## What changed on top of the frozen tree

1. **DOC-1L** merged (`claude/gcp-fp-doc-1l` `d875e4d3`): the accepted
   append-only contributions decision and the fast-path plan. The plan now
   records the night's results.
2. **D-1** merged (`claude/gcp-fp-d-1` `49317912`). The only conflict was
   semantic: the fastpath migrate profile reads its counts from the deploying
   commit's migration directory, but the manifest check pinned every profile
   to the A2 counts. The check now takes counts per profile: A2 and the
   benchmark keep 59/7, fastpath must match its environment counts.
   `grantAndVerifyTestRuntimePrivileges` stays exported.
3. **Seed = rehearsal chain.** The rehearsal exports its own steps
   (`fastpathRehearsalSchemas`, `sealFastpathRehearsalSource`,
   `loadFastpathRehearsalImporters`), and `gcp-fastpath-seed.mjs` calls them
   with the migrator pool. One
   `typed_legacy_transfer_rehearsal_target_fastpath_<8 hex>` schema in
   `tibotattle_fastpath` gets the same chain as the local rehearsal: T-1
   identity copy, typed-legacy, T-1 legacy-transport copy, T-2, T-1 v1.2
   event-source copy, usage-correction and the ingestion journal, followed by
   T-1's three verifications. The seed reads the golden itself. Its stage
   contracts name the real module exports, and every stage is required. A
   schema comment marks a complete seed; a partial schema is refused unless
   `--replace` is given.
4. **D-1 hand-offs.** `FASTPATH_TEST_CLOUD_TARGET` is the one set of
   fast-path cloud names the origin, analytics-refresh and the deploy script
   share.
   - fastpath-test accepts the explicit `tibotattle_fastpath_ledger_20261001`
     ledger when both roles are in `tibotattle_fastpath`.
   - Under `K_SERVICE` the mode still listens on `HOST` 127.0.0.1, and only
     as the fast-path origin with its instance, database and runtime user.
   - analytics-refresh's fast-path Job may reach `tibotattle_fastpath`, for
     the pinned schema or a seeded fast-path schema only.
   - The deploy script passes `ANALYTICS_V2_TEST_NOW_MS`, the name the
     composition root reads, in place of `ANALYTICS_V2_TEST_NOW`.
   - The build-context check fails when an included module imports one the
     context does not carry.
5. **Cache history horizon.** A-1 gains `readOwnerFirstEvidenceDay`.
   analytics-refresh starts cache bands at the earliest of that day, the
   queue, the stored floor and today-169. A-2's default is the first evidence
   day, in place of today-162. Production builds every delivered day
   (`CACHE_RETENTION_FROM_DAY` is unset) and binds no day for `all`. The
   route's `all` read was already unbounded.

   Audited and kept, as production method or contract constants: the 70
   model dates and the 101-day model and scalar windows (analysis days
   today-169..today), the 366-day read range, and the fail-closed 4,096-day
   capacity limits.

## Rehearsal

`PG_TEST_SOCKET=… PG_TEST_PORT=55433 node apps/worker/scripts/gcp-fastpath-rehearsal.mjs --golden apps/worker/analytics-v2-test/golden`,
run with `cloud-run/dist` rebuilt at `298afb15`. The run lasted from
2026-10-01T09:55:37Z to 09:56:27Z. The rehearsal ran under Node v26.2.0;
analytics-refresh and the origin ran under Node v22.16.0. Exit 1
(`gate_failed`).

- Migrations: 59 primary (tail `0059_analytics_v2.sql`) and 7 ledger.
- Sealed SQLite: integrity `ok`, 85 populated tables, sha256 `3aa696e734efc31c…`.
- Importers: T-1 identity copy 20 tables, 51 rows; typed-legacy
  `staged_rehearsal_complete`; legacy-transport copy (v1.1 chunks 1530,
  manifests 510, domain days 510, record proofs 11181, v1 chunks 2, upload
  authorizations 1532); T-2 `staged_rehearsal_complete` (510 day-streams,
  3649 occurrence ids, 0 divergent); v1.2 event sources 1; usage-correction
  runtime 1, history 0, facts 0; ingestion journal
  `synthetic_storage_ingestion_journal_transfer_complete`, 6 events.
- Verifications: owner roster 4/4, public source owners equal, owner
  revisions equal.
- First refresh: `complete`, 4 owners, 680 owner-days, 168 days published,
  blocked 2026-04-17 and 2026-04-18. 15 refusals:
  - `cache:incomplete_cache_day` 2;
  - `cache:incomplete_cache_lookback` 7;
  - `daily:source_conflict_or_order` 2;
  - `model:incomplete_window` 4.
- Read: 200, `public, max-age=300`, 396337 bytes.
- Second refresh: 0 published, 0 new revisions, highest revision 1.
- Cleanup: 3 schemas dropped.

| Family | Compared | Equal | Leaf differences |
|---|---:|---:|---:|
| envelope | 1 | 1 | 0 |
| daily-days | 1 | 1 | 0 |
| daily-totals | 168 | 168 | 0 |
| daily-cells | 168 | 168 | 0 |
| spend | 168 | 168 | 0 |
| daily-other | 168 | 168 | 0 |
| allowance-breakdowns | 71 | 71 | 0 |
| model-days | 127 | 119 | 91 |
| preview | 1 | 1 | 0 |
| cache-structure | 1 | 1 | 0 |
| cache-counts (informational) | 1 | 0 | 395 |

There is no new difference. The served response (sha256 `04f7a277a9d8616f…`)
and the stored preview (`b3722cc98b7a82ef…`) are byte-identical to the
frozen tree's runs. Cache windows hold 3, 11, 62 and 376 adjacencies. The
corpus begins at today-169 (2026-04-15), which is also its earliest queued
day, so the new horizon starts the cache bands where the frozen tree did. The
model-days difference is the documented block-withhold rule: 14 dates,
2026-07-24..2026-08-06, an open owner decision. Cache counts are
informational.

## Gates at `298afb15`

Commands run from `apps/worker` unless they start with the repository root.
The PostgreSQL gates used the PG17 cluster on port 55433.

| Gate | Result |
|---|---|
| `npm run analytics-v2:check` | 11 files, 108/108 under Node 26.2.0 and under Node 22.16.0 |
| Origin-fastpath, community-daily route, refresh, occurrence-source and owner-retirement specs, Node 22.16.0 | 57/57 |
| `npm run postgres:domain:check` | rc 0: Vitest 12 files, 75/75; node:test 290 tests, 288 pass, 0 fail, 2 skipped (ledger-authority by design; T-2's opt-in Q-1-dump case, run separately below) |
| T-2 Q-1-dump case (`POSTGRES_V12_TRANSFER_Q1_DUMP=<golden dump>`) | 6/6, 0 skipped |
| `npm run gcp:fastpath:scripts-check` | 19/19 (parity compare 4, seed 7 including the local PG17 seed run, deploy 8) |
| `npm run check` in `cloud-run` | rc 0: 213 tests, 212 pass, 1 skipped (the opt-in A2 real-PG activation case); `test-migrations` 14/14, `origin-route-modules` 19/19, `host.check` 22/22 |
| Image build in the audited context | the context built by `cloud-run-build-context.mjs` builds all 16 entries in isolation; each passes `node --check` under Node 22.16.0 |
| `node scripts/gcp-fastpath-test-deploy.mjs all --commit=HEAD --dry-run` | runs nothing remote; seed plan `run` with all 7 stages present; refresh and origin take the seeded schema and the golden clock (`--now=2026-10-01T12:00:00.000Z`; origin `ANALYTICS_V2_TEST_NOW_MS=1790856000000`, ledger `tibotattle_fastpath_ledger_20261001`) |
| `npx tsc --noEmit` | rc 0 (893 files) |
| `npm run vendor:kernels:check` | 10/10 |
| `node --test scripts/migration-numbering.check.mjs`; `scripts/ci-postgres-suite.check.mjs`; `node scripts/ci-postgres-suite.mjs --plan`; `scripts/postgres-retired-analytics-readers.check.mjs` | 7/7; 31/31; no failures; 3/3 |
| Root `npm run architecture:check` | passed (902 production files, 3,833 imports, 0 debt edges) |
| Root `node --test test/architecture-boundaries.test.js` | 72/72 |
| Default Worker Vitest (`npx vitest run`) | rc 1 only for the pre-existing failure: 174 files, 2,237 tests, 2,236 pass, 1 fail (`test/storage-graph-history-integration.spec.ts` "folds mixed v1 and v1.1 evidence once…", which also fails on the frozen tree and its base); no new failure |
| Root `npm run test:preflight` | rc 0 (root workspace hygiene, documentation governance over 299 Markdown files, 20/20 preflight tests) |

Not run: root `npm test`, root `npm run check`, the Worker's full `check`
(it includes Wrangler dry-runs and `deploy:dry`), a Docker build, and
anything on GCP or Cloudflare.

## Intake merge and primary 0062

Code commit `0fea08b0` on `claude/gcp-fastpath-final`. Evidence is local and
synthetic only, under the same limits as above. Nothing was pushed, deployed
or seeded, and no GCP, Cloudflare or production resource was read or
written.

### What changed

1. **Intake merged** (`2dcdd90f`): `claude/gcp-fastpath-intake` `aa260555`.
   It brings the IN-2 v1.1 and IN-3 v1.0/v0.1 intake composed into the
   origin, primary 0060 (v1.1 live admission) and 0061 (legacy contribution
   admission), and its seven review fixes. There was no textual conflict.
   The fastpath migrate profile already takes its counts from the deploying
   commit, so the only count changes were to the A2 and benchmark pins.
   The build context's import-closure check now also scans the nested
   `cloud-run/envelopes` and `cloud-run/routes` modules the intake adds.
   A probe import from a nested route module to a module outside the
   context now fails; the old pattern let it through.
2. **Primary 0062** (`f1f13bde`,
   `0062_telemetry_contribution_trigger_search_path.sql`). It runs
   `ALTER FUNCTION telemetry_contributions_require_active_participant() SET search_path FROM CURRENT`.
   That pins the path to the function's own schema, then `pg_catalog`, the
   pin every other runtime function in the chain carries. A catalog scan of
   the composed chain found this 0011 trigger function to be the only
   function in the runtime schemas without a pinned search_path. 0011's
   other one, the lifetime participant limit, was dropped by 0061.
   - Without the pin, an insert into `telemetry_contributions` from a pool
     that sets no search_path failed 42P01 inside the trigger. The origin's
     pools set none.
   - The new `postgres-function-search-path.spec.mjs` (2 cases) proves the
     fix. It shows the 42P01 on the chain up to 0061, then admission (and
     P1001 for a deleting participant) once the runner applies 0062. It also
     asserts that every primary and ledger function pins its path. Both
     cases fail when 0062 is a no-op.
   - The v0.1 persist's `SET LOCAL search_path` was **removed** as redundant.
     Its statements are schema-qualified, and the origin serves the route
     only on a schema whose receipts equal the runtime manifest, which
     includes 0062. The shipped-client v0.1 case in
     `postgres-origin-intake.spec.mjs` therefore also proves 0062 through
     the real path: it fails when 0062 is a no-op.
   - The v1.1 live spec's session `SET search_path` workaround was removed
     as well.
   - Every primary count and tail pin is now 62 with tail 0062. The ledger
     stays at 7.
3. **Single-producer ratchet** (`0fea08b0`). `buildJournalSqlite` in
   `scripts/gcp-fastpath-rehearsal.mjs` writes the oracle dump's journal rows
   into a sealed, journal-only node:sqlite file in a mkdtemp work directory.
   That file is the source the already-exempt sealed D1 import
   (`postgres-ingestion-journal-transfer.mjs`) reads; the rehearsal never
   writes the PostgreSQL journal. The file now has one entry in
   `REVIEWED_DYNAMIC_WRITERS` with its one computed write site pinned.
   Appending a literal PostgreSQL journal INSERT, or a second computed one,
   still fails the ratchet.

### Behaviour notes (from the intake)

- **Contributions preamble and `device_sync`.** The composed contributions
  preamble no longer charges the `device_sync` attempt limiter (RECOVERY, one
  global 20-per-minute key that sync reads also use) for any envelope,
  v1.2 included. This matches `d43c8f92` `handleContribution`, which meters
  the route only with the upload-ingress limiters and the per-device chunk
  windows. Before this change, a shipped v1.0 backfill hit 429
  `ATTEMPT_LIMIT_REACHED` after 19 chunks.
- **`cloud-run-iam` stays v1.2-only.** The intake is composed only in the
  `health-and-v12-day-manifest` and `fastpath-test` host modes
  (`ORIGIN_INTAKE_HOST_MODES`). In `cloud-run-iam` the only ingress is the
  OAuth gateway, whose closed route table has no v1.1, sync-capabilities or
  envelope-key route, so that service keeps its v1.2-only routes.

### Rehearsal at `0fea08b0`

The same command, run with `cloud-run/dist` rebuilt at `0fea08b0` by the
`cloud-run` check. The run lasted from 2026-10-01T12:45:00Z to 12:45:54Z.
The rehearsal ran under Node v26.2.0; analytics-refresh and the origin ran
under Node v22.16.0. Exit 1 (`gate_failed`), as before.

- Migrations: 62 primary (tail `0062_telemetry_contribution_trigger_search_path.sql`)
  and 7 ledger.
- Sealed SQLite `3aa696e734efc31c…`, 85 populated tables.
- Importers, verifications and imported row counts: equal to the
  `298afb15` run above.
- First refresh: `complete`, 4 owners, 680 owner-days, 168 days published,
  2026-04-17 and 2026-04-18 blocked, the same 15 refusals by reason.
- Read: 200, `public, max-age=300`, 396337 bytes, host mode `fastpath-test`.
- Second refresh: 0 new revisions, highest revision 1.
- Cleanup: 3 schemas dropped. No rehearsal or test schema was left in the
  local cluster.
- Parity families: identical to the table above. Model-days compares 127,
  119 equal, 91 differences (the documented 14 dates). Cache-counts is
  informational, with 395 differences. Every other family is fully equal.
- Bytes: the raw served body (396337 bytes) has sha256
  `a27aee711cabc056eea2ecb5c89b7f4de3ec4a9f85b72455057c1f760ffa680d`.
  The response file is that body plus a newline (`04f7a277a9d8616f…`), and
  the stored preview is `b3722cc98b7a82ef…`. All three equal the `298afb15`
  run. The merge and 0062 change no served byte.

### Gates at `0fea08b0`

Run serially in this order. Commands ran from `apps/worker` unless they
start with the repository root. The PostgreSQL gates used the PG17 cluster
on port 55433 (`PG_TEST_SOCKET`, `PG_TEST_HOST` unset). Node 26.2.0 was used
unless a row names Node 22.16.0.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | rc 0 (895 files) |
| `npm run postgres:domain:check` | rc 0. Vitest 12 files, 75/75. node:test 326 tests: 324 pass, 0 fail, 2 skipped, the same two as before (ledger-authority by design; T-2's opt-in Q-1-dump case). The added tests are the intake's v1.1-live, legacy-admission and origin-intake specs and the new search-path spec |
| `npm run scripts:check` | rc 0, 967/967. Before the ratchet entry, it failed only on the single-producer ratchet |
| `npm run check` in `cloud-run` | rc 0. 225 tests: 224 pass, 1 skipped (the opt-in A2 real-PG activation case). Build context reports 62 primary and 7 ledger migrations |
| `npm run analytics-v2:check` | 11 files, 108/108 under Node 26.2.0 and under Node 22.16.0 |
| `npm run gcp:fastpath:scripts-check` | rc 0, 19/19, including the local PG17 seed run |
| Rehearsal (above) | Exit 1 `gate_failed` on model-days only. Every other gate is true. Parity and bytes are unchanged |
| `postgres-origin-intake.spec.mjs`, Node 22.16.0 | 6/6 |
| `postgres-function-search-path.spec.mjs`, Node 22.16.0 and inside the domain check | 2/2 each |
| Root `npm run architecture:check` | passed (917 production files, 3,900 imports, 0 debt edges) |
| Root `npm run test:preflight` | rc 0: root workspace hygiene clean, documentation governance valid across 299 Markdown files and 1,565 source/config files, 20/20 preflight tests (run on the receipt as committed) |
| `node scripts/gcp-fastpath-test-deploy.mjs all --commit=HEAD --dry-run` | rc 0, and no command executed. The migrate Job would be given `PRIMARY_EXPECTED_MIGRATIONS=62` and `LEDGER_EXPECTED_MIGRATIONS=7`. The seed plan is `run`, with all 7 stages. Refresh and origin take the seeded schema and `--now=2026-10-01T12:00:00.000Z`. The origin also takes `ANALYTICS_V2_TEST_NOW_MS=1790856000000` and ledger `tibotattle_fastpath_ledger_20261001` |

One environment note: `postgres-legacy-contribution-admission.spec.mjs`
passes 22/22 under Node 26.2.0, as the domain check runs it. Under Node
22.16.0, 11 of its cases fail with `ERR_SQLITE_ERROR` ("column index out of
range") in its `node:sqlite` D1 oracle. The same 11 fail at the intake head
`aa260555`, so this is a Node 22 `node:sqlite` limit in the test oracle, not
a product change.

Not run: root `npm test`, root `npm run check`, the Worker's full `check`
and default Vitest suite, a Docker build, and anything on GCP or
Cloudflare.

## Cloud SQL seed preparation

Code commit `6850ba06` on `claude/gcp-fastpath-final`, on top of the merge
`6080e617`. Evidence is local and synthetic only, under the same limits as
above. Nothing was pushed, deployed or seeded, and no GCP, Cloudflare or
production resource was read or written.

### What changed

1. **Non-superuser T-1 merged** (`6080e617`): `claude/gcp-fp-seed-cloudsql`
   `2a7d6d1f`, with no conflict. The T-1 identity copy suppresses the copied
   tables' user triggers with owner DDL (`ALTER TABLE ... DISABLE/ENABLE
   TRIGGER USER`) inside its one transaction, in place of the superuser-only
   `session_replication_role`. Its commit message records the cloud seed
   failing at T-1 with `FASTPATH_IDENTITY_TRIGGER_SUPPRESSION_REFUSED`
   (42501). It adds a check that seeds the golden as a stand-in Cloud SQL
   migrator (not a superuser) and requires the superuser's result.
2. **The journal importer's one cloud exception** (`6850ba06`). The seed
   reaches Cloud SQL through the Cloud SQL Node connector, a TCP session, so
   `inet_server_addr()` is not NULL. The ingestion-journal importer accepts
   only a local PostgreSQL 17 on its Unix socket. It would have refused the
   seed with `INGESTION_JOURNAL_LOCAL_POSTGRES_17_REQUIRED`, after T-1,
   typed-legacy, T-2 and usage-correction had already written.
   - This is the only server-locality guard in the seed's chain. Typed-legacy,
     T-2, usage-correction and T-1 check only for PostgreSQL 17. T-1's
     `PGHOST` check is in its CLI only, which the seed does not use.
   - `transferPostgresIngestionJournal` takes `cloudFastpathTarget`. Only
     `gcp-fastpath-seed.mjs` passes `true`, through
     `loadFastpathRehearsalImporters`; the local rehearsal never does.
   - With the option, a session that fails the local check is admitted only
     when `scripts/gcp-fastpath-cloud-target.mjs` finds all four conditions:
     the database is `tibotattle_fastpath`, the schema is a
     `typed_legacy_transfer_rehearsal_target_fastpath_<8 hex>` target, the
     server is PostgreSQL 17, and neither the session user nor the current
     user is a superuser.
   - Anything else keeps the original refusal and code. The prefix and
     disposable-schema guards run first and are unchanged. The journal's own
     `storage_journal_transfer_target_` prefix is never a cloud target.
   - The seed's checkout plan also requires the helper to equal the deployed
     commit.
3. **Checks.** The journal-transfer PG17 spec and the seed check gain cases
   that need loopback TCP to the same cluster (`PG_TEST_TCP_HOST`). Without
   it they skip; the shared socket-only cluster rejects TCP. The stand-in is
   a local `tibotattle_fastpath` database owned by a NOLOGIN
   CREATEDB/CREATEROLE group, with a non-superuser migrator reached over TCP.
   Checks that share a cluster serialize on an advisory lock while the
   database exists.
   - Journal spec: (a) without the option, refused with the original code;
     (b) the option in another database, refused; (d) a superuser with the
     option, refused before and after the import; the journal's own prefix,
     refused. None of these writes anything. (c) The option with the right
     database, prefix and migrator imports the whole journal (6 rows, 3
     pages) and replays as `already_complete`.
   - Seed check: `runGcpFastpathSeed`, the deploy's entry point, runs with
     only the pool swapped, as that TCP migrator in `tibotattle_fastpath`. It
     equals the superuser's local-socket seed in importer receipts, imported
     row counts (the rehearsal's, below), per-table content digests and
     trigger states.
   - Unit checks cover a fake TCP session (with every single failing
     condition refused before any lock or write), the helper's refusal
     reasons, a plan refusal when the helper differs, and a ratchet that only
     the seed passes `cloudFastpathTarget: true`.
   - With the importer change reverted, both PG checks fail with
     `INGESTION_JOURNAL_LOCAL_POSTGRES_17_REQUIRED`. The TCP seed fails only
     at the journal, after T-1, typed-legacy, T-2 and usage-correction
     complete over TCP as the non-superuser.

### Gates at `6850ba06`

Run serially in this order with Node 26.2.0, from `apps/worker` unless they
start with the repository root. The PostgreSQL gates used the PG17 cluster
on port 55433 (`PG_TEST_SOCKET`, plus `PG_TEST_TCP_HOST=127.0.0.1` where
listed; `PG_TEST_HOST` unset).

| Gate | Result |
|---|---|
| Rehearsal (root, socket only) | Exit 1 `gate_failed`, on model-days only (127 compared, 119 equal, 91 differences); every other gate is true. Migrations 62/7. The importer receipts, imported row counts and parity report equal the post-merge, pre-change run. Served body 396337 bytes, sha256 `a27aee711cabc056eea2ecb5c89b7f4de3ec4a9f85b72455057c1f760ffa680d`; response file `04f7a277a9d8616f…` and preview `b3722cc98b7a82ef…`, as at `0fea08b0` |
| `npm run gcp:fastpath:scripts-check` with TCP | rc 0, 23/23. This includes the three PG17 seed runs: the superuser over the socket, the stand-in migrator over the socket, and the stand-in migrator over TCP in `tibotattle_fastpath` |
| T-1 identity-copy spec | 11/11 |
| T-2 v1.2 transfer spec | 5/6, 1 skipped (the opt-in Q-1-dump case) |
| Journal-transfer spec with TCP | 2/2 |
| `npm run postgres:domain:check` with TCP | rc 0. Vitest 12 files, 76/76. node:test 327: 325 pass, 0 fail, 2 skipped (the same two as before) |
| `npm run scripts:check` | rc 0, 967/967 |
| `npx tsc --noEmit` | rc 0 (895 files) |
| Root `npm run architecture:check` | passed (917 production files, 3,900 imports, 0 debt edges) |
| `node scripts/gcp-fastpath-test-deploy.mjs all --commit=HEAD --dry-run` (root) | rc 0, and nothing ran: every command is printed as dry-run. The migrate Job would get 62/7. The seed plan is `run`, with all 7 stages present. Refresh and origin take the seeded schema and `--now=2026-10-01T12:00:00.000Z`, and the origin takes `ANALYTICS_V2_TEST_NOW_MS=1790856000000` |

The seeded schema's suffix comes from the deployed commit and the golden
dump, so each commit seeds a fresh schema. A partial schema from an earlier
commit's attempt is left in place, and nothing reuses it.

## Remaining gates and owner decisions

- Model-day semantics: port production's block-and-withhold rule or accept
  per-date publication.
- No D-1 seed has completed on the test project. Seeding needs Node 26 on
  the operator workstation, a checkout equal to the deployed commit, and
  installed `apps/worker` and `apps/worker/cloud-run` dependencies (Vite
  for T-2's effective reader; the Cloud SQL connector, google-auth-library
  and pg). The Cloud SQL exceptions in this receipt are proven against a
  local stand-in only. Cloud SQL's own role and catalog behaviour, and the
  seed's runtime grant and read-back as the runtime IAM user, are not
  exercised locally.
- The image's build context, the A2 and benchmark migrate profiles and the
  activation, benchmark, readback and cleanup jobs now pin 62/7 (tail 0062).
  Keep the promoted chain (0053, ledger 0007) off every non-disposable
  database until the SIMP-0 amendments land. 0060 to 0062 have run only on
  local PostgreSQL 17.
- The IN-2/IN-3 intake is proven only locally, with shipped clients against
  the composed origin on local PostgreSQL 17. No edge, test-project or
  production traffic has reached it. Dense owners, the native dense
  fallback, the memo, the edge and production remain outside this
  evidence.
