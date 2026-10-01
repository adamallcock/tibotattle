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

- The contract is the proposed
  [thin Worker edge proxy decision](../decisions/2026-10-01-thin-worker-edge-proxy.md),
  pending owner sign-off.
- Cutover ordering belongs to PT-9's cutover runbook, which is planned and not
  yet written. Until it exists, the
  [GCP fast path plan](../plans/2026-10-01-gcp-fastpath.md#minimum-cutover-sequence)
  records the intended sequence. This runbook never decides order on its own.

## Never

- No load balancer in front of Cloud Run, no Transform Rule, no DNS change and
  no custom-domain removal or move. The three hostnames stay custom domains of
  the same Worker in every mode. Option A of OD-E6 (a Cloudflare-proxied
  origin hostname) would change this rule; it needs its own owner decision
  first.
- No guard-only Worker. The Sparkle appcast guard stays in the production
  Worker.
- No deploy from the checked-in `env.production`, and no raw `wrangler deploy`.
  Every edge deploy goes through the typed path.
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
- No gcp deploy runs until the owner has decided OD-E6. Cloudflare adds the
  client address, in `CF-Connecting-IP`, to every subrequest the edge sends to a
  `*.run.app` origin and to Google's token endpoint, and a Worker cannot remove
  it. An owner-authorized staging edge on Cloudflare's network must also have
  shown which address-bearing headers reach the origin for the chosen option,
  recording header names and whether each value is the edge's constant, never
  the values. See
  [the decision record, section 5](../decisions/2026-10-01-thin-worker-edge-proxy.md#5-client-address-privacy).
  E10 does not check this, so the operator must confirm it before the switch.
- Before the first production use of each mode, rehearse worker, fenced (with
  an EP-8 drill) and gcp on a staging Worker with its own hostnames, Access
  application and Cloud Run service. EP-9 provides a staging overlay for this.
  The owner provides the staging environment, and the cutover runbook places
  the rehearsal in its order.

## 2. Typed deploys per mode

Start from the guarded typed deployment in
[Production service operations](./production-operations.md#guarded-deployment-wrapper):
the live inventory, its pinned sha256 and the reviewed previous source. E10 adds
these flags to that command:

| Mode | Added flags | Typical use |
|---|---|---|
| `worker` | `--edge-mode=worker`; after a fence, also `--fence-receipt=<verified fence receipt> --fence-receipt-sha256=<its sha256>` | P1, the first edge-entry deploy; any later worker-mode redeploy; the abort |
| `fenced` | `--edge-mode=fenced` | Starting the fence; the brake from gcp |
| `gcp` | `--edge-mode=gcp --edge-plan=<private gcp plan> --origin-commit=<origin commit> --origin-verifier-account=<verifier account>` | The switch; gcp redeploys, including web-only releases |

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
   - Run `verify` after the plan's quiet window, at least 15 minutes after
     apply. Its fence receipt pins the D1 bookmarks and the R2 digest that the
     export must use.

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
- Gcp to worker is forbidden. The rollback policy after the switch is an open
  owner decision.

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

## 6. Releases and deploys in gcp mode

### Web-only releases

Web-only releases in gcp mode use the existing
[web-only release lane](./2026-08-17-web-only-release.md) on the edge-port line.
They need no Cloud Run redeploy. The deploy keeps the pinned gcp mode and plan,
and E10 applies the gcp rules:

- the predecessor and post-deploy identity come from the Cloudflare bindings;
- the contract blob at the release commit must equal the blob at the live
  origin commit;
- the candidate's privacy page must carry the marker.

Before the switch, a web-only release must not carry the marker. While fenced,
web-only releases pause.

### Cloud Run deploys

Every origin deploy must check that
`git rev-parse <origin commit>:apps/worker/src/edge-origin-contract.ts` equals
the same blob at the live edge commit, read from the Cloudflare
`DEPLOYMENT_SOURCE_COMMIT` binding. Refuse the deploy otherwise. The origin
deploy tooling does not implement this check yet.

A contract change has no in-place path: brake to fenced, deploy the origin,
then run the gcp deploy from an edge commit with the same blob.

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

## 7. Local proof and the optional live check

### Local end-to-end (E12)

From `apps/worker`, under Node 22 (the image runtime), with a local
PostgreSQL 17 cluster:

```bash
node cloud-run/build.mjs
PG_TEST_SOCKET=<local PostgreSQL 17 socket> PG_TEST_PORT=<port> \
  node --test --test-concurrency=1 postgres-test/edge-origin-e2e.spec.mjs
```

`npm run edge:e2e` runs the same two commands with the `node` on PATH, and
`npm run edge:e2e:check` runs the offline harness and live-check checks (also
part of `scripts:check`). Set `EDGE_E2E_GOLDEN=analytics-v2-test/golden` to
add the golden stage; it seeds through the fast-path rehearsal, whose importers
need a newer `node:sqlite` than Node 22.16 (`EDGE_E2E_REHEARSAL_NODE`, default
the `node` on PATH). `EDGE_E2E_EDGE_TREE=<edge-port worktree>/apps/worker`
builds the edge from that tree and refuses unless its
`src/edge-origin-contract.ts` is byte-identical. The run takes about four
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
  client addresses (in particular the `CF-Connecting-IP` Cloudflare adds to a
  subrequest for a non-Cloudflare host, which Miniflare does not add), Workers Rate Limiting across locations, Access, custom
  domains, the production origin composition (CR-6 and CR-7) or production
  data.

### Optional live check (OD-E3)

The live check runs the local edge in gcp mode against the GCP fast-path test
origin. It adds Google's front end and nothing else. It needs owner
authorization in chat for each of these:

1. Redeploy the fast-path test origin as the direct edge-test variant. This is
   a GCP write. The deployed sidecar variant has no origin boundary, so every
   response would map to 503.
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
still gets the constant `421`. The code names the refusal site, from
`EDGE_TEST_REQUEST_REFUSAL_REASONS` (`cloud-run/origin-edge-test-mode.mjs`,
such as `host_mismatch`) or `EDGE_ORIGIN_BOUNDARY_REFUSAL_REASONS`
(`cloud-run/postgres-edge-origin-dispatch.mjs`, such as
`invoker_bearer_prefix_missing`, `invoker_segments` or `audience_mismatch`).
A refusal of the delivered `x-serverless-authorization` adds `invokerShape`:
whether it starts with `Bearer `, its segment count, which segments are empty
or base64url, and whether the third is `SIGNATURE_REMOVED_BY_GOOGLE`. No line
carries a header value, token, email, host or path. A `421` without such a
line did not come from the origin.
