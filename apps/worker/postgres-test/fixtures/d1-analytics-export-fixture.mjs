/**
 * Synthetic sealed D1 exports for the D1 analytics export oracle.
 *
 * Three SQLite files (ingestion, analytics, ledger) are built exactly the way a
 * Worker deployment builds its D1 databases: the ingestion-role migration
 * directories in `scripts/d1-storage-plan.mjs` order (with the Worker's own
 * initializers between them, as the Worker specs apply them), the complete
 * `analytics-migrations` directory and the deletion-ledger migrations. Every
 * row after that is written by the Worker's own functions over the sealed
 * SQLite D1 adapter: accountless and social enrollment, v1, v1.1 and v1.2
 * uploads, ordered delivery, daily publication, the graph lane, the
 * cache-retention lane and an owner erasure that contains a published day.
 *
 * All identifiers are random or synthetic. No record carries prompts,
 * responses, paths, commands or any real account. The returned
 * `privateIdentifiers` exist only so the spec can prove that none of them
 * reaches the oracle output.
 */

import { chmod, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalTelemetryV11Json,
  canonicalTelemetryV12Json,
  telemetryV11DomainManifestDigestInput,
  telemetryV12DayManifestDigestInput,
  telemetryV12DomainManifestDigestInput,
  telemetryV12RequiredConsent,
} from "@app-usagemonitor/telemetry-contract";
import { openSealedSqliteD1 } from "../../cloud-run/sealed-sqlite-d1-adapter.mjs";
import { createV11DeviceFixture, makeV11Day, v11UsageRecord } from "../../test/helpers/telemetry-v11.ts";
import { enrollAccountlessDevice, parseAccountlessEnrollmentRequest } from "../../src/accountless-enrollment.ts";
import { createAccountlessUploadOwner, parseAccountlessOwnershipRequest } from "../../src/accountless-ownership.ts";
import { initializeStorageSource } from "../../src/analytics-delivery.ts";
import { drainCommunityPublicSourceBootstrap } from "../../src/community-daily-aggregates.ts";
import { encodeBase64Url, sha256Hex } from "../../src/crypto.ts";
import {
  authenticateDevice,
  claimDeviceUploadAuthorization,
  createDeviceUploadAuthorization,
} from "../../src/device-auth.ts";
import { eraseParticipantAsOwner } from "../../src/participant-erasure.ts";
import { putTrackedQuarantineObject } from "../../src/quarantine-reconciliation.ts";
import {
  advanceCacheRetentionDayLane,
  createCacheRetentionDaySourceBuild,
} from "../../src/cache-retention-day.ts";
import { advanceStorageErasureJobs } from "../../src/storage-erasure.ts";
import {
  advanceStorageAnalytics,
  initializeStorageAnalyticsRuntime,
} from "../../src/storage-analytics-runtime.ts";
import {
  advanceNextStorageCommunityDaily,
  retireStorageCommunityDailyPage,
} from "../../src/storage-community-daily.ts";
import { advanceStorageCommunityGraphWork } from "../../src/storage-community-graph-work.ts";
import {
  publishStorageCommunityGraphPreview,
  publishStorageCommunityModelDay,
  retireStorageCommunityGraphPublications,
} from "../../src/storage-community-graph-publication.ts";
import { grantTelemetryV12AccountlessAuthorization } from "../../src/telemetry-transport-policy.ts";
import { parseTelemetryV1Chunk } from "../../src/telemetry-v1.ts";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from "../../src/telemetry-v11-domain.ts";
import { registerTelemetryV11DayManifest, telemetryV11LegacyProjection } from "../../src/telemetry-v11-repository.ts";
import { activateTelemetryV12Domain, createTelemetryV12DomainPredecessor } from "../../src/telemetry-v12-domain.ts";
import { persistTelemetryV12StagedChunk, registerTelemetryV12DayManifest } from "../../src/telemetry-v12-repository.ts";
import { initializeTypedV1Admission, insertTypedTelemetryV1Chunk } from "../../src/typed-v1-admission.ts";
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../../src/typed-v11-admission.ts";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const D1_EXPORT_FIXTURE_SOURCE_ID = "synthetic-export-source";
export const D1_EXPORT_FIXTURE_NAMESPACE = "synthetic-export-namespace";
const DAY_MS = 86_400_000;
const ADMIN_ACTOR = "e".repeat(64);

/** The ingestion-role order of `scripts/d1-storage-plan.mjs`. */
const INGESTION_DIRECTORIES = Object.freeze([
  "migrations",
  "typed-ingestion-migrations",
  "ingestion-bridge-migrations",
  "typed-v11-admission-migrations",
  "typed-v1-admission-migrations",
  "ingestion-isolation-migrations",
]);

export function fixtureDay(pinnedNowMs, offsetDays) {
  const today = Date.parse(new Date(pinnedNowMs).toISOString().slice(0, 10));
  return new Date(today - offsetDays * DAY_MS).toISOString().slice(0, 10);
}

async function migrationFiles(directory) {
  const root = join(WORKER_ROOT, directory);
  return (await readdir(root)).filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/u.test(name)).sort()
    .map((name) => ({ name, path: join(root, name) }));
}

/** Wrangler's migration ledger and transaction: a migration is one atomic
 * unit, so its connection-level PRAGMAs behave exactly as they do in D1. */
async function applyMigrations(database, directory) {
  await database.exec(`CREATE TABLE IF NOT EXISTS d1_migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`);
  for (const file of await migrationFiles(directory)) {
    const sql = await readFile(file.path, "utf8");
    await database.exec(`BEGIN IMMEDIATE;\n${sql}\n;INSERT INTO d1_migrations(name) VALUES('${file.name}');\nCOMMIT;`)
      .catch(async (error) => {
        await database.exec("ROLLBACK").catch(() => {});
        throw error;
      });
  }
}

function inertObjectStore() {
  const objects = new Map();
  return {
    objects,
    async put(key, value) { objects.set(key, typeof value === "string" ? value.length : 0); return { key }; },
    async delete(keys) { for (const key of [].concat(keys)) objects.delete(key); },
    async head(key) { return objects.has(key) ? { key } : null; },
    async get() { return null; },
    async list() { return { objects: [], truncated: false }; },
  };
}

async function deviceSecret(deviceId) {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const prefix = new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`);
  const bytes = new Uint8Array(prefix.length + secret.length);
  bytes.set(prefix); bytes.set(secret, prefix.length);
  const deviceSecretHash = await sha256Hex(bytes);
  const authorization = `Device um_device_${deviceId}.${encodeBase64Url(secret)}`;
  bytes.fill(0); secret.fill(0);
  return { deviceSecretHash, authorization };
}

async function accountlessOwner(ctx, telemetrySchemaVersion) {
  const deviceId = crypto.randomUUID();
  const { deviceSecretHash, authorization } = await deviceSecret(deviceId);
  // The routes' own parsers produce the typed requests the handlers take.
  await enrollAccountlessDevice(ctx.ingestion, parseAccountlessEnrollmentRequest({
    schemaVersion: "accountless-enrollment-v0.1", deviceId, deviceSecretHash,
    policyVersion: "accountless-opt-out-v1", authorizationBasis: "accountless-policy-v1" }));
  await createAccountlessUploadOwner(ctx.ingestion, authorization, parseAccountlessOwnershipRequest({
    schemaVersion: "accountless-upload-owner-v0.1", policyVersion: "accountless-opt-out-v1",
    authorizationBasis: "accountless-policy-v1", telemetrySchemaVersion: "telemetry-contribution-v1.1" }));
  const participantId = await ctx.ingestion.prepare(
    "SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=?")
    .bind(deviceId).first("participant_id");
  if (telemetrySchemaVersion === "telemetry-contribution-v1.2") {
    await grantTelemetryV12AccountlessAuthorization(ctx.ingestion, { participantId, deviceId }, {
      schemaVersion: "accountless-upload-owner-v1.2", policyVersion: "accountless-telemetry-v1.2-policy-v1",
      authorizationBasis: "accountless-policy-v1.2", telemetrySchemaVersion: "telemetry-contribution-v1.2" });
  }
  ctx.privateIdentifiers.push(participantId, deviceId);
  return { participantId, deviceId, authorization };
}

async function claimedUpload(ctx, authorization, label) {
  const envelopeDigest = await sha256Hex(`${label}:${crypto.randomUUID()}`);
  const device = await authenticateDevice(ctx.ingestion, authorization);
  const upload = await createDeviceUploadAuthorization(ctx.ingestion, device, envelopeDigest, 4096);
  const claimed = await claimDeviceUploadAuthorization(ctx.ingestion, `Upload ${upload.uploadAuthorization}`,
    { envelopeDigest, bodyBytes: 4096, contentType: "application/json" });
  return { envelopeDigest, authorizationId: claimed.authorizationId };
}

/** Complete accountless v1.1 days, activated as one domain through today. */
async function uploadV11Days(ctx, owner, dayEvents) {
  const principal = { participantId: owner.participantId, deviceId: owner.deviceId };
  const registeredDays = [];
  // A domain names every day from its first through today; days without
  // records carry empty day manifests.
  const byDay = new Map(dayEvents.map(({ day, events }) => [day, events]));
  const first = [...byDay.keys()].sort()[0];
  const through = fixtureDay(ctx.pinnedNowMs, 0);
  const allDays = [];
  for (let at = Date.parse(first); at <= Date.parse(through); at += DAY_MS) {
    allDays.push(new Date(at).toISOString().slice(0, 10));
  }
  for (const day of allDays) {
    const events = byDay.get(day) ?? [];
    const prepared = await makeV11Day(day, events.length === 0 ? {} : { usage: events.map((n) =>
      v11UsageRecord(day, "a", { eventId: `event:v2:${n.toString(16).padStart(64, "0")}`,
        eventTime: `${day}T${String(8 + (n % 10)).padStart(2, "0")}:${String((n * 7) % 60).padStart(2, "0")}:00.000Z` })) });
    await registerTelemetryV11DayManifest(ctx.ingestion, principal, prepared.manifest);
    for (const chunk of prepared.chunks) {
      const claimed = await claimedUpload(ctx, owner.authorization, "synthetic-v11");
      await persistTypedV11StagedChunk(ctx.ingestion, principal, chunk, { sourceNamespace: ctx.sourceNamespace,
        chunkRowId: `chunk:${crypto.randomUUID()}`, r2Key: `synthetic/${crypto.randomUUID()}`,
        envelopeDigest: claimed.envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId });
    }
    const registered = await registerTelemetryV11DayManifest(ctx.ingestion, principal, prepared.manifest);
    registeredDays.push({ day: registered.day, manifestId: registered.manifestId,
      manifestDigest: registered.manifestDigest });
  }
  registeredDays.sort((left, right) => left.day < right.day ? -1 : left.day > right.day ? 1 : 0);
  const prior = await createTelemetryV11DomainPredecessor(ctx.ingestion, principal, ctx.pinnedNowMs);
  const manifest = { schemaVersion: "telemetry-domain-manifest-v1.1", fromDay: registeredDays[0].day,
    throughDay: through,
    predecessor: { token: prior.token, previousGenerationId: prior.previousGenerationId,
      legacyFingerprint: prior.legacyFingerprint },
    days: registeredDays, manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  await activateTelemetryV11Domain(ctx.ingestion, principal, manifest, ctx.pinnedNowMs);
}

function v1Records(stream, day, count, seq) {
  return Array.from({ length: count }, (_, index) => {
    const n = seq * 200 + index;
    if (stream === "usage") {
      return JSON.parse(telemetryV11LegacyProjection("usage", v11UsageRecord(day, "a", {
        eventId: `event:v2:${(0x10_0000 + n).toString(16).padStart(64, "0")}`,
        eventTime: `${day}T${String(9 + (index % 9)).padStart(2, "0")}:${String((index * 11) % 60).padStart(2, "0")}:00.000Z`,
        modelId: index % 2 === 0 ? "gpt-5.6-sol" : "gpt-5.5",
      })).canonicalRecord);
    }
    if (stream === "quota") {
      return { schemaVersion: "quota-observation-v1.0",
        observationId: `quota-occurrence:v1:${(0x20_0000 + n).toString(16).padStart(64, "0")}`,
        observedTime: `${day}T${String(10 + index).padStart(2, "0")}:00:00.000Z`, provider: "openai_codex",
        planType: "pro", planVariant: "unknown", limitId: "codex", slot: "secondary",
        usedPercent: 0.25 + index / 100, windowDurationMinutes: 10080, resetsAt: `${day}T23:00:00.000Z` };
    }
    return { schemaVersion: "session-dimension-v1.0", sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
      firstEventTime: `${day}T09:00:00.000Z`, provider: "openai_codex", toolClassCounts: { shell: 0, other: 3 } };
  });
}

/** One accepted typed v1 chunk of a paired social device. */
async function uploadV1Chunk(ctx, device, { stream, day, count, seq }) {
  const records = v1Records(stream, day, count, seq);
  const claimed = await claimedUpload(ctx, device.authorization, "synthetic-v1");
  const chunk = parseTelemetryV1Chunk({ schemaVersion: "telemetry-contribution-v1.0", chunkId: `${stream}:${day}:${seq}`,
    chunkRevision: 1, chunkDigest: await sha256Hex(canonicalTelemetryV11Json(records)), parserVersion: "synthetic-export-v1",
    consent: { telemetrySchemaVersion: "telemetry-contribution-v1.0",
      fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0" }, records });
  await insertTypedTelemetryV1Chunk(ctx.ingestion, { chunkRowId: `chunk:${crypto.randomUUID()}`,
    participantId: device.participantId, deviceId: device.deviceId, chunk,
    envelopeDigest: claimed.envelopeDigest, r2Key: `synthetic/v1-${crypto.randomUUID()}`,
    deviceUploadAuthorizationId: claimed.authorizationId, createdAt: new Date().toISOString(), supersedes: null },
  ctx.sourceNamespace);
}

async function socialV1Device(ctx) {
  const device = await createV11DeviceFixture(ctx.ingestion);
  ctx.privateIdentifiers.push(device.participantId, device.deviceId);
  return device;
}

function v12UsageRecord(day, n) {
  return {
    schemaVersion: "usage-event-v1.2", eventId: `event:v2:${(0x30_0000 + n).toString(16).padStart(64, "0")}`,
    eventTime: `${day}T${String(11 + (n % 8)).padStart(2, "0")}:05:00.000Z`,
    sessionUuid: "1b49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
    provider: "openai_codex", modelId: "gpt-5.6-sol", speedMode: "standard", apiServiceTier: "default",
    surface: "local_interactive_unclassified", billingSurface: "chatgpt_subscription", reasoningEffort: "high",
    agentScope: "root", outcome: "completed", totalInputContextTokens: 2000,
    components: { inputUncachedTokens: 200, inputCacheReadTokens: 1800, inputCacheWriteTokens: 0,
      outputTextTokens: 60, outputReasoningTokens: 30, outputCombinedTokens: null },
    accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null, planBasis: "same_source_occurrence",
      planType: "pro", planEraId: null },
    boundaryFlags: null, tieOrder: null, cacheWriteTtl: null,
  };
}

/** One complete v1.2 day, admitted in the upload route's order. */
async function uploadV12Day(ctx, owner, day, eventNumbers) {
  const principal = { participantId: owner.participantId, deviceId: owner.deviceId, authorization: owner.authorization };
  const consent = telemetryV12RequiredConsent(), parserVersion = "synthetic-export-v12";
  const records = eventNumbers.map((n) => v12UsageRecord(day, n));
  const chunk = { schemaVersion: "telemetry-contribution-v1.2", manifestDigest: "0".repeat(64),
    chunkId: `usage:${day}:0`, chunkRevision: 1, parserVersion, consent, records: [...records],
    chunkDigest: await sha256Hex(canonicalTelemetryV12Json(records)) };
  const manifest = { schemaVersion: "telemetry-day-manifest-v1.2", day, parserVersion, consent,
    chunks: [{ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: records.length }],
    excluded: { quota: 0, session: 0, usage: 0 }, manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = await sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  const registered = await registerTelemetryV12DayManifest(ctx.ingestion, principal, manifest);
  chunk.manifestDigest = manifest.manifestDigest;
  const claimed = await claimedUpload(ctx, owner.authorization, "synthetic-v12");
  const chunkRowId = `chunk:${crypto.randomUUID()}`, r2Key = `telemetry/v12-export/${crypto.randomUUID()}`;
  await putTrackedQuarantineObject(ctx.ingestion, ctx.objects, { contributionId: chunkRowId, objectKind: "telemetry",
    r2Key, registeredAt: new Date().toISOString() }, "synthetic v1.2 bytes");
  await persistTelemetryV12StagedChunk(ctx.ingestion, principal, chunk, { chunkRowId, r2Key,
    envelopeDigest: claimed.envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId });
  const predecessor = await createTelemetryV12DomainPredecessor(ctx.ingestion, principal);
  const domain = { schemaVersion: "telemetry-domain-manifest-v1.2", fromDay: day, throughDay: day,
    predecessor: { token: predecessor.token, previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint },
    days: [{ day, manifestId: registered.manifestId, manifestDigest: manifest.manifestDigest }],
    manifestDigest: "0".repeat(64) };
  domain.manifestDigest = await sha256Hex(telemetryV12DomainManifestDigestInput(domain));
  await activateTelemetryV12Domain(ctx.ingestion, principal, domain);
}

function bindings(ctx) {
  return { source: ctx.ingestion, target: ctx.analytics, sourceId: ctx.sourceId, sourceNamespace: ctx.sourceNamespace };
}

/** Ordered delivery, erasure jobs and daily publication until every lane is idle. */
async function settle(ctx) {
  for (let n = 0; n < 64; n += 1) {
    if ((await drainCommunityPublicSourceBootstrap(ctx.ingestion)).completed) break;
  }
  for (let round = 0; round < 8; round += 1) {
    let delivered = false;
    for (let n = 0; n < 512; n += 1) {
      const step = await advanceStorageAnalytics(bindings(ctx));
      if (step.state === "idle") break;
      delivered = true;
    }
    for (let n = 0; n < 16; n += 1) {
      if (!(await advanceStorageErasureJobs({ ...bindings(ctx), ledger: ctx.ledger })).pending) break;
    }
    let published = false;
    for (const preferStaleHead of [false, true]) {
      for (let n = 0; n < 256; n += 1) {
        const daily = await advanceNextStorageCommunityDaily({ ...bindings(ctx), preferStaleHead, nowMs: ctx.nowMs() });
        if (daily.state === "idle") break;
        published = true;
      }
    }
    for (let n = 0; n < 16; n += 1) if ((await retireStorageCommunityDailyPage(bindings(ctx))) === 0) break;
    if (!delivered && !published) return;
  }
  throw new Error("D1_EXPORT_FIXTURE_NOT_SETTLED");
}

/** The analytics Worker's graph lane at the pinned time, for a bounded number
 * of steps: the current fits, today's model and the newest historical days. */
async function runGraphLane(ctx, steps) {
  for (let n = 0; n < steps; n += 1) {
    const graph = await advanceStorageCommunityGraphWork({ ...bindings(ctx), nowMs: ctx.pinnedNowMs,
      preparedFold: false });
    if ((graph.state === "complete" || graph.state === "reused")) {
      if (graph.metric === "model" && graph.day) {
        await publishStorageCommunityModelDay(bindings(ctx), { day: graph.day, nowMs: ctx.pinnedNowMs });
      }
      await publishStorageCommunityGraphPreview(bindings(ctx), { nowMs: ctx.pinnedNowMs });
    }
    await retireStorageCommunityGraphPublications(bindings(ctx), ctx.pinnedNowMs);
  }
}

async function runCacheRetention(ctx, fromDay) {
  for (let n = 0; n < 256; n += 1) {
    const lane = await advanceCacheRetentionDayLane({ target: ctx.analytics, sourceId: ctx.sourceId,
      build: createCacheRetentionDaySourceBuild({ source: ctx.ingestion, target: ctx.analytics,
        sourceNamespace: ctx.sourceNamespace, now: () => ctx.pinnedNowMs }),
      deadlineMs: ctx.pinnedNowMs + 1, remainingQueries: 5_000, sourceQueries: 5_000, maxDays: 64,
      maxWrites: 64, now: () => ctx.pinnedNowMs, shardIndex: 0, shardCount: 1,
      ...(fromDay === null ? {} : { fromDay }) });
    if (lane.state === "idle") return;
  }
  throw new Error("D1_EXPORT_FIXTURE_CACHE_RETENTION_NOT_SETTLED");
}

/**
 * Build the three sealed files under `directory` (an existing, private,
 * resolved directory). `pinnedNowMs` is the drain instant the oracle is later
 * pinned to; it defaults to the build time.
 */
export async function buildD1AnalyticsExportFixture({ directory, pinnedNowMs = Date.now(), graphSteps = 48,
  cacheRetentionFromDay = null } = {}) {
  const root = await realpath(directory);
  const paths = { ingestion: join(root, "ingestion.sqlite"), analytics: join(root, "analytics.sqlite"),
    ledger: join(root, "ledger.sqlite") };
  const handles = {
    ingestion: openSealedSqliteD1(paths.ingestion, { create: true }),
    analytics: openSealedSqliteD1(paths.analytics, { create: true }),
    ledger: openSealedSqliteD1(paths.ledger, { create: true }),
  };
  const ctx = {
    ingestion: handles.ingestion.database, analytics: handles.analytics.database, ledger: handles.ledger.database,
    sourceId: D1_EXPORT_FIXTURE_SOURCE_ID, sourceNamespace: D1_EXPORT_FIXTURE_NAMESPACE,
    pinnedNowMs, nowMs: () => pinnedNowMs, objects: inertObjectStore(), privateIdentifiers: [],
  };
  const days = { today: fixtureDay(pinnedNowMs, 0), yesterday: fixtureDay(pinnedNowMs, 1),
    twoDaysAgo: fixtureDay(pinnedNowMs, 2), threeDaysAgo: fixtureDay(pinnedNowMs, 3) };
  try {
    for (const directoryName of INGESTION_DIRECTORIES.slice(0, 4)) await applyMigrations(ctx.ingestion, directoryName);
    await applyMigrations(ctx.analytics, "analytics-migrations");
    await applyMigrations(ctx.ledger, "deletion-ledger-migrations");
    await initializeStorageSource(ctx.ingestion, ctx.sourceId);
    await applyMigrations(ctx.ingestion, INGESTION_DIRECTORIES[4]);
    await initializeTypedV11Admission(ctx.ingestion, ctx.sourceNamespace);
    await initializeTypedV1Admission(ctx.ingestion, ctx.sourceNamespace);
    await applyMigrations(ctx.ingestion, INGESTION_DIRECTORIES[5]);
    await initializeStorageAnalyticsRuntime(bindings(ctx));
    // Deployment configuration the Worker specs also set: the accepted v1.1
    // transport and the active v1.2 successor runtime.
    await ctx.ingestion.prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
    await ctx.ingestion.prepare("UPDATE telemetry_v12_runtime SET state='active',changed_at=? WHERE id=1")
      .bind(new Date(pinnedNowMs).toISOString()).run();

    // v1.1 accountless owner with two closed days and today.
    const v11 = await accountlessOwner(ctx, "telemetry-contribution-v1.1");
    await uploadV11Days(ctx, v11, [{ day: days.twoDaysAgo, events: [1, 2, 3] },
      { day: days.yesterday, events: [4, 5] }]);
    // v1 social owner with usage, quota and session streams.
    const v1 = await socialV1Device(ctx);
    await uploadV1Chunk(ctx, v1, { stream: "usage", day: days.yesterday, count: 3, seq: 0 });
    await uploadV1Chunk(ctx, v1, { stream: "quota", day: days.yesterday, count: 2, seq: 0 });
    await uploadV1Chunk(ctx, v1, { stream: "session", day: days.yesterday, count: 1, seq: 0 });
    await uploadV1Chunk(ctx, v1, { stream: "usage", day: days.twoDaysAgo, count: 2, seq: 1 });
    // v1.2 accountless successor owner.
    const v12 = await accountlessOwner(ctx, "telemetry-contribution-v1.2");
    await uploadV12Day(ctx, v12, days.today, [1, 2, 3, 4]);
    // A v1 owner whose erasure later contains the day it folded.
    const erased = await socialV1Device(ctx);
    await uploadV1Chunk(ctx, erased, { stream: "usage", day: days.threeDaysAgo, count: 2, seq: 3 });
    await settle(ctx);
    await runGraphLane(ctx, graphSteps);
    await runCacheRetention(ctx, cacheRetentionFromDay);

    // Erasure: the terminal is journaled, delivered, the erasure job completes
    // and the contained day is republished for its smaller cohort.
    const env = { USAGE_MONITOR_DB: ctx.ingestion, DELETION_LEDGER: ctx.ledger, QUARANTINE: ctx.objects,
      ANALYTICS_DB: ctx.analytics, TELEMETRY_STORAGE_MODE: "typed", TELEMETRY_STORAGE_NAMESPACE: ctx.sourceNamespace,
      ENVIRONMENT: "synthetic-development" };
    // The first request deletes the participant and journals the terminal;
    // the owner's analytics payload spans more than one bounded retirement
    // page, so it answers unavailable and the storage-erasure lane finishes
    // the job. The owner's retry then proves durable completion.
    await eraseParticipantAsOwner(env, ADMIN_ACTOR, erased.participantId).catch((error) => {
      if (error?.code !== "BACKEND_STORAGE_UNAVAILABLE") throw error;
    });
    await settle(ctx);
    const retried = await eraseParticipantAsOwner(env, ADMIN_ACTOR, erased.participantId);
    if (retried.deleted !== true) throw new Error("D1_EXPORT_FIXTURE_ERASURE_INCOMPLETE");
    await settle(ctx);
    // The terminal retired every model day pinned below it; the graph lane
    // republishes the newest days for the smaller cohort.
    await runGraphLane(ctx, graphSteps);

    // Late inputs after the historical model days were published: a new
    // owner joins and an existing owner restates yesterday. D1 keeps serving
    // those model days (their validity is authority-only), so the oracle's
    // forced recompute records the difference as D1 recompute drift. The
    // restated day also gives yesterday a second daily revision.
    const late = await socialV1Device(ctx);
    await uploadV1Chunk(ctx, late, { stream: "usage", day: days.yesterday, count: 2, seq: 4 });
    await uploadV1Chunk(ctx, v1, { stream: "usage", day: days.yesterday, count: 4, seq: 2 });
    await settle(ctx);
    await runGraphLane(ctx, 6);
    await runCacheRetention(ctx, cacheRetentionFromDay);
    await settle(ctx);

    const ownerDigests = (await ctx.ingestion.prepare("SELECT owner_digest FROM storage_owner_revisions ORDER BY owner_digest")
      .all()).results.map((row) => row.owner_digest);
    const journalLength = await ctx.ingestion.prepare("SELECT count(*) AS n FROM storage_ingestion_changes").first("n");
    return {
      paths, sourceId: ctx.sourceId, sourceNamespace: ctx.sourceNamespace, pinnedNowMs, days,
      cacheRetentionFromDay, journalLength,
      privateIdentifiers: [...new Set([...ctx.privateIdentifiers, ...ownerDigests])],
    };
  } finally {
    handles.ingestion.close();
    handles.analytics.close();
    handles.ledger.close();
    for (const path of Object.values(paths)) await chmod(path, 0o400).catch(() => {});
  }
}
