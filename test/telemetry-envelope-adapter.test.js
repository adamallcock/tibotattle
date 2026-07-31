import test from "node:test";
import assert from "node:assert/strict";

import * as telemetryEnvelopeAdapter from "../src/platform/telemetry-envelope.js";
import {
  telemetryV01Golden,
  telemetryV02Golden,
} from "./fixtures/telemetry-contract-vectors.mjs";

function deferredCrypto({ plaintexts = [] } = {}) {
  let releaseImport;
  let importStarted;
  const importGate = new Promise((resolve) => {
    releaseImport = resolve;
  });
  const importStartedGate = new Promise((resolve) => {
    importStarted = resolve;
  });
  return {
    plaintexts,
    releaseImport() {
      releaseImport();
    },
    importStarted: importStartedGate,
    cryptoImpl: {
      getRandomValues(bytes) {
        bytes.fill(11);
        return bytes;
      },
      subtle: {
        importKey() {
          importStarted();
          return importGate.then(() => ({ kind: "wrapping-key" }));
        },
        async generateKey() {
          return { kind: "payload-key" };
        },
        async encrypt(algorithm, _key, data) {
          const input = new Uint8Array(data);
          if (algorithm.name === "AES-GCM") {
            plaintexts.push(new TextDecoder().decode(input));
            return Uint8Array.from([0xa5, ...input.slice(0, 11)]).buffer;
          }
          return new Uint8Array(256).buffer;
        },
        async exportKey() {
          return Uint8Array.from([1, 2, 3, 4]).buffer;
        },
      },
    },
  };
}

test("Node telemetry envelope adapter exposes only validated real encryption", () => {
  assert.deepEqual(
    Object.keys(telemetryEnvelopeAdapter),
    ["createTelemetryEnvelope"],
  );
});

test("Node adapter validates private payloads before touching Web Crypto", async () => {
  let cryptoReads = 0;
  const cryptoImpl = new Proxy({}, {
    get() {
      cryptoReads += 1;
      throw new Error("Web Crypto must not be reached");
    },
  });

  await assert.rejects(
    telemetryEnvelopeAdapter.createTelemetryEnvelope({
      payload: {
        schemaVersion: "telemetry-contribution-v0.1",
        synthetic: false,
        content: "private-content-canary",
      },
      publicJwk: {},
      keyId: "key:test",
      cryptoImpl,
    }),
    (error) => error?.code === "PRIVACY_CANARY_DETECTED",
  );
  assert.equal(cryptoReads, 0);
});

test("Node adapter rejects key IDs above the closed envelope maximum", async () => {
  await assert.rejects(
    telemetryEnvelopeAdapter.createTelemetryEnvelope({
      payload: telemetryV01Golden(),
      publicJwk: {},
      keyId: `key:${"a".repeat(65)}`,
    }),
    (error) => (
      error instanceof TypeError
      && error.message === "A public JWK and key ID are required."
    ),
  );
});

test("Node adapter snapshots validated bytes before deferred crypto", async () => {
  const payload = telemetryV01Golden();
  const expectedPlaintext = JSON.stringify(payload);
  const deferred = deferredCrypto();
  const pending = telemetryEnvelopeAdapter.createTelemetryEnvelope({
    payload,
    publicJwk: { kty: "RSA", n: "safe", e: "AQAB" },
    keyId: "key:snapshot",
    cryptoImpl: deferred.cryptoImpl,
  });

  payload.usageEvents[0].prompt = "private-content-canary";
  payload.usageEvents[0].components.outputReasoningTokens = 999_999;
  await deferred.importStarted;
  assert.deepEqual(deferred.plaintexts, []);
  deferred.releaseImport();
  await pending;

  assert.deepEqual(deferred.plaintexts, [expectedPlaintext]);
  assert.equal(
    deferred.plaintexts[0].includes("private-content-canary"),
    false,
  );
});

test("Node adapter preserves the v0.2 plaintext snapshot", async () => {
  const payload = telemetryV02Golden();
  const deferred = deferredCrypto();
  const pending = telemetryEnvelopeAdapter.createTelemetryEnvelope({
    payload,
    publicJwk: { kty: "RSA", n: "safe", e: "AQAB" },
    keyId: "key:v02",
    cryptoImpl: deferred.cryptoImpl,
  });

  await deferred.importStarted;
  deferred.releaseImport();
  await pending;
  assert.deepEqual(deferred.plaintexts, [JSON.stringify(payload)]);
});

test("Node adapter normalizes Proxy serialization faults before crypto", async () => {
  let cryptoReads = 0;
  const cryptoImpl = new Proxy({}, {
    get() {
      cryptoReads += 1;
      throw new Error("Web Crypto must not be reached");
    },
  });
  const payload = new Proxy(telemetryV01Golden(), {
    get(target, property, receiver) {
      if (property === "toJSON") {
        throw new Error("private-content-canary");
      }
      return Reflect.get(target, property, receiver);
    },
  });

  await assert.rejects(
    telemetryEnvelopeAdapter.createTelemetryEnvelope({
      payload,
      publicJwk: { kty: "RSA", n: "safe", e: "AQAB" },
      keyId: "key:serialization",
      cryptoImpl,
    }),
    {
      name: "TypeError",
      message: "Telemetry payload serialization failed.",
    },
  );
  assert.equal(cryptoReads, 0);
});
