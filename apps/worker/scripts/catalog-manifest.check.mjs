// Offline checks for the catalog manifest build-and-sign step
// (scripts/catalog-manifest.mjs, KM-1/KM-2) and the pinned public keys
// (src/catalog-manifest-keys.ts). Every private key here is a synthetic
// Ed25519 key generated at test time; no real private key, Keychain item,
// secret or network is used. The real pins are checked as public data only.
//
// Run: node --test ./scripts/catalog-manifest.check.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import {
  CATALOG_BASELINE_DATA_FILE,
  CATALOG_SIGNING_CI_MARKERS,
  VENDORED_COMPILED_INPUTS,
  dataFileText,
  detectedCiMarker,
  projectBaselineManifest,
  runCatalogManifestTool,
} from "./catalog-manifest.mjs";
import {
  CATALOG_KEY_CHANNELS,
  CATALOG_KEY_SLOTS,
  CATALOG_PINNED_KEYS,
  CATALOG_SIGNING_ENVIRONMENT_VARIABLE,
  catalogSigningKeyReference,
  catalogTrustedKeys,
} from "../src/catalog-manifest-keys.ts";
import {
  canonicalCatalogPayloadText,
  decodeBase64,
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

/** A synthetic pin set: only the staging current slot, holding the synthetic key under the real key id. */
function syntheticPins(publicKey) {
  const keyId = catalogSigningKeyReference("staging", "current").keyId;
  return (channel) => (channel === "staging" ? [{ keyId, publicKey }] : []);
}

test("the pinned keys are the round-11 public keys: fingerprints hold and no key crosses channels", () => {
  const expected = {
    production: { current: "catalog-prod-2026a", next: "catalog-prod-2026b" },
    staging: { current: "catalog-staging-2026a", next: "catalog-staging-2026b" },
  };
  const ids = new Set();
  const keys = new Set();
  for (const channel of CATALOG_KEY_CHANNELS) {
    for (const slot of CATALOG_KEY_SLOTS) {
      const pinned = CATALOG_PINNED_KEYS[channel][slot];
      assert.notEqual(pinned, null, `${channel} ${slot} is pinned`);
      assert.deepEqual(Object.keys(pinned).sort(), ["keyId", "publicKey", "sha256"]);
      assert.equal(pinned.keyId, expected[channel][slot]);
      const raw = decodeBase64(pinned.publicKey);
      assert.equal(raw?.byteLength, 32, `${pinned.keyId} is a raw 32-byte Ed25519 public key`);
      assert.equal(createHash("sha256").update(raw).digest("hex"), pinned.sha256, `${pinned.keyId} fingerprint`);
      assert.match(pinned.keyId, channel === "production" ? /^catalog-prod-/u : /^catalog-staging-/u);
      ids.add(pinned.keyId);
      keys.add(pinned.publicKey);
      const reference = catalogSigningKeyReference(channel, slot);
      assert.deepEqual({ ...reference }, { channel, slot, keyId: pinned.keyId,
        secretHelperName: `tibotattle-${pinned.keyId}`, environmentVariable: "TIBOTATTLE_CATALOG_SIGNING_KEY" });
    }
    assert.deepEqual(catalogTrustedKeys(channel).map(({ keyId }) => keyId),
      [expected[channel].current, expected[channel].next], "slot order: current, then next");
  }
  assert.equal(ids.size, 4, "four distinct key ids");
  assert.equal(keys.size, 4, "four distinct public keys");
  assert.equal(CATALOG_SIGNING_ENVIRONMENT_VARIABLE, "TIBOTATTLE_CATALOG_SIGNING_KEY");
  assert.throws(() => catalogSigningKeyReference("staging", "previous"), /CATALOG_KEY_SLOT_INVALID/u);
  assert.throws(() => catalogTrustedKeys("dev"), /CATALOG_KEY_CHANNEL_INVALID/u);
  // Custody is the owner's Keychain through `secret run`: no Secret Manager reference remains.
  for (const path of ["../src/catalog-manifest-keys.ts", "./catalog-manifest.mjs"]) {
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), path), "utf8");
    assert.equal(/secretManagerSecret|catalog-manifest-signing-key-/u.test(text), false, path);
  }
});

test("pinning loads nothing: no runtime module calls the loader, so the compiled baseline is served", async () => {
  // Round 7: the compiled registry is what is served at cutover. With the
  // keys pinned, a manifest reaches the store only through a deliberate
  // loadCatalogManifest call; KM-4 (the first post-cutover change) adds the
  // first runtime caller, and must change this check on purpose. The
  // PostgreSQL spec proves the read side: an empty store under the real pins
  // serves the compiled baseline (catalog-manifest-store.spec.mjs).
  const { readdir } = await import("node:fs/promises");
  const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const callers = [];
  async function walk(relative) {
    for (const entry of await readdir(join(workerRoot, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) {
        if (!["dist", "node_modules", "vendor"].includes(entry.name)) await walk(path);
      } else if (/\.(?:ts|mjs|js)$/u.test(entry.name) && !/\.(?:check|spec|test)\./u.test(entry.name)
          && /\bloadCatalogManifest\w*\s*\(/u.test(await readFile(join(workerRoot, path), "utf8"))) {
        callers.push(path);
      }
    }
  }
  for (const root of ["src", "cloud-run", "scripts"]) await walk(root);
  assert.deepEqual(callers, [join("src", "postgres-catalog-store.ts")], "only the store defines the loader");
});

test("sign refuses under CI before it reads a key, and under every listed marker", async () => {
  const payloadPath = join(directory, "ci-payload.json");
  const envelopePath = join(directory, "ci-envelope.json");
  await writeFile(payloadPath, canonicalCatalogPayloadText(projectBaselineManifest()));
  for (const [name, value] of [["CI", "true"], ["CI", "1"], ["GITHUB_ACTIONS", "true"], ["CLOUD_RUN_JOB", "x"]]) {
    const refused = await tool(["sign", "--payload", payloadPath, "--channel", "staging", "--out", envelopePath,
      "--key-env", KEY_ENV], { [KEY_ENV]: privateKeyBase64, [name]: value });
    assert.equal(refused.code, 2, `${name}=${value}`);
    assert.deepEqual(JSON.parse(refused.stderr), {
      status: "error", code: "CATALOG_TOOL_SIGNING_REFUSED_IN_CI", detail: name,
    });
    assert.equal(refused.stdout, "");
    assert.equal(refused.stderr.includes(privateKeyBase64), false);
  }
  await assert.rejects(readFile(envelopePath), { code: "ENOENT" }, "nothing is written under CI");
  // The refusal happens even with an invalid payload path: no file is read first.
  const early = await runCatalogManifestTool(["sign", "--payload", "missing.json", "--channel", "staging",
    "--out", "e.json"], { env: { CI: "true" }, cwd: directory }).catch((error) => error);
  assert.equal(early.code, "CATALOG_TOOL_SIGNING_REFUSED_IN_CI");
  // Empty, "0" and "false" are not CI.
  assert.equal(detectedCiMarker({ CI: "", GITHUB_ACTIONS: "false", TF_BUILD: "0" }), null);
  assert.equal(detectedCiMarker({}), null);
  for (const marker of CATALOG_SIGNING_CI_MARKERS) assert.equal(detectedCiMarker({ [marker]: "yes" }), marker);
  // A verify or check under CI still runs: only signing is owner-only.
  const checked = await runCatalogManifestTool(["check"], { env: { CI: "true" } });
  assert.equal(checked.status, "ok");
});

test("sign refuses a key that is not the pinned key for its slot, and writes nothing", async () => {
  const payloadPath = join(directory, "unpinned-payload.json");
  const envelopePath = join(directory, "unpinned-envelope.json");
  await writeFile(payloadPath, canonicalCatalogPayloadText(projectBaselineManifest()));
  for (const slot of ["current", "next"]) {
    const refused = await tool(["sign", "--payload", payloadPath, "--channel", "staging", "--slot", slot,
      "--out", envelopePath, "--key-env", KEY_ENV], { [KEY_ENV]: privateKeyBase64 });
    assert.equal(refused.code, 1, refused.stderr);
    assert.deepEqual(JSON.parse(refused.stderr), {
      status: "error", code: "CATALOG_TOOL_SIGNING_KEY_NOT_PINNED", detail: "key",
    });
    assert.equal(refused.stderr.includes(privateKeyBase64), false);
  }
  await assert.rejects(readFile(envelopePath), { code: "ENOENT" });
  const badSlot = await tool(["sign", "--payload", payloadPath, "--channel", "staging", "--slot", "previous",
    "--out", envelopePath]);
  assert.equal(JSON.parse(badSlot.stderr).code, "CATALOG_TOOL_USAGE");
  // The default variable is the one `secret run ... --env` sets.
  const missing = await tool(["sign", "--payload", payloadPath, "--channel", "production", "--out", envelopePath]);
  assert.equal(JSON.parse(missing.stderr).code, "CATALOG_TOOL_SIGNING_KEY_UNAVAILABLE");
});

test("build, sign and verify: the owner step produces a verifiable envelope from the reviewed data file", async () => {
  const payloadPath = join(directory, "payload.json");
  const envelopePath = join(directory, "envelope.json");
  const built = await tool(["build", "--data", CATALOG_BASELINE_DATA_FILE, "--out", payloadPath]);
  assert.equal(built.code, 0, built.stderr);
  const payload = await readFile(payloadPath, "utf8");
  assert.equal(payload, canonicalCatalogPayloadText(projectBaselineManifest()));
  assert.equal(JSON.parse(built.stdout).digest, await webCryptoSha256Hex(payload));

  // The key arrives only through the named environment variable.
  const trustedKeysFor = syntheticPins(publicKeyBase64);
  const missing = await runCatalogManifestTool(["sign", "--payload", payloadPath, "--channel", "staging",
    "--out", envelopePath, "--key-env", KEY_ENV], { env: {}, cwd: directory, trustedKeysFor })
    .catch((error) => error);
  assert.equal(missing.code, "CATALOG_TOOL_SIGNING_KEY_UNAVAILABLE");

  const receipt = await runCatalogManifestTool(["sign", "--payload", payloadPath, "--channel", "staging",
    "--out", envelopePath, "--key-env", KEY_ENV], { env: { [KEY_ENV]: privateKeyBase64 }, cwd: directory,
    trustedKeysFor });
  const reference = catalogSigningKeyReference("staging", "current");
  assert.deepEqual([receipt.channel, receipt.slot, receipt.keyId, receipt.secretHelperName, receipt.pinned],
    ["staging", "current", reference.keyId, reference.secretHelperName, true]);
  assert.equal(receipt.publicKey, publicKeyBase64);
  assert.equal("secretManagerSecret" in receipt, false);
  assert.equal(JSON.stringify(receipt).includes(privateKeyBase64), false, "the private key never reaches the receipt");
  const envelopeText = await readFile(envelopePath, "utf8");
  assert.equal(envelopeText.includes(privateKeyBase64), false);

  // A raw 32-byte seed signs identically (Ed25519 is deterministic).
  const seed = decodeBase64(privateKeyBase64).slice(-32);
  const seedEnvelopePath = join(directory, "seed-envelope.json");
  await runCatalogManifestTool(["sign", "--payload", payloadPath, "--channel", "staging", "--out", seedEnvelopePath,
    "--key-env", KEY_ENV], { env: { [KEY_ENV]: encodeBase64(seed) }, cwd: directory, trustedKeysFor });
  assert.equal(await readFile(seedEnvelopePath, "utf8"), envelopeText);

  const verified = await tool(["verify", "--envelope", envelopePath, "--key-id", receipt.keyId,
    "--public-key", publicKeyBase64]);
  assert.equal(verified.code, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).digest, receipt.digest);

  // Against the real pins, a synthetic key under the staging key id fails the
  // signature, and on the production channel that key id is not trusted at all.
  const staging = await tool(["verify", "--envelope", envelopePath, "--channel", "staging"]);
  assert.equal(JSON.parse(staging.stderr).code, "CATALOG_SIGNATURE_INVALID");
  const production = await tool(["verify", "--envelope", envelopePath, "--channel", "production"]);
  assert.equal(JSON.parse(production.stderr).code, "CATALOG_KEY_UNTRUSTED");

  // A different key cannot verify, and a flipped payload byte fails the signature.
  const other = await syntheticKey();
  const wrongKey = await tool(["verify", "--envelope", envelopePath, "--key-id", receipt.keyId,
    "--public-key", other.publicKey]);
  assert.equal(JSON.parse(wrongKey.stderr).code, "CATALOG_SIGNATURE_INVALID");
  const envelope = JSON.parse(envelopeText);
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
