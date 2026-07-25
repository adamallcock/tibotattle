---
title: G2 Provider-Neutral Pricing and Accounting Plan
date: 2026-07-25
type: plan
status: active
---

# G2 Provider-Neutral Pricing and Accounting Plan

## Purpose

Implement the first independently testable accounting slice of the [end-to-end multi-user usage-monitor goal](./2026-07-24-end-to-end-multi-user-usage-monitor-goal.md): a local-only, provider-neutral API-price-equivalent ledger for Codex/OpenAI and Claude/Anthropic evidence. The ledger must improve the cost-versus-quota calibration without implying that public API prices are the provider's subscription allowance formula.

This slice may proceed while G1 release-ceiling work remains open. It does not authorize upload, server storage, participant enrollment, or public reporting, and it does not claim G2 or G6 completion.

## Owner direction — July 25, 2026

The current implementation scope is OpenAI/Codex accounting. Claude production integration is paused, but the shared ledger, schemas, and adapter boundaries must remain provider-neutral so Claude can resume without a second accounting system.

For this subscription-monitoring proof of concept, do not implement regional or data-residency uplifts. The observed Codex subscription evidence does not identify an API processing region, and a subscription surface must not be treated as though it selected an API regional-processing option. A future explicitly API-billed observation may use a regional price row only when the event records the exact supported region and the official price evidence covers it.

The next completion pass should therefore:

- preserve unknown provider-billable units rather than turning them into zero;
- reconcile independently observed provider tool costs into every supported rollup;
- use the same streaming reducer and normalized component contract for every provider adapter;
- complete the OpenAI tier/component/threshold golden matrix;
- complete account-snapshot continuity and schema-drift tests; and
- rerun the measured R7 receipt only at the next release checkpoint, after source changes settle.

## User-facing question this slice answers

For every locally observed usage event, calculate the portion of an API-price-equivalent cost that is directly supported by:

- a reviewed provider/model identifier;
- observed token or provider-billable-unit components;
- a declared API processing tier or an explicitly labeled Standard-price counterfactual;
- a provenance-bound price row; and
- an applicable context, region, and price/evidence epoch.

The result must say what was priced, what was not priced, why, and which price evidence produced each component. It must remain separate from observed subscription quota movement so the downstream analysis can fit the relationship rather than assume it.

## Permanent accounting rules

1. Preserve exact token components and exact decimal money strings through the ledger. Convert to floating point only in a presentation layer that labels the loss of precision.
2. Missing or unavailable components are not observed zero. A normalized numeric zero may be priced only when the adapter's availability contract says the component was observed.
3. Anthropic five-minute and one-hour cache writes are disjoint. Never charge their sum and the aggregate cache-creation field together. When the TTL split is unavailable, retain the aggregate quantity as unpriced with a fixed reason.
4. OpenAI reasoning tokens and Anthropic combined output may use the provider's ordinary output rate only through an explicit pricing policy recorded on the component. Never invent text/reasoning proportions.
5. Codex subscription Standard/Fast and Claude subscription speed are not API service tiers. API Standard, Priority, Flex, Batch, Anthropic fast inference, and regional processing require their own provider evidence.
6. A tierless catalog row cannot price a non-Standard API tier. Unsupported tier/model combinations fail closed.
7. Client tools are explanatory metadata. Tool cost is added only for an independently observed provider billable unit with an exact unit and price row.
8. Unknown models, aliases, components, context thresholds, tiers, regions, and price epochs remain unknown. A keyed model fingerprint is never a pricing alias.
9. Provider-side daily/lifetime/account totals remain independent crosschecks. They never overwrite event evidence or allocate a residual to an unsupported surface.
10. Pricing is a derived local artifact in this slice. No cost-ledger record is added to the outbound telemetry contract.

## Price-evidence contract

Each reviewed price card must contain:

- provider, API surface, canonical model, reviewed aliases, and API service tier;
- exact decimal price per exact unit for every supported component;
- applicable context threshold, region, and vendor-declared effective interval when known;
- observation/retrieval timestamp distinct from vendor effective dates;
- official source URL, registry version, and deterministic evidence hash; and
- explicit assumptions, including any product-model alias used only as a counterfactual.

The checked-in registry is the deterministic offline baseline. RunCost remains the calculation kernel and may resolve external catalogs for diagnostics or gap discovery, but an external row cannot silently replace the reviewed baseline or broaden a tier/model alias.

The first reviewed sources are:

- OpenAI API pricing: <https://developers.openai.com/api/docs/pricing>
- Anthropic Claude pricing: <https://platform.claude.com/docs/en/about-claude/pricing>

Neither page's retrieval date is treated as proof that every displayed price was effective for all earlier history. Historical event-time pricing is authoritative only where a vendor-declared effective boundary or a retained contemporaneous snapshot supports it. Otherwise the result is labeled a current-price or observed-price-epoch sensitivity.

## Work packages

### P1 — Registry and validation

- Replace destructive model-only supplementation with an additive, provenance-bound registry.
- Cover every currently reviewed OpenAI model for which official evidence exists. Retain the provider-neutral registry contract for a later Claude resumption.
- Preserve `gpt-5.5-codex` only as an explicit reviewed API-price counterfactual alias, not as a claim about a public API SKU.
- Represent exact supported OpenAI Standard, Batch, Flex, and Priority rows rather than assuming universal multipliers.
- Reject invalid/overlapping cards, unsupported tier names, absent provenance, ambiguous aliases, and fabricated effective dates.
- Produce deterministic registry version and content hash.

### P2 — Provider-neutral cost ledger

- Accept normalized provider usage components only; never raw logs or responses.
- Return exact component costs, total, card identifiers, policies, provenance, and coverage status.
- Separate informational RunCost warnings from monetary-coverage failures.
- Compute coverage denominators for events and token components.
- Fail closed for unknown model, tier, TTL, component, provider tool unit, or price epoch.

### P3 — Local provider adapters

- Migrate Codex scan, transition mining, and experiment projections to the shared ledger.
- Honor the existing component-availability contract instead of pricing unavailable fields as zero.
- Keep the Claude adapter boundary and normalized component vocabulary compatible with the shared ledger, but defer Claude production pricing, source integration, and reports.
- Retain compatibility projections while reports migrate, but bind them to a method/version/registry hash.

### P4 — Tier, tool, and context semantics

- Carry observed API processing tier separately from an assumed pricing tier.
- Keep subscription speed weights in a separate quota-sensitivity view.
- Centralize exact provider web/file/container/server-tool units; remove duplicate hand multiplication.
- Retain long-context thresholds and unavailable context as coverage evidence.
- Defer region-aware pricing for subscription-derived observations. Fail closed unless a future explicitly API-billed event records the applicable supported region.

### P5 — Provider accounting crosscheck contract

- Define a strict local-only `providerAccountingSnapshot` fixture for provider-authoritative account/time-bucket totals.
- Keep raw account identifiers and arbitrary provider strings out of the contract.
- Exercise two-account switches, unattributed gaps, plan changes, identity rotation, and schema drift.
- Do not add this family to outbound telemetry until a separate minimization review authorizes it.

### P6 — Reconciliation and reports

- Reprice frozen and real local histories with the new ledger.
- Compare exact component totals against independent RunCost/ccusage projections using declared tolerances and fixed reason codes.
- Produce event-time results only where price epochs are supported; always offer a clearly labeled current-price sensitivity.
- Update the simple quota-gradient and weekly-limit analyses to show priced coverage, missing components, and tier/speed basis.
- Retain observed quota movement as the dependent evidence and API cost as the explanatory counterfactual.

## Test matrix

The frozen golden matrix must cover:

- OpenAI Standard, Batch, Flex, and Priority rows where officially supported;
- subscription Standard/Fast values that never select API Priority;
- Anthropic Standard, batch, fast, and regional modifiers only where exact rows apply;
- uncached input, cache read, five-minute write, one-hour write, text output, reasoning output, and combined output;
- below/at/above long-context boundaries;
- known aliases, unknown models, unknown aliases, unknown tiers, missing region, and missing price epochs;
- observed zero versus unavailable component;
- provider-billable web/file/container/server-tool units and client-tool non-pricing;
- exact decimal aggregation without binary-floating drift;
- same event under event-time and current-price sensitivity;
- provider schema additions and component drift failing closed; and
- local-only provider accounting snapshots across rapid account switches and unattributed gaps.

## Evidence and release gates

This slice is accepted as an implementation checkpoint only when:

1. registry and ledger unit suites pass under the pinned Node 24 and current Node 26 runtimes;
2. existing Codex, Claude, tier, tool, gradient, weekly, privacy, and telemetry tests remain green;
3. no raw content or new outbound telemetry fields are introduced;
4. every unpriced component has a stable machine-readable reason;
5. every priced component names an exact card and registry hash;
6. non-Standard tiers cannot use tierless or Standard rows;
7. historical repricing does not rewrite frozen reports or corrections in place;
8. a focused code-quality and test/documentation audit finds no unresolved correctness issue; and
9. a dated verification receipt records fixtures, runtime versions, registry hash, coverage, deltas, and remaining gaps.

Formal G2 remains blocked on the complete provider conformance and account-continuity matrix, including an authenticated non-null Claude quota observation. Formal G6 remains blocked on canonical server storage and exact local/server parity. Those are explicit later gates, not reasons to delay this deterministic local kernel.

## Parallel ownership for this cycle

- Registry worker: price cards, provenance, validation, and registry tests.
- Ledger worker: provider-neutral exact cost/coverage calculation and golden tests.
- Accounting-contract worker: local-only provider snapshot schema and conformance fixtures.
- Integration owner: Codex/Claude adapters, compatibility projections, report migration, full validation, and milestone receipt.

Workers own disjoint files. Shared adapter and report files are serialized through the integration owner, followed by a full cross-workstream test and privacy pass.
