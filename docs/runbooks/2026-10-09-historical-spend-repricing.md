---
title: Bounded historical spend repricing
date: 2026-10-09
type: runbook
status: implemented-candidate-not-live-qualified
---

# Bounded historical spend repricing

The candidate implements a separate saved-cohort repricing lane. It has not
been deployed or qualified against production. This runbook describes the
source contract, not permission to migrate, deploy or execute a production Job.
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
refresh, or rebuild allowance previews. Pro 10x allowance normalization and
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
success or failure; the root-owned execution carrier sets its task/process
budget and independently checks overlapping operations.

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
through the root-owned bounded readback; do not mint a new UUID or substitute a
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
[service operations boundary](./production-operations.md) and the reviewed
root-owned migration/deployment carrier.
