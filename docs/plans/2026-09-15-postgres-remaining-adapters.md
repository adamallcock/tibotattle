---
title: Complete the remaining PostgreSQL adapter boundaries
date: 2026-09-15
type: plan
status: complete
---

# Complete the remaining PostgreSQL adapter boundaries

User scope: all remaining projection, sync-read and owner-erasure adapter work,
continuing the existing isolated portability worktree. Implement and qualify
local code before considering any cloud resource changes. Production remains D1
until a separately qualified composition is deliberately selected.

## Workstreams and acceptance

- Sync: neutral bounded current-chunk acquisition, shared digest/manifest logic,
  D1 composition and PostgreSQL adapter; preserve 31-day ranges, 100k/10k limits,
  identity and ordering, missing evidence and explicit failures.
- Quota-fit: concrete projection, trigger maintenance, immutable high-water,
  bounded resumable CAS backfill and existing neutral page-reader implementation.
- Remaining v1 write effects: analytical revisions and current-analysis queue,
  daily rebuild queue, prepared-source discard/counters, graph preservation and
  hard invalidation; actual state transitions, not placeholder dirty requests.
- Lifecycle: owner-only admission remains at the existing authorized boundary;
  portable erasure/reconciliation state, durable ledger-before-delete, resumable
  bounded work, and verified object-version cleanup. Never infer purge from a
  live-object 404 or relax restore/retention guarantees.
- Composition: explicit factories and qualification configuration showing how
  the replacement adapters are supplied. Inventory any remaining D1-only auth,
  v1.1, aggregate computation or publication behavior precisely.
- Validation: real PostgreSQL and existing D1 regressions, negative/concurrent/
  rollback paths, portable compilation, architecture and documentation checks,
  complete owning Worker gate. Preserve distinct source, database, object,
  hosted runtime and deployment evidence.

## Delivery record

## Implemented boundaries

- `TelemetryV1Backend` groups contribution writes, replay reads and device sync.
  The Worker composition explicitly selects its D1 factory; the disposable
  PostgreSQL harness selects the PostgreSQL factory with its injected pool.
- Sync state, manifest and admission response construction are shared. Exact
  source ordering, digest construction, limits and negative errors remain
  covered by the existing D1 lane and the new PostgreSQL lane.
- PostgreSQL source writes now update actual analytical revisions, queues,
  prepared-source counters/invalidation, model-history dependencies, graph
  preservation state and preview invalidation. Generic dirty requests have
  been removed. Global graph-epoch serialization is retained deliberately;
  this does not qualify higher write throughput.
- Quota-fit uses physical source columns and a stable record ID, exact
  eligibility, trigger maintenance, immutable high-water and bounded CAS
  backfill. Row locks prevent a concurrent correction from being overwritten
  by stale backfill output. Plan paging handles observation order that differs
  from insertion ID order. The reader is the raw-source protocol; the separate
  prepared-source protocol is not implemented by changing its page size.
- Erasure uses the canonical PostgreSQL primary tables and a separate ledger
  database. The shared workflow checks ledger-before-delete, owner fences,
  bounded ordered object pages, exact enumerated counts and provider-version
  evidence. D1 keeps its existing owner/audit/CSRF and enrollment/identity hooks.
- Participant lifecycle now initializes and invalidates analytical versions,
  drops retained dependency/cache evidence on state changes, and clears
  prepared counters before owner removal. Claiming social deletion advances
  the graph epoch immediately, before external object deletion. Stored
  `observed_day` controls
  prepared-source invalidation, including repair cases with divergent times.

## Validation

- PostgreSQL 17.10: 65 tests pass, including sync/projection/quota and erasure work.
  Explicit local socket configuration passed with hostile ambient PG settings.
- Portable lane: 88 tests pass; focused D1 sync tests: 15 pass.
  Worker and portable TypeScript checks pass.
- After lifecycle hardening, focused D1 erasure/restore and GCS tests pass:
  29 selected tests (93 unrelated tests filtered out); final GCS portable
  coverage includes the malformed-list regression.
- Architecture, documentation and preflight checks pass. The full Worker run
  passed 1,111 tests across 91 files (410.27 seconds), followed by the final
  targeted checks above.
  The initial deployment dry-run stopped at the clean-tree guard. Repeating
  `npm run deploy:dry` on committed implementation `df1fbbd3` passed that guard
  and stopped because the generated public release manifest is absent. No
  deployment or staging qualification is claimed.
  Independent review found and fixed lifecycle withdrawal invalidation and
  unbounded PostgreSQL erasure reads. A real table-lock test verifies the
  configured read timeout; rollback and lost-commit connection tests also pass.

## Delivery

Implementation committed as `df1fbbd3` on `codex/hosted-object-storage-adapter`.
Both disposable database lifecycles were checked: zero qualification databases
remained, and the owned PostgreSQL server was stopped. No cloud writes, push,
merge or deployment were performed.

## Remaining qualification boundaries

PostgreSQL SQL remains a disposable qualification schema, not an operational
migration. No GCP database, runtime, cloud erasure or production switch is
performed here. Full auth/enrollment, account-scoped v1.1, prepared-source
reading, aggregate computation and publication still require provider work.
The PostgreSQL erasure rehearsal repeats the explicit workflow after primary
restore; automatic restore suppression and a startup admission gate remain
unimplemented. Manual child cleanup conservatively produces source-invalidation
epochs before the final root invalidation; it does not assert D1’s exact one-epoch
root-cascade behavior. Both prevent retaining stale graph evidence.

GCS erasure must inspect retained history as well as current generations.
Ordinary version listing does not enumerate soft-deleted objects, and a failed
soft-delete listing cannot establish absence. The candidate must fail closed
when history cannot be verified. See Google's [object listing contract](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/list)
and [soft-delete policy behavior](https://docs.cloud.google.com/storage/docs/use-soft-delete).
This source/mock contract is separate from live-GCS erasure qualification.
