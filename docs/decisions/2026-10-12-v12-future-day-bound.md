---
title: Bound v1.2 usage days against server time
date: 2026-10-12
type: decision-record
status: accepted
---

# Bound v1.2 usage days against server time

> **Accepted.** The owner approved this policy in chat on 2026-10-12, with the
> instruction that no new client be released for it. It mirrors the community
> speed report-day window. The source change is on the GCP line only. It is not
> deployed: the origin roll, analytics kernel 18 and its reprice are separate,
> owner-run gates.

## Context

Before this change, v1.2 admission compared a chunk day only with its own day
manifest: each event had to fall on the manifest's UTC day. Nothing compared the
day with the server's clock, so a day manifest and its chunks were accepted for
days after the current UTC day. The analytics refresh then planned through
`max(queued days, today)` and published those future days.

## Decision

### Admission

- The origin refuses a v1.2 day manifest, and a v1.2 chunk, whose UTC day is
  later than the server's current UTC day plus one.
- Past days stay unbounded: history backfill is legitimate.
- The answer is `429 TELEMETRY_DAY_NOT_YET_ADMISSIBLE` with `retry-after` set to
  the seconds until the refused day becomes admissible, at most seven days. The
  refusal reads only the request's day and the server clock. It carries no
  identifier, no content and no detail.
- A manifest is refused after the device's write authority is rechecked, so a
  revoked or blocked device keeps its own answer. A chunk is refused before the
  origin writes its object, so nothing is stored and the claimed upload grant is
  abandoned.

### Refresh

- The refresh never plans or publishes a day after the server's current UTC day.
- A queued future day is deferred. The run reports it among its blocked days,
  which queue semantics carry into the next run, and counts it in the receipt's
  `deferredFutureDays`. Once the day is no longer in the future, it publishes
  normally.
- The occurrence range and the evidence plan end at the current UTC day. Future events no longer enter fits, model dates or owner-day
  rows until their day arrives.
- A published head for a future day, written before this change, is kept: a
  deferred day is never written, so it keeps its prior row until it publishes
  again.

## Why 429, from the released client's code

The released client is `origin/main` (identical to v0.1.28) at
`src/contribution/telemetry-sync-protocol.js`, `classifyResponse`, with the
schedulers in `src/application/accountless-contribution-scheduler.js` (the
default accountless path) and `src/application/local-incremental-contribution-sync.js`
(the consented path).

| Answer to the day manifest | Released client result | Harm |
|---|---|---|
| Device codes (`DEVICE_AUTH_INVALID` and others) | `device_unavailable`, not retryable | Both schedulers pause all sharing |
| `TELEMETRY_CONSENT_INVALID`, `TELEMETRY_TRANSPORT_BLOCKED` | `consent_rejected`, not retryable | Both schedulers pause all sharing |
| Any other 4xx except 408 and 429 (for example 400, 403, 422, 425, or 409 with an unlisted code) | `authorization_rejected`, not retryable | Both schedulers pause all sharing |
| 409 with a listed conflict code | `revision_conflict`, retryable, no `retry-after` | The resumable day journal is erased; retried on the backoff ladder (at most one hour, or four hours accountless) forever |
| 429 with an admission-limit code | `admission_exhausted`, retryable, honours `retry-after` | Waits without pausing, but records a spent upload budget, which is false |
| 408, 5xx, or 429 with any other code | `service_unavailable`, retryable, honours `retry-after` up to seven days | Waits without pausing; the journal is kept |

The last row is the least harmful class. A 429 is chosen within it, with an
honest closed code, so a deterministic "not yet" never reads as an outage or
pollutes 5xx monitoring. The released protocol reads the bounded 429 body,
finds no admission-limit code and returns `service_unavailable` with the
`retry-after` delay. The accountless scheduler then waits in `retry_wait` for
at least that delay, and the consented scheduler retries at
`max(backoff, retry-after)`; neither pauses sharing. Unrelated days are not
lost: the days before the refused one are already staged on the server, and the
client's journal keeps them for the next pass.

## Residual cost

Every answer, 429 included, holds that device's next domain activation until
the refused day is admissible. The released client activates one contiguous
vector of days and needs a candidate for each day in it, so it cannot skip the
refused day. Its vector always ends at the device's latest local data day:
`src/contribution/telemetry-sync-protocol.js` takes the later of the active
`throughDay` and the last day `reader.days()` returns, and that reader has no
clock bound. Local days are dated from the timestamps of the device's own
sources. Activation is reached only after every day in the vector has been
registered. How long the hold lasts therefore depends on whether the skew is a
one-off or persistent:

- A device whose clock is correct, or ahead by less than a day, is never
  refused.
- A one-off future day holds the device once, for example after a clock that
  was briefly wrong has been corrected. If the day is two to eight days ahead,
  the device resumes at the `retry-after`, when that day becomes admissible. If
  it is further ahead, the device re-polls at most once every seven days until
  then.
- A device whose clock stays two or more days ahead of UTC is held
  indefinitely while it is in use. Each new local day it records lies past the
  server's UTC day plus one when it is recorded, so every pass ends in a refused
  day and activation is never reached. None of its usage reaches publication,
  including the earlier days it has already staged on the server. It retries at
  each `retry-after`, which is about every (skew minus one) days: near daily
  when the skew is about two days, and at most weekly when it is larger. Its
  accountless scheduler shows a transient `retry_wait`, not a pause, and nothing
  asks the user to act. The hold ends when the clock is corrected, or, while
  the clock stays wrong, only after the device records no usage for longer than
  about (skew minus one) days. The next pass then resumes from the kept journal
  and activates.
- A device whose clock stays between about one and two days ahead is held
  intermittently. Its latest local day lies past the bound only during the part
  of each server day when its local date is two days ahead. A pass whose vector
  ends on an admissible day still activates, so publication is delayed rather
  than stopped.

Before this change, all of these devices' future days were accepted and
published. Content-free server signals cannot say which device is held; the
[runbook](../runbooks/gcp-brake-and-incidents.md#future-dated-v12-days)
describes how to recognise the persistent case. Removing the hold needs a client
that bounds its own day vector, which the owner excluded ("No new client"). That
decision accepts that a persistently skewed device stays held for as long as its
clock stays wrong, not for one retry.

## Existing rows

Rows admitted before this change are not changed or deleted. The read-only
aggregates in
[GCP brake and incidents](../runbooks/gcp-brake-and-incidents.md#future-dated-v12-days)
count stored v1.2 manifests, chunks and records whose chunk day is after the
current UTC date, grouped by day, and the published heads of such days, with no
identifiers. A stored future manifest is refused on replay like a new one, so a
released client cannot activate it before its day is admissible; the refresh
defers its day in any case.

## Implementation

- `apps/worker/src/telemetry-v12-day-bound.ts` holds the bound and the
  retry-after; it imports nothing, so the origin's plain-JavaScript chunk
  handler and the TypeScript admission share it.
- `src/postgres-typed-v12-admission.ts` applies it to manifest registration and
  chunk persistence; `cloud-run/postgres-test-dispatch.mjs` applies it to a
  decrypted chunk before the object write.
- `cloud-run/analytics-refresh-read.mjs` (`analyticsRefreshDeferFutureDays`)
  defers the days; `cloud-run/analytics-refresh.mjs` adds `deferredFutureDays`
  to the receipt's closed read counts.
- `postgres-test/postgres-production-host.spec.mjs` runs the released client's
  own transport and accountless scheduler against the composed origin through
  the refusal and the resumed activation.

## Analytics kernel

The refresh change edits `cloud-run/analytics-refresh-read.mjs` and the error
code edits `src/errors.ts`, both compute-closure inputs, so it is analytics
kernel 18. A clamp outside the closure (for example in the Job shell) would
change which days are computed and published, and the occurrence range fits and
model dates read, without changing the kernel identity, so it was not taken.
The pricer is unchanged. The deployment needs the kernel 18 registry entry and
its `REGISTRY_PINS` line, and the analytics reprice immediately after the roll,
as every kernel change does.

## Gates not covered here

- Origin roll, kernel 18 activation and the post-roll reprice (owner-run).
- Running the existing-row aggregate against production (owner-run, read-only).
- A refused day's activation hold, described above, cannot be removed without a
  client change. For a device whose clock stays ahead, the hold is open-ended.
