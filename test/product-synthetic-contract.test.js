import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv from "ajv";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/product-synthetic-contribution-v0.1.json", import.meta.url),
  "utf8",
));
const contributionSchema = JSON.parse(readFileSync(
  new URL("../schemas/product-synthetic-v0.1/contribution.schema.json", import.meta.url),
  "utf8",
));
const envelopeSchema = JSON.parse(readFileSync(
  new URL("../schemas/product-synthetic-v0.1/envelope.schema.json", import.meta.url),
  "utf8",
));

const ajv = new Ajv({ allErrors: true, strict: true });
const validateContribution = ajv.compile(contributionSchema);
const validateEnvelope = ajv.compile(envelopeSchema);

test("the checked-in consumer fixture matches the closed synthetic contribution contract", () => {
  assert.equal(validateContribution(fixture), true, JSON.stringify(validateContribution.errors));
});

test("the synthetic contribution contract rejects content and altered demo observations", () => {
  const withContent = structuredClone(fixture);
  withContent.prompt = "private content";
  assert.equal(validateContribution(withContent), false);

  const altered = structuredClone(fixture);
  altered.usage.inputCachedTokens += 1;
  assert.equal(validateContribution(altered), false);
});

test("the transport envelope is closed, synthetic-only, and bounded", () => {
  const valid = {
    schemaVersion: "synthetic-envelope-v0.1",
    synthetic: true,
    keyId: "key:local-development-v1",
    wrappedKey: "a".repeat(342),
    iv: "b".repeat(16),
    ciphertext: "c".repeat(256),
  };
  assert.equal(validateEnvelope(valid), true, JSON.stringify(validateEnvelope.errors));

  assert.equal(validateEnvelope({ ...valid, synthetic: false }), false);
  assert.equal(validateEnvelope({ ...valid, prompt: "private" }), false);
  assert.equal(validateEnvelope({ ...valid, keyId: `key:${"a".repeat(65)}` }), false);
  assert.equal(validateEnvelope({ ...valid, keyId: "key:invalid:suffix" }), false);
  assert.equal(validateEnvelope({ ...valid, wrappedKey: "a".repeat(341) }), false);
  assert.equal(validateEnvelope({ ...valid, wrappedKey: "a".repeat(343) }), false);
  assert.equal(validateEnvelope({ ...valid, iv: "b".repeat(15) }), false);
  assert.equal(validateEnvelope({ ...valid, ciphertext: "c".repeat(32769) }), false);
});
