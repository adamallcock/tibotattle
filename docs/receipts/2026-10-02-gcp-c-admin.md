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
host.

OD-CR-3 keeps the admin host refused (503 `POSTGRES_ROUTE_NOT_PORTED`) until
the admin routes are ported. By default this port leaves the overview,
metrics history, reconstruction progress, the maintenance pass and the GitHub
sync unavailable, and the console cannot act while the overview is
unavailable (see [the cutover blocker](#cutover-blocker-the-console-is-unusable-while-the-overview-is-503)).
Whether that counts as "ported" is an open owner question. D-CRB registers
this family behind the chokepoint only after the owner confirms that the
admin host may leave refusal in this state, or after the missing sources
exist (see [Open owner questions](#open-owner-questions)).

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
| `d0b8449f` | The first revision of this receipt |
| the review-fix commit that carries this revision | Review fixes: the analytics role defaults to the primary pool, new ingress and preview-age spec cases, the composition negative tests, and this revision, which escalates the console blocker and the open owner questions |

## What is ported

The six ids are the `authority: "admin"` entries of `WORKER_ROUTE_POLICY`
(`src/route-registry.ts`), pinned by the check.

| Route | GCP answer | Source |
|---|---|---|
| `GET /api/v1/admin/overview` | The full `admin-overview-v0.5` typed body, in the Worker's key order, or the Worker's 503 when a block has no source (below) | [postgres-admin-overview.ts](../../apps/worker/src/postgres-admin-overview.ts), [postgres-admin-distribution.ts](../../apps/worker/src/postgres-admin-distribution.ts) |
| `GET /api/v1/admin/metrics/history` | 503 `ADMIN_METRICS_HISTORY_CACHE_UNAVAILABLE` unless a reader is injected | No GCP producer warms the history cache |
| `GET /api/v1/admin/community/allowance-preview` | The stored preview in canonical key order, or 503 `ADMIN_ALLOWANCE_STORAGE_UNAVAILABLE` | `analytics_v2_preview`, [postgres-admin-allowance-preview.ts](../../apps/worker/src/postgres-admin-allowance-preview.ts) |
| `GET /api/v1/admin/database-health` | The closed `admin-database-health-v0.1` DTO. The analytics role defaults to the primary pool, because primary migration 0059 places `analytics_v2` there, so both rows report the same database size. An unsupplied ledger role is `not_configured`, which keeps the status `degraded` | [postgres-admin-database-health.ts](../../apps/worker/src/postgres-admin-database-health.ts), [admin-console.mjs](../../apps/worker/cloud-run/routes/admin-console.mjs) |
| `GET /api/v1/admin/reconstruction-progress` | The Worker's query validation, then 503 `BACKEND_STORAGE_UNAVAILABLE` unless a reader is injected | The fast path has no incremental graph pipeline to report |
| `POST /api/v1/admin/action` | `set_collection_controls` is API-complete, but unusable from the console until the overview answers 200. The other actions are listed under "Decided differences" below | [postgres-admin-collection-controls.ts](../../apps/worker/src/postgres-admin-collection-controls.ts), [admin-action.mjs](../../apps/worker/cloud-run/routes/admin-action.mjs) |

The route families and their composition are
[admin-console.mjs](../../apps/worker/cloud-run/routes/admin-console.mjs) and
the modules it imports.

### Cutover blocker: the console is unusable while the overview is 503

With the default composition, `GET /api/v1/admin/overview` answers 503
`BACKEND_STORAGE_UNAVAILABLE` on every request. Three of its blocks have no
GCP source (see "Decided differences"), and the spec case "overview blocks
without a GCP source are the Worker's 503, never zeros" pins that answer.

The admin console UI gates every action on a successful overview read. This
holds in `d43c8f92`'s `src/admin-ui.generated.ts` and in this checkout's copy,
which the thin edge serves:

- A failed overview read sets `state.overviewUnavailable`.
- `renderControlStatus` then disables `#controls-fields`, `#save-controls`,
  `#run-maintenance`, `#sync-distribution` and both v1.1 adoption buttons.
- The controls submit handler returns early.
- `expectedRevision` comes only from `overview.collection.revision`.

So with the overview at 503, the owner cannot change enrollment, upload,
processing or publication containment from the console, even though
`set_collection_controls` itself works over the API (the spec proves it
byte for byte). Metrics history and reconstruction progress are also 503 by
default.

Under OD-CR-2 ("must work at the switch: ... the six admin console routes"),
most of the console therefore does **not** work at the switch. This is a
cutover blocker until the owner answers the open owner questions below.

### Open owner questions

None of these is answered in `owner-decisions-2026-10-02-answers.md`, so this
stream takes none of them.

1. **Overview sources.** Each of these needs a source or an approved
   representation before the overview can answer 200 after the switch:
   - `counts.contributions.synthetic`: the D1 `contributions` table is
     untransferred legacy state.
   - `historicalPublication`: production's per-day model publications and
     graph-preview freshness have no `analytics_v2` counterpart. One
     candidate is a mapping from `analytics_v2_preview`, which would need
     approval.
   - `deletionLedger`, once LEAD-SIMP removes the ledger.
2. **Leaving OD-CR-3 refusal.** Two choices: may the admin host leave
   refusal with the overview, metrics history, reconstruction progress, the
   maintenance pass and the GitHub sync unavailable? Or must it stay refused
   until question 1 is answered and those sources exist? D-CRB waits for this
   answer.
3. **A retired deletion-ledger role in database health.** After LEAD-SIMP,
   `deletion_ledger` reports `not_configured`, which keeps the status
   `degraded` permanently. Reporting it as `not_applicable` instead would
   change the closed DTO's semantics: in the Worker, `not_applicable` means
   the analytics role in json storage mode only.

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
    automatically. **Superseded by C-SIMP-RECON (2026-10-02):** the
    PostgreSQL line has no ledger, so that reader and the `pools.ledger` /
    `ledgerSchema` options are removed (a stale root passing either is
    refused), and `deletionLedger` is served only by an injected source.
    The spec now uses the primary chain only and injects a synthetic
    `deletionLedger` source. See
    [the C-SIMP-RECON receipt](2026-10-02-gcp-c-simp-recon.md).
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
  documents. The vendored validator alone does not bound the preview's age:
  `validCachedAdminCommunityAllowancePreview` in
  `vendor/analytics-d43c8f92/apps/worker/src/admin-community-allowance.ts`
  rejects only a `generatedAt` more than 5 minutes in the future
  ("publication is durable, not a TTL cache"). The spec serves a valid
  preview generated 120 days before the request unchanged, and refuses one
  generated 2 days in the future.
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
| `node --test cloud-run/routes/admin-console.check.mjs` | 24/24 pass (23/23 at `d0b8449f`) |
| `PG_TEST_SOCKET=… PG_TEST_PORT=55433 node --test --test-concurrency=1 postgres-test/postgres-admin-console.spec.mjs` | 10/10 pass (9/9 at `d0b8449f`). Schemas `c_admin_p_*` and `c_admin_l_*` were dropped afterwards; a catalog query confirmed none remain |
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
- The ingress block runs the Worker's `readUploadIngressStatus` over the
  PostgreSQL budget binding in the shape `cloud-run/server.mjs` composes, with
  the production origin's ingress policy. A fresh budget and recorded denials
  are served from the PostgreSQL budget row. Seven malformed or failing
  statuses or bindings degrade the block to `null`. In every case the rest of
  the overview is byte-identical to the Worker's.
- `set_collection_controls` matches the Worker's result, controls row and
  audit rows on success and on a stale revision.
- Database health matches the Worker's DTO shape and statuses. Through the
  composition, the analytics role is probed over the primary pool by
  default. An explicit analytics pool is probed as given and never falls back
  to primary, and a missing ledger pool reports `not_configured` and
  `degraded`.

## Not covered

- The host registration, the admin-host switch and the root's 404 for the six
  ids on the apex. These belong to D-CRB, and the admin-host switch waits for
  the owner's answer to open owner question 2.
- Any live Access verification against `tibotattle.cloudflareaccess.com` and
  the origin's egress to it. No request left the machine.
- **Cutover blocker:** the console is unusable at the switch. With the
  overview at 503, the owner cannot operate enrollment, upload, processing or
  publication containment from the console. `set_collection_controls` is
  API-complete, but unusable from the console until the overview answers 200.
  The owner must choose sources or representations for
  `counts.contributions.synthetic` and `historicalPublication`, and for
  `deletionLedger` after LEAD-SIMP, before D-CRB opens the admin host. See
  [Open owner questions](#open-owner-questions) 1 and 2.
- How a retired deletion-ledger role appears in database health (open owner
  question 3).
- The Worker's Durable Object ingress binding. Ingress parity rests on the
  shared `readUploadIngressStatus` and `uploadIngressBudgetStatus` code, not
  on a side-by-side run.
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

## Integration into the final line (2026-10-02)

The integrator merged `31d4e711` into `claude/gcp-fastpath-final` as
`2bb6cb04` (pre-merge head `9700d167`), with no conflicts and no migrations.
The merge broke two gates, and one integration commit fixes both:

- `node ../scripts/cloud-run-build-context.mjs --check` (in the Cloud Run
  check) refused `CLOUD_RUN_CONTEXT_IMPORT_OUTSIDE_CONTEXT`. `cloud-run/routes`
  enters the audited context whole, and three route modules import
  `cloud-run/postgres-family-contract.mjs`, which was not in it. The context
  now carries that file. It passed at `9700d167` and failed at `2bb6cb04`.
- `node scripts/ci-postgres-suite.mjs --plan` refused
  `UNREGISTERED_POSTGRES_SPEC` for the new spec. The spec is now in
  `postgres:domain:check`, and the check runs in the Cloud Run package's
  `check` script (FC-1).

Round 4 of the owner's answers settled the production commit as `d43c8f92`
and moved OAI-3 (allowance v1.2 and preview v0.4) after cutover. The v0.3
preview validator this port pins is therefore production's at the switch.

The integration gates and their results are recorded in the cutover
checklist's C-ADMIN entry. The cutover blocker and the three open owner
questions above are unchanged.
