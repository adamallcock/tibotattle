---
title: Usage explainer agent protocol
date: 2026-09-12
type: reference
status: maintained
---

# Usage explainer agent protocol

This is the maintained contract for agents that answer questions about local
TiboTattle usage. It governs source behavior, plan selection, pagination,
evidence lookup, and model synthesis. The implementation authority is the
closed plan registry in `src/reporting/usage-explainer.js`; the command syntax
is maintained in [the CLI reference](./cli-reference.md).
Installed Codex integrations use the equivalent closed tool surface documented
in [the Codex plugin reference](./codex-plugin.md).

## Responsibility boundary

```text
committed local index
        |
        v
deterministic usage-monitor plan -- bounded, content-free facts
        |
        v
host agent model -- interpretation, tradeoffs, and a proposed experiment
```

TiboTattle does not call an embedded or external LLM. The CLI determines the
facts, calculations, coverage, limitations, and prohibited claims. The model
already running the agent decides which plans to query and synthesizes advice.
No inference credential is required. Raw prompts, responses, commands, paths,
task names, or identifiers may not be added to make the advice more fluent.

## Discover and select plans

Run `usage-monitor explain-usage-plans` before relying on a remembered plan
list. From a repository checkout, `node ./src/cli.js explain-usage-plans` is the
equivalent source invocation. In the Codex plugin, call
`tibotattle_list_plans`. The catalog is machine-readable and does not open or
refresh the local index.

Choose the smallest set that can answer the user's question:

| Need | Plan |
| --- | --- |
| Establish whether interpretation is safe | `data_health` |
| Quantify recorded usage in one window | `current_usage` |
| Rank task families by recorded tokens | `top_work` |
| Compare arithmetic contributors across adjacent windows | `period_drivers` |
| Inspect recorded model mix | `model_effort_mix` |
| Inspect API-price-equivalent coverage | `pricing_coverage` |
| Compare primary and subworker contributions | `parent_subworker_usage` |
| Inspect compatible observed allowance movement | `allowance_movement` |

Do not run all plans by default. Start with `data_health` when freshness or
completeness is unknown, then query only the evidence needed for the question.
The default period is `7d` and the default page limit is `10`.

On desktop installations, default discovery selects the first present index
in this closed order: current Electron production state, retained native macOS
state where applicable, then the legacy CLI state. `coverage.sourceKind` names
the selected class without revealing its path. An explicit
`USAGE_MONITOR_STATE_ROOT` or `--index-file` remains authoritative.

## Query and paginate

Run a first page without a cursor:

```text
usage-monitor explain-usage --plan top_work --period 7d --limit 10
```

The response contains at most 25 items and 16 KiB. For pageable plans, `page`
reports the zero-based offset, requested limit, returned item count, and total
item count. Each item has a global one-based `rank`.

If `nextCursor` is non-null and more rows are relevant, make another invocation
with the exact same plan, period, and limit:

```text
usage-monitor explain-usage --plan top_work --period 7d --limit 10 --cursor <nextCursor>
```

The opaque cursor is authenticated with the local index secret and binds the
index generation, plan, period, exact time window, page limit, and next offset.
It therefore preserves the first page's window across separate CLI processes.
Changing a bound field is invalid; changing the committed generation makes the
cursor stale. Stop paging when `nextCursor` is null or when later ranks cannot
materially affect the answer.

`truncated: true` means the response is not a complete unqualified result. When
a cursor is also present, another page is available. When no cursor is present,
read the limitations: for example, subworker discovery can remain explicitly
bounded to the 100 largest task families.

## Inspect evidence

Use evidence lookup when the recommendation depends on one particular ranked
item rather than only aggregate facts:

```text
usage-monitor explain-usage-evidence --selector <item.selector>
```

Selectors are opaque, generation- and window-bound, and resolve items from any
page. Do not attempt to decode a task, project, path, or source location from a
selector. A stale or unresolvable selector is unavailable evidence, never zero.

## Interpret and answer

Separate four layers in the response:

1. **Observed:** exact local facts and explicit coverage.
2. **Calculated:** deterministic rankings, shares, and arithmetic changes.
3. **Judgment:** what the host model thinks may be worth changing, clearly
   labeled as an inference rather than a measured fact.
4. **Experiment:** one comparable, reversible follow-up and the measure that
   would support keeping or reverting the change.

When the user asks how to improve their usage, do not stop after these four
labels. Give at least one recommendation in this complete form:

- **Change:** one behavior the user can actually alter.
- **Why:** the smallest observed or calculated evidence that motivated it.
- **Tradeoff:** what may get worse, or what the evidence cannot establish.
- **Experiment:** a bounded comparison with the same kind of work.
- **Keep/revert threshold:** the result that would justify retaining or
  abandoning the behavior.

Use these signals as hypothesis generators, not conclusions:

- A high cache-read share can be efficient reuse. Inspect uncached input,
  output, task completion, and allowance observations before recommending less
  context.
- A dominant model identifies where a model-routing experiment has leverage;
  it does not establish that a cheaper or faster model would preserve quality.
- A high subworker share can reflect productive parallelism. Test narrower
  delegation on comparable work instead of treating delegation as overhead by
  definition.
- Concentrated task-family usage identifies where an experiment could have the
  largest effect. It does not identify the task or prove that it was wasteful.

If task outcome or quality is unavailable, give a class-level experiment and
ask the user to compare their own acceptance signal (for example tests passing,
review changes, or time to an acceptable result). Never invent a productivity
claim from token counts alone.

Honor every returned `prohibitedClaims` entry. In particular, recorded tokens
do not equal provider allowance depletion; API-price-equivalent valuation is
not a bill; an arithmetic contributor is not a cause; and high usage does not
establish waste, quality, or necessity. Preserve null, unavailable, partial,
stale, unpriced, incompatible, and unknown values rather than converting them
to zero or a default.

## Failure behavior

A result whose `coverage.status` is `unavailable` does not support behavioral
coaching. Give only the operational next step needed to obtain current evidence.
A `partial` result may support historical or bounded observations, but every
recommendation must carry the missing tail or attribution limitation.

- `usage_explainer_cursor_invalid`: rediscover plans and restart the query; do
  not edit or reuse the cursor with different parameters.
- `usage_explainer_cursor_stale`: the committed generation changed; restart at
  the first page and reassess coverage.
- `usage_explainer_selector_stale`: rerun the owning plan before requesting
  evidence again.
- `usage_explainer_window_uncovered`: wait for or diagnose a current committed
  refresh; do not report the empty requested window as zero usage.
- `usage_explainer_project_attribution_incomplete`: use aggregate or model
  evidence, or restore complete metadata before claiming period drivers.
- Any other unavailable result: report the returned error and limitation. Do
  not infer an answer from missing evidence or refresh the index implicitly.

The repository-scoped
[TiboTattle usage coach skill](../../.agents/skills/tibotattle-usage-coach/SKILL.md)
applies this protocol for Codex agents.
