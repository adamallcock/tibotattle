import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createSyntheticLocalIndexRetirementCorpus,
} from "../scripts/benchmark-local-index-retirement.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "benchmark-local-analysis-pipeline.mjs");

function runLegacyBenchmark({
  codexHome,
  stateDirectory,
  startAt = "2025-08-02T00:00:00.000Z",
  endAt = "2026-08-02T00:00:00.000Z",
  workers = 1,
}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [
      SCRIPT,
      "--codex-home",
      codexHome,
      "--state",
      stateDirectory,
      "--start-at",
      startAt,
      "--end-at",
      endAt,
      "--workers",
      String(workers),
    ], {
      cwd: ROOT,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolveResult({ code, signal, stdout, stderr });
    });
  });
}

test("retained legacy benchmark emits JSON after the accounting refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "legacy-analysis-pipeline-cli-"));
  const fixtureDirectory = join(root, "fixture");
  const stateDirectory = join(root, "state");
  try {
    const corpus = await createSyntheticLocalIndexRetirementCorpus(
      fixtureDirectory,
    );
    const result = await runLegacyBenchmark({
      codexHome: corpus.codexHome,
      stateDirectory,
    });

    assert.equal(result.signal, null);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.schemaVersion, "local-analysis-performance-receipt-v2");
    assert.deepEqual(receipt.accountingWindow, {
      startAt: "2025-08-02T00:00:00.000Z",
      endAt: "2026-08-02T00:00:00.000Z",
      durationDays: 365,
    });
    assert.deepEqual(receipt.coveredAt, {
      startAt: receipt.accountingWindow.startAt,
      endAt: receipt.accountingWindow.endAt,
    });
    assert.equal(receipt.accounting.sourceMode, "legacy");
    assert.equal(receipt.accounting.events, 4);
    assert.equal(receipt.accounting.totalTokens, 800);
    assert.equal(receipt.sourceCount, 2);
    assert.equal(receipt.privacy.sourcePathsStored, false);
    assert.equal(receipt.privacy.rawJsonStored, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("standalone legacy benchmark rejects noncanonical or unsupported windows", async () => {
  const root = await mkdtemp(join(tmpdir(), "legacy-analysis-pipeline-window-"));
  const fixtureDirectory = join(root, "fixture");
  try {
    const corpus = await createSyntheticLocalIndexRetirementCorpus(
      fixtureDirectory,
    );
    const noncanonical = await runLegacyBenchmark({
      codexHome: corpus.codexHome,
      stateDirectory: join(root, "noncanonical-state"),
      startAt: "2025-08-02T00:00:00Z",
    });
    assert.notEqual(noncanonical.code, 0);
    assert.match(noncanonical.stderr, /canonical ISO instants/u);

    const unsupported = await runLegacyBenchmark({
      codexHome: corpus.codexHome,
      stateDirectory: join(root, "unsupported-state"),
      startAt: "2026-07-01T00:00:00.000Z",
    });
    assert.notEqual(unsupported.code, 0);
    assert.match(unsupported.stderr, /between 365 and 3653 days/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
