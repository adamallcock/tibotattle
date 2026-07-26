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

The Worker is deliberately not configured or authorized for a public
production deployment. Real telemetry support is for local backend and
end-to-end product testing until the separate consent, admission-control,
security, and privacy review gates are complete.

## Local run

```sh
npm install
npm run keys:local
npm run migrate:local
npm run dev
```

`keys:local` creates a mode-0600 `.dev.vars` file and refuses to overwrite an
existing one. The file is ignored by Git. Never commit or paste its contents.

Useful checks:

```sh
npm run check
```

That command verifies generated Worker types, runs TypeScript and the
Cloudflare-runtime integration tests, and performs a deployment dry run. It
does not deploy anything.

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

`DELETION_LEDGER` has its own migration directory and must be backed up and
restored independently from `USAGE_MONITOR_DB`. Participant deletion first
withdraws derived snapshots, then writes a content-free deletion tombstone,
then removes R2 and primary D1 data. If the independent ledger is unavailable,
deletion fails closed with the primary participant left in a retryable,
non-serving `deleting` state.

Before a restored primary D1 database serves traffic, invoke the same
`runBackendLifecycle` replay path in an isolated stopped-service restore
procedure. It compares domain-separated participant digests, withdraws any
restored derived snapshot, removes R2 objects, and deletes restored primary
rows. The hourly pass is defense in depth, not permission to serve a restored
database before replay.

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
state. First prepare a closed `telemetry-contribution-v0.1` file as described
in the root README. Then:

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
  --file /absolute/path/to/telemetry-contribution-000001.json \
  "${INVITE_ARGS[@]}"
```

The smoke validates owner-only files, redeems twenty invitations without
printing them, and proves:

- exact Secure, HttpOnly, SameSite=Strict `__Host-` session cookies;
- same-origin CSRF and cookie/upload authority isolation;
- one-use upload registration bound to the encrypted digest and byte size;
- strict validation, D1 ingest, opaque R2 quarantine, and recomputed personal
  statistics using server-derived API-price-equivalent costs;
- idempotent replay using a fresh upload authorization;
- a fixed unavailable response before scheduled publication;
- a production-shaped 20-participant weekly snapshot built through Wrangler's
  scheduled-handler test route;
- byte-identical reads through both public aliases without participant counts,
  model fingerprints, or client-declared cost;
- bounded participant export with no invitation, session, CSRF, recovery,
  upload, or eligibility capability;
- recovery rotation with a bounded lost-response retry, security reset, revoked
  pending uploads, and logout cookie clearing;
- snapshot withdrawal when deletion starts; and
- complete deletion of all twenty participants.

It attempts participant cleanup in a `finally` block if an intermediate
assertion fails. The command prints only a content-free summary; it never
prints an invitation, session, CSRF, upload, recovery, participant,
contribution, or row value.

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
