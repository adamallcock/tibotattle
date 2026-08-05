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

function fakePage(name, { hidden = false } = {}) {
  const headingAttributes = new Map();
  const heading = {
    attributes: headingAttributes,
    focusOptions: null,
    setAttribute(name, value) { headingAttributes.set(name, value); },
    focus(options) { this.focusOptions = options; },
  };
  return {
    attributes: new Map(),
    classList: new FakeClassList(),
    dataset: { dashboardPage: name },
    hidden,
    inert: false,
    heading,
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
    querySelector(selector) {
      assert.equal(selector, "h1, h2");
      return heading;
    },
  };
}

function fakeBrowser({ hash = "" } = {}) {
  const links = ["overview", "weekly", "trends", "method", "community"]
    .map(fakeLink);
  const pages = ["overview", "weekly", "trends", "method", "community"]
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
    const inactive = page.dataset.dashboardPage !== expected;
    assert.equal(page.classList.contains("dashboard-page-inactive"), inactive, page.dataset.dashboardPage);
    assert.equal(page.inert, inactive, page.dataset.dashboardPage);
    assert.equal(page.attributes.get("aria-hidden"), inactive ? "true" : undefined, page.dataset.dashboardPage);
  }
  for (const link of browser.links) {
    const active = link.dataset.nav === expected;
    assert.equal(link.classList.contains("active"), active, link.dataset.nav);
    assert.equal(link.attributes.get("aria-current"), active ? "page" : undefined, link.dataset.nav);
  }
}

function assertExactlyOneVisiblePage(browser, expected) {
  assertActivePage(browser, expected);
  assert.equal(
    browser.pages.filter((page) => !page.classList.contains("dashboard-page-inactive")).length,
    1,
  );
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
  assertActivePage(browser, "community");
});

test("retired section hashes do not masquerade as live destinations", () => {
  const browser = fakeBrowser({ hash: "#coverage" });
  mountDashboardNavigation(browser);
  assertActivePage(browser, "overview");

  browser.windowRef.location.hash = "#trends";
  browser.listeners.get("hashchange")();
  assertActivePage(browser, "trends");

  browser.windowRef.location.hash = "#coverage";
  browser.listeners.get("hashchange")();
  assertActivePage(browser, "trends");
});

test("retained deep-link aliases select their current owning page", () => {
  const cases = [
    ["accounting", "method"],
    ["timeline", "trends"],
    ["trends", "trends"],
    ["history", "community"],
    ["backend", "community"],
    ["data", "community"],
    ["coverage", "overview"],
  ];

  for (const [target, expected] of cases) {
    const browser = fakeBrowser({ hash: `#${target}` });
    mountDashboardNavigation(browser);
    assertExactlyOneVisiblePage(browser, expected);
  }
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
  const trendsPage = browser.pages.find((page) => page.dataset.dashboardPage === "trends");
  assert.equal(trendsPage.heading.attributes.get("tabindex"), "-1");
  assert.deepEqual(trendsPage.heading.focusOptions, { preventScroll: true });
});

test("native trends hash selects the trends page", () => {
  const browser = fakeBrowser({ hash: "#trends" });
  mountDashboardNavigation(browser);
  assertActivePage(browser, "trends");
  const trendsPage = browser.pages.find((page) => page.dataset.dashboardPage === "trends");
  assert.equal(trendsPage.heading.focusOptions, null, "initial mount does not steal focus");

  browser.windowRef.location.hash = "#overview";
  browser.listeners.get("hashchange")();
  browser.windowRef.location.hash = "#trends";
  browser.listeners.get("hashchange")();
  assert.deepEqual(trendsPage.heading.focusOptions, { preventScroll: true });
});

test("repeated overview and trends transitions keep exactly one page active", () => {
  const browser = fakeBrowser({ hash: "#overview" });
  mountDashboardNavigation(browser);

  for (let index = 0; index < 50; index += 1) {
    const nav = index % 2 === 0 ? "trends" : "overview";
    browser.links.find((link) => link.dataset.nav === nav).click();
    assertExactlyOneVisiblePage(browser, nav);
  }
});

test("repeated transitions and a navigation remount keep exactly one page visible", () => {
  const browser = fakeBrowser({ hash: "#overview" });
  let teardown = mountDashboardNavigation(browser);

  for (const nav of ["trends", "overview", "community", "weekly", "method", "trends"]) {
    browser.links.find((link) => link.dataset.nav === nav).click();
    assertExactlyOneVisiblePage(browser, nav);
  }

  teardown();
  browser.windowRef.location.hash = "#timeline";
  teardown = mountDashboardNavigation(browser);
  assertExactlyOneVisiblePage(browser, "trends");

  for (const [hash, expected] of [
    ["#community", "community"],
    ["#weekly", "weekly"],
    ["#overview", "overview"],
    ["#trends", "trends"],
  ]) {
    browser.windowRef.location.hash = hash;
    browser.listeners.get("hashchange")();
    assertExactlyOneVisiblePage(browser, expected);
  }

  teardown();
});

test("navigation never overrides component-owned hidden state", () => {
  const browser = fakeBrowser({ hash: "#overview" });
  const hiddenOverviewComponent = browser.pages.find(
    (page) => page.dataset.dashboardPage === "overview",
  );
  hiddenOverviewComponent.hidden = true;
  mountDashboardNavigation(browser);

  browser.links.find((link) => link.dataset.nav === "trends").click();
  browser.links.find((link) => link.dataset.nav === "overview").click();

  assert.equal(hiddenOverviewComponent.hidden, true);
  assertActivePage(browser, "overview");
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
