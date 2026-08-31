# Hosted Worker

This Cloudflare Worker is TiboTattle's only current hosted product runtime. It
serves the public website and optional contribution service at
`https://tibotattle.com`, the Access-protected operator surface at
`https://admin.tibotattle.com`, and the guarded Sparkle feed integration for
`https://updates.tibotattle.com`.

Local TiboTattle remains fully useful without this service. Contribution is off
by default and requires a reviewed local payload, explicit first send, and a
valid pseudonymous account/device capability. Source configuration, a local
test, a deployment, a migration, and a live health observation are separate
gates; see the [current status matrix](../../docs/current-status.md) for the
latest verified external state.

## Runtime architecture

- `src/index.ts` is the request, queue, and scheduled-event composition root.
- `src/route-registry.ts` is the closed HTTP path inventory.
- D1 stores pseudonymous participants, consent/version state, accepted
  contribution metadata, deletion state, aggregates, audit receipts, and
  operational control state.
- R2 stores bounded encrypted/quarantined contribution objects and signed-update
  publication objects under separate lifecycle contracts.
- `ContributionCoordinator` is the Durable Object used for contribution
  coordination; it is not a substitute for D1 durability.
- Static assets under `apps/web/public` provide the acquisition, documentation,
  privacy, download, and delayed community surfaces.
- Production endpoints and update-bucket identity come from
  [`config/deployment-endpoints.js`](../../config/deployment-endpoints.js) and
  are checked against `wrangler.jsonc`.

## Privacy and authorization invariants

- Uploads accept only closed, versioned, content-free telemetry envelopes.
- Prompts, responses, commands, paths, URLs, credentials, names, emails, and raw
  provider account identifiers are rejected rather than redacted after upload.
- Google and Apple sign-in establish a one-person boundary. The service stores
  an irreversible identity hash, not the provider name or email.
- Browser sessions, upload authorizations, device credentials, CSRF values, and
  OAuth handoffs are distinct short-lived capabilities.
- Account-scoped reads authenticate before revealing whether data exists.
- Contribution ingestion, device operations, protected session operations, and
  private owner participant erasure remain replay-safe and auditable.
- Public aggregates are delayed, thresholded, rounded, and withheld when
  support, maturity, privacy, or quality evidence is insufficient.
- Unknown routes and wrong methods fail closed with bounded content-free errors.
- Production admin actions exist only on the reviewed admin host behind
  Cloudflare Access.

The maintained field, storage, retention, and deletion inventory is in the
[local data and privacy reference](../../docs/reference/local-data-and-privacy.md).

## Install and local development

The Worker owns an independent npm lockfile. Run commands from this directory
or through the root `npm --prefix apps/worker` scripts so Wrangler finds the
correct configuration and migrations.

```bash
npm ci
npm run keys:local
npm run dev
```

`keys:local` creates ignored development-only values. Never reuse them for a
remote environment or commit `.dev.vars`.

For the disposable local Worker/D1/R2 laboratory from the repository root:

```bash
npm run product:backend:acceptance
```

The lab automatically provisions separate synthetic owners for its lifecycle
and retained-state runs, generates isolated envelope keys, and passes the
appropriate `--owner-access-file` to each smoke child. It does not require the
workspace `.dev.vars` or promote ordinary participants. Generated-fixture
receipts identify separate owner and participant access files; both contain
secrets and must stay owner-only. Direct network harnesses require a supplied
owner file; offline load profiling does not. Follow the
[local HTTP procedure](../../docs/runbooks/production-operations.md#disposable-local-http-acceptance)
for standalone setup, flags, and the development-only authorization boundary.

Use `npm run product:backend:lab` when you intentionally want the verified
local state and portals to remain open. It starts the loopback companion at
`http://127.0.0.1:8791` and the backend-only Worker at
`http://127.0.0.1:8792`. Use `npm run product:backend:only` for backend-only
inspection. The default companion still uses real local sources and production
credential seams; it is not a no-real-account browser fixture. See the
[local companion boundary](../local/README.md#test). These local results do not
prove staging or production.

## HTTP surface

The exact method, caller, authority, request/response contract, storage effect,
and lifecycle owner for every route live in the source-checked
[API surface reference](../../docs/reference/api-surface.md).
This README summarizes the authority and lifecycle boundaries instead of
duplicating a route list; `src/route-registry.ts` remains the executable path
authority.

### Public, readiness, and release

The complete route registry, method map, authority classes, aliases, query
bounds, runtime bindings, and identity/device/upload sequence are documented in
the maintained
[TiboTattle API surface reference](../../docs/reference/api-surface.md).
That reference is checked directly against `src/route-registry.ts`, so newer
identity, admin, device-sync, daily-community, credential-renewal, and appcast
guard routes cannot disappear behind a stale partial list here.

Session endpoints accept only a short-lived D1-backed web session delivered as
a Secure, HttpOnly, SameSite=Strict `__Host-` cookie. Session-authenticated
mutations also require the exact same origin and a session-bound CSRF value.
No reusable personal credential is placed in browser storage or returned as an
access token.

Contribution upload is a separate authority class. The current collector uses
its locally held device bearer to mint one exact digest-, byte-, content-type-,
and principal-bound Upload authorization. That five-minute authority is
hash-only in D1 and can be used once for the exact encrypted body. The upload
request omits the personal cookie; session-backed upload-authority minting has
been retired, and neither authority substitutes for the other.

An enrolled participant can create a short-lived, one-use pairing code. The
collector generates its device UUID and 32-byte secret locally, stores the
secret in the app-owned macOS Keychain item, and sends only a domain-separated
credential hash while claiming the pairing. Device authority can synchronize,
renew or disconnect itself, and mint Upload authority; it cannot read session
controls, export data, manage other devices, or delete hosted participation.

The account/plan-attributed v1.1 successor is implemented but starts **staged**
in migration 0043. It requires accepted server capabilities, an explicit
hosted-session grant for the exact contract, and separate local field review
and approval. Pairing, device renewal and existing v1 consent cannot grant it.
The participant's persisted minimum write rank applies to every ingestion path,
including v0.2 if that dormant format is deliberately re-enabled.

Staged day chunks are immutable. Migration 0044 adds a complete-domain activation
boundary with exact legacy/successor occurrence compatibility proof, rather than
a per-day schema switch. Partial delivery leaves the old analytical source
selected; same-vector retries do not republish. Quota, usage, daily and model
consumers share source pins and existing publication/cache fences. Account
attribution remains conditional where quantity intervals cannot be proven.
Participants with accepted v0.2 history cannot raise their floor to v1.1 or
activate a successor, even on disjoint dates, until a semantic replacement
adapter is proven. Their existing analytical source remains selected.
Applying these migrations, enabling lifecycle acceptance or uploading real data
requires separate owner authorization and rehearsal; source tests are not a
production cutover receipt.

The current public product series is `GET /api/v1/community/daily`.
Self-service `DELETE /api/v1/me` is retired: the unknown API response is
`404 NOT_FOUND`, without D1 access or participant mutation. `GET /api/v1/me`,
legacy personal statistics, weekly aggregate, recovery,
session upload authorization, and granular legacy contribution read/delete
routes have been retired. Hosted export, security reset, and selected-device
management remain exact Worker session surfaces but are not granted through
the loopback participant relay.

Confirmed **Disconnect this Mac** uses the existing device-disconnect path;
it preserves hosted and local history. Private owner erasure instead uses
`POST /api/v1/admin/action` with `action: "run_maintenance"` and an explicit
`participantErasure` object containing the exact `participant:<UUID>` target
and `confirmation: "erase_hosted_participant"`. Cloudflare Access owner-pinning
and admin CSRF remain required. Omitting that object means ordinary maintenance
only; there is no new route or action enum. Follow the
[owner procedure](../../docs/runbooks/production-operations.md#private-owner-participant-erasure)
for response, audit, retry, and safe-pipeline requirements.

The same owner maintenance boundary also accepts a closed `transportRollback`
operation with the exact participant, expected floor revision, old/new rank and
`confirmation: "lower_transport_admission_preserving_analytical_source"`.
It records a purpose-separated participant digest in the audit and changes only
future upload admission. It never unpins an active v1.1 domain, erases consent
history or restores deleted records. Stale/replayed revisions fail closed.

Health advertises `participantDeletion: false` separately from
`deletionSafeRestoreReplay: true`. Retirement does not change retention,
migrations, or existing tombstones. This is the
[2026-08-30 source contract](../../docs/decisions/2026-08-30-self-service-deletion-retirement.md),
not evidence of deployment or a newly released app.

Contributions are encrypted with a fresh AES-GCM key and the data key is
wrapped with the published RSA-OAEP-256 key. Only the opaque envelope is held
in R2 quarantine; validated closed metadata is stored in D1. Uploaded API-cost
values remain `client_declared_unverified` diagnostics, while canonical cost is
recalculated from validated token metadata with price/method provenance.

Historical migrations and legacy D1 columns are deliberately retained after
route retirement. Any future schema removal must first pass the owner-run,
read-only checks in the
[hosted API retirement data-gate runbook](../../docs/runbooks/2026-08-27-hosted-api-retirement-data-gates.md)
and use a separately authorized forward migration. Source tests do not establish
the live row counts or deployed Worker revision.

## Migrations and storage

Forward-only D1 migrations are under `migrations/` and are applied in numeric
order. Never document a hard-coded migration ceiling as the operating contract;
the checked-in directory is the current set.

Deploying Worker code does not apply D1 migrations. Applying D1 migrations does
not deploy code. For schema-dependent changes, locally prove both pre-migration
refusal and post-migration behavior, then follow the
[production operations runbook](../../docs/runbooks/production-operations.md).

R2 update publication, contribution quarantine/reconciliation, D1 mutation,
collection controls, enrollment grants, key rotation, and remote migration are
independent protected operations. Do not treat a successful read or dry run as
authorization for a write.

## Environment boundaries

- **Local:** Miniflare/Vitest and disposable local D1/R2. Safe default.
- **Staging:** intentionally disabled-first and separately provisioned. Config
  validation does not prove a deployed staging service.
- **Production:** custom public/admin domains, D1, R2, Durable Object, OAuth, and
  Access bindings declared in `wrangler.jsonc`. All writes and deployments are
  maintainer-authorized operations.

Run `wrangler` from `apps/worker`; the repository root has no Worker
configuration. A remote migration result is not deployment evidence. A deploy
receipt is not live-route, queue, scheduled-maintenance, or public-site proof.

## Protected operations

The following require explicit authorization for the exact environment and
target:

- staging or production deployment;
- remote D1 migrations or any remote D1 write;
- R2 object publication, deletion, or reconciliation;
- private participant erasure through the owner maintenance boundary;
- OAuth/Access/key/secret changes;
- enrollment grants, collection controls, or incident containment;
- live smoke/load tests; and
- public website or updater publication.

Use the reviewed scripts rather than direct ad-hoc Wrangler commands. Capture
the source commit, environment, migration state, staged asset digest, deployment
receipt, and bounded post-deploy observations as separate evidence.

## Validation

Focused iteration:

```bash
npm test
npm run typecheck
npm run deployment:endpoints:check
```

Complete Worker gate from the repository root:

```bash
npm run product:worker:check
```

That gate checks guarded workspace-package copies, endpoint parity, generated
types, TypeScript, operational scripts, Vitest, production asset staging, dry
deployment, and disabled-staging configuration. It does not deploy, migrate,
write remote state, or prove the live service.

Run the source-derived documentation gate after changing routes, bindings,
storage, commands, or this README:

```bash
npm run docs:check
```
