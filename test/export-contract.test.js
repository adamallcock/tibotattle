import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExportCompatibilityTuple, exportCompatibilityTuple } from "../src/export-contract.js";
import { buildLocalMetadataBundle } from "../src/metadata-exporter.js";
import { verifyPrivacySafeBundle } from "../src/export-privacy.js";
import { stableJson } from "../src/storage.js";

const SECRET = Buffer.alloc(32, 17);
const BUNDLE_ID = `bundle:v1:${"4".repeat(64)}`;

async function emptyBundle() {
  const home = await mkdtemp(join(tmpdir(), "usage-monitor-contract-"));
  await mkdir(join(home, "sessions"));
  const result = await buildLocalMetadataBundle({
    startAt: "2026-07-24T12:00:00.000Z",
    endAt: "2026-07-24T13:00:00.000Z",
    createdAt: "2026-07-24T13:00:00.000Z",
    codexHome: home,
    secret: SECRET,
    bundleId: BUNDLE_ID,
  });
  return { home, ...result };
}

test("generated compatibility manifest exactly matches all live contract inputs", async () => {
  const generated = JSON.parse(await readFile(new URL("../generated/telemetry-v0.1-compatibility.json", import.meta.url), "utf8"));
  assert.deepEqual(generated, buildExportCompatibilityTuple());
  assert.deepEqual(exportCompatibilityTuple(), generated);
  assert.equal(generated.schemas.members.length, 6);
  assert.deepEqual(generated.schemas.members.map((member) => member.name), [
    "activity-marker.schema.json",
    "bundle.schema.json",
    "compatibility.schema.json",
    "privacy-receipt.schema.json",
    "quota-snapshot.schema.json",
    "usage-event.schema.json",
  ]);
  assert.equal(generated.providerAdapters.openaiCodex.status, "implemented");
  assert.equal(generated.providerAdapters.openaiCodex.capabilities.usageEvents, "implemented");
  assert.equal(generated.providerAdapters.openaiCodex.capabilities.quotaSnapshots.rollout, "implemented");
  assert.equal(generated.providerAdapters.openaiCodex.capabilities.quotaSnapshots.collector, "implemented");
  assert.equal(generated.providerAdapters.openaiCodex.sourceFormats.collectorQuota.status, "implemented");
  assert.equal(generated.providerAdapters.anthropicClaudeCode.status, "partial");
  assert.equal(generated.providerAdapters.anthropicClaudeCode.capabilities.usageEvents, "implemented");
  assert.equal(generated.providerAdapters.anthropicClaudeCode.capabilities.quotaSnapshots, "implemented");
  assert.equal(generated.providerAdapters.anthropicClaudeCode.sourceFormats.statusLine.status, "implemented");
  assert.equal(generated.providerAdapters.anthropicClaudeCode.sourceFormats.transcript.status, "implemented");
  assert.equal(generated.contract.transportReady, false);
  assert.equal(generated.contract.externalParticipantsAuthorized, false);
});

test("executed scanner version is the version embedded in the bundle", async () => {
  const result = await emptyBundle();
  try {
    assert.equal(result.bundle.compatibility.providerAdapters.openaiCodex.sourceFormats.rollout.parserVersion, "codex-log-scan-v5");
    assert.equal(result.receipt.compatibility.providerAdapters.openaiCodex.sourceFormats.rollout.parserVersion, "codex-log-scan-v5");
  } finally {
    await rm(result.home, { recursive: true, force: true });
  }
});

test("privacy verification rejects a schema-valid compatibility mutation", async () => {
  const result = await emptyBundle();
  try {
    const mutated = structuredClone(result.bundle);
    mutated.compatibility.schemas.setSha256 = "0".repeat(64);
    assert.notEqual(stableJson(mutated.compatibility), stableJson(exportCompatibilityTuple()));
    assert.throws(() => verifyPrivacySafeBundle(mutated), /compatibility_tuple/);
  } finally {
    await rm(result.home, { recursive: true, force: true });
  }
});

test("a declared partial Claude provider passes when no unsupported record family is observed", async () => {
  const result = await emptyBundle();
  try {
    const mutated = structuredClone(result.bundle);
    mutated.sourceProviders.push("anthropic_claude_code");
    assert.equal(verifyPrivacySafeBundle(mutated).verdict, "passed");
  } finally {
    await rm(result.home, { recursive: true, force: true });
  }
});
