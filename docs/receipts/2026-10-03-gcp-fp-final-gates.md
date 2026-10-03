---
title: GCP fast-path final line full gate run
date: 2026-10-03
type: receipt
status: snapshot
---

# GCP fast-path final line full gate run

This is a 2026-10-03 receipt for the full gate set on
`claude/gcp-fastpath-final` after the combined merge (PROD-PREP with the
INT-B stack, INT-C, DEPLOY-SITE, INT-D, and E-PT8 with the identity-link
rotation), from `2ada309a`, against the pre-merge line `de1e0caa`. It
records **local, synthetic** evidence only: one macOS arm64 workstation,
Node 26.2.0 (Node 22.16.0 where the image runtime is named), and the
fan-out PostgreSQL 17 cluster on port 55433 with one uniquely named
database created for this run and dropped afterwards. Nothing was pushed or
deployed, no gcloud or Wrangler command ran, and no provider was contacted.
A detached worktree at `de1e0caa` (node_modules cloned from the final
worktree) held the pre-existing comparisons.

## Failures caused by the merge, and their fixes

Each fix is its own commit on top of `2ada309a`:

| Commit | Gate | Cause | Fix |
|---|---|---|---|
| `5f7a7c46` | E12 under Node 22.16.0 | O-OPS (`46e515f0`) made `scripts/gcp-fastpath-test-deploy.mjs` import `gcp-production-rollout.mjs`, which imports `src/edge-origin-contract.ts`; the spec imports the test-deploy script, so it no longer loaded under Node 22.16.0 (`ERR_UNKNOWN_FILE_EXTENSION`). The same imports load on `de1e0caa` | The documented E12 command (spec header and `production-edge-modes.md`) passes `--experimental-strip-types`; the origin under test is still the bundled `cloud-run/dist` |
| `3181c441` | `append-only:absence:check` | STG-PREP's `gcp-ops-infra-staging-service.check.mjs` injects `LEDGER_SCHEMA` as a negative test: `1 LEDGER_* (pinned 0)`. 19/19 on `de1e0caa`, where the file does not exist | The file is pinned at its exact count beside `gcp-ops-infra-manifest.check.mjs` |
| `b47b8ea2` | `gcp:origin-smoke:check` | The CLI case assumed the committed production desired state still held placeholders; PROD-PREP filled it, so the dry run exits 0. 10/10 on `de1e0caa` | The case holds the committed state: a dry-run plan without `--execute`; with `--execute` and no gcloud, `EDGE_ORIGIN_IDENTITY_TOKEN_UNAVAILABLE`, exit 1, no probe; incomplete arguments exit 2 |
| `db277fdc` | `postgres:retired-readers:check` | E-PT8's `RUNTIME_RESET_TABLES` names the retired shared tables `community_model_composition_days` and `community_model_history_dependencies` on multi-element lines, which the guard reads as references. 4/4 on `de1e0caa` | Each name is a lone list element with an inventory ceiling of 1; table set and order unchanged (the disposition policy pin passes 24/24) |
| `5f49eff6` | `v0x:admission:check` | K-V0X's anti-vacuity floor required 15 build entries; E-RETIRE removed four daily publisher bundles, leaving 12. The check did not exist on `de1e0caa` | Floor 12 |

## Gates on the fixed head

Commands run from `apps/worker` unless noted; the last code fix is
`5f49eff6`.

| Gate | Result |
|---|---|
| Q-1 rehearsal (`gcp-fastpath-rehearsal.mjs --golden analytics-v2-test/golden --per-date-expected …/golden-q1-node/per-date-expected.json --owner-reference analytics-v2-test/golden-q1-node`; Node 26.2.0 runner, dist and refresh on Node 22.16.0), run on `2ada309a` | `status: pass`, every gate true: importers, first refresh, read 200 (396,767 bytes), second run 0 new revisions (168 heads before and after, highest revision 1), parity 0 unexpected (168/168 days), breakdowns v1.3 declared, per-date equal, owner parity 0 unexpected (fits 4/4, model dates 280/280, owner-days 672/672, cache owner-days 680/680, refusals 15/15). Primary 70 of 70, tail `0070_catalog_manifest_store.sql`; 2 schemas dropped. No later fix touches the rehearsal path |
| E12 without `EDGE_E2E_EDGE_TREE` (Node 22.16.0 `--experimental-strip-types`, `EDGE_E2E_GOLDEN=analytics-v2-test/golden`, rehearsal node 26.2.0) | 15/15, 383 s |
| E12 with `EDGE_E2E_EDGE_TREE` at `fp/EDGEPORT` (`claude/gcp-edge-port-d43c8f92` `4ee75b0e`, contract byte-identical, left clean) | 15/15, 350 s |
| E12 as previously documented (Node 22.16.0, no flag) on `2ada309a` | fails to load (the first fix above) |
| Worker `npm run check`, every step except the Wrangler CLI ones, serially | 201 of 208 steps pass. node:test 1,441 pass, 1 skipped, 0 failed; vitest `npm test` 182 files, 2,411/2,411; `test:node` 2/2; `analytics-v2:check` 17 files, 187/187; `tsc --noEmit` pass |
| Worker `npm run postgres:domain:check` | vitest 14 files, 101 passed, 1 skipped (the TCP-only journal case); node 446/447, 1 skipped (`POSTGRES_V12_TRANSFER_Q1_DUMP` unset), 0 failed |
| Worker `npm run gcp:ops:infra:check` | 336/336 |
| Worker `npm run postgres:cutover-seal:check` | 129/129 |
| Root `npm test` (`test:changed --base de1e0caa` plans the full lane) | 6,113 tests: 6,059 pass, 48 skipped, 6 failed, all pre-existing (below) |
| Root `npm run architecture:check` | pass (958 production files, 4,094 imports, 0 debt edges) |
| Root `npm run test:preflight` | 21/21 |

## Pre-existing failures (identical on `de1e0caa`)

Root `npm test`: six tests in `test/price-registry.test.js`,
`test/r7-generated-release-evidence.test.js` and
`test/reviewed-model-catalog.test.js` (registry and catalog contents ahead of
their pins, and the R7 receipts' `workloadCodeSha256`). The same three files
fail the same six tests on `de1e0caa`; this line changes none of them.

## Not run, and environment gaps

- Wrangler CLI steps of the Worker check were not run (this run's limits
  exclude Wrangler): `types:check`, the edge-mode dry run in
  `edge:e2e:check`, `deploy:dry` and the `staging:check` dry run.
- `production:stage-assets` (in `deploy:dry` and `staging:check`) fails with
  "Generated public release manifest is missing", and
  `staging-readiness.mjs --mode config` reports
  `GENERATED_COMMUNITY_ASSETS_INVALID`: this worktree holds no generated public
  site. Both fail the same way on `de1e0caa`.
- The worktree's installed `@app-usagemonitor/accounting` and
  `quota-analysis` copies carried a `test/` directory outside the packages'
  `files`, which `workspace-packages:guard` refuses; removing those copies
  made the guard pass. No tracked file changed.
- Nothing about live state: no staging or production database, Job,
  scheduler, edge or site was read or changed.
