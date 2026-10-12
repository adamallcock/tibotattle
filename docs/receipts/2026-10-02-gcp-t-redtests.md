---
title: GCP T-REDTESTS pre-existing red tests
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP T-REDTESTS pre-existing red tests

This is a 2026-10-02 receipt for stream T-REDTESTS on branch
`claude/gcp-fp-t-redtests`, built on `c80f99b9` (`claude/gcp-fastpath-final`).
It records **local, synthetic** evidence only: one macOS arm64 workstation,
Node 22.16.0 (the image runtime) for the Worker and PostgreSQL specs, Node
26.2.0 for repository tooling, and the local PostgreSQL 17 fan-out cluster
(port 55433) over its private Unix socket. Nothing was deployed, migrated or
read in any GCP or Cloudflare project, no `gcloud`, `wrangler` or push ran, and
no secret value was handled.

The stream clears two of the red tests that the cutover checklist (section J)
requires green before any merge to main. Both were **test drift, not product
defects**. No product source changed. Both fixes are test-only and strengthen
the test.

## Summary

| Red test | Root cause | Kind | Fix |
|---|---|---|---|
| `apps/worker/test/storage-graph-history-integration.spec.ts`, "folds mixed v1 and v1.1 evidence once through resumable model and fit graphs" (`effective_owner_pending` where `effective_checkpoint` is expected) | The test drains the analytics projection with a constant 30-step loop. The v1.1 domain window runs from the fixture's first day (2026-09-01) to the real current day, so the drain needs one step per calendar day plus one. The calendar outgrew 30. | Test drift, a calendar time bomb | The bound is derived from the window and the test now asserts the drain settled |
| `apps/worker/postgres-test/typed-v12-normalized.spec.mjs` (`PG_TEST_HOST` profile, `TELEMETRY_REQUIRED`) | Two independent drifts. The fixture's social participant has no `consent_version`, which the typed v1.2 admission has required since 5e33d722. After that, its erasure step deletes ready typed records directly, which the retention guard of migration 0035 forbids. | Test drift, two layers | The fixture carries the current consent. The erasure step uses the product's erasure path and asserts the guard refuses the direct delete |

## (a) storage-graph-history-integration, mixed v1 and v1.1

### Evidence

- Reproduced at the base: `expected 'effective_owner_pending' to be
  'effective_checkpoint'` at the `compute` helper (`:577` before the edit).
- `effective_owner_pending` is returned by `computeEffective` in
  `apps/worker/src/storage-community-graph.ts` when the analytics target has no
  active `analytics_owner_state` row at the source's `authority_epoch`. In the
  failing run the target held the owner at revision 10 and epoch 1 while the
  source held revision 11 and epoch 2: the v1.1 domain activation had not
  reached the target.
- The projection of an activated domain advances one day per
  `advanceStorageAnalytics` call. `createTelemetryV11DomainPredecessor` sets the
  window's end to the later of today (`Date.now()` by default) and every known
  day, so the window here is 2026-09-01 through the real current day. The
  predecessor is also time-bound by the database's own clock
  (`telemetry_v11_current_predecessors` filters on `expires_at > strftime(...'now')`),
  so the test cannot simply pin the clock to the past.
- Measured today (2026-10-02, a 32-day window): the owner-active
  acknowledgement arrives on step 33 and the idle state on step 34. With the
  loop bound set to 32 the case fails with the reported error; with 33 it
  passes. With the bound raised to 300 the whole case passes unchanged, so the
  product path, the graph fold and every later assertion are correct.
- Blame: the test and the product check arrived together in `8c0dd3927`
  (2026-09-21), when a window of at most 21 days fitted a 30-step loop. The bound
  `30` is that commit's. With a 30-step bound the drain covers a window of up to
  29 days, so the case became red on 2026-09-30 UTC. The migration, the reader
  and the graph code did not regress. There is no cap on the window that would
  turn the case red again for another reason
  (`MAX_TELEMETRY_V11_DOMAIN_DAYS` is 4,096).

### Fix

`apps/worker/test/storage-graph-history-integration.spec.ts`: the drain loop is
bounded by `days.length + 8` (the window the test already computes, plus the
acknowledgement, the idle read and slack) and the case asserts that the drain
reached `idle`. Before, a drain that ran out of attempts fell through silently
and surfaced two screens later as an unrelated-looking graph reason. Now it
fails at the cause. No assertion, timeout or privacy check was weakened.

Negative control: with the bound temporarily set to `days.length - 5`, the case
fails on the new assertion (`expected false to be true`). The file was restored
before the commit.

### Not changed, and why

`fixture()` in the same file has a second constant drain (`n < 30`). It runs the
v1-only projection, which has no calendar-sized window, and it passes.

Five sibling Worker specs also drain the analytics projection with constant
bounds (`storage-erasure`, `graph-day-fold-integration`, `graph-day-projection`,
`storage-community-graph-publication`, `cache-retention-day`). They do not share
this time bomb, and the reason is structural. Their passing today (163/163) is
corroboration only: a passing run cannot rule out a calendar-anchored window.

The rule: `createTelemetryV11DomainPredecessor` always puts today in the known
days (`apps/worker/src/telemetry-v11-domain.ts:165`) and activation rejects a
manifest that ends before the predecessor does (`:282`). An activated v1.1
domain therefore always ends at the real current day, so a constant drain bound
stays valid only if the window's start also moves with today (or the clock is
pinned). In the five siblings it does:

- `storage-erasure.spec.ts` builds each fixture day as `today() - n` (`:28`,
  `:38`) and ends the domain at `today()` (`:48`).
- `graph-day-fold-integration.spec.ts` (`:72`), `graph-day-projection.spec.ts`
  (`:752`) and `cache-retention-day.spec.ts` (`:1028`, `:1382`) build a fixed
  count of days back from today and end at today.
- `storage-community-graph-publication.spec.ts` runs from yesterday to today
  (`day()` and `today()`, `:48-49`).

The window length is constant in each. The mixed case in
`storage-graph-history-integration.spec.ts` was different: its v1 evidence starts
at a fixed past date (2026-09-01, `:111`) while the window end follows the
calendar.

A scan of the 34 specs under `apps/worker/test/` that create a predecessor or
activate a domain found one other fixed past start:
`community-daily-device-dedupe.spec.ts` (`DAY = "2026-08-01"` at `:110`, window
to today, about 63 days). It does not share the failure:

- It has no analytics drain. Its one bounded loop,
  `drainCommunityPublicSourceBootstrap` (4 pages of 32 days, in
  `rebuildAndReadDay`), returned `completed` on its first call in each of the 10
  cases that reach it, measured with a temporary probe that was reverted before
  the commit.
- What does grow is the staging cost, one staged day per calendar day. The
  slowest of its 21 cases takes 1.6 s today against the default 5 s test timeout
  (`vitest.config.ts` sets no `testTimeout`). The headroom beyond today was not
  measured. The spec is green, so this stream left it alone; anchoring `DAY`
  relative to today, or bounding the staged window, is a follow-up for whoever
  next touches that spec.

The other 32 specs use single-day windows, which the rule above forces to equal
today, windows that start at a today-relative day, or pass a pinned clock to the
predecessor (`telemetry-v12-transport.spec.ts`). The `postgres-test/` fixtures
that activate a domain were not re-audited for this.

## (b) typed-v12-normalized, `PG_TEST_HOST` profile

### Evidence

- Reproduced at the base with `PG_TEST_HOST` set to the fan-out cluster's
  socket directory: `TELEMETRY_REQUIRED` from `assertWriteAllowed` in
  `apps/worker/src/postgres-typed-v12-admission.ts`, reached from
  `registerPostgresTypedV12DayManifest` in the spec's `admitSyntheticUsageDay`.
- **Layer 1, consent.** For a social owner the admission requires
  `participants.consent_version` to equal `TELEMETRY_CONSENT_VERSION`. The spec
  inserted its participant without one. The check was added in `5e33d722`
  (2026-09-24 19:13), three hours after the spec was written in `c88c0a9c`
  (2026-09-24 16:12). The commit updated the sibling specs that depend on it and
  not this one. The spec is skipped without `PG_TEST_HOST`, so no default run
  noticed.
- **Layer 2, retention.** With layer 1 fixed, the spec reaches its last block and
  fails with `telemetry_v12_ready_source_retained` (SQLSTATE P1005). The block
  marks the participant `deleting` and deletes the ready typed records directly.
  Migration 0035 (`fb9e170f`, 2026-09-25) makes ready v1.2 source immutable: not
  even a `deleting` participant authorizes a direct delete, and only the terminal
  owner-erasure cascade with a same-transaction receipt does. The sibling spec
  `v12-ready-manifest-retention.spec.mjs` asserts exactly that ("deleting state
  alone does not authorize ready source deletion"). The later edit of this spec
  (`fe58fd7a`, 2026-09-25 21:52) came after 0035 and also went unnoticed for the
  same reason.
- The v1.2 reader-batch-cost receipt of this date
  (`2026-10-02-gcp-v12-reader-batch-cost.md`) had already observed both layers
  from a scratch copy; this stream confirmed them independently and fixed them.
- Why it stayed red unseen: the spec is HOST-gated and is on the shrink-only
  `UNREGISTERED_ALLOWLIST` of `apps/worker/scripts/ci-postgres-suite.mjs`, so no
  lane runs it. See "Recommendation".

### Fix

`apps/worker/postgres-test/typed-v12-normalized.spec.mjs`:

1. The fixture participant carries the current `TELEMETRY_CONSENT_VERSION`,
   loaded from `src/constants.ts` through the same Vite module load the sibling
   `v12-transport-roundtrip.spec.mjs` uses, not a copied literal.
2. The erasure block now follows the product's path. It asserts the typed source
   is populated, asserts that the direct delete of a `deleting` participant's
   ready typed records is refused with P1005 and leaves every row in place,
   deletes the participant, and then asserts the
   cascade removed every typed record, usage, quota and session-tool row and
   wrote exactly one erasure receipt. The old final assertions (all four counts
   zero, no `record_json` column) are kept. The `deleting` marker now also
   carries a `deletion_session_id`, as the retention spec does.

No assertion was weakened. The only removed assertion, that a direct delete's
`rowCount` equals the typed record count, asserted behavior the product now
forbids on purpose, and the block asserts the replacement behavior and more.

## Verification

All commands ran in `fp/T-REDTESTS`. Every result is local and synthetic.

| Command | Result |
|---|---|
| `vitest run test/storage-graph-history-integration.spec.ts` (apps/worker, Node 22.16.0) | 13/13 (the mixed case failed at the base) |
| The same case with the bound at `days.length - 5` | fails on the new assertion, as intended (restored) |
| `vitest run` on `storage-erasure`, `graph-day-fold-integration`, `graph-day-projection`, `storage-community-graph-publication`, `cache-retention-day` | 5 files, 163/163 |
| `PG_TEST_HOST=<fan-out socket> PG_TEST_PORT=55433 node --test postgres-test/typed-v12-normalized.spec.mjs` | 1/1 (failed at the base with `TELEMETRY_REQUIRED`) |
| `vitest run test/community-daily-device-dedupe.spec.ts` (apps/worker), unmodified | 21/21, slowest case 1.6 s |
| The same spec with a temporary probe on the bootstrap drain loop | probe only, reverted byte-identical before the commit; the first drain was already `completed` in all 10 cases that reach it |
| `tsc --noEmit` (apps/worker) | exit 0 |
| `node --test scripts/ci-postgres-suite.check.mjs` (apps/worker) | 43/43 |
| `npm run architecture:check` (root) | passed (928 production files, 3,977 imports) |
| `npm run test:preflight` (root) | passed |
| Full Worker `vitest run` (apps/worker, default config, Node 22.16.0) | 178 files, 2,364/2,364, exit 0. It excludes `postgres-test/**`, `analytics-v2-test/**` and `vendor/**` by config |

After the PostgreSQL runs, no `typed_v12_test_*` schema remained in the fan-out
cluster.

## Recommendation, outside this stream's files

`typed-v12-normalized.spec.mjs` is now green but is still registered in no lane
and HOST-gated, which is how it rotted. Registering it is a change to
`apps/worker/package.json` and `scripts/ci-postgres-suite.mjs` (the
`UNREGISTERED_ALLOWLIST` shrinks from ten to nine and its ratchet test count
changes). Those are hosted-CI files that wave 4 (C-CI) owns, so this stream did
not edit them. Until it is registered, the next drift in this spec will again be
invisible.

Still red at the base and untouched here, per the stream brief:
`test/tool-inventory.test.js` (owned by C-SIMP) and the hosted Worker gate
(C-CI). The retired A2 case and R7 regeneration are separate checklist items.

## Claim boundary

This proves the two named cases pass at the named base plus this branch, on this
workstation, on the dates and commands above. It does not prove the Worker or
PostgreSQL suites in general, the hosted CI, any GCP or Cloudflare behavior, or
that the retention guard and the consent gate are correct as product decisions.
Both are taken as the maintained contract. Nothing was merged.
