---
title: Production accountless contribution activation proposal
date: 2026-09-09
type: plan
status: proposed
---

# Scope and evidence

Prepare production collection for the accepted [Electron sharing policy](../decisions/2026-09-04-accountless-sharing-policy.md). This proposal authorizes no remote write, credential renewal, migration, deployment, public admission, or release publication. Public health was read on 2026-09-09: deployment `32cd6317622c9aef9b7bf015b376b4cdb93c91fc`, operational collection with enrollment/upload registration/processing/publication enabled, and passing reported storage/lifecycle checks. This endpoint does not expose accountless mode fields. A read-only production ledger observation at `2026-09-09T18:10:17.308Z` found primary migrations 0001–0056 applied and deletion-ledger migrations 0001–0002 applied. Read-only deployment and secret-name inspection at 18:19 UTC confirmed both accountless mode variables are absent (therefore disabled), collection revision 1 is operational with all four stages enabled, and all five required secret names are present and bound. No secret values were read. The credential-free observation is retained in the private qualification artifact directory.

The [Electron readiness record](2026-09-05-electron-release-readiness.md) records the signed staging pass: automatic accepted upload, authenticated restart with retained installation binding, and persistent opt-out. The separate signed untouched-install run [34386204318](https://github.com/adamallcock/tibotattle/actions/runs/34386204318), using runner `e33c6b37` and signed app `c0c98040`, also passed: the real native introduction was completed and the app created default-on sharing without a seeded preference or acknowledgement. The three-visible-notice transition has focused source/composition evidence; no seven-day signed migration run is claimed.

Enrollment, upload ownership, encrypted v1.1 transport, renewal, scheduling, opt-out fencing and installation-scoped replay protection are implemented. Production configuration still omits both accountless mode flags, whose server defaults are disabled. Public selectors explicitly exclude accountless owners. The older September 4–5 integration/migration proposals are historical, not the current implementation boundary.

# Observed migration admission and local result

The exact pending primary set from that production observation is:

| Migration | Reviewed SQL SHA-256 |
|---|---|
| `0057_accountless_enrollment_ledger.sql` | `5cbf718449688bffc0fc5cf63d1de17351acb915f44459f1b32f3202c7378cd5` |
| `0058_accountless_upload_ownership.sql` | `b435fd92d41e7ce8067cc183d7ac153359a9c130a971cba2e1b8b8c1c9cab61b` |
| `0059_accountless_upload_renewal.sql` | `98afb99dd91e56a96960e6d99096e44c41eec0cd52d5a1e2969dea4ddee3d312` |

No deletion-ledger migration is pending. The observation queried only migration
names, not production telemetry. D1's names-only ledger does not attest the
historical SQL bytes; final admission must recheck the prefix and retain the
existing deployment evidence.

The contained local gate passed with 1,000 synthetic accounts, 100,000 records
in each of the two telemetry tables, a 50% heavy-source skew and a 336-day
observation span. Each pending migration passed interrupted-transaction rollback,
forward preservation, foreign-key and integrity checks; replay performed zero
writes. The primary ledger reached 59 entries and deletion ledger stayed at 2.
Elapsed time was 16.953 seconds, peak reported RSS 120,848,384 bytes, primary
SQLite size 151,183,360 bytes, and deletion SQLite size 749,568 bytes. Node was
26.2.0 with SQLite 3.53.1 on Darwin arm64. The external watchdog confirmed owned
process termination. These are synthetic local resource observations, not
production-size or Cloudflare execution guarantees.

Private owner-only evidence is retained under
`production-activation-preparation-20260909/` in the qualification artifact
root: `production-prefix.json`, `migration-admission.json`, and
`local-populated-rehearsal.json`. The receipt binds prefix digest
`1106b1641acc84885b5e4680f7bf9a46cc988dd3038af582683973c23fc663d1` and full
migration-inventory digest
`1d50458ac1006c9de7b26c312df61d992ff28b709624742bbcafdc5790babc99`.
It explicitly records `freshness: supplied-snapshot-not-live`,
`remoteSyntax: not-exercised`, and `productionReadiness: false`. No production
migration, remote syntax write or deployment was performed.

# Live configuration and recovery preparation

At `2026-09-09T18:19:57Z`, the active deployment was
`949daaea-948c-4da4-9f35-5b3493d1348e`, created September 8 at 14:39:51 UTC,
with version `8258bfd0-5c19-4127-a23c-0f325f18044e` receiving 100% of traffic.
Both accountless mode variables are absent; `ENROLLMENT_MODE` is `open`,
`ACCOUNT_SCOPED_INGEST_MODE` is `disabled`, and the identity-link version is
`production-v1`. Required secret-name checks passed for both envelope keys,
`IDENTITY_LINK_SECRET`, `APPLE_PRIVATE_KEY`, and `GOOGLE_OIDC_CLIENT_SECRET`.
Presence is not a claim that key contents were read or independently validated.
Collection revision 1 is `operational`, reason `initial`, with enrollment,
upload registration, processing and publication all enabled. The closed
`required-secret-presence.json`, `deployment-config-metadata.json`, and
`collection-control-metadata.json` receipts retain those observations privately.

Both D1 bindings returned current recovery bookmarks at 18:21 UTC, retained in
`recovery-bookmarks.json`. These establish bookmark availability only. They are
not the eventual migration restore targets because collection was still open.
No database export, restore or remote syntax rehearsal was performed.

The exact migration operation should include these recovery controls:

1. Recheck the source SQL hashes and both prefixes. Through the maintained
   revision-checked production control operation, pause collection for the
   bounded migration window and verify the resulting revision and all four
   disabled flags. This short interruption is part of the operation requiring
   approval; do not use the local-only collection-control script remotely.
2. After that readback, retrieve fresh Time Travel bookmarks for both databases
   and retain the timestamps privately. The primary restore point must itself
   contain the paused controls, avoiding an accidental reopening after restore.
   Confirm the actual recovery window with the provider; do not infer its length
   from the current bookmark. Cloudflare documents an always-on recovery history
   whose window depends on plan, and an in-place destructive restore. See
   [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).
3. Apply only primary 0057–0059 using the canonical migration tool, then observe
   both ledgers again. Preserve the exact migration outcome, schema/FK/integrity
   checks and bounded preservation summaries. A timeout is an uncertain result:
   inspect the ledger and stop before a blind retry or deployment. No deletion-
   ledger migration, key rotation or R2 rewrite belongs to this operation.
4. Prefer forward repair if admission fails. Never delete ledger entries or
   reverse 0058 by hand. A separately approved emergency primary restore must
   use the captured paused bookmark and retain the newest independent deletion
   ledger; rewinding that ledger could resurrect erased sources. Preserve the
   pre-restore/undo bookmark too. Reconcile the restored schema with compatible
   code and reapply the reviewed forward migrations before reopening service.
5. Keep collection paused until required lifecycle work has replayed the latest
   tombstones and identity cooldowns, reconciled quarantine, and reported
   `restoreReplayComplete` with no unfinished owner/restore fence. Preserve R2
   deletion results; never recreate missing objects or clear tombstones to make
   recovery pass. Resume the previously recorded collection settings through a
   separate revision-checked readback. A bookmark does not qualify this recovery
   procedure as executed; no production restore has been rehearsed.

# Bounded production canary and cleanup

The canary is one synthetic source in a newly provisioned GitHub-hosted Mac
account, using an explicitly selected ordinary signed Electron artifact and
verified source/ASAR digests. It must refuse any existing normal profile,
legacy TiboTattle state or Codex directory before creating the tiny fixture.
Do not repoint the staging marker or introduce production credentials into CI.
The same existing native introduction, Settings bridge and owned-process
controls can establish acceptance, retained binding after restart and durable
opt-out. Limit the fixture to two content-free usage/quota events; do not query
or copy user history. An unchanged-input restart proves retained installation binding and an
authenticated ownership request before the zero-work incremental check. It does
not prove duplicate-record counts on the server; that requires a separate
bounded owner readback. Neither observation proves every possible duplicate
upload attack is prevented.

Settings off stops future delivery; accountless production deliberately does
not expose the older loopback disconnect route. The maintained cleanup is the
Access-owner `run_maintenance` action with an exact `participantErasure` target,
which revokes accountless authority and runs the deletion-safe pipeline. The
accountless ownership response reveals only the synthetic device ID, so resolve
its one participant through a private exact-device lookup before erasure.
Never infer the target from a timestamp, recent row or aggregate count.

A one-run owner public key may encrypt that synthetic device ID for the local
owner; its private key stays local. CI artifacts must contain neither raw
identifiers nor credentials. A runner result remains `cleanup_required` until
the owner decrypts the handoff, verifies the app/source binding, resolves only
that exact owner, and completes the maintained Access-owner, origin/header-protected erasure.
Retain only the operation reference, participant digest and closed result. An
ordinary maintenance response, opt-out, expired CI machine or timeout is not
erasure. Failed cleanup remains a visible retained synthetic contribution,
with the paused local source and owner retry procedure preserved.

Before requesting the canary's final approval, bind the reviewed wrapper,
artifact digests, one-run cleanup public-key digest, fixture limit and this
single-source owner-erasure scope. No current script execution is authorized
by this proposal alone. The production accountless flags must be deployed and
verified first; all accountless public selectors remain excluded. Public sample
admission is a separate product and aggregation decision below.

# Prepared executable canary

The separate [canary workflow](../../.github/workflows/electron-production-canary.yml)
uses a fresh `macos-26` account, pinned Node 26.2.0, read-only repository access
and no production secrets. Push only registers the workflow; the canary job is
manual-dispatch-only and defaults to `plan`. The reviewed runner commit must
match `GITHUB_SHA`. No staging workflow or staging endpoint is repointed.

Its artifact allowlist is exactly:

- [Normal .18 arm64 ZIP](https://updates.tibotattle.com/electron/rehearsal/native-to-electron-handover-v1/darwin-arm64/TiboTattle-0.1.19-native-to-electron-handover.18-mac-arm64.zip), 119,158,056 bytes;
  SHA-256 `98d32e2a25b4d860d1a60cbdc94fc2a2dbb2dc3e0af58510a0e85e6d1fa24936`.
- Signed application source `7293828ade187f6fd9e50c67d7018704150ca156`;
  ASAR SHA-256 `e7c725a0902a18a0970265a8b32535fbe8e447829754592af91fc709eb0a987e`.
- Version `0.1.19-native-to-electron-handover.18`, build `2026090920`.
  This is the normal production contribution runtime with the deliberately
  separate Mac handover test update channel, not a stable public release.

The [runner](../../scripts/run-signed-electron-production-canary.mjs) successfully
completed local `--plan` against those installed bytes after exact digest,
source, ordinary manifest and production Developer ID signature verification.
The private `production-canary-plan-qualified.json` receipt records preparation
only. No application launch, real profile read or production request occurred.
A one-run RSA-4096 cleanup key pair was generated locally with owner-only
permissions. Its public PEM digest is
`05130deadb623f30fe4986e30303d506fc9531737fb75ebd4f83a9853a3123f8`;
its private key remains local and is never a workflow input.

After review/commit, dispatch `electron-production-canary.yml` with `mode=plan`,
that exact 40-character runner commit, the artifact identities above, the
base64-encoded **public** PEM and its digest, with empty `confirmation`. This
qualifies hosted intake only. Once the schema/configuration operations and
single-source production canary are explicitly approved, the same inputs use
`mode=execute` and `confirmation=RUN_ONE_SYNTHETIC_PRODUCTION_CANARY`. The runner
requires the actual disposable OS account, untouched normal/legacy/Codex paths,
and real native Continue interaction. It writes only the tiny synthetic fixture;
no default-on preference or acknowledgement is injected.

A completed client journey exits with `cleanup_required`, not a release pass.
Only closed receipts and an AES-GCM encrypted target with an RSA-OAEP wrapped
key are uploaded. The owner privately decrypts the exact operation/source/ASAR-
bound device target, resolves its participant, performs the maintained targeted
erasure and verifies completion. Any timeout, missing target, unfinished fence
or partial enrollment stays unresolved. The controlled process restart is not a
native menu-quit qualification. The workflow has not yet executed; hosted
intake, production acceptance, duplicate-count readback, public exclusion and
owner erasure are not claimed by the local plan or unit tests.

# Proposed operation sequence

1. **Read-only intake.** Observe both production D1 migration ledgers with the maintained [migration rehearsal command](../runbooks/release-migration-rehearsal.md#observe-the-deployed-prefix). Record the exact Worker revision and collection-control revision/values. Inspect required secret names and bindings without reading or rotating their values. Preserve existing production encryption keys and the identity-link key/version.
2. **Prepare exact migration admission and recovery.** Canonical accountless source migrations are `0057_accountless_enrollment_ledger.sql`, `0058_accountless_upload_ownership.sql`, and `0059_accountless_upload_renewal.sql`. These are the exact pending names at the observation above; the corresponding populated local rehearsal passed. Recheck the remote prefix and intended source before admission. Migration 0058 snapshots/rebuilds populated ownership tables and restores their descendants; prepare the production backup/recovery and deletion-ledger implications before requesting approval for the exact pending set. Retained synthetic preservation tests do not measure current production size or attest remote migration bytes.
3. **Apply only the approved migration operation.** Use the maintained [production migration gate](../runbooks/production-operations.md#schema-migration-gate). Retain exact migration/ledger readback, foreign-key/integrity and preservation evidence. The deployment wrapper does not apply migrations. Do not deploy code requiring new columns before their schema is verified.
4. **Deploy the reviewed accountless configuration and privacy copy.** After schema verification, use the immutable production deployment wrapper, with normal preflight and post-deploy checks. The proposed configuration diff below enables the two accountless authority routes. Confirm `enrollment`, `uploadRegistration`, and `processing` collection controls permit the intended operation; do not change unrelated controls or disable existing social publication. Preserve social enrollment and all existing abuse limits, bindings and secrets.
5. **Verify a bounded, explicitly approved production canary.** Use an ordinary signed candidate and a disposable synthetic source. Verify enrollment, accepted encrypted upload, authenticated restart continuity and persistent opt-out; retain separate owner readback for duplicate-count and public-exclusion checks. Confirm the source remains excluded from public aggregates and revoke its authority afterward. The staging rehearsal is compiled to staging: do not repoint it or remove its isolation checks. The exact prepared runner and fixed-artifact dispatch below require this separate live-write approval; owner cleanup remains an explicit follow-on, and no production canary has run.
6. **Publish the release only after its independent gates pass.** Bind the deployed service, privacy wording and expected contribution behavior to the exact release artifacts. The genuine Mac .17→.18 automatic update and normal .18 refresh now pass in the readiness record. Windows signed runtime and protected R7 remain separately tracked; this plan does not close them.

# Proposed configuration diff — not applied

Only add these two properties to `env.production.vars` in `apps/worker/wrangler.jsonc`, after the existing `ENROLLMENT_MODE` property:

```diff
         "ENROLLMENT_MODE": "open",
+        "ACCOUNTLESS_ENROLLMENT_MODE": "enabled",
+        "ACCOUNTLESS_OWNERSHIP_MODE": "enabled",
         "ACCOUNT_SCOPED_INGEST_MODE": "disabled",
```

Both modes are explicit deployment controls; an app preference alone cannot open the server. No new production secret, key rotation, public-selector change or persistent unrelated mode change is proposed. The migration operation separately includes a temporary revision-checked pause and restoration of all four collection controls, as specified above.

For an admission incident, disable the two accountless modes and verify refusal of enrollment/ownership/renewal. That is **not** a claim that already issued upload authority is revoked: use the reviewed targeted revocation or collection-control response for accepted/in-flight authority. Do not roll back the rebuilt schema or deploy incompatible old code as an automatic recovery step. Preserve receipts and reconcile ambiguous remote outcomes before retrying.

# Separate public-sample decision

Recommendation: activate accountless collection with the current public exclusion retained, and describe that exclusion accurately. Public inclusion is not a deployment toggle today. It needs an explicit decision and engineering to adapt the social-only selectors and publication rules.

The proposed label is **contribution sources**, not people or verified provider accounts. One retained installation deduplicates retries; independently created installations can upload overlapping cloud-synced history. A global overlapping-history policy is not implemented. Before public admission, decide how to handle that overlap and source influence, preserve conflicting/partial evidence and existing suppression/revocation, and test the resulting aggregation. Do not silently clip accepted usage totals or merge distinct provider accounts.

# Completion evidence

Retain the exact source/configuration and migration digests, authorized operation identifiers, readbacks, privacy deployment verification and canary receipt. Keep schema, deployment, accepted private collection, public aggregate admission, signing, installed runtime, updater and release publication as separate claims. Only read-only health, migration-ledger, deployment/configuration, secret-name, collection-control and recovery-bookmark observations were performed against production while preparing this proposal; no production state was changed.
