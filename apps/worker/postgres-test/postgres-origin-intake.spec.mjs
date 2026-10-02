// GCP fast-path legacy intake, end to end in process (IN-2 and IN-3 composed).
//
// Each case composes the real Cloud Run origin (cloud-run/server.mjs
// createRuntime) in POSTGRES_TEST_HTTP_MODE=fastpath-test against a
// disposable PostgreSQL 17 schema pair migrated through the production
// runner, with injected local pools, connector, token provider and an
// in-memory object store; nothing listens on a port and nothing reaches
// Google. Requests reach runtime.postgresTestDispatch, the function the HTTP
// server calls.
//
// The clients are the shipped desktop client's own code, imported through
// test/helpers (the client source is byte-identical to d43c8f92's):
//   - v1.1: runTelemetryV11Sync (src/contribution/telemetry-v11-sync.js), the
//     transport the Electron app runs, for a social participant whose
//     consent is granted through the real consent route with its web
//     session, and for an accountless installation enrolled through the real
//     accountless routes that holds only the v1.1 grant chain;
//     createTelemetryV11Envelope (src/platform) builds its envelopes;
//   - v1.0: runIncrementalContributionSyncOnce
//     (src/contribution-incremental-sync.js) over a real local unified index,
//     which reads the sync cursor, authorizes each chunk with the shipped
//     three-key body and uploads the real encrypted v1.0 envelope;
//   - v0.1: syncPreparedContributionEntryOnce (src/contribution-device-sync.js),
//     which encrypts a prepared v0.1 contribution with the shipped envelope
//     builder, authorizes it with the three-key body and uploads it.
// Re-runs and re-uploads prove idempotence; unregistered envelope versions
// keep the origin's pre-change refusal byte for byte.
//
// Every row is synthetic and content-free (the v1.1 days are the Q-1
// synthetic oracle fixtures); each case creates and drops its own schemas.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash, randomBytes, randomUUID, webcrypto } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createServer } from "vite";
import {
  canonicalTelemetryV11Json,
  telemetryV11DayManifestDigestInput,
  telemetryV11RequiredConsent,
} from "@app-usagemonitor/telemetry-contract";
import { applyPostgresMigrations } from "../scripts/postgres-migrations.mjs";
import { runTelemetryV11Sync } from "../test/helpers/contribution-v11-runner.js";
import {
  createTelemetryV11Envelope,
  createUnifiedIndexWriter,
  openLocalUnifiedIndex,
  outcomeOrdinal,
  reasoningEffortOrdinal,
  runIncrementalContributionSyncOnce,
  syncPreparedContributionEntryOnce,
} from "../test/helpers/contribution-shipped-client.js";

const PG_TEST_SOCKET = process.env.PG_TEST_SOCKET;
const PG_TEST_PORT = Number(process.env.PG_TEST_PORT ?? "55432");
const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN_PORT = 43957;
const ORIGIN = `http://127.0.0.1:${ORIGIN_PORT}`;
const SOURCE_ID = "synthetic-intake-journal";
const NAMESPACE = "synthetic-intake-namespace";
const KEY_ID = "key:synthetic-intake";
const DAY_MS = 86_400_000;
const CONTRIBUTIONS_PATH = "/api/v1/contributions";
const UPLOAD_AUTHORIZATIONS_PATH = "/api/v1/device/upload-authorizations";
const V1_CONSENT = Object.freeze({
  telemetrySchemaVersion: "telemetry-contribution-v1.0",
  fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
  privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0",
});
const ACCOUNTLESS_AUTHORIZATION = Object.freeze({
  schemaVersion: "accountless-upload-owner-v0.1",
  policyVersion: "accountless-opt-out-v1",
  authorizationBasis: "accountless-policy-v1",
  telemetrySchemaVersion: "telemetry-contribution-v1.1",
});

// The refusal POST /api/v1/contributions gave an unregistered envelope
// before the envelope registry existed (postgres-origin-fastpath.spec.mjs
// pins the same bytes at fc2102eb), with crypto.randomUUID pinned.
const PINNED_REQUEST_ID = "00000000-0000-4000-8000-0000000000c1";
const PRE_CHANGE_HEADERS = Object.freeze([
  ["cache-control", "no-store"],
  ["content-type", "application/json; charset=utf-8"],
  ["referrer-policy", "no-referrer"],
  ["x-content-type-options", "nosniff"],
]);
const PRE_CHANGE_ENVELOPE_INVALID_BODY =
  `{"error":{"code":"ENVELOPE_INVALID","requestId":"${PINNED_REQUEST_ID}"}}`;
// Without an Upload-shaped bearer, d43c8f92 contributionRequestPreflight
// refuses before the body is read (index.ts:638-641).
const PREFLIGHT_UPLOAD_AUTH_INVALID_BODY =
  `{"error":{"code":"UPLOAD_AUTH_INVALID","requestId":"${PINNED_REQUEST_ID}"}}`;

let vite;
let modules;
after(async () => { await vite?.close(); });

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
  const [server, session, codec, constants] = await Promise.all([
    load("/cloud-run/server.mjs"),
    load("/src/session.ts"),
    load("/src/typed-telemetry-codec.ts"),
    load("/src/constants.ts"),
  ]);
  modules = { server, session, codec, constants };
  return modules;
}

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

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

function localPoolOptions(socket, max, applicationName) {
  return {
    ...socket,
    user: process.env.PG_TEST_USER || "postgres",
    password: process.env.PG_TEST_PASSWORD || "synthetic-local-only",
    database: process.env.PG_TEST_DATABASE || "postgres",
    application_name: applicationName,
    ssl: false,
    max,
    connectionTimeoutMillis: 5_000,
  };
}

let keyPair;
async function envelopeKeys() {
  keyPair ??= (async () => {
    const pair = await webcrypto.subtle.generateKey({
      name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
    }, true, ["encrypt", "decrypt"]);
    return {
      publicText: JSON.stringify({ ...await webcrypto.subtle.exportKey("jwk", pair.publicKey), kid: KEY_ID }),
      privateText: JSON.stringify({ ...await webcrypto.subtle.exportKey("jwk", pair.privateKey), kid: KEY_ID }),
    };
  })();
  return keyPair;
}

const RUNTIME_ENVIRONMENT_NAMES = Object.freeze([
  "POSTGRES_TEST_HTTP_MODE", "HOST", "PORT", "HOST_ORIGIN", "PUBLIC_ORIGIN", "ADMIN_HOST_ORIGIN",
  "K_SERVICE", "PRIMARY_DATABASE", "PRIMARY_SCHEMA", "PRIMARY_INSTANCE_CONNECTION_NAME",
  "LEDGER_DATABASE", "LEDGER_SCHEMA", "LEDGER_INSTANCE_CONNECTION_NAME", "POSTGRES_IAM_USER",
  "POSTGRES_SOURCE_ID", "POSTGRES_SOURCE_NAMESPACE", "POSTGRES_RATE_LIMIT_SECRET",
  "ENVELOPE_PUBLIC_JWK", "ENVELOPE_PRIVATE_JWK", "GCS_BUCKET_NAME", "GCS_QUARANTINE_BUCKET_HISTORY_PROOF",
  "GCS_ERASURE_BUCKET_HISTORY_PROOF",
  "ENVIRONMENT", "ENROLLMENT_MODE", "IDENTITY_LINK_SECRET", "IDENTITY_LINK_SECRET_VERSION",
  "GOOGLE_OIDC_CLIENT_ID", "GOOGLE_OIDC_CLIENT_SECRET", "SIGN_IN_START_MAX_PER_MINUTE",
  "ACCOUNTLESS_ENROLLMENT_MODE", "ACCOUNTLESS_OWNERSHIP_MODE", "SOURCE_CONTENT_DIGEST",
  "ANALYTICS_V2_ENABLED", "ANALYTICS_V2_TEST_NOW_MS",
]);

async function withEnvironment(environment, work) {
  const saved = new Map(RUNTIME_ENVIRONMENT_NAMES.map((name) => [name, process.env[name]]));
  for (const name of RUNTIME_ENVIRONMENT_NAMES) delete process.env[name];
  for (const [name, value] of Object.entries(environment)) process.env[name] = value;
  try {
    return await work();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/**
 * A fastpath-test origin over a fresh, fully migrated "<schema>" and
 * "<schema>_ledger" pair with the typed v1/v1.1 targets initialized, as the
 * transfer leaves a cut-over database: one journal source, one namespace
 * shared by both typed families, the v1.1 format accepted.
 */
async function withOrigin(run) {
  const m = await loadModules();
  const socket = await localSocket();
  const base = new pg.Pool(localPoolOptions(socket, 4, "pg-origin-intake-test"));
  const primarySchema = `tibotattle_fastpath_intake_${randomBytes(5).toString("hex")}`;
  const created = [];
  const pools = [];
  let runtime;
  try {
    const server = await base.query(
      "SELECT inet_server_addr() AS address, current_setting('server_version_num')::integer AS version",
    );
    assert.equal(server.rows[0]?.address, null, "qualification requires the local Unix socket");
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "the disposable socket must be PostgreSQL 17");
    for (const schema of [primarySchema]) {
      await base.query(`CREATE SCHEMA "${schema}"`);
      created.push(schema);
    }
    const primary = await applyPostgresMigrations({ role: "primary", schema: primarySchema, pool: base });
    assert.equal(primary.migrations.at(-1)?.name, "0064_append_only_residue.sql");
    const t = (name) => `"${primarySchema}"."${name}"`;
    await base.query(`UPDATE ${t("collection_controls")}
        SET revision=2, control_state='operational', enrollment_enabled=true, upload_registration_enabled=true,
            processing_enabled=true, publication_enabled=true, updated_at=$1
      WHERE singleton=1`, [new Date().toISOString()]);
    await base.query(`INSERT INTO ${t("storage_source_state")} (singleton, source_id, authority_epoch)
      VALUES (1, $1, 0)`, [SOURCE_ID]);
    const namespace = await base.query(`INSERT INTO ${t("typed_telemetry_namespaces")} (original_id)
      VALUES ($1) RETURNING id`, [Buffer.from(m.codec.encodeTypedTelemetryId(NAMESPACE))]);
    for (const family of ["typed_v1_admission_state", "typed_v11_admission_state"]) {
      await base.query(`INSERT INTO ${t(family)}
          (id, source_namespace, namespace_id, runtime_contract_version, next_source_row_id)
        VALUES (1, $1, $2, 1, 1)`, [NAMESPACE, namespace.rows[0].id]);
    }
    // D1 seeds v1.1 'staged'; production accepted it, and the transfer copies that.
    await base.query(`UPDATE ${t("telemetry_transport_formats")} SET lifecycle='accepted'
      WHERE schema_version='telemetry-contribution-v1.1'`);

    const keys = await envelopeKeys();
    const bucket = "synthetic-intake-bucket";
    const objects = new Map();
    const store = {
      objects,
      async put(key, value) { objects.set(key, typeof value === "string" ? value : Buffer.from(value).toString()); },
      async delete(key) { objects.delete(key); },
    };
    runtime = await withEnvironment({
      POSTGRES_TEST_HTTP_MODE: "fastpath-test",
      HOST: "127.0.0.1",
      PORT: String(ORIGIN_PORT),
      HOST_ORIGIN: ORIGIN,
      PRIMARY_SCHEMA: primarySchema,
      PRIMARY_DATABASE: process.env.PG_TEST_DATABASE || "postgres",
      PRIMARY_INSTANCE_CONNECTION_NAME: "synthetic-project:us-east1:synthetic-intake-primary",
      POSTGRES_IAM_USER: "synthetic-intake-runtime@synthetic.iam",
      POSTGRES_SOURCE_ID: SOURCE_ID,
      POSTGRES_SOURCE_NAMESPACE: NAMESPACE,
      POSTGRES_RATE_LIMIT_SECRET: "synthetic-intake-rate-limit-secret-0123456789abcdef",
      ENVELOPE_PUBLIC_JWK: keys.publicText,
      ENVELOPE_PRIVATE_JWK: keys.privateText,
      GCS_BUCKET_NAME: bucket,
      GCS_QUARANTINE_BUCKET_HISTORY_PROOF: JSON.stringify({
        bucket, bucketGeneration: "1", bucketMetageneration: "1", softDeleteRetentionDurationSeconds: "0",
      }),
      ACCOUNTLESS_ENROLLMENT_MODE: "enabled",
      ACCOUNTLESS_OWNERSHIP_MODE: "enabled",
    }, () => m.server.createRuntime({
      dependencies: {
        createConnector: () => ({ close() {} }),
        async createIamPool(options) {
          const pool = new pg.Pool(localPoolOptions(socket, options.max, `pg-origin-intake-${options.role}`));
          pools.push(pool);
          return pool;
        },
        async createGoogleAccessTokenProvider() { return async () => "synthetic-access-token"; },
        createGcsQuarantineObjectStore: () => store,
      },
    }));
    assert.equal(runtime.postgresTestHostMode, "fastpath-test");
    const exchanges = [];
    /** The clients' fetch: one in-process request to the origin per call. */
    const fetchImpl = async (url, init = {}) => {
      const request = new Request(url, init);
      const body = typeof init.body === "string" ? init.body : undefined;
      const response = await runtime.postgresTestDispatch(request);
      exchanges.push({ method: request.method, path: new URL(url).pathname, status: response.status, body });
      return response;
    };
    return await run({ m, base, t, primarySchema, runtime, store, fetchImpl, exchanges });
  } finally {
    for (const pool of pools) await pool.end().catch(() => {});
    for (const schema of created.reverse()) await base.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await base.end();
  }
}

function deviceSecretHash(deviceId, secret) {
  return createHash("sha256").update(`app-usagemonitor/device/v1\0${deviceId}\0`).update(secret).digest();
}

/** A paired, active social participant and device; returns its bearer and web session. */
async function socialOwner({ m, base, t }, { participantId, pairingConsent }) {
  const nowEpoch = Date.now();
  const now = new Date(nowEpoch).toISOString();
  const expires = new Date(nowEpoch + 30 * DAY_MS).toISOString();
  await base.query(`INSERT INTO ${t("participants")} (id, owner_kind, state, consent_version, created_at)
    VALUES ($1, 'social', 'active', $2, $3)`, [participantId, m.constants.TELEMETRY_CONSENT_VERSION, now]);
  const session = await m.session.createSessionMaterial(participantId, nowEpoch);
  await base.query(`INSERT INTO ${t("web_sessions")} (
      id, participant_id, secret_hash, csrf_hash, scope, state, issued_at, expires_at, last_used_at
    ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $6)`,
  [session.id, participantId, session.secretHash, session.csrfHash, session.scope, session.issuedAt, session.expiresAt]);
  const deviceId = randomUUID();
  const pairingId = randomUUID();
  const secret = randomBytes(32);
  await base.query(`INSERT INTO ${t("device_pairings")} (
      id, participant_id, issued_by_session_id, secret_hash, consent_version,
      transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
    ) VALUES ($1, $2, $3, $4, $5, $6, 'consumed', $7, $8, $7, $9)`,
  [pairingId, participantId, session.id, randomBytes(32), pairingConsent.consentVersion,
    pairingConsent.transportConsentVersion, now, expires, deviceId]);
  await base.query(`INSERT INTO ${t("device_credentials")} (
      id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
      state, issued_at, expires_at, last_used_at, social_verified_at
    ) VALUES ($1, $2, 'social', $3, $4, 'active', $5, $6, $5, $5)`,
  [deviceId, participantId, pairingId, deviceSecretHash(deviceId, secret), now, expires]);
  return {
    participantId, deviceId, secret, session,
    cookie: m.session.sessionCookie(session).split(";", 1)[0],
    deviceAuthorization: `Device um_device_${deviceId}.${secret.toString("base64url")}`,
  };
}

/** test/helpers/telemetry-v11.ts makeV11Day: one day's manifest and its 200-record chunks. */
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

/** A Q-1 synthetic owner-day: its day and records, and empty days around it. */
async function q1Day(name) {
  const fixture = JSON.parse(await readFile(resolve(WORKER_ROOT, "postgres-test/fixtures", name), "utf8"));
  return {
    day: fixture.day,
    readDay: (day) => makeV11Day(day, day === fixture.day ? fixture.records : {}, fixture.parserVersion),
    recordCount: Object.values(fixture.records).reduce((sum, records) => sum + records.length, 0),
  };
}

/** The shipped v1.1 envelope over the origin's own published envelope key. */
function v11EnvelopeFactory(fetchImpl) {
  let key;
  return async (chunk) => {
    key ??= await (await fetchImpl(new URL("/api/v1/envelope-key", ORIGIN), { headers: { accept: "application/json" } })).json();
    return createTelemetryV11Envelope({ chunk, publicJwk: key.publicJwk, keyId: key.keyId, cryptoImpl: webcrypto });
  };
}

function post(fetchImpl, path, body, headers = {}) {
  return fetchImpl(new URL(path, ORIGIN), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Re-post one retained envelope under a fresh authorization: the shipped re-upload. */
async function reupload(fetchImpl, deviceAuthorization, raw, telemetrySchemaVersion) {
  const authorization = await post(fetchImpl, UPLOAD_AUTHORIZATIONS_PATH, {
    envelopeDigest: sha256Hex(raw), contentLengthBytes: Buffer.byteLength(raw), contentType: "application/json",
    ...(telemetrySchemaVersion === undefined ? {} : { telemetrySchemaVersion }),
  }, { authorization: deviceAuthorization });
  assert.equal(authorization.status, 201);
  const { uploadAuthorization } = await authorization.json();
  return post(fetchImpl, CONTRIBUTIONS_PATH, raw, { authorization: `Upload ${uploadAuthorization}` });
}

async function grantStates(base, t, participantId) {
  return (await base.query(`SELECT state, count(*)::int AS n FROM ${t("device_upload_authorizations")}
    WHERE participant_id = $1 GROUP BY state ORDER BY state`, [participantId])).rows;
}

test("a shipped social v1.1 client runs consent, day manifests, chunks, predecessor and activation, then replays", {
  skip: !PG_TEST_SOCKET, timeout: 300_000,
}, () => withOrigin(async (origin) => {
  const { base, t, fetchImpl, exchanges, store } = origin;
  const owner = await socialOwner(origin, {
    participantId: `synthetic-intake-social-${randomBytes(4).toString("hex")}`,
    pairingConsent: { consentVersion: origin.m.constants.TELEMETRY_CONSENT_VERSION,
      transportConsentVersion: "ongoing-privacy-safe-telemetry-v1.0" },
  });
  const q1 = await q1Day("telemetry-v11-live-q1-owner-a-2026-09-30.json");
  const sync = (options = {}) => runTelemetryV11Sync({
    serverBaseUrl: ORIGIN, deviceAuthorization: owner.deviceAuthorization, consent: telemetryV11RequiredConsent(),
    days: [q1.day], readDay: q1.readDay, createEnvelope: v11EnvelopeFactory(fetchImpl), fetchImpl,
    maxDurationMs: 240_000, ...options,
  });

  // Before consent the shipped client stops at the capability read.
  const refused = await sync();
  assert.equal(refused.status, "failed");
  assert.equal(refused.failure.code, "consent_rejected");

  // Consent through the real route with the participant's web session.
  const consent = await post(fetchImpl, "/api/v1/me/device-telemetry-consents",
    { deviceId: owner.deviceId, consent: telemetryV11RequiredConsent(), ongoingUpload: true },
    { origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: owner.cookie, "x-usage-monitor-csrf": owner.session.csrfToken });
  assert.equal(consent.status, 201);
  assert.deepEqual(await consent.json(), { consent: telemetryV11RequiredConsent(), minimumWriteRank: 11 });

  const first = await sync();
  assert.equal(first.status, "complete", JSON.stringify(first.failure));
  assert.equal(first.recordsUploaded, q1.recordCount);
  assert.ok(first.chunksUploaded >= 3);
  assert.match(first.domainGenerationId ?? "", /^[0-9a-f-]{36}$/u);
  const paths = [...new Set(exchanges.map((exchange) => `${exchange.method} ${exchange.path}`))];
  for (const expected of ["POST /api/v1/me/device-telemetry-consents", "GET /api/v1/device/sync-capabilities",
    "POST /api/v1/me/telemetry-v11/domain-predecessor", "POST /api/v1/device/telemetry/v1.1/day-manifests",
    `POST ${UPLOAD_AUTHORIZATIONS_PATH}`, `POST ${CONTRIBUTIONS_PATH}`, "POST /api/v1/me/telemetry-v11/domain-activate"]) {
    assert.ok(paths.includes(expected), `${expected} was exercised`);
  }
  const counts = async () => (await base.query(`SELECT
      (SELECT count(*)::int FROM ${t("telemetry_v11_chunks")} WHERE participant_id = $1) AS chunks,
      (SELECT count(*)::int FROM ${t("typed_v11_record_admissions")} admission
         JOIN ${t("telemetry_v11_chunks")} chunk ON chunk.id = admission.chunk_id WHERE chunk.participant_id = $1) AS records,
      (SELECT count(*)::int FROM ${t("telemetry_v11_domains")} WHERE participant_id = $1) AS domains,
      (SELECT revision::int FROM ${t("telemetry_v11_domain_heads")} WHERE participant_id = $1) AS head,
      (SELECT count(*)::int FROM ${t("storage_ingestion_changes")} change
         JOIN ${t("storage_v11_owner_links")} link ON link.owner_digest = change.owner_digest
        WHERE link.participant_id = $1) AS journal`, [owner.participantId])).rows[0];
  assert.deepEqual(await counts(), { chunks: first.chunksUploaded, records: q1.recordCount, domains: 1, head: 1, journal: 1 });
  const objectsAfterFirst = store.objects.size;

  // A second pass: every chunk is already staged and the vector unchanged.
  const second = await sync();
  assert.equal(second.status, "complete", JSON.stringify(second.failure));
  assert.equal(second.chunksUploaded, 0);
  assert.equal(second.chunksSkipped, first.chunksUploaded);
  assert.equal(second.domainGenerationId, first.domainGenerationId);
  assert.deepEqual(await counts(), { chunks: first.chunksUploaded, records: q1.recordCount, domains: 1, head: 1, journal: 1 });

  // Re-uploading a retained envelope is a replay of the retained chunk.
  const uploaded = exchanges.find((exchange) => exchange.path === CONTRIBUTIONS_PATH && exchange.status === 202);
  const replay = await reupload(fetchImpl, owner.deviceAuthorization, uploaded.body, "telemetry-contribution-v1.1");
  assert.equal(replay.status, 202);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.equal((await replay.json()).replayed, true);
  assert.equal(store.objects.size, objectsAfterFirst, "a replay stores no new object");
  assert.deepEqual(await counts(), { chunks: first.chunksUploaded, records: q1.recordCount, domains: 1, head: 1, journal: 1 });
  assert.deepEqual(await grantStates(base, t, owner.participantId), [{ state: "consumed", n: first.chunksUploaded + 1 }]);
}));

test("a shipped accountless v1.1-only client enrolls, uploads under the v1.1 grant chain and activates", {
  skip: !PG_TEST_SOCKET, timeout: 300_000,
}, () => withOrigin(async ({ base, t, fetchImpl, exchanges }) => {
  const deviceId = randomUUID();
  const secret = randomBytes(32);
  const deviceAuthorization = `Device um_device_${deviceId}.${secret.toString("base64url")}`;
  const enrolled = await post(fetchImpl, "/api/v1/accountless/enrollment", {
    schemaVersion: "accountless-enrollment-v0.1", deviceId,
    deviceSecretHash: deviceSecretHash(deviceId, secret).toString("hex"),
    policyVersion: "accountless-opt-out-v1", authorizationBasis: "accountless-policy-v1",
  });
  assert.equal(enrolled.status, 201);
  const owned = await post(fetchImpl, "/api/v1/accountless/ownership", ACCOUNTLESS_AUTHORIZATION,
    { authorization: deviceAuthorization });
  assert.equal(owned.status, 201);
  const participantId = (await base.query(`SELECT participant_id FROM ${t("accountless_upload_owners")}
    WHERE enrollment_device_id = $1`, [deviceId])).rows[0].participant_id;
  // A v1.1-only installation: the v1.1 grant chain and no typed-v1.2 grant.
  assert.equal((await base.query(`SELECT count(*)::int AS n FROM ${t("accountless_v12_device_authorizations")}
    WHERE enrollment_device_id = $1`, [deviceId])).rows[0].n, 0);

  const q1 = await q1Day("telemetry-v11-live-q1-owner-b-2026-09-30.json");
  const sync = () => runTelemetryV11Sync({
    serverBaseUrl: ORIGIN, deviceAuthorization, authorization: ACCOUNTLESS_AUTHORIZATION, laboratory: true,
    days: [q1.day], readDay: q1.readDay, createEnvelope: v11EnvelopeFactory(fetchImpl), fetchImpl,
    maxDurationMs: 240_000,
  });
  const first = await sync();
  assert.equal(first.status, "complete", JSON.stringify(first.failure));
  assert.equal(first.recordsUploaded, q1.recordCount);
  assert.ok(exchanges.filter((exchange) => exchange.path === CONTRIBUTIONS_PATH)
    .every((exchange) => exchange.status === 202), "every contribution was claimed and admitted");
  const second = await sync();
  assert.equal(second.status, "complete", JSON.stringify(second.failure));
  assert.equal(second.chunksUploaded, 0);
  assert.equal(second.domainGenerationId, first.domainGenerationId);
  const uploaded = exchanges.find((exchange) => exchange.path === CONTRIBUTIONS_PATH && exchange.status === 202);
  const replay = await reupload(fetchImpl, deviceAuthorization, uploaded.body, "telemetry-contribution-v1.1");
  assert.equal(replay.status, 202);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.deepEqual(await grantStates(base, t, participantId), [{ state: "consumed", n: first.chunksUploaded + 1 }]);
  assert.equal((await base.query(`SELECT revision::int AS revision FROM ${t("telemetry_v11_domain_heads")}
    WHERE participant_id = $1`, [participantId])).rows[0].revision, 1);
}));

/** root test/contribution-v1-sync-engine.test.js writeEvents: a real local unified index. */
async function writeUnifiedIndex(file, events) {
  const database = openLocalUnifiedIndex(file, { readOnly: false, create: true });
  const writer = createUnifiedIndexWriter(database, { contractVersion: "telemetry-contribution-v0.1" });
  const accountScopeId = writer.internAccountScope({
    status: "unavailable", reason: "missing_account", planType: null, scopeLocal: null,
  });
  for (const event of events) {
    writer.writeUsageEvent({
      eventKey: event.eventKey, observedAtMs: event.observedAtMs, sessionLocal: Buffer.alloc(32, 0x0c),
      accountScopeId, modelId: writer.internModel("gpt-5.6-sol", "recognized"),
      tierId: writer.internTier({
        apiServiceTier: "unknown", billingSurface: "chatgpt_subscription", codexSpeedMode: "standard",
        tierSource: "rollout_thread_settings", providerTierRaw: "default",
      }),
      surfaceId: writer.internSurface({
        agentScope: "root", surface: "extension_or_ide", threadSource: "rollout", lineageDisposition: "standalone",
      }),
      quotaObservationId: null, reasoningEffort: reasoningEffortOrdinal("medium"), outcome: outcomeOrdinal("unknown"),
      tokensInUncached: event.tokens, tokensInCacheRead: null, tokensInCacheWrite: null,
      tokensInCacheWrite5m: null, tokensInCacheWrite1h: null, tokensOutText: 1, tokensOutReasoning: null,
      tokensOutCombined: null, totalInputContext: null,
    });
  }
  await writer.close({ integrityCheck: true, fsyncPath: null });
}

test("the shipped v1.0 sync engine authorizes with three keys, uploads through the real preamble, and re-runs idempotently", {
  skip: !PG_TEST_SOCKET, timeout: 300_000,
}, () => withOrigin(async (origin) => {
  const { base, t, fetchImpl, exchanges, store } = origin;
  const owner = await socialOwner(origin, {
    participantId: `synthetic-intake-v1-${randomBytes(4).toString("hex")}`,
    pairingConsent: { consentVersion: V1_CONSENT.privacyContractVersion,
      transportConsentVersion: V1_CONSENT.privacyContractVersion },
  });
  // The pairing claim records the v1.0 consent-once grant.
  await base.query(`INSERT INTO ${t("telemetry_v1_device_consents")} (participant_id, device_id,
      telemetry_schema_version, field_dictionary_version, privacy_contract_version, consented_at)
    VALUES ($1, $2, $3, $4, $5, $6)`, [owner.participantId, owner.deviceId, V1_CONSENT.telemetrySchemaVersion,
    V1_CONSENT.fieldDictionaryVersion, V1_CONSENT.privacyContractVersion, new Date().toISOString()]);
  const directory = await mkdtemp(join(tmpdir(), "intake-v1-index-"));
  try {
    const indexFile = join(directory, "index.sqlite");
    const dayStart = Date.parse("2026-09-28T00:00:00.000Z");
    const eventKey = (index) => { const key = Buffer.alloc(32, 0); key.writeUInt32BE(index, 28); return key; };
    await writeUnifiedIndex(indexFile, [
      { eventKey: eventKey(1), observedAtMs: dayStart + 1_000, tokens: 120 },
      { eventKey: eventKey(2), observedAtMs: dayStart + 2_000, tokens: 80 },
      { eventKey: eventKey(3), observedAtMs: dayStart + DAY_MS + 1_000, tokens: 40 },
    ]);
    const engine = () => runIncrementalContributionSyncOnce({
      indexFile, origin: ORIGIN, backend: {}, fetchImpl,
      withDeviceSecret: async ({ expectedOrigin, operation }) =>
        operation(owner.secret, { origin: expectedOrigin, deviceId: owner.deviceId }),
    });
    const first = await engine();
    assert.equal(first.status, "complete", JSON.stringify(first.failure));
    assert.equal(first.chunksUploaded, 2);
    assert.equal(first.recordsUploaded, 3);
    assert.equal(first.acknowledgedThroughDay, "2026-09-29");
    // The shipped engine sends the three-key authorization body.
    const authorizations = exchanges.filter((exchange) => exchange.path === UPLOAD_AUTHORIZATIONS_PATH);
    assert.ok(authorizations.length === 2 && authorizations.every((exchange) => exchange.status === 201
      && Object.keys(JSON.parse(exchange.body)).sort().join() === "contentLengthBytes,contentType,envelopeDigest"));
    const uploads = exchanges.filter((exchange) => exchange.path === CONTRIBUTIONS_PATH);
    assert.ok(uploads.every((exchange) => exchange.status === 202
      && JSON.parse(exchange.body).schemaVersion === "telemetry-envelope-v1.0"));
    const rows = async () => (await base.query(`SELECT
        (SELECT count(*)::int FROM ${t("telemetry_v1_chunks")} WHERE participant_id = $1) AS chunks,
        (SELECT count(*)::int FROM ${t("typed_v1_record_admissions")} admission
           JOIN ${t("telemetry_v1_chunks")} chunk ON chunk.id = admission.chunk_id WHERE chunk.participant_id = $1) AS records,
        (SELECT count(*)::int FROM ${t("typed_v1_event_sources")} WHERE participant_id = $1) AS events`,
    [owner.participantId])).rows[0];
    assert.deepEqual(await rows(), { chunks: 2, records: 3, events: 2 });
    const objects = store.objects.size;

    // A second pass agrees with the service's cursor and uploads nothing.
    const second = await engine();
    assert.equal(second.status, "complete", JSON.stringify(second.failure));
    assert.equal(second.chunksUploaded, 0);
    assert.equal(second.acknowledgedThroughDay, "2026-09-29");
    // Re-uploading the exact envelope under a fresh three-key authorization replays.
    const replay = await reupload(fetchImpl, owner.deviceAuthorization, uploads[0].body);
    assert.equal(replay.status, 202);
    assert.equal(replay.headers.get("idempotency-replayed"), "true");
    const receipt = await replay.json();
    assert.deepEqual([receipt.status, receipt.replayed], ["accepted", true]);
    assert.deepEqual(await rows(), { chunks: 2, records: 3, events: 2 });
    assert.equal(store.objects.size, objects);
    assert.deepEqual(await grantStates(base, t, owner.participantId), [{ state: "consumed", n: 3 }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}));

// d43c8f92 handleContribution meters POST /api/v1/contributions with the
// upload-ingress limiters and the per-device chunk windows only; the
// device_sync attempt limiter (RECOVERY: 20 per 60 s on one global key)
// meters the authenticated sync reads. More chunks than two RECOVERY windows
// hold must therefore all be admitted in one pass of the shipped engine.
const BACKFILL_DAYS = 45;

test("a shipped v1.0 backfill posts every chunk in one pass: contributions never draw the device-sync attempt limiter", {
  skip: !PG_TEST_SOCKET, timeout: 300_000,
}, () => withOrigin(async (origin) => {
  const { base, t, fetchImpl, exchanges } = origin;
  const owner = await socialOwner(origin, {
    participantId: `synthetic-intake-backfill-${randomBytes(4).toString("hex")}`,
    pairingConsent: { consentVersion: V1_CONSENT.privacyContractVersion,
      transportConsentVersion: V1_CONSENT.privacyContractVersion },
  });
  await base.query(`INSERT INTO ${t("telemetry_v1_device_consents")} (participant_id, device_id,
      telemetry_schema_version, field_dictionary_version, privacy_contract_version, consented_at)
    VALUES ($1, $2, $3, $4, $5, $6)`, [owner.participantId, owner.deviceId, V1_CONSENT.telemetrySchemaVersion,
    V1_CONSENT.fieldDictionaryVersion, V1_CONSENT.privacyContractVersion, new Date().toISOString()]);
  const directory = await mkdtemp(join(tmpdir(), "intake-v1-backfill-"));
  try {
    const indexFile = join(directory, "index.sqlite");
    const firstDay = Date.parse("2026-08-16T00:00:00.000Z");
    await writeUnifiedIndex(indexFile, Array.from({ length: BACKFILL_DAYS }, (_, index) => {
      const eventKey = Buffer.alloc(32, 0);
      eventKey.writeUInt32BE(index + 1, 28);
      return { eventKey, observedAtMs: firstDay + index * DAY_MS + 1_000, tokens: 10 + index };
    }));
    const result = await runIncrementalContributionSyncOnce({
      indexFile, origin: ORIGIN, backend: {}, fetchImpl,
      withDeviceSecret: async ({ expectedOrigin, operation }) =>
        operation(owner.secret, { origin: expectedOrigin, deviceId: owner.deviceId }),
    });
    assert.equal(result.status, "complete", JSON.stringify(result.failure));
    assert.equal(result.chunksUploaded, BACKFILL_DAYS);
    assert.equal(result.acknowledgedThroughDay, "2026-09-29");
    const uploads = exchanges.filter((exchange) => exchange.path === CONTRIBUTIONS_PATH);
    assert.equal(uploads.length, BACKFILL_DAYS);
    assert.ok(uploads.every((exchange) => exchange.status === 202), "every contribution was admitted");
    // The RECOVERY buckets counted the sync reads and nothing else.
    const syncReads = exchanges.filter((exchange) => exchange.path.startsWith("/api/v1/device/sync/")).length;
    assert.ok(syncReads >= 1);
    const recovery = (await base.query(`SELECT COALESCE(sum(used_count), 0)::int AS used
      FROM ${t("postgres_rate_limit_buckets")} WHERE limiter_name = 'RECOVERY'`)).rows[0].used;
    assert.ok(recovery <= syncReads, `${recovery} device-sync attempts for ${syncReads} sync reads`);
    assert.equal((await base.query(`SELECT count(*)::int AS n FROM ${t("telemetry_v1_chunks")}
      WHERE participant_id = $1`, [owner.participantId])).rows[0].n, BACKFILL_DAYS);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}));

/** A synthetic v0.1 contribution (the IN-3 spec's fixture shape): one usage event, one quota snapshot. */
function v01Contribution() {
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
      lineageDisposition: "standalone", toolClassCounts, outcome: "completed", eventId: `event:v2:${"a".repeat(64)}`,
      accounting: { estimatedApiCostUsd: "1.000000", pricingCoveragePercent: 100, unknownBillableUnits: 0,
        priceBasis: "current_api_prices" },
    }],
    quotaSnapshots: [{
      schemaVersion: "quota-snapshot-v0.1", observedTime: "2026-07-25T12:10:00.000Z",
      receivedTime: "2026-07-25T12:10:01.000Z", provider: "openai_codex", planType: "pro", planVariant: "pro-20x",
      limitId: "codex", slot: "seven_day", usedPercent: 31, displayPrecision: 0, windowDurationMinutes: 10080,
      resetsAt: "2026-07-31T12:00:00.000Z", snapshotSource: "rollout", providerSurface: "account_shared_unallocated",
      snapshotId: `snapshot:v2:${"a".repeat(64)}`,
    }],
    activityMarkers: [],
    accounting: { estimatedApiCostUsd: "1.000000", pricedEventCoveragePercent: 100, unknownModelEventCount: 0,
      unknownBillableUnits: 0, priceBasis: "current_api_prices" },
  };
}

test("a shipped v0.1 client uploads a prepared contribution through the composed v0.1 envelope, then replays", {
  skip: !PG_TEST_SOCKET, timeout: 300_000,
}, () => withOrigin(async (origin) => {
  const { base, t, fetchImpl, exchanges, store } = origin;
  // A social participant at the rank-1 transport floor, as the v1.0 case.
  const owner = await socialOwner(origin, {
    participantId: `synthetic-intake-v01-${randomBytes(4).toString("hex")}`,
    pairingConsent: { consentVersion: V1_CONSENT.privacyContractVersion,
      transportConsentVersion: V1_CONSENT.privacyContractVersion },
  });
  const sync = () => syncPreparedContributionEntryOnce({
    directory: "synthetic-prepared-set", entry: { basename: "synthetic-v01.json" }, origin: ORIGIN, backend: {},
    fetchImpl, cryptoImpl: webcrypto, loadContribution: async () => v01Contribution(),
    withDeviceSecret: async ({ expectedOrigin, operation }) =>
      operation(owner.secret, { origin: expectedOrigin, deviceId: owner.deviceId }),
  });
  const first = await sync();
  assert.equal(first.status, "accepted");
  assert.match(first.contributionId, /^contribution:[0-9a-f-]{36}$/u);
  const authorization = exchanges.find((exchange) => exchange.path === UPLOAD_AUTHORIZATIONS_PATH);
  assert.equal(authorization.status, 201);
  assert.equal(Object.keys(JSON.parse(authorization.body)).sort().join(), "contentLengthBytes,contentType,envelopeDigest");
  const upload = exchanges.find((exchange) => exchange.path === CONTRIBUTIONS_PATH);
  assert.equal(upload.status, 202);
  assert.equal(JSON.parse(upload.body).schemaVersion, "telemetry-envelope-v0.1");

  // The v0.1 admitter wrote the v0.1 rows; no typed v1.0 chunk exists.
  const rows = async () => (await base.query(`SELECT
      (SELECT count(*)::int FROM ${t("telemetry_contributions")} WHERE participant_id = $1) AS contributions,
      (SELECT count(*)::int FROM ${t("telemetry_records")} WHERE participant_id = $1) AS records,
      (SELECT COALESCE(sum(accepted_count), 0)::int FROM ${t("telemetry_contribution_admission_windows")}
        WHERE participant_id = $1) AS admitted,
      (SELECT count(*)::int FROM ${t("telemetry_v1_chunks")} WHERE participant_id = $1) AS v1Chunks`,
  [owner.participantId])).rows[0];
  assert.deepEqual(await rows(), { contributions: 1, records: 2, admitted: 1, v1chunks: 0 });
  const contribution = (await base.query(`SELECT id, r2_key FROM ${t("telemetry_contributions")}
    WHERE participant_id = $1`, [owner.participantId])).rows[0];
  assert.equal(contribution.id, first.contributionId);
  assert.equal(store.objects.get(contribution.r2_key), upload.body);

  // Re-uploading the exact envelope under a fresh three-key authorization replays it.
  const replay = await reupload(fetchImpl, owner.deviceAuthorization, upload.body);
  assert.equal(replay.status, 202);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  const receipt = await replay.json();
  assert.deepEqual([receipt.contributionId, receipt.status, receipt.replayed], [first.contributionId, "accepted", true]);
  assert.deepEqual(await rows(), { contributions: 1, records: 2, admitted: 1, v1chunks: 0 });
  assert.deepEqual(await grantStates(base, t, owner.participantId), [{ state: "consumed", n: 2 }]);
}));

async function withPinnedRequestId(work) {
  const webCrypto = globalThis.crypto;
  const original = webCrypto.randomUUID;
  webCrypto.randomUUID = () => PINNED_REQUEST_ID;
  try {
    return await work();
  } finally {
    webCrypto.randomUUID = original;
  }
}

test("unregistered envelope versions keep the pre-change refusal byte for byte; unauthorized formats are 403", {
  skip: !PG_TEST_SOCKET, timeout: 300_000,
}, () => withOrigin(async (origin) => {
  const { fetchImpl } = origin;
  const owner = await socialOwner(origin, {
    participantId: `synthetic-intake-refusal-${randomBytes(4).toString("hex")}`,
    pairingConsent: { consentVersion: origin.m.constants.TELEMETRY_CONSENT_VERSION,
      transportConsentVersion: "ongoing-privacy-safe-telemetry-v1.0" },
  });
  const sixKeys = (schemaVersion) => JSON.stringify({
    schemaVersion, synthetic: false, keyId: "key:synthetic-golden", wrappedKey: "A".repeat(342),
    iv: "B".repeat(16), ciphertext: "C".repeat(64),
  });
  for (const [label, body, status] of [
    ["a v0.2 envelope with the six envelope keys", sixKeys("telemetry-envelope-v0.2"), 500],
    ["a v1.3 envelope with the six envelope keys", sixKeys("telemetry-envelope-v1.3"), 500],
    ["a v9.0 envelope with other keys", JSON.stringify({ schemaVersion: "telemetry-envelope-v9.0", payload: "x" }), 400],
    ["an envelope without a schemaVersion", JSON.stringify({ synthetic: false, keyId: "key:x", extra: 1 }), 400],
  ]) {
    for (const authorization of [undefined, `Upload um_device_upload_${randomUUID()}.${"A".repeat(43)}`]) {
      const answer = await withPinnedRequestId(async () => {
        const response = await post(fetchImpl, CONTRIBUTIONS_PATH, body,
          authorization === undefined ? {} : { authorization });
        return { status: response.status, headers: [...response.headers], text: await response.text() };
      });
      assert.equal(answer.status, authorization === undefined ? 401 : status, label);
      assert.deepEqual(answer.headers, PRE_CHANGE_HEADERS, label);
      assert.equal(answer.text, authorization === undefined
        ? PREFLIGHT_UPLOAD_AUTH_INVALID_BODY : PRE_CHANGE_ENVELOPE_INVALID_BODY, label);
    }
  }
  // d43c8f92 answers an unknown transport, and v0.2's blocked lifecycle, 403
  // before issuing anything; the shipped three-key body defaults to v1.0.
  for (const telemetrySchemaVersion of ["telemetry-contribution-v9.9", "telemetry-contribution-v0.2"]) {
    const refused = await post(fetchImpl, UPLOAD_AUTHORIZATIONS_PATH, {
      envelopeDigest: "a".repeat(64), contentLengthBytes: 10, contentType: "application/json", telemetrySchemaVersion,
    }, { authorization: owner.deviceAuthorization });
    assert.equal(refused.status, 403, telemetrySchemaVersion);
    assert.equal((await refused.json()).error.code, "TELEMETRY_TRANSPORT_BLOCKED");
  }
  // The v1.1 routes, and the shared upload-authorization and contributions
  // routes, answer a wrong method with the Worker registry's 405 and Allow.
  for (const path of ["/api/v1/me/telemetry-v11/domain-activate", UPLOAD_AUTHORIZATIONS_PATH, CONTRIBUTIONS_PATH]) {
    for (const method of ["GET", "PUT", "DELETE", "OPTIONS"]) {
      const wrongMethod = await fetchImpl(new URL(path, ORIGIN), { method });
      assert.equal(wrongMethod.status, 405, `${method} ${path}`);
      assert.equal(wrongMethod.headers.get("allow"), "POST", `${method} ${path}`);
      assert.equal((await wrongMethod.json()).error.code, "METHOD_NOT_ALLOWED", `${method} ${path}`);
    }
  }
  assert.deepEqual(await grantStates(origin.base, origin.t, owner.participantId), []);
}));
