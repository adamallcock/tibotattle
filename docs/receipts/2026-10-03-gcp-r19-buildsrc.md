---
title: GCP round 19 BUILD-SOURCE, the builder's read on the default Cloud Build bucket
date: 2026-10-03
type: receipt
status: snapshot
---

# GCP round 19 BUILD-SOURCE: builder read on the default Cloud Build bucket

This receipt records local, synthetic evidence for branch
`claude/gcp-fp-build-source`, cut from `b8864974`. It covers one macOS arm64
workstation on 2026-10-03, where every gcloud call went to the in-memory fake.
Nothing was pushed or deployed. No gcloud, Wrangler or network call ran. The
only gcloud input was the locally installed SDK's help text and source. It
proves no live staging or production behaviour.

## The finding and the decision

OPS-10's `build` ran `gcloud builds submit <archive> --config=... --project
--region`, and gcloud staged the archive in the project's default bucket
`<project>_cloudbuild`. The builder account (staging:
`tibotattle-staging-builder`; production: `tibotattle-builder`) holds only
`roles/logging.logWriter`, so the live staging build failed with a 403 on
`storage.objects.get`. A temporary grant, since revoked, let it run end to
end.

Owner decision round 19, "Grant on the default bucket" (recorded in the
parity design's `owner-decisions-2026-10-02-answers.md`):

- OPS-2 manages a bucket-level `roles/storage.objectViewer` for the
  environment's builder on `<project>_cloudbuild`;
- the build pins `--gcs-source-staging-dir` to that bucket;
- not the dedicated-bucket design.

A stopped earlier agent had begun the dedicated
`tibotattle-<env>-build-source` design in this worktree. That work is not
committed. `git restore` removed all of it, and this change was rebuilt for
the chosen design. It borrows only the shape of the fake-gcloud create and
bind handlers and the build's bucket precheck.

**Accepted exposure.** In the shared test project `tibotattle`, the bucket
`tibotattle_cloudbuild` also holds the test estate's source archives. The
staging builder's `roles/storage.objectViewer` on it can therefore read
those archives as well. The owner accepted this in round 19. Production's
project is dedicated, so its bucket holds production sources only.

## What changed

- `apps/worker/scripts/gcp-build-source-bucket.mjs` is new: a leaf module
  that OPS-2 and OPS-10 share. It holds the name `<project>_cloudbuild`, the
  `source/` prefix, the reader role, the `BUILD_SOURCE_BUCKET_ABSENT` code
  and the build's policy check.
- Desired state and schema: a closed `buildSource: { bucket }` block. The
  committed files carry `tibotattle_cloudbuild` (staging) and
  `tibotattle-prod_cloudbuild` (production). The validator holds the bucket
  to `<project>_cloudbuild` (`BUILD_SOURCE_BUCKET_NAME_INVALID`). The JSON
  Schema states the form, and its closed-key test covers the block.
  `PROJECT_ROLE_POLICY.builder` is unchanged.
- OPS-2 (`gcp-ops-infra-operations.mjs`, `gcp-infra.mjs`):
  - The bucket is read from the existing listing. When its project number
    matches, its policy's builder, reader-role and public bindings are kept,
    with a `drift` list: `READER_BINDING_MISSING`, `BUILDER_ROLE_BROADER`,
    `READER_BINDING_CONDITIONAL`, `READER_EXTRA_MEMBER`.
  - Findings: `BUILD_SOURCE_BUCKET_ABSENT`, `BUILD_SOURCE_BUCKET_FOREIGN`,
    `BUILD_SOURCE_BUCKET_POLICY_PUBLIC_MEMBER` and
    `BUILD_SOURCE_BUCKET_IAM_DRIFT` (any drift except a missing binding).
  - The plan binds a missing binding. Every other builder, reader-role or
    public binding becomes a refused delete. A public member or a foreign
    bucket also blocks.
  - An absent bucket is created and its binding deferred. The guard admits
    `storage buckets create` and `storage buckets add-iam-policy-binding`
    only in apply, only with the bucket named to it, and only for
    `gs://<project>_cloudbuild`. `assertBucketMutationsScoped` refuses a
    plan that would mutate another bucket.
  - `render` shows the bucket, the source directory, the create argv and the
    reader binding.
- OPS-10 (`gcp-production-rollout.mjs`):
  - The rollout target gains `projectNumber`.
  - `build` adds `--gcs-source-staging-dir=gs://<project>_cloudbuild/source`
    to the submit. The dry run shows it in the argv and in `buildSource`.
  - Before the lock, `build` reads the bucket (`storage buckets describe
    --raw`) and its policy. It refuses with
    `ROLLOUT_BUILD_SOURCE_BUCKET_UNAVAILABLE`, `_FOREIGN` or `_UNQUALIFIED`.
  - The build's storage source must be in that bucket, under `source/`.
- Docs: `cloud-run/infra/README.md` (new BUILD-SOURCE section),
  `docs/runbooks/gcp-staging-apply.md` (steps 1, 7 and 8 and the
  bootstrap-image row of the gated tail), `docs/runbooks/gcp-rollout.md`
  (step 4) and `docs/runbooks/gcp-production-apply.md` (counts, approval 4b,
  pass 1b in step 9, and the bootstrap-image row).

## The absent-bucket choice: OPS-2 creates it

The production project may have no `<project>_cloudbuild` before its first
submit. The plan then reports `BUILD_SOURCE_BUCKET_ABSENT` and creates the
bucket:

```
gcloud storage buckets create gs://<project>_cloudbuild --project=<project> --location=<region> --uniform-bucket-level-access --public-access-prevention
```

It defers the binding with the same code, and the next pass binds. This was
chosen over a documented first-submit sequence for three reasons:

- **gcloud's defaults.** Read from the installed Google Cloud SDK 569.0.0
  `command_lib/builds/submit_util.py` and `api_lib/storage/storage_api.py`:
  - a first submit creates the bucket with no location (Cloud Storage's
    `US`), and with uniform access and public access prevention left at
    their defaults;
  - the build then fails on the missing grant;
  - with an explicit `--gcs-source-staging-dir`, gcloud also drops its check
    that the bucket belongs to the project (`check_ownership` is set only
    for the default bucket).
- **Posture.** Creating the bucket in apply puts it under the plan digest and
  the command guard. Uniform bucket-level access makes bucket IAM the only
  path, so no object ACL can widen the grant. Public access prevention
  rules out a public member. The plane's region keeps the sources beside
  the plane.
- **Deferral.** The deferred binding is applied only after readback has
  listed the bucket in the project and matched its project number.

The `build` precheck restores the owner check that gcloud drops. Production
gains approval 4b (pass 1b, one operation) between the pins and the
bootstrap image.

## Gates

| Command (from `apps/worker` unless noted) | Result |
|---|---|
| `npm run gcp:ops:infra:check` (includes `gcp-ops-infra-staging-service.check.mjs`, `gcp-ops-infra-production.check.mjs`, `gcp-infra.check.mjs`) | 357 tests, 357 pass, 0 fail (354 before the review follow-up) |
| `npm run gcp:production-rollout:check` | 29 tests, 29 pass, 0 fail |
| `node --test scripts/gcp-origin-verifier-smoke.check.mjs` | 10 tests, 10 pass, 0 fail |
| root `npm run test:preflight` (Node 26.2.0) | exit 0; documentation gate 21 pass, 0 fail |
| root `npm run architecture:check` | exit 0; 963 production files, 0 approved debt edges |

No PostgreSQL gate applies: none of these suites opens a database. The
item's private PG17 port 55446 was not needed and no cluster was started.

New coverage:

- the guard's scope (create and bind only on `gs://<project>_cloudbuild`,
  only in apply);
- the absent-bucket deferral and its two passes, both in the module and
  through the CLI (`readback`, `plan`, `apply` and `readback
  --require-clean`);
- each drift case: a missing binding, a broader role, an extra member, a
  conditional binding, a public member and a foreign bucket;
- the build argv, the dry run and the precheck refusals;
- staging and production symmetry: committed buckets, create argv and
  rollout dry runs;
- in `gcp-ops-infra-staging-service.check.mjs`, the pass-1 binding on the
  existing `tibotattle_cloudbuild` in the in-memory rehearsal, which then
  converges through pass 2;
- the production rehearsal's pass 1 create, its deferred binding and the
  pass 2 binding.

## Review follow-up

A review of `a0a9aece` raised five low findings. Each was checked against the
code and an in-memory rehearsal; none was refuted, and each is resolved on
the same branch:

1. **Production counts when the bucket already exists.** The runbook said
   29 executable / 10 deferred. The rehearsal gives 30 / 10, because the
   bind is executable rather than deferred. `gcp-production-apply.md` now says
   so, and in that case pass 1 runs the bind: step 5's `remaining` has 0
   executable, step 9's plan has 0, and pass 1b (approval 4b) is skipped. A
   new production test pins these counts.
2. **`BUILD_SOURCE_BUCKET_FOREIGN` cannot fire live.** Confirmed:
   `storage buckets list --project` names only the project's own buckets, so
   a `<project>_cloudbuild` that another project holds reads back absent. The
   plan then creates it, and the create's 409 stops apply with
   `APPLY_OPERATION_FAILED` before the later pass-1 operations. Option (b) was
   chosen: the check stays as a defensive one, and the README, the operations
   module and the production runbook (step 5) now state the real behaviour:
   stop and escalate to the owner. Option (a), a `describe` after a missing
   listing, was not taken, because the guard deliberately discards gcloud's
   error output. It cannot tell a 404 (truly absent: create) from a 403 (held
   elsewhere), and treating a failed read as absence would turn missing
   evidence into a planned create. A new operations test pins the failed
   create and the replan. OPS-10's `build` precheck remains the check that
   sees such a bucket: `FOREIGN` when it is readable, `UNAVAILABLE` when it
   is not.
3. **Refusal guidance.** `gcp-rollout.md` step 4, the staging gated tail's
   bootstrap-image row and the production bootstrap-image row now split the
   cases. For `UNAVAILABLE`, or `UNQUALIFIED` from a missing binding: apply
   OPS-2 and retry. For `FOREIGN`, or `UNQUALIFIED` from a public member:
   escalate to the owner, since OPS-2 binds nothing on a foreign bucket and
   blocks on a public member.
4. **The live staging path was untested.** A new rehearsal, "the live staging
   path", models it: pass 1 is applied without the bind, and the next plan's
   executables are exactly the one bind (its argv pinned). After that bind
   is applied, pass 2 has no build-source operation and the plane reads
   clean.
5. **Drift scope.** The narrow reading was kept. Drift covers the builder's
   roles and the members of `roles/storage.objectViewer`; another member who
   reads through a different role (for example `legacyObjectReader` or
   `storage.admin`) is not reported. The README states this, and a test pins
   it. Widening `READER_EXTRA_MEMBER` to every role that includes
   `storage.objects.get` is an owner decision. It would have to exempt Cloud
   Storage's project convenience members, and in the shared sandbox it could
   refuse the staging apply over a co-tenant's grant.

## What this does not prove

- That live `gcloud storage buckets list --raw` and `get-iam-policy` output
  parses as the fake does.
- That a live build reads its source under the binding.
- That the production project's bucket name is free. OPS-2 cannot see a
  name another project holds: it shows up only as a failed
  `build-source-bucket:create` at production pass 1 (review follow-up 2).
- That no other principal reads the source archives through a role other
  than `roles/storage.objectViewer` (review follow-up 5).

Each is a live gate: OPS-2 plan and apply, then the bootstrap-image build
for staging and, after owner approval, for production. The staging plane's
pass 1 predates this change, so its next plan holds the one binding. The
staging runbook says to apply it before the bootstrap image.
