import { createD1InvocationBudget } from "../../src/d1-invocation-budget";

export interface ScaleMeasurements {
  invocations: number;
  statements: number;
  maxInvocationStatements: number;
  rowsRead: number;
  rowsWritten: number;
  resultBytes: number;
  maxResultBytes: number;
  maxDatabaseBytes: number | null;
  elapsedMs: number;
  maxInvocationElapsedMs: number;
  rawRecordQueries: number;
}

export function emptyScaleMeasurements(): ScaleMeasurements {
  return { invocations: 0, statements: 0, maxInvocationStatements: 0,
    rowsRead: 0, rowsWritten: 0, resultBytes: 0, maxResultBytes: 0, maxDatabaseBytes: null,
    elapsedMs: 0, maxInvocationElapsedMs: 0, rawRecordQueries: 0 };
}

/** Local real-D1 measurement adapter. No bindings, values, rows or participant
 * identifiers enter its report. first() uses the identical SQL via all() only
 * to retain D1 metadata; the caller receives the same first row/column. */
export function measuredScaleInvocation(database: D1Database, totals: ScaleMeasurements,
  maxQueries = 900) {
  const meter = createD1InvocationBudget(maxQueries);
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const queries = new WeakMap<D1PreparedStatement, string>();
  const encoder = new TextEncoder();
  const start = Date.now();
  let finished = false;
  const record = (result: D1Result, sql: string) => {
    totals.rowsRead += result.meta.rows_read;
    totals.rowsWritten += result.meta.rows_written;
    const bytes = encoder.encode(JSON.stringify(result.results)).byteLength;
    totals.resultBytes += bytes;
    totals.maxResultBytes = Math.max(totals.maxResultBytes, bytes);
    if (Number.isSafeInteger(result.meta.size_after) && result.meta.size_after > 0) {
      totals.maxDatabaseBytes = Math.max(totals.maxDatabaseBytes ?? 0, result.meta.size_after);
    }
    if (/\btelemetry_v1_records\b/u.test(sql)) totals.rawRecordQueries++;
  };
  const wrapStatement = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrapStatement(target.bind(...values), sql);
        if (property === "first") return async (column?: string) => {
          const result = await target.all<Record<string, unknown>>();
          record(result, sql);
          const row = result.results[0] ?? null;
          if (column === undefined || row === null) return row;
          if (!Object.hasOwn(row, column)) throw new TypeError("scale measurement column absent");
          return row[column];
        };
        if (property === "all" || property === "run") return async () => {
          const result = await target[property](); record(result, sql); return result;
        };
        // Calculator paths use typed all/first/run. Refuse unmeasured methods
        // instead of claiming complete row/byte coverage for them.
        if (property === "raw") return () => { throw new TypeError("scale raw measurement unsupported"); };
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(wrapped, statement); queries.set(wrapped, sql); return wrapped;
  };
  const observed = new Proxy(database, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrapStatement(target.prepare(sql), sql);
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        const source = statements.map(statement => {
          const original = originals.get(statement);
          if (!original) throw new TypeError("scale foreign statement");
          return original;
        });
        const results = await target.batch(source);
        for (let index = 0; index < results.length; index++) record(results[index]!, queries.get(statements[index]!)!);
        return results;
      };
      if (property === "exec" || property === "dump" || property === "withSession") {
        return () => { throw new TypeError("scale unmeasured database operation"); };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: meter.wrap(observed), meter, deadlineMs: start + 40_000,
    finish() {
      if (finished) throw new TypeError("scale invocation already measured");
      finished = true;
      totals.invocations++;
      totals.statements += meter.queriesUsed;
      totals.maxInvocationStatements = Math.max(totals.maxInvocationStatements, meter.queriesUsed);
      const elapsedMs = Date.now() - start;
      totals.elapsedMs += elapsedMs;
      totals.maxInvocationElapsedMs = Math.max(totals.maxInvocationElapsedMs, elapsedMs);
    } };
}
