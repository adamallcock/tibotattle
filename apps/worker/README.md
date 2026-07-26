# Central contribution service

This development-only Cloudflare Worker exercises the full central product
boundary: enrollment, encrypted upload, strict validation, D1 ingest,
participant-isolated and k-anonymous statistics, export, contribution deletion,
and participant deletion. It retains the original fixed synthetic walkthrough
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
backend lifecycle over a real loopback HTTP server. First prepare a closed
`telemetry-contribution-v0.1` file as described in the root README. Then:

```sh
npm run grant:issue -- \
  --output-file /private/tmp/usage-monitor-invite.secret
npm run dev -- \
  --ip 127.0.0.1 \
  --port 8792 \
  --var ENROLLMENT_MODE:invite_only \
  --var ENVIRONMENT:local-development
```

In another terminal, from the repository root:

```sh
npm run product:backend:smoke -- \
  --origin http://127.0.0.1:8792 \
  --file /absolute/path/to/telemetry-contribution-000001.json \
  --invite-file /private/tmp/usage-monitor-invite.secret
```

The smoke command validates the owner-only file locally, redeems the invitation
without printing it, encrypts and uploads the contribution, checks replay and
participant-scoped status/personal/community/export APIs, deletes the test
participant, and proves the old access capability receives `401`. It attempts
participant cleanup in a `finally` block if an intermediate assertion fails.
The command prints only a content-free summary; it never prints the invitation,
access capability, recovery capability, participant ID, contribution ID, or
row values. Delete the temporary invitation file after the run.

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
- `GET /api/v1/envelope-key`
- `POST /api/v1/contributions`
- `GET|DELETE /api/v1/contributions/:id`
- `GET /api/v1/me`
- `GET /api/v1/me/stats` (alias: `/api/v1/me/insights`)
- `GET /api/v1/community/insights` (alias: `/api/v1/stats/aggregate`)
- `GET /api/v1/me/export`
- `DELETE /api/v1/me`

All participant endpoints use bearer capabilities. Recovery rotates the access
capability. Contributions are encrypted with a fresh AES-GCM key; the data key
is wrapped with the published RSA-OAEP-256 key. Only the opaque envelope is
retained in R2 quarantine. Validated closed metadata is stored in D1.

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
suppressed below that same threshold.
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
