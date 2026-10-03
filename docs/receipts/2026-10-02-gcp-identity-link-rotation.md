---
title: GCP identity-link rotation at cutover
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP identity-link rotation at cutover

This is a 2026-10-02 receipt for the round 16 identity-link rotation on branch
`claude/gcp-fp-idlink-rotate`. The branch was cut from `claude/gcp-fp-e-pt8`
at `c1049565` (E-PT8 with both review rounds) and has the fast-path final line
at `112d27cc` merged in. It records source and synthetic local proof only.
No rotation has run: no owner document exists yet, no production secret was
read, and nothing touched Cloudflare, Secret Manager or Cloud SQL.

## Decision and labels

Round 16 of the 2026-10-02 owner decisions: the production
`IDENTITY_LINK_SECRET` is lost (Cloudflare Worker secrets are write-only and
the owner has no copy), so the cutover rotates it. That is admissible only
because round 12 retires every route that consumes the secret.

| Item | Value |
|---|---|
| Retired label (D1 pin, `wrangler.jsonc` env.production) | `production-v1` |
| Rotated label (origin `PRODUCTION_VARS`) | `production-v2` |
| Secret Manager secret and version to mount | `IDENTITY_LINK_SECRET`, version `1` (the newly generated value) |
| Rotation document schema | `tibotattle-identity-link-rotation-v1`, reason `secret-lost` |
| Owner document digests | None yet: `identity-rotate-pin` has not run |

Fingerprints are keyed digests and appear in no repository file.

## What was built

| Part | Where |
|---|---|
| Rotation document, sealed-pin file parser, P8-R comparison | `apps/worker/scripts/postgres-identity-link-pin.mjs` |
| `identity-rotate-pin` (owner, stdin only), P8-R, the second token, the `identity-link-rotation` stage, continuity at post-import, the flip gate and the post-live check, the report's `rotation` digest | `apps/worker/scripts/postgres-production-transfer.mjs` |
| PT-3's closed rotate mode (`sealed == rotation.from`, `pinMode: rotated`; the row is still copied verbatim) | `apps/worker/scripts/postgres-identity-authority-transfer.mjs` |
| The new stage in PT-1's list and the plan; the pin table split from the kept-session tables | `postgres-transfer-target.mjs`, `postgres-transfer-coverage.mjs` |
| The consumer list and its refusal | `IDENTITY_LINK_CONSUMER_ROUTE_IDS`, `assertIdentityLinkConsumersRetired` in `apps/worker/cloud-run/postgres-production-registry.mjs` |
| The label, the retired label and the staging fence | `PRODUCTION_IDENTITY_LINK_SECRET_VERSION`, `PRODUCTION_RETIRED_IDENTITY_LINK_VERSIONS` in `postgres-production-configuration.mjs`; the analytics-refresh CR-3 fingerprint |
| The drift guard's closed rotated-var category | `ORIGIN_ROTATED_VAR_NAMES` in `apps/worker/scripts/cloud-run-production-configuration.check.mjs` |
| Boot refusal under a rotated label | `assertIdentityLinkRotationComposable` in `postgres-production-host.mjs` |

## Behaviour proven (synthetic)

- No rotation without the token: a run whose inputs declare a rotation refuses
  `CUTOVER_AUTHORIZATION_MISMATCH` (step `identity-rotation`) with the run
  token alone or a wrong second token, and writes nothing. An unrotated run
  refuses a rotation token.
- The new secret's pin without the rotation document fails P8
  (`CUTOVER_IDENTITY_LINK_SECRET_MISMATCH`) under either label.
- A wrong key version fails (`CUTOVER_IDENTITY_LINK_VERSION_MISMATCH`), as do
  a `from` that is not the sealed row, a pin that is not `to`, an unpinned or
  mismatched mount, and a ported consumer, at preflight and at host boot.
- The rotation document is closed and tamper-evident: a schema-valid edit no
  longer hashes to the inputs' `rotationSha256`
  (`CUTOVER_IDENTITY_ROTATION_INVALID`).
- `identity-rotate-pin` refuses a trailing newline, writes the two `0400`
  documents once, and prints neither secret nor fingerprint.
- A kill after the UPDATE and before the receipt rolls back; the resumed run
  rotates once. A pin set back behind the orchestrator's back refuses at
  post-import and at the flip gate (`CUTOVER_IDENTITY_ROTATION_STATE_INVALID`).
- PT-3 keeps exactly one verbatim table receipt for the pin table (source and
  target digests equal); the rotation adds only its stage receipt and its
  checkpoint (prefix = the rotation document's sha256). The run goes live,
  the post-live check re-asserts the rotated pin, and the report carries the
  rotation digest.
- The session read, credential renew and disconnect succeed against a rotated
  pin and against a pin no secret matches; they never read the pin.

## Gates

Node.js 26.2.0, local PostgreSQL 17.10 throwaway cluster on a private socket,
created for this run and removed afterwards.

| Command | Result |
|---|---|
| `node --test scripts/postgres-production-transfer.check.mjs` (apps/worker) | 23 of 23 |
| `npm run postgres:cutover-seal:check` (apps/worker) | 111 of 111 |
| `node --test scripts/postgres-identity-authority-transfer.check.mjs`, `scripts/postgres-transfer-target.check.mjs` | 6 of 6, 16 of 16 |
| `node --test scripts/cloud-run-production-configuration.check.mjs` | 12 of 12 |
| `node --test cloud-run/postgres-production-configuration.check.mjs`, `cloud-run/postgres-production-registry.check.mjs`, `cloud-run/postgres-production-host.check.mjs` | 28 of 28, 23 of 23, 13 of 13 |
| `vitest run --config vitest.postgres.config.ts postgres-test/postgres-production-transfer.spec.mjs` | 5 of 5 |
| `node --test postgres-test/identity-link-rotation-kept-routes.spec.mjs` | 1 of 1 |
| `node --test postgres-test/analytics-v2-refresh.spec.mjs` (CR-3 equality case) | 1 of 1 |
| `node --test scripts/ci-postgres-suite.check.mjs` (spec registration) | 43 of 43 |
| `npm run scripts:check` (apps/worker) | exit 0; 1,084 tests, 0 failures |
| `npm run check` (apps/worker/cloud-run) | exit 0; 427 tests, 0 failures |
| `npm run architecture:check`, `npm run test:preflight` (root) | pass |

## Open gates

- PROD-PREP's `gcp-identity-link-pin-check.mjs` and `gcp-production-apply.md`
  are not on this branch. The pin check needs a `--rotation-file` mode
  (`match-rotated`) before it can pass against the new secret; without it a
  rotated mount must still exit 2.
- The production desired state's `IDENTITY_LINK_SECRET` mount must be pinned to
  version `1` (PROD-PREP owns the filled file), after a boolean-only check that
  the version has no trailing newline.
- Who pipes the secret into `identity-rotate-pin` (round 16 says Claude runs
  the secret commands; PT-8 design section 6 says the owner) is an owner
  question.
