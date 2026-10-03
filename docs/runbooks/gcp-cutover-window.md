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
| Route decisions | OWN-2, OWN-3, E-PORTS, ROUTES-R12 | Decided in round 12 (2026-10-02) and built in the registry (`cloud-run/postgres-production-registry.mjs`): legacy enroll, Google and Apple sign-in, security reset, participant export, the performance device and consent routes and v0.x uploads are retired and answer `503 POSTGRES_ROUTE_NOT_PORTED` with no `retry-after`; the accountless performance authorization answers production's definite `403 TELEMETRY_TRANSPORT_BLOCKED`; credential renew, disconnect and the OD-CR-1 session-authority routes stay ported |
| Origin code | C-SIMP, C-ADMIN, C-MAINT, C-REFRESH, D-CRB, D-PT5A, D-OPS3, D-OPS4, D-BLOB, E-PT8 | Merged on the deploy line and green. The status of each at the time of writing is in [open gaps](#open-gaps-in-tooling-and-decisions) |
| Estate | PROD-1, OWN-5, OWN-5b, OWN-5c, OPS2-READ | The OPS-2 plan was applied by the owner and its readback reads clean. The first live readback parsed correctly on the test project |
| Secrets | PROD-2, OWN-6, OWN-6b | Secret Manager is populated and the envelope keys are identical. `IDENTITY_LINK_SECRET` is the newly generated version the desired state mounts: the production value is lost, so the cutover rotates the pin ([identity-link rotation](#identity-link-rotation-round-16)). Nobody has written a new value into the Cloudflare Worker's `IDENTITY_LINK_SECRET`. The Cloudflare edge secrets are in place and the typed baseline was recaptured after each put |
| Origin pre-staged | PROD-3 | The origin migrated to the tail and rolled ([rollout](./gcp-rollout.md)). A maintenance pass ran. The verifier smoke reads ready. An unauthenticated request to the Cloud Run URL gets Google's 403 |
| Scheduler | PROD-4, E-OPS5 | Triggers exist and are paused, with the cadence from the refresh measurements. `node scripts/gcp-infra.mjs readback --require-clean --require-cadence --environment=production` exits 0: without `--require-cadence`, a production estate whose cadence was never committed reads clean, has no trigger, and raises no refresh alert (those wait on the cadence), so this flag is the mechanical guard against it. The paused-too-long alert (`scheduler-quiet`, a log-absence proxy of about 25 h for a daily trigger, accepted in round 11 with no probe job) has a notification target; the probe stays operator-run |
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
| Flip evidence | Re-read just before the flip. Any drift fails `CUTOVER_SOURCE_CHANGED_AFTER_SEAL`; the analytics D1's bookmark, read before and after the sealed sources, must equal the fence receipt's analytics pin, else `CUTOVER_ANALYTICS_CHANGED_AFTER_FENCE` |
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
   opaque references only. D1 refuses a compound SELECT of 18 or 19 arms
   ("too many terms in compound SELECT", 7500) and accepts 5 (provider check
   2026-10-02), so each role's statement is printed in parts of at most five
   arms: `ingestion` 4 parts, `deletion-ledger` 1, `analytics` 2. From
   `apps/worker`, run each part through a read-only
   `wrangler d1 execute <database> --remote --json --command "<part>"` with
   the owner's read-only credentials in the environment, save each output
   privately, merge each role's parts into one array, and evaluate (the
   script's header has the exact commands):

   ```bash
   node scripts/cutover-quiescence-check.mjs queries --role ingestion --sql --part 1
   jq -s add <ingestion part 1> <part 2> <part 3> <part 4> > <private ingestion result>
   node scripts/cutover-quiescence-check.mjs evaluate --phase pre-fence --ingestion-result <private file> --ledger-result <private file> --analytics-result <private file>
   ```

   `evaluate` requires every fact exactly once across the merged parts, so a
   missing or repeated part is refused. Parts read separate snapshots: on a
   live source, a `QUIESCENCE_FACT_INCONSISTENT` refusal means a related fact
   moved between two parts; rerun. `evaluate` cannot hash, so its best result
   is exit 3 with only `deletion-digest-intersection` not evaluated; `check`
   on exported D1 files answers the intersection. Exit 2 (`blocked`): finish
   the erasure on Cloudflare and rerun; there is no override. The provider
   check of 2026-10-02 ran hand-cut parts of the earlier single statements and
   merged them (`evaluate` read them: exit 3, nothing blocked); the printed
   five-arm parts themselves have not yet been run against the provider.
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

   The inventory selects each source's ledger layout. Production ingestion was
   restored from a generated base, so its entry must say
   `"layout": "ingestion-restore-base-v1"` with all six ingestion directories
   under `d1_storage_migrations` (in role order) and no `d1_migrations`. That
   layout expects exactly the restore-era ledger: one `0001_restore_base.sql`
   row with the pinned digest `396753809b96…`, plus every ingestion file at P
   that the base did not fold (at `d43c8f92`, 13 rows in all). The folded list
   is recomputed from Git objects at the base generator commit `8da57e76` and
   must match the qualification's role-input digest; a folded file edited or
   removed at P refuses as `CUTOVER_EXPECTED_LEDGER_INVALID`. Without a layout
   the source uses the fresh chain (every file, one row each), which refuses
   the live ingestion ledger. The deletion-ledger entry keeps the fresh chain
   under `d1_migrations`. Provenance:
   [the restore-base receipt](../receipts/2026-10-02-gcp-int-c-seal-restore-base.md).
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
   the analytics D1 is never sealed, because analytics history is recomputed.
   Its admin metric snapshots are the one exception, read in step 6.

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
6. **Export the admin metric history from the analytics D1.** Production runs
   typed storage (the live Worker binds `ANALYTICS_DB`, and that D1 carries the
   typed storage ledger), which since the 2026-09-12 D1 migration captures the
   hourly admin gauge snapshots only in the analytics D1
   (`analytics_admin_metric_snapshots`); the sealed ingestion table stops at
   the switch. The import maps both, so the admin charts continue without a
   gap (round 5). This is one bounded, read-only export, not a seal. The
   owner's private analytics source file (`0600`, schema
   `tibotattle-cutover-analytics-source-v1`: `binding` `ANALYTICS_DB`,
   `databaseName`, `databaseId`) must name the D1 that the EP-8 fence receipt
   records as `analytics`:

   ```bash
   node scripts/cutover-admin-history-export.mjs export --inventory <private seal inventory> \
     --seal <seal manifest> --seal-id <sealId> --analytics-source <private analytics source file> \
     --fence-receipt <EP-8 verify receipt> --out <private owner directory> --execute --remote --owner-read-only
   ```

   Without `--execute --remote --owner-read-only` it is a dry run that spawns
   nothing. Both bookmarks it reads must equal the fence receipt's analytics
   bookmark. It checks the `0016_admin_metrics_history.sql` ledger row against
   Git at P, reads every snapshot of the sealed source id in pages, and writes
   `admin-history-export.json` (`0400`, never overwritten). It prints the
   export's sha256, the snapshot count, the first and last capture instants and
   the row count of any other source id; no id. The post-import step of H.4
   requires the file and its sha256. `built` (D-PT4X); the provider has never
   been contacted.
7. **Capture the revision floor from the analytics D1 (round 14).** GCP's
   community daily publications must continue above the revisions Cloudflare
   published: each day continues at Cloudflare's last revision plus one, and a
   day Cloudflare never published starts at r1. The floor comes from the
   current analytics D1 lineage only. It is one read-only, bookmark-bracketed
   SELECT, run after the EP-8 verify (the fence is quiet) and after the seal,
   with the same private analytics source file as step 6:

   ```bash
   node scripts/cutover-revision-floor.mjs capture --inventory <private seal inventory> \
     --seal <seal manifest> --seal-id <sealId> --analytics-source <private analytics source file> \
     --fence-receipt <EP-8 verify receipt> --out <private owner directory> --execute --remote --owner-read-only
   ```

   Without `--execute --remote --owner-read-only` it is a dry run that spawns
   nothing. It reads as the non-sealable read role `analytics-floor`, which the
   guarded transport admits for exactly one statement pinned by its sha256
   (`CUTOVER_REVISION_FLOOR_STATEMENT` in `cutover-source-seal.mjs`: the
   largest revision per day over `analytics_community_daily_heads` and
   `analytics_community_daily_publications`, every source id, withheld days
   included). Both bookmarks it reads must equal the fence receipt's analytics
   bookmark. It writes `revision-floor.json` (`0400`, never overwritten:
   schema `tibotattle-cutover-revision-floor-v1`, days and integers, the seal
   id, the fence receipt's sha256, the source commit and the sha256 of the
   bookmark) and prints the file's sha256 (the `floorSha256` the inputs pin),
   the day count, the largest revision and the first and last day; never the
   bookmark, a database id or a source id. Re-validate it offline, as P16
   will:

   ```bash
   node scripts/cutover-revision-floor.mjs check --floor <file> --sha256 <hex> \
     --seal <manifest> --seal-id <sealId> --fence-receipt <EP-8 verify receipt>
   ```

   The check reads the fence receipt at the digest the seal pins (a released
   fence is `CUTOVER_FENCE_RECEIPT_INVALID`) and refuses a captured floor
   whose capture block names another analytics D1 or bookmark with P16's
   code, `REVISION_FLOOR_CAPTURE_FENCE_MISMATCH`, and a synthetic floor with
   `REVISION_FLOOR_PROVENANCE_REFUSED` unless the dress rehearsal adds
   `--dress-rehearsal-synthetic-revision-floor` (which in turn refuses a
   captured floor). It prints `fenceBound: true` for a captured floor. It does
   not compare the floor with the frozen export; P16 still does
   (`REVISION_FLOOR_BELOW_FROZEN_EXPORT`). `built` (REV-SEED, R19 hardening
   (b)); the provider has never been contacted. The dress rehearsal does not capture: it loads a synthetic floor
   (round 14), written by `cutover-revision-floor.mjs synthetic` from its seal
   and its frozen export (each frozen day at its frozen revision), and its
   `pt8-inputs.json` declares the owner flag
   `dress-rehearsal-synthetic-revision-floor`. A synthetic floor covers only
   the frozen export's days, at revisions read before the fence, so P16
   refuses one without that flag, and refuses the flag with a captured
   floor: the window's inputs never carry it. If the capture refuses, capture
   again inside a quiet fence; a synthetic floor is never a substitute.

Refusals to plan for: `CUTOVER_SOURCE_BOOKMARK_DRIFT` (a write reached a D1
after the fence; for the revision floor, Cloudflare could have published after
the capture, so the floor is void), `CUTOVER_LEDGER_MISMATCH` or `CUTOVER_SCHEMA_MISMATCH`
(production's applied tail differs from the expected ledger at P, see the
renumbering gate, or the inventory selects the wrong ledger layout),
`CUTOVER_SECRET_IN_OUTPUT`, `CUTOVER_OWNER_DIRECTORY_UNSAFE`.
Each is content-free and leaves nothing behind. A bookmark drift means the
fence was not quiet: abort and fence again. The admin history export adds
`CUTOVER_FENCE_SOURCE_MISMATCH` (the analytics source file names another D1)
and `CUTOVER_ADMIN_HISTORY_VALUE_INVALID` (a stored snapshot outside the
d43c8f92 gauge grammar); neither touches the seal. The revision floor adds
`CUTOVER_FLOOR_STATEMENT_REFUSED` (any statement but the pinned one on the
floor role), `REVISION_FLOOR_EMPTY` (no published day), `REVISION_FLOOR_TOO_LARGE`
(over 4,000 days), `REVISION_FLOOR_DAY_INVALID` and
`REVISION_FLOOR_REVISION_INVALID` (a day or revision outside the closed
format); each leaves nothing behind and none touches the seal.

Evidence kept: the seal manifest and its sha256, the projection sha256 values,
the frozen export's digest, the admin history export's sha256, the revision
floor's sha256. Abort: Abort A.
The seal is lost and a later attempt needs a fresh fence.

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

The PT-8-lite orchestrator (E-PT8,
`apps/worker/scripts/postgres-production-transfer.mjs`, `S` below) sequences
every step of H.4. It is `built` and proven only on a synthetic seal against a
local PostgreSQL 17 target; it has not run against a real seal or a Cloud SQL
target. Its reference, including the owner directory, the authorization
tokens and every refusal, is [the orchestrator section](#h4-reference-the-pt-8-lite-orchestrator).

1. **Preflight (read-only).** `node $S preflight --owner-dir <dir> <connection>`
   runs P1 to P16 and prints `GO` with the `run` authorization token, or a
   closed refusal code. Among them: one disposition per sealed table (P3), the
   correction runtime staged with no facts (P4,
   `CUTOVER_CORRECTION_RUNTIME_ACTIVE`), erasure quiescence (P5), the
   deletion-digest exclusion count (P6), the public-source bootstrap at
   `completed=1` (P7), the identity pin (P8: the sealed fingerprint, and the
   secret and numeric version that the committed production desired state
   mounts; under round 16's rotation, P8-R instead, see
   [identity-link rotation](#identity-link-rotation-round-16)), no privilege
   on the transfer control schema for any role but its owner, `PUBLIC`
   included (P10), the scheduler probe (P11: the desired
   state's project, exactly the triggers its `scheduler` map manages, all
   paused, no alert, under 6 hours old), and the H.3 step 6 admin history
   export, read at its recorded sha256 and bound to this seal, inventory,
   fence receipt and sealed source (P15), and the H.3 step 7 revision floor,
   read at its recorded sha256, bound to this seal, fence receipt and source
   commit, captured inside this fence (its capture block names the analytics
   D1 and the sha256 of the bookmark that the fence receipt, read at the
   seal's pin, records; only the dress rehearsal loads a synthetic floor,
   under its owner flag), and at or above every revision the frozen read
   serves (P16).
2. **Import (protected).** `node $S run --owner-dir <dir> <connection>` is a dry
   run that prints the plan and the token; add `--execute --confirm <token>`.
   With a declared identity-link rotation it prints a second token, and the
   run also needs `--confirm-identity-rotation <token>`.
   It runs the stages in dependency order: PT-3 `identity-authority`,
   `identity-link-rotation` (a recorded no-op without a rotation), D-PT4X
   `legacy-contributions`, the eight D-PT5A stages, the waivers
   (`performance` under the owner flag `performance-routes-retired`,
   `accountless-retention` while its sealed table is empty, `objects` until
   PT-7, `analytics-expectation` and `analytics-history` because analytics is
   recomputed), D-PT4X `pending-registrations`, `owner-lifecycle-verify`,
   REV-SEED's `analytics-community-history` (round 14: it loads the H.3 step 7
   revision floor, once, before `markLive`; see
   [the orchestrator section](#h4-reference-the-pt-8-lite-orchestrator)) and
   `post-import`.
   Post-import restarts the typed identities (TL-1), maps the admin metric
   history (the sealed snapshots and cache, and the H.3 step 6 analytics D1
   export named in `pt8-inputs.json`) and the aggregate exclusions (D-PT4X),
   checks the invariants,
   finalizes coverage, runs the parity sample, **loads the frozen public read**
   (C-IPR) and **drops the staging relations**. Then the run moves to
   `verifying` and `verified`. A killed `run` is rerun with the same token.
   Before any write, every `run --execute` that has not reached `verified`
   proves P11 and P10's memberships again. If a resumed run starts more than
   6 hours after the probe, replace the probe receipt at the same path with a
   fresh one first.
3. **Finalize to live, in this order.** PT-1 admits the staging drop only
   before `verified`, and refuses every write once a run is live, so the drop
   and the frozen-read load happen inside step 2; the flip gate reads both
   back.
   - Owner: prove the sealed sources are unchanged after `verified`, into a
     fresh directory `flip-1`:

     ```bash
     node scripts/cutover-source-fence.mjs verify-unchanged --inventory <private seal inventory> \
       --seal <seal manifest> --seal-id <sealId> --analytics-source <private analytics source file> \
       --fence-receipt <EP-8 verify receipt> --out <owner dir>/flip-1 --execute --remote --owner-read-only
     ```

     The analytics source file is H.3 step 6's (the same file the floor
     capture read); it must name the D1 the fence receipt records (read at the
     seal's pin) and no sealed D1 (`CUTOVER_FENCE_SOURCE_MISMATCH`,
     `CUTOVER_SOURCE_NOT_ALLOWED`, before any remote read). Read-only and
     bookmark-bracketed like the capture: through the non-sealable role
     `analytics-bookmark`, which admits no statement at all
     (`CUTOVER_BOOKMARK_ROLE_QUERY_REFUSED`), it reads the analytics D1's
     bookmark before the first sealed read and again after the last, and both
     must equal the fence receipt's analytics pin, the bookmark the revision
     floor's capture started from. It writes `flip-evidence.json` (`0400`,
     never overwritten; schema `tibotattle-cutover-flip-evidence-v2`, which
     adds the analytics D1's id digest and re-read bookmark) or fails
     `CUTOVER_SOURCE_CHANGED_AFTER_SEAL` (a sealed source moved) or
     `CUTOVER_ANALYTICS_CHANGED_AFTER_FENCE` (Cloudflare published after the
     floor was captured, so the floor may be below its last revision). Either
     is a fence breach: abort. R19 hardening (c), REV-SEED design step 4.
   - `node $S release-controls --flip-evidence <flip-1>/flip-evidence.json`
     (protected) checks the evidence against the seal and its analytics entry
     against the fence receipt at `fenceReceiptPath`
     (`CUTOVER_FLIP_EVIDENCE_INVALID [check=analytics]`; `flip-gate` checks
     flip-2 the same way), then restores the sealed collection controls exactly. Without
     it, enrollment and publication stay disabled after the switch. It then
     reads the database clock once, after the restore commits, and records it
     as `releasedAt` in `release-controls.json`. A rerun keeps that instant.
   - Owner: `verify-unchanged` again, into `flip-2`, started only after
     `release-controls` has printed `executed`. Its `verifiedAt` must be later
     than `releasedAt`. Evidence taken between flip-1 and the release is
     refused (`CUTOVER_FLIP_EVIDENCE_STALE`).
   - `node $S flip-gate --flip-evidence <flip-2>/flip-evidence.json`
     (read-only) reads back the staging drop and the loaded frozen read, which
     must be the export post-import loaded (the `payloadSha256` in
     `post-import.json`, whose digest the post-import stage committed), runs
     `assertFlipReady` and checks that no sealed Sparkle nonce is unexpired. It
     writes `flip-gate.json` and prints the `mark-live` token.
   - `node $S mark-live --flip-evidence-sha256 <flip-2 sha256>` (protected).
   - **`markLive` is a one-way door for that target.** It locks the transfer
     control schema, the import handle only reads once a run is live, and the
     tooling contains no unlock. If the window aborts after it, the next
     attempt starts from a fresh seal and a new target; the owner and Claude
     decide whether that is a new database on the instance or a new instance.
4. **The frozen public read** is loaded by step 2 (before `markLive`), from the
   OWN-4 export and its recorded facts in `pt8-inputs.json`. Its `payloadSha256`
   is in `post-import.json` and `flip-gate.json`.
5. **Run a maintenance pass and resume the maintenance trigger.** Readiness
   goes stale 2 hours after the last pass, and an empty origin reads not ready
   until the first pass. Run one pass by hand until it reports complete, then
   `node $S post-live-check` (read-only on the target; it writes
   `post-live-check.json`, which carries no instant, so a later check is
   equal), then resume the maintenance trigger under
   [GCP scheduler resume](./gcp-scheduler-resume.md). The job is `built`
   (C-MAINT); its trigger is in the committed desired state, created paused at
   `* * * * *` (D-OPS4). After
   H.8, `node $S report` writes `pt8-report.json`. It refuses
   `CUTOVER_POST_LIVE_NOT_READY` until `post-live-check.json` exists.

Evidence kept: the run's stage and table receipts (counts, digests, states),
the owner directory's content-free receipts (`preflight.json`,
`post-import.json`, `release-controls.json`, `flip-gate.json`,
`mark-live.json`, `post-live-check.json`, `pt8-report.json`), the
flip-evidence sha256 and the
transfer run id. Abort: Abort A. The target database
is spent.

## H.4 reference: the PT-8-lite orchestrator

Design: `design/pt8-lite-design-2026-10-02.md` in the cutover workspace, with
the code-forced corrections of its section 1 applied. Round 13 holds: the
cutover runs on the proven full-recompute analytics engine, so the
orchestrator imports no analytics state, waives two analytics stages and loads
the revision floor in the third.
Round 12 holds: the native social chain is retired, and PT-3 still imports the
tables the kept session routes and credential renew and disconnect
authenticate against (pinned in `KEPT_SESSION_AUTHORITY_TABLES`); the retired
chain's short-lived handoff rows are imported verbatim and are inert. The
identity-link pin (`IDENTITY_LINK_PIN_TABLE`) is imported verbatim too, but no
kept route reads it: it is the continuity record that round 16's
[identity-link rotation](#identity-link-rotation-round-16) moves.

**The revision floor (round 14).** REV-SEED's per-day revision floor is loaded
inside this import, by the `analytics-community-history` stage, before
`markLive`: each day continues at Cloudflare's last published revision plus
one (round 12: no "revision restart"). The stage is a runner, no longer a
waiver, and the closed waiver map refuses `analytics-recomputed:d3` for it. It
reads `revision-floor.json` at the sha256 the inputs pin, re-checks P16 (this
seal, fence receipt and source commit; a capture block naming the fence
receipt's analytics D1 and bookmark, the receipt read again from
`fenceReceiptPath`, so a fence released since preflight refuses; a synthetic
floor only under the dress-rehearsal flag; every frozen-read revision at or
below the floor, else `REVISION_FLOOR_BELOW_FROZEN_EXPORT`), and in one
transaction with its stage receipt writes `analytics_v2_revision_floor` (one row per day)
and then `analytics_v2_revision_floor_source` (the singleton provenance:
`captured` or, at the dress rehearsal, `synthetic`). A rerun that finds the
identical floor writes nothing; any other floor is `REVISION_FLOOR_CONFLICT`,
and a target with a published day is `REVISION_FLOOR_PUBLICATION_EXISTS`. The
database enforces the same: both tables are immutable, refuse any insert once
a day is published, and a separate trigger refuses any published head at or
below its day's floor. The analytics D1 is never sealed, so the stage writes
no table receipt; its stage receipt (row count = days) digests the floor.
The tables' migration is primary
`0071_analytics_v2_revision_floor.sql` (promoted from its staged placeholder
`0951` at the REV-SEED merge into the fast-path final line); a target without
it fails P10 (`CUTOVER_TARGET_REVISION_FLOOR_TABLE_MISSING`). The production
refresh refuses `ANALYTICS_V2_REVISION_FLOOR_ABSENT` until this stage has run
(H.8).

**The seal is consumed, never produced.** The orchestrator reads a PT-2-lite
seal only through `readCutoverSeal` and `openSealedSourceFromSeal`
(`cutover-source-seal.mjs`), and the seal itself is taken at H.3 with that
module's CLI. A change to the seal's ingestion layout behind those exports
needs no orchestrator change, but the coverage gate (P3) refuses any sealed
table that has no reviewed disposition.

**Owner directory** (`0700`, outside the repository; files `0400` unless
stated). The owner writes `pt8-inputs.json` (schema
`tibotattle-pt8-lite-inputs-v1`, closed keys): `contractId`, `sealId`,
`sealManifestPath`, `expectedSourceCommit` (P), `fenceReceiptSha256`,
`fenceReceiptPath` (the EP-8 verify receipt itself, in its private receipts
directory beside its apply receipt; P16 and the floor stage read its
analytics entry at `fenceReceiptSha256`), `expectedIdentityKeyVersion`,
`deletionDigestProjection` (path and sha256, from
`cutover-source-projections.mjs deletion-digests`), `interimPublicRead` (the
OWN-4 export path and its recorded sha256, capture instant, source commit and
evidence date), `adminHistoryExport` (the path of H.3 step 6's
`admin-history-export.json` and the sha256 that step printed),
`revisionFloor` (the path of H.3 step 7's `revision-floor.json` and the
`floorSha256` that step printed; at the dress rehearsal, the synthetic
floor's), `schedulerEvidencePath` (a C-INFRA scheduler probe receipt
taken after the fence), `ownerFlags` (`performance-routes-retired`,
`accept-orphan-registration-clearing`, and at the dress rehearsal only
`dress-rehearsal-synthetic-revision-floor`) and `allowedRoleMembers`. The
orchestrator writes `identity-pin.json`, `preflight.json`, `post-import.json`,
`release-controls.json`, `flip-gate.json`, `mark-live.json`,
`post-live-check.json`, `pt8-report.json` and the advisory
`pt8-journal.ndjson` (`0600`). A receipt
is written once; a rerun that computes identical bytes reuses it and any other
result refuses `CUTOVER_RECEIPT_CONFLICT`. `post-import.json` is written before
the post-import stage commits. A rerun that finds the stage complete requires
the file and its digest (`CUTOVER_RECEIPT_CONFLICT` otherwise). A rerun of
`release-controls` must name the same flip-1 evidence. Every receipt is
content-free: names, counts, states and sha256 digests.

**Identity pin (owner only).** The deployed `IDENTITY_LINK_SECRET` is read from
standard input only, never from an argument or the environment:

```bash
gcloud secrets versions access <N> --secret=<identity-link secret id> | \
  node $S identity-pin --owner-dir <dir> --key-version <label> --secret-name <id> --secret-version <N>
```

The pin hashes the exact bytes on standard input, because the service hashes
the exact mounted bytes and never trims them. Input that ends in a line feed or
a carriage return is refused (`CUTOVER_IDENTITY_LINK_SECRET_INVALID`), never
stripped. That refusal means the version was probably stored with a trailing
newline (for example through `echo … |`), and the service would load it with
the newline and compute another fingerprint than the sealed one. Do not strip
it by hand: add a version without the newline (`printf '%s'`), pin the
desired state's mount to that version, and take the pin again from it. A
secret shorter than 32 characters and a version of `latest` are refused.
`--secret-name` and `--secret-version` must equal the `IDENTITY_LINK_SECRET`
entry of the committed production desired state
(`apps/worker/cloud-run/infra/production.desired-state.json`), which is the
secret the service template mounts. Preflight P8 refuses while that entry has
no numeric version (`CUTOVER_IDENTITY_LINK_MOUNT_UNPINNED`). Pin the version
in the desired state (owner) before the pin is taken. P8 also refuses a pin of
another secret or version (`CUTOVER_IDENTITY_LINK_MOUNT_MISMATCH`). The key
version label (`expectedIdentityKeyVersion`) still comes from `pt8-inputs.json`.
The pin is a keyed digest: keep it in the owner directory only. The production
secret is lost, so this cutover takes the pin with `identity-rotate-pin`
instead ([identity-link rotation](#identity-link-rotation-round-16)), which
writes the same pin document for the new secret.

**Connection.** Every database subcommand takes `--pg-socket <dir> --pg-port
<n> --pg-user <transfer IAM user> --pg-database <db>`: a Unix socket directory
owned by the operator with no group or other bits, such as a Cloud SQL Auth
Proxy started with `--auto-iam-authn` and `--unix-socket`. TCP hosts are
refused. The transfer login must reach the schema owner and
`tibotattle_source_transfer` by `SET` only, never by inheritance (P10). That
identity is not provisioned yet (PT8-I).

**Dry run and tokens.** `run`, `release-controls`, `mark-live` and `abandon` are
protected. Without `--execute` each performs only its read-only checks and
prints the exact token it requires. With `--execute`, it runs only when
`--confirm` equals that token (`CUTOVER_AUTHORIZATION_MISMATCH` otherwise,
before any write). A token is the sha256 of the step name, the seal id, the
contract, the inputs file and the step's own evidence (the preflight, the
flip-1 evidence and run id, or the flip gate and flip-2 evidence), so it
authorizes one step of one cutover.

**Order.** Each step refuses `CUTOVER_STEP_ORDER_VIOLATION` out of order:

| Step | Admitted when |
|---|---|
| `run` | `preflight.json` is GO for these inputs, and the run is absent, `preflight`, `importing`, `verifying` or `verified` (a no-op) |
| `release-controls` | The run is `verified`; the flip-1 evidence was taken after `verified_at` |
| `flip-gate` | The run is `verified`, `release-controls.json` exists, and the flip-2 evidence differs from flip-1 and its `verifiedAt` is later than the recorded `releasedAt` |
| `mark-live` | The flip gate passed for exactly this flip-2 sha256, or the run is already live with it (a readback) |
| `post-live-check`, `report` | The run is `live` |
| `abandon` | A run exists and is not `live` |

Inside `run`, each stage requires every earlier stage of the plan complete.
`run` holds the session advisory lock `tibotattle/production-transfer/v1`
(`CUTOVER_ORCHESTRATOR_BUSY`) and C-MAINT's shared migration fence
(`CUTOVER_MIGRATION_FENCE_HELD`) for its whole duration.

**Kill and resume.** Rerun the same command with the same token. The database
is authoritative: the run reopens for the same seal, complete stages are
skipped, the runners resume at their last committed page, every post-import
sub-step re-converges to equal receipts (the frozen read answers
`already-loaded`), and finished transitions are no-ops. The synthetic proof
kills the run after every committed step and compares every table receipt and
stage receipt with a clean run.

**Abort.** Before `markLive`: `abandon` (protected), then the fence release
of Abort A. The abandoned target is spent: any new seal needs a fresh,
migrated database (`CUTOVER_TARGET_NOT_EMPTY` otherwise). After `markLive`:
the target is final for this seal.

**Orchestrator refusals.** Preflight refuses before any target write:

| Code | Check | First action |
|---|---|---|
| `CUTOVER_SEAL_SOURCE_COMMIT_MISMATCH`, `CUTOVER_SEAL_FENCE_MISMATCH` | P1, P2 | The seal is not the one these inputs name. Fix the inputs or re-seal |
| `CUTOVER_COVERAGE_TABLE_UNKNOWN`, `CUTOVER_COVERAGE_TABLE_MISSING` | P3 | The sealed catalog differs from the reviewed dispositions. Re-derive the dispositions in code; never edit the seal |
| `CUTOVER_COVERAGE_NOT_EMPTY` | P3 | A must-be-empty table holds rows (for example retention markers: PT8-G is needed) |
| `CUTOVER_COVERAGE_DECISION_MISSING` | P3 | A non-empty table needs a recorded owner flag (`performance-routes-retired`) |
| `CUTOVER_CORRECTION_RUNTIME_ACTIVE` | P4 | The sealed usage-correction runtime is active or holds facts. Owner decision (OWN-3) |
| `CUTOVER_PARTICIPANT_ERASURE_PENDING`, `CUTOVER_OWNER_LINK_ERASED` | P3, P5 | An erasure is unfinished. Finish it on Cloudflare and re-seal |
| `CUTOVER_ERASED_PARTICIPANT_PRESENT`, `CUTOVER_PROJECTION_SEAL_MISMATCH` | P6 | A sealed participant matches a tombstone, or the projection is not this seal's |
| `CUTOVER_PUBLIC_SOURCE_BOOTSTRAP_INCOMPLETE` | P7 | The sealed bootstrap is not complete |
| `CUTOVER_IDENTITY_LINK_SECRET_MISMATCH`, `CUTOVER_IDENTITY_LINK_VERSION_MISMATCH` | P8, P8-R | The pin differs from the sealed row or the deployed label. Under round 16 the only rotation is the recorded [identity-link rotation](#identity-link-rotation-round-16); never edit a pin or a row to pass |
| `CUTOVER_IDENTITY_ROTATION_INVALID`, `CUTOVER_IDENTITY_ROTATION_SOURCE_MISMATCH`, `CUTOVER_IDENTITY_ROTATION_PIN_MISMATCH` | P8-R | The rotation document does not hash to the inputs' digest or is malformed, its `from` is not the sealed row, or the pin is not its `to`. Recompute it with `identity-rotate-pin` |
| `CUTOVER_IDENTITY_LINK_VERSION_MISMATCH` | P8-R, `identity-rotate-pin` | Under a rotation the labels are the origin's, not inputs: `to`, the pin and `expectedIdentityKeyVersion` must be `PRODUCTION_IDENTITY_LINK_SECRET_VERSION` (`production-v2`) and `from` one of `PRODUCTION_RETIRED_IDENTITY_LINK_VERSIONS` (`production-v1`), from `postgres-production-configuration.mjs`. Every step that reads the rotation re-checks this |
| `CUTOVER_IDENTITY_ROTATION_SOURCE_UNREADABLE` | `identity-rotate-pin` | The sealed-pin file is not a private regular file: group or other permission bits (a plain redirect under umask 022 is `0644`), another owner, a second link, a symlink in its path, empty, over 64 KiB or absent. Recreate it under `umask 077` (step 1) |
| `CUTOVER_IDENTITY_ROTATION_CONSUMER_PORTED` | P8-R | A route that reads the identity-link pin, link keys or cooldowns is classified other than `retired` in the registry. At preflight this is the registry classification only (every consumer is `retired`, which the default ported set excludes); the real ported set is refused at host boot (`IDENTITY_LINK_ROTATION_CONSUMER_PORTED`). A rotation is not admissible; stop |
| `CUTOVER_IDENTITY_LINK_MOUNT_UNPINNED`, `CUTOVER_IDENTITY_LINK_MOUNT_MISMATCH` | P8 | The committed production desired state mounts no numeric version, or the pin names another secret or version than the mount |
| `CUTOVER_DESIRED_STATE_INVALID` | P8, P11 | The committed production desired state is unreadable, still has a placeholder project, or its `scheduler` map is not a set of job names that includes `analytics-refresh` |
| `CUTOVER_CONTROLS_DEGRADE_IMPOSSIBLE` | P9 | The sealed controls admit no degraded form. Re-seal |
| `CUTOVER_TARGET_NOT_EMPTY`, `CUTOVER_TRANSFER_LOGIN_MEMBERSHIP_INVALID` (again at `run`), `CUTOVER_TARGET_FROZEN_READ_TABLE_MISSING` | P10 | The target is not the pre-staged empty database, the login's membership inherits, a role other than the owner (`PUBLIC` included) holds a privilege on the transfer control schema or anything in it (PT-1's flip-gate predicate), or the frozen-read table is absent or a published day exists |
| `CUTOVER_SCHEDULER_NOT_PAUSED` | P11 (again at `run`) | The probe does not name exactly the triggers the committed production desired state's `scheduler` map manages (`analytics-refresh`, and `maintenance` once C-INFRA manages it), all paused, for the desired state's project with no alert; or it predates the fence, is over 6 h old or has a non-strict instant |
| `CUTOVER_INTERIM_READ_FACTS_INVALID` and the C-IPR `INTERIM_PUBLIC_READ_*` codes | P12 | The OWN-4 export or its facts do not hold (captured after the fence, another commit, another day) |
| `CUTOVER_PENDING_OBJECT_GUARD_MISSING` | P13 | The transfer-hold guard is absent and no owner flag accepts that, or it is present but disabled or altered (no flag excuses that) |
| `CUTOVER_ADMIN_HISTORY_EXPORT_INVALID`, `CUTOVER_ADMIN_HISTORY_EXPORT_MISMATCH` | P15 (again at post-import) | The admin history export is unreadable, not private, or not at the recorded sha256; or it was taken for another seal, inventory, fence receipt or sealed source. Export again for this seal (H.3 step 6) and record its sha256 in the inputs |
| `REVISION_FLOOR_FILE_INVALID`, `REVISION_FLOOR_SEAL_MISMATCH` | P16 (again at the `analytics-community-history` stage) | The revision floor is unreadable, not private, not canonical or not at the recorded sha256; or it was captured for another seal, fence receipt or source commit. Capture again for this seal (H.3 step 7) |
| `REVISION_FLOOR_BELOW_FROZEN_EXPORT` | P16 (again at the stage) | A day of the frozen export has a revision above the floor (or no floor). The floor is not Cloudflare's maximum: never edit it; find why (the wrong analytics D1, or a capture outside the fence) and capture again |
| `REVISION_FLOOR_CAPTURE_FENCE_MISMATCH` | P16 (again at the stage) | The captured floor's capture block names another analytics D1 or another bookmark than the fence receipt the seal pins: it was taken outside this fence. Capture again for this seal and fence (H.3 step 7) |
| `REVISION_FLOOR_PROVENANCE_REFUSED` | P16 (again at the stage) | A synthetic floor without the owner flag `dress-rehearsal-synthetic-revision-floor`, or that flag with a captured floor. In the window, capture the floor; only the dress rehearsal declares the flag |
| `CUTOVER_FENCE_RECEIPT_INVALID` | P16 (again at the stage) | `fenceReceiptPath` is not the private fence receipt at `fenceReceiptSha256` beside its apply receipt, or that fence was released. Point the inputs at the EP-8 verify receipt; after a release, fence and seal again |
| `CUTOVER_TARGET_REVISION_FLOOR_TABLE_MISSING` | P10 | The target lacks the revision-floor migration. Migrate the target with the promoted chain |

During `run` and finalize: `CUTOVER_CORRECTION_OWNER_NOT_ACTIVE` (the
`usage-correction` stage: sealed correction history whose participant or owner
link is not `active`; D-PT5A refuses it before the stage touches the target),
`CUTOVER_OWNER_REVISIONS_DIVERGED`,
`CUTOVER_PUBLIC_SOURCE_OWNERS_DIVERGED`, `CUTOVER_PENDING_OBJECT_CONFLICT`,
`CUTOVER_RUNTIME_RESET_NOT_AT_SEED`, `CUTOVER_BOOTSTRAP_TARGET_INVALID`,
`CUTOVER_TYPED_IDENTITY_HEADROOM_INVALID`, `CUTOVER_COVERAGE_RECEIPT_MISSING`,
`CUTOVER_COVERAGE_RECEIPT_MISMATCH`, `CUTOVER_COVERAGE_RECEIPT_UNEXPECTED`,
`CUTOVER_PARITY_SAMPLE_MISMATCH` (with the class), `CUTOVER_FLIP_EVIDENCE_INVALID`
(with `check=analytics` when the evidence is v1 or its analytics entry is not
the fence receipt's analytics D1 and bookmark),
`CUTOVER_FLIP_EVIDENCE_STALE`, `CUTOVER_INTERIM_READ_NOT_LOADED` (the frozen
read is absent, or is not the export post-import loaded),
`CUTOVER_SPARKLE_NONCES_UNEXPIRED`, `REVISION_FLOOR_CONFLICT` and
`REVISION_FLOOR_PUBLICATION_EXISTS` (the `analytics-community-history` stage:
another floor is stored, or a day is already published),
`CUTOVER_POST_LIVE_NOT_READY` (also from
`report` before `post-live-check` has passed) and PT-1's own
codes (for example `CUTOVER_FLIP_ROLE_MEMBERS_UNEXPECTED`). Each is a NO-GO:
diagnose, never bypass. The design adds no override flag beyond the two named
owner flags.

### Identity-link rotation (round 16)

The production `IDENTITY_LINK_SECRET` is lost: Cloudflare Worker secrets are
write-only and the owner has no copy. The owner chose to rotate it at the
cutover (owner decisions 2026-10-02, round 16). That is admissible only
because round 12 retires every route that reads the pin, a provider
subject's link key or a re-enrolment cooldown digest
(`IDENTITY_LINK_CONSUMER_ROUTE_IDS` in `postgres-production-registry.mjs`:
enroll, Google and Apple sign-in, security reset and participant export). The
kept routes (session, logout, pairing and claim, devices and revoke, v1.2
consent, credential renew and disconnect) read none of them, so they keep
working and the 14 native social devices keep uploading until their 180-day
sunsets. The imported link keys stay in the database, inert: a key derived
under the new secret never equals an old one.

Preconditions (read-only):

- The committed production desired state mounts `IDENTITY_LINK_SECRET` at
  the numeric version that holds the new secret (version `1`; PROD-PREP owns
  that file).
- A boolean-only check confirms that version is 43 base64url characters with
  no trailing line feed or carriage return. If it fails, add a clean version
  and pin that one instead. The stdin reader refuses a trailing newline.
- Nobody writes a new value into the Cloudflare Worker's
  `IDENTITY_LINK_SECRET` before the switch. That would make every pin-gated
  Cloudflare route (enroll, Google and Apple sign-in and erasure) answer 503
  `IDENTITY_CONFIGURATION_INVALID` against the D1 pin. `wrangler.jsonc`
  keeps `production-v1`, which names that secret, until its deletion at P10.

Steps:

1. Read the D1 pin (read-only, approved in the window) into the owner
   directory. The subshell's `umask 077` creates the file `0600`; the
   `chmod` makes it `0400`:

   ```bash
   (umask 077; npx wrangler d1 execute <production ingestion D1> --remote --env production --json \
     --command "SELECT key_version, secret_fingerprint FROM identity_link_secret_configuration" \
     > <dir>/sealed-pin.json) && chmod 400 <dir>/sealed-pin.json
   ```

   It is a keyed digest: it stays in the owner directory, never the repository.
   `identity-rotate-pin` reads only a private file. A plain redirect under the
   usual umask leaves it `0644`, which refuses
   `CUTOVER_IDENTITY_ROTATION_SOURCE_UNREADABLE`, not the `from` mismatch.
2. Owner: compute the new pin and the rotation document. The new secret is
   read from standard input only:

   ```bash
   gcloud secrets versions access 1 --secret=IDENTITY_LINK_SECRET --project=<production project> | \
     node $S identity-rotate-pin --owner-dir <dir> --from-key-version production-v1 \
       --to-key-version production-v2 --secret-name IDENTITY_LINK_SECRET --secret-version 1 \
       --sealed-pin-file <dir>/sealed-pin.json
   ```

   The labels are not free: `--to-key-version` must be the label the origin
   runs and `--from-key-version` a retired production label (both from
   `postgres-production-configuration.mjs`), and the sealed-pin file must carry
   `--from-key-version`. Each is refused before the secret is read
   (`CUTOVER_IDENTITY_LINK_VERSION_MISMATCH`,
   `CUTOVER_IDENTITY_ROTATION_SOURCE_MISMATCH`).
   It writes `identity-pin.json` (the new secret, labelled `production-v2`)
   and `identity-rotation.json` (`tibotattle-identity-link-rotation-v1`: the
   sealed `from`, the new `to` with its secret name and version, the reason
   `secret-lost`, the decision and the retired consumer routes), each `0400`
   and written once. It prints only the labels, the version number and the
   two files' sha256.
3. In `pt8-inputs.json`, set `expectedIdentityKeyVersion` to `production-v2`
   and add `"identityLinkRotation": { "rotationSha256": "<printed rotationSha256>" }`.
4. Preflight runs P8-R instead of P8: the document must hash to
   `rotationSha256` (`CUTOVER_IDENTITY_ROTATION_INVALID`); `to`, the pin and
   `expectedIdentityKeyVersion` must be the origin's label and `from` a
   retired production label (`CUTOVER_IDENTITY_LINK_VERSION_MISMATCH`; any
   other well-formed label, `production-v3` or `staging-v1` included, is
   refused even when the documents agree on it); `from` must be the sealed
   row exactly (`CUTOVER_IDENTITY_ROTATION_SOURCE_MISMATCH`), the pin must be
   `to` (`CUTOVER_IDENTITY_ROTATION_PIN_MISMATCH`), and the pin must name the
   desired state's mount (P8's mount codes). The consumer refusal
   (`CUTOVER_IDENTITY_ROTATION_CONSUMER_PORTED`) at preflight checks the
   registry classification: every identity-link consumer must be `retired`.
   It cannot see the TypeScript ported set; the host's boot refusal below
   covers that. GO prints
   `identityRotationAuthorizationToken` beside the run token. It is bound to
   the seal, the contract, the inputs, the preflight, the rotation document,
   both labels and the secret version.
5. `run --execute --confirm <run token> --confirm-identity-rotation <rotation token>`.
   Without the exact second token the run refuses `CUTOVER_AUTHORIZATION_MISMATCH`
   (step `identity-rotation`) before any write: a run token alone never
   rotates. PT-3 still copies the sealed pin row verbatim, asserting
   `sealed == from`. The next stage, `identity-link-rotation`, moves that one
   row from `from` to `to` in one transaction and records a checkpoint and a
   stage receipt. A rerun after a crash finds `to` with this rotation's
   checkpoint and writes nothing; any other state refuses
   `CUTOVER_IDENTITY_ROTATION_STATE_INVALID`.
6. Post-import, the flip gate and the post-live check each re-assert that the
   target pin is `to` and that the rotation's checkpoint and receipt are
   complete for this run. `pt8-report.json` adds the rotation document's
   sha256. A new run (after an abandon and a fresh seal) re-presents the same
   rotation document, and the new seal must still show the unchanged D1 pin
   as `from`.

Without `identityLinkRotation`, P8 is unchanged and the new secret's pin is
refused (`CUTOVER_IDENTITY_LINK_SECRET_MISMATCH`). Never edit the sealed row,
the target row or the pin by hand to make a check pass. Under the rotated
label the production host also refuses to compose if any identity-link
consumer is in its real ported set (`IDENTITY_LINK_ROTATION_CONSUMER_PORTED`).
The origin still keys its rate-limit subjects (client address and upload
principal) with the new secret; those keys last one 60-second window and carry
no continuity, so the rotation does not affect them. Prior Google and
Apple links cannot be re-established; any future social sign-in starts a new
identity namespace.

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
  `site.manifestSha256`; it is the candidate manifest. Prepare it on the
  edge-port line that deploys it: the lane's allowlist and the staged asset
  set differ from this line's, so a receipt or generated site prepared here
  can fail there.
- The live site's pins from H.2 (its source sha and the live manifest
  sha256); they become the replaced pair. The source sha is the commit PROD-5
  pinned with `--retained-public-source`: the deploy proves it is on the live
  line and produced the live manifest
  (`PRODUCTION_REPLACED_PUBLIC_SOURCE_NOT_ON_LIVE_LINE`,
  `PRODUCTION_REPLACED_PUBLIC_SOURCE_UNPROVEN`).
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
live manifest against the replaced pin before the upload, proves the replaced
source produced it, stages exactly the candidate manifest built from the
switch commit, and requires the candidate live after it. Leave this deploy's
operation journal, receipt and generated site in place until they are
archived (below): the archived journal is the evidence a later website
rollback to the switch's site names. The retained pair (`--retained-public-source`,
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
- Archive the switch release, once the deploy reports `verified`, from
  `apps/worker` on the switch checkout. The tool is on the edge-port and
  fast-path lines since round 15, tested locally with synthetic data and never
  run against a live release. It writes nothing remote:

  ```bash
  npm run production:release-archive -- \
    --operation <absolute operation directory of the H.6 deploy> \
    --web-release-receipt <absolute path of the switch checkout's .release-build/web-release-receipt.json> \
    --archive /absolute/owner-private/release-archive
  ```

  It refuses a journal that is not a verified typed production deploy, and a
  receipt or site that is not the one the journal left live. It writes
  `<archive>/<journal identityDigest>/` with the journal, receipt, site and a
  content-free index, and never overwrites; a rerun prints
  `PRODUCTION_RELEASE_ALREADY_ARCHIVED`. Record the printed
  `journalIdentityDigest`. See
  [Archive the release](./2026-08-17-web-only-release.md#5-archive-the-release).

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
- The admin overview. The composition opens the admin host behind the Access
  chokepoint (ADMIN-R12). The overview is `admin-overview-v0.6`, whose
  synthetic-contribution counts, historical publication and deletion-ledger
  blocks answer `{"status":"unavailable"}` until their sources exist
  (E-ADMIN). The console reads it once the edge serves the admin client that
  accepts overview v0.6 and database health v0.2 (E-EDGEPORT); until then the
  deployed client fails closed on both and its controls stay disabled.

The duration of the observation and the thresholds that justify the brake are
owner decisions that are not recorded yet. The brake is gcp to fenced
(OWN-10), then fix forward.

## H.8 Analytics cold build

Authorization: the first manual run of the refresh job, and the scheduler
resume. `owner`.

1. Run the analytics-refresh job once, by hand, with the trigger still
   paused, and wait for it. Read its content-free receipt line. `ok` with state
   `LOCK_HELD` means another run held the lock and nothing was written; that is
   not a build. Success needs a completed run. Its `revisionFloor` must read
   `present: true` with the day count and largest revision H.3 step 7 printed:
   every republished day continues above Cloudflare's last revision. A
   production run with no floor loaded refuses
   `ANALYTICS_V2_REVISION_FLOOR_ABSENT` before reading anything and writes
   nothing (the H.4 import has not run its `analytics-community-history`
   stage); staging and test targets publish from r1 without one. Before that
   check, a production FIRST run (no completed run row, or no recorded
   journal cursor) with neither the frozen interim read nor the floor loaded
   refuses `ANALYTICS_V2_FIRST_RUN_BASELINE_ABSENT`, also before any read and
   writing nothing: it would otherwise record every day's first owner set
   without any record of Cloudflare's published history (R19 hardening (d),
   in addition to the flip gate's `CUTOVER_INTERIM_READ_NOT_LOADED`). The
   receipt's `baseline` reads `{firstRun, frozenInterimRead}`; this first
   manual run must show `firstRun: true` and `frozenInterimRead: true`.
   Staging and test targets, with or without a synthetic floor, are not
   gated. The production contract of the
   job (bounded history loading, output accounting, a time guard) is `built`
   (C-REFRESH); the measured dense run took 66 minutes on a test seed, and the
   production figure is unmeasured.
2. Confirm the first Google Cloud publication: `GET /api/v1/community/daily`
   serves origin-computed days. In the receipt line, `ownerSets` must show
   `bootstrapAdoptedDays: []`: every day's saved owner set was recorded at its
   first publication, never adopted from an earlier head (see below).
3. Retire the frozen interim read. `built` (C-IPR): the route stops reading
   the frozen export as soon as any day is published and cannot return to it.
   The stored row is kept, inert (owner decision round 12, OWN-18); only the
   OWN-4 export file is deleted, 90 days after the seal. The refresh job still
   reads the row to compare a frozen-window day's first recorded owner set
   with Cloudflare's count (E-OWNERSET). Once a receipt has recorded the
   window, a run that would first record a day inside it without the row
   refuses with `ANALYTICS_V2_SOURCE_UNAVAILABLE` instead of recording the day
   as outside the window.
4. Resume the analytics-refresh trigger under
   [GCP scheduler resume](./gcp-scheduler-resume.md), at the cadence set from
   the measurements. Then set its committed state to `ENABLED`. Tooling:
   explicit pause-all and resume-all are `not built` (D-OPS3).

Recomputed history can differ from what Cloudflare published, and past
contributions stay in recomputed history. These are accepted differences and
are disclosed on the privacy page (E-OPS9); they are not defects of the cold
build. Published revisions do not restart: each republished day continues
above Cloudflare's last revision (round 12, REV-SEED), so an aggregate
identifier the frozen read served is never reused for other content.

Each frozen-window day's saved owner set is the participants at GCP's first
publication of it (owner decision round 7, E-OWNERSET).
`analytics_v2_daily_owner_set_bootstrap` holds one receipt for every day
whose set is recorded, with the set's size and how it began: for a
frozen-window day, Cloudflare's `contributingParticipants` and the export's
window, verified (provenance 2) when the counts agree and disclosed
(provenance 3) when they differ; otherwise provenance 1. The cold build must
run an image that records owner sets, on a database where the owner-sets
migration precedes the first publication: such an image refuses to run
without the migration's tables, and P10 proves that no published day exists
before H.8. A head published without a recorded set (possible on staging or
test databases only) is adopted the first time a run queues it (provenance
4, listed in `bootstrapAdoptedDays`), is never compared with Cloudflare's
count, and lacks any owner that left before that run.

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
  fresh web-release receipt, and each is archived once verified
  (`production:release-archive`). A website rollback re-deploys a previously
  released site from its archive entry: the restored receipt
  (`--rollback-web-release-receipt`) and the entry's archived journal of the
  verified deploy that released it (`--rollback-release-operation`); see
  [Production edge modes](./production-edge-modes.md#website-rollback).
  Prepare receipts and generated sites on the edge-port line. A rollback past
  the switch is refused (`EDGE_PRIVACY_PAGE_NOT_CUTOVER`): it is not an edge
  rollback, which stays the brake.

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
| `EDGE_MODE_REQUIRED_FOR_EDGE_LIVE` | Typed deploy | A typed deploy without `--edge-mode` over a live edge, including `product:web-release:deploy` with its typed pins. Name the live mode |
| `PRODUCTION_UNTYPED_DEPLOY_REFUSED` | Any deploy | `production:deploy` without `--inventory`, or `product:web-release:deploy` without its typed pins. Nothing ran. Use the typed command |
| `PRODUCTION_REPLACED_PUBLIC_SOURCE_NOT_ON_LIVE_LINE`, `PRODUCTION_REPLACED_PUBLIC_SOURCE_UNPROVEN` | H.6, web-only releases | `--replaced-public-source` is off the live line, or did not produce the live manifest. Nothing was uploaded. Use the source PROD-5 pinned |
| `PRODUCTION_ROLLBACK_OPERATION_INVALID`, `PRODUCTION_ROLLBACK_SITE_NOT_RELEASED` | Website rollback | The named journal is not an intact, verified typed production deploy, or it did not leave this site live from the receipt's commit. Nothing ran |
| `WRITER_UNACCOUNTED`, `SCHEDULE_DRIFT` | EP-8 inventory, plan, apply | A script outside the plan binds a listed database or bucket, or a fenced script's crons differ from the plan. At H.1 this is free; at `apply` the edge is already fenced |
| `FENCE_INVENTORY_CHANGED` | EP-8 apply, verify | The fenced surface differs from the plan receipt's fingerprint. Rerun inventory and plan, then use the new receipt |
| `FENCE_WINDOW_TOO_SHORT`, `FENCE_WINDOW_TOO_EARLY` | EP-8 verify | Run too soon: wait until `appliedAt` + 2 x the quiet window + 5 minutes (35 minutes at the minimum), or fix the `--window-start` |
| `FENCE_NOT_QUIESCENT` | EP-8 verify | A D1 bookmark or the quarantine digest moved inside the window: something wrote after the fence. Find the writer; do not shorten the window |
| `CUTOVER_SOURCE_BOOKMARK_DRIFT`, `CUTOVER_SOURCE_CHANGED_AFTER_SEAL` | Seal, revision floor, flip evidence | A source changed after the fence. The seal (or the floor) is void |
| `CUTOVER_ANALYTICS_CHANGED_AFTER_FENCE` | Flip evidence | The analytics D1's bookmark moved after the fence: Cloudflare published after the revision floor's capture. The floor is void; abort, fence and seal again |
| `CUTOVER_BOOKMARK_ROLE_QUERY_REFUSED` | Flip evidence | A statement was sent through the bookmark-only role `analytics-bookmark`. A tooling defect: stop |
| `ANALYTICS_V2_REVISION_FLOOR_ABSENT` | H.8 | A production refresh found no revision floor. The import's `analytics-community-history` stage has not loaded it; never run the production refresh before it has |
| `ANALYTICS_V2_FIRST_RUN_BASELINE_ABSENT` | H.8 | A production first run found neither the frozen interim read nor the revision floor: the H.4 import has not run (or ran against another schema). Nothing was written; never run the production refresh before H.4 is live |
| `CUTOVER_ERASED_PARTICIPANT_PRESENT`, `CUTOVER_PARTICIPANT_ERASURE_PENDING` | Seal, PT-3 | An erased or mid-erasure participant is in the sealed set. Finish the erasure on Cloudflare and re-seal |
| `CUTOVER_IDENTITY_LINK_SECRET_MISMATCH`, `CUTOVER_IDENTITY_ROTATION_SOURCE_MISMATCH` | PT-3 | The configured pin, or under round 16 the rotation's `from`, does not match the sealed pin. Rotate only through the recorded [identity-link rotation](#identity-link-rotation-round-16) |
| `CUTOVER_IDENTITY_ROTATION_STATE_INVALID` | Run, post-import, flip gate, post-live | The target pin is neither the rotation's `from` nor its completed `to` for this run, or (without a rotation) differs from the pin. Something wrote the pin row outside the orchestrator: diagnose, never bypass |
| `CUTOVER_RUN_NOT_VERIFIED`, `CUTOVER_CONTROLS_DIGEST_MISMATCH` | Finalize | The run is not `verified`, or the controls do not equal the sealed row |
| `MUTATION_BARRIER_ACTIVE` | Edge | Expected while fenced. Not an error |

## Open gaps in tooling and decisions

Status is as of the line at `c80f99b9` and the checklist on 2026-10-02. The
C-IPR, C-ADMIN and C-REFRESH rows were re-marked when this draft merged into
the line after `95c158ba`, and the E-QUIESCE row when E-QUIESCE merged after
`ebb9304d`. The two D-CRB rows were re-marked in D-CRB itself, on top of the
line at `2b5c90cd`.

| Gap | Affects | State |
|---|---|---|
| Verifier smoke command | H.1, H.5 | `in build` (verifier tooling) |
| Production host composition, first-roll ready path, `HOST_ORIGIN` check | Preconditions, H.5 | `built` (D-CRB), local proof only (the PostgreSQL 17 production-host spec and E12); no revision is rolled anywhere. The staging service template is open (owner decision on CR-3's staging profile) |
| Telemetry importer production modes | H.4 | `built` (D-PT5A) on a synthetic seal only; the provider's real export shapes are unverified |
| Import orchestrator and finalize sequencing | H.4 | `built` (E-PT8) on a synthetic seal and a local PostgreSQL 17 target only; the production transfer identity and its Cloud SQL Auth Proxy connection are not provisioned (PT8-I) |
| Read-only pre-fence quiescence query | H.1 | `built` (E-QUIESCE); not yet run against the provider |
| Frozen public read: export format, loader, retirement | H.3, H.4, H.8 | `built` (C-IPR), with migration `0065` promoted to primary at the C-SIMP-RECON merge; dropping the stored row is `not built` |
| Admin routes at the origin | H.7 | `built` (C-ADMIN, ADMIN-R12): the production and staging composition opens the admin host behind the Access chokepoint (round 12). The overview is `admin-overview-v0.6`: the synthetic-contribution counts, historical publication and deletion-ledger blocks answer `{"status":"unavailable"}` until their sources exist (E-ADMIN); database health is `admin-database-health-v0.2`, the removed ledger `not_applicable`. The admin UI that reads both versions ships with the edge Worker; local proof only |
| Refresh job production contract | H.8 | `built` (C-REFRESH) |
| Revision floor: capture, load, refresh refusal | H.3, H.4, H.8 | `built` (REV-SEED) on synthetic data and a local PostgreSQL 17 target only; its migration is promoted as primary `0071`; the capture has never contacted the provider. R19 hardenings `built` the same way: the offline check binds the fence (b), verify-unchanged re-reads the analytics bookmark (c), a production first run refuses without the frozen read or the floor (d) |
| Maintenance job and trigger in the desired state | H.4 | `built` (D-OPS4), created paused; applied and resumed in no project |
| Scheduler pause-all and resume-all | H.4, H.8 | `not built` (D-OPS3) |
| Monitoring and alerting, origin-lock check | H.7 | `not built` (E-OPS5) |
| Barrier proof producer, edge live capture producer | H.2, rollout | No command writes either file |
| R2 to Cloud Storage copy | After | `not built` (PT-7) |
| Observation duration and brake thresholds | H.7 | Owner decision, not recorded |
| v0.x upload 503s in origin-5xx-ratio | H.7 | Owner question, open. Round 12 answers v0.x uploads with the uniform `503 POSTGRES_ROUTE_NOT_PORTED` on `/api/v1/contributions` and `/api/v1/device/upload-authorizations`, paths every live v1 upload shares, so the alert cannot exclude them and they count as 5xx. The live ingestion database never admitted a v0.x row, so the effect is theoretical. Keep counting them, or give v0.x a code the exclusion can name ([monitoring](../../apps/worker/cloud-run/infra/monitoring.md#origin-5xx-ratio)) |
| Backup-restore rehearsal | Preconditions (Backups) | Staging tool `built`, never run live (E-OPS7). Its do-not-restore step is injected with no list, because custody is OA-9 (decided after cutover). So the Backups precondition, which needs the list reapplied before uploads reopen, cannot clear before cutover as written. Owner decision needed |

## Evidence boundary

This is a draft runbook, not a deployment receipt or a readiness claim. A
source review does not prove a live service. Source merge, CI, local
synthetic checks, the staging rehearsal, the dress rehearsal, the production
cutover and public deployment are separate gates, and this document proves
none of them.
