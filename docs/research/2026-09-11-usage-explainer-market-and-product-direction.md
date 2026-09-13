---
title: Usage explainer market and product direction
date: 2026-09-11
type: research
status: proposed
---

# Usage explainer market and product direction

Research snapshot: 2026-09-11 America/New_York. Scope: existing tools, source-level feasibility, and a proposed product boundary. This is not an accepted implementation decision or an integration qualification. No real session data was supplied to competitors or external models. No product behavior was changed.

## Recommendation and competing thesis

Start with an integration experiment: let an existing audit skill consume a compact, allowlisted TiboTattle evidence result. Keep the desktop product useful without inference. Reuse the current index and accounting rather than add a second ledger. Consider MCP after a bounded CLI workflow proves useful.

The initial thesis is that TiboTattle can help people understand which behavior consumed their allowance and choose a better approach. The strongest competing thesis is already substantial: Codex Audit supplies a local analyzer plus an advisory skill; Codex Usage Tracker supplies agent-queryable evidence; AI Engineering Coach supplies configurable behavior detection and conversational coaching. A generic token teacher is not an unoccupied category.

The potentially useful remaining contribution is an accessible explanation tied to TiboTattle's existing allowance observations, accounting, evidence coverage, and desktop workflow. Its value must be demonstrated against those baselines.

## What users need to learn

Organize the experience around questions, rather than requiring users to interpret each technical chart:

| Question | Useful answer | Evidence needed |
|---|---|---|
| What happened to my allowance? | Observed change over an explicit window, reset/replenishment boundaries, coverage | Compatible account observations; other activity and unobserved periods remain explicit |
| Where did recorded usage go? | Largest tasks and intervals; model, token-component and service-tier breakdown | Deduplicated request usage and supported attribution |
| What made this task expensive? | Request count, repeatedly processed context, output/reasoning, children, cache behavior | Ordered requests, task lineage, components, compactions and configuration observations |
| Which behavior could I change? | One specific hypothesis with supporting evidence and tradeoffs | Tool/phase observations; task context or user confirmation for semantic judgments |
| Did the change help? | Comparable outcome with less total cost, rework or waiting | Accepted result, elapsed time, parent-plus-child usage and rework evidence |

Users control task scope, task boundaries, model/effort choices and requested work. The agent controls many intermediate searches, tools, retries and delegated actions. Provider/cache behavior adds another layer. An explanation should identify which layer a proposed change addresses, rather than blame the user for every expensive request.

Keep three quantities distinct: provider-observed allowance change, recorded token usage, and API-equivalent valuation. A priced task ranking is not an exact allocation of a subscription percentage drop. Only use a calibrated relationship within its supported account/window/model scope, with uncertainty; preserve unexplained differences instead of forcing reconciliation.

## Market evidence

Evidence labels: **source** means inspected implementation; **tested** means the named synthetic checks passed locally; **docs** means a documented capability not exercised here. Small test suites establish bounded behavior, not complete product correctness or usability.

| Candidate | Evidence and overlap | Integration judgment |
|---|---|---|
| [Codex Audit](https://github.com/EmergentKnowledgeGroup/Codex_audit) | Source + tested. Offline Python analysis plus a skill that asks Codex to interpret usage and recommend a comparable experiment. MIT. | Closest coaching workflow to reuse or contribute to. Adapt its evidence input; do not adopt its accounting wholesale. |
| [Codex Usage Tracker](https://github.com/douglasmonsky/codex-usage-tracker) | Source + tested. Local CLI/MCP, bounded queries, evidence selectors, allowance analysis; MIT. Package metadata is pre-alpha. | Closest agent-data product. Evaluate its public query contracts and possible adapter; distinguish the existing kernel from its replacement. |
| [AI Engineering Coach](https://github.com/microsoft/AI-Engineering-Coach) | Source + docs. Codex and other harness parsers, rule-based findings and chat coaching. MIT; employee community effort, not an official Microsoft product. | Reuse selected rule/workflow ideas after validation. Its content access and broad heuristic scores do not match TiboTattle by default. |
| [ccusage](https://github.com/ccusage/ccusage) | Source + docs. Multi-harness local reports, including a Codex adapter with accounting tests. | Baseline for usage reporting and cross-checks. No behavioral teacher was established in the inspected paths. |
| [Claude Code built-ins](https://code.claude.com/docs/en/commands) | Docs. `/insights` analyzes sessions and friction; `/context` and the context-window documentation explain context composition. | Strong native substitute/reference on Claude. Does not establish equivalent Codex functionality or a reusable library. |
| [Langfuse coding-agent workflows](https://langfuse.com/coding-agents) | Docs. Tracing, cost attribution, evaluation and skill optimization. | Relevant if the problem expands into instrumented team/application evaluation; inspect deployment/data requirements before adoption. |
| [better-ccflare](https://github.com/tombii/better-ccflare/blob/main/README.md) | Docs. Proxy/request analytics and multiple provider authentication paths. | Outside the preferred passive, no-auth-reuse architecture; not needed for this experiment. |

### Closest candidates inspected more deeply

**Codex Audit:** inspected `aea200ccc3cd15e970a8e3e1b0e0217c2b2da0b4`, committed 2026-09-06 UTC. The [skill](https://github.com/EmergentKnowledgeGroup/Codex_audit/blob/aea200ccc3cd15e970a8e3e1b0e0217c2b2da0b4/skills/audit-codex-token-routing/SKILL.md) already separates observations, hypotheses, experiments and acceptance/rework evidence. Its [window analyzer](https://github.com/EmergentKnowledgeGroup/Codex_audit/blob/aea200ccc3cd15e970a8e3e1b0e0217c2b2da0b4/skills/audit-codex-token-routing/scripts/audit_usage_window.py) uses deterministic recommendations and explicitly labels cheaper-model repricing as a same-token scenario. Its [legacy analyzer](https://github.com/EmergentKnowledgeGroup/Codex_audit/blob/aea200ccc3cd15e970a8e3e1b0e0217c2b2da0b4/skills/audit-codex-token-routing/scripts/analyze_codex_tokens.py) associates pending usage with a following action and labels this approximate. This cannot prove that the action caused those tokens. Raw upstream dictionaries in older paths and spread rate-limit fields require an independent allowlist before reuse. An independent repository audit ran 37 synthetic tests successfully. No installed skill or real-data coaching session was evaluated.

**Codex Usage Tracker:** inspected `43278d1408416c3262086028bdfa7a522cfc35f8`, committed 2026-08-20. The [existing MCP catalog](https://github.com/douglasmonsky/codex-usage-tracker/blob/43278d1408416c3262086028bdfa7a522cfc35f8/src/codex_usage_tracker/kernel/interfaces/mcp/catalog.py) exposes status, refresh, query, evidence, allowance and job status. The [query catalog](https://github.com/douglasmonsky/codex-usage-tracker/blob/43278d1408416c3262086028bdfa7a522cfc35f8/src/codex_usage_tracker/kernel/query/catalog.py) includes model/effort, tool output bytes and explicitly adjacent model usage. Adjacency is not causal attribution. Its [product direction](https://github.com/douglasmonsky/codex-usage-tracker/blob/43278d1408416c3262086028bdfa7a522cfc35f8/docs/decisions/PRODUCT_DIRECTION.md) describes a separate replacement kernel and explicitly permits potentially sensitive metadata without promising redaction. That is a material difference from TiboTattle's closed export contract. The existing kernel also contains an optional, separately enabled content subsystem; do not infer that all modes share one privacy boundary. The 34 selected synthetic tests passed; this does not qualify the replacement, installed plugin or cross-platform packaging.

**AI Engineering Coach:** inspected `18b1a3d16b586c171426c6a407cc5c2dc073556e`, committed 2026-09-05. Its [Codex parser](https://github.com/microsoft/AI-Engineering-Coach/blob/18b1a3d16b586c171426c6a407cc5c2dc073556e/src/core/parser-codex.ts) processes message/assistant content. Its [runaway-loop rule](https://github.com/microsoft/AI-Engineering-Coach/blob/18b1a3d16b586c171426c6a407cc5c2dc073556e/src/core/rules/runaway-agent-loops.md) uses counts, not an LLM, to flag tool-heavy requests. That establishes a heuristic, not unnecessary work. Its [cache rule](https://github.com/microsoft/AI-Engineering-Coach/blob/18b1a3d16b586c171426c6a407cc5c2dc073556e/src/core/rules/cache-hit-starvation.md) includes a claim that repeated prefixes are free; this must not become TiboTattle advice. Current [official Codex pricing](https://learn.chatgpt.com/docs/pricing) distinguishes nonzero cached-input rates. Its [extension README](https://github.com/microsoft/AI-Engineering-Coach/blob/18b1a3d16b586c171426c6a407cc5c2dc073556e/README.extension.md) marks token usage temporarily hidden and burndown disabled. No runtime tests were run here.

**ccusage:** inspected `c3216eccd09c1e7504cd978dd879f2c39e30882a`, committed 2026-09-11. Its [Codex adapter source/tests](https://github.com/ccusage/ccusage/blob/c3216eccd09c1e7504cd978dd879f2c39e30882a/rust/adapters/codex/src/lib.rs) include deduplication, cached-input accounting and report snapshots. This is a useful accounting comparison, not proof that its semantics match every TiboTattle boundary. No local suite or installed package was exercised. Older search results referring to MCP were not used to assert a current MCP capability.

These are current activity signals, not evidence of long-term maintenance commitments. No maintainer contact or upstream contribution was made.

## What can work without an LLM

A deterministic engine can rank measured contributors, calculate component shares, compare supported intervals, identify repeated large input contexts, count child activity and point to observed cache drops or compactions. It can produce useful templated prose from those facts.

For example, a **synthetic** explanation can say: “This task made 40 model requests. Most recorded input was repeated cached context. The final response is only a small part of the total.” This needs ordered token observations, not comprehension of the conversation. Follow it with a lesson about request count and repeated context, not an automatic accusation of waste.

More semantic questions—whether a search was unnecessary, a requirement was ambiguous, two agents duplicated work, or a cheaper route would have succeeded—need task evidence and judgment. An LLM helps interpret that evidence but does not manufacture causality or restore unrecorded context. User confirmation can sometimes supply the missing task context more cheaply and privately than reading a transcript.

The cost model should distinguish local tool execution from model work. A local shell command is not itself necessarily billed by the model provider. The model call that chooses it, the output later supplied to the model, repeated retained context, and any separately billed hosted tool are distinct effects. A nearby token event cannot be assigned wholly to the tool by timestamp proximity.

Likewise, token-component, model, task and behavior breakdowns overlap. They are different views of the same usage and must not be summed into an invented total savings figure. Removing a large context segment could also lose useful knowledge or cache reuse. Lower effort/model price can lead to more calls and rework. The target is useful accepted work per allowance, not minimum tokens.

## Current TiboTattle foundation and actual gaps

Source inspected at `841ee0c934e23ee7a5a4704a51f74f9959f5c581`; unrelated checkout changes were present and preserved. This is source evidence, not installed-app verification.

| Existing boundary | Implication for the next layer |
|---|---|
| [Unified index](../reference/unified-index-schema.md), [extractor](../../src/local-unified-index-extract.js) | Usage, quota, order, boundaries, lineage and coverage already have owned representations. Reuse these. |
| [Window breakdown](../../src/local-unified-window-breakdown.js), [local API](../reference/api-surface.md) | Bounded interval/model accounting exists. It is a building block for “what happened in this interval?” |
| [Cache analysis](../../src/cache-switch-impact.js) | Already separates observed drops, coverage and compaction confounds. Extend the discipline to other explanations. |
| [Tool normalization](../../src/providers/codex/log-normalization.js) | Retains fixed categories/source kinds, not raw commands, results or a full behavioral transcript. Exact tool-result byte/token ancestry and semantic retry analysis are not supplied by this projection. |
| [Existing CLI](../reference/cli-reference.md), [CLI source](../../src/cli.js) | Research/report/export commands exist. No dedicated bounded coaching/evidence query contract was established by this inspection. |
| [Privacy contract](../reference/local-data-and-privacy.md), [security policy](../../SECURITY.md) | Local UI titles/project labels have scoped transient exceptions. They do not authorize exporting those labels to an agent or putting them in the accounting ledger. |

The user's observation about GPT-6 cache behavior should not become a universal “thinking changes are cheap/free” lesson. The current cache logic already uses model-specific configuration normalization and separately requires observed token/compaction evidence. Any new advice needs the same model/version/source qualification.

Potential additional measurements, subject to a closed schema and source feasibility check: tool-result byte counts, explicit tool success/failure, bounded lifecycle counts, and links between requests and child work. Bytes remain bytes unless a valid tokenizer/context contract supplies a labeled estimate. Do not add prompt/response storage merely to make the explainer more fluent.

## Proposed product and technical organization

Keep three human-facing levels: **Overview** (allowance and pace), **Explain** (ranked measured contributors and evidence), and **Improve** (one suggested change and later outcome). These are proposed navigation concepts, not a request to rebuild the current UI. Existing charts become drilldowns supporting these questions.

```text
Existing local index + accounting + quota observations
                         |
              Bounded evidence queries
                  /                \
    Desktop facts and lessons    CLI / later MCP
                                       |
                              Existing host + skill
                                       |
                           Contextual advice + experiment
```

An explanation result should carry an explicit window/timezone, data generation and freshness, coverage, measured components, evidence handles, applicable pricing provenance, and limitations. A separate recommendation should reference those facts, state a hypothesis and tradeoff, and propose one comparable test. Use opaque local handles instead of leaking private project/task metadata through a new interface.

One plausible initial query returns a compact top-contributors summary; a second fetches evidence for one selected task/interval. Page details and cap rows/bytes. No implicit full-history scan or model-driven polling loop. CLI is a suitable first transport because it can reuse the current Node/domain boundary; MCP becomes useful when persistent discovery, multiple hosts or structured tool integration justify its maintenance.

The app remains a product: it owns trustworthy observations, comparison history, accessible explanations and the follow-through on improvements. Codex supplies an optional conversational interface. The source of product value need not be the place where every sentence is generated.

## Inference choices

| Route | Benefit | Cost and boundary |
|---|---|---|
| Deterministic facts and lesson templates | Offline, immediate, no inference credentials | Cannot judge task intent or outcome from counters alone |
| User-invoked Codex skill + local CLI | Reuses a capable host and familiar interaction | Consumes that conversation's normal allowance; queried data is supplied to the host model |
| Optional local model | Can keep semantic interpretation on-device | Model distribution, RAM, latency, power, quality and hardware support require evaluation |
| Optional user API key | Flexible provider/model choice | Added credential management and direct user inference cost |
| TiboTattle-funded hosted inference | Simple user setup | Operating cost and explicit remote-data handling; not needed for initial validation |

Official [skills documentation](https://learn.chatgpt.com/docs/build-skills) supports instructions plus optional scripts. This validates the integration shape, not an installed TiboTattle capability. A user asking Codex to run a local query does not require TiboTattle to acquire or reuse Codex inference credentials. The conversation still consumes [normal usage](https://learn.chatgpt.com/docs/pricing); it is not free analysis and cloud-hosted interpretation is not fully local. Do not automatically invoke a new model call whenever a graph refreshes.

## Smallest experiment and decision gates

1. **Benchmark the existing workflow before building a new teacher.** Use Codex Audit and Codex Usage Tracker as comparison baselines, with isolated synthetic fixtures. Test long cached context, a material uncached-input change, child work, tool-result growth, and duplicate/partial records across a reset. Do not use production logs as fixtures.
2. **Produce one evidence contract over TiboTattle's existing facade.** Prototype only the bounded interval summary and selected-task detail. Verify conservation, replay/child handling, unknown coverage, reset boundaries and private-field exclusion. Attempt an adapter into an existing audit skill before duplicating it.
3. **Compare rules-only and agent-assisted answers.** Use the same facts. Score numerical correctness, unsupported causal claims, evidence traceability, actionable advice, payload size, latency and the cost of the analysis itself. Human-reviewed semantic cases need separately authorized data access.
4. **Test one behavior change on the next comparable real task.** Keep acceptance criteria, measure total parent-plus-child usage, rework and elapsed time, and record whether the result was accepted. Avoid expensive retrospective full-task reruns just to make a chart.
5. **Put validated lessons in the desktop UI.** Test whether users can identify a dominant contributor and explain the proposed change/tradeoff without an LLM or technical charts. Broaden only when this improves decisions.

Choose **use** if an existing tool already gives the required experience. Choose **contribute/wrap** if a TiboTattle evidence adapter supplies the missing piece. Build a **thin explanation layer** only if existing tools cannot preserve the required accounting/privacy/desktop experience economically. Stop broader investment if the advice stays generic, relies on unsupported causality, or produces no useful improvement in accepted work. A full new LLM application or rebrand is not justified by this first pass.

## Validation receipt and limits

Public competitor source was cloned into disposable temporary directories. No competitor was installed into Codex and no user session store was queried. The main agent inspected Tracker, Coach and ccusage; a separate bounded audit inspected Codex Audit, and the main agent checked its key attribution/export paths.

Tracker command, run in its isolated checkout with temporary Python dependencies:

```text
python -m pytest -q tests/kernel/query/test_service.py tests/kernel/evidence/test_service.py tests/kernel/interfaces/test_mcp.py tests/kernel/test_ingest_privacy.py
34 passed in 6.20s
```

Codex Audit command reported by the independent audit:

```text
python3 -m unittest discover -s tests -v
37 tests passed
```

These cover selected synthetic behavior. Full accounting equivalence, security review, installed skill usability, signed distribution, real-user teaching effectiveness and realized savings remain untested. This report is a research recommendation; implementation and branding decisions remain open.

Repository documentation governance passed (`npm run docs:check`). `npm run test:preflight` stopped at root hygiene because the pre-existing tracked `design-qa.md` entry is outside the root allowlist. That file is present in the inspected base commit and was not changed. The remainder of the preflight lane did not run.
