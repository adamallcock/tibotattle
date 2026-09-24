import assert from "node:assert/strict";
import test from "node:test";
import {
  GCP_PRIVATE_TEST_TARGET,
  assessCloudRunReadback,
  cloudRunHostModeReady,
  runGcpPrivateTestDeployment,
  runSyntheticRouteBoundarySmoke,
  runUnauthenticatedInvokerProbe,
  validateConfig,
} from "./gcp-private-test-deploy.mjs";

const sourceDigest = "a".repeat(64);
const imageDigest = "b".repeat(64);
const image = GCP_PRIVATE_TEST_TARGET.imageRepository + "@sha256:" + imageDigest;

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
} = {}) {
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
          containers: [{
            image: serviceImage,
            env: [{ name: "SOURCE_CONTENT_DIGEST", value: source }],
          }],
        },
      },
    },
    status: {
      url: "https://test-service.example.invalid",
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
    buildId: "12345678-abcd-efab-1234-1234567890ab",
    ...overrides,
  };
}

test("target is fixed to the named us-east1 test service and exact Artifact Registry digest", () => {
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
});

test("Cloud Run readback requires a ready private service, exact image, and all traffic on its latest ready revision", () => {
  const good = assessCloudRunReadback({
    service: serviceFixture(),
    policy: policyFixture(),
    expectedImage: image,
    expectedSourceDigest: sourceDigest,
  });
  assert.equal(good.ok, true);

  const v2Service = serviceFixture();
  v2Service.status.latestReadyRevision = v2Service.status.latestReadyRevisionName;
  v2Service.status.latestCreatedRevision = v2Service.status.latestCreatedRevisionName;
  delete v2Service.status.latestReadyRevisionName;
  delete v2Service.status.latestCreatedRevisionName;
  v2Service.status.trafficStatuses = [{
    revision: "projects/tibotattle/locations/us-east1/services/tibotattle-test-app/revisions/tibotattle-test-app-00042-abc",
    percent: 100,
  }];
  delete v2Service.status.traffic;
  assert.equal(assessCloudRunReadback({
    service: v2Service,
    policy: policyFixture(),
    expectedImage: image,
    expectedSourceDigest: sourceDigest,
  }).ok, true);

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
    listenHost: "0.0.0.0",
    hostOrigin: "https://service.invalid",
    port: 8080,
  });
  assert.equal(cloudRunHostModeReady(() => false), false);
  assert.equal(cloudRunHostModeReady(null), false);
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
    blockers: ["SOURCE_PROVENANCE_UNQUALIFIED"],
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
  assert.deepEqual(result.blockers, ["SOURCE_PROVENANCE_UNQUALIFIED"]);
  assert.equal(result.unauthenticatedProbe, "denied_without_identity");
  assert.equal(calls.some(({ command, args }) => command === "gcloud"
    && args[0] === "run" && args[1] === "deploy"), false);
  assert.equal(calls.some(({ command, args }) => command === "gcloud"
    && args[0] === "auth"), false);
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
