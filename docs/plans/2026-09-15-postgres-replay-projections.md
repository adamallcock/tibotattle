---
title: PostgreSQL replay reads and model-history invalidation
date: 2026-09-15
type: plan
status: focused-qualification-passed
---

# PostgreSQL replay reads and model-history invalidation

Continue the experimental PostgreSQL qualification in the existing portability
worktree. Production remains D1; no GCP resource changes or deployment.

## Acceptance

- Inject a neutral contribution reader for envelope replay, exact current chunk
  identity and acknowledged-through day into the existing v1 handler. Preserve
  D1 route responses and participant/device scoping.
- Implement those reads with a bounded, sanitized PostgreSQL adapter against the
  disposable test schema. Qualify readback after uncertain commit, superseded
  envelope replay, missing rows and isolation. A failed read is never absence.
- Reproduce the actual model-history dependency invalidation and composition-day
  eviction for append/correction, including inclusive 100-day range, owner scope
  and rollback. Keep all other projection/deletion gaps explicit.
- Run focused D1 route tests, portable checks, real PostgreSQL tests, architecture,
  docs/preflight and the owning Worker gate. Stop the temporary server and commit
  reviewed work. Release-artifact and cloud-hosting gates remain separate.

## Preserved replay contract

The D1 reader delegates the existing repository queries. Envelope lookup is
participant-wide and includes superseded revisions; current lookup uses the
complete participant/device/stream/day/sequence identity. Receipt acknowledgement
uses the requesting device, even when an envelope was stored by another device
under that participant. Declared and accepted counts remain separate stored
values. Authentication and a fresh unused upload authorization precede the read
port; a consumed bearer is not made reusable by replay support.

Both providers use the same receipt builder. The PostgreSQL implementation uses
read-only transactions, bounded statement/lock deadlines, parameterized queries,
strict metadata decoding and sanitized errors. Missing rows are distinct from
failed or ambiguous reads. Pool acquisition and transport deadlines remain host
responsibilities; the local test pool explicitly bounds acquisition.

Recovery after an uncertain write now checks the exact retained envelope before
an equal-content current winner. This fixes a source-level race: a later
correction could otherwise hide the committed historical row from current-only
recovery and allow deletion of its retained object. Either lookup failing aborts
recovery before cleanup. This does not implement PostgreSQL object reconciliation
or qualify the complete PostgreSQL HTTP/auth path.

## Projection boundary

The PostgreSQL fixture ports v1 model-history dependency invalidation and cached
composition-day eviction from the insert/update triggers in D1 migration 0059.
The affected range is the source day through source day plus 100 days, inclusive.
Dependencies are participant-scoped; history composition days are community-wide
and evicted only for social sources. Corrections apply supersession and insertion
as two source mutations inside the same transaction.

This is invalidation of a real read model, not recomputation or publication of
model history. The remaining generic dirty requests still do not implement
analysis queues, daily aggregate rebuilding, quota-fit projections, prepared-source
discard, or graph preservation/invalidation. The model-history trigger on direct source-row deletion is qualified; the
owner-erasure workflow and deletion-ledger replay remain unqualified on PostgreSQL.

## Next boundaries

- Port the existing neutral quota-fit page-reader contract and its concrete
  projection, including readiness, high-water bounds and cursor CAS.
- Extract sync-state/manifest reads separately, retaining current-row ordering,
  digest semantics and the 100,000/10,000 scan ceilings.
- Complete authorization issuance/receipt recording, consent, admission reads,
  quarantine reconciliation, legacy/v1.1 blockers and the owner-erasure contract.
- Only then compose a test GCP host/database with explicit identity, pool limits,
  migrations, observability and rollback qualification. Production still uses D1.


## Validation

- Real PostgreSQL 17.10: 37 tests passed in 7.11 seconds, with deliberately
  invalid ambient PG host/database/options and a synthetic ambient password.
  Coverage includes pre-schema refusal, lost-commit readback, historical replay,
  separate stored acceptance counts, requesting-device acknowledgement, gapped
  dates, failed reads, projection boundaries, accountless projection gating,
  metadata-only no-op, current/superseded source deletion and transaction rollback.
- Portable TypeScript and 58 portable tests passed. Focused D1 v1 route tests:
  15 passed. Architecture: 549 production files, 2,158 imports, no debt.
- The test database was removed, a direct catalog check returned no leftover
  test databases, and the disposable server was stopped. No remote resources,
  deployment, migration, or production selection changed.
- During development, a PostgreSQL trigger WHEN expression needed enclosing
  parentheses. Two fixtures also needed correction: a mismatched digest must
  still be well-formed, and SQL row order must be sorted before exact comparison.
  These were corrected without weakening the tested contracts. No flaky test
  was suppressed.
- Implementation committed as `1954c6d0`. `npm run product:worker:check`
  passed generated types, package/endpoint guards, TypeScript, script checks,
  portable checks, GCS smoke/asset checks and all 1,092 Worker tests across 88
  files (483.07 seconds). It then failed at `production:stage-assets` because
  the generated public release manifest is absent from this worktree. The
  complete command did not pass; production/staging dry deployment remains
  unqualified. No artifact was fabricated or deployment performed.
- Documentation governance, preflight and diff whitespace checks passed. This
  record proves the scoped local source/test result, not cloud hosting or release
  qualification.
