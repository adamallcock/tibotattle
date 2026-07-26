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

`USAGE_MONITOR_CENTRAL_ORIGIN` is fixed at startup. The relay permits only
public `GET` requests for health, the public envelope key, and
privacy-thresholded aggregate results. It cannot proxy an arbitrary host,
path, query, content type, authorization header, cookie, CSRF value, or
upstream `Set-Cookie` response.

Enrollment, recovery, uploads, personal statistics, contribution details,
exports, security controls, and deletion require the central service's
same-origin HTTPS portal. The loopback server deliberately cannot relay those
authenticated operations because a Secure personal-session cookie must not be
tunneled through plain HTTP loopback.

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
