import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telemetryV11RequiredConsent } from "@app-usagemonitor/telemetry-contract";
import { readIncrementalContributionV11Review, runIncrementalContributionSyncOnce } from "../src/contribution-incremental-sync.js";
import { beginUnifiedIndexGeneration, openLocalUnifiedIndex } from "../src/local-unified-index.js";
import {
  ATTRIBUTION_FIXTURE_BINDING as binding, ATTRIBUTION_FIXTURE_START as start,
  attributionFixtureMarker, writeAttributionFixture,
} from "./helpers/local-attribution-fixture.js";
import { createAttributionFixtureDevice, createAttributionFixtureService } from "./helpers/attribution-transport-fixture.js";

async function fixture(t, { plans, accepted = true, granted = true, fromDay, throughDay } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "v11-local-sync-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const indexFile = join(directory, "index.sqlite");
  const stateFile = join(directory, "device.json");
  await writeAttributionFixture(indexFile, { plans });
  const backend = await createAttributionFixtureDevice(stateFile);
  const service = createAttributionFixtureService({ accepted, granted, fromDay, throughDay });
  const options = { indexFile, stateFile, backend, origin: binding.destinationOrigin,
    consent: { ...telemetryV11RequiredConsent(), destinationOrigin: binding.destinationOrigin },
    fetchImpl: service.fetchImpl, createV11Envelope: service.createEnvelope, now: () => start,
    loadExistingAccountObservationSecret: async () => { assert.fail("Historical plans must not read an account root"); },
  };
  return { options, service, records: () => [...service.envelopes.values()].flatMap((chunk) => chunk.records) };
}

test("public local review reads the exact published sample without granting consent or loading historical identity", async (t) => {
  const { options, service } = await fixture(t, { granted: false });
  const review = await readIncrementalContributionV11Review(options);
  assert.equal(review.status, "ready");
  assert.equal(review.capabilities.consentCurrent, false);
  assert.deepEqual(review.sample.recordCounts, { usage: 2, quota: 2, session: 1 });
  assert.equal(review.inventory.consent.telemetrySchemaVersion, "telemetry-contribution-v1.1");
  assert.match(review.publicationFingerprint, /^generation-v2-[0-9a-f]{64}$/u);
  assert.deepEqual(service.calls.map((call) => call.path), ["/api/v1/device/sync-capabilities"]);
});

test("v11 dispatcher requires the exact consent and destination before index, network or secret use", async (t) => {
  const { options, service } = await fixture(t);
  for (const consent of [
    { ...telemetryV11RequiredConsent() },
    { ...options.consent, destinationOrigin: "https://another.example" },
    { ...options.consent, fieldDictionaryVersion: "older-fields" },
    { ...options.consent, automatic: true },
  ]) await assert.rejects(runIncrementalContributionSyncOnce({ ...options, consent }), {
    code: "contribution_incremental_sync_consent_invalid",
  });
  assert.deepEqual(service.calls, []);
});

test("real local hydration and public runner activate mixed-plan history without inventing accounts or changing usage IDs", async (t) => {
  const { options, service, records } = await fixture(t);
  const result = await runIncrementalContributionSyncOnce(options);
  assert.equal(result.status, "complete");
  assert.equal(result.daysSynced, 1);
  assert.equal(result.recordsUploaded, 5);
  assert.equal(result.acknowledgedThroughDay, "2026-08-01");
  assert.ok(service.active());
  const usage = records().filter((row) => row.schemaVersion === "usage-event-v1.1");
  assert.deepEqual(usage.map((row) => row.accountPlanAttribution.planType), ["pro", "plus"]);
  assert.equal(usage.reduce((sum, row) => sum + row.components.inputUncachedTokens, 0), 20);
  assert.ok(usage.every((row) => row.accountPlanAttribution.accountTrackId === null
    && row.accountPlanAttribution.planEraId === null && /^[0-9a-f]{64}$/u.test(row.eventId)));
  assert.equal(service.calls.some((call) => call.path.includes("device-telemetry-consents")), false);
  assert.doesNotMatch(JSON.stringify(records()), /sourceLocal|source_local|sourceOffset|source_offset|scopeId|enrollmentNamespace|\/Users\//u);
  const database = openLocalUnifiedIndex(options.indexFile, { readOnly: true });
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 11);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM usage_event").get().count, 2);
  database.close();
});

test("staged or ungranted successor capability cannot upload despite local consent", async (t) => {
  for (const mode of [{ accepted: false }, { granted: false }]) {
    const { options, service } = await fixture(t, mode);
    const result = await runIncrementalContributionSyncOnce(options);
    assert.equal(result.status, "failed");
    assert.equal(result.daysSynced, 0);
    assert.equal(result.acknowledgedThroughDay, null);
    assert.deepEqual(service.calls.map((call) => call.path), ["/api/v1/device/sync-capabilities"]);
  }
});

test("partial staging has no acknowledged days, and the next bounded pass activates the complete domain", async (t) => {
  const { options, service } = await fixture(t);
  const partial = await runIncrementalContributionSyncOnce({ ...options, maximumChunks: 1 });
  assert.equal(partial.status, "partial");
  assert.equal(partial.chunksUploaded, 1);
  assert.equal(partial.daysSynced, 0);
  assert.equal(partial.acknowledgedThroughDay, null);
  assert.equal(service.active(), null);
  const complete = await runIncrementalContributionSyncOnce(options);
  assert.equal(complete.status, "complete");
  assert.equal(complete.chunksSkipped, 1);
  assert.equal(complete.chunksUploaded, 2);
  assert.equal(complete.daysSynced, 1);
});

test("private staged progress survives a new public runner invocation and completes a 62-day history", async (t) => {
  const { options, service } = await fixture(t, { plans: [], fromDay: "2026-06-01", throughDay: "2026-08-01" });
  let logicalClock = start;
  const delayedFetch = async (url, request) => { logicalClock += 1_000; return service.fetchImpl(url, request); };
  const first = await runIncrementalContributionSyncOnce({ ...options, now: () => logicalClock, fetchImpl: delayedFetch });
  assert.equal(first.status, "partial");
  assert.equal(first.daysTotal, 62);
  assert.equal(first.daysSynced, 0);
  assert.equal(first.acknowledgedThroughDay, null);
  assert.ok(first.stagedDays > 0 && first.stagedDays < 62);
  const journalFile = `${options.indexFile}.telemetry-v11-progress.json`;
  const journalText = await readFile(journalFile, "utf8");
  const journal = JSON.parse(journalText);
  assert.ok(journal.days.length > 0 && journal.days.length <= first.stagedDays);
  assert.ok(first.stagedDays - journal.days.length <= 1, "only the last ready day can lose its journal write at the budget boundary");
  assert.equal((await stat(journalFile)).mode & 0o777, 0o600);
  assert.doesNotMatch(journalText, /sourceLocal|enrollmentNamespace|deviceId|accountTrackId|scopeId|um_device|secret|\/private\//u);
  const calls = service.calls.length;
  // This creates a new SQLite connection, hydration reader and storage adapter;
  // only the owner-only file bridges the two passes, as after process restart.
  const resumed = await runIncrementalContributionSyncOnce({ ...options, now: () => logicalClock, fetchImpl: delayedFetch });
  assert.equal(resumed.status, "complete");
  assert.equal(resumed.daysSynced, 62);
  assert.equal(resumed.acknowledgedThroughDay, "2026-08-01");
  const resumedManifests = service.calls.slice(calls).filter((call) => call.path.endsWith("day-manifests"));
  assert.equal(resumedManifests[0].body.day, new Date(Date.parse("2026-06-01T00:00:00.000Z") + journal.days.length * 86_400_000).toISOString().slice(0, 10));
  assert.equal(resumedManifests.length, 62 - journal.days.length);
  assert.equal(await readFile(journalFile, "utf8"), "null");
});

test("a new publication revalidates staged day digests and preserves unchanged prefix progress", async (t) => {
  const { options, service } = await fixture(t, { plans: [], fromDay: "2026-06-01", throughDay: "2026-08-01" });
  let logicalClock = start;
  const fetchImpl = async (url, request) => { logicalClock += 1_000; return service.fetchImpl(url, request); };
  const first = await runIncrementalContributionSyncOnce({ ...options, now: () => logicalClock, fetchImpl });
  assert.equal(first.status, "partial");
  const before = JSON.parse(await readFile(`${options.indexFile}.telemetry-v11-progress.json`, "utf8"));
  assert.ok(before.days.length > 0);
  // New source facts belong to the final day. A new publication is not proof
  // that old day manifests still agree; the runner re-derives their hashes.
  await writeAttributionFixture(options.indexFile, { plans: ["plus"] });
  const calls = service.calls.length;
  const resumed = await runIncrementalContributionSyncOnce({ ...options, now: () => logicalClock, fetchImpl });
  assert.equal(resumed.status, "complete");
  assert.equal(resumed.daysSynced, 62);
  const manifests = service.calls.slice(calls).filter((call) => call.path.endsWith("day-manifests"));
  assert.equal(manifests.length, 62 - before.days.length, "unchanged prefix is revalidated locally, not repeatedly restaged");
  const usage = [...service.envelopes.values()].flatMap((chunk) => chunk.records).filter((row) => row.schemaVersion === "usage-event-v1.1");
  assert.equal(usage.length, 1);
  assert.equal(usage[0].accountPlanAttribution.planType, "plus");
});

test("marker presence changes revalidate an interrupted public sync without changing indexed facts", async (t) => {
  for (const initiallyPresent of [true, false]) await t.test(initiallyPresent ? "marker lost" : "marker added", async (t) => {
    const { options, service } = await fixture(t, { plans: ["pro", "pro"] });
    let logicalClock = start;
    let capabilitiesRead = 0;
    let markerPresent = initiallyPresent;
    const leasedRoots = [];
    const syncOptions = { ...options, now: () => logicalClock,
      readAccountMarkers: async () => markerPresent ? [attributionFixtureMarker()] : [],
      loadExistingAccountObservationSecret: async () => {
        assert.equal(markerPresent, true, "marker-free projection must not load an account root");
        const root = Buffer.alloc(32, 9);
        leasedRoots.push(root);
        return root;
      },
      fetchImpl: async (url, request) => {
        const response = await service.fetchImpl(url, request);
        if (new URL(url).pathname === "/api/v1/device/sync-capabilities" && ++capabilitiesRead === 2) {
          // The entire day is durably staged, but the pass expires before
          // activation. A fresh invocation must recheck its projection.
          logicalClock += 60_000;
        }
        return response;
      },
    };
    const first = await runIncrementalContributionSyncOnce(syncOptions);
    assert.equal(first.status, "partial");
    assert.equal(first.stagedDays, 1);
    assert.equal(first.daysSynced, 0);
    assert.equal(first.acknowledgedThroughDay, null);
    assert.equal(service.active(), null);
    const journalFile = `${options.indexFile}.telemetry-v11-progress.json`;
    const beforeText = await readFile(journalFile, "utf8");
    const before = JSON.parse(beforeText);
    assert.equal(before.days.length, 1);
    assert.equal(before.validatedDays, 1);
    assert.equal(leasedRoots.length, initiallyPresent ? 1 : 0);
    assert.ok(leasedRoots.every((root) => root.every((byte) => byte === 0)));
    assert.doesNotMatch(beforeText, /accountScope|scopeId|accountTrackId|enrollmentNamespace|um_device|secret/u);
    const stagedUsage = [...service.envelopes.values()].flatMap((chunk) => chunk.records)
      .filter((row) => row.schemaVersion === "usage-event-v1.1");
    assert.equal(stagedUsage.some((row) => row.accountPlanAttribution.accountTrackId !== null), initiallyPresent);
    const calls = service.calls.length;
    markerPresent = !initiallyPresent;
    // No index writes, credential changes or new hosted predecessor: only
    // the captured marker evidence differs from the prior preparation.
    const resumed = await runIncrementalContributionSyncOnce(syncOptions);
    assert.equal(resumed.status, "complete");
    assert.equal(resumed.daysSynced, 1);
    const manifests = service.calls.slice(calls).filter((call) => call.path.endsWith("day-manifests"));
    assert.equal(manifests.length, 1, "changed marker evidence must not silently reuse the staged projection");
    assert.equal(manifests[0].body.day, before.days[0].day);
    assert.notEqual(manifests[0].body.manifestDigest, before.days[0].manifestDigest);
    const activated = service.calls.at(-1).body.days[0];
    assert.equal(activated.manifestDigest, manifests[0].body.manifestDigest);
    const activeUsage = [...service.envelopes.values()]
      .filter((chunk) => chunk.manifestDigest === activated.manifestDigest)
      .flatMap((chunk) => chunk.records).filter((row) => row.schemaVersion === "usage-event-v1.1");
    assert.deepEqual(activeUsage.map((row) => row.eventId), stagedUsage.map((row) => row.eventId));
    assert.deepEqual(activeUsage.map((row) => row.components), stagedUsage.map((row) => row.components));
    assert.deepEqual(activeUsage.map((row) => row.accountPlanAttribution.planType), ["pro", "pro"]);
    assert.equal(activeUsage.some((row) => row.accountPlanAttribution.accountTrackId !== null), markerPresent);
    assert.equal(leasedRoots.length, 1);
    assert.ok(leasedRoots.every((root) => root.every((byte) => byte === 0)));
    assert.equal(await readFile(journalFile, "utf8"), "null");
  });
});

test("staged metadata cannot traverse a symlink or accept unclosed private fields", async (t) => {
  const { options, service } = await fixture(t);
  const journalFile = `${options.indexFile}.telemetry-v11-progress.json`;
  const target = `${options.indexFile}.unrelated`;
  await writeFile(target, "preserve synthetic target", { mode: 0o600 });
  await symlink(target, journalFile);
  const linked = await runIncrementalContributionSyncOnce(options);
  assert.equal(linked.status, "failed");
  assert.equal(linked.failure.code, "index_unavailable");
  assert.equal(await readFile(target, "utf8"), "preserve synthetic target");
  assert.equal(service.active(), null);
  const other = await fixture(t);
  const extra = await runIncrementalContributionSyncOnce({ ...other.options, progressStore: {
    async read() { return { schemaVersion: "telemetry-v11-sync-progress-v1", secret: "synthetic-canary" }; },
    async write() { assert.fail("Unclosed progress must not be written"); },
  } });
  assert.equal(extra.failure.code, "index_unavailable");
  assert.equal(other.service.active(), null);
  const publicFile = await fixture(t);
  const publicJournal = `${publicFile.options.indexFile}.telemetry-v11-progress.json`;
  await writeFile(publicJournal, "null", { mode: 0o600 });
  await chmod(publicJournal, 0o644);
  const unsafe = await runIncrementalContributionSyncOnce(publicFile.options);
  assert.equal(unsafe.failure.code, "index_unavailable");
  assert.equal(publicFile.service.active(), null);
});

test("only a captured matching valid marker leases the existing root and that buffer is always erased", async (t) => {
  const { options, records } = await fixture(t, { plans: ["pro", "pro"] });
  const root = Buffer.alloc(32, 9);
  let reads = 0;
  const result = await runIncrementalContributionSyncOnce({ ...options,
    readAccountMarkers: async () => [attributionFixtureMarker()],
    loadExistingAccountObservationSecret: async () => { reads += 1; return root; },
  });
  assert.equal(result.status, "complete");
  assert.equal(reads, 1);
  assert.ok(root.every((byte) => byte === 0));
  const usage = records().filter((row) => row.schemaVersion === "usage-event-v1.1");
  assert.equal(usage[0].accountPlanAttribution.accountTrackId, null);
  assert.equal(usage[1].accountPlanAttribution.accountBasis, "provisional_marker");
  assert.ok(usage[1].accountPlanAttribution.accountTrackId);
  const mismatch = await fixture(t, { plans: ["pro", "pro"] });
  assert.equal((await runIncrementalContributionSyncOnce({ ...mismatch.options,
    readAccountMarkers: async () => [attributionFixtureMarker({ observationBinding: {
      ...binding, enrollmentNamespace: "other_synthetic_enrollment",
    } })],
  })).status, "complete");
  assert.ok(mismatch.records().filter((row) => row.accountPlanAttribution)
    .every((row) => row.accountPlanAttribution.accountTrackId === null));
});

test("a writer starting after staging prevents activation and never erases committed evidence", async (t) => {
  const { options, service } = await fixture(t);
  let mutated = false;
  const result = await runIncrementalContributionSyncOnce({ ...options,
    fetchImpl: async (url, request) => {
      const response = await service.fetchImpl(url, request);
      if (!mutated && new URL(url).pathname === "/api/v1/contributions") {
        mutated = true;
        const database = openLocalUnifiedIndex(options.indexFile);
        beginUnifiedIndexGeneration(database, { contractVersion: "usage-event-v0.2", receivedAtMs: start + 1,
          discoveredSourceCount: 1, discoveredSourceBytes: 8192 });
        database.close();
      }
      return response;
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "local_index_changed");
  assert.equal(result.failure.retryable, true);
  assert.equal(result.daysSynced, 0);
  assert.equal(service.active(), null);
  assert.equal(service.calls.some((call) => call.path.endsWith("domain-activate")), false);
  const database = openLocalUnifiedIndex(options.indexFile, { readOnly: true });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM usage_event").get().count, 2);
  database.close();
});

test("cancellation during a root lease cannot leave a late secret buffer live or activate a domain", async (t) => {
  const { options, service } = await fixture(t, { plans: ["pro", "pro"] });
  const abort = new AbortController();
  let started;
  let release;
  const entered = new Promise((resolve) => { started = resolve; });
  const deferred = new Promise((resolve) => { release = resolve; });
  const pending = runIncrementalContributionSyncOnce({ ...options, signal: abort.signal,
    readAccountMarkers: async () => [attributionFixtureMarker()],
    loadExistingAccountObservationSecret: async () => { started(); return deferred; },
  });
  await entered;
  abort.abort();
  const result = await pending;
  assert.equal(result.daysSynced, 0);
  assert.equal(service.active(), null);
  const root = Buffer.alloc(32, 9);
  release(root);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(root.every((byte) => byte === 0));
});
