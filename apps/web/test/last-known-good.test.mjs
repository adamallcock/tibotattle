import assert from "node:assert/strict";
import test from "node:test";

import {
  LAST_KNOWN_GOOD_MAX_AGE_MS,
  createLastKnownGoodStore,
  isAuthoritativeWithdrawal,
} from "../public/last-known-good.js";
import { createCommunityRefresh } from "../public/community-refresh.js";
import {
  COMMUNITY_DAILY_CACHE_SCHEMA_IDENTITY,
  normalizeCommunityDailySeries,
  projectCommunityDailyPayloadForCache,
} from "../public/community-data.js";
import {
  renderCommunityAllowanceSection,
  renderCommunityDailySeries,
} from "../public/community-view.js";
import { formatAge } from "../public/ui-format.js";
import { publicAllowanceFixture } from "./fixtures/public-allowance.js";

// Everything below uses synthetic public aggregates only: the fixture is the
// reviewed wire shape with invented dollar values, and no real contribution,
// account, device or session data appears anywhere in this file.

const NOW_MS = Date.parse("2026-09-18T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

function fakeStorage({ throwOn = [] } = {}) {
  const items = new Map();
  const blocked = new Set(throwOn);
  const guard = (operation) => {
    if (blocked.has(operation)) throw new Error("site data is blocked");
  };
  return {
    items,
    getItem(key) {
      guard("getItem");
      return items.has(key) ? items.get(key) : null;
    },
    setItem(key, value) {
      guard("setItem");
      items.set(key, value);
    },
    removeItem(key) {
      guard("removeItem");
      items.delete(key);
    },
  };
}

function testStore({ clock = { ms: NOW_MS }, ...options } = {}) {
  const storage = options.storage ?? fakeStorage();
  const store = createLastKnownGoodStore({
    key: "test-view",
    schemaVersion: "test-contract-v1",
    project: (payload) => payload,
    storage,
    now: () => clock.ms,
    ...options,
  });
  return { store, storage, clock };
}

const failure = (properties = {}) =>
  Object.assign(new Error("read failed"), properties);

test("a payload that genuinely arrived is re-served when the next fetch fails, with all three states distinguishable", () => {
  const { store, clock } = testStore();
  const payload = { figure: 1500, day: "2026-09-17" };

  const live = store.resolve({ payload, failure: null });
  assert.equal(live.state, "live");
  assert.deepEqual(live.payload, payload);
  assert.equal(live.failure, null);
  assert.equal(live.ageMs, null);

  clock.ms += 2 * HOUR_MS;
  const offline = failure({ status: 503 });
  const cached = store.resolve({ payload: null, failure: offline });
  assert.equal(cached.state, "cached");
  // The figures are the ones that arrived, byte for byte. Nothing is
  // interpolated, carried forward or rounded on the way back out.
  assert.deepEqual(cached.payload, payload);
  assert.equal(cached.failure, offline);
  assert.equal(cached.fetchedAt, "2026-09-18T12:00:00.000Z");
  assert.equal(cached.ageMs, 2 * HOUR_MS);

  // A viewer with no retained payload gets an honest nothing, never the
  // cached state with an empty payload.
  const { store: empty } = testStore();
  const unavailable = empty.resolve({ payload: null, failure: offline });
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.payload, null);
  assert.equal(unavailable.failure, offline);
  assert.equal(unavailable.fetchedAt, null);

  assert.deepEqual(
    new Set([live.state, cached.state, unavailable.state]),
    new Set(["live", "cached", "unavailable"]),
  );
});

test("a payload written under a different contract is refused and discarded, never reinterpreted", () => {
  const { storage, clock } = testStore();
  const older = createLastKnownGoodStore({
    key: "test-view",
    schemaVersion: "test-contract-v0",
    project: (payload) => payload,
    storage,
    now: () => clock.ms,
  });
  assert.equal(older.remember({ figure: 1 }), true);
  assert.equal(storage.items.size, 1);

  const { store: current } = testStore({ storage, clock });
  assert.equal(current.recall(), null);
  assert.equal(
    current.resolve({ payload: null, failure: failure({ status: 503 }) }).state,
    "unavailable",
  );
  // Refused permanently, so the space it held is reclaimed rather than kept
  // for a reader that can never honestly interpret it.
  assert.equal(storage.items.size, 0);
});

test("a corrupt or foreign entry is refused without throwing", () => {
  const { store, storage } = testStore();
  for (const junk of ["{not json", "null", "[]", '{"envelopeVersion":"other"}', "3"]) {
    storage.items.set(store.storageKey, junk);
    assert.equal(store.recall(), null);
    assert.equal(storage.items.has(store.storageKey), false);
  }
});

test("storage that throws on every access never reaches the page", () => {
  const storage = fakeStorage({ throwOn: ["getItem", "setItem", "removeItem"] });
  const { store } = testStore({ storage });
  assert.equal(store.remember({ figure: 1 }), false);
  assert.equal(store.recall(), null);
  assert.doesNotThrow(() => store.forget());
  const resolved = store.resolve({ payload: null, failure: failure({ status: 503 }) });
  assert.equal(resolved.state, "unavailable");
  assert.equal(resolved.payload, null);
  // A live answer still renders: a blocked cache degrades the fallback, never
  // the page that does not need it.
  assert.deepEqual(
    store.resolve({ payload: { figure: 2 }, failure: null }),
    { state: "live", payload: { figure: 2 }, failure: null, fetchedAt: null, ageMs: null },
  );
});

test("a store constructs and degrades when the storage property itself throws", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("access to site data is denied");
    },
  });
  try {
    const store = createLastKnownGoodStore({
      key: "private-window",
      schemaVersion: "test-contract-v1",
      project: (payload) => payload,
    });
    assert.equal(store.remember({ figure: 1 }), false);
    assert.equal(store.recall(), null);
    assert.equal(
      store.resolve({ payload: null, failure: failure({ status: 503 }) }).state,
      "unavailable",
    );
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
});

test("a payload past the staleness bound is discarded rather than shown", () => {
  const { store, storage, clock } = testStore();
  assert.equal(store.remember({ figure: 1 }), true);
  clock.ms += LAST_KNOWN_GOOD_MAX_AGE_MS;
  assert.equal(store.recall()?.ageMs, LAST_KNOWN_GOOD_MAX_AGE_MS);
  clock.ms += 1;
  assert.equal(store.recall(), null);
  assert.equal(storage.items.size, 0);
});

test("a clock that moved backwards refuses to date the payload without destroying it", () => {
  const { store, storage, clock } = testStore();
  assert.equal(store.remember({ figure: 1 }), true);
  clock.ms -= HOUR_MS;
  assert.equal(store.recall(), null);
  // An entry that is merely unusable right now survives: a corrected clock
  // recovers real evidence that a delete would have thrown away.
  assert.equal(storage.items.size, 1);
  clock.ms += HOUR_MS;
  assert.equal(store.recall()?.ageMs, 0);
});

test("an oversized payload is refused and never leaves an older entry standing behind it", () => {
  const { store, storage, clock } = testStore({ maxBytes: 256 });
  assert.equal(store.remember({ figure: 1 }), true);
  clock.ms += HOUR_MS;
  assert.equal(store.remember({ figure: 2, filler: "x".repeat(4096) }), false);
  // The retained copy would now be older than a payload this browser already
  // held, and nothing on the page could say so, so it goes.
  assert.equal(storage.items.size, 0);
  assert.equal(store.recall(), null);
});

test("a write the browser rejects clears the entry instead of stranding a superseded one", () => {
  const storage = fakeStorage();
  const { store, clock } = testStore({ storage });
  assert.equal(store.remember({ figure: 1 }), true);
  storage.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  clock.ms += HOUR_MS;
  assert.equal(store.remember({ figure: 2 }), false);
  assert.equal(storage.items.size, 0);
});

test("a projection that declines a payload refuses it and clears the cache", () => {
  const storage = fakeStorage();
  const clock = { ms: NOW_MS };
  const store = createLastKnownGoodStore({
    key: "test-view",
    schemaVersion: "test-contract-v1",
    project: (payload) => (payload.usable === true ? payload : null),
    storage,
    now: () => clock.ms,
  });
  assert.equal(store.remember({ usable: true, figure: 1 }), true);
  assert.equal(store.remember({ usable: false, figure: 2 }), false);
  assert.equal(storage.items.size, 0);

  const throwing = createLastKnownGoodStore({
    key: "test-view",
    schemaVersion: "test-contract-v1",
    project: () => {
      throw new Error("projection failed");
    },
    storage,
    now: () => clock.ms,
  });
  assert.equal(throwing.remember({ figure: 3 }), false);
});

test("an authoritative empty answer clears the cache rather than leaving withdrawn figures behind", () => {
  const { store, storage } = testStore();
  assert.equal(store.remember({ figure: 1 }), true);
  const resolved = store.resolve({ payload: null, failure: null });
  assert.equal(resolved.state, "live");
  assert.equal(resolved.payload, null);
  assert.equal(storage.items.size, 0);
});

test("the cache refuses exactly the failures the refresh controller treats as authoritative", async () => {
  const candidates = [
    failure({ status: 403 }),
    failure({ status: 410 }),
    failure({ code: "PUBLICATION_DISABLED", status: 503 }),
    failure({ status: 500 }),
    failure({ status: 503 }),
    failure({ status: 404 }),
    failure(),
  ];
  for (const candidate of candidates) {
    // Drive the real controller: one success, then this failure. A controller
    // that publishes a null payload has decided the publication is gone.
    let clock = 0;
    let sequence = 0;
    const timers = new Map();
    const publications = [];
    const replies = [() => ({ ok: true }), () => {
      throw candidate;
    }];
    const refresh = createCommunityRefresh({
      now: () => clock,
      schedule: (fn, delay) => {
        const id = ++sequence;
        timers.set(id, { at: clock + delay, fn });
        return id;
      },
      cancel: (id) => timers.delete(id),
      read: () => (replies.shift() ?? (() => ({ ok: true })))(),
      publish: (result) => publications.push(result),
    });
    refresh.start();
    await new Promise((resolve) => setImmediate(resolve));
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > 60_000) continue;
      clock = timer.at;
      timers.delete(id);
      void timer.fn();
      await new Promise((resolve) => setImmediate(resolve));
    }
    refresh.stop();
    const controllerWithdrew = publications.some(
      (entry) => entry.payload === null && entry.failure === candidate,
    );

    const { store } = testStore();
    store.remember({ figure: 1 });
    const resolved = store.resolve({ payload: null, failure: candidate });
    assert.equal(
      resolved.state === "unavailable",
      controllerWithdrew,
      `cache and refresh controller disagree about ${candidate.code ?? candidate.status ?? "a plain failure"}`,
    );
    assert.equal(isAuthoritativeWithdrawal(candidate), controllerWithdrew);
  }
});

test("the community projection stores only what this reader validated, and re-normalizes to the same series", () => {
  const raw = publicAllowanceFixture(NOW_MS);
  raw.allowanceReadState = "confirmed";
  // Fields a future service could add, and a block this reader declines.
  raw.operatorDiagnostic = { queueDepth: 4, note: "internal" };
  raw.days[0].payload.experimentalTotals = { unknownMetric: 9 };
  raw.days[0].payload.allowance.experimentalConfidence = 0.5;

  const projected = projectCommunityDailyPayloadForCache(raw, { nowMs: NOW_MS });
  assert.deepEqual(
    normalizeCommunityDailySeries(projected, { nowMs: NOW_MS }),
    normalizeCommunityDailySeries(raw, { nowMs: NOW_MS }),
  );
  const stored = JSON.stringify(projected);
  for (const leaked of ["operatorDiagnostic", "queueDepth", "experimentalTotals", "unknownMetric", "experimentalConfidence"]) {
    assert.equal(stored.includes(leaked), false, `${leaked} must not reach storage`);
  }
  assert.deepEqual(Object.keys(projected).sort(), [
    "allowanceBreakdowns", "allowanceReadState", "allowanceState", "days", "from", "schemaVersion", "to",
  ]);
  assert.equal(projected.allowanceReadState, "confirmed");
  assert.equal(projected.allowanceBreakdowns.schemaVersion, "community-allowance-breakdowns-v1.2");

  // Re-reading days later only ever gets stricter, so a retained payload can
  // never be promoted into acceptance by the passage of time.
  const later = normalizeCommunityDailySeries(projected, { nowMs: NOW_MS + 3 * 24 * HOUR_MS });
  assert.equal(later.state, "published");
  assert.equal(later.breakdowns?.days.length, projected.allowanceBreakdowns.days.length);

  // A payload this reader cannot interpret is never stored in the first place.
  assert.equal(projectCommunityDailyPayloadForCache(null, { nowMs: NOW_MS }), null);
  assert.equal(
    projectCommunityDailyPayloadForCache({ ...raw, schemaVersion: "community-daily-read-v9.9" }, { nowMs: NOW_MS }),
    null,
  );
});

test("the community cache preserves a legacy allowance basis instead of relabeling it", () => {
  const raw = publicAllowanceFixture(NOW_MS);
  delete raw.allowanceBreakdowns;
  for (const day of raw.days) {
    day.payload.allowance.basis = "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d";
    day.payload.allowance.normalization = "pro_x1_prolite_x4_plus_x20";
  }
  const projected = projectCommunityDailyPayloadForCache(raw, { nowMs: NOW_MS });
  assert.deepEqual(
    normalizeCommunityDailySeries(projected, { nowMs: NOW_MS }),
    normalizeCommunityDailySeries(raw, { nowMs: NOW_MS }),
  );
  assert.equal(projected.days[0].payload.allowance.basis,
    "seven_day_codex_pro20x_equivalent_personal_plans_trailing_30d");
});

test("a community payload retained by the store still renders through the real reader", () => {
  const storage = fakeStorage();
  const clock = { ms: NOW_MS };
  const store = createLastKnownGoodStore({
    key: "community-daily",
    schemaVersion: COMMUNITY_DAILY_CACHE_SCHEMA_IDENTITY,
    project: (payload) => projectCommunityDailyPayloadForCache(payload, { nowMs: clock.ms }),
    storage,
    now: () => clock.ms,
  });
  const raw = publicAllowanceFixture(NOW_MS);
  store.resolve({ payload: raw, failure: null });
  clock.ms += 2 * HOUR_MS;

  const resolved = store.resolve({ payload: null, failure: failure({ status: 503 }) });
  assert.equal(resolved.state, "cached");
  const series = normalizeCommunityDailySeries(resolved.payload, { nowMs: clock.ms });
  assert.equal(series.state, "published");
  assert.equal(series.days.length, raw.days.length);
  assert.equal(
    series.days.at(-1).allowance.centralUsd,
    normalizeCommunityDailySeries(raw, { nowMs: NOW_MS }).days.at(-1).allowance.centralUsd,
  );
});

// The smallest element shape the community renderers actually use, matching
// the stub the rest of the web suite renders against.
class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.className = "";
    this.textContent = "";
    this.hidden = false;
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren() {
    this.children = [];
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  get text() {
    return [this.textContent, ...this.children.map((child) => child.text)]
      .filter((value) => value !== "")
      .join(" ");
  }
}

function fakeDocument() {
  return {
    documentElement: { lang: "en-US" },
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (namespace, tag) => new FakeElement(tag),
  };
}

function renderBoth(cache) {
  const documentRef = fakeDocument();
  const payload = publicAllowanceFixture(NOW_MS);
  const daily = {
    container: new FakeElement("div"),
    stateNode: new FakeElement("span"),
  };
  const allowance = {
    container: new FakeElement("div"),
    stateNode: new FakeElement("span"),
  };
  daily.state = renderCommunityDailySeries({
    documentRef, container: daily.container, stateNode: daily.stateNode, payload, cache,
  });
  allowance.state = renderCommunityAllowanceSection({
    documentRef, container: allowance.container, stateNode: allowance.stateNode, payload, cache,
  });
  return { daily, allowance };
}

test("both community views label retained figures, keep the figures, and never claim the live chip", () => {
  const live = renderBoth(null);
  assert.equal(live.daily.stateNode.textContent, "Daily series available");
  assert.equal(live.daily.stateNode.className, "evidence-chip");
  assert.equal(live.allowance.stateNode.textContent, "Allowance estimates available");
  assert.equal(live.allowance.stateNode.className, "evidence-chip");
  assert.equal(live.daily.container.text.includes("last received"), false);
  assert.equal(live.allowance.container.text.includes("last received"), false);

  const cached = renderBoth({ fetchedAt: "2026-09-18T10:00:00.000Z", ageMs: 2 * HOUR_MS });
  const age = formatAge((2 * HOUR_MS) / 1000);
  for (const view of [cached.daily, cached.allowance]) {
    assert.equal(view.stateNode.textContent, "Showing cached figures");
    // Never the live chip class: a glance and a read carry the same claim.
    assert.equal(view.stateNode.className, "evidence-chip neutral");
    assert.match(view.container.text, /The service could not be reached/u);
    assert.ok(view.container.text.includes(age), `states the age (${age})`);
    assert.match(view.container.text, /nothing has been estimated/u);
  }
  // Same render as live, with provenance added rather than figures removed.
  assert.equal(cached.daily.state, live.daily.state);
  assert.equal(cached.allowance.state, live.allowance.state);
  assert.ok(cached.daily.container.children.length > 1);
  assert.ok(cached.allowance.container.children.length > 1);

  // An unusable provenance descriptor is not allowed to invent an age; it
  // falls back to the live labelling rather than an unlabelled stale one.
  for (const broken of [{}, { fetchedAt: "2026-09-18T10:00:00.000Z" }, { fetchedAt: 5, ageMs: 1 }, { fetchedAt: "x", ageMs: Number.NaN }]) {
    const rendered = renderBoth(broken);
    assert.equal(rendered.daily.stateNode.textContent, "Daily series available");
    assert.equal(rendered.daily.container.text.includes("last received"), false);
  }
});
