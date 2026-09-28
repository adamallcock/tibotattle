import { env, reset, type D1Migration } from "cloudflare:test";
import { expect, it } from "vitest";
import { canonicalJson } from "../src/canonical-json";
import { sha256Hex } from "../src/crypto";
import { createEffectiveHistoryDayDependencyReader, effectiveHistoryDependency } from "../src/storage-effective-history";
import { readStorageCommunityOwnerPage } from "../src/storage-community-authority";
import { initializeSharedAnalyticsCorpusDatabases, seedSharedAnalyticsCorpus } from "./fixtures/shared-analytics-corpus";

const bindings = env as Env & { STORAGE_ANALYTICS_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[]; TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[]; TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
  TEST_ANALYTICS_MIGRATIONS: D1Migration[] };
const namespace = "synthetic-batched-dependency";
const marker = "/* batched occurrence links */";

async function setup() {
  await reset();
  const source = bindings.USAGE_MONITOR_DB;
  await initializeSharedAnalyticsCorpusDatabases(source, bindings.STORAGE_ANALYTICS_DB, bindings, namespace);
  const corpus = await seedSharedAnalyticsCorpus({ source, target: bindings.STORAGE_ANALYTICS_DB,
    sourceId: namespace, sourceNamespace: namespace, calendarDays: 14, graphDays: 2,
    crossDayLinks: true });
  if (!corpus.crossDayLinkDay) throw new Error("synthetic cross-day link missing");
  return { source, corpus, linkedDay: corpus.crossDayLinkDay };
}

async function exactDigest(source: D1Database, owner: SeededOwner, day: string,
  includeSessions: boolean) {
  return sha256Hex(canonicalJson(await effectiveHistoryDependency(source, owner, namespace,
    day, day, { includeSessions })));
}
type SeededCorpus = Awaited<ReturnType<typeof seedSharedAnalyticsCorpus>>;
type SeededOwner = SeededCorpus["owner"];

function observeD1(source: D1Database, options: {
  afterAll?: (sql: string) => void;
  rows?: (sql: string, original: Record<string, unknown>[]) => Record<string, unknown>[];
} = {}) {
  const queries: string[] = [];
  const database = new Proxy(source, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
        get(inner, member) {
          if (member === "bind") return (...values: unknown[]) => wrap(inner.bind(...values));
          if (member === "all") return async () => {
            const result = await inner.all<Record<string, unknown>>();
            queries.push(sql);
            const rows = options.rows?.(sql, result.results) ?? result.results;
            options.afterAll?.(sql);
            return { ...result, results: rows };
          };
          const value = Reflect.get(inner, member);
          return typeof value === "function" ? value.bind(inner) : value;
        },
      });
      return wrap(target.prepare(sql));
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { database, queries };
}

it("matches every singleton dependency across mixed formats, selected-day links, sessions, and empty days", async () => {
  const { source, corpus, linkedDay } = await setup();
  const days = corpus.historyDates;
  const exactSelected = await effectiveHistoryDependency(source, corpus.owner, namespace,
    corpus.equivalentDay, corpus.equivalentDay);
  expect(exactSelected.v1).toHaveLength(1);
  expect(exactSelected.v11).toHaveLength(1);
  expect(exactSelected.v12).toHaveLength(1);
  // A same-ID occurrence under another owner must not become an outside-day link.
  expect(exactSelected.occurrenceLinks).toEqual([]);
  const other = (await readStorageCommunityOwnerPage(source))
    .find(owner => owner.participantId !== corpus.participantId)!;
  expect((await effectiveHistoryDependency(source, other, namespace,
    corpus.equivalentDay, corpus.equivalentDay)).occurrenceLinks).toEqual([
    expect.objectContaining({ family: "v1", source_day: linkedDay }),
  ]);
  const correction = await effectiveHistoryDependency(source, corpus.owner, namespace,
    corpus.correctionDay, corpus.correctionDay);
  const linked = await effectiveHistoryDependency(source, corpus.owner, namespace, linkedDay, linkedDay);
  expect(correction.occurrenceLinks).toEqual(expect.arrayContaining([
    expect.objectContaining({ family: "v12", source_day: linkedDay }),
  ]));
  expect(linked.occurrenceLinks).toEqual(expect.arrayContaining([
    expect.objectContaining({ family: "v12", source_day: corpus.correctionDay }),
  ]));
  for (const includeSessions of [false, true]) {
    const observed = observeD1(source);
    const reader = await createEffectiveHistoryDayDependencyReader(observed.database, corpus.owner,
      namespace, days, { occurrenceLinks: "batched", includeSessions });
    expect(reader).toBeDefined();
    for (const day of days) {
      expect(await reader!.readDigest(day)).toBe(await exactDigest(source, corpus.owner,
        day, includeSessions));
    }
    expect(observed.queries.filter(sql => sql.includes(marker))).toHaveLength(1);
  }
  const otherReader = await createEffectiveHistoryDayDependencyReader(source, other,
    namespace, [corpus.equivalentDay, linkedDay], { occurrenceLinks: "batched" });
  expect(otherReader).toBeDefined();
  for (const day of [corpus.equivalentDay, linkedDay]) {
    expect(await otherReader!.readDigest(day)).toBe(await sha256Hex(canonicalJson(
      await effectiveHistoryDependency(source, other, namespace, day, day))));
  }
  const emptyDay = corpus.historyDates[1]!;
  expect(corpus.populatedDates).not.toContain(emptyDay);
  const withoutSession = await exactDigest(source, corpus.owner, corpus.sessionDay, false);
  const withSession = await exactDigest(source, corpus.owner, corpus.sessionDay, true);
  expect(withSession).not.toBe(withoutSession);
}, 60_000);

it("changes both real source days after an accepted successor while unrelated day digests stay reusable", async () => {
  const { source, corpus, linkedDay } = await setup();
  const days = [corpus.sessionDay, corpus.correctionDay, linkedDay];
  const before = await createEffectiveHistoryDayDependencyReader(source, corpus.owner,
    namespace, days, { occurrenceLinks: "batched", includeSessions: true });
  expect(before).toBeDefined();
  const previous = await Promise.all(days.map(day => before!.readDigest(day)));
  const owner = await corpus.mutateCorrection();
  const after = await createEffectiveHistoryDayDependencyReader(source, owner,
    namespace, days, { occurrenceLinks: "batched", includeSessions: true });
  expect(after).toBeDefined();
  const current = await Promise.all(days.map(day => after!.readDigest(day)));
  expect(current[0]).toBe(previous[0]);
  expect(current[1]).not.toBe(previous[1]);
  expect(current[2]).not.toBe(previous[2]);
  for (const [index, day] of days.entries()) {
    expect(current[index]).toBe(await exactDigest(source, owner, day, true));
  }
}, 60_000);

it("serializes out-of-order concurrent reads across 101 dates and 16-date batch boundaries", async () => {
  const { source, corpus } = await setup();
  const end = Date.parse(`${corpus.historyDates.at(-1)}T00:00:00.000Z`);
  const days = Array.from({ length: 101 }, (_, index) => new Date(end - (100 - index)
    * 86_400_000).toISOString().slice(0, 10));
  const observed = observeD1(source);
  const reader = await createEffectiveHistoryDayDependencyReader(observed.database, corpus.owner,
    namespace, days, { occurrenceLinks: "batched" });
  expect(reader).toBeDefined();
  const positions = [15, 16, 0, 100, 32, 31, 16, 15];
  const actual = await Promise.all(positions.map(index => reader!.readDigest(days[index]!)));
  for (const [position, index] of positions.entries()) {
    expect(actual[position]).toBe(await exactDigest(source, corpus.owner, days[index]!, false));
  }
  expect(observed.queries.filter(sql => sql.includes(marker))).toHaveLength(7);
}, 60_000);

it("refuses invalid bounds and cancellation, and falls back after a batch row overflow", async () => {
  const { source, corpus } = await setup();
  const days = corpus.historyDates.slice(0, 2);
  const invalid = observeD1(source);
  const tooMany = Array.from({ length: 102 }, (_, index) => new Date(Date.parse("2026-01-01")
    + index * 86_400_000).toISOString().slice(0, 10));
  await expect(createEffectiveHistoryDayDependencyReader(invalid.database, corpus.owner,
    namespace, tooMany, { occurrenceLinks: "batched" }))
    .rejects.toThrow("STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE");
  expect(invalid.queries).toHaveLength(0);

  const cancelledBefore = observeD1(source);
  expect(await createEffectiveHistoryDayDependencyReader(cancelledBefore.database, corpus.owner,
    namespace, days, { occurrenceLinks: "batched", canContinue: () => false })).toBeUndefined();
  expect(cancelledBefore.queries).toHaveLength(0);

  let beforeBatch = true;
  const cancelledAtBatch = observeD1(source, { afterAll() {
    if (cancelledAtBatch.queries.length === 5) beforeBatch = false;
  } });
  const noBatch = await createEffectiveHistoryDayDependencyReader(cancelledAtBatch.database, corpus.owner,
    namespace, days, { occurrenceLinks: "batched", canContinue: () => beforeBatch });
  expect(noBatch ? await noBatch.readDigest(days[0]!) : undefined).toBeUndefined();
  expect(cancelledAtBatch.queries).toHaveLength(5);
  expect(cancelledAtBatch.queries.some(sql => sql.includes(marker))).toBe(false);

  const overflowing = observeD1(source, { rows(sql, original) {
    return sql.includes(marker) ? Array(30_001).fill(original[0] ?? {}) : original;
  } });
  const fallback = await createEffectiveHistoryDayDependencyReader(overflowing.database, corpus.owner,
    namespace, days, { occurrenceLinks: "batched" });
  expect(fallback).toBeDefined();
  for (const day of days) expect(await fallback!.readDigest(day)).toBe(await exactDigest(source,
    corpus.owner, day, false));
  expect(overflowing.queries.filter(sql => sql.includes(marker))).toHaveLength(1);

  const oversizedDigest = "b".repeat(4 * 1024 * 1024);
  const oversizedBytes = observeD1(source, { rows(sql, original) {
    return sql.includes(marker) ? [{ ...(original[0] ?? {}), target_day: days[0],
      source_digest: oversizedDigest }] : original;
  } });
  const byteFallback = await createEffectiveHistoryDayDependencyReader(oversizedBytes.database,
    corpus.owner, namespace, days, { occurrenceLinks: "batched" });
  expect(byteFallback).toBeDefined();
  expect(await byteFallback!.readDigest(days[0]!)).toBe(await exactDigest(source, corpus.owner,
    days[0]!, false));
  expect(oversizedBytes.queries.filter(sql => sql.includes(marker))).toHaveLength(1);

  const invalidTag = observeD1(source, { rows(sql, original) {
    return sql.includes(marker) ? [{ ...(original[0] ?? {}), target_day: "2020-01-01" }] : original;
  } });
  const invalidReader = await createEffectiveHistoryDayDependencyReader(invalidTag.database,
    corpus.owner, namespace, days, { occurrenceLinks: "batched" });
  expect(invalidReader).toBeDefined();
  await expect(invalidReader!.readDigest(days[0]!))
    .rejects.toThrow("STORAGE_EFFECTIVE_HISTORY_UNAVAILABLE");
  expect(invalidTag.queries.filter(sql => sql.includes(marker))).toHaveLength(1);

  let keepGoing = true;
  const cancelledAfter = observeD1(source, { afterAll(sql) {
    if (sql.includes(marker)) keepGoing = false;
  } });
  const pending = await createEffectiveHistoryDayDependencyReader(cancelledAfter.database, corpus.owner,
    namespace, days, { occurrenceLinks: "batched", canContinue: () => keepGoing });
  const cancelledDigest = pending ? await pending.readDigest(days[0]!) : undefined;
  expect(cancelledDigest).toBeUndefined();
  expect(cancelledAfter.queries.filter(sql => sql.includes(marker))).toHaveLength(1);
}, 60_000);
