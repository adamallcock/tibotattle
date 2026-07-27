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
- `POST /api/local/contribution/prepare`
- `GET /api/local/contribution/sync-next`
- `POST /api/local/contribution/sync-inspect-exact`
- `POST /api/local/contribution/sync-once`
- the fixed central public and participant routes under `/api/v1/*` when a
  loopback central origin is configured

Refresh and preparation POSTs require the exact same origin, JSON, and
`X-Usage-Monitor-Local: 1`. Detailed reports and browser assets use fixed
allowlists. Every API response is `no-store`, and no CORS permission is
emitted.

## Development identity override

Production preparation uses the
`app-usagemonitor.export-identity.v1` macOS Keychain item. It never falls back
to a file when Keychain access fails.

For an isolated development journey only, the launcher accepts an explicit
owner-only identity file when both fixed settings are present. Create a
temporary `0700` directory and a `0600` identity through the existing
identity core; the command never prints the secret:

```bash
development_identity_dir="$(mktemp -d "${TMPDIR:-/tmp}/usage-monitor-identity.XXXXXX")"
chmod 700 "$development_identity_dir"
development_identity_file="$development_identity_dir/export-identity"

node --input-type=module -e '
  const { loadOrCreateParticipantSecret } =
    await import("./src/export-identity.js");
  await loadOrCreateParticipantSecret({
    environmentSecret: null,
    secretFile: process.argv[1],
    legacySecretFile: null
  });
' "$development_identity_file"

USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY=1 \
USAGE_MONITOR_DEVELOPMENT_EXPORT_SECRET_FILE="$development_identity_file" \
USAGE_MONITOR_PORT=8791 \
node ./apps/local/server.js
```

The launcher rejects a relative path, symlink, non-regular file, file not owned
by the current user, any mode other than exactly `0600`, a missing opt-in, or a
simultaneous `APP_USAGEMONITOR_EXPORT_SECRET`. It validates this before
listening. Browser responses expose only
`development_file_override`, never the path or credential. The override is not
an automatic recovery mechanism and does not establish production Keychain
acceptance. Keep the terminal open while testing; remove the specific temporary
directory later only if losing that development identity's continuity is
intentional.

The exact-review endpoint is a same-origin, explicitly authorized local
mutation. It reopens the next owner-only prepared contribution through the
prepared-set verifier and returns every retained field and value to the local
page. It never performs a service request. The send action remains disabled
until that review succeeds. A successful review creates a ten-minute,
single-use opaque authorization held only by the loopback server. It is bound
to that one queue job and prepared-file SHA-256; delivery consumes the
authorization and can claim only that exact ready job.

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
