// Bounded synthetic PostgreSQL activation gate. Owns one disposable schema;
// applies the stock primary chain, including promoted 0076, exactly once.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createServer } from "vite";
import {
  canonicalTelemetryV11Json, canonicalTelemetryV12Json, REVIEWED_CODEX_MODEL_IDS,
  telemetryV11DayManifestDigestInput, telemetryV11DomainManifestDigestInput, telemetryV11RequiredConsent,
  telemetryV12DayManifestDigestInput, telemetryV12DomainManifestDigestInput,
  telemetryV12RequiredConsent,
} from "@app-usagemonitor/telemetry-contract";
import { applyPostgresMigrations, readPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import analyticsV2Config from "../vitest.analytics-v2.config.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55567");
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ID = "synthetic-classification-source";
const DAY_ONE = "2026-10-01";
const DAY_TWO = "2026-10-02";
const DAY_THREE = "2026-10-03";
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const SOURCE_NAMESPACE = "synthetic-classification-legacy";
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const EVENT_ID = `event:v2:${"a".repeat(64)}`;
const MODEL = "gpt-6.1-sol"; // The combined current-catalog gate cannot silently fall back.
const CONFLICT = { status: 409, code: "TELEMETRY_MANIFEST_CONFLICT" };
const SNAPSHOT_TABLES = [
  "telemetry_classification_correction_links", "telemetry_v12_domains",
  "telemetry_v12_domain_days", "telemetry_v12_domain_heads", "telemetry_v12_domain_predecessors",
  "storage_ingestion_changes", "storage_v12_event_sources", "storage_owner_revisions",
  "input_versions", "input_source_digests", "community_analytical_input_versions",
  "storage_v11_owner_links", "analytics_owner_state",
];
let pool;
let vite;
let modules;
const databaseFailures = [];

after(async () => { await pool?.end(); await vite?.close(); });
const sha256Hex = value => createHash("sha256").update(value).digest("hex");

async function setup() {
  if (pool) return;
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.equal(PG_TEST_PORT, 55567, "this bounded gate uses only the coordinator-reserved port");
  const link = await lstat(PG_TEST_SOCKET);
  const host = await realpath(PG_TEST_SOCKET);
  const metadata = await stat(host);
  assert.equal(link.isSymbolicLink(), false);
  assert.equal(metadata.isDirectory(), true);
  assert.ok(host.startsWith("/private/tmp/tibotattle-pg-"));
  assert.equal(metadata.mode & 0o077, 0);
  assert.equal(metadata.uid, process.getuid());
  pool = new pg.Pool({ host, port: PG_TEST_PORT, user: process.env.PG_TEST_USER || "postgres",
    password: process.env.PG_TEST_PASSWORD || "synthetic-local-only", database: process.env.PG_TEST_DATABASE || "postgres",
    application_name: "pg-classification-correction-bounded", ssl: false, max: 2, connectionTimeoutMillis: 5_000 });
  pool.on("connect", client => {
    const query = client.query.bind(client);
    client.query = (...args) => {
      const caller = new Error().stack.split("\n").slice(2, 5);
      const result = query(...args);
      if (!result?.catch) return result;
      return result.catch(error => {
        databaseFailures.push({ code: error.code ?? null, routine: error.routine ?? null, caller });
        throw error;
      });
    };
  });
  const server = await pool.query("SELECT inet_server_addr() AS address, current_setting('server_version_num')::integer AS version");
  assert.equal(server.rows[0].address, null);
  assert.equal(Math.floor(server.rows[0].version / 10_000), 17);
  vite = await createServer({ root: WORKER_ROOT, configFile: false, logLevel: "silent",
    plugins: analyticsV2Config.plugins, resolve: analyticsV2Config.resolve,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom" });
  modules = {
    ...await vite.ssrLoadModule("/src/postgres-typed-v12-domain.ts"),
    ...await vite.ssrLoadModule("/src/postgres-typed-v12-admission.ts"),
    ...await vite.ssrLoadModule("/src/postgres-classification-records.ts"),
    ...await vite.ssrLoadModule("/src/postgres-schema-receipt.ts"),
    occurrences: await vite.ssrLoadModule("/src/analytics-v2/occurrence-source.ts"),
    live: await vite.ssrLoadModule("/src/postgres-telemetry-v11-live-admission.ts"),
    transport: await vite.ssrLoadModule("/src/postgres-typed-v12-transport.ts"),
    codec: await vite.ssrLoadModule("/src/typed-telemetry-codec.ts"),
    compatibility: await vite.ssrLoadModule("/src/telemetry-v11-compatibility.ts"),
    reconciliation: await vite.ssrLoadModule("/src/telemetry-usage-reconciliation.ts"),
  };
}

async function withSchema(run, correctionSourceState = "staged") {
  await setup();
  const failureOffset = databaseFailures.length;
  const schema = `classification_${randomBytes(6).toString("hex")}`;
  let created = false;
  let failure;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`); created = true;
    await applyPostgresMigrations({ role: "primary", schema, pool });
    const table = name => `"${schema}"."${name}"`;
    const now = new Date().toISOString();
    for (const name of ["telemetry_v12_runtime", "telemetry_v12_typed_runtime"]) {
      await pool.query(`UPDATE ${table(name)} SET state='active', changed_at=$1 WHERE id=1`, [now]);
    }
    await pool.query(`INSERT INTO ${table("storage_source_state")}(singleton,source_id,authority_epoch) VALUES (1,$1,0)`, [SOURCE_ID]);
    // Public occurrence reads require the reviewed total-correction runtime
    // contract to exist even when it is staged and this fixture has no facts.
    await pool.query(`INSERT INTO ${table("telemetry_usage_correction_runtime")}(
      id,schema_version,method_version,source_state,max_capture_rows,max_history_page)
      VALUES (1,'telemetry-usage-correction-v1','usage-total-correction-v1',$1,200,200)`, [correctionSourceState]);
    const options = { schema: { primarySchema: schema } };
    await run({ schema, table, options, domain: modules.createPostgresTypedV12Domain(pool, options) });
  } catch (error) {
    failure = error;
    console.error("CLASSIFICATION_TEST_DATABASE_FAILURE_CODES", JSON.stringify(databaseFailures.slice(failureOffset)));
    throw error;
  }
  finally {
    if (created) {
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      catch (cleanupError) {
        if (failure) throw new AggregateError([failure, cleanupError], "CLASSIFICATION_TEST_AND_SCHEMA_CLEANUP_FAILED");
        throw cleanupError;
      }
    }
  }
}

async function seedParticipant(context, label) {
  const { table } = context;
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 30 * 24 * HOUR_MS).toISOString();
  const participantId = `synthetic-classification-${label}-${randomUUID()}`;
  const sessionId = `${participantId}-session`;
  const ownerDigest = randomBytes(32).toString("hex");
  await pool.query(`INSERT INTO ${table("participants")}(id, owner_kind, state, consent_version, created_at)
    VALUES ($1,'social','active','privacy-safe-telemetry-v0.1',$2)`, [participantId, now]);
  await pool.query(`INSERT INTO ${table("web_sessions")}(
    id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$5)`, [sessionId, participantId, randomBytes(32), randomBytes(32), now, expires]);
  await pool.query(`INSERT INTO ${table("storage_v11_owner_links")}(participant_id, owner_digest, state)
    VALUES ($1,$2,'active')`, [participantId, ownerDigest]);
  await pool.query(`INSERT INTO ${table("analytics_owner_state")}(
    source_id, owner_digest, revision, authority_epoch, state
  ) VALUES ($1,$2,1,1,'active')`, [SOURCE_ID, ownerDigest]);
  return { participantId, sessionId, ownerDigest, now, expires };
}

async function seedDevice(context, participant, label, { v12 = true } = {}) {
  const { table } = context;
  const deviceId = `synthetic-classification-device-${label}-${randomUUID()}`;
  const pairingId = `synthetic-classification-pairing-${randomUUID()}`;
  const { participantId, sessionId, now, expires } = participant;
  await pool.query(`INSERT INTO ${table("device_pairings")}(
    id, participant_id, issued_by_session_id, secret_hash, consent_version,
    transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
  ) VALUES ($1,$2,$3,$4,'synthetic-consent-v1','synthetic-transport-v1','consumed',$5,$6,$5,$7)`, [
    pairingId, participantId, sessionId, randomBytes(32), now, expires, deviceId,
  ]);
  await pool.query(`INSERT INTO ${table("device_credentials")}(
    id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
    state, issued_at, expires_at, last_used_at, social_verified_at
  ) VALUES ($1,$2,'social',$3,$4,'active',$5,$6,$5,$5)`, [
    deviceId, participantId, pairingId, randomBytes(32), now, expires,
  ]);
  if (v12) await pool.query(`INSERT INTO ${table("telemetry_v12_device_capabilities")}(
    participant_id, device_id, telemetry_schema_version, field_dictionary_version,
    privacy_contract_version, state, consented_at
  ) VALUES ($1,$2,'telemetry-contribution-v1.2','telemetry-v1.2-registry-2026-09-20.1',
    'ongoing-privacy-safe-telemetry-v1.2','accepted',$3)`, [participantId, deviceId, now]);
  return { participantId, deviceId };
}

function usage(patch = {}) {
  return { schemaVersion: "usage-event-v1.2", eventId: EVENT_ID,
    eventTime: `${DAY_TWO}T12:05:00.000Z`, sessionUuid: SESSION_ID,
    provider: "unknown", modelId: "unknown", speedMode: "standard", apiServiceTier: "default",
    surface: "local_interactive_unclassified", billingSurface: "chatgpt_subscription",
    reasoningEffort: "high", agentScope: "root", outcome: "completed", totalInputContextTokens: 1000,
    components: { inputUncachedTokens: 100, inputCacheReadTokens: 900, inputCacheWriteTokens: 0,
      outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: null },
    accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null,
      planBasis: "same_source_occurrence", planType: "promax", planEraId: null },
    boundaryFlags: 1, tieOrder: 0, cacheWriteTtl: { fiveMinuteTokens: 0, oneHourTokens: 0 }, ...patch };
}
function session(provider = "unknown") {
  return { schemaVersion: "session-dimension-v1.2", sessionUuid: SESSION_ID,
    firstEventTime: `${DAY_ONE}T12:05:00.000Z`, provider, toolClassCounts: { shell: 2, browser: 1 } };
}

/** Same real register/stage/ready path as typed-v12-domain-unchanged. */
async function stage(context, principal, day, stream, record) {
  const nowEpoch = Date.now();
  const consent = telemetryV12RequiredConsent();
  const records = Array.isArray(record) ? record : [record];
  const chunk = { schemaVersion: "telemetry-contribution-v1.2", manifestDigest: "0".repeat(64),
    chunkId: `${stream}:${day}:0`, chunkRevision: 1, parserVersion: "synthetic-classification-pg17",
    consent, records, chunkDigest: sha256Hex(canonicalTelemetryV12Json(records)) };
  const manifest = { schemaVersion: "telemetry-day-manifest-v1.2", day,
    parserVersion: chunk.parserVersion, consent,
    chunks: [{ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: records.length }],
    excluded: { quota: 0, session: 0, usage: 0 }, manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  chunk.manifestDigest = manifest.manifestDigest;
  const candidate = await modules.registerPostgresTypedV12DayManifest(pool, principal, manifest, nowEpoch, context.options);
  assert.equal(candidate.state, "staged");
  const envelopeDigest = randomBytes(32).toString("hex");
  const authorizationId = `synthetic-classification-auth-${randomUUID()}`;
  const chunkRowId = `chunk:${randomUUID()}`;
  const r2Key = `synthetic/classification/${randomUUID()}`;
  const now = new Date(nowEpoch).toISOString();
  const expires = new Date(nowEpoch + 10 * 60_000).toISOString();
  await pool.query(`INSERT INTO ${context.table("device_upload_authorizations")}(
    id,participant_id,issued_by_device_id,secret_hash,envelope_digest,body_bytes,content_type,
    state,issued_at,expires_at,consume_lease_expires_at
  ) VALUES ($1,$2,$3,$4,$5,4096,'application/json','consuming',$6,$7,$7)`,
  [authorizationId, principal.participantId, principal.deviceId, randomBytes(32), envelopeDigest, now, expires]);
  await pool.query(`INSERT INTO ${context.table("pending_objects")}(contribution_id,object_key,object_kind)
    VALUES ($1,$2,'telemetry_v12')`, [chunkRowId, r2Key]);
  await modules.persistPostgresTypedV12StagedChunk(pool, principal, chunk,
    { chunkRowId, r2Key, envelopeDigest, deviceUploadAuthorizationId: authorizationId }, nowEpoch, context.options);
  const ready = (await pool.query(`SELECT state,expected_chunk_count FROM ${context.table("telemetry_v12_day_manifests")}
    WHERE id=$1`, [candidate.manifestId])).rows[0];
  assert.deepEqual(ready, { state: "ready", expected_chunk_count: 1 });
  const ids = (await pool.query(`SELECT id::text FROM ${context.table("telemetry_v12_typed_records")} WHERE manifest_id=$1`,
    [candidate.manifestId])).rows.map(row => row.id);
  assert.equal(ids.length, records.length);
  return { day, manifestId: candidate.manifestId, manifestDigest: candidate.manifestDigest, ids, chunkRowId };
}

function domainManifest(predecessor, days) {
  const ordered = [...days].sort((left, right) => left.day.localeCompare(right.day));
  const manifest = { schemaVersion: "telemetry-domain-manifest-v1.2", fromDay: ordered[0].day,
    throughDay: ordered.at(-1).day, predecessor: { token: predecessor.token,
      previousGenerationId: predecessor.previousGenerationId, legacyFingerprint: predecessor.legacyFingerprint },
    days: ordered.map(({ day, manifestId, manifestDigest }) => ({ day, manifestId, manifestDigest })),
    manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = sha256Hex(telemetryV12DomainManifestDigestInput(manifest));
  return manifest;
}
async function prepared(context, principal, days) {
  return domainManifest(await context.domain.createPredecessor(principal), days);
}
async function snapshot(context) {
  const result = {};
  for (const name of SNAPSHOT_TABLES) {
    result[name] = (await pool.query(`SELECT count(*)::integer AS n,
      md5(COALESCE(string_agg(row::text,E'\\n' ORDER BY row::text),'')) AS digest FROM ${context.table(name)} row`)).rows[0];
  }
  return result;
}
async function head(context, principal) {
  return (await pool.query(`SELECT generation_id,revision::integer AS revision FROM ${context.table("telemetry_v12_domain_heads")}
    WHERE participant_id=$1`, [principal.participantId])).rows[0];
}
async function links(context) {
  return (await pool.query(`SELECT kind,stream,before_record_json,after_record_json,
    encode(before_digest,'hex') AS before_digest,encode(after_digest,'hex') AS after_digest,
    generation_id,activation_manifest_digest,device_id FROM ${context.table("telemetry_classification_correction_links")} ORDER BY id`)).rows;
}
async function journalCount(context) {
  return (await pool.query(`SELECT count(*)::integer AS n FROM ${context.table("storage_ingestion_changes")}
    WHERE source_id=$1`, [SOURCE_ID])).rows[0].n;
}
async function immutableOriginals(context, days) {
  const ids = days.flatMap(day => day.ids);
  const records = await modules.readPostgresClassificationRecords(pool, `"${context.schema}"`, 12, ids);
  const raw = (await pool.query(`SELECT record.*,row_to_json(usage) AS usage,
      (SELECT COALESCE(jsonb_agg(tools ORDER BY tools.tool_class_id),'[]')
       FROM ${context.table("telemetry_v12_typed_session_tools")} tools WHERE tools.record_id=record.id) AS tools
    FROM ${context.table("telemetry_v12_typed_records")} record
    LEFT JOIN ${context.table("telemetry_v12_typed_usage")} usage ON usage.record_id=record.id
    WHERE record.id=ANY($1::bigint[]) ORDER BY record.id`, [ids])).rows;
  const chunks = (await pool.query(`SELECT * FROM ${context.table("telemetry_v12_chunks")}
    WHERE id=ANY($1::text[]) ORDER BY id`, [days.map(day => day.chunkRowId)])).rows;
  return { canonical: [...records].map(([id, row]) => [id, row.recordJson, row.canonicalDigest]), raw, chunks };
}
async function evidence(context, participant, days = { fromDay: DAY_ONE, throughDay: DAY_THREE }) {
  const source = { pool, schema: context.schema, nowMs: Date.now() };
  const range = { ownerDigest: participant.ownerDigest, ...days };
  return {
    fingerprints: await modules.occurrences.readOwnerDayFingerprints(source, range),
    watermark: (await modules.occurrences.readOwnerWatermarks(source, [participant.ownerDigest])).get(participant.ownerDigest),
    usage: await modules.occurrences.readOwnerOccurrences(source, { ...range, stream: "usage" }),
    session: await modules.occurrences.readOwnerOccurrences(source, { ...range, stream: "session" }),
  };
}
function only(map, day) { const rows = map.get(day); assert.equal(rows?.length, 1); return rows[0]; }
async function refused(context, principal, manifest) {
  const before = await snapshot(context);
  await assert.rejects(context.domain.activate(principal, manifest), CONFLICT);
  assert.deepEqual(await snapshot(context), before, "refusal rolls back links, head, predecessor consumption and journal");
}

test("classification corrections activate atomically across session days and preserve original evidence", {
  skip: !PG_TEST_SOCKET, timeout: 120_000,
}, async () => {
  assert.ok(REVIEWED_CODEX_MODEL_IDS.includes(MODEL));
  assert.equal(usage().accountPlanAttribution.planType, "promax");
  await withSchema(async context => {
    const participant = await seedParticipant(context, "owner");
    const principal = await seedDevice(context, participant, "original");
    const otherDevice = await seedDevice(context, participant, "foreign");
    const originalSession = session(); const originalUsage = usage();
    // The session's first-event day is earlier than the usage record day.
    const sessionDay = await stage(context, principal, DAY_ONE, "session", originalSession);
    const usageDay = await stage(context, principal, DAY_TWO, "usage", originalUsage);
    const initialManifest = await prepared(context, principal, [sessionDay, usageDay]);
    const initial = await context.domain.activate(principal, initialManifest);
    assert.equal(initial.replay, false);
    assert.deepEqual(await head(context, principal), { generation_id: initial.generationId, revision: 1 });
    assert.equal((await links(context)).length, 0);
    const originals = await immutableOriginals(context, [sessionDay, usageDay]);
    const initialEvidence = await evidence(context, participant);
    assert.equal(JSON.parse(only(initialEvidence.usage, DAY_TWO).recordJson).modelId, "unknown");
    const initialJournal = await journalCount(context);

    // Device B supplies the same occurrence and clock with known labels while
    // A's unknown evidence is current. B may not classify A's occurrence.
    const foreignSession = await stage(context, otherDevice, DAY_ONE, "session", session("openai_codex"));
    const foreignUsage = await stage(context, otherDevice, DAY_TWO, "usage", usage({ provider: "openai_codex", modelId: MODEL }));
    await refused(context, otherDevice, await prepared(context, otherDevice, [foreignSession, foreignUsage]));

    // Known session staged first is harmless; publication before the later
    // usage-provider repair must refuse and leave every activation table fixed.
    const knownSession = session("openai_codex");
    const knownSessionDay = await stage(context, principal, DAY_ONE, "session", knownSession);
    await refused(context, principal, await prepared(context, principal, [knownSessionDay, usageDay]));
    assert.deepEqual(await immutableOriginals(context, [sessionDay, usageDay]), originals);

    const providerUsage = usage({ provider: "openai_codex" });
    const providerDay = await stage(context, principal, DAY_TWO, "usage", providerUsage);
    const intermediateManifest = await prepared(context, principal, [sessionDay, providerDay]);
    const intermediate = await context.domain.activate(principal, intermediateManifest);
    assert.equal(intermediate.replay, false);
    assert.deepEqual((await links(context)).map(row => row.kind), ["usage-provider"]);
    const intermediateEvidence = await evidence(context, participant);
    assert.equal(JSON.parse(only(intermediateEvidence.usage, DAY_TWO).recordJson).provider, "openai_codex");
    assert.equal(JSON.parse(only(intermediateEvidence.session, DAY_ONE).recordJson).provider, "unknown",
      "unknown session remains pending during provider-only activation");
    assert.notEqual(intermediateEvidence.fingerprints.get(DAY_TWO), initialEvidence.fingerprints.get(DAY_TWO));
    assert.equal(intermediateEvidence.fingerprints.get(DAY_ONE), initialEvidence.fingerprints.get(DAY_ONE));
    assert.notEqual(intermediateEvidence.watermark, initialEvidence.watermark);
    assert.equal(await journalCount(context), initialJournal + 1);

    const stale = await context.domain.createPredecessor(principal);
    const extraUnknown = await stage(context, principal, DAY_THREE, "usage", usage({
      eventId: `event:v2:${"d".repeat(64)}`, eventTime: `${DAY_THREE}T12:05:00.000Z`,
    }));
    await refused(context, principal, await prepared(context, principal, [knownSessionDay, providerDay, extraUnknown]));
    // Root admitted the exact READY original bound by the authenticated
    // current predecessor. No extra domain activation is needed for DAY_THREE.
    const allOriginalDays = [sessionDay, usageDay, extraUnknown];
    const allOriginals = await immutableOriginals(context, allOriginalDays);
    const extraKnown = await stage(context, principal, DAY_THREE, "usage", usage({
      eventId: `event:v2:${"d".repeat(64)}`, eventTime: `${DAY_THREE}T12:05:00.000Z`,
      provider: "openai_codex", modelId: MODEL,
    }));
    const knownUsage = usage({ provider: "openai_codex", modelId: MODEL });
    const knownUsageDay = await stage(context, principal, DAY_TWO, "usage", knownUsage);
    const finalManifest = await prepared(context, principal, [knownSessionDay, knownUsageDay, extraKnown]);
    const final = await context.domain.activate(principal, finalManifest);
    assert.equal(final.replay, false);
    assert.deepEqual(await head(context, principal), { generation_id: final.generationId, revision: 3 });
    assert.equal(await journalCount(context), initialJournal + 2);
    const accepted = await links(context);
    assert.equal(accepted.length, 4);
    assert.deepEqual(accepted.map(row => row.kind).sort(), ["session-provider", "usage-model", "usage-model-provider", "usage-provider"]);
    const providerLink = accepted.find(row => row.kind === "usage-provider");
    const modelLink = accepted.find(row => row.kind === "usage-model");
    const sessionLink = accepted.find(row => row.kind === "session-provider");
    assert.equal(providerLink.before_record_json, canonicalTelemetryV12Json(originalUsage));
    assert.equal(providerLink.after_record_json, canonicalTelemetryV12Json(providerUsage));
    assert.equal(modelLink.before_record_json, providerLink.after_record_json);
    assert.equal(modelLink.after_record_json, canonicalTelemetryV12Json(knownUsage));
    assert.equal(sessionLink.before_record_json, canonicalTelemetryV12Json(originalSession));
    assert.equal(sessionLink.after_record_json, canonicalTelemetryV12Json(knownSession));
    const combinedLink = accepted.find(row => row.kind === "usage-model-provider");
    assert.equal(combinedLink.before_record_json, canonicalTelemetryV12Json(usage({
      eventId: `event:v2:${"d".repeat(64)}`, eventTime: `${DAY_THREE}T12:05:00.000Z`,
    })));
    assert.equal(combinedLink.after_record_json, canonicalTelemetryV12Json(usage({
      eventId: `event:v2:${"d".repeat(64)}`, eventTime: `${DAY_THREE}T12:05:00.000Z`, provider: "openai_codex", modelId: MODEL,
    })));
    for (const row of accepted) {
      assert.equal(row.before_digest, sha256Hex(row.before_record_json));
      assert.equal(row.after_digest, sha256Hex(row.after_record_json));
      assert.equal(row.device_id, principal.deviceId);
    }
    for (const row of [modelLink, sessionLink, combinedLink]) {
      assert.equal(row.generation_id, final.generationId);
      assert.equal(row.activation_manifest_digest, finalManifest.manifestDigest);
    }
    const finalEvidence = await evidence(context, participant);
    const selected = JSON.parse(only(finalEvidence.usage, DAY_TWO).recordJson);
    assert.equal(selected.modelId, MODEL); assert.equal(selected.provider, "openai_codex");
    assert.deepEqual(selected.components, originalUsage.components);
    assert.equal(selected.totalInputContextTokens, originalUsage.totalInputContextTokens);
    assert.equal(JSON.parse(only(finalEvidence.session, DAY_ONE).recordJson).provider, "openai_codex");
    assert.notEqual(finalEvidence.fingerprints.get(DAY_ONE), intermediateEvidence.fingerprints.get(DAY_ONE));
    assert.notEqual(finalEvidence.fingerprints.get(DAY_TWO), intermediateEvidence.fingerprints.get(DAY_TWO));
    assert.notEqual(finalEvidence.watermark, intermediateEvidence.watermark);
    assert.deepEqual(await immutableOriginals(context, [sessionDay, usageDay]), originals);
    assert.deepEqual(await immutableOriginals(context, allOriginalDays), allOriginals);

    // A retry after an assumed lost commit response returns the accepted
    // activation without another link/head/journal write. A historical domain
    // request is no longer current and must refuse with its provenance fixed.
    let quiet = await snapshot(context);
    const retry = await context.domain.activate(principal, finalManifest);
    assert.equal(retry.replay, true); assert.equal(retry.generationId, final.generationId);
    assert.deepEqual(await snapshot(context), quiet);
    await refused(context, principal, initialManifest);
    await refused(context, principal, domainManifest(stale, [sessionDay, knownUsageDay, extraKnown]));
    await refused(context, principal, await prepared(context, principal, [sessionDay, usageDay, extraKnown]));

    const knownReplacement = await stage(context, principal, DAY_TWO, "usage", { ...knownUsage, modelId: "gpt-5.6-sol" });
    await refused(context, principal, await prepared(context, principal, [knownSessionDay, knownReplacement, extraKnown]));
    const quantityChange = await stage(context, principal, DAY_TWO, "usage", { ...knownUsage, totalInputContextTokens: 1001 });
    await refused(context, principal, await prepared(context, principal, [knownSessionDay, quantityChange, extraKnown]));
    assert.deepEqual(await head(context, principal), { generation_id: final.generationId, revision: 3 });
    assert.equal((await links(context)).length, 4);
    assert.equal(await journalCount(context), initialJournal + 2);
    assert.deepEqual(await immutableOriginals(context, [sessionDay, usageDay]), originals);
    assert.deepEqual(await immutableOriginals(context, allOriginalDays), allOriginals);
    const finalReadback = await evidence(context, participant);
    assert.deepEqual(finalReadback.fingerprints, finalEvidence.fingerprints);
    assert.equal(finalReadback.watermark, finalEvidence.watermark);
    const count = (await pool.query(`SELECT count(*)::integer AS n FROM ${context.table("telemetry_v12_typed_records")}`)).rows[0].n;
    assert.equal(count, 11, "the entire bounded gate uses eleven synthetic records");
    quiet = await snapshot(context);
    await assert.rejects(pool.query(`UPDATE ${context.table("telemetry_classification_correction_links")}
      SET kind=kind WHERE kind='usage-model'`), { code: "P1005", message: "telemetry_classification_correction_retained" });
    assert.deepEqual(await snapshot(context), quiet);
  });
});

const q = (schema, name) => `"${schema}"."${name}"`;
function uploadSecretHash(id, secret) { return createHash("sha256").update(`app-usagemonitor/device-upload/v1\0${id}\0${secret}`).digest(); }

function makeV11Day(day, recordsByStream, parserVersion) {
  const consent = telemetryV11RequiredConsent();
  const chunks = [];
  for (const stream of ["quota", "session", "usage"]) {
    const source = recordsByStream[stream] ?? [];
    for (let offset = 0; offset < source.length; offset += 200) {
      const records = source.slice(offset, offset + 200);
      chunks.push({
        schemaVersion: "telemetry-contribution-v1.1", manifestDigest: "0".repeat(64),
        chunkId: `${stream}:${day}:${offset / 200}`, chunkRevision: 1,
        chunkDigest: sha256Hex(canonicalTelemetryV11Json(records)), parserVersion, consent, records,
      });
    }
  }
  const manifest = {
    schemaVersion: "telemetry-day-manifest-v1.1", day, parserVersion, consent,
    chunks: chunks.map((chunk) => ({ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: chunk.records.length })),
    excluded: { quota: 0, session: 0, usage: 0 }, manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = sha256Hex(telemetryV11DayManifestDigestInput(manifest));
  for (const chunk of chunks) chunk.manifestDigest = manifest.manifestDigest;
  return { manifest, chunks };
}

function v11DomainManifest(predecessor, days) {
  const ordered = [...days].sort((left, right) => left.day.localeCompare(right.day));
  const value = {
    schemaVersion: "telemetry-domain-manifest-v1.1",
    fromDay: ordered[0].day, throughDay: ordered.at(-1).day,
    predecessor: {
      token: predecessor.token, previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint,
    },
    days: ordered.map((entry) => ({ day: entry.day, manifestId: entry.manifestId, manifestDigest: entry.manifestDigest })),
    manifestDigest: "0".repeat(64),
  };
  value.manifestDigest = sha256Hex(telemetryV11DomainManifestDigestInput(value));
  return value;
}


async function persistDirect(modules, pool, schema, owner, chunk, options) {
  const authorizationId = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const envelopeDigest = randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO ${q(schema.primarySchema, "device_upload_authorizations")} (
       id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
       body_bytes, content_type, state, issued_at, expires_at
     ) VALUES ($1, $2, $3, $4, $5, 256, 'application/json', 'unused', $6, $7)`,
    [authorizationId, owner.participantId, owner.deviceId, uploadSecretHash(authorizationId, secret), envelopeDigest,
      new Date(Date.now() - 1_000).toISOString(), new Date(Date.now() + 5 * 60_000).toISOString()],
  );
  const claimed = await modules.transport.claimPostgresDeviceUploadAuthorization(pool,
    `Upload um_device_upload_${authorizationId}.${secret}`,
    { envelopeDigest, bodyBytes: 256, contentType: "application/json" },
    { schema, accountlessAuthorizationVersion: "v1.1" });
  const chunkRowId = `chunk:${randomUUID()}`;
  const objectKey = `telemetry/v11-${randomUUID()}`;
  await modules.live.registerPostgresTelemetryV11PendingObject(pool, chunkRowId, objectKey, Date.now(), options);
  return modules.live.persistPostgresTypedV11StagedChunk(pool, owner.principal, chunk, {
    chunkRowId, r2Key: objectKey, envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId,
  }, Date.now(), options);
}

/** Register a day, stage every chunk, and return its (now ready) candidate. */
async function stageDay(modules, pool, schema, owner, prepared, options) {
  await modules.live.registerPostgresTelemetryV11DayManifest(pool, owner.principal, prepared.manifest, Date.now(), options);
  for (const chunk of prepared.chunks) await persistDirect(modules, pool, schema, owner, chunk, options);
  const ready = await modules.live.registerPostgresTelemetryV11DayManifest(
    pool, owner.principal, prepared.manifest, Date.now(), options,
  );
  assert.equal(ready.state, "ready");
  return { day: ready.day, manifestId: ready.manifestId, manifestDigest: ready.manifestDigest };
}


async function seedTypedV1Chunk(modules, pool, primarySchema, owner, { day, stream, chunkSeq, records }) {
  const table = (name) => q(primarySchema, name);
  const now = new Date().toISOString();
  const authorizationId = randomUUID();
  const chunkRowId = `chunk:${randomUUID()}`;
  const r2Key = `synthetic/${chunkRowId}`;
  await pool.query(
    `INSERT INTO ${table("device_upload_authorizations")} (
       id, participant_id, issued_by_device_id, secret_hash, envelope_digest, body_bytes, content_type,
       state, issued_at, expires_at, consumed_at
     ) VALUES ($1, $2, $3, $4, $5, 256, 'application/json', 'consumed', $6, $7, $6)`,
    [authorizationId, owner.participantId, owner.deviceId, randomBytes(32), randomBytes(32).toString("hex"),
      now, new Date(Date.now() + DAY_MS).toISOString()],
  );
  await pool.query(
    `INSERT INTO ${table("pending_objects")} (contribution_id, object_key, object_kind) VALUES ($1, $2, 'telemetry_v1')`,
    [chunkRowId, r2Key],
  );
  await pool.query(
    `INSERT INTO ${table("telemetry_v1_chunks")} (
       id, participant_id, device_id, stream, chunk_day, chunk_seq, revision, chunk_digest, envelope_digest,
       parser_version, record_count, accepted_record_count, r2_key, device_upload_authorization_id, created_at
     ) VALUES ($1, $2, $3, $4, $5::date, $6, 1, $7, $8, 'synthetic-typed-v1', $9, $9, $10, $11, $12)`,
    [chunkRowId, owner.participantId, owner.deviceId, stream, day, chunkSeq,
      sha256Hex(canonicalTelemetryV11Json(records)), randomBytes(32).toString("hex"), records.length, r2Key,
      authorizationId, now],
  );
  async function admit({ ownerDigest, firstSourceRowId }) {
    const { codec } = modules;
    const original = (value) => Buffer.from(codec.encodeTypedTelemetryId(value));
    const state = (await pool.query(
      `SELECT namespace_id::text AS namespace_id, source_namespace FROM ${table("typed_v1_admission_state")} WHERE id = 1`,
    )).rows[0];
    const ns = state.namespace_id;
    const ensure = async (insertSql, selectSql, values) => {
      await pool.query(insertSql, values);
      return (await pool.query(selectSql, values)).rows[0].id;
    };
    const ownerId = await ensure(
      `INSERT INTO ${table("typed_telemetry_owners")} (namespace_id, original_id) VALUES ($1, $2)
       ON CONFLICT (namespace_id, original_id) DO NOTHING`,
      `SELECT id::text AS id FROM ${table("typed_telemetry_owners")} WHERE namespace_id = $1 AND original_id = $2`,
      [ns, original(owner.participantId)],
    );
    await pool.query(
      `INSERT INTO ${table("typed_telemetry_owner_memberships")} (
         namespace_id, source_format, owner_id, participant_id, source_namespace
       ) VALUES ($1, 10, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [ns, ownerId, owner.participantId, state.source_namespace],
    );
    await pool.query(
      `INSERT INTO ${table("typed_telemetry_devices")} (namespace_id, owner_id, original_id) VALUES ($1, $2, $3)
       ON CONFLICT (namespace_id, original_id) DO NOTHING`,
      [ns, ownerId, original(owner.deviceId)],
    );
    const deviceStorageId = (await pool.query(
      `SELECT id::text AS id FROM ${table("typed_telemetry_devices")} WHERE namespace_id = $1 AND original_id = $2`,
      [ns, original(owner.deviceId)],
    )).rows[0].id;
    const streamCode = { usage: 1, quota: 2, session: 3 }[stream];
    const dayNumber = Date.parse(`${day}T00:00:00.000Z`) / DAY_MS;
    const typedChunkId = (await pool.query(
      `INSERT INTO ${table("typed_telemetry_chunks")} (
         namespace_id, format, owner_id, device_id, manifest_id, original_id, stream, chunk_day
       ) VALUES ($1, 10, $2, $3, NULL, $4, $5, $6) RETURNING id::text AS id`,
      [ns, ownerId, deviceStorageId, original(chunkRowId), streamCode, dayNumber],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO ${table("typed_v1_chunk_allocations")} (
         chunk_id, namespace_id, chunk_original, first_source_row_id, record_count
       ) VALUES ($1, $2, $3, $4, $5)`,
      [chunkRowId, ns, original(chunkRowId), firstSourceRowId, records.length],
    );
    const word = (value) => ensure(
      `INSERT INTO ${table("typed_telemetry_dictionary")} (value) VALUES ($1) ON CONFLICT (value) DO NOTHING`,
      `SELECT id::text AS id FROM ${table("typed_telemetry_dictionary")} WHERE value = $1`, [value],
    );
    const canonicalDigests = [];
    for (const [index, record] of records.entries()) {
      const fields = codec.encodeTypedTelemetryRecord("v1", record);
      const canonical = codec.typedTelemetryCanonicalRecords(fields).canonicalRecord;
      const digest = createHash("sha256").update(canonical).digest();
      canonicalDigests.push(digest.toString("hex"));
      const recordId = (await pool.query(
        `INSERT INTO ${table("typed_telemetry_records")} (
           namespace_id, format, source_row_id, owner_id, device_id, chunk_id, manifest_id, stream,
           occurrence_id, observed_at_ms, observed_day, provider_id, canonical_digest
         ) VALUES ($1, 10, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10, $11) RETURNING id::text AS id`,
        [ns, firstSourceRowId + index, ownerId, deviceStorageId, typedChunkId, streamCode,
          Buffer.from(fields.occurrenceId), fields.observedAtMs, Math.floor(fields.observedAtMs / DAY_MS),
          await word(fields.provider), digest],
      )).rows[0].id;
      if (fields.usage) {
        const usage = fields.usage;
        const sessionId = await ensure(
          `INSERT INTO ${table("typed_telemetry_identifiers")} (namespace_id, owner_id, value) VALUES ($1, $2, $3)
           ON CONFLICT (namespace_id, owner_id, value) DO NOTHING`,
          `SELECT id::text AS id FROM ${table("typed_telemetry_identifiers")}
            WHERE namespace_id = $1 AND owner_id = $2 AND value = $3`,
          [ns, ownerId, Buffer.from(usage.sessionId)],
        );
        await pool.query(
          `INSERT INTO ${table("typed_telemetry_usage")} (
             record_id, session_id, model_id, speed_mode_id, api_service_tier_id, surface_id, billing_surface_id,
             reasoning_effort_id, agent_scope_id, outcome_id, attribution_id, total_input_context_tokens,
             input_uncached_tokens, input_cache_read_tokens, input_cache_write_tokens, output_text_tokens,
             output_reasoning_tokens, output_combined_tokens
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11, $12, $13, $14, $15, $16, $17)`,
          [recordId, sessionId, await word(usage.modelId), await word(usage.speedMode), await word(usage.apiServiceTier),
            await word(usage.surface), await word(usage.billingSurface), await word(usage.reasoningEffort),
            await word(usage.agentScope), await word(usage.outcome), usage.totalInputContextTokens,
            usage.components.inputUncachedTokens, usage.components.inputCacheReadTokens,
            usage.components.inputCacheWriteTokens, usage.components.outputTextTokens,
            usage.components.outputReasoningTokens, usage.components.outputCombinedTokens],
        );
      }
      for (const [tool, total] of Object.entries(fields.tools ?? {})) {
        await pool.query(
          `INSERT INTO ${table("typed_telemetry_session_tools")} (record_id, tool_class_id, count) VALUES ($1, $2, $3)`,
          [recordId, await word(tool), total],
        );
      }
      await pool.query(
        `INSERT INTO ${table("typed_v1_record_admissions")} (typed_record_id, chunk_id) VALUES ($1, $2)`,
        [recordId, chunkRowId],
      );
    }
    await pool.query(
      `INSERT INTO ${table("typed_v1_event_sources")} (
         event_digest, owner_digest, participant_id, chunk_id, source_namespace
       ) VALUES ($1, $2, $3, $4, $5)`,
      [randomBytes(32).toString("hex"), ownerDigest, owner.participantId, chunkRowId, state.source_namespace],
    );
    return canonicalDigests;
  }
  return { chunkRowId, admit };
}

test("exact current-predecessor READY unknown evidence corrects in one activation without a prior domain", {
  skip: !PG_TEST_SOCKET, timeout: 120_000,
}, async () => {
  await withSchema(async context => {
    const participant = await seedParticipant(context, "ready-only");
    const principal = await seedDevice(context, participant, "ready-only");
    const accepted = await stage(context, principal, DAY_ONE, "usage", usage({
      eventTime: `${DAY_ONE}T12:05:00.000Z`, provider: "openai_codex",
    }));
    await context.domain.activate(principal, await prepared(context, principal, [accepted]));
    const original = await stage(context, principal, DAY_TWO, "usage", usage({ eventId: `event:v2:${"e".repeat(64)}` }));
    const candidate = await stage(context, principal, DAY_TWO, "usage", usage({
      eventId: `event:v2:${"e".repeat(64)}`, provider: "openai_codex", modelId: MODEL,
    }));
    const predecessor = await context.domain.createPredecessor(principal);
    const pinned = (await pool.query(`SELECT days_json FROM ${context.table("telemetry_v12_domain_predecessors")}
      WHERE token_hash=$1`, [sha256Hex(predecessor.token)])).rows[0];
    assert.ok(JSON.parse(pinned.days_json).some(day => day.manifestId === original.manifestId),
      "the exact READY original is present in the real predecessor vector");
    assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${context.table("telemetry_v12_domain_days")}
      WHERE manifest_id=$1`, [original.manifestId])).rows[0].n, 0);
    const retained = await immutableOriginals(context, [original]);
    const value = domainManifest(predecessor, [accepted, candidate]);
    // The schema itself refuses corruption of an accepted-head vector.
    const beforeCorruptionAttempt = await snapshot(context);
    await assert.rejects(pool.query(`UPDATE ${context.table("telemetry_v12_domain_days")}
      SET manifest_digest=$1 WHERE manifest_id=$2`, ["f".repeat(64), accepted.manifestId]),
    { code: "P1005", message: "telemetry_domain_immutable" });
    assert.deepEqual(await snapshot(context), beforeCorruptionAttempt);
    // Adversarial storage damage is scoped to this disposable schema and
    // one guard. Activation runs with that guard enabled, as normal.
    const alterGuard = state => pool.query(`ALTER TABLE ${context.table("telemetry_v12_domain_days")}
      ${state} TRIGGER telemetry_v12_domain_day_immutable_guard`);
    try {
      await alterGuard("DISABLE");
      try {
        await pool.query(`UPDATE ${context.table("telemetry_v12_domain_days")}
          SET manifest_digest=$1 WHERE manifest_id=$2`, ["f".repeat(64), accepted.manifestId]);
      } finally { await alterGuard("ENABLE"); }
      await refused(context, principal, value);
    } finally {
      await alterGuard("DISABLE");
      try {
        await pool.query(`UPDATE ${context.table("telemetry_v12_domain_days")}
          SET manifest_digest=$1 WHERE manifest_id=$2`, [accepted.manifestDigest, accepted.manifestId]);
      } finally { await alterGuard("ENABLE"); }
    }
    assert.deepEqual(await snapshot(context), beforeCorruptionAttempt);
    const wrongManifest = structuredClone(value);
    wrongManifest.days[1].manifestDigest = "f".repeat(64);
    wrongManifest.manifestDigest = sha256Hex(telemetryV12DomainManifestDigestInput(wrongManifest));
    const quiet = await snapshot(context);
    await assert.rejects(context.domain.activate(principal, wrongManifest), { status: 409, code: "TELEMETRY_MANIFEST_INCOMPLETE" });
    assert.deepEqual(await snapshot(context), quiet);
    const stale = await context.domain.createPredecessor(principal);
    const activated = await context.domain.activate(principal, value);
    assert.equal(activated.replay, false);
    const proof = await links(context);
    assert.equal(proof.length, 1);
    assert.equal(proof[0].kind, "usage-model-provider");
    assert.equal(proof[0].before_record_json, retained.canonical[0][1]);
    assert.equal(proof[0].generation_id, activated.generationId);
    assert.deepEqual(await head(context, principal), { generation_id: activated.generationId, revision: 2 });
    assert.deepEqual(await immutableOriginals(context, [original]), retained);
    const afterActivation = await snapshot(context);
    assert.equal((await context.domain.activate(principal, domainManifest(stale, [accepted, candidate]))).replay, true);
    assert.deepEqual(await snapshot(context), afterActivation);
    const later = await stage(context, principal, DAY_THREE, "usage", usage({
      eventId: `event:v2:${"f".repeat(64)}`, eventTime: `${DAY_THREE}T12:05:00.000Z`,
      provider: "openai_codex", modelId: MODEL,
    }));
    await refused(context, principal, domainManifest(stale, [accepted, candidate, later]));
  });
});

async function archiveMethod1(context, participant, storageId, record, id) {
  const assertion = await modules.reconciliation.prepareAnalyticsReplayUsageCorrectionAssertion({
    format: "v1", recordJson: canonicalTelemetryV11Json(record),
  });
  const capturedAt = Date.now();
  await pool.query(`INSERT INTO ${context.table("telemetry_usage_correction_history")}(
    id,participant_id,owner_digest,owner_revision,authority_epoch,source_format,namespace_id,owner_id,device_id,
    chunk_id,manifest_id,source_storage_row_id,source_row_id,occurrence_id,event_time_ms,provider_id,session_id,
    model_id,speed_mode_id,api_service_tier_id,surface_id,billing_surface_id,reasoning_effort_id,agent_scope_id,
    outcome_id,attribution_id,total_input_context_tokens,input_uncached_tokens,input_cache_read_tokens,
    input_cache_write_tokens,output_text_tokens,output_reasoning_tokens,output_combined_tokens,
    source_chunk_digest,source_event_digest,record_digest,base_digest,captured_at_ms)
    SELECT $1,$2,decode($3,'hex'),1,1,10,r.namespace_id,r.owner_id,r.device_id,r.chunk_id,NULL,r.id,r.source_row_id,
      r.occurrence_id,r.observed_at_ms,r.provider_id,u.session_id,u.model_id,u.speed_mode_id,u.api_service_tier_id,
      u.surface_id,u.billing_surface_id,u.reasoning_effort_id,u.agent_scope_id,u.outcome_id,NULL,$4,
      u.input_uncached_tokens,u.input_cache_read_tokens,u.input_cache_write_tokens,u.output_text_tokens,
      u.output_reasoning_tokens,u.output_combined_tokens,decode(header.chunk_digest,'hex'),decode(receipt.event_digest,'hex'),
      decode($5,'hex'),decode($6,'hex'),$7
    FROM ${context.table("typed_telemetry_records")} r
    JOIN ${context.table("typed_telemetry_usage")} u ON u.record_id=r.id
    JOIN ${context.table("typed_v1_record_admissions")} admission ON admission.typed_record_id=r.id
    JOIN ${context.table("telemetry_v1_chunks")} header ON header.id=admission.chunk_id
    JOIN ${context.table("typed_v1_event_sources")} receipt ON receipt.chunk_id=header.id
    WHERE r.id=$8`, [id, participant.participantId, participant.ownerDigest, record.totalInputContextTokens,
    assertion.recordDigest, assertion.baseDigest, capturedAt, storageId]);
  await pool.query(`INSERT INTO ${context.table("telemetry_usage_correction_facts")}(id,history_id,method_version,captured_at_ms)
    VALUES ($1,$1,1,$2)`, [id, capturedAt]);
}
async function archived(context) {
  return { history: (await pool.query(`SELECT * FROM ${context.table("telemetry_usage_correction_history")} ORDER BY id`)).rows,
    facts: (await pool.query(`SELECT * FROM ${context.table("telemetry_usage_correction_facts")} ORDER BY id`)).rows };
}
async function enableV12(context, principal) {
  await pool.query(`INSERT INTO ${context.table("telemetry_v12_device_capabilities")}(
    participant_id,device_id,telemetry_schema_version,field_dictionary_version,privacy_contract_version,state,consented_at)
    VALUES ($1,$2,'telemetry-contribution-v1.2','telemetry-v1.2-registry-2026-09-20.1',
      'ongoing-privacy-safe-telemetry-v1.2','accepted',clock_timestamp())`, [principal.participantId, principal.deviceId]);
}

test("v11 classification links compose retained v1 and exact method-1 archives while preserving differing variants", {
  skip: !PG_TEST_SOCKET, timeout: 120_000,
}, async () => {
  await withSchema(async context => {
    const legacyDay = new Date().toISOString().slice(0, 10);
    const legacyEvidence = () => evidence(context, participant, { fromDay: legacyDay, throughDay: legacyDay });
    const participant = await seedParticipant(context, "legacy");
    const principal = await seedDevice(context, participant, "legacy", { v12: false });
    const owner = { ...principal, principal };
    const options = { ...context.options, sourceNamespace: SOURCE_NAMESPACE };
    await pool.query(`UPDATE ${context.table("telemetry_transport_formats")} SET lifecycle='accepted'
      WHERE schema_version='telemetry-contribution-v1.1'`);
    await modules.live.initializePostgresTypedV11Admission(pool, options);
    await pool.query(`INSERT INTO ${context.table("typed_v1_admission_state")}(
      id,source_namespace,namespace_id,runtime_contract_version,next_source_row_id)
      SELECT 1,source_namespace,namespace_id,1,3 FROM ${context.table("typed_v11_admission_state")} WHERE id=1`);
    const v11Records = ["a", "b"].map((fill, index) => {
      const { boundaryFlags, tieOrder, cacheWriteTtl, ...record } = usage({
        provider: "openai_codex", eventId: `event:v2:${fill.repeat(64)}`,
        eventTime: `${legacyDay}T12:05:0${index}.000Z`,
        components: { ...usage().components, inputCacheWriteTokens: null },
      });
      return { ...record, schemaVersion: "usage-event-v1.1" };
    });
    const legacyRecords = v11Records.map(record => {
      const projection = modules.compatibility.telemetryV11LegacyProjection("usage", record);
      assert.ok(projection); return JSON.parse(projection.canonicalRecord);
    });
    const legacy = await seedTypedV1Chunk(modules, pool, context.schema, owner,
      { day: legacyDay, stream: "usage", chunkSeq: 0, records: legacyRecords });
    await legacy.admit({ ownerDigest: participant.ownerDigest, firstSourceRowId: 1 });
    await modules.live.grantPostgresTelemetryV11Consent(pool, { ...principal, sessionId: participant.sessionId },
      telemetryV11RequiredConsent(), Date.now(), options);
    const rawIds = (await pool.query(`SELECT id::text FROM ${context.table("typed_telemetry_records")}
      WHERE format=10 ORDER BY source_row_id`)).rows.map(row => row.id);
    assert.equal(rawIds.length, 2);
    const domain = modules.live.createPostgresTelemetryV11Domain(pool, options);
    const beforeDay = await stageDay(modules, pool, context.options.schema, owner,
      makeV11Day(legacyDay, { usage: v11Records }, "synthetic-classification-v11"), options);
    const beforeManifest = v11DomainManifest(await domain.createPredecessor(principal), [beforeDay]);
    assert.equal((await domain.activate(principal, beforeManifest)).replay, false);
    await archiveMethod1(context, participant, rawIds[0], legacyRecords[0], 1);
    await archiveMethod1(context, participant, rawIds[1], legacyRecords[1], 2);
    await archiveMethod1(context, participant, rawIds[1], { ...legacyRecords[1], totalInputContextTokens: 1001 }, 3);
    const archiveBytes = await archived(context);
    const before = await legacyEvidence();
    const byId = map => new Map(map.get(legacyDay).map(row => [row.occurrenceId, row]));
    assert.equal(byId(before.usage).get(v11Records[0].eventId).status, "compatible");
    assert.equal(byId(before.usage).get(v11Records[1].eventId).status, "conflict");
    assert.equal(byId(before.usage).get(v11Records[1].eventId).recordJson, null);
    const knownRecords = v11Records.map(record => ({ ...record, modelId: MODEL }));
    const knownDay = await stageDay(modules, pool, context.options.schema, owner,
      makeV11Day(legacyDay, { usage: knownRecords }, "synthetic-classification-v11"), options);
    const classification = await domain.activate(principal,
      v11DomainManifest(await domain.createPredecessor(principal), [knownDay]));
    assert.equal(classification.replay, false);
    const afterV11 = await legacyEvidence();
    const exact = byId(afterV11.usage).get(v11Records[0].eventId);
    assert.equal(exact.status, "compatible", "an exact linked original composes its immutable archived method-1 fact");
    assert.equal(JSON.parse(exact.recordJson).modelId, MODEL);
    const differing = byId(afterV11.usage).get(v11Records[1].eventId);
    assert.equal(differing.status, "conflict");
    assert.equal(differing.recordJson, null, "the unlinked differing archive remains explicit conflict");
    assert.deepEqual(await archived(context), archiveBytes);
    const correctedLinks = await links(context);
    assert.equal(correctedLinks.length, 4, "each retained v1 and active v11 original has an exact classification link");
    assert.deepEqual(correctedLinks.map(row => row.kind), Array(4).fill("usage-model"));
    for (const row of correctedLinks) assert.equal(JSON.parse(row.before_record_json).modelId, "unknown");
    await enableV12(context, principal);
    const v12Records = knownRecords.map(record => ({ ...record, schemaVersion: "usage-event-v1.2",
      boundaryFlags: 1, tieOrder: null, cacheWriteTtl: null }));
    const v12Day = await stage(context, principal, legacyDay, "usage", v12Records);
    const v12Manifest = await prepared(context, principal, [v12Day]);
    assert.equal((await context.domain.activate(principal, v12Manifest)).replay, false);
    const afterV12 = await legacyEvidence();
    const exactV12 = byId(afterV12.usage).get(v11Records[0].eventId);
    assert.equal(exactV12.status, "compatible");
    assert.equal(JSON.parse(exactV12.recordJson).modelId, MODEL);
    const differingV12 = byId(afterV12.usage).get(v11Records[1].eventId);
    assert.equal(differingV12.status, "conflict");
    assert.equal(differingV12.recordJson, null);
    assert.deepEqual(await archived(context), archiveBytes);
    assert.notEqual(afterV12.watermark, afterV11.watermark);
  }, "active");
});

test("session provider closure includes active method-1 archives captured before usage repair", {
  skip: !PG_TEST_SOCKET, timeout: 120_000,
}, async () => {
  await withSchema(async context => {
    const options = { ...context.options, sourceNamespace: SOURCE_NAMESPACE };
    await pool.query(`UPDATE ${context.table("telemetry_transport_formats")} SET lifecycle='accepted'
      WHERE schema_version='telemetry-contribution-v1.1'`);
    await modules.live.initializePostgresTypedV11Admission(pool, options);
    await pool.query(`INSERT INTO ${context.table("typed_v1_admission_state")}(
      id,source_namespace,namespace_id,runtime_contract_version,next_source_row_id)
      SELECT 1,source_namespace,namespace_id,1,3 FROM ${context.table("typed_v11_admission_state")} WHERE id=1`);
    for (const [index, differingArchive] of [false, true].entries()) {
      const participant = await seedParticipant(context, differingArchive ? "archive-differing" : "archive-exact");
      const principal = await seedDevice(context, participant, "archive-session", { v12: false });
      const originalUsage = usage({ totalInputContextTokens: null,
        components: { ...usage().components, inputCacheWriteTokens: null }, cacheWriteTtl: null });
      const { boundaryFlags, tieOrder, cacheWriteTtl, ...common } = originalUsage;
      const projection = modules.compatibility.telemetryV11LegacyProjection("usage", { ...common, schemaVersion: "usage-event-v1.1" });
      assert.ok(projection);
      const legacyRecord = JSON.parse(projection.canonicalRecord);
      const legacy = await seedTypedV1Chunk(modules, pool, context.schema, { ...principal, principal },
        { day: DAY_TWO, stream: "usage", chunkSeq: 0, records: [legacyRecord] });
      await legacy.admit({ ownerDigest: participant.ownerDigest, firstSourceRowId: index + 1 });
      const rawId = (await pool.query(`SELECT r.id::text FROM ${context.table("typed_telemetry_records")} r
        JOIN ${context.table("typed_v1_record_admissions")} a ON a.typed_record_id=r.id WHERE a.chunk_id=$1`,
      [legacy.chunkRowId])).rows[0].id;
      const retainedLegacy = async () => ({
        records: [...await modules.readPostgresClassificationRecords(pool, `"${context.schema}"`, 10, [rawId])],
        rows: (await pool.query(`SELECT r.*,row_to_json(u) AS usage FROM ${context.table("typed_telemetry_records")} r
          JOIN ${context.table("typed_telemetry_usage")} u ON u.record_id=r.id WHERE r.id=$1`, [rawId])).rows,
        headers: (await pool.query(`SELECT * FROM ${context.table("telemetry_v1_chunks")} WHERE id=$1`, [legacy.chunkRowId])).rows,
        receipts: (await pool.query(`SELECT * FROM ${context.table("typed_v1_event_sources")} WHERE chunk_id=$1`, [legacy.chunkRowId])).rows,
      });
      await enableV12(context, principal);
      const originalSession = await stage(context, principal, DAY_ONE, "session", session());
      const originalDay = await stage(context, principal, DAY_TWO, "usage", originalUsage);
      const first = await context.domain.activate(principal, await prepared(context, principal, [originalSession, originalDay]));
      assert.equal(first.replay, false);
      const originalBytes = await immutableOriginals(context, [originalSession, originalDay]);
      const legacyBytes = await retainedLegacy();
      await archiveMethod1(context, participant, rawId, legacyRecord, index * 2 + 1);
      if (differingArchive) {
        await archiveMethod1(context, participant, rawId, { ...legacyRecord, totalInputContextTokens: 1001 }, index * 2 + 2);
      }
      const archiveBytes = await archived(context);
      const repairedUsage = await stage(context, principal, DAY_TWO, "usage", { ...originalUsage, provider: "openai_codex", modelId: MODEL });
      const repaired = await context.domain.activate(principal, await prepared(context, principal, [originalSession, repairedUsage]));
      assert.equal(repaired.replay, false, "active archived variants do not block usage repair while the session is unknown");
      assert.deepEqual(await head(context, principal), { generation_id: repaired.generationId, revision: 2 });
      const ownerLinks = (await links(context)).filter(row => row.device_id === principal.deviceId);
      assert.equal(ownerLinks.length, 2, "retained v1 and original v12 usage each carry their own exact correction link");
      assert.ok(ownerLinks.every(row => row.kind === "usage-model-provider"));
      assert.equal(JSON.parse(only((await evidence(context, participant)).session, DAY_ONE).recordJson).provider, "unknown");
      assert.deepEqual(await archived(context), archiveBytes);
      const knownSession = await stage(context, principal, DAY_ONE, "session", session("openai_codex"));
      const finalManifest = await prepared(context, principal, [knownSession, repairedUsage]);
      if (differingArchive) {
        await refused(context, principal, finalManifest);
        assert.deepEqual(await head(context, principal), { generation_id: repaired.generationId, revision: 2 });
        assert.equal(JSON.parse(only((await evidence(context, participant)).session, DAY_ONE).recordJson).provider, "unknown");
        assert.equal((await links(context)).filter(row => row.device_id === principal.deviceId).length, 2);
      } else {
        const final = await context.domain.activate(principal, finalManifest);
        assert.equal(final.replay, false, "an exact physical archive resolves its own accepted usage link for whole-session closure");
        assert.deepEqual(await head(context, principal), { generation_id: final.generationId, revision: 3 });
        assert.equal(JSON.parse(only((await evidence(context, participant)).session, DAY_ONE).recordJson).provider, "openai_codex");
        assert.equal((await links(context)).filter(row => row.device_id === principal.deviceId).length, 3);
      }
      assert.deepEqual(await archived(context), archiveBytes);
      assert.deepEqual(await immutableOriginals(context, [originalSession, originalDay]), originalBytes);
      assert.deepEqual(await retainedLegacy(), legacyBytes);
    }
  }, "active");
});


test("migration76 is a forward-only addition to the current75 ledger and fences both reader generations", {
  skip: !PG_TEST_SOCKET, timeout: 120_000,
}, async () => {
  await setup();
  const schema = `classification_upgrade_${randomBytes(5).toString("hex")}`;
  const prefixRoot = await mkdtemp("/private/tmp/tibotattle-classification-migration-prefix-");
  const migrations = await readPostgresMigrations({ role: "primary" });
  const expected = migrations.map(({version,name,sha256}) => ({version,name,sha256}));
  assert.equal(migrations[74].name, "0075_github_distribution_manifest_visibility.sql");
  assert.equal(migrations[74].sha256, "cd275a68f686c0b369a8919d45cddc2083cf7b617bbd18ac5b883f25b8df9ddd");
  assert.equal(migrations[75].name, "0076_classification_correction_links.sql");
  try {
    await mkdir(resolve(prefixRoot,"primary"));
    for (const migration of migrations.slice(0,75)) await copyFile(
      resolve(WORKER_ROOT,"postgres/migrations/primary",migration.name), resolve(prefixRoot,"primary",migration.name));
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await applyPostgresMigrations({role:"primary",schema,pool,rootDirectory:prefixRoot});
    assert.equal(await modules.readSchemaReceipt(pool,{schema,expected:expected.slice(0,75)}),"current");
    assert.equal(await modules.readSchemaReceipt(pool,{schema,expected}),"receipt_mismatch");
    assert.equal((await pool.query("SELECT to_regclass($1)::text AS name", [`${schema}.telemetry_classification_correction_links`])).rows[0].name,null);
    const oldHistory=(await pool.query(`SELECT * FROM "${schema}"."_tibotattle_migration_history" ORDER BY version`)).rows;
    await applyPostgresMigrations({role:"primary",schema,pool});
    assert.equal(await modules.readSchemaReceipt(pool,{schema,expected}),"current");
    assert.equal(await modules.readSchemaReceipt(pool,{schema,expected:expected.slice(0,75)}),"receipt_mismatch");
    assert.ok((await pool.query("SELECT to_regclass($1)::text AS name", [`${schema}.telemetry_classification_correction_links`])).rows[0].name);
    await applyPostgresMigrations({role:"primary",schema,pool});
    const history=(await pool.query(`SELECT * FROM "${schema}"."_tibotattle_migration_history" ORDER BY version`)).rows;
    assert.equal(history.length,76);
    assert.deepEqual(history.slice(0,75),oldHistory);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await rm(prefixRoot,{recursive:true,force:true});
  }
});
