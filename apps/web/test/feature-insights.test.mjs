import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheImpactFromHostedCurve, cacheImpactFromHostedWindow, createHostedSpeedLoader, exampleCacheImpact, exampleModelSpeeds, hostedCacheWindow, hostedSpeedPublicationUsable, mountExampleInsights } from '../public/feature-insights.js';
import { cacheReuseMatrixBuckets } from '../public/cache-reuse-matrix.js';
import { normalizeCommunityPerformanceDisplay, normalizeModelPerformance } from '../public/model-performance.js';
import { PUBLIC_ALLOWANCE_MODEL_CONFIG, PublicCommunityClient } from '../public/community-data.js';
import { translate } from '../public/localization.js';
test('synthetic cohorts satisfy the real cache matrix contract and preserve volumes',()=>{
 const impact=exampleCacheImpact(); const rows=cacheReuseMatrixBuckets(impact);
 // Ten buckets, each rendered as measured. The previous vocabulary ended in
 // two day-scale buckets merged back together for display; this one ends in
 // the single bucket the hosted evidence is actually cut into.
 assert.equal(rows.length,10);
 // The last bucket is CLOSED at the seven-day lookback. A null end would claim
 // gaps the lane cannot measure at all.
 assert.equal(rows.at(-1).endSeconds,604_800);
 assert.deepEqual(rows.map(row=>row.id),['under_one_minute','one_to_two_minutes','two_to_five_minutes',
  'five_to_ten_minutes','ten_to_thirty_minutes','thirty_minutes_to_one_hour','one_to_two_hours',
  'two_to_six_hours','six_to_twenty_four_hours','over_twenty_four_hours']);
 // Contiguous and disjoint: each bucket starts where the previous one ends, so
 // no gap is counted twice and none falls between two buckets.
 for(let i=1;i<rows.length;i++)assert.equal(rows[i].startSeconds,rows[i-1].endSeconds);
 assert.equal(rows[0].startSeconds,0);
 assert.equal(impact.byModel.reduce((n,m)=>n+m.comparableReturns,0),impact.comparableReturns);
 for(const model of impact.byModel)assert.equal(cacheReuseMatrixBuckets(model).length,10);
});
test('all example speed periods satisfy the actual closed app contract',()=>{
 for(const period of ['7','30','all']) for(const speedMode of ['standard','fast','ultrafast']) {const payload=exampleModelSpeeds(period,speedMode);assert.equal(normalizeModelPerformance(payload),payload);assert.equal(payload.speedMode,speedMode);if(speedMode!=='standard')assert.deepEqual(payload.models,[]);}
 assert.throws(()=>exampleModelSpeeds('all','priority'),RangeError);
 // The public demo shows the comparison the public page pins, and never names
 // a roster model held back until the served catalog adds it.
 assert.deepEqual(exampleModelSpeeds('all').models.map(model=>model.id),
  PUBLIC_ALLOWANCE_MODEL_CONFIG.filter(model=>model.pinned).map(model=>model.modelId));
 assert.ok(!JSON.stringify(exampleModelSpeeds('all')).includes('gpt-6.1-sol'));
 assert.ok(!JSON.stringify(exampleModelSpeeds('all')).includes('GPT-6.1 Sol'));
});
test('changing period preserves the same daily observations and varying sample sizes',()=>{
 const week=exampleModelSpeeds('7'),month=exampleModelSpeeds('30');
 for(let i=0;i<week.models.length;i++) {
  assert.deepEqual(week.models[i].speed[0].points,month.models[i].speed[0].points.slice(-7));
  assert.deepEqual(week.models[i].ttft,month.models[i].ttft.slice(-7));
  assert.ok(new Set(month.models[i].speed[0].points.map(p=>p.n)).size>10);
 }
});

const hostedBand=(band,startMs,endMs,adjacencies,reused,matched)=>({band,startMs,endMs,adjacencies,
 reusedMoreThanHalf:reused,matchedOrExceeded:matched,sessions:1,contributors:1,
 reusedMoreThanHalfRate:adjacencies?reused/adjacencies:null,
 matchedOrExceededRate:adjacencies?matched/adjacencies:null,
 topContributorShare:adjacencies?1:null,excludedInsufficientEvidence:0,
 excludedContextContracted:0,unorderedTies:0});
const hostedCurve=(overrides={})=>({schemaVersion:'community-cache-retention-v1.0',
 metric:'cache_retention_by_pause',methodVersion:'cache-retention-v2',
 measures:'consecutive_requests',gapBasis:'response_end_to_response_end',
 bands:[[0,60_000,100,99,70],[60_000,120_000,50,49,30],[120_000,300_000,40,38,20],
  [300_000,600_000,30,28,14],[600_000,1_800_000,20,13,6],[1_800_000,3_600_000,10,7,3],
  [3_600_000,7_200_000,8,4,2],[7_200_000,21_600_000,6,2,1],
  [21_600_000,86_400_000,4,1,0],[86_400_000,604_800_000,0,0,0]]
  .map(([startMs,endMs,n,more,matched],index)=>hostedBand(
   ['under_one_minute','one_to_two_minutes','two_to_five_minutes','five_to_ten_minutes',
    'ten_to_thirty_minutes','thirty_minutes_to_one_hour','one_to_two_hours','two_to_six_hours',
    'six_to_twenty_four_hours','over_twenty_four_hours'][index],startMs,endMs,n,more,matched)),
 ...overrides});

test('the hosted curve maps onto the matrix contract without inventing a number',()=>{
 const impact=cacheImpactFromHostedCurve(hostedCurve());
 // The real renderer accepting it IS the assertion: every sum, every boundary
 // and every disjointness rule in `cacheReuseMatrixBuckets` has to hold.
 const rows=cacheReuseMatrixBuckets(impact);
 assert.equal(rows.length,10);
 assert.equal(rows.at(-1).endSeconds,604_800);
 // A rename and a unit change, never a regrouping: the band a gap was measured
 // in is the band it is drawn in.
 assert.equal(rows[0].comparableReturns,100);
 assert.equal(rows[0].reusedMoreThanHalfReturns,99);
 assert.equal(rows[6].startSeconds,3_600);
 assert.equal(rows[6].endSeconds,7_200);
 // An empty band stays empty rather than borrowing from its neighbour.
 assert.equal(rows.at(-1).comparableReturns,0);
 // Nothing the hosted lane cannot see is claimed: no pricing evidence exists
 // behind a hosted gap, so the premium is absent rather than zero.
 assert.equal(impact.estimatedPremiumUsd,null);
 assert.equal(impact.coverageStatus,'incomplete');
});

test('an inconsistent or foreign hosted curve is refused rather than clamped',()=>{
 assert.equal(cacheImpactFromHostedCurve(null),null);
 assert.equal(cacheImpactFromHostedCurve({bands:[]}),null);
 // Turn-scoped evidence would be a different measurement wearing the same
 // shape, and must never be drawn under this caption.
 assert.equal(cacheImpactFromHostedCurve(hostedCurve({measures:'user_turns'})),null);
 // Parts that cannot add up are an upstream fault, not a rounding artefact:
 // clamping them would publish a figure nothing measured.
 const overReused=hostedCurve();
 overReused.bands[0]={...overReused.bands[0],reusedMoreThanHalf:101};
 assert.equal(cacheImpactFromHostedCurve(overReused),null);
 const overMatched=hostedCurve();
 overMatched.bands[0]={...overMatched.bands[0],matchedOrExceeded:100};
 assert.equal(cacheImpactFromHostedCurve(overMatched),null);
});

const hostedSeries=(overrides={})=>({measures:'consecutive_requests',
 windows:[{window:'all',days:null,modelsTruncated:false,bands:hostedCurve().bands,
  byModel:[{model:'gpt-5.6-sol',bands:hostedCurve().bands},
   {model:'gpt-5.6-terra',bands:hostedCurve().bands}]},
  {window:'week',days:7,modelsTruncated:false,
   bands:hostedCurve().bands.map(b=>({...b,adjacencies:0,reusedMoreThanHalf:0,matchedOrExceeded:0})),
   byModel:[]}],
 ...overrides});

test('a window is selected by name and never silently substituted',()=>{
 const series=hostedSeries();
 assert.equal(hostedCacheWindow(series,'all').window,'all');
 // A span the series does not carry returns null rather than another span:
 // a reader who chose 7 days must never be shown all time under that label.
 assert.equal(hostedCacheWindow(series,'month'),null);
 assert.equal(hostedCacheWindow({measures:'user_turns',windows:[]},'all'),null);
 assert.equal(hostedCacheWindow(null,'all'),null);
});

test('per-model cohorts go through the same contract as the pooled figure',()=>{
 const impact=cacheImpactFromHostedWindow(hostedCacheWindow(hostedSeries(),'all'));
 assert.equal(cacheReuseMatrixBuckets(impact).length,10);
 assert.deepEqual(impact.byModel.map(m=>m.model),['gpt-5.6-sol','gpt-5.6-terra']);
 // A cohort has to satisfy the whole contract, not a weaker one.
 for(const cohort of impact.byModel)assert.equal(cacheReuseMatrixBuckets(cohort).length,10);
 // A cohort that cannot be mapped is dropped; the pooled curve is still true
 // and the picker simply will not offer that model.
 const broken=hostedSeries();
 broken.windows[0].byModel[1].bands=broken.windows[0].byModel[1].bands.map(
  (b,i)=>i===0?{...b,reusedMoreThanHalf:b.adjacencies+1}:b);
 const partial=cacheImpactFromHostedWindow(hostedCacheWindow(broken,'all'));
 assert.deepEqual(partial.byModel.map(m=>m.model),['gpt-5.6-sol']);
 assert.ok(partial.comparableReturns>0);
 // An empty window maps to zero rather than to null, so the caller can say
 // "nothing measured in this period" instead of falling back to another.
 const empty=cacheImpactFromHostedWindow(hostedCacheWindow(hostedSeries(),'week'));
 assert.equal(empty.comparableReturns,0);
});

// ---------------------------------------------------------------------------
// Hosted swap of the model-speed demonstration. The fixtures are plain
// literals (a community-model-performance-v1 wire body and the error bodies
// the origin and edge answer with) so the edge line can copy them verbatim.
function speedWireBody() {
 return {
  schemaVersion:'community-model-performance-v1',methodVersion:'performance-histogram-pool-type7-bounds-v1',
  population:'reported_samples',approximate:true,revision:2,generatedAt:'2026-10-11T03:05:00.000Z',
  period:'all',interval:'week',start:'2026-09-01',end:'2026-10-10',speedMode:'standard',
  excludedUnknownTurns:1,contributors:3,devices:4,reports:7,
  models:[
   {provider:'openai_codex',modelId:'gpt-5.6-sol',turns:12,speedTurns:11,ttftTurns:9,timedResponses:14,toolFreeTurns:1,
    contributors:2,devices:3,
    speed:{unit:'tokens_per_second',points:[
     {day:'2026-08-31',n:6,unresolved:1,
      p10:{estimate:40,lower:35,upper:45},p25:{estimate:50,lower:46,upper:55},median:{estimate:62,lower:58,upper:66},
      p75:{estimate:70,lower:66,upper:80},p90:{estimate:90,lower:80,upper:130}},
     {day:'2026-10-05',n:5,unresolved:0,
      p10:{estimate:42,lower:36,upper:47},p25:{estimate:51,lower:47,upper:56},median:{estimate:60,lower:57,upper:64},
      p75:{estimate:69,lower:65,upper:79},p90:{estimate:88,lower:79,upper:120}}]},
    ttft:{unit:'milliseconds',points:[
     {day:'2026-08-31',n:5,unresolved:0,
      p10:{estimate:800,lower:700,upper:900},p25:{estimate:1000,lower:900,upper:1100},median:{estimate:1200,lower:1100,upper:1400},
      p75:{estimate:1600,lower:1400,upper:1800},p90:{estimate:2400,lower:1800,upper:3000}},
     {day:'2026-10-05',n:4,unresolved:0,
      p10:null,p25:null,median:{estimate:1500,lower:1300,upper:1900},p75:null,p90:null}]}},
   {provider:'openai_codex',modelId:'gpt-synthetic-unlisted',turns:5,speedTurns:0,ttftTurns:0,timedResponses:0,toolFreeTurns:0,
    contributors:1,devices:1,speed:{unit:'tokens_per_second',points:[]},ttft:{unit:'milliseconds',points:[]}}],
 };
}
const unpublishedBody={error:{code:'COMMUNITY_MODEL_PERFORMANCE_UNPUBLISHED',message:'Not published.'}};
const unknownRouteBody={error:{code:'NOT_FOUND',message:'Not found.'}};
const unavailableBody={error:{code:'SERVICE_UNAVAILABLE',message:'Unavailable.'}};
const SPEED_PATH='/api/v1/community/model-performance?period=all&speedMode=standard';

// One fake fetch: answers by exact path and records every request.
function publicFetch(answers) {
 const calls=[];
 const fetchImpl=async (path,options)=>{
  calls.push({path,options});
  const answer=answers[path] ?? {status:404,body:unknownRouteBody};
  if(answer instanceof Error)throw answer;
  return {ok:answer.status>=200&&answer.status<300,status:answer.status,json:async ()=>{
   if(answer.body===undefined)throw new SyntaxError('no body');
   return structuredClone(answer.body);
  }};
 };
 return {calls,client:new PublicCommunityClient({fetchImpl})};
}

test('the hosted speed loader requests one closed slot through the shared public client',async ()=>{
 const {calls,client}=publicFetch({[SPEED_PATH]:{status:200,body:speedWireBody()}});
 const load=createHostedSpeedLoader(client);
 const signal=new AbortController().signal;
 const result=await load('all',{signal,speedMode:'standard'});
 assert.deepEqual(calls.map(call=>call.path),[SPEED_PATH]);
 assert.deepEqual(calls[0].options,{headers:{Accept:'application/json'},cache:'no-cache',signal});
 assert.equal(result.state,'published');
 assert.equal(hostedSpeedPublicationUsable(result),true);
 // Without a signal the request carries no signal key at all.
 await load('all',{speedMode:'standard'});
 assert.deepEqual(calls[1].options,{headers:{Accept:'application/json'},cache:'no-cache'});
 // Both parameters are closed: nothing else from the caller reaches the URL.
 const refused=await load('365',{speedMode:'standard'});
 assert.equal(refused.state,'unsupported_schema');
 assert.equal(calls.length,2,'an unsupported slot is never requested');
 assert.throws(()=>createHostedSpeedLoader({}),TypeError);
});

test('the hosted speed adapter maps a publication: seconds, Monday weeks, end of day, omitted models counted',async ()=>{
 const {client}=publicFetch({[SPEED_PATH]:{status:200,body:speedWireBody()}});
 const result=await createHostedSpeedLoader(client)('all',{speedMode:'standard'});
 // The model the public catalog cannot name is validated, dropped and counted.
 assert.deepEqual(result.models.map(model=>[model.modelId,model.label]),[['gpt-5.6-sol','GPT-5.6 Sol']]);
 assert.deepEqual(result.omittedModels,{models:1,turns:5});
 const display=normalizeCommunityPerformanceDisplay(result);
 assert.equal(display.interval,'week');
 assert.equal(display.start,Date.UTC(2026,8,1));
 assert.equal(display.end,Date.UTC(2026,9,11)-1,'the window ends at the last millisecond of its final UTC day');
 const [model]=display.models;
 // Week bins are named by their Monday, and the first may begin before the window.
 assert.deepEqual(model.speed.map(point=>point.at),[Date.UTC(2026,7,31),Date.UTC(2026,9,5)]);
 for(const point of [...model.speed,...model.ttft])assert.equal(new Date(point.at).getUTCDay(),1);
 assert.deepEqual(model.speed[0].median,{estimate:62,lower:58,upper:66});
 assert.equal(model.unresolved,1);
 // First-token latency arrives in milliseconds and is shown in seconds, bounds included.
 assert.deepEqual(model.ttft[0].median,{estimate:1.2,lower:1.1,upper:1.4});
 assert.deepEqual(model.ttft[1],{at:Date.UTC(2026,9,5),n:4,unresolved:0,p10:null,p25:null,
  median:{estimate:1.5,lower:1.3,upper:1.9},p75:null,p90:null});
 assert.deepEqual(display.evidence.omittedModels,{models:1,turns:5});
 assert.equal(display.evidence.samples,17);
});

test('the hosted speed loader keeps unpublished, unavailable, unreadable and cancelled answers distinct',async ()=>{
 const answer=async (entry)=>createHostedSpeedLoader(publicFetch({[SPEED_PATH]:entry}).client)('all',{speedMode:'standard'});
 assert.equal((await answer({status:404,body:unpublishedBody})).state,'none_published');
 // A route neither the origin nor the edge knows yet reads as unpublished too.
 assert.equal((await answer({status:404,body:unknownRouteBody})).state,'none_published');
 assert.equal((await answer({status:503,body:unavailableBody})).state,'service_unavailable');
 assert.equal((await answer({status:503})).state,'service_unavailable');
 assert.equal((await answer(new TypeError('offline'))).state,'service_unavailable');
 assert.equal((await answer({status:200,body:{...speedWireBody(),schemaVersion:'community-model-performance-v0'}})).state,'unsupported_schema');
 assert.equal((await answer({status:200,body:{...speedWireBody(),period:'7'}})).state,'unsupported_schema','another slot is refused');
 assert.equal((await answer({status:200,body:null})).state,'service_unavailable');
 const controller=new AbortController();
 const aborted=Object.assign(new Error('aborted'),{name:'AbortError'});
 const fetchImpl=async ()=>{controller.abort();throw aborted;};
 await assert.rejects(createHostedSpeedLoader(new PublicCommunityClient({fetchImpl}))('all',{signal:controller.signal,speedMode:'standard'}),
  error=>error===aborted,'a cancelled request is not reported as a failure');
});

test('only a published slot that names a model can replace the demonstration',async ()=>{
 const {client}=publicFetch({[SPEED_PATH]:{status:200,body:speedWireBody()}});
 const published=await createHostedSpeedLoader(client)('all',{speedMode:'standard'});
 assert.equal(hostedSpeedPublicationUsable(published),true);
 assert.equal(hostedSpeedPublicationUsable({...published,models:[]}),false,'nothing nameable was measured');
 assert.equal(hostedSpeedPublicationUsable({...published,period:'7'}),false);
 assert.equal(hostedSpeedPublicationUsable({...published,speedMode:'fast'}),false);
 assert.equal(hostedSpeedPublicationUsable(speedWireBody()),false,'a raw body is never trusted');
 for(const state of ['none_published','service_unavailable','unsupported_schema'])
  assert.equal(hostedSpeedPublicationUsable({state,period:'all',speedMode:'standard',models:[],omittedModels:null}),false);
 assert.equal(hostedSpeedPublicationUsable(null),false);
});

// Tiny DOM boundary for the tour: enough of a document for the real cache
// matrix and the real model-performance view to render into, with timers that
// never fire by themselves so no request happens behind the test's back.
class TourElement {
 constructor(tag,doc){
  this.tagName=tag.toUpperCase();this.ownerDocument=doc;this.children=[];this.parent=null;
  this.attributes={};this.dataset={};this.listeners={};this.hidden=false;this._text='';this.className='';this.id='';
  this.style={setProperty(){},removeProperty(){}};
  const names=()=>this.className.split(' ').filter(Boolean);
  this.classList={contains:name=>names().includes(name),add:(...more)=>{this.className=[...new Set([...names(),...more])].join(' ');},
   remove:(...less)=>{this.className=names().filter(name=>!less.includes(name)).join(' ');},
   toggle:(name,force)=>{const on=force??!names().includes(name);on?this.classList.add(name):this.classList.remove(name);return on;}};
 }
 set textContent(value){this._text=String(value);for(const child of this.children)child.parent=null;this.children=[];}
 get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
 setAttribute(key,value){this.attributes[key]=String(value);if(key==='class')this.className=String(value);if(key==='id')this.id=String(value);}
 getAttribute(key){return Object.hasOwn(this.attributes,key)?this.attributes[key]:null;}
 hasAttribute(key){return Object.hasOwn(this.attributes,key);}
 removeAttribute(key){delete this.attributes[key];}
 append(...nodes){for(const node of nodes){if(typeof node==='string'){this._text+=node;continue;}node.parent?.removeChild(node);node.parent=this;this.children.push(node);}}
 prepend(...nodes){const rest=this.children;this.children=[];this.append(...nodes);this.children.push(...rest);}
 insertBefore(node,before){node.parent?.removeChild(node);const index=this.children.indexOf(before);node.parent=this;if(index<0)this.children.push(node);else this.children.splice(index,0,node);return node;}
 removeChild(node){this.children=this.children.filter(child=>child!==node);node.parent=null;return node;}
 remove(){this.parent?.removeChild(this);}
 replaceChildren(...nodes){this._text='';for(const child of this.children)child.parent=null;this.children=[];this.append(...nodes);}
 addEventListener(type,listener){(this.listeners[type]??=[]).push(listener);}
 removeEventListener(type,listener){this.listeners[type]=(this.listeners[type]??[]).filter(item=>item!==listener);}
 dispatch(type,event={}){for(const listener of this.listeners[type]??[])listener(event);}
 contains(node){return node===this||this.children.some(child=>child.contains(node));}
 focus(){this.ownerDocument.activeElement=this;}
 blur(){}
 getBoundingClientRect(){return {left:0,top:0,width:800,height:256,right:800,bottom:256};}
 all(){return this.children.flatMap(child=>[child,...child.all()]);}
 matches(selector){
  if(selector.startsWith('#'))return this.id===selector.slice(1);
  if(selector.startsWith('.'))return this.classList.contains(selector.slice(1));
  const attribute=selector.match(/^\[([a-z0-9-]+)\]$/u)?.[1];
  if(!attribute)throw new Error(`unsupported selector ${selector}`);
  const data=attribute.startsWith('data-')?attribute.slice(5).replace(/-([a-z])/gu,(_,c)=>c.toUpperCase()):null;
  return this.hasAttribute(attribute)||(data!==null&&this.dataset[data]!==undefined);
 }
 querySelectorAll(selector){return this.all().filter(node=>node.matches(selector));}
 querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
 closest(selector){for(let node=this;node;node=node.parent)if(node.matches(selector))return node;return null;}
}
function tourDocument(){
 const timers=new Map();let nextTimer=0;
 const windowListeners={};
 const win={
  setTimeout:(callback,delay)=>{const id=++nextTimer;timers.set(id,{callback,delay});return id;},
  clearTimeout:id=>{timers.delete(id);},
  MutationObserver:class{observe(){}disconnect(){}},
  addEventListener:(type,listener)=>{(windowListeners[type]??=[]).push(listener);},
  removeEventListener(){},
  dispatch:(type,event={})=>{for(const listener of windowListeners[type]??[])listener(event);},
 };
 const doc={hidden:false,activeElement:null,defaultView:win,documentElement:{lang:'en-US'},
  addEventListener(){},removeEventListener(){}};
 doc.createElement=tag=>new TourElement(tag,doc);
 doc.createElementNS=(_,tag)=>new TourElement(tag,doc);
 const body=doc.createElement('body');
 doc.querySelector=selector=>body.querySelector(selector);
 doc.querySelectorAll=selector=>body.querySelectorAll(selector);
 const section=(id,key,mountAttribute)=>{
  const demo=doc.createElement('section');demo.setAttribute('id',id);demo.setAttribute('class','insight-demo');
  const label=doc.createElement('p');label.setAttribute('class','insight-demo-label');label.setAttribute('data-i18n',key);
  label.textContent=translate(key,{},'en-US');
  const mount=doc.createElement('div');mount.setAttribute(mountAttribute,'');
  demo.append(label,mount);body.append(demo);
  return {demo,label,mount};
 };
 const cache=section('cache-demo','site.features.insightExample','data-cache-demo');
 const speeds=section('speeds-demo','site.features.insightExample','data-speeds-demo');
 const t=(key,values)=>translate(key,values,doc.documentElement.lang);
 // What the page's localizer does on a language change: every element that
 // carries a key is re-rendered from that key in the new language.
 const changeLocale=(lang)=>{
  doc.documentElement.lang=lang;
  win.dispatch('tibotattle:locale-change',{detail:{locale:lang}});
  for(const node of body.querySelectorAll('[data-i18n]'))node.textContent=translate(node.getAttribute('data-i18n'),{},lang);
 };
 return {doc,win,t,cache,speeds,changeLocale,timers};
}
const tourSettle=async ()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
const synthetic=(tour)=>tour.speeds.mount.dataset.performanceSource===undefined
 &&tour.speeds.label.getAttribute('data-i18n')==='site.features.insightExample'
 &&tour.speeds.label.textContent===translate('site.features.insightExample',{},tour.doc.documentElement.lang);

test('the tour keeps the labelled synthetic demonstration on 404, 503, unreadable, empty or failed answers',async ()=>{
 const emptyBody={...speedWireBody(),models:[speedWireBody().models[1]]};
 for(const [name,entry] of [
  ['unpublished',{status:404,body:unpublishedBody}],
  ['unknown route',{status:404,body:unknownRouteBody}],
  ['unavailable',{status:503,body:unavailableBody}],
  ['invalid payload',{status:200,body:{...speedWireBody(),approximate:false}}],
  ['mismatched slot',{status:200,body:{...speedWireBody(),speedMode:'fast'}}],
  ['nothing nameable',{status:200,body:emptyBody}],
  ['network error',new TypeError('offline')],
 ]){
  const tour=tourDocument();
  const {calls,client}=publicFetch({[SPEED_PATH]:entry});
  mountExampleInsights(tour.doc,tour.t,undefined,createHostedSpeedLoader(client));
  await tourSettle();
  assert.deepEqual(calls.map(call=>call.path),[SPEED_PATH],`${name}: one probe, nothing else`);
  assert.ok(synthetic(tour),`${name}: the demonstration stays and stays labelled`);
  assert.ok(tour.speeds.mount.children.length>0,`${name}: the demonstration is still rendered`);
 }
 // A loader that throws synchronously is a failure like any other.
 const tour=tourDocument();
 mountExampleInsights(tour.doc,tour.t,undefined,()=>{throw new Error('synthetic failure');});
 await tourSettle();
 assert.ok(synthetic(tour));
 // No loader at all is the offline page: the demonstration, and no request.
 const offline=tourDocument();
 mountExampleInsights(offline.doc,offline.t);
 await tourSettle();
 assert.ok(synthetic(offline));
});

test('a valid publication replaces the demonstration with the measured view, lazily and once',async ()=>{
 const tour=tourDocument();
 const {calls,client}=publicFetch({[SPEED_PATH]:{status:200,body:speedWireBody()},
  '/api/v1/community/model-performance?period=7&speedMode=standard':{status:404,body:unpublishedBody}});
 mountExampleInsights(tour.doc,tour.t,undefined,createHostedSpeedLoader(client));
 await tourSettle();
 assert.equal(tour.speeds.mount.dataset.performanceSource,'community');
 assert.equal(tour.speeds.label.getAttribute('data-i18n'),'site.features.speedMeasured');
 assert.equal(tour.speeds.label.textContent,translate('site.features.speedMeasured',{},'en-US'));
 // The probe answer is the measured view's first slot: one request in total.
 assert.deepEqual(calls.map(call=>call.path),[SPEED_PATH]);
 const status=()=>tour.speeds.mount.all().find(node=>node.className==='performance-status');
 assert.ok(tour.speeds.mount.all().some(node=>node.id==='performance-model-panel'),'the measured chart renders');
 // Another period is requested only when a reader selects it.
 const focus=key=>tour.speeds.mount.all().find(node=>node.dataset.performanceFocus===key);
 focus('period-7').dispatch('click');
 await tourSettle();
 assert.deepEqual(calls.map(call=>call.path),[SPEED_PATH,'/api/v1/community/model-performance?period=7&speedMode=standard']);
 assert.equal(status().dataset.state,'none');
 // Returning to the probed slot within the cadence reuses it instead of asking again.
 focus('period-all').dispatch('click');
 await tourSettle();
 assert.equal(calls.length,2);
 // The only pending refresh is the view's own, inside the 300 s cadence.
 const refreshes=[...tour.timers.values()].map(timer=>timer.delay).filter(delay=>delay>=60_000);
 assert.equal(refreshes.length,1);
 assert.ok(refreshes[0]<=300_000&&refreshes[0]>290_000,`refresh after ${refreshes[0]} ms`);
});

test('the measured speed and cache labels survive a locale change',async ()=>{
 const tour=tourDocument();
 const {client}=publicFetch({[SPEED_PATH]:{status:200,body:speedWireBody()}});
 mountExampleInsights(tour.doc,tour.t,async ()=>hostedSeries(),createHostedSpeedLoader(client));
 await tourSettle();
 assert.equal(tour.cache.label.getAttribute('data-i18n'),'site.features.insightMeasured');
 assert.equal(tour.speeds.label.getAttribute('data-i18n'),'site.features.speedMeasured');
 for(const lang of ['es','zh-Hans','en-US']){
  tour.changeLocale(lang);
  assert.equal(tour.cache.label.textContent,translate('site.features.insightMeasured',{},lang),`${lang}: cache stays measured`);
  assert.equal(tour.speeds.label.textContent,translate('site.features.speedMeasured',{},lang),`${lang}: speeds stay measured`);
  assert.equal(tour.speeds.mount.dataset.performanceSource,'community');
 }
 // A demonstration keeps its own key, so a language change cannot promote it.
 const demo=tourDocument();
 mountExampleInsights(demo.doc,demo.t,async ()=>null,createHostedSpeedLoader(publicFetch({}).client));
 await tourSettle();
 demo.changeLocale('es');
 assert.equal(demo.cache.label.textContent,translate('site.features.insightExample',{},'es'));
 assert.ok(synthetic(demo));
});

test('the synthetic demonstration answers every mode it offers, Ultrafast included',async ()=>{
 const tour=tourDocument();
 mountExampleInsights(tour.doc,tour.t);
 await tourSettle();
 const nodes=()=>tour.speeds.mount.all();
 const focus=key=>nodes().find(node=>node.dataset.performanceFocus===key);
 const status=()=>nodes().find(node=>node.className==='performance-status');
 for(const mode of ['standard','fast','ultrafast'])assert.ok(focus(`mode-${mode}`),`the demonstration offers ${mode}`);
 // Every mode button the view offers must be answerable by the demo: a refused
 // mode would reject and render the view's failure state with a retry button.
 for(const mode of ['ultrafast','fast','standard']){
  focus(`mode-${mode}`).dispatch('click');
  await tourSettle();
  assert.equal(focus(`mode-${mode}`).getAttribute('aria-pressed'),'true');
  assert.notEqual(status()?.dataset.state,'error',`${mode} renders, not a failure`);
  assert.equal(focus('retry'),undefined,`${mode} offers no retry`);
 }
 assert.ok(synthetic(tour),'the demonstration stays labelled');
});
