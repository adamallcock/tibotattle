import assert from "node:assert/strict";
import test from "node:test";
import { parseBenchmarkArguments } from "../scripts/benchmark-test-lanes.mjs";

test("benchmark runner accepts explicit modes and rejects ambiguous options", () => {
  assert.deepEqual(
    parseBenchmarkArguments(["--release-gate", "--verbose"]),
    {
      command: "benchmark",
      check: false,
      releaseGate: true,
      verbose: true,
    },
  );
  assert.deepEqual(
    parseBenchmarkArguments(["--check"]),
    {
      command: "check",
      check: true,
      releaseGate: false,
      verbose: false,
    },
  );
  assert.deepEqual(
    parseBenchmarkArguments(["--help"]),
    {
      command: "help",
      check: false,
      releaseGate: false,
      verbose: false,
    },
  );
  assert.throws(
    () => parseBenchmarkArguments(["--release-gate", "--release-gate"]),
    /at most once/u,
  );
  assert.throws(
    () => parseBenchmarkArguments(["--check", "--verbose"]),
    /cannot be combined/u,
  );
  assert.throws(
    () => parseBenchmarkArguments(["--unknown"]),
    /Unknown benchmark option/u,
  );
});
