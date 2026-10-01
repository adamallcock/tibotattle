---
title: Production deployment and open PR reconciliation
date: 2026-09-21
type: plan
status: in-progress
---

Reconcile routine Worker deployment with a reviewed typed production layout,
then resume the authorized admin dashboard deployment. The maintained operating
authority remains [production operations](../runbooks/production-operations.md).
This plan is not evidence that a deployment or migration occurred.

## Acceptance boundary

- Inventory open PRs against exact current main and PR commits; distinguish
  ancestry, equivalent patches, and unique work. Preserve branches and worktrees.
- Preserve live database identities, storage namespace, secrets, other bindings,
  runtime settings, ingress and cron during an ordinary code deployment.
- Qualify typed database contracts with bounded read-only probes; never run
  legacy migrations against typed storage or implicitly apply remote migrations.
- Retain immutable source/dependency checks, deployment coordination, predecessor
  checks, private operation receipts, and post-deployment verification.
- Preserve public website assets during an admin-only update.
- Test refusal paths and the deploy integration before publishing code. Keep
  source/CI qualification separate from production deployment and browser proof.

## Compatibility problem

A routine deployment must not infer production resource identities from an
outdated local configuration. Source configuration, schema compatibility,
public-asset provenance and deployment qualification are separate checks.
The inspection operator records those checks without modifying the service.

## Work

1. Produce the open-PR disposition with ancestry and patch-equivalence evidence.
2. Implement live-configuration preservation and typed schema qualification as
   closed, testable deployment components.
3. Integrate read-only planning and guarded execution into the existing operator;
   review production inputs without publishing private identifiers.
4. Validate the exact candidate, merge reviewed workflow changes, and deploy the
   admin candidate only after all applicable gates pass.

No bulk PR merging, branch deletion, database migration, maintenance cutover, or
configuration-mode change is part of this reconciliation.

## Completion work

- Integrate the typed inspection into the coordinated deployment wrapper with
  private inventory hash pinning and repeated configuration/schema checks.
- Permit an admin-only release to retain a separately pinned public-site Git
  source and exact live manifest, without changing current public source files.
- Rehearse any required trigger restoration locally against both migration
  orders, preserving existing rows and unrelated guards. A prepared repair is
  not permission to apply it to a remote database.
- Validate the exact admin/runtime composition, then verify live configuration,
  public assets, health and the authenticated admin page after deployment.

## Reconciliation findings

The [open PR review](../reviews/2026-09-21-open-pr-reconciliation.md) accounts
for all 20 PRs: 12 exact-ancestor tips, four equivalent/superseded tips, and four
with unique work. PR 152 is the unique maintenance-related patch; it does not
provide an ordinary typed deployment path. No PR or branch was removed.

The new `production:reconcile` operator performs inspection only. It captures
and fingerprints live configuration, prepares a private configuration preserving
live service settings, independently builds expected schemas from source-owned
migrations, and admits only fixed read-only schema/contract queries. It never
invokes the deployment or migration commands. Synthetic refusal tests do not
establish production compatibility.

Production-derived observations, resource identities and object-level schema
diagnostics belong in owner-private receipts. They are not included in this
public source artifact. A mismatch must remain a blocker until reconciled;
never manufacture an expected digest from live rows or apply migrations merely
to obtain a passing inspection.

## Validation boundary

The focused reconciliation suite, documentation checks, preflight and architecture
checks pass. The completed tooling has 40 reconciliation/repair checks, 43
deployment checks, two asset-staging checks and 30 public-release checks passing.
Admin qualification covers 106 web tests and 76 Worker tests.
The complete Worker runtime run reports 1,777 passing tests and 31 failures in
seven files. Those seven files reproduce the same 31 failing test names on clean
base `7125ee9bcc896c445f055370c222e979aa8df790`, with 108 tests passing there.
The owning gate is not fully green; baseline reproduction establishes the
failures predate the deployment-tooling changes, not that the failures are fixed.
