---
title: TiboTattle local-only quota notifications
date: 2026-08-03
type: decision-record
status: implemented-foundation
---

# TiboTattle local-only quota notifications

## Decision

TiboTattle may offer native macOS allowance notifications only as an explicit,
local-only opt-in. The feature is evaluated only after the app's existing
foreground refresh reaches a terminal state. It adds no daemon, Login Item,
LaunchAgent, privileged helper, independent timer, network poller, upload, or
remote notification identity.

The sole eligible input is a newly completed, direct Codex app-server
`account/rateLimits/read`, recorded by the existing collector as
`openai_codex` / `app_server_read` with zero staleness. The notification bridge
receives a small, closed projection of that one read; it does not read the
dashboard overview, collector history, logs, forecasts, token estimates,
or any mixed-source aggregate. The collector uses its existing local
pseudonymous account scope only to derive a second one-way continuity key; the
scope itself is not exposed to the native receipt, notification text, or
notification state.

The bridge also drops a direct receipt if it is more than five minutes old when
the foreground refresh finishes (or appears to be from the future). This clock
check can only suppress an alert; it is never itself an alert trigger.

## Eligibility state machine

```text
off
  -> user enables in Settings
  -> ask macOS only if authorization is not determined and has not already
     been requested
  -> authorized or provisional authorization
  -> await fresh direct provider observation
  -> first eligible observation: retain baseline, notify never
  -> later eligible observation:
       same provider window + newly crossed configured threshold -> one alert
       changed explicit provider reset identity -> optional reset alert
       otherwise -> no alert
```

Any unavailable provider, failed refresh, malformed/schema-changed payload,
stale value, inferred value, mixed source, log-derived value, unobserved value,
unknown classification, duplicate/reordered observation, or missing reset
identity returns to an ineligible/no-alert state. Ordinary clock passage is
never an event. An ineligible interval also clears only the comparison
baselines, so the next fresh receipt is a new first observation rather than a
threshold or reset transition inferred across an evidence gap. Existing
idempotency keys remain intact.

The direct provider `resetsAt` field is retained only as a reported schedule
and local threshold-dedupe partition. It is not an observed reset transition
or reset identity. A reset alert requires two consecutive fresh direct reads
whose explicit opaque provider reset identities differ. The current
`account/rateLimits/read` receipt has no such identity, so reset alerts are
truthfully suppressed for this source. The app does not schedule an alert at
`resetsAt`, predict a reset, or derive a reset from a percentage decrease.

## Settings, permission, and defaults

Notifications start off. Turning the switch on is the only action that may ask
macOS for notification authorization. The first opt-in applies conservative
defaults: usage alerts at 80% and 90% consumed. Settings exposes usage alerts
off, 90% only, or 80% and 90%. It also visibly shows the new-window control as
unavailable while the current provider receipt supplies only a reset schedule;
the control stays off. Later opt-outs retain preferences but immediately
disable delivery and clear only notification baselines, pending request
identifiers, and dedupe keys.

Notification copy is fixed and path-free. It says that the observation was
fresh and provider-reported, names only the configured threshold or a new
allowance window, and sends the person back to TiboTattle for details. It never
contains an account name, plan, workspace, repository, file path, prompt,
response, raw log value, reset timestamp, or notification-state payload.

## Persistence and idempotency

The owner-only app-state file contains only the opt-in preferences,
authorization-prompt attempt, safe supported-window baselines, bounded
per-window/threshold/reset dedupe keys, and native request identifiers. It
contains neither a raw/provider account subject nor notification text and is
never sent to the companion or hosted service. Its continuity key is a second
one-way local digest used only to avoid comparing different locally observed
accounts. A baseline records a direct-observation time, used percentage,
reported schedule, and only an explicitly supplied opaque reset identity.
Equal or older observations do not change it. The store uses a local advisory
lock plus no-follow descriptor validation and atomic replacement, so parallel
native processes cannot interleave baseline/dedupe writes. This makes a
relaunch, duplicate endpoint response, sleep/wake re-read, transient delivery
failure, or five-minute refresh unable to replay a threshold or reset alert.

At most one local notification is submitted for a single fresh provider
observation. When one read crosses multiple configured thresholds, the highest
crossed threshold is the one surfaced and every crossed threshold key is marked
handled. A reset transition wins over threshold evaluation for its new window.

## Deliberate non-goals

- no completion, forecast, scheduled-reset, token-estimate, price, or
  historical-log notifications;
- no alert for stale, inferred, mixed, unknown, or unobserved quota state;
- no push service, email/SMS identity, account upload, remote state, or
  analytics emission;
- no separate long-running app-server connection for notifications; and
- no claim that a local alert is a real-time provider guarantee.

The implementation is covered by deterministic injected evidence-provider and
notification-center adapters. Automated tests use fakes only and never submit a
real macOS notification. Human release verification still needs one explicit
macOS permission/Settings exercise with a controlled fresh provider refresh.

## 2026-08-04 hardening amendment

Each local companion refresh now receives an opaque UUID run token. The native
shell accepts notification evidence only when the terminal receipt carries the
same token as the foreground refresh it started or joined. Missing, malformed,
replaced, failed, or still-running receipts are `unobserved` and never alert.
The token is not persisted, uploaded, or placed in notification text.

Changing opt-in, threshold, or reset preferences advances an in-memory
evaluation epoch. Delayed evidence reads, authorization responses, and
notification-delivery callbacks from an earlier epoch are ignored, preventing
a disable/re-enable race from creating an alert, prompt loop, or overwritten
Settings status. Returning to the app performs a read-only authorization
resynchronization; it never prompts unless the user explicitly enables
notifications.
