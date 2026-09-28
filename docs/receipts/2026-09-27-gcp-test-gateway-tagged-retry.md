---
title: GCP test gateway tagged revision retry
date: 2026-09-27
type: receipt
status: snapshot
---

# GCP test gateway tagged revision retry

This is a test-project deployment and anonymous route readback on 2026-09-27
EDT. It does not qualify authenticated application behavior, the private
backend's database version, an installed client, or production cutover.
Production Cloudflare resources were not changed by this deployment.

## Exact test-only attempt

The fixed-target guard in `apps/worker/scripts/gcp-test-gateway-deploy.mjs`
validated local source archive SHA-256
`aa7dd181a284593d78368aa70aa2903ac5250b390f922c5239354fe88301be00`,
regional Cloud Build `92465ed3-bd1f-4220-8a8d-73771bbc91e0`, source object
generation `1790555018627958`, and immutable image
`us-east1-docker.pkg.dev/tibotattle/tibotattle-test/tibotattle-host@sha256:7913cec341f72acc6d14b9bf8520f9df58729c2f926da536096fef9405fdbc9e`.
The source archive's content digest was
`8c882d7a7519565cf40c078ffbe8cb4ff739912664801f00a5d2f73fb948be08`.

Before retry, Cloud Run still sent 100% to
`tibotattle-test-oauth-gateway-00005-qj2`; the service template pointed at the
candidate image, and latest-created candidate `00006-vrr` was retained but
unserved. The serving and candidate revision `spec` values had identical
SHA-256 hashes after excluding the container image field. The guard reused the
exact candidate, attached a temporary `codex-stage` tag, qualified its ready
revision while old traffic stayed at 100%, then switched traffic and removed
the tag. It returned `status: deployed`, `postDeployReadback: true`, and
revision `tibotattle-test-oauth-gateway-00006-vrr`.

An independent `gcloud run services describe` readback showed generation 8
observed, latest-created and latest-ready both `00006-vrr`, the pinned template
image above, and one 100% traffic assignment to `00006-vrr`. The prior
revision `00005-qj2` remains the captured rollback target. No backend service,
schema, IAM policy, or Logging configuration was changed in this attempt.

## Public route probes

At the fixed test gateway origin, anonymous, redirect-disabled requests gave:

| Request | Status | Redirect or Set-Cookie |
|---|---:|---|
| `GET /api/health` | 200 | Neither |
| `GET /api/v1/device/sync/manifest?fromDay=2026-09-01&toDay=2026-09-02` | 401 | Neither |
| `GET /api/v1/device/telemetry/v1.2/day-manifests?fromDay=2026-09-01&toDay=2026-09-02` | 401 | Neither |
| `GET /api/v1/device/sync-capabilities-v1.2` | 401 | Neither |

The v1.2 day-manifests GET without its required `fromDay` and `toDay` query
returned 404, as expected from the closed route contract. These probes show
public routing and anonymous refusal only. A synthetic device credential and
the private backend must be exercised before calling the read journey green.

The local gateway guard suite passed 15/15 after the repair. Its independent
read-only audit found no high-severity issue for this isolated retry, while
noting that concurrent service deployers could race the final traffic switch.
