import { env, reset, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest } from "@app-usagemonitor/telemetry-contract";
import { initializeStorageSource, readIngestionChanges } from "../src/analytics-delivery";
import { sha256Hex } from "../src/crypto";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from "../src/telemetry-v11-domain";
import { advanceV11DailyProjection, readV11ProjectedOwnerDays, retireV11DailyProjectionPage } from "../src/v11-daily-projection";
import { createV11DeviceFixture, makeV11Day, stageV11Day, v11UsageRecord } from "./helpers/telemetry-v11";

const b = env as Env & { STORAGE_ANALYTICS_DB: D1Database; TEST_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[]; TEST_ANALYTICS_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[] };
const source = () => b.USAGE_MONITOR_DB, target = () => b.STORAGE_ANALYTICS_DB;
const sourceId = "synthetic-v11-daily", today = () => new Date().toISOString().slice(0, 10);
const step = (db = target()) => advanceV11DailyProjection({ source: source(), target: db, sourceId });
async function drain() {
  for (let n = 0; n < 20; n++) {
    const progress = await step();
    const cleanup = await retireV11DailyProjectionPage(target(), sourceId);
    if (progress.state === "idle" && cleanup.state === "idle") return;
  }
  throw new Error("synthetic drain bound exceeded");
}
async function active(count = 1, day = today()) {
  const fixture = await createV11DeviceFixture(source(), { grant: true });
  const prepared = await makeV11Day(day, { usage: Array.from({ length: count }, (_, n) =>
    v11UsageRecord(day, "a", { eventId: `event:v2:${n.toString(16).padStart(64, "0")}` })) });
  const staged = await stageV11Day(source(), fixture, prepared);
  const prior = await createTelemetryV11DomainPredecessor(source(), fixture);
  const manifest: TelemetryV11DomainManifest = { schemaVersion: "telemetry-domain-manifest-v1.1",
    fromDay: day, throughDay: day, predecessor: { token: prior.token,
      previousGenerationId: prior.previousGenerationId, legacyFingerprint: prior.legacyFingerprint },
    days: [{ day, manifestId: staged.manifestId, manifestDigest: staged.manifestDigest }], manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  await activateTelemetryV11Domain(source(), fixture, manifest);
  const events = await readIngestionChanges(source(), sourceId, 0);
  return { fixture, manifest, event: events.at(-1)! };
}
const read = (ownerDigest: string) => readV11ProjectedOwnerDays({ source: source(), target: target(), sourceId,
  ownerDigest, fromDay: today(), throughDay: today() });

beforeEach(async () => {
  await reset();
  await applyD1Migrations(source(), b.TEST_MIGRATIONS);
  await applyD1Migrations(source(), b.TEST_TYPED_INGESTION_MIGRATIONS.filter(m => m.name.startsWith("0002")));
  await initializeStorageSource(source(), sourceId);
  await applyD1Migrations(source(), b.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(target(), b.TEST_ANALYTICS_MIGRATIONS);
});

describe("real activated source to isolated daily projection", () => {
  it("accepts the real domain while analytics is unavailable, then builds bounded pages before acknowledgement", async () => {
    const { event } = await active(203);
    expect(event.kind).toBe("owner-active");
    const broken = { prepare() { throw new Error("synthetic analytics unavailable"); } } as unknown as D1Database;
    await expect(step(broken)).rejects.toThrow("synthetic analytics unavailable");
    expect(await source().prepare("SELECT COUNT(*) n FROM telemetry_v11_records").first("n")).toBe(203);
    expect(await step()).toMatchObject({ state: "building", sequence: 0, recordsRead: 200 });
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_source_cursors").first("n")).toBe(0);
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_owner_heads").first("n")).toBe(0);
    expect(await step()).toMatchObject({ state: "building", recordsRead: 3, completedDay: today() });
    expect(await step()).toMatchObject({ state: "applied", sequence: 1 });
    const result = await read(event.ownerDigest);
    expect(result.state).toBe("available");
    expect(result.values).toHaveLength(1);
    expect(result.values[0]!.counts).toEqual({ usage: 203, quota: 0, session: 0 });
    expect(await step()).toMatchObject({ state: "idle" });
  });

  it("recovers a lost page response without folding the same records twice", async () => {
    const { event } = await active(203);
    let lost = false;
    const responseLost = { prepare: target().prepare.bind(target()),
      async batch(statements: D1PreparedStatement[]) {
        const result = await target().batch(statements);
        if (!lost) { lost = true; throw new Error("synthetic response loss"); }
        return result;
      } } as unknown as D1Database;
    expect(await step(responseLost)).toMatchObject({ state: "building", recordsRead: 200 });
    await drain();
    expect((await read(event.ownerDigest)).values[0]!.counts.usage).toBe(203);
  });

  it("rolls a failed page back and retries from the previous cursor", async () => {
    const { event } = await active(2);
    const failedBatch = { prepare: target().prepare.bind(target()), batch: (statements: D1PreparedStatement[]) =>
      target().batch([...statements, target().prepare("INSERT INTO synthetic_missing_table VALUES(1)")]) } as unknown as D1Database;
    await expect(step(failedBatch)).rejects.toThrow("V11_PROJECTION_STEP_UNACKNOWLEDGED");
    expect(await target().prepare("SELECT revision FROM analytics_v11_projection_work").first("revision")).toBe(0);
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_day_values").first("n")).toBe(0);
    await drain();
    expect((await read(event.ownerDigest)).values[0]!.counts.usage).toBe(2);
  });

  it("discards unfinished old work when withdrawal precedes its delivery", async () => {
    const { fixture, event } = await active(203);
    await step();
    await source().prepare("UPDATE participants SET state='deleting' WHERE id=?").bind(fixture.participantId).run();
    expect(await step()).toMatchObject({ state: "discarded", sequence: 1 });
    expect(await target().prepare("SELECT phase FROM analytics_v11_projection_work").first("phase")).toBe("retiring");
    await drain();
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_projection_work").first("n")).toBe(0);
    expect((await read(event.ownerDigest)).values).toEqual([]);
    expect(await target().prepare("SELECT reason FROM analytics_v11_discard_receipts WHERE event_digest=?")
      .bind(event.eventDigest).first("reason")).toBe("owner-withdrawn");
  });

  it("acknowledges source-proven erasure even after the old generation and owner link have disappeared", async () => {
    const { fixture, event } = await active();
    await source().prepare("UPDATE participants SET state='deleting' WHERE id=?").bind(fixture.participantId).run();
    await source().prepare("DELETE FROM participants WHERE id=?").bind(fixture.participantId).run();
    expect(await source().prepare("SELECT COUNT(*) n FROM telemetry_v11_records").first("n")).toBe(0);
    await drain();
    expect((await read(event.ownerDigest)).values).toEqual([]);
    expect(await target().prepare("SELECT state FROM analytics_owner_state WHERE owner_digest=?")
      .bind(event.ownerDigest).first("state")).toBe("erased");
    expect(await target().prepare("SELECT reason FROM analytics_v11_discard_receipts WHERE event_digest=?")
      .bind(event.eventDigest).first("reason")).toBe("owner-erased");
  });

  it("withholds already projected content as soon as source authority changes", async () => {
    const { fixture, event } = await active(); await drain();
    expect((await read(event.ownerDigest)).state).toBe("available");
    await source().prepare("UPDATE participants SET state='deleting' WHERE id=?").bind(fixture.participantId).run();
    expect(await read(event.ownerDigest)).toEqual({ state: "authority-unavailable", values: [] });
    await drain();
    expect(await read(event.ownerDigest)).toEqual({ state: "available", values: [] });
  });

  it("cannot recreate an old page after a competing withdrawal and physical cleanup", async () => {
    const { fixture, event } = await active(2);
    let raced = false;
    const racingTarget = { prepare: target().prepare.bind(target()), async batch(statements: D1PreparedStatement[]) {
      if (!raced) {
        raced = true;
        await source().prepare("UPDATE participants SET state='deleting' WHERE id=?").bind(fixture.participantId).run();
        await drain();
      }
      return target().batch(statements);
    } } as unknown as D1Database;
    expect(await step(racingTarget)).toMatchObject({ state: "applied", sequence: event.sequence });
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_projection_work").first("n")).toBe(0);
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_day_values").first("n")).toBe(0);
    expect((await read(event.ownerDigest)).values).toEqual([]);
  });

  it("cannot recreate retired work after a paused initialization resumes", async () => {
    const { fixture, event } = await active(2);
    const delayed = { prepare(sql: string) {
      const statement = target().prepare(sql);
      if (!sql.startsWith("INSERT INTO analytics_v11_projection_work")) return statement;
      return { bind(...values: unknown[]) { const bound = statement.bind(...values); return { async run() {
        await drain();
        await source().prepare("UPDATE participants SET state='deleting' WHERE id=?").bind(fixture.participantId).run();
        await drain();
        return bound.run();
      } }; } };
    } } as unknown as D1Database;
    expect(await step(delayed)).toMatchObject({ state: "applied", sequence: event.sequence });
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_projection_work").first("n")).toBe(0);
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_retirement_receipts").first("n")).toBe(1);
  });

  it("keeps a complete earlier day staged until the whole multi-day generation is finished", async () => {
    const fixture = await createV11DeviceFixture(source(), { grant: true });
    const yesterday = new Date(Date.parse(today()) - 86_400_000).toISOString().slice(0, 10);
    const first = await stageV11Day(source(), fixture, await makeV11Day(yesterday, { usage: [v11UsageRecord(yesterday, "a")] }));
    const second = await stageV11Day(source(), fixture, await makeV11Day(today(), { usage: [v11UsageRecord(today(), "b")] }));
    const prior = await createTelemetryV11DomainPredecessor(source(), fixture);
    const manifest: TelemetryV11DomainManifest = { schemaVersion: "telemetry-domain-manifest-v1.1",
      fromDay: yesterday, throughDay: today(), predecessor: { token: prior.token,
        previousGenerationId: prior.previousGenerationId, legacyFingerprint: prior.legacyFingerprint },
      days: [first, second].map(day => ({ day: day.day, manifestId: day.manifestId, manifestDigest: day.manifestDigest })),
      manifestDigest: "0".repeat(64) };
    manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
    await activateTelemetryV11Domain(source(), fixture, manifest);
    expect(await step()).toMatchObject({ state: "building", completedDay: yesterday });
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_day_values").first("n")).toBe(1);
    expect(await target().prepare("SELECT COUNT(*) n FROM analytics_v11_owner_heads").first("n")).toBe(0);
    await drain();
    const event = (await readIngestionChanges(source(), sourceId, 0))[0]!;
    const result = await readV11ProjectedOwnerDays({ source: source(), target: target(), sourceId,
      ownerDigest: event.ownerDigest, fromDay: yesterday, throughDay: today() });
    expect(result.state).toBe("available");
    expect(result.values.map(day => [day.day, day.counts.usage])).toEqual([[yesterday, 1], [today(), 1]]);
  });

  it("keeps both owners readable after later owner activation advances global authority", async () => {
    const first = await active(2); await drain();
    const second = await active(3);
    expect((await read(first.event.ownerDigest)).state).toBe("authority-unavailable");
    await drain();
    expect((await read(first.event.ownerDigest)).values[0]!.counts.usage).toBe(2);
    expect((await read(second.event.ownerDigest)).values[0]!.counts.usage).toBe(3);
  });

  it("records an explicitly complete empty day without manufacturing missing history", async () => {
    const { event } = await active(0); await drain();
    expect((await read(event.ownerDigest)).values[0]!.counts).toEqual({ usage: 0, quota: 0, session: 0 });
  });

  it("uses the manifest and occurrence index for bounded source pages", async () => {
    const rows = (await source().prepare(`EXPLAIN QUERY PLAN SELECT stream,occurrence_id,record_json FROM telemetry_v11_records
      WHERE manifest_id=? AND (stream,occurrence_id)>(?,?) ORDER BY stream,occurrence_id LIMIT ?`)
      .bind("synthetic-manifest", "", "", 200).all<{ detail: string }>()).results.map(row => row.detail).join("\n");
    expect(rows).toMatch(/SEARCH telemetry_v11_records USING INDEX .*manifest_id/);
    expect(rows).not.toMatch(/SCAN telemetry_v11_records|TEMP B-TREE/);
  });
});
