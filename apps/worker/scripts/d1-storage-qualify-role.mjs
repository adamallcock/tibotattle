import { mkdir,readFile,readdir,lstat,realpath,writeFile,rename } from 'node:fs/promises';
import { dirname,basename,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { identityDigest } from '../../../scripts/lib/release-operation.mjs';
import { D1_STORAGE_SCHEMA_DIRECTORIES,exactKeys,loadStorageQualification,storageError,
  storageSchemaDigest,storageSha256 } from './d1-storage-plan.mjs';
import { readIngestionRoleInputs } from './d1-storage-role.mjs';
import { STORAGE_SCHEMA_QUERY } from './d1-storage-wrangler.mjs';
import { SYNTHETIC_D1_WORKER,syntheticD1Binding,closeSyntheticD1Bindings } from './d1-storage-local-d1.mjs';

const roles=new Set(['analytics','control']),sha=/^[a-f0-9]{64}$/;
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
async function file(path,limit,{empty=false}={}){
 const full=resolve(path),info=await lstat(full);
 if(!info.isFile()||info.nlink!==1||info.size>(limit)||(!empty&&info.size===0)||await realpath(full)!==full)
  throw storageError('QUALIFICATION_FILE_UNSAFE');
 const bytes=await readFile(full);if(bytes.length!==info.size)throw storageError('QUALIFICATION_FILE_CHANGED');return bytes;
}
async function write(directory,name,value){
 const bytes=Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:`${JSON.stringify(value)}\n`);
 await writeFile(join(directory,name),bytes,{flag:'wx',mode:0o600});return storageSha256(bytes);
}
export async function readStorageRoleQualificationInputs(workerRoot,role,{allowUnfrozen=false}={}){
 if(!roles.has(role))throw storageError('QUALIFICATION_ROLE_INVALID');
 workerRoot=await realpath(resolve(workerRoot));
 // Reuse the maintained whole-checkout freeze and source-commit proof. Its
 // ingestion input digest is retained as a source pin, not a claim that this
 // tool rehearses ingestion or restores any retained data.
 const source=await readIngestionRoleInputs(workerRoot,{allowUnfrozen});
 const directory=D1_STORAGE_SCHEMA_DIRECTORIES[role],path=join(workerRoot,directory),stat=await lstat(path);
 if(!stat.isDirectory()||await realpath(path)!==path)throw storageError('QUALIFICATION_ROLE_UNSAFE');
 const names=(await readdir(path)).filter(name=>name.endsWith('.sql')).sort();
 if(names.length<1||names.length>128||names.some(name=>!/^\d{4}_[a-z0-9_-]+\.sql$/.test(name)))
  throw storageError('QUALIFICATION_ROLE_UNSAFE');
 const migrations=[];
 for(const name of names){const bytes=await file(join(path,name),240*1024),sql=bytes.toString('utf8');
  if(!Buffer.from(sql).equals(bytes)||sql.includes('\0')||/\bd1_storage_migrations\b/i.test(sql))
   throw storageError('MIGRATION_CHANGED_OR_RESERVED');
  migrations.push({name,sha256:storageSha256(bytes),bytes:bytes.length});
 }
 return {schema:'d1-storage-role-inputs-v1',role,directory,sourceCommit:source.sourceCommit,frozenSource:source.frozen,
  ingestionInputsSha256:source.inputSha256,migrations,inputSha256:identityDigest(migrations)};
}

/** This verifies an explicitly supplied, source-bound gate receipt AND its
 * actual log bytes. The schema rehearsal never manufactures a test-run claim. */
export async function verifyStorageOwningGate({gateReceipt,gateReceiptSha256,gateStdout,gateStderr},
 {sourceCommit,role,now=Date.now()}){
 if(![gateReceipt,gateStdout,gateStderr].every(value=>typeof value==='string'&&value.length>0)
  ||!sha.test(gateReceiptSha256??''))throw storageError('OWNING_GATE_REQUIRED');
 const receiptBytes=await file(gateReceipt,16*1024);
 if(storageSha256(receiptBytes)!==gateReceiptSha256)throw storageError('OWNING_GATE_CHANGED');
 let receipt;try{receipt=JSON.parse(receiptBytes);}catch{throw storageError('OWNING_GATE_INVALID');}
 exactKeys(receipt,['schema','sourceCommit','command','workingDirectory','roles','exitCode','startedAt','completedAt',
  'stdoutSha256','stderrSha256']);
 if(receipt.schema!=='d1-storage-owning-gate-v1'||!/^[a-f0-9]{40}$/.test(receipt.sourceCommit??'')||receipt.sourceCommit!==sourceCommit
  ||receipt.command!=='npm run check'||receipt.workingDirectory!=='apps/worker'||receipt.exitCode!==0
  ||!date(receipt.startedAt)||!date(receipt.completedAt)||Date.parse(receipt.startedAt)>Date.parse(receipt.completedAt)
  ||Date.parse(receipt.completedAt)>now||!sha.test(receipt.stdoutSha256)||!sha.test(receipt.stderrSha256)
  ||!Array.isArray(receipt.roles)||receipt.roles.length<1||receipt.roles.length>2
  ||new Set(receipt.roles).size!==receipt.roles.length||receipt.roles.some(value=>!roles.has(value))||!receipt.roles.includes(role))
  throw storageError('OWNING_GATE_INVALID');
 const stdout=await file(gateStdout,32*1024*1024,{empty:true}),stderr=await file(gateStderr,8*1024*1024,{empty:true});
 if(storageSha256(stdout)!==receipt.stdoutSha256||storageSha256(stderr)!==receipt.stderrSha256)
  throw storageError('OWNING_GATE_LOG_CHANGED');
 return {receipt,receiptBytes,stdout,stderr};
}

/** Only fresh synthetic workerd D1 is constructed here. There is no remote
 * adapter, cloud configuration, existing database or arbitrary binding option.
 * Every migration is one native batch, with immutable intent/result evidence.
 * An uncertain local failure is retained; this tool does not resume or retry. */
export async function qualifyStorageRole(options){
 const {role,qualify=false,allowUnfrozen=false,onProgress=()=>{}}=options;
 if(![options.workerRoot,options.directory].every(value=>typeof value==='string'&&value.length>0)
  ||typeof qualify!=='boolean'||typeof allowUnfrozen!=='boolean'||typeof onProgress!=='function')throw storageError('ARGUMENTS');
 if(qualify&&allowUnfrozen)throw storageError('SOURCE_NOT_FROZEN');
 const workerRoot=await realpath(resolve(options.workerRoot)),inputs=await readStorageRoleQualificationInputs(workerRoot,role,{allowUnfrozen});
 const gate=qualify?await verifyStorageOwningGate(options,inputs):null;
 const emitterSha256=storageSha256(await file(fileURLToPath(import.meta.url),256*1024));
 if(qualify&&storageSha256(await file(join(workerRoot,'scripts','d1-storage-qualify-role.mjs'),256*1024))!==emitterSha256)
  throw storageError('QUALIFICATION_EMITTER_CHANGED');
 const requested=resolve(options.directory),directory=join(await realpath(dirname(requested)),basename(requested));
 await mkdir(directory,{mode:0o700});
 const info=await lstat(directory);
 if(!info.isDirectory()||await realpath(directory)!==directory||(info.mode&0o077)||(process.getuid&&info.uid!==process.getuid()))
  throw storageError('QUALIFICATION_DIRECTORY_UNSAFE');
 const mirror=join(directory,'worker'),roleDirectory=join(mirror,inputs.directory);
 const migrations=[];let activeMigration=null,mf,manifestWritten=false;
 try{
  await mkdir(mirror,{mode:0o700});await mkdir(roleDirectory,{mode:0o700});
  await write(directory,'role-inputs.json',inputs);
  if(gate){await write(roleDirectory,'owning-gate.json',gate.receiptBytes);
   await write(roleDirectory,'owning-gate.stdout.log',gate.stdout);await write(roleDirectory,'owning-gate.stderr.log',gate.stderr);}
  const require=createRequire(join(workerRoot,'package.json')),{Miniflare}=require('miniflare');
  const {unstable_splitSqlQuery:split}=require('wrangler');
  mf=new Miniflare({host:'127.0.0.1',cf:false,modules:true,script:SYNTHETIC_D1_WORKER,
   compatibilityDate:'2026-07-26',d1Databases:{TARGET:randomUUID()},d1Persist:join(directory,'local-d1')});
  const db=syntheticD1Binding(mf,'TARGET');
  const schema=async()=>{const rows=(await db.prepare(STORAGE_SCHEMA_QUERY).all()).results;
   return {rows,sha256:storageSchemaDigest(rows)};};
  const initial=await schema();
  if(initial.rows.length!==0)throw storageError('QUALIFICATION_TARGET_NOT_EMPTY');
  let before=initial;
  for(const input of inputs.migrations){
   activeMigration=input.name;
   const sqlBytes=await file(join(workerRoot,inputs.directory,input.name),240*1024);
   if(storageSha256(sqlBytes)!==input.sha256)throw storageError('ROLE_INPUT_CHANGED');
   const statements=split(sqlBytes.toString('utf8'));
   if(statements.length<1||statements.length>900)throw storageError('MIGRATION_STATEMENT_LIMIT');
   await write(roleDirectory,input.name,sqlBytes);
   await write(directory,`${input.name}.intent.json`,{name:input.name,sha256:input.sha256,beforeSchemaSha256:before.sha256});
   await db.batch(statements.map(sql=>db.prepare(sql)));
   const after=await schema(),violations=(await db.prepare('PRAGMA foreign_key_check').all()).results;
   if(violations.length)throw storageError('QUALIFICATION_FOREIGN_KEY_FAILED');
   const step={name:input.name,sha256:input.sha256,beforeSchemaSha256:before.sha256,afterSchemaSha256:after.sha256};
   await write(directory,`${input.name}.result.json`,{...step,statements:statements.length,foreignKeyViolations:0});
   migrations.push(step);before=after;activeMigration=null;
   await onProgress({role,migrationsApplied:migrations.length,migrationsRequired:inputs.migrations.length});
  }
  const afterInputs=await readStorageRoleQualificationInputs(workerRoot,role,{allowUnfrozen});
  if(identityDigest(afterInputs)!==identityDigest(inputs))throw storageError('ROLE_INPUT_CHANGED');
  if(storageSha256(await file(fileURLToPath(import.meta.url),256*1024))!==emitterSha256)throw storageError('QUALIFICATION_EMITTER_CHANGED');
  if(qualify)await verifyStorageOwningGate(options,inputs);
  const finalSchemaFileSha256=await write(directory,'final-schema.json',before.rows);
  const proof={schema:'d1-storage-role-qualification-evidence-v1',status:'passed',scope:'fresh-synthetic-role-schema',
   role,sourceCommit:inputs.sourceCommit,frozenSource:inputs.frozenSource,inputSha256:inputs.inputSha256,
   ingestionInputsSha256:inputs.ingestionInputsSha256,nodeVersion:process.version,
   emitterSha256,
   initialSchemaSha256:initial.sha256,finalSchemaSha256:before.sha256,finalSchemaFileSha256,
   migrations,foreignKeyViolations:0,owningGate:gate?{receiptSha256:options.gateReceiptSha256,
    ...gate.receipt}:null,owningGateLogsVerified:gate!==null,
   runtimeReady:false,remoteOperations:false,productionDataUsed:false};
  const evidenceSha256=await write(roleDirectory,'qualification-evidence.json',proof);
  const manifest={schema:'d1-storage-schema-qualification-v1',status:qualify?'qualified':'unqualified',
   role,directory:inputs.directory,sourceCommit:inputs.sourceCommit,evidenceSha256,migrations};
  const qualificationSha256=await write(roleDirectory,'qualification.json',manifest);
  manifestWritten=true;
  if(qualify)await loadStorageQualification({workerRoot:mirror,plan:{sourceCommit:inputs.sourceCommit},target:{role,qualificationSha256}});
  return {status:manifest.status,role,sourceCommit:inputs.sourceCommit,frozenSource:inputs.frozenSource,
   migrationsApplied:migrations.length,qualificationSha256,evidenceSha256,schemaSha256:before.sha256,
   workerRoot:mirror,runtimeReady:false,remoteOperations:false};
 }catch(error){
  if(manifestWritten)await rename(join(roleDirectory,'qualification.json'),join(roleDirectory,'qualification.failed.json'));
  await write(directory,'failure.json',{schema:'d1-storage-role-qualification-failure-v1',role,
   code:/^D1_STORAGE_[A-Z_]+$/.test(error?.code??'')?error.code:'D1_STORAGE_LOCAL_REHEARSAL_FAILED',
   migrationsApplied:migrations.length,activeMigration,qualified:false,remoteOperations:false}).catch(()=>{});
  throw error;
 }finally{if(mf){await closeSyntheticD1Bindings(mf);await mf.dispose();}}
}

export function parseRoleQualificationArguments(argv){
 const options={qualify:false,allowUnfrozen:false};
 const values={'worker-root':'workerRoot',directory:'directory',role:'role','gate-receipt':'gateReceipt',
  'gate-receipt-sha256':'gateReceiptSha256','gate-stdout':'gateStdout','gate-stderr':'gateStderr'};
 for(let i=0;i<argv.length;i++){const arg=argv[i];
  if(arg==='--qualify'||arg==='--allow-unfrozen'){const key=arg==='--qualify'?'qualify':'allowUnfrozen';
   if(options[key])throw storageError('ARGUMENTS');options[key]=true;
  }else if(arg.startsWith('--')&&Object.hasOwn(values,arg.slice(2))&&argv[i+1]&&!argv[i+1].startsWith('--')){
   const key=values[arg.slice(2)];if(Object.hasOwn(options,key))throw storageError('ARGUMENTS');options[key]=argv[++i];
  }else throw storageError('ARGUMENTS');
 }
 const gates=['gateReceipt','gateReceiptSha256','gateStdout','gateStderr'];
 if(!options.workerRoot||!options.directory||!roles.has(options.role)||(options.qualify&&options.allowUnfrozen)
  ||(options.qualify?!gates.every(key=>options[key]):gates.some(key=>options[key])))throw storageError('ARGUMENTS');
 return options;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{process.stdout.write(`${JSON.stringify(await qualifyStorageRole(parseRoleQualificationArguments(process.argv.slice(2))))}\n`);}
 catch(error){process.stderr.write(`${/^D1_STORAGE_[A-Z_]+$/.test(error?.code??'')?error.code:'D1_STORAGE_QUALIFICATION_FAILED'}\n`);process.exitCode=1;}
}
