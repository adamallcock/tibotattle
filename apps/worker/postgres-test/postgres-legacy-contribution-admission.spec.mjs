import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import {
  createContributionEnvelopeRegistry,
  createUploadAuthorizationFormats,
} from "../cloud-run/contribution-envelope-registry.mjs";
import {
  DEFAULT_UPLOAD_AUTHORIZATION_SCHEMA_VERSION,
  LEGACY_V1_UPLOAD_AUTHORIZATION_SCHEMA_VERSIONS,
  RETAINED_V0_UPLOAD_AUTHORIZATION_SCHEMA_VERSIONS,
  legacyUploadAuthorizationFormatEntries,
  parseUploadAuthorizationRequest,
  resolveUploadAuthorizationFormat,
} from "../cloud-run/upload-authorization-formats.mjs";
import {
  TELEMETRY_V10_ENVELOPE_SCHEMA_VERSION,
  createTelemetryV10ContributionEnvelope,
} from "../cloud-run/envelopes/v10.mjs";

/*
 * IN-3: the telemetry-envelope-v1.0 contribution envelope and the legacy
 * upload-authorization formats on PostgreSQL 17, against a production-code
 * oracle.
 *
 * The oracle is the d43c8f92 Worker's own typed v1 admission
 * (src/typed-v1-admission.ts insertTypedTelemetryV1Chunk with
 * telemetry-v1-repository.ts) and transport policy, running unmodified on an
 * in-memory node:sqlite database built from the D1 migration directories the
 * live ingestion D1 applies. ORACLE_SOURCES pins every oracle file to its
 * d43c8f92 git blob, so a drift in the GCP line fails here instead of
 * silently changing the oracle.
 *
 * Every upload runs through the envelope registry: a spec-local stand-in for
 * the IN-1b contributions preamble claims the one-use authorization, enforces
 * the transport floor, dispatches on body.schemaVersion, then records the
 * receipt (or abandons the claim). The PostgreSQL rows are then compared,
 * normalized to original identifiers, with the rows the Worker's typed v1
 * admission writes for the same chunk, ids and clock on D1.
 * All data is synthetic and content-free.
 */

const PG_TEST_HOST = process.env.PG_TEST_HOST;
const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const PG_TEST_USER = process.env.PG_TEST_USER || "postgres";
const PG_TEST_PASSWORD = process.env.PG_TEST_PASSWORD || "synthetic-local-only";
const PG_TEST_DATABASE = process.env.PG_TEST_DATABASE || "postgres";
const SKIP = !PG_TEST_HOST && !PG_TEST_SOCKET;
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const D1_DIRECTORIES = Object.freeze([
  "migrations", "typed-ingestion-migrations", "ingestion-bridge-migrations",
  "typed-v11-admission-migrations", "typed-v1-admission-migrations",
  "ingestion-isolation-migrations",
]);
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const PARTICIPANT_CONSENT = "privacy-safe-telemetry-v0.1";
const PAIRING_CONSENT = "ongoing-privacy-safe-telemetry-v1.0";
const NAMESPACE = "synthetic-in3-v1-namespace";
const SOURCE_ID = "synthetic-in3-journal";
const KEY_ID = "key:synthetic-in3";
const DAY_MS = 24 * 60 * 60 * 1000;
const V1_CONSENT = Object.freeze({
  telemetrySchemaVersion: "telemetry-contribution-v1.0",
  fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
  privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0",
});

/*
 * git blob ids at d43c8f92 (`git rev-parse d43c8f92:apps/worker/<path>`)
 * of every file whose behaviour the oracle reproduces. Equal blob ids mean
 * the oracle runs production's exact code and D1 schema for this path.
 */
const ORACLE_SOURCES = Object.freeze({
  "src/typed-v1-admission.ts": null,
  "src/telemetry-v1-repository.ts": null,
  "src/typed-telemetry-repository.ts": null,
  "src/telemetry-v1.ts": null,
  "src/telemetry-transport-policy.ts": null,
  "typed-v1-admission-migrations/0001_typed_v1_chunk_admission.sql": null,
  "ingestion-isolation-migrations/0003_v1_append_classification.sql": null,
  "ingestion-isolation-migrations/0004_v1_multidevice_source_update.sql": null,
  "typed-ingestion-migrations/0001_typed_telemetry.sql": null,
  "typed-ingestion-migrations/0002_delivery_journal.sql": null,
});

let vite;
const modules = new Map();
async function workerModule(path) {
  vite ??= await createServer({
    root: WORKER_ROOT, configFile: false, server: { middlewareMode: true }, appType: "custom", logLevel: "silent",
  });
  if (!modules.has(path)) modules.set(path, await vite.ssrLoadModule(path));
  return modules.get(path);
}
after(async () => {
  if (vite) await vite.close();
});

function gitBlobId(content) {
  const body = Buffer.from(content);
  return createHash("sha1").update(`blob ${body.byteLength}\0`).update(body).digest("hex");
}

let d1Sources;
async function d1Oracle() {
  d1Sources ??= (async () => {
    const sources = [];
    for (const directory of D1_DIRECTORIES) {
      const names = (await readdir(join(WORKER_ROOT, directory)))
        .filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/u.test(name)).sort();
      for (const name of names) sources.push(await readFile(join(WORKER_ROOT, directory, name), "utf8"));
    }
    return sources;
  })();
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  for (const sql of await d1Sources) {
    database.exec("BEGIN");
    database.exec(sql);
    database.exec("COMMIT");
  }
  return database;
}

const toSqlite = (value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value);
const fromSqlite = (row) => {
  if (row === undefined) return row;
  const copy = { ...row };
  for (const [key, value] of Object.entries(copy)) {
    if (value instanceof Uint8Array) copy[key] = Uint8Array.from(value).buffer;
  }
  return copy;
};

/** The D1Database surface the Worker's admission uses, over node:sqlite. */
function d1Database(database) {
  const statement = (sql, values = []) => ({
    sql,
    values,
    bind: (...next) => statement(sql, next),
    async first(column) {
      const row = fromSqlite(database.prepare(sql).get(...values.map(toSqlite)));
      if (row === undefined) return null;
      return column === undefined ? row : row[column];
    },
    async all() {
      return { results: database.prepare(sql).all(...values.map(toSqlite)).map(fromSqlite), success: true, meta: {} };
    },
    async run() {
      const result = database.prepare(sql).run(...values.map(toSqlite));
      // D1 reports the database size; the oracle has unbounded headroom.
      return { success: true, meta: { changes: Number(result.changes), size_after: 0 } };
    },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = statements.map((entry) => ({
          success: true, meta: {},
          results: database.prepare(entry.sql).all(...entry.values.map(toSqlite)).map(fromSqlite),
        }));
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

async function endpoint() {
  assert.ok(!PG_TEST_HOST || ["localhost", "127.0.0.1", "::1"].includes(PG_TEST_HOST),
    "legacy admission tests require loopback or a private Unix socket");
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
    return { host, port: PG_TEST_PORT, socket: true };
  }
  return { host: PG_TEST_HOST, port: PG_TEST_PORT, socket: false };
}

async function withTwin(operation) {
  const local = await endpoint();
  const schema = `in3_legacy_${randomBytes(6).toString("hex")}`;
  const pool = new pg.Pool({
    host: local.host, port: local.port, user: PG_TEST_USER, password: PG_TEST_PASSWORD, database: PG_TEST_DATABASE,
    ssl: false, max: 6, connectionTimeoutMillis: 5_000, application_name: "pg-legacy-contribution-admission-test",
    options: `-c search_path=${schema},pg_catalog`,
  });
  let created = false;
  const d1 = await d1Oracle();
  try {
    const server = await pool.query(
      "SELECT current_setting('server_version_num')::integer AS version, host(inet_server_addr()) AS address",
    );
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "qualified on PostgreSQL 17");
    if (local.socket) assert.equal(server.rows[0].address, null);
    else assert.ok(["127.0.0.1", "::1"].includes(server.rows[0].address));
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await applyPostgresMigrations({ role: "primary", schema, pool });
    return await operation({ twin: new Twin(d1, pool), pool, schema, d1 });
  } finally {
    if (created) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
    d1.close();
  }
}

const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();
const bytes32 = () => randomBytes(32);
const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");
const toPostgres = (sql) => {
  let index = 0;
  return sql.replace(/\?/gu, () => `$${++index}`);
};
const hex = (value) => (value === null || value === undefined ? null : Buffer.from(
  value instanceof ArrayBuffer ? new Uint8Array(value) : value).toString("hex"));

class Twin {
  constructor(d1, pool) {
    this.d1 = d1;
    this.pool = pool;
  }

  async run(sql, values = []) {
    this.d1.prepare(sql).run(...values);
    await this.pool.query(toPostgres(sql), values);
  }

  d1Only(sql, values = []) {
    this.d1.prepare(sql).run(...values);
  }

  async pgOnly(sql, values = []) {
    return this.pool.query(toPostgres(sql), values);
  }
}

async function socialParticipant(twin, participantId, consentVersion = PARTICIPANT_CONSENT) {
  const now = iso();
  await twin.run(
    `INSERT INTO participants (id, owner_kind, access_token_id, access_token_hash, recovery_token_id,
       recovery_token_hash, state, consent_version, consented_at, created_at)
     VALUES (?, 'social', ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [participantId, `access-${participantId}`, bytes32(), `recovery-${participantId}`, bytes32(),
      consentVersion, now, now],
  );
  await twin.run(
    `INSERT INTO web_sessions (id, participant_id, secret_hash, csrf_hash, scope, state, issued_at, expires_at, last_used_at)
     VALUES (?, ?, ?, ?, 'personal', 'active', ?, ?, ?)`,
    [`session-${participantId}`, participantId, bytes32(), bytes32(), now, iso(DAY_MS), now],
  );
}

async function socialDevice(twin, participantId, deviceId, { consent = true } = {}) {
  const now = iso();
  const pairing = `pairing-${deviceId}`;
  await twin.run(
    `INSERT INTO device_pairings (id, participant_id, issued_by_session_id, secret_hash, consent_version,
       transport_consent_version, state, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'unused', ?, ?)`,
    [pairing, participantId, `session-${participantId}`, bytes32(), PAIRING_CONSENT, PAIRING_CONSENT, now, iso(DAY_MS)],
  );
  await twin.run(
    `INSERT INTO device_credentials (id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
       state, issued_at, expires_at, last_used_at, social_verified_at)
     VALUES (?, ?, 'social', ?, ?, 'active', ?, ?, ?, ?)`,
    [deviceId, participantId, pairing, bytes32(), now, iso(30 * DAY_MS), now, now],
  );
  await twin.run(
    "UPDATE device_pairings SET state = 'consumed', consumed_at = ?, claimed_device_id = ? WHERE id = ?",
    [now, deviceId, pairing],
  );
  if (consent) {
    await twin.run(
      `INSERT INTO telemetry_v1_device_consents (participant_id, device_id, telemetry_schema_version,
         field_dictionary_version, privacy_contract_version, consented_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [participantId, deviceId, V1_CONSENT.telemetrySchemaVersion, V1_CONSENT.fieldDictionaryVersion,
        V1_CONSENT.privacyContractVersion, now],
    );
  }
  return Object.freeze({
    deviceId, participantId, participantConsentVersion: PARTICIPANT_CONSENT, expiresAt: iso(30 * DAY_MS),
    credentialGeneration: 0, socialVerifiedAt: now, authorityKind: "social",
  });
}

/** The typed v1 target on both stores: journal source, namespace pin, contract 1. */
async function initializeTypedTargets(twin, schema) {
  const { initializeStorageSource } = await workerModule("/src/analytics-delivery.ts");
  const { initializeTypedV1Admission } = await workerModule("/src/typed-v1-admission.ts");
  const { encodeTypedTelemetryId } = await workerModule("/src/typed-telemetry-codec.ts");
  const d1 = d1Database(twin.d1);
  await initializeStorageSource(d1, SOURCE_ID);
  await initializeTypedV1Admission(d1, NAMESPACE);
  await twin.pgOnly("INSERT INTO storage_source_state (singleton, source_id, authority_epoch) VALUES (1, ?, 0)",
    [SOURCE_ID]);
  const namespace = await twin.pgOnly(
    "INSERT INTO typed_telemetry_namespaces (original_id) VALUES (?) RETURNING id",
    [Buffer.from(encodeTypedTelemetryId(NAMESPACE))]);
  await twin.pgOnly(
    `INSERT INTO typed_v1_admission_state (id, source_namespace, namespace_id, runtime_contract_version, next_source_row_id)
     VALUES (1, ?, ?, 1, 1)`, [NAMESPACE, namespace.rows[0].id]);
  return { schemaOptions: { primarySchema: schema, ledgerSchema: `${schema}_ledger` } };
}

let keyPair;
async function envelopeKeys() {
  keyPair ??= (async () => {
    const pair = await crypto.subtle.generateKey({
      name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
    }, true, ["encrypt", "decrypt"]);
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    return {
      publicJwk,
      publicText: JSON.stringify({ ...publicJwk, kid: KEY_ID }),
      privateText: JSON.stringify({ ...privateJwk, kid: KEY_ID }),
    };
  })();
  return keyPair;
}

async function encryptedEnvelope(plaintext) {
  const { encodeBase64Url } = await workerModule("/src/crypto.ts");
  const { canonicalJson } = await workerModule("/src/canonical-json.ts");
  const { publicJwk } = await envelopeKeys();
  const rsa = await crypto.subtle.importKey("jwk", publicJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    return {
      schemaVersion: TELEMETRY_V10_ENVELOPE_SCHEMA_VERSION, synthetic: false, keyId: KEY_ID,
      wrappedKey: encodeBase64Url(new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, raw))),
      iv: encodeBase64Url(iv),
      ciphertext: encodeBase64Url(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key,
        new TextEncoder().encode(canonicalJson(plaintext))))),
    };
  } finally {
    raw.fill(0);
  }
}

function day() {
  return new Date().toISOString().slice(0, 10);
}

function syntheticRecords(stream, count, seed) {
  return Array.from({ length: count }, (_, index) => {
    const occurrence = sha256Hex(`${seed}:${stream}:${index}`);
    if (stream === "usage") {
      return {
        schemaVersion: "usage-event-v1.0", eventId: `event:v2:${occurrence}`,
        eventTime: `${day()}T10:${String(index).padStart(2, "0")}:00.000Z`,
        sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b", provider: "openai_codex", modelId: "synthetic-model",
        speedMode: "standard", apiServiceTier: "default", surface: "cli", billingSurface: "subscription",
        reasoningEffort: "medium", agentScope: "main", outcome: "completed", totalInputContextTokens: 1200 + index,
        components: {
          inputUncachedTokens: 100 + index, inputCacheReadTokens: 1000, inputCacheWriteTokens: null,
          outputTextTokens: 40, outputReasoningTokens: 8, outputCombinedTokens: 48,
        },
      };
    }
    if (stream === "quota") {
      return {
        schemaVersion: "quota-observation-v1.0", observationId: `quota-occurrence:v1:${occurrence}`,
        observedTime: `${day()}T12:00:00.000Z`, provider: "openai_codex", planType: "pro", planVariant: "unknown",
        limitId: "codex", slot: "secondary", usedPercent: 0.30000000000000004, windowDurationMinutes: 10080,
        resetsAt: `${day()}T13:00:00.000Z`,
      };
    }
    return {
      schemaVersion: "session-dimension-v1.0", sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
      firstEventTime: `${day()}T12:00:00.000Z`, provider: "openai_codex", toolClassCounts: { shell: 0, other: 3 },
    };
  });
}

async function syntheticChunk({ stream = "usage", count = 1, revision = 1, seq = 0, seed = "base", digest } = {}) {
  const { canonicalJson } = await workerModule("/src/canonical-json.ts");
  const records = syntheticRecords(stream, count, seed);
  return {
    schemaVersion: "telemetry-contribution-v1.0", chunkId: `${stream}:${day()}:${seq}`, chunkRevision: revision,
    chunkDigest: digest ?? sha256Hex(canonicalJson(records)), parserVersion: "synthetic-in3-v1",
    consent: { ...V1_CONSENT }, records,
  };
}

function memoryObjectStore() {
  const objects = new Map();
  return {
    objects,
    async put(key, value, options) {
      objects.set(key, { value: String(value), options });
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

function outcomeOf(error) {
  return { status: error?.status, code: error?.code, details: error?.publicDetails ?? null };
}

/**
 * The origin wiring a later IN-1b/lead change composes: formats, the
 * registry with the v1.0 entry, and the context the preamble hands it.
 */
async function origin(pool, schemaOptions, objectStore) {
  const authority = await workerModule("/src/postgres-transport-write-authority.ts");
  const admission = await workerModule("/src/postgres-legacy-contribution-admission.ts");
  const transport = await workerModule("/src/postgres-typed-v12-transport.ts");
  const uploads = await workerModule("/src/postgres-upload-authorization.ts");
  const keys = await envelopeKeys();
  const formats = createUploadAuthorizationFormats(legacyUploadAuthorizationFormatEntries({
    assertTelemetryTransportWriteAllowed: authority.assertPostgresTelemetryTransportWriteAllowed,
  }));
  const registry = createContributionEnvelopeRegistry([
    createTelemetryV10ContributionEnvelope({
      admitTelemetryV1Contribution: admission.admitPostgresTelemetryV1Contribution,
    }),
  ]);
  const context = Object.freeze({
    primaryPool: pool, schema: schemaOptions, objectStore,
    envelopePublicJwk: keys.publicText, envelopePrivateJwk: keys.privateText,
    typedV1SourceNamespace: NAMESPACE,
  });

  /** POST /api/v1/device/upload-authorizations after device auth. */
  async function authorizeUpload(device, body) {
    const request = parseUploadAuthorizationRequest(body, { maxRequestBytes: MAX_REQUEST_BYTES });
    const format = resolveUploadAuthorizationFormat(formats, request.telemetrySchemaVersion);
    await format.assertUploadAllowed(pool, device, Date.now(), { schema: schemaOptions });
    return uploads.createPostgresDeviceUploadAuthorization(pool, device,
      { envelopeDigest: request.envelopeDigest, bodyBytes: request.contentLengthBytes }, { schema: schemaOptions });
  }

  /** POST /api/v1/contributions: a stand-in for the IN-1b preamble. */
  async function contribute(upload, raw) {
    const value = JSON.parse(raw);
    const claim = await transport.claimPostgresDeviceUploadAuthorization(pool, `Upload ${upload}`, {
      envelopeDigest: sha256Hex(raw), bodyBytes: Buffer.byteLength(raw), contentType: "application/json",
    }, { schema: schemaOptions });
    const participantRow = (await pool.query(
      `SELECT id, consent_version, owner_kind FROM "${schemaOptions.primarySchema}".participants WHERE id = $1`,
      [claim.participantId])).rows[0];
    const deviceId = (await pool.query(
      `SELECT issued_by_device_id FROM "${schemaOptions.primarySchema}".device_upload_authorizations WHERE id = $1`,
      [claim.authorizationId])).rows[0].issued_by_device_id;
    const principal = { participantId: claim.participantId, deviceId };
    try {
      await authority.assertPostgresTelemetryTransportWriteAllowed(pool, principal,
        authority.telemetryTransportSchemaForEnvelope(value.schemaVersion), { schema: schemaOptions });
      const handler = registry.resolve(value.schemaVersion);
      assert.ok(handler, "the v1.0 envelope is registered");
      const response = await handler({ raw, value },
        { id: participantRow.id, consentVersion: participantRow.consent_version, ownerKind: participantRow.owner_kind },
        deviceId, claim, context);
      const receipt = await response.clone().json();
      await admission.recordPostgresDeviceUploadReceipt(pool, claim.authorizationId, receipt.contributionId,
        { schema: schemaOptions });
      return { response, receipt, claim };
    } catch (error) {
      await transport.abandonPostgresDeviceUploadAuthorization(pool, claim, {
        participantId: claim.participantId, deviceId,
      }, { schema: schemaOptions }).catch(() => {});
      throw error;
    }
  }

  async function upload(device, chunk, { envelope } = {}) {
    const raw = JSON.stringify(envelope ?? await encryptedEnvelope(chunk));
    const authorization = await authorizeUpload(device, {
      envelopeDigest: sha256Hex(raw), contentLengthBytes: Buffer.byteLength(raw), contentType: "application/json",
      telemetrySchemaVersion: "telemetry-contribution-v1.0",
    });
    return { raw, ...await contribute(authorization.uploadAuthorization, raw) };
  }

  return { formats, registry, authorizeUpload, contribute, upload, admission };
}

/** The Worker's typed v1 admission for the same chunk, ids and clock, on D1. */
async function oracleAdmission(twin, schema, chunkRowId, chunk, raw) {
  const { insertTypedTelemetryV1Chunk } = await workerModule("/src/typed-v1-admission.ts");
  const { parseTelemetryV1Chunk } = await workerModule("/src/telemetry-v1.ts");
  const { telemetryEnvelopeDigest } = await workerModule("/src/telemetry-repository.ts");
  const row = (await twin.pgOnly(
    `SELECT c.*, to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_iso,
            a.participant_id AS grant_participant
       FROM "${schema}".telemetry_v1_chunks c
       JOIN "${schema}".device_upload_authorizations a ON a.id = c.device_upload_authorization_id
      WHERE c.id = ?`, [chunkRowId])).rows[0];
  assert.ok(row, "PostgreSQL committed the chunk");
  const issued = new Date(Date.parse(row.created_iso) - 1_000).toISOString();
  const expires = new Date(Date.parse(row.created_iso) + 5 * 60_000).toISOString();
  twin.d1Only(
    `INSERT INTO device_upload_authorizations (id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
       body_bytes, content_type, state, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'application/json', 'unused', ?, ?)`,
    [row.device_upload_authorization_id, row.participant_id, row.device_id, bytes32(), sha256Hex(raw),
      Buffer.byteLength(raw), issued, expires]);
  twin.d1Only("UPDATE device_upload_authorizations SET state = 'consuming', consume_lease_expires_at = ? WHERE id = ?",
    [expires, row.device_upload_authorization_id]);
  const envelope = JSON.parse(raw);
  const parsed = parseTelemetryV1Chunk(chunk);
  const result = await insertTypedTelemetryV1Chunk(d1Database(twin.d1), {
    participantId: row.participant_id, deviceId: row.device_id,
    deviceUploadAuthorizationId: row.device_upload_authorization_id, chunkRowId, r2Key: row.r2_key,
    envelopeDigest: await telemetryEnvelopeDigest(envelope), chunk: parsed, supersedes: null,
    createdAt: row.created_iso, authorizationEnvelopeDigest: sha256Hex(raw),
  }, NAMESPACE);
  assert.deepEqual(result, { acceptedRecords: chunk.records.length, replay: false });
  // The Worker records the receipt after the handler (recordDeviceUploadReceipt).
  twin.d1Only(`UPDATE device_upload_authorizations SET state = 'consumed', consumed_at = ?, consumed_contribution_id = ?,
    consume_lease_expires_at = NULL WHERE id = ? AND state = 'consuming'`,
  [row.created_iso, chunkRowId, row.device_upload_authorization_id]);
}

const STREAM_NAMES = ["usage", "quota", "session"];

/** Admission rows of one participant, as original identifiers and values. */
async function snapshot(twin, schema, participantId) {
  const pgq = async (sql, values = []) => (await twin.pool.query(sql, values)).rows;
  const d1q = (sql, values = []) => twin.d1.prepare(sql).all(...values).map((row) => ({ ...row }));
  const s = `"${schema}".`;
  const chunkHeaders = {
    pg: await pgq(`SELECT id, participant_id, device_id, stream, chunk_day::text AS chunk_day, chunk_seq, revision,
        chunk_digest, envelope_digest, parser_version, record_count, accepted_record_count, r2_key,
        device_upload_authorization_id, superseded_at,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
        FROM ${s}telemetry_v1_chunks WHERE participant_id = $1 ORDER BY id`, [participantId]),
    d1: d1q(`SELECT id, participant_id, device_id, stream, chunk_day, chunk_seq, revision, chunk_digest,
        envelope_digest, parser_version, record_count, accepted_record_count, r2_key, device_upload_authorization_id,
        superseded_at, created_at FROM telemetry_v1_chunks WHERE participant_id = ? ORDER BY id`, [participantId]),
  };
  const typedRecords = {
    pg: (await pgq(`SELECT ns.original_id AS namespace, r.format, r.source_row_id::text AS source_row_id,
        o.original_id AS owner, d.original_id AS device, c.original_id AS chunk, c.chunk_day AS chunk_day,
        r.stream, r.occurrence_id, r.observed_at_ms::text AS observed_at_ms, r.observed_day, p.value AS provider,
        r.canonical_digest, iv.value AS session, m.value AS model, sm.value AS speed, st.value AS tier,
        sf.value AS surface, bs.value AS billing, re.value AS effort, sc.value AS scope, oc.value AS outcome,
        u.total_input_context_tokens::text AS total, u.input_uncached_tokens::text AS uncached,
        u.input_cache_read_tokens::text AS cache_read, u.input_cache_write_tokens::text AS cache_write,
        u.output_text_tokens::text AS output_text, u.output_reasoning_tokens::text AS output_reasoning,
        u.output_combined_tokens::text AS output_combined, pt.value AS plan_type, pv.value AS plan_variant,
        li.value AS limit_id, sl.value AS slot, q.used_percent, q.window_duration_minutes,
        q.resets_at_ms::text AS resets_at_ms,
        (SELECT string_agg(tc.value || '=' || t.count, ',' ORDER BY tc.value) FROM ${s}typed_telemetry_session_tools t
          JOIN ${s}typed_telemetry_dictionary tc ON tc.id = t.tool_class_id WHERE t.record_id = r.id) AS tools
      FROM ${s}typed_telemetry_records r
      JOIN ${s}typed_telemetry_namespaces ns ON ns.id = r.namespace_id
      JOIN ${s}typed_telemetry_owners o ON o.id = r.owner_id
      JOIN ${s}typed_telemetry_devices d ON d.id = r.device_id
      JOIN ${s}typed_telemetry_chunks c ON c.id = r.chunk_id
      JOIN ${s}typed_telemetry_dictionary p ON p.id = r.provider_id
      LEFT JOIN ${s}typed_telemetry_usage u ON u.record_id = r.id
      LEFT JOIN ${s}typed_telemetry_identifiers iv ON iv.id = u.session_id
      LEFT JOIN ${s}typed_telemetry_dictionary m ON m.id = u.model_id
      LEFT JOIN ${s}typed_telemetry_dictionary sm ON sm.id = u.speed_mode_id
      LEFT JOIN ${s}typed_telemetry_dictionary st ON st.id = u.api_service_tier_id
      LEFT JOIN ${s}typed_telemetry_dictionary sf ON sf.id = u.surface_id
      LEFT JOIN ${s}typed_telemetry_dictionary bs ON bs.id = u.billing_surface_id
      LEFT JOIN ${s}typed_telemetry_dictionary re ON re.id = u.reasoning_effort_id
      LEFT JOIN ${s}typed_telemetry_dictionary sc ON sc.id = u.agent_scope_id
      LEFT JOIN ${s}typed_telemetry_dictionary oc ON oc.id = u.outcome_id
      LEFT JOIN ${s}typed_telemetry_quota q ON q.record_id = r.id
      LEFT JOIN ${s}typed_telemetry_quota_dimensions qd ON qd.id = q.dimensions_id
      LEFT JOIN ${s}typed_telemetry_dictionary pt ON pt.id = qd.plan_type_id
      LEFT JOIN ${s}typed_telemetry_dictionary pv ON pv.id = qd.plan_variant_id
      LEFT JOIN ${s}typed_telemetry_dictionary li ON li.id = q.limit_id
      LEFT JOIN ${s}typed_telemetry_dictionary sl ON sl.id = q.slot_id
      JOIN ${s}typed_telemetry_owner_memberships om ON om.namespace_id = r.namespace_id AND om.owner_id = r.owner_id
       AND om.source_format = 10
      WHERE r.format = 10 AND om.participant_id = $1
      ORDER BY r.source_row_id`, [participantId])),
    d1: d1q(`SELECT ns.original_id AS namespace, r.format, CAST(r.source_row_id AS TEXT) AS source_row_id,
        o.original_id AS owner, d.original_id AS device, c.original_id AS chunk, c.chunk_day AS chunk_day,
        r.stream, r.occurrence_id, CAST(r.observed_at_ms AS TEXT) AS observed_at_ms, r.observed_day,
        p.value AS provider, r.canonical_digest, iv.value AS session, m.value AS model, sm.value AS speed,
        st.value AS tier, sf.value AS surface, bs.value AS billing, re.value AS effort, sc.value AS scope,
        oc.value AS outcome, CAST(u.total_input_context_tokens AS TEXT) AS total,
        CAST(u.input_uncached_tokens AS TEXT) AS uncached, CAST(u.input_cache_read_tokens AS TEXT) AS cache_read,
        CAST(u.input_cache_write_tokens AS TEXT) AS cache_write, CAST(u.output_text_tokens AS TEXT) AS output_text,
        CAST(u.output_reasoning_tokens AS TEXT) AS output_reasoning,
        CAST(u.output_combined_tokens AS TEXT) AS output_combined, pt.value AS plan_type, pv.value AS plan_variant,
        li.value AS limit_id, sl.value AS slot, q.used_percent, q.window_duration_minutes,
        CAST(q.resets_at_ms AS TEXT) AS resets_at_ms,
        (SELECT group_concat(value || '=' || count, ',') FROM (SELECT tc.value, t.count
          FROM typed_telemetry_session_tools t JOIN typed_telemetry_dictionary tc ON tc.id = t.tool_class_id
          WHERE t.record_id = r.id ORDER BY tc.value)) AS tools
      FROM typed_telemetry_records r
      JOIN typed_telemetry_namespaces ns ON ns.id = r.namespace_id
      JOIN typed_telemetry_owners o ON o.id = r.owner_id
      JOIN typed_telemetry_devices d ON d.id = r.device_id
      JOIN typed_telemetry_chunks c ON c.id = r.chunk_id
      JOIN typed_telemetry_dictionary p ON p.id = r.provider_id
      LEFT JOIN typed_telemetry_usage u ON u.record_id = r.id
      LEFT JOIN typed_telemetry_identifiers iv ON iv.id = u.session_id
      LEFT JOIN typed_telemetry_dictionary m ON m.id = u.model_id
      LEFT JOIN typed_telemetry_dictionary sm ON sm.id = u.speed_mode_id
      LEFT JOIN typed_telemetry_dictionary st ON st.id = u.api_service_tier_id
      LEFT JOIN typed_telemetry_dictionary sf ON sf.id = u.surface_id
      LEFT JOIN typed_telemetry_dictionary bs ON bs.id = u.billing_surface_id
      LEFT JOIN typed_telemetry_dictionary re ON re.id = u.reasoning_effort_id
      LEFT JOIN typed_telemetry_dictionary sc ON sc.id = u.agent_scope_id
      LEFT JOIN typed_telemetry_dictionary oc ON oc.id = u.outcome_id
      LEFT JOIN typed_telemetry_quota q ON q.record_id = r.id
      LEFT JOIN typed_telemetry_quota_dimensions qd ON qd.id = q.dimensions_id
      LEFT JOIN typed_telemetry_dictionary pt ON pt.id = qd.plan_type_id
      LEFT JOIN typed_telemetry_dictionary pv ON pv.id = qd.plan_variant_id
      LEFT JOIN typed_telemetry_dictionary li ON li.id = q.limit_id
      LEFT JOIN typed_telemetry_dictionary sl ON sl.id = q.slot_id
      JOIN typed_v1_owner_memberships om ON om.typed_owner_id = r.owner_id
      WHERE r.format = 10 AND om.participant_id = ?
      ORDER BY r.source_row_id`, [participantId]),
  };
  const normalizeRecord = (row) => ({
    ...row, namespace: hex(row.namespace), owner: hex(row.owner), device: hex(row.device), chunk: hex(row.chunk),
    occurrence_id: hex(row.occurrence_id), canonical_digest: hex(row.canonical_digest),
    session: hex(row.session), format: Number(row.format), stream: STREAM_NAMES[Number(row.stream) - 1],
    chunk_day: Number(row.chunk_day), observed_day: Number(row.observed_day),
    used_percent: row.used_percent === null ? null : Number(row.used_percent),
    window_duration_minutes: row.window_duration_minutes === null ? null : Number(row.window_duration_minutes),
  });
  const allocations = {
    pg: await pgq(`SELECT a.chunk_id, ns.original_id AS namespace, a.chunk_original, a.first_source_row_id::text AS first,
        a.record_count FROM ${s}typed_v1_chunk_allocations a JOIN ${s}typed_telemetry_namespaces ns ON ns.id = a.namespace_id
        JOIN ${s}telemetry_v1_chunks c ON c.id = a.chunk_id WHERE c.participant_id = $1 ORDER BY a.chunk_id`, [participantId]),
    d1: d1q(`SELECT a.chunk_id, ns.original_id AS namespace, a.chunk_original, CAST(a.first_source_row_id AS TEXT) AS first,
        a.record_count FROM typed_v1_chunk_allocations a JOIN typed_telemetry_namespaces ns ON ns.id = a.namespace_id
        JOIN telemetry_v1_chunks c ON c.id = a.chunk_id WHERE c.participant_id = ? ORDER BY a.chunk_id`, [participantId]),
  };
  const admissions = {
    pg: await pgq(`SELECT a.chunk_id, r.source_row_id::text AS source_row_id FROM ${s}typed_v1_record_admissions a
        JOIN ${s}typed_telemetry_records r ON r.id = a.typed_record_id JOIN ${s}telemetry_v1_chunks c ON c.id = a.chunk_id
        WHERE c.participant_id = $1 ORDER BY r.source_row_id`, [participantId]),
    d1: d1q(`SELECT a.chunk_id, CAST(r.source_row_id AS TEXT) AS source_row_id FROM typed_v1_record_admissions a
        JOIN typed_telemetry_records r ON r.id = a.typed_record_id JOIN telemetry_v1_chunks c ON c.id = a.chunk_id
        WHERE c.participant_id = ? ORDER BY r.source_row_id`, [participantId]),
  };
  const typedChunks = {
    pg: await pgq(`SELECT c.original_id AS chunk, c.format, c.stream, c.chunk_day, c.manifest_id, o.original_id AS owner,
        d.original_id AS device FROM ${s}typed_telemetry_chunks c JOIN ${s}typed_telemetry_owners o ON o.id = c.owner_id
        JOIN ${s}typed_telemetry_devices d ON d.id = c.device_id
        JOIN ${s}typed_v1_chunk_allocations a ON a.chunk_original = c.original_id
        JOIN ${s}telemetry_v1_chunks h ON h.id = a.chunk_id WHERE h.participant_id = $1 ORDER BY a.chunk_id`, [participantId]),
    d1: d1q(`SELECT c.original_id AS chunk, c.format, c.stream, c.chunk_day, c.manifest_id, o.original_id AS owner,
        d.original_id AS device FROM typed_telemetry_chunks c JOIN typed_telemetry_owners o ON o.id = c.owner_id
        JOIN typed_telemetry_devices d ON d.id = c.device_id
        JOIN typed_v1_chunk_allocations a ON a.chunk_original = c.original_id
        JOIN telemetry_v1_chunks h ON h.id = a.chunk_id WHERE h.participant_id = ? ORDER BY a.chunk_id`, [participantId]),
  };
  const membership = {
    pg: await pgq(`SELECT m.participant_id, o.original_id AS owner FROM ${s}typed_telemetry_owner_memberships m
        JOIN ${s}typed_telemetry_owners o ON o.id = m.owner_id WHERE m.participant_id = $1 AND m.source_format = 10
        AND m.source_namespace = $2`, [participantId, NAMESPACE]),
    d1: d1q(`SELECT m.participant_id, o.original_id AS owner FROM typed_v1_owner_memberships m
        JOIN typed_telemetry_owners o ON o.id = m.typed_owner_id WHERE m.participant_id = ?`, [participantId]),
  };
  const events = {
    pg: await pgq(`SELECT e.chunk_id, e.source_namespace, e.event_digest, e.owner_digest, l.state AS link_state,
        l.object_digest, l.manifest_digest, j.kind, j.revision::text AS revision, j.authority_epoch::text AS authority_epoch,
        j.public_authority_epoch::text AS public_authority_epoch, j.object_digest AS journal_object, j.content_digest,
        j.sequence::text AS sequence
        FROM ${s}typed_v1_event_sources e JOIN ${s}storage_v11_owner_links l ON l.participant_id = e.participant_id
        JOIN ${s}storage_ingestion_changes j ON j.event_digest = e.event_digest
        WHERE e.participant_id = $1 ORDER BY j.sequence`, [participantId]),
    d1: d1q(`SELECT e.chunk_id, e.source_namespace, e.event_digest, e.owner_digest, l.state AS link_state,
        l.object_digest, l.manifest_digest, j.kind, CAST(j.revision AS TEXT) AS revision,
        CAST(j.authority_epoch AS TEXT) AS authority_epoch, CAST(j.public_authority_epoch AS TEXT) AS public_authority_epoch,
        j.object_digest AS journal_object, j.content_digest, CAST(j.sequence AS TEXT) AS sequence
        FROM typed_v1_event_sources e JOIN storage_v11_owner_links l ON l.participant_id = e.participant_id
        JOIN storage_ingestion_changes j ON j.event_digest = e.event_digest
        WHERE e.participant_id = ? ORDER BY j.sequence`, [participantId]),
  };
  // Random digests differ per store; keep only their identities and roles.
  const normalizeEvents = (rows) => {
    const last = rows.at(-1);
    return rows.map((row) => ({
      chunk_id: row.chunk_id, source_namespace: row.source_namespace, kind: row.kind, revision: row.revision,
      authority_epoch: row.authority_epoch, public_authority_epoch: row.public_authority_epoch,
      content_digest: row.content_digest, journalObjectIsEvent: row.journal_object === row.event_digest,
      ownerDigestIsLink: rows.every((other) => other.owner_digest === row.owner_digest),
      linkState: row.link_state,
      linkPointsAtLatest: row.object_digest === last.event_digest && row.manifest_digest === last.content_digest,
    }));
  };
  const heads = {
    pg: await pgq(`SELECT h.state, h.revision::text AS revision, h.authority_epoch::text AS authority_epoch
        FROM ${s}storage_owner_revisions h JOIN ${s}storage_v11_owner_links l ON l.owner_digest = h.owner_digest
        WHERE l.participant_id = $1`, [participantId]),
    d1: d1q(`SELECT h.state, CAST(h.revision AS TEXT) AS revision, CAST(h.authority_epoch AS TEXT) AS authority_epoch
        FROM storage_owner_revisions h JOIN storage_v11_owner_links l ON l.owner_digest = h.owner_digest
        WHERE l.participant_id = ?`, [participantId]),
  };
  const grants = {
    pg: await pgq(`SELECT id, state, consumed_contribution_id, consume_lease_expires_at IS NULL AS lease_cleared
        FROM ${s}device_upload_authorizations WHERE participant_id = $1 AND consumed_contribution_id IS NOT NULL
        AND consumed_contribution_id IN (SELECT id FROM ${s}telemetry_v1_chunks WHERE device_upload_authorization_id
          = device_upload_authorizations.id) ORDER BY id`, [participantId]),
    d1: d1q(`SELECT id, state, consumed_contribution_id, consume_lease_expires_at IS NULL AS lease_cleared
        FROM device_upload_authorizations WHERE participant_id = ? AND consumed_contribution_id IS NOT NULL
        AND consumed_contribution_id IN (SELECT id FROM telemetry_v1_chunks WHERE device_upload_authorization_id
          = device_upload_authorizations.id) ORDER BY id`, [participantId]),
  };
  const windows = {
    pg: await pgq(`SELECT device_id, window_day::text AS window_day, accepted_count
        FROM ${s}telemetry_v1_chunk_admission_windows WHERE participant_id = $1 ORDER BY device_id`, [participantId]),
    d1: d1q(`SELECT device_id, window_day, accepted_count FROM telemetry_v1_chunk_admission_windows
        WHERE participant_id = ? ORDER BY device_id`, [participantId]),
  };
  const state = {
    pg: await pgq(`SELECT next_source_row_id::text AS next FROM ${s}typed_v1_admission_state WHERE id = 1`),
    d1: d1q("SELECT CAST(next_source_row_id AS TEXT) AS next FROM typed_v1_admission_state WHERE id = 1"),
  };
  const transient = {
    pg: { records: Number((await pgq(`SELECT count(*) AS n FROM ${s}telemetry_v1_records`))[0].n),
      scope: Number((await pgq(`SELECT count(*) AS n FROM ${s}graph_scope`))[0].n) },
    d1: { records: Number(d1q("SELECT count(*) AS n FROM telemetry_v1_records")[0].n),
      scope: Number(d1q("SELECT count(*) AS n FROM community_graph_update_scope")[0].n)
        + Number(d1q("SELECT count(*) AS n FROM typed_v1_authority_requests")[0].n) },
  };
  const hexRows = (rows, keys) => rows.map((row) => ({ ...row, ...Object.fromEntries(keys.map((key) => [key, hex(row[key])])) }));
  return {
    pg: {
      chunkHeaders: chunkHeaders.pg.map((row) => ({ ...row, superseded_at: row.superseded_at })),
      typedRecords: typedRecords.pg.map(normalizeRecord),
      typedChunks: hexRows(typedChunks.pg, ["chunk", "owner", "device"]).map((row) => ({
        ...row, format: Number(row.format), stream: Number(row.stream), chunk_day: Number(row.chunk_day) })),
      allocations: hexRows(allocations.pg, ["namespace", "chunk_original"]),
      admissions: admissions.pg,
      membership: hexRows(membership.pg, ["owner"]),
      events: normalizeEvents(events.pg),
      heads: heads.pg,
      grants: grants.pg.map((row) => ({ ...row, lease_cleared: Boolean(row.lease_cleared) })),
      windows: windows.pg,
      state: state.pg,
      transient: transient.pg,
    },
    d1: {
      chunkHeaders: chunkHeaders.d1,
      typedRecords: typedRecords.d1.map(normalizeRecord),
      typedChunks: hexRows(typedChunks.d1, ["chunk", "owner", "device"]).map((row) => ({
        ...row, format: Number(row.format), stream: Number(row.stream), chunk_day: Number(row.chunk_day) })),
      allocations: hexRows(allocations.d1, ["namespace", "chunk_original"]),
      admissions: admissions.d1,
      membership: hexRows(membership.d1, ["owner"]),
      events: normalizeEvents(events.d1),
      heads: heads.d1,
      grants: grants.d1.map((row) => ({ ...row, lease_cleared: Boolean(row.lease_cleared) })),
      windows: windows.d1,
      state: state.d1,
      transient: transient.d1,
    },
  };
}

// ---------------------------------------------------------------------------

test("the oracle is production's code: every oracle source is byte-identical to its d43c8f92 blob", async () => {
  const pinned = JSON.parse(await readFile(join(WORKER_ROOT, "postgres-test", "fixtures",
    "legacy-contribution-oracle-blobs.json"), "utf8"));
  assert.equal(pinned.commit, "d43c8f92");
  assert.deepEqual(Object.keys(pinned.blobs).sort(), Object.keys(ORACLE_SOURCES).sort());
  for (const path of Object.keys(ORACLE_SOURCES)) {
    assert.equal(gitBlobId(await readFile(join(WORKER_ROOT, path))), pinned.blobs[path], path);
  }
});

test("upload-authorization formats: the Worker's body check, v1.0 default and refusal codes, no database", async () => {
  const unreachable = () => { throw new Error("a refused request must not reach the format authority"); };
  const formats = createUploadAuthorizationFormats(legacyUploadAuthorizationFormatEntries({
    assertTelemetryTransportWriteAllowed: unreachable,
  }));
  assert.deepEqual(formats.telemetrySchemaVersions, LEGACY_V1_UPLOAD_AUTHORIZATION_SCHEMA_VERSIONS);
  const digest = "a".repeat(64);
  const base = { envelopeDigest: digest, contentLengthBytes: 512, contentType: "application/json" };
  const parse = (value) => {
    try {
      return parseUploadAuthorizationRequest(value, { maxRequestBytes: MAX_REQUEST_BYTES });
    } catch (error) {
      return outcomeOf(error);
    }
  };
  const BODY_INVALID = { status: 400, code: "BODY_INVALID", details: null };
  const BLOCKED = { status: 403, code: "TELEMETRY_TRANSPORT_BLOCKED", details: null };
  // Oversized: the Worker's only size bound is MAX_REQUEST_BYTES for every format.
  assert.deepEqual(parse({ ...base, contentLengthBytes: MAX_REQUEST_BYTES + 1,
    telemetrySchemaVersion: "telemetry-contribution-v1.0" }), BODY_INVALID);
  assert.deepEqual(parse({ ...base, contentLengthBytes: MAX_REQUEST_BYTES + 1,
    telemetrySchemaVersion: "telemetry-contribution-v1.1" }), BODY_INVALID);
  assert.equal(parse({ ...base, contentLengthBytes: MAX_REQUEST_BYTES }).contentLengthBytes, MAX_REQUEST_BYTES);
  for (const bad of [null, [], "x", {}, { envelopeDigest: digest }, { ...base, contentLengthBytes: 0 },
    { ...base, contentLengthBytes: 1.5 }, { ...base, contentType: "text/plain" }, { ...base, envelopeDigest: "A".repeat(64) },
    { ...base, extra: 1 }, { ...base, telemetrySchemaVersion: "telemetry-contribution-v1.0", extra: 1 }]) {
    assert.deepEqual(parse(bad), BODY_INVALID, JSON.stringify(bad));
  }
  // Three keys: the Worker defaults to v1.0 (index.ts `?? "telemetry-contribution-v1.0"`).
  assert.equal(parse(base).telemetrySchemaVersion, DEFAULT_UPLOAD_AUTHORIZATION_SCHEMA_VERSION);
  assert.equal(parse({ ...base, telemetrySchemaVersion: null }).telemetrySchemaVersion, "telemetry-contribution-v1.0");
  for (const version of ["telemetry-contribution-v1.3", "telemetry-envelope-v1.0", "", 10, {}]) {
    assert.deepEqual(parse({ ...base, telemetrySchemaVersion: version }), BLOCKED, String(version));
  }
  // A known identifier without a registered format never mints an authorization.
  const resolveCode = (version) => {
    try {
      return resolveUploadAuthorizationFormat(formats, version) ? "resolved" : "none";
    } catch (error) {
      return outcomeOf(error);
    }
  };
  assert.equal(resolveCode("telemetry-contribution-v1.0"), "resolved");
  assert.equal(resolveCode("telemetry-contribution-v1.1"), "resolved");
  assert.deepEqual(resolveCode("telemetry-contribution-v0.1"), BLOCKED);
  assert.deepEqual(resolveCode("telemetry-contribution-v1.2"), BLOCKED);
  assert.throws(() => legacyUploadAuthorizationFormatEntries({ assertTelemetryTransportWriteAllowed: unreachable,
    schemaVersions: ["telemetry-contribution-v1.2"] }), /UPLOAD_AUTHORIZATION_FORMAT_INVALID/u);
  assert.throws(() => legacyUploadAuthorizationFormatEntries({}), /UPLOAD_AUTHORIZATION_FORMAT_INVALID/u);
  assert.deepEqual(Object.keys(legacyUploadAuthorizationFormatEntries({ assertTelemetryTransportWriteAllowed: unreachable,
    schemaVersions: RETAINED_V0_UPLOAD_AUTHORIZATION_SCHEMA_VERSIONS })), RETAINED_V0_UPLOAD_AUTHORIZATION_SCHEMA_VERSIONS);
});

test("PG17 upload authorization: each legacy format answers as the Worker on D1, unconsented v1.1 included", {
  skip: SKIP, timeout: 240_000,
}, () => withTwin(async ({ twin, pool, schema }) => {
  const { schemaOptions } = await initializeTypedTargets(twin, schema);
  const worker = await workerModule("/src/telemetry-transport-policy.ts");
  const { errorResponse, ApiError } = await workerModule("/src/errors.ts");
  const service = await origin(pool, schemaOptions, memoryObjectStore());
  const allFormats = createUploadAuthorizationFormats(legacyUploadAuthorizationFormatEntries({
    assertTelemetryTransportWriteAllowed:
      (await workerModule("/src/postgres-transport-write-authority.ts")).assertPostgresTelemetryTransportWriteAllowed,
    schemaVersions: [...LEGACY_V1_UPLOAD_AUTHORIZATION_SCHEMA_VERSIONS, ...RETAINED_V0_UPLOAD_AUTHORIZATION_SCHEMA_VERSIONS],
  }));
  await socialParticipant(twin, "in3-social");
  const device = await socialDevice(twin, "in3-social", randomUUID());
  const d1 = d1Database(twin.d1);
  const workerOutcome = async (version) => {
    try {
      await worker.assertTelemetryTransportWriteAllowed(d1, device, version);
      return "allowed";
    } catch (error) {
      return `${error.status} ${error.code}`;
    }
  };
  const originOutcome = async (formats, version) => {
    try {
      await resolveUploadAuthorizationFormat(formats, version).assertUploadAllowed(pool, device, Date.now(),
        { schema: schemaOptions });
      return "allowed";
    } catch (error) {
      return `${error.status} ${error.code}`;
    }
  };
  const matrix = async () => {
    const table = {};
    for (const version of [...LEGACY_V1_UPLOAD_AUTHORIZATION_SCHEMA_VERSIONS, ...RETAINED_V0_UPLOAD_AUTHORIZATION_SCHEMA_VERSIONS]) {
      const expected = await workerOutcome(version);
      assert.equal(await originOutcome(allFormats, version), expected, version);
      table[version] = expected;
    }
    return table;
  };
  // The D1 seed (0044) leaves v1.1 'staged': both stores refuse it as blocked.
  assert.deepEqual(await matrix(), {
    "telemetry-contribution-v1.0": "allowed",
    "telemetry-contribution-v1.1": "403 TELEMETRY_TRANSPORT_BLOCKED",
    "telemetry-contribution-v0.1": "allowed",
    "telemetry-contribution-v0.2": "403 TELEMETRY_TRANSPORT_BLOCKED",
  });
  // Production runs with v1.1 activated. The social participant has no v1.1
  // consent row: the Worker refuses v1.1 with 403 TELEMETRY_CONSENT_INVALID,
  // admits v1.0 and v0.1 (rank-1 floor) and refuses v0.2 ('blocked').
  await twin.run("UPDATE telemetry_transport_formats SET lifecycle = 'accepted' WHERE schema_version = ?",
    ["telemetry-contribution-v1.1"]);
  assert.deepEqual(await matrix(), {
    "telemetry-contribution-v1.0": "allowed",
    "telemetry-contribution-v1.1": "403 TELEMETRY_CONSENT_INVALID",
    "telemetry-contribution-v0.1": "allowed",
    "telemetry-contribution-v0.2": "403 TELEMETRY_TRANSPORT_BLOCKED",
  });
  // The rendered refusal is the Worker's errorResponse body.
  const raw = JSON.stringify({ synthetic: true });
  for (const [body, status, code] of [
    [{ envelopeDigest: sha256Hex(raw), contentLengthBytes: MAX_REQUEST_BYTES + 1, contentType: "application/json",
      telemetrySchemaVersion: "telemetry-contribution-v1.0" }, 400, "BODY_INVALID"],
    [{ envelopeDigest: sha256Hex(raw), contentLengthBytes: 10, contentType: "application/json",
      telemetrySchemaVersion: "telemetry-contribution-v1.1" }, 403, "TELEMETRY_CONSENT_INVALID"],
  ]) {
    let refusal;
    await assert.rejects(service.authorizeUpload(device, body), (error) => {
      refusal = error;
      return true;
    });
    const rendered = errorResponse(new ApiError(refusal.status, refusal.code), "request-synthetic");
    const expected = errorResponse(new ApiError(status, code), "request-synthetic");
    assert.equal(rendered.status, expected.status);
    assert.deepEqual(await rendered.json(), await expected.json());
  }
  const unissued = await pool.query(`SELECT count(*)::int AS n FROM "${schema}".device_upload_authorizations`);
  assert.equal(unissued.rows[0].n, 0, "a refused request issues nothing");
  // A three-key body is a v1.0 authorization, issued while v1.0 is allowed.
  const defaulted = await service.authorizeUpload(device, { envelopeDigest: sha256Hex(raw), contentLengthBytes: 10,
    contentType: "application/json" });
  assert.match(defaulted.uploadAuthorization, /^um_device_upload_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u);
  // Granting v1.1 consent raises the floor to rank 11 on both stores: v1.1 is
  // issued, while v1.0 and v0.1 are now below the floor.
  await twin.run(`INSERT INTO telemetry_v11_device_consents (participant_id, device_id, telemetry_schema_version,
      field_dictionary_version, privacy_contract_version, consented_at)
    VALUES (?, ?, 'telemetry-contribution-v1.1', 'telemetry-v1.1-registry-2026-08-31.1',
      'ongoing-privacy-safe-telemetry-v1.1', ?)`, [device.participantId, device.deviceId, iso()]);
  assert.deepEqual(await matrix(), {
    "telemetry-contribution-v1.0": "403 TELEMETRY_TRANSPORT_BLOCKED",
    "telemetry-contribution-v1.1": "allowed",
    "telemetry-contribution-v0.1": "403 TELEMETRY_TRANSPORT_BLOCKED",
    "telemetry-contribution-v0.2": "403 TELEMETRY_TRANSPORT_BLOCKED",
  });
  const issued = await service.authorizeUpload(device, { envelopeDigest: sha256Hex(raw), contentLengthBytes: 10,
    contentType: "application/json", telemetrySchemaVersion: "telemetry-contribution-v1.1" });
  assert.match(issued.uploadAuthorization, /^um_device_upload_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u);
  const issuedCount = await pool.query(`SELECT count(*)::int AS n FROM "${schema}".device_upload_authorizations`);
  assert.equal(issuedCount.rows[0].n, 2);
}));

test("PG17 a v1.0 chunk is admitted end to end through the registry with the d43c8f92 typed-v1 rows", {
  skip: SKIP, timeout: 300_000,
}, () => withTwin(async ({ twin, pool, schema }) => {
  const { schemaOptions } = await initializeTypedTargets(twin, schema);
  const store = memoryObjectStore();
  const service = await origin(pool, schemaOptions, store);
  await socialParticipant(twin, "in3-owner");
  const device = await socialDevice(twin, "in3-owner", randomUUID());

  const uploads = [];
  for (const [stream, count] of [["usage", 3], ["quota", 1], ["session", 1]]) {
    const chunk = await syntheticChunk({ stream, count, seed: "parity" });
    const result = await service.upload(device, chunk);
    assert.equal(result.response.status, 202);
    assert.equal(result.response.headers.get("idempotency-replayed"), null);
    assert.deepEqual({ ...result.receipt, contributionId: "<id>" }, {
      schemaVersion: "telemetry-chunk-receipt-v1.0", contributionId: "<id>", chunkId: chunk.chunkId, chunkRevision: 1,
      status: "accepted", supersededRevision: null, recordCounts: { declared: count, accepted: count },
      acknowledgedThroughDay: day(), admission: result.receipt.admission,
    });
    assert.equal(result.receipt.admission.schemaVersion, "telemetry-chunk-admission-v1.0");
    assert.equal(result.receipt.admission.acceptedChunks, uploads.length + 1);
    assert.match(result.receipt.contributionId, /^chunk:[0-9a-f-]{36}$/u);
    uploads.push({ chunk, ...result });
    await oracleAdmission(twin, schema, result.receipt.contributionId, chunk, result.raw);
  }

  const rows = await snapshot(twin, schema, "in3-owner");
  for (const key of Object.keys(rows.d1)) {
    assert.deepEqual(rows.pg[key], rows.d1[key], `${key} matches the d43c8f92 typed-v1 admission`);
  }
  assert.equal(rows.pg.typedRecords.length, 5);
  assert.deepEqual(rows.pg.events.map((event) => event.kind), ["owner-active", "source-updated", "source-updated"]);
  assert.deepEqual(rows.pg.transient, { records: 0, scope: 0 });
  // One stored envelope per chunk, exactly as the Worker writes it to R2.
  assert.equal(store.objects.size, 3);
  for (const { chunk, receipt, raw } of uploads) {
    const header = rows.pg.chunkHeaders.find((row) => row.id === receipt.contributionId);
    const object = store.objects.get(header.r2_key);
    assert.equal(object.value, JSON.stringify(JSON.parse(raw)));
    assert.deepEqual(object.options, { contentType: "application/json", customMetadata: {
      contributionId: receipt.contributionId, schemaVersion: "telemetry-envelope-v1.0",
      plaintextSchemaVersion: chunk.schemaVersion, synthetic: "false" } });
  }
  const pending = await pool.query(`SELECT object_kind, reconciliation_state, count(*)::int AS n
    FROM "${schema}".pending_objects GROUP BY 1, 2`);
  assert.deepEqual(pending.rows, [{ object_kind: "telemetry_v1", reconciliation_state: "registered", n: 3 }]);
}));

test("PG17 re-uploading the same chunk is idempotent: same receipt id, no new rows, the new grant consumed", {
  skip: SKIP, timeout: 300_000,
}, () => withTwin(async ({ twin, pool, schema }) => {
  const { schemaOptions } = await initializeTypedTargets(twin, schema);
  const store = memoryObjectStore();
  const service = await origin(pool, schemaOptions, store);
  await socialParticipant(twin, "in3-replay");
  const device = await socialDevice(twin, "in3-replay", randomUUID());
  const chunk = await syntheticChunk({ stream: "usage", count: 2, seed: "replay" });
  const first = await service.upload(device, chunk);
  assert.equal(first.response.status, 202);
  await oracleAdmission(twin, schema, first.receipt.contributionId, chunk, first.raw);
  const before = await snapshot(twin, schema, "in3-replay");

  // The exact envelope again (a lost response): envelope-digest replay.
  const again = await service.upload(device, chunk, { envelope: JSON.parse(first.raw) });
  // A re-encrypted envelope of the same records: current-content replay.
  const reencrypted = await service.upload(device, chunk);
  for (const replay of [again, reencrypted]) {
    assert.equal(replay.response.status, 202);
    assert.equal(replay.response.headers.get("idempotency-replayed"), "true");
    assert.deepEqual(replay.receipt, {
      schemaVersion: "telemetry-chunk-receipt-v1.0", contributionId: first.receipt.contributionId,
      chunkId: chunk.chunkId, chunkRevision: 1, status: "accepted", replayed: true,
      recordCounts: { declared: 2, accepted: 2 }, acknowledgedThroughDay: day(),
    });
    const grant = await pool.query(`SELECT state, consumed_contribution_id FROM "${schema}".device_upload_authorizations
      WHERE id = $1`, [replay.claim.authorizationId]);
    assert.deepEqual(grant.rows[0], { state: "consumed", consumed_contribution_id: first.receipt.contributionId },
      "the Worker's recordDeviceUploadReceipt consumes a replayed grant against the retained chunk");
  }
  const afterRows = await snapshot(twin, schema, "in3-replay");
  assert.deepEqual(afterRows.pg, before.pg, "a replay writes no admission row");
  assert.equal(store.objects.size, 1, "a replay stores no second envelope");
  const counts = await pool.query(`SELECT (SELECT count(*)::int FROM "${schema}".telemetry_v1_chunks) AS chunks,
    (SELECT count(*)::int FROM "${schema}".typed_telemetry_records) AS records,
    (SELECT count(*)::int FROM "${schema}".storage_ingestion_changes) AS journal,
    (SELECT count(*)::int FROM "${schema}".pending_objects) AS pending`);
  assert.deepEqual(counts.rows[0], { chunks: 1, records: 2, journal: 1, pending: 1 });
}));

test("PG17 v1.0 refusals keep the Worker's status, code and order, and write nothing", {
  skip: SKIP, timeout: 300_000,
}, () => withTwin(async ({ twin, pool, schema }) => {
  const { schemaOptions } = await initializeTypedTargets(twin, schema);
  const store = memoryObjectStore();
  const service = await origin(pool, schemaOptions, store);
  await socialParticipant(twin, "in3-refusals");
  const device = await socialDevice(twin, "in3-refusals", randomUUID());
  await socialParticipant(twin, "in3-unconsented");
  const unconsented = await socialDevice(twin, "in3-unconsented", randomUUID(), { consent: false });
  await socialParticipant(twin, "in3-wrong-consent", "privacy-safe-telemetry-v0.2");
  const wrongConsent = { ...await socialDevice(twin, "in3-wrong-consent", randomUUID()),
    participantConsentVersion: "privacy-safe-telemetry-v0.2" };

  const refused = async (principal, chunk, options) => {
    try {
      await service.upload(principal, chunk, options);
    } catch (error) {
      return outcomeOf(error);
    }
    assert.fail("the upload was expected to be refused");
  };
  assert.deepEqual(await refused(unconsented, await syntheticChunk()),
    { status: 403, code: "TELEMETRY_CONSENT_INVALID", details: null });
  assert.deepEqual(await refused(wrongConsent, await syntheticChunk()),
    { status: 400, code: "TELEMETRY_REQUIRED", details: null });
  assert.deepEqual(await refused(device, await syntheticChunk({ digest: "0".repeat(64) })),
    { status: 400, code: "CHUNK_DIGEST_MISMATCH", details: null });
  assert.deepEqual(await refused(device, await syntheticChunk({ revision: 2 })),
    { status: 409, code: "CHUNK_REVISION_CONFLICT", details: null });
  assert.deepEqual(await refused(device, await syntheticChunk({ revision: 0 })),
    { status: 400, code: "CHUNK_INVALID", details: null });
  const consentDrift = { ...await syntheticChunk(), consent: { ...V1_CONSENT, privacyContractVersion: "drift" } };
  assert.deepEqual(await refused(device, consentDrift), { status: 403, code: "TELEMETRY_CONSENT_INVALID", details: null });
  // An envelope that is not v1.0-shaped is refused before any decryption.
  const envelope = await encryptedEnvelope(await syntheticChunk());
  assert.deepEqual(await refused(device, null, { envelope: { ...envelope, synthetic: true } }),
    { status: 400, code: "ENVELOPE_INVALID", details: null });
  const counts = async () => (await pool.query(`SELECT
      (SELECT count(*)::int FROM "${schema}".telemetry_v1_chunks) AS chunks,
      (SELECT count(*)::int FROM "${schema}".typed_telemetry_records) AS records,
      (SELECT count(*)::int FROM "${schema}".pending_objects) AS pending,
      (SELECT count(*)::int FROM "${schema}".device_upload_authorizations WHERE state = 'revoked') AS abandoned,
      (SELECT count(*)::int FROM "${schema}".device_upload_authorizations WHERE state <> 'revoked') AS other`)).rows[0];
  assert.deepEqual(await counts(), { chunks: 0, records: 0, pending: 0, abandoned: 7, other: 0 },
    "every refused claim is abandoned and nothing is stored");
  assert.equal(store.objects.size, 0);

  // A correction over a current chunk is the documented gap: refused, no write.
  const first = await service.upload(device, await syntheticChunk({ count: 1, seed: "correct" }));
  assert.equal(first.response.status, 202);
  const correction = await syntheticChunk({ count: 2, seed: "correct-2", revision: 2 });
  assert.deepEqual(await refused(device, correction), { status: 503, code: "BACKEND_STORAGE_UNAVAILABLE", details: null });
  assert.deepEqual(await counts(), { chunks: 1, records: 1, pending: 1, abandoned: 8, other: 1 });
  assert.equal(store.objects.size, 1);

  // An unpinned typed target refuses before decrypting or writing.
  await pool.query(`UPDATE "${schema}".typed_v1_admission_state SET runtime_contract_version = 0 WHERE id = 1`);
  assert.deepEqual(await refused(device, await syntheticChunk({ seq: 4, seed: "unpinned" })),
    { status: 503, code: "BACKEND_STORAGE_UNAVAILABLE", details: null });
  assert.equal(store.objects.size, 1);
}));
