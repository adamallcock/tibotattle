---
title: GCP brake and incidents
date: 2026-10-02
type: runbook
status: draft
---

# GCP brake and incidents

> **Draft. Not operational.** This draft covers what to do when the switch to
> the Google Cloud origin goes wrong, and how to handle incidents once the
> origin serves production. The owner's rollback policy (checklist OWN-10,
> decided 2026-10-02) is the spine: **brake to `fenced` only, then fix forward.**
> Rolling back to the Cloudflare Worker is allowed only before the switch. There
> is no authority-write-free window and no flag. Nothing here authorizes a
> deploy, a brake, a secret change, a restore or a scheduler change; each is a
> separate owner-authorized operation. Tooling markers (`built`, `in build`,
> `not built`, `owner`) are defined in
> [GCP cutover window](./gcp-cutover-window.md#tooling-markers).

Related: [GCP cutover window](./gcp-cutover-window.md),
[GCP origin rollout](./gcp-rollout.md),
[GCP scheduler resume](./gcp-scheduler-resume.md), and
[Production edge modes](./production-edge-modes.md), whose sections 2, 3, 4 and
6 hold the typed deploy flags, the edge secrets, the fence, brake and abort
commands, and the edge failure table.

## Status and claim boundary

- **Basis.** The fast-path line `claude/gcp-fastpath-final` at `c80f99b9`
  (the C-ADMIN markers re-marked when this draft merged into the line after
  `95c158ba`), the accepted [edge decision](../decisions/2026-10-01-thin-worker-edge-proxy.md) and
  the owner decisions of 2026-10-02.
- **Verified from source.** The mode matrix, the typed deploy refusals, the
  fence-history proof for the abort, the privacy-marker rule across the brake,
  and the edge failure codes.
- **Not verified.** Nothing here has run against a live service. The restore
  procedure, the monitoring and the origin-side operator controls described as
  `not built` have not been built or rehearsed.
- **Not decided.** The thresholds that justify the brake, the observation
  period, who is on call, and any escalation or notification channel are owner
  decisions that are not recorded. This draft invents none of them.

## The rule

| From | To | Allowed | Condition |
|---|---|---|---|
| `worker` | `fenced` | Yes | Starts the fence |
| `fenced` | `worker` | Only before the switch | Abort A: no gcp-mode version has been deployed since the fence began, proved from the verified fence receipt |
| `fenced` | `gcp` | Yes | The switch, or leaving the brake; every gcp check runs again |
| `gcp` | `gcp` | Yes | Redeploy: web-only releases, secret rotation |
| `gcp` | `fenced` | Yes | **The brake** |
| `gcp` | `worker` | **Never** | Forbidden by the matrix. No rollback window exists |

After the first gcp-mode version, the Cloudflare stores are stale and fenced,
and the Google Cloud database holds the only live authority. Nothing returns
authority to Cloudflare. If the data on Google Cloud is wrong, the repair is
forward.

## Which situation am I in

| Situation | Action |
|---|---|
| Before the fence | Nothing has changed. Stop |
| Fenced, and no gcp-mode deploy has been attempted | Fix the cause and continue, or [Abort A](./gcp-cutover-window.md#abort-a-before-any-gcp-mode-version). Abort invalidates the seal and spends the import target |
| A gcp deploy was attempted and its outcome is **uncertain**, or it succeeded, or it failed after upload | Treat the switch as having happened. Brake and recover; never use Abort A. The typed deploy proves the history, and an uncertain deploy may have created a gcp version |
| gcp mode, healthy | Normal operation; incidents below |
| gcp mode, harmful or unsafe | Brake |
| Braked (`fenced` after gcp) | Stay braked, [fix forward](#fix-forward), and leave only by `fenced` to `gcp` |

## When to brake

The owner decides when to brake, and records the thresholds before the cutover
window opens. Candidate triggers, proposed here for the owner to confirm or
change:

- A public path may be writing wrong or unsafe data to the database.
- Evidence that the invoker credential or the origin boundary is exposed or
  bypassed.
- A public failure that no lesser control contains, where the expected time to
  fix forward is longer than the owner will tolerate.

Prefer the lesser control when it contains the harm:

- Collection controls stop enrollment, upload registration and processing. They
  never retract a publication, and turning publication off is a reversible
  serving switch that serves the same revisions when turned back on. The
  control surface at the origin is the admin routes. Since ADMIN-R12 (owner
  round 12) the production and staging composition opens the admin host
  behind the Access chokepoint, and `set_collection_controls` works over the
  API (local proof only). The overview is `admin-overview-v0.6`: its
  synthetic-contribution counts, historical publication and deletion-ledger
  blocks answer `{"status":"unavailable"}` until their sources exist
  (E-ADMIN). The console can act once the edge Worker serves the admin
  client that reads overview v0.6 and database health v0.2 (E-EDGEPORT).
  Until then the deployed client refuses both versions as invalid and keeps
  its controls disabled: it fails closed and never shows a wrong value. The
  Cloudflare collection-control operator reads Cloudflare's D1 and does not apply
  after the switch; a Google Cloud equivalent is `not built`.
- A trigger pause stops a job
  ([GCP scheduler resume](./gcp-scheduler-resume.md#pause)).
- A typed `gcp` redeploy fixes an edge-side fault such as a bad secret.

## The brake

Authorization: the brake, in chat, naming the reason. `owner`.

The brake is a typed fenced deploy with no plan, from the current edge commit:

```bash
npm run production:deploy -- --confirm DEPLOY_PRODUCTION \
  --expected-previous-source <reviewed-full-deployed-source-sha> \
  --inventory <fresh-private-inventory.json> \
  --inventory-sha256 <fresh-inventory-sha256> \
  --retained-public-source <live site's source sha> \
  --expected-live-manifest-sha256 <live manifest sha256> \
  --edge-mode=fenced
```

`built`. Capture a fresh private inventory first and pin its sha256; the edge
version in gcp mode is the predecessor, read from the Cloudflare bindings. The
brake keeps the live, marked site (the retained pair); a changed site is
refused while fenced (`PRODUCTION_CANDIDATE_SITE_FENCED`). A broken site is
fixed with a gcp deploy of a candidate or rollback site
([Production edge modes](./production-edge-modes.md#website-rollback)), not
with the brake.

Verify as in [Production edge modes, section 2](./production-edge-modes.md#2-typed-deploys-per-mode):
one version at 100% whose `DEPLOYMENT_SOURCE_COMMIT` and `EDGE_UPSTREAM_MODE`
bindings match; public health is barrier health; forwarded routes answer
`503 MUTATION_BARRIER_ACTIVE` with `no-store` and `retry-after: 300`.

Record the UTC time, the edge commit, the reason and the evidence.

What the brake does:

- The edge stops forwarding. Every API, admin, sign-in and Apple path answers
  `503 MUTATION_BARRIER_ACTIVE`. The apex site's static assets still serve.
- The Cloudflare writers stay fenced.
- The privacy page keeps its marked, accurate text, because the fenced version
  keeps the gcp-only bindings that record that Google Cloud has served.
- The Cloud SQL data is untouched. Accepted contributions stay.
- The origin stays IAM-private and still answers the verifier account, so
  readiness can be checked while braked.

What it does not do:

- It does not return authority to Cloudflare, and it does not restore anything.
- It does not pause any Cloud Scheduler trigger or stop any Cloud Run job.
  Decide that separately.
- It does not retract or hide any published statistic. Public community
  reads are forwarded, so they answer 503 while braked.
- It does not keep release publishing running: the Sparkle appcast guard is
  blocked in fenced mode, so publication pauses until the edge is in gcp mode
  again.
- It does not tell shipped clients anything beyond the 503 and its
  `retry-after: 300`.

## Fix forward

1. **Hold the brake.** Do not redeploy the edge in another mode and do not
   release the writer fence. Never use a dashboard or raw Wrangler version
   rollback; that is a raw deploy and bypasses the typed path.
2. **Preserve evidence, content-free.** Keep the receipts, the commits, the
   instants and the closed codes. Do not copy row values, tokens, addresses or
   session content into an issue, log or transcript.
3. **Diagnose read-only.** Public health and readiness, the infrastructure
   readback, the scheduler probe, the service and job descriptions, the edge and
   origin logs, and the database's own metrics:

   ```bash
   node scripts/gcp-infra.mjs readback --require-clean --environment=production
   node scripts/gcp-infra.mjs scheduler-probe --environment=production
   gcloud logging read '<filter on the closed event name>' --project=<project> --freshness=1h --limit=20 --format=json
   ```

   `built`. Edge failure codes are mapped to causes in
   [Production edge modes, reading edge failures](./production-edge-modes.md#reading-edge-failures).
4. **Choose the repair.**

   | Class | Repair |
   |---|---|
   | Origin code or configuration | A new commit, then [build, migrate and roll](./gcp-rollout.md) with the triggers paused. If it changes `edge-origin-contract.ts`, the edge must also redeploy from a commit with the same blob before the brake is released |
   | Schema | A forward, expand-compatible migration through the rollout. Never relabel a version, delete a ledger row or let older code mutate newer state |
   | Missing or drifted resource | The OPS-2 plan and apply, authorized by the plan digest. Apply creates, updates and binds; it never deletes |
   | Secret | Rotate; see [secrets](#secrets-and-keys) |
   | Edge | A typed redeploy in the mode the matrix allows |
   | Data | A reviewed, owner-authorized forward repair on a rehearsed copy, or a restore into a new instance under [database or data loss](#database-or-data-loss) |

5. **Verify before leaving.**
   - The infrastructure readback exits 0.
   - The verifier smoke reads `ok` and `ready` at the commit you intend to
     serve, and a maintenance pass is fresh.
   - The contract blob is identical at the edge commit and the origin commit.
   - The privacy-marker rule, edge secrets, admission bindings and the
     release-guard database are in place for a gcp deploy.
6. **Leave the brake.** Authorization: the switch back, in chat. Run the typed
   gcp deploy again, `fenced` to `gcp`, with the plan, the verified origin
   commit and the verifier account, exactly as in
   [cutover window, H.6](./gcp-cutover-window.md#h6-switch-the-edge-to-gcp).
   Every gcp check runs again. Public health must report `ok` with the origin
   commit.
7. **Observe and record** as in
   [cutover window, H.7](./gcp-cutover-window.md#h7-observe). Resume a trigger
   you paused only if it was live `ENABLED` before you paused it, under
   [GCP scheduler resume](./gcp-scheduler-resume.md#resume).

If a brake deploy's outcome is uncertain, do not retry it blind. A retained
deployment lock after an uncertain provider response is a stop. Follow the typed
recovery in [Production service operations](./production-operations.md#guarded-deployment-wrapper):
prove the original executor has stopped, capture a fresh private inventory, and
reconcile with the same pinned mode and plan.

## Incidents

Classify before mutating, and use the least control that contains the harm.

| Symptom | Likely cause | First read-only checks | Containment and repair |
|---|---|---|---|
| `503 EDGE_ORIGIN_UNAVAILABLE` for every forwarded request; edge log `EDGE_TOKEN_UNAVAILABLE` | The identity token cannot be minted: an invalid, expired or deleted invoker key, or the account disabled | Edge log code; the invoker account and key state in Google Cloud | Rotate `EDGE_INVOKER_KEY_JSON` (see secrets). A typed `gcp` redeploy is not needed |
| The same, with `EDGE_UPSTREAM_TIMEOUT` or `EDGE_UPSTREAM_NETWORK` | The origin is slow, restarting or unreachable | Service revision status, instance count, database health | Fix forward at the origin. Brake only if writes are at risk |
| The same, with `EDGE_UPSTREAM_UNMARKED` | Google's front end refused, Cloud Run was overloaded, or the origin boundary returned `421` | Origin logs for `edge_origin_boundary_refusal` and its reason code; the service's ingress and invoker IAM | A `421` after a deploy is contract drift or key misuse: check the contract blob on both commits. Fix forward; the contract path is in [rollout](./gcp-rollout.md#contract-changes) |
| `503 EDGE_NOT_CONFIGURED` | The mode variable is missing or unknown, or the gcp configuration is invalid | The live version's bindings against the plan | A typed redeploy with the correct mode and plan |
| `/api/ready` reads `not_ready`, health is `ok` | The lifecycle pass is stale (older than 2 hours) or failed, or reconciliation is incomplete | The maintenance job's last execution and its closed code | Run a pass by hand, then fix the trigger. Under a migration, the pass skips with `MIGRATION_IN_PROGRESS` |
| Public community reads are stale or missing | The refresh job is failing, paused or finding the lock held | The job's last executions and receipt line; `LOCK_HELD` is a no-write exit 0 | Published days stay served until republished. Fix the job forward; pause its trigger while the fix is built |
| Origin 5xx, connection errors, slow queries | Cloud SQL saturation, a long transaction, the refresh job's read snapshot holding the horizon | Instance metrics; `pg_stat_activity` classes; job executions | Pause the refresh trigger; the refresh writes in one transaction. Scale the instance only as an owner decision |
| Admin host returns `403 ACCESS_REQUIRED` or `503 ADMIN_NOT_CONFIGURED` | The Access chokepoint refused, or the Access settings are absent from the edge | `edge_admin_chokepoint_refused` log, Access application and owner pin | Diagnose Access separately; do not widen the chokepoint |
| An unauthenticated request to the Cloud Run URL gets anything other than Google's 403 | The origin lock is broken: ingress or invoker IAM changed | The service's IAM policy and ingress setting | Treat as a security incident. The owner removes the unexpected binding or restores the ingress setting by hand, because OPS-2 apply never deletes, then reads the estate back. Brake if exposure is confirmed |
| Release publication fails, or the update feed guard misbehaves | The guard's release-guard database, or a fenced edge | The edge mode; pending release-guard migrations | Web-only releases follow [Production edge modes, section 6](./production-edge-modes.md#6-releases-and-deploys-in-gcp-mode). Do not hand-edit signed feed bytes |
| Wrong published number | A computation or price card error | Run stamps and the refresh receipt; compare with the source change | There is no retraction path. The refresh job republishes only days named by new evidence or left blocked, so correcting an already published day needs the republish path over each day's saved owner set (E-OWNERSET, OAI-5), which is `not built`. Until it exists, the owner decides between disclosure and turning publication off, a reversible serving switch |

### Secrets and keys

- **`EDGE_INVOKER_KEY_JSON`.** Rotated every 90 days and on suspected exposure.
  The owner creates a new key for the edge-invoker account and puts it as the
  Worker secret. Then confirm that forwarded requests succeed (public
  `GET /api/health` returns the origin's 200, not `503 EDGE_ORIGIN_UNAVAILABLE`),
  delete the old key in Google Cloud, and recapture the typed baseline. Each
  put creates a new version at 100%; recapture after it. If organization policy
  blocks key creation, the request is an exception for the edge-invoker account
  only, rotated every 90 days and holding only the invoker role.
- **`EDGE_CLIENT_KEY_SECRET`.** Rotating it resets every per-address window once.
  Rotate on suspected exposure, not routinely, then recapture the baseline. It
  must never equal the origin's identity-link secret.
- **Origin secrets in Secret Manager.** Pinned by version in the committed
  desired state. A new version is a desired-state change through OPS-2 and a
  rollout. Do not rotate the identity-link secret without an owner decision and
  a design. Round 16 (2026-10-02) rotates it once, at the cutover, through the
  recorded [identity-link rotation](./gcp-cutover-window.md#identity-link-rotation-round-16):
  the Cloudflare value is lost, and round 12 retires every route that reads the
  pin or a link key. The kept session, device, renew and disconnect routes do
  not read it; at the origin it keys only the rate-limit subjects (client
  address and upload principal, 60-second windows, no continuity). The
  imported pin is the continuity record: a later rotation is a new owner
  decision with its own recorded pin change, never a hand edit of the pin row.
- Never put an edge secret in Secret Manager, the origin, the repository, a log
  or a receipt, and never put an identity token in a file, a log, an argument or
  shell history.

### Database or data loss

Backups are daily and kept at most 30 days, point-in-time recovery covers 7
days, and labelled pre-change backups are kept at most 90 days (the retention
drafted for the privacy disclosure). On-demand backups are taken only through the OPS-1
tool. Sealed Cloudflare exports and frozen copies are kept 90 days, then
deleted.

The procedure below is a design, not a rehearsed runbook. The staging
rehearsal tool is `built` (E-OPS7,
`apps/worker/scripts/gcp-backup-restore-rehearsal.mjs`, run as in
[the staging runbook](./gcp-staging-apply.md#backup-restore-rehearsal-e-ops7)),
but it has not run against a live instance, and restore tooling for a real
recovery (OPS-7) is `not built`. Treat a restore as an owner-led operation with
Claude preparing the plan.

1. Brake if writes are unsafe, and pause the triggers.
2. Restore into a **new** instance, from a backup or by point-in-time recovery.
   Never overwrite the live instance, and never restore the frozen Cloudflare
   copies to authority.
3. Migrate the restored database forward to the image tail with the migration
   job, and run a maintenance pass. Readiness must reach `ready` only after the
   restore-specific gates pass.
4. **Reapply the do-not-restore list before uploads reopen.** The list holds the
   deletion digests of participants erased before the move and of any later
   owner erasure. Custody of the list is an open decision (OA-9). Anything that
   restores participant data, including a frozen Cloudflare copy, applies the
   list first or is destroyed.
5. Keep client ingress and publication paused until those gates pass, then
   repoint the origin and leave the brake.

### Privacy and erasure requests

The running service performs no erasure, and no route, scheduled job or fence
does. A verified erasure request is a rare, manual, offline owner procedure
(Variant B). It is not operational until the owner decides its intake channel,
proof method and the do-not-restore list's custody (OA-9, decided after the
cutover), and until then the privacy page's wording stays conservative and
claims no request channel. Revoking, disconnecting, opting out, expiring a
credential or containing a device only stops future uploads; none withdraws
accepted contributions. See
[the append-only decision](../decisions/2026-09-26-append-only-contributions.md#d2-erasure-is-a-rare-manual-offline-owner-procedure-variant-b).

## Never

- Never move authority back to Cloudflare after the switch: no `gcp` to
  `worker`, no release of the writer fence with `--pre-gcp`, no restore of the
  Cloudflare D1 or R2 data as live state, and no DNS, load balancer, Transform
  Rule or custom-domain change.
- Never use Abort A once a gcp-mode version may have existed.
- Never deploy the edge from the GCP line, from the checked-in `env.production`
  or with a raw tool.
- Never delete or relabel a migration ledger, downgrade a schema, wipe
  application data, or let an older image run against a newer schema.
- Never put a secret, token, address, identifier, row value or session content
  in a ticket, log, receipt or transcript.

## Open gaps

| Gap | State |
|---|---|
| Thresholds that justify the brake, the observation period, escalation and notification | Owner decisions, not recorded |
| Monitoring, alerting and the origin-lock check | `not built` (E-OPS5) |
| Restore tooling and its rehearsal | Staging rehearsal tool `built`, never run live (E-OPS7). Its do-not-restore step has no list until OA-9, so it never reports that uploads may reopen. Real-recovery tooling `not built` (OPS-7) |
| Operator controls for collection containment at the origin | Route modules `built` (C-ADMIN; `set_collection_controls` works over the API) and the admin host opened behind the Access chokepoint (ADMIN-R12), local proof only. The overview is `admin-overview-v0.6`, with three blocks `{"status":"unavailable"}` (E-ADMIN). The console can act once the edge ships the admin client that reads v0.6 and database health v0.2 (E-EDGEPORT); until then the deployed client fails closed on both. A Google Cloud operator wrapper is `not built` |
| Scheduler pause-all and resume-all | `not built` (D-OPS3) |
| Custody of the do-not-restore list and the erasure intake channel | Open (OA-9), decided after the cutover |
| Edge live capture and barrier-proof writers | `not built`; no command writes either file |
| The fast-path plan's minimum cutover sequence and the append-only decision (D5 and its open choices) still describe the post-flip rollback policy as open | The owner answered it on 2026-10-02 (OWN-10), and the edge decision's section 10 records the answer; the other records predate the answer and are not rewritten |

## Evidence boundary

This is a draft runbook, not an incident record or a deployment receipt. A
source review does not prove a live service. The brake, a restore, a rotation,
a rollout and public deployment are separate gates, and this document proves
none of them.
