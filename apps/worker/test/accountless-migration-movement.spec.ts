import { env, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { accountlessMovementSelection, planAccountlessMovementBatch, type MovementSelectionRow } from "../scripts/accountless-migration-movement.mjs";
import { buildMutationBarrierSetupStatements, buildMutationBarrierPermissionStatements,
  MUTATION_BARRIER_PERMISSION_TABLE, MUTATION_BARRIER_ABORT_CODE } from "../src/mutation-barrier";

type MovementState = Parameters<typeof accountlessMovementSelection>[0];
type Statement = { readonly sql: string; readonly params: readonly unknown[] };
const db = () => env.USAGE_MONITOR_DB;
const permission = {
  begin: { sql: "UPDATE movement_permission SET allowed=1 WHERE singleton=1", params: [] },
  end: [{ sql: "UPDATE movement_permission SET allowed=0 WHERE singleton=1", params: [] },
    { sql: "INSERT OR REPLACE INTO _accountless_move_assertion(id,ok) VALUES(1,changes()=1)", params: [] }],
};
const initialState = (): MovementState => ({
  digest: "a".repeat(64), phase: "evacuate", revision: 0, tableIndex: 0, cursor: 0,
  order: ["movement_parent", "movement_child"], sequences: [], canonicalObjects: null,
  descriptors: {
    movement_parent: { columns: ["id", "label"], hasRowid: true, keys: ["rowid"], integerKeys: ["rowid"] },
    movement_child: { columns: ["id", "parent_id", "note"], hasRowid: true, keys: ["rowid"], integerKeys: ["rowid"] },
  },
});
async function batch(statements: readonly Statement[]) {
  return db().batch(statements.map(({ sql, params }) => db().prepare(sql).bind(...params)));
}
async function readState(): Promise<MovementState> {
  const row = await db().prepare("SELECT metadata FROM _accountless_move_journal WHERE id=1").first<{ metadata: string }>();
  if (!row) throw new Error("Missing synthetic movement journal");
  return JSON.parse(row.metadata) as MovementState;
}
async function plan(value?: MovementState) {
  const current = value ?? await readState();
  const selection = accountlessMovementSelection(current, { maxRows: 2 });
  const selected = await db().prepare(selection.sql).bind(...selection.params).all<MovementSelectionRow>();
  return planAccountlessMovementBatch({ current, selectedRows: selected.results, expectedRevision: current.revision,
    maxRows: 2, maxBytes: 1024, permission });
}

beforeEach(async () => {
  await reset();
  await batch([
    { sql: "CREATE TABLE movement_parent(id INTEGER PRIMARY KEY,label TEXT NOT NULL)", params: [] },
    { sql: "CREATE TABLE movement_child(id INTEGER PRIMARY KEY,parent_id INTEGER NOT NULL REFERENCES movement_parent(id) ON DELETE CASCADE,note TEXT)", params: [] },
    { sql: "INSERT INTO movement_parent VALUES(1,'synthetic parent')", params: [] },
    { sql: "INSERT INTO movement_child VALUES(9007199254741007,1,NULL),(9007199254741011,1,'synthetic child')", params: [] },
    { sql: "CREATE TABLE _accountless_move_journal(id INTEGER PRIMARY KEY CHECK(id=1),metadata TEXT NOT NULL)", params: [] },
    { sql: "CREATE TABLE _accountless_move_assertion(id INTEGER PRIMARY KEY CHECK(id=1),ok INTEGER NOT NULL CHECK(ok=1))", params: [] },
    { sql: "INSERT INTO _accountless_move_journal VALUES(1,?)", params: [JSON.stringify(initialState())] },
    { sql: "CREATE TABLE _accountless_move_movement_parent(_move_key INTEGER PRIMARY KEY,_original_rowid INTEGER,id INTEGER,label TEXT)", params: [] },
    { sql: "CREATE TABLE _accountless_move_movement_child(_move_key INTEGER PRIMARY KEY,_original_rowid INTEGER,id INTEGER,parent_id INTEGER,note TEXT)", params: [] },
    { sql: "CREATE TABLE movement_permission(singleton INTEGER PRIMARY KEY CHECK(singleton=1),allowed INTEGER NOT NULL CHECK(allowed IN(0,1)))", params: [] },
    { sql: "INSERT INTO movement_permission VALUES(1,0)", params: [] },
    ...["movement_parent", "movement_child"].flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(verb => ({
      sql: `CREATE TRIGGER ${table}_${verb.toLowerCase()} BEFORE ${verb} ON ${table} WHEN (SELECT allowed FROM movement_permission WHERE singleton=1) IS NOT 1 BEGIN SELECT RAISE(ABORT,'SYNTHETIC_MIGRATION_FENCED'); END`, params: [],
    }))),
  ]);
});

describe("bounded movement through the real local D1 batch API", () => {
  it("composes with the actual operational barrier and removes its permit", async () => {
    await batch(["movement_parent", "movement_child"].flatMap(table => ["insert", "update", "delete"].map(verb => ({
      sql: `DROP TRIGGER ${table}_${verb}`, params: [],
    }))));
    const operationId = "synthetic-movement-integration";
    await batch(buildMutationBarrierSetupStatements({ operationId, sourceRevision: "b".repeat(40),
      createdAt: "2026-09-09T00:00:00.000Z", productTables: ["movement_parent", "movement_child"] }));
    const current = await readState();
    const selection = accountlessMovementSelection(current, { maxRows: 2 });
    const selectedRows = (await db().prepare(selection.sql).all<MovementSelectionRow>()).results;
    const prepared = planAccountlessMovementBatch({ current, selectedRows, expectedRevision: 0,
      maxRows: 2, maxBytes: 1024, permission: buildMutationBarrierPermissionStatements(operationId) });
    await batch(prepared.statements);
    expect((await readState()).revision).toBe(1);
    expect(await db().prepare(`SELECT COUNT(*) FROM ${MUTATION_BARRIER_PERMISSION_TABLE}`).first("COUNT(*)")).toBe(0);
    await expect(db().prepare("INSERT INTO movement_child VALUES(7,1,'refused old writer')").run()).rejects.toThrow(MUTATION_BARRIER_ABORT_CODE);
    await expect(batch(prepared.statements)).rejects.toThrow();
    expect(await db().prepare(`SELECT COUNT(*) FROM ${MUTATION_BARRIER_PERMISSION_TABLE}`).first("COUNT(*)")).toBe(0);
  });

  it("moves and restores exact large rowids with parents-first restoration", async () => {
    expect((await plan()).result.rows).toBe(2);
    await batch((await plan()).statements);
    expect((await readState()).tableIndex).toBe(1);
    await batch((await plan()).statements);
    const empty = await db().prepare("SELECT (SELECT COUNT(*) FROM movement_parent)+(SELECT COUNT(*) FROM movement_child) AS n").first<{ n: number }>();
    expect(empty?.n).toBe(0);
    const restore = { ...await readState(), phase: "restore" as const, tableIndex: 0, cursor: 0 };
    await db().prepare("UPDATE _accountless_move_journal SET metadata=? WHERE id=1").bind(JSON.stringify(restore)).run();
    await batch((await plan()).statements);
    await batch((await plan()).statements);
    expect((await db().prepare("SELECT CAST(id AS TEXT) AS id,note FROM movement_child ORDER BY id").all()).results).toEqual([
      { id: "9007199254741007", note: null }, { id: "9007199254741011", note: "synthetic child" },
    ]);
    expect((await readState()).tableIndex).toBe(2);
    expect(await db().prepare("SELECT allowed FROM movement_permission").first("allowed")).toBe(0);
    await expect(db().prepare("DELETE FROM movement_parent").run()).rejects.toThrow("SYNTHETIC_MIGRATION_FENCED");
  });

  it("rolls back data, journal and permission on a late batch failure", async () => {
    const prepared = await plan();
    await expect(batch([...prepared.statements, { sql: "INSERT INTO _accountless_move_assertion VALUES(1,0)", params: [] }])).rejects.toThrow();
    expect(await readState()).toEqual(initialState());
    expect(await db().prepare("SELECT COUNT(*) FROM movement_child").first("COUNT(*)")).toBe(2);
    expect(await db().prepare("SELECT COUNT(*) FROM _accountless_move_movement_child").first("COUNT(*)")).toBe(0);
    expect(await db().prepare("SELECT allowed FROM movement_permission").first("allowed")).toBe(0);
    await batch(prepared.statements);
    await expect(batch(prepared.statements)).rejects.toThrow();
    expect((await readState()).revision).toBe(1);
    expect(await db().prepare("SELECT COUNT(*) FROM _accountless_move_movement_child").first("COUNT(*)")).toBe(2);
  });

  it("refuses stale selection without deleting a changed source row", async () => {
    const prepared = await plan();
    await batch([permission.begin, { sql: "UPDATE movement_child SET note='different synthetic size' WHERE id=9007199254741007", params: [] }, ...permission.end]);
    await expect(batch(prepared.statements)).rejects.toThrow();
    expect((await readState()).revision).toBe(0);
    expect(await db().prepare("SELECT COUNT(*) FROM movement_child").first("COUNT(*)")).toBe(2);
    expect(await db().prepare("SELECT COUNT(*) FROM _accountless_move_movement_child").first("COUNT(*)")).toBe(0);
    expect(await db().prepare("SELECT allowed FROM movement_permission").first("allowed")).toBe(0);
  });
});
