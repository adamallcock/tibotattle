// PostgreSQL v1.2 storage refusals (D1 parity with the v1.2 sync hardening's
// telemetryV12StorageConstraintRefusal). A constraint failure that no reviewed
// rule maps to a conflict is a paced 503 TELEMETRY_STORAGE_CONSTRAINT with
// retry-after 3600; reviewed trigger refusals, telemetry_v12 unique keys and
// concurrent writers stay 409; a lock or statement timeout is an unpaced 503;
// nothing answers 500. The classification table needs no database. The
// PostgreSQL cases drive the real day-manifest, predecessor and activation
// routes through createPostgresTestV12DayManifestDispatch on the local PG17
// socket. Every fixture is synthetic and content-free; each case owns one
// disposable primary schema and its ledger schema and drops only those.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createServer } from "vite";
import {
  canonicalTelemetryV12Json,
  telemetryV12DayManifestDigestInput,
  telemetryV12DomainManifestDigestInput,
  telemetryV12RequiredConsent,
} from "@app-usagemonitor/telemetry-contract";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { createPostgresTestV12DayManifestDispatch } from "../cloud-run/postgres-test-dispatch.mjs";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ID = "synthetic-v12-storage-constraint-source";
const ORIGIN = "http://127.0.0.1:43829";
const MANIFEST_PATH = "/api/v1/device/telemetry/v1.2/day-manifests";
const PREDECESSOR_PATH = "/api/v1/me/telemetry-v12/domain-predecessor";
const ACTIVATE_PATH = "/api/v1/me/telemetry-v12/domain-activate";
const DAY_ONE = "2026-09-21";
const DAY_TWO = "2026-09-22";
const HOUR_MS = 3_600_000;
const REVIEWED_TRIGGER_REFUSALS = Object.freeze([
  "telemetry_manifest_ready_incomplete",
  "telemetry_manifest_ready_mixed_storage",
  "telemetry_v12_typed_record_staging_denied",
  "telemetry_v12_typed_child_stream_conflict",
  "telemetry_v12_typed_row_immutable",
]);

let vite;
let modules;
let pool;

after(async () => {
  await pool?.end();
  await vite?.close();
});

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function loadModules() {
  if (modules) return modules;
  vite = await createServer({
    root: WORKER_ROOT,
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    logLevel: "silent",
  });
  const load = (path) => vite.ssrLoadModule(path);
  const [refusal, errors, client, runtimeSchema, transport, admission, domain, ledgerAuthority,
    workerAdmission, bodyReader, constants, workerCrypto] = await Promise.all([
    load("/src/postgres-telemetry-v12-storage-refusal.ts"),
    load("/src/errors.ts"),
    load("/src/postgres-client.ts"),
    load("/src/postgres-runtime-schema.ts"),
    load("/src/postgres-typed-v12-transport.ts"),
    load("/src/postgres-typed-v12-admission.ts"),
    load("/src/postgres-typed-v12-domain.ts"),
    load("/src/postgres-ledger-authority.ts"),
    load("/src/admission.ts"),
    load("/src/bounded-body.ts"),
    load("/src/constants.ts"),
    load("/src/crypto.ts"),
  ]);
  modules = {
    refusal, errors, client, runtimeSchema, transport, admission, domain, ledgerAuthority,
    workerAdmission, bodyReader, constants, workerCrypto,
  };
  return modules;
}

// ---------------------------------------------------------------------------
// Classification table (no database)
// ---------------------------------------------------------------------------

const DRIVER_DETAIL = "Failing row contains (synthetic-bound-value-7f3a).";
const DRIVER_CONSTRAINT = "synthetic_driver_constraint_name";
const DRIVER_SCHEMA = "synthetic_driver_schema";

/** A pg DatabaseError-shaped fixture: provider message, table, detail,
 * constraint and schema are all driver text that must never be copied. */
function driverError(code, { table, message } = {}) {
  return Object.assign(new Error(message ?? `synthetic driver message for ${code}`), {
    name: "error",
    severity: "ERROR",
    code,
    detail: DRIVER_DETAIL,
    constraint: DRIVER_CONSTRAINT,
    schema: DRIVER_SCHEMA,
    ...(table === undefined ? {} : { table }),
  });
}

const CONFLICT = Object.freeze({ status: 409, code: "TELEMETRY_MANIFEST_CONFLICT", retryAfter: null });
const PACED = Object.freeze({ status: 503, code: "TELEMETRY_STORAGE_CONSTRAINT", retryAfter: "3600" });
const UNAVAILABLE = Object.freeze({ status: 503, code: "BACKEND_STORAGE_UNAVAILABLE", retryAfter: null });

function classificationCases(PostgresStorageError) {
  const cases = [];
  const add = (label, error, expected) => cases.push({ label, error, expected });
  // (2) A reviewed trigger's exact message under 23514 stays a manifest conflict.
  for (const message of REVIEWED_TRIGGER_REFUSALS) {
    add(`23514 reviewed trigger ${message}`, driverError("23514", { message }), CONFLICT);
    add(`23514 reviewed trigger ${message} with a table`,
      driverError("23514", { message, table: "telemetry_v12_day_manifests" }), CONFLICT);
    // Only an exact reviewed message counts; anything near it is a table CHECK.
    for (const nearMiss of [`${message} `, ` ${message}`, message.toUpperCase(),
      `${message}_extra`, `ERROR: ${message}`]) {
      add(`23514 near-miss ${JSON.stringify(nearMiss)}`, driverError("23514", { message: nearMiss }), PACED);
    }
    // The message alone never maps: it must arrive with 23514.
    add(`P0001 with reviewed message ${message}`, driverError("P0001", { message }), null);
    add(`23505 with reviewed message ${message} elsewhere`,
      driverError("23505", { message, table: "pending_objects" }), PACED);
  }
  // (5) A table CHECK carries the provider's own message.
  for (const table of ["telemetry_v12_day_manifests", "telemetry_v12_domain_predecessors",
    "telemetry_v12_domains", "telemetry_v12_chunks", "device_upload_authorizations"]) {
    add(`23514 table CHECK on ${table}`, driverError("23514", {
      table,
      message: `new row for relation "${table}" violates check constraint "${DRIVER_CONSTRAINT}"`,
    }), PACED);
  }
  add("23514 without a message property", { code: "23514" }, PACED);
  // (3) A telemetry_v12 unique key is a manifest conflict; elsewhere it is paced.
  for (const table of ["telemetry_v12_day_manifests", "telemetry_v12_chunks",
    "telemetry_v12_typed_records", "telemetry_v12_domains", "telemetry_v12_domain_predecessors",
    "telemetry_v12_domain_days", "telemetry_v12_domain_heads"]) {
    add(`23505 on ${table}`, driverError("23505", { table }), CONFLICT);
  }
  for (const table of ["device_upload_authorizations", "pending_objects", "typed_telemetry_dictionary",
    "telemetry_v11_domains", "telemetry_v12", "TELEMETRY_V12_CHUNKS", "xtelemetry_v12_chunks", ""]) {
    add(`23505 on ${JSON.stringify(table)}`, driverError("23505", { table }), PACED);
  }
  add("23505 without a table", driverError("23505"), PACED);
  add("23505 with a non-string table", Object.assign(driverError("23505"), { table: 12 }), PACED);
  // (4) A concurrent writer is a manifest conflict, with or without a table.
  for (const code of ["40001", "40P01"]) {
    add(`${code} without a table`, driverError(code), CONFLICT);
    add(`${code} on another table`, driverError(code, { table: "participants" }), CONFLICT);
  }
  // (5) Every other integrity-constraint SQLSTATE is the paced refusal.
  for (const code of ["23000", "23001", "23502", "23503", "23P01"]) {
    add(`${code} on a telemetry_v12 table`, driverError(code, { table: "telemetry_v12_domains" }), PACED);
    add(`${code} elsewhere`, driverError(code, { table: "participants" }), PACED);
  }
  // (6) Statement and lock timeouts are an unpaced outage.
  for (const code of ["57014", "55P03"]) add(`${code} timeout`, driverError(code), UNAVAILABLE);
  // (7) Everything else is not recognised here.
  for (const code of ["22P02", "08006", "53300", "57P01", "25P02", "40002", "40003", "42P01",
    "P0001", "P1005", "XX000", "EPIPE"]) {
    add(`${code} unrecognised`, driverError(code, { table: "telemetry_v12_domains" }), null);
  }
  add("Error without a code", new Error("synthetic driver message without a code"), null);
  add("numeric code", Object.assign(driverError("23505"), { code: 23505 }), null);
  add("four-character code", driverError("2350"), null);
  add("padded code", driverError("23505 "), null);
  add("lower-case class-23 code", driverError("23p01"), null);
  add("sqlState only (never read)",
    Object.assign(new Error("synthetic driver message with sqlState"), { sqlState: "23505" }), null);
  add("throwing code getter", Object.defineProperty(new Error("synthetic driver message with a getter"), "code", {
    get() { throw new Error("synthetic getter failure"); },
  }), null);
  add("throwing proxy", new Proxy({}, { get() { throw new Error("synthetic proxy failure"); } }), null);
  add("string", "23505", null);
  add("null", null, null);
  add("undefined", undefined, null);
  add("number", 23505, null);
  for (const code of ["conflict", "timeout", "invalid", "unavailable"]) {
    add(`already-sanitized PostgresStorageError ${code}`,
      new PostgresStorageError(code, "typed_v12.manifest"), null);
  }
  return cases;
}

/** The answer is a fresh closed ApiError: its code as message, no details, no
 * cause, and either no headers or exactly the paced retry-after. */
function assertClosedAnswer(ApiError, answer, expected, label) {
  assert.ok(answer instanceof ApiError, label);
  assert.equal(answer.status, expected.status, label);
  assert.equal(answer.code, expected.code, label);
  assert.equal(answer.message, expected.code, label);
  assert.equal(answer.publicDetails, null, label);
  assert.equal(Object.hasOwn(answer, "cause"), false, label);
  if (expected.retryAfter === null) {
    assert.equal(answer.responseHeaders, null, label);
  } else {
    assert.deepEqual(answer.responseHeaders, { "retry-after": expected.retryAfter }, label);
  }
}

function assertNoDriverText(answer, error, label) {
  const driverText = [DRIVER_DETAIL, DRIVER_CONSTRAINT, DRIVER_SCHEMA, "synthetic driver message",
    "violates", "relation"];
  if (error !== null && typeof error === "object") {
    for (const name of ["message", "table"]) {
      let value;
      try { value = Reflect.get(error, name); } catch { value = undefined; }
      if (typeof value === "string" && value.length > 0) driverText.push(value);
    }
  }
  const rendered = JSON.stringify({
    code: answer.code,
    status: answer.status,
    message: answer.message,
    stack: answer.stack,
    publicDetails: answer.publicDetails,
    responseHeaders: answer.responseHeaders,
    own: Object.getOwnPropertyNames(answer).map((name) => [name, String(answer[name])]),
  });
  for (const text of driverText) {
    // A reviewed trigger message never names an answer code, so it cannot be
    // mistaken for one; a code is the only text an answer carries.
    if (text === answer.code) continue;
    assert.equal(rendered.includes(text), false, `${label}: answer carries driver text ${JSON.stringify(text)}`);
  }
}

test("classification table: every SQLSTATE, table and message maps as specified without driver text", async () => {
  const { refusal, errors, client } = await loadModules();
  const { ApiError } = errors;
  assert.equal(refusal.TELEMETRY_V12_STORAGE_CONSTRAINT_RETRY_AFTER_SECONDS, "3600");
  const cases = classificationCases(client.PostgresStorageError);
  assert.ok(cases.length > 100);
  for (const { label, error, expected } of cases) {
    const answer = refusal.classifyPostgresTelemetryV12StorageError(error);
    if (expected === null) {
      assert.equal(answer, null, label);
      // Whatever is unrecognised is an unpaced outage at the module boundary.
      const final = refusal.postgresTelemetryV12StorageFailure(error);
      assertClosedAnswer(ApiError, final, UNAVAILABLE, `${label} (final)`);
      assertNoDriverText(final, error, `${label} (final)`);
      continue;
    }
    assertClosedAnswer(ApiError, answer, expected, label);
    assertNoDriverText(answer, error, label);
    const final = refusal.postgresTelemetryV12StorageFailure(error);
    assertClosedAnswer(ApiError, final, expected, `${label} (final)`);
    // Each call builds its own answer, so one response cannot alter another.
    assert.notEqual(refusal.classifyPostgresTelemetryV12StorageError(error), answer, label);
    if (answer.responseHeaders !== null) {
      assert.notEqual(refusal.classifyPostgresTelemetryV12StorageError(error).responseHeaders,
        answer.responseHeaders, label);
    }
  }
});

test("classification table: an ApiError passes through unchanged", async () => {
  const { refusal, errors } = await loadModules();
  const { ApiError } = errors;
  for (const error of [
    new ApiError(409, "TELEMETRY_MANIFEST_INCOMPLETE"),
    new ApiError(400, "SYNC_RANGE_TOO_LARGE"),
    new ApiError(403, "TELEMETRY_TRANSPORT_BLOCKED"),
    new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE"),
    new ApiError(429, "ATTEMPT_LIMIT_REACHED", { responseHeaders: { "retry-after": "60" } }),
    // An ApiError is never reclassified by fields that look like a driver's.
    Object.assign(new ApiError(401, "DEVICE_AUTH_INVALID"), { table: "telemetry_v12_domains" }),
  ]) {
    assert.equal(refusal.classifyPostgresTelemetryV12StorageError(error), error);
    assert.equal(refusal.postgresTelemetryV12StorageFailure(error), error);
  }
});

// ---------------------------------------------------------------------------
// PostgreSQL 17 through the v1.2 test dispatch
// ---------------------------------------------------------------------------

async function localSocket() {
  assert.match(PG_TEST_SOCKET ?? "", /^\/private\/tmp\/tibotattle-pg-[^/]+\/socket$/u);
  assert.ok(Number.isSafeInteger(PG_TEST_PORT) && PG_TEST_PORT > 0 && PG_TEST_PORT <= 65_535);
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

async function setupPool() {
  if (pool) return pool;
  pool = new pg.Pool({
    ...await localSocket(),
    user: process.env.PG_TEST_USER || "postgres",
    password: process.env.PG_TEST_PASSWORD || "synthetic-local-only",
    database: process.env.PG_TEST_DATABASE || "postgres",
    application_name: "pg-v12-storage-constraint-test",
    ssl: false,
    max: 8,
    connectionTimeoutMillis: 5_000,
  });
  const server = await pool.query(
    "SELECT inet_server_addr() AS address, current_setting('server_version_num')::integer AS version",
  );
  assert.equal(server.rows[0]?.address, null, "qualification requires the local Unix socket");
  assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "the disposable socket must be PostgreSQL 17");
  return pool;
}

/** A pool view that records the SQLSTATE and message of every failed driver
 * query, so a case can prove which storage failure produced its answer. The
 * record stays inside this test process. */
function observedPool(basePool, failures) {
  return {
    async connect() {
      const client = await basePool.connect();
      return {
        async query(text, values) {
          try {
            return await client.query(text, values);
          } catch (error) {
            failures.push({
              code: error?.code, message: error?.message, table: error?.table, constraint: error?.constraint,
            });
            throw error;
          }
        },
        release(discard) {
          return client.release(discard);
        },
      };
    },
  };
}

function allowAll() {
  return { async limit() { return { success: true }; } };
}

function mustNotCall(name) {
  return async () => { throw new Error(`${name} must not be called by the v1.2 storage-constraint spec`); };
}

function deviceSecretHash(deviceId, secret) {
  return createHash("sha256")
    .update(`app-usagemonitor/device/v1\0${deviceId}\0`)
    .update(Buffer.from(secret, "base64url"))
    .digest();
}

/** A disposable, fully migrated primary and ledger schema pair, one paired
 * social device with a current v1.2 capability, and the real dispatch. */
async function withHarness(prefix, run) {
  const base = await setupPool();
  const m = await loadModules();
  const suffix = randomBytes(6).toString("hex");
  const primarySchema = `${prefix}_${suffix}`;
  const ledgerSchema = `${prefix}_${suffix}_ledger`;
  const created = [];
  try {
    for (const schema of [primarySchema, ledgerSchema]) {
      await base.query(`CREATE SCHEMA "${schema}"`);
      created.push(schema);
    }
    await applyPostgresMigrations({ role: "primary", schema: primarySchema, pool: base });
    await applyPostgresMigrations({ role: "ledger", schema: ledgerSchema, pool: base });
    const table = (name) => `"${primarySchema}"."${name}"`;
    const nowIso = new Date().toISOString();
    const expiry = new Date(Date.now() + 30 * 24 * HOUR_MS).toISOString();
    await base.query(`UPDATE ${table("telemetry_v12_runtime")} SET state='active', changed_at=$1 WHERE id=1`, [nowIso]);
    await base.query(`UPDATE ${table("telemetry_v12_typed_runtime")} SET state='active', changed_at=$1 WHERE id=1`, [nowIso]);
    await base.query(`INSERT INTO ${table("storage_source_state")}(singleton, source_id, authority_epoch)
      VALUES (1, $1, 0)`, [SOURCE_ID]);
    await base.query(`UPDATE ${table("collection_controls")}
        SET revision=2, control_state='operational', enrollment_enabled=true,
            upload_registration_enabled=true, processing_enabled=true,
            publication_enabled=true, updated_at=$1
      WHERE singleton=1`, [nowIso]);

    const participantId = `synthetic-storage-constraint-${suffix}`;
    const sessionId = randomUUID();
    const pairingId = randomUUID();
    const deviceId = randomUUID();
    const deviceSecret = randomBytes(32).toString("base64url");
    const ownerDigest = randomBytes(32).toString("hex");
    await base.query(`INSERT INTO ${table("participants")}(id, owner_kind, state, consent_version, created_at)
      VALUES ($1,'social','active',$2,$3)`, [participantId, m.constants.TELEMETRY_CONSENT_VERSION, nowIso]);
    await base.query(`INSERT INTO ${table("web_sessions")}(
      id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$5)`, [sessionId, participantId, randomBytes(32), randomBytes(32), nowIso, expiry]);
    await base.query(`INSERT INTO ${table("storage_v11_owner_links")}(participant_id, owner_digest, state)
      VALUES ($1,$2,'active')`, [participantId, ownerDigest]);
    await base.query(`INSERT INTO ${table("analytics_owner_state")}(
      source_id, owner_digest, revision, authority_epoch, state
    ) VALUES ($1,$2,1,0,'active')`, [SOURCE_ID, ownerDigest]);
    await base.query(`INSERT INTO ${table("device_pairings")}(
      id, participant_id, issued_by_session_id, secret_hash, consent_version,
      transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
    ) VALUES ($1,$2,$3,$4,$5,$5,'consumed',$6,$7,$6,$8)`, [
      pairingId, participantId, sessionId, randomBytes(32), m.constants.TELEMETRY_CONSENT_VERSION,
      nowIso, expiry, deviceId,
    ]);
    await base.query(`INSERT INTO ${table("device_credentials")}(
      id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
      state, issued_at, expires_at, last_used_at, social_verified_at
    ) VALUES ($1,$2,'social',$3,$4,'active',$5,$6,$5,$5)`, [
      deviceId, participantId, pairingId, deviceSecretHash(deviceId, deviceSecret), nowIso, expiry,
    ]);
    await base.query(`INSERT INTO ${table("telemetry_v12_device_capabilities")}(
      participant_id, device_id, telemetry_schema_version, field_dictionary_version,
      privacy_contract_version, state, consented_at
    ) VALUES ($1,$2,'telemetry-contribution-v1.2','telemetry-v1.2-registry-2026-09-20.1',
      'ongoing-privacy-safe-telemetry-v1.2','accepted',$3)`, [participantId, deviceId, nowIso]);

    const failures = [];
    const schemaOptions = { primarySchema, ledgerSchema };
    const admissionEnv = Object.freeze({
      ENVIRONMENT: "test",
      ENROLLMENT_RATE_LIMIT: allowAll(),
      RECOVERY_RATE_LIMIT: allowAll(),
      CLIENT_ATTEMPT_RATE_LIMIT: allowAll(),
      PUBLIC_READ_RATE_LIMIT: allowAll(),
      UPLOAD_AUTHORIZATION_RATE_LIMIT: allowAll(),
      UPLOAD_PRINCIPAL_RATE_LIMIT: allowAll(),
    });
    const dispatch = createPostgresTestV12DayManifestDispatch({
      primaryPool: observedPool(base, failures),
      ledgerPool: { connect: () => base.connect() },
      schemaOptions,
      expectedMigrations: m.runtimeSchema.POSTGRES_RUNTIME_MIGRATIONS,
      privateOrigin: ORIGIN,
      healthDispatch: mustNotCall("healthDispatch"),
      admissionEnv,
      assertAdmissionBindings: m.workerAdmission.assertAdmissionBindings,
      assertAttemptAllowed: m.workerAdmission.assertAttemptAllowed,
      assertUploadAuthorizationBindings: m.workerAdmission.assertUploadAuthorizationBindings,
      assertUploadAuthorizationAllowed: m.workerAdmission.assertUploadAuthorizationAllowed,
      authenticatePostgresDevice: m.transport.authenticatePostgresDevice,
      disconnectPostgresAuthenticatedDevice: mustNotCall("disconnectPostgresAuthenticatedDevice"),
      hasPostgresDeletionTombstone: m.ledgerAuthority.hasPostgresDeletionTombstone,
      readPostgresDeviceSyncCapabilities: mustNotCall("readPostgresDeviceSyncCapabilities"),
      readPostgresV12DayCandidates: mustNotCall("readPostgresV12DayCandidates"),
      readPostgresTelemetryV12EffectivePage: mustNotCall("readPostgresTelemetryV12EffectivePage"),
      publicEnvelopeKey: m.workerCrypto.publicEnvelopeKey,
      sourceNamespace: `synthetic-storage-constraint-source-${suffix}`,
      createPostgresTypedV12Domain: m.domain.createPostgresTypedV12Domain,
      assertPostgresV12UploadAllowed: mustNotCall("assertPostgresV12UploadAllowed"),
      createPostgresDeviceUploadAuthorization: mustNotCall("createPostgresDeviceUploadAuthorization"),
      registerPostgresTypedV12DayManifest: m.admission.registerPostgresTypedV12DayManifest,
      claimPostgresDeviceUploadAuthorization: mustNotCall("claimPostgresDeviceUploadAuthorization"),
      abandonPostgresDeviceUploadAuthorization: mustNotCall("abandonPostgresDeviceUploadAuthorization"),
      persistPostgresTypedV12StagedChunk: mustNotCall("persistPostgresTypedV12StagedChunk"),
      decryptSyntheticEnvelope: mustNotCall("decryptSyntheticEnvelope"),
      validateTelemetryV12Envelope: () => { throw new Error("validateTelemetryV12Envelope must not be called"); },
      validateTelemetryV12StagedChunk: mustNotCall("validateTelemetryV12StagedChunk"),
      sha256Hex: m.workerCrypto.sha256Hex,
      objectStore: { put: mustNotCall("objectStore.put"), delete: mustNotCall("objectStore.delete") },
      envelopePublicJwk: '{"synthetic":"unused-public-key"}',
      envelopePrivateJwk: "synthetic-unused-private-key",
      readBoundedRequestBody: m.bodyReader.readBoundedRequestBody,
      maxRequestBytes: m.constants.MAX_REQUEST_BYTES,
    });
    const auth = `Device um_device_${deviceId}.${deviceSecret}`;
    await run({
      base,
      table,
      primarySchema,
      failures,
      principal: { participantId, deviceId },
      options: { schema: schemaOptions },
      /** POST through the real dispatch; nothing may be logged meanwhile. */
      async post(path, body) {
        const logged = [];
        const saved = {};
        for (const method of ["log", "info", "warn", "error", "debug", "trace"]) {
          saved[method] = console[method];
          console[method] = (...args) => { logged.push([method, ...args]); };
        }
        let response;
        try {
          response = await dispatch(new Request(`${ORIGIN}${path}`, {
            method: "POST",
            headers: { authorization: auth, "content-type": "application/json" },
            body: JSON.stringify(body),
          }));
        } finally {
          Object.assign(console, saved);
        }
        assert.deepEqual(logged, [], `${path} must not log`);
        const text = await response.text();
        return { status: response.status, headers: response.headers, text, body: JSON.parse(text) };
      },
    });
  } finally {
    for (const schema of created.reverse()) await base.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
}

function emptyDayManifest(day, parserVersion = "synthetic-storage-constraint") {
  const manifest = {
    schemaVersion: "telemetry-day-manifest-v1.2",
    day,
    parserVersion,
    consent: telemetryV12RequiredConsent(),
    chunks: [],
    excluded: { quota: 0, session: 0, usage: 0 },
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  return manifest;
}

function domainManifest(predecessor, days) {
  const manifest = {
    schemaVersion: "telemetry-domain-manifest-v1.2",
    fromDay: days[0].day,
    throughDay: days.at(-1).day,
    predecessor: {
      token: predecessor.token,
      previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint,
    },
    days: days.map(({ day, manifestId, manifestDigest }) => ({ day, manifestId, manifestDigest })),
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = sha256Hex(telemetryV12DomainManifestDigestInput(manifest));
  return manifest;
}

function assertNoStorageTextInResponse(response, context, extra = []) {
  for (const text of ["violates", "constraint", "relation", "lock timeout", "canceling statement",
    "duplicate key", "telemetry_v12_", "telemetry_manifest_ready", context.primarySchema,
    context.principal.participantId, context.principal.deviceId, ...extra]) {
    assert.equal(response.text.includes(text), false, `response carries storage text ${JSON.stringify(text)}`);
  }
}

/** Exactly {error: {code, requestId}}: no details, SQL, message or bound value. */
function assertErrorBody(response, code) {
  assert.deepEqual(Object.keys(response.body), ["error"]);
  assert.deepEqual(Object.keys(response.body.error).sort(), ["code", "requestId"]);
  assert.equal(response.body.error.code, code);
}

function assertPacedRefusal(response, context, constraint) {
  assert.notEqual(response.status, 500);
  assert.equal(response.status, 503, response.text);
  assertErrorBody(response, "TELEMETRY_STORAGE_CONSTRAINT");
  assert.equal(response.headers.get("retry-after"), "3600");
  assertNoStorageTextInResponse(response, context, [constraint]);
}

function assertUnpacedUnavailable(response, context) {
  assert.notEqual(response.status, 500);
  assert.equal(response.status, 503, response.text);
  assertErrorBody(response, "BACKEND_STORAGE_UNAVAILABLE");
  assert.equal(response.headers.get("retry-after"), null);
  assertNoStorageTextInResponse(response, context);
}

/** The driver failures since `mark`, as the observed pool saw them. */
function driverFailuresSince(context, mark) {
  return context.failures.slice(mark);
}

async function injectRefusal(context, tableName, constraint, predicate) {
  await context.base.query(`ALTER TABLE ${context.table(tableName)}
    ADD CONSTRAINT "${constraint}" CHECK (${predicate}) NOT VALID`);
}

async function dropRefusal(context, tableName, constraint) {
  await context.base.query(`ALTER TABLE ${context.table(tableName)} DROP CONSTRAINT "${constraint}"`);
}

async function count(context, tableName, where = "TRUE", values = []) {
  const result = await context.base.query(
    `SELECT count(*)::integer AS n FROM ${context.table(tableName)} WHERE ${where}`, values,
  );
  return result.rows[0].n;
}

test("injected table CHECKs: day-manifest POST, predecessor and activation answer the paced 503", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withHarness("v12p3_check", async (context) => {
    const { principal } = context;
    const dayOne = await context.post(MANIFEST_PATH, emptyDayManifest(DAY_ONE));
    assert.equal(dayOne.status, 201, dayOne.text);
    assert.equal(dayOne.body.state, "ready");
    const first = await context.post(PREDECESSOR_PATH, {});
    assert.equal(first.status, 201, first.text);
    assert.equal(first.body.previousGenerationId, null);
    const dayOneRef = { day: DAY_ONE, manifestId: dayOne.body.manifestId, manifestDigest: dayOne.body.manifestDigest };

    // Activation: a CHECK on telemetry_v12_domains (previously 500 INTERNAL_ERROR).
    await injectRefusal(context, "telemetry_v12_domains", "synthetic_v12p3_domain_refusal", "false");
    let mark = context.failures.length;
    const activation = await context.post(ACTIVATE_PATH, domainManifest(first.body, [dayOneRef]));
    assertPacedRefusal(activation, context, "synthetic_v12p3_domain_refusal");
    assert.deepEqual(driverFailuresSince(context, mark).map(({ code, table, constraint }) => ({ code, table, constraint })),
      [{ code: "23514", table: "telemetry_v12_domains", constraint: "synthetic_v12p3_domain_refusal" }]);
    assert.equal(await count(context, "telemetry_v12_domains"), 0);
    assert.equal(await count(context, "telemetry_v12_domain_heads"), 0);
    assert.equal(await count(context, "telemetry_v12_domain_predecessors", "consumed_at IS NOT NULL"), 0);

    // Predecessor: a CHECK on telemetry_v12_domain_predecessors (previously 500).
    await injectRefusal(context, "telemetry_v12_domain_predecessors",
      "synthetic_v12p3_predecessor_refusal", "false");
    const predecessorsBefore = await count(context, "telemetry_v12_domain_predecessors");
    mark = context.failures.length;
    const predecessor = await context.post(PREDECESSOR_PATH, {});
    assertPacedRefusal(predecessor, context, "synthetic_v12p3_predecessor_refusal");
    assert.deepEqual(driverFailuresSince(context, mark).map(({ code, table, constraint }) => ({ code, table, constraint })),
      [{ code: "23514", table: "telemetry_v12_domain_predecessors", constraint: "synthetic_v12p3_predecessor_refusal" }]);
    assert.equal(await count(context, "telemetry_v12_domain_predecessors"), predecessorsBefore);

    // Day-manifest registration: the D1 schema gap this refusal was written
    // for, an empty day refused by a CHECK (previously 409 MANIFEST_CONFLICT).
    await injectRefusal(context, "telemetry_v12_day_manifests",
      "synthetic_v12p3_empty_day_refusal", "expected_chunk_count > 0");
    mark = context.failures.length;
    const registration = await context.post(MANIFEST_PATH, emptyDayManifest(DAY_TWO));
    assertPacedRefusal(registration, context, "synthetic_v12p3_empty_day_refusal");
    assert.deepEqual(driverFailuresSince(context, mark).map(({ code, table, constraint }) => ({ code, table, constraint })),
      [{ code: "23514", table: "telemetry_v12_day_manifests", constraint: "synthetic_v12p3_empty_day_refusal" }]);
    assert.equal(await count(context, "telemetry_v12_day_manifests", "chunk_day = $1", [DAY_TWO]), 0);

    // The same requests succeed once the schema no longer refuses them.
    await dropRefusal(context, "telemetry_v12_day_manifests", "synthetic_v12p3_empty_day_refusal");
    await dropRefusal(context, "telemetry_v12_domain_predecessors", "synthetic_v12p3_predecessor_refusal");
    await dropRefusal(context, "telemetry_v12_domains", "synthetic_v12p3_domain_refusal");
    const dayTwo = await context.post(MANIFEST_PATH, emptyDayManifest(DAY_TWO));
    assert.equal(dayTwo.status, 201, dayTwo.text);
    const second = await context.post(PREDECESSOR_PATH, {});
    assert.equal(second.status, 201, second.text);
    assert.deepEqual([second.body.fromDay, second.body.throughDay], [DAY_ONE, DAY_TWO]);
    const activated = await context.post(ACTIVATE_PATH, domainManifest(second.body, [
      dayOneRef,
      { day: DAY_TWO, manifestId: dayTwo.body.manifestId, manifestDigest: dayTwo.body.manifestDigest },
    ]));
    assert.equal(activated.status, 201, activated.text);
    assert.equal(activated.body.replay, false);
    assert.equal(await count(context, "telemetry_v12_domain_heads", "participant_id = $1", [principal.participantId]), 1);
  });
});

test("the reviewed ready-integrity trigger's refusal still answers 409 TELEMETRY_MANIFEST_CONFLICT", {
  skip: !PG_TEST_SOCKET,
  timeout: 120_000,
}, async () => {
  await withHarness("v12p3_ready", async (context) => {
    // Perturb the row between the 0035 retention guard and the 0028
    // ready-integrity guard (BEFORE triggers fire in name order), so the
    // reviewed guard itself sees a zero-chunk manifest that claims one chunk.
    await context.base.query(`CREATE FUNCTION "${context.primarySchema}".synthetic_v12p3_ready_perturbation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.state = 'ready' AND OLD.state = 'staged' THEN
          NEW.expected_chunk_count := NEW.expected_chunk_count + 1;
        END IF;
        RETURN NEW;
      END $$`);
    await context.base.query(`CREATE TRIGGER telemetry_v12_fixture_v12p3_ready_perturbation
      BEFORE UPDATE OF state ON ${context.table("telemetry_v12_day_manifests")}
      FOR EACH ROW EXECUTE FUNCTION "${context.primarySchema}".synthetic_v12p3_ready_perturbation()`);
    const order = await context.base.query(`SELECT tgname::text AS name
        FROM pg_catalog.pg_trigger
       WHERE tgrelid = $1::regclass AND NOT tgisinternal
         AND tgname::text IN ('telemetry_v12_day_manifest_retention_guard',
           'telemetry_v12_fixture_v12p3_ready_perturbation', 'telemetry_v12_manifest_ready_integrity_guard')
       ORDER BY tgname`, [`"${context.primarySchema}"."telemetry_v12_day_manifests"`]);
    assert.deepEqual(order.rows.map((row) => row.name), [
      "telemetry_v12_day_manifest_retention_guard",
      "telemetry_v12_fixture_v12p3_ready_perturbation",
      "telemetry_v12_manifest_ready_integrity_guard",
    ]);

    const mark = context.failures.length;
    const refused = await context.post(MANIFEST_PATH, emptyDayManifest(DAY_ONE));
    assert.notEqual(refused.status, 500);
    assert.equal(refused.status, 409, refused.text);
    assertErrorBody(refused, "TELEMETRY_MANIFEST_CONFLICT");
    assert.equal(refused.headers.get("retry-after"), null);
    assertNoStorageTextInResponse(refused, context);
    assert.deepEqual(driverFailuresSince(context, mark).map(({ code, message }) => ({ code, message })),
      [{ code: "23514", message: "telemetry_manifest_ready_incomplete" }]);
    assert.equal(await count(context, "telemetry_v12_day_manifests"), 0);
  });
});

test("a held row lock's lock_timeout answers 503 BACKEND_STORAGE_UNAVAILABLE without retry-after", {
  skip: !PG_TEST_SOCKET,
  timeout: 180_000,
}, async () => {
  await withHarness("v12p3_lock", async (context) => {
    const { principal } = context;
    const dayOne = await context.post(MANIFEST_PATH, emptyDayManifest(DAY_ONE));
    assert.equal(dayOne.status, 201, dayOne.text);
    const first = await context.post(PREDECESSOR_PATH, {});
    assert.equal(first.status, 201, first.text);
    const predecessorsBefore = await count(context, "telemetry_v12_domain_predecessors");

    // Predecessor and activation both lock the participant's analytical input
    // version; authentication does not, so only the domain transaction waits
    // (previously 500 INTERNAL_ERROR for both).
    const holder = await context.base.connect();
    try {
      await holder.query("BEGIN");
      const held = await holder.query(`SELECT participant_id FROM ${context.table("community_analytical_input_versions")}
        WHERE participant_id = $1 FOR UPDATE`, [principal.participantId]);
      assert.equal(held.rows.length, 1);
      let mark = context.failures.length;
      const predecessor = await context.post(PREDECESSOR_PATH, {});
      assertUnpacedUnavailable(predecessor, context);
      assert.deepEqual(driverFailuresSince(context, mark).map(({ code }) => code), ["55P03"]);
      assert.equal(await count(context, "telemetry_v12_domain_predecessors"), predecessorsBefore);

      mark = context.failures.length;
      const activation = await context.post(ACTIVATE_PATH, domainManifest(first.body, [
        { day: DAY_ONE, manifestId: dayOne.body.manifestId, manifestDigest: dayOne.body.manifestDigest },
      ]));
      assertUnpacedUnavailable(activation, context);
      assert.deepEqual(driverFailuresSince(context, mark).map(({ code }) => code), ["55P03"]);
      assert.equal(await count(context, "telemetry_v12_domains"), 0);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
    }

    // Registration rechecks the device's v1.2 capability FOR SHARE inside its
    // own transaction; authentication does not read it (this answer was
    // already 503 and stays so).
    const manifest = emptyDayManifest(DAY_TWO);
    const capabilityHolder = await context.base.connect();
    try {
      await capabilityHolder.query("BEGIN");
      const held = await capabilityHolder.query(`SELECT device_id
          FROM ${context.table("telemetry_v12_device_capabilities")}
         WHERE participant_id = $1 AND device_id = $2 FOR UPDATE`, [principal.participantId, principal.deviceId]);
      assert.equal(held.rows.length, 1);
      const mark = context.failures.length;
      const registration = await context.post(MANIFEST_PATH, manifest);
      assertUnpacedUnavailable(registration, context);
      assert.deepEqual(driverFailuresSince(context, mark).map(({ code }) => code), ["55P03"]);
      assert.equal(await count(context, "telemetry_v12_day_manifests", "chunk_day = $1", [DAY_TWO]), 0);
    } finally {
      await capabilityHolder.query("ROLLBACK").catch(() => {});
      capabilityHolder.release();
    }

    // With both holders gone, the same requests succeed.
    const dayTwo = await context.post(MANIFEST_PATH, manifest);
    assert.equal(dayTwo.status, 201, dayTwo.text);
    const second = await context.post(PREDECESSOR_PATH, {});
    assert.equal(second.status, 201, second.text);
  });
});

test("staged-chunk persistence rejects an injected chunk CHECK with the paced refusal and consumes nothing", {
  skip: !PG_TEST_SOCKET,
  timeout: 120_000,
}, async () => {
  await withHarness("v12p3_chunk", async (context) => {
    const { principal, table } = context;
    const { admission, errors } = await loadModules();
    const day = DAY_ONE;
    const parserVersion = "synthetic-storage-constraint";
    const quotaRecord = {
      schemaVersion: "quota-observation-v1.2",
      observationId: `quota:v12:${randomUUID()}`,
      observedTime: `${day}T12:05:00.000Z`,
      provider: "openai_codex",
      planType: "pro",
      planVariant: "unknown",
      limitId: "codex",
      slot: "primary",
      usedPercent: 20,
      windowDurationMinutes: 10080,
      resetsAt: `${day}T13:05:00.000Z`,
      accountPlanAttribution: {
        accountBasis: "unavailable",
        accountTrackId: null,
        planBasis: "same_source_occurrence",
        planType: "pro",
        planEraId: null,
      },
    };
    const consent = telemetryV12RequiredConsent();
    const chunk = {
      schemaVersion: "telemetry-contribution-v1.2",
      manifestDigest: "0".repeat(64),
      chunkId: `quota:${day}:0`,
      chunkRevision: 1,
      parserVersion,
      consent,
      records: [quotaRecord],
      chunkDigest: sha256Hex(canonicalTelemetryV12Json([quotaRecord])),
    };
    const manifest = {
      schemaVersion: "telemetry-day-manifest-v1.2",
      day,
      parserVersion,
      consent,
      chunks: [{ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: 1 }],
      excluded: { quota: 0, session: 0, usage: 0 },
      manifestDigest: "0".repeat(64),
    };
    manifest.manifestDigest = sha256Hex(telemetryV12DayManifestDigestInput(manifest));
    chunk.manifestDigest = manifest.manifestDigest;
    const registered = await context.post(MANIFEST_PATH, manifest);
    assert.equal(registered.status, 201, registered.text);
    assert.equal(registered.body.state, "staged");

    const nowEpoch = Date.now();
    const envelopeDigest = randomBytes(32).toString("hex");
    const authorizationId = `synthetic-storage-constraint-auth-${randomUUID()}`;
    const chunkRowId = `chunk:${randomUUID()}`;
    const r2Key = `synthetic/storage-constraint/${randomUUID()}`;
    const issued = new Date(nowEpoch).toISOString();
    const expires = new Date(nowEpoch + 10 * 60_000).toISOString();
    await context.base.query(`INSERT INTO ${table("device_upload_authorizations")}(
      id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
      body_bytes, content_type, state, issued_at, expires_at, consume_lease_expires_at
    ) VALUES ($1,$2,$3,$4,$5,4096,'application/json','consuming',$6,$7,$7)`, [
      authorizationId, principal.participantId, principal.deviceId, randomBytes(32), envelopeDigest, issued, expires,
    ]);
    await context.base.query(`INSERT INTO ${table("pending_objects")}(contribution_id, object_key, object_kind)
      VALUES ($1,$2,'telemetry_v12')`, [chunkRowId, r2Key]);
    const metadata = { chunkRowId, r2Key, envelopeDigest, deviceUploadAuthorizationId: authorizationId };

    // Previously 409 TELEMETRY_MANIFEST_CONFLICT for every 23514.
    await injectRefusal(context, "telemetry_v12_chunks", "synthetic_v12p3_chunk_refusal", "false");
    const refusal = await admission.persistPostgresTypedV12StagedChunk(
      context.base, principal, chunk, metadata, nowEpoch, context.options,
    ).then(() => null, (error) => error);
    assert.ok(refusal instanceof errors.ApiError);
    assert.equal(refusal.status, 503);
    assert.equal(refusal.code, "TELEMETRY_STORAGE_CONSTRAINT");
    assert.deepEqual(refusal.responseHeaders, { "retry-after": "3600" });
    assert.equal(refusal.message, "TELEMETRY_STORAGE_CONSTRAINT");
    assert.equal(await count(context, "telemetry_v12_chunks"), 0);
    assert.equal(await count(context, "device_upload_authorizations", "id = $1 AND state = 'consuming'",
      [authorizationId]), 1);

    await dropRefusal(context, "telemetry_v12_chunks", "synthetic_v12p3_chunk_refusal");
    const staged = await admission.persistPostgresTypedV12StagedChunk(
      context.base, principal, chunk, metadata, nowEpoch, context.options,
    );
    assert.equal(staged.replay, false);
    assert.equal(await count(context, "telemetry_v12_day_manifests", "state = 'ready'"), 1);
  });
});
