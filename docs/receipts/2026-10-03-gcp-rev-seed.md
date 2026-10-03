---
title: GCP REV-SEED per-day revision floor
date: 2026-10-03
type: receipt
status: snapshot
---

# GCP REV-SEED per-day revision floor

This is a 2026-10-03 receipt for item REV-SEED on branch
`claude/gcp-fp-rev-seed`, cut from the fast-path final line at `c2726984`. It
records **local, synthetic** evidence only: one macOS arm64 workstation, Node
26.2.0 (Node 22.16.0 for the rehearsal's refresh and origin) and the local
PostgreSQL 17 fan-out cluster, on uniquely named databases dropped afterwards.
No `gcloud`, `wrangler`, deploy, push or remote read ran; no production data
was read. Nothing is merged, and the migration is staged, not promoted.

## The decision it implements

Owner decisions of 2026-10-02: round 12 ("SEED revisions", no "revision
restart" disclosure) and round 14 (a **per-day** floor, the **current analytics
D1 lineage only**, loaded **inside the E-PT8 import** as the
`analytics-community-history` stage before markLive, the production refresh
refusing `ANALYTICS_V2_REVISION_FLOOR_ABSENT` without one, the capture one
read-only bookmark-bracketed SELECT after EP-8 verify, and a **synthetic floor
at the dress rehearsal**).

## What was built

| Item | Where |
|---|---|
| Staged migration (placeholder `0951`): `analytics_v2_revision_floor` (day PK, revision 1..2,000,000,000), `analytics_v2_revision_floor_source` (singleton provenance: `captured` or `synthetic`, seal id, floor sha256, fence receipt sha256, bookmark sha256, source commit, day count, largest revision), immutability (update, delete, truncate), day rows before the singleton (which must summarize them), a refusal on any insert once a day is published (behind a SHARE lock on the published heads), and a **separate** trigger refusing any published head at or below its day's floor | `apps/worker/postgres/staged-migrations/primary/0951_analytics_v2_revision_floor.sql` |
| `nextPublishedRevision` = max(head, floor, seed) + 1, the one assignment point; the store reads the candidate days' floor in the write transaction | `apps/worker/src/analytics-v2/store-publication.ts` (re-exported by `store.ts`) |
| The floor's table names, columns and keys, in the store's plumbing | `apps/worker/src/analytics-v2/store-run.ts` `ANALYTICS_V2_REVISION_FLOOR_*` |
| Refresh state gains `revisionFloor` {present, dayCount, maxRevision}; a production target refuses `ANALYTICS_V2_REVISION_FLOOR_ABSENT` in the read snapshot before any read or compute, writing nothing; staging and test treat an absent floor as 0; the receipt carries `revisionFloor` | `store-run.ts` `readAnalyticsV2RefreshState`, `apps/worker/cloud-run/analytics-refresh.mjs` |
| The non-sealable read role `analytics-floor`, which the guarded transport (and the Wrangler transport) admit for exactly one statement pinned by sha256 (`CUTOVER_FLOOR_STATEMENT_REFUSED` otherwise) | `apps/worker/scripts/cutover-source-seal.mjs` |
| `capture` (bookmark B0 equal to the fence pin, the pinned SELECT, B1 equal to B0, `revision-floor.json` 0400), `synthetic` (the dress rehearsal), `check` (offline), the closed file format, the seal binding, the C-IPR cross-check (`REVISION_FLOOR_BELOW_FROZEN_EXPORT`) and `loadRevisionFloorInTransaction` | `apps/worker/scripts/cutover-revision-floor.mjs` |
| E-PT8: `analytics-community-history` is a runner stage (its waiver removed), `pt8-inputs.json` gains `revisionFloor` {path, sha256}, preflight P16, P10 requires the floor tables (`CUTOVER_TARGET_REVISION_FLOOR_TABLE_MISSING`) | `apps/worker/scripts/postgres-production-transfer.mjs`, `postgres-transfer-coverage.mjs` |
| Q-1 rehearsal variant `--synthetic-revision-floor` and its gate `revisionFloorRespected` | `apps/worker/scripts/gcp-fastpath-rehearsal.mjs` |
| Runbook: H.3 step 7 (capture), H.4 steps 1 and 2 and the orchestrator reference (P16, the stage, the inputs key, the refusals), H.8 step 1 and the "revisions restart" paragraph, the refusal and gap tables | `docs/runbooks/gcp-cutover-window.md` |
| The fast-path plan's "published revisions restart" bullet | `docs/plans/2026-10-01-gcp-fastpath.md` |

## Deviations from the wave-15 design, and why

- **The floor tables are not in `contract.ts` `ANALYTICS_V2_TABLES`.**
  `contract.ts` is in the kernel compute closure
  (`cloud-run/analytics-kernel-closure.mjs`); adding two names changed the
  closure digest, and `cloud-run/build.mjs` refused the build
  (`CLOUD_RUN_BUILD_KERNEL_UNREGISTERED`). A revision floor decides no kernel
  value, so the names live in `store-run.ts`, which is plumbing. With that, the
  build still stamps the registered kernel 2 (closure `de143e6a…`). The stale
  comment in `contract.ts` ("revision = max(previous, revisionSeed) + 1") is
  left for the next registered closure change for the same reason.
- **No table receipt for the floor.** The analytics D1 is never sealed, and
  coverage finalize refuses a table receipt for a table outside the reviewed
  dispositions (`CUTOVER_COVERAGE_RECEIPT_UNEXPECTED`). The stage writes only
  its stage receipt (row count = days; the digest covers the floor's identity
  and the frozen days it covers).
- **The capture is its own script** (`cutover-revision-floor.mjs capture`), not
  a `cutover-source-seal.mjs` subcommand: it needs the analytics source file
  and the fence's analytics entry, which the admin history export already
  reads (`fencedAnalyticsEntry` is now exported for it). The read role and the
  pinned statement live in the seal module's guarded transport.
- **`verify-unchanged` does not re-read the analytics bookmark** (design step
  4, last bullet). It is not built here; B0 must equal the fence receipt's
  analytics bookmark, so a write between the fence and the capture is refused.
  A Cloudflare publication after the capture is excluded only by the fence
  staying quiet. Listed under open items.
- **`postgres-runtime-schema.ts` is not regenerated**: it is generated from
  promoted migrations, so the integrator regenerates it when `0951` is
  promoted.

## Evidence (local, synthetic)

| Gate | Result |
|---|---|
| `node --test postgres-test/analytics-v2-revision-floor.spec.mjs` (PG17): additive, search paths pinned, immutability, order and summary, after-publication refusal, below-floor refusal (insert and update, with 0059's trigger disabled), loader idempotence and conflicts, the lock race | 6/6 |
| `analytics-v2-refresh.spec.mjs` (PG17), incl. floor r5 continues at r6, a day without one at r1, a rerun mints nothing, byte-identical twins, floor and seed combine, production FLOOR_ABSENT with no run row and no write, then published above the floor | all pass (with the interim read and community daily route specs: 88/88) |
| `vitest --config vitest.postgres.config.ts`: E-PT8 (synthetic floor loaded once across every kill and resume, P16 negatives), identity authority, legacy contributions, seal rehearsal, telemetry modes | 47/47 |
| `node --test scripts/cutover-revision-floor.check.mjs`: pinned role, dry run, capture (max over every source id, withheld and retired days, the queue counter not read), drift, closed rows, sealed or unfenced D1, default Wrangler transport, file format, binding, cross-check, synthetic floor, CLI | 10/10 |
| `npm run postgres:cutover-seal:check` | 139/139 |
| `vitest --config vitest.analytics-v2.config.mjs` (incl. the new `publication-revision.spec.ts` ratchet) | 192/192 |
| `npm run scripts:check`, `npm run typecheck`, `cloud-run/build.mjs` and `--check`, `cloud-run-build-context.mjs --check` | pass |
| Q-1 rehearsal at `c2726984` (no floor code), at this branch with `0951` staged (no floor), and with `--synthetic-revision-floor` | all `pass`; base and branch: every `analytics_v2` family **byte-identical** (published daily, preview, owner day, cache bands, owner fits, model dates, cursor; run ids excluded). Floor variant: 144 floored days, each published at floor + 1, 24 at r1, second run 0 new revisions, parity 0 unexpected; every family identical to base except the published revision fields |
| Root `npm run test:preflight`, `npm run architecture:check` | pass |

## Open items

- The integrator promotes `0951` to the next free primary number (and
  regenerates `src/postgres-runtime-schema.ts`); specs and the W2 fixture find
  it by suffix.
- `verify-unchanged` re-reading the analytics bookmark (design step 4) is not
  built.
- The fallback load CLI after markLive (design step 5, only if E-PT8 slipped) is
  not built; E-PT8 is built, so it is not needed.
- The capture has never contacted the provider; real D1 response shapes for
  the pinned statement are unverified.
- Not covered: the pre-2026-09-12 legacy daily lineage (round 14 excludes it).
