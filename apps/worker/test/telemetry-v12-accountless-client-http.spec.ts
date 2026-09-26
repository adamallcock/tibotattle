import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalTelemetryV12Json,
  telemetryV12DayManifestDigestInput,
  telemetryV12RequiredConsent,
  type TelemetryV12Chunk,
  type TelemetryV12DayManifest,
  type TelemetryV12Envelope,
  type TelemetryV12UsageEvent,
} from "@app-usagemonitor/telemetry-contract";
import {
  assertAccountlessRetentionSourceSnapshotCurrent,
  captureAccountlessRetentionSourceSnapshot,
  readAccountlessRetentionSourcePage,
} from "../src/accountless-retention-transfer-source";
import { initializeStorageSource } from "../src/analytics-delivery";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { handleRequest } from "../src/index";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";
import { initializeTypedV11Admission } from "../src/typed-v11-admission";
import { runTelemetryV12Sync, type TelemetryV12SyncOptions } from "./helpers/contribution-v12-runner.js";

// The shipped desktop client talks to the real HTTP routes in its own order:
// capabilities, domain predecessor, day manifests, upload authorizations,
// contributions, then activation. These cases drive that client end to end for
// an accountless install that has only ever used v1.2 (it holds the v1.1 owner
// grant created at ownership, but never activates a v1.1 domain).

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
const namespace = "synthetic-v12-client-http";
// The accountless client accepts a laboratory destination only on loopback.
const origin = "http://127.0.0.1:9987";
const keyId = "key:synthetic-v12-client-http";
const parserVersion = "synthetic-v12-client-http";
const DAY_MS = 24 * 60 * 60 * 1000;
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

const TRANSFER_V12_MIGRATION = "0014_accountless_history_transfer_v12.sql";

async function prepare(options: { withoutTransferV12?: boolean } = {}): Promise<void> {
  await reset();
  await applyD1Migrations(db(), b.TEST_MIGRATIONS);
  await applyD1Migrations(db(), b.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(db(), b.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(db(), b.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(b.DELETION_LEDGER, b.TEST_DELETION_LEDGER_MIGRATIONS);
  await initializeStorageSource(db(), "synthetic-v12-client-http-journal");
  await applyD1Migrations(db(), b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await initializeTypedV11Admission(db(), namespace);
  await initializeTypedV1Admission(db(), namespace);
  // Every isolation migration, including 0010 (v1.2 renewal), 0011 (v1.2
  // public eligibility), 0012 (v1.2 empty-day manifest rebuild), 0013 (v1.2
  // quarantine admission fence) and 0014 (v1.2 retained-history transfer
  // source), unless a case omits 0014.
  if (!b.TEST_INGESTION_ISOLATION_MIGRATIONS.some((migration) => migration.name === TRANSFER_V12_MIGRATION)) {
    throw new Error("missing v1.2 retained-history transfer migration");
  }
  await applyD1Migrations(db(), b.TEST_INGESTION_ISOLATION_MIGRATIONS.filter((migration) =>
    !options.withoutTransferV12 || migration.name !== TRANSFER_V12_MIGRATION));
  await db().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
  await db().prepare("UPDATE telemetry_v12_runtime SET state='active', changed_at=? WHERE id=1")
    .bind(new Date(Date.now() - 30 * DAY_MS).toISOString()).run();
}

beforeEach(() => prepare());

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

function api(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.method === "POST") headers.set("origin", origin);
  return handleRequest(new Request(`${origin}${path}`, { ...init, headers }), typed());
}

function post(path: string, body: unknown, authorization?: string): Promise<Response> {
  return api(path, { method: "POST", headers: {
    "content-type": "application/json", ...(authorization ? { authorization } : {}),
  }, body: JSON.stringify(body) });
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
    eventId: `event:v2:${sequence.toString(16).padStart(64, "0")}`,
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

/** One deterministic local day: the same inputs always yield the same digests. */
async function localDay(day: string, records: number): Promise<{ manifest: TelemetryV12DayManifest; chunks: TelemetryV12Chunk[] }> {
  const consent = telemetryV12RequiredConsent();
  const usage = Array.from({ length: records }, (_, index) => usageRecord(day, index + 1));
  const chunk: TelemetryV12Chunk = {
    schemaVersion: "telemetry-contribution-v1.2", manifestDigest: "0".repeat(64),
    chunkId: `usage:${day}:0`, chunkRevision: 1, parserVersion, consent, records: usage,
    chunkDigest: await sha256Hex(canonicalTelemetryV12Json(usage)),
  };
  const manifest: TelemetryV12DayManifest = {
    schemaVersion: "telemetry-day-manifest-v1.2", day, parserVersion, consent,
    chunks: [{ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: usage.length }],
    excluded: { quota: 0, session: 0, usage: 0 }, manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = await sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  chunk.manifestDigest = manifest.manifestDigest;
  return { manifest, chunks: [chunk] };
}

async function deviceSecretHash(deviceId: string, secret: Uint8Array): Promise<string> {
  const prefix = new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`);
  const input = new Uint8Array(prefix.length + secret.length);
  input.set(prefix);
  input.set(secret, prefix.length);
  try { return await sha256Hex(input); } finally { input.fill(0); }
}

/** Enroll, take ownership and request the v1.2 grant over HTTP, 25 days into
 * the 30-day lease so a later renewal request is due. */
async function enrollV12OnlyInstall(): Promise<{ deviceId: string; authorization: string; participantId: string }> {
  const deviceId = crypto.randomUUID();
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const authorization = `Device um_device_${deviceId}.${encodeBase64Url(secret)}`;
  const hash = await deviceSecretHash(deviceId, secret);
  secret.fill(0);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 25 * DAY_MS);
  try {
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
  } finally { clock.mockRestore(); }
  const owner = await db().prepare("SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id = ?")
    .bind(deviceId).first<{ participant_id: string }>();
  if (!owner) throw new Error("missing accountless owner");
  return { deviceId, authorization, participantId: owner.participant_id };
}

interface Exchange { path: string; status: number; body: unknown }

function client(authorization: string, recordsByDay: Map<string, number>, exchanges: Exchange[]) {
  return {
    serverBaseUrl: origin, deviceAuthorization: authorization, laboratory: true,
    authorization: V12_AUTHORIZATION,
    days: [...recordsByDay.keys()].sort(),
    readDay: async (day: string) => localDay(day, recordsByDay.get(day) ?? 0),
    createEnvelope: encrypted,
    fetchImpl: async (url: URL, request: RequestInit) => {
      expect(request.redirect).toBe("error");
      const response = await handleRequest(new Request(url, { ...request, redirect: "manual" }), typed());
      exchanges.push({ path: new URL(url).pathname, status: response.status, body: await response.clone().json() });
      return response;
    },
  } satisfies TelemetryV12SyncOptions;
}

function journal() {
  const writes: unknown[] = [];
  let value: unknown = null;
  return {
    writes,
    current: () => value,
    store: { read: () => value, write: (next: unknown) => { writes.push(next); value = next; } },
  };
}

const count = (sql: string, ...binds: unknown[]) => db().prepare(sql).bind(...binds).first<number>("n");
const failed = (exchanges: Exchange[]) => exchanges.filter((exchange) => exchange.status >= 400);
const predecessors = (exchanges: Exchange[]) => exchanges
  .filter((exchange) => exchange.path === "/api/v1/me/telemetry-v12/domain-predecessor")
  .map((exchange) => exchange.body as { fromDay: string; throughDay: string; legacyFingerprint: string; previousGenerationId: string | null });

describe("real v1.2 client over the Worker HTTP routes for a v1.2-only accountless install", () => {
  it("seeds a never-uploaded install's predecessor with the current day instead of refusing it", async () => {
    const install = await enrollV12OnlyInstall();
    const first = await post("/api/v1/me/telemetry-v12/domain-predecessor", {}, install.authorization);
    expect(first.status, await first.clone().text()).toBe(201);
    const body = await first.json<{ fromDay: string; throughDay: string; previousGenerationId: string | null; legacyFingerprint: string }>();
    expect(body).toMatchObject({ fromDay: dayOf(0), throughDay: dayOf(0), previousGenerationId: null });
    const second = await post("/api/v1/me/telemetry-v12/domain-predecessor", {}, install.authorization);
    expect(second.status).toBe(201);
    expect((await second.json<{ legacyFingerprint: string }>()).legacyFingerprint).toBe(body.legacyFingerprint);
    expect(await count("SELECT count(*) n FROM telemetry_v12_day_manifests")).toBe(0);
  });

  it("uploads, renews and uploads again with the desktop's progress journal", async () => {
    const install = await enrollV12OnlyInstall();
    const recordsByDay = new Map([[dayOf(-1), 2], [dayOf(0), 3]]);
    const exchanges: Exchange[] = [];
    const progress = journal();
    const first = await runTelemetryV12Sync({ ...client(install.authorization, recordsByDay, exchanges),
      progressStore: progress.store, sourcePublication: { fingerprint: "local-v12-1", parserVersion } });
    expect({ first, failures: failed(exchanges) }).toMatchObject({
      first: { status: "complete", failure: null, chunksUploaded: 2, recordsUploaded: 5 }, failures: [],
    });
    // The journal re-reads the predecessor after its own days became ready;
    // that must not change the fingerprint it pinned before staging them.
    const pinned = predecessors(exchanges);
    expect(pinned).toHaveLength(2);
    expect(pinned[0]).toMatchObject({ fromDay: dayOf(0), throughDay: dayOf(0), previousGenerationId: null });
    expect(pinned[1]).toMatchObject({ fromDay: dayOf(-1), throughDay: dayOf(0), previousGenerationId: null });
    expect(pinned[1]!.legacyFingerprint).toBe(pinned[0]!.legacyFingerprint);
    expect(progress.current()).toBeNull();

    expect(await count("SELECT count(*) n FROM telemetry_v11_domains WHERE device_id = ?", install.deviceId)).toBe(0);
    expect(await count("SELECT count(*) n FROM telemetry_v12_chunks WHERE device_id = ?", install.deviceId)).toBe(2);
    expect(await db().prepare("SELECT revision FROM telemetry_v12_domain_heads WHERE participant_id = ?")
      .bind(install.participantId).first("revision")).toBe(1);
    expect(await count("SELECT count(*) n FROM community_public_source_owners WHERE device_id = ?", install.deviceId)).toBe(1);
    expect(await count("SELECT count(*) n FROM storage_v12_event_sources WHERE participant_id = ?", install.participantId)).toBe(1);

    const renewal = await post("/api/v1/accountless/renewal", {
      schemaVersion: "accountless-renewal-v0.1", policyVersion: "accountless-opt-out-v1",
      authorizationBasis: "accountless-policy-v1", telemetrySchemaVersion: "telemetry-contribution-v1.1",
    }, install.authorization);
    expect(renewal.status, await renewal.clone().text()).toBe(200);
    expect(await renewal.json()).toMatchObject({ state: "renewed", renewalGeneration: 1 });
    expect(await db().prepare(`SELECT grant_row.state, grant_row.expires_at = ledger.expires_at AS current
        FROM accountless_v12_device_authorizations grant_row
        JOIN accountless_enrollment_ledger ledger ON ledger.device_id = grant_row.enrollment_device_id
       WHERE grant_row.enrollment_device_id = ?`).bind(install.deviceId).first())
      .toEqual({ state: "active", current: 1 });

    recordsByDay.set(dayOf(0), 4);
    const again: Exchange[] = [];
    const second = await runTelemetryV12Sync({ ...client(install.authorization, recordsByDay, again),
      progressStore: progress.store, sourcePublication: { fingerprint: "local-v12-2", parserVersion } });
    expect({ second, failures: failed(again) }).toMatchObject({
      second: { status: "complete", failure: null, chunksUploaded: 1, chunksSkipped: 1, recordsUploaded: 4 }, failures: [],
    });
    expect(await count("SELECT count(*) n FROM telemetry_v12_chunks WHERE device_id = ?", install.deviceId)).toBe(3);
    expect(await db().prepare("SELECT revision FROM telemetry_v12_domain_heads WHERE participant_id = ?")
      .bind(install.participantId).first("revision")).toBe(2);
    expect(await count("SELECT count(*) n FROM telemetry_v11_domains WHERE device_id = ?", install.deviceId)).toBe(0);
    expect(await count("SELECT count(*) n FROM community_public_source_owners WHERE device_id = ?", install.deviceId)).toBe(1);
  });

  it("resumes a partial first pass from its journal instead of discarding it", async () => {
    const install = await enrollV12OnlyInstall();
    const recordsByDay = new Map([[dayOf(-1), 1], [dayOf(0), 1]]);
    const progress = journal();
    const publication = { fingerprint: "local-v12-resume", parserVersion };
    const partial = await runTelemetryV12Sync({ ...client(install.authorization, recordsByDay, []),
      progressStore: progress.store, sourcePublication: publication, maxChunks: 1 });
    expect(partial).toMatchObject({ status: "partial", failure: null, chunksUploaded: 1 });
    expect(progress.current()).not.toBeNull();
    const resumedFrom = progress.writes.length;
    const exchanges: Exchange[] = [];
    const resumed = await runTelemetryV12Sync({ ...client(install.authorization, recordsByDay, exchanges),
      progressStore: progress.store, sourcePublication: publication });
    expect({ resumed, failures: failed(exchanges) }).toMatchObject({
      resumed: { status: "complete", failure: null, chunksUploaded: 1 }, failures: [],
    });
    // A discarded journal is cleared before anything else is recorded. The
    // resumed pass instead re-validates its saved prefix under the same pin.
    expect(progress.writes[resumedFrom]).not.toBeNull();
    expect(progress.current()).toBeNull();
    expect(await count("SELECT count(*) n FROM telemetry_v12_chunks WHERE device_id = ?", install.deviceId)).toBe(2);
  });

  it("uploads a never-uploaded install without a journal", async () => {
    const install = await enrollV12OnlyInstall();
    const exchanges: Exchange[] = [];
    const result = await runTelemetryV12Sync(client(install.authorization, new Map([[dayOf(0), 2]]), exchanges));
    expect({ result, failures: failed(exchanges) }).toMatchObject({
      result: { status: "complete", failure: null, chunksUploaded: 1, recordsUploaded: 2, acknowledgedThroughDay: dayOf(0) },
      failures: [],
    });
    expect(predecessors(exchanges)).toHaveLength(1);
    expect(await count("SELECT count(*) n FROM telemetry_v12_domain_heads WHERE participant_id = ?", install.participantId)).toBe(1);
  });
});

async function optOutAfterUpload(): Promise<{ deviceId: string; participantId: string; generationId: string; retainedAt: string }> {
  const install = await enrollV12OnlyInstall();
  const exchanges: Exchange[] = [];
  const result = await runTelemetryV12Sync(client(install.authorization, new Map([[dayOf(0), 2]]), exchanges));
  expect({ result, failures: failed(exchanges) }).toMatchObject({ result: { status: "complete" }, failures: [] });
  const disconnect = await api("/api/v1/device/disconnect", { method: "POST", headers: { authorization: install.authorization } });
  expect(disconnect.status, await disconnect.clone().text()).toBe(200);
  const head = await db().prepare("SELECT generation_id FROM telemetry_v12_domain_heads WHERE participant_id = ?")
    .bind(install.participantId).first<{ generation_id: string }>();
  const marker = await db().prepare(`SELECT generation_id, head_revision, retained_at
      FROM accountless_public_history_retention WHERE participant_id = ?`)
    .bind(install.participantId).first<{ generation_id: string; head_revision: number; retained_at: string }>();
  expect(marker).toMatchObject({ generation_id: head!.generation_id, head_revision: 1 });
  expect(await db().prepare(`SELECT state, revocation_reason, revoked_at
      FROM accountless_v12_device_authorizations WHERE enrollment_device_id = ?`).bind(install.deviceId).first())
    .toEqual({ state: "revoked", revocation_reason: "user_opt_out", revoked_at: marker!.retained_at });
  return { deviceId: install.deviceId, participantId: install.participantId,
    generationId: head!.generation_id, retainedAt: marker!.retained_at };
}

describe("retained-history transfer source for a v1.2-only opt-out", () => {
  it("before isolation 0014 one v1.2-only opt-out refuses the whole capture", async () => {
    await prepare({ withoutTransferV12: true });
    await optOutAfterUpload();
    await expect(captureAccountlessRetentionSourceSnapshot(db(), {
      runId: `synthetic-v12-retention:${crypto.randomUUID()}`, snapshotAt: new Date().toISOString(),
    })).rejects.toMatchObject({ code: "SOURCE_MARKER_INELIGIBLE" });
  });

  it("seals the v1.2 marker with its successor proof and invalidates on a v1.2 head change", async () => {
    const retained = await optOutAfterUpload();
    // The retained v1.2 owner stays a public source through isolation 0011.
    expect(await count("SELECT count(*) n FROM community_public_source_owners WHERE device_id = ?", retained.deviceId)).toBe(1);
    const snapshot = await captureAccountlessRetentionSourceSnapshot(db(), {
      runId: `synthetic-v12-retention:${crypto.randomUUID()}`, snapshotAt: new Date().toISOString(),
    });
    expect(snapshot).toMatchObject({ state: "sealed", rowCount: 1 });
    const page = await readAccountlessRetentionSourcePage(db(), { runId: snapshot.runId, limit: 1 });
    expect(page?.rows).toHaveLength(1);
    expect(page!.rows[0]).toMatchObject({
      participant_id: retained.participantId,
      marker_generation_id: retained.generationId,
      marker_head_revision: 1,
      marker_retained_at: retained.retainedAt,
      grant_participant_id: retained.participantId,
      grant_device_credential_id: retained.deviceId,
      grant_telemetry_schema_version: "telemetry-contribution-v1.2",
      grant_field_dictionary_version: "telemetry-v1.2-registry-2026-09-20.1",
      grant_privacy_contract_version: "ongoing-privacy-safe-telemetry-v1.2",
      grant_state: "revoked",
      grant_revocation_reason: "user_opt_out",
      grant_revoked_at: retained.retainedAt,
      head_participant_id: retained.participantId,
      head_generation_id: retained.generationId,
      head_revision: 1,
      domain_id: retained.generationId,
      domain_participant_id: retained.participantId,
      domain_device_id: retained.deviceId,
    });
    expect(page!.rows[0]!.grant_expires_at).toBe(page!.rows[0]!.ledger_expires_at);
    await expect(assertAccountlessRetentionSourceSnapshotCurrent(db(), snapshot.runId))
      .resolves.toMatchObject({ state: "sealed" });
    // A v1.2 head change can alter the proof, so it fences the open snapshot.
    await db().prepare("UPDATE telemetry_v12_domain_heads SET revision = revision + 1 WHERE participant_id = ?")
      .bind(retained.participantId).run();
    await expect(assertAccountlessRetentionSourceSnapshotCurrent(db(), snapshot.runId))
      .rejects.toMatchObject({ code: "SOURCE_AUTHORITY_MUTATED" });
  });
});
