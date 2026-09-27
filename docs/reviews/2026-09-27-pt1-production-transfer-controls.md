---
title: PT-1 production transfer controls review
date: 2026-09-27
type: review
status: snapshot
---

# PT-1 production transfer controls review

**Status:** source-only review of `codex/gcp-transfer-control-audit` at
`447a029f83b5f0db215a7249c155c255b1be82f5`, dated 2026-09-27. No GCP,
Cloudflare, or PostgreSQL production resource was inspected or changed. The
PostgreSQL acceptance test was skipped because no local test connection was
configured.

## Decision

The inspected PT-1 controls fail closed for the PostgreSQL-visible identity,
run state, receipt, checkpoint, and trigger invariants. I found no concrete
control-flow bug in those paths by source review and local mocked checks.

**Target identity remains an integration gate.** The immutable contract stores
GCP project and Cloud SQL instance names, but `openProductionTransferTarget`
does not verify that its supplied pools connect to those resources. Before a
production caller uses this handle, its pool factory must bind and prove the
primary and ledger connection identities against the registered project and
instance values. An identically named PostgreSQL clone with the same contract,
database names, roles, migration receipts, and PostgreSQL major version could
otherwise pass the checks in this module.

## Verified control behavior

- `sessionFacts` checks PostgreSQL 17, `current_database()`, `session_user`,
  and that the initial `current_user` matches the login. Opening then checks
  the registered contract ID, database name, login, control-schema owner,
  application-schema owner, and exact migration receipts
  (`apps/worker/scripts/postgres-transfer-target.mjs:534-546,814-855`).
- Contract values are closed and immutable after registration, but project,
  instance, and bucket-generation values are validated only for shape and
  stored; the supplied pools are not bound to them in PT-1
  (`apps/worker/scripts/postgres-transfer-target.mjs:658-688,701-728,889-929`;
  primary migration `apps/worker/postgres/staged-migrations/primary/0056_production_transfer_control.sql:141-173`).
- Writes outside the private run-control path check the live and abandoned
  state. The run-control bypass is a module-private symbol; run transitions
  lock the row and enforce their own transition checks
  (`apps/worker/scripts/postgres-transfer-target.mjs:755-802,1091-1139`).
- Stage and table receipts reject conflicting repeat completions; checkpoints
  reject changed completed state, and verification requires every cursor to be
  NULL. Abandon clears abandoned cursors in the primary state transaction
  (`apps/worker/scripts/postgres-transfer-target.mjs:1053-1080,1124-1139,1149-1323`).
- Trigger suppression is limited to explicitly named ordinary triggers in a
  caller transaction. A savepoint encloses disable, page work, deferred
  constraint checks, and re-enable; errors roll back to that savepoint and
  check restoration (`apps/worker/scripts/postgres-transfer-target.mjs:1353-1454`).
- The live lock changes the primary run and installs/verifies its statement
  triggers in one transaction per database. A lost ledger step leaves primary
  live and ledger verified; retry rechecks ledger readiness before locking it
  (`apps/worker/scripts/postgres-transfer-target.mjs:2096-2175`).

## Gates outside PT-1

The PT-1 module is not wired into a production importer in this checkout; the
only non-module references found were its check and acceptance tests. Its
complete stage receipts and flip digest are control metadata, not evidence of
source import or exact destination readback. The module documents that PT-8
must establish those source-backed gates before `assertFlipReady` or
`markLive`; the ledger migration separately identifies PT-5b as the source
import/readback proof (`apps/worker/scripts/postgres-transfer-target.mjs:23-27,2068-2077`;
`apps/worker/postgres/staged-migrations/ledger/0007_production_transfer_control.sql:1-11`).

Remaining proof includes the real D1/R2 source fence, exact import and
readback, retry/reconciliation and rollback behavior, object bucket identity
and generation checks, and a caller that binds the pools to the registered
GCP project and instance. The control acceptance spec itself states it runs no
importer and proves no source/readback eligibility
(`apps/worker/postgres-test/postgres-transfer-target.spec.mjs:48-55`).

## Validation

- `node --check` passed for the target module, its check file, and the PG17
  acceptance spec.
- `node --test scripts/postgres-transfer-target.check.mjs` passed all 16
  local checks, including trigger-policy rollback behavior and migration
  contract checks. These checks are local/mocked evidence.
- `node --test postgres-test/postgres-transfer-target.spec.mjs` skipped its
  PG17 database test because `PG_TEST_SOCKET` and `PG_TEST_HOST` were not
  configured. No real PostgreSQL acceptance evidence was obtained in this run.
