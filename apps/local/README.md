# Local companion

This loopback-only Node application turns retained privacy-safe monitoring
artifacts into the functional Usage Monitor dashboard. It does not send raw
Codex logs, accept arbitrary source paths, or expose raw account/session
pseudonyms to the browser.

## Run

```bash
USAGE_MONITOR_PORT=8791 node ./apps/local/server.js
```

Then open `http://127.0.0.1:8791/`.

To read public central-service health and thresholded community results through
the loopback dashboard:

```bash
USAGE_MONITOR_PORT=8791 \
  USAGE_MONITOR_CENTRAL_ORIGIN=http://127.0.0.1:8792 \
  node ./apps/local/server.js
```

`USAGE_MONITOR_CENTRAL_ORIGIN` is fixed at startup and must be loopback. The
relay permits the reviewed public API plus an exact participant-lifecycle
allowlist for enrollment, recovery, uploads, personal statistics, contribution
history, export, security controls, and deletion. It cannot proxy an arbitrary
host, path, query, content type, cookie, CSRF value, authorization value, or
upstream response.

The participant relay is intentionally narrow rather than a generic reverse
proxy. It validates bounded JSON request and response bodies, forwards only the
fixed Usage Monitor session cookie, accepts CSRF and one-use upload
authorization values only in their expected routes and formats, and rejects
unexpected upstream cookies. This lets the local dashboard exercise the full
disposable backend lifecycle from one origin without exposing raw logs or
granting arbitrary network access.

## Local API

- `GET /api/local/health`
- `GET /api/local/overview`
- `GET /api/local/gradient`
- `GET /api/local/weekly`
- `GET /api/local/quality`
- `GET /api/local/reports`
- `GET|POST /api/local/refresh`
- `GET /api/local/contribution/preview`
- the fixed central public and participant routes under `/api/v1/*` when a
  loopback central origin is configured

Refresh POSTs require the exact same origin, JSON, and
`X-Usage-Monitor-Local: 1`. Detailed reports and browser assets use fixed
allowlists. Every API response is `no-store`, and no CORS permission is
emitted.

## Test

```bash
node --test \
  test/local-companion-data.test.js \
  test/telemetry-contribution-builder.test.js \
  apps/local/server.test.mjs
```

Run the disposable Worker/D1/R2 acceptance laboratory separately with:

```bash
# Run once on a clean checkout.
npm run product:keys:local

npm run product:backend:acceptance
```

Use `npm run product:backend:lab` instead when you want the verified state and
portal to remain available for inspection.
