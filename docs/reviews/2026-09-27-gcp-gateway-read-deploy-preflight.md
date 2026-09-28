---
title: GCP test gateway read deployment preflight
date: 2026-09-27
type: review
status: snapshot
---

# GCP test gateway read deployment preflight

**Status:** test-project snapshot for the two authenticated manifest GET routes
in source revision `9e26e842c5fafb5d4fcce60e0217111f72e02d5c`. The initial
preflight was read-only. A later authorized test-only image attempt is recorded
below; its staged qualification failed and did not complete deployment. No
migration, IAM change, or Logging change was performed. This is not production
readiness or cutover approval.

## Finding

The reviewed source archive and regional Cloud Build path can produce and
qualify an immutable image for the test project. The existing gated deployer,
[`gcp-private-test-deploy.mjs`](../../apps/worker/scripts/gcp-private-test-deploy.mjs#L1202),
is fixed to `tibotattle-test-app`; it does not cover the public gateway. The
follow-on gateway-specific guard is implemented in
[`gcp-test-gateway-deploy.mjs`](../../apps/worker/scripts/gcp-test-gateway-deploy.mjs).
It reuses the existing exact-archive and Cloud Build provenance assessors, then
checks the fixed gateway service, public IAM/ingress, four reviewed environment
values, runtime account, `_Default` request-log exclusion, the exact revision
receiving 100% traffic, and a matching service-template image. Its `deploy` mode
requires explicit fixed-service confirmation, tags and polls the exact
no-traffic candidate, verifies it while the captured revision remains at 100%,
then switches traffic and removes the temporary tag. Rollback restores both
captured traffic and the service-template image. This guard change is local;
the live test-only attempt below exposed the prior guard behavior and was not
qualified as a deployment.

The new gateway paths are `GET /api/v1/device/sync/manifest` and
`GET /api/v1/device/telemetry/v1.2/day-manifests` in
[`oauth-gateway.mjs`](../../apps/worker/cloud-run/oauth-gateway.mjs#L204).
Their source checks cover authorization and route/query rejection, but do not
prove a live application-token request.

## Test-project snapshot

Read-only Cloud Run and Logging inspection on 2026-09-27 found:

- Gateway `tibotattle-test-oauth-gateway` in `us-east1` was ready at revision
  `tibotattle-test-oauth-gateway-00005-qj2`, with 100% traffic and image
  `us-east1-docker.pkg.dev/tibotattle/tibotattle-test/tibotattle-host@sha256:5ab5c1697293a48c422c682b97b1ec8503f0ba184cb02bd0612432313eb0f60e`.
- Backend `tibotattle-test-app` was ready at revision
  `tibotattle-test-app-00047-hm6`, also at 100% on that image. Its service IAM
  policy had no public invoker binding; the gateway runtime identity had an
  invoker binding.
- Gateway ingress was public, and its IAM policy contained exactly one binding:
  `roles/run.invoker` for `allUsers`. Its attached runtime account matched the
  test gateway configuration. Extra IAM bindings or principals are treated as
  unreviewed access drift by the guard. These are required properties of this
  browser-facing test gateway, not production guidance.
- The gateway revision had exactly four configured `OAUTH_GATEWAY_*` variable
  names and no secret references. The guard requires those exact names/values,
  rejects extra variables and secret references, and never returns environment
  values in its result.
- The enabled `_Default` sink exclusion
  `tibotattle_test_oauth_gateway_requests` matched the exact gateway service
  and `run.googleapis.com/requests`. The project had only `_Default` and
  `_Required` sinks; no folder or organization ancestor was returned.

## Failed test-only staging attempt

An authorized test-only attempt used successful Cloud Build `92465ed3` for the
candidate image `sha256:7913cec3…`. The guard created no-traffic revision
`tibotattle-test-oauth-gateway-00006-vrr`, then refused its immediate readback
with `GCP_GATEWAY_LATEST_READY_REVISION_MISMATCH`,
`GCP_GATEWAY_IMAGE_DIGEST_UNQUALIFIED`, and
`GCP_GATEWAY_NEW_REVISION_NOT_READY`. It restored 100% traffic to prior revision
`tibotattle-test-oauth-gateway-00005-qj2`, but the service template continued to
point at the candidate image. That was an incomplete rollback, not a successful
deployment. The later read-only snapshot found 00005 still serving 100%, health
responding 200, and the new GET route returning 404; no authenticated device
journey was qualified.

The readback failure came from using `latestReadyRevision` as the revision to
inspect immediately after a no-traffic update. At that point Cloud Run still
reported 00005 as latest-ready while 00006 was latest-created; the old image was
therefore compared with the candidate digest. A later readback showed 00006 as
`Ready=True` with reason `Retired`. Cloud Run documents `RETIRED` as
infrastructure retired for a non-current revision and recommends a traffic tag
for testing a no-traffic revision. The repaired guard tags and polls the exact
latest-created revision, keeps old traffic at 100% during qualification,
removes the temporary tag during traffic switch, and restores the service
template image on rollback. It may reuse a retained latest-created candidate
only after exact image/config and source-build checks; ordinary preflight blocks
the candidate-template/old-traffic mismatch.

Cloud Run documents the retired revision state in [Manage revisions](https://docs.cloud.google.com/run/docs/managing/revisions)
and tagged no-traffic staging and cleanup in [traffic migration](https://docs.cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration)
and the [`update-traffic` reference](https://docs.cloud.google.com/sdk/gcloud/reference/run/services/update-traffic).

The current configured public origin is
`https://tibotattle-test-oauth-gateway-806510610397.us-east1.run.app`. It
matches the source constant
[`SYNTHETIC_V12_PUBLIC_GATEWAY_ORIGIN`](../../apps/worker/cloud-run/synthetic-v12-smoke.mjs#L32)
and is intentionally different from the Cloud Run-generated service URL. The
configured backend origin and audience both match the fixed test backend URL.
The gateway rejects Host values that do not match its configured public
origin ([`validHostHeader`](../../apps/worker/cloud-run/oauth-gateway.mjs#L198)
and [configuration validation](../../apps/worker/cloud-run/oauth-gateway.mjs#L557)).

## Exact-image sequence and recovery

After the final integrated source revision and its owning tests pass:

1. Run `node apps/worker/scripts/cloud-run-build-context.mjs --check` and
   create an archive with
   `node apps/worker/scripts/cloud-run-build-archive.mjs --output=<new absolute path>`.
   Use the archive receipt's create-only upload command and read back the exact
   object generation. Submit that archive through
   `cloud-run-source-build-submit.mjs`; inspect the regional Cloud Build receipt
   for successful status, the exact source object generation and SHA-256, and
   the immutable image digest. Do not use `gcloud builds submit`, which stages
   through the caller's default bucket. The archive interface supplies the
   create-only upload, generation readback, and build-description arguments
   ([`cloud-run-build-archive.mjs`](../../apps/worker/scripts/cloud-run-build-archive.mjs#L250)).
2. Before updating the gateway, require a fresh service/IAM/Logging readback and
   record the exact ready revision currently receiving 100% traffic as the
   rollback target. Require the expected test-only mode, configured public
   origin, fixed backend origin and matching audience, runtime account, public
   ingress/invoker policy, and enabled request-log exclusion. Stop if any
   setting differs; do not repair IAM or Logging in this deployment step.
3. Use a gateway-specific guard with the verified immutable image. It tags the
   no-traffic revision, polls its exact ready revision and verifies image and
   preserved settings while old traffic remains at 100%, then switches traffic
   to that revision and removes the temporary tag. This check does not exercise
   an authenticated route.
   Cloud Run supports image-only service updates with `--no-traffic` and exact
   revision traffic assignment ([service update](https://docs.cloud.google.com/sdk/gcloud/reference/run/services/update),
   [traffic update](https://docs.cloud.google.com/sdk/gcloud/reference/run/services/update-traffic)).
4. Read back the new ready revision, exact image digest, full traffic assignment,
   service IAM, gateway environment, runtime account, and `_Default` exclusion.
   Keep the private backend on its existing image unless the final source review
   shows a backend change is required; the reviewed route change is in the
   gateway allowlist, while the backend manifest readers predate it.
5. If post-update checks fail, assign 100% traffic to the captured rollback
   revision, remove the temporary tag, and restore the prior service-template
   image with a no-traffic update. Then verify that exact revision and matching
   prior image receive 100% traffic, the template matches, and the tag is absent.
   The traffic rollback command is
   `gcloud run services update-traffic tibotattle-test-oauth-gateway --to-revisions=<captured-revision>=100 --remove-tags=codex-stage --project=tibotattle --region=us-east1 --quiet`.
   Preserve the new revision and failure receipt for diagnosis; do not make a
   compensating IAM, Logging, or backend change.

No live canary request against a tagged revision is qualified: its generated
tag hostname differs from the configured public origin that the gateway checks.
The old serving revision returned 200 for health and 404 for the new GET route,
as expected before the candidate was deployed. This does not validate the
candidate's routes. The current source suite covers static route and
authorization behavior. A live authenticated GET also requires an approved
synthetic device authorization; no such journey was run. The guard reports route
smoke as not run, leaving that separate test-owner credential gate explicit.

The local guard interface is `npm --prefix apps/worker run gcp:test-gateway --`
followed by `preflight`, `verify`, or `deploy`. `preflight` is read-only.
`verify` and `deploy` require generated archive/build receipt arguments;
`deploy` additionally requires
`--confirm-test-gateway-deploy=tibotattle-test-oauth-gateway`. The focused
no-live-call contract tests run with
`npm --prefix apps/worker run gcp:test-gateway:check`.

## Evidence boundary

The source build receipt from 2026-09-25 qualifies the prior image only. Cloud
Build `92465ed3` qualifies the candidate's source/build/image provenance, but
the staged qualification failed and does not qualify deployment. The
2026-09-25 gateway receipt is historical, not current runtime evidence. The
later read-only observation above is the only live state evidence recorded in
this review. Production Cloudflare was not inspected or changed.
