# Contained Cloud Run guidance

Scope: all files under `apps/cloud-run/`. Apply the repository root guidance
first.

## Experimental boundary

- This is an experimental contained deployment unit and object-store adapter,
  not a second production ingestion service. Keep collection disabled and refuse
  every participant `/api/*` route.
- Do not route users, exports, contribution clients, or production traffic here.
  Liveness and private dependency readiness do not establish participant,
  metadata-store, aggregation, deletion, or production readiness.
- Keep the service non-root, privately invokable, single-purpose, and independent
  of the local product and Worker implementation. Do not import another app or
  create a parallel telemetry contract.
- The in-memory adapter is local-test only. Non-local environments require the
  private object-store mode and fail closed on missing or inconsistent settings.

## Storage and IAM

- Object writes, reads, and deletion use generation preconditions so retry and
  concurrency cannot overwrite or delete a different generation.
- Preserve bounded request draining on termination and explicit `/healthz` versus
  `/readyz` semantics. Readiness must expose missing dependencies honestly.
- Use an attached single-purpose service account and a private bucket with the
  narrow reviewed role. Never add public principals, broad project roles, or a
  downloaded service-account key.
- Local IAM verification sees only directly attached policy. It cannot prove the
  absence of inherited access through an organization, folder, group, or
  principal set; keep that gate explicit.
- Render deployment configuration only to the fixed ignored output, with an
  immutable image digest and exact service account/bucket values. Do not accept
  tags, overwrite an existing render, or commit environment-specific output.

## Authorization and validation

- Google Cloud project creation, API enablement, bucket or service-account
  creation, image push, IAM mutation, service deployment, and object mutation are
  protected external operations requiring explicit authorization.
- A `gcloud` dry run and live read-only IAM verification still contact the selected
  project and require an exact environment. Do not run them as routine local tests.
- Install this app with its independent npm lockfile using
  `npm --prefix apps/cloud-run ci`; it requires Node.js 24 or newer.
- Run focused `apps/cloud-run/test/*.test.js` files while iterating, then
  `npm run product:cloud-run:check` for the complete local/configuration gate.
- Container build/run can validate the local contract but needs separate Docker
  and network prerequisites. It is not deployment, IAM, or production evidence.
