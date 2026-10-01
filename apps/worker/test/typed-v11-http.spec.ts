import { env, applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalTelemetryV11Json, type TelemetryV11Envelope } from "@app-usagemonitor/telemetry-contract";
import { handleRequest } from "../src/index";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { initializeStorageSource } from "../src/analytics-delivery";
import { initializeTypedV11Admission } from "../src/typed-v11-admission";
import { parseTelemetryStorageMode } from "../src/telemetry-storage-mode";
import { createV11DeviceFixture, makeV11Day, v11UsageRecord } from "./helpers/telemetry-v11";
import { runTelemetryV11Sync } from "./helpers/contribution-v11-runner.js";
interface Bindings extends Env { TEST_MIGRATIONS: D1Migration[]; TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[]; TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[] }
const b = env as Bindings, db = () => b.USAGE_MONITOR_DB, namespace = "synthetic-http-original", origin = "https://example.test";
const day = () => new Date().toISOString().slice(0, 10), keyId = "key:synthetic-typed-http";
let publicJwk: JsonWebKey, publicText: string, privateText: string;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
  if (!("publicKey" in pair)) throw new Error("synthetic RSA pair required");
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (exported instanceof ArrayBuffer) throw new Error("synthetic JWK required");
  publicJwk = exported; publicText = JSON.stringify({ ...exported, kid: keyId });
  privateText = JSON.stringify({ ...await crypto.subtle.exportKey("jwk", pair.privateKey), kid: keyId });
});
beforeEach(async () => { await reset(); await applyD1Migrations(db(), b.TEST_MIGRATIONS); await applyD1Migrations(b.DELETION_LEDGER, b.TEST_DELETION_LEDGER_MIGRATIONS); });
function runtime(overrides: Partial<Env> = {}): Env {
  return { ...b, ENVIRONMENT: "synthetic-development", ACCOUNT_SCOPED_INGEST_MODE: "disabled", ACCOUNTLESS_ENROLLMENT_MODE: "enabled",
    ACCOUNTLESS_OWNERSHIP_MODE: "enabled", ENVELOPE_PUBLIC_JWK: publicText, ENVELOPE_PRIVATE_JWK: privateText, ...overrides };
}
function typed(overrides: Partial<Env> = {}): Env {
  const value = runtime(overrides);
  // Local --var overrides are validated by the real runtime parser. Generated
  // Env intentionally describes deployed JSON defaults, not this synthetic lane.
  Reflect.set(value, "TELEMETRY_STORAGE_MODE", "typed");
  Reflect.set(value, "TELEMETRY_STORAGE_NAMESPACE", namespace);
  return value;
}
function typedNamespace(value: string): Env {
  const target = typed(); Reflect.set(target, "TELEMETRY_STORAGE_NAMESPACE", value); return target;
}
function api(path: string, init: RequestInit, target = runtime()) {
  const headers = new Headers(init.headers); if (init.method === "POST") headers.set("origin", origin);
  return handleRequest(new Request(`${origin}${path}`, { ...init, headers }), target);
}
async function prepareTyped(options: { omitBridge?: boolean; omitClosure?: boolean; omitReader?: boolean; initialize?: boolean } = {}) {
  await applyD1Migrations(db(), b.TEST_TYPED_INGESTION_MIGRATIONS); await initializeStorageSource(db(), "synthetic-http-journal");
  if (!options.omitBridge) await applyD1Migrations(db(), b.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(db(), b.TEST_TYPED_V11_ADMISSION_MIGRATIONS.filter(m => (!options.omitClosure || !m.name.startsWith("0003")) && (!options.omitReader || !m.name.startsWith("0005"))));
  if (options.initialize !== false) await initializeTypedV11Admission(db(), namespace);
}
async function encrypted(value: unknown): Promise<TelemetryV11Envelope> {
  const rsa = await crypto.subtle.importKey("jwk", publicJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  if ("privateKey" in key) throw new Error("synthetic symmetric key required");
  const raw = await crypto.subtle.exportKey("raw", key); if (!(raw instanceof ArrayBuffer)) throw new Error("synthetic raw key required");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try { return { schemaVersion: "telemetry-envelope-v1.1", synthetic: false, keyId,
    wrappedKey: encodeBase64Url(new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, raw))), iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(canonicalTelemetryV11Json(value))))) };
  } finally { new Uint8Array(raw).fill(0); }
}
async function registerUpload(authorization: string, raw: string, target = runtime()) {
  const response = await api("/api/v1/device/upload-authorizations", { method: "POST", headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ envelopeDigest: await sha256Hex(raw), contentLengthBytes: new TextEncoder().encode(raw).length, contentType: "application/json", telemetrySchemaVersion: "telemetry-contribution-v1.1" }) }, target);
  expect(response.status).toBe(201); return (await response.json<{ uploadAuthorization: string }>()).uploadAuthorization;
}
const sendUpload = (upload: string, raw: string, target = runtime()) => api("/api/v1/contributions", { method: "POST",
  headers: { authorization: `Upload ${upload}`, "content-type": "application/json" }, body: raw }, target);
async function prepared(target = runtime()) {
  const fixture = await createV11DeviceFixture(db(), { grant: true }), value = await makeV11Day(day(), { usage: [v11UsageRecord(day())] });
  const response = await api("/api/v1/device/telemetry/v1.1/day-manifests", { method: "POST", headers: { authorization: fixture.authorization, "content-type": "application/json" }, body: JSON.stringify(value.manifest) }, target);
  expect(response.status).toBe(201); const raw = JSON.stringify(await encrypted(value.chunks[0]));
  return { fixture, value, raw, upload: await registerUpload(fixture.authorization, raw, target) };
}
function chunkBatchDatabase(action: (statements: D1PreparedStatement[]) => Promise<D1Result[]>) {
  const chunks = new WeakSet<object>();
  return new Proxy(db(), { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      const statement = target.prepare(sql); if (!/INSERT INTO telemetry_v11_chunks\s*\(/u.test(sql)) return statement;
      return new Proxy(statement, { get(value, member) {
        if (member === "bind") return (...values: Parameters<D1PreparedStatement["bind"]>) => { const bound = value.bind(...values); chunks.add(bound); return bound; };
        const property = Reflect.get(value, member); return typeof property === "function" ? property.bind(value) : property;
      } });
    };
    if (key === "batch") return (statements: D1PreparedStatement[]) => statements.some(s => chunks.has(s)) ? action(statements) : target.batch(statements);
    const property = Reflect.get(target, key); return typeof property === "function" ? property.bind(target) : property;
  } });
}
const count = (table: string) => db().prepare(`SELECT count(*) n FROM ${table}`).first<number>("n");
describe("explicit typed storage through encrypted v1.1 HTTP upload", () => {
  it("keeps the default JSON route working without optional typed tables", async () => {
    const value = await prepared(), response = await sendUpload(value.upload, value.raw);
    expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ status: "staged", replayed: false, recordCounts: { declared: 1, accepted: 1 } });
    expect(await count("telemetry_v11_records")).toBe(1); const object = (await b.QUARANTINE.list()).objects[0]!;
    expect(await (await b.QUARANTINE.get(object.key))!.text()).toBe(value.raw); expect(parseTelemetryStorageMode({})).toEqual({ kind: "json" });
  });
  it("runs the real accountless client through enrollment, encrypted upload and typed activation", async () => {
    await prepareTyped(); await db().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
    const deviceId = crypto.randomUUID(), secret = crypto.getRandomValues(new Uint8Array(32));
    const prefix = new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`), bytes = new Uint8Array(prefix.length + secret.length);
    bytes.set(prefix); bytes.set(secret, prefix.length);
    const authorization = `Device um_device_${deviceId}.${encodeBase64Url(secret)}`, deviceSecretHash = await sha256Hex(bytes); bytes.fill(0); secret.fill(0);
    expect((await api("/api/v1/accountless/enrollment", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: "accountless-enrollment-v0.1", deviceId, deviceSecretHash, policyVersion: "accountless-opt-out-v1", authorizationBasis: "accountless-policy-v1" }) }, typed())).status).toBe(201);
    expect((await api("/api/v1/accountless/ownership", { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: "accountless-upload-owner-v0.1", policyVersion: "accountless-opt-out-v1", authorizationBasis: "accountless-policy-v1", telemetrySchemaVersion: "telemetry-contribution-v1.1" }) }, typed())).status).toBe(201);
    const failures: { path: string; status: number; code: unknown }[] = [];
    const laboratoryOrigin = "http://127.0.0.1:9987";
    const options = { serverBaseUrl: laboratoryOrigin, deviceAuthorization: authorization, laboratory: true,
      authorization: { schemaVersion: "accountless-upload-owner-v0.1", policyVersion: "accountless-opt-out-v1",
        authorizationBasis: "accountless-policy-v1", telemetrySchemaVersion: "telemetry-contribution-v1.1" } as const, days: [day()],
      readDay: async (selected: string) => makeV11Day(selected, { usage: Array.from({ length: 203 }, (_, n) => v11UsageRecord(selected, "a", { eventId: `event:v2:${n.toString(16).padStart(64, "0")}` })) }), createEnvelope: encrypted,
      fetchImpl: async (url: URL, request: RequestInit) => {
        expect(request.redirect).toBe("error"); const target = typed(); Reflect.set(target, "PUBLIC_ORIGIN", laboratoryOrigin);
        const response = await handleRequest(new Request(url, { ...request, redirect: "manual" }), target);
        if (response.status >= 400) failures.push({ path: new URL(url).pathname, status: response.status,
          code: (await response.clone().json<{error?: {code?: string}} >()).error?.code });
        return response;
      } };
    const result = await runTelemetryV11Sync(options);
    expect({ result, failures }).toMatchObject({ result: { status: "complete", chunksUploaded: 2, recordsUploaded: 203 }, failures: [] });
    expect(await count("telemetry_v11_records")).toBe(0); expect(await count("typed_v11_record_admissions")).toBe(203);
    expect(await count("telemetry_v11_domain_heads")).toBe(1); expect(await count("storage_ingestion_changes")).toBe(1); expect((await b.QUARANTINE.list()).objects).toHaveLength(2);
    expect(await runTelemetryV11Sync(options)).toMatchObject({ status: "complete", chunksUploaded: 0 });
    expect(await count("typed_v11_record_admissions")).toBe(203); expect((await b.QUARANTINE.list()).objects).toHaveLength(2);
  });
  it.each(["json", "typed"] as const)("preserves retained ciphertext after a lost %s transaction response", async mode => {
    if (mode === "typed") await prepareTyped(); const target = mode === "typed" ? typed() : runtime(), value = await prepared(target); let lost = false;
    const database = chunkBatchDatabase(async statements => { await db().batch(statements); lost = true; throw new Error("synthetic lost committed response"); });
    const response = await sendUpload(value.upload, value.raw, { ...target, USAGE_MONITOR_DB: database });
    expect(lost).toBe(true); expect(response.status).toBe(202); const receipt = await response.json<{ contributionId: string; replayed: boolean }>(); expect(receipt.replayed).toBe(true);
    const row = await db().prepare("SELECT r2_key FROM telemetry_v11_chunks WHERE id=?").bind(receipt.contributionId).first<{ r2_key: string }>();
    expect(await (await b.QUARANTINE.get(row!.r2_key))!.text()).toBe(value.raw); expect((await b.QUARANTINE.list()).objects).toHaveLength(1);
    expect(await db().prepare("SELECT state,consumed_contribution_id FROM device_upload_authorizations").first()).toEqual({ state: "consumed", consumed_contribution_id: receipt.contributionId });
    const replay = await sendUpload(await registerUpload(value.fixture.authorization, value.raw, target), value.raw, target);
    expect(replay.status).toBe(202); expect(await replay.json()).toMatchObject({ contributionId: receipt.contributionId, replayed: true }); expect((await b.QUARANTINE.list()).objects).toHaveLength(1);
  });
  it("removes only its losing object when a concurrent typed request commits first", async () => {
    await prepareTyped(); const value = await prepared(typed());
    const winnerAuthorization = await registerUpload(value.fixture.authorization, value.raw, typed());
    let winnerId: string | undefined;
    const database = chunkBatchDatabase(async () => {
      const winner = await sendUpload(winnerAuthorization, value.raw, typed()); expect(winner.status).toBe(202);
      winnerId = (await winner.json<{ contributionId: string }>()).contributionId;
      throw new Error("synthetic losing transaction after another request committed");
    });
    const response = await sendUpload(value.upload, value.raw, typed({ USAGE_MONITOR_DB: database }));
    expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ contributionId: winnerId, replayed: true });
    const retained = await db().prepare("SELECT r2_key FROM telemetry_v11_chunks WHERE id=?").bind(winnerId!).first<{r2_key: string}>();
    expect((await b.QUARANTINE.list()).objects.map(row => row.key)).toEqual([retained!.r2_key]);
    expect(await (await b.QUARANTINE.get(retained!.r2_key))!.text()).toBe(value.raw);
    expect(await db().prepare("SELECT count(*) n FROM pending_quarantine_objects WHERE contribution_id!=?").bind(winnerId!).first("n")).toBe(0); expect(await count("typed_v11_record_admissions")).toBe(1);
    expect(await db().prepare("SELECT count(*) n FROM device_upload_authorizations WHERE state='consumed' AND consumed_contribution_id=?").bind(winnerId!).first("n")).toBe(2);
  });
  it("cleans only its uncommitted object when the typed transaction refuses", async () => {
    await prepareTyped(); const value = await prepared(typed()), database = chunkBatchDatabase(async () => { throw new Error("synthetic precommit database refusal"); });
    const response = await sendUpload(value.upload, value.raw, typed({ USAGE_MONITOR_DB: database }));
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: { code: "BACKEND_STORAGE_UNAVAILABLE" } });
    expect(await count("telemetry_v11_chunks")).toBe(0); expect(await count("typed_telemetry_records")).toBe(0); expect((await b.QUARANTINE.list()).objects).toEqual([]);
    expect(await count("pending_quarantine_objects")).toBe(0); expect(await db().prepare("SELECT state FROM device_upload_authorizations").first("state")).toBe("revoked");
  });
  it.each(["missing bridge", "missing closure", "missing typed reader"] as const)("refuses initialization and HTTP admission with %s", async missing => {
    await prepareTyped({ omitBridge: missing === "missing bridge", omitClosure: missing === "missing closure", omitReader: missing === "missing typed reader", initialize: false });
    await expect(initializeTypedV11Admission(db(), namespace)).rejects.toMatchObject({ code: "TYPED_TELEMETRY_CONFLICT" }); expect(await count("typed_v11_admission_state")).toBe(0);
    const value = await prepared(typed()); expect((await sendUpload(value.upload, value.raw, typed())).status).toBe(503);
    expect(await count("telemetry_v11_chunks")).toBe(0); expect((await b.QUARANTINE.list()).objects).toEqual([]);
  });
  it("refuses missing initialization, wrong namespaces and unknown modes without JSON fallback", async () => {
    await prepareTyped({ initialize: false }); const value = await prepared(typed()); expect((await sendUpload(value.upload, value.raw, typed())).status).toBe(503);
    await initializeTypedV11Admission(db(), namespace);
    for (const target of [typedNamespace("synthetic-other"), typedNamespace("")])
      expect((await sendUpload(await registerUpload(value.fixture.authorization, value.raw, target), value.raw, target)).status).toBe(503);
    expect(() => parseTelemetryStorageMode({ TELEMETRY_STORAGE_MODE: "typo" })).toThrow("BACKEND_STORAGE_UNAVAILABLE");
    expect(await count("telemetry_v11_records")).toBe(0); expect(await count("typed_telemetry_records")).toBe(0); expect((await b.QUARANTINE.list()).objects).toEqual([]);
    await expect(db().prepare("UPDATE typed_v11_admission_state SET runtime_contract_version=0").run()).rejects.toThrow("typed_v11_runtime_contract_unqualified");
  });
  it("never returns a successful replay for incomplete typed membership", async () => {
    await prepareTyped(); const value = await prepared(typed()); expect((await sendUpload(value.upload, value.raw, typed())).status).toBe(202);
    await db().prepare("DELETE FROM typed_v11_record_admissions").run();
    const response = await sendUpload(await registerUpload(value.fixture.authorization, value.raw, typed()), value.raw, typed());
    expect(response.status).toBe(503); expect((await b.QUARANTINE.list()).objects).toHaveLength(1); expect(await count("telemetry_v11_chunks")).toBe(1); expect(await count("telemetry_v11_records")).toBe(0);
  });
});
