/** Produce a short-argv invocation of the pinned CLI; never authenticates or runs it here. */
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import validation from './wrangler-query-preload.cjs';
export function createWranglerQueryInvocation({cliPath, configPath, binding, databaseId, mode, sqlPath, expectedSqlSha256, maxBytes=256*1024, persistTo=null}) {
  if (!['local','remote'].includes(mode) || (persistTo!==null && (mode!=='local' || !isAbsolute(persistTo)))) throw new Error('WRANGLER_QUERY_MODE');
  const cli=validation.verifyCli(cliPath),config=validation.verifyConfig({configPath,binding,databaseId}),query=validation.verifyQuery({sqlPath,expectedSqlSha256,maxBytes});
  return { command:process.execPath, args:['--no-warnings','--require',fileURLToPath(new URL('./wrangler-query-preload.cjs',import.meta.url)),cli.canonical,'d1','execute',binding,'--'+mode,'--json','--config',config.canonical,validation.PLACEHOLDER,
    '--tibo-query-path='+query.canonical,'--tibo-query-sha256='+expectedSqlSha256,'--tibo-query-max-bytes='+maxBytes,'--tibo-query-database='+databaseId,'--tibo-query-cli-sha256='+cli.digest,'--tibo-query-config-sha256='+config.digest,...(persistTo?['--persist-to',persistTo]:[])],
    proof:{wranglerVersion:'4.114.0',cliSha256:cli.digest,configSha256:config.digest,sqlSha256:expectedSqlSha256,sqlBytes:Buffer.byteLength(query.sql),mode,databaseId} };
}
