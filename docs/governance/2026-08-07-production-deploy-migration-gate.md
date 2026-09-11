---
title: Production deploy gate — migrations, not intake
date: 2026-08-07
type: governance-decision
status: complete
---

# Production deploy gate: migrations, not intake

## Decision

The owner asked whether the production containment window was still needed
("Containment window seems way too complex, do we really need it?"). The
answer was no. The production deploy gate now gates on what is actually
dangerous for a routine deploy — unapplied D1 schema migrations — rather
than on intake posture. This is a decided governance change, implemented on
2026-08-07, not a proposal.

## What the containment gate cost

The previous `production:deploy` required `--receipt-file` pointing at an
owner-written containment proof (schema
`tibotattle-worker-deployment-proof-v0.1`, operation
`production_containment_observed`, `enrollmentMode: "disabled"`,
`collectionControls: "contained"`, four `ownerObserved*` evidence flags, a
15-minute maximum age, and owner-only `0600` file mode). That design predates
public operation: it was written when production was expected to sit in a
contained, enrollment-disabled posture between releases.

Production is now enrollment-open and operational. Under that reality the
receipt could never be truthfully written without first taking real intake
down, so every routine deploy required:

- a deliberate production intake outage (containing collection controls and
  disabling enrollment), and
- a hand-written owner attestation observing that outage, fresh within
  15 minutes.

A gate that forces an outage plus a manual attestation to ship a routine
Worker change does not reduce risk; it manufactures it.

## What replaces it

`production:deploy` now runs a D1 migration gate before any other deploy
gate:

- The pending set is computed from the deploy snapshot's migration
  directories (`migrations/` for `USAGE_MONITOR_DB`,
  `deletion-ledger-migrations/` for `DELETION_LEDGER`) against the remote
  production `d1_migrations` ledgers, read through a single read-only
  `wrangler d1 execute … --remote --env production` SELECT per database.
  Nothing is applied or mutated by this query.
- If the deploy carries **no** unapplied migrations, it proceeds with no
  receipt and no intake pause.
- If it **does** carry unapplied migrations, the deploy additionally requires
  `--confirm-migrations` whose comma-separated value must exactly match the
  pending set, in order, using ids of the form
  `BINDING:0000_name.sql` (for example
  `USAGE_MONITOR_DB:0030_deletion_cascade_child_indexes.sql`). A migration
  can therefore never ride along unnoticed. The exact pending set is printed
  before Wrangler is spawned. The deploy itself still does **not** apply
  migrations; the reviewed migration procedure remains a separate owner
  action.
- If the pending set cannot be determined — unreadable migration directory,
  failed or unparseable remote query, a non-sequential ledger, or a ledger
  entry unknown to the checkout — the deploy fails closed
  (`PRODUCTION_MIGRATION_STATE_UNKNOWN` /
  `PRODUCTION_MIGRATION_LEDGER_DRIFT`). A migration confirmation supplied
  when nothing is pending also fails closed
  (`PRODUCTION_MIGRATIONS_CONFIRMATION_UNEXPECTED`).

The confirmation token was renamed from `DEPLOY_CONTAINED_PRODUCTION` to
`DEPLOY_PRODUCTION`, because the old token asserted a containment posture the
deploy no longer requires or checks.

## What is deliberately kept

- The explicit `--confirm DEPLOY_PRODUCTION` confirmation.
- The clean-committed-tree requirement and the detached-worktree snapshot
  deploy (Wrangler runs from an immutable snapshot of the exact commit).
- The credential-free canonical `/api/health` recheck immediately before
  Wrangler, with its redirect, JSON, size, and security-header checks — minus
  the disabled/contained body assertion, since deploys now happen against a
  live enrollment-open service. The body must still report `status: "ok"`.
- The checked-out tree re-check immediately before and after Wrangler, and
  the ambiguous-outcome handling: a deploy that already ran when the tree
  moved is reported as ambiguous for owner re-inspection, never as success.
- The local `release:preflight` disposable migration/schema rehearsal as a
  hard gate.
- The post-deploy public-surface recheck (public root only, real 404s for
  private assets).

## What was removed, and where

The production containment path was deleted cleanly rather than kept behind a
flag:

- `apps/worker/scripts/production-deploy.mjs` no longer accepts
  `--receipt-file` and no longer reads any deployment proof.
- `apps/worker/scripts/deployment-proof.mjs` no longer defines the
  production proof kind (`production_containment_observed`, the production
  observation channel, or the canonical production manifest binding). The
  `"production"` kind now fails closed with
  `DEPLOYMENT_PROOF_KIND_INVALID`, and a spec pins that refusal. The staging
  proof and staging deployment-identity paths are unchanged, as are the
  owner-only `0600` file-gate protections they rely on.

Specs were re-pinned to the new contract (not weakened) in
`apps/worker/scripts/production-deploy.check.mjs` and
`apps/worker/scripts/deployment-proof.check.mjs`; each re-pin carries a
comment citing this note.

## Runbook alignment

The maintained [production operations runbook](../runbooks/production-operations.md)
describes the deploy sequence and does not instruct writing containment
receipts for routine deploys. The read-only production observer
(`release-readiness.mjs --probe-public`) remains available as an intake
posture check for incident response and intake-policy decisions; its output
no longer feeds any deploy receipt.
