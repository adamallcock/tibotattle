---
title: GCP cutover window
date: 2026-10-02
type: runbook
status: draft
---

# GCP cutover window

> **Draft. Not operational.** This draft sequences the switch from the
> Cloudflare Worker's own storage to the Google Cloud origin: steps H.1 to H.8
> of the cutover checklist. It was written before the tooling for several steps
> exists and before any step has run. Nothing here authorizes a deploy, a
> writer fence, a seal, an import, a secret change, a scheduler resume, an edge
> switch or a brake. Each is a separate, owner-authorized protected operation,
> authorized in chat for that operation alone. Until the cutover completes,
> [Production service operations](./production-operations.md) governs
> Cloudflare, and [Production edge modes](./production-edge-modes.md) governs
> the typed edge deploys this window uses.

This runbook covers one planned window, from the go decision to the first
analytics publication on Google Cloud. It does not cover how the origin is
built and pre-staged ([GCP origin rollout](./gcp-rollout.md)), how triggers are
paused and resumed ([GCP scheduler resume](./gcp-scheduler-resume.md)), or what
to do when the switch goes wrong ([GCP brake and incidents](./gcp-brake-and-incidents.md)).
The window's order is the plan's
[minimum cutover sequence](../plans/2026-10-01-gcp-fastpath.md#minimum-cutover-sequence)
with every precondition, attestation and abort path made explicit.

## Status and claim boundary

- **Basis.** Written on 2026-10-02 from the fast-path line
  `claude/gcp-fastpath-final` at `c80f99b9` and the cutover checklist as it
  stood that day. The checklist is kept outside the repository, in the GCP
  parity workspace; its item IDs (`OWN-`, `PROD-`, `REH-`, `OAI-`, `C-`, `D-`,
  `E-`) are used here as labels. The owner's decisions of 2026-10-02 (rounds 1
  to 3 and the round 3 amendment) are binding. Wave-4 streams were still
  merging, so the line will change; take every command's exact flags from the
  code on the line that carries it.
- **Verified from source.** The EP-8 fence commands, the typed edge deploy
  flags and refusal codes, the seal and fence-consumption commands, the
  transfer target's run states and flip gates, the OPS-10 verbs and receipts,
  and the scheduler policy were read from the line's code and its local tests.
- **Not verified.** No step has run against Cloudflare, Google Cloud or real
  data. The seal's provider export shapes have never been observed. The
  window's length (the plan estimates 1.2 to 3.2 hours of authenticated-route
  outage) is an estimate until the production-scale timings from the dress
  rehearsal exist. The plan's "15-minute quiet window" counts one of the two
  windows that EP-8 `verify` needs, so fence verification alone cannot finish
  before 35 minutes after `apply`; check the estimate against that. No `gcloud` readback has been parsed from a live project.
- **Decisions this draft encodes.**
  - The [edge decision](../decisions/2026-10-01-thin-worker-edge-proxy.md) is
    accepted: three modes, one Worker, one version at 100%.
  - The rollback policy (checklist OWN-10): brake to `fenced` only, then fix
    forward. Rolling back to the Cloudflare Worker is allowed only before the
    switch. There is no authority-write-free window and no flag.
  - A sealed participant that is mid-erasure has no override: finish the
    erasure on Cloudflare, then re-seal.
  - The do-not-restore list is always enforced from the seal's own deletion
    records.
  - The scheduler triggers are resumed only explicitly.
- **Evidence gates stay separate.** A green local check, a staging rehearsal,
  the dress rehearsal and this window are four different pieces of evidence.
  None proves another.

## Tooling markers

Each step says what it depends on. A step marked `not built` or `in build`
cannot be run as written; its command is a placeholder in angle brackets, and
the step's acceptance criteria are what the finished tool must satisfy.

| Marker | Meaning |
|---|---|
| `built` | On the line at `c80f99b9` (for C-IPR, C-ADMIN and C-REFRESH, on the line this draft merged into after `95c158ba`), tested locally with synthetic data, never run against a live service |
| `in build` | Owned by a running wave-4 or wave-5 stream; not on the line yet |
| `not built` | Listed in the checklist for a later wave, or only designed |
| `owner` | Done by the owner outside the repository's tools, for example in the Cloudflare dashboard or Google Cloud console |

## Rules for the whole window

- No DNS change, load balancer, Transform Rule or custom-domain change. The
  three hostnames stay custom domains of the same Worker in every mode.
- No raw `wrangler deploy` and no deploy from the checked-in `env.production`.
  Every edge deploy is typed. Exactly one Worker version serves 100%; never use
  a gradual deployment or a version split.
- After any gcp-mode version has been deployed, the only way back is the brake
  (gcp to fenced). Gcp to worker is forbidden.
- Seal files, projections, inventories, plans and receipts live in an
  owner-private directory outside the repository, mode `0700`, with files
  `0600` or `0400`. They are kept for 90 days after the switch and then
  deleted.
- No secret, identity token, address, device or participant identifier, row
  value or session content enters the repository, a log, a receipt, an issue or
  a transcript. Records hold counts, digests, names, commits, instants and
  closed codes.
- A retained deployment lock after an uncertain provider response is a stop,
  not permission to retry with raw tools
  ([guarded deployment wrapper](./production-operations.md#guarded-deployment-wrapper)).
- Run one protected operation at a time, and write down its start and end in
  UTC in the cutover log.
- Claude prepares plans and reads local files; the owner runs every protected
  operation. An agent never runs a step of this window.

## The sequence at a glance

| Step | Edge mode after | Cloudflare writers | Google Cloud origin | Ends when | Way back |
|---|---|---|---|---|---|
| Preconditions | `worker` | Live | Pre-staged, migrated, empty, private | Every gate below is recorded | Nothing has changed |
| H.1 Pre-flight and release pause | `worker` | Live | Ready | The EP-8 plan receipt exists and the go decision is logged | Stop |
| H.2 Fence | `fenced` | Fenced, quiet window proven | Unchanged | EP-8 `verify` receipt exists | [Abort A](#abort-a-before-any-gcp-mode-version) |
| H.3 Seal | `fenced` | Fenced | Unchanged | Seal manifest, projections and frozen export exist | Abort A; the seal is lost |
| H.4 Import and verify | `fenced` | Fenced | Import, then `verified`, then `live` | `markLive` done, frozen read loaded, maintenance pass fresh | Abort A; the target database is spent |
| H.5 Verifier smoke | `fenced` | Fenced | Serving only the verifier | Smoke passes; origin commit recorded | Abort A |
| H.6 Switch | `gcp` | Fenced | Serving the public | Typed gcp deploy verified | None. The brake only |
| H.7 Observe | `gcp` | Fenced | Serving | Owner ends the observation | The brake |
| H.8 Analytics cold build | `gcp` | Fenced | Serving | First Google Cloud publication, interim read retired | The brake |

## Preconditions

Record each gate, its evidence and the time before H.1. A gate that is open is
a no-go.

| Gate | Checklist items | Must be true |
|---|---|---|
| Production line known | OWN-1, OAI-2 | The production commit P is recorded from the live health and its ancestry checked against `d43c8f92` |
| Catch-up to P | OAI-3 to OAI-9, F-REDERIVE, F-REGISTRY, F-V12P if it applies | Kernels, packages and contracts match P. Renumbered D1 migrations match production's applied tail (the seal's expected ledger depends on it) |
| Route decisions | OWN-2, OWN-3, E-PORTS | Kept and retired routes are decided from production traffic counts. Retired routes answer `503 POSTGRES_ROUTE_NOT_PORTED` or are ported |
| Origin code | C-SIMP, C-ADMIN, C-MAINT, C-REFRESH, D-CRB, D-PT5A, D-OPS3, D-OPS4, D-BLOB, E-PT8 | Merged on the deploy line and green. The status of each at the time of writing is in [open gaps](#open-gaps-in-tooling-and-decisions) |
| Estate | PROD-1, OWN-5, OWN-5b, OWN-5c, OPS2-READ | The OPS-2 plan was applied by the owner and its readback reads clean. The first live readback parsed correctly on the test project |
| Secrets | PROD-2, OWN-6, OWN-6b | Secret Manager is populated. The identity-link secret matches the sealed pin and the envelope keys are identical. The Cloudflare edge secrets are in place and the typed baseline was recaptured after each put |
| Origin pre-staged | PROD-3 | The origin migrated to the tail and rolled ([rollout](./gcp-rollout.md)). A maintenance pass ran. The verifier smoke reads ready. An unauthenticated request to the Cloud Run URL gets Google's 403 |
| Scheduler | PROD-4, E-OPS5 | Triggers exist and are paused, with the cadence from the refresh measurements. The paused-too-long probe has a runner and a notification target |
| Edge | PROD-5, E-EDGEPORT, OWN-7, OWN-7b | The worker-mode edge is live from the edge-port line. The release-guard D1 exists and has no pending migration. All six edge-tier rate-limit bindings are live. The edge IP probe from the `tibotattle.com` zone passed. Each mode was rehearsed on the staging edge, including a fence and abort drill |
| Candidate site | E-OPS9 | A site built from the edge-port line carries the privacy marker and is not yet deployed. `SECURITY.md`, the privacy page and the local-data reference are in the cutover commit |
| Owner-private plans | OWN-12 | The EP-8 fence plan (including the analytics catch-up consumer and any recovery analytics Worker), the seal inventory (`expectedSourceCommit` equal to P), the gcp edge plan and the receipts directory exist |
| Frozen read input | OWN-4, C-IPR | The format for the frozen `community_daily` export is defined and the export is ready to be taken at the seal |
| Rehearsal | REH-1, MEAS-2, MEAS-3 | The full dress rehearsal at P ran in the production project on a disposable database. Its timings sized this window |
| Backups | OPS-1 | The backup audit reports no breach. The restore rehearsal reapplied the do-not-restore list before uploads reopened (E-OPS7) |
| Authorizations | OWN-13 | Each protected operation below will be authorized in chat when its step is reached |
| People | | The owner is present for the whole window. No release publication is in flight |

## Attestations and clocks

The operator makes these attestations. The tools record them; they do not
prove them.

| Step | Attestation |
|---|---|
| H.1 | No release publication or web-only release is in flight |
| H.2 | Every in-flight Cloudflare erasure and analytics-delivery job has finished (`--analytics-drain-complete`) |
| H.3 | The inventory names the intended D1 databases and the production commit P, and every remote call is read-only (`--owner-read-only`) |
| H.4 | Any role members waived at the flip gate are administrative and are named in the log |
| H.5 | The operator may impersonate the verifier account, and the token stays in memory |
| H.6 | The IP probe passed from the production zone, and the privacy wording matches what the probe showed |

| Clock | Limit |
|---|---|
| EP-8 quiet window | `verify` succeeds only when now is at least `appliedAt` + 2 x the plan's quiet window + 5 minutes of analytics lag: 35 minutes after `apply` at the 15-minute minimum. `appliedAt` is when `apply` finished, not when the fenced deploy ran |
| Seal bookmarks | The bookmark before the export equals the fence receipt's, and the one after equals the one before |
| Flip evidence | Re-read just before the flip. Any drift fails `CUTOVER_SOURCE_CHANGED_AFTER_SEAL` |
| Origin readiness | Goes stale 2 hours after the last maintenance pass |
| Backup audit (rollout) | At most 6 hours old |
| Edge live capture (rollout) | At most 15 minutes old |
| Migrate receipt (rollout) | At most 24 hours old |

## H.1 Pre-flight and release pause

Authorization: the read-only Cloudflare reads in steps 1, 4 and 5 (inventory,
the quiescence statements, and plan; no write). `owner`.

1. **Confirm the edge.** The live Worker is in `worker` mode on the edge-port
   line: one version at 100%, `deployment.sourceCommit` on public
   `GET /api/health` equal to the recorded edge commit, and
   `EDGE_UPSTREAM_MODE` equal to `worker`. Capture a fresh private inventory
   and pin its sha256; the typed deploys in this window use it. `owner`.
2. **Confirm the origin.** Run the verifier smoke and record the origin
   commit. Check that the Git blob of `apps/worker/src/edge-origin-contract.ts`
   is identical at the edge commit and the origin commit. Tooling: the smoke
   is `in build` (verifier tooling); the blob comparison is
   `git rev-parse <commit>:apps/worker/src/edge-origin-contract.ts` on each
   commit, `built`.
3. **Pause release publishing.** The Sparkle guard is blocked while the edge
   is fenced, and web-only releases pause. Stop any release in flight and
   record that none is pending. Releases resume under the gcp rules in
   [Production edge modes](./production-edge-modes.md#6-releases-and-deploys-in-gcp-mode).
   `owner`.
4. **Check for participants that are not quiescent.** A participant that is
   mid-erasure refuses the seal and the identity import, and each one found
   late costs a full extra fence cycle. Run the read-only quiescence check
   (E-QUIESCE) with `--phase pre-fence`. It gates on mid-erasure participants,
   tombstoned participants and pending erasure jobs, and prints counts and
   opaque references only. From `apps/worker`, print each role's statement
   (`ingestion`, `deletion-ledger`, `analytics`), run it through a read-only
   `wrangler d1 execute <database> --remote --json --command "<statement>"`
   with the owner's read-only credentials in the environment, save the output
   privately, and evaluate it (the script's header has the exact commands):

   ```bash
   node scripts/cutover-quiescence-check.mjs queries --role ingestion --sql
   node scripts/cutover-quiescence-check.mjs evaluate --phase pre-fence --ingestion-result <private file> --ledger-result <private file> --analytics-result <private file>
   ```

   `evaluate` cannot hash, so its best result is exit 3 with only
   `deletion-digest-intersection` not evaluated; `check` on exported D1 files
   answers the intersection. Exit 2 (`blocked`): finish the erasure on
   Cloudflare and rerun; there is no override. `built`, but its statements and
   the shape of Wrangler's output have not been run against the provider.
5. **Inventory and plan the fence.** Neither command needs a fenced Worker,
   and both are read-only, so a refusal here costs nothing. From `apps/worker`,
   with `CLOUDFLARE_API_TOKEN` supplied through the approved credential
   mechanism:

   ```bash
   node scripts/cloudflare-writer-fence.mjs inventory --plan=<private fence plan> --receipts=<private receipts directory>
   node scripts/cloudflare-writer-fence.mjs plan --plan=<private fence plan> --receipts=<private receipts directory>
   ```

   Review the writer set against the OWN-12 plan: the production Worker, every
   separately deployed writer, the analytics catch-up consumer and any recovery
   analytics Worker. A script outside the plan that binds a listed D1 database
   or R2 bucket fails closed (`WRITER_UNACCOUNTED`), and a fenced script whose
   crons differ from the plan fails `SCHEDULE_DRIFT`. Fix either here, before
   anything is fenced. `plan` prints the receipt sha256 that `apply` takes as
   `--confirm` and `verify` as `--fence`. `built`.

   The plan's fingerprint covers the fenced scripts, their versions and the
   listed data resources, not the production Worker's version or mode, so it
   survives the fenced deploy in H.2. `apply` collects the inventory again and
   refuses `FENCE_INVENTORY_CHANGED` on any drift. Rerun both commands, and use
   the new receipt's sha256, if any Worker deploys between this step and H.2 or
   if the go decision waits long.
6. **Log the go decision.** Record UTC time, P, the edge commit, the origin
   commit and the image digest, the plan digest the estate was last applied
   from, the EP-8 plan receipt sha256, and who is present.

Shipped clients are not notified. For the whole fenced window they get
`503 MUTATION_BARRIER_ACTIVE` with `retry-after: 300`.

Abort: nothing has changed. Stop.

## H.2 Fence

Authorizations: the typed fenced deploy, and the EP-8 apply. `owner`.

1. **Deploy fenced and verify it.** Typed path only:

   ```bash
   npm run production:deploy -- --confirm DEPLOY_PRODUCTION \
     --expected-previous-source <reviewed-full-deployed-source-sha> \
     --inventory <private-inventory.json> \
     --inventory-sha256 <reviewed-inventory-sha256> \
     --retained-public-source <live site's source sha> \
     --expected-live-manifest-sha256 <live manifest sha256> \
     --edge-mode=fenced
   ```

   The fence keeps the live site: the retained pair pins the live manifest
   before and after the upload. A typed deploy with an inventory and no site
   pins is refused `PRODUCTION_ARGUMENTS_INVALID`, and a changed site is
   refused while fenced (`PRODUCTION_CANDIDATE_SITE_FENCED`).

   Verify as in [Production edge modes, section 2](./production-edge-modes.md#2-typed-deploys-per-mode):
   one version at 100% whose `DEPLOYMENT_SOURCE_COMMIT` and
   `EDGE_UPSTREAM_MODE` bindings match; public health is barrier health for the
   commit; the API, admin, Sparkle guard and Apple paths answer
   `503 MUTATION_BARRIER_ACTIVE` with `no-store` and `retry-after: 300`;
   `www` asset paths redirect; `/release-site-manifest.json` is 200. `built`.
2. **Fence the writers.** `apply` needs the production Worker already fenced,
   so it follows step 1. It collects the inventory again, so a script that
   appeared since H.1 still fails closed. From `apps/worker`:

   ```bash
   node scripts/cloudflare-writer-fence.mjs apply --plan=<private fence plan> --receipts=<private receipts directory> \
     --confirm=<plan receipt sha256 from H.1> --analytics-drain-complete
   ```

   `built`.
3. **Prove quiescence.** `verify` refuses until two quiet windows and the
   analytics lag have passed since `apply` finished: it takes the D1 bookmarks
   at the window start (`appliedAt` + one quiet window, unless `--window-start`
   is given) and at now, and the analytics interval ends 5 minutes before now
   and must itself be a full quiet window. At the 15-minute minimum, that is
   35 minutes after `apply`. Run:

   ```bash
   node scripts/cloudflare-writer-fence.mjs verify --plan=<private fence plan> --receipts=<private receipts directory> \
     --fence=<plan receipt sha256 from H.1>
   ```

   With `--window-start=<instant>`, the start may not be earlier than `appliedAt`
   plus one quiet window (`FENCE_WINDOW_TOO_EARLY`), and now must be at least
   the start plus one quiet window plus 5 minutes (`FENCE_WINDOW_TOO_SHORT`).
   Both timing refusals are decided from the apply receipt and the clock,
   before `verify` reads anything from the provider, so running early and
   retrying later costs nothing. The receipt pins the D1 bookmarks and the
   quarantine bucket digest the seal must use. D1 bookmark equality is
   authoritative; the provider's analytics figures only corroborate. `built`.
4. **Capture the barrier proof.** Write the closed file
   `tibotattle-cutover-barrier-proof-v1` from two observed responses taken after
   the fence applied: public `GET /api/health` in barrier mode carrying the
   deployed commit, and one dynamic `/api/` probe answering
   `503 MUTATION_BARRIER_ACTIVE` with `no-store` and `retry-after: 300`. The
   seal consumes it. No command in the repository produces the file; the
   operator writes it from the responses. `owner`.

Stranding risk. From the fenced deploy until `verify` writes its receipt, the
public edge is fenced and there is no typed way back to worker mode, because
[Abort A](#abort-a-before-any-gcp-mode-version) consumes the verified fence
receipt. H.1 moved every read-only check that can be made earlier. What can
still strand the window: an `apply` refusal from drift since H.1
(`FENCE_INVENTORY_CHANGED`, `WRITER_UNACCOUNTED`, `SCHEDULE_DRIFT`), a provider
failure, and a `verify` refusal `FENCE_NOT_QUIESCENT`. Fix the cause and retry
the step; do not weaken the window or the plan to get a receipt. After
`FENCE_NOT_QUIESCENT`, a retry can pass only with a `--window-start` later
than the stray write, and only once the writer is found and stopped. The fenced
outage runs from the fenced deploy through `verify`, so size it as the deploy
and `apply` time plus at least 35 minutes, not 15.

Evidence kept: the EP-8 plan, apply and verify receipts, the barrier proof,
the typed deploy operation record. Abort: [Abort A](#abort-a-before-any-gcp-mode-version).

## H.3 Seal

Authorization: the D1 seal export, a read-only production operation. `owner`.

1. **Preflight, read-only.** From `apps/worker`, compute the expected
   migration ledgers from Git objects at P:

   ```bash
   node scripts/cutover-source-seal.mjs expected-ledger --inventory <private seal inventory>
   ```

   `built`.
2. **Verify the fence for the seal.**

   ```bash
   node scripts/cutover-source-fence.mjs verify-fence --inventory <private seal inventory> \
     --fence-receipt <EP-8 verify receipt> --fence-sha256 <receipt sha256> --barrier-proof <barrier proof file>
   ```

   It refuses a receipt without a 40-hex production commit, a fence that is
   not quiet, bookmarks that do not match the inventory's databases, and a
   barrier proof that does not match the receipt's commit. `built`.
3. **Seal.** Only the ingestion and deletion-ledger D1 databases are sealable;
   the analytics D1 is never imported, because analytics history is recomputed.

   ```bash
   node scripts/cutover-source-seal.mjs seal --inventory <private seal inventory> \
     --fence-receipt <EP-8 verify receipt> --fence-sha256 <receipt sha256> --barrier-proof <barrier proof file> \
     --out <private owner directory> --execute --remote --owner-read-only
   ```

   Without `--execute --remote --owner-read-only` it is a dry run that spawns
   nothing. The seal reads one bookmark before and after the export, rebuilds
   the dump into one `0400` SQLite file, checks integrity, schema, ledgers,
   sequences and per-table aggregates against the remote, and deletes the dump.
   On any failure it deletes every artifact of the run and writes no manifest.
   The manifest's `sealId` is the sha256 of its canonical body; `seal` prints it
   with the manifest's sha256, and every later command that reads the seal takes
   it as `--seal-id`. `built`;
   the provider has never been contacted, so real export shapes are unverified.
4. **Derive the projections.** The journal projection and the content-free
   deletion-digest projection (the do-not-restore seed) come from the seal, and
   the intersection proves by count that no sealed participant matches a
   deletion digest (exit 1 and `CUTOVER_ERASED_PARTICIPANT_PRESENT` otherwise).
   Each command prints counts and sha256 values only:

   ```bash
   node scripts/cutover-source-projections.mjs journal --seal <seal manifest> --seal-id <sealId> --out <private owner directory>
   node scripts/cutover-source-projections.mjs deletion-digests --seal <seal manifest> --seal-id <sealId> --out <private owner directory>
   node scripts/cutover-source-projections.mjs intersection --seal <seal manifest> --seal-id <sealId> \
     --digests <deletion-digests projection> --digests-sha256 <its sha256>
   ```

   `built`. The identity importer repeats the same gate before its first write.
5. **Take the frozen public read.** Export the current `community_daily` read
   model from production, read-only, at the seal, in the format the interim
   read item defines (OWN-4). `owner`; the format and the loader are `built`
   (C-IPR). The loader's table is primary migration `0065`, promoted at the
   C-SIMP-RECON merge.

Refusals to plan for: `CUTOVER_SOURCE_BOOKMARK_DRIFT` (a write reached a D1
after the fence), `CUTOVER_LEDGER_MISMATCH` or `CUTOVER_SCHEMA_MISMATCH`
(production's applied tail differs from the expected ledger at P, see the
renumbering gate), `CUTOVER_SECRET_IN_OUTPUT`, `CUTOVER_OWNER_DIRECTORY_UNSAFE`.
Each is content-free and leaves nothing behind. A bookmark drift means the
fence was not quiet: abort and fence again.

Evidence kept: the seal manifest and its sha256, the projection sha256 values,
the frozen export's digest. Abort: Abort A. The seal is lost and a later
attempt needs a fresh fence.

## H.4 Import and verify

Authorizations: the production imports, the release of the sealed collection
controls and mark-live, the frozen public-read load, and resuming the
maintenance trigger. `owner`.

The target is the pre-staged, migrated, empty production database. The
transfer handle moves a run through `preflight`, `importing`, `verifying`,
`verified` and `live`; every transaction re-asserts PostgreSQL 17, the database,
the session user and the schema-owner role. The frozen stage order is set by the
tooling (`TRANSFER_STAGES` in `postgres-transfer-target.mjs`), and the stage
list on the deploy line governs.

1. **Run the stages in order.** The identity-and-authority stage (PT-3) is
   `built`. It refuses before its first write on column or counter closure, any
   invalid sealed value, an identity-link secret that does not match the pin
   (`CUTOVER_IDENTITY_LINK_SECRET_MISMATCH`), a participant that is not
   `active` or still carries a deletion fence
   (`CUTOVER_PARTICIPANT_ERASURE_PENDING`), an incomplete public-source
   bootstrap, and a broken accountless authority chain. Cooldowns and the
   deletion ledger are not imported. The sealed v0.x history
   (`legacy-contributions`), the pending registrations
   (`pending-registrations`, one transfer hold per registration) and the
   operational history (admin metric snapshots and
   `community_aggregate_exclusions`, mapped in R3 post-import) are `built`
   (D-PT4X; their tables are primary migrations `0066` and `0067`). The
   production modes of the telemetry importers (D-PT5A) and the orchestrator
   that sequences all stages (E-PT8) are `not built`:
   `<command: E-PT8 orchestrator, one disposition per sealed table>`.
2. **Check the orchestrator's dispositions and refusals.** One disposition per
   sealed table, the deletion-digest exclusion count, the identity-pin
   fingerprint, and a digest parity sample between the sealed files and
   PostgreSQL. The orchestrator also refuses while the correction runtime is
   active (`CUTOVER_CORRECTION_RUNTIME_ACTIVE`) and unless the public-source
   bootstrap reads `completed=1`. `not built` (E-PT8).
3. **Finalize to live, in this order.** The run must be `verified` first.
   - Prove the sealed sources are unchanged:

     ```bash
     node scripts/cutover-source-fence.mjs verify-unchanged --inventory <private seal inventory> \
       --seal <seal manifest> --seal-id <sealId> --out <private owner directory> --execute --remote --owner-read-only
     ```

     `--seal-id` is required: it pins the manifest, and without a 64-hex value
     the command refuses `CUTOVER_ARGUMENT_INVALID` before it reads anything.
     It writes `flip-evidence.json` (`0400`, never overwritten) and prints its
     sha256, or fails `CUTOVER_SOURCE_CHANGED_AFTER_SEAL`. `built`.
   - Restore the sealed collection controls exactly
     (`restoreSealedCollectionControls`). Without this, enrollment and
     publication stay disabled after the switch. `built`; the call is made by
     the orchestrator, `not built`.
   - Drop the staging relations, run the flip gate (`assertFlipReady`: every
     stage complete, no checkpoint cursor, controls equal to the sealed row, no
     unnamed role member, no foreign privilege on the transfer schema, every
     trigger enabled), and mark the run live (`markLive`) with the flip
     evidence sha256. `built` as library calls; sequencing `not built`.
   - **`markLive` is a one-way door for that target.** It locks the transfer
     control schema in both databases, the import handle only reads once a run
     is live, and the tooling contains no unlock. If the window aborts after
     it, the next attempt starts from a fresh seal and a new target; the owner
     and Claude decide whether that is a new database on the instance or a new
     instance.
4. **Load the frozen public read.** Serve the frozen `community_daily` until the
   first Google Cloud publication, with the evidence date labelled. The loader
   and the route are `built` (C-IPR), with primary migration `0065` promoted;
   the production load is a call from the import orchestrator, `not built`
   (E-PT8).
5. **Run a maintenance pass and resume the maintenance trigger.** Readiness
   goes stale 2 hours after the last pass, and an empty origin reads not ready
   until the first pass. Run one pass by hand, then resume the maintenance
   trigger under [GCP scheduler resume](./gcp-scheduler-resume.md). The job
   is `built` (C-MAINT); its trigger in the desired state is `not built`
   (D-OPS4).

Evidence kept: the run's stage receipts (counts, digests, states), the
flip-evidence sha256, the transfer run id. Abort: Abort A. The target database
is spent.

## H.5 Verifier smoke

Authorization: the verifier smoke `--execute`. `owner`.

The smoke reads the origin as the verifier account, which may send only plain
`GET /api/health` and `GET /api/ready`. It mints its identity token itself by
impersonating the verifier, keeps it in memory, and records statuses and the
origin commit only.

- **Pass:** both reads return 200 with the origin marker and secure JSON
  headers; `deployment.sourceCommit` equals the origin commit recorded in H.1.
  That commit becomes `--origin-commit` for H.6.
- **Fail:** `not_ready` after an import usually means the maintenance pass is
  stale or has not run. Run a pass and read again.
- Also confirm that `HOST_ORIGIN` on the service equals the origin URL in the
  gcp edge plan (`EDGE_UPSTREAM_ORIGIN`). The tooling check is `not built`
  (D-CRB); compare them by hand.

Tooling: the smoke command is `in build`:
`<command: verifier smoke, read-only, --execute>`. The same pre-gcp verifier
runs again inside the H.6 deploy, so the smoke is a rehearsal of that gate, not
a replacement.

## H.6 Switch the edge to gcp

Authorization: the edge switch (EP-10). `owner`.

Preconditions, all of them:

- H.5 passed within the readiness window.
- The privacy-marker site is the candidate site for this deploy, so the page
  changes in the same deploy as the switch. The deploy refuses
  `EDGE_PRIVACY_PAGE_NOT_CUTOVER` without it. The switch commit is on the
  edge-port line and differs from the live fenced commit only inside the
  [web-only closure](./2026-08-17-web-only-release.md#1-establish-the-source-boundary)
  (the privacy page, the browser localization, the paired i18n catalogue and
  mirror, and their focused tests). Edge code and repository documentation
  land before P1 or after the switch.
- A fresh web-release receipt for the switch commit:
  `product:web-release:prepare --base <live fenced commit>` from a clean
  checkout of the switch commit, which writes the generated site and
  `.release-build/web-release-receipt.json`. Record the receipt's
  `site.manifestSha256`; it is the candidate manifest.
- The live site's pins from H.2 (its source sha and the live manifest
  sha256); they become the replaced pair.
- The gcp plan and both edge secrets are present, the release-guard D1 has no
  pending migration, and all six edge-tier rate-limit bindings are live.
- The contract blob is identical at the edge commit and the origin commit
  (`EDGE_CONTRACT_DRIFT` otherwise).
- The production-zone IP probe passed and is recorded (OWN-7; passed on
  2026-10-02,
  [receipt](../receipts/2026-10-02-gcp-edge-ip-probe-production-zone.md)). The
  deploy does not check this.
- A fresh private inventory with a pinned sha256 exists.

```bash
npm run production:deploy -- --confirm DEPLOY_PRODUCTION \
  --expected-previous-source <reviewed-full-deployed-source-sha> \
  --inventory <fresh-private-inventory.json> \
  --inventory-sha256 <fresh-inventory-sha256> \
  --candidate-public-manifest-sha256 <the receipt's site.manifestSha256> \
  --web-release-receipt <absolute path of the switch checkout's .release-build/web-release-receipt.json> \
  --replaced-public-source <live site's source sha> \
  --replaced-live-manifest-sha256 <live manifest sha256> \
  --edge-mode=gcp \
  --edge-plan=<private gcp plan> \
  --origin-commit=<origin commit from H.5> \
  --origin-verifier-account=<verifier account>
```

`built`. Run it from `apps/worker` on the switch commit. Before the inventory
is read, the deploy re-verifies the receipt with the web-only lane's checks and
requires it to be fresh (its source is the checked-out commit, its base the
live fenced commit) and its manifest to be the candidate. It then rechecks the
live manifest against the replaced pin before the upload, stages exactly the
candidate manifest built from the switch commit, and requires the candidate
live after it. The retained pair (`--retained-public-source`,
`--expected-live-manifest-sha256`) is refused alongside a candidate
(`PRODUCTION_CANDIDATE_SITE_RETAINED_PIN_CONFLICT`). Every refusal is in
[Production edge modes](./production-edge-modes.md#changing-the-public-site).
After the deploy:

- One version at 100% with matching `DEPLOYMENT_SOURCE_COMMIT` and
  `EDGE_UPSTREAM_MODE` bindings, read from Cloudflare.
- Public `GET /api/health` is status `ok` with the origin commit. A
  `RETIRED_SECRET_PRESENT` warning is expected until the retired storage
  secrets are deleted in a later, separately authorized step.
- Every per-address rate-limit window resets once at the switch, because the
  keys are re-derived under the edge secret.

If the deploy refuses before upload, the edge is still `fenced`: fix the
cause and retry, or use Abort A. **If the outcome is uncertain, treat the
switch as having happened.** Do not use Abort A: the history check that guards
it proves from the deployment history whether a gcp-mode version ever existed,
and an uncertain deploy may have created one. Use the brake and typed recovery
in [GCP brake and incidents](./gcp-brake-and-incidents.md).

From the first gcp-mode version, there is no way back to `worker`.

## H.7 Observe

Authorization: none for reading. The brake needs its own authorization.

Read, do not change:

- Public health and readiness through Cloudflare (`/api/health` status ok with
  the origin commit; `/api/ready` ready).
- An unauthenticated request to the Cloud Run URL gets Google's 403
  (the origin-lock check; the monitoring item that automates it is
  `not built`, E-OPS5).
- Edge log lines (`edge_upstream_unavailable` and its codes,
  `edge_admin_chokepoint_refused`) and origin boundary refusals
  (`edge_origin_boundary_refusal`); expect none of the latter.
  [Reading edge failures](./production-edge-modes.md#reading-edge-failures)
  maps each to a cause.
- The maintenance trigger running and the lifecycle pass fresh.
- Database load: CPU, memory, connections and disk.
- One owner-controlled client completing a sync end to end (proposed).
- The admin overview, once the admin routes are served. C-ADMIN's route
  modules are `built` but not registered in the host until D-CRB, and the
  overview answers 503 until its missing sources exist (E-ADMIN).

The duration of the observation and the thresholds that justify the brake are
owner decisions that are not recorded yet. The brake is gcp to fenced
(OWN-10), then fix forward.

## H.8 Analytics cold build

Authorization: the first manual run of the refresh job, and the scheduler
resume. `owner`.

1. Run the analytics-refresh job once, by hand, with the trigger still
   paused, and wait for it. Read its content-free receipt line. `ok` with state
   `LOCK_HELD` means another run held the lock and nothing was written; that is
   not a build. Success needs a completed run. The production contract of the
   job (bounded history loading, output accounting, a time guard) is `built`
   (C-REFRESH); the measured dense run took 66 minutes on a test seed, and the
   production figure is unmeasured.
2. Confirm the first Google Cloud publication: `GET /api/v1/community/daily`
   serves origin-computed days.
3. Retire the frozen interim read. `built` (C-IPR): the route stops reading
   the frozen export as soon as any day is published and cannot return to it.
   Dropping the stored row is a later migration, `not built`, pending the
   owner's reading of the 90-day rule for frozen copies.
4. Resume the analytics-refresh trigger under
   [GCP scheduler resume](./gcp-scheduler-resume.md), at the cadence set from
   the measurements. Then set its committed state to `ENABLED`. Tooling:
   explicit pause-all and resume-all are `not built` (D-OPS3).

Recomputed history can differ from what Cloudflare published, published
revisions restart, and past contributions stay in recomputed history. These
are accepted differences and are disclosed on the privacy page (E-OPS9); they
are not defects of the cold build.

## Abort A, before any gcp-mode version

Allowed only while no gcp-mode version has been deployed since the fence
began. The edge decision's
[mode matrix](../decisions/2026-10-01-thin-worker-edge-proxy.md#10-mode-transitions)
allows fenced to worker in that case alone, and the typed deploy proves it from
the verified EP-8 fence receipt.

1. Run the typed worker-mode deploy with the fence receipt, while the fence is
   still applied:

   ```bash
   npm run production:deploy -- --confirm DEPLOY_PRODUCTION \
     --expected-previous-source <reviewed-full-deployed-source-sha> \
     --inventory <private-inventory.json> \
     --inventory-sha256 <reviewed-inventory-sha256> \
     --retained-public-source <live site's source sha> \
     --expected-live-manifest-sha256 <live manifest sha256> \
     --edge-mode=worker \
     --fence-receipt=<verified fence receipt> --fence-receipt-sha256=<its sha256>
   ```

   The abort keeps the live, unmarked site (the retained pair).

2. Release the fence:

   ```bash
   node scripts/cloudflare-writer-fence.mjs release --plan=<private fence plan> --receipts=<private receipts directory> \
     --confirm=<plan receipt sha256> --pre-gcp
   ```

   It restores the exact prior schedules and queue delivery from the apply
   journal, and is refused once any gcp-mode version has existed since the fence.

Consequences, stated plainly: Cloudflare writes resume, so every seal and
export taken under that fence is invalid and a later attempt needs a fresh
fence and a fresh seal. The tooling does not import into a target that
reached `live`. The fence receipt the abort needs exists only after EP-8
`verify`; before that, there is no typed path back to worker mode (see the
stranding risk in [H.2](#h2-fence)).

## After the switch

Each item is its own authorized operation. Order is flexible except where
noted.

- Web-only releases resume through `production:deploy --edge-mode=gcp` with a
  fresh web-release receipt, and a website rollback re-deploys a previously
  released site by its receipt (`--rollback-web-release-receipt`); see
  [Production edge modes](./production-edge-modes.md#web-only-releases). A
  rollback past the switch is refused (`EDGE_PRIVACY_PAGE_NOT_CUTOVER`): it
  is not an edge rollback, which stays the brake.

- Copy the frozen R2 objects to Google Cloud Storage (PT-7, reduced). `not built`.
  The maintenance pass's reconciliation guard against objects still in R2 is
  `built` (E-PT4, in D-PT4X): the reconciler never touches a registration with
  an unreleased transfer hold, and PT-7 releases each hold, one way, after the
  object is copied or proven absent.
- Integration commit: set `wrangler.jsonc` `main` to `src/edge-entry.ts` and
  record that production is typed-rendered.
- Delete the retired Cloudflare storage secrets, a separately authorized step
  that clears `RETIRED_SECRET_PRESENT`.
- Rotate `EDGE_INVOKER_KEY_JSON` every 90 days
  ([Production edge modes, section 3](./production-edge-modes.md#3-edge-secrets)).
- After 90 days, delete the sealed export, projection and oracle files and run
  the artifact receipt and decommission plan (PT-9). Apply the do-not-restore
  list before any use of the frozen Cloudflare copies, or destroy them.
- Write the supersession notes on the six accepted decision records and update
  the architecture topology in the cutover commit (E-OPS9).
- Clean up the test-project resources after the owner approves the exact
  deletions.
- Before merging to `main`: clear the known red tests and regenerate the R7
  evidence once.

## Refusal codes you will meet

| Code | Where | Meaning and first action |
|---|---|---|
| `EDGE_MODE_TRANSITION_FORBIDDEN` | Typed deploy | The mode pair is outside the matrix. Do not look for a way around it |
| `EDGE_MODE_FENCE_HISTORY_INCOMPLETE` | Abort A | The deployment history cannot be walked back to the fenced deployment the receipt names. Stop and diagnose |
| `EDGE_MODE_SOURCE_NOT_DESCENDANT` | Typed deploy | The source does not descend from the live commit |
| `EDGE_MODE_ADMISSION_BINDING_MISSING`, `EDGE_MODE_SECRET_MISSING`, `EDGE_MODE_RELEASE_GUARD_MIGRATIONS_PENDING` | gcp deploy | A precondition of H.6 is missing |
| `EDGE_ORIGIN_COMMIT_MISMATCH`, `EDGE_CONTRACT_DRIFT` | gcp deploy | The origin answered with another commit, or the contract blob differs between edge and origin commits |
| `EDGE_PRIVACY_PAGE_NOT_CUTOVER`, `EDGE_PRIVACY_PAGE_PREMATURE` | Typed deploy | The marker is missing in gcp mode, or present before it |
| `PRODUCTION_CANDIDATE_RECEIPT_STALE`, `PRODUCTION_CANDIDATE_RECEIPT_MISMATCH`, `PRODUCTION_CANDIDATE_RECEIPT_INVALID` | H.6 | The web-release receipt is not for the checked-out switch commit and the live fenced commit, names another manifest, or no longer passes the lane's checks. Prepare a fresh receipt |
| `PRODUCTION_CANDIDATE_SITE_RETAINED_PIN_CONFLICT`, `PRODUCTION_CANDIDATE_SITE_EDGE_MODE_REQUIRED`, `PRODUCTION_CANDIDATE_SITE_FENCED`, `PRODUCTION_CANDIDATE_SITE_UNCHANGED` | Typed deploy | The site flags are mixed or incomplete. Nothing ran |
| `EDGE_MODE_REQUIRED_FOR_EDGE_LIVE` | Typed deploy | A typed deploy without `--edge-mode` over a live edge, including `product:web-release:deploy` with typed pins. Name the live mode |
| `WRITER_UNACCOUNTED`, `SCHEDULE_DRIFT` | EP-8 inventory, plan, apply | A script outside the plan binds a listed database or bucket, or a fenced script's crons differ from the plan. At H.1 this is free; at `apply` the edge is already fenced |
| `FENCE_INVENTORY_CHANGED` | EP-8 apply, verify | The fenced surface differs from the plan receipt's fingerprint. Rerun inventory and plan, then use the new receipt |
| `FENCE_WINDOW_TOO_SHORT`, `FENCE_WINDOW_TOO_EARLY` | EP-8 verify | Run too soon: wait until `appliedAt` + 2 x the quiet window + 5 minutes (35 minutes at the minimum), or fix the `--window-start` |
| `FENCE_NOT_QUIESCENT` | EP-8 verify | A D1 bookmark or the quarantine digest moved inside the window: something wrote after the fence. Find the writer; do not shorten the window |
| `CUTOVER_SOURCE_BOOKMARK_DRIFT`, `CUTOVER_SOURCE_CHANGED_AFTER_SEAL` | Seal, flip evidence | A source changed after the fence. The seal is void |
| `CUTOVER_ERASED_PARTICIPANT_PRESENT`, `CUTOVER_PARTICIPANT_ERASURE_PENDING` | Seal, PT-3 | An erased or mid-erasure participant is in the sealed set. Finish the erasure on Cloudflare and re-seal |
| `CUTOVER_IDENTITY_LINK_SECRET_MISMATCH` | PT-3 | The origin's identity-link secret does not match the sealed pin. Do not rotate it to make the import pass |
| `CUTOVER_RUN_NOT_VERIFIED`, `CUTOVER_CONTROLS_DIGEST_MISMATCH` | Finalize | The run is not `verified`, or the controls do not equal the sealed row |
| `MUTATION_BARRIER_ACTIVE` | Edge | Expected while fenced. Not an error |

## Open gaps in tooling and decisions

Status is as of the line at `c80f99b9` and the checklist on 2026-10-02. The
C-IPR, C-ADMIN and C-REFRESH rows were re-marked when this draft merged into
the line after `95c158ba`, and the E-QUIESCE row when E-QUIESCE merged after
`ebb9304d`.

| Gap | Affects | State |
|---|---|---|
| Verifier smoke command | H.1, H.5 | `in build` (verifier tooling) |
| Production host composition, first-roll ready path, `HOST_ORIGIN` check | Preconditions, H.5 | `not built` (D-CRB); the origin refuses to start in production until it lands |
| Telemetry importer production modes | H.4 | `not built` (D-PT5A) |
| Import orchestrator and finalize sequencing | H.4 | `not built` (E-PT8) |
| Read-only pre-fence quiescence query | H.1 | `built` (E-QUIESCE); not yet run against the provider |
| Frozen public read: export format, loader, retirement | H.3, H.4, H.8 | `built` (C-IPR), with migration `0065` promoted to primary at the C-SIMP-RECON merge; dropping the stored row is `not built` |
| Admin routes at the origin | H.7 | Route modules `built` (C-ADMIN); registration in the host `not built` (D-CRB); the overview answers 503 until its sources exist (E-ADMIN) |
| Refresh job production contract | H.8 | `built` (C-REFRESH) |
| Maintenance job and trigger in the desired state | H.4 | `not built` (D-OPS4) |
| Scheduler pause-all and resume-all | H.4, H.8 | `not built` (D-OPS3) |
| Monitoring and alerting, origin-lock check | H.7 | `not built` (E-OPS5) |
| Barrier proof producer, edge live capture producer | H.2, rollout | No command writes either file |
| R2 to Cloud Storage copy | After | `not built` (PT-7) |
| Observation duration and brake thresholds | H.7 | Owner decision, not recorded |

## Evidence boundary

This is a draft runbook, not a deployment receipt or a readiness claim. A
source review does not prove a live service. Source merge, CI, local
synthetic checks, the staging rehearsal, the dress rehearsal, the production
cutover and public deployment are separate gates, and this document proves
none of them.
