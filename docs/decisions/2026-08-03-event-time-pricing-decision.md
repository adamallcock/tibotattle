---
title: Event-Time API-Price-Equivalent Accounting Decision
date: 2026-08-03
type: decision-record
status: implemented
---

# Event-time API-price-equivalent accounting decision

## Decision

TiboTattle prices each retained usage event with the official API price card
whose effective window contains that event's timestamp. The date that a price
registry was reviewed is source provenance only; it is never used as the price
date for a historical event.

This applies to local replay-safe accounting, weekly calibration, prepared
contribution diagnostics, and server repricing. A reset or reporting period
may therefore contain more than one official card when it crosses a price
change.

The explicit `current_price_sensitivity` option remains only for intentional
compatibility/comparison callers. It is not the default for local, telemetry,
or Worker accounting and must not be presented as a historical result.

## Required failure behavior

The calculator does not substitute a current card when history cannot be
proven. A monetary component remains unpriced when either of these is true:

- its event timestamp is missing or invalid; or
- its timestamp falls outside the official effective windows retained in the
  registry.

The result carries a fixed historical-pricing reason code. This is preferable
to a precise-looking but backdated total. In particular, the current official
OpenAI evidence starts on 2026-07-26; earlier events are not repriced with a
later card.

## July 30 GPT-5.6 card change

The registry contains distinct GPT-5.6 Terra and Luna Standard price cards
through 2026-07-29 and from 2026-07-30. Events on each side of the boundary
select their own card. If a visible seven-day fit contains both, the local
dashboard retains the two IDs, exact component totals, and event counts, and
labels the fit as spanning historical card windows.

The dashboard wording must state this directly: the lower official Terra/Luna
cards effective 2026-07-30 apply only to retained events on or after that
date; earlier events retain their earlier cards. No dashboard may say that all
historic events were repriced with the latest card.

## Cache and contract behavior

Replay-safe accounting changed from `v0.1` to `v0.2`. Its fast plan cache keys
include the event's effective date, and its persisted cache records the
event-time pricing basis plus per-card provenance. A cache produced under the
former current-price semantics is withheld and rebuilt; it is never silently
served as an event-time result.

The telemetry contract distinguishes `historical_api_prices` from
`current_api_prices`. Server outputs carry the event-time basis and fail closed
when ingestible telemetry lacks a canonical event time.

## Limits of this measure

An API-price equivalent is a conditional measuring stick for token consumption,
not a subscription charge or a provider-published allowance. Correct historical
price selection improves the consistency of the measure; it does not prove a
subscription quota, a billing total, or a causal change in OpenAI's allowance.

## Verification requirements

Before a release, preserve tests for all of the following:

1. the exact 2026-07-29/2026-07-30 Terra and Luna boundary;
2. mixed-card aggregation and exact decimal totals;
3. missing timestamp and pre-evidence failure paths;
4. cache invalidation from the old semantics; and
5. Worker, local dashboard, telemetry, and browser projection provenance.

The implementation uses the installed RunCost kernel's inclusive effective
date matching and its `historical_price_missing` behavior, while TiboTattle
adds its own timestamp-required boundary and user-facing provenance.
