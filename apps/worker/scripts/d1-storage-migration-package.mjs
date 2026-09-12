import { readFile,writeFile,mkdir,lstat,realpath } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { identityDigest } from '../../../scripts/lib/release-operation.mjs';
import { storageError,storageSha256 } from './d1-storage-plan.mjs';
import { readIngestionRoleInputs } from './d1-storage-role.mjs';

/** Produces a disabled, no-route operator bundle. Actual source/target IDs,
 * deletion-ledger reconciliation, source snapshot/write-pause approval and
 * deployment approval are separate reviewed inputs, not generated claims. */
export async function prepareStorageMigrationWorker({workerRoot,contractPath,contractDigest,directory,expiresAt,allowUnfrozen=false}){
 workerRoot=resolve(workerRoot);directory=resolve(directory);contractPath=resolve(contractPath);
 const inputs=await readIngestionRoleInputs(workerRoot,{allowUnfrozen});
 const info=await lstat(contractPath);
 if(!info.isFile()||info.nlink!==1||(info.mode&0o077)||await realpath(contractPath)!==contractPath
  ||process.getuid&&info.uid!==process.getuid()||info.size>2*1024*1024)throw storageError('RESTORE_CONTRACT_UNSAFE');
 const bytes=await readFile(contractPath);let contract;try{contract=JSON.parse(bytes);}catch{throw storageError('RESTORE_CONTRACT_INVALID');}
 if(identityDigest(contract)!==contractDigest||contract.version!=='authority-restore-v1'
  ||typeof contract.sourceId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(contract.sourceId)||!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(contract.runId??'')
  ||typeof contract.sourceNamespace!=='string'||!/^[A-Za-z0-9._:-]{1,256}$/.test(contract.sourceNamespace)
  ||identityDigest(contract.sourceSchema)!==contract.sourceSchemaDigest||identityDigest(contract.targetBaseSchema)!==contract.targetBaseSchemaDigest
  ||identityDigest(contract.finalSchema)!==contract.finalSchemaDigest
  ||!Array.isArray(contract.finalSchema)||!Array.isArray(contract.sourceSchema)||!Array.isArray(contract.targetBaseSchema))throw storageError('RESTORE_CONTRACT_INVALID');
 const deadline=Date.parse(expiresAt),now=Date.now();
 if(!Number.isSafeInteger(deadline)||new Date(deadline).toISOString()!==expiresAt||deadline<=now||deadline>now+24*60*60*1000)throw storageError('RESTORE_DEADLINE_INVALID');
 await mkdir(directory,{mode:0o700});const dir=await lstat(directory);
 if(await realpath(directory)!==directory||(dir.mode&0o077)||process.getuid&&dir.uid!==process.getuid())throw storageError('RESTORE_DIRECTORY_UNSAFE');
 const entry=`import * as restore from './src/authority-restore.ts';
import * as bootstrap from './src/authority-restore-bootstrap.ts';
import {createStorageMigrationWorker} from './scripts/d1-storage-migration-worker.mjs';
export default createStorageMigrationWorker({api:{...restore,...bootstrap},contract:${JSON.stringify(contract)},contractDigest:${JSON.stringify(contractDigest)},expiresAt:${deadline},frozenSource:${inputs.frozen}});`;
 const require=createRequire(join(workerRoot,'package.json')),{build}=require('esbuild');
 const built=await build({stdin:{contents:entry,resolveDir:workerRoot,sourcefile:'migration-entry.ts',loader:'ts'},bundle:true,
  platform:'browser',target:'es2022',format:'esm',write:false,logLevel:'silent'});
 if(built.outputFiles.length!==1)throw storageError('RESTORE_BUNDLE_INVALID');
 const bundle=built.outputFiles[0].contents;
 const files={
  'migration-worker.mjs':bundle,
  'wrangler.jsonc':JSON.stringify({name:'tibotattle-restore-unbound-example',main:'migration-worker.mjs',compatibility_date:'2026-07-26',compatibility_flags:['nodejs_compat'],
   workers_dev:false,preview_urls:false,triggers:{crons:[]},vars:{STORAGE_RESTORE_MODE:'disabled'},
   queues:{producers:[{binding:'STORAGE_RESTORE_QUEUE',queue:'tibotattle-restore-unbound-example'}],
    consumers:[{queue:'tibotattle-restore-unbound-example',max_batch_size:1,max_batch_timeout:1,max_concurrency:1,max_retries:0}]},d1_databases:[
    {binding:'SOURCE',database_name:'unbound-frozen-source',database_id:'11111111-1111-4111-8111-111111111111'},
    {binding:'TARGET',database_name:'unbound-restore-target',database_id:'22222222-2222-4222-8222-222222222222'}]},null,2)+'\n',
  'preparation.json':JSON.stringify({schema:'d1-storage-migration-worker-preparation-v1',sourceCommit:inputs.sourceCommit,frozenSource:inputs.frozen,
   roleInputSha256:inputs.inputSha256,contractDigest,bundleSha256:storageSha256(bundle),expiresAt,
   mode:'disabled',http:'not-found',driver:'queue-checkpoint-continuation',remoteOperations:false,runtimeReady:false,deletionLedgerReconciliation:'pending',bindingQualification:'pending'})+'\n',
 };
 for(const [name,value]of Object.entries(files))await writeFile(join(directory,name),value,{flag:'wx',mode:0o600});
 const after=await readIngestionRoleInputs(workerRoot,{allowUnfrozen});if(identityDigest(after)!==identityDigest(inputs))throw storageError('ROLE_INPUT_CHANGED');
 return {sourceCommit:inputs.sourceCommit,frozenSource:inputs.frozen,bundleSha256:storageSha256(bundle),contractDigest,mode:'disabled',runtimeReady:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const options={};for(let i=2;i<process.argv.length;i++){
  const name=process.argv[i];if(name==='--allow-unfrozen'){if(options.allowUnfrozen)throw storageError('ARGUMENTS');options.allowUnfrozen=true;continue;}
  const keys={'--worker-root':'workerRoot','--contract':'contractPath','--contract-sha256':'contractDigest','--directory':'directory','--expires-at':'expiresAt'};
  if(!keys[name]||options[keys[name]]!==undefined||!process.argv[i+1]||process.argv[i+1].startsWith('--'))throw storageError('ARGUMENTS');options[keys[name]]=process.argv[++i];
 }if(!['workerRoot','contractPath','contractDigest','directory','expiresAt'].every(k=>typeof options[k]==='string'))throw storageError('ARGUMENTS');
 process.stdout.write(JSON.stringify(await prepareStorageMigrationWorker(options))+'\n');
 }catch(error){process.stderr.write((/^D1_STORAGE_[A-Z_]+$/.test(error?.code??'')?error.code:'D1_STORAGE_MIGRATION_PREPARATION_FAILED')+'\n');process.exitCode=1;}
}
