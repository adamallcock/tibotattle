/** One actual-statement counter shared by every D1 binding in an invocation.
 * Helpers may conservatively reserve a phase allocation separately, but only
 * this adapter measures the queries sent to D1. A batch costs its statement
 * count, not one request. Failed attempts still consume their reservation.
 */
export class D1InvocationBudgetExceededError extends Error {
  readonly code = "D1_INVOCATION_BUDGET_DEFERRED";
  constructor() { super("scheduled database work deferred by invocation budget"); }
}

export interface D1InvocationBudget {
  readonly queriesUsed: number;
  readonly remainingQueries: number;
  /** Headroom for mandatory final operations, such as releasing the lease. */
  reserveQueries: number;
  wrap(database: D1Database): D1Database;
}

export function createD1InvocationBudget(maxQueries = 900): D1InvocationBudget {
  if (!Number.isSafeInteger(maxQueries) || maxQueries < 1 || maxQueries > 1_000) {
    throw new TypeError("invalid invocation query limit");
  }
  let queriesUsed = 0, reserveQueries = 0;
  const wrappedDatabases = new WeakMap<D1Database, D1Database>();
  const spend = (count: number): void => {
    if (!Number.isSafeInteger(count) || count < 0
        || count > maxQueries - queriesUsed - reserveQueries) {
      throw new D1InvocationBudgetExceededError();
    }
    queriesUsed += count;
  };

  return {
    get queriesUsed() { return queriesUsed; },
    get remainingQueries() { return maxQueries - queriesUsed - reserveQueries; },
    get reserveQueries() { return reserveQueries; },
    set reserveQueries(value: number) {
      if (!Number.isSafeInteger(value) || value < 0 || value > maxQueries) {
        throw new TypeError("invalid invocation query reserve");
      }
      reserveQueries = value;
    },
    wrap(database: D1Database): D1Database {
      const existing = wrappedDatabases.get(database);
      if (existing) return existing;
      const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
      const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => {
        const wrapped = new Proxy(statement, {
          get(target, property) {
            if (property === "bind") return (...values: unknown[]) => wrapStatement(target.bind(...values));
            if (["first", "all", "run", "raw"].includes(String(property))) {
              return (...args: unknown[]) => {
                spend(1);
                const method: unknown = Reflect.get(target, property);
                if (typeof method !== "function") throw new TypeError("database method unavailable");
                return Reflect.apply(method, target, args);
              };
            }
            const value: unknown = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        originals.set(wrapped, statement);
        return wrapped;
      };
      const unwrapBatch = (statements: D1PreparedStatement[]): D1PreparedStatement[] => {
        const unwrapped = statements.map(statement => {
          const original = originals.get(statement);
          if (!original) throw new TypeError("unmetered or foreign database statement");
          return original;
        });
        spend(unwrapped.length);
        return unwrapped;
      };
      const wrapSession = (session: D1DatabaseSession): D1DatabaseSession => new Proxy(session, {
        get(target, property) {
          if (property === "prepare") return (query: string) => wrapStatement(target.prepare(query));
          if (property === "batch") return (statements: D1PreparedStatement[]) => target.batch(unwrapBatch(statements));
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const wrapped = new Proxy(database, {
        get(target, property) {
          if (property === "prepare") return (query: string) => wrapStatement(target.prepare(query));
          if (property === "batch") return (statements: D1PreparedStatement[]) => target.batch(unwrapBatch(statements));
          if (property === "withSession") return (constraint?: D1SessionBookmark | D1SessionConstraint) =>
            wrapSession(target.withSession(constraint));
          // Scheduled work uses prepared statements. Parsing arbitrary SQL to
          // guess how many statements exec() contains would weaken this bound.
          if (property === "exec" || property === "dump") return () => {
            throw new TypeError("unbounded database operation unavailable in scheduled work");
          };
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      wrappedDatabases.set(database, wrapped);
      wrappedDatabases.set(wrapped, wrapped);
      return wrapped;
    },
  };
}
