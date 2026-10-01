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
  Worker-shaped `/api/health` and `/api/ready` (F8).
- The base's `storage-graph-history-integration` failure is unchanged and
  unrelated.
