import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

import { CATALOGS, SUPPORTED_LOCALES } from "../../../packages/i18n/index.js";
import * as dataClient from "../public/data-client.js";
import { translate, WEB_MESSAGES, LEGACY_TEXT_CATALOG } from "../public/localization.js";
import { withContributionReviewDeadline } from "../public/lib.js";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

function productionFunction(name) {
  const match = appSource.match(new RegExp(
    `^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, "mu",
  ));
  assert.ok(match, `${name} is tested from production source`);
  return match[0];
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const receipt = Object.freeze({
  schemaVersion: "local-contribution-device-disconnect-v0.1",
  status: "disconnected",
  deliveryPaused: true,
  localCredential: "deleted",
  localBinding: "removed",
  hostedDataDeleted: false,
  includesIdentifiers: false,
  includesCredentials: false,
});

function createDisconnectHarness({
  session = true,
  configured = true,
  incremental = true,
  syncStatus = null,
  diagnostics = async () => ({
    status: "available", pairing: { observed: true, paired: true },
  }),
  disconnect = async () => dataClient.normalizeLocalContributionDeviceDisconnect(receipt),
} = {}) {
  const state = { focused: null, calls: 0, diagnosticReads: 0, statusReads: 0, repairs: 0, locale: "en-US" };
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      const attributes = new Map();
      const events = new EventTarget();
      elements.set(id, {
        id, hidden: false, disabled: false, open: false, textContent: "",
        get className() { return [...classes].join(" "); },
        set className(value) {
          classes.clear();
          for (const name of value.split(" ").filter(Boolean)) classes.add(name);
        },
        classList: {
          add(name) { classes.add(name); },
          remove(name) { classes.delete(name); },
          contains(name) { return classes.has(name); },
        },
        focus() { state.focused = id; },
        showModal() { this.open = true; },
        close() { this.open = false; },
        addEventListener(type, listener) { events.addEventListener(type, listener); },
        dispatchEvent(event) { return events.dispatchEvent(event); },
        setAttribute(name, value) { attributes.set(name, value); },
        removeAttribute(name) { attributes.delete(name); },
      });
    }
    return elements.get(id);
  }
  element("#disconnect-device-status").hidden = true;
  const context = createContext({
    $: element,
    contributionDisconnectBusy: false,
    contributionDisconnectChecking: false,
    contributionDisconnectAbsent: false,
    contributionDisconnectCheckGeneration: 0,
    contributionDisconnectOutcome: null,
    incrementalConsentBusy: false,
    incrementalConsentApproved: true,
    communityConnectBusy: false,
    incrementalSyncRetryBusy: false,
    incrementalRepairAttempted: false,
    incrementalSyncLastOutcomeDetailCode: null,
    contributionSyncPreview: null,
    contributionSyncExactReview: null,
    contributionSyncStatus: { counts: { accepted: 3 }, lastAcceptedAt: "2026-08-29T00:00:00Z" },
    incrementalSyncStatus: syncStatus ?? {
      status: "available", paused: false, pausedReason: null,
      consent: { approved: true, current: true }, progress: null, lastOutcome: null,
    },
    communityDevicePaired: true,
    communityDevicePairedV1: true,
    hostedIdentity: null,
    communitySession: session ? { csrfToken: "synthetic-csrf" } : null,
    dashboard: { localEvidence: "synthetic-retained-evidence" },
    localCompanionHealth: { capabilities: {
      contributionDeviceDisconnect: configured,
      incrementalContributionSync: incremental ? "telemetry-contribution-v1.0" : false,
    } },
    INCREMENTAL_SYNC_CONTRACT: "telemetry-contribution-v1.0",
    hasCommunitySession: () => context.communitySession !== null,
    hostedSignInRequired: () => context.communitySession === null,
    keychainPromptSurface: () => "none",
    renderCommunityJourney() {},
    approveIncrementalContribution() { state.repairs += 1; },
    forgetLocalizedNode() {},
    setRawText(target, value) { target.textContent = value; },
    setLocalizedText(target, key, values = {}) {
      target.key = key;
      target.values = values;
      target.textContent = translate(key, values, state.locale);
    },
    t: (key, values = {}) => translate(key, values, state.locale),
    formatNumber: String,
    finite: (value, fallback = null) => Number.isFinite(value) ? value : fallback,
    withContributionReviewDeadline,
    localClient: {
      async contributionDiagnostics() { state.diagnosticReads += 1; return diagnostics(); },
      async disconnectContributionDevice() { state.calls += 1; return disconnect(); },
    },
    async loadIncrementalSyncStatus() {
      state.statusReads += 1;
      context.renderContributionActionState();
    },
  });
  runInContext([
    "contributionDisconnectDialogOpen", "contributionDeviceDisconnectPaused",
    "observeContributionDisconnectPause",
    "contributionDisconnectBlocksRepair", "renderContributionDisconnect",
    "openContributionDisconnectDialog", "closeContributionDisconnectDialog",
    "disconnectCommunityDevice", "communityUploadAuthorityEvidence",
    "incrementalSyncCapabilityAdvertised", "incrementalGrantRejected",
    "incrementalUploadAuthorityLost", "renderContributionActionState",
    "renderIncrementalConsent", "renderIncrementalSyncStatusLine",
    "renderIncrementalSyncRetry", "hideIncrementalSyncRetryNote",
    "maybeRepairIncrementalAuthorization", "resumeContributionCeremonyAfterSignIn",
  ].map(productionFunction).join("\n\n"), context);
  const eventHandlers = appSource.match(
    /^\$\("#disconnect-device"\)\.addEventListener[\s\S]*?(?=^\$\("#range-controls"\))/mu,
  );
  assert.ok(eventHandlers, "disconnect event wiring is tested from production source");
  runInContext(eventHandlers[0], context);
  context.renderContributionActionState();
  return { context, state, element };
}

test("self-service participant deletion is absent from the UI, client, and catalogs", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const client = await readFile(new URL("../public/data-client.js", import.meta.url), "utf8");
  const retired = /delete-contributions|deleteCommunityContributions|deleteParticipant|normalizeParticipantDeletionReceipt|CONTRIBUTION_DELETION_CONFIRMATION|participant_deletion/u;
  for (const source of [html, appSource, client]) assert.doesNotMatch(source, retired);
  assert.equal(typeof dataClient.CommunityClient.prototype.deleteParticipant, "undefined");
  assert.equal(Object.hasOwn(dataClient, "normalizeParticipantDeletionReceipt"), false);
  assert.equal(Object.hasOwn(LEGACY_TEXT_CATALOG, "Delete my contributions"), false);
  assert.doesNotMatch(JSON.stringify(CATALOGS), /Delete my contributions|删除我的贡献|Eliminar mis contribuciones/u);
});

test("disconnect uses a labeled native dialog with a safe default and restored cancel focus", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<dialog[^>]+id="disconnect-device-dialog"[^>]+aria-labelledby="disconnect-device-title"[^>]+aria-describedby="disconnect-device-confirmation"/u);
  assert.match(html, /id="disconnect-device"[^>]+aria-haspopup="dialog"[^>]+aria-controls="disconnect-device-dialog"/u);
  assert.match(html, /id="disconnect-device-cancel"[^>]+autofocus/u);
  assert.match(html, /id="disconnect-device-status"[^>]+role="status"[^>]+tabindex="-1"/u);
  assert.match(appSource, /\$\("#disconnect-device-dialog"\)\.addEventListener\("cancel", \(event\) => \{\s*event\.preventDefault\(\);\s*closeContributionDisconnectDialog\(\);/u);
  const { context, state, element } = createDisconnectHarness();
  await context.openContributionDisconnectDialog();
  assert.equal(state.focused, "#disconnect-device-cancel");
  assert.equal(element("#disconnect-device-dialog").open, true);
  assert.equal(element("#incremental-consent-approve").disabled, true);
  const cancel = new Event("cancel", { cancelable: true });
  element("#disconnect-device-dialog").dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(state.focused, "#disconnect-device");
  assert.equal(element("#disconnect-device-dialog").open, false);
  assert.equal(state.calls, 0);
  await context.disconnectCommunityDevice();
  assert.equal(state.calls, 0, "confirmation cannot run outside an open dialog");
});

test("dialog Escape keydown restores opener focus without native cancel and leaves other keys alone", async () => {
  const { context, state, element } = createDisconnectHarness();
  await context.openContributionDisconnectDialog();
  const dialog = element("#disconnect-device-dialog");
  const sessionBefore = context.communitySession;
  const dashboardBefore = context.dashboard;
  let nativeCancels = 0;
  dialog.addEventListener("cancel", () => { nativeCancels += 1; });
  for (const key of ["Tab", "Enter", "ArrowDown", "a"]) {
    const event = Object.assign(new Event("keydown", { cancelable: true }), { key });
    assert.equal(dialog.dispatchEvent(event), true, `${key} keeps its default handling`);
    assert.equal(event.defaultPrevented, false, key);
    assert.equal(dialog.open, true, key);
    assert.equal(state.focused, "#disconnect-device-cancel", key);
  }
  const escape = Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
  assert.equal(dialog.dispatchEvent(escape), false);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(nativeCancels, 0, "the embed only forwarded keydown, not native cancel");
  assert.equal(dialog.open, false);
  assert.equal(state.focused, "#disconnect-device");
  assert.equal(state.calls, 0, "Escape never confirms disconnect");
  assert.equal(context.communitySession, sessionBefore);
  assert.equal(context.dashboard, dashboardBefore);
});

test("disconnect is available without a hosted session or incremental transport", async () => {
  for (const session of [false, true]) {
    const { context, state, element } = createDisconnectHarness({ session, incremental: false });
    context.communityDevicePaired = false;
    context.communityDevicePairedV1 = false;
    context.contributionSyncStatus = null;
    context.renderContributionActionState();
    assert.equal(element("#incremental-consent").hidden, true);
    assert.equal(element("#contribution-device-controls").hidden, false);
    assert.equal(element("#disconnect-device").disabled, false);
    assert.equal(state.diagnosticReads, 0, "rendering never probes the Keychain");
    const sessionBefore = context.communitySession;
    const dashboardBefore = context.dashboard;
    await context.openContributionDisconnectDialog();
    await context.disconnectCommunityDevice();
    assert.equal(state.calls, 1);
    assert.equal(context.communitySession, sessionBefore);
    assert.equal(context.dashboard, dashboardBefore);
    assert.equal(state.focused, "#disconnect-device-status");
    assert.equal(element("#disconnect-device-status").key, "contribution.disconnect.completed");
    assert.equal(element("#disconnect-device").disabled, true);
    assert.equal(state.repairs, 0);
  }
});

test("no device prevents confirmation; unknown device state remains explicitly retryable", async () => {
  const absent = createDisconnectHarness({
    session: false,
    diagnostics: async () => ({ status: "available", pairing: { observed: true, paired: false } }),
  });
  await absent.context.openContributionDisconnectDialog();
  assert.equal(absent.element("#disconnect-device-confirm").disabled, true);
  assert.equal(absent.element("#disconnect-device-check").key, "contribution.disconnect.absent");
  await absent.context.disconnectCommunityDevice();
  assert.equal(absent.state.calls, 0);
  for (const diagnostics of [
    async () => ({ status: "unavailable" }),
    async () => ({ status: "available", pairing: { observed: false, paired: false } }),
    async () => { throw new Error("synthetic-private-diagnostic-detail"); },
  ]) {
    const unknown = createDisconnectHarness({ diagnostics });
    await unknown.context.openContributionDisconnectDialog();
    assert.equal(unknown.element("#disconnect-device-check").key, "contribution.disconnect.unknown");
    assert.equal(unknown.element("#disconnect-device-confirm").disabled, false);
    await unknown.context.disconnectCommunityDevice();
    assert.equal(unknown.state.calls, 1);
  }
});

test("an unavailable disconnect capability never enables a local mutation", async () => {
  const { context, state, element } = createDisconnectHarness({ configured: false });
  assert.equal(element("#contribution-device-controls").hidden, true);
  await context.openContributionDisconnectDialog();
  await context.disconnectCommunityDevice();
  assert.equal(state.diagnosticReads, 0);
  assert.equal(state.calls, 0);
});

test("cancelled and superseded device reads cannot change a newer dialog", async () => {
  const first = deferred();
  const second = deferred();
  const answers = [first.promise, second.promise];
  const { context, element } = createDisconnectHarness({ diagnostics: () => answers.shift() });
  const oldOpen = context.openContributionDisconnectDialog();
  assert.equal(element("#disconnect-device-confirm").disabled, true);
  context.closeContributionDisconnectDialog();
  const newOpen = context.openContributionDisconnectDialog();
  second.resolve({ status: "available", pairing: { observed: true, paired: true } });
  await newOpen;
  first.resolve({ status: "available", pairing: { observed: true, paired: false } });
  await oldOpen;
  assert.equal(element("#disconnect-device-confirm").disabled, false);
  assert.equal(element("#disconnect-device-check").key, "contribution.disconnect.ready");
});

test("duplicate confirmations run once and keep the pending result focused", async () => {
  const response = deferred();
  const { context, state, element } = createDisconnectHarness({ disconnect: () => response.promise });
  await context.openContributionDisconnectDialog();
  const first = context.disconnectCommunityDevice();
  await context.disconnectCommunityDevice();
  assert.equal(state.calls, 1);
  assert.equal(element("#disconnect-device").disabled, true);
  assert.equal(element("#incremental-sync-retry").disabled, true);
  assert.equal(element("#disconnect-device-status").key, "contribution.disconnect.starting");
  assert.equal(state.focused, "#disconnect-device-status");
  response.resolve(dataClient.normalizeLocalContributionDeviceDisconnect(receipt));
  await first;
  assert.equal(context.communityDevicePaired, false);
  assert.equal(context.communityDevicePairedV1, false);
  assert.equal(element("#incremental-sync-status").hidden, true);
  assert.equal(element("#incremental-sync-retry").hidden, true);
  assert.equal(element("#incremental-consent-approve").disabled, false, "reconnection requires explicit approval");
  assert.equal(state.repairs, 0);
});

test("malformed receipts and failures never claim disconnect or reveal server details", async () => {
  for (const disconnect of [
    async () => ({ status: "unavailable" }),
    async () => ({ status: "disconnected", deliveryPaused: false }),
    async () => { throw new Error("synthetic-private-service-detail"); },
  ]) {
    const { context, state, element } = createDisconnectHarness({ disconnect });
    const historyBefore = context.contributionSyncStatus;
    await context.openContributionDisconnectDialog();
    await context.disconnectCommunityDevice();
    assert.equal(element("#disconnect-device-status").key, "contribution.disconnect.failed");
    assert.doesNotMatch(element("#disconnect-device-status").textContent, /synthetic-private-service-detail/u);
    assert.equal(element("#disconnect-device-status").classList.contains("error"), true);
    assert.equal(context.communityDevicePaired, true);
    assert.equal(context.contributionSyncStatus, historyBefore);
    assert.equal(element("#disconnect-device").disabled, false);
    assert.equal(state.repairs, 0);
  }
});

test("cleanup-pending preserves revocation through failed retries and permits cleanup without a device", async () => {
  let attempt = 0;
  const { context, state, element } = createDisconnectHarness({
    diagnostics: async () => ({ status: "available", pairing: { observed: true, paired: attempt === 0 } }),
    disconnect: async () => {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error("synthetic-private-cleanup-detail"), {
        code: "contribution_device_disconnect_cleanup_pending",
      });
      if (attempt === 2) throw new Error("synthetic-network-failure");
      return dataClient.normalizeLocalContributionDeviceDisconnect(receipt);
    },
  });
  for (let index = 0; index < 2; index += 1) {
    await context.openContributionDisconnectDialog();
    assert.equal(element("#disconnect-device-confirm").disabled, false);
    await context.disconnectCommunityDevice();
    assert.equal(element("#disconnect-device-status").key, "contribution.disconnect.cleanupPending");
    assert.equal(element("#incremental-consent-approve").disabled, true);
    assert.equal(element("#incremental-sync-retry").hidden, true);
    context.resumeContributionCeremonyAfterSignIn();
    assert.equal(state.repairs, 0);
    assert.equal(context.communityDevicePaired, false);
  }
  await context.openContributionDisconnectDialog();
  await context.disconnectCommunityDevice();
  assert.equal(element("#disconnect-device-status").key, "contribution.disconnect.completed");
  assert.equal(state.calls, 3);
});

test("durable disconnect survives page load and cannot trigger silent repair or a sync retry", () => {
  const { context, state, element } = createDisconnectHarness({
    syncStatus: { status: "available", paused: true, pausedReason: "device_disconnected" },
  });
  context.resumeContributionCeremonyAfterSignIn();
  context.maybeRepairIncrementalAuthorization();
  assert.equal(state.repairs, 0);
  assert.equal(context.communityUploadAuthorityEvidence(), false, "historical accepted uploads are not live authority");
  assert.equal(element("#incremental-consent-approve").disabled, false);
  assert.equal(element("#incremental-consent-gate").key, "contribution.disconnect.paused");
  assert.equal(element("#incremental-sync-status").hidden, true);
  assert.equal(element("#incremental-sync-retry").hidden, true);
});

test("the closed incremental parser preserves device_disconnected and a transient read cannot forget it", () => {
  const payload = {
    schemaVersion: "local-incremental-contribution-sync-v1.0",
    status: "available",
    consent: { approved: true, current: true, consentedAt: "2026-08-30T00:00:00Z" },
    paused: true,
    pausedReason: "device_disconnected",
    running: false,
    progress: null,
    lastAttemptAt: null,
    nextAttemptAt: null,
    lastOutcome: null,
    includesContent: false,
    includesPaths: false,
    includesIdentifiers: false,
    includesCredentials: false,
  };
  const parsed = dataClient.normalizeIncrementalContributionSyncStatus(payload);
  assert.equal(parsed.status, "available");
  assert.equal(parsed.paused, true);
  assert.equal(parsed.pausedReason, "device_disconnected");
  assert.equal(parsed.consent.approved, true);
  const { context, state, element } = createDisconnectHarness({ syncStatus: parsed });
  context.observeContributionDisconnectPause(parsed);
  context.incrementalSyncStatus = dataClient.normalizeIncrementalContributionSyncStatus(null);
  context.observeContributionDisconnectPause(context.incrementalSyncStatus);
  context.renderContributionActionState();
  assert.equal(context.contributionDeviceDisconnectPaused(), true);
  assert.equal(element("#incremental-consent-gate").key, "contribution.disconnect.paused");
  context.resumeContributionCeremonyAfterSignIn();
  assert.equal(state.repairs, 0);
  context.observeContributionDisconnectPause({ ...parsed, paused: false, pausedReason: null });
  assert.equal(context.contributionDeviceDisconnectPaused(), false);
  assert.equal(dataClient.normalizeIncrementalContributionSyncStatus({
    ...payload, pausedReason: "device_disconnected synthetic-private-detail",
  }).pausedReason, null);
});

test("disconnect receipts reject extra identifiers and every unconfirmed contract field", () => {
  for (const mutation of [
    { schemaVersion: "local-contribution-device-disconnect-v0.2" },
    { status: "pending" }, { deliveryPaused: false },
    { localCredential: "unknown" }, { localBinding: "unknown" },
    { hostedDataDeleted: true }, { includesIdentifiers: true }, { includesCredentials: true },
    { participantId: "participant:00000000-0000-4000-8000-000000000001" },
  ]) {
    const result = dataClient.normalizeLocalContributionDeviceDisconnect({ ...receipt, ...mutation });
    assert.equal(result.status, "unavailable");
    assert.doesNotMatch(JSON.stringify(result), /participant:/u);
  }
});

test("disconnect and sign-out semantics come from complete canonical three-locale catalogs", () => {
  const keys = Object.keys(CATALOGS["en-US"]).filter((key) => key.startsWith("contribution."));
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of keys) {
      assert.equal(translate(key, {}, locale), CATALOGS[locale][key], `${locale}: ${key}`);
      assert.equal(WEB_MESSAGES[key].length, 3);
      if (locale !== "en-US") assert.notEqual(CATALOGS[locale][key], CATALOGS["en-US"][key]);
    }
  }
  assert.match(translate("contribution.signOutCompleted"), /upload connection is unchanged/u);
  assert.match(translate("contribution.deviceLimit"), /Signing out does not disconnect/u);
});

test("public privacy copy keeps retention and owner-handled rights requests separate from disconnect", async () => {
  const privacy = await readFile(new URL("../public/privacy.html", import.meta.url), "utf8");
  assert.match(privacy, /display window is not a retention limit/u);
  assert.match(privacy, /no blanket short\s+retention limit/u);
  assert.match(privacy, /Hosted erasure is handled by the service owner/u);
  assert.match(privacy, /privacy, rights, or erasure requests/u);
  assert.match(privacy, /dedicated private privacy-request intake channel is not\s+documented/u);
  assert.match(privacy, /https:\/\/github\.com\/adamallcock\/tibotattle\/blob\/main\/SUPPORT\.md/u);
  assert.match(privacy, /Do not post account identifiers, credentials, or private records/u);
  assert.match(privacy, /deletion record is retained/u);
  assert.doesNotMatch(privacy, /Complete hosted deletion removes|explicit identity and hosted privacy controls|contribution, deletion,|contact the maintainer|contact the service\s+owner|mailto:/u);
});
