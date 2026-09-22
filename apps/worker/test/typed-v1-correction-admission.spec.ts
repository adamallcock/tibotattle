import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalTelemetryV11Json } from "@app-usagemonitor/telemetry-contract";
import { createV11DeviceFixture, v11UsageRecord } from "./helpers/telemetry-v11";
import { authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization } from "../src/device-auth";
import { sha256Hex } from "../src/crypto";
import { initializeStorageSource } from "../src/analytics-delivery";
import { initializeTypedV1Admission, insertTypedTelemetryV1Chunk } from "../src/typed-v1-admission";
import { currentTelemetryV1Chunk } from "../src/telemetry-v1-repository";
import { parseTelemetryV1Chunk, type TelemetryV1UsageEvent } from "../src/telemetry-v1";
import { telemetryV11LegacyProjection } from "../src/telemetry-v11-compatibility";
import { readTelemetryUsageCorrectionEffectiveFacts } from "../src/telemetry-usage-correction-repository";

interface Bindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
}

const bindings = env as Bindings;
const db = () => bindings.USAGE_MONITOR_DB;
const sourceNamespace = "synthetic-v1-correction-admission";
const day = "2026-09-20";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), bindings.TEST_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_INGESTION_ISOLATION_MIGRATIONS);
  await initializeStorageSource(db(), "synthetic-v1-correction-journal");
  await initializeTypedV1Admission(db(), sourceNamespace);
});

async function makeInsert(
  fixture: Awaited<ReturnType<typeof createV11DeviceFixture>>,
  revision: number,
  eventId: string,
  totals: boolean,
  supersedes: Awaited<ReturnType<typeof currentTelemetryV1Chunk>> = null,
  count = 1,
  eventIds: readonly string[] = [],
) {
  const records = Array.from({ length: count }, (_, index) => {
    const primaryOccurrence = index === 0 && (count === 1 || eventIds.length > 0);
    const projected = telemetryV11LegacyProjection("usage", v11UsageRecord(day, "a", {
      eventId: eventIds[index] ?? (count === 1 ? eventId : `event:v2:${index.toString(16).padStart(64, "0")}`),
      modelId: primaryOccurrence ? "gpt-5.6-sol" : `synthetic-model-${index}`,
      sessionUuid: primaryOccurrence ? "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b"
        : `${index.toString(16).padStart(8, "0")}-8b2d-4c3e-9a6f-2f4f1c7d9e0b`,
      totalInputContextTokens: totals ? 150 : null,
      components: {
        inputUncachedTokens: 100, inputCacheReadTokens: null, inputCacheWriteTokens: null,
        outputTextTokens: 50, outputReasoningTokens: 25,
        outputCombinedTokens: totals ? 75 : null,
      },
    }));
    if (!projected) throw new Error("synthetic correction projection missing");
    return JSON.parse(projected.canonicalRecord) as TelemetryV1UsageEvent;
  });
  const envelopeDigest = await sha256Hex(`synthetic-v1-correction-envelope:${revision}`);
  const principal = await authenticateDevice(db(), fixture.authorization);
  const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 1000);
  const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`, {
    envelopeDigest, bodyBytes: 1000, contentType: "application/json",
  });
  const chunk = parseTelemetryV1Chunk({
    schemaVersion: "telemetry-contribution-v1.0", chunkId: `usage:${day}:0`, chunkRevision: revision,
    chunkDigest: await sha256Hex(canonicalTelemetryV11Json(records)), parserVersion: "synthetic-v1-correction-v1",
    consent: {
      telemetrySchemaVersion: "telemetry-contribution-v1.0",
      fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0",
    },
    records,
  });
  return {
    chunkRowId: `chunk:synthetic-correction-${revision}-${crypto.randomUUID()}`,
    participantId: fixture.participantId, deviceId: fixture.deviceId, chunk, envelopeDigest,
    r2Key: `synthetic/v1-correction-${crypto.randomUUID()}`,
    deviceUploadAuthorizationId: claimed.authorizationId, createdAt: new Date().toISOString(), supersedes,
  };
}

describe("active typed-v1 correction admission", () => {
  it("archives the old null-total row inside the real replacement batch and preserves receipt indexing", async () => {
    const fixture = await createV11DeviceFixture(db());
    const first = await makeInsert(fixture, 1, `event:v2:${"a".repeat(64)}`, false);
    await insertTypedTelemetryV1Chunk(db(), first, sourceNamespace);
    await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
    const prior = await currentTelemetryV1Chunk(db(), fixture.participantId, fixture.deviceId, "usage", day, 0);
    if (!prior) throw new Error("synthetic correction predecessor missing");
    const replacement = await makeInsert(fixture, 2, `event:v2:${"a".repeat(64)}`, true, prior);
    await expect(insertTypedTelemetryV1Chunk(db(), replacement, sourceNamespace)).resolves.toMatchObject({
      acceptedRecords: 1, replay: false,
    });
    expect(await db().prepare("SELECT count(*) n FROM telemetry_usage_correction_history").first<number>("n")).toBe(1);
    expect(await db().prepare("SELECT count(*) n FROM telemetry_usage_correction_facts").first<number>("n")).toBe(1);
    expect(await db().prepare("SELECT total_input_context_tokens n FROM telemetry_usage_correction_history").first<number | null>("n")).toBeNull();
    expect(await db().prepare("SELECT output_combined_tokens n FROM telemetry_usage_correction_history").first<number | null>("n")).toBeNull();
    expect(await db().prepare("SELECT output_text_tokens n FROM telemetry_usage_correction_history").first<number | null>("n")).toBe(50);
    expect(await db().prepare("SELECT output_reasoning_tokens n FROM telemetry_usage_correction_history").first<number | null>("n")).toBe(25);
    expect(await db().prepare("SELECT count(*) n FROM typed_telemetry_records").first<number>("n")).toBe(1);
  });

  it("retains known totals when a late-null replacement also adds a new occurrence", async () => {
    const fixture = await createV11DeviceFixture(db());
    const knownEventId = `event:v2:${"e".repeat(64)}`;
    const uniqueEventId = `event:v2:${"f".repeat(64)}`;
    const first = await makeInsert(fixture, 1, knownEventId, true);
    await insertTypedTelemetryV1Chunk(db(), first, sourceNamespace);
    await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
    const prior = await currentTelemetryV1Chunk(db(), fixture.participantId, fixture.deviceId, "usage", day, 0);
    if (!prior) throw new Error("synthetic known predecessor missing");
    const replacement = await makeInsert(fixture, 2, knownEventId, false, prior, 2, [knownEventId, uniqueEventId]);
    await expect(insertTypedTelemetryV1Chunk(db(), replacement, sourceNamespace)).resolves.toMatchObject({
      acceptedRecords: 2, replay: false,
    });

    const history = await db().prepare(`
      SELECT total_input_context_tokens,output_combined_tokens,output_text_tokens,output_reasoning_tokens
        FROM telemetry_usage_correction_history LIMIT 2
    `).first<{
      total_input_context_tokens: number | null; output_combined_tokens: number | null;
      output_text_tokens: number | null; output_reasoning_tokens: number | null;
    }>();
    expect(history).toMatchObject({
      total_input_context_tokens: 150, output_combined_tokens: 75,
      output_text_tokens: 50, output_reasoning_tokens: 25,
    });
    expect(await db().prepare("SELECT count(*) n FROM telemetry_usage_correction_history").first<number>("n")).toBe(1);
    expect(await db().prepare("SELECT count(*) n FROM typed_telemetry_records").first<number>("n")).toBe(2);
    expect(await db().prepare("SELECT count(*) n FROM typed_telemetry_compatibility_records WHERE occurrence_id=?")
      .bind(uniqueEventId).first<number>("n")).toBe(1);

    const owner = await db().prepare(`
      SELECT owner_digest,revision,authority_epoch FROM storage_owner_revisions
       WHERE owner_digest=(SELECT owner_digest FROM storage_v11_owner_links WHERE participant_id=?)
       LIMIT 1
    `).bind(fixture.participantId).first<{ owner_digest: string; revision: number; authority_epoch: number }>();
    if (!owner) throw new Error("synthetic current owner tuple missing");
    const facts = await readTelemetryUsageCorrectionEffectiveFacts(db(), {
      ownerDigest: owner.owner_digest, ownerRevision: owner.revision, authorityEpoch: owner.authority_epoch,
    });
    expect(facts.rows).toHaveLength(1);
    expect(facts.rows[0]).toMatchObject({ totalInputContextTokens: 150, outputCombinedTokens: 75 });
  });

  it("blocks an old direct typed retirement after activation until history exists", async () => {
    const fixture = await createV11DeviceFixture(db());
    const first = await makeInsert(fixture, 1, `event:v2:${"b".repeat(64)}`, false);
    await insertTypedTelemetryV1Chunk(db(), first, sourceNamespace);
    await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
    const typed = await db().prepare(`
      SELECT typed.id FROM typed_telemetry_chunks typed
      JOIN typed_v1_chunk_allocations allocation
        ON allocation.namespace_id=typed.namespace_id AND allocation.chunk_original=typed.original_id
       AND allocation.chunk_id=?
       WHERE typed.format=10 LIMIT 2
    `).bind(first.chunkRowId).first<{ id: number }>();
    if (!typed) throw new Error("synthetic typed parent missing");
    await expect(db().prepare("DELETE FROM typed_telemetry_chunks WHERE id=?").bind(typed.id).run())
      .rejects.toThrow("telemetry_usage_correction_archive_required");
    expect(await db().prepare("SELECT count(*) n FROM typed_telemetry_records").first<number>("n")).toBe(1);
  });

  it("fences allocation deletion after header supersession until typed retirement is guarded", async () => {
    const fixture = await createV11DeviceFixture(db());
    const first = await makeInsert(fixture, 1, `event:v2:${"a".repeat(64)}`, false);
    await insertTypedTelemetryV1Chunk(db(), first, sourceNamespace);
    const control = await db().prepare(`
      SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1
    `).first<{ mutation_epoch: number }>();
    if (!control) throw new Error("synthetic graph control missing");
    const supersededAt = new Date().toISOString();
    await db().prepare(`
      INSERT INTO community_graph_update_scope(
        singleton,participant_id,device_id,stream,chunk_day,chunk_seq,old_chunk_id,new_chunk_id,
        new_revision,chunk_digest,parser_version,record_count,authorization_id,envelope_digest,
        created_at,expected_epoch,phase
      ) VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'supersede')
    `).bind(
      fixture.participantId, fixture.deviceId, "usage", day, 0, first.chunkRowId,
      `chunk:synthetic-unmaterialized-${crypto.randomUUID()}`, 2, first.chunk.chunkDigest,
      first.chunk.parserVersion, 1, first.deviceUploadAuthorizationId, first.envelopeDigest,
      supersededAt, control.mutation_epoch,
    ).run();
    await db().prepare("UPDATE telemetry_v1_chunks SET superseded_at=? WHERE id=?")
      .bind(supersededAt, first.chunkRowId).run();
    expect(await db().prepare("SELECT superseded_at FROM telemetry_v1_chunks WHERE id=?")
      .bind(first.chunkRowId).first<{ superseded_at: string | null }>("superseded_at")).toBe(supersededAt);
    await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();

    await expect(db().prepare("DELETE FROM typed_v1_chunk_allocations WHERE chunk_id=?")
      .bind(first.chunkRowId).run()).rejects.toThrow("telemetry_usage_correction_archive_required");
    const typed = await db().prepare(`
      SELECT typed.id FROM typed_telemetry_chunks typed
      JOIN typed_v1_chunk_allocations allocation
        ON allocation.namespace_id=typed.namespace_id AND allocation.chunk_original=typed.original_id
       AND allocation.chunk_id=?
       WHERE typed.format=10 AND typed.stream=1 LIMIT 1
    `).bind(first.chunkRowId).first<{ id: number }>();
    if (!typed) throw new Error("synthetic superseded typed chunk missing");
    await expect(db().prepare("DELETE FROM typed_telemetry_chunks WHERE id=?").bind(typed.id).run())
      .rejects.toThrow("telemetry_usage_correction_archive_required");
  });

  it("keeps the admission and record fences for direct retirement", async () => {
    const fixture = await createV11DeviceFixture(db());
    const first = await makeInsert(fixture, 1, `event:v2:${"c".repeat(64)}`, false);
    await insertTypedTelemetryV1Chunk(db(), first, sourceNamespace);
    await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
    const ids = await db().prepare(`
      SELECT admission.typed_record_id FROM typed_v1_record_admissions admission
       WHERE admission.chunk_id=? LIMIT 2
    `).bind(first.chunkRowId).first<{ typed_record_id: number }>();
    if (!ids) throw new Error("synthetic admission missing");
    await expect(db().prepare("DELETE FROM typed_v1_record_admissions WHERE chunk_id=? AND typed_record_id=?")
      .bind(first.chunkRowId, ids.typed_record_id).run()).rejects.toThrow("telemetry_usage_correction_archive_required");
    await expect(db().prepare("DELETE FROM typed_telemetry_records WHERE id=?")
      .bind(ids.typed_record_id).run()).rejects.toThrow("telemetry_usage_correction_archive_required");
  });

  it("fits the maximum 200 diverse usage records through one active replacement", async () => {
    const fixture = await createV11DeviceFixture(db());
    const first = await makeInsert(fixture, 1, "unused", false, null, 200);
    await insertTypedTelemetryV1Chunk(db(), first, sourceNamespace);
    await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
    const prior = await currentTelemetryV1Chunk(db(), fixture.participantId, fixture.deviceId, "usage", day, 0);
    if (!prior) throw new Error("synthetic maximum predecessor missing");
    const replacement = await makeInsert(fixture, 2, "unused", true, prior, 200);
    await expect(insertTypedTelemetryV1Chunk(db(), replacement, sourceNamespace)).resolves.toMatchObject({
      acceptedRecords: 200, replay: false,
    });
    expect(await db().prepare("SELECT count(*) n FROM telemetry_usage_correction_history").first<number>("n")).toBe(200);
    expect(await db().prepare("SELECT count(*) n FROM telemetry_usage_correction_facts").first<number>("n")).toBe(200);
    expect(await db().prepare("SELECT count(*) n FROM typed_telemetry_records").first<number>("n")).toBe(200);
  });

  it("keeps authorized participant erasure available while the archive fence is active", async () => {
    const fixture = await createV11DeviceFixture(db());
    const first = await makeInsert(fixture, 1, `event:v2:${"d".repeat(64)}`, false);
    await insertTypedTelemetryV1Chunk(db(), first, sourceNamespace);
    await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
    await expect(db().prepare("DELETE FROM participants WHERE id=?").bind(fixture.participantId).run()).resolves.toBeDefined();
    expect(await db().prepare("SELECT count(*) n FROM typed_telemetry_records").first<number>("n")).toBe(0);
    expect(await db().prepare("SELECT count(*) n FROM telemetry_usage_correction_history").first<number>("n")).toBe(0);
  });
});
