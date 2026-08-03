import assert from "node:assert/strict";
import { test } from "node:test";

import { mountDashboardNavigation } from "../public/navigation.js";

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

function fakeLink(nav) {
  const attributes = new Map([["href", `#${nav}`]]);
  const listeners = new Map();
  return {
    attributes,
    classList: new FakeClassList(),
    dataset: { nav },
    addEventListener(type, listener) { listeners.set(type, listener); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    setAttribute(name, value) { attributes.set(name, value); },
    click() {
      let prevented = false;
      listeners.get("click")?.({
        currentTarget: this,
        preventDefault() { prevented = true; },
      });
      return prevented;
    },
  };
}

function fakePage(name) {
  return { dataset: { dashboardPage: name }, hidden: false };
}

function fakeBrowser({ hash = "" } = {}) {
  const links = ["overview", "weekly", "trends", "method", "community", "data"]
    .map(fakeLink);
  const pages = ["overview", "weekly", "trends", "method", "community", "data"]
    .map(fakePage);
  const disclosure = { open: false };
  const listeners = new Map();
  const pushed = [];
  const scrolls = [];
  const documentRef = {
    querySelector(selector) {
      assert.equal(selector, "#community-contribution-disclosure");
      return disclosure;
    },
    querySelectorAll(selector) {
      if (selector === "[data-nav]") return links;
      assert.equal(selector, "[data-dashboard-page]");
      return pages;
    },
  };
  const windowRef = {
    history: { pushState(_state, _title, hashValue) { pushed.push(hashValue); windowRef.location.hash = hashValue; } },
    location: { hash },
    scrollTo(options) { scrolls.push(options); },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  return { disclosure, documentRef, links, listeners, pages, pushed, scrolls, windowRef };
}

function assertActivePage(browser, expected) {
  for (const page of browser.pages) {
    assert.equal(page.hidden, page.dataset.dashboardPage !== expected, page.dataset.dashboardPage);
  }
  for (const link of browser.links) {
    const active = link.dataset.nav === expected;
    assert.equal(link.classList.contains("active"), active, link.dataset.nav);
    assert.equal(link.attributes.get("aria-current"), active ? "page" : undefined, link.dataset.nav);
  }
}

test("hashes preserve deep links while selecting their owning top-level page", () => {
  const browser = fakeBrowser({ hash: "#accounting" });
  mountDashboardNavigation(browser);
  assertActivePage(browser, "method");

  browser.windowRef.location.hash = "#community";
  browser.listeners.get("hashchange")();
  assert.equal(browser.disclosure.open, false);
  assertActivePage(browser, "community");

  browser.windowRef.location.hash = "#backend";
  browser.listeners.get("popstate")();
  assert.equal(browser.disclosure.open, true);
  assertActivePage(browser, "data");
});

test("page links prevent long-document anchor scrolling and retain normal history", () => {
  const browser = fakeBrowser();
  mountDashboardNavigation(browser);
  assertActivePage(browser, "overview");

  const trends = browser.links.find((link) => link.dataset.nav === "trends");
  assert.equal(trends.click(), true);
  assert.deepEqual(browser.pushed, ["#trends"]);
  assert.deepEqual(browser.scrolls, [{ top: 0, behavior: "instant" }]);
  assertActivePage(browser, "trends");
});

test("teardown removes page and history listeners", () => {
  const browser = fakeBrowser({ hash: "#overview" });
  const teardown = mountDashboardNavigation(browser);
  teardown();

  assert.equal(browser.listeners.has("hashchange"), false);
  assert.equal(browser.listeners.has("popstate"), false);
  assert.equal(browser.links[1].click(), false);
  assertActivePage(browser, "overview");
});
