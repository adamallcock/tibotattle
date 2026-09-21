import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalTelemetryV11Json } from "@app-usagemonitor/telemetry-contract";
import { createV11DeviceFixture, v11UsageRecord } from "./helpers/telemetry-v11";
import { authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization } from "../src/device-auth";
import { sha256Hex } from "../src/crypto";
import { initializeStorageSource } from "../src/analytics-delivery";
import { insertTypedTelemetryV1Chunk, initializeTypedV1Admission } from "../src/typed-v1-admission";
import { initializeTypedV11Admission } from "../src/typed-v11-admission";
import { parseTelemetryV1Chunk, type TelemetryV1UsageEvent } from "../src/telemetry-v1";
import { telemetryV11LegacyProjection } from "../src/telemetry-v11-compatibility";
import { initializeStorageAnalyticsRuntime } from "../src/storage-analytics-runtime";
import { eraseParticipantAsOwner } from "../src/participant-erasure";
import {
  captureTelemetryUsageCorrectionBeforeDelete,
  type TelemetryUsageCorrectionSource,
} from "../src/telemetry-usage-correction-repository";

interface Bindings extends Env {
  STORAGE_ANALYTICS_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
  TEST_ANALYTICS_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

const bindings = env as Bindings;
const source = () => bindings.USAGE_MONITOR_DB;
const target = () => bindings.STORAGE_ANALYTICS_DB;
const sourceId = "synthetic-correction-erasure";
const sourceNamespace = "synthetic-correction-erasure-original";
const day = "2026-09-20";

const runtime = (analytics = target()): Env => {
  const configured = { ...bindings, ENVIRONMENT: "synthetic-development" } as Env;
  Reflect.set(configured, "TELEMETRY_STORAGE_MODE", "typed");
  Reflect.set(configured, "TELEMETRY_STORAGE_NAMESPACE", sourceNamespace);
  Reflect.set(configured, "ANALYTICS_DB", analytics);
  return configured;
};

async function migrate(): Promise<void> {
  await applyD1Migrations(source(), bindings.TEST_MIGRATIONS);
  await applyD1Migrations(source(), bindings.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(source(), bindings.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(source(), bindings.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(source(), bindings.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await initializeStorageSource(source(), sourceId);
  await initializeTypedV11Admission(source(), sourceNamespace);
  await initializeTypedV1Admission(source(), sourceNamespace);
  await applyD1Migrations(source(), bindings.TEST_INGESTION_ISOLATION_MIGRATIONS);
  await applyD1Migrations(target(), bindings.TEST_ANALYTICS_MIGRATIONS);
  await applyD1Migrations(bindings.DELETION_LEDGER, bindings.TEST_DELETION_LEDGER_MIGRATIONS);
  await initializeStorageAnalyticsRuntime({ source: source(), target: target(), sourceId, sourceNamespace });
}

async function seedV1Source(): Promise<TelemetryUsageCorrectionSource> {
  const fixture = await createV11DeviceFixture(source());
  const projected = telemetryV11LegacyProjection("usage", v11UsageRecord(day, "a", {
    eventId: `event:v2:${"e".repeat(64)}`,
    totalInputContextTokens: null,
    components: {
      inputUncachedTokens: 100,
      inputCacheReadTokens: null,
      inputCacheWriteTokens: null,
      outputTextTokens: 50,
      outputReasoningTokens: null,
      outputCombinedTokens: null,
    },
  }));
  if (!projected) throw new Error("synthetic correction projection missing");
  const record = JSON.parse(projected.canonicalRecord) as TelemetryV1UsageEvent;
  const envelopeDigest = await sha256Hex("synthetic-correction-erasure-envelope");
  const principal = await authenticateDevice(source(), fixture.authorization);
  const upload = await createDeviceUploadAuthorization(source(), principal, envelopeDigest, 200);
  const claimed = await claimDeviceUploadAuthorization(source(), `Upload ${upload.uploadAuthorization}`, {
    envelopeDigest, bodyBytes: 200, contentType: "application/json",
  });
  const chunkRowId = `chunk:${crypto.randomUUID()}`;
  const chunk = parseTelemetryV1Chunk({
    schemaVersion: "telemetry-contribution-v1.0",
    chunkId: `usage:${day}:0`,
    chunkRevision: 1,
    chunkDigest: await sha256Hex(canonicalTelemetryV11Json([record])),
    parserVersion: "synthetic-correction-erasure-v1",
    consent: {
      telemetrySchemaVersion: "telemetry-contribution-v1.0",
      fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0",
    },
    records: [record],
  });
  await insertTypedTelemetryV1Chunk(source(), {
    chunkRowId,
    participantId: fixture.participantId,
    deviceId: fixture.deviceId,
    chunk,
    envelopeDigest,
    r2Key: `synthetic/correction-erasure/${crypto.randomUUID()}`,
    deviceUploadAuthorizationId: claimed.authorizationId,
    createdAt: new Date().toISOString(),
    supersedes: null,
  }, sourceNamespace);
  const row = await source().prepare(`
    SELECT storage_row_id,source_row_id,source_namespace,format,participant_id,device_id,
      chunk_row_id,manifest_id,occurrence_id
      FROM typed_telemetry_compatibility_records
     WHERE participant_id=? AND chunk_row_id=? LIMIT 2
  `).bind(fixture.participantId, chunkRowId).first<{
    storage_row_id: number;
    source_row_id: number;
    source_namespace: string;
    format: "v1" | "v11";
    participant_id: string;
    device_id: string;
    chunk_row_id: string;
    manifest_id: string | null;
    occurrence_id: string;
  }>();
  const owner = await source().prepare(`
    SELECT link.owner_digest,revision,authority_epoch
      FROM storage_v11_owner_links link
      JOIN storage_owner_revisions revision_row ON revision_row.owner_digest=link.owner_digest
     WHERE link.participant_id=? LIMIT 2
  `).bind(fixture.participantId).first<{
    owner_digest: string;
    revision: number;
    authority_epoch: number;
  }>();
  if (!row || !owner) throw new Error("synthetic correction source missing");
  return {
    participantId: fixture.participantId,
    ownerDigest: owner.owner_digest,
    ownerRevision: owner.revision,
    authorityEpoch: owner.authority_epoch,
    sourceNamespace: row.source_namespace,
    sourceStorageRowId: row.storage_row_id,
    sourceRowId: row.source_row_id,
    sourceFormat: row.format,
    sourceDeviceId: row.device_id,
    sourceChunkId: row.chunk_row_id,
    sourceManifestId: row.manifest_id,
    recordJson: projected.canonicalRecord,
  };
}

beforeEach(async () => {
  await reset();
  await migrate();
});

describe("usage correction operational erasure", () => {
  it("captures active v1 evidence before authorized participant erasure and keeps global references", async () => {
    const sourceRecord = await seedV1Source();
    await source().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
    const dictionaryCount = await source()
      .prepare("SELECT COUNT(*) n FROM typed_telemetry_dictionary")
      .first<number>("n");
    expect(dictionaryCount).toBeGreaterThan(0);

    await captureTelemetryUsageCorrectionBeforeDelete(source(), sourceRecord);
    expect(await source().prepare("SELECT state FROM telemetry_usage_correction_runtime WHERE id=1").first("state"))
      .toBe("active");
    expect(await source().prepare("SELECT COUNT(*) n FROM telemetry_usage_correction_history").first<number>("n"))
      .toBe(1);
    expect(await source().prepare("SELECT COUNT(*) n FROM telemetry_usage_correction_facts").first<number>("n"))
      .toBe(1);

    const result = await eraseParticipantAsOwner(runtime(), "synthetic-admin", sourceRecord.participantId);
    expect(result).toMatchObject({ deleted: true, alreadyDeleted: false });
    expect(await source().prepare("SELECT 1 FROM participants WHERE id=?")
      .bind(sourceRecord.participantId).first()).toBeNull();
    expect(await source().prepare("SELECT COUNT(*) n FROM telemetry_usage_correction_history")
      .first<number>("n")).toBe(0);
    expect(await source().prepare("SELECT COUNT(*) n FROM telemetry_usage_correction_facts")
      .first<number>("n")).toBe(0);
    expect(await source().prepare("SELECT state FROM telemetry_usage_correction_runtime WHERE id=1")
      .first("state")).toBe("active");
    expect(await source().prepare("SELECT COUNT(*) n FROM typed_telemetry_dictionary")
      .first<number>("n")).toBe(dictionaryCount);
  }, 30000);
});
