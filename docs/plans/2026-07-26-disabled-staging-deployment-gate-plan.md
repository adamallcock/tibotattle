---
title: Disabled Staging Deployment Gate Plan
date: 2026-07-26
type: plan
status: completed-development
---

# Disabled Staging Deployment Gate Plan

## Outcome

Create a production-shaped Cloudflare staging route that can be compiled,
provisioned, migrated, deployed, and inspected without authorizing enrollment,
upload registration, ingestion, account-scoped telemetry, or aggregate
publication.

This gate does not authorize external participant data. It exists to prove the
HTTPS, Worker, D1, R2, secrets, migration, and operational boundaries before a
human approves any collection.

## Current evidence

- The Cloudflare account is authenticated through Wrangler 4.114.0.
- The credential can manage Workers and D1.
- A live R2 listing fails with Cloudflare error `10042`: R2 has not been
  enabled for the account.
- The local Worker, D1, R2 simulation, ingestion lifecycle, personal results,
  aggregate publication, deletion, retention, incident controls, and dry
  deployment are already covered by the existing product gate.

Enabling R2 may create billing or account-level terms. It is therefore an
explicit human action, not something this repository should attempt
silently.

## Implementation

1. Add a named `staging` Wrangler environment with:
   - a non-sensitive public name;
   - `workers.dev` HTTPS enabled and version preview URLs disabled;
   - enrollment and account-scoped ingest disabled;
   - environment-specific D1, deletion-ledger, R2, rate-limit, asset, cron,
     observability, and required-secret declarations;
   - placeholder resource IDs that cannot pass the strict readiness gate.
2. Add a deterministic configuration evaluator that verifies:
   - the environment cannot use development-open enrollment;
   - collection-facing modes are disabled;
   - all bindings are present exactly once and use distinct staging resources;
   - secrets are declared by name but never stored in configuration;
   - assets, API routing, scheduled lifecycle, and observability are present;
   - placeholder resource identifiers are reported without being printed.
3. Add a live readiness mode that suppresses Wrangler output and reports only
   bounded capability states for authentication, D1, R2, configured resources,
   and required secret names.
4. Add a deployment wrapper that:
   - accepts only the staging environment;
   - requires an exact confirmation phrase;
   - requires the strict live readiness gate;
   - requires both remote D1 databases to have no pending migrations;
   - requires the remote collection-control row to be fully contained;
   - deploys with Wrangler strict mode;
   - checks an explicitly supplied HTTPS origin and refuses a health response
     that exposes any collection capability.
5. Add tests with a fake Wrangler executable so no test contacts Cloudflare,
   mutates remote state, prints credentials, or depends on a developer login.
6. Run the staging dry deployment, focused tests, full product check, and
   tracked-file privacy scan.

## Release boundary

Passing this gate means “safe to deploy a contained staging service.” It does
not mean:

- R2 has been enabled;
- remote resources exist;
- migrations have been applied;
- secrets have been installed;
- staging has been deployed;
- a participant may enroll or upload;
- external review or pilot authorization has passed.

Those facts require separate live receipts. Any readiness failure leaves the
service undeployed and collection unauthorized.

## Development result

The configuration, readiness evaluator, contained migration preparer,
first-deploy secret bootstrap, strict deployment wrapper, tests, runbook, and
root commands are implemented.

The checked-in gate is `safe_unprovisioned`. The live read-only probe is
`blocked` with exactly:

- `STAGING_RESOURCE_IDENTIFIERS_NOT_CONFIGURED`; and
- `R2_NOT_ENABLED`.

Authentication and D1 reachability passed. No resource was provisioned, no
migration was applied remotely, no secret was installed remotely, and no
Worker was deployed. This is the intended stopping point until the account
owner explicitly enables R2.

The dated [verification
receipt](../receipts/2026-07-26-disabled-staging-deployment-gate-verification-receipt.md)
contains the commands, test counts, and residual release gates.
