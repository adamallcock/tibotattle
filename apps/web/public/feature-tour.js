import { drawAllowanceTank } from "./allowance-tank-renderer.js";
import { createTankMotion } from "./allowance-tanks.js";

/** Playback is decorative: poster-first, visible-only, and motion-preference aware. */
export function wireFeaturePreviews(root = document, environment = window, translate = (key) => key) {
  const motion = environment.matchMedia('(prefers-reduced-motion: reduce)');
  const cleanups = [];
  const refreshers = [];
  for (const figure of root.querySelectorAll('[data-feature-preview]')) {
    const video = figure.querySelector('video');
    const button = figure.querySelector('[data-preview-toggle]');
    let visible = false;
    let userChoice = null;
    let failed = false;
    const label = () => {
      const key = video.paused ? 'site.features.play' : 'site.features.pause';
      button.dataset.i18n = key;
      button.textContent = translate(key);
    };
    const refresh = () => {
      const allowed = userChoice ?? !motion.matches;
      if (visible && !root.hidden && allowed && !failed) {
        const result = video.play();
        result?.catch((error) => {
          if (error.name !== "AbortError") failed = true;
          label();
        });
      } else {
        video.pause();
      }
      label();
    };
    const toggle = () => {
      userChoice = video.paused;
      failed = false;
      refresh();
    };
    const observer = new environment.IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      refresh();
    }, { threshold: 0.15 });
    observer.observe(figure);
    button.hidden = false;
    button.addEventListener('click', toggle);
    video.addEventListener('play', label);
    video.addEventListener('pause', label);
    motion.addEventListener('change', refresh);
    refreshers.push(refresh);
    cleanups.push(() => {
      observer.disconnect();
      button.removeEventListener('click', toggle);
      video.removeEventListener('play', label);
      video.removeEventListener('pause', label);
      motion.removeEventListener('change', refresh);
      video.pause();
    });
    label();
  }
  const refreshAll = () => refreshers.forEach((refresh) => refresh());
  root.addEventListener('visibilitychange', refreshAll);
  return () => {
    root.removeEventListener('visibilitychange', refreshAll);
    cleanups.forEach((cleanup) => cleanup());
  };
}

/** Isolated illustration, with no connection to personal or community data. */
export function wirePaceDemo(root = document, translate = (key) => key) {
  const demo = root.querySelector('[data-pace-demo]');
  if (!demo) return;
  const painting = mountDemoTank(demo, root);
  const verdict = demo.querySelector('[data-demo-verdict]');
  const buttons = [...demo.querySelectorAll('[data-demo-pace]')];
  for (const button of buttons) button.addEventListener('click', () => {
    const pace = button.dataset.demoPace;
    if (!['under', 'over', 'way'].includes(pace)) return;
    demo.dataset.pace = pace;
    painting?.sync();
    renderDemoForecast(demo, translate);
    for (const choice of buttons) choice.setAttribute('aria-pressed', String(choice === button));
    verdict.dataset.i18n = `site.features.${pace}Copy`;
    verdict.textContent = translate(verdict.dataset.i18n);
  });
  verdict.dataset.i18n = `site.features.${demo.dataset.pace}Copy`;
  verdict.textContent = translate(verdict.dataset.i18n);
  renderDemoForecast(demo, translate);
  root.defaultView?.addEventListener('tibotattle:locale-change', () => renderDemoForecast(demo, translate));
  const motion = demo.querySelector('[data-demo-motion]');
  motion.addEventListener('click', () => {
    const paused = demo.dataset.paused !== 'true';
    demo.dataset.paused = String(paused);
    painting?.sync();
    renderDemoForecast(demo, translate);
    motion.setAttribute('aria-pressed', String(paused));
    motion.dataset.i18n = paused ? 'site.features.play' : 'site.features.pause';
    motion.textContent = translate(motion.dataset.i18n);
  });
}

// Website-only inputs and lifecycle; drawing and frame scheduling are the app's.
function mountDemoTank(demo, doc) {
  const view = doc.defaultView;
  if (!view) return null;
  const canvas = demo.querySelector('canvas');
  const reduced = view.matchMedia('(prefers-reduced-motion: reduce)');
  let visible = false, time = 0;
  const palettes = {
    under: ['rgb(40, 200, 157)', 'rgb(163, 255, 206)', 'rgb(18, 102, 78)'],
    over: ['rgb(255, 183, 63)', 'rgb(255, 230, 168)', 'rgb(176, 104, 22)'],
    way: ['rgb(255, 101, 75)', 'rgb(255, 210, 140)', 'rgb(173, 37, 56)'],
  };
  function paint(stamp = time) {
    time = stamp;
    const width = canvas.clientWidth;
    if (!width) return;
    const dpr = Math.min(view.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width*dpr) || canvas.height !== Math.round(418*dpr)) {
      canvas.width = Math.round(width*dpr); canvas.height = Math.round(418*dpr);
    }
    const [fluid, glow, deep] = palettes[demo.dataset.pace];
    drawAllowanceTank(canvas, { remaining:33, pace:{under:0.6,over:1.5,way:10}[demo.dataset.pace], time, width, dpr,
      colors:{ bg:'rgb(16, 43, 36)', panel:'rgb(25, 50, 40)', ink:'rgb(240, 246, 235)', muted:'rgb(163, 191, 176)',
        edge:'rgb(86, 117, 104)', metal:'rgb(51, 78, 66)', bright:'rgb(188, 235, 209)', shadow:'rgb(0, 11, 7)', fluid, glow, deep } });
  }
  const motion = createTankMotion({request:fn=>view.requestAnimationFrame(fn),cancel:id=>view.cancelAnimationFrame(id),
    draw:paint,active:()=>visible && !doc.hidden && !reduced.matches && demo.dataset.paused !== 'true'});
  const sync = () => { paint(); motion.sync(); };
  const observer = new view.IntersectionObserver(([entry])=>{visible=entry.isIntersecting;sync();});
  observer.observe(canvas);
  const resize = new view.ResizeObserver(sync); resize.observe(canvas);
  doc.addEventListener('visibilitychange',sync);
  reduced.addEventListener('change',sync);
  view.addEventListener('pagehide',()=>motion.sync());
  view.addEventListener('pageshow',sync);
  sync();
  return {sync};
}

export function demoForecastScenario(pace) {
  const ratio = {under:0.6,over:1.5,way:10}[pace] ?? 0.6;
  const resetHours = 140, coveredHours = Math.min(resetHours, resetHours / ratio);
  return {ratio,resetHours,coveredHours,dryHours:resetHours-coveredHours};
}
function renderDemoForecast(demo, t) {
  const card = demo.querySelector('[data-demo-forecast]');
  if (!card?.classList) return;
  const scenario = demoForecastScenario(demo.dataset.pace);
  const duration = hours => { const whole=Math.floor(hours); return whole>=24 ? `${Math.floor(whole/24)}d ${whole%24}h` : `${whole}h`; };
  const dry = scenario.dryHours > 0;
  const set = (selector,value) => {card.querySelector(selector).textContent=value;};
  card.classList.toggle('is-over-pace',dry); card.classList.toggle('is-critical',scenario.ratio>=2);
  set('[data-forecast-badge]',t(`site.features.${demo.dataset.pace}`));
  set('[data-forecast-title]',t(dry?'site.features.headline':'site.features.spare',{duration:duration(scenario.coveredHours)}));
  set('[data-forecast-copy]',dry?t('site.features.forecastCopy',{ratio:scenario.ratio,gap:duration(scenario.dryHours)}):t('site.features.underCopy'));
  set('[data-forecast-gap]',t(dry?'site.features.dry':'site.features.until',{duration:duration(scenario.dryHours)}));
  const share = `${scenario.coveredHours/scenario.resetHours*100}%`;
  const track=card.querySelector('[data-forecast-track]'); track.style.setProperty('--pace-covered',share);
  track.classList.toggle('is-edge',scenario.coveredHours/scenario.resetHours<.22 || !dry);
  card.querySelector('[data-forecast-covered]').style.inlineSize=share;
  card.querySelector('[data-forecast-mark]').style.insetInlineStart=share;
  card.querySelector('[data-forecast-mark]').hidden=!dry;
  card.querySelector('[data-forecast-runout]').hidden=!dry;
  for (const [selector,hours] of [['[data-runout-time]',scenario.coveredHours],['[data-reset-time]',scenario.resetHours]]) {
    const time=card.querySelector(selector); time.textContent=t('site.features.in',{duration:duration(hours)});
    const date=new Date(Date.UTC(2026,8,16,0)+hours*3600000); time.dateTime=date.toISOString();
    time.title=new Intl.DateTimeFormat(demo.ownerDocument.documentElement.lang||'en',{dateStyle:'medium',timeStyle:'short',timeZone:'America/New_York'}).format(date)+' EDT · example';
  }
}
