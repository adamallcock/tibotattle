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
between them, and promotes W2-SEAL's migration as primary 0063. A later
review-fix commit on the same branch corrects five review findings
([Review fixes](#review-fixes)). It records **local, synthetic** evidence only: one macOS arm64 workstation, Node 26.2.0
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
| `aa2ae89b` | The cross-package seams, the gate registrations (withdrawn by the review fixes) and the journal-guard review |
| `5f8e1551` | The first version of this receipt and the fast-path plan's backlog rows |
| The review-fix commit | The [review fixes](#review-fixes): the four keys leave the Worker gates, PT-3 enforces the do-not-restore rule, and this receipt and the plan rows are corrected |

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
  `normalizePostgresError` maps by SQLSTATE class only, so at the SQL level
  every write a previous revision makes is admitted or refused as before.
  That review does not cover the previous revision's receipt fence: the only
  fence that exists requires the migration history to equal the image's
  manifest exactly, so a revision built before 0063 refuses its
  storage-gated routes with 503 once 0063 is applied, until the roll (see
  [Review fixes](#review-fixes)).
- PT-3's frozen policy digest covers the trigger's reason text, which changed
  from "Staged 0063" to "Primary 0063". The pin in
  `postgres-identity-authority-transfer.check.mjs` moved from `d78633fa…` to
  `779895eb…`; recomputing the digest with the old text reproduces the old pin
  exactly, so nothing else in the policy changed.
- The SIMP residue is **not** created here (LEAD-SIMP is deferred). Its
  number must come after 0063, and its proposed name is
  `NNNN_append_only_residue.sql` (NNNN 0064 or later). The name awaits the
  owner's confirmation (wave-3 SIMP design, OD-1); if the owner picks another
  name, `SIMP_RESIDUE_MIGRATION_SUFFIX` and its checks change in the same
  change. OPS-10's guard enforces the proposal and fails closed: `SIMP_RESIDUE_PREDECESSOR` is
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
- **Gate registration (withdrawn by the review fixes).** `aa2ae89b` chained
  `postgres:production-migrations:check` and `postgres:cutover-seal:check`
  into the Worker `check`, and `gcp:production-rollout:check` and
  `gcp:ops:infra:check` into `scripts:check`. That was not local only: the
  hosted Worker gate runs `npm --prefix apps/worker run check`. The review-fix
  commit takes the four keys out again (see
  [Review fixes](#review-fixes)).
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

## Review fixes

A review of `5f8e1551` raised five findings. Each was checked against the code
before it was fixed; none was rejected.

1. **Hosted CI ran the four new keys.** The first version of this receipt said
   no hosted gate changed. That was wrong: `aa2ae89b` chained the keys into
   the Worker `check` and `scripts:check`, and the hosted Worker gate runs
   `npm --prefix apps/worker run check`. Three of the four could not pass
   there. That job installs no `apps/worker/cloud-run` dependencies (pinned
   by `test/hosted-backend-workflow.test.js`), and with the cloud-run
   `node_modules` moved aside locally, `postgres:production-migrations:check`
   and `gcp:ops:infra:check` exit 1 with `ERR_MODULE_NOT_FOUND` for
   `@google-cloud/cloud-sql-connector` (test files fail to load).
   `gcp:production-rollout:check` exits 1 on one case: the rollout's manifest
   import fails, so it reports `ROLLOUT_INFRA_MANIFEST_UNAVAILABLE` instead of
   the expected refusal. Only `postgres:cutover-seal:check` passes there.
   The owner had not agreed, so the fix takes the four keys out of `check`
   and `scripts:check`, which are now byte-identical to `3fa1ba64`. A new local-only key,
   `gcp:production-tooling:local-check`, runs all four. Hosted CI still
   covers OPS-10's offline checks and its rollout check in the Cloud Run
   check job, which W2-OPSDB extended, and its PostgreSQL spec in the
   `postgres-17-suite`. `gcp:ops:infra:check` (which bundles the CR-3, EP-7
   and OPS-1 checks) and `postgres:cutover-seal:check` run in no hosted
   gate. Adding them is the owner's decision.
2. **The previous revision does not keep serving through a migrate.** OPS-10
   assumes the previous revision serves the migrated schema until the roll.
   But the only runtime receipt fence (`readSchemaReceipt` in
   `cloud-run/postgres-test-dispatch.mjs`) admits a history only when it
   equals the image's manifest exactly, and `assertStorageCurrent` gates every
   intake write. Behind that fence every migrate, 0063 included, takes the
   previous revision's storage-gated routes to 503 until the roll. This is
   latent until CR-7 builds the production host. The fix is to documentation
   and comments only:
   - The plan's CR-7 row now requires a fence that admits a reviewed,
     expand-compatible extension of the image's manifest. Failing that, the
     OPS-10 runbook must treat migrate-to-roll as a write outage. The OPS-10
     row says the same.
   - The OPS-10 module header, the `CONTRACT_MIGRATIONS` note, the 0063
     review reason and the rollout's `secondsSinceMigrate` comment now limit
     the review to the SQL a previous revision issues.
3. **The hosted `postgres-17-suite` would fail, not only report a gap.**
   `Not covered` and `Open` now say so, with the 11 analytics-v2 pin failures
   (re-run: 36 tests, 25 pass, 11 fail) and the merge-order constraint. The
   pre-existing Worker gate failure on `gcp:fastpath:scripts-check` is
   recorded beside it.
4. **PT-3 did not enforce the do-not-restore rule.** Called directly, it
   imported any `active` participant without consulting the sealed deletion
   digests. It now does so before its first write:
   - It reads the same seal's deletion-ledger digests in memory through the
     new `readSealedDeletionDigests`. This is the projection
     `projectDeletionDigests` writes, with the same sha256, so no caller can
     pass a stale or empty list.
   - It calls `assertNoSealedParticipantDeletionMatches`, which refuses
     `CUTOVER_ERASED_PARTICIPANT_PRESENT` whether or not PT-8-lite composes
     PT-3.
   - The quiescence refusal still comes first.
   - PT-3's returned receipt adds `doNotRestore` (the digest count, the
     projection sha256, the participant count and `matches: 0`), and the
     summary its stored `receiptSha256` digests covers the count and the
     sha256.
   - The policy digest is unchanged.
   - New cases: the offline check plants the tombstone of an `active`
     participant in a forged seal's ledger (`forgeVariantSeal` takes a
     source role now). PT-3 then refuses before it touches its target, and
     a mutation that skips the call fails that case with
     `CUTOVER_TARGET_HANDLE_INVALID`. The PostgreSQL spec proves nothing was
     written for the same variant. The rehearsal checks that PT-3's
     `doNotRestore` equals the PT-2-lite projection's count and sha256.
5. **The SIMP residue name is a proposal.** The plan's SIMP row, the
   migration numbering above and the OPS-10 module header now mark
   `NNNN_append_only_residue.sql` as awaiting the owner's confirmation (OD-1).
   The guard stays, because it fails closed.

### Gates after the review fixes

These ran serially on the review-fix code, with the same environments as
above.

| Gate | Result |
|---|---|
| Worker `npx tsc --noEmit`; `node --check` on every changed module | Exit 0 |
| Worker `npm run scripts:check` | Exit 0: 1,059 of 1,059 across 24 node:test runs (the 1,257 above less the 19 rollout and 179 infrastructure tests that left it) |
| `npm run gcp:production-tooling:local-check` (PG env) | Exit 0: production migrations 33 of 33 and 5 of 5 PostgreSQL; rollout 19 of 19; infrastructure 179 of 179; cutover seal 32 of 32 (including the new PT-3 and projection cases) |
| `cloud-run` `npm run check` (PG env) | Exit 0: 337 pass, 1 skipped (the opt-in A2 case) across 16 runs |
| `postgres:domain:check` Vitest half (PG env and TCP pair) | 14 files, 84 of 84, including the new PT-3 variant and the rehearsal's `doNotRestore` check |
| `postgres:migrations:check` | Exit 0: 10 of 10 and 1 of 1 |
| The hosted workflow's static step, run locally | 60 of 60 |
| `node scripts/ci-postgres-suite.mjs --plan` | Planned, 80 files (77 SOCKET, 2 HOST, 1 EDGE_E2E), 0 failures |
| `analytics-v2-refresh` and `analytics-v2-community-daily-route` specs (PG env and TCP pair) | 36 tests: 25 pass, 11 fail, the pins described in Open (re-run for finding 3, unchanged) |
| Root `architecture:check` | Pass: 924 production files, 3,950 imports, 0 debt edges |
| Root `test:preflight` (docs staged); `git diff --cached --check` | Exit 0; clean |
| Fan-out cluster leftovers | None: no database, role or schema created since this session began (`xmin` above 3,000,000) remains in any database |

The `postgres:domain:check` node half, `edge:e2e:check`,
`gcp:fastpath:scripts-check` and the edge end-to-end run were not re-run: no
file they load changed.

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
- The hosted workflows did not run. At this head the hosted
  `postgres-17-suite` job would **fail**, not only report a gap. The planner
  routes `analytics-v2-refresh.spec.mjs` and
  `analytics-v2-community-daily-route.spec.mjs` (SOCKET profile), and they
  fail 11 of 36 tests on their primary-chain pins (Open). Ten of the 11 are
  one setup assertion cascading, so the route behaviour cases (a) to (f) do
  not run on this branch. The job would also report the EDGE_E2E environment
  gap: CI has no Node 22.16.0 or golden.
- The hosted Worker gate cannot pass either, before or after this
  integration. Its job installs no `apps/worker/cloud-run` dependencies, and
  `test/hosted-backend-workflow.test.js` pins that it does not. The Worker
  `check` already runs `gcp:fastpath:scripts-check` at `3fa1ba64`, and that
  key imports `cloud-run/analytics-refresh.mjs`, which needs
  `@google-cloud/cloud-sql-connector`. Run locally with the cloud-run
  `node_modules` moved aside, it exits 1 with `ERR_MODULE_NOT_FOUND`. The
  keys before it in `check` that touch PostgreSQL passed that way; the rest,
  such as `npm test` and `analytics-v2:check`, were not tried that way. That
  key and its tooling belong to the dense workstream.
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
  0062 promotion did. **Merge order:** this branch must not reach `main`
  before the dense branch moves both pins, or the two must land together;
  otherwise `main` turns the PostgreSQL 17 suite red.
- A2: the cloud-run `check` skips the A2 activation real-PostgreSQL case
  unless `A2_DAILY_ACTIVATION_TEST_HOST` is set. With the TCP pair it fails
  "fresh migrations must match the exact contained baseline" (18 of 19). The
  identical failure reproduces at `3fa1ba64` in a temporary detached worktree
  (since removed), so it predates this integration: the case seeds the
  pre-0050 `collection_controls` bootstrap shape, as the
  [combined-gates receipt](./2026-10-02-gcp-fastpath-combined-gates.md#known-failure-outside-the-fast-path)
  records.
- The SIMP residue (LEAD-SIMP) is next. Until it lands, OPS-10 refuses every
  non-scratch target with `PRODUCTION_SIMP_RESIDUE_MISSING`. Its name awaits
  the owner's confirmation (OD-1).
- CR-7's receipt fence: until the production host admits a reviewed
  expand-compatible extension of its manifest, every migrate is a write
  outage for the previous revision until the roll (review fix 2).
- Hosted gates: `gcp:ops:infra:check` and `postgres:cutover-seal:check` run
  in no hosted gate, and the hosted Worker gate already fails on
  `gcp:fastpath:scripts-check` without the cloud-run dependencies. Both are
  for the owner, and the second also for the dense workstream.
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
