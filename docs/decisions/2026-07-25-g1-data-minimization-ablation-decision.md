---
title: G1 Data-Minimization Ablation Decision
date: 2026-07-25
type: decision-record
status: inconclusive
---

# G1 data-minimization ablation decision

## Decision

Do not accept any new telemetry retention or publish any aggregate from this ablation yet. The deterministic receipt is **inconclusive** under the preregistered stop rules: it found zero completed prospective reset windows, participant/account/plan scope was unavailable for the prospective population, and therefore the primary reference metric could not be scored.

This is not evidence that a field is useful or useless. It is a deliberate no-decision: the next valid result requires at least three completed windows that began after the preregistration cutoff and meet the stated scope gate.

## What ran

`npm run evaluate:minimization` reads only the current privacy-minimized transition history, writes an owner-only local receipt, and freezes the input digest plus separate independent Codex- and Claude-shaped synthetic-fixture digests. Its receipt contains only counts, metrics, gates, cardinalities, and digests—never source rows, exact source times, reset identifiers, or pseudonyms.

The evaluator covers A1–A7, including the joint minimum-detail selection. It applies the preregistered primary metric (later displayed quota movement MAE from Standard API-price-equivalent usage), the absolute and conditional relative loss limits, secondary gradient/scope diagnostics, and all hard gates: identity, collision, partition, reset assignment, component totals, identifiability, contamination, scope, determinism, and privacy.

The frozen synthetic manifest covers independently shaped Codex and Claude cases for restart, duplicate, fork/replay, account switch, reset boundary, stale snapshot, and missing surface. Regression tests exercise both successful synthetic selection and a whole-reset merge caused by time coarsening; the latter correctly fails the reset-assignment gate.

## Available-evidence result

The local receipt reports these blockers:

- Fewer than three completed prospective reset windows.
- Participant, account, and plan scope unavailable in the prospective population.
- Reference primary metric unavailable as a consequence.

The source can exercise timing, tool, reset-time, and diagnostic transformations in-memory. It does not contain complete session-pseudonym, unknown-model-fingerprint, or provider-summary families, so those are explicitly recorded as unavailable rather than substituted with another field.

## Default dispositions until a valid receipt

| Family | Current disposition |
| --- | --- |
| A1 event timestamp | Keep exact time only as temporary restricted local material until a prospective receipt exists. |
| A2 session pseudonym | Omit. |
| A3 unknown-model fingerprint | Omit. |
| A4 tool diagnostics | Omit; permit at most binary/coarsened evaluation after the synthetic gate. |
| A5 receipt/reset time | Do not add it to the accepted schema until reset-assignment passes. |
| A6 parser/source diagnostics | Omit or aggregate only after the synthetic gate. |
| A7 provider summaries | Omit. |

No public aggregate is permitted while this decision remains inconclusive.

## Rerun and acceptance rule

Run `npm run evaluate:minimization` after each completed prospective reset. The machine receipt is the only selection surface: it must show at least three qualifying prospective windows, usable scope, an available reference primary metric, every hard gate passing, and a passing joint minimum-detail selection. Where the joint selection fails, add only the smallest preregistered field set that resolves that failure; do not introduce a new field family or relax a gate retrospectively.

The current local receipt is `.usage-monitor/minimization-ablation-v0.1.json`; it is intentionally ignored because it is a local aggregate evidence artifact.

## Verification

- `node --test test/minimization-ablation.test.js`
- `npm run evaluate:minimization`

The test suite verifies deterministic receipts, all A1–A7 paths, minimum-detail selection on synthetic evidence, explicit insufficient-evidence handling, source-value suppression, unavailable-family handling, and reset-merge rejection.
