---
title: GCP admin processing and reconstruction progress
date: 2026-10-11
type: plan
status: release-preparation
---

Local candidate on `codex/gcp-admin-reconstruction-progress-20261011`, retained
for the owner's release handoff. Base: `2fd6d050d29e15db69de91effeb7355592136294`.
Feature commit: `2f8c48c83`. Merged origin integration:
`67281641501800cde114f4a425761fbcc53267d2` (merge `4c1f2f0e0`).
During implementation, no production reads, pushes, remote migrations or
deployment were performed.
Source implementation and local synthetic checks do not qualify production.

## Implementation and contract decision

The origin's admin composition now injects
`readPostgresAdminReconstructionProgress`. It reads journal head/time,
v1.2 head/day counts and unconsumed activation authorizations, delivery cursor
and journal backlog, distinct queued days, publication heads/preview presence,
and the last recorded refresh's status, start, finish, kernel and owner counts.
All reads share one REPEATABLE READ READ ONLY transaction, with 2-second
statement and 500-millisecond lock timeouts. The SQL returns aggregates and
timestamps only; no owner, event, generation, run identifiers or payloads.
Pending journal events and source counts stop at 100,001 rows; queued days
stop at 10,001. Exceeded bounds return unavailable totals, not truncated counts.
Missing, unsafe or ahead-of-journal cursors leave backlog/queued days unknown.

Queued days match the overview and refresh producers, including v1 chunks,
replaced v1.1 days, v1.2 manifest differences, current-source filtering and
terminal events adding no days. No analytics kernel module changed. Rebuilt
Cloud Run artifacts retain kernel 16 and compute closure SHA-256
`d2e867213fe9656f6edf91d0ac991cb293a323f3b2cd84af7d79c0ac431f39f4`.

V3's required graph/window/history counters cannot express unavailable GCP
evidence. The new closed version 4 explicitly marks incremental graph/history,
per-owner progress, delivery position, current execution and scheduler state
unavailable. `analytics_v2_runs` commits with publication; an in-flight refresh
is invisible, and automatic failures leave no row. A reserved, recorded failed
run is displayed as that record, with an attention item. A complete last record
does not imply idle/current success. The next nominal 03:00 UTC slot follows
the owner's cadence and is neither an execution ETA nor scheduler health.

**This needs an edge client deploy and an origin roll.** In GCP mode the Worker
serves admin assets through `admin-ui.ts` / `admin-ui.generated.ts`. The updated
client accepts v1/v2/v3/v4; the old client rejects v4. Regenerate assets from
their canonical web sources, then have the owner deploy the edge client before
rolling the origin with `scripts/gcp-production-rollout.mjs`. Asset generation
and local Cloud Run builds publish neither surface. No database migration is
introduced by this feature; the merged integration's release gates remain.

## Test run report

Trigger: the PostgreSQL reader, default admin binding, v4 projection/rendering
and embedded assets. Node 26.2.0; synthetic PostgreSQL 17.10 on an isolated
local Unix socket. No private sessions or production fixtures were used.

| Check | Result |
| --- | --- |
| New reader + existing PostgreSQL admin-console specs | 23 passed, 0 skipped |
| New reader after strengthening the unchanged-day fixture | 12 passed, 0 skipped |
| Admin client projection + site rendering specs | 104 passed, 0 skipped |
| Rebuilt origin console/host/dispatch/edge-contract and asset checks | 89 passed, 0 skipped |
| Final canonical embedded-asset checks | 4 passed |
| Final `cloud-run/build.mjs --check` | Passed; kernel 16 unchanged |
| `npm run test:preflight` | 21 passed; documentation/root layout clean |
| `npm run architecture:check` | Passed: 992 production files, 4,308 imports |
| PostgreSQL suite registration `--plan` | Passed; new socket spec registered |
| `npm run product:ui:test` | 1,093 passed, 3 failed, 0 skipped |
| `npm run docs:check` | Passed: 397 Markdown / 1,819 source/config files |
| `npm run product:worker:check` | Vitest: 2,725 passed, 25 failed, 0 skipped |
| Unchanged-parent reproduction of failing Worker files | Same 25 failure messages; 28 passed |

The PostgreSQL cases cover empty/unknown/unsafe/ahead cursors; a normal refresh;
an uncommitted in-flight refresh; a reserved failed last record; queue parity
including unchanged v1.2 days; bounded counts; a concurrent atomic publication;
both valid route query shapes; exact read-only isolation/timeouts; and sanitized
lock failure with rollback. Client negatives exercise closed keys, unknowns,
counts and timestamp invariants. Browser QA inspected both panels using local
synthetic fixtures at default and narrow widths. Real-system rendering remains
an owner post-roll gate.

Full UI failures reproduce unchanged on parent `672816415`: the accounting
normalizer, historical allowance headline and share-card tests in
`apps/web/test/lib.test.mjs` have stale plan-label expectations. They were left
unchanged. FLAKY: the existing attention-recovery test failed once during
concurrent local fixture load, then passed isolated and in the 104-test admin
run and full UI gate. No assertion, timeout or skip was changed.

The Worker gate passed its migrations, transfers, workspace-copy, endpoint,
generated-type, TypeScript, script and origin-smoke checks before reaching
Vitest. All 25 Vitest failures reproduce with identical failure messages on
parent `672816415`: 15 performance-repository tests reject their fixture as
`TELEMETRY_RECORD_INVALID`; two typed-restore tests fail at the same performance
admission; one runtime-activation test reports
`TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE`; and seven header-ratchet tests flag
existing `Map.get` expressions in `postgres-classification-activation.ts` as
dynamic header reads. These failures predate this feature and remain unchanged.
The gate stops at Vitest, so its later Node, analytics, dry-deploy and staging
checks were not reached. The parent reproduction used a disposable source
archive, not another release worktree.

Verdict: focused feature checks pass; the complete UI and Worker gates still
need attention on the merged parent. No tests were weakened, skipped or
removed. These baseline failures require the owner's integration follow-up
before treating the combined candidate as fully validated.

## Owner post-roll acceptance

1. Deploy the updated edge admin assets, then build/roll the origin. Confirm the
   owner-authenticated reconstruction route returns 200, `schemaVersion: 4`
   and `Cache-Control: no-store` for both allowed query shapes.
2. Reload `admin.tibotattle.com`: both panels must show the response's recorded
   numbers and dates. An unavailable-source attention item must disappear on
   successful reads; a recorded failed run must still produce attention.
3. Compare `pipeline.daily.queuedDays` to the overview's
   `ingestion.dailyPublication.pendingRebuilds` / visible "publication rebuilds
   queued" count.
   Compare while the cursor/journal head is stable; the two endpoints use
   separate snapshots. Unknown/bounded counts must stay explicitly unavailable.
4. Confirm incremental/current execution counters remain unavailable and the
   nominal slot is not rendered as a running job or completion estimate.

## Authorized combined release follow-up

On 2026-10-11 the owner assigned this chat the GitHub sync release through the
coordinated handoff. The direct owner instruction was verified in the sending
chat. This chat owns the combined rollout; the sync chat will not run a competing
release. The exact sync candidate `0a76521031ae9791d00554910efc79912ab44f23`
was merged at `a2f7f09e7c4891e81828348414e49c9d180e90be`. Both admin adapters and
PostgreSQL suite registrations are retained. No new token is needed.

Combined source qualification: 41 PostgreSQL tests passed with no skips;
104 admin tests passed; rebuilt Cloud Run checks passed 569 cases with four
existing PostgreSQL-dependent skips. The required production-tooling gate
passed 638 cases without skips. Its old production-migration spec still pinned
0077; only its exact count/name assertions and descriptive comments were
advanced to the canonical, already-merged additive 0078. Grant, replay,
ahead-history and divergence assertions remain intact. The baseline broad
UI/Worker failures above remain explicit.

Live read-only preflight observed origin commit `2fd6d050` on revision
`tibotattle-origin-00012-h4f`, edge commit
`ed3aee03f0c3046c376a214425867c490e8a04b3` in GCP mode, and an OK fresh backup
audit. Both triggers were ENABLED: maintenance every minute and analytics at
03:00 UTC. Their exact private captures must govern pause/resume; committed
bootstrap states must not replace those observations. No production write had
occurred when this preparation record was saved.

Release sequence: freeze a clean combined commit; preserve and prove the
exact live public release tree; build the GCP image with the existing rollout
CLI; stage the compatible edge client using the guarded typed deploy; capture
fresh edge/backup inputs; pause and drain previously enabled triggers; obtain a
fresh migration receipt bound to this commit/digest; roll the origin and Jobs
together; qualify both panels and GitHub snapshot/audit; resume only previously
enabled triggers, maintenance first. Keep owner-private receipts outside Git.
No whole-estate desired-state apply, secret creation or desktop publication is
part of this release.

The live edge is not an ancestor of the origin branch. Its contract blob matches
the origin, but its public tree includes `feature-value.png`, which the origin
branch's older asset allowlist refuses. The edge client therefore has its own
owned branch/worktree based on exact live edge `ed3aee03`; only this feature's
client/projection/rendering tests and generated embedded assets are ported.
The typed edge deploy must preserve the live manifest
`cedad565d9d5ac420a28b6445b5d66ecaecd3327227f04f63faee813d3df7e81`.
Never deploy the origin branch's older public layout over the live edge.

The edge client deployed and verified at `d06a2374cd6202895b0dabb5ec23b44d35dfdb47`;
the cache-busted public manifest retained the exact hash above. The first origin
image built and qualified at `30061403d`, but was not rolled. Paused-schedule
preflight found two old maintenance executions with `Completed=False`,
`ContainerPermissionDenied` and neither a start nor completion timestamp.
[Cloud Run's v1 contract](https://docs.cloud.google.com/run/docs/reference/rest/v1/namespaces.executions)
defines that condition as terminal failure and the completion timestamp as
optional. The rollout reader previously treated every missing timestamp as
running. Its correction recognizes one explicit terminal condition; absent or
inconsistent terminal evidence and contradictory running counts still block.
Existing failed execution history is preserved. The two recorded
ENABLED schedules were restored, maintenance first, during local qualification
and preparation of a new commit-bound image. No origin migration or roll had
occurred at this stopping point.

## Initial live release and follow-up qualification

The combined origin and managed Jobs rolled to
`c5148225edcd9773e11b7ad2d83bce4f89521b90`, image
`sha256:26e120b8ee7b888e1ba4dc15829aa0adaa73c6e96479695dbf4269500f7024de`.
Public health and the guarded roll receipt verify that source/image binding.
The edge remains `d06a2374cd6202895b0dabb5ec23b44d35dfdb47`; its retained public
manifest hash is unchanged. Both previously enabled schedules were restored
with their observed cadences, maintenance first. A fresh backup and migration
receipt were bound to this candidate; no canonical migration changed.

Authenticated live rendering shows the last recorded complete refresh at
kernel 15, 54 owners and 2,620 owner-days. GitHub evidence includes v0.1.28 and
the stale-snapshot attention item cleared. Queue parity did not qualify: the
new pipeline reader returned journal head 9,999 and correctly withheld a cursor
that appeared ahead, while overview reported 180 queued publication days.
A synthetic PostgreSQL digit-boundary regression reproduced the reader's
incorrect head (9,999 instead of 10,001). The head subquery's unqualified
`ORDER BY sequence` resolves the text output expression. Qualifying
`change.sequence` preserves numeric ordering; the cursor safety guard remains.
The timestamp subquery is qualified as well. A follow-up origin release must
prove live cursor, backlog and queue parity before those panels are qualified.

The owner also assigned this chat integration and deployment of telemetry
recovery commit `6aa004282deb4118ddd1a43c3f4e81970a113375`. The direct human
instruction was verified in its source chat. Integrate into this owned release
line and qualify a new candidate and compatible admin edge assets. Keep the
task nested inside owner maintenance, preserve both existing admin readers,
regenerate embedded assets, and retain the exact public release tree. This
authorization does not include running telemetry preview, adoption, a backfill
or a diagnostic job. Those recovery gates remain separately owner-approved.
Do not reuse the initial release's commit/image/backup/migration bindings.

Follow-up local qualification: 59 PostgreSQL tests passed with no skips,
including both admin readers, forced GitHub sync through the combined owner
maintenance composition, v1.1 recovery and v1.2 unchanged behavior. Origin
admin checks passed 105 cases; compatible edge admin checks passed 112 cases.
The regenerated origin bundle retains kernel 16 and the same compute, vendor
and closure hashes. Rebuilt Cloud Run checks passed 648 cases with four existing
PostgreSQL-dependent skips. Typecheck, architecture, docs and 21 preflight
checks passed. Edge UI passed 1,107 cases with one privacy-title assertion
failure; its source/test are unchanged from live edge `ed3aee03`, where that
failure was reproduced. The earlier edge Worker run passed 2,746 cases and
failed six cases across four unchanged files; three graph timeouts were
reproduced on the exact live-edge archive. This is not a passing full Worker
gate. No assertion, limit or timeout was relaxed.
