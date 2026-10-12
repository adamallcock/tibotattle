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
- Sealed weekly aggregates are delayed, thresholded, rounded, and withheld when
  support, maturity, privacy, or quality evidence is insufficient.
- Daily activity and allowance estimates have no minimum account count or
  per-account cap. The owner-approved optional plan/model projection includes
  dollar estimates and sample counts even for one account, without identifiers
  or admin diagnostics. It uses only complete, source-authorized cached evidence and
  closed, requested, published dates; missing evidence is omitted, never fitted
  during a public request. See the [public contract](../../docs/reference/api-surface.md#public-allowance-breakdowns).
- Unknown routes and wrong methods fail closed with bounded content-free errors.
- Production admin actions exist only on the reviewed admin host behind
  Cloudflare Access.

The maintained field, storage, retention, and deletion inventory is in the
[local data and privacy reference](../../docs/reference/local-data-and-privacy.md).

## Calculation and scale boundary

When pricing changes, daily publication rebuilds stale v1/v1.1 summaries from
the same admitted source records. Repricing checkpoints one source chunk or
one generation page at a time; it preserves source selection, immutable
projection records, and delivery cursors. Incomplete or invalid evidence is
never relabeled with the new registry or published as a complete day.

Migrations 0054–0056 add a fair dirty-account queue, restartable captured-cohort
publication, and constant-size preparation counters. Unchanged current work is
a metadata check, not an account scan. New inputs coalesce per account, and a
claimed account goes to the back of the queue before work starts so interruption
or a busy contributor cannot monopolize current calculation. Each publication
selects complete authorized versions for its captured membership; ordinary
uploads queue a successor without discarding an unfinished capture or a saved
graph. Erasure, consent and source-policy changes retain the hard fence.

Run the isolated synthetic calculator qualification with `npm run test:scale`.
It exercises real local Workers/D1 evidence at 100, 500 and 1,000 contributors,
exact reference fits, cold imports, no-change and single-account updates,
historical prepared-input reuse, public reads and a busy-account scenario.
The JSON report includes physical statement counts, rows, response bytes and
local elapsed time; it contains no real participant data. It does not send
traffic to a hosted environment. The
[1,000-contributor qualification review](../../docs/reviews/2026-09-08-thousand-contributor-qualification.md)
records the workload, measurements and unqualified capacity boundaries.

The shared 900-statement budget and one-minute scheduled cadence cover the whole
invocation. Graph calculations receive a 40-second admission window starting
after required maintenance and bounded weekly publication finish; earlier
housekeeping does not consume that window. Weekly publication retains its source
and privacy fences, reserves query headroom for graph work, and reports failures
independently. A population of 1,000 is not a claim of 1,000 simultaneous imports
or 1,000 full recalculations per minute.
Historical cohort readers still cap eligible contributors at 1,024 and retain
exact-date publication guards; larger cohorts and sustained arrival rates need
separate qualification. See the [operations boundary](../../docs/runbooks/production-operations.md)
before migration or deployment. Source implementation and local scale results
do not establish production activation, latency, CPU or memory capacity.

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
in migration 0044. It requires accepted server capabilities, an explicit
hosted-session grant for the exact contract, and separate local field review
and approval. Pairing, device renewal and existing v1 consent cannot grant it.
The participant's persisted minimum write rank applies to every ingestion path,
including v0.2 if that dormant format is deliberately re-enabled.

Staged day chunks are immutable. Migration 0045 adds a complete-domain activation
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
Its current activity, allowance and model calculations admit both signed-in
and accountless contribution sources. Migration `0060` defines the exact
durable accountless owner/device/v1.1 authority chain, immediate withdrawal
fences and bounded retained-source bootstrap. It does not grant social consent
or verify a person/provider account. Upload credential expiry is independent
of retained-data eligibility. See the
[public sample decision](../../docs/decisions/2026-09-11-public-contribution-sources.md)
for source identity, overlap and activation gates. Legacy sealed weekly
snapshots keep their original transport and cohort policy.

The GCP analytics-v2 daily reader also preserves previously published spend
under one pinned historical contract: kernel 10, manifest 1, aggregate and
policy v1.0, pricing method `server-api-price-equivalent-v0.5`, and registry
`48119389ecbcaced58837bc24fa852c3c4a99835289b417e69f34fb0166a63b9`.
The block retains its original amount, versions, publication date and revision;
it is historical pricing pending a separate membership-preserving repricing
workflow. Closed fields, count conservation, coverage and cost semantics,
the payload digest, the exact registered kernel identity and the head's own
completed run are required. That run's exclusion digest must match validated
current exclusions in the same repeatable-read snapshot. Missing or conflicting
proof withholds historical spend. The strict current-price validator and its
read path are unchanged. This compatibility path does not publish, recompute,
restamp or modify any stored head, contribution, membership or exclusion.

Self-service `DELETE /api/v1/me` is retired: the unknown API response is
`404 NOT_FOUND`, without D1 access or participant mutation. `GET /api/v1/me`,
legacy personal statistics, weekly aggregate, recovery,
session upload authorization, and granular legacy contribution read/delete
routes have been retired. Hosted export, security reset, and selected-device
management remain exact Worker session surfaces but are not granted through
the loopback participant relay.

Legacy confirmed **Disconnect this Mac** uses the existing device-disconnect path;
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

The 2026-09-04 lineage reconciliation preserves the already-applied historical
`0041_community_model_composition_cache.sql` and numbers the separate model
composition and attribution migrations `0042`–`0045`. These are not aliases for
the historical migration. See the
[lineage review](../../docs/reviews/2026-09-04-hosted-migration-lineage-reconciliation.md)
before reconciling any environment with a different ledger; exact ordered-prefix
validation remains fail-closed.

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

The independent npm lockfile pins the Worker test toolchain. Vitest 4.1.11
includes the [mock-path boundary fix](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9).
The scoped `miniflare` override selects sharp 0.35.4 for its
[patched image-decoding dependencies](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c).
Retain that override until the selected Miniflare version itself requires a
patched sharp release; verify dependency scanning and the complete Worker gate
before removing it. These are development dependencies, not a deployment.

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


## GCP GitHub distribution snapshots

Production maintenance independently syncs the complete public GitHub release
inventory when its last success is more than 15 minutes old. The owner console's
audited `sync_distribution` action forces that writer with a one-minute cooldown.
The overview reads stored snapshots and makes no GitHub request. Staging never
syncs public GitHub inventory.

`src/postgres-github-distribution-history.ts` reuses the D1 inventory reader and
allowlisted release/asset bindings. It claims the two-minute singleton lease
under a row lock, releases the connection during the bounded network read, then
checks ownership and expiry before atomically publishing all rows, the manifest
and success state. Failed or incomplete inventories record only a failed attempt;
they cannot replace last-good counters. A sync failure never changes maintenance's
lifecycle result or exit code. Fetches have eight-second request timeouts and a
20-second complete-inventory deadline, including response bodies; database writes
have five-second statement and 500-ms lock timeouts.

The public inventory requires no token. The committed production desired state
therefore keeps `DISTRIBUTION_GITHUB_API_TOKEN` absent. An owner may later pin one
for rate-limit capacity; infra renders mount it on maintenance only. Neither the
origin nor analytics jobs need it. Existing primary migrations 0022 and 0075
suffice, and the analytics kernel is unchanged.

Local validation (synthetic fixtures and mocked fetch only): rebuild
`node cloud-run/build.mjs`, then run `npm --prefix cloud-run run check` and
`PG_TEST_SOCKET=<private local PG17 socket> PG_TEST_PORT=<port> node --test
--test-concurrency=1 postgres-test/postgres-github-distribution-sync.spec.mjs`.
The [candidate handoff](../../docs/plans/2026-10-11-gcp-github-distribution-sync.md)
records owner rollout steps and remaining production checks.

## GCP analytics read bounds

Analytics A-1 readers use read-only repeatable-read transactions with a fixed
3,600,000-ms per-statement timeout and a 5,000-ms lock timeout. Only the exact
`analytics_v2.read` operation in read-only mode admits the longer statement
bound; other operations and all lock timeouts retain the 600,000-ms ceiling.
Grouped source expansion never retries query cancellation or lock timeout;
other SQL failures retain the granular fallback used to preserve source-refusal order.
Shared defaults remain 10,000 ms for statements and 5,000 ms for locks.
SQLSTATE `57014` and `55P03` become the content-free fatal codes
`ANALYTICS_V2_READ_STATEMENT_TIMEOUT` and `ANALYTICS_V2_READ_LOCK_TIMEOUT`, with
only their SQLSTATE retained. Operational failures never enter the `SOURCE_*`
unread-owner publication fallback. A read-phase failure reaches no analytics
output writes. These bounds do not guarantee that a full-history query finishes.

## GCP fast-pricer validation

`npm run analytics-v2:pricer:check` compares the independently bundled pinned
oracle with the bound pricer: focused contracts plus a deterministic differential
(currently 91,122 comparisons). It includes all 6,561 null/zero/one component
masks for each provider, every catalog identity at card date boundaries ±1 ms
(and inclusive end-day transitions), context thresholds, malformed input and
10,000 seeded events. The differential prints content-free pricer counters.
The attribution tripwire shares the fast binding and cannot independently detect
pricer divergence; the separately bundled oracle differential supplies that gate.

Any change to `apps/worker/vendor/` or `packages/accounting/` requires the full
`npm run analytics-v2:pricer:fuzz -- --events=3000000 --corpus=<synthetic-corpus>`
rerun in addition to the regular gate. Use the complete synthetic corpus; private
session data must never enter this harness. Coordinate full runs with the
integrator rather than running them concurrently with profiling.

`createFastTelemetryUsagePricer().getStats()` returns an independent content-free
snapshot. `fastPathHits` counts results returned through the specialization;
`fallbackCalls` counts oracle calls, including oracle exceptions. Registry
construction exceptions occur before either counter increments. Internal oracle
calls used to compile a plan do not count as fallbacks. `planCount` includes
retained null plans, and `maxPlans` is 16,384. At saturation, uncached cells fall
back while retained cells stay usable; no eviction or input content is recorded.
Counters accumulate for that pricer instance, so refresh measurements should
subtract before/after snapshots and report fast hits divided by fast hits plus
fallbacks, with registry exceptions separately reported.

Wave 25 integration must drop PRICER-PERF's branch-local kernel entry and pin,
preserve the integration line's existing entries byte-for-byte, and derive one
combined kernel 5 after all selected changes with
`node cloud-run/build.mjs --kernel-closure`. Recompute its registry pin and run
the owning kernel and analytics gates on the merged tree. This fix branch's
focused checks do not qualify its retained branch-local kernel closure, deployment
or combined performance; those remain integrator gates.

## Client classification compatibility

The source contract accepts known `promax` plan attribution and the reviewed
`gpt-6.1-sol` identity. This intake contract does not change the public allowance
normalization or qualify installed-client uploads. The immutable catalog
`catalog/manifest-0001.json` and its public model roster stay at their original
identity; kernel11 and intake use the separately identified compiled v0.9 price
registry. No catalog successor is loaded or activated by this change.

Primary migration `0076_classification_correction_links.sql` follows the existing
`0075_github_distribution_manifest_visibility.sql` without changing its bytes.
The normal v1.1/v1.2 domain activation transaction can append an authenticated
unknown-to-known classification link for the same owner, device, occurrence and
clock. Nonclassification quantities and original typed rows stay immutable;
effective readers validate the link and its activation receipt, and replay
converges on the existing head. A differing quantity remains a conflict.

The activation proof builds the candidate set and each history format once per
activation, as `ON COMMIT DROP` temporary tables, and pages indexed pair sets;
it never rebuilds them per page. The origin's runtime role therefore needs the
database `TEMPORARY` privilege, which PostgreSQL grants by default. The v1.1
closure probes (typed v1 transition, legacy gap, previous-generation gap) are
hash anti-joins over the candidate's decoded admissions, not per-row manifest
rescans. Set builds decide v1.1 acceptance once per manifest and device, decode
each device id once, and join the device's chunks as a set. The proof raises
`work_mem` to 64MB transaction-locally and restores it before returning, so
multi-million-row histories hash in memory within the 60 s statement budget.

Client occurrence ids are positional, so a re-parsed rollout can re-emit an
event at the same instant under a new id. The effective readers union a
participant's accepted v1 and v1.1 candidates with every accepted v1.2
generation of its retained devices per observed day by occurrence id, and the
proof's other checks compare only same-id records or same-format baselines.
Before any pair work, the proof therefore refuses an activation that would
introduce a re-keyed twin of the participant's accepted history: v1 for a v1.1
activation; v1, v1.1 and other devices' v1.2 for a v1.2 activation. A twin is
a candidate record that shares stream, observed day and instant with a legacy
record whose stream and occurrence id the candidate lacks on that day and is
the same event; matches no legacy record by stream and occurrence id; and is
not already in accepted history of the activating format that the readers
read. For a v1.2 activation that history is every accepted v1.2 generation of
the activating device and of the participant's other devices in the occurrence
reader's retained authorization scope (`v12RetainedAuthorizationScopeSql` with
the `reader` variant, from `src/analytics-v2/owners.ts`, evaluated at the
activation transaction's time). The reader reads each of those generations
whole, so it includes a re-paired machine's old, revoked device. For a v1.1
activation it is the participant's accepted v1.1 set, which the legacy reader
reads for every device. The refusal uses the callers' existing 409 codes
(`TELEMETRY_MANIFEST_CONFLICT` for v1.2,
`TELEMETRY_COMPATIBILITY_PROOF_UNAVAILABLE` for v1.1).

Being the same event follows how the clients build ids. A usage id hashes the
rollout position and instant, so a usage twin keeps the dropped event's
session (compared null-safe; a usage row always has one). Nothing else of a
usage record is compared: a re-parse may change its token quantities, and a
classification correction may change its model, provider and attribution.
Production's Gate 0 check on 2026-10-11 found 2,154 usage events re-keyed
between v1.1 (parser v16) and v1.2 (parser v20) in the same session at the
same instant whose token quantities differ: the same auto-review events
re-parsed. Re-keys of the same events from v1.1 to v1.1 kept identical
quantities. Guard v4 compared quantities, so it would have taken each of those
re-parses for a distinct event and let the union count it twice. Guard v5
(owner decision 2026-10-11) therefore matches a usage twin by session and
instant alone. A quota id hashes the source position, limit and slot, so a
quota twin keeps the dropped observation's limit and slot. The working sets do
not carry limit and slot, so only the provisional quota pairs are looked up by
primary key in `typed_telemetry_quota` and `telemetry_v12_typed_quota`, whose
limit and slot ids come from the shared `typed_telemetry_dictionary`. A quota
pair is dropped only when both detail rows exist and differ. A session
record's id is its session (the raw Codex session id or, before the client
records identity, a stable stand-in), which a rewritten rollout cannot change.
The client's only session re-key is the stand-in to raw identity switch, which
keeps every event id. A session twin must therefore be linked by a usage
occurrence kept under its own id that names the dropped session in legacy and
the twin in the candidate. Sessions that only share a first-event instant are
distinct.

Usage and session legacy covers every device of the participant. A machine
re-paired under a new device id keeps its device salt, so its event and session
ids persist. Event ids are salted and a session id is the machine's own (a
random Codex session id or a salted stand-in), so a twin across device ids is
the same machine's. For a v1.2 activation that legacy also holds the usage and
session records of the participant's current v1.2 head generation (the head is
per participant) when that generation belongs to another device in the reader's
retained scope. A re-paired machine therefore cannot re-key its old device's
v1.2 history while that history is the head. Those records are the proof's
existing `source_12` working set, so this reads no further history. Older
generations are not legacy; the exemption reads them, so taking the head alone
only loses recall and never refuses what the readers would not double count.
Quota legacy stays the activating device's v1.1 history. A quota record names
no session, and two machines on one account observe the same snapshot, so
another device's observation at the same instant, limit and slot is no evidence
of the same observation.

These pass: a legacy record absent with no same-instant candidate record (the
union keeps its legacy copy); a same-instant sibling kept under its own id (as
does a re-keyed copy kept beside its original id, which has the same shape); a
different event at a dropped record's instant (another session, another limit
or slot, or an unlinked session); and a twin already in accepted history the
readers read, which adds no new occurrence. Neither a device that production's
earlier proof let through nor its machine re-paired under a new device id is
wedged. The guard prevents a new double count; it does not reconcile an
existing one.

One known false positive is accepted (ADV3-5). Two distinct events of one
session at one instant (a tie group) cannot be told from a re-key. A candidate
that drops one of them and newly holds the other therefore refuses, whatever
their token quantities, although the union would count each event once, and
that day then stays refused (below). The owner accepted this on 2026-10-11.
Production showed no instance, and the quantity rule that told such events
apart let the Gate 0 re-parses double count.

These re-keys pass undetected. A rollout rewrite in the same upload as the
identity switch also renames the re-keyed events' session, so neither the usage
nor the session rule links it. A re-paired machine's quota re-key passes,
because quota legacy is device-scoped. A re-paired machine's re-key of its old
device's v1.2 history passes once that history is no longer the head, for
example after the new device's first activation. A v1.1 activation reads only
v1 legacy, so a v1.1 re-key across device ids passes. v1 quota is excluded: the
clients' v1.1 and v1.2 records keep the v1 usage `eventId` and session
`sessionUuid` but replace the v1 quota id `q:<ms>:<limit>:<slot>` with a
`quota-occurrence:v1:` id by design, which admission maps only through
`typed_v11_record_admissions.legacy_occurrence_id`. The analytics-v2 candidate
selection does not apply that map, so a day holding accepted v1 and v1.1 copies
of one quota observation selects two quota candidates, as does a device moving
from v1 straight to v1.2 for its v1 days. That reader property predates this
guard. Refusing it here would refuse every such day for good, because the client
always emits the successor id, so the fix belongs in the reader's selection.
Pinned predecessor days are each day's earliest READY manifest, accepted or
not, so they are no accepted baseline: a refused re-key stays pinned, and
because the same-day closure keeps its occurrences in every successor, that day
stays refused. Twins are exact so that this permanence applies only to real
double counts, except for the accepted tie-group false positive above.

The working sets have no indexes, so the statements over them run with
`enable_nestloop` off transaction-locally and restored before returning, as
`work_mem` is. These are the provisional twin statement (the kept anti-join,
the same-instant-and-session join and the legacy-id anti-join, materializing
pairs in a temporary table), the session link join and the v1.1 history probe.
With nested loops allowed, the earlier single-statement v1-only form planned a
nested-loop semi-join that rescans the candidate per unmatched legacy row and
exceeded the 60 s statement budget with synthetic 2.75M candidate and 1M v1
rows. The quota detail lookup and the v1.2 history probe run only for pairs
that remain, under the planner default. The lookup joins the quota pairs to the
detail tables' primary keys. v1.1 anti-joins the accepted v1.1 set. v1.2
first keys the accepted manifests of the twins' days (of this device and the
other retained devices) in a temporary table, then runs anti-joins whose
correlation sits only in their `WHERE` clauses. PostgreSQL therefore plans them
as anti-joins, never as a subplan that rescans the accepted set per twin. Usage
and quota twins are found through the
`(observed_day, stream, observed_at_ms, occurrence_id)` index, because their
ids encode the instant. Session twins, whose first-event instant can move, are
found through the `(manifest_id, stream, occurrence_id)` unique key of each
accepted manifest of their day.

Guard v4 was measured locally on 2026-10-11 with synthetic sets of 2.75M
candidate, 2.33M v1.1 and 1M v1 rows, plus 5M other owners' rows in each detail
table. Its twin statement took about 2.4 s for v1.2 (3.2 s with 270,000
re-keyed records, 5.8 s with 1.08M) and 0.8 s for v1.1. With a further 2.75M
head records of another retained device, it took 3.3 s when that device was the
same machine (its ids kept) and 5.8 s when it was another machine at the same
instants (2M dropped rows). Guard v5's twin statement is v4's without the
per-record usage legacy id and format columns, and v5 has no usage lookup (v4's
took at most 0.31 s at up to 1.45M pairs). The two twin statements were timed
on identical temporary working sets of 2.75M candidate, 2.33M v1.1 and 1M v1
rows (local, 2026-10-11, two runs each, while another checkout's tests ran).
v5's took 1.5 to 2.0 s without twins (v4: 1.9 s), 3.0 to 3.7 s with 270,000
(v4: 3.1 s, and one 8.8 s outlier) and 4.2 s with 1.08M (v4: 4.2 to 4.3 s).
With 2.75M head records of another retained device it took 2.2 to 2.3 s for the
same machine (v4: 2.3 to 2.4 s) and 5.8 to 6.6 s for another machine at the
same instants (v4: 6.1 s). The exactness filters and the probe together took
10 to 25 ms for about 2,400 twins, 1.6 s for 270,000 twins with accepted
history and 2.9 s for 1.08M (measured with v4, whose usage lookup ran first).
At those sizes the probe makes one hashed pass over the records table. The probe statement is
unchanged from guard v3, which measured it in a shape of 363,000 twins over 300
days, with 30 accepted manifests per day across 600 generations, at 0.3 to
0.5 s; the correlated-subplan form took 26 s to more than 60 s there. A set
join with the accepted manifests in a CTE hit the 60 s budget at 270,000
twins: it rescanned the twins once per accepted manifest. The retained-device
query reads only the authorization tables and was not measured at scale.

The proof lives in `src/postgres-classification-activation.ts`, outside the
analytics kernel's compute closure; the overlay readers and link predicate stay
in `src/postgres-classification-links.ts`, which is inside it. A proof-only
change therefore needs no new kernel entry, while any edit to the links module
does.

The PostgreSQL synthetic gate is `node --test
postgres-test/classification-correction.spec.mjs` with an owned local
`PG_TEST_SOCKET`/`PG_TEST_PORT`. It checks correction atomicity, variants,
whole-session provider closure, replay and the populated migration75-to76
receipt fence. It also compares the bounded proof and the v1.1 closures with the
frozen edca848 oracles in `postgres-test/fixtures/classification/` and bounds
their plans. The re-key cases show the frozen proof accepting each re-key that
the live proof refuses, with nothing written: usage in its session (including
a re-parse with other token quantities, the Gate 0 shape, and a re-paired
machine's re-key of its old device's v1.1 history and of its old device's v1.2
head), a tie-group event re-keyed beside a distinct one, a distinct tie-group
event replacing a dropped one (the accepted false positive), quota with its
limit and slot, a session identity switch, and a new twin beside an accepted
one with its retry with the refused day pinned. The two agree when ids are
preserved (also across device ids), a record is absent without a twin, a
different event shares a dropped record's instant (another session on this or
another device, another limit or slot, an unlinked session), a
v1 quota observation takes its v1.1 id, a same-instant sibling keeps its id, or
the twin is already in accepted v1.2 or v1.1 history the readers read. That
history is the activating device's or, for a re-paired machine, its old
device's, including a revoked device's v1.2 generation that is no longer the
head; it is reproduced through domains running the frozen proof. Every history
probe is planned without a correlated subplan and without the twin set on the
inner side of a nested loop.
`scripts/classification-activation-scale-bench.mjs` reports
local, aggregate-only statement timings at synthetic scale; it is evidence, not
a gate. Migration, image rollout and installed-client acceptance remain separate
operational gates. GCP performance admission stays retired.
