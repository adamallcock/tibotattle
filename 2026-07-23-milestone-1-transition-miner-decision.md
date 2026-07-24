---
title: Milestone 1 Historical Transition Miner Decision
date: 2026-07-23
type: decision-record
status: accepted
---

# Milestone 1 Historical Transition Miner Decision

## Decision

**Proceed** to Milestone 2, interval-censored inference.

The local history contains enough reproducible transition boundaries to test inference models. This decision does not declare the quota capacity identified and does not treat every recovered transition as clean.

## Implemented evidence path

- Streams active and archived Codex rollout JSONL rather than loading raw transcripts into a normalized artifact.
- Resolves structural parent/fork lineage from `session_meta` fields in memory and never persists the identifiers.
- Removes inherited fork history by exact cumulative token-snapshot identity while retaining legitimate child deltas.
- Normalizes uncached input, cache reads, cache writes, text output, and reasoning output as disjoint components.
- Prices each request-like event through RunCost using standard OpenAI API prices effective at the event timestamp.
- Keeps weekly, five-hour, reset identity, plan/limit classification, and slot groups separate.
- Collapses repeated integer displays into last-prior/first-next transition boundaries.
- Preserves regressions, skipped percentages, missing usage, partial coverage, unknown models, pricing warnings, aggregate tool classes, and unavailable snapshot age as explicit quality evidence.
- Writes stable-key JSON and a Markdown audit atomically with owner-only permissions.

## Live historical gate

Fixed interval: `2026-07-21T17:06:03.000Z` through `2026-07-23T16:15:40.974Z`.

- 118 rollout files scanned.
- 20,195 retained usage events; all 20,195 priced without a RunCost warning.
- Model attribution: 8,204 Terra events, 11,869 Sol events, and 122 Luna events; no unpriced model bucket.
- 35,181 inherited fork replay events excluded; zero missing lineage parents and zero unattributed fork replay events.
- 20,569 raw and 20,565 deduplicated quota-window snapshots.
- 588 reset groups observed, four of which contain displayed-percentage transitions.
- 284 total transitions: 195 increases and 89 regressions.
- 177 candidate one-percentage-point increases have full elapsed-time coverage, complete pricing, known model attribution, and at least one retained local usage event.
- Five malformed JSONL lines, one malformed rate-limit record, and two missing rate-limit records were retained as diagnostics.
- After adding the observed event/time lag envelopes required by Milestone 2, both normalized live runs produced dataset SHA-256 `5e39bfa451a0242dd138c1a23161bfc61b57a4089a2686c8db961bfc2b0d5398` and audit SHA-256 `5bdd764ffac8d1dce0aeb82bcbce3254c360dcfae37c365e4ff382458f9e912e`.
- Dataset and audit permissions were verified as `0600`.

## Test gate

The complete current Node test suite passed: 27 tests, zero failures, zero skips. Transition-specific coverage includes monotonic changes, repeated displays, skipped values, regressions, reset isolation, simultaneous five-hour and weekly windows, active/archive duplicates, null limits, a malformed final token line, an unknown model, deterministic serialization, owner-only files, and the existing parent/fork child-usage regression.

The first package-level attempt used `npm test`, but the bundled runtime did not expose `npm`; this was an environment-only command failure before test execution. The declared underlying test command, `node --test`, then passed completely.

## Privacy inspection

The emitted artifact was searched for local home paths, rollout filenames, fixture session identifiers, lineage field names, call IDs, arguments, working directories, prompts, and response fields. None were present. The only URL field is pricing-source provenance. A scalar-key inventory exposed no account, user, device, path, filename, argument, command, prompt, response, or session field.

## Known limitations carried into Milestone 2

- Provider snapshot age and original local receipt lag are unavailable in historical rollout files.
- Concurrent sessions can carry stale last-known quota displays; the 89 within-reset regressions demonstrate that event timestamp alone is not a total ordering of provider freshness.
- Elapsed-time coverage is not proof that every activity source contributing to the quota was logged locally.
- Tool observations are client-side aggregate classes and are not assumed to be provider-billed tool units.
- The 177 candidate transitions are inputs to competing interval models, contamination checks, and holdout validation—not independent exact one-percent measurements.

## Gate consequence

Milestone 2 may begin. Its estimator must exclude or separately model regressions and zero-local-usage transitions, preserve snapshot-age uncertainty, keep reset groups isolated, and issue a non-identifiability verdict if the competing rounding/delay models do not agree within justified thresholds.

## Parser 0.3.1 reproducibility addendum

The parser later gained the additive adjacent-snapshot stream required by Milestone 5. To preserve provenance, the current default now writes `.usage-monitor/transitions-v0.3.1.json`; `infer` and `contamination` use matching `0.3.1` defaults. The frozen `0.3.0` artifact above remains byte-identical at SHA-256 `5e39bfa451a0242dd138c1a23161bfc61b57a4089a2686c8db961bfc2b0d5398` and is the explicit input to the legacy correction migration.

Two current-parser fixed-window runs were byte-identical at SHA-256 `f79b9d06bf18ce967f792dfc3f83dda426b2c895c982540821d479145ecc1d9e`; the frozen hash was unchanged before and after both commands. Parser `0.3.1` also persists that service tier is unobserved and that `standard` is the counterfactual API-price assumption.
