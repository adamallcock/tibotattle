---
title: GCP INT-C seal restore-base ingestion layout
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP INT-C seal restore-base ingestion layout

This is a 2026-10-02 receipt for SEAL-RESTORE-BASE on branch
`claude/gcp-fp-int-c`, built on `0486c20b` (`claude/gcp-fastpath-final`). It
records **local, synthetic** evidence only: one macOS arm64 workstation and
Node 26.2.0. No Cloudflare or Google Cloud resource was read or written, no
Wrangler or gcloud command ran against a provider, and no production data was
used. The production ledger shape below comes from the wave 14 SEAL-LEDGER
evidence (13 names and git-blob digest prefixes), not from a read made here.

## The defect

Production ingestion was restored from a generated base, not migrated file by
file. Its ledger is `d1_storage_migrations` with 13 rows: one
`0001_restore_base.sql` row, then the 12 ingestion files applied after the
base (`migrations` 0061 and 0062, `typed-ingestion-migrations` 0005,
`ingestion-isolation-migrations` 0004 to 0012). The seal at `0486c20b`
modelled only a fresh chain, one row per file (90 at `d43c8f92`), so every
inventory layout refused live ingestion with `CUTOVER_LEDGER_MISMATCH`. The
deletion-ledger ledger (`d1_migrations`, 3 rows) already passed.

## The change

`apps/worker/scripts/cutover-source-seal.mjs`:

- An inventory source may name `"layout"`. Absent, or `"fresh-chain"`, is the
  earlier behaviour, and its expected-ledger digest is unchanged.
  `"ingestion-restore-base-v1"` is accepted only for ingestion, with all six
  ingestion directories, in role order, under `d1_storage_migrations` and no
  `d1_migrations`. Anything else is `CUTOVER_INVENTORY_INVALID`.
- Under that layout the expected ledger is the base row plus the tail: every
  `.sql` file of the six directories at `expectedSourceCommit` that the base
  did not fold, each with the sha256 of its git blob. The expected-ledger body
  records the layout and the base, so its digest differs from any fresh-chain
  digest.
- The folded inputs are recomputed from git objects at the base generator
  commit by `cutoverRoleInputsAt`, which lists them as
  `d1-storage-role.mjs` `readIngestionRoleInputs` does (directory order, sorted
  names, `{directory, name, sha256, bytes}`, the same size and NUL limits).
  They must number 78 and hash to the qualification's `inputSha256`. The
  generator commit must be an ancestor of `expectedSourceCommit`, and every
  folded file must still exist there with the same bytes. Any failure is
  `CUTOVER_EXPECTED_LEDGER_INVALID`.
- The base row's digest is pinned (`CUTOVER_RESTORE_BASE`). A live base row
  with any other digest is `CUTOVER_LEDGER_MISMATCH`.

The seal itself, its export, rebuild, remote checks and deletion-ledger
handling are unchanged.

## Provenance of the pinned base

| Fact | Value |
|---|---|
| Base row | `0001_restore_base.sql`, sha256 `396753809b9631990412a988972e105de6ce944417704f7ef560c76d6cae6c1f` |
| Generator | `apps/worker/scripts/d1-storage-restore.mjs` `rehearseStorageRestore` (`baseSql`, recorded as the operator ledger's one row) |
| Generator commit | `8da57e767a3b7b3d38d3bf80546e75afcd59e08d` |
| Folded role inputs | 78 files, `inputSha256` `9c128c5259a2af4fbd111a742caf9277683a8f122bb95dde527c2f4cda0a60af`: `migrations` 0001-0060, `typed-ingestion-migrations` 0001-0004, `ingestion-bridge-migrations` 0001-0002, `typed-v11-admission-migrations` 0001-0006, `typed-v1-admission-migrations` 0001-0003, `ingestion-isolation-migrations` 0001-0003 |
| Qualification reference | `.release-build/d1-upload-first-cutover-20260914/.release-build/upload-first-cutover-qualification/final-8da/ingestion/` (`qualification.json`, scope `restore-base-schema-only`; `role-inputs.json`, frozen source) |

Checks made on 2026-10-02:

1. **The generator is deterministic.** It was run with `--rehearse` (synthetic
   Miniflare D1 only) from a clean detached worktree at `8da57e76`. It wrote a
   `0001_restore_base.sql` that hashes to `396753809b96…`, byte for byte. The
   13 on-disk qualification copies under `.release-build` from seven source
   commits (`5ff56ab7`, `1070ee21`, `77f0b5e5`, `cd1ae544`, `edb6cbcb`,
   `1a2d8a36`, `8da57e76`) all hash to the same value and record the same
   `inputSha256`.
2. **The generator at `d43c8f92` does not reproduce it.** Run the same way, it
   wrote a base hashing to `06484964df77…`. At that commit it folds all 90
   files, and `typed-ingestion-migrations/0005_owner_occurrence_lookup.sql`
   adds two indexes on base tables. So the digest is pinned with provenance,
   not recomputed at seal time, and the seal fails closed on any other value.
3. **The folded list is recomputed from git objects.** `cutoverRoleInputsAt`
   at `8da57e76` gives 78 entries hashing to `9c128c52…`, the qualification's
   value. At `d43c8f92` every folded file is byte-identical, and the tail is
   exactly the 12 live rows. The restore expected ledger at `d43c8f92` is the
   13 live names with the 12-character digest prefixes from the evidence.

## Tests

New cases in `apps/worker/scripts/cutover-source-seal.check.mjs`, over the Q-1
synthetic ingestion D1 with its ledgers rewritten:

- The layout is explicit and ingestion-only. An unknown or null layout, the
  restore layout without its ledgers or with reordered or Wrangler-table
  directories, and the restore layout on the deletion ledger are all refused.
  Analytics is still `CUTOVER_SOURCE_NOT_ALLOWED` under either layout.
- The git-object role inputs equal `readIngestionRoleInputs` on the checkout,
  digest included.
- The restore expected ledger is the pinned base row plus exactly the
  unfolded tail, and it reproduces the 13-row live shape at `d43c8f92`. A
  folded file edited at the commit, role inputs that no longer match the
  qualification digest, a folded file removed at the commit, and a commit
  that predates the generator each refuse `CUTOVER_EXPECTED_LEDGER_INVALID`.
- A seal with the restore layout over a restore-era ledger succeeds; its
  deletion-ledger expected digest equals the fresh-chain run's.
- Each of these refuses `CUTOVER_LEDGER_MISMATCH` on `d1_storage_migrations`
  and leaves nothing behind: a wrong base digest, the base the generator
  writes at `d43c8f92`, a missing tail row, an extra tail row, an edited tail
  row, a folded file reappearing as a row, and a ledger with no base row.
- The fresh-chain layout refuses a restore-era ledger under both directory
  layouts. The restore layout refuses a fresh-chain ledger under both.

## CI coverage

A review found that, in CI, the restore cases above skipped without failing.
The only CI runner of this file is `.github/workflows/hosted-backend.yml`, job
`cloud-run-check`, step "Check the cutover seal tooling offline"
(`npm --prefix apps/worker run postgres:cutover-seal:check`). That job checked
out at depth 1, so `8da57e76` and `d43c8f92` were absent. Two tests skipped,
and two passed without running their pinned-commit assertions. The follow-up
on this branch:

- `cloud-run-check` checks out full history (`fetch-depth: 0`).
  `test/hosted-backend-workflow.test.js` pins this, and it pins depth 1 for
  the other jobs.
- Every check that reads a pinned commit object (`8da57e76`, its parent, and
  `d43c8f92`) now fails with `CUTOVER_SEAL_CHECK_ENVIRONMENT_GAP` when that
  object is missing. None skips. This includes the earlier Q-1 oracle
  comparison at `d43c8f92`.
- Reproduced locally: a depth-1 clone of `2aca5bfb` running the new check
  file gives 15 passed, 4 failed and 0 skipped. Each failure names the gap.
  Before the change, the reviewer's run of the restore and folded-inputs
  cases in the same setup gave 2 passed and 2 skipped. The full-history
  worktree gives 19/19 with 0 skipped.
- `d43c8f92` is not an ancestor of this line. A full-history checkout gets it
  only through a remote branch: on 2026-10-02 that was origin
  `codex/maintained-analytics-framework`. If no branch or tag on origin keeps
  it, the CI step fails as an environment gap. A durable tag would remove
  that dependency.
- The working-tree comparison in the folded-inputs check runs only when the
  six ingestion directories are clean against HEAD. A CI checkout always is.
- Not proven: a hosted GitHub Actions run of this job. Nothing was pushed.

## Gates

| Command | Result |
|---|---|
| `node --test ./scripts/cutover-source-seal.check.mjs` (apps/worker, full history) | 19/19, 0 skipped |
| `npm run postgres:cutover-seal:check` (apps/worker) | pass, 76/76 (seal, fence, projections, identity transfer, quiescence, legacy transfer checks) |
| `npm run test:preflight` (root) | pass, exit 0 |
| `npm run architecture:check` (root) | pass: 932 production files, 3,968 imports, 0 approved debt edges |

## Open items

- The owner command pack (`owner-command-pack-2026-10-02.md`, OWN-12 step 3
  and Appendix A) still tells the operator to place each ingestion directory
  under the table that holds its names, and to expect the fresh-chain tail.
  For production ingestion the inventory must instead select
  `"layout": "ingestion-restore-base-v1"`, and `expected-ledger` reports 13
  `d1_storage_migrations` rows at `d43c8f92`. That file is outside this
  branch and needs the correction.
- The restore layout requires the live ingestion D1 to have no
  `d1_migrations` table. The wave 14 evidence names only the storage ledger;
  if the private receipt shows a Wrangler ledger table on ingestion as well,
  the layout refuses and needs a decision. `production-operations.md` now
  says that `0063` goes to production ingestion as a `d1_storage_migrations`
  row, never through Wrangler, and to stop if a `d1_migrations` table shows
  up there.
- Not proven: any live seal, export or ledger read. The provider has never
  been contacted by the seal.

## Integration into the fast-path final line (2026-10-03)

`claude/gcp-fastpath-final` at `1e65504c` merged this branch at `62a438c5`
with `git merge --no-ff` (merge commit `d83a12fa`). Local and synthetic only:
macOS arm64, Node 26.2.0, the fan-out PostgreSQL 17 cluster on port 55433.
Nothing was pushed or deployed and no provider was contacted.

Conflicts and their resolution:

- `postgres-test/gcp-load-test.spec.mjs`, `scripts/gcp-load-test.mjs` and
  `scripts/gcp-load-test.check.mjs`: deleted here, edited on the final line
  (the C-SIMP integrator's `092dff19` spec repair and a D-CRB comment
  refresh). Those edits only kept the retired harness working, so the files
  are removed, as LOADTEST-RETIRE intends.
- `apps/worker/package.json`: `gcp:load-test`, `:check` and `:local` and the
  trailing `npm run gcp:load-test:check` in `edge:e2e:check` are gone; the
  final line's `gcp:origin-smoke:check` is kept.
- `apps/worker/cloud-run/infra/README.md`: this branch's staging row (the
  staging migrate-and-roll proof, no load test) with the final line's
  PROD-PREP production row, schema row and `monitoring.md` row.

Integration fix, committed separately as `573a4a74`: STG-PREP's
`cloud-run/staging-service.template.yaml`, which reached the final line after
this branch was cut, still said the staging load test (OPS-11) measures the
production shape. The comment now names the staging proof that replaced it.
No other tracked file outside dated receipts names the harness or its scripts.

No migration is added by this branch and none is staged on the final line, so
nothing was promoted; the primary chain still ends at `0070`.

| Command (merged tree, `573a4a74`) | Result |
|---|---|
| `npm run scripts:check` (apps/worker) | pass, 1,069/1,069 (includes `edge:e2e:check` without the load-test check) |
| `npm run gcp:ops:infra:check` (apps/worker) | pass, 335/335 |
| `npm run postgres:cutover-seal:check` (apps/worker) | pass, 104/104, 0 skipped; `cutover-source-seal.check.mjs` alone 19/19, 0 skipped (pinned commits present) |
| `npm run catalog:manifest:check` (apps/worker) | pass, 9/9, manifest check `ok` |
| `node --test test/hosted-backend-workflow.test.js apps/worker/scripts/migration-numbering.check.mjs apps/worker/scripts/ci-postgres-suite.check.mjs` | pass, 71/71 |
| `node apps/worker/scripts/ci-postgres-suite.mjs --plan` | no failures |
| `vitest run --config vitest.postgres.config.ts` on `cutover-source-seal-rehearsal`, `postgres-identity-authority-transfer`, `postgres-legacy-contribution-transfer` and `postgres-production-telemetry-modes` (the specs that use the changed W2-SEAL fixture), fan-out PG17 | 4 files, 42/42; no `w2_seal` database or role left behind |
| `npm run test:preflight` (root) | pass |
| `npm run architecture:check` (root) | pass: 965 production files, 4,129 imports, 0 approved debt edges |

No pre-existing failure was met. Still not proven: a hosted GitHub Actions run
of `cloud-run-check` with full history, and the owner command pack correction
listed under Open items.
