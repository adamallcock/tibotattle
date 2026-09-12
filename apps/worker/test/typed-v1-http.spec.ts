import { env, applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalTelemetryV11Json } from "@app-usagemonitor/telemetry-contract";
import { telemetryEnvelopeDigest } from "../src/telemetry-repository";
import { handleRequest } from "../src/index";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { initializeStorageSource } from "../src/analytics-delivery";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";
import { readTypedTelemetryRowsByStorageIds } from "../src/typed-telemetry-compatibility";
import { telemetryV11LegacyProjection } from "../src/telemetry-v11-compatibility";
import { initializeTypedV11Admission } from "../src/typed-v11-admission";
import { createV11DeviceFixture, v11UsageRecord } from "./helpers/telemetry-v11";
interface Bindings extends Env { TEST_MIGRATIONS: D1Migration[]; TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[]; TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[]; TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[] }
const b = env as Bindings, db = () => b.USAGE_MONITOR_DB, namespace = "synthetic-v1-http-original", origin = "https://example.test";
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
async function prepareTyped(initialize = true) {
  await applyD1Migrations(db(), b.TEST_TYPED_INGESTION_MIGRATIONS);
  await initializeStorageSource(db(), "synthetic-v1-http-journal");
  await applyD1Migrations(db(), b.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(db(), b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  if (initialize) await initializeTypedV1Admission(db(), namespace);
}
async function encrypted(value: unknown): Promise<object> {
  const rsa = await crypto.subtle.importKey("jwk", publicJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  if ("privateKey" in key) throw new Error("synthetic symmetric key required");
  const raw = await crypto.subtle.exportKey("raw", key); if (!(raw instanceof ArrayBuffer)) throw new Error("synthetic raw key required");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try { return { schemaVersion: "telemetry-envelope-v1.0", synthetic: false, keyId,
    wrappedKey: encodeBase64Url(new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, raw))), iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(canonicalTelemetryV11Json(value))))) };
  } finally { new Uint8Array(raw).fill(0); }
}
async function registerUpload(authorization: string, raw: string, target = runtime()) {
  const response = await api("/api/v1/device/upload-authorizations", { method: "POST", headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ envelopeDigest: await sha256Hex(raw), contentLengthBytes: new TextEncoder().encode(raw).length, contentType: "application/json", telemetrySchemaVersion: "telemetry-contribution-v1.0" }) }, target);
  expect(response.status).toBe(201); return (await response.json<{ uploadAuthorization: string }>()).uploadAuthorization;
}
const sendUpload = (upload: string, raw: string, target = runtime()) => api("/api/v1/contributions", { method: "POST",
  headers: { authorization: `Upload ${upload}`, "content-type": "application/json" }, body: raw }, target);
function records(stream: "usage" | "quota" | "session", count = 1) {
  return Array.from({ length: count }, (_, i) => stream === "usage"
    ? JSON.parse(telemetryV11LegacyProjection("usage", v11UsageRecord(day(), "a", { eventId: `event:v2:${i.toString(16).padStart(64, "0")}` }))!.canonicalRecord)
    : stream === "quota" ? { schemaVersion: "quota-observation-v1.0", observationId: `quota-occurrence:v1:${i.toString(16).padStart(64, "0")}`,
      observedTime: `${day()}T12:00:00.000Z`, provider: "openai_codex", planType: "pro", planVariant: "unknown",
      limitId: "codex", slot: "secondary", usedPercent: 0.30000000000000004, windowDurationMinutes: 10080, resetsAt: `${day()}T13:00:00.000Z` }
    : { schemaVersion: "session-dimension-v1.0", sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b", firstEventTime: `${day()}T12:00:00.000Z`,
      provider: "openai_codex", toolClassCounts: { shell: 0, other: 3 } });
}
async function prepared(target = runtime(), stream: "usage" | "quota" | "session" = "usage", revision = 1, count = 1,
  fixture?: Awaited<ReturnType<typeof createV11DeviceFixture>>) {
  fixture ??= await createV11DeviceFixture(db());
  const rowValues = records(stream, count), chunk = { schemaVersion: "telemetry-contribution-v1.0", chunkId: `${stream}:${day()}:0`,
    chunkRevision: revision, chunkDigest: await sha256Hex(canonicalTelemetryV11Json(rowValues)), parserVersion: "synthetic-http-v1",
    consent: { telemetrySchemaVersion: "telemetry-contribution-v1.0", fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1", privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0" }, records: rowValues };
  const raw = JSON.stringify(await encrypted(chunk));
  return { fixture, chunk, raw, upload: await registerUpload(fixture.authorization, raw, target) };
}
function chunkBatchDatabase(action: (statements: D1PreparedStatement[]) => Promise<D1Result[]>) {
  const chunks = new WeakSet<object>();
  return new Proxy(db(), { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      const statement = target.prepare(sql); if (!/INSERT INTO telemetry_v1_chunks\s*\(/u.test(sql)) return statement;
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
describe("explicit typed storage through encrypted v1 HTTP upload", () => {
  it("keeps JSON as the default without optional typed tables", async () => {
    const value = await prepared(), response = await sendUpload(value.upload, value.raw);
    expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ status: "accepted", recordCounts: { declared: 1, accepted: 1 } });
    expect(await count("telemetry_v1_records")).toBe(1); expect((await b.QUARANTINE.list()).objects).toHaveLength(1);
  });
  it("admits all three streams through actual encrypted HTTP with exact typed records and authority", async () => {
    await prepareTyped(); const fixture = await createV11DeviceFixture(db());
    for (const stream of ["usage", "quota", "session"] as const) {
      const value = await prepared(typed(), stream, 1, stream === "usage" ? 200 : 1, fixture), response = await sendUpload(value.upload, value.raw, typed());
      expect(response.status).toBe(202); const receipt = await response.json<{ contributionId: string }>();
      const ids = (await db().prepare("SELECT typed_record_id FROM typed_v1_record_admissions WHERE chunk_id=? ORDER BY typed_record_id").bind(receipt.contributionId).all<{typed_record_id: number}>()).results.map(r => r.typed_record_id);
      const found = await readTypedTelemetryRowsByStorageIds(db(), { sourceNamespace: namespace, participantId: fixture.participantId, storageRowIds: ids });
      expect(found.map(r => r.record_json)).toEqual(value.chunk.records.map(r => canonicalTelemetryV11Json(r)));
      expect(found.every(r => r.device_id === fixture.deviceId && r.chunk_row_id === receipt.contributionId && r.format === "v1")).toBe(true);
      expect(await db().prepare("SELECT state FROM device_upload_authorizations WHERE consumed_contribution_id=?").bind(receipt.contributionId).first("state")).toBe("consumed");
    }
    expect(await count("telemetry_v1_records")).toBe(0); expect(await count("typed_telemetry_records")).toBe(202);
    expect(await count("storage_ingestion_changes")).toBe(3); expect((await b.QUARANTINE.list()).objects).toHaveLength(3);
  });
  it("keeps legacy envelope identity separate from exact-body authorization including whitespace", async () => {
    await prepareTyped(); const value = await prepared(typed()), raw = JSON.stringify(JSON.parse(value.raw), null, 2);
    const authorization = await registerUpload(value.fixture.authorization, raw, typed());
    const response = await sendUpload(authorization, raw, typed()); expect(response.status).toBe(202);
    const { contributionId } = await response.json<{ contributionId: string }>();
    const legacyDigest = await telemetryEnvelopeDigest(JSON.parse(raw)), rawDigest = await sha256Hex(raw);
    expect(legacyDigest).not.toBe(rawDigest);
    expect(await db().prepare("SELECT envelope_digest FROM telemetry_v1_chunks WHERE id=?").bind(contributionId).first("envelope_digest")).toBe(legacyDigest);
    expect(await db().prepare("SELECT envelope_digest FROM device_upload_authorizations WHERE consumed_contribution_id=?").bind(contributionId).first("envelope_digest")).toBe(rawDigest);
    expect(await count("typed_v1_authority_requests")).toBe(0); expect(await count("community_graph_update_scope")).toBe(0);
    const replay = await sendUpload(value.upload, value.raw, typed());
    expect(replay.status).toBe(202); expect(await replay.json()).toMatchObject({ contributionId, replayed: true });
    expect((await b.QUARANTINE.list()).objects).toHaveLength(1);
  });
  it("corrects a current chunk and returns exact superseded-envelope and current-content receipts", async () => {
    await prepareTyped(); const first = await prepared(typed()), initial = await sendUpload(first.upload, first.raw, typed());
    expect(initial.status).toBe(202); const initialReceipt = await initial.json<{ contributionId: string }>();
    const second = await prepared(typed(), "usage", 2, 2, first.fixture), correction = await sendUpload(second.upload, second.raw, typed());
    expect(correction.status).toBe(202); const corrected = await correction.json<{ contributionId: string; supersededRevision: number }>(); expect(corrected.supersededRevision).toBe(1);
    expect(await count("typed_telemetry_records")).toBe(2); expect(await count("telemetry_v1_chunks")).toBe(2);
    expect(await db().prepare("SELECT count(*) n FROM typed_v1_record_admissions WHERE chunk_id=?").bind(initialReceipt.contributionId).first("n")).toBe(0);
    const oldReplay = await sendUpload(await registerUpload(first.fixture.authorization, first.raw, typed()), first.raw, typed());
    expect(oldReplay.status).toBe(202); expect(await oldReplay.json()).toMatchObject({ contributionId: initialReceipt.contributionId, status: "superseded", replayed: true, chunkRevision: 1 });
    const sameCurrent = await prepared(typed(), "usage", 2, 2, first.fixture), currentReplay = await sendUpload(sameCurrent.upload, sameCurrent.raw, typed());
    expect(currentReplay.status).toBe(202); expect(await currentReplay.json()).toMatchObject({ contributionId: corrected.contributionId, status: "accepted", replayed: true });
    expect(await count("storage_ingestion_changes")).toBe(2); expect((await b.QUARANTINE.list()).objects).toHaveLength(2);
  });
  it.each(["json", "typed"] as const)("preserves the actual retained ID and ciphertext after a lost %s transaction response", async mode => {
    if (mode === "typed") await prepareTyped(); const target = mode === "typed" ? typed() : runtime(), value = await prepared(target); let lost = false;
    const database = chunkBatchDatabase(async statements => { await db().batch(statements); lost = true; throw new Error("synthetic lost committed response"); });
    const response = await sendUpload(value.upload, value.raw, { ...target, USAGE_MONITOR_DB: database });
    expect(lost).toBe(true); expect(response.status).toBe(202); const receipt = await response.json<{ contributionId: string; replayed: boolean }>(); expect(receipt.replayed).toBe(true);
    const row = await db().prepare("SELECT r2_key FROM telemetry_v1_chunks WHERE id=?").bind(receipt.contributionId).first<{r2_key: string}>();
    expect(await (await b.QUARANTINE.get(row!.r2_key))!.text()).toBe(value.raw); expect((await b.QUARANTINE.list()).objects).toHaveLength(1);
    expect(await db().prepare("SELECT state,consumed_contribution_id FROM device_upload_authorizations").first()).toEqual({state: "consumed", consumed_contribution_id: receipt.contributionId});
  });
  it("cleans its losing object after another actual typed request commits the same content", async () => {
    await prepareTyped(); const value = await prepared(typed());
    const winnerAuthorization = await registerUpload(value.fixture.authorization, value.raw, typed());
    let winnerId: string | undefined;
    const database = chunkBatchDatabase(async () => {
      const winner = await sendUpload(winnerAuthorization, value.raw, typed()); expect(winner.status).toBe(202);
      winnerId = (await winner.json<{contributionId: string}>()).contributionId;
      throw new Error("synthetic losing transaction after another request committed");
    });
    const response = await sendUpload(value.upload, value.raw, typed({ USAGE_MONITOR_DB: database }));
    expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ contributionId: winnerId, replayed: true });
    const row = await db().prepare("SELECT r2_key FROM telemetry_v1_chunks WHERE id=?").bind(winnerId!).first<{r2_key: string}>();
    expect((await b.QUARANTINE.list()).objects.map(o => o.key)).toEqual([row!.r2_key]);
    expect(await db().prepare("SELECT count(*) n FROM pending_quarantine_objects WHERE contribution_id!=?").bind(winnerId!).first("n")).toBe(0);
    expect(await count("typed_telemetry_records")).toBe(1); expect(await count("storage_ingestion_changes")).toBe(1);
    expect(await db().prepare("SELECT count(*) n FROM device_upload_authorizations WHERE state='consumed' AND consumed_contribution_id=?").bind(winnerId!).first("n")).toBe(2);
  });
  it("rolls back a failed correction, keeping the original object and cleaning only its new orphan", async () => {
    await prepareTyped(); const first = await prepared(typed()); expect((await sendUpload(first.upload, first.raw, typed())).status).toBe(202);
    const before = (await b.QUARANTINE.list()).objects.map(r => r.key), next = await prepared(typed(), "usage", 2, 2, first.fixture);
    await db().prepare("CREATE TRIGGER synthetic_v1_http_journal_failure BEFORE INSERT ON typed_v1_event_sources BEGIN SELECT RAISE(ABORT,'synthetic database refusal'); END").run();
    const response = await sendUpload(next.upload, next.raw, typed()); expect(response.status).toBe(503);
    expect(await count("telemetry_v1_chunks")).toBe(1); expect(await count("typed_telemetry_records")).toBe(1); expect(await count("storage_ingestion_changes")).toBe(1);
    expect((await b.QUARANTINE.list()).objects.map(r => r.key)).toEqual(before);
    expect(await db().prepare("SELECT count(*) n FROM pending_quarantine_objects p WHERE NOT EXISTS(SELECT 1 FROM telemetry_v1_chunks c WHERE c.id=p.contribution_id AND c.r2_key=p.r2_key)").first("n")).toBe(0);
    expect(await db().prepare("SELECT count(*) n FROM device_upload_authorizations WHERE state='revoked'").first("n")).toBe(1);
  });
  it("refuses absent initialization or a different namespace without storing JSON", async () => {
    await prepareTyped(false); const first = await prepared(typed()); expect((await sendUpload(first.upload, first.raw, typed())).status).toBe(503);
    await initializeTypedV1Admission(db(), namespace);
    for (const target of [typedNamespace("synthetic-other"), typedNamespace("")]) {
      const value = await prepared(target); expect((await sendUpload(value.upload, value.raw, target)).status).toBe(503);
    }
    expect(await count("telemetry_v1_records")).toBe(0); expect(await count("typed_telemetry_records")).toBe(0); expect((await b.QUARANTINE.list()).objects).toHaveLength(0);
  });
  it("never acknowledges a same-owner envelope on another device", async () => {
    await prepareTyped(); const first = await prepared(typed()); expect((await sendUpload(first.upload, first.raw, typed())).status).toBe(202);
    const otherDevice = await createV11DeviceFixture(db(), { participantId: first.fixture.participantId });
    const response = await sendUpload(await registerUpload(otherDevice.authorization, first.raw, typed()), first.raw, typed());
    expect(response.status).toBe(503); expect(await count("telemetry_v1_chunks")).toBe(1); expect((await b.QUARANTINE.list()).objects).toHaveLength(1);
  });
  it("refuses a v11 namespace that differs from the initialized v1 source", async () => {
    await prepareTyped(); await applyD1Migrations(db(), b.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
    await expect(initializeTypedV11Admission(db(), "synthetic-other")).rejects.toMatchObject({ code: "TYPED_TELEMETRY_CONFLICT" });
    expect(await count("typed_v11_admission_state")).toBe(0);
    await initializeTypedV11Admission(db(), namespace); expect(await count("typed_v11_admission_state")).toBe(1);
  });
});
