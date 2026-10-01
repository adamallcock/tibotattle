import { describe, expect, it, vi } from "vitest";
import {
  advanceV11QuotaAcquisition,
  createV11QuotaAcquisitionCheckpoint,
  decodeV11QuotaWorkCheckpoint,
  encodeV11QuotaWorkCheckpoint,
  validateV11QuotaWorkControl,
  V11_QUOTA_ACQUISITION_PAGE_SIZE,
  V11_QUOTA_ACQUISITION_VERSION,
} from "../src/quota-analysis-v11-reader";
import type {
  V11QuotaAcquisitionCheckpoint,
  V11QuotaAcquisitionIdentity,
  V11QuotaAcquisitionStep,
  V11QuotaPageReader,
} from "../src/quota-analysis-v11-reader";
import {
  TYPED_V11_QUOTA_PAGE_SIZE,
  V11_QUOTA_PAGE_SIZE_BUDGET,
} from "../src/typed-v11-quota-reader";
import type { V11QuotaPageRow, V11QuotaSourceRow } from "../src/typed-v11-quota-reader";
import { QUOTA_RESET_CLUSTER_TOLERANCE_MS } from "../src/quota-endpoint-collapse";
import {
  STORAGE_GRAPH_V11_CHECKPOINT_PAGES_PER_CLAIM,
  STORAGE_GRAPH_V11_CONTINUE_QUERIES,
  STORAGE_GRAPH_V11_GROUP_QUERY_COSTS,
} from "../src/storage-community-graph";

/** The page size every in-flight production checkpoint was staged under. */
const LEGACY_PAGE_SIZE = 4_096;
const BASE = Date.parse("2026-08-01T00:00:00.000Z");
const RESET = "2026-08-08T00:00:00.000Z";
const RESET_MS = Date.parse(RESET);
const ACCOUNT = "account-track:v2:" + "a".repeat(64);
const IDENTITY: V11QuotaAcquisitionIdentity = {
  participantId: "synthetic-v11-page-size", inputFingerprint: "c".repeat(64),
  sourceMethodVersion: "synthetic-v11-page-size", observedAtCutoff: "2026-08-01T00:00:00.000Z",
  resetsAtCutoff: RESET, windowMinutes: 10_080, maxQuotaRows: 60_000,
};

/** A jittery owner stream. Each pool restates `resets_at` in one-minute steps,
 * so consecutive instants are inside the cluster tolerance while the hull they
 * single-linkage into spans far more than it: the pool a row belongs to, and
 * therefore the key every later sub-phase uses, is only known once the whole
 * window has been seen. A second pool sits a day away so the hulls stay
 * disjoint, and the displayed values carry enough distinct boundaries and span
 * for both pools to be fitable. */
function jitteryRows(count: number): V11QuotaPageRow[] {
  const rows: V11QuotaPageRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const sourceRowId = index + 1;
    const observedAtMs = BASE + index * 1_000;
    const pool = index % 2;
    const drift = index % 500 * 60_000;
    const resetsAtMs = RESET_MS + pool * 24 * 60 * 60_000 + drift;
    const active: V11QuotaSourceRow = {
      id: sourceRowId, observedAtMs, observedAt: new Date(observedAtMs).toISOString(),
      observedDay: new Date(observedAtMs).toISOString().slice(0, 10), deviceId: "device",
      provider: "openai_codex", limitId: "codex", planType: "pro", planVariant: "unknown",
      accountBasis: "same_source", accountTrackId: ACCOUNT, planBasis: "same_source_occurrence",
      planEraId: null, occurrenceId: `quota-occurrence:v1:${String(sourceRowId).padStart(64, "0")}`,
      slot: pool === 0 ? "seven_day" : "five_hour",
      usedPercent: index % 37 * 2.5, windowDurationMinutes: 10_080,
      resetsAtMs, resetsAt: new Date(resetsAtMs).toISOString(),
    };
    rows.push({ physicalId: sourceRowId, sourceRowId, observedAtMs, active });
  }
  return rows;
}

function fixtureReader(rows: readonly V11QuotaPageRow[], pageSize: number): V11QuotaPageReader {
  return {
    pageSize: pageSize as typeof V11_QUOTA_ACQUISITION_PAGE_SIZE,
    async readPage(cursor, limit) {
      return rows.filter((row) => row.observedAtMs > cursor.observedAtMs
        || row.observedAtMs === cursor.observedAtMs && row.sourceRowId > cursor.sourceRowId).slice(0, limit);
    },
  };
}

/** One whole-page step, exactly as a graph claim spends a statement. */
function budget() { return { remainingQueries: 1, deadlineMs: 1, now: () => 0 }; }

/** Round trip through the part encoder the checkpoint store persists, so a
 * resumed checkpoint is the decoded bytes rather than a live object. */
function roundTrip(identity: V11QuotaAcquisitionIdentity,
  checkpoint: V11QuotaAcquisitionCheckpoint): V11QuotaAcquisitionCheckpoint {
  const encoded = JSON.parse(JSON.stringify(encodeV11QuotaWorkCheckpoint(checkpoint))) as {
    control: unknown; components: unknown;
  };
  expect(validateV11QuotaWorkControl(encoded.control)).toBe(true);
  return decodeV11QuotaWorkCheckpoint(identity, encoded.control, encoded.components);
}

async function runToCompletion(reader: V11QuotaPageReader, identity: V11QuotaAcquisitionIdentity,
  start?: V11QuotaAcquisitionCheckpoint): Promise<V11QuotaAcquisitionStep> {
  let checkpoint = start;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const step = await advanceV11QuotaAcquisition(reader, identity, budget(), checkpoint);
    if (step.status !== "deferred") return step;
    checkpoint = roundTrip(identity, step.checkpoint);
  }
  throw new Error("v1.1 acquisition did not finish");
}

/** The acquisition as it was compiled against the 4,096-row page, so a
 * checkpoint really is staged by the reader production is running today. */
async function legacyReader() {
  vi.resetModules();
  vi.doMock("../src/typed-v11-quota-reader", async (original) => ({
    ...(await original() as Record<string, unknown>),
    TYPED_V11_QUOTA_PAGE_SIZE: LEGACY_PAGE_SIZE,
  }));
  const loaded = await import("../src/quota-analysis-v11-reader");
  return loaded as typeof import("../src/quota-analysis-v11-reader");
}

describe("v1.1 quota source page size", () => {
  it("keeps one decoded source page comfortably inside the 128 MiB isolate", () => {
    const limits = V11_QUOTA_PAGE_SIZE_BUDGET;
    expect(TYPED_V11_QUOTA_PAGE_SIZE).toBe(16_384);
    expect(Number.isInteger(Math.log2(TYPED_V11_QUOTA_PAGE_SIZE))).toBe(true);
    expect(V11_QUOTA_ACQUISITION_PAGE_SIZE).toBe(TYPED_V11_QUOTA_PAGE_SIZE);
    // The transient peak of `readPage`: the raw D1 result rows and the decoded
    // rows are both live across `rows.map`, on top of the largest in-memory
    // acquisition checkpoint this identity's `maxQuotaRows` can hold.
    const page = TYPED_V11_QUOTA_PAGE_SIZE * limits.pageRowBytes;
    const readPeak = page + limits.checkpointBytes + limits.runtimeBaselineBytes;
    // The save of that same checkpoint frames it while the page is already
    // released, and costs more than the page read does. The page size is
    // therefore not the binding memory term at 16,384.
    const savePeak = limits.checkpointFrameBytes + limits.checkpointBytes + limits.runtimeBaselineBytes;
    expect(readPeak).toBeLessThan(savePeak);
    expect(readPeak / limits.isolateBytes).toBeLessThan(0.6);
    // The next power of two would become the binding term and leave no room
    // for an unusually wide row.
    expect((2 * page + limits.checkpointBytes + limits.runtimeBaselineBytes) / limits.isolateBytes)
      .toBeGreaterThan(0.85);
  });

  it("re-tunes the v1.1 claim onto source pages while every save stays affordable", () => {
    const costs = STORAGE_GRAPH_V11_GROUP_QUERY_COSTS;
    const pages = STORAGE_GRAPH_V11_CHECKPOINT_PAGES_PER_CLAIM;
    // A whole group is all-or-nothing, so it still covers exactly the source
    // rows, and therefore the worst-case wall clock, of the 32 pages of 4,096
    // it replaces: no stage that finishes its group today can start being cut.
    expect(pages * TYPED_V11_QUOTA_PAGE_SIZE).toBe(32 * LEGACY_PAGE_SIZE);
    expect(pages).toBeLessThanOrEqual(1_024);
    // Starting another group leaves the meter the group, the persist
    // pre-checks, the save loop's admission bound and one whole save call.
    expect(STORAGE_GRAPH_V11_CONTINUE_QUERIES).toBe(65);
    const afterGroup = STORAGE_GRAPH_V11_CONTINUE_QUERIES - pages - costs.fences - costs.persistPreChecks;
    expect(afterGroup).toBeGreaterThanOrEqual(costs.saveLoopGuard);
    expect(afterGroup).toBeGreaterThanOrEqual(costs.firstSave);
    // The same 900-statement meter now buys more source rows per claim,
    // because the fixed per-group promotion is amortized over 4x the rows.
    const claim = 900 - 40;
    const now = pages + costs.fences + costs.persistPreChecks + costs.firstSave;
    const before = 32 + costs.fences + costs.persistPreChecks + costs.firstSave;
    expect(Math.floor(claim / now) * pages * TYPED_V11_QUOTA_PAGE_SIZE)
      .toBeGreaterThan(Math.floor(claim / before) * 32 * LEGACY_PAGE_SIZE);
  });

  it("resumes a checkpoint staged at 4,096 rows and reaches the single-pass result", async () => {
    // Enough rows that both page sizes need several pages per sub-phase, and
    // that no 4,096-row boundary coincides with a 16,384-row one.
    const rows = jitteryRows(LEGACY_PAGE_SIZE * 4 + 421);
    const legacy = await legacyReader();
    try {
      // The private acquisition contract is unchanged: only the physical page
      // moved, so a staged checkpoint is still the same protocol version.
      expect(legacy.V11_QUOTA_ACQUISITION_VERSION).toBe(V11_QUOTA_ACQUISITION_VERSION);
      expect(legacy.V11_QUOTA_ACQUISITION_PAGE_SIZE).toBe(LEGACY_PAGE_SIZE);
      const reference = await runToCompletion(fixtureReader(rows, TYPED_V11_QUOTA_PAGE_SIZE), IDENTITY);
      expect(reference.status).toBe("complete");
      if (reference.status !== "complete") throw new Error("expected complete");
      expect(reference.quotaRows.length).toBeGreaterThan(8);
      const legacyFixture = legacy.createV11QuotaAcquisitionCheckpoint(IDENTITY);
      expect(JSON.stringify(legacyFixture)).toBe(JSON.stringify(createV11QuotaAcquisitionCheckpoint(IDENTITY)));
      const legacyPageReader = fixtureReader(rows, LEGACY_PAGE_SIZE);
      let staged: V11QuotaAcquisitionCheckpoint = legacyFixture;
      const seen = new Set<string>();
      let resumed = 0, unaligned = 0;
      // Every 4,096-row page the legacy reader could stop on, including the
      // ones that land inside a sub-phase the current page size would have
      // crossed whole.
      for (let page = 1; page <= 24; page += 1) {
        const step = await legacy.advanceV11QuotaAcquisition(legacyPageReader, IDENTITY, budget(), staged);
        if (step.status !== "deferred") break;
        staged = step.checkpoint;
        seen.add(staged.phase);
        // The cursors that only a 4,096-row page can produce: inside a
        // sub-phase, and not where a 16,384-row page would ever have stopped.
        if (staged.cursor.sourceRowId > 0
          && staged.cursor.sourceRowId % TYPED_V11_QUOTA_PAGE_SIZE !== 0) unaligned += 1;
        // Serialize under the legacy reader, decode and finish under the
        // current one: exactly the transition an in-flight stage makes.
        const carried = roundTrip(IDENTITY, staged);
        expect(carried.version).toBe(V11_QUOTA_ACQUISITION_VERSION);
        const finished = await runToCompletion(
          fixtureReader(rows, TYPED_V11_QUOTA_PAGE_SIZE), IDENTITY, carried);
        expect(finished.status).toBe("complete");
        if (finished.status !== "complete") throw new Error("expected complete");
        expect(JSON.stringify(finished.quotaRows)).toBe(JSON.stringify(reference.quotaRows));
        expect(JSON.stringify(finished.planAnchors)).toBe(JSON.stringify(reference.planAnchors));
        expect(JSON.stringify(finished.identity)).toBe(JSON.stringify(reference.identity));
        resumed += 1;
      }
      expect(resumed).toBeGreaterThanOrEqual(12);
      // Every sub-phase was resumed from a cursor no 16,384-row page produces.
      expect(unaligned).toBeGreaterThanOrEqual(4 * (Math.ceil(rows.length / LEGACY_PAGE_SIZE) - 2));
      expect([...seen].sort()).toEqual(["clusters", "endpoints", "fitability", "plan"]);
    } finally {
      vi.doUnmock("../src/typed-v11-quota-reader");
      vi.resetModules();
    }
  }, 120_000);

  it("settles the same pool hulls whatever page the jittery resets arrive in", async () => {
    // The hull of one pool spans much more than the cluster tolerance, so a
    // page boundary inside it would be visible in the settled pools if the
    // clustering depended on the order the pages delivered the instants.
    const rows = jitteryRows(LEGACY_PAGE_SIZE * 2 + 97);
    const spans = (step: V11QuotaAcquisitionStep) => {
      if (step.status !== "complete") throw new Error("expected complete");
      return [...new Set(step.quotaRows.map((row) => row.resets_at))].sort();
    };
    const wide = spans(await runToCompletion(fixtureReader(rows, TYPED_V11_QUOTA_PAGE_SIZE), IDENTITY));
    const legacy = await legacyReader();
    try {
      const narrow = spans(await (async () => {
        let checkpoint: V11QuotaAcquisitionCheckpoint | undefined;
        for (let attempt = 0; attempt < 400; attempt += 1) {
          const step = await legacy.advanceV11QuotaAcquisition(
            fixtureReader(rows, LEGACY_PAGE_SIZE), IDENTITY, budget(), checkpoint);
          if (step.status !== "deferred") return step;
          checkpoint = roundTrip(IDENTITY, step.checkpoint);
        }
        throw new Error("legacy v1.1 acquisition did not finish");
      })());
      expect(wide).toEqual(narrow);
      expect(wide).toHaveLength(2);
      expect(Date.parse(wide[1]!) - Date.parse(wide[0]!)).toBeGreaterThan(QUOTA_RESET_CLUSTER_TOLERANCE_MS);
    } finally {
      vi.doUnmock("../src/typed-v11-quota-reader");
      vi.resetModules();
    }
  }, 120_000);
});
