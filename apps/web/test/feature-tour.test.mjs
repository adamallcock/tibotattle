import test from 'node:test';
import assert from 'node:assert/strict';
import { wireFeaturePreviews } from '../public/feature-tour.js';
import { translate } from '../public/localization.js';

function fixture(reduced = false) {
  const video = Object.assign(new EventTarget(), {
    paused: true, calls: 0,
    play() { this.calls++; this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); },
    pause() { this.paused = true; this.dispatchEvent(new Event('pause')); },
  });
  const button = Object.assign(new EventTarget(), { dataset: {}, hidden: true });
  const figure = { querySelector: (selector) => selector === 'video' ? video : button };
  const root = Object.assign(new EventTarget(), { hidden: false, querySelectorAll: () => [figure] });
  const motion = Object.assign(new EventTarget(), { matches: reduced });
  let intersect;
  let disconnected = false;
  const environment = { matchMedia: () => motion, IntersectionObserver: class {
    constructor(callback) { intersect = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  } };
  const dispose = wireFeaturePreviews(root, environment, (key) => translate(key));
  return { video, button, root, motion, dispose, disconnected: () => disconnected,
    visible: (value) => intersect([{ isIntersecting: value }]),
    click: () => button.dispatchEvent(new Event('click')) };
}

test('previews play only while visible, pause in background, and preserve manual pause', () => {
  const f = fixture();
  assert.equal(f.video.calls, 0);
  f.visible(true);
  assert.equal(f.video.paused, false);
  assert.equal(f.button.textContent, 'Pause preview');
  f.root.hidden = true; f.root.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.video.paused, true);
  f.root.hidden = false; f.root.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.video.paused, false);
  f.click(); f.visible(false); f.visible(true);
  assert.equal(f.video.paused, true);
  assert.equal(f.button.textContent, 'Play preview');
  f.click(); assert.equal(f.video.paused, false);
  f.dispose(); assert.equal(f.video.paused, true); assert.equal(f.disconnected(), true);
});

test('reduced motion shows a poster unless the visitor explicitly plays it', () => {
  const f = fixture(true);
  f.visible(true); assert.equal(f.video.calls, 0);
  f.click(); assert.equal(f.video.paused, false);
  f.visible(false); assert.equal(f.video.paused, true);
  f.dispose();
});

test('a live reduced-motion change stops automatic playback', () => {
  const f = fixture(); f.visible(true);
  f.motion.matches = true; f.motion.dispatchEvent(new Event('change'));
  assert.equal(f.video.paused, true);
  f.dispose();
});

test('public feature copy resolves in all shipped languages', () => {
  for (const locale of ['en-US', 'es', 'zh-Hans']) {
    for (const key of ['heading', 'pause', 'cacheCopy', 'privacyCopy']) {
      assert.notEqual(translate(`site.features.${key}`, {}, locale), `site.features.${key}`);
    }
  }
});

test('pace demonstration changes only its illustrative state and supports pausing', async () => {
  const { wirePaceDemo } = await import('../public/feature-tour.js');
  const element = (dataset = {}) => Object.assign(new EventTarget(), { dataset, attrs: {}, setAttribute(k,v) { this.attrs[k] = v; } });
  const buttons = ['under','over','way'].map(demoPace => element({demoPace}));
  const verdict = element(); const motion = element();
  const demo = element({pace:'under'});
  demo.querySelectorAll = () => buttons;
  demo.querySelector = selector => selector === '[data-demo-verdict]' ? verdict : motion;
  wirePaceDemo({querySelector: () => demo}, key => translate(key));
  buttons[2].dispatchEvent(new Event('click'));
  assert.equal(demo.dataset.pace, 'way');
  assert.deepEqual(buttons.map(b=>b.attrs['aria-pressed']), ['false','false','true']);
  assert.match(verdict.textContent, /much earlier stop/);
  buttons[0].dispatchEvent(new Event('click'));
  assert.equal(demo.dataset.pace, 'under');
  motion.dispatchEvent(new Event('click'));
  assert.equal(demo.dataset.paused, 'true');
  assert.equal(motion.textContent, 'Play preview');
  motion.dispatchEvent(new Event('click'));
  assert.equal(demo.dataset.paused, 'false');
});

test('illustrative forecast keeps covered and empty time consistent with pace', async () => {
  const { demoForecastScenario } = await import('../public/feature-tour.js');
  const critical = demoForecastScenario('way');
  assert.equal(critical.coveredHours,14);
  assert.equal(critical.dryHours,126);
  assert.equal(critical.coveredHours+critical.dryHours,critical.resetHours);
  assert.equal(demoForecastScenario('under').dryHours,0);
  assert.equal(demoForecastScenario('over').ratio,1.5);
});
