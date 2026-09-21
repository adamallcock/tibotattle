import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalTelemetryV11Json } from "@app-usagemonitor/telemetry-contract";
import { createV11DeviceFixture, v11UsageRecord } from "./helpers/telemetry-v11";
import { authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization } from "../src/device-auth";
import { sha256Hex } from "../src/crypto";
import { initializeStorageSource } from "../src/analytics-delivery";
import { insertTypedTelemetryV1Chunk, initializeTypedV1Admission } from "../src/typed-v1-admission";
import { parseTelemetryV1Chunk, type TelemetryV1UsageEvent } from "../src/telemetry-v1";
import { currentTelemetryV1Chunk, prepareTelemetryV1ChunkWrite } from "../src/telemetry-v1-repository";
import { prepareTypedTelemetryInsert } from "../src/typed-telemetry-repository";
import { encodeTypedTelemetryId } from "../src/typed-telemetry-codec";
import { telemetryV11LegacyProjection } from "../src/telemetry-v11-compatibility";
import {
  captureTelemetryUsageCorrectionBeforeDelete,
  prepareTelemetryUsageCorrectionCaptureBatch,
  readTelemetryUsageCorrectionEffectiveFacts,
  readTelemetryUsageCorrectionHistory,
  TELEMETRY_USAGE_CORRECTION_SOURCE_PAGE_SQL,
  type TelemetryUsageCorrectionSource,
} from "../src/telemetry-usage-correction-repository";

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
const sourceNamespace = "synthetic-usage-correction";
const sourceId = "synthetic-usage-correction-source";
const day = "2026-09-20";
const OWNER_CAS_SQL = "SELECT owner.owner_digest,owner.revision,owner.authority_epoch";

function binary(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../gu)!.map((pair) => Number.parseInt(pair, 16)));
}

async function migrate(includeCorrection = true): Promise<void> {
  await applyD1Migrations(db(), bindings.TEST_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await applyD1Migrations(db(), includeCorrection
    ? bindings.TEST_INGESTION_ISOLATION_MIGRATIONS
    : bindings.TEST_INGESTION_ISOLATION_MIGRATIONS.filter((migration) => !migration.name.startsWith("0006_")));
  await initializeStorageSource(db(), sourceId);
  await initializeTypedV1Admission(db(), sourceNamespace);
}

async function seedSources(count = 2,
  existingFixture?: Awaited<ReturnType<typeof createV11DeviceFixture>>, chunkSeq = 0): Promise<TelemetryUsageCorrectionSource[]> {
  const fixture = existingFixture ?? await createV11DeviceFixture(db());
  const records = Array.from({ length: count }, (_, index) => {
    const eventId = `event:v2:${(chunkSeq * 1000 + index).toString(36).padStart(3, "0")}`;
    const projected = telemetryV11LegacyProjection("usage", v11UsageRecord(day, "a", {
      eventId,
      totalInputContextTokens: null,
      components: { inputUncachedTokens: 100, inputCacheReadTokens: null, inputCacheWriteTokens: null,
        outputTextTokens: 50, outputReasoningTokens: null, outputCombinedTokens: null },
    }));
    if (!projected) throw new Error("missing synthetic legacy projection");
    return JSON.parse(projected.canonicalRecord) as TelemetryV1UsageEvent;
  });
  const envelopeDigest = await sha256Hex(`synthetic-correction-envelope:${chunkSeq}`);
  const principal = await authenticateDevice(db(), fixture.authorization);
  const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 200);
  const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`, {
    envelopeDigest, bodyBytes: 200, contentType: "application/json",
  });
  const chunk = parseTelemetryV1Chunk({
    schemaVersion: "telemetry-contribution-v1.0", chunkId: `usage:${day}:${chunkSeq}`, chunkRevision: 1,
    chunkDigest: await sha256Hex(canonicalTelemetryV11Json(records)), parserVersion: "synthetic-correction-v1",
    consent: { telemetrySchemaVersion: "telemetry-contribution-v1.0",
      fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0" }, records,
  });
  const chunkRowId = `chunk:${crypto.randomUUID()}`;
  await insertTypedTelemetryV1Chunk(db(), {
    chunkRowId, participantId: fixture.participantId, deviceId: fixture.deviceId, chunk,
    envelopeDigest, r2Key: `synthetic/correction-${crypto.randomUUID()}`,
    deviceUploadAuthorizationId: claimed.authorizationId, createdAt: new Date().toISOString(), supersedes: null,
  }, sourceNamespace);
  const rows = (await db().prepare(`
    SELECT v.storage_row_id,v.source_row_id,v.source_namespace,v.format,v.participant_id,v.device_id,
      v.chunk_row_id,v.manifest_id,v.occurrence_id FROM typed_telemetry_compatibility_records v
     WHERE v.participant_id=? AND v.chunk_row_id=? ORDER BY v.source_row_id LIMIT 201
  `).bind(fixture.participantId, chunkRowId).all<{
    storage_row_id: number; source_row_id: number; source_namespace: string; format: "v1" | "v11";
    participant_id: string; device_id: string; chunk_row_id: string; manifest_id: string | null; occurrence_id: string;
  }>()).results;
  const owner = await db().prepare(`
    SELECT link.owner_digest,revision,authority_epoch FROM storage_v11_owner_links link
      JOIN storage_owner_revisions revision_row ON revision_row.owner_digest=link.owner_digest
     WHERE link.participant_id=? LIMIT 2
  `).bind(fixture.participantId).first<{ owner_digest: string; revision: number; authority_epoch: number }>();
  const recordsByOccurrence = new Map(records.map((record) => [record.eventId, canonicalTelemetryV11Json(record)]));
  if (rows.length !== records.length || !owner || rows.some((row) => !recordsByOccurrence.has(row.occurrence_id))) {
    throw new Error("synthetic correction source did not admit");
  }
  return rows.map((row) => ({
    participantId: fixture.participantId, ownerDigest: owner.owner_digest,
    ownerRevision: owner.revision, authorityEpoch: owner.authority_epoch,
    sourceNamespace: row.source_namespace, sourceStorageRowId: row.storage_row_id,
    sourceRowId: row.source_row_id, sourceFormat: row.format, sourceDeviceId: row.device_id,
    sourceChunkId: row.chunk_row_id, sourceManifestId: row.manifest_id,
    recordJson: recordsByOccurrence.get(row.occurrence_id)!,
  }));
}

async function seed(): Promise<TelemetryUsageCorrectionSource> {
  return (await seedSources())[0]!;
}

/** Advance the owner journal through the same synthetic source-change proof
 * used by the existing pagination regression. This changes both revision and
 * authority epoch while preserving the admitted source rows. */
async function advanceOwnerRevision(ownerDigest: string): Promise<void> {
  await db().prepare(`
    INSERT INTO storage_ingestion_changes(
      event_digest,owner_digest,revision,kind,object_digest,content_digest,
      authority_epoch,public_authority_epoch,recorded_ms
    )
    SELECT lower(hex(randomblob(32))),owner.owner_digest,owner.revision+1,'source-updated',latest.object_digest,
      latest.content_digest,owner.authority_epoch,
      (SELECT authority_epoch FROM storage_source_state WHERE singleton=1),
      CAST(strftime('%s','now') AS INTEGER)*1000
      FROM storage_owner_revisions owner
      JOIN storage_ingestion_changes latest
        ON latest.owner_digest=owner.owner_digest AND latest.revision=owner.revision
     WHERE owner.owner_digest=?
  `).bind(ownerDigest).run();
}

/** Wrap only the D1 owner-CAS statement. The original database is used for
 * the synthetic journal mutation so the wrapper does not recursively count
 * its own update. Every other D1 method keeps its original receiver. */
function advanceOwnerBeforeCas(database: D1Database, ownerDigest: string, casNumber: number,
  onAdvance?: () => void, afterCas?: () => Promise<void> | void): { database: D1Database; casReads: () => number } {
  let casReads = 0;
  const wrapStatement = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
    get(target, property, receiver) {
      if (property === "bind") {
        return (...values: unknown[]) => wrapStatement(target.bind(...values), sql);
      }
      if (property === "first" && sql.replace(/\s+/gu, " ").includes(OWNER_CAS_SQL)) {
        return async (...args: unknown[]) => {
          casReads += 1;
          if (casReads === casNumber && !afterCas) {
            await advanceOwnerRevision(ownerDigest);
            onAdvance?.();
          }
          const result = await Reflect.apply(target.first as (...values: unknown[]) => Promise<unknown>, target, args);
          if (casReads === casNumber && afterCas) {
            await advanceOwnerRevision(ownerDigest);
            await afterCas();
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const wrapped = new Proxy(database, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql: string) => wrapStatement(target.prepare(sql), sql);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database: wrapped, casReads: () => casReads };
}

function withBatch(database: D1Database, batch: D1Database["batch"]): D1Database {
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === "batch") return batch;
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function withRuntimeRow(database: D1Database, row: Record<string, unknown> | null): D1Database {
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("telemetry_usage_correction_runtime")) return statement;
          return new Proxy(statement, {
            get(inner, key, innerReceiver) {
              if (key === "first") return async () => row;
              const value = Reflect.get(inner, key, innerReceiver);
              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

beforeEach(async () => { await reset(); });

describe("staged usage correction repository", () => {
  it("refuses reads before the dormant migration is installed", async () => {
    await migrate(false);
    await expect(readTelemetryUsageCorrectionHistory(db())).rejects.toMatchObject({
      code: "TELEMETRY_USAGE_CORRECTION_UNAVAILABLE",
    });
  });

  it("refuses a missing or unknown runtime schema version", async () => {
    await migrate();
    const source = await seed();
    await captureTelemetryUsageCorrectionBeforeDelete(db(), source);
    const read = { ownerDigest: source.ownerDigest, ownerRevision: source.ownerRevision, authorityEpoch: source.authorityEpoch };
    for (const row of [
      { state: "active", method_version: "usage-total-correction-v1", max_capture_rows: 200, max_history_page: 200 },
      { schema_version: "telemetry-usage-correction-v2", state: "active", method_version: "usage-total-correction-v1", max_capture_rows: 200, max_history_page: 200 },
    ]) {
      await expect(readTelemetryUsageCorrectionHistory(withRuntimeRow(db(), row), read)).rejects.toMatchObject({
        code: "TELEMETRY_USAGE_CORRECTION_UNAVAILABLE",
      });
    }
  });

  it("captures compact source proof, replays idempotently, and keeps facts fenced while staged", async () => {
    await migrate();
    const source = await seed();
    const read = { ownerDigest: source.ownerDigest, ownerRevision: source.ownerRevision, authorityEpoch: source.authorityEpoch };
    const assertion = await captureTelemetryUsageCorrectionBeforeDelete(db(), source);
    expect(assertion.methodVersion).toBe("usage-total-correction-v1");
    expect(await db().prepare("SELECT count(*) n FROM telemetry_usage_correction_history").first<number>("n")).toBe(1);
    expect(await db().prepare("SELECT count(*) n FROM telemetry_usage_correction_facts").first<number>("n")).toBe(1);
    expect((await readTelemetryUsageCorrectionHistory(db(), read)).rows[0]?.usage.totalInputContextTokens).toBeNull();
    await expect(readTelemetryUsageCorrectionEffectiveFacts(db(), read)).rejects.toMatchObject({
      code: "TELEMETRY_USAGE_CORRECTION_NOT_ACTIVE",
    });
    await expect(readTelemetryUsageCorrectionHistory(db(), {
      ...read, ownerRevision: read.ownerRevision + 1,
    })).rejects.toMatchObject({ code: "TELEMETRY_USAGE_CORRECTION_CAS_MISMATCH" });
    await captureTelemetryUsageCorrectionBeforeDelete(db(), source);
    expect(await db().prepare("SELECT count(*) n FROM telemetry_usage_correction_history").first<number>("n")).toBe(1);
    expect(await db().prepare("SELECT count(*) n FROM telemetry_usage_correction_facts").first<number>("n")).toBe(1);
    await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
    const facts = await readTelemetryUsageCorrectionEffectiveFacts(db(), read);
    expect(facts.rows).toHaveLength(1);
    expect(facts.rows[0]?.sourceHistoryId).toBe(1);
  });

  it("rolls back the archive when the fact phase races or fails", async () => {
    await migrate();
    const source = await seed();
    await db().prepare(`CREATE TRIGGER synthetic_correction_failure
      BEFORE INSERT ON telemetry_usage_correction_facts
      BEGIN SELECT RAISE(ABORT,'synthetic correction failure'); END`).run();
    await expect(captureTelemetryUsageCorrectionBeforeDelete(db(), source)).rejects.toMatchObject({
      code: "TELEMETRY_USAGE_CORRECTION_CAS_MISMATCH",
    });
    expect(await db().prepare("SELECT count(*) n FROM telemetry_usage_correction_history").first<number>("n")).toBe(0);
    expect(await db().prepare("SELECT count(*) n FROM telemetry_usage_correction_facts").first<number>("n")).toBe(0);
  });

  it("rolls back archive and fact when source retirement fails", async () => {
    await migrate();
    const source = await seed();
    const retirementFailure = db().prepare("INSERT INTO telemetry_usage_correction_missing_table VALUES (1)");
    await expect(captureTelemetryUsageCorrectionBeforeDelete(db(), source, [retirementFailure])).rejects.toMatchObject({
      code: "TELEMETRY_USAGE_CORRECTION_CAS_MISMATCH",
    });
    expect(await db().prepare("SELECT count(*) n FROM telemetry_usage_correction_history").first<number>("n")).toBe(0);
    expect(await db().prepare("SELECT count(*) n FROM telemetry_usage_correction_facts").first<number>("n")).toBe(0);
  });

  it("refuses v1.1 and v1.2 capture until their current authority proof is qualified", async () => {
    await migrate();
    const source = await seed();
    await expect(prepareTelemetryUsageCorrectionCaptureBatch(db(), [{
      ...source, sourceFormat: "v11", sourceManifestId: "manifest:unsupported",
    }])).rejects.toMatchObject({ code: "TELEMETRY_USAGE_CORRECTION_SOURCE_UNAVAILABLE" });
    await expect(prepareTelemetryUsageCorrectionCaptureBatch(db(), [{
      ...source, sourceFormat: "v12", sourceManifestId: "manifest:unsupported",
    }])).rejects.toMatchObject({ code: "TELEMETRY_USAGE_CORRECTION_SOURCE_UNAVAILABLE" });
  });

  it("keeps the maximum source page within the shared batch budget", async () => {
    await migrate();
    const sources = await seedSources(200);
    const prepared = await prepareTelemetryUsageCorrectionCaptureBatch(db(), sources);
    expect(prepared.assertions).toHaveLength(200);
    await prepared.commit();
    expect(await db().prepare("SELECT count(*) n FROM telemetry_usage_correction_history").first<number>("n")).toBe(200);
    expect(await db().prepare("SELECT count(*) n FROM telemetry_usage_correction_facts").first<number>("n")).toBe(200);
  });

  it("expands only the bounded requested source page before the compatibility view", async () => {
    await migrate();
    const source = await seed();
    const plan = (await db().prepare(`EXPLAIN QUERY PLAN ${TELEMETRY_USAGE_CORRECTION_SOURCE_PAGE_SQL}`)
      .bind(JSON.stringify([source.sourceStorageRowId]), source.ownerDigest, source.participantId, source.sourceNamespace)
      .all<{ detail: string }>()).results.map((row) => row.detail);
    expect(plan.some((detail) => detail.includes("MATERIALIZE page"))).toBe(true);
    expect(plan.some((detail) => detail.includes("SEARCH raw USING INTEGER PRIMARY KEY"))).toBe(true);
  });

  it("rejects an oversized retirement batch before invoking D1 batch", async () => {
    await migrate();
    const source = await seed();
    let batchCalls = 0;
    const guarded = withBatch(db(), async () => {
      batchCalls += 1;
      throw new Error("synthetic batch must not run");
    });
    const prepared = await prepareTelemetryUsageCorrectionCaptureBatch(guarded, [source]);
    // The bounded page is one archive statement; its fact rows are created by
    // the archive trigger in the same SQLite transaction. The CAS plus four
    // fixed reads consume five additional units, so 895 caller retirement
    // statements exceed the 900-statement transaction budget.
    const retirement = Array.from({ length: 895 }, () => db().prepare("SELECT 1"));
    await expect(prepared.commit(retirement)).rejects.toMatchObject({
      code: "TELEMETRY_USAGE_CORRECTION_LIMIT",
    });
    expect(batchCalls).toBe(0);
  });

  it("rejects history and effective readers when the owner changes after page SQL", async () => {
    await migrate();
    const historySource = await seed();
    await captureTelemetryUsageCorrectionBeforeDelete(db(), historySource);
    const historyRead = {
      ownerDigest: historySource.ownerDigest,
      ownerRevision: historySource.ownerRevision,
      authorityEpoch: historySource.authorityEpoch,
      limit: 1,
    };
    const historyRace = advanceOwnerBeforeCas(db(), historySource.ownerDigest, 2);
    await expect(readTelemetryUsageCorrectionHistory(historyRace.database, historyRead)).rejects.toMatchObject({
      code: "TELEMETRY_USAGE_CORRECTION_CAS_MISMATCH",
    });
    expect(historyRace.casReads()).toBe(2);

    const effectiveSource = await seed();
    await captureTelemetryUsageCorrectionBeforeDelete(db(), effectiveSource);
    await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
    const effectiveRead = {
      ownerDigest: effectiveSource.ownerDigest,
      ownerRevision: effectiveSource.ownerRevision,
      authorityEpoch: effectiveSource.authorityEpoch,
      limit: 1,
    };
    const effectiveRace = advanceOwnerBeforeCas(db(), effectiveSource.ownerDigest, 2);
    await expect(readTelemetryUsageCorrectionEffectiveFacts(effectiveRace.database, effectiveRead)).rejects.toMatchObject({
      code: "TELEMETRY_USAGE_CORRECTION_CAS_MISMATCH",
    });
    expect(effectiveRace.casReads()).toBe(2);
  });

  it("rejects history and effective readers when reconstruction races the final CAS", async () => {
    await migrate();
    const historySource = await seed();
    await captureTelemetryUsageCorrectionBeforeDelete(db(), historySource);
    const historyRead = {
      ownerDigest: historySource.ownerDigest,
      ownerRevision: historySource.ownerRevision,
      authorityEpoch: historySource.authorityEpoch,
      limit: 1,
    };
    const historyRace = advanceOwnerBeforeCas(db(), historySource.ownerDigest, 3);
    await expect(readTelemetryUsageCorrectionHistory(historyRace.database, historyRead)).rejects.toMatchObject({
      code: "TELEMETRY_USAGE_CORRECTION_CAS_MISMATCH",
    });
    expect(historyRace.casReads()).toBe(3);

    const effectiveSource = await seed();
    await captureTelemetryUsageCorrectionBeforeDelete(db(), effectiveSource);
    await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
    const effectiveRead = {
      ownerDigest: effectiveSource.ownerDigest,
      ownerRevision: effectiveSource.ownerRevision,
      authorityEpoch: effectiveSource.authorityEpoch,
      limit: 1,
    };
    const effectiveRace = advanceOwnerBeforeCas(db(), effectiveSource.ownerDigest, 3);
    await expect(readTelemetryUsageCorrectionEffectiveFacts(effectiveRace.database, effectiveRead)).rejects.toMatchObject({
      code: "TELEMETRY_USAGE_CORRECTION_CAS_MISMATCH",
    });
    expect(effectiveRace.casReads()).toBe(3);
  });

  it("keeps the final CAS pinned to the validated read-options snapshot", async () => {
    await migrate();
    const source = await seed();
    await captureTelemetryUsageCorrectionBeforeDelete(db(), source);
    const options = {
      ownerDigest: source.ownerDigest,
      ownerRevision: source.ownerRevision,
      authorityEpoch: source.authorityEpoch,
      limit: 1,
    };
    const race = advanceOwnerBeforeCas(db(), source.ownerDigest, 2, undefined, async () => {
      // This models a caller mutating a mutable object while the public reader
      // is awaiting digest reconstruction. The reader must retain its own
      // normalized snapshot rather than re-reading caller-owned properties.
      const current = await db().prepare(`
        SELECT revision FROM storage_owner_revisions WHERE owner_digest=? LIMIT 2
      `).bind(source.ownerDigest).first<{ revision: number }>();
      if (!current) throw new Error("synthetic owner revision missing after page race");
      options.ownerRevision = current.revision;
    });
    await expect(readTelemetryUsageCorrectionHistory(race.database, options)).rejects.toMatchObject({
      code: "TELEMETRY_USAGE_CORRECTION_CAS_MISMATCH",
    });
    expect(race.casReads()).toBe(3);
  });

  it("refuses withdrawn owners and inactive links even with a current tuple", async () => {
    await migrate();
    const source = await seed();
    await captureTelemetryUsageCorrectionBeforeDelete(db(), source);
    await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
    const read = {
      ownerDigest: source.ownerDigest,
      ownerRevision: source.ownerRevision,
      authorityEpoch: source.authorityEpoch,
      limit: 1,
    };
    await db().prepare("UPDATE storage_owner_revisions SET state='withdrawn' WHERE owner_digest=?")
      .bind(source.ownerDigest).run();
    await expect(readTelemetryUsageCorrectionHistory(db(), read)).rejects.toMatchObject({
      code: "TELEMETRY_USAGE_CORRECTION_CAS_MISMATCH",
    });
    await expect(readTelemetryUsageCorrectionEffectiveFacts(db(), read)).rejects.toMatchObject({
      code: "TELEMETRY_USAGE_CORRECTION_CAS_MISMATCH",
    });

    await db().prepare("UPDATE storage_owner_revisions SET state='active' WHERE owner_digest=?")
      .bind(source.ownerDigest).run();
    await db().prepare("UPDATE storage_v11_owner_links SET state='withdrawn' WHERE owner_digest=?")
      .bind(source.ownerDigest).run();
    const current = await db().prepare(`
      SELECT revision,authority_epoch FROM storage_owner_revisions WHERE owner_digest=? LIMIT 2
    `).bind(source.ownerDigest).first<{ revision: number; authority_epoch: number }>();
    if (!current) throw new Error("synthetic owner tuple missing after withdrawal");
    const withdrawnLinkRead = {
      ownerDigest: source.ownerDigest,
      ownerRevision: current.revision,
      authorityEpoch: current.authority_epoch,
      limit: 1,
    };
    await expect(readTelemetryUsageCorrectionHistory(db(), withdrawnLinkRead)).rejects.toMatchObject({
      code: "TELEMETRY_USAGE_CORRECTION_CAS_MISMATCH",
    });
    await expect(readTelemetryUsageCorrectionEffectiveFacts(db(), withdrawnLinkRead)).rejects.toMatchObject({
      code: "TELEMETRY_USAGE_CORRECTION_CAS_MISMATCH",
    });
  });

  it("refuses a source-backed history row with a forged base digest in both readers", async () => {
    await migrate();
    const source = await seed();
    const digestRows = await db().prepare(`
      SELECT c.chunk_digest,e.event_digest
        FROM telemetry_v1_chunks c JOIN typed_v1_event_sources e ON e.chunk_id=c.id
       WHERE c.id=? LIMIT 2
    `).bind(source.sourceChunkId).first<{ chunk_digest: string; event_digest: string }>();
    if (!digestRows) throw new Error("synthetic correction source digests missing");
    await db().prepare(`
      INSERT INTO telemetry_usage_correction_history (
        participant_id,owner_digest,owner_revision,authority_epoch,source_format,namespace_id,owner_id,
        device_id,chunk_id,manifest_id,source_storage_row_id,source_row_id,occurrence_id,event_time_ms,
        provider_id,session_id,model_id,speed_mode_id,api_service_tier_id,surface_id,billing_surface_id,
        reasoning_effort_id,agent_scope_id,outcome_id,attribution_id,total_input_context_tokens,
        input_uncached_tokens,input_cache_read_tokens,input_cache_write_tokens,output_text_tokens,
        output_reasoning_tokens,output_combined_tokens,source_chunk_digest,source_event_digest,
        record_digest,base_digest,captured_at_ms
      )
      SELECT ?,?,?,?,?,raw.namespace_id,raw.owner_id,raw.device_id,raw.chunk_id,raw.manifest_id,
        raw.id,raw.source_row_id,raw.occurrence_id,raw.observed_at_ms,raw.provider_id,usage.session_id,
        usage.model_id,usage.speed_mode_id,usage.api_service_tier_id,usage.surface_id,usage.billing_surface_id,
        usage.reasoning_effort_id,usage.agent_scope_id,usage.outcome_id,usage.attribution_id,
        usage.total_input_context_tokens,usage.input_uncached_tokens,usage.input_cache_read_tokens,
        usage.input_cache_write_tokens,usage.output_text_tokens,usage.output_reasoning_tokens,
        usage.output_combined_tokens,?,?,raw.canonical_digest,zeroblob(32),?
      FROM typed_telemetry_records raw JOIN typed_telemetry_usage usage ON usage.record_id=raw.id
      WHERE raw.id=?
    `).bind(source.participantId, binary(source.ownerDigest), source.ownerRevision, source.authorityEpoch, 10,
      binary(digestRows.chunk_digest), binary(digestRows.event_digest), Date.now(), source.sourceStorageRowId).run();
    const read = { ownerDigest: source.ownerDigest, ownerRevision: source.ownerRevision, authorityEpoch: source.authorityEpoch };
    await expect(readTelemetryUsageCorrectionHistory(db(), read)).rejects.toMatchObject({
      code: "TELEMETRY_USAGE_CORRECTION_SOURCE_MISMATCH",
    });
    await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
    await expect(readTelemetryUsageCorrectionEffectiveFacts(db(), read)).rejects.toMatchObject({
      code: "TELEMETRY_USAGE_CORRECTION_SOURCE_MISMATCH",
    });
  });

  it("archives multiple current chunks after the owner head advances", async () => {
    await migrate();
    const fixture = await createV11DeviceFixture(db());
    const first = (await seedSources(1, fixture, 0))[0]!;
    const second = (await seedSources(1, fixture, 1))[0]!;
    const current = await db().prepare(`
      SELECT revision,authority_epoch FROM storage_owner_revisions WHERE owner_digest=? LIMIT 2
    `).bind(first.ownerDigest).first<{ revision: number; authority_epoch: number }>();
    if (!current) throw new Error("synthetic current owner tuple missing");
    const sources = [first, second].map((source) => ({
      ...source, ownerRevision: current.revision, authorityEpoch: current.authority_epoch,
    }));
    const prepared = await prepareTelemetryUsageCorrectionCaptureBatch(db(), sources);
    expect(prepared.assertions).toHaveLength(2);
    await prepared.commit();
    const read = {
      ownerDigest: first.ownerDigest,
      ownerRevision: current.revision,
      authorityEpoch: current.authority_epoch,
      limit: 2,
    };
    const history = await readTelemetryUsageCorrectionHistory(db(), read);
    expect(history.rows).toHaveLength(2);
    expect(new Set(history.rows.map((row) => row.source.chunkId)).size).toBe(2);
  });

  it("retains and reads the archive after the approved typed-v1 replacement removes the source row", async () => {
    await migrate();
    const fixture = await createV11DeviceFixture(db());
    const source = (await seedSources(1, fixture))[0]!;
    const prior = await currentTelemetryV1Chunk(db(), fixture.participantId, fixture.deviceId, "usage", day, 0);
    if (!prior) throw new Error("synthetic prior typed-v1 chunk missing");
    const record = JSON.parse(telemetryV11LegacyProjection("usage", v11UsageRecord(day, "b", {
      eventId: `event:v2:${"b".repeat(64)}`,
    }))!.canonicalRecord) as TelemetryV1UsageEvent;
    const envelopeDigest = await sha256Hex("synthetic-correction-replacement");
    const principal = await authenticateDevice(db(), fixture.authorization);
    const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 200);
    const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`, {
      envelopeDigest, bodyBytes: 200, contentType: "application/json",
    });
    const replacementChunk = parseTelemetryV1Chunk({
      schemaVersion: "telemetry-contribution-v1.0", chunkId: `usage:${day}:0`, chunkRevision: 2,
      chunkDigest: await sha256Hex(canonicalTelemetryV11Json([record])), parserVersion: "synthetic-correction-replacement-v1",
      consent: { telemetrySchemaVersion: "telemetry-contribution-v1.0",
        fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
        privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0" }, records: [record],
    });
    const replacement = {
      chunkRowId: `chunk:${crypto.randomUUID()}`, participantId: fixture.participantId, deviceId: fixture.deviceId,
      chunk: replacementChunk, envelopeDigest, r2Key: `synthetic/correction-replacement-${crypto.randomUUID()}`,
      deviceUploadAuthorizationId: claimed.authorizationId, createdAt: new Date().toISOString(), supersedes: prior,
    };
    const state = await db().prepare(`
      SELECT namespace_id,next_source_row_id FROM typed_v1_admission_state WHERE id=1 LIMIT 1
    `).first<{ namespace_id: number; next_source_row_id: number }>();
    if (!state) throw new Error("synthetic typed-v1 admission state missing");
    const typed = await prepareTypedTelemetryInsert(db(), [{
      sourceNamespace, format: "v1", sourceRowId: state.next_source_row_id,
      participantId: fixture.participantId, deviceId: fixture.deviceId,
      chunkRowId: replacement.chunkRowId, manifestId: null, chunkDay: day, observedDay: day, record,
    }]);
    const encodedChunkId = Uint8Array.from(encodeTypedTelemetryId(replacement.chunkRowId)).buffer;
    const typedStatements: D1PreparedStatement[] = [
      db().prepare(`
        INSERT INTO typed_v1_chunk_allocations(
          chunk_id,namespace_id,chunk_original,first_source_row_id,record_count
        ) VALUES(?,?,?,?,?)
      `).bind(replacement.chunkRowId, state.namespace_id, encodedChunkId, state.next_source_row_id, 1),
      ...typed.statements,
      db().prepare(`
        INSERT INTO typed_v1_owner_memberships(participant_id,typed_owner_id)
        SELECT ?,owner_id FROM typed_telemetry_records
         WHERE namespace_id=? AND format=10 AND source_row_id=?
        ON CONFLICT(participant_id) DO UPDATE SET typed_owner_id=excluded.typed_owner_id
      `).bind(fixture.participantId, state.namespace_id, state.next_source_row_id),
      db().prepare(`
        INSERT INTO typed_v1_record_admissions(typed_record_id,chunk_id)
        SELECT id,? FROM typed_telemetry_records
         WHERE namespace_id=? AND format=10 AND source_row_id>=? AND source_row_id<?
      `).bind(replacement.chunkRowId, state.namespace_id, state.next_source_row_id, state.next_source_row_id + 1),
      db().prepare(`
        INSERT INTO storage_v11_owner_links(participant_id,owner_digest,state)
        VALUES(?,lower(hex(randomblob(32))),'active') ON CONFLICT(participant_id) DO NOTHING
      `).bind(fixture.participantId),
      db().prepare(`
        INSERT INTO typed_v1_event_sources(
          event_digest,owner_digest,participant_id,chunk_id,source_namespace
        )
        SELECT lower(hex(randomblob(32))),owner_digest,participant_id,?,?
          FROM storage_v11_owner_links WHERE participant_id=?
      `).bind(replacement.chunkRowId, sourceNamespace, fixture.participantId),
    ];
    const replacementDeletes = [db().prepare(`
      DELETE FROM typed_telemetry_chunks WHERE namespace_id=? AND format=10
        AND original_id=(SELECT chunk_original FROM typed_v1_chunk_allocations WHERE chunk_id=?)
    `).bind(state.namespace_id, prior.id)];
    const preparedReplacement = prepareTelemetryV1ChunkWrite(db(), replacement, {
      insertStatements: typedStatements, deleteSupersededStatements: replacementDeletes,
      authorizationEnvelopeDigest: envelopeDigest,
    });
    preparedReplacement.statements.unshift(db().prepare(`
      INSERT INTO typed_v1_authority_requests(
        chunk_id,participant_id,device_id,authorization_id,authorization_digest,envelope_digest
      ) VALUES(?,?,?,?,?,?)
    `).bind(replacement.chunkRowId, replacement.participantId, replacement.deviceId,
      replacement.deviceUploadAuthorizationId, envelopeDigest, replacement.envelopeDigest));
    preparedReplacement.statements.push(db().prepare(
      "DELETE FROM typed_v1_authority_requests WHERE chunk_id=?",
    ).bind(replacement.chunkRowId));

    const assertion = await captureTelemetryUsageCorrectionBeforeDelete(db(), source, preparedReplacement.statements);
    const oldEventId = (JSON.parse(source.recordJson) as { eventId: string }).eventId;
    expect(await db().prepare("SELECT count(*) n FROM typed_telemetry_compatibility_records WHERE occurrence_id=?")
      .bind(oldEventId).first<number>("n")).toBe(0);
    expect(await db().prepare("SELECT count(*) n FROM typed_telemetry_dictionary").first<number>("n")).toBeGreaterThan(0);
    const current = await db().prepare(`
      SELECT revision,authority_epoch FROM storage_owner_revisions WHERE owner_digest=? LIMIT 2
    `).bind(source.ownerDigest).first<{ revision: number; authority_epoch: number }>();
    if (!current) throw new Error("synthetic replacement owner tuple missing");
    const read = {
      ownerDigest: source.ownerDigest,
      ownerRevision: current.revision,
      authorityEpoch: current.authority_epoch,
      limit: 1,
    };
    const history = await readTelemetryUsageCorrectionHistory(db(), read);
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]?.source.recordDigest).toBe(assertion.recordDigest);
    await db().prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
    const facts = await readTelemetryUsageCorrectionEffectiveFacts(db(), read);
    expect(facts.rows).toHaveLength(1);
    expect(facts.rows[0]?.source.recordDigest).toBe(assertion.recordDigest);
    expect(facts.rows[0]?.totalInputContextTokens).toBeNull();
  });

  it("keeps old history readable through a current owner revision and paginates by cursor", async () => {
    await migrate();
    const sources = await seedSources(2);
    await captureTelemetryUsageCorrectionBeforeDelete(db(), sources[0]!);
    await captureTelemetryUsageCorrectionBeforeDelete(db(), sources[1]!);
    const before = { ownerDigest: sources[0]!.ownerDigest, ownerRevision: sources[0]!.ownerRevision,
      authorityEpoch: sources[0]!.authorityEpoch };
    const firstPage = await readTelemetryUsageCorrectionHistory(db(), { ...before, limit: 1 });
    expect(firstPage.rows).toHaveLength(1);
    expect(firstPage.nextAfterId).not.toBeNull();
    const secondPage = await readTelemetryUsageCorrectionHistory(db(), {
      ...before, afterId: firstPage.nextAfterId!, limit: 1,
    });
    expect(secondPage.rows).toHaveLength(1);
    expect(secondPage.rows[0]?.id).not.toBe(firstPage.rows[0]?.id);
    expect(secondPage.nextAfterId).toBeNull();

    await db().prepare(`
      INSERT INTO storage_ingestion_changes(
        event_digest,owner_digest,revision,kind,object_digest,content_digest,
        authority_epoch,public_authority_epoch,recorded_ms
      )
      SELECT lower(hex(randomblob(32))),owner.owner_digest,owner.revision+1,'source-updated',latest.object_digest,
        latest.content_digest,owner.authority_epoch,
        (SELECT authority_epoch FROM storage_source_state WHERE singleton=1),
        CAST(strftime('%s','now') AS INTEGER)*1000
        FROM storage_owner_revisions owner
        JOIN storage_ingestion_changes latest
          ON latest.owner_digest=owner.owner_digest AND latest.revision=owner.revision
       WHERE owner.owner_digest=?
    `).bind(before.ownerDigest).run();
    await expect(readTelemetryUsageCorrectionHistory(db(), { ...before, limit: 1 })).rejects.toMatchObject({
      code: "TELEMETRY_USAGE_CORRECTION_CAS_MISMATCH",
    });
    const current = await db().prepare(`
      SELECT revision,authority_epoch FROM storage_owner_revisions WHERE owner_digest=? LIMIT 2
    `).bind(before.ownerDigest).first<{ revision: number; authority_epoch: number }>();
    if (!current) throw new Error("synthetic owner revision did not advance");
    const afterRehash = await readTelemetryUsageCorrectionHistory(db(), {
      ownerDigest: before.ownerDigest, ownerRevision: current.revision,
      authorityEpoch: current.authority_epoch, limit: 1,
    });
    expect(afterRehash.rows).toHaveLength(1);
    expect(afterRehash.rows[0]?.ownerRevision).toBe(before.ownerRevision);
  });

  it("rejects direct forged source rows and cascades only after owner erasure", async () => {
    await migrate();
    const source = await seed();
    await captureTelemetryUsageCorrectionBeforeDelete(db(), source);
    await expect(db().prepare(`DELETE FROM telemetry_usage_correction_history WHERE id=1`).run()).rejects.toThrow("telemetry_usage_correction_history_retained");
    await expect(db().prepare(`
      INSERT INTO telemetry_usage_correction_history (
        participant_id,owner_digest,owner_revision,authority_epoch,source_format,namespace_id,owner_id,
        device_id,chunk_id,manifest_id,source_storage_row_id,source_row_id,occurrence_id,event_time_ms,
        provider_id,session_id,model_id,speed_mode_id,api_service_tier_id,surface_id,billing_surface_id,
        reasoning_effort_id,agent_scope_id,outcome_id,attribution_id,total_input_context_tokens,
        input_uncached_tokens,input_cache_read_tokens,input_cache_write_tokens,output_text_tokens,
        output_reasoning_tokens,output_combined_tokens,source_chunk_digest,source_event_digest,
        record_digest,base_digest,captured_at_ms
      ) SELECT participant_id,owner_digest,owner_revision,authority_epoch,source_format,namespace_id,owner_id,
        device_id,chunk_id,manifest_id,source_storage_row_id,source_row_id,occurrence_id,event_time_ms,
        provider_id,session_id,model_id,speed_mode_id,api_service_tier_id,surface_id,billing_surface_id,
        reasoning_effort_id,agent_scope_id,outcome_id,attribution_id,total_input_context_tokens,
        input_uncached_tokens,input_cache_read_tokens,input_cache_write_tokens,output_text_tokens,
        output_reasoning_tokens,output_combined_tokens,source_chunk_digest,source_event_digest,
        zeroblob(32),base_digest,captured_at_ms
      FROM telemetry_usage_correction_history WHERE id=1
    `).run()).rejects.toThrow("telemetry_usage_correction_source_proof");
    await db().prepare("DELETE FROM participants WHERE id=?").bind(source.participantId).run();
    expect(await db().prepare("SELECT count(*) n FROM telemetry_usage_correction_history").first<number>("n")).toBe(0);
    expect(await db().prepare("SELECT count(*) n FROM telemetry_usage_correction_facts").first<number>("n")).toBe(0);
  });
});
