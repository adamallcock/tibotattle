/** One actual-statement counter shared by every D1 binding in an invocation.
 * Helpers may conservatively reserve a phase allocation separately, but only
 * this adapter measures the queries sent to D1. A batch costs its statement
 * count, not one request. Failed attempts still consume their reservation.
 */
import {createD1SchemaObjectHints,type D1SchemaObject,type D1SchemaObjectHints} from './d1-schema-object-hints';

/** Operation-local lookup parameters. Every use still reads the exact current
 * schema; this attachment never carries an availability or authority result. */
const D1_SCHEMA_HINTS_ATTACHMENT=Symbol('d1-schema-hints-attachment');
interface SchemaHintsRegistry {
  forObjects(required:readonly D1SchemaObject[],observedDatabase?:D1Database):D1SchemaObjectHints|undefined;
  withBudget(database:D1Database):SchemaHintsRegistry;
}
function createSchemaHintsRegistry(database:D1Database,parent?:SchemaHintsRegistry,
  retainedKeys=new Set<string>()):SchemaHintsRegistry {
  const entries=new Map<string,D1SchemaObjectHints>();
  const facadeEntries=new WeakMap<D1Database,Map<string,D1SchemaObjectHints>>();
  const observed=(key:string,holder:D1SchemaObjectHints,db:D1Database):D1SchemaObjectHints=>{
    if(db===database)return holder;
    let bound=facadeEntries.get(db);
    if(!bound){bound=new Map();facadeEntries.set(db,bound);}
    const existing=bound.get(key);if(existing)return existing;
    // Weak facade keys do not retain an observer after its operation. Each
    // map uses only the same at-most16 admitted lists and shares their hints.
    const derived=holder.withBudget(()=>db);bound.set(key,derived);return derived;
  };
  const registry:SchemaHintsRegistry={
    forObjects(required,observedDatabase=database){
      if(!Array.isArray(required)||required.length<1||required.length>512)
        throw new TypeError('D1_SCHEMA_OBJECT_HINT_INPUT');
      const key=JSON.stringify(required);
      if(new TextEncoder().encode(key).byteLength>64*1024)throw new TypeError('D1_SCHEMA_OBJECT_HINT_INPUT');
      const old=entries.get(key);
      if(old)return observed(key,old,observedDatabase);
      // All nested meters for this binding share one retained-list bound.
      // Additional lists take their ordinary fresh path without retained hints.
      if(!retainedKeys.has(key)&&retainedKeys.size>=16)return;
      const original=parent?.forObjects(required);
      if(parent&&!original)return;
      const next=original?original.withBudget(()=>database):createD1SchemaObjectHints(database,required);
      retainedKeys.add(key);entries.set(key,next);
      return observed(key,next,observedDatabase);
    },
    withBudget(derivedDatabase){return createSchemaHintsRegistry(derivedDatabase,registry,retainedKeys);},
  };
  return registry;
}
/** Only a metered operation exposes reusable parameters; ordinary DB callers
 * keep the original one fresh inventory per call. */
export function d1SchemaObjectHintsFor(database:D1Database,required:readonly D1SchemaObject[]):D1SchemaObjectHints|undefined {
  const registry=Reflect.get(database,D1_SCHEMA_HINTS_ATTACHMENT) as SchemaHintsRegistry|undefined;
  // A transparent DB facade can forward this attachment. Bind the holder to
  // the actual observed facade so its SQL still traverses every observer and
  // meter; never substitute the attachment's earlier handle.
  return registry?.forObjects(required,database);
}
export async function readD1SchemaObjectsAvailable(database:D1Database,required:readonly D1SchemaObject[]):Promise<boolean> {
  return (d1SchemaObjectHintsFor(database,required)??createD1SchemaObjectHints(database,required)).check(database,required);
}

export class D1InvocationBudgetExceededError extends Error {
  readonly code = "D1_INVOCATION_BUDGET_DEFERRED";
  constructor() { super("scheduled database work deferred by invocation budget"); }
}

/** Request-local adapters may carry another binding. Each inner phase meter
 * must wrap that binding too; attachments cannot bypass actual statement costs. */
export const D1_BUDGET_ATTACHMENT = Symbol('d1-budget-attachment');
export interface D1BudgetAttachment {
  withBudget(wrap: (database: D1Database) => D1Database): D1BudgetAttachment;
}

/** Verified binding-local meter lineage. Transparent observers forward this
 * private attachment; callers cannot supply an unmetered cleanup binding. */
const FINAL_QUERY_METERS=Symbol('d1-final-query-meters');
interface FinalQueryMeter { readonly remaining:number; hold():()=>void; }
const finalQueryMeters=new WeakSet<FinalQueryMeter>();
export interface D1FinalQueryReservation { unreserve():void; }
/** Hold one actual statement on every enclosing meter of both bindings. The
 * same meter is charged once even when it wraps both bindings or appears at
 * several transparent facade layers. Unknown bindings cannot claim a reserve. */
export function reserveD1FinalQuery(databases:readonly D1Database[]):D1FinalQueryReservation|undefined {
  if(!Array.isArray(databases)||databases.length<1||databases.length>8)
    throw new TypeError('invalid final-query bindings');
  const meters=new Set<FinalQueryMeter>();
  for(const database of databases) {
    const lineage:unknown=Reflect.get(database,FINAL_QUERY_METERS);
    if(!Array.isArray(lineage)||lineage.length<1||lineage.length>64
      ||lineage.some(value=>!value||typeof value!=='object'||!finalQueryMeters.has(value)))return;
    for(const meter of lineage)meters.add(meter as FinalQueryMeter);
  }
  if([...meters].some(meter=>meter.remaining<1))throw new D1InvocationBudgetExceededError();
  const release=[...meters].map(meter=>meter.hold());
  let held=true;
  return Object.freeze({unreserve(){if(!held)return;held=false;for(const done of release)done();}});
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
  let queriesUsed = 0, reserveQueries = 0, finalQueries = 0;
  const finalMeter:FinalQueryMeter=Object.freeze({
    get remaining(){return maxQueries-queriesUsed-reserveQueries-finalQueries;},
    hold(){
      if(this.remaining<1)throw new D1InvocationBudgetExceededError();
      finalQueries++;let held=true;
      return ()=>{if(held){held=false;finalQueries--;}};
    },
  });
  finalQueryMeters.add(finalMeter);
  const wrappedDatabases = new WeakMap<D1Database, D1Database>();
  const spend = (count: number): void => {
    if (!Number.isSafeInteger(count) || count < 0
        || count > maxQueries - queriesUsed - reserveQueries - finalQueries) {
      throw new D1InvocationBudgetExceededError();
    }
    queriesUsed += count;
  };

  return {
    get queriesUsed() { return queriesUsed; },
    get remainingQueries() { return maxQueries - queriesUsed - reserveQueries - finalQueries; },
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
      const wrapAttached = (db: D1Database) => this.wrap(db);
      let attachment: D1BudgetAttachment | undefined;
      let schemaHints:SchemaHintsRegistry|undefined;
      const wrapped = new Proxy(database, {
        get(target, property) {
          if (property === "prepare") return (query: string) => wrapStatement(target.prepare(query));
          if (property === "batch") return (statements: D1PreparedStatement[]) => target.batch(unwrapBatch(statements));
          if(property===FINAL_QUERY_METERS) {
            const inherited:unknown=Reflect.get(target,property);
            if(inherited!==undefined&&(!Array.isArray(inherited)||inherited.length>63
              ||inherited.some(value=>!value||typeof value!=='object'||!finalQueryMeters.has(value))))
              throw new TypeError('invalid final-query meter lineage');
            return Object.freeze([...new Set([finalMeter,...(inherited as FinalQueryMeter[]|undefined??[])])]);
          }
          if (property === D1_SCHEMA_HINTS_ATTACHMENT) {
            const inherited=Reflect.get(target,property) as SchemaHintsRegistry|undefined;
            return schemaHints??=inherited?inherited.withBudget(wrapped):createSchemaHintsRegistry(wrapped);
          }
          if (property === D1_BUDGET_ATTACHMENT) {
            const value: unknown = Reflect.get(target, property);
            if (!value || typeof value !== 'object' || !('withBudget' in value)
              || typeof value.withBudget !== 'function') return undefined;
            return attachment ??= (value as D1BudgetAttachment).withBudget(wrapAttached);
          }
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
