---
title: GCP L-LOADTEST OPS-11 load-test harness
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP L-LOADTEST OPS-11 load-test harness

This is a 2026-10-02 receipt for stream L-LOADTEST on branch
`claude/gcp-fp-l-loadtest`, built on `c80f99b9` (`claude/gcp-fastpath-final`).
The harness landed in `c973b75d`; a second commit answers that commit's review
(see "Review findings" below) and this receipt describes the result.
It records **local, synthetic** evidence only: one macOS arm64 workstation,
Node 22.16.0 (the image runtime) for the PostgreSQL spec and the dist bundle,
Node 26.2.0 for repository tooling and the offline check, and the local
PostgreSQL 17.10 fan-out cluster (port 55433) over its private Unix socket.
Nothing was deployed, migrated or read in any GCP or Cloudflare project. No
`gcloud` ran. Wrangler ran only as the E12 edge bundle builder's
`wrangler deploy --dry-run` with every credential variable removed. No
request left the machine. Every key, device, address and record is synthetic.

The owner decision implemented is OPS-11 (round 2 of
`owner-decisions-2026-10-02-answers.md`): a staging load test after D-CRB at
3,000 uploads a minute, plus a migrate-and-roll under load, on synthetic data.
This stream builds and proves the harness. It does not run the staging test,
which is the owner's protected operation and needs D-CRB and OWN-7b first.

## What changed

| Item | Change |
|---|---|
| `apps/worker/scripts/gcp-load-test.mjs` (new) | The load generator: target classification, dry-run plan with an admission prediction, enrollment, paced v1.2 uploads with the shipped client, the drill hook and the receipt. |
| `apps/worker/scripts/gcp-load-test.check.mjs` (new) | 25 offline checks: no network, PostgreSQL or Miniflare. A synthetic in-process v1.2 target answers the shipped client, and the only child processes are the rollout script's own dry runs. |
| `apps/worker/postgres-test/gcp-load-test.spec.mjs` (new) | 2 PostgreSQL 17 specs: the local proof through the edge e2e harness. |
| `apps/worker/scripts/edge-live-check.mjs` | Exports its request builders for reuse, behavior unchanged: `accountlessDeviceRequests` (the three accountless admission requests), `syntheticV12Day` (generalized to N chunks of M records; the default is byte-identical to the live check's day), `ACCOUNTLESS_V12_AUTHORIZATION`, `LABORATORY_ORIGIN` and `isCapabilityPath`. `liveWriteRows` (E12's S9) now composes them; a check pins its first three rows. |
| `apps/worker/package.json` | `gcp:load-test`, `gcp:load-test:check` (also run at the end of `edge:e2e:check`, so `scripts:check` covers it) and `gcp:load-test:local` (build, then the PostgreSQL spec). |

No migration, no DDL, no route, no edit to the host composition, the
dispatch, the infra manifest, the rollout script or any wave-4 area.

## The harness

`node scripts/gcp-load-test.mjs` with no flags is a dry run. It prints the
target class, the derived profile, the prerequisites and an admission
prediction from the committed limits, and makes no request, starts no process
and writes no file. A run needs `--execute`, `--out=<private directory>` and,
for any target but loopback, `--authorize=GCP_LOAD_TEST:<target hostname>`.

**Target rules.** Without `--target`, the target is the reviewed staging
origin (`DEPLOYMENT_ENDPOINTS.staging`). Any other target must be given with
`--target`. Production hostnames are refused outright with
`LOAD_TEST_TARGET_PRODUCTION`, whatever else is given, including case,
trailing-dot and port variants. The refused set is the public, www, admin,
updates and dogfood-release hosts, the production Worker's workers.dev name
and its preview names; a check pins it to include
`EDGE_MODE_PRODUCTION_HOSTNAMES`. Also refused: run.app origins
(`LOAD_TEST_TARGET_ORIGIN_DIRECT`, because the load goes through an edge's
public routes), http: off loopback, IP literals, paths, queries and
credentials. A supplied authorization must match even in a dry run. Outbound
traffic goes only to the target origin. A URL that does not resolve to it
aborts the run with `LOAD_TEST_OUTBOUND_REFUSED`. That covers another host and
also a path that would escape the origin, such as `//host`, `/\host` or a
tab or newline before `//host`. Percent-encoded separators stay on the target.

**Receipt directory.** `--out` is created 0700 when it is missing. Otherwise
it must be a real directory, not a symlink, owned by this user, with no group
or other access. Writability is proved by creating and removing a probe file.
All of this happens before the preflight request, so a bad `--out` costs no
run (`LOAD_TEST_OUT_INVALID`, `LOAD_TEST_OUT_NOT_PRIVATE`,
`LOAD_TEST_OUT_UNWRITABLE`). The directory is checked again just before the
receipt is written 0600, and the receipt never overwrites a file.

**Workload (defaults: 600 devices, 3,000 uploads a minute, 600 s).**

1. A preflight: `/api/health` must answer 200. `/api/ready` and the envelope
   key are recorded.
2. N accountless devices are enrolled through the public routes, paced by
   `--enroll-rate` and honoring Retry-After within `--enroll-timeout`: the
   enrollment, the ownership grant and the v1.2 authorization.
3. Each device syncs one synthetic v1.2 day with the shipped client
   (`runTelemetryV12Sync`). The pass covers capabilities, the predecessor,
   the day manifest, an upload authorization and a contribution per chunk,
   then the activation. Every envelope is sealed by the shipped
   `createTelemetryV12Envelope`. Uploads are paced to `--rate` overall with
   no burst credit, and spread evenly across devices (12 s apart per device
   at the defaults, under the staging per-principal limit of 6 a minute).
   Global slots lie on a fixed grid and each holds one upload. A device that
   is waiting out its own interval leaves the earlier slots to other devices.
   A pass stopped by a retryable refusal resumes after its Retry-After or a
   bounded backoff. A pass whose budget ends while it waits for a slot gives
   the slot back. A pass that the window's close stops is recorded as
   `window_closed`, not as a failure. An upload counts as paced only when its
   envelope reaches a pass that is still running. Records carry the parser version
   `synthetic-gcp-load-test`, so a staging operator can identify them. They
   stay in staging, because contributions are append-only.
4. **Drill.** `--drill=<file>` names a `gcp-load-test-drill-v1` file. Its
   steps are OPS-10 rollout invocations
   (`scripts/gcp-production-rollout.mjs migrate|roll`), checked by that
   script's own parser and accepted only with `--environment=staging`.
   Starting `startAfterSeconds` into the window, they run in order as child
   processes with no shell and no stdin. Their content-free output goes to
   the harness's stderr. A drill that has started runs every step until one
   fails, even if the load aborts, so a completed migrate is always followed
   by its roll. A step is never killed, and a failed migrate stops the roll.
   The drill runs only rollout steps. It does not cover OPS-11's
   maintenance-pass sub-check; see "Not covered" below.

**Receipt.** The receipt is written 0600 into a 0700 directory. It holds
latency percentiles (p50, p90, p95, p99 and max) per route and the status
mix. A non-2xx status is labelled with its closed error code. Both the API's
nested `{ error: { code } }` and the flat `{ error: "<CODE>" }` count; the
flat form is what today's origin sends for an unported route. So an unported
route (`503:POSTGRES_TEST_ROUTE_UNSUPPORTED` today, or the planned
`503:POSTGRES_ROUTE_NOT_PORTED`) and the storage gate's
`503:BACKEND_STORAGE_UNAVAILABLE` stay distinct. The receipt also holds:

- refusals by code, excluding the preflight;
- transport failures by kind;
- accepted uploads per minute, and whether the target was met (95 % or more);
- uploads paced, declined at the close, released at a pass's end, and
  discarded after sealing;
- pass outcomes, including `windowClosed`, and the device counts;
- with a drill, the before, during and after windows;
- a claim boundary that names what the run does not cover.

It never holds a device id, secret, bearer, envelope, record, body or client
address.

## Local proof

`gcp:load-test:local` ran the spec under Node 22.16.0 against the edge e2e
harness's local origin. The chain was: the generator, the edge bundle in
workerd in gcp mode, the Google front-end emulator, `cloud-run/dist/server.mjs`
in fastpath-test mode behind EP-6, and a fresh
`tibotattle_fastpath_l_loadtest_*` schema pair. The `tibotattle_fastpath_`
prefix is required by fastpath-test mode; the schemas were dropped after the
run and zero remain. After the review fixes, the spec passed four more
times, the last on the committed code; the figures below are from the first
of those runs.

**Run 1: 6 devices, 60 uploads a minute, 6 uploads each, a 60 s window,
per-device client addresses and the harness's generous edge limits.**

- Enrollment: 6 of 6 devices, and the enrollment phase's status mix was
  exactly `201` × 18.
- Uploads: 36 accepted (`202`), all inside the window. PostgreSQL agrees:
  36 `telemetry_v12_chunks` rows from 6 participants, and 6 domain heads for
  the 6 devices that completed and activated.
- Pacing: 41 uploads paced and 41 upload-authorization requests sent (36
  granted, 5 refused by the storage gate). None was discarded, and no pass
  failed with `index_unavailable`.
- Latency: contributions p50 27.7 ms and p99 95.5 ms; upload
  authorizations p50 13.1 ms and p99 24.9 ms.
- Drill: "migrate" appended a synthetic migration-history row, and the
  running revision's storage gate answered
  `503:BACKEND_STORAGE_UNAVAILABLE` 13 times (8 capabilities and 5 upload
  authorizations), all inside the drill window. "roll" started a new revision
  on a new port, removed the row (standing in for an image whose manifest
  carries the migration), moved the front end to it and drained the old
  revision. The windows were: before, 42 requests with no 5xx; during, 13
  storage-gate 503s; after, 67 requests, 23 uploads accepted and no 5xx.
- The storage gate was the only 5xx label in the load phase: there was no
  unported-route code and no bare 5xx. There was no transport failure, and
  13 passes resumed after `service_unavailable`.
- The preflight's `/api/ready` was answered with
  `503:POSTGRES_TEST_ROUTE_UNSUPPORTED`. The local fastpath-test origin does
  not serve that route. The preflight's answers are kept out of the refusals.
  Before the fix the flat body's code was lost and this showed as a bare
  `503`.

**Run 2: one client address through the checked-in staging edge-tier limits
(`wrangler.jsonc` env.staging), 3 devices.** `CLIENT_ATTEMPT_RATE_LIMIT`
allows 5 a minute per address and purpose. Six `accountless_ownership`
requests meant one device's v1.2 authorization was refused
(`429:ATTEMPT_LIMIT_REACHED`, Retry-After 60), so 2 devices enrolled. The
two passes needed more than five `device_sync` requests, so a day manifest
and a capabilities read were refused. The run accepted 3 uploads, and no
device activated. The refusals by code were `ATTEMPT_LIMIT_REACHED` × 3, and
the load phase had no 5xx.

Miniflare's limiter counts in fixed wall-clock minutes. The first spec run's
run 2 straddled a minute and let one device finish, so the spec now starts
run 2 early in a minute. Cloudflare's own limiter is per location, and
this is not a measurement of it.

## Finding for the owner: the committed limits cap OPS-11 far below 3,000 a minute

The dry run's admission prediction for the default profile, from one load
machine, against the committed limits:

| Control (scope) | Staging limit / demand | Production limit / demand |
|---|---|---|
| `CLIENT_ATTEMPT_RATE_LIMIT` device_sync (per address) | 5 / 900 | 5 / 900 |
| `RECOVERY_RATE_LIMIT` device_sync (per location) | 20 / 900 | 20 / 900 |
| `ENROLLMENT_RATE_LIMIT`, and `CLIENT_ATTEMPT` for enrollment (per location, per address) | 20 and 5 / 120 | 20 and 5 / 120 |
| `UPLOAD_INGRESS_REQUEST` and `UPLOAD_INGRESS_CLIENT` (per location, per address) | 240 and 20 / 3,000 | 3,000 and 3,000 / 3,000 (not exceeded) |
| Upload ingress budget (starts a minute) | 120 / 3,000 | **1,200 / 3,000** |
| `UPLOAD_AUTHORIZATION` (origin tier) | 300 / 3,000 | 3,000 / 3,000 (not exceeded) |
| `UPLOAD_PRINCIPAL` (per device) | 6 / 5 (not exceeded) | 3,000 / 5 (not exceeded) |

Sources: `wrangler.jsonc` env.staging and env.production (the edge tier),
and `cloud-run/postgres-production-configuration.mjs`. The staging values
come from `STAGING_ORIGIN_TIER_RATE_LIMITS` and `STAGING_CONTAINMENT_VARS`;
the production values come from `ORIGIN_TIER_RATE_LIMITS` and
`PRODUCTION_VARS`. These are committed values. The live production
configuration is rendered from the live inventory and was not read.

Two conclusions follow:

1. **The staging configuration needs a decision before OPS-11.** As
   committed, the staging edge and origin refuse most of a 3,000-a-minute
   run, so the measurement would mostly be of refusals. The staging service
   also needs `STAGING_ADMISSION_MODE=synthetic-rehearsal`, because
   accountless admission is closed by default.
2. **3,000 uploads a minute is above production's committed ingress
   budget.** That budget is 1,200 contribution starts a minute, with a burst
   of 1,200. The device_sync attempt limits (20 a minute per location, 5 per
   address) also bound how many sync passes any one location or address can
   start.

Whether those values are the intended production capacity is an owner
question. This receipt does not claim it is a defect.

## Review findings (second commit)

The review of `c973b75d` raised six findings. Each was reproduced or
checked against the code before anything changed. Each new check was run
against a copy of the old harness first, and it failed there.

1. **Outbound guard bypass (medium): fixed.** The old guard checked the URL
   prefix and then resolved the path against the target without checking
   the result. Probed with a fake fetch:
   - `<lab origin>//evil.example/api/health` was sent to `evil.example`;
   - `<target>//tibotattle.com/...` and `<target>/\tibotattle.com/...` were
     sent to `tibotattle.com`, and so was a path with a tab before `//`.
   No fatal was raised. The fix: the resolved URL's origin must equal the
   target's, or the run aborts with `LOAD_TEST_OUTBOUND_REFUSED`. A new
   check covers seven escape spellings on both the laboratory origin and the
   target, and confirms that encoded separators stay on the target.
   `edge-live-check.mjs` builds its URLs by string concatenation, so it
   does not have this hole.
2. **`--out` checked only after the run (low): fixed.** `main()` now
   prepares and checks the directory before the preflight, as described
   under "Receipt directory" above. A new check sends a file, a symlink, a
   path under a file, a 0755 directory and an unwritable 0500 directory
   through `main()`, and gets each refused with zero requests. It also
   checks a fresh 0700 directory, a 0600 receipt and a refusal at write time
   for a directory widened after the start.
3. **Unported-route 503 not labelled (low): fixed.** The origin's unported
   answer is flat: `{status:"not_ready",error:"POSTGRES_TEST_ROUTE_UNSUPPORTED"}`
   (`origin-edge-test-mode.mjs` `EDGE_TEST_UNPORTED_BODY`, and
   `postgres-test-dispatch.mjs`). `errorCodeOf` read only `error.code`.
   `POSTGRES_ROUTE_NOT_PORTED` existed only in the load-test files, so the
   spec's assertion that it was absent was vacuous. `errorCodeOf` now also
   reads a top-level closed-code string, and the spec now asserts that the
   load phase's only 5xx label is `503:BACKEND_STORAGE_UNAVAILABLE`. The
   drill's before and after windows count every 5xx, bare or labelled.
4. **Window-close artifacts (low): fixed.** This was confirmed through the
   shipped client: the old code, run through a window close, recorded a
   `failed` pass with `index_unavailable`. The fix has four parts:
   - each pass now carries its own signal, aborted when the pass returns, so
     a reservation it can no longer use is released;
   - an envelope that is sealed after its pass has ended is discarded and
     not counted;
   - the window's close wakes every waiter, and the pass is recorded as
     `window_closed`;
   - `paced` counts only envelopes handed to a running pass.

   Releasing a slot needed a pacer whose slots are not one monotonic
   pointer. That pointer had a second defect: a device waiting out its own
   interval pushed every later reservation behind it. At the defaults it
   left the first 12 s almost idle. In a simulation of 600 devices, only 2
   of the 600 slots in the first 12 s were used before the fix, and 599
   after it. The new pacer uses a fixed slot grid, takes the earliest free
   slot, gives released slots back, and still allows no burst. A new check
   runs `runLoadTest` through the window close against an in-process v1.2
   target, with 2 devices and a 3.25 s window. It recorded 2 `partial`
   passes cut by their budget in the pacer, 2 `window_closed` passes, no
   failed pass, 2 releases, and 7 uploads paced, 7 authorized and 7
   accepted.
5. **OPS-11 maintenance-pass sub-check not covered (low): recorded as a
   gap; the step type was not built.** An expected-refusal step cannot
   observe `POSTGRES_MIGRATION_CONFLICT` through OPS-10: `migrate` reports a
   failed migration Job only as `ROLLOUT_MIGRATION_FAILED` (exit 1), without
   the runner's code. A step keyed on that exit would accept any migrate
   failure. Starting a maintenance pass would also add a new `gcloud run
   jobs execute` surface to the harness, in an area that wave 4 owns (the
   maintenance pass and the infra manifest, whose `JOB_NAMES` does not yet
   list a maintenance job). The gap is now stated in three places: the
   harness header, the dry-run plan's `notCovered`, and every run receipt's
   claim boundary. The CLI drill path now has an end-to-end offline check:
   `main()` reads a drill file and runs both steps as real child processes
   of `gcp-production-rollout.mjs` in dry-run mode. Each step's exit code
   must equal the code from running the same argv directly. On this base,
   the staging dry run refuses `ROLLOUT_INFRA_MANIFEST_UNAVAILABLE` (exit
   1), so the drill stops after `migrate`.
6. **Guidance conflict (info): still open; it needs the owner.**
   `apps/worker/AGENTS.md` (lines 71-73) asks network harnesses for
   `--owner-access-file`. That fixture belongs to the local backend
   laboratory, and the accountless plane has no owner session in its
   admission path. `edge-live-check.mjs` sets the precedent of not using it.
   Narrowing a scoped guidance rule is not this stream's decision. One
   possible wording for the owner or a docs stream: *"Local-laboratory
   network harnesses must validate ... through `--owner-access-file` ...
   Accountless-plane harnesses (`edge-live-check`, `gcp-load-test`) admit
   only synthetic accountless devices and take explicit per-target
   authorization instead."*

## Not covered

- OPS-11's maintenance-pass sub-check (from C-MAINT). A migration Job that
  meets a running maintenance pass must refuse `POSTGRES_MIGRATION_CONFLICT`
  and then rerun cleanly. The owner runs it outside this harness, reading the
  code from the migration Job's log. The Cloud SQL advisory-lock fence
  through the IAM connector is likewise outside it.

## Gates

| Command | Result |
|---|---|
| `node --test scripts/gcp-load-test.check.mjs` (Node 26.2.0) | 25/25; the three timing-sensitive checks were repeated 3 times |
| The new checks run against a copy of the first commit's harness | 9 of 25 fail as expected: 8 fail and the pacer-release check is cancelled at its 30 s timeout, because the old pacer ignores the pass signal. They cover pacer gap-fill, pacer release and close, the flat error code (2), outbound escape, the summary counters, `--out` (2), and the window close (`failed:1, index_unavailable:1`). The CLI drill check passes on the old code, because it covers a gap rather than a defect. |
| Mutation spot checks from the first commit (production refusal, run.app refusal, preflight exclusion, staging-only drill, outbound fatal) | each removal fails a check |
| `npm run edge:e2e:check` (apps/worker) | pass, exit 0: harness and live check 18/18, the edge-mode dry run, and load test 25/25 |
| `PG_TEST_SOCKET=… PG_TEST_PORT=55433 node --test --test-concurrency=1 postgres-test/gcp-load-test.spec.mjs` (Node 22.16.0, after `node cloud-run/build.mjs`) | 2/2, four times after the fixes; no leftover schema |
| `npm run test:preflight` (root) | pass, exit 0 |
| `npm run architecture:check` (root) | pass: 928 production files, 3,977 imports, 0 approved debt edges |
| `npm run docs:check` (root) | pass: 318 Markdown files |

## Claim boundary and open items

- **Not proven:** staging, Cloud Run, Cloud SQL, Cloudflare's network and
  limiter, the OWN-7b staging edge, the D-CRB composition, a real OPS-10
  migrate or roll, and throughput at any rate beyond 60 a minute. The local
  origin pools hold 3 connections per role.
- **Prerequisites for the owner's run:** D-CRB (the staging service template
  and its origin-tier limits); OWN-7b (the staging edge in gcp mode, passed
  as `--target`, because the reviewed default staging origin is today's
  disabled-first staging Worker); the limits decision above; and the owner's
  authorization in chat for the target and for each drill step. OPS-10's
  quiescence check counts every job trigger in the location; the harness
  creates none. OPS-11's maintenance-pass sub-check is a separate owner step
  (see "Not covered").
- **Client addresses:** a single load machine is one client address. The
  per-address edge limits then apply to the whole fleet, as run 2 shows.
- **Hosted CI:** the offline check runs inside `scripts:check`. Registering
  the PostgreSQL spec in the hosted PostgreSQL lane belongs to C-CI.
- **Guidance conflict, open for the owner:** `apps/worker/AGENTS.md` asks
  network harnesses to validate a local owner session through
  `--owner-access-file` before enrollment. That rule is written for the
  disposable local backend laboratory. This harness targets the accountless
  GCP plane, whose admission path has no owner session, so it takes no such
  file, following `edge-live-check.mjs`. Review finding 6 above proposes
  wording; the change itself belongs to the owner or a docs stream.
- **Duplication:** the spec mirrors `edge-origin-e2e.spec.mjs`'s
  `startOrigin` and `seedSchema` rather than editing E12, which D-CRB is
  expected to re-specify. A shared local-origin module is a follow-up.
