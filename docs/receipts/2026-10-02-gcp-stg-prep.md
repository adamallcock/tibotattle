---
title: GCP STG-PREP staging plane preparation
date: 2026-10-02
type: receipt
status: snapshot
---

# GCP STG-PREP staging plane preparation

This is a 2026-10-02 receipt for stream STG-PREP on branch
`claude/gcp-fp-stg-prep`, built on `9700d167` (`claude/gcp-fastpath-final`).
It covers `76cd4a2c` (the implementation, its checks and the runbook) and
the commit that adds this receipt.

It records **local, synthetic** evidence only: one macOS arm64 workstation,
Node 26.2.0, and the local PostgreSQL 17 fan-out cluster (port 55433) for
the OPS-10 migration specs. No gcloud or wrangler command ran, and nothing
read or wrote a GCP or Cloudflare resource. Every staging check blanks
`PATH`, so a real gcloud cannot start, and drives an in-memory gcloud. Every
value used is synthetic; the committed staging file names only non-secret
identifiers of the GCP test project that the test estate already tracks,
plus the staging edge's planned hostname. This receipt is not evidence that
the tooling works against the live project: the main session's first run of
[the staging apply runbook](../runbooks/gcp-staging-apply.md) is that
qualification.

## What changed

| Item | Implementation |
|---|---|
| (1) Staging service template | `apps/worker/cloud-run/staging-service.template.yaml`: EP-7's IAM-private Knative service with `HOST_MODE=staging` (OD-CR-8), `minScale 0`, `maxScale` from `service.maxInstances` (budget-checked), production's concurrency and timeout, the staging edge's `PUBLIC_ORIGIN` and derived `ADMIN_HOST_ORIGIN`, the Access settings, `STAGING_ADMISSION_MODE`, inert synthetic Google and Apple identifiers, and the OD-2 proof `GCS_QUARANTINE_BUCKET_HISTORY_PROOF` rendered from the pinned `bucket.proof` with the same placeholders and shape as C-SIMP's EP-7 change |
| Manifest | `gcp-ops-infra-manifest.mjs`: one new section ("STG-PREP: the staging service") plus small hooks. `SERVICE_TEMPLATE_UNAVAILABLE` is now empty and `SERVICE_TEMPLATE_FILES` names each plane's template. A new closed desired-state block `stagingOrigin` (`publicOrigin`, `accessTeamDomain`, `accessAud`, `accessAdminEmail`, `identityLinkSecretVersion`, `admissionMode`) is `null` in production (`STAGING_ORIGIN_FORBIDDEN:production`) and validated against CR-3's grammar and the production fingerprint in staging. `serviceTemplateBlocker` (render-ability: `STAGING_ORIGIN_UNASSIGNED[:stagingOrigin.accessAud]`, `SERVICE_RENDER_BUCKET_PROOF_UNPINNED`) is split from `serviceRenderBlocker` (what OPS-2 defers), which adds `SERVICE_COMPOSITION_PENDING.staging = STAGING_HOST_COMPOSITION_PENDING`: the server reads no `HOST_MODE` until D-CRB, so apply never creates a staging revision that cannot start. Each plane renders only from its own template (`assertPlaneServiceInvariants`) |
| Committed desired states | Staging gains `stagingOrigin` (`https://staging.tibotattle.com`, the staging edge plan's D-S1 proposal; `accessAud` `null` until the owner creates the staging admin Access application; the owner's admin email as production; `staging-gcp-v1`; `closed`) and its own synthetic `telemetryStorageNamespace` `tibotattle-staging-synthetic`. Production and the synthetic fixture gain `"stagingOrigin": null`. The JSON Schema and the infra README follow |
| (2) Secrets provisioner | `apps/worker/scripts/gcp-staging-secrets.mjs` (the brief's `scripts/gcp-staging-secrets.mjs`, placed beside the other OPS-2 scripts it reuses). Staging ids only (`STAGING_SECRET_ID`, and no production, test, rehearsal or synthetic token). Values: 48 random bytes for the identity-link and rate-limit secrets; one fresh RSA-2048 envelope pair with key id `key:staging-<uuid>`; inert `staging-inert-` tokens for the Google client secret and the GitHub token; an inert fresh P-256 PKCS#8 key for Apple. Each value goes to `gcloud secrets versions add <id> --data-file=-` on stdin; the guard refuses any other shape, any value in argv and any stdin elsewhere, and gcloud's stderr is discarded. Dry run by default with a generation self-test; `--apply` needs `staging-secrets:<project>:<id-map digest>`; missing containers are created exactly as OPS-2 apply would; a rerun skips secrets with an ENABLED version; `--write-pins` pins the versions; `--report-out` writes the content-free report owner-only |
| (3) Bucket-birth flow | `apps/worker/scripts/gcp-staging-bucket-birth.mjs`: the reviewed OPS-2 `runBucketBirth` with the receipt reserved at `apps/worker/cloud-run/infra/staging.bucket-birth.receipt.json`, then `verifyStagingBucketBirthReceipt` (schema, project, number, bucket, request and response digests, posture, first metageneration) and the proof pinned. `--pin-only` finishes a run whose pin failed; `--verify` checks the committed pair. `gcp-staging-desired-state.mjs` makes every pin an exact one-line edit, proves the result validates and differs only by the pins, refuses to move an existing pin, and writes by rename |
| (4) Runbook | `docs/runbooks/gcp-staging-apply.md` (status draft): plan, secrets, pin review, bucket birth, commit, apply pass 1 and readback, with expected outputs and stop conditions, then the gated tail |
| Tests | New `gcp-ops-infra-staging-service.check.mjs` (11), `gcp-staging-secrets.check.mjs` (11) and `gcp-staging-bucket-birth.check.mjs` (10), registered in `gcp:ops:infra:check`. Existing OPS-2 assertions that named `STAGING_SERVICE_TEMPLATE_UNAVAILABLE` now name the new deferral, and the committed-staging checks accept the file both before and after the main session's pins (fixture `staging-unpinned.mjs`) |

## Evidence

| Command (worktree `fp/STG-PREP`) | Result |
|---|---|
| `npm --prefix apps/worker run gcp:production-tooling:local-check` with `PG_TEST_SOCKET` and port 55433 | Exit 0. Migrations 33 and 5, rollout 19, infra 227 (`gcp:ops:infra:check`; 195 before this stream), cutover seal 32; all pass, none skipped |
| The same infra gate after simulating the main session's pins (seven versions `"1"`, a synthetic receipt at the committed path and its proof pinned by the pin tool), then restoring both files | 227 of 227 pass (the receipt check takes its "verified" branch instead of "both absent"), so the main session's pin commit keeps the gate green |
| `npm run test:preflight`, `npm run architecture:check` (root) | Exit 0 and exit 0 (928 production files, 0 debt edges) |
| `node scripts/gcp-staging-secrets.mjs --environment=staging --dry-run` | Exit 0, no call. `authorization` `staging-secrets:tibotattle:adf926e2663c3a85`; `generationSelfTest` 7 made, 7 checked, 0 kept; seven `tibotattle-staging-*` ids with their kinds and the exact `create` and `versions add --data-file=-` argv; no value in the output |
| `node scripts/gcp-staging-bucket-birth.mjs --environment=staging` | Exit 0, no call. `authorization` `bucket-birth:tibotattle:tibotattle-staging-quarantine`; the insert body (`US-EAST1`, `STANDARD`, uniform access, public access prevention enforced, soft delete `"0"`, versioning off); the receipt path; `proofPinned` false. `--environment=production` exits 1 with `STAGING_BUCKET_BIRTH_ENVIRONMENT_REFUSED`; `--verify` exits 1 with `STAGING_BUCKET_BIRTH_RECEIPT_MISSING` |
| `node scripts/gcp-infra.mjs render --environment=staging` with a synthetic bootstrap image | Exit 0, no call. Service `STAGING_ORIGIN_UNASSIGNED:stagingOrigin.accessAud`; verifier grant `VERIFIER_TOKEN_CREATOR_UNASSIGNED`; trigger `SCHEDULER_CADENCE_UNSET`; both jobs render; connection budget 82 of 100; desired-state digest `8ac07b20...f454` |
| In-memory apply rehearsal (last test of the staging service check) with the AUD, versions and proof filled synthetically | Pass 1: 26 executable, 8 deferred, no finding, no blocker, nothing refused; pass 2 with a bootstrap image creates both jobs and the scheduler's executor binding; the readback after it is unclean only for the verifier grant and the service (`STAGING_HOST_COMPOSITION_PENDING`) with its two invoker bindings; the `tibotattle-test-app` co-tenant is untouched |
| Rendered staging env plus provisioner-made values through CR-3 `readProductionConfiguration(env, "staging")` | Accepted: staging plane, closed admission, origin-tier limits 300 and 6, no external participants; `synthetic-rehearsal` opens accountless admission only; the same env is refused as production |

## Gates this does not clear

- **D-CRB.** The staging service is rendered and tested but OPS-2 defers it
  (`STAGING_HOST_COMPOSITION_PENDING`). D-CRB's merge must delete the
  staging entry of `SERVICE_COMPOSITION_PENDING`; the staging check
  asserts `server.mjs` reads no `HOST_MODE`, so that merge cannot miss it.
  Production has no such gate here (it waits for OWN-5); D-CRB should decide
  whether production needs one too.
- **Owner values.** `stagingOrigin.accessAud` (the staging admin Access
  application, staging edge plan phase C) and the verifier's
  `tokenCreators` (the operator; OPS-10 refuses every staging verb without
  it). The public origin follows the staging edge plan's D-S1 proposal.
- **The lock push.** OPS-10 `build`, `migrate` and `roll` take the shared
  production coordination lock by pushing
  `refs/heads/codex/production-deployment-lock` to GitHub. The staging
  bootstrap image needs `build`, so it needs explicit owner authorization
  for that push.
- **The shared project.** The custom role id `tibotattleQuarantineStore` is
  project-wide, not staging-named; the runbook stops unless the plan shows a
  plain create. OPS-10's quiescence check counts every job trigger in
  `us-east1`, so a running test-estate trigger refuses a staging migrate.
- **Roll.** No repository command writes the `tibotattle-edge-live-capture-v1`
  file roll requires, and the tracked `env.staging` Worker is the old
  workers.dev one, not the planned staging edge.
- **C-SIMP.** Until it merges, CR-3 ignores the OD-2 proof; after it, CR-3
  requires it, and the staging template already carries it. C-SIMP's
  `serviceTemplateValues` and invariant changes overlap this stream's hooks
  in the same functions (an additive merge: both supply the same
  `GCS_BUCKET_GENERATION` values).
- **D-OPS4.** This stream's manifest code is one separate section; its
  desired-state edits are the new last key `stagingOrigin` and the staging
  namespace.

## Review findings

None yet: no review pass ran on this stream.
