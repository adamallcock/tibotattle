import {sha256Hex} from '../../src/crypto';
import {C06_DATABASE_SCOPE,C06_STATEMENT_SCOPE,c06ScopeConsumer,isC06OperationScope,
  type C06OperationScope} from './analytics-c06-operation-scope';

export const C06_CONSUMERS=Object.freeze([
  'cohort','daily','api','scalar','model','block','cache','publication','fixture','unclassified',
] as const);
export type C06Consumer=(typeof C06_CONSUMERS)[number];
export interface C06SourceLabel {readonly consumer:C06Consumer;readonly phase:string;
  readonly operationScope?:C06OperationScope}
const OWNER_METADATA_COLUMNS=Object.freeze(['participantId','ownerDigest','inputRevision','ownerRevision',
  'authorityEpoch','hasV1','hasV11','hasV12','hasEffective','hasLegacy']);
const PREVIEW_METADATA_COLUMNS=Object.freeze(['member_count','identified_count']);
const REVIEWED_METADATA=new Map<string,readonly string[]>([
  ['51b95b449f7412dcd425ef642d284e46c4f3dd375dcafb79014affe28b656a63',OWNER_METADATA_COLUMNS],
  ['969d2558ba5b9be8852bcf95831a7b5f28dc959151b58b4d1768d5ac9f7278f0',OWNER_METADATA_COLUMNS],
  ['dc26b2537d8dd59bb74d67fd1bef8f0eacaa06371897ff686c51b2ddf58a4fa1',PREVIEW_METADATA_COLUMNS],
]);
const HISTORY_PHYSICAL=new Set([
  'telemetry_records','telemetry_v1_records','telemetry_v11_records','typed_telemetry_records',
  'telemetry_v12_records','telemetry_usage_correction_history','typed_v11_record_proofs',
  'typed_v1_record_admissions','typed_telemetry_usage','typed_telemetry_quota','typed_telemetry_session',
]);
function validMetadataField(name:string,value:unknown):boolean {
  if(name==='participantId')return typeof value==='string';
  if(name==='ownerDigest')return value===null||typeof value==='string'&&/^[0-9a-f]{64}$/u.test(value);
  if(name.startsWith('has'))return value===0||value===1;
  return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
}
type SourceResult = D1Result<Record<string,unknown>>;
function bindClass(args:readonly unknown[]):string {
  return args.map(value=>{
    if(value===null)return 'null';
    if(typeof value==='number')return Number.isSafeInteger(value)
      ?Number.isInteger(value)&&value>=0&&value<=1024?`int:${value}`:'int:other':'number:other';
    if(typeof value==='string')return /^[0-9a-f]{64}$/u.test(value)?'text:hex64'
      :/^\d{4}-\d{2}-\d{2}$/u.test(value)?'text:day'
      :value.length<=256?`text:length:${value.length}`:'text:large';
    if(value instanceof ArrayBuffer)return `blob:length:${value.byteLength}`;
    if(value instanceof Uint8Array)return `blob:length:${value.byteLength}`;
    return 'unsupported';
  }).join('|');
}
type Reading = {label:C06SourceLabel;sql:string;args:unknown[];attempts:number;failures:number;unknownExecution:number;
  rowsRead:number;rowsWritten:number;returnedRows:number;emptyResults:number;
  maxRowsRead:number;maxRowsWritten:number;maxReturnedRows:number;
  bindSamples:Map<string,{args:unknown[]|null;attempts:number;bindingRows:Map<number,number>}>;
  resultColumns:Set<string>;resultColumnTypes:Map<string,Set<string>>;
  invalidMetadataFields:number;unmeasured:boolean};
type SchemaObject = {type:string;name:string;tbl_name:string;rootpage:number;sql:string|null};

/** Test-only SQL observer. Bind values and returned rows remain in memory and
 * never enter its report. Setup, EXPLAIN and schema inventory run separately
 * from the measured consumer calls. */
export function c06SourceLineageObserver(database:D1Database, label:()=>C06SourceLabel,
  options:{allowedPhases:readonly string[];bindingEvidence?:true}) {
  if(!options||!Array.isArray(options.allowedPhases)||options.allowedPhases.length<1
    ||options.allowedPhases.length>64||new Set(options.allowedPhases).size!==options.allowedPhases.length
    ||options.allowedPhases.some(phase=>typeof phase!=='string'||!/^[a-z][a-z0-9_]{0,63}$/u.test(phase)))
    throw new Error('C06_PHASE_CONTRACT');
  const allowedPhases=new Set(options.allowedPhases),optionsBindingEvidence=options.bindingEvidence===true;
  const readings=new Map<string,Reading>();
  const completions=new Map<C06Consumer,{calls:number;receipts:Set<string>}>();
  const statements=new WeakMap<D1PreparedStatement,{inner:D1PreparedStatement;sql:string;args:unknown[];
    operationScope?:C06OperationScope}>();
  const maxShapes=1024,maxCalls=20000;
  let callCount=0,boundaryFailures=0,ddlAttempts=0,bindingBytes=0,bindingGaps=0;
  const bindingByteLimit=8*1024*1024,bindingVectors:string[]=[],bindingVectorIds=new Map<string,number>();
  let baselineSchemaSha256:string|undefined;
  const SCHEMA_SQL=`SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema
      WHERE type IN('table','index','view','trigger') ORDER BY type,name LIMIT 2049`;
  async function sourceSchema(diagnosticDatabase:D1Database){
    const schema=(await diagnosticDatabase.prepare(SCHEMA_SQL).all<SchemaObject>()).results;
    if(schema.length>2048)throw new Error('C06_SCHEMA_BOUND');
    return {schema,sha256:await sha256Hex(JSON.stringify(schema))};
  }
  async function establishSchema(diagnosticDatabase:D1Database=database){
    if(callCount!==0||baselineSchemaSha256!==undefined)throw new Error('C06_SCHEMA_START_BOUNDARY');
    baselineSchemaSha256=(await sourceSchema(diagnosticDatabase)).sha256;
    return {schemaSha256:baselineSchemaSha256,setupStatements:1};
  }
  function registerConsumerCompletion(value:{consumer:Exclude<C06Consumer,'fixture'|'unclassified'>;
    publicCompleteReceiptSha256:string}){
    if(!C06_CONSUMERS.includes(value.consumer)
      ||!/^[0-9a-f]{64}$/u.test(value.publicCompleteReceiptSha256))
      throw new Error('C06_COMPLETION_CONTRACT');
    const existing=completions.get(value.consumer)??{calls:0,receipts:new Set<string>()};
    if(existing.calls>=20000)throw new Error('C06_COMPLETION_BOUND');
    existing.calls++;
    existing.receipts.add(value.publicCompleteReceiptSha256);
    completions.set(value.consumer,existing);
  }
  function begin(sql:string,args:unknown[],operationScope?:C06OperationScope):Reading {
    if(++callCount>maxCalls){boundaryFailures++;throw new Error('C06_SOURCE_CALL_BOUND');}
    let argumentBytes:number;
    try{argumentBytes=JSON.stringify(args).length;}catch{boundaryFailures++;throw new Error('C06_SOURCE_ARGUMENT_BOUND');}
    if(sql.length>100_000||argumentBytes>1_000_000){boundaryFailures++;throw new Error('C06_SOURCE_ARGUMENT_BOUND');}
    if(/^\s*(?:CREATE|DROP|ALTER|REINDEX|VACUUM|ATTACH|DETACH)\b/iu.test(sql))ddlAttempts++;
    const phase=label();
    if(!phase||typeof phase!=='object'||!C06_CONSUMERS.includes(phase.consumer)
      ||!allowedPhases.has(phase.phase)||phase.operationScope!==undefined&&!isC06OperationScope(phase.operationScope)
      ||operationScope!==undefined&&!isC06OperationScope(operationScope)){
      boundaryFailures++;throw new Error('C06_CONSUMER_PHASE_CONTRACT');
    }
    const exactScope=operationScope??phase.operationScope;
    const scopedLabel={consumer:exactScope?c06ScopeConsumer(exactScope):phase.consumer,phase:phase.phase,
      operationScope:exactScope??'unclassified'} as const;
    const key=JSON.stringify([scopedLabel.consumer,scopedLabel.phase,scopedLabel.operationScope,
      options.bindingEvidence?sql:sql.replace(/\s+/gu,' ').trim()]);
    let item=readings.get(key);
    if(!item){
      if(readings.size>=maxShapes){boundaryFailures++;throw new Error('C06_SOURCE_SHAPE_BOUND');}
      item={label:scopedLabel,sql,args:optionsBindingEvidence?[]:args,attempts:0,failures:0,unknownExecution:0,rowsRead:0,rowsWritten:0,returnedRows:0,
        emptyResults:0,maxRowsRead:0,maxRowsWritten:0,maxReturnedRows:0,bindSamples:new Map(),
        resultColumns:new Set(),resultColumnTypes:new Map(),invalidMetadataFields:0,unmeasured:false};
      readings.set(key,item);
    }
    item.attempts++;
    const category=bindClass(args);
    const sample=item.bindSamples.get(category);
    if(sample)sample.attempts++;
    else if(item.bindSamples.size<64)item.bindSamples.set(category,{args:optionsBindingEvidence?null:args,attempts:1,bindingRows:new Map()});
    else {boundaryFailures++;throw new Error('C06_BIND_CLASS_BOUND');}
    if(options.bindingEvidence){
      // Exact typed bind vectors are private synthetic evidence, bounded across
      // the phase. Capture failure never changes dispatched product SQL.
      try{
        const encoded=JSON.stringify(args.map(value=>{
          if(value===null)return ['null'];
          if(typeof value==='string')return ['text',value];
          if(typeof value==='number'&&Number.isFinite(value))return ['number',Object.is(value,-0)?'-0':String(value)];
          const bytes=value instanceof ArrayBuffer?new Uint8Array(value):value instanceof Uint8Array?value:null;
          if(bytes)return ['blob',[...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('')];
          throw Error('C06_BIND_VALUE_UNSUPPORTED');
        }));
        const bytes=new TextEncoder().encode(encoded).byteLength;
        let id=bindingVectorIds.get(encoded);
        if(id===undefined&&(bindingBytes+bytes>bindingByteLimit||bindingVectors.length>=maxCalls))bindingGaps++;
        else{
          if(id===undefined){id=bindingVectors.length;bindingVectorIds.set(encoded,id);bindingVectors.push(encoded);bindingBytes+=bytes;}
          const rows=item.bindSamples.get(category)!.bindingRows;rows.set(id,(rows.get(id)??0)+1);
        }
      }catch{bindingGaps++;}
    }
    return item;
  }
  function record(item:Reading,result:SourceResult|undefined) {
    if(!result){item.unmeasured=true;return;}
    if(!Number.isSafeInteger(result.meta?.rows_read)||result.meta.rows_read<0
      ||!Number.isSafeInteger(result.meta.rows_written)||result.meta.rows_written<0){
      item.unmeasured=true;return;
    }
    item.rowsRead+=result.meta.rows_read;
    item.rowsWritten+=result.meta.rows_written;
    item.returnedRows+=result.results.length;
    item.maxRowsRead=Math.max(item.maxRowsRead,result.meta.rows_read);
    item.maxRowsWritten=Math.max(item.maxRowsWritten,result.meta.rows_written);
    item.maxReturnedRows=Math.max(item.maxReturnedRows,result.results.length);
    if(!result.results.length)item.emptyResults++;
    for(const row of result.results)for(const [column,value] of Object.entries(row)){
      item.resultColumns.add(column);
      let types=item.resultColumnTypes.get(column);
      if(!types){types=new Set();item.resultColumnTypes.set(column,types);}
      types.add(value===null?'null':typeof value==='string'?'text'
        :typeof value==='number'&&Number.isSafeInteger(value)?'integer'
          :typeof value==='number'?'real':value instanceof ArrayBuffer||value instanceof Uint8Array
            ?'blob':'unsupported');
      if((OWNER_METADATA_COLUMNS as readonly string[]).includes(column)
        ||(PREVIEW_METADATA_COLUMNS as readonly string[]).includes(column)){
        if(!validMetadataField(column,value))item.invalidMetadataFields++;
      }
    }
  }
  function prepared(inner:D1PreparedStatement,sql:string,args:unknown[]=[],operationScope?:C06OperationScope):D1PreparedStatement {
    const metadata={inner,sql,args,operationScope};
    const wrapped=new Proxy(inner,{get(target,key){
      if(key===C06_STATEMENT_SCOPE)return(next?:C06OperationScope)=>{
        if(next!==undefined){
          if(!isC06OperationScope(next)||metadata.operationScope!==undefined&&metadata.operationScope!==next){
            boundaryFailures++;throw new Error('C06_OPERATION_STATEMENT_SCOPE_MISMATCH');
          }
          metadata.operationScope=next;
        }
        return metadata.operationScope;
      };
      if(key==='bind')return(...values:unknown[])=>prepared(target.bind(...values),sql,values,metadata.operationScope);
      if(key==='all'||key==='run')return async()=>{
        const item=begin(sql,args,metadata.operationScope);
        try{const result=await target[key]() as SourceResult;record(item,result);return result;}
        catch(error){item.failures++;throw error;}
      };
      if(key==='first')return async(column?:string)=>{
        const item=begin(sql,args,metadata.operationScope);
        let result:SourceResult;
        try{result=await target.all<Record<string,unknown>>();}
        catch(error){item.failures++;throw error;}
        record(item,result);
        const first=result.results[0];
        if(first===undefined)return null;
        if(column===undefined)return first;
        if(!Object.hasOwn(first,column)){
          item.failures++;throw new Error('analytics benchmark first() column unavailable');
        }
        return first[column];
      };
      if(key==='raw')return async(options?:{columnNames?:boolean})=>{
        const item=begin(sql,args,metadata.operationScope);
        try{const result=options?.columnNames?await target.raw({columnNames:true})
          :await target.raw({columnNames:false});record(item,undefined);return result;}
        catch(error){item.failures++;throw error;}
      };
      const member=Reflect.get(target,key);return typeof member==='function'?member.bind(target):member;
    }});
    statements.set(wrapped,metadata);return wrapped;
  }
  function wrap<T extends D1Database|D1DatabaseSession>(db:T):T {
    return new Proxy(db,{get(target,key){
      if(key===C06_DATABASE_SCOPE)return true;
      if(key==='prepare')return(sql:string)=>prepared(target.prepare(sql),sql);
      if(key==='batch')return async(values:D1PreparedStatement[])=>{
        const selected=values.map(value=>{
          const found=statements.get(value);
          if(!found){boundaryFailures++;throw new Error('C06_FOREIGN_BATCH_STATEMENT');}
          return found;
        });
        const started=selected.map(value=>begin(value.sql,value.args,value.operationScope));
        let result:D1Result<unknown>[];
        try{result=await target.batch(selected.map(value=>value.inner));}
        catch(error){started.forEach(item=>item.unknownExecution++);throw error;}
        if(result.length!==started.length){started.forEach(item=>item.unknownExecution++);
          boundaryFailures++;throw new Error('C06_BATCH_CARDINALITY');}
        result.forEach((row,index)=>record(started[index]!,row as SourceResult));
        return result;
      };
      if(key==='withSession')return(constraint?:D1SessionBookmark|D1SessionConstraint)=>
        wrap((target as D1Database).withSession(constraint));
      if(key==='exec'||key==='dump')return()=>{boundaryFailures++;throw new Error('C06_UNOBSERVED_ADAPTER');};
      const member=Reflect.get(target,key);return typeof member==='function'?member.bind(target):member;
    }}) as T;
  }
  const source=wrap(database);
  async function report(options:{expectedSourceCalls?:number;diagnosticDatabase?:D1Database}={}) {
    if(options.expectedSourceCalls!==undefined&&(!Number.isSafeInteger(options.expectedSourceCalls)
      ||options.expectedSourceCalls<0))throw new Error('C06_EXPECTED_CALLS_CONTRACT');
    const diagnosticDatabase=options.diagnosticDatabase??database;
    const {schema,sha256:schemaSha256}=await sourceSchema(diagnosticDatabase);
    const roots=new Map(schema.filter(row=>row.rootpage>0).map(row=>[row.rootpage,row]));
    const layouts=new Map<string,readonly string[]>();
    async function columnsFor(object:SchemaObject):Promise<readonly string[]> {
      const key=`${object.type}:${object.name}`;
      const cached=layouts.get(key);
      if(cached)return cached;
      const escaped=object.name.replaceAll('"','""');
      diagnosticStatements++;
      const rows=object.type==='index'
        ?(await diagnosticDatabase.prepare(`PRAGMA index_xinfo("${escaped}")`).all<{seqno:number;cid:number;name:string|null}>()).results
        :(await diagnosticDatabase.prepare(`PRAGMA table_xinfo("${escaped}")`).all<{cid:number;name:string|null}>()).results;
      const fields=rows.map(row=>row.name??(row.cid===-1?'rowid':'unknown_expression'));
      if(fields.length===0)throw new Error('C06_COLUMN_LAYOUT');
      layouts.set(key,fields);
      return fields;
    }
    const output=[];
    let diagnosticStatements=1;
    for(const row of readings.values()) {
      let plan:string[]=[];
      let diagnosticFailure=false;
      const unknownRoots:number[]=[],nonMainOpens:number[]=[];
      let virtualOpens=0,unknownColumns=0,programCalls=0,writeOpens=0,opaquePayloadOps=0;
      const physical=new Set<string>(),rootAccess=new Set<string>(),columnAccess=new Set<string>();
      const bindPlans=[];
      for(const [category,sample] of row.bindSamples){
        let classPlan:string[]=[];
        let bytecode:{opcode:string;p1:number;p2:number;p3:number}[]=[];
        if(row.failures===0&&row.unknownExecution===0){
          try{
            // Opt-in exact capture has one aggregate dictionary; never retain a
            // second unbounded set of representative raw arguments per class.
            const vectorId=sample.bindingRows.keys().next().value;
            const args=optionsBindingEvidence
              ?(vectorId===undefined?null:(JSON.parse(bindingVectors[vectorId]!) as Array<[string,string?]>).map(cell=>{
                if(cell[0]==='null')return null;
                if(cell[0]==='text')return cell[1]!;
                if(cell[0]==='number')return cell[1]==='-0'?-0:Number(cell[1]);
                if(cell[0]==='blob')return Uint8Array.from(cell[1]!.match(/.{2}/gu)??[],value=>Number.parseInt(value,16));
                throw Error('C06_BIND_VALUE_UNSUPPORTED');
              })):sample.args;
            if(args===null)throw Error('C06_BIND_REPRESENTATIVE_UNAVAILABLE');
            diagnosticStatements++;
            classPlan=(await diagnosticDatabase.prepare('EXPLAIN QUERY PLAN '+row.sql).bind(...args)
              .all<{detail:string}>()).results.map(item=>item.detail);
            diagnosticStatements++;
            bytecode=(await diagnosticDatabase.prepare('EXPLAIN '+row.sql).bind(...args)
              .all<{opcode:string;p1:number;p2:number;p3:number}>()).results;
            if(classPlan.length>4096||bytecode.length>16384)throw new Error('C06_EXPLAIN_BOUND');
          }catch{diagnosticFailure=true;}
        }else diagnosticFailure=true;
        if(plan.length===0)plan=classPlan;
        const cursorRoots=new Map<number,SchemaObject|'sqlite_schema'>();
        const temporaryCursors=new Set<number>();
        const classRoots=new Set<string>(),classColumns=new Set<string>();
        const classSeeks=new Set<string>(),classIterations=new Set<string>();
        for(const step of bytecode){
          if(step.opcode==='Program')programCalls++;
          if(step.opcode==='VOpen')virtualOpens++;
          if(step.opcode==='OpenWrite')writeOpens++;
          if(step.opcode==='RowData'||step.opcode==='IdxData'||step.opcode==='VColumn')opaquePayloadOps++;
          if(['OpenEphemeral','SorterOpen','OpenPseudo','OpenAutoindex'].includes(step.opcode)){
            temporaryCursors.add(step.p1);continue;
          }
          if(step.opcode==='OpenDup'){unknownColumns++;continue;}
          if(step.opcode==='OpenRead'||step.opcode==='OpenWrite'||step.opcode==='ReopenIdx'){
            if(step.p3!==0){nonMainOpens.push(step.p3);continue;}
            const object=step.p2===1?'sqlite_schema':roots.get(step.p2);
            if(!object){unknownRoots.push(step.p2);continue;}
            cursorRoots.set(step.p1,object);
            if(object==='sqlite_schema'){
              physical.add(object);rootAccess.add(`${step.opcode}:sqlite_schema:1`);
              classRoots.add(`${step.opcode}:sqlite_schema`);
            }else{
              physical.add(object.type==='index'?object.tbl_name:object.name);
              rootAccess.add(`${step.opcode}:${object.type}:${object.name}:${step.p2}`);
              classRoots.add(`${step.opcode}:${object.type}:${object.name}`);
            }
          }
          if(step.opcode==='Column'||step.opcode==='Rowid'||step.opcode==='IdxRowid'){
            const object=cursorRoots.get(step.p1);
            if(!object){if(!temporaryCursors.has(step.p1))unknownColumns++;continue;}
            let column='rowid';
            if(step.opcode==='Column'){
              if(object==='sqlite_schema'){
                column=['type','name','tbl_name','rootpage','sql'][step.p2]??'unknown_schema_column';
              }else{
                try{column=(await columnsFor(object))[step.p2]??'unknown_column';}
                catch{diagnosticFailure=true;column='unknown_column';}
              }
              if(column.startsWith('unknown'))unknownColumns++;
            }
            const access=object==='sqlite_schema'?`sqlite_schema.${column}`
              :`${object.type}:${object.name}.${column}`;
            columnAccess.add(access);classColumns.add(access);
          }
          if(/^(?:Seek|Idx|Found$|NotFound$|NoConflict$)/u.test(step.opcode)
            ||step.opcode==='Next'||step.opcode==='Prev'){
            const object=cursorRoots.get(step.p1);
            if(object&&object!=='sqlite_schema'){
              const key=`${object.type}:${object.name}`;
              if(step.opcode==='Next'||step.opcode==='Prev')classIterations.add(key);
              else classSeeks.add(key);
            }
          }
        }
        bindPlans.push({bindClass:category,attempts:sample.attempts,
          ...(optionsBindingEvidence?{bindingWitness:{contract:'c06-exact-bind-values-v1' as const,
            attempts:sample.attempts,capturedAttempts:[...sample.bindingRows.values()].reduce((n,count)=>n+count,0),
            complete:bindingGaps===0&&[...sample.bindingRows.values()].reduce((n,count)=>n+count,0)===sample.attempts,
            valuesSha256:await sha256Hex(JSON.stringify([...sample.bindingRows].map(([id,attempts])=>[bindingVectors[id],attempts]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))))}}:{}),
          planSha256:await sha256Hex(classPlan.join('\n')),
          opcodeSha256:await sha256Hex(JSON.stringify(bytecode)),
          rootAccess:[...classRoots].sort(),columnAccess:[...classColumns].sort(),
          seekRoots:[...classSeeks].sort(),iterateRoots:[...classIterations].sort()});
      }
      const fingerprint=await sha256Hex(row.sql.replace(/\s+/gu,' ').trim());
      const reviewed=REVIEWED_METADATA.get(fingerprint);
      const projection=reviewed&&row.returnedRows>0&&row.emptyResults===0
        &&row.invalidMetadataFields===0
        &&row.resultColumns.size===reviewed.length
        &&reviewed.every(column=>row.resultColumns.has(column))?'reviewed_metadata'
          :row.returnedRows===0?'unobserved_empty':'unclassified';
      const historyPhysical=[...physical].filter(name=>HISTORY_PHYSICAL.has(name)).sort();
      const projectionSchema=[...row.resultColumnTypes].map(([name,types])=>[name,[...types].sort()] as const)
        .sort((a,b)=>a[0].localeCompare(b[0]));
      const scanCount=plan.filter(detail=>/\bSCAN\b/iu.test(detail)).length;
      const searchCount=plan.filter(detail=>/\bSEARCH\b.*\bUSING\b/iu.test(detail)).length;
      const physicalSeek=diagnosticFailure||unknownRoots.length||nonMainOpens.length||virtualOpens
        ||unknownColumns||programCalls||opaquePayloadOps?'unknown'
        :historyPhysical.length===0?'no_listed_history_root'
        :scanCount>0?'history_scan_or_other_scan_unresolved'
          :searchCount>0?'indexed_seek_potential':'unknown';
      output.push({consumer:row.label.consumer,phase:row.label.phase,
        operationScope:row.label.operationScope??'unclassified',
        fingerprint,exactSqlSha256:await sha256Hex(row.sql),
        attempts:row.attempts,failures:row.failures,unknownExecution:row.unknownExecution,
        rowsRead:row.rowsRead,rowsWritten:row.rowsWritten,returnedRows:row.returnedRows,
        maxRowsRead:row.maxRowsRead,maxRowsWritten:row.maxRowsWritten,
        maxReturnedRows:row.maxReturnedRows,bindPlans,
        emptyResults:row.emptyResults,observedColumnCount:row.resultColumns.size,
        projectionSchemaSha256:await sha256Hex(JSON.stringify(projectionSchema)),
        invalidMetadataFields:row.invalidMetadataFields,projection,
        physical:[...physical].sort(),rootAccess:[...rootAccess].sort(),
        columnAccess:[...columnAccess].sort(),unknownColumns,programCalls,writeOpens,opaquePayloadOps,
        historyPhysical,physicalSeek,scanCount,searchCount,virtualOpens,
        unknownRoots:[...new Set(unknownRoots)].sort((a,b)=>a-b),
        nonMainOpens:[...new Set(nonMainOpens)].sort((a,b)=>a-b),
        planSha256:await sha256Hex(plan.join('\n')),
        planBindingCoverage:'one-representative-per-observed-class' as const,
        diagnosticFailure,unmeasured:row.unmeasured,
        projectionUnknown:projection!=='reviewed_metadata'||row.unmeasured||diagnosticFailure});
    }
    const perConsumer=Object.fromEntries(C06_CONSUMERS.map(consumer=>[consumer,{attempts:0,
      rowsRead:0,rowsWritten:0,shapes:0}]));
    for(const row of output){const aggregate=perConsumer[row.consumer]!;aggregate.attempts+=row.attempts;
      aggregate.rowsRead+=row.rowsRead;aggregate.rowsWritten+=row.rowsWritten;aggregate.shapes++;}
    return {contract:'c06-source-lineage-synthetic-v1',calls:callCount,shapes:output.length,
      schemaObjects:schema.length,schemaSha256,
      schemaStable:baselineSchemaSha256!==undefined&&baselineSchemaSha256===schemaSha256,
      schemaSetupStatements:baselineSchemaSha256===undefined?0:1,ddlAttempts,
      layoutSha256:await sha256Hex(JSON.stringify([...layouts].sort((a,b)=>a[0].localeCompare(b[0])))),
      diagnosticStatements,boundaryFailures,
      ...(optionsBindingEvidence?{bindingEvidence:{contract:'c06-exact-bind-values-v1' as const,
        complete:bindingGaps===0,bytes:bindingBytes,maximumBytes:bindingByteLimit,gaps:bindingGaps,uniqueVectors:bindingVectors.length,maximumVectors:maxCalls}}:{}),
      meterReconciled:options.expectedSourceCalls!==undefined&&options.expectedSourceCalls===callCount,
      potentialAccessOnly:true,noRescanQualified:false,
      perConsumer,
      consumerCompletions:Object.fromEntries(C06_CONSUMERS.filter(consumer=>consumer!=='fixture'&&consumer!=='unclassified')
        .map(consumer=>[consumer,{entrypointCalls:completions.get(consumer)?.calls??0,
          publicCompleteReceiptSha256:[...(completions.get(consumer)?.receipts??[])].sort()}])),
      measurements:output,
      resourceMeasured:boundaryFailures===0&&output.every(row=>row.failures===0
        &&row.unknownExecution===0&&!row.unmeasured),
      potentialAccessComplete:output.every(row=>!row.diagnosticFailure&&row.unknownRoots.length===0
        &&row.nonMainOpens.length===0&&row.virtualOpens===0&&row.unknownColumns===0
        &&row.programCalls===0&&row.writeOpens===0&&row.opaquePayloadOps===0),
      allMeasured:boundaryFailures===0&&output.every(row=>row.failures===0
        &&row.unknownExecution===0&&!row.diagnosticFailure&&!row.unmeasured
        &&row.unknownRoots.length===0&&row.nonMainOpens.length===0&&row.virtualOpens===0)};
  }
  async function privateReviewCandidates(){
    return Promise.all([...readings.values()].map(async row=>({consumer:row.label.consumer,
      operationScope:row.label.operationScope??'unclassified',
      phase:row.label.phase,exactSqlSha256:await sha256Hex(row.sql),sql:row.sql,
      bindClasses:[...row.bindSamples.keys()].sort()})));
  }
  async function privateBindingReview(){
    if(!optionsBindingEvidence)return null;
    return {contract:'c06-private-bind-dictionary-v1' as const,complete:bindingGaps===0,
      vectors:[...bindingVectors],bytes:bindingBytes,maximumBytes:bindingByteLimit,
      shapes:await Promise.all([...readings.values()].map(async row=>({sql:row.sql,phase:row.label.phase,
        operationScope:row.label.operationScope??'unclassified',exactSqlSha256:await sha256Hex(row.sql),
        bindClasses:[...row.bindSamples].map(([bindClass,sample])=>({bindClass,attempts:sample.attempts,
          vectors:[...sample.bindingRows].map(([index,attempts])=>({index,attempts}))}))})))};
  }
  function snapshotCounters(){
    let productCalls=0,rowsRead=0,rowsWritten=0;
    for(const row of readings.values()){
      if(row.label.consumer!=='fixture'||row.label.operationScope!=='fixture')productCalls+=row.attempts;
      rowsRead+=row.rowsRead;rowsWritten+=row.rowsWritten;
    }
    return {sourceCalls:callCount,productCalls,rowsRead,rowsWritten,boundaryFailures};
  }
  return {source,establishSchema,registerConsumerCompletion,report,privateReviewCandidates,privateBindingReview,snapshotCounters};
}
