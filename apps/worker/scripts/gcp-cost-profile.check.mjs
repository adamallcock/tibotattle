import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  calculateMonthlyCostEstimate,
  createCostProfileReport,
  GCP_COST_PROFILE,
  getPriceFreshness,
  inspectCostProfileDocument,
  validateGcpCostProfile,
} from "./gcp-cost-profile.mjs";

function editableProfile() {
  return structuredClone(GCP_COST_PROFILE);
}

test("reference profile pins small zonal databases and request-billed scale-to-zero service", () => {
  const validation = validateGcpCostProfile(GCP_COST_PROFILE);
  assert.equal(validation.valid, true);
  assert.equal(GCP_COST_PROFILE.resources.databases.primary.tier, "db-g1-small");
  assert.equal(GCP_COST_PROFILE.resources.databases.ledger.tier, "db-f1-micro");
  assert.equal(GCP_COST_PROFILE.resources.databases.primary.storageGiB, 10);
  assert.equal(GCP_COST_PROFILE.resources.databases.ledger.storageGiB, 10);
  assert.equal(GCP_COST_PROFILE.resources.databases.primary.highAvailability, false);
  assert.equal(GCP_COST_PROFILE.resources.databases.ledger.crossZoneFailover, false);
  assert.deepEqual(GCP_COST_PROFILE.resources.cloudRun.service, {
    minInstances: 0,
    maxInstances: 2,
    scaleToZero: true,
    billing: "request",
    cpu: 1,
    memoryGiB: 1,
    concurrency: 8,
  });
});

test("Cloud SQL monthly arithmetic is transparent and does not claim a total bill", () => {
  const estimate = calculateMonthlyCostEstimate();
  assert.equal(estimate.primary.computeUsd, 25.55);
  assert.equal(estimate.primary.storageUsd, 1.7);
  assert.equal(estimate.primary.subtotalUsd, 27.25);
  assert.equal(estimate.ledger.computeUsd, 7.665);
  assert.equal(estimate.ledger.storageUsd, 1.7);
  assert.equal(estimate.ledger.subtotalUsd, 9.365);
  assert.equal(estimate.cloudSqlComputeUsd, 33.215);
  assert.equal(estimate.cloudSqlAllocatedSsdUsd, 3.4);
  assert.equal(estimate.knownConfiguredCloudSqlUsd, 36.615);
  assert.equal(estimate.roundedKnownConfiguredCloudSqlUsd, 36.62);
  assert.equal(estimate.totalCloudBillUsd, null);
});

test("cost arithmetic rejects non-finite, zero, negative, or unbounded month hours", () => {
  for (const hours of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 745]) {
    assert.throws(() => calculateMonthlyCostEstimate(GCP_COST_PROFILE, hours), RangeError);
  }
  assert.equal(calculateMonthlyCostEstimate(GCP_COST_PROFILE, 720).databaseRunningHours, 720);
});

test("validator rejects HA, failover, larger databases, region changes, and larger service limits", () => {
  const mutations = [
    (profile) => { profile.resources.databases.primary.highAvailability = true; },
    (profile) => { profile.resources.databases.ledger.crossZoneFailover = true; },
    (profile) => { profile.resources.databases.primary.storageGiB = 11; },
    (profile) => { profile.resources.databases.ledger.tier = "db-g1-small"; },
    (profile) => { profile.region = "us-east4"; },
    (profile) => { profile.resources.cloudRun.service.minInstances = 1; },
    (profile) => { profile.resources.cloudRun.service.maxInstances = 3; },
    (profile) => { profile.resources.cloudRun.service.billing = "instance"; },
    (profile) => { profile.resources.cloudRun.service.cpu = 2; },
  ];
  for (const mutate of mutations) {
    const candidate = editableProfile();
    mutate(candidate);
    assert.equal(validateGcpCostProfile(candidate).valid, false);
  }
});

test("lower Cloud Run instance cap remains within the ceiling and is reported as drift", () => {
  const candidate = editableProfile();
  candidate.resources.cloudRun.service.maxInstances = 1;
  const validation = validateGcpCostProfile(candidate);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.drift, ["cloud_run_max_instances_below_reference"]);
});

test("unknown workload allowances remain unknown, with a pinned Cloud Storage rate", () => {
  assert.equal(GCP_COST_PROFILE.rates.cloudStorageStandardUsdPerGiBMonth, 0.02);
  assert.equal(GCP_COST_PROFILE.unpricedAllowances.length > 0, true);
  for (const allowance of GCP_COST_PROFILE.unpricedAllowances) {
    assert.equal(allowance.monthlyUsd, null);
  }
});

test("price freshness is advisory, including when the pinned date is in the future", () => {
  assert.deepEqual(getPriceFreshness("2026-09-22", "2026-09-23", 30), {
    status: "current",
    ageDays: 1,
  });
  assert.equal(getPriceFreshness("2026-08-01", "2026-09-23", 30).status, "stale-advisory");
  assert.equal(getPriceFreshness("2026-10-01", "2026-09-23", 30).status, "future-date-advisory");
});

test("JSON report round-trips through the offline input validator", () => {
  const report = createCostProfileReport(GCP_COST_PROFILE, { today: "2026-09-23" });
  const inspected = inspectCostProfileDocument(report, { today: "2026-09-23" });
  assert.equal(inspected.assessment.valid, true);
  assert.equal(inspected.assessment.embeddedEstimate, "matches");
  assert.equal(inspected.costEstimate.knownConfiguredCloudSqlUsd, 36.615);
});

test("invalid or unknown supplied fields produce fixed diagnostics without echoing input", () => {
  const report = createCostProfileReport(GCP_COST_PROFILE, { today: "2026-09-23" });
  report.resources.databases.primary.tier = "private-sentinel-value";
  report.resources.cloudRun.service.unrecognizedSecretField = "private-sentinel-secret";
  report.privateSentinelField = "private-sentinel-value";
  const inspected = inspectCostProfileDocument(report, { today: "2026-09-23" });
  const output = JSON.stringify(inspected);
  assert.equal(inspected.assessment.valid, false);
  assert.deepEqual(inspected.resources, GCP_COST_PROFILE.resources);
  assert.equal(output.includes("private-sentinel"), false);
  assert.equal(output.includes("unrecognizedSecretField"), false);
});

test("malformed assessment metadata is rejected without throwing or echoing values", () => {
  const report = createCostProfileReport(GCP_COST_PROFILE, { today: "2026-09-23" });
  report.assessment.issues = { privateSentinel: "private-sentinel-secret" };
  const inspected = inspectCostProfileDocument(report, { today: "2026-09-23" });
  assert.equal(inspected.assessment.valid, false);
  assert.equal(inspected.assessment.issues.some((issue) => issue.code === "array_required"), true);
  assert.equal(JSON.stringify(inspected).includes("private-sentinel"), false);
});

test("CLI refuses oversized local profile input before parsing or echoing it", async () => {
  const directory = await mkdtemp("/private/tmp/gcp-cost-profile-check-");
  const inputPath = path.join(directory, "oversized.json");
  const scriptPath = fileURLToPath(new URL("./gcp-cost-profile.mjs", import.meta.url));
  try {
    await writeFile(inputPath, "x".repeat(65_537), { mode: 0o600 });
    const result = spawnSync(process.execPath, [scriptPath, "--input", inputPath], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /64 KiB input limit/u);
    assert.equal(result.stderr.includes(inputPath), false);
    assert.equal(result.stderr.includes("xxxx"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
