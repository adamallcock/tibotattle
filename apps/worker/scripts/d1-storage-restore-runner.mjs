// Runtime-neutral: the exact reviewed API supplies canonical contract hashing.
const storageError=code=>Object.assign(new Error(`D1_STORAGE_${code}`),{code:`D1_STORAGE_${code}`});

export const STORAGE_RESTORE_STAGES=Object.freeze(['freeze-source','begin','copy-authority','copy-v1','copy-v11',
 'adopt-v1','adopt-v11','seal','verify-authority','verify-v1','verify-v11','verify-adoption-v1','verify-adoption-v11',
 'verify-complete','install-role','finalize-role','initialize-bootstrap','bootstrap','verify-ready']);
const fail=()=>storageError('RESTORE_STEP_INVALID');
/** The adapter supplies genuine D1 bindings: prepare/bind/batch are not rewritten
 * as Wrangler SQL strings. These APIs depend on D1.batch atomicity. This runner
 * neither chooses a remote target nor grants source-freeze/restore permission. */
export async function runStorageRestoreStep({api,source,target,contract,contractDigest,stage}){
 if(!STORAGE_RESTORE_STAGES.includes(stage)||source===target||!source||!target||typeof api?.authorityRestoreContractDigest!=='function'
  ||await api.authorityRestoreContractDigest(contract)!==contractDigest)throw fail();
 const call=(name,...args)=>{if(typeof api?.[name]!=='function')throw fail();return api[name](...args);};
 let result,complete=true;
 switch(stage){
 case 'freeze-source':result=await call('freezeAuthorityRestoreSource',source,contract,contractDigest);break;
 case 'begin':result=await call('beginAuthorityRestore',source,target,contract,contractDigest);break;
 case 'copy-authority':case 'verify-authority':
  result=await call('copyAuthorityPage',source,target,contract,contractDigest,stage==='verify-authority'?'verify':'copy');complete=result.state==='complete';break;
 case 'copy-v1':case 'copy-v11':
  result=await call('copyAuthorityTypedPage',source,target,contract,contractDigest,stage.slice(5));complete=result.reachedEnd===true;break;
 case 'adopt-v1':case 'adopt-v11':case 'verify-adoption-v1':case 'verify-adoption-v11':
  result=await call('adoptAuthorityTypedPage',source,target,contract,contractDigest,stage.endsWith('v11')?'v11':'v1',stage.startsWith('verify-'));complete=result.done===true;break;
 case 'seal':result=await call('sealAuthorityRestore',source,target,contract,contractDigest);break;
 case 'verify-v1':case 'verify-v11':
  result=await call('verifyAuthorityTypedPage',source,target,contract,contractDigest,stage.slice(7));complete=result.reachedEnd===true;break;
 case 'verify-complete':result=await call('completeAuthorityVerification',source,target,contract,contractDigest);break;
 case 'install-role':result=await call('promoteAuthorityRestore',source,target,contract,contractDigest);break;
 case 'finalize-role':case 'verify-ready':result=await call('finalizeAuthorityRestore',source,target,contract,contractDigest);break;
 case 'initialize-bootstrap':result=await call('initializeAuthorityRestoreBootstrap',target,contractDigest);break;
 case 'bootstrap':result=await call('bootstrapAuthorityRestorePage',target,contractDigest);complete=result.completed===true;break;
 default:throw fail();
 }
 // Only bounded public progress, not arbitrary API objects/record contents.
 const counters={};for(const key of ['records','copied','verified','chunks','owners']){
  const value=result?.[key];if(value!==undefined){if(!Number.isSafeInteger(value)||value<0)throw fail();counters[key]=value;}
 }
 return {stage,complete,counters,nextStage:complete?STORAGE_RESTORE_STAGES[STORAGE_RESTORE_STAGES.indexOf(stage)+1]??null:stage};
}

/** Bounded injected execution for the local rehearsal and a future separately
 * qualified operator binding. Persist intent BEFORE calling. Unknown responses
 * retain the same stage for exact API reconciliation; no blind write replay. */
export async function runStorageRestorePage({state,save,api,source,target,contract,contractDigest,maxSteps=1}){
 if(!state||state.schema!=='d1-storage-restore-progress-v1'||state.contractDigest!==contractDigest
  ||!Number.isSafeInteger(state.steps)||state.steps<0||!(state.stage===null||STORAGE_RESTORE_STAGES.includes(state.stage))
  ||!Number.isSafeInteger(maxSteps)||maxSteps<1||maxSteps>32||typeof save!=='function')throw fail();
 if(state.intent!==null)throw storageError('RESTORE_RECONCILE_REQUIRED');
 let current=structuredClone(state);
 for(let n=0;n<maxSteps&&current.stage!==null;n++){
  const stage=current.stage;current.intent=stage;await save(current);
  const result=await runStorageRestoreStep({api,source,target,contract,contractDigest,stage});
  current={...current,intent:null,stage:result.nextStage,steps:current.steps+1};await save(current);
 }
 return current;
}
