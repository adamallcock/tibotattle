#!/usr/bin/env node
// Separate exact released-artifact admission. The original 0.1.22 lane is unchanged.
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseProductionCanaryArguments,runProductionCanary} from './run-signed-electron-production-canary.mjs';
export const SIGNED_023_SOURCE='dd4ca80510ddf0834baa55294ce1b2487cd473b7';
export const SIGNED_023_ASAR='3e058106d41b34fc630efb845a3052e4569dba8dd012309cd493281ba6fbfeba';
export function parseSigned023CanaryArguments(argv){
 const value=parseProductionCanaryArguments(argv);
 if(value.sourceRevision!==SIGNED_023_SOURCE||value.asarSha256!==SIGNED_023_ASAR)throw Object.assign(new Error('PRODUCTION_CANARY_REFUSED'),{canaryStage:'signed_023_identity'});
 return value;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const proof=await runProductionCanary(parseSigned023CanaryArguments(process.argv.slice(2)));process.stdout.write(JSON.stringify(proof)+'\n');if(proof.status!=='prepared')process.exitCode=proof.status==='cleanup_required'?2:1;}
 catch{process.stderr.write('PRODUCTION_CANARY_023_REFUSED\n');process.exitCode=1;}
}
