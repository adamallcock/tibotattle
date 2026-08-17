import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeDesktopShadowBatch,
  ingestClaudeDesktopShadowBatch,
  runClaudeDesktopShadowRefresh,
} from "../src/claude-desktop-shadow-refresh.js";
import { openClaudeDesktopShadowStore } from "../src/claude-desktop-shadow-store.js";

const KEY = "a".repeat(64);

async function makeRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await chmod(root, 0o700);
  return root;
}

function incrementalInput({ privateCanary = false } = {}) {
  const candidate = {
    candidateVersion: "claude-transcript-usage-candidate-v0.2",
    provider: "anthropic_claude_code",
    eventTime: "2026-07-24T12:00:00.000Z",
    modelDeclaration: {
      modelId: "claude-sonnet-4-6",
      modelRecognition: "recognized",
      modelFingerprint: null,
    },
    billingSurface: "claude_subscription",
    speedMode: "standard",
    components: {
      inputUncachedTokens: 10,
      inputCacheReadTokens: 30,
      inputCacheWriteTokens: 40,
      inputCacheWrite5mTokens: 30,
      inputCacheWrite1hTokens: 10,
      outputCombinedTokens: 7,
    },
    totalInputContextTokens: 80,
    surface: "local_interactive_unclassified",
    agentScope: "root",
    lineageDisposition: "standalone",
    toolClassCounts: {
      web_search: 0,
      file_search: 0,
      code_interpreter: 0,
      hosted_shell: 0,
      computer_use: 0,
      mcp: 0,
      apply_patch: 0,
      local_shell: 0,
      subagent: 0,
      tool_gateway: 0,
      other: 0,
      unknown: 0,
    },
    sessionScopeId: `session:v1:${"e".repeat(64)}`,
    occurrenceMaterial: "b".repeat(64),
  };
  if (privateCanary) candidate.privatePromptCanary = "must-never-leave-this-function";
  return {
    canonical: {
      sourceCount: 1,
      dirtyGroupCount: 1,
      parsedLines: 2,
      snapshot: { sources: 1, groups: 1, tools: 0, dirtyGroups: 1 },
      candidates: [{
        sourceKey: KEY,
        sourceGeneration: 2,
        candidate,
      }],
    },
    quota: {
      observations: [{
        accountScope: KEY,
        meterId: "five_hour",
        observedAtMs: 1_783_000_000_000,
        utilizationPercent: 12,
        resetsAtMs: null,
        revision: 1,
      }],
    },
    projection: {
      provider: "anthropic_claude_code",
      generation: 1,
      highWater: 1,
      payloadSha256: KEY,
      rowCount: 1,
    },
    pricingSummary: {
      schemaVersion: "claude-desktop-pricing-summary-v0.1",
      provider: "anthropic_claude_code",
      productProvider: "anthropic_claude_code",
      accountingVendor: "anthropic",
      usageProjectionGeneration: 1,
      payloadSha256: KEY,
      eventCount: 1,
      totalUsd: "0",
      coverageStatus: "unpriced",
      coverageCounts: { fullyPriced: 0, partiallyPriced: 0, unpriced: 1 },
      warningCodes: ["unknown_model"],
      pricingDigest: "f".repeat(64),
    },
    acceptedAtMs: 1_783_000_000_000,
  };
}

test("shadow batch is digest-only and can be merged from a real incremental-shaped result", async () => {
  const batch = buildClaudeDesktopShadowBatch(incrementalInput());
  assert.deepEqual(batch.counts, {
    records: 1,
    usageRecords: 1,
    quotaRecords: 0,
    artifacts: 4,
  });
  assert.throws(
    () => buildClaudeDesktopShadowBatch({ ...incrementalInput({ privateCanary: true }) }),
    (error) => error.code === "claude_desktop_shadow_refresh_candidate",
  );
  assert.equal(JSON.stringify(batch).includes(KEY), false);

  const root = await makeRoot("tibotattle-claude-shadow-refresh-");
  try {
    const store = openClaudeDesktopShadowStore({ statePath: join(root, "shadow.sqlite"), enabled: true });
    try {
      const first = ingestClaudeDesktopShadowBatch(store, incrementalInput());
      assert.equal(first.status, "enabled");
      assert.equal(first.records.inserted, 1);
      assert.equal(first.artifacts.inserted, 4);
      const replay = incrementalInput();
      replay.acceptedAtMs += 1;
      const second = ingestClaudeDesktopShadowBatch(store, replay);
      assert.equal(second.records.duplicates, 1);
      assert.equal(second.artifacts.duplicates, 4);
      assert.equal(store.snapshot().counts.records, 1);
      assert.equal(store.snapshot().counts.artifacts, 4);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shadow refresh defaults to disabled and does not create state", async () => {
  const root = await makeRoot("tibotattle-claude-shadow-refresh-disabled-");
  try {
    const statePath = join(root, "shadow.sqlite");
    const result = await runClaudeDesktopShadowRefresh({
      shadowStatePath: statePath,
      incrementalResult: incrementalInput(),
    });
    assert.equal(result.shadow.status, "disabled");
    await assert.rejects(stat(statePath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enabled shadow refresh injects only the digest sink and keeps the store separate", async () => {
  const root = await makeRoot("tibotattle-claude-shadow-refresh-enabled-");
  try {
    const statePath = join(root, "shadow.sqlite");
    let observedShadow;
    const result = await runClaudeDesktopShadowRefresh({
      shadowStatePath: statePath,
      enabled: true,
      refreshOptions: {
        sentinel: "not-forwarded-to-shadow",
        pricingCachePath: join(root, "pricing.sqlite"),
      },
      incrementalRefresh: async ({ shadowSink }) => {
        assert.equal(typeof shadowSink, "function");
        observedShadow = await shadowSink(incrementalInput());
        return { status: "completed", refreshOnly: true, shadow: observedShadow };
      },
    });
    assert.equal(result.shadow.records.inserted, 1);
    assert.equal(result.shadow.artifacts.inserted, 4);
    assert.equal(observedShadow.batchCounts.records, 1);

    const store = openClaudeDesktopShadowStore({ statePath, enabled: true });
    try {
      assert.deepEqual(store.snapshot().counts, {
        records: 1,
        artifacts: 4,
        tombstones: 0,
        receipts: 0,
      });
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enabled shadow refresh refuses the row-rich debug pricing path", async () => {
  const root = await makeRoot("tibotattle-claude-shadow-refresh-pricing-gate-");
  try {
    await assert.rejects(
      runClaudeDesktopShadowRefresh({
        shadowStatePath: join(root, "shadow.sqlite"),
        enabled: true,
        incrementalRefresh: async () => ({ status: "must-not-run" }),
      }),
      (error) => error.code === "claude_desktop_shadow_refresh_pricing_cache_required",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
