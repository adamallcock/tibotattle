import { applyD1Migrations, env, reset, type D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  activateTelemetryRuntimeAsOwner,
  canonicalTelemetryRuntimeDeploymentAttestationJson,
  canonicalTelemetryRuntimeReconciliationJson,
  EXPECTED_ANALYTICS_MIGRATIONS,
  EXPECTED_PRIMARY_MIGRATIONS,
  parseTelemetryRuntimeActivationRequest,
  TELEMETRY_RUNTIME_ACTIVATION_CONFIRMATIONS,
  TELEMETRY_RUNTIME_DEPLOYMENT_ATTESTATION_SCHEMA,
  TELEMETRY_RUNTIME_RECONCILIATION_SCHEMA,
  telemetryRuntimeReconciliationDigests,
  type TelemetryRuntimeActivationRequest,
} from "../src/telemetry-runtime-activation";
import { sha256Hex } from "../src/crypto";
import { initializeTypedV1Admission } from "../src/typed-v1-admission";
import { initializeTypedV11Admission } from "../src/typed-v11-admission";
import { initializeStorageSource } from "../src/analytics-delivery";

interface TestBindings extends Env {
  STORAGE_ANALYTICS_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
  TEST_TYPED_INGESTION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_BRIDGE_MIGRATIONS: D1Migration[];
  TEST_TYPED_V11_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_TYPED_V1_ADMISSION_MIGRATIONS: D1Migration[];
  TEST_INGESTION_ISOLATION_MIGRATIONS: D1Migration[];
  TEST_ANALYTICS_MIGRATIONS: D1Migration[];
}

const bindings = () => env as TestBindings;
const db = () => bindings().USAGE_MONITOR_DB;
const analytics = () => bindings().STORAGE_ANALYTICS_DB;
const SOURCE_NAMESPACE = "synthetic-runtime-activation";
const ACTOR_IDENTITY_KEY = "a".repeat(64);
const NOW_EPOCH = Date.parse("2026-09-22T15:00:00.000Z");
const SOURCE_COMMIT = "eaf6f521fb9842399da512fd1ad5020c7b706f5b";
const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const CONFIG_SHA256 = "b".repeat(64);
const settings: Record<string, unknown> = {
  TELEMETRY_STORAGE_MODE: "typed",
  TELEMETRY_STORAGE_NAMESPACE: SOURCE_NAMESPACE,
  DEPLOYMENT_SOURCE_COMMIT: SOURCE_COMMIT,
  ANALYTICS_DB: undefined,
};
let reconciliationProof!: TelemetryRuntimeActivationRequest["reconciliation"];

function request(
  target: "usage_v12" | "performance",
  expectedRevision = 1,
  idempotencyKey = target === "usage_v12"
    ? "22222222-2222-4222-8222-222222222222"
    : "33333333-3333-4333-8333-333333333333",
): TelemetryRuntimeActivationRequest {
  return {
    idempotencyKey,
    target,
    expectedRevision,
    confirmation: TELEMETRY_RUNTIME_ACTIVATION_CONFIRMATIONS[target],
    reconciliation: reconciliationProof,
  };
}

async function runtimeRow(target: "usage_v12" | "performance") {
  const table = target === "usage_v12" ? "telemetry_v12_runtime" : "telemetry_performance_runtime";
  return db().prepare(`SELECT state, policy_revision FROM ${table} WHERE id = 1`)
    .first<{ state: string; policy_revision: number }>();
}

async function installForwardLedger(): Promise<void> {
  await applyD1Migrations(analytics(), bindings().TEST_ANALYTICS_MIGRATIONS);
  await db().prepare(
    "CREATE TABLE d1_storage_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64)) STRICT",
  ).run();
  await db().batch(EXPECTED_PRIMARY_MIGRATIONS.map((migration) => db().prepare(
    "INSERT INTO d1_storage_migrations(name, sha256) VALUES (?, ?)",
  ).bind(migration.name, migration.sha256)));
  await analytics().prepare(
    "CREATE TABLE d1_storage_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64)) STRICT",
  ).run();
  await analytics().batch(EXPECTED_ANALYTICS_MIGRATIONS.map((migration) => analytics().prepare(
    "INSERT INTO d1_storage_migrations(name, sha256) VALUES (?, ?)",
  ).bind(migration.name, migration.sha256)));
}

async function installReconciliationProof(): Promise<void> {
  const deploymentAttestationUnsigned = {
    schema: TELEMETRY_RUNTIME_DEPLOYMENT_ATTESTATION_SCHEMA,
    capturedAt: "2026-09-22T14:58:00.000Z",
    sourceCommit: SOURCE_COMMIT,
    versionId: VERSION_ID,
    configSha256: CONFIG_SHA256,
  } as const;
  const deploymentAttestation = {
    ...deploymentAttestationUnsigned,
    attestationSha256: await sha256Hex(
      canonicalTelemetryRuntimeDeploymentAttestationJson(deploymentAttestationUnsigned),
    ),
  };
  const proofWithoutDigest = {
    schema: TELEMETRY_RUNTIME_RECONCILIATION_SCHEMA,
    capturedAt: "2026-09-22T14:59:00.000Z",
    sourceCommit: SOURCE_COMMIT,
    versionId: VERSION_ID,
    configSha256: CONFIG_SHA256,
    deploymentAttestation,
    primary: await telemetryRuntimeReconciliationDigests(db()),
    analytics: await telemetryRuntimeReconciliationDigests(analytics()),
  } satisfies Omit<TelemetryRuntimeActivationRequest["reconciliation"], "proofSha256">;
  reconciliationProof = Object.freeze({
    ...proofWithoutDigest,
    proofSha256: await sha256Hex(canonicalTelemetryRuntimeReconciliationJson(proofWithoutDigest)),
  });
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
  settings.ANALYTICS_DB = analytics();
  await installReconciliationProof();
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
    expect(() => parseTelemetryRuntimeActivationRequest({
      action: "run_maintenance",
      telemetryRuntimeActivation: {
        ...request("usage_v12"),
        idempotencyKey: "not-a-uuid",
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

  it("refuses a wrong revision and only replays an exact active operation", async () => {
    await expect(activateTelemetryRuntimeAsOwner(db(), settings, ACTOR_IDENTITY_KEY,
      request("usage_v12", 2), NOW_EPOCH)).rejects.toMatchObject({
      status: 409,
      code: "ADMIN_ACTION_CONFLICT",
    });
    expect(await runtimeRow("usage_v12")).toEqual({ state: "staged", policy_revision: 1 });

    await activateTelemetryRuntimeAsOwner(db(), settings, ACTOR_IDENTITY_KEY,
      request("usage_v12"), NOW_EPOCH);
    const replay = await activateTelemetryRuntimeAsOwner(db(), settings, ACTOR_IDENTITY_KEY,
      request("usage_v12"), NOW_EPOCH);
    expect(replay).toMatchObject({ target: "usage_v12", state: "active", toRevision: 2 });
    await expect(activateTelemetryRuntimeAsOwner(db(), settings, ACTOR_IDENTITY_KEY,
      request("usage_v12", 1, "44444444-4444-4444-8444-444444444444"), NOW_EPOCH)).rejects.toMatchObject({
      status: 409,
      code: "ADMIN_ACTION_CONFLICT",
    });
    expect(await runtimeRow("usage_v12")).toEqual({ state: "active", policy_revision: 2 });
  });

  it("replays a completed operation before freshness and control gates", async () => {
    const completed = request("usage_v12");
    await activateTelemetryRuntimeAsOwner(db(), settings, ACTOR_IDENTITY_KEY, completed, NOW_EPOCH);
    await db().prepare(
      `UPDATE collection_controls
          SET upload_registration_enabled = 0, control_state = 'degraded', revision = revision + 1
        WHERE singleton = 1`,
    ).run();
    const replay = await activateTelemetryRuntimeAsOwner(
      db(), settings, ACTOR_IDENTITY_KEY, completed, NOW_EPOCH + 86_400_001,
    );
    expect(replay).toMatchObject({
      operationId: completed.idempotencyKey,
      target: "usage_v12",
      state: "active",
      toRevision: 2,
    });
  });

  it("recovers a committed batch response loss and rejects conflicting key reuse", async () => {
    const first = request("usage_v12", 1, "55555555-5555-4555-8555-555555555555");
    const realBatch = db().batch.bind(db());
    let loseResponse = true;
    const responseLostDb = new Proxy(db(), {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const result = await realBatch(statements);
            if (loseResponse) {
              loseResponse = false;
              throw new Error("synthetic_response_lost_after_commit");
            }
            return result;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as D1Database;
    const recovered = await activateTelemetryRuntimeAsOwner(
      responseLostDb,
      settings,
      ACTOR_IDENTITY_KEY,
      first,
      NOW_EPOCH,
    );
    expect(recovered).toMatchObject({
      operationId: first.idempotencyKey,
      target: "usage_v12",
      state: "active",
      toRevision: 2,
    });
    expect((await db().prepare(
      "SELECT outcome FROM admin_action_audit WHERE operation_id = ?",
    ).bind(first.idempotencyKey).first<{ outcome: string }>())?.outcome).toBe("success");
    const exactReplay = await activateTelemetryRuntimeAsOwner(
      db(), settings, ACTOR_IDENTITY_KEY, first, NOW_EPOCH,
    );
    expect(exactReplay).toMatchObject({ operationId: first.idempotencyKey, toRevision: 2 });
    await expect(activateTelemetryRuntimeAsOwner(
      db(),
      settings,
      ACTOR_IDENTITY_KEY,
      request("usage_v12", 1, first.idempotencyKey),
      NOW_EPOCH,
    )).resolves.toMatchObject({ operationId: first.idempotencyKey });
    const conflicting = {
      ...request("performance", 1, first.idempotencyKey),
      reconciliation: reconciliationProof,
    };
    await expect(activateTelemetryRuntimeAsOwner(
      db(), settings, ACTOR_IDENTITY_KEY, conflicting, NOW_EPOCH,
    )).rejects.toMatchObject({ status: 409, code: "ADMIN_ACTION_CONFLICT" });
  });

  it("does not claim a competing activation after a deterministic zero-row CAS", async () => {
    const losingRequest = request("usage_v12", 1, "66666666-6666-4666-8666-666666666666");
    const realBatch = db().batch.bind(db());
    let winnerApplied = false;
    const losingDb = new Proxy(db(), {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!winnerApplied) {
              winnerApplied = true;
              await db().prepare(
                `UPDATE telemetry_v12_runtime
                    SET state = 'active', policy_revision = 2
                  WHERE id = 1 AND state = 'staged' AND policy_revision = 1`,
              ).run();
            }
            return realBatch(statements);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;

    await expect(activateTelemetryRuntimeAsOwner(
      losingDb, settings, ACTOR_IDENTITY_KEY, losingRequest, NOW_EPOCH,
    )).rejects.toMatchObject({ status: 409, code: "ADMIN_ACTION_CONFLICT" });
    expect(await runtimeRow("usage_v12")).toEqual({ state: "active", policy_revision: 2 });
    expect((await db().prepare(
      "SELECT outcome FROM admin_action_audit WHERE operation_id = ?",
    ).bind(losingRequest.idempotencyKey).first<{ outcome: string }>())?.outcome).toBe("failure");
  });

  it("resumes a started intent left behind by a pre-batch crash", async () => {
    const resumedRequest = request("usage_v12", 1, "77777777-7777-4777-8777-777777777777");
    await db().prepare(
      `INSERT INTO admin_action_audit (
        operation_id, action, actor_identity_digest, outcome, details_json, created_at
      ) VALUES (?, 'run_maintenance', ?, 'started', ?, ?)`,
    ).bind(
      resumedRequest.idempotencyKey,
      "a".repeat(64),
      JSON.stringify({
        schemaVersion: "telemetry-runtime-activation-v1",
        task: "telemetry_runtime_activation",
        idempotencyKey: resumedRequest.idempotencyKey,
        target: resumedRequest.target,
        expectedRevision: resumedRequest.expectedRevision,
        reconciliation: resumedRequest.reconciliation,
      }),
      new Date(NOW_EPOCH).toISOString(),
    ).run();

    const resumed = await activateTelemetryRuntimeAsOwner(
      db(), settings, ACTOR_IDENTITY_KEY, resumedRequest, NOW_EPOCH,
    );
    expect(resumed).toMatchObject({
      operationId: resumedRequest.idempotencyKey,
      target: "usage_v12",
      state: "active",
      toRevision: 2,
    });
    expect((await db().prepare(
      "SELECT COUNT(*) AS count, MAX(outcome) AS outcome FROM admin_action_audit WHERE operation_id = ?",
    ).bind(resumedRequest.idempotencyKey).first<{ count: number; outcome: string }>())).toEqual({
      count: 1,
      outcome: "success",
    });
  });

  it("does not promote a started audit beside an active runtime", async () => {
    const ambiguousRequest = request("usage_v12", 1, "88888888-8888-4888-8888-888888888888");
    await db().prepare(
      `INSERT INTO admin_action_audit (
        operation_id, action, actor_identity_digest, outcome, details_json, created_at
      ) VALUES (?, 'run_maintenance', ?, 'started', ?, ?)`,
    ).bind(
      ambiguousRequest.idempotencyKey,
      "a".repeat(64),
      JSON.stringify({
        schemaVersion: "telemetry-runtime-activation-v1",
        task: "telemetry_runtime_activation",
        idempotencyKey: ambiguousRequest.idempotencyKey,
        target: ambiguousRequest.target,
        expectedRevision: ambiguousRequest.expectedRevision,
        reconciliation: ambiguousRequest.reconciliation,
      }),
      new Date(NOW_EPOCH).toISOString(),
    ).run();
    await db().prepare(
      "UPDATE telemetry_v12_runtime SET state = 'active', policy_revision = 2 WHERE id = 1",
    ).run();

    await expect(activateTelemetryRuntimeAsOwner(
      db(), settings, ACTOR_IDENTITY_KEY, ambiguousRequest, NOW_EPOCH,
    )).rejects.toMatchObject({
      status: 503,
      code: "TELEMETRY_RUNTIME_ACTIVATION_RECONCILE_REQUIRED",
    });
    expect((await db().prepare(
      "SELECT outcome FROM admin_action_audit WHERE operation_id = ?",
    ).bind(ambiguousRequest.idempotencyKey).first<{ outcome: string }>())?.outcome).toBe("started");
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
