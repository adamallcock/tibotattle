---
title: Consumer MVP Backend Handoff
date: 2026-07-27
type: runbook
status: verified-local
---

# Consumer MVP backend handoff

## Outcome

Usage Monitor now has a disposable, locally testable end-to-end service rather
than only a static dashboard. The unified loopback app can exercise the
production-shaped Worker lifecycle while raw Codex logs remain local:

1. The local companion reads retained, content-free local evidence.
2. The browser validates an explicitly selected
   `telemetry-contribution-v0.1` file and shows its exact retained values.
3. The browser encrypts that contribution with the service envelope key.
4. The participant receives a one-use upload authorization.
5. The Worker decrypts into bounded memory, validates the closed schema,
   canonicalizes API-price-equivalent accounting, and writes accepted state.
6. D1 stores canonical participant, contribution, occurrence, and result data.
7. R2 stores the encrypted quarantine object.
8. Private statistics, history, insights, export, and deletion remain available
   through the same local product origin.
9. Thresholded community results publish only when eligibility requirements are
   met and are rebuilt or withdrawn after deletions.

This is verified local-development evidence. It is not a production deployment,
and external participant collection remains disabled.

## Start and inspect the backend

Run the complete disposable backend acceptance test and exit:

```bash
# One-time setup on a clean checkout; writes ignored mode-0600 local keys.
npm run product:keys:local

npm run product:backend:acceptance
```

The command creates isolated local D1/R2 state, runs destructive lifecycle
acceptance, creates an inspectable 20-participant state, restarts the Worker
against that state, verifies recovery and private statistics, writes a
mode-`0600` `local-backend-lab-receipt-v0.2`, and exits. It prints the exact
temporary state directory so the owner can inspect or move it to Trash.

To keep the verified backend running:

```bash
npm run product:backend:lab
```

The default portal is `http://127.0.0.1:8792/`. The recovery capability is
written only to the mode-`0600` participant-access file and is not printed.

## Start the unified consumer experience

With the backend laboratory running:

```bash
USAGE_MONITOR_PORT=8791 \
  USAGE_MONITOR_CENTRAL_ORIGIN=http://127.0.0.1:8792 \
  npm run product:local
```

Open `http://127.0.0.1:8791/`. This is the preferred local product surface. It
combines real locally derived usage analysis with the optional central
participant lifecycle.

The local service is not a generic reverse proxy. The central origin must be
loopback, and only an exact route/method allowlist is accepted. Request and
response JSON are bounded. Only the fixed Usage Monitor session cookie,
correctly shaped CSRF value, and route-specific one-use upload authorization
can cross the relay. Unexpected cookies, redirects, content types, paths,
queries, headers, or hosts fail closed. Participant export has its own bounded
192 MiB response allowance so the maximum valid retained history is not cut off
by the ordinary 4 MiB API-response ceiling.

## Backend acceptance matrix

| Capability | Verification | Result |
| --- | --- | --- |
| Pseudonymous enrollment and recovery | HTTP lifecycle plus persisted restart | Verified |
| One-use upload authorization | Accepted once; scope conflict rejected | Verified |
| Browser-side encryption | Real sanitized contribution uploaded through rendered UI | Verified |
| Closed-schema validation | Valid contribution accepted; invalid schema rejected | Verified |
| Forbidden-content boundary | Privacy canary rejected | Verified |
| Size, count, and time bounds | Oversized, over-count, and out-of-range timestamp cases rejected | Verified |
| Participant-scoped deduplication | Idempotent replay and canonical state asserted | Verified |
| Canonical API repricing | Client values compared with server-calculated values | Verified |
| D1 ingestion | Direct database counts and lifecycle state inspected | Verified |
| Encrypted R2 quarantine | Binding reachability and zero-orphan deletion/restart state checked; accepted objects may be processed before inspection | Verified lifecycle; positive retention not directly observed |
| Private participant results | Statistics, insights, profile/history rendered and asserted | Verified |
| Community aggregation | Twenty isolated participants publish thresholded snapshot | Verified |
| Deletion rebuild/withdrawal | Individual and complete deletion acceptance | Verified |
| Participant export | Content-free export verified and rendered UI action exercised | Verified |
| Persisted restart | Recovery and private statistics restored from the same state | Verified |
| Final storage state | Destructive pass reaches zero live D1/R2 participant data with tombstones retained | Verified |

The automated destructive acceptance pass is authoritative for deletion
storage assertions. Browser QA stopped before clicking irreversible deletion
controls; the rendered controls and non-destructive export journey were
inspected, while deletion was proven against isolated disposable state by the
HTTP acceptance test.

## Rendered browser evidence

- [Consumer overview](./docs/qa/2026-07-27-consumer-overview.png)
- [Real local usage timeline](./docs/qa/2026-07-27-consumer-timeline.png)
- [Interactive UTC quota timeline](./docs/qa/2026-07-27-interactive-quota-timeline.jpg)
- [Mobile timeline controls](./docs/qa/2026-07-27-mobile-timeline-controls.jpg)
- [Exact pre-upload inspection](./docs/qa/2026-07-27-exact-pre-upload-inspection.jpg)
- [Private server-calculated results](./docs/qa/2026-07-27-unified-private-results.png)
- [Backend status](./docs/qa/2026-07-27-unified-backend-status.png)

The real inspected contribution contained 99 usage rows and 101 quota rows and
was exactly 213,315 bytes. The UI showed the schema and counts before consent, with an
expandable plaintext review of every validated field and value. A synthetic
file with the wrong contract was visibly rejected before upload. The accepted
real contribution produced private server-repriced results and contribution
history through the unified local origin.

## What remains before an outside pilot

These are deliberate boundaries, not hidden completion claims:

- The loopback app can now prepare the latest covered hour in one click. It
  writes a verified review pair and committed prepared batches locally,
  performs no upload, and refreshes the foreground queue. The existing file
  picker remains available for exact plaintext review of an already prepared
  batch. This machine's normal profile currently cannot complete preparation
  because its existing Keychain identity is unreadable; the app fails closed
  with fixed guidance rather than overwriting that identity. Read-only
  diagnosis found the item at the exact expected service/account, but the
  login Keychain returns `errSecAuthFailed` for this and other application
  items. The next safe action is a manual `login` Keychain unlock in Keychain
  Access followed by a retry—not reset, deletion, ACL broadening, or identity
  rotation.
- A fresh companion checkpoint now indexes a fixed recent seven-day window
  with bounded path-free progress and durable pause/resume. Existing
  prospective checkpoints are not rewound; they are labelled honestly with
  their retained coverage dates and remain partial historical evidence.
  Oversized rollouts now use a bounded 768 MiB recent tail and 32 MiB state
  prelude under a 1.5 GiB per-pass budget. Missing cumulative state never turns
  a total into an invented usage delta, and a tail that cannot reach the
  requested boundary is labelled partial. Alignment is budgeted before I/O,
  and an out-of-order timestamp permanently downgrades the affected tail to
  partial. An isolated real-source rerun with those checks proved the
  seven-day boundary after seven resumable passes: 459 selected files and
  478,389 safe records in 60.6 seconds of collector time.
- Timeline range, hour/day/week grouping, 15-minute/one-hour/three-hour
  smoothing, UTC/local labels, residuals, and weekly uncertainty are present.
  The quota chart now uses timestamp-proportional spacing, keyboard and
  pointer-drag navigation, wheel zoom, explicit zoom/pan/reset controls,
  exact UTC/local inspection rows, and shaded missing/reset/ambiguous
  intervals where live evidence exposes those states. Residuals are restricted
  to the visible interval and fall back to the displayed comparison series
  instead of silently showing an unrelated historical period.
- The reusable backend is local-only. Public HTTPS staging, remote D1/R2
  provisioning, backups, alerting, abuse controls, external review, and
  production deletion exercises are explicitly deferred.
- A dedicated narrow rendered pass succeeded at an effective 293 px browser
  content width (stricter than the requested approximately 390 px target):
  no document-level horizontal overflow, 48 px-high timeline navigation
  controls, and intentional horizontal scrolling only inside the nine-item
  primary navigation.
- R7 large-corpus and dual-runtime receipt regeneration is intentionally
  separate hardening work. Existing unrelated R7 worktree changes were
  preserved and were not included in this implementation.

## Focused verification commands

```bash
npm run product:ui:test
npm run product:local:test
npm run product:backend:test
npm --prefix apps/worker run scripts:check
npm run product:backend:acceptance
git diff --check
```

The July 27 continuation reran the disposable 20-participant backend
acceptance successfully. Every safe-ingest, rejection, deduplication,
server-repricing, personal-statistics, aggregate, export, deletion, and
persisted-restart flag was true. The secret-bearing laboratory state and the
isolated browser-QA spool were moved to Trash after verification.

The backend acceptance receipt, rather than a screenshot alone, is the compact
machine-readable proof for safe acceptance, rejection, deduplication,
repricing, persistence, private/aggregate statistics, export, and both deletion
scopes.
