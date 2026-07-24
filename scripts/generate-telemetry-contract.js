#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS_DIRECTORY = join(REPO_ROOT, "schemas", "telemetry-v0.1");
const POLICY_FILE = join(REPO_ROOT, "contracts", "telemetry-v0.1", "field-policy.json");
const OUTPUT_FILE = join(REPO_ROOT, "generated", "telemetry-v0.1-field-dictionary.json");
const COMPATIBILITY_OUTPUT_FILE = join(REPO_ROOT, "generated", "telemetry-v0.1-compatibility.json");

const REQUIRED_POLICY_FIELDS = [
  "purpose",
  "privacyClass",
  "retentionClass",
  "publicEligibility",
  "codexProvenance",
  "claudeProvenance",
  "limitation",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escapePointerSegment(value) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function pointerToFieldPath(pointer) {
  const segments = pointer.split("/").slice(1);
  const result = [];
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] === "properties") {
      result.push(segments[index + 1].replaceAll("~1", "/").replaceAll("~0", "~"));
      index += 1;
    } else if (segments[index] === "items" && result.length > 0) {
      result[result.length - 1] += "[]";
    }
  }
  return result.join(".");
}

function walkSchemaNode(node, pointer, properties, references) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;

  if (typeof node.$ref === "string") {
    references.push({ schemaPointer: pointer || "/", ref: node.$ref });
  }

  if (node.properties && typeof node.properties === "object") {
    for (const propertyName of Object.keys(node.properties).sort()) {
      const propertyPointer = `${pointer}/properties/${escapePointerSegment(propertyName)}`;
      properties.push({ schemaPointer: propertyPointer, fieldPath: pointerToFieldPath(propertyPointer) });
      walkSchemaNode(node.properties[propertyName], propertyPointer, properties, references);
    }
  }

  if (node.items && typeof node.items === "object") {
    walkSchemaNode(node.items, `${pointer}/items`, properties, references);
  }
}

export async function readSchemaInventory(schemasDirectory = SCHEMAS_DIRECTORY) {
  const schemaFiles = (await readdir(schemasDirectory))
    .filter((name) => name.endsWith(".schema.json"))
    .sort();
  assert.equal(schemaFiles.length, 6, "telemetry v0.1 must contain exactly six JSON Schemas");

  const schemas = [];
  for (const schemaName of schemaFiles) {
    const bytes = await readFile(join(schemasDirectory, schemaName));
    const schema = JSON.parse(bytes.toString("utf8"));
    assert.equal(typeof schema.$id, "string", `${schemaName} must declare $id`);
    const properties = [];
    const references = [];
    walkSchemaNode(schema, "", properties, references);
    schemas.push({
      schemaName,
      schemaId: schema.$id,
      schemaSha256: sha256(bytes),
      properties,
      references,
    });
  }
  return schemas;
}

function splitTarget(target) {
  assert.equal(typeof target, "string", "policy target must be a string");
  const separator = target.indexOf("#");
  assert.ok(separator > 0, `policy target must be schema#pointer: ${target}`);
  const schemaName = target.slice(0, separator);
  const schemaPointer = target.slice(separator + 1);
  assert.ok(schemaPointer.startsWith("/properties/"), `policy target must identify a property: ${target}`);
  return { schemaName, schemaPointer };
}

export function expandAndValidatePolicy(schemaInventory, policy) {
  assert.equal(policy.contractVersion, "telemetry-field-dictionary-v0.1");
  assert.ok(Array.isArray(policy.policyGroups), "policyGroups must be an array");
  assert.ok(policy.provenanceStatuses && typeof policy.provenanceStatuses === "object");

  const schemaFields = new Map();
  for (const schema of schemaInventory) {
    for (const property of schema.properties) {
      const key = `${schema.schemaName}#${property.schemaPointer}`;
      assert.ok(!schemaFields.has(key), `duplicate schema property: ${key}`);
      schemaFields.set(key, { schemaName: schema.schemaName, ...property });
    }
  }

  const policies = new Map();
  for (const [groupIndex, group] of policy.policyGroups.entries()) {
    assert.ok(Array.isArray(group.targets) && group.targets.length > 0, `policy group ${groupIndex} has no targets`);
    for (const field of REQUIRED_POLICY_FIELDS) {
      assert.equal(typeof group[field], "string", `policy group ${groupIndex} is missing ${field}`);
      assert.ok(group[field].length > 0, `policy group ${groupIndex} has empty ${field}`);
    }
    assert.ok(
      Object.hasOwn(policy.provenanceStatuses, group.codexProvenance),
      `unknown Codex provenance status in policy group ${groupIndex}: ${group.codexProvenance}`,
    );
    assert.ok(
      Object.hasOwn(policy.provenanceStatuses, group.claudeProvenance),
      `unknown Claude provenance status in policy group ${groupIndex}: ${group.claudeProvenance}`,
    );

    for (const target of group.targets) {
      const { schemaName, schemaPointer } = splitTarget(target);
      const key = `${schemaName}#${schemaPointer}`;
      assert.ok(schemaFields.has(key), `orphan policy target: ${key}`);
      assert.ok(!policies.has(key), `duplicate policy target: ${key}`);
      policies.set(key, Object.fromEntries(REQUIRED_POLICY_FIELDS.map((field) => [field, group[field]])));
    }
  }

  const missing = [...schemaFields.keys()].filter((key) => !policies.has(key)).sort();
  assert.deepEqual(missing, [], `schema properties missing policy:\n${missing.join("\n")}`);
  assert.equal(policies.size, schemaFields.size, "policy and schema field counts must match");

  return [...schemaFields.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, schemaField]) => ({
      schemaName: schemaField.schemaName,
      schemaPointer: schemaField.schemaPointer,
      fieldPath: schemaField.fieldPath,
      ...policies.get(key),
    }));
}

export async function buildTelemetryContract({
  schemasDirectory = SCHEMAS_DIRECTORY,
  policyFile = POLICY_FILE,
} = {}) {
  const schemaInventory = await readSchemaInventory(schemasDirectory);
  const policy = JSON.parse(await readFile(policyFile, "utf8"));
  const schemaIds = new Map(schemaInventory.map((schema) => [schema.schemaId, schema.schemaName]));
  const resolvedReferences = [];
  for (const schema of schemaInventory) {
    for (const reference of schema.references) {
      const targetSchema = schemaIds.get(reference.ref);
      assert.ok(targetSchema, `unresolved or external schema reference: ${reference.ref}`);
      resolvedReferences.push({
        fromSchema: schema.schemaName,
        schemaPointer: reference.schemaPointer,
        targetSchema,
      });
    }
  }

  return {
    contractVersion: policy.contractVersion,
    description: policy.description,
    provenanceStatuses: policy.provenanceStatuses,
    schemas: schemaInventory.map(({ schemaName, schemaId, schemaSha256, properties }) => ({
      schemaName,
      schemaId,
      schemaSha256,
      propertyCount: properties.length,
    })),
    resolvedReferences: resolvedReferences.sort((left, right) =>
      `${left.fromSchema}#${left.schemaPointer}`.localeCompare(`${right.fromSchema}#${right.schemaPointer}`)),
    fields: expandAndValidatePolicy(schemaInventory, policy),
  };
}

export function serializeTelemetryContract(contract) {
  return `${JSON.stringify(contract, null, 2)}\n`;
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJsonValue(value[key])]));
}

function serializeCompatibility(value) {
  return `${JSON.stringify(sortJsonValue(value), null, 2)}\n`;
}

async function main() {
  const check = process.argv.slice(2).includes("--check");
  const unexpected = process.argv.slice(2).filter((argument) => argument !== "--check");
  assert.deepEqual(unexpected, [], `unexpected arguments: ${unexpected.join(" ")}`);
  const expected = serializeTelemetryContract(await buildTelemetryContract());
  if (check) {
    const actual = await readFile(OUTPUT_FILE, "utf8");
    assert.equal(actual, expected, `${OUTPUT_FILE} is stale; regenerate it without --check`);
    const { buildExportCompatibilityTuple } = await import("../src/export-contract.js");
    const expectedCompatibility = serializeCompatibility(buildExportCompatibilityTuple());
    const actualCompatibility = await readFile(COMPATIBILITY_OUTPUT_FILE, "utf8");
    assert.equal(
      actualCompatibility,
      expectedCompatibility,
      `${COMPATIBILITY_OUTPUT_FILE} is stale; regenerate it without --check`,
    );
    process.stdout.write(`telemetry contract is current (${JSON.parse(actual).fields.length} fields; compatibility current)\n`);
    return;
  }
  await writeFile(OUTPUT_FILE, expected, { encoding: "utf8", flag: "w" });
  const { buildExportCompatibilityTuple } = await import("../src/export-contract.js");
  const compatibility = serializeCompatibility(buildExportCompatibilityTuple());
  await writeFile(COMPATIBILITY_OUTPUT_FILE, compatibility, { encoding: "utf8", flag: "w" });
  process.stdout.write(`wrote ${OUTPUT_FILE} (${JSON.parse(expected).fields.length} fields) and compatibility manifest\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
