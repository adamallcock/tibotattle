#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const ENTRY = resolve(ROOT, "server.mjs");
const OUTFILE = resolve(ROOT, "dist/server.mjs");
const options = {
  entryPoints: [ENTRY],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: OUTFILE,
  sourcemap: false,
  external: ["@google-cloud/cloud-sql-connector", "google-auth-library", "jsonc-parser", "pg"],
  logLevel: "silent",
};
if (process.argv.includes("--check")) {
  await build({ ...options, write: false, outfile: undefined });
  console.log(JSON.stringify({ status: "ok", mode: "check", entry: "server.mjs" }));
} else {
  await mkdir(dirname(OUTFILE), { recursive: true });
  await build(options);
  console.log(JSON.stringify({ status: "ok", mode: "build", output: "dist/server.mjs" }));
}
