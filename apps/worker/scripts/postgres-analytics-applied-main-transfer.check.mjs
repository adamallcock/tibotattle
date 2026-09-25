import assert from "node:assert/strict";
import { test } from "node:test";
import {
  POSTGRES_ANALYTICS_APPLIED_MAIN_MAX_PAGE_SIZE,
  transferPostgresAnalyticsAppliedMain,
} from "./postgres-analytics-applied-main-transfer.mjs";

test("main analytics applied-event transfer has bounded pages and a disposable schema boundary", async () => {
  await assert.rejects(transferPostgresAnalyticsAppliedMain({
    targetSchema: "storage_journal_transfer_target_synthetic",
    transferId: "synthetic-analytics-applied-main-check",
    journalTransferId: "synthetic-ingestion-journal-check",
    pageSize: POSTGRES_ANALYTICS_APPLIED_MAIN_MAX_PAGE_SIZE + 1,
  }), { code: "ANALYTICS_APPLIED_MAIN_PAGE_SIZE_INVALID" });
  await assert.rejects(transferPostgresAnalyticsAppliedMain({
    targetSchema: "analytics_production",
    transferId: "synthetic-analytics-applied-main-check",
    journalTransferId: "synthetic-ingestion-journal-check",
  }), { code: "ANALYTICS_APPLIED_MAIN_DISPOSABLE_SCHEMA_REQUIRED" });
});

test("main analytics applied-event transfer requires explicitly scoped run identities", async () => {
  await assert.rejects(transferPostgresAnalyticsAppliedMain({
    targetSchema: "storage_journal_transfer_target_synthetic",
    transferId: "synthetic-analytics-applied-main-check",
    journalTransferId: "unscoped-journal-run",
  }), { code: "ANALYTICS_APPLIED_MAIN_JOURNAL_TRANSFER_ID_INVALID" });
  await assert.rejects(transferPostgresAnalyticsAppliedMain({
    targetSchema: "storage_journal_transfer_target_synthetic",
    transferId: "unscoped-main-run",
    journalTransferId: "synthetic-ingestion-journal-check",
  }), { code: "ANALYTICS_APPLIED_MAIN_TRANSFER_ID_INVALID" });
});

test("main analytics applied-event transfer accepts only the sealed D1 source implementation", async () => {
  await assert.rejects(transferPostgresAnalyticsAppliedMain({
    source: Object.freeze({
      snapshot: Object.freeze({ kind: "sealed-sqlite-rehearsal", immutable: true,
        artifactSha256: "0".repeat(64), snapshotId: `sha256:${"0".repeat(64)}` }),
      async verifySnapshot() { return {}; },
      async listPage() { return { rows: [] }; },
      async sourceIdentityManifest() { return { runtimeSources: [], sourceCursors: [] }; },
    }),
    destinationPool: Object.freeze({ async connect() { throw new Error("untrusted source must be rejected first"); } }),
    targetSchema: "storage_journal_transfer_target_synthetic",
    transferId: "synthetic-analytics-applied-main-check",
    journalTransferId: "synthetic-ingestion-journal-check",
  }), { code: "ANALYTICS_APPLIED_MAIN_SEALED_SOURCE_INVALID" });
});
