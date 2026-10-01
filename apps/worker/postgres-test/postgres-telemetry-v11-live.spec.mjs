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
import { createTelemetryV11OriginIntake } from "../cloud-run/routes/v11-composition.mjs";
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
 * The route modules and the envelope registration are driven directly here
 * (the composed origin, cloud-run/origin-intake-composition.mjs, is driven
 * end to end by postgres-origin-intake.spec.mjs), and the contributions
 * preamble is IN-1b's. The test plays the preamble's part with the production
 * PostgreSQL adapters: claim (under the v1.1 accountless gate for the
 * accountless owner), the telemetry-contribution-v1.1 transport gate, then
 * abandon on a failure before persistence. Rate-limit adapters are stubs.
 *
 * Further tests cover what the Q-1 owners cannot: typed v1 history carried
 * into a v1.1 domain (ingestion-isolation 0007's transition proof), the
 * active usage-correction exact-total tolerance, admission caps and their
 * retry-after, occurrence conflicts, v0.2 history and concurrent activation.
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
            event_tuple_version::int AS event_tuple_version, authority_epoch::int AS authority_epoch,
            public_authority_epoch::int AS public_authority_epoch
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
    const transportAuthority = await load("/src/postgres-transport-write-authority.ts");

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

    // ------------------------------------- composition (the lead's wiring) --
    const intake = createTelemetryV11OriginIntake({
      adapters: { live, bearer, transport, ledgerAuthority, personalDevices, controls, crypto, boundedBody },
      primaryPool, ledgerPool, schema, admissionEnv: {},
      assertAdmissionBindings() {},
      async assertAttemptAllowed() {},
      maxRequestBytes: constants.MAX_REQUEST_BYTES,
      socialConsentVersion: constants.TELEMETRY_CONSENT_VERSION,
      sourceNamespace: SOURCE_NAMESPACE,
      envelopePublicJwk: keys.publicJwkRaw,
      envelopePrivateJwk: keys.privateJwkRaw,
    });
    const [consentRoute, manifestGet, manifestPost, predecessorRoute, activateRoute] = intake.routeModules;
    assert.deepEqual(intake.routeModules.map((entry) => `${entry.method} ${entry.pathname}`), [
      "POST /api/v1/me/device-telemetry-consents",
      "GET /api/v1/device/telemetry/v1.1/day-manifests",
      "POST /api/v1/device/telemetry/v1.1/day-manifests",
      "POST /api/v1/me/telemetry-v11/domain-predecessor",
      "POST /api/v1/me/telemetry-v11/domain-activate",
    ]);
    const envelopes = createContributionEnvelopeRegistry([intake.envelopeRegistration]);
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
    // The pathname dispatch the lead mounts serves every method of the four
    // paths, so a wrong method gets the Worker registry's 405 and Allow.
    assert.deepEqual(intake.pathnames, [
      "/api/v1/me/device-telemetry-consents",
      "/api/v1/device/telemetry/v1.1/day-manifests",
      "/api/v1/me/telemetry-v11/domain-predecessor",
      "/api/v1/me/telemetry-v11/domain-activate",
    ]);
    for (const pathname of intake.pathnames) {
      const policy = routeRegistry.WORKER_ROUTE_POLICY.find((entry) => entry.pathname === pathname);
      for (const method of ["GET", "PUT", "DELETE"].filter((candidate) => !policy.methods.includes(candidate))) {
        const refused = await intake.dispatch(new Request(`${ORIGIN}${pathname}`, { method }));
        await apiError(refused, 405, "METHOD_NOT_ALLOWED");
        assert.equal(refused.headers.get("allow"), policy.methods.join(", "), `${method} ${pathname}`);
      }
    }
    assert.equal(await intake.dispatch(new Request(`${ORIGIN}/api/v1/me/telemetry-v12/domain-activate`,
      { method: "POST" })), null, "another path is not this dispatch's");
    // The handler resolves its own claim. The IN-1a seam on this branch drops
    // the option; the landed IN-1b registry keeps it.
    if ("ownsReceipt" in intake.envelopeRegistration) assert.equal(intake.envelopeRegistration.ownsReceipt, true);

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
    // A device id no device can have finds no preflight row, as in D1: 403,
    // not the device protocol's 401.
    for (const unknownDevice of ["", "dev ice", randomUUID()]) {
      await apiError(await consentRoute.handler(consentRequest({ ...consentBody, deviceId: unknownDevice })),
        403, "TELEMETRY_TRANSPORT_BLOCKED");
    }
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
        // The preamble's telemetry-contribution-v1.1 format gate (IN-3's
        // entry: TA-1), the Worker's pre-dispatch transport check.
        await transportAuthority.assertPostgresTelemetryTransportWriteAllowed(
          primaryPool, principal, "telemetry-contribution-v1.1", { schema, nowEpoch: Date.now() },
        );
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
    // Same owner evidence as the oracle's bootstrap predecessor, same fingerprint.
    assert.equal(predecessor.legacyFingerprint, fixture.bootstrapPredecessor.legacyFingerprint);
    const storedPredecessor = (await primaryPool.query(
      `SELECT input_revision::int AS input_revision, winners_json FROM ${q(primarySchema, "telemetry_v11_domain_predecessors")}
        WHERE token_hash = $1`, [sha256Hex(predecessor.token)],
    )).rows[0];
    assert.deepEqual(storedPredecessor, {
      input_revision: fixture.bootstrapPredecessor.inputRevision, winners_json: fixture.bootstrapPredecessor.winnersJson,
    });
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
    // D1 runs the transport gate before any replay read, so a refused
    // principal gets the refusal, never a replayed activation or chunk.
    const setLifecycle = (lifecycle) => primaryPool.query(
      `UPDATE ${q(primarySchema, "telemetry_transport_formats")} SET lifecycle = $1
        WHERE schema_version = 'telemetry-contribution-v1.1'`, [lifecycle],
    );
    await setLifecycle("blocked");
    await apiError(await activateRoute.handler(deviceRequest(
      "/api/v1/me/telemetry-v11/domain-activate", "POST", activation,
    )), 403, "TELEMETRY_TRANSPORT_BLOCKED");
    await apiError(await predecessorRoute.handler(deviceRequest(
      "/api/v1/me/telemetry-v11/domain-predecessor", "POST", {},
    )), 403, "TELEMETRY_TRANSPORT_BLOCKED");
    await apiError(await manifestPost.handler(deviceRequest(
      "/api/v1/device/telemetry/v1.1/day-manifests", "POST", prepared.manifest,
    )), 403, "TELEMETRY_TRANSPORT_BLOCKED");
    const blockedReplay = await contribute(prepared.chunks[0]);
    assert.deepEqual({ status: blockedReplay.error?.status, code: blockedReplay.error?.code },
      { status: 403, code: "TELEMETRY_TRANSPORT_BLOCKED" });
    assert.equal((await grantState(blockedReplay.authorizationId)).state, "revoked",
      "the refused replay's grant is abandoned, not consumed against the retained chunk");
    await setLifecycle("accepted");
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
      authority_epoch: 1, public_authority_epoch: 1,
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
    // Two concurrent uploads of one chunk under two grants: the manifest
    // lock orders them, one stages and the other is its exact replay.
    assert.equal(grown.chunks.length, 1);
    const racing = await Promise.all([contribute(grown.chunks[0]), contribute(grown.chunks[0])]);
    const raced = await Promise.all(racing.map(async (entry) => {
      assert.equal(entry.response?.status, 202, entry.error?.code);
      return entry.response.json();
    }));
    assert.deepEqual(raced.map((body) => body.replayed).sort(), [false, true]);
    assert.equal(raced[0].contributionId, raced[1].contributionId);
    for (const entry of racing) {
      assert.deepEqual(await grantState(entry.authorizationId),
        { state: "consumed", consumed_contribution_id: raced[0].contributionId });
    }
    assert.equal((await primaryPool.query(
      `SELECT count(*)::int AS n FROM ${q(primarySchema, "typed_v11_record_admissions")} WHERE chunk_id = $1`,
      [raced[0].contributionId],
    )).rows[0].n, grown.chunks[0].records.length);
    const retained = await primaryPool.query(
      `SELECT array_agg(r2_key ORDER BY r2_key) AS keys FROM ${q(primarySchema, "telemetry_v11_chunks")}`,
    );
    assert.deepEqual([...objects.keys()].sort(), retained.rows[0].keys,
      "exactly the referenced envelope objects remain; a losing attempt's object is retired");
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
    // D1 ingestion-isolation 0002 (v11-append-classification.spec.ts, "keeps
    // hard epochs across actual empty-day and same-day appends"): replacing
    // today's empty manifest with one holding records keeps every old row,
    // so the move is an append, journalled 'source-updated' with both epochs
    // unchanged.
    assert.deepEqual(secondBridge.journal.map((row) => [row.kind, row.revision, row.object_digest, row.content_digest,
      row.authority_epoch, row.public_authority_epoch]), [
      ["owner-active", 1, firstReceipt.event_digest, activation.manifestDigest, 1, 1],
      ["source-updated", 2, secondReceipt.event_digest, successorGeneration.manifestDigest, 1, 1],
    ]);
    const transitions = async () => (await primaryPool.query(
      `SELECT generation_id, previous_generation_id, head_revision::int AS head_revision, is_append::int AS is_append,
              compared_records FROM ${q(primarySchema, "storage_v11_append_transitions")}
        WHERE participant_id = $1 ORDER BY head_revision`, [participantId],
    )).rows;
    assert.deepEqual(await transitions(), [{
      generation_id: successorGeneration.generationId, previous_generation_id: generation.generationId,
      head_revision: 2, is_append: 1, compared_records: 0,
    }]);
    const sourceEpoch = async () => (await primaryPool.query(
      `SELECT authority_epoch::int AS epoch FROM ${q(primarySchema, "storage_source_state")} WHERE singleton = 1`,
    )).rows[0].epoch;
    assert.equal(await sourceEpoch(), 1, "an append leaves the public authority epoch where the first activation put it");
    // The published day's rows are immutable while the owner is active.
    await assert.rejects(primaryPool.query(
      `DELETE FROM ${q(primarySchema, "telemetry_v11_day_manifests")} WHERE id = $1`, [candidate.manifestId],
    ), { message: "telemetry_source_immutable" });
    await assert.rejects(primaryPool.query(
      `UPDATE ${q(primarySchema, "telemetry_v11_chunks")} SET chunk_digest = repeat('0', 64) WHERE manifest_id = $1`,
      [candidate.manifestId],
    ), { message: "telemetry_source_immutable" });

    // A successor that keeps every row but re-parses a day is not an append
    // (D1: "hard-invalidates changed parser metadata"): 'owner-active', and
    // both epochs advance.
    const reparsed = makeV11Day(fixture.day, fixture.records, `${fixture.parserVersion}-reparsed`);
    const reparsedCandidate = await (await manifestPost.handler(deviceRequest(
      "/api/v1/device/telemetry/v1.1/day-manifests", "POST", reparsed.manifest,
    ))).json();
    for (const chunk of reparsed.chunks) {
      const uploaded = await contribute(chunk);
      assert.equal(uploaded.response?.status, 202, uploaded.error?.code);
    }
    const reparsing = await (await predecessorRoute.handler(deviceRequest(
      "/api/v1/me/telemetry-v11/domain-predecessor", "POST", {},
    ))).json();
    const reparsedActivation = await activateRoute.handler(deviceRequest(
      "/api/v1/me/telemetry-v11/domain-activate", "POST", domainManifest(reparsing, grownDays.map((entry) => (
        entry.day === fixture.day
          ? { day: entry.day, manifestId: reparsedCandidate.manifestId, manifestDigest: reparsedCandidate.manifestDigest }
          : entry))),
    ));
    assert.equal(reparsedActivation.status, 201);
    const reparsedGeneration = await reparsedActivation.json();
    const thirdBridge = await bridgeState(primaryPool, primarySchema, participantId);
    assert.deepEqual(thirdBridge.journal.map((row) => [row.kind, row.revision, row.authority_epoch, row.public_authority_epoch]), [
      ["owner-active", 1, 1, 1], ["source-updated", 2, 1, 1], ["owner-active", 3, 2, 2],
    ]);
    assert.deepEqual((await transitions()).map((row) => [row.generation_id, row.head_revision, row.is_append]), [
      [successorGeneration.generationId, 2, 1], [reparsedGeneration.generationId, 3, 0],
    ]);
    assert.equal(await sourceEpoch(), 2);
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
    codec: await load("/src/typed-telemetry-codec.ts"),
    compatibility: await load("/src/telemetry-v11-compatibility.ts"),
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

    // The contributions preamble claims through claimPostgresDeviceUploadAuthorization.
    // Its default ('v1.2') gate also demands the typed-v1.2 grant this owner
    // never held, so a shipped v1.1-only client would get 401; a v1.1
    // envelope is claimed under 'v1.1', d43c8f92 claimDeviceUploadAuthorization's
    // own gate (the v1.1 lease graph).
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
      const header = `Upload um_device_upload_${authorizationId}.${uploadSecret}`;
      const request = { envelopeDigest, bodyBytes, contentType: "application/json" };
      await assert.rejects(transport.claimPostgresDeviceUploadAuthorization(primaryPool, header, request, { schema }),
        { code: "UPLOAD_AUTH_INVALID" });
      assert.equal((await grant(authorizationId)).state, "unused", "a refused claim leaves the grant redeemable");
      const claimed = await transport.claimPostgresDeviceUploadAuthorization(primaryPool, header, request,
        { schema, accountlessAuthorizationVersion: "v1.1" });
      assert.deepEqual(claimed, { authorizationId, participantId, authorizationKind: "device" });
      return { claimed, envelopeDigest, authorizationId };
    }
    const participantRow = { id: participantId, consentVersion: null, ownerKind: "accountless" };
    async function contribute(chunk, { bareClaim = false } = {}) {
      const raw = JSON.stringify(await encryptV11Envelope(chunk, keys.publicJwk));
      const { claimed, envelopeDigest, authorizationId } = await claimFor(raw);
      let persistStarted = false;
      try {
        // The Worker hands its v1.1 handler the bare authorization id.
        const passed = bareClaim ? claimed.authorizationId : claimed;
        const response = await handler({ raw, value: JSON.parse(raw) }, participantRow, deviceId, passed, {
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
    const absent = await contribute(prepared.chunks[0], { bareClaim: true });
    assert.equal(absent.persistStarted, true);
    assert.deepEqual({ status: absent.error?.status, code: absent.error?.code }, { status: 503, code: "BACKEND_STORAGE_UNAVAILABLE" });
    assert.equal((await grant(absent.authorizationId)).state, "revoked");
    assert.equal(objects.size, 0, "the never-referenced object was retired");
    assert.equal((await primaryPool.query(
      `SELECT count(*)::int AS n FROM ${q(primarySchema, "pending_objects")}`,
    )).rows[0].n, 0);

    // Uncertain persist, committed: the readback proves this attempt's own
    // row, and d43c8f92's catch answers a retained matching chunk as a
    // replay (replayed: true, idempotency-replayed), whoever committed it.
    persistFault = "after";
    const committed = await contribute(prepared.chunks[0]);
    assert.equal(committed.response?.status, 202, committed.error?.code);
    assert.equal(committed.response.headers.get("idempotency-replayed"), "true");
    const committedBody = await committed.response.json();
    assert.equal(committedBody.replayed, true);
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
    assert.equal(predecessor.legacyFingerprint, ownerB.bootstrapPredecessor.legacyFingerprint);
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

test("a v1.1 head accepted before storage_source_state is reported pending and bridged exactly once", {
  skip: endpoint === null,
  timeout: 120_000,
}, async () => {
  const { primaryPool, schema, close } = await openSchemas("pend", [STAGED]);
  try {
    const { live, constants } = await loadModules();
    const { primarySchema } = schema;
    await primaryPool.query(
      `UPDATE ${q(primarySchema, "telemetry_transport_formats")} SET lifecycle = 'accepted'
        WHERE schema_version = 'telemetry-contribution-v1.1'`,
    );
    await live.initializePostgresTypedV11Admission(primaryPool, { schema, sourceNamespace: SOURCE_NAMESPACE });
    const now = new Date().toISOString();
    const participantId = `participant:${randomUUID()}`;
    const deviceId = randomUUID();
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "participants")} (id, owner_kind, state, consent_version, created_at)
       VALUES ($1, 'social', 'active', $2, $3)`, [participantId, constants.TELEMETRY_CONSENT_VERSION, now],
    );
    const expiry = new Date(Date.now() + 30 * DAY_MS).toISOString();
    const sessionId = randomUUID();
    const pairingId = randomUUID();
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "web_sessions")} (
         id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $5)`,
      [sessionId, participantId, randomBytes(32), randomBytes(32), now, expiry],
    );
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "device_pairings")} (
         id, participant_id, issued_by_session_id, secret_hash, consent_version,
         transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
       ) VALUES ($1, $2, $3, $4, $5, 'ongoing-privacy-safe-telemetry-v1.0', 'consumed', $6, $7, $6, $8)`,
      [pairingId, participantId, sessionId, randomBytes(32), constants.TELEMETRY_CONSENT_VERSION, now, expiry, deviceId],
    );
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "device_credentials")} (
         id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
         state, issued_at, expires_at, last_used_at, social_verified_at
       ) VALUES ($1, $2, 'social', $3, $4, 'active', $5, $6, $5, $5)`,
      [deviceId, participantId, pairingId, randomBytes(32), now, expiry],
    );
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "telemetry_v11_device_consents")} (
         participant_id, device_id, telemetry_schema_version, field_dictionary_version,
         privacy_contract_version, consented_at
       ) VALUES ($1, $2, 'telemetry-contribution-v1.1', 'telemetry-v1.1-registry-2026-08-31.1',
         'ongoing-privacy-safe-telemetry-v1.1', $3)`, [participantId, deviceId, now],
    );
    const principal = { participantId, deviceId };
    const options = { schema, sourceNamespace: SOURCE_NAMESPACE };
    const today = new Date().toISOString().slice(0, 10);
    const empty = await live.registerPostgresTelemetryV11DayManifest(
      primaryPool, principal, makeV11Day(today, {}, "synthetic-v11-live").manifest, Date.now(), options,
    );
    const domain = live.createPostgresTelemetryV11Domain(primaryPool, options);
    const predecessor = await domain.createPredecessor(principal);
    const generation = await domain.activate(principal, domainManifest(predecessor, [
      { day: today, manifestId: empty.manifestId, manifestDigest: empty.manifestDigest },
    ]));
    assert.equal(generation.replay, false);

    const count = async () => Number((await primaryPool.query(
      `SELECT ${q(primarySchema, "storage_v11_bridge_pending_count")}() AS n`,
    )).rows[0].n);
    const backfill = async () => Number((await primaryPool.query(
      `SELECT ${q(primarySchema, "storage_v11_bridge_backfill")}(10) AS n`,
    )).rows[0].n);
    assert.equal(await count(), 1, "the head was accepted without a journal source");
    assert.equal(await backfill(), 0, "without storage_source_state nothing is minted");
    assert.deepEqual(await bridgeState(primaryPool, primarySchema, participantId), { link: null, receipts: [], journal: [] });
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "storage_source_state")} (singleton, source_id, authority_epoch)
       VALUES (1, 'synthetic-v11-live-source', 0)`,
    );
    assert.equal(await backfill(), 1);
    assert.equal(await count(), 0);
    assert.equal(await backfill(), 0, "a bridged head is never bridged twice");
    const bridged = await bridgeState(primaryPool, primarySchema, participantId);
    assert.deepEqual(bridged.receipts.map((row) => [row.generation_id, row.head_revision]), [[generation.generationId, 1]]);
    assert.deepEqual(bridged.journal.map((row) => [row.kind, row.revision, row.content_digest]),
      [["owner-active", 1, generation.manifestDigest]]);
    assert.deepEqual([bridged.link.state, bridged.link.generation_id, bridged.link.head_revision],
      ["active", generation.generationId, 1]);
    await assert.rejects(primaryPool.query(`SELECT ${q(primarySchema, "storage_v11_bridge_backfill")}(0)`),
      { message: "storage_v11_bridge_limit_invalid" });
  } finally {
    await close();
  }
});

// ------------------------------------------- closure and admission edges --

/**
 * A social owner with an active device. With consent (the default) its v1.1
 * device consent row is written too, which raises both floors to rank 11
 * (0051's consent floor trigger), as the consent route does.
 */
async function seedSocialOwner(pool, primarySchema, constants, { consent = true } = {}) {
  const now = new Date().toISOString();
  const expiry = new Date(Date.now() + 30 * DAY_MS).toISOString();
  const participantId = `participant:${randomUUID()}`;
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const pairingId = randomUUID();
  await pool.query(
    `INSERT INTO ${q(primarySchema, "participants")} (id, owner_kind, state, consent_version, created_at)
     VALUES ($1, 'social', 'active', $2, $3)`, [participantId, constants.TELEMETRY_CONSENT_VERSION, now],
  );
  await pool.query(
    `INSERT INTO ${q(primarySchema, "web_sessions")} (
       id, participant_id, secret_hash, csrf_hash, issued_at, expires_at, last_used_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $5)`,
    [sessionId, participantId, randomBytes(32), randomBytes(32), now, expiry],
  );
  await pool.query(
    `INSERT INTO ${q(primarySchema, "device_pairings")} (
       id, participant_id, issued_by_session_id, secret_hash, consent_version,
       transport_consent_version, state, issued_at, expires_at, consumed_at, claimed_device_id
     ) VALUES ($1, $2, $3, $4, $5, 'ongoing-privacy-safe-telemetry-v1.0', 'consumed', $6, $7, $6, $8)`,
    [pairingId, participantId, sessionId, randomBytes(32), constants.TELEMETRY_CONSENT_VERSION, now, expiry, deviceId],
  );
  await pool.query(
    `INSERT INTO ${q(primarySchema, "device_credentials")} (
       id, participant_id, authority_kind, paired_via_pairing_id, secret_hash,
       state, issued_at, expires_at, last_used_at, social_verified_at
     ) VALUES ($1, $2, 'social', $3, $4, 'active', $5, $6, $5, $5)`,
    [deviceId, participantId, pairingId, randomBytes(32), now, expiry],
  );
  const owner = Object.freeze({ participantId, deviceId, principal: Object.freeze({ participantId, deviceId }) });
  if (consent) await grantV11ConsentRow(pool, primarySchema, owner);
  return owner;
}

async function grantV11ConsentRow(pool, primarySchema, owner) {
  await pool.query(
    `INSERT INTO ${q(primarySchema, "telemetry_v11_device_consents")} (
       participant_id, device_id, telemetry_schema_version, field_dictionary_version,
       privacy_contract_version, consented_at
     ) VALUES ($1, $2, 'telemetry-contribution-v1.1', 'telemetry-v1.1-registry-2026-08-31.1',
       'ongoing-privacy-safe-telemetry-v1.1', $3)`, [owner.participantId, owner.deviceId, new Date().toISOString()],
  );
}

/** One chunk through the production claim, object journal and persist, as the envelope handler runs them. */
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

/** Empty, immediately ready day manifests for every day in the range. */
async function emptyDays(modules, pool, owner, fromDay, throughDay, parserVersion, options) {
  const days = [];
  for (const day of utcDays(fromDay, throughDay)) {
    const ready = await modules.live.registerPostgresTelemetryV11DayManifest(
      pool, owner.principal, makeV11Day(day, {}, parserVersion).manifest, Date.now(), options,
    );
    days.push({ day, manifestId: ready.manifestId, manifestDigest: ready.manifestDigest });
  }
  return days;
}

function withDay(days, replacement) {
  return days.map((entry) => (entry.day === replacement.day ? replacement : entry));
}

async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    return { status: error?.status, code: error?.code };
  }
  return { status: "resolved" };
}

/**
 * One typed v1.0 chunk in the shape the D1 transfer and typed v1 admission
 * leave it (0033): the header with its consumed grant and object journal row
 * first; `admit` then writes the typed records, their allocation and record
 * admissions, and the typed v1 event source.
 */
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

test("typed v1 history carries into a v1.1 domain only through ingestion-isolation 0007's transition proof", {
  skip: endpoint === null,
  timeout: 300_000,
}, async () => {
  const { primaryPool, schema, close } = await openSchemas("tv1", [STAGED]);
  try {
    const modules = await loadModules();
    const { live, constants, compatibility, codec } = modules;
    const { primarySchema } = schema;
    const options = { schema, sourceNamespace: SOURCE_NAMESPACE };
    await primaryPool.query(
      `UPDATE ${q(primarySchema, "telemetry_transport_formats")} SET lifecycle = 'accepted'
        WHERE schema_version = 'telemetry-contribution-v1.1'`,
    );
    await live.initializePostgresTypedV11Admission(primaryPool, options);
    // Typed v1 admission pinned to the same namespace, qualified as D1's is.
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "typed_v1_admission_state")} (
         id, source_namespace, namespace_id, runtime_contract_version, next_source_row_id
       ) SELECT 1, source_namespace, namespace_id, 1, 1000 FROM ${q(primarySchema, "typed_v11_admission_state")}`,
    );
    // The v1.0 history predates the owner's v1.1 consent (floor rank 1 then 11).
    const owner = await seedSocialOwner(primaryPool, primarySchema, constants, { consent: false });
    const ownerDigest = randomBytes(32).toString("hex");
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "storage_v11_owner_links")} (participant_id, owner_digest, state)
       VALUES ($1, $2, 'active')`, [owner.participantId, ownerDigest],
    );

    // The owner's v1.0 history for the Q-1 day is the exact legacy projection
    // of three v1.1 records: two usage rows in one chunk, one session row in
    // another. The session chunk's typed rows are not admitted yet.
    const day = fixture.day;
    const usage = fixture.records.usage.slice(0, 2);
    const sessionRecord = fixture.records.session[0];
    const legacy = (stream, record) => JSON.parse(compatibility.telemetryV11LegacyProjection(stream, record).canonicalRecord);
    const usageChunk = await seedTypedV1Chunk(modules, primaryPool, primarySchema, owner, {
      day, stream: "usage", chunkSeq: 0, records: usage.map((record) => legacy("usage", record)),
    });
    const usageDigests = await usageChunk.admit({ ownerDigest, firstSourceRowId: 1 });
    // The typed v1 canonical digest is exactly what a v1.1 proof's legacy digest carries.
    assert.deepEqual(usageDigests, usage.map((record) =>
      sha256Hex(compatibility.telemetryV11LegacyProjection("usage", record).canonicalRecord)));
    const sessionChunk = await seedTypedV1Chunk(modules, primaryPool, primarySchema, owner, {
      day, stream: "session", chunkSeq: 0, records: [legacy("session", sessionRecord)],
    });
    assert.equal(codec.typedTelemetryCanonicalRecords(codec.encodeTypedTelemetryRecord("v1", legacy("session", sessionRecord)))
      .canonicalRecord, compatibility.telemetryV11LegacyProjection("session", sessionRecord).canonicalRecord);
    await grantV11ConsentRow(primaryPool, primarySchema, owner);

    const domain = live.createPostgresTelemetryV11Domain(primaryPool, options);
    const predecessor = await domain.createPredecessor(owner.principal);
    const stored = (await primaryPool.query(
      `SELECT winners_json FROM ${q(primarySchema, "telemetry_v11_domain_predecessors")} WHERE token_hash = $1`,
      [sha256Hex(predecessor.token)],
    )).rows[0];
    assert.deepEqual(JSON.parse(stored.winners_json), [[owner.participantId, day, owner.deviceId]],
      "the bootstrap predecessor pins the typed v1 winner");
    const today = new Date().toISOString().slice(0, 10);
    assert.deepEqual([predecessor.fromDay, predecessor.throughDay], [day, today]);
    const empties = await emptyDays(modules, primaryPool, owner, day, today, fixture.parserVersion, options);

    const full = await stageDay(modules, primaryPool, schema, owner,
      makeV11Day(day, { usage, session: [sessionRecord] }, fixture.parserVersion), options);
    const dropping = await stageDay(modules, primaryPool, schema, owner,
      makeV11Day(day, { usage: usage.slice(0, 1), session: [sessionRecord] }, fixture.parserVersion), options);
    const activate = (dayEntry) => domain.activate(owner.principal, domainManifest(predecessor, withDay(empties, dayEntry)));
    const unproven = { status: 409, code: "TELEMETRY_COMPATIBILITY_PROOF_UNAVAILABLE" };

    // (b) a partially admitted current winner chunk refuses before any row proof.
    assert.deepEqual(await refusal(activate(full)), unproven);
    await sessionChunk.admit({ ownerDigest, firstSourceRowId: 3 });
    // (a) both typed runtimes must be qualified over one namespace.
    await primaryPool.query(`UPDATE ${q(primarySchema, "typed_v1_admission_state")} SET runtime_contract_version = 0`);
    assert.deepEqual(await refusal(activate(full)), unproven);
    await primaryPool.query(`UPDATE ${q(primarySchema, "typed_v1_admission_state")} SET runtime_contract_version = 1`);
    // (c) a candidate day that leaves out a typed v1 winner occurrence.
    assert.deepEqual(await refusal(activate(dropping)), unproven);
    const ownerRevision = async () => (await primaryPool.query(
      `SELECT (SELECT count(*)::int FROM ${q(primarySchema, "telemetry_v11_domain_heads")} WHERE participant_id = $1) AS heads,
              (SELECT revision::int FROM ${q(primarySchema, "community_analytical_input_versions")} WHERE participant_id = $1) AS input`,
      [owner.participantId],
    )).rows[0];
    assert.deepEqual(await ownerRevision(), { heads: 0, input: 0 }, "a refused activation moves nothing");

    // Every typed v1 occurrence present with its legacy digest: admitted.
    const generation = await activate(full);
    assert.equal(generation.replay, false);
    assert.deepEqual(await ownerRevision(), { heads: 1, input: 1 });
  } finally {
    await close();
  }
});

test("an active usage-correction runtime admits an exact-total restatement and nothing else", {
  skip: endpoint === null,
  timeout: 300_000,
}, async () => {
  const { primaryPool, schema, close } = await openSchemas("corr", [STAGED]);
  try {
    const modules = await loadModules();
    const { live, constants } = modules;
    const { primarySchema } = schema;
    const options = { schema, sourceNamespace: SOURCE_NAMESPACE };
    await primaryPool.query(
      `UPDATE ${q(primarySchema, "telemetry_transport_formats")} SET lifecycle = 'accepted'
        WHERE schema_version = 'telemetry-contribution-v1.1'`,
    );
    await live.initializePostgresTypedV11Admission(primaryPool, options);
    const owner = await seedSocialOwner(primaryPool, primarySchema, constants);
    const today = new Date().toISOString().slice(0, 10);
    const base = { ...fixture.records.usage[0], eventTime: `${today}T00:00:01.000Z`, totalInputContextTokens: null };
    const domain = live.createPostgresTelemetryV11Domain(primaryPool, options);
    const first = await stageDay(modules, primaryPool, schema, owner, makeV11Day(today, { usage: [base] }, "synthetic-corr"), options);
    const generation = await domain.activate(owner.principal, domainManifest(await domain.createPredecessor(owner.principal), [first]));
    assert.equal(generation.replay, false);

    // The same occurrence restating its exact total, and one changing a split.
    const restated = await stageDay(modules, primaryPool, schema, owner, makeV11Day(today, {
      usage: [{ ...base, totalInputContextTokens: 17_988 }],
    }, "synthetic-corr"), options);
    const resplit = await stageDay(modules, primaryPool, schema, owner, makeV11Day(today, {
      usage: [{ ...base, totalInputContextTokens: 17_988, components: { ...base.components, outputTextTokens: 1 } }],
    }, "synthetic-corr"), options);
    const successor = await domain.createPredecessor(owner.principal);
    const unproven = { status: 409, code: "TELEMETRY_COMPATIBILITY_PROOF_UNAVAILABLE" };
    // Without an active correction runtime the base digests must be equal.
    assert.deepEqual(await refusal(domain.activate(owner.principal, domainManifest(successor, [restated]))), unproven);
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "telemetry_usage_correction_runtime")} (
         id, schema_version, method_version, source_state, max_capture_rows, max_history_page
       ) VALUES (1, 'telemetry-usage-correction-v1', 'usage-total-correction-v1', 'active', 200, 200)`,
    );
    // Active: a changed split is still not the same occurrence.
    assert.deepEqual(await refusal(domain.activate(owner.principal, domainManifest(successor, [resplit]))), unproven);
    const corrected = await domain.activate(owner.principal, domainManifest(successor, [restated]));
    assert.equal(corrected.replay, false);
    assert.equal(corrected.generationId === generation.generationId, false);
  } finally {
    await close();
  }
});

test("v1.1 admission answers the Worker's caps, conflicts, v0.2 refusal and concurrent activations", {
  skip: endpoint === null,
  timeout: 300_000,
}, async () => {
  const { primaryPool, schema, close } = await openSchemas("edge", [STAGED]);
  try {
    const modules = await loadModules();
    const { live, constants } = modules;
    const { primarySchema } = schema;
    const options = { schema, sourceNamespace: SOURCE_NAMESPACE };
    await primaryPool.query(
      `UPDATE ${q(primarySchema, "telemetry_transport_formats")} SET lifecycle = 'accepted'
        WHERE schema_version = 'telemetry-contribution-v1.1'`,
    );
    await live.initializePostgresTypedV11Admission(primaryPool, options);
    const owner = await seedSocialOwner(primaryPool, primarySchema, constants);
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
    const usageAt = (dayValue, suffix) => ({
      ...fixture.records.usage[0], eventId: `event:v2:${sha256Hex(`v11-edge-${suffix}`)}`, eventTime: `${dayValue}T00:00:01.000Z`,
    });
    const domain = live.createPostgresTelemetryV11Domain(primaryPool, options);

    // 429 CHUNK_ADMISSION_LIMIT_REACHED, retry-after 60: the per-device daily
    // chunk window (20,000 while the device is under a week old).
    const limited = makeV11Day(yesterday, { usage: [usageAt(yesterday, "limited")] }, "synthetic-edge");
    await live.registerPostgresTelemetryV11DayManifest(primaryPool, owner.principal, limited.manifest, Date.now(), options);
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "telemetry_v1_chunk_admission_windows")} (
         participant_id, device_id, window_day, accepted_count, last_accepted_at
       ) VALUES ($1, $2, $3::date, 20000, now())`, [owner.participantId, owner.deviceId, today],
    );
    await assert.rejects(persistDirect(modules, primaryPool, schema, owner, limited.chunks[0], options), (error) =>
      error?.status === 429 && error.code === "CHUNK_ADMISSION_LIMIT_REACHED"
        && new Headers(error.responseHeaders).get("retry-after") === "60");
    await primaryPool.query(
      `DELETE FROM ${q(primarySchema, "telemetry_v1_chunk_admission_windows")} WHERE participant_id = $1`,
      [owner.participantId],
    );

    // 409 TELEMETRY_OCCURRENCE_CONFLICT: one occurrence in two candidate days.
    const shared = usageAt(yesterday, "shared");
    const first = await stageDay(modules, primaryPool, schema, owner, makeV11Day(yesterday, { usage: [shared] }, "synthetic-edge"), options);
    const second = await stageDay(modules, primaryPool, schema, owner, makeV11Day(today, {
      usage: [{ ...shared, eventTime: `${today}T00:00:01.000Z` }],
    }, "synthetic-edge"), options);
    const conflictPredecessor = await domain.createPredecessor(owner.principal);
    assert.deepEqual(await refusal(domain.activate(owner.principal, domainManifest(conflictPredecessor, [first, second]))),
      { status: 409, code: "TELEMETRY_OCCURRENCE_CONFLICT" });

    // Concurrent activations under one predecessor: the identical pair
    // converges on one generation (one write, one replay); a different
    // manifest racing it is a manifest conflict.
    const todayEmpty = (await emptyDays(modules, primaryPool, owner, today, today, "synthetic-edge", options))[0];
    const winner = domainManifest(conflictPredecessor, [first, todayEmpty]);
    const racing = await Promise.all([
      domain.activate(owner.principal, winner), domain.activate(owner.principal, winner),
    ]);
    assert.deepEqual(racing.map((result) => result.replay).sort(), [false, true]);
    assert.equal(racing[0].generationId, racing[1].generationId);
    const loserPredecessor = await domain.createPredecessor(owner.principal);
    const challenger = await stageDay(modules, primaryPool, schema, owner, makeV11Day(today, {
      usage: [usageAt(today, "challenger")],
    }, "synthetic-edge"), options);
    // Both commit orders are legitimate, as on D1: an unchanged vector neither
    // consumes the predecessor nor moves the head, so the challenger always
    // activates, and the unchanged vector is either an unchanged replay (it
    // ran first) or a manifest conflict (the head had already moved).
    const challengerManifest = domainManifest(loserPredecessor, [first, challenger]);
    const unchangedManifest = domainManifest(loserPredecessor, [first, todayEmpty]);
    const settle = (promise) => promise.then((result) => ({ status: "resolved", result }),
      (error) => ({ status: error?.status, code: error?.code }));
    const [challenged, repeated] = await Promise.all([
      settle(domain.activate(owner.principal, challengerManifest)),
      settle(domain.activate(owner.principal, unchangedManifest)),
    ]);
    assert.equal(challenged.status, "resolved");
    assert.equal(challenged.result.replay, false);
    assert.notEqual(challenged.result.generationId, racing[0].generationId);
    assert.ok((repeated.status === 409 && repeated.code === "TELEMETRY_MANIFEST_CONFLICT")
      || (repeated.status === "resolved" && repeated.result.unchanged === true
        && repeated.result.generationId === racing[0].generationId), JSON.stringify(repeated));
    const raceHead = await primaryPool.query(
      `SELECT generation_id FROM ${q(primarySchema, "telemetry_v11_domain_heads")} WHERE participant_id = $1`,
      [owner.participantId],
    );
    assert.equal(raceHead.rows[0]?.generation_id, challenged.result.generationId);
    // Once the head has moved, the same unchanged vector under the consumed
    // predecessor is a manifest conflict in either order.
    assert.deepEqual(await refusal(domain.activate(owner.principal, unchangedManifest)),
      { status: 409, code: "TELEMETRY_MANIFEST_CONFLICT" });

    // 429 for the 8,192nd-plus manifest of one device and UTC day, even
    // under concurrent registration.
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "telemetry_v11_day_manifests")} (
         id, participant_id, device_id, chunk_day, manifest_digest, parser_version, manifest_json,
         expected_chunk_count, state, created_at
       ) SELECT gen_random_uuid()::text, $1, $2, DATE '2026-01-01' + (n % 200),
                encode(sha256(convert_to('v11-edge-cap-' || n, 'UTF8')), 'hex'), 'synthetic-edge', '{}', 1, 'staged', now()
           FROM generate_series(1, 8192 - (
             SELECT count(*)::int FROM ${q(primarySchema, "telemetry_v11_day_manifests")}
              WHERE participant_id = $1 AND device_id = $2 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
           ) - 1) n`,
      [owner.participantId, owner.deviceId],
    );
    const capDays = ["2025-06-01", "2025-06-02", "2025-06-03", "2025-06-04"];
    const registered = await Promise.all(capDays.map((dayValue) => refusal(live.registerPostgresTelemetryV11DayManifest(
      primaryPool, owner.principal, makeV11Day(dayValue, { usage: [usageAt(dayValue, "cap")] }, "synthetic-edge").manifest,
      Date.now(), options,
    ))));
    assert.deepEqual(registered.map((outcome) => outcome.status).sort(), [429, 429, 429, "resolved"],
      "concurrent registrations stop exactly at the cap");
    assert.equal((await primaryPool.query(
      `SELECT count(*)::int AS n FROM ${q(primarySchema, "telemetry_v11_day_manifests")}
        WHERE participant_id = $1 AND device_id = $2 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      [owner.participantId, owner.deviceId],
    )).rows[0].n, 8192);

    // Accepted v0.2 history: the transport gate refuses every v1.1 write
    // with 403 TELEMETRY_TRANSPORT_BLOCKED before consent is even read, as
    // the Worker's does, so the closure's own v0.2 refusal is defence in depth.
    const legacyOwner = await seedSocialOwner(primaryPool, primarySchema, constants, { consent: false });
    const legacyUpload = randomUUID();
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "device_upload_authorizations")} (
         id, participant_id, issued_by_device_id, secret_hash, envelope_digest, body_bytes, content_type,
         state, issued_at, expires_at, consumed_at
       ) VALUES ($1, $2, $3, $4, $5, 256, 'application/json', 'consumed', now(), now() + interval '1 day', now())`,
      [legacyUpload, legacyOwner.participantId, legacyOwner.deviceId, randomBytes(32), randomBytes(32).toString("hex")],
    );
    // The pool sets no search_path: primary 0062 pins 0011's participant
    // guard, so the insert needs no session path (it used to).
    await primaryPool.query(
      `INSERT INTO ${q(primarySchema, "telemetry_contributions")} (
         id, participant_id, plaintext_digest, envelope_digest, r2_key, status, schema_version,
         transport_schema_version, range_start, range_end, client_platform, provider_policy_epoch,
         priced_event_coverage_percent, unknown_model_event_count, unknown_billable_units, price_basis,
         declared_record_count, device_upload_authorization_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'accepted', 'telemetry-contribution-v0.1', 'telemetry-contribution-v0.2',
         now() - interval '1 day', now(), 'synthetic', 'synthetic', 100, 0, 0, 'synthetic', 0, $6, now())`,
      [`contribution:${randomUUID()}`, legacyOwner.participantId, randomBytes(32).toString("hex"),
        randomBytes(32).toString("hex"), `synthetic/v02-${randomUUID()}`, legacyUpload],
    );
    const blocked = { status: 403, code: "TELEMETRY_TRANSPORT_BLOCKED" };
    await assert.rejects(grantV11ConsentRow(primaryPool, primarySchema, legacyOwner), { message: "telemetry_transport_blocked" });
    assert.deepEqual(await refusal(domain.createPredecessor(legacyOwner.principal)), blocked);
    assert.deepEqual(await refusal(live.registerPostgresTelemetryV11DayManifest(
      primaryPool, legacyOwner.principal, makeV11Day(today, {}, "synthetic-edge").manifest, Date.now(), options,
    )), blocked);
    assert.deepEqual(await refusal(domain.activate(legacyOwner.principal, domainManifest(
      { token: randomUUID(), previousGenerationId: null, legacyFingerprint: "0".repeat(64) },
      [{ day: today, manifestId: randomUUID(), manifestDigest: "1".repeat(64) }],
    ))), blocked);
  } finally {
    await close();
  }
});
