---
title: Side-chat accounting observability research
date: 2026-08-16
type: research
status: complete
---

# Side-chat accounting observability research

## Decision

**Side-chat existence and per-turn model activity are recoverable, but historical
side-chat cost is not exact.** Build, if requested, a separate evidence-graded
activity lane. Do not insert inferred side-chat rows into the exact usage ledger.

The strongest current historical estimate is a calibrated Standard
API-equivalent range derived from each retained sampling call's active-context
token count. Cache reuse, output/reasoning tokens, service tier, account
partition, and subscription allowance debit remain unobserved. A warm/cold
cache calculation is a sensitivity analysis, not a measured cache loss.

## What current side chats do

The installed ChatGPT build inspected for this report was `26.810.41047`, with
`codex-cli 0.148.0-alpha.9`. Its current side-chat path:

1. forks the parent task's latest completed model-visible history as an
   ephemeral task;
2. injects side-chat developer context and the new user message;
3. when the user selected an older parent message, includes that message as an
   untrusted reference in the injected developer context rather than making it
   the actual fork boundary; and
4. leaves no ordinary rollout file or normal state row for the child task.

This behavior is version-specific. One retained August 13 case began with a
smaller active context than the matched parent baseline even though no
compaction preceded its first response. That older desktop build may have used
a different fork boundary or history projection. Any collector must therefore
retain the desktop build and parser provenance and fail closed on an unknown
fork shape.

OpenAI's App Server documents `thread/fork` and ephemeral threads, and the
current schema exposes `thread/tokenUsage/updated` with per-turn last and total
input, cached-input, cache-write, output, reasoning-output, and total token
fields. However, the desktop app's App Server is a private stdio child process;
there is no supported second-client observer. The desktop consumes the token
notification in transient renderer state but does not appear to persist it,
and it starts threads with experimental raw-response events disabled.

Sources:

- [Codex App Server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Codex turn implementation](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn.rs)
- [Codex context history](https://github.com/openai/codex/blob/main/codex-rs/core/src/context_manager/history.rs)
- [Responses usage parsing](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/sse/responses.rs)

## Parent context is a baseline, not proof of a cache hit

The user's proposed parent baseline is directionally useful with one important
correction.

Let:

```text
A_parent = parent active context after its latest completed response
A_child  = child active context after its first response
```

Both values are approximately the latest upstream request's input plus output,
with a small possible Codex adjustment for locally retained items. Therefore:

```text
A_child - A_parent
```

is useful evidence of net side-chat additions: injected instructions, the new
user message, the child output, and any changed tool or state material. Canary
00106, for example, had a matched parent active total of 209,402 and a first
child total of 241,541, a net increase of 32,139 tokens.

That difference does **not** reveal the child input/output split or cache split.
The parent response's newly generated output was not present in the request
that produced it, so it was not part of that request's reusable prompt prefix.
At most, the parent's last request input is a candidate reusable child prefix.
The parent's reported cached-input tokens only describe what the parent read;
they are not the size of an entry and do not prove what the child read.

OpenAI's current prompt-caching contract requires an exact rendered prefix,
compatible cache key, and an available entry. GPT-5.6 documents an exact
30-minute default TTL refreshed by reuse; longer retention is possible but not
guaranteed. Fork-to-sample elapsed time is only a local proxy because the TTL
starts at an actual prefix write or reuse, not at the desktop fork marker.
Canary 00106 followed its matched parent by about 2 hours 46 minutes, so a warm
child is not a defensible default under the public API contract.

Sources:

- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)

## What survives locally

The evidence snapshot covered desktop diagnostics observed from August 2–17,
2026 UTC and the then-current `logs_2.sqlite` retention window.

| Evidence | Result | Interpretation |
|---|---:|---|
| Desktop-confirmed side chats | 12 | Strong existence, parent/child, fork-time, and surface evidence while logs survive |
| Confirmed children still present in `logs_2.sqlite` | 3 | Numeric and lifecycle enrichment is shorter-lived |
| Confirmed child rollout files or normal state rows | 0 | The ordinary TiboTattle scanner misses all 12 |
| `logs_2` user-input task IDs without a durable row | 427 | Mixed ephemeral population; orphan status alone is not a side-chat classifier |
| Confirmed side chats among those orphans | 3 | Requires the desktop fork/inject/side-route lifecycle anchor |

`logs_2.sqlite` is privacy-sensitive. Its raw bodies can contain prompts,
paths, tool arguments, developer instructions, and reasoning summaries. A
product collector must first identify children from the anchored desktop
lifecycle, then query only those exact IDs and extract an allow-listed numeric
and lifecycle grammar. Raw bodies must never enter the unified index, report,
or fixture.

## Yes, the retained evidence is per turn—and finer

The useful grain is:

```text
side chat -> visible turn -> upstream sampling call
```

`logs_2` retains a real `turn_id`, model, reasoning effort, follow-up state,
and one `total_usage_tokens` marker after each retained sampling call. A single
visible user turn may issue many model requests while the agent calls tools.

| Retained case | Visible turns | Sampling calls by turn | Compaction |
|---|---:|---|---|
| August 13 longer side chat | 2 | 4, then 48 | One mid-turn span in the second turn; one repeated snapshot removed |
| Canary 00104 | 1 | 1 | Before the retained response |
| Canary 00106 | 1 | 1 | None observed |

Across the retained sampling population, calls per `turn_id` had a median of
3, p90 of 44, and maximum of 110. `UserInput` log rows are not a reliable
question counter. Repeated rate-limit-only token snapshots are also not model
calls and must be deduplicated.

The sampling marker is best described as **active-context total after a model
response**. Current Codex source starts with upstream `input + output` token
usage and may add estimates for retained reasoning/items not represented by
that upstream snapshot. It is not cumulative across the task, and it resets
around compaction. Summing one deduplicated marker per sampling call is an
approximation of gross request-token volume because the growing context is
sent and billed again on each request, subject to its cache split.

On 818 matched ordinary GPT-5.6 Sol high/max short-context requests:

- active total / provider total was 1.001 at p10, 1.017 at median, and 1.114 at
  p90;
- ordinary Standard API-equivalent cost per million active tokens was $0.537
  at p10, $0.650 at median, and $1.055 at p90; and
- ordinary cached-input share had a 98.57% median, but that cache distribution
  must not be assumed for side chats.

This supports an empirical range for a retained side-chat call. It does not
make the component split observed.

## A tokenizer cannot recover total output

The visible-text hypothesis was tested over a deterministic aggregate-only
sample of 91 ordinary rollout files (276,170,049 bytes), frozen at
2026-08-17 02:20 UTC. After excluding 36,871 repeated usage snapshots with no
new response item, 6,519 sampling calls
remained.

| Calibration result | Observed |
|---|---:|
| Calls with any visible assistant text | 1,029 / 6,519 (15.8%) |
| Tool-bearing calls | 5,729 / 6,519 |
| Tool-bearing calls with visible text | 5.01% |
| Characters/4 median error vs all output tokens, text-bearing calls | 44.0% |
| Characters/4 p90 error vs all output tokens, text-bearing calls | 86.7% |
| Characters/4 median error vs non-reasoning output, text-bearing calls | 9.45% |
| Characters/4 p90 error vs non-reasoning output, text-bearing calls | 73.8% |

A better tokenizer could improve the visible non-reasoning estimate, but it
cannot reconstruct encrypted reasoning, tool-call structure, hidden framing,
or calls with no visible answer. Expired side chats do not retain their answer
text in the inspected sources anyway. The output-token estimator therefore
fails the product gate for total accounting and should not be built. At most,
live visible text could be shown as an explicitly incomplete lower bound.

OpenAI's input-token endpoint can count an exact supplied Responses payload,
including tools and framing. It does not recover a payload that was never
retained, report the actual cache hit, or count output; sending private task
history to it would also require an explicit opt-in privacy decision.

Source: [Counting tokens](https://developers.openai.com/api/docs/guides/token-counting)

The aggregate-only calibration is reproducible with
`output/reports/2026-08-16-side-chat-observability/analyze-visible-output.mjs`.

## Compaction is a segmentation boundary

Compaction emits an opaque canonical replacement context. It is evidence that
the pre-compaction warm-prefix counterfactual no longer applies; it does not
provide the original token components or a priceable cache-loss event.

- Canary 00104 compacted before its retained response. Its 43,504-token marker
  describes post-compaction active context and cannot price the compaction call.
- The August 13 side chat compacted mid-turn after reaching 245,199 active
  tokens; subsequent markers restarted near 38,725. Pre- and post-compaction
  calls may remain visible as separate volume segments, while compaction cost
  stays unavailable.

Source: [Compaction](https://developers.openai.com/api/docs/guides/compaction)

## Subagents are not a side-chat calibration cohort

The first subagent request usually receives a scoped task payload, not the
parent's full latest conversation. A deterministic sample of 112
non-compacted durable child agents found:

- median child cached share: 40.23%;
- median child cached tokens / parent input: 11.75%; and
- median child input / parent input: 20.58%.

Only two retained at least 80% of the parent's input. These results agree with
the user's intuition: the first subagent call is structurally different. Once
inside the child, later turns can be analyzed like any other durable child
task. Do not use first-subagent cache behavior to impute a desktop side chat.

## Competitor research

No surveyed current tool reads the desktop side-chat lifecycle or
`logs_2.sqlite` as a primary usage source. All therefore inherit the same
ephemeral-side-chat blind spot.

| Tool | Useful pattern | Side-chat limitation |
|---|---|---|
| [CodexBar](https://github.com/steipete/CodexBar) | Strong parent/fork baseline resolution and suffix ownership | Assumes durable rollouts; no desktop or `logs_2` side-chat source |
| [ccusage](https://github.com/ryoppippi/ccusage) | Cumulative/last deltas, fork-time parent replay handling | Same durable-rollout assumption |
| [Token Use](https://github.com/russmckendrick/tokenuse) | Parent lineage and short fork cutoff | Retains transcript content and still misses side chats |
| [ccstats](https://github.com/majiayu000/ccstats) | Careful token-component normalization | No parent replay subtraction or side-chat source |
| [codex-usage](https://github.com/crisxuan/codex-usage) | Simple visible-text token estimator | Estimator cannot recover hidden output; no fork/side-chat logic |
| [Codex Usage Dashboard](https://github.com/YUHAO-corn/codex-usage-dashboard) | Optional provider proxy can retain exact usage for requests traversing it | No evidence desktop side chats traverse that proxy |
| [codex-usage-tracker](https://github.com/douglasmonsky/codex-usage-tracker) | Strong evidence grades, missingness, and fail-closed valuation design | Architecture is ahead of its demonstrated live ingestion |

The right choice is to borrow lineage/suffix and evidence-grade patterns, not
wrap or fork a competitor.

## Strongest defensible reconstruction

For each retained sampling call `j`, let `A_j` be its active-context marker.
Report `A_j` directly as observed sampled active context. For an experimental
API-equivalent range, use the matched ordinary-request distribution:

```text
estimated cost_j = A_j / 1,000,000 * cost-per-active-million quantile
```

The current matched Sol cohort gives p10 / median / p90 multipliers of roughly
`$0.537 / $0.650 / $1.055` per million active tokens. This is an empirical
imputation whose cache behavior may not transfer to side chats.

For an immediate first call only, a separate cache sensitivity may use:

```text
possible reusable prefix P <= parent's latest request input
warm premium  = P * cached-input rate
cold premium  = P * uncached-input rate
write premium = P * cache-write rate
```

Do not use the parent's new output as part of `P`; do not subtract the parent's
cached-input count from the child active total; and do not call cold minus warm
an observed cache loss. Suppress a warm-default interpretation beyond the
documented exact TTL or after compaction.

Exact subscription allowance debit remains unavailable. Provider quota is a
rounded, shared aggregate. A before/after residual can only be studied in an
isolated controlled experiment and must remain unattributed if other work or
rounding can explain it.

## Build / contribute / stop decision

- **Build locally, if requested:** content-free side-chat activity detection,
  per-turn sampling counts, active-context volume, compaction segmentation,
  coverage status, and an optional separately labelled empirical range.
- **Borrow:** CodexBar/ccusage lineage rules and evidence-graded null handling.
- **Contribute upstream:** request a supported read-only observer or durable
  content-free `thread/tokenUsage/updated` summary for ephemeral tasks.
- **Do not build:** visible-text total-output estimation, synthetic exact usage
  events, cache-hit claims from parent state, or per-side-chat allowance debit.
- **Stop at a coverage gap:** if desktop lifecycle retention or parser drift
  cannot sustain high-confidence detection, show only aggregate missing-source
  coverage and do not estimate cost.

The current development collector reads only the active `logs_2.sqlite`
retention and recognizes pinned lifecycle, sampling, and compaction shapes.
Rotated/expired numeric partitions and wholly new logging shapes remain
unmeasured; the dashboard exposes both limitations rather than calling them
zero activity.
