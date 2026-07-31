#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "..", "..");

const SCHEMA_MIRRORS = Object.freeze([
  "activity-marker.schema.json",
  "contribution.schema.json",
  "quota-snapshot.schema.json",
  "usage-event.schema.json",
].map((basename) => Object.freeze({
  source: join(PACKAGE_ROOT, "schemas", "v0.2", basename),
  output: join(
    REPOSITORY_ROOT,
    "schemas",
    "telemetry-contribution-v0.2",
    basename,
  ),
})));

async function canonicalSchemaBytes(path) {
  const bytes = await readFile(path);
  const value = JSON.parse(bytes.toString("utf8"));
  assert.equal(
    value?.$schema,
    "http://json-schema.org/draft-07/schema#",
    `${path} must be a draft-07 JSON Schema`,
  );
  assert.equal(
    typeof value.$id,
    "string",
    `${path} must declare an identifier`,
  );
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

export async function checkTelemetrySchemaMirrors() {
  for (const mirror of SCHEMA_MIRRORS) {
    const [source, output] = await Promise.all([
      canonicalSchemaBytes(mirror.source),
      readFile(mirror.output),
    ]);
    assert.deepEqual(
      output,
      source,
      `${mirror.output} is stale; regenerate telemetry schema mirrors`,
    );
  }
  return Object.freeze({
    schemaCount: SCHEMA_MIRRORS.length,
  });
}

async function writeAtomically(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle = null;
  try {
    handle = await open(temporary, "wx", 0o644);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function writeTelemetrySchemaMirrors() {
  for (const mirror of SCHEMA_MIRRORS) {
    await writeAtomically(
      mirror.output,
      await canonicalSchemaBytes(mirror.source),
    );
  }
  return Object.freeze({
    schemaCount: SCHEMA_MIRRORS.length,
  });
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const check = arguments_.includes("--check");
  assert.deepEqual(
    arguments_.filter((argument) => argument !== "--check"),
    [],
    "unexpected schema mirror arguments",
  );
  const result = check
    ? await checkTelemetrySchemaMirrors()
    : await writeTelemetrySchemaMirrors();
  process.stdout.write(
    `${check ? "checked" : "wrote"} ${result.schemaCount} telemetry schema mirrors\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_FILE)) {
  await main();
}
