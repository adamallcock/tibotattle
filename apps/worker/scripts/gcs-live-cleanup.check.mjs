import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(new URL("./gcs-live-cleanup.mjs", import.meta.url));
const bucket = "tibotattle-gcs-test-synthetic";
const digest = "a".repeat(64);

function defaultReceipt(runId, runPrefix) {
  return {
    schemaVersion: "gcs-live-smoke-receipt-v1",
    status: "passed",
    bucket,
    runId,
    runPrefix,
    attemptedKeys: [
      `${runPrefix}/appcast.xml`,
      `${runPrefix}/releases/1.0.0/${digest}/TiboTattle.dmg`,
      `${runPrefix}/scratch/replace.bin`,
      `${runPrefix}/scratch/race.bin`,
    ],
    createdKeys: [
      `${runPrefix}/appcast.xml`,
      `${runPrefix}/releases/1.0.0/${digest}/TiboTattle.dmg`,
      `${runPrefix}/scratch/replace.bin`,
      `${runPrefix}/scratch/race.bin`,
    ],
    generations: {
      [`${runPrefix}/appcast.xml`]: "11",
      [`${runPrefix}/releases/1.0.0/${digest}/TiboTattle.dmg`]: "12",
      [`${runPrefix}/scratch/replace.bin`]: "13",
      [`${runPrefix}/scratch/race.bin`]: "14",
    },
    transportEvents: [],
  };
}

function fixture({ runId = "a", value, token = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gcs-cleanup-check-"));
  const runPrefix = `gcs-test/runs/${runId}`;
  const receiptFile = join(directory, "receipt.json");
  const receipt = value ?? defaultReceipt(runId, runPrefix);
  writeFileSync(receiptFile, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  chmodSync(receiptFile, 0o600);
  let tokenFile;
  if (token) {
    tokenFile = join(directory, "token");
    writeFileSync(tokenFile, "synthetic-cleanup-token", { mode: 0o600 });
    chmodSync(tokenFile, 0o600);
  }
  return { directory, runPrefix, receiptFile, tokenFile, receipt };
}

function run(args, { preload, env = {} } = {}) {
  const command = preload
    ? ["--import", preload, script, ...args]
    : [script, ...args];
  const result = spawnSync(process.execPath, command, {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 32 * 1024,
    env: { ...process.env, ...env },
  });
  assert.equal(result.error, undefined);
  return result;
}

function dryRunArgs(fixtureValue, extra = []) {
  return [
    "--bucket", bucket,
    "--run-prefix", fixtureValue.runPrefix,
    "--receipt-file", fixtureValue.receiptFile,
    ...extra,
  ];
}

function resultJson(result) {
  const output = result.stdout.trim() || result.stderr.trim();
  assert.notEqual(output, "");
  return JSON.parse(output);
}

function writeMockFetch(directory, { expireAfterFirst = false } = {}) {
  const preload = join(directory, "mock-fetch.mjs");
  writeFileSync(preload, `
import { writeFileSync } from "node:fs";
const callsFile = process.env.GCS_CLEANUP_MOCK_CALLS;
const statuses = (process.env.GCS_CLEANUP_MOCK_STATUSES ?? "204").split(",").map(Number);
const baseSeconds = Number(process.env.GCS_CLEANUP_BASE_SECONDS);
let nowSeconds = baseSeconds;
Date.now = () => nowSeconds * 1000;
let calls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  calls.push({
    url: url.href,
    method: init.method,
    redirect: init.redirect,
    authorization: new Headers(init.headers).has("authorization"),
    generation: url.searchParams.get("generation"),
    ifGenerationMatch: url.searchParams.get("ifGenerationMatch"),
  });
  writeFileSync(callsFile, JSON.stringify(calls));
  ${expireAfterFirst ? "if (calls.length === 1) nowSeconds = Number(process.env.GCS_CLEANUP_EXPIRY);" : ""}
  const status = statuses[Math.min(calls.length - 1, statuses.length - 1)] ?? 503;
  return new Response(null, { status });
};
`, { mode: 0o600 });
  chmodSync(preload, 0o600);
  return preload;
}

test("default mode emits an exact dry run for the one-character namespace", () => {
  const value = fixture();
  try {
    const result = run(dryRunArgs(value));
    assert.equal(result.status, 0);
    const receipt = resultJson(result);
    assert.equal(receipt.status, "dry-run");
    assert.equal(receipt.runPrefix, "gcs-test/runs/a");
    assert.equal(receipt.targets.length, 4);
    assert.equal(receipt.targets[1].generation, "12");
    assert.equal(receipt.physicalErasure, "unproven");
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("refuses failed or incomplete receipts before any cleanup request", () => {
  const cases = [
    ["failed status", { status: "failed" }, "RECEIPT_STATUS_UNSAFE"],
    ["uncertain attempt", { attemptedKeys: ["gcs-test/runs/a/appcast.xml"], createdKeys: [] }, "RECEIPT_ATTEMPT_UNCERTAIN"],
    ["unknown key", { attemptedKeys: ["gcs-test/runs/a/other.bin"], createdKeys: ["gcs-test/runs/a/other.bin"], generations: { "gcs-test/runs/a/other.bin": "1" } }, "RECEIPT_TARGET_UNKNOWN"],
    ["generation above signed int64", { generations: { "gcs-test/runs/a/appcast.xml": "9223372036854775808" } }, "RECEIPT_GENERATION_INVALID"],
  ];
  for (const [name, overrides, code] of cases) {
    const baseline = defaultReceipt("a", "gcs-test/runs/a");
    const value = fixture({ value: {
      ...baseline,
      ...overrides,
      ...(overrides.generations === undefined ? {} : {
        generations: { ...baseline.generations, ...overrides.generations },
      }),
    } });
    try {
      const result = run(dryRunArgs(value));
      assert.equal(result.status, 1, name);
      assert.equal(resultJson(result).code, code, name);
    } finally {
      rmSync(value.directory, { recursive: true, force: true });
    }
  }
});

test("rejects a top-level receipt shape change and oversized receipt", () => {
  const extra = fixture({ value: { ...defaultReceipt("a", "gcs-test/runs/a"), extra: true } });
  try {
    const result = run(dryRunArgs(extra));
    assert.equal(result.status, 1);
    assert.equal(resultJson(result).code, "RECEIPT_INVALID");
  } finally {
    rmSync(extra.directory, { recursive: true, force: true });
  }

  const oversized = fixture({});
  try {
    writeFileSync(oversized.receiptFile, `${"x".repeat(256 * 1024 + 1)}\n`, { mode: 0o600 });
    chmodSync(oversized.receiptFile, 0o600);
    const result = run(dryRunArgs(oversized));
    assert.equal(result.status, 1);
    assert.equal(resultJson(result).code, "RECEIPT_INVALID");
  } finally {
    rmSync(oversized.directory, { recursive: true, force: true });
  }
});

test("execute sends only generation-conditioned exact-object deletes", () => {
  const value = fixture({ token: true });
  const callsFile = join(value.directory, "calls.json");
  const preload = writeMockFetch(value.directory);
  const baseSeconds = Math.floor(Date.now() / 1000);
  const expiry = baseSeconds + 600;
  try {
    const result = run([
      ...dryRunArgs(value),
      "--execute", "--access-token-file", value.tokenFile,
      "--expires-at", String(expiry),
    ], {
      preload,
      env: {
        GCS_CLEANUP_MOCK_CALLS: callsFile,
        GCS_CLEANUP_MOCK_STATUSES: "204,204,204,204",
        GCS_CLEANUP_BASE_SECONDS: String(baseSeconds),
        GCS_CLEANUP_EXPIRY: String(expiry),
      },
    });
    assert.equal(result.status, 0);
    const output = resultJson(result);
    assert.equal(output.status, "delete-requested");
    assert.equal(output.physicalErasure, "unproven");
    assert.deepEqual(output.outcomes.map((entry) => entry.status), [
      "delete-requested", "delete-requested", "delete-requested", "delete-requested",
    ]);
    const calls = JSON.parse(readFileSync(callsFile, "utf8"));
    assert.equal(calls.length, 4);
    assert.ok(calls.every((call) => call.method === "DELETE"
      && call.redirect === "manual" && call.authorization && call.generation === null));
    assert.ok(calls.every((call) => call.url.startsWith("https://storage.googleapis.com/storage/v1/b/")));
    assert.equal(calls[0].ifGenerationMatch, "11");
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("stops with an uncertain receipt when a delete response is ambiguous", () => {
  const value = fixture({ token: true });
  const callsFile = join(value.directory, "calls.json");
  const preload = writeMockFetch(value.directory);
  const baseSeconds = Math.floor(Date.now() / 1000);
  const expiry = baseSeconds + 600;
  try {
    const result = run([
      ...dryRunArgs(value),
      "--execute", "--access-token-file", value.tokenFile,
      "--expires-at", String(expiry),
    ], {
      preload,
      env: {
        GCS_CLEANUP_MOCK_CALLS: callsFile,
        GCS_CLEANUP_MOCK_STATUSES: "204,503",
        GCS_CLEANUP_BASE_SECONDS: String(baseSeconds),
        GCS_CLEANUP_EXPIRY: String(expiry),
      },
    });
    assert.equal(result.status, 1);
    const output = resultJson(result);
    assert.equal(output.status, "uncertain");
    assert.equal(output.code, "DELETE_OUTCOME_UNCERTAIN");
    assert.deepEqual(output.outcomes.map((entry) => entry.status), ["delete-requested", "unknown"]);
    assert.equal(JSON.parse(readFileSync(callsFile, "utf8")).length, 2);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("rechecks token expiry before each delete and stops before the next request", () => {
  const value = fixture({ token: true });
  const callsFile = join(value.directory, "calls.json");
  const preload = writeMockFetch(value.directory, { expireAfterFirst: true });
  const baseSeconds = Math.floor(Date.now() / 1000);
  const expiry = baseSeconds + 600;
  try {
    const result = run([
      ...dryRunArgs(value),
      "--execute", "--access-token-file", value.tokenFile,
      "--expires-at", String(expiry),
    ], {
      preload,
      env: {
        GCS_CLEANUP_MOCK_CALLS: callsFile,
        GCS_CLEANUP_MOCK_STATUSES: "204,204,204,204",
        GCS_CLEANUP_BASE_SECONDS: String(baseSeconds),
        GCS_CLEANUP_EXPIRY: String(expiry),
      },
    });
    assert.equal(result.status, 1);
    const output = resultJson(result);
    assert.equal(output.status, "uncertain");
    assert.equal(output.code, "TOKEN_EXPIRED");
    assert.deepEqual(output.outcomes.map((entry) => entry.status), ["delete-requested"]);
    assert.equal(JSON.parse(readFileSync(callsFile, "utf8")).length, 1);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});
