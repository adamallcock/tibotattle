---
title: Public Upload Ingress Admission Decision
date: 2026-08-04
type: decision-record
status: complete
---

# Public upload ingress admission decision

## Decision

The public contribution path uses layered admission rather than treating the
hourly Worker cron as an upload scheduler. The cron runs backend maintenance;
the correlated-upload risk is the six-hour foreground client schedule, common
opt-in/relaunch times, and synchronized retries after an outage.

The implementation has five layers:

1. A newly enabled automatic client schedule receives a uniformly chosen,
   persisted 0–60 minute phase offset. A legacy or overdue stored schedule is
   assigned and persists that same offset before it may run, so relaunch cannot
   re-form a cohort at an exact six-hour boundary.
2. The durable local upload queue treats an HTTP `Retry-After` as a hard retry
   floor, then adds a small bounded positive spread. It still applies its own
   randomized exponential backoff when no server deadline exists. A valid
   retry horizon beyond the supported seven-day persistence limit pauses the
   queue rather than silently retrying before the server's advertised floor.
3. Upload-authorization registration has a coarse Cloudflare Rate Limit and a
   separate HMAC-keyed participant limit. Hosted values are 300
   registrations/minute per edge location and 6/minute per participant. The check occurs
   after authentication and CSRF, but before the JSON registration body is
   read; raw session, device, and participant identifiers never appear in a
   Rate Limit key.
4. The contribution endpoint has separate coarse (240/minute) and
   client-keyed (20/minute) edge Rate Limit bindings. After cheap method,
   content metadata, and bearer-header checks, they run before a body reader
   is acquired. This sheds malformed public floods before JSON parsing or a
   D1 token lookup.
5. A single named `UploadIngressBudget` Durable Object coordinates one
   environment-wide start budget (120/minute with a burst of 16) and at most
   eight in-flight upload leases. It is acquired before body consumption,
   hashing, token claim, envelope validation, decryption, R2, or contribution
   D1 work. A live request renews the lease every third of its configured
   lifetime; expiry remains the finite backstop for a Worker that dies before
   release. The canonical D1 consume lease is five minutes, matching the
   maximum permitted ingress-lease configuration.

The Rate Limit binding is deliberately an edge-local abuse/cost guard, not the
global capacity authority: Cloudflare documents it as local to a location with
eventual propagation. The named Durable Object is the shared ingress budget.
Rejected admission replies carry `Retry-After`. Rejection before entry leaves
the one-use authorization untouched, so the client can retry the same exact
prepared envelope after the indicated deadline. A token claimed for later
validation or persistence work is still best-effort revoked on failure.

This protects the body read and every later expensive step for syntactically
valid public requests. It is still not a substitute for the fixed 2 MiB body
bound, cryptographic checks, schema validation, per-contribution admission,
or platform-level DDoS controls.

## Queue decision: explicitly deferred

`UPLOAD_INGRESS_QUEUE_MODE` is intentionally fixed to `disabled`, and no
Cloudflare Queue producer or consumer is bound. The Worker fails closed on
upload-token issuance, `/api/ready`, and `/api/health` if someone changes that
mode before implementing the successor protocol.

Queues may be appropriate later for decoupling accepted R2-backed envelopes
from expensive database processing, but they are not a direct replacement for
the current request path: a Queue message is limited to 128 KB, while the
accepted upload envelope may be 2 MiB. A future activation therefore requires
all of the following before a Queue binding is added:

1. an R2-pointer message format with immutable object identity, digest, and
   bounded metadata rather than a body copied into the Queue;
2. consumer receipts and idempotent state transitions that survive duplicate
   delivery and retry;
3. a reviewed participant-deletion race policy for queued-but-not-processed
   objects;
4. dead-letter, age, retry, and consumer-failure observability; and
5. measured consumer concurrency and a load test that proves it cannot bypass
   the same storage/database budget.

This is a deliberate **defer**, not a claim that a Queue is unnecessary. The
stub preserves the activation requirements next to the runtime configuration
so a future change cannot silently turn on an incomplete asynchronous path.

## Rollout and operating limits

Source configuration and deployment state are separate evidence gates. The
staging gate verifies all ingress variables, all eight Rate Limit bindings,
the Durable Object binding, and its migration; post-deploy `/api/ready`
performs a non-consuming Durable Object RPC. Queue mode remains disabled. Run
a staged concurrent-upload profile against the actual Worker/D1/R2 region mix
before increasing the stated 8 / 120 / 16 / 90-second limits. A Rate Limit or
ingress-budget rejection is an overload signal, not permission to retry at
full speed.

The code emits redacted structured events for request failures, token-abandon
failures, and lease-release failures. It does **not** yet establish production
dashboards or alerts. Before raising limits, route those events plus Worker
CPU, D1 duration/errors, R2 errors, `Retry-After` compliance, and end-to-end
accepted latency to an observed log/trace destination and agree an alert and
rollback threshold. The current repository does not prove a production
capacity target or a Queue consumer SLO; changing numeric limits needs
measured evidence, not a larger estimate.

## Sources

- [Cloudflare Workers Rate Limiting bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Cloudflare Durable Objects overview](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare Queues limits](https://developers.cloudflare.com/queues/platform/limits/)
- [Cloudflare Queues batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)
