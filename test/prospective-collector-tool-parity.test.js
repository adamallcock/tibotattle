import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const CANONICAL = resolve(
  "tools/reports/build-prospective-collector-transitions.js",
);
const LEGACY = resolve(
  "scripts/build-prospective-collector-transitions.js",
);

function run(entrypoint, arguments_) {
  const result = spawnSync(
    process.execPath,
    [entrypoint, ...arguments_],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
      },
    },
  );
  return {
    signal: result.signal,
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

test("canonical prospective report tool preserves the legacy CLI contract", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "app-usagemonitor-prospective-tool-parity-"),
  );
  try {
    const canonicalInput = join(directory, "canonical-input.jsonl");
    const legacyInput = join(directory, "legacy-input.jsonl");
    const canonicalOutput = join(directory, "canonical-output.json");
    const legacyOutput = join(directory, "legacy-output.json");
    await Promise.all([
      writeFile(canonicalInput, "", {
        mode: 0o600,
      }),
      writeFile(legacyInput, "", {
        mode: 0o600,
      }),
    ]);

    const canonicalSuccess = run(CANONICAL, [
      "--input",
      canonicalInput,
      "--output",
      canonicalOutput,
    ]);
    const legacySuccess = run(LEGACY, [
      "--input",
      legacyInput,
      "--output",
      legacyOutput,
    ]);
    assert.deepEqual(legacySuccess, canonicalSuccess);
    assert.deepEqual(canonicalSuccess, {
      signal: null,
      status: 0,
      stderr: "",
      stdout:
        "Built 0 account-partitioned prospective transitions"
        + " from 0 eligible safe records.\n",
    });
    assert.equal(
      await readFile(legacyOutput, "utf8"),
      await readFile(canonicalOutput, "utf8"),
    );
    assert.equal((await stat(canonicalOutput)).mode & 0o777, 0o600);
    assert.equal((await stat(legacyOutput)).mode & 0o777, 0o600);

    const canonicalMissing = run(CANONICAL, [
      "--input",
      join(directory, "missing-canonical.jsonl"),
      "--output",
      canonicalOutput,
    ]);
    const legacyMissing = run(LEGACY, [
      "--input",
      join(directory, "missing-legacy.jsonl"),
      "--output",
      legacyOutput,
    ]);
    assert.deepEqual(legacyMissing, canonicalMissing);
    assert.deepEqual(canonicalMissing, {
      signal: null,
      status: 1,
      stderr: "prospective source is missing\n",
      stdout: "",
    });

    const canonicalArgumentError = run(CANONICAL, ["--input"]);
    const legacyArgumentError = run(LEGACY, ["--input"]);
    assert.deepEqual(legacyArgumentError, canonicalArgumentError);
    assert.deepEqual(canonicalArgumentError, {
      signal: null,
      status: 1,
      stderr: "prospective transition build failed\n",
      stdout: "",
    });
  } finally {
    await rm(directory, {
      force: true,
      recursive: true,
    });
  }
});
