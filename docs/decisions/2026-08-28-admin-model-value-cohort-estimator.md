---
title: Admin model-value cohort estimator
date: 2026-08-28
type: decision
status: accepted
---

# Admin model-value cohort estimator

## Decision

The owner-only allowance preview will estimate the Pro 20x-equivalent API value
of single-model Codex usage from a participant-balanced cohort fit for each
displayed model target. It admits only the three configured personal plans and
normalizes every observation's API cost before fitting:

- Pro: multiply cost by 1;
- ProLite: multiply cost by 4;
- Plus: multiply cost by 20.

Team, unknown, and other plans are excluded. Plan identity is retained through
observation construction and caching. A two-hour bin containing quota readings
from more than one plan is excluded before plan filtering because its untagged
usage cost cannot be assigned safely to one multiplier.

## Cohort aggregation

The graph is a cohort estimate, not an account estimate. Evidence must therefore
accumulate across the contributing accounts instead of requiring every account
to identify each model independently. After plan normalization, both the quota
movement and model-cost predictors for participant `i` are multiplied by
`1 / sqrt(n_i)`, where `n_i` is that participant's usable row count in the
trailing window. This preserves every row's capacity equation while giving each
participant equal total squared-error influence.

Sol, Terra, and Luna are configured targets. Each target receives its own fit so
forcing a low-share target through the generic model-discovery floor cannot make
another target unavailable. The minimum-row, adjusted-fit, and non-negative
checks still apply to the pooled, balanced corpus. Each target must also remain
positively identified in both interleaved evidence halves. The magnitude of
half-to-half drift remains diagnostic evidence but does not suppress the
owner-only point estimate; this avoids hiding every configured target when the
cohort mix changes within a window.

## Contract and claim boundary

The API and UI must name the aggregation basis as
`participant_balanced_pooled_fit` and the plan normalization as
`pro_x1_prolite_x4_plus_x20`. The displayed value is the Standard-API-price
counterfactual for one model under the observed subscription speed mix. It is
not a provider-published allowance, an API bill, or an individual participant's
capacity.

This exception to account-separated fitting applies only to the owner-only
cross-account model-value graph. Account-level calibration, forecasts, and
participant-facing results remain account-scoped. Publication beyond the admin
surface requires a separate product decision and validation.

## Acceptance checks

- Ten participants with individually sparse but collectively sufficient rows
  can produce a cohort model estimate.
- Duplicating one participant's rows does not increase that participant's total
  least-squares influence.
- Low-share Luna can be fitted as a configured target without suppressing Sol or
  Terra.
- A target identified in both evidence halves remains visible even when their
  point estimates drift; a zero or unidentified half still withholds it.
- Mixed-plan bins and unsupported plans do not enter the normalized estimator.
- Missing or unstable values remain unavailable rather than becoming zero.
