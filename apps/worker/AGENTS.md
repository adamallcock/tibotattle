# Hosted Worker guidance

Scope: all files under `apps/worker/`. Apply the repository root guidance first.

## Runtime and ownership

- The Worker is an optional hosted contribution service; local TiboTattle must
  remain fully useful without it.
- Run Worker commands from `apps/worker/` or through the root `npm --prefix`
  scripts so Wrangler resolves `wrangler.jsonc`, migrations, assets, and the
  independent npm lockfile correctly.
- The Worker consumes reviewed file-installed copies of workspace packages.
  Keep those copies and lockfile metadata synchronized through the existing
  guards; do not deep-import root `src/` or another app.
- D1 and R2 are distinct persistence contracts. Preserve pseudonymity, account
  scoping, consent/version state, deletion, retention, replay safety, and bounded
  aggregation across every route and queue.

## API and data principles

- Define route method, auth class, schema, size limits, rate limits, replay
  behavior, and safe error shape at the request boundary. Enforce route metadata
  in the live dispatch path, not only in documentation or inventory tests.
- Authenticate before revealing account-scoped state. Use constant, content-free
  not-found/denied behavior where response differences could enumerate users,
  grants, devices, or contributions.
- Validate closed telemetry envelopes before persistence. Never log payload
  bodies, OAuth artifacts, raw identities, tokens, or durable secrets.
- Use transactions or explicit journals for multi-step state changes. Retries,
  queue delivery, and duplicate client submissions must converge without double
  application.
- Migrations are forward-only, reviewable, and locally rehearsed. Deploying code
  does not apply D1 migrations, and applying a migration does not deploy code.
- Admin, incident, load, collection-control, and deletion pathways are privileged
  operational surfaces. Keep them fail-closed, auditable, and separate from
  ordinary participant capability.

## Environment and authorization

- Default to local Miniflare/Vitest and dry-run Wrangler flows. Treat staging
  configuration checks, staging writes, production deploys, remote migrations,
  D1 writes, R2 writes, key rotation, grants, live smoke tests, and load tests as
  separate gates.
- Production and staging resources belong to the maintainer. Do not create,
  mutate, deploy, migrate, seed, delete, rotate, or contain them without explicit
  authorization for the exact environment and operation.
- Read-only remote inspection still handles sensitive operational state: minimize
  output, avoid payload rows, and report whether the result is live or local.
- Keep `.dev.vars`, OAuth credentials, signing keys, account identifiers, and
  generated secrets untracked and out of output.

## Validation

- Install Worker dependencies with `npm --prefix apps/worker ci` from the root or
  `npm ci` in this directory. Do not replace its npm lockfile with root pnpm state.
- Run the narrow Vitest or script check while iterating.
- Run `npm run product:worker:check` for a complete Worker change. It includes
  workspace-copy guards, endpoint checks, generated types, TypeScript, script
  tests, Vitest, and dry deployment checks.
- Use the disposable local backend laboratory for HTTP acceptance, queue,
  account-scoped, or incident behavior. Do not aim smoke or load tools at the
  live service without explicit authorization.
- For schema-dependent changes, validate both pre-migration refusal and
  post-migration behavior locally; report deployment and migration readiness as
  separate outcomes.
