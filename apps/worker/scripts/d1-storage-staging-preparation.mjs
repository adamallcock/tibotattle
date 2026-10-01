import {readFile,writeFile,mkdir,lstat,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {identityDigest} from '../../../scripts/lib/release-operation.mjs';
import {readIngestionRoleInputs} from './d1-storage-role.mjs';
import {storageError,storageSha256} from './d1-storage-plan.mjs';
/** Local disabled preparation only: no CLI, credential lookup, provider call,
 * resource ID inference, source pause or approval is executed here. Null pins
 * deliberately cannot pass the existing operator plan validator. */
export async function prepareDisabledStorageStaging({workerRoot,directory,allowUnfrozen=false}){
 workerRoot=resolve(workerRoot);directory=resolve(directory);
 const inputs=await readIngestionRoleInputs(workerRoot,{allowUnfrozen});
 const base=JSON.parse(await readFile(join(workerRoot,'wrangler.analytics.example.jsonc'),'utf8'));
 if(base.vars.STORAGE_ANALYTICS_MODE!=='disabled'||base.triggers.crons.length||base.workers_dev!==false||base.preview_urls!==false
  ||base.d1_databases.map(x=>x.binding).sort().join(',')!=='DELETION_LEDGER,STORAGE_ANALYTICS_DB,STORAGE_INGESTION_DB')throw storageError('STAGING_TEMPLATE_INVALID');
 base.main=join(workerRoot,'src/storage-analytics-worker.ts');delete base.$schema;
 const template={schema:'d1-storage-plan-v1',operationId:null,environment:'staging',accountId:null,sourceCommit:null,previousSourceCommit:null,
  createdAt:null,expiresAt:null,phase:'create',operatingCapBytes:9000000000,targets:[
   {role:'ingestion',name:null,binding:'USAGE_MONITOR_DB',databaseId:null,qualificationSha256:null,migrationGrowthBudgetBytes:null},
   {role:'analytics',name:null,binding:'ANALYTICS_DB',databaseId:null,qualificationSha256:null,migrationGrowthBudgetBytes:null}]};
 const files={
  'resource-plan.template.json':template,
  'source-pause.template.json':{schema:'d1-storage-source-pause-preparation-v1',sourceKind:'raw-legacy-baseline',sourceDatabaseId:null,
   sourceWorkerCommit:null,sourceSchemaSha256:null,snapshotDigest:null,sourceId:null,sourceNamespace:null,
   collectionPauseReceiptSha256:null,allWritersStoppedProofSha256:null,sourceFreezeContractSha256:null,
   schemaAndHighWaterBeforeSha256:null,schemaAndHighWaterAfterSha256:null,privilegedDDLDisabledProofSha256:null},
  'ledger-reconciliation.template.json':{schema:'d1-storage-ledger-preparation-v1',mode:'reuse-qualified-independent-ledger',
   ledgerDatabaseId:null,ledgerSchemaSha256:null,orderedMigrationQualificationSha256:null,
   beforeReceiptSha256:null,restoredTargetSuppressionReceiptSha256:null,afterReceiptSha256:null,
   originalLedgerRetained:true,emptyReplacementForbidden:true,analyticsErasureJobsVerified:false},
  'app-config.patch.json':{env:{staging:{workers_dev:false,preview_urls:false,routes:[],triggers:{crons:[]},
   vars:{TELEMETRY_STORAGE_MODE:'typed',TELEMETRY_STORAGE_NAMESPACE:'unbound-example',ENROLLMENT_MODE:'disabled',
    ACCOUNTLESS_ENROLLMENT_MODE:'disabled',ACCOUNTLESS_OWNERSHIP_MODE:'disabled',ACCOUNT_SCOPED_INGEST_MODE:'disabled'},
   d1_databases:[{binding:'USAGE_MONITOR_DB',database_name:'unbound-ingestion-example',database_id:'11111111-1111-4111-8111-111111111111'},
    {binding:'ANALYTICS_DB',database_name:'unbound-analytics-example',database_id:'22222222-2222-4222-8222-222222222222'},
    {binding:'DELETION_LEDGER',database_name:'unbound-existing-independent-ledger',database_id:'33333333-3333-4333-8333-333333333333'}]}}},
  'analytics.wrangler.jsonc':base,
  'migration-resources.template.json':{schema:'d1-storage-migration-bindings-preparation-v1',sourceDatabaseId:null,targetDatabaseId:null,
   sourceQuarantineBucket:null,temporaryQueueName:null,queueBatchSize:1,queueConcurrency:1,queueRetries:0,
   queueMessages:'contract-stage-step-only',migrationWorkerPackageSha256:null,contractSha256:null,mode:'disabled',fetch:'404'},
  'readiness.json':{schema:'d1-storage-disabled-staging-preparation-v1',candidateSourceCommit:inputs.sourceCommit,frozenSource:inputs.frozen,
   roleInputSha256:inputs.inputSha256,approvedSourceCommit:null,remoteOperations:false,executable:false,
   newDatabases:['ingestion','analytics'],controlDatabaseRequired:false,independentLedger:'preserve-and-reconcile',
   retainedR2:'preserve source bucket and pointer reachability; no automatic payload copy or deletion',
   canary:'requires exact staging origin, synthetic identity and separate explicit activation approval',
   pending:['frozen-source','role-qualifications','resource-identities','source-pause-snapshot','target-base',
    'authority-typed-copy','independent-ledger-reconciliation','restored-runtime-proof','analytics-catch-up','staging-canary-approval']},
 };
 await mkdir(directory,{mode:0o700});const st=await lstat(directory);
 if(await realpath(directory)!==directory||(st.mode&0o077)||process.getuid&&st.uid!==process.getuid())throw storageError('STAGING_DIRECTORY_UNSAFE');
 const inventory=[];for(const [name,value]of Object.entries(files)){
  const bytes=JSON.stringify(value,null,2)+'\n';await writeFile(join(directory,name),bytes,{flag:'wx',mode:0o600});inventory.push({name,sha256:storageSha256(bytes),bytes:Buffer.byteLength(bytes)});
 }
 const after=await readIngestionRoleInputs(workerRoot,{allowUnfrozen});if(identityDigest(after)!==identityDigest(inputs))throw storageError('ROLE_INPUT_CHANGED');
 await writeFile(join(directory,'inventory.json'),JSON.stringify({schema:'d1-storage-staging-preparation-inventory-v1',files:inventory,remoteOperations:false})+'\n',{flag:'wx',mode:0o600});
 return {directory,candidateSourceCommit:inputs.sourceCommit,executable:false,remoteOperations:false,inventorySha256:identityDigest(inventory)};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const options={};for(let i=2;i<process.argv.length;i++){
  const flag=process.argv[i];if(flag==='--allow-unfrozen'&&!options.allowUnfrozen){options.allowUnfrozen=true;continue;}
  const key={'--worker-root':'workerRoot','--directory':'directory'}[flag];if(!key||options[key]||!process.argv[i+1]||process.argv[i+1].startsWith('--'))throw storageError('ARGUMENTS');options[key]=process.argv[++i];
 }if(!options.workerRoot||!options.directory)throw storageError('ARGUMENTS');console.log(JSON.stringify(await prepareDisabledStorageStaging(options)));
 }catch(error){console.error(/^D1_STORAGE_[A-Z_]+$/.test(error?.code??'')?error.code:'D1_STORAGE_STAGING_PREPARATION_FAILED');process.exitCode=1;}
}
