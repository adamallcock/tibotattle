---
title: GCP handover readiness catalog
date: 2026-09-25
type: review
status: snapshot
---

# GCP handover readiness catalog

**Status:** source and test-project review of candidate
`9c2a58617092fa957628fc7323bcfdde3c3625ab` on 2026-09-25. It catalogs what
must be true before production traffic could move from Cloudflare to Google
Cloud. It is not a go decision: the
[integration plan](../plans/2026-09-24-gcp-source-integration.md) still
records a production no-go, and production Cloudflare remains the serving
system.

**Scope:** the hosted contribution service, its data, its clients, and the
operations around it. Evidence comes from code at that commit, the plan's dated
production observations, and the live test project. Items marked *inferred*
were not directly observed.

## Bottom line

The Google data plane works for one narrow path: exact-source images on an
IAM-private Cloud Run backend, Cloud SQL PostgreSQL 17 with a separate erasure
ledger, GCS, and a synthetic v1.2 upload and exact-owner erasure through a
public test gateway. Everything a production handover depends on beyond that
is open. The production request path is hard-disabled, most routes and older
telemetry formats have no handler, identity and admin are unported, no
production data has been exported or transferred, and scheduled maintenance,
analytics publication, monitoring, and rollback do not exist on GCP.

The cheapest viable handover keeps every hostname unchanged. Consent, stored
device state, and pseudonyms are bound to `https://tibotattle.com`, and every
shipped client embeds it, so a DNS-level move avoids a client release and
re-consent, but only if GCP answers exactly as the Worker does today.

## Already proven in the test project

| Capability | Evidence |
|---|---|
| Exact-source build, provenance-gated deploy, IAM-private backend | [reconciled candidate journey](../receipts/2026-09-25-gcp-reconciled-candidate-journey.md) |
| Zonal Cloud SQL primary (migration 44) and independent ledger (6), GCS | same receipt |
| Narrow public gateway with callback request-log exclusion | same receipt; [plan](../plans/2026-09-24-gcp-source-integration.md) |
| Synthetic v1.2 upload, replay, rotation, readback, exact-owner erasure, replayed cleanup | same receipt |
| Synthetic daily aggregate publish and IAM-private read | [A2 private daily read retry](../receipts/2026-09-25-gcp-a2-private-daily-read-retry.md) |
| 100,000-member graph publication benchmark (about 186 to 285 seconds) | [indexed hosted graph](../receipts/2026-09-25-gcp-graph-readindexed-hosted.md) |
| Analytics owner retirement and social owner erasure (source, PostgreSQL 17 tests only) | candidate commits `96af368d`, `8af753e0` |

## Decisions to make first

These shape every later requirement.

1. **Keep the exact origins.** Recommended. `tibotattle.com`, `www`, `admin`,
   `updates`, and the dogfood hosts are constants in
   [deployment-endpoints](../../config/deployment-endpoints.js), packed into
   Electron 0.1.19 and later and signed into native builds up to 0.1.18.
   Consent matches on the destination origin, accountless transport accepts
   only that origin, and account-track pseudonyms hash it. Changing any
   hostname forces a client release, re-consent, and a pseudonym break (see
   the [accountless sharing decision](../decisions/2026-09-04-accountless-sharing-policy.md)).
2. **Edge topology.** Either keep Cloudflare as the edge (DNS, TLS, WAF,
   Access, and the trusted `CF-Connecting-IP`) in front of a GCP origin, or
   move ingress fully to Google (external load balancer, Cloud Armor, IAP).
   The first keeps Access-based admin authentication (the GCP host already
   preserves the Access assertion on the admin host) and keeps Cloudflare as a
   processor, but the origin must accept only Cloudflare, and the host must be
   changed to trust `CF-Connecting-IP` from that edge, because it currently
   strips every `cf-*` header used for rate limiting. The second needs admin
   authentication changes, because
   [admin access](../../apps/worker/src/admin-access.ts) accepts only
   `*.cloudflareaccess.com` issuers, and a new trusted client-address source.
3. **Scope: full parity or a narrower launch.** Retiring Apple sign-in,
   v0.x/v1.0/v1.1 upload formats, or performance telemetry shrinks the port.
   Each retirement needs a client release first, and native builds up to
   0.1.18 can move only through the Sparkle-to-Electron transition.
4. **What stays on Cloudflare.** The update and release hosting
   (`updates.tibotattle.com`, the Sparkle appcast guard, the dogfood Worker and
   buckets) and the Cloudflare analytics used for download counts have no GCP
   design. Keeping them on Cloudflare is the simplest option.
5. **Public analytics continuity.** Port the community publication lifecycle,
   recompute publications on GCP, or accept a reset of public community
   history. The D1 analytics contract differs from PostgreSQL's.
6. **Legacy data scope.** Decide whether the unbound legacy primary D1 (about
   10 GB and 4.1 million raw v1 rows in the plan's observation) is
   transferred, archived, or retired.
7. **Disclosure.** Decide whether and how to notify contributors of a
   processor change, whether to disclose providers and regions, and the
   request-log and IP posture on Google.

## Requirements by area

Status words: **Proven** (in the test project), **Partial**, **Missing**, and
**Decision** (owner choice pending).

### A. Request path and route parity

| Requirement | Now |
|---|---|
| A production composition root that serves the Worker request path on Cloud Run | **Missing.** `isPostgresWorkerRequestPathSupported()` returns `false` ([backend composition](../../apps/worker/src/backend-composition.ts)); host modes are pinned to the test service. |
| Every one of the 51 route contracts ported, retained elsewhere, or retired, then exercised against the chosen ingress | **Partial.** Classified in the [route parity review](./2026-09-25-gcp-route-parity-review.md); the public test gateway forwards 18. |
| Batch 1 privacy and operations routes: `/api/ready`, export, device inventory and revocation, owner admin action | **Missing** (all return 404 through the gateway). |
| Every still-accepted upload format (v0.1 through v1.2) and performance telemetry, or explicit retirement after client releases | **Missing.** The GCP contribution route accepts v1.2 only. |
| Production transport-lifecycle rows and per-participant and per-device format floors read back and preserved | **Missing.** Not in the repository; needs a D1 readback. |
| Client-compatible responses: no redirects on client paths, exact `cache-control: no-store`, JSON types, and 503 with `Retry-After` (never 404, 421, or HTML) during any transition | **Missing** (unverified). Accountless uploads pause after a terminal failure. |

### B. Identity, sessions, and admin

| Requirement | Now |
|---|---|
| Real Google sign-in and enrollment on GCP with the registered production callback | **Missing.** No test OAuth client is configured; only the callback log exclusion is proven. |
| Apple sign-in ported, or retired with client and privacy-text changes | **Missing** or **Decision**. |
| Session cookie `__Host-usage_monitor_session`, CSRF, and same-origin checks byte-identical, with `PUBLIC_ORIGIN` and `HOST_ORIGIN` both `https://tibotattle.com` | **Partial** (test origin only). |
| Active sessions, pairings, and sign-in handoffs transferred, or a planned forced re-sign-in | **Missing.** |
| Admin host, console, owner pin, and CSRF behind Access or a replacement | **Missing.** |

### C. Database transfer (D1 to Cloud SQL)

| Requirement | Now |
|---|---|
| A consistent snapshot: fence writes, prove the drain, export, and seal | **Missing.** Cloudflare fences exist but have not proven a drain; there is no export-and-seal tool, and a large D1 export can make the database unavailable. |
| Importers for identity and authority: participants, sessions, devices, pairings, grants, accountless authority, consents, capabilities, transport floors, collection controls | **Missing.** Other importers depend on them; the typed legacy transfer refuses without participants and owner links. |
| Importers for telemetry: production v1.2, typed v1/v1.1, v0.x contributions, performance telemetry | **Partial.** Typed legacy, admission, headers, and usage corrections are rehearsed on sealed or synthetic inputs. Production v1.2, v0.x, and performance are missing, and performance has no PostgreSQL tables. |
| Analytics state: owner state, cursors, journal, applied events; decide on publications and derived state | **Partial.** The first group is rehearsed on sealed inputs. |
| Erasure ledger transfer (tombstones, cooldowns, storage erasure jobs) into the production ledger | **Partial.** Rehearsed into disposable and test schemas only. |
| A production target mode. Every importer currently requires a disposable prefix schema | **Missing.** |
| One orchestrated, resumable, whole-family transfer reconciled source against destination, with stored `consent_version` values preserved exactly | **Missing.** |
| Final-delta capture between snapshot and cutover | **Missing.** |

### D. Stored objects (R2 to GCS)

| Requirement | Now |
|---|---|
| Live R2 inventory with a read-scoped token | **Missing** (tooling exists, never run live). |
| Copy of the quarantine bucket (57,300 objects and 7.92 GB in the plan's observation) with byte and metadata comparison | **Partial** (synthetic rehearsals only). |
| Database references mapped to GCS objects, with the referenced set reconciled (no orphans, no dangling references) | **Missing.** |
| Bucket posture for erasure proofs (soft delete off, birth-history receipt) and for indefinitely retained envelopes (no age-based lifecycle deletion) | **Proven** for the isolated test bucket only. |
| Release bucket (196 objects and 12.7 GB) and appcast guard hosting | **Decision** (see decision 4). |

### E. Scheduled work and analytics

| Requirement | Now |
|---|---|
| Every-minute maintenance parity: telemetry retention, restore replay, tombstone retention, storage erasure jobs, quarantine reconciliation, diagnostics prune | **Partial.** [PostgreSQL maintenance](../../apps/worker/src/postgres-maintenance.ts) covers purges, device lifecycle, and orphan reconciliation; the rest are hard-coded incomplete. |
| Scheduler and Job definitions for production, replacing the paused test Scheduler | **Missing.** None are in the repository. |
| Analytics delivery, erasure jobs, retirement sweeps, daily and graph publication | **Partial.** One synthetic daily publication and a graph benchmark. |
| Public community daily and graph parity, including allowance | **Missing.** The private reader is reduced and withholds allowance. |
| A matched Cloudflare comparison before any speed claim | **Missing.** No tenfold claim is supported. |

### F. Privacy, retention, and erasure

| Requirement | Now |
|---|---|
| Owner-only erasure end to end for social and accountless owners, including analytics retirement | **Partial.** PostgreSQL erasers are tested but unrouted; accountless analytics retirement is in progress separately; owners with a redeemed community grant are refused. |
| Documented hosted lifetimes enforced ([privacy reference](../reference/local-data-and-privacy.md)): 30-minute sessions, 5-minute upload authorizations, 24-hour sign-in admission rows, 30-day cooldowns, 400-day tombstones, 30-day diagnostics | **Partial.** Tombstone expiry and the diagnostics prune are not in the PostgreSQL path (*inferred*). |
| Cloud SQL backup, point-in-time, and on-demand backup horizons below the 400-day restore-suppression tombstone, and documented | **Missing.** On-demand backups do not expire on their own. |
| Client IPs never persisted or logged ([admission](../../apps/worker/src/admission.ts)): request-log exclusions for every public service, or disclosed logging | **Partial.** Only the test gateway has an exclusion. |
| OAuth callback queries never logged | **Proven** for the test gateway. |
| IP-derived download analytics | **Decision.** Depends on Cloudflare analytics today. |

### G. Operations

| Requirement | Now |
|---|---|
| Production deploy pipeline with the provenance gate and the deployment lock | **Missing.** The gate is pinned to the test service. |
| Infrastructure as code for services, Jobs, databases, buckets, IAM, Scheduler, and logging | **Missing.** No definitions are in the repository; the test resources were created by one-off commands and scripts. |
| CI running the Worker gate, Cloud Run check, and PostgreSQL suite | **Missing.** None of the 18 workflows builds or tests this code. |
| Production migration procedure with a pre-migration backup | **Partial.** Rehearsed on test. |
| Restore rehearsal from a Cloud SQL backup on the integrated line | **Missing.** |
| Monitoring and alerting: health, errors, latency, database saturation, Job failures, cost | **Missing.** |
| Owner-reachable incident containment (collection controls) | **Partial.** Test compare-and-set Jobs only. |
| Secrets carried over byte-identical in Secret Manager: envelope key pair (same key ID), identity-link secret and version, OIDC and Apple secrets, rate-limit secret, tokens | **Partial.** Test envelope keys only; identity-link rotation is unsupported. |
| GCP runbooks, indexed in `docs/README.md` | **Missing.** |

### H. Edge, hosting, and security

| Requirement | Now |
|---|---|
| Custom domains and TLS for the apex, `www`, and `admin`, with the `www` to apex 308 | **Missing.** The GCP host answers 421 for hosts outside its allowlist ([request boundary](../../apps/worker/cloud-run/request-boundary.mjs)). |
| Public website and security headers served from GCP, or retained | **Missing.** Only the test build stages the raw `apps/web/public` tree; the production release site is not packaged for GCP. |
| A trusted client address for per-client rate limits, plus the upload WAF rule | **Missing.** The GCP host strips `cf-*` and `x-forwarded-*`, so per-client keys fall back to one shared bucket (*inferred*). |
| Production rate-limit values and the upload ingress budget on a reachable path | **Missing.** Current defaults are test values. |
| Caching for public community reads | **Missing.** |

### I. Capacity, resilience, and cost

| Requirement | Now |
|---|---|
| Database tier, storage growth, and HA posture sized from measured production data | **Missing.** The test primary is zonal `db-g1-small` with 10 GiB and no auto-growth. |
| Sustained load test at production limits (3,000 uploads a minute in the production config) | **Missing.** |
| Cost model covering backups, requests, logging, Scheduler, and egress | **Partial.** The test-topology model has a price snapshot that expires after 30 days. |

### J. Cutover and rollback

| Requirement | Now |
|---|---|
| A written, rehearsed cutover runbook: fence, drain proof, export, transfer, reconcile, final delta, DNS TTL plan, observation window | **Missing.** |
| Shadow or read-compare window before the switch | **Missing.** |
| Rollback that accounts for writes accepted on GCP | **Missing.** The Cloudflare maintenance restore refuses after a target-write latch. |
| Explicit production authorization for the exact operations | **Required.** |

### K. Documentation and disclosure

| Requirement | Now |
|---|---|
| Public [privacy page](../../apps/web/public/privacy.html), which names Cloudflare D1, R2, and Access | **Missing** (text update). |
| [System architecture](../reference/system-architecture.md), privacy reference, API surface, [production operations](../runbooks/production-operations.md), READMEs, `SECURITY.md`, and `CONTRIBUTING.md` | **Missing.** A public-documentation test pins the literal "Cloudflare Access". |
| Superseding the [upload ingress decision](../decisions/2026-08-04-public-upload-ingress-admission.md) (Cloudflare rate limits and a Durable Object budget) | **Decision.** |

## Entry criteria

A handover can be considered when all of these hold:

1. The seven decisions above are recorded.
2. A GCP environment serves the full production request path for every
   retained route and format, and real Electron and native clients pass
   against it through a host override.
3. Google sign-in (and Apple, unless retired) works end to end.
4. Owner erasure, retention, and restore suppression match the Worker live.
5. A full rehearsal on a copy of production-shaped data completes: fenced
   snapshot, every family transferred and reconciled with no unexplained
   differences, and objects copied and remapped.
6. Operations exist: infrastructure as code, CI, alerting, runbooks, a
   backup restore rehearsal, and secrets.
7. Load and cost are measured and capacity is sized.
8. Cutover and rollback runbooks are rehearsed.

## Suggested order

1. Record the decisions, since they remove or add whole areas.
2. Build the production composition root with route and format parity,
   identity, and admin, in a staging-like GCP environment.
3. Port scheduled maintenance, analytics publication, and retention and
   erasure parity.
4. Build export-and-seal, identity and authority importers, orchestrated
   transfer, and the live R2 inventory, copy, and remap.
5. Add infrastructure as code, CI, runbooks, monitoring, backups, and secrets.
6. Run a full dress rehearsal with production-shaped data, real clients, load,
   and cost.
7. Cut over with a rehearsed rollback.
