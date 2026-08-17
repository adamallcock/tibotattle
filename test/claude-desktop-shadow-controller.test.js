import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createClaudeDesktopShadowController,
} from "../src/claude-desktop-shadow-controller.js";
import { openClaudeDesktopLedgerPrototype } from "../src/claude-desktop-ledger-prototype.js";
import { openClaudeDesktopShadowStore } from "../src/claude-desktop-shadow-store.js";
import { localCompanionStatePaths } from "../src/local-installation-diagnostics.js";

const PROVIDER = "anthropic_claude_code";
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const KEY_C = "c".repeat(64);

async function makeRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await chmod(root, 0o700);
  return root;
}

function readiness({ status = "ready", quota = "available" } = {}) {
  return {
    status,
    usageSources: {
      metadata: { status: "available" },
      projects: { status: "available" },
    },
    quotaSource: { status: quota },
    retention: {
      status: "available",
      effectiveDays: 30,
      effectiveScope: "user",
    },
  };
}

function refreshResult() {
  return {
    status: "completed",
    elapsedMs: 12,
    canonical: {
      sourceCount: 2,
      unchangedSources: 1,
      appendedSources: 1,
      rebuiltSources: 0,
      missingSources: 0,
      parsedBytes: 50,
      parsedLines: 2,
      candidateCount: 1,
    },
    merge: { inserted: 1, superseded: 0, tombstoned: 0 },
    pricingSummary: {
      eventCount: 1,
      coverageStatus: "fully_priced",
    },
    pricingCachePublication: { status: "published" },
    shadow: {
      records: { inserted: 1, tombstoned: 0 },
      artifacts: { inserted: 4 },
    },
  };
}

function candidate() {
  return {
    provider: PROVIDER,
    logicalKey: KEY_A,
    candidateKey: KEY_B,
    sourceKey: KEY_C,
    sourceGeneration: 1,
    observedAtMs: 100,
    modelKey: KEY_A,
    inputUncachedTokens: 10,
    inputCacheReadTokens: 20,
    inputCacheWriteTokens: 30,
    outputTextTokens: null,
    outputReasoningTokens: null,
    outputCombinedTokens: 40,
    outputKind: "provider_reported_combined",
    parserVersion: "test-parser-v1",
  };
}

test("disabled production shadow creates nothing and has no UI or upload surface", async () => {
  let inspected = false;
  let refreshed = false;
  const controller = createClaudeDesktopShadowController({
    enabled: false,
    // Disabled mode intentionally does not require or touch configured paths.
    stateRoot: "not-an-absolute-path",
    inspectReadiness: async () => { inspected = true; },
    refreshShadow: async () => { refreshed = true; },
  });
  assert.deepEqual(controller.status(), {
    schemaVersion: "claude-desktop-shadow-controller-v0.1",
    provider: PROVIDER,
    status: "disabled",
    localOnly: true,
    uiEnabled: false,
    uploadEnabled: false,
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    reasonCode: "shadow_disabled",
    retryAtMs: null,
  });
  assert.equal((await controller.refresh()).status, "disabled");
  assert.equal((await controller.purge()).status, "disabled");
  assert.equal(inspected, false);
  assert.equal(refreshed, false);
});

test("enabled shadow accepts usage-ready partial readiness and excludes quota", async () => {
  const root = await makeRoot("tibotattle-claude-shadow-controller-ready-");
  try {
    let received;
    const controller = createClaudeDesktopShadowController({
      enabled: true,
      stateRoot: root,
      homeDirectory: root,
      projectDirectory: root,
      inspectReadiness: async () => readiness({ status: "partial", quota: "missing" }),
      refreshShadow: async (options) => {
        received = options;
        return refreshResult();
      },
    });
    assert.equal(controller.status().status, "idle");
    const result = await controller.refresh();
    assert.equal(result.status, "completed");
    assert.equal(result.readiness.quotaSource, "missing");
    assert.equal(result.uiEnabled, false);
    assert.equal(result.uploadEnabled, false);
    assert.equal(received.refreshOptions.includeQuota, false);
    assert.equal(received.refreshOptions.includeDebugPricingRows, undefined);
    assert.equal(received.refreshOptions.signal instanceof AbortSignal, true);
    assert.equal(received.refreshOptions.secret.byteLength, 32);
    const paths = localCompanionStatePaths(root);
    const secretStats = await stat(paths.claudeDesktopShadowSecretFile);
    assert.equal(secretStats.size, 32);
    if (process.platform !== "win32") assert.equal(secretStats.mode & 0o077, 0);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(root), false);
    assert.equal(serialized.includes("secret"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("blocked sources do not create state and refresh failures back off without leaking errors", async () => {
  const root = await makeRoot("tibotattle-claude-shadow-controller-backoff-");
  let now = 1_000_000;
  try {
    let mode = "blocked";
    let refreshCalls = 0;
    const controller = createClaudeDesktopShadowController({
      enabled: true,
      stateRoot: root,
      homeDirectory: root,
      projectDirectory: root,
      clock: () => now,
      initialBackoffMs: 1_000,
      maximumBackoffMs: 8_000,
      inspectReadiness: async () => {
        const value = readiness();
        if (mode === "blocked") {
          value.status = "blocked";
          value.usageSources.projects.status = "missing";
        }
        return value;
      },
      refreshShadow: async () => {
        refreshCalls += 1;
        throw new Error(`/Users/private/${"prompt-canary"}`);
      },
    });
    const blocked = await controller.refresh();
    assert.equal(blocked.status, "blocked");
    assert.equal(refreshCalls, 0);
    await assert.rejects(
      stat(localCompanionStatePaths(root).claudeDesktopShadowSecretFile),
      { code: "ENOENT" },
    );

    mode = "ready";
    const failed = await controller.refresh();
    assert.equal(failed.status, "failed");
    assert.equal(failed.reasonCode, "shadow_refresh_failed");
    assert.equal(JSON.stringify(failed).includes("prompt-canary"), false);
    assert.equal((await controller.refresh()).status, "deferred");
    assert.equal(refreshCalls, 1);
    now += 1_000;
    assert.equal((await controller.refresh()).status, "failed");
    assert.equal(refreshCalls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("caller abort propagates into the shadow pipeline and returns a closed receipt", async () => {
  const root = await makeRoot("tibotattle-claude-shadow-controller-abort-");
  try {
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const controller = createClaudeDesktopShadowController({
      enabled: true,
      stateRoot: root,
      homeDirectory: root,
      projectDirectory: root,
      inspectReadiness: async () => readiness(),
      refreshShadow: async ({ refreshOptions }) => {
        markStarted();
        await new Promise((resolve, reject) => {
          refreshOptions.signal.addEventListener("abort", () => {
            const error = new Error("private aborted work");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
    });
    const abort = new AbortController();
    const running = controller.refresh({ signal: abort.signal });
    await started;
    const busy = await controller.refresh();
    assert.equal(busy.status, "busy");
    assert.equal(busy.reasonCode, "shadow_operation_active");
    abort.abort();
    const result = await running;
    assert.equal(result.status, "aborted");
    assert.equal(result.reasonCode, "shadow_aborted");
    assert.equal(JSON.stringify(result).includes("private aborted work"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("caller abort reaches readiness and leaves setup without creating shadow state", async () => {
  const root = await makeRoot("tibotattle-claude-shadow-controller-readiness-abort-");
  try {
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const controller = createClaudeDesktopShadowController({
      enabled: true,
      stateRoot: root,
      homeDirectory: root,
      projectDirectory: root,
      inspectReadiness: async ({ signal }) => {
        markStarted(signal);
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("readiness aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
        return readiness();
      },
      refreshShadow: async () => {
        throw new Error("refresh must not start");
      },
    });
    const abort = new AbortController();
    const running = controller.refresh({ signal: abort.signal });
    const readinessSignal = await started;
    assert.equal(readinessSignal instanceof AbortSignal, true);
    abort.abort();
    const result = await running;
    assert.equal(result.status, "aborted");
    assert.equal(result.reasonCode, "shadow_aborted");
    await assert.rejects(
      stat(localCompanionStatePaths(root).claudeDesktopShadowSecretFile),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timeout abort reaches a cooperative readiness probe", async () => {
  const root = await makeRoot("tibotattle-claude-shadow-controller-readiness-timeout-");
  try {
    const controller = createClaudeDesktopShadowController({
      enabled: true,
      stateRoot: root,
      homeDirectory: root,
      projectDirectory: root,
      timeoutMs: 1_000,
      inspectReadiness: async ({ signal }) => {
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("readiness timed out");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
        return readiness();
      },
    });
    const result = await controller.refresh();
    assert.equal(result.status, "timed_out");
    assert.equal(result.reasonCode, "shadow_timeout");
    await assert.rejects(
      stat(localCompanionStatePaths(root).claudeDesktopShadowSecretFile),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timeout bounds a non-cooperative read-only readiness probe", async () => {
  const root = await makeRoot("tibotattle-claude-shadow-controller-readiness-bounded-");
  try {
    const controller = createClaudeDesktopShadowController({
      enabled: true,
      stateRoot: root,
      homeDirectory: root,
      projectDirectory: root,
      timeoutMs: 1_000,
      inspectReadiness: async () => new Promise(() => {}),
    });
    const startedAt = Date.now();
    const result = await controller.refresh();
    assert.equal(result.status, "timed_out");
    assert.equal(result.reasonCode, "shadow_timeout");
    assert.ok(Date.now() - startedAt < 2_500);
    await assert.rejects(
      stat(localCompanionStatePaths(root).claudeDesktopShadowSecretFile),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsafe shadow state fails purge before mutating the durable ledger", async () => {
  const root = await makeRoot("tibotattle-claude-shadow-controller-purge-preflight-");
  const paths = localCompanionStatePaths(root);
  try {
    let ledger = openClaudeDesktopLedgerPrototype(paths.claudeDesktopShadowLedgerFile);
    assert.equal(ledger.mergeUsageCandidates([candidate()]).inserted, 1);
    ledger.close();

    const target = join(root, "shadow-state-target");
    await writeFile(target, "not-a-shadow-database", { mode: 0o600 });
    await symlink(target, paths.claudeDesktopShadowStateFile);
    const controller = createClaudeDesktopShadowController({
      enabled: true,
      stateRoot: root,
      homeDirectory: root,
      projectDirectory: root,
    });

    await assert.rejects(
      controller.purge({ startAtMs: 50, endAtMs: 150, createdAtMs: 200 }),
      { code: "claude_desktop_shadow_state_file" },
    );
    assert.equal((await lstat(paths.claudeDesktopShadowStateFile)).isSymbolicLink(), true);

    ledger = openClaudeDesktopLedgerPrototype(paths.claudeDesktopShadowLedgerFile);
    assert.equal(ledger.providerSnapshot(PROVIDER).winnerCount, 1);
    assert.deepEqual(ledger.mergeUsageCandidates([candidate()]), {
      inserted: 0,
      superseded: 0,
      tombstoned: 0,
    });
    ledger.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("purge retains ledger tombstones while removing rebuildable shadow artifacts", async () => {
  const root = await makeRoot("tibotattle-claude-shadow-controller-purge-");
  const paths = localCompanionStatePaths(root);
  try {
    let ledger = openClaudeDesktopLedgerPrototype(paths.claudeDesktopShadowLedgerFile);
    assert.equal(ledger.mergeUsageCandidates([candidate()]).inserted, 1);
    ledger.close();

    let store = openClaudeDesktopShadowStore({
      statePath: paths.claudeDesktopShadowStateFile,
      enabled: true,
    });
    store.ingest([{
      kind: "usage",
      sourceGeneration: 1,
      eventTimeMs: 100,
      recordKey: KEY_A,
      payloadDigest: KEY_B,
      revision: 1,
    }]);
    store.close();
    await writeFile(paths.claudeDesktopShadowCanonicalFile, "rebuildable", { mode: 0o600 });
    await writeFile(paths.claudeDesktopPricingCacheFile, "rebuildable", { mode: 0o600 });

    const controller = createClaudeDesktopShadowController({
      enabled: true,
      stateRoot: root,
      homeDirectory: root,
      projectDirectory: root,
    });
    const receipt = await controller.purge({
      startAtMs: 50,
      endAtMs: 150,
      createdAtMs: 200,
    });
    assert.equal(receipt.status, "purged");
    assert.equal(receipt.purge.ledgerUsageDeleted, 1);
    assert.equal(receipt.purge.shadowRecordsDeleted, 1);
    assert.equal(receipt.purge.physicalRemoved, 2);
    await assert.rejects(stat(paths.claudeDesktopShadowCanonicalFile), { code: "ENOENT" });
    await assert.rejects(stat(paths.claudeDesktopPricingCacheFile), { code: "ENOENT" });
    assert.equal((await stat(paths.claudeDesktopShadowLedgerFile)).isFile(), true);
    assert.equal((await stat(paths.claudeDesktopShadowStateFile)).isFile(), true);

    ledger = openClaudeDesktopLedgerPrototype(paths.claudeDesktopShadowLedgerFile);
    assert.deepEqual(ledger.mergeUsageCandidates([candidate()]), {
      inserted: 0,
      superseded: 0,
      tombstoned: 1,
    });
    assert.equal(ledger.providerSnapshot(PROVIDER).winnerCount, 0);
    ledger.close();

    store = openClaudeDesktopShadowStore({
      statePath: paths.claudeDesktopShadowStateFile,
      enabled: true,
    });
    assert.equal(store.ingest([{
      kind: "usage",
      sourceGeneration: 1,
      eventTimeMs: 100,
      recordKey: KEY_A,
      payloadDigest: KEY_B,
      revision: 1,
    }]).tombstoned, 1);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
