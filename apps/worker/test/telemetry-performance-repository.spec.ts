import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  canonicalTelemetryPerformanceJson,
  buildPerformanceHistogram,
} from "@app-usagemonitor/telemetry-contract";
import { canonicalJson } from "../src/canonical-json";
import { encodeBase64Url, sha256Hex } from "../src/crypto";
import { handleRequest } from "../src/index";
import {
  admitTelemetryPerformanceReport,
  eraseTelemetryPerformanceReports,
  parseTelemetryPerformanceReport,
  readTelemetryPerformanceReports,
} from "../src/telemetry-performance-repository";
import {
  ACCOUNTLESS_TELEMETRY_PERFORMANCE_AUTHORIZATION_BASIS,
  ACCOUNTLESS_TELEMETRY_PERFORMANCE_POLICY_VERSION,
  ACCOUNTLESS_TELEMETRY_PERFORMANCE_SCHEMA_VERSION,
  grantTelemetryPerformanceAccountlessAuthorization,
  grantTelemetryPerformanceSocialAuthorization,
} from "../src/telemetry-performance-policy";
import { requireTelemetryPerformanceStorageMode } from "../src/telemetry-storage-mode";
import { createV11DeviceFixture } from "./helpers/telemetry-v11";

interface Bindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
}

const bindings = env as Bindings;
const db = () => bindings.USAGE_MONITOR_DB;
const DAY = "2026-09-21";
const NOW = Date.parse("2026-09-21T12:00:00.000Z");
const AUTHORIZATION = {
  schemaVersion: "telemetry-performance-authorization-v1" as const,
  capabilityRevision: 1,
  authorityEpoch: 1,
  issuedAt: "2026-09-21T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  scope: "model-performance-daily" as const,
};

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), bindings.TEST_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await applyD1Migrations(db(), bindings.TEST_INGESTION_ISOLATION_MIGRATIONS);
});

function record(modelId = "gpt-5.6-luna") {
  return {
    schemaVersion: "model-performance-daily-v1",
    day: DAY,
    provider: "openai_codex",
    modelId,
    reasoningEffort: "high",
    speedMethod: "receipt",
    speedMode: "standard",
    speedModeSource: "rollout_thread_settings",
    apiServiceTier: "unknown",
    measurementVersion: "model-performance-samples-v1",
    bucketSchemeVersion: "performance-histogram-v1",
    turns: 1,
    speedTurns: 1,
    ttftTurns: 1,
    completionTurns: 1,
    timedResponses: 1,
    speedTokens: 100,
    speedDurationMs: 1_000,
    speedHistogram: buildPerformanceHistogram("speed", [100]),
    ttftHistogram: buildPerformanceHistogram("ttft", [100]),
    completionHistogram: buildPerformanceHistogram("turnDuration", [1_000]),
  };
}

function denseRecords(day = DAY) {
  const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
  const modes = [
    ["fast", "rollout_thread_settings"],
    ["standard", "rollout_thread_settings"],
    ["other", "lineage_inherited"],
    ["unknown", "unobserved"],
    ["mixed", "mixed"],
  ] as const;
  const tiers = ["standard", "priority", "flex", "batch", "unknown", "other", "mixed"] as const;
  const models = [
    "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra",
    "gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex",
    "gpt-5.1-codex", "gpt-5-codex", "gpt-4.1", "gpt-4o",
  ] as const;
  const records: ReturnType<typeof record>[] = [];
  outer: for (const modelId of models) {
    for (const reasoningEffort of efforts) {
      for (const [speedMode, speedModeSource] of modes) {
        for (const apiServiceTier of tiers) {
          records.push({
            ...record(modelId), day, reasoningEffort, speedMode, speedModeSource, apiServiceTier,
          });
          if (records.length === 1_024) break outer;
        }
      }
    }
  }
  records.sort((left, right) =>
    canonicalTelemetryPerformanceJson(left).localeCompare(canonicalTelemetryPerformanceJson(right)));
  return records;
}

function rejectPerformanceDetailReads(database: D1Database): D1Database {
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property !== "prepare") return Reflect.get(target, property, receiver);
      return (sql: string) => {
        if (/telemetry_performance_(?:cohorts|buckets)/u.test(sql)) {
          throw new Error("performance detail read should be fenced by metadata preflight");
        }
        return target.prepare(sql);
      };
    },
  }) as D1Database;
}

function mutateBeforePerformanceDetailBatch(
  database: D1Database,
  mutation: () => Promise<void>,
): D1Database {
  let batches = 0;
  return new Proxy(database, {
    get(target, property) {
      if (property === "batch") {
        return async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
          batches += 1;
          if (batches === 2) await mutation();
          return target.batch<T>(statements);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

async function report(modelId = "gpt-5.6-luna", records = [record(modelId)], reportDay = DAY,
  sourceRevision = 3, sourceDigest = "a".repeat(64), sourceGeneration = "source:v1:fixture") {
  const body = {
    schemaVersion: "telemetry-performance-report-v1",
    day: reportDay,
    sourceGeneration,
    sourceDigest,
    sourceRevision,
    methodVersion: "performance-daily-histogram-v1",
    parserVersion: "codex-parser-v17",
    fieldDictionaryVersion: "telemetry-performance-registry-2026-09-21.1",
    privacyContractVersion: "privacy-safe-model-performance-v1",
    bucketSchemeVersion: "performance-histogram-v1",
    measurementVersion: "model-performance-samples-v1",
    records,
  };
  return {
    ...body,
    reportRevision: await sha256Hex(canonicalJson(body)),
  };
}

async function activatePerformance(fixture: Awaited<ReturnType<typeof createV11DeviceFixture>>) {
  await db().prepare("UPDATE telemetry_performance_runtime SET state='active' WHERE id=1").run();
  await db().prepare(`INSERT INTO telemetry_performance_device_capabilities (
    participant_id, device_id, schema_version, field_dictionary_version,
    privacy_contract_version, scope, capability_revision, authority_epoch,
    issued_at, expires_at, state, consented_at
  ) VALUES (?, ?, 'model-performance-daily-v1',
    'telemetry-performance-registry-2026-09-21.1',
    'privacy-safe-model-performance-v1', 'model-performance-daily', 1, 1,
    '2026-09-21T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 'accepted',
    '2026-09-21T00:00:00.000Z')`).bind(fixture.participantId, fixture.deviceId).run();
}

async function createAccountlessPerformanceFixture() {
  const deviceId = crypto.randomUUID();
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const prefix = new TextEncoder().encode(`app-usagemonitor/device/v1\0${deviceId}\0`);
  const input = new Uint8Array(prefix.length + secret.length);
  input.set(prefix); input.set(secret, prefix.length);
  const deviceSecretHash = await sha256Hex(input);
  const authorization = `Device um_device_${deviceId}.${encodeBase64Url(secret)}`;
  input.fill(0); secret.fill(0);
  const request = (path: string, body: object, auth = "") => handleRequest(new Request(
    `https://performance.example.test${path}`,
    { method: "POST", headers: { origin: "https://performance.example.test", "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) },
  ), { ...bindings, ENVIRONMENT: "synthetic-development", ACCOUNT_SCOPED_INGEST_MODE: "disabled", ACCOUNTLESS_ENROLLMENT_MODE: "enabled", ACCOUNTLESS_OWNERSHIP_MODE: "enabled" } as Env);
  expect((await request("/api/v1/accountless/enrollment", {
    schemaVersion: "accountless-enrollment-v0.1", deviceId, deviceSecretHash,
    policyVersion: "accountless-opt-out-v1", authorizationBasis: "accountless-policy-v1",
  })).status).toBe(201);
  expect((await request("/api/v1/accountless/ownership", {
    schemaVersion: "accountless-upload-owner-v0.1", policyVersion: "accountless-opt-out-v1",
    authorizationBasis: "accountless-policy-v1", telemetrySchemaVersion: "telemetry-contribution-v1.1",
  }, authorization)).status).toBe(201);
  const owner = await db().prepare(
    "SELECT participant_id FROM accountless_upload_owners WHERE enrollment_device_id = ?",
  ).bind(deviceId).first<{ participant_id: string }>();
  if (!owner) throw new Error("missing synthetic accountless performance owner");
  return { participantId: owner.participant_id, deviceId };
}

describe("independent performance report repository", () => {
  it("requires typed performance deployment without requiring v1.2 activation", async () => {
    await db().prepare("UPDATE telemetry_performance_runtime SET state='active' WHERE id=1").run();
    await expect(requireTelemetryPerformanceStorageMode(db(), {
      TELEMETRY_STORAGE_MODE: "json",
    })).rejects.toMatchObject({ code: "BACKEND_STORAGE_UNAVAILABLE" });
    await expect(requireTelemetryPerformanceStorageMode(db(), {
      TELEMETRY_STORAGE_MODE: "typed",
      TELEMETRY_STORAGE_NAMESPACE: "synthetic-performance-storage",
    })).resolves.toBeUndefined();
    const v12 = await db().prepare(
      "SELECT state FROM telemetry_v12_runtime WHERE id=1",
    ).first<{ state: string }>();
    expect(v12?.state).toBe("staged");
  });

  it("requires its own runtime and capability, then stores typed cohorts and bins", async () => {
    const fixture = await createV11DeviceFixture(db());
    const value = await report();
    await expect(admitTelemetryPerformanceReport(
      db(), fixture, value, AUTHORIZATION, "b".repeat(64), NOW,
    )).rejects.toMatchObject({ code: "TELEMETRY_TRANSPORT_BLOCKED" });
    await activatePerformance(fixture);
    await expect(admitTelemetryPerformanceReport(
      db(), fixture, value, AUTHORIZATION, "b".repeat(64), NOW,
    )).resolves.toMatchObject({ status: "accepted", day: DAY });
    const typed = await db().prepare(
      "SELECT count(*) AS cohorts FROM telemetry_performance_cohorts WHERE report_id IN (SELECT id FROM telemetry_performance_reports)",
    ).first<{ cohorts: number }>();
    const bins = await db().prepare("SELECT count(*) AS buckets FROM telemetry_performance_buckets").first<{ buckets: number }>();
    expect(typed?.cohorts).toBe(1);
    expect(bins?.buckets).toBe(3);
    await expect(admitTelemetryPerformanceReport(
      db(), fixture, value, AUTHORIZATION, "b".repeat(64), NOW,
    )).resolves.toMatchObject({ status: "idempotent" });
    const read = await readTelemetryPerformanceReports(db(), fixture.participantId);
    expect(read).toMatchObject({ population: "reported_samples" });
    expect(read.reports).toHaveLength(1);
    expect(read.reports[0]?.sourceGeneration).toBe("source:v1:fixture");
    expect(read.reports[0]?.cohorts[0]?.speedHistogram.buckets).toEqual([{ index: 50, count: 1 }]);
  });

  it("fails closed when detail rows change after the count fence", async () => {
    const fixture = await createV11DeviceFixture(db());
    await activatePerformance(fixture);
    await admitTelemetryPerformanceReport(
      db(), fixture, await report(), AUTHORIZATION, "b".repeat(64), NOW,
    );
    const raced = mutateBeforePerformanceDetailBatch(db(), async () => {
      await db().prepare(
        `DELETE FROM telemetry_performance_buckets
          WHERE report_id IN (SELECT id FROM telemetry_performance_reports)`,
      ).run();
    });
    await expect(readTelemetryPerformanceReports(raced, fixture.participantId))
      .rejects.toMatchObject({ code: "BACKEND_STORAGE_UNAVAILABLE" });
  });

  it("supersedes one device/day revision without summing it and erases the dialect", async () => {
    const fixture = await createV11DeviceFixture(db());
    await activatePerformance(fixture);
    const first = await report();
    const second = await report("gpt-5.6-sol");
    await admitTelemetryPerformanceReport(db(), fixture, first, AUTHORIZATION, "b".repeat(64), NOW);
    await expect(admitTelemetryPerformanceReport(
      db(), fixture, second, AUTHORIZATION, "c".repeat(64), NOW + 1_000,
    )).resolves.toMatchObject({ status: "replaced" });
    const rows = await db().prepare(
      "SELECT state, count(*) AS total FROM telemetry_performance_reports GROUP BY state ORDER BY state",
    ).all<{ state: string; total: number }>();
    expect(rows.results).toEqual([
      { state: "current", total: 1 }, { state: "superseded", total: 1 },
    ]);
    const read = await readTelemetryPerformanceReports(db(), fixture.participantId);
    expect(read.reports).toHaveLength(1);
    expect(read.reports.map((item) => item.state)).toEqual(["current"]);
    const history = await readTelemetryPerformanceReports(db(), fixture.participantId, { includeSuperseded: true });
    expect(history.reports).toHaveLength(2);
    expect(history.reports.map((item) => item.state)).toEqual(["superseded", "current"]);
    await expect(eraseTelemetryPerformanceReports(db(), fixture.participantId))
      .resolves.toMatchObject({ deletedReports: 2, deletedReceipts: 2 });
    expect((await db().prepare("SELECT count(*) AS n FROM telemetry_performance_reports").first<{ n: number }>())?.n).toBe(0);
    expect((await db().prepare("SELECT count(*) AS n FROM telemetry_performance_buckets").first<{ n: number }>())?.n).toBe(0);
  });

  it("accepts a zero-record day tombstone and removes the prior revision from the default reader", async () => {
    const fixture = await createV11DeviceFixture(db());
    await activatePerformance(fixture);
    const first = await report();
    await admitTelemetryPerformanceReport(db(), fixture, first, AUTHORIZATION, "b".repeat(64), NOW);
    const tombstone = await report("gpt-5.6-luna", [], DAY, 4, "c".repeat(64));
    await expect(admitTelemetryPerformanceReport(
      db(), fixture, tombstone, AUTHORIZATION, "c".repeat(64), NOW + 1_000,
    )).resolves.toMatchObject({ status: "replaced", reportRevision: tombstone.reportRevision });
    const read = await readTelemetryPerformanceReports(db(), fixture.participantId);
    expect(read.reports).toHaveLength(1);
    expect(read.reports[0]).toMatchObject({ state: "current", cohorts: [] });
    const history = await readTelemetryPerformanceReports(db(), fixture.participantId, { includeSuperseded: true });
    expect(history.reports).toHaveLength(2);
    expect(history.reports.find((item) => item.state === "superseded")?.cohorts).toHaveLength(1);
  });

  it("rejects stale source revisions, conflicting equal revisions, and unqualified generation changes", async () => {
    const fixture = await createV11DeviceFixture(db());
    await activatePerformance(fixture);
    const first = await report();
    await admitTelemetryPerformanceReport(db(), fixture, first, AUTHORIZATION, "b".repeat(64), NOW);

    const lower = await report("gpt-5.6-sol", [record("gpt-5.6-sol")], DAY, 2, "a".repeat(64));
    await expect(admitTelemetryPerformanceReport(
      db(), fixture, lower, AUTHORIZATION, "c".repeat(64), NOW + 1_000,
    )).rejects.toMatchObject({ code: "TELEMETRY_MANIFEST_CONFLICT" });

    const equalDifferentDigest = await report(
      "gpt-5.6-sol", [record("gpt-5.6-sol")], DAY, 3, "b".repeat(64),
    );
    await expect(admitTelemetryPerformanceReport(
      db(), fixture, equalDifferentDigest, AUTHORIZATION, "d".repeat(64), NOW + 2_000,
    )).rejects.toMatchObject({ code: "TELEMETRY_MANIFEST_CONFLICT" });

    const differentGeneration = await report(
      "gpt-5.6-sol", [record("gpt-5.6-sol")], DAY, 3, "c".repeat(64), "source:v2:fixture",
    );
    await expect(admitTelemetryPerformanceReport(
      db(), fixture, differentGeneration, AUTHORIZATION, "e".repeat(64), NOW + 3_000,
    )).rejects.toMatchObject({ code: "TELEMETRY_MANIFEST_CONFLICT" });

    const newer = await report("gpt-5.6-sol", [record("gpt-5.6-sol")], DAY, 4, "c".repeat(64));
    await expect(admitTelemetryPerformanceReport(
      db(), fixture, newer, AUTHORIZATION, "f".repeat(64), NOW + 4_000,
    )).resolves.toMatchObject({ status: "replaced" });
    const current = await db().prepare(
      "SELECT source_generation, source_revision, source_digest, state FROM telemetry_performance_reports WHERE state='current'",
    ).first<{ source_generation: string; source_revision: number; source_digest: string; state: string }>();
    expect(current).toEqual({
      source_generation: "source:v1:fixture", source_revision: 4, source_digest: "c".repeat(64), state: "current",
    });
  });

  it("rejects duplicate cohort identities even when histogram values differ", async () => {
    const left = record();
    const right = {
      ...record(),
      speedDurationMs: 2_000,
      speedTokens: 200,
      speedHistogram: buildPerformanceHistogram("speed", [100]),
      ttftHistogram: buildPerformanceHistogram("ttft", [200]),
      completionHistogram: buildPerformanceHistogram("turnDuration", [2_000]),
    };
    const records = [left, right].sort((a, b) =>
      canonicalTelemetryPerformanceJson(a).localeCompare(canonicalTelemetryPerformanceJson(b)));
    const value = await report("gpt-5.6-luna", records);
    let thrown: unknown;
    try {
      parseTelemetryPerformanceReport(value);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "TELEMETRY_RECORD_INVALID" });
  });

  it("keeps the SQL source-order fence active for direct writers", async () => {
    const fixture = await createV11DeviceFixture(db());
    await activatePerformance(fixture);
    await admitTelemetryPerformanceReport(db(), fixture, await report(), AUTHORIZATION, "b".repeat(64), NOW);
    const current = await db().prepare(
      "SELECT id FROM telemetry_performance_reports WHERE state='current'",
    ).first<{ id: string }>();
    if (!current) throw new Error("missing synthetic current performance report");
    await db().prepare(
      "UPDATE telemetry_performance_reports SET state='superseded', superseded_at=? WHERE id=?",
    ).bind(new Date(NOW).toISOString(), current.id).run();
    await expect(db().prepare(`
      INSERT INTO telemetry_performance_reports (
        id, participant_id, device_id, report_day, report_revision,
        source_generation, source_digest, source_revision, method_version,
        parser_version, schema_version, field_dictionary_version,
        privacy_contract_version, bucket_scheme_version, measurement_version,
        record_count, canonical_bytes, capability_revision, authority_epoch,
        state, created_at
      ) SELECT ?, participant_id, device_id, report_day, ?,
        source_generation, source_digest, 1, method_version,
        parser_version, schema_version, field_dictionary_version,
        privacy_contract_version, bucket_scheme_version, measurement_version,
        record_count, canonical_bytes, capability_revision, authority_epoch,
        'current', ?
        FROM telemetry_performance_reports WHERE id=?
    `).bind(
      crypto.randomUUID(), "d".repeat(64), new Date(NOW + 1_000).toISOString(), current.id,
    ).run()).rejects.toThrow(/telemetry_performance_report_revision_conflict/u);
  });

  it("uses the generic source counter across generation changes and rejects its replay", async () => {
    const fixture = await createV11DeviceFixture(db());
    await activatePerformance(fixture);
    const first = await report("gpt-5.6-luna", [record()], DAY, 1, "a".repeat(64), "timing:1:0");
    await admitTelemetryPerformanceReport(db(), fixture, first, AUTHORIZATION, "b".repeat(64), NOW);
    const later = await report("gpt-5.6-sol", [record("gpt-5.6-sol")], DAY, 2, "b".repeat(64), "timing:2:0");
    await expect(admitTelemetryPerformanceReport(
      db(), fixture, later, AUTHORIZATION, "c".repeat(64), NOW + 1_000,
    )).resolves.toMatchObject({ status: "replaced" });
    const replay = await report("gpt-5.6-luna", [record()], DAY, 1, "c".repeat(64), "timing:1:0");
    await expect(admitTelemetryPerformanceReport(
      db(), fixture, replay, AUTHORIZATION, "d".repeat(64), NOW + 2_000,
    )).rejects.toMatchObject({ code: "TELEMETRY_MANIFEST_CONFLICT" });
  });

  it("requires a distinct accountless performance policy grant", async () => {
    const fixture = await createAccountlessPerformanceFixture();
    const value = await report();
    await db().prepare("UPDATE telemetry_performance_runtime SET state='active' WHERE id=1").run();
    await expect(admitTelemetryPerformanceReport(
      db(), fixture, value, AUTHORIZATION, "b".repeat(64), NOW,
    )).rejects.toMatchObject({ code: "TELEMETRY_TRANSPORT_BLOCKED" });
    await expect(grantTelemetryPerformanceAccountlessAuthorization(db(), fixture, {
      schemaVersion: ACCOUNTLESS_TELEMETRY_PERFORMANCE_SCHEMA_VERSION,
      policyVersion: ACCOUNTLESS_TELEMETRY_PERFORMANCE_POLICY_VERSION,
      authorizationBasis: ACCOUNTLESS_TELEMETRY_PERFORMANCE_AUTHORIZATION_BASIS,
    }, NOW)).resolves.toBeUndefined();
    const capability = await db().prepare(
      "SELECT issued_at, expires_at FROM telemetry_performance_device_capabilities WHERE participant_id=? AND device_id=?",
    ).bind(fixture.participantId, fixture.deviceId).first<{ issued_at: string; expires_at: string }>();
    if (!capability) throw new Error("missing accountless performance capability");
    const authorization = { ...AUTHORIZATION, issuedAt: capability.issued_at, expiresAt: capability.expires_at };
    await expect(admitTelemetryPerformanceReport(
      db(), fixture, value, authorization, "b".repeat(64), NOW,
    )).resolves.toMatchObject({ status: "accepted" });
  });

  it("requires explicit social performance consent instead of usage consent", async () => {
    const fixture = await createV11DeviceFixture(db());
    await db().prepare("UPDATE telemetry_performance_runtime SET state='active' WHERE id=1").run();
    await expect(admitTelemetryPerformanceReport(
      db(), fixture, await report(), AUTHORIZATION, "b".repeat(64), NOW,
    )).rejects.toMatchObject({ code: "TELEMETRY_TRANSPORT_BLOCKED" });
    const capability = await grantTelemetryPerformanceSocialAuthorization(db(), fixture, {
      schemaVersion: "model-performance-daily-v1",
      fieldDictionaryVersion: "telemetry-performance-registry-2026-09-21.1",
      privacyContractVersion: "privacy-safe-model-performance-v1",
      scope: "model-performance-daily",
    }, NOW);
    await expect(admitTelemetryPerformanceReport(
      db(), fixture, await report(), capability.authorization, "c".repeat(64), NOW,
    )).resolves.toMatchObject({ status: "accepted" });
  });

  it("keeps a normal 31-day small-report range readable", async () => {
    const fixture = await createV11DeviceFixture(db());
    await activatePerformance(fixture);
    const days = Array.from({ length: 31 }, (_, index) =>
      new Date(Date.UTC(2026, 7, index + 1)).toISOString().slice(0, 10));
    for (const [index, day] of days.entries()) {
      const digest = (index.toString(16).repeat(64)).slice(0, 64);
      const envelopeDigest = (`e${index.toString(16)}`).repeat(64).slice(0, 64);
      const dailyRecord = { ...record(), day };
      await expect(admitTelemetryPerformanceReport(
        db(), fixture, await report("gpt-5.6-luna", [dailyRecord], day, index + 1,
          digest, "source:normal-range"), AUTHORIZATION, envelopeDigest, NOW + index * 1_000,
      )).resolves.toMatchObject({ status: "accepted" });
    }
    const read = await readTelemetryPerformanceReports(db(), fixture.participantId, {
      fromDay: days[0], throughDay: days.at(-1),
    });
    expect(read.reports).toHaveLength(31);
    expect(read.reports.every((item) => item.cohorts.length === 1)).toBe(true);
  }, 20_000);

  it("admits the maximum dense cohort report through bounded json_each bindings", async () => {
    const fixture = await createV11DeviceFixture(db());
    await activatePerformance(fixture);
    const records = denseRecords();
    expect(records).toHaveLength(1_024);
    const value = await report("gpt-5.6-luna", records, DAY, 8, "d".repeat(64));
    await expect(admitTelemetryPerformanceReport(
      db(), fixture, value, AUTHORIZATION, "e".repeat(64), NOW,
    )).resolves.toMatchObject({ status: "accepted" });
    const counts = await db().batch([
      db().prepare("SELECT count(*) AS total FROM telemetry_performance_cohorts"),
      db().prepare("SELECT count(*) AS total FROM telemetry_performance_buckets"),
    ]);
    const cohortCount = (counts[0]?.results[0] as { total?: number } | undefined)?.total;
    const bucketCount = (counts[1]?.results[0] as { total?: number } | undefined)?.total;
    expect(cohortCount).toBe(1_024);
    expect(bucketCount).toBe(3_072);
  });

  it("refuses a dense multi-day range before materializing detail rows", async () => {
    const fixture = await createV11DeviceFixture(db());
    await activatePerformance(fixture);
    const days = Array.from({ length: 10 }, (_, index) =>
      `2026-09-${String(index + 1).padStart(2, "0")}`);
    for (const [index, day] of days.entries()) {
      const digest = (index.toString(16).repeat(64)).slice(0, 64);
      const envelopeDigest = `${"f".repeat(63)}${index.toString(16)}`;
      await expect(admitTelemetryPerformanceReport(
        db(), fixture, await report("gpt-5.6-luna", denseRecords(day), day, index + 1,
          digest, `source:dense:${index}`), AUTHORIZATION, envelopeDigest, NOW + index * 1_000,
      )).resolves.toMatchObject({ status: "accepted" });
    }
    const totals = await db().prepare(
      "SELECT count(*) AS reports, sum(canonical_bytes) AS canonical_bytes, sum(record_count) AS record_count FROM telemetry_performance_reports",
    ).first<{ reports: number; canonical_bytes: number; record_count: number }>();
    expect(totals).toMatchObject({ reports: 10, record_count: 10_240 });
    expect(totals?.canonical_bytes).toBeGreaterThan(8 * 1024 * 1024);

    await expect(readTelemetryPerformanceReports(
      rejectPerformanceDetailReads(db()), fixture.participantId,
    )).rejects.toMatchObject({ code: "SYNC_RANGE_TOO_LARGE" });
  }, 30_000);
});
