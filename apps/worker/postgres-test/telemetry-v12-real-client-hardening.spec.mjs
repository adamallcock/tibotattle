import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  canonicalTelemetryV12Json,
} from "@app-usagemonitor/telemetry-contract";
import { createTelemetryV12RealClientHarness } from "./telemetry-v12-real-client-harness.mjs";

const hasLocalPostgres = Boolean(process.env.PG_TEST_SOCKET || process.env.PG_TEST_HOST);

function utcDay(offset = 0) {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function dayByOffset(day, offset) {
  return new Date(Date.parse(day + "T00:00:00.000Z") + offset * 86_400_000)
    .toISOString().slice(0, 10);
}

test("PostgreSQL v1.2 real client replays an unchanged publication without writes", {
  skip: !hasLocalPostgres,
  timeout: 300_000,
}, async () => {
  const harness = await createTelemetryV12RealClientHarness({ label: "steady-state" });
  try {
    const day = utcDay();
    const clientOptions = {
      days: [day],
      parserVersion: "synthetic-steady-parser-v1",
      publicationFingerprint: "synthetic-steady-publication-v1",
      useProgress: true,
    };

    const first = await harness.runClient(clientOptions);
    assert.equal(first.result.status, "complete", JSON.stringify(first.result));
    assert.equal(first.result.failure, null);
    assert.deepEqual(first.exchanges.filter((exchange) => exchange.status >= 400), []);
    const firstActivation = first.exchanges.find((exchange) =>
      exchange.path === "/api/v1/me/telemetry-v12/domain-activate");
    assert.ok(firstActivation, "the first pass must activate through the real dispatch");
    assert.equal(firstActivation.status, 201);

    const baseline = await harness.counts();
    assert.ok(baseline.head);
    assert.equal(baseline.head.revision, 1);
    assert.equal(baseline.telemetry_v12_domains, 1);
    assert.equal(baseline.telemetry_v12_domain_days, 1);
    assert.equal(baseline.storage_v12_event_sources, 1);
    assert.equal(baseline.ownerActive, 1,
      "the staged OJ-2 bridge must journal the initial eligible v1.2 activation");

    for (let pass = 0; pass < 12; pass += 1) {
      const idle = await harness.runClient(clientOptions);
      assert.equal(idle.result.status, "complete", "idle pass " + (pass + 1) + " completes");
      assert.equal(idle.result.failure, null, "idle pass " + (pass + 1) + " has no failure");
      assert.deepEqual(idle.exchanges.filter((exchange) => exchange.status >= 400), [],
        "idle pass " + (pass + 1) + " must not receive a conflict or refusal");
      const activation = idle.exchanges.find((exchange) =>
        exchange.path === "/api/v1/me/telemetry-v12/domain-activate");
      assert.ok(activation, "idle pass " + (pass + 1) + " activates through the real dispatch");
      assert.equal(activation.status, 201);
      assert.equal(activation.body?.replay, true);
      assert.equal(activation.body?.unchanged, true);
      assert.equal(typeof activation.body?.requestedManifestDigest, "string");
      assert.equal(activation.body.manifestDigest, firstActivation.body.manifestDigest,
        "the unchanged acknowledgement keeps the active generation digest");
      assert.notEqual(activation.body.requestedManifestDigest, activation.body.manifestDigest,
        "the idle request has a fresh digest pinned to its renewed predecessor");
    }

    const after = await harness.counts();
    assert.deepEqual(after, baseline,
      "head revision and v1.2 domain/day, event receipt, journal and owner-active counts stay unchanged");
    const predecessors = await harness.primaryPool.query(
      "SELECT count(*)::integer AS count FROM "
        + '"' + harness.primarySchema + '"."telemetry_v12_domain_predecessors"'
        + " WHERE participant_id=$1 AND device_id=$2 AND consumed_at IS NULL"
        + " AND expires_at > clock_timestamp()",
      [harness.participantId, harness.deviceId],
    );
    assert.ok(predecessors.rows[0].count <= 8,
      "twelve idle passes must leave at most eight unconsumed, unexpired predecessors");
  } finally {
    await harness.cleanup();
  }
});

test("real v1.2 client pins the earliest per-day manifests across 4,098 ready rows", {
  skip: !hasLocalPostgres,
  timeout: 600_000,
}, async () => {
  const harness = await createTelemetryV12RealClientHarness({ label: "manifest-history" });
  try {
    const today = utcDay();
    const days = [dayByOffset(today, -2), dayByOffset(today, -1), today];
    const manifestsPerDay = 1_366;
    const base = Date.now() - 3 * 60 * 60 * 1_000;
    const chronological = Array.from({ length: days.length * manifestsPerDay }, (_, index) => ({
      day: days[index % days.length],
      parserVersion: "synthetic-parser-" + String(manifestsPerDay - 1 - Math.floor(index / days.length)).padStart(4, "0"),
      createdEpoch: base + index * 1_000,
    }));
    const registered = await harness.registerEmptyDayManifests([...chronological].reverse());

    const history = await harness.primaryPool.query(
      "SELECT count(*)::integer AS total, count(DISTINCT parser_version)::integer AS versions,"
        + " count(DISTINCT chunk_day)::integer AS days FROM \"" + harness.primarySchema
        + "\".\"telemetry_v12_day_manifests\" WHERE participant_id=$1 AND device_id=$2 AND state='ready'",
      [harness.participantId, harness.deviceId],
    );
    assert.deepEqual(history.rows[0], { total: 4_098, versions: 1_366, days: 3 });
    const daily = await harness.primaryPool.query(
      "SELECT to_char(chunk_day,'YYYY-MM-DD') AS day, count(*)::integer AS count FROM \""
        + harness.primarySchema + "\".\"telemetry_v12_day_manifests\""
        + " WHERE participant_id=$1 AND device_id=$2 AND state='ready'"
        + " GROUP BY chunk_day ORDER BY chunk_day",
      [harness.participantId, harness.deviceId],
    );
    assert.deepEqual(daily.rows, days.map((day) => ({ day, count: manifestsPerDay })));

    const earliest = days.map((day) => {
      const item = registered.find((candidate) => candidate.day === day
        && candidate.createdEpoch === Math.min(...chronological
          .filter((planned) => planned.day === day).map((planned) => planned.createdEpoch)));
      assert.ok(item, "the earliest manifest for each day is represented in the registration result");
      return { day, manifestId: item.manifestId, manifestDigest: item.manifestDigest };
    });
    for (let index = 0; index < days.length; index += 1) {
      const firstOfDay = chronological.find((planned) => planned.day === days[index]);
      assert.equal(firstOfDay.parserVersion, "synthetic-parser-1365");
    }

    const client = await harness.runClient({
      days,
      parserVersion: "synthetic-parser-1365",
      recordCount: 0,
      publicationFingerprint: "synthetic-history-publication-v1",
      useProgress: true,
    });
    assert.equal(client.result.status, "complete", JSON.stringify(client.result));
    assert.equal(client.result.failure, null);
    assert.equal(client.result.recordsUploaded, 0);
    assert.deepEqual(client.exchanges.filter((exchange) => exchange.status >= 400), []);
    const predecessor = client.exchanges.find((exchange) =>
      exchange.path === "/api/v1/me/telemetry-v12/domain-predecessor");
    assert.ok(predecessor, "the real client requests a domain predecessor");
    assert.equal(predecessor.status, 201);
    assert.equal(predecessor.body.schemaVersion, "telemetry-domain-predecessor-v1.2");
    const pinned = await harness.primaryPool.query(
      "SELECT days_json FROM \"" + harness.primarySchema + "\".\"telemetry_v12_domain_predecessors\""
        + " WHERE token_hash=$1",
      [sha256Hex(predecessor.body.token)],
    );
    assert.equal(pinned.rows.length, 1);
    assert.equal(pinned.rows[0].days_json, canonicalTelemetryV12Json(earliest),
      "the persisted predecessor pins the earliest (created_at, id) manifest for each day");
    const after = await harness.primaryPool.query(
      "SELECT count(*)::integer AS total FROM \"" + harness.primarySchema
        + "\".\"telemetry_v12_day_manifests\" WHERE participant_id=$1 AND device_id=$2 AND state='ready'",
      [harness.participantId, harness.deviceId],
    );
    assert.equal(after.rows[0].total, 4_098,
      "the client reuses the existing zero-chunk manifests without adding rows");
  } finally {
    await harness.cleanup();
  }
});

test("real v1.2 client completes a fresh 41-day pass inside production admission budgets", {
  skip: !hasLocalPostgres,
  timeout: 600_000,
}, async () => {
  const harness = await createTelemetryV12RealClientHarness({ label: "forty-one-day" });
  try {
    const today = utcDay();
    const days = Array.from({ length: 41 }, (_, index) => dayByOffset(today, index - 40));
    const negotiated = await harness.negotiateCapabilities();
    assert.equal(negotiated.value.schemaVersion, "device-sync-capabilities-v1.2");
    assert.deepEqual(negotiated.exchanges.map(({ path, status }) => ({ path, status })), [
      { path: "/api/v1/device/sync-capabilities-v1.2", status: 200 },
    ]);

    const started = performance.now();
    const client = await harness.runClient({
      days,
      parserVersion: "synthetic-forty-one-day-parser-v1",
      recordCount: 1,
      publicationFingerprint: "synthetic-forty-one-day-publication-v1",
      useProgress: true,
    });
    const elapsedMs = performance.now() - started;
    assert.equal(client.result.status, "complete", JSON.stringify(client.result));
    assert.equal(client.result.failure, null);
    assert.equal(client.result.daysTotal, 41);
    assert.equal(client.result.daysSynced, 41);
    assert.equal(client.result.chunksUploaded, 41);
    assert.equal(client.result.recordsUploaded, 41);
    assert.ok(elapsedMs < 60_000, "the synthetic full pass completes under the 60-second client budget");
    assert.deepEqual(client.exchanges.filter((exchange) => exchange.status >= 400), []);

    const allExchanges = [...negotiated.exchanges, ...client.exchanges];
    const syncPaths = new Set([
      "/api/v1/device/sync-capabilities-v1.2",
      "/api/v1/me/telemetry-v12/domain-predecessor",
      "/api/v1/device/telemetry/v1.2/day-manifests",
      "/api/v1/me/telemetry-v12/domain-activate",
    ]);
    const syncExchanges = allExchanges.filter((exchange) => syncPaths.has(exchange.path));
    assert.equal(syncExchanges.length, 47,
      "the 41-day client performs the N+6 v1.2 device-sync route requests including negotiation");
    assert.equal(allExchanges.filter((exchange) =>
      exchange.path === "/api/v1/device/sync-capabilities-v1.2").length, 3);
    assert.equal(allExchanges.filter((exchange) =>
      exchange.path === "/api/v1/me/telemetry-v12/domain-predecessor").length, 2);
    assert.equal(allExchanges.filter((exchange) =>
      exchange.path === "/api/v1/device/telemetry/v1.2/day-manifests").length, 41);
    assert.equal(allExchanges.filter((exchange) =>
      exchange.path === "/api/v1/me/telemetry-v12/domain-activate").length, 1);
    assert.equal(allExchanges.filter((exchange) =>
      exchange.path === "/api/v1/device/upload-authorizations").length, 41);
    assert.equal(allExchanges.filter((exchange) => exchange.path === "/api/v1/contributions").length, 41);

    // The private test host strips cf-* headers, so all requests share its
    // loopback client key. Per-address isolation is qualified separately by
    // EP-12/CR-7 and is not claimed by this real-client test.
    const rateLimits = await harness.primaryPool.query(
      "SELECT limiter_name, sum(used_count)::integer AS used FROM \"" + harness.primarySchema
        + "\".\"postgres_rate_limit_buckets\" GROUP BY limiter_name ORDER BY limiter_name",
    );
    const usage = Object.fromEntries(rateLimits.rows.map((row) => [row.limiter_name, row.used]));
    for (const name of ["DEVICE_SYNC_CLIENT", "DEVICE_SYNC", "DEVICE_SYNC_PRINCIPAL"]) {
      assert.equal(usage[name], 47, name + " charges each of the 47 sync requests");
    }
    assert.equal(usage.UPLOAD_AUTHORIZATION, 41);
    assert.equal(usage.UPLOAD_PRINCIPAL, 41);
    assert.ok(usage.DEVICE_SYNC_CLIENT < 4_200);
    assert.ok(usage.DEVICE_SYNC < 6_000);
    assert.ok(usage.DEVICE_SYNC_PRINCIPAL < 4_200);
    assert.ok(usage.UPLOAD_AUTHORIZATION < 6_000);
    assert.ok(usage.UPLOAD_PRINCIPAL < 4_200);

    const head = await harness.primaryPool.query(
      "SELECT revision::integer AS revision FROM \"" + harness.primarySchema
        + "\".\"telemetry_v12_domain_heads\" WHERE participant_id=$1",
      [harness.participantId],
    );
    assert.equal(head.rows.length, 1);
    assert.equal(head.rows[0].revision, 1);
  } finally {
    await harness.cleanup();
  }
});
