---
title: ChatGPT Web Gap Audit
date: 2026-07-24
type: research
status: complete
---

# ChatGPT Web Gap Audit

## Plain-language result

Four recent ordinary Chat messages were aligned with the independently predicted Codex seven-day quota curve. None produced a convincing extra quota drop that was missing from the local Codex cost ledger. Provider policy now supplies the stronger explanation: ordinary Chat conversations do not consume the Codex/Work shared agentic pool.

These messages should therefore be treated as a negative control, not as candidate missing usage. Their timestamps remain useful for checking that the residual curve does not react to an excluded surface, but no Chat token estimate belongs in the Codex accounting model.

## Privacy boundary

The bridge was used only against the two user-supplied authenticated ChatGPT tasks. This audit retains no prompts, responses, filenames, task URLs, conversation IDs, message IDs, raw account identifiers, or credentials. The tasks are referred to only as A and B.

## Visible ChatGPT evidence

The ChatGPT page exposes user-message time separators and assistant model slugs in the rendered interface. It does not expose per-turn token counts or independent assistant completion timestamps.

| Task | Visible user-message time (US Eastern) | UTC anchor | Following visible assistant model |
|---|---:|---:|---|
| B | 2026-07-20 5:13 PM | 2026-07-20 21:13 | `gpt-5-6-pro` |
| A | 2026-07-20 6:21 PM | 2026-07-20 22:21 | `gpt-5-6-thinking` |
| B | 2026-07-20 6:40 PM | 2026-07-20 22:40 | `gpt-5-6-pro` |
| A | 2026-07-20 8:18 PM | 2026-07-21 00:18 | `gpt-5-6-thinking` |

Task A therefore does not support describing its two recent turns as Pro: its rendered model slug is Thinking. Task B supplies the two clear GPT-5.6 Pro examples.

## Alignment with the Codex seven-day curve

The relevant Codex seven-day reset began on 2026-07-20 and has an independently fitted API-price-equivalent value of $1,832.03. Its protected prior-reset forecast used only earlier reset evidence.

For each ChatGPT message, the table brackets the message with the nearest observed one-point Codex quota boundaries. `Residual` is local-Codex-predicted movement minus provider-observed movement:

- a large downward residual change would be consistent with hidden Web usage;
- an upward change means the local Codex ledger predicted more movement, not less.

| ChatGPT anchor | Boundary before | Residual before | Boundary after | Residual after | Change across anchor | Evidence of missing Web debit? |
|---|---|---:|---|---:|---:|---|
| 5:13 PM Pro | 5:09 PM, 6 pp | +0.233 pp | 5:16 PM, 7 pp | +0.429 pp | +0.196 pp | No; movement is opposite the hidden-debit signature. |
| 6:21 PM Thinking | 6:18 PM, 13 pp | +1.047 pp | 6:29 PM, 14 pp | +1.059 pp | +0.012 pp | No; residual is effectively flat. |
| 6:40 PM Pro | 6:38 PM, 15 pp | +0.996 pp | 6:47 PM, 16 pp | +0.882 pp | -0.114 pp | At most a tiny candidate, far below display precision. |
| 8:18 PM Thinking | 8:03 PM, 22 pp | +0.044 pp | 8:23 PM, 23 pp | +0.032 pp | -0.012 pp | No; residual is effectively flat. |

The largest possible hidden-debit-shaped movement is 0.114 percentage points around the 6:40 PM Pro request. At this reset's fitted value, that is only about $2.09 of API-price-equivalent movement and is not measurable from an integer-percentage display. The other Pro anchor moves the opposite way.

Across the complete bracket from 5:09 PM, just before the first Web anchor, through 8:23 PM, just after the last one, the provider moved 17 points while local Codex cost predicted 16.799 points. The entire four-message period therefore contains only a 0.201-point possible excess provider movement. Multiplying that residual by this reset's $1,832.03 fitted scale gives $3.68 of **API-price-equivalent residual**. This is only a way to express the quota mismatch on the fitted Codex scale: it is not measured ChatGPT Web cost and does not use ChatGPT Web token counts, because the visible Web interface exposes none.

A wider lag check does not reveal a delayed overshoot. The roughly one-point positive residual near 6:20–6:40 PM closes toward zero over the following two hours; it does not continue into negative unexplained movement. That shape is at least as consistent with ordinary provider-display lag as with an additional Web debit.

## What this closes and what remains open

This closes one practical question: the large July 20 Codex quota movement is already explained extremely well by retained local Codex activity. These four ordinary Chat messages are excluded by policy and do not explain a gap.

It leaves three measurement caveats, none of which changes the policy exclusion:

1. The message time is the visible user timestamp; the assistant response can finish later.
2. Ordinary Chat exposes model class but no token or API-price-equivalent receipt.
3. The $3.68 figure above is only a Codex-curve residual conversion, not Chat usage.

## Next practical test

Do not spend quota on another ordinary-Chat coupling test. The relevant controlled panel is ChatGPT Work, Workspace Agents, ChatGPT for Excel, or another Codex surface without a local rollout. Capture a quiet-period marker and close before/after provider snapshots around one included surface at a time.

## Source artifacts

- `.usage-monitor/weekly-calibration-v0.2.json`
- `.usage-monitor/transitions-simple-history-2026-06-11-to-2026-07-24-v0.3.2.json`
- Visible ChatGPT task metadata inspected through the authenticated ChatGPT Surface Control bridge on 2026-07-24
