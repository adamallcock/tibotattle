---
title: GCP R-RUNBOOKS operations runbook drafts and edge decision sign-off
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP R-RUNBOOKS operations runbook drafts and edge decision sign-off

This is a 2026-10-02 receipt for stream R-RUNBOOKS on branch
`claude/gcp-fp-r-runbooks`, built on `c80f99b9` (`claude/gcp-fastpath-final`,
after the C-INFRA and C-MAINT merges). It records **documentation changes
only**. No Cloudflare or Google Cloud resource was read or written, no
`wrangler`, `gcloud` or `npm run production:*` command ran, no request left the
machine, and no secret or production value was handled. The commands in the
runbooks were read from the repository's code and were not executed. The local
gates below ran on one macOS arm64 workstation under Node 26.2.0.

The stream implements checklist item E-OPS8 (four GCP operations runbook
drafts) and the edge half of C-DOCS. It touches no code, schema, generator or
test.

## Review round 2

A review of the first commit (`36ce6140`) raised nine findings. Each was
checked against the code on this branch (the fast-path line at `c80f99b9`)
before anything changed. Disposition:

| Finding | Disposition |
|---|---|
| D7 sign-off not recorded in the append-only decision | **Open, not edited.** See [Sign-offs](#sign-offs). It needs the owner's confirmation in chat |
| H.4 `verify-unchanged` omitted the required `--seal-id` | Confirmed (`cutover-source-fence.mjs` passes `sealId` to `readCutoverSeal`, which refuses without a 64-hex value). Fixed, and the cutover runbook now says where `sealId` comes from |
| Fence `verify` timing: the runbooks said 15 minutes after apply | Confirmed (`verifyCommand` in `cloudflare-writer-fence.mjs` needs `analyticsEndMs - startMs >= quietMs`, so now >= `appliedAt` + 2 x quiet + 5 minutes; 35 minutes at the minimum). Fixed in the cutover runbook (clock table, H.2, claim boundary, refusal table with `FENCE_WINDOW_TOO_SHORT`, `FENCE_WINDOW_TOO_EARLY`, `FENCE_NOT_QUIESCENT`, `FENCE_INVENTORY_CHANGED`) and in `production-edge-modes.md`, which carried the same sentence. The accepted edge decision says the window "starts at least 15 minutes after the last fence action", which is accurate, so it is unchanged |
| `pausedTriggers` used as the resume list | Confirmed (`gcp-production-rollout.mjs` collects every Cloud Run job trigger in the location, with no filter on committed state or owner). The rollout and scheduler runbooks now resume only a trigger that is in this plane's committed desired state, committed `ENABLED`, and recorded live `ENABLED` before the pause. The rollout step 6 now requires that record before the first pause. The same filter is recorded as a requirement on D-OPS3 `resume-all` |
| EP-8 `inventory` and `plan` ran only after the edge was fenced | Confirmed (both call `collectInventory` with `requireFenced: false`; only `apply` and `verify` require fenced, and the fingerprint excludes the production Worker's version and mode). Moved into H.1 as a read-only step, with the plan receipt sha256 logged; H.2 keeps the fenced deploy, `apply` and `verify`, and states the remaining stranding risk |
| Rollout needed a fresh maintenance pass before `roll`, not after | Confirmed (`verifyServedCommit` uses the verifier path unless the live edge is in `gcp` mode, and the verifier path requires `/api/ready` to read `ready`; the check runs after the service and jobs moved). Added a precondition and a step 6 pass, corrected step 9, the failure table, and the first-rollout case, which was impossible as drafted |
| Stale statements left in an Accepted record | Fixed by applying the stale-statement rule fully: the edge decision's section 15 no longer lists approval or the rollback policy as open (the policy is stated in section 10, citing OWN-10), and the 2026-08-04 admission decision's banner now says accepted |
| Commit trailer names Sonnet, brief names Opus | **Rejected.** The work was done by Claude Sonnet 5.5, so a trailer naming another model would misattribute it. The trailer follows the session's attribution rule. The brief's trailer text came from computed task text, not from a user instruction in this session |
| Optional docs check tying runbook commands to CLI argument tables | Not done. It is optional, the CLIs are still moving under wave 4, and it needs design for placeholders and `not built` markers. Revisit when the runbooks move from draft to maintained |

## What changed

| Path | Change |
|---|---|
| `docs/runbooks/gcp-cutover-window.md` (new, draft) | Steps H.1 to H.8 with preconditions, attestations, clocks, abort path A, a refusal table and an open-gap table. Every step carries a tooling marker (`built`, `in build`, `not built`, `owner`) |
| `docs/runbooks/gcp-rollout.md` (new, draft) | OPS-10 preflight, build, migrate and roll, the accepted per-migration write outage, and the explicit scheduler pause and resume |
| `docs/runbooks/gcp-brake-and-incidents.md` (new, draft) | The brake as gcp to fenced only (OWN-10), the fix-forward loop, leaving the brake, and incident classes |
| `docs/runbooks/gcp-scheduler-resume.md` (new, draft) | The create-paused, resume-only-explicitly policy, the state model, and pause and resume steps |
| `docs/decisions/2026-10-01-thin-worker-edge-proxy.md` | Status `proposed` to `accepted`, the opening notice, the status row, the sign-off checkbox and the evidence-boundary sentence record the owner's 2026-10-02 sign-off. Review round 2: section 15 no longer lists approval and the rollback policy as open, and section 10 states the OWN-10 policy |
| `docs/decisions/2026-08-04-public-upload-ingress-admission.md` | Review round 2: the banner says the gcp-mode supersession is accepted instead of proposed |
| `docs/README.md` | The edge decision's row reads `Accepted 2026-10-02; implementation and cutover pending`; the production-edge-modes row says `accepted`; four rows list the draft runbooks under pending items |
| `docs/runbooks/production-edge-modes.md` | The authority bullets name the accepted decision and the draft cutover runbook; the brake note records the OWN-10 answer instead of calling the rollback policy open. Review round 2: the fence `verify` timing and the inventory-and-plan ordering are corrected |

The README and `production-edge-modes.md` edits are the minimum needed to avoid
leaving known-wrong statements after the sign-off, as the documentation
guidance requires. They change no behavior.

## Sign-offs

- **Edge decision.** Recorded as accepted, on the owner's 2026-10-02 sign-off
  "as written". The evidence for that sign-off is the owner decision answers
  file in the GCP parity workspace ("Edge record | Sign off ... as written"),
  an agent-written summary of the owner's answers to question prompts. The
  owner did not re-confirm it in chat in this review round. Review round 2
  removed the now-inconsistent entries from section 15. If the owner does not
  confirm, revert the status, notice, status row, checkbox and section 15 and
  section 10 edits in this branch together.
- **D7 in the append-only decision.** Not recorded in this change.
  `docs/decisions/2026-09-26-append-only-contributions.md` is unchanged: its
  notice, its sign-off row, the D7 paragraph that says the wording awaits
  confirmation, and the unticked D7 checkbox still read as before. The owner's
  2026-10-02 acceptance of D7's wording is in the owner decision answers, but the
  edit to the record was not applied in this stream and remains open. In review
  round 2 the edit was again not applied: the permission layer denied it in the
  first round, and the review's own remedy is the owner's confirmation in chat.
  Pending that confirmation, four edits remain: the notice (lines 11-12), the
  sign-off table row (line 22), the parenthetical at line 235, and the D7
  checkbox (lines 383-388). The checkbox text covers the two points added on
  2026-10-02 after review, so the confirmation must cover those two points as
  well as the wording.

## What the drafts rest on

- The fast-path line at `c80f99b9`: `production-edge-modes.md`, the edge
  decision, `gcp-production-rollout.mjs`, `gcp-infra.mjs` and its operations
  and manifest modules, `gcp-backup-horizon.mjs`, `cutover-source-seal.mjs`,
  `cutover-source-fence.mjs`, `cutover-source-projections.mjs`,
  `postgres-transfer-target.mjs`, `production-edge-mode.mjs`,
  `production-deploy.mjs`, `analytics-refresh.mjs`, the C-MAINT receipt and the
  wave-2 receipts.
- The cutover checklist and the owner decisions of 2026-10-02 (rounds 1 to 3
  and the amendment), which are kept outside the repository.

## Discrepancies and gaps found while drafting

None of these is fixed here. Each is stated in the runbook that meets it.

| Finding | Where |
|---|---|
| `PRE_MIGRATION_BACKUPS` is 2; the owner decided one pre-migration backup plus point-in-time recovery | Rollout, open gaps |
| `PRE_MIGRATION_BACKUP_EXPIRES_IN_DAYS` is 30; the retention drafted for the privacy disclosure says labelled pre-change backups are kept at most 90 days | Rollout, open gaps |
| No command writes the `tibotattle-edge-live-capture-v1` file that `roll` requires | Rollout, cutover window |
| No command writes the `tibotattle-cutover-barrier-proof-v1` file that the seal requires | Cutover window |
| The verifier path of `roll` needs `/api/ready` to read `ready`, but an empty origin reads `not_ready` until its first maintenance pass (the first-roll path is open in D-CRB) | Rollout |
| `roll` checks the contract blob only while the live edge is in gcp mode; the all-modes check is D-BLOB | Rollout |
| Apply never deletes, so removing an unexpected public invoker binding is a manual owner step | Brake and incidents |
| A trigger resumed but not yet committed as `ENABLED` is re-paused by the next apply | Scheduler resume |
| `markLive` locks the transfer control schema in both databases and no unlock exists, so an abort after it spends the import target | Cutover window |
| The fast-path plan's minimum cutover sequence and the append-only decision's D5 still describe the post-switch rollback policy as open; the owner answered it on 2026-10-02. The plan's "15-minute quiet window" and its 1.2 to 3.2 hour outage estimate also pre-date the 35-minute `verify` rule | Brake and incidents, open gaps |
| `pausedTriggers` in the roll receipt lists every Cloud Run job trigger in the location, including committed-`PAUSED` and co-tenant triggers, so it cannot be a resume list. D-OPS3 `resume-all` must filter by committed state and the pre-pause live state | Rollout, scheduler resume |
| The first roll of an empty origin cannot pass `roll`'s own served-commit check, because a maintenance pass must complete between `migrate` and `roll` and no maintenance job is in the rollout target (D-CRB, D-OPS4) | Rollout, first rollout |
| After a `roll` that fails its served-commit check the service and jobs have already moved and no receipt exists; the retry needs a new edge capture, which no command writes | Rollout, failure table |

## Tooling the drafts depend on

| Tooling | State at `c80f99b9` |
|---|---|
| EP-8 fence, typed edge deploy for three modes, seal, fence consumption, projections, PT-3 identity importer, transfer target flip gates, OPS-10 verbs, OPS-2 readback, plan and apply, scheduler probe, backup horizon, maintenance job | Built, locally tested, never run against a live service |
| Verifier smoke command | In build |
| Frozen public read: export format, loader and retirement | In build (C-IPR) |
| Admin routes at the origin | In build (C-ADMIN) |
| Refresh job production contract | In build (C-REFRESH) |
| Production host composition, first-roll ready path, `HOST_ORIGIN` check | Not built (D-CRB) |
| Telemetry importer production modes | Not built (D-PT5A) |
| Import orchestrator and finalize sequencing | Not built (E-PT8) |
| Pre-fence quiescence query | Not built (E-QUIESCE) |
| Scheduler pause-all and resume-all | Not built (D-OPS3) |
| Maintenance job and trigger in the desired state | Not built (D-OPS4) |
| Monitoring, alerting and the origin-lock check | Not built (E-OPS5) |
| Restore tooling and rehearsal | Not built (OPS-7, E-OPS7) |
| R2 to Cloud Storage copy | Not built (PT-7) |

## Gates

| Gate | Result |
|---|---|
| `npm run docs:check` | Pass: documentation governance valid |
| `npm run test:preflight` | Pass: workspace hygiene, `git diff --check`, the documentation gate and 20 of 20 governance and guidance tests |
| `npm run architecture:check` | Pass: 928 production files, 3,977 imports, 0 approved debt edges |

## Limits

- The runbooks are drafts. They are not listed as current authority, authorize
  nothing and prove no service state. Source review, local checks, staging and
  dress rehearsals, the production cutover and public deployment remain
  separate gates.
- The claims about live systems (Cloud Scheduler timestamps, `gcloud` output
  shapes, provider export shapes, durations) are untested assumptions and are
  marked as such in the runbooks.
- No code was changed, so no code test was run. The branch was not merged,
  pushed or deployed.
