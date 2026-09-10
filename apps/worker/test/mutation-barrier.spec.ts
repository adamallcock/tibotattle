import { applyD1Migrations, env, reset } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildMutationBarrierPermissionStatements,
  buildMutationBarrierReinstallStatements,
  buildMutationBarrierSetupStatements,
  MIGRATION_MUTATION_BARRIER_ENABLED,
  MUTATION_BARRIER_ABORT_CODE,
  MUTATION_BARRIER_ASSERTION_TABLE,
  MUTATION_BARRIER_PERMISSION_TABLE,
  MUTATION_BARRIER_PRODUCT_TABLES_QUERY,
  MUTATION_BARRIER_STATE_TABLE,
  mutationBarrierBlocksDynamicRequest,
  mutationBarrierOwnedMovementTables,
  mutationBarrierProductTablesFromSchema,
  mutationBarrierSkipsScheduledMaintenance,
  type MutationBarrierStatement,
} from "../src/mutation-barrier";
import { handleRequest, runScheduledMaintenance } from "../src/index";

interface TestBindings extends Env {
  TEST_MIGRATIONS: D1Migration[];
}

const OPERATION_ID = "accountless-migration-v1";
const SOURCE_REVISION = "a".repeat(40);
const CREATED_AT = "2026-09-09T00:00:00.000Z";

function db(): D1Database {
  return (env as TestBindings).USAGE_MONITOR_DB;
}

function prepared(statement: MutationBarrierStatement): D1PreparedStatement {
  return db().prepare(statement.sql).bind(...statement.params);
}

async function execute(statements: readonly MutationBarrierStatement[]): Promise<void> {
  await db().batch(statements.map(prepared));
}

async function currentProductTables(): Promise<readonly string[]> {
  const rows = await db().prepare(MUTATION_BARRIER_PRODUCT_TABLES_QUERY)
    .all<{ name: string }>();
  return mutationBarrierProductTablesFromSchema(rows.results);
}

async function establishBarrier(): Promise<readonly string[]> {
  const productTables = await currentProductTables();
  await execute(buildMutationBarrierSetupStatements({
    operationId: OPERATION_ID,
    sourceRevision: SOURCE_REVISION,
    createdAt: CREATED_AT,
    productTables,
  }));
  return productTables;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(
    db(),
    (env as TestBindings).TEST_MIGRATIONS.filter(
      (migration) => Number(migration.name.slice(0, 4)) <= 57,
    ),
  );
});

describe("accountless migration mutation barrier", () => {
  it("fences every discovered product table including the D1 migration ledger", async () => {
    const productTables = await establishBarrier();
    expect(productTables).toContain("d1_migrations");
    expect(productTables).toContain("collection_controls");

    const triggers = await db().prepare(`
      SELECT tbl_name AS tableName
        FROM sqlite_master
       WHERE type = 'trigger'
         AND name GLOB '_accountless_migration_barrier_v1_*'
       ORDER BY name
    `).all<{ tableName: string }>();
    expect(triggers.results).toHaveLength(productTables.length * 3);
    expect(new Set(triggers.results.map((trigger) => trigger.tableName)))
      .toEqual(new Set(productTables));

    await expect(db().prepare(`
      UPDATE collection_controls
         SET revision = revision + 1
       WHERE singleton = 1
    `).run()).rejects.toThrow(MUTATION_BARRIER_ABORT_CODE);
    await expect(db().prepare(
      "INSERT INTO d1_migrations(name) VALUES('synthetic-unapproved-migration.sql')",
    ).run()).rejects.toThrow(MUTATION_BARRIER_ABORT_CODE);
  });

  it("allows only an exact transaction marker and removes it before commit", async () => {
    await establishBarrier();
    const before = await db().prepare(
      "SELECT revision FROM collection_controls WHERE singleton = 1",
    ).first<{ revision: number }>();
    const permission = buildMutationBarrierPermissionStatements(OPERATION_ID);
    await db().batch([
      prepared(permission.begin),
      db().prepare(`
        UPDATE collection_controls
           SET revision = revision + 1
         WHERE singleton = 1
      `),
      ...permission.end.map(prepared),
    ]);
    const control = await db().prepare(
      "SELECT revision FROM collection_controls WHERE singleton = 1",
    ).first<{ revision: number }>();
    expect(control?.revision).toBe((before?.revision ?? 0) + 1);
    expect(await db().prepare(
      `SELECT operation_id FROM "${MUTATION_BARRIER_PERMISSION_TABLE}"`,
    ).first()).toBeNull();
    await expect(db().prepare(
      "UPDATE collection_controls SET revision = revision + 1 WHERE singleton = 1",
    ).run()).rejects.toThrow(MUTATION_BARRIER_ABORT_CODE);

    await expect(db().batch([
      prepared(permission.begin),
      db().prepare(
        "UPDATE collection_controls SET revision = revision + 1 WHERE singleton = 1",
      ),
      db().prepare(
        `DELETE FROM "${MUTATION_BARRIER_PERMISSION_TABLE}" WHERE singleton = 1`,
      ),
      ...permission.end.map(prepared),
    ])).rejects.toThrow();
    const afterFailedEnd = await db().prepare(
      "SELECT revision FROM collection_controls WHERE singleton = 1",
    ).first<{ revision: number }>();
    expect(afterFailedEnd?.revision).toBe(control?.revision);
    expect(await db().prepare(
      `SELECT operation_id FROM "${MUTATION_BARRIER_PERMISSION_TABLE}"`,
    ).first()).toBeNull();

    const wrongPermission = buildMutationBarrierPermissionStatements(
      "accountless-migration-v2",
    );
    await expect(db().batch([
      prepared(wrongPermission.begin),
      ...wrongPermission.end.map(prepared),
    ])).rejects.toThrow();
    expect(await db().prepare(
      `SELECT operation_id FROM "${MUTATION_BARRIER_PERMISSION_TABLE}"`,
    ).first()).toBeNull();
  });

  it("fails closed if its state row is lost and reinstallation preserves the fence", async () => {
    const productTables = await establishBarrier();
    await db().prepare(`DELETE FROM "${MUTATION_BARRIER_STATE_TABLE}"`).run();
    await expect(db().prepare(
      "UPDATE collection_controls SET revision = revision + 1 WHERE singleton = 1",
    ).run()).rejects.toThrow(MUTATION_BARRIER_ABORT_CODE);

    await expect(execute(buildMutationBarrierReinstallStatements(productTables)))
      .resolves.toBeUndefined();
    await expect(db().prepare(
      "UPDATE collection_controls SET revision = revision + 1 WHERE singleton = 1",
    ).run()).rejects.toThrow(MUTATION_BARRIER_ABORT_CODE);
  });

  it("rejects unknown control-looking schema names instead of silently exempting them", () => {
    const owned = mutationBarrierOwnedMovementTables(["participants"]);
    expect(mutationBarrierProductTablesFromSchema([
      { name: "d1_migrations" },
      { name: "participants" },
      { name: "_accountless_move_journal" },
      { name: "_accountless_move_assertion" },
      { name: "_accountless_move_participants" },
      { name: "_cf_internal" },
    ], owned)).toEqual(["d1_migrations", "participants"]);
    expect(() => mutationBarrierProductTablesFromSchema([
      { name: "participants" },
      { name: "_accountless_move_unrecognized" },
    ], owned)).toThrow("mutation barrier schema rows are invalid");
    expect(() => mutationBarrierProductTablesFromSchema([
      { name: "participants" },
    ], ["participants"])).toThrow("mutation barrier owned table set is invalid");
    expect(() => mutationBarrierOwnedMovementTables(["d1_migrations"]))
      .toThrow("mutation barrier product table set is invalid");
  });

  it("keeps ordinary assets outside the migration-only HTTP gate and skips cron only in the explicit source snapshot", () => {
    expect(MIGRATION_MUTATION_BARRIER_ENABLED).toBe(false);
    expect(mutationBarrierBlocksDynamicRequest("asset", false, true)).toBe(false);
    expect(mutationBarrierBlocksDynamicRequest("asset", true, true)).toBe(true);
    expect(mutationBarrierBlocksDynamicRequest("health", false, true)).toBe(true);
    expect(mutationBarrierBlocksDynamicRequest("health", false)).toBe(false);
    expect(mutationBarrierSkipsScheduledMaintenance(true)).toBe(true);
    expect(mutationBarrierSkipsScheduledMaintenance()).toBe(false);
  });

  it("uses the real request and cron gates before any storage access", async () => {
    const dynamic = await handleRequest(
      new Request("https://example.test/api/health"),
      {} as Env,
      true,
    );
    expect(dynamic.status).toBe(503);
    expect(await dynamic.json()).toMatchObject({
      error: { code: "MUTATION_BARRIER_ACTIVE" },
    });

    const adminAsset = await handleRequest(
      new Request("https://admin.tibotattle.com/arbitrary-static-path"),
      { PUBLIC_ORIGIN: "https://tibotattle.com" } as Env,
      true,
    );
    expect(adminAsset.status).toBe(503);
    expect(await adminAsset.json()).toMatchObject({
      error: { code: "MUTATION_BARRIER_ACTIVE" },
    });

    const publicAssetFailure = await handleRequest(
      new Request("https://tibotattle.com/arbitrary-static-path"),
      {
        PUBLIC_ORIGIN: "https://tibotattle.com",
        ASSETS: { fetch: () => { throw new Error("synthetic asset failure"); } },
      } as unknown as Env,
      true,
    );
    expect(publicAssetFailure.status).toBe(500);
    expect(await publicAssetFailure.json()).toMatchObject({
      error: { code: "INTERNAL_ERROR" },
    });

    const scheduled = await runScheduledMaintenance({} as Env, Date.now(), true);
    expect(scheduled).toMatchObject({
      outcome: "skipped",
      code: "MUTATION_BARRIER_ACTIVE",
    });
  });
});
