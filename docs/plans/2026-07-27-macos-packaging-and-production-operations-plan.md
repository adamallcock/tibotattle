---
title: macOS Packaging and Production Operations Plan
date: 2026-07-27
type: plan
status: implemented
---

# macOS Packaging and Production Operations Plan

## Outcome

Turn the current developer-only loopback dashboard and local backend laboratory
into two honest, independently verifiable product lanes:

1. a locally ad-hoc-signed, owner-local `Usage Monitor.app` that a Mac user can
   launch without a terminal, that reads only privacy-safe metadata from the
   user's local Codex state, and that guides the user through source access,
   refresh, review, and optional contribution; and
2. a production-shaped hosted service with durable ingestion, interruption
   recovery, readiness checks, private object storage, least-privilege
   deployment configuration, and an explicit path to both the existing
   Cloudflare implementation and a Google Cloud Run plus Cloud Storage
   implementation.

This milestone does not authorize a public pilot, external collection, paid
resource creation, Apple notarization, or a production deployment. It produces
locally exercised software and deployment-ready infrastructure whose remaining
external gates are visible.

## Verified starting point

As of July 27, 2026:

- the real local companion runs as a loopback Node process and displays real
  privacy-safe Codex evidence;
- the consumer still has to start that process from a terminal and open the
  browser manually;
- the hardened unsigned local-review tar is a separate CLI artifact and
  deliberately excludes the dashboard server and transport;
- no `.app`, `.dmg`, `.pkg`, LaunchAgent, login item, daemon, updater, or native
  onboarding experience exists;
- the companion currently couples read-only application resources and writable
  `.usage-monitor` state through one process working directory;
- the existing backend is a tested Cloudflare Worker using D1, an independent
  deletion ledger, private R2 quarantine storage, rate limiters, static assets,
  and scheduled lifecycle work;
- the configured Cloudflare staging and development Worker names do not exist
  in the authenticated account, and the live staging readiness check remains
  blocked by placeholder resource identifiers and unavailable R2;
- no Cloud Run, Cloud Storage, container, Google Cloud IAM, or infrastructure
  implementation exists; and
- a termination between an R2 object write and its D1 commit can leave an
  unreferenced encrypted object that the current D1-driven lifecycle cannot
  discover.

These facts replace any earlier implication that a consumer app or real hosted
environment already existed.

## Workstreams

### A. Native macOS launch and onboarding

Build a locally ad-hoc-signed native AppKit application with no new third-party
runtime:

- a calm first-run/status window;
- an embedded, pinned Node runtime and closed companion source tree;
- an ephemeral loopback port selected at launch;
- a fixed `~/Library/Application Support/Usage Monitor` state root;
- a separate immutable resource root inside the app bundle;
- a path-free source-readiness check for Codex sessions, archived sessions,
  writable state, and explicit refresh availability;
- an explicit `Open Dashboard` action after the companion is ready;
- graceful child shutdown on app quit and no orphan listener after forced
  termination and relaunch;
- no login item, daemon, background upload, or automatic refresh; and
- no bundled logs, reports containing local evidence, credentials, state
  database, account identifiers, or generated private artifacts.

The app remains without Developer ID signing and is unnotarized. Ad-hoc signing
must seal and strictly verify the complete local bundle; it is not a
distribution identity. A reproducible developer build and local execution
receipt are prerequisites for later Developer ID, hardened runtime,
notarization, DMG, and clean-Mac review.

### B. Installed-state boundary

Decouple the companion's roots:

| Boundary | Purpose |
|---|---|
| Resource root | Immutable JavaScript, browser assets, schemas, and fixed app metadata bundled in the `.app` |
| State root | Owner-only collector ledger, checkpoint, lock, journal, replay-safe cache, prepared spool, and sync queue |
| Codex home | Fixed user-local source discovery; raw source content never crosses the loopback projection |

Both roots must be absolute and resolved without symlink traversal. The state
root must be an owner-only directory and every mutable default must be derived
from it. Browser responses must expose status booleans and bounded counts, not
paths, filenames, account values, prompts, responses, commands, URLs, or
repository names.

### C. Local recovery

- retain the last verified dashboard snapshot when refresh fails or is aborted;
- abort indexing and accounting work on shutdown or timeout;
- recover collector journals and expired sync leases at restart;
- exercise a process-death test where a claimed local contribution becomes
  retryable and later converges without duplicate canonical ingestion;
- keep remote ambiguous outcomes idempotent by stable plaintext digest and
  server-side canonical uniqueness; and
- expose fixed operator diagnostics for stale cache, unavailable Codex source,
  paused sync, retry wait, and corrupted local state.

### D. Existing Worker hardening

Close the cross-store crash boundary before any hosted collection:

1. establish durable, content-free intent before or alongside each quarantine
   object write;
2. make object keys deterministic and opaque;
3. finalize analytical state transactionally;
4. reconcile bounded batches of stale pending or unreferenced objects;
5. preserve referenced and grace-period objects;
6. make reconciliation resumable and idempotent across termination;
7. keep liveness separate from readiness;
8. report not-ready while restore replay, aggregate rebuilding, retention, or
   quarantine reconciliation is incomplete, failed, or stale; and
9. emit fixed-field structured lifecycle logs without participant, object,
   account, or content values.

The disabled Cloudflare staging route remains the first contained hosted smoke
because its D1/R2 implementation and deployment gates already exist. Creating
resources or deploying still requires the account owner's explicit approval
and any resulting billing acceptance.

### E. Google Cloud provider lane

Do not port the Worker wholesale or claim Google Cloud support from a storage
adapter alone. Establish a small provider-neutral ingestion boundary, then add:

- a Cloud Run HTTP container that listens on the supplied `PORT`;
- `/healthz` for process liveness and `/readyz` for dependency and lifecycle
  readiness;
- graceful `SIGTERM` handling and bounded request draining;
- a private Cloud Storage adapter with opaque object keys, conditional writes,
  metadata checks, idempotent deletion, and no public ACL;
- short-lived signed upload URLs only if a later performance test proves direct
  upload is necessary; the first implementation may stream bounded encrypted
  envelopes through the service;
- a deliberate metadata-store choice before accepting contributions;
- service accounts split between runtime, deployment, and lifecycle jobs;
- Secret Manager or workload identity for secrets, never checked-in keys;
- lifecycle, soft-delete, retention, and orphan-reconciliation policies with
  an explicit deletion contract;
- declarative service/storage/IAM configuration and a non-mutating validation
  command; and
- a contained synthetic smoke before any external participant is admitted.

The first Cloud Run slice is limited to container/runtime contract, health and
readiness, private Cloud Storage connectivity, and a synthetic encrypted-object
round trip. Enrollment and real telemetry stay disabled until the chosen
database preserves the existing participant isolation, dedupe, deletion,
restore, aggregation, and audit invariants.

## Operational requirements

### Health, readiness, and recovery

- liveness means only that the process can serve;
- readiness means required storage and database dependencies are reachable and
  all mandatory lifecycle/recovery work is sufficiently fresh;
- a restart must not make partial ingestion visible;
- every retryable mutation must have a stable idempotency key;
- reconciliation work is bounded by count, bytes, and wall time;
- state cursors advance only after the corresponding side effect is durable;
- operators can rerun reconciliation safely;
- backups and deletion tombstones are restored and replayed as a pair; and
- failure responses and logs use fixed codes without private values.

### Observability

Record only:

- request identifier;
- route class and response status;
- bounded duration;
- deployment revision;
- fixed lifecycle stage and outcome;
- counts clipped to documented maxima; and
- readiness blocker codes.

Do not record request bodies, encryption envelopes, capabilities, cookies,
CSRF values, object keys, participant identifiers, account identifiers, source
paths, or local filenames.

### Release and incident gates

Before external collection:

- signed and notarized macOS successor;
- clean-user and clean-Mac onboarding test;
- independent privacy and security review;
- contained hosted smoke with collection controls still disabled;
- restoration rehearsal including the independent deletion ledger;
- orphan-object and ambiguous-response fault injection;
- key rotation and emergency containment rehearsal;
- budgets, alerts, paging owner, backup owner, and deletion-request owner;
- load test representing at least 1,000 intermittent clients;
- approved consent copy and telemetry contract; and
- explicit account-owner authorization to enable collection.

## Acceptance matrix for this iteration

| Area | Evidence required |
|---|---|
| macOS bundle | `.app` builds, launches from Finder or `open`, shows native status, starts one loopback companion, opens the real dashboard, and quits without an orphan listener |
| Local source | Temporary Codex fixtures produce path-free readiness and real content-free usage projections; unreadable/missing state fails safely |
| State isolation | All new files are confined to an explicit owner-only state root; app resources remain unchanged |
| Local recovery | Interrupted refresh and process restart retain/recover valid prior state; contribution retry remains idempotent |
| Worker recovery | Cross-store orphan case is reproduced, reconciled, and covered by restart/failure tests |
| Readiness | Liveness stays available while readiness returns a fixed 503 blocker during incomplete or stale recovery |
| Cloud Run lane | Container builds locally, honors `PORT`, handles `SIGTERM`, and passes liveness/readiness smoke without accepting real telemetry |
| Cloud Storage lane | Emulator or fake-backed contract proves bounded put/metadata/delete and idempotent retry; real resource creation remains disabled |
| Regression | Focused suites, product checks, Worker type/deploy dry run, native app smoke, and browser onboarding QA pass |

## Implementation order

1. Separate resource and state roots and add source-readiness projection.
2. Build and run the ad-hoc-signed native app against a temporary Codex
   fixture.
3. Integrate the onboarding state into the existing dashboard.
4. Add Worker quarantine intent/reconciliation and readiness.
5. Add a provider-neutral object-store contract and Cloud Storage adapter.
6. Add the contained Cloud Run runtime and declarative configuration.
7. Run process-death, restart, browser, narrow-window, and backend acceptance
   tests.
8. Record exact receipts and remaining external gates without claiming a
   deployment.

## Non-goals

- No public production deployment in this iteration.
- No creation of paid Google Cloud or Cloudflare resources without approval.
- No real participant data in hosted tests.
- No automatic upload or background collection.
- No LaunchAgent, login item, privileged helper, extension, or updater.
- No Apple Developer ID signing, notarization, or DMG claim.
- No replacement of the existing Worker/D1 backend before provider parity is
  measured.

## Implementation receipt

Completed on July 27, 2026:

- built a locally ad-hoc-signed native AppKit bundle at
  `.release-build/macos/Usage Monitor.app` with a pinned Node runtime, an
  ephemeral loopback companion, separate immutable resource and owner-only
  state roots, explicit dashboard launch, and parent-death cleanup;
- exercised the real app against the user's local Codex state without uploading
  data: the first bounded scan selected 531 rollouts, processed 9 rollouts, and
  projected 6,041 content-free records before correctly pausing for a later
  continuation;
- changed onboarding to distinguish "ready to scan" from offline, explain
  bounded indexing, and offer a clear continuation action for large histories;
- retained ordinary terminal use while adding a strict, opt-in native-parent
  watchdog that fails before listening when its parent contract is invalid;
- added fail-closed hosted readiness to the local dashboard and kept liveness,
  object reconciliation, and aggregate-rebuild state visibly separate;
- fixed the browser readiness integration discovered during rendered QA:
  browser-native `fetch` is invoked without an invalid receiver, the closed
  readiness contract includes the maintenance-cycle fence, and every lifecycle
  state has an honest operator label;
- added a signed build-time central-service contract: development bundles may
  use only an explicitly opted-in `http://127.0.0.1:<port>` origin, production
  bundles require a fixed non-loopback HTTPS origin, the launcher revalidates
  the sealed `Info.plist` values, and shell-injected origins are ignored;
- extended the exact participant relay across that pinned HTTPS origin for
  enrollment, recovery, sessions, uploads, private statistics, history,
  export, security controls, and deletion while retaining the route/method
  allowlist, same-origin browser boundary, cookie/CSRF/authorization filters,
  response bounds, and no-redirect policy;
- added durable quarantine-write registration and bounded, lease-fenced orphan
  reconciliation to the Cloudflare Worker, including a migration and readiness
  blockers;
- added a contained Cloud Run lane with a non-root container, liveness,
  readiness, graceful draining, a generation-safe Cloud Storage adapter,
  immutable-digest service rendering, direct-policy IAM validation, and all
  contribution routes held closed; and
- ran the complete product gate successfully: 39 browser/data-client tests, 77
  local-product tests, 37 Worker script checks, 82 Worker tests, Worker
  type/generated-type checks and dry deployments, plus 12 Cloud Run tests and
  configuration validation. The separate macOS bundle suite passed 4 tests,
  and a real forced-parent-death smoke confirmed that no bundled companion was
  orphaned.

A fresh disposable current-source backend lab then completed its full
synthetic acceptance and restart lifecycle. Backend health, direct readiness,
loopback readiness relay, and the dashboard all returned 200. A clean browser
render showed `Backend ready`, current retention and restore replay, reconciled
objects, and a complete aggregate rebuild. The disposable synthetic state was
stopped and moved to Trash after QA; the user's older separately started local
lab was not altered.

A second fresh lifecycle on a separate port proved the signed connection
boundary itself: the real local Worker/D1/R2 laboratory completed enrollment,
ingestion, canonical repricing, private and aggregate statistics, participant
export, both deletion scopes, and restart recovery; then a separately signed
native bundle reached `/api/ready` through its embedded companion using its
sealed loopback development origin. The focused companion suite passed 19
tests and the macOS suite passed 6 tests, including the production-HTTPS build,
strict code-sign verification, origin-injection refusal, orderly shutdown, and
forced-parent-death cleanup. Temporary state, recovery material, and test apps
were moved to Trash.

The final reproducible immutable-resource payload is 146,515,351 bytes; the
separately verified launcher and complete bundle also contain the build
manifest and sealed-resource signature. Its payload SHA-256 is
`56e8d58316f95e808fe2987656c584538d6b1825a261df342c50e9a3cd07c723`
and its bounded runtime-source SHA-256 is
`8adad50b809ca5c6dad6c9d6447fe8d03158551220dd46d8df90f3ccfb9a2630`.
The locally built contained Cloud Run image passed non-root HTTP and shutdown
smokes.

## Final end-to-end receipt

Rechecked on July 28, 2026 against the current source and the user's real local
Codex evidence:

- the signed native app launched normally, selected an ephemeral loopback port,
  returned `ready` from `/api/local/health`, reported readable Codex sources
  from `/api/local/onboarding`, and quit without leaving its companion or port
  behind;
- the local-only bundle exposed no central-service proxy, participant relay, or
  remote sync actions; its durable contribution queue was empty and no user
  data was uploaded;
- the resumable recent-history index reached `recent_7d_complete`: 2,844
  rollouts were discovered, 628 were selected and processed, and 591,755
  privacy-safe records covered July 21 through July 28;
- the bounded accounting pass retained 201,823 usage inputs and 206,878 weekly
  snapshots with a deterministic estimated footprint of 91,387,264 bytes,
  below the 320 MiB fail-closed ceiling. It produced 77,497 replay-safe 7-day
  usage events while excluding 973,409 inherited child snapshots;
- the weekly estimate is conditionally expressed in current public API-price
  equivalent: a central value of about $1,832, an across-reset 80% range of
  about $1,395–$2,170, and 17 qualifying reset series. It remains explicitly
  account-unattributed and may combine historical activity from multiple
  accounts;
- preparing the latest bounded contribution window through the real app
  produced 38 locally verified batches, about 7,400 safe records, and about
  7.9 MB. Preparation performed no upload, and sending remained disabled until
  explicit review;
- a separate disposable backend completed encrypted ingestion, server-side
  validation and repricing, deduplication, participant and community
  statistics, export, both deletion scopes, restart recovery, quarantine
  reconciliation, and readiness checks across 20 synthetic participants; and
- final regression results were 39/39 browser tests, 77/77 local tests, 37/37
  Worker script checks, 82/82 Worker tests, 12/12 Cloud Run tests, and 6/6
  macOS tests. `git diff --check` and strict deep code-sign verification also
  passed.

Disposable backend state, connected QA bundles, and the prepared QA queue were
stopped and moved recoverably to
`~/.Trash/usage-monitor-e2e-cleanup-20260728T0430Z`. The persistent real local
collector, checkpoint, and accounting cache under
`~/Library/Application Support/Usage Monitor` were retained.

## Remaining external gates

- The macOS bundle is a strictly verified, ad-hoc-signed developer build.
  Developer ID signing, hardened runtime, notarization, a DMG or installer,
  updater policy, and clean-Mac onboarding remain future release work.
- Cloudflare staging remains `safe_unprovisioned`: resource identifiers are
  placeholders, enrollment and account-scoped ingestion are disabled, and no
  Worker was deployed.
- The Google Cloud lane is deliberately contained. The Cloud Run Admin API is
  disabled in the active project, no API was enabled, no bucket or service was
  created, and no manifest was applied. Its IAM checker proves direct service,
  bucket, and project policies only; effective inherited access still requires
  IAM Policy Analyzer before production.
- Google Cloud still needs a metadata database and parity for participant
  isolation, enrollment, deletion, aggregate rebuild, restore replay, and
  operator audit before it can accept telemetry.
- Enabling either hosted lane requires explicit account-owner authorization,
  billing acceptance, resource names, secrets, budgets, alerts, and an
  independently reviewed production runbook.

## Online launch audit

Rechecked on July 27, 2026 without creating or changing any remote resource:

- the private GitHub repository is connected and its default branch is
  `main`;
- Cloudflare Wrangler has one authenticated account, D1 is reachable, no D1
  databases are present, R2 has not been enabled, and there is no staging
  Worker, deployment, or installed staging secret;
- `npm run product:staging:ready` fails closed on exactly
  `STAGING_RESOURCE_IDENTIFIERS_NOT_CONFIGURED` and `R2_NOT_ENABLED`;
- the checked-in staging environment is otherwise safe and passes its Worker
  tests, script tests, type checks, dry deployment, and startup profile;
- Google Cloud has an active credential and selected project, but the Cloud
  Run and Artifact Registry APIs are disabled and no Run service, artifact
  repository, or Storage bucket is visible; and
- one valid Developer ID Application identity is installed on this Mac, while
  the current bundle remains deliberately ad-hoc signed and unnotarized.

The fastest honest hosted milestone is therefore a **collection-disabled
Cloudflare staging deployment**. It requires four owner decisions before any
remote mutation:

1. enable R2 and accept any associated account terms;
2. choose data placement before resource creation (`enam` or an EU
   jurisdiction), because later relocation is not a routine configuration
   change;
3. choose the first URL and access boundary—an account `workers.dev` URL works
   with the current gate, while a custom domain needs a small configuration
   and deployment-wrapper change; and
4. authorize creation of two staging D1 databases, one private R2 bucket, two
   envelope secrets, one Worker with an hourly cron, and the resulting
   account usage.

Once those decisions are recorded, the contained launch sequence is:

1. create the two D1 databases and private R2 bucket in the selected
   placement;
2. replace only the two staging D1 placeholder UUIDs;
3. verify that rate-limit namespace IDs `2001` and `2002` are unused;
4. generate the ignored owner-only staging envelope key file;
5. apply both D1 migration streams and explicitly set collection controls to
   contained;
6. deploy the staging Worker with enrollment, upload registration, processing,
   publication, and account-scoped ingestion all disabled; and
7. verify HTTPS health, scheduled maintenance, readiness, headers, and the
   rendered public shell before considering a pilot.

This milestone would put the site and backend shell online, but it would not
accept a user's telemetry. Invitation-only collection is a distinct release
gate. The current staging validator deliberately rejects any enrollment mode
other than disabled, remote grant issuance and remote collection-control
commands are unavailable, and account-scoped ingestion remains loopback-only.
A pilot therefore still needs a separate environment with authenticated
operator actions and audit records, remote one-use invitation issuance,
reviewed key rotation, stronger global abuse controls, alerts and ownership,
paired two-D1 restore rehearsal, R2 retention/deletion policy, and approved
consent, jurisdiction, and privacy/security decisions.

The Google Cloud lane is not a competing shortcut. It currently proves only a
private non-root runtime and a generation-safe object-store adapter while every
contribution route returns `collection_disabled`. It lacks the metadata,
identity, enrollment, deletion, aggregation, restore, and audit machinery that
already exists in the Worker. Keep it as a portability and disaster-recovery
lane until provider parity is implemented.
