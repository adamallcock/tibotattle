/** Disposable installed qualification of already signed bytes; never rebuilds,
 * signs or publishes. The comparison tree is extracted from those signed bytes,
 * not represented as an independent pre-signing source-stage receipt. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { productionElectronCandidatePlan } from './package-electron-production.mjs';
import { runWindowsSignedInstalled } from './smoke-electron-windows-signed-installed.mjs';

const env=process.env;
assert.equal(process.platform,'win32');assert.equal(process.arch,'x64');assert.equal(process.version,'v26.2.0');
assert.equal(env.GITHUB_ACTIONS,'true');assert.equal(env.RUNNER_ENVIRONMENT,'github-hosted');
assert.match(env.SOURCE_REVISION??'',/^[0-9a-f]{40}$/u);assert.match(env.INSTALLER_SHA256??'',/^[0-9a-f]{64}$/u);
const input=join(env.RUNNER_TEMP,'signed-input','electron-production','win32-x64');
const previous=JSON.parse(await readFile(join(input,'evidence','windows-signed-installed.json'),'utf8'));
assert.equal(previous.sourceRevision,env.SOURCE_REVISION);assert.equal(previous.installerSha256,env.INSTALLER_SHA256);assert.equal(previous.signedInstallerVerified,true);
const names=(await readdir(join(input,'artifacts'))).filter(name=>/^TiboTattle-\d+\.\d+\.\d+-Windows-x64\.exe$/u.test(name));assert.equal(names.length,1);
const installer=join(input,'artifacts',names[0]);const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(await readFile(installer)),env.INSTALLER_SHA256);
const scratch=await mkdtemp(join(env.RUNNER_TEMP,'tibotattle-frozen-extract-'));
const sevenZip=join(env.ProgramFiles,'7-Zip','7z.exe');
function extract(archive,destination){const result=spawnSync(sevenZip,['x','-y',`-o${destination}`,archive],{shell:false,stdio:'ignore',timeout:180000});assert.equal(result.error,undefined);assert.equal(result.status,0);}
extract(installer,join(scratch,'nsis'));
extract(join(scratch,'nsis','$PLUGINSDIR','app-64.7z'),join(scratch,'package'));
const require=createRequire(import.meta.url),builder=createRequire(require.resolve('electron-builder/package.json')),lib=createRequire(builder.resolve('app-builder-lib/package.json'));
const asar=lib('@electron/asar');const archive=join(scratch,'package','resources','app.asar');
const manifest=JSON.parse(asar.extractFile(archive,'package.json').toString('utf8'));
assert.equal(manifest.tibotattleDistribution.sourceRevision,env.SOURCE_REVISION);assert.equal(manifest.tibotattleDistribution.target,'win32-x64');
assert.equal(names[0],`TiboTattle-${manifest.version}-Windows-x64.exe`);
const root=resolve('.release-build/electron-production/win32-x64');await mkdir(root,{recursive:true});
const stage=join(root,'app');await mkdir(stage);asar.extractAll(archive,stage);
const plan=productionElectronCandidatePlan({target:'win32-x64',sourceRevision:env.SOURCE_REVISION,buildNumber:manifest.tibotattleDistribution.buildNumber,hostPlatform:'win32',hostArchitecture:'x64'});
assert.equal(plan.version,manifest.version);
const candidate=join(root,'production-source-candidate.json');
await writeFile(candidate,JSON.stringify({...plan,status:'production_source_staged',stagedManifest:'app/package.json',runtimeManifest:'app/electron-runtime-manifest.json'})+'\n',{flag:'wx'});
await mkdir(join(root,'artifacts'));await cp(installer,join(root,'artifacts',names[0]),{errorOnExist:true,force:false});
await cp(join(input,'artifacts','latest.yml'),join(root,'artifacts','latest.yml'),{errorOnExist:true,force:false});
await mkdir(join(root,'evidence'));
await writeFile(join(root,'evidence','frozen-reference.json'),JSON.stringify({schemaVersion:'tibotattle-windows-frozen-reference-v1',sourceRevision:env.SOURCE_REVISION,qualificationRunnerRevision:env.GITHUB_SHA,installerSha256:env.INSTALLER_SHA256,version:manifest.version,buildNumber:manifest.tibotattleDistribution.buildNumber,referenceOrigin:'extracted_from_exact_signed_installer',independentPreSigningStage:false,rebuilt:false,resigned:false,published:false,installTimeoutMs:300000})+'\n',{flag:'wx'});
try {
 await runWindowsSignedInstalled({installerPath:join(root,'artifacts',names[0]),installerSha256:env.INSTALLER_SHA256,stagedAppPath:stage,sourceCandidatePath:candidate,sourceRevision:env.SOURCE_REVISION,receiptPath:join(root,'evidence','windows-signed-installed.json')});
 console.log('WINDOWS_FROZEN_INSTALLED_QUALIFIED');
} catch(error) {
 console.error(/^ELECTRON_WINDOWS_[A-Z_]+$/u.test(error?.code??'')?error.code:'WINDOWS_FROZEN_INSTALLED_FAILED');process.exitCode=1;
}
