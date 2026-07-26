# Central contribution service

This development-only Cloudflare Worker exercises the full central product
boundary: enrollment, encrypted upload, strict validation, D1 ingest,
participant-isolated statistics, thresholded development community diagnostics,
export, contribution deletion, and participant deletion. It retains the original fixed synthetic walkthrough
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

### Invite-only HTTP smoke

Use the invite-only mode to test the production-shaped admission and complete
backend lifecycle over a real loopback HTTP server and isolated local D1/R2
state. First prepare a closed `telemetry-contribution-v0.1` file as described
in the root README. Then:

```sh
SMOKE_STATE="$(mktemp -d /private/tmp/app-usagemonitor-backend-smoke.XXXXXX)"
echo "$SMOKE_STATE"
npm run migrate:local -- --persist-to "$SMOKE_STATE/state"
for number in 1 2 3; do
  npm run grant:issue -- \
    --persist-to "$SMOKE_STATE/state" \
    --output-file "$SMOKE_STATE/invite-$number.secret"
done
npm run dev -- \
  --ip 127.0.0.1 \
  --port 8792 \
  --persist-to "$SMOKE_STATE/state" \
  --var ENROLLMENT_MODE:invite_only \
  --var ENVIRONMENT:local-development
```

In another terminal, from the repository root:

```sh
# Use the exact directory printed by the first terminal.
SMOKE_STATE=/private/tmp/app-usagemonitor-backend-smoke.REPLACE_ME
npm run product:backend:smoke -- \
  --origin http://127.0.0.1:8792 \
  --file /absolute/path/to/telemetry-contribution-000001.json \
  --invite-file "$SMOKE_STATE/invite-1.secret" \
  --invite-file "$SMOKE_STATE/invite-2.secret" \
  --invite-file "$SMOKE_STATE/invite-3.secret"
```

The smoke validates owner-only files, redeems three invitations without
printing them, and proves:

- exact Secure, HttpOnly, SameSite=Strict `__Host-` session cookies;
- same-origin CSRF and cookie/upload authority isolation;
- one-use upload registration bound to the encrypted digest and byte size;
- strict validation, D1 ingest, opaque R2 quarantine, and recomputed personal
  statistics;
- idempotent replay using a fresh upload authorization;
- aggregate diagnostic suppression at one participant and development-only
  availability at three;
- bounded participant export with no invitation, session, CSRF, recovery,
  upload, or eligibility capability;
- recovery rotation with a bounded lost-response retry, security reset, revoked
  pending uploads, and logout cookie clearing; and
- complete deletion of all three participants.

It attempts participant cleanup in a `finally` block if an intermediate
assertion fails. The command prints only a content-free summary; it never
prints an invitation, session, CSRF, upload, recovery, participant,
contribution, or row value.

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

find "$SMOKE_STATE/state/v3/r2/app-usagemonitor-synthetic-quarantine/blobs" \
  -type f -print
trash "$SMOKE_STATE"
```

The expected result is zero for every D1 count and no R2 blob path. The final
`trash` operation is macOS-specific and recoverable.

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
- `GET /api/v1/envelope-key`
- `POST /api/v1/contributions`
- `GET|DELETE /api/v1/contributions/:id`
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
- API-cost values are explicitly labelled
  `client_declared_unverified` until server-side repricing is implemented.

In `invite_only` mode, only participants admitted with distinct one-time
invitation grants count toward community statistics. Local-open participants
cannot unlock the cohort. Community statistics are suppressed below three
eligible contributing participants, and model/day slices are independently
suppressed below that same threshold. These changing cumulative totals remain
development diagnostics: cohort thresholds do not prevent before/after
differencing. Public release requires delayed immutable weekly snapshots,
independent per-cell support, per-participant clipping, coarse rounding, and a
fixed ingestion cutoff.
Deleting a contribution removes its opaque R2 object and cascades its D1 rows.
Deleting a participant removes every R2 object before deleting the participant
and all dependent D1 rows, including its private eligibility relation.

## Production gate

`wrangler.jsonc` sets `workers_dev: false` and defines no route. Development
enrollment/recovery has global privacy-preserving attempt bounds, and
invite-only admission is implemented, but the global limiter can itself become
an availability bottleneck. Do not add a preview or production route until an
edge admission layer, participant-fair abuse controls, production secrets and
key rotation, retention/deletion operations, and a separate privacy/security
review authorize real participants. The current dry run is packaging evidence
only; it is not a deployment instruction.
