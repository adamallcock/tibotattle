---
title: Production service operations
date: 2026-08-27
type: runbook
status: operational
---

# Production service operations

This is the current service-operations runbook for the Cloudflare Worker behind
`tibotattle.com` and `admin.tibotattle.com`. It covers observation, deployment,
schema gates, private owner erasure, incident containment, and recovery. It does
not authorize credentials, remote writes, migrations, releases, or updater
publication; those remain explicit owner operations.

The Sparkle artifact/publication sequence is separate and remains governed by
the [macOS stable release runbook](./macos-stable-release-runbook.md).

## Production topology

| Surface | Authority and boundary |
|---|---|
| Public and `www` hosts | One production Worker and manifest-verified static release-site assets |
| Admin host | Same Worker, but admin routes exist only on `admin.tibotattle.com`, behind Cloudflare Access and a Worker-side owner check |
| Primary durable state | `USAGE_MONITOR_DB` D1 binding; checked-in migrations through `0045_attribution_domain_activation.sql`; this is a source inventory, not proof of remote application |
| Deletion ledger | Separate `DELETION_LEDGER` D1 binding and migration ledger |
| Encrypted/quarantined objects | Production `QUARANTINE` R2 binding with explicit deletion/reconciliation and deletion-safe restore rules; automatic age-based deletion is disabled in this source snapshot |
| Upload admission | `UPLOAD_INGRESS_BUDGET` Durable Object plus explicit rate-limit bindings |
| Updates | Separate `SPARKLE_RELEASES` R2 binding and `updates.tibotattle.com`; the owner-only atomic guard is the only appcast writer |
| Scheduled work | Production cron each minute; code must keep work replay-safe and bounded |

The exact binding names, routes, required secret names, controls, and limits live
in `apps/worker/wrangler.jsonc`; [api-surface.md](../reference/api-surface.md)
owns the route inventory.

## Read-only observation

Start without credentials or mutations:

1. Confirm the exact checkout and clean/dirty state. Record `git rev-parse HEAD`.
2. Read `https://tibotattle.com/api/health` and record its deployment source
   commit, collection-control state, storage checks, and contribution contracts.
3. Check the affected public route directly. Health alone is not route proof.
4. For admin-only symptoms, confirm the request is on the admin hostname and
   distinguish Access refusal, Worker owner refusal, missing optional analytics,
   and application errors. Never move admin routes onto the public host.
5. For updater symptoms, inspect the public appcast and immutable enclosure
   separately; do not infer updater state from Worker health.

Do not log credentials, cookies, Access assertions, raw participant identifiers,
private payloads, or session content in an incident note.

## Local validation before an owner deploy

From the repository root, with the pinned root and Worker dependencies already
installed:

```bash
npm run docs:check
npm run test:preflight
npm run product:worker:check
npm run architecture:check
```

From `apps/worker`, the maintained aggregate gate is `npm run check`. The
production dry bundle is `npm run production:deploy:dry`; it does not mutate
production and does not authorize a later deploy. Resolve every unexplained
failure before proceeding.

The production deploy wrapper itself rechecks endpoint configuration, workspace
package copies, generated assets, release preflight, source cleanliness,
dependency-tree integrity, public surface, pre-deploy health, post-deploy health,
and exact source identity. Do not replace it with raw `wrangler deploy`.

### Disposable local HTTP acceptance

`pnpm run product:backend:acceptance` from the repository root creates fresh
local D1/R2 state, separate synthetic owners for lifecycle and retained-state
runs, and isolated envelope keys. It starts Wrangler with generated local
configuration and `owner.env`, and supplies `--owner-access-file` to its smoke
child. No workspace `.dev.vars` is required; ordinary participants are never
promoted. This remains a local test, not production Access or deployment proof.
The synthetic-only fixture serves `apps/web/public` directly under `--local`;
no production asset staging or clean/committed release tree is required. This
exception does not change production/staging asset paths, guarded wrappers,
or release requirements.

Direct network commands from `apps/worker` — `smoke:http`,
`smoke:account-scoped:http`, `smoke:queue:http`, `smoke:incident:http`, and
`load:http` — require a caller-supplied `--owner-access-file`. They validate its
dedicated owner session and existing admin overview authorization before
participant enrollment, ingestion, or incident-control writes. Missing owner
access is a configuration failure (`LOCAL_OWNER_ACCESS_REQUIRED`), never
successful cleanup. `npm run load:profile` / `--profile-only` remains offline
and requires no owner file.

For standalone setup, migrate fresh owner-only state with
`npm run migrate:local -- --persist-to /absolute/private-lab/state`, then use
the [local owner fixture generator](../../apps/worker/scripts/local-owner-fixture.mjs)
with `--origin http://127.0.0.1:8792`,
`--persist-to /absolute/private-lab/state`, and
`--directory /absolute/private-lab/owner-fixture`. It refuses nonempty
participant state or an existing fixture directory and emits only file paths.
Start local Wrangler with `--local --env ''`, the returned `--config` and
`--env-file` paths, `--ip 127.0.0.1 --port 8792`, and the same `--persist-to`.
The generated configuration is `local_open`; account-scoped smoke also needs
`--var ACCOUNT_SCOPED_INGEST_MODE:local_preview`.

With that dedicated local-open fixture running, these command templates show
the required owner file (replace the absolute placeholder with its actual path):

```bash
npm run smoke:http -- --origin http://127.0.0.1:8792 \
  --owner-access-file /absolute/private-lab/owner-fixture/owner-access.json \
  --generated-content-free-fixture
npm run load:http -- --origin http://127.0.0.1:8792 \
  --owner-access-file /absolute/private-lab/owner-fixture/owner-access.json
```

Keep each tool's existing source, mode, and invitation requirements. The
standard full lab instead uses `invite_only` and issues its own cohort grants;
its redeemed invitation files cannot authorize another cohort.

Owner access uses the closed `local-backend-owner-access-v0.1` file: an
unexpired owner-only regular file bound to the exact loopback origin, distinct
from `participantAccessFile`. The development seam uses the dedicated owner's
cookie and session-bound CSRF with `ADMIN_IDENTITY_LINK_KEY`; it does not bypass
production Cloudflare Access. Keep credentials out of output, shell arguments,
and receipts. Generated-fixture lab receipt v0.4 reports `ownerAccessFile` and
`ownerAccessFileContainsSecret: true`; prepared-file receipts omit private paths.
Require `ownerErasureLifecycle` / `ownerErasureVerified` evidence, not a retired
`DELETE` response treated as deletion. The default lab companion is not an
isolated browser fixture; use backend-only mode unless the
[local source and credential boundaries](../../apps/local/README.md#test)
have been separately isolated.

## Schema migration gate

Production has two independent D1 migration ledgers. The deployment wrapper
performs read-only ledger inspection and fails closed on missing, malformed,
nonsequential, divergent, or unknown state.

- A normal deploy with no unapplied migrations needs no migration token.
- If migrations are pending, the wrapper reports exact
  `BINDING:filename.sql` tokens and refuses to continue unless the owner names
  exactly that set with `--confirm-migrations`.
- The deploy wrapper **does not apply migrations**. Applying remote migrations
  is a separate reviewed owner write, with backup/rollback analysis and an
  observed post-migration check before code that depends on it is deployed.
- A confirmation when nothing is pending also fails; this protects against an
  operator model that disagrees with production.

The underlying policy and failure modes are retained in
[the production migration gate](../governance/2026-08-07-production-deploy-migration-gate.md).

The [2026-09-04 lineage review](../reviews/2026-09-04-hosted-migration-lineage-reconciliation.md)
records why the source preserves the historical
`0041_community_model_composition_cache.sql` and moves the separate, unapplied
model-composition and attribution sequence to `0042`–`0045`. The historical
`0041` and the former `0041_community_model_composition.sql` have different SQL
and are not aliases. Do not edit an applied ledger, ignore an unknown name, or
apply this sequence to an alternative history. Stop and review that exact
environment before proceeding; the ordered-prefix guard remains unchanged.

## Owner deployment

### Attribution successor cutover and rollback

The account/plan changes separate analytical correction from new consented
transport. `0043` fences legacy analytical inputs/caches and publication;
`0044` adds explicit consent, enrollment namespaces, admission floors and
immutable staged day transport; `0045` adds complete-domain activation. Local
schema 11 is not renamed, downgraded or wiped. Applying migrations or enabling
the staged v1.1 format remains a separately authorized production operation.

The release rehearsal and staging readiness probe check both the exact migration
inventory and the attribution tables, columns, indexes, integrity triggers and
source-selection views. A complete ledger with missing schema guards fails the
readiness check. These schema-only probes do not transmit contribution content
and do not authorize migration application or format activation.

Before cutover, run the synthetic transport, domain, re-pair, erasure, source-pin
and public publication tests. Verify the actual pending migration set, owner
rollback authority, backup/deletion-ledger posture and consent UI. Code or a
successful development upload does not prove any existing person has consented.
New consent requires the exact schema/dictionary/privacy triple, explicit
ongoing-upload intent and hosted personal-session CSRF. Capability reads and
device credentials cannot grant it. Existing v1 uploads remain valid until
that participant explicitly raises its minimum write rank.

Check for accepted v0.2 history before offering an upgrade. Such participants
have an effectively blocked v1.1 capability; both consent and activation refuse
the transition, including disjoint-day candidates. This prevents loss of an
otherwise valid legacy fit. Do not delete old contributions or bypass the floor
guard to force cutover; a reviewed semantic replacement adapter is required.

Activation requires a contiguous full-domain manifest, a current predecessor
token/fingerprint, ready chunks and exact semantic predecessor coverage. Its
limit is 4,096 days and 30,000 chunks; over-limit or unproven replacement stays
staged without discarding history. An unchanged vector acknowledges the actual
active generation without republishing; a source correction forces revalidation.
Read back the selected generation and public readiness independently. Never
infer complete cutover from successful chunk delivery alone.

For an explicitly authorized write-floor rollback, use the existing
`POST /api/v1/admin/action` with `action: "run_maintenance"` and one closed
`transportRollback` object containing `participantId`, `expectedRevision`,
`fromRank`, `toRank` and
`confirmation: "lower_transport_admission_preserving_analytical_source"`.
The exact target and current revision must be inspected first. The Access owner
and admin CSRF gates still apply. The result reports the new write floor,
policy revision and `activeAnalyticalSourcePreserved: true`; the audit stores
a purpose-separated participant digest, not the raw target. A stale revision
is a conflict, never permission to retry with an invented one. Lowering a floor
does not unpin the active analytical history, delete consent, reactivate erased
data or authorize a different cross-format join.

### Guarded deployment wrapper

Only after explicit authorization and green preflight, use the wrapper from
`apps/worker`:

```bash
npm run production:deploy -- --confirm DEPLOY_PRODUCTION
```

If and only if the wrapper reports a reviewed pending set and the separate
migration operation has been handled, append its exact comma-separated tokens:

```bash
npm run production:deploy -- --confirm DEPLOY_PRODUCTION \
  --confirm-migrations BINDING:0000_name.sql
```

Capture the structured result. Success means the wrapper observed its named
pre/post conditions; it is not a release, appcast publication, identity-flow,
participant-deletion, or admin-UI end-to-end receipt. Compare the health
`deployment.sourceCommit` with the intended commit and probe the affected route.

## Private owner participant erasure

The [2026-08-30 retirement decision](../decisions/2026-08-30-self-service-deletion-retirement.md)
retires self-service `DELETE /api/v1/me` as `404 NOT_FOUND`, without participant
mutation or D1 access; individual-contribution deletion stays retired. Health
declares `participantDeletion: false` and `deletionSafeRestoreReplay: true`.
These are source contracts, not a claim that production has changed. Old installed apps
may still offer the former control; refusal must never be reported as erasure.

This is a destructive, private owner operation, never routine support cleanup:

1. Obtain explicit authorization for the exact environment and participant.
   Resolve the exact opaque `participant:<UUID>` through private, verified
   records; do not guess a target or put identifiers/request evidence in public
   issues.
   Verify the deployed revision supports this procedure. Before a retirement
   cutover, record aggregate counts of active/deleting participants and retained
   tombstones, and a completion path for every interrupted deletion.
2. Authenticate on the configured admin host through Cloudflare Access with the
   pinned owner identity, independently of the affected participant's session.
   Confirm primary D1, the independent deletion ledger, R2, and pinned identity
   configuration are available. Never bypass Access or use the participant relay.
3. Send `POST /api/v1/admin/action` from the exact admin origin with JSON content
   type and `x-usage-monitor-admin: 1`. The body is closed and explicitly targeted:

   ```json
   {
     "action": "run_maintenance",
     "participantErasure": {
       "participantId": "participant:00000000-0000-4000-8000-000000000000",
       "confirmation": "erase_hosted_participant"
     }
   }
   ```

   The participant identifier above is synthetic, not a target. Keep the real
   body out of shell history, logs, and receipts.
   `{ "action": "run_maintenance" }` without
   `participantErasure` performs ordinary maintenance only; it must never start
   a participant erasure.
4. Require `schemaVersion: "admin-action-v0.1"`, `action: "run_maintenance"`,
   and `result` with `task: "participant_erasure"`, `operationId` (UUID),
   `deleted: true`, `alreadyDeleted: false`, and numeric `contributionsDeleted`.
   An ordinary maintenance result, timeout, or error is not completion. Record
   only the operation reference and bounded outcome. The existing
   `run_maintenance` audit retains `task: "participant_erasure"`,
   `participantDigest = SHA256('app-usagemonitor/admin-participant-erasure/v1\0' + participantId)`,
   and outcome/code/count, never the raw participant identifier or identity.
5. A failed or interrupted operation remains incomplete. Diagnose its fixed
   failure code and retry the same verified target through this owner boundary
   when safe. A fresh started attempt returns `409 PARTICIPANT_DELETING`:
   wait/recheck instead of issuing concurrent erasures. A new attempt uses its
   audited operation UUID as the deletion fence; it may take over a non-null
   legacy deletion fence with no matching audit, a failed owner attempt, or a
   started owner attempt older than five minutes. Final database removal is
   conditionally fenced so a stale attempt cannot complete after takeover.
   No live participant session or schema migration is needed.
6. A missing participant is already erased only with an unexpired tombstone in
   the independent ledger: that success has
   `deleted: true`, `alreadyDeleted: true`, and `contributionsDeleted: null`
   (unknown historical count, not zero), with the same response envelope and
   task. Without that proof the response is `404 NOT_FOUND`, not success.

Restore replay owns `state: 'deleting'` with `deletion_session_id: null`.
An owner request against that state also returns `409 PARTICIPANT_DELETING`;
let maintenance finish or retry the restore instead of taking it over. Cron
must not resume non-null owner or legacy deletion fences: those require the
private owner path, even when an old session fence has no matching audit.

The operation must preserve the upload fence, aggregate withdrawal/rebuild,
independently verified tombstone, identity cooldown, bounded R2 cleanup, race
checks, and final database removal. It does not erase local history or provider
records. Do not substitute ad-hoc D1/R2 deletion, remove old tombstones, or
change migrations/retention as part of this retirement. Restore/reconciliation
and normal expiry safeguards remain required. Actual production retention and
backup horizons still need owner verification; a source constant is not proof.

Privacy-request intake and identity verification are separate from technical
authority to execute erasure. No new contact channel, deadline, or legal
conclusion is established here; see [SUPPORT.md](../../SUPPORT.md#hosted-history-and-privacy-requests).

## Incident containment

Classify before mutating:

| Class | First action |
|---|---|
| Public availability or bad deploy | Preserve health/error evidence; assess a source rollback through the same protected deploy path |
| Privacy, authorization, abuse, or cost risk | Stop or narrow the affected collection stage using the production control mechanism; preserve the control revision and reason |
| Data integrity or schema mismatch | Stop dependent writes, preserve the original state, inspect ledgers/backups, and rehearse forward recovery on a copy |
| Updater publication risk | Stop the atomic appcast publication path; do not overwrite or hand-edit signed feed bytes |
| Admin-only failure | Keep public/admin host segregation intact; diagnose Access, owner pin, optional analytics, and route behavior separately |

The checked-in `collection-control.mjs` command is intentionally local-only and
must not be repurposed for production. Production containment is an owner-run,
revision-checked D1 operation using the reviewed control schema and a valid
reason code. Restoration is a separate decision after root cause, reconciliation,
and read-back; never treat “contain” as permission to “restore.”

## Recovery and rollback

- Prefer forward-compatible repair. Never relabel a D1 or local SQLite schema,
  delete a migration ledger, or let older code mutate newer state.
- Before any destructive data operation, identify exact rows/objects, retention
  and tombstone effects, replay behavior, deletion-ledger impact, and the backup
  from which recovery was rehearsed.
- Quarantine retention and restore replay must remain deletion-safe. A deleted
  participant or tombstoned resource must not reappear through backup restore,
  delayed processing, or object replay.
- For tombstoned participants, restore replay atomically claims only active
  rows or interrupted restores already deleting with a null
  `deletion_session_id`; it skips non-null owner/legacy fences. Final removal
  must match the null restore fence or the owner operation UUID respectively,
  so concurrent maintenance cannot finish an owner's in-flight erasure.
- A Worker rollback must still understand the live schemas and current durable
  state. If it cannot, contain the affected path and deploy a forward repair.
- Do not roll back appcast bytes by ordinary R2 overwrite. The signed feed,
  immutable enclosure, version ordering, and atomic guard are one release
  contract.

## Closeout evidence

Record exact UTC time, source commit, affected surface, read-only observations,
authorized mutations, migration tokens, control revisions, deploy result,
post-change health identity, targeted route result, and remaining risks. Keep
private identifiers and secrets out. Add a dated receipt only when the evidence
has enduring audit or recovery value; otherwise use the issue/incident record
and remove superseded procedural notes from the repository.
