import { env, applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest,
  type TelemetryV11QuotaObservation } from "@app-usagemonitor/telemetry-contract";
import { authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization } from "../src/device-auth";
import { initializeStorageSource } from "../src/analytics-delivery";
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../src/typed-v11-admission";
import { registerTelemetryV11DayManifest } from "../src/telemetry-v11-repository";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor, loadV11SourcePin } from "../src/telemetry-v11-domain";
import { sha256Hex } from "../src/crypto";
import { createTypedV11QuotaPageReader } from "../src/typed-v11-quota-reader";
import { createV11DeviceFixture, makeV11Day } from "./helpers/telemetry-v11";

const bindings = env as Env & { STORAGE_INGESTION_A: D1Database; TEST_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[]; TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[] };
const database = () => bindings.STORAGE_INGESTION_A;
const SOURCE_NAMESPACE = "synthetic-v11-quota-reader";
const PARTICIPANT = "participant:synthetic-v11-quota-reader";
const DAY = new Date().toISOString().slice(0, 10);
const START = Date.parse(`${DAY}T00:00:00.000Z`);
const ACCOUNT = "account-track:v2:" + "a".repeat(64);

beforeEach(async () => {
  await reset();
  await applyD1Migrations(database(), bindings.TEST_MIGRATIONS);
  await applyD1Migrations(database(), bindings.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(database(), bindings.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(database(), bindings.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await initializeStorageSource(database(), SOURCE_NAMESPACE);
  await initializeTypedV11Admission(database(), SOURCE_NAMESPACE);
});

async function stageAndActivate() {
  const fixture = await createV11DeviceFixture(database(), { participantId: PARTICIPANT, grant: true });
  const attribution = { accountBasis: "same_source" as const, accountTrackId: ACCOUNT,
    planBasis: "same_source_occurrence" as const, planType: "pro" as const, planEraId: null };
  const quota: TelemetryV11QuotaObservation[] = Array.from({ length: 9 }, (_, index) => ({
    schemaVersion: "quota-observation-v1.1" as const,
    observationId: `quota:synthetic-reader:${index}`, observedTime: new Date(START + index * 300_000).toISOString(),
    provider: "openai_codex", planType: "pro" as const, planVariant: "unknown", limitId: "codex",
    slot: "seven_day", usedPercent: 10 + index * 5, windowDurationMinutes: 10_080,
    resetsAt: new Date(START + 7 * 86_400_000).toISOString(), accountPlanAttribution: { ...attribution },
  }));
  const prepared = await makeV11Day(DAY, { quota });
  await registerTelemetryV11DayManifest(database(), fixture, prepared.manifest);
  for (const chunk of prepared.chunks) {
    const envelopeDigest = await sha256Hex(`synthetic-v11-reader:${chunk.chunkDigest}`);
    const principal = await authenticateDevice(database(), fixture.authorization);
    const upload = await createDeviceUploadAuthorization(database(), principal, envelopeDigest, 200);
    const claimed = await claimDeviceUploadAuthorization(database(), `Upload ${upload.uploadAuthorization}`, {
      envelopeDigest, bodyBytes: 200, contentType: "application/json",
    });
    await persistTypedV11StagedChunk(database(), principal, chunk, {
      sourceNamespace: SOURCE_NAMESPACE, chunkRowId: `chunk:${crypto.randomUUID()}`,
      r2Key: `synthetic/v11-reader/${crypto.randomUUID()}`, envelopeDigest,
      deviceUploadAuthorizationId: claimed.authorizationId,
    });
  }
  const candidate = await registerTelemetryV11DayManifest(database(), fixture, prepared.manifest);
  const predecessor = await createTelemetryV11DomainPredecessor(database(), fixture);
  const manifest: TelemetryV11DomainManifest = {
    schemaVersion: "telemetry-domain-manifest-v1.1", fromDay: DAY, throughDay: DAY,
    predecessor: { token: predecessor.token, previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint },
    days: [{ day: DAY, manifestId: candidate.manifestId, manifestDigest: candidate.manifestDigest }],
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  await activateTelemetryV11Domain(database(), fixture, manifest);
  return (await loadV11SourcePin(database(), PARTICIPANT))!;
}

describe("typed v1.1 quota physical reader", () => {
  it("pages the current device domain and keeps the physical cursor bounded", async () => {
    const pin = await stageAndActivate();
    const reader = await createTypedV11QuotaPageReader(database(), {
      sourceNamespace: SOURCE_NAMESPACE, pin, fromObservedAtMs: START, beforeObservedAtMs: START + 86_400_000,
    });
    const first = await reader.readPage({ observedAtMs: START, sourceRowId: 0 }, 1);
    expect(first).toHaveLength(1);
    expect(first[0]!.active?.provider).toBe("openai_codex");
    expect(first[0]!.active?.usedPercent).toBe(10);
    const rest = await reader.readPage({ observedAtMs: first[0]!.observedAtMs, sourceRowId: first[0]!.sourceRowId });
    expect(rest).toHaveLength(8);
    expect([...first, ...rest].every((row) => row.active?.limitId === "codex")).toBe(true);
    expect([...first, ...rest].map((row) => row.sourceRowId)).toEqual(
      [...first, ...rest].map((row) => row.sourceRowId).sort((left, right) => left - right));
    expect(await reader.readPage({ observedAtMs: rest.at(-1)!.observedAtMs, sourceRowId: rest.at(-1)!.sourceRowId })).toEqual([]);
  }, 60_000);
});
