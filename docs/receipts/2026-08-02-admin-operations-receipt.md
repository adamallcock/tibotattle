---
title: Owner-authenticated operations surface receipt
date: 2026-08-02
type: receipt
status: local-complete
---

# Owner-authenticated operations surface

## Decision

The hosted dashboard does not receive direct D1 access. The new operations
page calls two exact Worker routes that return bounded aggregate state:

- `GET /api/v1/admin/overview`
- `POST /api/v1/admin/action`

Both routes require the existing HttpOnly session cookie. The Worker then
checks the session participant's pairwise OIDC `identity_link_key` against the
single production secret `ADMIN_IDENTITY_LINK_KEY`. This avoids inventing a
shared password or bearer token and keeps the allowlist inside the existing
identity boundary.

## Scope

`/admin.html` shows:

- participant, contribution, telemetry-record, and quarantine counts;
- collection-control state and revision;
- retention, restore-replay, quarantine-reconciliation, and maintenance state;
- pending historical snapshot rebuild count and immutable snapshot metadata;
- retained error groups with a per-day rate and request-reference lookup;
- recent owner actions without storing the raw identity key.

The action route supports only:

- revisioned collection-control changes with a fixed reason code;
- an audited bounded maintenance pass that processes deletion retention and
  quarantine reconciliation, and builds publication only when publication is
  enabled.

Each failed request records its response `requestId` as a 30-day diagnostic
reference when D1 is available. The record contains route class, error code,
status, and time only; it does not contain participant IDs, record contents,
cookies, or request bodies.

## Production enablement

`ADMIN_IDENTITY_LINK_KEY` is deliberately optional at deployment time. Without
it the Worker returns `503 ADMIN_NOT_CONFIGURED` for every admin route, while
ordinary service and security deployments can proceed. The admin surface stays
disabled until the owner provisions that secret from the owner's existing
pairwise identity-link value in an owner-only terminal. The value must not be
pasted into chat, committed, or written into this receipt.

## Validation

- `npm test` in `apps/worker`: 15 files, 173 tests passed.
- `npm run typecheck` and `npm run types:check`: passed.
- `npm run architecture:check`: passed, 285 production files, 0 approved debt edges.
- `npm run deploy:dry`: passed; Wrangler read 16 web assets, including the
  operations page and styles.
- `node --check apps/web/public/admin.js`: passed.
- `git diff --check`: passed.
