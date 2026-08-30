---
title: API and Integration Surface
date: 2026-08-27
type: reference
status: maintained
last_verified_commit: 52399658
---

# API and integration surface

This is the maintained inventory of TiboTattle's callable boundaries. Route
method and authority metadata is checked against source by
`test/api-surface-reference.test.js`; descriptions explain the trust and
storage effects that the registry alone cannot express.

This document is an implementation reference, not permission to deploy, call
protected production endpoints, or use private data. Production writes,
migrations, appcast publication, and admin operations remain owner-authorized
actions.

## Authority vocabulary

| Authority | Meaning |
| --- | --- |
| Public | No participant credential; bounded admission and publication controls can still apply. |
| Enrollment | Same-origin enrollment plus the configured identity or invitation proof. |
| Handoff | Short-lived, state-bound hosted identity handoff; provider callbacks terminate at the Worker. |
| Session | Secure, HTTP-only participant session cookie and CSRF on mutations. |
| Device | Rotating device bearer stored by the native app in the platform credential store. |
| Upload | One-use upload authorization bound to a session or device. |
| Pairing code | Short-lived claim code created by an authenticated participant session. |
| Admin | Cloudflare Access assertion, configured owner identity, and revision/CSRF controls where applicable. |
| Operator | Separate owner-held release credential; never exposed to the public app. |
| Loopback read | Loopback peer, exact Host header, fixed path, and no arbitrary proxying. |
| Loopback mutation | Loopback read controls plus same-origin and route-specific token/review checks. |

## Hosted Worker route inventory

The source authority is `apps/worker/src/route-registry.ts`; the handlers in
`apps/worker/src/index.ts` enforce the declared methods and credentials. The
Worker rejects unknown `/api/` paths instead of falling through to the static
site.

| Method | Path | Caller | Authority | Storage or network effect | Owner |
| --- | --- | --- | --- | --- | --- |
| all | `/.well-known/apple-developer-domain-association.txt` | Legacy crawler | None | Always returns 404 so the SPA cannot masquerade as configuration. | Worker |
| `GET` | `/api/health` | App and operator probes | Public | Reads D1, deletion ledger, R2, ingress state, controls, and contract configuration; no mutation. | Worker operations |
| `GET` | `/api/ready` | Deployment probes | Public | Reads lifecycle, retention, reconciliation, and rebuild readiness; no mutation. | Worker operations |
| `POST` | `/api/v1/enroll` | Website or loopback relay | Enrollment | Validates identity/consent, creates or reattaches a D1 participant, and may bootstrap a device pairing. | Identity and contribution |
| `POST` | `/api/v1/internal/release/appcast` | Release publisher | Operator | Authenticated conditional appcast write to R2 with nonce/replay state in D1. | Release operations |
| `POST` | `/api/v1/identity/google/start` | Website or loopback relay | Handoff | Creates a short-lived D1 handoff and returns the Google authorization URL. | Hosted identity |
| `GET` | `/api/v1/identity/google/callback` | Google | Handoff | Exchanges the provider code, verifies identity, and completes the bounded D1 handoff. | Hosted identity |
| `POST` | `/api/v1/identity/google/result` | Initiating client | Handoff | Reads/delivers the state-and-verifier-bound result; proof is later consumed by enrollment. | Hosted identity |
| `POST` | `/api/v1/identity/apple/start` | Website or loopback relay | Handoff | Creates a nonce-bound D1 handoff and returns the Apple authorization URL. | Hosted identity |
| `POST` | `/api/v1/identity/apple/callback` | Apple form post | Handoff | Exchanges and verifies the provider response, then completes the bounded D1 handoff. | Hosted identity |
| `POST` | `/api/v1/identity/apple/result` | Initiating client | Handoff | Reads/delivers the state-and-verifier-bound result. | Hosted identity |
| `GET` | `/api/v1/session` | Website or loopback relay | Session | Reads the current participant session and CSRF projection. | Participant account |
| `POST` | `/api/v1/logout` | Website or loopback relay | Session | Revokes/clears the current web session. | Participant account |
| `GET` | `/api/v1/admin/overview` | Admin application | Admin | Reads bounded operational, distribution, lifecycle, and sampled error evidence. | Operations |
| `GET` | `/api/v1/admin/metrics/history` | Admin application | Admin | Reads bounded operational history. | Operations |
| `GET` | `/api/v1/admin/community/allowance-preview` | Admin application | Admin | Reads unpublished allowance-fit previews; does not publish. | Operations |
| `POST` | `/api/v1/admin/action` | Admin application | Admin | Revision-checked collection controls, maintenance, rebuild, and distribution actions; auditable D1/R2 effects. | Operations |
| `POST` | `/api/v1/me/security-reset` | Participant browser | Session | Rotates session/recovery state and invalidates affected credentials. | Participant account |
| `POST` | `/api/v1/me/device-pairings` | Participant browser | Session | Creates a bounded device-pairing claim in D1. | Device lifecycle |
| `POST` | `/api/v1/device-pairings/claim` | Native app | Pairing code | Claims the pairing and returns the device credential once. | Device lifecycle |
| `POST` | `/api/v1/device/upload-authorizations` | Native app | Device | Creates a one-use upload authorization for a paired device. | Contribution |
| `POST` | `/api/v1/device/disconnect` | Native app | Device | Revokes the current device and stops its hosted upload authority. | Device lifecycle |
| `POST` | `/api/v1/device/credential/renew` | Native app | Device | Rotates the same device credential without creating a new device slot. | Device lifecycle |
| `GET` | `/api/v1/device/sync/state` | Native app | Device | Reads the device's v1 incremental cursor/admission state. | Contribution sync |
| `GET` | `/api/v1/device/sync/manifest` | Native app | Device | Reads a bounded date-range manifest of accepted incremental chunks. | Contribution sync |
| `GET` | `/api/v1/me/devices` | Participant browser | Session | Lists participant device projections without credentials. | Device lifecycle |
| `POST` | `/api/v1/me/devices/revoke` | Participant browser | Session | Revokes a selected device. | Device lifecycle |
| `GET` | `/api/v1/envelope-key` | Native or web client | Public | Returns the public wrapping key; never returns private key material. | Contribution crypto |
| `POST` | `/api/v1/contributions` | Prepared uploader | Upload | Validates and deduplicates an encrypted contribution, writes D1 state and quarantined R2 object data, and schedules aggregation. | Contribution ingestion |
| `GET` | `/api/v1/me/export` | Participant browser | Session | Returns a bounded export of the participant's hosted data. | Participant data |
| `GET` | `/api/v1/community/daily` | Website | Public | Reads a bounded published daily range and omits unavailable allowance evidence. | Community publication |
| `DELETE` | `/api/v1/me` | Participant browser | Session | Performs the participant deletion lifecycle and tombstone flow. | Participant account |

Production admin API and UI paths are served only on the configured admin host.
Public-host requests to those paths are deliberately 404. Static site assets
are not part of the API registry.

## Local route inventory

The local companion binds to loopback and checks the peer address and exact
Host header. Unknown API paths are 404. Mutations also require a same-origin
request and their route-specific authorization; contribution upload delivery
is never an arbitrary local proxy.

| Method | Path | Caller | Authority | Storage or network effect | Owner |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/local/health` | Dashboard/native shell | Loopback read | Reports companion/snapshot readiness and enabled local capabilities. | Local companion |
| `GET` | `/api/local/diagnostics/contribution` | Dashboard/native shell | Loopback read | Reads a content-free local support projection. | Diagnostics |
| `POST` | `/api/local/diagnostics/note` | Native shell | Loopback mutation | Records a bounded, fixed-vocabulary diagnostic reference; no prompt or path content. | Diagnostics |
| `GET`, `POST` | `/api/local/identity/hosted-signin-handoff` | Dashboard/native shell | Loopback mutation | Inspects, stores, or clears the bounded local OAuth restart handle. | Hosted identity |
| `GET` | `/api/local/onboarding` | Dashboard | Loopback read | Projects source readiness without exposing filesystem paths. | Local companion |
| `GET` | `/api/local/overview` | Dashboard | Loopback read | Reads the current derived overview snapshot. | Local companion |
| `GET` | `/api/local/gradient` | Dashboard | Loopback read | Reads the derived cost/quota gradient. | Local analysis |
| `GET` | `/api/local/weekly` | Dashboard | Loopback read | Reads derived weekly capacity and pace evidence. | Local analysis |
| `GET` | `/api/local/weekly-pace-outlook` | Native shell | Loopback read | Reads the bounded account-scoped weekly pace presentation projection. | Local analysis |
| `GET` | `/api/local/quality` | Dashboard | Loopback read | Reads monitoring-quality evidence. | Local analysis |
| `GET` | `/api/local/timeline/window-breakdown` | Dashboard | Loopback read | Reads a bounded `from`/`to` timeline window; it is the only local API query-string route. | Local analysis |
| `GET`, `POST` | `/api/local/refresh` | Dashboard/native shell | Loopback mutation | GET reads refresh state; POST starts source reads and an atomic snapshot/index refresh. | Refresh controller |
| `POST` | `/api/local/refresh/cancel` | Dashboard/native shell | Loopback mutation | Requests cancellation; published prior state remains intact. | Refresh controller |
| `POST` | `/api/local/contribution/prepare` | Dashboard | Loopback mutation | Materializes a reviewed, bounded prepared contribution set locally. | Contribution |
| `GET` | `/api/local/contribution/sync-status` | Dashboard | Loopback read | Reads the legacy prepared-set queue state. | Contribution sync |
| `POST` | `/api/local/contribution/sync-next` | Dashboard | Loopback mutation | Builds the next bounded local review projection; does not upload. | Contribution sync |
| `POST` | `/api/local/contribution/device-pair` | Dashboard | Loopback mutation | Claims a hosted pairing and stores the device credential in the platform credential store. | Device lifecycle |
| `POST` | `/api/local/contribution/device-disconnect` | Dashboard | Loopback mutation | Revokes hosted device authority and removes local binding/credential state. | Device lifecycle |
| `POST` | `/api/local/contribution/device-credential-reset` | Dashboard | Loopback mutation | Removes unusable local device credential/binding state; does not delete hosted data. | Device lifecycle |
| `POST` | `/api/local/contribution/sync-inspect-exact` | Dashboard | Loopback mutation | Verifies the exact next payload and issues a short-lived, single-use local review token. | Contribution sync |
| `GET` | `/api/local/contribution/incremental-status` | Dashboard | Loopback read | Reads v1 incremental consent/cursor/retry state. | Contribution sync |
| `POST` | `/api/local/contribution/incremental-approve` | Dashboard | Loopback mutation | Records current consent after exact local review and schedules the first due pass. | Contribution sync |
| `POST` | `/api/local/contribution/incremental-run` | Dashboard | Loopback mutation | Resets bounded retry backoff and asks the consent-gated controller to run now. | Contribution sync |
| `GET`, `POST` | `/api/local/accounting/fast-mode-preference` | Dashboard | Loopback mutation | Reads or stores an explicit local accounting mode and rebuilds the derived snapshot. | Accounting |

## Fixed report pages

These are GET-only, fixed-path HTML resources. They resolve only to files under
the configured local resource root and have a stricter report CSP.

| Method | Path | File family |
| --- | --- | --- |
| `GET` | `/reports/gradient` | Cost-versus-quota gradient |
| `GET` | `/reports/weekly` | Seven-day calibration |
| `GET` | `/reports/quality` | Monitoring quality |
| `GET` | `/reports/multi-surface` | Multi-surface account usage |

## Public central relay

The loopback companion can relay only this exact public GET route to the
configured central origin. It does not forward cookies, credentials, arbitrary
headers, arbitrary methods, or arbitrary paths.

| Method | Path | Upstream authority |
| --- | --- | --- |
| `GET` | `/api/health` | Public |

## Participant relay

The participant relay forwards only the exact method/path pairs in
`apps/local/transport/participant-relay-routes.js`. It preserves the bounded
session/CSRF/upload headers required by those routes, never chooses an upstream
from request data, and keeps provider callbacks off loopback.

| Method | Path |
| --- | --- |
| `POST` | `/api/v1/enroll` |
| `POST` | `/api/v1/identity/google/start` |
| `POST` | `/api/v1/identity/google/result` |
| `POST` | `/api/v1/identity/apple/start` |
| `POST` | `/api/v1/identity/apple/result` |
| `GET` | `/api/v1/session` |
| `POST` | `/api/v1/logout` |
| `DELETE` | `/api/v1/me` |
| `POST` | `/api/v1/me/device-pairings` |

## Native bridge

The embedded WKWebView admits only the current loopback companion, `about:`,
and bounded blob downloads. Provider sign-in opens in the system browser.

| Direction | Name | Payload boundary |
| --- | --- | --- |
| Web to native | `tibotattleLocalization` | Closed language-preference enum. |
| Web to native | `tibotattleDownloads` | Fixed `reveal-latest-download` action; no path crosses the bridge. |
| Web to native | `tibotattleHostedSignIn` | One boolean indicating whether a handoff is in flight. |
| Native to web | `tibotattle:hosted-sign-in-return` | Payload-free wake-up event. |
| Native to web | `tibotattle:local-evidence-updated` | Payload-free refresh-complete event. |
| Native to web | `tibotattle:locale-override` | Closed language preference plus locale table metadata. |
| Native to web | `tibotattle:appearance-override` | Closed appearance preference and resolved theme. |

## Process and provider protocols

| Boundary | Caller | Contract |
| --- | --- | --- |
| Codex app-server | Local collector | Spawns the local `codex app-server` binary and uses bounded JSON-RPC for account, rate-limit, and usage evidence. No provider credential is copied into documentation or telemetry. |
| Claude status line | Explicit standalone callback hook to local broker | Bounded JSON input through the managed callback/socket boundary; content-free status projection only. It is not an installed-app API. |
| R7 benchmark worker | Protected release-evidence generator | Bounded JSON request on stdin and one stable JSON result on stdout. It is not a routine documentation gate and may read private local corpus evidence. |
| Local companion ready line | Native launcher | One `USAGE_MONITOR_READY` line containing the loopback URL after bind; stdout is not a general API. |

## Package and contract boundaries

Runtime-neutral package APIs are exported only through each package root:

- `@app-usagemonitor/accounting`
- `@app-usagemonitor/i18n`
- `@app-usagemonitor/identity-core`
- `@app-usagemonitor/quota-analysis`
- `@app-usagemonitor/telemetry-contract`

Closed JSON Schema contracts live under `schemas/`; telemetry v0.2 mirrors are
generated from `packages/telemetry-contract/schemas/v0.2/`. Canonical/mirror
ownership and compatibility rules are documented in
[`schema-contracts.md`](./schema-contracts.md). Storage-version recovery is
documented separately in [`unified-index-schema.md`](./unified-index-schema.md)
and [`../runbooks/unified-index-recovery.md`](../runbooks/unified-index-recovery.md).

## Compatibility and retirement

- Compatibility aliases are explicit registry entries, not wildcard routes.
- A route is retired by removing its callers, migrations/data obligations,
  registry entry, handler, tests, and documentation together.
- A deprecated route remains documented until the shipping compatibility window
  ends. An obsolete document is deleted once it no longer describes a retained
  contract or supplies enduring audit/recovery evidence.
