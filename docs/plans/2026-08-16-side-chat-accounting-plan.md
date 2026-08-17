---
title: Side-chat accounting and coverage plan
date: 2026-08-16
type: plan
status: experimental-development
---

# Side-chat accounting and coverage plan

## Goal and boundary

Make ephemeral desktop side-chat activity visible without presenting inferred
tokens, cache behavior, API cost, or allowance consumption as exact. The owner
authorized a local development experiment on 2026-08-16; the validation gates
below still govern any production claim or default enablement.

The companion research is
[`2026-08-16-side-chat-accounting-observability.md`](../research/2026-08-16-side-chat-accounting-observability.md).

## Owner decision — 2026-08-17

- Advertise this as an active-window estimate covering approximately 10 days,
  not as historical side-chat accounting.
- Eligible retained estimates enter the development-only quota-weighted red
  line, its calibration metrics, and signed AUC. The exact ledger and exact
  accounting totals remain unchanged and visible as the baseline.
- Apply the reviewed Fast multiplier before allowance comparison, and divide
  each numerator only by a weekly capacity calibrated under the same speed
  scenario and basis identifier. A mismatched or unpriceable point is a gap,
  never a silent Standard-rate fallback.
- Expired or rotated side-chat detail remains unknown, not zero. Rebuilding
  later can therefore recover less historical side-chat evidence than an
  earlier snapshot; the UI states this active-window contract directly.
- Do not add a durable side-chat ledger in this iteration. Prospective
  side-chat-only retention is a possible future design, deliberately tabled
  until the active-window experiment proves useful.

## Authorized development experiment

The minimal experiment deliberately stops short of the proposed persistent
relations below:

- it is enabled only with
  `USAGE_MONITOR_DEVELOPMENT_SIDE_CHAT_ESTIMATES=1`;
- each snapshot detects the bounded desktop `fork -> inject -> side-route`
  sequence, then queries only those exact child partitions in the owner-local
  `logs_2.sqlite`;
- no prompt, response, reasoning, path, raw identifier, or raw log body enters
  the snapshot, and no inferred row enters `usage_event`;
- ordinary calls use the owner-approved mostly-warm parent-prefix hypothesis;
  elapsed time is only a local classification signal (fork-to-first-sample,
  then prior-sample-to-next-sample), not a provider cache-eligibility clock.
  The first call following an observed compaction is cold, and longer gaps
  widen the sensitivity endpoint to cold;
- the point estimate and sensitivity range may enter only a separate
  calibration timeline after retention, parser, pricing, and frozen-cohort
  gates pass. Exact usage periods, token totals, and accounting totals remain
  unchanged; and
- the dashboard shows adjusted residual area beside the exact-ledger baseline,
  making the hypothesis falsifiable on the owner's data.

The experimental reconstruction freezes the aggregate durable-call calibration
recorded in the companion research: active/provider-total ratios of
1.1137/1.0172/1.0007 and output/input ratios of
0.00071/0.0024/0.00953. The lower and point scenarios use ordinary cache-read
shares of 0.9954 and 0.9857. Because side-chat cache telemetry is absent, the
high-cost scenario uses zero cache reads instead of transferring the durable
cohort's p10 as though it were observed. Event-time Standard price cards are
then applied to the reconstructed components. The high-cost sensitivity also
uses zero cache reads. For GPT-5.6, whose reviewed cards include cache writes,
it deliberately allocates all reconstructed non-read input to a new cache
write; older reviewed cards that lack that category use ordinary uncached
input. This endpoint is a fully cold, all-reconstructed-input-written sensitivity,
not an observation, bound, percentile, or claim that every miss actually
writes the full input. Any unpriced sampling call
withholds the calibration overlay rather than contributing a partial sum. Reconstructed
timeline rows are marked `partiallyPricedEvents`, even when every component
found a reviewed event-time rate, so they cannot masquerade as exact usage.

The elapsed proxy is measured from the fork for the first retained sample and
from the preceding retained sample thereafter: 30 minutes for GPT-5.6 and 5
minutes for older models. It classifies the evidence but does not gate the
owner-directed mostly-warm point; after the proxy, only the high endpoint turns
cold. That clock is not provider cache evidence. Actual eligibility still
depends on exact prefix/key matching and a surviving entry, neither of which
the side-chat diagnostic exposes.

## Local development snapshot

At 2026-08-17 05:17 UTC, the owner-local preview detected 12 confirmed
side-chat lifecycles. Numeric diagnostics still survived for 3 of them; the
other 9 are reported as unknown rather than zero. One retained child is at the
known 1,000-row local retention limit, so only 2 children have complete numeric
retention. One repeated sampling snapshot was removed. The retained seven-day
evidence contains 54 deduplicated sampling markers across 4 visible turns and
8,462,295 active-context tokens. Six distinct compaction markers were retained;
two sampling calls were the first retained call after one or more of those
markers. The owner-directed mostly-warm point scenario is $5.638961 at
Standard API rates, with a $4.445988–$54.748271 sensitivity range spanning a
mostly-warm low side and a fully cold/cache-write upper side. All retained
calls in this snapshot use GPT-5.6 Sol; an older reviewed model would use
ordinary uncached input for the fully cold endpoint instead.

The current owner decision permits the surviving eligible calls to enter the
development calibration timeline despite partial historical retention. Their
scope is explicit: they estimate only the numeric markers still present in the
approximately 10-day active window. Expired lifecycles and capped earlier rows
remain a visible coverage gap. The adjusted red line, metrics, and AUC are
shown beside the exact-ledger baseline so the hypothesis remains testable; no
result is described as a complete seven-day, 30-day, or historical side-chat
total.

## Product contract

Expose three independent layers:

1. **Observed side-chat activity:** detected side chats, visible turns,
   sampling calls, model/effort, compaction, and retained coverage.
2. **Estimated API equivalent:** a p10/median/p90 empirical range based on
   sampled active-context volume, never merged into exact accounting.
3. **Allowance gap:** aggregate side-chat activity not represented in the
   exact ledger, with no invented percentage-point debit.

Never label the second layer `actual cost`, `billed tokens`, `cache loss`, or
`allowance used`.

## Minimal local architecture

### 1. Detect identity from desktop lifecycle

Recognize only the anchored sequence:

```text
parent thread/fork
  -> child thread/inject_items
  -> side-chat/browser route
```

Retain the desktop build, parser version, fork mode, first/last observed time,
and HMAC parent/child identities. Unknown or incomplete sequences remain
`other_ephemeral`, not side chats.

### 2. Enrich exact child IDs from `logs_2.sqlite`

Query only confirmed child IDs. Parse an allow-list of:

- timestamp;
- `turn_id` converted immediately to a local HMAC;
- model and effective reasoning effort;
- one deduplicated post-sampling active-token marker;
- follow-up/final state; and
- actual compaction reason/phase spans.

Never persist raw log bodies, task IDs, prompts, paths, commands, tool
arguments, item IDs, reasoning summaries, or developer text.

### 3. Future option: store a separate activity relation

Deferred by owner decision. Do not synthesize `usage_event` rows and do not add
this relation in the current iteration. If prospective side-chat-only
retention is approved later, use a narrow local-only relation such as:

```text
side_chat_activity
  child_local, parent_local, detected_at, ended_at,
  desktop_build, fork_shape, turn_count, sampling_call_count,
  active_token_volume, compaction_count,
  lifecycle_coverage, numeric_coverage, parser_version

side_chat_turn_activity
  child_local, turn_local, started_at, ended_at,
  model_id, reasoning_effort_id, sampling_call_count,
  active_token_volume, first_active_tokens, last_active_tokens,
  compacted_during, coverage_status
```

Use foreign keys and cascade deletion with the existing local retention model.
Keep recent detail bounded. Any table rendered in Accounting must use the
established ten-row Previous/Next pagination control.

### 4. Reuse accounting infrastructure selectively

Reuse:

- model canonicalization and Max/Ultra equivalence;
- event-time Standard price cards;
- evidence-grade status/coverage patterns;
- HMAC identity and parser provenance;
- period selection and paginated evidence UI.

Do not reuse the exact usage total, cache-switch, or cache-continuity ledger as
the storage destination. The side-chat range is an imputation, not a component
of those sums.

## Reconstruction formulas

### Observed active-context volume

For each deduplicated sampling call `j`:

```text
A_j = retained total_usage_tokens
turn active volume = sum(A_j) within one compaction-aware turn
```

This is observed active-context volume, not an exact component total.

### Empirical API-equivalent range

Maintain a version/model/effort/context-matched calibration from durable
requests where both `A_j` and exact components exist:

```text
q10, q50, q90 = cost per million active tokens
range_j = A_j / 1,000,000 * [q10, q50, q90]
```

Show cohort size, date range, and transfer warning. Withhold the range when the
matching cohort is stale, smaller than the gate below, or outside the observed
context/model regime.

### Parent-prefix cache sensitivity

For the first child call only:

```text
P = min(parent latest request input, estimated child input)
warm/cold delta = P * (uncached-input rate - cached-input rate)
```

This is optional sensitivity detail, never a headline. `P` excludes the
parent's newly generated output. Do not show a warm-default loss after
compaction, with an unknown fork shape, or beyond the documented exact TTL.

### Output

Keep observed output and reasoning `unavailable` historically. The development
scenario reconstructs only a combined output amount from its aggregate ratio
and maps that amount to the ordinary output rate solely at the price-adapter
boundary; it never presents a text/reasoning split as observed. The
characters/token branch already fails its stop gate and is not part of
implementation.

## Delivery stages

### Stage A — coverage and observed volume

Deliver:

- period totals for detected side chats, visible turns, sampling calls, and
  active-context volume;
- explicit active-window retention gap count;
- per-turn evidence with compaction and coverage status; and
- an explanation that missing side-chat logs are not zero usage.

No dollars or allowance conversion are required for Stage A.

### Stage B — experimental API-equivalent range

The estimate remains separate from exact accounting. When parser, price-card,
and cohort gates pass, surviving calls may enter the development-only
quota-weighted red line, metrics, and AUC with the exact-ledger baseline shown
beside them. The UI must show the interval, cohort grade, and active-window
coverage rather than implying a complete historical total.

### Stage C — exact live components

Do not implement by attaching to private stdio, patching the signed desktop
bundle, or scraping transient renderer state. Proceed only if one of these
supported paths appears:

- OpenAI exposes a read-only App Server observer;
- the desktop persists a content-free token-usage summary for ephemeral tasks;
- an upstream contribution adds such a summary; or
- TiboTattle becomes the authorized primary client for the task-producing App
  Server process.

If exact live components become available, persist only aggregate token fields,
turn/fork lineage, timing, model/effort, service tier, and compaction. Keep
prompts and response content out of the index.

## Validation experiments and gates

### A. Detection and retention

Run 20 controlled side chats across immediate forks, selected historical
messages, process restart, and compaction. Include a durable set of ordinary
tasks, subagents, and other ephemeral tasks as negatives.

Pass:

- at least 95% of controlled side chats detected;
- zero side-chat labels on the negative control set;
- at least 95% agreement between visible desktop turns and distinct retained
  turn IDs while both sources survive; and
- retention coverage displayed rather than inferred after pruning.

Early stop:

- detection falls below 90% in either of two consecutive desktop builds; or
- no stable lifecycle anchor distinguishes side chats from other ephemeral
  tasks.

Fallback: aggregate `ephemeral activity not in exact ledger` only.

### B. Sampling-call and active-total calibration

Use at least 500 matched durable sampling calls per supported
model/effort/context cohort. Exclude rate-limit-only duplicate snapshots and
segment compaction.

Pass:

- median absolute error of active total versus provider total at most 5%;
- p90 absolute error at most 15%;
- at least 95% of response-producing calls matched one-to-one; and
- no silent parser/version mixing.

Early stop:

- p90 error exceeds 20%; or
- sampling markers cannot be distinguished from duplicate usage snapshots.

Fallback: call counts and coverage only, without token volume.

### C. API-equivalent range transfer

Run controlled side chats whose exact components can be observed through a
supported future surface, then compare the empirical interval with actual
Standard API-equivalent cost.

Pass:

- at least 30 side-chat sampling calls in each supported model/effort cohort;
- at least 80% empirical coverage for the displayed p10–p90 interval; and
- no systematic undercoverage after fork delay, first-versus-follow-up call,
  or compaction segmentation.

Early stop:

- interval coverage is below 70%; or
- the required width is so broad that it does not improve on all-cached versus
  all-uncached sensitivity.

Fallback: observed active-context volume plus explicit warm/cold sensitivity.

### D. Cache-transfer experiment

This experiment is blocked until exact child cache components are available.
Then repeat equivalent forks immediately, before 30 minutes, after 30 minutes,
with model/effort changes, and before/after compaction. Use at least three
repeats per cell and no concurrent work.

Pass:

- cache-read behavior is reproducible enough to state a conditional measured
  rate by cell; and
- exact serialized-prefix/fork configuration is recorded without content.

Early stop:

- no supported child cache field exists;
- repeated forks vary materially under identical conditions; or
- only rounded/shared allowance movement is observable.

Fallback: keep warm/cold scenarios and do not state a cache-hit probability.

### E. Output-token estimator

**Stopped.** Existing calibration fails the proposed p90 error ceiling of 25%
for total output, and most tool calls retain no visible answer text. Reopen only
if a supported exact output field becomes available; a better tokenizer alone
does not address hidden reasoning or tool structure.

### F. Allowance attribution

Run isolated before/after quota trials only after all unrelated tasks and
shared-account activity can be excluded.

Early stop:

- the movement is within the provider's rounding resolution;
- concurrent/shared use cannot be excluded; or
- repeated identical trials do not produce a separable residual.

Fallback: label side chats as an observed coverage source for unexplained
allowance movement, with no per-chat percentage or dollar conversion.

## Privacy and release gates

- Fixture tests contain synthetic HMAC identities and aggregate values only.
- An automated secret/content scan rejects prompt fragments, paths, raw UUIDs,
  tool arguments, and response text in the new relations and DTO.
- Parser gaps in the known shapes are visible, and the UI states that detection
  is limited to those shapes; desktop-build provenance is not yet available.
  Missing evidence is never normalized to zero.
- Numeric recovery is limited to the active `logs_2.sqlite` retention. Rotated
  or expired partitions are not reconstructed and the UI says so directly.
- A fork/inject/route lifecycle split across rotated desktop-log files can be
  missed; this remains an explicit development limitation in the UI.
- Stage B output is excluded from exact totals, exports, and community
  estimates. The 2026-08-17 owner decision allows eligible retained estimates
  into the development-only allowance calibration timeline and AUC only.
- Browser QA covers zero, partial, compacted, unavailable, and paginated states
  at desktop and narrow widths.

## Exit condition

The feature is successful at Stage A if it makes previously invisible
side-chat activity and its coverage gap inspectable without inventing spend.
Stage B is optional and must stop if its interval does not validate. Stage C is
an upstream-capability dependency, not a reason to use unsupported desktop
instrumentation.
