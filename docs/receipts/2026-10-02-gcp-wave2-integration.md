---
title: GCP wave-2 integration
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP wave-2 integration

This is a 2026-10-02 receipt for the wave-2 integration on branch
`claude/gcp-fp-w2-integration`. It starts from `claude/gcp-fastpath-final` at
`3fa1ba64` and merges the three reviewed wave-2 packages, settles the seams
between them, and promotes W2-SEAL's migration as primary 0063. It records
**local, synthetic** evidence only: one macOS arm64 workstation, Node 26.2.0
for repository tooling, Node 22.16.0 (the image runtime) where noted, and the
local PostgreSQL 17.10 fan-out cluster on a private Unix socket (port 55433,
which also listens on loopback TCP). Nothing was built in Cloud Build,
deployed, migrated, applied or read in any GCP or Cloudflare project. No
`gcloud`, `wrangler` or push ran, and no request left the machine. Every
fixture value in the tests (roles, schemas, accounts, projects, commits and
receipts) is synthetic; the commits and file digests this receipt names are
the repository's own.

## Commits

| Commit | Content |
|---|---|
| `6357b05b` | `--no-ff` merge of W2-OPSDB, `claude/gcp-fp-w2-opsdb` `05626587`: the OPS-10 production migration job and rollout CLI, the shared runtime-grant policy, the `gcp-test-database` grant fix and the CI PostgreSQL planner fixes ([package receipt](./2026-10-02-gcp-w2-opsdb.md)) |
| `db12721c` | `--no-ff` merge of W2-INFRA, `claude/gcp-fp-w2-infra` `c99cfb47`: SIMP-0 items 7 to 9 and OPS-2 infrastructure as code, dry run only ([package receipt](./2026-10-02-gcp-w2-infra.md)) |
| `35aeb93d` | `--no-ff` merge of W2-SEAL, `claude/gcp-fp-w2-seal` `7e3ff2f1`: the PT-2-lite seal and deletion-digest projection, and the PT-3 importer in PT-1 production mode ([package receipt](./2026-10-02-gcp-w2-seal.md)) |
| `f2063efc` | Primary 0063 promoted, with the count and tail pins moved, OPS-10's contract review of 0063 and the SIMP residue rule |
| `aa2ae89b` | The cross-package seams, the gate registrations and the journal-guard review |
| This receipt's commit | This receipt and the fast-path plan's backlog rows |

### Merge reconciliation

Git merged all three packages without a textual conflict. The two expected
overlaps were reconciled by reading both sides:

- `apps/worker/package.json`: W2-OPSDB adds `postgres:production-migrations:check`
  and `gcp:production-rollout:check`, W2-INFRA adds `gcp:ops:infra:check`, and
  W2-SEAL adds `postgres:cutover-seal:check`. All four keys are kept.
- `apps/worker/scripts/gcp-backup-horizon.mjs`: W2-INFRA removes the ledger
  instance and role (audit receipt v2, role `primary` only). W2-OPSDB
  corrects the comment on the restated `INSTANCE_PATTERN`. Both are kept. The
  OPS-10 consumers stay compatible: the rollout calls `createOnDemandBackup`
  with `instanceRole: "primary"` and reads `roles.primary.instance` from the v2
  receipt through `verifyBackupHorizonReceipt`.

## Migration numbering

The integration is the numbering authority for this line.

- W2-SEAL's staged `0063_enrollment_grants_erased_redeemer.sql` (PT-3's 0075)
  moved with `git mv` to `postgres/migrations/primary/` as primary 0063, the
  next free number after 0062. Only its header comment changed, so its sha256
  is `0341b5a6…7ce9`. The staged directory is now empty and removed.
- `src/postgres-runtime-schema.ts` was regenerated with
  `generate-postgres-runtime-schema.mjs --write`; `--check` passes.
- Every primary count and tail pin moved from 62 to 63 in the files the 0062
  promotion moved, except the files this integration may not edit (see Open).
  `scripts/gcp-fastpath-test-deploy.check.mjs` passes synthetic counts to the
  command builder and reads no manifest, so it needs no change.
  `postgres-function-search-path.spec.mjs` now asserts that 0062 is applied
  and that the chain ends at the promoted tail, rather than at 0062.
- OPS-10's expand-compatibility classifier finds `drop` and `add-constraint`
  in 0063, so it is reviewed into `CONTRACT_MIGRATIONS` (24 entries, was 23)
  with its sha256. The review: 0063 replaces 0015's
  `enrollment_grants_check1` (aborting unless its definition is exactly
  0015's) with a weaker state-shape check that every existing row satisfies,
  plus a trigger that refuses a redeemed grant without a redeemer with the
  same SQLSTATE class 23514, except for an INSERT inside an import transfer
  session. The live writers always set the redeemer, and
  `normalizePostgresError` maps by SQLSTATE class only, so a serving previous
  revision sees no change.
- PT-3's frozen policy digest covers the trigger's reason text, which changed
  from "Staged 0063" to "Primary 0063". The pin in
  `postgres-identity-authority-transfer.check.mjs` moved from `d78633fa…` to
  `779895eb…`; recomputing the digest with the old text reproduces the old pin
  exactly, so nothing else in the policy changed.
- The SIMP residue is **not** created here (LEAD-SIMP is deferred). Its name
  must end in `_append_only_residue.sql` and its number must come after 0063
  (`NNNN_append_only_residue.sql`, NNNN 0064 or later). OPS-10's guard now
  enforces that: `SIMP_RESIDUE_PREDECESSOR` is
  `0063_enrollment_grants_erased_redeemer.sql`, and `simpResidueMigration`
  counts only a residue after both 0053 and that predecessor; a manifest
  missing either anchor has none. Checks cover a residue before 0053, one
  between 0053 and 0063, a manifest without the predecessor, and the accepted
  0064 residue.

## Seams settled

- **OPS-2 imports OPS-10's job.** `PRODUCTION_MIGRATION_JOB` now carries the
  env list `validateProductionMigrationEnvironment` reads, and the OPS-2
  manifest's `production-migrate` definition takes its entry, account, task
  timeout and env from it instead of a mirror. A new check proves the list is
  exactly what the validator reads: a recording proxy over the env shows the
  validator reads those ten keys and only Cloud Run's own besides, and
  dropping any one refuses. OPS-2 also refuses a migrate job whose declared
  connections are below the job's pool; that guard cannot fire while the
  pool is one connection, so it has no case of its own.
- **The OPS-10 cross-check runs.** The `gcp:ops:infra:check` test that ran
  OPS-10's validators on OPS-2's render was skipped on W2-INFRA's branch; it
  now imports both modules statically and has no skip condition: 179 of 179
  pass, 0 skipped (the package recorded 178 and 1 skipped).
- **`rolloutTarget(environment)` supplies the verifier path.** It now returns
  `verifierServiceAccount` (the desired state's verifier email) and
  `originAudience` (the service audience), so its keys equal OPS-10's
  `ROLLOUT_TARGET_KEYS` and `validateRolloutTarget` accepts the production and
  staging targets. A desired state without a verifier still validates for
  OPS-2, but `rolloutTarget` refuses it with
  `ROLLOUT_TARGET_VERIFIER_REQUIRED`. The verifier account is now a plane
  resource, as OPS-10 requires: a staging verifier must carry the staging
  marker and a production one must not.
- **The readback command is single-sourced.** The OPS-2 CLI check now derives
  OPS-10's preflight argv from `INFRA_READBACK_ARGV` and
  `ROLLOUT_ARGV.infraReadback` instead of restating it.
- **The stale OPS-10 test is renamed.** "without the infrastructure manifest
  every verb fails closed" is now "without an owner-held desired state every
  verb fails closed": the manifest exists, and the test pins that its
  `rolloutTarget` refuses `GCP_INFRA_DESIRED_STATE_UNCONFIGURED`, which the
  rollout reports as `ROLLOUT_INFRA_MANIFEST_UNAVAILABLE`. The rollout's
  header says the same.
- **Gate registration.** The Worker `check` now runs
  `postgres:production-migrations:check` and `postgres:cutover-seal:check`,
  and `scripts:check` runs `gcp:production-rollout:check` and
  `gcp:ops:infra:check`. The CR-3, EP-7 and OPS-1 checks that
  `gcp:ops:infra:check` bundles ran in no Worker gate before. Whether hosted
  CI runs these keys stays the owner's decision; no workflow changed.
- **The journal single-producer guard.** `scripts:check` failed on
  `scripts/cutover-source-projections.mjs` (W2-SEAL had not run it). The
  module writes a local journal-only SQLite for the existing journal importer
  and never opens PostgreSQL. Its one computed `INSERT` is now a reviewed
  dynamic writer, beside the rehearsal's `buildJournalSqlite`. Its local
  helper was renamed from `copy` to `copyRows`, because the guard's `COPY`
  pattern also matched `const copy = (`.
- **Checked and left as is.** OPS-10's backup consumers against the v2 audit
  receipt (above). `cloud-sql.mjs` connects over public IP with the connector,
  which matches OPS-2's rendered `--assign-ip` and
  `--connector-enforcement=REQUIRED`; a private-IP instance stays an owner
  decision.

## Gates

All gates ran serially on the code at `aa2ae89b` (the docs commit changes
no code). "PG env" is the fan-out cluster's socket and port; "TCP pair" adds
`PG_TEST_TCP_HOST=127.0.0.1` and `PG_TEST_TCP_PORT=55433`.

| Gate | Result |
|---|---|
| Worker `npx tsc --noEmit` | Exit 0 |
| Worker `npm run scripts:check` | Exit 0: 1,257 of 1,257 across 26 node:test runs, now including `gcp:production-rollout:check`, `gcp:ops:infra:check`, `edge:e2e:check` and the three-mode dry run. The first run failed the journal single-producer guard on W2-SEAL's projection (fixed, above) |
| `postgres:production-migrations:check` (PG env) | Exit 0: 33 of 33 offline; 5 of 5 PostgreSQL cases, migrating 0001-0063 forward. The two OPS-10 PostgreSQL specs under Node 22.16.0: 6 of 6 |
| `gcp:production-rollout:check` | 19 of 19 |
| `gcp:ops:infra:check` | 179 of 179, 0 skipped; the OPS-10 cross-check runs |
| `postgres:cutover-seal:check` | 32 of 32 |
| `postgres:migrations:check` | Exit 0: 10 of 10 and 1 of 1, and the generator's `--check` |
| The hosted workflow's static step, run locally (`test/hosted-backend-workflow.test.js`, `migration-numbering.check.mjs`, `ci-postgres-suite.check.mjs`) | 60 of 60 |
| `cloud-run` `npm run check` (PG env) | Exit 0: 337 pass, 1 skipped (the opt-in A2 case) across 16 runs. With the A2 TCP variables set, 18 of 19: the known A2 failure (Open) |
| `postgres:domain:check` Vitest half (PG env and TCP pair) | 14 files, 84 of 84, including both W2-SEAL specs |
| `postgres:domain:check` node:test half (PG env and TCP pair) | Exit 1: 337 tests, 324 pass, 11 fail, 2 skipped. All 11 failures are the two analytics-v2 pins (Open). The skips: `ledger-authority.spec.mjs` reads only `PG_TEST_HOST` and passed 1 of 1 alone with it set; the Q-1 dump transfer case is opt-in |
| `node scripts/ci-postgres-suite.mjs --plan` | Planned, 80 files (W2-OPSDB's 78 plus W2-SEAL's two), 0 failures; 2 HOST-profile files, 1 EDGE_E2E file, allowlist unchanged at 10 |
| `gcp:fastpath:scripts-check` (PG env) | 29 of 30, 1 skipped (the TCP case); with the TCP pair, 30 of 30 |
| `edge:e2e:check` | 18 of 18 |
| W2-SEAL Vitest specs (`postgres-identity-authority-transfer`, `cutover-source-seal-rehearsal`) | 2 files, 8 of 8, through the promoted 0063 (the fixture's staged path is no longer taken) |
| Edge end to end with the golden (spec under Node 22.16.0, the rehearsal under the default Node 26.2.0) | 15 of 15, including S9's golden read and write tier. A first attempt put Node 22.16.0 first on `PATH`, so S9's rehearsal ran its importers under it and failed `TYPED_LEGACY_SEALED_SQLITE_READ_FAILED`; that was the invocation, not the code |
| Root `architecture:check` | Pass: 924 production files, 3,950 imports, 0 debt edges |
| Root `test:preflight` (docs staged) | Exit 0; documentation governance valid, 20 of 20 governance tests |
| `git diff --cached --check` | Clean |
| Fan-out cluster leftovers | None from this integration. The remaining schemas all have OIDs older than a database created on 2026-10-01, and the newest belongs to the dense workstream's concurrent run |

## Not covered

- No GCP or Cloudflare resource was created, changed or read, and no image
  was built in Cloud Build. OPS-2's readback has never parsed real `gcloud`
  output, and PT-2-lite has never contacted the provider.
- `npm run product:worker:check`, the Worker `npx vitest run`,
  `analytics-v2:check` and a full `ci-postgres-suite` execution were not run;
  only the suite's static `--plan` ran. The gates above cover the changed
  surfaces, and the wave touched no Worker `src/` file except the generated
  runtime-schema manifest, which only the cloud-run host reads. The known
  `test/storage-graph-history-integration.spec.ts` failure recorded in the
  combined-gates receipt was therefore not re-run.
- The hosted workflows did not run. They have no Node 22.16.0 or EDGE_E2E
  golden, so the hosted `postgres-17-suite` job would report the EDGE_E2E
  environment gap.
- The analytics-v2 specs and the `gcp-fastpath-*` tooling belong to the dense
  workstream and were not edited (see Open).

## Open

- `postgres-test/analytics-v2-refresh.spec.mjs` asserts a 62-migration primary
  chain (staged plus promoted) and
  `postgres-test/analytics-v2-community-daily-route.spec.mjs` asserts the
  promoted tail is 0062. Both belong to the dense workstream, which this
  integration may not edit, and the dense branches carry the same pins. The
  refresh assertion already failed once W2-SEAL's staged 0063 merged, and the
  route assertion fails once 0063 is promoted. Copies of both specs with only
  those two literals moved to 63 and `0063_…` passed 36 of 36 on the same
  cluster; the copies were deleted. When the
  dense workstream merges, it must move both pins to 63 and `0063_…`, as the
  0062 promotion did.
- A2: the cloud-run `check` skips the A2 activation real-PostgreSQL case
  unless `A2_DAILY_ACTIVATION_TEST_HOST` is set. With the TCP pair it fails
  "fresh migrations must match the exact contained baseline" (18 of 19). The
  identical failure reproduces at `3fa1ba64` in a temporary detached worktree
  (since removed), so it predates this integration: the case seeds the
  pre-0050 `collection_controls` bootstrap shape, as the
  [combined-gates receipt](./2026-10-02-gcp-fastpath-combined-gates.md#known-failure-outside-the-fast-path)
  records.
- The SIMP residue (LEAD-SIMP) is next. Until it lands, OPS-10 refuses every
  non-scratch target with `PRODUCTION_SIMP_RESIDUE_MISSING`.
- The promoted 0063 changes the runtime receipt fence: an origin built from
  this line serves only a schema migrated through 0063, so the disposable
  `tibotattle_fastpath` test database (62 primary) needs a migrate before any
  redeploy from this line. That is a test-project write, not made here.
- Carried from the packages: the analytics-refresh Job and trigger stay
  deferred; a failed trigger pause leaves the trigger running until the next
  apply; a bucket insert with an unknown outcome needs a manual proof
  readback; the operator must be able to impersonate the verifier account;
  OPS-3 `pause-all` and `resume-all`, OPS-4 and OPS-5 are not built; a
  participant that is not quiescent after the seal costs an extra fence
  cycle, and the read-only pre-fence query is not built; PT-1 still needs an
  interim ledger pool until the SIMP residue lands.
