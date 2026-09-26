---
title: Admin metrics history contract rows
date: 2026-09-25
type: plan
status: ready-for-review
---

# Admin metrics history contract rows

## Boundary

This source change covers the typed owner growth-history publication behind
`GET /api/v1/admin/metrics/history`. It adds analytics migration 0027 and
changes only the typed writer and reader. It does not apply migrations, deploy
either Worker, change the payload shape, validation or contract version, or
alter the JSON-layout path, whose reader and writer ship in one Worker.

## Live observation

Read-only production evidence, 2026-09-25 to 2026-09-26 UTC. Remote reads were
limited to schema, counts, timestamps and the payload `schemaVersion`.

- The main Worker deployed on 2026-09-23 from `50381239`, whose payload contract
  is `admin-metrics-history-v0.2`, returned 200 for the route at
  2026-09-25T22:51Z.
- Both analytics scheduler Workers were deployed from `fd50d4ba` at
  2026-09-25T23:56Z. That source includes `16cb8222`, which advanced the
  contract to `v0.3`.
- The same main Worker version then returned
  `503 ADMIN_METRICS_HISTORY_CACHE_UNAVAILABLE` on all nine admin loads in a
  tail from 2026-09-26T00:07Z to 01:07Z. The other admin reads returned 200.
- The analytics role had migration 0016 applied and 278 gauge snapshots since
  2026-09-15T03:16Z. Its one source-keyed history row carried `v0.3`, generated
  at 2026-09-26T00:52:17Z. That is the 55-minute refresh after a first `v0.3`
  write, which is inferred at about 2026-09-25T23:57Z.
- The main Worker was redeployed from `5218c3bb` (`v0.3`) at
  2026-09-26T01:12:40Z. The reader and the stored row now agree. No admin load
  has yet confirmed a 200.

## Cause

Typed storage moved the only writer of the history row into the analytics
scheduler, while the reader stayed in the main Worker. The reader accepts
exactly its own payload contract, the writer rebuilds any row that carries
another, and they shared one row per source. `16cb8222` advanced the contract
so that `v0.2` totals, which omit v1.2 uploads, are refused and refreshed at
the next scheduled pass. That holds only when reader and writer deploy together.

Deployed scheduler-first, the new writer replaced the `v0.2` row on its first
pass. The old reader then had no row it accepted until the main Worker caught
up about 76 minutes later, after a failed first attempt. A main-first order
fails the same way, because the new reader refuses `v0.2` until the new writer
runs. The 503 was the reader's correct fail-closed response to a state that the
storage design should not create, so it is a defect rather than intended
unavailability.

## Change

- Analytics migration 0027 adds `analytics_admin_metrics_history_publications`,
  keyed by source and `schema_version`. CHECK constraints bind the key and
  `generated_at` to the payload. The foreign key admits only registered sources.
- The typed writer reads and upserts only its own contract's row. It never
  writes another contract's row or the 0016 row.
- The typed reader serves its own contract's row. The 0016 row is a fallback
  that validation accepts only when it carries the same contract, so either
  Worker may deploy first once the migration exists.
- `v0.2` totals remain refused. Superseded contract rows are retained, one row
  of at most 512 KiB for each contract ever published.

## Validation

Local only, on this uncommitted checkout. The new regression test failed on the
unchanged source, because the upgraded writer replaced the older contract's row.
With the change, these pass: the complete Worker Vitest suite (158 files, 1,988
tests), TypeScript, generated Worker types, and the Worker script checks (937
tests). The script checks include the typed-preflight migration-count ratchet,
now 27 analytics migrations. The documentation checks also pass. The added tests
cover refusal of `v0.2` in both tables, retention of other contracts' rows, the
same-contract fallback, and the table constraints. `deploy:dry` and
`staging:check` were not run, because asset staging requires a clean, committed
tree.

## Rollout

Every step is owner-run and needs explicit authorization.

1. Merge this change before applying the migration. The typed deployment
   wrapper requires the live analytics schema to match the deploying source's
   migrations exactly. It refuses this source until 0027 exists, and afterwards
   it refuses any main Worker source that lacks 0027.
2. Apply analytics `0027` to the production analytics role as a forward schema
   change. It is additive, and the running Workers ignore the new table.
3. Deploy the analytics scheduler Worker and the main Worker, in either order.
   A scheduler deployed before the migration stops refreshing the history, and
   the frozen 0016 row stays served until 0027 exists.
4. Load the admin console once and confirm a 200. Read back only
   `schema_version` and `generated_at` from the new table.

## Remaining gates

- The migration, both deployments and the live confirmation above.
- The typed scheduler discards its snapshot and refresh outcome codes. A failing
  writer is therefore visible only as an ageing `generated_at`.
