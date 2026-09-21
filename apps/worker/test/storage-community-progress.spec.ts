import { env, reset, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_MODEL_HISTORY_CATALOG_VERSION } from "@app-usagemonitor/telemetry-contract";
import { initializeStorageSource } from "../src/analytics-delivery";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";
import { initializeTypedV11Admission } from "../src/typed-v11-admission";
import { initializeStorageAnalyticsRuntime } from "../src/storage-analytics-runtime";
import { drainCommunityPublicSourceBootstrap } from "../src/community-daily-aggregates";
import { captureStorageCommunityAuthority } from "../src/storage-community-authority";
import { parsedCachedFits } from "../src/community-allowance";
import { STORAGE_GRAPH_METHOD } from "../src/storage-community-graph";
import { ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS } from "../src/admin-community-allowance";
import { sha256Hex } from "../src/crypto";
import { readStorageCommunityProgress } from "../src/storage-community-progress";

const b = env as Env & {
  STORAGE_ANALYTICS_DB: D1Database; TEST_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[]; TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[]; TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[]; TEST_ANALYTICS_MIGRATIONS: D1Migration[];
};
const source = () => b.USAGE_MONITOR_DB, target = () => b.STORAGE_ANALYTICS_DB;
const sourceId = "synthetic-progress", sourceNamespace = "synthetic-progress";
const bindings = () => ({ source: source(), target: target(), sourceId, sourceNamespace });
const DAY_MS = 86_400_000, REQUIRED_DAYS = ADMIN_COMMUNITY_ALLOWANCE_PREVIEW_DAYS - 1;
const MAX_ADMIN_AGGREGATE_ROWS = 10_000;
// A fixed instant keeps the window, the trailing throughput hours and the
// claim leases deterministic without freezing the runtime clock.
const NOW = Date.parse("2026-06-15T12:00:00.000Z");
const today = new Date(NOW).toISOString().slice(0, 10);
const back = (offset: number) => new Date(NOW - offset * DAY_MS).toISOString().slice(0, 10);
/** Synthetic, content-free owner pseudonyms. No real digest is ever used. */
const owner = (ordinal: number) => ordinal.toString(16).padStart(64, "0");
const hex = (seed: string) => seed.padEnd(64, "0").slice(0, 64);

beforeEach(async () => {
  await reset();
  for (const migrations of [b.TEST_MIGRATIONS, b.TEST_TYPED_INGESTION_MIGRATIONS, b.TEST_INGESTION_BRIDGE_MIGRATIONS,
    b.TEST_TYPED_V11_ADMISSION_MIGRATIONS, b.TEST_TYPED_V1_ADMISSION_MIGRATIONS,
    b.TEST_INGESTION_ISOLATION_MIGRATIONS]) await applyD1Migrations(source(), migrations);
  await applyD1Migrations(target(), b.TEST_ANALYTICS_MIGRATIONS);
  await initializeStorageSource(source(), sourceId);
  await initializeTypedV11Admission(source(), sourceNamespace);
  await initializeTypedV1Admission(source(), sourceNamespace);
  await initializeStorageAnalyticsRuntime(bindings());
  expect((await drainCommunityPublicSourceBootstrap(source())).completed).toBe(true);
});

async function activeOwners(total: number) {
  for (let ordinal = 1; ordinal <= total; ordinal++) {
    await target().prepare(`INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state)
      VALUES(?,?,1,1,'active')`).bind(sourceId, owner(ordinal)).run();
  }
}
async function withdrawOwner(ordinal: number) {
  await target().prepare("UPDATE analytics_owner_state SET state='withdrawn' WHERE source_id=? AND owner_digest=?")
    .bind(sourceId, owner(ordinal)).run();
}
async function result(input: {
  ordinal: number; metric: "model" | "fits"; day: string; payload: unknown;
  method?: string; computedMs?: number;
}) {
  const payload = JSON.stringify(input.payload);
  await target().prepare(`INSERT INTO analytics_community_graph_results(source_id,owner_digest,metric,day,method,
    dependency_digest,input_revision,payload_fingerprint,payload_json,payload_sha256,authority_json,computed_ms,source_kind)
    VALUES(?,?,?,?,?,?,1,?,?,?,'{}',?,'v1.1')`)
    .bind(sourceId, owner(input.ordinal), input.metric, input.day, input.method ?? STORAGE_GRAPH_METHOD,
      hex("d"), hex("f"), payload, await sha256Hex(payload), input.computedMs ?? NOW).run();
}
/** One recursive statement so a cap test does not cost 10k round trips. */
async function bulkResults(input: { total: number; method: string; computedMs: number }) {
  await target().prepare(`INSERT INTO analytics_community_graph_results(source_id,owner_digest,metric,day,method,
    dependency_digest,input_revision,payload_fingerprint,payload_json,payload_sha256,authority_json,computed_ms,source_kind)
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?2)
    SELECT ?1,printf('%064x',i),'model','2000-01-01',?3,?4,1,?4,'{"status":"ready"}',?4,'{}',?5,'v1.1' FROM n`)
    .bind(sourceId, input.total, input.method, hex("b"), input.computedMs).run();
}
const readyModel = (day: string) => ({ status: "ready", planType: "pro", day });
const refusal = (reason: string) => ({ status: "not_testable", reason, tracks: [] });
const unsupported = () => ({ status: "unsupported_source", reason: "legacy_source_overlap" });
/** A current fit is persisted as the selected-fit ARRAY, never a status
 * document: each element embeds the owner digest, so an empty array is the
 * only observable form of "analysed, no usable fit". */
const readyFits = (ordinal: number) => [{
  participantId: owner(ordinal), planType: "pro", capacityNanousd: 1_000_000,
  lastObservedAt: new Date(NOW - 3_600_000).toISOString(),
}];
const noFits = () => [] as const;

async function publishDay(day: string) {
  const payload = JSON.stringify({
    day, catalogVersion: ADMIN_MODEL_HISTORY_CATALOG_VERSION, values: [],
    fittedParticipantCount: 0, unstableParticipantCount: 0, staleParticipantCount: 0,
    refusedParticipantCount: 0, v1ParticipantCount: 0, unsupportedSourceParticipantCount: 0,
  });
  const authority = await captureStorageCommunityAuthority(source(), bindings());
  await target().prepare(`INSERT INTO analytics_community_model_publications(source_id,day,revision,method,
    cohort_digest,authority_json,payload_json,payload_sha256,computed_ms) VALUES(?,?,1,?,?,?,?,?,?)`)
    .bind(sourceId, day, STORAGE_GRAPH_METHOD, hex("c"), JSON.stringify(authority), payload,
      await sha256Hex(payload), Date.parse(`${day}T03:00:00.000Z`)).run();
}
async function selection(input: {
  ordinal: number; day: string; metric: "model" | "fits"; state: "pending" | "claimed" | "complete";
  claimExpiresMs?: number; updatedMs?: number;
}) {
  const claimed = input.state === "claimed";
  await target().prepare(`INSERT INTO analytics_community_graph_work_selection(source_id,owner_digest,day,metric,
    authority_epoch,selection_revision,state,envelope_json,envelope_sha256,claim_token,claim_expires_ms,created_ms,updated_ms)
    VALUES(?,?,?,?,1,1,?,'{}',?,?,?,?,?)`)
    .bind(sourceId, owner(input.ordinal), input.day, input.metric, input.state, hex("e"),
      claimed ? "synthetic-claim-token" : null, claimed ? input.claimExpiresMs ?? NOW + 60_000 : null,
      NOW - 1_000, input.updatedMs ?? NOW - 1_000).run();
}
/** Stage, fill and promote one generation so it is a resumable in-flight head. */
async function checkpoint(input: { ordinal: number; day: string; control: unknown; parts: number[] }) {
  const keyDigest = hex(`k${input.ordinal}${input.day}`), generation = `g-${input.ordinal}-${input.day}`;
  await stageCheckpoint({ keyDigest, generation, ordinal: input.ordinal, day: input.day,
    control: input.control, partCount: input.parts.length });
  for (const [index, bytes] of input.parts.entries()) {
    const payload = `[${"0".repeat(Math.max(bytes - 2, 0))}]`;
    await target().prepare(`INSERT INTO analytics_history_checkpoint_parts(key_digest,generation,part_index,sha256,
      payload_bytes,payload_json) VALUES(?,?,?,?,?,?)`)
      .bind(keyDigest, generation, index, hex("a"), payload.length, payload).run();
  }
  await promoteCheckpoint(keyDigest, generation);
}
async function stageCheckpoint(input: {
  keyDigest: string; generation: string; ordinal: number; day: string; control: unknown; partCount: number;
}) {
  await target().prepare(`INSERT INTO analytics_history_checkpoint_stages(key_digest,generation,source_id,owner_digest,
    day,dependency_digest,source_namespace,method,expected_head,owner_revision,authority_epoch,control_json,manifest_json,part_count)
    VALUES(?,?,?,?,?,?,?,?,NULL,1,1,?,'[]',?)`)
    .bind(input.keyDigest, input.generation, sourceId, owner(input.ordinal), input.day, hex("d"), sourceNamespace,
      STORAGE_GRAPH_METHOD, JSON.stringify(input.control), input.partCount).run();
}
const promoteCheckpoint = (keyDigest: string, generation: string) => target()
  .prepare("INSERT INTO analytics_history_checkpoint_heads(key_digest,generation,retired) VALUES(?,?,0)")
  .bind(keyDigest, generation).run();
const progress = () => readStorageCommunityProgress(bindings(), NOW, { includePreparation: true });

describe("typed storage community progress", () => {
  it("reports an empty source as an idle, fully missing window", async () => {
    const result = await progress();
    expect(result.schemaVersion).toBe(3);
    expect(result.preparation).toBeNull();
    expect(result.work).toMatchObject({ state: "idle", trigger: null, restartReason: null });
    expect(result.graph.window).toEqual({ days: REQUIRED_DAYS, from: back(REQUIRED_DAYS), to: back(1) });
    expect(result.graph.days).toHaveLength(REQUIRED_DAYS);
    expect(result.graph.owners.active).toBe(0);
    expect(result.graph.currentFits).toEqual({ day: today, ready: 0, noFit: 0, missing: 0 });
    expect(result.graph.work.checkpoints).toEqual({ stages: 0, parts: 0, bytes: 0, phases: [] });
    expect(result.graph.throughput).toEqual({ resultsLastHour: 0, resultsLast6Hours: 0,
      remainingResults: 0, estimatedHoursRemaining: null });
    expect(result.graph.retirement.staleResults).toBe(0);
    expect(result.history).toMatchObject({ requiredAccounts: 0, completeAccounts: 0 });
  });

  it("separates published, complete-unpublished, partial, unsupported and missing days", async () => {
    await activeOwners(3);
    for (const ordinal of [1, 2, 3]) await result({ ordinal, metric: "model", day: back(1), payload: readyModel(back(1)) });
    await publishDay(back(1));
    for (const ordinal of [1, 2]) await result({ ordinal, metric: "model", day: back(2), payload: readyModel(back(2)) });
    await result({ ordinal: 3, metric: "model", day: back(2), payload: refusal("usage_day_limit_exceeded") });
    await result({ ordinal: 1, metric: "model", day: back(3), payload: readyModel(back(3)) });
    // A legacy/overlap owner is not composable at all: it is neither a ready
    // composition nor an analytical refusal.
    await result({ ordinal: 2, metric: "model", day: back(3), payload: unsupported() });

    const graph = (await progress()).graph;
    expect(graph.owners.active).toBe(3);
    expect(graph.days.slice(0, 4)).toEqual([
      { day: back(1), ready: 3, refused: 0, unsupported: 0, missing: 0, published: true,
        publishedAt: new Date(Date.parse(`${back(1)}T03:00:00.000Z`)).toISOString() },
      { day: back(2), ready: 2, refused: 1, unsupported: 0, missing: 0, published: false, publishedAt: null },
      { day: back(3), ready: 1, refused: 0, unsupported: 1, missing: 1, published: false, publishedAt: null },
      { day: back(4), ready: 0, refused: 0, unsupported: 0, missing: 3, published: false, publishedAt: null },
    ]);
    for (const day of graph.days) {
      expect(day.ready + day.refused + day.unsupported + day.missing).toBe(graph.owners.active);
    }
    expect(graph.days.filter((day) => day.published)).toHaveLength(1);
    expect(graph.work.state).toBe("queued");
  });

  it("ignores results whose owner is no longer active", async () => {
    await activeOwners(2);
    for (const ordinal of [1, 2]) await result({ ordinal, metric: "model", day: back(1), payload: readyModel(back(1)) });
    await withdrawOwner(2);
    const graph = (await progress()).graph;
    expect(graph.owners.active).toBe(1);
    expect(graph.days[0]).toMatchObject({ day: back(1), ready: 1, refused: 0, unsupported: 0, missing: 0 });
    for (const day of graph.days) expect(day.ready + day.refused + day.unsupported + day.missing).toBe(1);
  });

  it("buckets current fits by selected-fit array length, not by a status field", async () => {
    await activeOwners(4);
    await result({ ordinal: 1, metric: "fits", day: today, payload: readyFits(1) });
    // A refused or unusable current analysis is persisted as the empty array.
    await result({ ordinal: 2, metric: "fits", day: today, payload: noFits() });
    // The stored ready payload is exactly what the shared parser accepts.
    const stored = await target().prepare("SELECT payload_json FROM analytics_community_graph_results WHERE metric='fits' AND owner_digest=?")
      .bind(owner(1)).first<{ payload_json: string }>();
    expect(parsedCachedFits(stored!.payload_json, owner(1))).toHaveLength(1);

    const graph = (await progress()).graph;
    expect(graph.currentFits).toEqual({ day: today, ready: 1, noFit: 1, missing: 2 });
    expect(graph.currentFits.ready + graph.currentFits.noFit + graph.currentFits.missing).toBe(graph.owners.active);
  });

  it("counts the active history day against every non-missing model bucket", async () => {
    await activeOwners(4);
    await result({ ordinal: 1, metric: "model", day: back(1), payload: readyModel(back(1)) });
    await result({ ordinal: 2, metric: "model", day: back(1), payload: refusal("usage_cost_limit_exceeded") });
    await result({ ordinal: 3, metric: "model", day: back(1), payload: unsupported() });
    const history = (await progress()).history;
    expect(history).toMatchObject({ activeDay: back(1), completeAccounts: 3, requiredAccounts: 4 });
  });

  it("counts distinct refusing owners per closed model reason and folds an unknown reason into other", async () => {
    await activeOwners(4);
    // The same owner refusing on two days is one owner for that reason.
    for (const day of [back(1), back(2)]) {
      await result({ ordinal: 1, metric: "model", day, payload: refusal("usage_day_limit_exceeded") });
    }
    await result({ ordinal: 2, metric: "model", day: back(1), payload: refusal("usage_day_limit_exceeded") });
    await result({ ordinal: 3, metric: "model", day: back(1), payload: refusal("invented_reason_not_in_vocabulary") });
    // The same owner under a second unknown reason is still one owner in `other`.
    await result({ ordinal: 3, metric: "model", day: back(3), payload: refusal("another_invented_reason") });
    await result({ ordinal: 4, metric: "model", day: back(2), payload: refusal("another_invented_reason") });
    // Fits carry no reason and never enter the refusal aggregate.
    await result({ ordinal: 1, metric: "fits", day: today, payload: noFits() });
    // A refusal outside the window is not counted.
    await result({ ordinal: 2, metric: "model", day: back(REQUIRED_DAYS + 5),
      payload: refusal("usage_cost_limit_exceeded") });

    const graph = (await progress()).graph;
    // Ties sort by reason ascending, so `other` precedes the closed code.
    expect(graph.refusals).toEqual([
      { owners: 2, reason: "other" },
      { owners: 2, reason: "usage_day_limit_exceeded" },
    ]);
    for (const entry of graph.refusals) expect(entry.owners).toBeLessThanOrEqual(graph.owners.active);
  });

  it("separates building, queued and idle work by live claims", async () => {
    await activeOwners(1);
    for (let offset = 1; offset <= REQUIRED_DAYS; offset++) {
      await result({ ordinal: 1, metric: "model", day: back(offset), payload: readyModel(back(offset)) });
    }
    await result({ ordinal: 1, metric: "fits", day: today, payload: readyFits(1) });
    const idle = (await progress()).graph;
    expect(idle.throughput.remainingResults).toBe(0);
    expect(idle.work).toMatchObject({ state: "idle", activeDay: null, activeMetric: null,
      leaseExpiresAt: null, selections: { pending: 0, claimed: 0 } });

    await selection({ ordinal: 1, day: back(1), metric: "model", state: "claimed", claimExpiresMs: NOW - 1 });
    const expired = (await progress()).graph;
    expect(expired.work).toMatchObject({ state: "idle", activeDay: null, activeMetric: null,
      leaseExpiresAt: null, selections: { pending: 0, claimed: 1 } });

    await target().prepare("DELETE FROM analytics_community_graph_work_selection").run();
    await selection({ ordinal: 1, day: back(2), metric: "fits", state: "pending" });
    const queued = (await progress()).graph;
    expect(queued.work).toMatchObject({ state: "queued", activeDay: back(2), activeMetric: "fits",
      leaseExpiresAt: null, selections: { pending: 1, claimed: 0 } });

    await target().prepare("DELETE FROM analytics_community_graph_work_selection").run();
    await selection({ ordinal: 1, day: back(3), metric: "model", state: "claimed",
      claimExpiresMs: NOW + 90_000, updatedMs: NOW - 10 });
    const building = await progress();
    expect(building.work.state).toBe("building");
    expect(building.graph.work).toMatchObject({ state: "building", activeDay: back(3), activeMetric: "model",
      leaseExpiresAt: new Date(NOW + 90_000).toISOString(), selections: { pending: 0, claimed: 1 } });
  });

  it("prefers the newest live claim over an older pending selection", async () => {
    await activeOwners(2);
    await selection({ ordinal: 1, day: back(9), metric: "model", state: "pending", updatedMs: NOW - 90_000 });
    await selection({ ordinal: 2, day: back(4), metric: "fits", state: "claimed",
      claimExpiresMs: NOW + 5_000, updatedMs: NOW - 5 });
    const work = (await progress()).graph.work;
    expect(work).toMatchObject({ state: "building", activeDay: back(4), activeMetric: "fits",
      selections: { pending: 1, claimed: 1 } });
  });

  it("aggregates in-flight checkpoint phases and maps an unknown phase to other", async () => {
    await activeOwners(3);
    await checkpoint({ ordinal: 1, day: back(1), parts: [64, 128],
      control: { version: 1, phase: "acquisition", acquisition: { phase: "clusters" } } });
    await checkpoint({ ordinal: 2, day: back(2), parts: [32],
      control: { version: 1, phase: "acquisition", acquisition: { phase: "clusters" } } });
    await checkpoint({ ordinal: 3, day: back(3), parts: [16, 16, 16, 16],
      control: { version: 1, phase: "usage", usage: {} } });
    await checkpoint({ ordinal: 1, day: back(4), parts: [8],
      control: { version: 1, phase: "teleportation", acquisition: null } });

    const checkpoints = (await progress()).graph.work.checkpoints!;
    expect(checkpoints.stages).toBe(4);
    expect(checkpoints.parts).toBe(8);
    expect(checkpoints.bytes).toBe(64 + 128 + 32 + 16 * 4 + 8);
    expect(checkpoints.phases).toEqual([
      { phase: "usage", stages: 1, parts: 4 },
      { phase: "clusters", stages: 2, parts: 3 },
      { phase: "other", stages: 1, parts: 1 },
    ]);
    expect(checkpoints.phases.reduce((sum, entry) => sum + entry.parts, 0)).toBe(checkpoints.parts);
    expect(checkpoints.phases.reduce((sum, entry) => sum + entry.stages, 0)).toBe(checkpoints.stages);
  });

  it("excludes retired and superseded checkpoint generations", async () => {
    await activeOwners(1);
    await checkpoint({ ordinal: 1, day: back(1), parts: [64], control: { version: 1, phase: "finish" } });
    expect((await progress()).graph.work.checkpoints!.stages).toBe(1);
    await target().prepare("UPDATE analytics_history_checkpoint_heads SET retired=1,generation=NULL").run();
    expect((await progress()).graph.work.checkpoints).toEqual({ stages: 0, parts: 0, bytes: 0, phases: [] });
  });

  it("reports an uncounted checkpoint census as null instead of an understated size", async () => {
    await activeOwners(1);
    const partsPerStage = 1_024;
    for (let stage = 0; stage <= Math.floor(MAX_ADMIN_AGGREGATE_ROWS / partsPerStage); stage++) {
      const keyDigest = hex(`bulk${stage}`), generation = `bulk-${stage}`;
      await stageCheckpoint({ keyDigest, generation, ordinal: 1, day: back(stage + 1),
        control: { version: 1, phase: "finish" }, partCount: partsPerStage });
      await target().prepare(`INSERT INTO analytics_history_checkpoint_parts(key_digest,generation,part_index,
        sha256,payload_bytes,payload_json)
        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<?3)
        SELECT ?1,?2,i,?4,2,'[]' FROM n`)
        .bind(keyDigest, generation, partsPerStage - 1, hex("a")).run();
      await promoteCheckpoint(keyDigest, generation);
    }
    const graph = (await progress()).graph;
    expect(graph.work.checkpoints).toBeNull();
    // An uncounted display block never takes the rest of the panel down.
    expect(graph.owners.active).toBe(1);
    expect(graph.work.state).toBe("queued");
  });

  it("measures throughput over the trailing hours and leaves the estimate null without evidence", async () => {
    await activeOwners(2);
    await result({ ordinal: 1, metric: "model", day: back(1), payload: readyModel(back(1)), computedMs: NOW - 10_000 });
    await result({ ordinal: 2, metric: "model", day: back(1), payload: readyModel(back(1)), computedMs: NOW - 10_000 });
    await result({ ordinal: 1, metric: "fits", day: today, payload: readyFits(1), computedMs: NOW - 3 * 3_600_000 });
    // Older than six hours: outside both windows.
    await result({ ordinal: 2, metric: "fits", day: today, payload: noFits(), computedMs: NOW - 9 * 3_600_000 });

    const throughput = (await progress()).graph.throughput;
    expect(throughput.resultsLastHour).toBe(2);
    expect(throughput.resultsLast6Hours).toBe(3);
    // 68 model days x 2 owners still missing; current fits are complete.
    expect(throughput.remainingResults).toBe((REQUIRED_DAYS - 1) * 2);
    expect(throughput.estimatedHoursRemaining)
      .toBe(Math.round(throughput.remainingResults / (3 / 6) * 10) / 10);

    await target().prepare("UPDATE analytics_community_graph_results SET computed_ms=?")
      .bind(NOW - 48 * 3_600_000).run();
    const stale = (await progress()).graph.throughput;
    expect(stale).toMatchObject({ resultsLastHour: 0, resultsLast6Hours: 0, estimatedHoursRemaining: null });
  });

  it("reports uncounted throughput as null rather than a smaller rate", async () => {
    await activeOwners(1);
    await bulkResults({ total: MAX_ADMIN_AGGREGATE_ROWS + 1, method: STORAGE_GRAPH_METHOD, computedMs: NOW - 60_000 });
    const graph = (await progress()).graph;
    expect(graph.throughput.resultsLastHour).toBeNull();
    expect(graph.throughput.resultsLast6Hours).toBeNull();
    expect(graph.throughput.estimatedHoursRemaining).toBeNull();
    expect(graph.throughput.remainingResults).toBeGreaterThan(0);
    expect(graph.retirement.staleResults).toBe(0);
  });

  it("counts results left behind by a method change as stale, not as coverage", async () => {
    await activeOwners(2);
    await result({ ordinal: 1, metric: "model", day: back(1), payload: readyModel(back(1)) });
    await result({ ordinal: 2, metric: "model", day: back(1), payload: readyModel(back(1)),
      method: `${STORAGE_GRAPH_METHOD}:superseded` });
    const graph = (await progress()).graph;
    expect(graph.retirement.staleResults).toBe(1);
    expect(graph.days[0]).toMatchObject({ day: back(1), ready: 1, refused: 0, unsupported: 0, missing: 1 });
    expect(graph.throughput.resultsLast6Hours).toBe(1);
  });

  it("reports an uncounted stale-result census as null", async () => {
    await activeOwners(1);
    await bulkResults({ total: MAX_ADMIN_AGGREGATE_ROWS + 1, method: `${STORAGE_GRAPH_METHOD}:superseded`,
      computedMs: NOW - 60_000 });
    const graph = (await progress()).graph;
    expect(graph.retirement.staleResults).toBeNull();
    expect(graph.throughput.resultsLast6Hours).toBe(0);
    expect(graph.owners.active).toBe(1);
  });

  it("keeps the serialized payload free of owner digests and participant identifiers", async () => {
    await activeOwners(2);
    await result({ ordinal: 1, metric: "model", day: back(1), payload: readyModel(back(1)) });
    // A ready fits payload embeds the owner digest in every selected fit.
    await result({ ordinal: 2, metric: "fits", day: today, payload: readyFits(2) });
    await selection({ ordinal: 2, day: back(1), metric: "model", state: "claimed" });
    await checkpoint({ ordinal: 1, day: back(1), parts: [32], control: { version: 1, phase: "finish" } });
    await publishDay(back(1));

    const serialized = JSON.stringify(await progress());
    for (const ordinal of [1, 2]) expect(serialized).not.toContain(owner(ordinal));
    expect(serialized).not.toContain("owner_digest");
    expect(serialized).not.toContain("participantId");
    expect(serialized).not.toContain("payload_json");
    expect(serialized).not.toContain("envelope");
    expect(serialized).not.toContain("claim_token");
  });

  it("refuses rather than reporting a cohort smaller than its own retained results", async () => {
    await activeOwners(1);
    await result({ ordinal: 1, metric: "model", day: back(1), payload: readyModel(back(1)) });
    // A cohort that shrinks below its retained coverage is an unavailable
    // census, never a negative or silently clamped missing count.
    await target().prepare(`UPDATE analytics_community_graph_results SET owner_digest=?
      WHERE owner_digest=?`).bind(owner(2), owner(1)).run();
    await target().prepare(`INSERT INTO analytics_owner_state(source_id,owner_digest,revision,authority_epoch,state)
      VALUES(?,?,1,1,'active')`).bind(sourceId, owner(2)).run();
    await target().prepare("DELETE FROM analytics_owner_state WHERE owner_digest=?").bind(owner(1)).run();
    expect((await progress()).graph.days[0]).toMatchObject({ ready: 1, missing: 0 });
    await target().prepare("UPDATE analytics_owner_state SET state='withdrawn' WHERE owner_digest=?")
      .bind(owner(2)).run();
    // The result now belongs to no active owner, so it stops being counted
    // instead of pushing `missing` negative.
    expect((await progress()).graph.days[0]).toMatchObject({ ready: 0, refused: 0, unsupported: 0, missing: 0 });
  });
});
