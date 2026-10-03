---
title: GCP fast-path INT-D integration
date: 2026-10-03
type: receipt
status: snapshot
---

# GCP fast-path INT-D integration

This is a 2026-10-03 receipt for merging `claude/gcp-fp-int-d` at `5e528c23`
into `claude/gcp-fastpath-final`. It records **local, synthetic** evidence
only: one macOS arm64 workstation, Node 26.2.0, and the fan-out PostgreSQL 17
cluster on port 55433 with one uniquely named database created for this run
and dropped afterwards. Nothing was pushed or deployed, no Wrangler or gcloud
command ran, and no provider was contacted. INT-D carries no receipt of its
own, so its integration note is this file.

## What the branch brings

INT-D already contained the final line at `112d27cc` (its merge `94fc29e1`).
Its own commits:

- `c23ad3df` (W-WEB-V13): the fast-path final reader mirror accepts allowance
  breakdowns v1.3 on the community page.
- `f86ff3bb` (W-WEB-L10N): the community tank's Codex label is localized
  through the catalog.
- `ec4bcd34` and `eab87650` (E-RETIRE): the legacy daily publisher
  (`src/postgres-community-daily-publisher.ts`, the A2 daily activation,
  contract, live-smoke, prepare, publish and restore tooling) and the
  analytics-history and applied transfer scripts and specs are removed.
- `34f0d6e2`, `c7768786` and `5e528c23` (MAINT-PURGE): the scheduled purges
  (expired identity handoffs, sign-in admission windows and the device
  lifecycle) run inside the lifecycle pass, with the new partial code
  `MAINTENANCE_PURGE_BACKLOG`, and the admin `run_maintenance` result reports
  them under the Worker's keys.

## Merge

Pre-merge head `a8bc2cca`; `git merge --no-ff 5e528c23`; merge commit
`4938e7e7`. Conflicts and their resolution:

- `cloud-run/postgres-community-daily-activation.mjs` and `.check.mjs`,
  `postgres-test/postgres-analytics-applied-main-transfer.spec.mjs` and
  `postgres-analytics-applied-transfer.spec.mjs`: deleted on INT-D, and the
  final line's only edits since `112d27cc` were the 0068 to 0070 migration
  count and tail pins. Removed, as E-RETIRE intends.
- `cloud-run/Dockerfile`, `cloud-run/build.mjs`, `cloud-run/package.json` and
  `apps/worker/package.json`: the final line's entries are kept (the K-PAR
  `analytics-refresh-worker` bundle and kernel identity, the refresh read and
  pool checks, `catalog:manifest:*`, `v0x:admission:check`,
  `postgres:retired-readers:check`, the extended `gcp:fastpath:scripts-check`
  and `gcp:ops:infra:check`, and `catalog-manifest-store.spec.mjs` and
  `unseen-token-probe.spec.mjs` in `postgres:domain:check`), without the
  retired daily publisher bundles and checks and without
  `analytics-history-transfer.spec.mjs`.
- `scripts/cloud-run-build-context.mjs`: the final line's 70-migration count
  and `0070_catalog_manifest_store.sql` tail, without the retired daily
  activation and contract required-path sets.
- `cloud-run/postgres-production-host.mjs`: both intents combined. A refused
  or failed pass still throws its `LIFECYCLE_PASS_ADMIN_ERRORS` entry (D-CRB's
  second review: a failure audit and the Worker's error, never a 200). A
  settled pass takes MAINT-PURGE's folded purge keys and the Worker's
  completeness conjunction (lifecycle, quarantine reconciliation and, when
  this pass ran them, the handoff and sign-in window purges); a
  device-lifecycle backlog stays outside the code. The header comment states
  both.
- `postgres-test/postgres-production-host.spec.mjs`: git interleaved two
  independent tests. Both are kept whole: the final line's refused or skipped
  `run_maintenance` test and INT-D's folded-purge test, with the file header
  naming both.
- `postgres-test/postgres-origin-fastpath.spec.mjs`: both sides made the same
  fix (the fastpath-test pool on the configured test database); the final
  line's `PG_TEST_DATABASE` constant is kept.
- `docs/plans/2026-10-01-gcp-fastpath.md`: the final line's newer OPS-2 to
  OPS-5 row; the SIMP row takes E-RETIRE's sentence that the
  analytics-history transfer scripts stayed until E-RETIRE removed them.

No tracked file outside dated receipts, reviews and the plan's history names a
removed module, and no remaining code imports a removed export
(`readPostgresCommunityDailyDaySourceEligibility`,
`publishPostgresCommunityDailyDay` and the daily publication types). The
dated-document mentions are the same ones INT-D itself carries.

No integration fix beyond the conflict resolution was needed.

## Migrations

INT-D adds and stages no migration, and none is staged on the final line, so
nothing was promoted. The primary chain still ends at
`0070_catalog_manifest_store.sql`; `src/postgres-runtime-schema.ts` is
unchanged and `CONTRACT_MIGRATIONS` is untouched.

## Gates on `4938e7e7`

| Command (from `apps/worker` unless noted) | Result |
|---|---|
| `npm run scripts:check` | exit 0, no failing test |
| `npm run gcp:ops:infra:check` | exit 0, 335/335 |
| `npm run postgres:cutover-seal:check` | exit 0, 104/104 |
| `npm run catalog:manifest:check` | exit 0, 9/9, digest `da55288b…` |
| `npm run postgres:migrations:check` | exit 0 |
| `cloud-run`: `npm run check` (rebuilds `dist/`, includes `production-host:check`) | exit 0, no failing test |
| `npm run postgres:production-migrations:check` (PG17 55433) | exit 0, 34/34 and 5/5 |
| `node --test --test-concurrency=1` on `postgres-lifecycle-pass`, `postgres-production-host`, `postgres-origin-fastpath` and `postgres-maintenance` specs (PG17 55433) | 28/28, 0 skipped |
| `node --test --test-concurrency=1` on `postgres-device-lifecycle`, `postgres-signin-primitives`, `postgres-google-handoff`, `postgres-admin-console`, `postgres-lifecycle-state` and `analytics-v2-community-daily-route` specs (PG17 55433) | 41/41, 0 skipped |
| `vitest run --config vitest.postgres.config.ts` (PG17 55433) | 13 files, 96 passed, 1 skipped |
| `vitest run test/edge-request-header-allowlist.spec.ts` | 9/9 |
| root: `node --test test/hosted-backend-workflow.test.js apps/web/test/community-breakdowns-v13.test.mjs` | 32/32 |
| root: the community, allowance and i18n web suites plus `test/macos-localization.test.js` and `test/public-release-site.test.js` | 189/189 |
| root: `npm run architecture:check` | passed (958 files, 4094 imports, 0 debt edges) |
| root: `npm run test:preflight` | 21/21 |

The one vitest skip is the TCP-only case in
`postgres-ingestion-journal-transfer.spec.mjs`, which needs a TCP stand-in
host that this socket run did not set; neither side changed that spec. No
known pre-existing failure was hit.

## Not proved here

- The full `postgres:domain:check`, root `npm test` and `npm run check`, and
  the Worker `product:worker:check` were not run; only the specs and gates
  this merge touches.
- No container image was built from the edited `Dockerfile`; `cloud-run`
  `npm run check` ran the same `build.mjs` and the build-context check.
- Nothing about live state: no staging or production database, Job,
  scheduler or site was read or changed.
