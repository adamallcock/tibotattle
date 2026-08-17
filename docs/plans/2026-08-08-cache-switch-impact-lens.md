---
title: Cache-switch impact lens
date: 2026-08-08
type: plan
status: implemented
---

# Outcome

TiboTattle will identify local requests where a recorded model or effective
reasoning-effort change is immediately followed by an observed loss of cache
reuse. It will sum a conservative API-price-equivalent premium for those
requests and, when the existing historical weekly calibration has explicit
scope and a compatible cost basis, translate that premium into a qualified
allowance percentage-point impact.

The feature is a diagnostic lens. It does not change existing usage or cost
totals, claim a provider bill, or say that a historical settings change proved
the cache loss on its own.

# Evidence and terminology

A controlled July 30 High -> Max -> High direct Responses API experiment held
the model, prompt, explicit cache breakpoint, cache key, history behavior, and
other request fields fixed. The first request after each API-distinct effort
change wrote rather than read the 3,392-token prefix; a same-effort repeat was
warm; switching back recovered the earlier cache. Controlled Codex A -> B -> A
runs observed the same pattern for model changes. This establishes the
mechanism, but it does not make every historical adjacency causal evidence.

OpenAI's prompt-caching documentation states that caching requires an exact
prefix and that retention can vary by model and policy. It also documents the
GPT-5.6 cache-read/write fields and explicit breakpoint behavior:

- https://developers.openai.com/api/docs/guides/prompt-caching

The UI and data contract therefore use these terms:

- **configuration change**: the next recorded request in one local session has
  a different recognized model or a different API-effective reasoning effort;
- **observed material cache-read drop**: the next request reports no more than
  half as many cache-read tokens as the preceding request and reports enough
  non-cache-read input to bound the difference;
- **switch-associated cache reuse loss**: the bounded token difference when
  both facts occur close together;
- **estimated cache-reuse premium**: the event-time Standard API-price
  equivalent of the observed cold input minus the same request with that
  bounded token slice treated as a cache read.

Do not label the result `caused`, `wasted`, `billing`, `provider allowance`, or
`cache deleted`. A model/effort switch creates or selects another effective
cache lineage; switching back may recover the earlier lineage.

# Minimal-change decision

Use the existing unified local SQLite index and existing accounting page.

No new raw-log parser, index column, parser version, migration, persisted
summary, endpoint, native destination, or contribution field is required. The
current index already retains the privacy-safe facts needed for the analysis:

- salted local session identity;
- event timestamp and deterministic event key;
- recognized model identity;
- reasoning-effort ordinal;
- uncached, cache-read, and cache-write input components;
- event-time pricing identity.

The companion will run one read-only chronological transition projection over
the index, price only the small candidate set with the existing memoized
accounting pricer, and attach bounded period summaries to the existing local
snapshot. The browser receives aggregate facts and a bounded recent detail
list, never the salted session identity, event key, rollout path, turn ID, or
content.

# Detection contract

Within each `session_local`, compare adjacent positive-input requests in exact
source-byte order. Sessions without complete single-source ordering coverage
are withheld rather than ordered by timestamp or an HMAC event key. The index
does not retain `turn_id`, so this is deliberately request-level, not a claim
that every row is exactly one user turn.

Treat configuration records as state updates, not per-turn presence receipts.
The UI's sparse `world_state.model` field is a delta: an omitted field means
the prior observed value remains effective, not that the current request has
missing configuration. Only a setting that has never been observed is unknown.
The privacy-reviewed extractor does not use raw `world_state` field presence as
request coverage; it attaches carried effective model/effort state to each
usage request. The analyzer compares those attached values and never treats
raw field absence as a switch or a coverage gap.

Normalize Codex `max` and `ultra` to the same API-effective effort. The
controlled evidence shows that both serialize as API effort `max`; treating a
Max <-> Ultra label change as an intrinsic effort-cache break would be false.
If the model changes at the same boundary it remains a model change.

Classify each effective change exactly once:

- `reasoning_only`
- `model_only`
- `model_and_reasoning`

For a candidate request:

```text
non_cache_read_input = current_uncached + current_cache_write

lost_cache_tokens = min(
  max(previous_cache_read - current_cache_read, 0),
  non_cache_read_input
)
```

Require all of the following before including a request in the headline sum:

1. both timestamps are valid and ordered;
2. the recorded gap is at most five minutes;
3. the changed dimensions are known;
4. the prior/current cache-read and current uncached/cache-write components are
   present, non-negative safe integers;
5. the previous request reports at least one cache-read token;
6. `lost_cache_tokens` is positive; and
7. current cache-read tokens are at most 50% of prior cache-read tokens.

Five minutes is a precision-first universal proximity ceiling, not a claim
about the provider's exact eviction time. Longer-gap changes remain counted as
configuration observations but are excluded from the attributed sum because
ordinary retention or eviction is a strong confound. Replay/import timestamps
can still be imperfect, so even a proximate row remains an association.

The 50% collapse gate separates a material cache break from small prefix drift
and warm switch-back behavior. In the diagnostic corpus, one Max -> High return
retained 114,432 of 115,456 cached tokens. A positive-difference-only rule would
incorrectly call that recovered lineage a break and assign 1,024 lost tokens.

# Cost counterfactual

Reuse `createAccountingPricer()` for both sides. Preserve the current request's
model, timestamp, output, total input, and Standard API tier. Move only the
bounded lost-cache slice into cache-read input.

When the slice could have come from uncached or cache-write input, move
uncached input first. Cache-write input is more expensive on current GPT-5.6
cards, so this produces the smaller, more conservative premium. Move any
remainder from cache-write input. If either side is unpriced, retain the token
observation but withhold its money estimate.

```text
estimated_cache_reuse_premium =
  actual_current_request_price - counterfactual_warm_request_price
```

This diagnostic is a sibling of ordinary accounting. It must never be added to
existing totals because the actual cold input is already included there.

# Allowance translation

When live weekly calibration is available and its selected cost basis is
`standard_api`, calculate:

```text
estimated_allowance_impact_pp =
  100 * estimated_cache_reuse_premium / median_weekly_capacity_usd
```

Apply the same calculation to the calibration's lower and upper capacity
values to preserve a range. Only the seven-day premium uses this weekly
denominator; 24-hour, 30-day, and all-history selections withhold percentage
points. Withhold them too if the calibration is missing, zero, lacks explicit
account-scope provenance, or is based on a speed-weighted metric. The
API-equivalent token/cost diagnostic remains available independently.

The current calibration is account-unattributed and may combine accounts. The
UI states that limitation whenever it renders the conditional historical
estimate. It is not a provider-published quota conversion.

# Product surface

Reuse the existing **How the estimate was calculated** page and its period
selector.

1. Add one optional metric card labeled **Possible switch overhead**. It shows
   the conservative API-equivalent premium, the count of cache-read drops, and
   the denominator of proximate configuration changes. If compatible weekly
   calibration exists on the seven-day selection, the note can also show the
   estimated percentage-point range and its may-combine-accounts qualifier.
2. Add one collapsed evidence disclosure below the model table. Its bounded
   recent rows show local time, change type, prior/current model or effort,
   observed cache-read change, bounded lost-cache tokens, and estimated
   premium.
3. Explain in the information label that the cache token change is observed
   while its relationship to the adjacent configuration change is inferred.
4. Render unavailable as an em dash, not `$0.00`. Render zero only when the
   unified index was completely evaluated and no qualifying loss was found.

No session or turn identifier crosses into the browser payload.

# Diagnostic corpus check

A final read-only probe of the installed 467,445-row unified index on
2026-08-08 found 227 API-effective adjacent configuration changes. Many were
hours or days apart and are not suitable for a causal cost sum. Under the
five-minute proximity ceiling, 90 changes remained; 80 had a material
cache-read drop, totaling 8,379,371 bounded tokens and $33.74016678 of fully
priced Standard API-equivalent premium across indexed history. The analyzer
read took 0.38–0.39 seconds in the final audit, versus about 7.70 seconds for
the existing full companion projection on the same corpus.

These figures validate that the existing schema contains a useful signal. They
are development diagnostics, not product constants or release claims.

# Verification

- Pure analyzer fixtures cover reasoning-only, model-only, combined, Max/Ultra
  equivalence, warm switch-back, long-gap exclusion, no prior cache,
  the exact 50% collapse boundary, cache-write allocation, unpriced events, and
  malformed values.
- A raw-rollout-to-unified-index fixture proves the existing extractor supplies
  model/effort/cache facts without a schema or parser change.
- Companion projection tests prove the four periods, missing-index state,
  bounded details, and absence of session/event identifiers.
- Browser normalization fails closed for hostile, partial, and oversized
  payloads; rendering tests distinguish unavailable, zero, and populated
  states.
- English, Spanish, and Simplified Chinese localization parity remains green.
- Benchmark the extra read against the installed index. Do not add a composite
  index or cache schema until measurement shows the read-only query is a real
  startup problem.
- Inspect the shared embedded dashboard assets in a browser at desktop and
  narrow widths. Native bundle inclusion remains covered by the existing macOS
  web-closure tests; this implementation does not build or install a release.

# Release boundary

This work is local analysis and presentation only. It does not publish,
deploy, change contribution payloads, or authorize a release.
