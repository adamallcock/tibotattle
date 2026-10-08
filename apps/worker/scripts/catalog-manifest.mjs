#!/usr/bin/env node

/**
 * Catalog manifest build-and-sign step (KM-1 baseline projection, KM-2 signing).
 *
 * ONE REVIEWED DATA FILE. apps/worker/catalog/manifest-0001.json is the
 * baseline manifest (version 1): a projection of the compiled d43c8f92 price
 * registry, reviewed model catalog, plan roster and Fast assumption, read
 * from the vendored kernels' own copies (vendor/analytics-d43c8f92). It is
 * immutable after cutover: `write` is restricted to its original source. Later
 * versions are reviewed data files of the same schema, checked for
 * append-only continuity against their predecessor with `--previous`.
 *
 * MODES (one JSON receipt line on stdout; one JSON error line on stderr):
 *   check   [--data F]                  Offline. F (default the baseline) must
 *           validate and, for version 1, equal the projection byte for byte.
 *   write                               Regenerate the baseline at its original source only.
 *   build   --data F --out P [--previous Q]
 *           Validate F (and its continuity from the canonical payload Q),
 *           then write the canonical payload bytes P, the bytes that are signed.
 *   sign    --payload P --channel production|staging --out E [--slot current|next]
 *           [--key-env NAME]
 *           Sign P into the catalog-envelope-v1 envelope E with the pinned key
 *           of that channel and slot (default current). An OWNER-RUN
 *           protected operation: it refuses to run when a CI or hosted-runner
 *           environment is detected (CATALOG_TOOL_SIGNING_REFUSED_IN_CI),
 *           before it reads any key. The private key is referenced by NAME
 *           only (src/catalog-manifest-keys.ts): the owner runs
 *             secret run tibotattle-<keyId> --env TIBOTATTLE_CATALOG_SIGNING_KEY -- \
 *               node apps/worker/scripts/catalog-manifest.mjs sign ...
 *           and the `secret` helper sets that variable for this one process
 *           from the macOS Keychain, as base64 PKCS#8 DER, a PKCS#8 PEM block
 *           or the base64 raw 32-byte Ed25519 seed. The key is never written,
 *           printed or passed as an argument, and never comes from CI or
 *           Secret Manager. A key whose public half is not the pinned key for
 *           that slot is refused (CATALOG_TOOL_SIGNING_KEY_NOT_PINNED) and
 *           nothing is written. Runbook:
 *           docs/runbooks/gcp-catalog-manifest-signing.md.
 *   verify  --envelope E (--channel C | --key-id K --public-key B64)
 *           Verify E exactly as the server loader does (signature, canonical
 *           bytes, closed schema, registry SHA).
 *
 * Exit 0 on success, 2 for a usage refusal, 1 for any other failure. Errors
 * carry a closed code and a structural path, never a value or key material.
 */

import frozenBaselineManifest from "../catalog/manifest-0001.json" with { type: "json" };
import { lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_OFFICIAL_PRICE_CARDS,
  APP_PRICE_REGISTRY_OBSERVED_AT,
  APP_PRICE_REGISTRY_SHA256,
  APP_PRICE_REGISTRY_VERSION,
} from "../vendor/analytics-d43c8f92/packages/accounting/src/price-registry.js";
import { FAST_MODE_ASSUMED_MULTIPLIER } from "../vendor/analytics-d43c8f92/packages/accounting/src/subscription-speed.js";
import {
  REVIEWED_MODEL_CATALOG,
  REVIEWED_MODEL_CATALOG_VERSION,
} from "../vendor/analytics-d43c8f92/packages/telemetry-contract/src/model-catalog.js";
import {
  TELEMETRY_PLAN_DISPLAY_NAMES,
  TELEMETRY_PLAN_TYPES,
} from "../vendor/analytics-d43c8f92/packages/telemetry-contract/src/constants.js";
import {
  CATALOG_BASELINE_DIGEST,
  CATALOG_BASELINE_SOURCE_COMMIT,
  CatalogManifestError,
  assertCatalogCompiledAssertions,
  assertCatalogManifestSuccessor,
  canonicalCatalogPayloadText,
  decodeBase64,
  parseCanonicalCatalogPayload,
  signCatalogPayload,
  validateCatalogManifest,
  verifyCatalogEnvelope,
  webCryptoSha256Hex,
} from "../src/catalog-manifest.ts";
import {
  CATALOG_KEY_CHANNELS,
  CATALOG_KEY_SLOTS,
  catalogSigningKeyReference,
  catalogTrustedKeys,
} from "../src/catalog-manifest-keys.ts";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CATALOG_BASELINE_DATA_FILE = join(WORKER_ROOT, "catalog", "manifest-0001.json");
const VENDOR_MANIFEST = join(WORKER_ROOT, "vendor", "analytics-d43c8f92", "MANIFEST.json");
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
const KEY_ID = /^[a-z0-9][a-z0-9-]{0,47}$/u;

export class CatalogToolError extends Error {
  constructor(code, detail = null, exitCode = 1) {
    super(code);
    this.code = code;
    this.detail = detail;
    this.exitCode = exitCode;
  }
}

function usage(detail) {
  throw new CatalogToolError("CATALOG_TOOL_USAGE", detail, 2);
}

/** This build's compiled inputs, from the vendored kernels' own modules. */
export const VENDORED_COMPILED_INPUTS = Object.freeze({
  priceCards: APP_OFFICIAL_PRICE_CARDS,
  registryVersion: APP_PRICE_REGISTRY_VERSION,
  registrySha256: APP_PRICE_REGISTRY_SHA256,
  registryObservedAt: APP_PRICE_REGISTRY_OBSERVED_AT,
  modelCatalog: REVIEWED_MODEL_CATALOG,
  modelCatalogVersion: REVIEWED_MODEL_CATALOG_VERSION,
  planTypes: TELEMETRY_PLAN_TYPES,
  planDisplayNames: TELEMETRY_PLAN_DISPLAY_NAMES,
  fastModeAssumedMultiplier: FAST_MODE_ASSUMED_MULTIPLIER,
});

export function projectBaselineManifest() {
  return JSON.parse(JSON.stringify(frozenBaselineManifest));
}

/** The reviewed data file's bytes: two-space JSON plus one newline. */
export function dataFileText(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function readRegularFile(path, detail) {
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new CatalogToolError("CATALOG_TOOL_FILE_UNREADABLE", detail);
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) {
    throw new CatalogToolError("CATALOG_TOOL_FILE_UNSAFE", detail);
  }
  return readFile(path, "utf8");
}

async function readDataFile(path) {
  const text = await readRegularFile(path, "data");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CatalogToolError("CATALOG_TOOL_DATA_NOT_JSON", "data");
  }
  if (dataFileText(parsed) !== text) throw new CatalogToolError("CATALOG_TOOL_DATA_NOT_FORMATTED", "data");
  return parsed;
}

async function assertVendoredBaselineCommit() {
  const manifest = JSON.parse(await readRegularFile(VENDOR_MANIFEST, "vendor"));
  if (manifest.sourceCommit !== CATALOG_BASELINE_SOURCE_COMMIT) {
    throw new CatalogToolError("CATALOG_TOOL_VENDOR_COMMIT_MISMATCH", "vendor");
  }
}

/** Validate a data-file manifest; version 1 must equal the projection exactly. */
export async function checkCatalogData(manifestValue) {
  const manifest = await validateCatalogManifest(manifestValue, webCryptoSha256Hex);
  assertCatalogCompiledAssertions(manifest, VENDORED_COMPILED_INPUTS);
  const payloadText = canonicalCatalogPayloadText(manifest);
  const digest = await webCryptoSha256Hex(payloadText);
  if (manifest.version === 1) {
    if (payloadText !== canonicalCatalogPayloadText(projectBaselineManifest()) || digest !== CATALOG_BASELINE_DIGEST) {
      throw new CatalogToolError("CATALOG_TOOL_BASELINE_DRIFT", "data");
    }
  }
  return { manifest, payloadText, digest };
}

function receiptOf(checked, extra = {}) {
  return {
    version: checked.manifest.version,
    digest: checked.digest,
    payloadBytes: Buffer.byteLength(checked.payloadText),
    registrySha256: checked.manifest.compat.registrySha256,
    ...extra,
  };
}

/**
 * Environment variables whose presence (with any value other than empty,
 * "0" or "false") marks a CI system, a hosted runner or a Google Cloud
 * build or run environment. Signing is owner-run only (design §2.5), so the
 * sign mode refuses under any of them before it reads a key.
 */
export const CATALOG_SIGNING_CI_MARKERS = Object.freeze([
  "CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "GITLAB_CI",
  "BUILDKITE", "CIRCLECI", "TRAVIS", "TF_BUILD", "JENKINS_URL", "TEAMCITY_VERSION", "CODEBUILD_BUILD_ID",
  "BITBUCKET_BUILD_NUMBER", "DRONE", "SEMAPHORE", "APPVEYOR", "BUILDER_OUTPUT", "CLOUD_RUN_JOB", "K_SERVICE",
]);

/** The first CI marker set in env, or null. */
export function detectedCiMarker(env) {
  for (const name of CATALOG_SIGNING_CI_MARKERS) {
    const value = env?.[name];
    if (typeof value === "string" && value.trim() !== "" && !["0", "false"].includes(value.trim().toLowerCase())) {
      return name;
    }
  }
  return null;
}

/** The fixed PKCS#8 DER prefix of an Ed25519 private key around its 32-byte seed (RFC 8410). */
const ED25519_PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
  0x70, 0x04, 0x22, 0x04, 0x20]);

/** Parse the private key from the named environment variable's value. */
function privateKeyFrom(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192) {
    throw new CatalogToolError("CATALOG_TOOL_SIGNING_KEY_UNAVAILABLE", "key");
  }
  const pem = /^-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END PRIVATE KEY-----\s*$/u.exec(value);
  const base64 = (pem === null ? value : pem[1]).replace(/\s+/gu, "");
  const bytes = decodeBase64(base64);
  if (bytes === null) throw new CatalogToolError("CATALOG_TOOL_SIGNING_KEY_UNAVAILABLE", "key");
  if (pem === null && bytes.byteLength === 32) {
    const wrapped = new Uint8Array(ED25519_PKCS8_PREFIX.byteLength + 32);
    wrapped.set(ED25519_PKCS8_PREFIX, 0);
    wrapped.set(bytes, ED25519_PKCS8_PREFIX.byteLength);
    bytes.fill(0);
    return wrapped;
  }
  return bytes;
}

function parseArguments(argv) {
  const [mode, ...rest] = argv;
  if (!["check", "write", "build", "sign", "verify"].includes(mode)) usage("mode");
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!/^--[a-z][a-z-]{0,31}$/u.test(flag ?? "") || value === undefined || value.startsWith("--")) usage("arguments");
    const name = flag.slice(2);
    if (Object.hasOwn(options, name)) usage(name);
    options[name] = value;
  }
  const allowed = {
    check: ["data"],
    write: [],
    build: ["data", "out", "previous"],
    sign: ["payload", "channel", "out", "slot", "key-env"],
    verify: ["envelope", "channel", "key-id", "public-key"],
  }[mode];
  for (const name of Object.keys(options)) if (!allowed.includes(name)) usage(name);
  return { mode, options };
}

function channelOf(value) {
  if (!CATALOG_KEY_CHANNELS.includes(value)) usage("channel");
  return value;
}

/**
 * `trustedKeysFor` defaults to the code pins; only the offline checks pass a
 * synthetic pin set, so they can sign without a real key.
 */
export async function runCatalogManifestTool(argv, {
  env = process.env, cwd = process.cwd(), trustedKeysFor = catalogTrustedKeys,
} = {}) {
  const { mode, options } = parseArguments(argv);
  const path = (name) => resolve(cwd, options[name]);
  if (mode === "check") {
    const checked = await checkCatalogData(await readDataFile(options.data ? path("data") : CATALOG_BASELINE_DATA_FILE));
    return { status: "ok", mode, ...receiptOf(checked) };
  }
  if (mode === "write") {
    await assertVendoredBaselineCommit();
    const projected = projectBaselineManifest();
    const checked = await checkCatalogData(JSON.parse(JSON.stringify(projected)));
    await writeFile(CATALOG_BASELINE_DATA_FILE, dataFileText(projected), { mode: 0o644 });
    return { status: "ok", mode, ...receiptOf(checked) };
  }
  if (mode === "build") {
    if (!options.data || !options.out) usage("build");
    const checked = await checkCatalogData(await readDataFile(path("data")));
    if (checked.manifest.version > 1) {
      if (!options.previous) usage("previous");
      const previousText = await readRegularFile(path("previous"), "previous");
      const previous = await validateCatalogManifest(parseCanonicalCatalogPayload(previousText), webCryptoSha256Hex);
      await assertCatalogManifestSuccessor({
        held: previous, heldDigest: await webCryptoSha256Hex(previousText), next: checked.manifest,
        digest: webCryptoSha256Hex,
      });
    } else if (options.previous) {
      usage("previous");
    }
    await writeFile(path("out"), checked.payloadText, { mode: 0o644 });
    return { status: "ok", mode, ...receiptOf(checked) };
  }
  if (mode === "sign") {
    // Owner-run only: refuse under CI before reading any argument file or key.
    const marker = detectedCiMarker(env);
    if (marker !== null) throw new CatalogToolError("CATALOG_TOOL_SIGNING_REFUSED_IN_CI", marker, 2);
    if (!options.payload || !options.out) usage("sign");
    const channel = channelOf(options.channel);
    const slot = options.slot ?? "current";
    if (!CATALOG_KEY_SLOTS.includes(slot)) usage("slot");
    const reference = catalogSigningKeyReference(channel, slot);
    if (reference === null) throw new CatalogToolError("CATALOG_TOOL_SIGNING_KEY_NOT_PINNED", "slot");
    const environmentVariable = options["key-env"] ?? reference.environmentVariable;
    if (!ENVIRONMENT_NAME.test(environmentVariable)) usage("key-env");
    const payloadText = await readRegularFile(path("payload"), "payload");
    const checked = await checkCatalogData(parseCanonicalCatalogPayload(payloadText));
    const signed = await signCatalogPayload({
      payloadText,
      keyId: reference.keyId,
      privateKeyPkcs8: privateKeyFrom(env[environmentVariable]),
    });
    const pinned = trustedKeysFor(channel).find((entry) => entry.keyId === reference.keyId) ?? null;
    if (pinned === null || pinned.publicKey !== signed.publicKey) {
      throw new CatalogToolError("CATALOG_TOOL_SIGNING_KEY_NOT_PINNED", "key");
    }
    // Verify the envelope exactly as the server loader will before writing it.
    await verifyCatalogEnvelope(signed.envelopeText, { trustedKeys: trustedKeysFor(channel) });
    await writeFile(path("out"), signed.envelopeText, { mode: 0o644 });
    return {
      status: "ok", mode, channel, slot, keyId: reference.keyId, secretHelperName: reference.secretHelperName,
      publicKey: signed.publicKey, pinned: true, ...receiptOf(checked),
    };
  }
  // verify
  if (!options.envelope) usage("verify");
  let trustedKeys;
  if (options.channel !== undefined) {
    if (options["key-id"] !== undefined || options["public-key"] !== undefined) usage("verify");
    trustedKeys = trustedKeysFor(channelOf(options.channel));
  } else {
    if (!KEY_ID.test(options["key-id"] ?? "") || typeof options["public-key"] !== "string") usage("verify");
    trustedKeys = [{ keyId: options["key-id"], publicKey: options["public-key"] }];
  }
  const verified = await verifyCatalogEnvelope(await readRegularFile(path("envelope"), "envelope"), { trustedKeys });
  return {
    status: "ok", mode, keyId: verified.keyId,
    ...receiptOf({ manifest: verified.manifest, payloadText: verified.payloadText, digest: verified.digest }),
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const receipt = await runCatalogManifestTool(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    const known = error instanceof CatalogToolError || error instanceof CatalogManifestError;
    process.stderr.write(`${JSON.stringify({
      status: "error",
      code: known ? error.code : "CATALOG_TOOL_FAILED",
      detail: known ? error.detail : null,
    })}\n`);
    process.exitCode = error instanceof CatalogToolError ? error.exitCode : 1;
  }
}
