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
stays the record for that commit). It records **local, synthetic** evidence
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

## Remaining gates and owner decisions

- Model-day semantics: port production's block-and-withhold rule or accept
  per-date publication.
- The D-1 deploy and seed have not run against the test project. Seeding
  needs Node 26 on the operator workstation and a checkout equal to the
  deployed commit.
- The image's build context still pins 59/7 migrations, as do the A2 and
  benchmark migrate profiles. Keep the promoted chain (0053, ledger 0007) off
  every non-disposable database until the SIMP-0 amendments land.
- IN-2 and IN-3 intake, dense owners, the native dense fallback, the memo,
  the edge and production remain outside this evidence.
