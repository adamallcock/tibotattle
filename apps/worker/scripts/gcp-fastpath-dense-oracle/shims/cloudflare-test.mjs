// Node stand-in for vitest-pool-workers' `cloudflare:test`, for the dense
// production-code oracle bundle only. applyD1Migrations mirrors
// @cloudflare/vitest-pool-workers 0.18.8 dist/worker/lib/cloudflare/test-internal.mjs
// (lines 23-44): one d1_migrations table, then one atomic unit per migration
// holding its split queries and the row that records it, skipping applied names.
//
// One deliberate difference in mechanism, not in effect: wrangler's
// unstable_splitSqlQuery leaves some chunks holding several statements (for
// example the tail of migrations/0012_revisioned_aggregate_rebuild.sql), and
// miniflare's D1 executes every statement of such a chunk. node:sqlite prepares
// only the first statement of a string, so a prepared batch would silently drop
// the rest. Each chunk therefore runs through exec() inside one explicit
// BEGIN IMMEDIATE ... COMMIT per migration, exactly the atomicity of the batch.
export async function applyD1Migrations(db, migrations, migrationsTableName = "d1_migrations") {
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
    throw new TypeError("Failed to execute 'applyD1Migrations': parameter 1 is not of type 'D1Database'.");
  }
  if (!Array.isArray(migrations) || !migrations.every((migration) => migration && typeof migration.name === "string"
    && Array.isArray(migration.queries) && migration.queries.every((query) => typeof query === "string"))) {
    throw new TypeError("Failed to execute 'applyD1Migrations': parameter 2 is not of type 'D1Migration[]'.");
  }
  const escapeId = (id) => `"${id.replace(/"/g, "\"\"")}"`;
  const escapedTableName = escapeId(migrationsTableName);
  const schema = `CREATE TABLE IF NOT EXISTS ${escapedTableName} (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
	);`;
  await db.prepare(schema).run();
  const applied = (await db.prepare(`SELECT name FROM ${escapedTableName};`).all()).results.map(({ name }) => name);
  const insertMigrationStmt = db.prepare(`INSERT INTO ${escapedTableName} (name) VALUES (?);`);
  for (const migration of migrations) {
    if (applied.includes(migration.name)) continue;
    await db.exec("BEGIN IMMEDIATE");
    try {
      for (const query of migration.queries) await db.exec(query);
      await insertMigrationStmt.bind(migration.name).run();
      await db.exec("COMMIT");
    } catch (error) {
      try { await db.exec("ROLLBACK"); } catch { /* the original failure is reported */ }
      throw error;
    }
  }
}
export const env = Object.freeze({});
export async function reset() {
  throw new Error("cloudflare:test reset() is not available in the dense oracle");
}
