---
title: Production service operations
date: 2026-08-27
type: runbook
status: operational
---

# Production service operations

This is the current service-operations runbook for the Cloudflare Worker behind
`tibotattle.com` and `admin.tibotattle.com`. It covers observation, deployment,
schema gates, incident containment, and recovery boundaries. It does not
authorize credentials, remote writes, migrations, releases, or updater
publication; those remain explicit owner operations.

The Sparkle artifact/publication sequence is separate and remains governed by
the [macOS stable release runbook](./macos-stable-release-runbook.md).

## Production topology

| Surface | Authority and boundary |
|---|---|
| Public and `www` hosts | One production Worker and manifest-verified static release-site assets |
| Admin host | Same Worker, but admin routes exist only on `admin.tibotattle.com`, behind Cloudflare Access and a Worker-side owner check |
| Primary durable state | `USAGE_MONITOR_DB` D1 binding; checked-in migrations through `0040_community_allowance_publication_state.sql` in this snapshot |
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

## Owner deployment

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
