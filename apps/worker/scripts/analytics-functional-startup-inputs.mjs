import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {lstat,readFile,readdir,realpath} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
const split=createRequire(import.meta.url)('wrangler').unstable_splitSqlQuery;
const sha=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Error('FUNCTIONAL_STARTUP_INPUT_'+code);};
const groups={source:['migrations','typed-ingestion-migrations','ingestion-bridge-migrations','typed-v1-admission-migrations','typed-v11-admission-migrations','ingestion-isolation-migrations'],target:['analytics-migrations'],ledger:['deletion-ledger-migrations']};
/** Private synthetic startup input, not a public artifact or migration action.
 * The D1 initializer journals the exact executed bytes; no expected ledger is
 * fabricated from an activation allowlist. */
export async function prepareFunctionalStartupInputs({workerDirectory,frontier='full'}={}){
 if(!isAbsolute(workerDirectory)||await realpath(workerDirectory)!==workerDirectory||!['full','maintained-predecessor'].includes(frontier))fail('SCOPE');
 const migrations={source:[],target:[],ledger:[]};let totalBytes=0;
 for(const [role,directories]of Object.entries(groups))for(const directory of directories){
  const folder=join(workerDirectory,directory);if(await realpath(folder)!==folder||!(await lstat(folder)).isDirectory())fail('DIRECTORY');
  const names=(await readdir(folder)).filter(name=>name.endsWith('.sql')).sort();if(!names.length||names.length>128)fail('INVENTORY');
  for(const name of names){
   if(!/^\d{4}_[a-z0-9_-]+\.sql$/u.test(name))fail('NAME');
   if(frontier==='maintained-predecessor'&&(directory==='ingestion-isolation-migrations'&&name>='0014_'||directory==='analytics-migrations'&&name>='0034_'))continue;
   const path=join(folder,name),info=await lstat(path);if(!info.isFile()||info.nlink!==1||await realpath(path)!==path||info.size<1||info.size>512*1024)fail('FILE');
   const bytes=await readFile(path),sql=bytes.toString('utf8');if(bytes.length!==info.size||!Buffer.from(sql).equals(bytes)||bytes.includes(0))fail('BYTES');
   totalBytes+=bytes.length;if(totalBytes>16*1024*1024)fail('TOTAL_BOUND');
   const queries=split(sql);if(!Array.isArray(queries)||!queries.length||queries.length>900||queries.some(query=>typeof query!=='string'||!query.trim()))fail('STATEMENTS');
   migrations[role].push({directory,name,sql,sha256:sha(bytes),queries,querySha256:queries.map(sha)});
  }
 }
 for(const values of Object.values(migrations))if(values.length>128||new Set(values.map(value=>value.name)).size!==values.length)fail('DUPLICATE_OR_COUNT');
 const unsigned={schemaVersion:'analytics-functional-startup-inputs-v1',frontier,migrations};
 return {...unsigned,inputSha256:sha(JSON.stringify(unsigned)),totalBytes};
}
