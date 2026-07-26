import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/errors";
import {
  TELEMETRY_V02_CONSENT_VERSION,
  TELEMETRY_V02_ENABLED,
  telemetryAccountTrackPartitionKey,
  validateTelemetryContributionV02,
  type AccountTrackId,
} from "../src/telemetry-v0.2";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
}

const TRACK = `account-track:v1:${"a".repeat(64)}` as AccountTrackId;
const DATASET = `dataset:v1:${"d".repeat(64)}`;

function fixture(): Record<string, unknown> {
  return {
    schemaVersion: "telemetry-contribution-v0.2",
    consentVersion: "privacy-safe-telemetry-v0.2",
    status: "implementation_disabled",
    synthetic: false,
    datasetId: DATASET,
    partIndex: 1,
    partCount: 2,
    completeness: "complete",
    createdAt: "2026-07-25T13:00:00.000Z",
    coveredAt: {
      startAt: "2026-07-25T12:00:00.000Z",
      endAt: "2026-07-25T12:30:00.000Z",
    },
    clientPlatform: "macos",
    providerPolicyEpoch: "openai_agentic_pool_2026_07_09",
    usageEvents: [{
      schemaVersion: "usage-event-v0.2",
      accountTrackId: TRACK,
      eventTime: "2026-07-25T12:05:00.000Z",
      provider: "openai_codex",
      modelId: "gpt-5.6-sol",
      modelRecognition: "recognized",
      modelFingerprint: null,
      billingSurface: "chatgpt_subscription",
      speedMode: "fast",
      apiServiceTier: "priority",
      reasoningEffort: "xhigh",
      components: {
        inputUncachedTokens: 100,
        inputCacheReadTokens: 900,
        inputCacheWriteTokens: 0,
        inputCacheWrite5mTokens: null,
        inputCacheWrite1hTokens: null,
        outputTextTokens: 50,
        outputReasoningTokens: 25,
        outputCombinedTokens: null,
      },
      totalInputContextTokens: 1000,
      surface: "local_interactive_unclassified",
      agentScope: "root",
      lineageDisposition: "standalone",
      toolClassCounts: {
        webSearch: 1,
        fileSearch: 0,
        codeInterpreter: 0,
        hostedShell: 0,
        computerUse: 0,
        mcp: 0,
        applyPatch: 1,
        localShell: 2,
        subagent: 0,
        toolGateway: 1,
        other: 0,
        unknown: 0,
      },
      outcome: "completed",
      eventId: `event:v2:${"e".repeat(64)}`,
      accountingDiagnostic: {
        status: "untrusted_diagnostic",
        sourceSchemaVersion: "telemetry-contribution-v0.1",
        estimatedApiCostUsd: "1.000000",
        pricingCoveragePercent: 100,
        unknownBillableUnits: 0,
        priceBasis: "current_api_prices",
      },
    }],
    quotaSnapshots: [{
      schemaVersion: "quota-snapshot-v0.2",
      accountTrackId: TRACK,
      observedTime: "2026-07-25T12:10:00.000Z",
      receivedTime: "2026-07-25T12:10:01.000Z",
      provider: "openai_codex",
      planType: "pro",
      planVariant: "pro-20x",
      limitId: "codex",
      slot: "seven_day",
      usedPercent: 31,
      displayPrecision: 0,
      windowDurationMinutes: 10_080,
      resetsAt: "2026-07-31T12:00:00.000Z",
      snapshotSource: "rollout",
      providerSurface: "account_shared_unallocated",
      snapshotId: `snapshot:v2:${"b".repeat(64)}`,
    }],
    activityMarkers: [{
      schemaVersion: "activity-marker-v0.2",
      accountTrackId: "unattributed",
      observedTime: "2026-07-25T12:15:00.000Z",
      provider: "openai_codex",
      surface: "quiet_period",
      state: "pulse",
      agenticPoolCoupling: "not_applicable",
      planType: "pro",
      planVariant: "pro-20x",
      markerId: `marker:v2:${"c".repeat(64)}`,
    }],
    accountingDiagnostic: {
      status: "untrusted_diagnostic",
      sourceSchemaVersion: "telemetry-contribution-v0.1",
      estimatedApiCostUsd: "1.000000",
      pricedEventCoveragePercent: 100,
      unknownModelEventCount: 0,
      unknownBillableUnits: 0,
      priceBasis: "current_api_prices",
    },
  };
}

function expectCode(value: unknown, code: string): void {
  try {
    validateTelemetryContributionV02(value);
    throw new Error("expected validation failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(code);
  }
}

describe("disabled telemetry v0.2 contract", () => {
  it("accepts only the renewed-consent closed contract and remains disabled", () => {
    expect(TELEMETRY_V02_ENABLED).toBe(false);
    expect(TELEMETRY_V02_CONSENT_VERSION).toBe("privacy-safe-telemetry-v0.2");
    expect(validateTelemetryContributionV02(fixture())).toMatchObject({
      schemaVersion: "telemetry-contribution-v0.2",
      consentVersion: "privacy-safe-telemetry-v0.2",
      status: "implementation_disabled",
    });
  });

  it("accepts only unattributed or participant-scoped track syntax on every row", () => {
    const value = fixture();
    const usage = (value.usageEvents as Array<Record<string, unknown>>)[0]!;
    usage.accountTrackId = "unattributed";
    expect(() => validateTelemetryContributionV02(value)).not.toThrow();

    for (const bad of [
      `account-track:v1:${"A".repeat(64)}`,
      `account-track:v1:${"a".repeat(63)}`,
      "unknown",
      null,
    ]) {
      const candidate = fixture();
      (candidate.quotaSnapshots as Array<Record<string, unknown>>)[0]!
        .accountTrackId = bad;
      expectCode(candidate, "TELEMETRY_RECORD_INVALID");
    }
  });

  it("rejects direct local account scopes and identity/content canaries", () => {
    for (const bad of [
      `account:v1:${"a".repeat(64)}`,
      `openai-account:v1:${"a".repeat(64)}`,
    ]) {
      const value = fixture();
      (value.usageEvents as Array<Record<string, unknown>>)[0]!.accountTrackId = bad;
      expectCode(value, "PRIVACY_CANARY_DETECTED");
    }

    for (const injected of [
      { participantId: "participant:00000000-0000-4000-8000-000000000000" },
      { sessionId: "um_session_private" },
      { email: "person@example.test" },
      { path: "/Users/person/private.json" },
      { prompt: "private content" },
    ]) {
      expectCode({ ...fixture(), ...injected }, "PRIVACY_CANARY_DETECTED");
    }
  });

  it("rejects unknown fields and mixed v0.1/v0.2 row families", () => {
    expectCode({ ...fixture(), extra: true }, "TELEMETRY_RECORD_INVALID");

    const mixed = fixture();
    (mixed.usageEvents as Array<Record<string, unknown>>)[0]!.schemaVersion =
      "usage-event-v0.1";
    expectCode(mixed, "TELEMETRY_RECORD_INVALID");
  });

  it("rejects invalid dataset part and covered-interval semantics", () => {
    const mutations = [
      (value: Record<string, unknown>) => {
        value.partIndex = 3;
      },
      (value: Record<string, unknown>) => {
        value.partIndex = 0;
      },
      (value: Record<string, unknown>) => {
        value.partCount = 0;
      },
      (value: Record<string, unknown>) => {
        value.partCount = 101;
      },
      (value: Record<string, unknown>) => {
        value.completeness = "unknown";
      },
      (value: Record<string, unknown>) => {
        value.datasetId = `dataset:v1:${"A".repeat(64)}`;
      },
      (value: Record<string, unknown>) => {
        value.coveredAt = {
          startAt: "2026-07-25T12:30:00.000Z",
          endAt: "2026-07-25T12:00:00.000Z",
        };
      },
    ];
    for (const mutate of mutations) {
      const value = fixture();
      mutate(value);
      expectCode(value, "TELEMETRY_RECORD_INVALID");
    }
  });

  it("bounds individual record arrays and the combined part size", () => {
    const value = fixture();
    value.usageEvents = Array.from(
      { length: 201 },
      () => structuredClone((fixture().usageEvents as unknown[])[0]),
    );
    expectCode(value, "TELEMETRY_RECORD_INVALID");

    const combined = fixture();
    combined.usageEvents = Array.from(
      { length: 100 },
      () => structuredClone((fixture().usageEvents as unknown[])[0]),
    );
    combined.quotaSnapshots = Array.from(
      { length: 101 },
      () => structuredClone((fixture().quotaSnapshots as unknown[])[0]),
    );
    expectCode(combined, "TELEMETRY_RECORD_INVALID");
  });

  it("builds a delimiter-safe server-side partition key", () => {
    const participant = "participant:00000000-0000-4000-8000-000000000000";
    expect(telemetryAccountTrackPartitionKey(
      participant,
      TRACK,
      "openai_codex",
    )).toBe(`${participant}\u0000${TRACK}\u0000openai_codex`);
    expect(() => telemetryAccountTrackPartitionKey(
      "participant:invalid",
      TRACK,
      "openai_codex",
    )).toThrow("Invalid telemetry account-track partition");
  });
});

describe("account-track v0.2 forward-only migration", () => {
  beforeEach(async () => {
    await reset();
    const bindings = env as TestBindings;
    await applyD1Migrations(bindings.USAGE_MONITOR_DB, bindings.TEST_MIGRATIONS);
  });

  it("adds constrained private telemetry columns without changing community tables", async () => {
    const bindings = env as TestBindings;
    const recordColumns = await bindings.USAGE_MONITOR_DB.prepare(
      "PRAGMA table_info(telemetry_records)",
    ).all<{ name: string; notnull: number; dflt_value: string | null }>();
    expect(recordColumns.results).toContainEqual(expect.objectContaining({
      name: "account_track_id",
      notnull: 1,
      dflt_value: "'unattributed'",
    }));

    const contributionColumns = await bindings.USAGE_MONITOR_DB.prepare(
      "PRAGMA table_info(telemetry_contributions)",
    ).all<{ name: string }>();
    expect(contributionColumns.results.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "dataset_id",
        "dataset_part_index",
        "dataset_part_count",
        "dataset_completeness",
        "dataset_range_start",
        "dataset_range_end",
      ]),
    );

    const communityColumns = await bindings.USAGE_MONITOR_DB.prepare(
      "PRAGMA table_info(community_weekly_snapshots)",
    ).all<{ name: string }>();
    expect(communityColumns.results.map((column) => column.name)).not.toContain(
      "account_track_id",
    );
    expect(communityColumns.results.map((column) => column.name)).not.toContain(
      "dataset_id",
    );
  });

  it("installs account/time, quota duration/reset, and dataset indexes and guards", async () => {
    const bindings = env as TestBindings;
    const objects = await bindings.USAGE_MONITOR_DB.prepare(
      `SELECT name, type, sql
         FROM sqlite_master
        WHERE name LIKE 'telemetry_%account%'
           OR name LIKE 'telemetry_%dataset%'`,
    ).all<{ name: string; type: string; sql: string }>();
    const names = objects.results.map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining([
      "telemetry_contributions_participant_dataset_part",
      "telemetry_contributions_participant_dataset",
      "telemetry_records_usage_account_time",
      "telemetry_records_quota_account_reset",
      "telemetry_contributions_dataset_metadata_insert",
      "telemetry_contributions_dataset_metadata_update",
    ]));

    const quotaIndex = objects.results.find(
      (row) => row.name === "telemetry_records_quota_account_reset",
    )?.sql ?? "";
    expect(quotaIndex).toContain("account_track_id");
    expect(quotaIndex).toContain("window_duration_minutes");
    expect(quotaIndex).toContain("resets_at");

    const contributionTable = await bindings.USAGE_MONITOR_DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'telemetry_contributions'",
    ).first<{ sql: string }>();
    expect(contributionTable?.sql).toContain(
      "dataset_part_index BETWEEN 1 AND 100",
    );
    const datasetInsertGuard = objects.results.find(
      (row) => row.name === "telemetry_contributions_dataset_metadata_insert",
    )?.sql ?? "";
    expect(datasetInsertGuard).toContain(
      "NEW.dataset_part_index > NEW.dataset_part_count",
    );

    const recordTable = await bindings.USAGE_MONITOR_DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'telemetry_records'",
    ).first<{ sql: string }>();
    expect(recordTable?.sql).toContain("account-track:v1:");
    expect(recordTable?.sql).toContain("NOT GLOB '*[^0-9a-f]*'");
  });
});
