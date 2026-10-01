import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import pg from "pg";
import { createServer } from "vite";
import { applyPostgresMigrations, readPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { applyStockAndStagedMigrations, listStagedMigrations } from "./staged-migrations-harness.mjs";
import * as contributionEnvelopeSeam from "../cloud-run/contribution-envelope-registry.mjs";
import {
  createContributionEnvelopeRegistry,
  createUploadAuthorizationFormats,
} from "../cloud-run/contribution-envelope-registry.mjs";
import { createOriginRouteModuleRegistry } from "../cloud-run/origin-route-modules.mjs";
import { createPostgresTestV12DayManifestDispatch } from "../cloud-run/postgres-test-dispatch.mjs";
import { validateTelemetryV12Envelope } from "@app-usagemonitor/telemetry-contract";
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
import {
  TELEMETRY_V01_ENVELOPE_SCHEMA_VERSION,
  createTelemetryV01ContributionEnvelope,
} from "../cloud-run/envelopes/v01.mjs";
import { createUploadAuthorizationRouteModule } from "../cloud-run/routes/upload-authorizations.mjs";

/*
 * IN-3: the telemetry-envelope-v1.0 contribution envelope and the legacy
 * upload-authorization formats on PostgreSQL 17, against a production-code
 * oracle.
 *
 * The oracle is the d43c8f92 Worker's own typed v1 admission
 * (src/typed-v1-admission.ts insertTypedTelemetryV1Chunk with
 * telemetry-v1-repository.ts) and transport policy, running unmodified on an
 * in-memory node:sqlite database built from the D1 migration directories the
 * live ingestion D1 applies. fixtures/legacy-contribution-oracle-blobs.json
 * pins every oracle file to its d43c8f92 git blob, so a drift in the GCP
 * line fails here instead of silently changing the oracle. The same holds
 * for telemetry-envelope-v0.1 (handleTelemetryContribution with
 * insertTelemetryContribution and its server repricing), which d43c8f92 has
 * not retired.
 *
 * Every upload is authorized through the IN-3 upload-authorization route
 * module (shipped v1.0 clients send three body keys) and runs through the
 * envelope registry: a spec-local stand-in for the landed IN-1b
 * contributions preamble claims the one-use authorization, enforces the
 * transport floor, dispatches on body.schemaVersion with the landed context
 * keys, then records the receipt (or abandons the claim). Where the landed
 * preamble exists (claude/gcp-fastpath), one case drives it for real. The
 * PostgreSQL rows are then compared, normalized to original identifiers,
 * with the rows the Worker's typed v1 admission writes for the same chunk,
 * ids and clock on D1. All data is synthetic and content-free.
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
 * Every file whose behaviour the oracle reproduces, relative to apps/worker:
 * the Worker sources and D1 migrations the oracle loads, and the
 * @app-usagemonitor package copies vite resolves for them (server repricing
 * and the telemetry contract). The fixture pins each to its git blob id at
 * d43c8f92, so equal ids mean the oracle runs production's exact code.
 */
const ORACLE_REQUIRED = Object.freeze([
  "src/typed-v1-admission.ts", "src/telemetry-v1-repository.ts", "src/typed-telemetry-repository.ts",
  "src/telemetry-v1.ts", "src/telemetry-transport-policy.ts", "src/telemetry-repository.ts",
  "src/telemetry-validation.ts", "src/server-pricing.ts", "src/device-auth.ts", "src/telemetry-storage-mode.ts",
  "migrations/0014_bounded_contribution_admission.sql",
  "typed-v1-admission-migrations/0001_typed_v1_chunk_admission.sql",
  "ingestion-isolation-migrations/0003_v1_append_classification.sql",
  "ingestion-isolation-migrations/0004_v1_multidevice_source_update.sql",
  "typed-ingestion-migrations/0001_typed_telemetry.sql", "typed-ingestion-migrations/0002_delivery_journal.sql",
  "node_modules/@app-usagemonitor/accounting/src/price-registry.js",
  "node_modules/@app-usagemonitor/telemetry-contract/index.js",
]);

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
        const results = statements.map((entry) => {
          const values = entry.values.map(toSqlite);
          if (/\bRETURNING\b/iu.test(entry.sql) || /^\s*(SELECT|WITH)\b/iu.test(entry.sql)) {
            return { success: true, meta: {},
              results: database.prepare(entry.sql).all(...values).map(fromSqlite) };
          }
          const run = database.prepare(entry.sql).run(...values);
          return { success: true, meta: { changes: Number(run.changes) }, results: [] };
        });
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

/** The IN-3 migration by name suffix, staged or promoted (plan-v5 numbering rule). */
async function legacyAdmissionMigration() {
  const suffix = "_legacy_contribution_admission.sql";
  const names = [
    ...(await listStagedMigrations("primary")).map((migration) => migration.name),
    ...(await readPostgresMigrations({ role: "primary" })).map((migration) => migration.name),
  ].filter((name) => name.endsWith(suffix));
  assert.equal(names.length, 1, "exactly one legacy_contribution_admission migration, staged or promoted");
  return names[0];
}

async function withTwin(operation, { ledger = false } = {}) {
  const local = await endpoint();
  const schema = `in3_legacy_${randomBytes(6).toString("hex")}`;
  let ledgerCreated = false;
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
    await applyStockAndStagedMigrations({
      role: "primary", schema, pool, stagedFiles: [await legacyAdmissionMigration()],
    });
    if (ledger) {
      await pool.query(`CREATE SCHEMA "${schema}_ledger"`);
      ledgerCreated = true;
      await applyPostgresMigrations({ role: "ledger", schema: `${schema}_ledger`, pool });
    }
    return await operation({ twin: new Twin(d1, pool), pool, schema, d1 });
  } finally {
    if (ledgerCreated) await pool.query(`DROP SCHEMA IF EXISTS "${schema}_ledger" CASCADE`).catch(() => {});
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

/** The Worker's device secret hash, so a known bearer authenticates (device-auth.ts). */
function deviceSecretHash(deviceId, secret) {
  return createHash("sha256").update(`app-usagemonitor/device/v1\0${deviceId}\0`)
    .update(Buffer.from(secret, "base64url")).digest();
}

async function socialDevice(twin, participantId, deviceId, { consent = true, secret } = {}) {
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
    [deviceId, participantId, pairing, secret === undefined ? bytes32() : deviceSecretHash(deviceId, secret), now,
      iso(30 * DAY_MS), now, now],
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

async function encryptedEnvelope(plaintext, schemaVersion = TELEMETRY_V10_ENVELOPE_SCHEMA_VERSION) {
  const { encodeBase64Url } = await workerModule("/src/crypto.ts");
  const { canonicalJson } = await workerModule("/src/canonical-json.ts");
  const { publicJwk } = await envelopeKeys();
  const rsa = await crypto.subtle.importKey("jwk", publicJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    return {
      schemaVersion, synthetic: false, keyId: KEY_ID,
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

/** An in-memory object store; beforePut runs between the pre-write checks and the persist. */
function memoryObjectStore({ beforePut } = {}) {
  const objects = new Map();
  return {
    objects,
    async put(key, value, options) {
      objects.set(key, { value: String(value), options });
      if (beforePut) await beforePut(key);
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

function outcomeOf(error) {
  return { status: error?.status, code: error?.code, details: error?.publicDetails ?? null };
}

const ORIGIN = "http://127.0.0.1:43933";
const UPLOAD_AUTHORIZATIONS_PATH = "/api/v1/device/upload-authorizations";
const V12_UPLOAD_FORMAT = "telemetry-contribution-v1.2";

/** The upload-registration and processing controls a live origin runs with. */
async function enableCollection(pool, schema) {
  await pool.query(`UPDATE "${schema}".collection_controls
      SET revision = 2, control_state = 'operational', enrollment_enabled = true,
          upload_registration_enabled = true, processing_enabled = true, publication_enabled = true,
          updated_at = $1
    WHERE singleton = 1`, [iso()]);
}

/** A device bearer the spec's authenticateDevice stand-in resolves. */
const bearerOf = (device) => `Device um_device_${device.deviceId}.synthetic`;

/** A refusal rendered by the origin, as the closed error a caller sees. */
async function refusalOf(response) {
  const body = await response.json();
  return Object.assign(new Error(body.error.code), {
    status: response.status, code: body.error.code, publicDetails: body.error.details ?? null,
    responseHeaders: Object.fromEntries(response.headers), body,
  });
}

/**
 * The origin wiring the composition root mounts for IN-3: the legacy formats
 * next to v1.2, the upload-authorization route module that replaces the
 * built-in route, the registry with the v1.0 and v0.1 entries, and a
 * contributions preamble. The preamble is a stand-in for
 * postgres-test-dispatch.mjs on claude/gcp-fastpath: it hands the handler
 * the same body ({ bytes, raw, value }) and context keys, records the
 * receipt the same way (500 INTERNAL_ERROR without a contributionId) and
 * abandons the claim on the same conditions. "PG17 ... through the landed
 * origin dispatch" below drives the real dispatch where it exists. The
 * route module's device-bearer and tombstone steps are stand-ins; its body
 * rules, format table, controls and authorization writes are real.
 */
async function origin(pool, schemaOptions, objectStore) {
  const authority = await workerModule("/src/postgres-transport-write-authority.ts");
  const admission = await workerModule("/src/postgres-legacy-contribution-admission.ts");
  const transport = await workerModule("/src/postgres-typed-v12-transport.ts");
  const uploads = await workerModule("/src/postgres-upload-authorization.ts");
  const controls = await workerModule("/src/postgres-collection-controls.ts");
  const { readBoundedRequestBody } = await workerModule("/src/bounded-body.ts");
  const keys = await envelopeKeys();
  await enableCollection(pool, schemaOptions.primarySchema);
  const legacyFormats = legacyUploadAuthorizationFormatEntries({
    assertTelemetryTransportWriteAllowed: authority.assertPostgresTelemetryTransportWriteAllowed,
    schemaVersions: [...LEGACY_V1_UPLOAD_AUTHORIZATION_SCHEMA_VERSIONS, ...RETAINED_V0_UPLOAD_AUTHORIZATION_SCHEMA_VERSIONS],
  });
  // The origin's whole table: v1.2 as postgres-test-dispatch.mjs registers it, plus IN-3's.
  const formats = createUploadAuthorizationFormats(new Map([
    [V12_UPLOAD_FORMAT, {
      assertUploadAllowed: (formatPool, device, nowEpoch, { schema }) =>
        authority.assertPostgresTelemetryTransportWriteAllowed(formatPool, device, V12_UPLOAD_FORMAT, { nowEpoch, schema }),
    }],
    ...Object.entries(legacyFormats),
  ]));
  const registry = createContributionEnvelopeRegistry([
    createTelemetryV10ContributionEnvelope({
      admitTelemetryV1Contribution: admission.admitPostgresTelemetryV1Contribution,
    }),
    createTelemetryV01ContributionEnvelope({
      admitTelemetryV01Contribution: admission.admitPostgresTelemetryV01Contribution,
    }),
  ]);
  const devices = new Map();
  const steps = [];
  const uploadAuthorizations = createUploadAuthorizationRouteModule({
    primaryPool: pool, ledgerPool: pool, schema: schemaOptions, maxRequestBytes: MAX_REQUEST_BYTES,
    admissionEnv: Object.freeze({ synthetic: true }), formats,
    assertStorageCurrent: async () => { steps.push("storage"); },
    assertAdmissionBindings: () => { steps.push("admission"); },
    assertUploadAuthorizationBindings: () => { steps.push("upload-bindings"); },
    assertUploadAuthorizationAllowed: async () => { steps.push("rate-limit"); },
    assertUploadRegistrationEnabled: (controlPool, primarySchema) => {
      steps.push("upload-registration");
      return controls.assertPostgresCollectionControlFromPool(controlPool, primarySchema, "uploadRegistration");
    },
    authenticateDevice: async (_pool, header) => {
      steps.push("device");
      const device = devices.get(header);
      if (!device) throw Object.assign(new Error("DEVICE_AUTH_INVALID"), { code: "DEVICE_AUTH_INVALID", status: 401 });
      return device;
    },
    hasDeletionTombstone: async () => { steps.push("tombstone"); return false; },
    readBoundedRequestBody,
    createDeviceUploadAuthorization: uploads.createPostgresDeviceUploadAuthorization,
  });

  /** POST /api/v1/device/upload-authorizations through the route module. */
  async function authorizeUploadResponse(device, body, { headers = {}, search = "", raw } = {}) {
    devices.set(bearerOf(device), device);
    return uploadAuthorizations.handler(new Request(`${ORIGIN}${UPLOAD_AUTHORIZATIONS_PATH}${search}`, {
      method: "POST",
      headers: { authorization: bearerOf(device), "content-type": "application/json", ...headers },
      body: raw ?? JSON.stringify(body),
    }), Object.freeze({ origin: ORIGIN, hostMode: "fastpath-test" }));
  }

  async function authorizeUpload(device, body, options) {
    const response = await authorizeUploadResponse(device, body, options);
    if (response.status !== 201) throw await refusalOf(response);
    return response.json();
  }

  /** POST /api/v1/contributions: a stand-in for the landed IN-1b preamble. */
  async function contribute(upload, raw, { store = objectStore } = {}) {
    const bytes = new TextEncoder().encode(raw);
    const value = JSON.parse(raw);
    const envelopeDigest = sha256Hex(raw);
    const claim = await transport.claimPostgresDeviceUploadAuthorization(pool, `Upload ${upload}`, {
      envelopeDigest, bodyBytes: bytes.byteLength, contentType: "application/json",
    }, { schema: schemaOptions });
    const participantRow = (await pool.query(
      `SELECT id, consent_version, owner_kind FROM "${schemaOptions.primarySchema}".participants WHERE id = $1`,
      [claim.participantId])).rows[0];
    const deviceId = (await pool.query(
      `SELECT issued_by_device_id FROM "${schemaOptions.primarySchema}".device_upload_authorizations WHERE id = $1`,
      [claim.authorizationId])).rows[0].issued_by_device_id;
    const principal = Object.freeze({ participantId: claim.participantId, deviceId });
    let persistStarted = false;
    let handlerReturned = false;
    try {
      const handler = registry.resolve(value.schemaVersion);
      assert.ok(handler, "the envelope version is registered");
      await formats.resolve(value.schemaVersion.replace("telemetry-envelope-", "telemetry-contribution-"))
        .assertUploadAllowed(pool, principal, Date.now(), { schema: schemaOptions });
      const response = await handler(Object.freeze({ bytes, raw, value }),
        Object.freeze({ id: participantRow.id, consentVersion: participantRow.consent_version,
          ownerKind: participantRow.owner_kind }),
        deviceId, claim, Object.freeze({
          primaryPool: pool, ledgerPool: pool, objectStore: store,
          envelopePublicJwk: keys.publicText, envelopePrivateJwk: keys.privateText, sourceNamespace: NAMESPACE,
          request: new Request(`${ORIGIN}/api/v1/contributions`, { method: "POST" }),
          envelopeDigest, bodyBytes: bytes.byteLength, contentType: "application/json", principal,
          schema: schemaOptions, markPersistStarted() { persistStarted = true; },
        }));
      handlerReturned = true;
      let receipt;
      try { receipt = await response.clone().json(); } catch { /* no JSON receipt */ }
      if (typeof receipt?.contributionId !== "string") {
        throw Object.assign(new Error("INTERNAL_ERROR"), { code: "INTERNAL_ERROR", status: 500 });
      }
      await admission.recordPostgresDeviceUploadReceipt(pool, claim.authorizationId, receipt.contributionId,
        { schema: schemaOptions });
      return { response, receipt, claim };
    } catch (error) {
      if (!persistStarted || handlerReturned) {
        await transport.abandonPostgresDeviceUploadAuthorization(pool, claim, principal, { schema: schemaOptions })
          .catch(() => {});
      }
      throw error;
    }
  }

  /** A v1.0 upload as the shipped d43c8f92 sync engine sends it: three authorization keys. */
  async function upload(device, chunk, { envelope, raw: rawEnvelope, store } = {}) {
    const raw = rawEnvelope ?? JSON.stringify(envelope ?? await encryptedEnvelope(chunk));
    const authorization = await authorizeUpload(device, {
      envelopeDigest: sha256Hex(raw), contentLengthBytes: Buffer.byteLength(raw), contentType: "application/json",
    });
    return { raw, ...await contribute(authorization.uploadAuthorization, raw, store ? { store } : {}) };
  }

  async function uploadV01(device, record, { envelope, raw: rawEnvelope, store } = {}) {
    const raw = rawEnvelope
      ?? JSON.stringify(envelope ?? await encryptedEnvelope(record, TELEMETRY_V01_ENVELOPE_SCHEMA_VERSION));
    const authorization = await authorizeUpload(device, {
      envelopeDigest: sha256Hex(raw), contentLengthBytes: Buffer.byteLength(raw), contentType: "application/json",
      telemetrySchemaVersion: "telemetry-contribution-v0.1",
    });
    return { raw, ...await contribute(authorization.uploadAuthorization, raw, store ? { store } : {}) };
  }

  return {
    formats, registry, uploadAuthorizations, steps, authorizeUploadResponse, authorizeUpload, contribute, upload,
    uploadV01, admission,
  };
}

/** The Worker's typed v1 admission for the same chunk, ids and clock, on D1. */
async function oracleAdmission(twin, schema, chunkRowId, chunk, raw, supersedesId = null) {
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
    envelopeDigest: await telemetryEnvelopeDigest(envelope), chunk: parsed,
    supersedes: supersedesId === null ? null
      : fromSqlite(twin.d1.prepare("SELECT * FROM telemetry_v1_chunks WHERE id = ?").get(supersedesId)),
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
        device_upload_authorization_id,
        to_char(superseded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS superseded_at,
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
  for (const path of ORACLE_REQUIRED) assert.ok(Object.hasOwn(pinned.sources, path), `${path} is pinned`);
  for (const [path, { production, blob }] of Object.entries(pinned.sources)) {
    assert.ok(production === `apps/worker/${path}` || production.startsWith("packages/"), path);
    assert.equal(gitBlobId(await readFile(join(WORKER_ROOT, path))), blob, `${path} equals d43c8f92:${production}`);
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
  // The route module's rendered refusal is the Worker's errorResponse body.
  const raw = JSON.stringify({ synthetic: true });
  for (const [body, status, code] of [
    [{ envelopeDigest: sha256Hex(raw), contentLengthBytes: MAX_REQUEST_BYTES + 1, contentType: "application/json",
      telemetrySchemaVersion: "telemetry-contribution-v1.0" }, 400, "BODY_INVALID"],
    [{ envelopeDigest: sha256Hex(raw), contentLengthBytes: 10, contentType: "application/json",
      telemetrySchemaVersion: "telemetry-contribution-v1.1" }, 403, "TELEMETRY_CONSENT_INVALID"],
    [{ envelopeDigest: sha256Hex(raw), contentLengthBytes: 10, contentType: "application/json",
      telemetrySchemaVersion: "telemetry-contribution-v1.3" }, 403, "TELEMETRY_TRANSPORT_BLOCKED"],
  ]) {
    let refusal;
    await assert.rejects(service.authorizeUpload(device, body), (error) => {
      refusal = error;
      return true;
    });
    const expected = errorResponse(new ApiError(status, code), "request-synthetic");
    assert.equal(refusal.status, expected.status);
    assert.match(refusal.body.error.requestId, /^[0-9a-f-]{36}$/u);
    assert.deepEqual({ ...refusal.body, error: { ...refusal.body.error, requestId: "request-synthetic" } },
      await expected.json());
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

test("PG17 a v1.0 correction supersedes the current chunk with the d43c8f92 rows, and replays answer both revisions", {
  skip: SKIP, timeout: 300_000,
}, () => withTwin(async ({ twin, pool, schema }) => {
  const { schemaOptions } = await initializeTypedTargets(twin, schema);
  const store = memoryObjectStore();
  const service = await origin(pool, schemaOptions, store);
  await socialParticipant(twin, "in3-correct");
  const device = await socialDevice(twin, "in3-correct", randomUUID());
  const ids = {};
  for (const [stream, count] of [["usage", 2], ["quota", 1]]) {
    const chunk = await syntheticChunk({ stream, count, seed: "first" });
    const result = await service.upload(device, chunk);
    assert.equal(result.response.status, 202);
    await oracleAdmission(twin, schema, result.receipt.contributionId, chunk, result.raw);
    ids[stream] = { first: result, chunk };
  }
  for (const [stream, count] of [["usage", 3], ["quota", 1]]) {
    const chunk = await syntheticChunk({ stream, count, seed: "second", revision: 2 });
    const result = await service.upload(device, chunk);
    assert.equal(result.response.status, 202);
    assert.deepEqual({ ...result.receipt, contributionId: "<id>", admission: "<admission>" }, {
      schemaVersion: "telemetry-chunk-receipt-v1.0", contributionId: "<id>", chunkId: chunk.chunkId, chunkRevision: 2,
      status: "accepted", supersededRevision: 1, recordCounts: { declared: count, accepted: count },
      acknowledgedThroughDay: day(), admission: "<admission>",
    });
    await oracleAdmission(twin, schema, result.receipt.contributionId, chunk, result.raw,
      ids[stream].first.receipt.contributionId);
    ids[stream].second = { ...result, chunk };
  }
  const rows = await snapshot(twin, schema, "in3-correct");
  for (const key of Object.keys(rows.d1)) {
    assert.deepEqual(rows.pg[key], rows.d1[key], `${key} matches the d43c8f92 typed-v1 correction`);
  }
  assert.equal(rows.pg.typedRecords.length, 4, "only the current revisions keep typed rows");
  assert.equal(rows.pg.chunkHeaders.filter((row) => row.superseded_at !== null).length, 2);
  assert.deepEqual(rows.pg.events.map((event) => event.kind),
    ["owner-active", "source-updated", "owner-active", "owner-active"]);

  // The superseded envelope replays as superseded; the current content as accepted.
  const old = await service.upload(device, null, { envelope: JSON.parse(ids.usage.first.raw) });
  assert.equal(old.response.status, 202);
  assert.deepEqual(old.receipt, {
    schemaVersion: "telemetry-chunk-receipt-v1.0", contributionId: ids.usage.first.receipt.contributionId,
    chunkId: ids.usage.chunk.chunkId, chunkRevision: 1, status: "superseded", replayed: true,
    recordCounts: { declared: 2, accepted: 2 }, acknowledgedThroughDay: day(),
  });
  const current = await service.upload(device, ids.usage.second.chunk);
  assert.equal(current.receipt.contributionId, ids.usage.second.receipt.contributionId);
  assert.equal(current.receipt.status, "accepted");
  assert.equal(current.receipt.replayed, true);
  // A skipped revision still conflicts.
  await assert.rejects(service.upload(device, await syntheticChunk({ stream: "usage", count: 1, seed: "skip", revision: 4 })),
    (error) => error.status === 409 && error.code === "CHUNK_REVISION_CONFLICT");

  // The retention allowance is exactly superseded format-10 rows: a current
  // chunk's typed rows still need the erasure proof.
  const currentTyped = await pool.query(`SELECT c.id FROM "${schema}".typed_telemetry_chunks c
    JOIN "${schema}".typed_v1_chunk_allocations a ON a.chunk_original = c.original_id
    WHERE a.chunk_id = $1`, [ids.quota.second.receipt.contributionId]);
  assert.equal(currentTyped.rows.length, 1);
  await assert.rejects(pool.query(`DELETE FROM "${schema}".typed_telemetry_chunks WHERE id = $1`,
    [currentTyped.rows[0].id]), (error) => error.code === "P1005" && error.message === "typed_telemetry_source_retained");
  await assert.rejects(pool.query(`DELETE FROM "${schema}".typed_telemetry_records WHERE chunk_id = $1`,
    [currentTyped.rows[0].id]), (error) => error.code === "P1005" && error.message === "typed_telemetry_source_retained");
  assert.equal(store.objects.size, 4);
}));

test("PG17 two concurrent uploads of one v1.0 envelope converge on one chunk and retire the losing object", {
  skip: SKIP, timeout: 300_000,
}, () => withTwin(async ({ twin, pool, schema }) => {
  const { schemaOptions } = await initializeTypedTargets(twin, schema);
  const store = memoryObjectStore();
  const service = await origin(pool, schemaOptions, store);
  await socialParticipant(twin, "in3-race");
  const device = await socialDevice(twin, "in3-race", randomUUID());
  const chunk = await syntheticChunk({ stream: "quota", count: 1, seed: "race" });
  const raw = JSON.stringify(await encryptedEnvelope(chunk));
  const body = { envelopeDigest: sha256Hex(raw), contentLengthBytes: Buffer.byteLength(raw),
    contentType: "application/json", telemetrySchemaVersion: "telemetry-contribution-v1.0" };
  const grants = [await service.authorizeUpload(device, body), await service.authorizeUpload(device, body)];
  const results = await Promise.all(grants.map((grant) => service.contribute(grant.uploadAuthorization, raw)));
  assert.deepEqual(results.map((result) => result.response.status), [202, 202]);
  const ids = new Set(results.map((result) => result.receipt.contributionId));
  assert.equal(ids.size, 1, "both requests acknowledge the one committed chunk");
  assert.deepEqual(results.map((result) => result.receipt.replayed === true).sort(), [false, true]);
  const rows = await pool.query(`SELECT (SELECT count(*)::int FROM "${schema}".telemetry_v1_chunks) AS chunks,
    (SELECT count(*)::int FROM "${schema}".typed_telemetry_records) AS records,
    (SELECT count(*)::int FROM "${schema}".storage_ingestion_changes) AS journal,
    (SELECT count(*)::int FROM "${schema}".pending_objects) AS pending,
    (SELECT count(*)::int FROM "${schema}".device_upload_authorizations
      WHERE state = 'consumed' AND consumed_contribution_id = $1) AS consumed`, [[...ids][0]]);
  assert.deepEqual(rows.rows[0], { chunks: 1, records: 1, journal: 1, pending: 1, consumed: 2 });
  assert.equal(store.objects.size, 1, "the losing request's object is retired");
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

  // A usage correction while the imported correction runtime was active is
  // the documented gap: refused before any write (D1 would record facts).
  const first = await service.upload(device, await syntheticChunk({ count: 1, seed: "correct" }));
  assert.equal(first.response.status, 202);
  await pool.query(`INSERT INTO "${schema}".telemetry_usage_correction_runtime
      (id, schema_version, method_version, source_state, max_capture_rows, max_history_page)
    VALUES (1, 'telemetry-usage-correction-v1', 'usage-total-correction-v1', 'active', 200, 200)`);
  const correction = await syntheticChunk({ count: 2, seed: "correct-2", revision: 2 });
  assert.deepEqual(await refused(device, correction), { status: 503, code: "BACKEND_STORAGE_UNAVAILABLE", details: null });
  assert.deepEqual(await counts(), { chunks: 1, records: 1, pending: 1, abandoned: 8, other: 1 });
  assert.equal(store.objects.size, 1);

  // An explicit-id import that left a typed identity behind its rows (TL-1)
  // refuses live allocation until the identities are restarted.
  const nsId = (await pool.query(`SELECT namespace_id FROM "${schema}".typed_v1_admission_state`)).rows[0].namespace_id;
  await pool.query(`INSERT INTO "${schema}".typed_telemetry_owners (id, namespace_id, original_id)
    VALUES (5000, $1, $2)`, [nsId, Buffer.from("\u0000synthetic-imported-owner")]);
  const lagging = await syntheticChunk({ stream: "session", seed: "lagging" });
  assert.deepEqual(await refused(device, lagging), { status: 503, code: "BACKEND_STORAGE_UNAVAILABLE", details: null });
  assert.deepEqual(await counts(), { chunks: 1, records: 1, pending: 1, abandoned: 9, other: 1 });
  await pool.query(`SELECT "${schema}".typed_telemetry_restart_identities()`);
  const resumed = await service.upload(device, lagging);
  assert.equal(resumed.response.status, 202);
  assert.equal(store.objects.size, 2);

  // An unpinned typed target refuses before decrypting or writing.
  await pool.query(`UPDATE "${schema}".typed_v1_admission_state SET runtime_contract_version = 0 WHERE id = 1`);
  assert.deepEqual(await refused(device, await syntheticChunk({ seq: 4, seed: "unpinned" })),
    { status: 503, code: "BACKEND_STORAGE_UNAVAILABLE", details: null });
  assert.equal(store.objects.size, 2);
}));

// ---------------------------------------------------------------------------
// telemetry-envelope-v0.1 (not retired at d43c8f92; see envelopes/v01.mjs).

function v01Contribution(suffix = "a") {
  const toolClassCounts = {
    webSearch: 1, fileSearch: 0, codeInterpreter: 0, hostedShell: 0, computerUse: 0, mcp: 0,
    applyPatch: 1, localShell: 2, subagent: 0, toolGateway: 1, other: 0, unknown: 0,
  };
  return {
    schemaVersion: "telemetry-contribution-v0.1", synthetic: false, createdAt: "2026-07-25T13:00:00.000Z",
    coveredAt: { startAt: "2026-07-25T12:00:00.000Z", endAt: "2026-07-25T12:30:00.000Z" },
    clientPlatform: "macos", providerPolicyEpoch: "openai_agentic_pool_2026_07_09",
    usageEvents: [{
      schemaVersion: "usage-event-v0.1", eventTime: "2026-07-25T12:05:00.000Z", provider: "openai_codex",
      modelId: "gpt-5.6-sol", modelRecognition: "recognized", modelFingerprint: null,
      billingSurface: "chatgpt_subscription", speedMode: "fast", apiServiceTier: "priority", reasoningEffort: "xhigh",
      components: {
        inputUncachedTokens: 100, inputCacheReadTokens: 900, inputCacheWriteTokens: 0, inputCacheWrite5mTokens: null,
        inputCacheWrite1hTokens: null, outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: null,
      },
      totalInputContextTokens: 1000, surface: "local_interactive_unclassified", agentScope: "root",
      lineageDisposition: "standalone", toolClassCounts, outcome: "completed", eventId: `event:v2:${suffix.repeat(64)}`,
      accounting: { estimatedApiCostUsd: "1.000000", pricingCoveragePercent: 100, unknownBillableUnits: 0,
        priceBasis: "current_api_prices" },
    }],
    quotaSnapshots: [{
      schemaVersion: "quota-snapshot-v0.1", observedTime: "2026-07-25T12:10:00.000Z",
      receivedTime: "2026-07-25T12:10:01.000Z", provider: "openai_codex", planType: "pro", planVariant: "pro-20x",
      limitId: "codex", slot: "seven_day", usedPercent: 31, displayPrecision: 0, windowDurationMinutes: 10080,
      resetsAt: "2026-07-31T12:00:00.000Z", snapshotSource: "rollout", providerSurface: "account_shared_unallocated",
      snapshotId: `snapshot:v2:${suffix.repeat(64)}`,
    }],
    activityMarkers: [],
    accounting: { estimatedApiCostUsd: "1.000000", pricedEventCoveragePercent: 100, unknownModelEventCount: 0,
      unknownBillableUnits: 0, priceBasis: "current_api_prices" },
  };
}

/** The Worker's insertTelemetryContribution for the same ids and clock, on D1. */
async function oracleV01Admission(twin, schema, contributionId, raw) {
  const { insertTelemetryContribution, telemetryEnvelopeDigest, telemetryPlaintextDigest } =
    await workerModule("/src/telemetry-repository.ts");
  const { validateTelemetryContribution, validateTelemetryEnvelope } = await workerModule("/src/telemetry-validation.ts");
  const { decryptSyntheticEnvelope } = await workerModule("/src/crypto.ts");
  const keys = await envelopeKeys();
  const row = (await twin.pgOnly(
    `SELECT c.*, to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_iso,
            a.issued_by_device_id FROM "${schema}".telemetry_contributions c
       JOIN "${schema}".device_upload_authorizations a ON a.id = c.device_upload_authorization_id
      WHERE c.id = ?`, [contributionId])).rows[0];
  assert.ok(row, "PostgreSQL committed the contribution");
  const expires = new Date(Date.now() + 5 * 60_000).toISOString();
  twin.d1Only(
    `INSERT INTO device_upload_authorizations (id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
       body_bytes, content_type, state, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'application/json', 'unused', ?, ?)`,
    [row.device_upload_authorization_id, row.participant_id, row.issued_by_device_id, bytes32(), sha256Hex(raw),
      Buffer.byteLength(raw), new Date(Date.parse(row.created_iso) - 1_000).toISOString(), expires]);
  twin.d1Only("UPDATE device_upload_authorizations SET state = 'consuming', consume_lease_expires_at = ? WHERE id = ?",
    [expires, row.device_upload_authorization_id]);
  const envelope = validateTelemetryEnvelope(JSON.parse(raw));
  const record = validateTelemetryContribution(
    await decryptSyntheticEnvelope(envelope, keys.publicText, keys.privateText));
  const envelopeDigest = await telemetryEnvelopeDigest(envelope);
  const plaintextDigest = await telemetryPlaintextDigest(record);
  assert.equal(row.envelope_digest, envelopeDigest);
  assert.equal(row.plaintext_digest, plaintextDigest);
  return insertTelemetryContribution(d1Database(twin.d1), row.participant_id,
    { authorizationId: row.device_upload_authorization_id, authorizationKind: "device" },
    contributionId, row.r2_key, envelopeDigest, plaintextDigest, record, row.created_iso);
}

const V01_TIMESTAMPS = new Set(["range_start", "range_end", "created_at", "dataset_range_start", "dataset_range_end",
  "quarantine_deleted_at", "server_price_event_time_start", "server_price_event_time_end", "observed_at", "resets_at",
  "server_price_event_time", "window_started_at", "last_accepted_at"]);
const V01_JSON = new Set(["record_json", "server_price_card_ids", "server_unpriced_reason_codes"]);
const V01_NUMBERS = new Set(["estimated_api_cost_usd", "priced_event_coverage_percent", "server_cost_usd",
  "server_cost_nanousd", "used_percent", "pricing_coverage_percent", "server_pricing_coverage_percent",
  "input_uncached_tokens", "input_cache_read_tokens", "input_cache_write_tokens", "output_text_tokens",
  "output_reasoning_tokens", "output_combined_tokens", "tool_units", "total_input_context_tokens"]);

async function v01Snapshot(twin, schema, participantId) {
  const { canonicalJson } = await workerModule("/src/canonical-json.ts");
  const normalize = (row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "id" || !("record_kind" in row))
    .map(([key, value]) => {
      if (value === null || value === undefined) return [key, null];
      if (value instanceof Date) return [key, value.toISOString()];
      if (V01_TIMESTAMPS.has(key)) return [key, new Date(value).toISOString()];
      if (V01_JSON.has(key)) return [key, canonicalJson(typeof value === "string" ? JSON.parse(value) : value)];
      if (V01_NUMBERS.has(key)) return [key, Number(value)];
      return [key, value];
    }));
  const s = `"${schema}".`;
  const pg = async (sql) => (await twin.pool.query(sql, [participantId])).rows.map(normalize);
  const d1 = (sql) => twin.d1.prepare(sql).all(participantId).map((row) => normalize({ ...row }));
  const columns = (table) => twin.d1.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name)
    .filter((name) => name !== "id" || table === "telemetry_contributions");
  const list = (table) => columns(table).join(", ");
  return {
    pg: {
      contributions: await pg(`SELECT ${list("telemetry_contributions")} FROM ${s}telemetry_contributions
        WHERE participant_id = $1 ORDER BY id`),
      records: await pg(`SELECT ${list("telemetry_records")} FROM ${s}telemetry_records
        WHERE participant_id = $1 ORDER BY record_kind, occurrence_id`),
      occurrences: await pg(`SELECT ${list("telemetry_contribution_occurrences")}
        FROM ${s}telemetry_contribution_occurrences WHERE participant_id = $1 ORDER BY contribution_id, record_kind, occurrence_id`),
      windows: await pg(`SELECT ${list("telemetry_contribution_admission_windows")}
        FROM ${s}telemetry_contribution_admission_windows WHERE participant_id = $1 ORDER BY window_started_at`),
      grants: await pg(`SELECT id, state, consumed_contribution_id, consume_lease_expires_at IS NULL AS lease_cleared
        FROM ${s}device_upload_authorizations WHERE participant_id = $1
         AND id IN (SELECT device_upload_authorization_id FROM ${s}telemetry_contributions) ORDER BY id`),
    },
    d1: {
      contributions: d1(`SELECT ${list("telemetry_contributions")} FROM telemetry_contributions
        WHERE participant_id = ? ORDER BY id`),
      records: d1(`SELECT ${list("telemetry_records")} FROM telemetry_records
        WHERE participant_id = ? ORDER BY record_kind, occurrence_id`),
      occurrences: d1(`SELECT ${list("telemetry_contribution_occurrences")}
        FROM telemetry_contribution_occurrences WHERE participant_id = ? ORDER BY contribution_id, record_kind, occurrence_id`),
      windows: d1(`SELECT ${list("telemetry_contribution_admission_windows")}
        FROM telemetry_contribution_admission_windows WHERE participant_id = ? ORDER BY window_started_at`),
      grants: d1(`SELECT id, state, consumed_contribution_id, consume_lease_expires_at IS NULL AS lease_cleared
        FROM device_upload_authorizations WHERE participant_id = ?
         AND id IN (SELECT device_upload_authorization_id FROM telemetry_contributions) ORDER BY id`)
        .map((row) => ({ ...row, lease_cleared: Boolean(row.lease_cleared) })),
    },
  };
}

test("PG17 a v0.1 contribution is admitted through the registry with the d43c8f92 rows, repriced, and replays idempotently", {
  skip: SKIP, timeout: 300_000,
}, () => withTwin(async ({ twin, pool, schema }) => {
  const { schemaOptions } = await initializeTypedTargets(twin, schema);
  const store = memoryObjectStore();
  const service = await origin(pool, schemaOptions, store);
  await socialParticipant(twin, "in3-v01");
  const device = await socialDevice(twin, "in3-v01", randomUUID(), { consent: false });

  const first = await service.uploadV01(device, v01Contribution("a"));
  assert.equal(first.response.status, 202);
  assert.deepEqual({ ...first.receipt, contributionId: "<id>" }, {
    contributionId: "<id>", status: "accepted",
    recordCounts: { usageEvents: 1, quotaSnapshots: 1, activityMarkers: 0, accepted: 2, deduplicated: 0 },
    accountingVerification: "server_repriced",
  });
  assert.match(first.receipt.contributionId, /^contribution:[0-9a-f-]{36}$/u);
  assert.deepEqual(await oracleV01Admission(twin, schema, first.receipt.contributionId, first.raw),
    { acceptedRecords: 2, deduplicatedRecords: 0 });
  // A second contribution re-sends the usage event (the client's replay
  // overlap) and adds a new snapshot: one record is deduplicated, as on D1.
  const overlap = v01Contribution("b");
  overlap.usageEvents = v01Contribution("a").usageEvents;
  const second = await service.uploadV01(device, overlap);
  assert.equal(second.response.status, 202);
  assert.deepEqual(second.receipt.recordCounts,
    { usageEvents: 1, quotaSnapshots: 1, activityMarkers: 0, accepted: 1, deduplicated: 1 });
  assert.deepEqual(await oracleV01Admission(twin, schema, second.receipt.contributionId, second.raw),
    { acceptedRecords: 1, deduplicatedRecords: 1 });

  const rows = await v01Snapshot(twin, schema, "in3-v01");
  for (const key of Object.keys(rows.d1)) {
    assert.deepEqual(rows.pg[key], rows.d1[key], `${key} matches the d43c8f92 v0.1 admission`);
  }
  assert.equal(rows.pg.contributions.length, 2);
  assert.equal(rows.pg.records.length, 3);
  assert.ok(rows.pg.records.some((row) => row.server_pricing_status !== null), "usage is server-repriced");
  assert.deepEqual(rows.pg.windows.map((row) => row.accepted_count), [2]);
  const pending = await pool.query(`SELECT count(*)::int AS n FROM "${schema}".pending_objects`);
  assert.equal(pending.rows[0].n, 0, "D1 clears the pending registration once the contribution references it");
  assert.equal(store.objects.size, 2);
  const object = store.objects.get(rows.pg.contributions.find((row) => row.id === first.receipt.contributionId).r2_key);
  assert.equal(object.value, JSON.stringify(JSON.parse(first.raw)));
  assert.deepEqual(object.options.customMetadata, { contributionId: first.receipt.contributionId,
    schemaVersion: "telemetry-envelope-v0.1", plaintextSchemaVersion: "telemetry-contribution-v0.1", synthetic: "false" });

  // Envelope and content replays answer the retained contribution.
  for (const replay of [
    await service.uploadV01(device, null, { envelope: JSON.parse(first.raw) }),
    await service.uploadV01(device, v01Contribution("a")),
  ]) {
    assert.equal(replay.response.status, 202);
    assert.equal(replay.response.headers.get("idempotency-replayed"), "true");
    assert.deepEqual(replay.receipt, {
      contributionId: first.receipt.contributionId, status: "accepted", replayed: true,
      recordCounts: { declared: 2, accepted: 2, deduplicated: 0 }, accountingVerification: "server_repriced",
    });
  }
  const after = await v01Snapshot(twin, schema, "in3-v01");
  assert.deepEqual(after.pg.contributions, rows.pg.contributions);
  assert.deepEqual(after.pg.records, rows.pg.records);
  assert.deepEqual(after.pg.windows, rows.pg.windows, "a replay takes no admission slot");
  assert.equal(store.objects.size, 2);
}));

test("PG17 v0.1 keeps the Worker's weekly window, consent and transport refusals", {
  skip: SKIP, timeout: 300_000,
}, () => withTwin(async ({ twin, pool, schema }) => {
  const { schemaOptions } = await initializeTypedTargets(twin, schema);
  const store = memoryObjectStore();
  const service = await origin(pool, schemaOptions, store);
  const repository = await workerModule("/src/telemetry-repository.ts");
  await socialParticipant(twin, "in3-v01-window");
  const device = await socialDevice(twin, "in3-v01-window", randomUUID(), { consent: false });
  const refused = async (principal, record) => {
    try {
      await service.uploadV01(principal, record);
    } catch (error) {
      return outcomeOf(error);
    }
    assert.fail("the upload was expected to be refused");
  };
  // A full window: both stores hold the same counter row.
  const window = repository.telemetryContributionAdmissionWindow(Date.now());
  await twin.run(`INSERT INTO telemetry_contribution_admission_windows (participant_id, window_started_at,
      accepted_count, last_accepted_at) VALUES (?, ?, 100, ?)`, ["in3-v01-window", window.startsAt, iso()]);
  const expected = await repository.telemetryContributionAdmission(d1Database(twin.d1), "in3-v01-window");
  const limit = await refused(device, v01Contribution("c"));
  assert.equal(limit.status, 429);
  assert.equal(limit.code, "CONTRIBUTION_LIMIT_REACHED");
  assert.deepEqual(limit.details, { admission: expected, retryAt: expected.window.endsAt });
  assert.equal(store.objects.size, 0);

  // The account-scoped consent is the deployed Worker's refusal.
  await socialParticipant(twin, "in3-v01-scoped", "privacy-safe-telemetry-v0.2");
  const scoped = { ...await socialDevice(twin, "in3-v01-scoped", randomUUID(), { consent: false }),
    participantConsentVersion: "privacy-safe-telemetry-v0.2" };
  assert.deepEqual(await refused(scoped, v01Contribution("d")),
    { status: 503, code: "ACCOUNT_SCOPED_INGEST_DISABLED", details: null });

  // A raised floor blocks v0.1 at authorization, as the Worker does.
  await socialParticipant(twin, "in3-v01-floor");
  const raised = await socialDevice(twin, "in3-v01-floor", randomUUID(), { consent: false });
  await twin.run("UPDATE telemetry_transport_formats SET lifecycle = 'accepted' WHERE schema_version = ?",
    ["telemetry-contribution-v1.1"]);
  await twin.run(`INSERT INTO telemetry_v11_device_consents (participant_id, device_id, telemetry_schema_version,
      field_dictionary_version, privacy_contract_version, consented_at)
    VALUES (?, ?, 'telemetry-contribution-v1.1', 'telemetry-v1.1-registry-2026-08-31.1',
      'ongoing-privacy-safe-telemetry-v1.1', ?)`, [raised.participantId, raised.deviceId, iso()]);
  assert.deepEqual(await refused(raised, v01Contribution("e")),
    { status: 403, code: "TELEMETRY_TRANSPORT_BLOCKED", details: null });
  const counts = await pool.query(`SELECT (SELECT count(*)::int FROM "${schema}".telemetry_contributions) AS contributions,
    (SELECT count(*)::int FROM "${schema}".pending_objects) AS pending`);
  assert.deepEqual(counts.rows[0], { contributions: 0, pending: 0 });
}));

test("PG17 the staged migration replaces the lifetime cap with D1's weekly window, backfilled as D1 0014", {
  skip: SKIP, timeout: 120_000,
}, async () => {
  const local = await endpoint();
  const schema = `in3_backfill_${randomBytes(6).toString("hex")}`;
  const pool = new pg.Pool({
    host: local.host, port: local.port, user: PG_TEST_USER, password: PG_TEST_PASSWORD, database: PG_TEST_DATABASE,
    ssl: false, max: 2, connectionTimeoutMillis: 5_000, application_name: "pg-legacy-contribution-backfill-test",
    options: `-c search_path=${schema},pg_catalog`,
  });
  let created = false;
  let stockRoot = null;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    // The stock migrations numbered below the legacy admission migration,
    // wherever it lives (staged today, promoted later), then pre-existing
    // contributions, then its SQL: the backfill runs over existing rows in
    // both states instead of being skipped once the file moves.
    const name = await legacyAdmissionMigration();
    const version = Number(name.slice(0, 4));
    const promotedDirectory = join(WORKER_ROOT, "postgres", "migrations", "primary");
    const promoted = (await readdir(promotedDirectory)).includes(name);
    const sql = await readFile(join(promoted ? promotedDirectory
      : join(WORKER_ROOT, "postgres", "staged-migrations", "primary"), name), "utf8");
    stockRoot = await mkdtemp(join(tmpdir(), "in3-backfill-"));
    await mkdir(join(stockRoot, "primary"));
    for (const file of await readdir(promotedDirectory)) {
      if (/^\d{4}_.+\.sql$/u.test(file) && Number(file.slice(0, 4)) < version) {
        await copyFile(join(promotedDirectory, file), join(stockRoot, "primary", file));
      }
    }
    await applyStockAndStagedMigrations({ role: "primary", schema, pool, stagedFiles: [], rootDirectory: stockRoot });
    await pool.query(`INSERT INTO "${schema}".participants (id, owner_kind, access_token_id, access_token_hash,
        recovery_token_id, recovery_token_hash, state, consent_version, consented_at, created_at)
      VALUES ('in3-history', 'social', 'access-in3-history', $1, 'recovery-in3-history', $2, 'active', $3, now(), now())`,
    [bytes32(), bytes32(), PARTICIPANT_CONSENT]);
    const created_at = ["2026-09-28T00:00:00.000Z", "2026-10-01T06:00:00.000Z", "2026-10-04T23:59:59.000Z",
      "2026-10-05T00:00:00.000Z"];
    for (const [index, at] of created_at.entries()) {
      await pool.query(`INSERT INTO "${schema}".telemetry_contributions (id, participant_id, plaintext_digest,
          envelope_digest, r2_key, status, schema_version, range_start, range_end, client_platform,
          provider_policy_epoch, priced_event_coverage_percent, unknown_model_event_count, unknown_billable_units,
          price_basis, declared_record_count, created_at)
        VALUES ($1, 'in3-history', $2, $3, $4, 'accepted', 'telemetry-contribution-v0.1', $5, $5, 'synthetic',
          'synthetic', 0, 0, 0, 'synthetic', 0, $5)`,
      [`contribution:history-${index}`, sha256Hex(`p${index}`), sha256Hex(`e${index}`), `synthetic/${index}`, at]);
    }
    const before = await pool.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_tables
      WHERE schemaname = $1 AND tablename = 'telemetry_contribution_admission_windows'`, [schema]);
    assert.equal(before.rows[0].n, 0, "the window table does not exist before the migration");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO "${schema}", pg_catalog`);
      await client.query(sql);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const windows = await pool.query(`SELECT window_started_at, accepted_count, last_accepted_at
      FROM "${schema}".telemetry_contribution_admission_windows ORDER BY window_started_at`);
    const repository = await workerModule("/src/telemetry-repository.ts");
    const startOf = (value) => repository.telemetryContributionAdmissionWindow(Date.parse(value)).startsAt;
    assert.deepEqual(windows.rows.map((row) => ({
      start: row.window_started_at.toISOString(), count: row.accepted_count, last: row.last_accepted_at.toISOString(),
    })), [
      { start: startOf(created_at[0]), count: 3, last: created_at[2] },
      { start: startOf(created_at[3]), count: 1, last: created_at[3] },
    ]);
    const triggers = await pool.query(`SELECT tgname FROM pg_catalog.pg_trigger
      WHERE tgrelid = '"${schema}".telemetry_contributions'::regclass AND NOT tgisinternal ORDER BY tgname`);
    const names = triggers.rows.map((row) => row.tgname);
    assert.ok(!names.includes("telemetry_contributions_participant_limit"), "the lifetime cap is gone");
    assert.ok(names.includes("telemetry_contributions_enforce_admission_window"));
    assert.ok(names.includes("telemetry_contributions_record_admission_window"));
    for (const at of ["2026-10-05T00:00:00Z", "2026-10-04T23:59:59.999Z", "2026-10-01T06:00:00Z", "1999-12-31T12:00:00Z"]) {
      const start = await pool.query(`SELECT "${schema}".telemetry_contribution_admission_window_start($1) AS start`, [at]);
      assert.equal(start.rows[0].start.toISOString(), startOf(at), at);
    }
  } finally {
    if (stockRoot !== null) await rm(stockRoot, { recursive: true, force: true });
    if (created) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
// The upload-authorization route, the receipt, in-batch refusals, supersession
// scope, withdrawn owners, the erasure inventory and the landed preamble.

const ROUTE_STEPS = Object.freeze(["storage", "admission", "device", "tombstone", "upload-bindings",
  "upload-registration", "rate-limit"]);
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
const duplicateIv = (raw) => raw.replace('"iv":', `"iv":"${"A".repeat(16)}","iv":`);

/** The route's answer equals the Worker's errorResponse for the same code, request id aside. */
async function assertWorkerRefusal(response, status, code, label = code) {
  const { errorResponse, ApiError } = await workerModule("/src/errors.ts");
  const body = await response.json();
  const expected = errorResponse(new ApiError(status, code), "request-synthetic");
  assert.equal(response.status, expected.status, label);
  assert.match(body.error.requestId, /^[0-9a-f-]{36}$/u, label);
  assert.deepEqual({ ...body, error: { ...body.error, requestId: "request-synthetic" } }, await expected.json(), label);
}

/**
 * One d43c8f92 typed-mode v1.0 persist on D1 (persistTelemetryV1StorageChunk,
 * or insertTypedTelemetryV1Chunk itself with direct: true) under a fresh
 * consuming grant, for a request PostgreSQL refuses. Returns the outcome.
 */
async function d1Attempt(twin, { participantId, deviceId, chunk, raw, supersedesId = null,
  leaseExpiresAt = iso(5 * 60_000), direct = false }) {
  const { persistTelemetryV1StorageChunk } = await workerModule("/src/telemetry-storage-mode.ts");
  const { insertTypedTelemetryV1Chunk } = await workerModule("/src/typed-v1-admission.ts");
  const { parseTelemetryV1Chunk } = await workerModule("/src/telemetry-v1.ts");
  const { telemetryEnvelopeDigest } = await workerModule("/src/telemetry-repository.ts");
  const authorizationId = randomUUID();
  twin.d1Only(
    `INSERT INTO device_upload_authorizations (id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
       body_bytes, content_type, state, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'application/json', 'unused', ?, ?)`,
    [authorizationId, participantId, deviceId, bytes32(), sha256Hex(raw), Buffer.byteLength(raw), iso(-1_000),
      iso(5 * 60_000)]);
  twin.d1Only("UPDATE device_upload_authorizations SET state = 'consuming', consume_lease_expires_at = ? WHERE id = ?",
    [leaseExpiresAt, authorizationId]);
  const insert = {
    participantId, deviceId, deviceUploadAuthorizationId: authorizationId, chunkRowId: `chunk:${randomUUID()}`,
    r2Key: `telemetry/v1-${randomUUID()}`, envelopeDigest: await telemetryEnvelopeDigest(JSON.parse(raw)),
    chunk: parseTelemetryV1Chunk(chunk),
    supersedes: supersedesId === null ? null
      : fromSqlite(twin.d1.prepare("SELECT * FROM telemetry_v1_chunks WHERE id = ?").get(supersedesId)),
    createdAt: iso(), authorizationEnvelopeDigest: sha256Hex(raw),
  };
  try {
    const result = direct
      ? await insertTypedTelemetryV1Chunk(d1Database(twin.d1), insert, NAMESPACE)
      : await persistTelemetryV1StorageChunk(d1Database(twin.d1), { kind: "typed", sourceNamespace: NAMESPACE }, insert);
    return { accepted: result };
  } catch (error) {
    return direct ? { thrown: String(error?.message ?? error) } : outcomeOf(error);
  }
}

test("PG17 the upload-authorization route module issues for shipped three-key bodies and refuses as the Worker", {
  skip: SKIP, timeout: 240_000,
}, () => withTwin(async ({ twin, pool, schema }) => {
  const { schemaOptions } = await initializeTypedTargets(twin, schema);
  const service = await origin(pool, schemaOptions, memoryObjectStore());
  const { WORKER_ROUTE_POLICY } = await workerModule("/src/route-registry.ts");
  const worker = await workerModule("/src/telemetry-transport-policy.ts");

  // It mounts on the IN-1 seam as the override of exactly this built-in.
  const mounted = createOriginRouteModuleRegistry({
    modules: [service.uploadAuthorizations], routePolicy: WORKER_ROUTE_POLICY,
  });
  assert.deepEqual(mounted.pathnames, [UPLOAD_AUTHORIZATIONS_PATH]);
  assert.equal(mounted.resolve("POST", UPLOAD_AUTHORIZATIONS_PATH), service.uploadAuthorizations);
  assert.equal(mounted.resolve("GET", UPLOAD_AUTHORIZATIONS_PATH), null);
  // A table without v1.2 would stop v1.2 issuance, so the module cannot start with one.
  const noop = () => {};
  assert.throws(() => createUploadAuthorizationRouteModule({
    primaryPool: pool, ledgerPool: pool, schema: schemaOptions, maxRequestBytes: MAX_REQUEST_BYTES,
    formats: createUploadAuthorizationFormats(legacyUploadAuthorizationFormatEntries({
      assertTelemetryTransportWriteAllowed: noop })),
    assertStorageCurrent: noop, assertAdmissionBindings: noop, assertUploadAuthorizationBindings: noop,
    assertUploadAuthorizationAllowed: noop, assertUploadRegistrationEnabled: noop, authenticateDevice: noop,
    hasDeletionTombstone: noop, readBoundedRequestBody: noop, createDeviceUploadAuthorization: noop,
  }), /UPLOAD_AUTHORIZATION_ROUTE_CONFIGURATION_INVALID/u);

  await socialParticipant(twin, "in3-route");
  const device = await socialDevice(twin, "in3-route", randomUUID());
  const raw = JSON.stringify({ synthetic: "route" });
  const base = { envelopeDigest: sha256Hex(raw), contentLengthBytes: 10, contentType: "application/json" };
  const issuedCount = async () => (await pool.query(
    `SELECT count(*)::int AS n FROM "${schema}".device_upload_authorizations`)).rows[0].n;

  // Shipped d43c8f92 sync engines send three keys: a v1.0 authorization, as on D1.
  service.steps.length = 0;
  const shipped = await service.authorizeUploadResponse(device, base);
  assert.equal(shipped.status, 201);
  assert.match((await shipped.json()).uploadAuthorization, /^um_device_upload_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(service.steps, ROUTE_STEPS, "the built-in route's order");
  // An explicit null is the same default (the Worker's `??`).
  assert.equal((await service.authorizeUploadResponse(device, { ...base, telemetrySchemaVersion: null })).status, 201);
  // Four keys naming v1.2 reach the v1.2 format as on the built-in route, with the Worker's answer.
  let workerV12 = 201;
  try {
    await worker.assertTelemetryTransportWriteAllowed(d1Database(twin.d1), device, V12_UPLOAD_FORMAT);
  } catch (error) {
    workerV12 = `${error.status} ${error.code}`;
  }
  const v12 = await service.authorizeUploadResponse(device, { ...base, telemetrySchemaVersion: V12_UPLOAD_FORMAT });
  assert.equal(v12.status === 201 ? 201 : `${v12.status} ${(await v12.json()).error.code}`, workerV12);
  const issued = await issuedCount();
  assert.equal(issued, workerV12 === 201 ? 3 : 2);

  for (const [label, body, options, status, code] of [
    ["an unknown version", { ...base, telemetrySchemaVersion: "telemetry-contribution-v1.3" }, {}, 403,
      "TELEMETRY_TRANSPORT_BLOCKED"],
    ["the blocked v0.2 format", { ...base, telemetrySchemaVersion: "telemetry-contribution-v0.2" }, {}, 403,
      "TELEMETRY_TRANSPORT_BLOCKED"],
    ["five keys", { ...base, telemetrySchemaVersion: "telemetry-contribution-v1.0", extra: 1 }, {}, 400, "BODY_INVALID"],
    ["two keys", { envelopeDigest: base.envelopeDigest, contentLengthBytes: 10 }, {}, 400, "BODY_INVALID"],
    ["a body that is not JSON", null, { raw: "{" }, 400, "BODY_INVALID"],
    ["a text body", base, { headers: { "content-type": "text/plain" } }, 415, "CONTENT_TYPE_INVALID"],
    ["an unknown bearer", base, { headers: { authorization: "Device um_device_unknown.synthetic" } }, 401,
      "DEVICE_AUTH_INVALID"],
    ["a cookie", base, { headers: { cookie: "session=synthetic" } }, 401, "DEVICE_AUTH_INVALID"],
  ]) {
    service.steps.length = 0;
    await assertWorkerRefusal(await service.authorizeUploadResponse(device, body, options), status, code, label);
    if (label === "a cookie") assert.deepEqual(service.steps, ["storage", "admission"], "refused before the bearer");
  }
  const query = await service.authorizeUploadResponse(device, base, { search: "?synthetic=1" });
  assert.equal(query.status, 503);
  assert.deepEqual(await query.json(), { status: "not_ready", error: "POSTGRES_TEST_ROUTE_UNSUPPORTED" });
  // A disabled upload-registration control refuses before the body.
  await pool.query(`UPDATE "${schema}".collection_controls SET revision = 3, control_state = 'degraded',
      upload_registration_enabled = false, updated_at = $1 WHERE singleton = 1`, [iso()]);
  service.steps.length = 0;
  await assertWorkerRefusal(await service.authorizeUploadResponse(device, base), 503, "UPLOAD_REGISTRATION_DISABLED");
  assert.deepEqual(service.steps, ROUTE_STEPS.slice(0, -1));
  assert.equal(await issuedCount(), issued, "a refused request issues nothing");
}));

test("PG17 an unrecordable upload receipt answers 500 INTERNAL_ERROR, as d43c8f92 recordDeviceUploadReceipt does", {
  skip: SKIP, timeout: 240_000,
}, () => withTwin(async ({ twin, pool, schema }) => {
  const { schemaOptions } = await initializeTypedTargets(twin, schema);
  const service = await origin(pool, schemaOptions, memoryObjectStore());
  const transport = await workerModule("/src/postgres-typed-v12-transport.ts");
  const { recordDeviceUploadReceipt } = await workerModule("/src/device-auth.ts");
  await socialParticipant(twin, "in3-receipt");
  const device = await socialDevice(twin, "in3-receipt", randomUUID());
  const d1 = d1Database(twin.d1);
  const outcome = async (work) => {
    try {
      await work();
      return "recorded";
    } catch (error) {
      return `${error.status} ${error.code}`;
    }
  };
  /** A claimed grant on PostgreSQL and the same consuming grant on D1. */
  const claimed = async (label) => {
    const raw = JSON.stringify({ synthetic: label });
    const { uploadAuthorization } = await service.authorizeUpload(device, {
      envelopeDigest: sha256Hex(raw), contentLengthBytes: Buffer.byteLength(raw), contentType: "application/json",
    });
    const claim = await transport.claimPostgresDeviceUploadAuthorization(pool, `Upload ${uploadAuthorization}`, {
      envelopeDigest: sha256Hex(raw), bodyBytes: Buffer.byteLength(raw), contentType: "application/json",
    }, { schema: schemaOptions });
    twin.d1Only(
      `INSERT INTO device_upload_authorizations (id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
         body_bytes, content_type, state, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'application/json', 'unused', ?, ?)`,
      [claim.authorizationId, device.participantId, device.deviceId, bytes32(), sha256Hex(raw),
        Buffer.byteLength(raw), iso(-1_000), iso(5 * 60_000)]);
    twin.d1Only("UPDATE device_upload_authorizations SET state = 'consuming', consume_lease_expires_at = ? WHERE id = ?",
      [iso(5 * 60_000), claim.authorizationId]);
    return claim.authorizationId;
  };
  const record = (authorizationId, contributionId) => Promise.all([
    outcome(() => recordDeviceUploadReceipt(d1, authorizationId, contributionId)),
    outcome(() => service.admission.recordPostgresDeviceUploadReceipt(pool, authorizationId, contributionId,
      { schema: schemaOptions })),
  ]);

  // The consume lease lapsed before the receipt step (a slow replay).
  const lapsed = await claimed("lapsed");
  await pool.query(`UPDATE "${schema}".device_upload_authorizations
      SET consume_lease_expires_at = now() - interval '1 second' WHERE id = $1`, [lapsed]);
  twin.d1Only("UPDATE device_upload_authorizations SET consume_lease_expires_at = ? WHERE id = ?", [iso(-1_000), lapsed]);
  assert.deepEqual(await record(lapsed, "chunk:synthetic-receipt"), ["500 INTERNAL_ERROR", "500 INTERNAL_ERROR"]);
  // Consumed against another contribution: refused; against the same one: accepted.
  const consumed = await claimed("consumed");
  await twin.run(`UPDATE device_upload_authorizations SET state = 'consumed', consumed_at = ?,
      consumed_contribution_id = 'chunk:synthetic-first', consume_lease_expires_at = NULL WHERE id = ?`,
  [iso(), consumed]);
  assert.deepEqual(await record(consumed, "chunk:synthetic-other"), ["500 INTERNAL_ERROR", "500 INTERNAL_ERROR"]);
  assert.deepEqual(await record(consumed, "chunk:synthetic-first"), ["recorded", "recorded"]);
  // A live claim is recorded on both.
  assert.deepEqual(await record(await claimed("live"), "chunk:synthetic-live"), ["recorded", "recorded"]);
}));

test("PG17 a duplicated envelope key is refused 400 ENVELOPE_INVALID after the claim, for v1.0 and v0.1", {
  skip: SKIP, timeout: 240_000,
}, () => withTwin(async ({ twin, pool, schema }) => {
  const { schemaOptions } = await initializeTypedTargets(twin, schema);
  const store = memoryObjectStore();
  const service = await origin(pool, schemaOptions, store);
  await socialParticipant(twin, "in3-duplicate");
  const device = await socialDevice(twin, "in3-duplicate", randomUUID());
  const v10 = await encryptedEnvelope(await syntheticChunk({ seed: "duplicate" }));
  const v01 = await encryptedEnvelope(v01Contribution("d"), TELEMETRY_V01_ENVELOPE_SCHEMA_VERSION);
  for (const [envelope, send] of [[v10, service.upload], [v01, service.uploadV01]]) {
    const raw = duplicateIv(JSON.stringify(envelope));
    assert.deepEqual(JSON.parse(raw), envelope, "JSON.parse keeps the last duplicate, so the parsed envelope is valid");
    await assert.rejects(send(device, null, { raw }),
      (error) => error.status === 400 && error.code === "ENVELOPE_INVALID");
  }
  const counts = async () => (await pool.query(`SELECT
      (SELECT count(*)::int FROM "${schema}".telemetry_v1_chunks) AS chunks,
      (SELECT count(*)::int FROM "${schema}".telemetry_contributions) AS contributions,
      (SELECT count(*)::int FROM "${schema}".pending_objects) AS pending,
      (SELECT count(*)::int FROM "${schema}".device_upload_authorizations WHERE state = 'revoked') AS abandoned`)).rows[0];
  assert.deepEqual(await counts(), { chunks: 0, contributions: 0, pending: 0, abandoned: 2 });
  assert.equal(store.objects.size, 0);
  // The same envelopes, each key once, are admitted.
  assert.equal((await service.upload(device, null, { envelope: v10 })).response.status, 202);
  assert.equal((await service.uploadV01(device, null, { envelope: v01 })).response.status, 202);
}));

test("PG17 a withdrawn owner link is admitted and reactivated with D1's rows, with and without a v1.0 mapping", {
  skip: SKIP, timeout: 300_000,
}, () => withTwin(async ({ twin, pool, schema }) => {
  const { schemaOptions } = await initializeTypedTargets(twin, schema);
  const service = await origin(pool, schemaOptions, memoryObjectStore());
  await socialParticipant(twin, "in3-withdrawn");
  const device = await socialDevice(twin, "in3-withdrawn", randomUUID());
  // Imported D1 opt-out history: a withdrawn link and no v1.0 mapping yet.
  await twin.run("INSERT INTO storage_v11_owner_links (participant_id, owner_digest, state) VALUES (?, ?, 'withdrawn')",
    ["in3-withdrawn", sha256Hex("synthetic-withdrawn-owner")]);
  const compare = async (label) => {
    const rows = await snapshot(twin, schema, "in3-withdrawn");
    for (const key of Object.keys(rows.d1)) assert.deepEqual(rows.pg[key], rows.d1[key], `${label}: ${key}`);
    return rows;
  };
  const first = await syntheticChunk({ stream: "usage", count: 2, seed: "withdrawn" });
  const admitted = await service.upload(device, first);
  assert.equal(admitted.response.status, 202);
  await oracleAdmission(twin, schema, admitted.receipt.contributionId, first, admitted.raw);
  let rows = await compare("first upload");
  assert.deepEqual(rows.pg.events.map((event) => [event.kind, event.linkState]), [["owner-active", "active"]]);
  assert.equal(rows.pg.membership.length, 1);

  // Withdrawn again, now with the mapping in place. D1's storage_v11_owner_terminal
  // trigger journals the withdrawal; PostgreSQL's withdrawal path appends the same row.
  const link = (await pool.query(`SELECT owner_digest, object_digest, manifest_digest
    FROM "${schema}".storage_v11_owner_links WHERE participant_id = $1`, ["in3-withdrawn"])).rows[0];
  twin.d1Only("UPDATE storage_v11_owner_links SET state = 'withdrawn' WHERE participant_id = ?", ["in3-withdrawn"]);
  await pool.query(`UPDATE "${schema}".storage_v11_owner_links SET state = 'withdrawn' WHERE participant_id = $1`,
    ["in3-withdrawn"]);
  await pool.query(`SELECT "${schema}".storage_journal_append('owner-withdrawn', $1, $2, $3, $4)`,
    [link.owner_digest, sha256Hex("synthetic-withdrawal-event"), link.object_digest, link.manifest_digest]);
  const second = await syntheticChunk({ stream: "quota", count: 1, seed: "withdrawn-again" });
  const readmitted = await service.upload(device, second);
  assert.equal(readmitted.response.status, 202);
  await oracleAdmission(twin, schema, readmitted.receipt.contributionId, second, readmitted.raw);
  rows = await compare("second upload");
  assert.deepEqual(rows.pg.events.map((event) => event.kind), ["owner-active", "owner-active"]);
}));

test("PG17 a v1.0 correction is refused 503 where D1's supersession guard refuses it (accepted v0.1 history)", {
  skip: SKIP, timeout: 300_000,
}, () => withTwin(async ({ twin, pool, schema }) => {
  const { schemaOptions } = await initializeTypedTargets(twin, schema);
  const store = memoryObjectStore();
  const service = await origin(pool, schemaOptions, store);
  await socialParticipant(twin, "in3-mixed");
  const device = await socialDevice(twin, "in3-mixed", randomUUID());
  const legacy = await service.uploadV01(device, v01Contribution("e"));
  assert.equal(legacy.response.status, 202);
  await oracleV01Admission(twin, schema, legacy.receipt.contributionId, legacy.raw);
  // A first revision is admitted on both stores: no graph-scope marker, and no guard on insert.
  const chunk = await syntheticChunk({ stream: "usage", count: 1, seed: "mixed" });
  const first = await service.upload(device, chunk);
  assert.equal(first.response.status, 202);
  await oracleAdmission(twin, schema, first.receipt.contributionId, chunk, first.raw);

  const correction = await syntheticChunk({ stream: "usage", count: 2, seed: "mixed-2", revision: 2 });
  const raw = JSON.stringify(await encryptedEnvelope(correction));
  const attempt = { participantId: "in3-mixed", deviceId: device.deviceId, chunk: correction, raw,
    supersedesId: first.receipt.contributionId };
  const direct = await d1Attempt(twin, { ...attempt, direct: true });
  assert.match(direct.thrown ?? "", /typed_v1_supersession_conflict/u, "D1 aborts in typed_v1_supersession_guard");
  assert.deepEqual(await d1Attempt(twin, attempt), { status: 503, code: "BACKEND_STORAGE_UNAVAILABLE", details: null });
  await assert.rejects(service.upload(device, null, { raw }),
    (error) => error.status === 503 && error.code === "BACKEND_STORAGE_UNAVAILABLE");
  const rows = await snapshot(twin, schema, "in3-mixed");
  for (const key of Object.keys(rows.d1)) assert.deepEqual(rows.pg[key], rows.d1[key], key);
  assert.equal(rows.pg.chunkHeaders.filter((row) => row.superseded_at !== null).length, 0);
  assert.equal(store.objects.size, 2, "the refused correction's object is retired");
}));

test("PG17 refusals raised inside the persist transaction keep D1's codes: typed v1.0 503 or 401, v0.1 500", {
  skip: SKIP, timeout: 300_000,
}, () => withTwin(async ({ twin, pool, schema }) => {
  const { schemaOptions } = await initializeTypedTargets(twin, schema);
  const { TELEMETRY_V1_LAUNCH_WEEK_CHUNKS_PER_DAY } = await workerModule("/src/telemetry-v1-repository.ts");
  const { insertTelemetryContribution, telemetryEnvelopeDigest, telemetryPlaintextDigest } =
    await workerModule("/src/telemetry-repository.ts");
  const { validateTelemetryContribution } = await workerModule("/src/telemetry-validation.ts");
  const { ApiError } = await workerModule("/src/errors.ts");
  // The race window: between the pre-write checks and the persist, the object write runs this hook once.
  let hook = null;
  const store = memoryObjectStore({ beforePut: async () => {
    const run = hook;
    hook = null;
    if (run) await run();
  } });
  const service = await origin(pool, schemaOptions, store);
  // Production runs with v1.1 accepted; a v1.1 consent then raises the floor above v1.0.
  await twin.run("UPDATE telemetry_transport_formats SET lifecycle = 'accepted' WHERE schema_version = ?",
    ["telemetry-contribution-v1.1"]);
  const s = `"${schema}".`;
  const v11Consent = `INSERT INTO telemetry_v11_device_consents (participant_id, device_id, telemetry_schema_version,
      field_dictionary_version, privacy_contract_version, consented_at)
    VALUES (?, ?, 'telemetry-contribution-v1.1', 'telemetry-v1.1-registry-2026-08-31.1',
      'ongoing-privacy-safe-telemetry-v1.1', ?)`;
  const refusedUpload = async (send) => {
    try {
      await send();
    } catch (error) {
      assert.equal(hook, null, `the refusal came after the object write: ${JSON.stringify(outcomeOf(error))}`);
      return outcomeOf(error);
    }
    assert.fail("the upload was expected to be refused");
  };

  // (1) The day's chunk window fills between the pre-write admission and the persist.
  await socialParticipant(twin, "in3-window-race");
  const windowDevice = await socialDevice(twin, "in3-window-race", randomUUID());
  const windowRow = `INSERT INTO telemetry_v1_chunk_admission_windows (participant_id, device_id, window_day,
      accepted_count, last_accepted_at) VALUES (?, ?, ?, ?, ?)`;
  const windowValues = ["in3-window-race", windowDevice.deviceId, day(), TELEMETRY_V1_LAUNCH_WEEK_CHUNKS_PER_DAY, iso()];
  const windowChunk = await syntheticChunk({ seed: "window-race" });
  hook = () => twin.pgOnly(windowRow, windowValues);
  assert.deepEqual(await refusedUpload(() => service.upload(windowDevice, windowChunk)),
    { status: 503, code: "BACKEND_STORAGE_UNAVAILABLE", details: null });
  twin.d1Only(windowRow, windowValues);
  assert.deepEqual(await d1Attempt(twin, { participantId: "in3-window-race", deviceId: windowDevice.deviceId,
    chunk: windowChunk, raw: JSON.stringify(await encryptedEnvelope(windowChunk)) }),
  { status: 503, code: "BACKEND_STORAGE_UNAVAILABLE", details: null });

  // (2) The transport floor rises between the preamble's check and the chunk insert (P1007).
  await socialParticipant(twin, "in3-floor-race");
  const floorDevice = await socialDevice(twin, "in3-floor-race", randomUUID());
  const floorChunk = await syntheticChunk({ seed: "floor-race" });
  hook = () => twin.pgOnly(v11Consent, [floorDevice.participantId, floorDevice.deviceId, iso()]);
  assert.deepEqual(await refusedUpload(() => service.upload(floorDevice, floorChunk)),
    { status: 503, code: "BACKEND_STORAGE_UNAVAILABLE", details: null });
  twin.d1Only(v11Consent, [floorDevice.participantId, floorDevice.deviceId, iso()]);
  assert.deepEqual(await d1Attempt(twin, { participantId: "in3-floor-race", deviceId: floorDevice.deviceId,
    chunk: floorChunk, raw: JSON.stringify(await encryptedEnvelope(floorChunk)) }),
  { status: 503, code: "BACKEND_STORAGE_UNAVAILABLE", details: null });

  // (3) The claim's consume lease lapses during the object write: D1's header
  // authority reads the clock at insert, so the request-start clock must not admit it.
  await socialParticipant(twin, "in3-lease-race");
  const leaseDevice = await socialDevice(twin, "in3-lease-race", randomUUID());
  const lapse = (participantId) => async () => {
    await pool.query(`UPDATE ${s}device_upload_authorizations
        SET consume_lease_expires_at = clock_timestamp() + interval '50 milliseconds'
      WHERE participant_id = $1 AND state = 'consuming'`, [participantId]);
    await sleep(250);
  };
  const leaseChunk = await syntheticChunk({ seed: "lease-race" });
  hook = lapse("in3-lease-race");
  assert.deepEqual(await refusedUpload(() => service.upload(leaseDevice, leaseChunk)),
    { status: 401, code: "UPLOAD_AUTH_INVALID", details: null });
  assert.deepEqual(await d1Attempt(twin, { participantId: "in3-lease-race", deviceId: leaseDevice.deviceId,
    chunk: leaseChunk, raw: JSON.stringify(await encryptedEnvelope(leaseChunk)), leaseExpiresAt: iso(-1_000) }),
  { status: 401, code: "UPLOAD_AUTH_INVALID", details: null });

  // (4) The same lapse for v0.1: D1's 'upload unavailable' abort is rethrown
  // unmapped (handleTelemetryContribution), which the Worker answers 500.
  hook = lapse("in3-lease-race");
  assert.deepEqual(await refusedUpload(() => service.uploadV01(leaseDevice, v01Contribution("c"))),
    { status: 500, code: "INTERNAL_ERROR", details: null });
  const keys = await envelopeKeys();
  const { decryptSyntheticEnvelope } = await workerModule("/src/crypto.ts");
  const v01Envelope = await encryptedEnvelope(v01Contribution("c"), TELEMETRY_V01_ENVELOPE_SCHEMA_VERSION);
  const v01Record = validateTelemetryContribution(
    await decryptSyntheticEnvelope(v01Envelope, keys.publicText, keys.privateText));
  const v01Grant = randomUUID();
  twin.d1Only(
    `INSERT INTO device_upload_authorizations (id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
       body_bytes, content_type, state, issued_at, expires_at, consume_lease_expires_at)
     VALUES (?, ?, ?, ?, ?, 10, 'application/json', 'consuming', ?, ?, ?)`,
    [v01Grant, "in3-lease-race", leaseDevice.deviceId, bytes32(), "b".repeat(64), iso(-60_000), iso(5 * 60_000),
      iso(-1_000)]);
  await assert.rejects(insertTelemetryContribution(d1Database(twin.d1), "in3-lease-race",
    { authorizationId: v01Grant, authorizationKind: "device" }, `contribution:${randomUUID()}`,
    `telemetry/${randomUUID()}`, await telemetryEnvelopeDigest(v01Envelope), await telemetryPlaintextDigest(v01Record),
    v01Record, iso()), (error) => !(error instanceof ApiError) && /upload unavailable/u.test(String(error?.message)));

  const counts = await pool.query(`SELECT (SELECT count(*)::int FROM ${s}telemetry_v1_chunks) AS chunks,
      (SELECT count(*)::int FROM ${s}typed_telemetry_records) AS records,
      (SELECT count(*)::int FROM ${s}telemetry_contributions) AS contributions,
      (SELECT count(*)::int FROM ${s}pending_objects) AS pending`);
  assert.deepEqual(counts.rows[0], { chunks: 0, records: 0, contributions: 0, pending: 0 });
  assert.equal(store.objects.size, 0, "every refused request's object is retired");
}));

test("PG17 a record another chunk of the device owns is 409 RECORD_OWNED_BY_OTHER_CHUNK, as on D1", {
  skip: SKIP, timeout: 300_000,
}, () => withTwin(async ({ twin, pool, schema }) => {
  const { schemaOptions } = await initializeTypedTargets(twin, schema);
  const service = await origin(pool, schemaOptions, memoryObjectStore());
  await socialParticipant(twin, "in3-owned");
  const device = await socialDevice(twin, "in3-owned", randomUUID());
  const owner = await syntheticChunk({ stream: "usage", count: 1, seed: "owned", seq: 0 });
  const admitted = await service.upload(device, owner);
  assert.equal(admitted.response.status, 202);
  await oracleAdmission(twin, schema, admitted.receipt.contributionId, owner, admitted.raw);
  // The same record in another slot of the same device and stream.
  const other = await syntheticChunk({ stream: "usage", count: 1, seed: "owned", seq: 1 });
  const raw = JSON.stringify(await encryptedEnvelope(other));
  assert.deepEqual(await d1Attempt(twin, { participantId: "in3-owned", deviceId: device.deviceId, chunk: other, raw }),
    { status: 409, code: "RECORD_OWNED_BY_OTHER_CHUNK", details: null });
  await assert.rejects(service.upload(device, null, { raw }),
    (error) => error.status === 409 && error.code === "RECORD_OWNED_BY_OTHER_CHUNK");
  const rows = await snapshot(twin, schema, "in3-owned");
  for (const key of Object.keys(rows.d1)) assert.deepEqual(rows.pg[key], rows.d1[key], key);
}));

test("PG17 the social owner erasure preflight accepts a schema carrying the v0.1 admission-window table", {
  skip: SKIP, timeout: 120_000,
}, () => withTwin(async ({ twin, pool, schema }) => {
  const { schemaOptions } = await initializeTypedTargets(twin, schema);
  const preflight = await workerModule("/src/postgres-social-owner-erasure-preflight.ts");
  const table = await pool.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_tables
    WHERE schemaname = $1 AND tablename = 'telemetry_contribution_admission_windows'`, [schema]);
  assert.equal(table.rows[0].n, 1, "the staged migration created the participant-owned window table");
  const participantId = `participant:${randomUUID()}`;
  await socialParticipant(twin, participantId);
  const inventory = await preflight.inspectPostgresSocialOwnerErasureTarget({
    primaryPool: pool, participantId, schema: schemaOptions,
  });
  assert.equal(inventory.status, "inspectable", "the fail-closed participant-table inventory knows the table");
}));

// The landed IN-1b preamble (claude/gcp-fastpath) exports the pairing check;
// the IN-1a seam this branch is based on does not, so the case below runs
// only once IN-3 is composed onto the fast path.
const LANDED_PREAMBLE = typeof contributionEnvelopeSeam.assertContributionEnvelopeFormats === "function";

test("PG17 through the landed origin dispatch: a shipped client authorizes with three keys and uploads v1.0 and v0.1", {
  skip: SKIP || (LANDED_PREAMBLE ? false : "needs the landed IN-1b contributions preamble (claude/gcp-fastpath)"),
  timeout: 300_000,
}, () => withTwin(async ({ twin, pool, schema }) => {
  const { schemaOptions } = await initializeTypedTargets(twin, schema);
  await enableCollection(pool, schema);
  const [authority, admission, transport, uploads, controls, ledgerAuthority, runtimeSchema, workerAdmission,
    workerCrypto, bounded, routes] = await Promise.all([
    "/src/postgres-transport-write-authority.ts", "/src/postgres-legacy-contribution-admission.ts",
    "/src/postgres-typed-v12-transport.ts", "/src/postgres-upload-authorization.ts",
    "/src/postgres-collection-controls.ts", "/src/postgres-ledger-authority.ts", "/src/postgres-runtime-schema.ts",
    "/src/admission.ts", "/src/crypto.ts", "/src/bounded-body.ts", "/src/route-registry.ts",
  ].map((path) => workerModule(path)));
  const keys = await envelopeKeys();
  const store = memoryObjectStore();
  const allowAll = () => ({ async limit() { return { success: true }; } });
  const admissionEnv = Object.freeze({
    ENVIRONMENT: "test", ENROLLMENT_RATE_LIMIT: allowAll(), RECOVERY_RATE_LIMIT: allowAll(),
    CLIENT_ATTEMPT_RATE_LIMIT: allowAll(), PUBLIC_READ_RATE_LIMIT: allowAll(),
    UPLOAD_AUTHORIZATION_RATE_LIMIT: allowAll(), UPLOAD_PRINCIPAL_RATE_LIMIT: allowAll(),
  });
  const mustNotCall = (name) => async () => { throw new Error(`${name} must not be called`); };
  const assertV12UploadAllowed = (formatPool, device, nowEpoch, { schema: formatSchema }) =>
    authority.assertPostgresTelemetryTransportWriteAllowed(formatPool, device, V12_UPLOAD_FORMAT,
      { nowEpoch, schema: formatSchema });
  const legacyFormats = legacyUploadAuthorizationFormatEntries({
    assertTelemetryTransportWriteAllowed: authority.assertPostgresTelemetryTransportWriteAllowed,
    schemaVersions: ["telemetry-contribution-v1.0", "telemetry-contribution-v0.1"],
  });
  const dispatch = createPostgresTestV12DayManifestDispatch({
    primaryPool: pool, ledgerPool: pool, schemaOptions,
    expectedMigrations: runtimeSchema.POSTGRES_RUNTIME_MIGRATIONS, privateOrigin: ORIGIN,
    healthDispatch: mustNotCall("healthDispatch"), admissionEnv,
    assertAdmissionBindings: workerAdmission.assertAdmissionBindings,
    assertAttemptAllowed: workerAdmission.assertAttemptAllowed,
    assertUploadAuthorizationBindings: workerAdmission.assertUploadAuthorizationBindings,
    assertUploadAuthorizationAllowed: workerAdmission.assertUploadAuthorizationAllowed,
    authenticatePostgresDevice: transport.authenticatePostgresDevice,
    disconnectPostgresAuthenticatedDevice: mustNotCall("disconnectPostgresAuthenticatedDevice"),
    hasPostgresDeletionTombstone: ledgerAuthority.hasPostgresDeletionTombstone,
    readPostgresDeviceSyncCapabilities: mustNotCall("readPostgresDeviceSyncCapabilities"),
    readPostgresV12DayCandidates: mustNotCall("readPostgresV12DayCandidates"),
    readPostgresTelemetryV12EffectivePage: mustNotCall("readPostgresTelemetryV12EffectivePage"),
    publicEnvelopeKey: workerCrypto.publicEnvelopeKey, sourceNamespace: NAMESPACE,
    createPostgresTypedV12Domain: mustNotCall("createPostgresTypedV12Domain"),
    assertPostgresV12UploadAllowed: assertV12UploadAllowed,
    createPostgresDeviceUploadAuthorization: uploads.createPostgresDeviceUploadAuthorization,
    registerPostgresTypedV12DayManifest: mustNotCall("registerPostgresTypedV12DayManifest"),
    claimPostgresDeviceUploadAuthorization: transport.claimPostgresDeviceUploadAuthorization,
    abandonPostgresDeviceUploadAuthorization: transport.abandonPostgresDeviceUploadAuthorization,
    recordPostgresDeviceUploadReceipt: admission.recordPostgresDeviceUploadReceipt,
    persistPostgresTypedV12StagedChunk: mustNotCall("persistPostgresTypedV12StagedChunk"),
    decryptSyntheticEnvelope: mustNotCall("decryptSyntheticEnvelope"),
    validateTelemetryV12Envelope,
    validateTelemetryV12StagedChunk: mustNotCall("validateTelemetryV12StagedChunk"),
    sha256Hex: workerCrypto.sha256Hex, objectStore: store,
    envelopePublicJwk: keys.publicText, envelopePrivateJwk: keys.privateText,
    readBoundedRequestBody: bounded.readBoundedRequestBody, maxRequestBytes: MAX_REQUEST_BYTES,
    contributionEnvelopes: [
      createTelemetryV10ContributionEnvelope({ admitTelemetryV1Contribution: admission.admitPostgresTelemetryV1Contribution }),
      createTelemetryV01ContributionEnvelope({ admitTelemetryV01Contribution: admission.admitPostgresTelemetryV01Contribution }),
    ],
    uploadAuthorizationFormats: legacyFormats,
  });
  const routeModule = createUploadAuthorizationRouteModule({
    primaryPool: pool, ledgerPool: pool, schema: schemaOptions, maxRequestBytes: MAX_REQUEST_BYTES, admissionEnv,
    formats: createUploadAuthorizationFormats(new Map([
      [V12_UPLOAD_FORMAT, { assertUploadAllowed: assertV12UploadAllowed }], ...Object.entries(legacyFormats),
    ])),
    // The composition root binds the dispatch's schema-receipt check here.
    assertStorageCurrent: async () => {},
    assertAdmissionBindings: workerAdmission.assertAdmissionBindings,
    assertUploadAuthorizationBindings: workerAdmission.assertUploadAuthorizationBindings,
    assertUploadAuthorizationAllowed: workerAdmission.assertUploadAuthorizationAllowed,
    assertUploadRegistrationEnabled: (controlPool, primarySchema) =>
      controls.assertPostgresCollectionControlFromPool(controlPool, primarySchema, "uploadRegistration"),
    authenticateDevice: transport.authenticatePostgresDevice,
    hasDeletionTombstone: ledgerAuthority.hasPostgresDeletionTombstone,
    readBoundedRequestBody: bounded.readBoundedRequestBody,
    createDeviceUploadAuthorization: uploads.createPostgresDeviceUploadAuthorization,
  });
  const mounted = createOriginRouteModuleRegistry({ modules: [routeModule], routePolicy: routes.WORKER_ROUTE_POLICY });
  // server.mjs: a module on an overridable path answers first, the built-in otherwise.
  const serve = (request) => {
    const routeModuleFor = mounted.resolve(request.method, new URL(request.url).pathname);
    return routeModuleFor === null ? dispatch(request)
      : routeModuleFor.handler(request, Object.freeze({ origin: ORIGIN, hostMode: "fastpath-test" }));
  };
  await socialParticipant(twin, "in3-landed");
  const secret = randomBytes(32).toString("base64url");
  const device = await socialDevice(twin, "in3-landed", randomUUID(), { secret });
  const bearer = `Device um_device_${device.deviceId}.${secret}`;
  const post = (handler, path, authorization, body) => handler(new Request(`${ORIGIN}${path}`, {
    method: "POST", headers: { authorization, "content-type": "application/json" }, body,
  }));
  const threeKeys = (raw) => JSON.stringify({
    envelopeDigest: sha256Hex(raw), contentLengthBytes: Buffer.byteLength(raw), contentType: "application/json",
  });

  // The built-in route alone refuses the shipped three-key body: the module is what admits it.
  const builtIn = await post(dispatch, UPLOAD_AUTHORIZATIONS_PATH, bearer, threeKeys("{}"));
  assert.equal(builtIn.status, 400);
  assert.equal((await builtIn.json()).error.code, "BODY_INVALID");
  const shippedUpload = async (raw) => {
    const authorization = await post(serve, UPLOAD_AUTHORIZATIONS_PATH, bearer, threeKeys(raw));
    assert.equal(authorization.status, 201);
    const { uploadAuthorization } = await authorization.json();
    return post(serve, "/api/v1/contributions", `Upload ${uploadAuthorization}`, raw);
  };

  const chunk = await syntheticChunk({ stream: "usage", count: 2, seed: "landed" });
  const raw = JSON.stringify(await encryptedEnvelope(chunk));
  const accepted = await shippedUpload(raw);
  assert.equal(accepted.status, 202);
  const receipt = await accepted.json();
  assert.equal(receipt.status, "accepted");
  await oracleAdmission(twin, schema, receipt.contributionId, chunk, raw);
  const rows = await snapshot(twin, schema, "in3-landed");
  for (const key of Object.keys(rows.d1)) assert.deepEqual(rows.pg[key], rows.d1[key], key);
  // A replay through the landed preamble and its receipt step.
  const replay = await shippedUpload(raw);
  assert.equal(replay.status, 202);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.equal((await replay.json()).contributionId, receipt.contributionId);
  // A duplicated key: 400 ENVELOPE_INVALID.
  const duplicate = await shippedUpload(duplicateIv(raw));
  assert.equal(duplicate.status, 400);
  assert.equal((await duplicate.json()).error.code, "ENVELOPE_INVALID");
  // v0.1 from the same device, authorized with three keys as src/contribution-device-sync.js does.
  const legacy = await shippedUpload(JSON.stringify(
    await encryptedEnvelope(v01Contribution("f"), TELEMETRY_V01_ENVELOPE_SCHEMA_VERSION)));
  assert.equal(legacy.status, 202);
  assert.equal((await legacy.json()).status, "accepted");
  const grants = await pool.query(`SELECT state, count(*)::int AS n FROM "${schema}".device_upload_authorizations
    GROUP BY state ORDER BY state`);
  assert.deepEqual(grants.rows, [{ state: "consumed", n: 3 }, { state: "revoked", n: 1 }]);
}, { ledger: true }));
