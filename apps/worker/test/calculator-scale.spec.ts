import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { projectAdminModelHistoryDay } from "@app-usagemonitor/telemetry-contract";
import { warmCommunityAnalysisCaches } from "../src/community-analysis-warmer";
import { readCachedAdminCommunityAllowancePreview, warmAdminCommunityAllowancePreviewCache } from "../src/admin-community-allowance";
import { readCachedCommunityAllowanceCorpus, readCachedCommunityModelCompositions,
  selectCommunityAllowanceAnalysisFits, summarizeCommunityAllowanceDay,
  type CommunityAllowanceFit } from "../src/community-allowance";
import { accountScopedModelCompositionV1, accountScopedQuotaAnalysisV1FullReferenceForTest } from "../src/quota-analysis-v1";
import { warmCommunityModelHistory } from "../src/community-model-history";
import { rebuildPendingCommunityDailyAggregates, readPublishedCommunityDailyAggregatesWithAllowanceState } from "../src/community-daily-aggregates";
import { advanceCommunityPublication } from "../src/community-publication";
import { seedModelHistoryFixture, MODEL_HISTORY_TEST_CAPACITIES, insertModelHistoryRecords,
  pricedModelHistoryUsage } from "./helpers/model-history";
import { emptyScaleMeasurements, measuredScaleInvocation } from "./helpers/calculator-scale";

declare module "vitest" {
  interface TaskMeta { calculatorScale?: Record<string, unknown>; }
}

const database = () => env.USAGE_MONITOR_DB;
const NOW = Date.parse("2026-09-08T12:00:00.000Z");
const LEASE = "synthetic-thousand-contributor-qualification";
const id = (index: number) => `synthetic-scale-${String(index).padStart(4, "0")}`;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(database(), (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  await database().prepare(`UPDATE retention_state SET maintenance_lease_token=?,
    maintenance_lease_expires_at='2030-01-01T00:00:00.000Z' WHERE singleton=1`).bind(LEASE).run();
});

describe("isolated real-D1 calculator scale qualification", () => {
  for (const contributors of [100, 500, 1000]) {
    it(`${contributors} contributors: cold import, stable reads and incremental contribution`, async ({ task }) => {
      const seededAt = Date.now();
      let firstFixture: Awaited<ReturnType<typeof seedModelHistoryFixture>> | undefined;
      let peerFixture: Awaited<ReturnType<typeof seedModelHistoryFixture>> | undefined;
      // Reviewed device/consent/journal fixtures, real priced usage and quota
      // curves. No legacy empty uploads and no pre-computed fit cache seeding.
      for (let index = 0; index < contributors; index++) {
        const fixture = await seedModelHistoryFixture({ participantId: id(index), binCount: 60 });
        if (index === 0) firstFixture = fixture;
        if (index === 1) peerFixture = fixture;
      }
      const seedMs = Date.now() - seededAt;
      const referenceFits = selectCommunityAllowanceAnalysisFits(id(0), [{ source: "v1",
        analysis: await accountScopedQuotaAnalysisV1FullReferenceForTest(database(), id(0)) }]);
      const referenceModel = await accountScopedModelCompositionV1(database(), id(0), { nowMs: NOW });
      expect(referenceFits.length).toBeGreaterThan(0);
      expect(referenceModel.status).toBe("ready");
      if (contributors === 1000) {
        await database().prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<200)
          INSERT INTO participants(id,access_token_id,access_token_hash,recovery_token_id,recovery_token_hash,
            state,consent_version,consented_at,created_at)
          SELECT 'synthetic-bystander-'||i,'synthetic-bystander-access-'||i,zeroblob(32),
            'synthetic-bystander-recovery-'||i,zeroblob(32),CASE WHEN i%2=0 THEN 'deleting' ELSE 'active' END,
            'privacy-safe-telemetry-v0.1','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z' FROM n`).run();
      }
      const cold = emptyScaleMeasurements();
      let completed = false, published = 0;
      for (let pass = 0; pass < contributors * 3 && !completed; pass++) {
        const invocation = measuredScaleInvocation(database(), cold);
        const result = await warmCommunityAnalysisCaches(invocation.db, NOW,
          { meter: invocation.meter, deadlineMs: invocation.deadlineMs, maintenanceLease: LEASE });
        invocation.finish();
        published += result.published;
        completed = result.status === "complete";
      }
      expect(completed, JSON.stringify({ cold, published })).toBe(true);
      expect(published).toBe(contributors);
      expect(cold.maxInvocationStatements).toBeLessThanOrEqual(900);

      const acquire = emptyScaleMeasurements();
      const reading = measuredScaleInvocation(database(), acquire);
      const budget = { remainingQueries: reading.meter.remainingQueries, deadlineMs: reading.deadlineMs };
      const corpus = await readCachedCommunityAllowanceCorpus(reading.db, NOW, { budget });
      const models = await readCachedCommunityModelCompositions(reading.db, NOW, { budget });
      reading.finish();
      expect(corpus?.participantIds).toHaveLength(contributors);
      const fitsByAccount = new Map<string, CommunityAllowanceFit[]>();
      for (const fit of corpus!.fits) {
        const fits = fitsByAccount.get(fit.participantId) ?? [];
        fits.push(fit); fitsByAccount.set(fit.participantId, fits);
      }
      expect(fitsByAccount.size).toBe(contributors);
      for (let index = 0; index < contributors; index++) {
        expect(fitsByAccount.get(id(index))).toEqual(referenceFits.map(fit => ({ ...fit, participantId: id(index) })));
      }
      expect(models?.v1ParticipantCount).toBe(contributors);
      expect(models?.compositions).toHaveLength(contributors);
      for (const account of models!.compositions) {
        expect(account.composition.status).toBe("ready");
        if (referenceModel.status === "ready") expect(account.composition.fit).toEqual(referenceModel.fit);
        for (const [model, capacity] of Object.entries(MODEL_HISTORY_TEST_CAPACITIES)) {
          expect(account.composition.fit.capacityUsdByModel?.[model]).toBeCloseTo(capacity, 4);
        }
      }

      const publication = emptyScaleMeasurements();
      let refreshed = false;
      for (let pass = 0; pass < 100 && !refreshed; pass++) {
        const invocation = measuredScaleInvocation(database(), publication);
        const result = await warmAdminCommunityAllowancePreviewCache(invocation.db, NOW,
          { mode: "cache-only", budget: { remainingQueries: invocation.meter.remainingQueries, deadlineMs: invocation.deadlineMs } });
        invocation.finish();
        refreshed = result.code === "ALLOWANCE_PREVIEW_CACHE_REFRESHED";
      }
      expect(refreshed).toBe(true);
      const preview = await readCachedAdminCommunityAllowancePreview(database(), NOW);
      expect(preview).not.toBeNull();
      expect(preview?.coverage.uploadingParticipantCount).toBe(contributors);

      const daily = emptyScaleMeasurements();
      let dailyComplete = false;
      for (let pass = 0; pass < contributors && !dailyComplete; pass++) {
        const invocation = measuredScaleInvocation(database(), daily);
        const result = await rebuildPendingCommunityDailyAggregates(invocation.db, NOW, 24, {},
          { mode: "cache-only", budget: { remainingQueries: invocation.meter.remainingQueries, deadlineMs: invocation.deadlineMs } });
        invocation.finish();
        dailyComplete = !result.remaining && !result.deferred;
      }
      expect(dailyComplete, JSON.stringify(daily)).toBe(true);
      const publicRead = emptyScaleMeasurements();
      const publicInvocation = measuredScaleInvocation(database(), publicRead);
      const publicGraph = await readPublishedCommunityDailyAggregatesWithAllowanceState(publicInvocation.db,
        "2026-07-01", "2026-09-07");
      publicInvocation.finish();
      expect(publicGraph.allowanceReadState).toBe("confirmed");
      expect(publicGraph.allowanceBreakdownsCache).not.toBeNull();
      expect(publicGraph.rows.length).toBeGreaterThanOrEqual(5);
      for (const row of publicGraph.rows) {
        expect(JSON.parse(row.payload_json).allowance).toEqual(summarizeCommunityAllowanceDay(corpus!.fits, row.day));
      }
      expect(publicRead.statements).toBe(2);
      expect(publicRead.rowsWritten).toBe(0);
      expect(publicRead.rawRecordQueries).toBe(0);

      const idle = emptyScaleMeasurements();
      for (let replay = 0; replay < 3; replay++) {
        const invocation = measuredScaleInvocation(database(), idle);
        expect(await warmCommunityAnalysisCaches(invocation.db, NOW,
          { meter: invocation.meter, deadlineMs: invocation.deadlineMs, maintenanceLease: LEASE }))
          .toMatchObject({ status: "complete", published: 0, resumed: 0 });
        invocation.finish();
      }
      expect(idle.rawRecordQueries).toBe(0);
      expect(idle.rowsWritten).toBe(0);

      // The history lane must include the same full cohort, and two adjacent
      // closed days must reuse prepared source days rather than acquire them
      // again. This is two representative dates, not a claim that all 69 dates
      // have completed in this benchmark.
      const history = emptyScaleMeasurements();
      for (const day of ["2026-09-07", "2026-09-06"]) {
        let historyPublished = false;
        for (let pass = 0; pass < contributors * 3 && !historyPublished; pass++) {
          const invocation = measuredScaleInvocation(database(), history);
          const result = await warmCommunityModelHistory(invocation.db, NOW,
            { meter: invocation.meter, deadlineMs: invocation.deadlineMs, maintenanceLease: LEASE });
          invocation.finish();
          expect(result.day).toBe(day);
          expect(result.requiredAccounts).toBe(contributors);
          historyPublished = result.publishedDays === 1;
        }
        expect(historyPublished, JSON.stringify(history)).toBe(true);
        const stored = await database().prepare("SELECT payload_json FROM community_model_composition_days WHERE day=?")
          .bind(day).first<{ payload_json: string }>();
        expect(stored).not.toBeNull();
        const modelDay = projectAdminModelHistoryDay(JSON.parse(stored!.payload_json));
        expect(modelDay).toMatchObject({ day, fittedParticipantCount: contributors, v1ParticipantCount: contributors,
          unstableParticipantCount: 0, staleParticipantCount: 0, refusedParticipantCount: 0,
          unsupportedSourceParticipantCount: 0 });
        expect(modelDay!.values).toEqual(Object.entries(MODEL_HISTORY_TEST_CAPACITIES)
          .sort(([left], [right]) => left.localeCompare(right, "en"))
          .map(([model, capacity]) => [model, capacity, contributors]));
      }
      expect(history.maxInvocationStatements).toBeLessThanOrEqual(900);
      expect(history.rawRecordQueries).toBe(0);

      // A real accepted additional chunk invalidates only one account. Saved
      // authorized graph remains usable during recalculation, with no new zero.
      await insertModelHistoryRecords(firstFixture!, "incremental",
        [pricedModelHistoryUsage("gpt-5.6-sol", 1, "2026-09-01T00:45:00.000Z").record]);
      expect(await readCachedAdminCommunityAllowancePreview(database(), NOW)).toEqual(preview);
      const incremental = emptyScaleMeasurements();
      let corrected = 0;
      for (let pass = 0; pass < 10 && corrected === 0; pass++) {
        const invocation = measuredScaleInvocation(database(), incremental);
        const result = await warmCommunityAnalysisCaches(invocation.db, NOW,
          { meter: invocation.meter, deadlineMs: invocation.deadlineMs, maintenanceLease: LEASE });
        invocation.finish(); corrected += result.published;
      }
      expect(corrected).toBe(1);
      expect(incremental.statements).toBeLessThan(cold.statements / 5);
      expect(await readCachedAdminCommunityAllowancePreview(database(), NOW)).toEqual(preview);
      const busy = emptyScaleMeasurements(), churn = emptyScaleMeasurements();
      let continuousArrivals = 0;
      if (contributors === 1000) {
        // One account contributes over 80x the ordinary fixture's usage, while
        // a second contributes a small correction. Both must finish; the other
        // 998 accounts must not be reconstructed or lose their saved graph.
        await insertModelHistoryRecords(firstFixture!, "busy", Array.from({ length: 10_000 },
          () => pricedModelHistoryUsage("gpt-5.6-sol", 0.001, "2026-09-02T00:30:00.000Z").record));
        await insertModelHistoryRecords(peerFixture!, "small-peer",
          [pricedModelHistoryUsage("gpt-5.6-terra", 0.001, "2026-09-02T00:30:00.000Z").record]);
        let busyComplete = false, busyPublished = 0;
        for (let pass = 0; pass < 100 && !busyComplete; pass++) {
          const invocation = measuredScaleInvocation(database(), busy);
          const result = await warmCommunityAnalysisCaches(invocation.db, NOW,
            { meter: invocation.meter, deadlineMs: invocation.deadlineMs, maintenanceLease: LEASE });
          invocation.finish(); busyPublished += result.published;
          busyComplete = result.status === "complete";
          expect(await readCachedAdminCommunityAllowancePreview(database(), NOW)).toEqual(preview);
        }
        expect(busyComplete, JSON.stringify(busy)).toBe(true);
        expect(busyPublished).toBe(2);

        // Resume a new capture after every one-page checkpoint. Once the first
        // member is captured, append another accepted chunk on EVERY pass.
        // Its already-complete captured version can still publish; requiring a
        // globally quiet upload epoch here would never finish this workload.
        let ready = false, capturedFirstMember = false;
        for (let pass = 0; pass < 100 && !ready; pass++) {
          const invocation = measuredScaleInvocation(database(), churn);
          const result = await advanceCommunityPublication(invocation.db, NOW,
            { maxPages: 1, budget: { remainingQueries: invocation.meter.remainingQueries, deadlineMs: invocation.deadlineMs } });
          invocation.finish();
          // Retirement reports the prior member count. Only the new capture
          // may authorize the arrival loop's first contribution.
          const head = await database().prepare("SELECT phase, published, member_count FROM community_publication_generation").first<{
            phase: string; published: number; member_count: number;
          }>();
          if (head?.published === 0 && head.phase !== "retiring" && head.member_count > 0) capturedFirstMember = true;
          if (capturedFirstMember) {
            await insertModelHistoryRecords(firstFixture!, `continuous-${pass}`,
              [pricedModelHistoryUsage("gpt-5.6-sol", 0.001, "2026-09-02T00:30:00.000Z").record]);
            continuousArrivals++;
          }
          expect(await readCachedAdminCommunityAllowancePreview(database(), NOW)).toEqual(preview);
          ready = result.status === "ready";
          if (ready) expect(result).toMatchObject({ memberCount: contributors, preparedCount: contributors });
        }
        expect(ready, JSON.stringify(churn)).toBe(true);
        expect(continuousArrivals).toBeGreaterThan(16);
        const invocation = measuredScaleInvocation(database(), churn);
        expect(await warmAdminCommunityAllowancePreviewCache(invocation.db, NOW,
          { mode: "cache-only", budget: { remainingQueries: invocation.meter.remainingQueries, deadlineMs: invocation.deadlineMs } }))
          .toEqual({ code: "ALLOWANCE_PREVIEW_CACHE_REFRESHED" });
        invocation.finish();
        expect((await readCachedAdminCommunityAllowancePreview(database(), NOW))?.coverage.uploadingParticipantCount)
          .toBe(contributors);
        const epochs = await database().prepare(`SELECT g.source_epoch, s.mutation_epoch
          FROM community_publication_generation g, community_snapshot_mutation_control s
          WHERE g.singleton=1 AND s.singleton_id=1`).first<{ source_epoch: number; mutation_epoch: number }>();
        expect(epochs!.source_epoch).toBeLessThan(epochs!.mutation_epoch);
      }
      task.meta.calculatorScale = { event: "synthetic_calculator_scale", contributors,
        quotaRows: contributors * 61, usageRows: contributors * 120,
        sourceDaysPerContributor: 5, knownModelCapacities: MODEL_HISTORY_TEST_CAPACITIES,
        seedMs, cold, acquire, publication, daily, publicRead, idle, history, incremental,
        ...(contributors === 1000 ? { busyUsageRows: 10_000, busy, continuousArrivals, churn } : {}),
        boundary: "Local Workers/D1; elapsed time is not production CPU or latency; no external traffic." };
    }, 600_000);
  }
});
