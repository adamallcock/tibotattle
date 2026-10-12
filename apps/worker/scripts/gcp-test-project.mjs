/**
 * Identities of the GCP test project's A2 estate (project tibotattle,
 * us-east1) and its shared Cloud Build settings.
 *
 * Owner decision OD-6 (2026-10-02) retired the A2 deployed-test tooling (the
 * private test deploy, the cloud-run-iam host mode, the a2 test-migrations
 * profile and the synthetic v1.2 smoke, cleanup and discovery Jobs). Its
 * cloud resources are not deleted here: that is owner action OA-4, a cloud
 * write that needs its own authorization. Until then these values stay as
 * refusal identities, so production tooling (OPS-2, OPS-10 and the backup
 * horizon) never targets the test service, its databases or its bucket, and
 * the build settings stay shared by the fast-path test deploy's source build
 * (cloud-run-source-build-submit.mjs).
 *
 * The retired test ledger instance, database and schema are listed for the
 * same reason; no tooling here reads or writes them (decisions D2, D4 and D6
 * of 2026-09-26).
 */

export const GCP_PRIVATE_TEST_TARGET = Object.freeze({
  project: "tibotattle",
  projectNumber: "806510610397",
  region: "us-east1",
  service: "tibotattle-test-app",
  hostOrigin: "https://tibotattle-test-app-5t5mehqi7a-ue.a.run.app",
  runtimeServiceAccount: "tibotattle-test-runtime@tibotattle.iam.gserviceaccount.com",
  primaryInstanceConnectionName: "tibotattle:us-east1:tibotattle-test-primary-20260922",
  primaryDatabase: "tibotattle",
  primarySchema: "tibotattle_v12_a2_20260925",
  retiredLedgerInstanceConnectionName: "tibotattle:us-east1:tibotattle-test-ledger-20260922",
  retiredLedgerDatabase: "tibotattle_ledger",
  retiredLedgerSchema: "tibotattle_ledger_v12_a2_20260925",
  postgresIamUser: "tibotattle-test-runtime@tibotattle.iam",
  gcsBucketName: "tibotattle-gcs-test-cleanup-20260925-a2",
  buildBucket: "tibotattle-gcs-test-build-20260922",
  imageRepository:
    "us-east1-docker.pkg.dev/tibotattle/tibotattle-test/tibotattle-host",
});

export const GCP_PRIVATE_TEST_BUILD = Object.freeze({
  serviceAccount:
    "projects/tibotattle/serviceAccounts/tibotattle-test-builder@tibotattle.iam.gserviceaccount.com",
  imageTag: GCP_PRIVATE_TEST_TARGET.imageRepository + ":content-digest-required",
  dockerBuilderImage:
    "gcr.io/cloud-builders/docker@sha256:bbb3d633c5c2813b2ce5245852979e1d637768f4acfc504d8ece288f91e9b60f",
  // Pin only after review; archive creation and provenance qualification check
  // this digest against the exact cloudbuild.yaml tar member.
  cloudBuildConfigSha256: "a6dd372a20429ab6b3e9b11b738514d201c6b5b0ca8e395e6c69bb0b166dbc12",
  sourceObjectPrefix: "source/cloud-run-host-",
});
