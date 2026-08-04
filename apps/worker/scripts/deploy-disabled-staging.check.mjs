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

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function notReadyLifecycle() {
  return {
    status: "not_ready",
    checks: {
      lifecycle: "never_run",
      lifecycleFresh: false,
      quarantineRetentionComplete: false,
      restoreReplayComplete: false,
      aggregateRebuildComplete: true,
      maintenanceCycleMatched: false,
      quarantineReconciliation: "never_run",
      quarantineReconciliationComplete: false,
    },
    policy: {
      lifecycleStaleAfterMilliseconds: 2 * 60 * 60 * 1000,
    },
  };
}

function containedFetch(url) {
  const pathname = new URL(String(url)).pathname;
  if (pathname === "/api/health") return jsonResponse(containedHealth());
  if (pathname === "/api/ready") return jsonResponse(notReadyLifecycle(), 503);
  throw new Error(`Unexpected URL: ${url}`);
}

const stagingOrigin =
  "https://app-usagemonitor-staging.test-account.workers.dev";

function runDeployment(options) {
  return runDisabledStagingDeployment({
    checkWorkspacePackages: async () => ({
      packageCount: 2,
      packages: [],
    }),
    stageAssets: async () => ({
      directory: "fixture-generated-worker-assets",
      files: 4,
    }),
    ...options,
  });
}

test("deployment requires an exact confirmation before any command", async () => {
  const calls = [];
  const result = await runDeployment({
    config: provisionedConfig(),
    origin: "https://staging.example.test",
    confirmation: "yes",
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn: (_command, args) => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    },
    fetchImpl: async (url) => containedFetch(url),
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
    const result = await runDeployment({
      config: provisionedConfig(),
      origin,
      confirmation: DEPLOY_CONFIRMATION,
      wrangler: "/fake/wrangler",
      workerDirectory,
    });
    assert.deepEqual(result, { ok: false, code: "STAGING_ORIGIN_INVALID" });
  }
});

test("deployment refuses any stale workspace package before Wrangler", async (t) => {
  for (const code of [
    "ACCOUNTING_PACKAGE_STALE",
    "TELEMETRY_CONTRACT_PACKAGE_STALE",
    "QUOTA_ANALYSIS_PACKAGE_STALE",
  ]) {
    await t.test(code, async () => {
      const calls = [];
      const stale = new Error("stale package bytes");
      stale.code = code;
      const result = await runDeployment({
        config: provisionedConfig(),
        origin: stagingOrigin,
        confirmation: DEPLOY_CONFIRMATION,
        wrangler: "/fake/wrangler",
        workerDirectory,
        checkWorkspacePackages: async () => {
          throw stale;
        },
        spawn: (_command, args) => {
          calls.push(args);
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      assert.deepEqual(result, { ok: false, code });
      assert.deepEqual(calls, []);
    });
  }
});

test("deployment fails closed on an unexpected package-check failure", async () => {
  let wranglerCalled = false;
  const result = await runDeployment({
    config: provisionedConfig(),
    origin: stagingOrigin,
    confirmation: DEPLOY_CONFIRMATION,
    wrangler: "/fake/wrangler",
    workerDirectory,
    checkWorkspacePackages: async () => {
      throw new Error("unexpected checker failure");
    },
    spawn: () => {
      wranglerCalled = true;
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(result, {
    ok: false,
    code: "WORKSPACE_PACKAGES_CHECK_FAILED",
  });
  assert.equal(wranglerCalled, false);
});

test("deployment refuses unverified generated public assets before Wrangler", async () => {
  let wranglerCalled = false;
  const result = await runDeployment({
    config: provisionedConfig(),
    origin: stagingOrigin,
    confirmation: DEPLOY_CONFIRMATION,
    wrangler: "/fake/wrangler",
    workerDirectory,
    stageAssets: async () => {
      throw new Error("generated public asset manifest is invalid");
    },
    spawn: () => {
      wranglerCalled = true;
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(result, {
    ok: false,
    code: "STAGING_PUBLIC_ASSETS_INVALID",
  });
  assert.equal(wranglerCalled, false);
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
  const result = await runDeployment({
    config,
    origin: stagingOrigin,
    confirmation: DEPLOY_CONFIRMATION,
    wrangler: "/fake/wrangler",
    workerDirectory,
    spawn,
    fetchImpl: async (url, options) => {
      requested.push({ url: String(url), options });
      return containedFetch(url);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, "DISABLED_STAGING_DEPLOYED");
  assert.equal(result.collectionAuthorized, false);
  assert.equal(
    result.receipt.schemaVersion,
    "usage-monitor-staging-operation-receipt-v0.1",
  );
  assert.equal(result.receipt.operation, "disabled_staging_deployed");
  assert.equal(result.receipt.activationState, "not_authorized");
  assert.equal(result.receipt.evidence.pilotSchemaCurrent, true);
  assert.equal(result.receipt.evidence.identityProtectionSchemaCurrent, true);
  assert.equal(
    result.receipt.evidence.identityProtectionSchema.status,
    "verified",
  );
  assert.equal(result.receipt.evidence.healthContained, true);
  assert.equal(result.receipt.evidence.lifecycleReadiness, "not_ready");
  assert.deepEqual(calls.at(-1), [
    "deploy", "--env", "staging", "--strict",
  ]);
  assert.equal(requested[0].url, `${stagingOrigin}/api/health`);
  assert.equal(requested[0].options.redirect, "error");
  assert.equal(requested[1].url, `${stagingOrigin}/api/ready`);
  assert.equal(requested[1].options.redirect, "error");
});

test("deployment refuses missing identity protection before Wrangler deploy", async (t) => {
  for (const scenario of [
    {
      name: "primary re-enrollment protection",
      options: { missingPrimarySchema: true },
      blocker: "REMOTE_IDENTITY_REENROLLMENT_SCHEMA_INCOMPLETE",
    },
    {
      name: "deletion-ledger cooldown protection",
      options: { missingDeletionLedgerSchema: true },
      blocker: "REMOTE_DELETION_LEDGER_SCHEMA_INCOMPLETE",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const config = provisionedConfig();
      const calls = [];
      let fetchCalled = false;
      const result = await runDeployment({
        config,
        origin: stagingOrigin,
        confirmation: DEPLOY_CONFIRMATION,
        wrangler: "/fake/wrangler",
        workerDirectory,
        spawn: successSpawn(config, calls, scenario.options),
        fetchImpl: async () => {
          fetchCalled = true;
          return containedFetch();
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, "STAGING_READINESS_BLOCKED");
      assert.equal(result.blockers.includes(scenario.blocker), true);
      assert.equal(calls.some((args) => args[0] === "deploy"), false);
      assert.equal(fetchCalled, false);
    });
  }
});

test("deployment refuses a health response with any collection path enabled", async () => {
  const config = provisionedConfig();
  const calls = [];
  const readinessSpawn = successSpawn(config, calls);
  const result = await runDeployment({
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
  const result = await runDeployment({
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
    const result = await runDeployment({
      config,
      origin: stagingOrigin,
      confirmation: DEPLOY_CONFIRMATION,
      wrangler: "/fake/wrangler",
      workerDirectory,
      secretsFile,
      spawn,
      fetchImpl: async (url) => containedFetch(url),
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
