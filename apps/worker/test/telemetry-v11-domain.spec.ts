import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalTelemetryV11Json, telemetryV11DomainManifestDigestInput, telemetryV11DayManifestDigestInput, telemetryV11RequiredConsent,
  type TelemetryV11QuotaObservation, type TelemetryV11DomainManifest } from "@app-usagemonitor/telemetry-contract";
import { createV11DeviceFixture, makeV11Day, stageV11Day, v11UsageRecord } from "./helpers/telemetry-v11";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor, loadV11SourcePin, assertV11SourcePinCurrent } from "../src/telemetry-v11-domain";
import { telemetryV11LegacyProjection } from "../src/telemetry-v11-repository";
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from "../src/device-auth";
import { grantTelemetryV11Consent, rollbackTelemetryTransportAsOwner } from "../src/telemetry-transport-policy";
import { insertTelemetryV1Chunk } from "../src/telemetry-v1-repository";
import { parseTelemetryV1Chunk } from "../src/telemetry-v1";
import { sha256Hex } from "../src/crypto";
import { loadV1SourcePin } from "../src/telemetry-v1-source-selection";
import { accountScopedModelCompositionV1, accountScopedQuotaAnalysisV1 } from "../src/quota-analysis-v1";

interface Bindings extends Env { TEST_MIGRATIONS: D1Migration[]; }
const db = () => (env as Bindings).USAGE_MONITOR_DB;
const today = () => new Date().toISOString().slice(0, 10);
const beforeDay = (day: string) => new Date(Date.parse(day) - 86_400_000).toISOString().slice(0, 10);

beforeEach(async () => { await reset(); await applyD1Migrations(db(), (env as Bindings).TEST_MIGRATIONS); });

async function enable(fixture: Awaited<ReturnType<typeof createV11DeviceFixture>>) {
  await db().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
  await grantTelemetryV11Consent(db(), fixture, telemetryV11RequiredConsent());
}

async function domain(fixture: Awaited<ReturnType<typeof createV11DeviceFixture>>,
  days: Awaited<ReturnType<typeof stageV11Day>>[],
  predecessor = undefined as Awaited<ReturnType<typeof createTelemetryV11DomainPredecessor>> | undefined,
): Promise<TelemetryV11DomainManifest> {
  const prior = predecessor ?? await createTelemetryV11DomainPredecessor(db(), fixture);
  const sorted = [...days].sort((a,b) => a.day.localeCompare(b.day));
  const value: TelemetryV11DomainManifest = {schemaVersion: "telemetry-domain-manifest-v1.1",
    fromDay: sorted[0]!.day, throughDay: sorted.at(-1)!.day,
    predecessor: {token: prior.token, previousGenerationId: prior.previousGenerationId, legacyFingerprint: prior.legacyFingerprint},
    days: sorted.map((day) => ({day: day.day, manifestId: day.manifestId, manifestDigest: day.manifestDigest})),
    manifestDigest: "0".repeat(64)};
  value.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(value));
  return value;
}

async function legacyUsage(fixture: Awaited<ReturnType<typeof createV11DeviceFixture>>, day: string, fills = ["a"]) {
  const records = fills.map((fill) => {
    const projection = telemetryV11LegacyProjection("usage", v11UsageRecord(day, fill));
    if (projection === null) throw new Error("Synthetic legacy usage must have a v1 counterpart");
    return JSON.parse(projection.canonicalRecord);
  });
  const envelopeDigest = await sha256Hex(`synthetic-legacy:${crypto.randomUUID()}`);
  const principal = await authenticateDevice(db(), fixture.authorization);
  const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, 200);
  const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`,
    {envelopeDigest, bodyBytes: 200, contentType: "application/json"});
  const chunk = parseTelemetryV1Chunk({schemaVersion: "telemetry-contribution-v1.0", chunkId: `usage:${day}:0`,
    chunkRevision: 1, chunkDigest: await sha256Hex(canonicalTelemetryV11Json(records)), parserVersion: "synthetic-v1",
    consent: {telemetrySchemaVersion: "telemetry-contribution-v1.0", fieldDictionaryVersion: "telemetry-v1.0-registry-2026-08-07.1",
      privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0"}, records});
  const id = `chunk:${crypto.randomUUID()}`;
  await insertTelemetryV1Chunk(db(), {chunkRowId: id, participantId: fixture.participantId, deviceId: fixture.deviceId,
    chunk, envelopeDigest, r2Key: `synthetic/legacy-${crypto.randomUUID()}`, deviceUploadAuthorizationId: claimed.authorizationId,
    createdAt: new Date().toISOString(), supersedes: null});
  return id;
}

describe("complete attribution domain activation", () => {
  it("boots from a null predecessor, remains staged until complete, then switches every consumer atomically", async () => {
    const fixture = await createV11DeviceFixture(db());
    const day = today();
    await legacyUsage(fixture, day);
    await enable(fixture);
    const prior = await createTelemetryV11DomainPredecessor(db(), fixture);
    expect(prior.previousGenerationId).toBeNull();
    expect(prior.legacyFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    const quota: TelemetryV11QuotaObservation = {schemaVersion: "quota-observation-v1.1",
      observationId: `quota-occurrence:v1:${"b".repeat(64)}`, observedTime: `${day}T12:05:00.000Z`,
      provider: "openai_codex", planType: "pro", planVariant: "unknown", limitId: "codex", slot: "seven_day",
      usedPercent: 40, windowDurationMinutes: 10080, resetsAt: `${new Date(Date.parse(day)+7*86400000).toISOString().slice(0,10)}T12:00:00.000Z`,
      accountPlanAttribution: {accountBasis: "unavailable", accountTrackId: null,
        planBasis: "same_source_occurrence", planType: "pro", planEraId: null}};
    const prepared = await makeV11Day(day, {usage: [v11UsageRecord(day)], quota: [quota]});
    const staged = await stageV11Day(db(), fixture, {...prepared, chunks: prepared.chunks.slice(0,1)});
    expect(staged.state).toBe("staged");
    expect(await loadV11SourcePin(db(), fixture.participantId)).toBeNull();
    const manifest = await domain(fixture, [staged], prior);
    await expect(activateTelemetryV11Domain(db(), fixture, manifest)).rejects.toMatchObject({code: "TELEMETRY_MANIFEST_INCOMPLETE"});
    expect(await db().prepare("SELECT count(*) AS n FROM telemetry_v11_domain_heads").first()).toEqual({n:0});
    const ready = await stageV11Day(db(), fixture, {...prepared, chunks: prepared.chunks.slice(1)});
    expect(ready.state).toBe("ready");
    const active = await activateTelemetryV11Domain(db(), fixture, manifest);
    expect(active.replay).toBe(false);
    expect((await loadV11SourcePin(db(), fixture.participantId))?.generationId).toBe(active.generationId);
    expect(await db().prepare("SELECT count(*) AS n FROM telemetry_v1_records").first()).toEqual({n:1});
    expect(await db().prepare("SELECT count(*) AS n FROM telemetry_analytical_records").first()).toEqual({n:2});
    const successorPin = await loadV1SourcePin(db(), {participantId: fixture.participantId});
    expect(successorPin.winners).toHaveLength(1);
    for (const analyze of [accountScopedQuotaAnalysisV1, accountScopedModelCompositionV1]) {
      await expect(analyze(db(),fixture.participantId)).rejects
        .toThrow("v1 analysis unavailable after v1.1 activation");
      await expect(analyze(db(),fixture.participantId,{sourcePin:successorPin})).rejects
        .toThrow("v1 analysis unavailable after v1.1 activation");
    }
    expect(await db().prepare("SELECT count(*) AS n FROM telemetry_v1_records").first()).toEqual({n:1});
    expect(await db().prepare("SELECT publication_state FROM community_allowance_publication_state WHERE singleton=1").first()).toEqual({publication_state:"updating"});
    expect(await db().prepare("SELECT day FROM community_daily_aggregate_rebuilds WHERE day=?").bind(day).first()).toEqual({day});
    expect(await activateTelemetryV11Domain(db(), fixture, manifest)).toEqual({...active,replay:true});
  });

  it("refuses missing legacy records even when excluded counts claim they were reviewed", async () => {
    const fixture = await createV11DeviceFixture(db()); const day = today();
    await legacyUsage(fixture, day, ["a","b"]); await enable(fixture);
    const prepared = await makeV11Day(day, {usage:[v11UsageRecord(day)]});
    prepared.manifest.excluded.usage = 1;
    const {telemetryV11DayManifestDigestInput} = await import("@app-usagemonitor/telemetry-contract");
    prepared.manifest.manifestDigest = await sha256Hex(telemetryV11DayManifestDigestInput(prepared.manifest));
    for (const chunk of prepared.chunks) chunk.manifestDigest = prepared.manifest.manifestDigest;
    const staged = await stageV11Day(db(), fixture, prepared);
    await expect(activateTelemetryV11Domain(db(), fixture, await domain(fixture,[staged])))
      .rejects.toMatchObject({code:"TELEMETRY_COMPATIBILITY_PROOF_UNAVAILABLE"});
    expect(await db().prepare("SELECT count(*) AS n FROM telemetry_analytical_records").first()).toEqual({n:2});
  });

  it("refuses changed base accounting under an unchanged occurrence identity", async () => {
    const fixture = await createV11DeviceFixture(db()); const day = today();
    await legacyUsage(fixture, day); await enable(fixture);
    const record = v11UsageRecord(day); record.components.inputUncachedTokens = 101;
    const staged = await stageV11Day(db(), fixture, await makeV11Day(day,{usage:[record]}));
    await expect(activateTelemetryV11Domain(db(),fixture,await domain(fixture,[staged])))
      .rejects.toMatchObject({code:"TELEMETRY_COMPATIBILITY_PROOF_UNAVAILABLE"});
    expect(await loadV11SourcePin(db(),fixture.participantId)).toBeNull();
  });

  it("rejects a source change after the predecessor snapshot without deleting the candidate", async () => {
    const fixture = await createV11DeviceFixture(db()); const day = today();
    const oldChunk = await legacyUsage(fixture,day); await enable(fixture);
    const staged = await stageV11Day(db(),fixture,await makeV11Day(day,{usage:[v11UsageRecord(day)]}));
    const manifest = await domain(fixture,[staged]);
    await db().prepare("UPDATE telemetry_v1_chunks SET chunk_digest=? WHERE id=?").bind("f".repeat(64),oldChunk).run();
    await expect(activateTelemetryV11Domain(db(),fixture,manifest)).rejects.toMatchObject({code:"TELEMETRY_MANIFEST_CONFLICT"});
    expect(await db().prepare("SELECT state FROM telemetry_v11_day_manifests WHERE id=?").bind(staged.manifestId).first()).toEqual({state:"ready"});
    expect(await loadV11SourcePin(db(),fixture.participantId)).toBeNull();
  });

  it("preserves the old active generation when its successor omits a known occurrence", async () => {
    const fixture = await createV11DeviceFixture(db(),{grant:true}); const day=today();
    const initial = await stageV11Day(db(),fixture,await makeV11Day(day,{usage:[v11UsageRecord(day)]}));
    const active = await activateTelemetryV11Domain(db(),fixture,await domain(fixture,[initial]));
    const pin = await loadV11SourcePin(db(),fixture.participantId);
    const empty = await stageV11Day(db(),fixture,await makeV11Day(day,{}));
    const manifest = await domain(fixture,[empty]);
    expect(manifest.predecessor.previousGenerationId).toBe(active.generationId);
    await expect(activateTelemetryV11Domain(db(),fixture,manifest)).rejects.toMatchObject({code:"TELEMETRY_COMPATIBILITY_PROOF_UNAVAILABLE"});
    await expect(assertV11SourcePinCurrent(db(),pin!)).resolves.toBeUndefined();
  });

  it("rejects one occurrence repeated across different candidate days", async () => {
    const fixture=await createV11DeviceFixture(db(),{grant:true}); const day=today(); const earlier=beforeDay(day);
    const left=await stageV11Day(db(),fixture,await makeV11Day(earlier,{usage:[v11UsageRecord(earlier)]}));
    const right=await stageV11Day(db(),fixture,await makeV11Day(day,{usage:[v11UsageRecord(day)]}));
    await expect(activateTelemetryV11Domain(db(),fixture,await domain(fixture,[left,right])))
      .rejects.toMatchObject({code:"TELEMETRY_OCCURRENCE_CONFLICT"});
  });

  it("does not permit a different participant or revoked device to consume a predecessor", async () => {
    const fixture=await createV11DeviceFixture(db(),{grant:true});
    const staged=await stageV11Day(db(),fixture,await makeV11Day(today(),{}));
    const manifest=await domain(fixture,[staged]);
    const other=await createV11DeviceFixture(db(),{grant:true});
    await expect(activateTelemetryV11Domain(db(),other,manifest)).rejects.toMatchObject({code:"TELEMETRY_MANIFEST_CONFLICT"});
    await db().prepare("UPDATE device_credentials SET state='revoked' WHERE id=?").bind(fixture.deviceId).run();
    await expect(activateTelemetryV11Domain(db(),fixture,manifest)).rejects.toMatchObject({code:"DEVICE_AUTH_INVALID"});
    expect(await loadV11SourcePin(db(),fixture.participantId)).toBeNull();
  });

  it("withdraws active data immediately on owner deletion and permits deletion-safe cascades", async () => {
    const fixture=await createV11DeviceFixture(db(),{grant:true});
    const staged=await stageV11Day(db(),fixture,await makeV11Day(today(),{usage:[v11UsageRecord(today())]}));
    await activateTelemetryV11Domain(db(),fixture,await domain(fixture,[staged]));
    const pin=await loadV11SourcePin(db(),fixture.participantId);
    await db().prepare("UPDATE participants SET state='deleting' WHERE id=?").bind(fixture.participantId).run();
    expect(await loadV11SourcePin(db(),fixture.participantId)).toBeNull();
    expect(await db().prepare("SELECT count(*) AS n FROM telemetry_v11_active_records").first()).toEqual({n:0});
    await expect(assertV11SourcePinCurrent(db(),pin!)).rejects.toThrow("changed");
    await db().prepare("DELETE FROM participants WHERE id=?").bind(fixture.participantId).run();
    for (const table of ["telemetry_v11_domain_heads","telemetry_v11_domains","telemetry_v11_domain_days","telemetry_v11_domain_predecessors"])
      expect(await db().prepare(`SELECT count(*) AS n FROM ${table}`).first()).toEqual({n:0});
  });

  it("acknowledges an unchanged vector without republishing or invalidating caches", async () => {
    const fixture=await createV11DeviceFixture(db(),{grant:true});
    const staged=await stageV11Day(db(),fixture,await makeV11Day(today(),{usage:[v11UsageRecord(today())]}));
    const first=await activateTelemetryV11Domain(db(),fixture,await domain(fixture,[staged]));
    const pin=await loadV11SourcePin(db(),fixture.participantId);
    const request=await domain(fixture,[staged]);
    expect(request.manifestDigest).not.toBe(first.manifestDigest);
    expect(await activateTelemetryV11Domain(db(),fixture,request)).toEqual({...first,replay:true,
      unchanged:true,requestedManifestDigest:request.manifestDigest});
    expect(await loadV11SourcePin(db(),fixture.participantId)).toEqual(pin);
    expect(await db().prepare("SELECT count(*) AS n FROM telemetry_v11_domains").first()).toEqual({n:1});
  });

  it("does not use the unchanged-vector shortcut after a legacy accounting correction", async () => {
    const fixture=await createV11DeviceFixture(db()); const day=today();
    await legacyUsage(fixture,day); await enable(fixture);
    const staged=await stageV11Day(db(),fixture,await makeV11Day(day,{usage:[v11UsageRecord(day)]}));
    const first=await activateTelemetryV11Domain(db(),fixture,await domain(fixture,[staged]));
    // A correction changes the source journal and its derived rows together,
    // like the production chunk replacement transaction (not out-of-band DB
    // tampering beneath an unchanged content digest).
    await db().batch([
      db().prepare(`UPDATE telemetry_v1_chunks SET chunk_digest = ? WHERE participant_id = ?`)
        .bind("f".repeat(64),fixture.participantId),
      db().prepare(`UPDATE telemetry_v1_records SET record_json = json_set(record_json,
        '$.components.inputUncachedTokens', 101) WHERE participant_id = ?`).bind(fixture.participantId),
    ]);
    await expect(activateTelemetryV11Domain(db(),fixture,await domain(fixture,[staged])))
      .rejects.toMatchObject({code:"TELEMETRY_COMPATIBILITY_PROOF_UNAVAILABLE"});
    expect((await loadV11SourcePin(db(),fixture.participantId))?.generationId).toBe(first.generationId);
  });

  it("keeps every analytical surface pinned after a floor rollback admits a different legacy day", async () => {
    const fixture=await createV11DeviceFixture(db(),{grant:true}); const day=today();
    const staged=await stageV11Day(db(),fixture,await makeV11Day(day,{usage:[v11UsageRecord(day)]}));
    const active=await activateTelemetryV11Domain(db(),fixture,await domain(fixture,[staged]));
    const floor=await db().prepare("SELECT revision FROM telemetry_transport_participant_floors WHERE participant_id=?")
      .bind(fixture.participantId).first<{revision:number}>();
    await rollbackTelemetryTransportAsOwner(db(),"synthetic-owner",{participantId:fixture.participantId,
      expectedRevision:floor!.revision,fromRank:11,toRank:10});
    await legacyUsage(fixture,beforeDay(day));
    expect(await db().prepare("SELECT count(*) AS n FROM telemetry_v1_records").first()).toEqual({n:1});
    expect(await db().prepare("SELECT count(*) AS n FROM telemetry_analytical_records").first()).toEqual({n:1});
    expect((await loadV1SourcePin(db(),{participantId:fixture.participantId})).winners.map(row=>row.observed_day)).toEqual([day]);
    expect((await loadV11SourcePin(db(),fixture.participantId))?.generationId).toBe(active.generationId);
    await expect(db().prepare("DELETE FROM telemetry_v11_domain_heads WHERE participant_id=?")
      .bind(fixture.participantId).run()).rejects.toThrow("telemetry_domain_active");
  });

  it("bounds abandoned predecessor tokens while allowing retry after more than eight attempts", async () => {
    const fixture=await createV11DeviceFixture(db(),{grant:true});
    const issued=[];
    for(let i=0;i<12;i++) issued.push(await createTelemetryV11DomainPredecessor(db(),fixture));
    expect(new Set(issued.map(value=>value.token)).size).toBe(12);
    expect(await db().prepare("SELECT count(*) AS n FROM telemetry_v11_domain_predecessors").first()).toEqual({n:8});
    const staged=await stageV11Day(db(),fixture,await makeV11Day(today(),{}));
    expect((await activateTelemetryV11Domain(db(),fixture,await domain(fixture,[staged],issued.at(-1)))).replay).toBe(false);
  });

  it("refuses an oversized replacement journal before scanning or activating its records", async () => {
    const fixture=await createV11DeviceFixture(db(),{grant:true});
    const candidates=[];
    for(let i=0;i<8;i++) {
      const day=new Date(Date.parse(today())-(7-i)*86400000).toISOString().slice(0,10);
      const prepared=await makeV11Day(day,{});
      prepared.manifest.chunks=Array.from({length:4096},(_,seq)=>({chunkId:`usage:${day}:${seq}`,
        chunkDigest:"c".repeat(64),recordCount:200}));
      prepared.manifest.manifestDigest=await sha256Hex(telemetryV11DayManifestDigestInput(prepared.manifest));
      candidates.push(await stageV11Day(db(),fixture,prepared));
    }
    await expect(activateTelemetryV11Domain(db(),fixture,await domain(fixture,candidates)))
      .rejects.toMatchObject({code:"SYNC_RANGE_TOO_LARGE"});
    expect(await db().prepare("SELECT count(*) AS n FROM telemetry_v11_domain_heads").first()).toEqual({n:0});
    expect(await db().prepare("SELECT count(*) AS n FROM telemetry_v11_day_manifests").first()).toEqual({n:8});
  });
});
