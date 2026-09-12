import { env, applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalTelemetryV11Json, type TelemetryV11Attribution, type TelemetryV11Record } from "@app-usagemonitor/telemetry-contract";
import { encodeTypedTelemetryId, encodeTypedTelemetryRecord, type TypedTelemetryFormat } from "../src/typed-telemetry-codec";
import { persistTypedTelemetryBatch, type TypedTelemetrySourceRecord } from "../src/typed-telemetry-repository";
import { telemetryV11LegacyProjection } from "../src/telemetry-v11-repository";
import {
  readTypedTelemetryCompatibilityPage, TYPED_TELEMETRY_COMPATIBILITY_COLUMNS, TYPED_TELEMETRY_COMPATIBILITY_PAGE_SQL,
  type TypedTelemetryCompatibilityOptions, type TypedTelemetryCompatibilityRecord,
} from "../src/typed-telemetry-compatibility";

interface TestBindings { STORAGE_INGESTION_A: D1Database; TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[] }
const bindings = () => env as unknown as TestBindings;
const db = () => bindings().STORAGE_INGESTION_A;
const migrations = () => bindings().TEST_TYPED_INGESTION_MIGRATIONS.filter((migration) => migration.name <= "0004_read_compatibility.sql");
const uuid = "12345678-1234-5678-9abc-1234567890ab";
const namespace = "original-database:compatibility";
const participantId = `participant:${uuid}`;
const day = "2026-08-24", time = `${day}T12:34:56.789Z`;
const attribution: TelemetryV11Attribution = { accountBasis: "same_source", accountTrackId: `account-track:v2:${"a".repeat(64)}`,
  planBasis: "same_source_occurrence", planType: "pro", planEraId: `plan-era:v1:${"b".repeat(64)}` };
const version = (format: TypedTelemetryFormat) => format === "v1" ? "v1.0" : "v1.1";
function usage(format: TypedTelemetryFormat, eventId = `event:v2:${"c".repeat(64)}`) {
  return { schemaVersion: `usage-event-${version(format)}`, eventId, eventTime: time, sessionUuid: uuid,
    provider: "codex", modelId: "future-model-22", speedMode: "unavailable", apiServiceTier: "priority", surface: "desktop",
    billingSurface: "unknown", reasoningEffort: "max", agentScope: "subagent", outcome: "unknown",
    totalInputContextTokens: 1_000_000_000_000, components: { inputUncachedTokens: 0, inputCacheReadTokens: null,
      inputCacheWriteTokens: 18, outputTextTokens: 1_000_000_000_000, outputReasoningTokens: 2, outputCombinedTokens: null },
    ...(format === "v11" ? { accountPlanAttribution: attribution } : {}) };
}
function quota(format: TypedTelemetryFormat, observationId = `quota-occurrence:v1:${"d".repeat(64)}`) {
  return { schemaVersion: `quota-observation-${version(format)}`, observationId, observedTime: time, provider: "codex",
    planType: "pro", planVariant: "unknown", limitId: "codex_spark", slot: "secondary", usedPercent: 0,
    windowDurationMinutes: 527040, resetsAt: "2027-08-25T00:00:00.001Z",
    ...(format === "v11" ? { accountPlanAttribution: attribution } : {}) };
}
function session(format: TypedTelemetryFormat) {
  return { schemaVersion: `session-dimension-${version(format)}`, sessionUuid: uuid, firstEventTime: time, provider: "codex",
    toolClassCounts: { zebra: 0, Alpha: 1_000_000_000, beta: 21 } };
}
function source(format: TypedTelemetryFormat, sourceRowId: number, record: unknown,
  overrides: Partial<TypedTelemetrySourceRecord> = {}): TypedTelemetrySourceRecord {
  const stream = encodeTypedTelemetryRecord(format, record).stream;
  return { sourceNamespace: namespace, format, sourceRowId, participantId, deviceId: `device:${uuid}`,
    chunkRowId: `chunk:${format}:${stream}`, manifestId: format === "v11" ? "manifest:synthetic" : null,
    chunkDay: day, observedDay: day, record, ...overrides };
}
const options = (stream: TypedTelemetryCompatibilityOptions["stream"], overrides: Partial<TypedTelemetryCompatibilityOptions> = {}): TypedTelemetryCompatibilityOptions =>
  ({ sourceNamespace: namespace, participantId, stream, ...overrides });
function expectExact(actual: TypedTelemetryCompatibilityRecord, expected: TypedTelemetrySourceRecord) {
  const stream = encodeTypedTelemetryRecord(expected.format, expected.record).stream;
  expect(actual.source_namespace).toBe(expected.sourceNamespace);
  expect(actual.format).toBe(expected.format); expect(actual.source_row_id).toBe(expected.sourceRowId); expect(actual.id).toBe(expected.sourceRowId);
  expect(actual.participant_id).toBe(expected.participantId); expect(actual.device_id).toBe(expected.deviceId);
  expect(actual.chunk_row_id).toBe(expected.chunkRowId); expect(actual.manifest_id).toBe(expected.manifestId);
  expect(actual.chunk_day).toBe(expected.chunkDay); expect(actual.observed_day).toBe(expected.observedDay);
  expect(actual.record).toEqual(expected.record);
  expect(actual.record_json).toBe(canonicalTelemetryV11Json(expected.record));
  const legacy = expected.format === "v11" ? telemetryV11LegacyProjection(stream, expected.record as TelemetryV11Record)
    : { occurrenceId: actual.occurrence_id, canonicalRecord: actual.record_json };
  expect(actual.legacy_record_json).toBe(legacy?.canonicalRecord ?? null);
  expect(actual.legacy_occurrence_id).toBe(legacy?.occurrenceId ?? null);
  expect(Object.keys(actual).some((key) => key.startsWith("_") || key === "storage_row_id")).toBe(false);
}

beforeEach(async () => { await reset(); await applyD1Migrations(db(), migrations()); });

describe("typed raw SQL compatibility and exact bounded JSON reader", () => {
  it("refuses a pre-view database and exposes the reviewed SQL column contract after migration", async () => {
    await db().exec("DROP VIEW typed_telemetry_compatibility_records");
    await expect(readTypedTelemetryCompatibilityPage(db(), options("usage"))).rejects.toMatchObject({ code: "TYPED_TELEMETRY_UNAVAILABLE" });
    await reset(); await applyD1Migrations(db(), migrations());
    const columns = await db().prepare("PRAGMA table_info(typed_telemetry_compatibility_records)").all<{ name: string }>();
    expect(columns.results.map((row) => row.name)).toEqual(TYPED_TELEMETRY_COMPATIBILITY_COLUMNS);
  });

  it("preserves all six admitted record shapes, complete flat fields and canonical/legacy bytes", async () => {
    const rows = (["v1", "v11"] as const).flatMap((format) => [source(format, 17, usage(format)), source(format, 41, quota(format)), source(format, 90, session(format))]);
    await persistTypedTelemetryBatch(db(), rows);
    for (const stream of ["usage", "quota", "session"] as const) {
      const result = await readTypedTelemetryCompatibilityPage(db(), options(stream));
      expect(result.next).toBeNull(); expect(result.records).toHaveLength(2);
      result.records.forEach((actual) => expectExact(actual, rows.find((row) => row.format === actual.format && row.sourceRowId === actual.source_row_id)!));
      const first = result.records[0]!, second = result.records[1]!;
      expect(first.account_basis).toBeNull();
      if (stream !== "session") expect(second.account_basis).toBe("same_source");
      if (stream === "usage") {
        expect(first).toMatchObject({ speed_mode: "unavailable", api_service_tier: "priority", billing_surface: "unknown",
          reasoning_effort: "max", agent_scope: "subagent", total_input_context_tokens: 1_000_000_000_000,
          input_uncached_tokens: 0, input_cache_read_tokens: null, output_combined_tokens: null });
        expect(JSON.parse(first.record_json)).not.toHaveProperty("accountPlanAttribution");
        expect(JSON.parse(second.record_json)).toHaveProperty("accountPlanAttribution", attribution);
      } else if (stream === "session") {
        expect(first.tool_class_counts).toEqual(session("v1").toolClassCounts);
        expect(first.session_uuid).toBe(uuid); expect(second.account_basis).toBeNull();
        const tools = await db().prepare("SELECT tool_class, count FROM typed_telemetry_compatibility_session_tools WHERE format_code=11 ORDER BY tool_class COLLATE BINARY").all();
        expect(tools.results).toEqual([{ tool_class: "Alpha", count: 1_000_000_000 }, { tool_class: "beta", count: 21 }, { tool_class: "zebra", count: 0 }]);
      }
    }
    const objects = (await db().prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' AND name LIKE 'typed_telemetry_%'").all<{ name: string; sql: string }>()).results;
    expect(objects.some((row) => /\brecord_json\b|\blegacy_record_json\b/.test(row.sql))).toBe(false);
  });

  it("keeps exact binary64 quota values and ECMAScript canonical number spelling", async () => {
    const values = [0, 1, 12.345678901234567, 99.99999999999999, 1e-7, 1e-20, Number.MIN_VALUE, 100];
    const rows = (["v1", "v11"] as const).flatMap((format) => values.map((value, index) =>
      source(format, index + 1, { ...quota(format, `quota:test:${index}`), usedPercent: value })));
    await persistTypedTelemetryBatch(db(), rows);
    const result = await readTypedTelemetryCompatibilityPage(db(), options("quota"));
    expect(result.records).toHaveLength(rows.length);
    result.records.forEach((actual) => {
      const expected = rows.find((row) => row.format === actual.format && row.sourceRowId === actual.source_row_id)!;
      expectExact(actual, expected); expect(actual.used_percent).toBe(Reflect.get(expected.record as object, "usedPercent"));
    });
  });

  it("preserves every nullable quota combination, zero and legacy projection unavailability", async () => {
    const rows = Array.from({ length: 8 }, (_, mask) => source("v11", mask + 1, {
      ...quota("v11", `quota:nullable:${mask}`), usedPercent: mask & 1 ? null : 0,
      windowDurationMinutes: mask & 2 ? null : 5, resetsAt: mask & 4 ? null : time,
      accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null,
        planBasis: "same_source_occurrence", planType: "pro", planEraId: null },
    }));
    rows.push(source("v11", 99, { ...quota("v11", "quota:long:key"), limitId: "l".repeat(64), slot: "s".repeat(64) }));
    await persistTypedTelemetryBatch(db(), rows);
    const result = await readTypedTelemetryCompatibilityPage(db(), options("quota"));
    for (let i = 0; i < rows.length; i++) expectExact(result.records[i]!, rows[i]!);
    expect(result.records[0]!.legacy_record_json).not.toBeNull();
    expect(result.records.slice(1).every((row) => row.legacy_record_json === null)).toBe(true);
  });

  it("reverses every current compact identifier tag and raw fallback without changing membership", async () => {
    const ids = [uuid, `participant:${uuid}`, `device:${uuid}`, `v1:${uuid}`, `contribution:${uuid}`, `chunk:${uuid}`,
      "a".repeat(64), `event:v2:${"a".repeat(64)}`, `quota-occurrence:v1:${"a".repeat(64)}`,
      `account-track:v2:${"a".repeat(64)}`, `plan-era:v1:${"a".repeat(64)}`, uuid.toUpperCase(), "future:ID_001.2", "x".repeat(256)];
    for (const [index, identifier] of ids.entries()) {
      // Metadata uses the wider storage-ID contract. Keep wire occurrence and
      // session IDs inside their separate maintained privacy contract.
      const row = source("v11", index + 1, usage("v11"), { sourceNamespace: identifier, participantId: identifier,
        deviceId: identifier, chunkRowId: identifier, manifestId: identifier });
      await persistTypedTelemetryBatch(db(), [row]);
      const result = await readTypedTelemetryCompatibilityPage(db(), options("usage", { sourceNamespace: identifier, participantId: identifier }));
      expect(result.records).toHaveLength(1); expectExact(result.records[0]!, row);
    }
  });

  it("preserves every attribution basis independently of nullable account and plan evidence", async () => {
    const rows: TypedTelemetrySourceRecord[] = [];
    for (const accountBasis of ["unavailable", "same_source", "provisional_marker"] as const) {
      for (const planBasis of ["unavailable", "same_source_occurrence", "provisional_marker", "conflicted"] as const) {
        const planType = planBasis === "unavailable" || planBasis === "conflicted" ? "unknown" : "pro";
        rows.push(source("v11", rows.length + 1, { ...quota("v11", `quota:attribution:${rows.length}`), planType,
          accountPlanAttribution: { accountBasis, accountTrackId: accountBasis === "unavailable" ? null : attribution.accountTrackId,
            planBasis, planType, planEraId: planType === "unknown" ? null : attribution.planEraId } }));
      }
    }
    await persistTypedTelemetryBatch(db(), rows);
    const result = await readTypedTelemetryCompatibilityPage(db(), options("quota"));
    expect(result.records).toHaveLength(rows.length);
    result.records.forEach((actual, index) => expectExact(actual, rows[index]!));
  });

  it("uses integer date arithmetic for millisecond, pre-epoch and extended-year boundaries", async () => {
    const instants = ["0000-01-01T00:00:00.000Z", "1969-12-31T23:59:59.999Z", "1970-01-01T00:00:00.001Z",
      "2000-02-29T12:30:01.001Z", "9999-12-31T23:59:59.999Z", "-271821-04-20T00:00:00.000Z", "+275760-09-13T00:00:00.000Z"];
    const rows = instants.map((instant, index) => source("v11", index + 1,
      { ...quota("v11", `quota:date:${index}`), observedTime: instant, resetsAt: instant },
      { observedDay: index % 2 ? "0000-01-01" : "9999-12-31", chunkDay: day }));
    await persistTypedTelemetryBatch(db(), rows);
    const result = await readTypedTelemetryCompatibilityPage(db(), options("quota"));
    result.records.forEach((actual) => expectExact(actual, rows.find((row) => row.sourceRowId === actual.source_row_id)!));
    expect(result.records).toHaveLength(rows.length);
  });

  it("scopes indexed keysets to namespace/owner/stream while preserving equal-time format and source IDs", async () => {
    const rows = [source("v1", 1, usage("v1", "event:first:0001")), source("v1", 7, usage("v1", "event:first:0007")),
      source("v11", 1, usage("v11", "event:second:0001")), source("v11", 7, usage("v11", "event:second:0007")),
      source("v11", 100, { ...usage("v11", "event:tomorrow"), eventTime: "2026-08-25T00:00:00.000Z" }),
      source("v11", 2, quota("v11"))];
    const foreign = [source("v11", 9, usage("v11"), { participantId: "participant:other", deviceId: "device:other", chunkRowId: "chunk:other", manifestId: "manifest:other" }),
      source("v11", 1, usage("v11"), { sourceNamespace: "source:other" })];
    await persistTypedTelemetryBatch(db(), [...rows, ...foreign]);
    const collected: TypedTelemetryCompatibilityRecord[] = [];
    let after: TypedTelemetryCompatibilityOptions["after"];
    do {
      const page = await readTypedTelemetryCompatibilityPage(db(), options("usage", { limit: 1, ...(after ? { after } : {}),
        fromObservedAtMs: Date.parse(time), beforeObservedAtMs: Date.parse("2026-08-25T00:00:00.000Z") }));
      collected.push(...page.records); after = page.next ?? undefined;
    } while (after);
    expect(collected.map((row) => [row.format, row.source_row_id])).toEqual([["v1", 1], ["v1", 7], ["v11", 1], ["v11", 7]]);
    expect((await readTypedTelemetryCompatibilityPage(db(), options("usage", { participantId: "participant:absent" }))).records).toEqual([]);
    const queryPlan = await db().prepare(`EXPLAIN QUERY PLAN ${TYPED_TELEMETRY_COMPATIBILITY_PAGE_SQL}`)
      .bind(Uint8Array.from(encodeTypedTelemetryId(namespace)).buffer, Uint8Array.from(encodeTypedTelemetryId(participantId)).buffer,
        1, -8_640_000_000_000_000, 8_640_000_000_000_001, -8_640_000_000_000_000, 9, 0, 2).all<{ detail: string }>();
    const details = queryPlan.results.map((row) => row.detail).join("\n");
    expect(details).toMatch(/SEARCH r USING (?:COVERING )?INDEX typed_telemetry_owner_time/);
    expect(details).toMatch(/SEARCH r USING INTEGER PRIMARY KEY/);
    expect(details).not.toMatch(/SCAN r\b/);
  });

  it("paginates more than one full page and bounds session-tool expansion to selected rows", async () => {
    const rows = Array.from({ length: 205 }, (_, index) => source("v11", index + 1,
      { ...session("v11"), sessionUuid: `session:page:${String(index).padStart(4, "0")}` },
      { chunkRowId: `chunk:session:page:${Math.floor(index / 200)}` }));
    for (let offset = 0; offset < rows.length; offset += 30) await persistTypedTelemetryBatch(db(), rows.slice(offset, offset + 30));
    const first = await readTypedTelemetryCompatibilityPage(db(), options("session", { limit: 200 }));
    expect(first.records).toHaveLength(200);
    expect(first.next).toEqual({ observedAtMs: Date.parse(time), format: "v11", sourceRowId: 200 });
    const second = await readTypedTelemetryCompatibilityPage(db(), options("session", { limit: 200, after: first.next! }));
    expect(second.records.map((row) => row.source_row_id)).toEqual([201, 202, 203, 204, 205]); expect(second.next).toBeNull();
    [...first.records, ...second.records].forEach((actual, index) => expectExact(actual, rows[index]!));
    const toolPlan = (await db().prepare(`EXPLAIN QUERY PLAN SELECT storage_row_id, tool_class, count
      FROM typed_telemetry_compatibility_session_tools WHERE storage_row_id IN (?, ?)
      ORDER BY storage_row_id, tool_class COLLATE BINARY LIMIT ?`).bind(1, 2, 65).all<{ detail: string }>()).results;
    expect(toolPlan.map((row) => row.detail).join("\n")).not.toMatch(/SCAN [rt]\b/);
  });

  it("rejects changed data and noncanonical identifier bytes without returning partial results", async () => {
    await persistTypedTelemetryBatch(db(), [source("v11", 7, usage("v11"))]);
    await db().exec("DROP TRIGGER typed_telemetry_usage_immutable; UPDATE typed_telemetry_usage SET input_uncached_tokens=9");
    await expect(readTypedTelemetryCompatibilityPage(db(), options("usage"))).rejects.toMatchObject({ code: "TYPED_TELEMETRY_CONFLICT" });
    await reset(); await applyD1Migrations(db(), migrations());
    await persistTypedTelemetryBatch(db(), [source("v11", 7, usage("v11"))]);
    await db().exec("DROP TRIGGER typed_telemetry_record_immutable");
    const alternate = new Uint8Array([0, ...new TextEncoder().encode(`event:v2:${"c".repeat(64)}`)]);
    await db().prepare("UPDATE typed_telemetry_records SET occurrence_id=?").bind(alternate.buffer).run();
    await expect(readTypedTelemetryCompatibilityPage(db(), options("usage"))).rejects.toMatchObject({ code: "TYPED_TELEMETRY_INVALID" });
  });

  it("refuses unbounded, unscoped and malformed page requests", async () => {
    for (const override of [{ limit: 201 }, { participantId: "" }, { beforeObservedAtMs: 0, fromObservedAtMs: 1 },
      { after: { format: "v11", observedAtMs: 0, sourceRowId: 0 } }, { stream: "unknown" }, { unknown: true }]) {
      await expect(readTypedTelemetryCompatibilityPage(db(), { ...options("usage"), ...override } as TypedTelemetryCompatibilityOptions))
        .rejects.toMatchObject({ code: "TYPED_TELEMETRY_INVALID" });
    }
  });
});
