---
title: G1 Data-Minimization Ablation Preregistration
date: 2026-07-24
type: research-plan
status: preregistered
---

# G1 Data-Minimization Ablation Preregistration

## Purpose

Determine which restricted telemetry fields materially improve local quota-versus-API-price-equivalent monitoring before freezing the first volunteer contract. The study must prefer omission or coarsening whenever utility remains within predeclared tolerance.

This preregistration is frozen before comparative ablation results are inspected. Later changes require a dated amendment explaining why the original test could not answer the question; the original rules and results remain visible.

## Scope and non-goals

The study evaluates only privacy-safe records already produced locally. It never reads or retains prompt/response content, code, tool arguments/results, paths, filenames, repository identity, raw session/account/device IDs, emails, credentials, or provider request IDs.

It does not decide public disclosure eligibility. Exact timestamps, pseudonyms, and row-level data remain restricted even if useful locally. It does not estimate a provider's true allowance or prove a provider billing formula.

## Frozen inputs

The final run will use:

1. independently shaped synthetic fixtures for Codex and Claude;
2. adversarial restart, duplicate, fork/subagent, account-switch, reset-boundary, stale-snapshot, and missing-surface fixtures;
3. completed local reset windows available before the analysis cutoff;
4. provider-specific source records only after both prospective Codex app-server and Claude status-line/export adapters are complete; and
5. an untouched chronological holdout consisting of the latest eligible completed reset per provider/account/plan track, plus leave-one-reset-out checks on the earlier eligible resets.

No row from an incomplete reset is used to choose a retention policy. Synthetic fixtures may test correctness gates but cannot alone justify retaining a restricted field for empirical calibration utility.

## Full-information reference

The reference retains all currently proposed restricted metadata:

- second-resolution observed, received, event, and reset times;
- session pseudonyms;
- keyed unknown-model fingerprints;
- the full reviewed tool-class count vector;
- exact receipt and reset timing;
- reviewed diagnostic codes and counts; and
- eligible prospective provider-side daily/lifetime summaries, evaluated only as a candidate and not included by default.

The reference is a comparison baseline, not a presumption that every field survives.

## Ablations

Each ablation changes one field family at a time, then the selected privacy-improving choices are evaluated jointly.

### A1 — Timestamp resolution

- Reference: exact seconds.
- Candidate 1: floor to UTC minute.
- Candidate 2: floor to five-minute UTC bucket.
- Apply consistently to event/observation/received time while retaining the ordering rule needed for deterministic IDs outside the timestamp value.

### A2 — Session pseudonym

- Reference: stable provider/session-scoped pseudonym.
- Candidate: omit it or replace it with a constant unavailable state wherever the schema permits.
- Event occurrence IDs remain source-occurrence-derived so the test measures analytical session utility rather than destroying basic deduplication intentionally.

### A3 — Unknown-model fingerprint

- Reference: installation-keyed unknown-model fingerprint.
- Candidate: plain `unknown` with no fingerprint.
- Recognized reviewed model IDs are unchanged.

### A4 — Tool granularity

- Reference: full reviewed count vector.
- Candidate 1: four coarse groups—provider-hosted, local execution/edit, retrieval/browser/computer, and agent/orchestration/other.
- Candidate 2: total tool calls only.
- Candidate 3: binary tool activity present/absent.
- Tool evidence remains explanatory and is never converted into billable provider units without independent provider evidence.

### A5 — Receipt and reset timing

- Reference: exact second-resolution receipt and reset epochs.
- Candidate 1: minute resolution.
- Candidate 2: five-minute resolution.
- Reset identity may keep a provider-declared stable identifier if available; it may not be reconstructed from private content.

### A6 — Diagnostics

- Reference: reviewed diagnostic code/count vector.
- Candidate 1: broad states only—complete, partial, malformed-source, lineage-uncertain, and resource-limited.
- Candidate 2: one aggregate quality-warning count.
- Candidate 3: omit diagnostics.

### A7 — Provider summaries

- Reference candidate: sanitized official daily token totals and lifetime/peak summaries where available.
- Candidate: omit all summaries and retain only canonical quota windows plus exported local usage events.
- Default decision is omission unless untouched-holdout utility exceeds the retention threshold below. Lifetime totals are presumed unnecessary because they cannot align a turn or reset directly.

## Primary metric

For every eligible completed reset track, fit only on earlier resets and predict the later displayed quota movement from API-price-equivalent usage. Measure mean absolute error in percentage points on the untouched later reset using the existing prior-reset/no-look-ahead rule.

An ablation is practically equivalent on the primary metric when both are true:

- absolute MAE degradation is no more than **0.25 percentage points**; and
- relative MAE degradation is no more than **5%**, except when reference MAE is below 0.25 points, where only the absolute rule applies.

The 0.25-point bound is below the half-point uncertainty induced by an integer percent display and is therefore a deliberately strict practical threshold.

## Hard correctness and scientific-integrity gates

An ablation fails regardless of average MAE if it causes any of the following on an untouched real or adversarial fixture:

- a logical event/snapshot duplicate or collision that the reference keeps separate;
- a changed account, provider, plan, limit, or reset-family partition;
- a completed reset assigned to the wrong reset identity;
- recognized priceable token components or API-price-equivalent totals to change;
- a previously non-identifiable result to become identifiable without new evidence;
- an identifiable result to become non-identifiable in more than one eligible holdout reset;
- a known shared-pool contamination period to be classified as clean;
- a provider/account boundary to be pooled;
- a policy/change-point alert to move by more than one candidate time bucket or change its final accepted/rejected verdict;
- deterministic serialization, restart equivalence, or cross-chunk deduplication to fail; or
- a privacy/schema verifier to accept a value outside the reviewed allowlist.

Reset-assignment mismatch must be exactly zero on synthetic boundary fixtures and no more than **0.5% of observations** on eligible local holdouts, with zero whole-reset reassignment.

## Secondary utility metrics

- quota-gradient correlation and slope error at one-, two-, and three-hour windows;
- proportion of observations with usable account/plan/speed/provider scope;
- stale-snapshot and unexplained-residual detection precision/recall on injected fixtures;
- fork/subagent/replay attribution agreement;
- model-regime and Fast/Standard sensitivity availability;
- provider aggregate crosscheck residual; and
- number of eligible completed resets retained after quality gates.

No secondary metric may override a hard failure. A field may be retained on secondary utility only when it improves an untouched holdout by at least **10% relative** on a predeclared metric and the improvement appears in at least two independent completed reset windows or one real reset plus all corresponding adversarial fixtures.

## Privacy/cardinality measurements

For each candidate, report without exposing values:

- number of retained restricted fields;
- distinct-value count and uniqueness fraction by field;
- number of records unique under the retained quasi-identifier tuple;
- temporal resolution;
- whether cross-session, cross-account, or cross-installation linking is possible;
- retention duration; and
- whether the field is eligible for personal output, aggregate-only use, or neither.

These are descriptive disclosure-risk indicators, not a claim of formal re-identification probability.

## Selection rule

For each field family:

1. Reject any candidate that fails a hard gate.
2. Among candidates within the primary-metric tolerance, choose the one with the least detail and lowest linkability.
3. Retain more detail only when its holdout gain passes the secondary retention threshold or the less detailed candidate fails a hard gate.
4. If empirical evidence is insufficient, apply these defaults:
   - exact timestamps remain restricted temporarily because they are central to lag/gradient analysis, with a mandatory rerun after three eligible provider/account-scoped resets;
   - session pseudonyms, unknown-model fingerprints, detailed tool classes, and diagnostics are omitted or coarsened unless required by a synthetic correctness gate;
   - provider lifetime/peak summaries are omitted; and
   - no inconclusive field becomes public-aggregate eligible.
5. Run the jointly selected minimization configuration against the full untouched holdout. If combined degradation exceeds the primary tolerance, add back the smallest single field family that restores equivalence, selected without looking at participant identity.

## Required outputs

- machine-readable configuration and frozen fixture hashes;
- per-ablation and joint-selection metric tables;
- per-reset results and participant/reset sample counts without exact private timestamps or pseudonyms in the human report;
- deterministic rerun receipt;
- explicit inconclusive/insufficient-evidence labels;
- a field-by-field keep/coarsen/omit decision with purpose and retention; and
- updated schemas, field dictionary, compatibility tuple, privacy contract, and tests only after the decision receipt is accepted.

## Stop conditions

Stop and issue an inconclusive result rather than choosing a policy if:

- provider adapters or record semantics change during the run;
- fewer than three eligible prospective completed reset windows exist for a field whose decision depends on real calibration utility;
- account/plan/provider scope is unavailable for the holdout;
- exact and ablated runs do not have record-count/identity parity where parity is expected;
- a source-integrity or privacy check fails; or
- the full reference itself fails the existing scientific-integrity gates.
