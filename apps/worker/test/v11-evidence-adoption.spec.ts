import { env, reset, applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { telemetryV11DomainManifestDigestInput, type TelemetryV11DomainManifest } from "@app-usagemonitor/telemetry-contract";
import { authenticateDevice, createDeviceUploadAuthorization, claimDeviceUploadAuthorization } from "../src/device-auth";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { handleRequest } from "../src/index";
import { initializeStorageSource } from "../src/analytics-delivery";
import { initializeTypedV11Admission, persistTypedV11StagedChunk } from "../src/typed-v11-admission";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";
import { registerTelemetryV11DayManifest } from "../src/telemetry-v11-repository";
import { activateTelemetryV11Domain, createTelemetryV11DomainPredecessor } from "../src/telemetry-v11-domain";
import { revokeAccountlessEnrollment } from "../src/accountless-enrollment";
import { grantTelemetryV12AccountlessAuthorization } from "../src/telemetry-transport-policy";
import { makeV11Day, v11UsageRecord } from "./helpers/telemetry-v11";
import { ownerErasureRequest } from "./helpers/owner-erasure";
import { adoptV11UploadedEvidence, adoptV11UploadedEvidenceAsOwner, parseV11EvidenceAdoptionRequest }
  from "../src/v11-evidence-adoption";

interface Bindings extends Env { TEST_MIGRATIONS: D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[]; TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[]; TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[] }
const b = env as Bindings, source = () => b.USAGE_MONITOR_DB;
const sourceId = "synthetic-adoption-source", namespace = "synthetic-adoption-namespace";
const runtime = () => ({ ...b, ENVIRONMENT: "synthetic-development", ACCOUNT_SCOPED_INGEST_MODE: "disabled",
  ACCOUNTLESS_ENROLLMENT_MODE: "enabled", ACCOUNTLESS_OWNERSHIP_MODE: "enabled" } as Env);
const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

beforeEach(async () => {
  await reset();
  await applyD1Migrations(source(), b.TEST_MIGRATIONS);
  await applyD1Migrations(source(), b.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(source(), b.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(source(), b.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await initializeStorageSource(source(), sourceId);
  await applyD1Migrations(source(), b.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await initializeTypedV11Admission(source(), namespace);
  await initializeTypedV1Admission(source(), namespace);
  await applyD1Migrations(source(), b.TEST_INGESTION_ISOLATION_MIGRATIONS);
  await source().prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
});

type Device = { participantId: string; deviceId: string; authorization: string };

async function accountlessDevice(): Promise<Device> {
  const deviceId = crypto.randomUUID(), secret = crypto.getRandomValues(new Uint8Array(32));
  const prefix = new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`);
  const bytes = new Uint8Array(prefix.length + secret.length); bytes.set(prefix); bytes.set(secret, prefix.length);
  const deviceSecretHash = await sha256Hex(bytes), authorization = `Device um_device_${deviceId}.${encodeBase64Url(secret)}`;
  bytes.fill(0); secret.fill(0);
  const request = (path: string, body: object, auth = "") => handleRequest(new Request(`https://adoption.example.test${path}`, {
    method: "POST", headers: { origin: "https://adoption.example.test", "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  }), runtime());
  expect((await request("/api/v1/accountless/enrollment", { schemaVersion: "accountless-enrollment-v0.1", deviceId, deviceSecretHash,
    policyVersion: "accountless-opt-out-v1", authorizationBasis: "accountless-policy-v1" })).status).toBe(201);
  expect((await request("/api/v1/accountless/ownership", { schemaVersion: "accountless-upload-owner-v0.1", policyVersion: "accountless-opt-out-v1",
    authorizationBasis: "accountless-policy-v1", telemetrySchemaVersion: "telemetry-contribution-v1.1" }, authorization)).status).toBe(201);
  const participantId = (await source().prepare("SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id=?")
    .bind(deviceId).first<string>("participant_id"))!;
  return { participantId, deviceId, authorization };
}

/** Upload one day as the client does. With `complete: false` the manifest is
 * registered but one chunk never arrives, as when a pass is cut off. */
async function uploadDay(device: Device, observedDay: string, events: number[], complete = true, parser = "synthetic-v11") {
  const prepared = await makeV11Day(observedDay, { usage: events.map((n) =>
    v11UsageRecord(observedDay, "a", { eventId: `event:v2:${observedDay.replaceAll("-", "")}${n.toString(16).padStart(56, "0")}`,
      eventTime: `${observedDay}T12:${String(n % 60).padStart(2, "0")}:00.000Z` })) }, parser);
  const registered = await registerTelemetryV11DayManifest(source(), device, prepared.manifest);
  for (const chunk of complete ? prepared.chunks : prepared.chunks.slice(0, -1)) {
    const envelopeDigest = await sha256Hex(`synthetic-adoption:${crypto.randomUUID()}`);
    const auth = await authenticateDevice(source(), device.authorization);
    const upload = await createDeviceUploadAuthorization(source(), auth, envelopeDigest, 200);
    const claimed = await claimDeviceUploadAuthorization(source(), `Upload ${upload.uploadAuthorization}`,
      { envelopeDigest, bodyBytes: 200, contentType: "application/json" });
    await persistTypedV11StagedChunk(source(), device, chunk, { sourceNamespace: namespace, chunkRowId: `chunk:${crypto.randomUUID()}`,
      r2Key: `synthetic/${crypto.randomUUID()}`, envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId });
  }
  return registered;
}

/** The client's own activation of exactly these days, at `nowEpoch`. */
async function clientActivate(device: Device, days: Array<{ day: string; manifestId: string; manifestDigest: string }>,
  nowEpoch = Date.now()) {
  const prior = await createTelemetryV11DomainPredecessor(source(), device, nowEpoch);
  const manifest: TelemetryV11DomainManifest = { schemaVersion: "telemetry-domain-manifest-v1.1",
    fromDay: days[0]!.day, throughDay: days.at(-1)!.day,
    predecessor: { token: prior.token, previousGenerationId: prior.previousGenerationId, legacyFingerprint: prior.legacyFingerprint },
    days, manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = await sha256Hex(telemetryV11DomainManifestDigestInput(manifest));
  return activateTelemetryV11Domain(source(), device, manifest, nowEpoch);
}

/** A moment on the previous UTC day that is past any client pass window and
 * inside the predecessor's 24-hour life, so a head can end before today. */
const yesterdayEpoch = () => Math.min(Date.parse(`${day(0)}T00:00:00.000Z`) - 1, Date.now() - 11 * 60_000);

const headDays = async (participantId: string) => (await source().prepare(`SELECT dd.observed_day AS day, dd.manifest_id AS manifestId
  FROM telemetry_v11_domain_heads h JOIN telemetry_v11_domain_days dd ON dd.generation_id=h.generation_id
  WHERE h.participant_id=? ORDER BY dd.observed_day`).bind(participantId).all<{ day: string; manifestId: string }>()).results;
const request = (dryRun: boolean) => ({ dryRun, maxDevices: 10, afterParticipantId: null });

describe("owner adoption of accepted v1.1 uploads", () => {
  it("previews, then activates the complete run of a device that never activated", async () => {
    const device = await accountlessDevice();
    for (const offset of [5, 4, 3]) await uploadDay(device, day(offset), [1, 2]);
    await uploadDay(device, day(2), [1, 2, 3], false);

    const preview = await adoptV11UploadedEvidence(source(), request(true));
    expect(preview).toMatchObject({ dryRun: true, examined: 1, daysCovered: 3, newDays: 3,
      outcomes: { adoptable: 1, adopted: 0 } });
    expect(await headDays(device.participantId)).toEqual([]);

    const applied = await adoptV11UploadedEvidence(source(), request(false));
    expect(applied).toMatchObject({ examined: 1, daysCovered: 3, outcomes: { adopted: 1, refused: 0 } });
    expect((await headDays(device.participantId)).map((row) => row.day)).toEqual([day(5), day(4), day(3)]);
    // The ordinary v1.1 bridge journaled it, so analytics will fold it.
    expect(await source().prepare("SELECT count(*) AS n FROM storage_v11_owner_links WHERE participant_id=? AND state='active'")
      .bind(device.participantId).first("n")).toBe(1);
    expect(await source().prepare("SELECT count(*) AS n FROM community_public_source_owners WHERE participant_id=?")
      .bind(device.participantId).first("n")).toBe(1);

    // Nothing new is complete: a second run changes nothing.
    const again = await adoptV11UploadedEvidence(source(), request(false));
    expect(again).toMatchObject({ examined: 0, outcomes: { adopted: 0 } });
  });

  it("extends a stuck head, keeping an accepted day whose newer upload drops a record", async () => {
    const device = await accountlessDevice();
    const accepted = [];
    for (const offset of [4, 3, 2, 1]) accepted.push(await uploadDay(device, day(offset), [1, 2]));
    await clientActivate(device, accepted.map((m) => ({ day: m.day, manifestId: m.manifestId, manifestDigest: m.manifestDigest })),
      yesterdayEpoch());
    // The client re-emits day(3) without an accepted record, so its own
    // activation fails the preservation proof; day(2) gains one; today is new.
    const dropped = await uploadDay(device, day(3), [1]);
    const grown = await uploadDay(device, day(2), [1, 2, 5]);
    const today = await uploadDay(device, day(0), [7]);
    await expect(clientActivate(device, [accepted[0]!, dropped, grown, accepted[3]!, today]
      .map((m) => ({ day: m.day, manifestId: m.manifestId, manifestDigest: m.manifestDigest }))))
      .rejects.toMatchObject({ code: "TELEMETRY_COMPATIBILITY_PROOF_UNAVAILABLE" });

    // The refused pass may still be running; eleven minutes later it is over.
    expect(await adoptV11UploadedEvidence(source(), request(false))).toMatchObject({ outcomes: { client_syncing: 1 } });
    const later = Date.now() + 11 * 60_000;
    const applied = await adoptV11UploadedEvidence(source(), request(false), later);
    expect(applied).toMatchObject({ outcomes: { adopted: 1, refused: 0 }, daysCovered: 5, newDays: 1, keptAcceptedDays: 1 });
    const head = await headDays(device.participantId);
    expect(head.map((row) => row.day)).toEqual([day(4), day(3), day(2), day(1), day(0)]);
    expect(head.find((row) => row.day === day(3))!.manifestId).toBe(accepted[1]!.manifestId);
    expect(head.find((row) => row.day === day(2))!.manifestId).toBe(grown.manifestId);

    // Only the refused re-emission remains outside the head, so a rerun changes nothing.
    expect(await adoptV11UploadedEvidence(source(), request(false), later)).toMatchObject({ examined: 1, outcomes: { unchanged: 1 } });
  });

  it("leaves an opted-out device alone", async () => {
    const device = await accountlessDevice();
    await uploadDay(device, day(3), [1]);
    await revokeAccountlessEnrollment(source(), device.deviceId, "user_opt_out");
    const applied = await adoptV11UploadedEvidence(source(), request(false));
    expect(applied.outcomes.adopted).toBe(0);
    expect(await headDays(device.participantId)).toEqual([]);
  });

  it("prunes a stuck client's oldest open predecessors, as the client does, instead of refusing at the cap", async () => {
    const device = await accountlessDevice();
    await uploadDay(device, day(3), [1]);
    // Every failed pass leaves an open predecessor; the table holds at most eight.
    const earlier = Date.now() - 30 * 60_000;
    for (let n = 0; n < 8; n += 1) await createTelemetryV11DomainPredecessor(source(), device, earlier + n * 1_000);
    const open = async () => source().prepare(`SELECT count(*) AS n FROM telemetry_v11_domain_predecessors
      WHERE participant_id = ? AND consumed_at IS NULL`).bind(device.participantId).first("n");
    expect(await open()).toBe(8);
    expect(await adoptV11UploadedEvidence(source(), request(false))).toMatchObject({ outcomes: { adopted: 1, refused: 0 } });
    expect((await headDays(device.participantId)).map((row) => row.day)).toEqual([day(3)]);
    // Still bounded: the client's seven newest stay open; adoption's own was consumed.
    expect(await open()).toBe(7);
  });

  it("leaves a device alone while its client may be mid-pass", async () => {
    const device = await accountlessDevice();
    await uploadDay(device, day(3), [1]);
    await createTelemetryV11DomainPredecessor(source(), device);
    expect(await adoptV11UploadedEvidence(source(), request(false))).toMatchObject({ outcomes: { client_syncing: 1, adopted: 0 } });
    expect(await headDays(device.participantId)).toEqual([]);
  });

  it("leaves a device that has moved to v1.2 to its client", async () => {
    const device = await accountlessDevice();
    await uploadDay(device, day(3), [1]);
    await source().prepare("UPDATE telemetry_v12_runtime SET state='active',changed_at=? WHERE id=1").bind(new Date().toISOString()).run();
    await grantTelemetryV12AccountlessAuthorization(source(), device, {
      schemaVersion: "accountless-upload-owner-v1.2", policyVersion: "accountless-telemetry-v1.2-policy-v1",
      authorizationBasis: "accountless-policy-v1.2", telemetrySchemaVersion: "telemetry-contribution-v1.2" });
    expect(await adoptV11UploadedEvidence(source(), request(false))).toMatchObject({ outcomes: { successor_active: 1, adopted: 0 } });
    expect(await headDays(device.participantId)).toEqual([]);
  });

  it("pages through devices with a bounded cursor", async () => {
    const devices = [await accountlessDevice(), await accountlessDevice(), await accountlessDevice()];
    for (const device of devices) await uploadDay(device, day(3), [1]);
    const ordered = devices.map((device) => device.participantId).sort();
    const first = await adoptV11UploadedEvidence(source(), { dryRun: true, maxDevices: 2, afterParticipantId: null });
    expect(first).toMatchObject({ examined: 2, outcomes: { adoptable: 2 }, nextAfterParticipantId: ordered[1] });
    const second = await adoptV11UploadedEvidence(source(), { dryRun: true, maxDevices: 2, afterParticipantId: first.nextAfterParticipantId });
    expect(second).toMatchObject({ examined: 1, outcomes: { adoptable: 1 }, nextAfterParticipantId: null });
  });

  it("is reachable only through the Access-owner admin action with its CSRF header", async () => {
    const device = await accountlessDevice();
    await uploadDay(device, day(3), [1]);
    const owner = await ownerErasureRequest(runtime(), device.participantId);
    const send = (body: unknown, drop?: string) => {
      const headers = new Headers(owner.request.headers);
      if (drop) headers.delete(drop);
      return handleRequest(new Request(owner.request.url, { method: "POST", headers, body: JSON.stringify(body) }), owner.runtimeEnv);
    };
    const body = { action: "run_maintenance", v11EvidenceAdoption: { dryRun: true } };
    expect((await send(body, "cf-access-jwt-assertion")).status).not.toBe(200);
    expect((await send(body, "x-usage-monitor-admin")).status).toBe(403);
    expect((await send({ action: "run_maintenance", v11EvidenceAdoption: { dryRun: "no" } })).status).toBe(400);
    const response = await send(body);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ schemaVersion: "admin-action-v0.1", action: "run_maintenance",
      result: { task: "v11_evidence_adoption", dryRun: true, outcomes: { adoptable: 1 } } });
    expect(await headDays(device.participantId)).toEqual([]);
  });

  it("audits the owner operation with counts only and validates its request", async () => {
    const device = await accountlessDevice();
    await uploadDay(device, day(3), [1]);
    const result = await adoptV11UploadedEvidenceAsOwner(source(), "owner@example.test", request(true));
    expect(result).toMatchObject({ task: "v11_evidence_adoption", outcomes: { adoptable: 1 } });
    const audit = await source().prepare("SELECT action, outcome, details_json FROM admin_action_audit ORDER BY id DESC LIMIT 1")
      .first<{ action: string; outcome: string; details_json: string }>();
    expect(audit).toMatchObject({ action: "run_maintenance", outcome: "success" });
    for (const value of [device.participantId, device.deviceId]) expect(audit!.details_json).not.toContain(value);
    const body = (target: unknown, extra: object = {}) => ({ action: "run_maintenance", v11EvidenceAdoption: target, ...extra });
    for (const invalid of [body({ dryRun: "yes" }), body({ dryRun: true, maxDevices: 26 }), body({ dryRun: true, extra: 1 }),
      body({ dryRun: true, afterParticipantId: "not a participant" }), body({ dryRun: true }, { participantErasure: {} }),
      { action: "export", v11EvidenceAdoption: { dryRun: true } }]) {
      expect(() => parseV11EvidenceAdoptionRequest(invalid)).toThrow();
    }
    expect(parseV11EvidenceAdoptionRequest(body({ dryRun: false })))
      .toEqual({ dryRun: false, maxDevices: 10, afterParticipantId: null });
  });
});
