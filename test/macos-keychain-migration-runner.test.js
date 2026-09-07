import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  inspectionPlan,
  main,
  matchesReviewedMigrationRequirement,
  parseArguments,
} from "./helpers/verify-signed-keychain-migration.mjs";

const SYNTHETIC_TEAM = "A1B2C3D4E5";

function syntheticRequirement(identifier) {
  return `identifier "${identifier}" and anchor apple generic `
    + "and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ "
    + "and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ "
    + `and certificate leaf[subject.OU] = "${SYNTHETIC_TEAM}"`;
}

test("signed probe accepts only equivalent quoted or bare reviewed identity tokens", () => {
  for (const identifier of ["node", "com.usagemonitor.local", "com.usagemonitor.migration-probe.wrong-parent"]) {
    const quoted = syntheticRequirement(identifier);
    const bare = quoted.replace(`identifier "${identifier}"`, `identifier ${identifier}`);
    for (const requirement of [quoted, bare, `  ${bare.replaceAll(" and ", "  and\t")}  `]) {
      assert.equal(matchesReviewedMigrationRequirement(requirement, identifier, SYNTHETIC_TEAM), true);
    }
    for (const altered of [
      quoted.replace(`identifier "${identifier}"`, `identifier "${identifier}.other"`),
      bare.replace(`identifier ${identifier} `, `identifier ${identifier}other `),
      `${bare} or true`, `${quoted} and true`,
      bare.replace("anchor apple generic", "anchor trusted"),
      bare.replace("1.2.840.113635.100.6.2.6", "1.2.840.113635.100.6.2.1"),
      bare.replace(SYNTHETIC_TEAM, "Z9Y8X7W6V5"),
      `certificate leaf[subject.OU] = "${SYNTHETIC_TEAM}"`,
    ]) assert.equal(matchesReviewedMigrationRequirement(altered, identifier, SYNTHETIC_TEAM), false);
  }
  assert.equal(matchesReviewedMigrationRequirement(syntheticRequirement("unreviewed"), "unreviewed", SYNTHETIC_TEAM), false);
});

test("signed synthetic migration requires one explicit execution mode and legacy app", () => {
  assert.deepEqual(parseArguments([]), { mode: "plan", legacyApp: null });
  assert.deepEqual(parseArguments(["--help"]), { mode: "plan", legacyApp: null });
  assert.deepEqual(parseArguments(["--compile-only"]), { mode: "compile", legacyApp: null });
  assert.deepEqual(parseArguments(["--run-signed", "--legacy-app", "/synthetic/Previous.app"]), {
    mode: "signed", legacyApp: "/synthetic/Previous.app",
  });
  for (const args of [
    ["--run-signed"], ["--run-signed", "--compile-only"], ["--compile-only", "--compile-only"],
    ["--help", "--run-signed"], ["--legacy-app"], ["--unrecognized"],
    ["--legacy-app", "--run-signed"],
    ["--compile-only", "--legacy-app", "/synthetic/Previous.app"],
    ["--legacy-app", "/first.app", "--legacy-app", "/second.app"],
  ]) assert.throws(() => parseArguments(args));
});

test("the imported default and path-only inspection are inert plans", async () => {
  assert.deepEqual(await main([]), inspectionPlan());
  const plan = await main(["--legacy-app", "/nonexistent/synthetic/Previous.app"]);
  assert.equal(plan.mode, "plan");
  assert.equal(plan.signingPerformed, false);
  assert.equal(plan.keychainAccessPerformed, false);
  assert.equal(plan.applicationLoginKeychainItemAccess, false);
  assert.equal(Object.hasOwn(plan, "fixtureDirectory"), false);
});

test("a signing label alone cannot opt the CLI into signing or Keychain access", async () => {
  const helper = fileURLToPath(new URL("./helpers/verify-signed-keychain-migration.mjs", import.meta.url));
  const result = await promisify(execFile)(process.execPath, [helper], {
    env: { ...process.env, TIBOTATTLE_MIGRATION_SIGNING_IDENTITY: "synthetic-unused-label" },
    timeout: 10_000,
    maxBuffer: 32_768,
  });
  assert.deepEqual(JSON.parse(result.stdout), inspectionPlan());
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes("synthetic-unused-label"), false);
});
