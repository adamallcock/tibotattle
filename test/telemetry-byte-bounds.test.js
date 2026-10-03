import assert from 'node:assert/strict';
import test from 'node:test';
import { loadBoundsHarness, utf8Bytes, descriptorJsonBytes } from '../apps/worker/scripts/telemetry-byte-bounds-benchmark.mjs';
const encoder=new TextEncoder();
function capture(operation) {
  try {return {ok:true,value:operation()};}
  catch(error){return {ok:false,name:error.constructor.name,message:error.message,code:error.code,detailCode:error.detailCode};}
}
test('platform-neutral UTF8 count matches encoder across all UTF16 units, pairs and escaped JSON strings',()=> {
  for(let unit=0;unit<=0xffff;unit++) {
    const text=String.fromCharCode(unit);
    assert.equal(utf8Bytes(text),encoder.encode(text).byteLength);
    assert.equal(utf8Bytes(JSON.stringify(text)),encoder.encode(JSON.stringify(text)).byteLength);
  }
  for(let point=0x10000;point<=0x10ffff;point+=97) {
    const text=String.fromCodePoint(point);assert.equal(utf8Bytes(text),encoder.encode(text).byteLength);
  }
  let seed=12345;
  for(let row=0;row<1000;row++) {
    let text='';for(let col=0;col<64;col++) {seed=(Math.imul(seed,1664525)+1013904223)>>>0;text+=String.fromCharCode(seed&0xffff);}
    assert.equal(utf8Bytes(text),encoder.encode(text).byteLength);
    assert.equal(utf8Bytes(JSON.stringify(text)),encoder.encode(JSON.stringify(text)).byteLength);
  }
});
test('stringify-preserving variants retain exact thresholds, validation failures and serialization effects',async()=> {
  const h=await loadBoundsHarness();let comparisons=0;
  try {
    const factories=[()=>null,()=>-0,()=>true,()=>1e21,()=>1e-7,()=>Number.MAX_VALUE,
      ()=>({control:'\u0000\b\t\n\f\r"\\\u2028\u2029',unicode:'\u00e9\u4e2d\ud83d\ude00\ud800\udfff'}),
      ()=>Object.assign(Object.create(null),{value:'safe'}),()=>[{n:1},2,'x',null],
      ()=>undefined,()=>NaN,()=>Infinity,()=>1n,()=>Symbol('synthetic'),()=>function synthetic(){},
      ()=>{const shared={n:1};return {a:shared,b:shared};},()=>{const obj={};obj.loop=obj;return obj;},
      ()=>new Date('2026-10-03'),()=>new Map(),()=>new Array(2),
      ()=>Object.defineProperty({},'hidden',{value:1}),()=>({[Symbol('key')]:1}),
      ()=>Object.defineProperty({},'field',{enumerable:true,get(){throw Error('getter must not run');}}),
      ()=>{const a=[1];a.extra=1;return a;},()=>{let o=0;for(let i=0;i<14;i++)o={value:o};return o;}];
    for(const factory of factories) for(const limit of [1,4,7,32,256]) for(const name of ['scan','buffer']) {
      const expected=capture(()=>h.variants.oracle(factory(),{maxSerializedBytes:limit}));
      assert.deepEqual(capture(()=>h.variants[name](factory(),{maxSerializedBytes:limit})),expected);comparisons++;
    }
    const pure=[null,-0,42.125,1e21,1e-7,'\ud800\udfff\ud83d\ude00',{a:'\u0000"\\',z:[1,false,null]}];
    for(const value of pure) {
      const bytes=encoder.encode(JSON.stringify(value)).byteLength;
      assert.equal(descriptorJsonBytes(value),bytes);
      for(const limit of [Math.max(1,bytes-1),bytes,bytes+1]) for(const name of ['scan','buffer']) {
        assert.deepEqual(capture(()=>h.variants[name](value,{maxSerializedBytes:limit})),capture(()=>h.variants.oracle(value,{maxSerializedBytes:limit})));comparisons++;
      }
    }
    for(const options of [{maxSerializedBytes:0},{maxDepth:-1},{maxArrayItems:0},{maxDepth:0,maxSerializedBytes:1},{maxArrayItems:1}])
      for(const name of ['scan','buffer']) {
        assert.deepEqual(capture(()=>h.variants[name]({rows:[1,2]},options)),capture(()=>h.variants.oracle({rows:[1,2]},options)));comparisons++;
      }
    for(const effect of ['toJSON','get','arrayToJSON','inheritedAccessor']) for(const limit of [1,20,10000]) {
      const run=name=> {
        const trace=[];let value;
        if(effect!=='get') {
          const prototype=effect==='arrayToJSON'?Array.prototype:Object.prototype;
          const inherited=Object.getOwnPropertyDescriptor(prototype,'toJSON');
          const hook=function(key){trace.push('toJSON:'+key);return 'x'.repeat(100);};
          Object.defineProperty(prototype,'toJSON',effect==='inheritedAccessor'
            ?{configurable:true,get(){trace.push('get:inheritedToJSON');return hook;}}
            :{configurable:true,writable:true,value:hook});
          try {return {result:capture(()=>h.variants[name](effect==='arrayToJSON'?[1]:{n:1},{maxSerializedBytes:limit})),trace};}
          finally {if(inherited===undefined)delete prototype.toJSON;else Object.defineProperty(prototype,'toJSON',inherited);}
        }
        value=new Proxy({n:1},{get(target,key,receiver){trace.push('get:'+String(key));return key==='n'?'x'.repeat(100):Reflect.get(target,key,receiver);}});
        return {result:capture(()=>h.variants[name](value,{maxSerializedBytes:limit})),trace};
      };
      const expected=run('oracle');for(const name of ['scan','buffer']) {assert.deepEqual(run(name),expected);comparisons++;}
      assert.notDeepEqual(run('descriptor'),expected,'descriptor prototype must expose its semantic mismatch');
    }
    // JSON.stringify exceptions and undefined returns still run after the walk.
    for(const result of [undefined,1n,()=>{throw Error('synthetic serialization failure');},()=>{const loop={};loop.loop=loop;return loop;}]) {
      const run=name=> {
        const inherited=Object.prototype.toJSON;let calls=0;
        Object.prototype.toJSON=function(){calls++;return typeof result==='function'?result():result;};
        try {return {result:capture(()=>h.variants[name]({n:1},{maxSerializedBytes:1})),calls};}
        finally {if(inherited===undefined)delete Object.prototype.toJSON;else Object.prototype.toJSON=inherited;}
      };
      const expected=run('oracle');for(const name of ['scan','buffer']) {assert.deepEqual(run(name),expected);comparisons++;}
    }
    assert.equal(comparisons,334);
  }finally{await h.close();}
});
