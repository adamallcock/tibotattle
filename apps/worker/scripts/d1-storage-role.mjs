import { spawnSync } from 'node:child_process';
import { readFile,readdir,lstat,realpath } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { storageError,storageSha256 } from './d1-storage-plan.mjs';
import { identityDigest } from '../../../scripts/lib/release-operation.mjs';

export const INGESTION_ROLE_INPUT_DIRECTORIES=Object.freeze(['migrations','typed-ingestion-migrations',
 'ingestion-bridge-migrations','typed-v11-admission-migrations','typed-v1-admission-migrations','ingestion-isolation-migrations']);
export async function readIngestionRoleInputs(workerRoot,{allowUnfrozen=false}={}){
 workerRoot=resolve(workerRoot);
 const git=(args)=>{const r=spawnSync('git',args,{cwd:workerRoot,encoding:'utf8',maxBuffer:1024*1024});
  if(r.status!==0)throw storageError('SOURCE_IDENTITY_UNAVAILABLE');return r.stdout.trim();};
 const sourceCommit=git(['rev-parse','HEAD']);if(!/^[a-f0-9]{40}$/.test(sourceCommit))throw storageError('SOURCE_IDENTITY_UNAVAILABLE');
 const dirty=git(['status','--porcelain=v1','--untracked-files=all'])!=='';
 if(dirty&&!allowUnfrozen)throw storageError('SOURCE_NOT_FROZEN');
 const migrations=[];
 for(const directory of INGESTION_ROLE_INPUT_DIRECTORIES){
  const path=join(workerRoot,directory),info=await lstat(path);
  if(!info.isDirectory()||await realpath(path)!==path)throw storageError('ROLE_INPUT_UNSAFE');
  const names=(await readdir(path)).filter(n=>n.endsWith('.sql')).sort();
  if(!names.length||names.some(n=>!/^\d{4}_[a-z0-9_-]+\.sql$/.test(n)))throw storageError('ROLE_INPUT_UNSAFE');
  for(const name of names){const file=join(path,name),stat=await lstat(file);
   if(!stat.isFile()||stat.nlink!==1||stat.size>240*1024||await realpath(file)!==file)throw storageError('ROLE_INPUT_UNSAFE');
   const bytes=await readFile(file);if(bytes.length!==stat.size||bytes.includes(0))throw storageError('ROLE_INPUT_UNSAFE');
   migrations.push({directory,name,sha256:storageSha256(bytes),bytes:bytes.length});
  }
 }
 if(migrations.length>128)throw storageError('ROLE_INPUT_LIMIT');
 return {schema:'d1-ingestion-role-inputs-v1',sourceCommit,frozen:!dirty,migrations,inputSha256:identityDigest(migrations)};
}
export function storageRestorePreparation(inputs){
 if(inputs?.schema!=='d1-ingestion-role-inputs-v1'||identityDigest(inputs.migrations)!==inputs.inputSha256)throw storageError('ROLE_INPUT_INVALID');
 return {schema:'d1-storage-restore-preparation-v1',sourceCommit:inputs.sourceCommit,inputSha256:inputs.inputSha256,
  qualificationStatus:'pending',runtimeReady:false,remoteExecutionAllowed:false,
  destination:'fresh-unbound-restore-base',finalRole:'authority-control-typed-admission-bridge-isolation',
  requiredEvidence:['exact-source-snapshot-and-write-pause','fresh-target-identity-and-capacity',
   'authority-copy-and-independent-verification','typed-copy-and-adoption-verification','exact-final-role-schema-and-foreign-keys',
   'all-retained-public-source-bootstrap','independent-analytics-catch-up','runtime-http-privacy-erasure-and-public-read-qualification'],
  frozenSourceRequired:!inputs.frozen};
}
