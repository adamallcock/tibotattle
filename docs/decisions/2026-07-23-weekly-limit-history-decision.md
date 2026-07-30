---
title: Weekly Limit History Decision
date: 2026-07-23
type: decision-record
status: complete
---

# Weekly Limit History Decision

## Decision

Use `$1.9k–$2.3k` only as a **conditional recent local slope** in Standard-API-equivalent / tier-weighted units. Do not publish it as this account's weekly allowance, and do not claim that OpenAI reduced the account's limit.

## Local evidence

- Fixed interval: June 11, 2026 00:00 UTC through July 23, 2026 23:59:59 UTC.
- Fully priced events: 222,525 of 222,525 at current Standard OpenAI API prices.
- Weekly display transitions: 4,177; control-state `unknown`: 4,177.
- Usable descriptive reset groups: 14 of 22 deduplicated groups.
- Across-reset median: `$1,890.63`; central 80% across resets: `$1,724.09–$2,286.48`.
- Last three usable resets: `$1,871.18` Standard-only; `$1,892.15–$2,327.06` with captured/unknown Standard-versus-Fast sensitivity.
- First-three versus last-three Standard-only medians: `$2,127.29` versus `$1,871.18`, a 12.04% decline.
- Tier sensitivity expands the possible late/early ratio to `0.3567–1.0939`, which crosses no-change (`1.0`).
- The workload mix is not stable: the first three usable groups are 99.3% GPT-5.5 by Standard-priced model cost, while the last three are 83.5% GPT-5.6 Sol and 16.4% GPT-5.6 Terra. Cache-read token share also rises from 92.9% to 95.2%. This is a material confounder, not evidence of causation.

## Why this is not an allowance estimate

Integer rounding is manageable with many transitions. The decisive problem is unbounded missing usage: Codex, ChatGPT Work, Excel, Workspace Agents, other devices, and other tasks can draw from the same pool without appearing in this local log corpus. The local `planType: pro` field also does not identify the current 5x versus 20x Pro variant. A session setting can be joined to later token snapshots, but no exact turn ID ties each token delta to a tier.

## Historical interpretation

There is a real descriptive downward pattern, broadly similar in direction to the [linked Reddit account's](https://www.reddit.com/r/codex/comments/1v4ds6g/ive_been_measuring_my_100_pro_lite_weekly_limit/) reported `$675 → $600` (11.1%) change. It is not confirmation of the same change: the accounts, plan variant, coverage, model mix, resets, and tier observations differ.

OpenAI has documented several material accounting or allowance changes over time:

- [November 24, 2025 usage fixes](https://developers.openai.com/codex/changelog) changed stale-display behavior and backend smoothing.
- [GPT-5.4 mini on March 17, 2026](https://developers.openai.com/codex/changelog) began consuming 30% as much included quota as GPT-5.4.
- [The April 2 token-based rate-card migration](https://help.openai.com/en/articles/20001106-codex-rate-card) replaced approximate per-message accounting for most plans.
- [The April 9 Pro announcement](https://help.openai.com/en/articles/6825453-chatgpt-release-notes) temporarily raised the new $100 Pro plan from its 5x standard allowance to up to 10x Plus usage.
- [The June 11 Codex update](https://help.openai.com/en/articles/6825453-chatgpt-release-notes) introduced rate-limit reset banking for eligible Plus and Pro users; banked resets remain usable for 30 days and can change observed availability without changing the baseline cap.
- [The June 15 CLI release](https://developers.openai.com/codex/changelog) added daily, weekly, and cumulative `/usage` token views, changing observability rather than publishing a numeric weekly cap.
- [Current Codex pricing](https://developers.openai.com/codex/pricing) again describes Pro as 5x or 20x Plus and says additional weekly limits may apply, without publishing their numeric sizes.

Those sources prove that effective limits and metering have changed historically. They do not prove when or whether this local account's underlying numeric weekly cap changed during June–July 2026.
