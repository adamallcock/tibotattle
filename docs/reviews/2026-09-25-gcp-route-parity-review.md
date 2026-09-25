---
title: GCP cutover route parity review
date: 2026-09-25
type: review
status: snapshot
---

# GCP cutover route parity review

**Status:** source review of candidate `c388769b47b13645cfb41e4f7dd055d75e4bb907`.
The Worker declares 51 exact route contracts. The PostgreSQL Cloud Run test
composition implements a selected subset, and the public GCP gateway exposes
18 of those paths. This is not route parity or cutover approval.

**Scope:** exact paths in `WORKER_ROUTE_POLICY`, their actual Worker dispatch,
the PostgreSQL test dispatcher used by the Cloud Run host, the public OAuth
gateway allowlist, existing local/browser callers, and nearby source tests.
This review makes no live GCP calls and performs no remote changes. It does not
prove deployed configuration, OAuth credentials, desktop sign-in, historical
data transfer, retention execution, or production behavior.

## What the code does today

The route registry declares the Worker’s exact paths, methods, and authority
classes. The Worker uses it in live request dispatch; route handlers enforce
the authority rules. Its route test compares all 51 entries, rejects retired
paths, and exercises allowed and denied methods. The
Cloud Run test host is a separate implementation: when its PostgreSQL test
dispatcher is configured, `dispatchCloudRunHostRequest` calls that dispatcher
instead of the Worker handler. Unsupported PostgreSQL-host requests therefore
do not fall through to the Worker/D1 implementation.

The public GCP gateway has a separate exact allowlist. It forwards only its 18
listed API paths, and its static-asset fallback rejects every `/api/` path.
Thus a backend route can exist privately while remaining unreachable through
the public test origin. For example, the private PostgreSQL dispatcher has an
envelope-key route, but the public gateway does not expose it.

| `WORKER_ROUTE_POLICY` path (method) | PostgreSQL Cloud Run test backend | Public GCP gateway | Existing caller / use | Cutover disposition |
|---|---|---|---|---|
| `/.well-known/apple-developer-domain-association.txt` (all) | No special route; test dispatcher reports unsupported. Worker intentionally returns 404. | No; static fallback returns 404. | Apple association verification regression contract. | Preserve the intentional 404; do not count it as a missing product feature. |
| `/api/health` (GET) | Yes; checks PostgreSQL schema/migration receipts. | Yes. | Host and service health. | Keep, but document its narrower meaning below. |
| `/api/ready` (GET) | No. | No. | Worker readiness for retention, restore replay, reconciliation, rebuild, and admission. | Batch 1: implement equivalent GCP readiness or a clearly versioned replacement before routing participants. |
| `/api/v1/enroll` (POST) | Conditional on Google enrollment composition/configuration. | Yes. | Browser hosted sign-in/enrollment; local session relay. | Batch 2: configure and prove Google OIDC end to end. |
| `/api/v1/accountless/enrollment` (POST) | Yes, when accountless authority and controls are configured. | No. | Desktop accountless contribution client. | Batch 2: expose through an approved public route and test opt-out/replay behavior. |
| `/api/v1/accountless/ownership` (POST) | Yes, when accountless authority is configured. | No. | Desktop accountless owner setup. | Batch 2: expose and preserve owner/device binding semantics. |
| `/api/v1/accountless/telemetry-v1.2-authorization` (POST) | Yes, when accountless authority is configured. | No. | Desktop v1.2 accountless consent/authorization. | Batch 2: expose and qualify consent and revocation behavior. |
| `/api/v1/accountless/telemetry-performance-authorization` (POST) | No. | No. | Local performance-telemetry flow. | Batch 3: port the performance authorization family, or make and document a product decision to retire it. |
| `/api/v1/accountless/renewal` (POST) | Yes, when accountless authority is configured. | No. | Desktop accountless credential renewal. | Batch 2: expose and test retry/idempotency behavior. |
| `/api/v1/internal/release/appcast` (POST) | No. | No. | Sparkle release publisher guard. | Batch 5: retain a separate protected release lane; it need not be participant-facing. |
| `/api/v1/identity/google/start` (POST) | Conditional on Google handoff composition/configuration. | Yes. | Browser and local-relayed hosted sign-in. | Batch 2: prove state binding, callback, session issuance, and production-equivalent secret handling. |
| `/api/v1/identity/google/callback` (GET) | Conditional on Google handoff composition/configuration. | Yes; callback query is specially forwarded. | Google identity provider redirect. | Batch 2: qualify the real redirect/callback flow. |
| `/api/v1/identity/google/result` (POST) | Conditional on Google handoff composition/configuration. | Yes. | Browser and local-relayed sign-in result exchange. | Batch 2: qualify cookie/CSRF/session behavior. |
| `/api/v1/identity/apple/start` (POST) | No. | No. | Browser hosted sign-in; local relay contract. | Batch 2: port the Apple provider flow or explicitly retire it with client and support changes. |
| `/api/v1/identity/apple/callback` (POST) | No. | No. | Apple provider callback. | Batch 2: port with provider-specific state/signature checks or explicitly retire. |
| `/api/v1/identity/apple/result` (POST) | No. | No. | Browser hosted sign-in; local relay contract. | Batch 2: port the Apple result exchange or explicitly retire. |
| `/api/v1/session` (GET) | Yes. | Yes. | Browser participant session and local cookie bridge. | Batch 2: keep cookie scope, owner binding, and CSRF contract equivalent. |
| `/api/v1/logout` (POST) | Yes. | Yes. | Browser/local participant logout. | Batch 2: preserve session revocation and cookie clearing. |
| `/api/v1/admin/overview` (GET) | No. | No. | Owner operations dashboard. | Batch 4: port behind owner-only identity and audit controls. |
| `/api/v1/admin/metrics/history` (GET) | No. | No. | Owner operations/history dashboard. | Batch 4: port or replace with a reviewed GCP operational view. |
| `/api/v1/admin/community/allowance-preview` (GET) | No. | No. | Owner community/allowance preview. | Batch 4: port only with the allowance producer/cache contract. |
| `/api/v1/admin/database-health` (GET) | No. | No. | Owner database diagnostics. | Batch 4: port using separate, redacted health output. |
| `/api/v1/admin/reconstruction-progress` (GET) | No. | No. | Owner analytics reconstruction/publication progress. | Batch 4: port the progress contract and publication gates. |
| `/api/v1/admin/action` (POST) | No. | No. | Owner maintenance, controls, publication, and confirmed erasure actions. | Batch 1: required operational/privacy lane; preserve Access-owner, CSRF, explicit-target, journal, and audit guarantees before real data moves. |
| `/api/v1/me/security-reset` (POST) | No. | No. | Participant session/security recovery contract. | Batch 2: preserve recovery and session invalidation semantics. |
| `/api/v1/me/device-pairings` (POST) | Yes. | Yes. | Browser participant session issues device pairing. | Batch 2: keep owner/session/CSRF checks and test real client flow. |
| `/api/v1/device-pairings/claim` (POST) | Yes. | Yes. | Desktop device claims a browser-issued pairing. | Batch 2: preserve single-use pairing, device binding, and retry behavior. |
| `/api/v1/device/upload-authorizations` (POST) | Yes, but validates the v1.2 telemetry schema. | Yes. | Desktop upload client. | Batch 3: keep v1.2 and add format-specific support for older accepted clients. |
| `/api/v1/device/disconnect` (POST) | Yes. | No. | Desktop device disconnect/opt-out. | Batch 2: expose and prove revocation reaches accountless and social data paths. |
| `/api/v1/device/credential/renew` (POST) | Yes. | Yes. | Desktop device secret rotation. | Batch 2: retain the same-device, no-new-slot contract and test renewal after retries. |
| `/api/v1/device/sync/state` (GET) | Yes; PostgreSQL typed v1.2 path. | Yes. | Desktop incremental sync. | Batch 3: preserve generation, authority, tombstone, and replay checks. |
| `/api/v1/device/sync-capabilities` (GET) | Yes as a capability read, but this alone is not v1.1 ingestion support. | No. | Desktop v1.1 sync negotiation. | Batch 3: port the matching format’s complete upload/read lifecycle. |
| `/api/v1/device/sync-capabilities-v1.2` (GET) | Yes. | Yes. | Desktop v1.2 sync negotiation. | Batch 3: keep and prove against the production client. |
| `/api/v1/device/telemetry/performance/capabilities` (GET) | No. | No. | Local performance telemetry client. | Batch 3: port with its separate data and consent contract, or retire explicitly. |
| `/api/v1/me/device-telemetry-performance-consents` (POST) | No. | No. | Browser grants performance telemetry consent. | Batch 3: port or remove the corresponding UI and local behavior by an explicit decision. |
| `/api/v1/device/telemetry/performance/reports` (GET, POST) | No. | No. | Local performance telemetry upload/read client. | Batch 3: port the full read/write and retention behavior, or retire explicitly. |
| `/api/v1/me/device-telemetry-consents` (POST) (v1.1) | No. | No. | Browser grants legacy v1.1 attribution consent. | Batch 3: support existing v1.1 consent or define a reviewed migration to v1.2. |
| `/api/v1/me/device-telemetry-v12-consents` (POST) | Yes. | Yes. | Browser grants v1.2 attribution consent. | Batch 2: preserve authenticated session, CSRF, origin, and revocation checks. |
| `/api/v1/device/telemetry/v1.1/day-manifests` (GET, POST) | No. | No. | Desktop v1.1 history sync. | Batch 3: port v1.1 manifest reads/writes and its historical-format policy. |
| `/api/v1/device/telemetry/v1.2/day-manifests` (GET, POST) | Yes. | POST only. | Desktop v1.2 sync stages each day with POST. | Batch 3: preserve both declared methods or prove and record why GCP may intentionally omit GET. |
| `/api/v1/me/telemetry-v11/domain-predecessor` (POST) | No. | No. | Desktop v1.1 domain sync. | Batch 3: port v1.1 predecessor/checkpoint behavior before moving these clients. |
| `/api/v1/me/telemetry-v11/domain-activate` (POST) | No. | No. | Desktop v1.1 domain activation. | Batch 3: port atomic activation and retry semantics. |
| `/api/v1/me/telemetry-v12/domain-predecessor` (POST) | Yes. | Yes. | Desktop v1.2 domain sync. | Batch 3: preserve predecessor pinning and authorization. |
| `/api/v1/me/telemetry-v12/domain-activate` (POST) | Yes. | Yes. | Desktop v1.2 domain activation. | Batch 3: preserve atomic commit and replay behavior. |
| `/api/v1/device/sync/manifest` (GET) | Yes. | No. | Desktop incremental reconciliation when sync-state digest differs. | Batch 3: expose and retain bounded date windows and digest reconciliation. |
| `/api/v1/me/devices` (GET) | Yes. | No. | Participant device inventory and owner-erasure tooling. | Batch 1: port participant self-service and make it available on the public origin. |
| `/api/v1/me/devices/revoke` (POST) | Yes. | No. | Participant device revocation and owner-erasure tooling. | Batch 1: port CSRF, owner scoping, tombstone check, and revocation. |
| `/api/v1/envelope-key` (GET) | Yes. | No. | Desktop attribution and performance clients fetch the encryption key before upload. | Batch 3: expose; without it the public client cannot prepare an envelope even though upload routes are listed. |
| `/api/v1/contributions` (POST) | v1.2 chunk upload only; older v0.1–v1.1 payloads are not accepted by this GCP dispatcher. | Yes. | Desktop v1.1/v1.2 attribution contribution transport. | Batch 3: implement every still-supported schema or explicitly migrate/retire each client before switching the origin. |
| `/api/v1/me/export` (GET) | No. | No. | Participant data export; used by privacy and owner-erasure workflows. | Batch 1: port a complete owner-scoped inventory export before moving participant data. |
| `/api/v1/community/daily` (GET) | Private implementation exists but returns a reduced activity/spend projection and marks allowance as updating. | No. | Public community dashboard. | Batch 4: expose only after complete analytics and allowance parity; current private handler is not full public parity. |

## Ranked implementation batches

1. **Privacy and operational controls.** Port the readiness contract, participant
   export/device inventory/revocation, retention/reconciliation, restore replay,
   and owner-confirmed erasure across PostgreSQL and GCS. The existing
   `/api/v1/admin/action` boundary is absent from the GCP dispatcher; merely
   having a separate deletion ledger does not implement the Worker’s owner
   erasure pipeline. Preserve the repository’s distinction between retired
   self-service deletion and required owner-only erasure.
2. **Authentication and device lifecycle.** Complete Google enrollment and
   sign-in; preserve session/CSRF/cookie rules; implement or explicitly retire
   Apple sign-in; expose accountless enrollment, ownership, v1.2 authorization,
   renewal, disconnect, device management, and security reset through a reviewed
   public boundary. A private backend handler is not enough for desktop clients.
3. **Telemetry format and encryption parity.** Add the public envelope-key read,
   then support each still-accepted contribution generation (including v1.1 and
   v1.2) with its own consent, capabilities, manifests, domain activation,
   upload, reconciliation, retries, and retention. Keep performance telemetry
   separate unless the product explicitly retires that family. The current
   PostgreSQL contribution route is specifically v1.2; route-name equality does
   not establish format compatibility.
4. **Operations and publication surfaces.** Port the six admin routes behind
   owner-only auth and audit, including confirmed maintenance/erasure actions;
   complete community daily and allowance publication before exposing the
   public community API. The current GCP daily reader is intentionally reduced,
   and the public gateway does not forward it.
5. **Release-only and retired paths.** Keep the Sparkle guard in a distinct
   protected release service or intentionally redesign its contract. Preserve
   the retired Apple association path’s 404. These are separate from participant
   data-plane cutover.

These are source-coverage batches, not authorization to enable participant
traffic. A narrower GCP launch would need an explicit product scope that names
which existing routes and formats are intentionally unsupported and updates the
desktop/browser behavior accordingly.

## Source and test evidence

- [`route-registry.ts`](../../apps/worker/src/route-registry.ts#L24) declares the
  exact paths, methods, and authority classes. [`route-registry.spec.ts`](../../apps/worker/test/route-registry.spec.ts#L319)
  pins the full list at 51 entries, checks exact matching and retired routes,
  and sends allowed and denied methods through `handleRequest`.
- [`index.ts`](../../apps/worker/src/index.ts#L4228) dispatches every registry id
  to a Worker handler. Its `/api/ready` checks retention, restore replay,
  reconciliation, maintenance-cycle matching, and rebuild state
  ([`handleReady`](../../apps/worker/src/index.ts#L4162)).
- [`postgres-test-dispatch.mjs`](../../apps/worker/cloud-run/postgres-test-dispatch.mjs#L143)
  shows that configured PostgreSQL test dispatch bypasses the Worker handler.
  The Cloud Run composition selects concrete community, session, pairing,
  participant-device, v1.2-consent, Google-enrollment, and Google-handoff
  dispatchers before falling through to the private v1.2 dispatcher
  ([`server.mjs`](../../apps/worker/cloud-run/server.mjs#L645)). The latter
  recognizes its explicit health, v1.2, device, accountless, and envelope-key
  route set ([`postgres-test-dispatch.mjs`](../../apps/worker/cloud-run/postgres-test-dispatch.mjs#L1980)).
- [`oauth-gateway.mjs`](../../apps/worker/cloud-run/oauth-gateway.mjs#L25)
  contains the 18 public API routes. Its asset fallback refuses `/api/` paths
  ([same file](../../apps/worker/cloud-run/oauth-gateway.mjs#L214)), and its
  request handler returns 404 when neither the exact route table nor static
  assets match ([same file](../../apps/worker/cloud-run/oauth-gateway.mjs#L619)).
- Nearby behavior tests include
  [`host.check.mjs`](../../apps/worker/cloud-run/host.check.mjs#L383) for health,
  community, personal session/device and PostgreSQL dispatch boundaries, and
  [`oauth-gateway.check.mjs`](../../apps/worker/cloud-run/oauth-gateway.check.mjs#L288)
  for public forwarding and refusal of unlisted API routes. These tests establish
  source behavior only; this review did not execute them.
- Existing callers confirm why path overlap is insufficient:
  [`telemetry-v11-sync.js`](../../src/contribution/telemetry-v11-sync.js#L43)
  retains v0.1 through v1.1 formats,
  [`telemetry-v12-sync.js`](../../src/contribution/telemetry-v12-sync.js#L48)
  adds v1.2, and
  [`telemetry-sync-protocol.js`](../../src/contribution/telemetry-sync-protocol.js#L646)
  issues the day manifest, upload authorization, and chunk-upload sequence.
  The incremental v1.0 client reads `/api/v1/device/sync/manifest`
  ([`contribution-incremental-sync.js`](../../src/contribution-incremental-sync.js#L1071)).
- Browser/local callers are visible in
  [`data-client.js`](../../apps/web/public/data-client.js#L9),
  [`participant-relay-routes.js`](../../apps/local/transport/participant-relay-routes.js#L9),
  and [`accountless-contribution.js`](../../apps/local/accountless-contribution.js#L23).
  The owner UI directly calls the admin routes from
  [`admin.js`](../../apps/web/public/admin.js#L3739); the public community client
  calls `/api/v1/community/daily` from
  [`community-data.js`](../../apps/web/public/community-data.js#L872).

## Live-proof boundary

This review establishes no live route response. Passing source checks, a ready
Cloud Run revision, static page rendering, or an IAM-private PostgreSQL health
response cannot substitute for route-by-route public client testing. In
particular, the Worker `/api/ready` semantics, real Google/Apple sign-in, every
supported telemetry generation, admin/erasure flows, historical-data
reconciliation, and full community publication remain separate live gates.
