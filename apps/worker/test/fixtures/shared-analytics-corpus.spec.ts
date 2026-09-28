import { env, reset, type D1Migration } from "cloudflare:test";
import { expect, it } from "vitest";
import { readEffectiveTelemetryOwnerDayPage, readEffectiveUsageOwnerDayPage } from "../../src/telemetry-usage-effective-reader";
import { readStorageCommunityOwnerPage } from "../../src/storage-community-authority";
import { createSharedAnalyticsInputCache } from "../../src/analytics-shared-input";
import { evaluateSharedCacheDay, evaluateSharedModelDate, evaluateSharedScalarDate } from "../../src/analytics-shared-reducers";
import { cacheRetentionLookbackDays } from "../../src/cache-retention-day";
import { modelHistoryWindow } from "../../src/model-history-window";
import { initializeSharedAnalyticsCorpusDatabases, seedSharedAnalyticsCorpus } from "./shared-analytics-corpus";

const bindings = env as Env & { STORAGE_ANALYTICS_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[]; TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[]; TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[]; TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
  TEST_ANALYTICS_MIGRATIONS: D1Migration[] };

it("seeds a scoped mixed-format corpus and changes its accepted correction pin", async () => {
  await reset();
  const source = bindings.USAGE_MONITOR_DB, target = bindings.STORAGE_ANALYTICS_DB;
  const sourceId = "synthetic-shared-corpus-test";
  await initializeSharedAnalyticsCorpusDatabases(source, target, bindings, sourceId);
  const corpus = await seedSharedAnalyticsCorpus({ source, target, sourceId,
    sourceNamespace: sourceId, calendarDays: 40, graphDays: 30 });
  expect(corpus.historyDates).toHaveLength(40);
  expect(corpus.graphDates).toHaveLength(30);
  expect(corpus.modelFitDates).toHaveLength(25);
  expect(corpus.owner).toMatchObject({ hasV1: true, hasV11: true, hasV12: true, hasEffective: true });
  const equivalentDay = corpus.equivalentDay;
  const scope = { sourceNamespace: sourceId, ownerDigest: corpus.owner.ownerDigest,
    ownerRevision: corpus.owner.ownerRevision, authorityEpoch: corpus.owner.authorityEpoch };
  const equivalent = await readEffectiveUsageOwnerDayPage(source,
    { ...scope, day: equivalentDay, limit: 10 });
  expect(equivalent.rows.find(row => row.occurrenceId === corpus.equivalentOccurrenceId))
    .toEqual(expect.objectContaining({
    occurrenceId: corpus.equivalentOccurrenceId, sourceCount: 3,
    sourceFormats: ["v1", "v11", "v12"],
  }));
  const other = (await readStorageCommunityOwnerPage(source))
    .find(value => value.participantId !== corpus.participantId)!;
  const otherPage = await readEffectiveUsageOwnerDayPage(source, {
    sourceNamespace: sourceId, ownerDigest: other.ownerDigest!, ownerRevision: other.ownerRevision,
    authorityEpoch: other.authorityEpoch, day: equivalentDay, limit: 10 });
  expect(otherPage.rows).toEqual([expect.objectContaining({
    occurrenceId: corpus.duplicateAcrossOwnersOccurrenceId, sourceCount: 1,
  })]);
  for (const [stream, count] of [["usage", 0], ["quota", 0], ["session", 1]] as const) {
    const page = await readEffectiveTelemetryOwnerDayPage(source, {
      ...scope, day: corpus.sessionDay, stream, limit: 10,
    });
    expect(page.rows).toHaveLength(count);
  }
  const correctionDay = corpus.correctionDay;
  const before = await readEffectiveUsageOwnerDayPage(source,
    { ...scope, day: correctionDay, limit: 200 });
  expect(before.rows.find(row => row.occurrenceId === corpus.correctionOccurrenceId))
    .toEqual(expect.objectContaining({
    occurrenceId: corpus.correctionOccurrenceId, sourceCount: 1,
  }));
  const updatedOwner = await corpus.mutateCorrection();
  expect(updatedOwner.ownerRevision).toBeGreaterThan(corpus.owner.ownerRevision);
  const after = await readEffectiveUsageOwnerDayPage(source, {
    sourceNamespace: sourceId, ownerDigest: updatedOwner.ownerDigest,
    ownerRevision: updatedOwner.ownerRevision, authorityEpoch: updatedOwner.authorityEpoch,
    day: correctionDay, limit: 200,
  });
  expect(after.rows.find(row => row.occurrenceId === corpus.correctionOccurrenceId))
    .toEqual(expect.objectContaining({
    occurrenceId: corpus.correctionOccurrenceId,
    sourceCount: 2,
  }));
  expect(after.rows.find(row => row.occurrenceId === corpus.correctionOccurrenceId)?.recordJson)
    .not.toBe(before.rows.find(row => row.occurrenceId === corpus.correctionOccurrenceId)?.recordJson);
});

it("admits the full 130-date domain behind 30 graph targets", async () => {
  await reset();
  const source = bindings.USAGE_MONITOR_DB, target = bindings.STORAGE_ANALYTICS_DB;
  const sourceId = "synthetic-shared-corpus-full";
  await initializeSharedAnalyticsCorpusDatabases(source, target, bindings, sourceId);
  const corpus = await seedSharedAnalyticsCorpus({ source, target, sourceId, sourceNamespace: sourceId });
  expect(corpus.historyDates).toHaveLength(130);
  expect(corpus.graphDates).toHaveLength(30);
  expect(corpus.firstGraphLookbackDates).toHaveLength(101);
  expect(corpus.graphDates[0]).toBe(corpus.historyDates[100]);
  expect(corpus.modelFitDates).toHaveLength(25);
  expect(corpus.owner.hasV12).toBe(true);
  expect(corpus.v11DomainThroughDay >= corpus.equivalentDay).toBe(true);
  const day = corpus.graphDates[0]!;
  const page = await readEffectiveUsageOwnerDayPage(source, {
    sourceNamespace: sourceId, ownerDigest: corpus.owner.ownerDigest,
    ownerRevision: corpus.owner.ownerRevision, authorityEpoch: corpus.owner.authorityEpoch,
    day, limit: 200,
  });
  expect(page.rows.length).toBeGreaterThan(0);
});

it("qualifies current scalar resets in the short benchmark corpus", async () => {
  await reset();
  const source = bindings.USAGE_MONITOR_DB, target = bindings.STORAGE_ANALYTICS_DB;
  const sourceId = "synthetic-shared-corpus-scalar";
  await initializeSharedAnalyticsCorpusDatabases(source, target, bindings, sourceId);
  const corpus = await seedSharedAnalyticsCorpus({ source, target, sourceId,
    sourceNamespace: sourceId, calendarDays: 14, graphDays: 2 });
  const throughDay = corpus.historyDates.at(-1)!;
  const firstGraphDay = corpus.graphDates[0]!;
  const cache = createSharedAnalyticsInputCache({ source, sourceNamespace: sourceId });
  const snapshot = await cache.load({ owner: corpus.owner,
    fromDay: modelHistoryWindow(firstGraphDay).fromDay, throughDay, deadlineMs: Date.now() + 60_000 });
  const pin = await snapshot.pinForDate(throughDay);
  const scalar = await evaluateSharedScalarDate({ pin, day: throughDay,
    ownerDigest: corpus.owner.ownerDigest, days: snapshot.days });
  expect(scalar.analysis).toMatchObject({ status: "ready" });
  expect(scalar.selectedFits.length).toBeGreaterThan(0);
  const modelPin = await snapshot.pinForDate(firstGraphDay);
  const model = await evaluateSharedModelDate({ pin: modelPin, day: firstGraphDay,
    ownerDigest: corpus.owner.ownerDigest, days: snapshot.days.filter(day => day.day <= firstGraphDay) });
  expect(model).toMatchObject({ status: "ready" });
  for (const graphDay of corpus.graphDates) {
    const cacheDay = evaluateSharedCacheDay({ day: graphDay,
      ownerDigest: corpus.owner.ownerDigest,
      days: snapshot.days.filter(day => day.day >= cacheRetentionLookbackDays(graphDay)[0]!
        && day.day <= graphDay) });
    expect(cacheDay.groups.length).toBeGreaterThan(0);
    expect(cacheDay.groups.reduce((sum, group) => sum + group.adjacencies, 0)).toBeGreaterThan(0);
  }
});
