import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash, randomBytes, randomUUID, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createServer } from "vite";
import {
  canonicalTelemetryV11Json,
  telemetryV11DayManifestDigestInput,
  telemetryV11DomainManifestDigestInput,
  telemetryV11RequiredConsent,
  validateTelemetryV11Envelope,
} from "@app-usagemonitor/telemetry-contract";
import { applyPostgresMigrations } from "../cloud-run/postgres-migrations.mjs";
import { createContributionEnvelopeRegistry } from "../cloud-run/contribution-envelope-registry.mjs";
import { createOriginRouteModuleRegistry } from "../cloud-run/origin-route-modules.mjs";
import { createTelemetryV11ContributionEnvelope } from "../cloud-run/envelopes/v11.mjs";
import { createTelemetryV11ConsentRouteModule } from "../cloud-run/routes/v11-device-telemetry-consents.mjs";
import { createTelemetryV11DayManifestRouteModules } from "../cloud-run/routes/v11-day-manifests.mjs";
import { createTelemetryV11DomainPredecessorRouteModule } from "../cloud-run/routes/v11-domain-predecessor.mjs";
import { createTelemetryV11DomainActivateRouteModule } from "../cloud-run/routes/v11-domain-activate.mjs";
import { applyStockAndStagedMigrations, postgresTestEndpoint } from "./staged-migrations-harness.mjs";
import { telemetryV11DayShape, TELEMETRY_V11_SHAPE_TABLES } from "./fixtures/telemetry-v11-row-shape.mjs";

/*
 * PostgreSQL 17 qualification of the live v1.1 intake family (GCP fast path,
 * IN-2): consent, day manifests, the telemetry-envelope-v1.1 contribution
 * handler, domain predecessor and activation, with the staged primary
 * migration 0060_telemetry_v11_live_admission.sql on top of the promoted
 * chain. The oracle is d43c8f92 (typed v1.1 storage, as production runs it).
 *
 * The rows one day writes are compared, id-free, with the rows the Q-1
 * production-code oracle wrote for the same synthetic owner-day
 * (fixtures/telemetry-v11-live-q1-owner-a-2026-09-30.json, extracted from the
 * Q-1 D1 dump by fixtures/extract-telemetry-v11-q1-day.mjs).
 *
 * The route modules and the envelope registration are driven directly: the
 * origin cannot mount additive (non built-in) route modules yet, and the
 * contributions preamble is IN-1b's. The test plays the preamble's part
 * (claim, then abandon on a failure before persistence) with the production
 * PostgreSQL claim and abandon adapters. Rate-limit adapters are stubs.
 *
 * Connection: PG_TEST_SOCKET or loopback PG_TEST_HOST; without either the
 * test skips (a skip is not a pass). Every row is synthetic and content-free.
 */

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGED = "0060_telemetry_v11_live_admission.sql";
const SOURCE_NAMESPACE = "gcp-fastpath-oracle";
const ORIGIN = "http://127.0.0.1:8787";
const DAY_MS = 86_400_000;
const endpoint = await postgresTestEndpoint();
const fixture = JSON.parse(await readFile(
  resolve(WORKER_ROOT, "postgres-test/fixtures/telemetry-v11-live-q1-owner-a-2026-09-30.json"), "utf8",
));

let vite;
const loaded = new Map();
async function load(path) {
  vite ??= await createServer({ root: WORKER_ROOT, configFile: false, server: { middlewareMode: true }, appType: "custom" });
  if (!loaded.has(path)) loaded.set(path, await vite.ssrLoadModule(path));
  return loaded.get(path);
}
after(async () => { await vite?.close(); });

const q = (schema, name) => `"${schema}"."${name}"`;
const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

function bearerSecretHash(deviceId, secret) {
  return createHash("sha256")
    .update(`app-usagemonitor/device/v1\0${deviceId}\0`)
    .update(Buffer.from(secret, "base64url"))
    .digest();
}

function uploadSecretHash(authorizationId, secret) {
  return createHash("sha256")
    .update(`app-usagemonitor/device-upload/v1\0${authorizationId}\0${secret}`)
    .digest();
}

async function envelopeKeys() {
  const pair = await webcrypto.subtle.generateKey({
    name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
  }, true, ["encrypt", "decrypt"]);
  const publicJwk = { ...await webcrypto.subtle.exportKey("jwk", pair.publicKey), kid: "key:v11-live-test" };
  const privateJwk = { ...await webcrypto.subtle.exportKey("jwk", pair.privateKey), kid: "key:v11-live-test" };
  return { publicJwk, publicJwkRaw: JSON.stringify(publicJwk), privateJwkRaw: JSON.stringify(privateJwk) };
}

/** The shipped client's v1.1 envelope: RSA-OAEP wrapped AES-GCM over the canonical chunk. */
async function encryptV11Envelope(plaintext, publicJwk) {
  const rsaJwk = { ...publicJwk };
  delete rsaJwk.kid;
  const rsa = await webcrypto.subtle.importKey("jwk", rsaJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const aes = await webcrypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const rawKey = await webcrypto.subtle.exportKey("raw", aes);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const wrappedKey = await webcrypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, rawKey);
  const ciphertext = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, aes,
    new TextEncoder().encode(typeof plaintext === "string" ? plaintext : canonicalTelemetryV11Json(plaintext)));
  const envelope = {
    schemaVersion: "telemetry-envelope-v1.1", synthetic: false, keyId: publicJwk.kid,
    wrappedKey: Buffer.from(wrappedKey).toString("base64url"),
    iv: Buffer.from(iv).toString("base64url"),
    ciphertext: Buffer.from(ciphertext).toString("base64url"),
  };
  validateTelemetryV11Envelope(envelope);
  return envelope;
}

/** test/helpers/telemetry-v11.ts makeV11Day, as the Q-1 oracle staged its days. */
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

function domainManifest(predecessor, days) {
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

function utcDays(fromDay, throughDay) {
  const days = [];
  for (let epoch = Date.parse(`${fromDay}T00:00:00.000Z`); epoch <= Date.parse(`${throughDay}T00:00:00.000Z`); epoch += DAY_MS) {
    days.push(new Date(epoch).toISOString().slice(0, 10));
  }
  return days;
}

/** to_jsonb rows with bytea as lowercase hex, the shape module's input. */
async function shapeTables(pool, schema) {
  const tables = {};
  for (const name of TELEMETRY_V11_SHAPE_TABLES) {
    const result = await pool.query(`SELECT to_jsonb(t) AS row FROM ${q(schema, name)} t`);
    tables[name] = result.rows.map(({ row }) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
      key, typeof value === "string" && value.startsWith("\\x") ? value.slice(2).toLowerCase() : value,
    ])));
  }
  return tables;
}

/** The owner link, receipts and exact journal rows the v1.1 bridge wrote for one participant. */
async function bridgeState(pool, schema, participantId) {
  const link = (await pool.query(
    `SELECT owner_digest, state, generation_id, head_revision::int AS head_revision, object_digest, manifest_digest
       FROM ${q(schema, "storage_v11_owner_links")} WHERE participant_id = $1`, [participantId],
  )).rows[0] ?? null;
  const receipts = (await pool.query(
    `SELECT event_digest, owner_digest, generation_id, manifest_digest, head_revision::int AS head_revision,
            input_revision::int AS input_revision, to_char(from_day, 'YYYY-MM-DD') AS from_day,
            to_char(through_day, 'YYYY-MM-DD') AS through_day
       FROM ${q(schema, "storage_v11_event_sources")} WHERE participant_id = $1 ORDER BY head_revision`,
    [participantId],
  )).rows;
  const journal = link === null ? [] : (await pool.query(
    `SELECT kind, revision::int AS revision, event_digest, object_digest, content_digest,
            event_tuple_version::int AS event_tuple_version
       FROM ${q(schema, "storage_ingestion_changes")} WHERE owner_digest = $1 ORDER BY sequence`,
    [link.owner_digest],
  )).rows;
  return { link, receipts, journal };
}

async function apiError(response, status, code) {
  assert.equal(response.status, status, `expected ${status} ${code}`);
  const body = await response.json();
  assert.equal(body?.error?.code, code);
  assert.match(body?.error?.requestId ?? "", /^[0-9a-f-]{36}$/u);
  return body;
}

test("PostgreSQL 17 runs a full v1.1 upload cycle with Worker-equal rows, replay and closed schemas", {
  skip: endpoint === null,
  timeout: 300_000,
}, async () => {
  const poolOptions = {
    host: endpoint.host, port: endpoint.port, user: endpoint.user, database: endpoint.database,
    password: endpoint.password ?? "synthetic-local-only", ssl: false, max: 6, connectionTimeoutMillis: 5_000,
  };
  const primaryPool = new pg.Pool({ ...poolOptions, application_name: "pg-v11-live-primary-test" });
  const ledgerPool = new pg.Pool({ ...poolOptions, application_name: "pg-v11-live-ledger-test" });
  const suffix = randomBytes(5).toString("hex");
  const primarySchema = `v11live_${suffix}`;
  const ledgerSchema = `v11live_l_${suffix}`;
  const schema = Object.freeze({ primarySchema, ledgerSchema });
  let primaryCreated = false;
  let ledgerCreated = false;
  try {
    const server = await primaryPool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17, "v1.1 live admission is qualified on PostgreSQL 17");
    await primaryPool.query(`CREATE SCHEMA "${primarySchema}"`);
    primaryCreated = true;
    await ledgerPool.query(`CREATE SCHEMA "${ledgerSchema}"`);
    ledgerCreated = true;
    const applied = await applyStockAndStagedMigrations({
      role: "primary", schema: primarySchema, pool: primaryPool, stagedFiles: [STAGED],
    });
    assert.ok(applied.staged.some((entry) => entry.name === STAGED) || applied.promoted.includes(STAGED));
    await applyPostgresMigrations({ role: "ledger", schema: ledgerSchema, pool: ledgerPool });

    const live = await load("/src/postgres-telemetry-v11-live-admission.ts");
    const bearer = await load("/src/postgres-device-bearer-auth.ts");
    const transport = await load("/src/postgres-typed-v12-transport.ts");
    const ledgerAuthority = await load("/src/postgres-ledger-authority.ts");
    const personalDevices = await load("/src/postgres-personal-devices.ts");
    const controls = await load("/src/postgres-collection-controls.ts");
    const crypto = await load("/src/crypto.ts");
    const boundedBody = await load("/src/bounded-body.ts");
    const constants = await load("/src/constants.ts");
    const sessionModule = await load("/src/session.ts");
    const routeRegistry = await load("/src/route-registry.ts");

    await primaryPool.query(
      `UPDATE ${q(primarySchema, "collection_controls")}
          SET control_state = 'operational', enrollment_enabled = true,
              upload_registration_enabled = true, processing_enabled = true,
              publication_enabled = true, revision = revision + 1, updated_at = clock_timestamp()
        WHERE singleton = 1`,
    );
    // D1 fixtures opt in to the accepted successor lifecycle the same way.
    await primaryPool.query(
      `UPDATE ${q(primarySchema, "telemetry_transport_formats")} SET lifecycle = 'accepted'
        WHERE schema_version = 'telemetry-contribution-v1.1'`,
    );
    const options = { schema, sourceNamespace: SOURCE_NAMESPACE };
    await live.initializePostgresTypedV11Admission(primaryPool, options);
    await live.initializePostgresTypedV11Admission(primaryPool, options);
    await assert.rejects(
      live.initializePostgresTypedV11Admission(primaryPool, { schema, sourceNamespace: "another-namespace" }),
      { code: "BACKEND_STORAGE_UNAVAILABLE" },
    );

    // Owner (a) of the Q-1 corpus: a social participant, so typed owner ids match.
    const nowEpoch = Date.now();
    const now = new Date(nowEpoch).toISOString();
    const expiresAt = new Date(nowEpoch + 30 * DAY_MS).toISOString();
    const participantId = fixture.participantId;
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "participants")} (id, owner_kind, state, consent_version, created_at)
       VALUES ($1, 'social', 'active', $2, $3)`,
      [participantId, constants.TELEMETRY_CONSENT_VERSION, now],
    );
    const session = await sessionModule.createSessionMaterial(participantId, nowEpoch);
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "web_sessions")} (
         id, participant_id, secret_hash, csrf_hash, scope, state, issued_at, expires_at, last_used_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $6)`,
      [session.id, participantId, session.secretHash, session.csrfHash, session.scope, session.issuedAt, session.expiresAt],
    );
    const cookie = sessionModule.sessionCookie(session).split(";", 1)[0];
    const deviceId = randomUUID();
    const pairingId = randomUUID();
    const deviceSecret = randomBytes(32).toString("base64url");
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "device_pairings")} (
         id, participant_id, issued_by_session_id, secret_hash, consent_version,
         transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
       ) VALUES ($1, $2, $3, $4, $5, 'ongoing-privacy-safe-telemetry-v1.0', 'consumed', $6, $7, $6, $8)`,
      [pairingId, participantId, session.id, randomBytes(32), constants.TELEMETRY_CONSENT_VERSION, now, expiresAt, deviceId],
    );
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "device_credentials")} (
         id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
         state, issued_at, expires_at, last_used_at, social_verified_at
       ) VALUES ($1, $2, 'social', $3, $4, 'active', $5, $6, $5, $5)`,
      [deviceId, participantId, pairingId, bearerSecretHash(deviceId, deviceSecret), now, expiresAt],
    );
    const deviceAuthorization = `Device um_device_${deviceId}.${deviceSecret}`;
    const principal = Object.freeze({ participantId, deviceId });

    const keys = await envelopeKeys();
    const objects = new Map();
    const objectStore = {
      async put(key, bytes) { objects.set(key, Uint8Array.from(bytes)); },
      async delete(key) { objects.delete(key); },
    };

    // ------------------------------------------------ composition (IN-1b's) --
    const deviceRouteDependencies = {
      primaryPool, ledgerPool, schema,
      admissionEnv: {},
      assertAdmissionBindings() {},
      async assertAttemptAllowed() {},
      authenticateDevice: (pool, header, routeOptions) => bearer.authenticatePostgresDeviceBearer(pool, header, routeOptions),
      hasDeletionTombstone: ledgerAuthority.hasPostgresDeletionTombstone,
      assertCollectionControl: controls.assertPostgresCollectionControlFromPool,
      readBoundedRequestBody: boundedBody.readBoundedRequestBody,
      maxRequestBytes: constants.MAX_REQUEST_BYTES,
    };
    const consentRoute = createTelemetryV11ConsentRouteModule({
      primaryPool, ledgerPool, schema,
      authenticatePersonalSession: personalDevices.authenticatePostgresPersonalSession,
      assertPersonalSessionCsrf: personalDevices.assertPostgresPersonalSessionCsrf,
      hasDeletionTombstone: ledgerAuthority.hasPostgresDeletionTombstone,
      assertCollectionControl: controls.assertPostgresCollectionControlFromPool,
      grantConsent: live.grantPostgresTelemetryV11Consent,
      readBoundedRequestBody: boundedBody.readBoundedRequestBody,
      maxRequestBytes: constants.MAX_REQUEST_BYTES,
      socialConsentVersion: constants.TELEMETRY_CONSENT_VERSION,
    });
    const [manifestGet, manifestPost] = createTelemetryV11DayManifestRouteModules({
      ...deviceRouteDependencies,
      registerDayManifest: live.registerPostgresTelemetryV11DayManifest,
      readDayChunkVector: live.readPostgresTelemetryV11DayChunkVector,
      readDayCandidates: live.readPostgresTelemetryV11DayCandidates,
    });
    const domainDependencies = { ...deviceRouteDependencies, createDomain: live.createPostgresTelemetryV11Domain };
    const predecessorRoute = createTelemetryV11DomainPredecessorRouteModule(domainDependencies);
    const activateRoute = createTelemetryV11DomainActivateRouteModule(domainDependencies);
    const envelopes = createContributionEnvelopeRegistry([createTelemetryV11ContributionEnvelope({
      readStorageReplay: live.readPostgresTelemetryV11StorageReplay,
      persistStagedChunk: live.persistPostgresTypedV11StagedChunk,
      readUploadOutcome: live.readPostgresTelemetryV11UploadOutcome,
      recordUploadReceipt: live.recordPostgresTelemetryV11UploadReceipt,
      registerPendingObject: live.registerPostgresTelemetryV11PendingObject,
      retirePendingObject: live.retirePostgresTelemetryV11PendingObject,
      abandonUploadAuthorization: transport.abandonPostgresDeviceUploadAuthorization,
      validateStagedChunk: live.validatePostgresTelemetryV11StagedChunk,
      decryptSyntheticEnvelope: crypto.decryptSyntheticEnvelope,
      sha256Hex: crypto.sha256Hex,
      socialConsentVersion: constants.TELEMETRY_CONSENT_VERSION,
      sourceNamespace: SOURCE_NAMESPACE,
      envelopePublicJwk: keys.publicJwkRaw,
      envelopePrivateJwk: keys.privateJwkRaw,
    })]);
    const v11Handler = envelopes.resolve("telemetry-envelope-v1.1");
    assert.equal(typeof v11Handler, "function");
    assert.deepEqual(envelopes.schemaVersions, ["telemetry-envelope-v1.1"]);
    // Hand-off evidence: the IN-1a seam only replaces named built-ins, so it
    // refuses these additive v1.1 routes until the lead extends it.
    assert.throws(() => createOriginRouteModuleRegistry({
      modules: [consentRoute, manifestGet, manifestPost, predecessorRoute, activateRoute],
      routePolicy: routeRegistry.WORKER_ROUTE_POLICY,
    }), { message: /ORIGIN_ROUTE_MODULE_INVALID: \/api\/v1\/me\/device-telemetry-consents is a built-in route/u });
    for (const routeModule of [consentRoute, manifestGet, manifestPost, predecessorRoute, activateRoute]) {
      const policy = routeRegistry.WORKER_ROUTE_POLICY.find((entry) => entry.pathname === routeModule.pathname);
      assert.ok(policy && (policy.methods === "all" || policy.methods.includes(routeModule.method)),
        `${routeModule.method} ${routeModule.pathname} is a Worker registry route`);
    }

    const deviceRequest = (path, method, body, headers = {}) => new Request(`${ORIGIN}${path}`, {
      method,
      headers: { authorization: deviceAuthorization, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const consentRequest = (body) => new Request(`${ORIGIN}/api/v1/me/device-telemetry-consents`, {
      method: "POST",
      headers: {
        origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json",
        cookie, "x-usage-monitor-csrf": session.csrfToken,
      },
      body: JSON.stringify(body),
    });

    // ------------------------------------------------------------ consent --
    const consentBody = { deviceId, consent: telemetryV11RequiredConsent(), ongoingUpload: true };
    await apiError(await consentRoute.handler(consentRequest({ ...consentBody, extra: true })), 400, "BODY_INVALID");
    await apiError(await consentRoute.handler(consentRequest({ ...consentBody, ongoingUpload: false })), 400, "BODY_INVALID");
    await apiError(await consentRoute.handler(consentRequest({
      ...consentBody, consent: { ...telemetryV11RequiredConsent(), unknown: "field" },
    })), 403, "TELEMETRY_CONSENT_INVALID");
    // Before consent the v1.1 transport is refused for this device.
    await apiError(await manifestPost.handler(deviceRequest(
      "/api/v1/device/telemetry/v1.1/day-manifests", "POST",
      makeV11Day(fixture.day, fixture.records, fixture.parserVersion).manifest,
    )), 403, "TELEMETRY_CONSENT_INVALID");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const granted = await consentRoute.handler(consentRequest(consentBody));
      assert.equal(granted.status, 201);
      assert.equal(granted.headers.get("vary"), "Cookie");
      assert.deepEqual(await granted.json(), { consent: telemetryV11RequiredConsent(), minimumWriteRank: 11 });
    }
    const floors = await primaryPool.query(
      `SELECT (SELECT minimum_rank FROM ${q(primarySchema, "telemetry_transport_participant_floors")} WHERE participant_id = $1) AS participant,
              (SELECT minimum_rank FROM ${q(primarySchema, "telemetry_transport_device_floors")} WHERE participant_id = $1 AND device_id = $2) AS device,
              (SELECT count(*)::int FROM ${q(primarySchema, "telemetry_v11_device_consents")} WHERE participant_id = $1) AS consents`,
      [participantId, deviceId],
    );
    assert.deepEqual(floors.rows[0], { participant: 11, device: 11, consents: 1 });

    // ------------------------------------------------------------ manifest --
    const prepared = makeV11Day(fixture.day, fixture.records, fixture.parserVersion);
    assert.equal(prepared.manifest.manifestDigest, fixture.expected.manifest.manifestDigest,
      "the PostgreSQL upload stages the Q-1 oracle's exact synthetic day");
    await apiError(await manifestPost.handler(deviceRequest(
      "/api/v1/device/telemetry/v1.1/day-manifests", "POST", { ...prepared.manifest, unknownField: 1 },
    )), 400, "TELEMETRY_MANIFEST_INVALID");
    await apiError(await manifestPost.handler(deviceRequest(
      "/api/v1/device/telemetry/v1.1/day-manifests", "POST",
      { ...prepared.manifest, chunks: prepared.manifest.chunks.map((chunk) => ({ ...chunk, note: "x" })) },
    )), 400, "TELEMETRY_MANIFEST_INVALID");
    await apiError(await manifestPost.handler(deviceRequest(
      "/api/v1/device/telemetry/v1.1/day-manifests", "POST", { ...prepared.manifest, manifestDigest: "f".repeat(64) },
    )), 400, "CHUNK_DIGEST_MISMATCH");
    const registered = await manifestPost.handler(deviceRequest(
      "/api/v1/device/telemetry/v1.1/day-manifests", "POST", prepared.manifest,
    ));
    assert.equal(registered.status, 201);
    const candidate = await registered.json();
    assert.deepEqual({ ...candidate, manifestId: "<id>" }, {
      manifestId: "<id>", day: fixture.day, manifestDigest: prepared.manifest.manifestDigest,
      state: "staged", expectedChunks: 3, stagedChunks: [],
    });
    const reRegistered = await (await manifestPost.handler(deviceRequest(
      "/api/v1/device/telemetry/v1.1/day-manifests", "POST", prepared.manifest,
    ))).json();
    assert.equal(reRegistered.manifestId, candidate.manifestId);
    await apiError(await manifestGet.handler(deviceRequest(
      `/api/v1/device/telemetry/v1.1/day-manifests?fromDay=${fixture.day}&toDay=${fixture.day}&x=1`, "GET",
    )), 400, "BODY_INVALID");
    await apiError(await manifestGet.handler(deviceRequest(
      "/api/v1/device/telemetry/v1.1/day-manifests?fromDay=2026-01-01&toDay=2026-03-01", "GET",
    )), 400, "SYNC_RANGE_TOO_LARGE");

    // ------------------------------------------------------------- chunks --
    // The test plays the contributions preamble: a bounded one-use grant is
    // claimed against the exact body, and a failure before persistence
    // abandons it.
    async function claimFor(raw) {
      const authorizationId = randomUUID();
      const secret = randomBytes(32).toString("base64url");
      const bodyBytes = new TextEncoder().encode(raw).byteLength;
      const envelopeDigest = sha256Hex(raw);
      await primaryPool.query(
        `INSERT INTO ${q(primarySchema, "device_upload_authorizations")} (
           id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
           body_bytes, content_type, state, issued_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'application/json', 'unused', $7, $8)`,
        [authorizationId, participantId, deviceId, uploadSecretHash(authorizationId, secret), envelopeDigest,
          bodyBytes, new Date(Date.now() - 1_000).toISOString(), new Date(Date.now() + 5 * 60_000).toISOString()],
      );
      const claimed = await transport.claimPostgresDeviceUploadAuthorization(primaryPool,
        `Upload um_device_upload_${authorizationId}.${secret}`,
        { envelopeDigest, bodyBytes, contentType: "application/json" }, { schema });
      return { claimed, envelopeDigest, authorizationId };
    }
    const participantRow = { id: participantId, consentVersion: constants.TELEMETRY_CONSENT_VERSION, ownerKind: "social" };
    async function contribute(plaintext, rawOverride) {
      const raw = rawOverride ?? JSON.stringify(await encryptV11Envelope(plaintext, keys.publicJwk));
      const { claimed, envelopeDigest, authorizationId } = await claimFor(raw);
      let persistStarted = false;
      try {
        const response = await v11Handler({ raw, value: JSON.parse(raw) }, participantRow, deviceId, claimed, {
          raw, envelopeDigest, primaryPool, schema, objectStore,
          markPersistStarted() { persistStarted = true; },
        });
        return { response, authorizationId };
      } catch (error) {
        if (!persistStarted) await transport.abandonPostgresDeviceUploadAuthorization(primaryPool, claimed, principal, { schema });
        return { error, authorizationId };
      }
    }
    const grantState = async (authorizationId) => (await primaryPool.query(
      `SELECT state, consumed_contribution_id FROM ${q(primarySchema, "device_upload_authorizations")} WHERE id = $1`,
      [authorizationId],
    )).rows[0];

    // Closed schemas: an unknown envelope key and an unknown chunk field.
    const goodEnvelope = await encryptV11Envelope(prepared.chunks[0], keys.publicJwk);
    const extraKey = await contribute(null, JSON.stringify({ ...goodEnvelope, extra: "field" }));
    assert.deepEqual({ status: extraKey.error?.status, code: extraKey.error?.code }, { status: 400, code: "ENVELOPE_INVALID" });
    assert.equal((await grantState(extraKey.authorizationId)).state, "revoked");
    const unknownChunkField = await contribute({ ...prepared.chunks[0], unknownField: true });
    assert.deepEqual({ status: unknownChunkField.error?.status, code: unknownChunkField.error?.code },
      { status: 400, code: "CHUNK_INVALID" });
    const unknownRecordField = await contribute({
      ...prepared.chunks[0],
      records: prepared.chunks[0].records.map((record, index) => (index === 0 ? { ...record, prompt: "x" } : record)),
    });
    assert.deepEqual({ status: unknownRecordField.error?.status, code: unknownRecordField.error?.code },
      { status: 400, code: "CHUNK_INVALID" });
    const wrongDigest = await contribute({ ...prepared.chunks[0], chunkDigest: "e".repeat(64) });
    assert.deepEqual({ status: wrongDigest.error?.status, code: wrongDigest.error?.code },
      { status: 400, code: "CHUNK_DIGEST_MISMATCH" });
    const socialWithoutConsent = await v11Handler({ raw: JSON.stringify(goodEnvelope), value: goodEnvelope },
      { ...participantRow, consentVersion: null }, deviceId, { authorizationId: randomUUID() },
      { raw: JSON.stringify(goodEnvelope), primaryPool, schema, objectStore }).catch((error) => error);
    assert.deepEqual({ status: socialWithoutConsent.status, code: socialWithoutConsent.code },
      { status: 400, code: "TELEMETRY_REQUIRED" });

    const receipts = [];
    for (const chunk of prepared.chunks) {
      const uploaded = await contribute(chunk);
      assert.equal(uploaded.error, undefined, uploaded.error?.code);
      assert.equal(uploaded.response.status, 202);
      assert.equal(uploaded.response.headers.get("idempotency-replayed"), null);
      const body = await uploaded.response.json();
      assert.deepEqual({ ...body, contributionId: "<id>" }, {
        schemaVersion: "telemetry-chunk-receipt-v1.1", contributionId: "<id>", manifestId: candidate.manifestId,
        chunkId: chunk.chunkId, chunkRevision: 1, status: "staged", replayed: false,
        recordCounts: { declared: chunk.records.length, accepted: chunk.records.length },
      });
      assert.match(body.contributionId, /^chunk:[0-9a-f-]{36}$/u);
      assert.deepEqual(await grantState(uploaded.authorizationId), { state: "consumed", consumed_contribution_id: body.contributionId });
      receipts.push(body);
    }
    assert.equal(objects.size, prepared.chunks.length, "one retained envelope object per admitted chunk");
    const pending = await primaryPool.query(
      `SELECT count(*)::int AS n FROM ${q(primarySchema, "pending_objects")} WHERE object_kind = 'telemetry_v11'
          AND reconciliation_state = 'registered'`,
    );
    assert.equal(pending.rows[0].n, prepared.chunks.length);
    const afterUpload = await (await manifestPost.handler(deviceRequest(
      "/api/v1/device/telemetry/v1.1/day-manifests", "POST", prepared.manifest,
    ))).json();
    assert.equal(afterUpload.state, "ready");
    assert.deepEqual(afterUpload.stagedChunks, prepared.chunks.map((chunk) => ({
      chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: chunk.records.length,
    })));

    // Idempotent re-upload: a new grant, the same chunk. The receipt names the
    // retained contribution, the grant is bound to it, nothing new is written.
    const counts = async () => (await primaryPool.query(
      `SELECT (SELECT count(*)::int FROM ${q(primarySchema, "telemetry_v11_chunks")}) AS chunks,
              (SELECT count(*)::int FROM ${q(primarySchema, "typed_telemetry_records")}) AS records,
              (SELECT count(*)::int FROM ${q(primarySchema, "typed_v11_record_proofs")}) AS proofs,
              (SELECT next_source_row_id::int FROM ${q(primarySchema, "typed_v11_admission_state")}) AS next_row`,
    )).rows[0];
    const before = await counts();
    assert.deepEqual(before, { chunks: 3, records: 30, proofs: 30, next_row: 31 });
    for (const [index, chunk] of prepared.chunks.entries()) {
      const replayed = await contribute(chunk);
      assert.equal(replayed.response.status, 202);
      assert.equal(replayed.response.headers.get("idempotency-replayed"), "true");
      const body = await replayed.response.json();
      assert.equal(body.replayed, true);
      assert.equal(body.contributionId, receipts[index].contributionId);
      assert.deepEqual(await grantState(replayed.authorizationId), {
        state: "consumed", consumed_contribution_id: receipts[index].contributionId,
      });
    }
    assert.deepEqual(await counts(), before);
    assert.equal(objects.size, prepared.chunks.length, "a replay writes no object");
    // The same chunk identity with different content is a conflict.
    const changed = { ...prepared.chunks[0], records: prepared.chunks[0].records.slice(0, 1) };
    changed.chunkDigest = sha256Hex(canonicalTelemetryV11Json(changed.records));
    const conflicting = await contribute(changed);
    assert.deepEqual({ status: conflicting.error?.status, code: conflicting.error?.code },
      { status: 409, code: "TELEMETRY_MANIFEST_CONFLICT" });

    // ---------------------------------------- rows equal the Q-1 D1 oracle --
    const shape = telemetryV11DayShape(await shapeTables(primaryPool, primarySchema), {
      participantId, day: fixture.day, ownerOriginalHex: fixture.ownerOriginalHex,
    });
    assert.deepEqual(shape, fixture.expected);
    // The oracle's base digest omits accountPlanAttribution: it equals the
    // typed canonical digest for session rows only, so 0033's equality could
    // not admit any production usage or quota proof.
    for (const chunk of fixture.expected.chunks) {
      for (const record of chunk.records) {
        assert.equal(record.proof.baseDigest === record.canonicalDigest, record.stream === "session",
          `${record.stream} base and canonical digests`);
      }
    }
    // 0060 keeps that equality for session rows. Re-prove one session and one
    // quota row with a wrong base digest inside a rolled-back transaction.
    const guardClient = await primaryPool.connect();
    try {
      for (const [stream, admitted] of [["session", false], ["quota", true]]) {
        await guardClient.query("BEGIN");
        try {
          const proof = (await guardClient.query(
            `SELECT p.* FROM ${q(primarySchema, "typed_v11_record_proofs")} p
              WHERE p.stream_code = $1 ORDER BY p.typed_record_id LIMIT 1`,
            [stream === "session" ? 3 : 2],
          )).rows[0];
          await guardClient.query(
            `DELETE FROM ${q(primarySchema, "typed_v11_record_proofs")} WHERE typed_record_id = $1`,
            [proof.typed_record_id],
          );
          const reinsert = guardClient.query(
            `INSERT INTO ${q(primarySchema, "typed_v11_record_proofs")} (
               typed_record_id, chunk_key, manifest_key, stream_code, occurrence_blob, base_digest,
               legacy_occurrence_blob, legacy_digest, observed_at_ms
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [proof.typed_record_id, proof.chunk_key, proof.manifest_key, proof.stream_code, proof.occurrence_blob,
              Buffer.alloc(32, 7), proof.legacy_occurrence_blob, proof.legacy_digest, proof.observed_at_ms],
          );
          if (admitted) await reinsert;
          else await assert.rejects(reinsert, { message: "typed_legacy_admission_parent_missing" });
        } finally {
          await guardClient.query("ROLLBACK");
        }
      }
    } finally {
      guardClient.release();
    }

    // -------------------------------------------- predecessor and activate --
    await apiError(await predecessorRoute.handler(deviceRequest(
      "/api/v1/me/telemetry-v11/domain-predecessor", "POST", { previousGenerationId: null },
    )), 400, "BODY_INVALID");
    const predecessorResponse = await predecessorRoute.handler(deviceRequest(
      "/api/v1/me/telemetry-v11/domain-predecessor", "POST", {},
    ));
    assert.equal(predecessorResponse.status, 201);
    const predecessor = await predecessorResponse.json();
    assert.equal(predecessor.schemaVersion, "telemetry-domain-predecessor-v1.1");
    assert.equal(predecessor.previousGenerationId, null);
    const today = new Date().toISOString().slice(0, 10);
    assert.deepEqual([predecessor.fromDay, predecessor.throughDay], [today, today]);

    // A domain covers every day of its range: empty days are complete manifests.
    const readyDays = [{ day: fixture.day, manifestId: candidate.manifestId, manifestDigest: candidate.manifestDigest }];
    for (const day of utcDays(fixture.day, today).slice(1)) {
      const empty = makeV11Day(day, {}, fixture.parserVersion);
      const emptyCandidate = await (await manifestPost.handler(deviceRequest(
        "/api/v1/device/telemetry/v1.1/day-manifests", "POST", empty.manifest,
      ))).json();
      assert.equal(emptyCandidate.state, "ready");
      readyDays.push({ day, manifestId: emptyCandidate.manifestId, manifestDigest: emptyCandidate.manifestDigest });
    }
    // The v1.1 owner bridge journals only once the analytics source exists.
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "storage_source_state")} (singleton, source_id, authority_epoch)
       VALUES (1, 'synthetic-v11-live-source', 0)`,
    );
    assert.deepEqual(await bridgeState(primaryPool, primarySchema, participantId), { link: null, receipts: [], journal: [] });
    const activation = domainManifest(predecessor, readyDays);
    await apiError(await activateRoute.handler(deviceRequest(
      "/api/v1/me/telemetry-v11/domain-activate", "POST", { ...activation, unknownField: true },
    )), 400, "TELEMETRY_MANIFEST_INVALID");
    // A day whose manifest is still staged (a chunk never arrived) is incomplete.
    const staged = makeV11Day(fixture.day, { usage: fixture.records.usage.slice(0, 1) }, fixture.parserVersion);
    const stagedCandidate = await (await manifestPost.handler(deviceRequest(
      "/api/v1/device/telemetry/v1.1/day-manifests", "POST", staged.manifest,
    ))).json();
    assert.equal(stagedCandidate.state, "staged");
    await apiError(await activateRoute.handler(deviceRequest(
      "/api/v1/me/telemetry-v11/domain-activate", "POST", domainManifest(predecessor, readyDays.map((entry) => (
        entry.day === fixture.day
          ? { day: entry.day, manifestId: stagedCandidate.manifestId, manifestDigest: stagedCandidate.manifestDigest }
          : entry))),
    )), 409, "TELEMETRY_MANIFEST_INCOMPLETE");
    const activated = await activateRoute.handler(deviceRequest(
      "/api/v1/me/telemetry-v11/domain-activate", "POST", activation,
    ));
    assert.equal(activated.status, 201);
    const generation = await activated.json();
    assert.deepEqual({ ...generation, generationId: "<id>" }, {
      schemaVersion: "telemetry-domain-activation-v1.1", generationId: "<id>",
      manifestDigest: activation.manifestDigest, fromDay: activation.fromDay, throughDay: activation.throughDay,
      replay: false,
    });
    const activationReplay = await (await activateRoute.handler(deviceRequest(
      "/api/v1/me/telemetry-v11/domain-activate", "POST", activation,
    ))).json();
    assert.deepEqual(activationReplay, { ...generation, replay: true });
    const head = await primaryPool.query(
      `SELECT h.generation_id, h.revision, (SELECT count(*)::int FROM ${q(primarySchema, "telemetry_v11_domain_days")} d
                WHERE d.generation_id = h.generation_id) AS days,
              (SELECT consumed_at IS NOT NULL FROM ${q(primarySchema, "telemetry_v11_domain_predecessors")}
                WHERE token_hash = $2) AS consumed,
              (SELECT revision::int FROM ${q(primarySchema, "community_analytical_input_versions")} WHERE participant_id = $1) AS input_revision
         FROM ${q(primarySchema, "telemetry_v11_domain_heads")} h WHERE h.participant_id = $1`,
      [participantId, sha256Hex(predecessor.token)],
    );
    assert.deepEqual(head.rows[0], {
      generation_id: generation.generationId, revision: 1, days: readyDays.length, consumed: true, input_revision: 1,
    });
    // D1 ingestion-bridge 0001: one receipt and one exact owner-active row.
    const firstBridge = await bridgeState(primaryPool, primarySchema, participantId);
    assert.equal(firstBridge.receipts.length, 1);
    const [firstReceipt] = firstBridge.receipts;
    assert.deepEqual({ ...firstReceipt, event_digest: "<digest>", owner_digest: "<digest>" }, {
      event_digest: "<digest>", owner_digest: "<digest>", generation_id: generation.generationId,
      manifest_digest: activation.manifestDigest, head_revision: 1, input_revision: 0,
      from_day: activation.fromDay, through_day: activation.throughDay,
    });
    assert.deepEqual(firstBridge.link, {
      owner_digest: firstReceipt.owner_digest, state: "active", generation_id: generation.generationId,
      head_revision: 1, object_digest: firstReceipt.event_digest, manifest_digest: activation.manifestDigest,
    });
    assert.deepEqual(firstBridge.journal, [{
      kind: "owner-active", revision: 1, event_digest: firstReceipt.event_digest,
      object_digest: firstReceipt.event_digest, content_digest: activation.manifestDigest, event_tuple_version: 1,
    }]);

    // --------------------------------------- successor negotiation (v1.1) --
    const successor = await (await predecessorRoute.handler(deviceRequest(
      "/api/v1/me/telemetry-v11/domain-predecessor", "POST", {},
    ))).json();
    assert.equal(successor.previousGenerationId, generation.generationId);
    assert.deepEqual([successor.fromDay, successor.throughDay], [fixture.day, today]);
    const unchanged = await (await activateRoute.handler(deviceRequest(
      "/api/v1/me/telemetry-v11/domain-activate", "POST", domainManifest(successor, readyDays),
    ))).json();
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.replay, true);
    assert.equal(unchanged.generationId, generation.generationId);
    assert.deepEqual(await bridgeState(primaryPool, primarySchema, participantId), firstBridge,
      "an unchanged acknowledgement writes no generation, head move or journal row");

    // A successor that drops an admitted occurrence of the previous generation
    // is refused: the day it replaces must carry every old row unchanged.
    const shrunk = makeV11Day(fixture.day, {
      quota: fixture.records.quota, session: fixture.records.session, usage: fixture.records.usage.slice(1),
    }, fixture.parserVersion);
    const shrunkCandidate = await (await manifestPost.handler(deviceRequest(
      "/api/v1/device/telemetry/v1.1/day-manifests", "POST", shrunk.manifest,
    ))).json();
    for (const chunk of shrunk.chunks) {
      const uploaded = await contribute(chunk);
      assert.equal(uploaded.response?.status, 202, uploaded.error?.code);
    }
    const dropping = await (await predecessorRoute.handler(deviceRequest(
      "/api/v1/me/telemetry-v11/domain-predecessor", "POST", {},
    ))).json();
    const droppingDays = readyDays.map((entry) => (entry.day === fixture.day
      ? { day: entry.day, manifestId: shrunkCandidate.manifestId, manifestDigest: shrunkCandidate.manifestDigest } : entry));
    await apiError(await activateRoute.handler(deviceRequest(
      "/api/v1/me/telemetry-v11/domain-activate", "POST", domainManifest(dropping, droppingDays),
    )), 409, "TELEMETRY_COMPATIBILITY_PROOF_UNAVAILABLE");

    // A successor that keeps every old row and adds a new day's records is admitted.
    const grownDay = today;
    const grown = makeV11Day(grownDay, {
      usage: fixture.records.usage.slice(0, 2).map((record, index) => ({
        ...record,
        eventId: `event:v2:${sha256Hex(`v11-live-grown-${index}`)}`,
        eventTime: `${grownDay}T0${index}:00:00.000Z`,
      })),
    }, fixture.parserVersion);
    const grownCandidate = await (await manifestPost.handler(deviceRequest(
      "/api/v1/device/telemetry/v1.1/day-manifests", "POST", grown.manifest,
    ))).json();
    for (const chunk of grown.chunks) {
      const uploaded = await contribute(chunk);
      assert.equal(uploaded.response?.status, 202, uploaded.error?.code);
    }
    const growing = await (await predecessorRoute.handler(deviceRequest(
      "/api/v1/me/telemetry-v11/domain-predecessor", "POST", {},
    ))).json();
    const grownDays = readyDays.map((entry) => (entry.day === grownDay
      ? { day: entry.day, manifestId: grownCandidate.manifestId, manifestDigest: grownCandidate.manifestDigest } : entry));
    const successorActivation = await activateRoute.handler(deviceRequest(
      "/api/v1/me/telemetry-v11/domain-activate", "POST", domainManifest(growing, grownDays),
    ));
    assert.equal(successorActivation.status, 201);
    const successorGeneration = await successorActivation.json();
    assert.equal(successorGeneration.replay, false);
    assert.notEqual(successorGeneration.generationId, generation.generationId);
    const movedHead = await primaryPool.query(
      `SELECT h.generation_id, h.revision, d.previous_generation_id
         FROM ${q(primarySchema, "telemetry_v11_domain_heads")} h
         JOIN ${q(primarySchema, "telemetry_v11_domains")} d ON d.id = h.generation_id
        WHERE h.participant_id = $1`,
      [participantId],
    );
    assert.deepEqual(movedHead.rows[0], {
      generation_id: successorGeneration.generationId, revision: 2, previous_generation_id: generation.generationId,
    });
    const secondBridge = await bridgeState(primaryPool, primarySchema, participantId);
    assert.equal(secondBridge.receipts.length, 2);
    const secondReceipt = secondBridge.receipts[1];
    assert.deepEqual([secondReceipt.generation_id, secondReceipt.head_revision, secondReceipt.owner_digest],
      [successorGeneration.generationId, 2, firstReceipt.owner_digest]);
    assert.deepEqual(secondBridge.link, {
      owner_digest: firstReceipt.owner_digest, state: "active", generation_id: successorGeneration.generationId,
      head_revision: 2, object_digest: secondReceipt.event_digest, manifest_digest: successorGeneration.manifestDigest,
    });
    assert.deepEqual(secondBridge.journal.map((row) => [row.kind, row.revision, row.object_digest, row.content_digest]), [
      ["owner-active", 1, firstReceipt.event_digest, activation.manifestDigest],
      ["owner-active", 2, secondReceipt.event_digest, successorGeneration.manifestDigest],
    ]);
    // The published day's rows are immutable while the owner is active.
    await assert.rejects(primaryPool.query(
      `DELETE FROM ${q(primarySchema, "telemetry_v11_day_manifests")} WHERE id = $1`, [candidate.manifestId],
    ), { message: "telemetry_source_immutable" });
    await assert.rejects(primaryPool.query(
      `UPDATE ${q(primarySchema, "telemetry_v11_chunks")} SET chunk_digest = repeat('0', 64) WHERE manifest_id = $1`,
      [candidate.manifestId],
    ), { message: "telemetry_source_immutable" });
  } finally {
    if (primaryCreated) await primaryPool.query(`DROP SCHEMA "${primarySchema}" CASCADE`);
    if (ledgerCreated) await ledgerPool.query(`DROP SCHEMA "${ledgerSchema}" CASCADE`);
    await primaryPool.end();
    await ledgerPool.end();
  }
});

// ------------------------------------------------- shared setup (tests 2-3) --

async function openSchemas(label, stagedFiles) {
  const poolOptions = {
    host: endpoint.host, port: endpoint.port, user: endpoint.user, database: endpoint.database,
    password: endpoint.password ?? "synthetic-local-only", ssl: false, max: 6, connectionTimeoutMillis: 5_000,
  };
  const primaryPool = new pg.Pool({ ...poolOptions, application_name: `pg-v11-${label}-primary-test` });
  const ledgerPool = new pg.Pool({ ...poolOptions, application_name: `pg-v11-${label}-ledger-test` });
  const suffix = randomBytes(5).toString("hex");
  const schema = Object.freeze({ primarySchema: `v11${label}_${suffix}`, ledgerSchema: `v11${label}_l_${suffix}` });
  const created = [];
  const close = async () => {
    for (const [pool, name] of created.reverse()) await pool.query(`DROP SCHEMA "${name}" CASCADE`);
    await primaryPool.end();
    await ledgerPool.end();
  };
  try {
    const server = await primaryPool.query("SELECT current_setting('server_version_num')::integer AS version");
    assert.equal(Math.floor(server.rows[0].version / 10_000), 17);
    await primaryPool.query(`CREATE SCHEMA "${schema.primarySchema}"`);
    created.push([primaryPool, schema.primarySchema]);
    await ledgerPool.query(`CREATE SCHEMA "${schema.ledgerSchema}"`);
    created.push([ledgerPool, schema.ledgerSchema]);
    await applyStockAndStagedMigrations({ role: "primary", schema: schema.primarySchema, pool: primaryPool, stagedFiles });
    await applyPostgresMigrations({ role: "ledger", schema: schema.ledgerSchema, pool: ledgerPool });
  } catch (error) {
    await close();
    throw error;
  }
  return { primaryPool, ledgerPool, schema, close };
}

async function loadModules() {
  return {
    live: await load("/src/postgres-telemetry-v11-live-admission.ts"),
    bearer: await load("/src/postgres-device-bearer-auth.ts"),
    transport: await load("/src/postgres-typed-v12-transport.ts"),
    ledgerAuthority: await load("/src/postgres-ledger-authority.ts"),
    controls: await load("/src/postgres-collection-controls.ts"),
    crypto: await load("/src/crypto.ts"),
    boundedBody: await load("/src/bounded-body.ts"),
    constants: await load("/src/constants.ts"),
  };
}

function envelopeDependencies(modules, keys, overrides = {}) {
  const { live, transport, crypto, constants } = modules;
  return {
    readStorageReplay: live.readPostgresTelemetryV11StorageReplay,
    persistStagedChunk: live.persistPostgresTypedV11StagedChunk,
    readUploadOutcome: live.readPostgresTelemetryV11UploadOutcome,
    recordUploadReceipt: live.recordPostgresTelemetryV11UploadReceipt,
    registerPendingObject: live.registerPostgresTelemetryV11PendingObject,
    retirePendingObject: live.retirePostgresTelemetryV11PendingObject,
    abandonUploadAuthorization: transport.abandonPostgresDeviceUploadAuthorization,
    validateStagedChunk: live.validatePostgresTelemetryV11StagedChunk,
    decryptSyntheticEnvelope: crypto.decryptSyntheticEnvelope,
    sha256Hex: crypto.sha256Hex,
    socialConsentVersion: constants.TELEMETRY_CONSENT_VERSION,
    sourceNamespace: SOURCE_NAMESPACE,
    envelopePublicJwk: keys.publicJwkRaw,
    envelopePrivateJwk: keys.privateJwkRaw,
    ...overrides,
  };
}

test("an accountless v1.1 owner negotiates successors, matches the Q-1 rows, and uncertain persists resolve exactly", {
  skip: endpoint === null,
  timeout: 300_000,
}, async () => {
  const ownerB = JSON.parse(await readFile(
    resolve(WORKER_ROOT, "postgres-test/fixtures/telemetry-v11-live-q1-owner-b-2026-09-30.json"), "utf8",
  ));
  assert.equal(ownerB.source.ownerKind, "accountless");
  const { primaryPool, ledgerPool, schema, close } = await openSchemas("acct", [STAGED]);
  try {
    const modules = await loadModules();
    const { live, bearer, transport, ledgerAuthority, controls, boundedBody, constants } = modules;
    const { primarySchema } = schema;
    await primaryPool.query(
      `UPDATE ${q(primarySchema, "collection_controls")}
          SET control_state = 'operational', enrollment_enabled = true, upload_registration_enabled = true,
              processing_enabled = true, publication_enabled = true, revision = revision + 1,
              updated_at = clock_timestamp()
        WHERE singleton = 1`,
    );
    await primaryPool.query(
      `UPDATE ${q(primarySchema, "telemetry_transport_formats")} SET lifecycle = 'accepted'
        WHERE schema_version = 'telemetry-contribution-v1.1'`,
    );
    const options = { schema, sourceNamespace: SOURCE_NAMESPACE };
    await live.initializePostgresTypedV11Admission(primaryPool, options);

    // Owner (b): accountless, holding only the v1.1 lease graph (no v1.2 grant).
    const nowEpoch = Date.now();
    const now = new Date(nowEpoch).toISOString();
    const expiresAt = new Date(nowEpoch + 30 * DAY_MS).toISOString();
    const participantId = ownerB.participantId;
    const deviceId = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "participants")} (id, owner_kind, state, consent_version, created_at)
       VALUES ($1, 'accountless', 'active', NULL, $2)`, [participantId, now],
    );
    // The accountless enrollment writer, not a trigger, gives an accountless
    // participant its attribution enrollment and creation floor (rank 11).
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "attribution_enrollments")} (participant_id, namespace, created_at)
       VALUES ($1, $2, $3)`, [participantId, sha256Hex(`v11-live-namespace-${participantId}`), now],
    );
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "telemetry_transport_participant_floors")} (
         participant_id, minimum_rank, revision, changed_at
       ) VALUES ($1, 11, 0, $2)`, [participantId, now],
    );
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "accountless_enrollment_ledger")} (
         device_id, device_secret_hash, installation_principal_id, schema_version,
         policy_version, authorization_basis, state, issued_at, expires_at
       ) VALUES ($1, $2, $3, 'accountless-enrollment-v0.1', 'accountless-opt-out-v1',
         'accountless-policy-v1', 'active', $4, $5)`,
      [deviceId, bearerSecretHash(deviceId, secret), `synthetic-install-${deviceId}`, now, expiresAt],
    );
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "device_credentials")} (
         id, participant_id, authority_kind, accountless_enrollment_device_id,
         secret_hash, state, issued_at, expires_at, last_used_at
       ) VALUES ($1, $2, 'accountless', $1, $3, 'active', $4, $5, $4)`,
      [deviceId, participantId, bearerSecretHash(deviceId, secret), now, expiresAt],
    );
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "accountless_upload_owners")} (
         enrollment_device_id, participant_id, device_credential_id, policy_version,
         authorization_basis, authorized_at, expires_at, state
       ) VALUES ($1, $2, $1, 'accountless-opt-out-v1', 'accountless-policy-v1', $3, $4, 'active')`,
      [deviceId, participantId, now, expiresAt],
    );
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "accountless_v11_device_authorizations")} (
         enrollment_device_id, participant_id, device_credential_id, telemetry_schema_version,
         field_dictionary_version, privacy_contract_version, authorized_at, expires_at, state
       ) VALUES ($1, $2, $1, 'telemetry-contribution-v1.1', 'telemetry-v1.1-registry-2026-08-31.1',
         'ongoing-privacy-safe-telemetry-v1.1', $3, $4, 'active')`,
      [deviceId, participantId, now, expiresAt],
    );
    const deviceAuthorization = `Device um_device_${deviceId}.${secret}`;
    const principal = Object.freeze({ participantId, deviceId });

    const keys = await envelopeKeys();
    const objects = new Map();
    const objectStore = {
      async put(key, bytes) { objects.set(key, Uint8Array.from(bytes)); },
      async delete(key) { objects.delete(key); },
    };
    const deviceRouteDependencies = {
      primaryPool, ledgerPool, schema, admissionEnv: {},
      assertAdmissionBindings() {},
      async assertAttemptAllowed() {},
      authenticateDevice: (pool, header, routeOptions) => bearer.authenticatePostgresDeviceBearer(pool, header, routeOptions),
      hasDeletionTombstone: ledgerAuthority.hasPostgresDeletionTombstone,
      assertCollectionControl: controls.assertPostgresCollectionControlFromPool,
      readBoundedRequestBody: boundedBody.readBoundedRequestBody,
      maxRequestBytes: constants.MAX_REQUEST_BYTES,
    };
    const [, manifestPost] = createTelemetryV11DayManifestRouteModules({
      ...deviceRouteDependencies,
      registerDayManifest: live.registerPostgresTelemetryV11DayManifest,
      readDayChunkVector: live.readPostgresTelemetryV11DayChunkVector,
      readDayCandidates: live.readPostgresTelemetryV11DayCandidates,
    });
    const domainDependencies = { ...deviceRouteDependencies, createDomain: live.createPostgresTelemetryV11Domain };
    const predecessorRoute = createTelemetryV11DomainPredecessorRouteModule(domainDependencies);
    const activateRoute = createTelemetryV11DomainActivateRouteModule(domainDependencies);
    const deviceRequest = (path, body) => new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { authorization: deviceAuthorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    let persistFault = null;
    const handler = createContributionEnvelopeRegistry([createTelemetryV11ContributionEnvelope(
      envelopeDependencies(modules, keys, {
        async persistStagedChunk(...args) {
          if (persistFault === "before") throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
          const result = await live.persistPostgresTypedV11StagedChunk(...args);
          if (persistFault === "after") throw Object.assign(new Error("commit acknowledgement lost"), { code: "ECONNRESET" });
          return result;
        },
      }),
    )]).resolve("telemetry-envelope-v1.1");

    // The contributions preamble claims through claimPostgresDeviceUploadAuthorization,
    // which requires an accountless v1.2 grant (hand-off: v1.1 needs the v1.1
    // lease graph, as the Worker's claimDeviceUploadAuthorization). The test
    // writes the claimed state that preamble would produce.
    async function claimFor(raw) {
      const authorizationId = randomUUID();
      const uploadSecret = randomBytes(32).toString("base64url");
      const bodyBytes = new TextEncoder().encode(raw).byteLength;
      const envelopeDigest = sha256Hex(raw);
      await primaryPool.query(
        `INSERT INTO ${q(primarySchema, "device_upload_authorizations")} (
           id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
           body_bytes, content_type, state, issued_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'application/json', 'unused', $7, $8)`,
        [authorizationId, participantId, deviceId, uploadSecretHash(authorizationId, uploadSecret), envelopeDigest,
          bodyBytes, new Date(Date.now() - 1_000).toISOString(), new Date(Date.now() + 5 * 60_000).toISOString()],
      );
      await assert.rejects(transport.claimPostgresDeviceUploadAuthorization(primaryPool,
        `Upload um_device_upload_${authorizationId}.${uploadSecret}`,
        { envelopeDigest, bodyBytes, contentType: "application/json" }, { schema }),
      { code: "UPLOAD_AUTH_INVALID" });
      await primaryPool.query(
        `UPDATE ${q(primarySchema, "device_upload_authorizations")}
            SET state = 'consuming', consume_lease_expires_at = $2 WHERE id = $1 AND state = 'unused'`,
        [authorizationId, new Date(Date.now() + 60_000).toISOString()],
      );
      return { claimed: { authorizationId, participantId, authorizationKind: "device" }, envelopeDigest, authorizationId };
    }
    const participantRow = { id: participantId, consentVersion: null, ownerKind: "accountless" };
    async function contribute(chunk) {
      const raw = JSON.stringify(await encryptV11Envelope(chunk, keys.publicJwk));
      const { claimed, envelopeDigest, authorizationId } = await claimFor(raw);
      let persistStarted = false;
      try {
        const response = await handler({ raw, value: JSON.parse(raw) }, participantRow, deviceId, claimed, {
          raw, envelopeDigest, primaryPool, schema, objectStore, markPersistStarted() { persistStarted = true; },
        });
        return { response, authorizationId, persistStarted };
      } catch (error) {
        if (!persistStarted) await transport.abandonPostgresDeviceUploadAuthorization(primaryPool, claimed, principal, { schema });
        return { error, authorizationId, persistStarted };
      }
    }
    const grant = async (authorizationId) => (await primaryPool.query(
      `SELECT state, consumed_contribution_id FROM ${q(primarySchema, "device_upload_authorizations")} WHERE id = $1`,
      [authorizationId],
    )).rows[0];

    // An accountless participant holds no social consent version.
    const prepared = makeV11Day(ownerB.day, ownerB.records, ownerB.parserVersion);
    assert.equal(prepared.manifest.manifestDigest, ownerB.expected.manifest.manifestDigest);
    const candidate = await (await manifestPost.handler(deviceRequest(
      "/api/v1/device/telemetry/v1.1/day-manifests", prepared.manifest,
    ))).json();
    assert.equal(candidate.state, "staged", JSON.stringify(candidate));

    // Uncertain persist, absent: nothing committed. The claim is abandoned,
    // this attempt's object and journal row are retired, the answer is 503.
    persistFault = "before";
    const absent = await contribute(prepared.chunks[0]);
    assert.equal(absent.persistStarted, true);
    assert.deepEqual({ status: absent.error?.status, code: absent.error?.code }, { status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });
    assert.equal((await grant(absent.authorizationId)).state, "revoked");
    assert.equal(objects.size, 0, "the never-referenced object was retired");
    assert.equal((await primaryPool.query(
      `SELECT count(*)::int AS n FROM ${q(primarySchema, "pending_objects")}`,
    )).rows[0].n, 0);

    // Uncertain persist, committed: the readback proves this attempt's own
    // row, so the answer is the original (not replayed) receipt.
    persistFault = "after";
    const committed = await contribute(prepared.chunks[0]);
    assert.equal(committed.response?.status, 202, committed.error?.code);
    const committedBody = await committed.response.json();
    assert.equal(committedBody.replayed, false);
    assert.deepEqual(await grant(committed.authorizationId), {
      state: "consumed", consumed_contribution_id: committedBody.contributionId,
    });
    persistFault = null;
    for (const chunk of prepared.chunks.slice(1)) {
      const uploaded = await contribute(chunk);
      assert.equal(uploaded.response?.status, 202, uploaded.error?.code);
    }
    const replay = await contribute(prepared.chunks[1]);
    assert.equal(replay.response.headers.get("idempotency-replayed"), "true");
    assert.equal(objects.size, prepared.chunks.length);

    const shape = telemetryV11DayShape(await shapeTables(primaryPool, primarySchema), {
      participantId, day: ownerB.day, ownerOriginalHex: ownerB.ownerOriginalHex,
    });
    assert.deepEqual(shape, ownerB.expected);

    // negotiateSuccessors: bootstrap predecessor, activation, then a
    // successor over an unchanged vector is acknowledged without a write.
    const predecessor = await (await predecessorRoute.handler(deviceRequest(
      "/api/v1/me/telemetry-v11/domain-predecessor", {},
    ))).json();
    assert.equal(predecessor.previousGenerationId, null);
    const today = new Date().toISOString().slice(0, 10);
    const days = [{ day: ownerB.day, manifestId: candidate.manifestId, manifestDigest: candidate.manifestDigest }];
    for (const day of utcDays(ownerB.day, today).slice(1)) {
      const empty = await (await manifestPost.handler(deviceRequest(
        "/api/v1/device/telemetry/v1.1/day-manifests", makeV11Day(day, {}, ownerB.parserVersion).manifest,
      ))).json();
      days.push({ day, manifestId: empty.manifestId, manifestDigest: empty.manifestDigest });
    }
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "storage_source_state")} (singleton, source_id, authority_epoch)
       VALUES (1, 'synthetic-v11-live-source', 0)`,
    );
    const activated = await activateRoute.handler(deviceRequest(
      "/api/v1/me/telemetry-v11/domain-activate", domainManifest(predecessor, days),
    ));
    assert.equal(activated.status, 201);
    const generation = await activated.json();
    assert.equal(generation.replay, false);
    // The accountless head is eligible through its device's v1.1 grant chain.
    const bridged = await bridgeState(primaryPool, primarySchema, participantId);
    assert.deepEqual(bridged.receipts.map((row) => [row.generation_id, row.head_revision]), [[generation.generationId, 1]]);
    assert.deepEqual(bridged.journal.map((row) => [row.kind, row.revision]), [["owner-active", 1]]);
    assert.equal(bridged.link.state, "active");
    const successor = await (await predecessorRoute.handler(deviceRequest(
      "/api/v1/me/telemetry-v11/domain-predecessor", {},
    ))).json();
    assert.equal(successor.previousGenerationId, generation.generationId);
    const acknowledged = await (await activateRoute.handler(deviceRequest(
      "/api/v1/me/telemetry-v11/domain-activate", domainManifest(successor, days),
    ))).json();
    assert.deepEqual({ unchanged: acknowledged.unchanged, replay: acknowledged.replay, generationId: acknowledged.generationId },
      { unchanged: true, replay: true, generationId: generation.generationId });

    // A revoked v1.1 grant stops future uploads and domain changes (the
    // bearer's accountless lease graph no longer holds, so 401 as the Worker
    // answers); it does not withdraw what was admitted.
    await primaryPool.query(
      `UPDATE ${q(primarySchema, "accountless_v11_device_authorizations")}
          SET state = 'revoked', revoked_at = clock_timestamp(), revocation_reason = 'user_opt_out'
        WHERE participant_id = $1`, [participantId],
    );
    await apiError(await predecessorRoute.handler(deviceRequest(
      "/api/v1/me/telemetry-v11/domain-predecessor", {},
    )), 401, "DEVICE_AUTH_INVALID");
    assert.equal((await primaryPool.query(
      `SELECT count(*)::int AS n FROM ${q(primarySchema, "telemetry_v11_domain_heads")} WHERE participant_id = $1`,
      [participantId],
    )).rows[0].n, 1);
  } finally {
    await close();
  }
});
