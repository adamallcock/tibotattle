import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,writeFile,mkdir,symlink,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildKernelBundle} from './benchmark-analytics-whole-workload.mjs';
const workerRoot=fileURLToPath(new URL('../',import.meta.url)),repositoryRoot=path.resolve(workerRoot,'../..');
const PIN='f056940fefabed0c7f0e88353cf54845b077f0c8';
const sha=value=>createHash('sha256').update(value).digest('hex');
export async function buildMutationCaptureBundle(root,outfile,lane){
 root=await realpath(root);
 const directories={TEST_MIGRATIONS:'migrations',TEST_TYPED_INGESTION_MIGRATIONS:'typed-ingestion-migrations',
 TEST_INGESTION_BRIDGE_MIGRATIONS:'ingestion-bridge-migrations',TEST_TYPED_V1_ADMISSION_MIGRATIONS:'typed-v1-admission-migrations',
 TEST_TYPED_V11_ADMISSION_MIGRATIONS:'typed-v11-admission-migrations',TEST_INGESTION_ISOLATION_MIGRATIONS:'ingestion-isolation-migrations',
 TEST_ANALYTICS_MIGRATIONS:'analytics-migrations'};
 const migrations=Object.fromEntries(await Promise.all(Object.entries(directories).map(async([key,directory])=>{
  const names=(await readdir(path.join(root,'apps/worker',directory))).filter(name=>name.endsWith('.sql')).sort();
  for(const name of names)if(sha(await readFile(path.join(root,'apps/worker',directory,name)))!==sha(await readFile(path.join(workerRoot,directory,name))))
   throw Error('MUTATION_CAPTURE_COMMON_MIGRATION_DRIFT');
  return [key,names];
 })));
 const result=await buildKernelBundle(root,outfile,lane,lane==='reference'?PIN:null,{mutationCapture:true});
 return result;
}
async function main(){
 const args=process.argv.slice(2),selectedCase=args.length===2&&args[0]==='--case'&&args[1]==='unrelated_append'?args[1]:null;
 if(args.length&&!selectedCase)throw Error('MUTATION_CAPTURE_UNSUPPORTED_ARGUMENT');
 const snapshot=await mkdtemp(path.join(tmpdir(),'analytics-mutation-native-'));await mkdir(path.join(workerRoot,'.wrangler'),{recursive:true});
 const scratch=await mkdtemp(path.join(workerRoot,'.wrangler','mutation-capture-'));
 try{
  const archive=path.join(snapshot,'source.tar');
  if(spawnSync('git',['archive','--format=tar','--output',archive,PIN],{cwd:repositoryRoot}).status!==0
   ||spawnSync('tar',['-xf',archive,'-C',snapshot]).status!==0)throw Error('MUTATION_CAPTURE_ARCHIVE');
  await symlink(path.join(workerRoot,'node_modules'),path.join(snapshot,'apps/worker/node_modules'),'dir');
  const referencePath=path.join(scratch,'reference.mjs'),candidatePath=path.join(scratch,'candidate.mjs');
  const reference=await buildMutationCaptureBundle(snapshot,referencePath,'reference'),candidate=await buildMutationCaptureBundle(repositoryRoot,candidatePath,'candidate');
  const harnessFiles=await Promise.all(['test/helpers/analytics-mutation-capture.ts','test/helpers/analytics-native-mutation.ts','test/helpers/analytics-mutation-current.ts',
   'test/helpers/analytics-mutation-native-reference.ts','test/analytics-mutation-capture.spec.ts','test/helpers/analytics-paired-source.ts',
   'test/helpers/analytics-source-snapshot.ts','scripts/analytics-workload-mutation-proof.mjs','scripts/analytics-workload-mutation-proof-v2.mjs','scripts/analytics-workload-mutation-capture-transform.mjs',
   'scripts/qualify-analytics-mutation-capture.mjs','scripts/benchmark-analytics-whole-workload.mjs','scripts/analytics-workload-publication-clock.mjs','test/helpers/analytics-workload-kernels.ts','test/helpers/analytics-candidate.ts','vitest.config.ts'].map(async relative=>({path:path.join(workerRoot,relative),sha256:sha(await readFile(path.join(workerRoot,relative)))})));
  const pins={reference:{commit:PIN,bundle:reference.bundleSha256,input:reference.inputSha256,capture:reference.capture,publicationClock:reference.publicationClock},
   candidate:{bundle:candidate.bundleSha256,input:candidate.inputSha256,capture:candidate.capture,publicationClock:candidate.publicationClock},harness:sha(harnessFiles.map(value=>value.sha256).join(''))};
  process.stdout.write('mutation-capture-pins '+JSON.stringify(pins)+'\n');
  const config=path.join(scratch,'capture.config.ts');
  await writeFile(config,`import {mergeConfig} from 'vitest/config';import base from ${JSON.stringify(path.join(workerRoot,'vitest.config.ts'))};\nexport default mergeConfig(base,{resolve:{alias:[{find:'./helpers/analytics-mutation-native-reference',replacement:${JSON.stringify(referencePath)}},{find:'./helpers/analytics-mutation-current',replacement:${JSON.stringify(candidatePath)}}]}});`);
  const child=spawn(process.execPath,[path.join(workerRoot,'node_modules/vitest/vitest.mjs'),'run','test/analytics-mutation-capture.spec.ts','--config',config,'--reporter=verbose','--disableConsoleIntercept',...(selectedCase?['--testNamePattern','captures authentic pinned '+selectedCase+' SQL']:[])],{cwd:workerRoot,env:{...process.env,FORCE_COLOR:'0'},stdio:['ignore','inherit','inherit']});
  const [code,signal]=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve([code,signal]));});
  for(const file of [...reference.inputFiles,...candidate.inputFiles,...harnessFiles])if(sha(await readFile(file.path))!==file.sha256)throw Error('MUTATION_CAPTURE_INPUT_CHANGED');
  process.stdout.write('mutation-capture-stability '+JSON.stringify({inputsUnchanged:true,exitCode:code,signal,selectedCases:selectedCase?[selectedCase]:['no_op','old_correction','unrelated_append','metadata_change']})+'\n');
  if(code!==0||signal!==null)throw Error('MUTATION_CAPTURE_COMPONENT_FAILED');
  process.stdout.write('mutation-capture-complete '+JSON.stringify({complete:true,inputsUnchanged:true,wholeIncrementalQualification:false})+'\n');
 }finally{await rm(scratch,{recursive:true,force:true});await rm(snapshot,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
