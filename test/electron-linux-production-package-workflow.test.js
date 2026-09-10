import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const yaml=createRequire(require.resolve('electron-builder'))('js-yaml');
const text=await readFile(new URL('../.github/workflows/electron-linux-production-package.yml',import.meta.url),'utf8');
const workflow=yaml.load(text), job=workflow.jobs.package;
const step=name=>{const value=job.steps.find(s=>s.name===name);assert.ok(value);return value;};
test('Linux production packaging is dispatch-only with harmless registration and read-only permissions',()=>{
 assert.deepEqual(Object.keys(workflow.on).sort(),['push','workflow_dispatch']);
 assert.deepEqual(workflow.on.push.branches,['codex/unified-desktop-accountless']);
 assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(),['build_number','source_revision']);
 assert.equal(workflow.jobs.registration.if,"github.event_name == 'push'");
 assert.equal(workflow.jobs.registration.steps.length,1);assert.match(workflow.jobs.registration.steps[0].run,/^printf /);
 assert.equal(job.if,"github.event_name == 'workflow_dispatch'");assert.equal(job['runs-on'],'ubuntu-24.04');
 assert.deepEqual(workflow.permissions,{contents:'read'});assert.equal(workflow.concurrency['cancel-in-progress'],false);
 assert.doesNotMatch(text,/secrets\.|id-token:|contents: write|gh release|wrangler|publish-electron/u);
 for(const s of job.steps.filter(s=>s.uses))assert.match(s.uses,/@[a-f0-9]{40}$/);
 assert.equal(job.steps[0].with.ref,'${{ github.sha }}');assert.equal(job.steps[0].with['persist-credentials'],false);
 assert.equal(job.env.SOURCE_REVISION,'${{ inputs.source_revision }}');
 assert.equal(job.env.BUILD_NUMBER,'${{ inputs.build_number }}');
 for(const s of job.steps.filter(s=>s.run))assert.doesNotMatch(s.run,/\$\{\{.*inputs\./);
});
test('actual shell admission refuses malformed, mismatched and dirty source before packaging',()=>{
 const source='a'.repeat(40), admission=step('Bind requested source and build number').run;
 const run=overrides=>spawnSync('/bin/bash',['--noprofile','--norc','-c',`git(){ if [ "$1" = rev-parse ]; then printf '%s' "$TEST_HEAD"; else printf '%s' "$TEST_DIRTY"; fi; };\n${admission}`],{encoding:'utf8',env:{PATH:process.env.PATH,SOURCE_REVISION:source,EXPECTED_DISPATCH_SHA:source,BUILD_NUMBER:'2026091001',TEST_HEAD:source,TEST_DIRTY:'',...overrides}});
 assert.equal(run({}).status,0);
 for(const input of [{SOURCE_REVISION:'x'},{SOURCE_REVISION:'b'.repeat(40)},{EXPECTED_DISPATCH_SHA:'b'.repeat(40)},{BUILD_NUMBER:'0'},{BUILD_NUMBER:'1; exit 0'},{TEST_DIRTY:' M source'}])assert.notEqual(run(input).status,0,JSON.stringify(input));
});
test('receipt-selected native builder is closed and final bytes are independently bound',()=>{
 const run=step('Package exact receipt and bind final AppImage bytes').run;
 assert.match(run,/assert\.deepEqual\(receipt,\{\.\.\.plan,status:'production_source_staged'/);
 assert.match(run,/\['--linux','AppImage','--x64','--publish','never'\]/);
 assert.match(run,/shell:false,stdio:'inherit',timeout:1200000/);
 assert.match(run,/\.\.\.receipt\.builderEnvironment/);
 assert.match(run,/linuxAppImageIdentity\(/);assert.match(run,/assert\.equal\(manifest\.sha512,image\.sha512\)/);
 assert.match(run,/assert\.deepEqual\(manifest\.files\[0\],\{url:artifactName,sha512:image\.sha512,size:image\.bytes\}\)/);
 assert.match(run,/sourceCandidateSha256:hash\(receiptBytes\)/);assert.match(run,/published:false,nativeRuntimeQualification:'separate_evidence_required'/);
 const program=run.slice(run.indexOf("<<'NODE'\n")+9,run.lastIndexOf('\nNODE'));
 const checked=spawnSync(process.execPath,['--input-type=module','--check'],{input:program,encoding:'utf8'});assert.equal(checked.status,0,checked.stderr);
});
test('native runtime, final artifact and manifest retention remain explicit',()=>{
 const setup=step('Set up pinned native Node');assert.equal(setup.with['node-version'],'26.2.0');assert.equal(setup.with.architecture,'x64');
 assert.match(step('Install locked dependencies').run,/process\.platform!=='linux'\|\|process\.arch!=='x64'/);
 const native=step('Build and qualify the native Linux credential mutex');assert.match(native.run,/stage-linux-credential-mutex-binding/);assert.match(native.run,/build-linux-credential-mutex-manifest/);assert.match(native.run,/qualify-linux-credential-mutex/);assert.ok(job.steps.indexOf(native)<job.steps.indexOf(step('Prepare normal production source')));
 assert.match(step('Install locked dependencies').run,/pnpm install --frozen-lockfile --ignore-scripts/);
 const retain=step('Retain final package and exact source evidence');assert.equal(retain.if,undefined);
 assert.equal(retain.with['if-no-files-found'],'error');assert.match(retain.with.path,/artifacts\/\*\.AppImage/);
 assert.match(retain.with.path,/latest-linux\.yml/);assert.match(retain.with.path,/linux-production-package-receipt\.json/);
 assert.equal(retain.with.name,'electron-linux-production-package-${{ github.sha }}');
});

test('source-only Linux lane builds the required native binding before staging',async()=>{
 const source=yaml.load(await readFile(new URL('../.github/workflows/electron-production-source-preparation.yml',import.meta.url),'utf8')).jobs['linux-x64'];
 const native=source.steps.findIndex(s=>s.run?.includes('stage-linux-credential-mutex-binding.mjs'));
 const stage=source.steps.findIndex(s=>s.run?.includes('node scripts/package-electron-production.mjs'));
 assert.ok(native>=0&&native<stage);assert.match(source.steps[native].run,/build-linux-credential-mutex-manifest/);assert.match(source.steps[native].run,/qualify-linux-credential-mutex/);
});
