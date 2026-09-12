import { env, reset, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest } from "@app-usagemonitor/telemetry-contract";
import { initializeStorageSource, readIngestionChanges, applyAnalyticsChange } from "../src/analytics-delivery";
import { canonicalJson } from "../src/canonical-json";
import { lookupV11StorageSource } from "../src/v11-storage-journal";
import { createV11DailyProjectionValues, foldV11DailyProjectionValues } from "../src/v11-daily-projection-values";
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
async function active(count = 1, day = today(), distinctModels = false) {
  const fixture = await createV11DeviceFixture(source(), { grant: true });
  const prepared = await makeV11Day(day, { usage: Array.from({ length: count }, (_, n) =>
    v11UsageRecord(day, "a", { eventId: `event:v2:${n.toString(16).padStart(64, "0")}`, ...(distinctModels?{modelId:`model-${String(n).padStart(4,"0")}`}:{}) })) });
  const staged = await stageV11Day(source(), fixture, prepared);
  const entries = [staged];
  if (day !== today()) entries.push(await stageV11Day(source(), fixture, await makeV11Day(today(), {})));
  const prior = await createTelemetryV11DomainPredecessor(source(), fixture);
  const manifest: TelemetryV11DomainManifest = { schemaVersion: "telemetry-domain-manifest-v1.1",
    fromDay: day, throughDay: today(), predecessor: { token: prior.token,
      previousGenerationId: prior.previousGenerationId, legacyFingerprint: prior.legacyFingerprint },
    days: entries.map(entry => ({ day: entry.day, manifestId: entry.manifestId, manifestDigest: entry.manifestDigest })), manifestDigest: "0".repeat(64) };
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

const count = (table: string) => target().prepare(`SELECT count(*) n FROM ${table}`).first<number>("n");
const yesterday = () => new Date(Date.parse(today()) - 86_400_000).toISOString().slice(0, 10);
async function successor(value: Awaited<ReturnType<typeof active>>, days = value.manifest.days) {
  const prior = await createTelemetryV11DomainPredecessor(source(), value.fixture);
  const manifest: TelemetryV11DomainManifest = { schemaVersion: "telemetry-domain-manifest-v1.1", fromDay: days[0]!.day,
    throughDay: days.at(-1)!.day, predecessor: { token: prior.token, previousGenerationId: prior.previousGenerationId,
      legacyFingerprint: prior.legacyFingerprint }, days, manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  await activateTelemetryV11Domain(source(), value.fixture, manifest);
  return (await readIngestionChanges(source(), sourceId, 0)).at(-1)!;
}
function rawReadObserver(refuseManifest?: string) {
  const calls: string[] = [];
  const observed = new Proxy(source(), { get(db, key) {
    if (key === "prepare") return (sql: string) => {
      const statement = db.prepare(sql);
      if (!sql.startsWith("SELECT stream,occurrence_id,record_json FROM telemetry_v11_records")) return statement;
      return new Proxy(statement, { get(st, member) {
        if (member === "bind") return (...values: Parameters<D1PreparedStatement["bind"]>) => {
          calls.push(String(values[0])); if (values[0] === refuseManifest) throw new Error("immutable day was rescanned");
          return st.bind(...values);
        };
        const value = Reflect.get(st, member); return typeof value === "function" ? value.bind(st) : value;
      } });
    };
    const value = Reflect.get(db, key); return typeof value === "function" ? value.bind(db) : value;
  } });
  return { calls, step: () => advanceV11DailyProjection({ source: observed, target: target(), sourceId }) };
}
async function seedDifferentCache(value: Awaited<ReturnType<typeof active>>, overrides: Record<string, string>) {
  const generation = await lookupV11StorageSource(source(), value.event); if (generation.disposition !== "generation") throw new Error("synthetic generation missing");
  let values = createV11DailyProjectionValues(value.manifest.fromDay);
  const input = Array.from({ length: 203 }, (_, n) => v11UsageRecord(value.manifest.fromDay, "a", { eventId: `event:v2:${n.toString(16).padStart(64, "0")}` }));
  values = foldV11DailyProjectionValues(values, input.slice(0, 200)); values = foldV11DailyProjectionValues(values, input.slice(200));
  const identity: Record<string, string> = { source_id: sourceId, source_layout: "json-v11", source_namespace: "", owner_digest: value.event.ownerDigest,
    device_id: value.fixture.deviceId, manifest_id: value.manifest.days[0]!.manifestId, manifest_digest: value.manifest.days[0]!.manifestDigest,
    day: value.manifest.fromDay, schema_version: "v11-daily-projection-values-v1", pricing_method: values.pricingMethodVersion, registry_sha256: values.registrySha256, ...overrides };
  const stored = { ...values, day: identity.day, schemaVersion: identity.schema_version, pricingMethodVersion: identity.pricing_method, registrySha256: identity.registry_sha256 };
  const json = canonicalJson(stored), key = await sha256Hex(canonicalJson(identity));
  await target().prepare(`INSERT INTO analytics_v11_reusable_values
    (value_key,source_id,source_layout,source_namespace,owner_digest,device_id,manifest_id,manifest_digest,day,schema_version,pricing_method,registry_sha256,record_count,values_digest,values_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(key, identity.source_id, identity.source_layout, identity.source_namespace, identity.owner_digest,
      identity.device_id, identity.manifest_id, identity.manifest_digest, identity.day, identity.schema_version, identity.pricing_method, identity.registry_sha256,
      203, await sha256Hex(json), json).run();
}

describe("immutable v11 daily value reuse", () => {
  it("retains every cell of a 401-model multi-chunk day, resumes pages, reuses them and advances the next event",async()=>{
    const value=await active(401,yesterday(),true);
    expect(await step()).toMatchObject({state:'building',recordsRead:200});
    await target().prepare("CREATE TRIGGER synthetic_page_failure BEFORE INSERT ON analytics_v11_value_pages WHEN NEW.page_index=1 BEGIN SELECT RAISE(ABORT,'synthetic page failure'); END").run();
    await expect(step()).rejects.toThrow();
    expect(await count('analytics_v11_value_pages')).toBe(1);
    expect(await target().prepare("SELECT day_records FROM analytics_v11_projection_work WHERE phase='building'").first('day_records')).toBe(200);
    expect(await count('analytics_v11_projection_steps')).toBe(1);
    await target().prepare('DROP TRIGGER synthetic_page_failure').run();
    let lost=false;const flaky=new Proxy(target(),{get(db,key){
      if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await db.batch(statements);
        if(!lost){lost=true;throw new Error('synthetic lost model page response');}return result;};
      const result=Reflect.get(db,key);return typeof result==='function'?result.bind(db):result;
    }});
    expect(await step(flaky)).toMatchObject({state:'building',recordsRead:200});await drain();
    const output=(await readV11ProjectedOwnerDays({source:source(),target:target(),sourceId,ownerDigest:value.event.ownerDigest,fromDay:yesterday(),throughDay:yesterday()})).values[0]!;
    expect(output.counts.usage).toBe(401);expect(output.cells).toHaveLength(200);expect(output.omitted.usageEvents).toBe(201);
    expect(output.tokens.nonOverlappingTotal.knownSum).toBe('431075');
    const pages=(await target().prepare('SELECT values_json,page_digest FROM analytics_v11_value_pages ORDER BY page_index')
      .all<{values_json:string;page_digest:string}>()).results;
    expect(pages).toHaveLength(3);const models=new Set<string>();let records=0;
    for(const p of pages){expect(await sha256Hex(p.values_json)).toBe(p.page_digest);const v=JSON.parse(p.values_json);
      expect(v.omitted.usageEvents).toBe(0);expect(v.cells.length).toBeLessThanOrEqual(200);
      records+=v.counts.usage;for(const cell of v.cells)models.add(cell.modelId);}
    expect(records).toBe(401);expect(models.size).toBe(401);
    await expect(target().prepare('DELETE FROM analytics_v11_value_pages').run()).rejects.toThrow('analytics_v11_page_retained');
    await expect(target().prepare("UPDATE analytics_v11_value_pages SET page_digest=?").bind('f'.repeat(64)).run()).rejects.toThrow('analytics_v11_page_conflict');
    const added=await stageV11Day(source(),value.fixture,await makeV11Day(today(),{usage:[v11UsageRecord(today(),'b')]}));
    await successor(value,[value.manifest.days[0]!,{day:added.day,manifestId:added.manifestId,manifestDigest:added.manifestDigest}]);
    const observed=rawReadObserver(value.manifest.days[0]!.manifestId);
    expect(await observed.step()).toMatchObject({recordsRead:0,completedDay:yesterday()});await drain();
    expect(await count('analytics_v11_value_pages')).toBe(4);
    expect(await target().prepare('SELECT sequence FROM analytics_source_cursors WHERE source_id=?').bind(sourceId).first('sequence')).toBe(2);
    await source().prepare("UPDATE participants SET state='deleting' WHERE id=?").bind(value.fixture.participantId).run();
    expect((await read(value.event.ownerDigest)).state).toBe('authority-unavailable');await drain();
    expect(await count('analytics_v11_value_pages')).toBe(0);expect((await read(value.event.ownerDigest)).values).toEqual([]);
  });

  it("reuses unchanged historical days with zero raw reads and only one stored aggregate", async () => {
    const value = await active(203, yesterday()); await drain();
    const added = await stageV11Day(source(), value.fixture, await makeV11Day(today(), { usage: [v11UsageRecord(today(), "b")] }));
    await successor(value, [value.manifest.days[0]!, { day: added.day, manifestId: added.manifestId, manifestDigest: added.manifestDigest }]);
    const observed = rawReadObserver(value.manifest.days[0]!.manifestId);
    expect(await observed.step()).toMatchObject({ state: "building", recordsRead: 0, completedDay: yesterday() }); expect(observed.calls).toEqual([]);
    expect(await count("analytics_v11_reusable_values")).toBe(2); expect(await count("analytics_v11_day_references")).toBe(3);
    expect(await observed.step()).toMatchObject({ state: "building", recordsRead: 1, completedDay: today() });
    expect(await observed.step()).toMatchObject({ state: "applied", sequence: 2 });
    expect(await count("analytics_v11_reusable_values")).toBe(3); expect(await count("analytics_v11_legacy_day_values")).toBe(0);
    const readyWork = await target().prepare("SELECT values_json FROM analytics_v11_projection_work WHERE phase='ready'").first<string>("values_json");
    expect(JSON.parse(readyWork!).counts).toEqual({ usage: 0, quota: 0, session: 0 });
    await drain(); expect(await count("analytics_v11_day_references")).toBe(2); expect(await count("analytics_v11_reusable_values")).toBe(2);
    const visible = await readV11ProjectedOwnerDays({ source: source(), target: target(), sourceId, ownerDigest: value.event.ownerDigest, fromDay: yesterday(), throughDay: today() });
    expect(visible.values.map(v => v.counts.usage)).toEqual([203, 1]);
  });

  it("recalculates a changed immutable manifest and retires only its obsolete value", async () => {
    const value = await active(203); await drain();
    const replacement = await stageV11Day(source(), value.fixture, await makeV11Day(today(), { usage: Array.from({ length: 204 }, (_, n) =>
      v11UsageRecord(today(), "a", { eventId: `event:v2:${n.toString(16).padStart(64, "0")}` })) }));
    await successor(value, [{ day: replacement.day, manifestId: replacement.manifestId, manifestDigest: replacement.manifestDigest }]);
    const observed = rawReadObserver(); expect(await observed.step()).toMatchObject({ recordsRead: 200 }); expect(await observed.step()).toMatchObject({ recordsRead: 4 });
    expect(observed.calls).toEqual([replacement.manifestId, replacement.manifestId]); expect(await count("analytics_v11_reusable_values")).toBe(2);
    await drain(); expect(await count("analytics_v11_reusable_values")).toBe(1); expect((await read(value.event.ownerDigest)).values[0]!.counts.usage).toBe(204);
  });

  it.each([
    ["source", { source_id: "different-source" }], ["owner", { owner_digest: "f".repeat(64) }],
    ["device", { device_id: "different-device" }], ["manifest", { manifest_id: "different-manifest" }],
    ["manifest digest", { manifest_digest: "f".repeat(64) }], ["day", { day: "2026-08-01" }],
    ["layout and namespace", { source_layout: "typed-v11", source_namespace: "different-namespace" }],
    ["schema", { schema_version: "future-calculation-schema" }], ["pricing method", { pricing_method: "future-pricing" }],
    ["price registry", { registry_sha256: "f".repeat(64) }],
  ] as [string, Record<string, string>][])("does not reuse a value with a different %s", async (_name, overrides) => {
    const value = await active(203); await seedDifferentCache(value, overrides); const observed = rawReadObserver();
    expect(await observed.step()).toMatchObject({ state: "building", recordsRead: 200 }); expect(observed.calls).toHaveLength(1);
    expect(await count("analytics_v11_day_references")).toBe(0);
  });

  it("resumes a lost reuse-page response without duplicate references or values", async () => {
    const value = await active(203, yesterday()); await drain();
    const added = await stageV11Day(source(), value.fixture, await makeV11Day(today(), { usage: [v11UsageRecord(today(), "b")] }));
    await successor(value, [value.manifest.days[0]!, { day: added.day, manifestId: added.manifestId, manifestDigest: added.manifestDigest }]);
    let lost = false;
    const failing = new Proxy(target(), { get(db, key) {
      if (key === "batch") return async (statements: D1PreparedStatement[]) => { const result = await db.batch(statements); if (!lost) { lost = true; throw new Error("synthetic lost reuse response"); } return result; };
      const value = Reflect.get(db, key); return typeof value === "function" ? value.bind(db) : value;
    } });
    expect(await advanceV11DailyProjection({ source: source(), target: failing, sourceId })).toMatchObject({ recordsRead: 0, completedDay: yesterday() });
    expect(await count("analytics_v11_reusable_values")).toBe(2); expect(await count("analytics_v11_day_references")).toBe(3);
    await drain(); expect(await count("analytics_v11_reusable_values")).toBe(2); expect(await count("analytics_v11_day_references")).toBe(2);
  });

  it("withdraws serving immediately and erases all reused values through bounded retirement", async () => {
    const value = await active(203, yesterday()); await drain();
    const added = await stageV11Day(source(), value.fixture, await makeV11Day(today(), { usage: [v11UsageRecord(today(), "b")] }));
    await successor(value, [value.manifest.days[0]!, { day: added.day, manifestId: added.manifestId, manifestDigest: added.manifestDigest }]); await drain();
    await source().prepare("UPDATE participants SET state='deleting' WHERE id=?").bind(value.fixture.participantId).run();
    expect((await read(value.event.ownerDigest)).state).toBe("authority-unavailable"); await drain();
    for (const table of ["analytics_v11_projection_work", "analytics_v11_day_references", "analytics_v11_reusable_values", "analytics_v11_legacy_day_values"]) expect(await count(table)).toBe(0);
    expect(await count("analytics_v11_retirement_receipts")).toBe(2);
  });

  it("retires a ten-day owner in bounded four-value pages before recording completion", async () => {
    const fixture = await createV11DeviceFixture(source(), { grant: true });
    const days: TelemetryV11DomainManifest["days"] = [];
    for (let offset = 9; offset >= 0; offset--) {
      const day = new Date(Date.parse(today()) - offset * 86_400_000).toISOString().slice(0, 10);
      const staged = await stageV11Day(source(), fixture, await makeV11Day(day, { usage: [v11UsageRecord(day, offset.toString(16))] }));
      days.push({ day, manifestId: staged.manifestId, manifestDigest: staged.manifestDigest });
    }
    const prior = await createTelemetryV11DomainPredecessor(source(), fixture);
    const manifest: TelemetryV11DomainManifest = { schemaVersion: "telemetry-domain-manifest-v1.1", fromDay: days[0]!.day, throughDay: today(),
      predecessor: { token: prior.token, previousGenerationId: prior.previousGenerationId, legacyFingerprint: prior.legacyFingerprint }, days, manifestDigest: "0".repeat(64) };
    manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest)); await activateTelemetryV11Domain(source(), fixture, manifest);
    await drain(); expect(await count("analytics_v11_reusable_values")).toBe(10);
    await source().prepare("UPDATE participants SET state='deleting' WHERE id=?").bind(fixture.participantId).run();
    expect(await step()).toMatchObject({ state: "discarded" });
    expect(await retireV11DailyProjectionPage(target(), sourceId)).toEqual({ state: "retiring" });
    expect(await count("analytics_v11_day_references")).toBe(6); expect(await count("analytics_v11_reusable_values")).toBe(6);
    expect(await count("analytics_v11_retirement_receipts")).toBe(0);
    await drain(); expect(await count("analytics_v11_reusable_values")).toBe(0); expect(await count("analytics_v11_retirement_receipts")).toBe(1);
  });

  it("preserves completed pre-migration values without treating them as reusable proof", async () => {
    await reset(); await applyD1Migrations(source(), b.TEST_MIGRATIONS);
    await applyD1Migrations(source(), b.TEST_TYPED_INGESTION_MIGRATIONS.filter(m => m.name.startsWith("0002")));
    await initializeStorageSource(source(), sourceId); await applyD1Migrations(source(), b.TEST_INGESTION_BRIDGE_MIGRATIONS);
    await applyD1Migrations(target(), b.TEST_ANALYTICS_MIGRATIONS.filter(m => m.name < "0004"));
    const value = await active(1, yesterday()), generation = await lookupV11StorageSource(source(), value.event);
    if (generation.disposition !== "generation") throw new Error("synthetic generation missing");
    const values = foldV11DailyProjectionValues(createV11DailyProjectionValues(yesterday()), [v11UsageRecord(yesterday(), "a", { eventId: `event:v2:${"0".repeat(64)}` })]);
    await target().prepare(`INSERT INTO analytics_v11_projection_work(source_id,event_digest,owner_digest,generation_id,manifest_digest,from_day,through_day,next_day,values_json,phase)
      VALUES(?,?,?,?,?,?,?,?,?,'ready')`).bind(sourceId, value.event.eventDigest, value.event.ownerDigest, generation.generationId, generation.manifestDigest, yesterday(), today(), today(), canonicalJson(createV11DailyProjectionValues(today()))).run();
    await target().prepare("INSERT INTO analytics_v11_day_values(source_id,event_digest,day,record_count,values_json) VALUES(?,?,?,?,?)")
      .bind(sourceId, value.event.eventDigest, yesterday(), 1, canonicalJson(values)).run();
    await target().prepare("INSERT INTO analytics_v11_day_values(source_id,event_digest,day,record_count,values_json) VALUES(?,?,?,?,?)")
      .bind(sourceId, value.event.eventDigest, today(), 0, canonicalJson(createV11DailyProjectionValues(today()))).run();
    await applyAnalyticsChange(target(), value.event, async db => [db.prepare("INSERT INTO analytics_v11_owner_heads(source_id,owner_digest,event_digest,sequence) VALUES(?,?,?,?)")
      .bind(sourceId, value.event.ownerDigest, value.event.eventDigest, value.event.sequence)]);
    await applyD1Migrations(target(), b.TEST_ANALYTICS_MIGRATIONS);
    expect(await count("analytics_v11_legacy_day_values")).toBe(2); expect(await count("analytics_v11_reusable_values")).toBe(0);
    const visible = await readV11ProjectedOwnerDays({ source: source(), target: target(), sourceId, ownerDigest: value.event.ownerDigest, fromDay: yesterday(), throughDay: yesterday() });
    expect(visible.values).toEqual([values]);
    const added = await stageV11Day(source(), value.fixture, await makeV11Day(today(), { usage: [v11UsageRecord(today(), "b")] }));
    await successor(value, [value.manifest.days[0]!, { day: added.day, manifestId: added.manifestId, manifestDigest: added.manifestDigest }]);
    const observed = rawReadObserver(); expect(await observed.step()).toMatchObject({ recordsRead: 1 }); await drain();
    expect(await count("analytics_v11_legacy_day_values")).toBe(0); expect(await count("analytics_v11_reusable_values")).toBe(2);
  });

  it("bounds the production owner reader before expanding reusable values", async () => {
    const value = await active(); await drain(); const plans: string[] = [];
    const watched = new Proxy(target(), { get(db, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = db.prepare(sql); if (!sql.includes("c.authority_epoch") || !sql.includes("v.values_json")) return statement;
        return new Proxy(statement, { get(st, member) {
          if (member === "bind") return (...args: Parameters<D1PreparedStatement["bind"]>) => {
            const bound = st.bind(...args);
            return new Proxy(bound, { get(result, method) {
              if (method === "all") return async () => {
                plans.push(...(await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>()).results.map(row => row.detail));
                return result.all();
              };
              const value = Reflect.get(result, method); return typeof value === "function" ? value.bind(result) : value;
            } });
          };
          const value = Reflect.get(st, member); return typeof value === "function" ? value.bind(st) : value;
        } });
      };
      const value = Reflect.get(db, key); return typeof value === "function" ? value.bind(db) : value;
    } });
    const result = await readV11ProjectedOwnerDays({ source: source(), target: watched, sourceId, ownerDigest: value.event.ownerDigest, fromDay: today(), throughDay: today() });
    expect(result.values).toHaveLength(1);
    expect(plans.join("\n")).not.toMatch(/SCAN analytics_v11_legacy_day_values|SCAN [rlv](?:\s|$)/m);
    expect(plans.join("\n")).toMatch(/SEARCH r USING PRIMARY KEY .*source_id=.*event_digest=.*day/);
    expect(plans.join("\n")).toMatch(/SEARCH l USING PRIMARY KEY .*source_id=.*event_digest=.*day/);
  });

  it("uses direct cache and reference indexes without a full scan", async () => {
    const cache = (await target().prepare("EXPLAIN QUERY PLAN SELECT * FROM analytics_v11_reusable_values WHERE value_key=?").bind("f".repeat(64)).all<{ detail: string }>()).results.map(r => r.detail).join("\n");
    expect(cache).toMatch(/SEARCH analytics_v11_reusable_values USING PRIMARY KEY/); expect(cache).not.toMatch(/SCAN|TEMP B-TREE/);
    const references = (await target().prepare("EXPLAIN QUERY PLAN SELECT 1 FROM analytics_v11_day_references WHERE value_key=?").bind("f".repeat(64)).all<{ detail: string }>()).results.map(r => r.detail).join("\n");
    expect(references).toMatch(/SEARCH analytics_v11_day_references USING COVERING INDEX analytics_v11_references_value/); expect(references).not.toMatch(/SCAN|TEMP B-TREE/);
  });
});
