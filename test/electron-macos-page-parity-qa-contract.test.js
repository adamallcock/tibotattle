import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TELEMETRY_SCHEMA_VERSION } from "@app-usagemonitor/telemetry-contract";
import { buildLocalCacheDropThreadLinks } from "../src/local-cache-drop-thread-links.js";
import { buildLocalCompanionSnapshot } from "../src/local-companion-data.js";
import { localCompanionStatePaths } from "../src/local-installation-diagnostics.js";
import { readLocalUnifiedCompanionProjection } from "../src/local-unified-companion-source.js";
import { rebuildLocalUnifiedIndex } from "../src/local-unified-index-build.js";
import { refreshReplaySafeAccountingCache } from "../src/replay-safe-accounting-cache.js";

import {
  buildClosedPageParityReceipt,
  buildClosedNativeTrayReceipt,
  finalizeSyntheticFixture,
  PAGE_PARITY_STATUSES,
  parsePageParityArguments,
  seedSyntheticCacheLinkSources,
  writeReceipt,
} from "../scripts/qa-electron-macos-page-parity.mjs";

const SOURCE = "a".repeat(40);
const ASAR = "b".repeat(64);

function passingInputs() {
  return {
    requestedStatus: "passed",
    sourceRevision: SOURCE,
    artifactSha256: ASAR,
    artifactIdentityBound: true,
    cleanQuit: true,
    loopbackOnly: true,
    pages: Object.fromEntries(["overview", "allowance", "trends", "usage"].map((key) => [key, {
      route: true, activeNav: true, visible: true, surface: "data", refreshState: "fresh",
    }])),
    cacheLinks: {
      renderedInPackagedDashboard: true, normalPackagedDataFlow: true,
      ordinaryLink: true, workerParentAndChild: true, autoReviewParentOnly: true,
      unavailableAutoReview: true, canonicalTargetsOnly: true,
    },
    settings: {
      language: { selected: true, dashboardLocalized: true, restored: true },
      general: { panelVisible: true, contentPresent: true },
      notifications: { panelVisible: true, contentPresent: true },
      about: { panelVisible: true, contentPresent: true },
    },
    screenshots: Object.fromEntries([
      "overview", "allowance", "trends", "usage", "cacheLinks",
      "settingsGeneral", "settingsNotifications", "settingsAbout",
    ].map((key) => [key, "c".repeat(64)])),
  };
}

test("supplemental receipt stays incomplete when physical native tray evidence is unavailable", () => {
  const receipt = buildClosedPageParityReceipt({
    ...passingInputs(),
    nativeTray: { status: "unavailable", reason: "cua_bridge_unavailable" },
  });
  assert.equal(receipt.status, "incomplete");
  assert.equal(receipt.nativeTray.status, "unavailable");
  assert.equal(receipt.nativeTray.reason, "cua_bridge_unavailable");
  assert.equal(receipt.cacheLinks.linksActivated, false);
  assert.equal(receipt.failureStage, null);
  assert.equal(receipt.failureReason, null);
  assert.equal(JSON.stringify(receipt).includes("/private/"), false);
});

test("supplemental receipt cannot pass when a required rendered page is absent", () => {
  const input = passingInputs();
  input.pages.trends.visible = false;
  const receipt = buildClosedPageParityReceipt({ ...input, nativeTray: { status: "passed" } });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.failureReason, "launch_failed");
  assert.ok(PAGE_PARITY_STATUSES.includes(receipt.status));
});

test("failed receipt retains finished content-free evidence without qualifying unfinished controls", () => {
  const input = passingInputs();
  input.cacheLinks = {};
  const receipt = buildClosedPageParityReceipt({
    ...input,
    nativeTray: { status: "unavailable", reason: "cua_bridge_unavailable" },
    failureStage: "cache_links",
    failureReason: "cache_links_invalid",
  });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.artifact.identityBound, true);
  assert.equal(receipt.pages.overview.route, true);
  assert.equal(receipt.screenshots.overview, "c".repeat(64));
  assert.equal(receipt.cacheLinks.normalPackagedDataFlow, false);
  assert.equal(receipt.failureStage, "cache_links");
  assert.equal(receipt.failureReason, "cache_links_invalid");
  assert.equal(JSON.stringify(receipt).includes("/private/"), false);
});

test("native tray receipt requires every physical interaction before it passes", () => {
  const complete = {
    requestedStatus: "passed",
    sourceRevision: SOURCE,
    artifactSha256: ASAR,
    artifactIdentityBound: true,
    dashboardReady: true,
    handoffAcknowledged: true,
    cleanQuit: true,
    loopbackOnly: true,
    nativeTray: {
      status: "passed",
      iconVisible: true,
      primaryPopupVisible: true,
      secondaryMenuVisible: true,
      mutuallyExclusive: true,
      dismissedAndReopened: true,
    },
  };
  assert.equal(buildClosedNativeTrayReceipt(complete).status, "passed");
  const incomplete = buildClosedNativeTrayReceipt({
    ...complete,
    nativeTray: { ...complete.nativeTray, mutuallyExclusive: false },
  });
  assert.equal(incomplete.status, "incomplete");
  assert.equal(incomplete.nativeTray.mutuallyExclusive, false);
  const unavailable = buildClosedNativeTrayReceipt({
    ...complete,
    nativeTray: { status: "unavailable", reason: "cua_bridge_unavailable" },
  });
  assert.equal(unavailable.status, "incomplete");
  assert.equal(unavailable.nativeTray.reason, "cua_bridge_unavailable");
  assert.equal(JSON.stringify(unavailable).includes("/private/"), false);
});

test("fallback fixture cleanup preserves the profile when TERM cannot prove the owned tree exited", async () => {
  const order = [];
  let removed = false;
  const child = {
    pid: 51,
    exitCode: null,
    signalCode: null,
    kill(signal) { order.push(`signal:${signal}`); return true; },
  };
  const result = await finalizeSyntheticFixture({
    child,
    fixture: { root: "/synthetic-fixture" },
    captureDescendants(pid) { assert.equal(pid, 51); order.push("descendants"); return [52]; },
    createExitWaiter(candidate) {
      assert.equal(candidate, child);
      order.push("listener");
      return async (timeoutMs) => { order.push(`wait:${timeoutMs}`); return false; };
    },
    isAlive: () => true,
    removeDirectory: async () => { removed = true; },
  });
  assert.deepEqual(order, ["descendants", "listener", "signal:SIGTERM", "wait:2000"]);
  assert.deepEqual(result, { shutdownConfirmed: false, fixtureRemoved: false });
  assert.equal(removed, false);
});

test("fallback fixture cleanup removes a profile only after captured processes exit", async () => {
  const order = [];
  let onExit = null;
  let removed = null;
  const child = {
    pid: 61,
    exitCode: null,
    signalCode: null,
    once(event, listener) { assert.equal(event, "exit"); order.push("listener"); onExit = listener; },
    removeListener(event, listener) { assert.equal(event, "exit"); assert.equal(listener, onExit); },
    kill(signal) {
      assert.equal(signal, "SIGTERM");
      order.push("signal");
      this.exitCode = 0;
      onExit();
      return true;
    },
  };
  const result = await finalizeSyntheticFixture({
    child,
    fixture: { root: "/synthetic-fixture" },
    captureDescendants(pid) { assert.equal(pid, 61); order.push("descendants"); return [62]; },
    isAlive: () => false,
    removeDirectory: async (directory) => { removed = directory; },
  });
  assert.deepEqual(order, ["descendants", "listener", "signal"]);
  assert.deepEqual(result, { shutdownConfirmed: true, fixtureRemoved: true });
  assert.equal(removed, "/synthetic-fixture");
});

test("receipt publication cannot overwrite a concurrent final destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "page-parity-receipt-"));
  const destination = join(root, "receipt.json");
  try {
    const outcomes = await Promise.allSettled([
      writeReceipt(destination, { writer: "one" }),
      writeReceipt(destination, { writer: "two" }),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason?.reason, "arguments_invalid");
    const persisted = JSON.parse(await readFile(destination, "utf8"));
    assert.ok(["one", "two"].includes(persisted.writer));
    assert.deepEqual(await readdir(root), ["receipt.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("synthetic cache fixture reaches the ordinary local index-to-link path", async () => {
  const root = await mkdtemp(join(tmpdir(), "page-parity-cache-links-"));
  const fixture = {
    root,
    codexHome: join(root, "codex"),
    stateRoot: join(root, "state"),
  };
  try {
    await Promise.all([
      mkdir(fixture.codexHome, { recursive: true, mode: 0o700 }),
      mkdir(fixture.stateRoot, { recursive: true, mode: 0o700 }),
    ]);
    const seeded = await seedSyntheticCacheLinkSources(fixture, { nowMs: Date.now() });
    assert.deepEqual(seeded, { status: "seeded", caseCount: 4 });

    const paths = localCompanionStatePaths(fixture.stateRoot);
    await rebuildLocalUnifiedIndex({
      codexHome: fixture.codexHome,
      indexFile: paths.unifiedIndexFile,
      secretFile: paths.unifiedIndexSecretFile,
      contractVersion: TELEMETRY_SCHEMA_VERSION,
      workerCount: 1,
    });
    const projection = await readLocalUnifiedCompanionProjection({
      indexFile: paths.unifiedIndexFile,
      nowMs: Date.now(),
    });
    await refreshReplaySafeAccountingCache({
      stateFile: paths.collectorStateFile,
      sourceMode: "unified",
      unifiedIndexFile: paths.unifiedIndexFile,
      expectedGeneration: projection.generation,
      contextBehavior: "legacy_zero",
      rebuildIsolation: "in_process",
    });
    const snapshot = await buildLocalCompanionSnapshot({
      root: fixture.root,
      collectorStateFile: paths.collectorStateFile,
      unifiedIndexFile: paths.unifiedIndexFile,
      codexHome: fixture.codexHome,
      accountingSourceMode: "unified",
    });
    const links = await buildLocalCacheDropThreadLinks({
      indexFile: paths.unifiedIndexFile,
      codexHome: fixture.codexHome,
      overview: snapshot.overview,
    });
    const entries = links.entries;
    assert.equal(snapshot.overview.accounting.generationMatched, true);
    assert.equal(snapshot.overview.accounting.cacheSwitchImpact.status, "available");
    assert.ok(snapshot.overview.accounting.cacheSwitchImpact.recent.length >= 4);
    assert.equal(links.status, "available");
    assert.equal(entries.length, 4);
    assert.equal(entries.filter((entry) => entry.thread.parent !== null).length, 2);
    assert.equal(entries.filter((entry) => entry.thread.origin === "auto_review").length, 2);
    assert.equal(entries.filter((entry) => entry.thread.origin === "auto_review"
      && entry.thread.parent === null).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("argument parser requires exact identity and explicit writable destinations", () => {
  const parsed = parsePageParityArguments([
    "--app", "/tmp/TiboTattle Dev.app",
    "--source-root", "/tmp/source",
    "--receipt", "/tmp/receipt.json",
    "--screenshots-dir", "/tmp/screenshots",
    "--source-revision", SOURCE,
    "--artifact-sha256", ASAR,
  ]);
  assert.equal(parsed.sourceRevision, SOURCE);
  assert.equal(parsed.artifactSha256, ASAR);
  assert.equal(parsed.nativeCuaHandoffDirectory, null);
  const native = parsePageParityArguments([
    "--app", "/tmp/TiboTattle Dev.app",
    "--source-root", "/tmp/source",
    "--receipt", "/tmp/receipt.json",
    "--screenshots-dir", "/tmp/screenshots",
    "--source-revision", SOURCE,
    "--artifact-sha256", ASAR,
    "--native-cua-handoff-dir", "/tmp/native-handoff",
  ]);
  assert.equal(native.nativeCuaHandoffDirectory, "/tmp/native-handoff");
  assert.throws(() => parsePageParityArguments(["--app", "/tmp/app"]), { reason: "arguments_invalid" });
});
