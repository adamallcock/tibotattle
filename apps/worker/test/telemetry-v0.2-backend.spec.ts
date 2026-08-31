import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import {
  accountScopedQuotaAnalysis,
} from "../src/quota-analysis";
import { selectCommunityAllowanceAnalysisFits } from "../src/community-allowance";
import { enroll } from "../src/repository";
import {
  createUploadAuthorizationMaterial,
  claimUploadAuthorization,
  storeUploadAuthorization,
} from "../src/session";
import {
  deleteTelemetryContribution,
  personalStats,
} from "../src/telemetry-repository";
import {
  insertTelemetryContributionV02Shadow,
} from "../src/telemetry-v0.2-repository";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
}

const TRACK = `account-track:v1:${"a".repeat(64)}`;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function opaque(kind: string, value: number): string {
  const version = kind === "event" || kind === "snapshot" ? "v2" : "v1";
  return `${kind}:${version}:${BigInt(value).toString(16).padStart(64, "0")}`;
}

function toolCounts(): Record<string, number> {
  return {
    webSearch: 0,
    fileSearch: 0,
    codeInterpreter: 0,
    hostedShell: 0,
    computerUse: 0,
    mcp: 0,
    applyPatch: 0,
    localShell: 0,
    subagent: 0,
    toolGateway: 0,
    other: 0,
    unknown: 0,
  };
}

function contribution(resetIndex: number): Record<string, unknown> {
  const resetAt = Date.UTC(2026, 0, 8) + resetIndex * 7 * DAY_MS;
  const firstObserved = resetAt - 2 * DAY_MS;
  const datasetId = opaque("dataset", 1_000 + resetIndex);
  const quotaSnapshots = Array.from({ length: 10 }, (_, pointIndex) => {
    const observed = new Date(firstObserved + pointIndex * HOUR_MS).toISOString();
    return {
      schemaVersion: "quota-snapshot-v0.2",
      accountTrackId: TRACK,
      observedTime: observed,
      receivedTime: observed,
      provider: "openai_codex",
      planType: "pro",
      planVariant: "pro-20x",
      limitId: "codex",
      slot: resetIndex % 2 === 0 ? "primary" : "secondary",
      usedPercent: pointIndex,
      displayPrecision: 0,
      windowDurationMinutes: 10_080,
      resetsAt: new Date(resetAt).toISOString(),
      snapshotSource: "rollout",
      providerSurface: "account_shared_unallocated",
      snapshotId: opaque("snapshot", 10_000 + resetIndex * 100 + pointIndex),
    };
  });
  const usageEvents = Array.from({ length: 9 }, (_, eventIndex) => ({
    schemaVersion: "usage-event-v0.2",
    accountTrackId: TRACK,
    eventTime: new Date(
      firstObserved + eventIndex * HOUR_MS + HOUR_MS / 2,
    ).toISOString(),
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    modelRecognition: "recognized",
    modelFingerprint: null,
    billingSurface: "chatgpt_subscription",
    speedMode: "standard",
    apiServiceTier: "standard",
    reasoningEffort: "xhigh",
    components: {
      inputUncachedTokens: 100_000,
      inputCacheReadTokens: 900_000,
      inputCacheWriteTokens: 0,
      inputCacheWrite5mTokens: null,
      inputCacheWrite1hTokens: null,
      outputTextTokens: 20_000,
      outputReasoningTokens: 10_000,
      outputCombinedTokens: null,
    },
    totalInputContextTokens: 1_000_000,
    surface: "local_interactive_unclassified",
    agentScope: "root",
    lineageDisposition: "standalone",
    toolClassCounts: toolCounts(),
    outcome: "completed",
    eventId: opaque("event", 20_000 + resetIndex * 100 + eventIndex),
    accountingDiagnostic: {
      status: "untrusted_diagnostic",
      sourceSchemaVersion: "telemetry-contribution-v0.1",
      estimatedApiCostUsd: "999.000000",
      pricingCoveragePercent: 100,
      unknownBillableUnits: 0,
      priceBasis: "current_api_prices",
    },
  }));
  return {
    schemaVersion: "telemetry-contribution-v0.2",
    consentVersion: "privacy-safe-telemetry-v0.2",
    status: "implementation_disabled",
    synthetic: false,
    datasetId,
    partIndex: 1,
    partCount: 1,
    completeness: "complete",
    createdAt: new Date(firstObserved + 10 * HOUR_MS).toISOString(),
    coveredAt: {
      startAt: new Date(firstObserved).toISOString(),
      endAt: new Date(firstObserved + 9 * HOUR_MS).toISOString(),
    },
    clientPlatform: "macos",
    providerPolicyEpoch: "unknown",
    usageEvents,
    quotaSnapshots,
    activityMarkers: [],
    accountingDiagnostic: {
      status: "untrusted_diagnostic",
      sourceSchemaVersion: "telemetry-contribution-v0.1",
      estimatedApiCostUsd: "8991.000000",
      pricedEventCoveragePercent: 100,
      unknownModelEventCount: 0,
      unknownBillableUnits: 0,
      priceBasis: "current_api_prices",
    },
  };
}

// Distinct complete contributions from one account, with three plan eras in
// the SAME weekly reset. Neither a new dataset nor returning to Pro is a new
// reset vote. The immutable occurrence IDs remain distinct across eras.
function planEraContribution(
  ordinal: number,
  planType: "pro" | "plus",
  options: { accountTrackId?: string; startOffsetHours?: number } = {},
): Record<string, unknown> {
  const value = contribution(ordinal);
  const originalStart = Date.parse((value.coveredAt as { startAt: string }).startAt);
  const start = Date.UTC(2026, 0, 6) + (options.startOffsetHours ?? ordinal * 10) * HOUR_MS;
  const move = (time: unknown) => new Date(Date.parse(String(time)) - originalStart + start).toISOString();
  for (const [index, row] of (value.quotaSnapshots as Record<string, unknown>[]).entries()) {
    row.accountTrackId = options.accountTrackId ?? TRACK;
    row.observedTime = move(row.observedTime);
    row.receivedTime = row.observedTime;
    row.planType = planType;
    row.planVariant = planType === "pro" ? "pro-20x" : "unknown";
    row.usedPercent = index * 5;
    row.resetsAt = "2026-01-08T00:00:00.000Z";
  }
  for (const row of value.usageEvents as Record<string, unknown>[]) {
    row.accountTrackId = options.accountTrackId ?? TRACK;
    row.eventTime = move(row.eventTime);
  }
  value.createdAt = move(value.createdAt);
  value.coveredAt = {
    startAt: new Date(start).toISOString(),
    endAt: new Date(start + 9 * HOUR_MS).toISOString(),
  };
  return value;
}

interface PlanEraAnalysis {
  status: string;
  fragmentSelection?: string;
  tracks: Array<{
    continuity: { accountTrackId: string; planType: string; planVariant: string; planEraKey: string };
    evidence: { resets: Array<{ refusalCodes: string[] }> };
    calibration: { tracks: Array<{ resets: Array<{
      status: string; capacityNanousd: number | null; priorForecast: unknown;
      limitId: string; windowDurationMinutes: number; displayedSpanPp: number;
      firstObservedAt: string; lastObservedAt: string; resetsAt: string;
      refusalCodes: string[];
    }> }> };
    rolling: { status: string };
    attribution: { status: string; accountScope: string; refusedResets: Array<{ reason: string }> };
  }>;
}

function conditionalResets(analysis: PlanEraAnalysis) {
  return analysis.tracks.flatMap((track) => track.calibration.tracks
    .flatMap((calibration) => calibration.resets)
    .filter((reset) => reset.status === "conditional_estimate")
    .map((reset) => ({ ...reset, planType: track.continuity.planType,
      accountTrackId: track.continuity.accountTrackId })));
}

async function insert(
  db: D1Database,
  participant: Awaited<ReturnType<typeof enroll>>,
  plaintext: Record<string, unknown>,
  ordinal: number,
): Promise<string> {
  const serialized = JSON.stringify(plaintext);
  const envelopeDigest = await sha256Hex(`shadow-envelope-${ordinal}\u0000${serialized}`);
  const authorization = await createUploadAuthorizationMaterial(
    participant.participantId,
    participant.session.id,
    envelopeDigest,
    new TextEncoder().encode(serialized).byteLength,
  );
  await storeUploadAuthorization(db, authorization);
  const claimed = await claimUploadAuthorization(
    db,
    `Upload ${authorization.encoded}`,
    {
      envelopeDigest,
      bodyBytes: new TextEncoder().encode(serialized).byteLength,
      contentType: "application/json",
    },
  );
  const contributionId = `contribution:${crypto.randomUUID()}`;
  await insertTelemetryContributionV02Shadow(db, {
    participantId: participant.participantId,
    uploadAuthorizationId: claimed.authorizationId,
    uploadAuthorizationKind: claimed.authorizationKind,
    contributionId,
    r2Key: `telemetry-v0.2-shadow/${crypto.randomUUID()}`,
    envelopeDigest,
    receivedAt: new Date().toISOString(),
    plaintext,
  });
  return contributionId;
}

describe("disabled v0.2 backend shadow lane", () => {
  beforeEach(async () => {
    await reset();
    const bindings = env as TestBindings;
    await applyD1Migrations(bindings.USAGE_MONITOR_DB, bindings.TEST_MIGRATIONS);
    // This suite deliberately exercises the dormant adapter. Production's
    // blocked default and participant downgrade floors stay tested elsewhere.
    await bindings.USAGE_MONITOR_DB.prepare(
      "UPDATE telemetry_transport_formats SET lifecycle = 'accepted' WHERE schema_version = 'telemetry-contribution-v0.2'",
    ).run();
  });

  it("separates same-account Pro to Plus to Pro eras without changing valid capacities or reset votes", async () => {
    const db = (env as TestBindings).USAGE_MONITOR_DB;
    const control = await enroll(db, "privacy-safe-telemetry-v0.2");
    const mixed = await enroll(db, "privacy-safe-telemetry-v0.2");
    await insert(db, control, planEraContribution(0, "pro"), 0);
    const controlAnalysis = await accountScopedQuotaAnalysis(db, control.participantId) as PlanEraAnalysis;
    const controlFits = conditionalResets(controlAnalysis);
    expect(controlFits).toHaveLength(1);
    for (const [index, plan] of (["pro", "plus", "pro"] as const).entries()) {
      await insert(db, mixed, planEraContribution(index, plan), index);
    }
    const analysis = await accountScopedQuotaAnalysis(db, mixed.participantId) as PlanEraAnalysis;
    const fits = conditionalResets(analysis);
    expect(analysis.fragmentSelection).toBe("unselected_diagnostics");
    expect(analysis.tracks).toHaveLength(3);
    expect(new Set(analysis.tracks.map((track) => track.continuity.planEraKey)).size).toBe(3);
    expect(fits).toHaveLength(3);
    expect(fits.map((fit) => fit.capacityNanousd)).toEqual(Array(3).fill(controlFits[0]!.capacityNanousd));
    expect(analysis.tracks.every((track) => track.attribution.status === "legacy_conditional"
      && track.attribution.accountScope === "declared")).toBe(true);
    // A returning plan does not borrow a forecast across the intervening plan.
    expect(analysis.tracks.every((track) => track.rolling.status === "not_testable")).toBe(true);
    const selected = selectCommunityAllowanceAnalysisFits(mixed.participantId, [{ source: "v0.2", analysis }]);
    expect(selected).toHaveLength(2);
    expect(selected.map((fit) => fit.planType).sort()).toEqual(["plus", "pro"]);
  });

  it.each(["pro", "plus"] as const)("does not let another account's unpriced %s activity poison account A", async (plan) => {
    const db = (env as TestBindings).USAGE_MONITOR_DB;
    const participant = await enroll(db, "privacy-safe-telemetry-v0.2");
    await insert(db, participant, planEraContribution(0, "pro"), 0);
    const before = conditionalResets(await accountScopedQuotaAnalysis(db, participant.participantId) as PlanEraAnalysis);
    expect(before).toHaveLength(1);
    const otherTrack = `account-track:v1:${"b".repeat(64)}`;
    const other = planEraContribution(1, plan, { accountTrackId: otherTrack, startOffsetHours: 0 });
    const unknown = (other.usageEvents as Record<string, unknown>[])[0]!;
    unknown.modelRecognition = "unrecognized";
    unknown.modelId = "unknown";
    unknown.modelFingerprint = opaque("model", 42);
    (other.accountingDiagnostic as Record<string, unknown>).unknownModelEventCount = 1;
    await insert(db, participant, other, 1);
    const analysis = await accountScopedQuotaAnalysis(db, participant.participantId) as PlanEraAnalysis;
    const fits = conditionalResets(analysis);
    expect(fits).toHaveLength(1);
    expect(fits[0]!.accountTrackId).toBe(TRACK);
    expect(fits[0]!.capacityNanousd).toBe(before[0]!.capacityNanousd);
    const refused = analysis.tracks.find((track) => track.continuity.accountTrackId === otherTrack)!;
    expect(refused.evidence.resets
      .some((reset) => reset.refusalCodes.includes("incomplete_server_pricing"))).toBe(true);
    expect(refused.calibration.tracks.flatMap((track) => track.resets)
      .every((reset) => reset.refusalCodes.includes("source_evidence_refused"))).toBe(true);
  });

  it("does not publish a 20-only fit when 80 percent of overlapping v0.2 usage has no account", async () => {
    const db = (env as TestBindings).USAGE_MONITOR_DB;
    const participant = await enroll(db, "privacy-safe-telemetry-v0.2");
    await insert(db, participant, planEraContribution(0, "pro"), 0);
    expect(conditionalResets(await accountScopedQuotaAnalysis(db, participant.participantId) as PlanEraAnalysis))
      .toHaveLength(1);
    const unknown = planEraContribution(2, "pro", { accountTrackId: "unattributed", startOffsetHours: 0 });
    unknown.quotaSnapshots = [];
    for (const event of unknown.usageEvents as Record<string, unknown>[]) {
      const components = event.components as Record<string, number | null>;
      for (const [key, value] of Object.entries(components)) if (value !== null) components[key] = value * 4;
      event.totalInputContextTokens = Number(event.totalInputContextTokens) * 4;
    }
    await insert(db, participant, unknown, 2);
    const analysis = await accountScopedQuotaAnalysis(db, participant.participantId) as PlanEraAnalysis;
    expect(analysis.status).toBe("ready");
    expect(conditionalResets(analysis)).toHaveLength(0);
    expect(analysis.tracks[0]!.attribution.refusedResets).toEqual([
      expect.objectContaining({ reason: "usage_account_unresolved" }),
    ]);
    expect(selectCommunityAllowanceAnalysisFits(participant.participantId, [{ source: "v0.2", analysis }]))
      .toHaveLength(0);
    const stored = await db.prepare(`
      SELECT COUNT(*) AS count, SUM(CASE WHEN account_track_id = 'unattributed' THEN 1 ELSE 0 END) AS unknown
      FROM telemetry_records WHERE participant_id = ? AND record_kind = 'usage'`)
      .bind(participant.participantId).first<{ count: number; unknown: number }>();
    expect(stored).toEqual({ count: 18, unknown: 9 }); // Retained, not dropped or zeroed.

    const later = contribution(1);
    for (const [index, row] of (later.quotaSnapshots as Record<string, unknown>[]).entries()) row.usedPercent = index * 5;
    await insert(db, participant, later, 1);
    const withLater = await accountScopedQuotaAnalysis(db, participant.participantId) as PlanEraAnalysis;
    expect(conditionalResets(withLater)).toHaveLength(1); // Unknowns outside this reset are not a blanket refusal.
    expect(conditionalResets(withLater)[0]!.resetsAt).toBe("2026-01-15T00:00:00.000Z");
  });

  it("does not confuse positively measured zero-cost unattributed usage with missing pricing", async () => {
    const db = (env as TestBindings).USAGE_MONITOR_DB;
    const participant = await enroll(db, "privacy-safe-telemetry-v0.2");
    await insert(db, participant, planEraContribution(0, "pro"), 0);
    const before = conditionalResets(await accountScopedQuotaAnalysis(db, participant.participantId) as PlanEraAnalysis);
    const zero = planEraContribution(1, "pro", { accountTrackId: "unattributed", startOffsetHours: 0 });
    zero.quotaSnapshots = [];
    for (const event of zero.usageEvents as Record<string, unknown>[]) {
      const components = event.components as Record<string, number | null>;
      for (const [key, value] of Object.entries(components)) if (value !== null) components[key] = 0;
      event.totalInputContextTokens = 0;
    }
    await insert(db, participant, zero, 1);
    const analysis = await accountScopedQuotaAnalysis(db, participant.participantId) as PlanEraAnalysis;
    expect(conditionalResets(analysis)).toHaveLength(1);
    expect(conditionalResets(analysis)[0]!.capacityNanousd).toBe(before[0]!.capacityNanousd);
    expect(analysis.tracks[0]!.attribution.refusedResets).toHaveLength(0);
  });

  it("uses a tiny foreign-plan five-hour observation before weekly fitability filtering", async () => {
    const db = (env as TestBindings).USAGE_MONITOR_DB;
    const participant = await enroll(db, "privacy-safe-telemetry-v0.2");
    const value = planEraContribution(0, "pro");
    const quota = value.quotaSnapshots as Record<string, unknown>[];
    const observedTime = "2026-01-06T04:30:00.000Z";
    quota.push({ ...quota[0], snapshotId: opaque("snapshot", 800_000),
      planType: "plus", planVariant: "unknown", observedTime, receivedTime: observedTime,
      windowDurationMinutes: 300, slot: "primary", usedPercent: 1,
      resetsAt: "2026-01-06T09:30:00.000Z" });
    await insert(db, participant, value, 0);
    const analysis = await accountScopedQuotaAnalysis(db, participant.participantId) as PlanEraAnalysis;
    expect(analysis.status).toBe("ready");
    expect(analysis.tracks.filter((track) => track.continuity.planType === "pro")).toHaveLength(2);
    expect(conditionalResets(analysis)).toHaveLength(0);
    expect(selectCommunityAllowanceAnalysisFits(participant.participantId,
      [{ source: "v0.2", analysis }])).toHaveLength(0);
  });

  it("persists account-scoped files, reprices on the server, and recomputes private analysis", async () => {
    const bindings = env as TestBindings;
    const participant = await enroll(
      bindings.USAGE_MONITOR_DB,
      "privacy-safe-telemetry-v0.2",
    );
    for (let index = 0; index < 4; index += 1) {
      await insert(bindings.USAGE_MONITOR_DB, participant, contribution(index), index);
    }

    const stored = await bindings.USAGE_MONITOR_DB.prepare(
      `SELECT
          COUNT(*) AS contributions,
          MIN(transport_schema_version) AS transport_schema_version,
          SUM(CASE WHEN dataset_id IS NOT NULL THEN 1 ELSE 0 END) AS dataset_rows
         FROM telemetry_contributions
        WHERE participant_id = ?`,
    ).bind(participant.participantId).first<{
      contributions: number;
      transport_schema_version: string;
      dataset_rows: number;
    }>();
    expect(stored).toEqual({
      contributions: 4,
      transport_schema_version: "telemetry-contribution-v0.2",
      dataset_rows: 4,
    });
    const tracks = await bindings.USAGE_MONITOR_DB.prepare(
      `SELECT COUNT(*) AS total
         FROM telemetry_records
        WHERE participant_id = ? AND account_track_id = ?`,
    ).bind(participant.participantId, TRACK).first<{ total: number }>();
    expect(tracks?.total).toBe(76);

    const analysis = await accountScopedQuotaAnalysis(
      bindings.USAGE_MONITOR_DB,
      participant.participantId,
    ) as any;
    expect(analysis.status).toBe("ready");
    expect(analysis.tracks).toHaveLength(1);
    expect(analysis.tracks[0].calibration.tracks[0].estimatedResetCount).toBe(4);
    expect(analysis.tracks[0].rolling.status).toBe("conditional_comparison");
    expect(analysis.tracks[0].rolling.comparisons.length).toBeGreaterThan(0);

    const stats = await personalStats(
      bindings.USAGE_MONITOR_DB,
      participant.participantId,
    ) as any;
    expect(stats.totals.usageEvents).toBe(36);
    expect(stats.totals.quotaSnapshots).toBe(40);
    expect(stats.totals.apiPriceEquivalentUsd).not.toBe("35964");
    expect(stats.totals.priceVerification).toBe("server_repriced");
    expect(stats.accountScopedQuotaAnalysis.status).toBe("ready");
  });

  it("keeps private account analysis participant-isolated", async () => {
    const bindings = env as TestBindings;
    const first = await enroll(
      bindings.USAGE_MONITOR_DB,
      "privacy-safe-telemetry-v0.2",
    );
    const second = await enroll(
      bindings.USAGE_MONITOR_DB,
      "privacy-safe-telemetry-v0.2",
    );
    await insert(bindings.USAGE_MONITOR_DB, first, contribution(0), 0);
    const other = await accountScopedQuotaAnalysis(
      bindings.USAGE_MONITOR_DB,
      second.participantId,
    ) as any;
    expect(other).toMatchObject({
      status: "not_testable",
      reason: "account_scoped_dataset_unavailable",
      tracks: [],
    });
  });

  it("rejects conflicting occurrence reuse instead of silently relabeling it", async () => {
    const bindings = env as TestBindings;
    const participant = await enroll(
      bindings.USAGE_MONITOR_DB,
      "privacy-safe-telemetry-v0.2",
    );
    const original = contribution(0);
    await insert(bindings.USAGE_MONITOR_DB, participant, original, 0);
    const conflict = structuredClone(original);
    const events = conflict.usageEvents as Array<Record<string, unknown>>;
    events[0]!.accountTrackId = `account-track:v1:${"b".repeat(64)}`;
    await expect(
      insert(bindings.USAGE_MONITOR_DB, participant, conflict, 1),
    ).rejects.toMatchObject({
      status: 409,
      code: "TELEMETRY_OCCURRENCE_CONFLICT",
    });
    const count = await bindings.USAGE_MONITOR_DB.prepare(
      "SELECT COUNT(*) AS total FROM telemetry_contributions WHERE participant_id = ?",
    ).bind(participant.participantId).first<{ total: number }>();
    expect(count?.total).toBe(1);
  });

  it("removes deleted dataset parts and recomputes from retained contributions", async () => {
    const bindings = env as TestBindings;
    const participant = await enroll(
      bindings.USAGE_MONITOR_DB,
      "privacy-safe-telemetry-v0.2",
    );
    const ids = [];
    for (let index = 0; index < 4; index += 1) {
      ids.push(await insert(
        bindings.USAGE_MONITOR_DB,
        participant,
        contribution(index),
        index,
      ));
    }
    await deleteTelemetryContribution(
      bindings.USAGE_MONITOR_DB,
      participant.participantId,
      ids[3]!,
    );
    const analysis = await accountScopedQuotaAnalysis(
      bindings.USAGE_MONITOR_DB,
      participant.participantId,
    ) as any;
    expect(analysis.status).toBe("ready");
    expect(analysis.tracks[0].calibration.tracks[0].totalResetCount).toBe(3);
    const counts = await bindings.USAGE_MONITOR_DB.prepare(
      `SELECT
          (SELECT COUNT(*) FROM telemetry_contributions
            WHERE participant_id = ?) AS contributions,
          (SELECT COUNT(*) FROM telemetry_records
            WHERE participant_id = ?) AS records`,
    ).bind(participant.participantId, participant.participantId).first<{
      contributions: number;
      records: number;
    }>();
    expect(counts).toEqual({ contributions: 3, records: 57 });
  });

  // csf_efc6acb1: a near-maximal corpus with one distinct continuity track per
  // row previously drove per-track full-array rescans into quadratic work. The
  // distinct-track ceiling now rejects the adversarial corpus before any
  // per-track analysis begins.
  it("rejects an adversarial high-cardinality corpus before any per-track analysis", async () => {
    const bindings = env as TestBindings;
    const participant = await enroll(
      bindings.USAGE_MONITOR_DB,
      "privacy-safe-telemetry-v0.2",
    );

    // 300 distinct account tracks (> the 256 continuity-track ceiling) spread
    // across two datasets, each within the 200-record-per-contribution and
    // 100-dataset limits. Every quota snapshot is on its own track, so each is a
    // distinct continuity seed. A handful of usage events keeps the contribution
    // contract-valid; usage rows do not create seeds.
    const MIN_MS = 60_000;
    const perContribution = 150;
    for (let datasetIndex = 0; datasetIndex < 2; datasetIndex += 1) {
      const datasetId = opaque("dataset", 9_000 + datasetIndex);
      const firstObserved = Date.UTC(2026, 0, 8) + datasetIndex * DAY_MS;
      const span = (perContribution - 1) * MIN_MS;
      const resetsAt = new Date(firstObserved + 30 * DAY_MS).toISOString();
      const quotaSnapshots = Array.from(
        { length: perContribution },
        (_, snapshotIndex) => {
          const ordinal = datasetIndex * perContribution + snapshotIndex;
          const observed = new Date(firstObserved + snapshotIndex * MIN_MS)
            .toISOString();
          return {
            schemaVersion: "quota-snapshot-v0.2",
            accountTrackId:
              `account-track:v1:${ordinal.toString(16).padStart(64, "0")}`,
            observedTime: observed,
            receivedTime: observed,
            provider: "openai_codex",
            planType: "pro",
            planVariant: "pro-20x",
            limitId: "codex",
            slot: snapshotIndex % 2 === 0 ? "primary" : "secondary",
            usedPercent: 0,
            displayPrecision: 0,
            windowDurationMinutes: 10_080,
            resetsAt,
            snapshotSource: "rollout",
            providerSurface: "account_shared_unallocated",
            snapshotId: opaque("snapshot", 900_000 + ordinal),
          };
        },
      );
      const usageEvents = Array.from({ length: 5 }, (_, eventIndex) => ({
        schemaVersion: "usage-event-v0.2",
        accountTrackId:
          `account-track:v1:${(700_000 + datasetIndex * 10 + eventIndex)
            .toString(16).padStart(64, "0")}`,
        eventTime: new Date(firstObserved + eventIndex * MIN_MS).toISOString(),
        provider: "openai_codex",
        modelId: "gpt-5.6-sol",
        modelRecognition: "recognized",
        modelFingerprint: null,
        billingSurface: "chatgpt_subscription",
        speedMode: "standard",
        apiServiceTier: "standard",
        reasoningEffort: "xhigh",
        components: {
          inputUncachedTokens: 100_000,
          inputCacheReadTokens: 900_000,
          inputCacheWriteTokens: 0,
          inputCacheWrite5mTokens: null,
          inputCacheWrite1hTokens: null,
          outputTextTokens: 20_000,
          outputReasoningTokens: 10_000,
          outputCombinedTokens: null,
        },
        totalInputContextTokens: 1_000_000,
        surface: "local_interactive_unclassified",
        agentScope: "root",
        lineageDisposition: "standalone",
        toolClassCounts: toolCounts(),
        outcome: "completed",
        eventId: opaque("event", 800_000 + datasetIndex * 10 + eventIndex),
        accountingDiagnostic: {
          status: "untrusted_diagnostic",
          sourceSchemaVersion: "telemetry-contribution-v0.1",
          estimatedApiCostUsd: "1.000000",
          pricingCoveragePercent: 100,
          unknownBillableUnits: 0,
          priceBasis: "current_api_prices",
        },
      }));
      const contributionRecord = {
        schemaVersion: "telemetry-contribution-v0.2",
        consentVersion: "privacy-safe-telemetry-v0.2",
        status: "implementation_disabled",
        synthetic: false,
        datasetId,
        partIndex: 1,
        partCount: 1,
        completeness: "complete",
        createdAt: new Date(firstObserved + span + MIN_MS).toISOString(),
        coveredAt: {
          startAt: new Date(firstObserved).toISOString(),
          endAt: new Date(firstObserved + span).toISOString(),
        },
        clientPlatform: "macos",
        providerPolicyEpoch: "unknown",
        usageEvents,
        quotaSnapshots,
        activityMarkers: [],
        accountingDiagnostic: {
          status: "untrusted_diagnostic",
          sourceSchemaVersion: "telemetry-contribution-v0.1",
          estimatedApiCostUsd: "5.000000",
          pricedEventCoveragePercent: 100,
          unknownModelEventCount: 0,
          unknownBillableUnits: 0,
          priceBasis: "current_api_prices",
        },
      };
      await insert(
        bindings.USAGE_MONITOR_DB,
        participant,
        contributionRecord,
        9_000 + datasetIndex,
      );
    }

    const distinctTracks = await bindings.USAGE_MONITOR_DB.prepare(
      `SELECT COUNT(DISTINCT account_track_id) AS total
         FROM telemetry_contribution_occurrences
        WHERE participant_id = ? AND record_kind = 'quota'`,
    ).bind(participant.participantId).first<{ total: number }>();
    expect(distinctTracks?.total).toBe(300);

    const analysis = await accountScopedQuotaAnalysis(
      bindings.USAGE_MONITOR_DB,
      participant.participantId,
    ) as { status: string; reason?: string; tracks: unknown[] };
    // The ceiling is enforced before any per-track flatMap or downstream
    // analysis: no track results are produced.
    expect(analysis).toMatchObject({
      status: "not_testable",
      reason: "continuity_track_limit_exceeded",
      tracks: [],
    });
  }, 60_000);
});
