import { describe, expect, it } from "vitest";
import { buildPlanAttributionIndex, planEraForInterval } from "@app-usagemonitor/quota-analysis";
import {
  advanceV11QuotaAcquisition,
  createV11QuotaAcquisitionCheckpoint,
  decodeV11QuotaWorkCheckpoint,
  encodeV11QuotaWorkCheckpoint,
  validateV11CompletedQuotaAcquisition,
  v11QuotaAcquisitionIdentityMatches,
  V11_QUOTA_ACQUISITION_PAGE_SIZE,
} from "../src/quota-analysis-v11-reader";
import type {
  V11QuotaAcquisitionCheckpoint,
  V11QuotaAcquisitionIdentity,
  V11QuotaPageReader,
} from "../src/quota-analysis-v11-reader";
import type { V11QuotaPageRow, V11QuotaSourceRow } from "../src/typed-v11-quota-reader";

const BASE = Date.parse("2026-08-01T00:00:00.000Z");
const RESET = "2026-08-08T00:00:00.000Z";
const ACCOUNT = "account-track:v2:" + "a".repeat(64);
const IDENTITY: V11QuotaAcquisitionIdentity = {
  participantId: "synthetic-v11-reader-participant", inputFingerprint: "a".repeat(64),
  sourceMethodVersion: "synthetic-v11-reader", observedAtCutoff: "2026-08-01T00:00:00.000Z",
  resetsAtCutoff: RESET, windowMinutes: 10_080, maxQuotaRows: 60_000,
};
const at = (offset: number) => new Date(BASE + offset).toISOString();

function sourceRow(sourceRowId: number, usedPercent: number, offset = sourceRowId * 1_000,
  patch: Partial<V11QuotaSourceRow> = {}): V11QuotaPageRow {
  const observedAtMs = BASE + offset;
  const active: V11QuotaSourceRow = {
    id: sourceRowId, observedAtMs, observedAt: at(offset), observedDay: "2026-08-01", deviceId: "device",
    provider: "openai_codex", limitId: "codex", planType: "pro", planVariant: "unknown",
    accountBasis: "same_source", accountTrackId: ACCOUNT, planBasis: "same_source_occurrence",
    planEraId: null, occurrenceId: `quota-occurrence:v1:${String(sourceRowId).padStart(64, "0")}`,
    slot: "seven_day", usedPercent, windowDurationMinutes: 10_080, resetsAtMs: Date.parse(RESET), resetsAt: RESET,
    ...patch,
  };
  return { physicalId: sourceRowId, sourceRowId, observedAtMs, active };
}

function fixtureReader(rows: V11QuotaPageRow[]): { reader: V11QuotaPageReader; calls: number } {
  const ordered = [...rows].sort((left, right) => left.observedAtMs - right.observedAtMs
    || left.sourceRowId - right.sourceRowId);
  let calls = 0;
  return {
    get calls() { return calls; },
    reader: {
      pageSize: V11_QUOTA_ACQUISITION_PAGE_SIZE,
      async readPage(cursor, limit) {
        calls += 1;
        return ordered.filter((row) => row.observedAtMs > cursor.observedAtMs
          || row.observedAtMs === cursor.observedAtMs && row.sourceRowId > cursor.sourceRowId).slice(0, limit);
      },
    },
  };
}

async function finish(rows: V11QuotaPageRow[], maxQuotaRows = IDENTITY.maxQuotaRows) {
  const fixture = fixtureReader(rows);
  const identity = { ...IDENTITY, maxQuotaRows };
  let checkpoint: V11QuotaAcquisitionCheckpoint | undefined;
  const phases = new Set<string>();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const budget = { remainingQueries: 1, deadlineMs: 1, now: () => 0 };
    const result = await advanceV11QuotaAcquisition(fixture.reader, identity, budget, checkpoint);
    expect(budget.remainingQueries).toBe(0);
    if (result.status !== "deferred") return { result, phases, calls: fixture.calls };
    phases.add(result.checkpoint.phase);
    const encoded = JSON.parse(JSON.stringify(encodeV11QuotaWorkCheckpoint(result.checkpoint))) as {
      control: unknown; components: unknown;
    };
    checkpoint = decodeV11QuotaWorkCheckpoint(identity, encoded.control, encoded.components);
  }
  throw new Error("synthetic v11 acquisition did not finish");
}

describe("resumable v1.1 quota acquisition", () => {
  it("retains flat-run endpoints while paging the physical owner stream", async () => {
    const rows: V11QuotaPageRow[] = [];
    for (let level = 0; level < 9; level += 1) {
      for (let repeat = 0; repeat < 150; repeat += 1) {
        rows.push(sourceRow(rows.length + 1, level * 10));
      }
    }
    const expected = rows.filter((row, index) => index % 150 === 0 || index % 150 === 149)
      .map((row) => row.active!.occurrenceId);
    const { result, phases, calls } = await finish(rows);
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.quotaRows.map((row) => row.occurrence_id)).toEqual(expected);
    expect(result.attributionIndex.eras).toHaveLength(1);
    expect([...phases].sort()).toEqual(["endpoints", "fitability", "plan"]);
    expect(calls).toBe(6);
  });

  it("keeps retired rows in the physical cursor and excludes them from evidence", async () => {
    const rows = [
      ...Array.from({ length: V11_QUOTA_ACQUISITION_PAGE_SIZE * 2 }, (_, index) =>
        sourceRow(index + 1, 10, index * 1_000)),
      ...Array.from({ length: 9 }, (_, index) => sourceRow(V11_QUOTA_ACQUISITION_PAGE_SIZE * 3 + index,
        index * 10, V11_QUOTA_ACQUISITION_PAGE_SIZE * 3_000 + index * 1_000)),
    ];
    for (const row of rows.slice(0, V11_QUOTA_ACQUISITION_PAGE_SIZE * 2)) row.active = null;
    const { result, calls } = await finish(rows);
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.quotaRows).toHaveLength(9);
    expect(calls).toBe(9);
  });

  it("matches the shared plan builder at equal-time plan changes", async () => {
    const prefix = Array.from({ length: V11_QUOTA_ACQUISITION_PAGE_SIZE - 1 }, (_, index) =>
      sourceRow(index + 1, 0, index * 1_000));
    const boundary = V11_QUOTA_ACQUISITION_PAGE_SIZE * 1_000;
    const rows = [...prefix,
      sourceRow(V11_QUOTA_ACQUISITION_PAGE_SIZE, 10, boundary, { planType: "plus" }),
      sourceRow(V11_QUOTA_ACQUISITION_PAGE_SIZE + 1, 20, boundary, { planType: "pro" }),
      sourceRow(V11_QUOTA_ACQUISITION_PAGE_SIZE + 2, 30, boundary + 1_000, { planType: "pro" }),
    ];
    const full = buildPlanAttributionIndex(rows.map((row) => ({
      contextKey: "openai_codex|codex", accountScopeId: ACCOUNT, observedAtMs: row.observedAtMs,
      planType: row.active!.planType, planVariant: row.active!.planVariant!, continuityId: row.active!.planEraId,
      conflicted: row.active!.planBasis === "conflicted",
    })));
    const { result } = await finish(rows);
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.attributionIndex.eras).toEqual(full.eras);
    expect(result.attributionIndex.conflicts).toEqual(full.conflicts);
    expect(planEraForInterval(result.attributionIndex, {
      contextKey: "openai_codex|codex", accountScopeId: ACCOUNT, observedAtMs: BASE + 1_500,
    })).toEqual(planEraForInterval(full, {
      contextKey: "openai_codex|codex", accountScopeId: ACCOUNT, observedAtMs: BASE + 1_500,
    }));
  });

  it("does not query after a zero budget and rejects malformed physical pages", async () => {
    const fixture = fixtureReader([]);
    expect((await advanceV11QuotaAcquisition(fixture.reader, IDENTITY,
      { remainingQueries: 0, deadlineMs: 1, now: () => 0 })).status).toBe("deferred");
    expect(fixture.calls).toBe(0);
    const invalidReader: V11QuotaPageReader = {
      pageSize: V11_QUOTA_ACQUISITION_PAGE_SIZE,
      async readPage() { return [sourceRow(2, 0), sourceRow(1, 0)]; },
    };
    await expect(advanceV11QuotaAcquisition(invalidReader, IDENTITY,
      { remainingQueries: 1, deadlineMs: 1, now: () => 0 })).rejects.toThrow("page order invalid");
  });

  it("preserves unknown account and plan-era fields without promoting them to identity", async () => {
    const rows = Array.from({ length: 9 }, (_, index) => sourceRow(index + 1, index * 10, index * 1_000, {
      accountBasis: "unavailable", accountTrackId: null,
      planType: "unknown", planVariant: "unknown", planBasis: "unavailable", planEraId: null,
    }));
    const { result } = await finish(rows);
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.attributionIndex.eras[0]?.accountScopeId).toBeNull();
    expect(result.quotaRows.every((row) => row.account_scope_id === null)).toBe(true);
    expect(result.quotaRows.every((row) => row.plan_type === "unknown")).toBe(true);
  });

  it("binds completed evidence to the exact acquisition identity", async () => {
    const { result } = await finish(Array.from({ length: 9 }, (_, index) =>
      sourceRow(index + 1, index * 10, index * 1_000)));
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(result.planAnchors.findIndex((anchor) => !validateV11CompletedQuotaAcquisition({
      identity: result.identity, planAnchors: [anchor], quotaRows: [],
    }))).toBe(-1);
    expect(result.quotaRows.findIndex((row) => !validateV11CompletedQuotaAcquisition({
      identity: result.identity, planAnchors: [], quotaRows: [row],
    }))).toBe(-1);
    expect(new Set(result.quotaRows.map((row) => row.occurrence_id)).size).toBe(result.quotaRows.length);
    const acquisition = { identity: result.identity, planAnchors: result.planAnchors, quotaRows: result.quotaRows };
    expect(validateV11CompletedQuotaAcquisition(acquisition)).toBe(true);
    expect(v11QuotaAcquisitionIdentityMatches(result.identity, IDENTITY)).toBe(true);
    for (const field of ["participantId", "inputFingerprint", "sourceMethodVersion"] as const) {
      const wrong = { ...result.identity,
        [field]: field === "participantId" ? "other-v11-participant"
          : field === "inputFingerprint" ? "b".repeat(64) : "other-v11-method",
      };
      expect(v11QuotaAcquisitionIdentityMatches(wrong, IDENTITY)).toBe(false);
    }
    expect(validateV11CompletedQuotaAcquisition({
      planAnchors: result.planAnchors, quotaRows: result.quotaRows,
    })).toBe(false);
  });
});
