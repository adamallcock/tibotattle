import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  activateTelemetryRuntimeAsOwner,
  EXPECTED_PRIMARY_MIGRATIONS,
  parseTelemetryRuntimeActivationRequest,
  TELEMETRY_RUNTIME_ACTIVATION_CONFIRMATIONS,
  type TelemetryRuntimeActivationRequest,
} from "../src/telemetry-runtime-activation";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";
import { initializeTypedV11Admission } from "../src/typed-v11-admission";
import { initializeStorageSource } from "../src/analytics-delivery";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
}

const bindings = () => env as TestBindings;
const db = () => bindings().USAGE_MONITOR_DB;
const SOURCE_NAMESPACE = "synthetic-runtime-activation";
const ACTOR_IDENTITY_KEY = "a".repeat(64);
const NOW_EPOCH = Date.parse("2026-09-22T15:00:00.000Z");
const settings = {
  TELEMETRY_STORAGE_MODE: "typed",
  TELEMETRY_STORAGE_NAMESPACE: SOURCE_NAMESPACE,
} as const;

function request(
  target: "usage_v12" | "performance",
  expectedRevision = 1,
): TelemetryRuntimeActivationRequest {
  return {
    target,
    expectedRevision,
    confirmation: TELEMETRY_RUNTIME_ACTIVATION_CONFIRMATIONS[target],
  };
}

async function runtimeRow(target: "usage_v12" | "performance") {
  const table = target === "usage_v12" ? "telemetry_v12_runtime" : "telemetry_performance_runtime";
  return db().prepare(`SELECT state, policy_revision FROM ${table} WHERE id = 1`)
    .first<{ state: string; policy_revision: number }>();
}

async function installForwardLedger(): Promise<void> {
  await db().prepare(
    "CREATE TABLE d1_storage_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64)) STRICT",
  ).run();
  await db().batch(EXPECTED_PRIMARY_MIGRATIONS.map((migration) => db().prepare(
    "INSERT INTO d1_storage_migrations(name, sha256) VALUES (?, ?)",
  ).bind(migration.name, migration.sha256)));
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(db(), bindings().TEST_MIGRATIONS);
  await applyD1Migrations(db(), bindings().TEST_TYPED_INGESTION_MIGRATIONS);
  await applyD1Migrations(db(), bindings().TEST_INGESTION_BRIDGE_MIGRATIONS);
  await applyD1Migrations(db(), bindings().TEST_TYPED_V11_ADMISSION_MIGRATIONS);
  await applyD1Migrations(db(), bindings().TEST_TYPED_V1_ADMISSION_MIGRATIONS);
  await applyD1Migrations(db(), bindings().TEST_INGESTION_ISOLATION_MIGRATIONS);
  await initializeStorageSource(db(), SOURCE_NAMESPACE);
  await initializeTypedV11Admission(db(), SOURCE_NAMESPACE);
  await initializeTypedV1Admission(db(), SOURCE_NAMESPACE);
  await installForwardLedger();
}, 30_000);

describe("protected telemetry runtime activation", () => {
  it("accepts only the exact nested action and target confirmation", () => {
    expect(parseTelemetryRuntimeActivationRequest({
      action: "run_maintenance",
      telemetryRuntimeActivation: request("usage_v12"),
    })).toMatchObject(request("usage_v12"));
    expect(() => parseTelemetryRuntimeActivationRequest({
      action: "run_maintenance",
      telemetryRuntimeActivation: {
        ...request("usage_v12"),
        confirmation: "activate_performance",
      },
    })).toThrowError("BODY_INVALID");
    expect(() => parseTelemetryRuntimeActivationRequest({
      action: "run_maintenance",
      telemetryRuntimeActivation: {
        ...request("usage_v12"),
        extra: "unexpected",
      },
    })).toThrowError("BODY_INVALID");
  });

  it("activates usage and performance independently with one revision step", async () => {
    const usage = await activateTelemetryRuntimeAsOwner(db(), settings, ACTOR_IDENTITY_KEY,
      request("usage_v12"), NOW_EPOCH);
    expect(usage).toMatchObject({ target: "usage_v12", state: "active", fromRevision: 1, toRevision: 2 });
    expect(await runtimeRow("usage_v12")).toEqual({ state: "active", policy_revision: 2 });
    expect(await runtimeRow("performance")).toEqual({ state: "staged", policy_revision: 1 });

    const performance = await activateTelemetryRuntimeAsOwner(db(), settings, ACTOR_IDENTITY_KEY,
      request("performance"), NOW_EPOCH);
    expect(performance).toMatchObject({ target: "performance", state: "active", fromRevision: 1, toRevision: 2 });
    expect(await runtimeRow("performance")).toEqual({ state: "active", policy_revision: 2 });
  });

  it("refuses a wrong revision and never treats an active replay as success", async () => {
    await expect(activateTelemetryRuntimeAsOwner(db(), settings, ACTOR_IDENTITY_KEY,
      request("usage_v12", 2), NOW_EPOCH)).rejects.toMatchObject({
      status: 409,
      code: "ADMIN_ACTION_CONFLICT",
    });
    expect(await runtimeRow("usage_v12")).toEqual({ state: "staged", policy_revision: 1 });

    await activateTelemetryRuntimeAsOwner(db(), settings, ACTOR_IDENTITY_KEY,
      request("usage_v12"), NOW_EPOCH);
    await expect(activateTelemetryRuntimeAsOwner(db(), settings, ACTOR_IDENTITY_KEY,
      request("usage_v12"), NOW_EPOCH)).rejects.toMatchObject({
      status: 409,
      code: "ADMIN_ACTION_CONFLICT",
    });
    expect(await runtimeRow("usage_v12")).toEqual({ state: "active", policy_revision: 2 });
  });

  it.each([
    ["JSON storage mode", { TELEMETRY_STORAGE_MODE: "json", TELEMETRY_STORAGE_NAMESPACE: "" }],
    ["missing typed namespace", { TELEMETRY_STORAGE_MODE: "typed", TELEMETRY_STORAGE_NAMESPACE: "" }],
  ])("refuses %s", async (_label, invalidSettings) => {
    await expect(activateTelemetryRuntimeAsOwner(db(), invalidSettings, ACTOR_IDENTITY_KEY,
      request("usage_v12"), NOW_EPOCH)).rejects.toMatchObject({
      status: 503,
      code: "TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE",
    });
    expect(await runtimeRow("usage_v12")).toEqual({ state: "staged", policy_revision: 1 });
  });

  it.each([
    ["upload registration", "upload_registration_enabled", "UPLOAD_REGISTRATION_DISABLED"],
    ["processing", "processing_enabled", "PROCESSING_DISABLED"],
  ])("refuses when %s is disabled", async (_label, column, code) => {
    await db().prepare(
      `UPDATE collection_controls
          SET ${column} = 0, control_state = 'degraded', revision = revision + 1
        WHERE singleton = 1`,
    ).run();
    await expect(activateTelemetryRuntimeAsOwner(db(), settings, ACTOR_IDENTITY_KEY,
      request("usage_v12"), NOW_EPOCH)).rejects.toMatchObject({ status: 503, code });
    expect(await runtimeRow("usage_v12")).toEqual({ state: "staged", policy_revision: 1 });
  });

  it("refuses an incomplete schema before changing the runtime", async () => {
    await db().prepare("DROP TABLE telemetry_performance_reports").run();
    await expect(activateTelemetryRuntimeAsOwner(db(), settings, ACTOR_IDENTITY_KEY,
      request("usage_v12"), NOW_EPOCH)).rejects.toMatchObject({
      status: 503,
      code: "TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE",
    });
    expect(await runtimeRow("usage_v12")).toEqual({ state: "staged", policy_revision: 1 });
  });

  it("refuses a wrong performance method tuple", async () => {
    await db().prepare(
      "UPDATE telemetry_performance_runtime SET method_version = 'wrong-method' WHERE id = 1",
    ).run();
    await expect(activateTelemetryRuntimeAsOwner(db(), settings, ACTOR_IDENTITY_KEY,
      request("performance"), NOW_EPOCH)).rejects.toMatchObject({
      status: 503,
      code: "TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE",
    });
    expect(await runtimeRow("performance")).toEqual({ state: "staged", policy_revision: 1 });
  });

  it("refuses a forward migration ledger hash mismatch", async () => {
    await db().prepare(
      "UPDATE d1_storage_migrations SET sha256 = ? WHERE name = ?",
    ).bind("0".repeat(64), "0009_performance_reports.sql").run();
    await expect(activateTelemetryRuntimeAsOwner(db(), settings, ACTOR_IDENTITY_KEY,
      request("usage_v12"), NOW_EPOCH)).rejects.toMatchObject({
      status: 503,
      code: "TELEMETRY_RUNTIME_ACTIVATION_UNAVAILABLE",
    });
    expect(await runtimeRow("usage_v12")).toEqual({ state: "staged", policy_revision: 1 });
  });

  it("keeps audit details content-free", async () => {
    await activateTelemetryRuntimeAsOwner(db(), settings, ACTOR_IDENTITY_KEY,
      request("usage_v12"), NOW_EPOCH);
    const rows = (await db().prepare(
      "SELECT outcome, details_json FROM admin_action_audit ORDER BY id",
    ).all<{ outcome: string; details_json: string }>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("success");
    expect(rows[0]?.details_json).toContain('"target":"usage_v12"');
    expect(rows[0]?.details_json).toContain('"fromRevision":1');
    expect(rows[0]?.details_json).toContain('"toRevision":2');
    expect(rows[0]?.details_json).not.toContain("participant");
    expect(rows[0]?.details_json).not.toContain("payload");
  });
});
