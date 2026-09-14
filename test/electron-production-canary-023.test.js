import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {validateCanaryManifest} from '../scripts/run-signed-electron-production-canary.mjs';
import {parseSigned023CanaryArguments,SIGNED_023_SOURCE,SIGNED_023_ASAR} from '../scripts/run-signed-electron-production-canary-023.mjs';
const identity=['--app','/tmp/TiboTattle.app','--source-revision',SIGNED_023_SOURCE,'--asar-sha256',SIGNED_023_ASAR,'--cleanup-public-key','/tmp/synthetic-public.pem','--cleanup-public-key-sha256','c'.repeat(64)];
test('023 wrapper requires the exact released source and ASAR before any artifact or key read',()=>{
 assert.equal(parseSigned023CanaryArguments(['--plan',...identity]).execute,false);
 for(const [key,value] of [['--source-revision','16a0d4dffad4b1213b28adaae139fc9ee6705837'],['--asar-sha256','e176d0d763b11f9aa90073b90d0bdd7fbdbb17cc61740331fb47e33899007579']]){const args=[...identity];args[args.indexOf(key)+1]=value;assert.throws(()=>parseSigned023CanaryArguments(['--plan',...args]),{canaryStage:'signed_023_identity'});}
 assert.throws(()=>parseSigned023CanaryArguments(['--execute-production-canary',...identity]));
 assert.equal(parseSigned023CanaryArguments(['--execute-production-canary',...identity,'--confirm','RUN_ONE_SYNTHETIC_PRODUCTION_CANARY']).execute,true);
});
test('023 manual workflow pins the fixed release and admits only bounded HTTPS redirects',async()=>{
 const workflow=await readFile(new URL('../.github/workflows/electron-production-canary-023.yml',import.meta.url),'utf8');
 const python=workflow.match(/python3 - <<'PY'\n([\s\S]*?)\n          PY/u)?.[1].replace(/^          /gmu,'');assert.ok(python);
 execFileSync('python3',['-c','import sys; compile(sys.stdin.read(),"intake","exec")'],{input:python});
 assert.ok(workflow.includes("'--location','--max-redirs','3','--proto-redir','=https'"));assert.ok(workflow.includes('default: plan'));assert.equal(workflow.includes('secrets.'),false);assert.ok(workflow.includes("canary:\n    if: github.event_name == 'workflow_dispatch'"));assert.ok(workflow.includes('scripts/run-signed-electron-production-canary-023.mjs'));assert.ok(workflow.includes('group: electron-production-synthetic-canary'));
 const directory=await mkdtemp(join(tmpdir(),'canary-023-refusal-'));
 const env={PATH:process.env.PATH,RUNNER_TEMP:directory,GITHUB_SHA:'a'.repeat(40),SELECTED_RUNNER:'a'.repeat(40),SELECTED_SOURCE:SIGNED_023_SOURCE,SELECTED_ARCHIVE:'ed055c53601ef17ecd36bee37aa1f02e45a6d8dd7cab6b0842978e5d41bfc586',SELECTED_ASAR:SIGNED_023_ASAR,CLEANUP_KEY_SHA256:'e'.repeat(64),SELECTED_MODE:'execute',EXECUTION_CONFIRMATION:'RUN_ONE_SYNTHETIC_PRODUCTION_CANARY',CLEANUP_PUBLIC_KEY:'aW52YWxpZA==',SELECTED_URL:'https://github.com/adamallcock/tibotattle/releases/download/v0.1.23/TiboTattle-0.1.23-mac-arm64.zip'};
 try{execFileSync('python3',['-c',python.split('key=base64.b64decode')[0]],{env,stdio:'ignore',timeout:3000});assert.deepEqual(await readdir(directory),[]);for(const changed of [{SELECTED_RUNNER:'f'.repeat(40)},{SELECTED_URL:'https://github.com/other/other/releases/download/v0.1.23/app.zip'},{SELECTED_SOURCE:'16a0d4dffad4b1213b28adaae139fc9ee6705837'},{SELECTED_ARCHIVE:'f'.repeat(64)},{SELECTED_ASAR:'f'.repeat(64)},{EXECUTION_CONFIRMATION:''},{SELECTED_URL:env.SELECTED_URL+'?override=true'}]){assert.throws(()=>execFileSync('python3',['-c',python],{env:{...env,...changed},stdio:'ignore',timeout:3000}));assert.deepEqual(await readdir(directory),[]);}}finally{await rm(directory,{recursive:true});}
});

test('actual released 023 manifest retains normal stable contribution policy without synthetic credential metadata',()=>{
 const manifest={name:'app-usagemonitor',version:'0.1.23',tibotattleDistribution:{appId:'com.usagemonitor.local',buildNumber:'2026091401',channel:'stable',contributionPolicy:'accountless-opt-out-v1',schemaVersion:'tibotattle-electron-distribution-v1',sourceRevision:SIGNED_023_SOURCE,target:'darwin-arm64',updateFeed:'https://updates.tibotattle.com/electron/stable/darwin-arm64'}};
 assert.equal(validateCanaryManifest(manifest,SIGNED_023_SOURCE).channel,'stable');
 assert.throws(()=>validateCanaryManifest({...manifest,tibotattleAccountlessSyntheticCredentialFixture:{}},SIGNED_023_SOURCE));
 assert.throws(()=>validateCanaryManifest(manifest,'16a0d4dffad4b1213b28adaae139fc9ee6705837'));
});
