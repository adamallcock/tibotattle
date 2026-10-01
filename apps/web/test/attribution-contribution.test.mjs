import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import { telemetryV11FieldInventory, telemetryV12FieldInventory } from "../../../src/contribution/index.js";
import { normalizeAttributionContributionReview, normalizeIncrementalContributionSyncStatus, CommunityClient } from "../public/data-client.js";
import { WEB_MESSAGES, translate } from "../public/localization.js";

const inventory = telemetryV11FieldInventory();
const payload = () => ({
  schemaVersion: "local-incremental-contribution-review-v1.1", status: "ready",
  reviewToken: "r".repeat(43), grantDeviceId: "11111111-1111-4111-8111-111111111111",
  consent: { ...inventory.consent, destinationOrigin: "https://telemetry.example" }, inventory,
  sample: { day: "2026-08-01", manifestDigest: "a".repeat(64), recordCounts: { usage: 2, quota: 2, session: 1 } },
  hostedConsentCurrent: false, includesContent: false, includesPaths: false,
  includesAccountIdentifiers: false, includesCredentials: false,
});

test("review normalization binds exact versions and safely rejects unreviewed or malformed evidence", () => {
  assert.ok(normalizeAttributionContributionReview(payload()));
  for (const alter of [
    (value) => { value.includesContent = true; },
    (value) => { value.consent.fieldDictionaryVersion = "old"; },
    (value) => { value.consent.destinationOrigin += "/private"; },
    (value) => { value.consent.extra = "private"; },
    (value) => { value.inventory.fields.usage.push("<script>"); },
    (value) => { value.inventory.accountBases.push("guessed"); },
    (value) => { value.sample.recordCounts.usage = null; },
    (value) => { value.grantDeviceId = "raw-account-id"; },
  ]) {
    const value = structuredClone(payload()); alter(value);
    assert.equal(normalizeAttributionContributionReview(value), null);
  }
  const value = { ...payload(), untrustedPrivatePath: "/private/synthetic-canary" };
  assert.doesNotMatch(JSON.stringify(normalizeAttributionContributionReview(value)), /synthetic-canary/u);
});

test("the hosted grant uses the fixed session/CSRF route, never upload device authorization", async () => {
  const calls = [];
  const client = new CommunityClient({ getCsrfToken: () => "synthetic-csrf", fetchImpl: async (url, options) => {
    calls.push({ url, options }); return { ok: true, status: 200, json: async () => ({ status: "granted" }) };
  } });
  await client.grantAttributionContribution(normalizeAttributionContributionReview(payload()));
  assert.equal(calls[0].url, "/api/v1/me/device-telemetry-consents");
  assert.equal(calls[0].options.headers["X-Usage-Monitor-CSRF"], "synthetic-csrf");
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.deepEqual(JSON.parse(calls[0].options.body).consent, inventory.consent);
});

test("all attribution approval copy has explicit English, Chinese and Spanish messages", () => {
  const entries = Object.entries(WEB_MESSAGES).filter(([key]) => key.startsWith("attributionConsent."));
  assert.ok(entries.length >= 20);
  for (const [key, messages] of entries) {
    assert.equal(messages.length, 3, key);
    assert.ok(messages.every((message) => typeof message === "string" && message.length > 0), key);
  }
  for (const key of ["consent.repairRequired", "consent.repairConnection", "consent.repairIncomplete", "consent.reviewAndApprove"]) {
    assert.equal(WEB_MESSAGES[key]?.length, 3, key);
    assert.ok(WEB_MESSAGES[key].every((message) => message.length > 0), key);
  }
});

test("successor review validates the exact v1.2 contract", () => {
  const inventory = telemetryV12FieldInventory();
  const source = { ...payload(), schemaVersion: "local-incremental-contribution-review-v1.2", inventory,
    consent: { ...inventory.consent, destinationOrigin: "https://telemetry.example" } };
  const review = normalizeAttributionContributionReview(source);
  assert.equal(review.consent.telemetrySchemaVersion, "telemetry-contribution-v1.2");
  assert.ok(review.inventory.fields.usage.includes("boundaryFlags"));
  assert.equal(normalizeAttributionContributionReview({ ...source, consent: payload().consent }), null);
});
