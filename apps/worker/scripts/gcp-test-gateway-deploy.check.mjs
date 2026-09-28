import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  GCP_PRIVATE_TEST_BUILD,
  GCP_PRIVATE_TEST_TARGET,
} from "./gcp-private-test-deploy.mjs";
import {
  GCP_TEST_GATEWAY_STAGE_TAG,
  GCP_TEST_GATEWAY_TARGET,
  assessGatewayReadback,
  parseArgs,
  runGcpTestGatewayDeployment,
  validateConfig,
} from "./gcp-test-gateway-deploy.mjs";

const sourceDigest = "a".repeat(64);
const archiveBytes = Buffer.from("synthetic source archive bytes");
const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
const imageDigest = "b".repeat(64);
const previousImageDigest = "c".repeat(64);
const image = GCP_PRIVATE_TEST_TARGET.imageRepository + "@sha256:" + imageDigest;
const previousImage = GCP_PRIVATE_TEST_TARGET.imageRepository + "@sha256:" + previousImageDigest;
const oldRevision = "tibotattle-test-oauth-gateway-00005-qj2";
const newRevision = "tibotattle-test-oauth-gateway-00006-xyz";
const buildId = "12345678-abcd-efab-1234-1234567890ab";
const sourceGeneration = "1733521432198765";
const sourceObject = GCP_PRIVATE_TEST_BUILD.sourceObjectPrefix
  + sourceDigest + "-" + archiveSha256 + ".tar.gz";
const sourceUri = `gs://${GCP_PRIVATE_TEST_TARGET.buildBucket}/${sourceObject}#${sourceGeneration}`;
const imageTag = GCP_PRIVATE_TEST_BUILD.imageTag;
const digestArray = GCP_PRIVATE_TEST_BUILD.dockerBuilderImage.slice(
  "gcr.io/cloud-builders/docker@".length,
);
const gatewayLogFilter = 'resource.type="cloud_run_revision" AND resource.labels.service_name="tibotattle-test-oauth-gateway" AND log_id("run.googleapis.com/requests")';
const testDirectory = await mkdtemp(join(tmpdir(), "gcp-test-gateway-deploy-"));
const archivePath = join(testDirectory, "source.tar.gz");
await writeFile(archivePath, archiveBytes, { flag: "wx", mode: 0o600 });
after(async () => rm(testDirectory, { recursive: true, force: true }));

function provenanceConfig(overrides = {}) {
  return {
    command: "deploy",
    project: GCP_TEST_GATEWAY_TARGET.project,
    region: GCP_TEST_GATEWAY_TARGET.region,
    service: GCP_TEST_GATEWAY_TARGET.service,
    image,
    sourceDigest,
    buildId,
    sourceArchivePath: archivePath,
    sourceArchiveSha256: archiveSha256,
    sourceBucket: GCP_PRIVATE_TEST_TARGET.buildBucket,
    sourceObject,
    sourceGeneration,
    confirmation: GCP_TEST_GATEWAY_TARGET.service,
    ...overrides,
  };
}

function revisionFixture({
  name = oldRevision,
  imageValue = previousImage,
  serviceAccount = GCP_TEST_GATEWAY_TARGET.runtimeServiceAccount,
  envOverrides = {},
  additionalEnvironment = [],
  ready = "True",
  readyReason,
} = {}) {
  const environment = {
    OAUTH_GATEWAY_MODE: "test-only",
    OAUTH_GATEWAY_PUBLIC_ORIGIN: GCP_TEST_GATEWAY_TARGET.publicOrigin,
    OAUTH_GATEWAY_BACKEND_ORIGIN: GCP_TEST_GATEWAY_TARGET.backendOrigin,
    OAUTH_GATEWAY_BACKEND_AUDIENCE: GCP_TEST_GATEWAY_TARGET.backendOrigin,
    ...envOverrides,
  };
  return {
    metadata: {
      name,
      labels: { "serving.knative.dev/service": GCP_TEST_GATEWAY_TARGET.service },
    },
    spec: {
      serviceAccountName: serviceAccount,
      containers: [{
        image: imageValue,
        env: [
          ...Object.entries(environment).map(([key, value]) => ({ name: key, value })),
          ...additionalEnvironment,
        ],
      }],
    },
    status: { conditions: [{ type: "Ready", status: ready, ...(readyReason ? { reason: readyReason } : {}) }] },
  };
}

function serviceFixture({
  readyRevision = oldRevision,
  createdRevision = oldRevision,
  traffic = [{ revisionName: oldRevision, percent: 100, latestRevision: true }],
  templateImage = previousImage,
  ingressValue = "all",
  generation = 47,
  observedGeneration = 47,
  iamDisabled = false,
} = {}) {
  return {
    metadata: {
      name: GCP_TEST_GATEWAY_TARGET.service,
      generation,
      annotations: {
        "run.googleapis.com/ingress": ingressValue,
        "run.googleapis.com/invoker-iam-disabled": String(iamDisabled),
      },
    },
    spec: {
      template: {
        spec: {
          serviceAccountName: GCP_TEST_GATEWAY_TARGET.runtimeServiceAccount,
          containers: [{ image: templateImage }],
        },
      },
    },
    status: {
      latestReadyRevisionName: readyRevision,
      latestCreatedRevisionName: createdRevision,
      observedGeneration,
      traffic,
      conditions: [{ type: "Ready", status: "True" }],
    },
  };
}

function policyFixture() {
  return { bindings: [{ role: "roles/run.invoker", members: ["allUsers"] }] };
}

function sinkFixture() {
  return {
    name: GCP_TEST_GATEWAY_TARGET.logSink,
    exclusions: [{
      name: GCP_TEST_GATEWAY_TARGET.logExclusionName,
      filter: gatewayLogFilter,
    }],
  };
}

function buildFixture() {
  return {
    id: buildId,
    name: `projects/${GCP_TEST_GATEWAY_TARGET.project}/locations/${GCP_TEST_GATEWAY_TARGET.region}/builds/${buildId}`,
    projectId: GCP_TEST_GATEWAY_TARGET.project,
    status: "SUCCESS",
    serviceAccount: GCP_PRIVATE_TEST_BUILD.serviceAccount,
    source: { storageSource: {
      bucket: GCP_PRIVATE_TEST_TARGET.buildBucket,
      object: sourceObject,
      generation: sourceGeneration,
    } },
    sourceProvenance: {
      resolvedStorageSource: {
        bucket: GCP_PRIVATE_TEST_TARGET.buildBucket,
        object: sourceObject,
        generation: sourceGeneration,
      },
      fileHashes: { [sourceUri]: { fileHash: [
        { type: "SHA256", value: Buffer.from(archiveSha256, "hex").toString("base64url") },
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
      args: ["build", "--file=apps/worker/cloud-run/Dockerfile", "--tag=" + imageTag, "."],
      status: "SUCCESS",
    }],
    timeout: "1200s",
    queueTtl: "3600s",
    artifacts: { images: [imageTag] },
    substitutions: { _IMAGE: imageTag },
    images: [imageTag],
    results: {
      buildStepImages: [digestArray],
      buildStepOutputs: [""],
      images: [{ name: imageTag, digest: "sha256:" + imageDigest }],
    },
  };
}

function makeDeploymentHarness({
  failAfterTrafficSwitch = false,
  failNoTrafficUpdateBeforeMutation = false,
  failNoTrafficUpdateAfterMutation = false,
  candidateReadyAfterReads = 2,
  unrelatedRevisionAtPoll = null,
  initialService,
  initialCandidate,
} = {}) {
  const calls = [];
  const revisions = new Map([[oldRevision, revisionFixture()]]);
  if (initialCandidate) revisions.set(newRevision, initialCandidate);
  const state = {
    service: initialService ?? serviceFixture(),
    policy: policyFixture(),
    sink: sinkFixture(),
    failAfterTrafficSwitch,
  };
  let candidateReads = 0;
  let serviceReadsAfterStage = 0;
  const spawn = (command, args) => {
    calls.push({ command, args });
    if (args[0] === "builds" && args[1] === "describe") {
      return { status: 0, stdout: JSON.stringify(buildFixture()), stderr: "" };
    }
    if (args[0] === "run" && args[1] === "services" && args[2] === "describe") {
      if (state.service.status.latestCreatedRevisionName === newRevision
          && state.service.status.traffic.some((entry) => entry.tag === GCP_TEST_GATEWAY_STAGE_TAG)) {
        serviceReadsAfterStage += 1;
        if (unrelatedRevisionAtPoll === serviceReadsAfterStage) {
          state.service.status.latestCreatedRevisionName = "tibotattle-test-oauth-gateway-00007-abc";
        }
      }
      return { status: 0, stdout: JSON.stringify(state.service), stderr: "" };
    }
    if (args[0] === "run" && args[1] === "services" && args[2] === "get-iam-policy") {
      return { status: 0, stdout: JSON.stringify(state.policy), stderr: "" };
    }
    if (args[0] === "logging" && args[1] === "sinks" && args[2] === "describe") {
      return { status: 0, stdout: JSON.stringify(state.sink), stderr: "" };
    }
    if (args[0] === "run" && args[1] === "revisions" && args[2] === "describe") {
      let revision = revisions.get(args[3]);
      if (args[3] === newRevision && !initialCandidate) {
        candidateReads += 1;
        if (candidateReadyAfterReads === null || candidateReads < candidateReadyAfterReads) {
          revision = revisionFixture({ name: newRevision, imageValue: image, ready: "False" });
        } else {
          revision = revisionFixture({ name: newRevision, imageValue: image });
        }
      }
      return { status: revision ? 0 : 1, stdout: JSON.stringify(revision ?? {}), stderr: "" };
    }
    if (args[0] === "run" && args[1] === "services" && args[2] === "update") {
      assert.equal(args[3], GCP_TEST_GATEWAY_TARGET.service);
      const imageArgument = args.find((value) => value.startsWith("--image="));
      assert.equal(args.includes("--no-traffic"), true);
      if (imageArgument === "--image=" + previousImage) {
        state.service.spec.template.spec.containers[0].image = previousImage;
        state.service.metadata.generation += 1;
        state.service.status.observedGeneration = state.service.metadata.generation;
        state.service.status.latestCreatedRevisionName = "tibotattle-test-oauth-gateway-00007-rst";
        state.service.status.latestReadyRevisionName = oldRevision;
        revisions.set("tibotattle-test-oauth-gateway-00007-rst", revisionFixture({
          name: "tibotattle-test-oauth-gateway-00007-rst",
          imageValue: previousImage,
        }));
        return { status: 0, stdout: "", stderr: "" };
      }
      assert.equal(imageArgument, "--image=" + image);
      if (failNoTrafficUpdateBeforeMutation) return { status: 1, stdout: "", stderr: "" };
      state.service = serviceFixture({
        readyRevision: oldRevision,
        createdRevision: newRevision,
        traffic: [
          { revisionName: oldRevision, percent: 100 },
          { revisionName: newRevision, tag: GCP_TEST_GATEWAY_STAGE_TAG },
        ],
        templateImage: image,
        generation: 48,
        observedGeneration: 48,
      });
      revisions.set(newRevision, revisionFixture({
        name: newRevision,
        imageValue: image,
        ready: "False",
      }));
      return { status: failNoTrafficUpdateAfterMutation ? 1 : 0, stdout: "", stderr: "" };
    }
    if (args[0] === "run" && args[1] === "services" && args[2] === "update-traffic") {
      const updateTag = args.find((value) => value.startsWith("--update-tags="));
      if (updateTag) {
        const assignment = updateTag.slice("--update-tags=".length);
        const [tag, revision] = assignment.split("=");
        const existing = state.service.status.traffic.filter((entry) => entry.tag !== tag);
        state.service.status.traffic = [...existing, { revisionName: revision, percent: 0, tag }];
        state.service.metadata.generation += 1;
        state.service.status.observedGeneration = state.service.metadata.generation;
        const candidate = revisions.get(revision);
        if (candidate?.status?.conditions?.[0]?.reason === "Retired") {
          candidate.status.conditions[0] = { type: "Ready", status: "True" };
        }
        return { status: 0, stdout: "", stderr: "" };
      }
      const removeTags = args.find((value) => value.startsWith("--remove-tags="));
      if (removeTags) {
        const removedTag = removeTags.slice("--remove-tags=".length);
        state.service.status.traffic = state.service.status.traffic
          .filter((entry) => entry.tag !== removedTag);
      }
      const target = args.find((value) => value.startsWith("--to-revisions="))
        ?.slice("--to-revisions=".length);
      const targetRevision = target?.split("=")[0];
      if (target) {
        const [name, percent] = target.split("=");
        assert.equal(percent, "100");
        state.service.status.traffic = state.service.status.traffic
          .filter((entry) => entry.tag)
          .concat([{ revisionName: name, percent: 100 }]);
      }
      if (targetRevision === newRevision && state.failAfterTrafficSwitch) {
        state.policy = { bindings: [{ role: "roles/run.invoker", members: ["user:tampered"] }] };
      } else if (target?.startsWith(oldRevision + "=")) {
        state.policy = policyFixture();
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error("Unexpected mocked command");
  };
  const latestReadyRevisionName = (service) =>
    service.status.latestReadyRevisionName;
  return { calls, revisions, state, spawn };
}

function runDeployment(options) {
  return runGcpTestGatewayDeployment({
    sleepFn: async () => {},
    pollAttempts: 4,
    pollIntervalMs: 0,
    ...options,
  });
}

test("target, image, provenance, and explicit deployment confirmation are fixed", () => {
  assert.equal(GCP_TEST_GATEWAY_TARGET.project, "tibotattle");
  assert.equal(GCP_TEST_GATEWAY_TARGET.region, "us-east1");
  assert.equal(GCP_TEST_GATEWAY_TARGET.service, "tibotattle-test-oauth-gateway");
  assert.throws(() => validateConfig(provenanceConfig({ confirmation: "" })),
    (error) => error.code === "GCP_GATEWAY_DEPLOY_CONFIRMATION_REQUIRED");
  assert.throws(() => validateConfig(provenanceConfig({ image: "repo:latest" })),
    (error) => error.code === "GCP_GATEWAY_IMAGE_DIGEST_REQUIRED");
  assert.throws(() => validateConfig(provenanceConfig({ sourceBucket: "other" })),
    (error) => error.code === "GCP_GATEWAY_SOURCE_BUCKET_UNEXPECTED");
  assert.throws(() => parseArgs(["deploy", "--service=production"]),
    (error) => error.code === "GCP_GATEWAY_ARGUMENT_INVALID");
  assert.throws(() => parseArgs([
    "deploy",
    "--image=" + image,
    "--source-digest=" + sourceDigest,
    "--build-id=" + buildId,
    "--source-archive=" + archivePath,
    "--source-archive-sha256=" + archiveSha256,
    "--source-bucket=" + GCP_PRIVATE_TEST_TARGET.buildBucket,
    "--source-object=" + sourceObject,
    "--source-generation=" + sourceGeneration,
    "--confirm-test-gateway-deploy=wrong",
  ]),
    (error) => error.code === "GCP_GATEWAY_DEPLOY_CONFIRMATION_REQUIRED");
  assert.throws(() => parseArgs(["preflight", "--image=" + image]),
    (error) => error.code === "GCP_GATEWAY_PREFLIGHT_READ_ONLY_ARGUMENTS_INVALID");
  assert.deepEqual(parseArgs(["preflight"]), {
    command: "preflight",
    project: GCP_TEST_GATEWAY_TARGET.project,
    region: GCP_TEST_GATEWAY_TARGET.region,
    service: GCP_TEST_GATEWAY_TARGET.service,
    image: "",
    sourceDigest: "",
    buildId: "",
    sourceArchivePath: "",
    sourceArchiveSha256: "",
    sourceBucket: "",
    sourceObject: "",
    sourceGeneration: "",
    confirmation: "",
  });
});

test("gateway readback qualifies the active 100% revision and matching service template", () => {
  const service = serviceFixture();
  const revision = revisionFixture();
  const assessment = assessGatewayReadback({
    service,
    policy: policyFixture(),
    sink: sinkFixture(),
    revision,
    expectedImage: previousImage,
  });
  assert.deepEqual(assessment, {
    ok: true,
    blockers: [],
    revision: oldRevision,
    image: previousImage,
  });
});

test("stage-tag readback accepts omitted zero allocation and rejects positive allocation", () => {
  const base = {
    policy: policyFixture(),
    sink: sinkFixture(),
    revision: revisionFixture({ name: newRevision, imageValue: image }),
    expectedImage: image,
    expectedTemplateImage: image,
    expectedTrafficRevision: oldRevision,
    expectedStageTagRevision: newRevision,
  };
  const omittedPercent = assessGatewayReadback({
    ...base,
    service: serviceFixture({
      createdRevision: newRevision,
      traffic: [
        { revisionName: oldRevision, percent: 100 },
        { revisionName: newRevision, tag: GCP_TEST_GATEWAY_STAGE_TAG },
      ],
      templateImage: image,
      generation: 48,
      observedGeneration: 48,
    }),
  });
  assert.equal(omittedPercent.ok, true, JSON.stringify(omittedPercent));
  const positivePercent = assessGatewayReadback({
    ...base,
    service: serviceFixture({
      createdRevision: newRevision,
      traffic: [
        { revisionName: oldRevision, percent: 90 },
        { revisionName: newRevision, percent: 10, tag: GCP_TEST_GATEWAY_STAGE_TAG },
      ],
      templateImage: image,
      generation: 48,
      observedGeneration: 48,
    }),
  });
  assert.equal(positivePercent.ok, false);
  assert.ok(positivePercent.blockers.includes("GCP_GATEWAY_TRAFFIC_REVISION_UNQUALIFIED"));
  assert.ok(positivePercent.blockers.includes("GCP_GATEWAY_STAGE_TAG_STATE_UNQUALIFIED"));
});

test("gateway readback fails closed on changed IAM, ingress, origins, runtime account, image, or log exclusion", () => {
  const base = {
    service: serviceFixture(),
    policy: policyFixture(),
    sink: sinkFixture(),
    revision: revisionFixture(),
    expectedImage: previousImage,
  };
  const changedSinkFilter = sinkFixture();
  changedSinkFilter.exclusions[0].filter += ' AND severity="ERROR"';
  const disabledSink = sinkFixture();
  disabledSink.exclusions[0].disabled = true;
  const secretMarker = "synthetic-secret-value-must-not-appear";
  const cases = [
    ["private ingress", { service: serviceFixture({ ingressValue: "internal" }) }, "GCP_GATEWAY_PUBLIC_INGRESS_UNQUALIFIED"],
    ["IAM without allUsers", { policy: { bindings: [{ role: "roles/run.invoker", members: ["user:test"] }] } }, "GCP_GATEWAY_PUBLIC_IAM_UNQUALIFIED"],
    ["additional public IAM role", { policy: { bindings: [
      { role: "roles/run.invoker", members: ["allUsers"] },
      { role: "roles/editor", members: ["allUsers"] },
    ] } }, "GCP_GATEWAY_PUBLIC_IAM_UNQUALIFIED"],
    ["unreviewed restricted IAM binding", { policy: { bindings: [
      { role: "roles/run.invoker", members: ["allUsers"] },
      { role: "roles/logging.viewer", members: ["user:test"] },
    ] } }, "GCP_GATEWAY_PUBLIC_IAM_UNQUALIFIED"],
    ["disabled invoker check", { service: serviceFixture({ iamDisabled: true }) }, "GCP_GATEWAY_PUBLIC_IAM_UNQUALIFIED"],
    ["wrong public origin", { revision: revisionFixture({ envOverrides: {
      OAUTH_GATEWAY_PUBLIC_ORIGIN: "https://wrong.example",
    } }) }, "GCP_GATEWAY_ENVIRONMENT_UNQUALIFIED"],
    ["wrong backend origin", { revision: revisionFixture({ envOverrides: {
      OAUTH_GATEWAY_BACKEND_ORIGIN: "https://wrong.example",
    } }) }, "GCP_GATEWAY_ENVIRONMENT_UNQUALIFIED"],
    ["wrong backend audience", { revision: revisionFixture({ envOverrides: {
      OAUTH_GATEWAY_BACKEND_AUDIENCE: "https://wrong.example",
    } }) }, "GCP_GATEWAY_ENVIRONMENT_UNQUALIFIED"],
    ["unexpected environment toggle", { revision: revisionFixture({
      additionalEnvironment: [{ name: "OAUTH_GATEWAY_ALLOW_UNLISTED", value: "true" }],
    }) }, "GCP_GATEWAY_ENVIRONMENT_UNQUALIFIED"],
    ["unexpected secret reference", { revision: revisionFixture({
      additionalEnvironment: [{
        name: "OAUTH_GATEWAY_SECRET",
        valueSource: { secretKeyRef: { secret: "synthetic-secret", version: "1" } },
      }],
    }) }, "GCP_GATEWAY_ENVIRONMENT_UNQUALIFIED"],
    ["unexpected credential value", { revision: revisionFixture({
      additionalEnvironment: [{ name: "OAUTH_GATEWAY_SECRET", value: secretMarker }],
    }) }, "GCP_GATEWAY_ENVIRONMENT_UNQUALIFIED"],
    ["wrong runtime identity", { revision: revisionFixture({ serviceAccount: "other@example.invalid" }) }, "GCP_GATEWAY_RUNTIME_ACCOUNT_UNQUALIFIED"],
    ["mutable image", { revision: revisionFixture({ imageValue: imageTag }) }, "GCP_GATEWAY_IMAGE_DIGEST_UNQUALIFIED"],
    ["wrong image digest", { revision: revisionFixture({ imageValue: image }) }, "GCP_GATEWAY_IMAGE_DIGEST_UNQUALIFIED"],
    ["missing request log exclusion", { sink: { name: "_Default", exclusions: [] } }, "GCP_GATEWAY_REQUEST_LOG_EXCLUSION_UNQUALIFIED"],
    ["disabled request log exclusion", { sink: disabledSink }, "GCP_GATEWAY_REQUEST_LOG_EXCLUSION_UNQUALIFIED"],
    ["broadened request log exclusion", { sink: changedSinkFilter }, "GCP_GATEWAY_REQUEST_LOG_EXCLUSION_UNQUALIFIED"],
    ["split traffic", { service: serviceFixture({ traffic: [
      { revisionName: oldRevision, percent: 90 },
      { revisionName: "other-revision", percent: 10 },
    ] }) }, "GCP_GATEWAY_TRAFFIC_REVISION_UNQUALIFIED"],
    ["service template differs from serving revision", { service: serviceFixture({
      templateImage: image,
    }) }, "GCP_GATEWAY_SERVICE_TEMPLATE_IMAGE_MISMATCH"],
  ];
  for (const [label, overrides, expectedBlocker] of cases) {
    const assessment = assessGatewayReadback({ ...base, ...overrides });
    assert.equal(assessment.ok, false, label);
    assert.ok(assessment.blockers.includes(expectedBlocker), `${label}: ${assessment.blockers}`);
    assert.equal(JSON.stringify(assessment).includes(secretMarker), false);
  }
});

test("deploy polls the exact tagged candidate while preserving old traffic, then switches and removes the tag", async () => {
  const harness = makeDeploymentHarness();
  const result = await runDeployment({
    config: provenanceConfig(),
    spawn: harness.spawn,
    archiveBuilder: async () => ({
      sourceContentDigest: sourceDigest,
      sourceArchiveSha256: archiveSha256,
      cloudBuildConfigSha256: GCP_PRIVATE_TEST_BUILD.cloudBuildConfigSha256,
    }),
  });
  assert.equal(result.status, "deployed", JSON.stringify(result));
  assert.deepEqual(result.blockers, []);
  assert.equal(result.deployedRevision, newRevision);
  assert.equal(result.rollbackRevision, oldRevision);
  assert.equal(result.rollbackImage, previousImage);
  assert.equal(result.routeSmoke, "not_run_application_device_token_required");
  const updateIndex = harness.calls.findIndex(({ args }) =>
    args[0] === "run" && args[1] === "services" && args[2] === "update",
  );
  const trafficIndex = harness.calls.findIndex(({ args }) =>
    args[0] === "run" && args[1] === "services" && args[2] === "update-traffic",
  );
  assert.ok(updateIndex >= 0 && trafficIndex > updateIndex);
  const updateArgs = harness.calls[updateIndex].args;
  assert.deepEqual(updateArgs, [
    "run", "services", "update", GCP_TEST_GATEWAY_TARGET.service,
    "--image=" + image,
    "--no-traffic",
    "--tag=" + GCP_TEST_GATEWAY_STAGE_TAG,
    "--project=" + GCP_TEST_GATEWAY_TARGET.project,
    "--region=" + GCP_TEST_GATEWAY_TARGET.region,
    "--quiet",
  ]);
  assert.equal(updateArgs.some((value) => /(?:env-vars|service-account|ingress|allow-unauthenticated)/u.test(value)), false);
  assert.equal(harness.calls[trafficIndex].args.includes("--to-revisions=" + newRevision + "=100"), true);
  assert.equal(harness.calls[trafficIndex].args.includes("--remove-tags=" + GCP_TEST_GATEWAY_STAGE_TAG), true);
  assert.ok(harness.calls.filter(({ args }) => args[0] === "run" && args[1] === "revisions"
    && args[2] === "describe" && args[3] === newRevision).length >= 2);
  assert.equal(harness.state.service.spec.template.spec.containers[0].image, image);
  assert.deepEqual(harness.state.service.status.traffic, [{ revisionName: newRevision, percent: 100 }]);
  assert.equal(harness.calls.some(({ args }) => args[0] === "run" && args[1] === "deploy"), false);
});

test("failed post-switch IAM readback restores the exact captured revision to 100%", async () => {
  const harness = makeDeploymentHarness({ failAfterTrafficSwitch: true });
  const result = await runDeployment({
    config: provenanceConfig(),
    spawn: harness.spawn,
    archiveBuilder: async () => ({
      sourceContentDigest: sourceDigest,
      sourceArchiveSha256: archiveSha256,
      cloudBuildConfigSha256: GCP_PRIVATE_TEST_BUILD.cloudBuildConfigSha256,
    }),
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes("GCP_GATEWAY_POSTDEPLOY_READBACK_UNQUALIFIED"));
  assert.equal(result.rollback.ok, true, JSON.stringify(result.rollback));
  assert.equal(result.rollback.templateRestored, true);
  assert.equal(result.rollback.stageTagRemoved, true);
  assert.equal(result.rollback.revision, oldRevision);
  assert.equal(harness.state.service.spec.template.spec.containers[0].image, previousImage);
  const trafficCalls = harness.calls.filter(({ args }) =>
    args[0] === "run" && args[1] === "services" && args[2] === "update-traffic",
  );
  assert.deepEqual(trafficCalls.map(({ args }) =>
    args.find((value) => value.startsWith("--to-revisions=")),
  ), [
    "--to-revisions=" + newRevision + "=100",
    "--to-revisions=" + oldRevision + "=100",
  ]);
});

test("failed no-traffic command without a revision mutation does not issue rollback", async () => {
  const harness = makeDeploymentHarness({ failNoTrafficUpdateBeforeMutation: true });
  const result = await runDeployment({
    config: provenanceConfig(),
    spawn: harness.spawn,
    archiveBuilder: async () => ({
      sourceContentDigest: sourceDigest,
      sourceArchiveSha256: archiveSha256,
      cloudBuildConfigSha256: GCP_PRIVATE_TEST_BUILD.cloudBuildConfigSha256,
    }),
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.rollback.attempted, false);
  assert.equal(result.rollback.ok, true);
  assert.equal(harness.calls.some(({ args }) => args[0] === "run"
    && args[1] === "services" && args[2] === "update-traffic"), false);
});

test("failed no-traffic command after revision creation restores the captured traffic", async () => {
  const harness = makeDeploymentHarness({ failNoTrafficUpdateAfterMutation: true });
  const result = await runDeployment({
    config: provenanceConfig(),
    spawn: harness.spawn,
    archiveBuilder: async () => ({
      sourceContentDigest: sourceDigest,
      sourceArchiveSha256: archiveSha256,
      cloudBuildConfigSha256: GCP_PRIVATE_TEST_BUILD.cloudBuildConfigSha256,
    }),
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.rollback.attempted, true);
  assert.equal(result.rollback.ok, true, JSON.stringify(result.rollback));
  assert.equal(result.rollback.templateRestored, true);
  assert.equal(harness.state.service.spec.template.spec.containers[0].image, previousImage);
  const trafficCalls = harness.calls.filter(({ args }) =>
    args[0] === "run" && args[1] === "services" && args[2] === "update-traffic",
  );
  assert.deepEqual(trafficCalls.map(({ args }) =>
    args.find((value) => value.startsWith("--to-revisions=")),
  ), ["--to-revisions=" + oldRevision + "=100"]);
});

test("unqualified predeploy IAM refuses before creating a revision", async () => {
  const harness = makeDeploymentHarness();
  harness.state.policy = { bindings: [] };
  const result = await runDeployment({
    config: provenanceConfig(),
    spawn: harness.spawn,
    archiveBuilder: async () => ({
      sourceContentDigest: sourceDigest,
      sourceArchiveSha256: archiveSha256,
      cloudBuildConfigSha256: GCP_PRIVATE_TEST_BUILD.cloudBuildConfigSha256,
    }),
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.preDeployReadOnlyAssessment, true);
  assert.equal(harness.calls.some(({ args }) => args[0] === "run" && args[1] === "services"
    && (args[2] === "update" || args[2] === "update-traffic")), false);
});

test("Cloud Build image mismatch blocks before live service reads or mutation", async () => {
  const calls = [];
  const result = await runDeployment({
    config: provenanceConfig(),
    spawn: (command, args) => {
      calls.push({ command, args });
      if (args[0] === "builds" && args[1] === "describe") {
        const build = buildFixture();
        build.results.images[0].digest = "sha256:" + "d".repeat(64);
        return { status: 0, stdout: JSON.stringify(build), stderr: "" };
      }
      throw new Error("service read should not occur");
    },
    archiveBuilder: async () => ({
      sourceContentDigest: sourceDigest,
      sourceArchiveSha256: archiveSha256,
      cloudBuildConfigSha256: GCP_PRIVATE_TEST_BUILD.cloudBuildConfigSha256,
    }),
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes("GCP_BUILD_IMAGE_DIGEST_MISMATCH"));
  assert.equal(calls.some(({ args }) => args[0] === "run"), false);
  assert.equal(calls.some(({ args }) => args[0] === "builds"), true);
});

test("preflight blocks a retired latest-created candidate when old revision still serves 100%", async () => {
  const harness = makeDeploymentHarness({
    initialService: serviceFixture({
      readyRevision: oldRevision,
      createdRevision: newRevision,
      traffic: [{ revisionName: oldRevision, percent: 100 }],
      templateImage: image,
      generation: 48,
      observedGeneration: 48,
    }),
    initialCandidate: revisionFixture({
      name: newRevision,
      imageValue: image,
      ready: "True",
      readyReason: "Retired",
    }),
  });
  const result = await runDeployment({
    config: parseArgs(["preflight"]),
    spawn: harness.spawn,
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.currentRevision, oldRevision);
  assert.ok(result.blockers.includes("GCP_GATEWAY_SERVICE_TEMPLATE_IMAGE_MISMATCH"));
  assert.equal(harness.calls.some(({ args }) => args[0] === "run"
    && args[1] === "services" && args[2] !== "describe" && args[2] !== "get-iam-policy"), false);
});

test("preflight accepts an unserved retired latest-created revision when template matches serving image", async () => {
  const harness = makeDeploymentHarness({
    initialService: serviceFixture({
      readyRevision: oldRevision,
      createdRevision: newRevision,
      traffic: [{ revisionName: oldRevision, percent: 100 }],
      templateImage: previousImage,
      generation: 48,
      observedGeneration: 48,
    }),
    initialCandidate: revisionFixture({
      name: newRevision,
      imageValue: previousImage,
      ready: "True",
      readyReason: "Retired",
    }),
  });
  const result = await runDeployment({
    config: parseArgs(["preflight"]),
    spawn: harness.spawn,
  });
  assert.equal(result.status, "ready", JSON.stringify(result));
  assert.equal(result.currentRevision, oldRevision);
  assert.equal(result.currentImage, previousImage);
});

test("deploy reuses and tags an exact retained candidate without stamping a duplicate revision", async () => {
  const harness = makeDeploymentHarness({
    initialService: serviceFixture({
      readyRevision: oldRevision,
      createdRevision: newRevision,
      traffic: [{ revisionName: oldRevision, percent: 100 }],
      templateImage: image,
      generation: 48,
      observedGeneration: 48,
    }),
    initialCandidate: revisionFixture({
      name: newRevision,
      imageValue: image,
      ready: "True",
      readyReason: "Retired",
    }),
  });
  const result = await runDeployment({
    config: provenanceConfig(),
    spawn: harness.spawn,
    archiveBuilder: async () => ({
      sourceContentDigest: sourceDigest,
      sourceArchiveSha256: archiveSha256,
      cloudBuildConfigSha256: GCP_PRIVATE_TEST_BUILD.cloudBuildConfigSha256,
    }),
  });
  assert.equal(result.status, "deployed", JSON.stringify(result));
  assert.equal(result.deployedRevision, newRevision);
  assert.equal(harness.calls.some(({ args }) => args[0] === "run"
    && args[1] === "services" && args[2] === "update"), false);
  const tagIndex = harness.calls.findIndex(({ args }) => args.some((value) =>
    value === "--update-tags=" + GCP_TEST_GATEWAY_STAGE_TAG + "=" + newRevision,
  ));
  const switchIndex = harness.calls.findIndex(({ args }) => args.some((value) =>
    value === "--to-revisions=" + newRevision + "=100",
  ));
  assert.ok(tagIndex >= 0 && switchIndex > tagIndex);
  assert.deepEqual(harness.state.service.status.traffic, [{ revisionName: newRevision, percent: 100 }]);
});

test("candidate readiness timeout restores prior traffic, template image, and removes the tag", async () => {
  const harness = makeDeploymentHarness({ candidateReadyAfterReads: null });
  const result = await runDeployment({
    config: provenanceConfig(),
    spawn: harness.spawn,
    pollAttempts: 3,
    archiveBuilder: async () => ({
      sourceContentDigest: sourceDigest,
      sourceArchiveSha256: archiveSha256,
      cloudBuildConfigSha256: GCP_PRIVATE_TEST_BUILD.cloudBuildConfigSha256,
    }),
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes("GCP_GATEWAY_STAGED_REVISION_READINESS_TIMEOUT"));
  assert.equal(result.rollback.ok, true, JSON.stringify(result.rollback));
  assert.equal(result.rollback.templateRestored, true);
  assert.equal(result.rollback.stageTagRemoved, true);
  assert.equal(harness.state.service.spec.template.spec.containers[0].image, previousImage);
  assert.deepEqual(harness.state.service.status.traffic, [{ revisionName: oldRevision, percent: 100 }]);
});

test("unrelated latest-created revision stops switching and only cleans the owned tag", async () => {
  const harness = makeDeploymentHarness({ unrelatedRevisionAtPoll: 1 });
  const result = await runDeployment({
    config: provenanceConfig(),
    spawn: harness.spawn,
    archiveBuilder: async () => ({
      sourceContentDigest: sourceDigest,
      sourceArchiveSha256: archiveSha256,
      cloudBuildConfigSha256: GCP_PRIVATE_TEST_BUILD.cloudBuildConfigSha256,
    }),
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes("GCP_GATEWAY_STAGED_REVISION_CHANGED"));
  assert.equal(result.rollback.complete, false);
  assert.equal(result.rollback.templateRestored, false);
  assert.equal(result.rollback.stageTagRemoved, true);
  assert.deepEqual(harness.state.service.status.traffic, [{ revisionName: oldRevision, percent: 100 }]);
  assert.equal(harness.state.service.spec.template.spec.containers[0].image, image);
  assert.equal(harness.calls.some(({ args }) => args.some((value) =>
    value === "--to-revisions=" + newRevision + "=100",
  )), false);
  assert.equal(harness.calls.some(({ args }) => args[0] === "run"
    && args[1] === "services" && args[2] === "update"
    && args.includes("--image=" + previousImage)), false);
});
