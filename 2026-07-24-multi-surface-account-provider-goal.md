---
title: Multi-Surface, Account-Aware Usage Triangulation Goal
date: 2026-07-24
type: plan
status: complete
---

# Multi-Surface, Account-Aware Usage Triangulation Goal

## Objective

Extend the local-only usage monitor so its estimates never silently mix accounts, plans, execution surfaces, or provider policy eras. Combine replay-safe local Codex receipts, read-only Codex app-server accounting, and explicitly captured ChatGPT web UI observations into a dated, privacy-safe history. Use the result to produce the best available weekly-limit ballpark while keeping actual allowance, local API-price equivalent, and provider-reported quota movement separate.

## User facts to model

- No other devices, Excel, or Voice usage is expected during this study unless that changes later.
- Codex scheduled tasks and subagents exist locally and must be classified rather than pooled as ordinary interactive work.
- ChatGPT Work is a plausible shared-pool surface from July 9, 2026 onward, but July 9 is a hypothesis boundary rather than a provider-confirmed accounting-effective date.
- The user normally has the $200 Pro 20x plan and briefly used the $100 plan. The dates and account affected by the $100 interval are not yet known, so the interval must remain unresolved rather than invented.
- Two ChatGPT accounts are used. Raw email addresses and raw provider account identifiers must never be persisted.

## Workstreams

### 1. Safe account attribution

- Read the current signed-in account through the local Codex app-server `account/read` method.
- Derive a stable local pseudonym with HMAC-SHA-256 using a secret injected from macOS Keychain.
- Persist only the pseudonymous scope ID, derivation version, plan type, and optional local alias.
- Never persist the email, account ID, authentication data, Keychain secret, credit balance, or reset-credit identifiers.
- Mark historical rollout events as `unattributed` unless a contemporaneous, fresh account marker exists; do not backfill account identity across switches.
- Partition provider comparisons and future inference by account scope. Missing scope is a visible limitation, not a default shared bucket.

### 2. Plan timeline

- Represent `pro-20x`, `pro-5x`, `pro-10x-promo`, and `unknown` as separate plan variants even when the provider only returns `planType: pro`.
- Support dated, account-scoped user declarations in an owner-only plan ledger.
- Encode the user's normal state as a 20x assumption only where a scope and effective date are known.
- Keep the brief $100 episode unresolved until dates/account are supplied or independently evidenced.
- Treat plan boundaries as structural breaks in every trend or capacity comparison.

### 3. Codex task-surface coverage

- Classify safe local session metadata into interactive user work, scheduled automation, subagent, CLI/exec, extension/IDE, and unclassified local rollout.
- Preserve only low-cardinality classifications; never copy raw `source`, `originator`, paths, task titles, automation prompts, or thread IDs.
- Reuse parent/fork lineage to exclude replayed cumulative history in both historical scans and passive backfill.
- Keep root work, subagent work, and automation work visible as separate cuts, while documenting that provider counters may already aggregate nested work.
- Treat cloud tasks not represented by a local rollout as provider-side unallocated usage.

### 4. ChatGPT Work and web/UI evidence

- Use read-only visible browser inspection of the authenticated Codex and Work Analytics page.
- Capture only aggregate date range, remaining percentage, reset timestamp, total turns, and enumerated surface/model categories.
- Do not access cookies, storage, auth headers, private network calls, raw charts, or hidden application state.
- Treat provider surface labels such as Web or Cloud as coarse provider categories; do not relabel them as Work without direct evidence.
- Track July 9 as a plausible Work-era breakpoint and July 16 as a UI-continuity change, not as proven accounting changes.

### 5. Provider-side accounting crosschecks

- Poll read-only app-server quota windows, official daily token buckets, and nonfinancial usage summaries.
- Compare provider daily tokens with replay-safe local tokens at matching UTC-day grain and account scope.
- Compare web UI weekly remaining/reset with app-server used percentage/reset when captured close in time.
- Store credit presence and unlimited flags only; exclude credit balance and financial/payment details.
- Keep provider totals unallocated across surfaces unless the provider supplies an explicit breakdown.

### 6. Historical reprocessing

- Reprocess every retained local rollout from the earliest safe timestamp through July 24, 2026.
- Produce daily and policy-epoch cuts by surface, model, token component, speed mode, and API-price equivalent.
- Use API Standard pricing as the base comparison series; apply subscription Fast multipliers only as a separate quota-sensitivity series.
- Compare pre/post July 9 observations, but label results descriptive because model mix, account switches, plan changes, missing Work usage, and quota weighting remain confounded.
- Report exact retained coverage dates and any gaps rather than claiming “several months” beyond the evidence.

### 7. Estimation and learning loop

- Produce a conditional ballpark even when actual allowance is not identifiable.
- Publish the assumptions needed for each ballpark and a range wide enough to include account, surface, speed, and model-mix uncertainty.
- Save provider/local residuals so repeated captures reduce uncertainty over time.
- Add change-point flags at plan, account, policy, reset, pricing, and collection-coverage boundaries.
- Never convert one observed percentage point into a universal allowance without enough within-reset transitions and complete account-scope coverage.

## Acceptance criteria

- Automated tests cover pseudonymization, raw-identity exclusion, task-surface classification, account mixing rejection, plan boundaries, provider/local daily comparison, and UI observation validation.
- A privacy scan finds neither declared email address, provider subject, raw balance, credentials, paths, prompts, nor thread IDs in new artifacts.
- The current signed-in account can be captured as a Keychain-HMAC scope without printing or persisting its email.
- Local scheduled tasks and subagents are quantified separately for the retained history.
- Provider UI and app-server snapshots agree on the current weekly percentage/reset or the mismatch is explicitly recorded.
- The revised technical report preserves the prior weekly-history findings and adds account, plan, surface, provider, policy-epoch, and uncertainty sections.
- The final result clearly states what is measured, what is inferred, what remains unallocated, and what one additional capture or user-supplied date would improve next.

## Explicit non-goals

- No cross-user collection, telemetry upload, account switching, credit purchase, billing change, task submission, or destructive account action.
- No unsupported private API calls or extraction of cookies, tokens, hidden network payloads, or raw ChatGPT application state.
- No claim that July 9 changed accounting unless a dated primary source states that directly.
- No retroactive email-to-rollout assignment when local events do not carry a provider account subject.

## Completion receipt

Completed July 24, 2026. The implementation now:

- HMAC-pseudonymizes accounts with a Keychain-held secret and supports dated, account-scoped plan registration without retaining raw identity;
- separates scheduled tasks, subagents, CLI/exec, and desktop/extension activity while excluding replayed fork history;
- captures read-only app-server quota and account-usage evidence, plus privacy-reduced visible Work/Codex Analytics observations;
- partitions inference and weekly histories by account scope and plan variant, suppressing pooled conclusions and provider-day ratios at known intraday plan boundaries;
- reprocesses the retained May 17–July 24 local history with Standard API pricing, model/token/speed/surface cuts, and dated provider-policy epochs;
- streams rollout JSONL input with a 16 MiB line cap and writes emitted records in batches of at most 1,000, with a digest-bound recovery journal, fsynced atomic metadata, batch-level checkpoint commits, and replay-safe failure recovery;
- produces the portable report and decision record linked from the project README; and
- maintains a separate [coverage gaps register](./2026-07-24-coverage-gaps-register.md) for unobserved, partially observable, and accounting-ambiguous surfaces.

Verification passed 152/152 Node tests, including injected rollout-batch and provider-snapshot append-success/checkpoint-failure recovery, journal-preparation and committed-batch cleanup recovery, and bounded recent-key compaction, plus the portable report verifier at desktop and narrow viewports, source-dialog keyboard checks, owner-only file-mode checks, and privacy scans for identity, prompts, thread IDs, credentials, balances, and absolute local paths.
