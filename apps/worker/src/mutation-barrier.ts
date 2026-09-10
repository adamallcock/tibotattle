/**
 * The migration mutation barrier is an operational fence for the temporary
 * accountless schema move. It is intentionally not a general maintenance
 * framework and it makes no claim that requests admitted by an older Worker
 * version have completed their reads. The deployment gate stops new dynamic
 * traffic; these D1 triggers stop writes that reach the primary database.
 */

export const MIGRATION_MUTATION_BARRIER_ENABLED = true;
export const MUTATION_BARRIER_ERROR_CODE = "MUTATION_BARRIER_ACTIVE";
export const MUTATION_BARRIER_ABORT_CODE =
  "ACCOUNTLESS_MIGRATION_MUTATION_BARRIER";

export const MUTATION_BARRIER_STATE_TABLE =
  "_accountless_migration_barrier_v1";
export const MUTATION_BARRIER_PERMISSION_TABLE =
  "_accountless_migration_barrier_permission_v1";
export const MUTATION_BARRIER_ASSERTION_TABLE =
  "_accountless_migration_barrier_assertion_v1";

const OPERATION_ID_PATTERN = /^[a-z][a-z0-9-]{7,127}$/u;
const SOURCE_REVISION_PATTERN = /^[a-f0-9]{7,64}$/u;
const SQLITE_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,127}$/u;
const SQL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const D1_MIGRATION_LEDGER_TABLE = "d1_migrations";
const ACCOUNTLESS_MOVEMENT_JOURNAL_TABLE = "_accountless_move_journal";
const ACCOUNTLESS_MOVEMENT_ASSERTION_TABLE = "_accountless_move_assertion";
const ACCOUNTLESS_MOVEMENT_STAGING_PREFIX = "_accountless_move_";

export interface MutationBarrierStatement {
  readonly sql: string;
  readonly params: readonly string[];
}

export interface MutationBarrierPermissionStatements {
  readonly begin: MutationBarrierStatement;
  /** Both statements are required, in order, at the tail of one D1.batch. */
  readonly end: readonly [MutationBarrierStatement, MutationBarrierStatement];
}

export interface MutationBarrierSetupOptions {
  readonly operationId: string;
  readonly sourceRevision: string;
  readonly createdAt: string;
  readonly productTables: readonly string[];
}

function quoteSqlName(identifier: string): string {
  if (!SQL_NAME_PATTERN.test(identifier)) {
    throw new TypeError("mutation barrier identifier is invalid");
  }
  return `"${identifier}"`;
}

function quoteProductTable(identifier: string): string {
  if (!SQLITE_IDENTIFIER_PATTERN.test(identifier)) {
    throw new TypeError("mutation barrier product table is invalid");
  }
  return quoteSqlName(identifier);
}

function assertOperationId(operationId: string): void {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new TypeError("mutation barrier operation id is invalid");
  }
}

function assertSourceRevision(sourceRevision: string): void {
  if (!SOURCE_REVISION_PATTERN.test(sourceRevision)) {
    throw new TypeError("mutation barrier source revision is invalid");
  }
}

function assertCreatedAt(createdAt: string): void {
  const parsed = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
  if (typeof createdAt !== "string" || createdAt.length < 20
      || createdAt.length > 40 || !Number.isFinite(parsed)
      || new Date(parsed).toISOString() !== createdAt) {
    throw new TypeError("mutation barrier created time is invalid");
  }
}

function isOperationOwnedTable(name: string): boolean {
  return name === MUTATION_BARRIER_STATE_TABLE
    || name === MUTATION_BARRIER_PERMISSION_TABLE
    || name === MUTATION_BARRIER_ASSERTION_TABLE
    || name === ACCOUNTLESS_MOVEMENT_JOURNAL_TABLE
    || name === ACCOUNTLESS_MOVEMENT_ASSERTION_TABLE;
}

function isProviderSystemTable(name: string): boolean {
  return name.startsWith("sqlite_") || name.startsWith("_cf_");
}

export function isMutationBarrierProductTable(name: string): boolean {
  return SQLITE_IDENTIFIER_PATTERN.test(name)
    && !isProviderSystemTable(name)
    && !isOperationOwnedTable(name);
}

/** Exact control/staging tables created by the reviewed local movement plan. */
export function mutationBarrierOwnedMovementTables(
  movedProductTables: readonly string[],
): readonly string[] {
  if (movedProductTables.includes(D1_MIGRATION_LEDGER_TABLE)) {
    throw new TypeError("mutation barrier product table set is invalid");
  }
  const tables = normalizedProductTables(movedProductTables);
  return Object.freeze([
    ACCOUNTLESS_MOVEMENT_JOURNAL_TABLE,
    ACCOUNTLESS_MOVEMENT_ASSERTION_TABLE,
    ...tables.map((table) => `${ACCOUNTLESS_MOVEMENT_STAGING_PREFIX}${table}`),
  ]);
}

function normalizedProductTables(tables: readonly string[]): readonly string[] {
  if (!Array.isArray(tables) || tables.length === 0) {
    throw new TypeError("mutation barrier product table set is invalid");
  }
  const normalized = [...new Set(tables)].sort();
  if (normalized.length !== tables.length
      || normalized.some((table) => !isMutationBarrierProductTable(table))) {
    throw new TypeError("mutation barrier product table set is invalid");
  }
  return Object.freeze(normalized);
}

function triggerName(verb: "insert" | "update" | "delete", table: string): string {
  return `_accountless_migration_barrier_v1_${verb}_${table}`;
}

function triggerStatement(
  verb: "INSERT" | "UPDATE" | "DELETE",
  table: string,
): MutationBarrierStatement {
  const trigger = triggerName(verb.toLowerCase() as "insert" | "update" | "delete", table);
  return {
    sql: `CREATE TRIGGER ${quoteSqlName(trigger)} BEFORE ${verb} ON ${quoteProductTable(table)}
WHEN NOT EXISTS(
  SELECT 1
    FROM ${quoteSqlName(MUTATION_BARRIER_PERMISSION_TABLE)} AS permission
    JOIN ${quoteSqlName(MUTATION_BARRIER_STATE_TABLE)} AS barrier
      ON barrier.singleton = 1
     AND permission.singleton = 1
     AND permission.operation_id = barrier.operation_id
   WHERE barrier.state = 'fenced'
)
BEGIN
  SELECT RAISE(ABORT, '${MUTATION_BARRIER_ABORT_CODE}');
END`,
    params: [],
  };
}

/**
 * Reads only table names from a D1 sqlite_master query. The movement operator
 * must read this immediately before setup and retain the exact returned list
 * in its private operation evidence; this module never opens a remote D1.
 */
export function mutationBarrierProductTablesFromSchema(
  rows: readonly { readonly name?: unknown }[],
  ownedTables: readonly string[] = [],
): readonly string[] {
  if (!Array.isArray(rows)) {
    throw new TypeError("mutation barrier schema rows are invalid");
  }
  if (!Array.isArray(ownedTables)
      || ownedTables.some((table) => typeof table !== "string"
        || !SQL_NAME_PATTERN.test(table))) {
    throw new TypeError("mutation barrier owned table set is invalid");
  }
  if (new Set(ownedTables).size !== ownedTables.length) {
    throw new TypeError("mutation barrier owned table set is invalid");
  }
  const rowNames = new Set(rows.map((row) => row?.name));
  if (ownedTables.some((table) => table !== ACCOUNTLESS_MOVEMENT_JOURNAL_TABLE
      && table !== ACCOUNTLESS_MOVEMENT_ASSERTION_TABLE
      && (!table.startsWith(ACCOUNTLESS_MOVEMENT_STAGING_PREFIX)
        || !SQLITE_IDENTIFIER_PATTERN.test(
          table.slice(ACCOUNTLESS_MOVEMENT_STAGING_PREFIX.length),
        )
        || !rowNames.has(table.slice(ACCOUNTLESS_MOVEMENT_STAGING_PREFIX.length))))) {
    throw new TypeError("mutation barrier owned table set is invalid");
  }
  const owned = new Set([
    ...ownedTables,
    MUTATION_BARRIER_STATE_TABLE,
    MUTATION_BARRIER_PERMISSION_TABLE,
    MUTATION_BARRIER_ASSERTION_TABLE,
    ACCOUNTLESS_MOVEMENT_JOURNAL_TABLE,
    ACCOUNTLESS_MOVEMENT_ASSERTION_TABLE,
  ]);
  const tables: string[] = [];
  for (const row of rows) {
    const table = row?.name;
    if (typeof table !== "string") {
      throw new TypeError("mutation barrier schema rows are invalid");
    }
    if (isProviderSystemTable(table) || owned.has(table)) continue;
    if (!isMutationBarrierProductTable(table)) {
      throw new TypeError("mutation barrier schema rows are invalid");
    }
    tables.push(table);
  }
  return normalizedProductTables(tables);
}

export const MUTATION_BARRIER_PRODUCT_TABLES_QUERY = `
SELECT name
 FROM sqlite_master
 WHERE type = 'table'
   AND name NOT GLOB 'sqlite_*'
   AND name NOT GLOB '_cf_*'
 ORDER BY name
`;

export function buildMutationBarrierPermissionStatements(
  operationId: string,
): MutationBarrierPermissionStatements {
  assertOperationId(operationId);
  const end = [
    Object.freeze({
      sql: `DELETE FROM ${quoteSqlName(MUTATION_BARRIER_PERMISSION_TABLE)}
 WHERE singleton = 1 AND operation_id = ?`,
      params: Object.freeze([operationId]),
    }),
    Object.freeze({
      sql: `INSERT OR REPLACE INTO ${quoteSqlName(MUTATION_BARRIER_ASSERTION_TABLE)} (singleton, ok)
VALUES (1, changes())`,
      params: Object.freeze([]),
    }),
  ] as const satisfies readonly [MutationBarrierStatement, MutationBarrierStatement];
  return Object.freeze({
    begin: Object.freeze({
      sql: `INSERT INTO ${quoteSqlName(MUTATION_BARRIER_PERMISSION_TABLE)} (singleton, operation_id)
VALUES (1, COALESCE((
  SELECT operation_id
    FROM ${quoteSqlName(MUTATION_BARRIER_STATE_TABLE)}
   WHERE singleton = 1 AND state = 'fenced' AND operation_id = ?
), ''))`,
      params: Object.freeze([operationId]),
    }),
    end: Object.freeze(end),
  });
}

/** Recreate all mutation triggers after a canonical table rebuild such as 0058. */
export function buildMutationBarrierReinstallStatements(
  productTables: readonly string[],
): readonly MutationBarrierStatement[] {
  const tables = normalizedProductTables(productTables);
  const statements: MutationBarrierStatement[] = [];
  for (const table of tables) {
    for (const verb of ["insert", "update", "delete"] as const) {
      statements.push({
        sql: `DROP TRIGGER IF EXISTS ${quoteSqlName(triggerName(verb, table))}`,
        params: [],
      });
    }
    statements.push(
      triggerStatement("INSERT", table),
      triggerStatement("UPDATE", table),
      triggerStatement("DELETE", table),
    );
  }
  return Object.freeze(statements.map((statement) => Object.freeze(statement)));
}

/**
 * Emits a one-time source-57-compatible bootstrap plan. It deliberately uses
 * CREATE TABLE (not IF NOT EXISTS): a pre-existing operation object is a
 * collision, never an implicit adoption of unknown migration authority.
 */
export function buildMutationBarrierSetupStatements(
  options: MutationBarrierSetupOptions,
): readonly MutationBarrierStatement[] {
  assertOperationId(options.operationId);
  assertSourceRevision(options.sourceRevision);
  assertCreatedAt(options.createdAt);
  const tables = normalizedProductTables(options.productTables);
  const statements: MutationBarrierStatement[] = [
    {
      sql: `CREATE TABLE ${quoteSqlName(MUTATION_BARRIER_STATE_TABLE)} (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  operation_id TEXT NOT NULL CHECK(length(operation_id) BETWEEN 8 AND 128),
  source_revision TEXT NOT NULL CHECK(length(source_revision) BETWEEN 7 AND 64),
  source_migration_prefix INTEGER NOT NULL CHECK(source_migration_prefix = 57),
  state TEXT NOT NULL CHECK(state = 'fenced'),
  created_at TEXT NOT NULL
) STRICT`,
      params: [],
    },
    {
      sql: `CREATE TABLE ${quoteSqlName(MUTATION_BARRIER_PERMISSION_TABLE)} (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  operation_id TEXT NOT NULL CHECK(length(operation_id) BETWEEN 8 AND 128)
) STRICT`,
      params: [],
    },
    {
      sql: `CREATE TABLE ${quoteSqlName(MUTATION_BARRIER_ASSERTION_TABLE)} (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  ok INTEGER NOT NULL CHECK(ok = 1)
) STRICT`,
      params: [],
    },
    {
      sql: `INSERT INTO ${quoteSqlName(MUTATION_BARRIER_STATE_TABLE)}
  (singleton, operation_id, source_revision, source_migration_prefix, state, created_at)
VALUES (1, ?, ?, 57, 'fenced', ?)`,
      params: [options.operationId, options.sourceRevision, options.createdAt],
    },
    ...buildMutationBarrierReinstallStatements(tables),
  ];
  return Object.freeze(statements.map((statement) => Object.freeze(statement)));
}

/**
 * This pure predicate keeps the release candidate’s normal path constant and
 * allows the separately reviewed migration-only source snapshot to be tested
 * without adding an environment-controlled production switch.
 */
export function mutationBarrierBlocksDynamicRequest(
  routeId: string,
  adminSurface: boolean,
  enabled = MIGRATION_MUTATION_BARRIER_ENABLED,
): boolean {
  return enabled && (routeId !== "asset" || adminSurface);
}

export function mutationBarrierSkipsScheduledMaintenance(
  enabled = MIGRATION_MUTATION_BARRIER_ENABLED,
): boolean {
  return enabled;
}
