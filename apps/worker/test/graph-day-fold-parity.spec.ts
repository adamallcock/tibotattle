import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical-json";
import {
  advanceV11QuotaAcquisition,
  foldV11QuotaAcquisition,
  v11PreparedDayRow,
  V11_QUOTA_ACQUISITION_PAGE_SIZE,
  V11_PLAN_ANCHOR_LIMIT,
} from "../src/quota-analysis-v11-reader";
import type {
  V11CompletedQuotaAcquisition,
  V11QuotaAcquisitionIdentity,
  V11QuotaAcquisitionStep,
  V11QuotaPageReader,
} from "../src/quota-analysis-v11-reader";
import { QUOTA_CALIBRATION_POLICY } from "@app-usagemonitor/quota-analysis";
import { QUOTA_RESET_CLUSTER_LIMIT } from "../src/quota-endpoint-collapse";
import { reduceGraphDayProjection } from "../src/graph-day-projection";
import {
  GRAPH_DAY_PROJECTION_VERSION,
  graphDayFitFragmentOrder,
  graphDayPlanSignature,
  graphDayRunKey,
  validGraphDayProjection,
  type GraphDayFitFragment,
  type GraphDayProjection,
  type GraphDayRunEndpoint,
} from "../src/graph-day-projection-values";
import type { V11QuotaPageRow, V11QuotaSourceRow } from "../src/typed-v11-quota-reader";

/**
 * The parity oracle. This is the gate for the prepared-day fold, not a smoke
 * test: `canonicalJson` of the acquisition the paged path settles on must equal
 * the folded one byte for byte, over corpora built to break it.
 *
 * Every fixture is generated from an explicit seed and the seed is printed with
 * any failure, so a divergence is replayable from the message alone.
 */

const DAY_MS = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
const BASE = Date.parse("2026-05-01T00:00:00.000Z");
const WINDOW_MINUTES = 10_080;
const ACCOUNT = `account-track:v2:${"a".repeat(64)}`;
const IDENTITY: V11QuotaAcquisitionIdentity = {
  participantId: "synthetic-graph-fold-participant", inputFingerprint: "b".repeat(64),
  sourceMethodVersion: "synthetic-graph-fold", observedAtCutoff: "2026-05-01T00:00:00.000Z",
  resetsAtCutoff: "2026-05-01T00:00:00.000Z", windowMinutes: WINDOW_MINUTES, maxQuotaRows: 60_000,
};

/** mulberry32. Deterministic, and the seed is the whole reproduction. */
function seeded(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const occurrence = (id: number) => `quota-occurrence:v1:${String(id).padStart(48, "0")}`;
const planEra = (index: number) => `plan-era:v1:${String(index).padStart(64, "0")}`;

interface RowPatch {
  planType?: string | null;
  planVariant?: string | null;
  planBasis?: V11QuotaSourceRow["planBasis"];
  planEraId?: string | null;
  slot?: string | null;
  usedPercent?: number | null;
  resetsAtMs?: number | null;
  windowDurationMinutes?: number | null;
  active?: false;
}

function pageRow(sourceRowId: number, observedAtMs: number, patch: RowPatch = {}): V11QuotaPageRow {
  if (patch.active === false) {
    return { physicalId: sourceRowId, sourceRowId, observedAtMs, active: null };
  }
  const resetsAtMs = patch.resetsAtMs === undefined ? observedAtMs + 7 * DAY_MS : patch.resetsAtMs;
  const active: V11QuotaSourceRow = {
    id: sourceRowId, observedAtMs, observedAt: new Date(observedAtMs).toISOString(),
    observedDay: new Date(observedAtMs).toISOString().slice(0, 10), deviceId: "device",
    provider: "openai_codex", limitId: "codex",
    planType: patch.planType === undefined ? "pro" : patch.planType,
    planVariant: patch.planVariant === undefined ? "unknown" : patch.planVariant,
    accountBasis: "same_source", accountTrackId: ACCOUNT,
    planBasis: patch.planBasis === undefined ? "same_source_occurrence" : patch.planBasis,
    planEraId: patch.planEraId === undefined ? null : patch.planEraId,
    occurrenceId: occurrence(sourceRowId),
    slot: patch.slot === undefined ? "seven_day" : patch.slot,
    usedPercent: patch.usedPercent === undefined ? 10 : patch.usedPercent,
    windowDurationMinutes: patch.windowDurationMinutes === undefined
      ? WINDOW_MINUTES : patch.windowDurationMinutes,
    resetsAtMs, resetsAt: resetsAtMs === null ? null : new Date(resetsAtMs).toISOString(),
  };
  return { physicalId: sourceRowId, sourceRowId, observedAtMs, active };
}

const rowOrder = (left: V11QuotaPageRow, right: V11QuotaPageRow) =>
  left.observedAtMs - right.observedAtMs || left.sourceRowId - right.sourceRowId;

function fixtureReader(rows: readonly V11QuotaPageRow[]): V11QuotaPageReader {
  const ordered = [...rows].sort(rowOrder);
  return {
    pageSize: V11_QUOTA_ACQUISITION_PAGE_SIZE,
    async readPage(cursor, limit) {
      let low = 0, high = ordered.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        const row = ordered[middle]!;
        if (row.observedAtMs < cursor.observedAtMs
          || row.observedAtMs === cursor.observedAtMs && row.sourceRowId <= cursor.sourceRowId) low = middle + 1;
        else high = middle;
      }
      return ordered.slice(low, low + limit);
    },
  };
}

async function pagedAcquisition(rows: readonly V11QuotaPageRow[],
  identity: V11QuotaAcquisitionIdentity): Promise<V11QuotaAcquisitionStep> {
  return advanceV11QuotaAcquisition(fixtureReader(rows), identity,
    { remainingQueries: 100_000, deadlineMs: 1, now: () => 0 });
}

type Prepared = ReturnType<typeof v11PreparedDayRow>;

/** The source rows split into UTC days, reduced to what a prepared day stores. */
function preparedDays(rows: readonly V11QuotaPageRow[]): Array<[string, Prepared[]]> {
  const byDay = new Map<string, Prepared[]>();
  for (const row of [...rows].sort(rowOrder)) {
    const day = new Date(row.observedAtMs).toISOString().slice(0, 10);
    const list = byDay.get(day);
    const prepared = v11PreparedDayRow(row, WINDOW_MINUTES);
    if (list === undefined) byDay.set(day, [prepared]); else list.push(prepared);
  }
  return [...byDay.entries()].sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
}

/** The days the production projection reducer builds. */
function projectDays(rows: readonly V11QuotaPageRow[]): GraphDayProjection[] {
  return preparedDays(rows).map(([day, inputs]) => reduceGraphDayProjection(day, inputs));
}

/**
 * A REFERENCE day projection, used to prove the fold rather than the reducer.
 *
 * It states the retention contract the fold actually needs, which is stronger
 * than "collapse runs per raw reset":
 *
 * - Plan anchors: every anchor of the day. A superset is always safe, because
 *   replaying a run's own boundaries through the plan collapse is idempotent.
 * - Run endpoints: a row may be dropped only when it is interior to a constant
 *   run under EVERY pooling the window could settle on. The fold keys by the
 *   settled pool, the day knows only the raw instants, and neither the raw
 *   grouping nor the merged grouping refines the other — so the sound rule is
 *   to keep a row unless every row of its `(signature, slot)` stream between
 *   its own raw-instant neighbours carries its value. Any pooling's neighbour
 *   of that row lies inside that window, so the row is then interior under all
 *   of them and is exactly what run collapse discards.
 */
function referenceDay(day: string, inputs: readonly Prepared[]): GraphDayProjection {
  const anchors = inputs.flatMap((input) => (input.anchor === null ? [] : [input.anchor]));
  const signatureOf = (input: Prepared): string | null => input.anchor !== null
    ? graphDayPlanSignature(input.anchor)
    : input.row === null ? null : graphDayPlanSignature({
      contextKey: `${input.row.provider}|${input.row.limit_id}`,
      accountScopeId: input.row.account_scope_id, planType: input.row.plan_type,
      planVariant: input.row.plan_variant, continuityId: input.row.continuity_id,
      planBasis: input.row.plan_basis });
  // Runs first: a maximal consecutive block of one signature, closed at every
  // signature change AND at every equal-time tie, which are exactly the
  // instants the attribution index can put an era boundary at.
  const assigned: Array<{ input: Prepared; signature: string | null; runFirstObservedAtMs: number }> = [];
  let openSignature: string | null = null, openRunFirstMs = 0;
  for (let index = 0; index < inputs.length;) {
    const instantMs = inputs[index]!.observedAtMs;
    let end = index;
    while (end < inputs.length && inputs[end]!.observedAtMs === instantMs) end += 1;
    const group = inputs.slice(index, end);
    const tie = new Set(group.map(signatureOf).filter((value) => value !== null)).size > 1;
    if (tie) openSignature = null;
    for (const input of group) {
      const signature = signatureOf(input);
      if (signature !== null && !tie && openSignature !== signature) {
        openSignature = signature;
        openRunFirstMs = instantMs;
      }
      assigned.push({ input, signature,
        runFirstObservedAtMs: signature === null || tie ? instantMs : openRunFirstMs });
    }
    index = end;
  }

  // An era's lower bound is always a RETAINED plan anchor, and the plan
  // collapse retains each of its runs' first and last. A day-local unit that
  // spans no retained anchor is therefore era-uniform, so the run's own last
  // instant becomes a unit of its own. Splitting more finely than necessary is
  // safe: every component is merged by era, and a larger retained endpoint set
  // is absorbed by the unchanged collapse kernel.
  const runTail = new Map<string, number>();
  for (const item of assigned) {
    if (item.signature === null) continue;
    const key = graphDayRunKey(item.signature, item.runFirstObservedAtMs);
    runTail.set(key, Math.max(runTail.get(key) ?? -Infinity, item.input.observedAtMs));
  }
  for (const item of assigned) {
    if (item.signature === null) continue;
    const tail = runTail.get(graphDayRunKey(item.signature, item.runFirstObservedAtMs))!;
    if (item.input.observedAtMs === tail) item.runFirstObservedAtMs = tail;
  }

  const distinct = new Map<string, { minimum: number; maximum: number; values: Set<number> }>();
  interface Candidate extends GraphDayRunEndpoint { stream: string }
  const candidates: Candidate[] = [];
  for (const { input, signature, runFirstObservedAtMs } of assigned) {
    if (input.row === null || signature === null) continue;
    const row = input.row;
    const runKey = graphDayRunKey(signature, runFirstObservedAtMs);
    const resetsAtMs = Date.parse(row.resets_at);
    const key = JSON.stringify([runKey, resetsAtMs]);
    const stat = distinct.get(key);
    if (stat === undefined) {
      distinct.set(key, { minimum: row.used_percent, maximum: row.used_percent,
        values: new Set([row.used_percent]) });
    } else {
      stat.minimum = Math.min(stat.minimum, row.used_percent);
      stat.maximum = Math.max(stat.maximum, row.used_percent);
      stat.values.add(row.used_percent);
    }
    candidates.push({ signature, runFirstObservedAtMs, slot: row.slot, resetsAtMs,
      sourceRowId: input.sourceRowId, observedAtMs: input.observedAtMs,
      usedPercent: row.used_percent, row, stream: JSON.stringify([runKey, row.slot]) });
  }
  const endpoints = candidates.filter((candidate) => {
    const stream = candidates.filter((value) => value.stream === candidate.stream);
    const position = stream.indexOf(candidate);
    let before = -1, after = -1;
    for (let step = position - 1; step >= 0; step -= 1) {
      if (stream[step]!.resetsAtMs === candidate.resetsAtMs) { before = step; break; }
    }
    for (let step = position + 1; step < stream.length; step += 1) {
      if (stream[step]!.resetsAtMs === candidate.resetsAtMs) { after = step; break; }
    }
    if (before < 0 || after < 0) return true;
    return stream.slice(before, after + 1).some((value) => value.usedPercent !== candidate.usedPercent);
  }).map(({ stream, ...endpoint }) => { void stream; return endpoint; });
  const fragments: GraphDayFitFragment[] = [...distinct].map(([key, stat]) => {
    const [runKey, resetsAtMs] = JSON.parse(key) as [string, number];
    const [signature, runFirstObservedAtMs] = JSON.parse(runKey) as [string, number];
    return { signature, runFirstObservedAtMs, resetsAtMs, minimum: stat.minimum, maximum: stat.maximum,
      values: [...stat.values].sort((left, right) => left - right)
        .slice(0, QUOTA_CALIBRATION_POLICY.minimumBoundaries) };
  }).sort((left, right) => (graphDayFitFragmentOrder(left) < graphDayFitFragmentOrder(right) ? -1 : 1));
  // Pools are no longer a stored component: the fold re-derives them from the
  // fit fragments' surviving members, which is what lets it apply the reset
  // horizon at all, so storing them would be a second encoding of one fact.
  return { version: GRAPH_DAY_PROJECTION_VERSION, day, planAnchors: { anchors },
    fitFragments: { fragments },
    // The usage components are not part of the quota fold's oracle; the model
    // half of usage is folded separately and proven on its own fixtures.
    runEndpoints: { endpoints },
    usage: { cells: [], openers: [], sessions: [], rowsRead: 0 } };
}

function referenceDays(rows: readonly V11QuotaPageRow[]): GraphDayProjection[] {
  return preparedDays(rows).map(([day, inputs]) => referenceDay(day, inputs));
}

/** The window's own day labels. A fixture always supplies every day it built,
 * so this is the complete set; the dedicated coverage test removes one. */
const expectedDays = (days: readonly GraphDayProjection[]) => days.map((day) => day.day);

const completed = (step: V11QuotaAcquisitionStep): V11CompletedQuotaAcquisition | null =>
  step.status === "complete"
    ? { identity: step.identity, planAnchors: step.planAnchors, quotaRows: step.quotaRows } : null;

/** The comparison itself: the acquisition either completes on both paths with
 * byte-identical canonical JSON, or refuses on both with the same reason. */
async function parity(rows: readonly V11QuotaPageRow[], label: string,
  identity: V11QuotaAcquisitionIdentity = IDENTITY,
  build: (rows: readonly V11QuotaPageRow[]) => GraphDayProjection[] = projectDays,
): Promise<{ rows: number; days: number }> {
  const paged = await pagedAcquisition(rows, identity);
  const days = build(rows);
  for (const day of days) expect(validGraphDayProjection(day), `${label}: day ${day.day} invalid`).toBe(true);
  let folded: V11QuotaAcquisitionStep;
  try {
    folded = foldV11QuotaAcquisition(identity, days, expectedDays(days));
  } catch (error) {
    throw new Error(`${label}: ${(error as Error).message}`, { cause: error });
  }
  expect(folded.status, label).toBe(paged.status);
  if (paged.status === "not_testable" && folded.status === "not_testable") {
    expect(folded.reason, label).toBe(paged.reason);
    return { rows: 0, days: days.length };
  }
  const left = completed(paged), right = completed(folded);
  expect(left, label).not.toBeNull();
  expect(right, label).not.toBeNull();
  expect(canonicalJson(right), label).toBe(canonicalJson(left));
  return { rows: left!.quotaRows.length, days: days.length };
}

type Corpus = "dense" | "jittery" | "sparse" | "multi-era" | "equal-time";

/** Five corpus shapes, each built to break a different composition claim:
 * dense flat runs (run collapse and spacing), reset jitter (pool hulls and the
 * representative), sparse days (nothing to collapse), plan changes (era
 * assignment) and equal-time conflicts (era boundaries and tie flushing). */
function corpus(kind: Corpus, seed: number): V11QuotaPageRow[] {
  const random = seeded(seed);
  const rows: V11QuotaPageRow[] = [];
  const dayCount = 2 + Math.floor(random() * 4);
  const plans = ["pro", "plus", "prolite"];
  let id = 0;
  let planIndex = 0;
  let value = Math.floor(random() * 90);
  for (let day = 0; day < dayCount; day += 1) {
    const dayStart = BASE + day * DAY_MS;
    if (kind === "multi-era" && random() < 0.6) planIndex = (planIndex + 1) % plans.length;
    const perDay = kind === "sparse" ? 2 + Math.floor(random() * 4) : 18 + Math.floor(random() * 30);
    const step = Math.floor(DAY_MS / (perDay + 2));
    // Two pools a week apart, so a pool's hull is settled over the window and
    // the representative is never day-local.
    const pools = [dayStart + 9 * DAY_MS, dayStart + 16 * DAY_MS];
    for (let index = 0; index < perDay; index += 1) {
      const observedAtMs = dayStart + (index + 1) * step;
      // A plan change part way through a day is an era boundary mid-day.
      if (kind === "multi-era" && index === Math.floor(perDay / 2) && random() < 0.5) {
        planIndex = (planIndex + 1) % plans.length;
      }
      const pool = pools[kind === "jittery" && random() < 0.5 ? 1 : 0]!;
      // A small discrete jitter set, so one pool really is restated under a
      // handful of RAW instants that repeat. Continuous jitter would give every
      // row its own instant and never exercise pool composition at all.
      const jitter = kind === "jittery"
        ? [0, 11 * MINUTE, 23 * MINUTE, 37 * MINUTE][Math.floor(random() * 4)]! : 0;
      // Long flat runs interrupted by occasional changes: the shape a dense
      // owner actually produces, and the shape run collapse exists for.
      // A realistic displayed alphabet, not a continuum: a quota restates a
      // small set of percentages, so a value RETURNS after changing, which is
      // the shape that separates raw-instant collapse from pooled collapse.
      if (random() < (kind === "dense" ? 0.2 : 0.5)) value = 5 * (1 + Math.floor(random() * 12));
      id += 1;
      rows.push(pageRow(id, observedAtMs, { planType: plans[planIndex]!, resetsAtMs: pool + jitter,
        usedPercent: value, slot: random() < 0.25 ? "five_hour" : "seven_day" }));
      if (kind === "equal-time" && random() < 0.12) {
        // A second observation at the same instant carrying a different plan:
        // an equal-time contradiction, which is an era boundary.
        id += 1;
        rows.push(pageRow(id, observedAtMs, { planType: plans[(planIndex + 1) % plans.length]!,
          resetsAtMs: pool + jitter, usedPercent: value, slot: "seven_day" }));
      }
      if (kind === "sparse" && random() < 0.2) {
        // A retired physical row: the page advances over it and neither path
        // may treat it as evidence.
        id += 1;
        rows.push(pageRow(id, observedAtMs + 1, { active: false }));
      }
    }
  }
  return rows;
}

/** The reset horizon production actually has: `resetsAtCutoff` is the window
 * start plus seven days, so it falls INSIDE the corpus and excludes every row
 * whose pool resets earlier. A prepared day is window-agnostic and carries
 * those rows, so the fold has to apply the horizon itself — to the pools and
 * the fitability evidence, not only to the endpoints. */
const HORIZON: V11QuotaAcquisitionIdentity = { ...IDENTITY,
  resetsAtCutoff: new Date(BASE + 12 * DAY_MS).toISOString() };

describe("prepared graph-day fold parity oracle", () => {
  it("matches the paged acquisition byte for byte over 250 randomized fixtures", async () => {
    // The gate: the days are the ones `reduceGraphDayProjection` actually
    // builds, not a shape written to suit the fold.
    const kinds: Corpus[] = ["dense", "jittery", "sparse", "multi-era", "equal-time"];
    let compared = 0, quotaRows = 0, days = 0;
    // Each corpus twice: once with no reset horizon, and once with one that
    // cuts through it, which is the shape production has.
    for (const identity of [IDENTITY, HORIZON]) {
      for (const kind of kinds) {
        for (let seed = 1; seed <= 50; seed += 1) {
          const measured = await parity(corpus(kind, seed),
            `${kind} seed ${seed} horizon ${identity.resetsAtCutoff}`, identity);
          compared += 1;
          quotaRows += measured.rows;
          days += measured.days;
        }
      }
    }
    expect(compared).toBe(500);
    // The corpora have to be doing work, or the oracle proves nothing.
    expect(quotaRows).toBeGreaterThan(1_000);
    expect(days).toBeGreaterThan(600);
  }, 900_000);

  it("matches an independently built day projection on the same corpora", async () => {
    // A second opinion on the same fixtures, from a reference projection
    // written against the artifact contract rather than derived from the
    // reducer. Agreement here is what separates "the fold is correct" from
    // "the fold and the reducer share a mistake".
    const kinds: Corpus[] = ["dense", "jittery", "sparse", "multi-era", "equal-time"];
    let compared = 0;
    for (const identity of [IDENTITY, HORIZON]) {
      for (const kind of kinds) {
        for (let seed = 1; seed <= 50; seed += 1) {
          await parity(corpus(kind, seed), `reference ${kind} seed ${seed}`, identity, referenceDays);
          compared += 1;
        }
      }
    }
    expect(compared).toBe(500);
  }, 900_000);

  it("folds an equal-time tie that is not an era contradiction", async () => {
    // Two observations at one instant differing only in plan basis. That is a
    // second day-local signature, which the tie flush must order canonically,
    // but it is NOT an era boundary: the index contradicts only on plan type,
    // variant, continuity or an explicitly conflicted basis. So the day stays
    // expressible and the fold must match byte for byte.
    const rows: V11QuotaPageRow[] = [];
    let id = 0;
    for (let hour = 0; hour < 30; hour += 1) {
      id += 1;
      rows.push(pageRow(id, BASE + hour * HOUR, { usedPercent: 10 + hour,
        resetsAtMs: BASE + 9 * DAY_MS + hour * MINUTE }));
      if (hour % 7 === 3) {
        id += 1;
        rows.push(pageRow(id, BASE + hour * HOUR, { planBasis: "provisional_marker",
          usedPercent: 10 + hour, resetsAtMs: BASE + 9 * DAY_MS + hour * MINUTE }));
      }
    }
    // The day must retain the run's last anchor from BEFORE the tie: the plan
    // sub-phase buffers each instant's ties and flushes them in `planSort`
    // order, which splits the run there, so an anchor absorbed into the open
    // run before the tie was known would be lost.
    const measured = await parity(rows, "equal-time tie without contradiction");
    expect(measured.days).toBe(2);
    expect(measured.rows).toBeGreaterThan(0);
    await parity(rows, "equal-time tie without contradiction (reference)", IDENTITY, referenceDays);
  });

  it("separates one signature's two eras inside one day", async () => {
    // `pro` runs, is contradicted at noon by an equal-time `plus`, and resumes.
    // The resumed rows reach an era whose lower bound the plan collapse places
    // at that run's last retained anchor, so a run split only at signature
    // changes and ties would still straddle "no era" and that era. Splitting
    // also at the run's last retained plan anchor closes it, and the day then
    // carries each part's pools and fitability separately.
    const rows: V11QuotaPageRow[] = [];
    let id = 0;
    for (let hour = 0; hour < 20; hour += 2) {
      id += 1;
      rows.push(pageRow(id, BASE + hour * HOUR, { usedPercent: 10 + hour,
        resetsAtMs: BASE + 9 * DAY_MS + hour * MINUTE }));
      if (hour === 10) {
        id += 1;
        rows.push(pageRow(id, BASE + hour * HOUR, { planType: "plus", usedPercent: 10 + hour,
          resetsAtMs: BASE + 9 * DAY_MS + hour * MINUTE }));
      }
    }
    expect((await pagedAcquisition(rows, IDENTITY)).status).toBe("complete");
    await parity(rows, "one signature, two eras, one day");
    await parity(rows, "one signature, two eras, one day (reference)", IDENTITY, referenceDays);
  });

  it("refuses a run whose retained endpoints do not all reach one era", async () => {
    // The boundary guard, on an artifact no builder in this tree produces: two
    // endpoints that reach different eras merged under one run key. The day's
    // hull and fit fragment for that run then cover both eras' evidence and
    // cannot be separated, so the fold must refuse rather than settle
    // something the paged path never would. `validGraphDayProjection` rejects
    // this too, but the kernel does not rely on having been handed a valid day.
    const rows: V11QuotaPageRow[] = [];
    let id = 0;
    for (let hour = 0; hour < 20; hour += 2) {
      id += 1;
      rows.push(pageRow(id, BASE + hour * HOUR, { usedPercent: 10 + hour,
        resetsAtMs: BASE + 9 * DAY_MS + hour * MINUTE }));
      if (hour === 10) {
        id += 1;
        rows.push(pageRow(id, BASE + hour * HOUR, { planType: "plus", usedPercent: 10 + hour,
          resetsAtMs: BASE + 9 * DAY_MS + hour * MINUTE }));
      }
    }
    const days = projectDays(rows);
    const day = days[0]!;
    const signature = day.runEndpoints.endpoints[0]!.signature;
    const runs = [...new Set(day.runEndpoints.endpoints
      .filter((endpoint) => endpoint.signature === signature)
      .map((endpoint) => endpoint.runFirstObservedAtMs))];
    expect(runs.length).toBeGreaterThan(1);
    // Collapse every run of that signature onto the first one's key.
    const doctored: GraphDayProjection = { ...day, runEndpoints: { endpoints:
      day.runEndpoints.endpoints.map((endpoint) => endpoint.signature === signature
        ? { ...endpoint, runFirstObservedAtMs: runs[0]! } : endpoint) } };
    expect(validGraphDayProjection(doctored)).toBe(false);
    expect(() => foldV11QuotaAcquisition(IDENTITY, [doctored, ...days.slice(1)], expectedDays([doctored, ...days.slice(1)])))
      .toThrowError("v11 quota prepared day ambiguous");
  });

  it("applies the reset horizon to fitability, not only to the endpoints", async () => {
    // The exact shape the horizon creates for a dense owner: rows whose pool
    // resets before the horizon share that pool with rows that reset after it.
    // The paged path drops them BEFORE it clusters and before it decides
    // fitability, so their displayed values must not reach the pool's stats. If
    // they do, seven distinct values become nine and a pool the calibration
    // refuses becomes one it admits — a difference in the emitted rows, not a
    // rounding.
    const horizon = BASE + 10 * DAY_MS;
    const identity: V11QuotaAcquisitionIdentity = { ...IDENTITY,
      resetsAtCutoff: new Date(horizon).toISOString() };
    const rows: V11QuotaPageRow[] = [];
    let id = 0;
    // Seven distinct values above the horizon: one short of the calibration's
    // boundary count, so the pool is refused.
    for (let step = 0; step < 7; step += 1) {
      id += 1;
      rows.push(pageRow(id, BASE + id * 20 * MINUTE, { usedPercent: 10 + step,
        resetsAtMs: horizon + HOUR }));
    }
    // Two more in the SAME pool but below the horizon. Their instants are
    // within the tolerance of the pool above it, so a fold that trimmed the
    // hull rather than re-deriving it from the surviving members would keep
    // them, and their values would carry the pool over the bound.
    for (const used of [50, 60]) {
      id += 1;
      rows.push(pageRow(id, BASE + id * 20 * MINUTE, { usedPercent: used, resetsAtMs: horizon - HOUR }));
    }
    const paged = completed(await pagedAcquisition(rows, identity))!;
    expect(paged.quotaRows).toHaveLength(0);
    await parity(rows, "reset horizon inside one pool", identity);
    await parity(rows, "reset horizon inside one pool (reference)", identity, referenceDays);
  });

  it("refuses a window with a day missing rather than folding a smaller one", async () => {
    // The failure this precondition exists for: a day the builder has not
    // reached, or refused, or that a mid-pass manifest change invalidated. The
    // fold has no way to notice from the days it WAS given — they are ordered,
    // inside the window and individually valid — so a smaller acquisition would
    // publish under an unchanged result identity.
    const rows = corpus("dense", 11);
    const days = projectDays(rows);
    expect(days.length).toBeGreaterThan(2);
    const expected = expectedDays(days);
    for (const dropped of [0, 1, days.length - 1]) {
      const partial = days.filter((_, index) => index !== dropped);
      expect(() => foldV11QuotaAcquisition(IDENTITY, partial, expected))
        .toThrowError("v11 quota prepared day set incomplete");
    }
    // An extra day the window does not contain is the same failure.
    expect(() => foldV11QuotaAcquisition(IDENTITY, days, [...expected, "2030-01-01"]))
      .toThrowError("v11 quota prepared day set incomplete");
    // The complete set still folds, so the refusal is the gap and not the test.
    expect(foldV11QuotaAcquisition(IDENTITY, days, expected).status).toBe("complete");
  });

  it("refuses a window whose observation cutoff splits a day", async () => {
    // A prepared day is the unit, so the observation start has to select whole
    // days. A cutoff inside one would need per-row evidence the day's
    // aggregates no longer carry, and is refused rather than approximated.
    const rows = corpus("dense", 3);
    const identity: V11QuotaAcquisitionIdentity = { ...IDENTITY,
      observedAtCutoff: new Date(BASE + 6 * HOUR).toISOString() };
    expect(() => foldV11QuotaAcquisition(identity, projectDays(rows), expectedDays(projectDays(rows))))
      .toThrowError("v11 quota acquisition checkpoint invalid");
  });

  it("fails when the fold is perturbed by one row", async () => {
    // The mutation check: the oracle must be able to see a single wrong row.
    const rows = corpus("dense", 7);
    const paged = completed(await pagedAcquisition(rows, IDENTITY))!;
    const days = projectDays(rows);
    const target = days.find((day) => day.runEndpoints.endpoints.length > 2)!;
    const endpoints = [...target.runEndpoints.endpoints];
    const index = 1;
    const original = endpoints[index]!;
    endpoints[index] = { ...original, usedPercent: (original.usedPercent + 1) % 101,
      row: { ...original.row, used_percent: (original.usedPercent + 1) % 101 } };
    const perturbed = days.map((day) => day === target
      ? { ...day, runEndpoints: { endpoints } } : day);
    const folded = completed(foldV11QuotaAcquisition(IDENTITY, perturbed, expectedDays(perturbed)));
    expect(canonicalJson(folded)).not.toBe(canonicalJson(paged));
    // And the unperturbed fold of the same days still matches, so the failure
    // above is the perturbation and not the fixture.
    expect(canonicalJson(completed(foldV11QuotaAcquisition(IDENTITY, days, expectedDays(days))))).toBe(canonicalJson(paged));
  });

  it("keeps an equal-value run that spans midnight as one run", async () => {
    // One constant value across a day boundary. Each day retains its own first
    // and last row; the fold must rejoin them into one run and emit exactly
    // the rows the paged path does.
    const rows: V11QuotaPageRow[] = [];
    let id = 0;
    for (let offset = 0; offset < 24; offset += 1) {
      id += 1;
      rows.push(pageRow(id, BASE + 12 * HOUR + offset * HOUR, { usedPercent: 40,
        resetsAtMs: BASE + 9 * DAY_MS }));
    }
    id += 1;
    rows.push(pageRow(id, BASE + 12 * HOUR + 24 * HOUR + MINUTE, { usedPercent: 75,
      resetsAtMs: BASE + 9 * DAY_MS }));
    const measured = await parity(rows, "equal-value run across midnight");
    expect(measured.days).toBe(2);
  });

  it("keeps an era boundary inside one day exact", async () => {
    // The plan changes at noon, so the day carries two eras and the day-local
    // signatures must each resolve to their own.
    const rows: V11QuotaPageRow[] = [];
    let id = 0;
    for (let hour = 0; hour < 24; hour += 1) {
      id += 1;
      rows.push(pageRow(id, BASE + hour * HOUR, { planType: hour < 12 ? "pro" : "plus",
        usedPercent: 10 + hour, resetsAtMs: BASE + 9 * DAY_MS + hour * MINUTE }));
    }
    const measured = await parity(rows, "era boundary mid-day");
    expect(measured.rows).toBeGreaterThan(0);
  });

  it("refuses identically when the downsampled-row bound is exceeded", async () => {
    const rows: V11QuotaPageRow[] = [];
    for (let index = 0; index < 400; index += 1) {
      rows.push(pageRow(index + 1, BASE + index * 20 * MINUTE, { usedPercent: index % 97,
        resetsAtMs: BASE + 9 * DAY_MS }));
    }
    await parity(rows, "maxQuotaRows refusal", { ...IDENTITY, maxQuotaRows: 12 });
  });

  it("refuses identically when the plan-anchor bound is exceeded", async () => {
    // Alternating plan signatures at distinct instants, so every row is a run
    // boundary and the anchor bound is reached on both paths. These carry a
    // window duration the acquisition never admits, so they are plan evidence
    // only and cannot reach the day's own pool or endpoint bounds first.
    const rows: V11QuotaPageRow[] = [];
    const total = V11_PLAN_ANCHOR_LIMIT + 8;
    const step = Math.floor(3 * DAY_MS / total);
    for (let index = 0; index < total; index += 1) {
      rows.push(pageRow(index + 1, BASE + index * step,
        { planType: index % 2 === 0 ? "pro" : "plus", planEraId: planEra(index % 2),
          usedPercent: index % 89, resetsAtMs: BASE + 9 * DAY_MS, windowDurationMinutes: 300 }));
    }
    const paged = await pagedAcquisition(rows, IDENTITY);
    expect(paged.status).toBe("not_testable");
    const folded = foldV11QuotaAcquisition(IDENTITY, projectDays(rows), expectedDays(projectDays(rows)));
    expect(folded.status).toBe("not_testable");
    expect(folded.status === "not_testable" && folded.reason)
      .toBe(paged.status === "not_testable" && paged.reason);
  }, 600_000);

  it("matches at the pool bound and refuses identically one pool past it", async () => {
    // Pools four hours apart never link at the three-hour tolerance, so the
    // pool count is the reset count. At the bound both paths complete; one
    // pool further and both refuse on the settled count.
    const build = (pools: number): V11QuotaPageRow[] => {
      const rows: V11QuotaPageRow[] = [];
      for (let index = 0; index < pools; index += 1) {
        rows.push(pageRow(index + 1, BASE + index * MINUTE,
          { usedPercent: index % 101, resetsAtMs: BASE + 9 * DAY_MS + index * 4 * HOUR }));
      }
      return rows;
    };
    await parity(build(QUOTA_RESET_CLUSTER_LIMIT), "cluster bound exactly");
    const over = build(QUOTA_RESET_CLUSTER_LIMIT + 1);
    const paged = await pagedAcquisition(over, IDENTITY);
    expect(paged.status === "not_testable" && paged.reason).toBe("downsampled_quota_limit_exceeded");
    const folded = foldV11QuotaAcquisition(IDENTITY, projectDays(over), expectedDays(projectDays(over)));
    expect(folded.status === "not_testable" && folded.reason).toBe("downsampled_quota_limit_exceeded");
  }, 600_000);

  it("keeps two restated instants of one pool interleaved in time", async () => {
    // One pool restated under two raw instants, with the value returning to an
    // earlier one across them. The prepared day collapses runs per RAW instant
    // while the acquisition collapses per settled POOL, so a row that is an
    // interior row of the raw run but a run boundary of the pooled run is the
    // exact shape that separates the two.
    const pool = BASE + 9 * DAY_MS;
    const first = pool, second = pool + 30 * MINUTE;
    const rows: V11QuotaPageRow[] = [];
    let id = 0;
    const emit = (usedPercent: number, resetsAtMs: number) => {
      id += 1;
      rows.push(pageRow(id, BASE + id * 20 * MINUTE, { usedPercent, resetsAtMs }));
    };
    // Enough distinct values and span for the calibration to admit the pool.
    for (let step = 1; step <= 8; step += 1) emit(step * 10, first);
    emit(10, first);
    emit(20, second);
    emit(10, first);
    emit(10, first);
    emit(30, second);
    await parity(rows, "two restated instants of one pool");
    await parity(rows, "two restated instants of one pool (reference)", IDENTITY, referenceDays);
  });

  it("records the one order-sensitive cluster case the fold cannot reproduce", async () => {
    // The known inexactness, pinned rather than hidden. Pools are inserted in
    // observation order, so a bridging instant that arrives late makes the
    // direct path's INTERMEDIATE pool count exceed the bound while the day's
    // settled hull set does not. The merge refuses on the count settled at
    // each day boundary, which is one-sided — it never refuses where the
    // direct path completed — so here the paged path refuses and the fold
    // completes. A corpus at this shape must be recognised, not folded.
    const rows: V11QuotaPageRow[] = [];
    let id = 0;
    const emit = (resetOffset: number) => {
      id += 1;
      rows.push(pageRow(id, BASE + id * MINUTE, { usedPercent: id % 101,
        resetsAtMs: BASE + 9 * DAY_MS + resetOffset }));
    };
    // The bound in separate pools, then one more isolated pool — which the
    // direct path refuses on the spot — and then a bridging instant that
    // settles two of the earlier pools back into one, so the count the day's
    // hull set carries is exactly the bound.
    for (let index = 0; index < QUOTA_RESET_CLUSTER_LIMIT; index += 1) emit(index * 5 * HOUR);
    emit((QUOTA_RESET_CLUSTER_LIMIT + 1) * 5 * HOUR);
    emit(2 * HOUR + 30 * MINUTE);
    const paged = await pagedAcquisition(rows, IDENTITY);
    expect(paged.status === "not_testable" && paged.reason).toBe("downsampled_quota_limit_exceeded");
    const folded = foldV11QuotaAcquisition(IDENTITY, projectDays(rows), expectedDays(projectDays(rows)));
    expect(folded.status).toBe("complete");
  }, 600_000);
});
