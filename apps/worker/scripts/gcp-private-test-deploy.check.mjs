import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  buildGcpTestBucketCreateRequest,
  GCP_TEST_BUCKET_HISTORY_RECEIPT_SCHEMA,
  GCP_TEST_BUCKET_HISTORY_TARGET,
} from "./gcp-test-bucket-history.mjs";
import {
  GCP_PRIVATE_TEST_BUILD,
  GCP_PRIVATE_TEST_TARGET,
  assessCloudBuildProvenance,
  assessCloudRunReadback,
  assessLocalCloudBuildSourceArchive,
  cloudRunHostModeReady,
  runGcpPrivateTestDeployment,
  runSyntheticRouteBoundarySmoke,
  runUnauthenticatedInvokerProbe,
  parseArgs,
  readGcpPrivateTestBucketHistoryProof,
  validateConfig,
} from "./gcp-private-test-deploy.mjs";

const sourceDigest = "a".repeat(64);
const imageDigest = "b".repeat(64);
const archiveSha256 = "c".repeat(64);
const image = GCP_PRIVATE_TEST_TARGET.imageRepository + "@sha256:" + imageDigest;
const sourceGeneration = "1733521432198765";
const sourceObject = GCP_PRIVATE_TEST_BUILD.sourceObjectPrefix
  + sourceDigest + "-" + archiveSha256 + ".tar.gz";
const backingTargetEnvironment = {
  PRIMARY_INSTANCE_CONNECTION_NAME: GCP_PRIVATE_TEST_TARGET.primaryInstanceConnectionName,
  PRIMARY_DATABASE: GCP_PRIVATE_TEST_TARGET.primaryDatabase,
  PRIMARY_SCHEMA: GCP_PRIVATE_TEST_TARGET.primarySchema,
  LEDGER_INSTANCE_CONNECTION_NAME: GCP_PRIVATE_TEST_TARGET.ledgerInstanceConnectionName,
  LEDGER_DATABASE: GCP_PRIVATE_TEST_TARGET.ledgerDatabase,
  LEDGER_SCHEMA: GCP_PRIVATE_TEST_TARGET.ledgerSchema,
  POSTGRES_IAM_USER: GCP_PRIVATE_TEST_TARGET.postgresIamUser,
  GCS_BUCKET_NAME: GCP_PRIVATE_TEST_TARGET.gcsBucketName,
};
const bucketCreationResponse = {
  bucket: GCP_PRIVATE_TEST_TARGET.gcsBucketName,
  projectNumber: GCP_TEST_BUCKET_HISTORY_TARGET.projectNumber,
  bucketGeneration: "1",
  bucketMetageneration: "1",
  location: GCP_TEST_BUCKET_HISTORY_TARGET.location,
  timeCreated: "2026-09-25T00:00:00.000Z",
  softDeleteRetentionDurationSeconds: "0",
  iamConfiguration: {
    uniformBucketLevelAccess: true,
    publicAccessPrevention: "enforced",
  },
  versioningEnabled: false,
};
const bucketHistoryProof = {
  bucket: bucketCreationResponse.bucket,
  bucketGeneration: bucketCreationResponse.bucketGeneration,
  bucketMetageneration: bucketCreationResponse.bucketMetageneration,
  softDeleteRetentionDurationSeconds: bucketCreationResponse.softDeleteRetentionDurationSeconds,
};
const bucketHistoryReceipt = {
  schemaVersion: GCP_TEST_BUCKET_HISTORY_RECEIPT_SCHEMA,
  source: "storage.buckets.insert",
  project: GCP_TEST_BUCKET_HISTORY_TARGET.project,
  projectNumber: GCP_TEST_BUCKET_HISTORY_TARGET.projectNumber,
  creationRequestSha256: createHash("sha256")
    .update(JSON.stringify(buildGcpTestBucketCreateRequest(GCP_PRIVATE_TEST_TARGET.gcsBucketName)))
    .digest("hex"),
  creationResponse: bucketCreationResponse,
  creationResponseSha256: createHash("sha256")
    .update(JSON.stringify(bucketCreationResponse)).digest("hex"),
  proof: bucketHistoryProof,
};
const bucketHistoryProofJson = JSON.stringify(bucketHistoryProof);
const previousBucketHistoryProofJson = JSON.stringify({
  bucket: "tibotattle-gcs-test-app-20260922",
  bucketGeneration: "1",
  bucketMetageneration: "1",
  softDeleteRetentionDurationSeconds: "0",
});
const bucketHistoryTestDirectory = await mkdtemp(join(tmpdir(), "private-test-bucket-proof-"));
const bucketHistoryReceiptPath = join(bucketHistoryTestDirectory, "receipt.json");
await writeFile(bucketHistoryReceiptPath, `${JSON.stringify(bucketHistoryReceipt, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
after(async () => rm(bucketHistoryTestDirectory, { recursive: true, force: true }));

function serviceFixture({
  serviceImage = image,
  ingress = "all",
  source = sourceDigest,
  ready = "True",
  invokerIamDisabled = false,
  invokerIamDisabledAnnotation = "false",
  traffic = [{ revisionName: "tibotattle-test-app-00042-abc", percent: 100 }],
  latestReadyRevisionName = "tibotattle-test-app-00042-abc",
  latestCreatedRevisionName = "tibotattle-test-app-00042-abc",
  generation = 42,
  observedGeneration = 42,
  postgresTestMode = "cloud-run-iam",
  serviceAccount = GCP_PRIVATE_TEST_TARGET.runtimeServiceAccount,
  environmentOverrides = {},
  environmentOmissions = [],
  additionalEnvironment = [],
} = {}) {
  const environment = {
    SOURCE_CONTENT_DIGEST: source,
    HOST: "0.0.0.0",
    HOST_ORIGIN: GCP_PRIVATE_TEST_TARGET.hostOrigin,
    POSTGRES_TEST_HTTP_MODE: postgresTestMode,
    GCS_ERASURE_BUCKET_HISTORY_PROOF: bucketHistoryProofJson,
    ...backingTargetEnvironment,
    ...environmentOverrides,
  };
  return {
    metadata: {
      name: GCP_PRIVATE_TEST_TARGET.service,
      generation,
      annotations: {
        "run.googleapis.com/ingress": ingress,
        "run.googleapis.com/invoker-iam-disabled": invokerIamDisabledAnnotation,
      },
    },
    invokerIamDisabled,
    spec: {
      template: {
        spec: {
          serviceAccountName: serviceAccount,
          containers: [{
            image: serviceImage,
            env: [
              ...Object.entries(environment)
                .filter(([name]) => !environmentOmissions.includes(name))
                .map(([name, value]) => ({ name, value })),
              ...additionalEnvironment,
            ],
          }],
        },
      },
    },
    status: {
      url: GCP_PRIVATE_TEST_TARGET.hostOrigin,
      latestReadyRevisionName,
      latestCreatedRevisionName,
      observedGeneration,
      traffic,
      conditions: [{ type: "Ready", status: ready }],
    },
  };
}

function serviceWithoutLatestReadyRevision() {
  const service = serviceFixture();
  delete service.status.latestReadyRevisionName;
  return service;
}

function policyFixture(members = ["user:test@example.invalid"]) {
  return { bindings: [{ role: "roles/run.invoker", members }] };
}

function config(overrides = {}) {
  return {
    command: "deploy",
    project: "tibotattle",
    region: "us-east1",
    service: "tibotattle-test-app",
    image,
    sourceDigest,
    bucketHistoryReceiptPath,
    buildId: "12345678-abcd-efab-1234-1234567890ab",
    ...overrides,
  };
}

function qualifiedConfig(overrides = {}) {
  return config({
    sourceArchivePath: "/private/tmp/source.tar.gz",
    sourceArchiveSha256: archiveSha256,
    sourceBucket: GCP_PRIVATE_TEST_TARGET.buildBucket,
    sourceObject,
    sourceGeneration,
    ...overrides,
  });
}

function buildFixture(overrides = {}, configValue = qualifiedConfig()) {
  const builderDigest = GCP_PRIVATE_TEST_BUILD.dockerBuilderImage
    .slice("gcr.io/cloud-builders/docker@".length);
  const sourceUri = `gs://${configValue.sourceBucket}/${configValue.sourceObject}#${sourceGeneration}`;
  return {
    id: configValue.buildId,
    name: `projects/${configValue.project}/locations/${configValue.region}/builds/${configValue.buildId}`,
    projectId: configValue.project,
    status: "SUCCESS",
    serviceAccount: GCP_PRIVATE_TEST_BUILD.serviceAccount,
    source: { storageSource: {
      bucket: configValue.sourceBucket,
      object: configValue.sourceObject,
      generation: sourceGeneration,
    } },
    sourceProvenance: {
      resolvedStorageSource: {
        bucket: configValue.sourceBucket,
        object: configValue.sourceObject,
        generation: sourceGeneration,
      },
      fileHashes: { [sourceUri]: { fileHash: [
        { type: "MD5", value: Buffer.alloc(16, 0x5a).toString("base64url") },
        {
          type: "SHA256",
          value: Buffer.from(configValue.sourceArchiveSha256, "hex").toString("base64url"),
        },
      ] } },
    },
    options: {
      logging: "CLOUD_LOGGING_ONLY",
      sourceProvenanceHash: ["SHA256"],
      requestedVerifyOption: "VERIFIED",
      pool: {},
    },
    steps: [{
      name: GCP_PRIVATE_TEST_BUILD.dockerBuilderImage,
      args: [
        "build",
        "--file=apps/worker/cloud-run/Dockerfile",
        "--tag=" + GCP_PRIVATE_TEST_BUILD.imageTag,
        ".",
      ],
      status: "SUCCESS",
    }],
    timeout: "1200s",
    queueTtl: "3600s",
    artifacts: { images: [GCP_PRIVATE_TEST_BUILD.imageTag] },
    substitutions: { _IMAGE: GCP_PRIVATE_TEST_BUILD.imageTag },
    images: [GCP_PRIVATE_TEST_BUILD.imageTag],
    results: {
      buildStepImages: [builderDigest],
      buildStepOutputs: [""],
      images: [{
        name: GCP_PRIVATE_TEST_BUILD.imageTag,
        digest: `sha256:${imageDigest}`,
      }],
    },
    ...overrides,
  };
}

test("target is fixed to the named us-east1 test service and exact Artifact Registry digest", () => {
  assert.equal(GCP_PRIVATE_TEST_TARGET.primarySchema, "tibotattle_v12_a2_20260925");
  assert.equal(GCP_PRIVATE_TEST_TARGET.ledgerSchema, "tibotattle_ledger_v12_a2_20260925");
  assert.equal(GCP_PRIVATE_TEST_TARGET.gcsBucketName, "tibotattle-gcs-test-cleanup-20260925-a2");
  assert.equal(GCP_PRIVATE_TEST_TARGET.primaryInstanceConnectionName,
    "tibotattle:us-east1:tibotattle-test-primary-20260922");
  assert.equal(GCP_PRIVATE_TEST_TARGET.ledgerInstanceConnectionName,
    "tibotattle:us-east1:tibotattle-test-ledger-20260922");
  assert.throws(
    () => validateConfig(config({ project: "production-project" })),
    (error) => error.code === "GCP_PRIVATE_TEST_TARGET_FIXED",
  );
  assert.throws(
    () => validateConfig(config({ region: "us-central1" })),
    (error) => error.code === "GCP_PRIVATE_TEST_TARGET_FIXED",
  );
  assert.throws(
    () => validateConfig(config({ image: GCP_PRIVATE_TEST_TARGET.imageRepository + ":latest" })),
    (error) => error.code === "GCP_PRIVATE_TEST_IMAGE_DIGEST_REQUIRED",
  );
  assert.throws(
    () => validateConfig(config({ image: "other.invalid/repo@sha256:" + imageDigest })),
    (error) => error.code === "GCP_PRIVATE_TEST_IMAGE_DIGEST_REQUIRED",
  );
  assert.throws(
    () => validateConfig(config({ command: "deploy", bucketHistoryReceiptPath: "relative.json" })),
    (error) => error.code === "GCP_PRIVATE_TEST_BUCKET_HISTORY_RECEIPT_REQUIRED",
  );
  assert.throws(
    () => validateConfig(config({ command: "verify", bucketHistoryReceiptPath: "" })),
    (error) => error.code === "GCP_PRIVATE_TEST_BUCKET_HISTORY_RECEIPT_REQUIRED",
  );
  assert.equal(parseArgs([
    "deploy",
    "--image=" + image,
    "--source-digest=" + sourceDigest,
    "--bucket-history-receipt=" + bucketHistoryReceiptPath,
  ]).bucketHistoryReceiptPath, bucketHistoryReceiptPath);
  assert.throws(() => parseArgs([
    "deploy",
    "--image=" + image,
    "--source-digest=" + sourceDigest,
  ]), (error) => error.code === "GCP_PRIVATE_TEST_BUCKET_HISTORY_RECEIPT_REQUIRED");
});

test("bucket birth receipt must be the owner-only, canonical proof for the exact A2 bucket", async () => {
  assert.equal(await readGcpPrivateTestBucketHistoryProof(bucketHistoryReceiptPath), bucketHistoryProofJson);
  const stat = await lstat(bucketHistoryReceiptPath);
  assert.equal(stat.mode & 0o777, 0o600);

  const scratch = await mkdtemp(join(tmpdir(), "private-test-bucket-proof-reject-"));
  const insecurePath = join(scratch, "insecure.json");
  const symlinkPath = join(scratch, "receipt-link.json");
  const wrongBucketPath = join(scratch, "wrong-bucket.json");
  try {
    await writeFile(insecurePath, `${JSON.stringify(bucketHistoryReceipt, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await chmod(insecurePath, 0o644);
    await symlink(bucketHistoryReceiptPath, symlinkPath);
    const wrongBucket = structuredClone(bucketHistoryReceipt);
    wrongBucket.creationResponse.bucket = "tibotattle-gcs-test-app-20260922";
    wrongBucket.creationResponseSha256 = createHash("sha256")
      .update(JSON.stringify(wrongBucket.creationResponse)).digest("hex");
    wrongBucket.proof.bucket = wrongBucket.creationResponse.bucket;
    await writeFile(wrongBucketPath, `${JSON.stringify(wrongBucket, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await assert.rejects(
      readGcpPrivateTestBucketHistoryProof(insecurePath),
      (error) => error?.code === "GCP_PRIVATE_TEST_BUCKET_HISTORY_RECEIPT_UNSAFE",
    );
    await assert.rejects(
      readGcpPrivateTestBucketHistoryProof(symlinkPath),
      (error) => error?.code === "GCP_PRIVATE_TEST_BUCKET_HISTORY_RECEIPT_UNSAFE",
    );
    await assert.rejects(
      readGcpPrivateTestBucketHistoryProof(wrongBucketPath),
      (error) => error?.code === "GCP_PRIVATE_TEST_BUCKET_HISTORY_RECEIPT_INVALID",
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("Cloud Build provenance binds the exact archive generation, hash, builder, service account, and image", () => {
  const configValue = qualifiedConfig();
  assert.deepEqual(assessCloudBuildProvenance({
    build: buildFixture(),
    config: configValue,
  }), {
    ok: true,
    blockers: [],
    sourceGeneration,
    image,
  });
  const projectNumberResourceName = buildFixture();
  projectNumberResourceName.name =
    `projects/${GCP_PRIVATE_TEST_TARGET.projectNumber}/locations/${configValue.region}/builds/${configValue.buildId}`;
  assert.equal(assessCloudBuildProvenance({
    build: projectNumberResourceName,
    config: configValue,
  }).ok, true);
  const otherWellFormedHash = buildFixture();
  otherWellFormedHash.sourceProvenance.fileHashes[
    `gs://${configValue.sourceBucket}/${configValue.sourceObject}#${sourceGeneration}`
  ].fileHash.push({ type: "SHA512", value: Buffer.alloc(64, 0x31).toString("base64") });
  assert.equal(assessCloudBuildProvenance({
    build: otherWellFormedHash,
    config: configValue,
  }).ok, true);
  const paddedBase64UrlHash = buildFixture();
  paddedBase64UrlHash.sourceProvenance.fileHashes[
    `gs://${configValue.sourceBucket}/${configValue.sourceObject}#${sourceGeneration}`
  ].fileHash[0].value = "K7dzdTVo3M81vTHfY2_M_A==";
  assert.equal(assessCloudBuildProvenance({
    build: paddedBase64UrlHash,
    config: configValue,
  }).ok, true);
  const paddedSha256 = "d6561f0f879677e24fb8f1c0d9524f055372165598f2f66ac857a845aab070a4";
  const paddedSha256Config = qualifiedConfig({
    sourceArchiveSha256: paddedSha256,
    sourceObject: GCP_PRIVATE_TEST_BUILD.sourceObjectPrefix
      + sourceDigest + "-" + paddedSha256 + ".tar.gz",
  });
  const paddedSha256Build = buildFixture({}, paddedSha256Config);
  const paddedSha256SourceUri = `gs://${paddedSha256Config.sourceBucket}/${paddedSha256Config.sourceObject}#${sourceGeneration}`;
  paddedSha256Build.sourceProvenance.fileHashes[paddedSha256SourceUri]
    .fileHash[1].value = Buffer.from(paddedSha256, "hex").toString("base64")
      .replaceAll("+", "-").replaceAll("/", "_");
  assert.equal(assessCloudBuildProvenance({
    build: paddedSha256Build,
    config: paddedSha256Config,
  }).ok, true);
  const successfulStepWithoutExplicitZero = buildFixture();
  delete successfulStepWithoutExplicitZero.steps[0].exitCode;
  assert.equal(assessCloudBuildProvenance({
    build: successfulStepWithoutExplicitZero,
    config: configValue,
  }).ok, true);

  const alteredHash = buildFixture();
  alteredHash.sourceProvenance.fileHashes[
    `gs://${configValue.sourceBucket}/${configValue.sourceObject}#${sourceGeneration}`
  ].fileHash[1].value = Buffer.from("d".repeat(32), "hex").toString("base64");
  const wrongStep = buildFixture();
  wrongStep.steps[0].name = "gcr.io/cloud-builders/docker";
  const failedStep = buildFixture();
  failedStep.steps[0].exitCode = 1;
  const addedStepEnvironment = buildFixture();
  addedStepEnvironment.steps[0].env = ["EXTRA=unsafe"];
  const addedStepEntrypoint = buildFixture();
  addedStepEntrypoint.steps[0].entrypoint = "sh";
  const addedStepWorkingDirectory = buildFixture();
  addedStepWorkingDirectory.steps[0].dir = "/tmp";
  const changedBuildTimeout = buildFixture();
  changedBuildTimeout.timeout = "300s";
  const changedArtifact = buildFixture();
  changedArtifact.artifacts.images[0] = GCP_PRIVATE_TEST_BUILD.imageTag + "-other";
  const changedPool = buildFixture();
  changedPool.options.pool = { workerPool: "projects/other/locations/us-east1/workerPools/custom" };
  const addedBuildOption = buildFixture();
  addedBuildOption.options.machineType = "E2_HIGHCPU_8";
  const changedSubstitution = buildFixture();
  changedSubstitution.substitutions._IMAGE = GCP_PRIVATE_TEST_BUILD.imageTag + "-other";
  const addedSubstitution = buildFixture();
  addedSubstitution.substitutions._EXTRA = "unexpected";
  const addedSecrets = buildFixture();
  addedSecrets.availableSecrets = { secretManager: [{ versionName: "projects/x/secrets/y/versions/1" }] };
  const extraBuildResult = buildFixture();
  extraBuildResult.results.artifactManifest = "gs://unexpected/manifest.json";
  const nonemptyBuildStepOutput = buildFixture();
  nonemptyBuildStepOutput.results.buildStepOutputs = ["cGF5bG9hZA=="];
  const wrongServiceAccount = buildFixture({ serviceAccount: "projects/tibotattle/serviceAccounts/other@tibotattle.iam.gserviceaccount.com" });
  const failedBuild = buildFixture({ status: "FAILURE" });
  const wrongImage = buildFixture();
  wrongImage.results.images[0].digest = "sha256:" + "d".repeat(64);
  const missingGeneration = buildFixture();
  delete missingGeneration.sourceProvenance.resolvedStorageSource.generation;
  const missingInputGeneration = buildFixture();
  delete missingInputGeneration.source.storageSource.generation;
  const wrongInputGeneration = buildFixture();
  wrongInputGeneration.source.storageSource.generation = "1";
  const wrongGeneration = buildFixture();
  wrongGeneration.sourceProvenance.resolvedStorageSource.generation = "1";
  const wrongProjectResourceName = buildFixture();
  wrongProjectResourceName.name =
    `projects/999999999999/locations/${configValue.region}/builds/${configValue.buildId}`;
  const wrongProjectId = buildFixture({ projectId: "other-project" });
  const missingHash = buildFixture();
  missingHash.sourceProvenance.fileHashes = {};
  const duplicateSha256 = buildFixture();
  duplicateSha256.sourceProvenance.fileHashes[
    `gs://${configValue.sourceBucket}/${configValue.sourceObject}#${sourceGeneration}`
  ].fileHash.push({ ...duplicateSha256.sourceProvenance.fileHashes[
    `gs://${configValue.sourceBucket}/${configValue.sourceObject}#${sourceGeneration}`
  ].fileHash[1] });
  const malformedSupplementalHash = buildFixture();
  malformedSupplementalHash.sourceProvenance.fileHashes[
    `gs://${configValue.sourceBucket}/${configValue.sourceObject}#${sourceGeneration}`
  ].fileHash[0].value = "not-base64";
  const malformedPaddedBase64UrlHash = buildFixture();
  malformedPaddedBase64UrlHash.sourceProvenance.fileHashes[
    `gs://${configValue.sourceBucket}/${configValue.sourceObject}#${sourceGeneration}`
  ].fileHash[0].value = "K7dzdTVo3M81vTHfY2_M_A=";
  const mixedAlphabetPaddedBase64UrlHash = buildFixture();
  mixedAlphabetPaddedBase64UrlHash.sourceProvenance.fileHashes[
    `gs://${configValue.sourceBucket}/${configValue.sourceObject}#${sourceGeneration}`
  ].fileHash[0].value = "K7dz+dTVo3M81vTHfY2_M_A==";
  const excessPaddingBase64UrlHash = buildFixture();
  excessPaddingBase64UrlHash.sourceProvenance.fileHashes[
    `gs://${configValue.sourceBucket}/${configValue.sourceObject}#${sourceGeneration}`
  ].fileHash[0].value = "K7dzdTVo3M81vTHfY2_M_A===";
  const extraSupplementalHashField = buildFixture();
  extraSupplementalHashField.sourceProvenance.fileHashes[
    `gs://${configValue.sourceBucket}/${configValue.sourceObject}#${sourceGeneration}`
  ].fileHash[0].unexpected = true;
  const conflictingSupplementalHash = buildFixture();
  conflictingSupplementalHash.sourceProvenance.fileHashes[
    `gs://${configValue.sourceBucket}/${configValue.sourceObject}#${sourceGeneration}`
  ].fileHash.push({ type: "MD5", value: Buffer.alloc(16, 0x6b).toString("base64") });
  const missingOptions = buildFixture();
  delete missingOptions.options.sourceProvenanceHash;
  const alteredVerifyOption = buildFixture();
  alteredVerifyOption.options.requestedVerifyOption = "NOT_VERIFIED";

  for (const [build, blocker] of [
    [alteredHash, "GCP_BUILD_SOURCE_ARCHIVE_SHA256_MISMATCH"],
    [wrongStep, "GCP_BUILD_STEP_UNEXPECTED"],
    [failedStep, "GCP_BUILD_STEP_UNEXPECTED"],
    [addedStepEnvironment, "GCP_BUILD_CONFIGURATION_UNEXPECTED"],
    [addedStepEntrypoint, "GCP_BUILD_CONFIGURATION_UNEXPECTED"],
    [addedStepWorkingDirectory, "GCP_BUILD_CONFIGURATION_UNEXPECTED"],
    [changedBuildTimeout, "GCP_BUILD_CONFIGURATION_UNEXPECTED"],
    [changedArtifact, "GCP_BUILD_CONFIGURATION_UNEXPECTED"],
    [changedPool, "GCP_BUILD_CONFIGURATION_UNEXPECTED"],
    [addedBuildOption, "GCP_BUILD_CONFIGURATION_UNEXPECTED"],
    [changedSubstitution, "GCP_BUILD_CONFIGURATION_UNEXPECTED"],
    [addedSubstitution, "GCP_BUILD_CONFIGURATION_UNEXPECTED"],
    [addedSecrets, "GCP_BUILD_CONFIGURATION_UNEXPECTED"],
    [extraBuildResult, "GCP_BUILD_SOURCE_ARCHIVE_SHA256_MISMATCH"],
    [nonemptyBuildStepOutput, "GCP_BUILD_SOURCE_ARCHIVE_SHA256_MISMATCH"],
    [wrongServiceAccount, "GCP_BUILD_SERVICE_ACCOUNT_UNEXPECTED"],
    [failedBuild, "GCP_BUILD_NOT_SUCCESSFUL"],
    [wrongImage, "GCP_BUILD_IMAGE_DIGEST_MISMATCH"],
    [missingGeneration, "GCP_BUILD_SOURCE_GENERATION_MISMATCH"],
    [wrongGeneration, "GCP_BUILD_SOURCE_GENERATION_MISMATCH"],
    [missingInputGeneration, "GCP_BUILD_SOURCE_OBJECT_MISMATCH"],
    [wrongInputGeneration, "GCP_BUILD_SOURCE_OBJECT_MISMATCH"],
    [wrongProjectResourceName, "GCP_BUILD_IDENTITY_MISMATCH"],
    [wrongProjectId, "GCP_BUILD_IDENTITY_MISMATCH"],
    [missingHash, "GCP_BUILD_SOURCE_ARCHIVE_SHA256_MISMATCH"],
    [duplicateSha256, "GCP_BUILD_SOURCE_ARCHIVE_SHA256_MISMATCH"],
    [malformedSupplementalHash, "GCP_BUILD_SOURCE_ARCHIVE_SHA256_MISMATCH"],
    [malformedPaddedBase64UrlHash, "GCP_BUILD_SOURCE_ARCHIVE_SHA256_MISMATCH"],
    [mixedAlphabetPaddedBase64UrlHash, "GCP_BUILD_SOURCE_ARCHIVE_SHA256_MISMATCH"],
    [excessPaddingBase64UrlHash, "GCP_BUILD_SOURCE_ARCHIVE_SHA256_MISMATCH"],
    [extraSupplementalHashField, "GCP_BUILD_SOURCE_ARCHIVE_SHA256_MISMATCH"],
    [conflictingSupplementalHash, "GCP_BUILD_SOURCE_ARCHIVE_SHA256_MISMATCH"],
    [missingOptions, "GCP_BUILD_PROVENANCE_OPTIONS_UNQUALIFIED"],
    [alteredVerifyOption, "GCP_BUILD_PROVENANCE_OPTIONS_UNQUALIFIED"],
  ]) {
    const assessment = assessCloudBuildProvenance({ build, config: configValue });
    assert.equal(assessment.ok, false);
    assert.equal(assessment.blockers.includes(blocker), true, blocker);
  }
});

test("Cloud Build config requests SHA256 source provenance and verified builds", async () => {
  const yamlBytes = await readFile(new URL("../cloud-run/cloudbuild.yaml", import.meta.url));
  const yaml = yamlBytes.toString("utf8");
  assert.equal(
    createHash("sha256").update(yamlBytes).digest("hex"),
    GCP_PRIVATE_TEST_BUILD.cloudBuildConfigSha256,
  );
  assert.match(yaml, /^\s*sourceProvenanceHash:\s*\[SHA256\]\s*$/mu);
  assert.match(yaml, /^\s*requestedVerifyOption:\s*VERIFIED\s*$/mu);
  assert.equal(yaml.includes(`- name: ${GCP_PRIVATE_TEST_BUILD.dockerBuilderImage}`), true);
});

test("local archive readback rejects changed bytes even when its path and size remain stable", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "cloud-run-source-gate-"));
  const archivePath = join(scratch, "source.tar.gz");
  const bytes = Buffer.from("synthetic-archive-one");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const configValue = qualifiedConfig({
    sourceArchivePath: archivePath,
    sourceArchiveSha256: sha,
    sourceObject: GCP_PRIVATE_TEST_BUILD.sourceObjectPrefix + sourceDigest + "-" + sha + ".tar.gz",
  });
  const archiveBuilder = async () => ({
    sourceContentDigest: sourceDigest,
    sourceArchiveSha256: sha,
    cloudBuildConfigSha256: GCP_PRIVATE_TEST_BUILD.cloudBuildConfigSha256,
  });
  try {
    await writeFile(archivePath, bytes, { flag: "wx", mode: 0o600 });
    assert.equal((await assessLocalCloudBuildSourceArchive(configValue, { archiveBuilder })).ok, true);
    const changedBytes = Buffer.from("synthetic-archive-two");
    assert.equal(changedBytes.length, bytes.length);
    await writeFile(archivePath, changedBytes);
    const changed = await assessLocalCloudBuildSourceArchive(configValue, { archiveBuilder });
    assert.equal(changed.ok, false);
    assert.equal(changed.blockers.includes("GCP_PRIVATE_TEST_SOURCE_ARCHIVE_SHA256_MISMATCH"), true);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("local source archive assessment binds its exact cloudbuild config hash", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "cloud-run-config-provenance-"));
  const archivePath = join(scratch, "source.tar.gz");
  const bytes = Buffer.from("synthetic-archive-with-build-config");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const qualified = qualifiedConfig({
    sourceArchivePath: archivePath,
    sourceArchiveSha256: sha,
    sourceObject: GCP_PRIVATE_TEST_BUILD.sourceObjectPrefix + sourceDigest + "-" + sha + ".tar.gz",
  });
  try {
    await writeFile(archivePath, bytes, { flag: "wx", mode: 0o600 });
    const assessWithHash = (cloudBuildConfigSha256) => assessLocalCloudBuildSourceArchive(
      qualified,
      { archiveBuilder: async () => ({
        sourceContentDigest: sourceDigest,
        sourceArchiveSha256: sha,
        cloudBuildConfigSha256,
      }) },
    );
    assert.equal((await assessWithHash(GCP_PRIVATE_TEST_BUILD.cloudBuildConfigSha256)).ok, true);
    const changed = await assessWithHash("d".repeat(64));
    assert.equal(changed.ok, false);
    assert.equal(changed.blockers.includes("GCP_PRIVATE_TEST_BUILD_CONFIG_SHA256_MISMATCH"), true);
    const missing = await assessWithHash(undefined);
    assert.equal(missing.ok, false);
    assert.equal(missing.blockers.includes("GCP_PRIVATE_TEST_BUILD_CONFIG_SHA256_MISMATCH"), true);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("Cloud Run readback requires a ready private service, exact image, and all traffic on its latest ready revision", () => {
  const good = assessCloudRunReadback({
    service: serviceFixture(),
    policy: policyFixture(),
    expectedImage: image,
    expectedSourceDigest: sourceDigest,
  });
  assert.equal(good.ok, true);

  const v2Service = {
    generation: "42",
    observedGeneration: "42",
    ingress: "INGRESS_TRAFFIC_ALL",
    uri: GCP_PRIVATE_TEST_TARGET.hostOrigin,
    template: {
      containers: [{
        image,
        env: Object.entries({
          SOURCE_CONTENT_DIGEST: sourceDigest,
          HOST: "0.0.0.0",
          HOST_ORIGIN: GCP_PRIVATE_TEST_TARGET.hostOrigin,
          POSTGRES_TEST_HTTP_MODE: "cloud-run-iam",
          ...backingTargetEnvironment,
        }).map(([name, value]) => ({ name, value })),
      }],
      serviceAccount: GCP_PRIVATE_TEST_TARGET.runtimeServiceAccount,
    },
    latestReadyRevision: "projects/tibotattle/locations/us-east1/services/tibotattle-test-app/revisions/tibotattle-test-app-00042-abc",
    latestCreatedRevision: "projects/tibotattle/locations/us-east1/services/tibotattle-test-app/revisions/tibotattle-test-app-00042-abc",
    trafficStatuses: [{
      revision: "projects/tibotattle/locations/us-east1/services/tibotattle-test-app/revisions/tibotattle-test-app-00042-abc",
      percent: 100,
    }],
    terminalCondition: { type: "Ready", state: "CONDITION_SUCCEEDED" },
  };
  assert.equal(assessCloudRunReadback({
    service: v2Service,
    policy: policyFixture(),
    expectedImage: image,
    expectedSourceDigest: sourceDigest,
  }).ok, true);
  assert.equal(assessCloudRunReadback({
    service: v2Service,
    policy: policyFixture(),
    expectedImage: image,
    expectedSourceDigest: sourceDigest,
    requireCloudRunHostMode: true,
  }).ok, true);

  const v2FailedCondition = { ...v2Service,
    terminalCondition: { type: "Ready", state: "CONDITION_FAILED" } };
  assert.equal(assessCloudRunReadback({
    service: v2FailedCondition,
    policy: policyFixture(),
    expectedImage: image,
    expectedSourceDigest: sourceDigest,
  }).blockers.includes("GCP_TEST_SERVICE_NOT_READY"), true);
  const v2UnexpectedIngress = { ...v2Service, ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY" };
  assert.equal(assessCloudRunReadback({
    service: v2UnexpectedIngress,
    policy: policyFixture(),
    expectedImage: image,
    expectedSourceDigest: sourceDigest,
  }).blockers.includes("GCP_TEST_INGRESS_UNEXPECTED"), true);
  const v2UnexpectedUrl = { ...v2Service, uri: "https://unexpected.example.invalid" };
  assert.equal(assessCloudRunReadback({
    service: v2UnexpectedUrl,
    policy: policyFixture(),
    expectedImage: image,
    expectedSourceDigest: sourceDigest,
    requireCloudRunHostMode: true,
  }).blockers.includes("GCP_TEST_HOST_MODE_READBACK_UNQUALIFIED"), true);

  const v2WrongServiceAccount = {
    ...v2Service,
    template: { ...v2Service.template, serviceAccount: "other@tibotattle.iam.gserviceaccount.com" },
  };
  assert.equal(assessCloudRunReadback({
    service: v2WrongServiceAccount,
    policy: policyFixture(),
    expectedImage: image,
    expectedSourceDigest: sourceDigest,
  }).blockers.includes("GCP_TEST_RUNTIME_SERVICE_ACCOUNT_UNQUALIFIED"), true);

  for (const [service, policy, code] of [
    [serviceFixture({ ready: "False" }), policyFixture(), "GCP_TEST_SERVICE_NOT_READY"],
    [serviceFixture({ ingress: "internal" }), policyFixture(), "GCP_TEST_INGRESS_UNEXPECTED"],
    [serviceFixture({ invokerIamDisabled: true }), policyFixture(), "GCP_TEST_INVOKER_IAM_CHECK_DISABLED"],
    [serviceFixture({ invokerIamDisabledAnnotation: "true" }), policyFixture(), "GCP_TEST_INVOKER_IAM_CHECK_DISABLED"],
    [serviceFixture({ traffic: [
      { revisionName: "tibotattle-test-app-00042-abc", percent: 80 },
      { revisionName: "tibotattle-test-app-00041-def", percent: 20 },
    ] }), policyFixture(), "GCP_TEST_LATEST_REVISION_TRAFFIC_UNQUALIFIED"],
    [serviceFixture({ traffic: [{ revisionName: "tibotattle-test-app-00041-def", percent: 100 }] }),
      policyFixture(), "GCP_TEST_LATEST_REVISION_TRAFFIC_UNQUALIFIED"],
    [serviceFixture({ latestCreatedRevisionName: "tibotattle-test-app-00043-ghi" }), policyFixture(),
      "GCP_TEST_LATEST_REVISION_TRAFFIC_UNQUALIFIED"],
    [serviceFixture({ observedGeneration: 41 }), policyFixture(),
      "GCP_TEST_LATEST_REVISION_TRAFFIC_UNQUALIFIED"],
    [serviceWithoutLatestReadyRevision(), policyFixture(),
      "GCP_TEST_LATEST_REVISION_TRAFFIC_UNQUALIFIED"],
    [serviceFixture({ traffic: [{ revisionName: "tibotattle-test-app-00042-abc", percent: "100" }] }),
      policyFixture(), "GCP_TEST_LATEST_REVISION_TRAFFIC_UNQUALIFIED"],
    [serviceFixture({ serviceImage: GCP_PRIVATE_TEST_TARGET.imageRepository + "@sha256:" + "c".repeat(64) }),
      policyFixture(), "GCP_TEST_IMAGE_DIGEST_MISMATCH"],
    [serviceFixture({ source: "d".repeat(64) }), policyFixture(), "GCP_TEST_SOURCE_DIGEST_READBACK_MISMATCH"],
    [serviceFixture(), policyFixture(["allUsers"]), "GCP_TEST_PUBLIC_INVOKER_PRESENT"],
    [serviceFixture(), policyFixture(["allAuthenticatedUsers"]), "GCP_TEST_PUBLIC_INVOKER_PRESENT"],
  ]) {
    const result = assessCloudRunReadback({
      service, policy, expectedImage: image, expectedSourceDigest: sourceDigest,
    });
    assert.equal(result.ok, false);
    assert.equal(result.blockers.includes(code), true);
  }
});

test("Cloud Run readback pins every database, IAM-user, bucket, and runtime identity target", () => {
  for (const name of Object.keys(backingTargetEnvironment)) {
    const missing = serviceFixture();
    missing.spec.template.spec.containers[0].env = missing.spec.template.spec.containers[0].env
      .filter((entry) => entry.name !== name);
    const missingAssessment = assessCloudRunReadback({
      service: missing,
      policy: policyFixture(),
      expectedImage: image,
      expectedSourceDigest: sourceDigest,
    });
    const expectedBlocker = name === "POSTGRES_IAM_USER"
      ? "GCP_TEST_CREDENTIAL_SCOPE_READBACK_UNQUALIFIED"
      : "GCP_TEST_BACKING_TARGET_READBACK_UNQUALIFIED";
    assert.equal(missingAssessment.blockers.includes(expectedBlocker), true, `missing ${name}`);

    const altered = serviceFixture({ environmentOverrides: { [name]: "other-test-target" } });
    const alteredAssessment = assessCloudRunReadback({
      service: altered,
      policy: policyFixture(),
      expectedImage: image,
      expectedSourceDigest: sourceDigest,
    });
    assert.equal(alteredAssessment.blockers.includes(expectedBlocker), true, `altered ${name}`);
  }

  const unknownCredential = serviceFixture();
  unknownCredential.spec.template.spec.containers[0].env.push({ name: "PRIMARY_DATABASE_URL", value: "redacted" });
  assert.equal(assessCloudRunReadback({
    service: unknownCredential,
    policy: policyFixture(),
    expectedImage: image,
    expectedSourceDigest: sourceDigest,
  }).blockers.includes("GCP_TEST_CREDENTIAL_SCOPE_READBACK_UNQUALIFIED"), true);

  const wrongRuntimeIdentity = serviceFixture({ serviceAccount: "other@tibotattle.iam.gserviceaccount.com" });
  assert.equal(assessCloudRunReadback({
    service: wrongRuntimeIdentity,
    policy: policyFixture(),
    expectedImage: image,
    expectedSourceDigest: sourceDigest,
  }).blockers.includes("GCP_TEST_RUNTIME_SERVICE_ACCOUNT_UNQUALIFIED"), true);

  const knownPreviousProfile = serviceFixture({
    environmentOverrides: {
      PRIMARY_SCHEMA: "tibotattle",
      LEDGER_SCHEMA: "tibotattle_ledger",
      GCS_BUCKET_NAME: "tibotattle-gcs-test-app-20260922",
      GCS_ERASURE_BUCKET_HISTORY_PROOF: previousBucketHistoryProofJson,
    },
  });
  assert.equal(assessCloudRunReadback({
    service: knownPreviousProfile,
    policy: policyFixture(),
    expectedImage: image,
    expectedSourceDigest: sourceDigest,
    expectedBucketHistoryProof: bucketHistoryProofJson,
    requireBackingTargets: false,
    allowKnownPreviousBackingTargets: true,
  }).blockers.includes("GCP_TEST_BACKING_TARGET_READBACK_UNQUALIFIED"), false);
  const unknownPreviousProfile = serviceFixture({
    environmentOverrides: {
      PRIMARY_SCHEMA: "unrecognized_schema",
      LEDGER_SCHEMA: "tibotattle_ledger",
      GCS_BUCKET_NAME: "tibotattle-gcs-test-app-20260922",
      GCS_ERASURE_BUCKET_HISTORY_PROOF: previousBucketHistoryProofJson,
    },
  });
  assert.equal(assessCloudRunReadback({
    service: unknownPreviousProfile,
    policy: policyFixture(),
    expectedImage: image,
    expectedSourceDigest: sourceDigest,
    expectedBucketHistoryProof: bucketHistoryProofJson,
    requireBackingTargets: false,
    allowKnownPreviousBackingTargets: true,
  }).blockers.includes("GCP_TEST_BACKING_TARGET_READBACK_UNQUALIFIED"), true);

  assert.equal(assessCloudRunReadback({
    service: serviceFixture(),
    policy: policyFixture(),
    expectedImage: image,
    expectedSourceDigest: sourceDigest,
    expectedBucketHistoryProof: bucketHistoryProofJson,
  }).ok, true);
  const wrongProof = serviceFixture({
    environmentOverrides: { GCS_ERASURE_BUCKET_HISTORY_PROOF: previousBucketHistoryProofJson },
  });
  assert.equal(assessCloudRunReadback({
    service: wrongProof,
    policy: policyFixture(),
    expectedImage: image,
    expectedSourceDigest: sourceDigest,
    expectedBucketHistoryProof: bucketHistoryProofJson,
  }).blockers.includes("GCP_TEST_BUCKET_HISTORY_PROOF_READBACK_UNQUALIFIED"), true);
  const duplicateProof = serviceFixture({
    additionalEnvironment: [
      { name: "GCS_ERASURE_BUCKET_HISTORY_PROOF", value: bucketHistoryProofJson },
    ],
  });
  assert.equal(assessCloudRunReadback({
    service: duplicateProof,
    policy: policyFixture(),
    expectedImage: image,
    expectedSourceDigest: sourceDigest,
    expectedBucketHistoryProof: bucketHistoryProofJson,
  }).blockers.includes("GCP_TEST_BUCKET_HISTORY_PROOF_READBACK_UNQUALIFIED"), true);
});

test("Cloud Run host mode needs the explicit cloud-run-iam predicate", () => {
  let seen;
  assert.equal(cloudRunHostModeReady((value) => {
    seen = value;
    return value.mode === "cloud-run-iam"
      && value.listenHost === "0.0.0.0"
      && value.hostOrigin.startsWith("https://");
  }), true);
  assert.deepEqual(seen, {
    mode: "cloud-run-iam",
    service: GCP_PRIVATE_TEST_TARGET.service,
    project: GCP_PRIVATE_TEST_TARGET.project,
    region: GCP_PRIVATE_TEST_TARGET.region,
    listenHost: "0.0.0.0",
    hostOrigin: GCP_PRIVATE_TEST_TARGET.hostOrigin,
    port: 8080,
  });
  assert.equal(cloudRunHostModeReady(() => false), false);
  assert.equal(cloudRunHostModeReady(null), false);

  const qualifiedHost = assessCloudRunReadback({
    service: serviceFixture(),
    policy: policyFixture(),
    expectedImage: image,
    expectedSourceDigest: sourceDigest,
    requireCloudRunHostMode: true,
  });
  assert.equal(qualifiedHost.ok, true);
  const alternateHost = serviceFixture();
  alternateHost.spec.template.spec.containers[0].env.find((entry) => entry.name === "HOST_ORIGIN").value =
    "https://alternate.example.invalid";
  assert.equal(assessCloudRunReadback({
    service: alternateHost,
    policy: policyFixture(),
    expectedImage: image,
    expectedSourceDigest: sourceDigest,
    requireCloudRunHostMode: true,
  }).blockers.includes("GCP_TEST_HOST_MODE_READBACK_UNQUALIFIED"), true);
  const localModeOnPublicBind = serviceFixture({
    postgresTestMode: "health-and-v12-day-manifest",
  });
  assert.equal(assessCloudRunReadback({
    service: localModeOnPublicBind,
    policy: policyFixture(),
    expectedImage: image,
    expectedSourceDigest: sourceDigest,
    requireCloudRunHostMode: true,
  }).blockers.includes("GCP_TEST_HOST_MODE_READBACK_UNQUALIFIED"), true);
});

test("deploy refuses unqualified build provenance before any remote Cloud Run operation", async () => {
  const calls = [];
  const result = await runGcpPrivateTestDeployment({
    config: config(),
    isPrivateHost: () => true,
    spawn: (command, args) => {
      calls.push({ command, args });
      return {
        status: 0,
        stdout: JSON.stringify({
          status: "ok",
          mode: "check",
          sourceContentDigest: sourceDigest,
        }),
        stderr: "",
      };
    },
  });
  assert.deepEqual(result, {
    status: "blocked",
    blockers: [
      "SOURCE_PROVENANCE_UNQUALIFIED",
      "GCP_BUILD_PROVENANCE_ARGUMENTS_REQUIRED",
    ],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.at(-1), "--check");
  assert.notEqual(calls[0].command, "gcloud");
});

test("preflight retains read-only live assessment while reporting the provenance blocker", async () => {
  const calls = [];
  const result = await runGcpPrivateTestDeployment({
    config: config({ command: "preflight" }),
    isPrivateHost: () => false,
    fetchImpl: async (_url, options) => {
      assert.equal(Object.hasOwn(options.headers, "authorization"), false);
      return new Response(null, { status: 403 });
    },
    spawn: (command, args) => {
      calls.push({ command, args });
      if (args.at(-1) === "--check") {
        return {
          status: 0,
          stdout: JSON.stringify({ status: "ok", mode: "check", sourceContentDigest: sourceDigest }),
          stderr: "",
        };
      }
      if (args[0] === "run" && args[1] === "services" && args[2] === "describe") {
        return { status: 0, stdout: JSON.stringify(serviceFixture()), stderr: "" };
      }
      if (args[0] === "run" && args[1] === "services" && args[2] === "get-iam-policy") {
        return { status: 0, stdout: JSON.stringify(policyFixture()), stderr: "" };
      }
      throw new Error("Unexpected command in read-only preflight.");
    },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.readOnlyAssessment, true);
  assert.deepEqual(result.blockers, [
    "SOURCE_PROVENANCE_UNQUALIFIED",
    "GCP_BUILD_PROVENANCE_ARGUMENTS_REQUIRED",
    "POSTGRES_TEST_HOST_CLOUD_RUN_MODE_UNAVAILABLE",
  ]);
  assert.equal(calls.some(({ command, args }) => command === "gcloud"
    && args[0] === "run" && args[1] === "deploy"), false);
});

test("read-only verification reports source and live image blockers without requesting a token", async () => {
  const oldImage = GCP_PRIVATE_TEST_TARGET.imageRepository + "@sha256:" + "c".repeat(64);
  const calls = [];
  const result = await runGcpPrivateTestDeployment({
    config: config({ command: "verify" }),
    isPrivateHost: () => false,
    fetchImpl: async (_url, options) => {
      assert.equal(Object.hasOwn(options.headers, "authorization"), false);
      return new Response(null, { status: 403 });
    },
    spawn: (_command, args) => {
      calls.push(args);
      if (args.at(-1) === "--check") {
        return {
          status: 0,
          stdout: JSON.stringify({
            status: "ok",
            mode: "check",
            sourceContentDigest: sourceDigest,
          }),
          stderr: "",
        };
      }
      if (args[0] === "run" && args[1] === "services" && args[2] === "describe") {
        return {
          status: 0,
          stdout: JSON.stringify(serviceFixture({
            serviceImage: oldImage,
            source: "d".repeat(64),
          })),
          stderr: "",
        };
      }
      if (args[0] === "run" && args[1] === "services"
          && args[2] === "get-iam-policy") {
        return { status: 0, stdout: JSON.stringify(policyFixture()), stderr: "" };
      }
      throw new Error("Unexpected command in read-only verification.");
    },
  });
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blockers, [
    "SOURCE_PROVENANCE_UNQUALIFIED",
    "GCP_BUILD_PROVENANCE_ARGUMENTS_REQUIRED",
    "GCP_TEST_IMAGE_DIGEST_MISMATCH",
    "GCP_TEST_SOURCE_DIGEST_READBACK_MISMATCH",
    "POSTGRES_TEST_HOST_CLOUD_RUN_MODE_UNAVAILABLE",
  ]);
  assert.equal(calls.some((args) => args[0] === "auth"), false);
});

test("unauthenticated service probe accepts only an IAM denial and never sends a token", async () => {
  const denied = await runUnauthenticatedInvokerProbe({
    serviceUrl: "https://test-service.example.invalid",
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.equal(Object.hasOwn(options.headers, "authorization"), false);
      return new Response(null, { status: 403 });
    },
  });
  assert.deepEqual(denied, { ok: true, result: "denied_without_identity" });

  const publicResponse = await runUnauthenticatedInvokerProbe({
    serviceUrl: "https://test-service.example.invalid",
    fetchImpl: async () => new Response(null, { status: 200 }),
  });
  assert.deepEqual(publicResponse, { ok: false, result: "unexpected_http_status" });
});

test("verify performs read-only assessment but never claims exact-image success without source provenance", async () => {
  const calls = [];
  const result = await runGcpPrivateTestDeployment({
    config: config({ command: "verify" }),
    isPrivateHost: () => true,
    fetchImpl: async (_url, options) => {
      assert.equal(Object.hasOwn(options.headers, "authorization"), false);
      return new Response(null, { status: 403 });
    },
    spawn: (command, args) => {
      calls.push({ command, args });
      if (args.at(-1) === "--check") {
        return {
          status: 0,
          stdout: JSON.stringify({
            status: "ok",
            mode: "check",
            sourceContentDigest: sourceDigest,
          }),
          stderr: "",
        };
      }
      if (args[0] === "run" && args[1] === "services" && args[2] === "describe") {
        return { status: 0, stdout: JSON.stringify(serviceFixture()), stderr: "" };
      }
      if (args[0] === "run" && args[1] === "services"
          && args[2] === "get-iam-policy") {
        return { status: 0, stdout: JSON.stringify(policyFixture()), stderr: "" };
      }
      throw new Error("Unexpected command in read-only verify.");
    },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.readOnlyAssessment, true);
  assert.deepEqual(result.blockers, [
    "SOURCE_PROVENANCE_UNQUALIFIED",
    "GCP_BUILD_PROVENANCE_ARGUMENTS_REQUIRED",
  ]);
  assert.equal(result.unauthenticatedProbe, "denied_without_identity");
  assert.equal(calls.some(({ command, args }) => command === "gcloud"
    && args[0] === "run" && args[1] === "deploy"), false);
  assert.equal(calls.some(({ command, args }) => command === "gcloud"
    && args[0] === "auth"), false);
});

test("verify qualifies only after local archive and regional Build readback prove the same source and image", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "cloud-run-provenance-verify-"));
  const archivePath = join(scratch, "source.tar.gz");
  const bytes = Buffer.from("synthetic build archive");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const qualified = qualifiedConfig({
    command: "verify",
    sourceArchivePath: archivePath,
    sourceArchiveSha256: sha,
    sourceObject: GCP_PRIVATE_TEST_BUILD.sourceObjectPrefix + sourceDigest + "-" + sha + ".tar.gz",
  });
  const build = buildFixture({}, qualified);
  const calls = [];
  try {
    await writeFile(archivePath, bytes, { flag: "wx", mode: 0o600 });
    const result = await runGcpPrivateTestDeployment({
      config: qualified,
      archiveBuilder: async () => ({
        sourceContentDigest: sourceDigest,
        sourceArchiveSha256: sha,
        cloudBuildConfigSha256: GCP_PRIVATE_TEST_BUILD.cloudBuildConfigSha256,
      }),
      isPrivateHost: () => true,
      fetchImpl: async (_url, options) => {
        assert.equal(Object.hasOwn(options.headers, "authorization"), false);
        return new Response(null, { status: 403 });
      },
      spawn: (command, args) => {
        calls.push({ command, args });
        if (command === process.execPath && args.at(-1) === "--check") {
          return { status: 0, stdout: JSON.stringify({
            status: "ok", mode: "check", sourceContentDigest: sourceDigest,
          }), stderr: "" };
        }
        if (args[0] === "builds" && args[1] === "describe") {
          return { status: 0, stdout: JSON.stringify(build), stderr: "" };
        }
        if (args[0] === "run" && args[1] === "services" && args[2] === "describe") {
          return { status: 0, stdout: JSON.stringify(serviceFixture()), stderr: "" };
        }
        if (args[0] === "run" && args[1] === "services" && args[2] === "get-iam-policy") {
          return { status: 0, stdout: JSON.stringify(policyFixture()), stderr: "" };
        }
        throw new Error("Unexpected command in provenance verify.");
      },
    });
    assert.equal(result.status, "verified");
    assert.deepEqual(result.blockers, []);
    assert.deepEqual(result.sourceProvenance, {
      buildId: qualified.buildId,
      sourceGeneration,
      sourceArchiveSha256: sha,
      image,
    });
    assert.equal(calls.some(({ args }) => args[0] === "builds" && args[1] === "describe"), true);
    assert.equal(calls.some(({ args }) => args[0] === "run" && args[1] === "deploy"), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("deploy applies only qualified image and scoped env updates, then rechecks IAM and host mode", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "cloud-run-provenance-deploy-"));
  const archivePath = join(scratch, "source.tar.gz");
  const bytes = Buffer.from("synthetic build archive for deploy");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const qualified = qualifiedConfig({
    command: "deploy",
    sourceArchivePath: archivePath,
    sourceArchiveSha256: sha,
    sourceObject: GCP_PRIVATE_TEST_BUILD.sourceObjectPrefix + sourceDigest + "-" + sha + ".tar.gz",
  });
  const build = buildFixture({}, qualified);
  const oldImage = GCP_PRIVATE_TEST_TARGET.imageRepository + "@sha256:" + "d".repeat(64);
  const initialService = serviceFixture({
    serviceImage: oldImage,
    source: "d".repeat(64),
    postgresTestMode: "health-and-v12-day-manifest",
    environmentOverrides: {
      PRIMARY_SCHEMA: "tibotattle",
      LEDGER_SCHEMA: "tibotattle_ledger",
      GCS_BUCKET_NAME: "tibotattle-gcs-test-app-20260922",
      GCS_ERASURE_BUCKET_HISTORY_PROOF: previousBucketHistoryProofJson,
    },
  });
  initialService.spec.template.spec.containers[0].env.find((entry) => entry.name === "HOST_ORIGIN").value =
    "https://alternate.example.invalid";
  let serviceReadbacks = 0;
  let deployArgs = null;
  let trafficArgs = null;
  const calls = [];
  try {
    await writeFile(archivePath, bytes, { flag: "wx", mode: 0o600 });
    const result = await runGcpPrivateTestDeployment({
      config: qualified,
      archiveBuilder: async () => ({
        sourceContentDigest: sourceDigest,
        sourceArchiveSha256: sha,
        cloudBuildConfigSha256: GCP_PRIVATE_TEST_BUILD.cloudBuildConfigSha256,
      }),
      isPrivateHost: () => true,
      fetchImpl: async (_url, options) => {
        assert.equal(Object.hasOwn(options.headers, "authorization"), false);
        return new Response(null, { status: 403 });
      },
      spawn: (command, args) => {
        calls.push({ command, args });
        if (command === process.execPath && args.at(-1) === "--check") {
          return { status: 0, stdout: JSON.stringify({
            status: "ok", mode: "check", sourceContentDigest: sourceDigest,
          }), stderr: "" };
        }
        if (args[0] === "builds" && args[1] === "describe") {
          return { status: 0, stdout: JSON.stringify(build), stderr: "" };
        }
        if (args[0] === "run" && args[1] === "deploy") {
          deployArgs = args;
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "run" && args[1] === "services" && args[2] === "update-traffic") {
          trafficArgs = args;
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "run" && args[1] === "services" && args[2] === "describe") {
          serviceReadbacks += 1;
          return {
            status: 0,
            stdout: JSON.stringify(serviceReadbacks === 1 ? initialService : serviceFixture()),
            stderr: "",
          };
        }
        if (args[0] === "run" && args[1] === "services" && args[2] === "get-iam-policy") {
          return { status: 0, stdout: JSON.stringify(policyFixture()), stderr: "" };
        }
        throw new Error("Unexpected command in provenance deploy.");
      },
    });
    assert.equal(result.status, "deployed", JSON.stringify(result));
    assert.deepEqual(result.blockers, []);
    assert.equal(result.postDeployAssessment, true);
    assert.equal(result.routeSmoke, "not_run_application_device_token_required");
    assert.ok(Array.isArray(deployArgs));
    assert.equal(deployArgs.includes("--no-allow-unauthenticated"), true);
    assert.equal(deployArgs.includes("--allow-unauthenticated"), false);
    assert.equal(deployArgs.some((argument) => argument.startsWith("--set-env-vars")), false);
    const updateArgument = deployArgs.find((argument) =>
      argument.startsWith("--update-env-vars="));
    assert.ok(updateArgument);
    assert.equal(updateArgument.startsWith("--update-env-vars=^|^"), true);
    const updates = updateArgument.slice("--update-env-vars=^|^".length)
      .split("|")
      .map((entry) => {
        const separator = entry.indexOf("=");
        assert.ok(separator > 0);
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      });
    assert.deepEqual(updates, [
      ["HOST", "0.0.0.0"],
      ["HOST_ORIGIN", GCP_PRIVATE_TEST_TARGET.hostOrigin],
      ["POSTGRES_TEST_HTTP_MODE", "cloud-run-iam"],
      ["PRIMARY_INSTANCE_CONNECTION_NAME", GCP_PRIVATE_TEST_TARGET.primaryInstanceConnectionName],
      ["PRIMARY_DATABASE", GCP_PRIVATE_TEST_TARGET.primaryDatabase],
      ["PRIMARY_SCHEMA", "tibotattle_v12_a2_20260925"],
      ["LEDGER_INSTANCE_CONNECTION_NAME", GCP_PRIVATE_TEST_TARGET.ledgerInstanceConnectionName],
      ["LEDGER_DATABASE", GCP_PRIVATE_TEST_TARGET.ledgerDatabase],
      ["LEDGER_SCHEMA", "tibotattle_ledger_v12_a2_20260925"],
      ["GCS_BUCKET_NAME", "tibotattle-gcs-test-cleanup-20260925-a2"],
      ["GCS_ERASURE_BUCKET_HISTORY_PROOF", bucketHistoryProofJson],
      ["POSTGRES_IAM_USER", GCP_PRIVATE_TEST_TARGET.postgresIamUser],
      ["SOURCE_CONTENT_DIGEST", sourceDigest],
    ]);
    assert.equal(updates.some(([name]) => name === "ADMIN_IDENTITY_LINK_KEY"), false);
    assert.equal(deployArgs.includes("--image=" + image), true);
    assert.equal(deployArgs.includes("--service-account=" + GCP_PRIVATE_TEST_TARGET.runtimeServiceAccount), true);
    assert.deepEqual(trafficArgs, [
      "run", "services", "update-traffic", GCP_PRIVATE_TEST_TARGET.service,
      "--to-latest",
      "--project=" + GCP_PRIVATE_TEST_TARGET.project,
      "--region=" + GCP_PRIVATE_TEST_TARGET.region,
      "--quiet",
    ]);
    assert.equal(deployArgs.includes("--no-allow-unauthenticated"), true);
    assert.equal(trafficArgs.includes("--allow-unauthenticated"), false);
    const deployCallIndex = calls.findIndex(({ args }) => args[0] === "run" && args[1] === "deploy");
    const trafficCallIndex = calls.findIndex(({ args }) => args[0] === "run"
      && args[1] === "services" && args[2] === "update-traffic");
    const postDeployReadbackIndex = calls.findIndex(({ args }, index) => index > trafficCallIndex
      && args[0] === "run" && args[1] === "services" && args[2] === "describe");
    assert.equal(deployCallIndex >= 0 && trafficCallIndex > deployCallIndex, true);
    assert.equal(postDeployReadbackIndex > trafficCallIndex, true);
    assert.equal(calls.filter(({ args }) => args[0] === "run"
      && args[1] === "services" && args[2] === "get-iam-policy").length, 2);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("deploy reports only a sanitized gcloud failure when the history proof was supplied", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "cloud-run-proof-deploy-failure-"));
  const archivePath = join(scratch, "source.tar.gz");
  const bytes = Buffer.from("synthetic archive for proof deployment failure");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const qualified = qualifiedConfig({
    sourceArchivePath: archivePath,
    sourceArchiveSha256: sha,
    sourceObject: GCP_PRIVATE_TEST_BUILD.sourceObjectPrefix + sourceDigest + "-" + sha + ".tar.gz",
  });
  const build = buildFixture({}, qualified);
  const previousService = serviceFixture({
    serviceImage: GCP_PRIVATE_TEST_TARGET.imageRepository + "@sha256:" + "d".repeat(64),
    source: "d".repeat(64),
    environmentOverrides: {
      PRIMARY_SCHEMA: "tibotattle",
      LEDGER_SCHEMA: "tibotattle_ledger",
      GCS_BUCKET_NAME: "tibotattle-gcs-test-app-20260922",
      GCS_ERASURE_BUCKET_HISTORY_PROOF: previousBucketHistoryProofJson,
    },
  });
  try {
    await writeFile(archivePath, bytes, { flag: "wx", mode: 0o600 });
    await assert.rejects(runGcpPrivateTestDeployment({
      config: qualified,
      archiveBuilder: async () => ({
        sourceContentDigest: sourceDigest,
        sourceArchiveSha256: sha,
        cloudBuildConfigSha256: GCP_PRIVATE_TEST_BUILD.cloudBuildConfigSha256,
      }),
      isPrivateHost: () => true,
      fetchImpl: async () => new Response(null, { status: 403 }),
      spawn: (command, args) => {
        if (command === process.execPath && args.at(-1) === "--check") {
          return { status: 0, stdout: JSON.stringify({
            status: "ok", mode: "check", sourceContentDigest: sourceDigest,
          }), stderr: "" };
        }
        if (args[0] === "builds" && args[1] === "describe") {
          return { status: 0, stdout: JSON.stringify(build), stderr: "" };
        }
        if (args[0] === "run" && args[1] === "services" && args[2] === "describe") {
          return { status: 0, stdout: JSON.stringify(previousService), stderr: "" };
        }
        if (args[0] === "run" && args[1] === "services" && args[2] === "get-iam-policy") {
          return { status: 0, stdout: JSON.stringify(policyFixture()), stderr: "" };
        }
        if (args[0] === "run" && args[1] === "deploy") {
          return {
            status: 1,
            stdout: "",
            stderr: "synthetic rejection included " + bucketHistoryProofJson,
          };
        }
        throw new Error("Unexpected command in sanitized deployment failure check.");
      },
    }), (error) => {
      assert.equal(error?.code, "GCP_PRIVATE_TEST_GCLOUD_OPERATION_FAILED");
      assert.equal(error.message.includes(bucketHistoryProofJson), false);
      return true;
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("deploy stops after a failed fixed-service latest-traffic update", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "cloud-run-traffic-update-failure-"));
  const archivePath = join(scratch, "source.tar.gz");
  const bytes = Buffer.from("synthetic archive for traffic update failure");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const qualified = qualifiedConfig({
    sourceArchivePath: archivePath,
    sourceArchiveSha256: sha,
    sourceObject: GCP_PRIVATE_TEST_BUILD.sourceObjectPrefix + sourceDigest + "-" + sha + ".tar.gz",
  });
  const build = buildFixture({}, qualified);
  const calls = [];
  try {
    await writeFile(archivePath, bytes, { flag: "wx", mode: 0o600 });
    await assert.rejects(runGcpPrivateTestDeployment({
      config: qualified,
      archiveBuilder: async () => ({
        sourceContentDigest: sourceDigest,
        sourceArchiveSha256: sha,
        cloudBuildConfigSha256: GCP_PRIVATE_TEST_BUILD.cloudBuildConfigSha256,
      }),
      isPrivateHost: () => true,
      fetchImpl: async () => new Response(null, { status: 403 }),
      spawn: (command, args) => {
        calls.push({ command, args });
        if (command === process.execPath && args.at(-1) === "--check") {
          return { status: 0, stdout: JSON.stringify({
            status: "ok", mode: "check", sourceContentDigest: sourceDigest,
          }), stderr: "" };
        }
        if (args[0] === "builds" && args[1] === "describe") {
          return { status: 0, stdout: JSON.stringify(build), stderr: "" };
        }
        if (args[0] === "run" && args[1] === "services" && args[2] === "describe") {
          return { status: 0, stdout: JSON.stringify(serviceFixture({
            serviceImage: GCP_PRIVATE_TEST_TARGET.imageRepository + "@sha256:" + "d".repeat(64),
            source: "d".repeat(64),
          })), stderr: "" };
        }
        if (args[0] === "run" && args[1] === "services" && args[2] === "get-iam-policy") {
          return { status: 0, stdout: JSON.stringify(policyFixture()), stderr: "" };
        }
        if (args[0] === "run" && args[1] === "deploy") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "run" && args[1] === "services" && args[2] === "update-traffic") {
          return { status: 1, stdout: "", stderr: "redacted gcloud error" };
        }
        throw new Error("Unexpected command in failed traffic-update test.");
      },
    }), (error) => error.code === "GCP_PRIVATE_TEST_GCLOUD_OPERATION_FAILED");
    assert.equal(calls.some(({ args }) => args[0] === "run" && args[1] === "services"
      && args[2] === "update-traffic" && args[3] === GCP_PRIVATE_TEST_TARGET.service
      && args[4] === "--to-latest"), true);
    assert.equal(calls.filter(({ args }) => args[0] === "run" && args[1] === "services"
      && args[2] === "describe").length, 1);
    const trafficCallIndex = calls.findIndex(({ args }) => args[0] === "run"
      && args[1] === "services" && args[2] === "update-traffic");
    assert.equal(calls.some(({ args }, index) => index > trafficCallIndex
      && args[0] === "run" && args[1] === "services" && args[2] === "describe"), false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("deploy refuses every wrong or missing backing target, runtime identity, and unknown credential before run deploy", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "cloud-run-target-reject-"));
  const archivePath = join(scratch, "source.tar.gz");
  const bytes = Buffer.from("synthetic archive for target rejection");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const qualified = qualifiedConfig({
    sourceArchivePath: archivePath,
    sourceArchiveSha256: sha,
    sourceObject: GCP_PRIVATE_TEST_BUILD.sourceObjectPrefix + sourceDigest + "-" + sha + ".tar.gz",
  });
  const build = buildFixture({}, qualified);
  try {
    await writeFile(archivePath, bytes, { flag: "wx", mode: 0o600 });
    const mutations = [
      ...Object.keys(backingTargetEnvironment).flatMap((name) => [
        {
          name: "wrong " + name,
          makeService: () => serviceFixture({ environmentOverrides: { [name]: "wrong-target" } }),
        },
        {
          name: "missing " + name,
          makeService: () => serviceFixture({ environmentOmissions: [name] }),
        },
      ]),
      {
        name: "runtime service account",
        makeService: () => serviceFixture({ serviceAccount: "wrong@tibotattle.iam.gserviceaccount.com" }),
      },
      {
        name: "missing runtime service account",
        makeService: () => serviceFixture({ serviceAccount: null }),
      },
      {
        name: "unknown credential scope",
        makeService: () => serviceFixture({
          additionalEnvironment: [{ name: "PRIMARY_DATABASE_URL", value: "redacted" }],
        }),
      },
    ];
    for (const mutation of mutations) {
      const calls = [];
      const result = await runGcpPrivateTestDeployment({
        config: qualified,
        archiveBuilder: async () => ({
          sourceContentDigest: sourceDigest,
          sourceArchiveSha256: sha,
          cloudBuildConfigSha256: GCP_PRIVATE_TEST_BUILD.cloudBuildConfigSha256,
        }),
        isPrivateHost: () => true,
        fetchImpl: async () => new Response(null, { status: 403 }),
        spawn: (command, args) => {
          calls.push({ command, args });
          if (command === process.execPath && args.at(-1) === "--check") {
            return { status: 0, stdout: JSON.stringify({
              status: "ok", mode: "check", sourceContentDigest: sourceDigest,
            }), stderr: "" };
          }
          if (args[0] === "builds" && args[1] === "describe") {
            return { status: 0, stdout: JSON.stringify(build), stderr: "" };
          }
          if (args[0] === "run" && args[1] === "services" && args[2] === "describe") {
            return { status: 0, stdout: JSON.stringify(mutation.makeService()), stderr: "" };
          }
          if (args[0] === "run" && args[1] === "services" && args[2] === "get-iam-policy") {
            return { status: 0, stdout: JSON.stringify(policyFixture()), stderr: "" };
          }
          if (args[0] === "run" && args[1] === "deploy") {
            return { status: 0, stdout: "", stderr: "" };
          }
          throw new Error("Unexpected command in target rejection test.");
        },
      });
      assert.equal(result.status, "blocked", mutation.name);
      assert.equal(calls.some(({ args }) => args[0] === "run" && args[1] === "deploy"), false,
        mutation.name + " must block before deploy");
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("synthetic route smoke checks health and rejects an invalid v1.2 envelope without writes", async () => {
  const calls = [];
  const response = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
  const result = await runSyntheticRouteBoundarySmoke({
    serviceUrl: "https://test-service.example.invalid",
    token: "synthetic-identity-token-placeholder",
    fetchImpl: async (url, options) => {
      const parsed = new URL(String(url));
      calls.push({ path: parsed.pathname, options });
      if (parsed.pathname === "/api/health") {
        return response({
          schemaVersion: "gcp-postgres-test-health-v1",
          status: "ready",
          workerApplicationReady: false,
          checks: {
            primaryMigrationReceipt: { status: "current" },
            ledgerMigrationReceipt: { status: "current" },
          },
        });
      }
      assert.equal(parsed.pathname, "/api/v1/contributions");
      const envelope = JSON.parse(options.body);
      assert.equal(envelope.synthetic, true);
      assert.equal(envelope.keyId, "key:synthetic-smoke");
      return response({ error: { code: "ENVELOPE_INVALID", requestId: "synthetic" } }, 400);
    },
  });
  assert.deepEqual(result, {
    health: "ready",
    routeBoundary: "synthetic_invalid_envelope_rejected",
    validRouteSmoke: "not_tested_requires_cloud_run_and_device_tokens",
    writesAttempted: false,
  });
  assert.deepEqual(calls.map((call) => call.path), ["/api/health", "/api/v1/contributions"]);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.redirect, "error");
  assert.equal(calls[1].options.headers.authorization,
    "Bearer synthetic-identity-token-placeholder");
});

test("smoke rejects redirects and malformed health receipts", async () => {
  await assert.rejects(runSyntheticRouteBoundarySmoke({
    serviceUrl: "https://test-service.example.invalid",
    token: "synthetic-identity-token-placeholder",
    fetchImpl: async () => new Response(null, { status: 302 }),
  }), (error) => error.code === "GCP_PRIVATE_TEST_SMOKE_RESPONSE_HEADERS_INVALID");

  await assert.rejects(runSyntheticRouteBoundarySmoke({
    serviceUrl: "https://test-service.example.invalid",
    token: "synthetic-identity-token-placeholder",
    fetchImpl: async () => new Response(JSON.stringify({ status: "ready" }), {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    }),
  }), (error) => error.code === "GCP_PRIVATE_TEST_HEALTH_SMOKE_FAILED");
});
