import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildCommunityWeeklySnapshot,
  rebuildPendingCommunityWeeklySnapshots,
} from "../src/community-snapshots";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_DELETION_LEDGER_MIGRATIONS: D1Migration[];
}

const PERIOD_START = "2026-07-20T00:00:00.000Z";
const PERIOD_END = "2026-07-27T00:00:00.000Z";
const CUTOFF = "2026-07-29T00:00:00.000Z";
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

function db(): D1Database {
  return (env as TestBindings).USAGE_MONITOR_DB;
}

// The builder's only batch is finalization; interleave a real D1 mutation
// immediately before it so each SQL fence is exercised, not mocked away.
function beforeFinalization(callback: () => Promise<void>): D1Database {
  return new Proxy(db(), {
    get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        await callback();
        return target.batch(statements);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function advanceEpoch(): Promise<void> {
  await db().prepare(
    `UPDATE community_snapshot_mutation_control SET mutation_epoch = mutation_epoch + 1
      WHERE singleton_id = 1`,
  ).run();
}

async function insertParticipant(
  index: number,
  {
    grantPrefix = "open",
    identityLinkKey = index.toString(16).padStart(2, "0").repeat(32),
  }: { grantPrefix?: "open" | "invite"; identityLinkKey?: string | null } = {},
): Promise<string> {
  const participantId = `participant:snapshot-test-${index}`;
  const hash = new Uint8Array(32).fill(index + 1);
  const now = "2026-07-01T00:00:00.000Z";
  const grantId = `${grantPrefix}:snapshot-test-${index}`;
  await db().batch([
    db().prepare(
      `INSERT INTO participants (
        id, access_token_id, access_token_hash, recovery_token_id,
        recovery_token_hash, state, consent_version, consented_at, created_at,
        identity_link_key
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    ).bind(
      participantId,
      `access:${index}`,
      hash,
      `recovery:${index}`,
      hash,
      "privacy-safe-telemetry-v0.1",
      now,
      now,
      identityLinkKey,
    ),
    db().prepare(
      `INSERT INTO enrollment_grants (
        id, secret_hash, state, issued_at, expires_at,
        redeemed_at, redeemed_participant_id
      ) VALUES (?, ?, 'redeemed', ?, ?, ?, ?)`,
    ).bind(grantId, hash, now, FAR_FUTURE, now, participantId),
    db().prepare(
      `INSERT INTO participant_community_eligibility (
        id, participant_id, grant_id, created_at
      ) VALUES (?, ?, ?, ?)`,
    ).bind(`eligibility:snapshot-test-${index}`, participantId, grantId, now),
  ]);
  return participantId;
}

async function insertAcceptedContribution(
  participantId: string,
  index: number,
  acceptedAt: string,
  modelId: string,
): Promise<void> {
  const suffix = `${index.toString(16).padStart(2, "0")}${acceptedAt.slice(8, 10)}${modelId}`;
  const digest = `${index.toString(16).padStart(8, "0")}${acceptedAt.slice(8, 10)}${
    modelId === "gpt-5.6-sol" ? "a" : "b"
  }${"0".repeat(64)}`.slice(0, 64);
  const contributionId = `contribution:snapshot-test-${suffix}`;
  const sessionId = `session:snapshot-test-${suffix}`;
  const authorizationId = `upload:snapshot-test-${suffix}`;
  const hash = new Uint8Array(32).fill(index + 3);
  const usageOccurrence = `event:snapshot-test-${suffix}`;
  const quotaOccurrence = `quota:snapshot-test-${suffix}`;
  await db().batch([
    db().prepare(
      `INSERT INTO web_sessions (
        id, participant_id, secret_hash, csrf_hash, scope, state,
        issued_at, expires_at, last_used_at
      ) VALUES (?, ?, ?, ?, 'personal', 'active', ?, ?, ?)`,
    ).bind(sessionId, participantId, hash, hash, acceptedAt, FAR_FUTURE, acceptedAt),
    db().prepare(
      `INSERT INTO upload_authorizations (
        id, participant_id, issued_by_session_id, secret_hash,
        envelope_digest, body_bytes, content_type, state, issued_at,
        expires_at, consume_lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, 1, 'application/json', 'consuming', ?, ?, ?)`,
    ).bind(
      authorizationId,
      participantId,
      sessionId,
      hash,
      digest,
      acceptedAt,
      FAR_FUTURE,
      FAR_FUTURE,
    ),
    db().prepare(
      `INSERT INTO telemetry_contributions (
        id, participant_id, plaintext_digest, envelope_digest, r2_key,
        status, schema_version, range_start, range_end, client_platform,
        provider_policy_epoch, estimated_api_cost_usd,
        priced_event_coverage_percent, unknown_model_event_count,
        unknown_billable_units, price_basis, declared_record_count,
        created_at, upload_authorization_id
      ) VALUES (?, ?, ?, ?, ?, 'accepted', 'telemetry-contribution-v0.1',
        ?, ?, 'macos', 'snapshot-test', NULL, 100, 0, 0,
        'server_repricing', 2, ?, ?)`,
    ).bind(
      contributionId,
      participantId,
      digest,
      digest,
      `quarantine/${contributionId}`,
      PERIOD_START,
      PERIOD_END,
      acceptedAt,
      authorizationId,
    ),
    db().prepare(
      `INSERT INTO telemetry_records (
        origin_contribution_id, participant_id, record_kind, occurrence_id,
        observed_at, provider, model_id, plan_type, plan_variant,
        input_uncached_tokens, output_text_tokens, output_reasoning_tokens,
        output_combined_tokens, tool_units, record_json
      ) VALUES (?, ?, 'usage', ?, ?, 'openai_codex', ?, 'pro', 'pro-20x',
        100, 50, 25, 75, 1, '{}')`,
    ).bind(contributionId, participantId, usageOccurrence, acceptedAt, modelId),
    db().prepare(
      `INSERT INTO telemetry_records (
        origin_contribution_id, participant_id, record_kind, occurrence_id,
        observed_at, provider, model_id, plan_type, plan_variant, record_json
      ) VALUES (?, ?, 'quota', ?, ?, 'openai_codex', ?, 'pro', 'pro-20x', '{}')`,
    ).bind(contributionId, participantId, quotaOccurrence, acceptedAt, modelId),
    db().prepare(
      `INSERT INTO telemetry_contribution_occurrences (
        contribution_id, participant_id, record_kind, occurrence_id
      ) VALUES (?, ?, 'usage', ?), (?, ?, 'quota', ?)`,
    ).bind(
      contributionId,
      participantId,
      usageOccurrence,
      contributionId,
      participantId,
      quotaOccurrence,
    ),
  ]);
}

async function seedMatureOpenCohort(modelIds = ["gpt-5.6-sol"]): Promise<string[]> {
  const participants: string[] = [];
  for (let index = 0; index < 20; index += 1) {
    const participantId = await insertParticipant(index);
    participants.push(participantId);
    for (const [day, modelId] of modelIds.entries()) {
      await insertAcceptedContribution(
        participantId,
        index * 10 + day,
        day === 0 ? "2026-07-25T12:00:00.000Z" : "2026-07-26T12:00:00.000Z",
        modelId,
      );
    }
  }
  return participants;
}

beforeEach(async () => {
  const bindings = env as TestBindings;
  await reset();
  await applyD1Migrations(bindings.USAGE_MONITOR_DB, bindings.TEST_MIGRATIONS);
  await applyD1Migrations(
    bindings.DELETION_LEDGER,
    bindings.TEST_DELETION_LEDGER_MIGRATIONS,
  );
});

describe("community aggregate safety", () => {
  it.each(["suppressed", "published"] as const)(
    "replaces an older %s epoch after ingest without deleting or rewriting sealed data",
    async (releaseState) => {
      const participant = releaseState === "published"
        ? (await seedMatureOpenCohort(["gpt-5.6-sol", "gpt-5.6-terra"]))[0]
        : await insertParticipant(0);
      if (!participant) throw new Error("synthetic cohort participant missing");
      const first = await buildCommunityWeeklySnapshot(db(), Date.parse(CUTOFF));
      const before = await db().prepare(
        "SELECT * FROM community_weekly_snapshots WHERE snapshot_id = ?",
      ).bind(first.snapshotId).first();
      expect(before!.release_state).toBe(releaseState);
      // Exercise the real 0043 ingest trigger, not only a direct epoch update.
      await insertAcceptedContribution(participant, 900, "2026-07-25T12:00:00.000Z", "gpt-5.6-sol");
      const records = await db().prepare("SELECT * FROM telemetry_records ORDER BY id").all();
      const contributions = await db().prepare("SELECT * FROM telemetry_contributions ORDER BY id").all();
      const second = await buildCommunityWeeklySnapshot(db(), Date.parse(CUTOFF));
      expect(second.state).toBe("built");
      expect(second.snapshotId).not.toBe(first.snapshotId);
      const after = await db().prepare(
        "SELECT * FROM community_weekly_snapshots WHERE snapshot_id = ?",
      ).bind(first.snapshotId).first();
      expect(after).toEqual({
        ...before,
        release_state: "withdrawn",
        withdrawn_at: CUTOFF,
        withdrawal_epoch: Number(before!.source_mutation_epoch) + 1,
      });
      expect(await buildCommunityWeeklySnapshot(db(), Date.parse(CUTOFF))).toEqual({
        state: "existing", snapshotId: second.snapshotId,
      });
      expect(await db().prepare(
        "SELECT COUNT(*) AS count FROM community_weekly_snapshots",
      ).first()).toEqual({ count: 2 });
      expect(await db().prepare(
        "SELECT COUNT(*) AS count FROM community_weekly_snapshot_rebuilds",
      ).first()).toEqual({ count: 0 });
      expect((await db().prepare("SELECT * FROM telemetry_records ORDER BY id").all()).results)
        .toEqual(records.results);
      expect((await db().prepare("SELECT * FROM telemetry_contributions ORDER BY id").all()).results)
        .toEqual(contributions.results);
    },
  );

  it.each(["epoch", "owner", "lease_epoch", "lease_expiry"] as const)(
    "does not withdraw or drain a queued rebuild after a %s race",
    async (race) => {
      const first = await buildCommunityWeeklySnapshot(db(), Date.parse(CUTOFF));
      const before = await db().prepare(
        "SELECT * FROM community_weekly_snapshots WHERE snapshot_id = ?",
      ).bind(first.snapshotId).first();
      await advanceEpoch();
      const epoch = Number(before!.source_mutation_epoch) + 1;
      // An older queue entry makes an unfenced journal UPSERT observable.
      await db().prepare(
        `INSERT INTO community_weekly_snapshot_rebuilds
          (week_start, week_end, ingestion_cutoff_at, requested_epoch, requested_at)
          VALUES (?, ?, ?, ?, ?)`,
      ).bind(PERIOD_START, PERIOD_END, CUTOFF, epoch - 1, PERIOD_END).run();
      const queued = await db().prepare("SELECT * FROM community_weekly_snapshot_rebuilds").first();
      let interleaved = false;
      const guarded = beforeFinalization(async () => {
        interleaved = true;
        if (race === "epoch") await advanceEpoch();
        else if (race === "owner") await db().prepare(
          "UPDATE community_snapshot_builders SET owner_nonce = 'replacement-owner'",
        ).run();
        else if (race === "lease_epoch") await db().prepare(
          "UPDATE community_snapshot_builders SET mutation_epoch = mutation_epoch + 1",
        ).run();
        else await db().prepare(
          "UPDATE community_snapshot_builders SET lease_expires_at = ?",
        ).bind(CUTOFF).run();
      });
      await expect(buildCommunityWeeklySnapshot(guarded, Date.parse(CUTOFF)))
        .rejects.toThrow("community snapshot finalization cancelled or conflicted");
      expect(interleaved).toBe(true);
      expect(await db().prepare("SELECT * FROM community_weekly_snapshots").first()).toEqual(before);
      expect(await db().prepare("SELECT * FROM community_weekly_snapshot_rebuilds").first()).toEqual(queued);
      expect(await db().prepare("SELECT COUNT(*) AS count FROM community_weekly_snapshots").first())
        .toEqual({ count: 1 });
      if (race === "owner") expect(await db().prepare(
        "SELECT owner_nonce FROM community_snapshot_builders",
      ).first()).toEqual({ owner_nonce: "replacement-owner" });
    },
  );

  it("rolls back journal and withdrawal if the replacement INSERT aborts, then retries", async () => {
    const first = await buildCommunityWeeklySnapshot(db(), Date.parse(CUTOFF));
    const before = await db().prepare("SELECT * FROM community_weekly_snapshots").first();
    await advanceEpoch();
    const epoch = Number(before!.source_mutation_epoch) + 1;
    await db().prepare(
      `INSERT INTO community_weekly_snapshot_rebuilds
        (week_start, week_end, ingestion_cutoff_at, requested_epoch, requested_at)
        VALUES (?, ?, ?, ?, ?)`,
    ).bind(PERIOD_START, PERIOD_END, CUTOFF, epoch - 1, PERIOD_END).run();
    const queued = await db().prepare("SELECT * FROM community_weekly_snapshot_rebuilds").first();
    await db().prepare(
      `CREATE TRIGGER test_replacement_abort BEFORE INSERT ON community_weekly_snapshots
        WHEN NEW.revision = 2 BEGIN SELECT RAISE(ABORT, 'synthetic replacement failure'); END`,
    ).run();
    await expect(buildCommunityWeeklySnapshot(db(), Date.parse(CUTOFF)))
      .rejects.toThrow("synthetic replacement failure");
    expect(await db().prepare("SELECT * FROM community_weekly_snapshots").first()).toEqual(before);
    expect(await db().prepare("SELECT * FROM community_weekly_snapshot_rebuilds").first()).toEqual(queued);
    await db().prepare("DROP TRIGGER test_replacement_abort").run();
    const replacement = await buildCommunityWeeklySnapshot(db(), Date.parse(CUTOFF) + 6 * 60_000);
    expect(replacement).toEqual({ state: "built", snapshotId: `${first.snapshotId}:r2` });
    expect(await db().prepare("SELECT COUNT(*) AS count FROM community_weekly_snapshot_rebuilds").first())
      .toEqual({ count: 0 });
  });

  it("retains a newer queued epoch and unrelated sealed weeks during replacement", async () => {
    const previous = await buildCommunityWeeklySnapshot(db(), Date.parse(CUTOFF) - 7 * 86_400_000);
    const previousRow = await db().prepare(
      "SELECT * FROM community_weekly_snapshots WHERE snapshot_id = ?",
    ).bind(previous.snapshotId).first();
    const first = await buildCommunityWeeklySnapshot(db(), Date.parse(CUTOFF));
    await advanceEpoch();
    const epoch = await db().prepare(
      "SELECT mutation_epoch FROM community_snapshot_mutation_control WHERE singleton_id = 1",
    ).first<{ mutation_epoch: number }>();
    await db().prepare(
      `INSERT INTO community_weekly_snapshot_rebuilds
        (week_start, week_end, ingestion_cutoff_at, requested_epoch, requested_at)
        VALUES (?, ?, ?, ?, ?)`,
    ).bind(PERIOD_START, PERIOD_END, CUTOFF, epoch!.mutation_epoch + 1, CUTOFF).run();
    const queued = await db().prepare("SELECT * FROM community_weekly_snapshot_rebuilds").first();
    expect(await buildCommunityWeeklySnapshot(db(), Date.parse(CUTOFF)))
      .toEqual({ state: "built", snapshotId: `${first.snapshotId}:r2` });
    expect(await db().prepare("SELECT * FROM community_weekly_snapshot_rebuilds").first()).toEqual(queued);
    expect(await db().prepare(
      "SELECT * FROM community_weekly_snapshots WHERE snapshot_id = ?",
    ).bind(previous.snapshotId).first()).toEqual(previousRow);
  });

  it("preserves a racing policy withdrawal and its newer journal until a fresh rebuild", async () => {
    const first = await buildCommunityWeeklySnapshot(db(), Date.parse(CUTOFF));
    await advanceEpoch();
    let withdrawn: Record<string, unknown> | null = null;
    let queued: Record<string, unknown> | null = null;
    const guarded = beforeFinalization(async () => {
      await db().prepare(
        `UPDATE community_snapshot_policy
          SET maturity_days = maturity_days + 1, policy_revision = policy_revision + 1,
              updated_at = ?, updated_by_digest = ? WHERE singleton_id = 1`,
      ).bind(CUTOFF, "c".repeat(64)).run();
      withdrawn = await db().prepare("SELECT * FROM community_weekly_snapshots").first();
      queued = await db().prepare("SELECT * FROM community_weekly_snapshot_rebuilds").first();
    });
    await expect(buildCommunityWeeklySnapshot(guarded, Date.parse(CUTOFF)))
      .rejects.toThrow("community snapshot finalization cancelled or conflicted");
    const persistedWithdrawal = await db().prepare("SELECT * FROM community_weekly_snapshots").first();
    expect(persistedWithdrawal?.release_state).toBe("withdrawn");
    expect(persistedWithdrawal).toEqual(withdrawn);
    expect(await db().prepare("SELECT * FROM community_weekly_snapshot_rebuilds").first()).toEqual(queued);
    const rebuilt = await rebuildPendingCommunityWeeklySnapshots(db(), Date.parse(CUTOFF) + 1000);
    expect(rebuilt).toEqual({ processed: 1, remaining: false, snapshotIds: [`${first.snapshotId}:r2`] });
    expect(await db().prepare(
      "SELECT * FROM community_weekly_snapshots WHERE snapshot_id = ?",
    ).bind(first.snapshotId).first()).toEqual(withdrawn);
  });

  it("applies maturity and account-level clipping deterministically", async () => {
    await seedMatureOpenCohort(["gpt-5.6-sol", "gpt-5.6-terra"]);
    await db().prepare(
      `UPDATE community_snapshot_policy
          SET account_usage_events_cap = 1,
              account_token_components_cap = 100,
              account_tool_units_cap = 1,
              policy_revision = policy_revision + 1,
              updated_at = ?,
              updated_by_digest = ?
        WHERE singleton_id = 1`,
    ).bind(CUTOFF, "a".repeat(64)).run();
    const result = await buildCommunityWeeklySnapshot(
      db(),
      Date.parse(CUTOFF),
    );
    expect(result.state).toBe("built");
    const row = await db().prepare(
      `SELECT payload_json, source_mutation_epoch
         FROM community_weekly_snapshots WHERE snapshot_id = ?`,
    ).bind(result.snapshotId).first<{
      payload_json: string;
      source_mutation_epoch: number;
    }>();
    const currentEpoch = await db().prepare(
      `SELECT mutation_epoch FROM community_snapshot_mutation_control
        WHERE singleton_id = 1`,
    ).first<{ mutation_epoch: number }>();
    expect(row?.source_mutation_epoch).toBe(currentEpoch?.mutation_epoch);
    const payload = JSON.parse(row!.payload_json) as Record<string, any>;
    expect(payload.schemaVersion).toBe("community-weekly-snapshot-v0.3");
    expect(payload.cohortEligibility).toBe(
      "provider_account_gated_open_cohort",
    );
    expect(payload.releaseStatus).toBe("published");
    expect(payload.privacyPolicy).toMatchObject({
      minimumProviderAccountParticipants: 20,
      maturity: {
        maturityDays: 7,
        minimumAcceptedCollectionDays: 2,
      },
      clipping: {
        usageEventsPerParticipantPerSnapshot: 1,
        tokensPerComponentPerParticipantPerSnapshot: 100,
        toolUnitsPerParticipantPerSnapshot: 1,
      },
    });
    expect(payload.cells).toHaveLength(2);
    expect(payload.cells[0].metrics.usageEvents.value).toBe(20);
    expect(payload.cells[1].metrics.usageEvents.value).toBe(0);
    // The existing 100,000-token quantum remains in force after account
    // clipping; this deliberately rounds the small fixture to zero.
    expect(payload.cells[0].metrics.inputUncachedTokens.value).toBe(0);
  });

  it("allows aggregate policy changes only to tighten the published v0.3 contract", async () => {
    for (const update of [
      "maturity_days = 6",
      "minimum_accepted_collection_days = 1",
      "account_usage_events_cap = 1001",
      "account_token_components_cap = 5000001",
      "account_tool_units_cap = 1001",
    ]) {
      await expect(db().prepare(
        `UPDATE community_snapshot_policy SET ${update} WHERE singleton_id = 1`,
      ).run()).rejects.toThrow();
    }
    for (const override of [
      { maturityDays: 6 },
      { minimumAcceptedCollectionDays: 1 },
      { accountUsageEventsCap: 1001 },
      { accountTokenComponentsCap: 5_000_001 },
      { accountToolUnitsCap: 1001 },
    ]) {
      await expect(buildCommunityWeeklySnapshot(
        db(),
        Date.parse(CUTOFF),
        override,
      )).rejects.toThrow("invalid community snapshot policy");
    }
  });

  it("keeps invite-only participants out of the v0.3 open provider-account cohort", async () => {
    await seedMatureOpenCohort(["gpt-5.6-sol", "gpt-5.6-terra"]);
    for (let index = 0; index < 10; index += 1) {
      const participantId = await insertParticipant(index + 100, {
        grantPrefix: "invite",
        identityLinkKey: null,
      });
      await insertAcceptedContribution(
        participantId,
        (index + 100) * 10,
        "2026-07-25T12:00:00.000Z",
        "gpt-5.6-sol",
      );
      await insertAcceptedContribution(
        participantId,
        (index + 100) * 10 + 1,
        "2026-07-26T12:00:00.000Z",
        "gpt-5.6-terra",
      );
    }
    const result = await buildCommunityWeeklySnapshot(db(), Date.parse(CUTOFF));
    expect(result.state).toBe("built");
    const row = await db().prepare(
      "SELECT payload_json FROM community_weekly_snapshots WHERE snapshot_id = ?",
    ).bind(result.snapshotId).first<{ payload_json: string }>();
    const payload = JSON.parse(row!.payload_json) as Record<string, any>;
    expect(payload.cohortEligibility).toBe("provider_account_gated_open_cohort");
    expect(payload.releaseStatus).toBe("published");
    expect(payload.cells.map((cell: any) => cell.metrics.usageEvents.value)).toEqual([20, 20]);
  });

  it("withdraws and queues a deterministic rebuild when an exclusion changes", async () => {
    const participants = await seedMatureOpenCohort();
    const first = await buildCommunityWeeklySnapshot(db(), Date.parse(CUTOFF));
    expect(first.state).toBe("built");
    await db().prepare(
      `INSERT INTO community_aggregate_exclusions (
        exclusion_id, participant_id, scope, reason_code, state,
        effective_at, created_at, created_by_digest
      ) VALUES (?, ?, 'community_weekly', 'abuse_signal', 'active', ?, ?, ?)`,
    ).bind(
      "exclusion:snapshot-test",
      participants[0],
      PERIOD_START,
      CUTOFF,
      "b".repeat(64),
    ).run();
    const withdrawn = await db().prepare(
      `SELECT release_state FROM community_weekly_snapshots
        WHERE snapshot_id = ?`,
    ).bind(first.snapshotId).first<{ release_state: string }>();
    expect(withdrawn?.release_state).toBe("withdrawn");
    const queued = await db().prepare(
      `SELECT week_start, requested_epoch FROM community_weekly_snapshot_rebuilds`,
    ).all<{ week_start: string; requested_epoch: number }>();
    expect(queued.results).toHaveLength(1);
    expect(queued.results[0]).toMatchObject({ week_start: PERIOD_START });
    await expect(db().prepare(
      "DELETE FROM community_aggregate_exclusions WHERE exclusion_id = ?",
    ).bind("exclusion:snapshot-test").run()).rejects.toThrow();
    await db().prepare(
      `UPDATE community_aggregate_exclusions
          SET state = 'revoked', revoked_at = ?, revoked_by_digest = ?
        WHERE exclusion_id = ?`,
    ).bind(CUTOFF, "c".repeat(64), "exclusion:snapshot-test").run();
    const audit = await db().prepare(
      `SELECT state, created_by_digest, revoked_by_digest
         FROM community_aggregate_exclusions
        WHERE exclusion_id = ?`,
    ).bind("exclusion:snapshot-test").first();
    expect(audit).toEqual({
      state: "revoked",
      created_by_digest: "b".repeat(64),
      revoked_by_digest: "c".repeat(64),
    });
  });

  it("rejects an open account that is young or has one accepted day", async () => {
    const participantId = await insertParticipant(0);
    await db().prepare(
      "UPDATE participants SET created_at = ? WHERE id = ?",
    ).bind("2026-07-24T00:00:00.000Z", participantId).run();
    await insertAcceptedContribution(
      participantId,
      99,
      "2026-07-25T12:00:00.000Z",
      "gpt-5.6-sol",
    );
    const result = await buildCommunityWeeklySnapshot(db(), Date.parse(CUTOFF));
    expect(result.state).toBe("built");
    const row = await db().prepare(
      "SELECT payload_json FROM community_weekly_snapshots WHERE snapshot_id = ?",
    ).bind(result.snapshotId).first<{ payload_json: string }>();
    expect(JSON.parse(row!.payload_json)).toMatchObject({
      releaseStatus: "suppressed",
      cells: [],
    });
  });
});
