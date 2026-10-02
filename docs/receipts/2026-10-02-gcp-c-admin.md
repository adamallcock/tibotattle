---
title: GCP C-ADMIN admin console port
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP C-ADMIN admin console port

This is a 2026-10-02 receipt for stream C-ADMIN on branch
`claude/gcp-fp-c-admin`, cut from `claude/gcp-fastpath-final` at `afd865a0`.
It ports the six admin console routes of the production Worker (`d43c8f92`)
to PostgreSQL as new modules only. Nothing is registered in the Cloud Run
host: D-CRB registers the family and switches the admin host from refused
(OD-CR-3) to the chokepoint.

It records **local, synthetic** evidence only: one macOS arm64 workstation,
Node 26.2.0 for the checks, Node 22.16.0 (the image runtime) for the bundle
probe, and the local PostgreSQL 17 fan-out cluster on a private Unix socket
(port 55433). Nothing was built in Cloud Build, deployed, migrated or read in
any GCP or Cloudflare project. No `gcloud`, `wrangler` or push ran. Every
fixture value is synthetic and content-free; the commits are the
repository's own.

## Commits

| Commit | Content |
|---|---|
| `d950f9ae` | The port: 6 `src/postgres-admin-*.ts` modules, 9 `cloud-run/routes/admin-*.mjs` modules (one is the check), and the PostgreSQL 17 spec |
| this receipt's commit | This receipt |

## What is ported

The six ids are the `authority: "admin"` entries of `WORKER_ROUTE_POLICY`
(`src/route-registry.ts`), pinned by the check.

| Route | GCP answer | Source |
|---|---|---|
| `GET /api/v1/admin/overview` | The full `admin-overview-v0.5` typed body, in the Worker's key order, or the Worker's 503 when a block has no source (below) | [postgres-admin-overview.ts](../../apps/worker/src/postgres-admin-overview.ts), [postgres-admin-distribution.ts](../../apps/worker/src/postgres-admin-distribution.ts) |
| `GET /api/v1/admin/metrics/history` | 503 `ADMIN_METRICS_HISTORY_CACHE_UNAVAILABLE` unless a reader is injected | No GCP producer warms the history cache |
| `GET /api/v1/admin/community/allowance-preview` | The stored preview in canonical key order, or 503 `ADMIN_ALLOWANCE_STORAGE_UNAVAILABLE` | `analytics_v2_preview`, [postgres-admin-allowance-preview.ts](../../apps/worker/src/postgres-admin-allowance-preview.ts) |
| `GET /api/v1/admin/database-health` | The closed `admin-database-health-v0.1` DTO; an unsupplied role is `not_configured` | [postgres-admin-database-health.ts](../../apps/worker/src/postgres-admin-database-health.ts) |
| `GET /api/v1/admin/reconstruction-progress` | The Worker's query validation, then 503 `BACKEND_STORAGE_UNAVAILABLE` unless a reader is injected | The fast path has no incremental graph pipeline to report |
| `POST /api/v1/admin/action` | `set_collection_controls` in full; the other actions per the table below | [postgres-admin-collection-controls.ts](../../apps/worker/src/postgres-admin-collection-controls.ts), [admin-action.mjs](../../apps/worker/cloud-run/routes/admin-action.mjs) |

The route families and their composition are
[admin-console.mjs](../../apps/worker/cloud-run/routes/admin-console.mjs) and
the modules it imports.

### Authorization

- The chokepoint,
  [postgres-admin-access.ts](../../apps/worker/src/postgres-admin-access.ts),
  is the Worker's own `verifyAdminAccessAssertion` followed by
  `authorizeAdminEmail` against `ACCESS_ADMIN_EMAIL`, unchanged. Its result
  is the normalized owner email, the identity key the root registers in the
  request context.
- It refuses to build over an env that carries `ACCESS_TEST_JWKS_JSON`
  unless a test origin opts in. CR-3 already forbids that variable; this is
  defense in depth at the point of use.
- The families never re-verify Access (FC-4). Each answers 403
  `ADMIN_REQUIRED` when the root registered no identity, before its method
  check.
- `admin_action` runs the Worker's `assertAdminCsrf` (exact Origin, a
  same-origin or absent Sec-Fetch-Site, and `x-usage-monitor-admin: 1`)
  before it reads the body.

### Edge contract check

EP-0 (`src/edge-origin-contract.ts`) and EP-4 (`src/edge-origin-proxy.ts`)
already carry everything these routes read, so no contract change is needed.

- `cf-access-jwt-assertion` is forwarded on the admin host only.
- `cookie`, which carries the `CF_Authorization` fallback, is forwarded on
  both hosts.
- `origin`, `sec-fetch-site`, `x-usage-monitor-admin`, `content-type` and
  `content-length` are forwarded.
- EP-6 rebuilds an admin-host request on `https://admin.<apex>`, so the CSRF
  origin comparison sees the browser's origin.
- The edge forwards every method of the six ids on the admin host and answers
  them 404 on the apex.
- The edge merges its Cloudflare distribution read into a 200 overview whose
  body has `distribution.cloudflare` and `distribution.github.release`. The
  origin body always has both.

The check pins the forwarded header lists.

### Decided differences

Each of these is fail-closed and covered by a negative test.

- **Overview blocks with no GCP source:** `counts.contributions.synthetic`
  (the D1 `contributions` table has no PostgreSQL relation),
  `historicalPublication` (production's per-day model publications have no
  `analytics_v2` counterpart) and `deletionLedger` once the ledger is gone.
  - Each is an injected source.
  - Without one, the whole overview is the Worker's 503
    `BACKEND_STORAGE_UNAVAILABLE`. It is never a zero.
  - While a ledger database exists, the faithful tombstone reader is bound
    automatically.
- **Pending daily rebuilds** are counted the way the analytics-refresh job
  reads them: the distinct days named by journal events after
  `analytics_v2_journal_cursor`. Terminal events name no day.
- **GitHub distribution:** the Worker's own exported
  `readGithubDistributionSnapshot` runs over a read-only adapter.
  - The adapter answers exactly the six statements that function issues, in
    one PostgreSQL snapshot. Any other statement degrades to the Worker's own
    `GITHUB_SNAPSHOT_UNAVAILABLE` block.
  - A release `published_at` with whole seconds renders in GitHub's format,
    without a fraction.
- **Allowance preview:** production's authority, containment and freshness
  columns are not ported, the same basis the public community-daily route
  documents. The spec shows that the vendored validator alone does not bound
  the preview's age.
- **`run_maintenance` with `participantErasure`** is a closed 400
  `BODY_INVALID` with no audit row and no storage call. This follows
  append-only decision D2 and the AA-1 v4 brief.
- **Tasks without a PostgreSQL port** answer 503 `POSTGRES_ROUTE_NOT_PORTED`,
  with no retry-after and before any audit row. These are the plain
  maintenance pass (C-MAINT), `sync_distribution`,
  `telemetryRuntimeActivation`, `transportRollback` and
  `v11EvidenceAdoption`.
  - Each is an injection point that follows the Worker's audit flow once it is
    supplied.
- **A PostgreSQL controls guard** (SQLSTATE P1005, such as the 0042/0043
  import lock) refusing `set_collection_controls` is 409
  `LIFECYCLE_STATE_CONFLICT`. Its failure audit is written in a second
  transaction. The Worker has no such guard.
- **Quarantine reference counts** check `telemetry_contributions` and the
  v1, v1.1 and v1.2 chunks. The synthetic `contributions` table does not
  exist on PostgreSQL.

## Gates

| Command (from `apps/worker` unless noted) | Result |
|---|---|
| `node_modules/.bin/tsc --noEmit -p tsconfig.json` | Pass |
| `node --test cloud-run/routes/admin-console.check.mjs` | 23/23 pass |
| `PG_TEST_SOCKET=… PG_TEST_PORT=55433 node --test --test-concurrency=1 postgres-test/postgres-admin-console.spec.mjs` | 9/9 pass. Schemas `c_admin_p_*` and `c_admin_l_*` were dropped afterwards; none remain |
| esbuild bundle of `admin-console.mjs` and `postgres-admin-access.ts` with the image options, imported under Node 22.16.0 | Bundles and loads |
| `npm run architecture:check` (root) | Pass: 940 production files, 0 debt edges |
| `npm run test:preflight` (root) | Pass |

The spec's parity method:

- The same synthetic fixture is written to PostgreSQL (the promoted primary
  and ledger chains) and to SQLite files carrying the Worker's D1 schemas.
- The expected body comes from the Worker's own code over the reviewed D1
  adapter. That code is the vendored `d43c8f92` `readAdminOverview` and
  `setCollectionControls`, plus `readGithubDistributionSnapshot`,
  `readDistributionAnalytics`, `readAdminDatabaseHealth` and
  `readCachedStorageAdminMetricsHistory`. These are unchanged since
  `d43c8f92`, or behave the same for an unconfigured Cloudflare section.
- The overview, including GitHub distribution, is byte-identical JSON.
- `set_collection_controls` matches the Worker's result, controls row and
  audit rows on success and on a stale revision.
- Database health matches the Worker's DTO shape and statuses.

## Not covered

- The host registration, the admin-host switch and the root's 404 for the six
  ids on the apex. These are D-CRB's.
- Any live Access verification against `tibotattle.cloudflareaccess.com` and
  the origin's egress to it. No request left the machine.
- The three overview blocks without a GCP source. They need an owner decision
  before the overview can answer 200 after the switch.
- Metrics-history capture and warming on GCP, and a GCP reconstruction or
  pipeline progress source.
- The maintenance pass (C-MAINT), GitHub sync, runtime activation, transport
  rollback and v1.1 evidence adoption.
- The admin preview v0.4 and allowance v1.2 catch-up (OD-OAI-3). It waits for
  the production commit. This port is pinned to `d43c8f92`'s v0.3 preview
  validator.
- The D1 schemas used for parity are this checkout's migration directories,
  not `d43c8f92`'s. They lack analytics 0028 to 0033 and typed-ingestion 0005,
  and they add three accountless-transfer migrations and one v1.2 quarantine
  trigger. None of these creates or alters a table these routes read.
- The broad Worker gate (`npm run product:worker:check`) and the
  `postgres:domain:check` suite did not run. The new check and spec are not
  yet registered in `package.json`; the integrator wires them (FC-1).
