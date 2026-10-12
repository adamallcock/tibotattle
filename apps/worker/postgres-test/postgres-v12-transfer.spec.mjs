import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalTelemetryV12Json, telemetryV12RequiredConsent } from "@app-usagemonitor/telemetry-contract";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import {
  createSealedSqliteV12RehearsalSource,
  loadPostgresV12EffectiveReader,
  POSTGRES_V12_TRANSFER_CONTROL_SCHEMA_PREFIX,
  POSTGRES_V12_TRANSFER_LAYOUT,
  POSTGRES_V12_TRANSFER_SOURCE_TABLES,
  POSTGRES_V12_TRANSFER_TARGET_SCHEMA_PREFIX,
  PostgresV12TransferError,
  runPostgresV12Transfer,
} from "../scripts/postgres-v12-transfer.mjs";

/*
 * T-2: the v1.2 telemetry importer (scripts/postgres-v12-transfer.mjs) from a
 * sealed D1 USAGE_MONITOR_DB SQLite file into a prefix-only PostgreSQL 17
 * rehearsal schema.
 *
 * The D1 fixture is built from this checkout's D1 migration directories with
 * node:sqlite (their 14 v1.2 tables are byte-identical to d43c8f92's), then its
 * triggers are dropped and synthetic, content-free rows are written directly,
 * as a sealed export holds them. Every typed record is encoded by the Worker's
 * own v1.2 codec, so its canonical digest is the one the PostgreSQL reader
 * re-derives. The fixture has two v1.2 owners (one social, one accountless
 * with an expired retained grant), three generations (one superseded, with
 * two days whose manifests changed), ten observed days and one abandoned
 * staged manifest.
 *
 * Identity rows (participants, sessions, pairings, devices, accountless
 * enrollment and owner links) are copied into the target by a spec-local
 * stand-in for T-1 before the importer runs, which is the rehearsal order.
 *
 * The Q-1 dump test runs only when POSTGRES_V12_TRANSFER_Q1_DUMP names Q-1's
 * dump/usage-monitor-db.json; it is skipped otherwise.
 */

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER || "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD;
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";
const SKIP = !PG_TEST_HOST && !PG_TEST_SOCKET;
const Q1_DUMP = process.env.POSTGRES_V12_TRANSFER_Q1_DUMP;
const Q1_EXPECTED_DAYS = process.env.POSTGRES_V12_TRANSFER_Q1_EXPECTED_DAYS;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const D1_DIRECTORIES = Object.freeze([
  "migrations", "typed-ingestion-migrations", "ingestion-bridge-migrations",
  "typed-v11-admission-migrations", "typed-v1-admission-migrations",
  "ingestion-isolation-migrations",
]);
const STREAMS = Object.freeze(["usage", "quota", "session"]);
const D1_V12_TABLES = Object.freeze([
  "telemetry_v12_runtime", "telemetry_v12_device_capabilities", "accountless_v12_device_authorizations",
  "telemetry_v12_day_manifests", "telemetry_v12_chunks", "telemetry_v12_attributions", "telemetry_v12_records",
  "telemetry_v12_usage", "telemetry_v12_quota", "telemetry_v12_session_tools",
  "telemetry_v12_domain_predecessors", "telemetry_v12_domains", "telemetry_v12_domain_days",
  "telemetry_v12_domain_heads",
]);
/** D1 table -> PostgreSQL table, for the independent per-table count check. */
const TARGET_OF = Object.freeze({
  telemetry_v12_runtime: "telemetry_v12_typed_runtime",
  telemetry_v12_attributions: "telemetry_v12_typed_attributions",
  telemetry_v12_records: "telemetry_v12_typed_records",
  telemetry_v12_usage: "telemetry_v12_typed_usage",
  telemetry_v12_quota: "telemetry_v12_typed_quota",
  telemetry_v12_session_tools: "telemetry_v12_typed_session_tools",
});
/** T-1 stand-in: identity tables in foreign-key order. */
const IDENTITY_TABLES = Object.freeze([
  "participants", "web_sessions", "device_pairings", "accountless_enrollment_ledger",
  "device_credentials", "accountless_upload_owners", "storage_v11_owner_links",
]);
const FIRST_DAY = "2026-09-20";
const DAY_COUNT = 10;
const PARSER_VERSION = "synthetic-t2-v12";
const ACCOUNTLESS_ISSUED_AT = "2026-08-29T00:00:00.000Z";
const ACCOUNTLESS_EXPIRES_AT = "2026-09-28T00:00:00.000Z";

let pool;
let vite;
let codec;
let reader;
let d1Sql;
const cleanups = [];

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function addDays(day, count) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + count * 86_400_000).toISOString().slice(0, 10);
}

function uuidFrom(seed) {
  const hex = sha256Hex(seed);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function hex64(seed) {
  return sha256Hex(`t2-fixture\u0000${seed}`);
}

async function endpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "the v1.2 transfer spec requires loopback or a private Unix socket");
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
  if (PG_TEST_SOCKET) {
    assert.match(PG_TEST_SOCKET, /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
    const link = await lstat(PG_TEST_SOCKET);
    const host = await realpath(PG_TEST_SOCKET);
    const metadata = await stat(host);
    assert.equal(link.isSymbolicLink(), false);
    assert.ok(host.startsWith("/private/tmp/tibotattle-pg-"));
    assert.equal(metadata.isDirectory(), true);
    assert.equal(metadata.mode & 0o077, 0);
    assert.equal(metadata.uid, process.getuid());
    return { host, port: PG_TEST_PORT };
  }
  return { host: PG_TEST_HOST, port: PG_TEST_PORT };
}

async function createPool() {
  const created = new pg.Pool({
    ...(await endpoint()),
    user: PG_TEST_USER,
    ...(PG_TEST_PASSWORD === undefined ? {} : { password: PG_TEST_PASSWORD }),
    database: PG_TEST_DATABASE,
    ssl: false,
    max: 4,
    connectionTimeoutMillis: 5_000,
  });
  const server = await created.query("SELECT current_setting('server_version_num')::integer AS version");
  assert.equal(Math.floor(Number(server.rows[0]?.version) / 10_000), 17, "the disposable server must be PostgreSQL 17");
  return created;
}

/** A migrated, uniquely named target schema plus its control schema; both are dropped after the run. */
async function createTarget() {
  const suffix = randomBytes(6).toString("hex");
  const targetSchema = `${POSTGRES_V12_TRANSFER_TARGET_SCHEMA_PREFIX}t2${suffix}`;
  const controlSchema = `${POSTGRES_V12_TRANSFER_CONTROL_SCHEMA_PREFIX}t2c${suffix}`;
  await pool.query(`CREATE SCHEMA "${targetSchema}"`);
  cleanups.push(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${targetSchema}" CASCADE`);
    await pool.query(`DROP SCHEMA IF EXISTS "${controlSchema}" CASCADE`);
  });
  await pool.query(`CREATE SCHEMA "${controlSchema}"`);
  const applied = await applyPostgresMigrations({ role: "primary", schema: targetSchema, pool });
  assert.equal(applied.applied, applied.migrations.length);
  return { targetSchema, controlSchema };
}

async function scratchDirectory() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tibotattle-t2-v12-")));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function sealFile(path) {
  await chmod(path, 0o444);
  return sha256Hex(await readFile(path));
}

async function d1Migrations() {
  d1Sql ??= (async () => {
    const sources = [];
    for (const directory of D1_DIRECTORIES) {
      const names = (await readdir(join(WORKER_ROOT, directory)))
        .filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/u.test(name)).sort();
      for (const name of names) sources.push(await readFile(join(WORKER_ROOT, directory, name), "utf8"));
    }
    return sources;
  })();
  return d1Sql;
}

// ---------------------------------------------------------------------------
// Synthetic D1 fixture

function usageRecord(seed, day, index, sessionUuid, model) {
  const base = Date.parse(`${day}T09:00:00.000Z`) + index * 600_000;
  return {
    schemaVersion: "usage-event-v1.2",
    eventId: `event:v2:${hex64(`usage|${seed}|${index}`)}`,
    eventTime: new Date(base).toISOString(),
    sessionUuid,
    provider: "openai_codex",
    modelId: model,
    speedMode: "standard",
    apiServiceTier: "default",
    surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription",
    reasoningEffort: index % 2 === 0 ? "high" : "medium",
    agentScope: "root",
    outcome: "completed",
    totalInputContextTokens: 1_000 + index,
    components: {
      inputUncachedTokens: 100 + index,
      inputCacheReadTokens: 900,
      inputCacheWriteTokens: 0,
      outputTextTokens: 50,
      outputReasoningTokens: 25,
      outputCombinedTokens: 75,
    },
    accountPlanAttribution: {
      accountBasis: "unavailable", accountTrackId: null,
      planBasis: "same_source_occurrence", planType: "pro", planEraId: null,
    },
    boundaryFlags: null,
    tieOrder: null,
    cacheWriteTtl: null,
  };
}

function quotaRecord(seed, day, usedPercent) {
  return {
    schemaVersion: "quota-observation-v1.2",
    observationId: `quota-occurrence:v1:${hex64(`quota|${seed}`)}`,
    observedTime: `${day}T12:05:00.000Z`,
    provider: "openai_codex",
    planType: "pro",
    planVariant: "unknown",
    limitId: "codex",
    slot: "primary",
    usedPercent,
    windowDurationMinutes: 10_080,
    resetsAt: `${addDays(day, 3)}T00:00:00.000Z`,
    accountPlanAttribution: {
      accountBasis: "unavailable", accountTrackId: null,
      planBasis: "same_source_occurrence", planType: "pro", planEraId: null,
    },
  };
}

function sessionRecord(sessionUuid, day, tools) {
  return {
    schemaVersion: "session-dimension-v1.2",
    sessionUuid,
    firstEventTime: `${day}T08:59:00.000Z`,
    provider: "openai_codex",
    toolClassCounts: tools,
  };
}

/** One owner-day upload: three usage records, one quota and one session record. */
function dayRecords(owner, day, variant) {
  const sessionUuid = uuidFrom(`session|${owner}|${day}|${variant === "v2" ? "v2" : "v1"}`);
  const keep = (index) => `${owner}|${day}|${index}`;
  const usage = [0, 1].map((index) => usageRecord(keep(index), day, index, sessionUuid, "gpt-5.6-sol"));
  // The re-uploaded variant replaces the third usage record and the quota record.
  usage.push(usageRecord(`${keep(2)}|${variant}`, day, 2, sessionUuid, variant === "v2" ? "gpt-5.5" : "gpt-5.6-sol"));
  return {
    usage,
    quota: [quotaRecord(`${owner}|${day}|${variant}`, day, variant === "v2" ? 42 : 21)],
    session: [sessionRecord(sessionUuid, day, variant === "v2" ? { localShell: 4, web: 2 } : { localShell: 3, web: 1 })],
  };
}

/**
 * Build and seal the D1 USAGE_MONITOR_DB fixture. Returns the sealed path, its
 * digest, the expected per-owner/stream/day occurrence sets of the current
 * head, the union sets over every generation, and the fixture row counts.
 */
async function buildFixture(directory) {
  const path = join(directory, "usage-monitor-db.sqlite");
  const database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode=DELETE");
  database.exec("PRAGMA foreign_keys=ON");
  for (const sql of await d1Migrations()) {
    database.exec("BEGIN");
    database.exec(sql);
    database.exec("COMMIT");
  }
  for (const { name } of database.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()) {
    database.exec(`DROP TRIGGER "${name}"`);
  }
  const insert = (tableName, row) => {
    const columns = Object.keys(row);
    database.prepare(`INSERT INTO "${tableName}" (${columns.map((name) => `"${name}"`).join(",")})
      VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map((name) => row[name]));
  };
  const at = (day, time = "10:00:00.000") => `${day}T${time}Z`;
  const days = Array.from({ length: DAY_COUNT }, (_, index) => addDays(FIRST_DAY, index));
  const consent = telemetryV12RequiredConsent();

  database.exec("BEGIN");
  database.prepare(`UPDATE telemetry_v12_runtime SET state='active', policy_revision=2, changed_at=? WHERE id=1`)
    .run(at(addDays(FIRST_DAY, -1)));

  // Owner A: social, accepted v1.2 capability.
  const ownerA = { participantId: `participant:${randomUUID()}`, deviceId: randomUUID(), kind: "social" };
  const sessionId = randomUUID();
  const pairingId = randomUUID();
  const issued = at(addDays(FIRST_DAY, -2));
  insert("participants", { id: ownerA.participantId, owner_kind: "social", state: "active", created_at: issued });
  insert("web_sessions", { id: sessionId, participant_id: ownerA.participantId, secret_hash: randomBytes(32),
    csrf_hash: randomBytes(32), scope: "personal", state: "active", issued_at: issued,
    expires_at: at(addDays(FIRST_DAY, -1)), last_used_at: issued });
  insert("device_pairings", { id: pairingId, participant_id: ownerA.participantId, issued_by_session_id: sessionId,
    secret_hash: randomBytes(32), consent_version: "ongoing-privacy-safe-telemetry-v1.0", state: "consumed",
    issued_at: issued, expires_at: at(addDays(FIRST_DAY, -1)), consumed_at: issued,
    claimed_device_id: ownerA.deviceId, transport_consent_version: "ongoing-privacy-safe-telemetry-v1.0" });
  insert("device_credentials", { id: ownerA.deviceId, participant_id: ownerA.participantId, authority_kind: "social",
    paired_via_pairing_id: pairingId, secret_hash: randomBytes(32), state: "active", issued_at: issued,
    expires_at: "2027-03-01T00:00:00.000Z", last_used_at: at(days.at(-1)), social_verified_at: issued,
    credential_generation: 1 });
  insert("storage_v11_owner_links", { participant_id: ownerA.participantId, owner_digest: hex64(`link|${ownerA.participantId}`), state: "active" });
  insert("telemetry_v12_device_capabilities", { participant_id: ownerA.participantId, device_id: ownerA.deviceId,
    telemetry_schema_version: consent.telemetrySchemaVersion, field_dictionary_version: consent.fieldDictionaryVersion,
    privacy_contract_version: consent.privacyContractVersion, state: "accepted", consented_at: issued });

  // Owner B: accountless, its v1.2 grant has expired and is retained.
  const ownerB = { participantId: `participant:${randomUUID()}`, deviceId: randomUUID(), kind: "accountless" };
  insert("participants", { id: ownerB.participantId, owner_kind: "accountless", state: "active", created_at: ACCOUNTLESS_ISSUED_AT });
  insert("accountless_enrollment_ledger", { device_id: ownerB.deviceId, device_secret_hash: randomBytes(32),
    installation_principal_id: `accountless:${randomUUID()}`, schema_version: "accountless-enrollment-v0.1",
    policy_version: "accountless-opt-out-v1", authorization_basis: "accountless-policy-v1", state: "active",
    issued_at: ACCOUNTLESS_ISSUED_AT, expires_at: ACCOUNTLESS_EXPIRES_AT, renewal_generation: 0 });
  insert("device_credentials", { id: ownerB.deviceId, participant_id: ownerB.participantId, authority_kind: "accountless",
    accountless_enrollment_device_id: ownerB.deviceId, secret_hash: randomBytes(32), state: "active", issued_at: ACCOUNTLESS_ISSUED_AT,
    expires_at: ACCOUNTLESS_EXPIRES_AT, last_used_at: ACCOUNTLESS_ISSUED_AT, credential_generation: 1 });
  insert("accountless_upload_owners", { enrollment_device_id: ownerB.deviceId, participant_id: ownerB.participantId,
    device_credential_id: ownerB.deviceId, policy_version: "accountless-opt-out-v1",
    authorization_basis: "accountless-policy-v1", authorized_at: ACCOUNTLESS_ISSUED_AT, expires_at: ACCOUNTLESS_EXPIRES_AT,
    state: "active" });
  insert("storage_v11_owner_links", { participant_id: ownerB.participantId, owner_digest: hex64(`link|${ownerB.participantId}`), state: "active" });
  insert("accountless_v12_device_authorizations", { enrollment_device_id: ownerB.deviceId,
    participant_id: ownerB.participantId, device_credential_id: ownerB.deviceId,
    schema_version: "accountless-upload-owner-v1.2", policy_version: "accountless-telemetry-v1.2-policy-v1",
    authorization_basis: "accountless-policy-v1.2", telemetry_schema_version: consent.telemetrySchemaVersion,
    field_dictionary_version: consent.fieldDictionaryVersion, privacy_contract_version: consent.privacyContractVersion,
    authorized_at: ACCOUNTLESS_ISSUED_AT, expires_at: ACCOUNTLESS_EXPIRES_AT, state: "active" });

  const dictionaryId = (value) => {
    database.prepare("INSERT INTO typed_telemetry_dictionary(value) VALUES (?) ON CONFLICT(value) DO NOTHING").run(value);
    return Number(database.prepare("SELECT id FROM typed_telemetry_dictionary WHERE value=?").get(value).id);
  };
  const attributionId = (value) => {
    const row = [value.accountBasis, Buffer.from(value.accountTrack), value.planBasis,
      dictionaryId(value.planType), Buffer.from(value.planEra)];
    // node:sqlite binds a zero-length buffer as NULL; D1 stores X''.
    database.prepare(`INSERT INTO telemetry_v12_attributions(account_basis,account_track,plan_basis,plan_type_id,plan_era)
      VALUES (?,COALESCE(?,X''),?,?,COALESCE(?,X'')) ON CONFLICT DO NOTHING`).run(...row);
    return Number(database.prepare(`SELECT id FROM telemetry_v12_attributions WHERE account_basis=?
      AND account_track=COALESCE(?,X'') AND plan_basis=? AND plan_type_id=? AND plan_era=COALESCE(?,X'')`).get(...row).id);
  };
  const digest = async (canonical) => createHash("sha256").update(canonical).digest();

  /** Write one manifest with its chunks and typed records; `complete` false leaves it staged and short. */
  const writeManifest = async (owner, day, records, { complete = true } = {}) => {
    const manifestId = randomUUID();
    const streams = complete ? STREAMS : ["usage"];
    const chunks = streams.map((stream) => ({
      id: `chunk:${randomUUID()}`, stream, chunkId: `${stream}:${day}:0`,
      records: records[stream], chunkDigest: sha256Hex(canonicalTelemetryV12Json(records[stream])),
    }));
    const manifest = {
      schemaVersion: "telemetry-day-manifest-v1.2", day, parserVersion: PARSER_VERSION, consent,
      chunks: chunks.map((chunk) => ({ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest,
        recordCount: chunk.records.length })),
      excluded: { quota: 0, session: 0, usage: 0 },
    };
    const manifestDigest = sha256Hex(canonicalTelemetryV12Json(manifest));
    insert("telemetry_v12_day_manifests", { id: manifestId, participant_id: owner.participantId,
      device_id: owner.deviceId, chunk_day: day, manifest_digest: manifestDigest, parser_version: PARSER_VERSION,
      manifest_json: canonicalTelemetryV12Json({ ...manifest, manifestDigest }), expected_chunk_count: chunks.length,
      state: "staged", created_at: at(day, "20:00:00.000") });
    for (const chunk of chunks) {
      const authorization = randomUUID();
      const envelopeDigest = hex64(`envelope|${chunk.id}`);
      insert("device_upload_authorizations", { id: authorization, participant_id: owner.participantId,
        issued_by_device_id: owner.deviceId, secret_hash: randomBytes(32), envelope_digest: envelopeDigest,
        body_bytes: 4_096, content_type: "application/json", state: "consumed", issued_at: at(day, "20:00:01.000"),
        expires_at: at(day, "20:05:01.000"), consumed_at: at(day, "20:00:02.000"), consumed_contribution_id: chunk.id });
      insert("telemetry_v12_chunks", { id: chunk.id, manifest_id: manifestId, participant_id: owner.participantId,
        device_id: owner.deviceId, stream: chunk.stream, chunk_day: day, chunk_seq: 0, chunk_id: chunk.chunkId,
        chunk_digest: chunk.chunkDigest, envelope_digest: envelopeDigest, parser_version: PARSER_VERSION,
        record_count: chunk.records.length, r2_key: `synthetic-t2-${hex64(`object|${chunk.id}`).slice(0, 40)}`,
        device_upload_authorization_id: authorization, created_at: at(day, "20:00:02.000") });
      const written = complete ? chunk.records : chunk.records.slice(0, 1);
      for (const [index, record] of written.entries()) {
        const fields = await codec.encodeTelemetryV12Record(chunk.stream, record, digest);
        const result = database.prepare(`INSERT INTO telemetry_v12_records(chunk_id,manifest_id,stream,record_index,
            occurrence_id,observed_at_ms,observed_day,provider_id,canonical_digest) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(chunk.id, manifestId, chunk.stream, index, Buffer.from(fields.occurrenceId), fields.observedAtMs,
            fields.observedDay, dictionaryId(fields.provider), Buffer.from(fields.canonicalDigest));
        const recordId = Number(result.lastInsertRowid);
        if (fields.usage) {
          const usage = fields.usage;
          insert("telemetry_v12_usage", { record_id: recordId, session_id: Buffer.from(usage.sessionId),
            model_id: dictionaryId(usage.model), speed_mode_id: dictionaryId(usage.speedMode),
            api_service_tier_id: dictionaryId(usage.apiServiceTier), surface_id: dictionaryId(usage.surface),
            billing_surface_id: dictionaryId(usage.billingSurface),
            reasoning_effort_id: dictionaryId(usage.reasoningEffort), agent_scope_id: dictionaryId(usage.agentScope),
            outcome_id: dictionaryId(usage.outcome), attribution_id: attributionId(usage.attribution),
            total_input_context_tokens: usage.totalInputContextTokens, input_uncached_tokens: usage.inputUncachedTokens,
            input_cache_read_tokens: usage.inputCacheReadTokens, input_cache_write_tokens: usage.inputCacheWriteTokens,
            output_text_tokens: usage.outputTextTokens, output_reasoning_tokens: usage.outputReasoningTokens,
            output_combined_tokens: usage.outputCombinedTokens, boundary_flags: usage.boundaryFlags,
            tie_order: usage.tieOrder, cache_write_ttl_five_minute_tokens: usage.cacheWriteTtlFiveMinuteTokens,
            cache_write_ttl_one_hour_tokens: usage.cacheWriteTtlOneHourTokens });
        } else if (fields.quota) {
          const quota = fields.quota;
          insert("telemetry_v12_quota", { record_id: recordId, plan_type_id: dictionaryId(quota.planType),
            plan_variant_id: dictionaryId(quota.planVariant), limit_id: dictionaryId(quota.limitId),
            slot_id: dictionaryId(quota.slot), used_percent: quota.usedPercent,
            window_duration_minutes: quota.windowDurationMinutes, resets_at_ms: quota.resetsAtMs,
            attribution_id: attributionId(quota.attribution) });
        } else {
          for (const [tool, count] of Object.entries(fields.tools).sort(([left], [right]) => left < right ? -1 : 1)) {
            insert("telemetry_v12_session_tools", { record_id: recordId, tool_class_id: dictionaryId(tool), count });
          }
        }
      }
    }
    if (complete) {
      database.prepare("UPDATE telemetry_v12_day_manifests SET state='ready', ready_at=? WHERE id=?")
        .run(at(day, "20:00:03.000"), manifestId);
    }
    return { id: manifestId, digest: manifestDigest, day, records };
  };

  /** Generation rows in production's order: consumed predecessor token, domain, its days. */
  const writeGeneration = (owner, manifests, previous, createdAt, inputRevision) => {
    const id = randomUUID();
    const sortedDays = manifests.map((manifest) => manifest.day).sort();
    const daysJson = JSON.stringify(manifests.map((manifest) => ({
      day: manifest.day, manifestDigest: manifest.digest, manifestId: manifest.id })));
    const tokenHash = hex64(`token|${id}`);
    const fingerprint = hex64(`legacy|${owner.participantId}`);
    insert("telemetry_v12_domain_predecessors", { token_hash: tokenHash, participant_id: owner.participantId,
      device_id: owner.deviceId, previous_generation_id: previous?.id ?? null, legacy_fingerprint: fingerprint,
      input_revision: inputRevision, from_day: sortedDays[0], through_day: sortedDays.at(-1), days_json: daysJson,
      created_at: createdAt, expires_at: new Date(Date.parse(createdAt) + 86_400_000).toISOString(),
      consumed_at: createdAt });
    insert("telemetry_v12_domains", { id, participant_id: owner.participantId, device_id: owner.deviceId,
      predecessor_token_hash: tokenHash, previous_generation_id: previous?.id ?? null,
      manifest_digest: hex64(`domain|${id}`), legacy_fingerprint: fingerprint, input_revision: inputRevision,
      from_day: sortedDays[0], through_day: sortedDays.at(-1), days_json: daysJson, created_at: createdAt });
    for (const manifest of manifests) {
      insert("telemetry_v12_domain_days", { generation_id: id, observed_day: manifest.day,
        manifest_id: manifest.id, manifest_digest: manifest.digest });
    }
    return { id, owner, manifests };
  };

  const first = [];
  for (const day of days.slice(0, 6)) first.push(await writeManifest(ownerA, day, dayRecords("a", day, "v1")));
  const generationA1 = writeGeneration(ownerA, first, null, at(days[5], "21:00:00.000"), 0);
  const second = [...first.slice(0, 4)];
  for (const day of days.slice(4)) second.push(await writeManifest(ownerA, day, dayRecords("a", day, "v2")));
  const generationA2 = writeGeneration(ownerA, second, generationA1, at(days[9], "21:00:00.000"), 1);
  await writeManifest(ownerA, days[9], dayRecords("a", days[9], "abandoned"), { complete: false });
  insert("telemetry_v12_domain_heads", { participant_id: ownerA.participantId, generation_id: generationA2.id,
    revision: 2, updated_at: at(days[9], "21:00:01.000") });

  const third = [];
  for (const day of days.slice(4, 8)) third.push(await writeManifest(ownerB, day, dayRecords("b", day, "v1")));
  const generationB1 = writeGeneration(ownerB, third, null, at(days[7], "21:00:00.000"), 0);
  insert("telemetry_v12_domain_heads", { participant_id: ownerB.participantId, generation_id: generationB1.id,
    revision: 1, updated_at: at(days[7], "21:00:01.000") });
  database.exec("COMMIT");

  const counts = Object.fromEntries(D1_V12_TABLES.map((name) =>
    [name, Number(database.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n)]));
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  database.close();

  const occurrence = (stream, record) => stream === "usage" ? record.eventId
    : stream === "quota" ? record.observationId : record.sessionUuid;
  const sets = (generations) => {
    const result = new Map();
    for (const generation of generations) {
      for (const manifest of generation.manifests) {
        for (const stream of STREAMS) {
          const key = `${generation.owner.participantId}|${stream}|${manifest.day}`;
          if (!result.has(key)) result.set(key, new Set());
          for (const record of manifest.records[stream]) result.get(key).add(occurrence(stream, record));
        }
      }
    }
    return result;
  };
  return {
    path,
    sha256: await sealFile(path),
    owners: [ownerA, ownerB],
    days,
    counts,
    headSets: sets([generationA2, generationB1]),
    unionSets: sets([generationA1, generationA2, generationB1]),
  };
}

/** T-1 stand-in: copy identity rows into the target by column intersection, in FK order. */
async function copyIdentity(sqlitePath, targetSchema) {
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  const copied = {};
  try {
    for (const tableName of IDENTITY_TABLES) {
      const targetColumns = new Set((await pool.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema=$1 AND table_name=$2`, [targetSchema, tableName])).rows.map((row) => row.column_name));
      const sourceColumns = database.prepare(`PRAGMA table_info("${tableName}")`).all().map((row) => row.name);
      const columns = sourceColumns.filter((name) => targetColumns.has(name));
      const rows = database.prepare(`SELECT ${columns.map((name) => `"${name}"`).join(",")} FROM "${tableName}"`).all();
      for (const row of rows) {
        await pool.query(`INSERT INTO "${targetSchema}"."${tableName}" (${columns.map((name) => `"${name}"`).join(",")})
          VALUES (${columns.map((_, index) => `$${index + 1}`).join(",")})`,
        columns.map((name) => row[name] instanceof Uint8Array ? Buffer.from(row[name]) : row[name]));
      }
      copied[tableName] = rows.length;
    }
  } finally {
    database.close();
  }
  return copied;
}

async function expectTransferError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof PostgresV12TransferError, `expected ${code}, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code, JSON.stringify(error.detail ?? {}));
    return true;
  });
}

async function v12RowTotal(targetSchema) {
  const targets = [...new Set(POSTGRES_V12_TRANSFER_LAYOUT.filter((entry) => entry.scope === "all-rows"
    && !entry.name.startsWith("telemetry_v12_runtime")).map((entry) => entry.target))];
  let total = 0;
  for (const name of targets) {
    total += Number((await pool.query(`SELECT count(*)::integer AS n FROM "${targetSchema}"."${name}"`)).rows[0].n);
  }
  return total;
}

/** The reader's per-stream/day occurrence-id sets for one participant, read independently of the importer. */
async function readerSets(targetSchema, participantId, firstDay, lastDay) {
  const options = { schema: { primarySchema: targetSchema } };
  const result = new Map();
  for (const stream of STREAMS) {
    for (let from = firstDay; from <= lastDay; from = addDays(from, 101)) {
      const through = addDays(from, 100) < lastDay ? addDays(from, 100) : lastDay;
      const days = await reader.readPostgresTelemetryV12EffectiveDays(pool,
        { participantId, fromDay: from, throughDay: through, stream }, options);
      for (const day of days) {
        const candidates = [];
        let next;
        for (;;) {
          const page = await reader.readPostgresTelemetryV12EffectiveCandidatePage(pool,
            { participantId, day, stream, limit: 200, ...(next ? { after: next } : {}) }, options);
          assert.equal(page.available, true);
          candidates.push(...page.records.map((record) => record.occurrenceId));
          if (page.next === null) break;
          next = page.next;
        }
        const ids = new Set();
        for (let offset = 0; offset < candidates.length; offset += 200) {
          const read = await reader.readPostgresTelemetryV12EffectiveOccurrences(pool,
            { participantId, stream, occurrenceIds: candidates.slice(offset, offset + 200) }, options);
          assert.equal(read.available, true);
          for (const record of read.records) {
            assert.equal(record.observedAt.slice(0, 10), day);
            ids.add(record.occurrenceId);
          }
        }
        assert.deepEqual([...ids].sort(), [...new Set(candidates)].sort());
        result.set(`${participantId}|${stream}|${day}`, ids);
      }
    }
  }
  return result;
}

function setsAsSortedObject(map) {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left < right ? -1 : 1)
    .map(([key, value]) => [key, [...value].sort()]));
}

before(async () => {
  if (SKIP) return;
  pool = await createPool();
  vite = await createServer({
    root: WORKER_ROOT, configFile: false, logLevel: "silent", appType: "custom",
    server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true },
  });
  codec = await vite.ssrLoadModule("/src/telemetry-v12-typed-codec.ts");
  reader = await loadPostgresV12EffectiveReader({ workerRoot: WORKER_ROOT });
});

after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
  await reader?.close().catch(() => {});
  await vite?.close().catch(() => {});
  await pool?.end().catch(() => {});
});

test("owns exactly the fourteen d43c8f92 v1.2 D1 tables", { skip: SKIP }, () => {
  assert.deepEqual([...POSTGRES_V12_TRANSFER_SOURCE_TABLES].sort(), [...D1_V12_TABLES].sort());
  const allowlisted = POSTGRES_V12_TRANSFER_LAYOUT.flatMap((entry) => entry.columns.map((column) => column.name));
  // Privacy: no plaintext secret, token or credential column is imported. The
  // consumed upload-authorization row carries only its one-way secret hash.
  for (const name of allowlisted) {
    assert.doesNotMatch(name, /(^|_)(password|cookie|email|prompt|command|path|cwd|filename|transcript|message)(_|$)/u, name);
    if (/(^|_)(secret|token)(_|$)/u.test(name)) assert.match(name, /_hash$/u, name);
  }
});

test("imports a sealed fixture with exact counts, canonical digests and effective-reader sets", { skip: SKIP }, async () => {
  const directory = await scratchDirectory();
  const fixture = await buildFixture(directory);
  assert.equal(fixture.counts.telemetry_v12_domains, 3);
  assert.equal(fixture.counts.telemetry_v12_domain_heads, 2);
  assert.equal(new Set([...fixture.headSets.keys()].map((key) => key.split("|").at(-1))).size, DAY_COUNT);

  const { targetSchema, controlSchema } = await createTarget();
  const identity = await copyIdentity(fixture.path, targetSchema);
  assert.equal(identity.participants, 2);
  // The typed-legacy importer runs before T-2 and fills the shared dictionary;
  // pre-seed part of it so both the verify-existing and insert-missing paths run.
  const sourceDictionary = new DatabaseSync(fixture.path, { readOnly: true });
  const dictionaryRows = sourceDictionary.prepare("SELECT id, value FROM typed_telemetry_dictionary ORDER BY id").all();
  sourceDictionary.close();
  for (const row of dictionaryRows.slice(0, Math.ceil(dictionaryRows.length / 2))) {
    await pool.query(`INSERT INTO "${targetSchema}".typed_telemetry_dictionary(id, value) VALUES ($1,$2)`,
      [Number(row.id), row.value]);
  }

  const source = await createSealedSqliteV12RehearsalSource({ path: fixture.path, expectedSha256: fixture.sha256 });
  cleanups.push(async () => source.close());
  const transferId = `t2-fixture-${randomBytes(4).toString("hex")}`;
  const result = await runPostgresV12Transfer({
    source, destinationPool: pool, targetSchema, controlSchema, transferId, pageSize: 7, effectiveReader: reader,
  });
  assert.equal(result.status, "staged_rehearsal_complete");
  assert.equal(result.destination.manifestSha256, result.source.manifestSha256);
  assert.deepEqual(result.families.map((family) => [family.family, family.action]),
    [["authority", "imported"], ["source", "imported"], ["domain", "imported"]]);

  // Row counts and per-table canonical SHA-256 equal the source, table by table.
  for (const entry of POSTGRES_V12_TRANSFER_LAYOUT) {
    const sourceTable = result.source.tables[entry.name];
    const targetTable = result.destination.tables[entry.name];
    assert.equal(targetTable.rows, sourceTable.rows, entry.name);
    assert.equal(targetTable.sha256, sourceTable.sha256, entry.name);
    assert.match(targetTable.sha256, /^[0-9a-f]{64}$/u);
  }
  // Independent count check straight from the SQLite file and PostgreSQL.
  for (const name of D1_V12_TABLES) {
    const target = TARGET_OF[name] ?? name;
    const actual = Number((await pool.query(`SELECT count(*)::integer AS n FROM "${targetSchema}"."${target}"`)).rows[0].n);
    assert.equal(actual, fixture.counts[name], name);
    if (name !== "telemetry_v12_runtime") assert.equal(result.source.tables[name].rows, fixture.counts[name], name);
  }
  // States, revisions and digests are preserved exactly.
  const preserved = await pool.query(`SELECT
      (SELECT count(*)::integer FROM "${targetSchema}".telemetry_v12_day_manifests WHERE state='ready') AS ready,
      (SELECT count(*)::integer FROM "${targetSchema}".telemetry_v12_day_manifests WHERE state='staged') AS staged,
      (SELECT string_agg(revision::text, ',' ORDER BY revision) FROM "${targetSchema}".telemetry_v12_domain_heads) AS revisions,
      (SELECT state || ':' || policy_revision FROM "${targetSchema}".telemetry_v12_typed_runtime) AS typed_runtime,
      (SELECT state || ':' || revision FROM "${targetSchema}".telemetry_v12_runtime) AS transport_runtime,
      (SELECT count(*)::integer FROM "${targetSchema}".pending_objects) AS pending,
      (SELECT count(*)::integer FROM "${targetSchema}".telemetry_v12_records) AS raw_records`);
  assert.deepEqual(preserved.rows[0], {
    ready: 16, staged: 1, revisions: "1,2", typed_runtime: "active:2", transport_runtime: "active:1",
    pending: 0, raw_records: 0,
  });
  const triggers = await pool.query(`SELECT count(*)::integer AS disabled FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=$1 AND NOT t.tgisinternal AND t.tgenabled <> 'O'`, [targetSchema]);
  assert.equal(triggers.rows[0].disabled, 0, "every trigger is enabled again after the import");

  // The effective reader's per-day occurrence-id sets equal the fixture's
  // current-head sets, read independently of the importer's own check.
  assert.equal(result.effective.verified, true);
  assert.equal(result.effective.participants, 2);
  const read = new Map();
  for (const owner of fixture.owners) {
    for (const [key, value] of await readerSets(targetSchema, owner.participantId, fixture.days[0], fixture.days.at(-1))) {
      read.set(key, value);
    }
  }
  assert.deepEqual(setsAsSortedObject(read), setsAsSortedObject(fixture.headSets));
  assert.equal(result.effective.dayStreams, fixture.headSets.size);
  assert.equal(result.effective.occurrenceIds, [...fixture.headSets.values()].reduce((sum, set) => sum + set.size, 0));
  // The superseded generation changed two days; d43c8f92's D1 reader reads
  // every generation, so those day-streams differ from the head-only reader.
  const divergent = [...fixture.unionSets.entries()].filter(([key, value]) => {
    const head = fixture.headSets.get(key) ?? new Set();
    return value.size !== head.size || [...value].some((id) => !head.has(id));
  }).length;
  assert.equal(divergent, 2 * STREAMS.length);
  assert.equal(result.effective.unionDivergentDayStreams, divergent);

  // A rerun with the same transfer id and source verifies and writes nothing.
  const again = await runPostgresV12Transfer({
    source, destinationPool: pool, targetSchema, controlSchema, transferId, pageSize: 50, effectiveReader: reader,
  });
  assert.equal(again.run, "complete");
  assert.deepEqual(again.families.map((family) => family.action),
    ["verified-existing", "verified-existing", "verified-existing"]);
  assert.equal(again.destination.manifestSha256, result.destination.manifestSha256);
  assert.equal(again.effective.sha256, result.effective.sha256);

  // Result evidence names no participant, device or occurrence.
  const serialized = JSON.stringify(result);
  for (const owner of fixture.owners) {
    assert.equal(serialized.includes(owner.participantId), false);
    assert.equal(serialized.includes(owner.deviceId), false);
  }
  assert.equal(serialized.includes("event:v2:"), false);
});

test("refuses a non-prefixed target before any write", { skip: SKIP }, async () => {
  const directory = await scratchDirectory();
  const fixture = await buildFixture(directory);
  const source = await createSealedSqliteV12RehearsalSource({ path: fixture.path, expectedSha256: fixture.sha256 });
  cleanups.push(async () => source.close());
  const { controlSchema } = await createTarget();
  for (const targetSchema of ["public", `t2_unprefixed_${randomBytes(4).toString("hex")}`,
    `${POSTGRES_V12_TRANSFER_TARGET_SCHEMA_PREFIX}short`, POSTGRES_V12_TRANSFER_CONTROL_SCHEMA_PREFIX + "abcdefgh"]) {
    await expectTransferError(runPostgresV12Transfer({
      source, destinationPool: pool, targetSchema, controlSchema, transferId: "t2-refusal",
    }), "V12_TRANSFER_TARGET_SCHEMA_REQUIRED");
  }
});

test("refuses a non-empty target before any write", { skip: SKIP }, async () => {
  const directory = await scratchDirectory();
  const fixture = await buildFixture(directory);
  const source = await createSealedSqliteV12RehearsalSource({ path: fixture.path, expectedSha256: fixture.sha256 });
  cleanups.push(async () => source.close());
  const { targetSchema, controlSchema } = await createTarget();
  await copyIdentity(fixture.path, targetSchema);
  const [owner] = fixture.owners;
  await pool.query(`INSERT INTO "${targetSchema}".telemetry_v12_domain_predecessors(token_hash, participant_id,
      device_id, legacy_fingerprint, input_revision, from_day, through_day, days_json, created_at, expires_at)
    VALUES ($1,$2,$3,$4,0,$5,$5,'[]',$6,$7)`,
  [hex64("foreign-token"), owner.participantId, owner.deviceId, hex64("foreign-fingerprint"), FIRST_DAY,
    `${FIRST_DAY}T00:00:00.000Z`, `${FIRST_DAY}T01:00:00.000Z`]);
  await expectTransferError(runPostgresV12Transfer({
    source, destinationPool: pool, targetSchema, controlSchema, transferId: "t2-non-empty",
  }), "V12_TRANSFER_TARGET_NOT_EMPTY");
  assert.equal(await v12RowTotal(targetSchema), 1, "the refusal wrote nothing beyond the foreign row");

  // A target that already holds a different v1.2 source is also refused.
  const other = await buildFixture(await scratchDirectory());
  const { targetSchema: importedSchema, controlSchema: importedControl } = await createTarget();
  await copyIdentity(other.path, importedSchema);
  const otherSource = await createSealedSqliteV12RehearsalSource({ path: other.path, expectedSha256: other.sha256 });
  cleanups.push(async () => otherSource.close());
  await runPostgresV12Transfer({ source: otherSource, destinationPool: pool, targetSchema: importedSchema,
    controlSchema: importedControl, transferId: "t2-other" });
  await copyIdentity(fixture.path, importedSchema);
  await expectTransferError(runPostgresV12Transfer({
    source, destinationPool: pool, targetSchema: importedSchema, controlSchema: importedControl,
    transferId: "t2-second-source",
  }), "V12_TRANSFER_TARGET_NOT_EMPTY");
});

test("refuses a source missing any expected table, and an unsealed source", { skip: SKIP }, async () => {
  const directory = await scratchDirectory();
  const fixture = await buildFixture(directory);
  for (const missing of D1_V12_TABLES) {
    const path = join(directory, `missing-${missing}.sqlite`);
    await copyFile(fixture.path, path);
    await chmod(path, 0o644);
    const database = new DatabaseSync(path);
    database.exec("PRAGMA foreign_keys=OFF");
    database.exec(`DROP TABLE "${missing}"`);
    database.close();
    const sha256 = await sealFile(path);
    await expectTransferError(createSealedSqliteV12RehearsalSource({ path, expectedSha256: sha256 }),
      "V12_TRANSFER_SOURCE_TABLE_MISSING");
  }
  const writable = join(directory, "writable.sqlite");
  await copyFile(fixture.path, writable);
  await chmod(writable, 0o644);
  await expectTransferError(createSealedSqliteV12RehearsalSource({
    path: writable, expectedSha256: sha256Hex(await readFile(writable)),
  }), "V12_TRANSFER_SEALED_SQLITE_UNSAFE");
  await expectTransferError(createSealedSqliteV12RehearsalSource({
    path: fixture.path, expectedSha256: "0".repeat(64),
  }), "V12_TRANSFER_SEALED_SQLITE_SHA256_MISMATCH");
});

// ---------------------------------------------------------------------------
// Q-1 dump (opt-in)

function decodeDumpCell(cell) {
  if (cell === null || typeof cell === "string" || typeof cell === "number") return cell;
  if (cell && typeof cell === "object" && typeof cell.$blob === "string") return Buffer.from(cell.$blob, "hex");
  if (cell && typeof cell === "object" && typeof cell.$real === "number") return cell.$real;
  throw new Error("Q1_DUMP_CELL_INVALID");
}

/** Rebuild Q-1's USAGE_MONITOR_DB JSON dump: tables, rows, then indexes, views and triggers. */
async function rebuildQ1Dump(dumpPath, directory) {
  const dump = JSON.parse(await readFile(dumpPath, "utf8"));
  const path = join(directory, "q1-usage-monitor-db.sqlite");
  const database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode=DELETE");
  // Rows load in dump order before any trigger exists, as Q-1's own rebuild does.
  database.exec("PRAGMA foreign_keys=OFF");
  database.exec("BEGIN");
  for (const entry of dump.schema.filter((item) => item.type === "table")) database.exec(entry.sql);
  for (const table of dump.tables) {
    const columns = table.columns.map((name) => `"${name}"`).join(",");
    const statement = database.prepare(`INSERT INTO "${table.name}" (${columns})
      VALUES (${table.columns.map(() => "?").join(",")})`);
    for (const row of table.rows) statement.run(...row.map(decodeDumpCell));
  }
  for (const kind of ["index", "view", "trigger"]) {
    for (const entry of dump.schema.filter((item) => item.type === kind)) database.exec(entry.sql);
  }
  database.exec("COMMIT");
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  database.close();
  return { path, sha256: await sealFile(path) };
}

test("imports Q-1's d43c8f92 dump and reads every v1.2 owner day", {
  skip: SKIP ? true : !Q1_DUMP ? "POSTGRES_V12_TRANSFER_Q1_DUMP is not set" : false,
}, async () => {
  const directory = await scratchDirectory();
  const sealed = await rebuildQ1Dump(Q1_DUMP, directory);
  const { targetSchema, controlSchema } = await createTarget();
  await copyIdentity(sealed.path, targetSchema);
  const source = await createSealedSqliteV12RehearsalSource({ path: sealed.path, expectedSha256: sealed.sha256 });
  cleanups.push(async () => source.close());
  const result = await runPostgresV12Transfer({
    source, destinationPool: pool, targetSchema, controlSchema, transferId: "t2-q1-dump", effectiveReader: reader,
  });
  assert.equal(result.status, "staged_rehearsal_complete");
  assert.equal(result.destination.manifestSha256, result.source.manifestSha256);
  const database = new DatabaseSync(sealed.path, { readOnly: true });
  const owners = database.prepare(`SELECT head.participant_id AS id,
      (SELECT min(chunk_day) FROM telemetry_v12_day_manifests m WHERE m.participant_id=head.participant_id) AS first,
      (SELECT max(chunk_day) FROM telemetry_v12_day_manifests m WHERE m.participant_id=head.participant_id) AS last,
      (SELECT count(DISTINCT domain_day.observed_day) FROM telemetry_v12_domain_days domain_day
         JOIN telemetry_v12_day_manifests m ON m.id=domain_day.manifest_id AND m.state='ready'
        WHERE domain_day.generation_id=head.generation_id) AS head_days
    FROM telemetry_v12_domain_heads head ORDER BY head.participant_id`).all();
  database.close();
  assert.ok(owners.length >= 1, "the Q-1 dump holds at least one v1.2 owner");
  const summary = [];
  for (const owner of owners) {
    const sets = await readerSets(targetSchema, owner.id, owner.first, owner.last);
    const readableDays = new Set([...sets.keys()].map((key) => key.split("|").at(-1)));
    assert.ok(readableDays.size <= Number(owner.head_days));
    summary.push({ readableDays: readableDays.size, headDays: Number(owner.head_days) });
  }
  if (Q1_EXPECTED_DAYS !== undefined) {
    assert.ok(summary.some((entry) => entry.readableDays === Number(Q1_EXPECTED_DAYS)),
      `a v1.2 owner has ${Q1_EXPECTED_DAYS} readable days: ${JSON.stringify(summary)}`);
  }
  process.stdout.write(`# q1 v1.2 owners ${JSON.stringify(summary)} effective ${JSON.stringify({
    dayStreams: result.effective.dayStreams, occurrenceIds: result.effective.occurrenceIds,
    unionDivergentDayStreams: result.effective.unionDivergentDayStreams })}\n`);
});
