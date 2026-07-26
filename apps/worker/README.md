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

Community statistics are suppressed below three contributing participants, and
model/day slices are independently suppressed below that same threshold.
Deleting a contribution removes its opaque R2 object and cascades its D1 rows.
Deleting a participant removes every R2 object before deleting the participant
and all dependent D1 rows.

## Production gate

`wrangler.jsonc` sets `workers_dev: false` and defines no route. Do not add a
preview or production route until unauthenticated enrollment and recovery have
edge admission controls and rate limits, production secrets and key rotation
are designed, and a separate privacy/security review authorizes real
participants. The current dry run is packaging evidence only; it is not a
deployment instruction.
