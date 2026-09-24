import { applyD1Migrations, env, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  canonicalTelemetryV12Json,
  telemetryV12DayManifestDigestInput,
  telemetryV12RequiredConsent,
  type TelemetryV12Chunk,
  type TelemetryV12DayManifest,
  type TelemetryV12UsageEvent,
} from "@app-usagemonitor/telemetry-contract";
import {
  authenticateDevice,
  claimDeviceUploadAuthorization,
  createDeviceUploadAuthorization,
} from "../src/device-auth";
import { sha256Hex } from "../src/crypto";
import {
  persistTelemetryV12StagedChunk,
  registerTelemetryV12DayManifest,
} from "../src/telemetry-v12-repository";
import { grantTelemetryV12Consent } from "../src/telemetry-transport-policy";
import {
  putTrackedQuarantineObject,
} from "../src/quarantine-reconciliation";
import {
  QUARANTINE_RECONCILIATION_GRACE_MILLISECONDS,
} from "../src/constants";
import { reconcilePendingQuarantineObjects } from "../src/quarantine-reconciliation";
import { createV11DeviceFixture } from "./helpers/telemetry-v11";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
}

const bindings = () => env as TestBindings;
const db = () => bindings().USAGE_MONITOR_DB;
const DAY = "2026-09-24";
const STAGED_TABLES = [
  "telemetry_v12_chunks",
  "telemetry_v12_records",
  "telemetry_v12_usage",
  "telemetry_v12_quota",
  "telemetry_v12_session_tools",
  "telemetry_v12_attributions",
  "typed_telemetry_dictionary",
] as const;

function usageRecord(eventId: string): TelemetryV12UsageEvent {
  return {
    schemaVersion: "usage-event-v1.2",
    eventId,
    eventTime: `${DAY}T12:05:00.000Z`,
    sessionUuid: "0a49f9db-8b2d-4c3e-9a6f-2f4f1c7d9e0b",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    speedMode: "standard",
    apiServiceTier: "default",
    surface: "local_interactive_unclassified",
    billingSurface: "chatgpt_subscription",
    reasoningEffort: "high",
    agentScope: "root",
    outcome: "completed",
    totalInputContextTokens: 1000,
    components: {
      inputUncachedTokens: 100,
      inputCacheReadTokens: 900,
      inputCacheWriteTokens: 0,
      outputTextTokens: 50,
      outputReasoningTokens: 25,
      outputCombinedTokens: 75,
    },
    accountPlanAttribution: {
      accountBasis: "unavailable",
      accountTrackId: null,
      planBasis: "same_source_occurrence",
      planType: "pro",
      planEraId: null,
    },
    boundaryFlags: null,
    tieOrder: null,
    cacheWriteTtl: null,
  };
}

class SyntheticQuarantine {
  readonly objects = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.objects.set(key, value);
  }

  async head(key: string): Promise<{ key: string } | null> {
    return this.objects.has(key) ? { key } : null;
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}

async function stagedAdmission() {
  const nowEpoch = Date.now();
  const fixture = await createV11DeviceFixture(db(), { nowEpoch });
  await db().prepare(
    "UPDATE telemetry_v12_runtime SET state = 'active', changed_at = ? WHERE id = 1",
  ).bind(new Date(nowEpoch).toISOString()).run();
  await grantTelemetryV12Consent(db(), fixture, telemetryV12RequiredConsent(), nowEpoch);

  const consent = telemetryV12RequiredConsent();
  const record = usageRecord(`event:v2:${await sha256Hex(crypto.randomUUID())}`);
  const chunk: TelemetryV12Chunk = {
    schemaVersion: "telemetry-contribution-v1.2",
    manifestDigest: "0".repeat(64),
    chunkId: `usage:${DAY}:0`,
    chunkRevision: 1,
    parserVersion: "synthetic-quarantine-admission-v12",
    consent,
    records: [record],
    chunkDigest: await sha256Hex(canonicalTelemetryV12Json([record])),
  };
  const manifest: TelemetryV12DayManifest = {
    schemaVersion: "telemetry-day-manifest-v1.2",
    day: DAY,
    parserVersion: chunk.parserVersion,
    consent,
    chunks: [{ chunkId: chunk.chunkId, chunkDigest: chunk.chunkDigest, recordCount: 1 }],
    excluded: { quota: 0, session: 0, usage: 0 },
    manifestDigest: "0".repeat(64),
  };
  manifest.manifestDigest = await sha256Hex(telemetryV12DayManifestDigestInput(manifest));
  chunk.manifestDigest = manifest.manifestDigest;
  const candidate = await registerTelemetryV12DayManifest(db(), fixture, manifest, nowEpoch);

  const rawEnvelope = canonicalTelemetryV12Json({ syntheticEnvelopeNonce: crypto.randomUUID() });
  const envelopeDigest = await sha256Hex(rawEnvelope);
  const bodyBytes = new TextEncoder().encode(rawEnvelope).byteLength;
  const principal = await authenticateDevice(db(), fixture.authorization);
  const upload = await createDeviceUploadAuthorization(db(), principal, envelopeDigest, bodyBytes);
  const claimed = await claimDeviceUploadAuthorization(db(), `Upload ${upload.uploadAuthorization}`, {
    envelopeDigest,
    bodyBytes,
    contentType: "application/json",
  });

  const chunkRowId = `chunk:${crypto.randomUUID()}`;
  const r2Key = `telemetry/v12-quarantine-test-${crypto.randomUUID()}`;
  const metadata = {
    chunkRowId,
    r2Key,
    envelopeDigest,
    deviceUploadAuthorizationId: claimed.authorizationId,
  };
  return {
    fixture,
    chunk,
    manifestId: candidate.manifestId,
    chunkRowId,
    r2Key,
    metadata,
    authorizationId: claimed.authorizationId,
    nowEpoch,
    persist: () => persistTelemetryV12StagedChunk(
      db(), fixture, chunk, metadata, nowEpoch,
    ),
  };
}

async function countsOfStagedRows(): Promise<Record<string, number>> {
  const entries = await Promise.all(STAGED_TABLES.map(async (name) => {
    const row = await db().prepare(`SELECT count(*) AS count FROM ${name}`)
      .first<{ count: number }>();
    return [name, row?.count ?? -1] as const;
  }));
  return Object.fromEntries(entries);
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), bindings().TEST_MIGRATIONS);
  await applyD1Migrations(db(), bindings().TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(db(), bindings().TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(db(), bindings().TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(db(), bindings().TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await applyD1Migrations(db(), bindings().TEST_INGESTION_ISOLATION_MIGRATIONS);
});

describe("v1.2 pending quarantine admission fence", () => {
  it("admits a chunk only while its matching telemetry registration is registered", async () => {
    const admission = await stagedAdmission();
    const registration = {
      contributionId: admission.chunkRowId,
      objectKind: "telemetry" as const,
      r2Key: admission.r2Key,
      registeredAt: new Date(admission.nowEpoch).toISOString(),
    };
    await db().prepare(
      `INSERT INTO pending_quarantine_objects (
        r2_key, contribution_id, object_kind, registered_at
      ) VALUES (?, ?, ?, ?)`,
    ).bind(registration.r2Key, registration.contributionId, registration.objectKind,
      registration.registeredAt).run();

    await expect(admission.persist()).resolves.toMatchObject({
      contributionId: admission.chunkRowId,
      replay: false,
    });
    await expect(db().prepare(
      "SELECT reconciliation_state FROM pending_quarantine_objects WHERE r2_key = ?",
    ).bind(admission.r2Key).first<string>("reconciliation_state"))
      .resolves.toBe("registered");
  });

  it.each([
    ["deleting registration", "deleting"],
    ["missing registration", "absent"],
    ["registration with a different contribution id", "wrong-id"],
    ["registration with a different object key", "wrong-key"],
  ] as const)("rejects admission with a %s without partial typed rows", async (_label, state) => {
    const admission = await stagedAdmission();
    const registration = {
      contributionId: state === "wrong-id" ? `chunk:${crypto.randomUUID()}` : admission.chunkRowId,
      objectKind: "telemetry" as const,
      r2Key: state === "wrong-key" ? `telemetry/other-${crypto.randomUUID()}` : admission.r2Key,
      registeredAt: new Date(admission.nowEpoch).toISOString(),
    };
    if (state !== "absent") {
      await db().prepare(
        `INSERT INTO pending_quarantine_objects (
          r2_key, contribution_id, object_kind, registered_at
        ) VALUES (?, ?, ?, ?)`,
      ).bind(registration.r2Key, registration.contributionId, registration.objectKind,
        registration.registeredAt).run();
      if (state === "deleting") {
        await db().prepare(
          `UPDATE pending_quarantine_objects
              SET reconciliation_state = 'deleting', reconciliation_lease_id = ?
            WHERE r2_key = ?`,
        ).bind(`synthetic-lease-${crypto.randomUUID()}`, admission.r2Key).run();
      }
    }

    const before = await countsOfStagedRows();
    await expect(admission.persist()).rejects.toMatchObject({
      code: "TELEMETRY_MANIFEST_CONFLICT",
    });
    expect(await countsOfStagedRows()).toEqual(before);
    await expect(db().prepare(
      "SELECT state FROM device_upload_authorizations WHERE id = ?",
    ).bind(admission.authorizationId).first<string>("state"))
      .resolves.toBe("consuming");
    await expect(db().prepare(
      "SELECT state FROM telemetry_v12_day_manifests WHERE id = ?",
    ).bind(admission.manifestId).first<string>("state"))
      .resolves.toBe("staged");
  });

  it("rolls back prior D1 batch writes when the pending-registration fence interrupts chunk admission", async () => {
    const admission = await stagedAdmission();
    const before = await countsOfStagedRows();
    const stateBefore = await db().prepare(
      "SELECT registrations_examined FROM quarantine_reconciliation_state WHERE singleton = 1",
    ).first<{ registrations_examined: number }>();
    expect(stateBefore?.registrations_examined).toBe(0);

    await expect(db().batch([
      db().prepare(
        `UPDATE quarantine_reconciliation_state
            SET registrations_examined = registrations_examined + 1
          WHERE singleton = 1`,
      ),
      db().prepare(
        `INSERT INTO telemetry_v12_chunks (
          id, manifest_id, participant_id, device_id, stream, chunk_day, chunk_seq,
          chunk_id, chunk_digest, envelope_digest, parser_version, record_count,
          r2_key, device_upload_authorization_id, created_at
        ) VALUES (?, ?, ?, ?, 'usage', ?, 0, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).bind(
        admission.chunkRowId,
        admission.manifestId,
        admission.fixture.participantId,
        admission.fixture.deviceId,
        DAY,
        admission.chunk.chunkId,
        admission.chunk.chunkDigest,
        admission.metadata.envelopeDigest,
        admission.chunk.parserVersion,
        admission.r2Key,
        admission.authorizationId,
        new Date(admission.nowEpoch).toISOString(),
      ),
    ])).rejects.toThrow(/telemetry_v12_chunk_staging_denied/u);

    expect(await countsOfStagedRows()).toEqual(before);
    await expect(db().prepare(
      "SELECT registrations_examined FROM quarantine_reconciliation_state WHERE singleton = 1",
    ).first<{ registrations_examined: number }>()).resolves.toEqual(stateBefore);
    await expect(db().prepare(
      "SELECT state FROM device_upload_authorizations WHERE id = ?",
    ).bind(admission.authorizationId).first<string>("state"))
      .resolves.toBe("consuming");
  });

  it("preserves an already committed v1.2 chunk during orphan reconciliation", async () => {
    const admission = await stagedAdmission();
    const quarantine = new SyntheticQuarantine();
    const registration = {
      contributionId: admission.chunkRowId,
      objectKind: "telemetry" as const,
      r2Key: admission.r2Key,
      registeredAt: new Date(
        admission.nowEpoch - QUARANTINE_RECONCILIATION_GRACE_MILLISECONDS - 1_000,
      ).toISOString(),
    };
    await putTrackedQuarantineObject(
      db(), quarantine as unknown as R2Bucket, registration, "synthetic v1.2 envelope",
    );
    await admission.persist();

    const result = await reconcilePendingQuarantineObjects(
      db(), quarantine as unknown as R2Bucket, admission.nowEpoch,
    );
    expect(result).toMatchObject({
      registrationsExamined: 1,
      orphanObjectsDeleted: 0,
      referencedObjectsPreserved: 1,
      reconciliationComplete: true,
    });
    expect(quarantine.objects.has(admission.r2Key)).toBe(true);
    await expect(db().prepare(
      "SELECT count(*) AS count FROM telemetry_v12_chunks WHERE id = ? AND r2_key = ?",
    ).bind(admission.chunkRowId, admission.r2Key).first<number>("count"))
      .resolves.toBe(1);
    await expect(db().prepare(
      "SELECT count(*) AS count FROM pending_quarantine_objects WHERE r2_key = ?",
    ).bind(admission.r2Key).first<number>("count"))
      .resolves.toBe(0);
  });
});
