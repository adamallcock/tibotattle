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
| Accountless enrollment | Native installation enrollment proof with a bounded device-hash body and no ambient participant/session authority. |
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
| `POST` | `/api/v1/accountless/enrollment` | Native installation | Accountless enrollment | When the synthetic accountless gate is enabled, atomically records one versioned enrollment-only ledger row keyed by device ID and a 256-bit device-secret hash. It creates no participant, session, pairing, device credential, upload authority, identity link, or community eligibility. | Accountless enrollment pilot |
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
| `POST` | `/api/v1/admin/action` | Owner/admin application | Admin | Collection controls, maintenance, and distribution actions; explicit participant erasure uses the existing maintenance action with auditable D1/R2 effects. | Operations |
| `POST` | `/api/v1/me/security-reset` | Participant browser | Session | Rotates session/recovery state and invalidates affected credentials. | Participant account |
| `POST` | `/api/v1/me/device-pairings` | Participant browser | Session | Creates a bounded device-pairing claim in D1. | Device lifecycle |
| `POST` | `/api/v1/device-pairings/claim` | Native app | Pairing code | Claims the pairing and returns the device credential once. | Device lifecycle |
| `POST` | `/api/v1/device/upload-authorizations` | Native app | Device | Creates a one-use upload authorization for a paired device. | Contribution |
| `POST` | `/api/v1/device/disconnect` | Native app | Device | Revokes the current device and stops its hosted upload authority. | Device lifecycle |
| `POST` | `/api/v1/device/credential/renew` | Native app | Device | Rotates the same device credential without creating a new device slot. | Device lifecycle |
| `GET` | `/api/v1/device/sync/state` | Native app | Device | Reads the device's v1 incremental cursor/admission state. | Contribution sync |
| `GET` | `/api/v1/device/sync/manifest` | Native app | Device | Reads a bounded date-range manifest of accepted incremental chunks. | Contribution sync |
| `GET` | `/api/v1/device/sync-capabilities` | Native app | Device | Reads accepted formats, exact v1.1 grant, write floor/revision and authenticated enrollment/destination binding; never creates consent. | Contribution sync |
| `POST` | `/api/v1/me/device-telemetry-consents` | Participant browser | Session | Records explicit current v1.1 consent for the selected device and raises the persisted participant write floor. | Contribution consent |
| `GET`, `POST` | `/api/v1/device/telemetry/v1.1/day-manifests` | Native app | Device | Reads a bounded date-range candidate inventory, or registers/replays one immutable day manifest and reports exact staged chunks; no analytical activation. | Contribution sync |
| `POST` | `/api/v1/me/telemetry-v11/domain-predecessor` | Native app | Device | Issues a bounded source-pinned bootstrap/successor token, with null predecessor for first cutover. | Contribution sync |
| `POST` | `/api/v1/me/telemetry-v11/domain-activate` | Native app | Device | Proves complete predecessor coverage and atomically switches the whole analytical domain; incomplete transfers remain staged. | Contribution sync |
| `GET` | `/api/v1/me/devices` | Participant browser | Session | Lists participant device projections without credentials. | Device lifecycle |
| `POST` | `/api/v1/me/devices/revoke` | Participant browser | Session | Revokes a selected device. | Device lifecycle |
| `GET` | `/api/v1/envelope-key` | Native or web client | Public | Returns the public wrapping key; never returns private key material. | Contribution crypto |
| `POST` | `/api/v1/contributions` | Prepared uploader | Upload | Validates and deduplicates an encrypted contribution, writes D1 state and quarantined R2 object data, and schedules aggregation. | Contribution ingestion |
| `GET` | `/api/v1/me/export` | Participant browser | Session | Returns a bounded export of the participant's hosted data. | Participant data |
| `GET` | `/api/v1/community/daily` | Website | Public | Reads a bounded published daily range and omits unavailable allowance evidence. | Community publication |

Production admin API and UI paths are served only on the configured admin host.
Public-host requests to those paths are deliberately 404. Static site assets
are not part of the API registry.

### Self-service retirement and private owner erasure

Under the [2026-08-30 source decision](../decisions/2026-08-30-self-service-deletion-retirement.md),
`DELETE /api/v1/me` is not a registered route: it returns the existing unknown
API `404 NOT_FOUND` without D1 access or participant mutation.
`POST /api/v1/me/contributions/delete` remains retired. Health reports
`participantDeletion: false` and retains `deletionSafeRestoreReplay: true`;
neither field is deployment or erasure-completion evidence.

Private erasure uses the existing `POST /api/v1/admin/action` and
`action: "run_maintenance"`, with the closed `participantErasure` object:
`participantId` is the exact opaque `participant:<UUID>` string, and
`confirmation` is `"erase_hosted_participant"`. It requires the configured
admin host, Access-pinned owner identity, exact-origin CSRF, and
`x-usage-monitor-admin: 1`. Without `participantErasure`, ordinary maintenance
must not initiate participant erasure. No new route, action enum, or migration
is introduced.

Success has `schemaVersion: "admin-action-v0.1"`, `action: "run_maintenance"`,
and `result` containing `task: "participant_erasure"`, `operationId` (UUID),
`deleted: true`, `alreadyDeleted`, and `contributionsDeleted`:

| Completion evidence | `alreadyDeleted` | `contributionsDeleted` |
| --- | --- | --- |
| The operation completed participant erasure | `false` | Number of contributions removed |
| Participant absent and an unexpired independent tombstone proves prior erasure | `true` | `null` (historical count unknown, not zero) |

Absence without an unexpired tombstone returns `404 NOT_FOUND`, not success.
An interrupted `deleting` participant with a non-null deletion fence can resume
through the owner boundary without its former web session. A fresh started
owner attempt returns `409 PARTICIPANT_DELETING`; wait/recheck rather than
erase concurrently. Owner takeover is limited to a non-null legacy fence
without a matching audit, a failed attempt, or a started attempt older than
five minutes. The new audited operation
UUID fences final removal against stale attempts. A null `deletion_session_id`
on a deleting participant belongs to restore replay: owner erasure returns the
same busy response while maintenance finishes or retries that restore. Cron
does not resume non-null owner/legacy deletions. Audit action remains
`run_maintenance`; its details identify `task: "participant_erasure"`, a
purpose-separated participant digest, and bounded outcome/code/count, never
raw identifiers. The
[production owner procedure](../runbooks/production-operations.md#private-owner-participant-erasure)
defines the exact audit domain and preserved pipeline/restore requirements.

## Local route inventory

The local companion binds to loopback and checks the peer address and exact
Host header. Unknown API paths are 404. Mutations also require a same-origin
request and their route-specific authorization; contribution upload delivery
is never an arbitrary local proxy.

| Method | Path | Caller | Authority | Storage or network effect | Owner |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/api/local/health` | Dashboard/native shell | Loopback read | Reports companion/snapshot readiness and enabled local capabilities. | Local companion |
| `GET` | `/api/local/desktop-status` | Electron shell | Loopback read | Projects closed lifecycle, a current direct display allowance from bounded published-overview metadata, and receipt-only strict v2 notification evidence; no account identifiers or filesystem paths. Available before the first snapshot. | Local companion |
| `GET` | `/api/local/diagnostics/contribution` | Dashboard/native shell | Loopback read | Reads a content-free local support projection. | Diagnostics |
| `POST` | `/api/local/diagnostics/note` | Native shell | Loopback mutation | Records a bounded, fixed-vocabulary diagnostic reference; no prompt or path content. | Diagnostics |
| `GET`, `POST` | `/api/local/identity/hosted-signin-handoff` | Dashboard/native shell | Loopback mutation | Inspects, stores, or clears the bounded local OAuth restart handle. | Hosted identity |
| `GET` | `/api/local/onboarding` | Dashboard | Loopback read | Projects source readiness without exposing filesystem paths. | Local companion |
| `GET` | `/api/local/overview` | Dashboard | Loopback read | Reads the current derived overview snapshot. | Local companion |
| `GET` | `/api/local/cache-drop-thread-links` | Local dashboard only | Same-origin custom-header read | Ephemeral, generation-bound names and Codex thread IDs for recent cache-drop rows; no query parameters, persistence, or export. | Local companion |
| `GET` | `/api/local/gradient` | Dashboard | Loopback read | Reads the derived cost/quota gradient. | Local analysis |
| `GET` | `/api/local/weekly` | Dashboard | Loopback read | Reads derived weekly capacity and pace evidence. | Local analysis |
| `GET` | `/api/local/weekly-pace-outlook` | Native shell | Loopback read | Reads the bounded account-scoped weekly pace presentation projection. | Local analysis |
| `GET` | `/api/local/quality` | Dashboard | Loopback read | Reads monitoring-quality evidence. | Local analysis |
| `GET` | `/api/local/timeline/window-breakdown` | Dashboard | Loopback read | Reads a bounded `from`/`to` timeline window; it is the only local API query-string route. | Local analysis |
| `GET`, `POST` | `/api/local/refresh` | Dashboard/native shell | Loopback mutation | GET reads refresh state, closed `mode` (`null`, `quick`, `detailed`) and actual `startedAt`; POST explicitly advances retained history and recalculates generation-bound detailed accounting before full publication. A 409 returns the in-flight receipt. | Refresh controller |
| `POST` | `/api/local/refresh/quick` | Dashboard/native shell | Loopback mutation | Refreshes current quota/headline evidence without advancing the unified index or rebuilding detailed accounting; the last authoritative detailed projection remains available with current freshness truth fields. | Refresh controller |
| `POST` | `/api/local/refresh/cancel` | Dashboard/native shell | Loopback mutation | Requests cancellation; published prior state remains intact. | Refresh controller |
| `POST` | `/api/local/contribution/prepare` | Dashboard | Loopback mutation | Materializes a reviewed, bounded prepared contribution set locally. | Contribution |
| `GET` | `/api/local/contribution/sync-status` | Dashboard | Loopback read | Reads the legacy prepared-set queue state. | Contribution sync |
| `POST` | `/api/local/contribution/sync-next` | Dashboard | Loopback mutation | Builds the next bounded local review projection; does not upload. | Contribution sync |
| `POST` | `/api/local/contribution/device-pair` | Dashboard | Loopback mutation | Claims a hosted pairing and stores the device credential in the platform credential store. | Device lifecycle |
| `POST` | `/api/local/contribution/device-disconnect` | Dashboard | Loopback mutation | Persists `device_disconnected` pause intent, revokes hosted device authority, and removes local binding/credential state; preserves history. | Device lifecycle |
| `POST` | `/api/local/contribution/device-credential-reset` | Dashboard | Loopback mutation | Removes unusable local device credential/binding state; does not delete hosted data. | Device lifecycle |
| `POST` | `/api/local/contribution/sync-inspect-exact` | Dashboard | Loopback mutation | Verifies the exact next payload and issues a short-lived, single-use local review token. | Contribution sync |
| `GET` | `/api/local/contribution/incremental-status` | Dashboard | Loopback read | Reads v1 incremental consent/cursor/retry state. | Contribution sync |
| `POST` | `/api/local/contribution/incremental-review-v11` | Dashboard | Loopback mutation | Capability-gated v1.1 field/sample review with a one-use token bound to the published index, consent triple and destination. Does not upload or grant hosted consent. | Contribution consent |
| `POST` | `/api/local/contribution/incremental-approve` | Dashboard | Loopback mutation | Records current consent after exact local review and schedules the first due pass. | Contribution sync |
| `POST` | `/api/local/contribution/incremental-run` | Dashboard | Loopback mutation | Resets bounded retry backoff and asks the consent-gated controller to run now. | Contribution sync |

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
| `POST` | `/api/v1/me/device-pairings` |
| `POST` | `/api/v1/me/device-telemetry-consents` |

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
- Retire a route's callers, registry entry, handler, and active promises
  together; retain negative tests proving refusal without side effects.
  Migrations, retained-data obligations, erasure/restore safeguards, and
  historical evidence do not disappear with an HTTP route. Their removal
  requires a separate reviewed and authorized lifecycle decision.
- A deprecated route remains documented until the shipping compatibility window
  ends. An obsolete document is deleted once it no longer describes a retained
  contract or supplies enduring audit/recovery evidence.
