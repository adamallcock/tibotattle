---
title: Production edge modes
date: 2026-10-01
type: runbook
status: maintained
---

# Production edge modes

> **Not yet operational.** This runbook becomes operational at P1, the first
> typed worker-mode edge deploy from the edge-port line. Until then,
> [Production service operations](./production-operations.md) governs every
> Cloudflare operation, and its Cloudflare sections stay authoritative after P1
> wherever this runbook does not replace them. Nothing here authorizes a deploy,
> a secret change, a writer fence, a GCP write or a cutover; each is a separate
> owner-authorized operation. The E10 deploy flags and the E12 commands below
> are those merged on `claude/gcp-fp-edge`. Use a command only on a line that
> carries the change implementing it, and take its exact flags from that
> line's code.

It covers the three modes of the production Worker's thin edge (`worker`,
`fenced` and `gcp`), their typed deploys, the edge secrets, the writer fence,
the brake and the abort, the pre-gcp verifier, web-only releases in gcp mode,
and the local proof.

Authority:

- The contract is the accepted
  [thin Worker edge proxy decision](../decisions/2026-10-01-thin-worker-edge-proxy.md),
  approved by the owner on 2026-10-02.
- Cutover ordering belongs to the cutover runbook, which exists only as a draft:
  [GCP cutover window](./gcp-cutover-window.md). The
  [GCP fast path plan](../plans/2026-10-01-gcp-fastpath.md#minimum-cutover-sequence)
  records the intended sequence. This runbook never decides order on its own.

## Never

- No load balancer in front of Cloud Run, no Transform Rule, no DNS change and
  no custom-domain removal or move. The three hostnames stay custom domains of
  the same Worker in every mode. Option A of OD-E6 (a Cloudflare-proxied
  origin hostname) would change this rule. It was a fallback only if the
  production-zone address probe failed, and that probe passed on 2026-10-02;
  it would need its own owner decision first.
- No guard-only Worker. The Sparkle appcast guard stays in the production
  Worker.
- No deploy from the checked-in `env.production`, and no raw `wrangler deploy`.
  Every edge deploy goes through the typed path. The commands enforce this:
  `production:deploy` without `--inventory`, and `product:web-release:deploy`
  without its inventory and live-site pins, are refused before anything runs
  (`PRODUCTION_UNTYPED_DEPLOY_REFUSED`). So is the release publication's
  website step, which passes no pins.
- No gradual deployment and no version split on this Worker. Exactly one version
  serves 100%.
- No edge deploy from the GCP line.
- No edge secret in Google Secret Manager, the origin, the repository, a log or
  a receipt. No identity token in a file, a log, a receipt, shell history or a
  command-line argument.

## 1. Source line and local gates

- Deploy the edge only from `claude/edge-port-<date>`. The integration lead cuts
  it from the owner-designated production release line (OD-E1). That line must
  contain `d43c8f92` and the live `DEPLOYMENT_SOURCE_COMMIT`. The edge files on
  it are blob-identical to the fast-path line.
- With OD-E2, E10 refuses `EDGE_MODE_SOURCE_NOT_DESCENDANT` for a source that
  does not descend from the live commit.
- Before any edge deploy, run on the deploy commit the local validation in
  [Production service operations](./production-operations.md#local-validation-before-an-owner-deploy)
  plus the gates that E4, E5 and E10 define for their specs and checks.
- Before the gcp deploy, the E12 local end-to-end
  ([section 7](#7-local-proof-and-the-optional-live-check)) must also be green
  for the edge commit against the origin commit. E12's cross-line option builds
  the edge from the edge-port tree and checks that the contract blob matches.
- No gcp deploy runs without a recorded pass of the edge IP probe from the
  `tibotattle.com` zone (OD-E6). The owner recorded that pass on 2026-10-02
  ([receipt](../receipts/2026-10-02-gcp-edge-ip-probe-production-zone.md)):
  from the zone, with the edge's `x-real-ip` override, no header carrying the
  visitor's address reached a Cloud Run service, no `CF-Connecting-IP` or
  `x-real-ip` arrived, `x-forwarded-for` carried Cloudflare's placeholder, and
  the header names matched the earlier `workers.dev` run. The probe did not
  observe the token exchange or the case without the override, so the
  override stays load-bearing. A change to the edge's topology or placement
  needs a new passing run, which follows
  [the probe's README](../../apps/worker/scripts/edge-ip-probe/README.md); the
  recommendation and the fallbacks if it fails are in
  [the decision record, section 5](../decisions/2026-10-01-thin-worker-edge-proxy.md#od-e6-recommendation-and-gate).
  E10 does not check this, so the operator confirms the recorded pass before
  the switch.
- Before the first production use of each mode, rehearse worker, fenced (with
  an EP-8 drill) and gcp on a staging Worker with its own hostnames, Access
  application and Cloud Run service. EP-9 provides a staging overlay for this.
  The owner provides the staging environment, and the cutover runbook places
  the rehearsal in its order.

## 2. Typed deploys per mode

Start from the guarded typed deployment in
[Production service operations](./production-operations.md#guarded-deployment-wrapper):
the live inventory, its pinned sha256, the reviewed previous source, and either
the retained public source with the live manifest sha256 or, for a changed
site, the candidate flags in [Changing the public site](#changing-the-public-site).
E10 adds these flags to that command:

| Mode | Added flags | Typical use |
|---|---|---|
| `worker` | `--edge-mode=worker`; after a fence, also `--fence-receipt=<verified fence receipt> --fence-receipt-sha256=<its sha256>` | P1, the first edge-entry deploy; any later worker-mode redeploy, including web-only releases before the fence; the abort |
| `fenced` | `--edge-mode=fenced` | Starting the fence; the brake from gcp |
| `gcp` | `--edge-mode=gcp --edge-plan=<private gcp plan> --origin-commit=<origin commit> --origin-verifier-account=<verifier account>` | The switch, with the privacy-marker candidate site; gcp redeploys, including web-only releases and website rollbacks |

**Without `--edge-mode`.** Once the live version carries an
`EDGE_UPSTREAM_MODE` binding (from P1 on), a typed deploy without
`--edge-mode` is refused before any snapshot or journal
(`EDGE_MODE_REQUIRED_FOR_EDGE_LIVE`). Its plain render would install the
checked-in entry in place of the edge entry and skip every edge gate,
including the privacy-page rule. `product:web-release:deploy` has no edge
mode, so from P1 on it is refused in both forms: with its typed pins by this
rule, and without them always (`PRODUCTION_UNTYPED_DEPLOY_REFUSED`). See
[Changing the public site](#changing-the-public-site).

The gcp plan is EP-9's closed plan: the Cloud Run origin URL, the audience, the
edge-invoker account, an optional headers timeout, and the release-guard D1's id
and name. It holds identifiers, so keep it owner-private and outside the
repository.

Before any upload, the deploy refuses:

- `--edge-mode` outside the typed path (`EDGE_MODE_REQUIRES_TYPED`);
- a transition outside EP-9's matrix (`EDGE_MODE_TRANSITION_FORBIDDEN`). For
  fenced to worker, E10 walks the deployment history back to the fenced
  deployment the verified EP-8 fence receipt names
  (`EDGE_MODE_FENCE_HISTORY_INCOMPLETE` when it cannot);
- a source that does not descend from the live commit
  (`EDGE_MODE_SOURCE_NOT_DESCENDANT`), or a source without the edge entry
  (`EDGE_MODE_ENTRY_UNAVAILABLE`);
- for gcp: a missing edge-tier rate-limit binding
  (`EDGE_MODE_ADMISSION_BINDING_MISSING`), a missing edge secret
  (`EDGE_MODE_SECRET_MISSING`), a pending release-guard migration
  (`EDGE_MODE_RELEASE_GUARD_MIGRATIONS_PENDING`), a pre-gcp verifier answer
  that names another origin commit (`EDGE_ORIGIN_COMMIT_MISMATCH`), a contract
  blob that differs between the edge commit and the origin commit
  (`EDGE_CONTRACT_DRIFT`), or a candidate site without the privacy marker
  (`EDGE_PRIVACY_PAGE_NOT_CUTOVER`);
- for worker, fenced and pre-gcp deploys: a candidate site with the marker
  (`EDGE_PRIVACY_PAGE_PREMATURE`).

After the deploy, verify the mode:

| Mode | Identity | Public surface |
|---|---|---|
| `worker` | Today's health-based checks: `deployment.sourceCommit` is the candidate | Unchanged from the pre-edge Worker |
| `fenced` | One version at 100% whose `DEPLOYMENT_SOURCE_COMMIT` and `EDGE_UPSTREAM_MODE` bindings match | Public `GET /api/health` is barrier health for the commit. `/api/ready`, API, admin, Sparkle guard and Apple paths answer `503 MUTATION_BARRIER_ACTIVE` with `no-store` and `retry-after: 300`. `www` asset paths redirect, and `/release-site-manifest.json` is 200 |
| `gcp` | As fenced, from the Cloudflare bindings | Public `/api/health` is status `ok` with the origin commit. A `RETIRED_SECRET_PRESENT` warning is expected until the owner deletes the retired storage secrets |

Reconciliation (`npm run production:reconcile`, with `--edge-mode` and
`--edge-plan`) and the typed recovery of an uncertain deploy must use the same
pinned mode and plan. E10 refuses `EDGE_MODE_PLAN_REQUIRED` when a pinned gcp
mode has no plan and `EDGE_MODE_PLAN_MISMATCH` when the plan differs. In gcp
mode no typed role is bound, so the typed schema inspection is skipped
(`EDGE_MODE_GCP_TYPED_ROLES_UNBOUND`).

### Changing the public site

A typed deploy pins the public site in one of two closed ways. They never mix.

| Site | Flags | Before the upload | After the upload |
|---|---|---|---|
| Kept | `--retained-public-source <live site's source sha> --expected-live-manifest-sha256 <live manifest sha256>` | The live manifest is the pinned one. The staged site is exactly that manifest, built from the retained source | The live manifest is still the pinned one |
| Changed | `--candidate-public-manifest-sha256 <candidate sha256>`; one of `--web-release-receipt <receipt>`, or `--rollback-web-release-receipt <receipt>` with `--rollback-release-operation <that release's archived journal>`; and `--replaced-public-source <live site's source sha> --replaced-live-manifest-sha256 <live manifest sha256>` | The live manifest is the replaced one, and its source provenance matches the replaced source commit. The staged site is exactly the candidate manifest, built from the receipt's source commit | The live manifest is the candidate |

**Prepare on the edge-port line.** These deploys run from the edge-port line,
and both rows stage the site with that line's `stage-production-assets.mjs`;
a changed site's receipt is re-verified by that line's web-only lane. Both
allowlists differ from this line's: the edge-port line stages
`feature-value.png` where this line stages `feature-value.jpg`, and only the
edge-port line's lane admits the cache-reuse matrix, feature insights,
feature-value image and model performance files. So build P1's retained tree
and prepare every receipt and generated site (the switch's, each web-only
release's, each rollback's) on the edge-port line. One prepared on this line
can fail there.

A changed site needs `--edge-mode worker` or `--edge-mode gcp`, so the
privacy-page rule always runs. The receipt is the one
`product:web-release:prepare` writes
([web-only release lane](./2026-08-17-web-only-release.md)); its path must be
absolute, under the checkout's `.release-build`, and outside the generated
site. Before the inventory is read or anything remote runs, the deploy
re-verifies the receipt with the lane's own checks (scope, catalogue proofs,
and the generated site in `.release-build/public-release-site`), then:

- **A release (`--web-release-receipt`).** The receipt must be fresh: its
  source is the checked-out commit, which becomes the deploy source, and its
  base is `--expected-previous-source`, the live commit the shared lock
  rechecks.
- **A rollback (`--rollback-web-release-receipt`).** The receipt is a
  previously released site, with that release's generated site restored into
  `.release-build/public-release-site`. Its source must be the live commit or
  an ancestor of it. The deploy source stays the checked-out commit, and the
  staged site is pinned to the receipt's source commit, which must also be an
  ancestor of the deploy source. A receipt proves a site's bytes and scope,
  not that the site was ever live, so `--rollback-release-operation` names
  the operation journal of the typed production deploy that left the site
  live: the `journal/` of that release's
  [archive entry](./2026-08-17-web-only-release.md#5-archive-the-release),
  used in place. The journal must be a verified typed production
  deploy whose state still matches its binding digest. The site it left live
  (the candidate it shipped, or the retained site it kept) must be the
  receipt's manifest built from the receipt's source commit, and its deploy
  commit must be on the live line.
- **Either way** the receipt's manifest must be the candidate, and the
  operation journal records the candidate (and, for a rollback, its source
  commit) so typed recovery rechecks the right site.
- **The replaced pair is proven, not trusted.** Before the upload the live
  manifest must be `--replaced-live-manifest-sha256`, `--replaced-public-source`
  must be the live commit or one of its ancestors, and the live manifest's
  source provenance must match that commit's public source files, read from
  Git. The journal therefore records a replaced source that produced the live
  site.

Refusals, all before any upload:

| Code | Cause |
|---|---|
| `PRODUCTION_CANDIDATE_SITE_EDGE_MODE_REQUIRED` | A candidate without `--edge-mode` |
| `PRODUCTION_CANDIDATE_SITE_FENCED` | A candidate with `--edge-mode fenced`. Releases pause while fenced; the brake keeps the live site |
| `PRODUCTION_CANDIDATE_SITE_RETAINED_PIN_CONFLICT` | A candidate with `--retained-public-source` or `--expected-live-manifest-sha256` |
| `PRODUCTION_CANDIDATE_SITE_UNCHANGED` | The candidate equals the replaced live manifest. A deploy that keeps the site uses the retained pair |
| `PRODUCTION_ARGUMENTS_INVALID` | No receipt, both receipts, a relative receipt path, a rollback without an absolute `--rollback-release-operation` or that flag on a release, a missing replaced pin, no inventory, `--confirm-migrations`, or a malformed value |
| `PRODUCTION_CANDIDATE_RECEIPT_INVALID` | The lane refuses the receipt: wrong shape, scope or catalogue proof, or the generated site no longer matches it |
| `PRODUCTION_CANDIDATE_RECEIPT_MISMATCH` | The receipt's manifest is not the candidate |
| `PRODUCTION_CANDIDATE_RECEIPT_STALE` | A release receipt whose source is not the checked-out commit, or whose base is not the live commit |
| `PRODUCTION_ROLLBACK_RECEIPT_NOT_ON_LIVE_LINE` | A rollback receipt whose source is not the live commit or one of its ancestors |
| `PRODUCTION_ROLLBACK_OPERATION_INVALID` | The rollback's journal is missing or unreadable, is not a verified typed production deploy, or its state no longer matches its binding digest |
| `PRODUCTION_ROLLBACK_SITE_NOT_RELEASED` | The journal's deploy did not leave this site live: another manifest, another source commit, or a deploy commit off the live line. A receipt prepared after the fact for a site no deploy shipped ends here |
| `PRODUCTION_REPLACED_PUBLIC_SOURCE_NOT_ON_LIVE_LINE` | `--replaced-public-source` is not the live commit or one of its ancestors |
| `PRODUCTION_REPLACED_PUBLIC_SOURCE_UNPROVEN` | The live manifest matched its sha256, but its source provenance does not match `--replaced-public-source` (or that commit cannot be read) |
| `PRODUCTION_CANDIDATE_PUBLIC_SOURCE_NOT_ANCESTOR` | A rollback site's source commit is not in the deploy source |
| `PRODUCTION_PUBLIC_ASSETS_INVALID` | The staged site is not exactly the candidate manifest from its pinned commit |
| `PRODUCTION_TYPED_PUBLIC_RELEASE_MANIFEST_INVALID` | The live manifest is not the replaced one before the upload, or not the candidate after it |

The privacy-page rule then applies to the candidate as to any site:
`EDGE_PRIVACY_PAGE_PREMATURE` for a marked candidate in worker mode or before
the switch, and `EDGE_PRIVACY_PAGE_NOT_CUTOVER` for an unmarked candidate in
gcp mode, including a rollback to a site from before the switch.

The gcp plan is EP-9's closed plan. It holds:

- the Cloud Run origin URL;
- the audience;
- the edge-invoker account;
- an optional headers timeout;
- the release-guard D1's id and name.

It holds identifiers, so keep it owner-private and outside the repository.

**Refusals before any upload.** The deploy refuses:

- `--edge-mode` outside the typed path (`EDGE_MODE_REQUIRES_TYPED`).
- A transition outside EP-9's matrix (`EDGE_MODE_TRANSITION_FORBIDDEN`). The
  allowed transitions are:
  - none → worker
  - worker → worker
  - worker → fenced
  - fenced → fenced
  - fenced → gcp
  - fenced → worker
  - gcp → gcp
  - gcp → fenced

  For fenced → worker, E10 walks the deployment history back to the fenced
  deployment that the verified EP-8 fence receipt names. When it cannot, it
  refuses with `EDGE_MODE_FENCE_HISTORY_INCOMPLETE`.
- A source that does not descend from the live commit
  (`EDGE_MODE_SOURCE_NOT_DESCENDANT`).
- A source without the edge entry (`EDGE_MODE_ENTRY_UNAVAILABLE`).
- For gcp:
  - a missing edge-tier binding (`EDGE_MODE_ADMISSION_BINDING_MISSING`);
  - a missing edge secret (`EDGE_MODE_SECRET_MISSING`);
  - a pending release-guard migration
    (`EDGE_MODE_RELEASE_GUARD_MIGRATIONS_PENDING`);
  - a pre-gcp verifier answer that names another origin commit
    (`EDGE_ORIGIN_COMMIT_MISMATCH`);
  - a contract blob that differs between the edge commit and the origin
    commit (`EDGE_CONTRACT_DRIFT`);
  - a candidate site without the privacy marker
    (`EDGE_PRIVACY_PAGE_NOT_CUTOVER`).
- For worker, fenced and pre-gcp deploys: a candidate site that carries the
  privacy marker (`EDGE_PRIVACY_PAGE_PREMATURE`).

## 3. Edge secrets

### Provisioning, during worker mode

After P1 and before the fence, the owner puts two Worker secrets on the
production Worker through the approved credential mechanism:

- `EDGE_INVOKER_KEY_JSON`: one JSON key of the edge-invoker service account. It
  exists only as this Worker secret. Delete any local copy after the put.
- `EDGE_CLIENT_KEY_SECRET`: a fresh random value of at least 32 characters. It
  is used only at the edge and must never equal the origin's
  `IDENTITY_LINK_SECRET`.

Keep `SPARKLE_APPCAST_GUARD_TOKEN` and `DISTRIBUTION_ANALYTICS_API_TOKEN`. The
gcp overlay requires both.

Each secret put creates and deploys a new version at 100%. Behavior does not
change, because worker mode never reads the edge secrets. After each put:

1. Confirm one version at 100%, with unchanged `DEPLOYMENT_SOURCE_COMMIT` and
   `EDGE_UPSTREAM_MODE` bindings and unchanged public health.
2. Recapture the typed baseline: capture the private inventory again and pin
   its new sha256. The earlier inventory names a superseded version, so the
   next typed deploy must not use it.

### Rotation

- **`EDGE_INVOKER_KEY_JSON`, every 90 days:**
  1. The owner creates a new key for the edge-invoker account.
  2. Put it as the secret.
  3. In gcp mode, confirm that forwarded requests succeed, for example public
     `GET /api/health` returning the origin's 200 rather than
     `503 EDGE_ORIGIN_UNAVAILABLE`.
  4. Delete the old key in Google Cloud.
  5. Recapture the baseline.
- **`EDGE_CLIENT_KEY_SECRET`:** rotating it changes every address rate-limit
  key, so every per-address window resets once. Rotate it on suspected
  exposure, not routinely, then recapture the baseline.
- After the gcp switch, the retired storage secrets stay listed with a warning
  until the owner deletes them in a separately authorized step.

## 4. Fence, brake and abort

### Fence

For the whole fenced window, every API, admin, sign-in and release path answers
`503 MUTATION_BARRIER_ACTIVE` with `retry-after: 300`. Release publishing and
web-only releases pause, because the Sparkle guard is blocked. The window's
length depends on the export and import, which the cutover runbook orders.

1. Run the typed fenced deploy and verify it ([section 2](#2-typed-deploys-per-mode)).
2. Run EP-8 from `apps/worker`, with `CLOUDFLARE_API_TOKEN` supplied through the
   approved credential mechanism:
   EP-8 requires complete account script and queue inventories. For each script
   it reads the explicit first deployment page with one result: Cloudflare
   [defines the first deployment as currently active](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/).
   Older lifetime history may continue on later pages; page/count/total metadata
   must still prove the requested newest prefix is complete. Verify and release
   read a bounded newest prefix of at most 25 deployments through the required
   fenced anchor, with unique identifiers, strictly descending timestamps,
   complete version weights and an unchanged head readback. Missing anchors,
   ambiguous metadata/order or a changing head refuse; they never authorize
   skipping history or weakening account inventory completeness.

   ```bash
   node scripts/cloudflare-writer-fence.mjs inventory --plan=<private fence plan> --receipts=<private receipts directory>
   node scripts/cloudflare-writer-fence.mjs plan --plan=<private fence plan> --receipts=<private receipts directory>
   node scripts/cloudflare-writer-fence.mjs apply --plan=<private fence plan> --receipts=<private receipts directory> \
     --confirm=<plan receipt sha256> --analytics-drain-complete
   node scripts/cloudflare-writer-fence.mjs verify --plan=<private fence plan> --receipts=<private receipts directory> \
     --fence=<plan receipt sha256>
   ```

   - `inventory` and `plan` are read-only. Review the writer set. `plan`
     prints the receipt sha256 that `apply` takes as `--confirm`.
   - `--analytics-drain-complete` is the operator's attestation that every
     in-flight Cloudflare erasure and analytics-delivery job has finished. EP-8
     records it; it does not prove it.
   - `inventory` and `plan` do not need a fenced Worker. Run them, and review
     the writer set, before the fenced deploy; `apply` collects the inventory
     again and refuses drift.
   - `verify` succeeds only once now is at least `apply`'s finish time plus two
     quiet windows plus the 5-minute analytics lag: 35 minutes at the 15-minute
     minimum (`FENCE_WINDOW_TOO_SHORT` before then, and `FENCE_WINDOW_TOO_EARLY` for a
     `--window-start` earlier than apply plus one quiet window).
     Its fence receipt pins the D1 bookmarks and the R2 digest that the export
     must use.

The fence plan is a closed, owner-private file. It names the account, the
production Worker, the fenced scripts with their expected crons or queue, the
four D1 databases, the quarantine bucket, any out-of-scope scripts with reasons,
and the quiet window. The receipts directory must be private (mode 0700). Keep
both outside the repository.

### Abort, before any gcp version

1. Run the typed worker-mode deploy with `--fence-receipt` and
   `--fence-receipt-sha256`, while the fence is still applied. Fenced to worker
   is allowed only while no gcp-mode version has been deployed since the fence
   began, and E10 proves that from the verified fence receipt, which its reader
   refuses once the fence is released. The receipt exists only after EP-8's
   `verify`; before it, there is no typed path back to worker mode.
2. Then release the fence from `apps/worker`:

   ```bash
   node scripts/cloudflare-writer-fence.mjs release --plan=<private fence plan> --receipts=<private receipts directory> \
     --confirm=<plan receipt sha256> --pre-gcp
   ```

   It restores the exact prior schedules and queue delivery from the apply
   journal. It is refused once any gcp-mode version has been deployed since the
   fence.

Writes resume, so any seal or export taken under that fence is no longer
valid. A later attempt needs a fresh fence.

### Brake, after the switch

Gcp to fenced is the brake: a typed fenced deploy with no plan.

- Forwarded routes then answer `503 MUTATION_BARRIER_ACTIVE` with
  `retry-after: 300`, and the edge stops forwarding.
- The Cloudflare writers stay fenced.
- Leave the brake only by fenced to gcp, which runs every gcp check again.
- Gcp to worker is forbidden. The owner decided on 2026-10-02 that the brake is
  the only way back after the switch, followed by a fix forward; the draft
  [GCP brake and incidents](./gcp-brake-and-incidents.md) sequences it.

## 5. Pre-gcp verifier

Before the gcp deploy, and wherever the cutover runbook asks for origin
readiness, an operator checks the origin through a verifier account. The
verifier is limited at the origin to plain `GET /api/health` and
`GET /api/ready`.

- **Owner prerequisites:** the verifier account holds `run.invoker` on the
  production service only (EP-7's optional verifier), and the operator may
  impersonate it.
- **Token:** the gcp deploy mints it itself from `--origin-verifier-account`:
  it runs `gcloud auth print-identity-token` with
  `--impersonate-service-account`, `--audiences` (the plan's audience) and
  `--include-email`, without a shell, and keeps the token in memory. It is
  never printed, passed as an argument or written.
- **Pass condition:** both reads return 200 with the origin marker and secure
  JSON headers. The verifier records the origin commit, which becomes the gcp
  deploy's `--origin-commit`.
- **Receipts:** they hold statuses and the origin commit only, never a token, an
  email or a key.
- **First roll:** `/api/ready` reads the rows C-MAINT's lifecycle pass writes,
  so a freshly migrated origin answers `503` until one pass has run. The
  rollout tool (`scripts/gcp-production-rollout.mjs`) runs one execution of
  the target's maintenance job (the desired state's `maintenance` job,
  D-OPS4) after the roll and before it verifies. Staging cannot deploy that
  job yet, so a staging target names none; while the edge is not in gcp mode
  (the roll then verifies through this verifier), a target without a
  `maintenanceJob` is refused before any write
  (`ROLLOUT_MAINTENANCE_JOB_REQUIRED`). The same tool refuses a target whose
  edge `upstreamOrigin` is not the rolled service's run.app origin (the
  origin's `HOST_ORIGIN`).
- **Finding F8 status:** the edge decision record's F8 (the fast-path test
  origin serves no `/api/ready`, so no gcp deploy can pass) is closed in
  source, not in deployment: the production origin (`HOST_MODE=production`
  or `staging`, D-CRB) and the fastpath-test mode serve Worker-shaped
  `/api/health` (RD-3) and `/api/ready` (RD-2). The verifier passes only
  against a rolled production-host revision after its first maintenance
  pass, and none is deployed yet.

## 6. Releases and deploys in gcp mode

### The switch's site

The switch (EP-10) is the first changed-site deploy in gcp mode: the
privacy-marker site ships in the same deploy as the mode. Build it as a
web-only candidate of the fenced commit:

1. The switch commit differs from the live fenced commit only inside the
   [web-only closure](./2026-08-17-web-only-release.md#1-establish-the-source-boundary):
   the privacy page, the browser localization, the paired i18n catalogue and
   mirror, and their focused tests. Every other change, including edge code
   and repository documentation, lands before P1 or after the switch.
2. Prepare it with `product:web-release:prepare --base <live fenced commit>`,
   on the edge-port line: a receipt or generated site prepared on this line
   can fail there (see [Changing the public site](#changing-the-public-site)).
3. Deploy, from `apps/worker` on the switch commit:

   ```bash
   npm run production:deploy -- --confirm DEPLOY_PRODUCTION \
     --expected-previous-source <live fenced commit> \
     --inventory <fresh-private-inventory.json> \
     --inventory-sha256 <fresh-inventory-sha256> \
     --candidate-public-manifest-sha256 <the receipt's site.manifestSha256> \
     --web-release-receipt <absolute path of .release-build/web-release-receipt.json> \
     --replaced-public-source <live site's source sha> \
     --replaced-live-manifest-sha256 <live manifest sha256> \
     --edge-mode gcp \
     --edge-plan <private gcp plan> \
     --origin-commit <origin commit> \
     --origin-verifier-account <verifier account>
   ```

`--replaced-public-source` is the source of the site PROD-5 kept: the commit
it pinned with `--retained-public-source`. Without the candidate the switch is
refused `EDGE_PRIVACY_PAGE_NOT_CUTOVER`; with the retained pair added it is
refused `PRODUCTION_CANDIDATE_SITE_RETAINED_PIN_CONFLICT`.

Once the switch is verified, archive it from `apps/worker` on the switch
checkout with `npm run production:release-archive` ([Archive the
release](./2026-08-17-web-only-release.md#5-archive-the-release)): its
journal, receipt and privacy-marker site are the rollback point for the
switch's site.

### Web-only releases

From P1 on, a web-only release is a changed-site deploy through
`production:deploy` with the live mode (`--edge-mode worker` before the
fence, `--edge-mode gcp` after the switch; the owner's round 12 decision).
`product:web-release:deploy` is refused: with its typed pins
`EDGE_MODE_REQUIRED_FOR_EDGE_LIVE` (it has no edge mode), and without them
`PRODUCTION_UNTYPED_DEPLOY_REFUSED`, which also applies before P1.

1. Prepare the candidate with the
   [web-only release lane](./2026-08-17-web-only-release.md) on the edge-port
   line, with the live commit as `--base`.
2. Deploy it as in [the switch's site](#the-switchs-site), with the live
   commit as `--expected-previous-source`. In gcp mode keep the gcp plan,
   `--origin-commit` (the live origin commit) and the verifier account; in
   worker mode use `--edge-mode worker` alone.
3. Once it is verified, archive it with `npm run production:release-archive`
   ([Archive the release](./2026-08-17-web-only-release.md#5-archive-the-release)).

E10 applies the mode's rules. In gcp mode no Cloud Run redeploy is needed;
the predecessor and post-deploy identity come from the Cloudflare bindings,
the contract blob at the release commit must equal the blob at the live
origin commit, and the candidate's privacy page must carry the marker. Before
the switch, a candidate must not carry the marker. While the fence is up,
web-only releases pause.

### Website rollback

Roll the site back by re-deploying a previously released site by its
receipt, not by deploying an old checkout. Only a site that a verified typed
production deploy left live can come back; a receipt prepared later for
another commit is refused (`PRODUCTION_ROLLBACK_SITE_NOT_RELEASED`).

1. Archive every release after it is verified ([Archive the
   release](./2026-08-17-web-only-release.md#5-archive-the-release)): the
   switch, each web-only release and each rollback. The entry keeps the
   deploy's operation journal, private and as the deploy left it, with the
   release's receipt and generated site. Prepare them on the edge-port line: a
   receipt or site prepared on this line can fail there. Never edit an entry.
2. On a clean checkout of the live commit, or a descendant of it, restore the
   entry's `public-release-site` into `.release-build/public-release-site` and
   its `web-release-receipt.json` anywhere under `.release-build` outside that
   directory.
3. Deploy as in [the switch's site](#the-switchs-site), with
   `--rollback-web-release-receipt <restored receipt>` in place of
   `--web-release-receipt`, plus
   `--rollback-release-operation <the entry's journal directory>` (the
   archived journal, used in place), the entry index's `manifestSha256` as
   the candidate, and the live site as the replaced pair. On a checkout of
   the live commit itself, also pass a fresh, absolute private `--operation`
   directory: the default one for that commit holds the earlier deploy's
   journal (`RELEASE_OPERATION_EXISTS_USE_RESUME`).

The site PROD-5 kept has PROD-5's journal as its evidence; archive that
journal with the kept site's web-release receipt and generated site in the
same way. That needs a receipt whose source is the retained source and whose
manifest is the live one, which the edge-port line's lane still accepts; find
it before PROD-5. Without one, or if the archive refuses it
(`PRODUCTION_RELEASE_ARCHIVE_RECEIPT_INVALID`,
`PRODUCTION_RELEASE_ARCHIVE_RECEIPT_MISMATCH`), the kept site is not a
rollback target: keep and record the journal, and restore that site, if
needed, with a revert commit
([A deploy that kept the site](./2026-08-17-web-only-release.md#5-archive-the-release)).
A site live only before the typed journals, with no verified typed journal,
cannot be a rollback target either.

In gcp mode a rollback past the switch is refused
(`EDGE_PRIVACY_PAGE_NOT_CUTOVER`): the restored site must carry the marker.
Rolling the edge back is the brake, not a site rollback.

### Cloud Run deploys

Every origin deploy must check that
`git rev-parse <origin commit>:apps/worker/src/edge-origin-contract.ts` equals
the same blob at the live edge commit, read from the Cloudflare
`DEPLOYMENT_SOURCE_COMMIT` binding. Refuse the deploy otherwise.

Both origin deploy tools apply this check (D-BLOB) in every edge mode, before
any remote command. They read the live edge commit from the owner's fresh
EP-9 capture (`{schema, capturedAt, snapshot, deployment}`, at most 15
minutes old):

- OPS-10's `gcp-production-rollout.mjs roll` (`--edge-live`);
- the fast-path test deploy's `origin` step (`--edge-live` and
  `--edge-environment`).

Each refuses `EDGE_CONTRACT_DRIFT` when the two blobs differ, or when either
commit has no contract file. A pre-edge Worker, such as the production
commit `d43c8f92`, has no contract file. An origin roll therefore refuses
until the edge port is live in worker mode (PROD-5).

**One exception: OPS-2's first create of the service.** `gcp-infra.mjs apply`
with `--bootstrap-image-digest` and `--bootstrap-source-commit` creates the
Cloud Run service from a bootstrap image when the service does not exist yet.
That create runs no contract-blob check. It is safe only because no edge can
be forwarding to a service that does not exist:

- a gcp-mode edge is deployed only against a verified, running origin whose
  blob matched;
- OPS-2 never deletes the service.

If the service is ever deleted out of band while the edge is in gcp mode,
brake to fenced before recreating it. Then roll the intended commit with
OPS-10, which checks the blob, before any gcp deploy.

A contract change has no in-place path. Run these steps in order:

1. **Brake to fenced, from an edge commit that already carries the new
   contract blob.** A fenced deploy does not compare the origin's blob, so
   it can go first. Braking from the old edge commit does not work: the
   origin deploy in step 2 would then refuse `EDGE_CONTRACT_DRIFT` against
   the live fenced edge.
2. Deploy the origin at a commit with the new blob. Its D-BLOB check now
   matches the live fenced edge.
3. Run the gcp deploy from an edge commit with the same blob.

### Reading edge failures

Edge logs are content-free JSON lines.

| Client sees | Log | Meaning |
|---|---|---|
| `503 EDGE_NOT_CONFIGURED`, `retry-after: 60` | One warn line naming the code | The mode variable is missing or unknown, the gcp configuration is invalid, or the proxy could not be built (for example an unreadable invoker key) |
| `503 EDGE_ORIGIN_UNAVAILABLE`, `retry-after: 60` | `edge_upstream_unavailable` with `EDGE_TOKEN_UNAVAILABLE` | The token mint failed; every forwarded request fails for the ten-second negative cache |
| The same | `edge_upstream_unavailable` with `EDGE_UPSTREAM_TIMEOUT` or `EDGE_UPSTREAM_NETWORK` | The origin did not answer in time, or the connection failed |
| The same | `edge_upstream_unavailable` with `EDGE_UPSTREAM_UNMARKED` | An unmarked answer: Google's front end refused, Cloud Run was overloaded, or the origin boundary returned its 421 |
| Admin 403 or 503 | `edge_admin_chokepoint_refused` | The Access chokepoint refused a forwarded admin-host request |
| Overview without Cloudflare download figures | `edge_distribution_merge_skipped` | The merge failed; the origin's bytes were served unchanged |

### Origin answers that differ from the Worker (OD-CR-6)

The GCP origin answers the Worker's routes with the Worker's codes and
envelopes, with these owner-accepted differences (owner decisions of
2026-10-02, and STATUS-REUSE of round 19 on 2026-10-03):

- **(i) Request id, fixed.** Every error envelope carries the edge's
  `x-tibotattle-edge-request-id`, so the edge, origin and client lines join
  on one id.
- **(ii) A query string on POST routes is refused.** A query string on a
  v1.2 POST route (among them `POST /api/v1/contributions`) or on
  `POST /api/v1/device/upload-authorizations` answers
  `503 POSTGRES_TEST_ROUTE_UNSUPPORTED` in the Worker envelope
  (`{"error":{"code","requestId"}}`, the edge's request id, no
  `retry-after`), where the Worker ignores the query. No shipped client
  sends one.
- **(iii) The storage 503 can come first.** While the origin's migration
  receipt does not match its image (a migration applied ahead of the roll),
  the storage-gated routes answer `503 BACKEND_STORAGE_UNAVAILABLE`, which
  can precede refusals the Worker makes from the request alone (method,
  body shape, credentials). The gate rereads the receipt on every request.
- **(iv) Unported routes send no `retry-after`.** They answer
  `503 POSTGRES_ROUTE_NOT_PORTED`, so clients that retry only on a
  `retry-after` do not retry them. Since round 12 every unported route is
  retired (legacy enroll, Google and Apple sign-in, security reset,
  participant export, the performance device and consent routes). Two
  retirements are never this 503 (round 19, 2026-10-03):
  - The accountless performance authorization answers production's exact
    sequence: `401 AUTH_INVALID` for a session cookie, the Worker's
    configuration and upload-registration `503`s, the accountless-ownership
    limiter's `429 ATTEMPT_LIMIT_REACHED` (replayed from the edge's
    outcome), `401 DEVICE_AUTH_INVALID` for a bearer that is not an active
    accountless device, the body's `415`, `400 BODY_INVALID` or `413`, and
    then the terminal `403 TELEMETRY_TRANSPORT_BLOCKED`. Nothing is granted.
    Electron parks on any of these 4xx answers instead of retrying on the
    shared accountless-ownership budget. What the origin does not reproduce
    is listed in the
    [round 19 amendment](../decisions/2026-09-04-accountless-sharing-policy.md#google-cloud-cutover-amendment-2026-10-02).
  - v0.x uploads (a v0.1 or v0.2 envelope or upload-authorization format)
    answer d43c8f92's `403 TELEMETRY_TRANSPORT_BLOCKED` at the transport
    write-authority step, after the claim on `/api/v1/contributions`. An
    earlier refusal stays the Worker's own (for example `401
    UPLOAD_AUTH_INVALID` for an unknown upload authorization, or `401
    DEVICE_AUTH_INVALID` from the write authority).
- **(v) Assets get a JSON 404.** A request for an asset path that reaches the
  origin answers the Worker's JSON `404 NOT_FOUND`, not an HTML page. The
  edge serves the site's assets itself, so only a request the edge forwards
  by mistake sees it.
- **STATUS-REUSE: status answers are reused for up to 1 s.** Accepted by
  the owner in round 19 (2026-10-03) as a documented difference, beside
  (ii), (iii) and (v). Concurrent `/api/ready` and `/api/health` requests on
  one instance share a single evaluation, and a completed evaluation (ready
  or not ready) is reused for up to 1 s (`STATUS_REUSE_MILLISECONDS` in
  `cloud-run/postgres-readiness-dispatch.mjs`, from the wave-3 host
  design). A refusal such as `503 BACKEND_STORAGE_UNAVAILABLE` is never
  reused. The Worker evaluates every request, so OD-CR-4 ("`/api/ready`
  matches the Worker exactly") holds except for this reuse: a change to the
  lifecycle rows, the migration receipt or a typed pin can show on these
  two routes up to 1 s late, and in that second the stale answer can be
  `ready` as well as not ready. The storage-gated routes reread the receipt
  on every request and are not affected. Read `/api/ready` more than 1 s
  after the change it must reflect.

## 7. Local proof and the optional live check

### Local end-to-end (E12)

From `apps/worker`, under Node 22 (the image runtime), with a local
PostgreSQL 17 cluster. The spec imports the fast-path test-deploy script,
which reaches `src/edge-origin-contract.ts` through the rollout tooling, so a
Node 22 before 22.18 (such as 22.16.0) needs `--experimental-strip-types`;
without it the spec fails to load with `ERR_UNKNOWN_FILE_EXTENSION`. The
origin under test still loads from the bundled `cloud-run/dist`.

```bash
node cloud-run/build.mjs
PG_TEST_SOCKET=<local PostgreSQL 17 socket> PG_TEST_PORT=<port> \
  node --experimental-strip-types --test --test-concurrency=1 \
  postgres-test/edge-origin-e2e.spec.mjs
```

`npm run edge:e2e` runs the same two commands with the `node` on PATH, and
`npm run edge:e2e:check` runs the offline harness and live-check checks (also
part of `scripts:check`). Set `EDGE_E2E_GOLDEN=analytics-v2-test/golden` to
add the golden stage: the community/daily read, then the live check's write
tier against an origin with the settings the deploy gives it over a seeded
schema. It seeds through the fast-path rehearsal, whose importers
need a newer `node:sqlite` than Node 22.16 (`EDGE_E2E_REHEARSAL_NODE`, default
the `node` on PATH). The golden's withheld model dates are held to the
oracle's per-date expectation, as in `npm run gcp:fastpath:rehearsal`:
`EDGE_E2E_PER_DATE_EXPECTED`, which defaults to
`analytics-v2-test/golden-q1-node/per-date-expected.json` for the committed
Q-1 golden. `EDGE_E2E_EDGE_TREE=<edge-port worktree>/apps/worker`
builds the edge from that tree and refuses unless its
`src/edge-origin-contract.ts` is byte-identical. With it, S0 holds worker
mode to that tree's own `wrangler.jsonc` main and compatibility settings,
built from that tree, and expects the `isPostgresWorkerRequestPathSupported`
export only when that tree's `src/index.ts` re-exports it (the production
line's does not). The run takes about four
minutes (S4 waits for fresh rate-limit windows) and drops every schema it
creates.

- **It qualifies:**
  - the edge bundle running in workerd, in all three modes and the
    unconfigured state;
  - the real token-mint and forward path, against a synthetic token issuer and
    a Cloud Run front-end emulator;
  - EP-6 and the real fast-path origin on PostgreSQL 17;
  - shipped-client flows through the edge;
  - privacy and transparency assertions on every forwarded exchange, for the
    headers the edge's code and workerd send;
  - parity with the unchanged Worker on comparable rows, including admission
    under the checked-in production limits.
- **Behaviour it found that operators should know:**
  - workerd hands the edge's answer to an upload to the client only after the
    client's body has finished streaming into the forward, so a refused or
    limited upload is answered after its body is sent, not before (the Worker
    answers at once);
  - a client disconnect could not be shown to cancel the forward under
    Miniflare, so that cancellation is unproven;
  - the Worker's own upload budget (1200 starts per minute) sheds load before
    the 3000/60 ingress limits; the fast-path origin has no such budget.
- **It does not qualify:** Google's front end, Cloudflare's network and real
  client addresses (the headers Cloudflare adds to a subrequest for a
  non-Cloudflare host, which Miniflare does not add; the
  [edge IP probe](../../apps/worker/scripts/edge-ip-probe/README.md) observes
  those), Workers Rate Limiting across locations, Access, custom domains, the
  `HOST_MODE` production composition (CR-7; `postgres-production-host.spec.mjs`
  rehearses it locally) or production data. The edge-test origin already
  answers through the CR-6 handler and registry the production host uses.

### Optional live check (OD-E3)

The live check runs the local edge in gcp mode against the GCP fast-path test
origin. It adds Google's front end and nothing else. It needs owner
authorization in chat for each of these:

1. Redeploy the fast-path test origin as the direct edge-test variant over the
   seeded schema (`--schema=<seeded schema>`). This is a GCP write. The
   deployed sidecar variant has no origin boundary, so every response would
   map to 503. The deploy gives the origin the golden's
   `POSTGRES_SOURCE_ID` and `POSTGRES_SOURCE_NAMESPACE`, without which every
   typed route the write tier uses answers `503 BACKEND_STORAGE_UNAVAILABLE`,
   and, in edge-test mode, `wrangler.jsonc` env.production's
   `ENROLLMENT_MODE`, `ACCOUNTLESS_ENROLLMENT_MODE`,
   `ACCOUNTLESS_OWNERSHIP_MODE` and `SIGN_IN_START_MAX_PER_MINUTE`. Before
   the origin deploys, the origin step also ensures the runtime account's one
   conditional binding on the fast-path bucket and reads it back; without it
   `POST /api/v1/contributions` answers `503 BACKEND_STORAGE_UNAVAILABLE`. The
   seed and migrate steps grant the runtime role `EXECUTE` on
   `storage_journal_append` and `storage_owner_link_ensure`; without it the
   v1.2 domain activation answers 503. `/api/ready` is the Worker-shaped
   readiness (RD-2): it answers `503` until a lifecycle pass has run on the
   seeded schema.
2. Run the read-only tier:
   `node scripts/edge-live-check.mjs run --authorize=EDGE_LIVE_CHECK_READ_ONLY`.
3. Separately, run the write tier, which enrolls synthetic accountless devices
   and uploads through the edge into the seeded test schema:
   `--authorize=EDGE_LIVE_CHECK_WRITES`.

Both tiers also take the inputs E12 defines: the pinned test origin URL and
invoker account (`--origin-url`, `--invoker`), the expected body digest from
E12's golden stage on the same commit and seed (`--expected-body-sha`), the
golden directory (`--golden`) and a private receipt directory (`--out`). Any
other origin, invoker or authorization token is refused before gcloud runs.
`node scripts/edge-live-check.mjs plan` prints the steps and runs nothing.

The identity token comes from gcloud impersonation of the test project's
journey account and is held in memory only. Receipts hold statuses, header
names, digests and timings, never a token, a key, an email or an address.

To explain an origin `421`, read the edge-test origin's Cloud Run log (a
separate read-only GCP operation). Each refusal writes one content-free line,
`{"event":"edge_origin_boundary_refusal","reason":"<code>"}`, while the client
still gets the constant `421`. The production origin writes the same line.
The code names the refusal site, from `ORIGIN_REQUEST_REFUSAL_REASONS`
(`cloud-run/origin-node-request.mjs`, such as `host_mismatch`) or `EDGE_ORIGIN_BOUNDARY_REFUSAL_REASONS`
(`cloud-run/postgres-edge-origin-dispatch.mjs`, such as
`invoker_bearer_prefix_missing`, `invoker_segments` or `audience_mismatch`).
A refusal of the delivered `x-serverless-authorization` adds `invokerShape`:
whether it starts with exactly `Bearer `, its scheme kind (`Bearer`,
`bearer-case-variant`, `none` or `other`) and the spaces after it (capped at
4), its segment count, which segments are empty or base64url, and whether the
third is `SIGNATURE_REMOVED_BY_GOOGLE`. No line carries a header value, token,
email, host or path. A `421` without such a line did not come from the origin.

The origin accepts that header as RFC 7235 credentials: the Bearer scheme in
any ASCII case, one or more spaces, then the token. The edge sends `Bearer `,
but on 2026-10-01 the test origin received the header without that exact
prefix. The rule lives in `src/edge-origin-contract.ts`, so the edge and the
origin must deploy from commits with the same contract blob.
