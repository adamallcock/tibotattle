import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
} from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
if (args.includes("--remote")) {
  process.stderr.write("Local migration refuses --remote.\n");
  process.exit(2);
}

let persistTo = resolve(".wrangler", "state");
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument !== "--persist-to") {
    process.stderr.write("Usage: migrate-local.mjs [--persist-to /absolute/path]\n");
    process.exit(2);
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    process.stderr.write("--persist-to requires a path.\n");
    process.exit(2);
  }
  persistTo = resolve(value);
  index += 1;
}

try {
  mkdirSync(persistTo, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(persistTo);
  if (!metadata.isDirectory()
      || metadata.isSymbolicLink()
      || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
    throw new Error("unsafe state directory");
  }
} catch {
  process.stderr.write(
    "Local migration state must be a real owner-only directory.\n",
  );
  process.exit(2);
}

const wrangler = resolve(
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);
for (const binding of ["USAGE_MONITOR_DB", "DELETION_LEDGER"]) {
  const command = [
    "d1",
    "migrations",
    "apply",
    binding,
    "--local",
    "--persist-to",
    persistTo,
  ];
  const result = spawnSync(wrangler, command, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) {
    process.stderr.write("Local migration runner could not start Wrangler.\n");
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
