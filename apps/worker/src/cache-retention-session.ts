import {canonicalJson} from './canonical-json';
import {sha256Hex} from './crypto';
const HASH=/^[a-f0-9]{64}$/u;
const fail=():Error=>new Error('CACHE_RETENTION_UNAVAILABLE');

/** Owner-scoped digest; a raw session UUID never enters derived output. */
export const CACHE_RETENTION_SESSION_DIGEST_METHOD = 'cache-retention-session-v1';
export async function cacheRetentionSessionDigest(input:{ownerDigest:string;provider:string;
  sessionUuid:string}):Promise<string> {
  if(!HASH.test(input.ownerDigest)||typeof input.provider!=='string'
    ||typeof input.sessionUuid!=='string'||input.sessionUuid.length===0)throw fail();
  return sha256Hex(canonicalJson({method:CACHE_RETENTION_SESSION_DIGEST_METHOD,kind:'session',
    ownerDigest:input.ownerDigest,value:[input.provider,input.sessionUuid]}));
}
