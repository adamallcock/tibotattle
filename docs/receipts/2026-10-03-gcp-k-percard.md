---
title: GCP engine v2 per-card price staleness (K-PERCARD)
date: 2026-10-03
type: receipt
status: snapshot
---

# GCP engine v2 per-card price staleness (K-PERCARD)

This is a 2026-10-03 receipt for stream K-PERCARD on branch
`claude/gcp-fp-k-percard`, built on `claude/gcp-fastpath-final` at
`c2726984` (kernel 2 registered by K-VENDOR2). It implements engine v2
design section 5 (`design/engine-v2-design-2026-10-02.md` in the parity
home) under owner decision round 13 ("before cutover, build only the parts
that shape stored data"). It records **local, synthetic** evidence only: one
macOS arm64 workstation shared with other agents, and the local PostgreSQL 17
fan-out cluster (private Unix socket, port 55433), in databases
`kpercard_a7f3`, `kpercard_base1` and `kpercard_dom1`, dropped afterwards.
Nothing ran in the cloud; no migration was applied anywhere but those
databases.

## What is built

- **Migration, staged** as
  `apps/worker/postgres/staged-migrations/primary/0912_analytics_v2_price_cards.sql`
  (a placeholder number; specs find it by its name suffix). Additive: seven
  tables, no change to an existing table or row. It fails on a schema without
  the run stamps (primary 0069), creating nothing.
  - `analytics_v2_kernel_prices`: per kernel, its compute class
    (`compute_sha256`, NULL when unknown), its card-set digest and count, and
    the price-input projection version.
  - `analytics_v2_price_cards` (`card_ref` integer; a card is its id plus the
    sha256 of its canonical JSON, so a changed card is a new ref) and
    `analytics_v2_kernel_cards`.
  - `analytics_v2_price_bases`: deduplicated, sorted card-ref sets with an
    environment-independent digest (ids and contents).
  - `analytics_v2_owner_day_price`: one row per owner-day row with daily
    values (same run and kernel, enforced by a trigger; the owner-day delete
    cascades): its basis, its usage, unpriced and partially priced event
    counts, and its **price inputs** (each event's projection onto exactly what
    `buildPricingEvent` reads, with this kernel's result: cost as the daily
    fold counts it, status, selected cards), canonical JSON, deflated, with
    the sha256 of the canonical text. This is the per-event capture the
    wave-5 critic called K-PRICEIN, folded into the side table.
  - `analytics_v2_kernel_transitions` and `analytics_v2_transition_stale`.
  - Every table but the price rows refuses UPDATE, DELETE and TRUNCATE.
- **The prepared-day observer** (`src/analytics-v2/price-attribution.ts`,
  called from `compute-owner.ts` for every stored owner-day with daily
  values): prices each usage event through the vendored `buildPricingEvent`
  and `priceTelemetryUsageEvent`, and **fails the run**
  (`ANALYTICS_V2_PRICE_ATTRIBUTION_MISMATCH`) unless the per-cell, omitted
  and total pricing blocks and the usage count equal the kernel's own daily
  values. It prices the stored projection, not the record, so the projection's
  sufficiency is proven on every run. Names outside the wire grammar fail the
  run (`ANALYTICS_V2_PRICE_INPUT_UNREPRESENTABLE`) rather than being dropped.
- **Kernel transitions** (`src/analytics-v2/price-transition.ts`, a new closure
  root; `src/analytics-v2/store-price.ts`): the Job proves, in its read
  snapshot, one transition per older kernel still stamping owner-days: the
  card diff, the compatibility claim (both compute classes known and equal),
  the proof (every stored event the older kernel fully priced with unchanged
  cards reprices identically under this bundle) and the stale owner-days
  (cause 1 removed or changed card, 2 repriced, 3 price unknown). The write
  transaction re-reads the pending transitions and refuses a proof that no
  longer matches (`ANALYTICS_V2_PRICE_TRANSITION_STALE`); corrupt stored
  inputs fail the run (`ANALYTICS_V2_PRICE_INPUTS_CORRUPT`). A transition is
  recorded once.
- **The compute class** (`compute_sha256`): the compute closure without the
  vendored `packages/accounting/src/price-registry.js`, computed by
  `cloud-run/analytics-kernel-closure.mjs` and stamped through a third
  esbuild define. It is not a registry key (the closure digest pins it); the
  store records it per kernel and refuses a kernel that states another one
  (`ANALYTICS_V2_KERNEL_PRICES_CONFLICT`). Kernels 1 and 2 never recorded one,
  so a transition from them is never compatible.
- **Derived-regime dirtiness** for the later incremental planner:
  `analyticsV2PriceDirtyOwnerDays` (unattributed, unproven, incompatible or
  stale rows) with the store reader `readAnalyticsV2PriceDirtyOwnerDays`, and
  `analyticsV2WindowPriceBasisSha256` for window memo keys.
- **Kernel 3** appended to `kernel-registry.json` (closure `54f0f84f...`,
  162 inputs; compute class `a94b1a0d...`; vendor manifest and price registry
  unchanged). Contract `analytics-v2-contract-v0.6` (the `ownerDayPrices`
  output and the seven tables).

Design pre-build check (section 5.3): in the stored Q-1 and dense oracle
owner results, the price registry identity appears only in daily values
(`registrySha256`), never in fits or model-date results.

## Evidence

| Gate | Result |
|---|---|
| `npx tsc --noEmit` (apps/worker) | rc 0 |
| `analytics-v2:check`, Node 22.16.0 | 19 files, 207/207 |
| `analytics-v2-refresh.spec.mjs` (with dist) | 51/51 |
| `analytics-v2-price-cards.spec.mjs` (new) | 6/6 |
| kernel-registry check | 6/6 (adds the compute-class mutation case) |
| `gcp:fastpath:scripts-check` | 91/91 |
| `postgres:migrations:check` | rc 0 |
| `append-only:absence:check`, `v0x:admission:check`, `postgres:retired-readers:check` | 19/19, 25/25, 4/4 |
| numbering, ci-postgres-suite and hosted-backend workflow checks | 71/71; `--plan` failures [] |
| `postgres:domain:check` (`kpercard_dom1`) | vitest 101 pass, 1 skip; node 448/453. Two failures were this branch's new staged-runtime assertion (fixed; rerun 3/3); two were `postgres-transfer-target.spec.mjs` `CUTOVER_FLIP_ROLE_MEMBERS_UNEXPECTED` (cluster-wide role members while other agents shared the cluster): 18/18 on rerun here and at the base line |
| cloud-run `npm run check` | rc 0 (415 pass, 4 skip) |
| `scripts:check`, `gcp:production-tooling:local-check` | 1,110/1,110, 532/532 |

**Q-1 rehearsal** (`npm run gcp:fastpath:rehearsal -- --staged-primary
0912_analytics_v2_price_cards.sql`): `status: pass`, every gate true,
parity 0 unexpected families and diffs, per-date equal. Run back to back
against the base line (`c2726984`, a `git archive` copy, kernel 2):

- the served `/api/v1/community/daily` body and the preview are
  **byte-identical**;
- every stored `owner_day`, `cache_bands`, `owner_fits`,
  `owner_model_dates`, `published_daily`, preview and cursor row is equal
  (run ids, kernel stamps and timestamps excluded), and the run rows'
  publication and refusals are equal;
- 678 price rows for the 678 owner-days with daily values; 9,315 events,
  419,214 bytes of deflated inputs (about 45 bytes per event); 178 cards,
  67 bases;
- refresh 16.9 s (base) against 17.7 s; prepare 4.17 s against 4.83 s
  (about +15%); output account 11 MiB against 13 MiB. Shared workstation,
  single runs: indicative only.
- **Transition on real-shaped data**: the base line's kept kernel-2 schema,
  with the staged migration applied, refreshed by this branch's dist
  (`--reuse-schema`): all gates pass; one transition 2 to 3 recorded,
  incompatible (no compute class for kernel 2), 680 owner-days, 678 stale
  with cause 3 (the two refused owner-days have no price); every owner-day
  then stamps kernel 3.

## Open items

- The integrator assigns the primary number and adds the
  `CONTRACT_MIGRATIONS` review only if the promoted file classifies as a
  contract migration (it holds no DROP).
- Kernel 3 is appended here; a parallel branch that also changes the closure
  (for example E-OWNERSET) will need its own entry after this one at merge.
- The output account and prepare phase grow with the stored inputs (about
  +15% prepare on Q-1); measure on the dense corpus before the production
  task profile is fixed (MEAS-3, K-MEAS-INCR).
- `analytics_v2_transition_stale` is append-only and holds owner digests;
  the offline purge (OA-9) decides how an erased owner's rows leave it.
