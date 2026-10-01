---
title: GCP fast-path local rehearsal
date: 2026-10-01
type: receipt
status: snapshot
---

# GCP fast-path local rehearsal

This is a 2026-10-01 receipt for branch `claude/gcp-fastpath` at commit
`8d2cb423`, built on `claude/gcp-fastpath-base` `8b1dcc4f`. It records
**local, synthetic** evidence only: one macOS arm64 workstation, a local
PostgreSQL 17 cluster on a private Unix socket, and the Q-1 oracle's
synthetic, content-free four-owner corpus. Nothing was pushed or deployed,
no GCP or Cloudflare resource was read or written, and no production data
was read. It does not qualify a Cloud Run image, a GCP test project, the
edge, production routing, production data volumes or production parity.

## What landed

Packages merged with `--no-ff`, in order, with no textual conflict: A-0,
A-1, A-2, A-3, IN-1a, IN-1b, A-4, T-1, T-2. Not merged, by instruction:
DOC-1L, IN-2, IN-3 (and D-1, which was not authorized). The Q-1 golden,
dumps and corpus were copied byte for byte from `claude/gcp-fp-q1-oracle`
`9e26237e` into `apps/worker/analytics-v2-test/golden/`; `SOURCE.json`
records every file's git blob id.

Integration-lead changes on top of the merges:

- **0059 promotion.** `0059_analytics_v2.sql` moved unchanged into
  `postgres/migrations/primary`; `src/postgres-runtime-schema.ts`
  regenerated with its generator; every primary count and tail pin moved from
  58 to 59 in the files the earlier promotions touched; ledger stays at 7.
- **FC-11(a).** The four analytics_v2 per-owner tables joined
  `OWNER_DIGEST_TABLES` with a DELETE decision: owner retirement deletes them
  by owner digest and never touches the append-only published heads or the
  preview. New retirement spec case; removing the delete step fails it.
- **Contract.** Cache-only refusal reasons (`group_limit_exceeded`,
  `session_limit_exceeded`) can no longer reach `analytics_v2_owner_day`,
  matching 0059's CHECK (contract v0.3). The overridable built-in is
  `/api/v1/device/upload-authorizations`, the runtime path; a check pins the
  two lists equal. Upload-authorization types narrowed to the runtime shapes.
- **Image.** `build.mjs` builds `dist/analytics-refresh.mjs` and refuses a
  bundle in which a vendored kernel resolves a workspace package outside the
  vendor tree. The Dockerfile copies `apps/worker/vendor` and checks the new
  entry; the audited build context carries both.
- **Origin.** The composition root injects the A-4 route factory (mounted
  only in fastpath-test with `ANALYTICS_V2_ENABLED=1`) and the
  `ANALYTICS_V2_TEST_NOW_MS` clock, refused outside fastpath-test.
- **Specs registered** in `postgres:domain:check`: origin-fastpath,
  analytics-v2 occurrence source, refresh, community-daily route, identity
  copy and v1.2 transfer. New scripts: `analytics-v2:check`,
  `vendor:kernels:check`, `gcp:fastpath:scripts-check` (all in `check`) and
  `gcp:fastpath:rehearsal`.
- **Importer chain.** The ingestion-journal and usage-correction importers
  also accept the one fast-path rehearsal prefix
  (`typed_legacy_transfer_rehearsal_target_fastpath_`). T-1's copier gained a
  rehearsal-only transport copy (`legacy-transport`, `v12-event-sources`):
  no importer in the plan's chain wrote the v1/v1.1 transport and admission
  tables or the journal's event sources that A-1 reads (T-1's hand-off).

## Rehearsal

Command, from the repository root, on the frozen commit with `cloud-run/dist`
built by `node cloud-run/build.mjs`:

```sh
PG_TEST_SOCKET=/private/tmp/tibotattle-pg-<cluster>/socket PG_TEST_PORT=55433 \
  node apps/worker/scripts/gcp-fastpath-rehearsal.mjs \
  --golden apps/worker/analytics-v2-test/golden
```

Run: 2026-10-01T08:56:52.711Z to 2026-10-01T08:57:38.918Z. The importers ran in the rehearsal process under Node v26.2.0; analytics-refresh and the origin ran as child processes under Node v22.16.0, the image runtime. The importers are local tooling that never enters the image, and the typed-legacy sealed-SQLite reader fails under Node 22.16.0 (`TYPED_LEGACY_SEALED_SQLITE_READ_FAILED`, in its own check too); Node 22.16.0 bundles SQLite 3.49.1 against 3.53.1 in 26.2.0, the likely but undiagnosed cause. Exit status: `gate_failed` (exit code 1).

1. **Schema.** `typed_legacy_transfer_rehearsal_target_fastpath_a374e0f4` plus its `_ledger` pair and an importer control schema; 59/59 primary migrations (tail `0059_analytics_v2.sql`) and 7 ledger migrations through the production runner.
2. **Sealed source.** The Q-1 `USAGE_MONITOR_DB` dump rebuilt into SQLite: integrity `ok`, 85 populated tables, sealed (sha256 `3aa696e734efc31c…`). The journal importer's journal-only SQLite is projected from the same dump with the dump's own DDL.
3. **Importers**, in order, each complete:
   - T-1 identity copy: 20 tables, 51 rows, 31 foreign keys re-checked;
   - typed-legacy transfer: `staged_rehearsal_complete`;
   - legacy-transport copy: 17316 rows in 14 tables (v1.1 chunks 1530, manifests 510, domain days 510, record proofs 11181, v1 chunks 2, upload authorizations 1532);
   - T-2 v1.2: `staged_rehearsal_complete`, effective reader verified: 1 owner, 510 day-streams, 3649 occurrence ids, unionDivergentDayStreams 0;
   - v1.2 event sources: 1 row;
   - usage-correction: runtime 1 row, history 0, facts 0 (the corpus has no correction facts);
   - ingestion journal: `synthetic_storage_ingestion_journal_transfer_complete`, 6 events.
   Verification: owner roster 4/4 (equal), `community_public_source_owners` equal to D1, derived owner revisions equal to D1.
4. **analytics-refresh** (`dist/analytics-refresh.mjs --mode=full --now=2026-10-01T12:00:00.000Z`): `complete`, 4 owners, 680 owner-days, 168 days published, blocked ['2026-04-17', '2026-04-18'], 15 refusals, journal cursor 6, wall 16418 ms.
5-6. **Origin and read.** `dist/server.mjs` composed in `fastpath-test` mode with local pools and served on 127.0.0.1 by a Node v22.16.0 child (closed cleanly, exit 0); `GET /api/v1/community/daily?from=2026-04-15&to=2026-10-01` returned 200, `cache-control: public, max-age=300`, 396337 bytes.
7. **Parity** (normalizing only days[].revision, days[].releasedAt, payload.revision, payload.releasedAt, payload.aggregateId :r<revision> suffix): published days golden 168, actual 168, missing [], extra [].

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

8. **Second run** at the same clock: `complete`, 0 published, 0 unchanged, blocked ['2026-04-17', '2026-04-18']; published heads 168 before and 168 after, **0 new revisions** (highest revision 1), wall 15042 ms.
9. **Cleanup.** 3 schemas dropped.

Refusals by family and reason (first run; the second is identical):

| Family:reason | Count | Owners (digest prefix) | Days |
|---|---:|---|---|
| `cache:incomplete_cache_day` | 2 | f214e768 | 2026-04-17, 2026-04-18 |
| `cache:incomplete_cache_lookback` | 7 | f214e768 | 2026-04-19..2026-04-25 (7) |
| `daily:source_conflict_or_order` | 2 | f214e768 | 2026-04-17, 2026-04-18 |
| `model:incomplete_window` | 4 | f214e768 | 2026-07-24..2026-07-27 (4) |

Timings (ms): migrate 396, sqlite 530, importer:t1-identity 106, importer:typed-legacy 1026, importer:legacy-transport 214, importer:t2-v12 11725, importer:v12-event-sources 29, importer:usage-correction 32, sqlite:journal 19, importer:ingestion-journal 13, importer:verify 113, refresh:first 16418, origin:start 179, origin:get 43, parity 3, refresh:second 15042, cleanup 104.
analytics-refresh phases, first run (ms): read 7704, cache 30, model 4556, write 106, scalar 305, prepare 3506, community 28.

## What the parity result means

Every daily payload the oracle published (168 days: totals, cells,
API-equivalent spend and every other payload field), the allowance
breakdowns (combined and per plan type, 69 days), the stored admin preview
(apart from its model days) and the cache-retention structure are
byte-equal to the d43c8f92 production-code oracle after the minimal
normalization; the 168 served day objects are equal even without it
(revision 1 and `releasedAt` at the pinned clock in both). Both outputs
leave the owner (a) crossed-day conflict days
2026-04-17 and 2026-04-18 unpublished, and owner (d)'s v1/v1.1 duplicate
occurrence counts once. This is also the end-to-end form of A-1's blocked
cross-check: A-1's readers over the imported oracle source produce the
oracle's per-day community totals for all four owners. It does not compare
per-owner occurrence-id sets.

The rehearsal exits 1 because one family differs unexpectedly; a second
differs by design of the oracle's own parity basis:

- **model-days (unexpected, 91 leaf differences).** The fast path publishes
  70 model dates; the oracle published 56. The 14 extra dates are exactly the
  oracle's withheld block 2026-07-24..2026-08-06 (golden
  `manifest.modelPublications.missing`), and the 7 allowance-breakdown days
  2026-07-29..2026-08-04 carry the corresponding model values where the
  oracle has none. Every one of the 56 shared model dates is byte-equal.
  Cause, from the oracle manifest and the run's refusals: owner (a)'s
  conflict makes four of its model windows incomplete (A-2 refuses
  2026-07-24..07-27 as `model:incomplete_window`). Production evaluates model
  dates in blocks and publishes a date only when every member holds a
  result, so owner (a)'s whole 14-date block stays pending and all 14 dates
  are withheld community-wide. A-2 evaluates per date, counts the refused
  owner on the published point (`refusedParticipantCount`), and publishes.
  Closing this needs an owner decision: port production's block-and-withhold
  semantics, or accept and disclose per-date publication.
- **cache-counts (informational, 395 leaf differences).** Q-1's manifest
  declares cache-retention counts not a parity basis, because production's
  counts depend on lane interleaving; in this oracle the effective cache lane
  stopped after 2026-04-16 behind the conflict, so its day, week and month
  windows are empty (all-window adjacencies 67). The fast path recomputes
  every owner-day (day 3, week 11, month 62, all 376 adjacencies). Its
  "all" window starts at today−162 (A-2's default `cacheFromDay`), whereas
  production's has no lower bound: an open owner decision under the
  no-small-data-caps rule.

## Scope exclusions

- **Dense owners.** None in the corpus. The 120,000-window-row and
  20,000-row-per-day refusals are exercised only by A-2's unit spec; the
  production native fallback is not ported, and dense owners are excluded
  from the parity claim.
- **Non-effective owners.** All four corpus owners route `effective` with the
  correction runtime active, as in the oracle. v1-only, mixed and v0.2 owners
  become `non_effective_source_unported` refusals and are not exercised
  here; the staged-runtime oracle variant was not rehearsed.
- **Eligibility.** Production's `community_public_source_owners`, verified
  equal to the D1 view (4/4 owners).
- **Importers.** The legacy-transport and v1.2 event-source copies are
  rehearsal-only, not production importers. The journal importer reads a
  journal-only SQLite projected from the same dump. The usage-correction
  importer copied zero history and fact rows because the corpus has none.
  T-2 reads the current v1.2 head only, whereas d43c8f92 reads every
  activated generation; this corpus has one generation (0 divergent days).
- **Second-run check.** It runs under queue semantics: no new journal events,
  the two blocked days are recomputed and stay blocked, and the published
  heads keep their revisions and digests. Across independent rehearsal runs
  (fresh schemas; origin in-process under Node 26.2.0 and as a Node 22.16.0
  child) the served response and the stored preview were byte-identical
  (response sha256 `04f7a277a9d8616f…`, preview `b3722cc98b7a82ef…`).

## Gates on the frozen commit

All local, on this workstation, against the PostgreSQL 17 cluster on port
55433 where a gate needs a database. Commands run from `apps/worker` unless
they start with the repository root. The gates ran between `c6664711` and
`8d2cb423`; the commits after `c6664711` change only the rehearsal script,
the golden's `SOURCE.json` (dropping the copied corpus generator) and the
cloud-run `package.json` script list, and the cloud-run check and the
rehearsal ran on that final script list and script.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | rc 0 (893 files) |
| `npm run postgres:domain:check` | rc 0: Vitest 12 files, 75/75; node:test 286 tests, 284 pass, 0 fail, 2 skipped (ledger-authority, HOST profile by design; T-2's opt-in Q-1-dump case, run separately below) |
| T-2 Q-1-dump case (`POSTGRES_V12_TRANSFER_Q1_DUMP=<golden dump>`) | 6/6, 0 skipped |
| Origin-fastpath, community-daily route, refresh, occurrence-source and owner-retirement specs under Node 22.16.0 | 53/53 |
| `npm run analytics-v2:check` | 11 files, 107/107 under Node 26.2.0 and under Node 22.16.0 |
| `npm run vendor:kernels:check` | 10/10 |
| `node --test scripts/migration-numbering.check.mjs` (OPS-6) | 7/7: primary 0001-0059 contiguous, ledger 0001-0007 |
| `node --test scripts/ci-postgres-suite.check.mjs`; `node scripts/ci-postgres-suite.mjs --plan` | 31/31; plan reports no failures |
| `node --test scripts/postgres-retired-analytics-readers.check.mjs` | 3/3 |
| `npm run postgres:migrations:check` (includes the generator check and `--check`) | rc 0 |
| `npm run gcp:fastpath:scripts-check` | rc 0 (parity compare 4/4) |
| `npm run check` in `cloud-run` (build, `build.mjs --check`, build context, host.check against PG17) | rc 0: 206 tests pass, 1 skipped (the opt-in A2 real-PG activation case, skipped at `cfd7dc39` too); `host.check` 22/22, origin-route-modules 18/18 |
| `node cloud-run/build.mjs` | emits 16 entries including `dist/analytics-refresh.mjs`; every entry passes `node --check` under Node 22.16.0 |
| Default Worker Vitest (`npx vitest run`) | rc 1 only for the pre-existing failure: 174 files, 2,237 tests, 2,236 pass, 1 fail (`test/storage-graph-history-integration.spec.ts` "folds mixed v1 and v1.1 evidence once…", which also fails at `cfd7dc39` (2,056 tests) and at the base (2,237 tests)); no new failure |
| Root `npm run architecture:check` | passed (902 production files, 3,832 imports, 0 debt edges) |
| Root `npm run test:preflight` | rc 0 |
| Root `node --test test/architecture-boundaries.test.js` | 72/72 |
| Rehearsal | exit 1: every step complete, second run 0 new revisions, parity differs in model-days (see above) |

Not run: root `npm test`, root `npm run check`, the Worker's full `check`
(it includes Wrangler dry-runs and `deploy:dry`), a Docker build of the
image, and anything on GCP or Cloudflare.

## Remaining gates and owner decisions

- **Model-day semantics** (above): port production's block-and-withhold rule
  or accept per-date publication with refused counts.
- **Cache "all" window lower bound** (above): pass production's
  `CACHE_RETENTION_FROM_DAY` (or the first evidence day) with a matching read,
  or accept a rolling window explicitly.
- **Migrations.** The promoted chain now ends at 0059 and still includes 0053
  and ledger 0007. Keep it off every non-disposable database until the
  SIMP-0 amendments land. `cloud-run/test-migrations.mjs` pins its targets to
  59/7: do not run the test migrate job.
- **A2 deployed-test tools** still write synthetic collection-control reasons
  that 0050 refuses (INT-0's hand-off); the opt-in real-PG activation case
  stays skipped.
- **Intake.** v1.1 (IN-2) and v1.0/v0.1 (IN-3) envelopes and
  upload-authorization formats are not merged. The shared claim still uses
  v1.2 accountless authority, and a v1.2 replay revokes the grant where
  production marks it consumed (IN-1b's notes).
- **Separate evidence gates not attempted:** a Docker build of the image, a
  GCP test-project deploy (D-1), the edge, production data volumes, dense
  owners, the native dense fallback, the memo or incremental mode, and any
  production read or write.
- `design/plan-v5.json` (outside the repository) still names base head
  `8b1dcc4f`.
