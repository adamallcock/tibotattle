---
title: Hosted Identity Remediation Plan
date: 2026-08-04
type: plan
status: proposed
---

# Hosted identity remediation plan

## Decision

Do not expand the current hosted sign-in or automatic-contribution rollout until
the release gates in this plan pass.  The aim is not to make sign-in more
complicated: a returning contributor should normally see no authentication
prompt at the six-hour contribution interval, and a deliberate interactive
sign-in should use the system browser and complete without a manual polling or
copy/paste step.

Use a hybrid, standards-first approach:

1. Use macOS `ASWebAuthenticationSession` for the app-owned browser launch and
   callback.  It is the platform component intended for this job and keeps
   Google and Apple authentication out of an embedded web view.
2. Retain `oauth4webapi` during the immediate remediation.  It is already the
   maintained standards implementation used to validate issuer, audience,
   JWKS, and signing algorithm.  Fix the missing lifecycle controls around it
   before replacing it.
3. Run a narrow, disposable Better Auth + D1 compatibility spike in parallel.
   Adopt it only if it preserves the privacy model and passes the end-to-end
   gates below.  It is a promising self-hosted component, not a pre-approved
   migration.
4. Do not adopt a managed identity SaaS by default.  Clerk, Stytch, and
   Supabase can reduce implementation work, but they introduce a new processor
   for identity/session data and must be approved separately for privacy,
   data-residency, deletion, outage, and commercial terms.  In particular, a
   browser flow that gives a refresh token to JavaScript is not compatible with
   the target boundary.

The product-specific work that remains is intentionally small: an opaque,
one-use handoff between the system browser and this Mac, a scoped device
capability for automatic contributions, and accurately named disconnect and
deletion flows.  An authentication package cannot safely infer those product
consent and device-ownership rules.

This plan complements and finishes the security direction in the existing
[G3 session/capability plan](./2026-07-25-g3-session-capability-separation-plan.md)
and the native-flow direction in the
[macOS migration plan](2026-08-03-native-first-macos-client-migration-plan.md).
It supersedes any remaining runtime behaviour that forwards a hosted personal
session cookie to HTTP loopback.

## What the audit established

These facts drive the plan:

| Area | Current behaviour | Consequence |
| --- | --- | --- |
| Google OAuth | Server-side confidential authorization-code flow, exact redirect URI, state and S256 PKCE; provider access and refresh tokens are discarded. | This is a strong base. A Google `nonce` is optional for the current code-only flow. |
| Apple OAuth | Server-side authorization-code flow and five-minute client-secret JWT, but no nonce is sent or verified. Provider access and refresh tokens are discarded. | Missing nonce/replay binding is a protocol defect. Discarding the refresh token leaves no verified Apple-token-revocation path for account deletion. |
| OIDC verification | `oauth4webapi` pins issuer, JWKS, audience, and `RS256`; it explicitly expects no nonce. | Apple nonce support needs an intentional contract and tests, not a cosmetic parameter. |
| Stored provider data | D1 stores short-lived handoff state/proof, the Google PKCE verifier, and an HMAC-derived identity link key. It does not retain raw provider tokens, email, or name. | Preserve this data-minimising identity model wherever a component is introduced. |
| Hosted browser session | A hash-backed, non-sliding `Secure; HttpOnly; SameSite=Strict; __Host-` cookie lasts 30 minutes. | It is unrelated to the six-hour contribution cadence, but it currently has a misleading local sign-out path. |
| Automatic contribution | A separate Keychain-backed device credential lasts 30 days and is used to mint short upload authority. | It does not require Google or Apple authentication every six hours. It is the correct idea, but its account-switch lifecycle is incomplete. |
| Local bridge | The companion proxies the hosted `Set-Cookie` header to `http://127.0.0.1`. Browser cookies are host- rather than port-scoped; a local browser proof showed a cookie set on one loopback port was sent to another. | This is the most serious architecture problem: another local service can receive a hosted personal-session cookie. |
| Sign-out and switching | UI sign-out clears JavaScript state only. The server cookie and device credential can remain live; a different account cannot take over the same device identifier cleanly. | The UI can say “not signed in” while private access and background contribution remain attached to the previous account. |
| Observability | Worker invocation logging is enabled in source configuration. A Google callback carries an authorization code and state in its query string. | Platform request-URL logging can retain OAuth material even though application logs are clean. |
| Deletion and retention | Authorities are revoked, but the deletion tombstone is development-oriented and is not purged according to a production retention policy. | “Delete” needs a bounded, documented live-data and backup policy. |

## Target user journey

The following is the product contract.  It is deliberately more important than
matching today’s implementation details.

### First connection

1. The app explains what will be shared and asks the user to choose Apple or
   Google.
2. The native app opens the provider journey through `ASWebAuthenticationSession`.
   The user sees the provider in their normal browser context, not an embedded
   `WKWebView`. Existing provider SSO should make a returning-provider user a
   one-approval journey unless the provider requires a challenge.
3. The Worker completes the OAuth exchange and token validation server-side.
   It redirects only an opaque, one-use completion ticket to the app callback;
   the callback never contains an OAuth code, ID token, access token, refresh
   token, session cookie, email, or provider subject.
4. The app redeems that ticket immediately over TLS with proof that it owns the
   installation key created for this Mac. It receives only the scoped native
   authority needed to pair/manage its contribution device.
5. The app confirms “Connected” and starts the user-approved contribution
   schedule. There is no “I have signed in; click here to poll again” control
   in the success path.

If the user cancels, the app returns to the unchanged connection screen. If a
network or callback failure occurs, it gives one clear retry action and leaves
the previous connected state untouched. A visible “Checking sign-in” state is
permitted only while the native completion is in flight; it is not a permanent
polling affordance.

### Normal six-hour renewal

Automatic renewal uses the existing device-scoped authority, not a browser
cookie and not a Google or Apple token. It can run while the user is away from
the app until the user disconnects the Mac, revokes it remotely, or its device
credential reaches its bounded renewal/expiry policy. It must not open a
browser or surprise the user every six hours.

When device authority is nearing expiry, the app should renew it silently when
the user has an active, valid device proof. If reauthentication is actually
needed, show a contextual “Reconnect to keep sharing” card before the schedule
stops, rather than failing a background upload without explanation.

### Returning interactive session

The public HTTPS portal may hold a browser-only session with an **eight-hour
idle lifetime and a 24-hour absolute lifetime**. It must be `Secure`,
`HttpOnly`, host-prefixed, and never accepted or forwarded by loopback. The
native contribution capability is not a substitute for a full portal session.

High-impact actions — export of detailed data, deletion, recovery changes,
and changing the connected account — require recent authentication (for
example, an OAuth authentication completed within the preceding ten minutes).
This keeps routine use smooth while making a stolen unlocked device or a stale
browser session materially less useful.

### Disconnect, sign-out, and account switching

Use names that reflect what the action actually does:

| User action | Result |
| --- | --- |
| **Disconnect this Mac** | Stops the schedule first, self-revokes the remote device authority, deletes the Keychain secret and local binding, revokes the local native-management capability, and clears the portal session on the public HTTPS origin. It is the normal native-app “sign out”. |
| **Switch account** | Performs the same disconnect transaction, confirms it succeeded, then launches a new Apple/Google connection. Cancelling the new sign-in leaves the Mac disconnected; it must never silently resume sending to the old account. |
| **Sign out of web portal** | Revokes only the public HTTPS portal session. If automatic contribution remains enabled, the UI says so plainly and links to “Disconnect this Mac”. |
| **Delete account and local connection** | Requires recent authentication, revokes every session/device authority, invokes provider-token revocation where applicable, removes local secrets, deletes live app data, and gives a retention receipt. |

The device itself must be able to execute its own revocation with proof of
possession even after a browser session expires. Requiring an expired account
cookie merely to stop background sharing is both insecure and frustrating.

## Target authority boundaries

| Authority | Stored where | Lifetime and scope | Explicitly not allowed |
| --- | --- | --- | --- |
| Google/Apple authorization code, ID token, access token | Worker request memory only, except the Apple deletion-revocation exception below | Single OAuth transaction | Local server, web JavaScript, custom URL callback, logs, D1 identity rows |
| OAuth state, Apple nonce, Google PKCE verifier | Short-lived server-side handoff record; state is stored as a hash, while the Apple nonce and Google verifier are encrypted while live or safely derived server-side | Five minutes; one use; atomically consumed or cancelled | Reuse, long-term retention, browser local storage |
| Public portal session | First-party HTTPS cookie only | Eight-hour idle / 24-hour absolute; revocable server-side | Loopback forwarding, native WebView cookie access, automatic-contribution authentication |
| Native completion ticket | Server-side hash plus opaque callback value | 60 seconds, one use, bound to the installation public-key thumbprint | OAuth/provider data, reusable bearer credential, logging |
| Native management capability | Keychain, proof-of-possession bound to a per-installation key | Short session; narrow account/device-management scope | Browser cookie equivalence, raw storage in the dashboard or local HTTP service |
| Contribution device authority | Keychain and a server-side verifier/revocation record | 30 days maximum until the bounded renewal design is approved; upload and self-revoke only | Portal export/delete access, account switching without explicit disconnect |
| Apple refresh token, if needed for deletion | Dedicated encrypted token vault keyed by the pseudonymous link key | Only until successful provider revocation or account deletion | General identity tables, logs, analytics, client delivery |

### Browser-to-native handoff design

The exact protocol should be threat-modelled before implementation, but it must
satisfy all of these constraints:

- At the start of a flow, the app creates or loads a non-exportable Keychain
  installation key and registers only its public-key thumbprint with the
  short-lived server handoff.
- OAuth state is high entropy, single-use, and server verified. Google retains
  S256 PKCE. Apple receives a high-entropy nonce and the returned ID token is
  verified against its expected nonce.
- After the server validates the provider response, it creates an opaque
  completion ticket whose server record is bound to the handoff, provider, and
  installation-key thumbprint. The callback contains only that ticket.
- Treat a custom URL scheme as transport rather than proof of app identity. A
  competing URL handler may observe the ticket but cannot redeem it without the
  installation-key proof; prefer an associated-domain callback if it can be
  made reliable on supported macOS versions.
- The native app redeems the ticket over TLS with a standard
  proof-of-possession mechanism (evaluate DPoP support from a maintained
  library rather than inventing a request-signing format). A 60-second ticket
  cannot be replayed from another process or after consumption.
- The Worker creates the browser portal cookie only on its public HTTPS
  origin. The local companion must never relay a `Set-Cookie` header, accept a
  hosted cookie, or proxy a personal portal API with that cookie.
- The current fixed-origin local server remains useful for local collection and
  app assets, but it holds no hosted identity/session authority.

This creates two deliberate sessions instead of one unsafe bridged session:
the browser portal session and the native device capability. Their scopes are
different, so losing one does not accidentally grant the other.

## Immediate security controls

These are release blockers and should be implemented before a framework
migration is allowed to obscure the underlying defects.

1. **Remove the loopback cookie bridge.** Delete the response-header forwarding
   path and reject hosted-cookie-bearing requests at the local companion. Add
   an integration test with two distinct loopback ports proving that no hosted
   cookie is sent to either one.
2. **Add and verify Apple nonce.** Generate an Apple nonce per handoff, send
   the raw nonce in the authorization request, and retain it only in an
   encrypted five-minute handoff record (or derive it safely from a server
   secret and validated state). Configure OIDC verification to require the
   expected nonce for Apple only. Add replay, missing-nonce, mismatched-nonce,
   and valid-nonce tests. Keep Google code-only behaviour separate rather than
   accidentally imposing an unsupported contract on it.
3. **Contain OAuth values in logs.** Put OAuth callback handling in a Worker or
   route configuration where invocation/request-URL logging is disabled, or
   otherwise configure the platform so callback URLs and request bodies are
   never retained. Confirm the effective production setting in the Cloudflare
   dashboard, not only source configuration. Review current retention and
   access to historical callback logs, then rotate any credential whose
   exposure cannot be ruled out. Application logs must continue to record only
   route class, result class, request ID, and safe error code.
4. **Make cancellation real.** Add an authenticated, rate-limited cancellation
   endpoint that atomically consumes/cancels the handoff and completion ticket.
   The client cancellation button must call it; closing a window must not leave
   a redeemable sign-in result for five minutes.
5. **Fail closed in production.** Make `IDENTITY_TEST_JWKS_JSON` unreachable in
   production builds/environments, validate all required identity secrets at
   Worker start-up, and add a deployment test that rejects test issuers or
   test JWKS overrides in production.
6. **Rate-limit public handoff endpoints.** Use a bounded per-IP and
   per-installation baseline for start, callback/result, claim, and cancel
   paths. Preserve a short, fixed retry interval only where the native client
   actually needs it; do not leave an unauthenticated result endpoint
   unbounded merely for polling convenience.
7. **Repair the full Worker test fixture.** The current identity test aggregate
   is blocked by a new upload-admission configuration requirement in the dirty
   worktree. Update the shared fixture or inject the explicit test binding so
   identity tests again exercise their complete routes. This is a test-harness
   repair, not a reason to reduce coverage.
8. **Harden public-session use.** Rotate the portal session on successful
   authentication and recent-authentication step-up; reject cross-origin CORS,
   verify `Origin`/`Host` and a CSRF defense on state-changing requests, and
   keep server-side revocation checks on every authenticated request. A
   `SameSite=Strict` cookie is a valuable layer, not the only CSRF control.

## Component strategy: use rather than rebuild

| Component / option | What it can safely own | Decision | Gate before use |
| --- | --- | --- | --- |
| `ASWebAuthenticationSession` | System-browser presentation, app-owned callback delivery, cancellation and completion UX on macOS | **Adopt now** | Packaged/signed-app tests for Apple and Google success, cancellation, timeout, relaunch, and callback ownership |
| Existing `oauth4webapi` | OAuth metadata and authorization-response validation, JWKS signature verification, issuer/audience/nonce checks, PKCE primitives | **Keep during remediation** | Patch Apple nonce and add adversarial tests; pin/update deliberately with release notes reviewed |
| macOS Keychain / Secure Enclave where available | Non-exportable installation key and minimal native/device secrets | **Use now** | Keychain access-group, uninstall/reinstall, backup/restore, and locked-device behaviour verified |
| Cloudflare Worker/D1 plus a real secret-encryption boundary | Short-lived handoffs, hashes, session/device revocation, minimal encrypted Apple revocation secret | **Use with tightened controls** | No plaintext provider token in D1/reporting/logs; versioned key rotation and least-privilege operation demonstrated |
| Better Auth with D1 | Social-provider callback/session lifecycle and standard account/session tables, if compatible | **Timebox a spike** | See the proof criteria below; no production user data or cutover during the spike |
| Clerk, Stytch, or Supabase Auth | Managed social identity and sessions | **Hold** | Explicit privacy/DPA/data-residency/egress approval, deletion audit, cost/outage review, and proof that client refresh tokens and unnecessary identity fields can be avoided |
| Ory | Mature identity deployment option | **Defer** | Only revisit if regulated/enterprise requirements justify its operational footprint |

### Better Auth D1 proof of compatibility

Run this in a disposable Worker, separate D1 database, and test Apple/Google
application credentials. It must not receive production identities or device
secrets. The spike is successful only if it proves all of the following:

- Google and Apple use a system-browser/native callback journey without an
  embedded user agent, and all provider exchange material stays server-side.
- State and nonce are generated, validated, expired, and replay-protected;
  session rotation and revocation are observable and testable.
- Its D1 schema can avoid retaining raw email, name, profile, provider access
  token, and refresh token by default. If an Apple refresh token is required,
  it can be isolated in the approved encrypted vault rather than a broad
  account table.
- The app can map its existing HMAC-derived `identity_link_key` to the new
  component without exposing the raw provider `sub` or creating duplicate
  accounts.
- The public HTTPS cookie remains browser-only, and the custom completion
  ticket plus native proof-of-possession flow still works.
- The six primary flows in the acceptance table pass in a signed macOS build,
  and the resulting bundle/runtime cost is acceptable.
- It has a pinned version, reviewed migration, upstream maintenance signal,
  and a rollback path.

If any one of these fails, retain the hardened `oauth4webapi` implementation.
That is a valid outcome: the immediate security fixes do not depend on a
framework migration.

## Delivery phases

### Phase 0 — containment and design freeze

**Owner areas:** release, Worker identity, macOS, privacy/operations.

- Treat new hosted enrollment and any expansion of automatic contribution as
  release-gated until Phase 1 and Phase 2 pass. Local-only collection remains
  independent of this decision.
- Write a concise threat model covering another local process, malicious URL
  handler, stolen unlocked Mac, OAuth-code replay, stale browser cookie, device
  cloning, provider-account change, and operator/log access.
- Establish the data inventory: each D1 table, Keychain item, R2 object,
  Cloudflare log class, backup, and third party that may receive identity or
  contribution data. Mark data owner, purpose, TTL, deletion action, and
  restore behaviour.
- Decide and record the production backup-retention horizon before making a
  deletion guarantee. The existing
  [retention and restore plan](./2026-07-26-backend-retention-and-restore-safety-plan.md)
  is the starting point, not a production policy.
- Create a feature flag with only safe states: `disabled`, `native_ticket`,
  and (after the spike) `better_auth`. Do not retain an `unsafe_loopback_cookie`
  rollback state.

**Exit gate:** written threat model and data inventory approved; no release
claim is made from source code alone.

### Phase 1 — protocol, observability, and lifecycle correctness

**Owner areas:** Worker identity and test suite.

- Implement the immediate controls above.
- Store only hashes for OAuth state and completion tickets where a raw value is
  not required for redemption. Encrypt any Apple nonce or PKCE verifier that
  must be recovered (or safely derive it server-side), expire it aggressively,
  and delete it atomically on every result.
- Split provider-specific validation contracts: Apple has required nonce;
  Google preserves state + S256 PKCE and validates the ID token claims already
  pinned by the Worker.
- Introduce server-side session/device revocation timestamps and session IDs so
  logout, disconnect, credential rotation, and account deletion immediately
  invalidate old authority rather than merely hiding it in the UI.
- Add bounded garbage collection for expired handoffs, sessions, device rows,
  result receipts, and revoked-token metadata. It must be idempotent and must
  record aggregate counts only.

**Exit gate:** automated unit, integration, and negative tests pass; effective
production logging configuration has been independently checked; no OAuth
code/state/session cookie appears in a representative log export.

### Phase 2 — remove the bridge and ship the frictionless native flow

**Owner areas:** macOS app, local companion, Worker identity.

- Build `HostedFlowCoordinator` around `ASWebAuthenticationSession`; preserve
  the existing user-facing dashboard and use the coordinator only for hosted
  identity/contribution journeys.
- Implement opaque completion-ticket creation and atomic native claim. Bind
  the ticket to the initiating installation public key and use a maintained
  proof-of-possession implementation for claim and native session requests.
- Stop using `WKWebView` cookies for hosted identity. The dashboard may remain
  a non-persistent, local presentation surface, but it cannot carry a hosted
  personal session.
- Delete the local companion routes/header handling that forward or accept the
  public session cookie. Add a hard regression test that fails on any hosted
  `Set-Cookie` reaching a local HTTP response.
- Replace visible polling with native callback completion. Keep a bounded
  recovery check only for an interrupted callback, with an explicit timeout and
  server cancellation.
- On first launch after upgrade, identify legacy connected devices. Show a
  clear, one-time “Securely reconnect this Mac” action before extending their
  authority; never silently convert a legacy cookie/session into a new native
  capability.

**Exit gate:** the signed application proves that provider material and hosted
cookies never appear in the loopback network trace; success, cancellation,
timeout, relaunch, and retry are understandable without support intervention.

### Phase 3 — disconnect, switch, and deletion as transactions

**Owner areas:** Worker identity, contribution/device code, macOS UX.

- Implement a device self-revocation endpoint authenticated by the device
  proof, so disconnect works even with an expired portal session. Make it
  idempotent and return a safe receipt.
- Implement `Disconnect this Mac` as a durable state machine: pause schedule;
  revoke server authority; remove Keychain items/local binding; revoke public
  session; verify no queued contribution can be sent; show completion. On a
  partial failure, retain a local recovery record and retry revocation before
  saying the Mac is disconnected.
- Implement `Switch account` as disconnect followed by a new native provider
  flow. Generate a new device identifier only after the old binding is
  definitely revoked, preventing the current primary-key collision and
  accidental attribution to the old account.
- Give web-only logout a separate endpoint that invalidates the actual server
  session and clears its cookie. Do not label a JavaScript state reset as
  logout.
- Require recent authentication and an explicit confirmation for account
  deletion. Deletion revokes browser, native, device, queued-upload, and
  recovery authorities before live data removal.

**Exit gate:** a disconnected or switched Mac cannot make an upload as the old
account; reloading the portal cannot restore a supposedly signed-out session;
each partial failure has an actionable, non-destructive recovery path.

### Phase 4 — Apple revocation and production data lifecycle

**Owner areas:** identity, privacy/operations, security review.

- Validate Apple’s required account-deletion/revocation behaviour with the
  official sandbox and a test account. Record exactly which token is returned,
  when it is issued, and how a repeat sign-in behaves after revocation.
- Store the Apple refresh token only if it is required to invoke provider
  revocation. Place it in a dedicated token vault with a pseudonymous link key,
  authenticated encryption, versioned keys, rotation procedure, strict access
  path, and audit events that never include the secret. Do not put it in a
  general D1 account row or browser/native storage.
- If the Better Auth spike cannot meet that vault boundary, retain direct token
  handling only in the narrow Worker service that performs revocation. Do not
  allow framework convenience to widen token access.
- Set and publish the production deletion contract: live data removed promptly;
  a minimal HMAC tombstone retained only long enough to reject stale authority;
  backups purge within the verified backup horizon. A new, legitimate sign-in
  after deletion must create a clean generation rather than revive old data.
- Add a scheduled purge with metrics for overdue tombstones, expired sessions,
  revoked devices, and encrypted Apple token records. Alert on failures but do
  not emit identity identifiers.

**Exit gate:** a deletion exercise in non-production demonstrates provider
revocation (where applicable), immediate authority invalidation, live-data
removal, bounded tombstone purge, and the documented backup path.

### Phase 5 — component decision, migration, and staged release

**Owner areas:** architecture, Worker identity, release, QA.

- Complete the Better Auth D1 spike and write a short accept/reject decision
  with the evidence listed above. Do not make a framework choice based only on
  documentation or marketing claims.
- If accepted, migrate with a one-way, reviewed mapping that keeps the
  existing HMAC identity-link key as the canonical join key. Run the new path
  for a small opt-in cohort first; compare only safe aggregate outcome metrics.
- If rejected, keep the hardened direct implementation and revisit a managed
  provider only after explicit processor approval. This is not a failure and
  does not block the security remediation.
- Roll out behind the safe feature flag to internal accounts, then a reversible
  small cohort, then general availability. On any auth/attribution anomaly,
  stop new enrollment and preserve local collection; do not fall back to
  loopback cookies.

**Exit gate:** production release review has current evidence from the deployed
Worker configuration and a signed build, not just source tests.

## Migration and compatibility rules

- Do not silently transfer a current browser session to native authority. A
  user-visible secure reconnect is required because the old bridge had a
  different trust boundary.
- Keep existing HMAC identity-link keys stable so that a legitimate reconnect
  maps to the correct account without needing email/name collection.
- Dual-read legacy device authority only for a short, measured migration window.
  Legacy authority may upload only to its already-bound account; it cannot
  create a new portal session, switch account, or renew indefinitely.
- Do not delete a local Keychain device secret until the server has confirmed
  revocation, unless the user explicitly chooses an offline emergency removal.
  In that case, leave an obvious “remote disconnect pending” recovery record.
- A failed migration must leave the user either safely connected to the same
  account under the legacy bounded credential or clearly paused; it must never
  send to an unknown account.

## Verification and acceptance criteria

| Scenario | Required evidence | Passing result |
| --- | --- | --- |
| Google first connection | Signed macOS app and Google test account | System browser completes; callback contains only opaque ticket; no provider material/local cookie observed |
| Apple first connection | Signed macOS app and Apple sandbox/test account | Same as Google, plus valid nonce accepted and missing/replayed nonce rejected |
| Six-hour automatic contribution | Controlled clock/device test and network trace | No browser launch or provider call; only scoped device/upload authority is used |
| Expired portal session | Browser and native-app test | Portal asks to reauthenticate when needed; automatic contribution remains correct and clearly labelled |
| Disconnect this Mac | Online and offline/interrupted transaction tests | Future contribution is blocked for the old account; Keychain/local state and server receipt agree or recovery is explicit |
| Switch account | A then B account test on the same Mac | A is disconnected before B is paired; no collision, invisible A upload, or ambiguous success state |
| Web sign-out | Browser reload and API test | Server session is revoked; reload does not restore private access |
| Account deletion | Staging data/lifecycle exercise | All authorities revoked, provider revocation handled where applicable, live data gone, retention receipt correct |
| Loopback isolation | Chromium plus packaged WebKit/WKWebView test, two-port probe | No public session cookie or personal endpoint authorization reaches any loopback port |
| Logging | Effective Cloudflare configuration plus representative log export | No OAuth code/state, cookie, provider token, email, or raw provider subject is retained |
| Abuse controls | Automated limit/replay tests | State, nonce, ticket, device authority, and result endpoints are one-use/bounded/rate-limited as designed |
| Regression suite | Worker, local companion, web, native, and upload-admission fixtures | All relevant suites pass without weakening existing security assertions |

Track only privacy-safe aggregates during rollout: flow started/completed/cancelled/expired, callback latency buckets, reconnect success, disconnect completion, and server-side rejection reason class. Never attach them to email, raw subject, token, code, cookie, or full URL.

## Open decisions that must be closed before general availability

1. Which maintained library will provide the native proof-of-possession support
   and server verification, and does it work in the selected Worker runtime?
2. Is Better Auth accepted after the isolated D1 proof, or is the hardened
   direct `oauth4webapi` path retained?
3. Which managed encryption/key-rotation boundary is approved for the minimal
   Apple refresh-token vault, and what operational access does it permit?
4. What is the verified backup-retention horizon, and therefore the exact
   deletion/tombstone wording shown to users?
5. Which actions count as high impact for recent-authentication purposes once
   the personal portal’s final data surface is fixed?
6. Does the signed production macOS build exhibit the same loopback and
   callback behaviour as the test environment? This must be demonstrated, not
   inferred from Chromium alone.

## Primary-source basis

- [Google OpenID Connect reference](https://developers.google.com/identity/openid-connect/reference)
  and [Google OAuth policy](https://developers.google.com/identity/protocols/oauth2/policies)
  for state, redirect, user-agent, and nonce guidance.
- [RFC 9700: OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700.html)
  for S256 PKCE and authorization-code protections.
- [Apple: incorporating Sign in with Apple into other platforms](https://developer.apple.com/documentation/signinwithapple/incorporating-sign-in-with-apple-into-other-platforms?changes=_6),
  [verifying a user](https://developer.apple.com/documentation/signinwithapple/verifying-a-user),
  and [TN3194 account deletion/token revocation](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple)
  for nonce verification and deletion/revocation responsibilities.
- [Apple `ASWebAuthenticationSession`](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession?changes=_1%2C_1)
  for the macOS system-browser authentication session and callback model.
- [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
  for the distinction between application logs and invocation/request logging.
- [Better Auth database adapters](https://better-auth.com/docs/concepts/database),
  [security reference](https://better-auth.com/docs/reference/security), and
  [social providers](https://better-auth.com/docs/basic-usage) for the D1
  proof-of-compatibility criteria; these are inputs to the spike, not evidence
  that its defaults meet this product's privacy boundary.
