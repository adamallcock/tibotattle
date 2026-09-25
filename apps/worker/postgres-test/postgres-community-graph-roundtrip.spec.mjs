import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { canonicalJson } from "../src/canonical-json.ts";
import {
  publishPostgresCommunityModelDay,
  publishPostgresCommunityModelDayStream,
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
const STRESS_MEMBERS = process.env.PG_GRAPH_STRESS_MEMBERS === undefined
  ? 1_025 : Number(process.env.PG_GRAPH_STRESS_MEMBERS);
const STRESS_NOW_MS = process.env.PG_GRAPH_STRESS_NOW_MS === undefined
  ? NOW : Number(process.env.PG_GRAPH_STRESS_NOW_MS);
const STRESS_TIMEOUT_MS = process.env.PG_GRAPH_STRESS_TIMEOUT_MS === undefined
  ? 120_000 : Number(process.env.PG_GRAPH_STRESS_TIMEOUT_MS);
const C_COLLATION_INDEX_MEMBER_THRESHOLD = 10_000;
if (!Number.isSafeInteger(STRESS_MEMBERS) || STRESS_MEMBERS < 1_025
    || STRESS_MEMBERS > 100_000) {
  throw new Error("PG_GRAPH_STRESS_MEMBERS must be an integer from 1025 to 100000");
}
if (!Number.isSafeInteger(STRESS_TIMEOUT_MS) || STRESS_TIMEOUT_MS < 120_000
    || STRESS_TIMEOUT_MS > 1_800_000) {
  throw new Error("PG_GRAPH_STRESS_TIMEOUT_MS must be an integer from 120000 to 1800000");
}
if (!Number.isSafeInteger(STRESS_NOW_MS) || STRESS_NOW_MS < 0) {
  throw new Error("PG_GRAPH_STRESS_NOW_MS must be a nonnegative safe integer");
}
function measuredPool(base) {
  const timings = new Map();
  let connectionAcquisitions = 0;
  let checkedOutConnections = 0;
  let maxConcurrentCheckedOutConnections = 0;
  let explainedResultPage = false;
  const classify = (sql) => {
    if (/^FETCH FORWARD\b/u.test(sql)) return "member_readback_pages";
    if (sql.includes("CREATE INDEX pg_community_graph_members_owner_digest_c")) return "member_page_index";
    if (/^\s*ANALYZE pg_temp\.pg_community_graph_members\b/u.test(sql)) return "member_table_analyze";
    if (sql.includes("candidates AS MATERIALIZED")) return "result_pages";
    if (sql.includes("WITH locked AS MATERIALIZED")) return "authority_locks";
    if (sql.includes("WITH stored AS MATERIALIZED")) return "member_receipt";
    if (/\bINSERT INTO\b/u.test(sql) && sql.includes("analytics_publication_owner_members")) {
      return "publication_members";
    }
    if (sql.includes("percentile_cont(0.5)")) return "database_median";
    if (sql.includes("pg_temp.pg_community_graph_members")) return "member_temp_table";
    if (sql.includes("pg_temp.pg_community_graph_capacities")) return "capacity_temp_table";
    if (sql.includes("analytics_publication_owner_members")) return "publication_members";
    if (sql.includes("analytics_publications")) return "publication_read_write";
    return "other_sql";
  };
  return {
    pool: {
      async connect() {
        const client = await base.connect();
        connectionAcquisitions += 1;
        checkedOutConnections += 1;
        maxConcurrentCheckedOutConnections = Math.max(
          maxConcurrentCheckedOutConnections, checkedOutConnections,
        );
        return {
          async query(sql, values) {
            if (!explainedResultPage && process.env.PG_GRAPH_STRESS_EXPLAIN === "1"
                && classify(sql) === "result_pages") {
              explainedResultPage = true;
              const explained = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, values);
              const explainedPlan = explained.rows[0]?.["QUERY PLAN"]?.[0];
              const plan = explainedPlan?.Plan;
              const bufferCounters = ["Shared Hit Blocks", "Shared Read Blocks", "Shared Dirtied Blocks",
                "Shared Written Blocks", "Local Hit Blocks", "Local Read Blocks", "Local Dirtied Blocks",
                "Local Written Blocks", "Temp Read Blocks", "Temp Written Blocks"];
              const nodes = [];
              const collect = (node) => {
                if (!node) return;
                const buffers = Object.fromEntries(bufferCounters
                  .filter((key) => Number.isSafeInteger(node[key]))
                  .map((key) => [key, node[key]]));
                nodes.push({ type: node["Node Type"], relation: node["Relation Name"],
                  index: node["Index Name"], planRows: node["Plan Rows"],
                  actualRows: node["Actual Rows"], loops: node["Actual Loops"],
                  actualTotalTimeMs: node["Actual Total Time"],
                  rowsRemovedByFilter: node["Rows Removed by Filter"],
                  buffers });
                for (const child of node.Plans ?? []) collect(child);
              };
              collect(plan);
              console.log(JSON.stringify({
                kind: "synthetic-postgres-result-page-explain-v2",
                querySha256: createHash("sha256").update(sql).digest("hex"),
                planningTimeMs: explainedPlan?.["Planning Time"] ?? null,
                executionTimeMs: explainedPlan?.["Execution Time"] ?? null,
                nodes,
              }));
            }
            const started = performance.now();
            let result;
            try {
              result = await client.query(sql, values);
              return result;
            }
            finally {
              const kind = classify(sql);
              const previous = timings.get(kind) ?? {
                count: 0, milliseconds: 0, returnedRows: 0,
                decodedRowsJsonBytes: 0, resultPayloadJsonBytes: 0,
                pageRowCounts: [], pageDecodedRowsJsonBytes: [], pagePayloadJsonBytes: [],
              };
              // `result` is assigned before the finally block on successful queries.
              // These sizes are decoded row JSON, not PostgreSQL wire-protocol bytes.
              const rows = result?.rows ?? [];
              const decodedRowsJsonBytes = Buffer.byteLength(JSON.stringify(rows));
              const resultPayloadJsonBytes = rows.reduce((total, row) => total
                + (typeof row.payload_json === "string" ? Buffer.byteLength(row.payload_json) : 0), 0);
              timings.set(kind, {
                count: previous.count + 1,
                milliseconds: previous.milliseconds + performance.now() - started,
                returnedRows: previous.returnedRows + rows.length,
                decodedRowsJsonBytes: previous.decodedRowsJsonBytes + decodedRowsJsonBytes,
                resultPayloadJsonBytes: previous.resultPayloadJsonBytes + resultPayloadJsonBytes,
                pageRowCounts: kind === "result_pages" || kind === "member_readback_pages"
                  ? [...previous.pageRowCounts, rows.length] : previous.pageRowCounts,
                pageDecodedRowsJsonBytes: kind === "result_pages" || kind === "member_readback_pages"
                  ? [...previous.pageDecodedRowsJsonBytes, decodedRowsJsonBytes] : previous.pageDecodedRowsJsonBytes,
                pagePayloadJsonBytes: kind === "result_pages" || kind === "member_readback_pages"
                  ? [...previous.pagePayloadJsonBytes, resultPayloadJsonBytes] : previous.pagePayloadJsonBytes,
              });
            }
          },
          release(discard) {
            checkedOutConnections -= 1;
            return client.release(discard);
          },
        };
      },
    },
    summary() {
      const summarizePages = (timing) => {
        const summarizePageValues = (values) => ({
          min: values.length ? Math.min(...values) : 0,
          max: values.length ? Math.max(...values) : 0,
          total: values.reduce((sum, value) => sum + value, 0),
        });
        return {
          pageCount: timing.pageRowCounts.length,
          rows: summarizePageValues(timing.pageRowCounts),
          decodedRowsJsonBytes: summarizePageValues(timing.pageDecodedRowsJsonBytes),
          resultPayloadJsonBytes: summarizePageValues(timing.pagePayloadJsonBytes),
        };
      };
      return {
        connectionAcquisitions,
        maxConcurrentCheckedOutConnections,
        checkedOutConnectionsAtEnd: checkedOutConnections,
        pageIndexMode: STRESS_MEMBERS >= C_COLLATION_INDEX_MEMBER_THRESHOLD
          ? "collate-c-index" : "primary-key-default-collation",
        pageIndexThresholdMembers: C_COLLATION_INDEX_MEMBER_THRESHOLD,
        queries: Object.fromEntries([...timings].sort(([left], [right]) => left.localeCompare(right))
          .map(([kind, timing]) => [kind, {
            count: timing.count,
            milliseconds: Math.round(timing.milliseconds),
            returnedRows: timing.returnedRows,
            decodedRowsJsonBytes: timing.decodedRowsJsonBytes,
            resultPayloadJsonBytes: timing.resultPayloadJsonBytes,
            ...(kind === "result_pages" || kind === "member_readback_pages" ? {
              pages: summarizePages(timing),
            } : {}),
          }])),
      };
    },
  };
}

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
    await pool.query(`UPDATE ${sqlSchema}.telemetry_v12_runtime SET state='active' WHERE id=1`);
    await pool.query(`UPDATE ${sqlSchema}.telemetry_v12_typed_runtime SET state='active' WHERE id=1`);
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

  function syntheticGraphStressDigests(memberCount, computedAtMs) {
    const payload = JSON.stringify(readyComposition(FINGERPRINT));
    const payloadSha256 = createHash("sha256").update(payload).digest("hex");
    const workload = {
      schemaVersion: "synthetic-public-graph-cohort-workload-v1",
      day: DAY,
      sourceId: SOURCE_ID,
      sourceNamespace: SOURCE_NAMESPACE,
      memberCount,
      computedAtMs,
      sourcePin,
      syntheticGeneration: {
        ownerDigest: "lowercase-hex(index), left padded to 64 characters",
        participantId: "synthetic-stream-index",
        sourceKind: "effective",
        inputRevision: 0,
        ownerRevision: 1,
        authorityEpoch: 0,
        inputFingerprint: FINGERPRINT,
        payloadSha256,
      },
    };
    const source = createHash("sha256");
    const updateSource = (record) => {
      const serialized = canonicalJson(record);
      source.update(`${Buffer.byteLength(serialized)}:${serialized}\n`);
    };
    updateSource(workload);
    for (let index = 1; index <= memberCount; index += 1) {
      const ownerDigest = index.toString(16).padStart(64, "0");
      updateSource({
        schemaVersion: "synthetic-community-graph-owner-v1",
        participant: { id: `synthetic-stream-${index}`, ownerKind: "social", state: "active" },
        owner: { sourceId: SOURCE_ID, ownerDigest, revision: 1, authorityEpoch: 0, state: "active" },
        link: { participantId: `synthetic-stream-${index}`, ownerDigest, state: "active" },
        inputVersion: { participantId: `synthetic-stream-${index}`, revision: 0 },
        graphMember: {
          participantId: `synthetic-stream-${index}`,
          ownerDigest,
          inputRevision: 0,
          ownerRevision: 1,
          authorityEpoch: 0,
          sourceKind: "effective",
          inputFingerprint: FINGERPRINT,
        },
        ownerResult: {
          sourceId: SOURCE_ID,
          sourceNamespace: SOURCE_NAMESPACE,
          observedDay: DAY,
          metric: "model",
          ownerDigest,
          inputRevision: 0,
          ownerRevision: 1,
          authorityEpoch: 0,
          publicAuthorityEpoch: 0,
          sourceEpoch: 0,
          sequence: 0,
          method: V11_PLAN_ATTRIBUTION_ADAPTER_VERSION,
          status: "ready",
          reason: null,
          payloadSha256,
          computedAtMs,
        },
      });
    }
    return Object.freeze({
      workloadDigest: createHash("sha256").update(canonicalJson(workload)).digest("hex"),
      sourceDigest: source.digest("hex"),
    });
  }

  const sourcePin = {
    sourceId: SOURCE_ID,
    sourceNamespace: SOURCE_NAMESPACE,
    sourceAuthorityEpoch: 0,
    analyticsAuthorityEpoch: 0,
    sequence: 0,
    policyRevision: 1,
    collectionRevision: 2,
    telemetryV12RuntimeState: "active",
    telemetryV12RuntimeRevision: 0,
    telemetryV12TypedRuntimeState: "active",
    telemetryV12TypedRuntimePolicyRevision: 1,
    accountlessAuthorizationCount: 0,
    nextAccountlessAuthorizationExpiry: null,
  };

  async function waitForLockedQuery(fragment, applicationName = "pg-community-graph-test") {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE application_name = $1 AND wait_event_type = 'Lock'
          AND position($2 in query) > 0 LIMIT 1`, [applicationName, fragment]);
      if (waiting.rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const activity = await pool.query(`SELECT application_name, wait_event_type, wait_event, left(query, 400) AS query
      FROM pg_stat_activity WHERE state='active' AND pid <> pg_backend_pid()`);
    assert.fail(`Expected ${applicationName} to wait on ${fragment}; active=${JSON.stringify(activity.rows)}`);
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

  it("continues to read persisted version-1 capture receipts after the streamed proof migration", async () => {
    await seedOwner();
    const schemaOptions = { primarySchema: schema, ledgerSchema: "tibotattle_ledger" };
    const published = await publishPostgresCommunityModelDay(pool, {
      sourcePin, members: [member()], day: DAY, nowMs: NOW, schema: schemaOptions,
    });
    expect(published).toMatchObject({ state: "published", memberCount: 1 });
    const publication = (await pool.query(`SELECT authority_json FROM ${sqlSchema}.analytics_publications
      WHERE source_id=$1 AND day=$2::date AND metric='model'`, [SOURCE_ID, DAY])).rows[0];
    const persisted = (await pool.query(`SELECT payload_sha256 FROM ${sqlSchema}.analytics_owner_results
      WHERE source_id=$1 AND owner_digest=$2 AND observed_day=$3::date AND metric='model'`, [SOURCE_ID, OWNER_DIGEST, DAY])).rows[0];
    const authority = JSON.parse(publication.authority_json);
    const memberProof = [[OWNER_DIGEST, "effective", 0, 1, 0, FINGERPRINT, persisted.payload_sha256]];
    const legacyGeneration = createHash("sha256").update(canonicalJson([
      "postgres-community-model-day-v1", DAY, publication.authority_json, memberProof,
    ])).digest("hex");
    const legacyCapture = canonicalJson({
      schema: "postgres-community-model-capture-v1", authority, memberProof,
    });
    await pool.query(`DELETE FROM ${sqlSchema}.analytics_publication_owner_members
      WHERE source_id=$1 AND day=$2::date AND metric='model' AND generation=$3`, [SOURCE_ID, DAY, published.generation]);
    await pool.query(`DELETE FROM ${sqlSchema}.analytics_publication_captures
      WHERE source_id=$1 AND day=$2::date AND metric='model' AND generation=$3`, [SOURCE_ID, DAY, published.generation]);
    await pool.query(`INSERT INTO ${sqlSchema}.analytics_publication_captures(
      source_id, day, metric, generation, cohort_digest, expected_members, payload_json,
      policy_revision, collection_revision
    ) VALUES ($1,$2::date,'model',$3,$3,1,$4,1,2)`, [SOURCE_ID, DAY, legacyGeneration, legacyCapture]);
    await pool.query(`INSERT INTO ${sqlSchema}.analytics_publication_owner_members(
      source_id, day, metric, generation, owner_digest, input_revision, owner_revision, authority_epoch
    ) VALUES ($1,$2::date,'model',$3,$4,0,1,0)`, [SOURCE_ID, DAY, legacyGeneration, OWNER_DIGEST]);
    await pool.query(`UPDATE ${sqlSchema}.analytics_publications
      SET generation=$3, cohort_digest=$3 WHERE source_id=$1 AND day=$2::date AND metric='model'`, [
      SOURCE_ID, DAY, legacyGeneration,
    ]);
    expect(await readPostgresCommunityModelDay(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE, day: DAY, schema: schemaOptions,
    })).toMatchObject({ day: DAY, fittedParticipantCount: 1, values: [["gpt-6-astra", 1000, 1]] });
    await pool.query(`UPDATE ${sqlSchema}.analytics_publication_owner_members
      SET source_kind='effective', input_fingerprint=$4, result_sha256=$5
      WHERE source_id=$1 AND day=$2::date AND metric='model' AND generation=$3`, [
      SOURCE_ID, DAY, legacyGeneration, FINGERPRINT, persisted.payload_sha256,
    ]);
    expect(await readPostgresCommunityModelDay(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE, day: DAY, schema: schemaOptions,
    })).toBeNull();
    await pool.query(`UPDATE ${sqlSchema}.analytics_publication_owner_members
      SET source_kind=NULL, input_fingerprint=NULL, result_sha256=NULL
      WHERE source_id=$1 AND day=$2::date AND metric='model' AND generation=$3`, [
      SOURCE_ID, DAY, legacyGeneration,
    ]);
    await pool.query(`UPDATE ${sqlSchema}.analytics_publication_owner_members
      SET input_revision=1 WHERE source_id=$1 AND day=$2::date AND metric='model' AND generation=$3`, [
      SOURCE_ID, DAY, legacyGeneration,
    ]);
    expect(await readPostgresCommunityModelDay(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE, day: DAY, schema: schemaOptions,
    })).toBeNull();
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
      // pg_stat_activity truncates long SQL statements before the FROM clause;
      // match the publisher's uniquely identifying authority-pin query prefix.
      await waitForLockedQuery("SELECT source.source_id");
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

  it("streams cohorts above 1,024 members and rolls back interrupted attempts before retry", async () => {
    await seedOwner();
    const largeCount = STRESS_MEMBERS;
    await pool.query(`INSERT INTO ${sqlSchema}.participants(id, owner_kind, state, created_at)
      SELECT 'synthetic-stream-'||index, 'social', 'active', clock_timestamp()
        FROM generate_series(1,$1::integer) AS generated(index)`, [largeCount]);
    await pool.query(`INSERT INTO ${sqlSchema}.analytics_owner_state(
      source_id, owner_digest, revision, authority_epoch, state
    ) SELECT $1, lpad(to_hex(index),64,'0'), 1, 0, 'active'
        FROM generate_series(1,$2::integer) AS generated(index)`, [SOURCE_ID, largeCount]);
    await pool.query(`INSERT INTO ${sqlSchema}.storage_v11_owner_links(participant_id, owner_digest, state)
      SELECT 'synthetic-stream-'||index, lpad(to_hex(index),64,'0'), 'active'
        FROM generate_series(1,$1::integer) AS generated(index)`, [largeCount]);
    const largePayload = JSON.stringify(readyComposition(FINGERPRINT));
    const largePayloadHash = createHash("sha256").update(largePayload).digest("hex");
    await pool.query(`INSERT INTO ${sqlSchema}.input_versions(participant_id, revision)
      SELECT 'synthetic-stream-'||index, 0
        FROM generate_series(1,$1::integer) AS generated(index)
      ON CONFLICT (participant_id) DO NOTHING`, [largeCount]);
    await pool.query(`INSERT INTO ${sqlSchema}.analytics_owner_results(
      source_id, source_namespace, observed_day, metric, owner_digest, input_revision,
      owner_revision, authority_epoch, public_authority_epoch, source_epoch, sequence,
      method, status, reason, payload_json, payload_sha256, computed_at_ms
    ) SELECT $1, $2, $3::date, 'model', lpad(to_hex(index),64,'0'), 0, 1, 0, 0, 0, 0,
             $4, 'ready', NULL, $5, $6, $7
        FROM generate_series(1,$8::integer) AS generated(index)`, [
      SOURCE_ID, SOURCE_NAMESPACE, DAY, V11_PLAN_ATTRIBUTION_ADAPTER_VERSION,
      largePayload, largePayloadHash, STRESS_NOW_MS, largeCount,
    ]);
    const workloadDigests = syntheticGraphStressDigests(largeCount, STRESS_NOW_MS);

    const stream = async function* (stopAfter = largeCount) {
      for (let index = 1; index <= stopAfter; index += 1) {
        yield member("effective", FINGERPRINT, 0, 1,
          index.toString(16).padStart(64, "0"), `synthetic-stream-${index}`);
      }
    };
    async function* interrupted() {
      yield* stream(700);
      throw new Error("synthetic stream interruption");
    }
    const schemaOptions = { primarySchema: schema, ledgerSchema: "tibotattle_ledger" };
    await expect(publishPostgresCommunityModelDayStream(pool, {
      sourcePin, members: interrupted(), day: DAY, nowMs: STRESS_NOW_MS, schema: schemaOptions,
    })).rejects.toMatchObject({ code: "unavailable", operation: "postgres.community_graph.publish_model_day" });
    expect(await pool.query(`SELECT
      (SELECT count(*) FROM ${sqlSchema}.analytics_publications) AS publications,
      (SELECT count(*) FROM ${sqlSchema}.analytics_publication_captures) AS captures,
      (SELECT count(*) FROM ${sqlSchema}.analytics_publication_owner_members) AS members`))
      .toMatchObject({ rows: [{ publications: "0", captures: "0", members: "0" }] });

    let membershipPageCalls = 0;
    const failSecondMembershipPagePool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, values) {
            if (typeof sql === "string"
                && sql.includes("analytics_publication_owner_members")
                && /\bINSERT INTO\b/u.test(sql)) {
              membershipPageCalls += 1;
              if (membershipPageCalls === 2) throw new Error("synthetic membership page failure");
            }
            return client.query(sql, values);
          },
          release: client.release.bind(client),
        };
      },
    };
    await expect(publishPostgresCommunityModelDayStream(failSecondMembershipPagePool, {
      sourcePin, members: stream(), day: DAY, nowMs: STRESS_NOW_MS, schema: schemaOptions,
    })).rejects.toMatchObject({ code: "unavailable", operation: "postgres.community_graph.publish_model_day" });
    expect(membershipPageCalls).toBe(2);
    expect(await pool.query(`SELECT
      (SELECT count(*) FROM ${sqlSchema}.analytics_publications) AS publications,
      (SELECT count(*) FROM ${sqlSchema}.analytics_publication_captures) AS captures,
      (SELECT count(*) FROM ${sqlSchema}.analytics_publication_owner_members) AS members`))
      .toMatchObject({ rows: [{ publications: "0", captures: "0", members: "0" }] });

    const memorySnapshot = () => {
      const { rss, heapUsed, external } = process.memoryUsage();
      return { rssBytes: rss, heapUsedBytes: heapUsed, externalBytes: external };
    };
    const cpuMilliseconds = (usage) => ({
      userMs: Math.round(usage.user / 1000),
      systemMs: Math.round(usage.system / 1000),
      totalMs: Math.round((usage.user + usage.system) / 1000),
    });
    const rssBefore = memorySnapshot();
    const publishCpuStarted = process.cpuUsage();
    const publicationSql = measuredPool(pool);
    const publishStarted = performance.now();
    const published = await publishPostgresCommunityModelDayStream(publicationSql.pool, {
      sourcePin, members: stream(), day: DAY, nowMs: STRESS_NOW_MS, schema: schemaOptions,
    });
    const publishMilliseconds = performance.now() - publishStarted;
    const publishCpu = cpuMilliseconds(process.cpuUsage(publishCpuStarted));
    const rssAfterPublish = memorySnapshot();
    expect(published).toMatchObject({ state: "published", memberCount: largeCount });
    const publicationSqlSummary = publicationSql.summary();
    expect(publicationSqlSummary.queries.publication_members?.count ?? 0)
      .toBe(Math.ceil(largeCount / 1_000));
    const expectCollationIndex = largeCount >= C_COLLATION_INDEX_MEMBER_THRESHOLD;
    expect(publicationSqlSummary.queries.member_page_index?.count ?? 0)
      .toBe(expectCollationIndex ? 1 : 0);
    expect(publicationSqlSummary.queries.member_table_analyze?.count ?? 0)
      .toBe(expectCollationIndex ? 1 : 0);
    expect(await pool.query(`SELECT expected_members, payload_json
      FROM ${sqlSchema}.analytics_publication_captures`)).toMatchObject({
      rows: [{ expected_members: String(largeCount), payload_json: expect.stringContaining('"postgres-community-model-capture-v2"') }],
    });
    const readSql = measuredPool(pool);
    const readCpuStarted = process.cpuUsage();
    const readStarted = performance.now();
    const readback = await readPostgresCommunityModelDay(readSql.pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE, day: DAY, schema: schemaOptions,
    });
    expect(readback).toMatchObject({
      day: DAY,
      fittedParticipantCount: largeCount,
      v1ParticipantCount: largeCount,
      unsupportedSourceParticipantCount: 0,
      values: [["gpt-6-astra", 1000, largeCount]],
    });
    const readMilliseconds = performance.now() - readStarted;
    const readCpu = cpuMilliseconds(process.cpuUsage(readCpuStarted));
    const rssAfterRead = memorySnapshot();
    const outputDigest = createHash("sha256").update(canonicalJson(readback)).digest("hex");
    if (largeCount === 100_000 && STRESS_NOW_MS === 1_790_294_400_000) {
      expect(workloadDigests).toMatchObject({
        workloadDigest: "7b3199c3da470fd8c55806f275f4f3094cb5be4fff7158aa1d07bcfc7a27f5fc",
        sourceDigest: "c90d7927e4444ccb53db17822d5c11fa42adfd933854fbc50123a70cc9dde934",
      });
      expect(outputDigest).toBe("4025b72539599beb754fb0b3a476203d05b2c0ff07fb824f9287656b40f7b10f");
    }
    if (process.env.PG_GRAPH_STRESS_MEMBERS !== undefined) {
      console.log(JSON.stringify({
        kind: "synthetic-postgres-graph-stress-v2",
        profile: "community-graph-100k-capable-v1",
        members: largeCount,
        computedAtMs: STRESS_NOW_MS,
        workloadDigest: workloadDigests.workloadDigest,
        sourceDigest: workloadDigests.sourceDigest,
        outputDigest,
        publishMilliseconds: Math.round(publishMilliseconds),
        publishCpu,
        readMilliseconds: Math.round(readMilliseconds),
        readCpu,
        memorySnapshots: [rssBefore, rssAfterPublish, rssAfterRead],
        processMaxRssPlatformUnits: process.resourceUsage().maxRSS,
        poolMax: 4,
        publicationSql: publicationSqlSummary,
        readSql: readSql.summary(),
      }));
    }
    expect(await publishPostgresCommunityModelDayStream(pool, {
      sourcePin, members: stream(), day: DAY, nowMs: STRESS_NOW_MS + 1, schema: schemaOptions,
    })).toMatchObject({ state: "unchanged", memberCount: largeCount, generation: published.generation });
    await pool.query(`UPDATE ${sqlSchema}.analytics_publication_owner_members
      SET authority_epoch=1 WHERE source_id=$1 AND day=$2::date AND metric='model' AND generation=$3
        AND owner_digest=(SELECT min(owner_digest) FROM ${sqlSchema}.analytics_publication_owner_members
          WHERE source_id=$1 AND day=$2::date AND metric='model' AND generation=$3)`, [
      SOURCE_ID, DAY, published.generation,
    ]);
    expect(await readPostgresCommunityModelDay(pool, {
      sourceId: SOURCE_ID, sourceNamespace: SOURCE_NAMESPACE, day: DAY, schema: schemaOptions,
    })).toBeNull();
  }, STRESS_TIMEOUT_MS);
});
