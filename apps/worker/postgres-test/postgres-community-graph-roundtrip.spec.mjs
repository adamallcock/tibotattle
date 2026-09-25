import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import {
  publishPostgresCommunityModelDay,
  readPostgresCommunityModelDay,
} from "../src/postgres-community-graph.ts";
import { V11_PLAN_ATTRIBUTION_ADAPTER_VERSION } from "../src/quota-analysis-v11.ts";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "5432");
const SOURCE_ID = "synthetic-community-source";
const SOURCE_NAMESPACE = "synthetic-community-namespace";
const OWNER_DIGEST = "f".repeat(64);
const PARTICIPANT_ID = "synthetic-community-participant";
const OTHER_OWNER_DIGEST = "e".repeat(64);
const OTHER_PARTICIPANT_ID = "synthetic-community-participant-2";
const DAY = "2026-09-23";
const FINGERPRINT = "a".repeat(64);
const NOW = Date.now();

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65535);
  const link = await lstat(PG_TEST_SOCKET);
  const resolved = await realpath(PG_TEST_SOCKET);
  const metadata = await stat(resolved);
  assert.equal(link.isSymbolicLink(), false);
  assert.ok(resolved.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  return { host: resolved, port: PG_TEST_PORT };
}

function readyComposition(fingerprint) {
  return {
    status: "ready",
    planType: "pro",
    fit: {
      status: "fitted",
      observationCount: 30,
      totalCostUsd: 120,
      modelCostShares: { "gpt-6-astra": 1 },
      capacityUsdByModel: { "gpt-6-astra": 1000 },
      singleConstantUsd: 1000,
      r2: 0.99,
      singleConstantR2: 0.5,
      solverConverged: true,
      identification: {
        adjustedR2: 0.98,
        singleConstantAdjustedR2: 0.4,
        splitHalfIdentified: true,
        splitHalfMaxCapacityDriftFraction: 0,
      },
    },
    voidedBinCount: 0,
    poolCount: 1,
    quotaRowCount: 31,
    usageEventCount: 30,
    unpricedUsageEventCount: 0,
    poisonedBinCount: 0,
    latestQuotaObservedAt: "2026-09-22T12:00:00.000Z",
    attributionStatus: "legacy_conditional",
    attributionMethod: V11_PLAN_ATTRIBUTION_ADAPTER_VERSION,
    inputFingerprint: fingerprint,
  };
}

describe.skipIf(!PG_TEST_SOCKET)("PostgreSQL community graph publication fences", () => {
  let pool;
  let schema;
  let sqlSchema;

  beforeAll(async () => {
    const socket = await localSocket();
    pool = new pg.Pool({
      ...socket,
      user: process.env.PG_TEST_USER || "postgres",
      password: process.env.PG_TEST_PASSWORD || "synthetic-local-only",
      database: process.env.PG_TEST_DATABASE || "postgres",
      application_name: "pg-community-graph-test",
      ssl: false,
      max: 4,
      connectionTimeoutMillis: 5_000,
    });
    const locality = await pool.query("SELECT inet_server_addr() AS address, version() AS version");
    assert.equal(locality.rows[0]?.address, null, "qualification requires a local Unix socket");
    assert.match(locality.rows[0]?.version ?? "", /^PostgreSQL 17\./u);
  }, 120_000);

  beforeEach(async () => {
    schema = `pcg_${randomBytes(6).toString("hex")}`;
    sqlSchema = `"${schema}"`;
    await pool.query(`CREATE SCHEMA ${sqlSchema}`);
    await applyPostgresMigrations({ role: "primary", schema, pool });
  }, 120_000);

  afterEach(async () => {
    if (schema) await pool.query(`DROP SCHEMA IF EXISTS ${sqlSchema} CASCADE`);
    schema = undefined;
    sqlSchema = undefined;
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function seedOwner() {
    await pool.query(`INSERT INTO ${sqlSchema}.storage_source_state(singleton, source_id, authority_epoch)
      VALUES (1, $1, 0)`, [SOURCE_ID]);
    await pool.query(`INSERT INTO ${sqlSchema}.analytics_source_cursors(source_id, sequence, authority_epoch)
      VALUES ($1, 0, 0)`, [SOURCE_ID]);
    await pool.query(`UPDATE ${sqlSchema}.publication_state SET publication_state='ready' WHERE singleton=1`);
    await pool.query(`UPDATE ${sqlSchema}.collection_controls SET revision=revision+1, control_state='operational',
      enrollment_enabled=true, upload_registration_enabled=true, processing_enabled=true,
      publication_enabled=true, reason_code=NULL, updated_at=clock_timestamp() WHERE singleton=1`);
    await pool.query(`INSERT INTO ${sqlSchema}.participants(id, owner_kind, state, created_at)
      VALUES ($1, 'social', 'active', clock_timestamp())`, [PARTICIPANT_ID]);
    await pool.query(`INSERT INTO ${sqlSchema}.analytics_owner_state(source_id, owner_digest, revision, authority_epoch, state)
      VALUES ($1, $2, 1, 0, 'active')`, [SOURCE_ID, OWNER_DIGEST]);
    await pool.query(`INSERT INTO ${sqlSchema}.storage_v11_owner_links(participant_id, owner_digest, state)
      VALUES ($1, $2, 'active')`, [PARTICIPANT_ID, OWNER_DIGEST]);
    await writeResult(FINGERPRINT, 0, 1);
  }

  async function seedOtherOwner() {
    await pool.query(`INSERT INTO ${sqlSchema}.participants(id, owner_kind, state, created_at)
      VALUES ($1, 'social', 'active', clock_timestamp())`, [OTHER_PARTICIPANT_ID]);
    await pool.query(`INSERT INTO ${sqlSchema}.analytics_owner_state(source_id, owner_digest, revision, authority_epoch, state)
      VALUES ($1, $2, 1, 0, 'active')`, [SOURCE_ID, OTHER_OWNER_DIGEST]);
    await pool.query(`INSERT INTO ${sqlSchema}.storage_v11_owner_links(participant_id, owner_digest, state)
      VALUES ($1, $2, 'active')`, [OTHER_PARTICIPANT_ID, OTHER_OWNER_DIGEST]);
  }

  async function writeResult(fingerprint, inputRevision, ownerRevision, sequence = 0, ownerDigest = OWNER_DIGEST) {
    const payload = JSON.stringify(readyComposition(fingerprint));
    const payloadHash = createHash("sha256").update(payload).digest("hex");
    await pool.query(`INSERT INTO ${sqlSchema}.analytics_owner_results(
      source_id, source_namespace, observed_day, metric, owner_digest, input_revision,
      owner_revision, authority_epoch, public_authority_epoch, source_epoch, sequence,
      method, status, reason, payload_json, payload_sha256, computed_at_ms
    ) VALUES ($1, $2, $3::date, 'model', $4, $5, $6, 0, 0, 0, $7, $8, 'ready', NULL, $9, $10,
      floor(extract(epoch FROM clock_timestamp())*1000)::bigint)`, [
      SOURCE_ID, SOURCE_NAMESPACE, DAY, ownerDigest, inputRevision, ownerRevision, sequence,
      V11_PLAN_ATTRIBUTION_ADAPTER_VERSION, payload, payloadHash,
    ]);
  }

  function member(sourceKind = "effective", fingerprint = FINGERPRINT, inputRevision = 0, ownerRevision = 1,
    ownerDigest = OWNER_DIGEST, participantId = PARTICIPANT_ID) {
    return {
      participantId,
      ownerDigest,
      inputRevision,
      ownerRevision,
      authorityEpoch: 0,
      sourceKind,
      ...(sourceKind === "effective" || sourceKind === "v1.1" || sourceKind === "v1"
        ? { inputFingerprint: fingerprint } : {}),
    };
  }

  const sourcePin = {
    sourceId: SOURCE_ID,
    sourceNamespace: SOURCE_NAMESPACE,
    sourceAuthorityEpoch: 0,
    analyticsAuthorityEpoch: 0,
    sequence: 0,
  };

  async function waitForLockedQuery(fragment, applicationName = "pg-community-graph-test") {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE application_name = $1 AND wait_event_type = 'Lock'
          AND position($2 in query) > 0 LIMIT 1`, [applicationName, fragment]);
      if (waiting.rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`Expected ${applicationName} to wait on ${fragment}`);
  }

  it("keeps the last completed generation through ordinary input and opt-out", async () => {
    await seedOwner();
    const pin = { ...sourcePin };

    await pool.query(`INSERT INTO ${sqlSchema}.storage_ingestion_changes(
      source_id, sequence, event_digest, owner_digest, owner_revision, authority_epoch, kind, recorded_ms
    ) VALUES ($1,1,$2,$3,1,0,'source-updated',$4)`, [SOURCE_ID, "c".repeat(64), OWNER_DIGEST, NOW]);
    expect(await publishPostgresCommunityModelDay(pool, { sourcePin: pin, members: [member()], day: DAY, nowMs: NOW, schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" } }))
      .toMatchObject({ state: "deferred", reason: "source_changed", memberCount: 1 });
    await pool.query(`DELETE FROM ${sqlSchema}.storage_ingestion_changes WHERE source_id=$1`, [SOURCE_ID]);

    const first = await publishPostgresCommunityModelDay(pool, {
      sourcePin: pin, members: [member()], day: DAY, nowMs: NOW,
      schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" },
    });
    expect(first).toMatchObject({ state: "published", memberCount: 1 });
    const firstGeneration = first.generation;
    expect(await readPostgresCommunityModelDay(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE, day: DAY,
      schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" },
    })).toMatchObject({ day: DAY, fittedParticipantCount: 1, values: [["gpt-6-astra", 1000, 1]] });

    expect(await publishPostgresCommunityModelDay(pool, {
      sourcePin: pin, members: [member()], day: DAY, nowMs: NOW + 1,
      schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" },
    })).toMatchObject({ state: "unchanged", generation: firstGeneration });

    await pool.query(`UPDATE ${sqlSchema}.input_versions SET revision=1 WHERE participant_id=$1`, [PARTICIPANT_ID]);
    await pool.query(`UPDATE ${sqlSchema}.analytics_owner_state SET revision=2 WHERE source_id=$1 AND owner_digest=$2`, [SOURCE_ID, OWNER_DIGEST]);
    await pool.query(`INSERT INTO ${sqlSchema}.storage_ingestion_changes(
      source_id, sequence, event_digest, owner_digest, owner_revision, authority_epoch, kind, recorded_ms
    ) VALUES ($1,1,$2,$3,2,0,'source-updated',$4)`, [SOURCE_ID, "d".repeat(64), OWNER_DIGEST, NOW + 1]);
    // The source has accepted newer input, but analytics delivery and graph
    // replacement are still pending. Exact user opt-out keeps the accepted
    // owner link active; it is not a public-history withdrawal.
    const link = await pool.query(`SELECT state FROM ${sqlSchema}.storage_v11_owner_links WHERE owner_digest=$1`, [OWNER_DIGEST]);
    expect(link.rows[0]?.state).toBe("active");
    expect(await readPostgresCommunityModelDay(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE, day: DAY,
      schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" },
    })).toMatchObject({ day: DAY, fittedParticipantCount: 1, values: [["gpt-6-astra", 1000, 1]] });
    expect(await publishPostgresCommunityModelDay(pool, {
      sourcePin: pin, members: [member()], day: DAY, nowMs: NOW + 2,
      schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" },
    })).toMatchObject({ state: "deferred", reason: "source_changed" });

    await pool.query(`UPDATE ${sqlSchema}.analytics_source_cursors SET sequence=1 WHERE source_id=$1`, [SOURCE_ID]);
    const nextFingerprint = "b".repeat(64);
    await pool.query(`DELETE FROM ${sqlSchema}.analytics_owner_results
      WHERE source_id=$1 AND observed_day=$2::date AND metric='model' AND owner_digest=$3`, [SOURCE_ID, DAY, OWNER_DIGEST]);
    await writeResult(nextFingerprint, 1, 2, 1);
    const second = await publishPostgresCommunityModelDay(pool, {
      sourcePin: { ...pin, sequence: 1 }, members: [member("effective", nextFingerprint, 1, 2)], day: DAY, nowMs: NOW + 3,
      schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" },
    });
    expect(second).toMatchObject({ state: "published", memberCount: 1 });
    expect(second.generation).not.toBe(firstGeneration);
    expect(await readPostgresCommunityModelDay(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE, day: DAY,
      schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" },
    })).toMatchObject({ day: DAY, fittedParticipantCount: 1 });
  }, 120_000);

  it("accepts a terminal source event before analytics cursor initialization and keeps reads closed", async () => {
    await pool.query(`INSERT INTO ${sqlSchema}.storage_source_state(singleton, source_id, authority_epoch)
      VALUES (1, $1, 0)`, [SOURCE_ID]);
    await pool.query(`UPDATE ${sqlSchema}.publication_state SET publication_state='ready' WHERE singleton=1`);
    await pool.query(`UPDATE ${sqlSchema}.collection_controls SET revision=revision+1, control_state='operational',
      enrollment_enabled=true, upload_registration_enabled=true, processing_enabled=true,
      publication_enabled=true, reason_code=NULL, updated_at=clock_timestamp() WHERE singleton=1`);
    await pool.query(`INSERT INTO ${sqlSchema}.participants(id, owner_kind, state, created_at)
      VALUES ($1, 'social', 'active', clock_timestamp())`, [PARTICIPANT_ID]);
    await pool.query(`INSERT INTO ${sqlSchema}.analytics_owner_state(source_id, owner_digest, revision, authority_epoch, state)
      VALUES ($1, $2, 1, 0, 'active')`, [SOURCE_ID, OWNER_DIGEST]);
    await pool.query(`INSERT INTO ${sqlSchema}.storage_v11_owner_links(participant_id, owner_digest, state)
      VALUES ($1, $2, 'active')`, [PARTICIPANT_ID, OWNER_DIGEST]);

    await expect(pool.query(`INSERT INTO ${sqlSchema}.storage_ingestion_changes(
      source_id, sequence, event_digest, owner_digest, owner_revision, authority_epoch, kind, recorded_ms
    ) VALUES ($1,1,$2,$3,2,1,'owner-withdrawn',$4)`, [SOURCE_ID, "d".repeat(64), OWNER_DIGEST, NOW]))
      .resolves.toMatchObject({ rowCount: 1 });
    expect(await pool.query(`SELECT 1 FROM ${sqlSchema}.analytics_source_cursors WHERE source_id=$1`, [SOURCE_ID]))
      .toMatchObject({ rows: [] });
    expect(await readPostgresCommunityModelDay(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE, day: DAY,
      schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" },
    })).toBeNull();
  }, 120_000);

  it("serializes a terminal withdrawal with publication and keeps unrelated days after delivery", async () => {
    await seedOwner();
    await seedOtherOwner();
    const affected = await publishPostgresCommunityModelDay(pool, {
      sourcePin, members: [member()], day: DAY, nowMs: NOW,
      schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" },
    });
    expect(affected.state).toBe("published");
    const unrelatedDay = "2026-09-22";
    const unrelated = await publishPostgresCommunityModelDay(pool, {
      sourcePin, members: [member("mixed", null, 0, 1, OTHER_OWNER_DIGEST, OTHER_PARTICIPANT_ID)],
      day: unrelatedDay, nowMs: NOW,
      schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" },
    });
    expect(unrelated.state).toBe("published");

    const terminalClient = await pool.connect();
    await terminalClient.query("BEGIN");
    try {
      await terminalClient.query(`INSERT INTO ${sqlSchema}.storage_ingestion_changes(
        source_id, sequence, event_digest, owner_digest, owner_revision, authority_epoch, kind, recorded_ms
      ) VALUES ($1,1,$2,$3,2,1,'owner-withdrawn',$4)`, [SOURCE_ID, "d".repeat(64), OWNER_DIGEST, NOW + 1]);
      await terminalClient.query(`UPDATE ${sqlSchema}.storage_source_state SET authority_epoch=1 WHERE singleton=1`);
      await terminalClient.query(`UPDATE ${sqlSchema}.analytics_owner_state
        SET revision=2, authority_epoch=1, state='withdrawn' WHERE source_id=$1 AND owner_digest=$2`, [SOURCE_ID, OWNER_DIGEST]);
      await terminalClient.query(`UPDATE ${sqlSchema}.storage_v11_owner_links SET state='withdrawn' WHERE owner_digest=$1`, [OWNER_DIGEST]);

      const staleCandidate = publishPostgresCommunityModelDay(pool, {
        sourcePin, members: [member()], day: DAY, nowMs: NOW + 2,
        schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" },
      });
      await waitForLockedQuery("storage_source_state");
      await terminalClient.query("COMMIT");
      expect(await staleCandidate).toMatchObject({ state: "deferred", reason: "source_changed" });
    } catch (error) {
      await terminalClient.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      terminalClient.release();
    }

    expect(await readPostgresCommunityModelDay(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE, day: DAY,
      schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" },
    })).toBeNull();
    // Source-ahead terminal evidence temporarily withholds all older days.
    expect(await readPostgresCommunityModelDay(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE, day: unrelatedDay,
      schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" },
    })).toBeNull();

    await pool.query(`UPDATE ${sqlSchema}.analytics_source_cursors SET sequence=1, authority_epoch=1 WHERE source_id=$1`, [SOURCE_ID]);
    expect(await readPostgresCommunityModelDay(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE, day: unrelatedDay,
      schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" },
    })).toMatchObject({ day: unrelatedDay, v1ParticipantCount: 0, unsupportedSourceParticipantCount: 1 });
    const invalidation = await pool.query(`SELECT reason FROM ${sqlSchema}.analytics_publication_invalidations
      WHERE source_id=$1 AND day=$2::date AND metric='model' AND generation=$3 AND owner_digest=$4`,
    [SOURCE_ID, DAY, affected.generation, OWNER_DIGEST]);
    expect(invalidation.rows[0]?.reason).toBe("owner-withdrawn");
  }, 120_000);

  it("serializes participant erasure with publication and preserves the owner tombstone", async () => {
    await seedOwner();
    const initial = await publishPostgresCommunityModelDay(pool, {
      sourcePin, members: [member()], day: DAY, nowMs: NOW,
      schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" },
    });
    expect(initial.state).toBe("published");

    await pool.query(`UPDATE ${sqlSchema}.input_versions SET revision=1 WHERE participant_id=$1`, [PARTICIPANT_ID]);
    await pool.query(`UPDATE ${sqlSchema}.analytics_owner_state SET revision=2 WHERE source_id=$1 AND owner_digest=$2`, [SOURCE_ID, OWNER_DIGEST]);
    await pool.query(`INSERT INTO ${sqlSchema}.storage_ingestion_changes(
      source_id, sequence, event_digest, owner_digest, owner_revision, authority_epoch, kind, recorded_ms
    ) VALUES ($1,1,$2,$3,2,0,'source-updated',$4)`, [SOURCE_ID, "c".repeat(64), OWNER_DIGEST, NOW + 1]);
    await pool.query(`UPDATE ${sqlSchema}.analytics_source_cursors SET sequence=1 WHERE source_id=$1`, [SOURCE_ID]);
    const nextFingerprint = "b".repeat(64);
    await pool.query(`DELETE FROM ${sqlSchema}.analytics_owner_results
      WHERE source_id=$1 AND observed_day=$2::date AND metric='model' AND owner_digest=$3`, [SOURCE_ID, DAY, OWNER_DIGEST]);
    await writeResult(nextFingerprint, 1, 2, 1);
    expect(await readPostgresCommunityModelDay(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE, day: DAY,
      schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" },
    })).toMatchObject({ day: DAY, fittedParticipantCount: 1 });

    const headLockClient = await pool.connect();
    await headLockClient.query("SET application_name = 'pg-community-graph-head-lock-test'");
    await headLockClient.query("BEGIN");
    await headLockClient.query(`SELECT generation FROM ${sqlSchema}.analytics_publications
      WHERE source_id=$1 AND day=$2::date AND metric='model' FOR UPDATE`, [SOURCE_ID, DAY]);
    const candidate = publishPostgresCommunityModelDay(pool, {
      sourcePin: { ...sourcePin, sequence: 1 },
      members: [member("effective", nextFingerprint, 1, 2)], day: DAY, nowMs: NOW + 2,
      schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" },
    });
    await waitForLockedQuery("analytics_publications");

    const erasureClient = await pool.connect();
    await erasureClient.query("SET application_name = 'pg-community-graph-erasure-test'");
    await erasureClient.query("BEGIN");
    try {
      const deleteParticipant = erasureClient.query(`DELETE FROM ${sqlSchema}.participants WHERE id=$1`, [PARTICIPANT_ID]);
      await waitForLockedQuery("participants", "pg-community-graph-erasure-test");
      await headLockClient.query("COMMIT");
      expect(await candidate).toMatchObject({ state: "published", memberCount: 1 });
      await deleteParticipant;
      await erasureClient.query("COMMIT");
    } catch (error) {
      await headLockClient.query("ROLLBACK").catch(() => {});
      await erasureClient.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      headLockClient.release();
      erasureClient.release();
    }

    expect(await readPostgresCommunityModelDay(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE, day: DAY,
      schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" },
    })).toBeNull();
    const erasureInvalidation = await pool.query(`SELECT reason FROM ${sqlSchema}.analytics_publication_invalidations
      WHERE source_id=$1 AND day=$2::date AND metric='model' AND generation=$3 AND owner_digest=$4`,
    [SOURCE_ID, DAY, initial.generation, OWNER_DIGEST]);
    expect(erasureInvalidation.rows[0]?.reason).toBe("owner-erased");
  }, 120_000);

  it("treats collection revision as hard publication authority", async () => {
    await seedOwner();
    await publishPostgresCommunityModelDay(pool, {
      sourcePin, members: [member()], day: DAY, nowMs: NOW,
      schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" },
    });
    await pool.query(`UPDATE ${sqlSchema}.collection_controls SET revision=revision+1 WHERE singleton=1`);
    expect(await readPostgresCommunityModelDay(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE, day: DAY,
      schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" },
    })).toBeNull();
  }, 120_000);

  it("counts an explicitly unsupported source without fabricating a model result", async () => {
    await seedOwner();
    const unsupportedDay = "2026-09-22";
    const published = await publishPostgresCommunityModelDay(pool, {
      sourcePin: sourcePin, members: [member("mixed", null)], day: unsupportedDay, nowMs: NOW,
      schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" },
    });
    expect(published).toMatchObject({ state: "published", memberCount: 1 });
    const result = await readPostgresCommunityModelDay(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE, day: unsupportedDay,
      schema: { primarySchema: schema, ledgerSchema: "tibotattle_ledger" },
    });
    expect(result).toMatchObject({ day: unsupportedDay, v1ParticipantCount: 0, unsupportedSourceParticipantCount: 1 });
  }, 120_000);
});
