import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse } from "jsonc-parser";
import { MAX_TELEMETRY_V12_DOMAIN_DAYS } from "@app-usagemonitor/telemetry-contract";
import wranglerSource from "../wrangler.jsonc?raw";
import {
  assertAccountlessRetentionSourceSnapshotCurrent,
  captureAccountlessRetentionSourceSnapshot,
  readAccountlessRetentionSourcePage,
} from "../src/accountless-retention-transfer-source";
import { initializeStorageSource } from "../src/analytics-delivery";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { ApiError } from "../src/errors";
import { handleRequest } from "../src/index";
import { eraseParticipantAsOwner } from "../src/participant-erasure";
import { recordDeletionTombstone, replayDeletionTombstones } from "../src/retention";
import { telemetryV12StorageConstraintRefusal } from "../src/telemetry-v12-repository";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";
import { initializeTypedV11Admission } from "../src/typed-v11-admission";
import {
  createTelemetryV12Day,
  createTelemetryV12Envelope,
  readTelemetryV12Capabilities,
  runTelemetryV12Sync,
  type TelemetryV12SyncRun,
} from "./helpers/contribution-v12-runner.js";

// The shipped desktop client (v0.1.24) drives these routes itself, in its own
// order: enrollment, ownership, v1.2 negotiation (a capability read, then the
// grant when it is not current), and then one incremental pass with a progress
// journal: capabilities, domain predecessor, one day manifest per day of the
// range (a day without records is an empty manifest), uploads, a closing
// capability read and predecessor, and activation. Every case below runs the
// real client modules against handleRequest; nothing is hand-assembled. The
// cases cover the first-sync contract (a predecessor for a device with no
// ready day, empty days, a fingerprint that the pass's own days do not move),
// steady-state passes, device-sync admission at the checked-in limits, the
// paced refusal of a schema without ingestion-isolation 0012, and the opt-out,
// eligibility and erasure paths of a domain that includes empty days. The GCP
// line adds the retained-history transfer source for a v1.2-only opt-out,
// which needs ingestion-isolation 0014.

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
const EMPTY_DAYS_MIGRATION = "0012_v12_empty_day_manifests.sql";
const TRANSFER_V12_MIGRATION = "0014_accountless_history_transfer_v12.sql";
const SESSION = "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b";
const DAY_MS = 86_400_000;
const ENROLLMENT = Object.freeze({
  schemaVersion: "accountless-enrollment-v0.1", policyVersion: "accountless-opt-out-v1",
  authorizationBasis: "accountless-policy-v1",
});
const V11_OWNERSHIP = Object.freeze({
  schemaVersion: "accountless-upload-owner-v0.1", policyVersion: "accountless-opt-out-v1",
  authorizationBasis: "accountless-policy-v1", telemetrySchemaVersion: "telemetry-contribution-v1.1",
});
const V12_AUTHORIZATION = Object.freeze({
  schemaVersion: "accountless-upload-owner-v1.2",
  policyVersion: "accountless-telemetry-v1.2-policy-v1",
  authorizationBasis: "accountless-policy-v1.2",
  telemetrySchemaVersion: "telemetry-contribution-v1.2",
} as const);
const DEVICE_SYNC_PATHS = new Set([
  "/api/v1/device/sync-capabilities-v1.2",
  "/api/v1/me/telemetry-v12/domain-predecessor",
  "/api/v1/device/telemetry/v1.2/day-manifests",
  "/api/v1/me/telemetry-v12/domain-activate",
]);

const today = () => new Date().toISOString().slice(0, 10);
const dayOf = (offset: number) =>
  new Date(Date.parse(`${today()}T00:00:00.000Z`) + offset * DAY_MS).toISOString().slice(0, 10);

let publicText = "";
let privateText = "";

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({
    name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
  }, true, ["encrypt", "decrypt"]);
  if (!("publicKey" in pair)) throw new Error("synthetic RSA pair required");
  publicText = JSON.stringify({ ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: keyId });
  privateText = JSON.stringify({ ...await crypto.subtle.exportKey("jwk", pair.privateKey), kid: keyId });
});

async function prepare(options: { withoutEmptyDays?: boolean; withoutTransferV12?: boolean } = {}): Promise<void> {
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
  if (!b.TEST_INGESTION_ISOLATION_MIGRATIONS.some((migration) => migration.name === EMPTY_DAYS_MIGRATION)) {
    throw new Error("missing the empty-day manifest migration");
  }
  if (!b.TEST_INGESTION_ISOLATION_MIGRATIONS.some((migration) => migration.name === TRANSFER_V12_MIGRATION)) {
    throw new Error("missing v1.2 retained-history transfer migration");
  }
  // Every isolation migration, including 0012 (v1.2 empty-day manifest
  // rebuild), 0013 (v1.2 quarantine admission fence) and 0014 (v1.2
  // retained-history transfer source), unless a case stops before 0012 or
  // omits 0014.
  await applyD1Migrations(db(), b.TEST_INGESTION_ISOLATION_MIGRATIONS.filter((migration) =>
    (!options.withoutEmptyDays || migration.name < EMPTY_DAYS_MIGRATION)
    && (!options.withoutTransferV12 || migration.name !== TRANSFER_V12_MIGRATION)));
  await db().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
  await db().prepare("UPDATE telemetry_v12_runtime SET state='active', changed_at=? WHERE id=1")
    .bind(new Date(Date.now() - 30 * DAY_MS).toISOString()).run();
}

beforeEach(() => prepare());

function runtime(limiters: Record<string, RateLimit> = {}, bindings: Partial<Env> = {}): Env {
  const value = {
    ...b, ENVIRONMENT: "synthetic-development", ACCOUNT_SCOPED_INGEST_MODE: "disabled",
    ACCOUNTLESS_ENROLLMENT_MODE: "enabled", ACCOUNTLESS_OWNERSHIP_MODE: "enabled",
    ENVELOPE_PUBLIC_JWK: publicText, ENVELOPE_PRIVATE_JWK: privateText, ...limiters, ...bindings,
  } as Env;
  // Local overrides are validated by the real runtime parser; the generated
  // Env describes deployed defaults, not this synthetic typed lane.
  Reflect.set(value, "TELEMETRY_STORAGE_MODE", "typed");
  Reflect.set(value, "TELEMETRY_STORAGE_NAMESPACE", namespace);
  Reflect.set(value, "PUBLIC_ORIGIN", origin);
  return value;
}

interface Exchange {
  method: string;
  path: string;
  status: number;
  code: string | null;
  retryAfter: string | null;
  body: unknown;
}

interface Transport {
  exchanges: Exchange[];
  fetch: (input: URL | string, init?: RequestInit) => Promise<Response>;
}

/** Hands each client request to the Worker as a fresh Request, optionally
 * from one client address and under replacement Rate Limit or D1 bindings. */
function transport(options: {
  limiters?: Record<string, RateLimit>; address?: string; bindings?: Partial<Env>;
} = {}): Transport {
  const exchanges: Exchange[] = [];
  return {
    exchanges,
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      const headers = new Headers(init.headers);
      if (options.address) headers.set("cf-connecting-ip", options.address);
      const method = init.method ?? "GET";
      const response = await handleRequest(new Request(url, {
        method, headers, ...(init.body === undefined || init.body === null ? {} : { body: init.body }),
      }), runtime(options.limiters, options.bindings));
      let body: unknown = null;
      try { body = await response.clone().json(); } catch { body = null; }
      const code = response.ok ? null
        : (body as { error?: { code?: string } } | null)?.error?.code ?? null;
      exchanges.push({ method, path: url.pathname, status: response.status, code,
        retryAfter: response.headers.get("retry-after"), body });
      return response;
    },
  };
}

interface Install { deviceId: string; authorization: string; deviceSecretHash: string }

async function newInstall(): Promise<Install> {
  const deviceId = crypto.randomUUID();
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const prefix = new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`);
  const input = new Uint8Array(prefix.length + secret.length);
  input.set(prefix);
  input.set(secret, prefix.length);
  try {
    return { deviceId, authorization: `Device um_device_${deviceId}.${encodeBase64Url(secret)}`,
      deviceSecretHash: await sha256Hex(input) };
  } finally {
    input.fill(0);
    secret.fill(0);
  }
}

async function participantOf(install: Install): Promise<string> {
  const participantId = await db().prepare(
    "SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id = ?",
  ).bind(install.deviceId).first<string>("participant_id");
  if (!participantId) throw new Error("missing accountless owner");
  return participantId;
}

interface DayRecords { usage: number; quota?: number; session?: number }

const hexOf = (day: string, stream: number, index: number) =>
  `${day.replaceAll("-", "")}${stream}${index.toString(16).padStart(8, "0")}`.padStart(64, "0");

/** The desktop's local index: day -> records. Days absent here are gaps. */
function localIndex(initial: Record<string, number | DayRecords>) {
  const days = new Map<string, DayRecords>();
  let revision = 0;
  const set = (day: string, records: number | DayRecords) => {
    days.set(day, typeof records === "number" ? { usage: records } : records);
    revision += 1;
  };
  for (const [day, records] of Object.entries(initial)) set(day, records);
  return {
    set,
    days: () => [...days.keys()].sort(),
    fingerprint: () => `synthetic-local-v12-${revision}`,
    readDay: async (day: string, context: { activationTime: string | null }) => {
      const records = days.get(day) ?? { usage: 0 };
      return createTelemetryV12Day({
        day, parserVersion, activationTime: context.activationTime,
        recordsByStream: {
          usage: Array.from({ length: records.usage }, (_, index) => ({
            eventId: `event:v2:${hexOf(day, 1, index)}`,
            eventTime: `${day}T12:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
            sessionUuid: SESSION, provider: "openai_codex", modelId: "gpt-5.6-sol", speedMode: "standard",
            apiServiceTier: "default", surface: "local_interactive_unclassified",
            billingSurface: "chatgpt_subscription", reasoningEffort: "high", agentScope: "root",
            outcome: "completed", totalInputContextTokens: 1000,
            components: { inputUncachedTokens: 100, inputCacheReadTokens: 900, inputCacheWriteTokens: 0,
              outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: null },
          })),
          quota: Array.from({ length: records.quota ?? 0 }, (_, index) => ({
            observationId: `quota-occurrence:v1:${hexOf(day, 2, index)}`,
            observedTime: `${day}T13:00:${String(index % 60).padStart(2, "0")}.000Z`,
            provider: "openai_codex", planType: "pro", planVariant: "unknown", limitId: "codex",
            slot: "secondary", usedPercent: 12.5, windowDurationMinutes: 10_080,
            resetsAt: `${day}T23:00:00.000Z`,
          })),
          session: Array.from({ length: records.session ?? 0 }, () => ({
            sessionUuid: SESSION, firstEventTime: `${day}T12:00:00.000Z`, provider: "openai_codex",
            toolClassCounts: { localShell: 2 },
          })),
        },
      });
    },
  };
}
type LocalIndex = ReturnType<typeof localIndex>;

function journal() {
  const writes: unknown[] = [];
  let value: unknown = null;
  return {
    writes,
    current: () => value,
    store: {
      read: async () => value,
      write: async (next: unknown) => { writes.push(next); value = next; },
    },
  };
}
type Journal = ReturnType<typeof journal>;

const JSON_HEADERS = Object.freeze({ accept: "application/json", "content-type": "application/json" });

/** Enrollment, ownership and v1.2 negotiation, exactly as the desktop runs
 * them at the start of every pass. */
async function negotiate(install: Install, net: Transport): Promise<void> {
  const enrolled = await net.fetch(`${origin}/api/v1/accountless/enrollment`, {
    method: "POST", headers: JSON_HEADERS,
    body: JSON.stringify({ ...ENROLLMENT, deviceId: install.deviceId, deviceSecretHash: install.deviceSecretHash }),
  });
  expect([200, 201], await enrolled.clone().text()).toContain(enrolled.status);
  const owned = await net.fetch(`${origin}/api/v1/accountless/ownership`, {
    method: "POST", headers: { ...JSON_HEADERS, authorization: install.authorization },
    body: JSON.stringify(V11_OWNERSHIP),
  });
  expect([200, 201], await owned.clone().text()).toContain(owned.status);
  const capability = await readTelemetryV12Capabilities({ serverBaseUrl: origin,
    deviceAuthorization: install.authorization, fetchImpl: net.fetch, clock: Date.now, requestTimeoutMs: 30_000 });
  expect(capability).toMatchObject({ authorityKind: "accountless", successor: { lifecycle: "accepted" } });
  if (!capability.successor.authorizationCurrent) {
    const grant = await net.fetch(`${origin}/api/v1/accountless/telemetry-v1.2-authorization`, {
      method: "POST", headers: { ...JSON_HEADERS, authorization: install.authorization },
      body: JSON.stringify(V12_AUTHORIZATION),
    });
    expect(grant.status, await grant.clone().text()).toBe(201);
  }
}

/** One accountless desktop pass with the v1.2 successor negotiated. */
async function accountlessPass(install: Install, local: LocalIndex, progress: Journal, net: Transport,
  options: { maxChunks?: number } = {}): Promise<TelemetryV12SyncRun> {
  await negotiate(install, net);
  let key: { publicJwk: JsonWebKey; keyId: string } | null = null;
  return runTelemetryV12Sync({
    serverBaseUrl: origin, deviceAuthorization: install.authorization, authorization: V12_AUTHORIZATION,
    laboratory: true, days: local.days(), readDay: local.readDay, fetchImpl: net.fetch, clock: Date.now,
    progressStore: progress.store,
    preparePublication: async () => ({ fingerprint: local.fingerprint(), parserVersion }),
    createEnvelope: async (chunk) => {
      if (key === null) {
        const response = await net.fetch(new URL("/api/v1/envelope-key", origin), { headers: { accept: "application/json" } });
        key = await response.json<{ publicJwk: JsonWebKey; keyId: string }>();
      }
      return createTelemetryV12Envelope({ chunk, publicJwk: key.publicJwk, keyId: key.keyId });
    },
    maxChunks: options.maxChunks ?? 500, maxDurationMs: 60_000, requestTimeoutMs: 30_000,
  });
}

const failures = (net: Transport) => net.exchanges.filter((exchange) => exchange.status >= 400);
const deviceSync = (net: Transport) => net.exchanges.filter((exchange) => DEVICE_SYNC_PATHS.has(exchange.path));
const predecessors = (net: Transport) => net.exchanges
  .filter((exchange) => exchange.path === "/api/v1/me/telemetry-v12/domain-predecessor")
  .map((exchange) => exchange.body as { fromDay: string; throughDay: string; legacyFingerprint: string;
    previousGenerationId: string | null });
const count = (sql: string, ...binds: unknown[]) => db().prepare(sql).bind(...binds).first<number>("n");

interface RateLimitBinding { name: string; namespace_id: string; simple: { limit: number; period: number } }
const wrangler = parse(wranglerSource) as {
  ratelimits: RateLimitBinding[];
  env: Record<"staging" | "production", { ratelimits: RateLimitBinding[] }>;
};
function configuredLimits(environment: "staging" | "production"): Map<string, number> {
  return new Map(wrangler.env[environment].ratelimits.map((binding) => [binding.name, binding.simple.limit]));
}

interface RecordingLimiter extends RateLimit { readonly keys: string[] }

/** Exact fixed-window enforcement: one window, never reset by elapsed time. */
function fixedWindow(limit: number): RecordingLimiter {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }: RateLimitOptions): Promise<RateLimitOutcome> {
      keys.push(key);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return { success: next <= limit };
    },
  };
}

/** Counts every D1 statement a request starts, to prove refusal before D1. */
function countingDatabase(target: D1Database): { database: D1Database; statements: () => number } {
  let statements = 0;
  const database = new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object) as unknown;
      if (typeof value !== "function") return value;
      return (...values: unknown[]) => {
        statements += 1;
        return (value as (...items: unknown[]) => unknown).apply(object, values);
      };
    },
  });
  return { database, statements: () => statements };
}

/** Every Rate Limit binding at its checked-in production value. */
function productionLimiters(overrides: Record<string, number> = {}): Record<string, RecordingLimiter> {
  return Object.fromEntries([...configuredLimits("production")].map(([name, limit]) =>
    [name, fixedWindow(overrides[name] ?? limit)]));
}

describe("real v1.2 client over the Worker HTTP routes for a fresh accountless install", () => {
  it("seeds a never-uploaded install's predecessor with the current day instead of refusing it", async () => {
    const install = await newInstall();
    const net = transport();
    await negotiate(install, net);
    // The Worker once answered 409 TELEMETRY_MANIFEST_INCOMPLETE to a device
    // with no ready day, and the client requests this before registering any
    // day, so every pass stopped here.
    const post = () => net.fetch(`${origin}/api/v1/me/telemetry-v12/domain-predecessor`, {
      method: "POST", headers: { ...JSON_HEADERS, authorization: install.authorization }, body: "{}",
    });
    const first = await post();
    expect(first.status, await first.clone().text()).toBe(201);
    const body = await first.json<{ fromDay: string; throughDay: string; previousGenerationId: string | null;
      legacyFingerprint: string }>();
    expect(body).toMatchObject({ fromDay: today(), throughDay: today(), previousGenerationId: null });
    const second = await post();
    expect(second.status).toBe(201);
    expect((await second.json<{ legacyFingerprint: string }>()).legacyFingerprint).toBe(body.legacyFingerprint);
    expect(await count("SELECT count(*) n FROM telemetry_v12_day_manifests")).toBe(0);
  });

  it("uploads history with gap days in one pass, then a second pass after activation", async () => {
    const install = await newInstall();
    // All three streams: day -1 carries a usage, a quota and a session chunk.
    const local = localIndex({ [dayOf(-4)]: 2, [dayOf(-2)]: 1, [dayOf(-1)]: { usage: 3, quota: 1, session: 1 } });
    const progress = journal();
    const net = transport();
    const first = await accountlessPass(install, local, progress, net);
    expect({ first, failures: failures(net) }).toMatchObject({
      first: { status: "complete", failure: null, chunksUploaded: 5, recordsUploaded: 8,
        acknowledgedThroughDay: today() },
      failures: [],
    });
    // The range runs from the oldest local day through the bootstrap day, so
    // two of its five days are empty: the gap and the current day.
    expect(deviceSync(net)).toHaveLength(5 + 6);
    const pinned = predecessors(net);
    expect(pinned).toHaveLength(2);
    expect(pinned[0]).toMatchObject({ fromDay: today(), throughDay: today(), previousGenerationId: null });
    expect(pinned[1]).toMatchObject({ fromDay: dayOf(-4), throughDay: today(), previousGenerationId: null });
    // The run's own newly ready days must not move the pinned fingerprint.
    expect(pinned[1]!.legacyFingerprint).toBe(pinned[0]!.legacyFingerprint);
    expect(progress.current()).toBeNull();

    const participantId = await participantOf(install);
    expect(await db().prepare(`SELECT chunk_day, expected_chunk_count, state, ready_at IS NOT NULL AS ready
        FROM telemetry_v12_day_manifests WHERE device_id = ? AND expected_chunk_count = 0 ORDER BY chunk_day`)
      .bind(install.deviceId).all()).toMatchObject({ results: [
      { chunk_day: dayOf(-3), expected_chunk_count: 0, state: "ready", ready: 1 },
      { chunk_day: today(), expected_chunk_count: 0, state: "ready", ready: 1 },
    ] });
    expect(await count("SELECT count(*) n FROM telemetry_v12_chunks WHERE device_id = ?", install.deviceId)).toBe(5);
    for (const table of ["telemetry_v12_quota", "telemetry_v12_session_tools"]) {
      expect(await count(`SELECT count(*) n FROM ${table} t JOIN telemetry_v12_records r ON r.id = t.record_id
          JOIN telemetry_v12_chunks c ON c.id = r.chunk_id WHERE c.device_id = ?`, install.deviceId), table).toBe(1);
    }
    expect(await count(`SELECT count(*) n FROM telemetry_v12_domain_heads h
        JOIN telemetry_v12_domain_days d ON d.generation_id = h.generation_id WHERE h.participant_id = ?`,
      participantId)).toBe(5);
    expect(await db().prepare("SELECT revision FROM telemetry_v12_domain_heads WHERE participant_id = ?")
      .bind(participantId).first("revision")).toBe(1);
    // Empty days change nothing about eligibility: the device is a public source.
    expect(await count("SELECT count(*) n FROM community_public_source_owners WHERE device_id = ?", install.deviceId)).toBe(1);
    expect(await count("SELECT count(*) n FROM storage_v12_event_sources WHERE participant_id = ?", participantId)).toBe(1);

    local.set(today(), 2);
    const again = transport();
    const second = await accountlessPass(install, local, progress, again);
    expect({ second, failures: failures(again) }).toMatchObject({
      second: { status: "complete", failure: null, chunksUploaded: 1, chunksSkipped: 5, recordsUploaded: 2 },
      failures: [],
    });
    expect(predecessors(again)[0]).toMatchObject({ fromDay: dayOf(-4), throughDay: today() });
    expect(predecessors(again)[0]!.previousGenerationId).toBe(first.domainGenerationId);
    expect(await db().prepare("SELECT revision FROM telemetry_v12_domain_heads WHERE participant_id = ?")
      .bind(participantId).first("revision")).toBe(2);
    expect(await db().prepare(`SELECT m.expected_chunk_count FROM telemetry_v12_domain_heads h
        JOIN telemetry_v12_domain_days d ON d.generation_id = h.generation_id
        JOIN telemetry_v12_day_manifests m ON m.id = d.manifest_id
       WHERE h.participant_id = ? AND d.observed_day = ?`).bind(participantId, today())
      .first("expected_chunk_count")).toBe(1);
    expect(await count("SELECT count(*) n FROM storage_v12_event_sources WHERE participant_id = ?", participantId)).toBe(2);
  });

  it("resumes a partial first pass from its journal instead of discarding it", async () => {
    const install = await newInstall();
    const local = localIndex({ [dayOf(-2)]: 1, [dayOf(0)]: 1 });
    const progress = journal();
    const partial = await accountlessPass(install, local, progress, transport(), { maxChunks: 1 });
    expect(partial).toMatchObject({ status: "partial", failure: null, chunksUploaded: 1 });
    expect(progress.current()).not.toBeNull();
    const resumedFrom = progress.writes.length;
    const net = transport();
    const resumed = await accountlessPass(install, local, progress, net);
    expect({ resumed, failures: failures(net) }).toMatchObject({
      resumed: { status: "complete", failure: null, chunksUploaded: 1 }, failures: [],
    });
    // A discarded journal is cleared before anything else is recorded. The
    // resumed pass instead re-validates its saved prefix under the same pin.
    expect(progress.writes[resumedFrom]).not.toBeNull();
    expect(progress.current()).toBeNull();
    expect(await count("SELECT count(*) n FROM telemetry_v12_chunks WHERE device_id = ?", install.deviceId)).toBe(2);
  });
});

describe("steady-state passes after activation", () => {
  it("acknowledges an unchanged day vector without a new generation or owner change", async () => {
    const install = await newInstall();
    const local = localIndex({ [dayOf(-3)]: 2, [dayOf(-1)]: 1 });
    const progress = journal();
    const first = await accountlessPass(install, local, progress, transport());
    expect(first).toMatchObject({ status: "complete", failure: null });
    const participantId = await participantOf(install);
    const state = async () => ({
      head: await db().prepare("SELECT generation_id, revision FROM telemetry_v12_domain_heads WHERE participant_id = ?")
        .bind(participantId).first(),
      domains: await count("SELECT count(*) n FROM telemetry_v12_domains WHERE participant_id = ?", participantId),
      domainDays: await count(`SELECT count(*) n FROM telemetry_v12_domain_days d
          JOIN telemetry_v12_domains g ON g.id = d.generation_id WHERE g.participant_id = ?`, participantId),
      events: await count("SELECT count(*) n FROM storage_v12_event_sources WHERE participant_id = ?", participantId),
      changes: await count("SELECT count(*) n FROM storage_ingestion_changes"),
    });
    const activated = await state();
    expect(activated).toMatchObject({ head: { generation_id: first.domainGenerationId, revision: 1 },
      domains: 1, domainDays: 4, events: 1 });

    // Nothing new: the client re-registers every day, stages nothing and asks
    // to activate the same vector under a new predecessor token, so its
    // manifest digest differs. Before this fix every such pass (at least every
    // four hours) wrote a generation of every domain day and a public change.
    const net = transport();
    const again = await accountlessPass(install, local, progress, net);
    expect({ again, failures: failures(net) }).toMatchObject({
      again: { status: "complete", failure: null, chunksUploaded: 0, domainGenerationId: first.domainGenerationId },
      failures: [],
    });
    const receipt = net.exchanges.find((exchange) => exchange.path === "/api/v1/me/telemetry-v12/domain-activate")
      ?.body as { manifestDigest: string; requestedManifestDigest: string } | undefined;
    expect(receipt).toMatchObject({ generationId: first.domainGenerationId, replay: true, unchanged: true });
    expect(receipt!.requestedManifestDigest).not.toBe(receipt!.manifestDigest);
    expect(await state()).toEqual(activated);
    expect(progress.current()).toBeNull();

    // Any other change to the participant's analytical input still activates
    // a new generation for the same vector, as v1.1 does.
    await db().prepare("UPDATE community_analytical_input_versions SET revision = revision + 1 WHERE participant_id = ?")
      .bind(participantId).run();
    const moved = await accountlessPass(install, local, progress, transport());
    expect(moved).toMatchObject({ status: "complete", failure: null });
    expect(moved.domainGenerationId).not.toBe(first.domainGenerationId);
    expect(await state()).toMatchObject({ head: { generation_id: moved.domainGenerationId, revision: 2 },
      domains: 2, domainDays: 8, events: 2 });
  });

  it("counts ready days, not accumulated manifest versions, against the domain limit", async () => {
    const install = await newInstall();
    const net = transport();
    await negotiate(install, net);
    const participantId = await participantOf(install);
    const days = [dayOf(-3), dayOf(-2), dayOf(-1)] as const;
    const versions = MAX_TELEMETRY_V12_DOMAIN_DAYS + 12;
    // A device keeps every earlier manifest of a day, and new records or a
    // parser release re-digest it. Seed that history directly: more ready
    // (empty) manifest versions than the day limit, over three days.
    await db().prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?)
      INSERT INTO telemetry_v12_day_manifests (
        id, participant_id, device_id, chunk_day, manifest_digest, parser_version, manifest_json,
        expected_chunk_count, state, created_at
      ) SELECT printf('%08x-0000-4000-8000-%012x', i, i), ?, ?, day, printf('%064x', i + 1),
          'synthetic-history',
          json_object('schemaVersion', 'telemetry-day-manifest-v1.2', 'day', day, 'chunks', json('[]')),
          0, 'staged', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        FROM (SELECT i, CASE i % 3 WHEN 0 THEN ? WHEN 1 THEN ? ELSE ? END AS day FROM n)`)
      .bind(versions, participantId, install.deviceId, ...days).run();
    await db().prepare("UPDATE telemetry_v12_day_manifests SET state = 'ready', ready_at = created_at WHERE device_id = ?")
      .bind(install.deviceId).run();
    expect(await count("SELECT count(*) n FROM telemetry_v12_day_manifests WHERE device_id = ? AND state = 'ready'",
      install.deviceId)).toBe(versions);

    // Before this fix the predecessor counted rows and answered 400
    // SYNC_RANGE_TOO_LARGE, which the client treats as non-retryable: the
    // scheduler paused the install, and every later attempt failed the same way.
    const predecessor = await net.fetch(`${origin}/api/v1/me/telemetry-v12/domain-predecessor`, {
      method: "POST", headers: { ...JSON_HEADERS, authorization: install.authorization }, body: "{}",
    });
    expect(predecessor.status, await predecessor.clone().text()).toBe(201);
    expect(await predecessor.json()).toMatchObject({ fromDay: days[0], throughDay: days[2], previousGenerationId: null });
    const pinned = await db().prepare(`SELECT days_json FROM telemetry_v12_domain_predecessors
        WHERE participant_id = ? ORDER BY created_at DESC LIMIT 1`).bind(participantId).first<string>("days_json");
    // One entry per day, and each is that day's earliest ready manifest: the
    // seeded rows share one creation time, so the lowest id (i = 0, 1, 2) wins.
    const hex = (value: number, width: number) => value.toString(16).padStart(width, "0");
    expect(JSON.parse(pinned!)).toEqual(days.map((day, i) => ({ day,
      manifestId: `${hex(i, 8)}-0000-4000-8000-${hex(i, 12)}`, manifestDigest: hex(i + 1, 64) })));

    // The install still completes an ordinary pass over that range.
    const result = await accountlessPass(install, localIndex({ [dayOf(-2)]: 1 }), journal(), transport());
    expect(result).toMatchObject({ status: "complete", failure: null, chunksUploaded: 1, acknowledgedThroughDay: days[2] });
  });
});

describe("device-sync admission under the checked-in production limits", () => {
  it("sizes the authenticated budget for a full pass and keeps the attempt budgets", () => {
    for (const environment of ["production", "staging"] as const) {
      const limits = configuredLimits(environment);
      const principal = limits.get("DEVICE_SYNC_PRINCIPAL_RATE_LIMIT")!;
      // A full pass of the largest supported domain: one manifest per day and
      // six fixed requests (negotiation read, capabilities, predecessor,
      // closing capabilities and predecessor, activation).
      expect(principal, environment).toBeGreaterThanOrEqual(MAX_TELEMETRY_V12_DOMAIN_DAYS + 6);
      expect(limits.get("DEVICE_SYNC_RATE_LIMIT"), environment).toBeGreaterThanOrEqual(principal);
      // Every well-formed bearer is charged to its address before
      // verification. That budget admits the same full pass, and stays below
      // the location cap, so one address can neither drive more credential
      // checks than one pass nor use up its location's budget.
      const client = limits.get("DEVICE_SYNC_CLIENT_RATE_LIMIT")!;
      expect(client, environment).toBeGreaterThanOrEqual(principal);
      expect(client, environment).toBeLessThan(limits.get("DEVICE_SYNC_RATE_LIMIT")!);
      // Enrollment, recovery and unauthenticated attempts are not widened.
      expect({ enrollment: limits.get("ENROLLMENT_RATE_LIMIT"), recovery: limits.get("RECOVERY_RATE_LIMIT"),
        client: limits.get("CLIENT_ATTEMPT_RATE_LIMIT") }, environment)
        .toEqual({ enrollment: 20, recovery: 20, client: 5 });
    }
    const names = (bindings: RateLimitBinding[]) => bindings.map((binding) => binding.name).sort();
    expect(names(wrangler.ratelimits)).toEqual(names(wrangler.env.production.ratelimits));
    expect(names(wrangler.env.staging.ratelimits)).toEqual(names(wrangler.env.production.ratelimits));
    for (const environment of [wrangler, wrangler.env.staging, wrangler.env.production]) {
      const ids = environment.ratelimits.map((binding) => binding.namespace_id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("completes a fresh install's first pass in one window at the production limits", async () => {
    const limiters = productionLimiters();
    const install = await newInstall();
    // Forty days through today; every third day has no records.
    const history: Record<string, number> = {};
    for (let offset = -39; offset < 0; offset += 1) if ((offset + 39) % 3 !== 1) history[dayOf(offset)] = 1;
    const local = localIndex(history);
    const net = transport({ limiters, address: "198.51.100.23" });
    const result = await accountlessPass(install, local, journal(), net);
    expect({ result, failures: failures(net) }).toMatchObject({
      result: { status: "complete", failure: null, acknowledgedThroughDay: today() }, failures: [],
    });
    const requests = deviceSync(net).length;
    expect(requests).toBe(40 + 6);
    // The attempt budgets alone could never have admitted this pass.
    expect(requests).toBeGreaterThan(configuredLimits("production").get("CLIENT_ATTEMPT_RATE_LIMIT")!);
    expect(requests).toBeGreaterThan(configuredLimits("production").get("RECOVERY_RATE_LIMIT")!);
    // Authenticated device sync is charged to its own budgets only: its
    // address and location before verification, its participant after.
    expect(limiters.DEVICE_SYNC_CLIENT_RATE_LIMIT!.keys).toHaveLength(requests);
    expect(new Set(limiters.DEVICE_SYNC_CLIENT_RATE_LIMIT!.keys).size).toBe(1);
    expect(limiters.DEVICE_SYNC_RATE_LIMIT!.keys).toHaveLength(requests);
    expect(new Set(limiters.DEVICE_SYNC_PRINCIPAL_RATE_LIMIT!.keys).size).toBe(1);
    expect(limiters.DEVICE_SYNC_PRINCIPAL_RATE_LIMIT!.keys).toHaveLength(requests);
    for (const name of ["CLIENT_ATTEMPT_RATE_LIMIT", "RECOVERY_RATE_LIMIT"]) {
      expect(limiters[name]!.keys.filter((key) => key.includes(":device_sync:")), name).toEqual([]);
    }
    expect(await count("SELECT count(*) n FROM telemetry_v12_day_manifests WHERE device_id = ? AND expected_chunk_count = 0",
      install.deviceId)).toBe(14);
  });

  it("keeps the per-client attempt budget for device-sync requests that do not authenticate", async () => {
    const limiters = productionLimiters();
    const install = await newInstall();
    await negotiate(install, transport({ limiters, address: "198.51.100.1" }));
    const capabilities = (authorization: string, address: string) =>
      transport({ limiters, address }).fetch(`${origin}/api/v1/device/sync-capabilities-v1.2`, {
        headers: { accept: "application/json", authorization },
      });
    const presentedBefore = limiters.DEVICE_SYNC_RATE_LIMIT!.keys.length;
    const stranger = `Device um_device_${crypto.randomUUID()}.${"A".repeat(43)}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const refused = await capabilities(stranger, "203.0.113.9");
      expect(refused.status).toBe(401);
      expect(await refused.json()).toMatchObject({ error: { code: "DEVICE_AUTH_INVALID" } });
    }
    const limited = await capabilities(stranger, "203.0.113.9");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toMatchObject({ error: { code: "ATTEMPT_LIMIT_REACHED" } });
    // A malformed bearer is charged before any credential work.
    const malformed = await capabilities("Device not-a-credential", "203.0.113.9");
    expect(malformed.status).toBe(429);
    expect((await capabilities("Device not-a-credential", "203.0.113.10")).status).toBe(401);
    // Only well-formed bearers reach the device-sync keys.
    expect(limiters.DEVICE_SYNC_RATE_LIMIT!.keys.length - presentedBefore).toBe(6);
    // Failed verifications alone do not lock out an authenticated device at
    // a shared address while that address is inside its device-sync budget.
    const valid = await capabilities(install.authorization, "203.0.113.9");
    expect(valid.status, await valid.clone().text()).toBe(200);
  });

  it("refuses a flood of well-formed bearers from one address before verification", async () => {
    const budget = 8;
    const limiters = productionLimiters({ DEVICE_SYNC_CLIENT_RATE_LIMIT: budget });
    const install = await newInstall();
    await negotiate(install, transport({ limiters, address: "198.51.100.1" }));
    const primary = countingDatabase(db());
    const ledger = countingDatabase(b.DELETION_LEDGER);
    const capabilities = (authorization: string, address: string) =>
      transport({ limiters, address, bindings: { USAGE_MONITOR_DB: primary.database, DELETION_LEDGER: ledger.database } })
        .fetch(`${origin}/api/v1/device/sync-capabilities-v1.2`, {
          headers: { accept: "application/json", authorization },
        });
    const flood = "203.0.113.50";
    const attemptsBefore = limiters.CLIENT_ATTEMPT_RATE_LIMIT!.keys.length;
    const locationBefore = limiters.DEVICE_SYNC_RATE_LIMIT!.keys.length;
    const codes: (string | null)[] = [];
    for (let attempt = 0; attempt < budget; attempt += 1) {
      const response = await capabilities(`Device um_device_${crypto.randomUUID()}.${"B".repeat(43)}`, flood);
      codes.push((await response.json<{ error?: { code?: string } }>()).error?.code ?? null);
    }
    // Inside the address budget each bearer is verified and its failure is
    // charged to the attempt budgets, which answer 429 after five.
    expect(codes).toEqual([...Array(5).fill("DEVICE_AUTH_INVALID"), ...Array(budget - 5).fill("ATTEMPT_LIMIT_REACHED")]);
    expect(limiters.CLIENT_ATTEMPT_RATE_LIMIT!.keys.length - attemptsBefore).toBe(budget);
    const verified = { primary: primary.statements(), ledger: ledger.statements() };
    expect(verified.primary).toBeGreaterThan(0);

    // Past the address budget every well-formed bearer, valid or not, is
    // refused before any D1 statement, attempt charge or location charge.
    for (const authorization of [
      `Device um_device_${crypto.randomUUID()}.${"C".repeat(43)}`,
      `Device um_device_${crypto.randomUUID()}.${"D".repeat(43)}`,
      install.authorization,
    ]) {
      const refused = await capabilities(authorization, flood);
      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toBe("60");
      expect(await refused.json()).toMatchObject({ error: { code: "DEVICE_SYNC_LIMIT_REACHED" } });
    }
    expect({ primary: primary.statements(), ledger: ledger.statements() }).toEqual(verified);
    expect(limiters.CLIENT_ATTEMPT_RATE_LIMIT!.keys.length - attemptsBefore).toBe(budget);
    expect(limiters.DEVICE_SYNC_RATE_LIMIT!.keys.length - locationBefore).toBe(budget);
    // Another address, and so the rest of the location, is unaffected.
    const elsewhere = await capabilities(install.authorization, "198.51.100.77");
    expect(elsewhere.status, await elsewhere.clone().text()).toBe(200);
  });

  it("paces an authenticated device at its own budget and sheds load before verification", async () => {
    const install = await newInstall();
    await negotiate(install, transport());
    const local = localIndex({ [dayOf(-1)]: 1 });
    const throttled = productionLimiters({ DEVICE_SYNC_PRINCIPAL_RATE_LIMIT: 3 });
    const net = transport({ limiters: throttled });
    const result = await accountlessPass(install, local, journal(), net);
    expect(result).toMatchObject({ status: "failed", failure: { code: "service_unavailable", retryable: true,
      deviceUnavailable: false, retryAfterMilliseconds: 60_000 } });
    expect(failures(net)).toEqual([expect.objectContaining({ status: 429, code: "DEVICE_SYNC_LIMIT_REACHED",
      retryAfter: "60" })]);

    const used = () => db().prepare("SELECT last_used_at FROM device_credentials WHERE id = ?")
      .bind(install.deviceId).first<string>("last_used_at");
    const before = await used();
    const shed = await transport({ limiters: productionLimiters({ DEVICE_SYNC_RATE_LIMIT: 0 }) })
      .fetch(`${origin}/api/v1/device/sync-capabilities-v1.2`, {
        headers: { accept: "application/json", authorization: install.authorization },
      });
    expect(shed.status).toBe(429);
    expect(await shed.json()).toMatchObject({ error: { code: "DEVICE_SYNC_LIMIT_REACHED" } });
    expect(await used()).toBe(before);
  });
});

describe("storage-constraint refusals", () => {
  it("answers an empty day on a role without 0012 with a paced refusal, and 0012 then refuses that role", async () => {
    await prepare({ withoutEmptyDays: true });
    const install = await newInstall();
    const local = localIndex({ [dayOf(-4)]: 2, [dayOf(-2)]: 1, [dayOf(-1)]: 3 });
    const progress = journal();
    const net = transport();
    const refused = await accountlessPass(install, local, progress, net);
    // The CHECK that 0012 widens refuses the first empty day. That is a schema
    // gap, not a storage outage: the answer is retryable and paced, so the
    // desktop scheduler waits at least the hour and at most its four-hour
    // interval, never pauses on it, and the pass keeps its journal.
    expect(refused).toMatchObject({ status: "failed", chunksUploaded: 1, failure: {
      code: "service_unavailable", retryable: true, deviceUnavailable: false, retryAfterMilliseconds: 3_600_000,
    } });
    expect(failures(net)).toEqual([expect.objectContaining({ method: "POST",
      path: "/api/v1/device/telemetry/v1.2/day-manifests", status: 503, code: "TELEMETRY_STORAGE_CONSTRAINT",
      retryAfter: "3600" })]);
    expect(progress.current()).not.toBeNull();
    expect(await count("SELECT count(*) n FROM telemetry_v12_day_manifests WHERE device_id = ?", install.deviceId)).toBe(1);

    // The day accepted before the refusal makes 0012's guard refuse the role,
    // which it leaves unchanged: this source must not serve a role without 0012.
    await expect(applyD1Migrations(db(), b.TEST_INGESTION_ISOLATION_MIGRATIONS)).rejects.toThrow();
    expect(await db().prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'telemetry_v12_day_manifests'")
      .first<string>("sql")).toContain("expected_chunk_count BETWEEN 1 AND 4096");
    expect(await count("SELECT count(*) n FROM telemetry_v12_day_manifests WHERE device_id = ?", install.deviceId)).toBe(1);
  });

  it("paces only SQLite constraint failures, never an outage or an already mapped answer", () => {
    for (const message of ["CHECK constraint failed: expected_chunk_count BETWEEN 1 AND 4096",
      "NOT NULL constraint failed: telemetry_v12_chunks.r2_key", "FOREIGN KEY constraint failed"]) {
      const refusal = telemetryV12StorageConstraintRefusal(new Error(`D1_ERROR: ${message}: SQLITE_CONSTRAINT`));
      expect({ status: refusal?.status, code: refusal?.code, retryAfter: new Headers(refusal?.responseHeaders ?? {})
        .get("retry-after") }, message).toEqual({ status: 503, code: "TELEMETRY_STORAGE_CONSTRAINT", retryAfter: "3600" });
    }
    expect(telemetryV12StorageConstraintRefusal(new Error("D1_ERROR: Network connection lost."))).toBeNull();
    expect(telemetryV12StorageConstraintRefusal(new ApiError(409, "TELEMETRY_MANIFEST_CONFLICT"))).toBeNull();
  });
});

describe("opt-out, eligibility and erasure of a domain that includes empty days", () => {
  async function uploadedWithEmptyDays(): Promise<{ install: Install; participantId: string; generationId: string }> {
    const install = await newInstall();
    const result = await accountlessPass(install, localIndex({ [dayOf(-2)]: 2 }), journal(), transport());
    expect(result).toMatchObject({ status: "complete", failure: null });
    expect(await count("SELECT count(*) n FROM telemetry_v12_day_manifests WHERE device_id = ? AND expected_chunk_count = 0",
      install.deviceId)).toBe(2);
    return { install, participantId: await participantOf(install), generationId: result.domainGenerationId! };
  }

  it("retains an eligible v1.2 head through an ordinary opt-out", async () => {
    const { install, participantId, generationId } = await uploadedWithEmptyDays();
    expect(await count("SELECT count(*) n FROM community_public_source_owners WHERE device_id = ?", install.deviceId)).toBe(1);
    const disconnect = await transport().fetch(`${origin}/api/v1/device/disconnect`, {
      method: "POST", headers: { authorization: install.authorization },
    });
    expect(disconnect.status, await disconnect.clone().text()).toBe(200);
    const marker = await db().prepare(`SELECT generation_id, head_revision, retained_at
        FROM accountless_public_history_retention WHERE participant_id = ?`).bind(participantId)
      .first<{ generation_id: string; head_revision: number; retained_at: string }>();
    expect(marker).toMatchObject({ generation_id: generationId, head_revision: 1 });
    expect(await db().prepare(`SELECT state, revocation_reason, revoked_at
        FROM accountless_v12_device_authorizations WHERE enrollment_device_id = ?`).bind(install.deviceId).first())
      .toEqual({ state: "revoked", revocation_reason: "user_opt_out", revoked_at: marker!.retained_at });
    // The retained v1.2 branch keeps the device's accepted history public.
    expect(await count("SELECT count(*) n FROM community_public_source_owners WHERE device_id = ?", install.deviceId)).toBe(1);
  });

  it("erases the owner and every v1.2 row through the ordinary owner erasure", async () => {
    const { install, participantId } = await uploadedWithEmptyDays();
    const retained = await uploadedWithEmptyDays();
    const owner = { ...b, ENVIRONMENT: "synthetic-development", ACCOUNT_SCOPED_INGEST_MODE: "disabled",
      ACCOUNTLESS_ENROLLMENT_MODE: "enabled", ACCOUNTLESS_OWNERSHIP_MODE: "enabled" } as Env;
    expect(await eraseParticipantAsOwner(owner, "e".repeat(64), participantId)).toMatchObject({ deleted: true });
    for (const table of ["telemetry_v12_day_manifests", "telemetry_v12_chunks", "telemetry_v12_domains",
      "telemetry_v12_domain_heads", "telemetry_v12_domain_predecessors", "storage_v12_event_sources"]) {
      expect(await count(`SELECT count(*) n FROM ${table} WHERE participant_id = ?`, participantId), table).toBe(0);
    }
    expect(await count("SELECT count(*) n FROM participants WHERE id = ?", participantId)).toBe(0);
    expect(await count("SELECT count(*) n FROM device_credentials WHERE id = ?", install.deviceId)).toBe(0);
    // Only the other owner's domain days, chunks and records remain.
    expect(await count(`SELECT count(*) n FROM telemetry_v12_domain_heads h
        JOIN telemetry_v12_domain_days d ON d.generation_id = h.generation_id WHERE h.participant_id = ?`,
      retained.participantId)).toBe(3);
    expect(await count("SELECT count(*) n FROM telemetry_v12_domain_days")).toBe(3);
    expect(await count("SELECT count(*) n FROM telemetry_v12_chunks")).toBe(1);
    expect(await count("SELECT count(*) n FROM telemetry_v12_records")).toBe(2);
  });

  it("suppresses a restored owner through deletion-tombstone replay", async () => {
    const { participantId } = await uploadedWithEmptyDays();
    expect((await b.QUARANTINE.list()).objects.length).toBeGreaterThan(0);
    await recordDeletionTombstone(b.DELETION_LEDGER, participantId);
    expect(await replayDeletionTombstones(db(), b.DELETION_LEDGER, b.QUARANTINE))
      .toEqual({ suppressed: 1, complete: true });
    expect(await count("SELECT count(*) n FROM participants WHERE id = ?", participantId)).toBe(0);
    for (const table of ["telemetry_v12_day_manifests", "telemetry_v12_chunks", "telemetry_v12_records",
      "telemetry_v12_domain_days", "telemetry_v12_domains", "telemetry_v12_domain_heads"]) {
      expect(await count(`SELECT count(*) n FROM ${table}`), table).toBe(0);
    }
    expect((await b.QUARANTINE.list()).objects).toHaveLength(0);
  });
});

/** One complete pass of today's records, then an ordinary opt-out: the v1.2
 * head is retained under a marker and the v1.2 grant is revoked with it. */
async function optOutAfterUpload(): Promise<{ deviceId: string; participantId: string; generationId: string; retainedAt: string }> {
  const install = await newInstall();
  const net = transport();
  const result = await accountlessPass(install, localIndex({ [dayOf(0)]: 2 }), journal(), net);
  expect({ result, failures: failures(net) }).toMatchObject({ result: { status: "complete" }, failures: [] });
  const disconnect = await transport().fetch(`${origin}/api/v1/device/disconnect`, {
    method: "POST", headers: { authorization: install.authorization },
  });
  expect(disconnect.status, await disconnect.clone().text()).toBe(200);
  const participantId = await participantOf(install);
  const head = await db().prepare("SELECT generation_id FROM telemetry_v12_domain_heads WHERE participant_id = ?")
    .bind(participantId).first<{ generation_id: string }>();
  const marker = await db().prepare(`SELECT generation_id, head_revision, retained_at
      FROM accountless_public_history_retention WHERE participant_id = ?`)
    .bind(participantId).first<{ generation_id: string; head_revision: number; retained_at: string }>();
  expect(marker).toMatchObject({ generation_id: head!.generation_id, head_revision: 1 });
  expect(await db().prepare(`SELECT state, revocation_reason, revoked_at
      FROM accountless_v12_device_authorizations WHERE enrollment_device_id = ?`).bind(install.deviceId).first())
    .toEqual({ state: "revoked", revocation_reason: "user_opt_out", revoked_at: marker!.retained_at });
  return { deviceId: install.deviceId, participantId,
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
