---
title: Telemetry v1.2 sync hardening
date: 2026-09-26
type: plan
status: ready-for-review
---

# Telemetry v1.2 sync hardening

## Boundary

This plan covers hosted Worker source, three new Rate Limit bindings, the
typed production deployment path that adds them, and local proof. It builds on
the v1.2 first-sync fix (predecessor seeded with the current day, empty-day
manifests through ingestion-isolation `0012`, a fingerprint without the
device's manifests), which is described in the
[v1.2 public eligibility plan](2026-09-25-v12-public-eligibility.md). This
change adds no migration and edits none.

Nothing here has been deployed, applied to a remote database, or checked
against production data. That production runs the first-sync source with
`0012` applied is reported by its pull request, not verified here; the
deployment order below reads it back first.

## Findings (local, 2026-09-26)

The shipped 0.1.24 client modules were driven against the Worker's
`handleRequest` on the first-sync source, with the checked-in limits:

1. **Device-sync admission.** Capabilities, day-manifest registration, the
   domain predecessor and activation were all charged to the attempt budgets
   meant for unauthenticated requests: 5 per minute per client address and
   one 20-per-minute key per location shared by every device. A v1.2 pass
   needs N + 6 of those requests for an N-day domain; the six fixed requests
   alone exceed the per-address budget. At the production limits a fresh
   install with 40 days of history is refused at its sixth request
   (`429 ATTEMPT_LIMIT_REACHED`). Even at the local limits (20 per minute per
   location), two five-day passes cannot run in the same minute. Each refusal
   is retryable, so installs keep retrying, and a pass can complete only if it
   happens to straddle a window boundary.
2. **Day limit counted rows.** The predecessor counted a device's ready
   manifest rows against the 4,096-day limit. Every changed day keeps its
   earlier manifests (new records or a parser release re-digest it), so a
   long-lived install would reach `400 SYNC_RANGE_TOO_LARGE`. The client treats
   a 400 as final, the scheduler pauses the install, and every later attempt
   fails the same way. 4,108 ready versions over three days already trigger
   it.
3. **Idle passes wrote generations.** The client activates at the end of every
   pass, and its domain digest covers the predecessor token, which is new each
   pass. Activation short-circuited only on an identical digest, so every idle
   pass inserted a generation of every domain day, moved the head and, for an
   eligible owner, journaled an owner change that advances the public
   authority epoch.
4. **Unpaced storage refusals.** A deterministic SQLite constraint failure
   (for example the empty-day `CHECK` on a role without `0012`) answered
   `503 BACKEND_STORAGE_UNAVAILABLE` without `Retry-After`, so the client
   retried it on its own backoff, starting at one minute, although the same
   refusal repeats.
5. **The typed deploy could not add bindings.** The guarded typed production
   deployment reproduces the live bindings exactly, so a Rate Limit binding
   the source requires could never reach production through it.

## Changes

- **Device-sync admission** (`src/admission.ts`, `deviceSyncPrincipal` in
  `src/index.ts`). A request without a well-formed device bearer, or with a
  cookie, is charged to the unchanged attempt budgets before any D1 work.
  Every well-formed bearer, valid or not, is charged before credential
  verification to `DEVICE_SYNC_CLIENT_RATE_LIMIT` (per client address) and
  then `DEVICE_SYNC_RATE_LIMIT` (per location). A bearer that fails
  verification is also charged to the attempt budgets, which answer repeated
  failures from one address with 429. An authenticated request is charged to
  `DEVICE_SYNC_PRINCIPAL_RATE_LIMIT` (per participant). A device-sync refusal
  is `429 DEVICE_SYNC_LIMIT_REACHED` with `Retry-After: 60`, which the client
  retries.
- **Limits.** Production and staging: 4,200 per minute per participant and
  per address (4,096 day manifests plus six fixed requests, with headroom for
  the performance stream) and 6,000 per minute per location. The address
  budget stays below the location cap, so one address can neither drive more
  credential checks than one pass nor exhaust its location. Namespaces are
  3009–3011 (production), 2009–2011 (staging) and 1009–1011 (local). Health
  and readiness require the bindings; the staging gate pins them.
- **Predecessor day counting** (`src/telemetry-v12-domain.ts`). The
  predecessor reads one ready manifest per day (the earliest, as before), so
  its range and the 4,096-day limit count days.
- **Unchanged acknowledgement.** Activation returns the active generation
  with `replay: true`, `unchanged: true` and `requestedManifestDigest`, and
  writes nothing, when this device's head has the same range and days, the
  presented predecessor is current and pins that head, and the participant's
  analytical input is still at the revision the head was activated under.
  One statement checks all of it. Any other change still activates a new
  generation. The shipped client already accepts this receipt, as it does for
  v1.1.
- **Paced storage refusal** (`src/telemetry-v12-repository.ts`). A constraint
  failure that no specific mapping covers, during staging or activation, is
  `503 TELEMETRY_STORAGE_CONSTRAINT` with `Retry-After: 3600`. The
  accountless scheduler waits at least that long before its next attempt,
  and the pass keeps its journal.
- **Typed deployment** (`scripts/production-live-config.mjs`,
  `production-deploy.mjs`, `production-reconcile.mjs`). The renderer adds a
  Rate Limit binding only when it is pinned in
  `PRODUCTION_RATE_LIMIT_ADDITIONS` (name, namespace, limit and period),
  `wrangler.jsonc` declares it identically, and live has neither its name nor
  its namespace. Any other missing tracked Rate Limit binding fails closed.
  Reconciliation reports `rateLimitAdditions`, and after Wrangler the wrapper
  requires the live configuration to equal the baseline plus exactly those
  bindings. See the
  [production runbook](../runbooks/production-operations.md#guarded-deployment-wrapper).

## Deployment order (owner-authorized, protected)

Every step below is an owner operation. A dry run or a green local gate is not
authorization for any of them.

1. Read-only: confirm the live Worker's source commit (the reviewed
   predecessor for `--expected-previous-source`), and that
   ingestion-isolation `0012` is recorded in the primary role's migration
   ledger. This source must not run against a role without `0012`: its first
   non-empty day would make `0012`'s guard refuse that role.
2. Capture a fresh private inventory and run the read-only reconciliation for
   this commit. Proceed only if it is `compatible` with
   `configurationPreserved: true` and `rateLimitAdditions` is exactly
   `DEVICE_SYNC_CLIENT_RATE_LIMIT`, `DEVICE_SYNC_PRINCIPAL_RATE_LIMIT` and
   `DEVICE_SYNC_RATE_LIMIT`. Stop on any other difference.
3. Deploy through the guarded typed wrapper only. It adds the three bindings
   with the code and afterwards requires the live configuration to be the
   baseline plus exactly those bindings. Without them this source answers 503
   on every device-sync route and on health, so never deploy it through a
   path that cannot add them.
4. Verify health and readiness, and that `deployment.sourceCommit` is this
   commit. Over the next passes (installs retry within four hours), read only
   aggregates: v1.2 manifest, chunk, domain and head counts, and domain
   generations against head revisions, which should stop growing for idle
   devices.
5. The added bindings change the live configuration fingerprint. Prepare any
   maintenance or typed-forward plan pinned to the previous fingerprint again.

Rolling back to the previous source through the same wrapper keeps the three
bindings, because the renderer carries every live binding; the older code
ignores them. It also restores the attempt-budget admission, so v1.2 passes
would stall again.

## Validation

Recorded in the pull request. The local proof is
`apps/worker/test/telemetry-v12-accountless-client-http.spec.ts` (the real
client over HTTP: bootstrap, gap days and all three streams, second pass,
journal resume, unchanged acknowledgement, day counting over accumulated
versions, the checked-in production limits, unauthenticated budgets,
per-address refusal before D1, participant pacing, the paced refusal without
`0012`, opt-out, eligibility and erasure), the live-configuration, typed
deployment and reconciliation checks for the pinned additions, the root client
contract test, TypeScript and the complete Worker gate.

## Open follow-ups

- Nothing prunes superseded v1.2 day manifests or generations. They no longer
  fail an install, but they grow with every changed day. Retention is an owner
  decision: accepted evidence stays until a reviewed, receipt-backed workflow
  names exact targets.
- The additions are verified against synthetic live inventories only. Whether
  Wrangler accepts a production deploy that adds Rate Limit bindings is proven
  only by the first authorized deploy, whose post-deploy check requires them.
- When v1.2 negotiation fails for any reason, including a 429, the desktop runs
  that pass as v1.1. A device with any v1.1 domain is excluded from the v1.2
  eligibility branch. This client behavior is unchanged and unmeasured.
- Enrollment and ownership, which the client calls on each pass, remain on
  their 20-per-minute per-location attempt keys. Revisit them with fleet size.
- v1.1 passes use the same device-sync routes, so the new admission may also
  help the v1.1 activations that have mostly failed since about 2026-09-16.
  That cause is not verified.
