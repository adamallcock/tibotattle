import { env, reset, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalTelemetryV11Json, type TelemetryV11QuotaObservation } from "@app-usagemonitor/telemetry-contract";
import { createV11DeviceFixture, makeV11Day, stageV11Day, v11UsageRecord } from "./helpers/telemetry-v11";
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from "../src/device-auth";
import { insertTelemetryV1Chunk } from "../src/telemetry-v1-repository";
import { telemetryV11LegacyProjection } from "../src/telemetry-v11-repository";
import { parseTelemetryV1Chunk } from "../src/telemetry-v1";
import { sha256Hex } from "../src/crypto";
import { beginRawTelemetryCopy, copyLegacyTelemetryPage, readLegacyTelemetryCopyPage,
  verifyLegacyTelemetryCopyPage, type RawCopyRun } from "../src/typed-telemetry-copy";
import { prepareTypedTelemetryInsert, persistTypedTelemetryBatch, readTypedTelemetryPage } from "../src/typed-telemetry-repository";

const bindings = env as Env & { STORAGE_INGESTION_A: D1Database;
  TEST_MIGRATIONS: D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[] };
const source = () => bindings.USAGE_MONITOR_DB, target = () => bindings.STORAGE_INGESTION_A;
const day = () => new Date().toISOString().slice(0, 10);
const run = (format: "v1" | "v11"): RawCopyRun => ({ runId: `copy-${format}`,
  sourceNamespace: "original-database", sourceSnapshotDigest: "a".repeat(64), format });

beforeEach(async () => {
  await reset();
  await applyD1Migrations(source(), bindings.TEST_MIGRATIONS);
  await applyD1Migrations(target(), bindings.TEST_TYPED_INGESTION_MIGRATIONS);
});
async function seedV1(count: number) {
  const fixture = await createV11DeviceFixture(source());
  const records = Array.from({ length: count }, (_, i) => JSON.parse(telemetryV11LegacyProjection("usage",
    v11UsageRecord(day(), "a", { eventId: `event:v2:${i.toString(16).padStart(64, "0")}` }))!.canonicalRecord));
  const envelopeDigest = await sha256Hex(`synthetic-copy-${crypto.randomUUID()}`);
  const auth = await authenticateDevice(source(), fixture.authorization);
  const uploaded = await createDeviceUploadAuthorization(source(), auth, envelopeDigest, 200);
  const claimed = await claimDeviceUploadAuthorization(source(), `Upload ${uploaded.uploadAuthorization}`,
    { envelopeDigest, bodyBytes: 200, contentType: "application/json" });
  const chunk = parseTelemetryV1Chunk({ schemaVersion: "telemetry-contribution-v1.0", chunkId: `usage:${day()}:0`,
    chunkRevision: 1, chunkDigest: await sha256Hex(canonicalTelemetryV11Json(records)), parserVersion: "synthetic-copy-v1",
    consent: { telemetrySchemaVersion: "telemetry-contribution-v1.0", fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0" }, records });
  await insertTelemetryV1Chunk(source(), { chunkRowId: `chunk:${crypto.randomUUID()}`, participantId: fixture.participantId,
    deviceId: fixture.deviceId, chunk, envelopeDigest, r2Key: `synthetic/copy-${crypto.randomUUID()}`,
    deviceUploadAuthorizationId: claimed.authorizationId, createdAt: new Date().toISOString(), supersedes: null });
  return fixture;
}
async function seedV11() {
  const fixture = await createV11DeviceFixture(source(), { grant: true });
  const quota: TelemetryV11QuotaObservation = { schemaVersion: "quota-observation-v1.1",
    observationId: `quota-occurrence:v1:${"a".repeat(64)}`, provider: "openai_codex", observedTime: `${day()}T12:00:00.000Z`,
    planType: "pro", planVariant: "unknown", limitId: "codex", slot: "secondary", usedPercent: null,
    windowDurationMinutes: null, resetsAt: null, accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null,
      planBasis: "same_source_occurrence", planType: "pro", planEraId: null } };
  await stageV11Day(source(), fixture, await makeV11Day(day(), { usage: [v11UsageRecord(day())], quota: [quota],
    session: [{ schemaVersion: "session-dimension-v1.1", sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
      firstEventTime: `${day()}T12:00:00.000Z`, provider: "openai_codex", toolClassCounts: { shell: 0, other: 3 } }] }));
  return fixture;
}
async function copyAll(spec: RawCopyRun) {
  await beginRawTelemetryCopy(target(), spec);
  for (let page = 0; page < 10; page++) {
    if ((await copyLegacyTelemetryPage(source(), target(), spec)).reachedEnd) return;
  }
  throw new Error("Synthetic copy did not terminate");
}
function databaseWithBatch(batch: D1Database["batch"]): D1Database {
  return new Proxy(target(), { get(db, key) {
    if (key === "batch") return batch;
    const value = Reflect.get(db, key); return typeof value === "function" ? value.bind(db) : value;
  } });
}

describe("populated legacy-to-typed raw copy", () => {
  it("preserves a long codec-valid namespace independently from the operation token", async () => {
    await seedV1(1);
    const spec = { ...run("v1"), sourceNamespace: "original.namespace." + "x".repeat(130) };
    await beginRawTelemetryCopy(target(), spec);
    expect((await copyLegacyTelemetryPage(source(), target(), spec)).copied).toBe(1);
    expect((await readTypedTelemetryPage(target(), { sourceNamespace: spec.sourceNamespace, format: "v1" })).records[0]?.sourceNamespace).toBe(spec.sourceNamespace);
    await expect(verifyLegacyTelemetryCopyPage(source(), target(), spec, 0)).resolves.toMatchObject({verified:1});
    await expect(beginRawTelemetryCopy(target(), { ...spec, runId: spec.sourceNamespace })).rejects.toThrow("RAW_COPY_EVIDENCE_MISMATCH");
    await expect(beginRawTelemetryCopy(target(), { ...spec, sourceNamespace: "unadmitted space" })).rejects.toThrow();
  });

  it("resumes v1 pages with original row IDs and exact current bytes", async () => {
    await seedV1(200); await seedV1(3); const spec = run("v1"); await beginRawTelemetryCopy(target(), spec);
    expect(await copyLegacyTelemetryPage(source(), target(), spec)).toMatchObject({ copied: 200, afterSourceRowId: 200, reachedEnd: false });
    await beginRawTelemetryCopy(target(), spec);
    expect(await copyLegacyTelemetryPage(source(), target(), spec)).toMatchObject({ copied: 3, afterSourceRowId: 203 });
    expect(await copyLegacyTelemetryPage(source(), target(), spec)).toMatchObject({ copied: 0, reachedEnd: true });
    expect(await verifyLegacyTelemetryCopyPage(source(), target(), spec, 0)).toMatchObject({ verified: 200, afterSourceRowId: 200 });
    expect(await verifyLegacyTelemetryCopyPage(source(), target(), spec, 200)).toMatchObject({ verified: 3, afterSourceRowId: 203 });
    expect(await verifyLegacyTelemetryCopyPage(source(), target(), spec, 203)).toMatchObject({ verified: 0, reachedEnd: true });
    expect(await source().prepare("SELECT COUNT(*) n FROM telemetry_v1_records").first("n")).toBe(203);
  });

  it("selects deterministic byte/query bounded prefixes without losing original rows", async () => {
    await seedV1(40); const spec=run("v1"); await beginRawTelemetryCopy(target(),spec);
    const first=await readLegacyTelemetryCopyPage(source(),{sourceNamespace:spec.sourceNamespace,format:"v1",afterSourceRowId:0,maxReadBytes:16_384});
    expect(first.length).toBeGreaterThan(0);expect(first.length).toBeLessThan(40);
    const copied=await copyLegacyTelemetryPage(source(),target(),spec,{maxReadBytes:16_384});
    expect(copied.copied).toBe(first.length);expect(copied.afterSourceRowId).toBe(first.at(-1)!.sourceRowId);
    // Force preparation to split a wider page before its first mutation. Each
    // committed receipt advances only the exact prefix that actually fit.
    let total=copied.copied;
    for(let i=0;i<40;i++){const page=await copyLegacyTelemetryPage(source(),target(),spec,{maxStatements:20});total+=page.copied;if(page.reachedEnd)break;expect(page.copied).toBeLessThan(40);}
    expect(total).toBe(40);expect((await verifyLegacyTelemetryCopyPage(source(),target(),spec,0)).verified).toBe(40);
    expect(await target().prepare("SELECT copied_rows FROM storage_raw_copy_runs").first("copied_rows")).toBe(40);
  });

  it("copies staged v11, all streams and nullable quota without inventing a legacy counterpart", async () => {
    await seedV11(); const spec = run("v11"); await copyAll(spec);
    expect(await verifyLegacyTelemetryCopyPage(source(), target(), spec, 0)).toMatchObject({ verified: 3 });
    const page = await readTypedTelemetryPage(target(), { sourceNamespace: spec.sourceNamespace, format: "v11" });
    const quota = page.records.find(r => r.record.schemaVersion === "quota-observation-v1.1")!;
    expect(quota.legacy).toBeNull(); expect(quota.record).toMatchObject({ usedPercent: null, resetsAt: null });
    expect(await source().prepare("SELECT COUNT(*) n FROM telemetry_v11_domain_heads").first("n")).toBe(0);
  });

  it("preserves collisions with a nonempty target in another original namespace", async () => {
    await seedV1(1); const spec = run("v1");
    const rows = await readLegacyTelemetryCopyPage(source(), { sourceNamespace: spec.sourceNamespace, format: "v1", afterSourceRowId: 0 });
    await persistTypedTelemetryBatch(target(), rows.map(row => ({ ...row, sourceNamespace: "another-original-database" })));
    await copyAll(spec); await verifyLegacyTelemetryCopyPage(source(), target(), spec, 0);
    expect(await target().prepare("SELECT COUNT(*) n FROM typed_telemetry_records WHERE source_row_id=1").first("n")).toBe(2);
  });

  it("rolls evidence and checkpoint back together if checkpoint commit fails", async () => {
    await seedV1(2); const spec = run("v1"); await beginRawTelemetryCopy(target(), spec);
    await target().prepare("CREATE TRIGGER synthetic_copy_failure BEFORE INSERT ON storage_raw_copy_pages BEGIN SELECT RAISE(ABORT,'synthetic_full'); END").run();
    await expect(copyLegacyTelemetryPage(source(), target(), spec)).rejects.toThrow("RAW_COPY_UNACKNOWLEDGED");
    expect(await target().prepare("SELECT COUNT(*) n FROM typed_telemetry_records").first("n")).toBe(0);
    expect(await target().prepare("SELECT copied_rows FROM storage_raw_copy_runs").first("copied_rows")).toBe(0);
    await target().prepare("DROP TRIGGER synthetic_copy_failure").run();
    expect(await copyLegacyTelemetryPage(source(), target(), spec)).toMatchObject({ copied: 2 });
  });

  it("refuses resumed source identity changes and denormalized corruption instead of repairing silently", async () => {
    await seedV1(1); const spec = run("v1"); await beginRawTelemetryCopy(target(), spec);
    await expect(beginRawTelemetryCopy(target(), { ...spec, sourceSnapshotDigest: "b".repeat(64) })).rejects.toThrow("RAW_COPY_EVIDENCE_MISMATCH");
    // Deliberately corrupt a permitted old denormalized column; preserve the JSON.
    await source().prepare("UPDATE telemetry_v1_records SET model_id='corrupt-model'").run();
    await expect(copyLegacyTelemetryPage(source(), target(), spec)).rejects.toThrow("RAW_COPY_EVIDENCE_MISMATCH");
    expect(await target().prepare("SELECT copied_rows FROM storage_raw_copy_runs").first("copied_rows")).toBe(0);
  });

  it("verification detects an unpreserved source row added after the copy", async () => {
    await seedV1(1); const spec = run("v1"); await copyAll(spec); await seedV1(1);
    await expect(verifyLegacyTelemetryCopyPage(source(), target(), spec, 0)).rejects.toThrow("RAW_COPY_EVIDENCE_MISMATCH");
  });

  it("reconciles a committed page when its batch response is lost", async () => {
    await seedV1(200); const spec = run("v1"); await beginRawTelemetryCopy(target(), spec);
    const lostResponse = databaseWithBatch(async statements => {
      await target().batch(statements); throw new Error("Synthetic response lost after commit");
    });
    expect(await copyLegacyTelemetryPage(source(), lostResponse, spec)).toMatchObject({ copied: 200, afterSourceRowId: 200 });
    expect(await target().prepare("SELECT COUNT(*) n FROM typed_telemetry_records").first("n")).toBe(200);
    expect(await target().prepare("SELECT copied_rows FROM storage_raw_copy_runs").first("copied_rows")).toBe(200);
  });

  it("rolls back all 200 payload rows and earlier receipts when a later receipt fails", async () => {
    await seedV1(200); const spec = run("v1"); await beginRawTelemetryCopy(target(), spec);
    await target().prepare(`CREATE TRIGGER synthetic_second_receipt_refusal BEFORE INSERT ON storage_raw_copy_pages
      WHEN NEW.after_source_row_id=32 BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END`).run();
    await expect(copyLegacyTelemetryPage(source(), target(), spec)).rejects.toThrow("RAW_COPY_UNACKNOWLEDGED");
    expect(await target().prepare("SELECT COUNT(*) n FROM typed_telemetry_records").first("n")).toBe(0);
    expect(await target().prepare("SELECT COUNT(*) n FROM storage_raw_copy_pages").first("n")).toBe(0);
    expect(await target().prepare("SELECT last_source_row_id,copied_rows FROM storage_raw_copy_runs").first())
      .toEqual({last_source_row_id:0,copied_rows:0});
    await target().exec("DROP TRIGGER synthetic_second_receipt_refusal");
    expect(await copyLegacyTelemetryPage(source(), target(), spec)).toMatchObject({copied:200});
    const receipts=(await target().prepare("SELECT after_source_row_id,through_source_row_id,record_count,batch_digest FROM storage_raw_copy_pages ORDER BY after_source_row_id").all()).results;
    expect(receipts.map(r=>[r.after_source_row_id,r.through_source_row_id,r.record_count]))
      .toEqual([[0,32,32],[32,64,32],[64,96,32],[96,128,32],[128,160,32],[160,192,32],[192,200,8]]);
    const originals=await readLegacyTelemetryCopyPage(source(),{sourceNamespace:spec.sourceNamespace,format:"v1",afterSourceRowId:0});
    for(let i=0;i<receipts.length;i++)expect(receipts[i]!.batch_digest)
      .toBe((await prepareTypedTelemetryInsert(target(),originals.slice(i*32,(i+1)*32))).batchDigest);
  });

  it("does not acknowledge only the first matching subreceipt after an unknown outcome", async () => {
    await seedV1(200); const spec=run("v1"); await beginRawTelemetryCopy(target(),spec);
    const incomplete=databaseWithBatch(async statements=>{
      // Simulate a damaged durable history after a successful atomic write.
      await target().batch(statements);
      await target().prepare("DELETE FROM storage_raw_copy_pages WHERE after_source_row_id>0").run();
      throw new Error("Synthetic incomplete retained proof");
    });
    await expect(copyLegacyTelemetryPage(source(),incomplete,spec)).rejects.toThrow("RAW_COPY_UNACKNOWLEDGED");
  });

  it("converges concurrent callers starting from the same checkpoint", async () => {
    await seedV1(200); const spec = run("v1"); await beginRawTelemetryCopy(target(), spec);
    let arrived = 0, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const concurrent = databaseWithBatch(async statements => {
      arrived++; if (arrived === 2) release(); await barrier;
      return target().batch(statements);
    });
    const receipts = await Promise.all([copyLegacyTelemetryPage(source(), concurrent, spec),
      copyLegacyTelemetryPage(source(), concurrent, spec)]);
    expect(receipts).toEqual([{ copied: 200, afterSourceRowId: 200, reachedEnd: false },
      { copied: 200, afterSourceRowId: 200, reachedEnd: false }]);
    expect(await target().prepare("SELECT copied_rows FROM storage_raw_copy_runs").first("copied_rows")).toBe(200);
    expect(await target().prepare("SELECT COUNT(*) n FROM storage_raw_copy_pages").first("n")).toBe(7);
    await verifyLegacyTelemetryCopyPage(source(), target(), spec, 0);
  });

  it("does not acknowledge a conflicting durable page receipt", async () => {
    await seedV1(2); const spec = run("v1"); await beginRawTelemetryCopy(target(), spec);
    const conflicting = databaseWithBatch(async () => {
      // Inject an operator-corrupted receipt, not a legitimate application write.
      await target().prepare("INSERT INTO storage_raw_copy_pages VALUES(?,0,2,2,?)").bind(spec.runId, "b".repeat(64)).run();
      throw new Error("Synthetic unknown result");
    });
    await expect(copyLegacyTelemetryPage(source(), conflicting, spec)).rejects.toThrow("RAW_COPY_UNACKNOWLEDGED");
    expect(await target().prepare("SELECT COUNT(*) n FROM typed_telemetry_records").first("n")).toBe(0);
  });

  it.each([0, -1])("refuses an explicitly stored source row ID %i instead of skipping it", async rowId => {
    await seedV1(1); const spec = run("v1"); await beginRawTelemetryCopy(target(), spec);
    await source().prepare("UPDATE telemetry_v1_records SET id=?").bind(rowId).run();
    await expect(copyLegacyTelemetryPage(source(), target(), spec)).rejects.toThrow("RAW_COPY_EVIDENCE_MISMATCH");
    await expect(verifyLegacyTelemetryCopyPage(source(), target(), spec, 0)).rejects.toThrow("RAW_COPY_EVIDENCE_MISMATCH");
  });
});
