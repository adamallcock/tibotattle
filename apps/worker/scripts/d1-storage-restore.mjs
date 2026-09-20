import { mkdir,writeFile,readFile,lstat,realpath,symlink,readdir } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { pathToFileURL,fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { openOperation,identityDigest } from '../../../scripts/lib/release-operation.mjs';
import { storageError,storageSha256,storageSchemaDigest } from './d1-storage-plan.mjs';
import { readIngestionRoleInputs,storageRestorePreparation } from './d1-storage-role.mjs';
import { buildStorageMigrationBundles } from './d1-storage-migration-package.mjs';
import { runStorageRestorePage } from './d1-storage-restore-runner.mjs';
import { createSyntheticRestoreOwner,verifyRestoredRuntime } from './d1-storage-restored-runtime.mjs';
import { SYNTHETIC_D1_WORKER,syntheticD1Binding,syntheticRestoreQuarantine,closeSyntheticD1Bindings } from './d1-storage-local-d1.mjs';

const entry=`export * from './src/authority-restore.ts';
export * from './src/authority-restore-role.ts';
export * from './src/authority-restore-bootstrap.ts';
export * from './test/helpers/telemetry-v11.ts';
export {activateTelemetryV11Domain,createTelemetryV11DomainPredecessor} from './src/telemetry-v11-domain.ts';
export {telemetryV11DomainManifestDigestInput} from '@app-usagemonitor/telemetry-contract';
export {sha256Hex,encodeBase64Url} from './src/crypto.ts';
export {enrollAccountlessDevice,revokeAccountlessEnrollment,parseAccountlessEnrollmentRequest} from './src/accountless-enrollment.ts';
export {createAccountlessUploadOwner} from './src/accountless-ownership.ts';
export {authenticateDevice,createDeviceUploadAuthorization,claimDeviceUploadAuthorization} from './src/device-auth.ts';
export {registerTelemetryV11DayManifest} from './src/telemetry-v11-repository.ts';
export {resolveTelemetryStorageMode,readTelemetryV11StorageReplay,persistTelemetryV11StorageChunk} from './src/telemetry-storage-mode.ts';
export {initializeStorageAnalyticsRuntime,runStorageAnalyticsPass} from './src/storage-analytics-runtime.ts';
export {readV11ProjectedOwnerDays} from './src/v11-daily-projection.ts';
export {recordDeletionTombstone,hasDeletionTombstone,replayDeletionTombstones} from './src/retention.ts';
export {eraseParticipantAsOwner} from './src/participant-erasure.ts';`;
async function privateDirectory(directory){
 await mkdir(directory,{mode:0o700});const st=await lstat(directory);
 if(!st.isDirectory()||await realpath(directory)!==resolve(directory)||(st.mode&0o077)||process.getuid&&st.uid!==process.getuid())throw storageError('RESTORE_DIRECTORY_UNSAFE');
}
async function privateWrite(directory,name,value){
 const data=typeof value==='string'?value:`${JSON.stringify(value)}\n`;
 await writeFile(join(directory,name),data,{flag:'wx',mode:0o600});return storageSha256(data);
}
async function compileApi(workerRoot,directory){
 const require=createRequire(join(workerRoot,'package.json')),{build}=require('esbuild');
 const built=await build({stdin:{contents:entry,resolveDir:workerRoot,sourcefile:'storage-restore-api.ts',loader:'ts'},bundle:true,
  platform:'node',target:'node26',format:'esm',packages:'external',write:false,logLevel:'silent',
  banner:{js:`import {timingSafeEqual as nodeTimingSafeEqual} from 'node:crypto';
const crypto={getRandomValues:globalThis.crypto.getRandomValues.bind(globalThis.crypto),randomUUID:globalThis.crypto.randomUUID.bind(globalThis.crypto),
subtle:new Proxy(globalThis.crypto.subtle,{get(target,key){if(key==='timingSafeEqual')return (a,b)=>nodeTimingSafeEqual(new Uint8Array(a),new Uint8Array(b));const value=target[key];return typeof value==='function'?value.bind(target):value;}})};`}});
 if(built.outputFiles.length!==1)throw storageError('RESTORE_BUNDLE_INVALID');
 await symlink(await realpath(join(workerRoot,'node_modules')),join(directory,'node_modules'),'dir');
 const bytes=built.outputFiles[0].contents;await writeFile(join(directory,'restore-api.mjs'),bytes,{flag:'wx',mode:0o600});
 return {api:await import(pathToFileURL(join(directory,'restore-api.mjs')).href),sha256:storageSha256(bytes)};
}
async function applyMigrations(db,inputs,workerRoot,split){
 for(const input of inputs){const bytes=await readFile(join(workerRoot,input.directory,input.name));
  if(storageSha256(bytes)!==input.sha256)throw storageError('ROLE_INPUT_CHANGED');
  const statements=split(bytes.toString('utf8')).map(sql=>db.prepare(sql));
  if(statements.length>900)throw storageError('MIGRATION_STATEMENT_LIMIT');
  await db.batch(statements);
 }
}

/** Fully executable, synthetic-only local D1 API rehearsal. No remote adapter,
 * cloud credential, existing persistence directory or user dataset is admitted.
 * The source fence and all old/new local evidence remain in the private output.
 * Dirty source can rehearse but can never emit qualified schema metadata. */
export async function rehearseStorageRestore({workerRoot,directory,allowUnfrozen=false,qualify=false,records=1,transport='direct',onProgress=()=>{}}){
 const started=performance.now();
 workerRoot=resolve(workerRoot);directory=resolve(directory);
 if(!['direct','placed'].includes(transport))throw storageError('REHEARSAL_TRANSPORT_INVALID');
 if(!Number.isSafeInteger(records)||records<1||records>10000)throw storageError('REHEARSAL_RECORD_LIMIT');
 const inputs=await readIngestionRoleInputs(workerRoot,{allowUnfrozen});
 if(qualify&&!inputs.frozen)throw storageError('SOURCE_NOT_FROZEN');
 await privateDirectory(directory);
 const roleInputsSha256=await privateWrite(directory,'role-inputs.json',inputs);
 await privateWrite(directory,'preparation.json',storageRestorePreparation(inputs));
 const {api,sha256:runnerSha256}=await compileApi(workerRoot,directory);
 const require=createRequire(join(workerRoot,'package.json')),{Miniflare}=require('miniflare');
 const {unstable_splitSqlQuery:split}=require('wrangler');
 const databaseIds={SOURCE:randomUUID(),TARGET:randomUUID(),REFERENCE:randomUUID(),BASE:randomUUID(),ANALYTICS:randomUUID(),LEDGER:randomUUID()};
 const inspector={name:'inspector',modules:true,script:SYNTHETIC_D1_WORKER,compatibilityDate:'2026-07-26',d1Databases:databaseIds,r2Buckets:['QUARANTINE']};
 const localOptions={host:'127.0.0.1',cf:false,d1Persist:join(directory,'local-d1')};
 const mf=new Miniflare({...localOptions,workers:[inspector]});
 let operation;
 try{
  await mf.ready;
  const source=syntheticD1Binding(mf,'SOURCE'),target=syntheticD1Binding(mf,'TARGET'),reference=syntheticD1Binding(mf,'REFERENCE');
  await applyMigrations(source,inputs.migrations.filter(x=>x.directory==='migrations'),workerRoot,split);
  const sourceEmptyBytes=(await source.prepare('SELECT 1 AS probe').all()).meta.size_after;
  const analytics=syntheticD1Binding(mf,'ANALYTICS'),ledger=syntheticD1Binding(mf,'LEDGER');
  const runtimeInputs=[];
  for(const directory of ['analytics-migrations','deletion-ledger-migrations']){
   for(const name of (await readdir(join(workerRoot,directory))).filter(n=>/^\d{4}_[a-z0-9_-]+\.sql$/.test(n)).sort()){
    const path=join(workerRoot,directory,name),info=await lstat(path),bytes=await readFile(path);
    if(!info.isFile()||info.nlink!==1||await realpath(path)!==path||bytes.length>240*1024)throw storageError('SOURCE_FILE_UNSAFE');
    runtimeInputs.push({directory,name,sha256:storageSha256(bytes),bytes:bytes.length});
   }
  }
  await applyMigrations(analytics,runtimeInputs.filter(x=>x.directory==='analytics-migrations'),workerRoot,split);
  await applyMigrations(ledger,runtimeInputs.filter(x=>x.directory==='deletion-ledger-migrations'),workerRoot,split);
  await privateWrite(directory,'runtime-inputs.json',runtimeInputs);
  const day=new Date().toISOString().slice(0,10),fixture=await createSyntheticRestoreOwner(api,source),tombstoned=await createSyntheticRestoreOwner(api,source);
  await api.recordDeletionTombstone(ledger,tombstoned.participantId);
  await source.prepare("UPDATE telemetry_transport_formats SET lifecycle='accepted' WHERE schema_version='telemetry-contribution-v1.1'").run();
  const preparedDay=await api.makeV11Day(day,{usage:Array.from({length:records},(_,n)=>api.v11UsageRecord(day,'a',{eventId:`event:v2:${n.toString(16).padStart(64,'0')}`}))});
  const staged=await api.stageV11Day(source,fixture,preparedDay);
  const previous=await api.createTelemetryV11DomainPredecessor(source,fixture);
  const manifest={schemaVersion:'telemetry-domain-manifest-v1.1',fromDay:day,throughDay:day,
   predecessor:{token:previous.token,previousGenerationId:previous.previousGenerationId,legacyFingerprint:previous.legacyFingerprint},
   days:[{day,manifestId:staged.manifestId,manifestDigest:staged.manifestDigest}],manifestDigest:'0'.repeat(64)};
  manifest.manifestDigest=await api.sha256Hex(api.telemetryV11DomainManifestDigestInput(manifest));
  await api.activateTelemetryV11Domain(source,fixture,manifest);
  const sourcePopulatedBytes=(await source.prepare('SELECT 1 AS probe').all()).meta.size_after;
  await applyMigrations(reference,inputs.migrations,workerRoot,split);
  const finalRoleEmptyBytes=(await reference.prepare('SELECT 1 AS probe').all()).meta.size_after;
  const role=await api.prepareAuthorityRoleTarget(reference,target,await api.authoritySchemaDigest(await api.authoritySchemaInventory(reference)));
  const ddl=objects=>['table','index','view','trigger'].flatMap(type=>objects.filter(x=>x.type===type).map(x=>`${x.sql};`)).join('\n');
  const baseSql=`${ddl(role.baseSchema)}\nINSERT INTO typed_telemetry_schema VALUES(1,1);\nINSERT INTO typed_v1_analytical_schema VALUES(1,1);\nINSERT INTO ingestion_analytics_separation VALUES(1,'prepared',1,1);\n`;
  const baseSha256=storageSha256(baseSql),operatorLedger=[{name:'0001_restore_base.sql',sha256:baseSha256}];
  await target.batch([target.prepare(api.AUTHORITY_OPERATOR_LEDGER_SQL),target.prepare('INSERT INTO d1_storage_migrations VALUES(?,?)').bind(operatorLedger[0].name,baseSha256)]);
  role.baseSchema=await api.authoritySchemaInventory(target);role.baseSchemaDigest=await api.authoritySchemaDigest(role.baseSchema);
  role.finalSchema.push({type:'table',name:'d1_storage_migrations',tbl_name:'d1_storage_migrations',sql:api.AUTHORITY_OPERATOR_LEDGER_SQL});
  role.finalSchema.sort((a,b)=>a.type<b.type?-1:a.type>b.type?1:a.name<b.name?-1:a.name>b.name?1:0);
  const sourceSchema=await api.authoritySchemaInventory(source),retained=new Set(api.authorityRestoreRetainedTableNames());
  const sourceNamespace='synthetic-operator-rehearsal',sourceSnapshotDigest=identityDigest({inputs:inputs.inputSha256,fixture:'synthetic-v11-usage-v1',records,manifestDigest:manifest.manifestDigest});
  const authoritySequences=[];
  for(const object of sourceSchema.filter(x=>x.type==='table'&&(retained.has(x.name)||x.name==='telemetry_v1_records')&&/AUTOINCREMENT/.test(x.sql)))
   authoritySequences.push({name:object.name,sequence:await source.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').bind(object.name).first('seq')??0});
  const contract={targetOperatorLedgerDigest:identityDigest(operatorLedger),version:'authority-restore-v1',runId:'synthetic-operator-rehearsal',sourceId:'synthetic-operator-journal',sourceNamespace,sourceSnapshotDigest,
   sourceSchema,sourceSchemaDigest:await api.authoritySchemaDigest(sourceSchema),targetBaseSchema:role.baseSchema,targetBaseSchemaDigest:role.baseSchemaDigest,
   tables:sourceSchema.filter(x=>x.type==='table').map(x=>({name:x.name,disposition:retained.has(x.name)?'authority':x.name==='telemetry_v1_records'?'typed-v1':x.name==='telemetry_v11_records'?'typed-v11':x.name==='d1_migrations'?'outside-role':'analytics'})),
   finalSchema:role.finalSchema,finalSchemaDigest:await api.authoritySchemaDigest(role.finalSchema),authoritySequences,
   typedCopies:['v1','v11'].map(format=>({runId:`restore-${format}`,sourceNamespace,sourceSnapshotDigest,format})),
   admissionContract:'typed-v1-v11-restore-v1',operatingLimitBytes:64*1024*1024};
  const contractDigest=await api.authorityRestoreContractDigest(contract);
  await privateWrite(directory,'restore-contract.json',contract);
  const finalRoleSchemaSha256=await privateWrite(directory,'final-role-schema.json',role.finalSchema);
  await privateWrite(directory,'0001_restore_base.sql',baseSql);
  const base=syntheticD1Binding(mf,'BASE'),baseStatements=split(baseSql).map(sql=>base.prepare(sql));
  if(baseStatements.length>900)throw storageError('MIGRATION_STATEMENT_LIMIT');
  await base.batch(baseStatements);
  if(storageSchemaDigest(await api.authoritySchemaInventory(base))!==storageSchemaDigest(role.baseSchema))throw storageError('RESTORE_BASE_ARTIFACT_INVALID');
  await privateWrite(directory,'final-role-reference.sql.txt',`${ddl(role.finalSchema)}\n`);
  operation=await openOperation({directory:join(directory,'operation'),kind:'qualification',binding:{sourceCommit:inputs.sourceCommit,inputSha256:inputs.inputSha256,runnerSha256,contractDigest}});
  let state={schema:'d1-storage-restore-progress-v1',contractDigest,intent:null,stage:'freeze-source',steps:0};
  await operation.save(state);
  let transportEvidence={transport:'direct-node-api'};
  if(transport==='placed'){
   // Fresh synthetic databases only. This local admission is not a frozen-source
   // claim: source status is retained below and dirty qualification still refuses.
   const deadline=Date.now()+120000;
   const executionDigest=identityDigest({sourceCommit:inputs.sourceCommit,inputSha256:inputs.inputSha256,contractDigest,deadline,transport:'local-synthetic-placed'});
   const bundles=await buildStorageMigrationBundles({workerRoot,contract,contractDigest,expiresAt:deadline,frozenSource:true,executionDigest,placed:true});
   for(const [name,bytes]of Object.entries(bundles))await privateWrite(directory,name,Buffer.from(bytes).toString('utf8'));
   await closeSyntheticD1Bindings(mf);
   await mf.setOptions({...localOptions,workers:[inspector,
    {name:'restore-backend',modules:true,script:Buffer.from(bundles['migration-backend.mjs']).toString('utf8'),compatibilityDate:'2026-07-26',
     bindings:{STORAGE_RESTORE_MODE:'enabled'},d1Databases:{SOURCE:databaseIds.SOURCE,TARGET:databaseIds.TARGET}},
    {name:'restore-front',modules:true,script:Buffer.from(bundles['migration-worker.mjs']).toString('utf8'),compatibilityDate:'2026-07-26',
     bindings:{STORAGE_RESTORE_MODE:'enabled'},serviceBindings:{STORAGE_RESTORE_EXECUTOR:'restore-backend'},
     queueProducers:{STORAGE_RESTORE_QUEUE:'synthetic-restore'},queueConsumers:{'synthetic-restore':{maxBatchSize:1,maxBatchTimeout:0,maxRetries:0}}},
   ]});
   const queue=await mf.getQueueProducer('STORAGE_RESTORE_QUEUE','restore-front');
   await queue.send({schema:'d1-storage-restore-wakeup-v1',contractDigest,stage:'freeze-source',steps:0});
   let lastSteps=-1;
   while(true){
    if(Date.now()>=deadline)throw storageError('REHEARSAL_TRANSPORT_DEADLINE');
    const exists=await target.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='_authority_operator_progress'").first('n');
    const progress=exists?await target.prepare('SELECT contract_digest,stage,steps,intent FROM _authority_operator_progress WHERE id=1').first():null;
    if(progress){
     if(progress.contract_digest!==contractDigest||progress.steps>1024+5*Math.ceil(records/32))throw storageError('REHEARSAL_PROOF_FAILED');
     state={schema:state.schema,contractDigest,stage:progress.stage,steps:progress.steps,intent:progress.intent};
     if(state.steps!==lastSteps){onProgress({stage:state.stage,steps:state.steps});lastSteps=state.steps;await operation.save(state);}
     if(state.stage===null){if(state.intent!==null)throw storageError('REHEARSAL_PROOF_FAILED');break;}
    }
    await new Promise(resolve=>setTimeout(resolve,100));
   }
   transportEvidence={transport:'native-queue-service-binding-fetch',executionDigest,backendBundleSha256:storageSha256(bundles['migration-backend.mjs']),
    frontBundleSha256:storageSha256(bundles['migration-worker.mjs']),syntheticApiStubs:false,placementMeasured:false};
   await privateWrite(directory,'transport-evidence.json',transportEvidence);
  }else{
   // Each call is one bounded invocation; no remote adapter is admitted.
   while(state.stage!==null){
    if(state.steps>=1024+5*Math.ceil(records/32))throw storageError('REHEARSAL_STEP_LIMIT');
    onProgress({stage:state.stage,steps:state.steps});
    state=await runStorageRestorePage({state,save:value=>operation.save(value),api,source,target,contract,contractDigest});
   }
  }
  const check=async(db,sql,expected)=>{if(await db.prepare(sql).first('n')!==expected)throw storageError('REHEARSAL_PROOF_FAILED');};
  await check(source,'SELECT count(*) n FROM telemetry_v11_records',records);
  await check(target,'SELECT count(*) n FROM telemetry_v11_records',0);
  await check(target,'SELECT count(*) n FROM typed_v11_record_admissions',records);
  await check(target,'SELECT count(*) n FROM storage_v11_event_sources',1);
  await check(target,'SELECT completed n FROM community_public_source_bootstrap',1);
  if((await target.prepare('PRAGMA foreign_key_check').all()).results.length)throw storageError('REHEARSAL_PROOF_FAILED');
  const after=await readIngestionRoleInputs(workerRoot,{allowUnfrozen});
  if(identityDigest(after)!==identityDigest(inputs))throw storageError('ROLE_INPUT_CHANGED');
  const schemaRows={results:await api.authoritySchemaInventory(target)};
  const targetPopulatedBytes=(await target.prepare('SELECT 1 AS probe').all()).meta.size_after;
  if(![sourceEmptyBytes,sourcePopulatedBytes,finalRoleEmptyBytes,targetPopulatedBytes].every(n=>Number.isSafeInteger(n)&&n>0))throw storageError('REHEARSAL_MEASUREMENT_INVALID');
  const restoreElapsedMs=Math.ceil(performance.now()-started),runtimeStarted=performance.now();
  const runtimeProof=await verifyRestoredRuntime({api,source,ingestion:target,analytics,ledger,quarantine:syntheticRestoreQuarantine(mf),contract,fixture,tombstoned,preparedDay,records,onProgress});
  for(const input of runtimeInputs)if(storageSha256(await readFile(join(workerRoot,input.directory,input.name)))!==input.sha256)throw storageError('ROLE_INPUT_CHANGED');
  if(identityDigest(await readIngestionRoleInputs(workerRoot,{allowUnfrozen}))!==identityDigest(inputs))throw storageError('ROLE_INPUT_CHANGED');
  const runtimeElapsedMs=Math.ceil(performance.now()-runtimeStarted);
  const runtimeEvidenceSha256=await privateWrite(directory,'restored-runtime-evidence.json',{...runtimeProof,elapsedMs:runtimeElapsedMs,sourceCommit:inputs.sourceCommit,frozenSource:inputs.frozen,runnerSha256,contractDigest,inputSha256:inputs.inputSha256,runtimeInputSha256:identityDigest(runtimeInputs)});
  const proof={transportEvidence,elapsedMs:Math.ceil(performance.now()-started),restoreElapsedMs,runtimeElapsedMs,restoredRuntimeEvidenceSha256:runtimeEvidenceSha256,measurement:{scope:'whole-role-one-data-owner-v11-usage',additionalTombstonedAuthorityOwners:1,measuredBeforeRuntimeCanary:true,records,sourceEmptyBytes,sourcePopulatedBytes,finalRoleEmptyBytes,targetPopulatedBytes,targetIncludesRestoreReceipts:true,analyticsDatabaseExcluded:true},schema:'d1-storage-restore-rehearsal-v1',status:'passed',scope:'synthetic-v11-authority-copy-and-bootstrap',
   sourceCommit:inputs.sourceCommit,frozenSource:inputs.frozen,inputSha256:inputs.inputSha256,runnerSha256,contractDigest,
   sourceSnapshotDigest,sourceSchemaSha256:contract.sourceSchemaDigest,restoreBaseSchemaSha256:role.baseSchemaDigest,
   finalRoleSchemaSha256,roleInputsSha256,baseSqlSha256:baseSha256,finalSchemaSha256:storageSchemaDigest(schemaRows.results),steps:state.steps,
   sourceRowsPreserved:true,typedEvidenceVerified:true,authorityVerified:true,finalRoleInstalled:true,publicSourceBootstrapComplete:true,
   runtimeReady:false,remoteOperations:false,analyticsQualification:'restored-daily-runtime-passed-public-graph-separate',deletionLedgerReconciliation:'synthetic-preserved-ledger-passed'};
  const evidenceSha256=await privateWrite(directory,'qualification-evidence.json',proof);
  if(qualify){
   const manifest={schema:'d1-storage-schema-qualification-v1',status:'qualified',role:'ingestion',directory:'.release-build/ingestion-role-migrations',sourceCommit:inputs.sourceCommit,
    evidenceSha256,qualificationScope:'restore-base-schema-only',runtimeReady:false,finalRoleSchemaSha256,roleInputsSha256,
    migrations:[{name:'0001_restore_base.sql',sha256:baseSha256,beforeSchemaSha256:storageSchemaDigest([]),afterSchemaSha256:storageSchemaDigest(role.baseSchema)}]};
   await privateWrite(directory,'qualification.json',manifest);
  }
  return {status:'rehearsed',sourceCommit:inputs.sourceCommit,steps:state.steps,evidenceSha256,qualifiedRestoreBase:qualify,runtimeReady:false,remoteOperations:false};
 }finally{if(operation)await operation.close();await closeSyntheticD1Bindings(mf);await mf.dispose();}
}
export function parseRestoreArguments(argv){
 const options={rehearse:false,qualify:false,allowUnfrozen:false};
 for(let i=0;i<argv.length;i++){const arg=argv[i];
  if(['--rehearse','--qualify','--allow-unfrozen'].includes(arg)){const key=arg==='--allow-unfrozen'?'allowUnfrozen':arg.slice(2);if(options[key])throw storageError('ARGUMENTS');options[key]=true;}
  else if(['--worker-root','--directory','--records','--transport'].includes(arg)&&argv[i+1]&&!argv[i+1].startsWith('--')){const key=arg==='--worker-root'?'workerRoot':arg==='--records'?'records':arg==='--transport'?'transport':'directory';if(options[key])throw storageError('ARGUMENTS');options[key]=key==='records'?Number(argv[++i]):argv[++i];}
  else throw storageError('ARGUMENTS');
 }
 if(!options.workerRoot||(!options.rehearse&&(options.directory!==undefined||options.records!==undefined||options.transport!==undefined))
  ||(options.transport!==undefined&&!['direct','placed'].includes(options.transport))
  ||(options.records!==undefined&&(!Number.isSafeInteger(options.records)||options.records<1||options.records>10000))||(options.rehearse&&!options.directory)||(options.qualify&&(!options.rehearse||options.allowUnfrozen)))throw storageError('ARGUMENTS');return options;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const options=parseRestoreArguments(process.argv.slice(2));
  const result=options.rehearse?await rehearseStorageRestore(options):storageRestorePreparation(await readIngestionRoleInputs(options.workerRoot,{allowUnfrozen:options.allowUnfrozen}));
  process.stdout.write(`${JSON.stringify(result)}\n`);
 }catch(error){process.stderr.write(`${/^D1_STORAGE_[A-Z_]+$/.test(error?.code??'')?error.code:'D1_STORAGE_RESTORE_FAILED'}\n`);process.exitCode=1;}
}
