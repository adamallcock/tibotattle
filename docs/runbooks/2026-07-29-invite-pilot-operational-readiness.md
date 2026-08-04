---
title: Invite-Only Pilot Operational Readiness
date: 2026-07-29
type: runbook
status: blocked
---

# Invite-only pilot operational readiness

## Outcome

This runbook takes the central service from the checked-in, unprovisioned state
to a **deployed but collection-contained staging service** and defines the
separately confirmed invitation and activation operations needed for a bounded
pilot. No remote command in this runbook has been run.

A separate human approval is required after staging evidence, privacy copy,
retention policy, restore rehearsal, and operating ownership are complete.

## Safety invariants

- Checked-in staging uses `ENROLLMENT_MODE=disabled`.
- Enrollment, upload registration, processing, and publication must all remain
  contained until a separately reviewed activation change.
- Pilot activation temporarily deploys the same exact staging configuration
  with only `ENROLLMENT_MODE=invite_only`; rollback redeploys the checked-in
  disabled configuration.
- Pilot activation enables enrollment, upload registration, and processing
  together while publication remains disabled. There is no public-open mode.
- Public enrollment is never used. The pilot is invitation-only.
- The service accepts only the closed privacy-safe contribution schemas. It
  never accepts raw Codex logs, prompts, responses, paths, commands, account
  names, or arbitrary JSON.
- Envelope keys, invitation capabilities, recovery capabilities, device
  capabilities, and account/resource identifiers never appear in receipts.
- Account-scoped v0.2 remains a loopback-only experiment and is not authorized
  for external participants.
- A successful infrastructure deployment is not pilot approval.

## Intended first-run contract

1. The website checks `/api/health` for liveness and `/api/ready` for lifecycle
   readiness. These states must be shown separately.
2. The user enters a one-use invitation code and explicitly accepts the current
   privacy disclosure.
3. The website calls `POST /api/v1/enroll` with:

   ```json
   {
     "consentVersion": "privacy-safe-telemetry-v0.1",
     "syntheticOnly": false,
     "inviteCode": "one-use capability supplied out of band",
     "deviceBootstrap": {
       "ongoingUpload": true,
       "consentVersion": "ongoing-privacy-safe-telemetry-v0.1"
     }
   }
   ```

4. D1 atomically commits the participant, personal session, invitation
   redemption, community eligibility, and one-use pairing. A partial bootstrap
   must not survive a failed transaction.
5. The `participant-bootstrap-v0.1` response reports:

   - active session issue and expiry times (30 minutes);
   - an issued non-expiring recovery capability that the user must acknowledge;
   - invitation state;
   - a claimable one-use pairing and expiry time (10 minutes).

6. The website passes the pairing to the installed local companion. The
   companion claims it, stores only its device capability in macOS Keychain,
   and reports success. The device credential expires after 30 days.
7. Each upload still requires a digest- and length-bound one-use upload
   authorization that expires after five minutes.
8. Accepted telemetry is bounded to 100 batches per fixed seven-day window,
   Monday 00:00 UTC through the following Monday. The admission counter stores
   only participant ID, coarse window, count, and last acceptance time.
   Contribution deletion does not refund a slot.
9. The personal profile exposes the exact admission window, accepted batches,
   remaining batches, and renewal time. It returns at most 101 recent history
   items while separately reporting the total. Personal export streams the
   complete retained history. Participant deletion walks all retained
   quarantine references in bounded pages.

The website-to-local-companion handoff and native packaging are separate
client deliverables. The server contract above is ready for those clients to
consume.

## Stage 0: local release evidence

From `apps/worker`:

```sh
npm install
npm run check
```

Required evidence:

- generated Worker bindings are current;
- TypeScript passes;
- script contract tests pass;
- Cloudflare-runtime tests pass;
- the deploy dry run passes;
- staging configuration is safe and intentionally unprovisioned or is bound to
  the exact isolated staging resources.

The disposable HTTP acceptance must additionally prove this sequence using the
atomic bootstrap response:

```text
invite -> atomic enroll/pairing -> pairing claim -> encrypted upload
-> private profile/export -> contribution deletion -> participant deletion
```

No manual telemetry file selection belongs in that acceptance path.

## Stage 1: human Cloudflare account actions

These steps require the account owner. Do not infer consent from an existing
Cloudflare login.

1. Enable R2 and accept any displayed terms or billing consequences.
2. Confirm a pilot budget and billing alert.
3. Create only the isolated resources:

   ```sh
   npx wrangler d1 create app-usagemonitor-staging
   npx wrangler d1 create app-usagemonitor-staging-deletion-ledger
   npx wrangler r2 bucket create app-usagemonitor-staging-quarantine
   ```

4. Put the two returned D1 UUIDs in the matching staging bindings in
   `wrangler.jsonc`. Do not change either ingest mode.
5. Generate a distinct ignored owner-only staging key file:

   ```sh
   npm run keys:staging
   ```

The account owner must supply the exact deployed Workers origin after the first
deployment. It must be a bare HTTPS origin.

## Stage 2: non-mutating readiness

```sh
npm run staging:check
npm run staging:ready
```

`staging:ready` is read-only. A deployable result must prove:

- Cloudflare authentication;
- both D1 resources and the private R2 bucket exist;
- both envelope-key secret names are installed, or are identified as the only
  permitted first-deploy omission;
- both migration streams are current;
- the telemetry admission table and its guard/counter triggers exist;
- lifecycle and quarantine-reconciliation schema exists; and
- all four collection controls are contained.

The JSON output is bounded and excludes command output and resource
identifiers.

## Stage 3: prepare contained remote storage

Deploy the compatible disabled Worker first, observe its active revision and
contained health, and retain the owner-supplied local proof. Only then is this
remote migration mutation reachable and it requires the exact confirmation:

```sh
npm run staging:deploy -- \
  --origin https://EXACT-STAGING-HOST \
  --phase pre_migration_compatibility \
  --identity-receipt-file /owner-only/staging-deployment-identity.json \
  --confirm DEPLOY_COMPATIBLE_DISABLED_STAGING
npm run staging:prepare -- \
  --origin https://EXACT-STAGING-HOST \
  --receipt-file /owner-only/staging-disabled-worker-proof.json \
  --identity-receipt-file /owner-only/staging-deployment-identity.json \
  --confirm PREPARE_DISABLED_STAGING
```

The command applies both migration streams, forces all collection controls to
contained, probes the result again, and emits
`usage-monitor-staging-operation-receipt-v0.1`. The receipt always records
`collectionAuthorized: false` and `activationState: not_authorized`.

Store receipts only in an owner-only operational evidence directory outside
Git. Do not store Wrangler output containing account information.

## Stage 4: deploy contained staging

This is an external deployment and requires the account owner's exact origin
and confirmation:

```sh
npm run staging:deploy -- \
  --origin https://EXACT-STAGING-HOST \
  --confirm DEPLOY_DISABLED_STAGING
```

The wrapper:

- reruns live resource, migration, pilot-schema, and containment checks;
- validates an owner-only key file if first-deploy secrets are needed;
- requires Wrangler's deploy output to name the exact supplied origin;
- verifies `/api/health` is contained over HTTPS;
- verifies `/api/ready` has the closed lifecycle contract, accepting either
  `not_ready` before the first maintenance cycle or `ready`; and
- emits a content-free operation receipt that still does not authorize
  collection.

After the first hourly maintenance cycle, `/api/ready` must become `ready` and
remain fresh. Its two-hour stale threshold means two missed cycles are an
incident.

## Stage 5: remote invitation operations

Do not put an invitation, invitation identifier, participant name, Cloudflare
identifier, API token, or envelope key in a shell argument, receipt, or log.
Use opaque numbered filenames in an owner-only directory outside Git:

```sh
PILOT_EVIDENCE=/absolute/owner-only/pilot-evidence
install -d -m 700 "$PILOT_EVIDENCE"
```

Issue one invitation while collection is contained:

```sh
npm run pilot:invitation -- \
  --action issue \
  --origin https://EXACT-STAGING-HOST \
  --expires-in-hours 72 \
  --invitation-file "$PILOT_EVIDENCE/invite-0001.secret" \
  --receipt-file "$PILOT_EVIDENCE/invite-0001-issued.receipt.json" \
  --confirm ISSUE_STAGING_INVITATION
```

The command:

- requires exact, provisioned staging D1 configuration, Cloudflare
  authentication, and current primary migrations;
- verifies an ordinary contained `collection_controls` row before generating
  any capability or attempting an insert; a `maintenance`, incident, or
  otherwise unverified row returns
  `INVITATION_ISSUANCE_CONTROL_BLOCKED`;
- requires contained HTTP health and fresh `/api/ready`;
- reserves a new mode-0600 invitation file without overwrite;
- passes only a fresh mode-0600 SQL-file path to Wrangler, never the
  invitation capability;
- verifies the exact hash-matching issued D1 row; and
- writes a bounded mode-0600 receipt containing counts, state, expiry,
  revision-independent operation ID, and fixed exclusion claims.

The final D1 `INSERT` repeats the exact ordinary-contained control predicate in
the same SQL operation. If a maintenance fence or other non-issuance state
arrives after preflight, `changes() = 0`, no grant is created, and the wrapper
removes only the exact inode-matched undistributed capability file. If that
exact cleanup cannot be proven, it retains the owner-only file and returns
`UNDISTRIBUTED_INVITATION_FILE_RETAINED` with the fixed recovery action
`remove_exact_undistributed_invitation_file`; it never emits an issuance
receipt for that attempt.

Wrangler output is captured and discarded, Wrangler disk/output-file logging is
explicitly disabled for these wrappers, and log sanitization remains enabled.
The receipt and process output do not contain the invitation, grant identifier,
hash, origin, account ID, D1 identifier, R2 bucket name, or SQL.

Every remote SQL operation uses a newly created owner-only mode-0700 temporary
directory and a mode-0600 SQL file, and verifies both owner and mode before
invoking Wrangler. If cleanup fails, the result and receipt contain only the
fixed warning `PILOT_SQL_TEMP_CLEANUP_REQUIRED`; they do not expose the
temporary path, SQL, invitation identifier, or derived hash. Treat the warning
as local operational cleanup work: inspect only current-user mode-0700
`usage-monitor-pilot-sql-*` directories under the system temporary directory,
match the operation time, remove the exact leftover directory without printing
its contents, and retain the bounded receipt.

If the remote command may have committed but its response was lost, the
invitation file is retained and the result is
`INVITATION_ISSUE_UNVERIFIED`. Do not distribute it. Choose exactly one
recovery:

```sh
npm run pilot:invitation -- \
  --action resume-issue \
  --invitation-file "$PILOT_EVIDENCE/invite-0001.secret" \
  --receipt-file "$PILOT_EVIDENCE/invite-0001-resumed.receipt.json" \
  --confirm RESUME_STAGING_INVITATION_ISSUE

npm run pilot:invitation -- \
  --action rollback \
  --invitation-file "$PILOT_EVIDENCE/invite-0001.secret" \
  --receipt-file "$PILOT_EVIDENCE/invite-0001-rollback.receipt.json" \
  --confirm ROLLBACK_STAGING_INVITATION
```

Resume is read-only and succeeds only for the same unexpired, hash-matching
issued row. Rollback deletes only that same unredeemed row, writes its receipt,
then removes the exact invitation file inode. Both operations are retry-safe
when each retry uses a fresh receipt filename; receipts are intentionally
no-clobber.

Revoke an unredeemed invitation with:

```sh
npm run pilot:invitation -- \
  --action revoke \
  --invitation-file "$PILOT_EVIDENCE/invite-0001.secret" \
  --receipt-file "$PILOT_EVIDENCE/invite-0001-revoked.receipt.json" \
  --confirm REVOKE_STAGING_INVITATION
```

Revocation is idempotent for an already absent row. It refuses a redeemed
invitation; participant/device/session handling must then use the participant
contract rather than rewriting enrollment history. Retain each invitation
file only in the owner-only directory until redemption, revocation, or expiry,
then remove it through the reviewed operation or an operator-approved cleanup.

## Stage 6: human pilot activation gate

Do not activate the pilot until every item below has a named human owner and
recorded evidence:

- privacy disclosure and consent version approved;
- seven-day encrypted-quarantine policy approved;
- canonical metadata retention policy approved;
- production backup horizon and deletion-tombstone margin approved (the
  current 400-day development tombstone is not a production decision);
- D1 primary plus independent deletion-ledger backup and stopped-service
  restore rehearsed together;
- R2 reconciliation and deletion retry rehearsed;
- operational alerts for failed/stale maintenance, D1/R2 errors, 5xx rate,
  enrollment abuse, and admission exhaustion configured;
- spend cap and billing alert configured;
- invitation issuance, expiry, revocation, and support ownership assigned;
- recovery-code loss and device re-pairing support copy approved;
- macOS signing/notarization and browser-to-companion handoff verified on a
  clean Mac;
- end-to-end acceptance completed against staging in supported browsers; and
- a separate reviewed activation approval authorizes staging to move from
  disabled to invite-only through the command below. No generic public-open
  mode is permitted.

Inspect the exact runtime mode, lifecycle state, and current optimistic D1
revision without mutation:

```sh
npm run pilot:control -- \
  --action inspect \
  --origin https://EXACT-STAGING-HOST
```

Inspection returns failure when the live health control shape disagrees with D1
or either state is unverified. Do not use a mismatched inspection revision for
activation.

After reviewing the inspection and issued-invitation receipts, activate using
that exact revision:

```sh
npm run pilot:control -- \
  --action activate \
  --origin https://EXACT-STAGING-HOST \
  --expected-revision EXACT_REVISION \
  --receipt-file "$PILOT_EVIDENCE/pilot-activate.receipt.json" \
  --confirm ACTIVATE_STAGING_INVITE_PILOT
```

Before any pilot-control mutation, the wrapper reruns full live staging
readiness for both exact D1 resources and both migration streams, the private
R2 bucket, both required envelope secrets, and the pilot schema. New activation
or resume additionally requires the exact optimistic D1 row to be contained.
Pause, rollback, and an exact lost-response replay may begin active, so only the
expected `REMOTE_COLLECTION_NOT_CONTAINED` readiness blocker is waived for
those paths; every secondary-resource and configuration blocker remains fatal.

Activation also requires fresh HTTP lifecycle readiness. It performs a strict
deploy against the exact staging bindings with three fixed non-secret runtime
variables: `ENVIRONMENT=staging`,
`ENROLLMENT_MODE=invite_only`, and
`ACCOUNT_SCOPED_INGEST_MODE=disabled`. It verifies the exact origin while
discarding deploy output, then uses an optimistic D1 revision to enable only
enrollment, upload registration, and processing. Publication stays disabled.
It verifies health and lifecycle again. A failed post-enable verification
automatically fences and contains D1 before redeploying the checked-in disabled
runtime; an unverified rollback is an incident and must be reinspected before
any further action.

Automatic failed-enable rollback owns only the exact active
`expectedRevision + 1` row created by that attempt. It atomically contains that
row as a `maintenance` rollback fence at `expectedRevision + 2`; every ordinary
pilot mutation rejects that fence. The wrapper reconfirms the exact fence
immediately before any disabled deploy, verifies the disabled runtime, and then
releases the fence at the same revision. If any newer revision or different
control shape is observed, it emits
`PILOT_ENABLE_ROLLBACK_REVISION_CONFLICT`, performs no disabled deploy or fence
release, and requires manual incident containment. This rule prevents a delayed
activation process from overwriting a newer reviewed operator action.

If the process stops after acquiring the fence, inspection reports
`STAGING_PILOT_ROLLBACK_FENCE_PENDING`. Do not activate, pause, or resume. Run a
reviewed rollback with the exact fence revision reported by inspection, the
exact rollback confirmation, and a fresh receipt filename:

```sh
npm run pilot:control -- \
  --action rollback \
  --origin https://EXACT-STAGING-HOST \
  --expected-revision EXACT_FENCE_REVISION \
  --receipt-file "$PILOT_EVIDENCE/pilot-fence-recovery.receipt.json" \
  --confirm ROLLBACK_STAGING_INVITE_PILOT
```

Fence recovery accepts only that exact contained `maintenance` row. If the
runtime is still invite-only it deploys disabled once; if disabled was already
deployed it does not redeploy. It then releases the fence, verifies the exact
contained revision and disabled HTTP state, and emits
`STAGING_INVITE_PILOT_ROLLBACK_FENCE_RECOVERED`. A different revision fails
closed without a deploy. Invitation `issue` and `resume-issue` also fail closed
while the fence is pending, before an insert or new local capability artifact;
invitation revoke and rollback remain available as tightening operations.

Pause collection without redeploying so a reviewed resume remains possible:

```sh
npm run pilot:control -- \
  --action pause \
  --origin https://EXACT-STAGING-HOST \
  --expected-revision EXACT_REVISION \
  --receipt-file "$PILOT_EVIDENCE/pilot-pause.receipt.json" \
  --confirm PAUSE_STAGING_INVITE_PILOT
```

Pause reports failure, while retaining the verified D1 containment receipt, if
live health does not confirm an invite-only contained runtime. Reinspect and
retry with a fresh receipt filename or proceed to rollback; do not interpret
D1 containment alone as proof that the pause is fully verified.

Reinspect, then resume from the new contained revision:

```sh
npm run pilot:control -- \
  --action resume \
  --origin https://EXACT-STAGING-HOST \
  --expected-revision EXACT_REVISION \
  --receipt-file "$PILOT_EVIDENCE/pilot-resume.receipt.json" \
  --confirm RESUME_STAGING_INVITE_PILOT
```

Resume refuses a disabled or stale/unready runtime and never enables
publication. To end the pilot, contain D1 and restore the checked-in disabled
runtime:

```sh
npm run pilot:control -- \
  --action rollback \
  --origin https://EXACT-STAGING-HOST \
  --expected-revision EXACT_REVISION \
  --receipt-file "$PILOT_EVIDENCE/pilot-rollback.receipt.json" \
  --confirm ROLLBACK_STAGING_INVITE_PILOT
```

Every mutation requires the exact current revision and exact action-specific
confirmation. A retry can recognize the desired `expectedRevision + 1` state
after a lost response, but any other revision or control shape fails closed.
Receipts are capped, mode-0600, no-clobber, and contain no origin or resource
identifier.

## Incident containment

When collection integrity, privacy, billing, or lifecycle state is uncertain:

1. Stop issuing invitations.
2. Run `pilot:control --action inspect`. If it reports a pending rollback
   fence, use the exact-revision fence-recovery command above. Otherwise, if
   the current pilot revision is known, run `pilot:control --action pause` with
   the exact pause confirmation. If the control state cannot be verified,
   re-run the contained preparation command only with a fresh compatible
   Worker proof:

   ```sh
   npm run staging:prepare -- \
     --origin https://EXACT-STAGING-HOST \
     --receipt-file /owner-only/staging-disabled-worker-proof.json \
     --identity-receipt-file /owner-only/staging-deployment-identity.json \
     --confirm PREPARE_DISABLED_STAGING
   ```

3. Confirm `/api/health` reports all four controls contained.
4. Revoke any still-unredeemed invitation files held by the operator.
5. Preserve bounded readiness/operation receipts and Cloudflare request IDs;
   never copy secrets or contribution contents into the incident record.
6. Diagnose D1, R2, deletion-ledger, lifecycle, and reconciliation state before
   considering reactivation.

Participant access, export, and deletion are intentionally independent of
publication containment. If the deletion ledger is unavailable, deletion fails
closed with the participant left in a retryable deleting state.

## Restore and crash-recovery gate

A restore is not ready to serve merely because D1 opened successfully.

1. Stop service traffic.
2. Restore `USAGE_MONITOR_DB` and `DELETION_LEDGER` from the same documented
   recovery point, preserving the deletion ledger independently.
3. Reconcile restored D1 quarantine references with the private R2 bucket.
4. Run deletion-ledger replay, retention, aggregate rebuild, and pending-object
   reconciliation.
5. Require `/api/ready` to report fresh lifecycle, retention, replay, rebuild,
   matching maintenance cycle, and reconciliation completion.
6. Run the disposable lifecycle acceptance again before serving pilot traffic.

Remote backup automation and a production restore rehearsal remain human/cloud
gates; the current code proves the fail-closed protocol but does not create
paid backup infrastructure.

## Current external blockers

| Blocker | Required owner/action |
| --- | --- |
| R2 account enablement | Cloudflare account owner accepts terms/billing |
| Isolated D1 and R2 resources | Cloudflare account owner creates resources |
| Real staging D1 identifiers | Developer inserts exact returned UUIDs |
| Staging envelope secrets | Operator generates/installs owner-only keys |
| Contained deployment | Account owner authorizes exact origin and deploy |
| Domain choice | Product owner chooses and configures a pilot hostname |
| Privacy and retention approval | Product/privacy owner signs off policies |
| Backup and restore evidence | Operator provisions and rehearses recovery |
| Alerts and spend guardrails | Operator configures budgets and monitoring |
| Invitation cohort | Product owner approves users and support process |
| Pilot activation | Human authorization plus exact revision/confirmation |

Until those actions occur, the correct release state is **blocked but safely
testable locally**.
