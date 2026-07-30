---
title: Milestone 2 Interval-Censored Inference Decision
date: 2026-07-23
type: decision-record
status: accepted
---

# Milestone 2 Interval-Censored Inference Decision

## Decision

**Proceed** to Milestone 3, the passive local collector, while retaining a live verdict of **non-identifiable** for the current weekly capacity.

The inference implementation passes its methodological gate because it recovers synthetic capacities, exposes incompatible live evidence, and refuses a quota claim. Future passive and controlled observations are needed before the capacity lane can be reconsidered.

## Implemented models

1. Floor display: an increase to `q` places the hidden `q%` crossing between the last prior and first next API-priced cumulative values.
2. Nearest-integer display: the analogous crossing is at `q - 0.5` percentage points.
3. One-event delayed display: the lower crossing bound expands to the actual cumulative price before the prior one request-like event.
4. Thirty-second delayed display: the lower crossing bound expands to the actual cumulative price observed 30 seconds before the displayed update.

Each reset window receives a nuisance hidden-usage offset. Capacity is shared only within the same provider, plan/limit ID, slot, and duration classification. This avoids making zero local activity at reset the primary assumption.

## Estimation and diagnostics

- Exact joint feasibility is solved from all boundary/intercept inequalities before a point estimate is shown.
- A within-reset pairwise Theil-Sen median provides an outlier-resistant provisional slope.
- A deterministic 500-replicate median bootstrap reports a 95% interval; large pair sets use a deterministic 1,000-quantile representative population for bounded runtime.
- The newest 20% of eligible boundaries in sufficiently populated reset groups are held out.
- Residuals are sliced by model mix, cache share, reasoning share, aggregate tool class, UTC hour, and window age.
- A chronological split scan flags a candidate change when before/after robust slopes differ by at least 1.25×.
- Origin-aligned floor and nearest fits remain sensitivity analyses only.

Floor and nearest rounding have the same capacity slope once every reset has a free offset: subtracting one half point from every threshold changes the offset, not the slope. The system records this non-identifiability instead of pretending the local data can choose between them. An origin-aligned synthetic fixture demonstrates that the models become distinguishable only after imposing the zero-offset assumption.

## Synthetic gate

Tests cover:

- exact recovery for floor-generated data;
- exact recovery for nearest-generated data;
- observed one-event and 30-second delay envelopes;
- skipped percentages and irregular increments;
- one controlled outlier with a stable robust median;
- non-identifiable low-span data;
- incompatible reset capacities and a detected change point;
- deterministic bootstrap and byte-stable serialization.

The complete current Node suite passes: 27 tests, zero failures, zero skips.

## Live weekly result

Classification: `openai_codex`, Pro, `codex`, primary, 10,080 minutes.

- 284 total transitions; 190 passed the parser/pricing/coverage/monotonic selection for inference.
- Displayed percentage span: 92 points.
- All 284 control states are unknown.
- Exact floor and nearest constraints are infeasible, with 124 parallel non-overlap contradictions.
- The one-event delayed model remains infeasible; the 30-second model reduces contradictions to 34 but does not restore feasibility.
- Provisional robust floor slope: `$1,886.697180725` API-price-equivalent.
- Deterministic bootstrap 95% interval around that robust statistic: `$1,878.592378461527` to `$1,897.376649999971`.
- Central 80% of pairwise slopes: `$1,733.488771093724` to `$2,023.864947380947`.
- Newest-transition holdout MAE: `1.917762610113` percentage points, above the 1.5-point gate; maximum error is `2.608430263` points.
- Strongest chronological split: `$1,260.032534375` before versus `$1,906.097249656246` after, a `1.512736534697×` candidate change.

The robust dollar value is not a capacity estimate because exact feasibility, holdout, control-state, and change-point gates all fail.

## Identifiability failures

- `candidate_capacity_change_point`
- `heldout_error_unavailable_or_too_large`
- `material_unknown_or_uncontrolled_activity`
- `no_finite_jointly_feasible_capacity_interval`

## Determinism, permissions, and privacy

Two unchanged live inference runs produced byte-identical outputs:

- JSON SHA-256: `2f98327629b1d80a9671177735dc9d4498a1c5ecbbd80a2fdccf273877523959`
- Markdown SHA-256: `05dda04666e0d53bbaa117627283bc4ac991ec30ce72917e15370dd03d55474f`

Both output files are mode `0600`. Searches found no local paths, rollout names, lineage identifiers, call IDs, arguments, working directories, prompts, responses, or fixture identifiers.

## Gate consequence

Milestone 3 should collect fresher source/receipt timing and future boundaries without generating model turns. Milestones 4 and 5 must establish controlled intervals and explain shared-pool/change-point effects before any live capacity range can pass the identifiability gate.

## Final pathway-audit addendum

The descriptive `report` and `report --json` paths now always return `non_identifiable` and null all fit, origin-aligned, rounded-capacity, and holdout result fields; they cannot surface a two-point perfect-fit capacity. The interval-inference machine artifact retains provisional method-development diagnostics under its explicit non-identifiable verdict, while the human inference report withholds exact, robust, bootstrap, and holdout values whenever any identifiability gate fails.
