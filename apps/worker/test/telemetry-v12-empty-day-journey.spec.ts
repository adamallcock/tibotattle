import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  canonicalTelemetryV12Json,
  telemetryV12DayManifestDigestInput,
  telemetryV12RequiredConsent,
  type TelemetryV12Chunk,
  type TelemetryV12DayManifest,
  type TelemetryV12Envelope,
  type TelemetryV12UsageEvent,
} from "@app-usagemonitor/telemetry-contract";
import { initializeStorageSource } from "../src/analytics-delivery";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { handleRequest } from "../src/index";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";
import { initializeTypedV11Admission } from "../src/typed-v11-admission";
import { runTelemetryV12Sync, type TelemetryV12SyncOptions } from "./helpers/contribution-v12-runner.js";

// The shipped desktop client registers a manifest for every day of its
// contiguous planned range, idle days included (`chunks: []`). This drives
// that client over the real Worker HTTP routes for a v1.2-only accountless
// install whose range contains an idle day, with every ingestion-isolation
// migration applied: 0012 (empty-day manifest rebuild), 0013 (quarantine
// admission fence) and 0014 (retained-history transfer source).

interface Bindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
}

const b = env as Bindings;
const db = () => b.USAGE_MONITOR_DB;
const namespace = "synthetic-v12-empty-day-journey";
// The accountless client accepts a laboratory destination only on loopback.
const origin = "http://127.0.0.1:9988";
const keyId = "key:synthetic-v12-empty-day-journey";
const parserVersion = "synthetic-v12-empty-day-journey";
const DAY_MS = 24 * 60 * 60 * 1000;
const EMPTY_DAY_MIGRATION = "0012_v12_empty_day_manifests.sql";
const V12_AUTHORIZATION = Object.freeze({
  schemaVersion: "accountless-upload-owner-v1.2",
  policyVersion: "accountless-telemetry-v1.2-policy-v1",
  authorizationBasis: "accountless-policy-v1.2",
  telemetrySchemaVersion: "telemetry-contribution-v1.2",
} as const);
const dayOf = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);

let publicJwk: JsonWebKey;
let publicText: string;
let privateText: string;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({
    name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
  }, true, ["encrypt", "decrypt"]);
  if (!("publicKey" in pair)) throw new Error("synthetic RSA pair required");
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (exported instanceof ArrayBuffer) throw new Error("synthetic JWK required");
  publicJwk = exported;
  publicText = JSON.stringify({ ...exported, kid: keyId });
  privateText = JSON.stringify({ ...await crypto.subtle.exportKey("jwk", pair.privateKey), kid: keyId });
});

async function prepare(options: { withoutEmptyDayMigration?: boolean } = {}): Promise<void> {
  await reset();
  await applyD1Migrations(db(), b.TEST_MIGRATIONS);
  await applyD1Migrations(db(), b.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(db(), b.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(db(), b.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(b.DELETION_LEDGER, b.TEST_DELETION_LEDGER_MIGRATIONS);
  await initializeStorageSource(db(), "synthetic-v12-empty-day-journal");
  await applyD1Migrations(db(), b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await initializeTypedV11Admission(db(), namespace);
  await initializeTypedV1Admission(db(), namespace);
  const isolation = b.TEST_INGESTION_ISOLATION_MIGRATIONS;
  for (const name of [EMPTY_DAY_MIGRATION, "0013_v12_quarantine_admission.sql", "0014_accountless_history_transfer_v12.sql"]) {
    if (!isolation.some((migration) => migration.name === name)) throw new Error(`missing isolation migration ${name}`);
  }
  await applyD1Migrations(db(), isolation.filter((migration) =>
    !options.withoutEmptyDayMigration || migration.name !== EMPTY_DAY_MIGRATION));
  await db().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
  await db().prepare("UPDATE telemetry_v12_runtime SET state='active', changed_at=? WHERE id=1")
    .bind(new Date(Date.now() - 30 * DAY_MS).toISOString()).run();
}

afterEach(() => { vi.restoreAllMocks(); });

function typed(): Env {
  const value = {
    ...b, ENVIRONMENT: "synthetic-development", ACCOUNT_SCOPED_INGEST_MODE: "disabled",
    ACCOUNTLESS_ENROLLMENT_MODE: "enabled", ACCOUNTLESS_OWNERSHIP_MODE: "enabled",
    ENVELOPE_PUBLIC_JWK: publicText, ENVELOPE_PRIVATE_JWK: privateText,
  } as Env;
  // Local overrides are validated by the real runtime parser; the generated
  // Env describes deployed defaults, not this synthetic typed lane.
  Reflect.set(value, "TELEMETRY_STORAGE_MODE", "typed");
  Reflect.set(value, "TELEMETRY_STORAGE_NAMESPACE", namespace);
  Reflect.set(value, "PUBLIC_ORIGIN", origin);
  return value;
}

function post(path: string, body: unknown, authorization?: string): Promise<Response> {
  return handleRequest(new Request(`${origin}${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...(authorization ? { authorization } : {}) },
    body: JSON.stringify(body),
  }), typed());
}

async function encrypted(value: TelemetryV12Chunk): Promise<TelemetryV12Envelope> {
  const rsa = await crypto.subtle.importKey("jwk", publicJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  if ("privateKey" in key) throw new Error("synthetic symmetric key required");
  const raw = await crypto.subtle.exportKey("raw", key);
  if (!(raw instanceof ArrayBuffer)) throw new Error("synthetic raw key required");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    return {
      schemaVersion: "telemetry-envelope-v1.2", synthetic: false, keyId,
      wrappedKey: encodeBase64Url(new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, raw))),
      iv: encodeBase64Url(iv),
      ciphertext: encodeBase64Url(new Uint8Array(await crypto.subtle.encrypt(
        { name: "AES-GCM", iv }, key, new TextEncoder().encode(canonicalTelemetryV12Json(value)),
      ))),
    };
  } finally { new Uint8Array(raw).fill(0); }
}

function usageRecord(day: string, sequence: number): TelemetryV12UsageEvent {
  return {
    schemaVersion: "usage-event-v1.2",
    eventId: `event:v2:${day.replaceAll("-", "")}${sequence.toString(16).padStart(56, "0")}`,
    eventTime: `${day}T00:05:${String(sequence % 60).padStart(2, "0")}.000Z`,
    sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
    provider: "openai_codex", modelId: "gpt-5.6-sol", speedMode: "standard", apiServiceTier: "default",
    surface: "local_interactive_unclassified", billingSurface: "chatgpt_subscription", reasoningEffort: "high",
    agentScope: "root", outcome: "completed", totalInputContextTokens: 1000,
    components: { inputUncachedTokens: 100, inputCacheReadTokens: 900, inputCacheWriteTokens: 0,
      outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: null },
    accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null,
      planBasis: "same_source_occurrence", planType: "pro", planEraId: null },
    boundaryFlags: null, tieOrder: null, cacheWriteTtl: null,
  };
}

/** The desktop's day preparation: an idle day is a manifest with no chunk. */
async function localDay(day: string, records: number): Promise<{ manifest: TelemetryV12DayManifest; chunks: TelemetryV12Chunk[] }> {
  const consent = telemetryV12RequiredConsent();
  const usage = Array.from({ length: records }, (_, index) => usageRecord(day, index + 1));
  const chunks: TelemetryV12Chunk[] = usage.length ? [{
    schemaVersion: "telemetry-contribution-v1.2", manifestDigest: "0".repeat(64),
    chunkId: `usage:${day}:0`, chunkRevision: 1, parserVersion, consent, records: usage,
    chunkDigest: await sha256Hex(canonicalTelemetryV12Json(usage)),
  }] : [];
  const manifest: TelemetryV12DayManifest = {
    schemaVersion: "telemetry-day-manifest-v1.2", day, parserVersion, consent,
    chunks: chunks.map((chunk) => ({ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: chunk.records.length })),
    excluded: { quota: 0, session: 0, usage: 0 }, manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = await sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  for (const chunk of chunks) chunk.manifestDigest = manifest.manifestDigest;
  return { manifest, chunks };
}

async function deviceSecretHash(deviceId: string, secret: Uint8Array): Promise<string> {
  const prefix = new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`);
  const input = new Uint8Array(prefix.length + secret.length);
  input.set(prefix);
  input.set(secret, prefix.length);
  try { return await sha256Hex(input); } finally { input.fill(0); }
}

/** Enroll, take ownership and request the v1.2 grant over HTTP. */
async function enrollV12OnlyInstall(): Promise<{ deviceId: string; authorization: string; participantId: string }> {
  const deviceId = crypto.randomUUID();
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const authorization = `Device um_device_${deviceId}.${encodeBase64Url(secret)}`;
  const hash = await deviceSecretHash(deviceId, secret);
  secret.fill(0);
  const enrollment = await post("/api/v1/accountless/enrollment", {
    schemaVersion: "accountless-enrollment-v0.1", deviceId, deviceSecretHash: hash,
    policyVersion: "accountless-opt-out-v1", authorizationBasis: "accountless-policy-v1",
  });
  expect(enrollment.status, await enrollment.clone().text()).toBe(201);
  const ownership = await post("/api/v1/accountless/ownership", {
    schemaVersion: "accountless-upload-owner-v0.1", policyVersion: "accountless-opt-out-v1",
    authorizationBasis: "accountless-policy-v1", telemetrySchemaVersion: "telemetry-contribution-v1.1",
  }, authorization);
  expect(ownership.status, await ownership.clone().text()).toBe(201);
  const grant = await post("/api/v1/accountless/telemetry-v1.2-authorization", V12_AUTHORIZATION, authorization);
  expect(grant.status, await grant.clone().text()).toBe(201);
  const owner = await db().prepare("SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id = ?")
    .bind(deviceId).first<{ participant_id: string }>();
  if (!owner) throw new Error("missing accountless owner");
  return { deviceId, authorization, participantId: owner.participant_id };
}

interface Exchange { path: string; status: number }

function client(authorization: string, recordsByDay: Map<string, number>, exchanges: Exchange[]) {
  return {
    serverBaseUrl: origin, deviceAuthorization: authorization, laboratory: true,
    authorization: V12_AUTHORIZATION,
    days: [...recordsByDay.keys()].sort(),
    // A day the client plans but holds no record for is idle: zero chunks.
    readDay: async (day: string) => localDay(day, recordsByDay.get(day) ?? 0),
    createEnvelope: encrypted,
    fetchImpl: async (url: URL, request: RequestInit) => {
      expect(request.redirect).toBe("error");
      const response = await handleRequest(new Request(url, { ...request, redirect: "manual" }), typed());
      exchanges.push({ path: new URL(url).pathname, status: response.status });
      return response;
    },
  } satisfies TelemetryV12SyncOptions;
}

function journal() {
  let value: unknown = null;
  return { current: () => value, store: { read: () => value, write: (next: unknown) => { value = next; } } };
}

const count = (sql: string, ...binds: unknown[]) => db().prepare(sql).bind(...binds).first<number>("n");
const failed = (exchanges: Exchange[]) => exchanges.filter((exchange) => exchange.status >= 400);

async function idleManifest(participantId: string, day: string) {
  return db().prepare(`SELECT expected_chunk_count, state, ready_at IS NOT NULL AS ready
      FROM telemetry_v12_day_manifests WHERE participant_id = ? AND chunk_day = ?`)
    .bind(participantId, day).all<{ expected_chunk_count: number; state: string; ready: number }>();
}

async function activeDomainDays(participantId: string): Promise<string[]> {
  const rows = await db().prepare(`SELECT day_row.observed_day
      FROM telemetry_v12_domain_heads head
      JOIN telemetry_v12_domain_days day_row ON day_row.generation_id = head.generation_id
     WHERE head.participant_id = ? ORDER BY day_row.observed_day`)
    .bind(participantId).all<{ observed_day: string }>();
  return rows.results.map((row) => row.observed_day);
}

describe("real v1.2 client across an idle day on the D1 routes", () => {
  it("completes and activates a first pass whose range contains an idle day, then appends", async () => {
    await prepare();
    const install = await enrollV12OnlyInstall();
    const recordsByDay = new Map([[dayOf(-2), 2], [dayOf(0), 1]]);
    const exchanges: Exchange[] = [];
    const progress = journal();
    const first = await runTelemetryV12Sync({ ...client(install.authorization, recordsByDay, exchanges),
      progressStore: progress.store, sourcePublication: { fingerprint: "local-v12-idle-1", parserVersion } });
    expect({ first, failures: failed(exchanges) }).toMatchObject({
      first: { status: "complete", failure: null, daysTotal: 3, chunksUploaded: 2, recordsUploaded: 3,
        acknowledgedThroughDay: dayOf(0) },
      failures: [],
    });
    expect(progress.current()).toBeNull();
    // The idle day is registered, complete at registration and covered by the
    // activated generation; it uploaded nothing.
    expect((await idleManifest(install.participantId, dayOf(-1))).results)
      .toEqual([{ expected_chunk_count: 0, state: "ready", ready: 1 }]);
    expect(await count("SELECT count(*) n FROM telemetry_v12_chunks WHERE chunk_day = ?", dayOf(-1))).toBe(0);
    expect(await activeDomainDays(install.participantId)).toEqual([dayOf(-2), dayOf(-1), dayOf(0)]);
    expect(await db().prepare("SELECT revision FROM telemetry_v12_domain_heads WHERE participant_id = ?")
      .bind(install.participantId).first("revision")).toBe(1);
    // Every uploaded chunk passed the quarantine admission fence (0013).
    expect(await count(`SELECT count(*) n FROM telemetry_v12_chunks chunk
        JOIN pending_quarantine_objects pending
          ON pending.contribution_id = chunk.id AND pending.r2_key = chunk.r2_key
       WHERE chunk.device_id = ?`, install.deviceId)).toBe(2);
    expect(await count("SELECT count(*) n FROM community_public_source_owners WHERE device_id = ?", install.deviceId)).toBe(1);

    // A later pass keeps the idle day as registered and appends the newer day.
    recordsByDay.set(dayOf(0), 2);
    const again: Exchange[] = [];
    const second = await runTelemetryV12Sync({ ...client(install.authorization, recordsByDay, again),
      progressStore: progress.store, sourcePublication: { fingerprint: "local-v12-idle-2", parserVersion } });
    expect({ second, failures: failed(again) }).toMatchObject({
      second: { status: "complete", failure: null, chunksUploaded: 1, chunksSkipped: 1 }, failures: [],
    });
    expect((await idleManifest(install.participantId, dayOf(-1))).results)
      .toEqual([{ expected_chunk_count: 0, state: "ready", ready: 1 }]);
    expect(await activeDomainDays(install.participantId)).toEqual([dayOf(-2), dayOf(-1), dayOf(0)]);
    expect(await db().prepare("SELECT revision FROM telemetry_v12_domain_heads WHERE participant_id = ?")
      .bind(install.participantId).first("revision")).toBe(2);
  });

  it("without isolation 0012 the idle day is refused and no pass can activate", async () => {
    await prepare({ withoutEmptyDayMigration: true });
    const install = await enrollV12OnlyInstall();
    const recordsByDay = new Map([[dayOf(-2), 1], [dayOf(0), 1]]);
    for (let pass = 0; pass < 2; pass += 1) {
      const exchanges: Exchange[] = [];
      const result = await runTelemetryV12Sync(client(install.authorization, recordsByDay, exchanges));
      expect(result).toMatchObject({ status: "failed", failure: { retryable: true } });
      expect(failed(exchanges).map((exchange) => [exchange.path, exchange.status]))
        .toEqual([["/api/v1/device/telemetry/v1.2/day-manifests", 503]]);
    }
    expect(await count("SELECT count(*) n FROM telemetry_v12_day_manifests WHERE chunk_day = ?", dayOf(-1))).toBe(0);
    expect(await count("SELECT count(*) n FROM telemetry_v12_domain_heads WHERE participant_id = ?", install.participantId)).toBe(0);
  });
});
