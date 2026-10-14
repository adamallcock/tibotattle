---
title: Bounded historical spend repricing
date: 2026-10-09
type: runbook
status: implemented-candidate-not-live-qualified
---

# Bounded historical spend repricing

The candidate implements a separate saved-cohort repricing lane. It has not
been deployed or qualified against production. This runbook describes the
source contract and its production carrier (the reprice Cloud Run Job and the
typed operator verb, OPS-REPRICE), not permission to migrate, deploy, apply
infrastructure or execute a production Job. Each of those is an owner-only
protected step.
The operator retains the exact source commit, image digest, registered kernel,
manifest version, target configuration, plan receipt and operation identity
before any separately authorized execution.

The maintained CLI is [analytics-reprice.mjs](../../apps/worker/cloud-run/analytics-reprice.mjs),
bundled as `apps/worker/cloud-run/dist/analytics-reprice.mjs`. Its contract is
[reprice.ts](../../apps/worker/src/analytics-v2/reprice.ts), with separate
[metadata/input reading](../../apps/worker/src/analytics-v2/reprice-read.ts) and
[transactional execution](../../apps/worker/src/analytics-v2/reprice-store.ts).
Migration [0077](../../apps/worker/postgres/migrations/primary/0077_analytics_v2_reprice.sql)
provides the input-association archive, completed-run ledger, immutable price
proofs and former-publication log. The CLI never applies a migration.

This lane reprices retained daily contributions for already published days.
It does not activate staged manifests, enroll participants, discover or union
in today's uploader roster, advance the analytics journal, run an ordinary full
refresh, or rebuild allowance previews. Allowance normalization and
historical spend repricing are separate computations.

## Explicit planning and execution

Every invocation requires `--mode=plan` or `--mode=execute`, real inclusive UTC
calendar dates `--from-day` and `--through-day`, and all three bounds:

| Argument | Hard maximum | Meaning |
|---|---:|---|
| `--max-days` | 32 | Selected stale-price published heads, not calendar span |
| `--max-members` | 1,000 | Saved member rows across all selected heads |
| `--max-input-bytes` | 16,777,216 | Compressed input bytes; contribution-document bytes are independently bounded by the same value |

The domain also limits selected input events to 500,000 and exclusion rows to
10,000. Planning fetches metadata, not contribution bodies or compressed input
bodies. It returns `analytics-v2-reprice-plan-v1`, aggregate counts, cap flags,
a plan SHA256 and the compiled target's kernel/manifest/registry/pricing-method
identity. A cap flag means the bounded result is incomplete; counts are not
whole-history totals. Execution refuses every capped plan. Planning does not
prove that every selected contribution will qualify for repricing.

The digest binds the exact bounds and target, selected day/revision/payload and
run stamps, saved contribution/source metadata, and the exclusion digest.
Execution additionally requires `--run-id=<UUID>` and
`--expected-plan-sha256=<reviewed lowercase SHA256>`. Neither is permitted in
plan mode. Duplicate or unknown flags fail closed. There is no implicit execute,
automatic retry, pagination expansion, HTTP endpoint or credential override.

Production inherits the refresh Job's closed environment and IAM connection,
uses `PRIMARY_SCHEMA` and the real clock, and forbids `--schema` and `--now`
overrides. Synthetic local targets may select their isolated schema; a test
clock requires the existing refresh test-clock guard. The compiled registry
must match the kernel's registered registry identity. Record the image/source
binding externally; there is no CLI flag that substitutes a different kernel.

The following are templates for a disposable local fixture only, from the
repository root with the maintained local PostgreSQL test environment already
configured. They do not build an image, apply migration 0077, choose a provider
project or submit a Job. Replace placeholders before execution; preserve the
same bounds, image and target between steps.

```sh
node apps/worker/cloud-run/dist/analytics-reprice.mjs \
  --mode=plan --schema=synthetic_reprice \
  --from-day=2026-01-01 --through-day=2026-01-02 \
  --max-days=2 --max-members=4 --max-input-bytes=1024

node apps/worker/cloud-run/dist/analytics-reprice.mjs \
  --mode=execute --schema=synthetic_reprice \
  --from-day=2026-01-01 --through-day=2026-01-02 \
  --max-days=2 --max-members=4 --max-input-bytes=1024 \
  --run-id='<fresh-operation-uuid>' \
  --expected-plan-sha256='<reviewed-plan-sha256>'
```

Planning uses a repeatable-read, read-only transaction with a 15-second
statement timeout and 250-millisecond lock timeout. Execution uses one
repeatable-read mutation transaction, 30-second statement timeout and the same
lock timeout. It locks mutable publication, saved-cohort, contribution, input,
owner-link and exclusion sources before its first snapshot read, then acquires
the shared refresh transaction lock. Busy or changed input refuses execution.
These are per-statement limits, not a promised whole-process deadline. The CLI
uses a pool of at most two connections and closes pools/connector on either
success or failure. The execution carrier (see [Production carrier](#production-carrier))
sets the task budget (one task, 3,600 s, no retries) and refuses to start while
a refresh, reprice or migration execution is running.

## Saved membership and exact inputs

A selected day must have its recorded saved owner set. Its linked departed or
opted-out contributors remain in that set: stopping future uploads does not
remove retained published membership. The lane uses the saved members' current
contribution versions and device counts, not today's active uploader roster.
An applicable active `community_weekly` exclusion omits that member's values
from the fold while retaining its membership. An unavailable owner link remains
a refusal; the lane cannot infer the member's exclusions.

A usage-bearing contribution needs the exact supported price-input codec,
digest and event/document consistency checks. First association requires the
price-input run and kernel to equal the saved contribution's run and price
kernel. Equal event counts or daily sums cannot establish that association.
Zero-usage contributions need no price inputs. Newly appended contribution
versions archive genuine same-run/kernel inputs in
`analytics_v2_contribution_price_inputs`; repricing appends the newly priced
codec document and retains its source-input digest. It does not retroactively
invent associations for older versions from matching totals.

The closed per-day refusals are `owner_set_unavailable`,
`member_link_unavailable`, `price_inputs_unavailable`,
`price_input_association_unproven`, `price_inputs_corrupt`,
`contribution_invalid` and `reprice_membership_or_evidence_drift`. Missing or
invalid evidence preserves the prior publication. A fold whose non-spend
payload differs from the saved head is refused, rather than publishing altered
membership, usage coverage or other aggregate evidence under a pricing change.

## Publication, equivalence and replay

| Outcome | Durable behavior |
|---|---|
| `unchanged` | No new daily revision; also includes already validated target equivalences |
| `equivalent` | Actual amounts/coverage are identical after removing only price identity; append an immutable target-price proof, preserving the public head's revision and release time |
| `changed` | Append changed contribution versions and publish a higher daily revision using the existing publication writer; preserve the former head in `analytics_v2_published_daily_log` |
| `refused` | Preserve the prior head and count the closed refusal reason |

An equivalence proof binds the old day, revision and payload digest, saved
source digest, exclusions digest, target kernel/manifest/registry/pricing method
and completed repricing run. The public reader revalidates these bindings
before presenting the target price identity. Unknown, capped or unavailable
proof is withheld; it never rewrites an old amount or asserts current pricing.

Publication changes, contribution versions, input archives, equivalences and
the completed-run receipt commit atomically. A successfully committed run UUID
is immutable. Repeating execute with that same UUID, original bounds, target
kernel/manifest and expected plan hash returns its stored receipt with
`replayed: true`; it does not append another revision. A reused UUID with a
different binding or a changed unexecuted plan refuses. The CLI does not retry.

If commit acknowledgement, receipt emission or cleanup is uncertain, retain
the original exclusive operation record and UUID. Reconcile that same operation
by rerunning execute with the same run id and plan receipt (see
[Production carrier](#production-carrier)); do not mint a new UUID or substitute a
fresh plan to conceal uncertainty. A completed ledger row permits same-operation
replay; a closed CLI failure alone does not prove rollback. There is no separate
`--mode=verify` or status flag.

## Verification and evidence

The outer `analytics-reprice-receipt-v1` validates a closed plan or execution
result before printing it. Execute reports `planned`, `changed`, `equivalent`,
`unchanged`, `refused`, `contributionVersions`, the exact refusal histogram and
`replayed`. The four outcome counts must sum to `planned`, and the refusal
histogram must sum to `refused`. `status: complete` means the bounded transaction
finished; it does not mean every day was repriced or the full history is current.

Root verification retains the exact receipt/plan/source/image bindings, checks
the completed ledger row for the same operation, and uses bounded, aggregate-only
readback for selected public heads, revisions, price identities and unchanged
non-spend evidence. It also checks former-head preservation for changed days
and current proof bindings for equivalent days. Public HTTP readback and graph
freshness qualification remain separate from CLI/test success. Refused days
stay explicit and are not forced into a new plan without resolving their actual
input association or evidence gap.

Errors print only closed status/code and an allowlisted phase. Unknown driver
errors become `ANALYTICS_V2_REPRICE_FAILED`; never print error messages, stacks,
SQL, binds, identities, codec bodies or contribution documents. Preserve private
operation artifacts with existing owner-only permissions and avoid raw driver
logging in an outer runner.

Local source checks are
`node --test apps/worker/cloud-run/analytics-reprice.check.mjs` and, from
`apps/worker`,
`npx vitest run --config vitest.analytics-v2.config.mjs analytics-v2-test/reprice.spec.ts`.
They use synthetic inputs. They do not qualify migration application, provider
execution or the public production response. Production operations follow the
[service operations boundary](./production-operations.md), the
[GCP origin rollout](./gcp-rollout.md) (the reprice is step 10, after a roll
that changes the analytics kernel) and the production carrier below.

## Production carrier

Status: `built`, offline only. The Job and the verb are tested with synthetic
data and a stubbed `gcloud`. No infrastructure apply, Job execution or log read
has happened in any project. The first live run is a staging run that the owner
authorizes.

**The Job.** `jobs.analytics-reprice` in both committed desired states
(`tibotattle-analytics-reprice` in production, `tibotattle-staging-analytics-reprice`
in staging). Its contract, `ANALYTICS_REPRICE_JOB_CONTRACT` in
[`gcp-ops-infra-manifest.mjs`](../../apps/worker/scripts/gcp-ops-infra-manifest.mjs),
is described in the
[infrastructure README](../../apps/worker/cloud-run/infra/README.md#reprice-job-ops-reprice):

- It runs as the runtime account and the runtime IAM database user, with the
  refresh Job's closed environment.
- It has no secret, one task, no retries, no trigger and no scheduler grant.
- Its own arguments name only the entry, so an execution without explicit
  arguments fails closed before any connection.

The roll moves it with the other Jobs, so it always runs the rolled kernel.
It is created by an owner-applied OPS-2 plan. On an estate that already exists,
that plan needs a bootstrap image (`--bootstrap-image-digest` and
`--bootstrap-source-commit`) whose image contains this CLI and whose database
holds migration 0077.

**The verb.** `npm run gcp:analytics:reprice --` from `apps/worker`, which runs
[`gcp-analytics-reprice.mjs`](../../apps/worker/scripts/gcp-analytics-reprice.mjs).
Every invocation takes these flags:

- `--environment=<production|staging>` and `--mode=<plan|execute>`;
- `--commit=<deployed commit>`;
- `--expected-kernel=<id>`, which must be registered in the checkout's
  `kernel-registry.json`;
- the inclusive day range and all three bounds, as above;
- `--receipt-out=<new absolute path>`.

Execute also takes `--plan-receipt`, `--expected-plan-sha256` and `--run-id`.
Without `--execute`, the verb makes no call. It validates everything offline
(the committed desired state, the registry, the plan receipt and the CLI's own
argument parser) and prints the exact `gcloud` argv. `--execute` requires the
authorization `reprice-plan:<env>:<commit>` or
`reprice-execute:<env>:<planSha256>`. A supplied authorization must match in a
dry run too.

With `--execute`, the verb holds the environment's deployment coordination lock
(the OPS-10 ref) and does the following in order:

1. It reads the Job back. The Job must have exactly one container, whose image
   comes from the plane's repository at a sha256 digest, whose
   `DEPLOYMENT_SOURCE_COMMIT` is `--commit`, and whose own arguments are the
   entry alone.
2. It refuses if any execution of the reprice, refresh or migration Job has no
   terminal evidence.
3. It runs `gcloud run jobs execute --async --args=<entry and the CLI's
   explicit arguments>` once, then polls the execution until it completes,
   for at most the task timeout plus five minutes.
4. It reads exactly one `analytics-reprice-receipt-v1` line for that execution
   from Cloud Logging. While no line has been ingested, it retries a bounded
   number of times.
5. It validates the receipt with the CLI's own `validateAnalyticsRepriceResult`.
   The receipt must name the requested mode, this environment, the wall clock,
   the expected kernel and that kernel's registered price-registry digest.
   Execute must also carry the reviewed plan hash.
6. It writes a digest-sealed `tibotattle-gcp-analytics-reprice-v1` receipt,
   owner-only, to `--receipt-out`.

The verb prints only counts, cap flags, the refusal histogram, `replayed`,
names, digests and closed codes.

Execute requires the verb's own plan receipt, and that receipt must match the
execution in every one of these ways:

- the same environment, Job, commit and expected kernel;
- the same bounds;
- `planSha256` equal to `--expected-plan-sha256`;
- uncapped and non-empty;
- at most 24 hours old.

The live Job's image must also still be the image the plan ran on. A roll
between the plan and the execution makes the plan stale.

**Procedure (owner-only for every `--execute`).**

1. Plan over a day window. If a cap flag is set (`executable: false`), the
   window exceeds one run's heads, members or input bytes. Narrow the window
   and plan again. Never raise a bound beyond the CLI's hard maximum.
2. Review the plan receipt's counts and `planSha256`. Choose a fresh run UUID
   and record it with the receipt before executing.
3. Execute with that plan receipt, its hash and the run UUID. A later plan of
   the same window no longer lists the changed days. Days that were equivalent
   or refused can still appear: an execution reports them as `unchanged` or
   `refused` and publishes nothing new for them.
4. Repeat for the next window until every published day since the previous
   kernel has been planned.

If the execute step's outcome is uncertain (`REPRICE_EXECUTION_TIMEOUT`,
`REPRICE_RECEIPT_UNAVAILABLE`, or a lost terminal), rerun execute with the same
`--run-id`, the same plan receipt and a new `--receipt-out`. Do this within the
plan receipt's 24 hours. A committed run returns its stored result with
`replayed: true`, and an uncommitted one runs once. Never mint a new run id to
hide that uncertainty.

### Refusals

The verb's own refusals are closed `REPRICE_*` codes. A refused Job prints
`REPRICE_JOB_REFUSED` with the CLI's closed `jobCode` and `jobPhase`, and its
failure receipt is still written.

| Code | Meaning | Action |
|---|---|---|
| `REPRICE_AUTHORIZATION_REQUIRED`, `REPRICE_AUTHORIZATION_MISMATCH` | `--execute` without authorization, or a token for another mode, plane, commit or plan | Obtain the owner's authorization for exactly this step |
| `REPRICE_KERNEL_UNREGISTERED`, `REPRICE_KERNEL_UNEXPECTED` | The expected kernel is not in this checkout's registry, or the Job's receipt names another kernel or manifest version | Stop. The checkout or the rolled image is not the kernel you meant. Never substitute the receipt's kernel |
| `REPRICE_JOB_COMMIT_MISMATCH`, `REPRICE_JOB_IMAGE_UNRECOGNIZED`, `REPRICE_JOB_UNRECOGNIZED` | The live Job is not the reviewed render at `--commit` | Nothing ran. Read back the estate (`gcp-infra.mjs readback --require-clean`) and finish the roll |
| `REPRICE_OVERLAP_REFUSED` | A refresh, reprice or migration execution is running | Nothing ran. Wait for it. Never cancel a refresh to make room |
| `REPRICE_PLAN_RECEIPT_REQUIRED`, `REPRICE_PLAN_RECEIPT_MISMATCH`, `REPRICE_PLAN_BOUNDS_MISMATCH`, `REPRICE_PLAN_DIGEST_MISMATCH`, `REPRICE_PLAN_CAPPED`, `REPRICE_PLAN_EMPTY`, `REPRICE_PLAN_RECEIPT_STALE`, `REPRICE_PLAN_IMAGE_MISMATCH`, `REPRICE_RECEIPT_FILE_INVALID` | Execution without a matching, sealed, fresh, uncapped and non-empty plan on the same image | Nothing ran. Plan again |
| `REPRICE_RECEIPT_UNAVAILABLE`, `REPRICE_RECEIPT_AMBIGUOUS`, `REPRICE_RECEIPT_INVALID`, `REPRICE_EXECUTION_TIMEOUT`, `REPRICE_EXECUTION_OUTCOME_UNKNOWN` | The execution ran but its outcome is unproven | For execute, reconcile with the same run id as above. For plan, plan again |
| `REPRICE_JOB_REFUSED` with `jobCode` `ANALYTICS_V2_REPRICE_PLAN_CHANGED` | The plan changed before execution | Plan again |
| `REPRICE_JOB_REFUSED` with `jobCode` `ANALYTICS_V2_REPRICE_SCHEMA_UNAVAILABLE` | Migration 0077 is not applied | Stop. Migration is a separate owner step |
| `REPRICE_JOB_REFUSED`, other `jobCode` | One of the CLI's closed refusals | Read this runbook's sections above for that code |
| `PRODUCTION_COORDINATION_*`, `STAGING_COORDINATION_*` | The deployment lock is held | Stop, as for OPS-10 ([GCP origin rollout](./gcp-rollout.md#when-something-fails)) |

The offline checks are `node --test apps/worker/scripts/gcp-analytics-reprice.check.mjs`
(the verb, against a stubbed `gcloud`) and `npm run gcp:ops:infra:check` from
`apps/worker` (the desired state, the render and the plan). The least-privilege
claim is proven locally by the PostgreSQL test "the runtime grant policy alone
plans, executes and replays" in `postgres-test/analytics-v2-reprice.spec.mjs`.
None of these qualifies a live apply, execution or log format.
