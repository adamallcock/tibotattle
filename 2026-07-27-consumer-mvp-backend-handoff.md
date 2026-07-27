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
mode-`0600` `local-backend-lab-receipt-v0.3`, and exits. It prints the exact
temporary state directory so the owner can inspect or move it to Trash.

For an explicitly authorized proof using one real locally sanitized interval,
run `npm run product:backend:acceptance:real-local --` with the required
confirmation, exact UTC start/end, Codex home, owner-only identity file, new
workspace, new receipt destination, and `--cleanup recoverable-trash`. This is
separate from ordinary startup and never becomes an automatic log scan.

To keep the verified backend running:

```bash
npm run product:backend:lab
```

The default portal is `http://127.0.0.1:8792/`. The recovery capability is
written only to the mode-`0600` participant-access file and is not printed.
The laboratory receipt prints the exact path to that file. To inspect the
seeded participant safely, open that specific owner-only file locally, copy
only its current `recoveryCode`, expand **Recover an existing anonymous
participant** in the portal, paste the code, and choose **Recover access**.
Recovery rotates the capability; do not paste it into chat, shell history,
logs, screenshots, or a committed file. The entire laboratory directory is
disposable and should be moved to Trash after inspection.

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

## MVP boundary

| Area | Implementation | Verification | Status |
| --- | --- | --- | --- |
| Real local personal dashboard | Incremental content-free collector plus unified loopback UI | Real retained Codex evidence rendered across every primary view | Verified |
| Privacy preparation and review | Closed-schema builder, independent verifier, prepared spool, exact human review | Real bounded interval plus reviewed-job consent-binding tests and browser inspection | Verified |
| Real sanitized backend path | Local exporter connected to the Worker ingestion contract | One real 200-record contribution completed validation, repricing, D1/R2 lifecycle, private/community analysis, export, restart, and deletion | Verified |
| Community behavior | Twenty isolated pseudonymous participants with clipped, support-gated delayed publication | Synthetic laboratory and rendered participant comparison | Verified |
| Participant rights | Recovery, private results/history, export, individual deletion, complete deletion | Rendered browser controls plus direct post-deletion D1 and R2 inspection | Verified |
| Production Keychain on this Mac | Native Keychain remains the fail-closed default | Existing login Keychain item currently returns `errSecAuthFailed`; explicit owner-file development mode works | Partial environment issue |
| Public service deployment | Disabled-by-default staging configuration only | Configuration and dry-deploy checks | Deferred |
| R7 corpus/runtime qualification | Kept outside the consumer path | Existing unrelated work preserved | Deferred hardening |

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
| Deletion rebuild/withdrawal | Individual and complete deletion exercised in the rendered UI and destructive HTTP acceptance | Verified |
| Participant export | Rendered UI download plus content-free artifact inspection | Verified |
| Persisted restart | Recovery and private statistics restored from the same state | Verified |
| Final storage state | Destructive pass reaches zero live D1/R2 participant data with tombstones retained | Verified |

Both rendered deletion controls validate an exact, participant-bound success
receipt before clearing local access or claiming that deletion completed.
Malformed HTTP-success bodies, mismatched identifiers, negative or non-integer
counts, and unexpected fields fail closed and retain the current UI state.

## Fresh real-local acceptance

On July 27, 2026, the reproducible real-local command completed against the
bounded `2026-07-27T01:00:00.000Z`–`02:00:00.000Z` interval:

- 394 sanitized usage events and 402 quota snapshots passed the independent
  source privacy verifier;
- four bounded prepared contributions were committed;
- the selected 200-record contribution passed the same twenty-participant
  acceptance lifecycle used by the generated fixture;
- rejection, deduplication, server repricing, private and community results,
  export, restart, and both deletion scopes all passed; and
- final live participants, contributions, canonical records, quarantine
  references, and R2 objects were all zero.

The secret-bearing workspace and temporary development identity were moved to
Trash. The durable
`.usage-monitor/private/real-local-backend-acceptance-2026-07-27-v0.1.json`
receipt is content-free and contains no paths, credentials, account or
participant identifiers, or source content.

The automated destructive acceptance pass remains authoritative for the
all-participant zero-state assertions. A separate browser pass used one
disposable seeded participant and exercised recovery, private results,
participant export, individual-contribution deletion, and complete-participant
deletion through the rendered controls. The same run then inspected D1 and R2
directly.

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

A final July 27 pass after the reviewed-upload binding fix rendered all nine
primary destinations from the same unified loopback page: Overview, Timeline,
Weekly, Accounting, Community, Your data, Gaps, Privacy, and Backend. It
confirmed real local values in each view, a ready central health state, delayed
twenty-participant community evidence, local preparation, and an exact
4.2-KiB queued-payload review with send disabled before review and enabled only
after review. The browser reported zero console errors. The reviewed action is
now a single-use, ten-minute opaque authorization held by the loopback server
and bound to one queue job plus its prepared-file digest; the queue runner can
claim only that exact job. A focused re-audit found no remaining
high-confidence consent-binding defect.

The first final browser pass did not create or remove a participant. Its
foreground delivery attempt reached the central service but was rejected
because the isolated local device had not been paired; the reviewed
authorization was consumed and no other queued item was sent. That remains an
honest negative device-path receipt rather than an accepted-upload claim.

A subsequent disposable seeded-participant pass closed the participant-rights
gap:

- browser recovery restored one contribution, one usage event, one quota
  snapshot, `$0.0032` of server-repriced API-equivalent usage, its private
  comparison, and the twenty-participant delayed community snapshot;
- the rendered export control produced a 4,517-byte
  `participant-export-v0.2`; recursive key and content scans found no local
  paths, credentials, email addresses, raw-content canaries, or upload
  capabilities (`fileSearch` was the permitted coarse tool-class field);
- individual deletion removed the contribution from private results, changed
  D1 from 20 to 19 accepted contributions and 40 to 38 canonical records, and
  visibly withdrew the community revision;
- complete participant deletion hid the private controls, emptied contribution
  history, rendered `No personal result is available`, reported one deleted
  contribution batch, and left 19 active participants, 19 accepted
  contributions, 38 canonical records, 19 active sessions, one deletion
  tombstone, no retained quarantine references, and a complete direct R2
  object count of zero; and
- the deletion browser pass reported zero console errors. Its disposable state
  and downloaded export were moved to Trash after verification.

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
- The normal queued contribution can now be opened through an authorized
  loopback exact-review action. The page shows every verified retained field
  and value, performs no service request, and keeps sending disabled until
  that review succeeds. An explicit owner-only development identity file is
  available for isolated testing; production still fails closed on Keychain
  access and never falls back.
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
