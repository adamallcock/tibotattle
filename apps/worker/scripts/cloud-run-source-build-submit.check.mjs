import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GCP_PRIVATE_TEST_BUILD,
  GCP_PRIVATE_TEST_TARGET,
} from "./gcp-private-test-deploy.mjs";
import { createCloudRunBuildArchive } from "./cloud-run-build-archive.mjs";
import { submitCloudRunSourceBuild } from "./cloud-run-source-build-submit.mjs";

const sourceGeneration = "1733521432198765";
const buildId = "12345678-abcd-efab-1234-1234567890ab";

async function preparedSubmission() {
  const scratch = await mkdtemp(join(tmpdir(), "cloud-run-source-submit-"));
  const archivePath = join(scratch, "reviewed source.tar.gz");
  const buildConfigPath = archivePath + ".cloudbuild.yaml";
  const archive = await createCloudRunBuildArchive();
  await writeFile(archivePath, archive.bytes, { flag: "wx", mode: 0o600 });
  await writeFile(buildConfigPath, archive.cloudBuildConfigBytes, { flag: "wx", mode: 0o600 });
  const config = Object.freeze({
    archivePath,
    archiveSha256: archive.sourceArchiveSha256,
    sourceDigest: archive.sourceContentDigest,
    sourceBucket: GCP_PRIVATE_TEST_TARGET.buildBucket,
    sourceObject: GCP_PRIVATE_TEST_BUILD.sourceObjectPrefix
      + archive.sourceContentDigest + "-" + archive.sourceArchiveSha256 + ".tar.gz",
    sourceGeneration,
    buildConfigPath,
    buildConfigSha256: archive.cloudBuildConfigSha256,
  });
  return { scratch, archive, config };
}

function operationFixture(config, overrides = {}) {
  const build = {
    name: `projects/${GCP_PRIVATE_TEST_TARGET.project}/locations/${GCP_PRIVATE_TEST_TARGET.region}/builds/${buildId}`,
    id: buildId,
    projectId: GCP_PRIVATE_TEST_TARGET.project,
    status: "QUEUED",
    source: { storageSource: {
      bucket: config.sourceBucket,
      object: config.sourceObject,
      generation: config.sourceGeneration,
    } },
    steps: [{
      name: GCP_PRIVATE_TEST_BUILD.dockerBuilderImage,
      args: [
        "build",
        "--file=apps/worker/cloud-run/Dockerfile",
        "--tag=" + GCP_PRIVATE_TEST_BUILD.imageTag,
        ".",
      ],
    }],
    timeout: "1200s",
    images: [GCP_PRIVATE_TEST_BUILD.imageTag],
    serviceAccount: GCP_PRIVATE_TEST_BUILD.serviceAccount,
    options: {
      logging: "CLOUD_LOGGING_ONLY",
      sourceProvenanceHash: ["SHA256"],
      requestedVerifyOption: "VERIFIED",
    },
    substitutions: { _IMAGE: GCP_PRIVATE_TEST_BUILD.imageTag },
    queueTtl: "3600s",
    ...overrides.build,
  };
  return {
    name: `operations/build/${GCP_PRIVATE_TEST_TARGET.project}/${buildId}`,
    metadata: {
      "@type": "type.googleapis.com/google.devtools.cloudbuild.v1.BuildOperationMetadata",
      build,
    },
    ...overrides.operation,
  };
}

function successfulDependencies(config, operation, observations) {
  return {
    config,
    archiveBuilder: async () => observations.archive,
    spawn: (command, args, options) => {
      observations.spawnCalls.push({ command, args, options });
      return { status: 0, stdout: "ya29.synthetic-access-token\n", stderr: "" };
    },
    fetchImpl: async (url, options) => {
      observations.requests.push({ url, options });
      return new Response(JSON.stringify(operation), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

test("source-only submit sends the exact regional Build request and returns sanitized IDs", async () => {
  const prepared = await preparedSubmission();
  try {
    const observations = { archive: prepared.archive, spawnCalls: [], requests: [] };
    const operation = operationFixture(prepared.config);
    const result = await submitCloudRunSourceBuild(successfulDependencies(
      prepared.config,
      operation,
      observations,
    ));
    assert.deepEqual(result, {
      status: "submitted",
      buildId,
      operationName: operation.name,
    });
    assert.equal(JSON.stringify(result).includes("synthetic-access-token"), false);
    assert.equal(observations.spawnCalls.length, 1);
    assert.equal(observations.spawnCalls[0].command, "gcloud");
    assert.deepEqual(observations.spawnCalls[0].args, ["auth", "print-access-token"]);
    assert.equal(observations.spawnCalls[0].options.stdio[2], "ignore");
    assert.equal(observations.requests.length, 1);
    const [{ url, options }] = observations.requests;
    assert.equal(url,
      "https://cloudbuild.googleapis.com/v1/projects/tibotattle/locations/us-east1/builds?projectId=tibotattle");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, "Bearer ya29.synthetic-access-token");
    const body = JSON.parse(options.body);
    assert.deepEqual(body, {
      source: { storageSource: {
        bucket: prepared.config.sourceBucket,
        object: prepared.config.sourceObject,
        generation: prepared.config.sourceGeneration,
      } },
      steps: [{
        name: GCP_PRIVATE_TEST_BUILD.dockerBuilderImage,
        args: [
          "build",
          "--file=apps/worker/cloud-run/Dockerfile",
          "--tag=${_IMAGE}",
          ".",
        ],
      }],
      images: ["${_IMAGE}"],
      options: {
        logging: "CLOUD_LOGGING_ONLY",
        sourceProvenanceHash: ["SHA256"],
        requestedVerifyOption: "VERIFIED",
      },
      serviceAccount: GCP_PRIVATE_TEST_BUILD.serviceAccount,
      substitutions: { _IMAGE: GCP_PRIVATE_TEST_BUILD.imageTag },
      timeout: "1200s",
    });
  } finally {
    await rm(prepared.scratch, { recursive: true, force: true });
  }
});

test("source-only submit rejects local archive or reviewed-config mismatch before OAuth or API request", async () => {
  const prepared = await preparedSubmission();
  try {
    const observations = { archive: prepared.archive, spawnCalls: [], requests: [] };
    await assert.rejects(submitCloudRunSourceBuild(successfulDependencies(
      { ...prepared.config, buildConfigSha256: "d".repeat(64) },
      operationFixture(prepared.config),
      observations,
    )), (error) => error.code === "CLOUD_BUILD_SOURCE_INPUTS_UNQUALIFIED");
    assert.deepEqual(observations.spawnCalls, []);
    assert.deepEqual(observations.requests, []);

    const alteredConfigBytes = Buffer.from(await readFile(prepared.config.buildConfigPath));
    alteredConfigBytes[0] ^= 1;
    await writeFile(prepared.config.buildConfigPath, alteredConfigBytes);
    await assert.rejects(submitCloudRunSourceBuild(successfulDependencies(
      prepared.config,
      operationFixture(prepared.config),
      observations,
    )), (error) => error.code === "CLOUD_BUILD_SOURCE_ARCHIVE_OR_CONFIG_MISMATCH");
    assert.deepEqual(observations.spawnCalls, []);
    assert.deepEqual(observations.requests, []);
  } finally {
    await rm(prepared.scratch, { recursive: true, force: true });
  }
});

test("source-only submit rejects unexpected API source identity and HTTP errors without leaking response text", async () => {
  const prepared = await preparedSubmission();
  try {
    const mismatchedOperation = operationFixture(prepared.config, {
      build: { source: { storageSource: {
        bucket: prepared.config.sourceBucket,
        object: prepared.config.sourceObject,
        generation: "1",
      } } },
    });
    const observations = { archive: prepared.archive, spawnCalls: [], requests: [] };
    await assert.rejects(submitCloudRunSourceBuild(successfulDependencies(
      prepared.config,
      mismatchedOperation,
      observations,
    )), (error) => error.code === "CLOUD_BUILD_SOURCE_CREATE_RESPONSE_UNEXPECTED");
    assert.equal(observations.requests.length, 1);

    const rejected = await assert.rejects(submitCloudRunSourceBuild({
      ...successfulDependencies(prepared.config, {}, observations),
      fetchImpl: async () => new Response("private server detail", { status: 403 }),
    }), (error) => error.code === "CLOUD_BUILD_SOURCE_CREATE_REJECTED");
    assert.equal(String(rejected).includes("private server detail"), false);
  } finally {
    await rm(prepared.scratch, { recursive: true, force: true });
  }
});
