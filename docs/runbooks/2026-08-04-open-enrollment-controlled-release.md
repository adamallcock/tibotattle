---
title: Open Enrollment Controlled Release
date: 2026-08-04
type: runbook
status: implementation-complete-external-authorization-required
---

# Open enrollment controlled release

## Outcome and authority boundary

The repository implements the privacy-minimised Google/Apple account gate,
server-verified upload path, bounded device lifecycle, global sign-in-start
budget, account-level aggregate controls, and contained-mode kill switch.
Checked-in staging and production both keep `ENROLLMENT_MODE=disabled`.

This runbook is deliberately **not** approval to set a live OAuth secret,
change an OAuth-provider console, run a remote D1 migration, deploy a Worker,
or enable collection. Those are account-owner operations and require a named
release approval after the evidence below is complete. A successful source
test is not evidence of live provider configuration or a safe public launch.

The operational claim at launch is only:

> Open, voluntary, provider-account-gated, self-reported telemetry.

Do not describe the cohort as unique humans, independently sampled people,
provider-verified usage, or population-wide usage.

## Non-negotiable user-flow and privacy contract

- A person uses the system browser to sign in with Google or Apple on first
  connection, a replacement/additional Mac, a deliberate account switch, or a
  high-risk recheck. A normal six-hour upload must not show OAuth, CAPTCHA,
  a passkey prompt, or a provider page.
- The client retains its scoped device bearer in macOS Keychain. It can renew
  its upload-only authority while recently active, but no later than the
  configured social-verification horizon. It stores no provider refresh token.
- The Worker requests no email or profile scope, derives a keyed opaque
  issuer-and-subject link, and discards authorization codes, ID tokens, access
  tokens, and refresh tokens in the request that used them.
- A user who chooses **Disconnect this Mac** first revokes server authority,
  then clears only the matching local Keychain material. A local switch must
  never leave the old account uploading in the background.
- Account deletion revokes sessions/devices and removes primary data. The
  independent restore tombstone has a bounded retention period. A separate,
  purpose-separated opaque re-enrolment cooldown is written to primary D1
  before the old identity link is removed, then copied to the independent
  ledger. The participant `INSERT` rejects a live primary marker, so a timed
  delete/re-enrol request cannot reset contribution history. The marker expires
  and is purged from both stores; it is not a permanent hidden social
  identifier.
- Google and Apple accounts are separate account units. Do not silently merge
  them using email, display name, or Apple private-relay data.

## Required source and local evidence

Run these before any owner-account operation, from the repository root. They
must be run against the reviewed commit, with a clean worktree except for the
release receipt directory kept outside Git.

```sh
npm --prefix apps/worker run typecheck
npm --prefix apps/worker run types:check
npm --prefix apps/worker run scripts:check
npm --prefix apps/worker run release:preflight
npm --prefix apps/worker test -- --run \
  test/identity-google.spec.ts test/identity-apple.spec.ts \
  test/identity-oidc.spec.ts test/device-auth.spec.ts \
  test/community-snapshots.spec.ts test/worker.spec.ts
npm --prefix apps/worker run staging:check
```

`release:preflight` accepts no remote/deploy option and uses a freshly created,
owner-only local D1 state directory. Its bounded receipt contains only boolean
checks and fixed blocker codes, never Wrangler output. It verifies primary
migrations `0023`–`0028`, including the primary cooldown table, retention
index, participant-insert guard, and pinned identity-link key configuration,
plus the complete independent deletion-ledger stream. The release owner must
also retain that redacted receipt and focused behavior-test evidence showing
the isolated migration rehearsal verifies both cooldown copies and leaves
collection contained. Together they must prove all of the following without a
live account or provider credential:

1. Applying the migrations from an empty database succeeds.
2. Re-running them is idempotently current.
3. Existing published/suppressed aggregate revisions are withdrawn and queued
   for rebuild by the aggregate-policy migration.
4. The sign-in admission counter accepts up to its configured bound, rejects
   the next attempt atomically, and is removed by bounded retention cleanup.
5. An expired identity handoff, device authority, deletion tombstone, and both
   copies of the re-enrolment cooldown no longer grant or block authority after
   their respective expiry; bounded maintenance reports completion.
6. A failed rehearsal leaves the disposable database only; do not use a
   production or shared staging D1 database as the test target.

The source gate and rehearsal are necessary but not sufficient. Do not infer
that a configured client ID, placeholder callback, test JWKS hook, or a
successful local mock proves the real Google/Apple journey.

## Account-owner configuration checklist

Perform the following in a fresh, dedicated browser session. Keep values out
of shell history, screenshots, source files, test fixtures, receipts, logs,
and support tickets.

1. Confirm staging and production use different OAuth client registrations and
   only exact HTTPS callback URLs of the form
   `https://EXACT-HOST/api/v1/identity/{google|apple}/callback`. The deployed
   Worker public origin and provider-console entries must match byte-for-byte.
   No loopback URL, wildcard, custom query string, or browser-supplied redirect
   URI is permitted.
2. Confirm the Google registration has the minimal OIDC scope contract and the
   Apple Services ID/domain/return URL/key are for the exact intended
   environment. Verify provider consent/error/cancellation routes, not merely
   a portal save.
3. Install only the expected Worker secret names through the approved
   Cloudflare secret path: `ENVELOPE_PRIVATE_JWK`, `ENVELOPE_PUBLIC_JWK`,
   `IDENTITY_LINK_SECRET`, `GOOGLE_OIDC_CLIENT_SECRET`, and
   `APPLE_PRIVATE_KEY`. Secret values must never be echoed, copied into
   `wrangler.jsonc`, or supplied as a command-line argument. Cloudflare keeps
   Workers secrets outside the configuration file and treats their names as
   deploy-time requirements; see its [Secrets documentation](https://developers.cloudflare.com/workers/configuration/secrets/).
4. Confirm the non-secret identifiers, `PUBLIC_ORIGIN`, and
   `IDENTITY_LINK_SECRET_VERSION` are environment-correct, then rerun generated
   Worker type/config validation. The version label is not secret, but it is
   immutable: primary D1 pins it with a keyed fingerprint of
   `IDENTITY_LINK_SECRET`. Never rotate either value in place. If a rotation is
   necessary, contain enrollment and use a separately reviewed dual-key
   migration/relink procedure; a configuration mismatch is designed to fail
   closed. Do not loosen the checked-in `disabled` mode merely to make a
   readiness command pass.
5. Turn on/verify Workers observability for the deployed environment and prove
   that query-string OAuth `code`/`state`, cookies, handoff proofs, provider
   subjects, tokens, and secret values are absent from Workers Logs, error
   reporting, and any third-party analytics. Workers Logs should be treated as
   operational evidence, not an identity store; use the documented
   [Workers Logs controls](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).

## Disabled-mode staging gate

Provisioning or migration work starts with collection disabled. The standard
commands make that distinction explicit:

```sh
cd apps/worker
npm run staging:check
npm run staging:ready
```

`staging:check` validates the checked-in closed configuration and dry-run
bundle; `staging:ready` is a read-only live-resource check. If remote storage
must be created or updated, use only the reviewed contained-staging preparation
procedure in the existing [invite pilot readiness runbook](./2026-07-29-invite-pilot-operational-readiness.md), with its exact confirmation string.
Cloudflare D1 records applied migration state and rolls back a failed migration
transaction; retain only the redacted result, not Wrangler output or resource
identifiers. See [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).

Required disabled-mode acceptance evidence:

- `/api/health` says all four collection controls are contained.
- `/api/ready` is fresh after an hourly maintenance cycle, including the new
  handoff, admission, device, primary/ledger cooldown, reconciliation, and
  aggregate maintenance checks.
- A Google and Apple sign-in start is rejected before provider redirect while
  disabled; the rejection does not allocate an admission row or a handoff.
- The redacted error/diagnostic view can distinguish a disabled gate from an
  upstream-provider failure, a global-admission rejection, and a device limit.
- A staged, signed app can show the connected, reconnect-required, signed-out,
  and disconnected states without retaining a provider token locally.

## Mandatory Worker and schema ordering

The identity cooldown schema is an expand/contract deployment, not a migration
that may be applied to an open, mixed-version service. A pre-`0027` Worker
deletion writes only the independent ledger marker; a post-`0027` enrollment
expects the primary marker. Applying schema first while old Workers still
serve traffic can therefore admit a deletion/re-enrollment race.

For every environment, retain a redacted receipt that establishes this exact
order:

1. Keep `ENROLLMENT_MODE=disabled` and all collection controls contained.
   Confirm Google/Apple starts reject before a redirect. Wait at least the
   five-minute handoff TTL plus the platform's documented request-drain window
   after the final open-enrollment revision is removed, and confirm no old
   Worker revision is still receiving identity traffic.
2. Deploy the reviewed Worker revision while still disabled. Verify the active
   revision and that no older Worker instance remains able to serve an identity
   request. During this short compatibility window, a pre-schema identity
   deletion may fail closed rather than remove a link without its primary
   marker; do not enable enrollment or run a public cohort then.
3. Only after step 2, apply primary migrations `0023`–`0028` and the reviewed
   deletion-ledger stream. Verify the primary cooldown table/trigger and the
   identity-link configuration table before any connected preview.
4. Run the signed connected-preview journey and normal maintenance/ready
   checks. A local `release:preflight` proves only a disposable rehearsal; it
   does not replace the drain, active-revision, or remote-schema receipts.

Do not reverse steps 2 and 3. If their completion cannot be proven, leave
enrollment disabled and treat the rollout as incomplete.

## Connected-preview acceptance journey

Use a disposable provider account and a clean macOS user profile. Do not record
the account name, provider subject, browser URL query, code, token, cookie,
proof, device bearer, or raw telemetry in the result. Record only pass/fail,
timestamp, build identifier, provider, and an opaque request reference where
needed for incident correlation.

For both Google and Apple, prove:

1. First connection reaches the system browser, returns through the exact
   callback, creates one participant, and pairs one Mac.
2. Restart/restored-session behavior is honest; explicit browser logout clears
   the browser session without claiming to revoke a separately paired Mac.
3. Reinstalling or adding a Mac with the same provider account reattaches the
   same active participant rather than creating a second unit.
4. Normal prepared uploads run without a six-hour identity prompt. At idle or
   social-recheck expiry, the queue pauses and presents one clear reconnect
   journey rather than discarding data or silently renewing forever.
5. Disconnect-this-Mac revokes the remote device first and prevents an
   upload/disconnect race. A different account cannot silently take over the
   old device authority.
6. Missing, replayed, expired, or nonce-mismatched callback data fails without
   a participant/session/device write. An expired/consumed handoff proof also
   fails without a second attempt creating a record.
7. Deletion clears the account's primary contribution/session/device state.
   Immediate re-enrolment receives the neutral cooldown outcome; after the
   documented expiry it can enter a new account generation only through a new
   verified provider flow.

## Observability, limits, and incident ownership

Before any public change, name an on-call owner and configure alert delivery
outside the repository. Alerts must cover, at minimum:

- Worker 5xx/errors and a missing or stale scheduled-maintenance success;
- `identity_google_start` / `identity_apple_start` failures, callbacks,
  one-use result failures, and provider-unavailable errors;
- sign-in admission exhaustion, enrollment-rate limiting, and unexpected
  handoff backlog/expiry;
- device pairing/claim ceilings, active-device saturation, disconnect failures,
  and upload-authorization rejection;
- deletion-ledger/lifecycle/reconciliation failures, aggregate rebuild backlog,
  policy/exclusion changes, and publication-state drift; and
- abnormal participant/device/accepted-contribution distribution, D1/R2
  failures, and cost/billing thresholds.

The operational dashboard may use the authenticated admin overview and bounded
diagnostic groups, but it must never show raw provider identities or telemetry.
The source emits redacted route class, status, error code, and opaque request
reference; configure aggregation on those fields only. Keep raw HTTP request
URL logging off for identity callbacks.

## Staged approval and containment

There is intentionally no generic command that turns production open
enrollment on. An activation must be a separate reviewed change with all of
the following attached: this runbook's completed evidence, named owner,
privacy/deletion policy approval, support path for a legitimate device
replacement, metric baselines, and an explicit maximum cohort/rollback
decision.

The rollout sequence is:

1. Keep staging disabled while configuration and connected-preview evidence
   are gathered.
2. Obtain written approval for a small, monitored production cohort. Start
   with public aggregate publication still contained.
3. Review the first-week account/device distribution, admission rejections,
   provider errors, re-enrolment cooldowns, disconnects, and aggregate
   exclusions before widening availability.
4. Authorize public aggregate publication only after the descriptive cohort
   wording, 20-account threshold, maturity, clipping, delayed release, and
   deterministic rebuild controls are verified in the deployed environment.

If privacy, integrity, availability, abuse, cost, or monitoring certainty is
lost, stop new enrollment first. Use the existing `pilot:control` inspection
and containment/rollback flow for the exact deployed revision; if state cannot
be verified, use the reviewed contained-staging preparation path. Preserve
only redacted receipts and request references. Do not delete data, rotate
identity secrets, or redeploy a guessed configuration during containment.

## Explicit non-decisions

- Do not add an OAuth refresh token to remove the rare social recheck; that
  creates a higher-value retained credential and is unnecessary for the normal
  background flow.
- Do not add anonymous passkeys, recovery-only enrollment, or a generic auth
  SaaS as an alternate open-enrollment identity class. They would not make a
  provider account more Sybil-resistant or prove that client telemetry is true.
- Do not enable Cloudflare Turnstile speculatively. Add it only after a named
  abuse rule, accessible retry journey, site key, server-side Siteverify,
  hostname/action validation, and operational owner are approved. It must
  never gate normal device uploads or be described as identity proof.
- Do not claim this system detects a modified client inventing plausible data.
  The server enforces authority, replay, schema, deduplication, repricing,
  quota, maturity, clipping, and release rules; stronger source provenance
  would require a metric-specific provider receipt or API.
