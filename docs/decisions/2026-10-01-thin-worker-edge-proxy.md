---
title: Thin Worker edge proxy in front of the Google Cloud origin
date: 2026-10-01
type: decision-record
status: accepted
---

# Thin Worker edge proxy in front of the Google Cloud origin

> **Accepted.** The owner approved this text as written in chat on 2026-10-02.
> It changes no current Cloudflare behavior. It authorizes no deploy, secret
> change, writer fence, GCP write or cutover, and it makes no
> production-readiness claim. It contains no identifiers, tokens or session
> content.

| Field | Value |
|---|---|
| Status | Accepted; the owner approved this text as written in chat on 2026-10-02 |
| Recorded | 2026-10-01, for the GCP fast path (planning item E11, which supersedes the EP-11 brief) |
| Applies to | The production Worker as a thin edge, and the Google Cloud origin behind it, from an owner-authorized cutover |
| Does not apply to | Current Cloudflare production before the first edge deploy, local analysis and the desktop clients |
| Production Worker source | `d43c8f92` (the source Cloudflare production runs). GitHub `main` is `f0067d0f` |
| Builds on | [Append-only contributions on the Google Cloud service](./2026-09-26-append-only-contributions.md), accepted 2026-09-30 |
| Operations | [Production edge modes](../runbooks/production-edge-modes.md) |
| Delivery plan | [GCP fast path](../plans/2026-10-01-gcp-fastpath.md) |

## Claim boundary and implementation state

- Facts about the production Worker were read with Git from `d43c8f92`. Facts
  about the edge and origin code were read from the fast-path line,
  `claude/gcp-fastpath-final` at `7ef0e144`. No running service was queried.
- Present on the fast-path line, as source with local tests only:
  - EP-0, the transport contract
    ([`edge-origin-contract.ts`](../../apps/worker/src/edge-origin-contract.ts));
  - EP-1, the edge admission policy
    ([`edge-admission-policy.ts`](../../apps/worker/src/edge-admission-policy.ts));
  - EP-2, the Google ID-token source
    ([`edge-google-id-token.ts`](../../apps/worker/src/edge-google-id-token.ts));
  - EP-3, the distribution-analytics split;
  - EP-6, the origin boundary and admission replay
    ([`postgres-edge-origin-dispatch.mjs`](../../apps/worker/cloud-run/postgres-edge-origin-dispatch.mjs),
    [`postgres-edge-admission-limiters.mjs`](../../apps/worker/cloud-run/postgres-edge-admission-limiters.mjs));
  - EP-7, the production service and invoker IAM templates;
  - EP-8, the writer fence
    ([`cloudflare-writer-fence.mjs`](../../apps/worker/scripts/cloudflare-writer-fence.mjs));
  - EP-9, the edge-mode overlay
    ([`edge-mode-configuration.mjs`](../../apps/worker/scripts/edge-mode-configuration.mjs)).
- Merged on the GCP line's edge integration branch `claude/gcp-fp-edge`,
  locally tested and not deployed:
  - E4, the proxy core;
  - E5, the Worker entry and the release-guard database facade;
  - EORIGIN, the edge-test origin and the origin's admission fixes;
  - E10, the typed deploy for the edge modes;
  - E12, the local end-to-end test
    ([receipt](../receipts/2026-10-01-gcp-edge-proxy-local.md)).

  Where this record describes them, it states their reviewed design. Their
  merged code and tests are the implementation evidence. None of them is yet
  on an edge-port line (OD-E1).
- Nothing has been deployed. No Cloudflare or GCP resource has been created or
  changed for the edge. The origin's production composition (CR-6 and CR-7)
  does not exist yet, and the origin still refuses to start without a test
  mode.
- Two observations on Cloudflare's network exist, both owner-authorized
  address probes on 2026-10-02 to a temporary echo service in the GCP test
  project, since deleted: one from a throwaway `workers.dev` Worker
  ([section 5](#the-cloudflare-network-probe-2026-10-02)), and a rerun from an
  exact-path route on the `tibotattle.com` zone
  ([section 5](#the-production-zone-probe-2026-10-02)). Neither deployed any
  part of the edge.

## 1. Topology and modes

One production Worker, `app-usagemonitor`, becomes a thin edge. Its mode is the
plain-text variable `EDGE_UPSTREAM_MODE`, read by `src/edge-entry.ts`:

| Mode | Behavior |
|---|---|
| `worker` | The unchanged Worker. Requests and the cron delegate to the Worker's default export. Bindings, variables, secrets and crons are the live ones plus this one inert variable |
| `fenced` | The reviewed request-level mutation barrier, with no storage binding passed to it. Public `GET /api/health` returns barrier health. Every other non-asset request, and every admin-surface request, gets `503 MUTATION_BARRIER_ACTIVE` with `no-store` and `retry-after: 300`. Apex assets serve, `www` asset paths redirect to the apex, and the cron does nothing |
| `gcp` | Storage-free request classes are answered at the edge by the unchanged `handleRequest`. Everything else is forwarded, unbuffered, to an IAM-private Cloud Run origin |
| Absent, unknown or invalid | `www` and assets still serve. Every other request gets `503 EDGE_NOT_CONFIGURED` with `retry-after: 60`. An invalid `gcp` configuration behaves the same way |

Unchanged in every mode:

- `tibotattle.com`, `www.tibotattle.com` and `admin.tibotattle.com` stay custom
  domains of the same Worker. No DNS record, certificate, custom domain or
  Access application changes.
- `updates.tibotattle.com` and the separate dogfood release guard Worker are
  untouched.
- Cloudflare keeps the static site and assets, release and update hosting (the
  Sparkle appcast bucket and the appcast guard), download analytics, and the
  admin portal behind Cloudflare Access.
- Exactly one Worker version serves 100% of traffic. Gradual deployments and
  version splits are never used on this Worker, because a split could route
  requests to both the Cloudflare and the PostgreSQL stores.

## 2. Configuration source

Every production edge deploy, in every mode, goes through the typed path:

1. Render `env.production` from the live inventory (`renderProductionLiveConfig`).
2. Apply EP-9's `applyEdgeModeOverlay` for the mode.
3. Build the expected snapshot with `applyEdgeModeSnapshotDelta`.
4. `verifyProductionLiveConfig` must accept exactly that declared change. Any
   other drift fails.

The mode and the overlay's sha256 join the typed operation pin and the receipt.
Reconciliation re-renders with the same overlay, so it can never produce a
config without a mode.

The overlay per mode:

- **worker:** `main` becomes `src/edge-entry.ts` and `EDGE_UPSTREAM_MODE` is
  `worker`. Nothing else changes.
- **fenced:** the same, with the mode `fenced`.
- **gcp:** the same, plus `EDGE_UPSTREAM_ORIGIN`, `EDGE_ORIGIN_AUDIENCE`,
  `EDGE_INVOKER_SERVICE_ACCOUNT` and `EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS`.
  Storage is reduced to the new `RELEASE_GUARD_DB` and `SPARKLE_RELEASES`, and
  crons become empty. Assets, every rate-limit binding, the Durable Object
  binding and its migration history, routes, variables and secrets are kept. An
  unknown storage binding fails closed.

**Why not the checked-in `env.production`.** It still names the unbound legacy
primary D1, sets JSON storage mode and has no `ANALYTICS_DB`. A deploy from it
would rebind the legacy database, drop the analytics database and switch the
storage mode. A raw `wrangler deploy` bypasses every guard. The checked-in
`main` changes to `src/edge-entry.ts` only after the gcp switch, in an
integration commit that also records that production is typed-rendered.

## 3. Edge source line

- Deploy the edge only from the production line: a branch that contains
  `d43c8f92` and the live `DEPLOYMENT_SOURCE_COMMIT`. Never deploy it from the
  GCP line. At `7ef0e144` the GCP line's web assets, admin UI bundle, storage
  analytics modules and expected D1 migrations differ from `d43c8f92`. A worker
  or fenced deploy from it would change production behavior, and a gcp deploy
  would serve an older site and admin UI.
- The edge files are line-portable. Their imports are identical on both lines,
  and the entry imports `./index` and `./ingress-budget`, not the GCP line's
  `./cloudflare-entry`. The integration lead cuts `claude/edge-port-<date>` from
  the owner-designated production release line (OD-E1). The lead then ports EP-0
  to EP-3, EP-9 (with its `production-live-config.mjs` change), E4, E5 and the
  release-guard migration, each blob-identical to the fast-path line. E10 is
  built against that line's deploy tooling. The entry also imports
  `contributionRequestPreflight` from `./index`, which `d43c8f92` does not
  export, so the port adds the `export` keyword to that one function in
  `index.ts` and changes nothing else in it.
- The origin side (EP-6, EP-7, EORIGIN and the future production composition)
  stays on the GCP line. The contract-blob rule in
  [section 11](#11-identity-split-and-the-contract-blob-rule) is what makes two
  lines safe.
- Proposed guard (OD-E2): an `--edge-mode` deploy refuses
  `EDGE_MODE_SOURCE_NOT_DESCENDANT` unless its source commit descends from the
  live `DEPLOYMENT_SOURCE_COMMIT`.

## 4. Origin authentication

- **The service.** The Cloud Run service has ingress `all`, requires invoker
  IAM, has the custom audience `EDGE_ORIGIN_AUDIENCE` and never grants
  `run.invoker` to a public principal. Only the dedicated edge-invoker account
  and optional verifier accounts hold `run.invoker`, on this one service.
  Neither holds any project role. The EP-7 templates
  ([service](../../apps/worker/cloud-run/production-service.template.yaml),
  [IAM](../../apps/worker/cloud-run/production-edge-iam.template.json)) define
  this.
- **The token.** The edge mints Google ID tokens (EP-2) from the Worker secret
  `EDGE_INVOKER_KEY_JSON`, which exists only at the edge. The mint is an RS256
  JWT-bearer exchange with Google's fixed token endpoint. It has a five-second
  deadline and a 16 KiB response cap. Tokens are cached per isolate until five
  minutes before expiry, never longer than one hour, with one exchange in flight
  at a time and a ten-second negative cache. A token is accepted only for the
  configured audience and account, with a verified email.
- **The header.** The token travels in `X-Serverless-Authorization`, so the
  client's own `Authorization` header (the device bearer) reaches the origin
  untouched.
- **The origin boundary (EP-6).** The delivered claims must carry the audience,
  a verified email and an unexpired token (60 seconds of clock skew). The email
  must be the invoker or a verifier account. A verifier may send only a plain
  `GET /api/health` or `GET /api/ready` with an empty query and no
  `x-tibotattle-*` header. The invoker may send only the contract's
  `x-tibotattle-*` headers. The boundary rebuilds the request on the public
  origin, copies only the allowlisted headers and marks every response it
  returns with `x-tibotattle-origin: 1`. Every refusal is one constant, unmarked
  `421 {"error":"HOST_REQUEST_UNAVAILABLE"}` with `connection: close`, and the
  body is never read.
- **HMAC fallback.** It applies only if organization policy forbids
  service-account keys. It changes only EP-2 and EP-6, but it exposes a public
  service URL without IAM, so it needs its own owner decision before use.
- **Accepted risk.** The invoker key is a long-lived credential held by
  Cloudflare. A leak would allow direct origin calls with forged admission
  outcomes; route authentication still applies to every route. Mitigations:
  `run.invoker` on one service only, and rotation every 90 days.

## 5. Client address privacy

**On Cloudflare's network, no header carrying the visitor's address reached
a Cloud Run service that a Worker called the way the edge does.** An
owner-authorized probe observed this on 2026-10-02 from a `workers.dev` Worker
([below](#the-cloudflare-network-probe-2026-10-02)). With the edge's
`x-real-ip` override, the `x-forwarded-for` that Google delivered carried
Cloudflare's placeholder, not the visitor's address. Cloudflare's
documentation says otherwise for `CF-Connecting-IP`, and a previous revision
of this section, relying on it, said that Google receives the raw client
address on every forwarded request. The observation replaces that statement for the
placement it covers. The edge's own code sets no value derived from the client
address. The same probe from the `tibotattle.com` zone, where the production
edge runs, passed later on 2026-10-02
([below](#the-production-zone-probe-2026-10-02)), which clears OD-E6's gate on
the gcp switch ([below](#od-e6-recommendation-and-gate)).

### What Cloudflare documents for the edge's subrequests

Cloudflare's [HTTP headers reference](https://developers.cloudflare.com/fundamentals/reference/http-headers/)
says that a Worker subrequest to a host outside any Cloudflare zone carries the
client's address in both `CF-Connecting-IP` and `x-real-ip`, and that a Worker
can change only `x-real-ip`. Both of the edge's subrequests to Google are of
that kind:

- the forward to the Cloud Run origin, a `*.run.app` host, on every forwarded
  request;
- the ID-token exchange with `oauth2.googleapis.com`, which runs inside the
  client request that finds the cache empty, so it carries that client's
  address, about once an hour per isolate.

The edge therefore sets `x-real-ip` to the constant `2a06:98c0:3600::103` on
both (`src/edge-google-subrequest.ts`), the address Cloudflare itself
substitutes for a cross-zone Worker subrequest. No Worker code can change
`CF-Connecting-IP`. By the documentation, Google's front end and the Cloud Run
container would receive that header; in the 2026-10-02 probe it did not reach
the container. EP-6 copies only the allowlisted headers to the application, so
even a delivered `CF-Connecting-IP` would reach no handler, PostgreSQL row,
origin log or response. What Google's own platform does with the headers it
receives is outside this record's evidence.

Cloudflare does not document every header it adds to such a subrequest, and
Miniflare adds none of them. E12's S7 proves what the edge's code and workerd
send, not what Cloudflare's network adds. Only an observation on Cloudflare's
network can establish that.

### The Cloudflare-network probe (2026-10-02)

At about 02:10 UTC on 2026-10-02, with the owner's authorization, a throwaway
Worker (`tibotattle-edge-ip-probe`, on the owner's `workers.dev` subdomain, not
the `tibotattle.com` zone, deployed by the owner) fetched a temporary public
Cloud Run echo service (`tibotattle-ip-probe-echo` in the GCP test project,
us-east1) as the edge does: `x-real-ip` set to the constant, plus a
per-request salt and a salted SHA-256 of the inbound `CF-Connecting-IP`. The
echo returned only header names and, for address-like names, booleans and
token counts: whether the value equals or contains the constant, and whether
it contains a token whose salted hash equals the visitor's. No value was
returned, logged or stored. Both the echo and the throwaway Worker were
deleted afterwards (the Worker by the owner). The tooling is in
[`apps/worker/scripts/edge-ip-probe/`](../../apps/worker/scripts/edge-ip-probe/README.md),
and the [edge receipt](../receipts/2026-10-01-gcp-edge-proxy-local.md#cloudflare-network-address-probe)
records the run.

- The Worker had the visitor's address in `CF-Connecting-IP`.
- The header names that reached the container were `accept-encoding`,
  `cdn-loop`, `cf-ew-via`, `cf-ray`, `cf-visitor`, `cf-worker`, `forwarded`,
  `host`, `traceparent`, `x-cloud-trace-context`, `x-forwarded-for` and
  `x-forwarded-proto`, plus the two probe headers. Neither `cf-connecting-ip`
  nor `x-real-ip` arrived, and no `cf-ip*` header derived from the address
  did.
- `x-forwarded-for` held two tokens, including the constant, and not the
  visitor's address. `forwarded`, which Google's front end adds, held four
  tokens and not the visitor's address. No header contained the visitor's
  address.

For a `workers.dev` Worker with the override, then, "no client address reaches
the origin" holds: the `x-forwarded-for` that Google delivers carries
Cloudflare's placeholder, not the visitor's address. The probe does not prove:

- the same for a Worker on the `tibotattle.com` zone. Expected, because the
  origin is a non-Cloudflare host either way, but unobserved by this run (the
  [production-zone probe](#the-production-zone-probe-2026-10-02) covers it);
- what the token exchange's endpoint receives. It is the same kind of
  subrequest with the same override, but `oauth2.googleapis.com` cannot be
  observed this way;
- what would arrive without the override. That was not tested, so the
  override stays load-bearing, and so does E12's S7 assertion of it;
- anything Google's front end receives and does not deliver: the container
  is the observation point. Nor does it show the values of headers whose
  names are not address-like, which it did not examine;
- delivery to an IAM-private service. The echo was public; the invoker check
  is not expected to change header delivery, but the probe did not exercise
  it.

### The production-zone probe (2026-10-02)

At about 16:30 UTC on 2026-10-02 the owner re-ran the same probe, following
the [probe's README](../../apps/worker/scripts/edge-ip-probe/README.md#rerun-it-on-the-production-zone-before-the-first-gcp-deploy),
from a throwaway Worker on one exact-path route of the `tibotattle.com` zone
(`workers_dev` off), against a temporary public echo in the GCP test project.
The production Worker was not touched. The
[production-zone receipt](../receipts/2026-10-02-gcp-edge-ip-probe-production-zone.md)
records the run with header names, booleans and token counts only. Both the
Worker and the echo were deleted afterwards.

- The Worker had the visitor's address in `CF-Connecting-IP`, so the run is
  valid.
- The header names that reached the container were identical to the
  `workers.dev` run's, with no new name. Neither `cf-connecting-ip`,
  `x-real-ip` nor `true-client-ip` arrived.
- `x-forwarded-for` held two tokens, including the constant, and not the
  visitor's address. `forwarded` held four tokens and not the visitor's
  address. No header contained the visitor's address.

**Result: pass.** From the production zone, with the override, no header
carrying the visitor's address reaches the origin. The run leaves the rest of
the list above unproven: the token exchange, the counterfactual without the
override, what Google's front end receives and does not deliver, and an
IAM-private service.

### What the edge's code controls

- **Request headers are allowlisted.** The edge copies only
  `FORWARDED_REQUEST_HEADERS` from the contract, plus `cf-access-jwt-assertion`
  on the admin host. It drops the client's `cf-connecting-ip`, every other
  `cf-*` header, `x-forwarded-*`, `forwarded`, `x-real-ip`, `true-client-ip`,
  `user-agent` and any client-sent `x-tibotattle-*` header.
- **The edge sets six headers:** `x-tibotattle-edge-host` (apex or admin),
  `x-tibotattle-edge-request-id` (a fresh UUID v4), `x-tibotattle-edge-admission`
  (policy routes only), `x-tibotattle-google-callback-query` (the apex Google
  callback only), `x-serverless-authorization` and `x-real-ip` (the constant
  above). E12's S7 requires exactly that `x-real-ip` value, once, on every
  exchange.
- **Edge keys.** `EDGE_CLIENT_KEY_SECRET` is used only as the edge admission
  environment's `IDENTITY_LINK_SECRET`, so every address rate-limit key is an
  HMAC under a secret that exists only at the edge. No client-key header exists
  in the contract, and the origin refuses a legacy `x-tibotattle-edge-client-key`
  with its 421.
- **Replay at the origin.** No contract header carries a client address. When
  the origin replays a helper, the helper derives its key from the
  "unavailable" subject under the origin's own `IDENTITY_LINK_SECRET`. The
  replay bindings check only that key's shape; the outcome comes from the edge
  header. No PostgreSQL row or origin log carries a per-address value.
- **Google callback.** The forwarded callback URL always has an empty query.
  When the query is valid and at most 8,192 characters, it travels in its
  header, on the apex only, so it never appears in a Cloud Run request URL.
- **Logs.** Edge and origin boundary logs are content-free. They never include
  the query, host, address, cookies, authorization values, the Access token,
  the ID token, key material or bodies.
- **Unchanged exposure.** Workers observability already records request URLs at
  the edge. That is existing Cloudflare exposure, not a new flow to Google.

### OD-E6: recommendation and gate

**Recommended: keep the current topology, in which the edge forwards directly
to the `*.run.app` origin, with the `x-real-ip` override. No proxied-hostname
rework is needed.** The 2026-10-02 probe found no visitor address reaching the
origin from a `workers.dev` Worker, so neither fallback below is needed unless
the production-zone probe disagrees.

**Gate: re-run the probe from the production zone before the first gcp
deploy.** The owner deploys the echo to the test project and the probe Worker
with an exact-path route on the `tibotattle.com` zone, calls `/probe` once,
deletes both and records the result, as the
[probe's README](../../apps/worker/scripts/edge-ip-probe/README.md) describes.
It records header names and booleans, never a value. A pass keeps this
recommendation. If any header carries the visitor's address, or a name derived
from it arrives, the switch stays blocked and the owner chooses between the
fallbacks:

- **A. A Cloudflare-proxied origin hostname.** The edge forwards to a hostname
  in a Cloudflare zone that fronts the Cloud Run service. By Cloudflare's
  documentation, Cloudflare then substitutes the Worker address
  `2a06:98c0:3600::103` in `CF-Connecting-IP` for a subrequest to another
  zone, and copies `x-real-ip` (the constant) into it for the same zone. This
  needs a contract change (`canonicalRunAppOrigin` accepts only `*.run.app`),
  new EP-7 and EP-9 templates, a DNS record and a way for that hostname to
  reach an IAM-private service (for example a Google load balancer with a
  serverless network endpoint group, or a Cloudflare host override). It
  conflicts with the runbook's "no load balancer, no DNS change" rule, so it
  needs its own owner decision. It does not cover the token exchange, which
  still goes to Google directly; that needs the exchange moved out of client
  requests or the exposure accepted for it.
- **B. Accept and disclose.** Keep `*.run.app` and state that Google's front
  end receives the client's network address in a header Cloudflare adds, which
  the origin discards before any handler runs. Section 12's privacy-page text
  changes to say so.

No local gate can replace the probe: Miniflare adds none of Cloudflare's
headers.

**Gate result: passed on 2026-10-02.** The owner's rerun from the
`tibotattle.com` zone found no visitor address and no new header name reaching
the origin ([above](#the-production-zone-probe-2026-10-02);
[receipt](../receipts/2026-10-02-gcp-edge-ip-probe-production-zone.md)). The
recommendation stands, neither fallback is needed, and the probe no longer
blocks a gcp deploy. A change to the edge's topology or placement, such as
option A, needs its own passing probe before a gcp deploy (section 12).

## 6. Request handling in gcp mode

### Classes answered at the edge

These are answered by `handleRequest(request, localEnv)` and never touch a
limiter, the token source or the origin:

- the `www` host, every method and path (308 to the apex);
- route `asset` on the apex (the site, with the Worker's security headers) and
  on the admin host (the Access chokepoint, then the embedded admin UI);
- `unknown_api` on either host (404), including the retired
  `DELETE /api/v1/me`;
- `apple_domain_association` (404);
- the six admin API routes on the apex (404 `NOT_FOUND`);
- an exact route with a method outside the route registry (405 with `Allow`),
  except the six admin API routes on the admin host, which are forwarded so the
  origin's own chokepoint answers them;
- `community/daily` while `PUBLIC_ANALYTICS_MODE` is not `enabled`
  (`503 PUBLICATION_DISABLED`, `no-store`, no limiter charged). Production
  answers this in `handleRequest` before dispatch (`d43c8f92` `index.ts`
  :4452-4457), and the origin route does not read that variable;
- admin-host chokepoint failures for forwarded requests (`403 ACCESS_REQUIRED`,
  `503 ADMIN_NOT_CONFIGURED`), rendered exactly as `handleRequest`'s catch
  renders them;
- the Sparkle appcast guard, served with its own guard environment
  ([section 8](#8-surfaces-that-stay-at-cloudflare)).

`localEnv` is a named-key environment: public origin, environment, publication
mode, assets, the Access settings, the deployment source commit, and the Sparkle
guard's variables, token and bucket. It never carries a storage database, the
quarantine bucket, any rate-limit binding, the Durable Object or an edge secret.

### Forwarded requests

Every other request for an exact route with a registry method is forwarded,
from either host. The order at the edge is:

1. the admin-host Access chokepoint (`verifyAdminAccessAssertion`, then
   `authorizeAdminEmail`);
2. the pre-admission guard of a policy route (`EDGE_PRE_ADMISSION_GUARDS`):
   the refusals `d43c8f92` gives before its limiter that depend only on the
   request. The five accountless routes refuse a session cookie
   (`401 AUTH_INVALID`). `enroll` and both sign-in starts run
   `assertSameOrigin` (`403 CSRF_INVALID`). `contributions` runs the Worker's
   own `contributionRequestPreflight`, which `index.ts` exports for the entry
   to inject: session cookie (401), content type (415), declared length (400 or
   413 above 2 MiB), body, and the `Upload` bearer's shape (401). A refusal is
   rendered as `handleRequest`'s catch renders it, spends no budget and never
   reaches the origin. `test/edge-pre-admission-guards.spec.ts` holds the map
   to `handleRequest` for every policy route, method and a matrix of request
   variants;
3. a request whose body would be forwarded, with a declared `content-length`
   above 8 MiB, gets a local `413 BODY_TOO_LARGE`. Any other problem with that
   header is left to the origin;
4. edge admission ([section 7](#7-rate-limit-tiering-against-d43c8f92));
5. the forward.

The forward:

- The upstream URL is `EDGE_UPSTREAM_ORIGIN` with the path and query assigned as
  fields, so no path can change the host. The method is unchanged.
- The headers are the allowlist, the contract headers, the ID token and
  `x-real-ip` set to the constant of [section 5](#5-client-address-privacy).
- The body is streamed. It is never buffered and never retried.
- The request uses `redirect: "manual"` and `cache: "no-store"`. The headers
  timeout is `EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS` (default 100, bounds 5 to
  300) and never cuts a streaming body. The forward follows the incoming
  request's abort signal; E12 could not show a client disconnect cancelling it
  under Miniflare, so that cancellation is unproven.
- Responses pass through with their status and every header except the
  contract's `DROPPED_RESPONSE_HEADERS` (hop-by-hop headers, `server`, `via`,
  `alt-svc`, trace headers and the origin marker). Each `Set-Cookie` stays
  separate. The edge never adds or rewrites a header on a forwarded response.
  The admin-overview distribution merge is the only body change.
- A network or TLS error, a headers timeout, a token failure or any unmarked
  response becomes `503 EDGE_ORIGIN_UNAVAILABLE` with `retry-after: 60` and
  `no-store`. Unmarked responses include Google front-end 401, 403, 429 and 5xx
  answers, Cloud Run overload and the origin boundary's 421. The edge cancels
  the unmarked body and logs one content-free `edge_upstream_unavailable` line
  whose code is `EDGE_TOKEN_UNAVAILABLE`, `EDGE_UPSTREAM_TIMEOUT`,
  `EDGE_UPSTREAM_NETWORK` or `EDGE_UPSTREAM_UNMARKED`. Marked responses pass
  through at any status, 3xx and 5xx included.
- A source-scan ratchet over `src/**/*.ts` and `cloud-run/**/*.mjs` (E4) keeps
  the header allowlist equal to the request headers that handlers and origin
  adapters read.

## 7. Rate-limit tiering against d43c8f92

### Edge tier

Six Workers Rate Limiting bindings stay at the edge: `ENROLLMENT_RATE_LIMIT`,
`RECOVERY_RATE_LIMIT`, `CLIENT_ATTEMPT_RATE_LIMIT`, `PUBLIC_READ_RATE_LIMIT`,
`UPLOAD_INGRESS_REQUEST_RATE_LIMIT` and `UPLOAD_INGRESS_CLIENT_RATE_LIMIT`. The
edge evaluates them with the unchanged `admission.ts` helpers, at the 13
production call sites below, for 24 route ids (EP-1's `EDGE_ADMISSION_POLICY`).
Line numbers are `apps/worker/src/index.ts` at `d43c8f92`.

| Line | Route ids | Helper | Purpose | Coarse binding | Client binding |
|---|---|---|---|---|---|
| 718 | `accountless_enrollment` | `assertAttemptAllowed` | `enrollment` | `ENROLLMENT` | `CLIENT_ATTEMPT` |
| 746 | `accountless_ownership` | `assertAttemptAllowed` | `accountless_ownership` | `RECOVERY` | `CLIENT_ATTEMPT` |
| 773 | `accountless_telemetry_v12_authorization` | `assertAttemptAllowed` | `accountless_ownership` | `RECOVERY` | `CLIENT_ATTEMPT` |
| 812 | `accountless_telemetry_performance_authorization` | `assertAttemptAllowed` | `accountless_ownership` | `RECOVERY` | `CLIENT_ATTEMPT` |
| 851 | `accountless_renewal` | `assertAttemptAllowed` | `accountless_renewal` | `RECOVERY` | `CLIENT_ATTEMPT` |
| 899 | `enroll` | `assertAttemptAllowed` | `enrollment` | `ENROLLMENT` | `CLIENT_ATTEMPT` |
| 1508 | `identity_apple_start` | `assertAttemptAllowed` | `sign_in_start` | `ENROLLMENT` | `CLIENT_ATTEMPT` |
| 1719 | `identity_google_start` | `assertAttemptAllowed` | `sign_in_start` | `ENROLLMENT` | `CLIENT_ATTEMPT` |
| 2184 | `device_disconnect` | `assertAttemptAllowed` | `device_disconnect` | `RECOVERY` | `CLIENT_ATTEMPT` |
| 2225 | `device_credential_renew` | `assertAttemptAllowed` | `device_credential_renew` | `RECOVERY` | `CLIENT_ATTEMPT` |
| 3023 | `device_sync_state`, `device_sync_capabilities`, `device_sync_capabilities_v12`, `device_sync_manifest`, `telemetry_performance_capabilities`, `telemetry_performance_reports`, `telemetry_v11_day_manifests`, `telemetry_v12_day_manifests`, `telemetry_v11_domain_predecessor`, `telemetry_v11_domain_activate`, `telemetry_v12_domain_predecessor`, `telemetry_v12_domain_activate` | `assertAttemptAllowed`, inside `deviceSyncPrincipal` (:3016-3030; callers :3047, :3067, :3077, :3098, :3141, :3238, :3258, :3278, :3293, :3306) | `device_sync` | `RECOVERY` | `CLIENT_ATTEMPT` |
| 3342 | `contributions` | `assertUploadIngressRequestAllowed` | `upload_ingress` | `UPLOAD_INGRESS_REQUEST` | `UPLOAD_INGRESS_CLIENT` |
| 3979 | `community_daily` | `assertPublicAggregateReadAllowed` | `public_aggregate_read` | none | `PUBLIC_READ` |

Binding names in the table omit the `_RATE_LIMIT` suffix. The checked-in
`env.production` at `d43c8f92` declares 20 per 60 s for `ENROLLMENT` and
`RECOVERY`, 5 for `CLIENT_ATTEMPT`, 120 for `PUBLIC_READ`, and 3,000 for each
upload binding. Live values come from the typed render, and the overlay keeps
them unchanged. A gcp deploy requires all six edge-tier bindings to be live
already (E10), so the switch never changes admission bindings.

The edge sends only the outcome, `v1;<purpose>;allowed|limited|unavailable`.
The remaining 27 exact routes get no admission header:
`device_upload_authorization` uses only the origin tier below, and the other 26
call no rate limiter at all.

### Origin tier

These stay at the origin, in PostgreSQL:

- `UPLOAD_AUTHORIZATION_RATE_LIMIT` and `UPLOAD_PRINCIPAL_RATE_LIMIT`, keyed on
  the authenticated participant (`index.ts` :2132, `device_upload_authorization`).
  They become exact, global PostgreSQL limits with the production values in
  [`postgres-production-configuration.mjs`](../../apps/worker/cloud-run/postgres-production-configuration.mjs)
  (3,000 per 60 s each);
- the upload ingress budget, which moves from the Durable Object to PostgreSQL;
- the global sign-in start window.

### The replay rule

At the origin, six replay bindings stand in for the edge-tier bindings. They
answer each helper call from the edge outcome at the handler's own call point:

- `allowed` admits;
- `limited` gives the helper's 429 with `retry-after: 60`;
- `unavailable`, a missing header, a purpose mismatch or a call the Worker
  never makes gives the helper's 503 with `retry-after: 60`.

So the Worker's ordering against earlier 401, 403 and 503 checks is kept.

**Every origin handler calls exactly the Worker's helper, at the Worker's call
point.** An extra, missing or reordered call is a parity defect:

- An extra, repeated or wrong-purpose call fails closed with a 503 on every
  request of that route, so it is visible.
- A missing call is silent. The edge's `limited` outcome is ignored, and the
  address limit goes unenforced.
- A reordered call changes which answer wins, for example a 401 where the
  Worker answers 429. It shows only under a `limited` outcome or a cookie.

That silent case caught two fast-path gaps (finding F1). The analytics-v2
`community/daily` route never called the public-read helper, and the
contributions preamble never called the upload-ingress helper. Behind the edge,
`PUBLIC_READ` and the upload-ingress address limits would have gone unenforced.
The same review found four ordering and error-code differences that show only
under a `limited` outcome or a cookie (F2). EORIGIN fixes both groups with
`d43c8f92` line citations, and E12 proves them against the unchanged Worker.

The proofs are split by side. On the edge side, EP-1's spec holds the policy to
`index.ts` with a handler probe and a raw-source ratchet. On the origin side,
EORIGIN's replay-parity spec and E12's admission rows run every served policy
route with each outcome. A new origin adapter must follow EP-1's policy.

If production's admission call sites change before the gcp switch (a new
helper call, binding or purpose), EP-1 is re-derived from that production
source and this table is updated before the switch (OD-E5).

## 8. Surfaces that stay at Cloudflare

- **Admin.** Cloudflare Access still fronts `admin.tibotattle.com`. The edge
  runs the chokepoint before it serves the admin UI or forwards a request. It
  forwards `cf-access-jwt-assertion` and the cookie only for the admin host.
  The origin re-verifies every admin-host request with the same
  `admin-access.ts` functions; that is CR-6 and CR-7 work, and those routes are
  outside the fast path (OD-E4).
- **Download analytics.** For an admin-host `GET /api/v1/admin/overview`, the
  edge reads the seven Cloudflare analytics segments while the forward is in
  flight. On a marked 200 JSON response of at most 4 MiB, it replaces
  `distribution.cloudflare` with EP-3's `cloudflareDistributionFromSegments`,
  using the response's own GitHub release tag. On any failure, size overrun or
  shape mismatch, the origin's bytes pass unchanged. The analytics token and
  zone stay at Cloudflare, and raw analytics rows exist only in transient edge
  memory.
- **Sparkle appcast guard.** In worker mode it runs as today. In fenced mode it
  is blocked, so release publishing pauses. In gcp mode it is served locally:
  its `USAGE_MONITOR_DB` is a facade over `RELEASE_GUARD_DB`, the D1
  `tibotattle-release-guard`. That database is created from
  `release-guard-migrations/0001`, whose statements equal `migrations/0029`.
  The facade accepts only SQL that names `sparkle_appcast_guard_nonces`, so the
  guard's sampled diagnostic insert is refused and swallowed. Nonces are kept
  for 301 seconds and purged inline, and the fence lasts longer than that
  window, so no nonce copy is needed.

## 9. Writer fence and quiescence proof

The fence covers every Cloudflare writer:

- The production Worker in fenced mode: requests are fenced and the cron is a
  no-op.
- EP-8 removes the cron schedules of every separately deployed writer Worker in
  the live inventory and pauses the analytics catch-up queue consumer.
- The inventory fails closed (`WRITER_UNACCOUNTED`) if any script outside the
  fence binds a listed D1 database or R2 bucket, and refuses `SCHEDULE_DRIFT`
  when a fenced script's crons differ from the plan.

EP-8 proves quiescence over a quiet window that starts at least 15 minutes after
the last fence action:

- D1 time-travel bookmarks are equal at both ends of the window for the
  ingestion, analytics, deletion-ledger and catch-up control databases;
- the quarantine bucket's R2 inventory digest equals the baseline taken at
  apply;
- Cloudflare analytics show no rows written and no invocation of a fenced
  script. These figures are provider-lagged corroboration; the bookmarks are
  the authoritative evidence.

The fence receipt pins the bookmarks the export must use. Apply journals the
prior state, so `release --pre-gcp` restores it exactly. Release is refused once
any gcp-mode version has been deployed since the fence. Apply also requires the
operator's analytics-drain attestation; EP-8 does not prove it. Only the
request-level barrier is reused. The D1 trigger half of the mutation barrier is
not installed, because EP-8 proves quiescence instead.

## 10. Mode transitions

EP-9's matrix allows only these transitions:

| From | To | Condition |
|---|---|---|
| none (pre-edge) | `worker` | The first edge deploy |
| `worker` | `worker` | Redeploy |
| `worker` | `fenced` | Starts the fence |
| `fenced` | `fenced` | Redeploy |
| `fenced` | `gcp` | The switch, after the fence and import |
| `fenced` | `worker` | Abort, only while no gcp-mode version has been deployed since the fence began, and after EP-8 release |
| `gcp` | `gcp` | Redeploy, including web-only releases |
| `gcp` | `fenced` | The brake |

Every other pair is forbidden, including none to fenced, worker to gcp and gcp
to worker. The overlay and the snapshot delta enforce the history-free part of
the matrix on the live state itself. `assertEdgeModeTransition` adds the
history condition for fenced to worker. Worker mode is also refused on any live
state that only a gcp deploy produces, or that lacks the ingestion database.

The rollback policy after the switch is settled (checklist OWN-10, 2026-10-02):
the brake in the table is the only way back, followed by a fix forward. Rolling
back to the Worker is allowed only before the switch (fenced to worker). There
is no authority-write-free window and no flag; a rollback window would need a
new owner decision and a reviewed matrix change.

## 11. Identity split and the contract-blob rule

- **Edge identity** is always the Cloudflare active deployment: exactly one
  version at 100% whose `DEPLOYMENT_SOURCE_COMMIT` and `EDGE_UPSTREAM_MODE`
  plain-text bindings match.
- **Public `/api/health`** is answered by the Worker in worker mode, by barrier
  health in fenced mode and by the Cloud Run origin in gcp mode.
- In worker mode, deploy checks keep today's health-based identity. In fenced
  and gcp modes, E10 takes the predecessor, post-deploy and reconciliation
  identity from the Cloudflare binding instead. In gcp mode it also requires
  public health to report status `ok` with the origin commit that the verifier
  pre-check read from the origin.
- **The contract-blob rule.** E10 refuses `EDGE_CONTRACT_DRIFT` unless the Git
  blob of `apps/worker/src/edge-origin-contract.ts` is identical at the edge
  commit and the origin commit. This is a local Git check. Edge-only and
  web-only releases in gcp mode therefore need no Cloud Run redeploy. Cloud Run
  deploys must apply the same check against the live edge commit.
- **Contract changes.** A behavior both sides depend on, such as the header
  allowlist, is part of the contract and must be reflected in that file. This
  record defines no in-place contract upgrade; one would need its own reviewed
  procedure. Under the blob rule as written, the only path is through the brake
  (gcp to fenced, origin deploy, fenced to gcp), and the forwarded routes are
  unavailable for that window.
- **Fail-closed until a production origin is rolled.** Finding F8 (no
  `/api/ready` on the fast-path origin) is closed in source by D-CRB
  (2026-10-02): the production origin composition (CR-6 and CR-7,
  `HOST_MODE=production|staging`) and the fastpath-test mode serve
  Worker-shaped `/api/health` (RD-3) and `/api/ready` (RD-2). Readiness stays
  `503` until C-MAINT's lifecycle pass has written its rows, so the verifier
  passes only against a rolled production-host revision after its first
  maintenance pass; nothing of that is deployed yet.
- **Gated on the production-zone probe (OD-E6): passed on 2026-10-02.**
  Lifting F8 does not clear the switch by itself. Until the owner had re-run
  the address probe from the `tibotattle.com` zone and recorded a pass
  ([section 5](#od-e6-recommendation-and-gate)), no gcp deploy could run and
  the privacy page could not carry the gcp text (section 12). The owner
  recorded that pass on 2026-10-02
  ([receipt](../receipts/2026-10-02-gcp-edge-ip-probe-production-zone.md)).
  A change to the edge's topology or placement reopens the gate, and a failed
  probe reopens OD-E6's fallbacks. E10 has no code check for this, so it stays
  an owner gate: the operator confirms the recorded pass before the switch.

## 12. Privacy-marker rule

- At the cutover, the hosted-processing paragraph of
  `apps/web/public/privacy.html` is rewritten (OPS-9). It must say:
  - Cloudflare remains the edge: TLS, address-keyed rate limiting, download
    analytics and release hosting;
  - Google Cloud (Cloud SQL and Cloud Storage) holds hosted data;
  - what Google receives of the client's network address, as OD-E6 settles it
    ([section 5](#5-client-address-privacy)). With the recommended topology,
    once the production-zone probe passes, the page may say that the edge
    passes Google no client network address. If the probe fails and the owner
    takes option A, the same wording needs a passing probe of that topology.
    Under option B the page must say that Google's front end receives the
    client's network address in a header Cloudflare adds, and that the origin
    discards it before processing. The page must not claim more than the probe
    showed. The production-zone probe passed on 2026-10-02
    ([section 5](#the-production-zone-probe-2026-10-02)). It observed the
    forward to the origin only, not the token exchange with
    `oauth2.googleapis.com`, so the page's sentence stays scoped to the
    Google Cloud service: that service does not receive the visitor's network
    address.
- The new text carries `data-hosting-topology="cloudflare-edge-gcp-origin"`.
- A gcp deploy requires a candidate site, built from its own source, whose
  privacy page carries the marker (`EDGE_PRIVACY_PAGE_NOT_CUTOVER` otherwise).
- Worker, fenced and pre-gcp web-only deploys refuse a candidate whose privacy
  page carries it (`EDGE_PRIVACY_PAGE_PREMATURE`).
- The page therefore changes in the same deploy as the gcp switch and is never
  inaccurate before it.

## 13. Documented deviations from production behavior

These are deliberate and accepted with this record:

1. Fenced 503 responses carry `retry-after: 300`.
2. The edge's own `503 EDGE_ORIGIN_UNAVAILABLE` and `503 EDGE_NOT_CONFIGURED`
   carry `retry-after: 60`.
3. A forwarded body declared above 8 MiB gets a local `413 BODY_TOO_LARGE` after
   the pre-admission guard and before admission. For `contributions` the guard
   is the Worker's own preflight, so the edge answers exactly as the Worker
   does: 401 for a session cookie, 415 for a non-JSON type, and 413 for any
   declared length above 2 MiB. The same holds for a session cookie on an
   accountless route and a cross-origin enrollment or sign-in start. On every
   other body route the Worker can refuse first, after the edge's guard: on
   configuration or stored state (503), at its limiter (429), at
   authentication (401), or at a later check such as `admin_action`'s CSRF
   (403) or content type (415) on the admin host. There the edge answers 413.
   No shipped client sends a body over 2 MiB.
4. The edge charges a policy route's budget before the Worker's preconditions
   that read configuration or stored state. In `d43c8f92` these come before
   the limiter: the accountless enrollment and ownership modes, the
   enrollment, upload-registration and publication collection controls, the
   hosted sign-in start switch, and the admission-binding checks. A request
   the Worker refuses there spends no budget in the Worker. At the edge it
   spends the per-address budget and the coarse (global) budget of its
   purpose. Each response is still equal, because the origin replays the
   outcome at the Worker's call point. Later requests are not: within the same
   60-second window, a request the Worker would admit can get
   `429 ATTEMPT_LIMIT_REACHED` or `429 UPLOAD_INGRESS_LIMIT_REACHED` from the
   edge. The global budgets are 20 per 60 s for sign-in start, enrollment and
   recovery, so this shows mainly while a collection control or mode is off
   and in the window after it is turned back on. The refusals that depend only
   on the request are answered at the edge before admission and spend nothing
   (step 2 of [forwarded requests](#forwarded-requests); E12's S4 rows). The
   state-dependent ones would need the origin's state before every admission,
   a second round trip per request.
5. Address rate-limit keys are re-derived under `EDGE_CLIENT_KEY_SECRET`, so
   every per-address window resets once, at the gcp switch. Rotating that
   secret resets them again.
6. Edge-local failures write no diagnostic rows. The edge's pre-admission guard
   refusals and its 8 MiB `413` also log no line, where `handleRequest` logs a
   content-free `request_failed` warning for each.
7. `UPLOAD_AUTHORIZATION` and `UPLOAD_PRINCIPAL` become exact, global PostgreSQL
   limits instead of per-location Workers Rate Limiting.
8. In gcp mode, public `/api/health` reports the origin's commit. The edge's
   commit is read from the Cloudflare version bindings.
9. An upload the origin refuses or limits before reading its body is answered
   once the client has finished sending that body, not before. E12 measured
   this in workerd: the origin's 429 reached the edge at once, and the edge's
   answer reached the client only when the held body closed, while the Worker
   answers at once. The 8 MiB forward cap and the origin's own body deadline
   bound the cost.
10. The edge runs the contribution preflight without the upload-ingress
    configuration checks that precede it in the Worker's `handleContribution`.
    If the origin's upload-ingress configuration is invalid, the Worker would
    answer 503 first, while the edge answers a preflight refusal (400, 401, 413
    or 415) itself.

## 14. Relationship to accepted decisions

- **[Append-only contributions](./2026-09-26-append-only-contributions.md).**
  This record specifies its D5: hostnames are kept, a thin Worker proxies to an
  IAM-private origin, admin stays behind Access, and release hosting and
  download analytics stay at Cloudflare. The edge has no withdrawal,
  containment or erasure route (D1). Erasure stays the manual, offline,
  owner-run Variant B procedure (D2), and nothing at the edge performs erasure.
  `DELETE /api/v1/me` stays retired and is answered at the edge as a local
  `404 NOT_FOUND`.
- **[Public upload ingress admission](./2026-08-04-public-upload-ingress-admission.md).**
  In gcp mode only, from the cutover, this record replaces two of its parts. The
  address-keyed contribution limits (its layer 4) are evaluated at the edge and
  replayed at the origin. The identity-keyed registration limits (layer 3) and
  the shared ingress budget (layer 5) move to PostgreSQL at the origin. Its
  client-side layers 1 and 2 and its deferred Queue decision are unchanged. In
  worker and fenced modes it stays fully authoritative.
- **[Self-service deletion retirement](./2026-08-30-self-service-deletion-retirement.md).**
  The retired route stays a `404 NOT_FOUND`. This record changes nothing else in
  it.

## 15. Open owner choices this record does not settle

- OD-E1: the production release line that carries the edge port and E10. It
  must contain `d43c8f92`; merging GitHub `main` first brings its typed
  reconciliation.
- OD-E2: whether `--edge-mode` deploys refuse a source that does not descend
  from the live commit (recommended).
- OD-E3: whether to authorize the optional live check against the GCP test
  project (a GCP write, with a separately authorized write tier).
- OD-E4: the admin, export, security-reset, performance and Apple and Google
  sign-in routes stay outside the fast path. CR-6 and CR-7 own them before any
  gcp switch.
- OD-E5: re-derive EP-1, and `EDGE_PRE_ADMISSION_GUARDS`, if production's
  admission call sites or the request-only guards ahead of them change before
  the switch.
- The HMAC fallback, only if organization policy forbids service-account keys.

## 16. Documentation owed at the cutover

These are integration checklist entries, not part of this record:

- the privacy page rewrite with the marker (OPS-9);
- `SECURITY.md` scope for the edge and the origin boundary;
- [Production service operations](../runbooks/production-operations.md): a
  pointer to the edge-mode runbook and the typed-only deploy rule;
- [System architecture](../reference/system-architecture.md): the topology;
- the [web-only release lane](../runbooks/2026-08-17-web-only-release.md): the
  gcp-mode identity rule and the privacy marker;
- the checked-in `wrangler.jsonc` `main`, after the switch.

## Sign-off

- [x] The owner approved this text in chat, as written, on 2026-10-02.

## Evidence boundary

This record is an accepted decision text. It is not a deployment receipt.
Implementation, local tests, the local end-to-end proof, a staging rehearsal,
the optional live check, the writer fence, the production cutover and public
deployment are separate gates, and this document proves none of them.
