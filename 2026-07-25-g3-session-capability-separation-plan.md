---
title: G3 Session and Upload Capability Separation Plan
date: 2026-07-25
type: plan
status: completed-development
---

# Outcome

Turn the current central-service prototype into a locally verifiable, production-shaped backend without enabling public collection.

The completed checkpoint must let us run the real Worker locally and prove, through HTTP rather than direct function calls, that it can:

1. enroll or recover a participant without placing a reusable personal bearer credential in browser storage;
2. issue an independent, narrowly scoped, one-use upload authorization;
3. accept only a bounded encrypted metadata envelope;
4. validate, deduplicate, quarantine, and ingest the envelope into local D1 and R2;
5. recompute private participant statistics and privacy-suppressed community statistics;
6. expose private contribution status, insights, export, and deletion only to the correct participant;
7. revoke sessions and upload authority on recovery, security reset, logout, expiry, or participant deletion; and
8. leave a deterministic test and verification receipt that another developer can run.

This remains a development checkpoint. The Worker stays unrouted, public collection stays disabled, and no real participant data is accepted.

# Product boundary

The deployed personal portal and its authenticated API will share one HTTPS Worker origin. The local dashboard remains a local evidence and collection surface. It will not proxy personal session cookies through plain HTTP loopback.

The boundary is intentional:

- the personal portal owns enrollment, recovery, personal statistics, exports, deletion, and security controls;
- the local collector owns source-log discovery, stripping, local validation, review, and envelope encryption;
- uploads use a separate short-lived authorization that cannot read personal data;
- the current unauthenticated aggregate endpoint exposes only a clearly
  labelled, thresholded development diagnostic and is not publication-safe;
- the current loopback relay may expose health and development aggregate
  reads, but it must not become a general authenticated proxy.

# Security contract

## Web session

- A web session is an opaque random identifier and secret stored hash-only in D1.
- The browser receives it only as a `__Host-` cookie with `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/`.
- The session has a short absolute expiry and may not silently become a long-lived credential.
- Private responses use `Cache-Control: no-store`.
- The cookie authenticates personal reads only. It does not authorize an upload by itself.
- Logout revokes the current session and clears the cookie.
- Security reset revokes every session and every unused upload authorization.

## CSRF

- Every session-authenticated mutation requires a session-bound CSRF value.
- The server also requires the configured same-origin `Origin`.
- Enrollment and recovery use a pre-session same-origin request contract and do not accept cross-origin browser requests.
- CSRF values are not stored in persistent browser storage, URLs, logs, exports, filenames, or analytics.

## Upload authorization

- A logged-in participant registers exactly one intended encrypted envelope.
- Registration binds an opaque one-use upload authorization to:
  - the participant;
  - the envelope digest;
  - the exact byte size;
  - `application/json`;
  - an expiry; and
  - unused state.
- `POST /api/v1/contributions` accepts only this upload authorization and omits the personal session cookie.
- The authorization cannot read, export, delete, recover, register another upload, or derive another authority.
- Acceptance consumes the authorization atomically. Expired, replayed, revoked, differently scoped, or concurrently reused authorizations fail closed.

## Recovery

- Recovery codes remain random and hash-only server side. The old code alone
  is single-use; only an independently bound attempt value permits the bounded
  exact-response retry described below.
- Successful recovery rotates the recovery code, revokes prior sessions and upload authorizations, creates a fresh session, and displays the replacement recovery code once.
- Losing both the active session and the latest recovery code is intentionally unrecoverable in the anonymous design.

## Deletion

- Participant deletion first marks the participant deleting and invalidates all sessions and upload authorizations.
- Stored contribution metadata and quarantined objects are removed using the existing retryable deletion flow.
- Completion removes the participant and dependent authority rows.
- A deleted participant cannot recover or authenticate.

# Data and migration work

Add an additive D1 migration with:

## `web_sessions`

- opaque ID;
- participant foreign key;
- session secret hash;
- CSRF hash or binding;
- issued, expiry, revoked, and last-used timestamps;
- active/revoked state; and
- indexes for participant cleanup and expiry.

## `upload_authorizations`

- opaque ID;
- participant foreign key;
- secret hash;
- intended envelope digest;
- exact body byte count;
- content type;
- issued and expiry timestamps;
- unused/consumed/revoked state; and
- optional consumed contribution ID for an auditable replay decision.

The existing participant access-token columns may remain temporarily for migration compatibility, but no browser route may issue or accept that legacy credential after this checkpoint. Removal requires a later table rebuild and is not necessary for the security boundary.

# API work

## Session and identity

- `POST /api/v1/enroll`
  - validates consent and optional invite;
  - creates participant, recovery code, and web session;
  - sets the session cookie;
  - returns participant ID, CSRF value, and one-time recovery code;
  - never returns an access token.
- `POST /api/v1/recover`
  - validates and consumes the recovery code;
  - binds any bounded lost-response replay to an independent high-entropy
    recovery-attempt value;
  - rotates recovery, sessions, and uploads;
  - sets a new session cookie;
  - returns a replacement one-time recovery code and CSRF value;
  - when deletion is already in progress, issues only a `deletion_only`
    session that can resume deletion but cannot restore personal access.
- `GET /api/v1/session`
  - authenticates the cookie;
  - returns bounded session/participant state and a current or rotated CSRF value.
- `POST /api/v1/logout`
  - validates CSRF;
  - revokes the current session;
  - clears the cookie.
- `POST /api/v1/me/security-reset`
  - validates CSRF;
  - revokes other sessions and all unused upload authorizations;
  - rotates recovery;
  - preserves or replaces the current session by an explicit tested rule.

## Upload and contribution

- `POST /api/v1/me/upload-authorizations`
  - requires session, same-origin, and CSRF;
  - validates digest, byte size, and content type;
  - returns one short-lived upload authorization.
- `POST /api/v1/contributions`
  - requires only `Authorization: Upload ...`;
  - rejects personal session authority as upload authority;
  - verifies the exact encrypted body scope before decrypting;
  - atomically consumes the authorization around idempotent ingestion.
- Contribution reads and deletes remain private session operations.

## Personal and community outputs

- Personal statistics, insights, contribution status, export, and deletion use only the web session.
- The current live community calculation remains a local-development diagnostic.
  Minimum-participant and eligibility rules prevent the simplest small-cohort
  disclosure, but do not make a changing cumulative total safe to publish.
- A participant pilot must replace that live response with delayed, immutable,
  non-overlapping weekly snapshots. Every released cell needs independent
  participant support, per-participant clipping, coarse rounding, a fixed
  ingestion cutoff, and withdrawal rather than same-window recomputation after
  deletion.
- Every private response is non-cacheable.
- Error responses remain fixed, bounded, and non-reflective.

# Browser work

- Remove `SESSION_KEY`, browser-stored access tokens, and Bearer-based personal requests.
- Use same-origin cookie credentials for session and personal endpoints.
- Keep the CSRF value in memory only and recover it from `GET /api/v1/session` after reload.
- Register an upload authorization, then upload with `credentials: "omit"` and only the one-use Upload header.
- Add recovery, sign-out, security reset, and rotate-recovery controls.
- Show a recovery code only in a one-time save/acknowledge flow.
- Preserve the existing local dashboard, real-vs-demo labeling, rolling quota views, weekly estimates, gaps, and privacy review.

# Local versus hosted UI

The production-shaped authenticated personal portal is served by Worker `ASSETS` over the same HTTPS origin.

The loopback app:

- continues to show local-only evidence and collector results;
- may read health and the thresholded development aggregate endpoint;
- does not receive, forward, persist, or transform central session cookies;
- does not spoof central `Origin`; and
- may hand off an encrypted envelope through an explicit user action to the hosted upload flow, but that handoff protocol is a separate reviewed slice.

For this checkpoint, the full server lifecycle is exercised directly against local Wrangler HTTP. A development-only test client owns its cookie jar; that test mechanism is not shipped to browsers.

# Verification matrix

## Worker unit and integration tests

- exact cookie attributes and clearing;
- absolute expiry, revocation, logout, and session fixation resistance;
- recovery rotates recovery/session/upload authority and provides only a
  bounded, exact-material retry for a lost successful response;
- missing, wrong, stale, or cross-origin CSRF rejection;
- personal responses are `no-store`;
- no session, recovery, CSRF, or upload secret appears in logs or exports;
- a web session cannot upload;
- an upload authorization cannot access personal routes;
- upload digest, size, type, expiry, replay, and concurrent-use enforcement;
- participant deletion invalidates every authority;
- invite-only and disabled enrollment behavior remains intact;
- aggregate minimum-participant suppression remains intact for the
  local-development diagnostic; no test treats that live result as
  publication-safe.

## Browser tests

- browser-client contract tests prove no `localStorage`, `sessionStorage`, or
  personal Bearer credential remains; personal calls use same-origin cookie
  credentials; mutations use the in-memory CSRF value; and uploads omit cookies
  and use only a one-use Upload authorization;
- static UI-contract tests prove that the recovery, reset, logout, export, and
  deletion controls are present and that the app source wires the reviewed
  client operations; and
- loopback rendered QA proves control presence and layout only. A staged
  same-origin HTTPS preview must execute recovery, upload, reset, logout,
  export, and deletion in a real browser before a participant pilot.

## HTTP backend smoke

Run Wrangler with local D1 and R2, then prove:

1. health and envelope-key retrieval;
2. invite enrollment and cookie issuance;
3. session probe and CSRF behavior;
4. one-use upload registration;
5. encrypted contribution upload;
6. exact replay and conflicting-scope rejection;
7. personal contribution status and recomputed statistics;
8. privacy-suppressed then eligible aggregate statistics;
9. bounded export;
10. recovery rotation and old-authority rejection;
11. deletion and post-delete HTTP rejection.

The script must fail on unexpected HTTP status, response shape, cookie
attribute, cache policy, or leaked authority value. The documented post-run
operator check, run after stopping Wrangler against the same isolated state,
independently verifies the expected D1 row counts and R2 object cleanup; it is
not currently performed by the HTTP script itself.

# Release gates

## Gate A — architecture

- session and upload authority are distinct;
- personal UI is same-origin HTTPS;
- loopback authenticated proxying is removed or explicitly blocked;
- threat model and migration are reviewed.

## Gate B — implementation

- migration, Worker routes, browser client, controls, and tests are implemented;
- focused type, unit, UI, and relay tests pass.

## Gate C — adversarial verification

- authority confusion, CSRF, replay, expiry, concurrency, deletion, and leakage tests pass;
- the complete HTTP smoke passes against fresh local persistence.

## Gate D — release decision

- a dated verification receipt records exact commands and results;
- the Worker remains unrouted and real-data collection disabled;
- public deployment requires a separate consent, retention, operator-access, incident, and deletion readiness decision.
- public aggregate deployment additionally requires immutable delayed snapshots;
  live cumulative aggregate differencing is not an accepted release design.

# Work order

1. Freeze this contract and map every current Bearer-based path.
2. Add the D1 authority schema and repository primitives.
3. Implement session, CSRF, recovery rotation, logout, and security reset.
4. Implement scoped one-use upload registration and consumption.
5. Convert every private and contribution route to the new authority boundary.
6. Convert the browser client and add missing account/security controls.
7. Remove authenticated personal routes from the loopback relay.
8. update the HTTP smoke to own a cookie jar and exercise real local D1/R2.
9. run focused and full product checks.
10. write the verification receipt and explicitly decide whether hosted testing is safe to begin.
