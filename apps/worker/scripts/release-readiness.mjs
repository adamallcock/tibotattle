#!/usr/bin/env node
import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RELEASE_PROBE_TIMEOUT_MS,
  MAX_RELEASE_PROBE_TIMEOUT_MS,
  verifyReleaseReadiness,
} from "./release-readiness-lib.mjs";

const SCRIPT_FILE = fileURLToPath(import.meta.url);

function usageError(message) {
  const error = new TypeError(message);
  error.code = "RELEASE_READINESS_ARGUMENTS_INVALID";
  throw error;
}

function parseTimeout(value) {
  if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) {
    usageError("--timeout-ms must be a positive decimal integer");
  }
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1
      || timeoutMs > MAX_RELEASE_PROBE_TIMEOUT_MS) {
    usageError(
      `--timeout-ms must be from 1 to ${MAX_RELEASE_PROBE_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

export function parseReleaseReadinessArguments(argv) {
  const options = {
    help: false,
    probePublic: false,
    timeoutMs: DEFAULT_RELEASE_PROBE_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
    } else if (argument === "--probe-public") {
      options.probePublic = true;
    } else if (argument === "--timeout-ms") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        usageError("--timeout-ms requires a value");
      }
      options.timeoutMs = parseTimeout(value);
      index += 1;
    } else {
      usageError("unsupported release-readiness option");
    }
  }
  return Object.freeze(options);
}

function writeUsage(writer = process.stdout) {
  writer.write(
    "Usage: node apps/worker/scripts/release-readiness.mjs "
      + "[--probe-public] [--timeout-ms N]\n",
  );
  writer.write(
    "  --probe-public  explicitly perform bounded GET checks for health, "
      + "ready, and appcast\n",
  );
  writer.write(
    `  --timeout-ms N  per-request timeout, 1..${MAX_RELEASE_PROBE_TIMEOUT_MS} `
      + `(default ${DEFAULT_RELEASE_PROBE_TIMEOUT_MS})\n`,
  );
}

export async function runReleaseReadinessCLI(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
    stderr = process.stderr,
    verify = verifyReleaseReadiness,
  } = {},
) {
  try {
    const options = parseReleaseReadinessArguments(argv);
    if (options.help) {
      writeUsage(stdout);
      return Object.freeze({ exitCode: 0, result: null });
    }
    const result = await verify(options);
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return Object.freeze({
      exitCode: options.probePublic
        ? result.status === "ready" ? 0 : 1
        : ["public_unchecked", "ready"].includes(result.status) ? 0 : 1,
      result,
    });
  } catch {
    stderr.write("Release readiness verification failed closed.\n");
    return Object.freeze({ exitCode: 1, result: null });
  }
}

if (process.argv[1]
    && resolve(process.argv[1]) === resolve(SCRIPT_FILE)) {
  const result = await runReleaseReadinessCLI();
  process.exitCode = result.exitCode;
}
