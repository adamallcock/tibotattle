import { readFile,writeFile,mkdir,lstat,realpath } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { identityDigest } from '../../../scripts/lib/release-operation.mjs';
import { storageError,storageSha256 } from './d1-storage-plan.mjs';
import { readIngestionRoleInputs } from './d1-storage-role.mjs';

const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join()===keys.sort().join();
/** Exact deployment topology, independently reviewed; no provider discovery or writes. */
export function validatePlacedMigrationTopology(value){
 const name=x=>typeof x==='string'&&/^[a-z][a-z0-9-]{0,62}$/.test(x);
 const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
 // Match the maintained D1 operator name contract, independently of Worker names.
 const db=x=>exact(x,['name','id'])&&typeof x.name==='string'&&/^[a-z][a-z0-9-]{2,95}$/.test(x.name)&&uuid(x.id);
 if(!exact(value,['schema','frontName','backendName','queueName','queueId','source','target','region'])
  ||value.schema!=='d1-storage-placed-topology-v1'||!name(value.frontName)||!name(value.backendName)
  ||value.frontName===value.backendName||!name(value.queueName)||!/^[a-f0-9]{32}$/.test(value.queueId??'')
  ||!db(value.source)||!db(value.target)||value.source.id===value.target.id||value.source.name===value.target.name
  ||value.region!=='gcp:us-east4')throw storageError('MIGRATION_TOPOLOGY_INVALID');
 return structuredClone(value);
}
async function privateJson(path,limit){
 path=resolve(path);const info=await lstat(path);
 if(!info.isFile()||info.nlink!==1||(info.mode&0o077)||await realpath(path)!==path
  ||process.getuid&&info.uid!==process.getuid()||info.size>limit)throw storageError('RESTORE_CONTRACT_UNSAFE');
 try{return JSON.parse(await readFile(path));}catch{throw storageError('RESTORE_CONTRACT_INVALID');}
}
/** Shared bundling only, with no qualification claims. The production generator
 * pins clean source around this call; the local synthetic rehearsal records its
 * own source status and cannot qualify dirty source. */
export async function buildStorageMigrationBundles({workerRoot,contract,contractDigest,expiresAt,frozenSource,executionDigest,placed=false}){
 const require=createRequire(join(workerRoot,'package.json')),{build}=require('esbuild');
 if(placed&&!/^[a-f0-9]{64}$/.test(executionDigest??''))throw storageError('MIGRATION_TOPOLOGY_INVALID');
 const fixed=`contract:${JSON.stringify(contract)},contractDigest:${JSON.stringify(contractDigest)},expiresAt:${expiresAt},frozenSource:${frozenSource===true}`;
 const api=`import * as restore from './src/authority-restore.ts';
import * as bootstrap from './src/authority-restore-bootstrap.ts';
`;
 const entries=placed?{
  'migration-backend.mjs':`${api}import {createStorageMigrationBackend} from './scripts/d1-storage-migration-placed.mjs';
export default createStorageMigrationBackend({api:{...restore,...bootstrap},executionDigest:${JSON.stringify(executionDigest)},${fixed}});`,
  'migration-worker.mjs':`import {createStorageMigrationFront} from './scripts/d1-storage-migration-placed.mjs';
export default createStorageMigrationFront({executionDigest:${JSON.stringify(executionDigest)},contractDigest:${JSON.stringify(contractDigest)},expiresAt:${expiresAt}});`,
 }:{'migration-worker.mjs':`${api}import {createStorageMigrationWorker} from './scripts/d1-storage-migration-worker.mjs';
export default createStorageMigrationWorker({api:{...restore,...bootstrap},${fixed}});`};
 const bundles={};
 for(const [name,contents]of Object.entries(entries)){
  const built=await build({stdin:{contents,resolveDir:workerRoot,sourcefile:name,loader:'ts'},bundle:true,
   platform:'browser',target:'es2022',format:'esm',write:false,logLevel:'silent'});
  if(built.outputFiles.length!==1)throw storageError('RESTORE_BUNDLE_INVALID');
  bundles[name]=built.outputFiles[0].contents;
 }
 return bundles;
}

/** Produces a disabled, no-route operator bundle. Actual source/target IDs,
 * deletion-ledger reconciliation, source snapshot/write-pause approval and
 * deployment approval are separate reviewed inputs, not generated claims. */
export async function prepareStorageMigrationWorker({workerRoot,contractPath,contractDigest,directory,expiresAt,allowUnfrozen=false,placedTopologyPath,placedTopologyDigest}){
 workerRoot=resolve(workerRoot);directory=resolve(directory);contractPath=resolve(contractPath);
 const inputs=await readIngestionRoleInputs(workerRoot,{allowUnfrozen});
 const contract=await privateJson(contractPath,2*1024*1024);
 let topology;
 if(placedTopologyPath!==undefined||placedTopologyDigest!==undefined){
  if(typeof placedTopologyPath!=='string'||!/^[a-f0-9]{64}$/.test(placedTopologyDigest??''))throw storageError('MIGRATION_TOPOLOGY_INVALID');
  topology=validatePlacedMigrationTopology(await privateJson(placedTopologyPath,4096));
  if(identityDigest(topology)!==placedTopologyDigest)throw storageError('MIGRATION_TOPOLOGY_INVALID');
 }
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
 const executionDigest=topology?identityDigest({sourceCommit:inputs.sourceCommit,roleInputSha256:inputs.inputSha256,contractDigest,expiresAt,topology}):undefined;
 const bundles=await buildStorageMigrationBundles({workerRoot,contract,contractDigest,expiresAt:deadline,frozenSource:inputs.frozen,executionDigest,placed:!!topology});
 const bundle=bundles['migration-worker.mjs'];
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
 if(topology){
  const common={compatibility_date:'2026-07-26',compatibility_flags:['nodejs_compat'],workers_dev:false,preview_urls:false,
   routes:[],triggers:{crons:[]},vars:{STORAGE_RESTORE_MODE:'disabled'},observability:{enabled:true,head_sampling_rate:1}};
  const front={...common,name:topology.frontName,main:'migration-worker.mjs',
   services:[{binding:'STORAGE_RESTORE_EXECUTOR',service:topology.backendName}],
   queues:{producers:[{binding:'STORAGE_RESTORE_QUEUE',queue:topology.queueName}],
    consumers:[{queue:topology.queueName,max_batch_size:1,max_batch_timeout:1,max_concurrency:1,max_retries:0}]}};
  const backend={...common,name:topology.backendName,main:'migration-backend.mjs',placement:{region:topology.region},
   d1_databases:[{binding:'SOURCE',database_name:topology.source.name,database_id:topology.source.id},
    {binding:'TARGET',database_name:topology.target.name,database_id:topology.target.id}]};
  files['migration-backend.mjs']=bundles['migration-backend.mjs'];
  files['wrangler.jsonc']=JSON.stringify(front,null,2)+'\n';
  files['wrangler.backend.jsonc']=JSON.stringify(backend,null,2)+'\n';
  files['topology.json']=JSON.stringify(topology,null,2)+'\n';
  files['preparation.json']=JSON.stringify({...JSON.parse(files['preparation.json']),
   schema:'d1-storage-placed-migration-preparation-v1',executionDigest,driver:'private-fetch-queue-checkpoint-continuation',topology,
   topologyDigest:identityDigest(topology),backendBundleSha256:storageSha256(bundles['migration-backend.mjs']),
   frontConfigSha256:storageSha256(files['wrangler.jsonc']),backendConfigSha256:storageSha256(files['wrangler.backend.jsonc'])})+'\n';
 }
 for(const [name,value]of Object.entries(files))await writeFile(join(directory,name),value,{flag:'wx',mode:0o600});
 const after=await readIngestionRoleInputs(workerRoot,{allowUnfrozen});if(identityDigest(after)!==identityDigest(inputs))throw storageError('ROLE_INPUT_CHANGED');
 return {sourceCommit:inputs.sourceCommit,frozenSource:inputs.frozen,bundleSha256:storageSha256(bundle),contractDigest,mode:'disabled',runtimeReady:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const options={};for(let i=2;i<process.argv.length;i++){
  const name=process.argv[i];if(name==='--allow-unfrozen'){if(options.allowUnfrozen)throw storageError('ARGUMENTS');options.allowUnfrozen=true;continue;}
  const keys={'--worker-root':'workerRoot','--contract':'contractPath','--contract-sha256':'contractDigest','--directory':'directory','--expires-at':'expiresAt','--placed-topology':'placedTopologyPath','--placed-topology-sha256':'placedTopologyDigest'};
  if(!keys[name]||options[keys[name]]!==undefined||!process.argv[i+1]||process.argv[i+1].startsWith('--'))throw storageError('ARGUMENTS');options[keys[name]]=process.argv[++i];
 }if(!['workerRoot','contractPath','contractDigest','directory','expiresAt'].every(k=>typeof options[k]==='string'))throw storageError('ARGUMENTS');
 process.stdout.write(JSON.stringify(await prepareStorageMigrationWorker(options))+'\n');
 }catch(error){process.stderr.write((/^D1_STORAGE_[A-Z_]+$/.test(error?.code??'')?error.code:'D1_STORAGE_MIGRATION_PREPARATION_FAILED')+'\n');process.exitCode=1;}
}
