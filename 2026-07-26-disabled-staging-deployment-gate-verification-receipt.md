---
title: Disabled Staging Deployment Gate Verification Receipt
date: 2026-07-26
type: verification
status: passed-development
---

# Disabled Staging Deployment Gate Verification Receipt

## Result

The central Cloudflare backend has a production-shaped, fail-closed staging
configuration and deployment workflow. The workflow can prove configuration,
account capabilities, D1/R2 resources, required secret names, both migration
streams, full collection containment, strict deployment, and the post-deploy
HTTPS health contract without printing credentials or resource identifiers.

The environment is not provisioned or deployed. Collection remains
unauthorized.

## Implemented controls

- Named `staging` Worker environment with HTTPS `workers.dev` routing and
  version preview URLs disabled.
- Environment-specific D1, deletion-ledger, R2, rate-limit, assets, cron,
  observability, variables, and required-secret declarations.
- Enrollment and account-scoped ingestion fixed to `disabled`.
- Schema-valid sentinel D1 UUIDs that compile but cannot pass strict live
  readiness.
- Bounded configuration and live readiness JSON with no account email, account
  ID, resource name, resource ID, secret, path, or raw Wrangler output.
- Separate `PREPARE_DISABLED_STAGING` confirmation before remote migration.
- Preparation applies both migration streams, then sets enrollment, upload
  registration, processing, and publication to `contained`.
- No remote restoration command.
- Separate `DEPLOY_DISABLED_STAGING` confirmation before deployment.
- First-deploy keys are generated into ignored, no-clobber, mode-0600
  `.dev.vars.staging`; the local development key is never reused.
- The first-deploy secret file must be a regular non-symlink, owner-owned
  mode-0600 file with exactly the related RSA private/public pair.
- Wrangler deploy uses `--env staging --strict`; first deployment additionally
  uses the validated secret file.
- Post-deploy verification requires a bare HTTPS origin and a closed
  `/api/health` response. Any enabled collection, publication, ongoing-device,
  or external account-scoped path fails the gate.
- The legacy top-level dry deploy now explicitly selects `--env=""`, removing
  environment ambiguity after staging was added.

## Test evidence

### Focused staging and operator tests

Command:

```text
npm --prefix apps/worker run scripts:check
```

Result: 27 of 27 tests passed.

The new coverage proves:

- safe-unprovisioned checked-in configuration;
- local-open staging rejection;
- live resource/secret/migration/containment success projection;
- bounded R2-not-enabled reporting;
- confirmation before any preparation or deployment call;
- zero remote mutation for unprovisioned infrastructure;
- both D1 migrations followed by containment and reinspection;
- strict bare-HTTPS origin validation;
- binding the health probe to the exact `workers.dev` origin reported by the
  successful Wrangler deployment;
- deployment only after live readiness;
- post-deploy refusal when any collection path is enabled;
- first-deploy secret-file validation;
- owner-only key generation and no overwrite.

### Complete product gate

Command:

```text
npm run product:check
```

Result:

- 28 of 28 browser/data-contract tests passed;
- 41 of 41 loopback, contribution, queue, and local-product tests passed;
- generated Worker types matched;
- TypeScript passed;
- 27 of 27 operator-script tests passed;
- 65 of 65 Cloudflare Worker runtime tests passed;
- the top-level Worker deployment dry run passed; and
- the named staging deployment dry run passed.

The staging bundle contained five static assets and compiled with the two
isolated D1 bindings, one R2 binding, two rate limiters, assets, and exactly
three non-secret staging variables. No deployment occurred.

### Startup profile

Command:

```text
wrangler check startup --args="--env staging"
```

Result: Worker build and startup analysis passed. Wrangler labels this command
alpha and notes that the local CPU profile is diagnostic rather than a
Cloudflare-edge latency measurement. The temporary profile directory was moved
to Trash after the pass.

### Live read-only readiness

Command:

```text
npm --prefix apps/worker run staging:ready
```

Result:

```json
{
  "state": "blocked",
  "collectionAuthorized": false,
  "authenticated": true,
  "d1ServiceReachable": true,
  "r2ServiceReachable": false,
  "resourceIdentifiersConfigured": false,
  "blockers": [
    "STAGING_RESOURCE_IDENTIFIERS_NOT_CONFIGURED",
    "R2_NOT_ENABLED"
  ]
}
```

The receipt deliberately records only the bounded projection, not the
authenticated account identity or Cloudflare resource output.

## Current external boundary

Cloudflare R2 is not enabled on the authenticated account. Enabling it may
require account-level acceptance or billing, so no automated action was taken.
No D1 database or R2 bucket was created, no remote migration ran, no staging
secret was generated or installed, and no Worker was deployed.

After explicit owner enablement, the Worker runbook provides the exact resource
creation, UUID replacement, isolated key generation, contained migration, live
readiness, and strict deployment sequence.

## Documentation basis

- Cloudflare Wrangler environments and non-inherited bindings:
  <https://developers.cloudflare.com/workers/wrangler/environments/>
- Cloudflare D1 migration commands and remote behavior:
  <https://developers.cloudflare.com/d1/wrangler-commands/>
- Cloudflare R2 bucket creation and private-by-default behavior:
  <https://developers.cloudflare.com/r2/buckets/create-buckets/>
- Cloudflare required-secret validation and secret deployment:
  <https://developers.cloudflare.com/workers/configuration/secrets/>

## What this does not prove

- R2 enablement or production storage terms.
- Existence of remote staging resources.
- Remote migration or containment execution.
- Installed remote envelope keys.
- An accessible staging URL.
- Browser session behavior over deployed same-origin HTTPS.
- Remote backup, soft-delete, Cloudflare-log, cost, latency, or incident
  measurements.
- External privacy/security review.
- Consent or authorization for any real participant upload.
- Production or public aggregate release readiness.

Those remain active end-to-end gates.
