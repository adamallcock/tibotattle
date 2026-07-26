import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEPLOY_CONFIRMATION,
  runDisabledStagingDeployment,
} from "./deploy-disabled-staging.mjs";
import { generateEnvelopeKeys } from "./generate-dev-keys.mjs";
import {
  provisionedConfig,
  successSpawn,
  workerDirectory,
} from "./staging-test-fixtures.mjs";

function containedHealth() {
  return {
    status: "ok",
    enrollmentMode: "disabled",
    collectionControls: {
      state: "contained",
      enrollment: false,
      uploadRegistration: false,
      processing: false,
      publication: false,
    },
    contracts: {
      accountScopedContribution: {
        externalParticipantsAuthorized: false,
      },
    },
    capabilities: {
      encryptedUpload: false,
      delayedAggregateStats: false,
      ongoingDeviceUploadRegistration: false,
    },
  };
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

const stagingOrigin =
  "https://app-usagemonitor-staging.test-account.workers.dev";

test("deployment requires an exact confirmation before any command", async () => {
  const calls = [];
  const result = await runDisabledStagingDeployment({
    config: provisionedConfig(),
    origin: "https://staging.example.test",
    confirmation: "yes",
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn: (_command, args) => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    },
    fetchImpl: async () => jsonResponse(containedHealth()),
  });
  assert.deepEqual(result, { ok: false, code: "CONFIRMATION_REQUIRED" });
  assert.deepEqual(calls, []);
});

test("deployment accepts only a bare HTTPS staging origin", async () => {
  for (const origin of [
    "http://staging.example.test",
    "https://user:pass@staging.example.test",
    "https://staging.example.test/path",
    "not a URL",
  ]) {
    const result = await runDisabledStagingDeployment({
      config: provisionedConfig(),
      origin,
      confirmation: DEPLOY_CONFIRMATION,
      wrangler: "/fake/wrangler",
      workerDirectory,
    });
    assert.deepEqual(result, { ok: false, code: "STAGING_ORIGIN_INVALID" });
  }
});

test("deployment runs only after live readiness and verifies contained health", async () => {
  const config = provisionedConfig();
  const calls = [];
  const readinessSpawn = successSpawn(config, calls);
  const spawn = (command, args, options) => {
    if (args[0] === "deploy") {
      calls.push(args);
      return { status: 0, stdout: `Deployed ${stagingOrigin}`, stderr: "" };
    }
    return readinessSpawn(command, args, options);
  };
  const requested = [];
  const result = await runDisabledStagingDeployment({
    config,
    origin: stagingOrigin,
    confirmation: DEPLOY_CONFIRMATION,
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn,
    fetchImpl: async (url, options) => {
      requested.push({ url: String(url), options });
      return jsonResponse(containedHealth());
    },
  });
  assert.deepEqual(result, {
    ok: true,
    code: "DISABLED_STAGING_DEPLOYED",
    collectionAuthorized: false,
  });
  assert.deepEqual(calls.at(-1), [
    "deploy", "--env", "staging", "--strict",
  ]);
  assert.equal(requested[0].url, `${stagingOrigin}/api/health`);
  assert.equal(requested[0].options.redirect, "error");
});

test("deployment refuses a health response with any collection path enabled", async () => {
  const config = provisionedConfig();
  const calls = [];
  const readinessSpawn = successSpawn(config, calls);
  const result = await runDisabledStagingDeployment({
    config,
    origin: stagingOrigin,
    confirmation: DEPLOY_CONFIRMATION,
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn: (command, args, options) => args[0] === "deploy"
      ? { status: 0, stdout: `Deployed ${stagingOrigin}`, stderr: "" }
      : readinessSpawn(command, args, options),
    fetchImpl: async () => {
      const health = containedHealth();
      health.collectionControls.processing = true;
      return jsonResponse(health);
    },
  });
  assert.deepEqual(result, { ok: false, code: "STAGING_NOT_CONTAINED" });
});

test("deployment binds health verification to Wrangler's deployed origin", async () => {
  const config = provisionedConfig();
  const calls = [];
  const readinessSpawn = successSpawn(config, calls);
  let requested = false;
  const result = await runDisabledStagingDeployment({
    config,
    origin: stagingOrigin,
    confirmation: DEPLOY_CONFIRMATION,
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn: (command, args, options) => args[0] === "deploy"
      ? {
        status: 0,
        stdout: "Deployed https://different.test-account.workers.dev",
        stderr: "",
      }
      : readinessSpawn(command, args, options),
    fetchImpl: async () => {
      requested = true;
      return jsonResponse(containedHealth());
    },
  });
  assert.deepEqual(result, {
    ok: false,
    code: "STAGING_DEPLOY_ORIGIN_MISMATCH",
  });
  assert.equal(requested, false);
});

test("first deployment accepts only an owner-only validated key file", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-staging-secrets-"));
  const secretsFile = join(root, ".dev.vars.staging");
  const config = provisionedConfig();
  try {
    generateEnvelopeKeys(secretsFile);
    const calls = [];
    const baseSpawn = successSpawn(config, calls);
    const spawn = (command, args, options) => {
      const joined = args.join(" ");
      if (joined === "secret list --env staging --format json") {
        calls.push(args);
        return { status: 1, stdout: "", stderr: "Worker not found" };
      }
      if (args[0] === "deploy") {
        calls.push(args);
        return {
          status: 0,
          stdout: `Deployed ${stagingOrigin}`,
          stderr: "",
        };
      }
      return baseSpawn(command, args, options);
    };
    const result = await runDisabledStagingDeployment({
      config,
      origin: stagingOrigin,
      confirmation: DEPLOY_CONFIRMATION,
      wrangler: "/fake/wrangler",
      workerDirectory,
      secretsFile,
      spawn,
      fetchImpl: async () => jsonResponse(containedHealth()),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls.at(-1), [
      "deploy", "--env", "staging", "--strict",
      "--secrets-file", secretsFile,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
