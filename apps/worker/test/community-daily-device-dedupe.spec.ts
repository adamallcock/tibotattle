import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  readLatestCommunityDailyAggregate,
  rebuildPendingCommunityDailyAggregates,
} from "../src/community-daily-aggregates";
import {
  assertV1SourcePinCurrent,
  loadV1SourcePin,
} from "../src/telemetry-v1-source-selection";

/**
 * Cross-device dedupe in the daily community aggregates.
 *
 * Sync state and chunk supersession are per-(participant, device): when a
 * device's credential is irrecoverably lost, the participant pairs a fresh
 * device whose empty per-device cursor re-uploads the entire history while
 * the lost device's chunks stay current. Devices are an upload transport,
 * not a data partition — both devices observed the SAME underlying local
 * index — so the aggregation must count each (participant, day) exactly
 * once: only the winning device's records, winner = newest current-chunk
 * created_at for the day (analytical streams first, explicit session-only
 * fallback), deterministic bytewise tiebreak on the larger device_id.
 *
 * These tests seed the journal directly (through the full 0031 trigger
 * chain: consuming upload authorization, admission windows, and the
 * day-keyed rebuild enqueue) so chunk created_at values can express
 * histories the HTTP path would clock-stamp itself.
 */

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

function db(): D1Database {
  return (env as TestBindings).USAGE_MONITOR_DB;
}

const DAY = "2026-08-01";
const SEED_AT = "2026-08-01T00:00:00.000Z";
const FUTURE = "2027-01-01T00:00:00.000Z";

function hash(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

let seedSequence = 0;

async function seedParticipant(name: string): Promise<string> {
  const participantId = `participant-${name}`;
  await db().batch([
    db().prepare(
      `INSERT INTO participants (
        id, access_token_id, access_token_hash, recovery_token_id,
        recovery_token_hash, state, consent_version, consented_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'active', 'privacy-safe-telemetry-v0.2',
        ?, ?)`,
    ).bind(
      participantId,
      `access-${name}`,
      hash(1),
      `recovery-${name}`,
      hash(2),
      SEED_AT,
      SEED_AT,
    ),
    db().prepare(
      `INSERT INTO web_sessions (
        id, participant_id, secret_hash, csrf_hash, scope, state,
        issued_at, expires_at, last_used_at
      ) VALUES (?, ?, ?, ?, 'personal', 'active', ?, ?, ?)`,
    ).bind(`session-${name}`, participantId, hash(3), hash(4), SEED_AT,
      FUTURE, SEED_AT),
  ]);
  return participantId;
}

async function seedDevice(
  participantId: string,
  deviceId: string,
): Promise<void> {
  const sessionId = `session-${participantId.replace("participant-", "")}`;
  await db().batch([
    db().prepare(
      `INSERT INTO device_pairings (
        id, participant_id, issued_by_session_id, secret_hash,
        consent_version, state, issued_at, expires_at,
        transport_consent_version
      ) VALUES (?, ?, ?, ?, 'ongoing-privacy-safe-telemetry-v1.0', 'unused',
        ?, ?, 'ongoing-privacy-safe-telemetry-v1.0')`,
    ).bind(`pairing-${deviceId}`, participantId, sessionId, hash(5), SEED_AT,
      FUTURE),
    db().prepare(
      `INSERT INTO device_credentials (
        id, participant_id, paired_via_pairing_id, secret_hash, state,
        issued_at, expires_at, last_used_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).bind(deviceId, participantId, `pairing-${deviceId}`, hash(6), SEED_AT,
      FUTURE, SEED_AT),
  ]);
}

interface SeedRecord {
  occurrenceId: string;
  inputUncachedTokens?: number | null;
  inputCacheReadTokens?: number | null;
  inputCacheWriteTokens?: number | null;
  outputTextTokens?: number | null;
  outputReasoningTokens?: number | null;
  outputCombinedTokens?: number | null;
  modelId?: string;
}

async function seedChunk(options: {
  participantId: string;
  deviceId: string;
  createdAt: string;
  seq?: number;
  stream?: "usage" | "quota" | "session";
  records: SeedRecord[];
}): Promise<void> {
  seedSequence += 1;
  const chunkRowId = `chunk-${seedSequence}`;
  const authorizationId = `authorization-${seedSequence}`;
  const stream = options.stream ?? "usage";
  const chunkDigest = seedSequence.toString(16).padStart(64, "0");
  const envelopeDigest = (seedSequence + 0xffff).toString(16)
    .padStart(64, "0");
  await db().batch([
    db().prepare(
      `INSERT INTO device_upload_authorizations (
        id, participant_id, issued_by_device_id, secret_hash,
        envelope_digest, body_bytes, content_type, state, issued_at,
        expires_at, consume_lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, 1024, 'application/json', 'consuming',
        ?, ?, ?)`,
    ).bind(authorizationId, options.participantId, options.deviceId, hash(7),
      envelopeDigest, SEED_AT, FUTURE, FUTURE),
    db().prepare(
      `INSERT INTO telemetry_v1_chunks (
        id, participant_id, device_id, stream, chunk_day, chunk_seq,
        revision, chunk_digest, envelope_digest, parser_version,
        record_count, accepted_record_count, r2_key,
        device_upload_authorization_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'test-parser-v1', ?, ?, ?, ?, ?)`,
    ).bind(
      chunkRowId,
      options.participantId,
      options.deviceId,
      stream,
      DAY,
      options.seq ?? 0,
      chunkDigest,
      envelopeDigest,
      options.records.length,
      options.records.length,
      `telemetry/v1-test-${seedSequence}`,
      authorizationId,
      options.createdAt,
    ),
    ...options.records.map((record) => db().prepare(
      `INSERT INTO telemetry_v1_records (
        chunk_row_id, participant_id, device_id, stream, occurrence_id,
        observed_at, observed_day, provider, model_id,
        input_uncached_tokens, input_cache_read_tokens,
        input_cache_write_tokens, output_text_tokens,
        output_reasoning_tokens, output_combined_tokens, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
    ).bind(
      chunkRowId,
      options.participantId,
      options.deviceId,
      stream,
      record.occurrenceId,
      `${DAY}T10:00:00.000Z`,
      DAY,
      stream === "usage" ? "openai_codex" : null,
      stream === "usage" ? record.modelId ?? "gpt-5.6-sol" : null,
      record.inputUncachedTokens ?? null,
      record.inputCacheReadTokens ?? null,
      record.inputCacheWriteTokens ?? null,
      record.outputTextTokens ?? null,
      record.outputReasoningTokens ?? null,
      record.outputCombinedTokens ?? null,
    )),
  ]);
}

interface PublishedTotals {
  contributingParticipants: number;
  contributingDevices: number;
  usageEvents: number;
  quotaObservations: number;
  sessionDimensions: number;
  inputUncachedTokens: number;
  inputCacheReadTokens: number;
  inputCacheWriteTokens: number;
  outputTextTokens: number;
  outputReasoningTokens: number;
  outputCombinedTokens: number;
}

async function rebuildAndReadDay(scheduledAt: string): Promise<{
  revision: number;
  totals: PublishedTotals;
  cells: Array<Record<string, unknown>>;
}> {
  const outcome = await rebuildPendingCommunityDailyAggregates(
    db(),
    Date.parse(scheduledAt),
  );
  expect(outcome.remaining).toBe(false);
  const row = await readLatestCommunityDailyAggregate(db(), DAY);
  expect(row?.release_state).toBe("published");
  return JSON.parse(row!.payload_json) as {
    revision: number;
    totals: PublishedTotals;
    cells: Array<Record<string, unknown>>;
  };
}

beforeEach(async () => {
  await reset();
  seedSequence = 0;
  const test = env as TestBindings;
  await applyD1Migrations(test.USAGE_MONITOR_DB, test.TEST_MIGRATIONS);
  await applyD1Migrations(
    test.DELETION_LEDGER,
    test.TEST_DELETION_LEDGER_MIGRATIONS,
  );
});

describe("community daily aggregate cross-device dedupe", () => {
  it("does not let a later session-only device erase analytical totals or cells", async () => {
    const participant = await seedParticipant("session-after-usage");
    await seedDevice(participant, "device-analytical");
    await seedDevice(participant, "device-session-only");
    await seedChunk({ participantId: participant, deviceId: "device-analytical",
      createdAt: "2026-08-02T01:00:00.000Z", records: [{ occurrenceId: "usage-one", inputUncachedTokens: 42 }] });
    await seedChunk({ participantId: participant, deviceId: "device-session-only", stream: "session",
      createdAt: "2026-08-03T01:00:00.000Z", records: [{ occurrenceId: "session-one" }] });
    const dayPin = await loadV1SourcePin(db(), { day: DAY });
    const participantPin = await loadV1SourcePin(db(), { participantId: participant, fromDay: DAY });
    expect(dayPin.winners).toEqual(participantPin.winners);
    expect(dayPin.winners).toEqual([{ participant_id: participant, observed_day: DAY,
      device_id: "device-analytical", evidence: "analytical" }]);
    const payload = await rebuildAndReadDay("2026-08-03T12:00:00.000Z");
    expect(payload.totals.inputUncachedTokens).toBe(42);
    expect(payload.totals.usageEvents).toBe(1);
    expect(payload.totals.sessionDimensions).toBe(0);
    expect(payload.cells[0]?.inputUncachedTokens).toBe(42);
  });

  it("retains a newest-device fallback for a genuinely session-only participant-day", async () => {
    const participant = await seedParticipant("session-fallback");
    await seedDevice(participant, "device-old-session");
    await seedDevice(participant, "device-new-session");
    await seedChunk({ participantId: participant, deviceId: "device-old-session", stream: "session",
      createdAt: "2026-08-02T01:00:00.000Z", records: [{ occurrenceId: "session-old" }] });
    await seedChunk({ participantId: participant, deviceId: "device-new-session", stream: "session",
      createdAt: "2026-08-03T01:00:00.000Z", records: [{ occurrenceId: "session-new-a" }, { occurrenceId: "session-new-b" }] });
    const pin = await loadV1SourcePin(db(), { participantId: participant, fromDay: DAY });
    expect(pin.winners[0]).toMatchObject({ device_id: "device-new-session", evidence: "session_only" });
    const payload = await rebuildAndReadDay("2026-08-03T12:00:00.000Z");
    expect(payload.totals.sessionDimensions).toBe(2);
    expect(payload.totals.usageEvents).toBe(0);
  });

  it("keeps a participant fingerprint stable across unrelated uploads but invalidates its own changed input", async () => {
    const participant = await seedParticipant("pin-owner");
    await seedDevice(participant, "device-pin-owner");
    await seedChunk({ participantId: participant, deviceId: "device-pin-owner",
      createdAt: "2026-08-02T01:00:00.000Z", records: [{ occurrenceId: "owner-usage", inputUncachedTokens: 42 }] });
    const scope = { participantId: participant, fromDay: DAY };
    const pin = await loadV1SourcePin(db(), scope);
    expect(pin.inputRevision).toBeGreaterThan(0);
    const other = await seedParticipant("pin-other");
    await seedDevice(other, "device-pin-other");
    await seedChunk({ participantId: other, deviceId: "device-pin-other",
      createdAt: "2026-08-02T02:00:00.000Z", records: [{ occurrenceId: "other-usage", inputUncachedTokens: 99 }] });
    const unchanged = await loadV1SourcePin(db(), scope);
    expect(unchanged.fingerprint).toBe(pin.fingerprint);
    expect(unchanged.inputRevision).toBe(pin.inputRevision);
    expect(unchanged.mutationEpoch).toBeGreaterThan(pin.mutationEpoch);
    await expect(assertV1SourcePinCurrent(db(), pin)).resolves.toBeUndefined();
    await seedChunk({ participantId: participant, deviceId: "device-pin-owner", seq: 1,
      createdAt: "2026-08-02T01:00:00.000Z", records: [{ occurrenceId: "owner-usage-two", inputUncachedTokens: 1 }] });
    await expect(assertV1SourcePinCurrent(db(), pin)).rejects.toThrow("v1 source changed during analysis");
    await expect(loadV1SourcePin(db(), scope, { maxChunks: 1 })).rejects.toThrow("v1 source chunk limit exceeded");
  });

  it("counts an overlapping participant-day once, the newest device winning across streams", async () => {
    const participant = await seedParticipant("alpha");
    await seedDevice(participant, "device-lost");
    await seedDevice(participant, "device-fresh");
    const solo = await seedParticipant("solo");
    await seedDevice(solo, "device-solo");

    // The lost device's history stays current: nothing supersedes it.
    await seedChunk({
      participantId: participant,
      deviceId: "device-lost",
      createdAt: "2026-08-05T10:00:00.000Z",
      records: [
        {
          occurrenceId: "event-1",
          inputUncachedTokens: 100,
          outputTextTokens: 50,
          outputReasoningTokens: 25,
        },
        {
          occurrenceId: "event-2",
          inputUncachedTokens: 200,
          outputTextTokens: 10,
          outputReasoningTokens: 0,
          outputCombinedTokens: 10,
        },
      ],
    });
    await seedChunk({
      participantId: participant,
      deviceId: "device-lost",
      stream: "quota",
      createdAt: "2026-08-05T11:00:00.000Z",
      records: [{ occurrenceId: "quota-1" }],
    });

    // Clear the queue the seeds above populated, so the next assertion
    // proves the FRESH device's conflicting upload re-enqueues the day:
    // the 0031 enqueue trigger keys on the day alone, never the device.
    await db().prepare(
      "DELETE FROM community_daily_aggregate_rebuilds",
    ).run();

    // The fresh device re-pairs and re-uploads the same underlying days.
    await seedChunk({
      participantId: participant,
      deviceId: "device-fresh",
      createdAt: "2026-08-09T10:00:00.000Z",
      records: [
        {
          occurrenceId: "event-1",
          inputUncachedTokens: 100,
          outputTextTokens: 50,
          outputReasoningTokens: 25,
        },
        {
          occurrenceId: "event-2",
          inputUncachedTokens: 200,
          outputTextTokens: 10,
          outputReasoningTokens: 0,
          outputCombinedTokens: 10,
        },
      ],
    });
    const enqueued = await db().prepare(
      "SELECT day FROM community_daily_aggregate_rebuilds",
    ).all<{ day: string }>();
    expect(enqueued.results).toEqual([{ day: DAY }]);

    await seedChunk({
      participantId: participant,
      deviceId: "device-fresh",
      stream: "quota",
      createdAt: "2026-08-09T09:00:00.000Z",
      records: [{ occurrenceId: "quota-1" }],
    });
    await seedChunk({
      participantId: solo,
      deviceId: "device-solo",
      createdAt: "2026-08-02T00:00:00.000Z",
      records: [{
        occurrenceId: "solo-1",
        inputUncachedTokens: 1000,
        outputTextTokens: 5,
        outputReasoningTokens: 0,
      }],
    });

    const payload = await rebuildAndReadDay("2026-08-09T12:00:00.000Z");
    // Without the winner rule these would read 5 usage events, 2 quota
    // observations, and 1,600 uncached input tokens: the overlapping day
    // summed once per device. The winner (device-fresh, newest chunk
    // created_at 2026-08-09T10:00) is counted alone — across ALL streams,
    // so its quota observation wins too even though its quota chunk is not
    // the day's newest quota chunk by itself.
    expect(payload.totals).toEqual({
      contributingParticipants: 2,
      contributingDevices: 2,
      usageEvents: 3,
      quotaObservations: 1,
      sessionDimensions: 0,
      inputUncachedTokens: 1300,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTextTokens: 65,
      outputReasoningTokens: 25,
      outputCombinedTokens: 90,
    });
    expect(payload.cells).toEqual([{
      provider: "openai_codex",
      modelId: "gpt-5.6-sol",
      usageEvents: 3,
      inputUncachedTokens: 1300,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      outputTextTokens: 65,
      outputReasoningTokens: 25,
      outputCombinedTokens: 90,
    }]);
  });

  it("never resurrects the losing device unless its evidence is genuinely newer", async () => {
    const participant = await seedParticipant("beta");
    await seedDevice(participant, "device-lost");
    await seedDevice(participant, "device-fresh");

    await seedChunk({
      participantId: participant,
      deviceId: "device-lost",
      createdAt: "2026-08-05T10:00:00.000Z",
      records: [{ occurrenceId: "event-1", inputUncachedTokens: 100 }],
    });
    await seedChunk({
      participantId: participant,
      deviceId: "device-fresh",
      createdAt: "2026-08-09T10:00:00.000Z",
      records: [{ occurrenceId: "event-1", inputUncachedTokens: 100 }],
    });
    const first = await rebuildAndReadDay("2026-08-09T12:00:00.000Z");
    expect(first.revision).toBe(1);
    expect(first.totals.usageEvents).toBe(1);
    expect(first.totals.inputUncachedTokens).toBe(100);

    // A further chunk lands from the losing device, but its created_at is
    // still older than the winner's newest evidence: the winner must key on
    // chunk freshness, not on insert order or arrival recency.
    await seedChunk({
      participantId: participant,
      deviceId: "device-lost",
      seq: 1,
      createdAt: "2026-08-07T00:00:00.000Z",
      records: [{ occurrenceId: "event-3", inputUncachedTokens: 999 }],
    });
    const second = await rebuildAndReadDay("2026-08-09T13:00:00.000Z");
    expect(second.revision).toBe(2);
    expect(second.totals.usageEvents).toBe(1);
    expect(second.totals.inputUncachedTokens).toBe(100);

    // Genuinely newer evidence from the formerly losing device flips the
    // winner — freshest evidence wins, direction-free — and its WHOLE day
    // is then the single counted copy.
    await seedChunk({
      participantId: participant,
      deviceId: "device-lost",
      seq: 2,
      createdAt: "2026-08-10T00:00:00.000Z",
      records: [{ occurrenceId: "event-4", inputUncachedTokens: 7 }],
    });
    const third = await rebuildAndReadDay("2026-08-10T01:00:00.000Z");
    expect(third.revision).toBe(3);
    expect(third.totals.usageEvents).toBe(3);
    expect(third.totals.inputUncachedTokens).toBe(1106);
  });

  it("breaks created_at ties deterministically on the larger device_id", async () => {
    const participant = await seedParticipant("gamma");
    await seedDevice(participant, "device-a");
    await seedDevice(participant, "device-b");
    await seedChunk({
      participantId: participant,
      deviceId: "device-a",
      createdAt: "2026-08-05T10:00:00.000Z",
      records: [{ occurrenceId: "event-1", inputUncachedTokens: 11 }],
    });
    await seedChunk({
      participantId: participant,
      deviceId: "device-b",
      createdAt: "2026-08-05T10:00:00.000Z",
      records: [{ occurrenceId: "event-1", inputUncachedTokens: 22 }],
    });
    const payload = await rebuildAndReadDay("2026-08-09T12:00:00.000Z");
    expect(payload.totals.usageEvents).toBe(1);
    expect(payload.totals.inputUncachedTokens).toBe(22);
  });

  it("leaves single-device aggregation byte-identical (regression fixture)", async () => {
    const participant = await seedParticipant("delta");
    await seedDevice(participant, "device-only");
    await seedChunk({
      participantId: participant,
      deviceId: "device-only",
      createdAt: "2026-08-05T10:00:00.000Z",
      records: [
        {
          occurrenceId: "usage-1",
          inputUncachedTokens: 100,
          inputCacheReadTokens: 900,
          inputCacheWriteTokens: 3,
          outputTextTokens: 50,
          outputReasoningTokens: 25,
        },
        {
          occurrenceId: "usage-2",
          inputUncachedTokens: 200,
          outputTextTokens: 10,
          outputReasoningTokens: 0,
          outputCombinedTokens: 10,
        },
      ],
    });
    // A second, later chunk of the SAME device: dedupe is per device, not
    // per chunk — every current chunk of the winning device counts.
    await seedChunk({
      participantId: participant,
      deviceId: "device-only",
      seq: 1,
      createdAt: "2026-08-06T10:00:00.000Z",
      records: [{
        occurrenceId: "usage-3",
        inputUncachedTokens: 40,
        outputTextTokens: 4,
        outputReasoningTokens: 1,
        modelId: "gpt-5.7",
      }],
    });
    await seedChunk({
      participantId: participant,
      deviceId: "device-only",
      stream: "quota",
      createdAt: "2026-08-05T10:00:00.000Z",
      records: [{ occurrenceId: "quota-1" }],
    });
    await seedChunk({
      participantId: participant,
      deviceId: "device-only",
      stream: "session",
      createdAt: "2026-08-05T10:00:00.000Z",
      records: [{ occurrenceId: "session-1" }],
    });

    const payload = await rebuildAndReadDay("2026-08-09T12:00:00.000Z");
    // Exactly what the pre-dedupe aggregation published for this fixture:
    // a single-device participant is always its own winner.
    expect(payload.totals).toEqual({
      contributingParticipants: 1,
      contributingDevices: 1,
      usageEvents: 3,
      quotaObservations: 1,
      sessionDimensions: 1,
      inputUncachedTokens: 340,
      inputCacheReadTokens: 900,
      inputCacheWriteTokens: 3,
      outputTextTokens: 64,
      outputReasoningTokens: 26,
      outputCombinedTokens: 90,
    });
    expect(payload.cells).toEqual([
      {
        provider: "openai_codex",
        modelId: "gpt-5.6-sol",
        usageEvents: 2,
        inputUncachedTokens: 300,
        inputCacheReadTokens: 900,
        inputCacheWriteTokens: 3,
        outputTextTokens: 60,
        outputReasoningTokens: 25,
        outputCombinedTokens: 85,
      },
      {
        provider: "openai_codex",
        modelId: "gpt-5.7",
        usageEvents: 1,
        inputUncachedTokens: 40,
        inputCacheReadTokens: 0,
        inputCacheWriteTokens: 0,
        outputTextTokens: 4,
        outputReasoningTokens: 1,
        outputCombinedTokens: 5,
      },
    ]);
  });
});
