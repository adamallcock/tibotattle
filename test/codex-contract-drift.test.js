import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  CODEX_CONTRACT_LEDGER_VERSION,
  checkCodexContractDrift,
  compareBinaryPlanTypes,
  compareProductPlanRegistry,
  compareUpstreamPlanRegistry,
  inspectCodexBinaryContract,
  parseCodexContractArguments,
  parseKnownPlanSource,
  parsePlanTypeScript,
  planTypesSha256,
  validateCodexContractLedger,
} from "../scripts/check-codex-contract-drift.mjs";
import {
  TELEMETRY_PLAN_DISPLAY_NAMES,
  TELEMETRY_PLAN_TYPES,
} from "@app-usagemonitor/telemetry-contract";

const execFile = promisify(execFileCallback);
const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const LEDGER_FILE = resolve(REPOSITORY_ROOT, "config/codex-contract-ledger.json");
const SOURCE_FIXTURE = resolve(
  REPOSITORY_ROOT,
  "test/fixtures/codex-known-plan-auth.rs",
);
const PLAN_TYPE_FIXTURE = resolve(
  REPOSITORY_ROOT,
  "test/fixtures/codex-plan-type.ts",
);
const CHECKER_FILE = resolve(
  REPOSITORY_ROOT,
  "scripts/check-codex-contract-drift.mjs",
);

async function fixtureText(path) {
  return readFile(path, "utf8");
}

async function fixtureLedger() {
  return JSON.parse(await readFile(LEDGER_FILE, "utf8"));
}

test("checked-in Codex contract ledger is valid and matches the product registry", async () => {
  const ledger = validateCodexContractLedger(await fixtureLedger());
  assert.equal(ledger.schemaVersion, CODEX_CONTRACT_LEDGER_VERSION);
  assert.deepEqual(compareProductPlanRegistry(ledger), { issues: [], ok: true });
  assert.deepEqual(
    ledger.plans.map((plan) => plan.rawValue),
    TELEMETRY_PLAN_TYPES.filter((plan) => plan !== "unknown"),
  );
  assert.deepEqual(
    Object.fromEntries(ledger.plans.map((plan) => [plan.rawValue, plan.displayName])),
    TELEMETRY_PLAN_DISPLAY_NAMES,
  );
  assert.deepEqual(
    ledger.marketingSeats.map(({ id, displayName }) => [id, displayName]),
    [
      ["business-standard", "Standard"],
      ["business-premium", "Premium"],
    ],
  );
  const premium = ledger.seatMappings.find(
    (mapping) => mapping.id === "business-premium-candidate",
  );
  assert.equal(premium.marketingSeatId, "business-premium");
  assert.equal(premium.status, "unverified_candidate");
  assert.deepEqual(premium.mappingEvidence, []);
});

test("source fixture yields the current exhaustive raw/display plan pairs", async () => {
  const pairs = parseKnownPlanSource(await fixtureText(SOURCE_FIXTURE));
  assert.deepEqual(
    pairs.map(({ rawValue }) => rawValue),
    TELEMETRY_PLAN_TYPES.filter((plan) => plan !== "unknown"),
  );
  assert.deepEqual(
    Object.fromEntries(pairs.map(({ rawValue, displayName }) => [rawValue, displayName])),
    TELEMETRY_PLAN_DISPLAY_NAMES,
  );
});

test("upstream comparison names additions, display renames, and active removals", async () => {
  const ledger = validateCodexContractLedger(await fixtureLedger());
  const pairs = parseKnownPlanSource(await fixtureText(SOURCE_FIXTURE));
  const changed = pairs
    .filter((plan) => plan.rawValue !== "go")
    .map((plan) => plan.rawValue === "plus"
      ? { ...plan, displayName: "Plus Renamed" }
      : plan)
    .concat({
      displayName: "Future Plan",
      rawValue: "future_plan",
      variant: "FuturePlan",
    });
  const result = compareUpstreamPlanRegistry(ledger, changed);
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.issues.map((entry) => entry.code).sort(),
    [
      "upstream_active_plan_removed",
      "upstream_display_name_changed",
      "upstream_plan_added",
    ],
  );
});

test("deprecated historical values may disappear without weakening telemetry acceptance", async () => {
  const ledger = structuredClone(validateCodexContractLedger(await fixtureLedger()));
  const go = ledger.plans.find((plan) => plan.rawValue === "go");
  go.lifecycle = "deprecated";
  go.deprecatedOn = "2026-08-26";
  validateCodexContractLedger(ledger);
  const pairs = parseKnownPlanSource(await fixtureText(SOURCE_FIXTURE))
    .filter((plan) => plan.rawValue !== "go");
  assert.deepEqual(compareUpstreamPlanRegistry(ledger, pairs), {
    issues: [],
    ok: true,
    warnings: [],
  });
  assert.equal(TELEMETRY_PLAN_TYPES.includes("go"), true);
});

test("generated PlanType parser accepts only a literal union", async () => {
  const parsed = parsePlanTypeScript(await fixtureText(PLAN_TYPE_FIXTURE));
  assert.deepEqual(parsed, TELEMETRY_PLAN_TYPES);
  assert.throws(
    () => parsePlanTypeScript("export type PlanType = string;\n"),
    { code: "CODEX_SCHEMA_INVALID" },
  );
  assert.throws(
    () => parsePlanTypeScript('export type PlanType = "plus" | FuturePlan;\n'),
    { code: "CODEX_SCHEMA_INVALID" },
  );
  assert.throws(
    () => parsePlanTypeScript('export type PlanType = "plus" | "plus";\n'),
    { code: "CODEX_SCHEMA_INVALID" },
  );
});

test("released binary comparison fails closed on a new plan or missing sentinel", () => {
  assert.deepEqual(compareBinaryPlanTypes(TELEMETRY_PLAN_TYPES), {
    issues: [],
    ok: true,
  });
  const future = compareBinaryPlanTypes([...TELEMETRY_PLAN_TYPES, "future_plan"]);
  assert.equal(future.ok, false);
  assert.equal(future.issues[0].code, "binary_plan_types_unsupported");
  const noUnknown = compareBinaryPlanTypes(
    TELEMETRY_PLAN_TYPES.filter((plan) => plan !== "unknown"),
  );
  assert.equal(noUnknown.ok, false);
  assert.equal(noUnknown.issues[0].code, "binary_unknown_sentinel_missing");
});

test("binary inspector supports stable generation and the older experimental fallback", async () => {
  const fixture = await fixtureText(PLAN_TYPE_FIXTURE);
  const stableCalls = [];
  const stable = await inspectCodexBinaryContract({
    binaryPath: "/private/not-reported/codex",
    channel: "fixture_stable",
    execute: async (_binary, args) => {
      stableCalls.push(args);
      if (args[0] === "--version") return { stderr: "", stdout: "codex-cli 1.2.3\n" };
      const output = args[args.indexOf("--out") + 1];
      await writeFile(join(output, "PlanType.ts"), fixture, "utf8");
      return { stderr: "", stdout: "" };
    },
  });
  assert.equal(stable.generatorMode, "stable");
  assert.equal(stable.version, "codex-cli 1.2.3");
  assert.equal(stable.planTypesSha256, planTypesSha256(TELEMETRY_PLAN_TYPES));
  assert.equal(stableCalls.some((args) => args.includes("--experimental")), false);

  const fallback = await inspectCodexBinaryContract({
    binaryPath: "/private/not-reported/codex",
    channel: "fixture_fallback",
    execute: async (_binary, args) => {
      if (args[0] === "--version") return { stderr: "", stdout: "codex-cli 1.2.2\n" };
      if (!args.includes("--experimental")) throw new Error("legacy flag required");
      const output = args[args.indexOf("--out") + 1];
      await writeFile(join(output, "PlanType.ts"), fixture, "utf8");
      return { stderr: "", stdout: "" };
    },
  });
  assert.equal(fallback.generatorMode, "experimental_compatibility");
});

test("machine report is path-free even when an explicit binary path is private", async () => {
  const checked = await checkCodexContractDrift({
    binaries: [{
      binaryPath: "/Users/example/private/Codex.app/Contents/Resources/codex",
      channel: "fixture",
    }],
    inspectBinary: async ({ channel }) => ({
      channel,
      generatorMode: "stable",
      planTypes: TELEMETRY_PLAN_TYPES,
      planTypesSha256: planTypesSha256(TELEMETRY_PLAN_TYPES),
      version: "codex-cli 1.2.3",
    }),
  });
  assert.equal(checked.result.ok, true);
  const serialized = JSON.stringify(checked.result);
  assert.doesNotMatch(serialized, /Users\/example/u);
  assert.doesNotMatch(serialized, /Contents\/Resources/u);
  assert.match(serialized, /"channel":"fixture"/u);
});

test("same-version recorded contract mutation is a release failure", async () => {
  const ledger = await fixtureLedger();
  ledger.verifiedContracts.push({
    channel: "standalone_latest",
    version: "codex-cli 9.9.9",
    verifiedOn: "2026-08-26",
    planTypesSha256: "0".repeat(64),
  });
  const root = await mkdtemp(join(tmpdir(), "codex-contract-recorded-test-"));
  const ledgerFile = join(root, "ledger.json");
  await writeFile(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  try {
    const checked = await checkCodexContractDrift({
      binaries: [{ binaryPath: "/not/reported", channel: "standalone_latest" }],
      inspectBinary: async ({ channel }) => ({
        channel,
        generatorMode: "stable",
        planTypes: TELEMETRY_PLAN_TYPES,
        planTypesSha256: planTypesSha256(TELEMETRY_PLAN_TYPES),
        version: "codex-cli 9.9.9",
      }),
      ledgerFile,
    });
    assert.equal(checked.result.ok, false);
    assert.equal(
      checked.result.issues.some(
        (entry) => entry.code === "binary_recorded_contract_mismatch",
      ),
      true,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("explicit update advances provenance only after a clean semantic comparison", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-contract-update-test-"));
  const ledgerFile = join(root, "ledger.json");
  const reportFile = join(root, "report.json");
  await writeFile(
    ledgerFile,
    `${JSON.stringify(await fixtureLedger(), null, 2)}\n`,
    "utf8",
  );
  try {
    const revision = "a".repeat(40);
    const result = await execFile(process.execPath, [
      CHECKER_FILE,
      "--ledger", ledgerFile,
      "--source-file", SOURCE_FIXTURE,
      "--source-revision", revision,
      "--report", reportFile,
      "--update-ledger",
    ], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
    assert.match(result.stdout, /Codex contract check: PASS/u);
    const updated = validateCodexContractLedger(
      JSON.parse(await readFile(ledgerFile, "utf8")),
    );
    assert.equal(updated.source.reviewedRevision, revision);
    assert.equal(updated.source.sourceSha256.length, 64);
    const report = JSON.parse(await readFile(reportFile, "utf8"));
    assert.equal(report.ok, true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("argument parser requires explicit channel-qualified binaries and source revisions", () => {
  assert.deepEqual(
    parseCodexContractArguments(["--binary", "standalone_latest=/tmp/codex"])
      .binaries,
    [{ binaryPath: "/tmp/codex", channel: "standalone_latest" }],
  );
  assert.throws(
    () => parseCodexContractArguments(["--binary", "/tmp/codex"]),
    { code: "CODEX_CONTRACT_ARGUMENT_INVALID" },
  );
  assert.throws(
    () => parseCodexContractArguments(["--source-revision", "a".repeat(40)]),
    { code: "CODEX_CONTRACT_ARGUMENT_INVALID" },
  );
});
