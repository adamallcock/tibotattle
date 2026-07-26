import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parse, printParseErrorCode } from "jsonc-parser";
import {
  assessStagingConfiguration,
  probeStagingLive,
} from "./staging-readiness-lib.mjs";

function usageError(message) {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    "Usage: staging-readiness.mjs --mode config|live [--config /absolute/path]\n",
  );
  process.exit(2);
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) usageError(`${name} requires a value`);
  return value;
}

const knownArguments = new Set(["--mode", "--config"]);
for (let index = 2; index < process.argv.length; index += 2) {
  if (!knownArguments.has(process.argv[index])) {
    usageError("An unsupported option was supplied");
  }
}

const mode = optionValue("--mode");
if (!["config", "live"].includes(mode)) {
  usageError("--mode must be config or live");
}

const workerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const configFile = resolve(
  optionValue("--config") ?? join(workerDirectory, "wrangler.jsonc"),
);
const errors = [];
const configText = await readFile(configFile, "utf8");
const config = parse(configText, errors, {
  allowTrailingComma: true,
  disallowComments: false,
});
if (errors.length > 0) {
  process.stderr.write(
    `Staging configuration is invalid JSONC (${printParseErrorCode(errors[0].error)}).\n`,
  );
  process.exit(1);
}

const wrangler = join(
  workerDirectory,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);
const result = mode === "config"
  ? assessStagingConfiguration(config)
  : probeStagingLive({ config, wrangler, workerDirectory });

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (mode === "config") {
  process.exit(result.state === "unsafe_configuration" ? 1 : 0);
}
process.exit(result.state === "ready_for_disabled_deploy" ? 0 : 1);
