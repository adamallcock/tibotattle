---
title: GCP fast-path deploy-site integration
date: 2026-10-03
type: receipt
status: snapshot
---

# GCP fast-path deploy-site integration

This is a 2026-10-03 receipt for merging `claude/gcp-fp-deploy-site` at
`889bea3d` into `claude/gcp-fastpath-final`. It records **local, synthetic**
evidence only: one macOS arm64 workstation and Node 26.2.0. Nothing was pushed
or deployed, no Wrangler or gcloud command ran, and no provider was contacted.
The deploy-site branch carries no receipt of its own, so its integration note
is this file.

## What the branch brings

Four commits on top of `f8a8620d`, the final line's mirror of the edge-port
line's changed-site work (owner round 15: every production deploy is typed, a
site rollback needs a verified release journal, the replaced source must be
proven, and Claude adds a release-archive script):

- `3b38f1f9`: the typed `production:deploy` accepts a changed site:
  `--candidate-public-manifest-sha256` with a fresh `--web-release-receipt` or
  a `--rollback-web-release-receipt`, plus the replaced live pair; it is
  exclusive with the retained pair and needs `--edge-mode worker` or `gcp`.
  `EDGE_MODE_REQUIRED_FOR_EDGE_LIVE` refuses a typed deploy without a mode over
  a live edge.
- `00d3e16a`: `PRODUCTION_UNTYPED_DEPLOY_REFUSED`, rollback bound to a verified
  release journal (`PRODUCTION_ROLLBACK_SITE_NOT_RELEASED`), and proof of the
  replaced site.
- `4a4d3ec1`, `889bea3d`: `production:release-archive` and its check, with
  the input, lock-probe and receipt-proof hardening. Both files are
  blob-identical to `claude/gcp-edge-port-d43c8f92` at `4ee75b0e`.
- Runbooks: the switch's site, web-only releases after the switch, the
  website rollback by receipt and archive, and the retained pair on every
  fenced, brake and worker-mode deploy command.

## The merge

`claude/gcp-fastpath-final` at `7855683a` merged `889bea3d` with
`git merge --no-ff` (merge commit `74526123`). The merge was textually clean.
Six files changed on both sides since `f8a8620d`: `apps/worker/package.json`,
`production-edge-mode.check.mjs`, `gcp-brake-and-incidents.md`,
`gcp-cutover-window.md`, `production-edge-modes.md` and
`production-operations.md`. Their hunks are disjoint. The merged result was
read for intent, not only for markers:

- `package.json` keeps the final line's `scripts:check` and gains
  `production:release-archive`, its `:check`, and the archive check inside
  `scripts:check`.
- `production-edge-modes.md` section 6 reads as one sequence: the switch's
  site, web-only releases, the website rollback, then the final line's D-BLOB
  Cloud Run deploy rules. The contract-change order (brake to fenced from a
  commit with the new blob) is compatible with the retained pair the brake
  now requires.
- Every `production:deploy` command in the maintained runbooks carries either
  the retained pair or the candidate site. No runbook the final line added
  since `f8a8620d` (staging and production apply, rollout, probes, scheduler
  resume, catalog signing) invokes `production:deploy`.

No integration fix was needed, so there is no separate fix commit. The merge
touches no file under `apps/worker/src`, `apps/worker/postgres`,
`apps/worker/postgres-test`, `apps/worker/cloud-run`, `apps/worker/test`,
`src/` or `packages/`.

No migration is added by this branch and none is staged on the final line
(no `staged-migrations` directory exists), so nothing was promoted; the
primary chain still ends at `0070_catalog_manifest_store.sql`.

## Gates

| Command (merged tree, `74526123`) | Result |
|---|---|
| `npm run scripts:check` (apps/worker) | pass, 1,110/1,110, 0 skipped (includes `production:release-archive:check` and `edge:e2e:check`) |
| `npm run gcp:ops:infra:check` (apps/worker) | pass, 335/335 |
| `npm run postgres:cutover-seal:check` (apps/worker) | pass, 104/104, 0 skipped |
| `npm run catalog:manifest:check` (apps/worker) | pass, 9/9 |
| `node --test` on `test/web-release-lane`, `release-publication`, `deployment-endpoints`, `hosted-backend-workflow`, `test-lanes`, `public-release-site`, `electron-public-site`, `public-release-site-preview`, `apps/worker/scripts/migration-numbering.check.mjs`, `ci-postgres-suite.check.mjs` | pass, 184/184 |
| `node --test test/tool-inventory.test.js` | pass, 6/6 |
| `node apps/worker/scripts/ci-postgres-suite.mjs --plan` | no failures |
| `npm run test:preflight` (root) | pass |
| `npm run architecture:check` (root) | pass: 965 production files, 4,129 imports, 0 approved debt edges |

No postgres-test spec reads a changed file, so none was run; no PostgreSQL
database was created. No pre-existing failure was met.

## Not proven

- Any live typed deploy, release archive or rollback. The provider has never
  been contacted by these tools on this line.
- A hosted CI run of the merged tree. Nothing was pushed.
- The production-deploy and staging-asset scripts are not blob-identical to
  the edge-port line (the lines differ elsewhere); only the archive script and
  its check are.
