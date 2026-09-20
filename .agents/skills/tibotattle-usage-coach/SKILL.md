---
name: tibotattle-usage-coach
description: Analyze local TiboTattle coding-agent usage and give evidence-backed advice. Use when asked why recorded usage changed, which work or models dominate it, how cache or subworker usage contributes, what allowance observations show, or what comparable usage experiment to try.
---

# TiboTattle usage coach

Answer usage questions from TiboTattle's deterministic, content-free explainer.
The CLI owns facts and calculations; use the host model only to interpret those
results and propose tradeoffs. Do not request an inference API key or create a
second usage ledger.

Read the maintained
[agent protocol](../../../docs/reference/usage-explainer-agent-protocol.md)
before the first analysis in a task. It defines plan selection, pagination,
evidence lookup, errors, and prohibited claims.

## Workflow

1. When the TiboTattle plugin tools are available, call `tibotattle_status`, then
   stop if it reports an unsupported platform; otherwise call
   `tibotattle_list_plans`. If the app is absent or incompatible, explain that
   no private evidence was read and stop unless the user separately asks to
   install or upgrade it. Without plugin tools, run
   `node ./src/cli.js explain-usage-plans` from the repository root to discover
   the current contract. Use `usage-monitor` only when an installed CLI is the
   intended evidence source.
2. Select the smallest useful plan and period. Check `data_health` first when
   evidence freshness or completeness is unknown.
3. Call `tibotattle_explain_usage`, or run `explain-usage` in CLI mode. Treat
   `facts`, `coverage`, `limitations`, and `prohibitedClaims` as authoritative.
4. Follow `nextCursor` with the same plan, period, and limit only when later
   ranks could change the answer. Stop at a null cursor or once the remaining
   ranks are immaterial. Never construct or modify a cursor.
5. Resolve an item's selector with `tibotattle_get_evidence`, or
   `explain-usage-evidence` in CLI mode, when a conclusion depends on that item.
   Never infer a hidden task, project, path, command, or identity from a selector.
6. Answer with observed facts first, then clearly labeled model judgment, then
   one reversible comparison or experiment when advice is warranted.

## Coaching contract

When the user asks how to improve their usage, provide at least one complete
behavioral recommendation with all five fields below:

- **Change:** a specific behavior the user controls.
- **Why:** the minimum observed or calculated evidence behind the hypothesis.
- **Tradeoff:** the plausible downside and any missing outcome evidence.
- **Experiment:** a bounded comparison on similar work.
- **Keep/revert threshold:** the measured result that decides whether to keep
  the change.

Do not treat cache reads, dominant models, high-volume task families, or
subworker tokens as waste by themselves. Use them to choose a high-leverage
experiment, then ask the user to compare quality, completion, elapsed time, and
allowance movement where those measures are actually available.

If `coverage.status` is `unavailable`, give only the operational action needed
to obtain usable evidence. If it is `partial`, scope the claim to the covered
history and repeat the missing-tail or attribution limitation in the advice.

Preserve missing, partial, stale, incompatible, unpriced, and unknown evidence.
Do not equate recorded usage with provider allowance movement or subscription
billing, infer causality from arithmetic contribution, or label high-usage work
as wasteful without task context supplied by the user.

Do not refresh the index, send data to another model or service, mutate user
settings, or perform a recommended experiment unless the user separately asks
for that action.
