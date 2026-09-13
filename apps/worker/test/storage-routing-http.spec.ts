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
import { STORAGE_NEW_OWNER_CUTOFF_BYTES } from "../src/storage-routing";
import { initializeStorageSource } from "../src/analytics-delivery";
import { initializeTypedV11Admission } from "../src/typed-v11-admission";
import { makeV11Day, v11UsageRecord } from "./helpers/telemetry-v11";
import {
  participantStorageLocatorDigest,
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
        if (!/INSERT INTO storage_participant_owner_locators/u.test(sql)) {
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
      const property = Reflect.get(target, key);
      return typeof property === "function" ? property.bind(target) : property;
    },
  });
}

async function observe(shardId: string, observedBytes: number,
  allocationTier: "active" | "spare" = "active"): Promise<void> {
  await recordStorageCapacityObservation(catalog(), {
    shardId, observedBytes, observedAt: Date.now() - 1000,
    validUntil: Date.now() + 60_000, pressureState: "normal",
  });
  await configureStorageShardAllocation(catalog(), {
    shardId, allocationTier, allocationEnabled: true, updatedAt: Date.now() - 1000,
  });
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(bindings().USAGE_MONITOR_DB, bindings().TEST_MIGRATIONS);
  await applyD1Migrations(bindings().DELETION_LEDGER,
    bindings().TEST_DELETION_LEDGER_MIGRATIONS);
  await applyD1Migrations(catalog(), bindings().TEST_ROUTING_MIGRATIONS);
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
    expect((await storageForParticipantOwner(runtime(), participantId!)).route)
      .toMatchObject({ ownerId: expect.stringMatching(/^accountless:/u), shardId: "a" });
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
    expect(await shardA().prepare("SELECT count(*) AS n FROM participants").first("n"))
      .toBe(1);
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
