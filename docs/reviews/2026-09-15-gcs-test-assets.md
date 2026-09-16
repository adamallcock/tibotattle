---
title: GCS test asset setup
date: 2026-09-15
type: review
status: live-release-adapter-qualified
---

# GCS test asset setup

This records the first fixed-namespace live qualification. Subsequent source
uses per-run namespaces; see the [GCS test runbook](../runbooks/2026-09-15-gcs-adapter-tests.md)
for the current CLI. The object inventory below remains the original receipt.

User-selected target: project `tibotattle`, location `us-east1`. Project identity
and active state were verified through the Google Cloud CLI. All commands use
an explicit project; the existing CLI default project was not changed.
This extends the [local wiring review](2026-09-15-gcs-local-test-wiring.md).

## Current resource state

- Enabled `iam.googleapis.com` and `iamcredentials.googleapis.com` for the selected
  project, as required for keyless short-lived service-account tokens.
- Created `gcs-adapter-test@tibotattle.iam.gserviceaccount.com` for synthetic adapter
  qualification. Verified zero user-managed service-account keys.
- Granted the existing authenticated caller `roles/iam.serviceAccountTokenCreator`
  on this service account only, conditional on time before
  **2026-09-17T00:41:00Z**. Caller identity and credential values are not recorded.
- Billing was initially disabled; the user enabled it and a fresh read confirmed
  `billingEnabled: true`. The agent did not select or link a billing account.
- Created `tibotattle-gcs-test-release-20260915-a7c92f` in `US-EAST1`, Standard
  storage, with uniform bucket-level access and public access prevention enforced.
- Verified seven-day soft-delete recovery (`604800` seconds), no public IAM
  members, and exactly `roles/storage.objectUser` for the test service account on
  this bucket. No project-level storage grant was added.
- Successfully minted a 30-minute short-lived token through IAM Credentials;
  token contents were never logged. The token was held in an owner-only temporary
  file for the local live test, not a tracked fixture or service-account key.

Bucket creation, IAM setup and the bounded live checks below are complete. This
qualifies the test release-object path only, not a GCP deployment or contribution
storage migration.

## Access and recovery plan

`roles/storage.objectUser` is granted to the test service account on the test
bucket only. Do not grant project-level storage access. This predefined role supplies
the object read/create/delete operations required for conditional replacement;
it does not make the bucket public. No long-lived service-account key is needed.

The bounded smoke run uses only fresh synthetic signing material and synthetic
object bytes. It should retain a content-free receipt with exact created object
keys and generation IDs. Do not auto-delete a bucket or prefix: cleanup must
verify the receipt's exact objects and current generations first. Default soft
delete means logical deletion is not proof of immediate physical erasure. This
lane is not contribution-quarantine erasure qualification.

Local nonce state stays in the dedicated D1 simulator, not a remote database.
No Cloudflare deployment or production configuration changes are part of this run.

## Sources

- [Google: short-lived service-account credentials](https://cloud.google.com/iam/docs/create-short-lived-credentials-direct)
- [Google: Cloud Storage IAM roles](https://docs.cloud.google.com/storage/docs/access-control/iam-roles)
- [Google: create buckets](https://cloud.google.com/sdk/gcloud/reference/storage/buckets/create)

## Live application result

The local Worker used persistent local D1 for nonce claims and the real private
GCS bucket for objects. Only synthetic bytes and fresh synthetic signing keys
were used. The live check passed:

- Signed appcast creation through the HTTP application returned 200.
- Replaying the same signed request returned 401.
- Conditional current-generation reads returned the exact expected bytes.
- Object replacement succeeded only for the current generation.
- Writes and reads with a stale generation were refused.
- Two concurrent create-if-absent writes produced one winner and one conflict;
  the stored bytes matched the winner.
- A separate anonymous appcast read returned 401.

Initial attempts reached GCS successfully from Node but failed from the local
Worker before publication. Content-free diagnostics isolated the runtime's
rejection of `redirect: "error"`. The adapter now uses `redirect: "manual"` and
rejects every non-success redirect response without following it. This preserves
credential-origin confinement. Existing redirect-refusal tests remain in place;
only the required fetch mode changed. The succeeding live run exercised this fix.
Three earlier synthetic artifacts remain alongside the final artifact. No failed
attempt published an appcast; subsequent attempts inspected its absence first.

The input access token was removed after validation, and the local listener was
confirmed stopped. The harness deletes its own temporary credential/configuration
and local simulator directories; it does not delete cloud objects. Its local D1
is suitable for this bounded test, not a shared deployed nonce service.

## Repeating the check

`apps/worker/scripts/gcs-live-smoke.mjs --help` describes the explicit bucket,
owner-readable token-file and expiry inputs. It refuses non-test bucket names,
pre-existing local credential configuration, an occupied test port, and an
existing appcast. Start with another approved disposable bucket or perform an
explicitly reviewed cleanup of the exact receipt objects; do not bypass that
existing-appcast refusal. New short-lived credentials are needed for another run.
The temporary impersonation grant expires at the timestamp recorded above.

The harness records attempted keys before writes, confirmed keys and generation
IDs after success, and safe failure codes. An interrupted or uncertain write
requires inspecting its attempted keys before retrying. No cloud deletion is
implicit in success or failure.

## Validation

- Worker TypeScript and portable TypeScript compilation passed.
- Portable GCS/application tests: 17/17 passed.
- Worker GCS adapter and test-composition tests: 18/18 passed.
- Live-harness refusal checks: 6/6 passed, covering help, non-test targets,
  duplicate resource arguments, file permissions, symlinks and hardlinks.
- Dedicated Wrangler dry bundle passed. Architecture passed with 543 production
  files, 2,138 imports and zero debt edges; documentation and 20 preflight tests passed.
- A final read-only harness audit identified ambient environment precedence in
  Wrangler. The harness now removes inherited test-secret variables, disables
  error-report submission, and bounds token-file reads before starting Wrangler.
  The six local refusal checks passed after this hardening.
- Live permission-denied faults and deliberately ambiguous writes were not
  injected; successful checks do not qualify every provider failure scenario.
- Live GCS result: passed as described above. Full production deployment gates
  and GCP-hosted application/database migration remain outside this proof.

## Retained object receipt

Inventory was read directly from GCS after the successful run. These names and
contents are generated synthetic test data. Soft-deleted objects remain subject
to the bucket's recovery policy; this receipt does not claim physical erasure.

| State | Object key | Generation | Bytes |
|---|---|---|---:|
| Live | `gcs-test/appcast.xml` | `1789520135265021` | 469 |
| Live | `gcs-test/releases/1.0.0/078c5df7f8f7defe3d071d69720a22a3880094871d2a6b0853a93c9c74aa1c89/TiboTattle.dmg` | `1789519829763022` | 39 |
| Live | `gcs-test/releases/1.0.0/3d17523a653fab9b3270c278c51fbcff54ffc74c0125859e307af554dd4a0e2b/TiboTattle.dmg` | `1789519994571447` | 44 |
| Live | `gcs-test/releases/1.0.0/8525afc00c97d2e8d643cc0442c88c62aec23a4c297ec06ece41335c5b77d919/TiboTattle.dmg` | `1789519793306607` | 39 |
| Live | `gcs-test/releases/1.0.0/c92bd282565d18966171ee22ea17c7d7b07974cea85a1ef357138cb1077e35a9/TiboTattle.dmg` | `1789519939174437` | 39 |
| Live | `gcs-test/smoke/ssGB0_wP2CJxx9IX/race.bin` | `1789520136012018` | 23 |
| Live | `gcs-test/smoke/ssGB0_wP2CJxx9IX/replace.bin` | `1789520135644236` | 30 |
| Soft-deleted | `gcs-test/smoke/ssGB0_wP2CJxx9IX/replace.bin` | `1789520135485456` | 31 |
