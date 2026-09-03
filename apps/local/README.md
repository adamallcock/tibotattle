# Local companion

This loopback-only Node application turns retained privacy-safe monitoring
artifacts into the functional TiboTattle dashboard. It does not send raw
Codex logs, accept arbitrary source paths, or expose raw account/session
pseudonyms to the browser. A separate, explicitly local-only thread-link
contract exposes Codex thread IDs and display names for recent cache-drop rows,
without adding them to accounting snapshots or export DTOs.

A detailed-accounting refresh processes metadata from the selected Codex
`sessions` and `archived_sessions` folders. It also reads the selected Codex home's
`state_5.sqlite` for rollout lineage and `config.toml` for service-tier
settings, and invokes the installed Codex binary's local `app-server` methods
`account/read`, `account/rateLimits/read`, and `account/usage/read`. Source
records are processed locally; prompt and response text is never retained in
the companion's derived state. See the maintained
[local data and privacy reference](../../docs/reference/local-data-and-privacy.md).

`GET /api/local/cache-drop-thread-links` independently resolves those recent
rows against the same published index generation, then reads explicit display
names from the selected Codex home's `session_index.jsonl` and bounded
worker/parent metadata from `state_5.sqlite`. It never reads prompt-bearing
`threads.title` or source transcripts. The endpoint requires the local custom
header, refuses foreign origins and query strings, returns `no-store`, and
does not persist its response or modify the source databases. Missing metadata
does not fail an accounting refresh. See the
[accepted local-link boundary](../../docs/decisions/2026-08-30-local-cache-drop-thread-links.md).

## Run

```bash
USAGE_MONITOR_PORT=8791 node ./apps/local/server.js
```

Then open `http://127.0.0.1:8791/`.

Startup defers the full-history projection so the first local dashboard does
not wait for it. A validated last-authoritative snapshot may supply retained
figures, labelled with their original provenance and the current projection's
unavailable state. Without a valid saved snapshot, missing history remains
unavailable. Automatic lightweight refresh publishes current quota/headline
evidence without advancing retained history. Manual **Refresh** updates quota
and detailed accounting together, replacing retained or unavailable details
only after its generation-bound full projection completes.

To let the personal loopback dashboard read central-service health and use the
fixed hosted identity/participation relay:

```bash
USAGE_MONITOR_PORT=8791 \
  USAGE_MONITOR_CENTRAL_ORIGIN=http://127.0.0.1:8792 \
  node ./apps/local/server.js
```

`USAGE_MONITOR_CENTRAL_ORIGIN` is fixed at startup. It must be either explicit
development loopback (`http://127.0.0.1:<port>`) or a non-loopback HTTPS
origin. The credential-free relay permits only `GET /api/health`. The separate
participant allowlist contains eight current browser operations: enrollment;
Google and Apple sign-in start/result; session; logout; and
device-pairing creation. Collector device sync and upload use their own fixed
hosted client rather than widening the browser relay. Neither relay can proxy
an arbitrary host, path, query, content type, cookie, CSRF value,
authorization value, redirect, or upstream response.

The participant relay is intentionally narrow rather than a generic reverse
proxy. It validates bounded JSON request and response bodies, forwards only the
fixed TiboTattle session cookie and route-appropriate CSRF value, rejects
incoming `Authorization`, and rejects unexpected upstream cookies. This lets
the local dashboard complete its current identity/pairing journey from one
origin without exposing raw logs or granting arbitrary network access.

Retired self-service `DELETE /api/v1/me` and private owner erasure are not
participant-relay permissions. Confirmed **Disconnect this Mac** uses
`POST /api/local/contribution/device-disconnect` and the collector's fixed
hosted device client; it does not widen the relay or delete hosted/local
history. This describes the
[2026-08-30 source contract](../../docs/decisions/2026-08-30-self-service-deletion-retirement.md),
not a verified installed release or hosted deployment.

## Native macOS developer app

The repository can build a self-contained AppKit developer bundle, including a
pinned Node runtime, so a user does not need to install Node or start the
companion from Terminal:

```bash
npm run product:macos:build
open ".release-build/macos/TiboTattle.app"
```

The native window starts the loopback companion on an ephemeral port and opens
the same real dashboard. First-run may register the normal TiboTattle app as a
macOS Login Item only after the user confirms the visibly preselected choice;
it installs no daemon, LaunchAgent, browser extension, privileged helper, or
separate background uploader. Development/ad-hoc builds contain no updater.
Signed stable releases embed the pinned Sparkle framework, enable automatic
downloads by default, and expose that switch under **Settings → About**.
Closing the app stops its companion; a
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
port and the explicit development flag. Preview and production builds derive
the reviewed HTTPS origin from
[`config/deployment-endpoints.js`](../../config/deployment-endpoints.js); the
generic builder cannot accept an independent production origin.

The normalized origin and its mode are sealed into `Info.plist`; the native
launcher validates them again and passes only that value into its closed child
environment. It never inherits a central origin from the launching shell.
Credentials, paths, queries, fragments, arbitrary HTTP hosts, and loopback
HTTPS are rejected. The build manifest records only whether the service is
configured and the connection mode, not its origin.

The HTTPS configuration and exact participant relay are covered by local
contract tests, but they are not evidence that a particular hosted deployment
or installed app is healthy. Track source, preview, installed, live-service,
release, and updater evidence separately in
[`docs/current-status.md`](../../docs/current-status.md).

On first use:

1. open the dashboard from the native window;
2. review whether local Codex metadata and writable installed state are
   available;
3. let the native launcher perform one quick quota/headline refresh after the
   dashboard's first paint, or choose **Refresh** in a standalone browser
   development session;
4. during manual **Refresh**, keep reading as
   TiboTattle continues bounded slices under that original action, or choose
   **Cancel** and resume later; and
5. review the privacy-safe local results; then
6. optionally choose **Contribute and keep it current**, review the exact first
   prepared contribution, and send it explicitly.

Every detailed-analysis slice is deliberately bounded. A separate 128 MiB
checkpointed headline pass publishes current quota and recent content-free
usage before the full seven-day index and deeper replay-safe accounting
complete. The refresh status
exposes `quickResultAt` and the `quick_result` phase. Internal
`bounded_pause` results continue automatically under the same user action, with
a fixed ceiling of exactly two automatic continuations after the initial pass.
Ordinary cache-hit work retains the server's five-minute pass ceiling. A fresh
index, or the exact point at which the companion has authoritatively selected a
full accounting-cache rebuild, can instead use a four-hour total cold-work
ceiling measured from that refresh's start. Each accepted pass receives a
241-minute browser polling window so progress and **Cancel** remain attached to
either server bound; the browser window does not extend the companion deadline.
The fixed maximum remains two automatic continuations after the initial pass,
so the absolute UI attachment bound is three 241-minute windows even though
ordinary passes normally settle within five minutes. If more work remains, the
dashboard says **Deep analysis paused after two bounded continuations**, retains
the headline and verified state, and offers an explicit later resume; it is not
presented as a crash.

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
collector record store as a substitute or perform a second raw-log pass.

An automatic quick refresh preserves the last authoritative accounting
projection while publishing the newly observed quota card; it never advances
the unified index or starts a replay-safe rebuild. The single manual Refresh action
advances the index and rebuilds from the retained authoritative corpus when the
generation is not already cached. A display range is not a history-retention
limit; the explicit legacy rollback scan has a configured window of at least
365 days.

Refresh status carries the attempt's `mode` (`quick` or `detailed`) and actual
`startedAt`, including joined and terminal attempts. Native automatic cadence
observes that receipt, including browser-started work. A confirmed join of a
quick attempt does not consume the hourly detailed allowance.

Selected-plan Trends receives a separate compact, generation/basis/cohort-bound
usage and quota lane. Explicit comparable intervals prevent rolling windows or
cumulative drift from bridging a plan transition or ambiguous usage. Quota is
selected before generic cross-plan collapse. The optional lane has 100,000-row
and 4 MiB resource ceilings, not a short history window: a limit refuses that
comparison rather than truncating history or invalidating all-plan accounting.
The existing export resource guard is applied to source files and bytes,
directory entries, elapsed time, line size, and RSS, including a 1.5 GiB
accounting RSS ceiling. A violation becomes fixed
`refresh_resource_limited`; the browser retains the useful headline or prior
result and explains that deep analysis stopped at its safety limit.

A separate archive-accounting SQLite index now makes all-history coverage
explicit. Its first scheduled source parse is 128 MiB; later resumptions may
schedule up to 1.5 GiB, examine 500,000 directory entries and 125,000 rollout
files, and run for five minutes. It publishes owner-only, durable 128 MiB-or-smaller
checkpoints while it works. The dashboard reports **scanning**, **partial**, or
**complete** archive coverage, while its current cost controls remain
explicitly labelled as a cached 31-day window. This first archive step is a
coverage gate, not an all-time aggregate; it does not turn an incomplete
archive prefix into an all-time cost total.

Before it stages a new archive generation, the companion reserves free disk
space for the existing index, the selected pass budget, and a 128 MiB safety
margin. If that check cannot pass, the dashboard receives the fixed partial
state `archive_disk_space`; it never starts an unsafe stage or calls coverage
complete.

The source-parse budget does not claim to meter every operating-system read:
small source-identity and lineage preflight reads remain protected by the same
source caps and five-minute deadline. A normal finalized JSONL source needs
only a one-byte terminal-newline check before its already indexed prefix can
be reused.

Passive recursive discovery is abort-aware and capped at 500,000 directory
entries and 125,000 rollout files per pass, so the foreground collector cannot
block a qualifying archive scan merely because the older discovery guard was
too small. Its byte ceiling also covers later files, appends, truncations, and
reseeding. Reaching a bound preserves durable cursors and emits fixed
content-free pause evidence. Its responsive recent-window byte, record-batch,
and line-size boundaries remain, while records, cursors, dedupe, quota
observations, accounting cache, and lock live together in one owner-only SQLite
state database; these larger discovery caps are not an unbounded scan.
Legacy JSON/JSONL retirement is serialized by an owner-only migration lease,
requires strict valid bounded records, and does not report complete until every
managed legacy artifact has been removed after a durable parity receipt.

### Codex rollout generations and integrity gaps

Codex may retain several immutable rollout files for one stable thread, including
the canonical `rollout-<timestamp>-<thread>_<rollout>.jsonl` form used by
paginated history. TiboTattle treats the stable thread and the physical rollout
as separate identities. It indexes every valid physical spend delta once,
resolves `history_base` by rollout ID and exact ordinal/byte cutoff, and seeds the
new generation from that boundary so retained history is not charged twice.
Codex's owner-controlled `state_5.sqlite` selected path is used only as a
read-only lineage hint; it never removes superseded real spend from accounting.

An invalid lineage, divergent duplicate rollout, filename mismatch, or
unsupported compressed source quarantines only the affected logical thread.
Unrelated rollouts continue into a terminal partial generation. The dashboard
keeps verified nonzero totals, labels the refresh **degraded**, and reports
privacy-safe skipped-thread/source counts and fixed reason codes; it never
represents the missing portion as zero or calls that archive generation
complete. Raw paths, IDs, prompts, responses, and rollout contents remain local.

An unchanged terminal integrity receipt is a stopping condition. Browser
continuation and the native foreground cadence do not repeatedly rescan the same
corpus. Automatic work is re-enabled only after the source receipt changes; a
user can still explicitly choose **Retry analysis** after repairing the local
files. Old parser identities trigger a cold transactional rebuild so legacy and
rollout-aware event keys cannot coexist in a supposedly complete generation.

Repository-generated weekly artifacts are not a native production fallback.
Developers who specifically need the frozen historical fixture may opt in while
running the source checkout:

```bash
USAGE_MONITOR_DEVELOPMENT_ARTIFACT_FALLBACK=1 \
USAGE_MONITOR_PORT=8791 \
node ./apps/local/server.js
```

Mutable installed state is confined to the owner-only
`~/Library/Application Support/Usage Monitor` directory. The neutral machine
identity is intentional and remains stable across display-name changes. App
resources stay inside the bundle. Development output is ad-hoc signed; current
public releases are separately Developer ID signed, notarized, packaged, and
qualified through the retained release gates. A source build never inherits
those release claims.

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
it is open. The optional Login Item starts the normal app; no daemon,
LaunchAgent, or separate background process continues after the app exits. The
recurring range begins from an owner-only
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
personal-export, multi-device-management, or self-service hosted-deletion flow.
**Disconnect this Mac** asks for confirmation, revokes this device's hosted
authority, clears its local credential/binding, and pauses delivery. Previously
hosted history, other devices, and local analysis remain. Browser sign-out is
not device disconnect; private hosted erasure is an owner operation.
Native troubleshooting-only local erase and targeted Keychain reset remain
under **Data & Diagnostics…** and are not contribution steps.

The incremental controller persists `paused: true`,
`pausedReason: "device_disconnected"`, and `nextAttemptAt: null` before remote
revocation or local credential cleanup. This is explicit user intent, not the
transient `device_unavailable` repair state: restarting the app or reaching the
next scheduled run must not resume delivery. Only explicit approval or resume
can rearm it. Disconnect cancels scheduled work and aborts in-flight attempts
without rewriting consent, measured progress, or prior outcomes. If pause
persistence fails, the operation fails before revocation/cleanup and preserves
the credential/binding for retry; a later revocation or cleanup failure leaves
delivery paused.

## Local API

The complete route-by-route inventory lives in the maintained
[TiboTattle API surface reference](../../docs/reference/api-surface.md).
It covers all local companion paths, fixed report routes, the credential-free
central relay, and the separately allowlisted participant relay. A source-parity
test fails if an exact route allowlist changes without the reference changing
with it.

Local mutations require the exact same origin and
`X-Usage-Monitor-Local: 1`; handlers with bodies additionally enforce closed
JSON contracts. Detailed reports and browser assets use fixed allowlists.
Every API response is `no-store`, and no CORS permission is emitted. The
companion's `/api/local/contribution/sync-next` operation is `POST`; use the
canonical reference rather than retaining a partial route list here.

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
npm run product:backend:acceptance
```

The lab creates dedicated synthetic owner fixtures and isolated envelope keys,
and supplies its smoke child with `--owner-access-file` automatically. It does
not require `.dev.vars` or make ordinary participants admins. Direct smoke/load
commands have a separate required owner-file preflight; see the
[local HTTP procedure](../../docs/runbooks/production-operations.md#disposable-local-http-acceptance).

Use `npm run product:backend:lab` instead when you want the verified state and
portal to remain available for inspection. That command now starts this local
companion on `http://127.0.0.1:8791/` and the backend Worker on
`http://127.0.0.1:8792/` together. Open 8791; 8792 is backend-only.
The companion still defaults to the real Codex home and production credential
backend: isolated Worker storage does not isolate local sources or Keychain.
For backend-only inspection use `npm run product:backend:only`. A no-real-account
browser fixture must separately isolate sources, state, credentials, refresh,
and outbound requests. The standard lab is invite-only and the browser does
not collect invitation codes. Use an already established session for inspection
or a separately configured local-open fixture for fresh browser enrollment.
