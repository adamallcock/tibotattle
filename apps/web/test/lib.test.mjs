import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  buildSyntheticFixture,
  bytesToBase64Url,
  createSyntheticEnvelope,
  ENVELOPE_SCHEMA_VERSION,
  safeApiError,
  safeFilename,
  validateSyntheticFixture
} from "../public/lib.js";

test("the fixture is synthetic, stable, and content-free", () => {
  const fixture = buildSyntheticFixture();
  assert.equal(validateSyntheticFixture(fixture), true);
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.fixtureId, "codex-weekly-demo-v0.1");
  assert.equal(fixture.usage.inputCachedTokens, 900000);

  const serialized = JSON.stringify(fixture).toLowerCase();
  for (const forbidden of ["prompt", "response", "content", "path", "command", "email", "repository"]) {
    assert.equal(serialized.includes(forbidden), false, `fixture must not include ${forbidden}`);
  }
});

test("modified fixture is rejected", () => {
  const fixture = buildSyntheticFixture();
  fixture.usage.modelId = "user-controlled";
  assert.throws(() => validateSyntheticFixture(fixture), /must not be modified/);
});

test("base64url encoding is unpadded and URL safe", () => {
  assert.equal(bytesToBase64Url(new Uint8Array([])), "");
  assert.equal(bytesToBase64Url(new TextEncoder().encode("f")), "Zg");
  assert.equal(bytesToBase64Url(new TextEncoder().encode("fo")), "Zm8");
  assert.equal(bytesToBase64Url(new TextEncoder().encode("foo")), "Zm9v");
  assert.equal(bytesToBase64Url(new Uint8Array([251, 255])), "-_8");
});

test("hybrid envelope can be decrypted with the matching private key", async () => {
  const pair = await webcrypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["encrypt", "decrypt"]
  );
  const publicJwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const envelope = await createSyntheticEnvelope({
    publicJwk,
    keyId: "key:test",
    cryptoImpl: webcrypto
  });

  assert.equal(envelope.schemaVersion, ENVELOPE_SCHEMA_VERSION);
  assert.equal(envelope.synthetic, true);
  assert.equal(envelope.keyId, "key:test");
  assert.ok(envelope.ciphertext.length > 100);
  assert.ok(envelope.wrappedKey.length > 100);
  assert.notEqual(envelope.ciphertext, JSON.stringify(buildSyntheticFixture()));

  const decode = (value) => new Uint8Array(Buffer.from(value, "base64url"));
  const rawPayloadKey = await webcrypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    pair.privateKey,
    decode(envelope.wrappedKey)
  );
  const payloadKey = await webcrypto.subtle.importKey(
    "raw",
    rawPayloadKey,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const plaintext = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: decode(envelope.iv) },
    payloadKey,
    decode(envelope.ciphertext)
  );
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(plaintext)),
    buildSyntheticFixture()
  );
});

test("export filenames cannot inject paths", () => {
  assert.equal(safeFilename("../../private id"), "usage-monitor-privateid-export.json");
});

test("API errors expose only bounded server codes", () => {
  assert.equal(safeApiError({ error: { code: "INVALID_ENVELOPE" } }, "failed"), "INVALID ENVELOPE");
  assert.equal(safeApiError({ error: "<script>alert(1)</script>" }, "failed"), "failed");
  assert.equal(safeApiError({ message: "private server detail" }, "failed"), "failed");
});

test("public interface has no arbitrary content or real-log upload control", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /type=["']file["']/i);
  assert.doesNotMatch(html, /<textarea/i);
  assert.doesNotMatch(html, /contenteditable/i);
  assert.match(html, /id="delete-phrase"/);
  assert.match(html, /Fixed synthetic records only/);
});

test("the browser enrollment request carries the exact synthetic consent contract", async () => {
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(appSource, /consentVersion:\s*"synthetic-preview-v0\.1"/);
  assert.match(appSource, /syntheticOnly:\s*true/);
});

test("the consumer UI exposes recovery and sends only the recovery capability", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(html, /id="recovery-access"/);
  assert.match(html, /id="recovery-input"/);
  assert.match(appSource, /api\("\/recover"/);
  assert.match(appSource, /body:\s*\{ recoveryCode \}/);
});
