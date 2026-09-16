---
title: Hosted portability recovery and transaction slice
date: 2026-09-15
type: plan
status: in-progress
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

## Remaining gates

- Integrate repeatability, infrastructure plans, and failure tests.
- Run uninterrupted validation and review the complete diff.
- Extract the smallest coherent transaction operation after source investigation.
- PostgreSQL parity and a hosted GCP runtime require separate evidence.

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
