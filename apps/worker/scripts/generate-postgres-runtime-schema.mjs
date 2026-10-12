#!/usr/bin/env node

/**
 * Generate the Worker-safe PostgreSQL migration receipt manifest from the
 * canonical SQL fragments. The Worker cannot inspect its filesystem at
 * runtime, so the TypeScript manifest is a checked source artifact. It is
 * primary-only (manifest v2): there is no deletion-ledger schema.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPostgresMigrationManifest } from "./postgres-migrations.mjs";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(SCRIPT_ROOT, "src", "postgres-runtime-schema.ts");

function renderRole(migrations) {
  return migrations.map(({ name, sha256 }) => [
    "    [", JSON.stringify(name), ", ", JSON.stringify(sha256), "],",
  ].join(""));
}

export function renderPostgresRuntimeSchema(manifest) {
  if (manifest === null || typeof manifest !== "object"
      || manifest.schemaVersion !== "tibotattle-postgres-migration-manifest-v2"
      || manifest.roles === null || typeof manifest.roles !== "object"
      || Object.keys(manifest.roles).join(",") !== "primary"
      || !Array.isArray(manifest.roles.primary)) {
    throw new TypeError("invalid PostgreSQL migration manifest");
  }
  const lines = [
    "/**",
    " * Build-time PostgreSQL migration receipt expected by the Worker runtime.",
    " *",
    " * The migration runner owns applying SQL fragments. The application still",
    " * needs a source-owned admission fence so a host cannot point an older",
    " * reader at a missing, newer, or checksum-drifted schema and begin a write.",
    " * Keep this small manifest in product code instead of importing the Node-only",
    " * migration script or reading the filesystem from a Worker.",
    " */",
    "",
    "export interface PostgresRuntimeMigrationReceipt {",
    "  readonly version: number;",
    "  readonly name: string;",
    "  readonly sha256: string;",
    "}",
    "",
    "export const POSTGRES_RUNTIME_SCHEMA_VERSION =",
    "  " + JSON.stringify(manifest.schemaVersion) + " as const;",
    "",
    "type MigrationEntry = readonly [name: string, sha256: string];",
    "",
    "function receipt(",
    "  entry: readonly [string, string],",
    "  version: number,",
    "): PostgresRuntimeMigrationReceipt {",
    "  const [name, sha256] = entry;",
    "  return Object.freeze({ version, name, sha256 });",
    "}",
    "",
    "export const POSTGRES_RUNTIME_MIGRATIONS: Readonly<{",
    "  readonly primary: readonly PostgresRuntimeMigrationReceipt[];",
    "}> = Object.freeze({",
    "  primary: Object.freeze(([",
    ...renderRole(manifest.roles.primary),
    "  ] as readonly MigrationEntry[]).map((entry, index) => receipt(entry, index + 1))),",
    "});",
  ];
  return lines.join("\n") + "\n";
}

export async function generatePostgresRuntimeSchema({
  target = TARGET,
  write = false,
} = {}) {
  const manifest = await buildPostgresMigrationManifest();
  const expected = renderPostgresRuntimeSchema(manifest);
  if (write) {
    await writeFile(target, expected, "utf8");
    return { changed: true, target, manifest };
  }
  const actual = await readFile(target, "utf8");
  if (actual !== expected) {
    const error = new Error("POSTGRES_RUNTIME_MANIFEST_STALE");
    error.code = "POSTGRES_RUNTIME_MANIFEST_STALE";
    throw error;
  }
  return { changed: false, target, manifest };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes("--write");
  if (write && process.argv.includes("--check")) {
    throw new Error("choose only --check or --write");
  }
  try {
    await generatePostgresRuntimeSchema({ write });
  } catch (error) {
    if (error?.code === "POSTGRES_RUNTIME_MANIFEST_STALE") {
      console.error("PostgreSQL runtime migration manifest is stale; review SQL, then run --write.");
    }
    process.exitCode = 1;
  }
}
