import { mountAllowanceTanks } from "./allowance-tanks.js";

/** The app's interactive tank, with explicitly illustrative website inputs. */
export function wirePaceDemo(root = document, translate = (key) => key) {
  const demo = root.querySelector('[data-pace-demo]');
  if (!demo) return () => {};
  const container = demo.querySelector('.pace-apparatus');
  const tank = container.querySelector('.quota-tank');
  const forecast = demo.querySelector('[data-demo-forecast]');
  const verdict = demo.querySelector('[data-demo-verdict]');
  const buttons = [...demo.querySelectorAll('[data-demo-pace]')];
  const view = root.defaultView;
  let painting = null;
  function refresh() {
    const focused = root.activeElement;
    const restoreCanvas = focused != null && focused === container.querySelector('canvas');
    const restoreMotion = focused != null && focused === forecast.querySelector('.allowance-motion-controls button');
    painting?.dispose();
    const scenario = demoForecastScenario(demo.dataset.pace);
    // Relative example times remain illustrative; no private allowance is read.
    const resetAt = Date.now() + scenario.resetHours * 3_600_000;
    tank.dataset.remaining = '33';
    tank.dataset.forecastPool = 'true';
    tank.dataset.resetAt = String(resetAt);
    tank.dataset.stale = 'false';
    forecast.dataset.tankRatio = String(scenario.ratio);
    forecast.dataset.tankRemaining = tank.dataset.remaining;
    forecast.dataset.tankReset = tank.dataset.resetAt;
    renderDemoForecast(demo, translate);
    for (const choice of buttons) choice.setAttribute('aria-pressed', String(choice.dataset.demoPace === demo.dataset.pace));
    verdict.dataset.i18n = `site.features.${demo.dataset.pace}Copy`;
    verdict.textContent = translate(verdict.dataset.i18n);
    painting = mountAllowanceTanks(container, forecast, {t: translate});
    if (restoreCanvas) container.querySelector('canvas')?.focus({preventScroll: true});
    if (restoreMotion) forecast.querySelector('.allowance-motion-controls button')?.focus({preventScroll: true});
  }
  const choose = (event) => {
    const pace = event.currentTarget.dataset.demoPace;
    if (!['under', 'over', 'way'].includes(pace)) return;
    demo.dataset.pace = pace;
    refresh();
  };
  for (const button of buttons) button.addEventListener('click', choose);
  view.addEventListener('tibotattle:locale-change', refresh);
  refresh();
  return () => {
    painting?.dispose();
    for (const button of buttons) button.removeEventListener('click', choose);
    view.removeEventListener('tibotattle:locale-change', refresh);
  };
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
  const badge = card.querySelector('[data-forecast-badge]');
  badge.dataset.i18n = `site.features.${demo.dataset.pace}`;
  badge.textContent = t(badge.dataset.i18n);
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
