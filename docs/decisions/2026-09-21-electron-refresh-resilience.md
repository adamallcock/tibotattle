---
title: Electron refresh leases are observable and self-healing
date: 2026-09-21
type: decision-record
status: accepted
---

# Electron refresh leases are observable and self-healing

The Electron shell owns automatic refresh cadence while the dashboard renderer
owns the loopback refresh request and its progress UI. A refresh lease connects
those responsibilities. This decision keeps that lease bounded, observable and
recoverable without allowing the shell to start overlapping local analysis.

## Lifecycle contract

- The renderer starts a lease only after the local companion accepts a refresh.
  The request carries the closed `quick` or `detailed` mode and returns one
  positive integer lease.
- While the operation remains active, the renderer renews that exact lease with
  a numeric heartbeat every 30 seconds. Quick and detailed work use different
  missing-heartbeat bounds so an orphaned quick refresh recovers sooner while a
  detailed renderer has more tolerance for heavy presentation work.
- A separate 243-minute absolute deadline is measured from lease creation and is
  never extended by heartbeat. It exceeds the renderer's current 241-minute
  polling window without allowing a live renderer bug to reserve cadence
  indefinitely.
- Terminal settlement is idempotent for the most recently settled lease. A
  valid settlement clears both watchdogs and rearms exactly one timer from the
  latest persisted interval. Stale or foreign leases cannot change cadence.
- Dashboard replacement, missing heartbeats and the absolute deadline all clear
  an abandoned lease and rearm cadence. They preserve the companion's own
  single-operation authority, cancellation and checkpoint rules.

## Presentation and support contract

- Dashboard and tray observation age are both derived from
  `freshness.latestObservedAt` against the current wall clock. A serialized
  `ageSeconds` value cannot keep either surface visually fresh after time passes.
- When an observation crosses its stale boundary, the open dashboard updates its
  timestamp, freshness state, allowance qualifiers and pacing presentation
  without waiting for another API response.
- A renderer that finishes while Electron still reports its lease active shows
  a bounded automatic-refresh recovery message. Unknown staleness remains a
  request to update, not a claim about why provider evidence stopped.
- Content-free diagnostics expose whether the cadence timer and watchdog are
  armed, the active mode and lease age, the latest start, heartbeat, settlement
  and recovery times, and a closed recovery reason. They never expose a lease
  value, path, account identifier, credential or session content.

## Required evidence

The retained regression must exercise renderer lifecycle code through the real
preload request builder, IPC validator and controller for at least two complete
automatic cycles. Fake-clock checks must cover normal settlement, delayed
responses, malformed bridge arguments, heartbeat recovery, absolute recovery,
dashboard replacement and stale-boundary presentation. Browser rendering and an
unsigned package remain separate from installed, signed and updater evidence.
