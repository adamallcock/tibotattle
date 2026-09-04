---
title: Release 0.1.18 Codex and Astra compatibility assessment
date: 2026-09-03
type: research
status: assessed-and-implemented
---

# Release 0.1.18 Codex and Astra compatibility assessment

## Scope and evidence boundary

This records the initial release-scoping research against `origin/main` at
`9e1c33338297c4ffdd224a22b2a2cfbf589ce62a`, on the new
`codex/release-0.1.18` branch. Its tree
`032785b61a573077d3237d108c911b57b0c43e98` matches the released `v0.1.17`
tree. Local `main` and the isolated website deployment branch are not inputs.

Baseline descriptions and proposed changes below are the **pre-implementation
snapshot**, not current source status. Implementation of the accepted scope is
recorded in the [validation receipt](../reviews/2026-09-03-release-0-1-18-compatibility-validation.md).
This research record retains the primary-source evidence and reasoning that
motivated those changes; it supersedes the completed planning document.
Installed applications, hosted data, and public releases remain outside this
pass. External sources were checked on September 3, 2026 local time
(September 4 UTC). Model availability and applied-update behavior require
separate qualification.

## Recommendation

There are concrete compatibility changes worth including in 0.1.18. Prioritize
model recognition/pricing, evidence-preserving cache analysis, compressed
history coverage, and versioned admin model history. Response-level usage is a
valuable additional source, but must be reconciled with existing records before
it contributes money or tokens. Early-warning and Guardian analytics changes
do not require a new accounting path.

The implementation uses the explicitly permitted legacy-only fallback for new
response records. It does not infer applied effort from a configuration-update
input. See the validation receipt for completed work and remaining gates. This
is not release qualification or proof that the user's account can select Astra.

## Named upstream changes

The first three changes shipped in CLI [0.153.0](https://github.com/openai/codex/releases/tag/rust-v0.153.0)
on September 3; the Astra backport shipped in [0.153.1](https://github.com/openai/codex/releases/tag/rust-v0.153.1)
later that day. The fetched [Learn changelog](https://learn.chatgpt.com/docs/changelog)
still listed 0.152.0 as its newest CLI entry, so release tags and diffs were
checked separately.

| Change | Verified behavior | Recommendation |
| --- | --- | --- |
| [#41912: persist response token usage](https://github.com/openai/codex/pull/41912) | Adds durable response usage and cumulative turn/thread totals; legacy `token_count` continues. Compaction retains a checkpoint copy. | Adopt through response-level reconciliation, not additive summation. Keep legacy fallback. |
| [#42142: early rate-limit warnings](https://github.com/openai/codex/pull/42142) | Plus/Team TUI warning begins at 50% used for approximately five-hour windows; other plans retain 75/90/95 thresholds. | No parser change. Warning text is not a quota sample or a new plan. Existing direct-evidence notification policy stays independent. |
| [#42144: Guardian V2 analytics](https://github.com/openai/codex/pull/42144) | Adds classification/fast-decision analytics, not durable token records. Its model field identifies the parent task, not necessarily the classifier. | Do not charge analytics as model calls or infer reviewer pricing from their model label. |
| [#42605: Astra catalog backport](https://github.com/openai/codex/pull/42605) | Adds an API-supported but hidden catalog entry; no default/picker activation. | Add reviewed identity and prices; separately qualify actual logs and cache-preserving update support. |

### Response usage adoption contract

The [frozen upstream definition](https://github.com/openai/codex/blob/5f79a92e3936274318d2122ae3244e5edd80dd1f/codex-rs/protocol/src/protocol.rs#L2213)
contains `thread_id`, `turn_id`, `session_id`, `root_turn_id`, `response_id`,
per-response `usage`, and cumulative `turn_token_usage`/`thread_token_usage`.
The token vector includes cache writes. Budget units are not serialized.
`compacted.latest_token_usage_record` is a checkpoint, not fresh consumption;
`session_id` identifies the root thread, not necessarily the current child.

Current readers ignore the new record type: provider
[parser](../../src/providers/codex/log-parser.js), unified
[extractor](../../src/local-unified-index-extract.js),
[passive collector](../../src/passive-collector.js), and
[checkpoint adapter](../../src/application/export-sources/codex-checkpoint.js).
This is additive compatibility today, not proof of lost legacy usage.

Before enabling the new source, define precedence, overlap detection and fallback
per response. Neither cumulative totals nor checkpoint copies may be charged
again. Missing upstream usage must stay unavailable. Raw attribution IDs stay
local or enter the existing pseudonymization boundary; arbitrary payload fields
must never pass into derived artifacts. Validate fork, resume, replay, split
rollout, multiple-response turn and interleaved-model cases across every reader.

## Astra cache and effort semantics

The relevant capability is conditional: `configuration_update` can change
effective effort while retaining the original request-level prefix. It currently
supports standard, single-agent operation only. The response's
`reasoning.effort` still reports the original request setting. Automatic
compaction/truncation and `/responses/compact` are incompatible; explicit
`compaction_trigger` is allowed, followed by a fresh update. Normal cache
requirements still apply. [Reasoning guide](https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation)

The [released Codex catalog](https://github.com/openai/codex/blob/5cc1c94b8e3226c5a343b2f4fe77bf0585234f50/codex-rs/models-manager/models.json#L4)
does expose all six requested choices: low, medium, high, xhigh, max and ultra.
However, [the request mapping](https://github.com/openai/codex/blob/5cc1c94b8e3226c5a343b2f4fe77bf0585234f50/codex-rs/core/src/client.rs#L186)
maps Astra Ultra to API `xhigh` using the model's override, with proactive
delegation enabled. It is not a sixth API effort. Do not treat Max/Ultra as the
same configuration, or assume a transition into Ultra qualifies for single-agent
cache continuity.

[#42328](https://github.com/openai/codex/pull/42328) adds durable configuration-update
protocol/provenance handling on newer upstream main. Its
[configuration-update source](https://github.com/openai/codex/blob/0d502a423031396a8d11c096e5b9f1cb0d30b3d0/codex-rs/protocol/src/models/configuration_update.rs)
was absent from the inspected 0.153.1 tag. Persistence support itself also does
not prove ordinary Codex setting changes emit applied updates. Keep this as an
explicit installed-client/log qualification gate.

### What actually needs changing in TiboTattle

- The [cache lens](../../src/cache-switch-impact.js) already requires a measured
  cache-read drop, complete components, sufficiently close events and no known
  compaction. It does **not** automatically zero cache on an effort change.
  Preserve those controls and distinguish an observed miss from its inferred
  relationship to a settings change. Never hide a real Astra cache drop.
- Its global Max/Ultra equivalence at line 181 is no longer a defensible universal
  rule. Update it alongside the mirrored browser validator and
  [thread-link resolver](../../src/local-cache-drop-thread-links.js), using
  reviewed model/mode semantics. Cache compatibility and equal effective
  configuration are different concepts.
- The index already preserves all six raw effort labels with stable ordinals;
  no enum extension or ordinal reorder is needed. A future update parser must
  distinguish original/requested effort, effective effort and evidence source.
  Do not overwrite one with the other or infer an applied update from a preference.
  Review trusted harness provenance and reject unsupported/custom labels safely.
- Carry this distinction through full/incremental/worker extraction, fork/history
  seeds, compaction, stored schema, cache analysis and browser projection. Current
  `response_item` handling extracts tools, not configuration-update effort.
- Fix the independently verified missingness defect: extractor
  `normalizeUsage` at line 163 uses `value[key] ?? 0`, and numerical components
  reach SQLite without availability metadata. Synthetic omitted cache fields
  and explicit zero produce identical complete events. The provider scanner
  preserves presence separately, so the two paths disagree. Missing cache-read
  or cache-write evidence must remain unavailable end to end; it must not
  manufacture a measured miss. This is a baseline defect, not a claim that actual
  Astra logs omit those fields.

Cache writes are already separate components in the accounting kernel and cache
counterfactual. Keep them separate: input total consists of ordinary input,
cache reads and cache writes; output reasoning is part of output billing, not a
second output charge. Modern cached-token counts can be exact rather than
128-token multiples. Existing successful cache reuse is not evidence that a
later request must hit. [Prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)

## Verified Astra pricing and context

All supplied price cells match the fetched [official API tables](https://developers.openai.com/api/docs/pricing).
Amounts below are USD per million tokens, in input / cached input / cache write /
output order.

| Tier | Short context | Long context |
| --- | --- | --- |
| Standard | 10 / 1 / 12.5 / 50 | 20 / 2 / 25 / 75 |
| Batch | 5 / 0.5 / 6.25 / 25 | 10 / 1 / 12.5 / 37.5 |
| Flex | 5 / 0.5 / 6.25 / 25 | 10 / 1 / 12.5 / 37.5 |
| Fast / Priority | 20 / 2 / 25 / 100 | 40 / 4 / 50 / 150 |

The [registry](../../packages/accounting/src/price-registry.js) has no Astra cards.
Add eight explicit cards plus source/version provenance, using the canonical
`gpt-6-astra` ID. Do not invent `gpt-6t` or wildcard family aliases. Keep review
time separate from rate-validity time; the September 3 release is documented,
but older models' historical price epochs must not change.

The [Astra model card](https://developers.openai.com/api/docs/models/gpt-6-astra)
says long pricing applies above 272,000 input tokens to the entire request.
The existing helper instead starts long at exactly 272,000 for every banded
model. Resolve this explicitly for Astra with tests at 271,999 / 272,000 /
272,001; do not silently reuse the legacy boundary or rewrite historical model
contracts in this addition. Context-band selection uses per-request total input,
not cumulative thread input or nominal model context capacity.

API capacity is 1,050,000 total tokens, with 922,000 maximum input and 128,000
maximum output. The inspected Codex catalog separately configures 272,000
default and 872,000 maximum context. Neither is the observed request input or
proof that the account enables the maximum.

API Fast is 2x Standard. Codex's [credit schedule](https://learn.chatgpt.com/docs/pricing)
separately says 2.5x for Astra Fast. Preserve the accepted
[API-equivalent pricing decision](../decisions/2026-08-30-fast-priority-published-pricing.md):
use the verified API ratio, not a credit multiplier. Neither ratio establishes
a universal subscription-quota conversion. Published task-per-allowance
comparisons are estimates, not calibration constants.

The model guide also specifies no `none` effort, no sampling/logprob controls,
Responses-only tool calling, and no Astra Fast with EU data residency. These are
API-client restrictions; TiboTattle should recognize observed evidence without
becoming a new inference client or guessing user region/entitlement.
[Astra migration guide](https://developers.openai.com/api/docs/guides/latest-model#migration-quickstart)

## Other compatibility changes

### Compressed shared histories: high priority

[#42039](https://github.com/openai/codex/pull/42039), included in 0.153.0, expands cold
`.jsonl.zst` compression to shared/forked histories. Our
[discovery code](../../src/providers/codex/log-sources.js) deliberately quarantines
compressed thread groups with `codex_rollout_compression_unsupported`. Both full
index building and incremental ingestion use this discovery. Coverage remains
explicitly partial, but a CLI update can make more history unreadable.

Add read-only, bounded streaming decompression compatible with supported
runtimes; do not decompress or rewrite the user's source tree in place.
Preserve graph validation, source identity, line/decompressed-byte/resource
bounds, cancellation and replay deduplication. Test compressed parents, children,
mixed physical generations, truncation and hostile expansion. Until supported,
retain explicit coverage diagnostics and preserve previously accumulated facts.

### Useful telemetry that is not an offline accounting source

- [#41980](https://github.com/openai/codex/pull/41980) retains upstream usage metadata
  on `rawResponse/completed`. The [released rollout policy](https://github.com/openai/codex/blob/5cc1c94b8e3226c5a343b2f4fe77bf0585234f50/codex-rs/rollout/src/policy.rs#L140)
  excludes that notification; durable token records do not contain its raw
  metadata. Do not promise to recover raw amounts or tiers from offline logs.
- [#41944](https://github.com/openai/codex/pull/41944) emits estimated workspace-visible
  turn costs after response settlement. This could support a separate
  provider-reported comparison, but it is not universal billing authority or a
  replacement for API-equivalent accounting. Access, persistence and coverage
  remain unqualified. No authenticated probe or new telemetry capture was run.
- [Async tools](https://developers.openai.com/api/docs/guides/async-tool-calling) and
  [steering](https://developers.openai.com/api/docs/guides/steering) require regression
  cases for overlapping calls, late results and multiple responses. A steered
  incomplete response is not necessarily failed/unbillable work. Match actual
  usage identity rather than assigning one response per UI turn.
- [Misalignment monitoring](https://developers.openai.com/api/docs/guides/safety-checks/misalignment-monitoring)
  can stop work after some output/actions. Do not erase observed consumption on
  a stop, infer a refund, or copy safety payloads into diagnostics. The monitor
  need not implement inference retries, safety webhooks or tool execution.

## Admin per-model dashboard

The baseline has four pinned models: Sol, Terra, Luna and GPT-5.5, with no GPT-6.
The roster is duplicated in [Worker](../../apps/worker/src/admin-community-allowance.ts)
and [browser](../../apps/web/public/admin-client.js). Rendering is already
iterative; the contracts and upstream identity recognition are the larger work.

Two measured traps prevent a simple list expansion:

1. Stored model days must match the current roster exactly. The reader discards
   days failing validation, so adding models can silently remove old history.
2. The complete preview limit is 131,072 bytes. A synthetic 70-day history for
   the registry's 34 actual OpenAI models occupies **145,181 bytes for model
   days alone**, even with null capacities and zero counts. This excludes all
   outer preview/plan data. Per-day and composition caches also have 16 KiB caps.

The [export registry](../../src/export/registries.js) recognizes only 12 Codex IDs,
despite those 34 priced models. Index construction maps unreviewed IDs to
`unknown` before persistence. A chart-only change therefore cannot recover
Astra or older Codex identities already discarded. The synthetic provider-tool
price card is not a model and must be excluded from catalog generation.

Recommended design:

- One reviewed shared catalog with identity, provider, label, allowance track,
  and price/support metadata; derive appropriate reviewed identities from
  pricing and add explicit Codex-only identities. Use a package/generator
  boundary, not another duplicated list or unrestricted model-name passthrough.
- Versioned, sparse daily summaries with an explicit historical interpretation.
  Preserve old four-model days. Newly added models absent in those days mean
  not recorded, not zero use or zero supporting participants.
- List all reviewed potential models, emphasizing identified/observed models
  and providing filtering for the rest. Keep unknown/unreviewed activity visible
  as content-free diagnostics. Sharing a price card is not proof of identical
  model identity or quota-capacity behavior.
- Separate visibility from estimation. Existing model-composition share,
  observation-count, stability, plan, account, provider and continuity gates stay.
  Unpriced bins must not enter fits with understated cost. Spark remains a
  separate allowance/unpriced diagnostic, not primary Codex capacity.
- Do not infer unseen, unpriced, below-threshold or unstable from a null capacity
  alone. Distinguishing these requires a bounded model census before filtering.
- Preserve scheduled computation and cache-only admin reads. Regenerate the
  Worker-served UI from its source; do not hand-edit generated assets or change
  the public allowance estimate as part of admin expansion.

## Accepted implementation scope

This was the agreed implementation sequence. It is retained to explain scope;
the validation receipt, not these original acceptance criteria, records results.

1. **Identity and pricing:** extend reviewed recognition and eight Astra cards;
   reconcile legacy schema enums, active v1 projection, generators and public
   package types. Test older non-5.6 models, Astra, aliases, unknowns, Spark,
   all tiers, exact context boundaries and event-time provenance. Prove local
   and Worker numerical parity.
2. **Ingestion integrity:** fix missing-component preservation; add compressed
   source support with replay/resource controls. Adopt response records only
   after old/new/checkpoint reconciliation passes, or leave them ignored with
   an explicit compatibility test. Preserve cancellation and malformed-input
   behavior across the passive, checkpoint and unified readers.
3. **Cache/effort:** remove universal Max/Ultra equivalence; qualify the actual
   configuration-update format/client before recording effective effort. Test
   retained cache, real drops, mode/model changes, missing metadata, compaction,
   fork/resume and full-versus-incremental-versus-worker parity. Update the
   explanatory copy in all three locales and exact thread-link resolution.
4. **Admin history:** introduce a bounded shared roster and sparse versioned
   projection. Test old-history survival, maximum 70-day payload sizes, unsafe
   IDs, empty/sparse states and existing estimator refusals. Render and inspect
   the actual admin interface before claiming UI completion.
5. **Derived-data compatibility:** advance affected parser/projection/cache
   versions; retained events normalized to unknown or zero require a safe source
   reparse to recover evidence. Preserve the prior index and last-good generation.
   Repricing must invalidate local/Worker fit caches. Do not relabel physical
   schemas or reuse stale receipts. R7 regeneration remains a separate protected
   release operation.

Start with relevant existing suites: cache-switch/thread-links, Codex parser and
discovery, unified-index, price-registry/local-api-pricing/subscription-speed,
quota model composition, Worker admin/server-pricing and browser admin tests.
Then run architecture, schema/generator mirrors and Worker package-copy checks.
Broaden to root/Worker/UI gates after shared contracts change. Source tests,
installed app behavior, signed artifacts and release/deployment remain separate.

## Research verification boundary

The baseline tree/tag equality, synthetic missing-component reproduction and
dense-history sizing were verified without private session data. The installed
ChatGPT-bundled CLI reported `0.153.0-alpha.5`; its narrow
`check-codex-contract-drift` inspection passed with 17 PlanType values. That
proves plan-enum compatibility only, not new rollout or Astra functionality.
Independent upstream/admin source reviews found no substantive research errors.

Dependencies were subsequently installed from frozen manifests and runtime
suites executed during implementation. Their exact outcomes, release-evidence
failures and untested client capabilities are recorded in the
[validation receipt](../reviews/2026-09-03-release-0-1-18-compatibility-validation.md).
