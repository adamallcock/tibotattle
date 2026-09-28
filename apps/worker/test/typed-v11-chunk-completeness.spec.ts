import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { createV11DeviceFixture, makeV11Day, v11UsageRecord } from "./helpers/telemetry-v11";
import { initializeStorageSource } from "../src/analytics-delivery";
import { authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization } from "../src/device-auth";
import { sha256Hex } from "../src/crypto";
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../src/typed-v11-admission";
import { registerTelemetryV11DayManifest } from "../src/telemetry-v11-repository";
import { TYPED_V11_CHUNK_PROOF_COUNT_SQL } from "../src/typed-v11-chunk-completeness";

const b = env as Env & {
  TEST_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
};
const db = () => b.USAGE_MONITOR_DB;
const namespace = "synthetic-chunk-completeness";
const today = () => new Date().toISOString().slice(0, 10);
type Fixture = Awaited<ReturnType<typeof createV11DeviceFixture>>;
const currentSql = `SELECT chunk.id,chunk.record_count,${TYPED_V11_CHUNK_PROOF_COUNT_SQL} AS proof_count
  FROM telemetry_v11_chunks chunk WHERE chunk.id=?`;
const priorSql = currentSql.replace(TYPED_V11_CHUNK_PROOF_COUNT_SQL,
  "(SELECT count(*) FROM typed_v11_record_admissions proof WHERE proof.chunk_id=chunk.id)");

beforeEach(async () => {
  await reset();
  for (const migrations of [b.TEST_MIGRATIONS, b.TEST_TYPED_INGESTION_MIGRATIONS,
    b.TEST_INGESTION_BRIDGE_MIGRATIONS, b.TEST_TYPED_V11_ADMISSION_MIGRATIONS]) {
    await applyD1Migrations(db(), migrations);
  }
  await initializeStorageSource(db(), namespace);
  await initializeTypedV11Admission(db(), namespace);
});

async function stage(fixture: Fixture, observedDay: string, count = 1) {
  const prepared = await makeV11Day(observedDay, { usage: Array.from({ length: count }, (_, index) =>
    v11UsageRecord(observedDay, "a", { eventId: `synthetic:completeness:${observedDay}:${index}` })) });
  await registerTelemetryV11DayManifest(db(), fixture, prepared.manifest);
  const envelopeDigest = await sha256Hex(`synthetic:${crypto.randomUUID()}`);
  const principal = await authenticateDevice(db(), fixture.authorization);
  const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 200);
  const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`,
    { envelopeDigest, bodyBytes: 200, contentType: "application/json" });
  const chunkRowId = `chunk:${crypto.randomUUID()}`;
  await persistTypedV11StagedChunk(db(), fixture, prepared.chunks[0]!, {
    sourceNamespace: namespace, chunkRowId, r2Key: `synthetic/${crypto.randomUUID()}`,
    envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId,
  });
  return chunkRowId;
}

it("uses the complete physical chunk key and matches the admitted view without namespace-wide chunk scans", async () => {
  const fixture = await createV11DeviceFixture(db(), { grant: true });
  const chunkId = await stage(fixture, today(), 2);
  const before = await db().prepare(currentSql).bind(chunkId).all();
  expect(before.results).toEqual([{ id: chunkId, record_count: 2, proof_count: 2 }]);

  const unrelated = await createV11DeviceFixture(db(), { grant: true });
  for (let index = 0; index < 32; index += 1) {
    const observedDay = new Date(Date.parse(today()) - index * 86_400_000).toISOString().slice(0, 10);
    await stage(unrelated, observedDay);
  }
  const current = await db().prepare(currentSql).bind(chunkId).all();
  const prior = await db().prepare(priorSql).bind(chunkId).all();
  expect(current.results).toEqual(before.results);
  expect(current.results).toEqual(prior.results);
  // Allow the index tree to deepen as rows are added; none of the unrelated
  // chunk/proof rows should be scanned by this exact-key lookup.
  expect(current.meta.rows_read).toBeLessThanOrEqual(before.meta.rows_read + 2);
  expect(current.meta.rows_read).toBeLessThan(prior.meta.rows_read / 3);
  console.info("typed-v11-chunk-completeness-rows", {
    current: current.meta.rows_read, prior: prior.meta.rows_read, unrelatedChunks: 32,
  });

  const plan = (await db().prepare(`EXPLAIN QUERY PLAN ${currentSql}`).bind(chunkId)
    .all<{ detail: string }>()).results.map(row => row.detail);
  expect(plan).toEqual(expect.arrayContaining([
    expect.stringMatching(/SEARCH physical_chunk USING (?:COVERING )?INDEX .+ \(namespace_id=\? AND format=\? AND original_id=\?\)/u),
    expect.stringMatching(/SEARCH proof USING (?:COVERING )?INDEX typed_v11_proof_chunk \(chunk_key=\?\)/u),
  ]));
}, 30_000);

it("keeps partial and absent proof counts identical to the view and refuses to mark either complete", async () => {
  const fixture = await createV11DeviceFixture(db(), { grant: true });
  const chunkId = await stage(fixture, today(), 2);
  for (const expected of [1, 0]) {
    // These are unactivated staging proofs; the ordinary retention triggers
    // permit their removal. No source authority or trigger is bypassed.
    await db().prepare(`DELETE FROM typed_v11_record_proofs WHERE typed_record_id=(
      SELECT min(typed_record_id) FROM typed_v11_record_admissions WHERE chunk_id=?)`).bind(chunkId).run();
    const current = await db().prepare(currentSql).bind(chunkId).all();
    const prior = await db().prepare(priorSql).bind(chunkId).all();
    expect(current.results).toEqual([{ id: chunkId, record_count: 2, proof_count: expected }]);
    expect(current.results).toEqual(prior.results);
    expect(await db().prepare(`SELECT count(*) AS complete FROM telemetry_v11_chunks chunk
      WHERE chunk.id=? AND chunk.record_count=${TYPED_V11_CHUNK_PROOF_COUNT_SQL}`).bind(chunkId).first("complete")).toBe(0);
  }
  expect(await db().prepare(`WITH chunk(id) AS (SELECT 'synthetic:missing')
    SELECT ${TYPED_V11_CHUNK_PROOF_COUNT_SQL} AS proof_count FROM chunk`).first("proof_count")).toBe(0);
});
