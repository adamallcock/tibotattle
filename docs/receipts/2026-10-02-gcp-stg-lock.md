---
title: GCP STG-LOCK staging deployment lock
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP STG-LOCK staging deployment lock

This is a 2026-10-02 receipt for STG-LOCK on the side integration branch
`claude/gcp-fp-int-b`, commit `6db3a2b4` on top of `9c83466d`. It records
**local, synthetic** evidence only: one macOS arm64 workstation, Node
26.2.0. No `gcloud`, `wrangler` or `git push` ran, no lock ref was read or
written on GitHub, and nothing read or wrote a GCP or Cloudflare resource.
This branch does not change `claude/gcp-fastpath-final`.

## Decision implemented

Owner decisions, round 9, "Deploy lock": OPS-10 for staging takes its own
ref, `codex/staging-deployment-lock`, never the production lock. Pushes of
that one staging ref are authorized; no other push is. This run made no
push; the tests use a fake git.

Before this change every OPS-10 mutating verb (`build`, `migrate`, `roll`)
took `refs/heads/codex/production-deployment-lock` whatever the
environment, so a staging bootstrap image would have pushed the production
lock.

## Change (`6db3a2b4`)

| Area | Content |
|---|---|
| `apps/worker/scripts/production-deployment-lock.mjs` | `STAGING_LOCK_REF` (`refs/heads/codex/staging-deployment-lock`) and the closed, frozen `DEPLOYMENT_LOCK_REFS` mapping `{production, staging}`. `deploymentLockRef(environment)` refuses anything else (`DEPLOYMENT_COORDINATION_ENVIRONMENT_INVALID`, own-property lookup, so `__proto__` and `constructor` are refused too). `createStagingDeploymentLock` uses the same compare-and-swap lock with its own error prefix (`STAGING_COORDINATION_*`) and owner schema `staging-deployment-lock-v1`. `createEnvironmentDeploymentLock({environment, ref, repositoryRoot, spawn?})` takes a closed option set and refuses a crossed pair (`DEPLOYMENT_COORDINATION_REF_MISMATCH`) before any Git access. Every lock object now exposes its `ref`. `createProductionDeploymentLock`, the immutable-artifact lock and their Git commands are unchanged |
| `apps/worker/scripts/gcp-production-rollout.mjs` | `underLock` asks the factory for the environment's own ref and refuses a lock that reports another (`ROLLOUT_LOCK_REF_MISMATCH`) before creating an owner. The default factory is `createEnvironmentDeploymentLock`. Dry runs of `build`, `migrate` and `roll` print `lockRef`, the exact ref `--execute` would push; `preflight` takes no lock and prints none. The new codes are in the content-free error allowlist. Receipts are unchanged |
| Runbooks | `docs/runbooks/gcp-staging-apply.md`, gated tail: the bootstrap-image and migrate rows now name the staging ref and the owner's push authorization, require the dry run's `lockRef` to read exactly `refs/heads/codex/staging-deployment-lock`, and stop on a dry run with no `lockRef` (a pre-STG-LOCK checkout, which would take the production lock). `docs/runbooks/gcp-rollout.md`: the Lock precondition and the error table (`STAGING_COORDINATION_*`, `ROLLOUT_LOCK_REF_MISMATCH`, `DEPLOYMENT_COORDINATION_*`) |

The task named "step 15" of the staging runbook. The runbook has numbered
sections 1 to 8 and an unnumbered gated-tail table, and no branch has a
step 15. The lock appears only in the gated tail's bootstrap-image and
migrate rows, so those are the rows changed.

## Tests added

`scripts/production-deployment-lock.check.mjs`, 15 to 25 tests:

- staging joins the lane matrix, so the six CAS lock tests (cross-checkout
  create and delete, lost acknowledgments, acquisition race, rejected
  deletion, push-URL allowlist, malformed remote state) run against the
  staging ref with the `STAGING_COORDINATION_*` codes;
- the mapping is exactly `{production, staging}` and frozen, and 14 unknown
  or malformed environments are refused;
- negative pairs, all before Git access: staging with the production ref,
  production with the staging ref, either with the immutable-artifact ref,
  a short or suffixed ref, an unknown environment, and extra options;
- staging and production locks are independent: with production held,
  staging acquires and releases only its own ref, never names the
  production ref, and neither owner can release the other's lock;
- production through the environment factory issues the same Git argv,
  options and environment as `createProductionDeploymentLock`, with the
  same schema-1 owner record (40-hex owner ids normalized, since owner
  commits carry their commit time).

`scripts/gcp-production-rollout.check.mjs`, 20 to 24 tests:

- dry runs print `lockRef` for both environments and all three mutating
  verbs, and preflight has none;
- a staging `migrate` then `roll`, through the real lock over an
  in-memory fake git, pushes only the staging ref (four pushes), never names
  the production ref, writes `staging-deployment-lock-v1` owners and leaves
  the ref released;
- a production `migrate` over the same fake git pushes the exact two
  production argv lines and the schema-1 record;
- a lock reporting another environment's ref is refused before any owner,
  in both directions; the real factory refuses crossed pairs and an unknown
  environment before Git, and the argument parser refuses an unknown
  environment first.

A mutation check confirmed the tests bind: mapping staging to the
production ref failed 3 rollout tests and 3 lock tests; the restored file
passed.

## Gates

Commands ran in `apps/worker` unless noted. Where a gate needed PostgreSQL
it used the local fan-out cluster (`PG_TEST_SOCKET=/private/tmp/tibotattle-pg-fanout-20260926/socket`,
`PG_TEST_PORT=55433`, `PG_TEST_TCP_HOST=127.0.0.1`, `PG_TEST_TCP_PORT=55433`).

| Gate | Result |
|---|---|
| `node --test scripts/production-deployment-lock.check.mjs scripts/gcp-production-rollout.check.mjs` on `6db3a2b4` | 49 of 49 |
| `npm run gcp:production-tooling:local-check` | Exit 0: production migrations 33 and 5, rollout 24, infra 266 (1 skipped, the same O-OPS skip as the INT-B receipt), cutover seal 66 |
| `npm run scripts:check` | Exit 0. 24 node:test runs: 1,069 tests, 1,069 pass (1,059 at `9c83466d`; the 10 are the lock check's) |
| `npm run gcp:fastpath:scripts-check` | Exit 0: 82 tests, 79 pass, 3 skipped (unchanged) |
| `npm run typecheck` | Exit 0 |
| Root: `node --test test/release-publication.test.js test/electron-stable-writer.test.js test/web-release-lane.test.js test/release-operation.test.js` (the root importers of the production lock) | 79 of 79 |
| Root `npm run architecture:check` | Pass: 944 production files, 4,040 imports, 0 debt edges |
| Root `npm run test:preflight` | Pass, on the tree with this receipt: documentation governance across 335 Markdown files, and 20 of 20 governance and guidance tests |

The rollout and lock gates ran on the uncommitted tree that became
`6db3a2b4`; the only later edits were a comment reflow and two runbook
lines, after which the two checks were rerun (49 of 49).

The PostgreSQL migration spec created and dropped its own tagged
`w2_opsdb_*` database and roles. Afterwards the cluster held no
`w2_opsdb*` or `int_b*` database or role.

## Not covered

- No live push of either lock ref. The first real staging `build` is the
  first proof that GitHub accepts `refs/heads/codex/staging-deployment-lock`
  (branch protection or rulesets on `codex/*` are not checked here).
- Other production-lock users (`production-deploy.mjs`, the release
  publication scripts, the D1 storage operator) still take the production
  lock and have no staging mode; they were not changed.
- Existing receipts that describe the staging lock push as a production
  push (STG-PREP) are point-in-time and were not rewritten.
