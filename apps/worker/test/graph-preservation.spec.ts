import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN_MODEL_HISTORY_CATALOG_VERSION, canonicalTelemetryV11Json, projectAdminModelHistoryDay,
  telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest,
} from "@app-usagemonitor/telemetry-contract";
import {
  ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG, ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
  ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE, buildAdminCommunityAllowancePreview,
  readCachedAdminCommunityAllowancePreview, warmAdminCommunityAllowancePreviewCache,
} from "../src/admin-community-allowance";
import { COMMUNITY_ALLOWANCE_BASIS, COMMUNITY_ATTRIBUTION_METHOD_VERSION } from "../src/community-allowance";
import { warmCommunityAnalysisCaches } from "../src/community-analysis-warmer";
import { readPublishedCommunityDailyAggregatesWithAllowanceState } from "../src/community-daily-aggregates";
import { createD1InvocationBudget } from "../src/d1-invocation-budget";
import { projectPublicAllowanceGraph } from "../src/public-allowance-breakdowns";
import { MODEL_HISTORY_METHOD_VERSION } from "../src/quota-analysis-v1";
import { authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization } from "../src/device-auth";
import { sha256Hex } from "../src/crypto";
import { parseTelemetryV1Chunk } from "../src/telemetry-v1";
import {
  currentTelemetryV1Chunk, existingTelemetryV1ChunkByEnvelopeDigest, insertTelemetryV1Chunk,
  type TelemetryV1ChunkInsert,
} from "../src/telemetry-v1-repository";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from "../src/telemetry-v11-domain";
import { telemetryV11LegacyProjection } from "../src/telemetry-v11-repository";
import { createV11DeviceFixture, makeV11Day, stageV11Day, v11UsageRecord } from "./helpers/telemetry-v11";

const db = () => env.USAGE_MONITOR_DB;
const migrations = () => (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
const NOW = Date.parse("2026-09-07T12:00:00.000Z"), DAY = "2026-09-06";
const PARTICIPANT = "synthetic-preserved-graph-participant";
type Fixture = Awaited<ReturnType<typeof createV11DeviceFixture>>;
type Control = { mutation_epoch: number; graph_append_epoch: number; graph_invalidation_epoch: number };

beforeEach(async () => { await reset(); await applyD1Migrations(db(), migrations()); });

async function upload(fixture: Fixture) {
  const envelopeDigest = await sha256Hex(`synthetic-graph-upload:${crypto.randomUUID()}`);
  const principal = await authenticateDevice(db(), fixture.authorization);
  const authorization = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 200);
  const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${authorization.uploadAuthorization}`,
    { envelopeDigest, bodyBytes: 200, contentType: "application/json" });
  return { envelopeDigest, authorizationId: claimed.authorizationId };
}

async function prepareChunk(fixture: Fixture, options: {
  sequence?: number; revision?: number; day?: string; supersedes?: TelemetryV1ChunkInsert["supersedes"];
} = {}): Promise<TelemetryV1ChunkInsert> {
  const sequence = options.sequence ?? 0, day = options.day ?? DAY;
  const projection = telemetryV11LegacyProjection("usage", v11UsageRecord(day, (sequence + 1).toString(16)));
  if (projection === null) throw new Error("synthetic usage projection missing");
  const records = [JSON.parse(projection.canonicalRecord)];
  const grant = await upload(fixture);
  return {
    chunkRowId: `synthetic-graph-chunk:${crypto.randomUUID()}`,
    participantId: fixture.participantId, deviceId: fixture.deviceId,
    chunk: parseTelemetryV1Chunk({ schemaVersion: "telemetry-contribution-v1.0", chunkId: `usage:${day}:${sequence}`,
      chunkRevision: options.revision ?? 1, chunkDigest: await sha256Hex(canonicalTelemetryV11Json(records)),
      parserVersion: "synthetic-graph-preservation", consent: {
        telemetrySchemaVersion: "telemetry-contribution-v1.0",
        fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
        privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0",
      }, records }),
    envelopeDigest: grant.envelopeDigest, deviceUploadAuthorizationId: grant.authorizationId,
    r2Key: `synthetic/graph-preservation/${crypto.randomUUID()}`, createdAt: new Date().toISOString(),
    supersedes: options.supersedes ?? null,
  };
}

async function seedInput() {
  const fixture = await createV11DeviceFixture(db(), { participantId: PARTICIPANT });
  const insert = await prepareChunk(fixture);
  await insertTelemetryV1Chunk(db(), insert);
  return { fixture, insert };
}

function preview() {
  const model = projectAdminModelHistoryDay({ day: DAY, catalogVersion: ADMIN_MODEL_HISTORY_CATALOG_VERSION,
    values: [["gpt-6-astra", 1_166, 1]], fittedParticipantCount: 1, unstableParticipantCount: 0,
    staleParticipantCount: 0, refusedParticipantCount: 0, v1ParticipantCount: 1, unsupportedSourceParticipantCount: 0 });
  if (model === null) throw new Error("synthetic model day missing");
  return buildAdminCommunityAllowancePreview([{ participantId: PARTICIPANT, planType: "pro",
    capacityNanousd: 1_200_000_000_000, lastObservedAt: `${DAY}T12:00:00.000Z` }], NOW, [PARTICIPANT], {
    modelConfig: ADMIN_COMMUNITY_ALLOWANCE_MODEL_CONFIG, basis: ADMIN_COMMUNITY_ALLOWANCE_MODELS_BASIS,
    gate: ADMIN_COMMUNITY_ALLOWANCE_MODELS_GATE, days: [model],
  });
}

async function seedPublication() {
  const value = preview(), payload = JSON.stringify(value);
  const epoch = (await db().prepare("SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id=1")
    .first<{ mutation_epoch: number }>())!.mutation_epoch;
  await db().batch([
    db().prepare(`INSERT INTO admin_community_allowance_preview_cache
      (singleton,generated_at,payload_json,attribution_method_version,source_mutation_epoch) VALUES(1,?,?,?,?)`)
      .bind(value.generatedAt, payload, COMMUNITY_ATTRIBUTION_METHOD_VERSION, epoch),
    db().prepare(`UPDATE community_allowance_publication_state SET publication_state='ready',expected_basis=?,
      attribution_method_version=?,safe_from_day=?,safe_to_day=? WHERE singleton=1`)
      .bind(COMMUNITY_ALLOWANCE_BASIS, COMMUNITY_ATTRIBUTION_METHOD_VERSION, value.from, value.to),
    db().prepare(`INSERT INTO community_daily_aggregates
      (aggregate_id,day,revision,source_mutation_epoch,policy_version,payload_json,payload_sha256,release_state,released_at)
      VALUES('synthetic-preserved-activity',?,1,?,'community-daily-v1.0','{}',?,'published',?)`)
      .bind(DAY, epoch, await sha256Hex("{}"), value.generatedAt),
  ]);
  return { value, payload, epoch };
}

async function control() {
  return (await db().prepare(`SELECT mutation_epoch,graph_append_epoch,graph_invalidation_epoch
    FROM community_snapshot_mutation_control WHERE singleton_id=1`).first<Control>())!;
}
async function cache() {
  return db().prepare("SELECT * FROM admin_community_allowance_preview_cache WHERE singleton=1").first();
}
async function revision() {
  return (await db().prepare("SELECT revision FROM community_analytical_input_versions WHERE participant_id=?")
    .bind(PARTICIPANT).first<{ revision: number }>())?.revision;
}
async function publicGraph(nowMs = NOW) {
  const read = await readPublishedCommunityDailyAggregatesWithAllowanceState(db(), DAY, DAY);
  return { read, graph: projectPublicAllowanceGraph(read.allowanceBreakdownsCache,
    { publishedDays: read.rows.map(row => row.day), nowMs }) };
}
async function expectUnavailable() {
  expect(await cache()).toBeNull();
  await expect(readCachedAdminCommunityAllowancePreview(db(), NOW))
    .rejects.toMatchObject({ code: "ADMIN_ALLOWANCE_CACHE_UNAVAILABLE" });
  expect((await publicGraph()).graph).toBeNull();
}

async function warmSource(nowMs = NOW) {
  const lease = "synthetic-graph-publisher-lease";
  await db().prepare(`UPDATE retention_state SET maintenance_lease_token=?,
    maintenance_lease_expires_at='2027-01-01T00:00:00.000Z' WHERE singleton=1`).bind(lease).run();
  const meter = createD1InvocationBudget(900);
  const result = await warmCommunityAnalysisCaches(meter.wrap(db()), nowMs,
    { meter, deadlineMs: Date.now() + 30_000, maintenanceLease: lease });
  expect(result).toEqual({ status: "complete", visited: 1, published: 1, resumed: 1 });
  expect(meter.queriesUsed).toBeLessThan(900);
}

function recovery() {
  return { mode: "cache-only" as const, budget: { remainingQueries: 800, deadlineMs: Date.now() + 30_000 } };
}

async function seedModelDay(options: { reconstructed?: boolean; terminalNoFit?: boolean; day?: string } = {}) {
  const prior = { ...preview().models.days[0]!, day: options.day ?? DAY };
  const value = options.terminalNoFit ? projectAdminModelHistoryDay({ ...prior,
    values: [], fittedParticipantCount: 0, refusedParticipantCount: 1 }) : prior;
  if (value === null) throw new Error("synthetic terminal model day missing");
  const source = await control();
  await db().prepare(`INSERT INTO community_model_composition_days
    (day,payload_json,computed_at,attribution_method_version,source_mutation_epoch,history_method_version)
    VALUES(?,?,?,?,?,?)`).bind(value.day, JSON.stringify(value), new Date(NOW).toISOString(),
      COMMUNITY_ATTRIBUTION_METHOD_VERSION, source.mutation_epoch,
      options.reconstructed ? MODEL_HISTORY_METHOD_VERSION : null).run();
  return value;
}

async function modelRows() {
  return (await db().prepare("SELECT * FROM community_model_composition_days ORDER BY day").all()).results;
}

describe("preserved graph publication on local D1", () => {
  it("preserves exact aggregate, plan and model output across a genuine same-device/day revision-1 append", async () => {
    const { fixture } = await seedInput(); const published = await seedPublication();
    const before = await control(), oldRevision = await revision(), oldCache = await cache(), oldGraph = await publicGraph();
    expect(oldGraph.graph?.breakdowns.days[0]).toMatchObject({ combined: { centralUsd: 1_200 },
      byPlanType: { pro: { centralUsd: 1_200 } }, models: [["gpt-6-astra", 1_166, 1]] });
    await insertTelemetryV1Chunk(db(), await prepareChunk(fixture, { sequence: 1 }));
    expect(await revision()).toBe(oldRevision! + 1);
    expect(await control()).toEqual({ mutation_epoch: before.mutation_epoch + 1,
      graph_append_epoch: before.mutation_epoch + 1, graph_invalidation_epoch: before.graph_invalidation_epoch });
    expect(await cache()).toEqual(oldCache);
    expect(await readCachedAdminCommunityAllowancePreview(db(), NOW)).toEqual(published.value);
    const after = await publicGraph();
    expect(after.read.allowancePublicationState?.publication_state).toBe("updating");
    expect(after.graph).toEqual(oldGraph.graph);
    expect(after.read.rows).toEqual(oldGraph.read.rows);
    expect(await db().prepare("SELECT COUNT(*) AS n FROM telemetry_v1_records").first()).toEqual({ n: 2 });
  });

  it("preserves the real published date beyond the former two-hour expiry without creating newer points", async () => {
    await seedInput(); const published = await seedPublication(); const original = await publicGraph();
    const later = NOW + 3 * 86_400_000;
    expect(await readCachedAdminCommunityAllowancePreview(db(), later)).toEqual(published.value);
    expect((await publicGraph(later)).graph).toEqual(original.graph);
    expect((await publicGraph(later)).graph?.breakdowns.generatedAt).toBe(published.value.generatedAt);
  });

  it("repository replay lookup and rejected duplicate insertion do not change the publication, epoch, or records", async () => {
    const { fixture, insert } = await seedInput(); await seedPublication();
    const before = await control(), oldCache = await cache(), oldRevision = await revision();
    expect((await existingTelemetryV1ChunkByEnvelopeDigest(db(), PARTICIPANT, insert.envelopeDigest))?.id)
      .toBe(insert.chunkRowId);
    await expect(insertTelemetryV1Chunk(db(), await prepareChunk(fixture)))
      .rejects.toMatchObject({ code: "CHUNK_REVISION_CONFLICT" });
    expect(await control()).toEqual(before); expect(await revision()).toBe(oldRevision); expect(await cache()).toEqual(oldCache);
    expect(await db().prepare("SELECT COUNT(*) AS n FROM telemetry_v1_records").first()).toEqual({ n: 1 });
    expect(await db().prepare("SELECT accepted_count FROM telemetry_v1_chunk_admission_windows").first())
      .toEqual({ accepted_count: 1 });
  });

  it.each([
    ["supersession", "UPDATE telemetry_v1_chunks SET superseded_at='2026-09-07T12:01:00.000Z'"],
    ["digest-only correction", "UPDATE telemetry_v1_chunks SET chunk_digest='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'"],
    ["participant withdrawal", "UPDATE participants SET state='deleting'"],
    ["owner erasure cascade", "DELETE FROM participants"],
    ["current chunk removal", "DELETE FROM telemetry_v1_chunks"],
    ["unknown epoch mutation", "UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1"],
    ["aggregate policy change", "UPDATE community_snapshot_policy SET maturity_days=maturity_days+1 WHERE singleton_id=1"],
  ])("hard-invalidates on %s", async (_label, sql) => {
    await seedInput(); await seedPublication(); const before = await control();
    await db().prepare(sql).run();
    expect((await control()).mutation_epoch).toBeGreaterThan(before.mutation_epoch);
    expect((await control()).graph_invalidation_epoch).toBe((await control()).mutation_epoch);
    await expectUnavailable();
  });

  it("preserves every published view through both phases of an authorized revision-2 replacement", async () => {
    const { fixture } = await seedInput(); await seedPublication();
    const before = await control(), oldCache = await cache(), graph = (await publicGraph()).graph, oldRevision = await revision();
    const supersedes = await currentTelemetryV1Chunk(db(), PARTICIPANT, fixture.deviceId, "usage", DAY, 0);
    await insertTelemetryV1Chunk(db(), await prepareChunk(fixture, { revision: 2, supersedes }));
    expect(await db().prepare("SELECT revision FROM telemetry_v1_chunks WHERE superseded_at IS NULL").first())
      .toEqual({ revision: 2 });
    expect(await cache()).toEqual(oldCache);
    expect((await publicGraph()).graph).toEqual(graph);
    expect(await control()).toEqual({ mutation_epoch: before.mutation_epoch + 2,
      graph_append_epoch: before.mutation_epoch + 2, graph_invalidation_epoch: before.graph_invalidation_epoch });
    expect(await revision()).toBe(oldRevision! + 2);
    expect(await db().prepare("SELECT COUNT(*) AS n FROM community_graph_update_scope").first()).toEqual({ n: 0 });
  });

  it("preserves the publication when the authorized first sync of a new identity starts at a higher revision", async () => {
    const { fixture } = await seedInput(); await seedPublication();
    const oldCache = await cache(), before = await control();
    await insertTelemetryV1Chunk(db(), await prepareChunk(fixture, { sequence: 1, revision: 2 }));
    expect(await cache()).toEqual(oldCache);
    expect((await control()).graph_invalidation_epoch).toBe(before.graph_invalidation_epoch);
  });

  it("a revision-1 insert cannot reuse a superseded higher-revision identity as a soft append", async () => {
    const fixture = await createV11DeviceFixture(db(), { participantId: PARTICIPANT });
    await insertTelemetryV1Chunk(db(), await prepareChunk(fixture, { revision: 2 }));
    await db().batch([
      db().prepare("UPDATE telemetry_v1_chunks SET superseded_at='2026-09-07T12:01:00.000Z'"),
      db().prepare("DELETE FROM telemetry_v1_records"),
    ]);
    await seedPublication();
    await insertTelemetryV1Chunk(db(), await prepareChunk(fixture));
    await expectUnavailable();
  });

  it("a new contributor's first upload preserves the existing cohort publication until a successor is ready", async () => {
    await seedInput(); await seedPublication(); const oldCache = await cache(), oldGraph = await publicGraph();
    const newcomer = await createV11DeviceFixture(db(), { participantId: "synthetic-new-graph-participant" });
    await insertTelemetryV1Chunk(db(), await prepareChunk(newcomer));
    expect(await cache()).toEqual(oldCache); expect((await publicGraph()).graph).toEqual(oldGraph.graph);
  });

  it("an authorized competing device marks calculations dirty without revoking the published generation", async () => {
    await seedInput(); const second = await createV11DeviceFixture(db(), { participantId: PARTICIPANT });
    await seedPublication();
    const oldCache = await cache(), before = await control(), oldRevision = await revision();
    await insertTelemetryV1Chunk(db(), await prepareChunk(second));
    expect(await cache()).toEqual(oldCache);
    expect((await control()).graph_invalidation_epoch).toBe(before.graph_invalidation_epoch);
    expect(await revision()).toBe(oldRevision! + 1);
  });

  it("a new device on a disjoint day can append without replacing an existing elected day", async () => {
    await seedInput(); const second = await createV11DeviceFixture(db(), { participantId: PARTICIPANT });
    await seedPublication(); const oldCache = await cache();
    await insertTelemetryV1Chunk(db(), await prepareChunk(second, { day: "2026-09-05", sequence: 1 }));
    expect(await cache()).toEqual(oldCache);
    expect((await publicGraph()).graph).not.toBeNull();
  });

  it("new v1 input atop accepted legacy history invalidates format arbitration", async () => {
    const fixture = await createV11DeviceFixture(db(), { participantId: PARTICIPANT });
    const grant = await upload(fixture);
    await db().prepare(`INSERT INTO telemetry_contributions(id,participant_id,plaintext_digest,envelope_digest,r2_key,
      status,schema_version,range_start,range_end,client_platform,provider_policy_epoch,estimated_api_cost_usd,
      priced_event_coverage_percent,unknown_model_event_count,unknown_billable_units,price_basis,declared_record_count,
      created_at,device_upload_authorization_id) VALUES('synthetic-legacy',?,?,?,'synthetic/graph-legacy','accepted',
      'telemetry-contribution-v0.1',?,?,'macos','unknown',NULL,0,0,0,'unavailable',0,?,?)`)
      .bind(PARTICIPANT, "a".repeat(64), grant.envelopeDigest, `${DAY}T00:00:00.000Z`, `${DAY}T23:59:59.999Z`,
        new Date().toISOString(), grant.authorizationId).run();
    await seedPublication();
    await insertTelemetryV1Chunk(db(), await prepareChunk(fixture));
    await expectUnavailable();
  });

  it("complete successor-domain activation is hard and later blocked legacy writes cannot restore the preview", async () => {
    const fixture = await createV11DeviceFixture(db(), { participantId: PARTICIPANT, grant: true });
    const today = new Date().toISOString().slice(0, 10);
    const staged = await stageV11Day(db(), fixture, await makeV11Day(today, {}));
    const prior = await createTelemetryV11DomainPredecessor(db(), fixture);
    const manifest: TelemetryV11DomainManifest = { schemaVersion: "telemetry-domain-manifest-v1.1",
      fromDay: today, throughDay: today, predecessor: { token: prior.token,
        previousGenerationId: prior.previousGenerationId, legacyFingerprint: prior.legacyFingerprint },
      days: [{ day: today, manifestId: staged.manifestId, manifestDigest: staged.manifestDigest }], manifestDigest: "0".repeat(64) };
    manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
    await seedPublication(); const before = await control();
    await activateTelemetryV11Domain(db(), fixture, manifest);
    expect((await control()).graph_invalidation_epoch).toBeGreaterThan(before.mutation_epoch);
    await expectUnavailable();
    const invalidLegacy = await prepareChunk(fixture, { day: today });
    await expect(insertTelemetryV1Chunk(db(), invalidLegacy)).rejects.toThrow();
    await expectUnavailable();
  });

  it("a hard mutation followed by an append in the same repository transaction cannot resurrect a deleted preview", async () => {
    const { fixture } = await seedInput(); await seedPublication(); const before = await control();
    const database = new Proxy(db(), { get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => (await target.batch([
        target.prepare("UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1"),
        ...statements,
      ])).slice(1);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await insertTelemetryV1Chunk(database, await prepareChunk(fixture, { sequence: 1 }));
    expect(await control()).toEqual({ mutation_epoch: before.mutation_epoch + 2,
      graph_append_epoch: before.mutation_epoch + 2, graph_invalidation_epoch: before.mutation_epoch + 1 });
    await expectUnavailable();
  });

  it.each(["stale marker", "pre-written marker", "epoch jump"])("does not let a %s disguise a hard mutation", async kind => {
    const { fixture } = await seedInput(); await seedPublication();
    if (kind === "stale marker") await insertTelemetryV1Chunk(db(), await prepareChunk(fixture, { sequence: 1 }));
    if (kind === "pre-written marker") {
      await db().prepare("UPDATE community_snapshot_mutation_control SET graph_append_epoch=mutation_epoch+1 WHERE singleton_id=1").run();
    }
    await db().prepare(kind === "epoch jump"
      ? "UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+2,graph_append_epoch=mutation_epoch+2 WHERE singleton_id=1"
      : "UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1").run();
    expect((await control()).graph_invalidation_epoch).toBe((await control()).mutation_epoch);
    await expectUnavailable();
  });

  it.each([false, true])("rolls back graph, journal, records, admission and epoch if a %s superseding batch fails", async superseding => {
    const { fixture } = await seedInput(); await seedPublication();
    const before = await control(), oldCache = await cache(), oldRevision = await revision();
    const supersedes = superseding ? await currentTelemetryV1Chunk(db(), PARTICIPANT, fixture.deviceId, "usage", DAY, 0) : null;
    const insert = await prepareChunk(fixture, { sequence: superseding ? 0 : 1, revision: superseding ? 2 : 1, supersedes });
    await db().prepare(`CREATE TRIGGER synthetic_graph_record_failure BEFORE INSERT ON telemetry_v1_records
      BEGIN SELECT RAISE(ABORT,'synthetic graph transaction failure'); END`).run();
    await expect(insertTelemetryV1Chunk(db(), insert)).rejects.toThrow("synthetic graph transaction failure");
    expect(await control()).toEqual(before); expect(await cache()).toEqual(oldCache); expect(await revision()).toBe(oldRevision);
    expect(await db().prepare("SELECT revision,superseded_at FROM telemetry_v1_chunks").all())
      .toMatchObject({ results: [{ revision: 1, superseded_at: null }] });
    expect(await db().prepare("SELECT COUNT(*) AS n FROM telemetry_v1_records").first()).toEqual({ n: 1 });
    expect(await db().prepare("SELECT accepted_count FROM telemetry_v1_chunk_admission_windows").first())
      .toEqual({ accepted_count: 1 });
    expect(await db().prepare("SELECT state FROM device_upload_authorizations WHERE id=?")
      .bind(insert.deviceUploadAuthorizationId).first()).toEqual({ state: "consuming" });
    expect(await db().prepare("SELECT COUNT(*) AS n FROM community_graph_update_scope").first()).toEqual({ n: 0 });
  });

  it.each(["before hard fence", "after current epoch"])("readers reject a snapshot epoch %s even if a faulty writer stores it", async kind => {
    await seedInput(); const published = await seedPublication();
    if (kind === "before hard fence") {
      await db().prepare("UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1").run();
    }
    const current = await control();
    await db().prepare(`INSERT OR REPLACE INTO admin_community_allowance_preview_cache
      (singleton,generated_at,payload_json,attribution_method_version,source_mutation_epoch) VALUES(1,?,?,?,?)`)
      .bind(published.value.generatedAt, published.payload, COMMUNITY_ATTRIBUTION_METHOD_VERSION,
        kind === "before hard fence" ? published.epoch : current.mutation_epoch + 1).run();
    await expect(readCachedAdminCommunityAllowancePreview(db(), NOW))
      .rejects.toMatchObject({ code: "ADMIN_ALLOWANCE_CACHE_UNAVAILABLE" });
    expect((await publicGraph()).graph).toBeNull();
  });

  it("fails both optional snapshot readers closed before migration 0049 without hiding published activity", async () => {
    await reset(); await applyD1Migrations(db(), migrations().filter(migration => migration.name < "0049_"));
    await seedPublication();
    await expect(readCachedAdminCommunityAllowancePreview(db(), NOW))
      .rejects.toMatchObject({ code: "ADMIN_ALLOWANCE_STORAGE_UNAVAILABLE" });
    const read = await publicGraph();
    expect(read.read.rows).toEqual([{ day: DAY, revision: 1, payload_json: "{}", released_at: new Date(NOW).toISOString() }]);
    expect(read.read.allowanceBreakdownsCache).toBeNull(); expect(read.graph).toBeNull();
    expect(read.read.allowanceReadState).toBe("temporarily_unavailable");
  });

  it("does not revoke or dirty analytical publication for R2 reconciliation and no-op journal updates", async () => {
    await seedInput(); await seedPublication();
    const before = await control(), priorRevision = await revision(), priorCache = await cache();
    await db().prepare("UPDATE telemetry_v1_chunks SET r2_key='synthetic/reconciled',chunk_digest=chunk_digest").run();
    expect(await control()).toEqual(before);
    expect(await revision()).toBe(priorRevision);
    expect(await cache()).toEqual(priorCache);
  });

  it("cannot preserve a correction across an unexpected hard mutation after its transaction marker", async () => {
    const { fixture } = await seedInput(); await seedPublication();
    const supersedes = await currentTelemetryV1Chunk(db(), PARTICIPANT, fixture.deviceId, "usage", DAY, 0);
    const database = new Proxy(db(), { get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        const results = await target.batch([statements[0]!,
          target.prepare("UPDATE community_snapshot_mutation_control SET mutation_epoch=mutation_epoch+1 WHERE singleton_id=1"),
          ...statements.slice(1)]);
        return [results[0]!, ...results.slice(2)];
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await insertTelemetryV1Chunk(database, await prepareChunk(fixture, { revision: 2, supersedes }));
    await expectUnavailable();
    expect((await control()).graph_invalidation_epoch).toBe((await control()).mutation_epoch);
    expect(await db().prepare("SELECT COUNT(*) AS n FROM community_graph_update_scope").first()).toEqual({ n: 0 });
  });
});

describe("preserved graph successor publisher on local D1", () => {
  it("publishes a newly completed older model day inside the 55-minute throttle without a source-epoch change", async () => {
    await seedInput(); await seedPublication(); await seedModelDay(); await warmSource();
    const source = await control();
    expect(await warmAdminCommunityAllowancePreviewCache(db(), NOW + 1_000, recovery()))
      .toEqual({ code: "ALLOWANCE_PREVIEW_CACHE_CURRENT" });
    const older = await seedModelDay({ day: "2026-09-05", reconstructed: true });
    expect(await control()).toEqual(source);
    const nextTime = NOW + 60_000;
    expect(await warmAdminCommunityAllowancePreviewCache(db(), nextTime, recovery()))
      .toEqual({ code: "ALLOWANCE_PREVIEW_CACHE_REFRESHED" });
    const next = await readCachedAdminCommunityAllowancePreview(db(), nextTime);
    expect(next.models.days.map(day => day.day)).toEqual(["2026-09-05", DAY, "2026-09-07"]);
    expect(next.models.days[0]).toEqual(older);
    expect(await cache()).toMatchObject({ generated_at: new Date(nextTime).toISOString(), source_mutation_epoch: source.mutation_epoch });
    expect(await warmAdminCommunityAllowancePreviewCache(db(), nextTime + 1_000, recovery()))
      .toEqual({ code: "ALLOWANCE_PREVIEW_CACHE_CURRENT" });
    expect(await control()).toEqual(source);
  });

  it.each(["incomplete fit cohort", "missing previously published model day"])("keeps the preview if new historical dates encounter %s", async failure => {
    await seedInput(); await seedPublication();
    if (failure === "incomplete fit cohort") await seedModelDay();
    else await warmSource();
    await seedModelDay({ day: "2026-09-05", reconstructed: true });
    const previous = await cache(), days = await modelRows(), source = await control(), graph = (await publicGraph()).graph;
    expect(await warmAdminCommunityAllowancePreviewCache(db(), NOW + 60_000, recovery()))
      .toEqual({ code: "ALLOWANCE_PREVIEW_CACHE_UNAVAILABLE" });
    expect(await cache()).toEqual(previous); expect(await modelRows()).toEqual(days); expect(await control()).toEqual(source);
    expect((await publicGraph()).graph).toEqual(graph);
  });

  it.each([
    ["outside the preview", "2026-06-01", COMMUNITY_ATTRIBUTION_METHOD_VERSION],
    ["on the still-open day", "2026-09-07", COMMUNITY_ATTRIBUTION_METHOD_VERSION],
    ["from an obsolete method", "2026-09-05", "synthetic-obsolete-attribution"],
  ])("keeps unchanged publications throttled for a date %s without needing source caches", async (_label, day, method) => {
    await seedInput(); await seedPublication(); await seedModelDay();
    await seedModelDay({ day });
    await db().prepare("UPDATE community_model_composition_days SET attribution_method_version=? WHERE day=?").bind(method, day).run();
    const previous = await cache();
    const meter = createD1InvocationBudget(2), options = recovery();
    expect(await warmAdminCommunityAllowancePreviewCache(meter.wrap(db()), NOW + 60_000, options))
      .toEqual({ code: "ALLOWANCE_PREVIEW_CACHE_CURRENT" });
    expect(meter.queriesUsed).toBe(2); expect(options.budget.remainingQueries).toBe(793);
    expect(await cache()).toEqual(previous);
  });

  it("preserves the preview when the bounded date probe fails or cannot reserve its statement", async () => {
    await seedInput(); await seedPublication(); const previous = await cache();
    let probed = false;
    const unavailable = new Proxy(db(), { get(target, property) {
      if (property === "prepare") return (sql: string) => {
        if (sql.startsWith("SELECT day FROM community_model_composition_days")) {
          probed = true; throw new Error("synthetic model-day metadata unavailable");
        }
        return target.prepare(sql);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    expect(await warmAdminCommunityAllowancePreviewCache(unavailable, NOW + 60_000, recovery()))
      .toEqual({ code: "ALLOWANCE_PREVIEW_CACHE_UNAVAILABLE" });
    expect(probed).toBe(true); expect(await cache()).toEqual(previous);
    probed = false; const options = recovery(); options.budget.remainingQueries = 6;
    expect(await warmAdminCommunityAllowancePreviewCache(unavailable, NOW + 60_000, options))
      .toEqual({ code: "ALLOWANCE_PREVIEW_CACHE_UNAVAILABLE" });
    expect(probed).toBe(false); expect(options.budget.remainingQueries).toBe(0); expect(await cache()).toEqual(previous);
  });

  it("throttles an unchanged epoch but refreshes immediately after a completed append calculation", async () => {
    const { fixture } = await seedInput(); const previous = await seedPublication(); await seedModelDay();
    await warmSource();
    expect(await warmAdminCommunityAllowancePreviewCache(db(), NOW + 1_000, recovery()))
      .toEqual({ code: "ALLOWANCE_PREVIEW_CACHE_CURRENT" });
    expect((await cache())?.generated_at).toBe(previous.value.generatedAt);
    await insertTelemetryV1Chunk(db(), await prepareChunk(fixture, { sequence: 1 }));
    const changed = await control(), nextTime = NOW + 60_000;
    expect(changed.mutation_epoch).toBe(previous.epoch + 1);
    await warmSource(nextTime);
    expect(await warmAdminCommunityAllowancePreviewCache(db(), nextTime, recovery()))
      .toEqual({ code: "ALLOWANCE_PREVIEW_CACHE_REFRESHED" });
    expect(await cache()).toMatchObject({ source_mutation_epoch: changed.mutation_epoch,
      generated_at: new Date(nextTime).toISOString() });
    const next = await readCachedAdminCommunityAllowancePreview(db(), nextTime);
    expect(next.models.days.map(day => day.day)).toEqual([DAY, "2026-09-07"]);
    expect(next.models.days[0]).toEqual(previous.value.models.days[0]);
    // These real source fixtures contain usage but no quota observations. A
    // completed calculation truthfully replaces the old scalar fit with no fit.
    expect(next.days.at(-2)?.combined).toEqual({ fitCount: 0, participantCount: 0, centralUsd: null, band80Usd: null });
    expect((await publicGraph(nextTime)).graph?.breakdowns.generatedAt).toBe(next.generatedAt);
  });

  it("does not overwrite a preserved preview when an affected historical model day is still missing", async () => {
    const { fixture } = await seedInput(); await seedPublication(); await seedModelDay({ reconstructed: true });
    const previous = await cache(), graph = (await publicGraph()).graph;
    await insertTelemetryV1Chunk(db(), await prepareChunk(fixture, { sequence: 1 }));
    expect(await modelRows()).toEqual([]); // Real input trigger invalidates this reconstructed day only.
    await warmSource(NOW + 60_000);
    expect(await warmAdminCommunityAllowancePreviewCache(db(), NOW + 60_000, recovery()))
      .toEqual({ code: "ALLOWANCE_PREVIEW_CACHE_UNAVAILABLE" });
    expect(await cache()).toEqual(previous); expect((await publicGraph()).graph).toEqual(graph);
    expect(await modelRows()).toEqual([]); // Even the prepared current-day result is not partially published.
  });

  it("publishes a complete replacement and its current model day together, including a terminal historical no-fit result", async () => {
    const { fixture } = await seedInput(); await seedPublication(); await seedModelDay({ reconstructed: true });
    await insertTelemetryV1Chunk(db(), await prepareChunk(fixture, { sequence: 1 }));
    await warmSource(NOW + 60_000);
    const terminal = await seedModelDay({ reconstructed: true, terminalNoFit: true });
    const epoch = (await control()).mutation_epoch, nextTime = NOW + 60_000;
    expect(await warmAdminCommunityAllowancePreviewCache(db(), nextTime, recovery()))
      .toEqual({ code: "ALLOWANCE_PREVIEW_CACHE_REFRESHED" });
    const cached = await cache(), next = await readCachedAdminCommunityAllowancePreview(db(), nextTime);
    expect(cached).toMatchObject({ source_mutation_epoch: epoch, generated_at: new Date(nextTime).toISOString() });
    expect(next.models.days[0]).toEqual(terminal);
    expect(next.models.days).toHaveLength(2);
    const rows = await modelRows();
    expect(rows.map(row => row.source_mutation_epoch)).toEqual([epoch, epoch]);
    expect(JSON.parse(rows[1]!.payload_json as string)).toEqual(next.models.days[1]);
    expect((await publicGraph(nextTime)).graph?.breakdowns.days[0]?.models).toEqual([]);
    expect(await warmAdminCommunityAllowancePreviewCache(db(), nextTime + 1_000, recovery()))
      .toEqual({ code: "ALLOWANCE_PREVIEW_CACHE_CURRENT" });
  });

  it("rolls back the replacement model day if final preview publication fails", async () => {
    const { fixture } = await seedInput(); await seedPublication(); await seedModelDay();
    await insertTelemetryV1Chunk(db(), await prepareChunk(fixture, { sequence: 1 })); await warmSource(NOW + 60_000);
    const previous = await cache(), priorDays = await modelRows(), source = await control();
    await db().prepare(`CREATE TRIGGER synthetic_graph_preview_failure BEFORE INSERT ON admin_community_allowance_preview_cache
      BEGIN SELECT RAISE(ABORT,'synthetic preview publication failure'); END`).run();
    expect(await warmAdminCommunityAllowancePreviewCache(db(), NOW + 60_000, recovery()))
      .toEqual({ code: "ALLOWANCE_PREVIEW_CACHE_UNAVAILABLE" });
    expect(await cache()).toEqual(previous); expect(await modelRows()).toEqual(priorDays); expect(await control()).toEqual(source);
  });

  it("an append immediately before publication fences both replacement writes while retaining the previous snapshot", async () => {
    const { fixture } = await seedInput(); await seedPublication(); await seedModelDay();
    await insertTelemetryV1Chunk(db(), await prepareChunk(fixture, { sequence: 1 })); await warmSource(NOW + 60_000);
    const racedAppend = await prepareChunk(fixture, { sequence: 2 });
    const previous = await cache(), priorDays = await modelRows(), source = await control();
    let batchCalls = 0;
    const database = new Proxy(db(), { get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        batchCalls += 1; expect(statements).toHaveLength(2);
        await insertTelemetryV1Chunk(db(), racedAppend);
        return target.batch(statements);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    expect(await warmAdminCommunityAllowancePreviewCache(database, NOW + 60_000, recovery()))
      .toEqual({ code: "ALLOWANCE_PREVIEW_CACHE_UNAVAILABLE" });
    expect(batchCalls).toBe(1); expect((await control()).mutation_epoch).toBe(source.mutation_epoch + 1);
    expect(await cache()).toEqual(previous); expect(await modelRows()).toEqual(priorDays);
    expect((await publicGraph()).graph?.breakdowns.generatedAt).toBe(new Date(NOW).toISOString());
  });
});
