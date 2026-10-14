---
title: "Protected telemetry runtime activation"
date: 2026-09-22
type: runbook
status: maintained
---

This runbook is the owner-operated sequence for enabling the staged telemetry
successor after the Worker and typed storage release have qualified. It covers
the hosted runtime state only. It does not change local cache calculations,
rewrite existing usage evidence, or apply a migration.

The usage successor (`usage_v12`) and the model-performance stream
(`performance`) are independent runtimes. Activating usage leaves performance
staged; performance may remain staged until its histogram collection has a
separate rollout decision.

The sections up to [Failure and recovery boundary](#failure-and-recovery-boundary)
describe the Cloudflare Worker and its D1 roles. The Google Cloud origin
activates only the performance runtime, with a different request body and no
reconciliation receipt; follow
[Google Cloud origin performance activation](#google-cloud-origin-performance-activation)
there.

## Preconditions

The target primary and analytics D1 roles must have the common forward
migration prefix and a durable, read-only post-migration/post-deploy
reconciliation receipt. The receipt contains the exact schema and
`d1_storage_migrations` ledger SHA-256 for both roles, the deployed source
commit, the owner-captured Worker version/config metadata, and its canonical
proof digest. The Worker live-checks `DEPLOYMENT_SOURCE_COMMIT` against the
receipt and re-reads both D1 roles before activation. The version and config
metadata are bound into the owner-authenticated receipt; this deployment does
not expose runtime bindings for them. The receipt fields are evidence pins;
the maintained operator transaction independently captures and compares the
live version/config immediately around the admin POST under the shared
production lock. The shared provider-schema predicate is used when calculating
the schema digest, so exact provider-owned metadata is excluded while a shadow
object remains visible as drift.

Usage activation requires the common primary forward rows through
`0008_telemetry_v12.sql`, the exact `0014_v12_quarantine_admission.sql` ledger
row and trigger, and the final typed v1/v1.1 and successor usage objects. In
the ordered D1 migration stream `0014` follows `0009_performance_reports.sql`,
`0010_accountless_v12_renewal.sql`, `0011_v12_public_eligibility.sql`,
`0012_v12_empty_day_manifests.sql` and `0013_performance_ultrafast.sql`, so
applying `0014` also requires applying those five first. Usage activation
does not inspect the independent performance tables or histogram bucket
contract, and the performance runtime may remain staged. Performance
activation additionally requires the `0009` ledger row, every pinned
performance object, and the exact report bucket and measurement checks. Both
targets require typed storage, the same valid source namespace for v1 and v1.1,
and enabled upload registration and processing controls. The historical
existing-role operator described in the production runbook is source-pinned
through `0009`; it applies none of `0010`–`0015`. `0010`, `0011` and `0012`
have their own owner-authorized forward steps (see the
[v1.2 public eligibility plan](../plans/2026-09-25-v12-public-eligibility.md)).
`0014` needs its own reviewed, rehearsed forward application and receipt;
complete that step separately before attempting activation.
The quarantine file was renamed byte-identically from the GCP line's earlier
name after the owner-authorized 2026-10-12 production ledger readback proved it
unapplied. Applied filenames and checksum requirements remain unchanged.
Performance activation also requires the exact `0013_performance_ultrafast.sql`
ledger pin (`88ac498493c869009e322e029ccff805236afd8d08ef299c39a3befda72d4aad`)
and `telemetry_performance_cohort_dictionary_insert` and
`telemetry_performance_cohort_dictionary_update`. Missing evidence refuses
performance activation while independent usage activation stays available.

Migration `0013` preserves the runtime state and advances its existing
`policy_revision` by one. A fresh staged fixture advances from 1 to 2 before
activation, then activation advances 2 to 3; these are synthetic fixture values,
not revisions to assume for an existing environment. Already-active rows remain
active. Historical September 21 reports and grants remain retained, while new September 29
dictionary writes require matching new authorization. The historical forward
operator retains its closed pins through `0009`; applying `0013` therefore needs
a reviewed environment-specific migration plan and rehearsal before using this
activation sequence. Do not broaden those operator pins as an implicit upgrade.

The runtime row must still be `staged`. Record its current `policy_revision`
from a read-only post-deploy check and use that value as `expectedRevision`.
Do not guess a revision or start a new operation/key against an already-active
row. An exact retry of the same idempotency key and complete request is the
lost-response recovery path. A stale revision, tuple mismatch, missing schema
object, disabled control, or JSON storage mode is a refusal and does not
produce an activation success.

## Activation sequence

1. Apply the forward migration set using the protected migration procedure and
   retain its ledger and reconciliation receipt. Migration application is a
   separate operation from activation.
2. Reconcile the target D1 role read-only. Confirm the typed v1 and v1.1
   admission state, source namespace, collection controls, the staged target
   runtime row, its exact revision, and the target-specific schema/migration
   state. For usage, performance tables may be absent; for performance, the
   full performance migration, tables, indexes, triggers, and bucket contract
   must be present.
3. Deploy the Worker build containing the activation path. A deploy does not
   apply D1 migrations and does not activate a runtime.
4. Repeat the post-deploy read-only checks. Confirm that the runtime target is
   still staged and that `uploadRegistration` and `processing` are enabled.
5. Create the post-deploy receipt from the owner-private directory. The
   command performs only fixed read-only Cloudflare inventory and D1 `SELECT`
   calls, re-reads the Worker and both D1 roles before writing, refuses any
   source/config/schema/ledger drift, and writes a new 0600 file without
   overwriting an existing receipt:

   ```sh
   node apps/worker/scripts/telemetry-runtime-reconciliation.mjs \
     --account-id <account-id> \
     --worker-name <production-worker-name> \
     --output <owner-private-directory>/telemetry-runtime-reconciliation.json
   ```

   Keep that file owner-private and use its complete JSON object as the
   `reconciliation` value below. The source commit is live-checked from the
   deployed `DEPLOYMENT_SOURCE_COMMIT` binding; the version ID and config
   fingerprint are captured from the same Worker inventory. The generator
   refuses an existing output path, so preserve the original receipt for
   recovery evidence and choose a new path for a recapture.
6. Create two owner-private, mode `0600` JSON files: the request file contains
   the exact body below (with the receipt copied byte-for-byte), and the admin
   session file contains the owner session used by the maintained operator
   entrypoint. The session file shape is:

   ```json
   {
    "schema": "telemetry-runtime-admin-session-v1",
    "origin": "https://admin.tibotattle.com",
    "cookie": "CF_Authorization=<owner Access cookie>",
    "csrfToken": null,
    "accessJwt": "<same owner Access JWT as CF_Authorization>"
  }
  ```

   Keep the Access cookie and JWT only in that private file. The maintained
   entrypoint posts exactly `POST /api/v1/admin/action` with the exact origin
   and `x-usage-monitor-admin: 1`; it sends the optional CSRF header only when
   a session token is supplied. It accepts either the verified Access JWT
   header or the `CF_Authorization` cookie and never prints session values. It
   refuses any origin other than the reviewed admin origin. Generate a fresh
   bounded UUIDv4 idempotency key for the attempt and include the exact
   reconciliation receipt from the post-deploy check:

   ```json
   {
    "action": "run_maintenance",
    "telemetryRuntimeActivation": {
      "target": "usage_v12",
      "expectedRevision": 1,
      "confirmation": "activate_telemetry_v12_runtime",
      "idempotencyKey": "<uuid-v4>",
      "reconciliation": {
        "schema": "typed-forward-post-deploy-reconciliation-v1",
        "capturedAt": "<canonical ISO timestamp>",
        "sourceCommit": "<40 lowercase hex characters>",
        "versionId": "<owner-captured deployed Worker version UUID>",
        "configSha256": "<owner-captured live config SHA-256>",
        "deploymentAttestation": {
          "schema": "typed-forward-live-deployment-attestation-v1",
          "capturedAt": "<canonical ISO timestamp>",
          "sourceCommit": "<same deployed source commit>",
          "versionId": "<same owner-captured deployed Worker version UUID>",
          "configSha256": "<same owner-captured live config SHA-256>",
          "attestationSha256": "<SHA-256 of the canonical unsigned attestation>"
        },
        "primary": {
          "schemaSha256": "<64 lowercase hex characters>",
          "ledgerSha256": "<64 lowercase hex characters>"
        },
        "analytics": {
          "schemaSha256": "<64 lowercase hex characters>",
          "ledgerSha256": "<64 lowercase hex characters>"
        },
        "proofSha256": "<SHA-256 of the canonical unsigned proof>"
      }
    }
  }
   ```

   Replace `1` with the reconciled revision and obtain the proof fields from
   the operator receipt; do not hand-edit its digests. Run the maintained
   operator transaction from the repository root:

   ```sh
   node apps/worker/scripts/telemetry-runtime-reconciliation.mjs \
     --mode activate \
     --account-id <account-id> \
     --worker-name <production-worker-name> \
     --repository-root "$PWD" \
     --operation-directory <owner-private-directory>/telemetry-runtime-activation \
     --request-file <owner-private-directory>/telemetry-runtime-activation-request.json \
     --admin-session-file <owner-private-directory>/telemetry-runtime-admin-session.json
   ```

   The entrypoint acquires the shared production lock, captures the live
   Worker version/config immediately before the POST, compares those facts to
   the nested deployment attestation, and captures them again before releasing
   the lock. A stale version/config receipt is refused before the POST. The
   endpoint performs one D1 batch containing the runtime compare-and-swap, the
   collection-control revision guard, and the terminal success audit update.
   The batch either commits all of those changes or commits none. It writes
   only the closed, content-free activation request envelope and singleton
   runtime row; no participant or event payload is included.

   When the owner has an authenticated admin tab in Chrome but cannot provide
   a private session file, use the journaled browser handoff. It performs the
   same live source/version/config and request/proof checks, acquires the
   shared production lock, and durably records the exact action before it
   returns. It never reads or writes cookies, Access JWTs, or browser state and
   it never sends the request itself:

   ```sh
   node apps/worker/scripts/telemetry-runtime-reconciliation.mjs \
     --mode browser-arm \
     --account-id <account-id> \
     --worker-name <production-worker-name> \
     --repository-root "$PWD" \
     --operation-directory <owner-private-directory>/telemetry-runtime-activation \
     --request-file <owner-private-directory>/telemetry-runtime-activation-request.json
   ```

   The bounded result is `status: "action_required"` with the fixed
   same-origin route, target, revision, idempotency key, request digest, proof
   digest, and deployment-attestation digest. It does not print the request
   body or any authentication material. Keep the operation directory and the
   shared lock in place while the browser action is pending.

   From the already authenticated `https://admin.tibotattle.com` page, use
   that page's own same-origin context to select the exact request file and
   post its unchanged UTF-8 bytes. This browser-side helper verifies the file
   digest printed by `browser-arm` before sending; it does not inspect or copy
   cookies or JWTs:

   ```js
   const expectedRequestSha256 = "<requestSha256 from action-required output>";
   const picker = Object.assign(document.createElement("input"), {
     type: "file",
     accept: "application/json",
   });
   picker.onchange = async () => {
     const file = picker.files?.[0];
     if (!file) throw new Error("request file required");
     const bytes = new Uint8Array(await file.arrayBuffer());
     const digestBytes = new Uint8Array(
       await crypto.subtle.digest("SHA-256", bytes),
     );
     const digest = [...digestBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
     if (digest !== expectedRequestSha256) throw new Error("request digest mismatch");
     const response = await fetch("/api/v1/admin/action", {
       method: "POST",
       credentials: "same-origin",
       headers: {
         "content-type": "application/json",
         "x-usage-monitor-admin": "1",
       },
       body: new TextDecoder().decode(bytes),
     });
     const body = await response.json();
     if (!response.ok) throw new Error(`admin action refused (${response.status})`);
     console.log(body);
   };
   picker.click();
   ```

   The browser POST is the only external action in this handoff. After it
   completes, run the read-only reconciliation command below. Do not use the
   ordinary `activate` command for a browser-armed operation, and do not
   release the shared lock manually.
7. Verify the response and runtime row read-only. Confirm `state = active` and
   the revision increased by exactly one. When the performance stream is
   installed, its independent row must remain staged during usage activation;
   it may be absent while performance is still unprepared. Keep the response
   and audit operation identifier with the release evidence.

Performance activation is optional and follows the same proof and operator
sequence only after its separate collection decision. Its exact request is:

```json
{
  "action": "run_maintenance",
  "telemetryRuntimeActivation": {
    "target": "performance",
    "expectedRevision": 1,
    "confirmation": "activate_telemetry_performance_runtime",
    "idempotencyKey": "<uuid-v4>",
    "reconciliation": "<same receipt shape, with exact live role digests>"
  }
}
```

Use the reconciled performance revision. This operation cannot activate the
usage runtime and can be omitted while performance remains staged.

## Failure and recovery boundary

The activation CAS has an exact state, revision, schema, method, privacy, and
limit tuple in its `WHERE` clause. The collection-control revision is bound in
the same batch. A returned zero-row CAS is a deterministic admin conflict and
cannot claim a competing activation. A successful batch has both an active
runtime at the next revision and a `success` audit row with the same durable
operation id.

If the response is lost after the batch commits, retry the identical request,
including the same idempotency key and reconciliation proof. The Worker reads
that exact unique audit row and returns the prior success without another
mutation. Reusing a key with any different target, revision, or proof is a
conflict. If a process failed after writing the `started` intent but before
the batch, an identical retry reuses that intent while the runtime is still
staged. A `started` audit alongside an active runtime is ambiguous and returns
the reconcile-required error; inspect the exact operation id, runtime row, and
audit row before taking any further action. Never promote that audit by reading
the runtime alone.

The maintained operator command journals its lock and POST boundary in the
owner-private operation directory. If it exits after `lock_intent`, rerun the
same command with `--resume`; it adopts that exact owner when the shared lock
is already held or acquires it when the lock is still absent. A fresh operation
captures live deployment identity before POST, so a version/config drift
refuses before the POST; create a new reconciliation proof and operation key
after the deployment is stable.

If it exits with `admin_intent`, `--resume` asserts the existing owner and
first retries the exact same request. A completed Worker replay returns the
durable success before mutable proof checks, journals `release_intent`, and
releases the lock even when the deployment has since drifted. If the replay is
refused or its response is lost, use the separate reviewed reconciliation
mode. Reconciliation mode never posts to the admin route: it reads the fixed
target runtime and exact audit row under the held lock:

```sh
node apps/worker/scripts/telemetry-runtime-reconciliation.mjs \
  --mode reconcile \
  --account-id <account-id> \
  --worker-name <production-worker-name> \
  --repository-root "$PWD" \
  --operation-directory <owner-private-directory>/telemetry-runtime-activation \
  --request-file <owner-private-directory>/telemetry-runtime-activation-request.json
```

That mode is read-only for both private-session and browser handoffs. It
releases only after a durable success with the expected active
revision or a durable failure with the original staged revision. A still
started audit, an active revision without matching success, a missing audit,
or any read uncertainty remains fail-closed and retains the lock for review.
For a browser handoff, source/version/config drift between arming and
reconciliation is also ambiguous and retains the lock. A browser-arm journal
can be resumed with `--mode browser-arm --resume` to re-emit the same bounded
action-required details after a process interruption; it will not post or
change the request.
If it exits with `release_intent`, `--resume` releases or reconciles that exact
owner and returns the stored result without posting again.

If post-deploy verification fails, leave the target staged and resolve the
migration, schema, configuration, or collection-control issue before retrying
with the newly reconciled revision. An active runtime is forward-only; use the
existing collection-control containment procedure for an incident rather than
attempting an undocumented state reversal. Cache calculations remain on their
existing implementation until a separately approved back-catalog change.
Performance remains independently staged by default.

## Google Cloud origin performance activation

The owner decided on 2026-10-10 to restore accountless performance intake on
the Google Cloud origin and to activate it as a separate owner step
([community model speed decision](../decisions/2026-10-10-community-model-speed.md#owner-only-activation)).
This section is the owner sequence for that step. It is source-verified only:
the task, its body and its refusals are proven with local PostgreSQL 17 tests
and a composed production host, and the step has never run against a live
project. Activation is a protected production write. It needs explicit owner
authorization for this environment and this image, and an agent never performs
it.

On this origin only the `performance` target exists. A `usage_v12` body is
refused with `400 BODY_INVALID`; that runtime arrived active by transfer and is
never activated here. There is no activation control in the admin UI.

### Preconditions

All of these must hold, and each is checked read-only before the POST:

1. **The v1.2 activation-timeout fix is live and verified** in production
   (decision 10), and so is any kernel the live registry orders before the
   performance kernel.
2. **The edge is in `gcp` mode.** `admin.tibotattle.com` reaches this origin
   only while the live edge forwards its admin routes here. In `worker` mode
   the D1 Worker answers the admin view and the admin action itself, and in
   `fenced` mode they answer `503 MUTATION_BARRIER_ACTIVE`; this section does
   not apply in either.
3. **Migration 0079 is applied and the image rolled**, through
   [Migration 0079](./gcp-rollout.md#migration-0079-community-model-speed) in
   the rollout runbook. Keep the migrate receipt: its
   `migrations.historySha256` is the `deployment.historySha256` below.
4. **The edge deploy is live** (rollout step 6; its code deploy carries the
   admin view). The admin view that preconditions 7 and 8 read exists at the
   edge only from that deploy:
   before it, the live edge answers `GET /api/v1/admin/performance-intake`
   itself with `404 NOT_FOUND` and never forwards it. No other read-only source
   for the staged revision is built, so activation waits for this deploy. The
   admin action route itself is already forwarded.
5. **The storage receipt is current.** The live migration history equals the
   image's manifest exactly, so `/api/ready` reads `ready` and the
   storage-gated routes answer. The task re-reads the receipt itself and
   refuses `503 TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE` if it is not
   current.
6. **Collection controls are enabled.** `uploadRegistration` and `processing`
   must both be enabled. A disabled control refuses with its own `503`
   (`UPLOAD_REGISTRATION_DISABLED` or `PROCESSING_DISABLED`).
7. **The runtime is staged.** Read `GET /api/v1/admin/performance-intake` on
   the admin host. It must show runtime `staged` and the policy revision to use
   as `expectedRevision` (1 on a fresh migration). Do not guess the revision.
8. **The deployment matches.** The view's `deployment.sourceCommit` must equal
   the rolled commit, and its `deployment.historySha256` must equal the migrate
   receipt's `migrations.historySha256`. The view's digest is computed from the
   image's own migration manifest, not read from the live database, so check
   it against the receipt rather than relying on the view alone. A null
   `sourceCommit` means `DEPLOYMENT_SOURCE_COMMIT` is not set, and every
   activation then refuses `503 TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE`.

### The request

Generate a fresh lowercase UUIDv4 idempotency key for the attempt. The body is
exactly:

```json
{
  "action": "run_maintenance",
  "telemetryRuntimeActivation": {
    "target": "performance",
    "expectedRevision": 1,
    "confirmation": "activate_telemetry_performance_runtime",
    "idempotencyKey": "<lowercase uuid-v4>",
    "deployment": {
      "historySha256": "<migrations.historySha256 from the migrate receipt>",
      "sourceCommit": "<the rolled 40-hex commit>"
    }
  }
}
```

Replace `1` with the staged revision from precondition 7. Every key is
required, and any other key, value or shape is `400 BODY_INVALID`.

`scripts/telemetry-runtime-reconciliation.mjs` is Worker and D1 only. It builds
the D1 body with a `reconciliation` receipt and reads D1, Cloudflare inventory
and the Worker version. The origin refuses that body with `400 BODY_INVALID`.
Do not use it here; no origin operator entrypoint is built.

Post the body as `POST /api/v1/admin/action` on the admin host
(`https://admin.tibotattle.com`), behind Cloudflare Access as the pinned owner.
The admin CSRF check requires the request's `Origin` to be the admin origin,
`Sec-Fetch-Site` absent or same-origin, and `x-usage-monitor-admin: 1`. The
browser helper in step 6 of the Worker sequence meets these from an
authenticated admin page. Compute the request file's SHA-256 locally and use
it as `expectedRequestSha256`; the helper then posts the file's unchanged
bytes.

A success answers 200 with `schemaVersion: "admin-action-v0.1"` and a result
of `task: "telemetry_runtime_activation"`, `operationId` (the idempotency
key), `target: "performance"`, `state: "active"`, `fromRevision`,
`toRevision`, `revision`, `replayed` and `reconciled`. Keep the response, the
idempotency key and the UTC time with the rollout evidence.

### Refusals

| Answer | Meaning | Action |
|---|---|---|
| `400 BODY_INVALID` | The body is not the exact shape above, names `usage_v12`, or is the D1 body | Fix the body |
| `403 ADMIN_REQUIRED`, `403 CSRF_INVALID` | Not the Access owner, or the CSRF headers are missing | Post from the owner's authenticated admin page |
| `409 ADMIN_ACTION_CONFLICT` | The runtime is not staged at `expectedRevision`; the deployment block does not name this image; or the key was already used for another intent, a failure or another action | Re-read the admin view. Use a new key for a new intent. Never reuse a key with a changed body |
| `503 TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE` | The migration receipt is not current, the dictionary registry differs from the image's, the commit is unset, or the commit outcome is unknown | Resolve the cause. After an unknown outcome, resend the identical request: a committed activation replays |
| `503 UPLOAD_REGISTRATION_DISABLED`, `503 PROCESSING_DISABLED` | A collection control is disabled | Enable it through the reviewed control path, then retry |
| `503 TELEMETRY_RUNTIME_ACTIVATION_RECONCILE_REQUIRED` | A `started` audit row exists for this intent while the runtime is still staged | See below. This key will never succeed: use a new idempotency key |

Every refusal before the audit row rolls the transaction back and leaves no
audit row.

### Replay and reconcile

- **Lost response.** Resend the identical request with the same key. A
  recorded success returns the original result with `replayed: true` and
  changes nothing. Replay identity is the key, target and expected revision;
  the deployment block is a precondition for doing an activation, not part of
  the intent, so a replay after a redeploy still returns the recorded result.
- **Concurrent requests.** Two requests with the same key serialize on the
  runtime row; the loser answers as a replay.
- **Interrupted earlier writer.** This task never commits a `started` row,
  because the audit row and the runtime change commit together. A `started`
  row can only come from an interrupted earlier writer. If the runtime is
  already active at `expectedRevision + 1`, a retry finishes that row with
  success and answers `reconciled: true`; reconcile re-checks the receipt and
  this image's deployment, so send the current image's commit and digest. That
  path can record a second success row for an activation another operation
  performed. If the runtime is still staged, the answer is
  `503 TELEMETRY_RUNTIME_ACTIVATION_RECONCILE_REQUIRED` for every retry of that
  key, and nothing changes. Generate a new idempotency key and send a new
  request.
- An active runtime is forward-only. There is no deactivation and no pause
  state.

### Verify

1. Read `GET /api/v1/admin/performance-intake`: runtime `active` at policy
   revision 2 (the expected revision plus one). The admin audit list shows one
   `run_maintenance` row for this key finished as success.
2. Wait for the first accepted report. Intake ramps up only as clients
   restart or renew their sharing preference and re-grant; while the runtime
   was staged, clients paused on their 403 answers. The admin view's
   `reports.latestAcceptedAt` and the runtime probe's
   `performance_newest_accepted_report_age_seconds` move off `NO_DATA` with the
   first accepted report.
3. The first publication follows at the next analytics refresh (daily, at
   03:00 UTC in the committed desired state), once a report with an included
   record exists. Until then the public read answers
   `404 COMMUNITY_MODEL_PERFORMANCE_UNPUBLISHED`.

### Brake

There is no performance-only brake. To stop intake, use the collection
controls through the admin action `set_collection_controls`: disabling
`uploadRegistration` refuses new grants, and disabling `processing` refuses
report uploads. Both controls also stop usage collection. While the
`publication` control is disabled, the public read answers
`503 PUBLICATION_DISABLED`. See
[GCP brake and incidents](./gcp-brake-and-incidents.md) for the edge brake.

### Operating notes

- **Staged window.** Between the roll and activation, every authenticated
  grant, capability poll and report upload answers
  `403 TELEMETRY_TRANSPORT_BLOCKED`, and each one upserts a refusal counter
  row. Local measurement at concurrency 24 and 64 with the production pool
  sizes counted every refusal, with refused polls at about twice read latency
  (p50 35–99 ms). A refusal waits up to its 1-second bound only when the
  counter table is locked or unavailable. The admin attention item for
  refusals in the last 24 hours fires throughout this window; that is
  expected.
- **Report-day window.** Once active, a new report or replacement whose day
  falls outside the server's UTC window, from 10 days before today through
  tomorrow, is refused `409 TELEMETRY_RECORD_INVALID` and appears in the
  refusal counters; a few from devices with skewed clocks are expected
  ([decision](../decisions/2026-10-10-community-model-speed.md#google-cloud-origin-implementation)).
- **Admin view cost.** The view reads grant and capability heads, report
  totals and a 400-day cohort window under one 10-second read-only snapshot,
  mostly as full scans of narrow tables. It has not been load-tested at
  production scale; if it starts answering
  `503 ADMIN_PERFORMANCE_INTAKE_UNAVAILABLE` as the corpus grows, suspect its
  statement timeout first.
- **Output budget.** If the twelve performance payloads ever overflowed the
  refresh run's output budget, the whole run would fail with
  `ANALYTICS_V2_OUTPUTS_CAPACITY_EXCEEDED`, blocking the daily publication too.
  Payload sizes make this unlikely; the head-age probes show it.
