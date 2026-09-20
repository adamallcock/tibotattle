'use strict';
const { isMainThread } = require('node:worker_threads');
const validation = require('./wrangler-query-preload.cjs');
const PLACEHOLDER = '__TIBOTATTLE_PINNED_STORAGE_FILE__';
function fileArguments(argv, cliPath) {
  const fail=()=>{throw new Error('D1_STORAGE_FILE_INPUT_INVALID');};
  if(argv.length!==14)fail();
  const [d1,execute,binding,mode,json,configFlag,configPath,placeholder,pathArg,hashArg,limitArg,databaseArg,cliArg,configArg]=argv;
  if(d1!=='d1'||execute!=='execute'||mode!=='--remote'||json!=='--json'||configFlag!=='--config'||placeholder!==PLACEHOLDER)fail();
  const value=(arg,name)=>{if(typeof arg!=='string'||!arg.startsWith(name+'='))fail();return arg.slice(name.length+1);};
  const cli=validation.verifyCli(cliPath,value(cliArg,'--tibo-query-cli-sha256'));
  const config=validation.verifyConfig({configPath,binding,databaseId:value(databaseArg,'--tibo-query-database')});
  if(config.digest!==value(configArg,'--tibo-query-config-sha256'))fail();
  const input=validation.verifyQuery({sqlPath:value(pathArg,'--tibo-query-path'),expectedSqlSha256:value(hashArg,'--tibo-query-sha256'),maxBytes:Number(value(limitArg,'--tibo-query-max-bytes'))});
  return [process.execPath,cli.canonical,'d1','execute',binding,mode,json,'--config',config.canonical,'--file',input.canonical,'--yes'];
}
module.exports={PLACEHOLDER,fileArguments};
if(isMainThread&&process.argv.includes(PLACEHOLDER)){
  try{process.argv=fileArguments(process.argv.slice(2),process.argv[1]);}
  catch{process.stderr.write('D1_STORAGE_FILE_INPUT_INVALID\n');process.exit(1);}
}
