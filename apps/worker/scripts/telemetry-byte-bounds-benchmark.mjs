#!/usr/bin/env node
/** Synthetic investigation only. Transforms live source in its own bundle;
 * no package, vendor, mirror, build binding or registry is changed. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir, loadavg } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..','..','..');
export function utf8Bytes(text) {
  // JSON.stringify emits mostly ASCII telemetry vocabulary. Avoid a JS loop
  // for that path while retaining TextEncoder's exact surrogate replacement.
  if (!/[^\x00-\x7f]/u.test(text)) return text.length;
  let bytes=text.length;
  for(let index=0;index<text.length;index++) {
    const unit=text.charCodeAt(index);
    if(unit<0x80) continue;
    if(unit<0x800) {bytes++;continue;}
    if(unit>=0xd800 && unit<=0xdbff && index+1<text.length) {
      const next=text.charCodeAt(index+1);
      if(next>=0xdc00 && next<=0xdfff) {bytes+=2;index++;continue;}
    }
    bytes+=2;
  }
  return bytes;
}
export function descriptorJsonBytes(value) {
  // Deliberately restricted research comparator. It ignores serialization
  // effects and is never a candidate for arbitrary validator inputs.
  if(value===null) return 4;
  if(typeof value==='string') return utf8Bytes(JSON.stringify(value));
  if(typeof value==='number') return String(value).length;
  if(typeof value==='boolean') return value?4:5;
  if(Array.isArray(value)) return 2+Math.max(0,value.length-1)+value.reduce((sum,item)=>sum+descriptorJsonBytes(item),0);
  const entries=Object.entries(value);
  return 2+Math.max(0,entries.length-1)+entries.reduce((sum,[key,item])=>sum+utf8Bytes(JSON.stringify(key))+1+descriptorJsonBytes(item),0);
}
export async function loadBoundsHarness({ bufferFactory } = {}) {
  const sourceFile=join(root,'packages/telemetry-contract/src/primitives.js'),source=await readFile(sourceFile,'utf8');
  const needle='new TextEncoder().encode(serialized).byteLength';
  assert.equal(source.split(needle).length-1,1);
  const directory=await mkdtemp(join(tmpdir(),'telemetry-byte-bounds-'));
  const variants={};
  try {
    for(const name of ['oracle','scan','buffer','descriptor']) {
      if(name==='buffer' && bufferFactory) {variants[name]=await bufferFactory(directory);continue;}
      let contents=source;
      if(name==='scan') contents=source.replace(needle,'utf8Bytes(serialized)')+'\n'+utf8Bytes.toString();
      if(name==='buffer') contents='import { Buffer } from "node:buffer";\n'+source.replace(needle,'Buffer.byteLength(serialized,"utf8")');
      if(name==='descriptor') contents=source.replace('serialized = JSON.stringify(value);','serialized = "";')
        .replace(needle,'descriptorJsonBytes(value)')+'\n'+utf8Bytes.toString()+'\n'+descriptorJsonBytes.toString();
      const outfile=join(directory,name+'.mjs');
      await build({stdin:{contents,sourcefile:sourceFile,resolveDir:dirname(sourceFile),loader:'js'},outfile,bundle:true,
        platform:'node',format:'esm',target:'node22',logLevel:'silent'});
      variants[name]=(await import(pathToFileURL(outfile).href)).assertTelemetryClientBounds;
    }
    return {variants,close:()=>rm(directory,{recursive:true,force:true})};
  }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
}
export function syntheticShape(kind) {
  const vocabulary=kind==='unicode'?'synthetic-\u00e9\u4e2d\ud83d\ude00\ud800':'synthetic-vocabulary';
  const entry={schemaVersion:'synthetic-v1',provider:'openai_codex',model:vocabulary,usedPercent:42.125,
    observedAt:'2026-10-03T12:00:00.000Z',slot:'five_hour',ready:true,missing:null};
  return kind==='array'?{entries:Array.from({length:200},(_,i)=>({...entry,index:i}))}:entry;
}
let escape=0;
async function phase(name,value,calls,operation) {
  global.gc?.(); const loadBefore=loadavg(),start=performance.now();
  for(let index=0;index<calls;index++) {operation(value,{maxSerializedBytes:100000});escape^=index;}
  return {variant:name,calls,usPerCall:(performance.now()-start)*1000/calls,loadBefore,loadAfter:loadavg()};
}
async function allocated(name,kind,calls) {
  const child=spawnSync(process.execPath,['--expose-gc','--trace-gc-nvp',fileURLToPath(import.meta.url),
    '--allocation-child='+name,'--kind='+kind,'--calls='+calls],{encoding:'utf8',maxBuffer:16*1024*1024});
  assert.equal(child.status,0,'allocation child failed');
  let active=false,bytes=0,collections=0,scavenges=0;
  for(const line of child.stdout.split('\n')) {
    if(line==='BYTE_BOUNDS_START') {active=true;continue;}
    if(line==='BYTE_BOUNDS_END') {active=false;continue;}
    if(active) {const match=line.match(/\ballocated=([0-9]+)/);if(match) {bytes+=Number(match[1]);collections++;if(/\bgc=s\b/.test(line))scavenges++;}}
  }
  assert.ok(collections>0);return {allocatedBytesPerCall:bytes/calls,collections,scavenges};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),calls=Number(args.find(arg=>arg.startsWith('--calls='))?.slice(8)??10000);
  assert.ok(Number.isSafeInteger(calls)&&calls>=100&&calls<=1000000);
  const kind=args.find(arg=>arg.startsWith('--kind='))?.slice(7)??'ascii',child=args.find(arg=>arg.startsWith('--allocation-child='))?.split('=')[1];
  const harness=await loadBoundsHarness(),value=syntheticShape(kind);
  try {
    for(const operation of Object.values(harness.variants)) for(let warm=0;warm<500;warm++) operation(value,{maxSerializedBytes:100000});
    if(child) {global.gc();console.log('BYTE_BOUNDS_START');await phase(child,value,calls,harness.variants[child]);global.gc();console.log('BYTE_BOUNDS_END');}
    else if(args.includes('--timing-only')) {
      for(let cycle=0;cycle<3;cycle++) for(const name of ['oracle','scan','buffer','buffer','scan','oracle'])
        console.log(JSON.stringify({kind,cycle,...await phase(name,value,calls,harness.variants[name])}));
    } else if(args.includes('--length-only')) {
      const serialized=JSON.stringify(value),methods={oracle:s=>new TextEncoder().encode(s).byteLength,scan:utf8Bytes,buffer:s=>Buffer.byteLength(s,'utf8')};
      for(const name of ['oracle','scan','buffer','buffer','scan','oracle']) {
        global.gc?.();const loadBefore=loadavg(),start=performance.now();
        for(let index=0;index<calls;index++) escape^=methods[name](serialized);
        console.log(JSON.stringify({kind,variant:name,calls,serializedBytes:Buffer.byteLength(serialized),usPerCall:(performance.now()-start)*1000/calls,loadBefore,loadAfter:loadavg()}));
      }
    } else for(const name of ['oracle','scan','buffer','descriptor']) {
      const measured=await phase(name,value,calls,harness.variants[name]);
      const allocation=await allocated(name,kind,calls);
      console.log(JSON.stringify({kind,serializedBytes:Buffer.byteLength(JSON.stringify(value)),...measured,...allocation,
        basis:'V8 managed-heap GC trace between forced collections; excludes UTF8 backing-store bytes; marker overhead included',
        eliminatedUtf8BufferBytesPerCall:name==='oracle'?0:Buffer.byteLength(JSON.stringify(value)),escape}));
    }
  }finally{await harness.close();}
}
