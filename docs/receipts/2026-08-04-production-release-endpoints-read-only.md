---
title: Production Release Endpoint Read-Only Observation
date: 2026-08-04
type: receipt
status: blocking-observation
---

# Production release endpoint read-only observation

## Scope and method

At 2026-08-04T18:56:44Z, the canonical endpoints from
[`config/deployment-endpoints.js`](../../config/deployment-endpoints.js) were
requested with a read-only HTTPS `GET`, a ten-second timeout, and no
credentials. No deployment, publication, enrollment, identity, R2, or local
application action was performed.

## Observed responses

| Endpoint | HTTP result | Relevant response evidence | Release meaning |
| --- | --- | --- | --- |
| `https://tibotattle.com/api/health` | `200` | `enrollmentMode: "open"`; collection controls reported `operational` and enrollment, registration, processing, and publication as `true` | **P0 containment discrepancy**: the observed live service accepts open enrollment, contrary to the disabled-staging-first channel policy. Do not direct tests or users there until an owner verifies and contains this state. |
| `https://tibotattle.com/api/ready` | `200` | `status: "ready"`; lifecycle-related checks reported ready/completed | Readiness does not prove release policy or update availability. |
| `https://updates.tibotattle.com/appcast.xml` | `404` | Cloudflare HTML Not Found response, not Sparkle XML | **P0 updater blocker**: no live appcast exists at the canonical endpoint, so no update-capable build may imply that production updates are usable. |

## Consequences

1. The current external service must be treated as **uncontained for release
   testing** until the operator checks its configuration and records the
   correction.
2. The updater remains non-operational externally until a separately approved
   beta/staging feed and its signed artifact have been published and read back.
3. This is an observation, not a deployment receipt. It is intentionally not
   evidence that the service, appcast, artifact, or identity provider is safe
   for any user-facing release.

## Follow-up gate

The owner-run staging procedure in
[`2026-08-04-release-recovery-channel-policy.md`](../decisions/2026-08-04-release-recovery-channel-policy.md)
must record a fresh, credentialed configuration check and a subsequent
unauthenticated endpoint check before any signed dogfood build points at a
network service.
