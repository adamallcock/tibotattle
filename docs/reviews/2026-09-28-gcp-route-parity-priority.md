---
title: GCP route parity and next-slice priority
date: 2026-09-28
type: review
status: point-in-time
---

# GCP route parity and next-slice priority

## Scope and claim boundary

This source review compares the Cloudflare Worker route registry with the GCP private PostgreSQL test host and its public gateway. The audited isolated branch is `codex/gcp-public-accountless-routes` at `006506a342162313211516f83436ee521ea06837`. The separate integration candidate `b0687071` has the same route sets; it adds a fail-closed v1.1 capability projection in `apps/worker/src/postgres-device-sync.ts` that reports accepted v1.1 as blocked because the PostgreSQL v1.1 write path is not qualified. It does not add the missing v1.1 routes.

These are source and test findings, not a live route probe, production deployment, migration, or cutover qualification. The private dispatcher is explicitly test-only and bypasses the Worker handler (`apps/worker/cloud-run/postgres-test-dispatch.mjs:143-151`); its GCP target is constrained to a named test host and test schemas (`apps/worker/cloud-run/postgres-test-dispatch.mjs:29-49`). The gateway is configured for that same test backend and requires test-only mode (`apps/worker/cloud-run/oauth-gateway.mjs:11,769-797`). Therefore “public gateway” below means source-allowlisted at the GCP test edge, not proven reachable from a deployed public service.

## Route census

Counts are unique pathnames, not HTTP method combinations. The Worker registry has 51 entries, including one retired Apple association path that deliberately returns 404; the registry test pins the exact list and count (`apps/worker/src/route-registry.ts:24-343`, `apps/worker/test/route-registry.spec.ts:319-323`). The gateway has 28 path entries (`apps/worker/cloud-run/oauth-gateway.mjs:43-223`). The private GCP dispatcher recognizes 30 paths in its route constants and host composition (`apps/worker/cloud-run/postgres-test-dispatch.mjs:10-18,1094-1110,1984-2017`, `apps/worker/cloud-run/server.mjs:649-678`).

| Surface | Path count | Relationship |
|---|---:|---|
| Cloudflare Worker registry | 51 (50 API paths plus one retired path) | Source authority for the Worker route inventory |
| GCP private PostgreSQL test host | 30 | 29 Worker API paths plus one internal v1.2 effective-page path |
| GCP public gateway source map | 28 | Every mapped path is also in the Worker registry and private test host |

Of the 50 Worker API paths, 21 are absent from the private GCP host and 22 are not exposed by the gateway. The extra gateway gap is the v1.1 capability route, which the private test host recognizes but the gateway intentionally does not allow. The private-only internal effective-page route is not in the Worker registry and is not gateway-exposed. The retired `.well-known` path is excluded from API gap counts because the Worker intentionally returns 404 for it.

The 21 API paths missing from both GCP surfaces are: `/api/ready`; `/api/v1/admin/overview`, `/api/v1/admin/metrics/history`, `/api/v1/admin/community/allowance-preview`, `/api/v1/admin/database-health`, `/api/v1/admin/reconstruction-progress`, `/api/v1/admin/action`; `/api/v1/identity/apple/start`, `/api/v1/identity/apple/callback`, `/api/v1/identity/apple/result`; `/api/v1/internal/release/appcast`; `/api/v1/me/export`; `/api/v1/me/security-reset`; the v1.1 family `/api/v1/me/device-telemetry-consents`, `/api/v1/device/telemetry/v1.1/day-manifests`, `/api/v1/me/telemetry-v11/domain-predecessor`, `/api/v1/me/telemetry-v11/domain-activate`; and the performance family `/api/v1/accountless/telemetry-performance-authorization`, `/api/v1/device/telemetry/performance/capabilities`, `/api/v1/me/device-telemetry-performance-consents`, `/api/v1/device/telemetry/performance/reports` (GET/POST).

## Journey matrix

| Journey | Worker | GCP private PostgreSQL host | GCP gateway source | Assessment |
|---|---|---|---|---|
| Health and readiness | `/api/health` and `/api/ready` | `/api/health` only | `/api/health` only | Health is not readiness parity. The PG host test reports `workerApplicationReady: false`; there is no GCP equivalent of Worker `/api/ready` in this host (`apps/worker/cloud-run/host.check.mjs:2614-2619`). |
| Public community daily read | Present | Present | Present | Route is source-implemented and contract-tested. PostgreSQL currently returns an activity/spend projection with `allowanceState: "updating"`; allowance fit and capacity are not ported (`postgres-test-dispatch.mjs:388-408`). The web normalizer accepts this state and omits allowance breakdowns (`apps/web/public/community-data.js:693-729`). The gateway accepts ranges up to 366 days but caps response bodies at 8 MiB; the publisher bound is 91.5 MiB for a dense 366-day range, so full-year production-size parity remains open (`oauth-gateway.mjs:36-42`). At the parent-reported test setting of 256 MiB and concurrency 4, this is up to 32 MiB of raw response buffers before decoding/parsing; that setting was not re-read in this source audit, and memory/concurrency profiling is still required. |
| Accountless device lifecycle | Present | Present | Present | Enrollment, ownership, v1.2 authorization, renewal, and disconnect are all represented at the edge and private host. The gateway enforces closed methods/bodies and rejects cookies on bearer routes (`oauth-gateway.mjs:186-223`); the host tests cover synthetic accountless lifecycle paths. This is source/test evidence only. |
| Desktop v1.2 sync and upload | Present | Present | Present | Sync state, v1.2 capability, predecessor, day-manifest read/write, upload authorization, contribution upload, activation, envelope key, credential renewal, and v1.2 consent are mapped across the three source surfaces (`src/contribution/telemetry-v12-sync.js:50-57`, `oauth-gateway.mjs:122-185`, `postgres-test-dispatch.mjs:1094-1109,1984-2017`). Gateway and host checks exercise the route contracts and synthetic PostgreSQL cases; this review does not prove a currently deployed full desktop journey. |
| Google sign-in, session, pairing, and device management | Present | Present in conditional test dispatches | Present | Source routes include Google handoff, session/logout, pair/claim, device listing/revoke, and v1.2 consent. The private host composes these test dispatches conditionally (`server.mjs:653-675`). This is not evidence of a production identity integration. |
| v1.1 sync | Present | Capability path only | Hidden | Worker has a v1.1 capability, consent, predecessor, day-manifest, and activation family (`route-registry.ts:224-288`; desktop paths in `telemetry-v11-sync.js:45-52`). The GCP private host recognizes the capability path, but lacks the rest of the v1.1 family; the public gateway hides that capability. The next-image candidate additionally maps accepted v1.1 to blocked. Keep the capability hidden until the entire supported v1.1 family, including shared upload authorization/contribution semantics, is implemented and tested together. |
| Operator, privacy, Apple identity, and performance routes | Worker-only | Missing | Missing | The GCP surfaces do not implement Worker readiness, six admin routes, Apple identity handoff, internal appcast, participant export/security reset, or the performance authorization/consent/capabilities/reports family. These are not all ordinary user routes, but readiness and owner privacy operations remain cutover requirements; privileged admin actions must stay separately protected. |

The gateway's exact path allowlist is closed: unlisted paths do not proxy (`oauth-gateway.mjs:343-386`). Device and accountless routes intentionally reject browser cookies and require their scoped bearer authorization; the public daily GET does not forward browser cookies or Authorization. These edge checks narrow input and avoid mixing browser sessions with device authority; they are not route-parity regressions. The route-scoped bodyless disconnect handling now matches the Worker/private refusal for a declared nonzero body. The remaining daily response cap is a real compatibility limit for dense full-year results.

## Priority

The smallest next end-to-end vertical slice is the **public community daily read, from the GCP gateway through PostgreSQL to the rendered web page**. The route already exists at all three source layers and needs no participant identity. Use the existing approved synthetic publication/source and verify one published day; if it is unavailable, obtain separate authorization for a minimal test fixture rather than treating an empty result as proof. Verify the reduced `updating` allowance state in the actual page, safe failure when PostgreSQL is unavailable, and the 8 MiB edge limit. A separate dense 366-day payload and memory/concurrency measurement must resolve the 91.5 MiB publisher bound before describing full-window parity.

After that read slice, qualify one accountless v1.2 desktop day-sync against an exact immutable GCP test image, including enrollment/ownership, authorization, manifest and upload, replay behavior, disconnect, exact cleanup, and safe receipts. The route matrix is not sufficient to claim this journey works as a single deployed transaction. Do not expose v1.1 capability while its dependent path family is absent. Before cutover, also close the missing readiness, owner-export/erasure, and required operator-maintenance paths or document an approved operational replacement for each.
