import {
  beginUnifiedIndexGeneration, createUnifiedIndexWriter, openLocalUnifiedIndex,
} from "../../src/local-unified-index.js";

export const ATTRIBUTION_FIXTURE_DAY = "2026-08-01";
export const ATTRIBUTION_FIXTURE_START = Date.parse(`${ATTRIBUTION_FIXTURE_DAY}T12:00:00.000Z`);
export const ATTRIBUTION_FIXTURE_DEVICE_ID = "11111111-1111-4111-8111-111111111111";
export const ATTRIBUTION_FIXTURE_BINDING = Object.freeze({
  destinationOrigin: "https://usage.example", enrollmentNamespace: "synthetic_enrollment_0001",
});
export function attributionFixtureMarker(overrides = {}) {
  return {
    version: "provisional-account-marker-v2", source: "app_server_read",
    capturedAt: new Date(ATTRIBUTION_FIXTURE_START - 1).toISOString(),
    receivedAt: new Date(ATTRIBUTION_FIXTURE_START + 2_000).toISOString(),
    accountScope: { status: "available", reason: null, version: "openai-account-v1",
      scopeId: `openai-account:v1:${Buffer.alloc(32, 7).toString("base64url")}`, planType: "pro" },
    observationBinding: ATTRIBUTION_FIXTURE_BINDING, ...overrides,
  };
}

/** Synthetic, content-free schema-11 publication through the real writer. */
export async function writeAttributionFixture(file, { plans = ["pro", "plus"], publish = true } = {}) {
  const database = openLocalUnifiedIndex(file, { create: true });
  const generation = beginUnifiedIndexGeneration(database, {
    contractVersion: "usage-event-v0.2", receivedAtMs: ATTRIBUTION_FIXTURE_START,
    discoveredSourceCount: 1, discoveredSourceBytes: 4096,
  });
  const writer = createUnifiedIndexWriter(database, {
    contractVersion: "usage-event-v0.2", receivedAtMs: ATTRIBUTION_FIXTURE_START,
    generationId: generation.generationId, parserVersionId: generation.parserVersionId, ingestRunId: generation.ingestRunId,
  });
  const source = { sourceLocal: Buffer.alloc(32, 1), sourceOrdinal: 0, sessionLocal: Buffer.alloc(32, 21) };
  const accountScopeId = writer.internAccountScope({ status: "unavailable", reason: "missing_account", planType: null, scopeLocal: null });
  const modelId = writer.internModel("gpt-5.6-sol", "recognized");
  const tierId = writer.internTier({ apiServiceTier: "unknown", billingSurface: "chatgpt_subscription",
    codexSpeedMode: "standard", tierSource: "unknown", providerTierRaw: null });
  const surfaceId = writer.internSurface({ agentScope: "root", surface: "cli_exec", threadSource: "user", lineageDisposition: "standalone" });
  for (const [index, planType] of plans.entries()) {
    const eventKey = Buffer.alloc(32); eventKey.writeUInt32BE(index + 1, 28);
    const observedAtMs = ATTRIBUTION_FIXTURE_START + index * 1_000;
    const window = { observedAtMs, limitId: "codex", slot: "secondary", planType, usedPercent: 10 + index,
      resetsAtMs: ATTRIBUTION_FIXTURE_START + 604_800_000, durationMins: 10_080 };
    const canonicalObservationId = writer.internQuota(window);
    writer.writeQuotaOccurrence({ ...source, sourceOffset: index + 1, generationId: generation.generationId,
      surfaceId, canonicalObservationId, ...window, provider: "openai_codex", slotOrder: 0, admission: "admitted" });
    writer.writeUsageEvent({ ...source, eventKey, observedAtMs, sourceOffset: index + 1, generationId: generation.generationId,
      accountScopeId, modelId, tierId, surfaceId, quotaObservationId: canonicalObservationId,
      reasoningEffort: 4, outcome: 5, tierObservedAtMs: null,
      tokensInUncached: 10, tokensInCacheRead: 20, tokensInCacheWrite: 0, tokensInCacheWrite5m: null,
      tokensInCacheWrite1h: null, tokensOutText: 1, tokensOutReasoning: 0, tokensOutCombined: null,
      totalInputContext: null, partial: false });
  }
  writer.recordSessionIdentity(source.sessionLocal, "11111111-2222-4333-8444-000000000001");
  writer.writeToolClassFact({ ...source, eventKey: Buffer.alloc(32, 71), sourceOffset: 1,
    generationId: generation.generationId, observedAtMs: ATTRIBUTION_FIXTURE_START,
    toolOrdinal: 0, toolClass: "localShell", sourceKind: "response_item" });
  writer.writeSourceCursor({ ...source, scannedBytes: 4096, sizeBytes: 4096, mtimeMs: ATTRIBUTION_FIXTURE_START,
    snapshotsPersisted: true, turnContextSeen: true, carryModel: "gpt-5.6-sol", carryEffort: "high",
    carryTierRaw: null, carryTierObservedAtMs: null, carryTotals: null });
  writer.writeGenerationSource({ ...source, generationId: generation.generationId, surfaceId, status: "complete",
    discoveredSizeBytes: 4096, scannedBytes: 4096, mtimeMs: ATTRIBUTION_FIXTURE_START, diagnosticsComplete: true });
  writer.writeSourceDiagnostics(source.sourceLocal, {}, { generationId: generation.generationId });
  writer.writeMeta("contract_version", "usage-event-v0.2");
  writer.writeMeta("status", "complete");
  if (publish) writer.finalizeGeneration({ status: "complete", blockReason: null, discoveredSourceCount: 1,
    discoveredSourceBytes: 4096, indexedSourceCount: 1, indexedSourceBytes: 4096,
    discoveryComplete: true, diagnosticsComplete: true });
  await writer.close({ fsyncPath: file });
  return generation;
}
