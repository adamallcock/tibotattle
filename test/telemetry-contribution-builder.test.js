import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import {
  buildTelemetryContributionsFromBundle,
  materializeTelemetryContributions,
} from "../src/telemetry-contribution-builder.js";
import {
  buildLocalMetadataBundle,
  writeLocalMetadataBundle,
} from "../src/metadata-exporter.js";

function usage(index, overrides = {}) {
  return {
    schemaVersion: "usage-event-v0.1",
    eventTime: "2026-07-24T23:00:06.717Z",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    modelRecognition: "recognized",
    modelFingerprint: null,
    billingSurface: "chatgpt_subscription",
    speedMode: "standard",
    apiServiceTier: "unknown",
    reasoningEffort: "unknown",
    components: {
      inputUncachedTokens: 100 + index,
      inputCacheReadTokens: 200,
      inputCacheWriteTokens: 0,
      outputTextTokens: 5,
      outputReasoningTokens: 2,
    },
    totalInputContextTokens: 300 + index,
    surface: "extension_or_ide",
    agentScope: "root",
    lineageDisposition: "standalone",
    toolClassCounts: {
      webSearch: 0,
      fileSearch: 0,
      codeInterpreter: 0,
      hostedShell: 0,
      computerUse: 0,
      mcp: 0,
      applyPatch: 0,
      localShell: 0,
      subagent: 0,
      toolGateway: 0,
      other: 0,
      unknown: 0,
    },
    outcome: "unknown",
    eventId: `event:v2:${String(index).padStart(64, "a")}`,
    sessionScopeId: `session:v1:${"b".repeat(64)}`,
    accountScopeId: "unattributed",
    ...overrides,
  };
}

function quota(index) {
  return {
    schemaVersion: "quota-snapshot-v0.1",
    observedTime: "2026-07-24T23:00:06.717Z",
    receivedTime: "2026-07-24T23:00:06.717Z",
    provider: "openai_codex",
    planType: "pro",
    planVariant: "unknown",
    limitId: "codex",
    slot: "primary",
    usedPercent: index % 100,
    displayPrecision: 0,
    windowDurationMinutes: 10_080,
    resetsAt: "2026-07-30T20:06:21.000Z",
    snapshotSource: "rollout",
    providerSurface: "account_shared_unallocated",
    snapshotId: `snapshot:v2:${String(index).padStart(64, "c")}`,
    providerStateId: `quota-state:v1:${"d".repeat(64)}`,
    sessionScopeId: `session:v1:${"e".repeat(64)}`,
    accountScopeId: "unattributed",
  };
}

function bundle({ usageEvents = [usage(1)], quotaSnapshots = [quota(1)] } = {}) {
  return {
    schemaVersion: "usage-metadata-bundle-v0.1",
    createdAt: "2026-07-24T23:24:52.000Z",
    coveredAt: {
      startAt: "2026-07-24T23:00:00.000Z",
      endAt: "2026-07-24T23:24:52.000Z",
    },
    clientPlatform: "macos",
    records: {
      usageEvents,
      quotaSnapshots,
      activityMarkers: [],
    },
  };
}

test("builder removes private scopes, normalizes components, and prices usage", () => {
  const [contribution] = buildTelemetryContributionsFromBundle(bundle());
  assert.equal(contribution.schemaVersion, "telemetry-contribution-v0.1");
  assert.equal(contribution.synthetic, false);
  assert.equal(contribution.providerPolicyEpoch, "openai_agentic_pool_2026_07_09");
  assert.equal(contribution.usageEvents[0].components.outputCombinedTokens, null);
  assert.match(contribution.usageEvents[0].accounting.estimatedApiCostUsd, /^\d+\.\d{6}$/u);
  assert.equal(contribution.accounting.priceBasis, "current_api_prices");
  const serialized = JSON.stringify(contribution);
  for (const forbidden of [
    "accountScopeId",
    "sessionScopeId",
    "participantId",
    "providerStateId",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("builder splits large canonical bundles into bounded transport batches", () => {
  const contributions = buildTelemetryContributionsFromBundle(bundle({
    usageEvents: Array.from({ length: 222 }, (_, index) => usage(index + 1)),
    quotaSnapshots: Array.from({ length: 227 }, (_, index) => quota(index + 1)),
  }));
  assert.equal(contributions.length, 3);
  assert.deepEqual(contributions.map((row) => (
    row.usageEvents.length + row.quotaSnapshots.length + row.activityMarkers.length
  )), [200, 200, 49]);
  assert.ok(contributions.every((row) => Buffer.byteLength(JSON.stringify(row)) < 1_250_000));
});

test("materializer re-verifies a reviewed bundle and writes owner-only no-clobber files", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-telemetry-build-"));
  const codexHome = join(root, "codex");
  await mkdir(join(codexHome, "sessions"), { recursive: true });
  const tokenUsage = {
    input_tokens: 100,
    cached_input_tokens: 40,
    cache_write_input_tokens: 0,
    output_tokens: 20,
    reasoning_output_tokens: 8,
    total_tokens: 120,
  };
  const rows = [
    {
      timestamp: "2026-07-24T23:00:00.000Z",
      type: "session_meta",
      payload: { id: "private-session", source: "user" },
    },
    {
      timestamp: "2026-07-24T23:00:01.000Z",
      type: "turn_context",
      payload: { model: "gpt-5.6-sol" },
    },
    {
      timestamp: "2026-07-24T23:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: tokenUsage, last_token_usage: tokenUsage },
        rate_limits: {
          limit_id: "codex",
          plan_type: "pro",
          primary: {
            used_percent: 20,
            window_minutes: 10_080,
            resets_at: 1_785_438_000,
          },
        },
      },
    },
  ];
  await writeFile(
    join(codexHome, "sessions", "rollout-current.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    { mode: 0o600 },
  );
  const source = await buildLocalMetadataBundle({
    startAt: "2026-07-24T23:00:00.000Z",
    endAt: "2026-07-24T23:02:00.000Z",
    codexHome,
    secret: Buffer.alloc(32, 7),
    createdAt: "2026-07-24T23:02:00.000Z",
  });
  const sourceDirectory = join(root, "source");
  await mkdir(sourceDirectory, { mode: 0o700 });
  const bundleFile = join(sourceDirectory, "source.umx.json");
  const receiptFile = join(sourceDirectory, "source.receipt.json");
  await writeLocalMetadataBundle({
    bundle: source.bundle,
    receipt: source.receipt,
    outputFile: bundleFile,
    receiptFile,
  });
  const output = join(root, "out");
  const result = await materializeTelemetryContributions({
    bundleFile,
    receiptFile,
    outputDirectory: output,
  });
  assert.equal(result.sourcePrivacyVerdict, "passed");
  assert.equal(result.batchCount, 1);
  for (const file of result.files) {
    const metadata = await stat(file.file);
    assert.equal(metadata.mode & 0o077, 0);
    const payload = JSON.parse(await readFile(file.file, "utf8"));
    assert.equal(payload.schemaVersion, "telemetry-contribution-v0.1");
  }
});
