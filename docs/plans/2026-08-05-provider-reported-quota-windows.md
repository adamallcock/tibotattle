---
title: Provider-reported quota windows and plan evidence
date: 2026-08-05
type: plan
status: implementation
---

# Outcome

TiboTattle must display every valid normal Codex quota window that the provider
reports, including a longer primary window when no seven-day window is present.
It must do this without inventing calendar-month semantics, subscription
multipliers, or billing entitlements.

This work changes local analysis and client presentation only. It does not
deploy a Worker, alter D1 or R2, read raw user logs for development, change
OAuth configuration, or publish an app.

## Evidence boundary

The current raw provider `rate_limits` observation uses `plan_type` for the
provider-reported plan label, `window_minutes` for the quota-window duration,
and `resets_at` for the provider-reported reset schedule, alongside the limit,
slot, and current percentage. Unknown or unsupported labels fail closed for
plan evidence: they remain `unknown` and cannot establish an exact plan,
multiplier, entitlement, or absolute allowance. A valid limit and duration may
still select the provider-reported window independently of that label.

`plan_type` is not an exact plan variant. A `plan_variant` such as `pro-5x` or
`pro-20x` is separate dated evidence; it is not derived from `plan_type`. A
provider label alone does not prove a multiplier, current entitlement, or
absolute allowance.

- `300` minutes is named **Five-hour allowance**.
- `10,080` minutes is named **Seven-day allowance**.
- After bounded normalization, any other safe integer from 1 through 525,600
  is a **Provider-reported N-day/hour/minute window**.

A value such as `window_minutes: 43,200` may be formatted as a **30-day
provider-reported window**. It must not be called “monthly”: a duration does
not prove a calendar month or a billing cycle.

## Selection policy

For normal Codex allowance surfaces, select the longest valid
`limitId === "codex"` window. Resolve equal-duration ties using the provider
slot, with `primary` before `secondary`.

This keeps the existing seven-day-over-five-hour choice when those are the only
two windows. Spark and other non-Codex limits remain excluded from that normal
allowance selection.

Weekly history, weekly capacity estimates, and weekly pace are strictly tied
to the 10,080-minute window. A longer current window must not borrow seven-day
history or ranges. Its estimate remains unavailable unless there is matching
calibration for that duration.

## Implementation lanes

1. **Shared analysis**
   - Admit safe integer durations in the bounded range.
   - Preserve named constants and the existing weekly API.
   - Keep duration in every track, reset, rolling, and calibration identity.
   - Make the core pace primitive duration-aware while retaining a seven-day
     wrapper for existing consumers.

2. **Ingestion and local index**
   - Validate raw provider duration at normalization and app-server boundaries.
   - Add duration to the settled/leading-window lookup identity so a five-hour,
     seven-day, and long window cannot collide.
   - Bump the local analysis index semantic version; rebuild from local source
     data through the existing staged publish mechanism.
   - No JSONL, SQLite-column, telemetry-contract, or D1 migration is expected:
     the duration field already exists in those records.

3. **Local companion and Worker analysis**
   - Select the same longest valid normal Codex window.
   - Expose an optional generic quota pace result with its duration.
   - Leave `weekly.paceForecast` exact-seven-day and backward compatible.
   - Add duration to the Worker rolling-observation filter and retain duration
     grouping.

4. **Web and share card**
   - Render fixed, client-owned duration labels; never render a provider label
     as a semantic product name.
   - Select and order normal Codex windows using the shared selection policy.
   - Carry duration into the share card, but omit seven-day range/history data
     for a non-weekly primary window.
   - Keep weekly charts and copy visibly seven-day.

5. **macOS menu and notifications**
   - Decode and label valid generic windows without falling back to an
     incorrect seven-day label.
   - Retain stale hiding and longest-valid selection.
   - Keep notification eligibility separate from generic-window presentation:
     the current gate remains limited to fresh direct-read five-hour and
     seven-day observations until explicitly broadened. Preserve the existing
     fresh, scoped, normal-limit, known-plan, opt-in, dedupe, and
     schedule-only-reset safeguards.

## Acceptance tests

- A 43,200-minute fixture reaches normalization, local persistence, index,
  analysis, export, and presentation without being rejected or called monthly.
- Equivalent provider/limit/slot observations at 300, 10,080, and 43,200
  minutes have separate stale-leading and reset identities.
- Invalid `0`, fractional, unsafe, and greater-than-525,600 durations are
  rejected fail-closed.
- Existing five-hour and seven-day calculations, labels, and weekly forecasts
  remain unchanged.
- A `plan_type: pro` observation does not create `plan_variant: pro-5x` or
  `plan_variant: pro-20x`; the exact variant remains unknown without separate
  dated evidence.
- A non-weekly current window cannot render a seven-day capacity/range/chart.
- A long valid provider window reaches normal analysis and presentation but is
  not currently eligible for the native notification evidence gate, which
  remains limited to fresh direct-read 300- and 10,080-minute windows; push,
  stale, unknown-plan, wrong-limit, and missing-scope observations remain
  rejected there.
- English, Spanish, and Simplified Chinese localization parity is retained for
  the new fixed labels.

## Release boundary

This feature is not evidence of a particular subscription plan and is not a
release authorization. A release candidate still needs the separate signed,
notarized, Sparkle-feed and N-to-N+1 update rehearsal gates.
