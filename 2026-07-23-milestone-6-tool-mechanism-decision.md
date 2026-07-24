---
title: Milestone 6 Tool Mechanism Decision
date: 2026-07-23
type: decision-record
status: complete
---

# Milestone 6 Tool Mechanism Decision

## Decision

**Proceed to Milestone 7.** The acceptance gate passes on the permitted alternative: the evidence demonstrates why no tool/no-tool pair is currently safe and identifiable. No paired workload was launched, no API tool price was assigned to a client call, and no claim is made about OpenAI's internal Codex subscription accounting.

The fixed interval is `2026-07-21T17:06:03.000Z` through `2026-07-23T16:15:40.974Z`. It is the same interval used by Milestones 1, 2, and 5.

## What changed

- Added a descriptor-only tool-mechanism analyzer and deterministic human report.
- Updated the rollout parser to distinguish:
  - client function calls;
  - client wrapper calls;
  - statically visible nested client tool calls; and
  - typed Responses output items such as `web_search_call`.
- Kept raw names, code, arguments, commands, paths, URLs, content, and stable identifiers out of derived artifacts.
- Added standard OpenAI API pricing only when an independently observed provider unit matches the documented unit.
- Added a `tools` CLI command with fixed `--since` and `--until` boundaries.

## Official unit boundary

The current [OpenAI API detailed pricing page](https://developers.openai.com/api/docs/pricing) documents:

- web search at `$10.00 / 1,000 calls` plus applicable model-token charges;
- file search at `$2.50 / 1,000 Responses API calls` plus storage;
- Hosted Shell and Code Interpreter containers at `$0.03` to `$1.92` per 20-minute session per container depending on memory, with eligible sessions billed by minute and a five-minute minimum; and
- no separate current per-action Computer Use fee or ordinary client function-call fee.

The [OpenAI organization Usage API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage) exposes provider aggregates with different units: web and file search use request counts, while Code Interpreter uses session counts. Those API-organization receipts are separate from Codex subscription quota telemetry.

RunCost 0.2.0 already preserves this boundary: it can map typed Responses output items and provider usage receipts to tool components, but it does not convert arbitrary client wrapper calls into hosted-tool billing units.

## Fixed-window evidence

The first materialization selected 126 active or archived rollout files, including required lineage ancestors. Later verification selected 128 after new fork lineage files appeared, while every fixed-window tool aggregate remained identical. The changing file count is therefore excluded from the canonical tool artifact. The scanner observed 19,904 raw client function/custom-tool response items. Nested wrapper extraction produced 21,162 privacy-safe aggregate observations because one wrapper may invoke more than one nested client tool.

The nine requested classes account for 17,552 client observations. Five classes were observed in the fixed interval; the four zero-count provider classes are explicitly marked `desk_researched_unobserved`, not falsely counted as observed:

| Class | Client observations | Matching provider units | Classification |
| --- | ---: | ---: | --- |
| Web search | 445 | 0 | Inconclusive |
| File search | 0 | 0 | Inconclusive |
| Code Interpreter | 0 | 0 | Inconclusive |
| Hosted shell | 0 | 0 | Inconclusive |
| Computer use | 0 | 0 | Inconclusive |
| MCP | 590 | 0 | Inconclusive |
| Local shell | 13,447 | 0 | Unsupported as an API hosted-tool unit |
| Apply Patch | 1,928 | 0 | Unsupported as a separately priced API unit |
| Subagent orchestration | 1,142 | 0 | Unsupported as a separately priced API unit |

The remaining observations were 3,274 client gateway/wait events and 336 unclassified nested client events. They are retained in diagnostics but excluded from the requested nine-class total.

There were zero typed provider-tool output items in the fixed interval. A read-only schema survey across the broader local archive found 2,374 aggregate `web_search_call` items outside the fixed interval. This shows that the raw format can sometimes expose a typed server item, but the unbounded historical count is not used as a fixed-window billing receipt, paired experiment, or quota-mechanism claim.

`replayedToolCallsSkipped` is zero. Unlike token records, tool records do not carry cumulative counters that permit the 35,181 fork-history token replay exclusions to be transferred to tool counts. The client tool totals therefore remain descriptive explanatory features, not a causal per-turn ledger.

## Why no paired pilot was launched

No current class satisfies all of the necessary conditions:

1. a clean no-tool control;
2. a locally observed unit that exactly matches a documented provider billable unit;
3. bounded repetition sufficient to exceed the integer-percentage quota display's resolution;
4. model, effort, context, and token-shape control; and
5. an uncontaminated before/after quota interval.

Web search is the only plausible future candidate. In this fixed interval, however, its 445 observations are client wrapper calls, not typed Responses `web_search_call` units. At `$0.01` per documented API call, even the provisional Milestone 2 diagnostic would imply roughly thousands of calls to approach one displayed percentage point. That sensitivity calculation is illustrative only—the provisional capacity is non-identifiable, and API pricing is not the subscription formula. Launching that workload would therefore spend resources without resolving the mechanism.

The other classes fail more directly:

- local shell and Apply Patch are client operations, not hosted containers;
- Code Interpreter and Hosted Shell lack provider session, size, and duration telemetry;
- Computer Use lacks a separately priced action unit in current standard API pricing;
- MCP has no separately listed standard API per-call price; and
- subagent orchestration has no separate API orchestration unit, while child model tokens must be attributed independently.

## Classification semantics

- **Supported** would require a matching provider unit and usable evidence. There are zero supported classes in the fixed interval.
- **Unsupported** means the observed local event is not a valid separately priced API unit. It does not prove that the operation has zero effect on Codex subscription quota.
- **Inconclusive** means provider-unit observability, clean pairing, resolution, or attribution is missing.

The result is six inconclusive classes and three unsupported-as-API-unit classes.

## Validation receipts

- Focused analyzer and parser tests: 19 passed, 0 failed.
- Analyzer-specific tests: 9 passed, 0 failed.
- Fixed-window live tool scan: gate passed as `no_safely_identifiable_pair_explained`.
- Produced artifacts are owner-only (`0600`).
- The deterministic artifact contains aggregate descriptors and official public source links only.

## Artifacts

- `.usage-monitor/tool-mechanisms-v0.3.json`
- `.usage-monitor/2026-07-23-tool-mechanism-report.md`
- `src/tool-mechanism-analysis.js`
- `test/tool-mechanism-analysis.test.js`

## Gate verdict

`proceed` — the evidence-linked matrix is complete and explains why no safe identifiable pair exists now. A future typed web-search experiment remains conditional on an exact server unit, a clean quiet window, repeated paired transitions, and a stop budget appropriate to the display resolution.
