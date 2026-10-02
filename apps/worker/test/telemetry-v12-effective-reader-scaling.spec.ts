import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import {
  canonicalTelemetryV12Json, telemetryV12DayManifestDigestInput,
  telemetryV12DomainManifestDigestInput, telemetryV12RequiredConsent,
  type TelemetryV12Chunk, type TelemetryV12DayManifest, type TelemetryV12UsageEvent,
} from "@app-usagemonitor/telemetry-contract";
import { initializeStorageSource } from "../src/analytics-delivery";
import { sha256Hex } from "../src/crypto";
import { createD1InvocationBudget } from "../src/d1-invocation-budget";
import { authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization } from "../src/device-auth";
import { grantTelemetryV12Consent } from "../src/telemetry-transport-policy";
import { activateTelemetryV12Domain, createTelemetryV12DomainPredecessor } from "../src/telemetry-v12-domain";
import { readTelemetryV12EffectiveOccurrences } from "../src/telemetry-v12-effective-reader";
import { persistTelemetryV12StagedChunk, registerTelemetryV12DayManifest } from "../src/telemetry-v12-repository";
import { readEffectiveUsageOwnerDayPage } from "../src/telemetry-usage-effective-reader";
import { createV11DeviceFixture } from "./helpers/telemetry-v11";

interface Bindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
}
const bindings = env as Bindings;
const db = () => bindings.USAGE_MONITOR_DB;
const selectedDay = "2026-09-20", unrelatedDay = "2026-09-21";
type Device = Awaited<ReturnType<typeof createV11DeviceFixture>>;
type DayRef = { day: string; manifestId: string; manifestDigest: string };

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), bindings.TEST_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_INGESTION_ISOLATION_MIGRATIONS);
  await initializeStorageSource(db(), "synthetic-v12-scaling-source");
  await db().prepare("UPDATE telemetry_v12_runtime SET state='active',changed_at=? WHERE id=1")
    .bind(new Date().toISOString()).run();
});

function usage(eventId: string, observedDay: string): TelemetryV12UsageEvent {
  return {
    schemaVersion: "usage-event-v1.2", eventId, eventTime: observedDay + "T12:05:00.000Z",
    sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b", provider: "openai_codex",
    modelId: "gpt-5.6-sol", speedMode: "standard", apiServiceTier: "default",
    surface: "local_interactive_unclassified", billingSurface: "chatgpt_subscription",
    reasoningEffort: "high", agentScope: "root", outcome: "completed",
    totalInputContextTokens: 1000,
    components: { inputUncachedTokens: 100, inputCacheReadTokens: 900,
      inputCacheWriteTokens: 0, outputTextTokens: 50, outputReasoningTokens: 25,
      outputCombinedTokens: null },
    accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null,
      planBasis: "same_source_occurrence", planType: "pro", planEraId: null },
    boundaryFlags: null, tieOrder: null, cacheWriteTtl: null,
  };
}

async function acceptDay(device: Device, observedDay: string,
  records: readonly TelemetryV12UsageEvent[], chunkSize: number,
  priorDays: readonly DayRef[] = []): Promise<readonly DayRef[]> {
  const consent = telemetryV12RequiredConsent();
  const parserVersion = "synthetic-v12-scaling-v1";
  const chunks: TelemetryV12Chunk[] = [];
  for (let start = 0; start < records.length; start += chunkSize) {
    const selected = records.slice(start, start + chunkSize);
    chunks.push({ schemaVersion: "telemetry-contribution-v1.2", manifestDigest: "0".repeat(64),
      chunkId: `usage:${observedDay}:${start / chunkSize}`, chunkRevision: 1,
      parserVersion, consent, records: [...selected],
      chunkDigest: await sha256Hex(canonicalTelemetryV12Json(selected)) });
  }
  const manifest: TelemetryV12DayManifest = {
    schemaVersion: "telemetry-day-manifest-v1.2", day: observedDay, parserVersion, consent,
    chunks: chunks.map(chunk => ({ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest,
      recordCount: chunk.records.length })),
    excluded: { quota: 0, session: 0, usage: 0 }, manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = await sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  const accepted = await registerTelemetryV12DayManifest(db(), device, manifest);
  for (const chunk of chunks) {
    chunk.manifestDigest = manifest.manifestDigest;
    const principal = await authenticateDevice(db(), device.authorization);
    const envelopeDigest = await sha256Hex("synthetic-v12-scaling-envelope-" + crypto.randomUUID());
    const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 4096);
    const claimed = await claimDeviceUploadAuthorization(db(), "Upload " + upload.uploadAuthorization,
      { envelopeDigest, bodyBytes: 4096, contentType: "application/json" });
    await persistTelemetryV12StagedChunk(db(), device, chunk, {
      chunkRowId: "chunk:" + crypto.randomUUID(), r2Key: "synthetic/v12-scaling/" + crypto.randomUUID(),
      envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId,
    });
  }
  const predecessor = await createTelemetryV12DomainPredecessor(db(), device, Date.now());
  const days = [...priorDays,
    { day: observedDay, manifestId: accepted.manifestId, manifestDigest: manifest.manifestDigest }];
  const domain = {
    schemaVersion: "telemetry-domain-manifest-v1.2" as const,
    fromDay: days[0]!.day, throughDay: days.at(-1)!.day,
    predecessor: { token: predecessor.token, previousGenerationId: predecessor.previousGenerationId,
      legacyFingerprint: predecessor.legacyFingerprint },
    days,
    manifestDigest: "0".repeat(64),
  };
  domain.manifestDigest = await sha256Hex(telemetryV12DomainManifestDigestInput(domain));
  const activation = await activateTelemetryV12Domain(db(), device, domain, Date.now());
  expect(activation.replay).toBe(false);
  return days;
}

async function owner(participantId: string, ownerDigest: string) {
  await db().prepare(`INSERT INTO storage_v11_owner_links
    (participant_id,owner_digest,state,object_digest,manifest_digest) VALUES(?,?,?,?,?)`)
    .bind(participantId, ownerDigest, "active", ownerDigest, ownerDigest).run();
  await db().prepare(`INSERT INTO storage_owner_revisions
    (owner_digest,revision,authority_epoch,state) VALUES(?,?,?,?)`)
    .bind(ownerDigest, 1, 1, "active").run();
}

async function effectiveOwnerPin(ownerDigest: string): Promise<{ ownerRevision: number; authorityEpoch: number }> {
  const row = await db().prepare("SELECT revision,authority_epoch FROM storage_owner_revisions WHERE owner_digest=?")
    .bind(ownerDigest).first<{ revision: number; authority_epoch: number }>();
  if (!row) throw new Error("synthetic v12 owner missing");
  return { ownerRevision: row.revision, authorityEpoch: row.authority_epoch };
}

it("bounds fixed 200 v1.2 occurrence IDs as unrelated same-owner chunks grow", async () => {
  const primary = await createV11DeviceFixture(db());
  const crossDay = await createV11DeviceFixture(db(), { participantId: primary.participantId });
  const foreign = await createV11DeviceFixture(db());
  const consent = telemetryV12RequiredConsent();
  for (const device of [primary, crossDay, foreign])
    await grantTelemetryV12Consent(db(), device, consent, Date.now());
  const ownerDigest = "a".repeat(64);
  await owner(primary.participantId, ownerDigest);
  await owner(foreign.participantId, "b".repeat(64));
  const ids = Array.from({ length: 200 }, (_, index) =>
    `event:v2:${(index + 1).toString(16).padStart(64, "0")}`);
  await acceptDay(primary, selectedDay, ids.map(id => usage(id, selectedDay)), 200);
  let crossDayManifests = await acceptDay(crossDay, unrelatedDay,
    [usage(ids[199]!, unrelatedDay)], 1);
  await acceptDay(foreign, selectedDay, [usage(ids[0]!, selectedDay)], 1);

  const snapshots: { unrelatedChunks: number; sourceRowsRead: number; batchRowsRead: readonly number[] }[] = [];
  const explainSnapshots: { unrelatedChunks: number; plans: readonly (readonly string[])[] }[] = [];
  let baseline: readonly unknown[] | undefined;
  let baselinePublicRows: readonly unknown[] | undefined;
  const measure = async (unrelatedChunks: number) => {
    let sourceRowsRead = 0;
    let sourceQueries = 0;
    const batchRowsRead: number[] = [];
    const bindCounts: number[] = [];
    const expansions: { sql: string; values: unknown[] }[] = [];
    const observed = new Proxy(db(), { get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const selected = sql.includes("WITH requested(occurrence_id) AS MATERIALIZED");
        const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
          get(inner, member) {
            if (member === "bind") return (...values: unknown[]) => {
              if (selected) {
                bindCounts.push(values.length);
                expansions.push({ sql, values });
              }
              return wrap(inner.bind(...values));
            };
            if (member === "all") return async () => {
              const result = await inner.all();
              if (selected) {
                sourceQueries += 1;
                sourceRowsRead += result.meta.rows_read;
                batchRowsRead.push(result.meta.rows_read);
              }
              return result;
            };
            const value = Reflect.get(inner, member);
            return typeof value === "function" ? value.bind(inner) : value;
          },
        });
        return wrap(target.prepare(sql));
      };
    } });
    const meter = createD1InvocationBudget(950);
    const result = await readTelemetryV12EffectiveOccurrences(meter.wrap(observed), {
      participantId: primary.participantId, stream: "usage", occurrenceIds: [...ids].reverse(),
    });
    expect(result.available).toBe(true);
    expect(result.records).toHaveLength(201);
    expect(result.records.map(row => row.occurrenceId)).toEqual([...ids, ids[199]]);
    expect(result.records.filter(row => row.occurrenceId === ids[199])).toHaveLength(2);
    expect(result.records.filter(row => row.occurrenceId === ids[0])).toHaveLength(1);
    const expectedSource = ids.flatMap((id, index) => index === 199
      ? [canonicalTelemetryV12Json(usage(id, selectedDay)),
        canonicalTelemetryV12Json(usage(id, unrelatedDay))]
      : [canonicalTelemetryV12Json(usage(id, selectedDay))]);
    expect(result.records.map(row => row.sourceRecordJson)).toEqual(expectedSource);
    if (baseline) expect(result.records).toEqual(baseline);
    else baseline = result.records;
    expect(sourceQueries).toBe(3);
    expect(meter.queriesUsed).toBe(1 + sourceQueries);
    expect(bindCounts).toEqual([84, 84, 44]);
    expect(bindCounts.every(count => count <= 100)).toBe(true);
    expect(Number.isSafeInteger(sourceRowsRead)).toBe(true);
    const plans = await Promise.all(expansions.map(async ({ sql, values }) =>
      (await db().prepare("EXPLAIN QUERY PLAN " + sql)
        .bind(...values).all<{ detail: string }>()).results.map(row => row.detail)));
    for (const plan of plans) {
      expect(plan.some(detail => /SEARCH r USING (?:COVERING )?INDEX .*\(manifest_id=\? AND stream=\? AND occurrence_id=\?\)/u.test(detail)))
        .toBe(true);
      expect(plan.some(detail => /SEARCH complete USING COVERING INDEX .*\(chunk_id=\?\)/u.test(detail)))
        .toBe(true);
      expect(plan.some(detail => /MATERIALIZE complete_chunks/u.test(detail))).toBe(true);
      const chunkAccess = plan.filter(detail => /\b(?:SEARCH|SCAN) chunk\b/u.test(detail));
      expect(chunkAccess.length).toBeGreaterThan(0);
      expect(chunkAccess.every(detail => /\bSEARCH chunk USING (?:COVERING )?INDEX .*\(id=\?\)/u.test(detail)))
        .toBe(true);
    }
    explainSnapshots.push({ unrelatedChunks, plans });
    snapshots.push({ unrelatedChunks, sourceRowsRead, batchRowsRead });
    const publicPage = await readEffectiveUsageOwnerDayPage(db(), {
      sourceNamespace: "synthetic-v12-scaling-source", ownerDigest,
      ...await effectiveOwnerPin(ownerDigest),
      day: selectedDay, limit: 200,
    });
    expect(publicPage.rows.map(row => row.occurrenceId)).toEqual(ids);
    expect(publicPage.rows[199]).toMatchObject({ sourceCount: 2, eventTimeConflict: true });
    if (baselinePublicRows) expect(publicPage.rows).toEqual(baselinePublicRows);
    else baselinePublicRows = publicPage.rows;
  };
  await measure(0);
  for (const [count, start, nextDay] of [[128, 10_000, "2026-09-22"],
    [896, 20_000, "2026-09-23"]] as const) {
    crossDayManifests = await acceptDay(crossDay, nextDay,
      Array.from({ length: count }, (_, index) => usage(
        `event:v2:${(start + index).toString(16).padStart(64, "0")}`, nextDay)),
      1, crossDayManifests);
    await measure(count === 128 ? 128 : 1_024);
  }
  console.info("v12-effective-occurrence-chunk-scaling", snapshots);
  console.info("v12-effective-occurrence-literal-explain", JSON.stringify(explainSnapshots));
  const [base, medium, large] = snapshots;
  expect([base?.unrelatedChunks, medium?.unrelatedChunks, large?.unrelatedChunks])
    .toEqual([0, 128, 1_024]);
  for (const sample of [medium!, large!])
    expect(sample.sourceRowsRead - base!.sourceRowsRead).toBeLessThanOrEqual(512);
}, 240_000);
