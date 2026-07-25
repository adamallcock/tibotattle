import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexAppServerChildEnv,
  sanitizeCodexAccountSnapshot,
  sanitizeCodexAccountSnapshotWithSecretLoader,
} from "../src/codex-app-server.js";
import { summarizeCcusage } from "../src/ccusage.js";
import {
  buildCacheValidationSidecar,
  observationsWithEffectiveDerived,
  parseArgs,
  selectCacheValidationBaseline,
  validateLocalHistoryCacheProvenance,
} from "../src/cli.js";
import { stableJson } from "../src/storage.js";
import { defaultContaminationFile, defaultInferenceFile, defaultTransitionFile, frozenTransitionFile } from "../src/storage.js";
import {
  classifyToolCall,
  appendedRolloutSourcesAreAfterEnd,
  canonicalComponentAvailability,
  createSnapshotLineage,
  extractToolObservations,
  hasForkReplayPrefix,
  normalizeTokenUsage,
  scanAndPriceCodexLogs,
  scanCodexLogEvents,
} from "../src/codex-log-scan.js";

test("fork snapshot lineage shares ancestors instead of copying their keys", () => {
  const chain = [];
  let parent = null;
  for (let index = 0; index < 1_000; index += 1) {
    const node = createSnapshotLineage(parent);
    node.add(`snapshot-${index}`);
    chain.push(node);
    parent = node;
  }
  assert.equal(chain.at(-1).has("snapshot-0"), true);
  assert.equal(chain.at(-1).has("snapshot-999"), true);
  assert.equal(chain.reduce((sum, node) => sum + node.localSize(), 0), 1_000);
});

test("Codex snapshot sanitizer drops balances and all reset-credit data", () => {
  const result = sanitizeCodexAccountSnapshot({
    account: { account: { email: "private.owner@example.test", planType: "pro" } },
    rateLimits: {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 123 },
        secondary: null,
        planType: "pro",
        credits: { hasCredits: true, unlimited: false, balance: "private" },
      },
      rateLimitResetCredits: {
        availableCount: 1,
        credits: [{ id: "private-credit-id" }],
      },
    },
    accountUsage: {
      dailyUsageBuckets: [{ startDate: "2026-07-23", tokens: 10 }],
      summary: { lifetimeTokens: 100, currentStreakDays: 2 },
    },
  }, "2026-07-23T00:00:00.000Z", { accountHmacKey: "test-account-hmac-key" });

  const serialized = JSON.stringify(result);
  assert.equal(result.earnedResetCount, undefined);
  assert.equal(result.canonical.credits.hasCredits, true);
  assert.equal(result.accountScope.status, "available");
  assert.equal(result.officialUsageSummary.lifetimeTokens, 100);
  assert.equal(serialized.includes("private"), false);
  assert.equal(serialized.includes("example.test"), false);
  assert.equal(serialized.includes("credit-id"), false);
  assert.equal(serialized.includes("availableCount"), false);
});

test("Codex app-server child environment never inherits the account HMAC key", () => {
  const environment = codexAppServerChildEnv({
    PATH: "/safe/bin",
    APP_USAGEMONITOR_ACCOUNT_HMAC_KEY: "private-hmac-key",
  });
  assert.deepEqual(environment, { PATH: "/safe/bin" });
});

test("async account credential loading derives scope in memory and zeroes the disposable copy", async () => {
  const disposable = Buffer.alloc(32, 76);
  const result = await sanitizeCodexAccountSnapshotWithSecretLoader({
    account: { account: { email: "private.owner@example.test", planType: "pro" } },
    rateLimits: { rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 123 },
      planType: "pro",
    } },
    accountUsage: { dailyUsageBuckets: [] },
  }, "2026-07-23T00:00:00.000Z", {
    loadAccountObservationSecret: async () => disposable,
  });
  assert.equal(result.accountScope.status, "available");
  assert.deepEqual(disposable, Buffer.alloc(32));
  assert.equal(JSON.stringify(result).includes("private.owner"), false);
});

test("locked, denied, and malformed credential loads remain safely unattributed", async () => {
  const raw = {
    account: { account: { email: "private.owner@example.test", planType: "pro" } },
    rateLimits: { rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 123 },
      planType: "pro",
    } },
    accountUsage: { dailyUsageBuckets: [] },
  };
  for (const loadAccountObservationSecret of [
    async () => { throw new Error("DO-NOT-LEAK-locked"); },
    async () => { const error = new Error("DO-NOT-LEAK-denied"); error.code = "denied"; throw error; },
    async () => Buffer.alloc(31, 1),
  ]) {
    const result = await sanitizeCodexAccountSnapshotWithSecretLoader(raw, "2026-07-23T00:00:00.000Z", {
      loadAccountObservationSecret,
    });
    assert.deepEqual(result.accountScope, {
      status: "unavailable",
      reason: "credential_unavailable",
      version: "openai-account-v1",
      scopeId: null,
      planType: "pro",
    });
    assert.equal(JSON.stringify(result).includes("DO-NOT-LEAK"), false);
  }
});

test("ccusage summary keeps token categories disjoint", () => {
  const result = summarizeCcusage({
    daily: [{
      date: "2026-07-23",
      totalTokens: 175,
      costUSD: 1,
      models: {
        model: {
          inputTokens: 100,
          cacheReadTokens: 50,
          cacheCreationTokens: 0,
          outputTokens: 25,
          reasoningOutputTokens: 5,
          totalTokens: 175,
          isFallback: false,
        },
      },
    }],
    totals: {
      inputTokens: 100,
      cacheReadTokens: 50,
      cacheCreationTokens: 0,
      outputTokens: 25,
      reasoningOutputTokens: 5,
      totalTokens: 175,
      costUSD: 1,
    },
  });
  assert.equal(result.totals.totalTokens, 175);
  assert.equal(result.byModel.model.reasoningOutputTokens, 5);
  assert.match(result.limitations[0], /cacheCreationTokens as zero/);
});

test("CLI options reject missing values with an actionable error", () => {
  assert.throws(() => parseArgs(["capture", "--label"]), /--label requires a value/);
  assert.throws(() => parseArgs(["report", "--data-file", "--json"]), /--data-file requires a value/);
  assert.throws(() => parseArgs(["quality", "--collector-file"]), /--collector-file requires a value/);
  assert.equal(parseArgs(["rotate-local-identity", "--confirm"]).confirm, true);
  const exportSet = parseArgs([
    "export-set", "--workspace", "./workspace", "--directory", "./set", "--resume",
    "--max-records-per-chunk", "1000", "--max-bundle-bytes", "1048576",
    "--max-artifact-bytes", "1114112",
  ]);
  assert.equal(exportSet.resume, true);
  assert.equal(exportSet.maximumRecordsPerChunk, 1000);
  assert.equal(exportSet.maximumCanonicalBundleBytes, 1048576);
  assert.equal(exportSet.maximumEncodedArtifactBytes, 1114112);
  const deletion = parseArgs([
    "delete-local-export", "--workspace", "./workspace", "--directory", "./set",
    "--confirm-deletion", "ABCDEFGHJKLM2345",
  ]);
  assert.equal(deletion.confirmDeletionToken, "ABCDEFGHJKLM2345");
  assert.throws(
    () => parseArgs(["delete-local-export", "--confirm-deletion"]),
    /--confirm-deletion requires a value/,
  );
});

test("cached history requires a matching rollout-source fingerprint or explicit stale override", () => {
  const cached = { sourceProvenance: { schemaVersion: "codex-rollout-source-fingerprint-v1", fingerprint: "a", fileCount: 1, files: [{ keyHash: "one", ino: 1, birthtimeMs: 2, mtimeMs: 3, size: 100 }] } };
  const current = { schemaVersion: "codex-rollout-source-fingerprint-v1", fingerprint: "b", fileCount: 1, files: [{ keyHash: "one", ino: 2, birthtimeMs: 2, mtimeMs: 3, size: 100 }] };
  assert.throws(() => validateLocalHistoryCacheProvenance(cached, current), /does not match/);
  assert.equal(validateLocalHistoryCacheProvenance(cached, current, { allowStale: true }).status, "stale_override");
  const rewritten = { ...cached.sourceProvenance, files: [{ keyHash: "one", ino: 1, birthtimeMs: 2, mtimeMs: 4, size: 100 }] };
  assert.throws(() => validateLocalHistoryCacheProvenance(cached, rewritten), /does not match/);
  const appended = { ...cached.sourceProvenance, fingerprint: "changed-by-append", files: [{ keyHash: "one", ino: 1, birthtimeMs: 2, mtimeMs: 4, size: 150 }] };
  assert.throws(() => validateLocalHistoryCacheProvenance(cached, appended), /does not match/);
  assert.equal(validateLocalHistoryCacheProvenance(cached, appended, { appendedAfterEndOnly: true }).status, "current_after_end_growth");
  assert.equal(validateLocalHistoryCacheProvenance(cached, appended, { allowStale: true }).status, "stale_override");
});

test("cache suffix validation accepts only complete records after the fixed interval", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-usagemonitor-cache-suffix-"));
  const path = join(root, "rollout.jsonl");
  const priorText = `${JSON.stringify({ timestamp: "2026-07-23T00:00:00.000Z", type: "event_msg" })}\n`;
  try {
    await writeFile(path, priorText);
    const metadata = await stat(path);
    const prior = { keyHash: "one", ino: metadata.ino, birthtimeMs: Math.trunc(metadata.birthtimeMs), mtimeMs: Math.trunc(metadata.mtimeMs), size: metadata.size };
    await writeFile(path, `${priorText}${JSON.stringify({ timestamp: "2026-07-24T05:00:00.000Z", type: "event_msg" })}\n`);
    const nextMetadata = await stat(path);
    const current = {
      files: [{ ...prior, mtimeMs: Math.trunc(nextMetadata.mtimeMs), size: nextMetadata.size }],
      sourcePathByKeyHash: { one: path },
    };
    assert.equal(await appendedRolloutSourcesAreAfterEnd({
      cachedProvenance: { files: [prior] },
      currentProvenance: current,
      endAt: "2026-07-24T04:15:00.000Z",
    }), true);
    await writeFile(path, `${priorText}${JSON.stringify({ timestamp: "2026-07-24T04:00:00.000Z", type: "event_msg" })}\n`);
    const inRangeMetadata = await stat(path);
    current.files[0] = { ...prior, mtimeMs: Math.trunc(inRangeMetadata.mtimeMs), size: inRangeMetadata.size };
    assert.equal(await appendedRolloutSourcesAreAfterEnd({
      cachedProvenance: { files: [prior] },
      currentProvenance: current,
      endAt: "2026-07-24T04:15:00.000Z",
    }), false);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("cache validation sidecar advances only a matching cache and interval without retaining paths", () => {
  const cached = { sourceProvenance: { schemaVersion: "codex-rollout-source-fingerprint-v1", fingerprint: "cache-a", files: [] } };
  const current = {
    schemaVersion: "codex-rollout-source-fingerprint-v1",
    fingerprint: "current-b",
    files: [],
    sourcePathByKeyHash: { one: "/private/path" },
  };
  const sidecar = buildCacheValidationSidecar(cached, current, {
    startAt: "2026-05-17T00:00:00.000Z",
    endAt: "2026-07-24T04:15:00.000Z",
    verifiedAt: "2026-07-24T05:00:00.000Z",
  });
  assert.equal(JSON.stringify(sidecar).includes("/private/path"), false);
  assert.equal(selectCacheValidationBaseline(cached, sidecar, {
    startAt: "2026-05-17T00:00:00.000Z",
    endAt: "2026-07-24T04:15:00.000Z",
  }).fingerprint, "current-b");
  assert.equal(selectCacheValidationBaseline(cached, { ...sidecar, cacheFingerprint: "other" }, {
    startAt: "2026-05-17T00:00:00.000Z",
    endAt: "2026-07-24T04:15:00.000Z",
  }).fingerprint, "cache-a");
});

test("current parser defaults cannot overwrite the frozen Milestone 1 transition artifact", () => {
  assert.match(defaultTransitionFile(), /transitions-v0\.3\.2\.json$/);
  assert.match(defaultInferenceFile(), /inference-v0\.3\.2\.json$/);
  assert.match(defaultContaminationFile(), /contamination-v0\.3\.2\.json$/);
  assert.match(frozenTransitionFile(), /transitions-v0\.3\.json$/);
  assert.notEqual(defaultTransitionFile(), frozenTransitionFile());
});

test("report inputs apply an effective derived correction without mutating raw observations", () => {
  const raw = [{
    observationId: "legacy",
    windows: [{ local: { runcost: { totalUsd: 1, totalTokens: 100, warningCounts: { unknown_model: 1 } }, diagnostics: { old: true } } }],
  }];
  const before = stableJson(raw);
  const corrected = observationsWithEffectiveDerived(raw, {
    effectiveByOriginalId: {
      legacy: {
        originalObservationId: "legacy",
        effectiveRecordId: "correction-a",
        derived: {
          aggregateTokenTotal: 90,
          apiPricedCostUsd: 1,
          tokenComponents: { input_uncached_tokens: 90 },
          byModel: { model: { events: 1 } },
          warnings: [],
          diagnostics: { replayed: 10 },
          pricingBasis: "standard_openai_api_prices_not_codex_subscription_credits",
        },
      },
    },
  });

  assert.equal(stableJson(raw), before);
  assert.equal(corrected[0].windows[0].local.apiPricing.totalTokens, 90);
  assert.deepEqual(corrected[0].windows[0].local.apiPricing.warningCounts, {});
  assert.equal(corrected[0].windows[0].local.apiPricing.correctionRecordId, "correction-a");
});

test("Codex sanitizer rejects malformed quota windows instead of persisting invalid dates", () => {
  const result = sanitizeCodexAccountSnapshot({
    account: null,
    rateLimits: {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: "25", windowDurationMins: 300, resetsAt: 123 },
      },
    },
    accountUsage: { dailyUsageBuckets: [] },
  }, "2026-07-23T00:00:00.000Z");
  assert.equal(result.canonical.primary, null);
});

test("Codex sanitizer rejects quota percentages outside zero to one hundred", () => {
  const result = sanitizeCodexAccountSnapshot({
    account: null,
    rateLimits: {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 101, windowDurationMins: 300, resetsAt: 123 },
        secondary: { usedPercent: -1, windowDurationMins: 10080, resetsAt: 456 },
        planType: "pro",
      },
    },
    accountUsage: null,
  }, "2026-07-23T00:00:00.000Z");
  assert.equal(result.canonical.primary, null);
  assert.equal(result.canonical.secondary, null);
});

test("local usage normalization rejects negative and non-numeric counters", () => {
  assert.equal(normalizeTokenUsage({ input_tokens: -1 }), null);
  assert.equal(normalizeTokenUsage({ input_tokens: "10" }), null);
  assert.deepEqual(normalizeTokenUsage({ input_tokens: 10, output_tokens: 2 }), {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  });
});

test("inconsistent source token components are unavailable for export rather than silently clamped", () => {
  const present = {
    input_tokens: true,
    cached_input_tokens: true,
    cache_write_input_tokens: true,
    output_tokens: true,
    reasoning_output_tokens: true,
    total_tokens: true,
  };
  assert.deepEqual(canonicalComponentAvailability(present, {
    input_tokens: 10,
    cached_input_tokens: 9,
    cache_write_input_tokens: 2,
    output_tokens: 5,
    reasoning_output_tokens: 6,
  }), {
    input_uncached_tokens: false,
    input_cache_read_tokens: false,
    input_cache_write_tokens: false,
    output_text_tokens: false,
    output_reasoning_tokens: false,
  });
});

test("tool names collapse to privacy-safe aggregate classes", () => {
  assert.equal(classifyToolCall("functions.exec"), "tool_gateway");
  assert.equal(classifyToolCall("exec"), "tool_gateway");
  assert.equal(classifyToolCall("mcp__example__search"), "mcp");
  assert.equal(classifyToolCall("thread_spawn"), "subagent");
  assert.equal(classifyToolCall("wait_agent", "collaboration"), "subagent");
  assert.equal(classifyToolCall("private_custom_name"), "other");
});

test("tool observation extraction separates client wrappers from typed Responses units", () => {
  assert.deepEqual(extractToolObservations({
    type: "custom_tool_call",
    name: "exec",
    input: "const a = await tools.web__run({private: true}); const b = await tools.exec_command({cmd: secret});",
  }), [
    { toolClass: "web_search", sourceKind: "client_nested_tool_call", serverBillableUnit: null },
    { toolClass: "local_shell", sourceKind: "client_nested_tool_call", serverBillableUnit: null },
  ]);
  assert.deepEqual(extractToolObservations({ type: "web_search_call", id: "private" }), [{
    toolClass: "web_search",
    sourceKind: "responses_typed_output_item",
    serverBillableUnit: "responses_web_search_call",
  }]);
  assert.deepEqual(extractToolObservations({ type: "shell_call", id: "private" }), [{
    toolClass: "hosted_shell",
    sourceKind: "responses_typed_output_item",
    serverBillableUnit: null,
  }]);
});

test("fork lineage marks a rollout as containing a replay prefix", async () => {
  const directory = await mkdtemp(join(tmpdir(), "app-usagemonitor-test-"));
  try {
    const forked = join(directory, "forked.jsonl");
    const ordinary = join(directory, "ordinary.jsonl");
    await writeFile(forked, `${JSON.stringify({ type: "session_meta", payload: { forked_from_id: "parent" } })}\n`);
    await writeFile(ordinary, `${JSON.stringify({ type: "session_meta", payload: {} })}\n`);
    assert.equal(await hasForkReplayPrefix(forked), true);
    assert.equal(await hasForkReplayPrefix(ordinary), false);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("forked cumulative snapshots are excluded while new fork usage is retained", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "app-usagemonitor-scan-test-"));
  try {
    const sessions = join(codexHome, "sessions");
    await mkdir(sessions, { recursive: true });
    const usage = (input_tokens, total_tokens = input_tokens) => ({
      input_tokens,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens,
    });
    const record = (timestamp, total, last) => JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: total, last_token_usage: last },
      },
    });
    const parent = [
      JSON.stringify({ timestamp: "2026-07-23T00:00:00.000Z", type: "session_meta", payload: { id: "controller-parent-secret" } }),
      JSON.stringify({ timestamp: "2026-07-23T00:00:00.000Z", type: "turn_context", payload: { model: "gpt-test" } }),
      record("2026-07-23T00:00:01.000Z", usage(100), usage(100)),
    ].join("\n");
    const fork = [
      JSON.stringify({ timestamp: "2026-07-23T00:01:00.000Z", type: "session_meta", payload: { forked_from_id: "controller-parent-secret" } }),
      JSON.stringify({ timestamp: "2026-07-23T00:01:00.001Z", type: "turn_context", payload: { model: "gpt-test" } }),
      record("2026-07-23T00:01:00.002Z", usage(100), usage(100)),
      record("2026-07-23T00:01:01.000Z", usage(160), usage(60)),
    ].join("\n");
    await writeFile(join(sessions, "rollout-2026-07-23T00-00-00-parent.jsonl"), `${parent}\n`);
    await writeFile(join(sessions, "rollout-2026-07-23T00-01-00-fork.jsonl"), `${fork}\n`);
    const result = await scanAndPriceCodexLogs({
      codexHome,
      startAt: "2026-07-22T23:59:00.000Z",
      endAt: "2026-07-23T00:02:00.000Z",
      priceCards: [{
        schema_version: "0.1",
        id: "openai:gpt-test:test",
        provider: "openai",
        model: "gpt-test",
        components: [{
          usage_component: "input_uncached_tokens",
          unit: "token",
          price: { amount: "1", currency: "USD", per: "1" },
        }],
        source: {
          name: "test",
          url: "https://example.invalid/pricing",
          retrieved_at: "2026-07-23T00:00:00.000Z",
        },
      }],
    });
    assert.equal(result.eventCount, 2);
    assert.equal(result.totalTokens, 160);
    assert.equal(result.runcost.totalUsd, 160);
    assert.equal(result.runcost.priceResolution.serviceTier.observed, null);
    assert.equal(result.runcost.priceResolution.serviceTier.apiPriceAssumption, "standard");
    assert.equal(result.diagnostics.forkReplayEventsSkipped, 1);
    assert.equal(result.diagnostics.usageBearingRollouts, 2);
    assert.equal(result.diagnostics.concurrentLocalUsageDetected, true);
    assert.deepEqual(Object.keys(result.runcost.byModel), ["gpt-test"]);

    const sibling = [
      JSON.stringify({ timestamp: "2026-07-23T00:01:30.000Z", type: "session_meta", payload: { id: "sibling" } }),
      JSON.stringify({ timestamp: "2026-07-23T00:01:30.001Z", type: "turn_context", payload: { model: "gpt-test" } }),
      JSON.stringify({ timestamp: "2026-07-23T00:01:30.500Z", type: "event_msg", payload: { type: "task_started", turn_id: "sibling-turn-secret" } }),
      record("2026-07-23T00:01:31.000Z", usage(20), usage(20)),
    ].join("\n");
    await writeFile(join(sessions, "rollout-2026-07-23T00-01-30-sibling.jsonl"), `${sibling}\n`);
    const controllerExcluded = await scanAndPriceCodexLogs({
      codexHome,
      startAt: "2026-07-22T23:59:00.000Z",
      endAt: "2026-07-23T00:02:00.000Z",
      priceCards: [{
        schema_version: "0.1",
        id: "openai:gpt-test:test",
        provider: "openai",
        model: "gpt-test",
        components: [{
          usage_component: "input_uncached_tokens",
          unit: "token",
          price: { amount: "1", currency: "USD", per: "1" },
        }],
        source: { name: "test", url: "https://example.invalid/pricing", retrieved_at: "2026-07-23T00:00:00.000Z" },
      }],
      excludeSessionIds: ["controller-parent-secret"],
    });
    assert.equal(controllerExcluded.totalTokens, 80);
    assert.equal(controllerExcluded.diagnostics.excludedRollouts, 1);
    assert.equal(controllerExcluded.diagnostics.lineageParentsMissing, 0);
    assert.equal(controllerExcluded.diagnostics.forkReplayEventsSkipped, 1);
    assert.equal(controllerExcluded.diagnostics.usageBearingRollouts, 2);
    assert.equal(controllerExcluded.diagnostics.activeTaskRolloutsAtEnd, 1);
    assert.equal(JSON.stringify(controllerExcluded).includes("controller-parent-secret"), false);
    assert.equal(JSON.stringify(controllerExcluded).includes("sibling"), false);
    assert.equal(JSON.stringify(controllerExcluded).includes("sibling-turn-secret"), false);
  } finally {
    await rm(codexHome, { recursive: true });
  }
});

test("activity scans can exclude exactly the controller session without exposing its identifier", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "app-usagemonitor-controller-test-"));
  try {
    const sessions = join(codexHome, "sessions");
    await mkdir(sessions, { recursive: true });
    const usageRecord = (sessionId, timestamp) => [
      JSON.stringify({ timestamp, type: "session_meta", payload: { id: sessionId } }),
      JSON.stringify({ timestamp, type: "turn_context", payload: { model: "gpt-test" } }),
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 10, total_tokens: 10 },
            last_token_usage: { input_tokens: 10, total_tokens: 10 },
          },
        },
      }),
    ].join("\n");
    await writeFile(join(sessions, "rollout-2026-07-23T00-00-00-controller.jsonl"), `${usageRecord("controller-session-secret", "2026-07-23T00:00:00.000Z")}\n`);
    await writeFile(join(sessions, "rollout-2026-07-23T00-00-01-worker.jsonl"), `${usageRecord("worker-session", "2026-07-23T00:00:01.000Z")}\n`);

    const observed = [];
    const result = await scanCodexLogEvents({
      codexHome,
      startAt: "2026-07-22T23:59:00.000Z",
      endAt: "2026-07-23T00:02:00.000Z",
      excludeSessionIds: ["controller-session-secret"],
      onUsage: (event) => observed.push(event),
    });
    assert.equal(observed.length, 1);
    assert.equal(result.diagnostics.excludedRollouts, 1);
    assert.equal(JSON.stringify(result).includes("controller-session-secret"), false);
    assert.equal(JSON.stringify(observed).includes("worker-session"), false);
  } finally {
    await rm(codexHome, { recursive: true });
  }
});
