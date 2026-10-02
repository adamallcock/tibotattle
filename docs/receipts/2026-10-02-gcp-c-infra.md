---
title: GCP C-INFRA committed desired state and refresh job
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP C-INFRA committed desired state and refresh job

This is a 2026-10-02 receipt for stream C-INFRA on branch
`claude/gcp-fp-c-infra`, built on `afd865a0` (`claude/gcp-fastpath-final`).
It covers two commits: `bd16f278` (the implementation, the
committed desired states and their checks) and the commit that adds this
receipt and the plan row.

It records **local, synthetic** evidence only: one macOS arm64 workstation,
Node 26.2.0, and the local PostgreSQL 17 fan-out cluster (port 55433) for the
OPS-10 migration spec. No gcloud or wrangler command ran. Nothing read or
wrote a GCP or Cloudflare resource, production or test. Nothing was pushed.
Every OPS-2 check blanks `PATH`, so a real gcloud cannot start, and drives
the in-memory gcloud fixture. The committed staging file names real,
non-secret identifiers of the GCP test project (`tibotattle`, its project
number and region, already tracked in the test-estate targets); no other
file names a real resource, and no file holds a secret value.

This receipt is not evidence that the tooling works against a live project.
The first owner-run readback against the test project is that qualification.

## What changed

| Item | Implementation |
|---|---|
| (a) Desired state committed | `apps/worker/cloud-run/infra/{staging,production}.desired-state.json` and `desired-state.schema.json`. The schema moves to `tibotattle-gcp-ops-infra-desired-state-v2`. `GCP_INFRA_DESIRED_STATE_<ENV>` and every `process.env` read are gone from the manifest. `loadCommittedDesiredState(env)` reads only the committed file, requires its environment, refuses the synthetic fixture (`COMMITTED_DESIRED_STATE_SYNTHETIC`) and requires the verifier (`COMMITTED_DESIRED_STATE_VERIFIER_REQUIRED`). `rolloutTarget(env)` and the CLI's `--environment` read through it. `apply` and an applying `bucket-birth` accept `--environment` only (`GCP_INFRA_COMMITTED_DESIRED_STATE_REQUIRED`); `render`, `readback`, `plan` and `scheduler-probe` still accept `--desired-state` for a draft or the fixture |
| Non-secret only | Each secret names its Secret Manager id (`secretName`) and a pinned version. The service render points each `secretKeyRef` at that id; EP-7's own render is unchanged. `refuseSecretMaterial` runs before any shape check and refuses secret-valued keys (`value`, `privateKey`, `jwk`, `token` and the rest of `SECRET_VALUE_KEYS`) and strings that look like a PEM block, a JWK, a Google API key, an OAuth or GitHub token, or a long mixed-case base64 token (`DESIRED_STATE_SECRET_VALUE_FORBIDDEN:<path>`) |
| Schema and validator | `DESIRED_STATE_SHAPE` holds every closed key set. The validator enforces it, and the manifest check holds the JSON Schema's `properties`, `required` and `additionalProperties: false` to it at every level |
| Staging | Project `tibotattle`, `projectTenancy: "shared"`, all-new `tibotattle-staging-*` names: accounts, repository, instance, database and schema, bucket, service, jobs, trigger and Secret Manager ids. The check proves that no name equals, or starts like, a test-estate name and that none carries a `test` token. In a shared project, readback keeps only the plane's own instances, services, jobs and triggers, so co-tenants are never planned for deletion. It neither reads nor plans the `_Default` log sink, the log bucket or the Data Access audit settings. Production is always `dedicated` (`PROJECT_TENANCY_SHARED_FORBIDDEN:production`) |
| Production | `project`, `projectNumber`, `region` and `bucket.location` are explicit `null` placeholders (`OWNER_PLACEHOLDER_PATHS`). The validator refuses them with `DESIRED_STATE_PLACEHOLDER_UNFILLED:<path>`, so the loader, the CLI and OPS-10 all refuse the file until OWN-5 fills them |
| (b) Verifier (OD-CR-7) | Both committed files name the verifier account. Its new `tokenCreators` key lists the principals that get `roles/iam.serviceAccountTokenCreator` on the verifier account alone: 1 to 4 `user:`, `group:` or `serviceAccount:` members, never public, never a plane account. Readback adds `iam service-accounts get-iam-policy` and apply adds `iam service-accounts add-iam-policy-binding`. While `tokenCreators` is `null`, the grant is a deferral (`VERIFIER_TOKEN_CREATOR_UNASSIGNED`) that keeps the estate unclean, and `rolloutTarget` refuses (`ROLLOUT_TARGET_VERIFIER_TOKEN_CREATOR_UNASSIGNED`). Any live grant of an impersonation role (token creator, OpenID token creator, service account user) that the file does not name is a delete that apply refuses |
| (c) Refresh job and trigger | `DEFERRED_JOBS` is empty; both jobs deploy and OPS-10 moves both. The job runs `node --max-old-space-size=12288 dist/analytics-refresh.mjs --mode=full`, with no `--schema` and no `--now`, on 4 CPU, `16Gi` memory and a 14,400 s timeout (`ANALYTICS_REFRESH_TASK_PROFILE` "dense"). Its env is exactly `ANALYTICS_REFRESH_TARGET`, `PRIMARY_INSTANCE_CONNECTION_NAME`, `PRIMARY_DATABASE`, `PRIMARY_SCHEMA`, `POSTGRES_IAM_USER` and `ANALYTICS_V2_MEMORY_BUDGET_MIB=9216`, plus `DEPLOYMENT_SOURCE_COMMIT`, which OPS-10 sets on every job (`ANALYTICS_REFRESH_JOB_CONTRACT`). The trigger is created and paused in one apply whatever its desired state. The scheduler account's `run.jobsExecutor` on the job is bound only after that pause, and `assertTriggersCreatedPaused` refuses any other order (`SCHEDULER_CREATE_NOT_PAUSED`) |
| (d) Paused-too-long signal | `gcp-infra.mjs scheduler-probe --environment=<env>` makes one read (`scheduler jobs list`) and gives a content-free verdict per trigger. It raises `SCHEDULER_TRIGGER_PAUSED_TOO_LONG` and exits 2 when a trigger whose committed state is `ENABLED` is live `PAUSED` and neither `userUpdateTime` nor `lastAttemptTime` is newer than `SCHEDULER_PAUSE_ALERT_THRESHOLD_HOURS` (6, the proposal for the owner's "a few hours"). Missing, malformed or future timestamps, an absent trigger that should run, and an unrecognized state also exit 2. A trigger committed `PAUSED` (before OPS-3 resumes it) is paused by design |
| (e) Dry-run and offline | Plan, readback and apply remain injected-runner, argv-only and digest-authorized. Negative tests for the committed files cover secrets present, null production identifiers, test names (and shared tenancy, and staging names) in production, and a trigger not paused at creation |

## Proposals the owner confirms (OWN-5 and others)

These are reviewable values in the committed files, not decisions taken
here.

- Production names: `tibotattle-{runtime,migrator,scheduler,builder,edge-invoker,verifier}`
  accounts, `tibotattle-images/tibotattle-host`, instance `tibotattle-primary`,
  database and schema `tibotattle_primary`, bucket `tibotattle-quarantine`
  (bucket names are global), service `tibotattle-origin`, jobs
  `tibotattle-migrate` and `tibotattle-analytics-refresh`, the trigger
  `tibotattle-analytics-refresh-trigger`, audience `tibotattle-edge-origin`.
  Production secret ids equal the variable names, as EP-7's template names
  them.
- Sizing, the same for both planes so that REH-1 timings transfer:
  `db-custom-4-16384`, 50 GB auto-increasing, `max_connections` 100,
  4 instances plus 4 for rollout overlap (budget 82 of 100), and backups at
  07:00 UTC.
- The refresh memory budget, 9216 MiB, keeps `analytics-refresh.mjs`'s
  default ratio (4608 of a 6144 MiB heap). The check proves it with the
  entry's own `analyticsRefreshResources`.
- The 6 h paused threshold.

Values left `null` because they are not this stream's to choose: the
verifier's `tokenCreators` (the operator's identity), every secret version,
the bucket proof (from bucket birth), `service.telemetryStorageNamespace`
(it must equal the namespace the imported data carries, so the service
cannot render without it), and the trigger cadence (D3, no default).

## Gates

All gates ran on the final tree of the implementation commit. They ran from
`apps/worker` unless marked root.

| Gate | Result |
|---|---|
| `npm run gcp:ops:infra:check` | 194 of 194: manifest 32, operations 26, bucket birth 11, CLI 11, plus EP-7, CR-3 and OPS-1, unchanged. At `afd865a0` it was 179 of 179 |
| `npm run gcp:production-rollout:check` | 19 of 19 |
| `npm run gcp:production-tooling:local-check` with the PG17 fan-out env | migrations 33 and 5, rollout 19, infra 194, cutover seal 32; all pass, none skipped |
| `node scripts/cloud-run-build-context.mjs --check` | Exit 0. `cloud-run/infra/` is outside the image's allowlist |
| Root `npm run architecture:check` | Passed: 926 production files, 3,961 imports, 0 debt edges |
| Root `npm run test:preflight` | Exit 0, including documentation validation |

Not run: `npm test`, `npm run product:worker:check` and the Worker Vitest
suites. No Worker source, TypeScript or route changed.

## Not covered

- **No live evidence.** Readback has never parsed real gcloud output for
  `iam service-accounts get-iam-policy` or for Cloud Scheduler's
  `userUpdateTime` and `lastAttemptTime`. The probe assumes that a pause
  updates `userUpdateTime`; if it does not, the probe errs early, towards
  raising the signal.
- **The probe is not scheduled.** It is a signal with an exit code, not yet
  an alert. A periodic runner and a notification target are still owed;
  both are owner choices. No Cloud Monitoring policy is rendered, because
  Cloud Scheduler exposes no paused-state metric, and absence-of-attempts
  alerting depends on the cadence, which is undecided.
- **C-REFRESH acceptance.** The old pin that the entry refuses this env was
  removed with the deferral. The check proves the rendered arguments and
  resources against today's entry parser and resource gate, but not the
  production target path, which C-REFRESH adds. The integrator should add
  that cross-check when C-REFRESH merges (see integration notes).
- **The staging service.** It is deferred (`STAGING_SERVICE_TEMPLATE_UNAVAILABLE`)
  because EP-7's template is the production profile, so a staging estate
  never reads clean until D-CRB provides a staging template.
- **OPS-10 in the shared project.** The rollout's quiescence check counts
  every Cloud Run job trigger in the location, so a running test-estate
  trigger would refuse a staging migrate or roll. The rollout body is not
  this stream's; the target loader is.
- **The shared project's custom role.** `tibotattleQuarantineStore` is a
  project-scoped id. No test tooling creates it, but no live listing was
  taken.
- OD-2 (C-SIMP) is untouched. The manifest still refuses
  `GCS_ERASURE_BUCKET_HISTORY_PROOF`, and the EP-7 template is unchanged.
