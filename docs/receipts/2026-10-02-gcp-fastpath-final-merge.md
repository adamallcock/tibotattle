---
title: GCP fast-path final merge
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP fast-path final merge

This is a 2026-10-02 receipt for merging the dense-owner parity branch and the
wave-2 integration into `claude/gcp-fastpath-final`. The final line started
at `3fa1ba64`. It merged `claude/gcp-fastpath-dense` at `6e78d64f` and
`claude/gcp-fp-w2-integration` at `7c310cac`, then fixed one seam the merges
exposed.

This receipt records **local, synthetic** evidence only. The gates ran on one
macOS arm64 workstation:

- Node 26.2.0 for repository tooling and importers;
- Node 22.16.0, the image runtime, where noted;
- the local PostgreSQL 17.10 fan-out cluster on a private Unix socket. That
  cluster also listens on loopback TCP on port 55433.

Nothing was built in Cloud Build, deployed, migrated, applied or read in any
GCP or Cloudflare project. No `gcloud`, `wrangler` or push ran, and no request
left the machine.

## Commits

| Commit | Content |
|---|---|
| `b9b004ed` | `--no-ff` merge of `claude/gcp-fastpath-dense` `6e78d64f` (25 commits): raised caps, the native-path oracle and golden-dense, the v1.2 occurrence reader fix, parity-compare v3 with per-date values, preview withholding on a refused fit, the day backstop, `--corpus`/`--dump`/`--refresh-profile` for the seed and test deploy, and decision D7 |
| `c47f92d9` | `--no-ff` merge of `claude/gcp-fp-w2-integration` `7c310cac` (20 commits): OPS-10 and the shared runtime-grant policy, OPS-2 infrastructure as code, the SIMP-0 ledger removal from CR-3, EP-7 and OPS-1, the PT-2-lite seal, the PT-3 importer and primary migration 0063, plus the dense-side migration-tail pins moved to 63 |
| `f8406093` | The edge end-to-end S9 stage holds the golden's withheld model dates to the per-date expectation, as the rehearsal does ([S9 seam](#s9-seam)) |
| this commit | This receipt |

The first parents are `3fa1ba64` and `b9b004ed`, and the second parents are
`6e78d64f` and `7c310cac`.

When this pass started, the branch was already at `f8406093` and the worktree
was clean. An earlier run of the same integration task had made both merges
and the S9 fix, but it had not written this receipt. This pass did not redo
that work. It verified the work in three steps:

1. It recomputed each merge from its recorded parents with
   `git merge-tree --write-tree`.
2. It confirmed that each committed tree differs from git's automatic result
   only in the files listed below.
3. It reviewed every hunk in those files.

It then reran every gate on `f8406093`.

## Merge 1: the dense branch (`b9b004ed`)

Git reported four textual conflicts. Each resolution keeps both sides' intent.

- `apps/worker/package.json`: the dense side's `gcp:fastpath:scripts-check` is
  a superset of the final side's. It adds the owner-parity compare, the
  dense-oracle scripts, the rehearsal check and the golden-dense check. The
  merge also takes the dense side's `gcp:fastpath:rehearsal` with
  `--per-date-expected`, and keeps the final side's `edge:e2e` and
  `edge:e2e:check`.
- `apps/worker/scripts/gcp-fastpath-seed.mjs`:
  - `readSeedGolden(golden, { dump })` keeps the dense side's dump rules:
    `GCP_FASTPATH_SEED_DUMP_AMBIGUOUS`, `GCP_FASTPATH_SEED_DUMP_REQUIRED`, and
    the digest pin for an external dump.
  - It still returns the final side's `sourceIdentity`, parsed from the same
    bytes it hashes.
  - The seed passes `--dump` through.
  - The dense side's `sha256File` helper became unused and was dropped.
  - One cost: for `golden-dense` the external dump is 163,950,762 bytes, and
    it is now parsed once in memory. Only the seed and the test deploy's
    origin-only step read it.
- `apps/worker/scripts/gcp-fastpath-test-deploy.mjs`:
  - The options carry both `sourceIdentity` and `corpus`/`dump`/`refreshProfile`.
  - The help states the dense refresh profiles, plus the final side's
    origin-bucket binding and source environment.
  - The dry-run seed returns both `dumpSha256` and `sourceIdentity`.
  - An origin-only run over a seeded schema reads the source identity with the
    same `--dump`.
- `docs/plans/2026-10-01-gcp-fastpath.md`: the Risks section keeps the OD-E6
  client-address bullet and takes the dense side's dense-owner bullet. The
  dense bullet supersedes the final side's earlier bullet about excluding
  dense owners, which was removed.

Git merged several files cleanly that were expected to conflict:

- `gcp-fastpath-test-deploy.check.mjs` and `gcp-fastpath-seed.check.mjs`. Both
  sides edited them, and no test name is duplicated.
- The append-only contributions decision. Only the dense side changed it, by
  adding D7.
- The 2026-10-01 receipts. Only the dense side changed the final-integration
  and local-rehearsal receipts, adding "decided later" notes.
- The plan's OpenAI alignment section. It has no overlapping hunk, and it
  already refers to the dense branch landing first.

## Merge 2: the wave-2 integration (`c47f92d9`)

Git reported two textual conflicts.

- `apps/worker/package.json`: the merge keeps the dense `gcp:fastpath:scripts-check`
  and the per-date rehearsal, and adds wave 2's `gcp:ops:infra:check`. The
  other wave-2 keys merged cleanly, and `check` and `scripts:check` are
  unchanged.
- `docs/plans/2026-10-01-gcp-fastpath.md`:
  - The backlog takes wave 2's PT-2-lite, PT-3, PT-4 and PT-8-lite rows, and
    the dense side's Dense-owner row.
  - The merge-order note records that both branches landed together on this
    line.

The seam: the dense analytics-v2 specs pinned the primary chain's tail at 62.
The merge moved both pins:

- `postgres-test/analytics-v2-refresh.spec.mjs` now expects a 63-migration
  chain.
- `postgres-test/analytics-v2-community-daily-route.spec.mjs` now expects the
  tail `0063_enrollment_grants_erased_redeemer.sql`, in its constant, its
  header comment and its assertion message.

A search of every file the dense branch changed found no other tail pin.
Every remaining migration-count assertion under `postgres-test` reads 63. The
`0062` references that remain are all intentional:

- `postgres-function-search-path.spec.mjs` is about migration 0062 itself;
- the D1 `0062_v1_acquisition_vocabulary.sql` references belong to the D1
  chain;
- `ingestion-isolation-sequence.check.mjs` refers to GitHub main's D1 baseline.

## S9 seam

`f8406093` fixes this seam. At `c47f92d9` the edge end-to-end S9 stage
failed. It ran the rehearsal without a per-date expectation and composed its
own compare without the withheld dates, so its parity table differed from the
rehearsal's:

| Run | `model-days` compared | Equal | Differences |
|---|---:|---:|---:|
| Edge read | 127 | 119 | 91 |
| Rehearsal | 141 | 120 | 21 |

The fix composes S9's compare exactly as the rehearsal does. It passes
`EDGE_E2E_PER_DATE_EXPECTED` to the rehearsal; for the committed Q-1 golden
this defaults to `golden-q1-node/per-date-expected.json`. With an expectation,
S9 also requires zero unexpected differences. The edge-modes runbook names the
variable.

## Gates on `f8406093`

The gates ran serially from 2026-10-02 09:03Z to 10:19Z. The environment was:

- `PG_TEST_SOCKET=/private/tmp/tibotattle-pg-fanout-20260926/socket`;
- `PG_TEST_PORT=55433`;
- `PG_TEST_TCP_HOST=127.0.0.1` and `PG_TEST_TCP_PORT=55433`.

Commands ran in `apps/worker` unless noted.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` (TypeScript 7.0.2) | Exit 0 |
| `npm run analytics-v2:check` under Node 22.16.0 | 12 files, 121 of 121 |
| `npm run vendor:kernels:check` | 10 of 10 |
| `npm run gcp:fastpath:scripts-check` (socket and TCP) | Exit 0, 65 of 65, including the TCP case where the seed's chain runs as a non-superuser |
| `npm run scripts:check` | Exit 0, 1,059 of 1,059 over 24 runs |
| `npm run gcp:production-tooling:local-check` | Exit 0, 268 of 268 |
| `cloud-run`: `npm run check` | Exit 0, 338 tests: 337 pass, 1 skipped (the A2 opt-in case, below). This also rebuilt `cloud-run/dist`, which the rehearsals below executed |
| `postgres:domain:check`, Vitest half (`vitest.postgres.config.ts`) | 14 files, 84 of 84 |
| `postgres:domain:check`, node:test half | Exit 0, 347 tests: 345 pass, 2 skipped. `ledger-authority.spec.mjs` reads only `PG_TEST_HOST`. The Q-1 dump transfer case needs `POSTGRES_V12_TRANSFER_Q1_DUMP` |
| `ledger-authority.spec.mjs` alone, with `PG_TEST_HOST` set to the socket path | 1 of 1 |
| `node scripts/ci-postgres-suite.mjs --plan` | `planned`, 80 files, 2 host-profile files, 1 explicit-profile file, 10 allowlisted, 0 failures. `scripts/ci-postgres-suite.check.mjs`: 43 of 43 |
| `npm run edge:e2e:check` | 18 of 18, plus the dry run of all three edge modes |
| `npm run edge:e2e` under Node 22.16.0, `EDGE_E2E_GOLDEN=analytics-v2-test/golden`, `EDGE_E2E_REHEARSAL_NODE` set to Node 26.2.0 | 15 of 15, including S9 |
| Q-1 rehearsal: `npm run gcp:fastpath:rehearsal` | Exit 0, [pass](#q-1-rehearsal) |
| Dense rehearsal, `--dense` on the kept schema | Exit 0, [pass](#dense-rehearsal) |
| Worker `npx vitest run` | 2,363 of 2,364. The one failure is the known storage-graph-history case ([below](#known-failures-proven-pre-existing)) |
| Root `node --test test/hosted-backend-workflow.test.js` | 10 of 10 |
| Root `npm run architecture:check` | Passed: 926 production files, 3,961 imports, 0 approved debt edges |
| Root `npm run test:preflight` | Passed: root hygiene, `git diff --check`, documentation governance (312 Markdown and 1,654 source and config files), 20 of 20 |

Two invocation details:

- The first edge end-to-end run put Node 22.16.0 first on `PATH` without
  `EDGE_E2E_REHEARSAL_NODE`. S9's seeding rehearsal therefore ran its
  importers under Node 22.16.0 and failed `TYPED_LEGACY_SEALED_SQLITE_READ_FAILED`,
  so that run passed 14 of 15. The runbook requires a newer `node:sqlite` for
  those importers, and the rerun with the variable set passed 15 of 15.
- The first standalone `ledger-authority` run set `PG_TEST_HOST` to
  `127.0.0.1`. The spec accepts only a private socket path.

### Q-1 rehearsal

`npm run gcp:fastpath:rehearsal` ran with `PG_TEST_DATABASE=fmerge_q1`. It
imported fresh into schema
`typed_legacy_transfer_rehearsal_target_fastpath_e9166444` and took 56 s.

- **Migrations:** 63 primary, ending at
  `0063_enrollment_grants_erased_redeemer.sql`, and 7 ledger.
- **Gates:** every gate was true: importers, first refresh, read 200, no new
  revision on the second run, no unexpected parity difference, and
  `perDateEqual`.
- **Served read:** 396,337 bytes, `public, max-age=300`, origin on Node
  22.16.0.
- **Parity families:**

| Family | Equal / compared |
|---|---|
| `daily-totals`, `daily-cells`, `spend`, `daily-other` | 168 / 168 each |
| `allowance-breakdowns` | 71 / 71 |
| `model-days` | 120 / 120 |
| `model-days-per-date` | 21 accepted |

- **Per-date values:** all 14 withheld dates are published with values held
  to `gcp-fastpath-dense-per-date-v1`, and none is unverified.
- **Cache counts:** `cache-counts` stays the declared informational family,
  with 395 differences.
- **Output digests:** the response file `04f7a277…` and the preview
  `b3722cc9…` are byte-identical to the dense branch's.
- **Cleanup:** the rehearsal dropped its three schemas.

### Dense rehearsal

This pass ran the dense rehearsal with `--reuse-schema` on the kept dense
schema `typed_legacy_transfer_rehearsal_target_fastpath_dbab8e9e`, in the
local database `tibotattle_dense_parity`:

```sh
PG_TEST_DATABASE=tibotattle_dense_parity \
  node --max-old-space-size=8192 ./scripts/gcp-fastpath-rehearsal.mjs \
  --golden ./analytics-v2-test/golden-dense --dense \
  --reuse-schema typed_legacy_transfer_rehearsal_target_fastpath_dbab8e9e \
  --refresh-timeout-minutes 360
```

The importer contract allows reuse, with one difference:

- The kept schema was imported on 2026-10-02 between 00:24Z and 01:14Z. Its
  v1.2 transfer run is `complete`, from source snapshot `cb04f411…`. That
  window falls after the dense branch's `57df6927`, committed at 00:11Z.
- The rehearsal's importer modules, and the local modules they import, are
  identical from `57df6927` to `f8406093` except for one change.
  `postgres-fastpath-identity-copy.mjs` gained exports for the PT-3 importer,
  which the rehearsal does not read. The modules checked were:
  - `postgres-fastpath-identity-copy.mjs`;
  - `postgres-typed-legacy-transfer.mjs`;
  - `postgres-v12-transfer.mjs`;
  - `postgres-usage-correction-transfer.mjs`;
  - `postgres-ingestion-journal-transfer.mjs`;
  - `postgres-transfer-target.mjs`;
  - `gcp-fastpath-cloud-target.mjs`;
  - `postgres-migrations.mjs`;
  - `gcp-fastpath-oracle-sqlite.mjs`.
- The difference is the migration chain. The kept schema ends at 0062, and
  the only migration added since is 0063, which changes only
  `enrollment_grants` (a CHECK and a trigger). `analytics-refresh` and the
  analytics-v2 route read neither that table nor the migration receipts.

The run took 1,480 s. Every gate was true, including
`ownerParityZeroUnexpected`.

| Family | Equal / compared |
|---|---|
| Served daily families | 168 / 168 each |
| `allowance-breakdowns` | 71 / 71 |
| `model-days` (against the per-date expectation) | 141 / 141 |
| Owner fits | 5 / 5 |
| Owner model dates | 350 / 350 |
| Owner-days | 840 / 840 |
| Cache owner-days | 850 / 850 |
| Refusals | 15 / 15 |

- **Per-date values:** `perDateEqual` is true.
- **Second run:** it created no new revision.
- **Refreshes:** 744 s and 735 s. The model phase took 451 s and the read
  phase 156 s. The budget was 4,608 MiB, owner e's estimate 1,517 MiB, the
  sampled heap peak 2,060 MiB and the peak RSS 2,354 MiB.
- **Output digests:** the response file `36316eca…` (413,197 bytes served) and
  the preview `4158041c…` are byte-identical to the dense branch's
  `dense-final` run.
- **Kept schema:** the run mutated the kept schema only through the refresh's
  analytics writes and did not drop it.

A fresh dense import was not rerun in this pass. The earlier run of this task
did run one on `f8406093` with `--dump` set to the dense oracle's 163,950,762-byte
dump (digest `1d0bef8e…`, pinned by the manifest). That run started at
07:36:34Z, 83 s after `f8406093` was committed, and took 4,601 s:

- It imported into a fresh schema, `…_55f72736`, which it then dropped.
- It applied 63 primary migrations, ending at 0063, and 7 ledger migrations.
- T-2 took 3,173 s, and the refreshes 759 s and 659 s.
- Its report passes every gate.
- Its response and preview files hash to the same `36316eca…` and `4158041c…`
  as this pass's reuse run.

That report is earlier-pass evidence, which this pass hashed but did not
reproduce.

## Known failures proven pre-existing

Each failure was reproduced at `f8406093` and in a temporary detached
worktree at `3fa1ba64`, the final line before both merges, with the same
dependencies. That worktree was removed afterwards.

| Failure | `f8406093` | `3fa1ba64` |
|---|---|---|
| A2 activation opt-in case: `cloud-run/postgres-community-daily-activation.check.mjs` with `A2_DAILY_ACTIVATION_TEST_HOST=127.0.0.1` and `A2_DAILY_ACTIVATION_TEST_PORT=55433` | 18 of 19. "fresh migrations must match the exact contained baseline" | 18 of 19, the same assertion |
| `test/storage-graph-history-integration.spec.ts` alone | 12 of 13. `effective_owner_pending` where `effective_checkpoint` is expected | 12 of 13, the same assertion |
| Hosted Worker gate without `apps/worker/cloud-run` dependencies: `gcp:fastpath:scripts-check` with no `cloud-run/node_modules` | Exit 1. `gcp-fastpath-test-deploy.check.mjs` cannot load `cloud-run/analytics-refresh.mjs` (`ERR_MODULE_NOT_FOUND`, `@google-cloud/cloud-sql-connector`); 49 of 50 | Exit 1, the same module error; 16 of 17 |

The hosted-dependency failure also reproduces on the dense head `6e78d64f`
(48 of 49). The causes are recorded in the
[combined-gates receipt](./2026-10-02-gcp-fastpath-combined-gates.md#known-failure-outside-the-fast-path)
and the [wave-2 receipt](./2026-10-02-gcp-wave2-integration.md#open). None is
caused by these merges.

## Cleanup

- This pass created the local database `fmerge_q1` and dropped it.
- The earlier run left `fmerge_q1` and `fmerge_dense`, each holding only a
  `tibotattle_transfer` schema. This pass dropped both before starting.
- The schema list of the cluster's `postgres` database was the same before
  and after the gates.
- `tibotattle_dense_parity`, its three `dbab8e9e` schemas and
  `tibotattle_q1_parity` are kept.

## Not proved here

- This receipt does not cover the Worker `npm run check` as one command. Its
  `deploy:dry` and `staging:check` parts were not run, and neither were the
  root `npm test` and `npm run check`, a Docker image build, or anything on
  GCP or Cloudflare.
- The [wave-2 receipt](./2026-10-02-gcp-wave2-integration.md#open) records
  that the disposable `tibotattle_fastpath` test database holds 62 primary
  migrations. An origin built from this line serves only a schema migrated
  through 0063, so any redeploy from this line needs that test-project
  migrate first. This pass did not read or write that database.
- Synthetic data on one workstation does not prove Cloud SQL, Cloud Run,
  production volumes or the largest real owner. The dense-owner parity
  receipt's open items still stand: a measured cloud run with the `dense`
  refresh profile, and the T-2 importer's quadratic reader verification.
- The hosted Worker gate still fails without the cloud-run dependencies, as
  it did before these merges. Fixing it is for the owner and the dense
  workstream.
