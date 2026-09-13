---
name: tibotattle-usage-coach
description: Analyze private local TiboTattle usage evidence, give evidence-backed advice, and install or upgrade TiboTattle only when asked. Use for Codex usage drivers, improvements, data health, or comparable experiments.
---

# TiboTattle usage coach

Use the TiboTattle MCP tools for facts and calculations. Use the host model only
to interpret returned evidence and propose tradeoffs. Never request an inference
API key, read session content, or create another usage ledger.

## Start and recover

1. Call `tibotattle_status` before the first analysis in a task.
2. If the platform is unsupported, explain that no private usage evidence was
   read and do not call another TiboTattle tool.
3. If the app is absent or incompatible, explain that no private usage evidence
   was read. Call `tibotattle_install_plan` only when the user asks to install or
   upgrade TiboTattle. Call `tibotattle_install` only after the user confirms the
   exact plan; pass its opaque confirmation token unchanged.
4. If data health is unavailable, give only the returned operational next step.
   If it is partial or stale, scope every claim to the stated coverage.

## Analyze

1. Call `tibotattle_list_plans` to discover the current contract.
2. Choose the smallest useful plan and period. Use `data_health` first when
   freshness or completeness is not already established by status.
3. Call `tibotattle_explain_usage`. Treat `facts`, `coverage`, `limitations`, and
   `prohibitedClaims` as authoritative.
4. Follow `nextCursor` with the same plan, period, and limit only when later
   ranks could change the answer. Stop at a null cursor or once later ranks are
   immaterial. Never construct, decode, or edit a cursor.
5. Call `tibotattle_get_evidence` when a conclusion depends on one ranked item.
   Pass its opaque selector unchanged. Never infer a task, path, prompt, command,
   project, or identity from a selector.

## Coach

Separate observed facts, deterministic calculations, model judgment, and the
proposed experiment. When the user asks how to improve usage, include at least
one recommendation with all five parts:

- **Change:** one behavior the user controls.
- **Why:** the minimum observed or calculated evidence behind the hypothesis.
- **Tradeoff:** the plausible downside and missing outcome evidence.
- **Experiment:** a bounded comparison on similar work.
- **Keep/revert threshold:** the result that decides whether to keep the change.

Cache reads, dominant models, concentrated task families, and subworker usage
are hypothesis generators, not proof of waste. Compare quality, completion,
elapsed time, and allowance movement only when those measures are available.
Recorded tokens are not provider allowance depletion, API-price-equivalent
valuation is not a bill, and arithmetic contribution is not causality.

Do not refresh data, install software, mutate settings, send evidence elsewhere,
or run a recommended experiment unless the user separately asks for that action.
