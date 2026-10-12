// Bounded synthetic PostgreSQL activation gate. Owns one disposable schema;
// applies the stock primary chain, including promoted 0076, exactly once.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
import {
  grantScaleV11, initializeScaleV11, scaleDays, scaleSession, scaleUsage, scaleV11DomainManifest, stageScaleV11Day,
  stageScaleV12Day,
} from "./fixtures/classification-scale.mjs";
import { postgresTestEndpoint } from "./staged-migrations-harness.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
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
// Statement texts, recorded only while a test sets it to an array.
let statementLog = null;
// Statement texts with their bind values, recorded only while set.
let statementCapture = null;
// The frozen edca848 proof and closures the rewrite must reproduce exactly.
const FROZEN = {
  "postgres-test/fixtures/classification/activation-oracle.ts": "d9ebe9b302d093543c9167609e01c938eb10fe67827ca456d575ba423158c70d",
  "postgres-test/fixtures/classification/closure-oracle.ts": "a7b1008aae61c40f2c618cddfde38c8c6a50f767ef54ee933f4942567413bb69",
};

after(async () => { await pool?.end(); await vite?.close(); });
const sha256Hex = value => createHash("sha256").update(value).digest("hex");

async function setup() {
  if (pool) return;
  for (const [path, digest] of Object.entries(FROZEN)) {
    assert.equal(sha256Hex(await readFile(resolve(WORKER_ROOT, path))), digest, `${path} is a frozen oracle`);
  }
  // The shared harness requires a private /private/tmp/tibotattle-pg-* socket
  // directory owned by this user (no link, mode 0700) and a valid port.
  const endpoint = await postgresTestEndpoint({ PG_TEST_SOCKET, PG_TEST_PORT: process.env.PG_TEST_PORT,
    PG_TEST_USER: process.env.PG_TEST_USER, PG_TEST_DATABASE: process.env.PG_TEST_DATABASE,
    PG_TEST_PASSWORD: process.env.PG_TEST_PASSWORD });
  assert.ok(endpoint?.host?.startsWith("/private/tmp/tibotattle-pg-"), "a private local PostgreSQL socket");
  pool = new pg.Pool({ ...endpoint,
    application_name: "pg-classification-correction-bounded", ssl: false, max: 2, connectionTimeoutMillis: 5_000 });
  pool.on("connect", client => {
    const query = client.query.bind(client);
    client.query = (...args) => {
      const caller = new Error().stack.split("\n").slice(2, 5);
      statementLog?.push(typeof args[0] === "string" ? args[0] : args[0]?.text ?? "");
      statementCapture?.push({ text: typeof args[0] === "string" ? args[0] : args[0]?.text ?? "",
        values: Array.isArray(args[1]) ? args[1] : [] });
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
    activation: await vite.ssrLoadModule("/src/postgres-classification-activation.ts"),
    oracle: await vite.ssrLoadModule("/postgres-test/fixtures/classification/activation-oracle.ts"),
    closureOracle: await vite.ssrLoadModule("/postgres-test/fixtures/classification/closure-oracle.ts"),
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
async function stage(context, principal, day, stream, record, { parserVersion = "synthetic-classification-pg17" } = {}) {
  const nowEpoch = Date.now();
  const consent = telemetryV12RequiredConsent();
  const records = Array.isArray(record) ? record : [record];
  const chunk = { schemaVersion: "telemetry-contribution-v1.2", manifestDigest: "0".repeat(64),
    chunkId: `${stream}:${day}:0`, chunkRevision: 1, parserVersion,
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

test("v12 activation runs its whole-domain classification proof under the 60 s statement budget", {
  skip: !PG_TEST_SOCKET, timeout: 120_000,
}, async () => {
  await withSchema(async context => {
    const participant = await seedParticipant(context, "activation-budget");
    const principal = await seedDevice(context, participant, "activation-budget");
    const accepted = await stage(context, principal, DAY_ONE, "usage", usage({
      eventTime: `${DAY_ONE}T12:05:00.000Z`, provider: "openai_codex",
    }));
    const manifest = await prepared(context, principal, [accepted]);
    statementLog = [];
    let activation;
    try {
      activation = await context.domain.activate(principal, manifest);
    } finally {
      const issued = statementLog;
      statementLog = null;
      const begin = issued.lastIndexOf("BEGIN");
      const transaction = issued.slice(begin);
      assert.equal(transaction[1], "SET LOCAL statement_timeout='60000ms'");
      assert.ok(transaction.some(sql => sql.startsWith('CREATE TEMP TABLE pg_temp."classification_candidate"')),
        "the classification proof runs inside the budgeted activation transaction");
    }
    assert.equal(activation.replay, false);
  });
});

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


// ---- Bounded activation proof and v1.1 closures (2026-10-10) ----------------
// Each proof case runs the live proof and the frozen edca848 proof (pinned in
// FROZEN) on the same state with the same activation input, each in its own
// always-rolled-back transaction, and requires the same outcome and the same
// link rows in the same order. Every case also asserts its expected outcome,
// so agreement can never be two vacuous passes.
const ACCEPTED = "accepted";
const REFUSED = "refused";
const KNOWN = { provider: "openai_codex", modelId: MODEL };
const usageAt = (day, index, patch = {}) => usage({ eventId: `event:v2:${sha256Hex(`parity:${day}:${index}`)}`,
  eventTime: new Date(Date.parse(`${day}T00:00:00.000Z`) + (index + 1) * 1000).toISOString(), ...patch });
const bulkUsage = (day, count, patch = {}, override = () => ({})) =>
  Array.from({ length: count }, (_, index) => usageAt(day, index, { ...patch, ...override(index) }));
const candidateBuilds = statements => statements.filter(sql => sql.includes("JOIN candidate_days day ON day.manifest_id")).length;
function* planNodes(node) { yield node; for (const child of node.Plans ?? []) yield* planNodes(child); }

/** The exact input a domain hands the proof, rebuilt from its predecessor row. */
async function proofInput(context, format, principal, manifest, token) {
  const tokenHash = sha256Hex(token);
  const name = format === 11 ? "telemetry_v11_domain_predecessors" : "telemetry_v12_domain_predecessors";
  const row = (await pool.query(`SELECT previous_generation_id,input_revision::text AS input_revision,
    ${format === 12 ? "days_json" : "NULL::text AS days_json"} FROM ${context.table(name)} WHERE token_hash=$1`, [tokenHash])).rows[0];
  assert.ok(row, "the predecessor exists");
  return { participantId: principal.participantId, deviceId: principal.deviceId, format,
    previousGenerationId: row.previous_generation_id, generationId: randomUUID(), predecessorTokenHash: tokenHash,
    inputRevision: Number(row.input_revision), manifestDigest: manifest.manifestDigest, days: manifest.days,
    ...(format === 12 ? { predecessorDays: JSON.parse(row.days_json) } : {}) };
}

/** One proof implementation inside a transaction that is always rolled back. */
async function runProof(prepare, context, input, { explain = false } = {}) {
  const client = await pool.connect();
  const statements = [], plans = [], setWorkMem = [], guardNestloop = [], exactness = [];
  const proofClient = { async query(text, values) {
    const pairs = /^CREATE TEMP TABLE pg_temp\."classification_((?:exact|foreign)_\d+)"/u.exec(text);
    const nestloop = async () => (await client.query("SELECT current_setting('enable_nestloop') AS v")).rows[0].v;
    if (/^CREATE TEMP TABLE pg_temp\."classification_/u.test(text)) {
      setWorkMem.push((await client.query("SELECT current_setting('work_mem') AS v")).rows[0].v);
    }
    const history = /FROM pg_temp\."classification_rekey_twins" twin/u.test(text);
    if (/^CREATE TEMP TABLE pg_temp\."classification_rekey_twins"/u.test(text) || history) guardNestloop.push(await nestloop());
    // The quota (2) and session (3) exactness filters over provisional twin pairs.
    const exact = /DELETE FROM pg_temp\."classification_rekey_twins" pair[\s\S]*?pair\.stream=(\d)/u.exec(text);
    if (exact) exactness.push({ stream: Number(exact[1]), nestloop: await nestloop() });
    if (explain && history) plans.push({ set: "rekey_history", plan: (await client.query(`EXPLAIN (FORMAT JSON) ${text}`, values)).rows[0]["QUERY PLAN"][0].Plan });
    if (explain && pairs) plans.push({ set: pairs[1], plan: (await client.query(`EXPLAIN (FORMAT JSON) ${text}`, values)).rows[0]["QUERY PLAN"][0].Plan });
    statements.push(text);
    return client.query(text, values);
  }, release() {} };
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='60000ms'");
    let outcome = ACCEPTED;
    const setting = async name => (await client.query("SELECT current_setting($1) AS v", [name])).rows[0].v;
    const workMemBefore = await setting("work_mem"), nestloopBefore = await setting("enable_nestloop");
    try { await prepare(proofClient, `"${context.schema}"`, input); }
    catch (error) { if (error?.code !== "POSTGRES_CLASSIFICATION_CORRECTION_INVALID") throw error; outcome = REFUSED; }
    const workMemAfter = outcome === ACCEPTED ? await setting("work_mem") : null;
    const nestloopAfter = outcome === ACCEPTED ? await setting("enable_nestloop") : null;
    const links = (await client.query(`SELECT * FROM ${context.table("telemetry_classification_correction_links")}
      WHERE generation_id=$1 ORDER BY id`, [input.generationId])).rows.map(({ id, created_at, ...row }) => row);
    const leftovers = (await client.query(`SELECT count(*)::integer AS n FROM pg_class
      WHERE relpersistence='t' AND relname LIKE 'classification\\_%' AND pg_table_is_visible(oid)`)).rows[0].n;
    return { outcome, links, statements, plans, leftovers, workMemBefore, workMemAfter, setWorkMem,
      nestloopBefore, nestloopAfter, guardNestloop, exactness };
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function proofParity(context, format, principal, manifest, token, expected, label) {
  const input = await proofInput(context, format, principal, manifest, token);
  const live = await runProof(modules.activation.preparePostgresClassificationActivation, context, input, { explain: true });
  const frozen = await runProof(modules.oracle.preparePostgresClassificationActivation, context, input);
  assert.equal(frozen.outcome, expected, `${label}: frozen outcome`);
  assert.equal(live.outcome, frozen.outcome, `${label}: outcome`);
  assert.deepEqual(live.links, frozen.links, `${label}: identical link rows in identical order`);
  if (live.outcome === ACCEPTED) {
    assert.equal(live.leftovers, 0, `${label}: working sets dropped`);
    assert.equal(live.workMemAfter, live.workMemBefore, `${label}: work_mem restored after the proof`);
    assert.equal(live.nestloopAfter, live.nestloopBefore, `${label}: enable_nestloop restored after the proof`);
  }
  assert.ok(live.setWorkMem.every(value => value === "64MB"), `${label}: every working set builds under 64MB work_mem`);
  if (live.guardNestloop.length) assert.equal(live.guardNestloop[0], "off", `${label}: the re-key set joins run without nested loops`);
  return { input, live, frozen };
}

test("bounded proof reproduces the frozen edca848 proof across pages, devices, duplicate originals and refusals", {
  skip: !PG_TEST_SOCKET, timeout: 300_000,
}, async () => {
  await withSchema(async context => {
    const participant = await seedParticipant(context, "parity");
    const principal = await seedDevice(context, participant, "parity-own");
    const other = await seedDevice(context, participant, "parity-other");
    const stageMany = (device, day, records, parserVersion) => stageScaleV12Day(modules, pool, context.schema,
      context.options, device, day, records, parserVersion ? { parserVersion } : {});
    const COUNT = 450; // three pages of 200 pairs
    const unknown = bulkUsage(DAY_TWO, COUNT);
    // Every later predecessor pins the earliest READY original; an identical
    // second original is the accepted head, so both pair with each candidate.
    await stageMany(principal, DAY_TWO, unknown, "synthetic-parity-earliest");
    const sessionDay = await stage(context, principal, DAY_ONE, "session", session());
    const headDay = await stageMany(principal, DAY_TWO, unknown);
    const tail = await stage(context, principal, DAY_THREE, "usage", usageAt(DAY_THREE, 0));
    assert.equal((await context.domain.activate(principal,
      await prepared(context, principal, [sessionDay, headDay, tail]))).replay, false);
    const check = async (label, device, days, expected) => {
      const predecessor = await context.domain.createPredecessor(device);
      return proofParity(context, 12, device, domainManifest(predecessor, days), predecessor.token, expected, label);
    };

    const knownSession = await stage(context, principal, DAY_ONE, "session", session("openai_codex"));
    const knownDay = await stageMany(principal, DAY_TWO, bulkUsage(DAY_TWO, COUNT, KNOWN));
    const knownTail = await stage(context, principal, DAY_THREE, "usage", usageAt(DAY_THREE, 0, KNOWN));
    // 2x450 usage pairs: the second original of each occurrence resolves
    // through the link the first just wrote. The session closure then pages
    // more than 200 original and candidate rows.
    const corrected = await check("exact multi-page correction", principal, [knownSession, knownDay, knownTail], ACCEPTED);
    assert.equal(corrected.live.links.length, COUNT + 2);
    const quantity = await stageMany(principal, DAY_TWO, bulkUsage(DAY_TWO, COUNT, KNOWN,
      index => index === COUNT - 1 ? { totalInputContextTokens: 1001 } : {}));
    const late = await check("refusal on a later exact page", principal, [knownSession, quantity, knownTail], REFUSED);
    assert.ok(late.live.links.length >= 2 * 200, "two full pages of links precede the refusal");
    assert.equal(late.live.statements.filter(sql => /FROM pg_temp\."classification_exact_12" pair/u.test(sql)).length, 3,
      "the refusal comes on the third exact page");
    const sameForeign = await stageMany(other, DAY_TWO, bulkUsage(DAY_TWO, COUNT));
    await check("agreeing foreign device over every foreign page", other, [sameForeign], ACCEPTED);
    const differingForeign = await stageMany(other, DAY_TWO, bulkUsage(DAY_TWO, COUNT, {},
      index => index === COUNT - 1 ? KNOWN : {}));
    await check("foreign classification refused on a later page", other, [differingForeign], REFUSED);

    // Cost shape: one candidate build and at most one history build per
    // format, however many pages; pages read only their indexed pair set.
    const { live, frozen } = corrected;
    assert.equal(candidateBuilds(live.statements), 1, "the candidate set is built once");
    assert.ok(candidateBuilds(frozen.statements) >= 12, "the frozen proof rebuilt it in every statement and page");
    assert.equal(live.statements.filter(sql => /^CREATE TEMP TABLE pg_temp\."classification_source_/u.test(sql)).length, 3);
    const pages = live.statements.filter(sql => /FROM pg_temp\."classification_(?:exact|foreign)_\d+" pair/u.test(sql));
    assert.ok(pages.length >= 6);
    for (const sql of pages) assert.equal(sql.includes(context.schema), false, "a page reads only its working set");
    const exact = live.plans.find(entry => entry.set === "exact_12");
    const join = [...planNodes(exact.plan)].find(node => /Join|Nested Loop/u.test(node["Node Type"]));
    assert.ok(["Hash Join", "Merge Join"].includes(join["Node Type"]),
      `the analyzed working sets pair in one set join, not a nested rescan (${join["Node Type"]})`);
  });
});

test("an unchanged v1.2 day is re-checked against v1.1 evidence a later v1.1 activation admitted", {
  skip: !PG_TEST_SOCKET, timeout: 120_000,
}, async () => {
  await withSchema(async context => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
    const participant = await seedParticipant(context, "cross-format");
    const modern = await seedDevice(context, participant, "cross-v12");
    const legacy = await seedDevice(context, participant, "cross-v11", { v12: false });
    const options = { ...context.options, sourceNamespace: SOURCE_NAMESPACE };
    await initializeScaleV11(modules, pool, context.schema, options);
    await grantScaleV11(modules, pool, participant, legacy, options);
    const modernToday = await stage(context, modern, today, "usage", usageAt(today, 0, KNOWN));
    assert.equal((await context.domain.activate(modern, await prepared(context, modern, [modernToday]))).replay, false);
    // A v1.1 activation never compares against v1.2 records, so another
    // device's unknown copy of the same occurrence is admitted afterwards.
    const { boundaryFlags, tieOrder, cacheWriteTtl, ...common } = usageAt(today, 0,
      { components: { ...usage().components, inputCacheWriteTokens: null } });
    const v11Domain = modules.live.createPostgresTelemetryV11Domain(pool, options);
    const legacyToday = await stageScaleV11Day(modules, pool, context.schema, options, legacy, today,
      [{ ...common, schemaVersion: "usage-event-v1.1" }]);
    assert.equal((await v11Domain.activate(legacy, scaleV11DomainManifest(await v11Domain.createPredecessor(legacy),
      [legacyToday]))).replay, false);
    // The v1.2 device's next domain keeps today's manifest and adds yesterday.
    const modernYesterday = await stage(context, modern, yesterday, "usage", usageAt(yesterday, 0, KNOWN));
    const predecessor = await context.domain.createPredecessor(modern);
    const manifest = domainManifest(predecessor, [modernYesterday, modernToday]);
    await proofParity(context, 12, modern, manifest, predecessor.token, REFUSED, "unchanged day re-checked");
    // A changed-days-only candidate would accept it: narrowing is not
    // semantics-preserving, so the bounded proof keeps every domain day.
    const narrowed = await proofInput(context, 12, modern, manifest, predecessor.token);
    narrowed.days = narrowed.days.filter(day => day.day === yesterday);
    assert.equal((await runProof(modules.oracle.preparePostgresClassificationActivation, context, narrowed)).outcome, ACCEPTED);
    await refused(context, modern, manifest);
  });
});

/** Run captured live closure SQL and the frozen edca848 SQL on one (possibly mutated) state, then roll back. */
async function closurePair(live, frozen, { mutate = async () => {}, values = live.values } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role=replica");
    await mutate(client);
    return [(await client.query(live.text, values)).rows.length, (await client.query(frozen, values)).rows.length];
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
const withoutDay = (json, day) => JSON.stringify(JSON.parse(json).filter(entry => entry.day !== day));

test("v1.1 closure anti-joins refuse exactly what the frozen closures refuse under every disjunct", {
  skip: !PG_TEST_SOCKET, timeout: 180_000,
}, async () => {
  await withSchema(async context => {
    const day = new Date().toISOString().slice(0, 10);
    const participant = await seedParticipant(context, "closure-parity");
    const principal = await seedDevice(context, participant, "closure-parity", { v12: false });
    const owner = { ...principal, principal };
    const options = { ...context.options, sourceNamespace: SOURCE_NAMESPACE };
    await pool.query(`UPDATE ${context.table("telemetry_transport_formats")} SET lifecycle='accepted'
      WHERE schema_version='telemetry-contribution-v1.1'`);
    await modules.live.initializePostgresTypedV11Admission(pool, options);
    await pool.query(`INSERT INTO ${context.table("typed_v1_admission_state")}(
      id,source_namespace,namespace_id,runtime_contract_version,next_source_row_id)
      SELECT 1,source_namespace,namespace_id,1,3 FROM ${context.table("typed_v11_admission_state")} WHERE id=1`);
    const v11Records = [0, 1].map(index => {
      const { boundaryFlags, tieOrder, cacheWriteTtl, ...record } = usageAt(day, index,
        { provider: "openai_codex", components: { ...usage().components, inputCacheWriteTokens: null } });
      return { ...record, schemaVersion: "usage-event-v1.1" };
    });
    const legacyRecords = v11Records.map(record => JSON.parse(
      modules.compatibility.telemetryV11LegacyProjection("usage", record).canonicalRecord));
    const legacy = await seedTypedV1Chunk(modules, pool, context.schema, owner,
      { day, stream: "usage", chunkSeq: 0, records: legacyRecords });
    const digests = await legacy.admit({ ownerDigest: participant.ownerDigest, firstSourceRowId: 1 });
    // The retained raw v1 rows and preservation proofs legacyGap reads.
    const raw = await pool.connect();
    try {
      await raw.query("BEGIN");
      await raw.query("SET LOCAL session_replication_role=replica");
      for (const [index, record] of legacyRecords.entries()) {
        await raw.query(`INSERT INTO ${context.table("telemetry_v1_records")}(id,chunk_row_id,participant_id,device_id,
          stream,occurrence_id,observed_at,observed_day,provider,model_id,session_uuid,record_json)
          VALUES ($1,$2,$3,$4,'usage',$5,$6,$7::date,$8,$9,$10,$11)`, [index + 1, legacy.chunkRowId, participant.participantId,
          principal.deviceId, v11Records[index].eventId, v11Records[index].eventTime, day, record.provider, record.modelId,
          v11Records[index].sessionUuid, JSON.stringify(record)]);
        await raw.query(`INSERT INTO ${context.table("typed_v1_preservation_proofs")}(source_row_id,canonical_digest)
          VALUES ($1,decode($2,'hex'))`, [index + 1, digests[index]]);
      }
      await raw.query("COMMIT");
    } finally { raw.release(); }
    await modules.live.grantPostgresTelemetryV11Consent(pool, { ...principal, sessionId: participant.sessionId },
      telemetryV11RequiredConsent(), Date.now(), options);
    const domain = modules.live.createPostgresTelemetryV11Domain(pool, options);
    const first = await stageScaleV11Day(modules, pool, context.schema, options, principal, day, v11Records);
    assert.equal((await domain.activate(principal, scaleV11DomainManifest(await domain.createPredecessor(principal), [first]))).replay, false);
    const extra = (() => { const { boundaryFlags, tieOrder, cacheWriteTtl, ...record } = usageAt(day, 2,
      { provider: "openai_codex", components: { ...usage().components, inputCacheWriteTokens: null } });
    return { ...record, schemaVersion: "usage-event-v1.1" }; })();
    const second = await stageScaleV11Day(modules, pool, context.schema, options, principal, day, [...v11Records, extra]);
    statementCapture = [];
    let captured;
    try {
      assert.equal((await domain.activate(principal, scaleV11DomainManifest(await domain.createPredecessor(principal),
        [second]))).replay, false);
    } finally { captured = statementCapture; statementCapture = null; }
    const find = marker => { const found = captured.filter(entry => entry.text.includes(marker)); assert.equal(found.length, 1, marker); return found[0]; };
    const s = `"${context.schema}"`;
    const closures = {
      uncovered: [find("winner_records AS MATERIALIZED"), modules.closureOracle.frozenUncoveredSql(s), 2],
      legacyGap: [find(`${s}."telemetry_v1_records" old_row`), modules.closureOracle.frozenLegacyGapSql(s), 2],
      previousGap: [find(`${s}."telemetry_v11_domain_days" previous_day`), modules.closureOracle.frozenPreviousGapSql(s), 1],
    };
    const successor = (await pool.query(`SELECT typed_record_id::text AS id FROM ${context.table("typed_v11_record_admissions")}
      WHERE manifest_id=$1 ORDER BY typed_record_id LIMIT 1`, [second.manifestId])).rows[0].id;
    const typedV1 = (await pool.query(`SELECT id::text AS id,owner_id::text AS owner_id,chunk_id::text AS chunk_id
      FROM ${context.table("typed_telemetry_records")} WHERE format=10 ORDER BY source_row_id LIMIT 1`)).rows[0];
    const blob = value => Buffer.from(modules.codec.encodeTypedTelemetryId(value));
    const update = (sql, values) => client => client.query(sql, values);
    const proofs = context.table("typed_v11_record_proofs");
    const cases = {
      uncovered: [
        ["unmutated", false],
        ["candidate day missing (D1)", true, { values: ([a, b, c, d]) => [a, b, withoutDay(c, day), d] }],
        ["owner decodes to another participant (D4 true)", true,
          { mutate: update(`UPDATE ${context.table("typed_telemetry_owners")} SET original_id=$2 WHERE id=$1`, [typedV1.owner_id, blob(`participant:${randomUUID()}`)]) }],
        ["owner id undecodable (D4 NULL)", false,
          { mutate: update(`UPDATE ${context.table("typed_telemetry_owners")} SET original_id=$2 WHERE id=$1`, [typedV1.owner_id, Buffer.from([0xee, ...randomBytes(16)])]) }],
        ["chunk decodes to another chunk (D6)", true,
          { mutate: update(`UPDATE ${context.table("typed_telemetry_chunks")} SET original_id=$2 WHERE id=$1`, [typedV1.chunk_id, blob(`chunk:${randomUUID()}`)]) }],
        ["observed day moved (D7)", true,
          { mutate: update(`UPDATE ${context.table("typed_telemetry_records")} SET observed_at_ms=observed_at_ms+${DAY_MS},observed_day=observed_day+1 WHERE id=$1`, [typedV1.id]) }],
        ["successor legacy digest differs (D8)", true,
          { mutate: update(`UPDATE ${proofs} SET legacy_digest=$2 WHERE typed_record_id=$1`, [successor, randomBytes(32)]) }],
      ],
      legacyGap: [
        ["unmutated", false],
        ["preservation proof missing", true, { mutate: update(`DELETE FROM ${context.table("typed_v1_preservation_proofs")} WHERE source_row_id=1`, []) }],
        ["candidate day missing", true, { values: ([a, b, c, d]) => [a, b, withoutDay(c, day), d] }],
        ["successor legacy digest differs", true,
          { mutate: update(`UPDATE ${proofs} SET legacy_digest=$2 WHERE typed_record_id=$1`, [successor, randomBytes(32)]) }],
        ["successor legacy occurrence differs", true,
          { mutate: update(`UPDATE ${proofs} SET legacy_occurrence_blob=$2 WHERE typed_record_id=$1`, [successor, blob(`event:v2:${"f".repeat(64)}`)]) }],
      ],
      previousGap: [
        ["unmutated", false],
        ["candidate day missing", true, { values: ([a, b, c]) => [a, withoutDay(b, day), c] }],
        ["successor occurrence differs", true,
          { mutate: update(`UPDATE ${proofs} SET occurrence_blob=$2 WHERE typed_record_id=$1`, [successor, blob(`event:v2:${"f".repeat(64)}`)]) }],
        ["successor base digest differs", true,
          { mutate: update(`UPDATE ${proofs} SET base_digest=$2 WHERE typed_record_id=$1`, [successor, randomBytes(32)]) }],
      ],
    };
    for (const [name, [live, frozen]] of Object.entries(closures)) {
      for (const [label, refuses, { mutate, values } = {}] of cases[name]) {
        const [liveRows, frozenRows] = await closurePair(live, frozen,
          { mutate, values: values ? values(live.values) : live.values });
        assert.equal(frozenRows > 0, refuses, `${name}/${label}: frozen outcome`);
        assert.equal(liveRows > 0, frozenRows > 0, `${name}/${label}: live and frozen agree`);
      }
    }
  });
});

test("v1.1 closures probe successors once per manifest, not once per retained row", {
  skip: !PG_TEST_SOCKET, timeout: 180_000,
}, async () => {
  await withSchema(async context => {
    const participant = await seedParticipant(context, "closure-plan");
    const principal = await seedDevice(context, participant, "closure-plan", { v12: false });
    const options = { ...context.options, sourceNamespace: SOURCE_NAMESPACE };
    await initializeScaleV11(modules, pool, context.schema, options);
    await grantScaleV11(modules, pool, participant, principal, options);
    const PER_DAY = 300;
    const days = scaleDays(2, new Date(Date.now() - DAY_MS).toISOString().slice(0, 10));
    const records = (day, extra = 0) => [scaleSession(11, day, days.indexOf(day)), ...Array.from({ length: PER_DAY + extra },
      (_, index) => scaleUsage(11, day, index, { session: days.indexOf(day) }))];
    const domain = modules.live.createPostgresTelemetryV11Domain(pool, options);
    const first = [];
    for (const day of days) first.push(await stageScaleV11Day(modules, pool, context.schema, options, principal, day, records(day)));
    assert.equal((await domain.activate(principal, scaleV11DomainManifest(await domain.createPredecessor(principal), first))).replay, false);
    const second = [first[0], await stageScaleV11Day(modules, pool, context.schema, options, principal, days[1], records(days[1], 1))];
    for (const { tablename } of (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname=$1", [context.schema])).rows) {
      await pool.query(`ANALYZE ${context.table(tablename)}`);
    }
    statementCapture = [];
    let captured;
    try {
      assert.equal((await domain.activate(principal, scaleV11DomainManifest(await domain.createPredecessor(principal),
        second))).replay, false);
    } finally { captured = statementCapture; statementCapture = null; }
    const live = captured.find(entry => entry.text.includes(`"${context.schema}"."telemetry_v11_domain_days" previous_day`));
    const loops = async text => {
      const plan = (await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, live.values)).rows[0]["QUERY PLAN"][0].Plan;
      return Math.max(...[...planNodes(plan)].filter(node => node["Relation Name"] === "typed_v11_record_proofs")
        .map(node => node["Actual Loops"]));
    };
    const frozenLoops = await loops(modules.closureOracle.frozenPreviousGapSql(`"${context.schema}"`));
    const liveLoops = await loops(live.text);
    assert.ok(frozenLoops >= PER_DAY, `the frozen probe rescans a manifest per retained row (${frozenLoops})`);
    assert.ok(liveLoops <= 4, `the anti-join reads each manifest's proofs a bounded number of times (${liveLoops})`);
  });
});

test("session closure reads every usage row of a large session in numeric order", {
  skip: !PG_TEST_SOCKET, timeout: 180_000,
}, async () => {
  await withSchema(async context => {
    const participant = await seedParticipant(context, "session-pages");
    const principal = await seedDevice(context, participant, "session-pages");
    const COUNT = 600;
    const sessionDay = await stage(context, principal, DAY_ONE, "session", session());
    // A single-digit id from 2 to 9 sorts after every "1..." id as text, so
    // the frozen pages' bigint cursor has passed it before it is ever read.
    const tail = await stage(context, principal, DAY_THREE, "usage", usageAt(DAY_THREE, 0));
    assert.ok(Number(tail.ids[0]) >= 2 && Number(tail.ids[0]) < 10);
    const original = await stageScaleV12Day(modules, pool, context.schema, context.options, principal, DAY_TWO,
      bulkUsage(DAY_TWO, COUNT));
    assert.equal((await context.domain.activate(principal,
      await prepared(context, principal, [sessionDay, original, tail]))).replay, false);
    const knownSession = await stage(context, principal, DAY_ONE, "session", session("openai_codex"));
    const knownDay = await stageScaleV12Day(modules, pool, context.schema, context.options, principal, DAY_TWO,
      bulkUsage(DAY_TWO, COUNT, KNOWN));
    // The unchanged tail keeps its unknown provider, so a known session must refuse.
    const predecessor = await context.domain.createPredecessor(principal);
    const manifest = domainManifest(predecessor, [knownSession, knownDay, tail]);
    const input = await proofInput(context, 12, principal, manifest, predecessor.token);
    assert.equal((await runProof(modules.oracle.preparePostgresClassificationActivation, context, input)).outcome, ACCEPTED,
      "edca848 accepted: its text-ordered session pages never read the unknown tail");
    assert.equal((await runProof(modules.activation.preparePostgresClassificationActivation, context, input)).outcome, REFUSED);
    await refused(context, principal, manifest);
  });
});

// ---- Cross-format re-key guard (2026-10-11) ---------------------------------
// Client occurrence ids are positional, so a re-parse can emit the same event
// at the same instant under a new id. Effective readers union a participant's
// accepted legacy candidates with its v1.2 generations per day by occurrence
// id, so an activation that re-keys an accepted older-format record would
// count it twice. edca848 (the frozen oracle) had no such guard. A twin is the
// same event: usage in the same session, quota with the same limit and slot,
// and a session linked through a usage event kept under its own id.
const OTHER_SESSION = "00000000-0000-4000-8000-0000000000b2";
const V11_TABLES = ["telemetry_classification_correction_links", "telemetry_v11_domains", "telemetry_v11_domain_days",
  "telemetry_v11_domain_heads", "telemetry_v11_domain_predecessors", "storage_v11_event_sources",
  "storage_ingestion_changes", "storage_owner_revisions", "input_versions", "community_analytical_input_versions"];
const v11At = (day, index, patch = {}) => {
  const { boundaryFlags, tieOrder, cacheWriteTtl, ...record } = usageAt(day, index,
    { components: { ...usage().components, inputCacheWriteTokens: null }, ...patch });
  return { ...record, schemaVersion: "usage-event-v1.1" };
};
// The same event in v1.2 with identical quantities (v1.1 has no cache-write split).
const asV12 = (record, patch = {}) => ({ ...record, schemaVersion: "usage-event-v1.2",
  boundaryFlags: 1, tieOrder: null, cacheWriteTtl: null, ...patch });
const rekeyedId = label => `event:v2:${sha256Hex(`rekeyed:${label}`)}`;
const pairWork = statements => statements.filter(sql => /classification_(?:foreign|exact)_\d+/u.test(sql));
const guardStatement = statements => {
  const found = statements.filter(sql => /^CREATE TEMP TABLE pg_temp\."classification_rekey_twins"/u.test(sql));
  assert.equal(found.length, 1, "the proof runs exactly one re-key twin statement");
  return found[0];
};
// The accepted-history probe runs only when a twin survives the exactness filters.
const historyProbes = statements => statements.filter(sql => /FROM pg_temp\."classification_rekey_twins" twin/u.test(sql));
// A correlated subplan re-runs per outer row; the history probe joins as sets.
// Nor may the twin set sit on the inner side of a nested loop, which rescans it
// per outer row (per accepted manifest, in the shape a CTE-only probe planned).
const perRowRescans = plan => [...planNodes(plan)].filter(node => node["Parent Relationship"] === "SubPlan"
  || (node["Node Type"] === "Nested Loop" && (node.Plans ?? []).some(child => child["Parent Relationship"] === "Inner"
    && [...planNodes(child)].some(inner => inner["CTE Name"] === "twins"))));
const historyPlan = live => {
  const found = live.plans.filter(entry => entry.set === "rekey_history");
  assert.equal(found.length, 1, "one history probe was planned");
  return found[0].plan;
};

/** The live proof refuses a re-key the frozen edca848 proof accepted, before any pair work. */
async function rekeyRefusal(context, format, principal, manifest, token, label) {
  const input = await proofInput(context, format, principal, manifest, token);
  assert.equal((await runProof(modules.oracle.preparePostgresClassificationActivation, context, input)).outcome, ACCEPTED,
    `${label}: edca848 accepted the re-key`);
  const live = await runProof(modules.activation.preparePostgresClassificationActivation, context, input, { explain: true });
  assert.equal(live.outcome, REFUSED, `${label}: the guard refuses`);
  assert.equal(live.links.length, 0, `${label}: no link written`);
  assert.deepEqual(pairWork(live.statements), [], `${label}: refused before any pair set or page`);
  assert.equal(historyProbes(live.statements).length, 1, `${label}: the twin was checked against accepted history`);
  assert.deepEqual(perRowRescans(historyPlan(live)), [], `${label}: the history probe rescans no set per row`);
  // v1.1 compares working sets (no nested loops); v1.2 probes indexed history under the default.
  assert.deepEqual(live.guardNestloop, ["off", format === 11 ? "off" : live.nestloopBefore], `${label}: planner settings`);
  return { statement: guardStatement(live.statements), live };
}

/** Plan a captured guard statement over synthetic working sets of `rows` rows, then roll back. */
async function syntheticGuardPlan(text, deviceId, rows) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('work_mem','64MB',true)");
    // As the proof runs the twin statement (pinned by runProof's guardNestloop).
    await client.query("SELECT set_config('enable_nestloop','off',true)");
    for (const [name, streamType] of [["candidate", "integer"], ["source_10", "smallint"], ["source_11", "smallint"],
      ["source_12", "integer"]]) {
      await client.query(`CREATE TEMP TABLE pg_temp."classification_${name}" ON COMMIT DROP AS
        SELECT i::bigint AS id,(i%3+1)::${streamType} AS stream,decode(md5(i::text),'hex') AS occurrence_id,
          (1780000000000+i*1000)::bigint AS observed_at_ms,((1780000000000+i*1000)/${DAY_MS})::integer AS observed_day,
          CASE WHEN i%3=0 THEN decode(md5('session:'||(i/500)),'hex') END AS session_id,
          $1::text AS source_device_id FROM generate_series(1,$2::integer) i`, [deviceId, rows]);
      await client.query(`ANALYZE pg_temp."classification_${name}"`);
    }
    // Only a v1.2 twin statement binds the device (its quota legacy is the
    // device's) and the other retained devices (here the synthetic v1.2 set's
    // own, so that branch contributes every row to the plan).
    const values = /\$2\b/u.test(text) ? [deviceId, [deviceId]] : /\$1\b/u.test(text) ? [deviceId] : [];
    return (await client.query(`EXPLAIN (FORMAT JSON) ${text}`, values)).rows[0]["QUERY PLAN"][0].Plan;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

test("v1.2 activation refuses a same-instant re-key of this device's accepted v1.1 history", {
  skip: !PG_TEST_SOCKET, timeout: 180_000,
}, async () => {
  await withSchema(async context => {
    const today = new Date().toISOString().slice(0, 10);
    const participant = await seedParticipant(context, "rekey-v11");
    const principal = await seedDevice(context, participant, "rekey-v11", { v12: false });
    const options = { ...context.options, sourceNamespace: SOURCE_NAMESPACE };
    await initializeScaleV11(modules, pool, context.schema, options);
    await grantScaleV11(modules, pool, participant, principal, options);
    const v11Domain = modules.live.createPostgresTelemetryV11Domain(pool, options);
    const legacy = [0, 1, 2].map(index => v11At(today, index));
    const legacyDay = await stageScaleV11Day(modules, pool, context.schema, options, principal, today, legacy);
    assert.equal((await v11Domain.activate(principal, scaleV11DomainManifest(await v11Domain.createPredecessor(principal),
      [legacyDay]))).replay, false);
    await enableV12(context, principal);
    const range = { fromDay: today, throughDay: today };
    assert.equal((await evidence(context, participant, range)).usage.get(today).length, 3);
    const v12Day = records => stage(context, principal, today, "usage", records);
    const fresh = async days => { const predecessor = await context.domain.createPredecessor(principal);
      return { predecessor, manifest: domainManifest(predecessor, days) }; };
    const known = record => asV12(record, KNOWN);

    // (b) The third legacy event is simply absent and the candidate has no
    // record at its instant: the union keeps its legacy copy, so this accepts
    // exactly as the frozen proof does, and activates.
    const absent = await fresh([await v12Day([known(legacy[0]), known(legacy[1]), known(v11At(today, 3))])]);
    const absentProof = await proofParity(context, 12, principal, absent.manifest, absent.predecessor.token, ACCEPTED,
      "absent without a twin");
    const guard = guardStatement(absentProof.live.statements);
    assert.equal(absentProof.live.links.length, 2, "the two kept unknown v1.1 originals take exact links");
    assert.equal((await context.domain.activate(principal, absent.manifest)).replay, false);
    assert.equal((await evidence(context, participant, range)).usage.get(today).length, 4,
      "the absent legacy event and the new event each count once");

    // (c) Every id preserved: identical to the frozen proof, and the union
    // still counts each event once.
    const preserved = await fresh([await v12Day([...legacy, v11At(today, 3)].map(known))]);
    const kept = await proofParity(context, 12, principal, preserved.manifest, preserved.predecessor.token, ACCEPTED,
      "all ids preserved");
    assert.equal(guardStatement(kept.live.statements), guard);
    assert.equal(kept.live.links.length, 1, "the last unknown v1.1 original takes its exact link");
    assert.ok(kept.live.links.every(row => Number(row.before_format) === 11));
    assert.equal((await context.domain.activate(principal, preserved.manifest)).replay, false);
    const accepted = await evidence(context, participant, range);
    assert.equal(accepted.usage.get(today).length, 4, "each preserved occurrence counts once");
    assert.ok(accepted.usage.get(today).every(row => JSON.parse(row.recordJson)?.modelId === MODEL));

    // (a) The third event re-parsed under a new id at the same instant. The
    // same-day closure passes (the earliest READY day's ids are all kept), so
    // only the guard stands between this and a double count: with the guard
    // bypassed it commits and the union counts five occurrences for four
    // events. It refuses before any pair work and nothing is written.
    const rekeyed = await fresh([await v12Day([known(legacy[0]), known(legacy[1]),
      known({ ...legacy[2], eventId: rekeyedId("v11") }), known(v11At(today, 3))])]);
    assert.equal((await rekeyRefusal(context, 12, principal, rekeyed.manifest, rekeyed.predecessor.token, "v1.1 re-key"))
      .statement, guard);
    await refused(context, principal, rekeyed.manifest);
    assert.deepEqual((await evidence(context, participant, range)).usage, accepted.usage);
    // The same statement plans as set joins over large working sets (the
    // kept anti-join, the same-instant-and-session join and the legacy-id
    // anti-join), never a per-row rescan of the candidate.
    const joins = [...planNodes(await syntheticGuardPlan(guard, principal.deviceId, 20_000))]
      .filter(node => /Join|Nested Loop/u.test(node["Node Type"]));
    assert.ok(joins.length >= 3, `the twin statement joins three times (${joins.length})`);
    for (const node of joins) {
      assert.ok(["Hash Join", "Merge Join"].includes(node["Node Type"]), `the guard joins as a set (${node["Node Type"]})`);
    }

    // (f) The third event absent and another session's event at its instant
    // under its own id: a re-keyed twin keeps its session, so this is no
    // re-key (guard v2 refused it, and the refused day stayed pinned). The
    // proof agrees with the frozen one without probing history, and the
    // union counts the new event once beside the four.
    const otherSession = known(v11At(today, 2, { eventId: rekeyedId("other-session"), sessionUuid: OTHER_SESSION }));
    const sibling = await fresh([await v12Day([known(legacy[0]), known(legacy[1]), otherSession, known(v11At(today, 3))])]);
    const siblingProof = await proofParity(context, 12, principal, sibling.manifest, sibling.predecessor.token, ACCEPTED,
      "another session at a dropped event's instant");
    assert.deepEqual(historyProbes(siblingProof.live.statements), [], "a different session is no twin");
    assert.equal((await context.domain.activate(principal, sibling.manifest)).replay, false);
    assert.equal((await evidence(context, participant, range)).usage.get(today).length, 5,
      "the four events and the other session's event each count once");
  });
});

test("the re-key guard covers v1 history for v1.1 and v1.2 activations; another device's other session is no twin", {
  skip: !PG_TEST_SOCKET, timeout: 180_000,
}, async () => {
  await withSchema(async context => {
    const today = new Date().toISOString().slice(0, 10);
    const participant = await seedParticipant(context, "rekey-v1");
    const principal = await seedDevice(context, participant, "rekey-v1", { v12: false });
    const other = await seedDevice(context, participant, "rekey-v1-other", { v12: false });
    const options = { ...context.options, sourceNamespace: SOURCE_NAMESPACE };
    await pool.query(`UPDATE ${context.table("telemetry_transport_formats")} SET lifecycle='accepted'
      WHERE schema_version='telemetry-contribution-v1.1'`);
    await modules.live.initializePostgresTypedV11Admission(pool, options);
    await pool.query(`INSERT INTO ${context.table("typed_v1_admission_state")}(
      id,source_namespace,namespace_id,runtime_contract_version,next_source_row_id)
      SELECT 1,source_namespace,namespace_id,1,5 FROM ${context.table("typed_v11_admission_state")} WHERE id=1`);
    const project = record => JSON.parse(modules.compatibility.telemetryV11LegacyProjection("usage", record).canonicalRecord);
    const v11 = [0, 1, 2].map(index => v11At(today, index));
    // This device's retained v1 history, and another device's v1 event, in a
    // session of its own, at its own instant.
    const own = await seedTypedV1Chunk(modules, pool, context.schema, { ...principal, principal },
      { day: today, stream: "usage", chunkSeq: 0, records: v11.map(project) });
    await own.admit({ ownerDigest: participant.ownerDigest, firstSourceRowId: 1 });
    const foreignEvent = v11At(today, 5, { sessionUuid: OTHER_SESSION });
    const foreign = await seedTypedV1Chunk(modules, pool, context.schema, { ...other, principal: other },
      { day: today, stream: "usage", chunkSeq: 0, records: [project(foreignEvent)] });
    await foreign.admit({ ownerDigest: participant.ownerDigest, firstSourceRowId: 4 });
    await grantScaleV11(modules, pool, participant, principal, options);
    const v2Rekeyed = { ...v11[2], eventId: rekeyedId("v1") };

    // (d) A v1.1 activation that re-keys a v1 record at the same instant
    // refuses with the existing compatibility code and writes nothing.
    const v11Domain = modules.live.createPostgresTelemetryV11Domain(pool, options);
    const rekeyedV11 = await stageScaleV11Day(modules, pool, context.schema, options, principal, today,
      [v11[0], v11[1], v2Rekeyed]);
    const v11Predecessor = await v11Domain.createPredecessor(principal);
    const v11Manifest = scaleV11DomainManifest(v11Predecessor, [rekeyedV11]);
    await rekeyRefusal(context, 11, principal, v11Manifest, v11Predecessor.token, "v1 re-key into v1.1");
    const tables = async () => { const result = {}; for (const name of V11_TABLES) {
      result[name] = (await pool.query(`SELECT count(*)::integer AS n,md5(COALESCE(string_agg(row::text,E'\\n'
        ORDER BY row::text),'')) AS digest FROM ${context.table(name)} row`)).rows[0];
    } return result; };
    const quiet = await tables();
    await assert.rejects(v11Domain.activate(principal, v11Manifest),
      { status: 409, code: "TELEMETRY_COMPATIBILITY_PROOF_UNAVAILABLE" });
    assert.deepEqual(await tables(), quiet, "refusal rolls back links, head, predecessor consumption and journal");

    // (e) Another device's v1 event is absent from this candidate, which holds
    // its own event at that instant in this device's session. Usage history is
    // the participant's (a re-paired machine keeps its ids), but a twin keeps
    // its session, so a different session's event is none: accepted. This
    // device's third v1 event is simply absent (no twin) as well.
    await enableV12(context, principal);
    const fresh = async days => { const predecessor = await context.domain.createPredecessor(principal);
      return { predecessor, manifest: domainManifest(predecessor, days) }; };
    const ownAtForeignInstant = asV12({ ...foreignEvent, sessionUuid: SESSION_ID },
      { eventId: rekeyedId("own-event-at-foreign-instant") });
    const scoped = await fresh([await stage(context, principal, today, "usage",
      [asV12(v11[0]), asV12(v11[1]), ownAtForeignInstant])]);
    await proofParity(context, 12, principal, scoped.manifest, scoped.predecessor.token, ACCEPTED, "another device's history");
    assert.equal((await context.domain.activate(principal, scoped.manifest)).replay, false);

    // A v1.2 activation that re-keys this device's v1 record at the same
    // instant (it has no accepted v1.1 history, so only the v1 set can
    // refuse) uses the v1.2 conflict code. It keeps every id of the earliest
    // READY day, so the same-day closure alone would have accepted it.
    const rekeyedV12 = await fresh([await stage(context, principal, today, "usage",
      [asV12(v11[0]), asV12(v11[1]), ownAtForeignInstant, asV12(v2Rekeyed)])]);
    await rekeyRefusal(context, 12, principal, rekeyedV12.manifest, rekeyedV12.predecessor.token, "v1 re-key into v1.2");
    await refused(context, principal, rekeyedV12.manifest);
  });
});

// Domains whose activations run the frozen edca848 proof (production before
// this guard), to reproduce history that proof accepted.
let deployed;
async function deployedDomains() {
  await setup();
  if (deployed) return deployed;
  const oracle = resolve(WORKER_ROOT, "postgres-test/fixtures/classification/activation-oracle.ts");
  const importers = [];
  const server = await createServer({ root: WORKER_ROOT, configFile: false, logLevel: "silent",
    plugins: [{ name: "classification-deployed-proof", enforce: "pre", resolveId(source, importer) {
      if (source !== "./postgres-classification-activation" || !importer?.startsWith(resolve(WORKER_ROOT, "src"))) return null;
      importers.push(importer.slice(WORKER_ROOT.length));
      return oracle;
    } }, ...(analyticsV2Config.plugins ?? [])], resolve: analyticsV2Config.resolve,
    server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom" });
  deployed = { server,
    v12: await server.ssrLoadModule("/src/postgres-typed-v12-domain.ts"),
    live: await server.ssrLoadModule("/src/postgres-telemetry-v11-live-admission.ts") };
  assert.deepEqual([...new Set(importers)].sort(), ["/src/postgres-telemetry-v11-live-admission.ts", "/src/postgres-typed-v12-domain.ts"],
    "both domains run the frozen proof");
  return deployed;
}
after(async () => { await deployed?.server.close(); });

const quotaV11 = (day, index, patch = {}) => ({ schemaVersion: "quota-observation-v1.1",
  observationId: `quota-occurrence:v1:${sha256Hex(`quota:${day}:${index}`)}`,
  observedTime: `${day}T06:00:00.000Z`, provider: "openai_codex", planType: "pro", planVariant: "unknown",
  limitId: "codex", slot: "primary", usedPercent: 12, windowDurationMinutes: 300, resetsAt: `${day}T10:00:00.000Z`,
  accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null, planBasis: "same_source_occurrence",
    planType: "pro", planEraId: null }, ...patch });
const usageCounts = async (context, participant, fromDay, throughDay, stream = "usage") => {
  const read = await modules.occurrences.readOwnerOccurrences({ pool, schema: context.schema, nowMs: Date.now() },
    { ownerDigest: participant.ownerDigest, fromDay, throughDay, stream });
  return Object.fromEntries([...read].map(([day, rows]) => [day, rows.length]));
};
const asV12Quota = record => ({ ...record, schemaVersion: "quota-observation-v1.2" });
const v1Ready = async (context, participant) => {
  await pool.query(`UPDATE ${context.table("telemetry_transport_formats")} SET lifecycle='accepted'
    WHERE schema_version='telemetry-contribution-v1.1'`);
  await modules.live.initializePostgresTypedV11Admission(pool, { ...context.options, sourceNamespace: SOURCE_NAMESPACE });
  await pool.query(`INSERT INTO ${context.table("typed_v1_admission_state")}(
    id,source_namespace,namespace_id,runtime_contract_version,next_source_row_id)
    SELECT 1,source_namespace,namespace_id,1,100 FROM ${context.table("typed_v11_admission_state")} WHERE id=1`);
};

test("v1 quota's designed id change and a same-instant sibling kept under its own id are not re-keys", {
  skip: !PG_TEST_SOCKET, timeout: 180_000,
}, async () => {
  await withSchema(async context => {
    const today = new Date().toISOString().slice(0, 10);
    const participant = await seedParticipant(context, "rekey-designed");
    const principal = await seedDevice(context, participant, "rekey-designed", { v12: false });
    const options = { ...context.options, sourceNamespace: SOURCE_NAMESPACE };
    await v1Ready(context, participant);
    // v1 names a quota observation by instant, limit and slot; v1.1 and v1.2
    // name the same observation 'quota-occurrence:v1:...' (the clients'
    // telemetry-v1-chunks.js and telemetry-v11-chunks.js), mapped only through
    // legacy_occurrence_id. Usage and session ids are kept across formats.
    const quota = quotaV11(today, 0);
    const v1Quota = modules.compatibility.telemetryV11LegacyProjection("quota", quota);
    assert.match(v1Quota.occurrenceId, /^q:\d+:codex:primary$/u);
    const v1 = await seedTypedV1Chunk(modules, pool, context.schema, { ...principal, principal },
      { day: today, stream: "quota", chunkSeq: 0, records: [JSON.parse(v1Quota.canonicalRecord)] });
    await v1.admit({ ownerDigest: participant.ownerDigest, firstSourceRowId: 1 });
    await grantScaleV11(modules, pool, participant, principal, options);
    const v11Domain = modules.live.createPostgresTelemetryV11Domain(pool, options);
    // A and B are two events at one instant.
    const a = v11At(today, 0), b = v11At(today, 1, { eventTime: a.eventTime }), c = v11At(today, 2);
    const v11Day = await stageScaleV11Day(modules, pool, context.schema, options, principal, today, [quota, a, b, c]);
    const v11Predecessor = await v11Domain.createPredecessor(principal);
    const v11Manifest = scaleV11DomainManifest(v11Predecessor, [v11Day]);
    // The v1 quota id is absent while the candidate holds a quota record at its instant.
    const quotaProof = await proofParity(context, 11, principal, v11Manifest, v11Predecessor.token, ACCEPTED,
      "v1 quota under its v1.1 id");
    assert.deepEqual(historyProbes(quotaProof.live.statements), [], "no twin is found");
    assert.equal((await v11Domain.activate(principal, v11Manifest)).replay, false);
    assert.deepEqual(await usageCounts(context, participant, today, today), { [today]: 3 });

    // A is simply absent and B keeps its id at A's instant: B is a sibling,
    // not a twin. The v1 quota id is absent again beside its v1.1 id.
    await enableV12(context, principal);
    const fresh = async days => { const predecessor = await context.domain.createPredecessor(principal);
      return { predecessor, manifest: domainManifest(predecessor, days) }; };
    const quotaV12 = { ...quota, schemaVersion: "quota-observation-v1.2" };
    const sibling = await fresh([await stageScaleV12Day(modules, pool, context.schema, context.options, principal, today,
      [quotaV12, asV12(b), asV12(c)])]);
    const siblingProof = await proofParity(context, 12, principal, sibling.manifest, sibling.predecessor.token, ACCEPTED,
      "same-instant sibling");
    assert.deepEqual(historyProbes(siblingProof.live.statements), [], "a sibling matching its own legacy id is not a twin");
    assert.equal((await context.domain.activate(principal, sibling.manifest)).replay, false);
    assert.deepEqual(await usageCounts(context, participant, today, today), { [today]: 3 },
      "A keeps its legacy copy; B and C count once");

    // The accepted observation dropped and one of another slot new at its
    // instant: a different observation, not a twin (guard v2 refused it, its
    // sets carrying no limit or slot). The provisional pair is dropped by the
    // indexed detail lookup under the planner default, before any history
    // probe. Proof level only: the same-day closure keeps the sibling day's ids.
    const otherSlot = asV12Quota(quotaV11(today, 1, { slot: "secondary" }));
    const swapped = await fresh([await stageScaleV12Day(modules, pool, context.schema, context.options, principal, today,
      [otherSlot, asV12(b), asV12(c)])]);
    const swappedProof = await proofParity(context, 12, principal, swapped.manifest, swapped.predecessor.token, ACCEPTED,
      "quota of another slot");
    assert.deepEqual(swappedProof.live.exactness, [{ stream: 2, nestloop: swappedProof.live.nestloopBefore }]);
    assert.deepEqual(historyProbes(swappedProof.live.statements), [], "another slot is no twin");
  });
});

test("a quota observation is a twin only with the dropped observation's limit and slot", {
  skip: !PG_TEST_SOCKET, timeout: 180_000,
}, async () => {
  await withSchema(async context => {
    const today = new Date().toISOString().slice(0, 10);
    const participant = await seedParticipant(context, "rekey-quota");
    const principal = await seedDevice(context, participant, "rekey-quota", { v12: false });
    const options = { ...context.options, sourceNamespace: SOURCE_NAMESPACE };
    await initializeScaleV11(modules, pool, context.schema, options);
    await grantScaleV11(modules, pool, participant, principal, options);
    const v11Domain = modules.live.createPostgresTelemetryV11Domain(pool, options);
    // One accepted snapshot observation P (codex, primary) and one usage event.
    const p = quotaV11(today, 0), a = v11At(today, 0);
    const v11Day = await stageScaleV11Day(modules, pool, context.schema, options, principal, today, [p, a]);
    assert.equal((await v11Domain.activate(principal, scaleV11DomainManifest(await v11Domain.createPredecessor(principal),
      [v11Day]))).replay, false);
    await enableV12(context, principal);
    const quotaCounts = () => usageCounts(context, participant, today, today, "quota");
    assert.deepEqual(await quotaCounts(), { [today]: 1 });
    const fresh = async days => { const predecessor = await context.domain.createPredecessor(principal);
      return { predecessor, manifest: domainManifest(predecessor, days) }; };

    // P is no longer emitted, and observations of another limit and of
    // another slot are new at its instant: each pairs with P provisionally,
    // and the detail lookup drops both. Guard v2 refused this, and the
    // refused day stayed pinned as the day's earliest READY manifest.
    const otherLimit = asV12Quota(quotaV11(today, 1, { limitId: "codex_other" }));
    const otherSlot = asV12Quota(quotaV11(today, 2, { slot: "secondary" }));
    const distinctDay = await stageScaleV12Day(modules, pool, context.schema, context.options, principal, today,
      [otherLimit, otherSlot, asV12(a)]);
    const distinct = await fresh([distinctDay]);
    const proof = await proofParity(context, 12, principal, distinct.manifest, distinct.predecessor.token, ACCEPTED,
      "another limit and another slot at a dropped observation's instant");
    assert.deepEqual(proof.live.exactness, [{ stream: 2, nestloop: proof.live.nestloopBefore }],
      "the detail lookup ran once, under the planner default");
    assert.deepEqual(historyProbes(proof.live.statements), [], "both provisional pairs were dropped");
    assert.equal((await context.domain.activate(principal, distinct.manifest)).replay, false);
    assert.deepEqual(await quotaCounts(), { [today]: 3 }, "P keeps its legacy copy beside the two new observations");

    // P itself under a new id at its instant, beside the two: a twin.
    const rekeyedP = asV12Quota({ ...p, observationId: `quota-occurrence:v1:${sha256Hex("rekeyed:quota")}` });
    const twin = await fresh([await stageScaleV12Day(modules, pool, context.schema, context.options, principal, today,
      [otherLimit, otherSlot, rekeyedP, asV12(a)])]);
    const { live } = await rekeyRefusal(context, 12, principal, twin.manifest, twin.predecessor.token, "quota re-key");
    assert.deepEqual(live.exactness, [{ stream: 2, nestloop: live.nestloopBefore }]);
    await refused(context, principal, twin.manifest);
    assert.deepEqual(await quotaCounts(), { [today]: 3 });
  });
});

test("a machine re-paired under a new device id cannot re-key its old device's usage; another session can share the instant", {
  skip: !PG_TEST_SOCKET, timeout: 180_000,
}, async () => {
  await withSchema(async context => {
    const [yesterday, today] = [1, 0].map(back => new Date(Date.now() - back * DAY_MS).toISOString().slice(0, 10));
    const participant = await seedParticipant(context, "rekey-repaired");
    const old = await seedDevice(context, participant, "rekey-repaired-old", { v12: false });
    const repaired = await seedDevice(context, participant, "rekey-repaired-new", { v12: false });
    const options = { ...context.options, sourceNamespace: SOURCE_NAMESPACE };
    await initializeScaleV11(modules, pool, context.schema, options);
    await grantScaleV11(modules, pool, participant, old, options);
    const v11Domain = modules.live.createPostgresTelemetryV11Domain(pool, options);
    const legacy = Object.fromEntries([yesterday, today].map(day => [day, [0, 1, 2].map(index => v11At(day, index))]));
    const v11Days = [];
    for (const day of [yesterday, today]) {
      v11Days.push(await stageScaleV11Day(modules, pool, context.schema, options, old, day, legacy[day]));
    }
    assert.equal((await v11Domain.activate(old, scaleV11DomainManifest(await v11Domain.createPredecessor(old), v11Days)))
      .replay, false);
    await enableV12(context, repaired);
    const counts = () => usageCounts(context, participant, yesterday, today);
    assert.deepEqual(await counts(), { [yesterday]: 3, [today]: 3 });
    const fresh = async days => { const predecessor = await context.domain.createPredecessor(repaired);
      return { predecessor, manifest: domainManifest(predecessor, days) }; };

    // The same machine (same device salt, so the same ids) re-uploads today
    // under its new credential: the third event is absent and another
    // session's event sits at its instant. No twin, so it activates.
    const todayDay = await stage(context, repaired, today, "usage", [asV12(legacy[today][0]), asV12(legacy[today][1]),
      asV12(v11At(today, 2, { eventId: rekeyedId("repaired-other-session"), sessionUuid: OTHER_SESSION }))]);
    const sibling = await fresh([todayDay]);
    const proof = await proofParity(context, 12, repaired, sibling.manifest, sibling.predecessor.token, ACCEPTED,
      "another session on a re-paired machine");
    assert.deepEqual(historyProbes(proof.live.statements), [], "a different session is no twin on any device");
    assert.equal((await context.domain.activate(repaired, sibling.manifest)).replay, false);
    assert.deepEqual(await counts(), { [yesterday]: 3, [today]: 4 });

    // Yesterday's third event re-keyed in its own session under the new
    // device id is the old device's accepted v1.1 event: guard v2 accepted it
    // (its history was device-scoped) and the union counted it twice.
    const rekeyed = await fresh([await stage(context, repaired, yesterday, "usage", [asV12(legacy[yesterday][0]),
      asV12(legacy[yesterday][1]), asV12({ ...legacy[yesterday][2], eventId: rekeyedId("repaired") })]), todayDay]);
    await rekeyRefusal(context, 12, repaired, rekeyed.manifest, rekeyed.predecessor.token, "re-paired machine re-key");
    await refused(context, repaired, rekeyed.manifest);
    assert.deepEqual(await counts(), { [yesterday]: 3, [today]: 4 });
  });
});

test("a session record is a twin only when a usage event kept under its own id links it to the dropped session", {
  skip: !PG_TEST_SOCKET, timeout: 180_000,
}, async () => {
  await withSchema(async context => {
    const [yesterday, today] = [1, 0].map(back => new Date(Date.now() - back * DAY_MS).toISOString().slice(0, 10));
    const participant = await seedParticipant(context, "rekey-session");
    const principal = await seedDevice(context, participant, "rekey-session", { v12: false });
    const options = { ...context.options, sourceNamespace: SOURCE_NAMESPACE };
    await initializeScaleV11(modules, pool, context.schema, options);
    await grantScaleV11(modules, pool, participant, principal, options);
    const v11Domain = modules.live.createPostgresTelemetryV11Domain(pool, options);
    // A session id is not positional: the raw Codex session id or, before the
    // client recorded identity, a stable stand-in (hex of its local session
    // key). A session record is named by it and anchored at its first event.
    const session = (format, sessionUuid, firstEventTime) => ({ schemaVersion: `session-dimension-v1.${format}`,
      sessionUuid, firstEventTime, provider: "unknown", toolClassCounts: { shell: 2 } });
    const standIn = day => sha256Hex(`stand-in:${day}`);
    const events = Object.fromEntries([yesterday, today].map(day =>
      [day, [0, 1].map(index => v11At(day, index, { sessionUuid: standIn(day) }))]));
    const v11Days = [];
    for (const day of [yesterday, today]) {
      v11Days.push(await stageScaleV11Day(modules, pool, context.schema, options, principal, day,
        [...events[day], session(1, standIn(day), events[day][0].eventTime)]));
    }
    assert.equal((await v11Domain.activate(principal, scaleV11DomainManifest(await v11Domain.createPredecessor(principal),
      v11Days))).replay, false);
    await enableV12(context, principal);
    const sessions = () => usageCounts(context, participant, yesterday, today, "session");
    assert.deepEqual(await sessions(), { [yesterday]: 1, [today]: 1 });
    const fresh = async days => { const predecessor = await context.domain.createPredecessor(principal);
      return { predecessor, manifest: domainManifest(predecessor, days) }; };

    // Today the stand-in session's record is absent while its events keep
    // their ids and session, and an unrelated session starts at the same
    // instant: no kept event moves between them, so the provisional pair is
    // dropped by the link join (over the working sets, nested loops off).
    const unrelated = "00000000-0000-4000-8000-0000000000c3";
    const todayDay = await stageScaleV12Day(modules, pool, context.schema, context.options, principal, today,
      [...events[today].map(event => asV12(event)),
        asV12(v11At(today, 0, { eventId: rekeyedId("unrelated-first-event"), sessionUuid: unrelated })),
        session(2, unrelated, events[today][0].eventTime)]);
    const sibling = await fresh([todayDay]);
    const proof = await proofParity(context, 12, principal, sibling.manifest, sibling.predecessor.token, ACCEPTED,
      "an unlinked session at a dropped session's instant");
    assert.deepEqual(proof.live.exactness, [{ stream: 3, nestloop: "off" }]);
    assert.deepEqual(historyProbes(proof.live.statements), [], "an unlinked session is no twin");
    assert.equal((await context.domain.activate(principal, sibling.manifest)).replay, false);
    assert.deepEqual(await sessions(), { [yesterday]: 1, [today]: 2 });

    // Yesterday the client recorded the raw identity: the same events, under
    // their own ids, now name the raw session, and the session record
    // follows. That is the stand-in session re-keyed at its instant.
    const raw = "00000000-0000-4000-8000-0000000000d4";
    const switched = await stageScaleV12Day(modules, pool, context.schema, context.options, principal, yesterday,
      [...events[yesterday].map(event => asV12({ ...event, sessionUuid: raw })),
        session(2, raw, events[yesterday][0].eventTime)]);
    const rekeyed = await fresh([switched, todayDay]);
    const { live } = await rekeyRefusal(context, 12, principal, rekeyed.manifest, rekeyed.predecessor.token,
      "session identity switch");
    assert.deepEqual(live.exactness, [{ stream: 3, nestloop: "off" }]);
    await refused(context, principal, rekeyed.manifest);
    assert.deepEqual(await sessions(), { [yesterday]: 1, [today]: 2 });
  });
});

test("a twin this device's accepted v1.2 history already holds does not wedge it; a new twin still refuses on retry", {
  skip: !PG_TEST_SOCKET, timeout: 180_000,
}, async () => {
  const { v12: deployedV12 } = await deployedDomains();
  await withSchema(async context => {
    const [twoDaysAgo, yesterday, today] = [2, 1, 0].map(back => new Date(Date.now() - back * DAY_MS).toISOString().slice(0, 10));
    const participant = await seedParticipant(context, "rekey-accepted");
    const principal = await seedDevice(context, participant, "rekey-accepted", { v12: false });
    const options = { ...context.options, sourceNamespace: SOURCE_NAMESPACE };
    await initializeScaleV11(modules, pool, context.schema, options);
    await grantScaleV11(modules, pool, participant, principal, options);
    const v11Domain = modules.live.createPostgresTelemetryV11Domain(pool, options);
    const legacy = Object.fromEntries([[twoDaysAgo, 2], [yesterday, 2], [today, 3]].map(([day, count]) =>
      [day, Array.from({ length: count }, (_, index) => v11At(day, index))]));
    const v11Days = [];
    for (const [day, records] of Object.entries(legacy)) {
      v11Days.push(await stageScaleV11Day(modules, pool, context.schema, options, principal, day, records));
    }
    assert.equal((await v11Domain.activate(principal, scaleV11DomainManifest(await v11Domain.createPredecessor(principal),
      v11Days))).replay, false);
    await enableV12(context, principal);
    const counts = () => usageCounts(context, participant, twoDaysAgo, today);
    assert.deepEqual(await counts(), { [twoDaysAgo]: 2, [yesterday]: 2, [today]: 3 });

    // Production's proof before this guard accepted a re-key of today's third
    // event, so this device's accepted v1.2 history holds the twin and the
    // union already counts that event twice.
    const rekeyedToday = await stage(context, principal, today, "usage",
      [asV12(legacy[today][0]), asV12(legacy[today][1]), asV12({ ...legacy[today][2], eventId: rekeyedId("accepted") })]);
    const first = domainManifest(await context.domain.createPredecessor(principal), [rekeyedToday]);
    assert.equal((await deployedV12.createPostgresTypedV12Domain(pool, context.options).activate(principal, first)).replay, false);
    assert.deepEqual(await counts(), { [twoDaysAgo]: 2, [yesterday]: 2, [today]: 4 });
    const fresh = async days => { const predecessor = await context.domain.createPredecessor(principal);
      return { predecessor, manifest: domainManifest(predecessor, days) }; };

    // Adding a new day introduces nothing: the twin is found, matched in the
    // accepted history and the activation proceeds.
    const yesterdayDay = await stage(context, principal, yesterday, "usage", legacy[yesterday].map(record => asV12(record)));
    const next = await fresh([yesterdayDay, rekeyedToday]);
    const nextProof = await proofParity(context, 12, principal, next.manifest, next.predecessor.token, ACCEPTED,
      "twin already accepted");
    assert.equal(historyProbes(nextProof.live.statements).length, 1, "the twin was checked against accepted history");
    assert.deepEqual(perRowRescans(historyPlan(nextProof.live)), [], "the history probe joins as sets, rescanning no set per row");
    assert.deepEqual(nextProof.live.guardNestloop, ["off", nextProof.live.nestloopBefore]);
    assert.equal((await context.domain.activate(principal, next.manifest)).replay, false);
    assert.deepEqual(await counts(), { [twoDaysAgo]: 2, [yesterday]: 2, [today]: 4 }, "no further double count");

    // A new twin beside the accepted one still refuses. Its refused manifest
    // stays the day's earliest READY one, which every later predecessor pins
    // (so pinned predecessor days are no accepted baseline): a retry refuses.
    const rekeyedOld = await stage(context, principal, twoDaysAgo, "usage",
      [asV12(legacy[twoDaysAgo][0]), asV12({ ...legacy[twoDaysAgo][1], eventId: rekeyedId("introduced") })]);
    for (const label of ["new twin beside an accepted one", "retry with the refused day pinned"]) {
      const retry = await fresh([rekeyedOld, yesterdayDay, rekeyedToday]);
      const pinned = (await pool.query(`SELECT days_json FROM ${context.table("telemetry_v12_domain_predecessors")}
        WHERE token_hash=$1`, [sha256Hex(retry.predecessor.token)])).rows[0].days_json;
      assert.ok(JSON.parse(pinned).some(day => day.manifestId === rekeyedOld.manifestId), `${label}: pinned`);
      await rekeyRefusal(context, 12, principal, retry.manifest, retry.predecessor.token, label);
      await refused(context, principal, retry.manifest);
    }
    assert.deepEqual(await counts(), { [twoDaysAgo]: 2, [yesterday]: 2, [today]: 4 });
  });
});

test("a twin this device's accepted v1.1 history already holds does not wedge a v1.1 activation", {
  skip: !PG_TEST_SOCKET, timeout: 180_000,
}, async () => {
  const { live: deployedLive } = await deployedDomains();
  await withSchema(async context => {
    const [yesterday, today] = [1, 0].map(back => new Date(Date.now() - back * DAY_MS).toISOString().slice(0, 10));
    const participant = await seedParticipant(context, "rekey-accepted-v11");
    const principal = await seedDevice(context, participant, "rekey-accepted-v11", { v12: false });
    const other = await seedDevice(context, participant, "rekey-accepted-v11-other", { v12: false });
    const options = { ...context.options, sourceNamespace: SOURCE_NAMESPACE };
    await v1Ready(context, participant);
    const project = record => JSON.parse(modules.compatibility.telemetryV11LegacyProjection("usage", record).canonicalRecord);
    const own = [0, 1, 2].map(index => v11At(today, index));
    const ownV1 = await seedTypedV1Chunk(modules, pool, context.schema, { ...principal, principal },
      { day: today, stream: "usage", chunkSeq: 0, records: own.map(project) });
    await ownV1.admit({ ownerDigest: participant.ownerDigest, firstSourceRowId: 1 });
    // Another device's newer v1 chunk wins the day, so the v1-to-v1.1
    // transition closure requires its event, not this device's.
    await new Promise(done => setTimeout(done, 20));
    const winner = v11At(today, 5);
    const otherV1 = await seedTypedV1Chunk(modules, pool, context.schema, { ...other, principal: other },
      { day: today, stream: "usage", chunkSeq: 0, records: [project(winner)] });
    await otherV1.admit({ ownerDigest: participant.ownerDigest, firstSourceRowId: 4 });
    await grantScaleV11(modules, pool, participant, principal, options);
    // Production's proof before this guard accepted this device's re-key of its third v1 event.
    const rekeyedToday = await stageScaleV11Day(modules, pool, context.schema, options, principal, today,
      [own[0], own[1], { ...own[2], eventId: rekeyedId("accepted-v11") }, winner]);
    const deployedV11 = deployedLive.createPostgresTelemetryV11Domain(pool, options);
    assert.equal((await deployedV11.activate(principal, scaleV11DomainManifest(await deployedV11.createPredecessor(principal),
      [rekeyedToday]))).replay, false);
    // Adding a new day introduces nothing, so it activates.
    const v11Domain = modules.live.createPostgresTelemetryV11Domain(pool, options);
    const yesterdayDay = await stageScaleV11Day(modules, pool, context.schema, options, principal, yesterday,
      [v11At(yesterday, 0)]);
    const predecessor = await v11Domain.createPredecessor(principal);
    const manifest = scaleV11DomainManifest(predecessor, [yesterdayDay, rekeyedToday]);
    const proof = await proofParity(context, 11, principal, manifest, predecessor.token, ACCEPTED, "v1.1 twin already accepted");
    assert.equal(historyProbes(proof.live.statements).length, 1, "the twin was checked against accepted v1.1 history");
    assert.deepEqual(proof.live.guardNestloop, ["off", "off"]);
    assert.equal((await v11Domain.activate(principal, manifest)).replay, false);
  });
});

// A machine re-paired under a new device id: the old credential and its v1.2
// capability are revoked. The occurrence reader retains a revoked v1.2
// capability's generations (its retained authorization scope), so the union
// keeps reading the old device's accepted v1.2 history.
async function revokeDevice(context, principal) {
  await pool.query(`UPDATE ${context.table("device_credentials")} SET state='revoked',revoked_at=clock_timestamp()
    WHERE id=$1`, [principal.deviceId]);
  await pool.query(`UPDATE ${context.table("telemetry_v12_device_capabilities")} SET state='revoked',revoked_at=clock_timestamp()
    WHERE device_id=$1`, [principal.deviceId]);
}

test("a re-paired machine is not wedged by a twin its old device's retained v1.2 history already holds", {
  skip: !PG_TEST_SOCKET, timeout: 240_000,
}, async () => {
  const { v12: deployedV12 } = await deployedDomains();
  await withSchema(async context => {
    const [yesterday, today] = [1, 0].map(back => new Date(Date.now() - back * DAY_MS).toISOString().slice(0, 10));
    const participant = await seedParticipant(context, "repaired-accepted");
    const old = await seedDevice(context, participant, "repaired-accepted-old", { v12: false });
    const repaired = await seedDevice(context, participant, "repaired-accepted-new", { v12: false });
    const options = { ...context.options, sourceNamespace: SOURCE_NAMESPACE };
    await initializeScaleV11(modules, pool, context.schema, options);
    await grantScaleV11(modules, pool, participant, old, options);
    const v11Domain = modules.live.createPostgresTelemetryV11Domain(pool, options);
    const legacy = Object.fromEntries([yesterday, today].map(day => [day, [0, 1, 2].map(index => v11At(day, index))]));
    const v11Days = [];
    for (const day of [yesterday, today]) {
      v11Days.push(await stageScaleV11Day(modules, pool, context.schema, options, old, day, legacy[day]));
    }
    assert.equal((await v11Domain.activate(old, scaleV11DomainManifest(await v11Domain.createPredecessor(old), v11Days)))
      .replay, false);
    // Production's proof before this guard accepted the old device's v1.2
    // re-key of each day's third event, so the union counts each twice.
    await enableV12(context, old);
    const rekeyed = Object.fromEntries([yesterday, today].map(day => [day, [asV12(legacy[day][0], KNOWN),
      asV12(legacy[day][1], KNOWN), asV12({ ...legacy[day][2], eventId: rekeyedId(`repaired-accepted:${day}`) }, KNOWN)]]));
    const oldDays = [];
    for (const day of [yesterday, today]) oldDays.push(await stage(context, old, day, "usage", rekeyed[day]));
    assert.equal((await deployedV12.createPostgresTypedV12Domain(pool, context.options)
      .activate(old, domainManifest(await context.domain.createPredecessor(old), oldDays))).replay, false);
    const counts = () => usageCounts(context, participant, yesterday, today);
    assert.deepEqual(await counts(), { [yesterday]: 4, [today]: 4 });
    await revokeDevice(context, old);
    assert.deepEqual(await counts(), { [yesterday]: 4, [today]: 4 }, "the reader retains the revoked device's generations");
    await enableV12(context, repaired);
    const fresh = async days => { const predecessor = await context.domain.createPredecessor(repaired);
      return { predecessor, manifest: domainManifest(predecessor, days) }; };

    // The same machine (same device salt, so the same ids) uploads yesterday
    // under its new credential while the old device's generation is the head:
    // its twin is the other retained device's head record by id, so no twin.
    const newYesterday = await stage(context, repaired, yesterday, "usage", rekeyed[yesterday]);
    const first = await fresh([newYesterday]);
    const headProof = await proofParity(context, 12, repaired, first.manifest, first.predecessor.token, ACCEPTED,
      "a twin the old device's head generation holds");
    assert.deepEqual(historyProbes(headProof.live.statements), [], "matched by id in another retained device's head");
    assert.equal((await context.domain.activate(repaired, first.manifest)).replay, false);
    assert.deepEqual(await counts(), { [yesterday]: 4, [today]: 4 }, "no occurrence is added");

    // The head is now this device's, so today's twin is found. The old
    // device's accepted generation holds it and the reader reads that
    // generation, so it is exempt (guard v3 read only the activating device's
    // history, refused, and the refused day stayed pinned).
    const newToday = await stage(context, repaired, today, "usage", rekeyed[today]);
    const next = await fresh([newYesterday, newToday]);
    const proof = await proofParity(context, 12, repaired, next.manifest, next.predecessor.token, ACCEPTED,
      "a twin another retained device's accepted generation holds");
    assert.equal(historyProbes(proof.live.statements).length, 1, "the twin was checked against accepted history");
    assert.deepEqual(perRowRescans(historyPlan(proof.live)), [], "the history probe rescans no set per row");
    assert.deepEqual(proof.live.exactness, [], "a usage twin has no detail lookup");
    assert.equal((await context.domain.activate(repaired, next.manifest)).replay, false);
    assert.deepEqual(await counts(), { [yesterday]: 4, [today]: 4 }, "no occurrence is added");
  });
});

test("a re-paired machine is not wedged by a twin its old device's accepted v1.1 history already holds", {
  skip: !PG_TEST_SOCKET, timeout: 180_000,
}, async () => {
  const { live: deployedLive } = await deployedDomains();
  await withSchema(async context => {
    const [yesterday, today] = [1, 0].map(back => new Date(Date.now() - back * DAY_MS).toISOString().slice(0, 10));
    const participant = await seedParticipant(context, "repaired-accepted-v11");
    const old = await seedDevice(context, participant, "repaired-accepted-v11-old", { v12: false });
    const repaired = await seedDevice(context, participant, "repaired-accepted-v11-new", { v12: false });
    const other = await seedDevice(context, participant, "repaired-accepted-v11-other", { v12: false });
    const options = { ...context.options, sourceNamespace: SOURCE_NAMESPACE };
    await v1Ready(context, participant);
    const project = record => JSON.parse(modules.compatibility.telemetryV11LegacyProjection("usage", record).canonicalRecord);
    const own = [0, 1, 2].map(index => v11At(today, index));
    const oldV1 = await seedTypedV1Chunk(modules, pool, context.schema, { ...old, principal: old },
      { day: today, stream: "usage", chunkSeq: 0, records: own.map(project) });
    await oldV1.admit({ ownerDigest: participant.ownerDigest, firstSourceRowId: 1 });
    // Another device's newer v1 chunk wins the day, so the v1-to-v1.1
    // transition closure requires its event of each activation.
    await new Promise(done => setTimeout(done, 20));
    const winner = v11At(today, 5);
    const otherV1 = await seedTypedV1Chunk(modules, pool, context.schema, { ...other, principal: other },
      { day: today, stream: "usage", chunkSeq: 0, records: [project(winner)] });
    await otherV1.admit({ ownerDigest: participant.ownerDigest, firstSourceRowId: 4 });
    // Production's proof before this guard accepted the old device's re-key of its third v1 event.
    await grantScaleV11(modules, pool, participant, old, options);
    const rekeyedToday = [own[0], own[1], { ...own[2], eventId: rekeyedId("repaired-accepted-v11") }, winner];
    const deployedV11 = deployedLive.createPostgresTelemetryV11Domain(pool, options);
    const oldDay = await stageScaleV11Day(modules, pool, context.schema, options, old, today, rekeyedToday);
    assert.equal((await deployedV11.activate(old, scaleV11DomainManifest(await deployedV11.createPredecessor(old),
      [oldDay]))).replay, false);
    const counts = () => usageCounts(context, participant, yesterday, today);
    assert.deepEqual(await counts(), { [today]: 5 }, "the union counts the re-keyed event twice");

    // The same machine re-paired re-uploads the day with the same ids and adds
    // yesterday. Its twin of the v1 event is in the old device's accepted v1.1
    // set, which the legacy reader reads, so it introduces nothing (guard v3
    // read only the activating device's v1.1 set and refused).
    await grantScaleV11(modules, pool, participant, repaired, options);
    const v11Domain = modules.live.createPostgresTelemetryV11Domain(pool, options);
    const days = [await stageScaleV11Day(modules, pool, context.schema, options, repaired, yesterday, [v11At(yesterday, 0)]),
      await stageScaleV11Day(modules, pool, context.schema, options, repaired, today, rekeyedToday)];
    const predecessor = await v11Domain.createPredecessor(repaired);
    const manifest = scaleV11DomainManifest(predecessor, days);
    const proof = await proofParity(context, 11, repaired, manifest, predecessor.token, ACCEPTED,
      "a v1.1 twin another device's accepted v1.1 history holds");
    assert.equal(historyProbes(proof.live.statements).length, 1, "the twin was checked against accepted v1.1 history");
    assert.deepEqual(proof.live.guardNestloop, ["off", "off"]);
    assert.deepEqual(proof.live.exactness, [], "a usage twin has no detail lookup");
    assert.equal((await v11Domain.activate(repaired, manifest)).replay, false);
    assert.deepEqual(await counts(), { [yesterday]: 1, [today]: 5 }, "no occurrence is added today");
  });
});

test("a re-paired machine cannot re-key its old device's v1.2 history while that history is the head", {
  skip: !PG_TEST_SOCKET, timeout: 180_000,
}, async () => {
  await withSchema(async context => {
    const [yesterday, today] = [1, 0].map(back => new Date(Date.now() - back * DAY_MS).toISOString().slice(0, 10));
    const participant = await seedParticipant(context, "repaired-v12");
    const old = await seedDevice(context, participant, "repaired-v12-old", { v12: true });
    const repaired = await seedDevice(context, participant, "repaired-v12-new", { v12: true });
    const events = Object.fromEntries([[yesterday, 2], [today, 3]].map(([day, count]) =>
      [day, Array.from({ length: count }, (_, index) => asV12(v11At(day, index), KNOWN))]));
    const oldDays = [];
    for (const day of [yesterday, today]) oldDays.push(await stage(context, old, day, "usage", events[day]));
    assert.equal((await context.domain.activate(old, domainManifest(await context.domain.createPredecessor(old), oldDays)))
      .replay, false);
    const counts = () => usageCounts(context, participant, yesterday, today);
    assert.deepEqual(await counts(), { [yesterday]: 2, [today]: 3 });
    await revokeDevice(context, old);
    const fresh = async days => { const predecessor = await context.domain.createPredecessor(repaired);
      return { predecessor, manifest: domainManifest(predecessor, days) }; };

    // The same machine's ids preserved under the new credential: no twin.
    const newYesterday = await stage(context, repaired, yesterday, "usage", events[yesterday]);
    const kept = await fresh([newYesterday]);
    const keptProof = await proofParity(context, 12, repaired, kept.manifest, kept.predecessor.token, ACCEPTED,
      "ids preserved across device ids");
    assert.deepEqual(historyProbes(keptProof.live.statements), [], "every id is matched in the old device's head");

    // Today's third event is absent and another session's event sits at its
    // instant: a different event, not a twin.
    const sibling = await fresh([newYesterday, await stage(context, repaired, today, "usage", [events[today][0], events[today][1],
      asV12(v11At(today, 2, { eventId: rekeyedId("repaired-v12-other-session"), sessionUuid: OTHER_SESSION }), KNOWN)])]);
    const siblingProof = await proofParity(context, 12, repaired, sibling.manifest, sibling.predecessor.token, ACCEPTED,
      "another session at the old device's dropped event's instant");
    assert.deepEqual(historyProbes(siblingProof.live.statements), [], "a different session is no twin");

    // The third event re-keyed in its session: the old device's v1.2 event
    // counted twice (guard v3 had no v1.2 legacy and accepted it).
    const rekeyed = await fresh([newYesterday, await stage(context, repaired, today, "usage", [events[today][0],
      events[today][1], { ...events[today][2], eventId: rekeyedId("repaired-v12") }])]);
    const { live } = await rekeyRefusal(context, 12, repaired, rekeyed.manifest, rekeyed.predecessor.token,
      "re-paired machine v1.2 re-key");
    assert.deepEqual(live.exactness, [], "a usage twin has no detail lookup");
    await refused(context, repaired, rekeyed.manifest);
    assert.deepEqual(await counts(), { [yesterday]: 2, [today]: 3 });
  });
});

// ADV3-5, an accepted known false positive. Guard v5 (owner decision
// 2026-10-11, "v4 without token rule") matches a usage twin by session and
// instant alone, so a distinct event of the dropped event's tie group refuses
// like a re-key, and in production the refused day stays pinned. The owner
// accepted this: production showed no instance, while guard v4's quantity rule
// let the Gate 0 re-parses (next test) double count.
test("a distinct event of a dropped usage event's tie group refuses like a re-key (accepted false positive)", {
  skip: !PG_TEST_SOCKET, timeout: 180_000,
}, async () => {
  await withSchema(async context => {
    const today = new Date().toISOString().slice(0, 10);
    const participant = await seedParticipant(context, "rekey-tie-group");
    const principal = await seedDevice(context, participant, "rekey-tie-group", { v12: false });
    const options = { ...context.options, sourceNamespace: SOURCE_NAMESPACE };
    await initializeScaleV11(modules, pool, context.schema, options);
    await grantScaleV11(modules, pool, participant, principal, options);
    const v11Domain = modules.live.createPostgresTelemetryV11Domain(pool, options);
    // E1 and E3 share session and instant (a tie group) but are distinct
    // events with different token quantities. v1.1 kept E1 and not E3.
    const e1 = v11At(today, 0);
    const e3 = v11At(today, 1, { eventTime: e1.eventTime, totalInputContextTokens: 5000,
      components: { ...e1.components, inputUncachedTokens: 4000, inputCacheReadTokens: 1000 } });
    const v11Day = await stageScaleV11Day(modules, pool, context.schema, options, principal, today, [e1]);
    assert.equal((await v11Domain.activate(principal, scaleV11DomainManifest(await v11Domain.createPredecessor(principal),
      [v11Day]))).replay, false);
    await enableV12(context, principal);
    const counts = () => usageCounts(context, participant, today, today);
    assert.deepEqual(await counts(), { [today]: 1 });
    const fresh = async days => { const predecessor = await context.domain.createPredecessor(principal);
      return { predecessor, manifest: domainManifest(predecessor, days) }; };

    // v1.2 keeps E3 and not E1: E3 shares E1's session and instant, so it is
    // E1's twin whatever its quantities, and refuses although the union would
    // count each event once (guard v4 accepted it by its quantities).
    const tie = await fresh([await stage(context, principal, today, "usage", [asV12(e3, KNOWN)])]);
    const tieRefusal = await rekeyRefusal(context, 12, principal, tie.manifest, tie.predecessor.token,
      "a distinct event of the dropped event's tie group");
    assert.deepEqual(tieRefusal.live.exactness, [], "token quantities are not looked up");
    await refused(context, principal, tie.manifest);
    assert.deepEqual(await counts(), { [today]: 1 });

    // E1 itself under a new id with its quantities, beside E3: a twin.
    const twin = await fresh([await stage(context, principal, today, "usage",
      [asV12(e3, KNOWN), asV12({ ...e1, eventId: rekeyedId("tie-group") }, KNOWN)])]);
    const { live } = await rekeyRefusal(context, 12, principal, twin.manifest, twin.predecessor.token, "tie-group re-key");
    assert.deepEqual(live.exactness, [], "token quantities are not looked up");
    await refused(context, principal, twin.manifest);
    assert.deepEqual(await counts(), { [today]: 1 });
  });
});

// Production Gate 0 (2026-10-11) held 2,154 usage events re-keyed between
// v1.1 (parser v16) and v1.2 (parser v20) in the same session at the same
// instant whose token quantities differ: the same auto-review events
// re-parsed. Re-keys of those events from v1.1 to v1.1 kept identical
// quantities. Guard v4's quantity rule took each for a distinct event and let
// the union count it twice; guard v5 compares no quantities.
test("a usage re-key whose token quantities differ refuses (the production Gate 0 shape)", {
  skip: !PG_TEST_SOCKET, timeout: 180_000,
}, async () => {
  await withSchema(async context => {
    const today = new Date().toISOString().slice(0, 10);
    const participant = await seedParticipant(context, "rekey-requantified");
    const principal = await seedDevice(context, participant, "rekey-requantified", { v12: false });
    const options = { ...context.options, sourceNamespace: SOURCE_NAMESPACE };
    await initializeScaleV11(modules, pool, context.schema, options);
    await grantScaleV11(modules, pool, participant, principal, options);
    const v11Domain = modules.live.createPostgresTelemetryV11Domain(pool, options);
    const legacy = [0, 1, 2].map(index => v11At(today, index));
    const v11Day = await stageScaleV11Day(modules, pool, context.schema, options, principal, today, legacy);
    assert.equal((await v11Domain.activate(principal, scaleV11DomainManifest(await v11Domain.createPredecessor(principal),
      [v11Day]))).replay, false);
    await enableV12(context, principal);
    const counts = () => usageCounts(context, participant, today, today);
    assert.deepEqual(await counts(), { [today]: 3 });

    // The third event re-parsed under a new id, in its session at its instant,
    // with every token quantity changed.
    const reparsed = { ...legacy[2], eventId: rekeyedId("requantified"), totalInputContextTokens: 1400,
      components: { ...legacy[2].components, inputUncachedTokens: 300, inputCacheReadTokens: 1100,
        outputTextTokens: 70, outputReasoningTokens: 35 } };
    assert.notEqual(reparsed.totalInputContextTokens, legacy[2].totalInputContextTokens);
    for (const name of ["inputUncachedTokens", "inputCacheReadTokens", "outputTextTokens", "outputReasoningTokens"]) {
      assert.notEqual(reparsed.components[name], legacy[2].components[name], `${name} differs`);
    }
    const predecessor = await context.domain.createPredecessor(principal);
    const manifest = domainManifest(predecessor, [await stage(context, principal, today, "usage",
      [asV12(legacy[0], KNOWN), asV12(legacy[1], KNOWN), asV12(reparsed, KNOWN)])]);
    const { live } = await rekeyRefusal(context, 12, principal, manifest, predecessor.token, "re-parse with other quantities");
    assert.deepEqual(live.exactness, [], "token quantities are not looked up");
    await refused(context, principal, manifest);
    assert.deepEqual(await counts(), { [today]: 3 }, "nothing is counted twice");
  });
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
    assert.equal(history.length,migrations.length,"later promoted migrations append after 0076");
    assert.deepEqual(history.slice(0,75),oldHistory);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await rm(prefixRoot,{recursive:true,force:true});
  }
});
