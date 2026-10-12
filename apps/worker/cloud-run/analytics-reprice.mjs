#!/usr/bin/env node

/**
 * Bounded saved-cohort repricing Job. --mode=plan reads only; --mode=execute
 * requires the reviewed plan hash and a run UUID. There is no default mode,
 * retry, schema migration, HTTP endpoint, or credential override. Production
 * uses the refresh Job's closed environment, IAM connection and real clock.
 * Literal TypeScript imports are bundled into dist/analytics-reprice.mjs.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connector } from "@google-cloud/cloud-sql-connector";
import pg from "pg";
import { closeCloudSqlResources, createIamPool } from "./cloud-sql.mjs";
import {
  analyticsRefreshProductionTargetRequested, analyticsRefreshRunStamp,
  analyticsRefreshTestClockAllowed, resolveAnalyticsRefreshDatabase,
} from "./analytics-refresh.mjs";

export const ANALYTICS_REPRICE_ENTRY = "analytics-reprice";
export const ANALYTICS_REPRICE_RECEIPT_VERSION = "analytics-reprice-receipt-v1";
export const ANALYTICS_REPRICE_POOL_MAX = 2;
/** Mirror the domain's hard caps; run-time equality is checked before connecting. */
export const ANALYTICS_REPRICE_LIMITS = Object.freeze({ days: 32, members: 1_000,
  inputBytes: 16 * 1024 * 1024, events: 500_000 });
export const ANALYTICS_REPRICE_REFUSALS = Object.freeze([
  "owner_set_unavailable", "member_link_unavailable", "price_inputs_unavailable",
  "price_input_association_unproven", "price_inputs_corrupt", "contribution_invalid",
  "reprice_membership_or_evidence_drift",
]);
export const ANALYTICS_REPRICE_USAGE = `Usage: node analytics-reprice.mjs --mode=<plan|execute>
  --from-day=YYYY-MM-DD --through-day=YYYY-MM-DD
  --max-days=<1..32> --max-members=<1..1000> --max-input-bytes=<1..16777216>

Execute also requires --run-id=<UUID> --expected-plan-sha256=<64 lowercase hex>.
Local synthetic targets may use --schema=<identifier> and --now=<ISO instant>
under the existing test-clock guard. Production uses PRIMARY_SCHEMA and the
real clock. --help must be used alone. No automatic execution or retries.
`;
const FLAGS = new Set(["mode", "from-day", "through-day", "max-days", "max-members",
  "max-input-bytes", "run-id", "expected-plan-sha256", "schema", "now"]);
const SHA = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN = /^[A-Za-z0-9._:-]{1,64}$/u;
const PHASES = new Set(["configuration", "modules", "connection", "plan", "execute", "receipt", "cleanup"]);
const SAFE_CODES = new Set([
  "ANALYTICS_V2_REPRICE_ARGUMENT_INVALID", "ANALYTICS_V2_REPRICE_ARGUMENT_FORBIDDEN",
  "ANALYTICS_V2_REPRICE_INVALID", "ANALYTICS_V2_REPRICE_LIMIT", "ANALYTICS_V2_REPRICE_PLAN_CHANGED",
  "ANALYTICS_V2_REPRICE_WRITE_FAILED", "ANALYTICS_V2_REPRICE_SCHEMA_UNAVAILABLE",
  "ANALYTICS_V2_REPRICE_MODULES_UNAVAILABLE", "ANALYTICS_V2_REPRICE_RECEIPT_INVALID",
  "ANALYTICS_V2_REPRICE_FAILED", "ANALYTICS_V2_KERNEL_REGISTRY_INVALID", "ANALYTICS_V2_KERNEL_UNREGISTERED",
  "ANALYTICS_V2_REFRESH_ENV_FORBIDDEN", "ANALYTICS_V2_REFRESH_ENV_INVALID", "ANALYTICS_V2_REFRESH_ENV_MISSING",
  "ANALYTICS_V2_REFRESH_TARGET_INVALID", "ANALYTICS_V2_REFRESH_TARGET_FORBIDDEN",
  "ANALYTICS_V2_REFRESH_CONTEXT_INVALID", "ANALYTICS_V2_REFRESH_PLANE_MISMATCH",
  "ANALYTICS_V2_REFRESH_TEST_TARGET_FORBIDDEN", "ANALYTICS_V2_REFRESH_DATABASE_INVALID",
  "ANALYTICS_V2_REFRESH_DATABASE_UNCONFIGURED", "ANALYTICS_V2_TEST_CLOCK_FORBIDDEN",
  "CLOUD_SQL_CONNECTOR_OPTIONS_FAILED", "CLOUD_SQL_CONNECTOR_CLOSE_FAILED",
  "POSTGRES_CONNECTION_FAILED", "POSTGRES_POOL_CLOSE_FAILED",
]);
function fail(code, usage = false) { throw Object.assign(new Error(code), { code, usage }); }
function closed(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function count(value) { return Number.isSafeInteger(value) && value >= 0; }
function day(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function integer(text, max) {
  if (typeof text !== "string" || !/^[1-9][0-9]*$/u.test(text)
      || !Number.isSafeInteger(Number(text)) || Number(text) > max) {
    fail("ANALYTICS_V2_REPRICE_ARGUMENT_INVALID", true);
  }
  return Number(text);
}
export function parseAnalyticsRepriceArguments(argv, env = {}) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== "string")) fail("ANALYTICS_V2_REPRICE_ARGUMENT_INVALID", true);
  if (argv.length === 1 && argv[0] === "--help") return Object.freeze({ help: true });
  const flags = new Map();
  for (const argument of argv) {
    const match = /^--([a-z][a-z0-9-]*)=(.*)$/su.exec(argument);
    if (!match || !FLAGS.has(match[1]) || flags.has(match[1])) fail("ANALYTICS_V2_REPRICE_ARGUMENT_INVALID", true);
    flags.set(match[1], match[2]);
  }
  const mode = flags.get("mode");
  if (!["plan", "execute"].includes(mode)) fail("ANALYTICS_V2_REPRICE_ARGUMENT_INVALID", true);
  if (analyticsRefreshProductionTargetRequested(env) && (flags.has("schema") || flags.has("now"))) {
    fail("ANALYTICS_V2_REPRICE_ARGUMENT_FORBIDDEN", true);
  }
  const schema = flags.get("schema") ?? env.PRIMARY_SCHEMA;
  if (typeof schema !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(schema)
      || schema.startsWith("pg_") || schema === "information_schema") fail("ANALYTICS_V2_REPRICE_ARGUMENT_INVALID", true);
  const fromDay = flags.get("from-day"), throughDay = flags.get("through-day");
  if (!day(fromDay) || !day(throughDay) || fromDay > throughDay) fail("ANALYTICS_V2_REPRICE_ARGUMENT_INVALID", true);
  const bounds = Object.freeze({ fromDay, throughDay,
    maxDays: integer(flags.get("max-days"), ANALYTICS_REPRICE_LIMITS.days),
    maxMembers: integer(flags.get("max-members"), ANALYTICS_REPRICE_LIMITS.members),
    maxInputBytes: integer(flags.get("max-input-bytes"), ANALYTICS_REPRICE_LIMITS.inputBytes) });
  const runId = flags.get("run-id") ?? null, expectedPlanSha256 = flags.get("expected-plan-sha256") ?? null;
  if (mode === "execute" ? !UUID.test(runId ?? "") || !SHA.test(expectedPlanSha256 ?? "")
    : runId !== null || expectedPlanSha256 !== null) fail("ANALYTICS_V2_REPRICE_ARGUMENT_INVALID", true);
  let nowMs = null;
  if (flags.has("now")) {
    if (!analyticsRefreshTestClockAllowed(env)) fail("ANALYTICS_V2_TEST_CLOCK_FORBIDDEN", true);
    const text = flags.get("now");
    nowMs = Date.parse(text);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(text)
        || !Number.isSafeInteger(nowMs) || nowMs < 0 || new Date(nowMs).toISOString().slice(0, 19) !== text.slice(0, 19)) {
      fail("ANALYTICS_V2_REPRICE_ARGUMENT_INVALID", true);
    }
  }
  return Object.freeze({ help: false, mode, schema, bounds, runId, expectedPlanSha256, nowMs });
}
function figures(value, keys) { return closed(value, keys) && keys.every(key => count(value[key])); }
/** Reject unexpected fields rather than printing a domain/driver object wholesale. */
export function validateAnalyticsRepriceResult(result, { mode, bounds, stamp, pricingMethodVersion, expectedPlanSha256 }) {
  let valid;
  if (mode === "plan") {
    const keys = ["heads", "members", "inputBytes"];
    valid = closed(result, ["schema", "status", "planSha256", "counts", "caps", "target"])
      && result.schema === "analytics-v2-reprice-plan-v1" && result.status === "planned"
      && figures(result.counts, keys) && closed(result.caps, keys)
      && keys.every(key => typeof result.caps[key] === "boolean")
      && result.counts.heads <= bounds.maxDays && result.counts.members <= bounds.maxMembers
      && result.counts.inputBytes <= bounds.maxInputBytes
      && closed(result.target, ["kernelId", "manifestVersion", "registrySha256", "pricingMethodVersion"])
      && result.target.kernelId === stamp.kernel.kernelId && result.target.manifestVersion === stamp.manifestVersion
      && result.target.registrySha256 === stamp.kernel.priceRegistrySha256
      && result.target.pricingMethodVersion === pricingMethodVersion;
  } else {
    valid = closed(result, ["schema", "status", "planSha256", "counts", "refusals", "replayed"])
      && result.schema === "analytics-v2-reprice-execution-v1" && result.status === "complete"
      && figures(result.counts, ["planned", "changed", "equivalent", "unchanged", "refused", "contributionVersions"])
      && figures(result.refusals, ANALYTICS_REPRICE_REFUSALS) && typeof result.replayed === "boolean"
      && result.planSha256 === expectedPlanSha256 && result.counts.planned <= bounds.maxDays
      && result.counts.contributionVersions <= bounds.maxMembers
      && result.counts.changed + result.counts.equivalent + result.counts.unchanged + result.counts.refused === result.counts.planned
      && Object.values(result.refusals).reduce((sum, value) => sum + value, 0) === result.counts.refused;
  }
  if (!valid || typeof result.planSha256 !== "string" || !SHA.test(result.planSha256)) fail("ANALYTICS_V2_REPRICE_RECEIPT_INVALID");
  return structuredClone(result);
}
export async function loadAnalyticsRepriceModules() {
  const [reprice, contract, store] = await Promise.all([
    import("../src/analytics-v2/reprice-store.ts"), import("../src/analytics-v2/reprice.ts"), import("../src/analytics-v2/store.ts"),
  ]);
  return { reprice, contract, store };
}
async function defaultCreatePool(database, { connector }) {
  if (database.kind === "cloud-sql") return createIamPool({ connector,
    instanceConnectionName: database.instanceConnectionName, database: database.database, user: database.iamUser,
    max: ANALYTICS_REPRICE_POOL_MAX, applicationName: "tibotattle-analytics-reprice" });
  const pool = new pg.Pool({ host: database.host, port: database.port, user: database.user, database: database.database,
    ...(database.password === undefined ? {} : { password: database.password }), max: ANALYTICS_REPRICE_POOL_MAX,
    connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000, application_name: "tibotattle-analytics-reprice" });
  pool.on("error", () => {});
  return pool;
}
function safeCode(error) {
  try { return SAFE_CODES.has(error?.code) ? error.code : SAFE_CODES.has(error?.message) ? error.message : "ANALYTICS_V2_REPRICE_FAILED"; }
  catch { return "ANALYTICS_V2_REPRICE_FAILED"; }
}
export function analyticsRepriceFailureReceipt(error) {
  return { schemaVersion: ANALYTICS_REPRICE_RECEIPT_VERSION, status: "failed", code: safeCode(error),
    ...(PHASES.has(error?.phase) ? { phase: error.phase } : {}) };
}
export async function runAnalyticsReprice({ argv = process.argv.slice(2), env = process.env, dependencies = {} } = {}) {
  const parsed = parseAnalyticsRepriceArguments(argv, env);
  if (parsed.help) return { status: "help" };
  let phase = "configuration", pool, connector, failure, receipt;
  try {
    const database = await resolveAnalyticsRefreshDatabase(env, { schema: parsed.schema });
    const nowMs = parsed.nowMs ?? (dependencies.wallClock ?? Date.now)();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isFinite(new Date(nowMs).getTime())) fail("ANALYTICS_V2_REPRICE_INVALID");
    phase = "modules";
    const { reprice, contract, store } = dependencies.modules ?? await loadAnalyticsRepriceModules();
    if (typeof reprice?.planAnalyticsV2Reprice !== "function" || typeof reprice?.executeAnalyticsV2Reprice !== "function"
        || typeof contract?.validAnalyticsV2RepriceBounds !== "function"
        || !figures(contract.ANALYTICS_V2_REPRICE_LIMITS, Object.keys(ANALYTICS_REPRICE_LIMITS))
        || Object.keys(ANALYTICS_REPRICE_LIMITS).some(key => contract.ANALYTICS_V2_REPRICE_LIMITS[key] !== ANALYTICS_REPRICE_LIMITS[key])) {
      fail("ANALYTICS_V2_REPRICE_MODULES_UNAVAILABLE");
    }
    const bounds = contract.validAnalyticsV2RepriceBounds(parsed.bounds);
    const stamp = analyticsRefreshRunStamp(store, dependencies.kernelIdentity);
    const pricingMethodVersion = store.analyticsV2BundledPricer?.().pricingMethodVersion;
    if (typeof pricingMethodVersion !== "string" || !TOKEN.test(pricingMethodVersion)) fail("ANALYTICS_V2_REPRICE_MODULES_UNAVAILABLE");
    phase = "connection";
    if (database.kind === "cloud-sql") connector = (dependencies.createConnector ?? (() => new Connector()))();
    pool = await (dependencies.createPool ?? defaultCreatePool)(database, { connector });
    phase = parsed.mode;
    const options = { schema: parsed.schema, bounds, stamp };
    const result = parsed.mode === "plan" ? await reprice.planAnalyticsV2Reprice(pool, options)
      : await reprice.executeAnalyticsV2Reprice(pool, { ...options, runId: parsed.runId,
        expectedPlanSha256: parsed.expectedPlanSha256, nowMs });
    phase = "receipt";
    receipt = { schemaVersion: ANALYTICS_REPRICE_RECEIPT_VERSION, status: "ok", mode: parsed.mode,
      target: database.target ?? null, now: new Date(nowMs).toISOString(), clock: parsed.nowMs === null ? "wall" : "test",
      kernel: { kernelId: stamp.kernel.kernelId, manifestVersion: stamp.manifestVersion },
      result: validateAnalyticsRepriceResult(result, { ...parsed, bounds, stamp, pricingMethodVersion }) };
  } catch (error) { failure = Object.assign(new Error(safeCode(error)), { code: safeCode(error), phase }); }
  try { await (dependencies.closeResources ?? closeCloudSqlResources)({ pools: pool === undefined ? [] : [pool], connector }); }
  catch (error) { failure ??= Object.assign(new Error(safeCode(error)), { code: safeCode(error), phase: "cleanup" }); }
  if (failure) throw failure;
  return receipt;
}
async function main() {
  try {
    const receipt = await runAnalyticsReprice();
    process.stdout.write(receipt.status === "help" ? ANALYTICS_REPRICE_USAGE : `${JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(analyticsRepriceFailureReceipt(error))}\n`);
    process.exitCode = error?.usage === true ? 2 : 1;
  }
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
