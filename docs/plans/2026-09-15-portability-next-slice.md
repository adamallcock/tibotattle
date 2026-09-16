---
title: Hosted portability recovery and transaction slice
date: 2026-09-15
type: plan
status: implementation-complete-validation-pending
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
- The complete final Worker gate is running; keep release-site artifact
  requirements explicit before claiming that gate passed.
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
