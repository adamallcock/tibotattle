import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telemetryV12RequiredConsent } from "@app-usagemonitor/telemetry-contract";
import { readIncrementalContributionV12Review, runIncrementalContributionSyncOnce } from "../src/contribution-incremental-sync.js";
import { ATTRIBUTION_FIXTURE_BINDING as binding, ATTRIBUTION_FIXTURE_START as start,
  writeAttributionFixture } from "./helpers/local-attribution-fixture.js";
import { createAttributionFixtureDevice, createAttributionFixtureService } from "./helpers/attribution-transport-fixture.js";

async function fixture(t, serviceOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "v12-local-sync-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const indexFile = join(directory, "index.sqlite");
  const stateFile = join(directory, "device.json");
  await writeAttributionFixture(indexFile, { boundaryFlags: [1, 3] });
  const backend = await createAttributionFixtureDevice(stateFile);
  const service = createAttributionFixtureService({ successor: true, ...serviceOptions });
  return { service, options: { indexFile, stateFile, backend, origin: binding.destinationOrigin,
    consent: { ...telemetryV12RequiredConsent(), destinationOrigin: binding.destinationOrigin },
    fetchImpl: service.fetchImpl, createV12Envelope: service.createEnvelope, now: () => start,
    createV11Envelope: () => assert.fail("Successor must use its own envelope"),
    loadExistingAccountObservationSecret: async () => assert.fail("Historical plans do not load identity") } };
}

test("normal local dispatcher projects v1.2 from the actual index and resumes its own journal", async (t) => {
  const { options, service } = await fixture(t);
  const first = await runIncrementalContributionSyncOnce({ ...options, maximumChunks: 1 });
  assert.equal(first.status, "partial");
  const interrupted = await runIncrementalContributionSyncOnce({ ...options,
    fetchImpl: (url, request) => new URL(url).pathname.endsWith("/domain-activate")
      ? Promise.resolve(new Response(JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE" } }),
        { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } }))
      : options.fetchImpl(url, request) });
  assert.equal(interrupted.status, "failed");
  assert.equal(interrupted.failure.code, "service_unavailable");
  const saved = JSON.parse(await readFile(`${options.indexFile}.telemetry-v12-progress.json`, "utf8"));
  assert.equal(saved.schemaVersion, "telemetry-v12-sync-progress-v1");
  await assert.rejects(readFile(`${options.indexFile}.telemetry-v11-progress.json`), { code: "ENOENT" });
  const second = await runIncrementalContributionSyncOnce(options);
  assert.equal(second.status, "complete");
  const rows = [...service.envelopes.values()].flatMap((chunk) => chunk.records)
    .filter((row) => row.schemaVersion === "usage-event-v1.2");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].boundaryFlags, null, "pre-cutoff continuity stays unknown");
  assert.equal(rows[0].tieOrder, null);
  assert.equal(rows[1].boundaryFlags, 3, "post-cutoff source boundary reaches the real upload dispatcher");
  assert.equal(rows[1].tieOrder, 0);
  assert.equal(service.capability.successor.activationTime, "2026-08-01T12:00:00.500Z");
  assert.ok(service.active());
  assert.ok(service.calls.every(({ path }) => !path.includes("telemetry-v11")));
});

test("successor grants and a persisted cutoff are required before local day projection", async (t) => {
  const { options, service } = await fixture(t, { activationTime: null });
  const result = await runIncrementalContributionSyncOnce(options);
  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "response_invalid");
  assert.equal(service.envelopes.size, 0);
  assert.equal(service.active(), null);
});

test("v1.2 consent cannot borrow the previous dictionary or an extra authority field", async (t) => {
  const { options, service } = await fixture(t);
  for (const consent of [{ ...options.consent, fieldDictionaryVersion: "telemetry-fields-v1.1" },
    { ...options.consent, activationTime: "2026-08-01T00:00:00.000Z" }]) {
    await assert.rejects(runIncrementalContributionSyncOnce({ ...options, consent }),
      { code: "contribution_incremental_sync_consent_invalid" });
  }
  assert.equal(service.calls.length, 0);
});


test("ungranted v1.2 review presents the exact inventory without inventing a cutoff", async (t) => {
  const { options, service } = await fixture(t, { granted: false });
  const review = await readIncrementalContributionV12Review(options);
  assert.equal(review.status, "ready");
  assert.equal(review.capabilities.successor.activationTime, null);
  assert.equal(review.capabilities.successor.authorizationCurrent, false);
  assert.equal(review.inventory.consent.telemetrySchemaVersion, "telemetry-contribution-v1.2");
  assert.deepEqual(review.sample.recordCounts, { usage: 2, quota: 2, session: 1 });
  assert.deepEqual(service.calls.map(({ path }) => path), ["/api/v1/device/sync-capabilities-v1.2"]);
  assert.equal(service.envelopes.size, 0);
});
