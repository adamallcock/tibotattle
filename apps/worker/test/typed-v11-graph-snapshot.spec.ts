import { env, applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest,
  type TelemetryV11QuotaObservation } from "@app-usagemonitor/telemetry-contract";
import { authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization } from "../src/device-auth";
import { initializeStorageSource } from "../src/analytics-delivery";
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../src/typed-v11-admission";
import { registerTelemetryV11DayManifest } from "../src/telemetry-v11-repository";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor, loadV11SourcePin,
  V11_DOMAIN_METHOD_VERSION } from "../src/telemetry-v11-domain";
import { sha256Hex } from "../src/crypto";
import { canonicalJson } from "../src/canonical-json";
import { encodeTypedTelemetryId } from "../src/typed-telemetry-codec";
import { createTypedV11QuotaPageReader, loadTypedV11GenerationSnapshot,
  TYPED_V11_QUOTA_SNAPSHOT_PAGE_SQL,
  type V11GenerationSnapshot } from "../src/typed-v11-quota-reader";
import { readTypedV11UsageAnalysisPage, TYPED_V11_USAGE_SNAPSHOT_PAGE_SQL } from "../src/typed-v11-analysis-reader";
import { createV11DeviceFixture, makeV11Day, v11UsageRecord } from "./helpers/telemetry-v11";

const bindings = env as Env & { STORAGE_INGESTION_A: D1Database; TEST_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[]; TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[] };
const database = () => bindings.STORAGE_INGESTION_A;
const SOURCE_NAMESPACE = "synthetic-v11-graph-snapshot";
const PARTICIPANT = "participant:synthetic-v11-graph-snapshot";
const DAY = new Date().toISOString().slice(0, 10);
const NEXT_DAY = new Date(Date.parse(`${DAY}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
const START = Date.parse(`${DAY}T00:00:00.000Z`);
const ACCOUNT = "account-track:v2:" + "b".repeat(64);

const b = () => database();

beforeEach(async () => {
  await reset();
  await applyD1Migrations(database(), bindings.TEST_MIGRATIONS);
  await applyD1Migrations(database(), bindings.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(database(), bindings.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(database(), bindings.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await initializeStorageSource(database(), SOURCE_NAMESPACE);
  await initializeTypedV11Admission(database(), SOURCE_NAMESPACE);
});

type Fixture = Awaited<ReturnType<typeof createV11DeviceFixture>>;
type Prepared = Awaited<ReturnType<typeof makeV11Day>>;
type Candidate = Awaited<ReturnType<typeof registerTelemetryV11DayManifest>>;

function preparedDay(day: string, fill: string): Promise<Prepared> {
  const dayStart = Date.parse(`${day}T00:00:00.000Z`);
  const attribution = { accountBasis: "same_source" as const, accountTrackId: ACCOUNT,
    planBasis: "same_source_occurrence" as const, planType: "pro" as const, planEraId: null };
  const quota: TelemetryV11QuotaObservation[] = [0, 1].map(index => ({
    schemaVersion: "quota-observation-v1.1" as const,
    observationId: `quota:graph-snapshot:${fill}:${index}`,
    observedTime: new Date(dayStart + index * 1_000).toISOString(), provider: "openai_codex",
    planType: "pro" as const, planVariant: "unknown", limitId: "codex", slot: "seven_day",
    usedPercent: 20 + index * 5, windowDurationMinutes: 10_080,
    resetsAt: new Date(dayStart + 7 * 86_400_000).toISOString(), accountPlanAttribution: { ...attribution },
  }));
  return makeV11Day(day, { quota, usage: [v11UsageRecord(day, fill)] });
}

async function stage(fixture: Fixture, prepared: Prepared): Promise<Candidate> {
  await registerTelemetryV11DayManifest(database(), fixture, prepared.manifest);
  for (const chunk of prepared.chunks) {
    const envelopeDigest = await sha256Hex(`synthetic-v11-graph-snapshot:${crypto.randomUUID()}`);
    const principal = await authenticateDevice(database(), fixture.authorization);
    const upload = await createDeviceUploadAuthorization(database(), principal, envelopeDigest, 200);
    const claimed = await claimDeviceUploadAuthorization(database(), `Upload ${upload.uploadAuthorization}`, {
      envelopeDigest, bodyBytes: 200, contentType: "application/json",
    });
    await persistTypedV11StagedChunk(database(), principal, chunk, {
      sourceNamespace: SOURCE_NAMESPACE, chunkRowId: `chunk:${crypto.randomUUID()}`,
      r2Key: `synthetic/v11-graph-snapshot/${crypto.randomUUID()}`, envelopeDigest,
      deviceUploadAuthorizationId: claimed.authorizationId,
    });
  }
  return registerTelemetryV11DayManifest(database(), fixture, prepared.manifest);
}

async function activate(fixture: Fixture, candidates: Candidate[]) {
  const ordered = [...candidates].sort((left, right) => left.day.localeCompare(right.day));
  const predecessor = await createTelemetryV11DomainPredecessor(database(), fixture);
  const manifest: TelemetryV11DomainManifest = {
    schemaVersion: "telemetry-domain-manifest-v1.1", fromDay: ordered[0]!.day,
    throughDay: ordered.at(-1)!.day,
    predecessor: { token: predecessor.token, previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint },
    days: ordered.map(candidate => ({ day: candidate.day, manifestId: candidate.manifestId,
      manifestDigest: candidate.manifestDigest })), manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  return activateTelemetryV11Domain(database(), fixture, manifest);
}

async function scenario() {
  const fixture = await createV11DeviceFixture(database(), { participantId: PARTICIPANT, grant: true });
  const first = await preparedDay(DAY, "a");
  const firstCandidate = await stage(fixture, first);
  await activate(fixture, [firstCandidate]);
  const firstPin = (await loadV11SourcePin(database(), PARTICIPANT))!;
  const snapshot = await loadTypedV11GenerationSnapshot(database(), { sourceNamespace: SOURCE_NAMESPACE, pin: firstPin });

  // Re-admit the immutable first day and add a successor day to force a new
  // current head while retaining the first generation's source journal.
  const replayedFirst = await stage(fixture, first);
  const successor = await stage(fixture, await preparedDay(NEXT_DAY, "b"));
  await activate(fixture, [replayedFirst, successor]);
  return { fixture, firstPin, snapshot };
}

async function snapshotWith(snapshot: V11GenerationSnapshot,
  changes: Partial<V11GenerationSnapshot>): Promise<V11GenerationSnapshot> {
  const value = { ...snapshot, ...changes };
  value.fingerprint = await sha256Hex(canonicalJson({ method: V11_DOMAIN_METHOD_VERSION,
    participantId: value.participantId, generationId: value.generationId,
    manifestDigest: value.manifestDigest, fromDay: value.fromDay,
    throughDay: value.throughDay, inputRevision: value.inputRevision }));
  return value;
}

async function readQuota(snapshot: Awaited<ReturnType<typeof loadTypedV11GenerationSnapshot>>) {
  const reader = await createTypedV11QuotaPageReader(database(), {
    sourceNamespace: SOURCE_NAMESPACE, snapshot,
    fromObservedAtMs: START, beforeObservedAtMs: START + 86_400_000,
  });
  const rows = [] as Awaited<ReturnType<typeof reader.readPage>>;
  let after = { observedAtMs: START, sourceRowId: 0 };
  for (;;) {
    const page = await reader.readPage(after, 1);
    if (page.length === 0) break;
    rows.push(...page);
    after = { observedAtMs: page.at(-1)!.observedAtMs, sourceRowId: page.at(-1)!.sourceRowId };
  }
  return { reader, rows };
}

describe("typed v1.1 fixed graph snapshots", () => {
  it("reads the retained generation after a successor head is active", async () => {
    const { firstPin, snapshot } = await scenario();
    expect(snapshot.generationId).toBe(firstPin.generationId);
    expect(snapshot.sourceNamespace).toBe(SOURCE_NAMESPACE);

    const { reader, rows } = await readQuota(snapshot);
    expect(reader.snapshot).toEqual(snapshot);
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.active?.usedPercent)).toEqual([20, 25]);
    expect(rows.every(row => row.active?.deviceId === snapshot.deviceId)).toBe(true);

    const usage = await readTypedV11UsageAnalysisPage(database(), {
      sourceNamespace: SOURCE_NAMESPACE, snapshot, day: DAY,
      from: `${DAY}T00:00:00.000Z`, to: `${NEXT_DAY}T00:00:00.000Z`,
      afterTime: `${DAY}T00:00:00.000Z`, afterOccurrence: "", pageSize: 10,
    });
    expect(usage).toHaveLength(1);
    expect(usage[0]!.record_json).toContain('"eventId":"event:v2:' + "a".repeat(64));

    // The ordinary reader remains current-head strict even though the pinned
    // reader above can continue from the retained generation.
    await expect(createTypedV11QuotaPageReader(database(), {
      sourceNamespace: SOURCE_NAMESPACE, pin: firstPin,
      fromObservedAtMs: START, beforeObservedAtMs: START + 86_400_000,
    })).rejects.toThrow("TYPED_V11_QUOTA_READER_UNAVAILABLE");
  }, 120_000);

  it("rejects foreign identity and rechecks erasure before every page", async () => {
    const { snapshot } = await scenario();
    const foreignManifest = await snapshotWith(snapshot, { manifestDigest: "f".repeat(64) });
    const foreignGeneration = await snapshotWith(snapshot, { generationId: crypto.randomUUID() });
    await expect(createTypedV11QuotaPageReader(database(), {
      sourceNamespace: SOURCE_NAMESPACE, snapshot: foreignManifest,
      fromObservedAtMs: START, beforeObservedAtMs: START + 86_400_000,
    })).rejects.toThrow("TYPED_V11_QUOTA_READER_UNAVAILABLE");
    await expect(createTypedV11QuotaPageReader(database(), {
      sourceNamespace: SOURCE_NAMESPACE, snapshot: foreignGeneration,
      fromObservedAtMs: START, beforeObservedAtMs: START + 86_400_000,
    })).rejects.toThrow("TYPED_V11_QUOTA_READER_UNAVAILABLE");

    const reader = await createTypedV11QuotaPageReader(database(), {
      sourceNamespace: SOURCE_NAMESPACE, snapshot,
      fromObservedAtMs: START, beforeObservedAtMs: START + 86_400_000,
    });
    await b().prepare("UPDATE participants SET state='deleting' WHERE id=?").bind(PARTICIPANT).run();
    await expect(reader.readPage({ observedAtMs: START, sourceRowId: 0 }, 1))
      .rejects.toThrow("TYPED_V11_QUOTA_READER_UNAVAILABLE");
    await expect(readTypedV11UsageAnalysisPage(database(), {
      sourceNamespace: SOURCE_NAMESPACE, snapshot, day: DAY,
      from: `${DAY}T00:00:00.000Z`, to: `${NEXT_DAY}T00:00:00.000Z`,
      afterTime: `${DAY}T00:00:00.000Z`, afterOccurrence: "", pageSize: 10,
    })).rejects.toThrow("TYPED_V11_QUOTA_READER_UNAVAILABLE");
  }, 120_000);

  it("keeps retained quota and usage pages on bounded indexed drivers after planner statistics",async()=>{
    const {snapshot}=await scenario();
    const reader=await createTypedV11QuotaPageReader(database(),{sourceNamespace:SOURCE_NAMESPACE,snapshot,
      fromObservedAtMs:START,beforeObservedAtMs:START+86_400_000});
    await database().prepare("ANALYZE").run();
    const quota=(await database().prepare("EXPLAIN QUERY PLAN "+TYPED_V11_QUOTA_SNAPSHOT_PAGE_SQL).bind(
      reader.scope.namespaceId,reader.scope.ownerId,START,START+86_400_000,START,0,1024,
      snapshot.generationId,snapshot.participantId,reader.scope.namespaceId,SOURCE_NAMESPACE,
      reader.scope.deviceIdBlob,snapshot.manifestDigest,snapshot.fromDay,snapshot.throughDay)
      .all<{detail:string}>()).results.map(row=>row.detail);
    expect(quota.some(detail=>detail.includes("typed_telemetry_owner_time"))).toBe(true);
    expect(quota.some(detail=>detail.includes("USE TEMP B-TREE FOR ORDER BY"))).toBe(false);
    const usage=(await database().prepare("EXPLAIN QUERY PLAN "+TYPED_V11_USAGE_SNAPSHOT_PAGE_SQL).bind(
      SOURCE_NAMESPACE,snapshot.participantId,snapshot.generationId,snapshot.deviceId,DAY,
      START,START+86_400_000,START,"",5000,
      Uint8Array.from(encodeTypedTelemetryId(snapshot.deviceId)).buffer,
      snapshot.manifestDigest,snapshot.fromDay,snapshot.throughDay).all<{detail:string}>()).results.map(row=>row.detail);
    expect(usage.some(detail=>detail.includes("typed_v11_manifest_observed (manifest_key=? AND stream=? AND observed_at_ms>? AND observed_at_ms<?)"))).toBe(true);
    // Compatibility expansion reorders only the already limited 5,000-row
    // page. The proof seek above occurs before that one bounded temp sort.
    expect(usage.filter(detail=>detail.includes("USE TEMP B-TREE FOR ORDER BY")),usage.join("\n")).toHaveLength(1);
  },120_000);
});
