import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import { telemetryV11FieldInventory } from "../../../src/contribution/index.js";
import { normalizeAttributionContributionReview, normalizeIncrementalContributionSyncStatus, CommunityClient } from "../public/data-client.js";
import { WEB_MESSAGES, translate } from "../public/localization.js";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const inventory = telemetryV11FieldInventory();
const payload = () => ({
  schemaVersion: "local-incremental-contribution-review-v1.1", status: "ready",
  reviewToken: "r".repeat(43), grantDeviceId: "11111111-1111-4111-8111-111111111111",
  consent: { ...inventory.consent, destinationOrigin: "https://telemetry.example" }, inventory,
  sample: { day: "2026-08-01", manifestDigest: "a".repeat(64), recordCounts: { usage: 2, quota: 2, session: 1 } },
  hostedConsentCurrent: false, includesContent: false, includesPaths: false,
  includesAccountIdentifiers: false, includesCredentials: false,
});
const production = (name) => {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, "mu"));
  assert.ok(match, `production ${name} is available`);
  return match[0];
};

const repairStatus = (selected = false) => normalizeIncrementalContributionSyncStatus({
  schemaVersion: "local-incremental-contribution-sync-v1.0", status: "available",
  ...(selected ? { contractVersion: inventory.consent.telemetrySchemaVersion } : {}),
  consent: { approved: true, current: true, consentedAt: "2026-08-01T00:00:00.000Z" },
  paused: true, pausedReason: "device_repair_required", running: false,
  progress: null, lastOutcome: null, lastAttemptAt: null, nextAttemptAt: null,
  includesContent: false, includesPaths: false, includesIdentifiers: false, includesCredentials: false,
});

function harness({ accepted = true, selected = false, signedIn = true, localFailure = false, repairRequired = false, pairFailure = false } = {}) {
  const elements = new Map();
  const node = (id = "") => ({ id, hidden: true, disabled: false, checked: false,
    textContent: "", children: [], append(...values) { this.children.push(...values); },
    replaceChildren(...values) { this.children = values; }, focus() { state.focused = id; } });
  const element = (id) => { if (!elements.has(id)) elements.set(id, node(id)); return elements.get(id); };
  element("#incremental-consent-approve").hidden = false;
  const state = { calls: [], focused: null, polls: 0, locale: "en-US" };
  const context = createContext({
    $: element, document: { createElement: () => node() },
    TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION: inventory.consent.telemetrySchemaVersion,
    incrementalSyncStatus: repairRequired ? repairStatus(selected) : { ...(selected ? { contractVersion: inventory.consent.telemetrySchemaVersion,
      consent: { approved: true, current: true } } : {}),
      ...(accepted ? { attributionUpgradeAvailable: true } : {}) },
    attributionContributionBusy: false, attributionContributionReview: null, attributionContributionNotice: null,
    incrementalConsentBusy: false, communityConnectBusy: false, contributionDisconnectBusy: false,
    incrementalConsentApproved: true, incrementalSyncRetryBusy: false, incrementalRepairAttempted: false,
    contributionSyncExactReview: null, contributionSyncPreview: null,
    contributionDisconnectOutcome: null, hostedIdentity: null,
    contributionDisconnectDialogOpen: () => false, contributionDeviceDisconnectPaused: () => false,
    contributionDisconnectBlocksRepair: () => false, hostedSignInRequired: () => !signedIn,
    incrementalSyncCapabilityAdvertised: () => true, keychainPromptSurface: () => "none",
    hasCommunitySession: () => signedIn,
    forgetLocalizedNode() {},
    formatNumber: String, setRawText: (target, value) => { target.textContent = value; },
    setLocalizedText: (target, key, values = {}) => { target.textContent = translate(key, values, state.locale); },
    t: (key, values = {}) => translate(key, values, state.locale),
    localClient: {
      async pairContributionDevice() { state.calls.push("pair"); if (pairFailure) throw new Error("synthetic lost receipt"); },
      async localContributionMutation() { state.calls.push("run"); return {}; },
      async reviewAttributionContribution() { state.calls.push("review"); return normalizeAttributionContributionReview(payload()); },
      async approveAttributionContribution(value) {
        state.calls.push("approve-local"); assert.equal(value.consent.fieldDictionaryVersion, inventory.consent.fieldDictionaryVersion);
        if (localFailure) throw new Error("synthetic failure without sensitive content");
        return { status: "approved", contractVersion: inventory.consent.telemetrySchemaVersion };
      },
    },
    communityClient: { async grantAttributionContribution(value) {
      state.calls.push("grant-hosted"); assert.equal(value.grantDeviceId, payload().grantDeviceId);
    } },
    async mintDevicePairingWithCookieCommitRetry() { state.calls.push("mint"); return { pairingCode: "synthetic-pairing" }; },
    normalizeIncrementalContributionSyncStatus, observeContributionDisconnectPause() {}, boundedOutcomeDetailCode: () => null,
    async loadIncrementalSyncStatus() { context.incrementalSyncStatus = { ...context.incrementalSyncStatus,
      contractVersion: inventory.consent.telemetrySchemaVersion, consent: { approved: true, current: true },
      paused: false, pausedReason: null }; },
    scheduleIncrementalSyncStatusPoll() { state.polls += 1; },
    renderContributionActionState() { context.renderAttributionContribution(); },
  });
  runInContext(["attributionContributionSelected", "renderAttributionContribution", "ensureAttributionHostedSession",
    "openAttributionContributionReview", "approveAttributionContribution", "approveIncrementalContribution",
    "maybeRepairIncrementalAuthorization", "resumeContributionCeremonyAfterSignIn", "incrementalGrantRejected",
    "incrementalUploadAuthorityLost", "renderIncrementalConsent", "renderIncrementalSyncStatusLine",
    "renderIncrementalSyncRetry", "hideIncrementalSyncRetryNote", "runIncrementalSyncNow"].map(production).join("\n"), context);
  return { context, element, elements, state };
}

test("additional contribution review stays hidden unless accepted or explicitly selected", async () => {
  const { context, element, state } = harness({ accepted: false });
  context.renderAttributionContribution();
  assert.equal(element("#attribution-consent").hidden, true);
  await context.openAttributionContributionReview();
  assert.deepEqual(state.calls, []);
  const enabled = harness();
  enabled.context.renderAttributionContribution();
  assert.equal(enabled.element("#attribution-consent").hidden, false);
  assert.equal(enabled.element("#attribution-review").hidden, true);
});

test("review renders field inventory and caveats but never its device capability or token", async () => {
  const { context, element, elements, state } = harness();
  await context.openAttributionContributionReview();
  assert.deepEqual(state.calls, ["review"]);
  assert.equal(state.focused, "#attribution-review-title");
  assert.equal(element("#attribution-consent-approve").disabled, true);
  assert.equal(element("#attribution-review-inventory").children.length, 4);
  const visible = JSON.stringify([...elements.values()].map((value) => ({ text: value.textContent, children: value.children })));
  assert.match(visible, /accountTrackId/u);
  assert.match(visible, /Verified sample day/u);
  assert.doesNotMatch(visible, /11111111-1111-4111-8111-111111111111|rrrrrrrr|enrollmentNamespace|scopeId/u);
});

test("approval requires an explicit checkbox and hosted session, then grant before local approval", async () => {
  const { context, element, state } = harness();
  await context.openAttributionContributionReview();
  await context.approveAttributionContribution();
  assert.deepEqual(state.calls, ["review"]);
  element("#attribution-consent-confirm").checked = true;
  await context.approveAttributionContribution();
  assert.deepEqual(state.calls, ["review", "grant-hosted", "approve-local"]);
  assert.equal(state.polls, 1);
  assert.equal(context.attributionContributionReview, null);
  assert.match(element("#attribution-consent-description").textContent, /Historical identity remains unknown/u);
  const unsigned = harness({ signedIn: false });
  await unsigned.context.openAttributionContributionReview();
  unsigned.element("#attribution-consent-confirm").checked = true;
  await unsigned.context.approveAttributionContribution();
  assert.deepEqual(unsigned.state.calls, ["review"]);
});

test("a granted but unfinished local approval asks for fresh review without fallback or a success claim", async () => {
  const { context, element, state } = harness({ localFailure: true });
  await context.openAttributionContributionReview();
  element("#attribution-consent-confirm").checked = true;
  await context.approveAttributionContribution();
  assert.deepEqual(state.calls, ["review", "grant-hosted", "approve-local"]);
  assert.equal(state.polls, 0);
  assert.equal(context.attributionContributionReview, null);
  assert.match(element("#attribution-consent-status").textContent, /Approval could not finish/u);
});

test("successor consent never silently resumes or downgrades to the old approval ceremony", async () => {
  const { context, state } = harness({ selected: true });
  context.maybeRepairIncrementalAuthorization();
  context.resumeContributionCeremonyAfterSignIn();
  assert.deepEqual(state.calls, []);
  await context.approveIncrementalContribution();
  assert.deepEqual(state.calls, ["review"]);
});

for (const selected of [false, true]) {
  test(`${selected ? "successor" : "legacy"} repair-required status offers explicit repair, not retry or automatic repair`, async () => {
    const { context, element, state } = harness({ selected, repairRequired: true });
    assert.equal(context.incrementalSyncStatus.status, "available");
    assert.equal(context.incrementalSyncStatus.pausedReason, "device_repair_required");
    assert.equal(context.incrementalSyncStatus.consent.current, true);
    assert.equal(context.incrementalUploadAuthorityLost(), true);
    context.renderIncrementalConsent();
    const button = element(selected ? "#attribution-review-open" : "#incremental-consent-approve");
    assert.equal(button.hidden, false);
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, "Repair connection");
    assert.match(element("#incremental-sync-status").textContent, /Sharing is paused.*history is preserved/u);
    assert.doesNotMatch(element("#incremental-sync-status").textContent, /refreshing|device_repair_required/u);
    assert.equal(element("#incremental-sync-retry").hidden, true);
    context.maybeRepairIncrementalAuthorization();
    context.resumeContributionCeremonyAfterSignIn();
    await context.runIncrementalSyncNow();
    assert.deepEqual(state.calls, [], "no old credential request or automatic re-pair escapes the pause");
  });
}

test("explicit approved successor repair finishes without racing its resumed upload with a new review", async () => {
  const { context, element, state } = harness({ selected: true, repairRequired: true });
  context.renderAttributionContribution();
  assert.match(element("#attribution-consent-description").textContent, /Sharing is paused/u);
  context.localClient.reviewAttributionContribution = async () => {
    throw new Error("review would conflict with the resumed upload");
  };
  await context.openAttributionContributionReview();
  assert.deepEqual(state.calls, ["mint", "pair"]);
  assert.equal(state.polls, 1);
  assert.equal(context.attributionContributionReview, null);
  assert.equal(context.incrementalSyncStatus.contractVersion, inventory.consent.telemetrySchemaVersion);
  assert.equal(context.incrementalSyncStatus.consent.current, true);
  assert.equal(element("#attribution-consent-confirm").checked, false);
  assert.match(element("#attribution-consent-status").textContent, /authorization is refreshed/u);
});

test("an ambiguous successor repair keeps the pause and never claims review or upload success", async () => {
  const { context, element, state } = harness({ selected: true, repairRequired: true, pairFailure: true });
  await context.openAttributionContributionReview();
  assert.deepEqual(state.calls, ["mint", "pair"]);
  assert.equal(state.polls, 0);
  assert.equal(context.incrementalSyncStatus.pausedReason, "device_repair_required");
  assert.match(element("#attribution-consent-status").textContent, /could not be confirmed.*Sharing stays paused/u);
});

test("stale successor consent repairs before review but still requires its fresh checkbox and hosted grant", async () => {
  const { context, element, state } = harness({ selected: true, repairRequired: true });
  context.incrementalSyncStatus = { ...context.incrementalSyncStatus, consent: { approved: true, current: false } };
  context.localClient.reviewAttributionContribution = async () => {
    assert.equal(state.calls.includes("pair"), true, "the real review route refuses a repair-required pause");
    state.calls.push("review"); return normalizeAttributionContributionReview(payload());
  };
  await context.openAttributionContributionReview();
  assert.deepEqual(state.calls, ["mint", "pair", "review"]);
  assert.equal(element("#attribution-consent-confirm").checked, false);
  await context.approveAttributionContribution();
  assert.deepEqual(state.calls, ["mint", "pair", "review"]);
  element("#attribution-consent-confirm").checked = true;
  await context.approveAttributionContribution();
  assert.deepEqual(state.calls, ["mint", "pair", "review", "grant-hosted", "approve-local"]);
});

test("a legacy repair pause directs to the existing repair before a separate successor review", async () => {
  const { context, element, state } = harness({ repairRequired: true });
  context.incrementalSyncStatus = { ...context.incrementalSyncStatus, attributionUpgradeAvailable: true };
  await context.openAttributionContributionReview();
  assert.deepEqual(state.calls, [], "no review can race the existing repair or its resumed v1 upload");
  assert.match(element("#attribution-consent-status").textContent, /existing sharing setting first.*separately/u);
  assert.equal(context.attributionContributionReview, null);
  // The separate legacy ceremony is exercised with the real client in lib.test.mjs.
  // Only its completed/idle status makes the subsequent new-format review safe.
  context.incrementalSyncStatus = { ...context.incrementalSyncStatus, paused: false, pausedReason: null };
  await context.openAttributionContributionReview();
  assert.deepEqual(state.calls, ["review"]);
  await context.approveAttributionContribution();
  assert.deepEqual(state.calls, ["review"]);
  element("#attribution-consent-confirm").checked = true;
  await context.approveAttributionContribution();
  assert.deepEqual(state.calls, ["review", "grant-hosted", "approve-local"]);
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
