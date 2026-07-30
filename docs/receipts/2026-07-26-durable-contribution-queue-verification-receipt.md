---
title: Durable Contribution Queue Verification Receipt
date: 2026-07-26
type: verification
status: passed-development
---

# Scope

This receipt covers the privacy-safe foreground contribution queue and its
integration with the local companion, participant portal, Cloudflare Worker,
D1, and R2. It is a local development verification, not a production release
approval.

# Local source evidence

A fresh bounded Codex export covering 2026-07-26 00:00–12:00 UTC was built
from 57 local source files. The closed export contained:

- 5,115 usage events;
- 5,355 quota snapshots;
- 0 activity markers;
- 53 prepared contribution batches; and
- 12,828,546 total prepared bytes.

The privacy verdict passed before preparation. The smoke selected one
owner-only `telemetry-contribution-v0.1` batch. Raw logs, prompts, responses,
source paths, account names, sessions, and credentials were not sent to the
backend.

# Durable queue verification

Focused Node tests prove:

- owner-only, path-free SQLite state;
- strict discovery of committed sets and `prepared-set-<uuid>` spool children;
- loose and incomplete file exclusion;
- manifest, mode, ownership, link-count, size, digest, and schema revalidation;
- transient-only retry with capped backoff and eventual single acceptance;
- terminal privacy/schema rejection without automatic replay;
- device-revocation pause with retryable work preserved;
- expired lease recovery after process interruption;
- post-enqueue file substitution rejection before any network call;
- symlinked and non-owner-only queue location rejection;
- explicit foreground watch without installing persistence; and
- content-free CLI status, pause, resume, one-shot, pairing, and watch output.

The focused local, browser-contract, queue, CLI, and Worker suites passed 96
checks before the live smokes. After removing identifier-bearing contribution
routes, the Worker suite again passed 52 checks and the local/browser suites
passed 27 checks.

# Live queue smoke

Against a loopback Worker with isolated D1/R2 state, the real queue proved:

- 2 committed prepared sets discovered;
- 1 encrypted batch accepted before restart;
- 1 accepted row retained after restart;
- 0 accepted rows replayed after restart;
- private server-repriced statistics updated;
- paired device visible to the participant;
- remote device revocation paused the queue;
- 1 retryable job preserved;
- local credential removed only after confirmed remote revocation; and
- complete participant deletion.

The smoke's bounded summary reported no content, paths, identities, origins, or
credentials. After deletion, D1 contained zero participants, contributions,
records, sessions, pairings, devices, and device upload authorizations. R2
contained zero blobs.

# Full backend lifecycle smoke

A separate fresh invite-only state exercised 20 participants over real loopback
HTTP. It verified encrypted ingest, server-side validation and API-price
repricing, participant isolation, one-use authority, idempotent replay, private
statistics, scheduled aggregate publication at 20 participants, byte-stable
public aliases, export, recovery, security reset, device pairing/revocation,
contribution deletion, snapshot withdrawal, and deletion of all 20
participants.

Post-smoke D1 counts were:

- participants: 0;
- telemetry contributions: 0;
- telemetry records: 0;
- web sessions: 0;
- upload authorizations: 0;
- device pairings: 0;
- device credentials: 0; and
- device upload authorizations: 0.

One immutable aggregate snapshot tombstone remained in the required
`withdrawn` state. R2 contained zero blobs.

# Access-log privacy correction

Device revocation and participant contribution read/delete now use fixed POST
routes with exact one-key JSON bodies:

- `/api/v1/me/devices/revoke`;
- `/api/v1/me/contributions/read`; and
- `/api/v1/me/contributions/delete`.

The former identifier-bearing path forms return 404. The live Wrangler access
log therefore showed fixed route names rather than device or contribution
pseudonyms.

# Product and rendered UI check

`npm run product:check` passed the browser contract, expanded local queue and
companion suite, Worker types, TypeScript, scripts, 52 Worker runtime tests,
and dry deployment. The rendered loopback dashboard was inspected with both
the central service stopped and connected. It showed:

- the full real local quota, cost, residual, weekly-limit, and coverage views;
- a content-free empty queue with zero waiting/in-flight/accepted/attention
  counts;
- explicit foreground-only/no-background-installation copy;
- fail-closed `Service unavailable` and `Backend unavailable` states; and
- `Service reachable` and `Backend ready` when connected to the local Worker,
  including D1 connected, encrypted quarantine reachable, local enrollment,
  and the accepted v0.1 contract.

The repository-wide suite passed 859 of 861 tests. Its only two failures are
the pre-existing retained R7 release-receipt provenance mismatch
(`workloadCodeSha256` and `workloadCodeFileCount`). Those frozen receipts were
not regenerated or weakened as part of this contribution-system change.

# Remaining gates

This receipt does not approve:

- a login item, LaunchAgent, daemon, or silent background process;
- signed consumer packaging or clean-machine installation;
- production HTTPS, production secrets, key rotation, abuse controls, or
  incident operations;
- external participant collection or public aggregate publication;
- the disabled v0.2 account-track transport; or
- Claude collection, which remains deferred by product decision.

All temporary source, queue, D1, R2, and invitation smoke directories were
moved to Trash after exact cleanup checks.
