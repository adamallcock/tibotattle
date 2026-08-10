---
title: Public Upload Ingress Activation Runbook
date: 2026-08-04
type: runbook
status: blocked-pending-live-validation
---

# Public upload ingress activation

## Outcome and boundary

This is the operational gate for turning on a small invite-only contribution
cohort after the service is otherwise approved. It does **not** authorize a
deployment, public enrollment, a capacity increase, or Cloudflare Queue use.
Checked-in staging and production both remain collection-contained.

The synchronous upload path is protected by four separate controls:

1. persisted client dither and `Retry-After`-respecting local retries;
2. Cloudflare Worker Rate Limit bindings for coarse and keyed admission;
3. a single `UploadIngressBudget` Durable Object for global starts and active
   uploads; and
4. a version-controlled Cloudflare WAF per-IP rule that sheds an obvious
   pre-Worker flood.

The WAF artifact is deliberately not applied by a deployment script:
[`apps/worker/ops/cloudflare/upload-ingress-rate-limit.ruleset.json`](../../apps/worker/ops/cloudflare/upload-ingress-rate-limit.ruleset.json)
must be reviewed and applied to the intended zone by its account owner. Its
per-IP limit is an edge-local shed, not the global capacity authority.

## Preconditions

Complete all of these before any activation operation:

- `npm --prefix apps/worker run check` passes on the reviewed commit.
- `npm --prefix apps/worker run staging:check` and the production dry run pass.
- The staging resource, migrations, all four required secrets, all nine rate
  limit bindings, and the `UploadIngressBudget` Durable Object migration are
  live and verified by `staging:ready`.
- The operator has the `READINESS_PROBE_TOKEN` in approved secret storage and
  supplies it only through the `USAGE_MONITOR_READINESS_PROBE_TOKEN`
  environment variable. Do not put it in a command line, receipt, source
  file, shell history, or issue.
- `GET /api/health` returns only public liveness. An authenticated
  `GET /api/ready` proves lifecycle state, ingress-probe availability, and
  collection containment. It must be used for every deployment and rollback
  verification.
- The WAF rule has been applied to staging first, and its managed-zone rule ID,
  change time, and reviewer are stored in an owner-only external receipt.
- Structured Worker logs are routed to an observed destination. Before the
  first cohort, create alerts for `upload_ingress_finished`,
  `upload_authorization_abandon_failed`, and
  `upload_ingress_lease_heartbeat_stop_failed`, plus Worker errors, D1/R2
  errors, and ingress 429/503 outcomes.

No live action proceeds while `/api/ready` is unavailable or any control is
not `contained` before the reviewed activation step.

## Initial configuration

Do not raise the checked-in production-shaped limits during the first ramp:

| Control | Initial value | Purpose |
|---|---:|---|
| Durable Object active leases | 8 | Global ceiling for body, crypto, R2, and D1 work. |
| Durable Object starts | 120/min, burst 16 | Shared start budget. |
| Worker ingress limits | 240/min coarse; 20/min keyed client | Cheap pre-body shedding. |
| WAF per-IP rule | 30/min; 60-second mitigation | Pre-Worker flood shedding. |
| Body bounds | 60 s total; 15 s idle; 2 MiB | Slow-body and memory bound. |
| Ingress lifetime | 4 minutes fixed maximum | A live request cannot renew shared capacity indefinitely. |

The five-minute consuming-authorization fence intentionally exceeds the
four-minute ingress lifetime. A stale request is checked before R2 and D1
side effects; a tracked orphan is reconciled rather than treated as accepted.

## Staged activation and rollback drill

Use only the existing reviewed collection-control and pilot-control operations;
never edit variables in place or widen a route to bypass these gates.

1. Deploy and verify a **contained** staging build. Save the bounded operation
   receipt outside Git.
2. Run one intentional, low-rate internal upload through the complete native
   client path. Confirm the client preserves its dithered next-attempt time
   and that `Retry-After` moves the queue's persisted retry floor forward.
3. Activate one invite-only participant. Observe at least one complete
   six-hour client scheduling interval plus one hourly lifecycle pass.
4. If the evidence is healthy, widen the reviewed cohort no faster than
   1 → 2 → 4 → 8 participants, holding each step for a full scheduling
   interval. Keep publication disabled throughout.
5. At each hold, record only aggregate counts/latency/error rates and the
   presence of redacted structured event names. Do not place IPs, bearer
   values, invitation IDs, envelope digests, or object keys in the record.
6. Exercise rollback once in staging before any production-facing cohort:
   contain controls, redeploy the contained configuration if needed, verify
   authenticated `/api/ready`, and verify that queued local work remains
   pending rather than being discarded.

Pause/contain immediately when any of the following persists for two
consecutive 15-minute windows: accepted-upload 5xx above 1%, ingress 503
above 0.5%, p95 accepted latency above 90 seconds, or any uninvestigated
`UPLOAD_INGRESS_UNAVAILABLE` burst. Treat an edge/WAF 429 as an abuse signal;
do not increase limits to make it disappear. These are initial safety
thresholds, not a claimed production SLO; capacity changes require a measured
concurrent-upload profile and a new reviewed receipt.

## Cloudflare Queues: intentionally deferred

`UPLOAD_INGRESS_QUEUE_MODE` remains `disabled`, and no Queue binding is
present. A Queue cannot carry the accepted 2 MiB envelope directly. Before it
is reconsidered, design and validate an R2-pointer message, idempotent
consumer receipt/state machine, participant-deletion race policy, dead-letter
and age monitoring, and bounded consumer concurrency sharing the same D1/R2
budget. See the adjacent [decision record](../decisions/2026-08-04-public-upload-ingress-admission.md).

## Evidence required to close this runbook

- exact reviewed commit and configuration dry-run results;
- owner-only staging and rollback receipts;
- WAF rule review/apply evidence (not a secret or account identifier);
- aggregate ramp observations and alert outcomes; and
- a decision to keep limits, reduce them, or stop the public path.

Without those evidence items, retain `ENROLLMENT_MODE=disabled` and all four
collection controls contained.
