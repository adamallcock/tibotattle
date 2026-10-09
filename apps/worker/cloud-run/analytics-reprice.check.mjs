/** Content-free synthetic CLI checks. No database, provider, or credential calls. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ANALYTICS_REFRESH_USAGE } from "./analytics-refresh.mjs";
import {
  ANALYTICS_REPRICE_LIMITS, ANALYTICS_REPRICE_REFUSALS, ANALYTICS_REPRICE_USAGE,
  analyticsRepriceFailureReceipt, parseAnalyticsRepriceArguments, runAnalyticsReprice,
} from "./analytics-reprice.mjs";

const HASH = "a".repeat(64), REGISTRY = "b".repeat(64);
const RUN = "12345678-1234-4234-8234-123456789abc";
const ARGS = ["--mode=plan", "--schema=synthetic_reprice", "--from-day=2026-01-01",
  "--through-day=2026-01-02", "--max-days=2", "--max-members=4", "--max-input-bytes=1024"];
const EXECUTE = ["--mode=execute", ...ARGS.slice(1), `--run-id=${RUN}`, `--expected-plan-sha256=${HASH}`];
const LOCAL = { PG_TEST_HOST: "127.0.0.1", PG_TEST_PORT: "55433" };
const PRODUCTION = { ANALYTICS_REFRESH_TARGET: "production", CLOUD_RUN_JOB: "analytics-production",
  CLOUD_RUN_TASK_INDEX: "0", CLOUD_RUN_TASK_COUNT: "1", PRIMARY_SCHEMA: "primary",
  PRIMARY_INSTANCE_CONNECTION_NAME: "example-project:europe-west2:primary",
  PRIMARY_DATABASE: "primary", POSTGRES_IAM_USER: "operator@example-project.iam.gserviceaccount.com",
  ANALYTICS_V2_MEMORY_BUDGET_MIB: "10752" };
const stamp = { kernel: { kernelId: 13, priceRegistrySha256: REGISTRY }, manifestVersion: 1 };
const refusals = () => Object.fromEntries(ANALYTICS_REPRICE_REFUSALS.map(key => [key, 0]));
function planResult() {
  return { schema: "analytics-v2-reprice-plan-v1", status: "planned", planSha256: HASH,
    counts: { heads: 2, members: 4, inputBytes: 500 }, caps: { heads: false, members: false, inputBytes: false },
    target: { kernelId: 13, manifestVersion: 1, registrySha256: REGISTRY, pricingMethodVersion: "v0.5" } };
}
function executionResult() {
  return { schema: "analytics-v2-reprice-execution-v1", status: "complete", planSha256: HASH,
    counts: { planned: 2, changed: 1, equivalent: 1, unchanged: 0, refused: 0, contributionVersions: 4 },
    refusals: refusals(), replayed: false };
}
function fixture({ plan = async () => planResult(), execute = async () => executionResult(),
  close = async () => {}, contract = {}, store = {} } = {}) {
  const calls = [], pool = { synthetic: true }, connector = { synthetic: true };
  const modules = { reprice: {
    async planAnalyticsV2Reprice(actual, options) { assert.equal(actual, pool); calls.push(["plan", options]); return plan(options); },
    async executeAnalyticsV2Reprice(actual, options) { assert.equal(actual, pool); calls.push(["execute", options]); return execute(options); },
  }, contract: { ANALYTICS_V2_REPRICE_LIMITS: { ...ANALYTICS_REPRICE_LIMITS },
    validAnalyticsV2RepriceBounds: bounds => bounds, ...contract },
  store: { resolveAnalyticsV2Kernel: () => stamp.kernel, analyticsV2BundledKernelIdentity: () => ({}),
    analyticsV2BaselineRunStamp: () => stamp, analyticsV2BundledPricer: () => ({ pricingMethodVersion: "v0.5" }), ...store } };
  return { calls, modules, run: (argv = ARGS, env = LOCAL) => runAnalyticsReprice({ argv, env,
    dependencies: { modules, wallClock: () => Date.parse("2026-10-09T12:00:00Z"),
      createConnector() { calls.push(["connector"]); return connector; },
      async createPool(database, options) { calls.push(["pool", database, options]); return pool; },
      async closeResources(resources) { calls.push(["close", resources]); await close(resources); },
    } }) };
}
const rejectsCode = code => error => {
  assert.equal(error.code, code);
  assert.doesNotMatch(JSON.stringify(analyticsRepriceFailureReceipt(error)), /sentinel|SELECT|owner|stack|detail|password|\/private\//u);
  return true;
};

test("arguments require an explicit mode, range and every bound; help is standalone", () => {
  assert.deepEqual(parseAnalyticsRepriceArguments(["--help"]), { help: true });
  assert.equal(parseAnalyticsRepriceArguments(ARGS).mode, "plan");
  for (const argv of [[], ["--help", "--mode=execute"], ["-h"], null, [1],
    ...ARGS.map((_, index) => ARGS.filter((__, i) => i !== index)),
    [...ARGS, "--mode=execute"], [...ARGS, "--retry=1"], [...ARGS, "--password=sentinel"]]) {
    assert.throws(() => parseAnalyticsRepriceArguments(argv), rejectsCode("ANALYTICS_V2_REPRICE_ARGUMENT_INVALID"));
  }
});
test("bounds and calendar days fail closed without numeric coercion or rollover", () => {
  for (const [prefix, values] of [
    ["max-days", ["0", "33", "02", "1e1", "Infinity"]],
    ["max-members", ["1001", "-1", "1.5"]], ["max-input-bytes", ["16777217", "9007199254740993", ""]],
    ["from-day", ["2026-02-30", "2026-1-01", "2026-01-03"]],
    ["through-day", ["2025-12-31", "2026-13-01"]], ["schema", ["pg_catalog", "information_schema", "primary;SELECT"]],
  ]) for (const value of values) {
    assert.throws(() => parseAnalyticsRepriceArguments(ARGS.map(arg => arg.startsWith(`--${prefix}=`) ? `--${prefix}=${value}` : arg)),
      rejectsCode("ANALYTICS_V2_REPRICE_ARGUMENT_INVALID"));
  }
});
test("execute requires exact run UUID and plan hash; plan cannot carry execution authorization", () => {
  assert.equal(parseAnalyticsRepriceArguments(EXECUTE).runId, RUN);
  for (const argv of [EXECUTE.slice(0, -1), EXECUTE.filter(arg => !arg.startsWith("--run-id=")),
    EXECUTE.map(arg => arg.startsWith("--run-id=") ? "--run-id=sentinel" : arg),
    EXECUTE.map(arg => arg.startsWith("--expected-plan-sha256=") ? `--expected-plan-sha256=${HASH.toUpperCase()}` : arg),
    [...ARGS, `--run-id=${RUN}`], [...ARGS, `--expected-plan-sha256=${HASH}`]]) {
    assert.throws(() => parseAnalyticsRepriceArguments(argv), rejectsCode("ANALYTICS_V2_REPRICE_ARGUMENT_INVALID"));
  }
});
test("production refuses schema and clock overrides; local clock requires the maintained guard", () => {
  for (const arg of ["--schema=primary", "--now=2026-01-01T00:00:00Z"]) {
    assert.throws(() => parseAnalyticsRepriceArguments([...ARGS.filter(a => !a.startsWith("--schema=")), arg], PRODUCTION),
      rejectsCode("ANALYTICS_V2_REPRICE_ARGUMENT_FORBIDDEN"));
  }
  assert.throws(() => parseAnalyticsRepriceArguments([...ARGS, "--now=2026-01-01T00:00:00Z"]), rejectsCode("ANALYTICS_V2_TEST_CLOCK_FORBIDDEN"));
  const env = { ...LOCAL, ANALYTICS_V2_TEST_CLOCK: "1" };
  for (const now of ["2026-02-30T00:00:00Z", "2026-01-01", "2026-01-01T24:00:00Z", "2026-01-01T00:00:00+00:00", "1969-12-31T23:59:59Z"]) {
    assert.throws(() => parseAnalyticsRepriceArguments([...ARGS, `--now=${now}`], env), rejectsCode("ANALYTICS_V2_REPRICE_ARGUMENT_INVALID"));
  }
});
test("plan calls only the read-only API and emits a closed detached receipt", async () => {
  const result = planResult(), f = fixture({ plan: async () => result });
  const receipt = await f.run();
  assert.deepEqual(f.calls.map(call => call[0]), ["pool", "plan", "close"]);
  assert.deepEqual(f.calls[1][1], { schema: "synthetic_reprice", bounds: parseAnalyticsRepriceArguments(ARGS).bounds, stamp });
  assert.deepEqual(Object.keys(receipt).sort(), ["clock", "kernel", "mode", "now", "result", "schemaVersion", "status", "target"]);
  assert.equal(receipt.result.status, "planned");
  result.counts.heads = 0;
  assert.equal(receipt.result.counts.heads, 2);
  assert.doesNotMatch(JSON.stringify(receipt), /synthetic_reprice|example-project|password|SELECT|ownerDigest/u);
});
test("execute forwards exactly reviewed authorization, bounds, stamp and guarded clock once", async () => {
  const f = fixture();
  const receipt = await f.run([...EXECUTE, "--now=2026-01-01T00:00:00Z"], { ...LOCAL, ANALYTICS_V2_TEST_CLOCK: "1" });
  assert.deepEqual(f.calls.map(call => call[0]), ["pool", "execute", "close"]);
  assert.deepEqual(f.calls[1][1], { schema: "synthetic_reprice", bounds: parseAnalyticsRepriceArguments(ARGS).bounds,
    stamp, runId: RUN, expectedPlanSha256: HASH, nowMs: Date.parse("2026-01-01T00:00:00Z") });
  assert.equal(receipt.clock, "test");
  assert.equal(receipt.result.status, "complete");
});
test("production reuses protected IAM configuration with no new credential seam", async () => {
  const f = fixture();
  const receipt = await f.run(ARGS.filter(arg => !arg.startsWith("--schema=")), PRODUCTION);
  assert.equal(receipt.target, "production");
  assert.deepEqual(f.calls.map(call => call[0]), ["connector", "pool", "plan", "close"]);
  assert.equal(f.calls[1][1].kind, "cloud-sql");
  assert.equal(f.calls[1][1].iamUser, "operator@example-project.iam");
  assert.equal(f.calls[2][1].schema, "primary");
  assert.doesNotMatch(JSON.stringify(receipt), /example-project|operator|instanceConnectionName/u);
});
test("unsafe environment/context/remote targets fail before a connection", async () => {
  for (const env of [{ ...LOCAL, PG_TEST_HOST: "remote.invalid" },
    { ...PRODUCTION, GOOGLE_APPLICATION_CREDENTIALS: "/private/sentinel" },
    { ...PRODUCTION, NODE_OPTIONS: "--require=sentinel" }, { ...PRODUCTION, CLOUD_RUN_TASK_COUNT: "2" },
    { ...PRODUCTION, PGOPTIONS: "sentinel" }]) {
    const f = fixture();
    await assert.rejects(f.run(ARGS.filter(arg => !arg.startsWith("--schema=")), { PRIMARY_SCHEMA: "synthetic_reprice", ...env }));
    assert.deepEqual(f.calls.map(call => call[0]), ["close"]);
  }
});
test("unregistered kernel and drifting domain caps fail before connection", async () => {
  for (const options of [{ store: { resolveAnalyticsV2Kernel() { throw new Error("sentinel"); } } },
    { contract: { ANALYTICS_V2_REPRICE_LIMITS: { ...ANALYTICS_REPRICE_LIMITS, members: 2000 } } }]) {
    const f = fixture(options);
    await assert.rejects(f.run());
    assert.deepEqual(f.calls.map(call => call[0]), ["close"]);
  }
});
test("plan refuses raw fields, malformed counts, wrong target and exceeding reviewed caps", async () => {
  for (const mutate of [result => { result.ownerDigest = "sentinel"; }, result => { result.counts.heads = "2"; },
    result => { result.counts.members = 5; }, result => { result.target.kernelId = 12; },
    result => { result.target.registrySha256 = HASH; }, result => { result.target.pricingMethodVersion = "sentinel with private spaces"; },
    result => { result.target.pricingMethodVersion = "v0.6"; }, result => { result.caps.inputBytes = 1; }]) {
    const result = planResult(); mutate(result);
    const f = fixture({ plan: async () => result });
    await assert.rejects(f.run(), rejectsCode("ANALYTICS_V2_REPRICE_RECEIPT_INVALID"));
    assert.equal(f.calls.at(-1)[0], "close");
  }
});
test("a capped read-only plan remains explicitly capped without claiming execution", async () => {
  const result = planResult(); result.caps.inputBytes = true; result.counts.inputBytes = 1024;
  const f = fixture({ plan: async () => result });
  const receipt = await f.run();
  assert.equal(receipt.result.caps.inputBytes, true);
  assert.deepEqual(f.calls.map(call => call[0]), ["pool", "plan", "close"]);
});
test("execute validates exact plan binding and outcome/refusal partitions", async () => {
  for (const mutate of [result => { result.planSha256 = REGISTRY; }, result => { result.replayed = "yes"; },
    result => { result.counts.changed = 3; }, result => { result.refusals.owner_set_unavailable = 1; },
    result => { result.refusals.ownerDigest = 0; }, result => { result.counts.refused = -1; },
    result => { result.counts.contributionVersions = 5; }]) {
    const result = executionResult(); mutate(result);
    await assert.rejects(fixture({ execute: async () => result }).run(EXECUTE), rejectsCode("ANALYTICS_V2_REPRICE_RECEIPT_INVALID"));
  }
  const result = executionResult(); result.replayed = true;
  assert.equal((await fixture({ execute: async () => result }).run(EXECUTE)).result.replayed, true);
});
test("domain refusal is preserved, raw driver failures are closed, and neither retries", async () => {
  for (const code of ["ANALYTICS_V2_REPRICE_PLAN_CHANGED", "ANALYTICS_V2_REPRICE_SCHEMA_UNAVAILABLE", "private_owner_sentinel", "57014"]) {
    const f = fixture({ execute: async () => { throw Object.assign(new Error("SELECT sentinel password"), { code, detail: "sentinel" }); } });
    await assert.rejects(f.run(EXECUTE), rejectsCode(code.startsWith("ANALYTICS_V2_REPRICE_") ? code : "ANALYTICS_V2_REPRICE_FAILED"));
    assert.deepEqual(f.calls.map(call => call[0]), ["pool", "execute", "close"]);
  }
});
test("cleanup failure refuses success and preserves an earlier operation refusal", async () => {
  const close = async () => { throw new Error("POSTGRES_POOL_CLOSE_FAILED"); };
  await assert.rejects(fixture({ close }).run(), rejectsCode("POSTGRES_POOL_CLOSE_FAILED"));
  await assert.rejects(fixture({ close, execute: async () => { throw Object.assign(new Error("sentinel"), { code: "ANALYTICS_V2_REPRICE_PLAN_CHANGED" }); } }).run(EXECUTE),
    rejectsCode("ANALYTICS_V2_REPRICE_PLAN_CHANGED"));
});
test("native source help/refusal is content-free and requires no TypeScript or database execution", () => {
  const file = new URL("./analytics-reprice.mjs", import.meta.url);
  const help = spawnSync(process.execPath, [file.pathname, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0); assert.equal(help.stdout, ANALYTICS_REPRICE_USAGE); assert.equal(help.stderr, "");
  const invalid = spawnSync(process.execPath, [file.pathname, "--mode=execute"], { encoding: "utf8" });
  assert.equal(invalid.status, 2); assert.equal(invalid.stdout, "");
  assert.deepEqual(JSON.parse(invalid.stderr), { schemaVersion: "analytics-reprice-receipt-v1", status: "failed", code: "ANALYTICS_V2_REPRICE_ARGUMENT_INVALID" });
  const refresh = spawnSync(process.execPath, [new URL("./analytics-refresh.mjs", import.meta.url).pathname, "--help"], { encoding: "utf8" });
  assert.equal(refresh.status, 0); assert.equal(refresh.stdout, ANALYTICS_REFRESH_USAGE); assert.equal(refresh.stderr, "");
});
