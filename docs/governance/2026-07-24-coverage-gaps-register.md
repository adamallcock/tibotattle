---
title: Usage Monitor Coverage Gaps Register
date: 2026-07-24
type: research
status: active
---

# Usage Monitor Coverage Gaps Register

## Purpose

This is the side register for activity that may affect a ChatGPT, Codex, or Claude allowance but is not yet observed well enough to allocate confidently. It is deliberately separate from the quota-gradient report: the report shows what the current evidence supports, while this register records missing surfaces, ambiguous accounting relationships, and the next probe that could reduce each uncertainty.

An activity belongs here when at least one of these is unknown:

1. whether it consumes the same provider allowance;
2. whether it leaves a local receipt;
3. whether the receipt includes enough token, model, speed, tool, and account data to price it; or
4. whether provider-side totals can allocate it to that activity.

## Status vocabulary

| Status | Meaning |
|---|---|
| **Covered** | Local receipts and relevant provider snapshots are collected, subject to documented precision limits. |
| **Partial** | Some activity or aggregate usage is visible, but per-turn attribution or accounting semantics are incomplete. |
| **Unobserved** | The activity can occur without a receipt in the current monitor. |
| **Unknown coupling** | Activity can be detected or declared, but it is not established whether it consumes the allowance being modeled. |
| **Not currently used** | The user reports no current use. This reduces present contamination risk but is not instrumentation. |

These labels describe evidence coverage, not whether a feature exists or is billable.

## Prospective marker now available

`usage-monitor mark-activity --surface … --state start|end|pulse` now appends an owner-only, privacy-safe boundary marker. The fixed vocabulary separates ordinary Chat and ordinary Chat Voice from ChatGPT Work, Workspace Agents, ChatGPT for Excel, Codex Cloud, other-device Codex, Work Voice task activity, image generation, and Spark. The marker captures the current Keychain-HMAC account pseudonym when available, but never content, URLs, raw account identifiers, credentials, or free text.

Provider policy checked on July 24, 2026 establishes the coupling boundary: Codex and ChatGPT Work share usage; the authenticated usage UI additionally names ChatGPT for Excel and Workspace Agents. Ordinary Chat conversations are excluded. Ordinary Chat Voice does not consume Codex usage; Work Voice task activity does, while connected Voice time has a separate plan-dependent meter. Image generation consumes the included general usage limit roughly 3–5 times faster on average. GPT-5.3-Codex-Spark has a separate demand-adjusted usage limit. The official pricing source is [OpenAI's Codex pricing page](https://learn.chatgpt.com/docs/pricing).

This improves prospective attribution but does not change a surface to **Covered**: a marker proves only that the owner declared an activity boundary. Allowance coupling, per-turn tokens, hosted units, and provider update lag remain separate unknowns.

## Highest-priority blind spots

| Priority | Blind spot | Why it matters now |
|---|---|---|
| P0 | ChatGPT Work and Workspace Agent requests | They consume the shared agentic allowance without a local Codex rollout receipt. |
| P0 | ChatGPT for Excel | It consumes the shared pool when available but has no local receipt here. |
| P0 | Codex Cloud, code-review, or remote work without a local rollout | Provider aggregates expose these surfaces, but the local cost ledger cannot allocate them. |
| P0 | Account switches and unresolved plan eras | They can create false changes in the inferred quota gradient or weekly capacity. |
| P0 | Third-party clients using ChatGPT/OpenAI authentication | Authentication, API billing, and subscription allowance coupling are distinct and not yet inventoried per app. |
| P0 | Provider policy changes, global resets, and propagation delays | These can look like a changed slope even when the local workload is unchanged. |
| P1 | Voice Mode and voice dictation | They may use audio, transcription, reasoning, or ordinary text-message accounting in different combinations. |
| P1 | ChatGPT mobile/desktop and other devices | They can create invisible shared-pool movement if use begins. |
| P1 | Image generation | It is confirmed to use included general limits roughly 3–5 times faster, but local receipts do not yet contain image quality, size, or exact provider units. |
| P1 | GPT-5.3-Codex-Spark | Its separate demand-adjusted limit must not be fitted as movement in the main shared seven-day pool. |
| P1 | Deep Research, agentic browsing, and other hosted tools | Local client tool counts do not reveal provider-billed units or subscription weights. |

## ChatGPT consumer surfaces

| Surface or mechanism | Current status | What is visible now | Missing or uncertain | Likely effect on analysis | Next evidence or controlled probe |
|---|---|---|---|---|---|
| Ordinary Chat conversations | **Excluded from this pool** | Visible timestamps and model slugs can be inspected when useful, but provider policy says Chat conversations do not consume the Codex/Work shared agentic allowance. | Separate Chat product caps and tokens remain outside this monitor. | No contamination of the Codex seven-day gradient. | Do not run further Chat-only coupling experiments; retain the July 20 audit as a negative control. |
| ChatGPT Work | **Partial / confirmed shared pool** | Provider policy says Work and Codex share usage; aggregate model/surface totals are visible. | No Work-only per-turn token or API-price-equivalent receipt; historical task allocation remains unavailable. | Unallocated shared-pool usage and apparent historical slope changes. | Run a bounded Work-only panel and compare close UI/app-server snapshots with the provider daily bucket after it settles. |
| Workspace Agents | **Unobserved / confirmed shared pool** | The authenticated provider usage UI names Workspace Agents as drawing from the same agentic pool. | No local task receipt, model/token breakdown, or historical allocation. | Invisible shared-pool movement. | Inventory enabled agents and run one quiet bounded agent task with before/after snapshots. |
| ChatGPT macOS/desktop app | **Surface-dependent** | Local Codex/Work task activity is part of the shared pool; ordinary Chat is not. | The generic Desktop App analytics label does not by itself identify Chat versus Work/Codex. | Misclassification if all desktop activity is pooled. | Mark the experience, not merely the client application. |
| ChatGPT mobile or another device | **Not currently used / uninstrumented** | Provider analytics may expose Mobile in aggregate. | No device-local receipts or reliable device attribution. | Hidden quota movement if use begins. | Keep a user-declared activity ledger; add a controlled mobile probe only if usage begins. |
| ChatGPT for Excel | **Not currently used / confirmed shared pool** | Provider policy says it draws from the same agentic usage and credit pool when available. | No local Excel receipt or per-action model/token allocation. | Invisible shared-pool movement if use begins. | Keep excluded while unused; add an explicit Excel marker before the first future test. |
| Ordinary Chat Voice | **Not currently used / excluded from this pool** | Provider policy says ordinary Chat Voice uses separate caps and does not consume Codex usage. | Its separate Voice cap is outside this monitor. | No contamination of the Codex seven-day gradient. | No Codex-pool experiment needed. |
| Voice in Work / Codex desktop | **Not currently used / mixed meters** | Tasks started through Voice consume the existing Codex budget. Connected Voice time uses a separate plan-dependent allowance and can be credit-metered on flexible plans. | No local split between live Voice minutes and task tokens. | Task work can move the shared pool while Voice time moves a separate meter. | Mark `chatgpt_work_voice`; compare task quota and Voice allowance separately. |
| Voice input or dictation | **Not currently used / destination-dependent** | Dictation itself is an input mechanism. | Whether the resulting request is ordinary Chat, Work, or Codex. | Coupling follows the destination experience, not the microphone. | Record the destination surface; do not classify all dictation as shared usage. |
| File upload and document analysis | **Unobserved on ChatGPT surfaces** | A manual activity declaration is possible. | File preprocessing, extracted tokens, vision/OCR, cached content, and hosted-tool units are absent from local Codex receipts. | API-price estimate may understate provider work. | Test a small fixed public document against a text-only control, without retaining the document contents in the monitor. |
| Image input / vision | **Unobserved on ChatGPT surfaces** | Manual activity declaration only. | Image-token calculation, preprocessing, model selection, and subscription weight. | Unexplained quota movement or incorrect text-token proxy. | Use one fixed public image in a bounded panel and retain only dimensions, declared class, and quota deltas. |
| Image generation or editing | **Unobserved / confirmed included-limit consumer** | Provider policy says it uses the same general limits as local messages and cloud chats, roughly 3–5 times faster on average depending on quality and size. | No local image quality, dimensions, exact token/credit units, or provider-update timing. | A material positive residual if image work occurs without a marker. | Mark `image_generation`; compare bounded quality/size panels and retain only low-cardinality settings plus quota deltas. |
| Deep Research | **Unobserved / unknown coupling** | Completion and elapsed time can be declared. | Hidden browsing, model calls, reasoning, citations, and separate product limits. | A single run could create a large residual. | Treat as its own workload class; do not translate it into ordinary message tokens without provider evidence. |
| Agent, browser, or Operator-style work | **Unobserved / unknown coupling** | Only manual task boundaries or provider aggregates. | Hosted actions, retries, computer-use units, and shared-versus-separate caps. | Large, bursty residuals that could distort short smoothing windows. | Isolate one short task and preserve a provider-reset-aligned before/after panel. |
| Custom GPTs | **Unobserved** | Manual activity declaration only. | Base-model tokens, GPT actions, knowledge retrieval, and whether custom integrations use separate API billing. | Mixed hidden usage and tool costs. | Record GPT type and broad action classes, not content; compare a no-action GPT with an action-enabled GPT. |
| Connectors and app actions inside ChatGPT | **Unknown coupling** | Manual declaration or coarse provider activity. | Retrieval/tool units and whether third-party actions add provider-side usage. | Local token-only estimate may miss hosted operations. | Start with a connector-free versus connector-enabled matched test. |
| Canvas and interactive editing | **Unobserved** | Manual declaration only. | Whether background rewrites or executions create multiple accounted turns. | One visible interaction may correspond to several hidden requests. | Use a fixed edit sequence and capture event timestamps plus quota snapshots. |
| ChatGPT scheduled tasks or automations | **Unobserved** | Completion notifications may be visible. | Background execution time, account, model, and allowance coupling. | Quota can move while the local user appears idle. | Maintain an inventory of enabled tasks and annotate their run windows without storing prompts. |
| Temporary, deleted, or history-disabled chats | **Unobserved** | Provider aggregate movement may remain. | Local transcript unavailable by design. | Permanent provider/local residual. | Add manual activity markers; never infer zero use from missing chat history. |

## Codex surfaces

| Surface or mechanism | Current status | What is visible now | Missing or uncertain | Likely effect on analysis | Next evidence or controlled probe |
|---|---|---|---|---|---|
| Codex desktop / extension / IDE | **Covered** | Replay-safe local token components, model, timestamps, surface class, and quota snapshots. | Integer quota precision, provider lag, and some historical speed/account metadata. | Core gradient remains noisy rather than absent. | Continue passive collection and use shorter rolling windows alongside reset-aligned panels. |
| Codex CLI / exec | **Covered** | Classified local rollouts and token usage. | Whether every invocation uses the same login/account marker and whether detached work writes the expected rollout. | Small unallocated gaps or cross-account contamination. | Add prospective account-marker coverage diagnostics by surface. |
| Codex subagents | **Covered with aggregation caveat** | Subagent rollouts are classified and fork replay is excluded. | Provider counters may aggregate nested work differently from local request pricing. | Double-counting if replay/lineage logic regresses; weighting ambiguity even when counts are right. | Keep lineage tests and compare isolated single-agent versus one-subagent panels. |
| Codex scheduled tasks | **Covered locally when a rollout exists** | Scheduled-task rollouts are classified separately. | Cloud-only or failed background attempts may not create retained local receipts. | Quota movement during apparently idle periods. | Cross-check scheduled run timestamps against provider residual spikes. |
| Codex Cloud tasks | **Partial / provider-side unallocated** | Coarse Cloud activity may appear in provider analytics. | Per-task local tokens, account, speed, model, and hosted-tool units. | Provider usage exceeds local receipts. | Capture task start/end and provider snapshots; add a cloud-task receipt adapter if an official export becomes available. |
| Codex code review | **Partial / provider-side unallocated** | Code review may appear as a provider surface. | Per-review tokens, retries, tool work, and linkage to a local repository session. | Bursty unexplained quota consumption. | Isolate one review and compare provider daily/snapshot movement to a declared task marker. |
| Other Codex devices or remote clients | **Not currently used / uninstrumented** | Possibly only a coarse provider surface. | Device, account, and per-turn receipts. | Hidden shared-pool movement. | Add a new client only after verifying whether it writes compatible local rollouts. |
| Standard versus Fast | **Partial** | Prospective and some historical thread settings distinguish subscription Standard from Fast. | Per-request confirmation, unknown historical rows, and any provider-policy multiplier beyond documented schedules. | Wrong quota-weight sensitivity and false time trend. | Run matched isolated Standard/Fast panels on the same model, effort, cache, and context. |
| GPT-5.3-Codex-Spark | **Partial / separate limit** | A separate named Spark bucket is retained when the app server exposes it. Provider policy confirms that it is demand-adjusted and separate from the general limit. | No stable published capacity or API price at launch; the local aggregate cannot always be assigned to Spark. | Main-pool calibration is corrupted if Spark movement is merged into it. | Mark `codex_spark`, retain its named provider snapshot, and calibrate only after at least three isolated Spark windows. |
| Model aliases and unknown models | **Partial** | Most model names and token components are retained. | Unknown model rows, alias changes, unpriced future models, and provider-side routing. | Cost ledger error and apparent slope changes. | Version the model alias/pricing map and quarantine unknowns from precise claims. |
| Failed, cancelled, retried, or interrupted requests | **Partial** | Some local request events and errors exist. | Whether the provider charges quota before failure and how retries are deduplicated. | Local cost can over- or under-predict quota movement. | Add outcome classification and compare controlled cancellation/retry cases only if inexpensive and safe. |

## Authentication and account boundaries

| Surface or mechanism | Current status | What is visible now | Missing or uncertain | Likely effect on analysis | Next evidence or controlled probe |
|---|---|---|---|---|---|
| Switching between the two ChatGPT accounts | **Prospectively covered / historically partial** | Fresh account reads produce privacy-safe pseudonyms; future events can be scoped. | Historical rollouts lack an account subject; quota snapshots attached to old events may still help only within their own reset series. | Mixed-account gradients, false resets, and impossible lifetime reconciliation. | Register each account after intentional switches and never pool reset windows across scopes. |
| $200 Pro 20x versus brief $100 5x era | **Partial** | Current plan assumption and unresolved episode are recorded. | Approximate dates, affected account, and whether a temporary promotion applied. | Structural break mistaken for provider policy drift. | Add approximate episode dates/account alias when available; preserve a wide boundary if only approximate. |
| Third-party app using “Sign in with ChatGPT/OpenAI” | **Unknown coupling** | Nothing is inventoried yet. | Exact client, OAuth scopes, product entitlement, whether requests use a subscription allowance, and whether any local receipt exists. Authentication alone does not prove usage coupling. | Potential hidden consumer or a false suspected contaminant. | Build a local inventory containing app name, broad auth type, account alias, and last-used time—never tokens or secrets—then test one app at a time. |
| App using an OpenAI API key | **Expected separate billing, not yet inventoried** | API activity may have its own provider usage/billing record. | Whether the app truly uses the API key path and which organization/project/tier is billed. | Should not be mixed into a ChatGPT subscription gradient; accidental mixing corrupts the cost model. | Tag billing surface explicitly as `api` versus `chatgpt_subscription` and reconcile API usage separately. |
| Browser extension or IDE using Codex login | **Partial** | Covered if it writes a compatible Codex rollout with a recognized source. | Some clients may authenticate successfully without writing local receipts in the monitored directories. | Hidden usage or incorrect surface classification. | Inventory clients and confirm a test event reaches the collector before labeling the client covered. |
| Multiple simultaneous sessions on one account | **Partial** | Account-level quota movement and local activity on this machine. | Concurrency from other browsers, apps, or machines. | Controlled intervals become contaminated. | Require a quiet-period declaration and flag provider movement with no matching local receipt. |

## Claude surfaces

| Surface or mechanism | Current status | What is visible now | Missing or uncertain | Likely effect on analysis | Next evidence or controlled probe |
|---|---|---|---|---|---|
| Claude Code local CLI | **Partial** | Local usage logs exist; the status-line adapter can retain five-hour and seven-day percentages/resets when supplied. | A live non-null status-line limit payload has not yet been validated; internal subscription weights remain unknown. | No reliable allowance gradient until both receipts and limit snapshots align. | Install or invoke the privacy-safe status-line tap and capture a bounded ordinary turn. |
| Claude Web | **Unobserved** | Manual UI observation only. | Per-turn tokens, model routing, tools, projects/artifacts, and shared allowance coupling with Claude Code. | Hidden movement in Claude limits. | Run a web-only bounded test around status-line/UI limit captures. |
| Claude desktop/mobile | **Unobserved** | Manual declaration only. | Local receipts and cross-device/account allocation. | Hidden shared-pool movement. | Add only if usage begins; first determine whether the same five-hour/seven-day limits move. |
| Claude Fast or other speed modes | **Partial** | A prior OAuth smoke reported standard speed and Fast off. | Subscription multiplier and per-turn certainty for other modes. | Wrong weighting when comparing standard and accelerated requests. | Matched mode test after the quota callback is working. |
| Claude MCP, tools, web search, and computer use | **Unknown coupling** | Client tool calls may be countable. | Provider-billed units and subscription weights. | Token-only estimates may miss hosted operations. | Separate client orchestration from server-hosted units and test tools one class at a time. |
| Claude account switching | **Uninstrumented** | Current authenticated session can be refreshed manually. | Stable pseudonymous scope, historical account attribution, and plan timeline. | Mixed-account limits. | Reuse the Keychain-HMAC account-scope design after confirming a supported non-secret account marker. |

## Cross-cutting measurement gaps

| Gap | Current consequence | Improvement |
|---|---|---|
| Quota is displayed at one-integer-percentage precision | Small real changes are censored; repeated values do not mean zero use. | Model percentages as intervals and aggregate several transitions; do not invent sub-percent readings. |
| Snapshot update lag and stale rollout values | Usage may be attributed to the wrong minute or short rolling window. | Poll the read-only account endpoint, retain snapshot age, and compare several smoothing windows. |
| Reset propagation can vary across the network | A reset may look gradual, regional, or account-specific. | Annotate approximate global reset events with a tolerance window and exclude them from ordinary slope fitting. |
| Absolute allowance denominator is absent | A displayed percentage cannot reveal the underlying token/credit cap directly. | Infer only conditional cost-per-percentage slopes and reset-level ballparks. |
| Provider daily totals are account-level | Work, Workspace Agents, Excel, Codex Cloud, local Codex, and code review cannot be allocated individually. | Preserve an unallocated residual and add controlled included-surface panels. |
| Current provider plan label is too coarse | 5x, 20x, and promotions can be confused. | Maintain an account-scoped, dated owner declaration ledger. |
| Historical account identity is absent | Old local receipts cannot be assigned safely to either account. | Partition by reset identity and contemporaneous snapshot; keep account as unknown. |
| Deleted, expired, moved, or never-retained logs | Local cost is systematically incomplete. | Report retained coverage boundaries and never interpret missing files as zero activity. |
| Long-context and cache weighting | API-price equivalent may not match subscription quota weight. | Preserve input, cached input, output, reasoning, context band, and model; estimate separate sensitivities. |
| Server-hosted tools versus client tool calls | A tool count is not a billable provider unit. | Price only exact typed provider units and retain other tool calls as explanatory features. |
| Provider-side retries, safety work, routing, or speculative execution | Internal work may affect limits without a client-visible token receipt. | Keep it in the residual unless the provider exposes a supported metric. |
| Policy, promotion, model, or pricing changes | A time-varying slope can be mistaken for a stable cap. | Version every pricing/policy assumption and use change-point flags rather than one all-time gradient. |
| Time zones and rolling-window semantics | Daily and weekly bins can be aligned incorrectly. | Store UTC timestamps and explicit reset identities; render local time only as a view. |
| Concurrent activity | A controlled probe can be contaminated even on the same account. | Use quiet periods, activity declarations, and reject intervals with unexplained local/provider movement. |

## Current user-reported non-use

These are useful working assumptions, not verified coverage:

| Activity | User-reported state on July 24, 2026 | Monitor treatment |
|---|---|---|
| Other devices | None | Low current risk, still uninstrumented. |
| Excel ChatGPT integration | Not used | Excluded from current likely causes, retained as a future surface. |
| Voice Mode | Not used | No current adjustment; retain as a distinct future experiment. |
| Voice input / transcription | Not used | No current adjustment; do not merge with Voice Mode. |

## Minimum prospective activity ledger

The monitor should eventually accept privacy-minimized declarations with only:

- timestamp range;
- pseudonymous account scope when known;
- provider;
- billing surface: subscription, API, or unknown;
- client surface from a fixed low-cardinality enum;
- mode class such as text, voice, dictation, image, research, or automation;
- controlled/quiet-period status;
- optional broad tool classes; and
- a confidence/source label such as local receipt, provider aggregate, visible UI, or user declaration.

It must not retain prompts, responses, filenames, URLs, uploaded content, third-party app tokens, OAuth scopes containing identifiers, or credentials.

## Immediate next steps

1. Extend the new chronological weekly calibration with interval-censored one-event, 5-second, 30-second, and 60-second lag candidates, using holdout error rather than in-sample fit to choose among them.
2. Use the low-cardinality activity ledger to distinguish included Work, Workspace Agent, Excel, Codex Cloud/other-device, and Work Voice task activity from excluded ordinary Chat.
3. Extend the implemented `quality` interval flags into every residual/report row: local receipt, account, plan, speed, provider snapshot age, control state, and timing ambiguity.
4. Run controlled Standard/Fast pairs across model families, followed by the first ChatGPT Work-only panel.
5. Inventory authenticated clients locally by name and auth class without inspecting or exporting secrets.
6. Validate the Claude status-line callback with non-null five-hour and seven-day fields.
7. Review the reset-by-reset value series after every completed reset and require a persistent multi-reset shift before raising a provider-policy-change hypothesis.

## Change log

- **2026-07-24:** Corrected the shared-pool boundary from provider policy. Ordinary Chat and ordinary Chat Voice are excluded; Work, Workspace Agents, ChatGPT for Excel, and Codex share the agentic pool. Work Voice task activity is shared, while connected Voice time can use a separate meter.
- **2026-07-24:** Added explicit image-generation and Spark accounting states. Image generation consumes included general limits at a provider-reported average 3–5× rate; Spark remains a separate, demand-adjusted limit and is excluded from the main-pool fit.
- **2026-07-24:** Added the [ordinary-Chat negative-control audit](../audits/2026-07-24-chatgpt-web-gap-audit.md). Two GPT-5.6 Pro and two GPT-5.6 Thinking message anchors on July 20 showed no material provider movement beyond the local Codex forecast; provider policy now confirms that these ordinary Chat conversations are outside the shared agentic pool.
- **2026-07-24:** Added `calibrate-weekly` and the [seven-day calibration report](./2026-07-24-weekly-7-day-calibration-report.html). Fourteen stable resets now have exact API-price-equivalent values, chronological holdout receipts, and no-look-ahead prior-reset errors; conservative captured-speed weighting narrowly beats unweighted Standard API cost.
- **2026-07-24:** Added the `quality` command and [monitoring quality report](./2026-07-24-monitoring-quality-report.html). The first profile separated fixed-reset timestamp jitter from the moving/high-churn `codex_bengalfox` family, quantified whole-percentage censoring, and exposed collector freshness as an operational gate.
- **2026-07-24:** Initial register created from the current local monitor, provider crosscheck, and user-reported surface use.
