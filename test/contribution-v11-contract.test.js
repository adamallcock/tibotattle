import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import {
  canonicalTelemetryV11Json, parseTelemetryV11Attribution, parseTelemetryV11Chunk,
  parseTelemetryV11DayManifest, telemetryV11DayManifestDigestInput,
  telemetryV11RequiredConsent, validateTelemetryV11Envelope,
} from "@app-usagemonitor/telemetry-contract";
import * as browser from "../apps/web/public/telemetry-shared.generated.js";
import { createTelemetryV11Day, deriveTelemetryV11Attribution, deriveTelemetryV11QuotaOccurrenceId } from "../src/contribution/index.js";
import { createTelemetryV11Envelope } from "../src/platform/telemetry-v11-envelope.js";

const day = "2026-08-28";
const binding = { destinationOrigin: "https://community.example.test", enrollmentNamespace: "synthetic_enrollment_one" };
const root = Buffer.alloc(32, 85);
const scope = { status: "available", reason: null, version: "openai-account-v1",
  scopeId: `openai-account:v1:${Buffer.alloc(32, 82).toString("base64url")}`, planType: "pro" };
const hash = (value) => createHash("sha256").update(value).digest("hex");
function usage(fill = "a") {
  return { schemaVersion: "usage-event-v1.0", eventId: `event:v2:${fill.repeat(64)}`,
    eventTime: `${day}T12:05:00.000Z`, sessionUuid: "session-fixture-1", provider: "openai_codex",
    modelId: "gpt-5.6-sol", speedMode: "standard", apiServiceTier: "default",
    surface: "local_interactive_unclassified", billingSurface: "chatgpt_subscription",
    reasoningEffort: "high", agentScope: "root", outcome: "completed", totalInputContextTokens: 1000,
    components: { inputUncachedTokens: 100, inputCacheReadTokens: 900, inputCacheWriteTokens: 0,
      outputTextTokens: 50, outputReasoningTokens: 25, outputCombinedTokens: null } };
}
function quota() {
  return { schemaVersion: "quota-observation-v1.0",
    observationId: deriveTelemetryV11QuotaOccurrenceId({ sourceRecordDigest: "a".repeat(64), limitId: "codex", slot: "secondary" }),
    observedTime: `${day}T12:05:00.000Z`, provider: "openai_codex", planType: "plus", planVariant: "unknown",
    limitId: "codex", slot: "secondary", usedPercent: 20, windowDurationMinutes: 10080,
    resetsAt: "2026-08-31T12:05:00.000Z" };
}
function prepare(overrides = {}) {
  return createTelemetryV11Day({ day, recordsByStream: { usage: [usage()], quota: [quota()] },
    parserVersion: "synthetic-v11", ...overrides });
}

test("v1.1 keeps event-time plan when historical account/enrollment proof is missing", () => {
  const value = deriveTelemetryV11Attribution({ accountBasis: "same_source", accountScope: scope,
    planBasis: "same_source_occurrence", planType: "pro", eraStartOccurrenceId: "event-era-1" },
  { accountObservationSecret: root, binding });
  assert.deepEqual(value, { accountBasis: "unavailable", accountTrackId: null,
    planBasis: "same_source_occurrence", planType: "pro", planEraId: null });
  assert.deepEqual(parseTelemetryV11Attribution(value), browser.parseTelemetryV11Attribution(value));
});

test("v1.1 separates account roots and plan eras; provisional remains provisional", () => {
  const evidence = { accountBasis: "provisional_marker", accountScope: scope, observationBinding: binding,
    planBasis: "provisional_marker", planType: "pro", eraStartOccurrenceId: "event-era-1" };
  const one = deriveTelemetryV11Attribution(evidence, { accountObservationSecret: root, binding });
  const returned = deriveTelemetryV11Attribution({ ...evidence, eraStartOccurrenceId: "event-era-3" },
    { accountObservationSecret: root, binding });
  const plus = deriveTelemetryV11Attribution({ ...evidence, planType: "plus", eraStartOccurrenceId: "event-era-2" },
    { accountObservationSecret: root, binding });
  assert.match(one.accountTrackId, /^account-track:v2:[0-9a-f]{64}$/u);
  assert.equal(one.accountBasis, "provisional_marker");
  assert.equal(plus.accountTrackId, one.accountTrackId);
  assert.equal(returned.accountTrackId, one.accountTrackId);
  assert.equal(new Set([one.planEraId, plus.planEraId, returned.planEraId]).size, 3);
  assert.equal(deriveTelemetryV11Attribution(evidence, { accountObservationSecret: root,
    binding: { ...binding, enrollmentNamespace: "synthetic_enrollment_two" } }).accountTrackId, null);
  assert.equal(deriveTelemetryV11Attribution(evidence, { accountObservationSecret: null, binding }).accountTrackId, null);
});

test("v1.1 attribution is closed and rejects contradictory null/proof relations", () => {
  const valid = { accountBasis: "unavailable", accountTrackId: null,
    planBasis: "same_source_occurrence", planType: "pro", planEraId: null };
  for (const change of [{ rawAccount: "private-canary" }, { accountBasis: "same_source" },
    { accountTrackId: `account-track:v1:${"a".repeat(64)}` }, { planType: "unknown" },
    { planBasis: "unavailable" }, { planBasis: "conflicted" }, { planEraId: "raw-era-id" }]) {
    assert.throws(() => parseTelemetryV11Attribution({ ...valid, ...change }));
    assert.throws(() => browser.parseTelemetryV11Attribution({ ...valid, ...change }));
  }
});

test("day projection strips local fields and never stamps current profile on historical usage", () => {
  const base = { ...usage(), source_local: Buffer.alloc(32, 4), source_offset: 8,
    prompt: "private-synthetic-canary", currentPlan: "pro" };
  const prepared = prepare({ recordsByStream: { usage: [base], quota: [quota()] },
    accountObservationSecret: root, binding });
  const usageRow = prepared.chunks.find((chunk) => chunk.chunkId.startsWith("usage:")).records[0];
  const quotaRow = prepared.chunks[0].records[0];
  assert.equal(usageRow.accountPlanAttribution.planType, "unknown");
  assert.equal(quotaRow.accountPlanAttribution.planType, "plus");
  assert.equal(quotaRow.accountPlanAttribution.accountTrackId, null);
  assert.equal(JSON.stringify(prepared).includes("private-synthetic-canary"), false);
  assert.equal(JSON.stringify(prepared).includes(scope.scopeId), false);
  assert.equal(JSON.stringify(prepared).includes(binding.enrollmentNamespace), false);
  assert.equal(JSON.stringify(prepared).includes(root.toString("hex")), false);
  assert.equal(usageRow.eventId, base.eventId);
  base.components.inputUncachedTokens = 999;
  assert.equal(usageRow.components.inputUncachedTokens, 100);
  assert.ok(Object.isFrozen(usageRow.components));
});

test("quota plan survives account-only evidence and positive plan disagreement stays explicit", () => {
  const accountOnly = prepare({ attributionForRecord: () => ({ accountBasis: "unavailable", accountScope: null }) });
  assert.equal(accountOnly.chunks[0].records[0].planType, "plus");
  const conflict = prepare({ attributionForRecord: () => ({ planBasis: "same_source_occurrence", planType: "pro" }) });
  assert.equal(conflict.chunks[0].records[0].accountPlanAttribution.planBasis, "conflicted");
  assert.equal(conflict.chunks[0].records[0].planType, "unknown");
});

test("metadata-only quota plans stay on the wire with explicit null measurements", () => {
  const source = { ...quota(), slot: "unknown", usedPercent: null, windowDurationMinutes: null, resetsAt: null };
  const prepared = prepare({ recordsByStream: { quota: [source] } });
  const record = prepared.chunks[0].records[0];
  assert.equal(record.planType, "plus");
  assert.equal(record.accountPlanAttribution.planBasis, "same_source_occurrence");
  assert.equal(record.usedPercent, null);
  assert.deepEqual(browser.parseTelemetryV11Record("quota", record), record);
  for (const field of ["usedPercent", "windowDurationMinutes", "resetsAt"]) {
    assert.throws(() => browser.parseTelemetryV11Record("quota", { ...record, [field]: undefined }));
    assert.throws(() => prepare({ recordsByStream: { quota: [{ ...source, [field]: undefined }] } }));
  }
});

test("day digest, parser/consent vector, empty days, order and occurrence uniqueness are deterministic", () => {
  const prepared = prepare();
  assert.equal(prepared.manifest.manifestDigest, hash(telemetryV11DayManifestDigestInput(prepared.manifest)));
  for (const chunk of prepared.chunks) {
    assert.equal(chunk.chunkDigest, hash(canonicalTelemetryV11Json(chunk.records)));
    assert.equal(chunk.manifestDigest, prepared.manifest.manifestDigest);
    assert.deepEqual(parseTelemetryV11Chunk(chunk), browser.parseTelemetryV11Chunk(chunk));
  }
  assert.deepEqual(prepare(), prepared);
  assert.equal(prepare({ recordsByStream: {} }).manifest.chunks.length, 0);
  assert.throws(() => prepare({ recordsByStream: { usage: [usage(), usage()] } }));
  assert.throws(() => prepare({ recordsByStream: { usage: [{ ...usage(), eventTime: "2026-08-29T12:05:00.000Z" }] } }));
  assert.throws(() => parseTelemetryV11DayManifest({ ...prepared.manifest, consent: {
    ...telemetryV11RequiredConsent(), privacyContractVersion: "ongoing-privacy-safe-telemetry-v1.0" } }));
  assert.notEqual(deriveTelemetryV11QuotaOccurrenceId({ sourceRecordDigest: "b".repeat(64), limitId: "codex", slot: "secondary" }), quota().observationId);
});

test("v1.1 envelope snapshots the validated chunk and round-trips through RSA/AES", async () => {
  const pair = await webcrypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
  const publicJwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const source = structuredClone(prepare().chunks[0]);
  const pending = createTelemetryV11Envelope({ chunk: source, publicJwk, keyId: "key:synthetic", cryptoImpl: webcrypto });
  source.records[0].usedPercent = 99;
  const envelope = await pending;
  validateTelemetryV11Envelope(envelope);
  const keyBytes = await webcrypto.subtle.decrypt({ name: "RSA-OAEP" }, pair.privateKey, Buffer.from(envelope.wrappedKey, "base64url"));
  const key = await webcrypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(envelope.iv, "base64url") },
    key, Buffer.from(envelope.ciphertext, "base64url"));
  new Uint8Array(keyBytes).fill(0);
  const decoded = JSON.parse(new TextDecoder().decode(plaintext));
  assert.equal(decoded.records[0].usedPercent, 20);
  assert.equal(decoded.schemaVersion, "telemetry-contribution-v1.1");
  assert.deepEqual(validateTelemetryV11Envelope(envelope), browser.validateTelemetryV11Envelope(envelope));
});
