import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalTelemetryV11Json } from "@app-usagemonitor/telemetry-contract";
import { initializeStorageSource } from "../src/analytics-delivery";
import { authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization } from "../src/device-auth";
import { resolveTelemetryStorageMode } from "../src/telemetry-storage-mode";
import { parseTelemetryV1Chunk, type TelemetryV1Record } from "../src/telemetry-v1";
import { type TelemetryV1ChunkInsert } from "../src/telemetry-v1-repository";
import { initializeTypedV1Admission, insertTypedTelemetryV1Chunk } from "../src/typed-v1-admission";
import { loadTypedV1AnalysisScope } from "../src/typed-v1-analysis-reader";
import { encodeTypedTelemetryId } from "../src/typed-telemetry-codec";
import { readQualifiedTypedTelemetryOwnerOrigins, TYPED_TELEMETRY_ORIGIN_SCHEMA_DIGEST } from "../src/typed-telemetry-origins";
import { createV11DeviceFixture, makeV11Day, v11UsageRecord } from "./helpers/telemetry-v11";
import { sha256Hex } from "../src/crypto";
import { telemetryV11LegacyProjection } from "../src/telemetry-v11-repository";
import { registerTelemetryV11DayManifest } from "../src/telemetry-v11-repository";
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../src/typed-v11-admission";
import { readTypedV11ManifestPage } from "../src/typed-v11-record-reader";
import { readTypedV11ChunkRecords } from "../src/typed-v11-analysis-reader";

const b = env as Env & { TEST_MIGRATIONS: D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[]; TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[] };
const db = () => b.USAGE_MONITOR_DB;
const currentNamespace = "synthetic-origin-b";
const retainedNamespace = "synthetic-origin-a";
const day = () => new Date().toISOString().slice(0, 10);
const binary = (value: string): ArrayBuffer => Uint8Array.from(encodeTypedTelemetryId(value)).buffer;
const count = (table: string) => db().prepare(`SELECT count(*) n FROM ${table}`).first<number>("n");

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), b.TEST_MIGRATIONS);
  await applyD1Migrations(db(), b.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(db(), b.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(db(), b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await initializeStorageSource(db(), "synthetic-two-origin-journal");
  await initializeTypedV1Admission(db(), currentNamespace);
});

async function seedCurrent() {
  const fixture = await createV11DeviceFixture(db());
  const record = JSON.parse(telemetryV11LegacyProjection("usage", v11UsageRecord(day()))!.canonicalRecord) as TelemetryV1Record;
  const envelopeDigest = await sha256Hex(`synthetic-origin-${crypto.randomUUID()}`);
  const principal = await authenticateDevice(db(), fixture.authorization);
  const issued = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 200);
  const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${issued.uploadAuthorization}`,
    { envelopeDigest, bodyBytes: 200, contentType: "application/json" });
  const records = [record];
  const chunk = parseTelemetryV1Chunk({ schemaVersion: "telemetry-contribution-v1.0", chunkId: `usage:${day()}:0`,
    chunkRevision: 1, chunkDigest: await sha256Hex(canonicalTelemetryV11Json(records)), parserVersion: "synthetic-origin-v1",
    consent: { telemetrySchemaVersion: "telemetry-contribution-v1.0",
      fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0" }, records });
  const insert: TelemetryV1ChunkInsert = { chunkRowId: `chunk:${crypto.randomUUID()}`,
    participantId: fixture.participantId, deviceId: fixture.deviceId, chunk,
    envelopeDigest, r2Key: `synthetic/${crypto.randomUUID()}`,
    deviceUploadAuthorizationId: claimed.authorizationId, createdAt: new Date().toISOString(), supersedes: null };
  await insertTypedTelemetryV1Chunk(db(), insert, currentNamespace);
  return { fixture, insert };
}

async function registerRetainedOwner(participantId: string, namespace = retainedNamespace) {
  await db().prepare("INSERT INTO typed_telemetry_namespaces(original_id) VALUES(?)").bind(binary(namespace)).run();
  const namespaceId = await db().prepare("SELECT id FROM typed_telemetry_namespaces WHERE original_id=?")
    .bind(binary(namespace)).first<number>("id");
  await db().prepare(`INSERT INTO typed_telemetry_origin_contracts(
    namespace_id,namespace_original,access_mode,v1_read_contract_version,v11_read_contract_version,
    source_schema_digest,registered_move_id,registered_at)
    VALUES(?,?,'retained-read',2,0,?,'synthetic-move-a','2026-09-13T00:00:00.000Z')`)
    .bind(namespaceId, binary(namespace), TYPED_TELEMETRY_ORIGIN_SCHEMA_DIGEST).run();
  await db().prepare("INSERT INTO typed_telemetry_owners(namespace_id,original_id) VALUES(?,?)")
    .bind(namespaceId, binary(participantId)).run();
  const ownerId = await db().prepare("SELECT id FROM typed_telemetry_owners WHERE namespace_id=? AND original_id=?")
    .bind(namespaceId, binary(participantId)).first<number>("id");
  await db().prepare("INSERT INTO typed_v1_owner_memberships(participant_id,namespace_id,typed_owner_id) VALUES(?,?,?)")
    .bind(participantId, namespaceId, ownerId).run();
  return { namespaceId: namespaceId!, ownerId: ownerId! };
}

describe("qualified typed telemetry origins", () => {
  it("keeps one writable origin, preserves both owner identities, and replays only the current origin", async () => {
    const { fixture, insert } = await seedCurrent();
    const current = await db().prepare(`SELECT r.source_row_id,c.source_namespace
      FROM typed_telemetry_records r JOIN typed_telemetry_origin_contracts c ON c.namespace_id=r.namespace_id`)
      .first<{ source_row_id: number; source_namespace: string }>();
    expect(current).toEqual({ source_row_id: 1, source_namespace: currentNamespace });
    const retained = await registerRetainedOwner(fixture.participantId);
    expect(await readQualifiedTypedTelemetryOwnerOrigins(db(), fixture.participantId, "v1")).toEqual([
      { namespaceId: retained.namespaceId, sourceNamespace: retainedNamespace, typedOwnerId: retained.ownerId, accessMode: "retained-read" },
      expect.objectContaining({ sourceNamespace: currentNamespace, accessMode: "current-write" }),
    ]);
    await expect(loadTypedV1AnalysisScope(db(), fixture.participantId)).rejects.toThrow("TYPED_V1_ANALYSIS_NOT_READY");
    expect(await insertTypedTelemetryV1Chunk(db(), insert, currentNamespace)).toMatchObject({ replay: true, acceptedRecords: 1 });
    await expect(insertTypedTelemetryV1Chunk(db(), insert, retainedNamespace)).rejects.toMatchObject({ code: "TYPED_TELEMETRY_CONFLICT" });
    expect(await count("typed_telemetry_records")).toBe(1);
    await expect(resolveTelemetryStorageMode(db(), { TELEMETRY_STORAGE_MODE: "typed",
      TELEMETRY_STORAGE_NAMESPACE: retainedNamespace }, "v1")).rejects.toMatchObject({ code: "BACKEND_STORAGE_UNAVAILABLE" });
  });

  it("rejects namespace and owner collisions without changing qualified closure", async () => {
    const { fixture } = await seedCurrent();
    await registerRetainedOwner(fixture.participantId);
    const before = await readQualifiedTypedTelemetryOwnerOrigins(db(), fixture.participantId, "v1");
    const third = "synthetic-origin-c";
    await db().prepare("INSERT INTO typed_telemetry_namespaces(original_id) VALUES(?)").bind(binary(third)).run();
    const thirdId = await db().prepare("SELECT id FROM typed_telemetry_namespaces WHERE original_id=?")
      .bind(binary(third)).first<number>("id");
    await expect(db().prepare(`INSERT INTO typed_telemetry_origin_contracts(
      namespace_id,namespace_original,access_mode,v1_read_contract_version,v11_read_contract_version,
      source_schema_digest,registered_move_id,registered_at)
      VALUES(?,?,'retained-read',2,0,?,'synthetic-bad','2026-09-13T00:00:00.000Z')`)
      .bind(thirdId, binary(retainedNamespace), TYPED_TELEMETRY_ORIGIN_SCHEMA_DIGEST).run())
      .rejects.toThrow("typed_origin_namespace_conflict");
    await db().prepare("INSERT INTO typed_telemetry_owners(namespace_id,original_id) VALUES(?,?)")
      .bind(thirdId, binary("participant:00000000-0000-4000-8000-000000000001")).run();
    const wrongOwner = await db().prepare("SELECT max(id) id FROM typed_telemetry_owners").first<number>("id");
    await expect(db().prepare("INSERT INTO typed_v1_owner_memberships(participant_id,namespace_id,typed_owner_id) VALUES(?,?,?)")
      .bind(fixture.participantId, thirdId, wrongOwner).run()).rejects.toThrow();
    expect(await readQualifiedTypedTelemetryOwnerOrigins(db(), fixture.participantId, "v1")).toEqual(before);
  });

  it("cascades every namespace-specific owner while retaining database origin contracts", async () => {
    const { fixture } = await seedCurrent();
    await registerRetainedOwner(fixture.participantId);
    expect(await count("typed_v1_owner_memberships")).toBe(2);
    expect(await count("typed_telemetry_owners")).toBe(2);
    await db().prepare("DELETE FROM participants WHERE id=?").bind(fixture.participantId).run();
    expect(await count("typed_v1_owner_memberships")).toBe(0);
    expect(await count("typed_telemetry_owners")).toBe(0);
    expect(await count("typed_telemetry_origin_contracts")).toBe(2);
  });

  it("resolves v1.1 manifests and private chunks by their exact qualified origin", async () => {
    await reset();
    await applyD1Migrations(db(), b.TEST_MIGRATIONS);
    await applyD1Migrations(db(), b.TEST_TYPED_INGESTION_MIGRATIONS);
    await applyD1Migrations(db(), b.TEST_INGESTION_BRIDGE_MIGRATIONS);
    await applyD1Migrations(db(), b.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
    await initializeStorageSource(db(), "synthetic-two-origin-v11-journal");
    await initializeTypedV11Admission(db(), currentNamespace);
    const fixture = await createV11DeviceFixture(db(), { grant: true });
    const prepared = await makeV11Day(day(), { usage: [v11UsageRecord(day())] });
    const manifest = await registerTelemetryV11DayManifest(db(), fixture, prepared.manifest);
    const envelopeDigest = await sha256Hex(`synthetic-origin-v11-${crypto.randomUUID()}`);
    const principal = await authenticateDevice(db(), fixture.authorization);
    const issued = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 200);
    const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${issued.uploadAuthorization}`,
      { envelopeDigest, bodyBytes: 200, contentType: "application/json" });
    const metadata = { sourceNamespace: currentNamespace, chunkRowId: `chunk:${crypto.randomUUID()}`,
      r2Key: `synthetic/${crypto.randomUUID()}`, envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId };
    await persistTypedV11StagedChunk(db(), fixture, prepared.chunks[0]!, metadata);

    await db().prepare("INSERT INTO typed_telemetry_namespaces(original_id) VALUES(?)")
      .bind(binary(retainedNamespace)).run();
    const retainedId = await db().prepare("SELECT id FROM typed_telemetry_namespaces WHERE original_id=?")
      .bind(binary(retainedNamespace)).first<number>("id");
    await db().prepare(`INSERT INTO typed_telemetry_origin_contracts(
      namespace_id,namespace_original,access_mode,v1_read_contract_version,v11_read_contract_version,
      source_schema_digest,registered_move_id,registered_at)
      VALUES(?,?,'retained-read',0,2,?,'synthetic-move-v11','2026-09-13T00:00:00.000Z')`)
      .bind(retainedId, binary(retainedNamespace), TYPED_TELEMETRY_ORIGIN_SCHEMA_DIGEST).run();
    await db().prepare("INSERT INTO typed_telemetry_owners(namespace_id,original_id) VALUES(?,?)")
      .bind(retainedId, binary(fixture.participantId)).run();
    const retainedOwner = await db().prepare("SELECT id FROM typed_telemetry_owners WHERE namespace_id=? AND original_id=?")
      .bind(retainedId, binary(fixture.participantId)).first<number>("id");
    await db().prepare("INSERT INTO typed_v11_owner_memberships(participant_id,namespace_id,typed_owner_id) VALUES(?,?,?)")
      .bind(fixture.participantId, retainedId, retainedOwner).run();

    expect((await readQualifiedTypedTelemetryOwnerOrigins(db(), fixture.participantId, "v11"))
      .map(origin => origin.sourceNamespace)).toEqual([retainedNamespace, currentNamespace]);
    expect(await readTypedV11ManifestPage(db(), { sourceNamespace: currentNamespace,
      participantId: fixture.participantId, deviceId: fixture.deviceId, manifestId: manifest.manifestId,
      afterStream: "", afterOccurrence: "", limit: 2 })).toHaveLength(1);
    await expect(readTypedV11ManifestPage(db(), { sourceNamespace: retainedNamespace,
      participantId: fixture.participantId, deviceId: fixture.deviceId, manifestId: manifest.manifestId,
      afterStream: "", afterOccurrence: "", limit: 2 })).rejects.toThrow("TYPED_V11_READER_MEMBERSHIP_CONFLICT");
    expect(await readTypedV11ChunkRecords(db(), { sourceNamespace: currentNamespace,
      participantId: fixture.participantId, chunkId: metadata.chunkRowId, expectedCount: 1 })).toHaveLength(1);
    await expect(readTypedV11ChunkRecords(db(), { sourceNamespace: retainedNamespace,
      participantId: fixture.participantId, chunkId: metadata.chunkRowId, expectedCount: 1 }))
      .rejects.toThrow("TYPED_V11_EXPORT_MEMBERSHIP_CONFLICT");
    await db().prepare("DELETE FROM participants WHERE id=?").bind(fixture.participantId).run();
    expect(await count("typed_v11_owner_memberships")).toBe(0);
    expect(await count("typed_telemetry_owners")).toBe(0);
  });
});
