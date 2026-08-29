# Quota-analysis package guidance

Scope: all files under `packages/quota-analysis/`. Apply the repository root
guidance first.

## Analytical contract

- This package analyzes observed quota tracks, reset evidence, calibration,
  rolling comparisons, pace, and model composition. It does not know or prove a
  provider's private allowance formula.
- Preserve quota family, window duration, reset identity, account scope, plan era,
  observation time, freshness, coverage, speed/billing basis, and uncertainty
  wherever they affect comparability.
- Never pool distinct accounts for account-level inference, or pool plans, reset
  windows, quota families, or pricing bases. A cross-account cohort estimator is
  allowed only when an accepted product decision explicitly scopes it to an
  aggregate surface, preserves participant boundaries, balances participant
  influence, and makes the aggregation basis part of the output contract. Never
  use future reset observations to fit or label an earlier forecast.
- Unknown control state, hidden usage, missing coverage, integer-display lag,
  conflicting constraints, wide intervals, and change points remain explicit
  non-identifiability or uncertainty, not cleaned data.
- Keep descriptive observation, fitted calibration, forecast, and presentation
  policy separate. A convenient display must not feed back into the estimator.

## Package and validation discipline

- Keep algorithms deterministic, runtime neutral, and independent of files,
  network, credentials, clocks, app code, and repository tooling.
- Make ordering, tie-breaking, windows, bounds, convergence, and refusal thresholds
  explicit and stable. Avoid data-dependent nondeterminism and hidden defaults.
- Export through the package root with matching types. Treat public policy
  constants and continuity/reset keys as compatibility contracts.
- Add property and adversarial coverage for ordering, sparse tracks, repeated
  integers, reset boundaries, contamination, uncertainty, and no-look-ahead.
- Run focused quota-analysis tests, then `npm test` and
  `npm run architecture:check`; add report/UI tests when output semantics change.
