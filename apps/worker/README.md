# Central contribution service

This development-only Cloudflare Worker exercises the full central product
boundary: enrollment, encrypted upload, strict validation, deterministic
server-side API repricing, D1 ingest, participant-isolated statistics and
rolling quota comparison, delayed immutable weekly community snapshots,
independent incident containment, seven-day encrypted-quarantine retention,
deletion-safe restore replay, export, contribution deletion, and participant
deletion. It retains the
original fixed synthetic walkthrough
and also accepts a closed privacy-safe telemetry batch. It never accepts raw log
files, prompts, responses, commands, paths, account identifiers, or arbitrary
keys.

The Worker is deliberately not authorized for a public production deployment.
A named staging environment is now configured as an HTTPS-capable but
collection-disabled target. It remains unprovisioned and undeployed. Real
telemetry support is for local backend and end-to-end product testing until the
separate consent, admission-control, security, and privacy review gates are
complete.

Telemetry admission is bounded to 100 accepted batches in each fixed
Monday-to-Monday UTC seven-day window. The transactional D1 counter stores no
contribution content or digest, and contribution deletion does not refund a
slot. The participant profile reports the current window and remaining
batches. Profile history is a bounded recent view, while personal export
streams the complete retained history and participant deletion pages through
every retained quarantine reference.

## Local run

```sh
npm install
npm run keys:local
npm run migrate:local
npm run dev
```

`keys:local` creates a mode-0600 `.dev.vars` file and refuses to overwrite an
existing one. `migrate:local` creates `.wrangler/state` as an owner-only
directory and refuses to use an existing group/world-readable or linked state
directory. These paths are ignored by Git. Never commit or paste their
contents.

Useful checks:

```sh
npm run check
```

That command verifies generated Worker types, runs TypeScript and the
Cloudflare-runtime integration tests, and performs a deployment dry run. It
does not deploy anything.

## Inspectable local backend laboratory

The regular HTTP smoke proves the complete lifecycle and deletes its cohort at
the end. The inspectable laboratory instead creates fresh disposable state,
seeds twenty privacy-safe participants through the real encrypted HTTP path,
publishes the thresholded weekly snapshot, directly inspects bounded D1
counts, restarts the Worker against the same state, and leaves the portal
running. The normal laboratory command starts both the backend Worker on 8792
and the real local companion on 8791:

```sh
# Run once if apps/worker/.dev.vars does not exist.
npm run keys:local

# From the repository root.
npm run product:backend:lab
```

The command prints:

- the unified loopback portal URL (`http://127.0.0.1:8791/` by default);
- the backend-only origin (`http://127.0.0.1:8792/` by default);
- the exact disposable state directory;
- an owner-only `participant-access.json` path;
- a content-free `lab-receipt.json` path; and
- bounded participant, contribution, canonical-record, and published-snapshot
  counts.

Open the printed portal URL, not the backend-only origin. The backend origin
does not implement `/api/local/*`; it is reached through the companion's
strict relay.

The recovery capability is never printed. To inspect the seeded participant,
read that owner-only file locally and enter its `recoveryCode` in the portal's
“Recover an existing anonymous participant” control. The same page can then
read authenticated individual statistics, contribution history, community
comparison, and participant export. The public community panel reads the
released clipped and rounded aggregate without authentication.

The Codex in-app browser completed this loopback recovery and private-results
journey on July 26, 2026. A real staged HTTPS deployment must repeat it across
target browsers; localhost behavior is not a substitute for that release gate.

Press `Ctrl-C` to stop both processes. Shutdown deliberately retains the exact
state directory; after inspection, move only the printed laboratory directory
to Trash. It contains disposable credentials and encrypted development
objects.

For backend diagnostics without the local companion, use
`npm run product:backend:only`. That mode intentionally has no dashboard
portal.

Inspect an already stopped laboratory without reading identifiers, secrets, or
record contents:

```sh
npm run product:backend:inspect -- \
  --persist-to /exact/lab/directory/state
```

The stopped-state inspector reports canonical D1 counts and retained
quarantine references. During startup, the laboratory also counts the live
local R2 objects through Wrangler's fixed explorer route, discards all object
keys, and fails unless that count matches the canonical references still
marked as retained. The aggregate-publication smoke advances the scheduled
clock past the ingestion cutoff and may therefore exercise the seven-day
encrypted-quarantine deletion before inspection; accepted canonical metadata
and personal statistics remain in D1. R2 deletion is also exercised through
the Worker integration and destructive HTTP smoke tests.

The laboratory additionally encrypts a fixed payload containing a forbidden
`prompt` canary, proves the server returns `PRIVACY_CANARY_DETECTED`, and then
proves the rejected upload did not alter the primary participant's accepted
history. No raw provider log file is accepted by this route.

## Disabled staging gate

The checked-in `staging` environment is intentionally safe but incomplete:

- `ENROLLMENT_MODE=disabled`;
- `ACCOUNT_SCOPED_INGEST_MODE=disabled`;
- all four D1 collection controls must be `contained`;
- version preview URLs are disabled;
- required envelope-key names are declared without values;
- two D1 bindings, one private R2 binding, two independent rate limiters,
  static assets, hourly lifecycle work, and Worker observability are explicit
  environment configuration; and
- root, staging, and production `ASSETS` bindings all consume the
  manifest-verified `.release-build/worker-assets` tree. The staging step
  allows only the generated community landing assets and rejects dashboard,
  admin, sign-in, contribution, and app-open routes; the native app's
  loopback server continues to use `apps/web/public` separately; and
- D1 resource IDs are schema-valid sentinels that the strict readiness command
  rejects.

Run the non-mutating configuration and dry-deployment gate. It first verifies
and atomically stages the generated public release tree, so a missing,
tampered, or unsafe release output blocks before Wrangler is invoked:

```sh
npm run staging:check
```

Run the live, non-mutating account and resource probe:

```sh
npm run staging:ready
```

The command suppresses raw Wrangler output and emits only bounded booleans and
fixed blocker codes. On July 26, 2026, the authenticated account could reach
D1, but Cloudflare returned `R2_NOT_ENABLED`. No staging resource was created
and nothing was deployed.

Cloudflare documents named Wrangler environments as independent Workers whose
variables and bindings must be restated per environment:
<https://developers.cloudflare.com/workers/wrangler/environments/>.
Cloudflare also documents that R2 buckets are private by default:
<https://developers.cloudflare.com/r2/buckets/create-buckets/>.

After the account owner explicitly enables R2 and accepts any resulting terms
or billing, create exactly these isolated resources:

```sh
npx wrangler d1 create app-usagemonitor-staging
npx wrangler d1 create app-usagemonitor-staging-deletion-ledger
npx wrangler r2 bucket create app-usagemonitor-staging-quarantine
```

Put the two returned D1 UUIDs into the matching `env.staging.d1_databases`
entries. Do not change enrollment or account-scoped modes. Generate a distinct
owner-only staging key file:

```sh
npm run keys:staging
```

This creates ignored mode-0600 `.dev.vars.staging`, refuses overwrite, and
never prints a key. It must not reuse `.dev.vars`.

After the owner has observed the exact staging target and configured resources,
deploy the compatible disabled Worker before any migration:

```sh
npm run staging:deploy -- \
  --origin https://EXACT-STAGING-HOST \
  --phase pre_migration_compatibility \
  --identity-receipt-file /owner-only/staging-deployment-identity.json \
  --confirm DEPLOY_COMPATIBLE_DISABLED_STAGING
```

The compatible deploy binds the checked-out source commit into the non-secret
`DEPLOYMENT_SOURCE_COMMIT` Worker variable through Wrangler's `--var` path and
emits a local non-secret identity receipt. That receipt is an owner-local
attestation, not self-authenticating live proof; its revision field explicitly
remains owner-observation required. Preparation independently fetches the
exact origin's `/api/health` and requires its validated runtime source commit
to match both the identity receipt and the expected checkout before any
remote D1/resource inspection or mutation. The owner must still observe the active opaque revision
and disabled/contained health, then retain a proof referencing that identity
receipt outside Git. Only after those checks may preparation reach remote D1
mutation:

```sh
npm run staging:prepare -- \
  --origin https://EXACT-STAGING-HOST \
  --receipt-file /owner-only/staging-disabled-worker-proof.json \
  --identity-receipt-file /owner-only/staging-deployment-identity.json \
  --confirm PREPARE_DISABLED_STAGING
```

This applies both migration streams and immediately forces enrollment, upload
registration, processing, and publication into `contained`. It has no restore
action. It performs no deployment and authorizes no collection.

Finally deploy the contained build to its exact HTTPS origin:

```sh
npm run staging:deploy -- \
  --origin https://EXACT-STAGING-HOST \
  --confirm DEPLOY_DISABLED_STAGING
```

The wrapper refuses unless configuration, authentication, resources,
migrations, pilot admission/reconciliation schema, and containment are
proven. On the first deploy, it accepts only the fixed owner-only
`.dev.vars.staging` file and supplies those secrets to Wrangler without
printing them. It then checks `/api/health` and `/api/ready` over HTTPS and
fails unless enrollment, upload registration, processing, publication,
encrypted upload, aggregate publication, ongoing device upload, and external
account-scoped participation all remain disabled and lifecycle readiness uses
the expected fail-closed contract. Preparation and deployment each emit a
bounded receipt that explicitly records that collection is not authorized.

This route follows Cloudflare's documented required-secret validation and
first-deploy `--secrets-file` support:
<https://developers.cloudflare.com/workers/configuration/secrets/>.
It is a contained infrastructure check, not pilot authorization. There is
deliberately no remote “resume” command in this repository.

The [disabled staging deployment gate
plan](../../docs/plans/2026-07-26-disabled-staging-deployment-gate-plan.md) records the
trust boundary and remaining live blockers.

The [invite-only pilot operational readiness
runbook](../../docs/runbooks/2026-07-29-invite-pilot-operational-readiness.md) records the atomic
enrollment/pairing contract, contained staging procedure, incident and restore
gates, and remaining human/cloud actions.

From the repository root, the shorter backend-only command is:

```sh
npm run product:backend:test
```

It creates isolated Cloudflare test bindings, applies the real D1 migrations,
and tests validation, canonical server repricing, transactional ingest,
overlap deduplication, participant isolation, private statistics, delayed
aggregation, export, recovery, deletion, quarantine retention, R2 failure
retries, and deletion-safe restore suppression. The deletion ledger is a
second independent D1 binding whose rows contain only a domain-separated
participant digest and fixed retention times. No server or external account is
required.

### Retention and restore safety

Migration `0010_retention_lifecycle.sql` records successful removal of accepted
encrypted quarantine objects. The hourly scheduled handler removes objects
seven days after accepted processing but preserves the separately governed
canonical metadata used for private results and calibration.

Migration `0013_quarantine_reconciliation.sql` closes the object-write crash
window with a D1-first registration protocol:

1. commit an opaque pending registration before calling R2 `put`;
2. write the encrypted envelope to the private bucket;
3. commit the canonical contribution and its accepted records while an insert
   trigger clears the pending registration in that same D1 transaction.

A termination after step 2 therefore leaves a durable, content-free
registration. The hourly reconciler resumes from a persisted D1 cursor, scans
at most 100 due registrations per pass, and waits one hour before treating an
unreferenced registration as abandoned. It checks both canonical contribution
tables. A referenced object is preserved while only its stale registration is
cleared; an unreferenced object is removed idempotently with `head` and
`delete`. Destructive claims are fenced by the current reconciliation lease,
and a replacement pass can reclaim work left by an expired invocation. Failed
D1 or R2 work leaves the cursor retryable and readiness closed. The reconciler
does not enumerate, log, or expose bucket keys.

`GET /api/health` remains the existing non-sensitive liveness and dependency
surface. `GET /api/ready` is the fail-closed traffic-readiness surface. It
returns `503` until the hourly lifecycle has completed within the last two
hours and quarantine retention, deletion-ledger restore replay, pending
aggregate rebuilds, and quarantine reconciliation are all complete. Retention
and reconciliation must also record the same maintenance-cycle timestamp, so a
termination between the two passes cannot reuse an older successful status.
It also validates the upload ingress bindings and performs a non-consuming
`UploadIngressBudget` Durable Object probe, so readiness cannot remain `200`
when public upload admission is unavailable.

`DELETION_LEDGER` has its own migration directory and must be backed up and
restored independently from `USAGE_MONITOR_DB`. Participant deletion first
withdraws derived snapshots, then writes a content-free deletion tombstone,
then removes R2 and primary D1 data. If the independent ledger is unavailable,
deletion fails closed with the primary participant left in a retryable,
non-serving `deleting` state.

Before a restored primary D1 database serves traffic, invoke
`runBackendLifecycle` and then `reconcilePendingQuarantineObjects` in an
isolated stopped-service restore procedure. The lifecycle replay compares
domain-separated participant digests, withdraws any restored derived snapshot,
removes R2 objects, and deletes restored primary rows. Reconciliation then
resolves pending object registrations against both restored canonical tables.
`GET /api/ready` remains `503` until both passes and any queued aggregate
rebuilds are complete. The hourly pass is defense in depth, not permission to
serve a restored database before replay.

The development tombstone has a 400-day `retain_until`. This is a bounded test
value, not an approved production policy. A production backup/soft-delete
horizon and longer tombstone margin remain release gates.

### Loopback-only account-scoped preview

`telemetry-contribution-v0.2` adds participant-bound account tracks, dataset
parts, completeness semantics, provider-policy epochs, five-hour/seven-day
calibration, and rolling quota comparison. It now has a verified encrypted HTTP
path with fresh consent version `privacy-safe-telemetry-v0.2`, but only for an
explicit loopback development preview. Checked-in configuration sets
`ACCOUNT_SCOPED_INGEST_MODE=disabled`; public routes and external participants
remain unauthorized.

Run its focused contract and backend tests with:

```sh
npm test -- --run \
  test/account-scoped-http.spec.ts \
  test/telemetry-v0.2.spec.ts \
  test/telemetry-v0.2-backend.spec.ts
```

Those tests prove server repricing overrides client diagnostics, complete
multi-part datasets are required for calibration, tracks remain scoped to one
participant, conflicting occurrence reuse fails without partial writes, and
deletion removes the account-scoped evidence before statistics are recomputed.
The HTTP suite also proves fail-closed configuration and host checks, fresh
consent, encrypted acceptance, replay behavior, export/deletion, and a
v0.2 upload-only device that cannot read private results.

For a live isolated local smoke:

```sh
ACCOUNT_STATE="$(mktemp -d /private/tmp/app-usagemonitor-account-v02.XXXXXX)"
npm run migrate:local -- --persist-to "$ACCOUNT_STATE"
npm run dev:account-scoped -- --port 8794 --persist-to "$ACCOUNT_STATE"
```

In another terminal:

```sh
npm run smoke:account-scoped:http -- \
  --origin http://127.0.0.1:8794
```

The smoke posts four generated, content-free contributions through the real
encrypted route, verifies server repricing, private account-scoped calibration,
community-field exclusion, participant export, and full participant deletion.
It must be run only against disposable local state. External activation still
requires the prospective reset, minimization, renewed-consent, security, and
privacy gates recorded in `contracts/telemetry-v0.2/`.

### Invite-only HTTP smoke

Use the invite-only mode to test the production-shaped admission and complete
backend lifecycle over a real loopback HTTP server and isolated local D1/R2
state. The smoke can use either a closed `telemetry-contribution-v0.1` file
prepared as described in the root README, or its generated content-free
transport fixture. Then:

```sh
SMOKE_STATE="$(mktemp -d /private/tmp/app-usagemonitor-backend-smoke.XXXXXX)"
echo "$SMOKE_STATE"
npm run migrate:local -- --persist-to "$SMOKE_STATE/state"
for number in {1..20}; do
  npm run grant:issue -- \
    --persist-to "$SMOKE_STATE/state" \
    --output-file "$SMOKE_STATE/invite-$number.secret"
done
npm run dev -- \
  --ip 127.0.0.1 \
  --port 8792 \
  --test-scheduled \
  --persist-to "$SMOKE_STATE/state" \
  --var ENROLLMENT_MODE:invite_only \
  --var ENVIRONMENT:local-development
```

In another terminal, from the repository root:

```sh
# Use the exact directory printed by the first terminal.
SMOKE_STATE=/private/tmp/app-usagemonitor-backend-smoke.REPLACE_ME
INVITE_ARGS=()
for number in {1..20}; do
  INVITE_ARGS+=(--invite-file "$SMOKE_STATE/invite-$number.secret")
done
npm run product:backend:smoke -- \
  --origin http://127.0.0.1:8792 \
  --generated-content-free-fixture \
  "${INVITE_ARGS[@]}"
```

Replace `--generated-content-free-fixture` with
`--file /absolute/path/to/telemetry-contribution-000001.json` to exercise an
actual local export. Exactly one source is required.

The smoke validates owner-only files, redeems twenty invitations without
printing them, and proves:

- exact Secure, HttpOnly, SameSite=Strict `__Host-` session cookies;
- same-origin CSRF and cookie/upload authority isolation;
- one-use upload registration bound to the encrypted digest and byte size;
- strict validation, D1 ingest, opaque R2 quarantine, and recomputed personal
  statistics using server-derived API-price-equivalent costs;
- an authenticated bounded contribution history with accepted/deduplicated
  counts, schema/platform provenance, server-pricing status, and the independent
  seven-day encrypted-quarantine lifecycle, without R2 keys, digests,
  dataset/account pseudonyms, authorities, paths, or source content;
- idempotent replay using a fresh upload authorization;
- a fixed unavailable response before scheduled publication;
- a production-shaped 20-participant weekly snapshot built through Wrangler's
  scheduled-handler test route;
- an authenticated same-week comparison between one participant's clipped
  contribution and the already-public rounded total, without an average,
  percentile, cohort count, account track, or inferred allowance conversion;
- byte-identical reads through both public aliases without participant counts,
  model fingerprints, or client-declared cost;
- bounded participant export with no invitation, session, CSRF, recovery,
  upload, or eligibility capability;
- recovery rotation with a bounded lost-response retry, security reset, revoked
  pending uploads, and logout cookie clearing;
- snapshot withdrawal when deletion starts, followed by an immutable second
  revision rebuilt without the deleted contribution;
- removal of the exact contribution from authenticated history immediately
  after its CSRF-scoped deletion;
- a final privacy-suppressed third revision after all participants are deleted;
  and
- complete deletion of all twenty participants.

It attempts participant cleanup in a `finally` block if an intermediate
assertion fails. The command prints only a content-free summary; it never
prints an invitation, session, CSRF, upload, recovery, participant,
contribution, or row value.

### Capacity profile

Inspect the frozen numerical profile without starting a Worker or making any
request:

```sh
npm run load:profile
```

The profile reports 1,000 participants, 100 attempts per participant, 200
records per attempt, 100,000 encrypted bundle attempts, and 20 million expanded
records. The runner refuses to execute that literal profile unless
`--allow-full-profile` is present.

Against a fresh loopback Worker, run a bounded private-ingestion load with:

```sh
npm run load:http -- \
  --origin http://127.0.0.1:8792 \
  --participants 20 \
  --attempts-per-participant 4 \
  --records-per-attempt 200 \
  --concurrency 10 \
  --hot-participant-count 5 \
  --hot-attempts-per-participant 20 \
  --receipt-file /absolute/owner-only/new-receipt.json
```

`--exercise-aggregate` additionally requires exactly one repeated
`--invite-file /absolute/owner-only/invitation.secret` per participant and an
`invite_only` Worker. Local-open participants deliberately have no independent
eligibility unit and cannot be used to claim aggregate-threshold evidence.

The runner accepts only loopback HTTP, uses the browser RSA/AES envelope path,
registers a new object-bound authority for every upload, checks private
results, records bounded latency summaries and fixed failure codes, and deletes
every created participant in cleanup. More than twenty participants require
`--enrollment-spacing-ms 3100` or greater because the configured enrollment
binding is globally limited to twenty attempts per sixty seconds. The literal
full run therefore has at least 3,096,900 milliseconds of enrollment setup.

The [scaled verification
receipt](../../docs/receipts/2026-07-26-backend-load-scaled-verification-receipt.md) records
the current passing evidence and the remaining full-profile limitations.

The Worker runtime suite, rather than this transport smoke, supplies the exact
assertions for per-participant clipping, independent metric support,
null-versus-explicit-zero handling, cutoff exclusion, and rounding.

### Local incident-containment drill

Migration `0009_collection_controls.sql` adds independent fail-closed controls
for enrollment, upload registration, ingestion processing, and aggregate
publication. The control is a strict singleton D1 row; no administrator HTTP
route exists, and the operator deliberately rejects `--remote`.

With a fresh migrated local state and the Worker still running against that
same `--persist-to` directory, inspect or contain collection from another
terminal:

```sh
npm run control:collection -- \
  --action inspect \
  --persist-to /absolute/path/to/isolated-state

npm run control:collection -- \
  --action contain-all \
  --persist-to /absolute/path/to/isolated-state
```

Restoration is deliberately separate and confirmed:

```sh
npm run control:collection -- \
  --action restore-all \
  --confirm RESTORE_COLLECTION \
  --persist-to /absolute/path/to/isolated-state
```

The repeatable live HTTP drill accepts an owner-only prepared v0.1
contribution:

```sh
npm run smoke:incident:http -- \
  --origin http://127.0.0.1:8792 \
  --persist-to /absolute/path/to/isolated-state \
  --file /absolute/path/to/telemetry-contribution-000001.json
```

It creates two local participants, changes D1 while the Worker remains running,
proves all four controlled paths stop, proves private stats/export/deletion
remain available, restores explicitly, submits the same previously blocked
one-use upload, verifies private statistics, and deletes both participants. The
command attempts restoration and deletion in `finally` on failure. Stop the
Worker, inspect D1/R2 for zeros, and discard the isolated state after the drill.
This local control is development evidence, not a production operator design.

After the server stops, inspect the isolated D1 counts and R2 blob directory,
then move the whole isolated state to Trash:

```sh
npx wrangler d1 execute USAGE_MONITOR_DB \
  --local \
  --persist-to "$SMOKE_STATE/state" \
  --command "SELECT
    (SELECT COUNT(*) FROM participants) AS participants,
    (SELECT COUNT(*) FROM telemetry_contributions) AS contributions,
    (SELECT COUNT(*) FROM telemetry_records) AS records,
    (SELECT COUNT(*) FROM web_sessions) AS sessions,
    (SELECT COUNT(*) FROM upload_authorizations) AS uploads,
    (SELECT COUNT(*) FROM recovery_retry_receipts) AS recovery_receipts;"

npx wrangler d1 execute USAGE_MONITOR_DB \
  --local \
  --persist-to "$SMOKE_STATE/state" \
  --command "SELECT
    (SELECT COUNT(*) FROM community_snapshot_builders) AS builders,
    (SELECT COUNT(*) FROM community_weekly_snapshots) AS snapshots,
    (SELECT COUNT(*) FROM community_weekly_snapshots
      WHERE release_state = 'withdrawn') AS withdrawn_snapshots;"

find "$SMOKE_STATE/state/v3/r2/app-usagemonitor-synthetic-quarantine/blobs" \
  -type f -print
trash "$SMOKE_STATE"
```

The expected result is zero for every participant/session/upload/contribution/
record/recovery count, zero builders, one retained immutable snapshot row in
the `withdrawn` state, and no R2 blob path. The snapshot tombstone is retained
deliberately so a deleted historical week cannot be rebuilt and compared. The
final `trash` operation is macOS-specific and recoverable.

`grant:issue` is local-only. It prints the invitation once when no output file
is supplied. `--output-file` first reserves and syncs a new mode-0600 file
without overwriting an existing path, then creates the matching local D1 grant.
If D1 creation fails, the script removes that exact reserved file before
returning a fixed error; it will not unlink a substituted path.
Remote grant issuance is deliberately unsupported until a separately reviewed
production operator command and approval boundary exist.

## API

- `GET /api/health`
- `GET /api/ready`
- `POST /api/v1/enroll`
- `POST /api/v1/recover`
- `GET /api/v1/session`
- `POST /api/v1/logout`
- `POST /api/v1/me/security-reset`
- `POST /api/v1/me/upload-authorizations`
- `POST /api/v1/me/device-pairings`
- `POST /api/v1/device-pairings/claim`
- `GET /api/v1/me/devices`
- `POST /api/v1/me/devices/revoke`
- `POST /api/v1/device/upload-authorizations`
- `GET /api/v1/envelope-key`
- `POST /api/v1/contributions`
- `POST /api/v1/me/contributions/read`
- `POST /api/v1/me/contributions/delete`
- `GET /api/v1/me`
- `GET /api/v1/me/stats` (alias: `/api/v1/me/insights`)
- `GET /api/v1/community/insights` (alias: `/api/v1/stats/aggregate`)
- `GET /api/v1/me/export`
- `DELETE /api/v1/me`

Personal endpoints accept only a short-lived D1-backed web session delivered
as a Secure, HttpOnly, SameSite=Strict `__Host-` cookie. Session-authenticated
mutations also require the exact same origin and a session-bound CSRF value.
No reusable personal credential is placed in browser storage or returned as an
access token.

Contribution upload is a separate authority class. A session first registers
one exact encrypted digest, byte length, and `application/json` content type.
The returned five-minute `Upload` authorization is hash-only in D1 and can be
used once for that exact body. The upload request omits the personal cookie,
and neither authority is accepted in the other's routes.

An enrolled participant can also create a short-lived, one-use pairing code for
a local collector. The collector generates its device UUID and 32-byte secret
locally, stores the secret in macOS Keychain, and sends only the
domain-separated credential hash while claiming the pairing. The resulting
device authority can register only an exact digest-and-byte-bound one-use
upload authorization. It cannot read participant statistics, export data,
create another device, revoke devices, reset security, recover a participant,
or delete anything. The participant portal lists and revokes devices; recovery,
security reset, and deletion revoke device upload authority as part of their
normal lifecycle.

Recovery rotates the recovery code, revokes every prior web session and unused
upload authorization, and creates a replacement session. To survive a lost
successful HTTP response, the old recovery presentation can reproduce the
same replacement material at most twice for five minutes only when paired
with the identical independent high-entropy recovery-attempt value. The old
code alone or a different attempt value cannot replay it. The retry receipt
stores only hashes, opaque identifiers, and a derivation nonce.
If deletion has already started and the winning session expires or is lost,
the latest recovery code creates a `deletion_only` session. That session
cannot read, export, reset, or upload; it can only finish deletion.
Security reset preserves only the current session while rotating recovery and
revoking other sessions/uploads. Logout clears the cookie even when it is
already stale. Contributions are encrypted with a fresh AES-GCM key; the data
key is wrapped with the published RSA-OAEP-256 key. Only the opaque envelope
is retained in R2 quarantine. Validated closed metadata is stored in D1.

The real test contract is:

- envelope schema `telemetry-envelope-v0.1`, with exactly
  `schemaVersion`, `synthetic`, `keyId`, `wrappedKey`, `iv`, and `ciphertext`;
- plaintext schema `telemetry-contribution-v0.1`, with at most 200 rows total
  (and at most 100 activity rows);
- no client participant, account, or session pseudonym;
- occurrence IDs are used only for participant-scoped overlap deduplication;
- model fingerprints remain participant-scoped and are never emitted from
  community APIs;
- uploaded API-cost values remain `client_declared_unverified` diagnostics;
- canonical personal cost is recalculated by the Worker from validated token
  metadata and stored with price-card, method, registry-version, registry-hash,
  coverage, and unpriced-reason provenance; and
- Codex subscription Fast remains separate and never selects API Priority.
  Subscription usage uses a labeled Standard API counterfactual, while an exact
  Standard, Batch, Flex, or Priority tier is honored only for an API-billed
  surface.

`GET /api/v1/me/stats` returns `participant-stats-v0.2`. Its
`apiPriceEquivalentUsd` is server-repriced. The private analysis machinery can
build bounded one-, two-, and three-hour UTC windows only after account
continuity, monotonic fresh quota observations, and complete server pricing are
available. The current transport intentionally omits account scope, so
`rollingQuotaMovement` fails closed with
`reason: account_continuity_not_transmitted` rather than publishing a
participant-wide conversion. Client tool-class counts are never priced as
provider tool calls because the transport does not contain an exact
provider-billable tool-unit field.

When a weekly community revision is published, the same authenticated response
also includes `participant-community-comparison-v0.1`. It recomputes only that
participant's accepted, eligible records inside the snapshot's fixed period and
cutoff, applies the same per-cell clipping caps, and pairs those private values
only with metrics already released in the immutable public payload. Suppressed
community metrics do not expose a participant value. A withdrawn, suppressed,
malformed, or unavailable revision returns a fixed not-testable state. The
projection contains no cohort count, eligibility identifier, account track,
average, percentile, threshold distance, or share calculation.

In `invite_only` mode, only participants admitted with distinct one-time
invitation grants count toward community snapshots. Local-open participants
cannot unlock a public cell. Each snapshot covers one non-overlapping UTC week,
uses a fixed 48-hour ingestion cutoff, and requires at least twenty independent
eligible participants in every released provider/model cell. Metrics are
clipped per participant before summation, rounded down, and independently
suppressed when they lack support. No exact cohort count, exact metric support,
model fingerprint, or client-declared cost is released. Public reads return
only sealed stored bytes; they never compute live aggregate totals.
Deleting a contribution first marks its D1 row as `deleting`, atomically
withdraws snapshots, and only then removes its opaque R2 object and cascades
its D1 rows. A failed object deletion is retryable without restoring public
snapshot access.
Deleting a participant removes every R2 object before deleting the participant
and all dependent D1 rows, including its private eligibility relation. Either
deletion first withdraws all sealed snapshots and cancels active builders.

## Production gate

`wrangler.jsonc` sets `workers_dev: false` and defines no route. Development
enrollment/recovery has global privacy-preserving attempt bounds, and
invite-only admission is implemented, but the global limiter can itself become
an availability bottleneck. Do not add a preview or production route until an
edge admission layer, participant-fair abuse controls, production secrets and
key rotation, retention/deletion operations, and a separate privacy/security
review authorize real participants. The current dry run is packaging evidence
only; it is not a deployment instruction.
