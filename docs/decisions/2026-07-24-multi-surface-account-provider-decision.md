---
title: Multi-Surface, Account-Aware Provider Crosscheck Decision
date: 2026-07-24
type: decision-record
status: complete
---

# Multi-Surface, Account-Aware Provider Crosscheck Decision

## Decision

Keep the project local-only and treat it as a three-ledger triangulation system:

1. replay-safe local receipts describe what retained Codex rollouts did and what those tokens would cost at Standard OpenAI API prices;
2. read-only provider snapshots describe account-level quota percentage, reset, daily token activity, plan label, and lifetime usage; and
3. occasional visible UI observations add shared Work/Codex language and provider-defined surface categories that the local app-server does not expose.

Never force these ledgers to reconcile. Preserve differences as residuals partitioned by pseudonymous account, plan assumption, local surface, reset, and dated policy epoch. Continue to report the weekly-limit result as a conditional API-price-equivalent ballpark, not as an observed subscription allowance.

## Evidence interval

- Local replay-safe history: May 17, 2026 00:00 UTC through July 24, 2026 04:15 UTC.
- Provider daily buckets available for 60 matched UTC days.
- Visible Codex and Work Analytics observation: July 24, 2026 04:00 UTC.
- Read-only app-server account snapshot: July 24, 2026 05:18 UTC.
- Study assumptions supplied by the user: no meaningful other-device, Excel, or Voice usage; two ChatGPT accounts are used; the normal plan is $200 Pro 20x; one brief $100 Pro 5x episode has unknown dates/account.

## What the local corpus contains

The bounded reprocessing classified 2,366 rollouts and retained 295,681 request-like usage events. It excluded 585,778 cumulative fork-replay events. Retained activity totals 55,675,896,357 tokens and $51,671.51 at current Standard OpenAI API-price-equivalent rates.

| Local surface | Rollouts | Usage events | Tokens | Standard API equivalent |
|---|---:|---:|---:|---:|
| Desktop / extension / IDE | 504 | 236,022 | 48,542,234,466 | $46,087.22 |
| Subagent | 1,821 | 58,948 | 7,087,664,582 | $5,568.53 |
| Scheduled task | 33 | 673 | 44,584,979 | $14.05 |
| CLI exec | 8 | 38 | 1,412,330 | $1.71 |

Codex scheduled tasks and subagents are therefore represented in retained local logs and are no longer silently pooled as ordinary interactive work. A Cloud task, Work request, code review, or other provider activity with no local rollout remains provider-side unallocated usage.

## Account result

The current signed-in account is represented only by a Keychain-HMAC pseudonym and local alias. No email, provider account ID, auth token, balance, or reset-credit identifier is persisted.

The current provider snapshot reports 37,056,585,614 lifetime tokens. Retained local history contains 55,675,896,357 tokens, a ratio of 1.502456. Under equal token semantics, that is incompatible with treating the whole local history as the current account's history. Known account switching is a strong candidate explanation, but older metric semantics or residual duplication are not ruled out.

Historical rollout records do not contain a provider account subject. They remain account-unattributed. Future collection can safely distinguish accounts only after a fresh `account/read` marker; the passive collector uses a five-minute freshness window and never retroactively assigns older history.

The retained collector ledger currently has zero rollout events with the newly registered current-account scope, so the prospective same-scope comparison is correctly `not_yet_observed`. Once new marked events arrive, the crosscheck filters to the current pseudonymous scope, partitions them by dated plan variant, and labels daily ratios as partial-marker coverage rather than full-day reconciliation. Snapshot reports, interval inference, and weekly history also include account scope and plan variant in their grouping keys.

## Plan result

The provider exposes `planType: pro`, not a 5x/20x product variant. The owner-only plan timeline therefore records:

- current pseudonymous profile default: `pro-20x`, confidence `user_reported_normal_state`, effective only from the July 24 account capture; and
- unresolved episode: `pro-5x`, with account and dates left null.

This ambiguity is a structural break, not a missing value to impute. Approximate dates plus the affected local account alias would materially improve the historical interpretation.

The clearest verified plan change near the study window is April 9, 2026: OpenAI announced the $100 Pro option with a temporary up-to-10x Codex allowance, described as an increase from its normal 5x level, while the $200 option remained the highest-usage tier. The retained local interval starts May 17. Because the brief $100 episode's account and dates are unknown, the monitor does not decide whether it was 5x or the temporary 10x promotion. Current official pricing again lists $100 as 5x and $200 as 20x. See the [release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes) and [current plan pricing](https://learn.chatgpt.com/docs/pricing).

## Provider-side crosscheck

The app-server read-only methods provide more useful provider evidence than local rollouts alone:

- `account/read`: current email and generic plan type, transformed immediately into a pseudonymous scope;
- `account/rateLimits/read`: integer percentage, reset, window duration, and plan-level quota state; and
- `account/usage/read`: 60 daily token buckets plus nonfinancial summary/lifetime token counts.

Credit balance and raw account fields are dropped. The provider totals remain account-level and cannot allocate Work, Cloud, Desktop, subagent, scheduled-task, or code-review usage.

Across all 60 matched days, account-unattributed local tokens are 1.378088 times the current account's official tokens. These are coverage diagnostics between unmatched account scopes, not reconciliation ratios. The dated cuts are more informative:

| Observed epoch | Matched days | Local / official tokens | Interpretation |
|---|---:|---:|---|
| May 17–28 | 12 | 1.106502 | Close enough to be suggestive, not equivalent |
| May 29–July 8 | 33 | 1.764502 | Strongly incompatible with one-current-account history |
| July 9–15 | 7 | 0.900997 | Provider total is about 11% above retained local total |
| July 16–24 | 8 | 0.924232 | Provider total is about 8% above retained local total |

Only days with an official bucket enter each ratio. The original implementation briefly included unmatched local days in an epoch numerator; that bug was corrected and a regression test now locks matched-day semantics.

The much better post–July 9 agreement is useful evidence that the newer local receipts and provider token activity are close enough to learn from prospectively. It does not prove a merger/accounting change on July 9. Account switches, missing Work/cloud receipts, model changes, and provider metric definitions are confounded.

## ChatGPT Work result

The authenticated visible page was titled **Codex and Work Analytics** and explicitly said that Codex and Work share the same usage limit. It showed 74% remaining with a July 30 reset at the UI capture. Seventy-eight minutes later, the app-server showed 69% remaining. Because that exceeds the monitor's one-hour comparison threshold, the percentage and reset differences are deliberately suppressed as stale rather than called agreement or contradiction. The raw reset timestamps happen to be 21 seconds apart, but they are not used as a formal close-capture comparison.

The UI exposed:

- 6,844 turns by model;
- 5,275 turns by surface; and
- Desktop, CLI, Extension, Cloud, Mobile, Code review, Desktop App, Web, and Exec categories.

It did not expose a Work-only bucket. The 1,569 difference between the two UI totals cannot be assumed to be Work because the two charts may use different inclusion rules. It remains unclassified.

Current official guidance says Work follows Codex's usage structure and shares its limit. The July 9 [ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes) establish the Work launch and unified desktop milestone. No primary source found says shared accounting began on exactly July 9, so July 9 is retained as `plausible_unconfirmed_accounting_boundary`. July 16 is a verified continuity/UI change, not a quota-policy change.

Relevant primary sources:

- [ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275/)
- [Getting started with Codex and plan usage](https://help.openai.com/en/articles/11369540-getting-started-with-codex)
- [Codex and Work pricing](https://learn.chatgpt.com/docs/pricing)
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
- [Enterprise Analytics API](https://learn.chatgpt.com/docs/enterprise/analytics-api)

The Enterprise Analytics API is not a substitute for this consumer Pro monitor: it is workspace-aggregate infrastructure, not a documented per-turn consumer endpoint. For a personal account, the strongest supported crosschecks remain the visible Analytics UI and local app-server reads.

## Weekly-limit framing over the retained months

The prior fixed June 11–July 23 weekly diagnostic remains valid as an assumption-bound local series:

- 222,525 priced events;
- 4,177 displayed weekly-window transitions;
- 14 usable reset groups;
- all transitions uncontrolled;
- Standard API-equivalent median across usable resets: $1,890.63;
- central 80% reset-to-reset spread: $1,724.09–$2,286.48;
- recent Standard-only median: $1,871.18; and
- recent tier-weighted sensitivity: $1,892.15–$2,327.06.

The best current framing is therefore:

> On this machine's retained receipts, one displayed weekly allowance behaves as if it were roughly $1.9k–$2.3k of the monitor's API-priced/tier-weighted usage under recent conditions. That is not the account's published or identified allowance. Older history is mixed-account or metric-incompatible, Work/cloud activity is not allocated per request, plan variant dates are incomplete, and provider quota precision is one integer percentage point.

The earlier Standard-only first-three versus last-three decline of 12.04% remains descriptive. The tier-weighted late/early ratio still crosses one, so neither a limit reduction nor a stable cap is established. The new provider token series adds evidence about data coverage, not an absolute allowance denominator.

## Implementation decisions

- API Standard prices remain the base counterfactual; Codex subscription Fast multipliers are a separate quota-sensitivity series. API Priority/Flex/Batch and subscription Standard/Fast remain independent taxonomies.
- Session metadata is reduced to low-cardinality surface classes. Raw source objects, titles, paths, thread IDs, parent IDs, prompts, and content are not retained.
- Account identity is HMAC-pseudonymized with a Keychain-injected secret. A fresh marker can scope only nearby new events.
- Snapshot reports, interval inference, and weekly history group on pseudonymous account scope plus specific plan variant. Existing raw history is explicitly `unattributed` / `unknown`; prospective provider crosschecks use only same-scope collector records and label their marker-window coverage as partial.
- Official daily activity is lagging account-level evidence and never overwrites interval-level local residuals.
- Visible UI capture is read-only and limited to aggregate text and numbers. Cookies, storage, auth headers, network payloads, and hidden application state are out of scope.
- The replay-safe local scan is cached in `.usage-monitor/local-history-v0.1.json`. A provider crosscheck using the cache runs in under one second; a full historical rescan took roughly two minutes.
- Cached scans carry privacy-safe rollout-source fingerprints. Same-size rewrites, replacement files, newly relevant files, and appended records at or before the fixed end invalidate the cache. Growth is accepted only after parsing the appended JSONL suffix and proving every complete record is later than the fixed interval. `--allow-stale-cache` is an explicit override whose status remains visible in durable output.
- Successful after-end suffix checks advance an owner-only, cache-digest-bound validation sidecar, so the next poll reads only newly appended bytes. Two consecutive cached crosschecks completed in 0.93 and 0.47 seconds.
- The passive collector reads appended rollout bytes in 256 KiB stream chunks and caps any one buffered JSONL line at 16 MiB. Oversized lines are skipped with a diagnostic while the cursor resumes at the next complete line; idle reconciliations no longer rewrite an unchanged checkpoint.
- Emitted collector records are written in batches of at most 1,000 rather than retained for a whole backfill. A path-free digest journal distinguishes an appended-and-checkpointed batch from one that must be truncated and replayed, so checkpoint-write failures do not duplicate events. Journal/checkpoint temporary files are fsynced before atomic rename, parent directories are fsynced after rename/removal, and ledger batches are fsynced before checkpoint commit. Recent event keys retain a bounded 5,000-entry window and are compacted once per batch rather than front-spliced per record. The implementation exposes batch count and maximum buffered-record diagnostics.
- A provider UTC-day bucket is never assigned to one plan when the dated plan timeline contains an intraday boundary on that day, even if the partial prospective collector observes only one side of the boundary.
- Collector records remain append-only for this proof of concept. Automatic retention is intentionally disabled; a future archive command should create owner-only monthly partitions plus a digest manifest before deleting any source records.
- All new owner-only data artifacts are mode `0600`.

## Verification

- 152 Node tests pass, including account/plan inference partitioning, cross-partition headline suppression, raw-identity rejection, task-surface classification, matched-day epoch ratios, prospective same-scope, mixed-plan-day, and one-sided known-boundary handling, fresh-marker scoping, suffix-aware cache freshness and advancement, bounded streamed collector batching, exactly-once rollout and provider-snapshot checkpoint-failure replay, journal-preparation and committed-journal cleanup recovery, bounded dedupe compaction, idle-checkpoint suppression, UI sanitization, and report-width packaging.
- A privacy scan found neither declared email address nor Gmail address patterns in project source, documentation, the canonical artifact, or new owner-only crosscheck artifacts.
- The portable report contains 31 rendered blocks, 8 metric cards, 4 charts, and 3 tables. Its embedded artifact equals `.usage-monitor/legacy-reports/artifact.json`; the enhanced reader passes 1440-pixel and 390-pixel viewport checks and keyboard-accessible source-dialog verification with no external requests or browser errors.

## Next evidence to collect

The living [coverage gaps register](../governance/2026-07-24-coverage-gaps-register.md) tracks surface-specific blind spots, accounting ambiguity, contamination signatures, and controlled probes. The immediate sequence remains:

1. After the next intentional account switch, run `register-account --alias account-secondary --default-plan pro-20x`, then force `collect-once --stale-after-ms 0`. `doctor` only reports state and never writes the plan ledger.
2. Add approximate start/end dates and affected account alias for the brief 5x episode.
3. Keep collecting app-server quota plus daily token snapshots across at least three reset windows per account/plan.
4. Occasionally capture the visible Analytics page close to the app-server poll; record the time gap and never force equality.
5. Run controlled Standard and Fast panels on a fixed model/effort/context/cache shape while all known shared-pool surfaces are paused.
6. Treat any unexplained provider/local residual as evidence to classify, not as an allowance conversion factor.

## Stop/build judgment

**Build and use locally.** The proof of concept now measures enough independent ledgers to improve prospectively and has already detected a material single-account interpretation error. Do not build cross-user telemetry yet. First accumulate account-scoped, plan-dated reset panels and verify that the newer provider/local alignment remains stable.
