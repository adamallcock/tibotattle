import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_DESKTOP_PRICING_CACHE_PROVIDER,
  ClaudeDesktopPricingCacheError,
  claudeDesktopPricingProjectionPayloadSha256,
  openClaudeDesktopPricingCache,
  readClaudeDesktopPricingCache,
} from "../src/claude-desktop-pricing-cache.js";
import { createClaudeDesktopLedgerCandidate } from "../src/claude-desktop-incremental-refresh.js";
import { openClaudeDesktopLedgerPrototype } from "../src/claude-desktop-ledger-prototype.js";

async function createPricingSummary(root, { final = false } = {}) {
  const ledger = openClaudeDesktopLedgerPrototype(join(root, final ? "ledger-final.sqlite" : "ledger.sqlite"));
  const candidate = createClaudeDesktopLedgerCandidate({
    sourceKey: "a".repeat(64),
    sourceGeneration: 1,
    candidate: {
      provider: CLAUDE_DESKTOP_PRICING_CACHE_PROVIDER,
      occurrenceMaterial: "b".repeat(64),
      eventTime: new Date(final ? 1784894460000 : 1784894400000).toISOString(),
      modelDeclaration: {
        modelId: "claude-sonnet-4-6",
        modelRecognition: "recognized",
        modelFingerprint: null,
      },
      billingSurface: "claude_subscription",
      outputKind: "provider_reported_combined",
      totalInputContextTokens: 80,
      components: {
        inputUncachedTokens: 10,
        inputCacheReadTokens: 30,
        inputCacheWriteTokens: 40,
        inputCacheWrite5mTokens: 13,
        inputCacheWrite1hTokens: 27,
        outputCombinedTokens: final ? 29 : 3,
      },
      candidateVersion: "pricing-cache-test-v1",
    },
  });
  ledger.mergeUsageCandidates([candidate]);
  const projection = ledger.readPricingSummary();
  ledger.close();
  return projection;
}

test("Claude pricing cache creates owner-only storage and reports empty explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-pricing-cache-empty-"));
  const path = join(root, "private", "pricing.sqlite");
  const cache = openClaudeDesktopPricingCache(path);
  try {
    assert.deepEqual(cache.readProjection(), {
      status: "empty",
      schemaVersion: "claude-desktop-pricing-cache-v0.1",
      provider: CLAUDE_DESKTOP_PRICING_CACHE_PROVIDER,
      publicationGeneration: null,
      usageProjectionGeneration: null,
      payloadSha256: null,
      publishedAtMs: null,
      previousPayloadSha256: null,
      projection: null,
    });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "private"))).mode & 0o777, 0o700);
  } finally {
    cache.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("streaming Claude pricing summary remains bounded and changes on a winner correction", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-pricing-summary-10k-"));
  const ledger = openClaudeDesktopLedgerPrototype(join(root, "ledger.sqlite"));
  const candidateFor = (index, { output = 1, sourceGeneration = 1, version = "v1" } = {}) => (
    createClaudeDesktopLedgerCandidate({
      sourceKey: "a".repeat(64),
      sourceGeneration,
      candidate: {
        provider: CLAUDE_DESKTOP_PRICING_CACHE_PROVIDER,
        occurrenceMaterial: index.toString(16).padStart(64, "0"),
        eventTime: new Date(1784894400000 + index * 1_000).toISOString(),
        modelDeclaration: {
          modelId: "claude-sonnet-4-6",
          modelRecognition: "recognized",
          modelFingerprint: null,
        },
        billingSurface: "claude_subscription",
        outputKind: "provider_reported_combined",
        totalInputContextTokens: 2,
        components: {
          inputUncachedTokens: 1,
          inputCacheReadTokens: 0,
          inputCacheWriteTokens: 1,
          inputCacheWrite5mTokens: 1,
          inputCacheWrite1hTokens: 0,
          outputCombinedTokens: output,
        },
        candidateVersion: `summary-${version}`,
      },
    })
  );
  try {
    ledger.mergeUsageCandidates(Array.from({ length: 10_000 }, (_, index) => candidateFor(index)));
    const first = ledger.readPricingSummary();
    assert.equal(first.eventCount, 10_000);
    assert.equal(first.usageProjectionGeneration, null);
    assert.equal(Object.hasOwn(first, "rows"), false);
    assert.ok(JSON.stringify(first).length < 2_048);

    ledger.mergeUsageCandidates([candidateFor(0, {
      output: 2,
      sourceGeneration: 2,
      version: "correction",
    })]);
    const corrected = ledger.readPricingSummary();
    assert.equal(corrected.eventCount, 10_000);
    assert.equal(corrected.usageProjectionGeneration, first.usageProjectionGeneration);
    assert.notEqual(corrected.pricingDigest, first.pricingDigest);
    assert.notEqual(corrected.payloadSha256, first.payloadSha256);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded Claude pricing summary publishes, replays exactly, and invalidates on correction", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-pricing-cache-replay-"));
  const projectionRoot = await mkdtemp(join(tmpdir(), "tibotattle-claude-pricing-cache-projection-"));
  const path = join(root, "pricing.sqlite");
  const first = await createPricingSummary(projectionRoot);
  const final = await createPricingSummary(projectionRoot, { final: true });
  const cache = openClaudeDesktopPricingCache(path);
  try {
    assert.equal(claudeDesktopPricingProjectionPayloadSha256(first), first.payloadSha256);
    const published = cache.publishProjection(first, { publishedAtMs: 100 });
    assert.deepEqual(published, {
      status: "published",
      reused: false,
      invalidated: false,
      publicationGeneration: 1,
      usageProjectionGeneration: null,
      payloadSha256: first.payloadSha256,
      previousPayloadSha256: null,
      publishedAtMs: 100,
    });
    assert.deepEqual(cache.readProjection().projection, first);

    const replay = cache.publishProjection(first, { publishedAtMs: 200 });
    assert.deepEqual(replay, {
      status: "reused",
      reused: true,
      invalidated: false,
      publicationGeneration: 1,
      usageProjectionGeneration: null,
      payloadSha256: first.payloadSha256,
      previousPayloadSha256: null,
      publishedAtMs: 100,
    });

    const correction = cache.publishProjection(final, { publishedAtMs: 300 });
    assert.deepEqual(correction, {
      status: "published",
      reused: false,
      invalidated: true,
      publicationGeneration: 2,
      usageProjectionGeneration: null,
      payloadSha256: final.payloadSha256,
      previousPayloadSha256: first.payloadSha256,
      publishedAtMs: 300,
    });
    assert.deepEqual(cache.readProjection().projection, final);
    assert.equal(cache.readProjection().previousPayloadSha256, first.payloadSha256);
  } finally {
    cache.close();
    await rm(root, { recursive: true, force: true });
    await rm(projectionRoot, { recursive: true, force: true });
  }
});

test("failed publication retains the last-good Claude pricing summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-pricing-cache-failure-"));
  const projectionRoot = await mkdtemp(join(tmpdir(), "tibotattle-claude-pricing-cache-failure-projection-"));
  const path = join(root, "pricing.sqlite");
  const first = await createPricingSummary(projectionRoot);
  const final = await createPricingSummary(projectionRoot, { final: true });
  const cache = openClaudeDesktopPricingCache(path);
  try {
    cache.publishProjection(first, { publishedAtMs: 100 });
    assert.throws(
      () => cache.publishProjection(final, {
        publishedAtMs: 200,
        failpoint: (point) => {
          if (point === "after_publication_write") throw new Error("test publication failure");
        },
      }),
      /test publication failure/,
    );
    const retained = cache.readProjection();
    assert.equal(retained.payloadSha256, first.payloadSha256);
    assert.deepEqual(retained.projection, first);
    assert.equal(retained.publicationGeneration, 1);
  } finally {
    cache.close();
    await rm(root, { recursive: true, force: true });
    await rm(projectionRoot, { recursive: true, force: true });
  }
});

test("cache rejects cross-provider, digest-mismatched, and privacy-unsafe summaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-pricing-cache-invalid-"));
  const projectionRoot = await mkdtemp(join(tmpdir(), "tibotattle-claude-pricing-cache-invalid-projection-"));
  const path = join(root, "pricing.sqlite");
  const first = await createPricingSummary(projectionRoot);
  const cache = openClaudeDesktopPricingCache(path);
  try {
    assert.throws(
      () => cache.publishProjection({ ...first, provider: "openai_codex" }),
      (error) => error instanceof ClaudeDesktopPricingCacheError
        && error.code === "claude_desktop_pricing_cache_projection_identity",
    );
    assert.throws(
      () => cache.publishProjection({ ...first, payloadSha256: "0".repeat(64) }),
      (error) => error instanceof ClaudeDesktopPricingCacheError
        && error.code === "claude_desktop_pricing_cache_projection_digest",
    );
    const privateValue = {
      ...first,
      totalUsd: "/Users/private-secret",
    };
    privateValue.payloadSha256 = claudeDesktopPricingProjectionPayloadSha256(privateValue);
    assert.throws(
      () => cache.publishProjection(privateValue),
      (error) => error instanceof ClaudeDesktopPricingCacheError
        && error.code === "claude_desktop_pricing_cache_projection_privacy",
    );
    assert.throws(
      () => cache.publishProjection({
        ...first,
        metadata: { detail: "/Users/private-secret" },
      }),
      (error) => error instanceof ClaudeDesktopPricingCacheError
        && error.code === "claude_desktop_pricing_cache_projection_shape",
    );
  } finally {
    cache.close();
    await rm(root, { recursive: true, force: true });
    await rm(projectionRoot, { recursive: true, force: true });
  }
});

test("corrupt persisted payload fails closed instead of serving it", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-pricing-cache-corrupt-"));
  const projectionRoot = await mkdtemp(join(tmpdir(), "tibotattle-claude-pricing-cache-corrupt-projection-"));
  const path = join(root, "pricing.sqlite");
  const first = await createPricingSummary(projectionRoot);
  const cache = openClaudeDesktopPricingCache(path);
  try {
    cache.publishProjection(first);
    cache.close();
    const database = new DatabaseSync(path);
    database.prepare("UPDATE pricing_publication SET payload_json = ? WHERE provider = ?")
      .run("{}", CLAUDE_DESKTOP_PRICING_CACHE_PROVIDER);
    database.close();
    assert.throws(
      () => readClaudeDesktopPricingCache(path),
      (error) => error instanceof ClaudeDesktopPricingCacheError
        && error.code === "claude_desktop_pricing_cache_corrupt",
    );
  } finally {
    if (cache) cache.close();
    await rm(root, { recursive: true, force: true });
    await rm(projectionRoot, { recursive: true, force: true });
  }
});

test("unsafe cache database permissions fail closed", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX owner-only mode is not available on Windows");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "tibotattle-claude-pricing-cache-perms-"));
  const path = join(root, "pricing.sqlite");
  const cache = openClaudeDesktopPricingCache(path);
  try {
    cache.close();
    await chmod(path, 0o644);
    assert.throws(
      () => openClaudeDesktopPricingCache(path),
      (error) => error instanceof ClaudeDesktopPricingCacheError
        && error.code === "claude_desktop_pricing_cache_storage_unsafe",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
