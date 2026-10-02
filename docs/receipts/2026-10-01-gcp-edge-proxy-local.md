---
title: GCP edge proxy local end-to-end
date: 2026-10-01
type: receipt
status: snapshot
---

# GCP edge proxy local end-to-end

This is a 2026-10-01 receipt for branch `claude/gcp-fp-edge`, built on
`claude/gcp-fastpath-final` `7ef0e144`. The E12 run recorded here is the tree
of code commit `b03bec59`. The Worker suite ran at `2948ddd1` and the other
gates at `f824355a`; the commits after those change only `scripts/edge-e2e`,
the E12 spec, package scripts and documentation, none of which those gates
load. The commit that adds this receipt changes documentation only. It
records **local, synthetic** evidence: one macOS arm64 workstation, workerd
through Miniflare `4.20260722.0` (the version wrangler `4.114.0` installs),
Node 22.16.0 for the end-to-end spec and the origin, Node 26.2.0 for the
repository tooling, and a local PostgreSQL 17 cluster on a private Unix
socket. Every key, token, account, address and row is synthetic and
content-free.

A later section, [review fixes](#review-fixes), records three review findings
against `4722c4a3`, the fixes in code commit `02841e26`, and the gates re-run
at that commit. Where it differs from the sections before it, it supersedes
them.

The [live check](#live-check) section records the owner-authorized live
check (OD-E3) run later the same day against the GCP test project, the four
defects only it found, and the commit that adds that section, which makes the
last two fixes permanent. The last section,
[Cloudflare-network address probe](#cloudflare-network-address-probe),
records an owner-authorized observation made on 2026-10-02 (UTC), after this
receipt's date, with a throwaway Worker on Cloudflare's network and a
temporary echo service in the GCP test project. Those two sections are the
only parts of this receipt that involve Google, GCP or Cloudflare's network;
the statements below that nothing called them hold for the sections before
them.

Nothing was pushed or deployed. No Cloudflare API, Google endpoint or GCP
resource was called, and wrangler ran only with `--dry-run` and without any
Cloudflare credential in its environment. This receipt does not qualify
Cloudflare's network, Google's front end, Workers Rate Limiting across
locations, Access, custom domains, the production origin composition (CR-6
and CR-7), production data, a staging rehearsal or the live check (OD-E3).

## What the branch holds

Merged without conflicts, in this order:

| Branch | Head | Item |
|---|---|---|
| `claude/gcp-fp-e5` | `dba10d89` | E5, the edge Worker entry and the release-guard nonce schema, on top of E4 (`2a7b8b7f` proxy core, `6d3d55a9` request-header ratchet) |
| `claude/gcp-fp-eorigin` | `d5327ba6` | EORIGIN, the fast-path origin behind EP-6 (`EDGE_ORIGIN_MODE=edge-test`) and its admission-order fixes |
| `claude/gcp-fp-e10` | `fe1ed615` | E10, the typed edge-mode deploy, reconcile and endpoint checks, on the cherry-pick `f2d0b5aa` of main's typed recovery |
| `claude/gcp-fp-e11` | `765040a7` | E11, the proposed decision record and the edge-mode runbook |

Integration commits on top:

1. `44c8de6a` classifies EORIGIN's origin-marker read in E4's header ratchet.
   It is a response read, so it joins the file-scoped response list; a request
   read of the marker anywhere else still fails.
2. `8a4e0763` keeps the edge entry's main-module exports to functions (see
   finding 1).
3. `f211d96f` delivers the edge-test origin's early answers instead of
   resetting them (finding 2).
4. `c8220eb8` authenticates the accountless v1.2 grant before reading its body,
   as `d43c8f92` does (finding 3).
5. `2948ddd1`, `c3dfe89b`, `f824355a` and `b03bec59` add E12 (below).
6. `6a48a23b` reconciles the decision record, the runbook and the fast-path
   plan with E10 and E12.

## Hand-offs applied

- E4 and E5's E12 items: real `fetch` with `cache: "no-store"` and
  `redirect: "manual"` runs in workerd (every forward in the run); request body
  framing (finding 6); client-disconnect cancellation (finding 5); the Access
  JWKS read and the seven Cloudflare GraphQL reads of an owner overview on a
  production-`ENVIRONMENT` edge go through the edge's single network path (S2);
  workerd hands every request of an isolate the same env object, sequential or
  concurrent, so E5's per-env proxy cache imports the invoker key once (S0).
- E5: gcp mode without a canonical `PUBLIC_ORIGIN` answers
  `503 EDGE_NOT_CONFIGURED` in the bundle as in the spec (S0).
- EORIGIN: EP-6's two checks now run in `cloud-run`'s `check`.
- E10: `scripts:check` now runs `production-edge-mode.check.mjs`, and also
  EP-8's `cloudflare-writer-fence.check.mjs` and EP-9's
  `edge-mode-configuration.check.mjs`, which no script registered.
- E11: the runbook now carries E10's real flags, refusal codes and abort order
  and E12's commands; the decision record states the merged state and E12's
  findings; the fast-path plan's edge rows drop the withdrawn device-sync
  admission patches. The conditional supersession note in the 2026-08-04
  ingress decision (`003fa639`) is kept as written.
- E12's `package.json` items: `miniflare` `4.20260722.0` is an explicit
  devDependency (the lockfile changes only the root entry, as `npm install
  --package-lock-only` produced it), plus `edge:e2e` and `edge:e2e:check`.

Not applied here, by design: the edge-port branch (OD-E1). The edge files must
be cherry-picked to a line that contains `d43c8f92`, now including
`src/edge-entry-env.ts` (integration commit `8a4e0763`).

## E12

`apps/worker/postgres-test/edge-origin-e2e.spec.mjs` runs the bundle that
wrangler builds from `src/edge-entry.ts` (with `--dry-run`) in workerd, in gcp
mode, against `cloud-run/dist/server.mjs` in fastpath-test with EP-6 in front,
on a fresh `tibotattle_fastpath_edge_e2e_<8 hex>` schema pair. The edge's only
network is `scripts/edge-e2e/google-front-end.mjs`: a token issuer that checks
the edge's RS256 JWT-bearer assertion, and a Cloud Run IAM front-end emulator
that checks the ID token, replaces its signature with
`SIGNATURE_REMOVED_BY_GOOGLE`, adds Google's headers and records every
exchange. The unchanged Worker, the same bundle in worker mode with full D1,
R2, Durable Object and rate-limit storage, answers every comparable row,
pairwise and from the same `CF-Connecting-IP`.

The recorded run, at `b03bec59` with `EDGE_E2E_GOLDEN=analytics-v2-test/golden`,
passed 15 of 15 tests in 4 minutes 59 seconds. It recorded 3,928 forwarded
exchanges with 3,928 distinct request ids, 3 ID-token exchanges (one per
forwarding edge isolate), no transport retry, and no leftover schema.

| Stage | What it showed |
|---|---|
| S0 modes | Fenced: barrier health, and `503 MUTATION_BARRIER_ACTIVE` with `retry-after: 300` on API, admin, guard and `www` API paths, assets still serving. Absent and cased modes and four invalid gcp settings (short client-key secret, http upstream, no invoker key, no `PUBLIC_ORIGIN`): assets and `www` serve, every other request `503 EDGE_NOT_CONFIGURED` with `retry-after: 60` and exactly one `{"level":"warn","code":"EDGE_NOT_CONFIGURED"}` line, with no token request and no exchange. Worker mode answers ten sample requests byte for byte like the checked-in `main` (`src/cloudflare-entry.ts` on this line), request ids masked |
| S1 local | 25 rows equal the Worker with no exchange: the `www` redirects (including `//evil.example/x`), assets and the 404 page, admin UI and the six admin APIs on the apex, the Apple path, unknown API paths and `DELETE /api/v1/me`, four 405s with their `Allow`, and `503 PUBLICATION_DISABLED` |
| S2 admin | No, malformed, wrong-audience, wrong-key and non-owner Access tokens equal the Worker's 403s. Owner UI and assets are byte-equal. Owner admin-overview GET and POST and an admin-host community read are forwarded with host kind `admin`, the Access assertion only when it came as the header, and the cookie; the origin answers its unported 503. The production-`ENVIRONMENT` row is in the hand-offs above |
| S3 forwarded | Every Worker-comparable refusal matches, including the envelope key byte for byte, the device-sync 401s, the contribution 401, 413 and 415 answers under both framings, the community-daily 400s and the accountless session-cookie 401. A sweep of every forwarded (route, method) pair matches EORIGIN's served list, with the admission header exactly on EP-1 routes. Verifier health is 200 and readiness the unported 503, both marked; a tokenless or unknown account gets Google's unmarked 401 or 403 |
| S4 admission | At the checked-in `env.production` limits, one route per purpose is limited exactly after its client limit (5 attempts, 120 public reads) and every EP-1 route the origin serves matches the Worker pair by pair; coarse exhaustion matches after 20 addresses for RECOVERY and ENROLLMENT; the d43c8f92 order rows while limited match; upload authorization is never limited at the edge. Ingress: the edge admits 3,000 uploads from one address and limits the 3,001st (the Worker compared on the first 1,000, finding 7); a 100/60 pair matches the Worker on the client, coarse and preflight-while-limited rows |
| S5 flows | The shipped clients run through the edge to their directly proven outcomes and re-run without new rows: v1.1 and v1.2 for a social and an accountless owner, a 12-chunk v1.0 backfill with a replay, a v0.1 prepared contribution with a replay, and session, pairing create and claim, device list, revocation, disconnect and logout (its `Set-Cookie` passed through) |
| S6 failures | Origin unreachable, headers after 6.5 s (timeout 5 s), unmarked 401, 403, 429, 503 and 302, and a token-endpoint 500 in a fresh isolate each give `503 EDGE_ORIGIN_UNAVAILABLE` with `retry-after: 60`, `no-store` and one content-free warn line with the right code; the token failure is negative-cached; a marked origin 500 passes through byte for byte |
| S7 privacy | On every exchange: forwarded header names are the contract's plus the platform's `cf-worker` zone header and the `cache-control`/`pragma` pair workerd renders for `cache: "no-store"`; no client address or any of its rate-limit HMACs anywhere; fresh UUID v4 request ids; no callback query on a URL. The gcp edge's decoy `USAGE_MONITOR_DB` and `QUARANTINE` stayed empty |
| S8 guard | A signed appcast POST answers 200 equal to the Worker, writes the same appcast, leaves only the nonce table in the release-guard D1, and a replay is refused equally; nothing is forwarded |
| S9 golden | Seeded by the Q-2 rehearsal on this commit with `--keep-schema` (status `gate_failed` on the known `model-days` 91 differences). Through the edge, `community/daily` returns 396,337 bytes, `public, max-age=300`, sha256 `a27aee711cabc056eea2ecb5c89b7f4de3ec4a9f85b72455057c1f760ffa680d`, byte-equal to the origin's recorded answer and to a direct origin read, and its parity family table equals the rehearsal's |
| S10 detectors | A rewritten admission purpose, a stripped origin marker, an injected client-key header and an account outside IAM are each caught, and the same row passes again once the fault is removed |

`scripts/edge-live-check.mjs` plans the owner-authorized live check and
refuses to run without the exact tier token, the pinned origin and invoker,
the inputs and `gcloud`. It was not run; its offline check proves the token
never reaches stdout, stderr, the receipt or an error.

## Findings

1. **Fixed: workerd would not start the edge bundle.** With
   `src/edge-entry.ts` as the main module, workerd refused the string-constant
   export `EDGE_GUARD_DB_STATEMENT_REFUSED` ("Incorrect type for map entry ...
   not of type 'function or ExportedHandler'"). The wrangler dry run and the
   vitest specs, which import the module rather than run it as `main`, could
   not see it, so a real deploy would have failed at startup. The env builders,
   the guard facade and their constants moved, unchanged, to
   `src/edge-entry-env.ts`; E5's spec gains a ratchet that every named export
   of the entry other than `default` is a function, and the dry run checks the
   bundle's exports.
2. **Fixed: a chunked contribution over 2 MiB reached the edge as 503.** The
   Worker answers `413 BODY_TOO_LARGE`. The edge-test origin's lazy body
   cancelled through `Readable.toWeb`, which destroys the socket, so the 413 was
   never written; and Node closes a connection as soon as an answer is written
   before the body has arrived, which lost the answer to a reset in 4 to 8 of
   20 local attempts. The body now reads through
   `req.iterator({ destroyOnReturn: false })`, and `serve()` lingers for the
   rest of the body (at most 15 s) before it closes. The non-edge
   `requestFromNode` path keeps `Readable.toWeb` and has the same reset; it is
   left for the production composition.
3. **Fixed: the accountless v1.2 grant read its body before authenticating.**
   With an unknown credential and an invalid body the origin answered 400 where
   `d43c8f92` answers `401 DEVICE_AUTH_INVALID` (index.ts:780-789). The ownership
   route keeps its body-first order, which is production's.
4. **Deviation: an upload refused before its body is read is answered once the
   body has been sent.** In workerd, the origin's early 429 reached the edge at
   once, but the edge's answer reached the client only when the held body
   closed (2,003 ms for a 2,000 ms hold; the Worker answered in 1 ms). Recorded
   as deviation 9 in the decision record.
5. **Unproven: client-disconnect cancellation.** A client that disconnects did
   not cancel the edge's forward under Miniflare, and a minimal Worker behaved
   the same with and without the `enable_request_signal` compatibility flag, so
   this local setup cannot show it either way.
6. **Body framing (F10).** workerd forwards a body with the client's
   `Content-Length` when the client declared one and chunked otherwise
   (3,582 exchanges with a length, 1 chunked, 345 without a body). After an
   early answer, workerd stops sending a chunked body and would otherwise reuse
   that connection; the front-end emulator closes it with a lingering close, as
   a front end would.
7. **Origin-tier gap: the upload budget.** The Worker's own upload budget (a
   Durable Object capped at 1,200 starts per minute) refuses before its
   3,000/60 address limiters can. The fast-path origin has no equivalent
   budget, so beyond 1,200 uploads a minute the two would differ. The decision
   moves that budget to PostgreSQL; the production composition must carry it.
8. **Reference limitation, not a production difference.** On empty stores the
   reference Worker (checked-in `json` storage mode, D1 aggregates) reports
   `allowanceReadState: confirmed` with `public, max-age=300`, where the origin,
   like production's typed read, reports `temporarily_unavailable` with
   `no-store`. S4 therefore compares admitted community reads on their verdict
   only.
9. **Observation: unregistered envelopes.** For an unregistered envelope with an
   unknown `Upload` authorization the origin answers 400, where the Worker
   claims first and answers 401. The origin keeps its pinned pre-change refusal
   on purpose (the fast-path spec's case c); no S3 or S4 row depends on it.

## Gates

| Gate | Result |
|---|---|
| Worker vitest, default config (`npx vitest run`) | 176 of 177 files and 2,352 of 2,353 tests pass in 1,019 s. The one failure is the recorded `storage-graph-history-integration` case, failing as on the base; the one added test is the export ratchet |
| `npx tsc --noEmit` (apps/worker) | Exit 0 |
| `cloud-run`: `npm run check` with the local PostgreSQL 17 env | Exit 0: 276 node:test tests, 275 pass and 1 skipped (the opt-in A2 activation case), plus the plain checks including `host.check.mjs` |
| `npm run postgres:domain:check` with the same env | Exit 0: vitest 75 pass and 1 skip; node:test 336 tests, 334 pass, 2 skipped by design |
| `npm run scripts:check` (apps/worker) | Exit 0: 24 node:test suites, 1,053 pass, 0 fail, including the edge-mode dry run |
| E10's gate suites (`edge-mode-configuration`, `production-edge-mode`, `production-deploy`, `production-reconcile` checks) | 106 of 106 |
| `npm run deployment:endpoints:check` | Pass |
| E12 spec (Node 22.16.0, `--test-concurrency=1`, golden stage on) | 15 of 15 |
| `edge:e2e:check` (harness and live-check checks, edge-mode dry run) | 12 of 12, and the dry run passes |
| Edge-mode dry run (`node scripts/edge-e2e/edge-mode-dry-run.mjs`) | worker, fenced and gcp candidates each bundle with `wrangler deploy --env production --dry-run`; gcp keeps only the release-guard D1 and the Sparkle bucket as storage; every bundle exports only the handler and functions |
| Repository root `npm run architecture:check` | Passed: 921 production files, 3,934 imports, 0 debt edges |
| Repository root `npm run test:preflight`, with this receipt in place | Exit 0: documentation governance valid across 303 Markdown files; 20 of 20 governance and guidance tests |

## Open

- OD-E1: cut the edge-port branch from a line containing `d43c8f92` and
  cherry-pick EP-0 to EP-3, EP-9, E4 `2a7b8b7f`, E5 `dba10d89`, the
  `src/edge-entry-env.ts` move `8a4e0763`, the release-guard migration and
  E10; rerun E4's and E5's gates and the edge-mode dry run there, and E12 with
  `EDGE_E2E_EDGE_TREE`.
- OD-E2 to OD-E5 and the decision sign-off stay with the owner. OD-E3, the live
  check, needs a GCP write to redeploy the test origin as the direct edge-test
  variant.
- The non-edge origin request path keeps the early-answer reset (finding 2),
  and the origin has no upload budget (finding 7); both belong to the
  production composition (CR-6 and CR-7).
- Client-disconnect cancellation is unproven (finding 5).
- A gcp deploy stays blocked by design until the production origin serves
  Worker-shaped `/api/health` and `/api/ready` (F8), and, separately, until the
  owner re-runs the address probe from the `tibotattle.com` zone and records a
  pass (OD-E6). The 2026-10-02 run from `workers.dev` found no visitor address
  reaching the origin
  ([Cloudflare-network address probe](#cloudflare-network-address-probe)).
  E10 has no code check for OD-E6.
- The edge port must also carry `02841e26`: the edge files it changes, the new
  `src/edge-google-subrequest.ts`, and the `export` keyword and two comment
  lines it adds to `contributionRequestPreflight` in `index.ts`. Otherwise
  `d43c8f92`'s copy of that function, and of `hasSessionCookie` and
  `assertSameOrigin` in `session.ts`, is identical to this line's.
- The planning spec `design/specs-v2/edge-thin-proxy.json`, outside this
  repository, still states the withdrawn privacy claim.
- The base's `storage-graph-history-integration` failure is unchanged and
  unrelated.

## Review fixes

A review of `4722c4a3` raised three findings. Each was checked against
`d43c8f92`, the branch code and Cloudflare's documentation before any change.
Code commit `02841e26` holds the fixes and the corrected decision record,
runbook and plan. The commit that adds this section adds two clarifications
to the decision record, on the evidence level of the exposure and on logging,
and changes documentation only.

1. **Blocker, confirmed: Google receives the client address.** Cloudflare's
   [HTTP headers reference](https://developers.cloudflare.com/fundamentals/reference/http-headers/),
   read on 2026-10-01, says that a Worker subrequest to a host outside any
   Cloudflare zone carries the client's address in `CF-Connecting-IP` and
   `x-real-ip`, and that a Worker can change only `x-real-ip`. Both edge
   subrequests to Google are of that kind: the forward to the `*.run.app`
   origin and the ID-token exchange, which runs inside a client request. The
   decision record's "no raw client address reaches Google" was therefore
   false for its own topology, and no Worker code can make it true there.
   - Fixed in code: the edge sets `x-real-ip` to the constant
     `2a06:98c0:3600::103` on both subrequests (`src/edge-google-subrequest.ts`),
     the one header a Worker can set.
   - Fixed in tests: S7 now requires exactly that value, once, on every
     exchange, instead of forbidding the header name. S10 shows S7 catching a
     client-valued, a missing and a repeated `x-real-ip`. The proxy and
     token-source specs pin it too.
   - Fixed in documents: section 5 of the decision record withdraws the claim
     and states the exposure. A new owner choice, OD-E6, is either a
     Cloudflare-proxied origin hostname (a contract, template and DNS change)
     or acceptance with disclosure. Section 11 blocks the gcp switch on OD-E6
     and on a probe on Cloudflare's network. Section 12 ties the privacy-page
     text to the outcome. The runbook and the plan say the same.
   - Still open: OD-E6 and the probe. S7's claim boundary is now written down:
     Miniflare adds none of Cloudflare's subrequest headers, so E12 proves only
     what the edge's code and workerd send.
2. **Minor, confirmed: the edge's 8 MiB cap pre-empted the Worker's earlier
   refusals.** At `4722c4a3` a 9 MiB contribution with `text/plain` or a
   session cookie got the edge's `413` where `d43c8f92` answers `415` or `401`.
   - Fixed for every refusal the Worker gives before its limiter from the
     request alone. `EDGE_PRE_ADMISSION_GUARDS` runs before the cap and before
     admission: a session cookie on the five accountless routes
     (`401 AUTH_INVALID`), `assertSameOrigin` on `enroll` and both sign-in
     starts (`403 CSRF_INVALID`), and the Worker's own
     `contributionRequestPreflight` on `contributions`. `index.ts` now exports
     that function and the entry injects it, so the edge-port branch adds one
     `export` keyword to `d43c8f92`'s `index.ts`.
   - What remains is deviation 3, now stated route by route. On other body
     routes the Worker can still refuse first, on stored state, its limiter,
     authentication or `admin_action`'s CSRF or content type.
3. **Minor, confirmed: refused requests spent edge budget.** At `4722c4a3`,
   every request on a policy route charged the per-address and global
   limiters, including requests `d43c8f92` refuses before its limiter.
   - Fixed for the request-only refusals by the same guards: they no longer
     reach admission.
   - Still deviation 4: the refusals that read configuration or stored state
     (accountless modes, collection controls, the sign-in start switch,
     admission bindings) still come after the edge's charge. Deviation 4 now
     states the cross-request effect: a later request the Worker would admit
     can get `429` within the same 60-second window. Deviation 10 records that
     the contribution preflight runs without the Worker's ingress
     configuration checks.

New proof:

- `test/edge-pre-admission-guards.spec.ts` checks the guard map against
  `handleRequest`. It runs every EP-1 policy route and registry method with 21
  request variants (567 comparisons), under a permissive configuration and
  migrated storage. Wherever the Worker refuses before its limiter, the edge
  must give the same status, headers and envelope locally, with no limiter call
  and no forward. Everywhere else it must charge and forward, apart from the
  8 MiB cap.
- Two mutation checks were each caught, then reverted: disabling the guards
  (6 tests failed across the two specs) and removing one map entry
  (`identity_apple_start`, which the differential spec names).
- E12 now answers these rows at the edge (`local`), each equal to the Worker:
  - the five contribution preflight rows;
  - 9 MiB with `text/plain` (415) and with a session cookie (401);
  - accountless enrollment and renewal with a session cookie, the enrollment
    one also at 9 MiB (401);
  - a foreign-origin `enroll`, an origin-less Google start and a cross-site
    Apple start (403).
- New S4 rows show that refused requests spend no budget. From one address,
  14 refused attempts (session-cookie enrollments and foreign-origin `enroll`)
  at the production limit of 5, then requests both sides admit with
  `v1;enrollment;allowed`. Then 102 refused uploads against a 100/60 pair,
  followed by an upload both sides admit.
- The S3 sweep now sends a same-origin header, so every forwarded pair still
  reaches the origin.

E12 at `02841e26` (Node 22.16.0, golden stage on) passed 15 of 15 in 6 minutes
18 seconds:

- 3,925 forwarded exchanges, with 3,925 distinct request ids;
- framing: 3,579 with a length, 1 chunked and 345 without a body;
- 3 ID-token exchanges;
- S9 byte-equal: 396,337 bytes, sha256
  `a27aee711cabc056eea2ecb5c89b7f4de3ec4a9f85b72455057c1f760ffa680d`.

Three 9 MiB rows each needed one transport retry. These are the local client
race that `b03bec59` records: undici reports "fetch failed" when an early
answer closes the connection while the body is still being sent. Each retry
then matched the Worker.

### Gates at `02841e26`

| Gate | Result |
|---|---|
| E12 spec (Node 22.16.0, `--test-concurrency=1`, golden stage on) | 15 of 15, figures above |
| Worker vitest, default config (`npx vitest run`) | 177 of 178 files and 2,363 of 2,364 tests pass in 909 s. The one failure is the recorded `storage-graph-history-integration` case, as on the base. The 11 added tests are 9 in the proxy spec and 2 in the guard-map spec |
| `npx tsc --noEmit` (apps/worker) | Exit 0 |
| `cloud-run`: `npm run check` with the local PostgreSQL 17 env | Exit 0: 276 node:test tests, 275 pass and 1 skipped (the opt-in A2 activation case), plus the plain checks including `host.check.mjs` |
| `npm run scripts:check` (apps/worker) | Exit 0: 24 node:test suites, 1,053 pass, 0 fail, including the edge-mode dry run and E10's gate suites |
| `npm run deployment:endpoints:check` | Pass |
| `npm run postgres:domain:check` with the same env | Exit 0: vitest 75 pass and 1 skip; node:test 336 tests, 334 pass, 2 skipped by design |
| `edge:e2e:check` | 12 of 12; the dry run passes with `contributionRequestPreflight` in each bundle's exports |
| Repository root `npm run architecture:check` | Passed: 922 production files, 3,937 imports, 0 debt edges |
| Repository root `npm run test:preflight`, with this section in place | Exit 0: documentation governance valid across 303 Markdown files; 20 of 20 governance and guidance tests |

## Live check

On 2026-10-01, between about 21:16 and 22:38 UTC, the orchestrator ran the
OD-E3 live check with the owner's authorization for each GCP write. The edge
ran locally in workerd in gcp mode (`scripts/edge-live-check.mjs`). Its
forwards and its ID-token exchange went through Google's front end to the
fast-path test origin, `tibotattle-fastpath-test-origin` in project
`tibotattle` (us-east1). The origin was the direct edge-test variant over the
seeded schema `typed_legacy_transfer_rehearsal_target_fastpath_cd40451d`.
Every device, key and row was synthetic. The live receipts hold statuses,
header names, digests and timings; this section copies only statuses,
digests and artifact identities.

This qualifies Google's front end with a local edge: the impersonated ID
token, the Cloud Run invoker check, the delivered `x-serverless-authorization`
and Google's own headers. It does not qualify Cloudflare's network, Workers
Rate Limiting across locations, Access, custom domains, the production origin
composition (CR-6 and CR-7) or production data. OD-E6 and the probe on
Cloudflare's network for the address-bearing headers
([review fixes](#review-fixes), finding 1) remained open at the time; the
probe ran on 2026-10-02
([Cloudflare-network address probe](#cloudflare-network-address-probe)).

### Origin revisions

All are in project `tibotattle`. Images are in
`us-east1-docker.pkg.dev/tibotattle/tibotattle-test/tibotattle-host`.

| Revision | Image | Origin settings | Live result |
|---|---|---|---|
| `00005-4sc` | from `4aab26ed`, `sha256:c9cba350…` | edge-test, closed admission defaults | Every forwarded request got the origin boundary's constant `421`, without a logged reason |
| `00006-j6m` | from `b754017f`, `sha256:84cd4ccc…` | as above | Every request refused with the logged reason `invoker_bearer_prefix_missing` (defect 1) |
| `00007-brw` | from `417dd594`, `sha256:63324fb8504ce3a0da18a82029ad5069603c814323fa9a6a9ad2d52924392043` | as above | The read-only tier passed (below) |
| `00008-rcg` | the same image | adds `ENROLLMENT_MODE`, `ACCOUNTLESS_ENROLLMENT_MODE` and `ACCOUNTLESS_OWNERSHIP_MODE` at production's values | Enrollment, ownership and the v1.2 authorization `201`, then `503 BACKEND_STORAGE_UNAVAILABLE` at the v1.2 sync capabilities (defect 2) |
| `00009-cmx` | the same image | deployed by `a6602516`'s tooling: the golden's `POSTGRES_SOURCE_ID` and `POSTGRES_SOURCE_NAMESPACE`, and all four production settings | The write tier reached the contribution and the domain activation, each `503` until defects 3 and 4 were fixed by hand, then passed (below) |

### The passing tiers

The read-only tier passed at 22:02:58 UTC on `00007-brw` with 11 rows:

| Row | Status | Answered by |
|---|---|---|
| `/api/health` | 200 | the origin, through the edge |
| `/api/ready` | 503 `POSTGRES_TEST_ROUTE_UNSUPPORTED`, by design (F8, below) | the origin, through the edge |
| `/api/v1/envelope-key` | 200 | the origin, through the edge |
| `/api/v1/community/daily` | 200, sha256 `a27aee711cabc056eea2ecb5c89b7f4de3ec4a9f85b72455057c1f760ffa680d`, byte-identical to the E12 golden answer (S9) | the origin, through the edge |
| Device sync with no bearer, and with an unknown bearer | 401 and 401 | the origin, through the edge |
| `www` redirect, asset, unknown API, admin without Access | 308, 200, 404 and 403 | the local edge, with nothing forwarded |
| The origin URL requested directly without a token | 403 | Google's front end |

The write tier passed at 22:38:06 UTC on `00009-cmx` with 22 rows: the same
11, with the same statuses and community digest, then 11 written through the
edge into the seeded schema:

| Row | Status |
|---|---|
| Accountless enrollment | 201 |
| Accountless ownership | 201 |
| v1.2 authorization | 201 |
| Shipped v1.2 sync: capabilities | 200 |
| Predecessor | 201 |
| Day manifests | 201 |
| Envelope key (body equal to the read-only row's) | 200 |
| Upload authorization | 201 |
| Contribution | 202 |
| Capabilities again (body equal to the first read) | 200 |
| Domain activation | 201 |

### Defects only the live check found

1. **Cloud Run delivers `x-serverless-authorization` without the exact
   `Bearer ` prefix the contract pinned.** The local front-end emulator sent
   it as the edge did, so E12 passed. Fixed in code commit `417dd594`: the
   shared contract (`src/edge-origin-contract.ts`) reads the header as RFC 7235
   credentials. `b754017f` first made each boundary refusal name its reason.
2. **The seeded-schema origin had no source identity and ran closed admission
   defaults.** Every typed route answered `503 BACKEND_STORAGE_UNAVAILABLE`, and
   the participant write routes ran at the composition's closed defaults. Fixed
   in code commit `a6602516`: the deploy gives a seeded schema's origin the
   golden's source pair, and gives an edge-test origin the four admission
   settings from `wrangler.jsonc` env.production.
3. **The runtime service account had no access to the fast-path bucket.** Its
   only storage grant was the project custom role
   `projects/tibotattle/roles/tibotattleTestCleanupStorage`, conditioned to the
   A2 bucket, so `POST /api/v1/contributions` answered
   `503 BACKEND_STORAGE_UNAVAILABLE`. The orchestrator added a bucket-level
   binding by hand: that role, for the runtime account, with the condition
   `TiboTattleFastpathTelemetry` (the bucket itself and its `telemetry/`
   objects). The commit that adds this section makes it permanent:
   `scripts/gcp-fastpath-test-deploy.mjs`'s origin step ensures exactly that
   binding before the origin deploys. It reads the policy, adds the binding
   only when the runtime account holds none, reads it back, and refuses any
   other binding of that account and any public member. A dry run prints all
   three calls.
4. **The runtime database role could not execute the owner-journal
   functions.** Primary 0046 revokes `storage_journal_append` and
   `storage_owner_link_ensure` from PUBLIC. Both are SECURITY INVOKER and run
   as the request's role inside the v1.2 owner bridge (0055), v1.1 live
   admission (0060) and legacy contribution admission (0061).
   `grantAndVerifyTestRuntimePrivileges` granted only
   `insert_telemetry_v1_contribution`, so
   `POST /api/v1/me/telemetry-v12/domain-activate` answered 503. The
   orchestrator granted both by hand. The commit that adds this section fixes
   the routine (`cloud-run/test-migrations.mjs`), which the A2, benchmark and
   fast-path migrate Jobs and the fast-path seed all run:
   - it resets every direct routine grant to the runtime role in the schema;
   - it grants `EXECUTE` on exactly those three functions;
   - its read-back requires that the runtime role executes exactly those
     three among the schema's non-PUBLIC functions;
   - the read-back also requires that `storage_v11_bridge_backfill`,
     `storage_v12_bridge_backfill` and `typed_telemetry_restart_identities`
     exist, are non-PUBLIC and are closed to the runtime role.

   The seed applies the fix from the checkout. The migrate Jobs apply it only
   from an image built at that commit.

### Notes

- `/api/ready` answers `503 POSTGRES_TEST_ROUTE_UNSUPPORTED` in fastpath-test
  mode. This is the known F8 gap: a Worker-shaped readiness answer belongs to
  the production origin composition. Not changed here.
- The fast-path plan's integration checklist names
  `insert_telemetry_v1_typed_contribution`, which no promoted migration
  defines. LF-3 landed as TypeScript admission (`0061` and
  `src/postgres-legacy-contribution-admission.ts`), which calls the two journal
  functions directly. The runtime set is therefore
  `insert_telemetry_v1_contribution`, `storage_journal_append` and
  `storage_owner_link_ensure`.
- No production grant code exists on this line. OPS-2 is planned, and the
  EP-7 templates carry only the invoker binding. The plan's OPS-2 row now
  states both requirements: the runtime function grants with read-back, and
  the runtime account's production bucket grant.
- `scripts/gcp-test-database.mjs` has the same function gap. It is the older,
  generic Cloud SQL IAM qualification job, which the fast path does not use,
  and it grants only `insert_telemetry_v1_contribution`. It is recorded here,
  not fixed.

### Gates for the commit that adds this section

Local only, on the same workstation: Node 26.2.0 and the local PostgreSQL 17
cluster on a private Unix socket. No GCP or Cloudflare call was made, and
nothing was pushed.

| Gate | Result |
|---|---|
| New `postgres-test/postgres-test-runtime-grants.spec.mjs`, registered in `postgres:domain:check` | 1 of 1. A non-superuser, Cloud SQL-like migrator owns a fresh database and migrates both roles. Under the pre-fix grant the runtime role gets `42501` on both journal functions. After the routine it mints an owner link and appends a journal row. The three operator entrypoints stay `42501`, a stray direct grant is reset, and a PUBLIC re-grant fails the read-back. Run against `a6602516`'s routine, the spec fails at `storage_journal_append` |
| `cloud-run/test-migrations.check.mjs` | 16 of 16, including the policy and fail-closed cases |
| `npm run gcp:fastpath:scripts-check` with the PostgreSQL env | 29 pass, 1 skipped (the TCP case needs `PG_TEST_TCP_HOST`). Includes the deploy script's 14 checks: the rendered binding, idempotency, refusal of a different or extra binding and of public members, and dry-run order |
| `gcp-fastpath-test-deploy.mjs all --commit=HEAD --dry-run` | Exit 0. The bucket policy read, binding and read-back print before `run services replace` |
| `cloud-run`: `npm run check` with the PostgreSQL env | Exit 0: 286 node:test tests, 285 pass and 1 skipped (the opt-in A2 activation case) |
| `npx tsc --noEmit` (apps/worker) | Exit 0 |
| `node scripts/ci-postgres-suite.mjs --plan` | The new spec routes and registers cleanly. The two failures it reports exist at `a6602516` too: `edge-origin-e2e.spec.mjs` unregistered and `postgres-ingestion-journal-transfer.spec.mjs` ambiguous |
| Repository root `npm run architecture:check` | Passed: 922 production files, 3,937 imports, 0 debt edges |
| Repository root `npm run test:preflight`, with this section in place | Exit 0: documentation governance valid across 303 Markdown files; 20 of 20 governance and guidance tests |

## Cloudflare-network address probe

At about 02:10 UTC on 2026-10-02, with the owner's authorization, a throwaway
Worker on Cloudflare's network called a temporary Cloud Run service the way
the edge calls Google, to observe which headers carrying the client's address
reach the origin (OD-E6, [review fixes](#review-fixes) finding 1). This
section copies only header names, booleans and token counts. No address, salt,
hash or header value was returned, logged or stored.

- **The Worker:** `tibotattle-edge-ip-probe`, on the owner's `workers.dev`
  subdomain, not the `tibotattle.com` zone, and deployed by the owner. For
  `GET /probe` it read the inbound `CF-Connecting-IP` and fetched the echo with
  `x-real-ip` set to `2a06:98c0:3600::103` (the edge's
  `EDGE_SUBREQUEST_REAL_IP`), a fresh random salt in `x-probe-salt`, and the
  SHA-256 of salt plus address in `x-probe-visitor-hash`.
- **The echo:** `tibotattle-ip-probe-echo`, a public Cloud Run service in
  project `tibotattle` (us-east1). It answered with the sorted request header
  names and, for each address-like name, `equalsPlaceholder`,
  `containsPlaceholder`, `containsVisitor` (a token whose salted hash equals
  the visitor hash) and `tokenCount`.
- **Afterwards:** the echo service was deleted. Deleting the throwaway Worker
  is the owner's step; this receipt does not record it.
- **The code:** the probe that ran is now in
  [`apps/worker/scripts/edge-ip-probe/`](../../apps/worker/scripts/edge-ip-probe/README.md),
  renamed (`echo-server.mjs`, `probe-worker.mjs`, `wrangler.example.jsonc`).
  The echo's classification is unchanged but now sits in an exported
  `describeHeaders`, and the server starts only when the file is the entry
  module, so the offline check can import it. The example configuration
  replaces the run's `ECHO_URL` with a placeholder.

### Result

| Observation | Result |
|---|---|
| `visitorSeenByWorker` | `true`: the Worker had the visitor's `CF-Connecting-IP` |
| Header names that reached Cloud Run | `accept-encoding`, `cdn-loop`, `cf-ew-via`, `cf-ray`, `cf-visitor`, `cf-worker`, `forwarded`, `host`, `traceparent`, `x-cloud-trace-context`, `x-forwarded-for`, `x-forwarded-proto`, and the two probe headers |
| `cf-connecting-ip` | Absent |
| `x-real-ip` | Absent |
| `x-forwarded-for` | 2 tokens; contains the placeholder; does not contain the visitor |
| `forwarded` (added by Google's front end) | 4 tokens; does not contain the visitor |
| Any header containing the visitor's address | None |

With the edge's `x-real-ip` override, the `x-forwarded-for` that Google
delivered carried Cloudflare's placeholder, not the visitor's address, and no
header carrying the visitor's address reached the origin. For a `workers.dev`
Worker, "no client address reaches the origin" holds.

Not covered:

- a Worker on the `tibotattle.com` zone, as the production edge runs.
  Expected to behave the same for a non-Cloudflare host, but unobserved;
- the counterfactual without the override, which was not tested. The
  override and E12's S7 assertion of it stay load-bearing;
- the token exchange's endpoint, `oauth2.googleapis.com`, which gets the same
  kind of subrequest and the same override but cannot be observed this way;
- headers that Google's front end might receive and not deliver (the
  container is the observation point), the values of headers whose names are
  not address-like, and an IAM-private service (the echo was public).

### What the commit that adds this section changes

- The [decision record](../decisions/2026-10-01-thin-worker-edge-proxy.md)
  records the probe in section 5 and its boundary. OD-E6 now recommends
  keeping the direct `*.run.app` topology with the `x-real-ip` override, with
  no proxied-hostname rework. Sections 11, 12 and 15 turn the gcp-switch gate
  into an owner-run rerun of the probe from the production zone before the
  first gcp deploy, and keep options A and B as the fallbacks if it fails.
- The [edge-modes runbook](../runbooks/production-edge-modes.md) and the
  [fast-path plan](../plans/2026-10-01-gcp-fastpath.md) say the same.
- The probe is reusable tooling with a README covering its privacy design, the
  production-zone rerun and how to read the result. The new offline check
  `scripts/edge-ip-probe/echo-server.check.mjs` is registered in
  `edge:e2e:check`, beside the harness and live-check checks.
- The comments in `src/edge-google-subrequest.ts` and the E12 spec point to
  the probe. No code path changes.

### Gates for the commit that adds this section

Local only, on the same workstation, under Node 26.2.0. No GCP or Cloudflare
call was made, and nothing was pushed. The E12 spec was not re-run: its change
is a comment.

| Gate | Result |
|---|---|
| New `scripts/edge-ip-probe/echo-server.check.mjs` | 6 of 6. With the visitor match disabled in the echo, 1 of 6 fails |
| `npm run edge:e2e:check` (apps/worker) | Exit 0: 18 of 18 (harness, live-check and probe checks), and the edge-mode dry run passes |
| Vitest: `edge-request-header-allowlist`, `edge-google-id-token` and `edge-origin-proxy` specs, which load the edited source | 225 of 225 |
| `npx tsc --noEmit` (apps/worker) | Exit 0 |
| Repository root `npm run architecture:check` | Passed: 922 production files, 3,937 imports, 0 debt edges |
| Repository root `npm run test:preflight`, with this section in place | Exit 0: root workspace hygiene clean; documentation governance valid across 304 Markdown files; 20 of 20 governance and guidance tests |
