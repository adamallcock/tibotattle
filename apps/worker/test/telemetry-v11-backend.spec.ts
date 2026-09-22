import { env, applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import {
  canonicalTelemetryV11Json,
  telemetryV11RequiredConsent,
} from "@app-usagemonitor/telemetry-contract";
import { sha256Hex } from "../src/crypto";
import { authenticateDevice, claimDeviceUploadAuthorization, createDeviceUploadAuthorization } from "../src/device-auth";
import { createD1TelemetryV11Backend } from "../src/d1-telemetry-v11-backend";
import { createV11DeviceFixture, makeV11Day, v11UsageRecord } from "./helpers/telemetry-v11";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
}

const bindings = () => env as TestBindings;
const db = () => bindings().USAGE_MONITOR_DB;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), bindings().TEST_MIGRATIONS);
});

it("uses the same v1.1 port for D1 manifest, exact lease chunk and ready reads", async () => {
  const fixture = await createV11DeviceFixture(db(), { grant: true });
  const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const prepared = await makeV11Day(day, { usage: [v11UsageRecord(day)] });
  const principal = { participantId: fixture.participantId, deviceId: fixture.deviceId };
  const backend = createD1TelemetryV11Backend(db());

  await expect(backend.registerDayManifest(principal, prepared.manifest)).resolves.toMatchObject({
    state: "staged",
    expectedChunks: 1,
  });
  const rawEnvelope = canonicalTelemetryV11Json({ syntheticTestEnvelope: prepared.chunks[0]!.chunkDigest });
  const envelopeDigest = await sha256Hex(rawEnvelope);
  const authorization = await createDeviceUploadAuthorization(
    db(), await authenticateDevice(db(), fixture.authorization), envelopeDigest,
    new TextEncoder().encode(rawEnvelope).byteLength,
  );
  const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${authorization.uploadAuthorization}`, {
    envelopeDigest,
    bodyBytes: new TextEncoder().encode(rawEnvelope).byteLength,
    contentType: "application/json",
  });
  const metadata = {
    chunkRowId: `chunk:${crypto.randomUUID()}`,
    objectKey: `telemetry/v11/d1-${crypto.randomUUID()}`,
    envelopeDigest,
    deviceUploadAuthorizationId: claimed.authorizationId,
    uploadAuthorizationLeaseExpiresAt: claimed.leaseExpiresAt,
  };
  expect((await db().prepare("SELECT consume_lease_expires_at FROM device_upload_authorizations WHERE id = ?")
    .bind(claimed.authorizationId).first<{ consume_lease_expires_at: string }>())?.consume_lease_expires_at)
    .toBe(claimed.leaseExpiresAt);
  await expect(backend.persistChunk(principal, prepared.chunks[0], metadata)).resolves.toMatchObject({ replay: false });
  await expect(backend.persistChunk(principal, prepared.chunks[0], metadata)).resolves.toMatchObject({ replay: true });
  const candidates = await backend.readDayCandidates(principal, { fromDay: day, toDay: day });
  expect(candidates).toMatchObject({ bounded: false, candidates: [{ state: "ready", expectedChunks: 1 }] });
  await expect(backend.loadReadyDayVector(principal, [{
    day,
    manifestId: candidates.candidates[0]!.manifestId,
    manifestDigest: prepared.manifest.manifestDigest,
  }])).resolves.toHaveLength(1);
  expect((await db().prepare("SELECT state FROM device_upload_authorizations WHERE id = ?")
    .bind(claimed.authorizationId).first<{ state: string }>())?.state).toBe("consumed");
});

it("fences a stale D1 lease before the chunk journal can be written", async () => {
  const fixture = await createV11DeviceFixture(db(), { grant: true });
  const day = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const prepared = await makeV11Day(day, { usage: [v11UsageRecord(day, "b")] });
  const principal = { participantId: fixture.participantId, deviceId: fixture.deviceId };
  const backend = createD1TelemetryV11Backend(db());
  await backend.registerDayManifest(principal, prepared.manifest);
  const rawEnvelope = canonicalTelemetryV11Json({ syntheticTestEnvelope: prepared.chunks[0]!.chunkDigest });
  const envelopeDigest = await sha256Hex(rawEnvelope);
  const authorization = await createDeviceUploadAuthorization(
    db(), await authenticateDevice(db(), fixture.authorization), envelopeDigest,
    new TextEncoder().encode(rawEnvelope).byteLength,
  );
  const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${authorization.uploadAuthorization}`, {
    envelopeDigest,
    bodyBytes: new TextEncoder().encode(rawEnvelope).byteLength,
    contentType: "application/json",
  });
  await db().prepare(`UPDATE device_upload_authorizations
    SET consume_lease_expires_at = ? WHERE id = ?`)
    .bind(new Date(Date.now() + 60 * 60 * 1000).toISOString(), claimed.authorizationId).run();
  await expect(backend.persistChunk(principal, prepared.chunks[0], {
    chunkRowId: `chunk:${crypto.randomUUID()}`,
    objectKey: `telemetry/v11/d1-stale-${crypto.randomUUID()}`,
    envelopeDigest,
    deviceUploadAuthorizationId: claimed.authorizationId,
    uploadAuthorizationLeaseExpiresAt: claimed.leaseExpiresAt,
  })).rejects.toMatchObject({ code: "UPLOAD_AUTH_INVALID" });
  expect((await db().prepare("SELECT count(*) AS n FROM telemetry_v11_chunks").first<{ n: number }>())?.n).toBe(0);
});
