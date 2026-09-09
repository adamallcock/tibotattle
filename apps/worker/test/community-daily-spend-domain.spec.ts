import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  canonicalTelemetryV11Json, telemetryV11DomainManifestDigestInput, telemetryV11RequiredConsent,
  type TelemetryV11DomainManifest, type TelemetryV11UsageEvent,
} from "@app-usagemonitor/telemetry-contract";
import {
  COMMUNITY_DAILY_SPEND_BASIS, COMMUNITY_DAILY_SPEND_PRICING_METHOD,
  COMMUNITY_DAILY_SPEND_REGISTRY_SHA256, DAILY_SPEND_RECORDS_SQL, priceCommunityDailySpend,
} from "../src/community-daily-spend";
import { sha256Hex } from "../src/crypto";
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from "../src/device-auth";
import { grantTelemetryV11Consent } from "../src/telemetry-transport-policy";
import { parseTelemetryV1Chunk } from "../src/telemetry-v1";
import { insertTelemetryV1Chunk } from "../src/telemetry-v1-repository";
import { loadV1SourcePin } from "../src/telemetry-v1-source-selection";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from "../src/telemetry-v11-domain";
import { telemetryV11LegacyProjection } from "../src/telemetry-v11-repository";
import { createV11DeviceFixture, makeV11Day, stageV11Day, v11UsageRecord } from "./helpers/telemetry-v11";

interface Bindings extends Env { TEST_MIGRATIONS: D1Migration[]; }
type DeviceFixture = Awaited<ReturnType<typeof createV11DeviceFixture>>;
type StagedDay = Awaited<ReturnType<typeof stageV11Day>>;
const db = () => (env as Bindings).USAGE_MONITOR_DB;
const today = () => new Date().toISOString().slice(0, 10);

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), (env as Bindings).TEST_MIGRATIONS);
});

function usage(day: string, fill: string, tokens: number): TelemetryV11UsageEvent {
  return v11UsageRecord(day, fill, {
    modelId: "gpt-4.1", totalInputContextTokens: tokens,
    components: { inputUncachedTokens: tokens, inputCacheReadTokens: 0, inputCacheWriteTokens: 0,
      outputTextTokens: 0, outputReasoningTokens: 0, outputCombinedTokens: null },
  });
}

async function enable(fixture: DeviceFixture) {
  await db().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
  await grantTelemetryV11Consent(db(), fixture, telemetryV11RequiredConsent());
}

async function activate(fixture: DeviceFixture, staged: StagedDay) {
  const prior = await createTelemetryV11DomainPredecessor(db(), fixture);
  const manifest: TelemetryV11DomainManifest = {
    schemaVersion: "telemetry-domain-manifest-v1.1", fromDay: staged.day, throughDay: staged.day,
    predecessor: { token: prior.token, previousGenerationId: prior.previousGenerationId,
      legacyFingerprint: prior.legacyFingerprint },
    days: [{ day: staged.day, manifestId: staged.manifestId, manifestDigest: staged.manifestDigest }],
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  return activateTelemetryV11Domain(db(), fixture, manifest);
}

// Reuse the domain suite's real ingestion path; no admission/activation triggers are disabled.
async function legacyUsage(fixture: DeviceFixture, day: string, records: TelemetryV11UsageEvent[],
  options: { id?: string; createdAt?: string } = {}) {
  const projected = records.map((record) => {
    const value = telemetryV11LegacyProjection("usage", record);
    if (value === null) throw new Error("Synthetic usage must have a legacy counterpart");
    return JSON.parse(value.canonicalRecord);
  });
  const envelopeDigest = await sha256Hex(`synthetic-daily-spend:${crypto.randomUUID()}`);
  const principal = await authenticateDevice(db(), fixture.authorization);
  const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 200);
  const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`,
    { envelopeDigest, bodyBytes: 200, contentType: "application/json" });
  const chunk = parseTelemetryV1Chunk({
    schemaVersion: "telemetry-contribution-v1.0", chunkId: `usage:${day}:0`, chunkRevision: 1,
    chunkDigest: await sha256Hex(canonicalTelemetryV11Json(projected)), parserVersion: "synthetic-daily-spend-v1",
    consent: { telemetrySchemaVersion: "telemetry-contribution-v1.0",
      fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0" }, records: projected,
  });
  const id = options.id ?? `chunk:${crypto.randomUUID()}`;
  await insertTelemetryV1Chunk(db(), {
    chunkRowId: id, participantId: fixture.participantId, deviceId: fixture.deviceId, chunk,
    envelopeDigest, r2Key: `synthetic/daily-spend-${crypto.randomUUID()}`,
    deviceUploadAuthorizationId: claimed.authorizationId,
    createdAt: options.createdAt ?? new Date().toISOString(), supersedes: null,
  });
  return id;
}

async function winningUsageCount(day: string, winnersJson: string) {
  const row = await db().prepare(`SELECT COUNT(*) AS n FROM telemetry_analytical_records r
    WHERE r.observed_day=?1 AND r.stream='usage'
      AND (r.participant_id,r.observed_day,r.device_id) IN (
        SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]')
        FROM json_each(?2))`).bind(day, winnersJson).first<{ n: number }>();
  return row!.n;
}

function expectedSpend(usageEvents: number, knownCostUsd: number) {
  return { state: "priced", spend: {
    basis: COMMUNITY_DAILY_SPEND_BASIS, currency: "USD", knownCostUsd, coverage: "complete",
    usageEvents, fullyPricedUsageEvents: usageEvents, partiallyPricedUsageEvents: 0, unpricedUsageEvents: 0,
    pricingMethodVersion: COMMUNITY_DAILY_SPEND_PRICING_METHOD,
    registrySha256: COMMUNITY_DAILY_SPEND_REGISTRY_SHA256,
  } };
}

describe("daily spend active attribution-domain isolation", () => {
  it("prices only the active generation, not suppressed legacy, retired generations, or staged devices", async () => {
    const day = today();
    const activeDevice = await createV11DeviceFixture(db());
    const olderDevice = await createV11DeviceFixture(db(), { participantId: activeDevice.participantId });
    const a = usage(day, "a", 1_000);
    const b = usage(day, "b", 2_000);
    await legacyUsage(olderDevice, day, [usage(day, "c", 100_000)],
      { createdAt: new Date(Date.now() - 10_000).toISOString() });
    await legacyUsage(activeDevice, day, [a]);
    const legacyPin = await loadV1SourcePin(db(), { day });
    expect(legacyPin.winners).toHaveLength(1);
    expect(legacyPin.winners[0]!.device_id).toBe(activeDevice.deviceId);
    const legacyCount = await winningUsageCount(day, legacyPin.winnersJson);
    expect(legacyCount).toBe(1);
    await expect(priceCommunityDailySpend(db(), day, legacyPin.winnersJson, legacyCount,
      { remainingChunks: 8, remainingEvents: 200 })).resolves.toEqual(expectedSpend(1, 0.002));

    await enable(activeDevice);
    const first = await stageV11Day(db(), activeDevice, await makeV11Day(day, { usage: [a] }));
    const initial = await activate(activeDevice, first);
    const successor = await stageV11Day(db(), activeDevice, await makeV11Day(day, { usage: [a, b] }));
    const current = await activate(activeDevice, successor);
    expect(current.generationId).not.toBe(initial.generationId);
    const staged = await stageV11Day(db(), activeDevice,
      await makeV11Day(day, { usage: [a, b, usage(day, "d", 100_000)] }));
    const alternate = await createV11DeviceFixture(db(), { participantId: activeDevice.participantId, grant: true });
    const alternateStaged = await stageV11Day(db(), alternate,
      await makeV11Day(day, { usage: [usage(day, "e", 100_000)] }));
    expect(staged.state).toBe("ready");
    expect(alternateStaged.state).toBe("ready");
    expect(await db().prepare("SELECT COUNT(*) AS n FROM telemetry_v1_records").first()).toEqual({ n: 2 });
    expect(await db().prepare("SELECT COUNT(*) AS n FROM telemetry_v11_records").first()).toEqual({ n: 7 });
    expect(await db().prepare("SELECT DISTINCT generation_id FROM telemetry_analytical_records").all())
      .toMatchObject({ results: [{ generation_id: current.generationId }] });
    const pin = await loadV1SourcePin(db(), { day });
    expect(pin.winners).toHaveLength(1);
    expect(pin.winners[0]!.device_id).toBe(activeDevice.deviceId);
    const count = await winningUsageCount(day, pin.winnersJson);
    expect(count).toBe(2);
    // GPT-4.1 Standard is $2/M uncached input: (1000 + 2000) * 2 / 1e6.
    const budget = { remainingChunks: 8, remainingEvents: 200 };
    await expect(priceCommunityDailySpend(db(), day, pin.winnersJson, count, budget))
      .resolves.toEqual(expectedSpend(2, 0.006));
    expect(budget).toEqual({ remainingChunks: 7, remainingEvents: 198 });
  });

  it("keeps cross-table chunk-ID collisions isolated by participant and device", async () => {
    const day = today();
    const activeDevice = await createV11DeviceFixture(db(), { grant: true });
    const staged = await stageV11Day(db(), activeDevice, await makeV11Day(day, { usage: [usage(day, "a", 1_000)] }));
    await activate(activeDevice, staged);
    const activeChunk = await db().prepare("SELECT id FROM telemetry_v11_chunks WHERE manifest_id=?")
      .bind(staged.manifestId).first<{ id: string }>();
    const legacyDevice = await createV11DeviceFixture(db());
    await legacyUsage(legacyDevice, day, [usage(day, "b", 100_000)], { id: activeChunk!.id });
    for (const [fixture, expectedSchema] of [[activeDevice, "usage-event-v1.1"], [legacyDevice, "usage-event-v1.0"]] as const) {
      const identities = JSON.stringify([[fixture.participantId, fixture.deviceId, activeChunk!.id]]);
      const selected = await db().prepare(DAILY_SPEND_RECORDS_SQL).bind(identities, day, 201)
        .all<{ participant_id: string; device_id: string; record_json: string }>();
      expect(selected.results).toHaveLength(1);
      expect(selected.results[0]).toMatchObject({ participant_id: fixture.participantId, device_id: fixture.deviceId });
      expect(JSON.parse(selected.results[0]!.record_json).schemaVersion).toBe(expectedSchema);
    }
    const pin = await loadV1SourcePin(db(), { day });
    expect(pin.winners).toHaveLength(2);
    const count = await winningUsageCount(day, pin.winnersJson);
    expect(count).toBe(2);
    await expect(priceCommunityDailySpend(db(), day, pin.winnersJson, count,
      { remainingChunks: 8, remainingEvents: 200 })).resolves.toEqual(expectedSpend(2, 0.202));
  });
});
