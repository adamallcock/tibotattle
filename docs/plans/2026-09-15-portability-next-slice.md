---
title: Hosted portability recovery and transaction slice
date: 2026-09-15
type: plan
status: source-qualified
---

# Hosted portability recovery and transaction slice

Scope: the isolated hosted-object-storage-adapter worktree. No production
migration, deployment, or GCS quarantine support is implied.

## Acceptance

1. Repeatable isolated GCS smoke runs with durable receipts and generation-bound,
   default-dry-run cleanup; infrastructure commands are explicit plans.
2. Recovery tests distinguish a lost response after commit from a failed write,
   preserve consumed nonces, and require read-back before a new signed attempt.
3. Validate settled source through the Worker suite, portable tests, architecture,
   and documentation checks; record any release-artifact gate separately.
4. Commit the reviewed portability slice before beginning the transactional
   contribution boundary. Preserve D1 admission, deduplication, correction,
   quarantine, and authorization semantics; assess PostgreSQL proof explicitly.

## Progress and remaining gates

- Portability and repeatable GCS lane committed as `a135579d`; 1,055 Worker
  tests, 21 portable tests and two isolated live GCS runs passed.
- The v1 transaction extraction is wired through the Worker composition root;
  its neutral port compiles without Cloudflare ambient types. Existing D1 SQL,
  bindings and error mapping are preserved.
- Focused transaction regressions passed 72 tests across four files, covering
  graph preservation, corrections, rollback and domain isolation. The extracted
  SQL and bind sequences were mechanically compared to the committed source.
  Worker and portable typechecks passed.
- Transaction extraction committed as `cbc24452`. On that runtime source,
  `npm run product:worker:check` passed workspace-package guards, endpoint checks,
  generated types, TypeScript, scripts, portable compilation, 21 portable tests,
  14 smoke/cleanup tests, four asset-plan tests, and all 1,055 Worker tests across
  85 files (352.57 seconds).
- The combined command exited at `production:stage-assets` with “Generated
  public release manifest is missing or cannot be inspected.” No release-site
  artifact was supplied in this worktree, so production/staging dry deployment
  remains unqualified. The separate GCS test dry bundle passed (59.83 KiB).
- Architecture checks passed at 545 production files / 2,146 imports / no debt;
  documentation and preflight checks passed. No source push or deployment was
  performed.
- PostgreSQL parity and a hosted GCP runtime remain separate qualification work.

## Transaction boundary decision

The next port represents the complete v1 chunk insertion transaction. It accepts
provider-neutral object keys and a predecessor ID; D1 owns SQL and trigger error
translation. Keep the existing repository wrapper for existing callers while
injecting the port at the Worker composition boundary. Preserve the graph-scope
marker's optional behavior: an absent marker intentionally falls back to hard
graph invalidation and is not an admission failure.

Do not change upload admission, record ownership, correction, trigger side
effects or pending-object reconciliation as part of the extraction. Existing
predecessor validation remains in the handler. A stronger adapter-level
predecessor compare-and-swap is a separate behavioral change requiring its own
regression proof.

PostgreSQL was not available at the local inspection: PostgreSQL binaries and
client dependency were absent, and the installed Docker client could not reach
its Colima daemon. A faithful proof needs real transactions, constraints and
concurrent clients; mocks do not qualify PostgreSQL behavior.

## Next executable qualification

Provide a disposable local PostgreSQL runtime and implement this one operation
against real transactions. Before considering a GCP-hosted contribution service,
prove append, replay, correction, record-ownership rollback, expired authorization,
concurrent admission, projection invalidation and lost-response recovery. Preserve
the current five-minute authorization lease and one-hour quarantine reconciliation
separation; do not infer erasure guarantees from a live-object 404.

This completes the scoped source extraction and repeatable release-object lane.
PostgreSQL, a refreshable deployed identity, runtime hosting and GCS quarantine
remain explicit future work rather than claims implied by these adapters.
