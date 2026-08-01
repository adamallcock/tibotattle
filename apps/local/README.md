# Local companion

This loopback-only Node application turns retained privacy-safe monitoring
artifacts into the functional TiboTattle dashboard. It does not send raw
Codex logs, accept arbitrary source paths, or expose raw account/session
pseudonyms to the browser.

## Run

```bash
USAGE_MONITOR_PORT=8791 node ./apps/local/server.js
```

Then open `http://127.0.0.1:8791/`.

To let the personal loopback dashboard read public central-service health and
thresholded community results:

```bash
USAGE_MONITOR_PORT=8791 \
  USAGE_MONITOR_CENTRAL_ORIGIN=http://127.0.0.1:8792 \
  node ./apps/local/server.js
```

`USAGE_MONITOR_CENTRAL_ORIGIN` is fixed at startup. It must be either explicit
development loopback (`http://127.0.0.1:<port>`) or a non-loopback HTTPS
origin. The relay permits the reviewed public API plus an exact
participant-lifecycle allowlist for enrollment, uploads, personal statistics,
contribution history, support-only recovery/export/security routes, and
deletion. The ordinary product does not expose the support-only routes as a
consumer recovery or account-management journey. The relay cannot proxy an
arbitrary host, path, query, content type, cookie, CSRF value, authorization
value, redirect, or upstream response.

The participant relay is intentionally narrow rather than a generic reverse
proxy. It validates bounded JSON request and response bodies, forwards only the
fixed TiboTattle session cookie, accepts CSRF and one-use upload
authorization values only in their expected routes and formats, and rejects
unexpected upstream cookies. This lets the local dashboard exercise the full
disposable backend lifecycle from one origin without exposing raw logs or
granting arbitrary network access.

## Native macOS developer app

The repository can build a self-contained AppKit developer bundle, including a
pinned Node runtime, so a user does not need to install Node or start the
companion from Terminal:

```bash
npm run product:macos:build
open ".release-build/macos/TiboTattle.app"
```

The native window starts the loopback companion on an ephemeral port and opens
the same real dashboard. It does not install a daemon, Login Item,
LaunchAgent, browser extension, or background uploader. The ordinary
development/ad-hoc build also contains no updater framework and performs no
updater networking. A separately gated external-distribution build can embed
the pinned Sparkle 2.9.3 framework; automatic download and install-on-quit are
still off until the user opts in. Closing the app stops its companion; a
parent-death watchdog also prevents the bundled child from surviving a forced
launcher termination. External preparation is repeatable: an existing exact
pinned framework is independently verified and reused, while an alias or
modified framework fails closed.

The default bundle is deliberately local-only. For an end-to-end developer
smoke against the disposable backend laboratory, bake its loopback origin into
the signed bundle:

```bash
node ./scripts/build-macos-app.js \
  --output ".release-build/macos-connected/TiboTattle.app" \
  --central-origin http://127.0.0.1:8792 \
  --allow-loopback-central-origin

".release-build/macos-connected/TiboTattle.app/Contents/MacOS/UsageMonitor" \
  --central-smoke-test
```

Plain HTTP is accepted only for the exact `127.0.0.1` host, with an explicit
port and the explicit development flag. A future production build instead
uses a fixed non-loopback HTTPS origin and no development flag:

```bash
node ./scripts/build-macos-app.js \
  --output ".release-build/macos-production/TiboTattle.app" \
  --central-origin https://usage-monitor.example
```

The normalized origin and its mode are sealed into `Info.plist`; the native
launcher validates them again and passes only that value into its closed child
environment. It never inherits a central origin from the launching shell.
Credentials, paths, queries, fragments, arbitrary HTTP hosts, and loopback
HTTPS are rejected. The build manifest records only whether the service is
configured and the connection mode, not its origin.

The HTTPS configuration and exact participant relay are covered by local
contract tests, but they are not evidence that a particular hosted deployment
exists or is ready. Consumer enrollment, contribution history, uploads, and
deletion, plus the support-only recovery and export routes, still require a
live disabled-first hosted smoke before a production claim.

On first use:

1. open the dashboard from the native window;
2. review whether local Codex metadata and writable installed state are
   available;
3. choose **Analyze local usage** to start one bounded, cancellable job;
4. keep reading as TiboTattle automatically continues bounded slices under
   that original action, or choose **Cancel** and resume later; and
5. review the privacy-safe local results; then
6. optionally choose **Contribute and keep it current**, review the exact first
   prepared contribution, and send it explicitly.

Every slice is deliberately bounded. A separate 64 MiB checkpointed headline
pass publishes current quota and recent content-free usage before the full
seven-day index and deeper replay-safe accounting complete. The refresh status
exposes `quickResultAt` and the `quick_result` phase. Internal
`bounded_pause` results continue automatically under the same user action, with
a fixed ceiling of exactly two automatic continuations after the initial pass.
Each accepted pass receives a six-minute browser polling window around the
server's five-minute pass ceiling, so one click has a finite roughly 18-minute
UI budget. If more work remains, the dashboard says **Deep analysis paused
after two bounded continuations**, retains the headline and verified state, and
offers an explicit later resume; it is not presented as a crash.

A user can cancel through the same-origin loopback API at any time. Cancellation
preserves the last verified dashboard, safe quick result, and durable
checkpoint. A later **Update local usage** resumes from that checkpoint. Raw
prompts, responses, commands, source paths, repository names, and local files
are not served to the browser or sent to a hosted service.

The same lineage-aware raw-log pass now captures weekly rate-limit snapshots
while it computes API-price-equivalent usage. It atomically writes only an
owner-readable, versioned, content-free accounting cache. The weekly view uses
that live cache and labels older observations as account-unattributed and
potentially spanning multiple accounts. It does not read the replay-heavy
collector ledger as a substitute or perform a second raw-log pass.

A quota-only refresh now reuses a current accounting cache while preserving
the newly observed quota card. If any genuinely new rollout usage was written,
the companion still rebuilds through one bounded 31-day replay-safe scan.
The existing export resource guard is applied to source files and bytes,
directory entries, elapsed time, line size, and RSS, including a 1.5 GiB
accounting RSS ceiling. A violation becomes fixed
`refresh_resource_limited`; the browser retains the useful headline or prior
result and explains that deep analysis stopped at its safety limit. This is
safe for the pilot. A persistent incremental index remains the intended
performance optimization for fast complete scans of very large histories.

Passive recursive discovery is abort-aware and capped at 20,000 directory
entries and 5,000 rollout files per pass. Its byte ceiling also covers later
files, appends, truncations, and reseeding. Reaching a bound preserves durable
cursors and emits fixed content-free pause evidence; the foreground collector
uses the same limits.

Repository-generated weekly artifacts are not a native production fallback.
Developers who specifically need the frozen historical fixture may opt in while
running the source checkout:

```bash
USAGE_MONITOR_DEVELOPMENT_ARTIFACT_FALLBACK=1 \
USAGE_MONITOR_PORT=8791 \
node ./apps/local/server.js
```

Mutable installed state is confined to the owner-only
`~/Library/Application Support/TiboTattle` directory. App resources stay
inside the bundle. The current artifact is only ad-hoc signed for local
development; it is not Developer ID signed, notarized, packaged as a
publishable DMG, or ready for unreviewed public installation.

## Product and contribution boundary

The installed app is the local collection and lifecycle owner. Its private
loopback dashboard is the canonical personal-reporting surface. A hosted site
is for acquisition, downloads, documentation, and delayed public community
aggregates; it does not receive permission to read Codex files and is not a
substitute for the personal dashboard.

Contribution is off by default. The affirmative path requires:

1. an explicit consent choice;
2. local preparation of a bounded content-free pseudonymous set;
3. exact local review;
4. an explicit first send; and
5. a terminally accepted first upload before recurring contribution can start.

After those gates, the app may attempt one bounded update every six hours while
it is open. No daemon, Login Item, LaunchAgent, or separate background process
continues after the app exits. The recurring range begins from an owner-only
accepted-through watermark bound to the exact destination and contribution
contract, includes a fixed one-hour overlap for replay-safe server
deduplication, and covers at most 24 hours per prepared pass. A partial,
retryable, rejected, aborted, or timed-out pass cannot move the watermark.
Settings v0.3 first persists an owner-only write-ahead claim containing the
fixed preparation attempt and exact range contract. An interrupted run
re-enters that same attempt, verifies any retained review, staging, or
published evidence, and does not prepare a fresh range while the claim remains.
Once its prepared-set ID is known, the claim binds and protects that exact set
through maintenance and the transition to pending upload.

One run requests cooperative abort at a five-minute deadline and is further
limited to 100 upload jobs and 64 MiB. Shutdown waits for active preparation or
upload cleanup to quiesce before releasing the single-instance lock. Longer
offline intervals catch up across successive 24-hour passes; more than 256
unresolved prepared sets fails closed for repair rather than allowing
unbounded discovery.

Accepted prepared sets are retired only when every queue job in the set is
terminally accepted and the bounded artifact path passes the owner-only
canonical-root checks. The policy protects the reviewed first-send evidence
and any active claim or pending set from automatic retirement, makes an
unprotected fully accepted set eligible when it is older than seven days or
beyond the eight most-recent accepted sets, removes artifacts before compacting
accepted queue rows, removes at most sixteen eligible sets per pass, and never
removes retryable, in-flight, or rejected work.

The ordinary browser journey has no recovery-code, account-reset,
personal-export, or multi-device-management flow. A quiet
**Hosted privacy controls** disclosure retains complete hosted deletion.
Native troubleshooting-only local erase and targeted Keychain reset remain
under **Data & Diagnostics…** and are not contribution steps.

## Local API

- `GET /api/local/health`
- `GET /api/local/onboarding`
- `GET /api/local/overview`
- `GET /api/local/gradient`
- `GET /api/local/weekly`
- `GET /api/local/quality`
- `GET /api/local/reports`
- `GET|POST /api/local/refresh`
- `POST /api/local/refresh/cancel`
- `GET /api/local/contribution/preview`
- `POST /api/local/contribution/prepare`
- `GET /api/local/contribution/sync-next`
- `POST /api/local/contribution/sync-inspect-exact`
- `POST /api/local/contribution/sync-once`
- `GET /api/ready` through the fixed central relay when configured
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
npm run product:local:test
npm run product:macos:test
```

Run the disposable Worker/D1/R2 acceptance laboratory separately with:

```bash
# Run once on a clean checkout.
npm run product:keys:local

npm run product:backend:acceptance
```

Use `npm run product:backend:lab` instead when you want the verified state and
portal to remain available for inspection. That command now starts this local
companion on `http://127.0.0.1:8791/` and the backend Worker on
`http://127.0.0.1:8792/` together. Open 8791; 8792 is backend-only.
