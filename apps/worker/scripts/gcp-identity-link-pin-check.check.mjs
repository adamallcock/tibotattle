/**
 * The production identity-link continuity check (gcp-identity-link-pin-check.mjs):
 * its fingerprint is the Worker's, it reads only the pinned version through
 * one read-only gcloud call, it names mismatches without content, and its
 * output never carries the value, the payload or a fingerprint. Every value
 * here is synthetic.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import * as check from "./gcp-identity-link-pin-check.mjs";
import * as manifest from "./gcp-ops-infra-manifest.mjs";
import { unpinnedProductionText } from "./fixtures/gcp-ops-infra/production-unfilled.mjs";

process.env.PATH = "/nonexistent-gcloud-guard";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "synthetic-identity-link-secret-value-0000000001";
const OTHER = "synthetic-identity-link-secret-value-0000000002";
const SECRETS = Object.freeze([SECRET, `${SECRET}\n`, "s".repeat(32), `${"long-synthetic-key-".repeat(9)}é`, "﻿synthetic-bom-led-identity-link-0001"]);

async function workerFingerprint() {
  const bundle = await build({
    entryPoints: [join(WORKER_ROOT, "src/identity-link-configuration.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  });
  const source = Buffer.from(bundle.outputFiles[0].text).toString("base64");
  return (await import(`data:text/javascript;base64,${source}`)).identityLinkSecretFingerprint;
}

function desired(version = "1") {
  const value = JSON.parse(unpinnedProductionText());
  value.secrets.IDENTITY_LINK_SECRET.version = version;
  return manifest.validateDesiredState(value);
}

function pinFor(secret, keyVersion = "production-v1") {
  return { keyVersion, secretFingerprint: check.identityLinkSecretFingerprint(secret) };
}

function d1Output(row) {
  return JSON.stringify([{ results: [row], success: true, meta: { rows_read: 1 } }]);
}

/** A fake spawn that answers `gcloud secrets versions access` with a synthetic value. */
function fakeGcloud(value, { status = 0, name, encode = (bytes) => bytes.toString("base64") } = {}) {
  const calls = [];
  const spawn = (command, argv, options) => {
    calls.push({ command, argv, options });
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    const response = {
      name: name ?? `projects/874229235044/secrets/IDENTITY_LINK_SECRET/versions/${argv[3]}`,
      payload: { data: encode(bytes), dataCrc32c: "1" },
    };
    return { status, stdout: status === 0 ? JSON.stringify(response) : "", stderr: status === 0 ? "" : "ERROR: synthetic" };
  };
  return { spawn, calls };
}

async function run(argv, { value = SECRET, pin = d1Output({ key_version: "production-v1",
  secret_fingerprint: check.identityLinkSecretFingerprint(SECRET) }), desiredState = desired(), gcloud } = {}) {
  const fake = gcloud ?? fakeGcloud(value);
  const out = [];
  const err = [];
  const code = await check.main(argv, {
    spawn: fake.spawn,
    readPin: () => pin,
    loadDesiredState: () => desiredState,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
  return { code, stdout: out.join(""), stderr: err.join(""), calls: fake.calls };
}

function assertContentFree(text, secret = SECRET) {
  assert.equal(text.includes(secret.trim()), false);
  assert.equal(text.includes(Buffer.from(secret).toString("base64").slice(0, 16)), false);
  assert.doesNotMatch(text, /[0-9a-f]{64}/u);
}

test("the fingerprint is the Worker's identityLinkSecretFingerprint", async () => {
  const worker = await workerFingerprint();
  for (const secret of SECRETS) assert.equal(check.identityLinkSecretFingerprint(secret), await worker(secret), secret.length);
  assert.notEqual(check.identityLinkSecretFingerprint(SECRET), check.identityLinkSecretFingerprint(`${SECRET}\n`));
});

test("the pin comes from a wrangler d1 --json SELECT or PT-3's identityLinkPin, with exactly one row", () => {
  const fingerprint = check.identityLinkSecretFingerprint(SECRET);
  const expected = { keyVersion: "production-v1", secretFingerprint: fingerprint };
  assert.deepEqual({ ...check.parseIdentityLinkPin(d1Output({ key_version: "production-v1", secret_fingerprint: fingerprint })) },
    expected);
  assert.deepEqual({ ...check.parseIdentityLinkPin(JSON.stringify(expected)) }, expected);
  for (const text of [
    "not json",
    "[]",
    JSON.stringify([{ results: [] }]),
    JSON.stringify([{ results: [{ key_version: "production-v1", secret_fingerprint: fingerprint }], success: false }]),
    JSON.stringify([{ results: [{ key_version: "production-v1", secret_fingerprint: fingerprint },
      { key_version: "production-v1", secret_fingerprint: fingerprint }] }]),
    d1Output({ key_version: "production-v1", secret_fingerprint: fingerprint, recorded_at: "2026-01-01" }),
    d1Output({ key_version: "production-v1", secret_fingerprint: fingerprint.toUpperCase() }),
    d1Output({ key_version: "production v1", secret_fingerprint: fingerprint }),
    JSON.stringify({ ...expected, extra: 1 }),
    JSON.stringify({ keyVersion: "production-v1", secretFingerprint: fingerprint.slice(1) }),
  ]) {
    assert.throws(() => check.parseIdentityLinkPin(text), { code: "PIN_CHECK_PIN_INVALID" }, text);
  }
});

test("the target is the committed production IDENTITY_LINK_SECRET version, or --version before the pin", () => {
  assert.deepEqual({ ...check.pinCheckTarget(desired("3"), undefined) }, { project: "tibotattle-prod",
    projectNumber: "874229235044", secretName: "IDENTITY_LINK_SECRET", version: "3", versionPinned: true });
  assert.equal(check.pinCheckTarget(desired("3"), "3").version, "3");
  assert.throws(() => check.pinCheckTarget(desired("3"), "4"), { code: "PIN_CHECK_VERSION_NOT_THE_PINNED_VERSION" });
  const unpinned = desired(null);
  assert.throws(() => check.pinCheckTarget(unpinned, undefined), { code: "PIN_CHECK_VERSION_REQUIRED" });
  assert.deepEqual([check.pinCheckTarget(unpinned, "2").version, check.pinCheckTarget(unpinned, "2").versionPinned],
    ["2", false]);
  // The committed file loads as the production plane the check reads.
  assert.equal(manifest.loadCommittedDesiredState("production").secrets.IDENTITY_LINK_SECRET.secretName,
    check.IDENTITY_LINK_SECRET_NAME);
  for (const argv of [[], ["--environment=staging", "--pin-file=x"], ["--environment=production"],
    ["--environment=production", "--pin-file=x", "--version=latest"], ["--environment=production", "--pin-file=x", "extra"],
    ["--environment=production", "--pin-file=x", "--project=other"]]) {
    assert.throws(() => check.parsePinCheckArgs(argv), (error) => error.code?.startsWith("PIN_CHECK_"), argv.join(" "));
  }
});

test("a match reads the pinned version once, read-only, without a shell or HTTP logging, and prints no content", async () => {
  const result = await run(["--environment=production", "--pin-file=pin.json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.calls.length, 1);
  const [call] = result.calls;
  assert.equal(call.command, "gcloud");
  assert.deepEqual(call.argv, ["secrets", "versions", "access", "1", "--secret=IDENTITY_LINK_SECRET",
    "--project=tibotattle-prod", "--format=json", "--no-log-http"]);
  assert.equal(call.options.shell, false);
  assert.deepEqual(call.options.stdio, ["ignore", "pipe", "pipe"]);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report, { schema: check.IDENTITY_LINK_PIN_CHECK_SCHEMA, environment: "production",
    project: "tibotattle-prod", secret: "IDENTITY_LINK_SECRET", version: "1", versionPinned: true,
    expectedKeyVersion: "production-v1", outcome: "match", reasons: [] });
  assertContentFree(result.stdout);
  assert.equal(result.stderr, "");
  // gcloud's base64url alphabet and a project-id response name are accepted too.
  const urlSafe = fakeGcloud("??>>synthetic-identity-link-secret-url-safe-01", {
    name: "projects/tibotattle-prod/secrets/IDENTITY_LINK_SECRET/versions/1",
    encode: (bytes) => bytes.toString("base64url"),
  });
  const safe = await run(["--environment=production", "--pin-file=pin.json"], { gcloud: urlSafe,
    pin: JSON.stringify(pinFor("??>>synthetic-identity-link-secret-url-safe-01")) });
  assert.equal(safe.code, 0, safe.stderr);
});

test("a mismatch names its reasons without content, including the trailing-newline slips", async () => {
  const cases = [
    [`${SECRET}\n`, pinFor(SECRET), ["FINGERPRINT_MISMATCH", "MATCHES_WITHOUT_TRAILING_NEWLINE"]],
    [`${SECRET}\r\n`, pinFor(SECRET), ["FINGERPRINT_MISMATCH", "MATCHES_WITHOUT_TRAILING_NEWLINE"]],
    [SECRET, pinFor(`${SECRET}\n`), ["FINGERPRINT_MISMATCH", "MATCHES_WITH_TRAILING_NEWLINE"]],
    [OTHER, pinFor(SECRET), ["FINGERPRINT_MISMATCH"]],
    [SECRET, pinFor(SECRET, "production-v2"), ["KEY_VERSION_MISMATCH"]],
    ["short-synthetic", pinFor("short-synthetic"), ["SECRET_TOO_SHORT"]],
  ];
  for (const [value, pin, reasons] of cases) {
    const result = await run(["--environment=production", "--pin-file=pin.json"], { value, pin: JSON.stringify(pin) });
    assert.equal(result.code, 2, reasons.join());
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, "mismatch");
    assert.deepEqual(report.reasons, reasons);
    assertContentFree(result.stdout, value);
  }
});

test("refusals are named codes on stderr, never echo gcloud or the value, and a bad pin calls nothing", async () => {
  const argv = ["--environment=production", "--pin-file=pin.json"];
  const badPin = await run(argv, { pin: "{}" });
  assert.deepEqual([badPin.code, badPin.calls.length, JSON.parse(badPin.stderr)],
    [1, 0, { status: "error", code: "PIN_CHECK_PIN_INVALID" }]);
  const cases = [
    [fakeGcloud(SECRET, { status: 1 }), "PIN_CHECK_SECRET_ACCESS_FAILED"],
    [fakeGcloud(SECRET, { name: "projects/874229235044/secrets/IDENTITY_LINK_SECRET/versions/2" }),
      "PIN_CHECK_SECRET_RESPONSE_INVALID"],
    [fakeGcloud(SECRET, { name: "projects/874229235044/secrets/OTHER_SECRET/versions/1" }),
      "PIN_CHECK_SECRET_RESPONSE_INVALID"],
    [fakeGcloud(SECRET, { encode: () => "not base64!" }), "PIN_CHECK_SECRET_RESPONSE_INVALID"],
    [fakeGcloud(Buffer.from([0xff, 0xfe, 0x41])), "PIN_CHECK_SECRET_NOT_UTF8"],
    [{ calls: [], spawn: () => ({ status: 0, stdout: `{"payload":"${SECRET}"` }) }, "PIN_CHECK_SECRET_RESPONSE_INVALID"],
    [{ calls: [], spawn: () => ({ error: new Error(SECRET) }) }, "PIN_CHECK_SECRET_ACCESS_FAILED"],
  ];
  for (const [gcloud, code] of cases) {
    const result = await run(argv, { gcloud });
    assert.equal(result.code, 1, code);
    assert.deepEqual(JSON.parse(result.stderr), { status: "error", code }, code);
    assert.equal(result.stdout, "");
    assertContentFree(result.stderr);
  }
  const unpinned = await run(argv, { desiredState: desired(null) });
  assert.deepEqual([unpinned.code, unpinned.calls.length, JSON.parse(unpinned.stderr).code],
    [1, 0, "PIN_CHECK_VERSION_REQUIRED"]);
});

test("the CLI entry runs as a subprocess and refuses a non-production environment", () => {
  const result = spawnSync(process.execPath, [join(WORKER_ROOT, "scripts/gcp-identity-link-pin-check.mjs"),
    "--environment=staging", "--pin-file=pin.json"], { encoding: "utf8", env: { PATH: "/nonexistent-gcloud-guard" } });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stderr), { status: "error", code: "PIN_CHECK_ENVIRONMENT_INVALID" });
  assert.equal(result.stdout, "");
});
