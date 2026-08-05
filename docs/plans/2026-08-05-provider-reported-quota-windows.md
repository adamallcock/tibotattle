---
title: Provider-reported quota windows and plan evidence
date: 2026-08-05
type: plan
status: implementation
---

# Outcome

TiboTattle must display every valid normal Codex quota window that the provider
reports, including a longer primary window used on plans that do not have a
seven-day limit. It must do this without inventing calendar-month semantics,
subscription multipliers, or billing entitlements.

This work changes local analysis and client presentation only. It does not
deploy a Worker, alter D1 or R2, read raw user logs for development, change
OAuth configuration, or publish an app.

## Evidence boundary

The authoritative observation is a provider-reported numeric
`windowDurationMinutes` together with its `limitId`, `planType`, current
percentage, slot, and reset schedule.

- `300` minutes is named **Five-hour allowance**.
- `10,080` minutes is named **Seven-day allowance**.
- Any other safe integer from 1 through 525,600 is a **Provider-reported
  N-day/hour/minute window**.

A value such as 43,200 minutes may be formatted as a 30-day provider-reported
window. It must not be called “monthly”: a duration does not prove a calendar
month or a billing cycle.

Likewise, a `planType` observation may be displayed as, for example,
“provider reported plan type: pro.” It cannot prove an exact Pro multiplier,
current entitlement, plan variant, or absolute allowance. Those remain
unknown unless the provider independently exposes them in the same scoped,
fresh observation.

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
   - Broaden notification duration validation only. Preserve the existing
     direct-read, fresh, scoped, normal-limit, known-plan, opt-in, dedupe, and
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
- A non-weekly current window cannot render a seven-day capacity/range/chart.
- A long valid direct-read observation can pass notification duration gating,
  while push, stale, unknown-plan, wrong-limit, and missing-scope observations
  remain rejected.
- English, Spanish, and Simplified Chinese localization parity is retained for
  the new fixed labels.

## Release boundary

This feature is not evidence of a particular subscription plan and is not a
release authorization. A release candidate still needs the separate signed,
notarized, Sparkle-feed and N-to-N+1 update rehearsal gates.
