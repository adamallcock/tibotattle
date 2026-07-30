---
title: Contained Google Cloud Run Backend
date: 2026-07-27
type: runbook
status: experimental
---

# Contained Google Cloud Run backend

This is a deployment unit, storage adapter, and operational contract for a
future Google Cloud backend. It is deliberately not a second production
ingestion implementation.

The service:

- runs as a non-root Cloud Run container and listens on `PORT`;
- exposes process liveness at `/healthz`;
- exposes private Cloud Storage dependency readiness at `/readyz`;
- uses generation-zero conditional writes and generation-matched deletion for
  idempotent encrypted object handling;
- handles `SIGTERM` with a bounded request-drain window;
- requires a dedicated runtime service account;
- refuses every `/api/*` request with `collection_disabled`; and
- has no enrollment, session, contribution, metadata database, aggregation, or
  participant-data path.

Do not route users to this service and do not describe it as accepting Usage
Monitor exports.

## Local verification

```sh
npm install
npm run check

ENVIRONMENT=local-test \
COLLECTION_MODE=disabled \
OBJECT_STORE_MODE=memory \
PORT=8080 \
npm start
```

The in-memory adapter is rejected outside `local-test`.

Build locally:

```sh
docker build -t app-usagemonitor-contained:local .
docker run --rm -p 8080:8080 \
  -e ENVIRONMENT=local-test \
  -e COLLECTION_MODE=disabled \
  -e OBJECT_STORE_MODE=memory \
  -e PORT=8080 \
  app-usagemonitor-contained:local
```

## Contained staging preparation

The checked-in service template contains placeholders and cannot be deployed as
written. Prepare an isolated Google Cloud project and:

1. create a private, uniform-bucket-level-access Cloud Storage bucket;
2. retain soft delete and add an explicit lifecycle policy only after the
   deletion contract is approved;
3. create the fixed `operations/readiness-v1` marker;
4. create a single-purpose runtime service account with object access scoped
   only to that bucket;
5. build and push an immutable image digest;
6. render the three placeholders into an ignored owner-only file:

   ```sh
   npm run service:render -- \
     --output ./service.rendered.yaml \
     --image REGION-docker.pkg.dev/PROJECT/REPOSITORY/IMAGE@sha256:DIGEST \
     --service-account RUNTIME_ACCOUNT@PROJECT.iam.gserviceaccount.com \
     --bucket PRIVATE_BUCKET
   ```

   The renderer refuses tags, overwrite, a different output location, or
   malformed service-account, image-digest, and bucket values.

7. validate without deployment:

   ```sh
   gcloud run services replace service.rendered.yaml \
     --dry-run \
     --region=REGION \
     --project=PROJECT_ID
   ```

8. review the dry-run result and IAM bindings before any deployment.

9. after deployment, perform the live, read-only IAM gate:

   ```sh
   npm run iam:verify -- \
     --project PROJECT_ID \
     --region REGION \
     --bucket PRIVATE_BUCKET \
     --service-account RUNTIME_ACCOUNT@PROJECT.iam.gserviceaccount.com
   ```

   This checks the directly attached Cloud Run, bucket, and project policies:
   it rejects public principals, requires direct bucket-scoped
   `roles/storage.objectUser` for the runtime identity, and rejects any direct
   project-level role attached to that runtime identity. Before production,
   separately use Google Cloud IAM Policy Analyzer to rule out effective access
   inherited through folders, organizations, groups, or principal sets; this
   local gate cannot prove the absence of those indirect grants.

The dry-run still requires the Cloud Run Admin API to be enabled in the selected
project. This repository does not enable APIs or create resources.

The service must remain private; do not grant `roles/run.invoker` to
`allUsers`. Use an attached user-managed service account rather than a
downloaded service-account key. Google recommends attached workload identities
and avoiding service-account keys where possible.

## Why readiness is not yet production-ready

`/readyz` proves the runtime can reach one fixed object in the private bucket.
It intentionally reports `metadataStore: not_implemented`. Real contribution
acceptance stays disabled until a metadata store implements and tests the
existing participant isolation, stable digest dedupe, transactional visibility,
deletion tombstones, restore replay, immutable weekly snapshots, and bounded
orphan reconciliation.

## Primary references

- Cloud Run container runtime contract:
  <https://cloud.google.com/run/docs/container-contract>
- Cloud Run health checks:
  <https://cloud.google.com/run/docs/configuring/healthchecks>
- Cloud Storage request preconditions:
  <https://cloud.google.com/storage/docs/request-preconditions>
- Cloud Storage lifecycle management:
  <https://cloud.google.com/storage/docs/lifecycle>
- Service account security:
  <https://cloud.google.com/iam/docs/best-practices-service-accounts>
- IAM Policy Analyzer:
  <https://cloud.google.com/policy-intelligence/docs/policy-analyzer-overview>
