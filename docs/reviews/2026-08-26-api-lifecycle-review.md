---
title: TiboTattle API lifecycle and redundancy review
date: 2026-08-26
last_reviewed: 2026-08-27
type: review
status: implemented-in-source
---

# TiboTattle API lifecycle and redundancy review

## Outcome

The seven approved API-lifecycle actions are implemented in repository source.
The result is a smaller, exact surface without weakening current telemetry v1,
account deletion, native-shell, or local-monitoring contracts:

| Boundary | Before | After | Source authority |
|---|---:|---:|---|
| Loopback API | 32 paths / 35 operations | 23 paths / 26 operations | [`apps/local/server.js`](../../apps/local/server.js) |
| Direct local report pages | 4 `GET` paths | 4 `GET` paths | [`src/local-companion-data.js`](../../src/local-companion-data.js) |
| Credential-free central relay | 5 paths | 1 health path | [`src/local-companion-central-proxy.js`](../../src/local-companion-central-proxy.js) |
| Participant browser relay | 20 paths / 21 operations | 9 paths / 9 operations | [`participant-relay-routes.js`](../../apps/local/transport/participant-relay-routes.js) |
| Hosted Worker API | 38 paths / 39 operations | 31 paths / 31 operations | [`route-registry.ts`](../../apps/worker/src/route-registry.ts) |
| Accounting package root | 47 symbols | 27 symbols | [`packages/accounting/index.js`](../../packages/accounting/index.js) |
| Quota-analysis package root | 39 symbols | 32 symbols | [`packages/quota-analysis/index.js`](../../packages/quota-analysis/index.js) |

The complete post-retirement inventories and diagrams live in the
[canonical API surface reference](../reference/2026-08-26-api-surface-reference.md).
Its contract test derives route policies and package exports from source, so
the table above cannot silently become a second, stale API definition.

This is a **source implementation result**, not a production-deployment or
installed-release claim. No Worker was deployed, no release was published, and
no hosted database row was changed as part of this lifecycle work.

## Why current usage was directly checkable

The repository is authoritative for current systems, and the only possible
additional callers are older TiboTattle apps. The review therefore checked:

- current browser, native, local companion, synchronization, CLI, operator,
  scheduled Worker, and package-import call sites;
- exact route and relay registries, WebKit messages, socket frames, subprocess
  requests, and runtime bindings;
- public `v0.1.x` tags, dogfood RC tags, and inspected installed app bundles;
- telemetry v1, legacy/synthetic tables, local settings, and Keychain
  generations as durable compatibility state.

An allowlist entry proves only that a request *could* be forwarded. It does not
prove that current product code constructs that request. Conversely, the
absence of a source caller does not authorize deleting durable state: an older
installation or hosted row can outlive the code that created it. The
implementation uses migration/tombstone boundaries where that distinction
matters.

## The seven completed actions

### 1. Remove nonexistent browser probes

The dashboard no longer probes `GET /api/local/v1/status` or
`GET /api/local/v1/dashboard` before falling back to real routes. Neither path
has existed in the current server or any inspected tag. Removing the requests,
comment, and probe-only expectation eliminates two guaranteed failures per page
load without adding misleading compatibility aliases.

### 2. Retire the unused local contribution preview

`GET /api/local/contribution/preview`, its provider seam, browser wrapper, and
route-only tests are removed. It had no current or tagged browser/native caller
and its default provider returned `not_configured`. The distinct live review
contract remains `POST /api/local/contribution/sync-next`, with exact-byte
inspection at `POST /api/local/contribution/sync-inspect-exact`.

### 3. Remove exact hosted aliases

The two aliases with no current or tagged caller are absent from the Worker,
relays, browser wrappers, smoke tooling, and route contracts:

- `GET /api/v1/community/insights`, formerly an exact alias of the legacy
  community aggregate; and
- `GET /api/v1/me/insights`, formerly an exact alias of personal legacy
  statistics.

No replacement alias was introduced. Current community UI uses
`GET /api/v1/community/daily`.

### 4. Retire legacy hosted recovery, authorization, and statistics routes

The following exact Worker routes are removed:

| Retired route | Reason |
|---|---|
| `POST /api/v1/recover` | Hosted identity configuration rejected recovery before consuming the capability; no current caller |
| `POST /api/v1/me/upload-authorizations` | Session-backed authority for the old upload path; current sync mints device-scoped authority |
| `POST /api/v1/me/contributions/read` | Legacy `contribution:<uuid>` subset, not current telemetry v1 chunks |
| `POST /api/v1/me/contributions/delete` | Same legacy identifier/table restriction; whole-account deletion remains v1-aware |
| `GET /api/v1/me/stats` | Legacy personal statistics with no current caller |
| `GET /api/v1/stats/aggregate` | Legacy weekly aggregate; current product reads the v1 daily series |

`GET /api/v1/me` is also removed from the shared route definition. Its current,
v1-aware `DELETE /api/v1/me` method remains exact and live. Contribution intake
now accepts only a device-minted, one-use Upload authority; session-backed
minting is no longer an alternate authority path.

The participant browser relay was narrowed at the same boundary. It now
contains only enrollment; Google/Apple start and result; session; logout;
`DELETE /api/v1/me`; and device-pairing creation. The central browser relay is
health-only. Hosted export, security-reset, device-list, and selected-device
revocation handlers remain in the Worker but are no longer browser-relay
permissions; retaining a Worker handler is distinct from granting loopback UI
reachability.

### 5. Remove unused local wrappers and quota/report-index runtime work

The following loopback routes and browser projections are removed:

- `GET /api/local/claude/quota`, together with its shipping refresh/state
  chain and two dedicated tests;
- `GET /api/local/reports` and the unused browser report-index projection;
- `POST /api/local/contribution/sync-once`;
- `POST /api/local/contribution/sync-pause` and `sync-resume`; and
- automatic settings, enable, and disable HTTP controls.

The four fixed direct report pages remain intentionally available:

- `GET /reports/gradient`;
- `GET /reports/weekly`;
- `GET /reports/quality`; and
- `GET /reports/multi-surface`.

There is no general report directory, listing payload, or reports API. Claude
status-line/transcript support remains local-only and does not call Anthropic.
The separate hard-disabled Claude shadow qualification pipeline is not a
shipping quota route.

### 6. Narrow private workspace package roots

Repository-wide production-consumer analysis supported de-exporting 27 symbols
without introducing package subpath imports. The accounting root removed 20:

`aggregateCostResults`, `ANTHROPIC_OFFICIAL_PRICE_CARDS`,
`APP_PRICE_REGISTRY_OBSERVED_AT`, `APP_PRICE_REGISTRY_SHA256`,
`APP_PRICE_REGISTRY_VERSION`, `NORMALIZED_PRICE_EVIDENCE_ROWS`,
`OFFICIAL_PRICE_SOURCE_URLS`, `OPENAI_LONG_CONTEXT_SOURCE_URLS`,
`OPENAI_OFFICIAL_PRICE_CARDS`, `PROVIDER_TOOL_PRICE_CARDS`,
`addOfficialPriceRegistry`, `validateOfficialPriceRegistry`,
`FAST_MODE_RESIDUAL_INFERENCE_REASON_CODES`,
`FAST_MODE_RESIDUAL_INFERENCE_THRESHOLDS`,
`SPEED_MODE_PROVENANCE_VALUES`, `fastModeModelFamily`,
`quotaWeightedApiPriceEquivalent`, `LOCAL_API_PRICING_METHOD_VERSION`,
`codexProviderBillableToolUnits`, and `summarizeClaudeApiPriceRecords`.

The quota-analysis root removed seven:

`QUOTA_TRACK_POLICY`, `forecastCapacityFromPriorResets`,
`QUOTA_ROLLING_POLICY`, `QUOTA_PACE_POLICY`,
`solveNonNegativeLeastSquares`, `selectPrimaryQuotaWindow`, and
`SUPPORTED_QUOTA_WINDOW_DURATIONS`.

The resulting 27- and 32-symbol contracts are listed exactly in the canonical
reference and mirrored by their TypeScript declarations. Helpers still needed
inside a package remain private implementation details.

### 7. Migrate durable state, consolidate Keychain, and remove legacy shims

Three stateful cleanups were completed behind explicit compatibility controls.

#### Automatic-contribution state

Before accepting requests, the companion takes the historical scheduler's
single-instance lock and atomically replaces settings schemas v0.1 through v0.4
with `automatic-contribution-retired-v1`. The mode-0600 tombstone contains only
`retiredAt`, coarse `priorState`, and `networkActivity: false`; queue and
prepared-set paths are outside this boundary and remain untouched. The write is
idempotent and fails closed on unsafe modes, symlinks, or unavailable state.
Its schema is deliberately unknown to old scheduler builds, so a downgrade
cannot silently resume an enabled legacy uploader. Incremental telemetry v1 is
the sole remaining contribution scheduler.

#### Closed Keychain migration

The packaged macOS app now owns a protocol-v2 broker with an exact four-value
capability map: export identity, account observation, Claude-session pseudonym,
and contribution device. The current packaged-companion runtime graph consumes
the export-identity, account-observation, and contribution-device mappings;
Claude callback remains a standalone CLI/local-review composition. The wire
never accepts service/account strings. For each broker capability the signed
app:

1. reads the app-owned `.app.v1` generation first;
2. probes the fixed legacy `.v1` item without prompting;
3. permits at most one interactive legacy read per capability and process;
4. writes and reads back the exact secret in the app-owned item; and
5. deletes the legacy item only after verified migration.

Denial returns `migration_required` and preserves the legacy secret. The broker
will not prompt that capability again in the same app process. The UI tells the
user to quit and reopen TiboTattle before approving again; that process restart
is the sole retry boundary, and reset or deletion is never offered. Export
identity, account observation, Claude-session pseudonym, and contribution
device adapters all preserve a fixed, content-free migration-required code for
operator diagnosis. Protocol v1 remains accepted only for the historical
contribution-device-only client. The packaged runtime dependency closure no
longer contains `@github/keytar`; the standalone Claude callback and other
CLI/local-review compositions retain the audited keytar backend.

#### Source-owner composition and shims

The new [`src/local-node-runtime.js`](../../src/local-node-runtime.js) is the
single Node composition root for the local server and migrated callers. Nine
flat compatibility shims and five compatibility internals were deleted after
their callers moved to reviewed owner facades:

- flat shims: `codex-log-scan.js`, `contribution-sync-queue.js`,
  `export-checkpoint-state.js`, `export-deletion-schema.js`,
  `export-safe-records.js`, `export-set-materializer.js`,
  `export-workspace-lock.js`, `export-workspace.js`, and
  `metadata-exporter.js`;
- internals: export-deletion, export-source-pipeline, export-workspace,
  export-workspace-discard, and export-workspace-lock compatibility modules.

Architecture checks continue to require entry through the 24 reviewed
source-owner entrypoints. This is consolidation of ownership, not deletion of
the underlying export or contribution capabilities.

## Hosted historical-data gate

Handler retirement does not prove that historical D1 rows are absent. The
ordered migrations, legacy columns, and dormant data helpers remain in source
until an authorized owner runs the read-only production checks in
[`2026-08-27-hosted-api-retirement-data-gates.md`](../runbooks/2026-08-27-hosted-api-retirement-data-gates.md).

That runbook checks the legacy recovery/session-upload/contribution/statistics
planes without modifying them. Only a separately authorized, backed-up,
forward-only migration may remove historical schema. This source change had no
Cloudflare API token and therefore makes no claim about live row counts,
deployed route revision, or remote resource inventory.

Cloud Run and GCS were removed separately after explicit authorization. The
Cloudflare Worker, its D1/R2/Durable Object bindings, and current telemetry v1
path are unrelated and remain deliberate TiboTattle systems.

## Deliberately retained surfaces

The cleanup preserves boundaries with current callers or unique product value:

- all 23 routes in the current local inventory, including health,
  diagnostics, dashboard projections, refresh, exact contribution review,
  device pair/disconnect/reset, incremental v1 controls, and fast-mode
  preference;
- all four direct local HTML report pages, with no index payload;
- `DELETE /api/v1/me` and the telemetry-v1 daily community series;
- Worker hosted export, security reset, device listing/revocation, direct
  device sync, identity handoff, admin, appcast, and readiness boundaries;
- every WKWebView message/DOM event, the native launch/READY and custom-URL
  contracts, and protocol-v2 Keychain `get`, `set`, and `delete`;
- Codex app-server, ccusage diagnostic, Claude callback, rebuild child, and
  local-index worker protocols;
- D1, R2, upload-budget Durable Object, assets, cron, and rate-limit bindings;
- all 37 JSON schema/contract files, code-defined telemetry v1, 43 ordered
  hosted SQL migrations, and the 12 current local SQLite storage owners; and
- the local-analysis legacy rollback lane until its separate dominance,
  installed-refresh, coverage, and performance gates are satisfied.

Dependency upgrades, schema-authority generation, disabled experiment
packaging, Windows qualification classification, and product decisions about
surfacing hosted export/device/security controls remain separate maintenance
work. They were not silently folded into these seven lifecycle actions.

## Verification contract

Every future API lifecycle change must update the authoritative source and the
canonical inventory together. Run:

```bash
npm run docs:api:check
npm run docs:links:check
```

Then run the owning local, Worker, browser, native, package, architecture, and
artifact lanes in proportion to the changed boundary. Green source tests do
not establish a deployed Worker, migrated production database, signed app,
published appcast, or installed-release journey.
