import assert from "node:assert/strict";
import { test } from "node:test";
import {
  POSTGRES_ANALYTICS_APPLIED_MAX_PAGE_SIZE,
  POSTGRES_ANALYTICS_APPLIED_RECEIPT_TABLE,
  transferPostgresAnalyticsAppliedReceipts,
} from "./postgres-analytics-applied-transfer.mjs";

test("analytics applied-receipt staging has a dedicated versioned table and bounded pages", async () => {
  assert.equal(POSTGRES_ANALYTICS_APPLIED_RECEIPT_TABLE, "synthetic_analytics_applied_event_receipts_v1");
  await assert.rejects(transferPostgresAnalyticsAppliedReceipts({
    targetSchema: "analytics_applied_transfer_target_synthetic",
    transferId: "synthetic-analytics-applied-check",
    pageSize: POSTGRES_ANALYTICS_APPLIED_MAX_PAGE_SIZE + 1,
  }), { code: "ANALYTICS_APPLIED_PAGE_SIZE_INVALID" });
});

test("analytics applied-receipt staging rejects non-disposable targets and arbitrary transfer ids", async () => {
  await assert.rejects(transferPostgresAnalyticsAppliedReceipts({
    targetSchema: "analytics_production",
    transferId: "synthetic-analytics-applied-check",
  }), { code: "ANALYTICS_APPLIED_DISPOSABLE_SCHEMA_REQUIRED" });
  await assert.rejects(transferPostgresAnalyticsAppliedReceipts({
    targetSchema: "analytics_applied_transfer_target_synthetic",
    transferId: "unscoped-transfer",
  }), { code: "ANALYTICS_APPLIED_TRANSFER_ID_INVALID" });
});

test("analytics applied-receipt staging requires a trusted sealed event source", async () => {
  await assert.rejects(transferPostgresAnalyticsAppliedReceipts({
    source: Object.freeze({
      snapshot: Object.freeze({ kind: "sealed-sqlite-rehearsal", immutable: true, artifactSha256: "0".repeat(64),
        snapshotId: `sha256:${"0".repeat(64)}` }),
      async verifySnapshot() { return {}; },
      async listPage() { return { rows: [] }; },
    }),
    destinationPool: Object.freeze({ async connect() { throw new Error("must not connect to an untrusted source"); } }),
    targetSchema: "analytics_applied_transfer_target_synthetic",
    transferId: "synthetic-analytics-applied-check",
  }), { code: "ANALYTICS_APPLIED_SEALED_SOURCE_REQUIRED" });
});
