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
 const checkout=step('Check out exact requested application source');assert.equal(checkout.with.ref,'${{ inputs.source_revision }}');assert.equal(checkout.with['persist-credentials'],false);assert.ok(job.steps.indexOf(step('Validate explicit source selection before checkout'))<job.steps.indexOf(checkout));
 assert.equal(job.env.SOURCE_REVISION,'${{ inputs.source_revision }}');
 assert.equal(job.env.BUILD_NUMBER,'${{ inputs.build_number }}');
 for(const s of job.steps.filter(s=>s.run))assert.doesNotMatch(s.run,/\$\{\{.*inputs\./);
});
test('actual shell admission refuses malformed, mismatched and dirty source before packaging',()=>{
 const source='a'.repeat(40), admission=step('Validate explicit source selection before checkout').run+'\n'+step('Bind requested source and build number').run;
 const run=overrides=>spawnSync('/bin/bash',['--noprofile','--norc','-c',`git(){ if [ "$1" = rev-parse ]; then printf '%s' "$TEST_HEAD"; else printf '%s' "$TEST_DIRTY"; fi; };\n${admission}`],{encoding:'utf8',env:{PATH:process.env.PATH,SOURCE_REVISION:source,WORKFLOW_RUNNER_REVISION:'b'.repeat(40),BUILD_NUMBER:'2026091001',TEST_HEAD:source,TEST_DIRTY:'',...overrides}});
 assert.equal(run({}).status,0,'a different exact workflow revision may package the explicitly selected application source');
 for(const input of [{SOURCE_REVISION:'x'},{SOURCE_REVISION:'b'.repeat(40)},{WORKFLOW_RUNNER_REVISION:'invalid'},{BUILD_NUMBER:'0'},{BUILD_NUMBER:'1; exit 0'},{TEST_DIRTY:' M source'}])assert.notEqual(run(input).status,0,JSON.stringify(input));
});
test('receipt-selected native builder is closed and final bytes are independently bound',()=>{
 const run=step('Package exact receipt and bind final AppImage bytes').run;
 assert.match(run,/assert\.deepEqual\(receipt,\{\.\.\.plan,status:'production_source_staged'/);
 assert.match(run,/\['--linux','AppImage','--x64','--publish','never'\]/);
 assert.match(run,/shell:false,stdio:'inherit',timeout:1200000/);
 assert.match(run,/\.\.\.receipt\.builderEnvironment/);
 assert.match(run,/linuxAppImageIdentity\(/);assert.match(run,/assert\.equal\(manifest\.sha512,image\.sha512\)/);
 assert.match(run,/validateLinuxFile\(manifest\.files\[0\],\{url:artifactName,sha512:image\.sha512,size:image\.bytes\}\)/);
 assert.match(run,/sourceCandidateSha256:hash\(receiptBytes\)/);assert.match(run,/workflowRunnerRevision:process\.env\.WORKFLOW_RUNNER_REVISION/);assert.match(run,/linux-x86_64\.AppImage/);assert.doesNotMatch(run,/linux-x64\.AppImage/);assert.match(run,/published:false,nativeRuntimeQualification:'separate_evidence_required'/);
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
 assert.equal(retain.with.name,'electron-linux-production-package-${{ inputs.source_revision }}-runner-${{ github.sha }}');
});

test('source-only Linux lane builds the required native binding before staging',async()=>{
 const source=yaml.load(await readFile(new URL('../.github/workflows/electron-production-source-preparation.yml',import.meta.url),'utf8')).jobs['linux-x64'];
 const native=source.steps.findIndex(s=>s.run?.includes('stage-linux-credential-mutex-binding.mjs'));
 const stage=source.steps.findIndex(s=>s.run?.includes('node scripts/package-electron-production.mjs'));
 const prereq=source.steps.findIndex(s=>s.run?.includes('apt-get install --yes --no-install-recommends libsecret-1-dev pkg-config'));assert.ok(prereq>=0&&prereq<native);assert.ok(native>=0&&native<stage);assert.match(source.steps[native].run,/build-linux-credential-mutex-manifest/);assert.match(source.steps[native].run,/qualify-linux-credential-mutex/);
});

test('actual builder file shape accepts bounded embedded blockMapSize and rejects unexpected metadata',()=>{
 // Public artifact metadata observed in failed hosted run34477522133; no installer/runtime success is inferred.
 const observed={url:'TiboTattle-0.1.19-linux-x86_64.AppImage',sha512:'Emmawzx46HsR/7WBKLT6vnAKOWKEbbkUpl7HwZgEoHk4TDh3ApMmiHG232S5WFtNwzSqjd8P0b55vUbkE6MdRQ==',size:130426949,blockMapSize:137305};
 const run=step('Package exact receipt and bind final AppImage bytes').run;
 const start=run.indexOf('function validateLinuxFile('),end=run.indexOf('\nassert.equal(manifest.files.length',start);
 assert.ok(start>=0&&end>start);const validate=Function('assert',`return (${run.slice(start,end).trim()});`)(assert);
 const expected={url:observed.url,sha512:observed.sha512,size:observed.size};validate(observed,expected);validate(expected,expected);
 for(const value of [0,-1,1.5,'137305',observed.size-3,Number.MAX_SAFE_INTEGER])assert.throws(()=>validate({...observed,blockMapSize:value},expected));
 for(const diff of [{unexpected:true},{url:'wrong.AppImage'},{sha512:'wrong'},{size:observed.size+1}])assert.throws(()=>validate({...observed,...diff},expected));
});
test('failed packaging always retains bounded metadata without labeling an installer qualified',()=>{
 const capture=step('Capture bounded package metadata for diagnosis'),retain=step('Retain diagnostic metadata independently of qualification');
 assert.equal(capture.if,'always()');assert.equal(retain.if,'always()');assert.equal(capture.env.PACKAGE_OUTCOME,'${{ steps.package-bytes.outcome }}');
 assert.match(capture.run,/131072/);assert.match(capture.run,/info\.isSymbolicLink\(\)/);assert.match(capture.run,/qualifiedInstaller:false/);
 assert.doesNotMatch(capture.run,/readFile\([^\n]*AppImage/);assert.doesNotMatch(retain.with.path,/AppImage|artifacts/);
 const program=capture.run.slice(capture.run.indexOf("<<'NODE'\n")+9,capture.run.lastIndexOf('\nNODE'));
 const checked=spawnSync(process.execPath,['--input-type=module','--check'],{input:program,encoding:'utf8'});assert.equal(checked.status,0,checked.stderr);
});

test('final AppImage runtime qualification uses the existing offline normal journey before retention',async()=>{
 const extract=step('Extract only the verified final AppImage for native runtime qualification');
 const image=step('Prepare the existing isolated native Linux desktop runtime');
 const runtime=step('Qualify exact final application startup refresh and cold restart offline');
 const retain=step('Retain final package and exact source evidence');
 assert.ok(job.steps.indexOf(step('Package exact receipt and bind final AppImage bytes'))<job.steps.indexOf(extract));
 assert.ok(job.steps.indexOf(extract)<job.steps.indexOf(image));
 assert.ok(job.steps.indexOf(image)<job.steps.indexOf(runtime));
 assert.ok(job.steps.indexOf(runtime)<job.steps.indexOf(retain));
 assert.match(extract.run,/qualify-electron-linux-final-appimage\.mjs --prepare --source-revision "\$SOURCE_REVISION"/);
 assert.match(image.run,/build-electron-linux-container\.mjs --architecture amd64/);
 assert.match(image.run,/containers\/electron-linux-production\/Dockerfile/);
 assert.match(runtime.run,/timeout 600s docker run --rm --init --platform=linux\/amd64 --cap-add=SYS_ADMIN --network none/);
 for(const root of ['/home/node','/run/user/1000'])assert.ok(runtime.run.includes(`--tmpfs ${root}:rw,noexec,nosuid,size=128m,uid=1000,gid=1000,mode=0700`));
 assert.match(runtime.run,/TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED=1/);
 assert.match(runtime.run,/USAGE_MONITOR_LINUX_NETWORK_BOUNDARY=network-none/);
 assert.match(runtime.run,/smoke-electron-linux-packaged\.mjs/);
 assert.match(runtime.run,/--app "\$candidate_root\/final-runtime\/extracted\/squashfs-root\/tibotattle"/);
 assert.match(runtime.run,/--staged-app "\$candidate_root\/app"/);
 assert.match(runtime.run,/qualify-electron-linux-final-appimage\.mjs --verify-runtime --source-revision "\$SOURCE_REVISION"/);
 assert.doesNotMatch(runtime.run,/--privileged|--network host|--mount|--volume|--no-sandbox|--disable-setuid-sandbox|electron-builder|updater-rehearsal/);
 for(const file of ['final-image-preparation.json','normal-packaged-smoke.json','final-image-runtime.json'])assert.ok(retain.with.path.includes(`final-runtime/${file}`));
 const docker=await readFile(new URL('../containers/electron-linux-production/Dockerfile',import.meta.url),'utf8');
 const ignore=await readFile(new URL('../containers/electron-linux-production/Dockerfile.dockerignore',import.meta.url),'utf8');
 assert.match(docker,/FROM tibotattle-electron-linux-amd64:test/);
 assert.match(docker,/process\.argv\[1\] !== process\.env\.TIBOTATTLE_IMAGE_SOURCE_REVISION/);
 assert.match(docker,/COPY \.release-build\/electron-production\/linux-x64\/final-runtime\/extracted\/squashfs-root/);
 assert.match(docker,/USER node\nENTRYPOINT \["xvfb-run"/);
 assert.match(docker,/chmod 4755 .*\/chrome-sandbox/);
 assert.doesNotMatch(docker,/electron-dev|electron-candidates|updater-rehearsal|npm install|pnpm|electron-builder/);
 assert.ok(ignore.startsWith('*\n'));assert.doesNotMatch(ignore,/!\.git|!\.release-build\/\*\*|!node_modules|!.*AppImage|!.*home/);
 const base=await readFile(new URL('../containers/electron-linux-amd64/Dockerfile',import.meta.url),'utf8');
 assert.match(base,/FROM node:26\.2\.0-bookworm-slim@sha256:ba2f9edd0785ee291c1a5287764cb41fdb7922336f878993f9d58622613e67a8/);
});
