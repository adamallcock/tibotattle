import {
  insertTelemetryContribution,
  telemetryPlaintextDigest,
  type TelemetryTransportMetadata,
} from "./telemetry-repository";
import {
  canonicalTelemetryContributionV01,
  validateTelemetryContributionV02,
  type TelemetryContributionV02,
} from "./telemetry-v0.2";
import { ApiError } from "./errors";

export interface TelemetryV02Insert {
  participantId: string;
  uploadAuthorizationId: string;
  uploadAuthorizationKind: "session" | "device";
  contributionId: string;
  r2Key: string;
  envelopeDigest: string;
  receivedAt: string;
  plaintext: unknown;
}

function transportMetadata(record: TelemetryContributionV02): TelemetryTransportMetadata {
  return {
    transportSchemaVersion: record.schemaVersion,
    datasetId: record.datasetId,
    partIndex: record.partIndex,
    partCount: record.partCount,
    completeness: record.completeness,
    rangeStart: record.coveredAt.startAt,
    rangeEnd: record.coveredAt.endAt,
    policyEpoch: record.providerPolicyEpoch,
    usage: new Map(record.usageEvents.map((row) => [
      row.eventId,
      {
        accountTrackId: row.accountTrackId,
        recordJson: JSON.stringify(row),
      },
    ])),
    quota: new Map(record.quotaSnapshots.map((row) => [
      row.snapshotId,
      {
        accountTrackId: row.accountTrackId,
        recordJson: JSON.stringify(row),
      },
    ])),
    activity: new Map(record.activityMarkers.map((row) => [
      row.markerId,
      {
        accountTrackId: row.accountTrackId,
        recordJson: JSON.stringify(row),
      },
    ])),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function assertOccurrenceCompatibility(
  db: D1Database,
  participantId: string,
  record: TelemetryContributionV02,
): Promise<void> {
  const incoming = [
    ...record.usageEvents.map((row) => ({
      kind: "usage",
      id: row.eventId,
      accountTrackId: row.accountTrackId,
      policyEpoch: record.providerPolicyEpoch,
      canonical: canonicalJson(row),
    })),
    ...record.quotaSnapshots.map((row) => ({
      kind: "quota",
      id: row.snapshotId,
      accountTrackId: row.accountTrackId,
      policyEpoch: record.providerPolicyEpoch,
      canonical: canonicalJson(row),
    })),
    ...record.activityMarkers.map((row) => ({
      kind: "activity",
      id: row.markerId,
      accountTrackId: row.accountTrackId,
      policyEpoch: record.providerPolicyEpoch,
      canonical: canonicalJson(row),
    })),
  ];
  const existing = await db.batch(incoming.map((row) => db.prepare(
    `SELECT account_track_id, policy_epoch, record_json
       FROM telemetry_records
      WHERE participant_id = ? AND record_kind = ? AND occurrence_id = ?`,
  ).bind(participantId, row.kind, row.id)));
  for (let index = 0; index < incoming.length; index += 1) {
    const found = existing[index]?.results?.[0] as {
      account_track_id?: unknown;
      policy_epoch?: unknown;
      record_json?: unknown;
    } | undefined;
    if (!found) continue;
    let storedCanonical = "";
    try {
      storedCanonical = canonicalJson(JSON.parse(String(found.record_json)));
    } catch {
      throw new ApiError(409, "TELEMETRY_OCCURRENCE_CONFLICT");
    }
    const expected = incoming[index]!;
    if (found.account_track_id !== expected.accountTrackId
        || found.policy_epoch !== expected.policyEpoch
        || storedCanonical !== expected.canonical) {
      throw new ApiError(409, "TELEMETRY_OCCURRENCE_CONFLICT");
    }
  }
}

/**
 * Persist a validated v0.2 contribution through the same canonical pricing,
 * deduplication, deletion, and participant-isolation tables as v0.1.
 *
 * The HTTP route may call this only after the local-preview activation guard
 * and renewed v0.2 consent checks pass. External collection remains disabled.
 */
export async function insertTelemetryContributionV02(
  db: D1Database,
  input: TelemetryV02Insert,
): Promise<{
  acceptedRecords: number;
  deduplicatedRecords: number;
  plaintextDigest: string;
}> {
  const record = validateTelemetryContributionV02(input.plaintext);
  await assertOccurrenceCompatibility(db, input.participantId, record);
  const canonical = canonicalTelemetryContributionV01(record);
  const plaintextDigest = await telemetryPlaintextDigest(record);
  const result = await insertTelemetryContribution(
    db,
    input.participantId,
    {
      authorizationId: input.uploadAuthorizationId,
      authorizationKind: input.uploadAuthorizationKind,
    },
    input.contributionId,
    input.r2Key,
    input.envelopeDigest,
    plaintextDigest,
    canonical,
    input.receivedAt,
    transportMetadata(record),
  );
  return { ...result, plaintextDigest };
}

/** @deprecated Compatibility alias for the original repository-only tests. */
export const insertTelemetryContributionV02Shadow =
  insertTelemetryContributionV02;
