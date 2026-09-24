import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const GCP_COST_PROFILE = deepFreeze({
  schemaVersion: "tibotattle-gcp-cost-profile-v1",
  profileDate: "2026-09-23",
  region: "us-east1",
  resources: {
    databases: {
      primary: {
        instanceName: "tibotattle-test-primary-20260922",
        role: "shared-primary",
        tier: "db-g1-small",
        topology: "zonal",
        highAvailability: false,
        crossZoneFailover: false,
        storageType: "SSD",
        storageGiB: 10,
        automaticStorageIncrease: false,
      },
      ledger: {
        instanceName: "tibotattle-test-ledger-20260922",
        role: "independent-ledger",
        tier: "db-f1-micro",
        topology: "zonal",
        highAvailability: false,
        crossZoneFailover: false,
        storageType: "SSD",
        storageGiB: 10,
        automaticStorageIncrease: false,
        independentFrom: "primary",
      },
    },
    cloudRun: {
      service: {
        minInstances: 0,
        maxInstances: 2,
        scaleToZero: true,
        billing: "request",
        cpu: 1,
        memoryGiB: 1,
        concurrency: 8,
      },
      maintenanceSchedule: "hourly",
    },
  },
  priceSnapshot: {
    asOf: "2026-09-22",
    verifiedAt: "2026-09-23",
    staleAfterDays: 30,
    sources: [
      "https://cloud.google.com/sql/pricing",
      "https://cloud.google.com/run/pricing",
      "https://cloud.google.com/storage/pricing",
    ],
  },
  rates: {
    cloudSqlComputeUsdPerInstanceHour: { "db-g1-small": 0.035, "db-f1-micro": 0.0105 },
    cloudSqlSsdUsdPerGiBMonth: 0.17,
    cloudRunRequestBilling: {
      cpuUsdPerVcpuSecond: 0.000024,
      memoryUsdPerGiBSecond: 0.0000025,
      requestsUsdPerMillion: 0.4,
    },
    cloudRunJobInstanceBilling: {
      cpuUsdPerVcpuSecond: 0.000018,
      memoryUsdPerGiBSecond: 0.000002,
      minimumBillableSeconds: 60,
    },
    cloudStorageStandardUsdPerGiBMonth: 0.02,
  },
  assumptions: {
    databaseRunningHoursPerMonth: 730,
    cloudRunFreeTierApplied: false,
    accountCreditsOrDiscountsApplied: false,
    storageGiBIsForThisRehearsalOnly: true,
  },
  unpricedAllowances: [
    { code: "cloud_sql_backups", monthlyUsd: null, needs: ["retained backup bytes", "restore history"] },
    { code: "cloud_run_requests", monthlyUsd: null, needs: ["request count", "billable CPU and memory seconds", "startup and shutdown time"] },
    { code: "hourly_maintenance_job", monthlyUsd: null, needs: ["job resources", "duration per execution", "task count"] },
    { code: "cloud_storage", monthlyUsd: null, rateUsdPerGiBMonth: 0.02, needs: ["average stored GiB", "operation counts", "retained generations"] },
    { code: "network_builds_logging_scheduler", monthlyUsd: null, needs: ["measured usage and destination regions"] },
    { code: "billing_account_adjustments", monthlyUsd: null, needs: ["billing-account invoice and eligibility"] },
  ],
});

const ROOT_KEYS = Object.keys(GCP_COST_PROFILE);
const EXPECTED_OUTPUT_KEYS = [...ROOT_KEYS, "rateFreshness", "costEstimate", "assessment"];
const DAY_MS = 86_400_000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function sameValue(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function roundUsd(amount) {
  return Number(amount.toFixed(6));
}

function checkKeys(value, expected, pathName, issues) {
  if (!isRecord(value)) {
    issues.push({ code: "object_required", path: pathName });
    return;
  }
  for (const key of Object.keys(expected)) {
    if (!Object.hasOwn(value, key)) issues.push({ code: "field_required", path: `${pathName}.${key}` });
  }
  if (Object.keys(value).some((key) => !Object.hasOwn(expected, key))) {
    issues.push({ code: "unknown_property", path: pathName });
  }
}

function checkAllowedKeys(value, allowed, pathName, issues) {
  if (!isRecord(value)) {
    issues.push({ code: "object_required", path: pathName });
    return;
  }
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    issues.push({ code: "unknown_property", path: pathName });
  }
}

function checkProfileShape(candidate) {
  const issues = [];
  checkKeys(candidate, GCP_COST_PROFILE, "profile", issues);
  if (!isRecord(candidate)) return issues;
  checkKeys(candidate.resources, GCP_COST_PROFILE.resources, "profile.resources", issues);
  if (isRecord(candidate.resources)) {
    checkKeys(candidate.resources.databases, GCP_COST_PROFILE.resources.databases, "profile.resources.databases", issues);
    if (isRecord(candidate.resources.databases)) {
      for (const name of ["primary", "ledger"]) {
        checkKeys(candidate.resources.databases[name], GCP_COST_PROFILE.resources.databases[name], `profile.resources.databases.${name}`, issues);
      }
    }
    checkKeys(candidate.resources.cloudRun, GCP_COST_PROFILE.resources.cloudRun, "profile.resources.cloudRun", issues);
    if (isRecord(candidate.resources.cloudRun)) {
      checkKeys(candidate.resources.cloudRun.service, GCP_COST_PROFILE.resources.cloudRun.service, "profile.resources.cloudRun.service", issues);
    }
  }
  return issues;
}

export function validateGcpCostProfile(candidate) {
  const issues = checkProfileShape(candidate);
  if (issues.length) return { valid: false, issues, drift: [] };

  const codes = [];
  const p = candidate.resources.databases.primary;
  const l = candidate.resources.databases.ledger;
  const s = candidate.resources.cloudRun.service;
  for (const key of ["schemaVersion", "profileDate", "region", "priceSnapshot", "rates", "assumptions", "unpricedAllowances"]) {
    if (!sameValue(candidate[key], GCP_COST_PROFILE[key])) codes.push({ code: "pinned_profile_field_changed", path: key });
  }
  if (candidate.region !== "us-east1") codes.push({ code: "region_over_limit", path: "region" });
  for (const [name, actual, expected] of [["primary", p, GCP_COST_PROFILE.resources.databases.primary], ["ledger", l, GCP_COST_PROFILE.resources.databases.ledger]]) {
    for (const key of Object.keys(expected)) {
      if (actual[key] !== expected[key]) codes.push({ code: "database_profile_mismatch", path: `resources.databases.${name}.${key}` });
    }
  }
  if (p.instanceName === l.instanceName) codes.push({ code: "ledger_must_be_independent", path: "resources.databases" });
  if (s.minInstances !== 0) codes.push({ code: "minimum_instances_must_be_zero", path: "resources.cloudRun.service.minInstances" });
  if (!Number.isInteger(s.maxInstances) || s.maxInstances < 1 || s.maxInstances > 2) {
    codes.push({ code: "maximum_instances_exceeds_ceiling", path: "resources.cloudRun.service.maxInstances" });
  }
  for (const [key, expected] of [["scaleToZero", true], ["billing", "request"], ["cpu", 1], ["memoryGiB", 1], ["concurrency", 8]]) {
    if (s[key] !== expected) codes.push({ code: "cloud_run_profile_mismatch", path: `resources.cloudRun.service.${key}` });
  }
  if (candidate.resources.cloudRun.maintenanceSchedule !== "hourly") {
    codes.push({ code: "maintenance_schedule_profile_mismatch", path: "resources.cloudRun.maintenanceSchedule" });
  }

  const drift = [];
  if (s.maxInstances === 1) drift.push("cloud_run_max_instances_below_reference");
  return { valid: codes.length === 0, issues: codes, drift: codes.length === 0 ? drift : [] };
}

export function calculateMonthlyCostEstimate(profile = GCP_COST_PROFILE, hours = profile.assumptions.databaseRunningHoursPerMonth) {
  if (!Number.isFinite(hours) || hours <= 0 || hours > 744) throw new RangeError("hours must be finite and between 0 and 744");
  const validation = validateGcpCostProfile(profile);
  if (!validation.valid) throw new TypeError("cannot estimate an invalid profile");
  const costs = {};
  let compute = 0;
  let storage = 0;
  for (const name of ["primary", "ledger"]) {
    const db = profile.resources.databases[name];
    const computeUsd = roundUsd(hours * profile.rates.cloudSqlComputeUsdPerInstanceHour[db.tier]);
    const storageUsd = roundUsd(db.storageGiB * profile.rates.cloudSqlSsdUsdPerGiBMonth);
    costs[name] = {
      tier: db.tier,
      computeUsd,
      storageUsd,
      subtotalUsd: roundUsd(computeUsd + storageUsd),
    };
    compute += computeUsd;
    storage += storageUsd;
  }
  const known = roundUsd(compute + storage);
  return {
    currency: "USD",
    databaseRunningHours: hours,
    primary: costs.primary,
    ledger: costs.ledger,
    cloudSqlComputeUsd: roundUsd(compute),
    cloudSqlAllocatedSsdUsd: roundUsd(storage),
    knownConfiguredCloudSqlUsd: known,
    roundedKnownConfiguredCloudSqlUsd: Number(known.toFixed(2)),
    totalCloudBillUsd: null,
  };
}

export function getPriceFreshness(asOf, today = new Date().toISOString().slice(0, 10), staleAfterDays = 30) {
  const snapshot = new Date(`${asOf}T00:00:00.000Z`);
  const current = new Date(`${today}T00:00:00.000Z`);
  if (!Number.isFinite(snapshot.getTime()) || snapshot.toISOString().slice(0, 10) !== asOf) throw new TypeError("invalid price snapshot date");
  if (!Number.isFinite(current.getTime()) || current.toISOString().slice(0, 10) !== today) throw new TypeError("invalid current date");
  const age = Math.floor((current.getTime() - snapshot.getTime()) / DAY_MS);
  if (age < 0) return { status: "future-date-advisory", ageDays: null };
  if (age > staleAfterDays) return { status: "stale-advisory", ageDays: age };
  return { status: "current", ageDays: age };
}

function validateReportEnvelope(input) {
  const issues = [];
  checkAllowedKeys(input, EXPECTED_OUTPUT_KEYS, "input", issues);
  if (!isRecord(input)) return issues;
  if (Object.hasOwn(input, "rateFreshness")) {
    checkAllowedKeys(input.rateFreshness, ["status", "ageDays"], "input.rateFreshness", issues);
  }
  if (Object.hasOwn(input, "costEstimate")) {
    checkAllowedKeys(input.costEstimate, [
      "currency", "databaseRunningHours", "primary", "ledger", "cloudSqlComputeUsd",
      "cloudSqlAllocatedSsdUsd", "knownConfiguredCloudSqlUsd", "roundedKnownConfiguredCloudSqlUsd", "totalCloudBillUsd",
    ], "input.costEstimate", issues);
    for (const name of ["primary", "ledger"]) {
      if (isRecord(input.costEstimate)) checkAllowedKeys(input.costEstimate[name], ["tier", "computeUsd", "storageUsd", "subtotalUsd"], `input.costEstimate.${name}`, issues);
    }
  }
  if (Object.hasOwn(input, "assessment")) {
    checkAllowedKeys(input.assessment, ["valid", "issues", "drift", "embeddedEstimate"], "input.assessment", issues);
    if (isRecord(input.assessment)) {
      if (Object.hasOwn(input.assessment, "issues")) {
        if (!Array.isArray(input.assessment.issues)) {
          issues.push({ code: "array_required", path: "input.assessment.issues" });
        } else {
          for (const issue of input.assessment.issues) {
            checkAllowedKeys(issue, ["code", "path"], "input.assessment.issues[]", issues);
          }
        }
      }
      if (Object.hasOwn(input.assessment, "drift") && (!Array.isArray(input.assessment.drift) || input.assessment.drift.some((item) => typeof item !== "string"))) {
        issues.push({ code: "string_array_required", path: "input.assessment.drift" });
      }
      if (Object.hasOwn(input.assessment, "valid") && typeof input.assessment.valid !== "boolean") {
        issues.push({ code: "boolean_required", path: "input.assessment.valid" });
      }
      if (Object.hasOwn(input.assessment, "embeddedEstimate") && !["matches", "recomputed", "not-provided"].includes(input.assessment.embeddedEstimate)) {
        issues.push({ code: "estimate_status_invalid", path: "input.assessment.embeddedEstimate" });
      }
    }
  }
  return issues;
}

export function createCostProfileReport(profile = GCP_COST_PROFILE, { today } = {}) {
  const validation = validateGcpCostProfile(profile);
  const safeProfile = validation.valid ? clone(profile) : clone(GCP_COST_PROFILE);
  return {
    ...safeProfile,
    rateFreshness: getPriceFreshness(GCP_COST_PROFILE.priceSnapshot.asOf, today, GCP_COST_PROFILE.priceSnapshot.staleAfterDays),
    costEstimate: validation.valid ? calculateMonthlyCostEstimate(profile) : null,
    assessment: validation,
  };
}

export function inspectCostProfileDocument(input, { today } = {}) {
  const envelopeIssues = validateReportEnvelope(input);
  const candidate = isRecord(input)
    ? Object.fromEntries(ROOT_KEYS.filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]))
    : input;
  const validation = validateGcpCostProfile(candidate);
  const issues = [...envelopeIssues, ...validation.issues];
  const valid = issues.length === 0;
  const costEstimate = valid ? calculateMonthlyCostEstimate(candidate) : null;
  const embeddedEstimate = !input?.costEstimate
    ? "not-provided"
    : sameValue(input.costEstimate, costEstimate) ? "matches" : "recomputed";
  return {
    ...((valid ? clone(candidate) : clone(GCP_COST_PROFILE))),
    rateFreshness: getPriceFreshness(GCP_COST_PROFILE.priceSnapshot.asOf, today, GCP_COST_PROFILE.priceSnapshot.staleAfterDays),
    costEstimate,
    assessment: {
      valid,
      issues,
      drift: valid ? validation.drift : [],
      embeddedEstimate,
    },
  };
}

export function formatCostProfileReport(report) {
  const estimated = report.costEstimate;
  const primary = estimated ? `$${estimated.primary.subtotalUsd.toFixed(2)}` : "unavailable";
  const ledger = estimated ? `$${estimated.ledger.subtotalUsd.toFixed(2)}` : "unavailable";
  const total = estimated ? `$${estimated.roundedKnownConfiguredCloudSqlUsd.toFixed(2)}` : "unavailable";
  const stale = report.rateFreshness.status === "stale-advisory"
    ? ` Advisory: snapshot is ${report.rateFreshness.ageDays} days old; refresh rates.`
    : report.rateFreshness.status === "future-date-advisory"
      ? " Advisory: snapshot date is in the future; check the clock and provenance."
      : "";
  return [
    `GCP cost/config profile (${report.region})`,
    `Published rates: ${report.priceSnapshot.asOf}; verified ${report.priceSnapshot.verifiedAt}.${stale}`,
    `Primary ${report.resources.databases.primary.tier}: ${primary}/month; independent ledger ${report.resources.databases.ledger.tier}: ${ledger}/month.`,
    `Known Cloud SQL compute + 10 GiB SSD per instance: ${total}/month for ${estimated?.databaseRunningHours ?? "the configured"} running hours. Not a total bill or budget cap.`,
    `Cloud Run: 0–${report.resources.cloudRun.service.maxInstances} instances, request billing, scale-to-zero, 1 vCPU/1 GiB, concurrency 8. Request and hourly job cost is workload-dependent and unknown, not zero.`,
    `Unpriced categories: ${report.unpricedAllowances.map((item) => item.code).join(", ")}.`,
    `Validation: ${report.assessment.valid ? "within profile limits" : "failed"}${report.assessment.drift?.length ? `; drift: ${report.assessment.drift.join(", ")}` : ""}.`,
    ...(report.assessment.issues ?? []).map((issue) => `  ${issue.code} at ${issue.path}`),
  ].join("\n");
}

function usage() {
  return "Usage: node apps/worker/scripts/gcp-cost-profile.mjs [--json] [--input <profile.json>]\nOffline only. Save --json output and pass it back with --input to validate profile drift. No credentials, gcloud, provisioning, or apply path.";
}

async function main(args) {
  let json = false;
  let inputPath = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--json") json = true;
    else if (args[i] === "--help" || args[i] === "-h") {
      process.stdout.write(`${usage()}\n`);
      return 0;
    } else if (args[i] === "--input" && args[i + 1] && !args[i + 1].startsWith("--")) inputPath = args[++i];
    else if (args[i].startsWith("--input=") && args[i].length > 8) inputPath = args[i].slice(8);
    else throw new Error("unsupported or incomplete command-line option");
  }

  let report;
  if (inputPath) {
    let contents;
    try {
      contents = await readFile(path.resolve(inputPath), { encoding: "utf8", flag: "r" });
    } catch {
      throw new Error("could not read the supplied profile file");
    }
    if (Buffer.byteLength(contents, "utf8") > 64 * 1024) throw new Error("profile file exceeds the 64 KiB input limit");
    let input;
    try {
      input = JSON.parse(contents);
    } catch {
      throw new Error("supplied profile is not valid JSON");
    }
    report = inspectCostProfileDocument(input);
  } else {
    report = createCostProfileReport();
  }

  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${formatCostProfileReport(report)}\n`);
  return report.assessment.valid ? 0 : 1;
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
