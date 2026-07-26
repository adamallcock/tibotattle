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

To exercise the central contribution service through the same origin:

```bash
USAGE_MONITOR_PORT=8791 \
  USAGE_MONITOR_CENTRAL_ORIGIN=http://127.0.0.1:8792 \
  node ./apps/local/server.js
```

`USAGE_MONITOR_CENTRAL_ORIGIN` is fixed at startup. The relay permits only the
documented enrollment, encryption-key, contribution, participant,
personal-statistics, community-statistics, export, recovery, and deletion
routes. It cannot proxy an arbitrary host, path, query, or content type.

## Local API

- `GET /api/local/health`
- `GET /api/local/overview`
- `GET /api/local/gradient`
- `GET /api/local/weekly`
- `GET /api/local/quality`
- `GET /api/local/reports`
- `GET|POST /api/local/refresh`
- `GET /api/local/contribution/preview`

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
