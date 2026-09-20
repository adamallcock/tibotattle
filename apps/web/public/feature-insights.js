import { createCacheReuseMatrix } from './cache-reuse-matrix.js';
import { mountModelPerformance } from './model-performance.js';
import { formatModelName } from './ui-format.js';

// Isolated, deterministic illustration inputs. No companion or hosted requests.
export function exampleCacheImpact() {
  // The same ten buckets the hosted lane measures, so the illustration cannot
  // show a shape the real curve is incapable of producing.
  const ids=['under_one_minute','one_to_two_minutes','two_to_five_minutes','five_to_ten_minutes','ten_to_thirty_minutes','thirty_minutes_to_one_hour','one_to_two_hours','two_to_six_hours','six_to_twenty_four_hours','over_twenty_four_hours'];
  const edges=[0,60,120,300,600,1800,3600,7200,21600,86400,604800];
  const counts=[1400,620,490,320,240,150,60,30,40,16], rates=[.99,.98,.97,.94,.85,.72,.45,.31,.1,.04];
  const cohort=(model,factor)=>{
    const byOutcomeBucket={};
    ids.forEach((id,i)=>{
      const n=Math.floor(counts[i]*factor),more=Math.floor(n*rates[i]),less=n-more;
      byOutcomeBucket[id]={startSeconds:edges[i],endSeconds:edges[i+1],comparableReturns:n,reusedMoreThanHalfReturns:more,reusedHalfOrLessReturns:less,matchedOrExceededReturns:Math.floor(more*.7),reusedBetweenHalfAndPreviousReturns:more-Math.floor(more*.7),cacheReadDrops:less,lostCacheTokens:less*1000,pricedDrops:less,unpricedDrops:0,coverageStatus:'complete',estimatedPremiumUsd:less*.02};
    });
    const total={model,byOutcomeBucket,coverageStatus:'complete',estimatedPremiumUsd:0};
    for(const row of Object.values(byOutcomeBucket)) for(const key of ['comparableReturns','reusedMoreThanHalfReturns','reusedHalfOrLessReturns','matchedOrExceededReturns','reusedBetweenHalfAndPreviousReturns','cacheReadDrops','lostCacheTokens','pricedDrops','unpricedDrops','estimatedPremiumUsd']) total[key]=(total[key]??0)+row[key];
    return total;
  };
  const models=[cohort('gpt-5.5',.6),cohort('gpt-5.4',.4)];
  const all=cohort('',0);
  for(const id of ids)for(const key of Object.keys(models[0].byOutcomeBucket[id]))if(!['startSeconds','endSeconds','coverageStatus'].includes(key))all.byOutcomeBucket[id][key]=models.reduce((sum,m)=>sum+m.byOutcomeBucket[id][key],0);
  for(const key of Object.keys(models[0]))if(typeof models[0][key]==='number')all[key]=models.reduce((sum,m)=>sum+m[key],0);
  return {...all,status:'available',byModel:models};
}
export function exampleModelSpeeds(period='all') {
  const end=Date.UTC(2026,8,15), days=period==='7'?7:30,start=end-(days-1)*86400000;
  // Fixed illustrative daily observations: uneven samples and independently varying latency.
  // Slice the same history for every period so changing the filter never changes a day's data.
  const activity=[42,67,31,85,56,12,7,49,104,73,38,61,19,9,54,88,126,46,72,14,5,65,97,43,112,58,21,8,76,51];
  const speeds=[62,58,71,47,53,79,66,60,39,51,68,57,74,82,63,48,44,59,70,76,64,55,41,67,50,61,78,69,56,65];
  const latency=[1.4,2.1,1.1,3.8,1.7,.9,1.6,2.3,4.9,2.6,1.3,1.8,1.2,.8,2.7,1.9,3.4,1.5,2.2,1.1,1.8,3.1,2.4,1.2,4.2,1.7,.9,1.4,2.8,1.6];
  return {schemaVersion:2,method:3,status:'ready',collecting:false,stale:false,updatedAt:new Date(end+86400000-1).toISOString(),period,interval:'day',start,end,historyProgress:null,
    models:[['gpt-5.5','GPT-5.5'],['gpt-5.4','GPT-5.4']].map(([id,label],index)=>{
      const history=activity.map((count,i)=>{
        const j=(i+index*9)%30, n=Math.max(3,Math.round(count*(index ? .62 : 1)));
        const at=end-(29-i)*86400000, median=speeds[j]+index*8;
        const spread=[.24,.37,.18,.43,.29,.21,.34][(i+index)%7];
        const speed={at,n,p10:median*(1-spread*1.6),p25:median*(1-spread*.7),median,p75:median*(1+spread),p90:median*(1+spread*1.9)};
        const mid=latency[(i+index*7)%30]*(index ? .85 : 1), measured=Math.max(2,n-1-i%4);
        const ttft={at,n:measured,p10:mid*.32,p25:mid*.64,median:mid,p75:mid*(1.35+spread),p90:mid*(2.1+spread*3)};
        for (const point of [speed,ttft]) if (point.n < 5) {
          for (const key of ['p10','p25','p75','p90']) point[key] = null;
        }
        return {speed,ttft};
      }).slice(-days);
      const speedTurns=history.reduce((n,p)=>n+p.speed.n,0), ttftTurns=history.reduce((n,p)=>n+p.ttft.n,0);
      return {id,label,turns:speedTurns+days*2,speedTurns,ttftTurns,timedResponses:ttftTurns,speed:[{method:'speed',points:history.map(p=>p.speed)}],ttft:history.map(p=>p.ttft)};
    })};
}
export function mountExampleInsights(doc,t,loadHostedCurve) {
  const locale=()=>doc.documentElement.lang||'en-US';
  const container=doc.querySelector('[data-cache-demo]');
  const matrix=createCacheReuseMatrix({container,t,formatNumber:n=>new Intl.NumberFormat(locale()).format(n),formatPercent:n=>new Intl.NumberFormat(locale(),{maximumFractionDigits:1}).format(n)+'%',formatModelName});
  // The illustration renders immediately so the section is never blank, and
  // the measured curve replaces it if and when one arrives. A hosted lane that
  // has published nothing leaves the synthetic demonstration in place, still
  // labelled as one -- it is never relabelled as real.
  let impact=exampleCacheImpact(); matrix.render({impact});
  const demo=doc.querySelector('#cache-demo');
  const label=demo?.querySelector('.insight-demo-label');
  if(typeof loadHostedCurve==='function'){
    Promise.resolve().then(loadHostedCurve).then(curve=>{
      const measured=cacheImpactFromHostedCurve(curve);
      if(!measured||measured.comparableReturns===0)return;
      impact=measured;
      if(label)label.textContent=t('site.features.insightMeasured');
      matrix.render({impact});
    }).catch(()=>{});
  }
  const win=doc.defaultView;
  const localWindow={MutationObserver:win.MutationObserver,setTimeout:win.setTimeout.bind(win),clearTimeout:win.clearTimeout.bind(win),localStorage:{getItem:()=>null,setItem:()=>{}}};
  const speed=mountModelPerformance({root:doc.querySelector('[data-speeds-demo]'),client:{modelPerformance:async period=>exampleModelSpeeds(period)},t,locale,windowRef:localWindow});
  win.addEventListener('tibotattle:locale-change',()=>{matrix.render({impact});speed.render();});
}

/**
 * Map the hosted community cache-retention curve onto the matrix's impact
 * contract.
 *
 * The two vocabularies are the same ten buckets, so this is a rename and a
 * unit change, never a regrouping: nothing is summed, split or interpolated.
 * `reusedMoreThanHalf` and `matchedOrExceeded` arrive as COUNTS for exactly
 * this reason — multiplying a rounded rate back out would invent the numbers
 * the contract then checks add up.
 *
 * What the hosted lane does not measure stays unmeasured. There is no pricing
 * evidence behind a hosted gap, so `coverageStatus` is `incomplete` and
 * `estimatedPremiumUsd` is null rather than zero; `lostCacheTokens` is not
 * observed hosted-side and is not drawn, and the null premium beside it is
 * what stops a reader taking its zero for a finding.
 *
 * Returns null on anything unexpected, so the page falls back rather than
 * rendering a partly trusted curve.
 */
export function cacheImpactFromHostedCurve(curve) {
  if (!curve || typeof curve !== "object" || !Array.isArray(curve.bands)) return null;
  if (curve.measures !== "consecutive_requests") return null;
  const count = (value) => Number.isSafeInteger(value) && value >= 0;
  const byOutcomeBucket = {};
  const totals = { comparableReturns: 0, reusedMoreThanHalfReturns: 0, reusedHalfOrLessReturns: 0,
    matchedOrExceededReturns: 0, reusedBetweenHalfAndPreviousReturns: 0,
    cacheReadDrops: 0, lostCacheTokens: 0, pricedDrops: 0, unpricedDrops: 0 };
  for (const band of curve.bands) {
    if (!band || typeof band.band !== "string"
      || !count(band.adjacencies) || !count(band.reusedMoreThanHalf) || !count(band.matchedOrExceeded)
      || !count(band.startMs) || !count(band.endMs)) return null;
    // The parts have to be consistent at the source. A band whose reused count
    // exceeds its adjacencies, or whose matched count exceeds its reused, is
    // not a rounding artefact to be clamped -- it is evidence something
    // upstream is wrong, and it fails the whole curve.
    if (band.reusedMoreThanHalf > band.adjacencies
      || band.matchedOrExceeded > band.reusedMoreThanHalf) return null;
    const less = band.adjacencies - band.reusedMoreThanHalf;
    const row = {
      startSeconds: band.startMs / 1_000, endSeconds: band.endMs / 1_000,
      comparableReturns: band.adjacencies,
      reusedMoreThanHalfReturns: band.reusedMoreThanHalf,
      reusedHalfOrLessReturns: less,
      matchedOrExceededReturns: band.matchedOrExceeded,
      reusedBetweenHalfAndPreviousReturns: band.reusedMoreThanHalf - band.matchedOrExceeded,
      cacheReadDrops: less, lostCacheTokens: 0, pricedDrops: 0, unpricedDrops: less,
      coverageStatus: "incomplete", estimatedPremiumUsd: null,
    };
    byOutcomeBucket[band.band] = row;
    for (const key of Object.keys(totals)) totals[key] += row[key];
  }
  return { ...totals, byOutcomeBucket, model: "", coverageStatus: "incomplete",
    estimatedPremiumUsd: null, status: "available", byModel: [] };
}
