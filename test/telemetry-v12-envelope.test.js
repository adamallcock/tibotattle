import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { parseTelemetryV11Chunk, parseTelemetryV12Chunk } from "@app-usagemonitor/telemetry-contract";
import { createTelemetryV12Day } from "../src/contribution/index.js";
import { createTelemetryV12Envelope } from "../src/platform/index.js";

function chunk() {
  return createTelemetryV12Day({
    day: "2026-09-21", parserVersion: "synthetic-v17",
    activationTime: "2026-09-21T00:00:00.000Z",
    continuityForRecord: () => ({ boundaryFlags: 3, tieOrder: 0 }),
    recordsByStream: { usage: [{
      schemaVersion: "usage-event-v1.0", eventId: "event:synthetic-envelope",
      eventTime: "2026-09-21T12:00:00.000Z", sessionUuid: "synthetic-session",
      provider: "openai_codex", modelId: "gpt-5.6-sol", speedMode: "standard",
      apiServiceTier: "unknown", surface: "local_interactive_unclassified",
      billingSurface: "chatgpt_subscription", reasoningEffort: "high", agentScope: "root",
      outcome: "unknown", totalInputContextTokens: 100,
      components: { inputUncachedTokens: 100, inputCacheReadTokens: 0,
        inputCacheWriteTokens: 0, outputTextTokens: 5, outputReasoningTokens: 2,
        outputCombinedTokens: 7 },
    }] },
  }).chunks[0];
}

test("v1.2 encryption preserves successor bytes and cannot be decoded as v1.1", async () => {
  const keys = await webcrypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
  const source = chunk();
  const envelope = await createTelemetryV12Envelope({ chunk: source,
    publicJwk: await webcrypto.subtle.exportKey("jwk", keys.publicKey), keyId: "key:synthetic" });
  assert.equal(envelope.schemaVersion, "telemetry-envelope-v1.2");
  const rawKey = await webcrypto.subtle.decrypt({ name: "RSA-OAEP" }, keys.privateKey,
    Buffer.from(envelope.wrappedKey, "base64url"));
  const key = await webcrypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  const plaintext = await webcrypto.subtle.decrypt({ name: "AES-GCM",
    iv: Buffer.from(envelope.iv, "base64url") }, key, Buffer.from(envelope.ciphertext, "base64url"));
  const decoded = JSON.parse(new TextDecoder().decode(plaintext));
  assert.deepEqual(parseTelemetryV12Chunk(decoded), source);
  assert.throws(() => parseTelemetryV11Chunk(decoded));
  const usage = decoded.records[0];
  assert.equal(usage.boundaryFlags, 3);
  assert.equal(usage.components.outputCombinedTokens, 7);
  new Uint8Array(rawKey).fill(0);
  new Uint8Array(plaintext).fill(0);
});

test("v1.2 encryption refuses unknown fields before importing a wrapping key", async () => {
  const source = structuredClone(chunk());
  source.records[0].prompt = "synthetic-private-canary";
  let touched = false;
  await assert.rejects(createTelemetryV12Envelope({ chunk: source, publicJwk: {}, keyId: "key:synthetic",
    cryptoImpl: { getRandomValues: () => assert.fail("must not encrypt"),
      subtle: { importKey() { touched = true; assert.fail("must not import"); } } } }),
  /Telemetry chunk serialization failed/u);
  assert.equal(touched, false);
});
