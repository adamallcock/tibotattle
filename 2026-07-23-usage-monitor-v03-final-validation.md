---
title: Usage Monitor v0.3 Final Validation
date: 2026-07-23
type: validation
status: complete
---

# Usage Monitor v0.3 Final Validation

## Final verdict

The local-only proof of concept is implemented and validated. It can reproducibly join local token usage, standard OpenAI API-price equivalents, integer quota snapshots, reset identities, contamination evidence, controlled-workload receipts, client tool observations, and append-only corrections.

It **cannot yet identify the weekly allowance**. The defensible live result is `non_identifiable` because:

- the exact interval constraints conflict;
- held-out error exceeds the one-percentage-point display resolution;
- all live historical/experiment intervals have unknown control state;
- the two bounded live pilots were contaminated by separate local activity;
- there are zero strict controlled reference intervals; and
- the observed tool calls do not match provider-billed hosted-tool units.

The provisional `$1,886.70` robust statistic is a sensitivity diagnostic only. It is not an estimate of OpenAI's internal limit or formula.

## Direct answers to the research questions

### 1. Pricing basis

The system uses **standard OpenAI API pricing**, not the Codex subscription rate card. Input, cached input, cache writes, text output, reasoning output, and long-context conditions remain separate pricing semantics. Codex rollout token-count records do not expose API service tier or Fast mode, so parser `0.3.1` persists `observed: null` beside an explicit `standard` counterfactual pricing assumption. RunCost is the pricing kernel and retains source/provenance warnings.

A follow-up check of [OpenAI's Codex Speed documentation](https://developers.openai.com/codex/speed) established that ChatGPT Codex Fast and API Priority are separate. Fast is 1.5 times model speed and consumes GPT-5.6/GPT-5.5 credits at 2.5 times Standard (GPT-5.4 at 2 times); GPT-5.6 API Priority is billed at 2 times Standard API token pricing. The standard API-price ledger remains unchanged, while future quota analysis must record `codexSpeedMode` separately and treat missing historical mode as unknown.

The installed app-server schema exposes `serviceTier` on thread start/resume responses and turn/thread-setting overrides. The local app log database currently has 908 service-tier-bearing session-handler rows: zero Fast overrides, 56 explicit Default overrides, 510 clears, and 342 omissions. This supplies a privacy-sanitizable prospective capture path, but it does not retroactively label the already processed fixed-window events.

The current official source is [OpenAI API detailed pricing](https://developers.openai.com/api/docs/pricing). The fixed live interval contains 20,195 fully priced request-like events and no remaining unpriced model.

### 2. Remaining allowance and precision

Local Codex rollout logs normally retain the last provider-reported:

- integer `used_percent`;
- window duration;
- reset timestamp;
- plan/limit identity; and
- limited credit-state metadata.

They do **not** contain the absolute remaining token/message/dollar allowance. A 30-day structural scan found no fractional quota percentage: observed values were integers from 0 through 100. The local value is also event-driven and can be stale until another response writes a token-count event.

The Codex app-server account method can refresh the current rate-limit snapshot without spending a model turn, and a held connection can receive update notifications. It exposes the same integer granularity, not a hidden decimal or absolute capacity. Therefore an endpoint refresh improves freshness, not precision.

The official daily account token buckets are useful only as lagging anomaly signals. They cannot be used to force local reconstructed tokens and quota burn into agreement.

### 3. Unknown-model tokens

The 71,060,499 “unknown model” tokens were not a secret or fallback model. They were copied cumulative history at the beginning of forked/spawned rollout files before an attributable active model context.

Replay-safe lineage matching removes:

- 2,685,437 uncached input tokens;
- 68,264,192 cache-read tokens;
- 65,468 text-output tokens; and
- 45,402 reasoning-output tokens.

The effective baseline falls from 2,963,770,014 to 2,892,709,515 tokens. API-priced cost remains `$1,668.23595870` because the replay bucket was already unpriced. The retained schema-0.1 observation is unchanged; a one-record correction supplies the effective view and audit trail.

Separately, the first passive-collector smoke produced 22 pre-model-seeding records labelled `unknown`, totalling 3,714,307 tokens. They are not inputs to any canonical analysis or correction pathway and cannot be re-attributed safely from the privacy-minimized record. They remain operational provenance and are not part of the 71,060,499 replay correction.

### 4. Drastic system improvements

All seven agreed improvements are implemented:

| Milestone | Result | Gate |
| --- | --- | --- |
| 1. Historical transition miner | 20,195 priced events; 284 collapsed transitions; 19,977 adjacent snapshot intervals retained additively | Proceed |
| 2. Interval-censored inference | Floor/nearest/delay models, robust fit, bootstrap, holdout, residual slices, and change-point checks | Proceed; live capacity non-identifiable |
| 3. Passive collector | Run-once and foreground modes, atomic checkpoints, rotation/truncation handling, notification reconnect, stationary resource receipt, no daemon install | Proceed |
| 4. Controlled workloads | Seven manifests, standard API-price projections, quiet/headroom/concurrency/budget stops, two bounded live pilots | Proceed; no causal observation |
| 5. Contamination analysis | 19,979 intervals, include/exclude views, sensitivity residuals, daily lag signals, synthetic contamination/change tests | Proceed; live result non-identifiable |
| 6. Tool mechanisms | Nine-class evidence matrix, client/server separation, exact provider-unit pricing boundary | Proceed; no safe identifiable pair |
| 7. Append-only corrections | Digest-validated chains, conflict/cycle/error handling, deterministic replay migration | Proceed |

## Core live evidence

### Fixed-window token and transition data

Interval: `2026-07-21T17:06:03.000Z`–`2026-07-23T16:15:40.974Z`.

| Measure | Value |
| --- | ---: |
| Usage events | 20,195 |
| Fully priced events | 20,195 |
| Fork replay events excluded | 35,181 |
| Unknown/unpriced models | 0 |
| Corrected tokens | 2,892,709,515 |
| Standard API-price equivalent | $1,668.24 |
| Collapsed displayed transitions | 284 |
| Adjacent snapshot intervals | 19,977 |
| Zero-display-change intervals | 19,693 |
| Positive display changes | 195 |
| Negative display changes | 89 |

The original parser-`0.3.0` Milestone 1 artifact remains frozen at SHA-256 `5e39bfa451a0242dd138c1a23161bfc61b57a4089a2686c8db961bfc2b0d5398`. Current parser-`0.3.1` commands write different versioned paths; two fixed-window reruns were byte-identical at SHA-256 `f79b9d06bf18ce967f792dfc3f83dda426b2c895c982540821d479145ecc1d9e` without changing the frozen file.

### Inference

- Robust point diagnostic: `$1,886.697180725`.
- Holdout mean absolute error: `1.918` percentage points.
- Exact floor/nearest constraints: incompatible.
- Candidate reset-to-reset change ratio: `1.51x`.
- Control state: unknown for all live inference evidence.
- Reported capacity interval: none.

### Controlled pilots

Two bounded Terra workloads completed with aligned before/after captures. Each interval also contained a separate Sol rollout. The harness preserved both results as contaminated, spent within its declared bounds, and made no multiplier claim. Later attempts were refused before launch when another task remained active/recent.

### Contamination

The live contamination analysis combines 19,977 historical intervals and two completed experiments:

- controlled: 0;
- uncontrolled: 0;
- unknown: 19,979;
- positive-cost/no-display-movement flags: 19,359;
- displayed movement/no retained local cost: 19;
- provisional unexplained movements: 76;
- explained movements: not measurable because the capacity/control gate is non-identifiable;
- negative deltas: 89; and
- strict controlled reference intervals: 0 of the required 8.

Daily account buckets cannot alter interval arithmetic; a synthetic invariance test enforces that boundary.

### Tool mechanisms

The fixed interval contains 17,552 relevant client observations:

- local shell: 13,447;
- Apply Patch: 1,928;
- subagent orchestration: 1,142;
- MCP: 590; and
- web-search wrappers: 445.

There are zero matching provider-billed units in the interval. A local shell call is not an OpenAI Hosted Shell container session, and a client web wrapper is not automatically a Responses `web_search_call`.

Current standard API pricing documents web search calls, file search calls/storage, and Hosted Shell/Code Interpreter containers. The [OpenAI organization Usage API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage) separately exposes web/file request counts and Code Interpreter session counts. Those API-organization units are not Codex subscription receipts.

No tool/no-tool workload was launched because none had an exact provider unit, a clean control, sufficient integer-display sensitivity, bounded repetition, and an uncontaminated interval. This is more informative than pricing 17,552 client calls with invented conversions.

## Validation receipts

- Full test suite: **88 passed, 0 failed, 0 skipped**.
- JavaScript syntax checks: all source files passed.
- Legacy `report` smoke: `non_identifiable`, reported capacity `not identified`, and perfect-fit diagnostics suppressed.
- Legacy `report --json` smoke: fit, origin-aligned, rounded-capacity, and holdout fields null; no numeric capacity value emitted.
- Non-identifiable human inference report: exact, robust, bootstrap, and holdout values withheld; only verdict and gate failures emitted.
- Parser `0.3.1` fixed-window rerun: byte-identical canonical output; frozen parser-`0.3.0` SHA-256 unchanged.
- Stationary five-second collector smoke: zero watcher events, zero reconciliation cycles, one initial ingestion, two checkpoint writes, 0.07s user/0.04s system CPU, 70,909,952-byte maximum RSS, lock removed.
- Tool analyzer fixed-window rerun: byte-identical canonical JSON and Markdown after excluding unstable filesystem-layout counts.
- Correction migration rerun: one correction line before and after; effective JSON and report byte-identical.
- Retained observation SHA-256 before/after migration: `965118ca1fbb0fadc9644e3b3909ee5066bd728bdbeac6253c86075ce1ee3e69`.
- New artifacts: mode `0600`.
- Privacy scan of tool, correction, and effective JSON/JSONL: zero forbidden-key or sensitive-string hits.
- Independent audit findings led to read-time correction privacy validation, safe identifier errors, an exclusive correction-ledger transaction lock, explicit observed-versus-desk tool states, versioned current artifacts, and the report refusal path.
- Final independent code and plan re-audits passed with no remaining blockers.

## What to do next

The next work should collect better evidence rather than add a dashboard:

1. Leave the passive collector running during ordinary use for multiple complete reset windows.
2. Wait for a genuinely quiet window, then run repeated no-tool pairs that cross more than one displayed percentage transition.
3. Freeze model, effort, `codexSpeedMode`, context band, and cache state within each pair; never infer Fast from API Priority.
4. Add a typed provider-unit receipt before testing web search, file search, or hosted containers.
5. Require at least eight strict controlled reference intervals and validation across a second reset before reporting a capacity range.
6. Claude.ai Pro OAuth now passes a Keychain-backed live smoke; capture one successful status-line event with non-null five-hour/seven-day windows and keep its inference separate from Codex.
7. Version every future parser/pricing change through the correction ledger rather than rewriting observations.
8. Only after local identifiability succeeds, design the multi-user schema around interval aggregates, explicit consent, regional/legal review, k-anonymity thresholds, and no raw transcripts or stable account identifiers.

## Final boundary

This system measures whether observed quota movement is consistent with chosen API-price mappings under explicit observation models. It does not reveal or prove OpenAI's private subscription formula. The current absence of an identified capacity is a successful result: the system now shows exactly which missing evidence prevents the claim.

## Key artifacts

- [Evidence-gated goal](./2026-07-23-usage-monitor-v03-goal.md)
- [Milestone 1 decision](./2026-07-23-milestone-1-transition-miner-decision.md)
- [Milestone 2 decision](./2026-07-23-milestone-2-interval-inference-decision.md)
- [Milestone 3 decision](./2026-07-23-milestone-3-passive-collector-decision.md)
- [Milestone 4 decision](./2026-07-23-milestone-4-controlled-workload-gate.md)
- [Milestone 5 decision](./2026-07-23-milestone-5-contamination-decision.md)
- [Milestone 6 decision](./2026-07-23-milestone-6-tool-mechanism-decision.md)
- [Milestone 7 decision](./2026-07-23-milestone-7-correction-provenance-decision.md)
- [Original research validation](./2026-07-23-local-usage-limit-validation.md)
- [Linked Reddit experiment](https://www.reddit.com/r/codex/comments/1v4ds6g/ive_been_measuring_my_100_pro_lite_weekly_limit/)
