#!/usr/bin/env node
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");

export function parseBenchmarkArguments(argv) {
  let check = false;
  let releaseGate = false;
  let verbose = false;
  for (const option of argv) {
    if (option === "--check") {
      if (check) throw new Error("--check must be provided at most once");
      check = true;
    } else if (option === "--release-gate") {
      if (releaseGate) throw new Error("--release-gate must be provided at most once");
      releaseGate = true;
    } else if (option === "--verbose") {
      if (verbose) throw new Error("--verbose must be provided at most once");
      verbose = true;
    } else if (option === "--help" || option === "-h") {
      return Object.freeze({ command: "help", check: false, releaseGate: false, verbose: false });
    } else {
      throw new Error(`Unknown benchmark option: ${option}`);
    }
  }
  if (check && (releaseGate || verbose)) {
    throw new Error("--check cannot be combined with benchmark options");
  }
  return Object.freeze({ command: check ? "check" : "benchmark", check, releaseGate, verbose });
}

function usage() {
  console.log(`Usage: node scripts/benchmark-test-lanes.mjs [options]

Options:
  --release-gate  Also time the retained product:macos:test gate.
  --verbose       Stream lane output instead of retaining it for failures only.
  --check         Validate benchmark argument handling without running tests.
`);
}

function run(command, arguments_, {
  environment = process.env,
  verboseOutput = false,
} = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const output = [];
    const stdio = verboseOutput ? "inherit" : ["ignore", "pipe", "pipe"];
    const child = spawn(command, arguments_, {
      cwd: REPOSITORY_ROOT,
      env: environment,
      stdio,
    });
    if (!verboseOutput) {
      child.stdout.on("data", (chunk) => output.push(chunk));
      child.stderr.on("data", (chunk) => output.push(chunk));
    }
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0) resolveRun();
      else {
        const detail = Buffer.concat(output).toString("utf8").trim();
        rejectRun(new Error(
          `${command} failed with ${signal ?? `exit code ${code}`}`
          + (detail ? `:\n${detail}` : ""),
        ));
      }
    });
  });
}

async function timed(label, command, arguments_, { verbose }) {
  const started = performance.now();
  await run(command, arguments_, {
    environment: {
      ...process.env,
      USAGE_MONITOR_TEST_LANE_REPORTER: "dot",
    },
    verboseOutput: verbose,
  });
  const seconds = (performance.now() - started) / 1_000;
  console.log(`${label}: ${seconds.toFixed(1)} s`);
  return seconds;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseBenchmarkArguments(argv);
  if (options.command === "help") {
    usage();
    return;
  }
  if (options.command === "check") {
    console.log("benchmark-test-lanes: argument handling passed");
    return;
  }

  const lanes = [
    ["macOS source lane", process.execPath, ["scripts/test-lanes.mjs", "macos-source"]],
    ["macOS test-build smoke", process.execPath, ["scripts/test-lanes.mjs", "macos-smoke"]],
  ];
  if (options.releaseGate) {
    lanes.push([
      "macOS retained release gate",
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["run", "product:macos:test"],
    ]);
  }

  const started = performance.now();
  for (const [label, command, arguments_] of lanes) {
    await timed(label, command, arguments_, options);
  }
  console.log(`benchmark total: ${((performance.now() - started) / 1_000).toFixed(1)} s`);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main().catch((error) => {
    console.error(`benchmark-test-lanes: ${error.message}`);
    process.exitCode = 1;
  });
}
