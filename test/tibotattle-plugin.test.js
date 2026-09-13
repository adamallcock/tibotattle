import assert from "node:assert/strict";
import test from "node:test";

import {
  MINIMUM_AGENT_RELEASE_VERSION,
  PLUGIN_STATUS_SCHEMA_VERSION,
  TiboTattlePluginError,
  createInstalledAgentClient,
  locateInstalledTiboTattle,
  readMacOSBundleVersion,
} from "../plugins/tibotattle/lib/installed-agent.mjs";
import {
  INSTALL_PLAN_SCHEMA_VERSION,
  INSTALL_RECEIPT_SCHEMA_VERSION,
  compareReleaseVersions,
  createInstallationController,
  readLatestReleaseManifest,
  readPublishedCask,
  selectInstallArtifact,
} from "../plugins/tibotattle/lib/installation.mjs";
import {
  TIBOTATTLE_TOOLS,
  createMcpRequestHandler,
  createToolRouter,
} from "../plugins/tibotattle/mcp/server.mjs";

const HASH = "a".repeat(64);
const COMMIT = "b".repeat(40);

function releaseManifest(version = MINIMUM_AGENT_RELEASE_VERSION) {
  return {
    schemaVersion: "usage-monitor-release-evidence-v1",
    repository: "https://github.com/adamallcock/tibotattle",
    version,
    tag: `v${version}`,
    commit: COMMIT,
    artifacts: [{
      platform: "macos",
      architecture: "arm64",
      format: "dmg",
      version,
      fileName: `TiboTattle-${version}-mac-arm64.dmg`,
      bytes: 123456,
      sha256: HASH,
      source: {
        repository: "https://github.com/adamallcock/tibotattle",
        commit: COMMIT,
      },
    }],
  };
}

test("plugin installation discovery selects the latest exact app candidate", async () => {
  const inspected = [];
  const result = await locateInstalledTiboTattle({
    candidates: [
      { sourceKind: "first", appPath: "/synthetic/one.app" },
      { sourceKind: "second", appPath: "/synthetic/two.app" },
    ],
    exists: async (path) => {
      inspected.push(path);
      return true;
    },
    readVersion: async (path) => path.includes("two.app") ? "0.1.24" : "0.1.23",
  });
  assert.equal(result.sourceKind, "second");
  assert.equal(result.releaseVersion, "0.1.24");
  assert.equal(result.detectedInstallations, 2);
  assert.match(result.executable, /two\.app\/Contents\/MacOS\/TiboTattle$/u);
  assert.match(result.agentScript, /app\.asar\/apps\/local\/server\.js$/u);
  assert.equal(inspected.some((path) => path.includes("one.app")), true);
});

test("equal installation versions keep system-before-user precedence", async () => {
  const result = await locateInstalledTiboTattle({
    candidates: [
      { sourceKind: "macos_system", appPath: "/synthetic/system.app" },
      { sourceKind: "macos_user", appPath: "/synthetic/user.app" },
    ],
    exists: async () => true,
    readVersion: async () => "0.1.24",
  });
  assert.equal(result.sourceKind, "macos_system");
  assert.equal(result.detectedInstallations, 2);
});

test("macOS bundle version discovery accepts strict versions and sanitizes failures", async () => {
  assert.equal(await readMacOSBundleVersion("/synthetic/TiboTattle.app", {
    execute: async () => ({ stdout: "0.1.24\n" }),
  }), "0.1.24");
  await assert.rejects(
    readMacOSBundleVersion("/Users/private/TiboTattle.app", {
      execute: async () => ({ stdout: "not-a-version\n" }),
    }),
    (error) => (
      error.code === "tibotattle_installation_version_unavailable"
      && !error.message.includes("/Users/private")
    ),
  );
});

test("newest installation wins even when its agent interface is unavailable", async () => {
  const installation = await locateInstalledTiboTattle({
    candidates: [
      { sourceKind: "macos_system", appPath: "/synthetic/system.app" },
      { sourceKind: "macos_user", appPath: "/synthetic/user.app" },
    ],
    exists: async (path) => !path.includes("user.app/Contents/Resources/app.asar"),
    readVersion: async (path) => path.includes("user.app") ? "0.1.24" : "0.1.23",
  });
  assert.equal(installation.releaseVersion, "0.1.24");
  assert.equal(installation.sourceKind, "macos_user");
  assert.equal(installation.agentScript, null);
  assert.equal(installation.detectedInstallations, 2);

  let executed = false;
  const client = createInstalledAgentClient({
    platform: "darwin",
    locate: async () => installation,
    execute: async () => {
      executed = true;
      return { stdout: "{}\n" };
    },
  });
  const status = await client.status();
  assert.equal(status.compatibility, "incompatible");
  assert.equal(status.releaseVersion, "0.1.24");
  assert.equal(status.detectedInstallations, 2);
  assert.equal(status.errorCode, "tibotattle_agent_unavailable");
  assert.equal(executed, false);
});

test("plugin status distinguishes absent, compatible, and incompatible apps", async () => {
  const absent = createInstalledAgentClient({ platform: "darwin", locate: async () => null });
  assert.deepEqual(await absent.status(), {
    schemaVersion: PLUGIN_STATUS_SCHEMA_VERSION,
    installation: "absent",
    compatibility: "unavailable",
    requiredProtocolVersion: 1,
    minimumReleaseVersion: MINIMUM_AGENT_RELEASE_VERSION,
  });

  const installation = {
    sourceKind: "synthetic",
    executable: "/synthetic/TiboTattle",
    agentScript: "/synthetic/app.asar/apps/local/server.js",
    releaseVersion: "0.1.23",
    detectedInstallations: 2,
  };
  const compatible = createInstalledAgentClient({
    platform: "darwin",
    locate: async () => installation,
    execute: async (_selected, args) => ({
      stdout: `${JSON.stringify({
        schemaVersion: "tibotattle-installed-agent-status-v1",
        protocolVersion: 1,
        releaseVersion: "0.1.23",
        dataHealth: { status: "available" },
        args,
      })}\n`,
    }),
  });
  const compatibleStatus = await compatible.status();
  assert.equal(compatibleStatus.compatibility, "compatible");
  assert.equal(compatibleStatus.dataHealth.status, "available");
  assert.equal(compatibleStatus.detectedInstallations, 2);
  assert.doesNotMatch(JSON.stringify(compatibleStatus), /synthetic\/TiboTattle/u);

  const incompatible = createInstalledAgentClient({
    platform: "darwin",
    locate: async () => installation,
    execute: async () => ({ stdout: "not-json\n" }),
  });
  assert.equal((await incompatible.status()).compatibility, "incompatible");
  assert.equal((await incompatible.status()).releaseVersion, "0.1.23");
});

test("plugin reports unsupported platforms before installation discovery", async () => {
  let located = false;
  const client = createInstalledAgentClient({
    platform: "linux",
    locate: async () => {
      located = true;
      return null;
    },
  });
  assert.deepEqual(await client.status(), {
    schemaVersion: PLUGIN_STATUS_SCHEMA_VERSION,
    installation: "unsupported",
    compatibility: "unsupported",
    requiredProtocolVersion: 1,
    minimumReleaseVersion: MINIMUM_AGENT_RELEASE_VERSION,
    errorCode: "tibotattle_platform_unsupported",
  });
  await assert.rejects(
    client.invoke("status"),
    (error) => error.code === "tibotattle_platform_unsupported",
  );
  assert.equal(located, false);
});

test("plugin forwards opaque paging and evidence values without decoding them", async () => {
  const calls = [];
  const client = createInstalledAgentClient({
    platform: "darwin",
    locate: async () => ({ sourceKind: "synthetic" }),
    execute: async (_installation, args) => {
      calls.push(args);
      return { stdout: `${JSON.stringify({ status: "available" })}\n` };
    },
  });
  await client.invoke("explain-usage", {
    plan: "top_work",
    period: "7d",
    limit: 5,
    cursor: "opaque-cursor",
  });
  await client.invoke("explain-usage-evidence", { selector: "opaque-selector" });
  assert.deepEqual(calls, [
    ["explain-usage", "--plan", "top_work", "--period", "7d", "--limit", "5", "--cursor", "opaque-cursor"],
    ["explain-usage-evidence", "--selector", "opaque-selector"],
  ]);
});

test("install planning refuses releases without the installed agent protocol", () => {
  assert.equal(compareReleaseVersions("0.1.22", "0.1.23"), -1);
  assert.equal(compareReleaseVersions("0.1.23", "0.1.23"), 0);
  assert.throws(
    () => selectInstallArtifact(releaseManifest("0.1.22"), {
      platform: "darwin",
      architecture: "arm64",
    }),
    (error) => error.code === "tibotattle_compatible_release_unavailable",
  );
});

test("install planning rejects unsupported platforms before network access", async () => {
  let clientRead = false;
  let manifestRead = false;
  const controller = createInstallationController({
    client: {
      status: async () => {
        clientRead = true;
        return { installation: "unsupported", compatibility: "unsupported" };
      },
    },
    fetchManifest: async () => {
      manifestRead = true;
      return releaseManifest();
    },
    platform: "linux",
    architecture: "x64",
  });
  await assert.rejects(
    controller.plan(),
    (error) => error.code === "tibotattle_install_platform_unsupported",
  );
  assert.equal(clientRead, false);
  assert.equal(manifestRead, false);
});

test("release and cask readers accept only bounded canonical metadata", async () => {
  const manifest = releaseManifest();
  const requests = [];
  const fetched = await readLatestReleaseManifest({
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          tag_name: "v0.1.23",
          draft: false,
          prerelease: false,
          assets: [{
            name: "release-manifest.json",
            browser_download_url: "https://github.com/adamallcock/tibotattle/releases/download/v0.1.23/release-manifest.json",
          }],
        }));
      }
      return new Response(JSON.stringify(manifest));
    },
  });
  assert.equal(fetched.commit, COMMIT);
  assert.equal(requests.length, 2);

  const cask = await readPublishedCask({
    fetchImpl: async () => new Response([
      'cask "tibotattle" do',
      '  version "0.1.23"',
      `  sha256 arm:   "${HASH}",`,
      `         intel: "${"c".repeat(64)}"`,
      "end",
    ].join("\n")),
  });
  assert.equal(cask.version, "0.1.23");
  assert.equal(cask.sha256.arm64, HASH);

  await assert.rejects(
    readPublishedCask({
      fetchImpl: async () => new Response("small", {
        headers: { "content-length": String(65 * 1024) },
      }),
    }),
    (error) => error.code === "tibotattle_cask_lookup_failed",
  );
});

test("install is bound to a single-use, expiring, exact release plan", async () => {
  let installed = false;
  const brewCalls = [];
  const controller = createInstallationController({
    client: {
      async status() {
        return installed
          ? { installation: "present", compatibility: "compatible", releaseVersion: "0.1.23" }
          : { installation: "absent", compatibility: "unavailable" };
      },
    },
    fetchManifest: async () => releaseManifest(),
    fetchCask: async () => ({ version: "0.1.23", sha256: { arm64: HASH } }),
    tokenBytes: () => "c".repeat(48),
    brew: async (args) => {
      brewCalls.push(args);
      installed = true;
    },
    platform: "darwin",
    architecture: "arm64",
  });
  const plan = await controller.plan();
  assert.equal(plan.schemaVersion, INSTALL_PLAN_SCHEMA_VERSION);
  assert.equal(plan.status, "confirmation_required");
  assert.equal(plan.artifactSha256, HASH);
  const receipt = await controller.install({ confirmationToken: plan.confirmationToken });
  assert.equal(receipt.schemaVersion, INSTALL_RECEIPT_SCHEMA_VERSION);
  assert.equal(receipt.version, "0.1.23");
  assert.deepEqual(brewCalls, [["install", "--cask", "adamallcock/tap/tibotattle"]]);
  await assert.rejects(
    controller.install({ confirmationToken: plan.confirmationToken }),
    (error) => error.code === "tibotattle_install_confirmation_invalid",
  );
});

test("install planning upgrades an older protocol-compatible app", async () => {
  const controller = createInstallationController({
    client: {
      status: async () => ({
        installation: "present",
        compatibility: "compatible",
        releaseVersion: "0.1.23",
      }),
    },
    fetchManifest: async () => releaseManifest("0.1.24"),
    fetchCask: async () => ({ version: "0.1.24", sha256: { arm64: HASH } }),
    tokenBytes: () => "f".repeat(48),
    platform: "darwin",
    architecture: "arm64",
  });
  const plan = await controller.plan();
  assert.equal(plan.status, "confirmation_required");
  assert.equal(plan.action, "upgrade");
  assert.equal(plan.version, "0.1.24");
});

test("install refuses cask drift after confirmation", async () => {
  let caskRead = 0;
  let brewCalled = false;
  const controller = createInstallationController({
    client: { status: async () => ({ installation: "absent", compatibility: "unavailable" }) },
    fetchManifest: async () => releaseManifest(),
    fetchCask: async () => {
      caskRead += 1;
      return caskRead === 1
        ? { version: "0.1.23", sha256: { arm64: HASH } }
        : { version: "0.1.24", sha256: { arm64: "d".repeat(64) } };
    },
    tokenBytes: () => "e".repeat(48),
    brew: async () => { brewCalled = true; },
    platform: "darwin",
    architecture: "arm64",
  });
  const plan = await controller.plan();
  await assert.rejects(
    controller.install({ confirmationToken: plan.confirmationToken }),
    (error) => error.code === "tibotattle_cask_release_mismatch",
  );
  assert.equal(brewCalled, false);
});

test("MCP tools keep read analysis separate from the destructive install tool", async () => {
  const installTool = TIBOTATTLE_TOOLS.find((tool) => tool.name === "tibotattle_install");
  assert.equal(installTool.annotations.readOnlyHint, false);
  assert.equal(installTool.annotations.destructiveHint, true);
  for (const name of [
    "tibotattle_status",
    "tibotattle_list_plans",
    "tibotattle_explain_usage",
    "tibotattle_get_evidence",
    "tibotattle_install_plan",
  ]) {
    assert.equal(TIBOTATTLE_TOOLS.find((tool) => tool.name === name).annotations.readOnlyHint, true);
  }

  const calls = [];
  const router = createToolRouter({
    client: {
      status: async () => ({ status: "ok" }),
      invoke: async (command, input) => {
        calls.push([command, input]);
        return { status: "available", nextCursor: "opaque-next" };
      },
    },
    installer: {
      plan: async () => ({ status: "confirmation_required" }),
      install: async () => ({ status: "installed" }),
    },
  });
  const result = await router("tibotattle_explain_usage", {
    plan: "top_work",
    period: "30d",
    limit: 3,
    cursor: "opaque-current",
  });
  assert.equal(result.structuredContent.nextCursor, "opaque-next");
  assert.deepEqual(calls[0], ["explain-usage", {
    plan: "top_work",
    period: "30d",
    limit: 3,
    cursor: "opaque-current",
  }]);
  const rejected = await router("tibotattle_explain_usage", {
    plan: "top_work",
    hiddenPath: "/private/value",
  });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.errorCode, "tibotattle_tool_input_invalid");
  assert.doesNotMatch(JSON.stringify(rejected), /private\/value/u);
});

test("MCP request handler lists tools and returns structured tool results", async () => {
  const handler = createMcpRequestHandler({
    callTool: async () => ({
      content: [{ type: "text", text: "{}" }],
      structuredContent: { ok: true },
    }),
  });
  const listed = await handler({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(listed.result.tools.length, 6);
  const called = await handler({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "tibotattle_status", arguments: {} },
  });
  assert.equal(called.result.structuredContent.ok, true);
  assert.equal(await handler({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("unexpected plugin errors never echo sensitive error contents", async () => {
  const router = createToolRouter({
    client: { status: async () => { throw new Error("/Users/private/secret.sqlite"); } },
    installer: {},
  });
  const result = await router("tibotattle_status", {});
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.errorCode, "tibotattle_plugin_internal_error");
  assert.doesNotMatch(JSON.stringify(result), /secret\.sqlite/u);
  assert.equal(new TiboTattlePluginError("code", "safe").code, "code");
});
