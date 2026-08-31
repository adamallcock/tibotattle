import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { cacheDropThreadLookupKey } from "../public/data-client.js";
import { SUPPORTED_LOCALES, translate } from "../public/localization.js";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const helperStart = source.indexOf("function isCacheDropThreadDashboard(");
const helperEnd = source.indexOf("\nfunction renderAccountingCacheSwitchDetails(", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart);
const helpers = source.slice(helperStart, helperEnd);
const THREAD_ID = "00000001-0000-7000-8000-000000000001";
const PARENT_ID = "00000002-0000-7000-8000-000000000002";
const OBSERVED_AT = "2026-08-25T12:34:00.000Z";

function row(kind = "switch") {
  const configuration = { model: "gpt-5.6-sol", reasoningEffort: "high" };
  return {
    observedAt: OBSERVED_AT,
    gapSeconds: 60,
    previousCacheReadTokens: 120_000,
    currentCacheReadTokens: 20_000,
    lostCacheTokens: 100_000,
    ...(kind === "switch"
      ? { previous: { ...configuration, reasoningEffort: "low" }, current: configuration }
      : { configuration }),
  };
}

function createHarness({ locale = "en-US", lookup, local = true } = {}) {
  const document = { activeElement: null };
  class Element {
    constructor(tagName, className = "", textContent = "") {
      this.tagName = tagName;
      this.className = className;
      this.children = [];
      this.attributes = new Map();
      this.textContent = textContent;
      this.isConnected = true;
    }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
    set innerHTML(_value) { assert.fail("private names must never be interpreted as markup"); }
    set href(value) { this.setAttribute("href", value); }
    get href() { return this.getAttribute("href"); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    append(...children) { this.children.push(...children); }
    contains(target) { return target === this || this.children.some((child) => child.contains?.(target)); }
    querySelectorAll(selector) {
      const matches = (node) => selector.startsWith(".")
        ? node.className?.split(" ").includes(selector.slice(1))
        : node.tagName === selector;
      return this.children.flatMap((child) => [
        ...(matches(child) ? [child] : []),
        ...(child.querySelectorAll?.(selector) ?? []),
      ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    focus(options) { document.activeElement = this; this.focusOptions = options; }
  }
  document.createTextNode = (textContent) => ({ textContent });
  const state = {
    dashboard: null, generation: null, requestToken: 0, loadToken: 0,
    requested: false, entries: new Map(), cells: { switch: [], continuity: [] },
  };
  const dependencies = {
    dashboard: null,
    cacheDropThreadLinks: state,
    cacheDropThreadLookupKey,
    localClient: lookup === undefined ? {} : { cacheDropThreadLinks: lookup },
    isLoopbackDashboard: () => local,
    document,
    clear: (element) => { element.textContent = ""; },
    rawNode: (tag, className, value) => {
      const element = new Element(tag, className, value);
      element.setAttribute("data-i18n-skip", "");
      return element;
    },
    formatLocal: (value) => `local(${value})`,
    t: (key, values) => translate(key, values, locale),
  };
  const api = Function(...Object.keys(dependencies), `${helpers}
    return {
      parts: cacheDropThreadParts,
      fill: fillCacheDropThreadCell,
      cell: cacheDropThreadCell,
      load: loadCacheDropThreadLinks,
      reset: resetCacheDropThreadLinks,
      setDashboard(data) { dashboard = data; resetCacheDropThreadLinks(data); },
    };`)(...Object.values(dependencies));
  return { ...api, state, document, Element };
}

function localDashboard(generation = "35") {
  return { mode: "local", accounting: { generation, generationMatched: true } };
}

function lookupResult(kind = "switch", generation = "35", thread = {}) {
  return {
    schemaVersion: "local-cache-drop-thread-links-v1",
    status: "available",
    generation,
    entries: [{ kind, key: cacheDropThreadLookupKey(kind, row(kind)), thread: {
      id: THREAD_ID, name: "Synthetic thread", nickname: null, parent: null, ...thread,
    } }],
  };
}

test("both drop tables link raw titles to exact Codex thread UUIDs with accessible local time", () => {
  for (const locale of SUPPORTED_LOCALES) {
    const harness = createHarness({ locale });
    for (const kind of ["switch", "continuity"]) {
      const title = '<img src=x onerror="secret()"> & Configuration';
      const evidence = lookupResult(kind, "35", { name: title, href: "javascript:secret()" });
      harness.state.entries.set(evidence.entries[0].key, evidence.entries[0].thread);
      const cell = harness.cell(kind, row(kind));
      assert.equal(cell.textContent, title, "private titles remain literal, untranslated text");
      const links = cell.querySelectorAll("a");
      assert.equal(links.length, 1);
      assert.equal(links[0].href, `codex://threads/${THREAD_ID}`);
      assert.equal(links[0].getAttribute("data-i18n-skip"), "");
      assert.equal(links[0].getAttribute("rel"), "noreferrer");
      assert.match(links[0].getAttribute("title"), /local\(2026-08-25T12:34:00\.000Z\)/u);
      assert.match(links[0].getAttribute("aria-label"), /Codex/u);
      assert.ok(links[0].getAttribute("aria-label").includes(title));
      assert.ok(links[0].getAttribute("aria-label").includes(links[0].getAttribute("title")));
      assert.equal(cell.getAttribute("title"), links[0].getAttribute("title"));
      assert.equal(cell.querySelectorAll("img").length, 0);
      assert.equal(cell.getAttribute("data-label"), translate("accounting.cacheDropThread.column", {}, locale));
    }
  }
});

test("workers have distinct parent and worker links and never infer a missing parent", () => {
  const harness = createHarness();
  const cell = new harness.Element("td");
  const worker = { id: THREAD_ID, name: null, nickname: "Peirce", parent: { id: PARENT_ID, name: "Synthetic parent" } };
  harness.fill(cell, worker, OBSERVED_AT);
  assert.equal(cell.textContent, "Synthetic parent [Peirce subworker]");
  assert.deepEqual(cell.querySelectorAll("a").map((link) => [link.textContent, link.href]), [
    ["Synthetic parent", `codex://threads/${PARENT_ID}`],
    ["Peirce subworker", `codex://threads/${THREAD_ID}`],
  ]);
  harness.fill(cell, { ...worker, parent: null }, OBSERVED_AT);
  assert.equal(cell.textContent, "[Peirce subworker]");
  assert.deepEqual(cell.querySelectorAll("a").map((link) => link.href), [`codex://threads/${THREAD_ID}`]);
  harness.fill(cell, { ...worker, nickname: null, parent: { id: PARENT_ID, name: null } }, OBSERVED_AT);
  assert.equal(cell.textContent, "Thread 00000002 [Thread 00000001 subworker]");
  harness.fill(cell, { id: THREAD_ID, name: null, nickname: null, parent: null }, OBSERVED_AT);
  assert.equal(cell.textContent, "Thread 00000001");
  assert.equal(cell.querySelector("a").href, `codex://threads/${THREAD_ID}`);
});

test("unsafe, malformed and absent thread IDs never become links", () => {
  const harness = createHarness();
  const cell = new harness.Element("td");
  for (const id of [null, "", 123, ` ${THREAD_ID}`, `${THREAD_ID}\n`, `${THREAD_ID}?x=1`, `${THREAD_ID}#extra`,
    `javascript:${THREAD_ID}`, `codex://threads/${THREAD_ID}`, `${THREAD_ID}/../settings`,
    "00000001-0000-7000-1000-000000000001", "00000001-0000-0000-8000-000000000001"]) {
    harness.fill(cell, { id, name: "Untrusted title", parent: { id: PARENT_ID, name: "Parent" } }, OBSERVED_AT);
    assert.equal(cell.textContent, "Thread unavailable");
    assert.equal(cell.querySelectorAll("a").length, 0);
    assert.equal(cell.querySelector(".cache-drop-thread-unavailable").tabIndex, 0);
    assert.match(cell.querySelector("span").querySelector("span").getAttribute("aria-label"), /local\(/u);
  }
  harness.fill(cell, null, OBSERVED_AT);
  assert.equal(cell.textContent, "Thread unavailable");
  harness.fill(cell, { id: THREAD_ID, name: "Valid", parent: { id: `https://example.test/${PARENT_ID}`, name: "Unsafe parent" } }, OBSERVED_AT);
  assert.equal(cell.textContent, "Valid");
  assert.equal(cell.querySelectorAll("a").length, 1);
  harness.fill(cell, { id: THREAD_ID.toUpperCase(), name: "Valid", parent: { id: THREAD_ID, name: "Self-parent" } }, OBSERVED_AT);
  assert.equal(cell.textContent, "Valid");
  assert.equal(cell.querySelector("a").href, `codex://threads/${THREAD_ID}`);
});

test("asynchronous enrichment updates the existing cells and preserves keyboard focus", async () => {
  const ready = Promise.withResolvers();
  let calls = 0;
  const harness = createHarness({ lookup: () => { calls += 1; return ready.promise; } });
  const data = localDashboard();
  harness.setDashboard(data);
  const cell = harness.cell("switch", row());
  cell.querySelector(".cache-drop-thread-unavailable").focus();
  const pending = harness.load(data);
  assert.equal(cell.textContent, "Thread unavailable", "the dashboard need not await private lookup");
  assert.equal(calls, 1);
  await harness.load(data);
  assert.equal(calls, 1, "same-dashboard rerenders do not refetch");
  ready.resolve(lookupResult());
  await pending;
  assert.equal(cell.textContent, "Synthetic thread");
  assert.equal(harness.state.cells.switch[0].cell, cell);
  assert.equal(harness.document.activeElement, cell.querySelector("a"));
  assert.deepEqual(harness.document.activeElement.focusOptions, { preventScroll: true });
  assert.deepEqual(data, localDashboard(), "thread enrichment never mutates dashboard/accounting DTOs");
  harness.reset();
  assert.equal(cell.textContent, "Thread unavailable", "unavailable dashboard clears existing names");
  assert.equal(harness.state.entries.size, 0);
});

test("the real local companion mode loads thread names as well as the default local mode", async () => {
  const harness = createHarness({ lookup: async () => lookupResult() });
  const data = { ...localDashboard(), mode: "real_local_evidence" };
  harness.setDashboard(data);
  const cell = harness.cell("switch", row());
  await harness.load(data);
  assert.equal(cell.textContent, "Synthetic thread");
  assert.equal(cell.querySelector("a").href, `codex://threads/${THREAD_ID}`);
});

test("late lookup is fenced by generation, match attestation, dashboard identity and load token", async () => {
  for (const scenario of ["foreign-generation", "generation-mutated", "attestation-changed", "new-dashboard", "new-load", "demo", "mode-mutated"]) {
    const ready = Promise.withResolvers();
    const harness = createHarness({ lookup: () => ready.promise });
    const data = localDashboard();
    harness.setDashboard(data);
    const cell = harness.cell("switch", row());
    const pending = harness.load(data);
    if (scenario === "generation-mutated") data.accounting.generation = "36";
    if (scenario === "attestation-changed") data.accounting.generationMatched = false;
    if (scenario === "new-dashboard") harness.setDashboard(localDashboard());
    if (scenario === "new-load") harness.state.loadToken += 1;
    if (scenario === "demo") harness.setDashboard({ ...localDashboard(), mode: "demo" });
    if (scenario === "mode-mutated") data.mode = "demo";
    ready.resolve(lookupResult("switch", scenario === "foreign-generation" ? "36" : "35"));
    await pending;
    assert.equal(cell.textContent, "Thread unavailable", scenario);
    assert.equal(harness.state.entries.size, 0, scenario);
  }
});

test("missing route, unavailable metadata, demo and non-local pages retain a quiet fallback", async () => {
  for (const lookup of [undefined, async () => { throw new Error("private path"); },
    async () => ({ schemaVersion: "local-cache-drop-thread-links-v1", status: "unavailable", generation: null, entries: [] })]) {
    const harness = createHarness({ lookup });
    const data = localDashboard();
    harness.setDashboard(data);
    const cell = harness.cell("continuity", row("continuity"));
    await assert.doesNotReject(harness.load(data));
    assert.equal(cell.textContent, "Thread unavailable");
    assert.equal(harness.state.entries.size, 0);
  }
  for (const data of [{ ...localDashboard(), mode: "demo" }, localDashboard(null),
    { mode: "local", accounting: { generation: "35", generationMatched: false } }]) {
    let calls = 0;
    const harness = createHarness({ lookup: async () => { calls += 1; return lookupResult(); } });
    harness.setDashboard(data);
    await harness.load(data);
    assert.equal(calls, 0);
  }
  let calls = 0;
  const harness = createHarness({ local: false, lookup: async () => { calls += 1; return lookupResult(); } });
  const data = localDashboard();
  harness.setDashboard(data);
  await harness.load(data);
  assert.equal(calls, 0);
});

test("both drop tables replace local time with localized thread names and preserve their columns", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  for (const kind of ["switch", "continuity"]) {
    const details = html.match(new RegExp(`<details[^>]+id="cache-${kind}-details"[\\s\\S]*?<\\/details>`, "u"))?.[0];
    assert.ok(details);
    assert.equal((details.match(/<th\b/gu) ?? []).length, kind === "switch" ? 5 : 6);
    assert.match(details, /data-i18n="accounting\.cacheDropThread\.column">Thread name<\/th>/u);
    assert.doesNotMatch(details, /column\.localTime|>Local time<\/th>/u);
    assert.ok(source.includes(`cacheDropThreadCell("${kind}", item)`));
    assert.ok(styles.includes(`#cache-${kind}-details tbody td::before`));
  }
  assert.match(styles, /\.cache-drop-thread-cell\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/u);
  assert.doesNotMatch(helpers, /innerHTML|insertAdjacentHTML|localStorage|sessionStorage|console\./u);
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of ["column", "unavailable", "fallback", "subworker", "localTime", "open"]) {
      const translated = translate(`accounting.cacheDropThread.${key}`, { id: "00000001", name: "Synthetic", time: "12:34" }, locale);
      assert.doesNotMatch(translated, /accounting\.|\{(?:id|name|time)\}/u);
    }
  }
});

test("continuity rows preserve six translated columns, lost tokens and the empty-state span", () => {
  const start = source.indexOf("function renderAccountingCacheContinuityDetails(");
  const end = source.indexOf("\nfunction sideChatConfigurationDescription(", start);
  assert.ok(start >= 0 && end > start);
  for (const locale of SUPPORTED_LOCALES) {
    const harness = createHarness({ locale });
    const rows = new harness.Element("tbody");
    const disclosure = new harness.Element("details");
    const message = (key) => translate(key, {}, locale);
    const dependencies = {
      $: (selector) => selector === "#cache-continuity-rows" ? rows : disclosure,
      cacheDropThreadLinks: harness.state,
      clear: (element) => { element.textContent = ""; },
      renderAccountingCacheReuseOutcome: () => {},
      renderCacheImpactPagination: () => {},
      cacheContinuityTablePagination: {},
      paginateCacheImpactRows: (recent) => ({ rows: recent }),
      cacheImpactTableSignature: () => "synthetic-continuity",
      node: (tag) => new harness.Element(tag),
      localizedNode: (tag, className, key) => new harness.Element(tag, className, message(key)),
      cacheDropThreadCell: harness.cell,
      cacheSwitchDataCell: (className, value, key) => {
        const cell = new harness.Element("td", className, value);
        cell.setAttribute("data-label", message(key));
        return cell;
      },
      formatCacheContinuityGap: (seconds) => `${seconds} seconds`,
      cacheContinuityConfigurationDescription: () => "GPT-5.6 Sol · High",
      formatCount: String,
      formatApiMoney: (value) => `$${value.toFixed(2)}`,
    };
    const render = Function(...Object.keys(dependencies),
      `${source.slice(start, end)}; return renderAccountingCacheContinuityDetails;`)(
      ...Object.values(dependencies),
    );
    render({ status: "available", recent: [{ ...row("continuity"), estimatedPremiumUsd: 0.3 }] });
    assert.equal(rows.children.length, 1);
    assert.equal(rows.children[0].children.length, 6);
    assert.deepEqual(rows.children[0].children.map((cell) => cell.getAttribute("data-label")), [
      "accounting.cacheDropThread.column",
      "accounting.cacheContinuity.column.gap",
      "accounting.cacheContinuity.column.configuration",
      "accounting.cacheContinuity.column.cacheRead",
      "accounting.cacheContinuity.column.lostTokens",
      "accounting.cacheContinuity.column.apiEquivalent",
    ].map(message));
    assert.deepEqual(rows.children[0].children.map((cell) => cell.textContent), [
      message("accounting.cacheDropThread.unavailable"), "60 seconds", "GPT-5.6 Sol · High",
      "120000 → 20000", "100000", "$0.30",
    ]);
    assert.equal(harness.state.cells.continuity.length, 1);
    render({ status: "available", recent: [] });
    assert.equal(rows.children.length, 1);
    assert.equal(rows.children[0].children.length, 1);
    assert.equal(rows.children[0].children[0].colSpan, 6);
    assert.equal(rows.children[0].children[0].textContent, message("accounting.cacheContinuity.detailsEmpty"));
    assert.equal(harness.state.cells.continuity.length, 0);
  }
});

test("narrow drop cards wrap long localized labels inside their own grid track", async () => {
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const mobileStart = styles.indexOf("@media (max-width: 640px) {", styles.indexOf(".cache-drop-thread-cell"));
  assert.ok(mobileStart >= 0);
  const mobile = styles.slice(mobileStart, styles.indexOf("\n.accounting-bars", mobileStart));
  const labels = mobile.match(/#cache-switch-details tbody td::before,\s*#cache-continuity-details tbody td::before\s*\{([^}]+)\}/u)?.[1];
  assert.ok(labels, "both evidence tables share the narrow-screen label rule");
  assert.match(labels, /min-width:\s*0;/u);
  assert.match(labels, /overflow-wrap:\s*anywhere;/u,
    "an unbroken heading such as CONFIGURATION must wrap before reaching its value");
  assert.match(mobile, /grid-template-columns:\s*minmax\(0, 42%\) minmax\(0, 1fr\);/u,
    "wrapping preserves the existing label/value track widths");
});
