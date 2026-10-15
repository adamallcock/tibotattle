import assert from "node:assert/strict";
import test from "node:test";
import {
  bundleExportNames,
  dryRunViolations,
  edgeModeCandidates,
  MAIN_MODULE_EXPORTS,
  wranglerEnvironment,
} from "./edge-mode-dry-run.mjs";

const RATE_LIMITS = Object.freeze([
  "CLIENT_ATTEMPT_RATE_LIMIT", "ENROLLMENT_RATE_LIMIT", "PUBLIC_READ_RATE_LIMIT", "RECOVERY_RATE_LIMIT",
  "UPLOAD_AUTHORIZATION_RATE_LIMIT", "UPLOAD_INGRESS_CLIENT_RATE_LIMIT", "UPLOAD_INGRESS_REQUEST_RATE_LIMIT",
  "UPLOAD_PRINCIPAL_RATE_LIMIT",
  "PUBLIC_PROBE_RATE_LIMIT", "PUBLIC_PROBE_CLIENT_RATE_LIMIT", "SPARKLE_APPCAST_GUARD_RATE_LIMIT",
]);

function passingResults() {
  const common = {
    main: "src/edge-entry.ts",
    ratelimits: [...RATE_LIMITS],
    durableObjects: ["UPLOAD_INGRESS_BUDGET"],
    exports: [...MAIN_MODULE_EXPORTS],
  };
  return [
    { ...common, mode: "worker", modeVar: "worker", d1: ["ANALYTICS_DB", "DELETION_LEDGER", "USAGE_MONITOR_DB"],
      r2: ["QUARANTINE", "SPARKLE_RELEASES"], crons: ["* * * * *"] },
    { ...common, mode: "fenced", modeVar: "fenced", d1: ["ANALYTICS_DB", "DELETION_LEDGER", "USAGE_MONITOR_DB"],
      r2: ["QUARANTINE", "SPARKLE_RELEASES"], crons: ["* * * * *"] },
    { ...common, mode: "gcp", modeVar: "gcp", d1: ["RELEASE_GUARD_DB"], r2: ["SPARKLE_RELEASES"], crons: [] },
  ];
}

test("the three candidates follow the overlay along worker -> fenced -> gcp", async () => {
  const candidates = await edgeModeCandidates();
  assert.deepEqual(Object.keys(candidates), ["worker", "fenced", "gcp"]);
  for (const [mode, config] of Object.entries(candidates)) {
    const production = config.env.production;
    assert.equal(production.main, "src/edge-entry.ts", mode);
    assert.equal(production.vars.EDGE_UPSTREAM_MODE, mode, mode);
    assert.deepEqual(production.ratelimits.map((limit) => limit.name).sort(), [...RATE_LIMITS].sort(), mode);
  }
  const bindings = (config) => (config.env.production.d1_databases ?? []).map((database) => database.binding).sort();
  assert.deepEqual(bindings(candidates.worker), ["ANALYTICS_DB", "DELETION_LEDGER", "USAGE_MONITOR_DB"]);
  assert.deepEqual(bindings(candidates.gcp), ["RELEASE_GUARD_DB"]);
  assert.deepEqual(candidates.gcp.env.production.triggers.crons, []);
});

test("the checked-in main is unchanged: only the typed overlay names the edge entry", async () => {
  const candidates = await edgeModeCandidates();
  for (const config of Object.values(candidates)) assert.equal(config.main, "src/cloudflare-entry.ts");
});

test("a passing result set has no violation", () => {
  assert.deepEqual(dryRunViolations(passingResults()), []);
});

test("each broken property is reported", () => {
  const cases = [
    [(results) => { results[0].main = "src/index.ts"; }, "worker: main src/index.ts"],
    [(results) => { results[1].modeVar = "worker"; }, "fenced: mode var worker"],
    [(results) => { results[0].exports = [...MAIN_MODULE_EXPORTS, "EDGE_CONSTANT"].sort(); },
      `worker: main-module exports ${[...MAIN_MODULE_EXPORTS, "EDGE_CONSTANT"].sort().join(",")}`],
    [(results) => { results[2].ratelimits = results[2].ratelimits.filter((name) => name !== "PUBLIC_READ_RATE_LIMIT"); },
      "gcp: an edge rate-limit binding is missing"],
    [(results) => { results[2].durableObjects = []; }, "gcp: the Durable Object binding is missing"],
    [(results) => { results[2].d1.push("USAGE_MONITOR_DB"); }, "gcp: a data binding survives"],
    [(results) => { results[2].r2 = []; }, "gcp: the release guard D1 or the Sparkle bucket is missing"],
    [(results) => { results[2].crons = ["* * * * *"]; }, "gcp: crons are not empty"],
    [(results) => { results[0].d1 = ["USAGE_MONITOR_DB"]; }, "worker: a data binding is missing"],
    [(results) => { results[1].d1.push("RELEASE_GUARD_DB"); }, "fenced: the release guard D1 is bound"],
    [(results) => { results.reverse(); }, "modes"],
  ];
  for (const [mutate, expected] of cases) {
    const results = passingResults();
    mutate(results);
    assert.ok(dryRunViolations(results).includes(expected), expected);
  }
});

test("every mode requires each operational rate-limit binding separately from the six edge purposes", () => {
  for (const index of [0, 1, 2]) {
    for (const name of ["PUBLIC_PROBE_RATE_LIMIT", "PUBLIC_PROBE_CLIENT_RATE_LIMIT", "SPARKLE_APPCAST_GUARD_RATE_LIMIT"]) {
      const results = passingResults();
      results[index].ratelimits = results[index].ratelimits.filter((binding) => binding !== name);
      assert.deepEqual(dryRunViolations(results), [`${results[index].mode}: an operational rate-limit binding is missing`], name);
    }
  }
});

test("wrangler runs with PATH and HOME only", () => {
  const env = wranglerEnvironment({
    PATH: "/bin", HOME: "/home/synthetic", CLOUDFLARE_API_TOKEN: "synthetic-token-not-real",
    CLOUDFLARE_ACCOUNT_ID: "0".repeat(32), WRANGLER_API_ENVIRONMENT: "staging",
  });
  assert.deepEqual(Object.keys(env).sort(), ["CI", "HOME", "PATH", "WRANGLER_SEND_METRICS"]);
  assert.equal(env.WRANGLER_SEND_METRICS, "false");
});

test("reads the bundle's final export clause", () => {
  assert.deepEqual(
    bundleExportNames("var a;\nexport {\n  b as default,\n  c,\n  d as handleRequest\n};\n//# sourceMappingURL=x.map\n"),
    ["c", "default", "handleRequest"],
  );
  assert.deepEqual(bundleExportNames("var a = 1;\n"), []);
});
