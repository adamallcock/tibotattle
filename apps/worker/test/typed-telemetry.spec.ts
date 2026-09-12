import { env, applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalTelemetryV11Json, type TelemetryV11Attribution } from "@app-usagemonitor/telemetry-contract";
import {
  decodeTypedTelemetryId, encodeTypedTelemetryId, encodeTypedTelemetryRecord, typedTelemetryCanonicalRecords,
  typedTelemetryDayNumber, typedTelemetryDayString, type TypedTelemetryFormat,
} from "../src/typed-telemetry-codec";
import {
  MAX_TYPED_TELEMETRY_BATCH_RECORDS, MAX_TYPED_TELEMETRY_BATCH_STATEMENTS,
  persistTypedTelemetryBatch, prepareTypedTelemetryInsert, readTypedTelemetryPage, type TypedTelemetrySourceRecord,
} from "../src/typed-telemetry-repository";
import { telemetryV11LegacyProjection } from "../src/telemetry-v11-repository";
import type { TelemetryV11Record } from "@app-usagemonitor/telemetry-contract";

interface TestBindings { STORAGE_INGESTION_A: D1Database; TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[] }
const bindings = () => env as unknown as TestBindings;
const db = () => bindings().STORAGE_INGESTION_A;
const day = "2026-08-24";
const time = `${day}T12:34:56.789Z`;
const namespace = "original-database:synthetic";
const uuid = "12345678-1234-5678-9abc-1234567890ab";
const attribution: TelemetryV11Attribution = { accountBasis: "same_source", accountTrackId: `account-track:v2:${"a".repeat(64)}`,
  planBasis: "same_source_occurrence", planType: "pro", planEraId: `plan-era:v1:${"b".repeat(64)}` };

function usage(format: TypedTelemetryFormat, eventId = `event:v2:${"c".repeat(64)}`) {
  return { schemaVersion: `usage-event-${format === "v1" ? "v1.0" : "v1.1"}`, eventId, eventTime: time,
    sessionUuid: uuid, provider: "codex", modelId: "future-model-22", speedMode: "unavailable",
    apiServiceTier: "priority", surface: "desktop", billingSurface: "unknown", reasoningEffort: "max",
    agentScope: "subagent", outcome: "unknown", totalInputContextTokens: 1_000_000_000_000,
    components: { inputUncachedTokens: 0, inputCacheReadTokens: null, inputCacheWriteTokens: 18,
      outputTextTokens: 1_000_000_000_000, outputReasoningTokens: 2, outputCombinedTokens: null },
    ...(format === "v11" ? { accountPlanAttribution: attribution } : {}) };
}
function quota(format: TypedTelemetryFormat, observationId = `quota-occurrence:v1:${"d".repeat(64)}`) {
  return { schemaVersion: `quota-observation-${format === "v1" ? "v1.0" : "v1.1"}`, observationId, observedTime: time,
    provider: "codex", planType: "pro", planVariant: "unknown", limitId: "codex_spark", slot: "secondary",
    usedPercent: 0, windowDurationMinutes: 527040, resetsAt: "2027-08-25T00:00:00.001Z",
    ...(format === "v11" ? { accountPlanAttribution: attribution } : {}) };
}
function session(format: TypedTelemetryFormat, sessionUuid = uuid) {
  return { schemaVersion: `session-dimension-${format === "v1" ? "v1.0" : "v1.1"}`, sessionUuid, firstEventTime: time,
    provider: "codex", toolClassCounts: Object.fromEntries(Array.from({ length: 32 }, (_, index) =>
      [`tool${index}`, index === 0 ? 0 : index === 31 ? 1_000_000_000 : index])) };
}
function source(format: TypedTelemetryFormat, sourceRowId: number, record: unknown,
  overrides: Partial<TypedTelemetrySourceRecord> = {}): TypedTelemetrySourceRecord {
  const stream = encodeTypedTelemetryRecord(format, record).stream;
  return { sourceNamespace: namespace, format, sourceRowId, participantId: `participant:${uuid}`,
    deviceId: `device:${uuid}`, chunkRowId: `chunk:${format}:${stream}`, manifestId: format === "v11" ? "manifest:synthetic" : null,
    chunkDay: day, observedDay: day, record, ...overrides };
}
async function count(table: string): Promise<number> {
  return (await db().prepare(`SELECT count(*) AS count FROM ${table}`).first<{ count: number }>())!.count;
}
async function assertRoundtrip(rows: TypedTelemetrySourceRecord[]) {
  await persistTypedTelemetryBatch(db(), rows);
  for (const format of ["v1", "v11"] as const) {
    const expected = rows.filter((row) => row.format === format).sort((a, b) => a.sourceRowId - b.sourceRowId);
    const result = await readTypedTelemetryPage(db(), { sourceNamespace: namespace, format, limit: 200 });
    expect(result.nextAfterSourceRowId).toBeNull();
    expect(result.records).toHaveLength(expected.length);
    for (let index = 0; index < expected.length; index += 1) {
      const row = expected[index]!;
      const actual = result.records[index]!;
      const { canonicalRecord, legacy, ...stored } = actual;
      expect(stored).toEqual(row);
      expect(canonicalRecord).toBe(canonicalTelemetryV11Json(row.record));
      if (format === "v11") {
        const stream = encodeTypedTelemetryRecord(format, row.record).stream;
        expect(legacy).toEqual(telemetryV11LegacyProjection(stream, row.record as TelemetryV11Record));
      } else expect(legacy?.canonicalRecord).toBe(canonicalRecord);
    }
  }
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), bindings().TEST_TYPED_INGESTION_MIGRATIONS);
});

describe("lossless typed telemetry codec", () => {
  it("reverses every compact ID form and unfamiliar/case-sensitive forms without collisions", () => {
    const ids = [uuid, `participant:${uuid}`, `device:${uuid}`, `v1:${uuid}`, `contribution:${uuid}`, `chunk:${uuid}`,
      "a".repeat(64), `event:v2:${"a".repeat(64)}`, `quota-occurrence:v1:${"a".repeat(64)}`,
      `account-track:v2:${"a".repeat(64)}`, `plan-era:v1:${"a".repeat(64)}`, uuid.toUpperCase(), "future:ID_001.2", "x".repeat(256)];
    const encoded = ids.map(encodeTypedTelemetryId);
    expect(encoded.map(decodeTypedTelemetryId)).toEqual(ids);
    expect(new Set(encoded.map((bytes) => Array.from(bytes).join(","))).size).toBe(ids.length);
    expect(encodeTypedTelemetryId(`chunk:${uuid}`).length).toBe(17);
    expect(() => decodeTypedTelemetryId(new Uint8Array([255, 1]))).toThrow("TYPED_TELEMETRY_INVALID");
    expect(() => decodeTypedTelemetryId(new Uint8Array([0, ...new TextEncoder().encode(uuid)]))).toThrow("TYPED_TELEMETRY_INVALID");
    expect(() => encodeTypedTelemetryId("raw private path /x")).toThrow("TYPED_TELEMETRY_INVALID");
  });
  it("preserves millisecond dates, pre-epoch days and all six record shapes", () => {
    for (const original of ["0000-01-01", "1960-02-29", day, "9999-12-31"]) {
      expect(typedTelemetryDayString(typedTelemetryDayNumber(original))).toBe(original);
    }
    expect(() => typedTelemetryDayNumber("2026-02-29")).toThrow("TYPED_TELEMETRY_INVALID");
    for (const format of ["v1", "v11"] as const) for (const record of [usage(format), quota(format), session(format)]) {
      const decoded = typedTelemetryCanonicalRecords(encodeTypedTelemetryRecord(format, record));
      expect(decoded.record).toEqual(record);
      expect(decoded.canonicalRecord).toBe(canonicalTelemetryV11Json(record));
    }
  });
  it("uses maintained closed validators rather than accepting malformed or future schemas", () => {
    for (const record of [{ ...usage("v11"), prompt: "synthetic content" }, { ...usage("v11"), schemaVersion: "usage-event-v2.0" },
      { ...quota("v11"), usedPercent: NaN }, { ...quota("v1"), usedPercent: null },
      { ...usage("v1"), components: { ...usage("v1").components, inputUncachedTokens: 0.5 } }]) {
      expect(() => encodeTypedTelemetryRecord(record.schemaVersion.endsWith("1.0") ? "v1" : "v11", record))
        .toThrow("TYPED_TELEMETRY_INVALID");
    }
    expect(() => encodeTypedTelemetryRecord("v1", usage("v11"))).toThrow("TYPED_TELEMETRY_INVALID");
  });
});

describe("typed target D1", () => {
  it("reconstructs all fields, NULL/zero/unknown and exact legacy counterparts from persisted typed rows", async () => {
    const unavailable = { accountBasis: "unavailable", accountTrackId: null, planBasis: "conflicted", planType: "unknown", planEraId: null };
    const rows = [source("v1", 1, usage("v1")), source("v1", 2, quota("v1")), source("v1", 3, session("v1")),
      source("v11", 1, usage("v11")), source("v11", 2, quota("v11")), source("v11", 3, session("v11")),
      source("v11", 4, { ...quota("v11", "observation:nulls"), planType: "unknown", usedPercent: null,
        windowDurationMinutes: null, resetsAt: null, accountPlanAttribution: unavailable }),
      source("v11", 5, { ...quota("v11", "observation:long-counterpart"), limitId: "l".repeat(64), slot: "s".repeat(64), usedPercent: 12.345 }),
      source("v11", 6, { ...usage("v11", "event:unknown-session"), sessionUuid: "FUTURE_SESSION:001", totalInputContextTokens: null,
        accountPlanAttribution: { ...attribution, accountBasis: "unavailable", accountTrackId: null, planEraId: null } }),
      // Stored membership/observed days are not silently replaced by UTC time.
      source("v11", 7, usage("v11", "event:separate-day"), { observedDay: "2026-08-23" }),
    ];
    await assertRoundtrip(rows);
    const result = await readTypedTelemetryPage(db(), { sourceNamespace: namespace, format: "v11" });
    expect(result.records.find((r) => r.sourceRowId === 4)?.legacy).toBeNull();
    expect(result.records.find((r) => r.sourceRowId === 5)?.legacy).toBeNull();
    const columns = await db().prepare("SELECT name FROM pragma_table_info('typed_telemetry_records')").all<{ name: string }>();
    expect(columns.results.some((column) => column.name.includes("json"))).toBe(false);
  });
  it("retains same row numbers in separate original namespaces and formats, including destination-local rowid collisions", async () => {
    const row = source("v11", 1, usage("v11"));
    await persistTypedTelemetryBatch(db(), [source("v1", 1, usage("v1")), row, { ...row, sourceNamespace: "original-database:second" }]);
    expect(await count("typed_telemetry_records")).toBe(3);
    for (const sourceNamespace of [namespace, "original-database:second"]) {
      const page = await readTypedTelemetryPage(db(), { sourceNamespace, format: "v11" });
      expect(page.records[0]?.sourceRowId).toBe(1);
      expect(page.records[0]?.sourceNamespace).toBe(sourceNamespace);
      expect(page.records[0]?.record).toEqual(row.record);
    }
  });
  it("keeps each nullable quota component independent and repeated flat readings distinct", async () => {
    const rows = Array.from({ length: 8 }, (_, mask) => source("v11", mask + 1, {
      ...quota("v11", `observation:mask-${mask}`),
      observedTime: `${day}T12:34:${String(mask).padStart(2, "0")}.001Z`,
      usedPercent: mask & 1 ? null : 100,
      windowDurationMinutes: mask & 2 ? null : 300,
      resetsAt: mask & 4 ? null : "2026-08-25T01:02:03.004Z",
    }));
    await assertRoundtrip(rows);
    const page = await readTypedTelemetryPage(db(), { sourceNamespace: namespace, format: "v11" });
    expect(page.records.filter((row) => row.legacy !== null)).toHaveLength(1);
    expect(await count("typed_telemetry_records")).toBe(8);
    expect(await count("typed_telemetry_quota_dimensions")).toBe(1);
  });
  it("is idempotent only for the same original membership and canonical bytes; conflicting batch rolls back", async () => {
    const row = source("v11", 42, usage("v11"));
    const first = await persistTypedTelemetryBatch(db(), [row]);
    expect(await persistTypedTelemetryBatch(db(), [row])).toEqual(first);
    expect(await count("typed_telemetry_records")).toBe(1);
    await expect(persistTypedTelemetryBatch(db(), [source("v11", 43, usage("v11", "event:next-unique")),
      { ...row, record: { ...usage("v11"), outcome: "different" } }])).rejects.toMatchObject({ code: "TYPED_TELEMETRY_CONFLICT" });
    expect(await count("typed_telemetry_records")).toBe(1);
    await expect(persistTypedTelemetryBatch(db(), [{ ...row, observedDay: "2026-08-23" }]))
      .rejects.toMatchObject({ code: "TYPED_TELEMETRY_CONFLICT" });
    expect((await readTypedTelemetryPage(db(), { sourceNamespace: namespace, format: "v11" })).records[0]?.record).toEqual(row.record);
  });
  it("enforces source duplicate scopes without collapsing independent manifests, devices or owners", async () => {
    const v1 = source("v1", 1, usage("v1"));
    const v11 = source("v11", 1, usage("v11"));
    await persistTypedTelemetryBatch(db(), [v1, v11]);
    await expect(persistTypedTelemetryBatch(db(), [{ ...v1, sourceRowId: 2, chunkRowId: "chunk:v1:different" }]))
      .rejects.toMatchObject({ code: "TYPED_TELEMETRY_CONFLICT" });
    await expect(persistTypedTelemetryBatch(db(), [{ ...v11, sourceRowId: 2, chunkRowId: "chunk:v11:different" }]))
      .rejects.toMatchObject({ code: "TYPED_TELEMETRY_CONFLICT" });
    await persistTypedTelemetryBatch(db(), [{ ...v11, sourceRowId: 2, manifestId: "manifest:next-version", chunkRowId: "chunk:v11:next" },
      { ...v1, sourceRowId: 2, deviceId: "device:second", chunkRowId: "chunk:v1:second" }]);
    expect(await count("typed_telemetry_records")).toBe(4);
  });
  it("rejects device, manifest and chunk owner mismatches with no partial new owner or record", async () => {
    const row = source("v11", 1, usage("v11"));
    await persistTypedTelemetryBatch(db(), [row]);
    for (const overrides of [
      { participantId: "participant:other" },
      { participantId: "participant:other", deviceId: "device:other" },
      { participantId: "participant:other", deviceId: "device:other", manifestId: "manifest:other" },
    ]) {
      await expect(persistTypedTelemetryBatch(db(), [{ ...row, sourceRowId: 2, ...overrides, record: usage("v11", "event:new-owner") }]))
        .rejects.toMatchObject({ code: "TYPED_TELEMETRY_CONFLICT" });
      expect(await count("typed_telemetry_records")).toBe(1);
      expect(await count("typed_telemetry_owners")).toBe(1);
    }
  });
  it("scopes private session/attribution/dimension mappings to each owner and removes them with that owner", async () => {
    const a = [source("v11", 1, usage("v11")), source("v11", 2, quota("v11"))];
    const b = a.map((row) => ({ ...row, sourceRowId: row.sourceRowId + 10, participantId: "participant:other", deviceId: "device:other",
      manifestId: "manifest:other", chunkRowId: `${row.chunkRowId}:other` }));
    await persistTypedTelemetryBatch(db(), [...a, ...b]);
    for (const table of ["typed_telemetry_identifiers", "typed_telemetry_attributions", "typed_telemetry_quota_dimensions"]) expect(await count(table)).toBe(2);
    await db().prepare("DELETE FROM typed_telemetry_owners WHERE original_id = ?").bind(encodeTypedTelemetryId(a[0]!.participantId).buffer).run();
    for (const table of ["typed_telemetry_identifiers", "typed_telemetry_attributions", "typed_telemetry_quota_dimensions"]) expect(await count(table)).toBe(1);
    expect(await count("typed_telemetry_records")).toBe(2);
    expect((await readTypedTelemetryPage(db(), { sourceNamespace: namespace, format: "v11" })).records.map((row) => row.participantId))
      .toEqual(["participant:other", "participant:other"]);
  });
  it("enforces subtype ownership in SQL, including equal-looking session IDs and attribution values", async () => {
    const a = source("v11", 1, usage("v11"));
    const b = { ...a, sourceRowId: 2, participantId: "participant:other", deviceId: "device:other",
      manifestId: "manifest:other", chunkRowId: "chunk:other" };
    await persistTypedTelemetryBatch(db(), [a, b]);
    const stored = (await db().prepare("SELECT id, source_row_id FROM typed_telemetry_records ORDER BY source_row_id")
      .all<{ id: number; source_row_id: number }>()).results;
    const first = stored[0]!.id;
    const second = stored[1]!.id;
    const columns = (await db().prepare("SELECT name FROM pragma_table_info('typed_telemetry_usage')")
      .all<{ name: string }>()).results.map((column) => column.name);
    await db().prepare("DELETE FROM typed_telemetry_usage WHERE record_id = ?").bind(first).run();
    await expect(db().prepare(`INSERT INTO typed_telemetry_usage (${columns.join(",")})
      SELECT ${columns.map((column) => column === "record_id" ? "?" : column).join(",")}
      FROM typed_telemetry_usage WHERE record_id = ?`).bind(first, second).run())
      .rejects.toThrow("typed_telemetry_membership_conflict");
    // Exact replay repairs only the absent child using the correct owner's maps.
    await persistTypedTelemetryBatch(db(), [a]);
    expect((await readTypedTelemetryPage(db(), { sourceNamespace: namespace, format: "v11" })).records).toHaveLength(2);
  });
  it("keysets a full-size batch by original row IDs, leaves room for a journal, and snapshots caller values", async () => {
    const rows = Array.from({ length: MAX_TYPED_TELEMETRY_BATCH_RECORDS }, (_, index) => source("v11", index * 3 + 1,
      usage("v11", `event:v2:${index.toString(16).padStart(64, "0")}`)));
    const preparing = prepareTypedTelemetryInsert(db(), rows);
    (rows[0]!.record as ReturnType<typeof usage>).outcome = "changed-after-prepare";
    const prepared = await preparing;
    expect(prepared.statements.length).toBeLessThan(MAX_TYPED_TELEMETRY_BATCH_STATEMENTS);
    expect(await count("typed_telemetry_records")).toBe(0);
    await db().batch(prepared.statements);
    let afterSourceRowId = 0;
    const seen: number[] = [];
    do {
      const result = await readTypedTelemetryPage(db(), { sourceNamespace: namespace, format: "v11", afterSourceRowId, limit: 73 });
      seen.push(...result.records.map((row) => row.sourceRowId));
      if (afterSourceRowId === 0) expect((result.records[0]!.record as ReturnType<typeof usage>).outcome).toBe("unknown");
      if (result.nextAfterSourceRowId === null) break;
      afterSourceRowId = result.nextAfterSourceRowId;
    } while (true);
    expect(seen).toEqual(rows.map((row) => row.sourceRowId));
  });
  it("fits maximum session tool counts in bounded statements without JSON expansion", async () => {
    const rows = Array.from({ length: 200 }, (_, index) => source("v11", index + 1,
      session("v11", `session:synthetic-${index.toString().padStart(4, "0")}`)));
    const prepared = await prepareTypedTelemetryInsert(db(), rows);
    expect(prepared.statements.length).toBeLessThan(MAX_TYPED_TELEMETRY_BATCH_STATEMENTS);
    await db().batch(prepared.statements);
    expect(await count("typed_telemetry_session_tools")).toBe(6400);
    const page = await readTypedTelemetryPage(db(), { sourceNamespace: namespace, format: "v11", limit: 200 });
    expect(page.records.map((row) => row.record)).toEqual(rows.map((row) => row.record));
  });
  it("detects valid-shaped changed persisted fields through canonical readback verification", async () => {
    await persistTypedTelemetryBatch(db(), [source("v11", 1, usage("v11"))]);
    // Simulate storage corruption outside the maintained mutation boundary.
    await db().prepare("DROP TRIGGER typed_telemetry_usage_immutable").run();
    await db().prepare("UPDATE typed_telemetry_usage SET output_text_tokens = 123").run();
    await expect(readTypedTelemetryPage(db(), { sourceNamespace: namespace, format: "v11" }))
      .rejects.toMatchObject({ code: "TYPED_TELEMETRY_CONFLICT" });
  });
  it("refuses a newer storage layout before exposing records or committing a batch", async () => {
    await persistTypedTelemetryBatch(db(), [source("v11", 1, usage("v11"))]);
    // A synthetic future migration retains table shapes while advancing its
    // version. Older code must not treat those shapes as permission to proceed.
    await db().batch([
      db().prepare("DROP TABLE typed_telemetry_schema"),
      db().prepare("CREATE TABLE typed_telemetry_schema (id INTEGER PRIMARY KEY, version INTEGER NOT NULL) STRICT"),
      db().prepare("INSERT INTO typed_telemetry_schema (id, version) VALUES (1, 2)"),
    ]);
    await expect(readTypedTelemetryPage(db(), { sourceNamespace: namespace, format: "v11" }))
      .rejects.toMatchObject({ code: "TYPED_TELEMETRY_UNAVAILABLE" });
    await expect(persistTypedTelemetryBatch(db(), [source("v11", 2, { ...usage("v11", "event:future-layout"), modelId: "must-not-persist" })]))
      .rejects.toMatchObject({ code: "TYPED_TELEMETRY_UNAVAILABLE" });
    expect(await count("typed_telemetry_records")).toBe(1);
    expect(await db().prepare("SELECT id FROM typed_telemetry_dictionary WHERE value = 'must-not-persist'").first()).toBeNull();
  });
  it("refuses missing schema, over-limit inputs and corruption instead of returning incomplete evidence", async () => {
    const row = source("v11", 1, usage("v11"));
    await expect(prepareTypedTelemetryInsert(db(), [row, row])).rejects.toMatchObject({ code: "TYPED_TELEMETRY_CONFLICT" });
    await expect(prepareTypedTelemetryInsert(db(), Array.from({ length: 201 }, () => row)))
      .rejects.toMatchObject({ code: "TYPED_TELEMETRY_LIMIT" });
    await expect(readTypedTelemetryPage(db(), { sourceNamespace: namespace, format: "v11", limit: 201 }))
      .rejects.toMatchObject({ code: "TYPED_TELEMETRY_LIMIT" });
    await persistTypedTelemetryBatch(db(), [row]);
    await expect(db().prepare("UPDATE typed_telemetry_usage SET output_text_tokens = 1").run()).rejects.toThrow();
    await db().prepare("DELETE FROM typed_telemetry_usage").run();
    await expect(readTypedTelemetryPage(db(), { sourceNamespace: namespace, format: "v11" }))
      .rejects.toMatchObject({ code: "TYPED_TELEMETRY_INVALID" });
    await reset();
    await expect(persistTypedTelemetryBatch(db(), [row])).rejects.toMatchObject({ code: "TYPED_TELEMETRY_UNAVAILABLE" });
  });
});
