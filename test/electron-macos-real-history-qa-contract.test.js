import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  REAL_HISTORY_QA_MODES,
  REAL_HISTORY_QA_TIMEOUTS,
  buildRealHistoryReceipt,
  capturedDescendantPidsGone,
  capturedDescendantPidsValid,
  classifyAdvancedModuleText,
  classifyRealHistoryTerminal,
  communityParitySnapshotValid,
  createRefreshObserver,
  parseRealHistoryArguments,
  verifyPackagedArtifactIdentity,
  usageParitySnapshotValid,
} from "../scripts/qa-electron-macos-real-history.mjs";

const VALID_ARGS = [
  "--app", "/tmp/TiboTattle Dev.app",
  "--profile", "/tmp/tibotattle-real-history-profile",
  "--codex-home", "/tmp/codex-home",
  "--artifact-sha256", "a".repeat(64),
];

function degradedRefresh(overrides = {}) {
  return {
    status: "degraded",
    refreshId: "internal-refresh-id",
    errorCode: "refresh_degraded",
    failedStep: "unified_index",
    failureCode: "codex_rollout_generation_ambiguous",
    result: {
      unifiedIndex: {
        status: "ingested",
        generation: {
          status: "partial",
          blockReason: "codex_rollout_sources_quarantined",
          skippedSourceCount: 4,
          skippedThreadCount: 2,
          reasonCounts: {
            codex_rollout_generation_ambiguous: 2,
          },
          discoveryComplete: true,
          diagnosticsComplete: true,
          usageProvenanceComplete: true,
          sourceOrderComplete: true,
          quotaProvenanceComplete: true,
        },
      },
      accounting: {
        status: "replay_safe",
        sourceMode: "unified",
        coverageStatus: "partial",
        generationMatched: true,
        fallbackCount: 0,
        diagnosticsAvailable: true,
      },
    },
    ...overrides,
  };
}

test("real-history QA requires explicit isolated inputs and bounded modes", () => {
  assert.deepEqual(REAL_HISTORY_QA_MODES, ["cancel", "full", "relaunch"]);
  const parsed = parseRealHistoryArguments(VALID_ARGS.concat(["--mode", "relaunch", "--debug-port", "43210"]));
  assert.deepEqual(parsed, {
    help: false,
    appPath: "/tmp/TiboTattle Dev.app",
    profilePath: "/tmp/tibotattle-real-history-profile",
    codexHomePath: "/tmp/codex-home",
    mode: "relaunch",
    debugPort: 43210,
    receiptPath: null,
    artifactSha256: "a".repeat(64),
  });
  for (const args of [
    [],
    VALID_ARGS.slice(0, -2),
    VALID_ARGS.concat(["--mode", "unknown"]),
    VALID_ARGS.concat(["--debug-port", "80"]),
    VALID_ARGS.concat(["--app", "relative.app"]),
    VALID_ARGS.concat(["--profile", "/tmp/codex-home"]),
    VALID_ARGS.concat(["--unknown", "value"]),
    VALID_ARGS.concat(["--artifact-sha256", "A".repeat(64)]),
  ]) {
    assert.throws(() => parseRealHistoryArguments(args), (error) => {
      assert.equal(error.code, "REAL_HISTORY_QA_INPUT_INVALID");
      assert.equal(error.qaReason, "input_invalid");
      return true;
    });
  }
  assert.deepEqual(parseRealHistoryArguments(["--help"]), { help: true });
});

test("real-history timeout budgets are finite and bounded", () => {
  for (const [name, value] of Object.entries(REAL_HISTORY_QA_TIMEOUTS)) {
    assert.ok(Number.isSafeInteger(value), `${name} must be an integer`);
    assert.ok(value > 0, `${name} must be positive`);
    assert.ok(value <= 125 * 60_000, `${name} must be bounded`);
  }
  assert.ok(REAL_HISTORY_QA_TIMEOUTS.healthMs <= REAL_HISTORY_QA_TIMEOUTS.operationMs * 2);
});

test("full-history terminal acceptance allows success and only coherent quarantine degradation", () => {
  assert.deepEqual(
    classifyRealHistoryTerminal({ status: "succeeded", refreshId: "internal" }),
    { accepted: true, terminalStatus: "succeeded", degradedFailureCode: null },
  );
  assert.deepEqual(
    classifyRealHistoryTerminal(degradedRefresh()),
    {
      accepted: true,
      terminalStatus: "degraded",
      degradedFailureCode: "codex_rollout_generation_ambiguous",
    },
  );
  assert.equal(classifyRealHistoryTerminal(degradedRefresh({
    result: {
      ...degradedRefresh().result,
      accounting: {
        ...degradedRefresh().result.accounting,
        generationMatched: false,
      },
    },
  })).accepted, false);
  assert.equal(classifyRealHistoryTerminal({
    ...degradedRefresh(),
    failureCode: "private_unbounded_error",
  }).accepted, false);
  assert.equal(classifyRealHistoryTerminal(degradedRefresh({
    result: {
      ...degradedRefresh().result,
      unifiedIndex: {
        ...degradedRefresh().result.unifiedIndex,
        generation: {
          ...degradedRefresh().result.unifiedIndex.generation,
          reasonCounts: undefined,
        },
      },
    },
  })).accepted, false);
  assert.equal(classifyRealHistoryTerminal(degradedRefresh({
    result: {
      ...degradedRefresh().result,
      unifiedIndex: {
        ...degradedRefresh().result.unifiedIndex,
        generation: {
          ...degradedRefresh().result.unifiedIndex.generation,
          reasonCounts: { codex_rollout_generation_ambiguous: 0 },
        },
      },
    },
  })).accepted, false);
  assert.equal(classifyRealHistoryTerminal(degradedRefresh({
    result: {
      ...degradedRefresh().result,
      unifiedIndex: {
        ...degradedRefresh().result.unifiedIndex,
        generation: {
          ...degradedRefresh().result.unifiedIndex.generation,
          reasonCounts: { codex_rollout_content_invalid: 2 },
        },
      },
    },
  })).accepted, false);
  assert.equal(classifyRealHistoryTerminal({ status: "failed" }).accepted, false);
});

test("real-history receipt is allowlisted, content-free, and strips refresh identity", () => {
  const receipt = buildRealHistoryReceipt({
    mode: "relaunch",
    status: "passed",
    cleanQuit: true,
    timer: { sampleCount: 5, uniqueCount: 5, advanced: true },
    artifactSha256: "b".repeat(64),
    artifactIdentityVerified: true,
    startup: {
      requestCount: 1,
      refreshIdChanged: true,
      terminalStatus: "degraded",
      degradedFailureCode: "codex_rollout_generation_ambiguous",
      refreshId: "private-refresh-id",
    },
    parity: {
      dashboard: { populated: true },
      usage: {
        pageVisible: true,
        periodCount: 4,
        summaryCardCount: 4,
        meaningfulTokenRows: 3,
        meaningfulCostRows: 2,
        meaningfulModelRows: 1,
        meaningfulModelMetricCells: 3,
        advancedModulesAvailable: 2,
        advancedModulesUnavailable: 1,
        advancedModulesExplicit: true,
        advancedModulesReady: true,
      },
      community: {
        pageVisible: true,
        serviceConfigured: true,
        serviceReachability: "ok",
        serviceReachabilityProven: true,
        currentLayout: true,
        providerControlsEnabled: true,
        indexTerminal: true,
        partialHistoryDetail: true,
      },
    },
    relaunch: {
      persistedDashboard: true,
      newAutomaticRefresh: true,
      firstTerminalStatus: "succeeded",
      secondTerminalStatus: "degraded",
      firstRefreshId: "private-first-id",
      secondRefreshId: "private-second-id",
    },
  });
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.contentFree, true);
  assert.deepEqual(receipt.artifact, {
    sha256: "b".repeat(64),
    identityBound: true,
  });
  assert.deepEqual(buildRealHistoryReceipt({ status: "failed", artifactSha256: "b".repeat(64) }).artifact, {
    sha256: null,
    identityBound: false,
  });
  assert.equal(receipt.cleanQuit, true);
  assert.equal(receipt.parity.usage.meaningfulModelMetricCells, 3);
  assert.equal(receipt.parity.usage.advancedModulesAvailable, 2);
  assert.equal(receipt.parity.usage.advancedModulesUnavailable, 1);
  assert.equal(receipt.parity.community.providerControlsEnabled, true);
  assert.equal(receipt.parity.community.serviceReachability, "ok");
  assert.equal(receipt.parity.community.serviceReachabilityProven, true);
  assert.equal(receipt.startupRefresh.terminalStatus, "degraded");
  assert.equal(receipt.relaunch.persistedDashboard, true);
  assert.equal(receipt.relaunch.newAutomaticRefresh, true);
  assert.equal(Object.hasOwn(receipt, "refreshId"), false);
  assert.equal(JSON.stringify(receipt).includes("private-refresh-id"), false);
  assert.equal(JSON.stringify(receipt).includes("private-first-id"), false);
  assert.equal(JSON.stringify(receipt).includes("127.0.0.1"), false);
  assert.equal(JSON.stringify(receipt).includes("/tmp/"), false);
  assert.equal(JSON.stringify(receipt).includes("http://"), false);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.startupRefresh), true);
});

test("real-history process proof requires exact captured descendants and observes their disappearance", () => {
  assert.equal(capturedDescendantPidsValid([]), false);
  assert.equal(capturedDescendantPidsValid([123, 123]), false);
  assert.equal(capturedDescendantPidsValid([123, 456]), true);
  assert.equal(capturedDescendantPidsValid([123, 0]), false);
  assert.equal(capturedDescendantPidsGone([123, 456], () => false), true);
  assert.equal(capturedDescendantPidsGone([123, 456], (pid) => pid === 456), false);
  assert.equal(capturedDescendantPidsGone([], () => false), false);
});

test("real-history binds receipt identity to the exact app.asar bytes and rejects mismatches", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-real-history-artifact-"));
  const appPath = join(root, "TiboTattle Dev.app");
  const resources = join(appPath, "Contents", "Resources");
  const asar = join(resources, "app.asar");
  const bytes = Buffer.from("exact packaged app bytes\n", "utf8");
  const expected = createHash("sha256").update(bytes).digest("hex");
  try {
    await mkdir(resources, { recursive: true });
    await writeFile(asar, bytes);
    assert.equal(await verifyPackagedArtifactIdentity(appPath, expected), expected);
    await assert.rejects(
      () => verifyPackagedArtifactIdentity(appPath, "0".repeat(64)),
      (error) => {
        assert.equal(error.code, "REAL_HISTORY_QA_ARTIFACT_MISMATCH");
        assert.equal(error.qaReason, "artifact_invalid");
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real-history cancellation observer accepts one exact active-loader POST only", () => {
  const handlers = new Map();
  const cdp = {
    on(method, handler) {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    },
  };
  const observer = createRefreshObserver(cdp);
  const emit = (event) => handlers.get("Network.requestWillBeSent")?.(event);
  observer.select({
    expectedOrigin: "http://127.0.0.1:1234",
    expectedLoaderId: "active-loader",
  });
  emit({
    loaderId: "other-loader",
    request: { method: "POST", url: "http://127.0.0.1:1234/api/local/refresh" },
  });
  emit({
    loaderId: "active-loader",
    request: { method: "POST", url: "http://localhost:1234/api/local/refresh" },
  });
  emit({
    loaderId: "active-loader",
    request: { method: "GET", url: "http://127.0.0.1:1234/api/local/refresh" },
  });
  emit({
    loaderId: "active-loader",
    request: { method: "POST", url: "http://127.0.0.1:1234/api/local/refresh" },
  });
  assert.equal(observer.snapshot().length, 1);
  observer.reset();
  assert.equal(observer.snapshot().length, 0);
  observer.seal();
  emit({
    loaderId: "active-loader",
    request: { method: "POST", url: "http://127.0.0.1:1234/api/local/refresh" },
  });
  assert.equal(observer.snapshot().length, 0);
  observer.dispose();
});

test("real-history parity helpers reject blank model metrics, hidden advanced modules, or disabled providers", () => {
  assert.deepEqual(classifyAdvancedModuleText("Loading cache continuity…"), {
    explicitContent: false,
    explicitUnavailable: false,
    placeholder: true,
    terminalEvidence: false,
  });
  assert.equal(classifyAdvancedModuleText("No cache priced observations").terminalEvidence, true);
  assert.equal(classifyAdvancedModuleText("No cache priced observations").explicitUnavailable, true);
  assert.equal(classifyAdvancedModuleText("Checking…").terminalEvidence, false);
  const usage = {
    route: "#accounting",
    pageVisible: true,
    periodCount: 4,
    summaryCardCount: 4,
    tokenCountRows: 1,
    costContributionRows: 1,
    modelIdentityRows: 1,
    meaningfulTokenRows: 1,
    meaningfulCostRows: 1,
    meaningfulModelRows: 1,
    meaningfulModelMetricCells: 2,
    priceCoverage: true,
    advancedModuleShellCount: 3,
    advancedModulesExplicit: true,
    advancedModulesReady: true,
  };
  assert.equal(usageParitySnapshotValid(usage), true);
  assert.equal(usageParitySnapshotValid({ ...usage, meaningfulModelMetricCells: 1 }), false);
  assert.equal(usageParitySnapshotValid({ ...usage, advancedModulesExplicit: false }), false);

  const health = {
    capabilities: {
      contributionDevicePairing: true,
      incrementalContributionSync: "telemetry-contribution-v1.0",
    },
    serviceReachabilityProven: true,
  };
  const community = {
    route: "#community",
    pageVisible: true,
    journeyStageCount: 2,
    indexTerminal: true,
    indexDetail: true,
    partialHistoryDetail: false,
    googleButton: true,
    appleButton: true,
    googleButtonEnabled: true,
    appleButtonEnabled: true,
    currentLayout: true,
    noServiceCopy: false,
  };
  assert.equal(communityParitySnapshotValid(community, health), true);
  assert.equal(communityParitySnapshotValid(community, {
    ...health,
    serviceReachabilityProven: false,
  }), false);
  assert.equal(communityParitySnapshotValid({ ...community, appleButtonEnabled: false }, health), false);
  assert.equal(communityParitySnapshotValid(community, {
    capabilities: { ...health.capabilities, incrementalContributionSync: false },
  }), false);
});

test("source contract preserves the real profile and bounds every health poll", async () => {
  const source = await readFile(new URL("../scripts/qa-electron-macos-real-history.mjs", import.meta.url), "utf8");
  assert.match(source, /The profile is private and persistent/u);
  assert.match(source, /no teardown removes it/u);
  assert.match(source, /AbortController/u);
  assert.match(source, /X-Usage-Monitor-Local/u);
  assert.match(source, /fetchJson\(healthUrl, REAL_HISTORY_QA_TIMEOUTS\.healthMs\)/u);
  assert.match(source, /refreshIdChanged: true/u);
  assert.match(source, /refreshId,/u);
  assert.match(source, /profileIsolated: true/u);
  assert.match(source, /--artifact-sha256/u);
  assert.match(source, /verifyPackagedArtifactIdentity/u);
  assert.match(source, /createReadStream/u);
  assert.match(source, /artifactIdentityVerified: true/u);
  assert.match(source, /serviceReachabilityProven/u);
  assert.match(source, /centralServiceProxy === true/u);
  assert.match(source, /new URL\("\/api\/health", session\.dashboardUrl\)/u);
  assert.match(source, /serviceHealth\?\.status === "ok"/u);
  assert.match(source, /(?:loading|preparing|checking)/u);
  assert.match(source, /capturedDescendantPidsGone/u);
  assert.match(source, /session\.expectedDescendantPids = descendantsOf\(child\.pid\)/u);
  assert.match(source, /capturedDescendantCount: expectedDescendantPids\.length/u);
  assert.match(source, /session\.observer\.snapshot\(\)\.length !== 1/u);
});
