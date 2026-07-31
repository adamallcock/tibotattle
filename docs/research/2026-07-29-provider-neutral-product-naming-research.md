---
title: Provider-Neutral Product Naming Research
date: 2026-07-29
type: research
status: complete-candidate-not-selected
---

# Provider-Neutral Product Naming Research

## Decision

Do not launch the consumer product publicly as **Usage Monitor**. Keep that
name only as an internal working label until a replacement has passed final
clearance and a small comprehension test.

The leading candidate from this pass is:

> **Quota Trace**  
> Private insight into coding-agent usage and limits.

The strongest alternate is **QuotaCrest**. It is likely more distinctive
because it is more coined, but it communicates the product less clearly; that
is a naming judgment, not stronger clearance evidence. **Meterloom** is the
strongest fully coined route if the product later needs a brand that can
stretch beyond subscription quotas.

This is a research recommendation, not a rename or legal clearance. Do not
change bundle identifiers, package names, URL schemes, release assets, or
domains until the owner chooses a candidate and a professional confusion
search is complete.

## Why the master brand should be provider-neutral

The product is not inherently a Codex utility:

- Codex is the first consumer collection surface.
- Claude Code transcript normalization, status-line quota capture, and
  content-free export machinery already exist in the source tree, with
  accepted semantics for deduplicating Claude's cumulative transcript rows.
- The central model is provider-neutral: compare provider-reported limits with
  locally reconstructed usage, API-price-equivalent cost, evidence quality,
  and delayed community observations.
- Provider names belong in source cards and compatibility copy, not in the
  master brand.

The intended architecture is therefore:

| Layer | Recommended wording |
|---|---|
| Master brand | Provider-neutral, e.g. **Quota Trace** |
| Product descriptor | **Private insight into coding-agent usage and limits** |
| Provider cards | **Codex**, **Claude Code**, and later supported tools |
| Measurement label | **API-price equivalent**, never “your bill” |
| Allowance label | **Estimated limit** or **provider-reported remaining** |
| Evidence label | **Observed**, **estimated**, **incomplete**, or **unknown** |

This structure survives a future in which Codex and Claude Code have different
quota windows, token semantics, account boundaries, and provider endpoints.

## Product promise the name must preserve

The product:

1. reads provider logs locally and derives an allowlisted, content-free
   metadata set;
2. reconstructs usage and a current API-price equivalent;
3. observes provider-reported quota movement where available;
4. estimates a relationship only when the evidence supports one;
5. can contribute privacy-minimized observations to delayed community
   aggregates; and
6. does not claim that API cost equals a subscription charge or that inferred
   limits are provider-authoritative.

The name should therefore describe a **view, trace, signal, or interpretation**.
It should not claim billing authority, exact spend, entitlement management, or
control of a provider account.

## Current market and collision evidence

The generic category is already crowded:

| Product | Verified public proposition | Naming implication |
|---|---|---|
| [CodexBar](https://github.com/steipete/CodexBar) | A multi-provider macOS app and CLI for limits, reset times, local cost scans, and provider status, including Codex and Claude | Avoid `Bar`, provider-led names, and a generic “all limits” promise |
| [ccusage](https://github.com/ccusage/ccusage) | Local daily, weekly, monthly, session, token, and cost reports across Claude Code, Codex, and many other coding agents | Local multi-provider cost aggregation is not a distinctive naming territory |
| [coding_agent_usage_tracker](https://github.com/Dicklesworthstone/coding_agent_usage_tracker) | One CLI for remaining quota, rate limits, and cost across several coding agents | `coding agent usage tracker` is a category description, not a defensible brand |
| [Leet Agent Tracker](https://www.npmjs.com/package/%40leettools%2Fleet-agent-tracker) | A local-first Codex and Claude dashboard backed by a local warehouse | `Agent Tracker` is already occupied and can imply content surveillance |
| [Usage Monitor for Claude](https://github.com/jens-duttke/usage-monitor-for-claude) | A Windows tray app for Claude rate-limit windows and reset alerts | The current name has a near-verbatim active collision |
| [AI Usage Monitor](https://chromewebstore.google.com/detail/ai-usage-monitor/ifioneilgbldbkbdhagahemiehhdfoin) | A browser extension that combines official Codex, Claude, and Cursor usage pages | The generic category phrase is already used publicly |
| [LimitLens](https://www.npmjs.com/package/limitlens) | A local-first Codex and Claude quota-intelligence package published July 28, 2026 | Reject **Limit Lens** despite its strong semantics; this is a direct, current collision |

The opening is not “another usage monitor.” It is an evidence-aware product
that helps provider quota, local token history, API-price equivalents, and
uncertainty explain one another without pretending they are the same ledger.

## Naming criteria

Candidates were screened against these requirements:

1. **Provider neutrality:** no OpenAI, Codex, Anthropic, or Claude in the master
   name.
2. **Claim safety:** does not imply authoritative billing, balances,
   entitlements, or exact provider accounting.
3. **Product fit:** can cover limits, history, cost equivalents, evidence
   quality, and community comparisons.
4. **Consumer comprehension:** pronounceable, memorable, and usable in
   onboarding without an explanation paragraph.
5. **Lowercase readability:** the concatenated package/domain form must remain
   easy to parse.
6. **Distinctiveness:** avoids the saturated `meter`, `gauge`, `bar`, `watch`,
   `tracker`, `dashboard`, and `monitor` pattern where possible.
7. **Preliminary ownability:** no exact active software/package result in the
   checked registries and no current registration record from the checked
   domain RDAP service.
8. **Extension:** should still work if the product later supports other coding
   agents or separates local, hosted, and menu-bar experiences.

## Ranked shortlist

### 1. Quota Trace — recommended candidate

Why it works:

- `Quota` identifies the consumer problem rather than a provider.
- `Trace` describes an evidence trail and interpretation, not a bill.
- It naturally accommodates history, reset windows, cost-versus-quota
  comparison, residuals, and evidence quality.
- `quotatrace` is readable in lowercase.
- The master brand can support Codex, Claude Code, and later provider cards.

Preliminary signals checked July 29, 2026:

- exact USPTO wordmark search: no results;
- exact npm package: no record;
- exact PyPI project: no record;
- exact GitHub repository-name search: zero results in the completed query;
- `quotatrace.com`, `quotatrace.app`, and `quotatrace.dev`: no registration
  record returned by the respective registry RDAP queries; and
- exact-name general web searches: no dominant software product found.

Risks:

- `Quota` also appears in sales, storage, telecom, and admissions products.
- `Trace` can sound like behavioral tracking. Privacy copy must immediately
  say that prompts, responses, commands, paths, and account names stay out of
  the contribution.
- The name becomes less natural if the product expands from subscription
  limits into general API spend governance.

Recommended lockup:

> **Quota Trace**  
> Private insight into coding-agent usage and limits.

Alternative launch copy:

> See the local usage behind your Codex and Claude Code limits.

### 2. QuotaCrest — strongest ownability alternate

Why it works:

- short, pronounceable, provider-neutral, and readable as `quotacrest`;
- no obvious billing-authority claim; and
- clean preliminary exact-name package, repository, trademark-search, and
  `.com` RDAP signals in this pass.

Risks:

- `Crest` does not tell a new user that the product measures or explains usage;
- it can imply a peak rather than remaining capacity; and
- it has a strong existing [consumer-brand association](https://crest.com/) in
  the United States, even though the exact compound returned no result; and
- it requires the descriptor everywhere until the brand is established.

Recommended lockup:

> **QuotaCrest**  
> Understand your coding-agent usage and limits.

### 3. Meterloom — strongest coined alternate

Why it works:

- highly distinctive in the checked exact-name searches;
- can stretch from quota analysis into cost, community, and additional
  providers; and
- “loom” suggests weaving several incomplete signals into one view.

Risks:

- it is not self-explanatory;
- `meter` belongs to the most crowded category vocabulary; and
- some users may parse it as a physical-meter or textile product; and
- [Loom](https://www.loom.com/) is an established software brand, creating
  practical confusion risk even though the exact USPTO, package, repository,
  and checked-domain queries were clean.

Recommended lockup:

> **Meterloom**  
> Your private view of coding-agent usage.

### 4. QuotaMinder — clearest consumer alternate

Why it works:

- easy to pronounce and understand;
- provider-neutral; and
- clean preliminary exact-name registry signals.

Risks:

- sounds primarily like an alert or reminder utility;
- understates the product's historical inference and community analysis; and
- “minder” can feel slightly paternalistic.

### 5. UsageTally — descriptive fallback

Why it works:

- immediately understandable;
- provider-neutral; and
- broad enough for tokens, cost equivalents, and events.

Risks:

- weakly distinctive;
- suggests counting rather than explaining quota movement; and
- `UsageTally` already appears as a technical class name in unrelated software,
  even though no exact standalone package or app dominated the screen.

## Names and territories to reject

| Name or territory | Decision | Reason |
|---|---|---|
| **Usage Monitor** | Reject for public brand | Near-verbatim product collision and extremely low search distinctiveness |
| **AI Usage Monitor / Usage Tracker** | Reject | Existing products already use the exact category phrase |
| **Limit Lens** | Reject | Exact `limitlens` npm competitor for Codex and Claude quota intelligence; `.com` is registered |
| **Codex… / Claude…** | Reject as master brand | Provider-bound, hard to extend, and based on third-party marks |
| **Meter / Gauge / Bar / Watch / Tracker** compounds | Usually reject | Saturated category vocabulary; only use inside a genuinely distinctive coined name |
| **Billing / Spend / Credits / Allowance / Rate Card** | Reject | Overstates what local logs and API-price equivalents establish |
| **Ledger** compounds | Deprioritize | Sounds authoritative and accounting-led; existing usage-ledger software also crowds the term |
| **RunCost Monitor** | Deprioritize | [RunCost](https://www.npmjs.com/package/runcost) is better treated as an accounting component or methodology than the consumer umbrella |
| **QuotaLoom / LimitLoom** | Deprioritize | Semantically attractive, but `Loom` is already a prominent software brand |

## Preliminary clearance method and limitations

The screen used current exact-name checks against:

- [USPTO Trademark Search](https://tmsearch.uspto.gov/);
- [GitHub repository search](https://docs.github.com/en/rest/search/search#search-repositories);
- the [npm registry](https://registry.npmjs.org/quotatrace);
- the [PyPI JSON API](https://pypi.org/pypi/quotatrace/json);
- [Verisign `.com` RDAP](https://rdap.verisign.com/com/v1/domain/quotatrace.com);
- [Google Registry RDAP for `.app`](https://pubapi.registry.google/rdap/domain/quotatrace.app);
- [Google Registry RDAP for `.dev`](https://pubapi.registry.google/rdap/domain/quotatrace.dev);
- Apple Search API exact-name results for US Mac software; and
- general exact-name web searches.

A `404` or empty exact-name result means only that the queried service returned
no current record. It does not guarantee that a name is legally clear,
purchasable, affordable, unreserved, available in every country or class, or
free from phonetic and confusingly similar marks. Search APIs can also be
rate-limited or incomplete.

## Required gates before a rename

1. Owner chooses one lead and one fallback.
2. Run a professional trademark confusion search for software, downloadable
   applications, hosted analytics, and related services in intended markets.
3. Confirm actual checkout availability and price for the preferred domain;
   check app-store, package, GitHub organization, and major social handles.
4. Test the name and one-sentence descriptor with at least five unfamiliar
   coding-agent users. Ask:
   - What do you think this product does?
   - Do you think it is an official provider or billing product?
   - What data do you think it reads or uploads?
   - Can you spell the name after hearing it once?
5. Freeze the selected display name, lowercase slug, bundle identifier, URL
   scheme, state-directory migration, release-site metadata, updater identity,
   and old-name compatibility plan in a dated decision record.
6. Only then update the centralized product-brand configuration and execute the
   rename as one reviewed migration.

## Current implementation impact

No code change is needed for this research pass. The application already keeps
the display name, bundle name, executable name, bundle identifier, URL scheme,
state-directory name, and monitored-product label in
`config/product-brand.js`. That makes a later rename tractable, but it does not
remove the need for state migration, updater continuity, old URL-scheme
handling, or release-signing review.

## Final recommendation

Use **Usage Monitor** only as the development codename. Advance **Quota Trace**
to comprehension testing and full clearance, with **QuotaCrest** as the
fallback if ownability proves more important than immediate meaning.

Do not reserve, publish, or rename anything solely from this pass. The next
decision should be evidence from human comprehension plus professional
clearance, not another round of unconstrained name generation.
