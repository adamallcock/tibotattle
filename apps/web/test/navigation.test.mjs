import assert from "node:assert/strict";
import { test } from "node:test";

import {
  mountDashboardNavigation,
} from "../public/navigation.js";

class FakeClassList {
  #values = new Set();

  toggle(value, force) {
    if (force) this.#values.add(value);
    else this.#values.delete(value);
  }

  contains(value) {
    return this.#values.has(value);
  }
}

function fakeLink(nav, { active = false } = {}) {
  const attributes = new Map();
  const classList = new FakeClassList();
  if (active) {
    classList.toggle("active", true);
    attributes.set("aria-current", "location");
  }
  return {
    attributes,
    classList,
    dataset: { nav },
    removeAttribute(name) {
      attributes.delete(name);
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
  };
}

function fakeBrowser({ hash = "" } = {}) {
  const links = [
    fakeLink("overview", { active: true }),
    fakeLink("timeline"),
    fakeLink("community"),
    fakeLink("data"),
  ];
  const sections = [
    { id: "overview" },
    { id: "timeline" },
    { id: "community" },
    { id: "data" },
  ];
  const disclosure = { open: false };
  const listeners = new Map();
  const documentRef = {
    querySelector(selector) {
      assert.equal(selector, "#community-contribution-disclosure");
      return disclosure;
    },
    querySelectorAll(selector) {
      if (selector === "[data-nav]") return links;
      assert.equal(
        selector,
        ".dashboard-section, [data-nav-target]",
      );
      return sections;
    },
  };
  const windowRef = {
    location: { hash },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  class FakeIntersectionObserver {
    static instances = [];

    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.observed = [];
      this.disconnected = false;
      FakeIntersectionObserver.instances.push(this);
    }

    disconnect() {
      this.disconnected = true;
    }

    observe(target) {
      this.observed.push(target);
    }
  }
  return {
    disclosure,
    documentRef,
    IntersectionObserverRef: FakeIntersectionObserver,
    links,
    listeners,
    sections,
    windowRef,
  };
}

function assertActiveNavigation(links, expected) {
  for (const link of links) {
    const active = link.dataset.nav === expected;
    assert.equal(link.classList.contains("active"), active, link.dataset.nav);
    assert.equal(
      link.attributes.get("aria-current"),
      active ? "location" : undefined,
      link.dataset.nav,
    );
  }
}

test("hash navigation preserves disclosure and exact primary-link semantics", () => {
  const browser = fakeBrowser({ hash: "#history" });
  mountDashboardNavigation(browser);

  assert.equal(browser.disclosure.open, true);
  assertActiveNavigation(browser.links, null);

  browser.windowRef.location.hash = "#community";
  browser.listeners.get("hashchange")();
  assert.equal(browser.disclosure.open, true);
  assertActiveNavigation(browser.links, "community");

  browser.windowRef.location.hash = "";
  browser.listeners.get("hashchange")();
  assertActiveNavigation(browser.links, "community");

  browser.windowRef.location.hash = "#backend";
  browser.listeners.get("hashchange")();
  assert.equal(browser.disclosure.open, true);
  assertActiveNavigation(browser.links, null);
});

test("intersection navigation observes the exact targets and selects the highest visible ratio", () => {
  const browser = fakeBrowser();
  mountDashboardNavigation(browser);
  const [observer] = browser.IntersectionObserverRef.instances;

  assert.deepEqual(observer.options, {
    rootMargin: "-25% 0px -65% 0px",
    threshold: [0, .2, .7],
  });
  assert.deepEqual(observer.observed, browser.sections);

  observer.callback([
    {
      intersectionRatio: .3,
      isIntersecting: true,
      target: browser.sections[0],
    },
    {
      intersectionRatio: .7,
      isIntersecting: true,
      target: browser.sections[1],
    },
    {
      intersectionRatio: 1,
      isIntersecting: false,
      target: browser.sections[2],
    },
  ]);
  assertActiveNavigation(browser.links, "timeline");

  observer.callback([
    {
      intersectionRatio: .9,
      isIntersecting: true,
      target: browser.sections[0],
    },
  ]);
  assertActiveNavigation(browser.links, "overview");

  observer.callback([
    {
      intersectionRatio: .4,
      isIntersecting: true,
      target: browser.sections[2],
    },
  ]);
  assertActiveNavigation(browser.links, "overview");

  observer.callback([
    {
      intersectionRatio: 0,
      isIntersecting: false,
      target: browser.sections[0],
    },
  ]);
  assertActiveNavigation(browser.links, "timeline");

  observer.callback([
    {
      intersectionRatio: 1,
      isIntersecting: false,
      target: browser.sections[2],
    },
  ]);
  assertActiveNavigation(browser.links, "timeline");
});

test("teardown disconnects observation and removes hash synchronization", () => {
  const browser = fakeBrowser({ hash: "#overview" });
  const teardown = mountDashboardNavigation(browser);
  const [observer] = browser.IntersectionObserverRef.instances;
  assertActiveNavigation(browser.links, "overview");

  teardown();

  assert.equal(observer.disconnected, true);
  assert.equal(browser.listeners.has("hashchange"), false);
  browser.windowRef.location.hash = "#community";
  assertActiveNavigation(browser.links, "overview");
});
