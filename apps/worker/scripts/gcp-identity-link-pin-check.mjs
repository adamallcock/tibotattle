#!/usr/bin/env node

/**
 * Identity-link pin check for the production origin (PROD-PREP). It is a
 * gate before PROD-3's migrate and roll.
 *
 *   node scripts/gcp-identity-link-pin-check.mjs --environment=production
 *        --pin-file=<path> [--rotation-file=<path>] [--version=<n>]
 *
 * The production primary imports Cloudflare's identity-link pin: the
 * key-version label and the keyed fingerprint of IDENTITY_LINK_SECRET, in
 * identity_link_secret_configuration. The origin never re-pins it
 * (assertExistingPostgresIdentityLinkPin).
 *
 * Round 16 (2026-10-02): Cloudflare's value is lost, so the cutover rotates
 * it. Secret Manager holds a NEWLY GENERATED version, the origin runs the
 * rotated label (PRODUCTION_IDENTITY_LINK_SECRET_VERSION, 'production-v2'),
 * and the E-PT8 orchestrator moves the imported pin to it under its own token
 * and receipt. Only the retired routes read the pin (round 12;
 * IDENTITY_LINK_CONSUMER_ROUTE_IDS: the social chain, legacy enroll, security
 * reset and export), and the host refuses to compose under the rotated label
 * if it would serve one, so no kept route answers differently for a wrong
 * value. What this check guards is that the rotation moves the pin to the
 * bytes the service actually mounts.
 *
 * Modes:
 *   - Continuity (no --rotation-file): the mounted version must be the pin's
 *     value under the label the origin runs. Against a pin read from
 *     production's D1 (the retired label and the lost secret's fingerprint)
 *     a rotated mount therefore reports KEY_VERSION_MISMATCH and
 *     FINGERPRINT_MISMATCH and exits 2: without the flag it never passes.
 *   - Rotated (--rotation-file, the owner's identity-rotation.json from
 *     `postgres-production-transfer.mjs identity-rotate-pin`): the document
 *     must pass validateIdentityLinkRotation and its labels
 *     assertRotationLabels under PRODUCTION_IDENTITY_LINK_ROTATION_LABELS
 *     (from 'production-v1' to 'production-v2'; anything else is an error).
 *     Then the D1 pin must be the rotation's `from` (ROTATION_SOURCE_MISMATCH
 *     otherwise), the label must be 'production-v2' (KEY_VERSION_MISMATCH),
 *     the mounted value's fingerprint must be the rotation's `to`
 *     (FINGERPRINT_MISMATCH, with the trailing-newline hints), and the
 *     rotation's `to` must name the secret id and version this check reads
 *     (ROTATION_SECRET_NAME_MISMATCH, ROTATION_SECRET_VERSION_MISMATCH).
 *
 * Secret: the IDENTITY_LINK_SECRET version that the committed production
 * desired state pins. Before that pin is committed, --version names it; when
 * both exist they must agree. The tool reads it with one read-only call,
 *   gcloud secrets versions access <version> --secret=<id> --project=<project>
 *     --format=json --no-log-http
 * made through spawnSync with an argv array and no shell. The value stays in
 * this process: it is never printed, logged, written to disk, or put in argv
 * or an error, and gcloud's own output is never echoed. --no-log-http keeps
 * the response, which carries the value, out of gcloud's log files.
 *
 * Pin file: the expected pin, which is not secret. It is either the output
 * of a read-only `wrangler d1 execute ... --json` SELECT of key_version and
 * secret_fingerprint from production's identity_link_secret_configuration,
 * or PT-3's identityLinkPin object {keyVersion, secretFingerprint}. It must
 * hold exactly one row. In the rotated mode it is the D1 pin, the rotation's
 * source. The rotation file (closed JSON, at most 64 KiB, keyed digests and
 * labels only) is the owner's; keep it in the owner directory. Both files
 * are read and validated before any gcloud call.
 *
 * The fingerprint is the Worker's identityLinkSecretFingerprint
 * (src/identity-link-configuration.ts): HMAC-SHA-256 keyed by the secret's
 * UTF-8 bytes over a fixed domain string, as hex. The check holds the two
 * implementations equal.
 *
 * Output: one content-free JSON document on stdout. It names the secret id,
 * the version, in the rotated mode the rotation's two labels, the outcome
 * ('match' or 'mismatch') and content-free reasons, and never a value or a
 * fingerprint. On a fingerprint mismatch it also says
 * whether the value would match without, or with, one trailing newline. Exit
 * 0 on match, 2 on mismatch, and 1 on error, with {"status":"error","code":...}
 * on stderr.
 */

import { spawnSync } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { PRODUCTION_RESOURCE_FINGERPRINT } from "../cloud-run/postgres-production-configuration.mjs";
import { IDENTITY_LINK_CONSUMER_ROUTE_IDS } from "../cloud-run/postgres-production-registry.mjs";
import { loadCommittedDesiredState } from "./gcp-ops-infra-manifest.mjs";
import { assertRotationLabels, validateIdentityLinkRotation } from "./postgres-identity-link-pin.mjs";
import { PRODUCTION_IDENTITY_LINK_ROTATION_LABELS } from "./postgres-production-transfer.mjs";

export const IDENTITY_LINK_PIN_CHECK_SCHEMA = "tibotattle-identity-link-pin-check-v1";
/** src/identity-link-configuration.ts IDENTITY_LINK_SECRET_FINGERPRINT_DOMAIN; the check pins equality. */
export const IDENTITY_LINK_SECRET_FINGERPRINT_DOMAIN = "app-usagemonitor/identity-link-secret-fingerprint/v1\0";
export const IDENTITY_LINK_SECRET_NAME = "IDENTITY_LINK_SECRET";
/** The Worker refuses a shorter IDENTITY_LINK_SECRET (assertExistingPostgresIdentityLinkPin). */
export const MINIMUM_IDENTITY_LINK_SECRET_LENGTH = 32;

const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const FINGERPRINT = /^[0-9a-f]{64}$/u;
const SECRET_VERSION = /^[1-9][0-9]{0,9}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/u;
const MAX_PIN_FILE_BYTES = 64 * 1024;
const MAX_GCLOUD_OUTPUT_BYTES = 1024 * 1024;

export class IdentityLinkPinCheckError extends Error {
  constructor(code) {
    super(code);
    this.name = "IdentityLinkPinCheckError";
    this.code = code;
  }
}

function fail(code) {
  throw new IdentityLinkPinCheckError(code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactlyKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

/** The Worker's identityLinkSecretFingerprint, computed with node:crypto. */
export function identityLinkSecretFingerprint(secret) {
  if (typeof secret !== "string") fail("PIN_CHECK_SECRET_INVALID");
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(IDENTITY_LINK_SECRET_FINGERPRINT_DOMAIN, "utf8")
    .digest("hex");
}

export function parsePinCheckArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        environment: { type: "string" },
        "pin-file": { type: "string" },
        "rotation-file": { type: "string" },
        version: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch {
    fail("PIN_CHECK_ARGUMENT_INVALID");
  }
  const { environment, "pin-file": pinFile, "rotation-file": rotationFile, version } = parsed.values;
  // Only production imports a Cloudflare pin; staging's is its own (round 9).
  if (environment !== "production") fail("PIN_CHECK_ENVIRONMENT_INVALID");
  if (typeof pinFile !== "string" || pinFile.length === 0) fail("PIN_CHECK_ARGUMENT_INVALID");
  if (rotationFile !== undefined && rotationFile.length === 0) fail("PIN_CHECK_ARGUMENT_INVALID");
  if (version !== undefined && !SECRET_VERSION.test(version)) fail("PIN_CHECK_ARGUMENT_INVALID");
  return Object.freeze({ environment, pinFile, rotationFile: rotationFile ?? null, version });
}

/**
 * The round-16 rotation document (identity-rotation.json): the closed schema
 * naming exactly the registry's identity-link consumer routes
 * (validateIdentityLinkRotation; PIN_CHECK_ROTATION_INVALID otherwise), whose
 * labels move from a label production retired to the one the origin runs
 * (assertRotationLabels under PRODUCTION_IDENTITY_LINK_ROTATION_LABELS;
 * PIN_CHECK_ROTATION_LABELS_INVALID otherwise).
 */
export function parseIdentityLinkRotation(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("PIN_CHECK_ROTATION_INVALID");
  }
  let rotation;
  try {
    rotation = validateIdentityLinkRotation(value, { consumerRouteIds: IDENTITY_LINK_CONSUMER_ROUTE_IDS });
  } catch {
    fail("PIN_CHECK_ROTATION_INVALID");
  }
  try {
    assertRotationLabels({ fromKeyVersion: rotation.from.keyVersion, toKeyVersion: rotation.to.keyVersion },
      PRODUCTION_IDENTITY_LINK_ROTATION_LABELS);
  } catch {
    fail("PIN_CHECK_ROTATION_LABELS_INVALID");
  }
  return rotation;
}

/**
 * The rotated mode's comparison: the D1 pin is the rotation's source, the
 * rotation lands on the label the origin runs, names the secret version read,
 * and the mounted value is the rotation's target. Content-free reasons only.
 */
export function checkRotatedIdentityLinkPin(secret, pin, rotation, target, { expectedKeyVersion }) {
  const reasons = [];
  if (pin.keyVersion !== rotation.from.keyVersion || pin.secretFingerprint !== rotation.from.secretFingerprint) {
    reasons.push("ROTATION_SOURCE_MISMATCH");
  }
  if (rotation.to.secretName !== target.secretName) reasons.push("ROTATION_SECRET_NAME_MISMATCH");
  if (rotation.to.secretVersion !== target.version) reasons.push("ROTATION_SECRET_VERSION_MISMATCH");
  const mounted = checkIdentityLinkPin(secret, {
    keyVersion: rotation.to.keyVersion,
    secretFingerprint: rotation.to.secretFingerprint,
  }, { expectedKeyVersion });
  reasons.push(...mounted.reasons);
  return Object.freeze({ outcome: reasons.length === 0 ? "match" : "mismatch", reasons: Object.freeze(reasons) });
}

/** The secret id, project and version to read, from a validated desired state. */
export function pinCheckTarget(desired, requestedVersion) {
  const secret = desired?.secrets?.[IDENTITY_LINK_SECRET_NAME];
  if (!isRecord(secret)) fail("PIN_CHECK_SECRET_CONTAINER_MISSING");
  const pinned = secret.version;
  if (pinned !== null && requestedVersion !== undefined && requestedVersion !== pinned) {
    fail("PIN_CHECK_VERSION_NOT_THE_PINNED_VERSION");
  }
  const version = pinned ?? requestedVersion;
  if (version === undefined) fail("PIN_CHECK_VERSION_REQUIRED");
  return Object.freeze({
    project: desired.project,
    projectNumber: desired.projectNumber,
    secretName: secret.secretName,
    version,
    versionPinned: pinned !== null,
  });
}

/** The expected pin from a wrangler d1 --json result or PT-3's identityLinkPin object. */
export function parseIdentityLinkPin(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("PIN_CHECK_PIN_INVALID");
  }
  let keyVersion;
  let secretFingerprint;
  if (Array.isArray(value)) {
    const [statement] = value;
    if (value.length !== 1 || !isRecord(statement) || !Array.isArray(statement.results)
        || statement.results.length !== 1 || (Object.hasOwn(statement, "success") && statement.success !== true)) {
      fail("PIN_CHECK_PIN_INVALID");
    }
    const [row] = statement.results;
    if (!hasExactlyKeys(row, ["key_version", "secret_fingerprint"])) fail("PIN_CHECK_PIN_INVALID");
    ({ key_version: keyVersion, secret_fingerprint: secretFingerprint } = row);
  } else if (hasExactlyKeys(value, ["keyVersion", "secretFingerprint"])) {
    ({ keyVersion, secretFingerprint } = value);
  } else {
    fail("PIN_CHECK_PIN_INVALID");
  }
  if (typeof keyVersion !== "string" || !KEY_VERSION.test(keyVersion)
      || typeof secretFingerprint !== "string" || !FINGERPRINT.test(secretFingerprint)) {
    fail("PIN_CHECK_PIN_INVALID");
  }
  return Object.freeze({ keyVersion, secretFingerprint });
}

export function readPinFile(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    fail("PIN_CHECK_PIN_FILE_UNREADABLE");
  }
  if (!stat.isFile() || stat.size > MAX_PIN_FILE_BYTES) fail("PIN_CHECK_PIN_FILE_UNREADABLE");
  try {
    return readFileSync(path, "utf8");
  } catch {
    fail("PIN_CHECK_PIN_FILE_UNREADABLE");
  }
}

/** gcloud's payload.data, in either base64 alphabet, as bytes; anything else refuses. */
function decodePayload(data) {
  if (typeof data !== "string") fail("PIN_CHECK_SECRET_RESPONSE_INVALID");
  const standard = data.replaceAll("-", "+").replaceAll("_", "/");
  if (!BASE64.test(standard)) fail("PIN_CHECK_SECRET_RESPONSE_INVALID");
  const bytes = Buffer.from(standard, "base64");
  if (bytes.toString("base64").replace(/=+$/u, "") !== standard.replace(/=+$/u, "")) {
    bytes.fill(0);
    fail("PIN_CHECK_SECRET_RESPONSE_INVALID");
  }
  return bytes;
}

/**
 * Reads the target version's value with one read-only gcloud call. The value
 * is returned to the caller only; nothing here prints or keeps it.
 */
export function readIdentityLinkSecretVersion(target, { spawn = spawnSync } = {}) {
  const argv = [
    "secrets", "versions", "access", target.version,
    `--secret=${target.secretName}`, `--project=${target.project}`, "--format=json", "--no-log-http",
  ];
  const result = spawn("gcloud", argv, {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: MAX_GCLOUD_OUTPUT_BYTES,
  });
  if (result?.error || result?.status !== 0 || typeof result?.stdout !== "string") {
    fail("PIN_CHECK_SECRET_ACCESS_FAILED");
  }
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    fail("PIN_CHECK_SECRET_RESPONSE_INVALID");
  }
  const names = [target.project, target.projectNumber]
    .map((project) => `projects/${project}/secrets/${target.secretName}/versions/${target.version}`);
  if (!isRecord(response) || !names.includes(response.name) || !isRecord(response.payload)) {
    fail("PIN_CHECK_SECRET_RESPONSE_INVALID");
  }
  const bytes = decodePayload(response.payload.data);
  try {
    // The Worker reads the variable as UTF-8 text; keep a leading BOM as a character.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail("PIN_CHECK_SECRET_NOT_UTF8");
  } finally {
    bytes.fill(0);
  }
}

function fingerprintMatches(secret, expected) {
  return timingSafeEqual(Buffer.from(identityLinkSecretFingerprint(secret), "hex"), Buffer.from(expected, "hex"));
}

/**
 * Compares a value with the pin, as assertExistingPostgresIdentityLinkPin
 * would at the origin. Returns the outcome and content-free reasons only.
 */
export function checkIdentityLinkPin(secret, pin, { expectedKeyVersion }) {
  if (typeof secret !== "string") fail("PIN_CHECK_SECRET_INVALID");
  const reasons = [];
  if (pin.keyVersion !== expectedKeyVersion) reasons.push("KEY_VERSION_MISMATCH");
  if (secret.length < MINIMUM_IDENTITY_LINK_SECRET_LENGTH) reasons.push("SECRET_TOO_SHORT");
  if (!fingerprintMatches(secret, pin.secretFingerprint)) {
    reasons.push("FINGERPRINT_MISMATCH");
    // Diagnostics for the usual custody slip; each is one bit about trailing whitespace.
    const withoutNewline = secret.replace(/\r?\n$/u, "");
    if (withoutNewline !== secret && fingerprintMatches(withoutNewline, pin.secretFingerprint)) {
      reasons.push("MATCHES_WITHOUT_TRAILING_NEWLINE");
    }
    if (fingerprintMatches(`${secret}\n`, pin.secretFingerprint)) reasons.push("MATCHES_WITH_TRAILING_NEWLINE");
  }
  return Object.freeze({ outcome: reasons.length === 0 ? "match" : "mismatch", reasons: Object.freeze(reasons) });
}

function loadProductionDesiredState() {
  try {
    return loadCommittedDesiredState("production");
  } catch {
    return fail("PIN_CHECK_DESIRED_STATE_INVALID");
  }
}

/** CLI entry; returns the process exit code. */
export async function main(argv = process.argv.slice(2), {
  spawn = spawnSync,
  readPin = readPinFile,
  loadDesiredState = loadProductionDesiredState,
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
} = {}) {
  try {
    const args = parsePinCheckArgs(argv);
    const target = pinCheckTarget(loadDesiredState(), args.version);
    // Both files are read and validated before any gcloud call.
    const pin = parseIdentityLinkPin(readPin(args.pinFile));
    const rotation = args.rotationFile === null ? null : parseIdentityLinkRotation(readPin(args.rotationFile));
    const expectedKeyVersion = PRODUCTION_RESOURCE_FINGERPRINT.identityLinkSecretVersion;
    const secret = readIdentityLinkSecretVersion(target, { spawn });
    const result = rotation === null
      ? checkIdentityLinkPin(secret, pin, { expectedKeyVersion })
      : checkRotatedIdentityLinkPin(secret, pin, rotation, target, { expectedKeyVersion });
    stdout(`${JSON.stringify({
      schema: IDENTITY_LINK_PIN_CHECK_SCHEMA,
      environment: args.environment,
      project: target.project,
      secret: target.secretName,
      version: target.version,
      versionPinned: target.versionPinned,
      expectedKeyVersion,
      ...(rotation === null ? {} : {
        rotation: { fromKeyVersion: rotation.from.keyVersion, toKeyVersion: rotation.to.keyVersion },
      }),
      outcome: result.outcome,
      reasons: result.reasons,
    }, null, 2)}\n`);
    return result.outcome === "match" ? 0 : 2;
  } catch (error) {
    const code = error instanceof IdentityLinkPinCheckError ? error.code : "PIN_CHECK_FAILED";
    stderr(`${JSON.stringify({ status: "error", code })}\n`);
    return 1;
  }
}

/** Compares real paths, so a run through a symlinked path still runs main(). */
export function isCliEntry(argvPath, moduleUrl = import.meta.url) {
  if (typeof argvPath !== "string" || argvPath.length === 0) return false;
  try {
    return realpathSync(resolve(argvPath)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isCliEntry(process.argv[1])) {
  process.exitCode = await main();
}
