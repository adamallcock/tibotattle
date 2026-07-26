---
title: G3 Session and Upload Capability Separation Verification Receipt
date: 2026-07-25
type: verification
status: passed-development
---

# Decision

The production-shaped local backend checkpoint passes.

This receipt does not authorize a public route, production deployment, real
participant collection, or volunteer upload. It proves that the central
service can be exercised locally through real HTTP, D1, R2, and Worker assets
without using the prototype's browser-stored personal bearer capability.

The current changing community totals are a development diagnostic, not a
publication-safe aggregate. A three-participant gate does not prevent
before/after differencing or one participant dominating a total. A public
pilot therefore remains blocked on delayed, immutable, non-overlapping weekly
snapshots with independent per-cell support, per-participant clipping, coarse
rounding, and a fixed ingestion cutoff.

# Verified architecture

## Personal web access

- Enrollment returns no access token.
- The server creates a 30-minute, hash-only D1 web session.
- The browser receives the session only in the
  `__Host-usage_monitor_session` cookie.
- The cookie is `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/`.
- Personal reads accept only the session cookie and are `no-store`.
- Session-authenticated mutations require an exact same-origin request and
  the session-bound `X-Usage-Monitor-CSRF` value.
- The browser stores neither the personal session nor the recovery code in
  `sessionStorage` or `localStorage`.

## Upload

- A participant registers the exact encrypted envelope SHA-256 digest, UTF-8
  byte length, and `application/json` type.
- The server returns a distinct five-minute, one-use `Upload` authorization.
- Only a hash of that authorization is stored.
- The upload omits the personal cookie.
- A personal session cannot upload directly.
- An upload authorization cannot read, export, reset, recover, or delete
  personal data.
- Expired, replayed, revoked, concurrently claimed, differently sized, or
  differently digested upload authorizations fail closed.

## Recovery and deletion

- Recovery rotates the old code and stores only hashes, opaque identifiers,
  an independent client recovery-attempt hash, and a derivation nonce for a
  five-minute lost-response receipt.
- Only the identical high-entropy recovery-attempt value can reproduce the
  exact replacement recovery/session material, at most twice. The old
  recovery code alone or a different attempt value cannot replay authority.
- Recovery rotates the recovery code, revokes every prior session and unused
  upload authorization, and creates a replacement session.
- Security reset preserves the current session, rotates recovery, and revokes
  other sessions and pending uploads.
- Logout revokes an active session and clears the cookie; a missing, stale, or
  already-revoked cookie also receives a bounded successful clear.
- Participant deletion revokes other sessions and uploads but preserves the
  current deletion session until object deletion completes.
- If the first R2 deletion attempt fails, the same current session and CSRF
  value can retry; other authority remains rejected.
- If that deletion-owner session expires or its cookie is lost, the latest
  recovery code creates a replacement `deletion_only` session. That session
  cannot read, export, reset, or upload; it can only finish the owned deletion.

# Automated product checks

`npm run product:check` passed:

| Surface | Result |
|---|---:|
| Browser/UI contract tests | 17/17 |
| Local companion and contribution-builder tests | 10/10 |
| Worker integration tests | 24/24 |
| Enrollment-grant operator test | 1/1 |
| Generated Worker types | current |
| TypeScript | passed |
| Worker script syntax | passed |
| Worker deployment dry run | passed |

The dry run packaged the five reviewed browser assets and the D1, R2, Assets,
enrollment-rate-limit, and recovery-rate-limit bindings. It did not deploy.
`workers_dev` remains false and the Worker has no route.

# Fresh HTTP backend lifecycle

A fresh isolated local persistence directory was migrated through:

1. `0001_initial.sql`;
2. `0002_telemetry_ingest.sql`;
3. `0003_enrollment_grants.sql`; and
4. `0004_web_sessions_and_upload_authorizations.sql`.

Three owner-only, one-time invitations were issued into that isolated D1. A
mode-0600, 200-record privacy-safe contribution was then used against Wrangler
on `127.0.0.1`.

The smoke proved:

| Check | Result |
|---|---:|
| Enrollment mode | `invite_only` |
| Distinct participants | 3 |
| Safe records accepted per participant | 200 |
| Session cookie contract | passed |
| Missing CSRF rejection | passed |
| Session-only upload rejection | passed |
| Upload-only personal read rejection | passed |
| One-use upload replay rejection | passed |
| Idempotent envelope replay with a new upload authorization | passed |
| Personal statistics recomputed from D1 | passed |
| Community aggregate suppressed at one participant | passed |
| Development aggregate available at three participants | passed |
| Participant export capability scan | passed |
| Recovery rotation and old-session rejection | passed |
| Security reset and pending-upload revocation | passed |
| Logout cookie clearing | passed |
| Participants deleted | 3/3 |

The content-free smoke output included no invitation, participant, session,
CSRF, upload, recovery, contribution, or record value.

# Post-deletion state

A direct D1 query returned zero for:

- participants;
- telemetry contributions;
- telemetry records;
- web sessions;
- upload authorizations;
- recovery retry receipts; and
- participant eligibility relations.

The local R2 object table returned zero and the bucket's blob directory was
empty. The isolated persistence directory and redeemed invitation files were
moved to macOS Trash after verification.

# Browser QA

The Worker-served portal was inspected through the actual in-app browser:

- desktop viewport had zero document-width overflow;
- mobile viewport had zero document-width overflow;
- the mobile header was corrected so all five navigation destinations remain
  visible without clipped status text;
- offline local evidence remained explicit rather than being replaced by demo
  data;
- the central service and aggregate endpoint were reachable;
- choosing the labeled demo rendered three SVG visualizations, two evidence
  tables, two quota cards, eight diagnostic rows, and seven weekly rows; and
- recovery, one-time code acknowledgement, upload, export, security reset,
  sign-out, and deletion controls were present in the rendered DOM.

The complete browser upload lifecycle was not claimed over loopback HTTP
because a production `Secure` cookie belongs on the same-origin HTTPS Worker
portal. The equivalent lifecycle was proved by the real HTTP smoke's explicit
cookie jar. A future staged HTTPS preview must repeat the browser interaction
before any participant pilot.

# Loopback boundary

The local companion no longer proxies authenticated central operations. Its
central allowlist contains only:

- `GET /api/health`;
- `GET /api/v1/envelope-key`;
- `GET /api/v1/stats/aggregate`; and
- `GET /api/v1/community/insights`.

It does not forward authorization, cookie, origin, CSRF, arbitrary request
headers, or upstream `Set-Cookie` values. Tests prove enrollment, recovery,
session, upload, contribution, personal statistics, export, security reset,
logout, and deletion routes return local `404` without invoking central fetch.

# Residual work before a public pilot

This checkpoint is intentionally not the end of G3/G4. Remaining release work
includes:

- an HTTPS staged-preview browser lifecycle;
- a reviewed local-to-hosted handoff for prepared encrypted envelopes, or a
  separately packaged desktop companion;
- delayed immutable weekly aggregate snapshots; the live cumulative aggregate
  must remain development-only because minimum cohort size alone does not stop
  differencing;
- frozen upload-capable telemetry and consent versions;
- server-side repricing instead of accepting client-declared API-equivalent
  cost as verified;
- scheduled expiry cleanup for old session and upload-authorization rows;
- production key rotation and retired-key behavior;
- participant-fair edge abuse controls;
- retention, deletion tombstones, backup restore suppression, and aggregate
  rebuild drills;
- operator access, jurisdiction, processor, incident, notification, and
  privacy-policy decisions; and
- external privacy and security review.
