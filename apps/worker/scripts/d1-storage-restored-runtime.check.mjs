import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {rehearseStorageRestore} from './d1-storage-restore.mjs';
import {prepareDisabledStorageStaging} from './d1-storage-staging-preparation.mjs';
import {validateStoragePlan,storageSha256} from './d1-storage-plan.mjs';
const workerRoot=resolve(fileURLToPath(new URL('..',import.meta.url)));
test('actual restored accountless source completes replay, independent analytics, opt-out and ledger erasure', {timeout:90000},async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'restored-runtime-check-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=join(root,'operation');const result=await rehearseStorageRestore({workerRoot,directory,records:3,allowUnfrozen:true});
 assert.equal(result.qualifiedRestoreBase,false);assert.equal(result.runtimeReady,false);
 const bytes=await readFile(join(directory,'restored-runtime-evidence.json'));const proof=JSON.parse(bytes);
 const restore=JSON.parse(await readFile(join(directory,'qualification-evidence.json')));
 assert.equal(storageSha256(bytes),restore.restoredRuntimeEvidenceSha256);
 for(const name of ['credentialsPreserved','acceptedReceiptReplayVerified','newUploadAccepted','journalDrained','dailyValuesExact',
  'retainedTombstoneSuppressed','optOutImmediate','revokedCredentialsRefused','physicalErasureComplete','independentLedgerPreserved','sourceUnchanged'])assert.equal(proof[name],true,name);
 assert.equal(proof.recordsBefore,3);assert.equal(proof.recordsAfterAccepted,4);assert.equal(proof.remoteOperations,false);
 assert.ok(restore.restoreElapsedMs>0);assert.ok(restore.runtimeElapsedMs>0);
});
test('staging package remains disabled with two new databases, independent ledger and an unfilled approval',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'storage-staging-check-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=join(root,'preparation'),result=await prepareDisabledStorageStaging({workerRoot,directory,allowUnfrozen:true});
 assert.equal(result.executable,false);const read=async name=>JSON.parse(await readFile(join(directory,name)));
 const plan=await read('resource-plan.template.json');assert.deepEqual(plan.targets.map(t=>t.role),['ingestion','analytics']);assert.throws(()=>validateStoragePlan(plan));
 const config=await read('analytics.wrangler.jsonc');assert.equal(config.vars.STORAGE_ANALYTICS_MODE,'disabled');assert.equal(config.workers_dev,false);assert.deepEqual(config.triggers.crons,[]);
 assert.equal((await read('ledger-reconciliation.template.json')).emptyReplacementForbidden,true);
 const patch=await read('app-config.patch.json');assert.equal(patch.env.staging.vars.ACCOUNTLESS_ENROLLMENT_MODE,'disabled');assert.equal(patch.env.staging.d1_databases.length,3);
 await assert.rejects(prepareDisabledStorageStaging({workerRoot,directory,allowUnfrozen:true}),{code:'EEXIST'});
});
