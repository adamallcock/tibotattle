import {
  canonicalTelemetryV11Json, parseTelemetryV11Chunk, parseTelemetryV11DayManifest,
  telemetryV11DayManifestDigestInput, telemetryV11RequiredConsent,
  TELEMETRY_V11_STREAMS, type TelemetryV11Chunk, type TelemetryV11DayManifest,
  type TelemetryV11Record, type TelemetryV11Stream, type TelemetryV11UsageEvent,
} from "@app-usagemonitor/telemetry-contract";
import { encodeBase64Url, sha256Hex } from "../../src/crypto";
import {
  authenticateDevice, claimDevicePairing, claimDeviceUploadAuthorization,
  createDevicePairing, createDeviceUploadAuthorization,
} from "../../src/device-auth";
import { createSessionMaterial, sessionCookie, sessionInsert } from "../../src/session";
import { grantTelemetryV11Consent } from "../../src/telemetry-transport-policy";
import { registerTelemetryV11DayManifest, persistTelemetryV11StagedChunk } from "../../src/telemetry-v11-repository";
import { putTrackedQuarantineObject } from "../../src/quarantine-reconciliation";

/** Synthetic local fixtures only. Accepted successor lifecycle is an explicit opt-in. */
export async function createV11DeviceFixture(db: D1Database, options: {
  nowEpoch?: number; participantId?: string; grant?: boolean;
} = {}) {
  const nowEpoch = options.nowEpoch ?? Date.now();
  const now = new Date(nowEpoch).toISOString();
  const participantId = options.participantId ?? `participant:${crypto.randomUUID()}`;
  const existingParticipant = await db.prepare("SELECT consent_version FROM participants WHERE id = ?")
    .bind(participantId).first<{ consent_version: string }>();
  if (!existingParticipant) {
    await db.prepare(`INSERT INTO participants (
      id, access_token_id, access_token_hash, recovery_token_id, recovery_token_hash,
      state, consent_version, consented_at, created_at
    ) VALUES (?, ?, ?, ?, ?, 'active', 'privacy-safe-telemetry-v0.1', ?, ?)`).bind(
      participantId, crypto.randomUUID(), new Uint8Array(32), crypto.randomUUID(), new Uint8Array(32), now, now,
    ).run();
  }
  const session = await createSessionMaterial(participantId, nowEpoch);
  await sessionInsert(db, session).run();
  const pairing = await createDevicePairing(db, participantId, session.id,
    existingParticipant?.consent_version ?? "privacy-safe-telemetry-v0.1",
    nowEpoch, {}, existingParticipant?.consent_version === "privacy-safe-telemetry-v0.2"
      ? "ongoing-privacy-safe-telemetry-v0.2" : "ongoing-privacy-safe-telemetry-v1.0");
  const deviceId = crypto.randomUUID();
  const rawSecret = crypto.getRandomValues(new Uint8Array(32));
  const prefix = new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`);
  const hashInput = new Uint8Array(prefix.length + rawSecret.length);
  hashInput.set(prefix); hashInput.set(rawSecret, prefix.length);
  const deviceSecretHash = await sha256Hex(hashInput);
  hashInput.fill(0);
  const authorization = `Device um_device_${deviceId}.${encodeBase64Url(rawSecret)}`;
  rawSecret.fill(0);
  await claimDevicePairing(db, `Pairing ${pairing.pairingCode}`, deviceId, deviceSecretHash, nowEpoch);
  const fixture = { participantId, deviceId, sessionId: session.id, authorization, nowEpoch,
    cookie: sessionCookie(session).split(";", 1)[0]!, csrfToken: session.csrfToken };
  if (options.grant === true) {
    await db.prepare("UPDATE telemetry_transport_formats SET lifecycle = 'accepted' WHERE schema_version = 'telemetry-contribution-v1.1'").run();
    await grantTelemetryV11Consent(db, fixture, telemetryV11RequiredConsent(), nowEpoch);
  }
  return fixture;
}

export function v11UsageRecord(day: string, fill = "a", overrides: Partial<TelemetryV11UsageEvent> = {}): TelemetryV11UsageEvent {
  return {
    schemaVersion: "usage-event-v1.1", eventId: `event:v2:${fill.repeat(64)}`,
    eventTime: `${day}T12:05:00.000Z`, sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
    provider: "openai_codex", modelId: "gpt-5.6-sol", speedMode: "standard", apiServiceTier: "default",
    surface: "local_interactive_unclassified", billingSurface: "chatgpt_subscription",
    reasoningEffort: "high", agentScope: "root", outcome: "completed", totalInputContextTokens: 1000,
    components: { inputUncachedTokens: 100, inputCacheReadTokens: 900, inputCacheWriteTokens: 0,
      outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: null },
    accountPlanAttribution: { accountBasis: "unavailable", accountTrackId: null,
      planBasis: "same_source_occurrence", planType: "pro", planEraId: null },
    ...overrides,
  };
}

export async function makeV11Day(day: string, recordsByStream: Partial<Record<TelemetryV11Stream, TelemetryV11Record[]>>,
  parserVersion = "synthetic-v11") {
  const consent = telemetryV11RequiredConsent();
  const chunks: TelemetryV11Chunk[] = [];
  for (const stream of TELEMETRY_V11_STREAMS) {
    const source = recordsByStream[stream] ?? [];
    for (let offset = 0; offset < source.length; offset += 200) {
      const records = source.slice(offset, offset + 200);
      chunks.push({ schemaVersion: "telemetry-contribution-v1.1", manifestDigest: "0".repeat(64),
        chunkId: `${stream}:${day}:${offset / 200}`, chunkRevision: 1,
        chunkDigest: await sha256Hex(canonicalTelemetryV11Json(records)), parserVersion, consent, records });
    }
  }
  const manifest: TelemetryV11DayManifest = { schemaVersion: "telemetry-day-manifest-v1.1", day,
    parserVersion, consent, chunks: chunks.map((chunk) => ({ chunkId: chunk.chunkId,
      chunkDigest: chunk.chunkDigest, recordCount: chunk.records.length })),
    excluded: { quota: 0, session: 0, usage: 0 }, manifestDigest: "0".repeat(64) };
  manifest.manifestDigest = await sha256Hex(telemetryV11DayManifestDigestInput(manifest));
  for (const chunk of chunks) { chunk.manifestDigest = manifest.manifestDigest; parseTelemetryV11Chunk(chunk); }
  parseTelemetryV11DayManifest(manifest);
  return { manifest, chunks };
}

export async function stageV11Day(db: D1Database,
  fixture: Awaited<ReturnType<typeof createV11DeviceFixture>>,
  prepared: Awaited<ReturnType<typeof makeV11Day>>,
  options: { quarantine?: R2Bucket } = {}) {
  await registerTelemetryV11DayManifest(db, fixture, prepared.manifest);
  for (const chunk of prepared.chunks) {
    const rawEnvelope = canonicalTelemetryV11Json({ syntheticTestEnvelope: chunk.chunkDigest,
      manifestDigest: chunk.manifestDigest, nonce: crypto.randomUUID() });
    const envelopeDigest = await sha256Hex(rawEnvelope);
    const bodyBytes = new TextEncoder().encode(rawEnvelope).byteLength;
    const principal = await authenticateDevice(db, fixture.authorization);
    const upload = await createDeviceUploadAuthorization(db, principal, envelopeDigest, bodyBytes);
    const claimed = await claimDeviceUploadAuthorization(db, `Upload ${upload.uploadAuthorization}`,
      { envelopeDigest, bodyBytes, contentType: "application/json" });
    const chunkRowId = `chunk:${crypto.randomUUID()}`;
    const r2Key = `telemetry/v11-test-${crypto.randomUUID()}`;
    if (options.quarantine) await putTrackedQuarantineObject(db, options.quarantine,
      { contributionId: chunkRowId, r2Key, objectKind: "telemetry", registeredAt: new Date().toISOString() }, rawEnvelope);
    await persistTelemetryV11StagedChunk(db, fixture, chunk,
      { chunkRowId, r2Key, envelopeDigest, deviceUploadAuthorizationId: claimed.authorizationId });
  }
  return registerTelemetryV11DayManifest(db, fixture, prepared.manifest);
}
