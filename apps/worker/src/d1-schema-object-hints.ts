/** Request-local rowid hints for exact SQLite schema objects. A hint is never
 * an availability result: every check reads the current sqlite_schema, and an
 * unexpected row pays a full typed inventory before returning. */
export type D1SchemaObject = readonly [type:'table'|'index'|'trigger'|'view',name:string];
type Hint=readonly [rowid:number,type:D1SchemaObject[0],name:string];
type Row={rowid:unknown;type:unknown;name:unknown};

export interface D1AtomicSchemaGuard {
  /** Embed in the same statement as runtime generation/method predicates. */
  readonly predicateSql:string;
  readonly json:string;
  readonly expectedCount:number;
  readonly mode:'rowid_triples'|'full_pairs';
}
export interface D1SchemaObjectHints {
  /** The caller must pass the same DB handle and exact required list. */
  check(db:D1Database,required:readonly D1SchemaObject[]):Promise<boolean>;
  /** Construct SQL only; the resulting predicate must execute atomically with
   * the caller's runtime fence. No JS result can replace that fence. */
  atomicGuard(db:D1Database,required:readonly D1SchemaObject[],jsonParameter:number,
    countParameter:number):D1AtomicSchemaGuard;
  /** A trusted invocation-budget adapter derives a new exact handle while
   * sharing rowid parameters only within this operation. */
  withBudget(wrap:(db:D1Database)=>D1Database):D1SchemaObjectHints;
}

const FULL=`SELECT rowid,type,name FROM sqlite_schema s WHERE (s.type,s.name) IN(
 SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?))`;
const BY_ROWID=`SELECT rowid,type,name FROM sqlite_schema WHERE rowid IN(
 SELECT CAST(value AS INTEGER) FROM json_each(?))`;
const failInput=():never=>{throw new TypeError('D1_SCHEMA_OBJECT_HINT_INPUT');};
const failScope=():never=>{throw new TypeError('D1_SCHEMA_OBJECT_HINT_SCOPE_MISMATCH');};
const stable=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;

function snapshot(required:readonly D1SchemaObject[]):readonly D1SchemaObject[] {
  if(!Array.isArray(required)||required.length<1||required.length>512)failInput();
  const result:D1SchemaObject[]=[],seen=new Set<string>();
  for(const item of required){
    if(!Array.isArray(item)||item.length!==2||!['table','index','trigger','view'].includes(item[0])
      ||typeof item[1]!=='string'||item[1].length<1||item[1].length>128||item[1].includes('\0'))failInput();
    const pair=[item[0],item[1]] as D1SchemaObject,key=JSON.stringify(pair);
    if(seen.has(key))failInput();
    seen.add(key);result.push(Object.freeze(pair));
  }
  if(new TextEncoder().encode(JSON.stringify(result)).byteLength>64*1024)failInput();
  return Object.freeze(result);
}

function exact(rows:readonly Row[],required:readonly D1SchemaObject[]):Hint[]|undefined {
  if(!Array.isArray(rows)||rows.length!==required.length)return;
  const byPair=new Map<string,Hint>(),rowids=new Set<number>();
  for(const row of rows){
    if(!row||!stable(row.rowid)||typeof row.type!=='string'||typeof row.name!=='string'
      ||rowids.has(row.rowid))return;
    rowids.add(row.rowid);
    const key=JSON.stringify([row.type,row.name]);
    if(byPair.has(key))return;
    byPair.set(key,[row.rowid,row.type as Hint[1],row.name]);
  }
  const hints:Hint[]=[];
  for(const pair of required){
    const found=byPair.get(JSON.stringify(pair));if(!found)return;
    hints.push(found);
  }
  return hints;
}

export function createD1SchemaObjectHints(db:D1Database,required:readonly D1SchemaObject[]):D1SchemaObjectHints {
  if(!db||typeof db.prepare!=='function')failInput();
  const frozen=snapshot(required),key=JSON.stringify(frozen);
  let hints:readonly Hint[]|undefined;
  const bind=(boundDb:D1Database):D1SchemaObjectHints=>{
   if(!boundDb||typeof boundDb.prepare!=='function')failInput();
   const scope=(observedDb:D1Database,observedRequired:readonly D1SchemaObject[])=>{
    if(observedDb!==boundDb||JSON.stringify(snapshot(observedRequired))!==key)failScope();
   };
   return {
    async check(observedDb,observedRequired){
      scope(observedDb,observedRequired);
      if(hints){
        const rows=(await boundDb.prepare(BY_ROWID).bind(JSON.stringify(hints.map(hint=>hint[0])))
          .all<Row>()).results;
        const fresh=exact(rows,frozen);
        if(fresh&&JSON.stringify(fresh)===JSON.stringify(hints))return true;
        hints=undefined;
      }
      const rows=(await boundDb.prepare(FULL).bind(key).all<Row>()).results;
      hints=exact(rows,frozen);
      return hints!==undefined;
    },
    atomicGuard(observedDb,observedRequired,jsonParameter,countParameter){
      scope(observedDb,observedRequired);
      if(!Number.isSafeInteger(jsonParameter)||jsonParameter<1||jsonParameter>99
        ||!Number.isSafeInteger(countParameter)||countParameter<1||countParameter>99
        ||jsonParameter===countParameter)failInput();
      // A replaced object can acquire a new rowid between calls. The full
      // typed branch retains the original fence result in that case, inside
      // this same SQL statement rather than after a JS round trip.
      const predicateSql=hints
        ?`(CASE WHEN (SELECT count(*) FROM json_each(json_extract(?${jsonParameter},'$.hints')) hint
          CROSS JOIN sqlite_schema schema_object
          WHERE schema_object.rowid=CAST(json_extract(hint.value,'$[0]') AS INTEGER)
            AND schema_object.type=json_extract(hint.value,'$[1]')
            AND schema_object.name=json_extract(hint.value,'$[2]'))=?${countParameter}
          THEN 1 WHEN (SELECT count(*) FROM sqlite_schema s WHERE (s.type,s.name) IN(
          SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]')
            FROM json_each(json_extract(?${jsonParameter},'$.required'))))=?${countParameter}
          THEN 1 ELSE 0 END)=1`
        :`(SELECT count(*) FROM sqlite_schema s WHERE (s.type,s.name) IN(
          SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?${jsonParameter})))=?${countParameter}`;
      return {predicateSql,json:hints?JSON.stringify({hints,required:frozen}):key,expectedCount:frozen.length,
        mode:hints?'rowid_triples':'full_pairs'};
    },
    withBudget(wrap){
      if(typeof wrap!=='function')failInput();
      return bind(wrap(boundDb));
    },
   };
  };
  return bind(db);
}
