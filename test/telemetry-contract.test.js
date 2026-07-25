import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandAndValidatePolicy } from "../scripts/generate-telemetry-contract.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED_FILE = resolve(REPO_ROOT, "generated", "telemetry-v0.1-field-dictionary.json");
const CONTRACT_STATUS_FILE = resolve(REPO_ROOT, "contracts", "telemetry-v0.1", "contract-status.json");

function oneFieldInventory() {
  return [{
    schemaName: "example.schema.json",
    schemaId: "https://example.test/example.schema.json",
    schemaSha256: "0".repeat(64),
    properties: [{ schemaPointer: "/properties/value", fieldPath: "value" }],
    references: [],
  }];
}

function oneFieldGroup(target = "example.schema.json#/properties/value") {
  return {
    targets: [target],
    purpose: "Exercise contract validation.",
    privacyClass: "test_metadata",
    retentionClass: "test_only",
    publicEligibility: "not_public",
    codexProvenance: "observed",
    claudeProvenance: "unavailable",
    limitation: "Synthetic test policy only.",
  };
}

function policy(groups) {
  return {
    contractVersion: "telemetry-field-dictionary-v0.1",
    provenanceStatuses: {
      observed: "Observed.",
      unavailable: "Unavailable.",
    },
    policyGroups: groups,
  };
}

test("checked-in telemetry field dictionary is deterministic and current", () => {
  const output = execFileSync(
    process.execPath,
    [resolve(REPO_ROOT, "scripts", "generate-telemetry-contract.js"), "--check"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.match(output, /telemetry contract is current \(151 fields; compatibility current\)/);
});

test("generated dictionary gives every schema property a complete policy row", async () => {
  const dictionary = JSON.parse(await readFile(GENERATED_FILE, "utf8"));
  assert.equal(dictionary.contractVersion, "telemetry-field-dictionary-v0.1");
  assert.equal(dictionary.schemas.length, 6);
  assert.equal(dictionary.fields.length, 151);
  assert.equal(
    dictionary.schemas.reduce((sum, schema) => sum + schema.propertyCount, 0),
    dictionary.fields.length,
  );
  assert.deepEqual(
    dictionary.resolvedReferences.map((reference) => reference.targetSchema).sort(),
    [
      "activity-marker.schema.json",
      "compatibility.schema.json",
      "compatibility.schema.json",
      "quota-snapshot.schema.json",
      "usage-event.schema.json",
    ],
  );

  const keys = new Set();
  for (const field of dictionary.fields) {
    const key = `${field.schemaName}#${field.schemaPointer}`;
    assert.equal(keys.has(key), false, `duplicate generated field: ${key}`);
    keys.add(key);
    assert.match(field.schemaPointer, /^\/properties\//);
    assert.ok(field.fieldPath.length > 0);
    for (const name of [
      "purpose",
      "privacyClass",
      "retentionClass",
      "publicEligibility",
      "codexProvenance",
      "claudeProvenance",
      "limitation",
    ]) {
      assert.equal(typeof field[name], "string", `${key} is missing ${name}`);
      assert.ok(field[name].length > 0, `${key} has empty ${name}`);
    }
    assert.ok(Object.hasOwn(dictionary.provenanceStatuses, field.codexProvenance));
    assert.ok(Object.hasOwn(dictionary.provenanceStatuses, field.claudeProvenance));
  }
});

test("telemetry v0.1 is explicitly an unfrozen local-only draft", async () => {
  const status = JSON.parse(await readFile(CONTRACT_STATUS_FILE, "utf8"));
  assert.deepEqual(status, {
    contractFamily: "telemetry-v0.1",
    status: "draft_local_only_unfrozen",
    transportReady: false,
    backwardCompatibility: "none_regenerate_local_review_artifacts",
    externalParticipantsAuthorized: false,
    freezeRule: "The first volunteer or upload-capable contract must use a new version and preserve every frozen predecessor unchanged.",
  });
});

test("policy validation rejects missing, orphaned, and duplicate coverage", () => {
  const inventory = oneFieldInventory();
  assert.throws(
    () => expandAndValidatePolicy(inventory, policy([])),
    /schema properties missing policy/,
  );
  assert.throws(
    () => expandAndValidatePolicy(inventory, policy([oneFieldGroup("example.schema.json#/properties/other")])),
    /orphan policy target/,
  );
  assert.throws(
    () => expandAndValidatePolicy(inventory, policy([oneFieldGroup(), oneFieldGroup()])),
    /duplicate policy target/,
  );
});
