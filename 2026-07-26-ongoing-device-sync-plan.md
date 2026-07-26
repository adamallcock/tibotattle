---
title: Ongoing Device Sync Plan
date: 2026-07-26
type: plan
status: in-progress-development
---

# Outcome

Add a visible, bounded `watch`/sync path that can contribute newly prepared
privacy-safe batches without asking the participant to repeat the entire web
upload ceremony for every file.

This phase must preserve the current release boundary:

- no production route or external participant collection;
- no server-directed filesystem discovery;
- no raw-log, prompt, response, path, command, credential, email, or provider
  account identifier transmission;
- no activation of the disabled account-scoped v0.2 transport;
- no silent scheduled/background installation; and
- no reuse of telemetry identity, account HMAC, recovery, browser session,
  pairing, encryption, or upload capabilities.

The first shipped surface is a foreground command against the local
development backend. LaunchAgent/systemd/Task Scheduler installation requires a
later separate confirmation and release gate.

# Participant journey

1. The participant enrolls or recovers in the same-origin personal web portal.
2. The portal creates one short-lived, single-use device-pairing code after an
   explicit consent checkbox describing ongoing transmission.
3. The participant gives that code to the local client. The client generates a
   device UUID and 32-byte secret locally, stores the secret in Keychain, and
   sends only the UUID plus a domain-separated hash while claiming the pairing.
   The server never generates or returns the long-lived device secret.
4. The local client stores the secret in the dedicated
   `app-usagemonitor.contribution-device.v1` Keychain capability. It is never written
   to configuration, queue state, logs, receipts, shell history, or browser
   storage.
5. `sync-once` validates already-prepared privacy-safe v0.1 contribution files,
   asks the device credential for a short-lived authorization bound to one
   encrypted envelope digest and byte length, uploads with only that one-use
   authority, and records a content-free local receipt.
6. `sync-watch` repeats the same bounded operation in the foreground with an
   explicit interval. It starts paused after credential recovery or application
   reinstall unless the participant explicitly resumes it.
7. The portal lists device capabilities by bounded non-secret metadata and can
   revoke one or all devices. Recovery, security reset, and participant
   deletion revoke every device and pending pairing.

# Authority model

## Pairing capability

- 32 random bytes plus a UUID, encoded as `um_pair_<uuid>.<secret>`.
- Stored hash-only in D1.
- Issued only by an authenticated personal session with same-origin CSRF.
- Single use, ten-minute expiry, and participant bound.
- May mint one device credential and nothing else.
- Cannot read personal data, register an upload, recover access, or pair another
  device.

## Device upload-registration credential

- The local client generates 32 random bytes plus a UUID and later proves
  possession as `um_device_<uuid>.<secret>`.
- Stored hash-only in D1 and stored locally only in the dedicated Keychain
  capability.
- Pairing claim sends the UUID and domain-separated SHA-256 hash, never the
  secret. A lost claim response is therefore recoverable from local state.
- Scope is exactly `upload_registration`.
- Thirty-day absolute expiry in the development slice; the portal can revoke it
  at any time.
- May register a one-use authorization for one exact encrypted envelope.
- Cannot upload directly, read personal data, export, delete, recover, reset,
  create pairing codes, or mint another device.
- The resulting `Upload` authority retains the existing five-minute,
  digest/length/content-type binding and cookie omission.

# D1 changes

Add an additive migration:

## `device_pairings`

- pairing UUID;
- participant foreign key;
- issuing web-session foreign key;
- pairing secret hash;
- consent version for ongoing upload;
- `unused|consumed|revoked` state;
- issued, expiry, consumed, and revoked timestamps; and
- the created device ID when consumed.

## `device_credentials`

- device UUID;
- participant foreign key;
- device secret hash;
- fixed `upload_registration` scope;
- `active|revoked` state;
- issued, expiry, last-used, and revoked timestamps.

`upload_authorizations.issued_by_session_id` currently requires a web session.
Prefer an additive `device_upload_authorizations` table plus a nullable
device-authorization relation on contribution rows, with triggers requiring
exactly one live browser or device authority. This avoids rebuilding the
existing authorization table and its foreign-key graph. Existing browser-issued
rows remain unchanged.

# API changes

- `POST /api/v1/me/device-pairings`
  - personal session, same-origin, CSRF;
  - exact consent version and `ongoingUpload: true`;
  - returns the pairing code once and its expiry.
- `POST /api/v1/device-pairings/claim`
  - pairing capability only;
  - no browser cookie;
  - exact device UUID and domain-separated secret hash in a closed body;
  - atomically consumes the pairing and returns non-secret device metadata.
- `GET /api/v1/me/devices`
  - personal session only;
  - returns device UUID, fixed scope, state, issued/expiry/last-used times;
  - never returns credential hashes or secrets.
- `DELETE /api/v1/me/devices/:id`
  - personal session, same-origin, CSRF;
  - revokes the exact participant-owned device and its unused upload
    authorizations.
- `POST /api/v1/device/upload-authorizations`
  - `Authorization: Device ...`;
  - exact digest, length, and content type;
  - returns the existing one-use `Upload` authorization.

Every private or authority response is `Cache-Control: no-store`. Operational
logs retain only fixed route class, status, and error code.

# Local queue and sync state

The queue is an owner-only metadata SQLite ledger. It observes only committed
`prepared-contribution-set-v0.1` manifests published after every member file is
durable and validated; loose JSON, source bundles, and incomplete sets are
ignored. Each row contains only:

- random job ID and prepared-set ID;
- fixed contribution basename, never an arbitrary or source path;
- SHA-256 of the already-prepared contribution bytes;
- byte length;
- schema version;
- creation and covered-day bounds copied from the validated contribution;
- state: `pending|in_flight|accepted|retryable|rejected`;
- bounded attempt count and next-attempt time;
- fixed response/error code; and
- the accepted contribution ID only when needed for participant-visible
  reconciliation.

The fixed prepared-directory root is selected at process startup and never
server-directed. The local source file path must not enter queue rows, stdout, a
server request, or a verification receipt. A replacement, symlink, hardlink,
mode change, digest change, byte-length change, incomplete manifest, or disabled
v0.2 schema fails closed before any network request.

Retry rules:

- retry only network failures, 408, 429, and 5xx;
- use capped exponential backoff with jitter and a fixed maximum attempt count;
- never retry privacy/schema rejection automatically;
- idempotent replay must yield the existing contribution receipt;
- a revoked/expired device pauses the queue and requires explicit pairing;
- SIGINT leaves the current item `retryable`, not silently accepted.

# Commands

- `usage-monitor contribution pair --origin ORIGIN`
- `usage-monitor sync-status`
- `usage-monitor sync-once --directory PREPARED_DIRECTORY --origin ORIGIN`
- `usage-monitor sync-watch --directory PREPARED_DIRECTORY --origin ORIGIN
  [--interval-seconds N]`
- `usage-monitor sync-pause`
- `usage-monitor sync-resume`
- `usage-monitor sync-revoke --confirm TOKEN`

Origins are configured locally, must be HTTPS outside explicit loopback
development, and can never be supplied by the server. Command output is a
bounded content-free summary.

# Verification

## Worker

- pairing single-use, expiry, replay, and race behavior;
- device hash-only storage and credential grammar;
- device cannot call personal, pairing-issuance, recovery, deletion, or direct
  contribution routes;
- web session cannot use the device route;
- device registration returns a separately scoped one-use upload authority;
- recovery, security reset, device deletion, and participant deletion revoke
  device/pairing/upload authority;
- issuer constraints prevent orphaned, dual-issued, or relabeled upload rows;
- no capability appears in personal export, logs, aggregate output, or errors.

## Local

- Keychain capability is distinct from every existing capability;
- pair stores only after exact readback and zeroizes temporary copies;
- queue state is owner-only, bounded, path-free, and crash-safe;
- file substitution and digest mismatch fail closed;
- only prepared v0.1 contribution files can enter the queue;
- at-least-once retry produces one canonical server contribution;
- pause/resume/revoke are explicit and content-free;
- foreground watch exits cleanly and never installs persistence.

## End to end

Run a real loopback Worker/D1/R2 server and prove:

1. browser/session pairing issuance;
2. CLI pairing redemption and Keychain-backed storage;
3. two encrypted prepared-file uploads;
4. idempotent retry;
5. personal-stat update;
6. portal device listing and revocation;
7. rejected post-revocation registration;
8. complete participant deletion; and
9. zero participant/device/pairing/upload/contribution/R2 state afterward.

# Release gates

This development slice remains unrouted. A participant pilot still requires:

- dated consent and privacy approval for ongoing transmission;
- signed client distribution and clean-machine verification;
- production HTTPS origin, secrets, key rotation, and abuse controls;
- 30-day bounded foreground collection evidence before background installation;
- retention and incident drills including device compromise;
- renewed review before v0.2 account tracks are accepted; and
- a staged real-browser HTTPS lifecycle test.
