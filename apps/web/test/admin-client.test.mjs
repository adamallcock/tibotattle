import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  AdminResponseError,
  adminActionErrorMessage,
  adminResponseError,
  projectAdminAction,
  projectAdminOverview,
} from "../public/admin-client.js";

const fixture = async (name) => JSON.parse(await readFile(
  new URL(`./fixtures/${name}`, import.meta.url),
  "utf8",
));

test("admin overview fixture projects to the renderer's explicit contract", async () => {
  const overview = projectAdminOverview(await fixture("admin-overview-valid.json"));
  assert.deepEqual(overview, {
    generatedAt: "2026-08-02T12:00:00.000Z",
    service: { environment: "production" },
    collection: {
      state: "operational",
      revision: 7,
      enrollment: true,
      uploadRegistration: true,
      processing: true,
      publication: true,
    },
    counts: {
      participants: {
        active: 5,
        total: 6,
        bounded: false,
        enrolledLast24Hours: 1,
        enrolledLast7Days: 3,
      },
      contributions: {
        telemetry: {
          accepted: 9,
          total: 10,
          bounded: false,
          acceptedLast24Hours: 2,
          acceptedLast7Days: 6,
        },
        storedTelemetryRecords: 22,
        storedTelemetryRecordsBounded: false,
      },
      pendingQuarantineObjects: 1,
      pendingQuarantineObjectsBounded: false,
    },
    lifecycle: {
      state: "completed",
      quarantineRetentionComplete: true,
      restoreReplayComplete: true,
      maintenanceRunAt: "2026-08-02T11:00:00.000Z",
      failureCode: null,
    },
    reconciliation: { state: "completed", reconciliationComplete: true },
    ingress: {
      activeLeases: 3,
      maximumConcurrent: 16,
      availableStartTokens: 240,
      burst: 300,
      concurrencyDenials: 4,
      startRateDenials: 2,
      lastDeniedAt: "2026-08-02T09:15:00.000Z",
    },
    snapshots: [{
      snapshotId: "community-weekly:2026-07-26",
      weekStart: "2026-07-26T00:00:00.000Z",
      weekEnd: "2026-08-02T00:00:00.000Z",
      releaseState: "published",
      releasedAt: "2026-08-02T11:30:00.000Z",
    }],
    pendingHistoricalRebuilds: 0,
    errors: {
      groups: [{
        routeClass: "admin_overview",
        errorCode: "BACKEND_STORAGE_UNAVAILABLE",
        occurrences: 2,
        ratePerDay: 0.29,
        latestAt: "2026-08-02T10:00:00.000Z",
      }],
      recentDiagnostics: [{
        requestId: "019fc0b7-6c19-7b40-bda0-a1a1d7202100",
        routeClass: "admin_overview",
        errorCode: "BACKEND_STORAGE_UNAVAILABLE",
        status: 503,
        occurredAt: "2026-08-02T10:00:00.000Z",
      }],
      lookup: null,
    },
    audit: [{
      action: "run_maintenance",
      outcome: "success",
      details: { code: "OK" },
      createdAt: "2026-08-02T11:00:00.000Z",
    }],
  });
  assert.equal(Object.isFrozen(overview), true);
  assert.equal(Object.isFrozen(overview.collection), true);
});

test("an unavailable ingress budget projects to null instead of failing the view", async () => {
  const payload = await fixture("admin-overview-valid.json");
  payload.ingress = null;
  assert.equal(projectAdminOverview(payload).ingress, null);
  delete payload.ingress;
  assert.equal(projectAdminOverview(payload).ingress, null);
});

test("admin overview projector rejects malformed ingress pressure values", async () => {
  for (const ingress of [
    { activeLeases: -1 },
    { ...{
      activeLeases: 0,
      maximumConcurrent: 16,
      availableStartTokens: 0,
      burst: 300,
      concurrencyDenials: 0,
      startRateDenials: 0,
    }, lastDeniedAt: 12345 },
    "unavailable",
  ]) {
    const payload = await fixture("admin-overview-valid.json");
    payload.ingress = ingress;
    assert.throws(
      () => projectAdminOverview(payload),
      /ADMIN_OVERVIEW_INVALID/u,
    );
  }
});

test("admin overview projector rejects missing and malformed render values", async () => {
  for (const name of [
    "admin-overview-missing-counts.json",
    "admin-overview-malformed.json",
  ]) {
    const payload = await fixture(name);
    assert.throws(
      () => projectAdminOverview(payload),
      /ADMIN_OVERVIEW_INVALID/u,
    );
  }
});

test("admin action projection rejects malformed successful responses", () => {
  assert.throws(
    () => projectAdminAction({
      schemaVersion: "admin-action-v0.1",
      action: "run_maintenance",
      result: {},
    }, "run_maintenance"),
    (error) => error instanceof AdminResponseError
      && error.code === "ADMIN_ACTION_INVALID",
  );
});

test("admin action conflicts explain that the displayed revision is stale", async () => {
  const error = adminResponseError(409, await fixture("admin-action-stale-revision.json"));
  assert.equal(error.code, "ADMIN_ACTION_CONFLICT");
  assert.equal(
    adminActionErrorMessage(error),
    "The collection state changed elsewhere. Refresh the operations view before trying again.",
  );
});

test("admin action failures retain a verified diagnostic reference for display", async () => {
  const error = adminResponseError(503, await fixture("admin-action-error.json"));
  assert.equal(
    adminActionErrorMessage(error),
    "BACKEND_STORAGE_UNAVAILABLE (019fc0b7-6c19-7b40-bda0-a1a1d7202180)",
  );
  assert.equal(
    adminActionErrorMessage(adminResponseError(503, { error: { code: 42 } })),
    "HTTP_503",
  );
});
