import { mountTrendsHorizon } from './trends-horizon.js';

// A deterministic illustrative dataset, never passed into dashboard selectors.
export function exampleWeek() {
  const start = Date.UTC(2026,8,7,4), hour = 3600000;
  // Uneven work sessions: deep-work bursts, lunch breaks, late work and a quiet weekend.
  const sessions = [
    [[9,12,52],[14,18,76],[21,23,24]],
    [[8,11,38],[13,17,93]],
    [[10,13,64],[15,19,42],[22,24,58]],
    [[9,12,87],[14,16,35],[20,23,69]],
    [[8,10,31],[11,15,72],[16,18,44]],
    [[11,14,28]],
    [[16,19,46],[21,23,19]],
  ];
  const texture = [.38,.91,.64,1.17,.53,.82,1.08,.46,.72,1.24,.59,.97,.33];
  const resetHour = 81; // Thursday morning, independent of midnight/day boundaries.
  let remaining = 92;
  const points = [];
  for (let i=0;i<=168;i++) {
    const localHour=i%24;
    const session = sessions[Math.min(6, Math.floor(i/24))].find(([from,to])=>localHour>=from&&localHour<to);
    const usage = session ? Math.round(session[2]*texture[(i*7+Math.floor(i/24))%texture.length]*10)/10 : 0;
    if(i===resetHour) remaining=100;
    else if(i) remaining=Math.max(0,remaining-usage/(25+(i%5)*1.8));
    points.push({timestampMs:start+i*hour,periodStartAt:new Date(start+(i-1)*hour).toISOString(),allowanceRemaining:remaining,usage,cycle:i<resetHour?0:1});
  }
  return {points,domain:{startMs:start,endMs:start+168*hour},events:[{timestampMs:start+resetHour*hour,kind:'observed_reset'}]};
}
export function mountExampleWeek(root, t) {
  if (!root) return;
  const doc=root.ownerDocument, data=exampleWeek();
  const money=value=>new Intl.NumberFormat(doc.documentElement.lang,{style:'currency',currency:'USD',maximumFractionDigits:0}).format(value);
  const percent=value=>new Intl.NumberFormat(doc.documentElement.lang,{maximumFractionDigits:0}).format(value)+'%';
  const view=mountTrendsHorizon(root,{t,locale:doc.documentElement.lang,timeZone:'America/New_York',formatMoney:money,formatPercent:percent,formatDuration:()=> '1h'});
  view.setAllowanceSamples(data.points);
  view.setSpendLookup(at=>{const point=data.points[Math.min(168,Math.max(0,Math.floor((at-data.domain.startMs)/3600000)))];return {allowanceWeightedUsd:point.usage,measuredSpanMs:3600000};});
  const svgNode=(tag,attrs,text)=>{const el=doc.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value] of Object.entries(attrs))el.setAttribute(key,value);if(text!=null)el.textContent=text;return el;};
  for(const [id,key,height,max,label,format] of [['allowance-timeline-chart','allowanceRemaining',250,100,t('trends.headerAllowance'),percent],['usage-timeline-chart','usage',130,120,t('trends.headerSpend'),money]]) {
    const width=900,margin={left:42,right:16,top:26,bottom:28};
    const x=p=>margin.left+(p.timestampMs-data.domain.startMs)/(data.domain.endMs-data.domain.startMs)*(width-margin.left-margin.right);
    const y=value=>height-margin.bottom-value/max*(height-margin.top-margin.bottom);
    const shell=root.querySelector('#'+id), svg=svgNode('svg',{viewBox:`0 0 ${width} ${height}`,role:'img','aria-label':label});shell.append(svg);
    for(const tick of [0,max/2,max]) {svg.append(svgNode('line',{x1:margin.left,x2:width-margin.right,y1:y(tick),y2:y(tick),class:'week-grid'}));svg.append(svgNode('text',{x:margin.left-8,y:y(tick)+4,'text-anchor':'end',class:'week-axis'},tick));}
    for(let day=0;day<=7;day++)svg.append(svgNode('text',{x:x({timestampMs:data.domain.startMs+day*86400000}),y:height-6,'text-anchor':day===7?'end':'start',class:'week-axis'},new Intl.DateTimeFormat(doc.documentElement.lang,{weekday:'short',timeZone:'America/New_York'}).format(data.domain.startMs+day*86400000)));
    if(key==='allowanceRemaining') {let path='';data.points.forEach((p,i)=>{path+=(i===0||p.cycle!==data.points[i-1].cycle?'M':'L')+x(p)+','+y(p[key]);});svg.append(svgNode('path',{d:path,fill:'none',stroke:'var(--green-2)','stroke-width':2}));}
    view.register(shell,{svg,points:data.points,series:[{key,label,format,className:'allowance',segmentKey:'cycle',maxGapMs:7200000}],x,y,domain:data.domain,margin,width,height});
  }
  view.setEvents(data.events);view.select(data.domain.startMs+10*3600000);
  doc.defaultView.addEventListener('tibotattle:locale-change',()=>view.refreshLocale(doc.documentElement.lang));
  return view;
}
