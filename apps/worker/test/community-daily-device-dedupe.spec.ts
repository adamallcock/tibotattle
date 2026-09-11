import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { telemetryV11RequiredConsent } from "@app-usagemonitor/telemetry-contract";

import {
  ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
  ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
  ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
} from "../src/accountless-enrollment";
import {
  ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
  ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
} from "../src/accountless-ownership";

import {
  readLatestCommunityDailyAggregate,
  rebuildPendingCommunityDailyAggregates,
} from "../src/community-daily-aggregates";
import {
  assertV1SourcePinCurrent,
  loadV1SourcePin,
  MAX_V1_SOURCE_CHUNKS,
} from "../src/telemetry-v1-source-selection";
import { DAILY_SPEND_RECORDS_SQL, isCurrentCommunityDailySpend, priceCommunityDailySpend } from "../src/community-daily-spend";
import type { CommunityDailySpend } from "../src/community-daily-spend";
import { priceChunkUsageRecord } from "../src/quota-analysis-v1";

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
const ACCOUNTLESS_LEASE_ISSUED_AT = "2099-01-01T00:00:00.000Z";
const ACCOUNTLESS_LEASE_EXPIRES_AT = "2099-01-31T00:00:00.000Z";

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

/**
 * Establish a real direct-owner graph, then materialize a deliberately
 * oversized legacy source journal. Accountless owners cannot submit v1.0 in
 * production; the raw journal below models stale/corrupt/future source rows
 * so the public selector's bound is tested independently of that admission
 * fence. The direct owner itself remains fully authority-shaped.
 */
async function seedOversizedAccountlessSourceJournal(): Promise<string> {
  const participantId = "participant-accountless-public-cap";
  const deviceId = "11111111-1111-4111-8111-111111111111";
  const required = telemetryV11RequiredConsent();
  await db().batch([
    db().prepare(`INSERT INTO accountless_enrollment_ledger (
      device_id, device_secret_hash, installation_principal_id,
      schema_version, policy_version, authorization_basis, state, issued_at,
      expires_at
    ) VALUES (?, ?, 'accountless:public-cap', ?, ?, ?, 'active', ?, ?)`)
      .bind(
        deviceId,
        hash(8),
        ACCOUNTLESS_ENROLLMENT_SCHEMA_VERSION,
        ACCOUNTLESS_ENROLLMENT_POLICY_VERSION,
        ACCOUNTLESS_ENROLLMENT_AUTHORIZATION_BASIS,
        ACCOUNTLESS_LEASE_ISSUED_AT,
        ACCOUNTLESS_LEASE_EXPIRES_AT,
      ),
    db().prepare(`INSERT INTO participants (
      id, owner_kind, access_token_id, access_token_hash, recovery_token_id,
      recovery_token_hash, state, consent_version, consented_at, created_at,
      deletion_session_id, identity_link_key, identity_cooldown_digest
    ) VALUES (?, 'accountless', NULL, NULL, NULL, NULL, 'active', NULL,
      NULL, ?, NULL, NULL, NULL)`).bind(participantId, ACCOUNTLESS_LEASE_ISSUED_AT),
    db().prepare(`INSERT INTO device_credentials (
      id, participant_id, authority_kind, paired_via_pairing_id,
      accountless_enrollment_device_id, secret_hash, state, issued_at,
      expires_at, last_used_at, revoked_at, social_verified_at,
      credential_generation
    ) VALUES (?, ?, 'accountless', NULL, ?, ?, 'active', ?, ?, ?, NULL,
      NULL, 1)`).bind(deviceId, participantId, deviceId, hash(8),
      ACCOUNTLESS_LEASE_ISSUED_AT, ACCOUNTLESS_LEASE_EXPIRES_AT,
      ACCOUNTLESS_LEASE_ISSUED_AT),
    db().prepare(`INSERT INTO accountless_upload_owners (
      enrollment_device_id, participant_id, device_credential_id,
      policy_version, authorization_basis, authorized_at, expires_at, state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`).bind(
      deviceId,
      participantId,
      deviceId,
      ACCOUNTLESS_UPLOAD_OWNER_POLICY_VERSION,
      ACCOUNTLESS_UPLOAD_OWNER_AUTHORIZATION_BASIS,
      ACCOUNTLESS_LEASE_ISSUED_AT,
      ACCOUNTLESS_LEASE_EXPIRES_AT,
    ),
    db().prepare(`INSERT INTO accountless_v11_device_authorizations (
      enrollment_device_id, participant_id, device_credential_id,
      telemetry_schema_version, field_dictionary_version,
      privacy_contract_version, authorized_at, expires_at, state
    ) VALUES (?, ?, ?, 'telemetry-contribution-v1.1', ?, ?, ?, ?, 'active')`)
      .bind(deviceId, participantId, deviceId, required.fieldDictionaryVersion,
        required.privacyContractVersion, ACCOUNTLESS_LEASE_ISSUED_AT,
        ACCOUNTLESS_LEASE_EXPIRES_AT),
  ]);

  // The social-owner and v1 transport guards correctly reject this synthetic
  // malformed lane. Disable only those per-test guards so the source selector
  // sees MAX+1 rows; reset restores the production schema for every test.
  await db().batch([
    db().prepare("DROP TRIGGER telemetry_transport_v1_insert"),
    db().prepare("DROP TRIGGER telemetry_v1_chunks_enforce_admission"),
    db().prepare("DROP TRIGGER telemetry_v1_chunks_require_social_owner"),
    db().prepare("DROP TRIGGER telemetry_v1_chunks_require_consuming_upload"),
    db().prepare("DROP TRIGGER telemetry_v1_chunks_consume_device_upload"),
    db().prepare("DROP TRIGGER telemetry_v1_chunks_record_admission"),
    db().prepare("DROP TRIGGER community_analytical_input_v1_insert"),
    db().prepare("DROP TRIGGER accountless_device_upload_authorization_admission"),
  ]);
  await db().prepare(`WITH RECURSIVE source_rows(value) AS (
    VALUES(0)
    UNION ALL SELECT value + 1 FROM source_rows
      WHERE value < ?
  ) INSERT INTO device_upload_authorizations (
    id, participant_id, issued_by_device_id, secret_hash, envelope_digest,
    body_bytes, content_type, state, issued_at, expires_at,
    consume_lease_expires_at
  ) SELECT
    'accountless-cap-upload-' || printf('%05d', value), ?, ?, zeroblob(32),
    printf('%064x', value + 100000), 1, 'application/json', 'consuming', ?,
    ?, ?
  FROM source_rows`).bind(
    MAX_V1_SOURCE_CHUNKS,
    participantId,
    deviceId,
    SEED_AT,
    FUTURE,
    FUTURE,
  ).run();
  await db().prepare(`WITH RECURSIVE source_rows(value) AS (
    VALUES(0)
    UNION ALL SELECT value + 1 FROM source_rows
      WHERE value < ?
  ) INSERT INTO telemetry_v1_chunks (
    id, participant_id, device_id, stream, chunk_day, chunk_seq, revision,
    chunk_digest, envelope_digest, parser_version, record_count,
    accepted_record_count, r2_key, device_upload_authorization_id, created_at
  ) SELECT
    'accountless-cap-chunk-' || printf('%05d', value), ?, ?, 'usage', ?,
    value, 1, printf('%064x', value), printf('%064x', value + 100000),
    'synthetic-public-cap', 1, 1,
    'telemetry/accountless-public-cap/' || value,
    'accountless-cap-upload-' || printf('%05d', value), ?
  FROM source_rows`).bind(
    MAX_V1_SOURCE_CHUNKS,
    participantId,
    deviceId,
    DAY,
    SEED_AT,
  ).run();
  return participantId;
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
  recordJson?: Record<string, unknown>;
}

async function seedChunk(options: {
  participantId: string;
  deviceId: string;
  createdAt: string;
  day?: string;
  seq?: number;
  stream?: "usage" | "quota" | "session";
  records: SeedRecord[];
}): Promise<void> {
  seedSequence += 1;
  const chunkRowId = `chunk-${seedSequence}`;
  const authorizationId = `authorization-${seedSequence}`;
  const stream = options.stream ?? "usage";
  const chunkDay = options.day ?? DAY;
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
      chunkDay,
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      chunkRowId,
      options.participantId,
      options.deviceId,
      stream,
      record.occurrenceId,
      `${chunkDay}T10:00:00.000Z`,
      chunkDay,
      stream === "usage" ? "openai_codex" : null,
      stream === "usage" ? record.modelId ?? "gpt-5.6-sol" : null,
      record.inputUncachedTokens ?? null,
      record.inputCacheReadTokens ?? null,
      record.inputCacheWriteTokens ?? null,
      record.outputTextTokens ?? null,
      record.outputReasoningTokens ?? null,
      record.outputCombinedTokens ?? null,
      JSON.stringify(record.recordJson ?? {}),
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
  apiEquivalentSpend: CommunityDailySpend;
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
    apiEquivalentSpend: CommunityDailySpend;
  };
}

function spendRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "openai_codex", modelId: "gpt-5.6-sol", billingSurface: "chatgpt_subscription",
    speedMode: "standard", apiServiceTier: "standard", reasoningEffort: "high",
    components: { inputUncachedTokens: 100, inputCacheReadTokens: 900, inputCacheWriteTokens: 0,
      outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: null },
    ...overrides,
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
  it("prices the exact winner once and retains partial component costs", async () => {
    const participant = await seedParticipant("spend");
    await seedDevice(participant, "spend-old");
    await seedDevice(participant, "spend-new");
    const full = spendRecord();
    // Known context permits pricing observed components without guessing the missing cache read.
    const partial = spendRecord({ totalInputContextTokens: 1000, components: { inputUncachedTokens: 100, inputCacheReadTokens: null,
      inputCacheWriteTokens: 0, outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: null } });
    const unknownContext = { ...partial, totalInputContextTokens: null };
    const unknown = spendRecord({ modelId: "unknown-model" });
    await seedChunk({ participantId: participant, deviceId: "spend-old", createdAt: "2026-08-02T00:00:00.000Z",
      records: [{ occurrenceId: "old-copy", recordJson: full }] });
    await seedChunk({ participantId: participant, deviceId: "spend-new", createdAt: "2026-08-03T00:00:00.000Z",
      records: [full, partial, unknown, {}, unknownContext].map((recordJson, index) => ({ occurrenceId: `spend-${index}`, recordJson })) });
    const payload = await rebuildAndReadDay("2026-08-04T00:00:00.000Z");
    const price = (value: Record<string, unknown>) => priceChunkUsageRecord(JSON.stringify(value), `${DAY}T10:00:00.000Z`)!;
    expect(price(full).pricingStatus).toBe("fully_priced");
    expect(price(partial).pricingStatus).toBe("partially_priced");
    expect(price(partial).costNanousd).toBeGreaterThan(0);
    expect(price(unknownContext)).toMatchObject({ pricingStatus: "unpriced", costNanousd: 0 });
    // Combined output and its splits represent the same tokens, not two bills.
    expect(price(full).costNanousd).toBe(price(spendRecord({ components: {
      inputUncachedTokens: 100, inputCacheReadTokens: 900, inputCacheWriteTokens: 0,
      outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: 75,
    } })).costNanousd);
    const expected = Number((BigInt(price(full).costNanousd) + BigInt(price(partial).costNanousd) + 50_000n) / 100_000n) / 10_000;
    expect(payload.apiEquivalentSpend).toMatchObject({ currency: "USD", knownCostUsd: expected,
      coverage: "partial", usageEvents: 5, fullyPricedUsageEvents: 1, partiallyPricedUsageEvents: 1, unpricedUsageEvents: 3 });
    expect(payload.totals.usageEvents).toBe(payload.apiEquivalentSpend.usageEvents);
    expect(isCurrentCommunityDailySpend(payload.apiEquivalentSpend)).toBe(true);
  });

  it("distinguishes wholly unpriced from genuinely empty usage", async () => {
    const participant = await seedParticipant("no-price"); await seedDevice(participant, "no-price-device");
    await seedChunk({ participantId: participant, deviceId: "no-price-device", createdAt: SEED_AT,
      records: [{ occurrenceId: "unknown", recordJson: spendRecord({ modelId: "unknown-model" }) }] });
    const pin = await loadV1SourcePin(db(), { day: DAY });
    expect(await priceCommunityDailySpend(db(), DAY, pin.winnersJson, 1, { remainingChunks: 10, remainingEvents: 10 }))
      .toMatchObject({ state: "priced", spend: { knownCostUsd: null, coverage: "unavailable", unpricedUsageEvents: 1 } });
    expect(await priceCommunityDailySpend(db(), "2026-08-02", "[]", 0, { remainingChunks: 0, remainingEvents: 0 }))
      .toMatchObject({ state: "priced", spend: { knownCostUsd: 0, coverage: "complete", usageEvents: 0 } });
  });

  it("defers whole days without publishing a subtotal or removing the queued request", async () => {
    const participant = await seedParticipant("budget"); await seedDevice(participant, "budget-device");
    await seedChunk({ participantId: participant, deviceId: "budget-device", createdAt: SEED_AT,
      records: [{ occurrenceId: "budget-event", recordJson: spendRecord() }] });
    const request = await db().prepare("SELECT * FROM community_daily_aggregate_rebuilds WHERE day=?").bind(DAY).first();
    expect(await rebuildPendingCommunityDailyAggregates(db(), Date.parse(SEED_AT), 24, { chunks: 0, events: 0 }))
      .toEqual({ processed: 0, remaining: true, aggregateIds: [] });
    expect(await readLatestCommunityDailyAggregate(db(), DAY)).toBeNull();
    expect(await db().prepare("SELECT * FROM community_daily_aggregate_rebuilds WHERE day=?").bind(DAY).first()).toEqual(request);
    expect((await rebuildAndReadDay("2026-08-02T00:00:00.000Z")).apiEquivalentSpend.coverage).toBe("complete");
  });

  it("shares the pricing budget across days and resumes without duplicating prior totals", async () => {
    const participant = await seedParticipant("shared-budget"); await seedDevice(participant, "shared-budget-device");
    for (const day of [DAY, "2026-08-02"]) {
      await seedChunk({ participantId: participant, deviceId: "shared-budget-device", day,
        createdAt: "2026-08-03T00:00:00.000Z", records: [{ occurrenceId: `usage-${day}`, recordJson: spendRecord() }] });
    }
    const scheduled = Date.parse("2026-08-03T00:00:00.000Z");
    expect(await rebuildPendingCommunityDailyAggregates(db(), scheduled, 24, { events: 1 }))
      .toMatchObject({ processed: 1, remaining: true });
    const first = await readLatestCommunityDailyAggregate(db(), DAY);
    expect(first?.revision).toBe(1);
    expect(await readLatestCommunityDailyAggregate(db(), "2026-08-02")).toBeNull();
    expect(await rebuildPendingCommunityDailyAggregates(db(), scheduled + 3_600_000, 24, { events: 1 }))
      .toMatchObject({ processed: 1, remaining: false });
    expect(await readLatestCommunityDailyAggregate(db(), DAY)).toEqual(first);
    const second = await readLatestCommunityDailyAggregate(db(), "2026-08-02");
    expect(JSON.parse(second!.payload_json).apiEquivalentSpend).toMatchObject({ usageEvents: 1, coverage: "complete" });
  });

  it("uses both chunk indexes without a dense record scan or global sort", async () => {
    const rows = (await db().prepare(`EXPLAIN QUERY PLAN ${DAILY_SPEND_RECORDS_SQL}`)
      .bind(JSON.stringify([["p", "d", "chunk"]]), DAY, 1601).all<{ parent: number; detail: string }>()).results;
    const plan = rows.map(row => row.detail);
    expect(plan.some(detail => /telemetry_v1_records_chunk.*chunk_row_id/u.test(detail))).toBe(true);
    expect(plan.some(detail => /sqlite_autoindex_telemetry_v11_records_1.*chunk_id/u.test(detail))).toBe(true);
    expect(plan.some(detail => /USE TEMP B-TREE|MATERIALIZE telemetry_analytical_records/u.test(detail))).toBe(false);
    // The outer consumer scans the bounded UNION co-routine. Neither physical
    // branch may scan records instead of seeking its selected chunk indexes.
    expect(rows.filter(row => row.parent !== 0 && /^SCAN r\b/u.test(row.detail)), plan.join("\n")).toEqual([]);
  });

  it.each([false, true])("keeps aged allowance only for price-only backfills (queued source correction: %s)", async (queuedCorrection) => {
    const participant = await seedParticipant("backfill"); await seedDevice(participant, "backfill-device");
    await seedChunk({ participantId: participant, deviceId: "backfill-device", createdAt: SEED_AT,
      records: [{ occurrenceId: "backfill-event", recordJson: spendRecord() }] });
    const allowance = { basis: "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d",
      fitCount: 2, participantCount: 1, centralUsd: 100, band80Usd: null };
    const oldJson = JSON.stringify({ allowance, totals: { usageEvents: 1 } });
    for (const [day, state] of [[DAY, "published"], ["2026-07-31", "withdrawn"]] as const) {
      await db().prepare(`INSERT INTO community_daily_aggregates
        (aggregate_id,day,revision,source_mutation_epoch,policy_version,payload_json,payload_sha256,release_state,released_at,withdrawn_at)
        VALUES (?, ?, 1, 0, 'community-daily-v1.0', ?, ?, ?, ?, ?)`)
        .bind(`community-daily:${day}:r1`, day, oldJson, "0".repeat(64), state, SEED_AT,
          state === "withdrawn" ? SEED_AT : null).run();
    }
    if (!queuedCorrection) await db().prepare("DELETE FROM community_daily_aggregate_rebuilds").run();
    expect(await rebuildPendingCommunityDailyAggregates(db(), Date.parse("2026-11-01T00:00:00.000Z")))
      .toMatchObject({ processed: 1, remaining: false });
    const published = await readLatestCommunityDailyAggregate(db(), DAY);
    expect(published?.revision).toBe(2);
    const payload = JSON.parse(published!.payload_json);
    if (queuedCorrection) {
      expect(payload.allowance.fitCount).toBe(0);
      expect(payload.allowance.centralUsd).toBeNull();
    } else expect(payload.allowance).toEqual(allowance);
    expect(payload.apiEquivalentSpend).toMatchObject({ usageEvents: 1, coverage: "complete" });
    expect((await db().prepare("SELECT payload_json FROM community_daily_aggregates WHERE day=? AND revision=1")
      .bind(DAY).first())?.payload_json).toBe(oldJson);
    expect(await readLatestCommunityDailyAggregate(db(), "2026-07-31"))
      .toMatchObject({ revision: 1, release_state: "withdrawn" });
    expect(await rebuildPendingCommunityDailyAggregates(db(), Date.parse("2026-11-01T01:00:00.000Z")))
      .toEqual({ processed: 0, remaining: false, aggregateIds: [] });
  });

  it("refuses a pricing read whose source changes before publication and retains its journal", async () => {
    const participant = await seedParticipant("price-fence"); await seedDevice(participant, "price-fence-device");
    await seedChunk({ participantId: participant, deviceId: "price-fence-device", createdAt: SEED_AT,
      records: [{ occurrenceId: "fence-event", recordJson: spendRecord() }] });
    let interleaved = false;
    const base = db();
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (property === "all" && sql === DAILY_SPEND_RECORDS_SQL) return async () => {
          const result = await target.all();
          interleaved = true;
          await base.prepare("UPDATE telemetry_v1_chunks SET chunk_digest=? WHERE device_id='price-fence-device'")
            .bind("f".repeat(64)).run();
          return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const interleaving = new Proxy(base, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(await rebuildPendingCommunityDailyAggregates(interleaving, Date.parse(SEED_AT)))
      .toMatchObject({ remaining: true });
    expect(interleaved).toBe(true);
    expect(await readLatestCommunityDailyAggregate(base, DAY)).toBeNull();
    expect(await base.prepare("SELECT day FROM community_daily_aggregate_rebuilds WHERE day=?").bind(DAY).first())
      .toEqual({ day: DAY });
  });

  it("atomically refuses historical price-only publication when a source request arrives after the last pin", async () => {
    const participant = await seedParticipant("late-request"); await seedDevice(participant, "late-request-device");
    await seedChunk({ participantId: participant, deviceId: "late-request-device", createdAt: SEED_AT,
      records: [{ occurrenceId: "late-request-event", recordJson: spendRecord() }] });
    await db().prepare(`INSERT INTO community_daily_aggregates
      (aggregate_id,day,revision,source_mutation_epoch,policy_version,payload_json,payload_sha256,release_state,released_at)
      VALUES (?, ?, 1, 0, 'community-daily-v1.0', ?, ?, 'published', ?)`)
      .bind(`community-daily:${DAY}:r1`, DAY, JSON.stringify({ totals: { usageEvents: 1 },
        allowance: { fitCount: 1, centralUsd: 100 } }), "0".repeat(64), SEED_AT).run();
    await db().prepare("DELETE FROM community_daily_aggregate_rebuilds").run();
    const base = db();
    let publishing = false;
    let interleaved = false;
    const interleaving = new Proxy(base, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => {
          if (sql.includes("INSERT INTO community_daily_aggregates")) publishing = true;
          return target.prepare(sql);
        };
        if (property === "batch") return async (statements: D1PreparedStatement[]) => {
          if (publishing) {
            publishing = false;
            interleaved = true;
            await base.prepare(`INSERT INTO community_daily_aggregate_rebuilds (day,requested_epoch,requested_at)
              SELECT ?,mutation_epoch,? FROM community_snapshot_mutation_control WHERE singleton_id=1`)
              .bind(DAY, "2026-11-01T00:00:00.000Z").run();
          }
          return target.batch(statements);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(await rebuildPendingCommunityDailyAggregates(interleaving, Date.parse("2026-11-01T00:00:00.000Z")))
      .toMatchObject({ remaining: true });
    expect(interleaved).toBe(true);
    expect(await readLatestCommunityDailyAggregate(base, DAY)).toMatchObject({ revision: 1 });
    expect(await base.prepare("SELECT day FROM community_daily_aggregate_rebuilds WHERE day=?").bind(DAY).first())
      .toEqual({ day: DAY });
  });
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

  it("bounds the public source after social ownership filtering", async () => {
    const socialParticipant = await seedParticipant("public-source-cap-social");
    await seedDevice(socialParticipant, "device-public-source-cap-social");
    await seedChunk({
      participantId: socialParticipant,
      deviceId: "device-public-source-cap-social",
      createdAt: "2026-08-02T01:00:00.000Z",
      records: [{ occurrenceId: "public-source-cap-usage", inputUncachedTokens: 42 }],
    });
    const accountlessParticipant = await seedOversizedAccountlessSourceJournal();
    expect(await db().prepare(`SELECT COUNT(*) AS count
      FROM telemetry_v1_chunks WHERE participant_id = ?`).bind(accountlessParticipant)
      .first<{ count: number }>()).toEqual({ count: MAX_V1_SOURCE_CHUNKS + 1 });

    // The unscoped private/debug source reaches its exact cap, while the
    // public selector admits the social record before applying that bound.
    await expect(loadV1SourcePin(db(), { day: DAY }))
      .rejects.toThrow("v1 source chunk limit exceeded");
    const unscoped = await loadV1SourcePin(db(), { day: DAY }, {
      // The oversized private journal plus the single social chunk.
      maxChunks: MAX_V1_SOURCE_CHUNKS + 2,
    });
    const publicPin = await loadV1SourcePin(db(), {
      day: DAY,
      ownerKind: "social",
    });
    expect(unscoped.winners).toEqual(expect.arrayContaining([
      expect.objectContaining({ participant_id: accountlessParticipant }),
      expect.objectContaining({ participant_id: socialParticipant }),
    ]));
    expect(publicPin.scope).toEqual({ day: DAY, ownerKind: "social" });
    expect(publicPin.fingerprint).not.toBe(unscoped.fingerprint);
    expect(publicPin.winners).toEqual([{
      participant_id: socialParticipant,
      observed_day: DAY,
      device_id: "device-public-source-cap-social",
      evidence: "analytical",
    }]);

    const payload = await rebuildAndReadDay("2026-08-03T12:00:00.000Z");
    expect(payload.totals).toMatchObject({
      contributingParticipants: 1,
      contributingDevices: 1,
      usageEvents: 1,
      inputUncachedTokens: 42,
    });
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
