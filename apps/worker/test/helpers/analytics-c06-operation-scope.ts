/** Test-only source-query attribution. A facade binds one immutable operation
 * scope to each prepared statement; it leaves the database, SQL, binds, budget
 * wrappers and result untouched. Absence of the census marker is a cold-pass
 * no-op. The census and independent profile still count every statement. */
export const C06_DATABASE_SCOPE=Symbol.for('analytics-c06-database-scope-v1');
export const C06_STATEMENT_SCOPE=Symbol.for('analytics-c06-statement-scope-v1');

export const C06_OPERATION_SCOPES=Object.freeze([
  'direct_cohort','direct_daily','direct_api','direct_scalar','direct_model','native_block',
  'direct_cache','direct_publication','fixture','unclassified',
  'scheduler_shared','scheduler_prelude','scheduler_coverage','scheduler_effects','scheduler_cache_publication_admission',
  'scheduler_rolling_admission','scheduler_canonical','scheduler_features','scheduler_cache',
  'scheduler_activity','scheduler_publication','scheduler_fits','scheduler_cleanup',
  'scheduler_graph_owner','scheduler_graph_fits','scheduler_graph_model','scheduler_rolling_window',
  'candidate_model_block',
] as const);
export type C06OperationScope=(typeof C06_OPERATION_SCOPES)[number];
export type C06ScopeConsumer='cohort'|'daily'|'api'|'scalar'|'model'|'block'|'cache'|'publication'|'fixture'|'unclassified';
/** Only exact producer boundaries receive a consumer. Shared preparation,
 * rolling admission, mixed fits and unknown stage work stay unclassified. */
export function c06ScopeConsumer(scope:C06OperationScope):C06ScopeConsumer {
  if(!isC06OperationScope(scope))throw new Error('C06_OPERATION_SCOPE_INVALID');
  switch(scope){
    case 'direct_cohort':return 'cohort';
    case 'direct_daily':return 'daily';
    case 'direct_api':return 'api';
    case 'direct_scalar':case 'scheduler_graph_fits':return 'scalar';
    case 'direct_model':case 'scheduler_graph_model':return 'model';
    case 'native_block':case 'candidate_model_block':return 'block';
    case 'direct_cache':case 'scheduler_cache':return 'cache';
    case 'direct_publication':case 'scheduler_publication':return 'publication';
    case 'fixture':return 'fixture';
    default:return 'unclassified';
  }
}

export function isC06OperationScope(value:unknown):value is C06OperationScope {
  return typeof value==='string'&&(C06_OPERATION_SCOPES as readonly string[]).includes(value);
}

type ScopedStatement=D1PreparedStatement&{
  [C06_STATEMENT_SCOPE]?: (scope?:C06OperationScope)=>C06OperationScope|undefined;
};
const ownedFacades=new WeakMap<object,{base:D1Database|D1DatabaseSession;onFailure?:()=>void}>();

/** Operates on the *passed* handle. When it is already a nested metered or
 * observing facade, all those layers remain in the dispatch path. */
export function c06ScopeSource<T extends D1Database|D1DatabaseSession>(database:T,scope:C06OperationScope,
  options?:{onFailure?:()=>void}):T {
  const previous=ownedFacades.get(database),onFailure=options?.onFailure??previous?.onFailure;
  const notifyFailure=()=>{try{onFailure?.();}catch{/* Attribution callbacks cannot replace the original refusal. */}};
  const fail=(code:string):never=>{notifyFailure();throw new Error(code);};
  if(onFailure!==undefined&&typeof onFailure!=='function')throw new Error('C06_OPERATION_FAILURE_CALLBACK');
  if(!isC06OperationScope(scope))return fail('C06_OPERATION_SCOPE_INVALID');
  // Only our own facade may be replaced. Unknown wrappers, including a later
  // budget wrapper, must remain in the path; a conflicting inner scope refuses.
  const base=previous?.base??database;
  if(Reflect.get(base,C06_DATABASE_SCOPE)!==true)return database;
  const wrap=(handle:D1Database|D1DatabaseSession):D1Database|D1DatabaseSession=>{
    const facade=new Proxy(handle,{
    get(target,key){
      if(key==='prepare')return(sql:string)=>{
        const statement=target.prepare(sql) as ScopedStatement;
        try{
          const tag=Reflect.get(statement,C06_STATEMENT_SCOPE) as ScopedStatement[typeof C06_STATEMENT_SCOPE];
          if(typeof tag!=='function')throw new Error('C06_OPERATION_STATEMENT_SCOPE_MISSING');
          if(tag(scope)!==scope)throw new Error('C06_OPERATION_STATEMENT_SCOPE_MISMATCH');
        }catch(error){notifyFailure();throw error;}
        return statement;
      };
      if(key==='withSession')return(constraint?:D1SessionBookmark|D1SessionConstraint)=>{
        if(typeof (target as D1Database).withSession!=='function')return fail('C06_OPERATION_SESSION_UNAVAILABLE');
        return wrap((target as D1Database).withSession(constraint));
      };
      const value:unknown=Reflect.get(target,key);
      return typeof value==='function'?value.bind(target):value;
    },
    });
    ownedFacades.set(facade,{base:handle,...(onFailure?{onFailure}:{})});
    return facade;
  };
  return wrap(base) as T;
}
