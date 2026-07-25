import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BundleVerificationError, verifyLocalMetadataBundleFiles } from "../src/bundle-verifier.js";
import { buildLocalMetadataBundle, writeLocalMetadataBundle } from "../src/metadata-exporter.js";
import { verifyPrivacySafeBundle } from "../src/export-privacy.js";
import { stableJson } from "../src/storage.js";

const SECRET = Buffer.alloc(32, 23);
const BUNDLE_ID = `bundle:v1:${"V".repeat(43)}`;

async function localPair({ marker = false, markerCount = marker ? 1 : 0 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-verify-"));
  const home = join(directory, "codex-home");
  await mkdir(join(home, "sessions"), { recursive: true });
  const result = await buildLocalMetadataBundle({
    startAt: "2026-07-24T12:00:00.000Z",
    endAt: "2026-07-24T13:00:00.000Z",
    createdAt: "2026-07-24T13:00:00.000Z",
    codexHome: home,
    secret: SECRET,
    bundleId: BUNDLE_ID,
    activityMarkers: Array.from({ length: markerCount }, (_, index) => ({
      markerId: index === 0
        ? "019f9010-1111-7111-8111-111111111111"
        : "019f9010-2222-7222-8222-222222222222",
      observedAt: index === 0 ? "2026-07-24T12:20:00.000Z" : "2026-07-24T12:40:00.000Z",
      surface: "quiet_period",
      state: "pulse",
      agenticPoolCoupling: "not_applicable",
      planType: "pro",
      planVariant: "pro-20x",
      accountScope: { status: "unavailable" },
    })),
  });
  const bundleFile = join(directory, "review.umx.json");
  const receiptFile = `${bundleFile}.privacy-receipt.json`;
  await writeLocalMetadataBundle({ ...result, outputFile: bundleFile, receiptFile });
  return { directory, bundleFile, receiptFile, ...result };
}

async function overwriteWithMatchingReceipt(pair, bundle) {
  const receipt = verifyPrivacySafeBundle(bundle, { createdAt: pair.receipt.createdAt });
  await writeFile(pair.bundleFile, stableJson(bundle), { mode: 0o600 });
  await writeFile(pair.receiptFile, stableJson(receipt), { mode: 0o600 });
}

function assertSafeFailure(error, expectedCode, pair) {
  assert.equal(error instanceof BundleVerificationError, true);
  assert.equal(error.code, expectedCode);
  assert.equal(error.message.includes(pair.directory), false);
  assert.equal(error.message.includes("PRIVATE_CANARY"), false);
  return true;
}

test("standalone verifier accepts an exact canonical owner-only pair", async () => {
  const pair = await localPair();
  try {
    const verified = await verifyLocalMetadataBundleFiles(pair);
    assert.equal(verified.verdict, "passed");
    assert.equal(verified.contractFamily, "telemetry-v0.1");
    assert.equal(verified.contractStatus, "draft_local_only_unfrozen");
    assert.equal(verified.transportReady, false);
    assert.deepEqual(verified.recordCounts, { usageEvents: 0, quotaSnapshots: 0, activityMarkers: 0 });
  } finally {
    await rm(pair.directory, { recursive: true, force: true });
  }
});

test("verifier rejects bundle tampering without echoing content or paths", async () => {
  const pair = await localPair();
  try {
    const bundle = JSON.parse(await readFile(pair.bundleFile, "utf8"));
    bundle.privateCanary = "PRIVATE_CANARY";
    await writeFile(pair.bundleFile, stableJson(bundle), { mode: 0o600 });
    await assert.rejects(
      verifyLocalMetadataBundleFiles(pair),
      (error) => assertSafeFailure(error, "bundle_digest", pair),
    );
  } finally {
    await rm(pair.directory, { recursive: true, force: true });
  }
});

test("verifier rejects non-canonical receipt JSON", async () => {
  const pair = await localPair();
  try {
    const receipt = JSON.parse(await readFile(pair.receiptFile, "utf8"));
    await writeFile(pair.receiptFile, JSON.stringify(receipt), { mode: 0o600 });
    await assert.rejects(
      verifyLocalMetadataBundleFiles(pair),
      (error) => assertSafeFailure(error, "receipt_not_canonical", pair),
    );
  } finally {
    await rm(pair.directory, { recursive: true, force: true });
  }
});

test("verifier rejects canonical receipt tampering", async () => {
  const pair = await localPair();
  try {
    const receipt = JSON.parse(await readFile(pair.receiptFile, "utf8"));
    receipt.excludedCategories = receipt.excludedCategories.slice(1);
    await writeFile(pair.receiptFile, stableJson(receipt), { mode: 0o600 });
    await assert.rejects(
      verifyLocalMetadataBundleFiles(pair),
      (error) => assertSafeFailure(error, "receipt_mismatch", pair),
    );
  } finally {
    await rm(pair.directory, { recursive: true, force: true });
  }
});

test("verifier requires the receipt and bundle to share one creation time", async () => {
  const pair = await localPair();
  try {
    const receipt = JSON.parse(await readFile(pair.receiptFile, "utf8"));
    receipt.createdAt = "2026-07-24T13:00:01.000Z";
    await writeFile(pair.receiptFile, stableJson(receipt), { mode: 0o600 });
    await assert.rejects(
      verifyLocalMetadataBundleFiles(pair),
      (error) => assertSafeFailure(error, "receipt_created_at", pair),
    );
  } finally {
    await rm(pair.directory, { recursive: true, force: true });
  }
});

test("verifier rejects a coherent pair carrying a stale compatibility tuple", async () => {
  const pair = await localPair();
  try {
    const bundle = structuredClone(pair.bundle);
    bundle.compatibility.schemas.setSha256 = "0".repeat(64);
    const bundleBytes = Buffer.from(stableJson(bundle));
    const receipt = structuredClone(pair.receipt);
    receipt.compatibility = structuredClone(bundle.compatibility);
    receipt.bundleBytes = bundleBytes.length;
    receipt.bundleSha256 = createHash("sha256").update(bundleBytes).digest("hex");
    await writeFile(pair.bundleFile, bundleBytes, { mode: 0o600 });
    await writeFile(pair.receiptFile, stableJson(receipt), { mode: 0o600 });
    await assert.rejects(
      verifyLocalMetadataBundleFiles(pair),
      (error) => assertSafeFailure(error, "privacy_gate", pair),
    );
  } finally {
    await rm(pair.directory, { recursive: true, force: true });
  }
});

test("verifier enforces semantic coverage bounds even with a matching privacy receipt", async () => {
  const pair = await localPair({ marker: true });
  try {
    const bundle = structuredClone(pair.bundle);
    bundle.records.activityMarkers[0].observedTime = "2026-07-24T14:00:00.000Z";
    const receipt = verifyPrivacySafeBundle(bundle, { createdAt: pair.receipt.createdAt });
    await writeFile(pair.bundleFile, stableJson(bundle), { mode: 0o600 });
    await writeFile(pair.receiptFile, stableJson(receipt), { mode: 0o600 });
    await assert.rejects(
      verifyLocalMetadataBundleFiles(pair),
      (error) => assertSafeFailure(error, "bundle_record_out_of_bounds", pair),
    );
  } finally {
    await rm(pair.directory, { recursive: true, force: true });
  }
});

test("verifier rejects duplicate IDs, unsorted records, and reversed coverage", async () => {
  const cases = [
    {
      code: "bundle_duplicate_ids",
      mutate(bundle) {
        bundle.records.activityMarkers[1].markerId = bundle.records.activityMarkers[0].markerId;
      },
    },
    {
      code: "bundle_record_order",
      mutate(bundle) {
        bundle.records.activityMarkers.reverse();
      },
    },
    {
      code: "bundle_record_order",
      mutate(bundle) {
        bundle.records.activityMarkers[0].observedTime = "2026-07-24T12:30:00.100Z";
        bundle.records.activityMarkers[1].observedTime = "2026-07-24T12:30:00Z";
      },
    },
    {
      code: "bundle_time_bounds",
      mutate(bundle) {
        bundle.coveredAt.startAt = "2026-07-24T14:00:00.000Z";
      },
    },
  ];
  for (const scenario of cases) {
    const pair = await localPair({ markerCount: 2 });
    try {
      const bundle = structuredClone(pair.bundle);
      scenario.mutate(bundle);
      await overwriteWithMatchingReceipt(pair, bundle);
      await assert.rejects(
        verifyLocalMetadataBundleFiles(pair),
        (error) => assertSafeFailure(error, scenario.code, pair),
      );
    } finally {
      await rm(pair.directory, { recursive: true, force: true });
    }
  }
});

test("verifier bounds quota receipt time and rejects receipt before observation", async () => {
  const scenarios = [
    { receivedTime: "2026-07-24T11:59:59.000Z", code: "bundle_record_out_of_bounds" },
    { receivedTime: "2026-07-24T12:29:59.000Z", code: "bundle_received_before_observed" },
  ];
  for (const scenario of scenarios) {
    const pair = await localPair();
    try {
      const bundle = structuredClone(pair.bundle);
      bundle.records.quotaSnapshots.push({
        schemaVersion: "quota-snapshot-v0.1",
        observedTime: "2026-07-24T12:30:00.000Z",
        receivedTime: scenario.receivedTime,
        provider: "openai_codex",
        planType: "pro",
        planVariant: "pro-20x",
        limitId: "codex",
        slot: "seven_day",
        usedPercent: 25,
        displayPrecision: 0,
        windowDurationMinutes: 10080,
        resetsAt: "2026-07-31T12:00:00.000Z",
        snapshotSource: "rollout",
        providerSurface: "account_shared_unallocated",
        snapshotId: `snapshot:v2:${"Q".repeat(43)}`,
        providerStateId: `quota-state:v1:${"P".repeat(43)}`,
        sessionScopeId: `session:v1:${"S".repeat(43)}`,
        accountScopeId: "unattributed",
      });
      bundle.recordCounts.quotaSnapshots = 1;
      await overwriteWithMatchingReceipt(pair, bundle);
      await assert.rejects(
        verifyLocalMetadataBundleFiles(pair),
        (error) => assertSafeFailure(error, scenario.code, pair),
      );
    } finally {
      await rm(pair.directory, { recursive: true, force: true });
    }
  }
});

test("verifier rejects an observed provider absent from the bundle declaration", async () => {
  const pair = await localPair();
  try {
    const bundle = structuredClone(pair.bundle);
    bundle.records.usageEvents.push({
      schemaVersion: "usage-event-v0.1",
      eventTime: "2026-07-24T12:30:00.000Z",
      provider: "anthropic_claude_code",
      modelId: "unknown",
      modelRecognition: "missing",
      modelFingerprint: null,
      billingSurface: "claude_subscription",
      speedMode: "unknown",
      apiServiceTier: "unknown",
      reasoningEffort: "unknown",
      components: {
        inputUncachedTokens: 1,
        inputCacheReadTokens: 2,
        inputCacheWriteTokens: 3,
        inputCacheWrite5mTokens: 3,
        inputCacheWrite1hTokens: 0,
        outputTextTokens: null,
        outputReasoningTokens: null,
        outputCombinedTokens: 4,
      },
      totalInputContextTokens: 6,
      surface: "local_rollout_unclassified",
      agentScope: "unknown",
      lineageDisposition: "standalone",
      toolClassCounts: {
        webSearch: 0, fileSearch: 0, codeInterpreter: 0, hostedShell: 0,
        computerUse: 0, mcp: 0, applyPatch: 0, localShell: 0,
        subagent: 0, toolGateway: 0, other: 0, unknown: 0,
      },
      outcome: "unknown",
      eventId: `event:v2:${"E".repeat(43)}`,
      sessionScopeId: `session:v1:${"S".repeat(43)}`,
      accountScopeId: "unattributed",
    });
    bundle.recordCounts.usageEvents = 1;
    const bundleBytes = Buffer.from(stableJson(bundle));
    const receipt = structuredClone(pair.receipt);
    receipt.bundleBytes = bundleBytes.length;
    receipt.bundleSha256 = createHash("sha256").update(bundleBytes).digest("hex");
    receipt.recordCounts.usageEvents = 1;
    await writeFile(pair.bundleFile, bundleBytes, { mode: 0o600 });
    await writeFile(pair.receiptFile, stableJson(receipt), { mode: 0o600 });
    await assert.rejects(
      verifyLocalMetadataBundleFiles(pair),
      (error) => assertSafeFailure(error, "bundle_provider_declaration", pair),
    );
  } finally {
    await rm(pair.directory, { recursive: true, force: true });
  }
});

test("verifier rejects linked artifacts and unsafe parent permissions", async () => {
  const hardlinked = await localPair();
  try {
    await link(hardlinked.receiptFile, join(hardlinked.directory, "extra-link"));
    await assert.rejects(
      verifyLocalMetadataBundleFiles(hardlinked),
      (error) => assertSafeFailure(error, "receipt_link_count", hardlinked),
    );
  } finally {
    await rm(hardlinked.directory, { recursive: true, force: true });
  }

  const unsafeParent = await localPair();
  try {
    await chmod(unsafeParent.directory, 0o777);
    await assert.rejects(
      verifyLocalMetadataBundleFiles(unsafeParent),
      (error) => assertSafeFailure(error, "parent_directory_permissions", unsafeParent),
    );
  } finally {
    await chmod(unsafeParent.directory, 0o700).catch(() => {});
    await rm(unsafeParent.directory, { recursive: true, force: true });
  }
});

test("verifier never follows an artifact symlink", async () => {
  const pair = await localPair();
  try {
    const realBundle = join(pair.directory, "real-bundle.json");
    await rename(pair.bundleFile, realBundle);
    await symlink(realBundle, pair.bundleFile);
    await assert.rejects(
      verifyLocalMetadataBundleFiles(pair),
      (error) => assertSafeFailure(error, "bundle_not_regular", pair),
    );
  } finally {
    await rm(pair.directory, { recursive: true, force: true });
  }
});

test("verify-bundle CLI reports only a bounded privacy-safe summary", async () => {
  const pair = await localPair();
  try {
    const output = execFileSync(process.execPath, [
      resolve("src/cli.js"),
      "verify-bundle",
      "--input", pair.bundleFile,
      "--receipt", pair.receiptFile,
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.match(output, /Local metadata bundle verification: passed/);
    assert.match(output, /Upload disabled: true/i);
    assert.equal(output.includes(pair.directory), false);
    assert.equal(output.includes(pair.bundle.participantId), false);
  } finally {
    await rm(pair.directory, { recursive: true, force: true });
  }
});

test("verification and recovery CLI commands fail safely when required paths are absent", () => {
  for (const [command, expected] of [["verify-bundle", "requires --input"], ["recover-exports", "requires --directory"]]) {
    const result = spawnSync(process.execPath, [resolve("src/cli.js"), command], {
      cwd: resolve("."), encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(expected));
    assert.equal(result.stderr.includes("/Users/"), false);
  }
});
