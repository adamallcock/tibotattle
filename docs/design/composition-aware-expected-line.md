---
title: Composition-aware expected-line contract
date: 2026-08-10
type: design
status: maintained
last_verified_commit: 52399658f28303f6af00259f921c2c46a881978f
last_verified_date: 2026-08-27
---

# Composition-aware expected-line contract

## Outcome

The composition-aware expected line, allowance-pool saturation guard, and
lineage-scoped speed carry-forward are implemented. This document records the
maintained interpretation contract; it is not a live allowance measurement or
a provider-capacity claim.

The earlier constant expected line could mistake model mix for quota drift:
API-price-equivalent cost and provider allowance consumption are different
quantities, and their ratio varies by model. A saturated allowance also cannot
supply further observed percentage movement. The maintained model keeps those
limitations explicit instead of turning them into confident residuals.

## Contract

### Composition-aware calibration

Fit a non-negative per-model API-price-equivalent capacity vector from the same
eligible calibration corpus used for the weekly report. Expected movement for a
bucket is the sum of each model's cost divided by that model's fitted capacity.
The headline rate is a cost-weighted blend for the observed mix; it is not a
universal allowance price.

Unknown, insufficient, stale, incompatible, or unidentifiable calibration
evidence stays unavailable. It must not silently fall back to a precise
constant or an invented zero.

### Saturation and reset handling

When a bucket begins at the provider-reported ceiling, both observed and
expected movement are unavailable for residual accumulation and the row is
marked as pool-saturated. Cost incurred after the ceiling must not be booked as
negative drift merely because the percentage cannot rise.

A reset or a new allowance-pool identity starts a new segment. Residual and
signed-area calculations exclude saturated spans rather than smoothing through
them. The dashboard renders the excluded state explicitly.

### Lineage-scoped speed carry-forward

A rollout may inherit the most recent reviewed speed tier from its own resume
history or reachable fork ancestry. It must never inherit from an unrelated
session, a process-global default, or a concurrent thread. When no reachable
declaration exists, speed remains unobserved.

This carry-forward changes pricing only where lineage supplies evidence. It
does not change token quantities, provider quota observations, model identity,
or replay suppression.

## Implementation map

- [Model-composition fitting](../../packages/quota-analysis/src/model-composition.js)
  owns per-model fitting and the blended-rate projection.
- [Weekly calibration](../../src/reporting/weekly-calibration.js) integrates the
  composition-aware vector into retained report evidence.
- [Expected-line construction](../../src/simple-quota-gradient.js) applies the
  vector and pool-saturation rules.
- [Unified-index ingestion](../../src/local-unified-index-ingest.js) and
  [extraction](../../src/local-unified-index-extract.js) implement
  lineage-scoped tier seeding.
- [Dashboard rendering](../../apps/web/public/app.js) displays per-model rates
  and explicit saturated states.
- [Focused regression tests](../../test/simple-quota-gradient.test.js) cover
  mixed-model calibration, historical synthetic fixtures, saturation, resets,
  and residual exclusion.
- [Package-boundary tests](../../test/quota-analysis-package-boundary.test.js)
  pin the public analysis implementation.

## Claim boundary

These checks establish deterministic local interpretation for the tested
source and fixtures. They do not establish a provider-published numeric
allowance, billing total, universal dollar-per-point constant, or live capacity
change. A new model family, quota identity, parser version, or provider
accounting policy must remain unknown until source-backed calibration and
regression evidence are reviewed.

## Maintenance triggers

Revalidate this contract when any of the following changes:

- model normalization or pricing semantics;
- quota-pool identity, duration, reset, or saturation handling;
- weekly calibration eligibility or fitting code;
- session lineage, fork replay, or speed-tier inheritance; or
- dashboard residual, signed-area, or unavailable-state rendering.
