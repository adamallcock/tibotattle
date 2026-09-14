import { applyD1Migrations, env, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalTelemetryV11Json,
  TELEMETRY_V11_ENVELOPE_SCHEMA_VERSION,
  type TelemetryV11Envelope,
} from "@app-usagemonitor/telemetry-contract";
import {
  ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
  ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
  ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
} from "../src/accountless-enrollment";
import {
  ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
  ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
  ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
} from "../src/accountless-ownership";
import { ACCOUNTLESS_RENEWAL_SCHEMA_VERSION } from "../src/accountless-renewal";
import {
  deviceAuthorizationCapabilityHash,
  uploadAuthorizationCapabilityHash,
} from "../src/device-auth";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { handleRequest } from "../src/index";
import { configureStorageShardAllocation, recordStorageCapacityObservation } from "../src/storage-capacity";
import { qualifyStorageShardForTest } from './helpers/storage-shard-readiness';
import {
  createCatalogStorageRouter,
  initializeAccountlessIssuanceBaseline,
  STORAGE_NEW_OWNER_CUTOFF_BYTES,
} from "../src/storage-routing";
import { initializeStorageSource } from "../src/analytics-delivery";
import {
  initializeTypedV11Admission,
  persistTypedV11StagedChunk,
} from "../src/typed-v11-admission";
import {
  createV11DeviceFixture,
  makeV11Day,
  v11UsageRecord,
} from "./helpers/telemetry-v11";
import {
  authenticateDevice,
  claimDeviceUploadAuthorization,
  createDeviceUploadAuthorization,
} from "../src/device-auth";
import { registerTelemetryV11DayManifest } from "../src/telemetry-v11-repository";
import { participantDeletionDigest } from "../src/participant-deletion-digest";
import { recordCatalogDeletionReplayPending } from "../src/retention";
import {
  participantStorageLocatorDigest,
  registerParticipantOwnerRoute,
  storageForParticipantOwner,
} from "../src/storage-routing-runtime";

interface Bindings extends Env {
  STORAGE_ROUTING_DB: D1Database;
  STORAGE_INGESTION_A: D1Database;
  STORAGE_INGESTION_B: D1Database;
  STORAGE_INGESTION_C: D1Database;
  TEST_MIGRATIONS: D1Migration[];
  TEST_ROUTING_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ROUTING_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
}

const ORIGIN = "https://example.test";
const bindings = () => env as Bindings;
const catalog = () => bindings().STORAGE_ROUTING_DB;
const shardA = () => bindings().STORAGE_INGESTION_A;
const shardB = () => bindings().STORAGE_INGESTION_B;
const shardC = () => bindings().STORAGE_INGESTION_C;
const KEY_ID = "key:synthetic-shard-routing";
const NAMESPACE = "synthetic-original-ingestion-a";
const NAMESPACE_B = "synthetic-original-ingestion-b";
const NAMESPACE_C = "synthetic-original-ingestion-c";
let publicJwk: JsonWebKey;
let publicText = "";
let privateText = "";

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({
    name: "RSA-OAEP", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
  }, true, ["encrypt", "decrypt"]);
  if (!("publicKey" in pair)) throw new Error("synthetic RSA pair required");
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (exported instanceof ArrayBuffer) throw new Error("synthetic JWK required");
  publicJwk = exported;
  publicText = JSON.stringify({ ...exported, kid: KEY_ID });
  privateText = JSON.stringify({
    ...await crypto.subtle.exportKey("jwk", pair.privateKey), kid: KEY_ID,
  });
});

function runtime(overrides: Partial<Env> = {}): Env {
  return {
    ...bindings(),
    ENVIRONMENT: "synthetic-development",
    ACCOUNT_SCOPED_INGEST_MODE: "disabled",
    ACCOUNTLESS_ENROLLMENT_MODE: "enabled",
    ACCOUNTLESS_OWNERSHIP_MODE: "enabled",
    STORAGE_ROUTING_MODE: "catalog",
    STORAGE_NEW_OWNER_RESERVATION_BYTES: "16777216",
    TELEMETRY_STORAGE_MODE: "typed",
    TELEMETRY_STORAGE_NAMESPACE: NAMESPACE,
    STORAGE_SOURCE_NAMESPACE_A: NAMESPACE,
    STORAGE_SOURCE_NAMESPACE_B: NAMESPACE_B,
    STORAGE_SOURCE_NAMESPACE_C: NAMESPACE_C,
    ENVELOPE_PUBLIC_JWK: publicText,
    ENVELOPE_PRIVATE_JWK: privateText,
    ...overrides,
  } as unknown as Env;
}

async function api(path: string, init: RequestInit, target = runtime()): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("origin", ORIGIN);
  return handleRequest(new Request(`${ORIGIN}${path}`, { ...init, headers }), target);
}

async function encrypted(value: unknown): Promise<TelemetryV11Envelope> {
  const rsa = await crypto.subtle.importKey("jwk", publicJwk,
    { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  if ("privateKey" in key) throw new Error("synthetic symmetric key required");
  const raw = await crypto.subtle.exportKey("raw", key);
  if (!(raw instanceof ArrayBuffer)) throw new Error("synthetic raw key required");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    return {
      schemaVersion: TELEMETRY_V11_ENVELOPE_SCHEMA_VERSION,
      synthetic: false,
      keyId: KEY_ID,
      wrappedKey: encodeBase64Url(new Uint8Array(await crypto.subtle.encrypt(
        { name: "RSA-OAEP" }, rsa, raw))),
      iv: encodeBase64Url(iv),
      ciphertext: encodeBase64Url(new Uint8Array(await crypto.subtle.encrypt(
        { name: "AES-GCM", iv }, key,
        new TextEncoder().encode(canonicalTelemetryV11Json(value))))),
    };
  } finally {
    new Uint8Array(raw).fill(0);
  }
}

async function prepareTyped(database: D1Database, namespace = NAMESPACE,
  sourceId = "synthetic-shard-journal"): Promise<void> {
  await applyD1Migrations(database, bindings().TEST_TYPED_INGESTION_MIGRATIONS);
  await initializeStorageSource(database, sourceId);
  await applyD1Migrations(database, bindings().TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(database, bindings().TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await initializeTypedV11Admission(database, namespace);
}

async function deviceSecretHash(deviceId: string, secret: Uint8Array): Promise<string> {
  const prefix = new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`);
  const value = new Uint8Array(prefix.byteLength + secret.byteLength);
  value.set(prefix);
  value.set(secret, prefix.byteLength);
  try {
    return await sha256Hex(value);
  } finally {
    value.fill(0);
  }
}

function ownerBody() {
  return {
    schemaVersion: ACCOUNTLESS_UPLOAD_OWNER_SCHEMA_VERSION,
    policyVersion: ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
    authorizationBasis: ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
    telemetrySchemaVersion: ACCOUNTLESS_UPLOAD_OWNER_TELEMETRY_SCHEMA_VERSION,
  };
}

async function enroll(deviceId: string, secret: Uint8Array): Promise<Response> {
  return api("/api/v1/accountless/enrollment", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
      deviceId,
      deviceSecretHash: await deviceSecretHash(deviceId, secret),
      policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
      authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
    }),
  });
}

function authorization(deviceId: string, secret: Uint8Array): string {
  return `Device um_device_${deviceId}.${encodeBase64Url(secret)}`;
}

async function own(deviceId: string, secret: Uint8Array): Promise<Response> {
  return api("/api/v1/accountless/ownership", {
    method: "POST",
    headers: {
      authorization: authorization(deviceId, secret),
      "content-type": "application/json",
    },
    body: JSON.stringify(ownerBody()),
  });
}

async function registerUpload(deviceAuthorization: string, raw: string,
  target = runtime()): Promise<string> {
  const response = await api("/api/v1/device/upload-authorizations", {
    method: "POST",
    headers: {
      authorization: deviceAuthorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      envelopeDigest: await sha256Hex(raw),
      contentLengthBytes: new TextEncoder().encode(raw).byteLength,
      contentType: "application/json",
      telemetrySchemaVersion: "telemetry-contribution-v1.1",
    }),
  }, target);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json<{ uploadAuthorization: string }>())
    .uploadAuthorization;
}

async function preparedV11Owner(options: {database?: D1Database; namespace?: string;
  sourceId?: string} = {}): Promise<{
  deviceId: string; secret: Uint8Array; deviceAuthorization: string;
  raw: string; upload: string;
}> {
  await prepareTyped(options.database ?? shardA(), options.namespace, options.sourceId);
  const deviceId = crypto.randomUUID();
  const secret = crypto.getRandomValues(new Uint8Array(32));
  expect((await enroll(deviceId, secret)).status).toBe(201);
  expect((await own(deviceId, secret)).status).toBe(201);
  const deviceAuthorization = authorization(deviceId, secret);
  const day = new Date().toISOString().slice(0, 10);
  const value = await makeV11Day(day, { usage: [v11UsageRecord(day)] });
  const manifest = await api("/api/v1/device/telemetry/v1.1/day-manifests", {
    method: "POST",
    headers: {
      authorization: deviceAuthorization,
      "content-type": "application/json",
    },
    body: JSON.stringify(value.manifest),
  });
  expect(manifest.status, await manifest.clone().text()).toBe(201);
  const raw = JSON.stringify(await encrypted(value.chunks[0]));
  return {
    deviceId, secret, deviceAuthorization, raw,
    upload: await registerUpload(deviceAuthorization, raw),
  };
}

function fenceDuringTypedAdmission(database: D1Database,
  fence: () => Promise<void>): D1Database {
  const chunkStatements = new WeakSet<object>();
  return new Proxy(database, {
    get(target, key) {
      if (key === "prepare") {
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!/INSERT INTO telemetry_v11_chunks\s*\(/u.test(sql)) return statement;
          return new Proxy(statement, {
            get(value, member) {
              if (member === "bind") return (...values: Parameters<D1PreparedStatement["bind"]>) => {
                const bound = value.bind(...values);
                chunkStatements.add(bound);
                return bound;
              };
              const property = Reflect.get(value, member);
              return typeof property === "function" ? property.bind(value) : property;
            },
          });
        };
      }
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        if (statements.some((statement) => chunkStatements.has(statement))) await fence();
        return target.batch(statements);
      };
      const property = Reflect.get(target, key);
      return typeof property === "function" ? property.bind(target) : property;
    },
  });
}

function refuseParticipantLocator(database: D1Database): D1Database {
  return new Proxy(database, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (!/INSERT INTO storage_participant_(?:owner|deletion_replay)_locators/u.test(sql)) {
          return statement;
        }
        return new Proxy(statement, {
          get(value, member) {
            if (member === "bind") {
              return (...values: Parameters<D1PreparedStatement["bind"]>) => {
                const bound = value.bind(...values);
                return new Proxy(bound, {
                  get(entry, operation) {
                    if (operation === "run") return async () => {
                      throw new Error("synthetic catalog publication refusal");
                    };
                    const property = Reflect.get(entry, operation);
                    return typeof property === "function" ? property.bind(entry) : property;
                  },
                });
              };
            }
            const property = Reflect.get(value, member);
            return typeof property === "function" ? property.bind(value) : property;
          },
        });
      };
      if (key === "batch") return async () => {
        throw new Error("synthetic catalog publication refusal");
      };
      const property = Reflect.get(target, key);
      return typeof property === "function" ? property.bind(target) : property;
    },
  });
}

function refuseAccountlessLedgerBatch(database: D1Database): D1Database {
  const enrollmentStatements = new WeakSet<object>();
  return new Proxy(database, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (!/INSERT INTO accountless_enrollment_ledger/u.test(sql)) return statement;
        return new Proxy(statement, {
          get(value, member) {
            if (member === "bind") return (...values: Parameters<D1PreparedStatement["bind"]>) => {
              const bound = value.bind(...values);
              enrollmentStatements.add(bound);
              return bound;
            };
            const property = Reflect.get(value, member);
            return typeof property === "function" ? property.bind(value) : property;
          },
        });
      };
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        if (statements.some((statement) => enrollmentStatements.has(statement))) {
          throw new Error("synthetic shard enrollment refusal");
        }
        return target.batch(statements);
      };
      const property = Reflect.get(target, key);
      return typeof property === "function" ? property.bind(target) : property;
    },
  });
}

function loseFirstCatalogBatchAcknowledgement(database: D1Database): D1Database {
  let lost = false;
  return new Proxy(database, {
    get(target, key) {
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        const result = await target.batch(statements);
        if (!lost) {
          lost = true;
          throw new Error("synthetic committed catalog acknowledgement loss");
        }
        return result;
      };
      const property = Reflect.get(target, key);
      return typeof property === "function" ? property.bind(target) : property;
    },
  });
}

function refuseCatalogIssuanceBatch(database: D1Database): D1Database {
  const issuanceStatements = new WeakSet<object>();
  return new Proxy(database, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (!/INSERT INTO storage_accountless_issuance_reservations/u.test(sql)) {
          return statement;
        }
        return new Proxy(statement, {
          get(value, member) {
            if (member === "bind") return (...values: Parameters<D1PreparedStatement["bind"]>) => {
              const bound = value.bind(...values);
              issuanceStatements.add(bound);
              return bound;
            };
            const property = Reflect.get(value, member);
            return typeof property === "function" ? property.bind(value) : property;
          },
        });
      };
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        if (statements.some((statement) => issuanceStatements.has(statement))) {
          throw new Error("synthetic catalog issuance refusal");
        }
        return target.batch(statements);
      };
      const property = Reflect.get(target, key);
      return typeof property === "function" ? property.bind(target) : property;
    },
  });
}

async function prepareEnrollmentRoute(deviceId: string, secret: Uint8Array,
  ownerId: string, shardId: "a" | "b"): Promise<void> {
  const route = await createCatalogStorageRouter({
    catalog: catalog(),
    bindings: {
      STORAGE_INGESTION_A: shardA(),
      STORAGE_INGESTION_B: shardB(),
      STORAGE_INGESTION_C: shardC(),
    },
    clock: Date.now,
  }).ensureOwner(ownerId, shardId, 16_777_216);
  const capabilityHash = await deviceSecretHash(deviceId, secret);
  await catalog().prepare(`INSERT INTO storage_capability_locators
    (capability_hash,owner_id,state) VALUES (?,?,'active')`)
    .bind(capabilityHash, route.ownerId).run();
}

async function observe(shardId: string, observedBytes: number,
  allocationTier: "active" | "spare" = "active"): Promise<void> {
  await recordStorageCapacityObservation(catalog(), {
    shardId, observedBytes, observedAt: Date.now() - 1000,
    validUntil: Date.now() + 60_000, pressureState: "normal",
  });
  const readiness=await qualifyStorageShardForTest(catalog(),{shardId,
    bindingName:`STORAGE_INGESTION_${shardId.toUpperCase()}`,qualifiedAt:Date.now()-1000});
  await configureStorageShardAllocation(catalog(), {
    shardId, allocationTier, allocationEnabled: true, qualificationDigest:readiness.readinessDigest,
    updatedAt: Date.now() - 1000,
  });
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(bindings().USAGE_MONITOR_DB, bindings().TEST_MIGRATIONS);
  await applyD1Migrations(bindings().DELETION_LEDGER,
    bindings().TEST_DELETION_LEDGER_MIGRATIONS);
  await applyD1Migrations(catalog(), bindings().TEST_ROUTING_MIGRATIONS);
  await initializeAccountlessIssuanceBaseline(catalog(), {
    budgetDay: new Date().toISOString().slice(0, 10),
    dailyReserved: 0,
    lifetimeReserved: 0,
    baselineDigest: "f".repeat(64),
    initializedAt: Date.now() - 2_000,
  });
  for (const database of [shardA(), shardB(), shardC()]) {
    await applyD1Migrations(database, bindings().TEST_MIGRATIONS);
    await applyD1Migrations(database,
      bindings().TEST_INGESTION_ROUTING_MIGRATIONS);
  }
  await catalog().batch([
    catalog().prepare("INSERT INTO storage_shards (shard_id,binding_name,state) VALUES ('a','STORAGE_INGESTION_A','active')"),
    catalog().prepare("INSERT INTO storage_shards (shard_id,binding_name,state) VALUES ('b','STORAGE_INGESTION_B','active')"),
    catalog().prepare("INSERT INTO storage_shards (shard_id,binding_name,state) VALUES ('c','STORAGE_INGESTION_C','active')"),
  ]);
  await observe("a", 1_000);
  await observe("b", 2_000);
  await observe("c", 0, "spare");
  await shardA().prepare(`UPDATE telemetry_transport_formats SET lifecycle='accepted'
    WHERE schema_version='telemetry-contribution-v1.1'`).run();
  await shardB().prepare(`UPDATE telemetry_transport_formats SET lifecycle='accepted'
    WHERE schema_version='telemetry-contribution-v1.1'`).run();
});

describe("catalog-routed accountless HTTP lifecycle", () => {
  it("refuses catalog enrollment until the historical issuance baseline is qualified", async () => {
    await catalog().prepare(`UPDATE storage_accountless_issuance_state
      SET budget_day='1970-01-01',initialization_state='uninitialized',
          daily_reserved=0,lifetime_reserved=0,last_reservation_key='',
          baseline_digest=NULL,initialized_at=NULL,updated_at=0
      WHERE singleton_id=1`).run();
    const deviceId = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const response = await enroll(deviceId, secret);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "ADMISSION_CONFIGURATION_INVALID" },
    });
    expect(await catalog().prepare(`SELECT count(*) AS n
      FROM storage_owner_routes`).first("n")).toBe(0);
    expect(await shardA().prepare(`SELECT count(*) AS n
      FROM accountless_enrollment_ledger`).first("n")).toBe(0);
  });

  it("routes two synthetic owners to separate shards while preserving replay", async () => {
    const firstId = crypto.randomUUID();
    const firstSecret = crypto.getRandomValues(new Uint8Array(32));
    const first = await enroll(firstId, firstSecret);
    expect(first.status, await first.clone().text()).toBe(201);
    const replay = await enroll(firstId, firstSecret);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect((await own(firstId, firstSecret)).status).toBe(201);

    await observe("a", STORAGE_NEW_OWNER_CUTOFF_BYTES);
    const secondId = crypto.randomUUID();
    const secondSecret = crypto.getRandomValues(new Uint8Array(32));
    expect((await enroll(secondId, secondSecret)).status).toBe(201);
    expect((await own(secondId, secondSecret)).status).toBe(201);

    expect(await shardA().prepare("SELECT count(*) AS n FROM accountless_upload_owners").first("n")).toBe(1);
    expect(await shardB().prepare("SELECT count(*) AS n FROM accountless_upload_owners").first("n")).toBe(1);
    expect(await shardC().prepare("SELECT count(*) AS n FROM accountless_upload_owners").first("n")).toBe(0);
    expect(await bindings().USAGE_MONITOR_DB.prepare("SELECT count(*) AS n FROM accountless_upload_owners").first("n")).toBe(0);
    const participantId = await shardA().prepare(
      "SELECT participant_id FROM accountless_upload_owners LIMIT 1")
      .first<string>("participant_id");
    expect(participantId).toBeTruthy();
    const digest = await participantStorageLocatorDigest(participantId!);
    expect(await catalog().prepare(`SELECT count(*) AS n
      FROM storage_participant_owner_locators
      WHERE participant_digest=? AND participant_digest<>?`)
      .bind(digest, participantId).first("n")).toBe(1);
    expect(await catalog().prepare(`SELECT count(*) AS n
      FROM storage_participant_deletion_replay_locators
      WHERE participant_digest=? AND participant_digest<>?`)
      .bind(await participantDeletionDigest(participantId!), participantId).first("n")).toBe(1);
    expect((await storageForParticipantOwner(runtime(), participantId!)).route)
      .toMatchObject({ ownerId: expect.stringMatching(/^accountless:/u), shardId: "a" });
    expect(await catalog().prepare(`SELECT daily_reserved,lifetime_reserved
      FROM storage_accountless_issuance_state WHERE singleton_id=1`).first())
      .toEqual({ daily_reserved: 2, lifetime_reserved: 2 });
    expect(await shardA().prepare(`SELECT daily_issued FROM accountless_enrollment_issuance
      WHERE singleton=1`).first("daily_issued")).toBe(0);
    expect(await shardB().prepare(`SELECT daily_issued FROM accountless_enrollment_issuance
      WHERE singleton=1`).first("daily_issued")).toBe(0);
  });

  it("enforces one global final issuance slot across different routed shards", async () => {
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const firstSecret = crypto.getRandomValues(new Uint8Array(32));
    const secondSecret = crypto.getRandomValues(new Uint8Array(32));
    await prepareEnrollmentRoute(firstId, firstSecret, "accountless:global-a", "a");
    await prepareEnrollmentRoute(secondId, secondSecret, "accountless:global-b", "b");
    const day = new Date().toISOString().slice(0, 10);
    await catalog().prepare(`UPDATE storage_accountless_issuance_state
      SET budget_day=?,daily_reserved=999,lifetime_reserved=9999,
          last_reservation_key='',updated_at=? WHERE singleton_id=1`)
      .bind(day, Date.now()).run();

    const [first, second] = await Promise.all([
      enroll(firstId, firstSecret),
      enroll(secondId, secondSecret),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 429]);
    const winner = first.status === 201
      ? { id: firstId, secret: firstSecret }
      : { id: secondId, secret: secondSecret };
    const loser = first.status === 429
      ? { id: firstId, secret: firstSecret }
      : { id: secondId, secret: secondSecret };
    expect((await enroll(winner.id, winner.secret)).status).toBe(200);
    expect((await enroll(loser.id, loser.secret)).status).toBe(429);
    expect(await catalog().prepare(`SELECT daily_reserved,lifetime_reserved
      FROM storage_accountless_issuance_state WHERE singleton_id=1`).first())
      .toEqual({ daily_reserved: 1000, lifetime_reserved: 10000 });
    expect(await catalog().prepare(`SELECT count(*) AS n
      FROM storage_accountless_issuance_reservations`).first("n")).toBe(1);
    const localRows = Number(await shardA().prepare(`SELECT count(*) AS n
      FROM accountless_enrollment_ledger`).first("n"))
      + Number(await shardB().prepare(`SELECT count(*) AS n
        FROM accountless_enrollment_ledger`).first("n"));
    expect(localRows).toBe(1);
  });

  it("keeps a catalog reservation spent after a definite shard refusal and retries exactly", async () => {
    const deviceId = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const refused = await api("/api/v1/accountless/enrollment", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
        deviceId,
        deviceSecretHash: await deviceSecretHash(deviceId, secret),
        policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
        authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
      }),
    }, runtime({ STORAGE_INGESTION_A: refuseAccountlessLedgerBatch(shardA()) }));
    expect(refused.status).toBe(503);
    expect(await catalog().prepare(`SELECT count(*) AS n
      FROM storage_accountless_issuance_reservations`).first("n")).toBe(1);
    expect(await catalog().prepare(`SELECT lifetime_reserved
      FROM storage_accountless_issuance_state WHERE singleton_id=1`)
      .first("lifetime_reserved")).toBe(1);
    expect(await shardA().prepare(`SELECT count(*) AS n
      FROM accountless_enrollment_ledger`).first("n")).toBe(0);

    expect((await enroll(deviceId, secret)).status).toBe(201);
    expect(await catalog().prepare(`SELECT lifetime_reserved
      FROM storage_accountless_issuance_state WHERE singleton_id=1`)
      .first("lifetime_reserved")).toBe(1);
    expect(await catalog().prepare(`SELECT count(*) AS n
      FROM storage_owner_routes`).first("n")).toBe(1);
  });

  it("creates no shard authority when the central reservation is not durable", async () => {
    const deviceId = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const response = await api("/api/v1/accountless/enrollment", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
        deviceId,
        deviceSecretHash: await deviceSecretHash(deviceId, secret),
        policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
        authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
      }),
    }, runtime({ STORAGE_ROUTING_DB: refuseCatalogIssuanceBatch(catalog()) }));
    expect(response.status).toBe(503);
    expect(await catalog().prepare(`SELECT count(*) AS n
      FROM storage_accountless_issuance_reservations`).first("n")).toBe(0);
    expect(await catalog().prepare(`SELECT count(*) AS n
      FROM storage_owner_routes`).first("n")).toBe(0);
    expect(await shardA().prepare(`SELECT count(*) AS n
      FROM accountless_enrollment_ledger`).first("n")).toBe(0);
  });

  it("keeps the original budget day when a failed shard write retries after midnight", async () => {
    const deviceId = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    // Keep the boundary ahead of the issuance baseline seeded during setup.
    const boundary = new Date(Date.now());
    boundary.setUTCDate(boundary.getUTCDate() + 1);
    boundary.setUTCHours(23, 59, 59, 0);
    const firstInstant = boundary.getTime();
    const firstBudgetDay = boundary.toISOString().slice(0, 10);
    const retryInstant = firstInstant + 2_000;
    await recordStorageCapacityObservation(catalog(), {
      shardId: "a", observedBytes: 1_000, observedAt: firstInstant - 1_000,
      validUntil: retryInstant + 60_000, pressureState: "normal",
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(firstInstant);
    try {
      const body = JSON.stringify({
        schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
        deviceId,
        deviceSecretHash: await deviceSecretHash(deviceId, secret),
        policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
        authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
      });
      const first = await api("/api/v1/accountless/enrollment", {
        method: "POST", headers: { "content-type": "application/json" }, body,
      }, runtime({ STORAGE_INGESTION_A: refuseAccountlessLedgerBatch(shardA()) }));
      expect(first.status).toBe(503);
      clock.mockReturnValue(retryInstant);
      const retry = await api("/api/v1/accountless/enrollment", {
        method: "POST", headers: { "content-type": "application/json" }, body,
      });
      expect(retry.status, await retry.clone().text()).toBe(201);
      expect(await catalog().prepare(`SELECT budget_day,reserved_at
        FROM storage_accountless_issuance_reservations`).first())
        .toEqual({ budget_day: firstBudgetDay, reserved_at: firstInstant });
      expect(await catalog().prepare(`SELECT budget_day,daily_reserved,lifetime_reserved
        FROM storage_accountless_issuance_state WHERE singleton_id=1`).first())
        .toEqual({ budget_day: firstBudgetDay, daily_reserved: 1, lifetime_reserved: 1 });
    } finally {
      clock.mockRestore();
    }
  });

  it("converges after a committed catalog batch loses its acknowledgement", async () => {
    const deviceId = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const response = await api("/api/v1/accountless/enrollment", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
        deviceId,
        deviceSecretHash: await deviceSecretHash(deviceId, secret),
        policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
        authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
      }),
    }, runtime({
      STORAGE_ROUTING_DB: loseFirstCatalogBatchAcknowledgement(catalog()),
    }));
    expect(response.status, await response.clone().text()).toBe(201);
    expect(await catalog().prepare(`SELECT count(*) AS n
      FROM storage_accountless_issuance_reservations`).first("n")).toBe(1);
    expect(await catalog().prepare(`SELECT lifetime_reserved
      FROM storage_accountless_issuance_state WHERE singleton_id=1`)
      .first("lifetime_reserved")).toBe(1);
    expect(await shardA().prepare(`SELECT count(*) AS n
      FROM accountless_enrollment_ledger`).first("n")).toBe(1);
  });

  it("rejects one client device digest from splitting across two owners", async () => {
    const deviceId = crypto.randomUUID();
    const firstSecret = crypto.getRandomValues(new Uint8Array(32));
    const secondSecret = crypto.getRandomValues(new Uint8Array(32));
    expect((await enroll(deviceId, firstSecret)).status).toBe(201);
    await observe("a", STORAGE_NEW_OWNER_CUTOFF_BYTES);
    const conflict = await enroll(deviceId, secondSecret);
    expect(conflict.status).toBe(409);
    expect(await catalog().prepare(`SELECT count(*) AS n
      FROM storage_accountless_issuance_reservations`).first("n")).toBe(1);
    expect(await shardA().prepare(`SELECT count(*) AS n
      FROM accountless_enrollment_ledger`).first("n")).toBe(1);
    expect(await shardB().prepare(`SELECT count(*) AS n
      FROM accountless_enrollment_ledger`).first("n")).toBe(0);
    expect(await catalog().prepare(`SELECT count(*) AS n
      FROM storage_owner_routes`).first("n")).toBe(1);
  });

  it("keeps credential lookup separate from shard authentication and fails closed", async () => {
    const deviceId = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    expect((await enroll(deviceId, secret)).status).toBe(201);
    const wrong = crypto.getRandomValues(new Uint8Array(32));
    const response = await own(deviceId, wrong);
    expect(response.status).toBe(401);
    expect(await shardA().prepare("SELECT count(*) AS n FROM participants").first("n")).toBe(0);
  });

  it("refuses an unqualified shard before reserving or creating owner state", async () => {
    await shardA().prepare("DROP TRIGGER storage_route_write_guard").run();
    const deviceId = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const response = await enroll(deviceId, secret);
    expect(response.status).toBe(503);
    expect(await catalog().prepare("SELECT count(*) AS n FROM storage_owner_routes").first("n"))
      .toBe(0);
    expect(await shardA().prepare("SELECT count(*) AS n FROM accountless_enrollment_ledger").first("n"))
      .toBe(0);
  });

  it("refuses direct catalog and ingestion binding aliases", async () => {
    const deviceId = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const body = {
      schemaVersion: ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
      deviceId,
      deviceSecretHash: await deviceSecretHash(deviceId, secret),
      policyVersion: ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
      authorizationBasis: ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
    };
    const response = await api("/api/v1/accountless/enrollment", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, runtime({ STORAGE_INGESTION_A: catalog() }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "ADMISSION_CONFIGURATION_INVALID" },
    });
    expect(await catalog().prepare("SELECT count(*) AS n FROM storage_owner_routes").first("n"))
      .toBe(0);
  });

  it("withholds ownership success until the participant locator is durable, then converges", async () => {
    const deviceId = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    expect((await enroll(deviceId, secret)).status).toBe(201);
    const first = await api("/api/v1/accountless/ownership", {
      method: "POST",
      headers: {
        authorization: authorization(deviceId, secret),
        "content-type": "application/json",
      },
      body: JSON.stringify(ownerBody()),
    }, runtime({ STORAGE_ROUTING_DB: refuseParticipantLocator(catalog()) }));
    expect(first.status).toBe(503);
    expect(await shardA().prepare("SELECT count(*) AS n FROM accountless_upload_owners").first("n"))
      .toBe(1);
    expect(await catalog().prepare("SELECT count(*) AS n FROM storage_participant_owner_locators").first("n"))
      .toBe(0);
    expect(await catalog().prepare("SELECT count(*) AS n FROM storage_participant_deletion_replay_locators").first("n"))
      .toBe(0);

    const skippedRetryUpload = await api("/api/v1/device/upload-authorizations", {
      method: "POST", headers: { authorization: authorization(deviceId, secret),
        "content-type": "application/json" }, body: JSON.stringify({
        envelopeDigest: "a".repeat(64), contentLengthBytes: 200,
        contentType: "application/json", telemetrySchemaVersion: "telemetry-contribution-v1.1",
      }),
    });
    expect(skippedRetryUpload.status).toBe(503);
    const skippedRetrySync = await api("/api/v1/device/telemetry/v1.1/day-manifests", {
      method: "POST", headers: { authorization: authorization(deviceId, secret),
        "content-type": "application/json" }, body: "{}",
    });
    expect(skippedRetrySync.status).toBe(503);
    expect(await shardA().prepare("SELECT count(*) AS n FROM device_upload_authorizations").first("n"))
      .toBe(0);

    const retry = await own(deviceId, secret);
    expect(retry.status, await retry.clone().text()).toBe(200);
    expect(await catalog().prepare("SELECT count(*) AS n FROM storage_participant_owner_locators").first("n"))
      .toBe(1);
    expect(await catalog().prepare("SELECT count(*) AS n FROM storage_participant_deletion_replay_locators").first("n"))
      .toBe(1);
    expect(await shardA().prepare("SELECT count(*) AS n FROM participants").first("n"))
      .toBe(1);
    expect(await catalog().prepare(`SELECT lifetime_reserved
      FROM storage_accountless_issuance_state WHERE singleton_id=1`)
      .first("lifetime_reserved")).toBe(1);
  });

  it("refuses real device credentials while an expired catalog replay marker is pending", async () => {
    const deviceId = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    expect((await enroll(deviceId, secret)).status).toBe(201);
    expect((await own(deviceId, secret)).status).toBe(201);
    const participantId = await shardA().prepare(`SELECT participant_id
      FROM accountless_upload_owners WHERE enrollment_device_id=?`)
      .bind(deviceId).first<string>("participant_id");
    expect(participantId).toBeTruthy();
    const marker=await recordCatalogDeletionReplayPending(bindings().DELETION_LEDGER,participantId!);
    await bindings().DELETION_LEDGER.prepare(`UPDATE deletion_tombstones
      SET deleted_at=?,retain_until=? WHERE participant_digest=?`)
      .bind(new Date(Date.now()-2).toISOString(),new Date(Date.now()-1).toISOString(),
        marker.participant_digest).run();
    const response=await api("/api/v1/device/upload-authorizations",{
      method:"POST",headers:{authorization:authorization(deviceId,secret),"content-type":"application/json"},
      body:JSON.stringify({envelopeDigest:"a".repeat(64),contentLengthBytes:200,
        contentType:"application/json",telemetrySchemaVersion:"telemetry-contribution-v1.1"}),
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({error:{code:"DEVICE_AUTH_INVALID"}});
    expect(await shardA().prepare("SELECT count(*) AS n FROM device_upload_authorizations").first("n"))
      .toBe(0);
  });

  it("routes upload registration and durable disconnect through the same owner shard", async () => {
    const deviceId = crypto.randomUUID();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    expect((await enroll(deviceId, secret)).status).toBe(201);
    expect((await own(deviceId, secret)).status).toBe(201);
    const deviceAuthorization = authorization(deviceId, secret);
    const created = await api("/api/v1/device/upload-authorizations", {
      method: "POST",
      headers: {
        authorization: deviceAuthorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        envelopeDigest: "e".repeat(64),
        contentLengthBytes: 256,
        contentType: "application/json",
        telemetrySchemaVersion: "telemetry-contribution-v1.1",
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const receipt = await created.json<{ uploadAuthorization: string }>();
    const uploadLocator = await uploadAuthorizationCapabilityHash(
      `Upload ${receipt.uploadAuthorization}`,
    );
    expect(await catalog().prepare(`SELECT state FROM storage_capability_locators
      WHERE capability_hash=?`).bind(uploadLocator).first("state")).toBe("active");
    expect(await shardA().prepare("SELECT count(*) AS n FROM device_upload_authorizations").first("n"))
      .toBe(1);

    const disconnected = await api("/api/v1/device/disconnect", {
      method: "POST",
      headers: { authorization: deviceAuthorization },
    });
    expect(disconnected.status, await disconnected.clone().text()).toBe(200);
    expect(await shardA().prepare(`SELECT state FROM accountless_enrollment_ledger
      WHERE device_id=?`).bind(deviceId).first("state")).toBe("revoked");
    expect(await catalog().prepare(`SELECT state FROM storage_capability_locators
      WHERE capability_hash=?`).bind(await deviceAuthorizationCapabilityHash(deviceAuthorization)).first("state"))
      .toBe("revoked");
  });

  it("routes encrypted typed admission and replay through the owner shard", async () => {
    const prepared = await preparedV11Owner();
    const accepted = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${prepared.upload}`,
        "content-type": "application/json",
      },
      body: prepared.raw,
    });
    expect(accepted.status, await accepted.clone().text()).toBe(202);
    const receipt = await accepted.json<{ contributionId: string; replayed: boolean }>();
    expect(receipt.replayed).toBe(false);
    expect(await shardA().prepare("SELECT count(*) AS n FROM typed_v11_record_admissions").first("n"))
      .toBe(1);
    expect(await bindings().USAGE_MONITOR_DB.prepare(
      "SELECT count(*) AS n FROM telemetry_v11_chunks").first("n")).toBe(0);

    const replayUpload = await registerUpload(
      prepared.deviceAuthorization, prepared.raw);
    const replay = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${replayUpload}`,
        "content-type": "application/json",
      },
      body: prepared.raw,
    });
    expect(replay.status, await replay.clone().text()).toBe(202);
    expect(await replay.json()).toMatchObject({
      contributionId: receipt.contributionId,
      replayed: true,
    });
    expect(await shardA().prepare("SELECT count(*) AS n FROM typed_v11_record_admissions").first("n"))
      .toBe(1);
  });

  it("keeps a healthy routed upload available when an unrelated shard is offline", async () => {
    const prepared = await preparedV11Owner();
    const unavailableB = new Proxy(shardB(), {
      get(target, key) {
        if (key === "prepare") return () => {
          throw new Error("synthetic unrelated shard unavailable");
        };
        const property = Reflect.get(target, key);
        return typeof property === "function" ? property.bind(target) : property;
      },
    });
    const isolatedRuntime = runtime({ STORAGE_INGESTION_B: unavailableB });
    const upload = await registerUpload(
      prepared.deviceAuthorization, prepared.raw, isolatedRuntime,
    );
    const accepted = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${upload}`,
        "content-type": "application/json",
      },
      body: prepared.raw,
    }, isolatedRuntime);
    expect(accepted.status, await accepted.clone().text()).toBe(202);
    expect(await shardA().prepare(
      "SELECT count(*) AS n FROM typed_v11_record_admissions",
    ).first("n")).toBe(1);
  });

  it("uses each routed shard's explicit immutable typed source namespace", async () => {
    const first = await preparedV11Owner({ sourceId: "synthetic-source-a" });
    const acceptedA = await api("/api/v1/contributions", {
      method: "POST", headers: { authorization: `Upload ${first.upload}`,
        "content-type": "application/json" }, body: first.raw,
    });
    expect(acceptedA.status, await acceptedA.clone().text()).toBe(202);

    await observe("a", STORAGE_NEW_OWNER_CUTOFF_BYTES);
    const second = await preparedV11Owner({ database: shardB(), namespace: NAMESPACE_B,
      sourceId: "synthetic-source-b" });
    const acceptedB = await api("/api/v1/contributions", {
      method: "POST", headers: { authorization: `Upload ${second.upload}`,
        "content-type": "application/json" }, body: second.raw,
    });
    expect(acceptedB.status, await acceptedB.clone().text()).toBe(202);
    expect(await shardA().prepare("SELECT source_namespace FROM typed_v11_admission_state WHERE id=1")
      .first("source_namespace")).toBe(NAMESPACE);
    expect(await shardB().prepare("SELECT source_namespace FROM typed_v11_admission_state WHERE id=1")
      .first("source_namespace")).toBe(NAMESPACE_B);
  });

  it("exports an authenticated participant from its exact routed shard without relabeling original provenance", async () => {
    const participantId = `participant:${crypto.randomUUID()}`;
    const route = await createCatalogStorageRouter({
      catalog: catalog(),
      bindings: {
        STORAGE_INGESTION_A: shardA(),
        STORAGE_INGESTION_B: shardB(),
        STORAGE_INGESTION_C: shardC(),
      },
      clock: Date.now,
    }).ensureOwner(`accountless:${crypto.randomUUID()}`, "b", 16_777_216);

    // The physical database is B while the immutable record provenance is
    // the original A namespace. Export must follow owner routing and let the
    // qualified typed reader resolve that original namespace.
    await prepareTyped(shardB(), NAMESPACE, "synthetic-retained-source-a-on-b");
    const fixture = await createV11DeviceFixture(shardB(), {
      participantId,
      grant: true,
    });
    await registerParticipantOwnerRoute(runtime(), participantId, route);
    const day = new Date().toISOString().slice(0, 10);
    const eventId = `event:v2:${"7".repeat(64)}`;
    const prepared = await makeV11Day(day, {
      usage: [v11UsageRecord(day, "7", { eventId })],
    });
    const manifest = await registerTelemetryV11DayManifest(
      shardB(), fixture, prepared.manifest,
    );
    const chunk = prepared.chunks[0]!;
    const envelopeDigest = await sha256Hex(`synthetic-export-${crypto.randomUUID()}`);
    const principal = await authenticateDevice(shardB(), fixture.authorization);
    const upload = await createDeviceUploadAuthorization(
      shardB(), principal, envelopeDigest, 200,
    );
    const claimed = await claimDeviceUploadAuthorization(
      shardB(), `Upload ${upload.uploadAuthorization}`,
      { envelopeDigest, bodyBytes: 200, contentType: "application/json" },
    );
    await persistTypedV11StagedChunk(shardB(), fixture, chunk, {
      sourceNamespace: NAMESPACE,
      chunkRowId: `chunk:${crypto.randomUUID()}`,
      r2Key: `synthetic/export-${crypto.randomUUID()}`,
      envelopeDigest,
      deviceUploadAuthorizationId: claimed.authorizationId,
    });
    expect(await shardB().prepare(`SELECT origin.source_namespace
      FROM typed_v11_record_proofs proof
      JOIN typed_telemetry_records record ON record.id=proof.typed_record_id
      JOIN typed_telemetry_origin_contracts origin ON origin.namespace_id=record.namespace_id
      JOIN typed_v11_owner_memberships owner
        ON owner.namespace_id=record.namespace_id AND owner.typed_owner_id=record.owner_id
      WHERE owner.participant_id=? LIMIT 1`)
      .bind(participantId).first("source_namespace")).toBe(NAMESPACE);

    // Browser authority remains global. Its participant identity selects the
    // immutable catalog locator only after the cookie has authenticated.
    const authority = await createV11DeviceFixture(
      bindings().USAGE_MONITOR_DB,
      { participantId },
    );
    const authorityOnly = new Proxy(bindings().USAGE_MONITOR_DB, {
      get(database, key) {
        if (key === "prepare") return (sql: string) => {
          if (/FROM (?:contributions|telemetry_contributions|telemetry_v11_)/u.test(sql)) {
            throw new Error("singleton export read attempted");
          }
          return database.prepare(sql);
        };
        const value = Reflect.get(database, key);
        return typeof value === "function" ? value.bind(database) : value;
      },
    });
    const response = await api("/api/v1/me/export", {
      method: "GET",
      headers: { cookie: authority.cookie },
    }, runtime({ USAGE_MONITOR_DB: authorityOnly }));
    expect(response.status, await response.clone().text()).toBe(200);
    const exported = await response.json<{
      participant: { participantId: string };
      attributionTransport: Array<{ kind: string; manifestId?: string; records?: unknown[] }>;
    }>();
    expect(exported.participant.participantId).toBe(participantId);
    expect(exported.attributionTransport).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "day_manifest", manifestId: manifest.manifestId }),
      expect.objectContaining({
        kind: "chunk",
        records: [expect.objectContaining({ eventId })],
      }),
    ]));
  });

  it("fails private export closed without a participant route and authenticates before catalog lookup", async () => {
    const authority = await createV11DeviceFixture(bindings().USAGE_MONITOR_DB);
    const missing = await api("/api/v1/me/export", {
      headers: { cookie: authority.cookie },
    });
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({
      error: { code: "BACKEND_STORAGE_UNAVAILABLE" },
    });

    const unavailableCatalog = new Proxy(catalog(), {
      get(database, key) {
        if (key === "prepare") return () => {
          throw new Error("catalog accessed before session authentication");
        };
        const value = Reflect.get(database, key);
        return typeof value === "function" ? value.bind(database) : value;
      },
    });
    const malformedCookie = authority.cookie
      .replace(/=.*/u, "=invalid");
    const unauthenticated = await api("/api/v1/me/export", {
      headers: { cookie: malformedCookie },
    }, runtime({ STORAGE_ROUTING_DB: unavailableCatalog }));
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({
      error: { code: "AUTH_INVALID" },
    });
  });

  it("rejects the complete typed batch when the route fences during preparation", async () => {
    const prepared = await preparedV11Owner();
    const ownerId = await catalog().prepare(
      "SELECT owner_id FROM storage_owner_routes LIMIT 1").first<string>("owner_id");
    expect(ownerId).toBeTruthy();
    const proxy = fenceDuringTypedAdmission(shardA(), async () => {
      await shardA().prepare(`UPDATE storage_owner_fences
        SET state='fenced', move_id='synthetic-mid-admission'
        WHERE owner_id=? AND state='active'`).bind(ownerId).run();
    });
    const response = await api("/api/v1/contributions", {
      method: "POST",
      headers: {
        authorization: `Upload ${prepared.upload}`,
        "content-type": "application/json",
      },
      body: prepared.raw,
    }, runtime({ STORAGE_INGESTION_A: proxy }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "BACKEND_STORAGE_UNAVAILABLE" },
    });
    expect(await shardA().prepare("SELECT count(*) AS n FROM telemetry_v11_chunks").first("n"))
      .toBe(0);
    expect(await shardA().prepare("SELECT count(*) AS n FROM typed_telemetry_records").first("n"))
      .toBe(0);
  });

  it("rejects a renewal when the shard-local route generation is fenced", async () => {
    const initial = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(initial);
    try {
      const deviceId = crypto.randomUUID();
      const secret = crypto.getRandomValues(new Uint8Array(32));
      expect((await enroll(deviceId, secret)).status).toBe(201);
      expect((await own(deviceId, secret)).status).toBe(201);
      const owner = await catalog().prepare("SELECT owner_id FROM storage_owner_routes").first<string>("owner_id");
      expect(owner).toBeTruthy();
      await shardA().prepare(`UPDATE storage_owner_fences SET state='fenced',move_id='synthetic-move'
        WHERE owner_id=? AND state='active'`).bind(owner).run();
      clock.mockReturnValue(initial + 29 * 24 * 60 * 60 * 1000);
      const renewed = await api("/api/v1/accountless/renewal", {
        method: "POST",
        headers: {
          authorization: authorization(deviceId, secret),
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...ownerBody(), schemaVersion: ACCOUNTLESS_RENEWAL_SCHEMA_VERSION }),
      });
      expect(renewed.status).toBe(503);
      const ledger = await shardA().prepare(`SELECT renewal_generation
        FROM accountless_enrollment_ledger WHERE device_id=?`).bind(deviceId).first<number>("renewal_generation");
      expect(ledger).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });
});
