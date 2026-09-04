---
title: Astra pricing and reviewed model identities
date: 2026-09-03
type: decision-record
status: accepted
---

# Astra pricing and reviewed model identities

This is the source contract for the 0.1.18 compatibility work, not a release,
deployment, account-entitlement or installed-client qualification receipt.

The accounting registry adds eight explicit `gpt-6-astra` price cards, one per
Standard/Batch/Flex/Priority and short/long context combination. The cells match
the [official API pricing tables](https://developers.openai.com/api/docs/pricing).
The [model card](https://developers.openai.com/api/docs/models/gpt-6-astra) specifies
long pricing strictly above 272,000 request input tokens; 272,000 remains short
and 272,001 selects long for the entire request. Existing models retain their
established boundary. Cache reads, cache writes and uncached input remain separate;
reasoning output is included in output charges once.

The registry's Astra evidence was reviewed at `2026-09-04T02:30:56Z` (September 3
locally). The documented September 3 release boundary is independent of that
review time. Older price cards, validity windows, source timestamps and evidence
hashes are unchanged. Astra has its own source entry and normalized-row hash;
the aggregate registry advances to `app-official-api-prices-v0.7`. Event-time
requests before its release remain unpriced rather than inheriting current rates.

Fast is the API Priority card's verified 2x Standard ratio for each eligible
Astra context. It does not use the separate Codex credit schedule's 2.5x figure
as a billing or allowance conversion. This follows the accepted
[published-speed pricing decision](./2026-08-30-fast-priority-published-pricing.md).
Rate source, time, context and availability still govern price selection.

The shared, runtime-neutral telemetry catalog contains 39 reviewed OpenAI
identities: 35 canonical priced models, three explicit price aliases, and Spark.
It also preserves five Claude identities. A catalog entry does not promise
Codex picker access. No `gpt-6t` alias or wildcard name is invented. Aliases
retain identity and assumption metadata; Spark cannot enter primary-allowance
cost comparisons. Closed schemas and the browser mirror consume/check the same
vocabulary. Old enum positions do not move.

The shared reasoning helpers distinguish API request effort from cache-relevant
configuration. Astra Ultra requests `xhigh`, but also enables proactive
delegation, so cache comparisons retain its distinct `ultra` label. `max` remains
distinct. This mapping follows the reviewed [Codex client source](https://github.com/openai/codex/blob/5cc1c94b8e3226c5a343b2f4fe77bf0585234f50/codex-rs/core/src/client.rs)
and is not evidence that a mid-thread configuration update took effect or that
the cache survived. Raw observed labels are preserved.

Local replay-accounting caches bind registry version and Worker model-fit caches
bind the registry hash. These derived results must be recomputed, and previously
unknown model events require source reparse. No physical schema is relabeled and
no retained R7 receipt is regenerated; that remains a protected release operation.
