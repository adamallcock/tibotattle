import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { wirePaceDemo } from '../public/feature-tour.js';
import { translate } from '../public/localization.js';

// Exercise the public adapter through the actual app controller and renderer.
// Timers and observers stay deterministic; no wall-clock work survives a test.
function paceFixture({ reducedMotion = false, height = 418 } = {}) {
  const frames = new Map(), timers = new Map(), observers = [];
  let sequence = 0;
  const contextCalls = [];
  const context = new Proxy({}, {
    get(_target, key) {
      if (key.startsWith('create')) return () => ({ addColorStop() {} });
      return (...args) => contextCalls.push([key, ...args]);
    },
    set() { return true; },
  });
  class Element extends EventTarget {
    constructor(tag = 'div', className = '', dataset = {}) {
      super(); this.tagName = tag; this.className = className; this.dataset = dataset;
      this.children = []; this.attributes = {}; this.ownerDocument = doc; this.isConnected = true;
      this.style = { setProperty() {}, removeProperty() {} };
      const classes = new Set(className.split(' '));
      this.classList = { add: key => classes.add(key), remove: key => classes.delete(key),
        toggle(key, on) { if (on) classes.add(key); else classes.delete(key); } };
    }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    insertBefore(child) { this.append(child); }
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key]; }
    focus(options) { doc.activeElement = this; this.focusOptions = options; }
    querySelectorAll(selector) {
      if (selector.includes(' ')) {
        const [ancestor, ...descendant] = selector.split(' ');
        return this.querySelectorAll(ancestor).flatMap(element => element.querySelectorAll(descendant.join(' ')));
      }
      const matches = element => selector.startsWith('.') ? element.className.split(' ').includes(selector.slice(1))
        : selector.startsWith('[data-') ? selector.slice(6, -1).replace(/-([a-z])/g, (_, value) => value.toUpperCase()) in element.dataset
        : element.tagName === selector;
      return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    getContext() { return context; }
    getBoundingClientRect() { return { left: 0, width: 280, height }; }
  }
  const media = Object.assign(new EventTarget(), { matches: reducedMotion });
  const view = Object.assign(new EventTarget(), {
    devicePixelRatio: 2,
    matchMedia: query => query.includes('reduced') ? media : Object.assign(new EventTarget(), { matches: false }),
    getComputedStyle: () => ({ color: 'rgb(100, 150, 120)' }),
    requestAnimationFrame: callback => { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: callback => { timers.set(++sequence, callback); return sequence; },
    clearTimeout: id => timers.delete(id),
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.kind = 'resize'; this.targets = []; observers.push(this); }
      observe(target) { this.targets.push(target); }
      disconnect() { this.targets = []; }
    },
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; this.kind = 'intersection'; this.targets = []; observers.push(this); }
      observe(target) { this.targets.push(target); }
      disconnect() { this.targets = []; }
    },
    MutationObserver: class { observe() {} disconnect() {} },
  });
  const doc = Object.assign(new EventTarget(), { defaultView: view, hidden: false });
  doc.documentElement = new Element(); doc.documentElement.lang = 'en-US';
  doc.createElement = tag => new Element(tag);
  const demo = new Element('section', '', { paceDemo: '', pace: 'way' });
  const apparatus = new Element('div', 'pace-apparatus quota-grid');
  const tank = new Element('article', 'quota-tank');
  tank.append(new Element('div', 'quota-tank-header'), new Element('div', 'quota-tank-bottom'));
  apparatus.append(tank);
  const forecast = new Element('aside', 'weekly-pace-forecast', { demoForecast: '' });
  forecast.append(new Element('div', 'weekly-pace-forecast-heading'));
  for (const name of ['forecastBadge','forecastTitle','forecastCopy','forecastGap','forecastTrack','forecastCovered','forecastMark','forecastRunout','runoutTime','resetTime']) {
    forecast.append(new Element('span', '', { [name]: '' }));
  }
  const verdict = new Element('p', '', { demoVerdict: '' });
  const buttons = ['under','over','way'].map(pace => new Element('button', '', { demoPace: pace }));
  demo.append(apparatus, forecast, verdict, ...buttons);
  doc.querySelector = selector => selector === '[data-pace-demo]' ? demo : null;
  const dispose = wirePaceDemo(doc, (key, values) => translate(key, values));
  function show() {
    for (const observer of observers) {
      if (!observer.targets.length) continue;
      observer.callback(observer.targets.map(target => observer.kind === 'resize'
        ? { target, contentRect: { width: 280, height } }
        : { target, isIntersecting: true }));
    }
  }
  function frame(stamp) {
    const pending = [...frames]; frames.clear();
    for (const [, callback] of pending) callback(stamp);
  }
  return { doc, view, media, demo, tank, forecast, verdict, buttons, frames, timers, contextCalls, dispose, show, frame,
    canvas: () => tank.querySelector('canvas'),
    control: () => forecast.querySelector('.allowance-motion-controls').querySelector('button') };
}

function click(element, extra = {}) {
  element.dispatchEvent(Object.assign(new Event('click'), { detail: 1, ...extra }));
}

test('public feature copy resolves in all shipped languages', () => {
  for (const locale of ['en-US', 'es', 'zh-Hans']) {
    for (const key of ['heading', 'pause', 'cacheCopy', 'privacyCopy']) {
      assert.notEqual(translate(`site.features.${key}`, {}, locale), `site.features.${key}`);
    }
  }
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

test('public pace uses the app canvas at its measured height and cleans up on pace or locale changes', () => {
  const f = paceFixture({ height: 390 });
  try {
    f.show();
    const oldCanvas = f.canvas();
    assert.equal(oldCanvas.width, 560);
    assert.equal(oldCanvas.height, 780, 'the bitmap follows the displayed height instead of clipping a taller drawing');
    assert.deepEqual(f.contextCalls.find(call => call[0] === 'setTransform'), ['setTransform', 780 / 556, 0, 0, 780 / 556, 0, 0]);
    assert.equal(oldCanvas.getAttribute('role'), 'button');
    assert.equal(oldCanvas.getAttribute('tabindex'), '0');
    assert.equal(f.tank.dataset.remaining, '33');
    assert.equal(f.forecast.dataset.tankRatio, '10');
    click(f.buttons[0]);
    f.show();
    assert.equal(f.demo.dataset.pace, 'under');
    assert.equal(f.forecast.dataset.tankRatio, '0.6');
    assert.equal(f.tank.dataset.remaining, '33', 'interaction never changes illustrative capacity');
    assert.notEqual(f.canvas(), oldCanvas);
    assert.equal(oldCanvas.isConnected, false);
    assert.equal(f.tank.querySelectorAll('canvas').length, 1);
    assert.equal(f.forecast.querySelectorAll('.allowance-motion-controls').length, 1);
    assert.deepEqual(f.buttons.map(button => button.getAttribute('aria-pressed')), ['true', 'false', 'false']);
    f.view.dispatchEvent(new Event('tibotattle:locale-change'));
    f.show();
    assert.equal(f.tank.querySelectorAll('canvas').length, 1);
    assert.equal(f.forecast.querySelectorAll('.allowance-motion-controls').length, 1);
    assert.equal(f.frames.size, 1, 'remounting leaves only the current animation loop');
  } finally { f.dispose(); }
  assert.equal(f.frames.size, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.tank.querySelectorAll('canvas').length, 0);
});

test('the public canvas reacts to pointer and keyboard input through the app slosh renderer', () => {
  function trace(interact) {
    const f = paceFixture();
    try {
      f.show(); f.frame(0); f.contextCalls.length = 0;
      interact?.(f.canvas());
      f.frame(34);
      return f.contextCalls.filter(call => call[0] === 'lineTo');
    } finally { f.dispose(); }
  }
  const idle = trace();
  const pointer = trace(canvas => click(canvas, { clientX: 70 }));
  let prevented = false;
  const keyboard = trace(canvas => {
    const event = new Event('keydown', { cancelable: true });
    Object.assign(event, { key: ' ', repeat: false });
    canvas.dispatchEvent(event); prevented = event.defaultPrevented;
  });
  assert.ok(idle.length > 0);
  assert.notDeepEqual(pointer, idle, 'a tap must change the liquid surface, not just play a recording');
  assert.notDeepEqual(keyboard, idle, 'keyboard activation must change the liquid surface');
  assert.equal(prevented, true, 'space activation does not scroll the page');
});

test('public pause survives pace changes and reduced motion disables animation and agitation', () => {
  const f = paceFixture();
  try {
    f.show();
    click(f.control());
    assert.equal(f.control().getAttribute('aria-pressed'), 'true');
    assert.equal(f.canvas().getAttribute('aria-disabled'), 'true');
    assert.equal(f.frames.size, 0);
    click(f.buttons[1]); f.show();
    assert.equal(f.control().getAttribute('aria-pressed'), 'true');
    assert.equal(f.frames.size, 0);
    click(f.control());
    assert.equal(f.canvas().getAttribute('aria-disabled'), 'false');
    assert.equal(f.frames.size, 1);
    f.media.matches = true; f.media.dispatchEvent(new Event('change'));
    assert.equal(f.frames.size, 0);
    assert.equal(f.canvas().getAttribute('tabindex'), '-1');
    assert.equal(f.canvas().getAttribute('aria-disabled'), 'true');
    assert.equal(f.forecast.querySelector('.allowance-motion-controls').hidden, true);
  } finally { f.dispose(); }
});

test('the public allowance example ships app-compatible interactive markup instead of a recorded substitute', async () => {
  const page = await readFile(new URL('../public/community.html', import.meta.url), 'utf8');
  const allowance = page.slice(page.indexOf('id="pace"'), page.indexOf('id="usage-history"'));
  assert.match(allowance, /class="pace-apparatus quota-grid"/);
  assert.match(allowance, /class="[^"]*quota-tank[^"]*"/);
  assert.doesNotMatch(allowance, /<video\b|feature-allowance\.(?:mp4|jpg)|<canvas\b/);
  assert.doesNotMatch(allowance, /class="pace-apparatus[^>]*aria-hidden="true"/);
});


test('locale remount preserves focused interactive controls without stealing language-selector focus', () => {
  const f = paceFixture();
  try {
    f.show();
    for (const current of [f.canvas, f.control]) {
      const original = current();
      original.focus();
      f.view.dispatchEvent(new Event('tibotattle:locale-change'));
      assert.notEqual(current(), original, 'locale refresh remounts the translated control');
      assert.equal(f.doc.activeElement, current(), 'focus follows the equivalent control');
      assert.deepEqual(current().focusOptions, { preventScroll: true });
    }
    const languageSelector = f.doc.createElement('select');
    languageSelector.focus();
    f.view.dispatchEvent(new Event('tibotattle:locale-change'));
    assert.equal(f.doc.activeElement, languageSelector, 'a locale selection keeps focus outside the demo');
    assert.equal(f.tank.querySelectorAll('canvas').length, 1);
    assert.equal(f.forecast.querySelectorAll('.allowance-motion-controls button').length, 1);
  } finally { f.dispose(); }
});
