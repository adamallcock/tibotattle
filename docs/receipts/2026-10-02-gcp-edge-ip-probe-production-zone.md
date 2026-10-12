---
title: GCP edge IP probe on the production zone
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP edge IP probe on the production zone

This is a 2026-10-02 receipt for the owner-run rerun of the edge IP probe from
the `tibotattle.com` zone: cutover checklist item OWN-7 and the gate on the
gcp switch in OD-E6 of the
[thin-edge decision record](../decisions/2026-10-01-thin-worker-edge-proxy.md#od-e6-recommendation-and-gate).
It follows the
[probe's README](../../apps/worker/scripts/edge-ip-probe/README.md#rerun-it-on-the-production-zone-before-the-first-gcp-deploy).
It copies only header names, booleans and token counts. No address, salt,
hash or header value was returned, logged or stored, and none appears here.

The run is a live observation of one request from one connection, at about
16:30 UTC on 2026-10-02. It deployed no part of the edge and changed nothing on
the production Worker. It is not a deployment receipt and proves no other gate.

## Setup

- **The echo:** `tibotattle-ip-probe-echo`, a temporary public Cloud Run
  service in the GCP test project (us-east1), deployed from
  `apps/worker/scripts/edge-ip-probe/echo-server.mjs` on the fast-path line.
- **The probe Worker:** `tibotattle-edge-ip-probe`, deployed by the owner with
  Wrangler from a scratch directory outside the repository, with
  `workers_dev` set to `false` and one exact-path route, `tibotattle.com/probe`,
  on the **`tibotattle.com` zone**. The production Worker's name,
  configuration and custom domains were not touched, and the production Worker
  serves nothing at `/probe`.
- **The call:** the owner called `/probe` from their own connection. The first
  call returned the site's HTML because the route had not yet propagated; a
  later call returned the probe's JSON. Only that later answer is read here.

## Result: pass

| Observation | Result |
|---|---|
| `visitorSeenByWorker` | `true`, so the run is valid |
| Header names that reached Cloud Run | `accept-encoding`, `cdn-loop`, `cf-ew-via`, `cf-ray`, `cf-visitor`, `cf-worker`, `forwarded`, `host`, `traceparent`, `x-cloud-trace-context`, `x-forwarded-for`, `x-forwarded-proto`, and the two probe headers. Identical to the 2026-10-02 `workers.dev` run; no new name, and no `cf-ip*` name |
| `cf-connecting-ip` | Absent |
| `x-real-ip` | Absent |
| `true-client-ip` | Absent |
| `x-forwarded-for` | 2 tokens; contains the edge's placeholder: yes; contains the visitor: no |
| `forwarded` (added by Google's front end) | 4 tokens; contains the placeholder: no; contains the visitor: no |
| `x-forwarded-proto` | 1 token |
| Any header containing the visitor's address | None |

From the production zone, with the edge's `x-real-ip` override, no header
carrying the visitor's address reached the Google Cloud origin, and the header
names matched the earlier `workers.dev` run
([edge receipt](./2026-10-01-gcp-edge-proxy-local.md#cloudflare-network-address-probe)).
Every pass condition in the probe's README holds, so the production-zone gate
on the gcp switch (OD-E6) passes.

## Not covered

- The counterfactual without the override. The probe always sends it, so the
  override and E12's S7 assertion of it stay load-bearing.
- The token exchange with `oauth2.googleapis.com`, which gets the same kind of
  subrequest and the same override but cannot be observed this way.
- Headers that Google's front end receives and does not deliver: the container
  is the observation point. The values of headers whose names are not
  address-like were not examined.
- Delivery to an IAM-private service: the echo was public.
- Any later change to the edge's topology, such as OD-E6's option A, which
  would need its own passing probe.

## Cleanup

- The owner deleted the probe Worker (`wrangler delete` reported it deleted).
  Afterwards `/probe` on the zone returned the production site's own 404 page
  and not the probe's JSON, so the route is gone.
- The echo service and the image that its source deploy left in the test
  project's Artifact Registry repository were deleted, and both were verified
  gone.

## Evidence boundary

This receipt records one owner-run observation on Cloudflare's network. It is
not a deployment, staging or cutover receipt. The edge's implementation, local
tests, the staging rehearsal, the writer fence, the production cutover and the
privacy-page publication are separate gates, and this run proves none of them.
