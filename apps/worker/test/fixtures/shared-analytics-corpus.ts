import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import {
  canonicalTelemetryV12Json,
  telemetryV11DomainManifestDigestInput,
  telemetryV12DayManifestDigestInput,
  telemetryV12DomainManifestDigestInput,
  telemetryV12RequiredConsent,
  type TelemetryV11DomainManifest,
  type TelemetryV12Chunk,
  type TelemetryV12DayManifest,
  type TelemetryV12Record,
  type TelemetryV12UsageEvent,
  type TelemetryV12QuotaObservation,
} from "@app-usagemonitor/telemetry-contract";
import { initializeStorageSource } from "../../src/analytics-delivery";
import { drainCommunityPublicSourceBootstrap } from "../../src/community-daily-aggregates";
import { canonicalJson } from "../../src/canonical-json";
import { encodeBase64Url, sha256Hex } from "../../src/crypto";
import { enrollAccountlessDevice, parseAccountlessEnrollmentRequest } from "../../src/accountless-enrollment";
import { createAccountlessUploadOwner, parseAccountlessOwnershipRequest } from "../../src/accountless-ownership";
import { authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization } from "../../src/device-auth";
import { initializeStorageAnalyticsRuntime } from "../../src/storage-analytics-runtime";
import { readStorageCommunityOwnerPage, type StorageCommunityOwner } from "../../src/storage-community-authority";
import { currentTelemetryV1Chunk } from "../../src/telemetry-v1-repository";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from "../../src/telemetry-v11-domain";
import { registerTelemetryV11DayManifest } from "../../src/telemetry-v11-repository";
import { telemetryV11LegacyProjection } from "../../src/telemetry-v11-compatibility";
import { activateTelemetryV12Domain, createTelemetryV12DomainPredecessor } from "../../src/telemetry-v12-domain";
import { persistTelemetryV12StagedChunk, registerTelemetryV12DayManifest } from "../../src/telemetry-v12-repository";
import { parseTelemetryV1Chunk, type TelemetryV1UsageEvent } from "../../src/telemetry-v1";
import { grantTelemetryV12Consent, grantTelemetryV12AccountlessAuthorization } from "../../src/telemetry-transport-policy";
import { initializeTypedV1Admission, insertTypedTelemetryV1Chunk } from "../../src/typed-v1-admission";
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../../src/typed-v11-admission";
import { createV11DeviceFixture, makeV11Day, v11UsageRecord } from "../helpers/telemetry-v11";
import { MODEL_HISTORY_TEST_CAPACITIES, pricedModelHistoryUsage } from "../helpers/model-history";

/** Synthetic, content-free local D1 corpus. No live bindings, R2 objects, or telemetry are read. */
export interface SharedAnalyticsCorpusMigrations {
  TEST_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
  TEST_ANALYTICS_MIGRATIONS: D1Migration[];
}

export interface SharedAnalyticsCorpusOptions {
  source: D1Database;
  target: D1Database;
  sourceId: string;
  sourceNamespace: string;
  /** Integrated harnesses derive target authority from real delivery receipts. */
  targetAuthority?: "fixture-direct" | "ordered-delivery";
  /** Local lifecycle qualification only; the ordinary social corpus is unchanged. */
  secondaryOwnerKind?: "social" | "accountless";
  /** Default 130: the last 30 dates each have a complete 101-date predecessor window. */
  calendarDays?: number;
  graphDays?: number;
  anchorDay?: string;
  /** Opt-in full quota and usage occupancy over the calendar horizon. */
  denseDays?: boolean;
  /** Additional content-free usage rows on the first selected graph day. */
  denseUsageRows?: number;
  /** Opt-in accepted same-ID variants on two source days for link invalidation tests. */
  crossDayLinks?: boolean;
  /** Make mutateCorrection replace priced fit evidence as well as the sparse dependency. */
  correctionAffectsModelFit?: boolean;
}

export interface SharedAnalyticsCorpus {
  owner: StorageCommunityOwner & { ownerDigest: string };
  readonly participantId: string;
  /** Private laboratory coordinates, never included in aggregate receipts. */
  readonly secondaryAccountless?: { participantId: string; enrollmentDeviceId: string };
  readonly historyDates: readonly string[];
  readonly graphDates: readonly string[];
  readonly firstGraphLookbackDates: readonly string[];
  readonly populatedDates: readonly string[];
  readonly equivalentOccurrenceId: string;
  readonly equivalentDay: string;
  readonly correctionOccurrenceId: string;
  readonly correctionDay: string;
  /** Only present when crossDayLinks is enabled; shares correctionOccurrenceId. */
  readonly crossDayLinkDay?: string;
  readonly sessionDay: string;
  /** v1.1 closure includes empty UTC days through this actual fixture clock day. */
  readonly v11DomainThroughDay: string;
  readonly duplicateAcrossOwnersOccurrenceId: string;
  readonly modelFitDates: readonly string[];
  /** Private coordinates of records actually staged above; no extra admission. */
  readonly functionalInputs: {usage:{day:string;occurrenceId:string};quota?:{day:string;occurrenceId:string};emptyDay?:string;crossDayDestination:string};
  /** Activates a replacement v1.2 domain day, then returns the current owner CAS pin. */
  mutateCorrection(): Promise<StorageCommunityOwner & { ownerDigest: string }>;
  /** Accepts a new v1.1 event on the current fixture day, outside historical model windows. */
  appendOutsideV11(): Promise<StorageCommunityOwner & { ownerDigest: string }>;
  /** Accepts a replacement v1.1 manifest on an already retained fixture day. */
  appendV11Day(day: string): Promise<StorageCommunityOwner & { ownerDigest: string }>;
}

type Device = Pick<Awaited<ReturnType<typeof createV11DeviceFixture>>, "participantId" | "deviceId" | "authorization">;
type V11Ready = Awaited<ReturnType<typeof registerTelemetryV11DayManifest>>;
type V12Ready = Awaited<ReturnType<typeof registerTelemetryV12DayManifest>>;
const DAY_MS = 86_400_000;
const SESSION = "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b";
const SECOND_MODEL_SESSION = "e46332ab-4fd4-4f52-90d2-1445b0af46f2";
const CACHE_SESSION = "451107ee-f4b5-4124-98f9-78a4e2446e4a";
const TRACK = `account-track:v2:${"f".repeat(64)}`;
const id = (number: number) => `event:v2:${number.toString(16).padStart(64, "0")}`;
const date = (epoch: number) => new Date(epoch).toISOString().slice(0, 10);
const midnight = (day: string) => Date.parse(`${day}T00:00:00.000Z`);
const at = (day: string, hour: number) => new Date(midnight(day) + hour * 3_600_000).toISOString();
const digest = (label: string) => sha256Hex(`synthetic-shared-analytics-corpus:${label}`);
const attribution = () => ({ accountBasis: "same_source" as const, accountTrackId: TRACK,
  planBasis: "same_source_occurrence" as const, planType: "pro" as const, planEraId: null });
const legacyRecord = (day: string, occurrenceId: string, knownTotals: boolean) => v11UsageRecord(day, "a", {
  eventId: occurrenceId, eventTime: at(day, 12), sessionUuid: SESSION,
  accountPlanAttribution: attribution(),
  totalInputContextTokens: knownTotals ? 150 : null,
  components: { inputUncachedTokens: 100, inputCacheReadTokens: null, inputCacheWriteTokens: null,
    outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: knownTotals ? 75 : null },
});

/** Caller owns `reset()`. This applies the actual local source/target migrations and runtime setup. */
export async function initializeSharedAnalyticsCorpusDatabases(
  source: D1Database, target: D1Database, migrations: SharedAnalyticsCorpusMigrations,
  sourceId: string, sourceNamespace = sourceId,
): Promise<void> {
  for (const group of [migrations.TEST_MIGRATIONS, migrations.TEST_TYPED_INGESTION_MIGRATIONS,
    migrations.TEST_INGESTION_BRIDGE_MIGRATIONS, migrations.TEST_TYPED_V1_ADMISSION_MIGRATIONS,
    migrations.TEST_TYPED_V11_ADMISSION_MIGRATIONS]) await applyD1Migrations(source, group);
  await initializeStorageSource(source, sourceId);
  await initializeTypedV1Admission(source, sourceNamespace);
  await initializeTypedV11Admission(source, sourceNamespace);
  await applyD1Migrations(source, migrations.TEST_INGESTION_ISOLATION_MIGRATIONS);
  await applyD1Migrations(target, migrations.TEST_ANALYTICS_MIGRATIONS);
  if (!(await drainCommunityPublicSourceBootstrap(source)).completed) throw new Error("synthetic bootstrap incomplete");
  await initializeStorageAnalyticsRuntime({ source, target, sourceId, sourceNamespace });
  await source.prepare("UPDATE telemetry_v12_runtime SET state='active' WHERE id=1").run();
  await source.prepare("UPDATE telemetry_usage_correction_runtime SET state='active' WHERE id=1").run();
}

/** One genuine native enrollment/ownership/grant episode before source cloning.
 * Credential material stays in fixture memory and is never emitted. */
async function createAccountlessSecondary(source: D1Database): Promise<Device> {
  const nowEpoch = Date.now(), deviceId = crypto.randomUUID();
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const prefix = new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`);
  const bytes = new Uint8Array(prefix.length + secret.length);
  bytes.set(prefix); bytes.set(secret, prefix.length);
  const deviceSecretHash = await sha256Hex(bytes);
  const authorization = `Device um_device_${deviceId}.${encodeBase64Url(secret)}`;
  bytes.fill(0); secret.fill(0);
  await enrollAccountlessDevice(source, parseAccountlessEnrollmentRequest({
    schemaVersion: "accountless-enrollment-v0.1", deviceId, deviceSecretHash,
    policyVersion: "accountless-opt-out-v1", authorizationBasis: "accountless-policy-v1",
  }), nowEpoch);
  await createAccountlessUploadOwner(source, authorization, parseAccountlessOwnershipRequest({
    schemaVersion: "accountless-upload-owner-v0.1", policyVersion: "accountless-opt-out-v1",
    authorizationBasis: "accountless-policy-v1", telemetrySchemaVersion: "telemetry-contribution-v1.1",
  }), nowEpoch);
  const participantId = await source.prepare("SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=?")
    .bind(deviceId).first<string>("participant_id");
  if (!participantId) throw new Error("synthetic accountless owner unavailable");
  const device = { participantId, deviceId, authorization };
  await grantTelemetryV12AccountlessAuthorization(source, device, {
    schemaVersion: "accountless-upload-owner-v1.2", policyVersion: "accountless-telemetry-v1.2-policy-v1",
    authorizationBasis: "accountless-policy-v1.2", telemetrySchemaVersion: "telemetry-contribution-v1.2",
  }, nowEpoch);
  return device;
}

async function grantUpload(source: D1Database, device: Device, label: string) {
  const envelopeDigest = await digest(label);
  const principal = await authenticateDevice(source, device.authorization);
  const upload = await createDeviceUploadAuthorization(source, principal, envelopeDigest, 4096);
  const claimed = await claimDeviceUploadAuthorization(source, `Upload ${upload.uploadAuthorization}`,
    { envelopeDigest, bodyBytes: 4096, contentType: "application/json" });
  return { envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId };
}

async function insertV1Usage(source: D1Database, namespace: string, device: Device, day: string,
  occurrenceId: string, revision: number, knownTotals: boolean) {
  const prior = revision === 1 ? null : await currentTelemetryV1Chunk(source,
    device.participantId, device.deviceId, "usage", day, 0);
  if (revision > 1 && !prior) throw new Error("synthetic correction predecessor missing");
  const projected = telemetryV11LegacyProjection("usage", legacyRecord(day, occurrenceId, knownTotals));
  if (!projected) throw new Error("synthetic v1 usage projection missing");
  const records = [JSON.parse(projected.canonicalRecord) as TelemetryV1UsageEvent];
  const chunk = parseTelemetryV1Chunk({ schemaVersion: "telemetry-contribution-v1.0",
    chunkId: `usage:${day}:0`, chunkRevision: revision,
    chunkDigest: await sha256Hex(canonicalJson(records)), parserVersion: "synthetic-shared-corpus-v1",
    consent: { telemetrySchemaVersion: "telemetry-contribution-v1.0",
      fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0" }, records });
  const coordinates = `v1:${device.participantId}:${day}:${revision}`;
  await insertTypedTelemetryV1Chunk(source, {
    chunkRowId: `chunk:shared-corpus:${coordinates}`, participantId: device.participantId,
    deviceId: device.deviceId, chunk, ...await grantUpload(source, device, coordinates),
    r2Key: `synthetic/shared-corpus/${coordinates}`, createdAt: new Date().toISOString(), supersedes: prior,
  }, namespace);
}

async function stageV11(source: D1Database, namespace: string, device: Device, day: string,
  occurrenceId?: string | readonly string[], knownTotals = true): Promise<V11Ready> {
  const occurrences = occurrenceId === undefined ? []
    : typeof occurrenceId === 'string' ? [occurrenceId] : occurrenceId;
  const prepared = await makeV11Day(day, occurrences.length
    ? { usage: occurrences.map(value => legacyRecord(day, value, knownTotals)) } : {},
  "synthetic-shared-corpus-v11");
  await registerTelemetryV11DayManifest(source, device, prepared.manifest);
  for (const chunk of prepared.chunks) {
    const coordinates = `v11:${device.participantId}:${day}:${chunk.chunkId}:${chunk.manifestDigest}`;
    await persistTypedV11StagedChunk(source, device, chunk, {
      sourceNamespace: namespace, chunkRowId: `chunk:${(await digest(coordinates)).slice(0, 36)}`,
      r2Key: `synthetic/shared-corpus/${coordinates}`,
      ...await grantUpload(source, device, coordinates),
    });
  }
  return registerTelemetryV11DayManifest(source, device, prepared.manifest);
}

async function activateV11(source: D1Database, device: Device, ready: readonly V11Ready[]) {
  const predecessor = await createTelemetryV11DomainPredecessor(source, device);
  const ordered = [...ready].sort((left, right) => left.day.localeCompare(right.day));
  const manifest: TelemetryV11DomainManifest = { schemaVersion: "telemetry-domain-manifest-v1.1",
    fromDay: ordered[0]!.day, throughDay: ordered.at(-1)!.day,
    predecessor: { token: predecessor.token, previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint },
    days: ordered.map(value => ({ day: value.day, manifestId: value.manifestId,
      manifestDigest: value.manifestDigest })), manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  await activateTelemetryV11Domain(source, device, manifest);
}

function v12Usage(day: string, occurrenceId: string, legacyKnownTotals?: boolean): TelemetryV12UsageEvent {
  const record = legacyKnownTotals !== undefined ? legacyRecord(day, occurrenceId, legacyKnownTotals)
    : v11UsageRecord(day, "a", { eventId: occurrenceId, eventTime: at(day, 12), sessionUuid: SESSION });
  return { ...record, schemaVersion: "usage-event-v1.2", boundaryFlags: null,
    tieOrder: null, cacheWriteTtl: null };
}

async function stageV12(source: D1Database, device: Device, day: string,
  records: readonly TelemetryV12Record[]): Promise<V12Ready> {
  const consent = telemetryV12RequiredConsent();
  const chunks: TelemetryV12Chunk[] = [];
  for (const stream of ["quota", "session", "usage"] as const) {
    const selected = records.filter(record => record.schemaVersion.startsWith(`${stream}-`));
    for (let offset = 0; offset < selected.length; offset += 200) {
      const rows = selected.slice(offset, offset + 200);
      chunks.push({ schemaVersion: "telemetry-contribution-v1.2", manifestDigest: "0".repeat(64),
        chunkId: `${stream}:${day}:${offset / 200}`, chunkRevision: 1,
        chunkDigest: await sha256Hex(canonicalTelemetryV12Json(rows)),
        parserVersion: "synthetic-shared-corpus-v12", consent, records: rows });
    }
  }
  const manifest: TelemetryV12DayManifest = { schemaVersion: "telemetry-day-manifest-v1.2",
    day, parserVersion: "synthetic-shared-corpus-v12", consent,
    chunks: chunks.map(chunk => ({ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest,
      recordCount: chunk.records.length })), excluded: { quota: 0, session: 0, usage: 0 },
    manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = await sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  await registerTelemetryV12DayManifest(source, device, manifest);
  for (const chunk of chunks) {
    chunk.manifestDigest = manifest.manifestDigest;
    const coordinates = `v12:${device.participantId}:${day}:${chunk.chunkId}:${manifest.manifestDigest}`;
    await persistTelemetryV12StagedChunk(source, device, chunk, {
      chunkRowId: `chunk:${(await digest(coordinates)).slice(0, 36)}`,
      r2Key: `synthetic/shared-corpus/${coordinates}`,
      ...await grantUpload(source, device, coordinates),
    });
  }
  return registerTelemetryV12DayManifest(source, device, manifest);
}

async function activateV12(source: D1Database, device: Device, ready: readonly V12Ready[]) {
  const now = Date.now();
  const predecessor = await createTelemetryV12DomainPredecessor(source, device, now);
  const ordered = [...ready].sort((left, right) => left.day.localeCompare(right.day));
  const manifest = { schemaVersion: "telemetry-domain-manifest-v1.2" as const,
    fromDay: ordered[0]!.day, throughDay: ordered.at(-1)!.day,
    predecessor: { token: predecessor.token, previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint },
    days: ordered.map(value => ({ day: value.day, manifestId: value.manifestId,
      manifestDigest: value.manifestDigest })), manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = await sha256Hex(telemetryV12DomainManifestDigestInput(manifest));
  await activateTelemetryV12Domain(source, device, manifest, now);
}

async function ownerFor(source: D1Database, participantId: string) {
  const owner = (await readStorageCommunityOwnerPage(source))
    .find(candidate => candidate.participantId === participantId);
  if (!owner?.ownerDigest || !owner.hasEffective) throw new Error("synthetic effective owner unavailable");
  return owner as StorageCommunityOwner & { ownerDigest: string };
}

/**
 * One owner has accepted v1, v1.1, and v1.2 evidence. The v1/v1.1/v1.2
 * overlap proves same-owner equivalence; a second owner reuses the ID to prove
 * owner scoping. A real accepted v1.2 successor changes the source owner pin.
 * Quota observations and priced two-model usage clear the ordinary fit lane.
 */
export async function seedSharedAnalyticsCorpus(options: SharedAnalyticsCorpusOptions): Promise<SharedAnalyticsCorpus> {
  const { source, target, sourceId, sourceNamespace } = options;
  if (options.secondaryOwnerKind !== undefined && !["social", "accountless"].includes(options.secondaryOwnerKind))
    throw new Error("invalid synthetic secondary owner kind");
  const calendarDays = options.calendarDays ?? 130, graphDays = options.graphDays ?? 30;
  const denseUsageRows = options.denseUsageRows ?? 0;
  const anchorDay = options.anchorDay ?? "2026-09-20";
  if (!Number.isSafeInteger(calendarDays) || calendarDays < graphDays + 8 ||
    !Number.isSafeInteger(graphDays) || graphDays < 1 || graphDays > 70 ||
    !Number.isSafeInteger(denseUsageRows) || denseUsageRows < 0 || denseUsageRows > 600 ||
    !Number.isFinite(midnight(anchorDay))) throw new Error("invalid synthetic calendar");
  const anchorMs = midnight(anchorDay), firstMs = anchorMs - (calendarDays - 1) * DAY_MS;
  const historyDates = Array.from({ length: calendarDays }, (_, index) => date(firstMs + index * DAY_MS));
  const selectedDates = historyDates.slice(-graphDays);
  const equivalentDay = historyDates[calendarDays - graphDays - 7]!;
  const correctionDay = historyDates[calendarDays - graphDays - 6]!;
  const sessionDay = historyDates[calendarDays - graphDays - 8]!;
  const equivalentOccurrenceId = id(1), correctionOccurrenceId = id(2);
  const duplicateAcrossOwnersOccurrenceId = equivalentOccurrenceId;

  const v1 = await createV11DeviceFixture(source, {
    participantId: "participant:4aa335fb-32cd-452e-91b9-73e818a3cf81",
  });
  await insertV1Usage(source, sourceNamespace, v1, equivalentDay, equivalentOccurrenceId, 1, true);
  const v11 = await createV11DeviceFixture(source, { participantId: v1.participantId, grant: true });
  const v11Ready: V11Ready[] = [];
  const v11LastMs = Math.max(Date.now() - Date.now() % DAY_MS, midnight(correctionDay));
  if ((v11LastMs - midnight(equivalentDay)) / DAY_MS + 1 > 366) {
    throw new Error("synthetic v1.1 closure exceeds 366 days; choose a newer anchor day");
  }
  for (let dayMs = midnight(equivalentDay); dayMs <= v11LastMs; dayMs += DAY_MS) {
    const selectedDay = date(dayMs);
    v11Ready.push(await stageV11(source, sourceNamespace, v11, selectedDay,
      selectedDay === equivalentDay ? equivalentOccurrenceId : undefined));
  }
  await activateV11(source, v11, v11Ready);

  const v12 = await createV11DeviceFixture(source, { participantId: v1.participantId });
  await grantTelemetryV12Consent(source, v12, telemetryV12RequiredConsent());
  const ownerBeforeV12 = await ownerFor(source, v1.participantId);
  if (!ownerBeforeV12.hasV1 || !ownerBeforeV12.hasV11) throw new Error("synthetic mixed owner unavailable");
  const grouped = new Map<string, TelemetryV12Record[]>();
  const add = (record: TelemetryV12Record, day: string) => {
    const rows = grouped.get(day) ?? []; rows.push(record); grouped.set(day, rows);
  };
  const correctionRecord = (knownTotals: boolean): TelemetryV12UsageEvent => ({
    ...v12Usage(correctionDay, correctionOccurrenceId, knownTotals),
    accountPlanAttribution: attribution(),
  });
  add({ schemaVersion: "session-dimension-v1.2",
    sessionUuid: "17539c1b-61da-4d9d-8b1f-6e464470d88b",
    firstEventTime: at(sessionDay, 13), provider: "openai_codex",
    toolClassCounts: { localShell: 2, web: 1 } }, sessionDay);
  add(v12Usage(equivalentDay, equivalentOccurrenceId, true), equivalentDay);
  add(correctionRecord(false), correctionDay);
  const crossDayLinkDay = options.crossDayLinks ? selectedDates[0]! : undefined;
  if (crossDayLinkDay) add({ ...v12Usage(crossDayLinkDay, correctionOccurrenceId, true),
    eventTime: `${crossDayLinkDay}T00:00:00.000Z`,
    accountPlanAttribution: attribution() }, crossDayLinkDay);
  // Sparse occurrences cover the entire history. Empty accepted manifests
  // below still preserve the complete 130-day comparison vector.
  for (let index = 0; index < calendarDays - 5; index += 7) {
    const day = historyDates[index]!;
    add({ ...v12Usage(day, id(1_000 + index)), accountPlanAttribution: attribution() }, day);
  }
  // Two consecutive positive-input requests on every target day make the
  // real cache reader exercise a comparable five-minute same-session pair,
  // including graph dates between the seven-day model-fit windows.
  for (const [index, day] of selectedDates.entries()) {
    for (let pair = 0; pair < 2; pair++) {
      add({ ...v12Usage(day, id(20_000 + index * 2 + pair)),
        eventTime: new Date(midnight(day) + 18 * 3_600_000 + pair * 300_000).toISOString(),
        sessionUuid: CACHE_SESSION,
        totalInputContextTokens: 1_000,
        components: { inputUncachedTokens: 100, inputCacheReadTokens: 900,
          inputCacheWriteTokens: 0, outputTextTokens: 1,
          outputReasoningTokens: 0, outputCombinedTokens: null },
        accountPlanAttribution: attribution() }, day);
    }
  }
  let quotaIndex = 0, usageIndex = 0;
  const quota = (time: string, percent: number, resetsAt: string): TelemetryV12Record => ({
    schemaVersion: "quota-observation-v1.2", observationId: `quota-occurrence:v1:${(++quotaIndex).toString(16).padStart(64, "0")}`,
    observedTime: time, provider: "openai_codex", planType: "pro", planVariant: "unknown",
    limitId: "codex", slot: "seven_day", usedPercent: percent,
    windowDurationMinutes: 10_080, resetsAt, accountPlanAttribution: attribution(),
  });
  const modelFitDates = new Set<string>();
  const fitStarts: number[] = [];
  const dailyFitPercent = new Map<string, number>();
  // One identified two-model window every seven days gives all selected target
  // dates recent, nonempty fit evidence, including the current scalar date.
  for (let startIndex = calendarDays - graphDays - 4; startIndex <= calendarDays - 5; startIndex += 7) {
    fitStarts.push(startIndex);
    const modelStart = historyDates[startIndex]!;
    const resetsAt = at(modelStart, 168);
    let usedPercent = 0;
    add(quota(at(modelStart, 0), 0, resetsAt), modelStart);
    for (let bin = 0; bin < 60; bin++) {
      const time = at(modelStart, bin * 2 + 0.5), usageDay = time.slice(0, 10);
      modelFitDates.add(usageDay);
      for (const [index, [model, capacity]] of Object.entries(MODEL_HISTORY_TEST_CAPACITIES).entries()) {
        const cost = (5 + ((bin * 7 + index * 11) % 17) / 4) * ((bin + index) % 3 === 0 ? 0.2 : 1);
        const priced = pricedModelHistoryUsage(model, cost, time);
        const values = JSON.parse(priced.record.recordJson!) as Pick<TelemetryV12UsageEvent,
          "components" | "totalInputContextTokens">;
        add({ ...v12Usage(usageDay, id(10_000 + usageIndex++)), eventTime: time, modelId: model,
          sessionUuid: index === 0 ? SESSION : SECOND_MODEL_SESSION,
          totalInputContextTokens: 1_000,
          components: { ...values.components, inputUncachedTokens: 100,
            inputCacheReadTokens: 900, inputCacheWriteTokens: 0 },
          accountPlanAttribution: attribution() }, usageDay);
        usedPercent += priced.costUsd * 100 / capacity;
      }
      const quotaTime = at(modelStart, bin * 2 + 1);
      add(quota(quotaTime, usedPercent, resetsAt), quotaTime.slice(0, 10));
      dailyFitPercent.set(quotaTime.slice(0, 10), usedPercent);
    }
    if (usedPercent >= 100) throw new Error("synthetic fit crosses quota reset");
  }
  if (options.denseDays) {
    const firstFitStart = fitStarts[0]!;
    for (const [index, day] of historyDates.entries()) {
      const fitStart = [...fitStarts].reverse().find(start => start <= index && index < start + 7);
      const periodStart = fitStart ?? firstFitStart - 7 * Math.ceil((firstFitStart - index) / 7);
      const resetDay = date(firstMs + (periodStart + 7) * DAY_MS);
      let usedPercent = 0;
      if (fitStart !== undefined) {
        for (let previous = fitStart; previous <= index; previous++) {
          usedPercent = dailyFitPercent.get(historyDates[previous]!) ?? usedPercent;
        }
      }
      add(quota(at(day, 23.5), usedPercent, `${resetDay}T00:00:00.000Z`), day);
      add({ ...v12Usage(day, id(40_000 + index)), accountPlanAttribution: attribution() }, day);
    }
  }
  for (let index = 0; index < denseUsageRows; index++) {
    const day = selectedDates[0]!;
    add({ ...v12Usage(day, id(50_000 + index)),
      eventTime: new Date(midnight(day) + (12 * 60 + index) * 60_000).toISOString(),
      accountPlanAttribution: attribution() }, day);
  }
  const staged: V12Ready[] = [];
  // The accepted v1.2 domain is a complete UTC-day comparison vector. Empty
  // day manifests are required even though occurrence density is sparse.
  for (const day of historyDates) staged.push(await stageV12(source, v12, day, grouped.get(day) ?? []));
  await activateV12(source, v12, staged);

  // This is a different owner with the same occurrence ID. The effective
  // reader must never merge it with the primary owner's evidence.
  let secondaryAccountless: SharedAnalyticsCorpus["secondaryAccountless"];
  if (options.secondaryOwnerKind === "accountless") {
    const other = await createAccountlessSecondary(source), secondaryReady: V12Ready[] = [];
    for (const day of historyDates) secondaryReady.push(await stageV12(source, other, day,
      day === equivalentDay || day === crossDayLinkDay
        ? [v12Usage(day, duplicateAcrossOwnersOccurrenceId, true)] : []));
    await activateV12(source, other, secondaryReady);
    const secondary = await ownerFor(source, other.participantId);
    if (!secondary.hasV12) throw new Error("synthetic accountless accepted source unavailable");
    secondaryAccountless = { participantId: other.participantId, enrollmentDeviceId: other.deviceId };
  } else {
    const other = await createV11DeviceFixture(source, { participantId: "synthetic-shared-corpus-other" });
    await insertV1Usage(source, sourceNamespace, other, equivalentDay,
      duplicateAcrossOwnersOccurrenceId, 1, true);
    if (crossDayLinkDay) {
      const otherLinkedDevice = await createV11DeviceFixture(source, { participantId: other.participantId });
      await insertV1Usage(source, sourceNamespace, otherLinkedDevice, crossDayLinkDay,
        duplicateAcrossOwnersOccurrenceId, 1, true);
    }
  }
  const owner = await ownerFor(source, v1.participantId);
  if (!owner.hasV1 || !owner.hasV11 || !owner.hasV12) throw new Error("synthetic mixed owner incomplete");
  if (options.targetAuthority !== "ordered-delivery") await target.prepare(`INSERT INTO analytics_owner_state
    (source_id,owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?,?)`)
    .bind(sourceId, owner.ownerDigest, owner.ownerRevision, owner.authorityEpoch, "active").run();
  let corrected = false, outsideAppends = 0;
  const appendedV11 = new Map<string, string[]>();
  const appendV11Day = async (day: string) => {
    const position = v11Ready.findIndex(value => value.day === day);
    if (position < 0) throw new Error('synthetic v1.1 day missing');
    const occurrences = [...appendedV11.get(day) ?? [], id(95_000 + outsideAppends++)];
    const candidate = await stageV11(source, sourceNamespace, v11, day, occurrences);
    v11Ready[position] = candidate;
    appendedV11.set(day, occurrences);
    await activateV11(source, v11, v11Ready);
    const current = await ownerFor(source, v1.participantId);
    if (options.targetAuthority !== "ordered-delivery") await target.prepare(`UPDATE analytics_owner_state SET revision=?,authority_epoch=?
      WHERE source_id=? AND owner_digest=? AND state='active'`)
      .bind(current.ownerRevision, current.authorityEpoch, sourceId, current.ownerDigest).run();
    return current;
  };
  return { owner, participantId: v1.participantId, ...(secondaryAccountless ? { secondaryAccountless } : {}), historyDates, graphDates: selectedDates,
    firstGraphLookbackDates: historyDates.slice(0, Math.min(101, calendarDays - graphDays + 1)),
    populatedDates: [...grouped.keys()].sort(), equivalentOccurrenceId, equivalentDay,
    correctionOccurrenceId, correctionDay, crossDayLinkDay, sessionDay, v11DomainThroughDay: date(v11LastMs),
    duplicateAcrossOwnersOccurrenceId, modelFitDates: [...modelFitDates].sort(),
    functionalInputs: {usage:{day:correctionDay,occurrenceId:correctionOccurrenceId},
      quota: [...grouped.entries()].flatMap(([day,records])=>records.filter(record=>
        record.schemaVersion==='quota-observation-v1.2'&&record.usedPercent!==null&&record.usedPercent<=95&&record.planType==='pro')
        .map(record=>({day,occurrenceId:(record as TelemetryV12QuotaObservation).observationId})))[0],
      emptyDay:historyDates.find(day=>(grouped.get(day)?.length??0)===0),crossDayDestination:equivalentDay},
    appendOutsideV11: () => appendV11Day(date(v11LastMs)), appendV11Day,
    async mutateCorrection() {
      if (corrected) throw new Error("synthetic correction already applied");
      const replacement = grouped.get(correctionDay)?.map(record =>
        record.schemaVersion === "usage-event-v1.2" && record.eventId === correctionOccurrenceId
          ? correctionRecord(true) : record);
      if (!replacement) throw new Error("synthetic correction day missing");
      const candidate = await stageV12(source, v12, correctionDay, replacement);
      const position = historyDates.indexOf(correctionDay);
      staged[position] = candidate;
      if (options.correctionAffectsModelFit) {
        const fitDay = historyDates[fitStarts[0]!]!;
        const initial = grouped.get(fitDay);
        if (!initial) throw new Error("synthetic fit correction day missing");
        const exemplar = initial.find((record): record is TelemetryV12UsageEvent =>
          record.schemaVersion === "usage-event-v1.2"
          && record.modelId === Object.keys(MODEL_HISTORY_TEST_CAPACITIES)[0]);
        if (!exemplar) throw new Error("synthetic fit correction rows missing");
        // Preserve accepted old occurrences: an in-place numerical rewrite of
        // the same occurrence is correctly reported as a source conflict.
        const revised = [...initial, { ...JSON.parse(JSON.stringify(exemplar)) as TelemetryV12UsageEvent,
          eventId: id(90_000) }];
        staged[fitStarts[0]!] = await stageV12(source, v12, fitDay, revised);
      }
      await activateV12(source, v12, staged);
      corrected = true;
      const current = await ownerFor(source, v1.participantId);
      if (options.targetAuthority !== "ordered-delivery") await target.prepare(`UPDATE analytics_owner_state SET revision=?,authority_epoch=?
        WHERE source_id=? AND owner_digest=? AND state='active'`)
        .bind(current.ownerRevision, current.authorityEpoch, sourceId, current.ownerDigest).run();
      return current;
    } };
}
