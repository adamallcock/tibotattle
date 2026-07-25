# Synthetic service

This is a development-only Cloudflare Worker for the consumer-product vertical
slice. It accepts one checked-in synthetic contribution shape. It is not
configured or authorized for production deployment or real log uploads.

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
- `GET /api/v1/me`
- `GET /api/v1/me/export`
- `DELETE /api/v1/me`

All participant endpoints use bearer capabilities. Recovery rotates the access
capability. The fixed contribution is encrypted with a fresh AES-GCM key; the
data key is wrapped with the published RSA-OAEP-256 key. Only the opaque
envelope is retained in R2 quarantine. Validated fixed synthetic metadata is
stored in D1. Deletion removes both.

## Production gate

`wrangler.jsonc` sets `workers_dev: false` and defines no route. Do not add a
preview or production route until unauthenticated enrollment and recovery have
edge admission controls and rate limits, production secrets and key rotation
are designed, and a separate privacy/security review authorizes real
participants. The current dry run is packaging evidence only; it is not a
deployment instruction.
