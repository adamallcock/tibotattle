---
title: G5 Server Repricing and Calibration Plan
date: 2026-07-26
type: plan
status: in_progress
---

# G5 Server Repricing and Calibration Plan

## Outcome

Turn the central service from a safe file receiver into a trustworthy analysis
service. Every accepted usage event will be re-priced from its allowlisted
metadata on the server, persisted with immutable method and price-registry
provenance, and used for private observed-versus-calculated quota views.
Client-declared prices remain available only as diagnostics and never determine
canonical personal or community results.

This is an implementation slice of the
[end-to-end multi-user goal](./2026-07-24-end-to-end-multi-user-usage-monitor-goal.md).
It does not authorize a public deployment or claim that an API-price-equivalent
estimate is the provider's actual subscription allowance.

## User-facing result

After an upload, a participant should be able to see:

- server-calculated API-price-equivalent cost and pricing coverage;
- an exact explanation of priced and unpriced components;
- Standard, Batch, Flex, and Priority as API processing tiers;
- Codex Standard/Fast as a separate subscription-speed observation;
- hourly cost and provider-reported quota movement on the same UTC timeline;
- selectable one-, two-, and three-hour smoothing;
- five-hour and seven-day reset-aligned estimates when evidence is sufficient;
- plain-language warnings for stale quota snapshots, unknown models, long-context
  uncertainty, missing account continuity, or possible shared-pool activity; and
- the client/server accounting difference as an integrity diagnostic.

## Non-negotiable accounting rules

1. The server derives canonical cost from validated token and provider-billable
   unit metadata. It does not trust uploaded cost totals.
2. All monetary arithmetic remains exact decimal or fixed-scale integer
   arithmetic. SQL `REAL` is not a canonical money representation.
3. API price is an explanatory counterfactual for subscription usage, not a
   claim about the internal quota rate card.
4. Codex subscription Fast never selects OpenAI API Priority. The two dimensions
   are stored and analyzed separately.
5. An explicitly observed API Standard, Batch, Flex, or Priority tier selects
   only its exact reviewed price card. Unknown or unsupported tiers fail closed.
6. GPT-5.6 requests above 272,000 total input tokens use the reviewed long-context
   prices. Missing total context prevents a short-context assumption where the
   threshold could matter.
7. Unknown models, missing components, unavailable cache-write splits, unknown
   tool units, and unsupported price epochs remain unpriced with stable reason
   codes; they never become zero.
8. Historical pricing is asserted only for a supported vendor-effective window
   or a retained contemporaneous observation. Otherwise the result is labeled a
   current-price sensitivity.
9. Provider quota movement remains observed evidence. Repricing must not rewrite
   quota values or force cost to match them.
10. Private participant views may use exact timestamps and participant-scoped
    records. Public releases use only sealed, contribution-bounded,
    thresholded, clipped, and rounded snapshots.

## Architecture

### Shared accounting kernel

- Extract the edge-safe parts of `src/cost-ledger.js`,
  `src/local-api-pricing.js`, and `src/price-registry.js` into one shared package
  used by both the local analyzer and Worker.
- Keep RunCost as the calculation kernel where it remains edge-safe.
- Generate or compute one deterministic registry manifest containing version,
  source URLs, observed timestamp, evidence hash, method version, and supported
  effective intervals.
- Add parity fixtures proving that the local and Worker adapters produce the
  same exact totals, component coverage, and reason codes.

### Canonical D1 representation

Add server-derived fields to each usage record:

- canonical cost as an exact decimal string and fixed-scale integer;
- coverage status and percentage;
- unknown billable units and stable unpriced reason codes;
- pricing method version, registry version, registry hash, price-card IDs, and
  pricing epoch basis;
- separate client-declared cost and server/client delta;
- enough normalized context to reproduce the calculation without retaining
  content.

Add contribution-level server summaries calculated from the accepted canonical
records. Deduplicated records must not be charged twice. Deletion must remove
derived records and withdraw any dependent public snapshot under the existing
mutation-epoch protocol.

### Private calibration projection

Build a bounded server query that:

1. partitions quota observations by participant, provider, limit, slot, reset,
   plan variant, and privacy-safe account track when available;
2. rejects resets, backwards movement, stale or ambiguous observations, and
   intervals without adequate priced usage coverage;
3. assigns canonical cost between consecutive observations;
4. creates minute/hour buckets and one-, two-, and three-hour rolling views;
5. reports observed quota change beside the change implied by the fitted
   API-price-equivalent capacity;
6. fits five-hour and seven-day capacity only from eligible positive movement;
7. provides central estimates, empirical error bands, sample counts, coverage,
   holdout error, and stable exclusion reasons; and
8. labels the result conditional when account scope or shared-pool coverage is
   incomplete.

The primary UI must call these “observed quota movement” and “expected from API
cost.” Pairwise fits may remain an internal robust-estimation primitive but are
not the participant-facing explanation.

### Account continuity

The current outbound contribution deliberately removes account scope. That is
privacy-safe but can make two-account calibration ambiguous. Before adding an
account field, perform a minimization review of a contribution-local,
domain-separated account-track pseudonym that:

- cannot be joined to local account identifiers or other participants;
- rotates with participant identity and deletion;
- contains no email, plan, or provider account ID;
- is used only for private calibration and never published; and
- is optional, with `unattributed` remaining a first-class state.

Until that review passes, the server must not pool overlapping ambiguous quota
tracks into a precise estimate.

## Work packages

Checkpoint status on July 26:

| Package | Status | Evidence |
| --- | --- | --- |
| G5.1 Price evidence correction | Verified | Official July 26 registry, tier matrix, and exact long-context boundary tests |
| G5.2 Edge-safe shared repricer | Verified for OpenAI | Local and Worker use the same framework-free ledger and registry; Claude production work remains paused |
| G5.3 Canonical persistence | Verified | Forward-only D1 migration, server-derived event/contribution fields, tampering tests, and deletion smoke |
| G5.4 Private results API and UI | Partial | Server-priced totals, coverage, and speed separation are live; rolling conversion fails closed until account continuity is approved |
| G5.5 Community calibration | Privacy gate open | Existing usage-only weekly snapshots remain unchanged; no public cost/quota field was added |

The detailed test and lifecycle evidence is recorded in the
[G5 verification receipt](./2026-07-26-g5-server-repricing-and-calibration-verification-receipt.md).

### G5.1 — Price evidence correction

- Refresh official OpenAI API pricing evidence.
- Add GPT-5.6 short/long-context cards and exact threshold tests.
- Verify Standard, Batch, Flex, and Priority rows.
- Preserve tool-call prices and explicit non-coverage for container sessions.
- Keep Claude-compatible shared interfaces while production Claude analysis
  remains paused.

### G5.2 — Edge-safe shared repricer

- Extract one shared pure accounting package.
- Remove Node-only hashing from request-time price calculation or replace it
  with a build-time manifest.
- Add Worker and local parity tests.
- Ensure no mutable request state or floating promises.

### G5.3 — Canonical persistence

- Add a forward-only D1 migration.
- Reprice before the D1 batch is committed.
- Persist fixed-scale/exact values and provenance.
- Preserve client declarations under explicitly untrusted names.
- Add idempotency, duplicate, partial-pricing, deletion, and migration tests.

### G5.4 — Private results API and UI

- Replace client-declared totals in personal statistics with server-derived
  totals.
- Add component coverage and server/client comparison.
- Add the long UTC timeline with one-, two-, and three-hour smoothing.
- Add reset-aligned five-hour and seven-day cards with honest non-value states.
- Keep raw records and account-track values out of browser-visible diagnostics
  unless required for that participant's private chart.

### G5.5 — Community calibration

- Define a separate privacy review for any public cost/quota metric.
- Require independent participant support, per-participant clipping, coarse
  rounding, non-overlapping weeks, delayed cutoff, and immutable snapshots.
- Do not publish a cost-derived field merely because token fields are already
  public; assess residual disclosure and linked-equation risk first.
- Retain suppression, withdrawal, and no-live-fallback behavior.

## Verification matrix

- Official price golden cases for every supported OpenAI model/tier.
- Below, exactly at, and above the 272K GPT-5.6 threshold.
- Subscription Fast with API Standard pricing and no implicit multiplier.
- Explicit API Priority/Flex/Batch, plus unknown and unsupported tier failures.
- Observed zero versus unavailable component.
- Exact cache reads/writes, reasoning output, combined output, and tool units.
- Unknown model and model fingerprint non-resolution.
- Client price tampering that cannot change canonical server totals.
- Duplicate uploads and overlapping contributions with one canonical charge.
- Contribution deletion and participant deletion removing derived private data.
- Mutation during snapshot finalization cancelling publication.
- Local/Worker exact parity on frozen fixtures.
- Real HTTP enrollment, authorization, encrypted upload, status, personal stats,
  export, deletion, and withdrawn-snapshot smoke.
- Desktop and mobile browser checks for loading, empty, partial, priced,
  ambiguous-account, stale-quota, suppressed, withdrawn, and error states.

## Release gates

This slice reaches a verified checkpoint only when:

1. the shared repricer and registry golden matrix pass;
2. Worker typecheck, generated binding check, Worker tests, and dry deploy pass;
3. local and Worker price results match exactly on the same safe fixtures;
4. canonical personal results contain no client-trusted price;
5. Fast and API Priority/Flex/Batch remain separate in storage, API, and UI;
6. long-context uncertainty is handled without short-rate underpricing;
7. account ambiguity is either separated by an approved private track or
   explicitly excluded;
8. deletion removes canonical private derivatives and withdraws dependent
   snapshots;
9. HTTP and rendered browser QA pass; and
10. a dated verification receipt records commands, versions, registry hash,
    fixtures, observed outputs, and remaining gaps.

Public deployment, real participant solicitation, and automated collection
remain separate gates requiring production infrastructure, secrets, retention,
monitoring, incident operations, and pilot consent review.
