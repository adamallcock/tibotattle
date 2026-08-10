# Design note: composition-aware expected line, saturation guard, lineage speed carry-forward

**Status:** proposed (expected-line changes pending sign-off; lineage speed
carry-forward approved). **Author:** cost-deviation deep-dive follow-up,
2026-08-10. **Evidence:** `docs/investigations/redteam-cost-deviation-prompt.md`
+ 8-agent workflow over the live unified index; memory
`cost-deviation-is-mix-misspecification-not-capacity`.

## 1. Problem

The dashboard's "expected vs actual" / deviation surface books large drifts
(e.g. Jul 29–30 −40.6pp over, Jul 24 +21.2pp under). An adversarial deep-dive
refuted the "provider capacity swing" reading and located the cause **in our own
expected line, not in the actuals** (token accounting is sound — subagents,
forks, tiers all counted).

**Root conceptual error.** The weekly quota `used_percent` (pp) is consumed by
**tokens weighted by a per-model quota-credit rate**; dollar cost is **tokens
weighted by a per-model price**. Their ratio — dollars per pp — is therefore
**model-specific**, not a constant. The expected line uses ONE blended constant:

```
src/simple-quota-gradient.js:205
  const expectedChange = cost * 100 / capacityUsd;   // capacityUsd = one global median
```

Implied capacity across 12 historical windows correlates **r=+0.87 with sol
cost-share** and **−0.88 with terra share**: sol≥80% windows imply ~$2,292/100pp,
terra≥80% ~$799, against the $1,856 blend. So **sol-heavy ⇒ reads over-cost,
terra/high-cache ⇒ reads under-cost**, purely from mix. Killer control: the 07-31
window is entirely *after* the 2026-07-30 repricing yet over-costs identically to
Jul 29–30 — the drift is mix, not price or time.

**Secondary artifact — 100% saturation.** `monotonicUsed = Math.max(...)`
([:169](src/simple-quota-gradient.js:169), [:293](src/simple-quota-gradient.js:293),
[:340](src/simple-quota-gradient.js:340)) caps observed at 100. Once the weekly
pool pegs, observed pp can't rise but cost keeps accruing, so `expectedChange`
keeps rising and the residual books it all as over-cost. In Jul 29–30 this tail
is **−14pp / $263 = 46% of the window**.

**Tertiary, narrow — Fast priced as Standard.** 55.6% of turns are unknown-speed
(priced Standard). Inert in Jul 24/29–30 (no reachable Fast), but the one
Fast-heavy window (2026-07-13, 37% Fast) reads +30pp under. Tie-in to the speed
question: we carry tier forward only *within one rollout file* (`tierAt`,
[log-parser.js:399](src/providers/codex/log-parser.js:399)); turns with no
declaration earlier in their own file fall back to `unobserved`.

## 2. Change 1 — composition-aware expected line

**Precedent already in the tree.** `analyzeFastDiagnostic` already emits
alternative expected series by tier — "Expected if all Standard" and "Expected
with captured Fast Nx" ([:401–402](src/simple-quota-gradient.js:401)) — using a
per-segment implied capacity and a tier-weighted cost. The composition-aware line
is the same idea generalized from *tier* to *model*.

**Calibration (the real work).** Replace the single
`descriptiveCapacityUsd` with a **per-model capacity vector** `capacity_model`.
Because the provider's per-model quota-credit weighting is not in the index, it
must be **calibrated empirically, not derived from prices**:

- Fit `pp_consumed(interval) ≈ Σ_model cost_model(interval) / capacity_model`
  via a non-negative least-squares regression over the full calibration corpus
  (intervals are already produced as `snapshotIntervals` with per-mode costs —
  see `summarizeIntervalSegment`, [:290](src/simple-quota-gradient.js:290), which
  already splits `costs.{fast,standard,unknown}` and could split by model_id).
- Keep the existing per-interval implied-capacity diagnostic for display, but the
  **expected line consumes the per-model vector**: for each rolling bucket,
  `expectedChange = Σ_model bucket.cost_model * 100 / capacity_model`.
- Report a blended headline capacity for the calibration card (cost-weighted mean
  of `capacity_model` over the recent mix) so the "$X per point" copy still has a
  single honest number, with per-model detail available.

**Touch points.** `buildRollingHours` ([:156](src/simple-quota-gradient.js:156))
gains per-model cost buckets and takes a `capacityByModel` map instead of a scalar;
`buildRollingResidual` unchanged; the diagnostic capacity computation adds the
regression; `apps/web/public/app.js` `liveTimelinePoints` (residual/cumulative)
and `lib.js` `detectDeviationPeriods` consume the new expected without shape
changes. UI: the calibration-rate card ([app.js:1506](apps/web/public/app.js:1506))
shows blended + optional per-model breakdown.

**Effect.** Collapses the mix-driven residual toward zero across all 12 windows;
the deviation panel then surfaces only *genuine* anomalies. Any residual
"capacity" hypothesis can only be tested *after* this — the constant line cannot.

## 3. Change 2 — saturation guard

When a rolling bucket's `startUsedPercent` is already at the ceiling (weekly pool
== 100), **suspend residual accumulation** for that bucket instead of booking
cost as negative drift — mirroring how stale/among-reset brackets are excluded.
Emit the expected series as `null` (or a distinct "pool saturated" state) so the
cumulative residual and signed-AUC ([lib.js:505](apps/web/public/lib.js:505)) do
not integrate post-peg cost.

- Detect peg at bucket construction in `buildRollingHours`
  ([:190–199](src/simple-quota-gradient.js:190)); carry a `saturated` flag.
- Also treat a `used_percent` **decrease** (reset) as a hard segment boundary so
  the monotone `Math.max` cannot smear a reset into a permanent 100 ceiling.
- UI: render saturated spans as a shaded "allowance exhausted" band, not a
  deviation — this is honest ("you hit 100%, we can't infer capacity here")
  rather than a false over-cost.

**Effect.** Removes the ~46% saturation inflation from the over-cost tails
(Jul 29–30, 07-31, 08-08).

## 4. Change 3 — session-lineage speed carry-forward (approved)

**Today.** Tier is carried forward only *within a single rollout file*
(`collectTierTimeline`/`tierAt`, per-rollout), plus across a session's own
**resumed** segments via the ingest seed
(`seedTier: resuming ? carriedTier(cursor) : null`,
[ingest:430](src/local-unified-index-ingest.js:430)). A **fork child** or a new
lineage segment does **not** inherit its ancestor's last observed tier, so its
pre-declaration turns fall back to `unobserved` → priced Standard.

**Proposed.** Seed a fork/lineage rollout's initial tier from the **most-recent
observed tier of its ancestor lineage**, reusing machinery that already exists
for snapshot inheritance:

- `ancestorSessionLocalsFor(info)` already yields the fork ancestor chain
  ([ingest:401](src/local-unified-index-ingest.js:401)); `finalBySessionId`
  ([ingest:438](src/local-unified-index-ingest.js:438)) already records each
  session's final derived state.
- Extend the seed: when `info.lineage.isFork` (or an ancestor chain exists) and
  the rollout has no `thread_settings_applied` before a turn, seed `seedTier`
  from the ancestor lineage's last observed tier (analogous to how
  `inheritedSnapshots` consults ancestors).

**Safety.** Strictly **lineage-scoped** — a session's own resume segments + its
fork/parent chain only. Never global across concurrent, unrelated threads, which
is the failure mode the `codex-service-tier-not-a-baseline-source` memory warns
about (per-thread `service_tier`; 62% mislabel risk). Unknown stays unknown when
no reachable ancestor declaration exists.

**Effect.** Fills unknown-speed turns that have a real upstream declaration; only
changes pricing where a reachable Fast exists. Fixes 07-13-type Fast windows;
`$0/0pp` change to Jul 24/29–30 (confirmed by the deep-dive's lineage simulation).

## 5. Test plan

- **Composition-aware:** unit tests on the NNLS calibration (synthetic corpus
  with known per-model capacities recovers them); `buildRollingHours` expected
  series equals Σ per-model for a mixed bucket; a sol-pure and a terra-pure bucket
  price at their own capacities; blended headline = cost-weighted mean. Golden
  fixtures for Jul 24 and Jul 29–30 assert residual collapses vs. today.
- **Saturation guard:** a bucket at 100 start emits null expected; a reset
  (100→0) starts a fresh segment; signed-AUC excludes saturated spans; UI band
  renders.
- **Lineage speed:** a fork child with an ancestor Fast declaration and no own
  `thread_settings_applied` prices Fast; two concurrent unrelated threads never
  cross-contaminate; a session with no reachable declaration stays unobserved.
- **Regression sweep:** re-run the 12-window enumeration after all three; expect
  every window's |residual| to drop, with any survivor flagged as a *real*
  candidate.

## 6. Effort, risk, and v0.1.0 recommendation

- Composition-aware line: **medium** (the calibration regression is the crux;
  the plumbing is a scalar→map change with existing per-tier precedent). Highest
  correctness value.
- Saturation guard: **small**, self-contained, high clarity.
- Lineage speed: **small–medium**, reuses ancestor machinery; well-contained.

**Recommendation:** the current deviation surface actively mislabels model-mix as
"deviation," which conflicts with the product's honest-estimator ethos. If
v0.1.0 ships the deviation panel prominently, do at least the **saturation guard
+ composition-aware line** first (they are the difference between an honest and a
misleading surface). If the panel is secondary, ship v0.1.0 and land all three
immediately after, documenting the limitation in the runbook. The lineage speed
fix is independent and can ride either train.

## Addendum (2026-08-10): three live-index discoveries that reshape changes 1–2

1. **The constant was once real.** gpt-5.5-pure June weeks imply $2,231 / $2,194 /
   $2,186 per 100pp (±1%) — a true constant. Per-model divergence began with the
   5.6 family (fitted at 2h grain: sol=$2,342, terra=$1,129, luna/other=$696;
   R² 0.842 vs 0.808 for the single constant). Token-space alternatives are
   unidentifiable (collinear), so calibrate per-model $/pp empirically —
   mechanism-agnostic.
2. **Quota-pool lifecycle.** Exhaustion does not block until resets_at; a fresh
   ~7-day pool spins up within ~2–12h (observed Jul 30, Aug 1, Aug 5).
   resets_at = expiry-if-unexhausted, jittering by seconds. The saturation guard
   (§3) must therefore treat the peg→new-pool **interregnum** as unmeasurable
   (not negative drift), and observed pp must be **pool-aware** (sum monotone
   envelopes across pool tracks, clustering resets_at within ~3h).
3. **Slot flip.** Weekly (10080-min) quota was slot='secondary' until ~Jul 6,
   'primary' after. Weekly selection must key on duration_mins, never slot, or
   the 5.5-era calibration corpus disappears.

## 7. Open decisions for you

1. **Calibration model:** NNLS per-model regression (principled, recommended) vs.
   pragmatic per-model implied-capacity from model-dominated spans (simpler,
   coarser). 
2. **Calibration card copy:** single blended "$X per point" + per-model detail on
   expand, vs. always show per-model. 
3. **Saturated-span UX:** shaded "allowance exhausted" band vs. simply omit the
   expected line there.
4. **v0.1.0 scope:** all three now, saturation+composition now / speed after, or
   defer all three post-release.
