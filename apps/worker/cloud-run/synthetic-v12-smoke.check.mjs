#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import {
  canonicalTelemetryV12Json,
  parseTelemetryV12Chunk,
} from "@app-usagemonitor/telemetry-contract";
import {
  CLOUD_RUN_IAM_TEST_TARGET,
} from "./postgres-test-dispatch.mjs";
import {
  parseSyntheticV12SmokeConfig,
  assertSyntheticV12RuntimeReady,
  encryptSyntheticV12Envelope,
  makeManifestAndChunk,
  postgresAndGcsReadback,
  readSyntheticGcsObject,
  runSyntheticV12Smoke,
  seedSyntheticV12Fixture,
  SYNTHETIC_V12_SMOKE_BUCKET,
  SYNTHETIC_V12_SMOKE_DATABASE_TARGET,
  SYNTHETIC_V12_SMOKE_JOB,
  SYNTHETIC_V12_SMOKE_PARTICIPANT_PREFIX,
} from "./synthetic-v12-smoke.mjs";

const IDS = [
  "20000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
  "20000000-0000-4000-8000-000000000003",
  "20000000-0000-4000-8000-000000000004",
  "20000000-0000-4000-8000-000000000005",
  "20000000-0000-4000-8000-000000000006",
  "20000000-0000-4000-8000-000000000007",
];
const MANIFEST_ID = "30000000-0000-4000-8000-000000000001";
const CONTRIBUTION_ID = "chunk:30000000-0000-4000-8000-000000000002";
const SERVERLESS_TOKEN = "synthetic-iam-token-never-print";
const DEVICE_SECRET = "synthetic-device-secret-never-print";
const GRANT_TOKEN_1 = "um_device_upload_40000000-0000-4000-8000-000000000001.synthetic-grant-one";
const GRANT_TOKEN_2 = "um_device_upload_40000000-0000-4000-8000-000000000002.synthetic-grant-two";
const PARTICIPANT_ID = `${SYNTHETIC_V12_SMOKE_PARTICIPANT_PREFIX}${IDS[0]}`;
const DEVICE_ID = "20000000-0000-4000-8000-000000000004";

function env(overrides = {}) {
  return {
    CLOUD_RUN_JOB: SYNTHETIC_V12_SMOKE_JOB,
    CLOUD_RUN_EXECUTION: "tibotattle-v12-smoke-20260924-abc12",
    CLOUD_RUN_TASK_INDEX: "0",
    CLOUD_RUN_TASK_COUNT: "1",
    CLOUD_RUN_TASK_ATTEMPT: "0",
    GOOGLE_CLOUD_PROJECT: CLOUD_RUN_IAM_TEST_TARGET.project,
    HOST_ORIGIN: CLOUD_RUN_IAM_TEST_TARGET.origin,
    GCS_BUCKET_NAME: SYNTHETIC_V12_SMOKE_BUCKET,
    PRIMARY_DATABASE: SYNTHETIC_V12_SMOKE_DATABASE_TARGET.primaryDatabase,
    PRIMARY_SCHEMA: SYNTHETIC_V12_SMOKE_DATABASE_TARGET.primarySchema,
    PRIMARY_INSTANCE_CONNECTION_NAME: SYNTHETIC_V12_SMOKE_DATABASE_TARGET.primaryInstance,
    LEDGER_DATABASE: SYNTHETIC_V12_SMOKE_DATABASE_TARGET.ledgerDatabase,
    LEDGER_SCHEMA: SYNTHETIC_V12_SMOKE_DATABASE_TARGET.ledgerSchema,
    LEDGER_INSTANCE_CONNECTION_NAME: SYNTHETIC_V12_SMOKE_DATABASE_TARGET.ledgerInstance,
    POSTGRES_IAM_USER: SYNTHETIC_V12_SMOKE_DATABASE_TARGET.postgresIamUser,
    ENVELOPE_PUBLIC_JWK: JSON.stringify({ kty: "RSA", n: "synthetic-modulus", e: "AQAB", kid: "key:test" }),
    SYNTHETIC_V12_SMOKE_DAY: "2026-09-24",
    ...overrides,
  };
}

function response(status, value, url = "") {
  const result = new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
  Object.defineProperty(result, "url", { value: url });
  return result;
}

function fakeDependencies({ failManifest = false, anonymousStatus = 403 } = {}) {
  const calls = [];
  let seedCount = 0;
  let getTokenCount = 0;
  const fixture = {
    participantId: PARTICIPANT_ID,
    sessionId: IDS[1],
    deviceId: DEVICE_ID,
    deviceAuthorization: `Device um_device_${DEVICE_ID}.${DEVICE_SECRET}`,
    deviceSecret: DEVICE_SECRET,
  };
  return {
    calls,
    get seedCount() { return seedCount; },
    get getTokenCount() { return getTokenCount; },
    fixture,
    dependencies: {
      async validateEnvelopeKey(jwk) { assert.equal(jwk.kid, "key:test"); },
      async assertRuntimeReady() {},
      async seedFixture() { seedCount += 1; return fixture; },
      async getIdToken(audience) {
        assert.equal(audience, CLOUD_RUN_IAM_TEST_TARGET.origin);
        getTokenCount += 1;
        return SERVERLESS_TOKEN;
      },
      async fetchImpl(url, options) {
        calls.push({ url: new URL(url), options });
        if (options.headers?.["x-serverless-authorization"] === undefined) {
          return response(anonymousStatus, { status: "blocked" });
        }
        if (url.pathname === "/api/health") {
          return response(200, {
            schemaVersion: "gcp-postgres-test-health-v1",
            scope: "postgres_schema_and_migrations_only",
            status: "ready",
            workerApplicationReady: false,
            checks: {
              postgresMajor: 17,
              primaryMigrationReceipt: { status: "current", version: 35 },
              ledgerMigrationReceipt: { status: "current", version: 6 },
            },
          });
        }
        if (url.pathname === "/api/v1/device/sync/state") {
          return response(200, {
            schemaVersion: "device-sync-state-v1.0",
            contractVersion: "telemetry-contribution-v1.0",
            acknowledgedThroughDay: null,
            historyDigest: null,
            dayCount: 0,
            chunkCount: 0,
            admission: {
              schemaVersion: "telemetry-chunk-admission-v1.0",
              state: "available",
            },
          });
        }
        if (url.pathname === "/api/v1/device/telemetry/v1.2/day-manifests") {
          if (failManifest) {
            return response(503, {
              requestId: "sensitive-request-id",
              error: { code: "REQUEST_REJECTED", secret: DEVICE_SECRET },
            });
          }
          return response(201, {
            manifestId: MANIFEST_ID,
            manifestDigest: JSON.parse(options.body).manifestDigest,
            state: "staged",
            expectedChunks: 1,
            stagedChunks: [],
          });
        }
        if (url.pathname === "/api/v1/device/upload-authorizations") {
          const grantIndex = calls.filter((call) => call.url.pathname === url.pathname).length;
          return response(201, { uploadAuthorization: grantIndex === 1 ? GRANT_TOKEN_1 : GRANT_TOKEN_2 });
        }
        if (url.pathname === "/api/v1/contributions") {
          const replayed = calls.filter((call) => call.url.pathname === url.pathname).length === 2;
          return response(202, {
            schemaVersion: "telemetry-chunk-receipt-v1.2",
            contributionId: CONTRIBUTION_ID,
            manifestId: MANIFEST_ID,
            chunkId: `usage:${env().SYNTHETIC_V12_SMOKE_DAY}:0`,
            replayed,
          });
        }
        return response(404, { error: "unexpected fake route" });
      },
      async encryptEnvelope(chunk, jwk) {
        assert.equal(chunk.schemaVersion, "telemetry-contribution-v1.2");
        assert.equal(jwk.kid, "key:test");
        return {
          schemaVersion: "telemetry-envelope-v1.2",
          synthetic: false,
          keyId: jwk.kid,
          wrappedKey: "synthetic-wrapped-key",
          iv: "synthetic-iv",
          ciphertext: "synthetic-ciphertext",
        };
      },
      async readback(input) {
        assert.equal(input.fixture.participantId, PARTICIPANT_ID);
        assert.equal(input.manifestId, MANIFEST_ID);
        assert.equal(input.contributionId, CONTRIBUTION_ID);
        assert.equal(input.envelopeByteLength, Buffer.byteLength(JSON.stringify({
          schemaVersion: "telemetry-envelope-v1.2",
          synthetic: false,
          keyId: "key:test",
          wrappedKey: "synthetic-wrapped-key",
          iv: "synthetic-iv",
          ciphertext: "synthetic-ciphertext",
        })));
        return { postgres: true, gcs: true };
      },
      randomUUID() { return IDS[6]; },
    },
  };
}

test("job config pins the single Cloud Run job, app origin, project, bucket, and fixed day", () => {
  const config = parseSyntheticV12SmokeConfig(env());
  assert.equal(config.origin, CLOUD_RUN_IAM_TEST_TARGET.origin);
  assert.equal(config.bucket, SYNTHETIC_V12_SMOKE_BUCKET);
  assert.equal(config.day, "2026-09-24");
  assert.equal(config.envelopePublicJwk.kid, "key:test");
});

test("job config rejects local execution, spoofable origins, wrong bucket, invalid task shape, and private JWK", () => {
  for (const overrides of [
    { CLOUD_RUN_JOB: "different-job" },
    { CLOUD_RUN_EXECUTION: undefined },
    { CLOUD_RUN_TASK_INDEX: "1" },
    { CLOUD_RUN_TASK_COUNT: "2" },
    { CLOUD_RUN_TASK_ATTEMPT: "1" },
    { GOOGLE_CLOUD_PROJECT: "other-project" },
    { K_SERVICE: "tibotattle-test-app" },
    { HOST_ORIGIN: "https://service.invalid" },
    { HOST_ORIGIN: "https://tibotattle-test-app-806510610397.us-east1.run.app" },
    { GCS_BUCKET_NAME: "another-test-bucket" },
    { PRIMARY_INSTANCE_CONNECTION_NAME: "other-project:us-east1:test-primary" },
    { PRIMARY_DATABASE: "production" },
    { LEDGER_SCHEMA: "public" },
    { POSTGRES_IAM_USER: "other-runtime@other-project.iam" },
    { SYNTHETIC_V12_SMOKE_DAY: "2026-02-30" },
    { ENVELOPE_PUBLIC_JWK: JSON.stringify({ kty: "RSA", n: "n", e: "AQAB", kid: "x", d: "private" }) },
  ]) {
    assert.throws(() => parseSyntheticV12SmokeConfig(env(overrides)));
  }
});

function runtimePool(controlOverrides = {}) {
  const controls = {
    revision: 2,
    control_state: "degraded",
    enrollment_enabled: false,
    upload_registration_enabled: true,
    processing_enabled: true,
    publication_enabled: false,
    ...controlOverrides,
  };
  return {
    async query(sql) {
      if (sql.includes('"telemetry_v12_runtime"')) {
        return { rows: [{ state: "active" }], rowCount: 1 };
      }
      if (sql.includes('"telemetry_v12_typed_runtime"')) {
        return { rows: [{ state: "active" }], rowCount: 1 };
      }
      if (sql.includes('"collection_controls"')) {
        return { rows: [controls], rowCount: 1 };
      }
      throw new Error("unexpected runtime readiness query");
    },
  };
}

test("runtime readiness accepts only the narrow degraded v1.2 upload controls", async () => {
  await assertSyntheticV12RuntimeReady({ primaryPool: runtimePool(), schema: "tibotattle" });
  await assertSyntheticV12RuntimeReady({
    primaryPool: runtimePool({ revision: 15 }),
    schema: "tibotattle",
  });
  for (const controls of [
    { control_state: "operational", enrollment_enabled: true,
      upload_registration_enabled: true, processing_enabled: true, publication_enabled: true },
    { control_state: "contained", enrollment_enabled: false,
      upload_registration_enabled: false, processing_enabled: false, publication_enabled: false },
    { revision: 1 },
    { revision: 14 },
    { revision: 16 },
    { enrollment_enabled: true },
    { upload_registration_enabled: false },
    { processing_enabled: false },
    { publication_enabled: true },
  ]) {
    await assert.rejects(
      assertSyntheticV12RuntimeReady({ primaryPool: runtimePool(controls), schema: "tibotattle" }),
      { code: "SMOKE_RUNTIME_CONTROLS_NOT_READY" },
    );
  }
});

test("a wrong revision blocks fixture seeding before the authenticated journey", async () => {
  const fake = fakeDependencies();
  const dependencies = {
    ...fake.dependencies,
    async assertRuntimeReady() {
      await assertSyntheticV12RuntimeReady({
        primaryPool: runtimePool({ revision: 14 }),
        schema: "tibotattle",
      });
    },
  };
  await assert.rejects(
    runSyntheticV12Smoke({ config: parseSyntheticV12SmokeConfig(env()), dependencies }),
    { code: "SMOKE_RUNTIME_CONTROLS_NOT_READY" },
  );
  assert.equal(fake.seedCount, 0);
});

test("fixture seed writes only uniquely tagged authority rows in one transaction", async () => {
  const statements = [];
  const client = {
    async query(sql, params) { statements.push({ sql, params }); return { rowCount: 1, rows: [] }; },
    release() { statements.push({ sql: "RELEASE", params: [] }); },
  };
  const pool = { async connect() { return client; } };
  let idIndex = 0;
  let byteIndex = 0;
  const fixture = await seedSyntheticV12Fixture({
    pool,
    schema: "test_primary",
    now: new Date("2026-09-24T00:00:00.000Z"),
    randomUUIDImpl: () => IDS[idIndex++],
    randomBytesImpl: (length) => Buffer.alloc(length, ++byteIndex),
  });
  assert.equal(fixture.participantId, `${SYNTHETIC_V12_SMOKE_PARTICIPANT_PREFIX}${IDS[0]}`);
  assert.equal(fixture.deviceId, IDS[3]);
  assert.match(fixture.ownerDigest, /^[a-f0-9]{64}$/u);
  assert.match(fixture.enrollmentNamespace, /^[a-f0-9]{64}$/u);
  assert.deepEqual(statements.map(({ sql }) => sql === "RELEASE" ? sql : sql.match(/(?:INSERT INTO|BEGIN|COMMIT)/u)?.[0]), [
    "BEGIN", "INSERT INTO", "INSERT INTO", "INSERT INTO", "INSERT INTO", "INSERT INTO", "INSERT INTO", "INSERT INTO", "COMMIT", "RELEASE",
  ]);
  assert.equal(statements.some(({ sql }) => /UPDATE .*collection_controls|DELETE FROM/u.test(sql)), false);
  assert.equal(statements.filter(({ sql }) => /INSERT INTO/u.test(sql)).length, 7);
  assert.ok(statements.every(({ sql }) => !/POSTGRES_RATE_LIMIT_SECRET/u.test(sql)));
});

test("synthetic encrypted chunk round-trips using only the public envelope key", async () => {
  const keyPair = await webcrypto.subtle.generateKey({
    name: "RSA-OAEP",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }, true, ["encrypt", "decrypt"]);
  const publicJwk = { ...await webcrypto.subtle.exportKey("jwk", keyPair.publicKey), kid: "key:test" };
  const { manifest, chunk } = makeManifestAndChunk({
    day: "2026-09-24",
    sessionId: IDS[1],
    randomUUIDImpl: () => IDS[6],
  });
  const parsedChunk = parseTelemetryV12Chunk(chunk);
  assert.equal(createHash("sha256")
    .update(canonicalTelemetryV12Json(parsedChunk.records)).digest("hex"), parsedChunk.chunkDigest);
  assert.equal(manifest.chunks[0].chunkDigest, chunk.chunkDigest);
  const envelope = await encryptSyntheticV12Envelope(chunk, publicJwk);
  const privateJwk = await webcrypto.subtle.exportKey("jwk", keyPair.privateKey);
  const rsa = await webcrypto.subtle.importKey(
    "jwk", privateJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"],
  );
  const rawKey = await webcrypto.subtle.decrypt(
    { name: "RSA-OAEP" }, rsa, Buffer.from(envelope.wrappedKey, "base64url"),
  );
  const aes = await webcrypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await webcrypto.subtle.decrypt({
    name: "AES-GCM",
    iv: Buffer.from(envelope.iv, "base64url"),
  }, aes, Buffer.from(envelope.ciphertext, "base64url"));
  assert.equal(new TextDecoder().decode(plaintext), canonicalTelemetryV12Json(chunk));
});

test("PostgreSQL readback uses ISO date text and identifies the failing stage", async () => {
  const envelopeBytes = Buffer.from('{"synthetic":"v12-readback-test"}');
  const envelopeDigest = createHash("sha256").update(envelopeBytes).digest("hex");
  const manifestDigest = "a".repeat(64);
  const chunkDigest = "b".repeat(64);
  const objectKey = "telemetry/v12-50000000-0000-4000-8000-000000000001";
  let failureStage = "";
  let gcsReads = 0;
  const primaryPool = {
    async query(sql) {
      if (sql.includes('"telemetry_v12_day_manifests"')) {
        assert.match(sql, /chunk_day::text AS chunk_day/u);
        return { rows: [{
          id: MANIFEST_ID,
          manifest_digest: manifestDigest,
          chunk_day: failureStage === "manifest" ? "2026-09-23" : "2026-09-24",
          expected_chunk_count: 1,
        }] };
      }
      if (sql.includes('"telemetry_v12_chunks"')) {
        return { rows: [{
          id: CONTRIBUTION_ID,
          chunk_id: "usage:2026-09-24:0",
          chunk_digest: failureStage === "chunk" ? "c".repeat(64) : chunkDigest,
          envelope_digest: envelopeDigest,
          record_count: 1,
          r2_key: objectKey,
        }] };
      }
      if (sql.includes('"device_upload_authorizations"')) {
        return { rows: failureStage === "grants" ? [] : [
          { state: "consumed", consumed_contribution_id: CONTRIBUTION_ID },
          { state: "revoked", consumed_contribution_id: null },
        ] };
      }
      if (sql.includes('"pending_objects"')) {
        return { rows: failureStage === "journal" ? [] : [{
          object_key: objectKey,
          object_kind: "telemetry_v12",
          reconciliation_state: "registered",
        }] };
      }
      throw new Error("unexpected PostgreSQL readback query");
    },
  };
  const input = {
    primaryPool,
    primarySchema: "tibotattle",
    async readGcsObject({ bucket, key }) {
      assert.equal(bucket, SYNTHETIC_V12_SMOKE_BUCKET);
      assert.equal(key, objectKey);
      gcsReads += 1;
      return { size: envelopeBytes.length, bytes: new Uint8Array(envelopeBytes) };
    },
    bucket: SYNTHETIC_V12_SMOKE_BUCKET,
    fixture: { participantId: PARTICIPANT_ID, deviceId: DEVICE_ID },
    manifest: { manifestDigest, day: "2026-09-24" },
    manifestId: MANIFEST_ID,
    chunk: { chunkId: "usage:2026-09-24:0", chunkDigest },
    envelopeDigest,
    envelopeByteLength: envelopeBytes.length,
    contributionId: CONTRIBUTION_ID,
  };
  assert.deepEqual(await postgresAndGcsReadback(input), { postgres: true, gcs: true });
  assert.equal(gcsReads, 1);
  for (const [stage, code] of [
    ["manifest", "SMOKE_POSTGRES_READBACK_MANIFEST_MISMATCH"],
    ["chunk", "SMOKE_POSTGRES_READBACK_CHUNK_MISMATCH"],
    ["grants", "SMOKE_POSTGRES_READBACK_GRANTS_MISMATCH"],
    ["journal", "SMOKE_POSTGRES_READBACK_JOURNAL_MISMATCH"],
  ]) {
    failureStage = stage;
    await assert.rejects(postgresAndGcsReadback(input), { code });
    assert.equal(gcsReads, 1);
  }
});

test("GCS readback pins the test bucket/object, uses bounded authenticated GETs, and returns exact bytes", async () => {
  const key = "telemetry/v12-50000000-0000-4000-8000-000000000001";
  const body = Buffer.from("{\"envelope\":\"synthetic-only\"}");
  const requests = [];
  const result = await readSyntheticGcsObject({
    bucket: SYNTHETIC_V12_SMOKE_BUCKET,
    key,
    accessToken: async () => SERVERLESS_TOKEN,
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      if (url.pathname.startsWith("/storage/v1/")) {
        return response(200, { bucket: SYNTHETIC_V12_SMOKE_BUCKET, name: key,
          size: String(body.byteLength), generation: "123" });
      }
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(body.byteLength) },
      });
    },
  });
  assert.equal(result.size, body.byteLength);
  assert.deepEqual(Buffer.from(result.bytes), body);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url.origin, "https://storage.googleapis.com");
    assert.equal(request.options.method, "GET");
    assert.equal(request.options.redirect, "manual");
    assert.equal(request.options.headers.authorization, `Bearer ${SERVERLESS_TOKEN}`);
  }
  await assert.rejects(readSyntheticGcsObject({
    bucket: SYNTHETIC_V12_SMOKE_BUCKET,
    key,
    accessToken: async () => SERVERLESS_TOKEN,
    maximumBytes: 2,
    fetchImpl: async (url) => url.pathname.startsWith("/storage/v1/")
      ? response(200, { bucket: SYNTHETIC_V12_SMOKE_BUCKET, name: key,
        size: String(body.byteLength), generation: "123" })
      : new Response(body, { status: 200, headers: { "content-length": String(body.byteLength) } }),
  }), { code: "SMOKE_GCS_OBJECT_TOO_LARGE" });
});

test("smoke journey keeps IAM and participant credentials separate and replays exact bytes", async () => {
  const fake = fakeDependencies();
  const receipt = await runSyntheticV12Smoke({
    config: parseSyntheticV12SmokeConfig(env()),
    dependencies: fake.dependencies,
  });
  assert.deepEqual({
    manifest: receipt.manifest,
    chunk: receipt.chunk,
    syncState: receipt.syncState,
    postgresReadback: receipt.postgresReadback,
    gcsReadback: receipt.gcsReadback,
  }, {
    manifest: "staged_and_exactly_replayed",
    chunk: "staged_and_exactly_replayed",
    syncState: "empty_history_admission_available",
    postgresReadback: true,
    gcsReadback: true,
  });
  assert.equal(fake.getTokenCount, 8);
  const anonymous = fake.calls[0];
  assert.equal(anonymous.options.headers.authorization, undefined);
  assert.equal(anonymous.options.headers["x-serverless-authorization"], undefined);
  const authenticated = fake.calls.slice(1);
  assert.equal(authenticated.length, 8);
  for (const call of authenticated) {
    assert.equal(call.url.origin, CLOUD_RUN_IAM_TEST_TARGET.origin);
    assert.equal(call.options.redirect, "manual");
    assert.equal(call.options.headers["x-serverless-authorization"], `Bearer ${SERVERLESS_TOKEN}`);
    assert.equal(call.options.headers.host, undefined);
    assert.equal(call.options.headers["x-forwarded-host"], undefined);
    assert.equal(call.options.headers["x-forwarded-authorization"], undefined);
  }
  const deviceAuthCalls = authenticated.filter((call) =>
    call.options.headers.authorization?.startsWith("Device "));
  const grantAuthCalls = authenticated.filter((call) =>
    call.options.headers.authorization?.startsWith("Upload "));
  assert.equal(deviceAuthCalls.length, 5);
  assert.equal(grantAuthCalls.length, 2);
  assert.equal(grantAuthCalls[0].options.headers.authorization, `Upload ${GRANT_TOKEN_1}`);
  assert.equal(grantAuthCalls[1].options.headers.authorization, `Upload ${GRANT_TOKEN_2}`);
  const manifests = authenticated.filter((call) => call.url.pathname.endsWith("day-manifests"));
  assert.equal(manifests.length, 2);
  assert.equal(manifests[0].options.body, manifests[1].options.body);
  const chunks = authenticated.filter((call) => call.url.pathname === "/api/v1/contributions");
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].options.body, chunks[1].options.body);
  assert.equal(JSON.stringify(receipt).includes(SERVERLESS_TOKEN), false);
  assert.equal(JSON.stringify(receipt).includes(DEVICE_SECRET), false);
  assert.equal(JSON.stringify(receipt).includes(GRANT_TOKEN_1), false);
  assert.equal(JSON.stringify(receipt).includes(MANIFEST_ID), false);
  assert.equal(JSON.stringify(receipt).includes(CONTRIBUTION_ID), false);
});

test("unauthenticated direct-origin health must fail before fixture creation", async () => {
  const fake = fakeDependencies({ anonymousStatus: 200 });
  await assert.rejects(
    runSyntheticV12Smoke({ config: parseSyntheticV12SmokeConfig(env()), dependencies: fake.dependencies }),
    { code: "SMOKE_UNAUTHENTICATED_ORIGIN_REACHABLE" },
  );
  assert.equal(fake.seedCount, 0);
});

test("failed hosted write reports only a safe orphan prefix and never response bodies or credentials", async () => {
  const fake = fakeDependencies({ failManifest: true });
  let failure;
  try {
    await runSyntheticV12Smoke({ config: parseSyntheticV12SmokeConfig(env()), dependencies: fake.dependencies });
  } catch (error) { failure = error; }
  assert.equal(failure?.code, "SMOKE_MANIFEST_FAILED_REQUEST_REJECTED");
  assert.equal(failure?.orphaned, true);
  assert.equal(failure?.orphanMarker, SYNTHETIC_V12_SMOKE_PARTICIPANT_PREFIX);
  for (const secret of [SERVERLESS_TOKEN, DEVICE_SECRET, GRANT_TOKEN_1, "sensitive-request-id"]) {
    assert.equal(`${failure.message}${JSON.stringify(failure)}`.includes(secret), false);
  }
});
