// Offline checks for the catalog manifest build-and-sign step
// (scripts/catalog-manifest.mjs, KM-1/KM-2). Every key here is a synthetic
// Ed25519 key generated at test time; no real key, secret or network is used.
//
// Run: node --test ./scripts/catalog-manifest.check.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import {
  CATALOG_BASELINE_DATA_FILE,
  VENDORED_COMPILED_INPUTS,
  dataFileText,
  projectBaselineManifest,
  runCatalogManifestTool,
} from "./catalog-manifest.mjs";
import {
  catalogTrustedKeys,
  CATALOG_SIGNING_KEY_REFERENCES,
} from "../src/catalog-manifest-keys.ts";
import {
  canonicalCatalogPayloadText,
  encodeBase64,
  webCryptoSha256Hex,
} from "../src/catalog-manifest.ts";

const run = promisify(execFile);
const TOOL = join(dirname(fileURLToPath(import.meta.url)), "catalog-manifest.mjs");
const KEY_ENV = "KM_CORE_SYNTHETIC_CATALOG_KEY";
let directory;
let privateKeyBase64;
let publicKeyBase64;

async function syntheticKey() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return {
    privateKey: encodeBase64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
    publicKey: encodeBase64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
  };
}

async function tool(args, env = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [TOOL, ...args], {
      cwd: directory, env: { PATH: process.env.PATH, ...env }, maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "km-core-catalog-"));
  ({ privateKey: privateKeyBase64, publicKey: publicKeyBase64 } = await syntheticKey());
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("the committed baseline is exactly the d43c8f92 projection and reproduces the registry SHA", async () => {
  const committed = await readFile(CATALOG_BASELINE_DATA_FILE, "utf8");
  assert.equal(committed, dataFileText(projectBaselineManifest()));
  const receipt = await runCatalogManifestTool(["check"]);
  assert.equal(receipt.version, 1);
  assert.equal(receipt.registrySha256, VENDORED_COMPILED_INPUTS.registrySha256);
  // The price cards are the compiled cards byte for byte, so their digest is
  // the compiled APP_PRICE_REGISTRY_SHA256 literal.
  const parsed = JSON.parse(committed);
  assert.equal(JSON.stringify(parsed.priceCards), JSON.stringify(VENDORED_COMPILED_INPUTS.priceCards));
  assert.equal(await webCryptoSha256Hex(JSON.stringify(parsed.priceCards)), VENDORED_COMPILED_INPUTS.registrySha256);
});

test("check refuses a baseline that drifts from the compiled projection", async () => {
  const drifted = JSON.parse(await readFile(CATALOG_BASELINE_DATA_FILE, "utf8"));
  drifted.models[0].label = "Drifted label";
  const path = join(directory, "drifted.json");
  await writeFile(path, dataFileText(drifted));
  const result = await tool(["check", "--data", path]);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stderr), {
    status: "error", code: "CATALOG_TOOL_BASELINE_DRIFT", detail: "data",
  });
  const repriced = JSON.parse(await readFile(CATALOG_BASELINE_DATA_FILE, "utf8"));
  repriced.priceCards[0].components[0].price.amount = "999";
  await writeFile(path, dataFileText(repriced));
  const sha = await tool(["check", "--data", path]);
  assert.equal(JSON.parse(sha.stderr).code, "CATALOG_REGISTRY_SHA_MISMATCH");
});

test("build, sign and verify: the CI step produces a verifiable envelope from the reviewed data file", async () => {
  const payloadPath = join(directory, "payload.json");
  const envelopePath = join(directory, "envelope.json");
  const built = await tool(["build", "--data", CATALOG_BASELINE_DATA_FILE, "--out", payloadPath]);
  assert.equal(built.code, 0, built.stderr);
  const payload = await readFile(payloadPath, "utf8");
  assert.equal(payload, canonicalCatalogPayloadText(projectBaselineManifest()));
  assert.equal(JSON.parse(built.stdout).digest, await webCryptoSha256Hex(payload));

  // The key arrives only through the named environment variable.
  const missing = await tool(["sign", "--payload", payloadPath, "--channel", "staging", "--out", envelopePath,
    "--key-env", KEY_ENV]);
  assert.equal(JSON.parse(missing.stderr).code, "CATALOG_TOOL_SIGNING_KEY_UNAVAILABLE");

  const signed = await tool(["sign", "--payload", payloadPath, "--channel", "staging", "--out", envelopePath,
    "--key-env", KEY_ENV], { [KEY_ENV]: privateKeyBase64 });
  assert.equal(signed.code, 0, signed.stderr);
  const receipt = JSON.parse(signed.stdout);
  assert.equal(receipt.keyId, CATALOG_SIGNING_KEY_REFERENCES.staging.keyId);
  assert.equal(receipt.secretManagerSecret, CATALOG_SIGNING_KEY_REFERENCES.staging.secretManagerSecret);
  assert.equal(receipt.publicKey, publicKeyBase64);
  assert.equal(receipt.pinned, false, "no key is pinned until the owner pins one");
  for (const output of [signed.stdout, signed.stderr, missing.stdout, missing.stderr]) {
    assert.equal(output.includes(privateKeyBase64), false, "the private key never reaches output");
  }

  const verified = await tool(["verify", "--envelope", envelopePath, "--key-id", receipt.keyId,
    "--public-key", publicKeyBase64]);
  assert.equal(verified.code, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).digest, receipt.digest);

  // The pinned production and staging slots are empty: a channel verify refuses.
  assert.deepEqual(catalogTrustedKeys("production"), []);
  const unpinned = await tool(["verify", "--envelope", envelopePath, "--channel", "staging"]);
  assert.equal(JSON.parse(unpinned.stderr).code, "CATALOG_KEY_UNTRUSTED");

  // A different key cannot verify, and a flipped payload byte fails the signature.
  const other = await syntheticKey();
  const wrongKey = await tool(["verify", "--envelope", envelopePath, "--key-id", receipt.keyId,
    "--public-key", other.publicKey]);
  assert.equal(JSON.parse(wrongKey.stderr).code, "CATALOG_SIGNATURE_INVALID");
  const envelope = JSON.parse(await readFile(envelopePath, "utf8"));
  const flipped = envelope.payload.slice(0, 100) + (envelope.payload[100] === "A" ? "B" : "A")
    + envelope.payload.slice(101);
  await writeFile(envelopePath, JSON.stringify({ ...envelope, payload: flipped }));
  const tampered = await tool(["verify", "--envelope", envelopePath, "--key-id", receipt.keyId,
    "--public-key", publicKeyBase64]);
  assert.equal(JSON.parse(tampered.stderr).code, "CATALOG_SIGNATURE_INVALID");
});

test("build checks a successor's continuity against its predecessor's canonical payload", async () => {
  const base = projectBaselineManifest();
  const basePath = join(directory, "base-payload.json");
  await writeFile(basePath, canonicalCatalogPayloadText(base));
  const next = JSON.parse(JSON.stringify(base));
  next.version = 2;
  next.previousVersion = 1;
  next.previousDigest = await webCryptoSha256Hex(canonicalCatalogPayloadText(base));
  next.projectedFromCommit = null;
  next.models[0].label = "Relabelled";
  const nextPath = join(directory, "next.json");
  await writeFile(nextPath, dataFileText(next));
  const ok = await tool(["build", "--data", nextPath, "--previous", basePath, "--out", join(directory, "p2.json")]);
  assert.equal(ok.code, 0, ok.stderr);
  next.priceCards = next.priceCards.slice(1);
  next.compat.registrySha256 = await webCryptoSha256Hex(JSON.stringify(next.priceCards));
  await writeFile(nextPath, dataFileText(next));
  const dropped = await tool(["build", "--data", nextPath, "--previous", basePath, "--out", join(directory, "p3.json")]);
  assert.equal(JSON.parse(dropped.stderr).code, "CATALOG_NOT_APPEND_ONLY");
  const noPrevious = await tool(["build", "--data", nextPath, "--out", join(directory, "p4.json")]);
  assert.equal(noPrevious.code, 2);
});

test("usage refusals are closed and exit 2", async () => {
  for (const args of [[], ["publish"], ["check", "--data"], ["check", "--unknown", "x"],
    ["sign", "--payload", "p", "--channel", "dev", "--out", "e"], ["verify", "--envelope", "e"]]) {
    const result = await tool(args);
    assert.equal(result.code, 2, args.join(" "));
    assert.equal(JSON.parse(result.stderr).code, "CATALOG_TOOL_USAGE");
  }
  assert.equal(resolve(CATALOG_BASELINE_DATA_FILE).endsWith("apps/worker/catalog/manifest-0001.json"), true);
});
