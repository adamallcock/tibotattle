import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { formatReportingTime } from "../public/ui-format.js";
import { createAdminAllowancePreviewPayload } from "./fixtures/admin-allowance.js";

const fixture = async (name) => JSON.parse(await readFile(
  new URL(`./fixtures/${name}`, import.meta.url),
  "utf8",
));

class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.className = "";
    this.disabled = false;
    this.hidden = false;
    this.id = "";
    this.innerHTML = "";
    this.listeners = new Map();
    this.offsetHeight = 0;
    this.offsetWidth = 0;
    this.rect = { bottom: 0, left: 0, top: 0 };
    this.style = {};
    this.textContent = "";
    this.type = "";
    this.value = "";
    this.checked = false;
    this.attributes = new Map();
    this.dataset = {};
    this.parentNode = null;
    this.ownerDocument = null;
    this.classList = {
      contains: (name) => this.className.split(/\s+/u).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/u).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/u).filter((name) => !names.includes(name)).join(" "); },
      toggle: (name, force) => {
        const active = force ?? !this.classList.contains(name);
        this.classList[active ? "add" : "remove"](name);
        return active;
      },
    };
  }

  append(...nodes) {
    for (const node of nodes) node.parentNode = this;
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    for (const node of this.children) node.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  setAttribute(name, value) {
    const copy = String(value);
    this.attributes.set(name, copy);
    if (name === "id") this.id = copy;
    if (name === "class") this.className = copy;
    if (name.startsWith("data-")) this.dataset[dataKey(name)] = copy;
  }

  getAttribute(name) {
    if (name === "class") return this.className;
    if (name.startsWith("data-")) return this.dataset[dataKey(name)] ?? null;
    return this.attributes.get(name) ?? null;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  querySelectorAll(selector) {
    return this.children.flatMap(descendantNodes).filter((node) => matchesSelector(node, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector) {
    for (let node = this; node; node = node.parentNode) {
      if (matchesSelector(node, selector)) return node;
    }
    return null;
  }

  focus() {
    if (this.disabled) return;
    this.ownerDocument.activeElement = this;
    this.listeners.get("focus")?.({ target: this });
  }
}

function dataKey(name) {
  return name.slice(5).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

// Only the tag/class/data selectors used by the real admin allowance renderer
// and these interaction checks; this is not a general browser replacement.
function matchesSimpleSelector(node, selector) {
  const attributes = [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/gu)];
  const bare = selector.replace(/\[[^\]]*\]/gu, "");
  const tag = bare.match(/^[\w-]+/u)?.[0];
  if (tag && node.tag !== tag) return false;
  for (const [, className] of bare.matchAll(/\.([\w-]+)/gu)) {
    if (!node.classList.contains(className)) return false;
  }
  for (const [, name, value] of attributes) {
    const actual = node.getAttribute(name);
    if (actual === null || (value !== undefined && value !== actual)) return false;
  }
  return true;
}

function matchesSelector(node, selector) {
  return selector.split(",").some((choice) => {
    const parts = choice.trim().split(/\s+(?![^\[]*\])/u);
    if (!matchesSimpleSelector(node, parts.pop())) return false;
    let ancestor = node.parentNode;
    while (parts.length > 0) {
      const part = parts.pop();
      while (ancestor && !matchesSimpleSelector(ancestor, part)) ancestor = ancestor.parentNode;
      if (!ancestor) return false;
      ancestor = ancestor.parentNode;
    }
    return true;
  });
}

function fakeDocument() {
  const byId = new Map([
    "notice",
    "operator-attention-badge",
    "operator-attention",
    "counts",
    "quarantine-status-badge",
    "quarantine-counts",
    "quarantine-status",
    "distribution-status",
    "distribution-counts",
    "distribution-version-rows",
    "distribution-version-empty",
    "distribution-source-status",
    "github-release-rows",
    "github-release-empty",
    "service-state",
    "ingress-status",
    "lifecycle-status",
    "snapshot-rows",
    "snapshot-empty",
    "error-groups",
    "error-empty",
    "recent-diagnostic-rows",
    "recent-diagnostic-empty",
    "diagnostic-lookup",
    "diagnostic-reference",
    "diagnostic-retention-summary",
    "audit-rows",
    "audit-empty",
    "audit-pagination",
    "audit-previous",
    "audit-next",
    "audit-page-status",
    "last-refresh",
    "refresh",
    "diagnostic-form",
    "controls-form",
    "run-maintenance",
    "maintenance-result",
  ].map((id) => [id, new FakeNode("div")]));
  byId.get("diagnostic-reference").value = "";
  byId.get("last-refresh").textContent = "Not loaded";
  const controls = new Map([
    "enrollment",
    "uploadRegistration",
    "processing",
    "publication",
  ].map((name) => [name, new FakeNode("input")]));

  const documentRef = {
    byId,
    activeElement: null,
    createElement(tag) {
      const node = new FakeNode(tag);
      node.ownerDocument = documentRef;
      return node;
    },
    createElementNS(_namespace, tag) {
      return this.createElement(tag);
    },
    createTextNode(value) {
      const node = this.createElement("#text");
      node.textContent = value;
      return node;
    },
    querySelector(selector) {
      const control = selector.match(/^input\[name="([^"]+)"\]$/u);
      if (control) return controls.get(control[1]);
      if (!selector.startsWith("#")) {
        return [...byId.values()].flatMap(descendantNodes)
          .find((node) => matchesSelector(node, selector)) ?? null;
      }
      assert.match(selector, /^#[\w-]+$/u);
      const node = byId.get(selector.slice(1));
      assert.ok(node, `unexpected selector: ${selector}`);
      return node;
    },
  };
  for (const node of [...byId.values(), ...controls.values()]) node.ownerDocument = documentRef;
  return documentRef;
}

function response(body) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    },
  };
}

function tableTexts(documentRef, id) {
  return documentRef.byId.get(id).children.map((row) =>
    row.children.map((cell) => cell.textContent));
}

function descendantNodes(node) {
  return [node, ...node.children.flatMap(descendantNodes)];
}

function reconstructionText(documentRef) {
  return descendantNodes(documentRef.byId.get("admin-reconstruction-details"))
    .map((node) => node.textContent).filter(Boolean).join(" ");
}

function metricTexts(documentRef, id) {
  return documentRef.byId.get(id).children.map((card) => [
    card.children[0].children[0].textContent,
    card.children[1].textContent,
    card.children[2].textContent,
  ]);
}

function statusTexts(documentRef, id) {
  return documentRef.byId.get(id).children.map((line) => [
    `${line.children[0].children[0].children[0].textContent}: `,
    line.children[1].textContent,
  ]);
}

function assertInfoHint(labelNode, label) {
  assert.equal(labelNode.children[0].textContent, label);
  const hint = labelNode.children[1];
  assert.equal(hint.className, "admin-info");
  const [trigger, tooltip] = hint.children;
  assert.equal(trigger.tag, "button");
  assert.equal(trigger.type, "button");
  assert.equal(trigger.textContent, "i");
  assert.equal(trigger.getAttribute("aria-label"), `Explain ${label}`);
  assert.equal(trigger.getAttribute("aria-describedby"), tooltip.id);
  assert.equal(trigger.listeners.has("mouseenter"), true);
  assert.equal(trigger.listeners.has("focus"), true);
  assert.equal(tooltip.getAttribute("role"), "tooltip");
  assert.notEqual(tooltip.textContent.trim(), "");
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for the admin view to render");
}

async function withAdminPage(fetchResponse, check) {
  const documentRef = fakeDocument();
  const html = await readFile(new URL("../public/admin.html", import.meta.url), "utf8");
  for (const [, id] of html.matchAll(/\bid="([\w-]+)"/gu)) {
    if (!documentRef.byId.has(id)) documentRef.byId.set(id, documentRef.createElement("div"));
  }
  for (const [, attributes, kind, label] of html.matchAll(/<button\b([^>]*data-(allowance-mode|range-days)[^>]*)>([^<]*)<\/button>/gu)) {
    const button = documentRef.createElement("button");
    for (const [, name, value] of attributes.matchAll(/([\w-]+)="([^"]*)"/gu)) button.setAttribute(name, value);
    button.textContent = label;
    documentRef.byId.get(kind === "allowance-mode" ? "admin-community-mode-controls" : "admin-community-range-controls").append(button);
  }
  documentRef.body = { classList: { contains: (name) => name === "admin-operator-page" } };
  documentRef.addEventListener = () => {};
  documentRef.querySelectorAll = () => [];
  documentRef.byId.get("notice").hidden = true;
  documentRef.byId.get("service-state").textContent = "Checking session…";
  const storedPreferences = new Map([
    ["tibotattle-admin-auto-refresh-minutes-v1", "0"],
  ]);
  const replacements = {
    document: documentRef,
    fetch: fetchResponse,
    window: { innerHeight: 844, innerWidth: 390, addEventListener() {} },
    localStorage: {
      getItem: (key) => storedPreferences.get(key) ?? null,
      setItem: (key, value) => storedPreferences.set(key, value),
    },
    // Keep actual load/refresh execution while preventing background timers
    // from outliving the isolated page and touching a later test's globals.
    setInterval: () => 0,
  };
  const descriptors = new Map(Object.keys(replacements).map((key) => [
    key, Object.getOwnPropertyDescriptor(globalThis, key),
  ]));
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  try {
    const moduleUrl = new URL("../public/admin.js", import.meta.url);
    moduleUrl.search = `?admin-refresh-test=${process.hrtime.bigint()}`;
    await import(moduleUrl.href);
    await check(documentRef, storedPreferences);
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

function unavailableResponse() {
  return {
    ok: false,
    status: 500,
    async json() {
      return { error: { code: "INTERNAL_ERROR" } };
    },
  };
}

test("an initial overview failure marks operations unavailable without inventing a successful snapshot", async () => {
  const requests = [];
  await withAdminPage(async (path) => {
    requests.push(path);
    return unavailableResponse();
  }, async (documentRef) => {
    await waitFor(() => !documentRef.byId.get("notice").hidden);
    assert.deepEqual(requests, ["/api/v1/admin/overview"]);
    assert.equal(documentRef.byId.get("last-refresh").textContent, "Not loaded");
    assert.equal(documentRef.byId.get("service-state").textContent,
      "Refresh unavailable · no successful data loaded");
    assert.equal(documentRef.byId.get("operator-attention-badge").textContent,
      "Unavailable · not loaded");
    assert.equal(documentRef.byId.get("operator-attention-badge").className,
      "admin-source-badge admin-source-partial");
    assert.equal(documentRef.byId.get("counts").children.length, 0);
    assert.equal(documentRef.byId.get("refresh").disabled, false);
    assert.equal(documentRef.title, "• TiboTattle operations");
    assert.equal(documentRef.byId.get("notice").textContent,
      "Operations view unavailable: INTERNAL_ERROR.");
  });
});

test("overview success, failed refresh, and recovery preserve then replace the last successful data", async () => {
  const overview = await fixture("admin-overview-valid.json");
  overview.reconstruction = await fixture("admin-reconstruction-valid.json");
  const recovered = structuredClone(overview);
  recovered.generatedAt = "2026-08-18T12:00:00.000Z";
  recovered.counts.contributions.acceptedLast24Hours += 1;
  recovered.reconstruction.observedAt = "2026-09-06T12:05:00.000Z";
  recovered.reconstruction.calculations.completedAccounts += 1;
  recovered.reconstruction.calculations.scanningAccounts -= 1;
  recovered.reconstruction.calculations.checkpointsWritten = 21;
  const overviewResponses = [response(overview), unavailableResponse(), response(recovered)];
  let overviewRequests = 0;
  await withAdminPage(async (path) => path === "/api/v1/admin/overview"
    ? overviewResponses[overviewRequests++]
    : unavailableResponse(), async (documentRef, storedPreferences) => {
    await waitFor(() => documentRef.byId.get("admin-community-status").textContent === "Preview unavailable"
      && documentRef.byId.get("growth-status").textContent === "History unavailable");
    const counts = metricTexts(documentRef, "counts");
    const lastRefresh = documentRef.byId.get("last-refresh").textContent;
    const preferences = [...storedPreferences];
    assert.equal(documentRef.byId.get("service-state").textContent, "production · operational");
    assert.equal(documentRef.byId.get("operator-attention-badge").textContent, "No action indicated");
    assert.match(reconstructionText(documentRef), /3 of 8 tracked accounts/u);

    await documentRef.byId.get("refresh").listeners.get("click")();
    assert.equal(overviewRequests, 2);
    assert.equal(documentRef.byId.get("service-state").textContent,
      "Refresh unavailable · showing last successful data");
    assert.equal(documentRef.byId.get("operator-attention-badge").textContent,
      "Stale · refresh unavailable");
    assert.equal(documentRef.byId.get("operator-attention-badge").className,
      "admin-source-badge admin-source-partial");
    assert.equal(documentRef.byId.get("last-refresh").textContent, lastRefresh);
    assert.deepEqual(metricTexts(documentRef, "counts"), counts);
    assert.deepEqual([...storedPreferences], preferences);
    assert.equal(documentRef.byId.get("notice").hidden, false);
    assert.equal(documentRef.byId.get("admin-reconstruction-status").textContent, "Stale · last known progress");
    assert.match(documentRef.byId.get("admin-reconstruction-progress").className, /admin-reconstruction-stale/u);
    assert.match(reconstructionText(documentRef), /3 of 8 tracked accounts/u);
    assert.match(reconstructionText(documentRef), /Refresh failed; showing the last available observation/u);
    assert.ok(reconstructionText(documentRef).includes(formatReportingTime(overview.reconstruction.observedAt)));

    await documentRef.byId.get("refresh").listeners.get("click")();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(overviewRequests, 3);
    assert.equal(documentRef.byId.get("service-state").textContent, "production · operational");
    assert.equal(documentRef.byId.get("operator-attention-badge").textContent, "No action indicated");
    assert.equal(documentRef.byId.get("operator-attention-badge").className,
      "admin-source-badge admin-source-available");
    assert.equal(documentRef.byId.get("last-refresh").textContent, formatReportingTime(recovered.generatedAt));
    assert.notEqual(documentRef.byId.get("last-refresh").textContent, lastRefresh);
    assert.deepEqual(metricTexts(documentRef, "counts").find(([label]) => label === "Accepted uploads last 24h"),
      ["Accepted uploads last 24h", "6", "14 in the last 7 days"]);
    assert.equal(documentRef.byId.get("notice").hidden, true);
    assert.equal(documentRef.title, "TiboTattle operations");
    assert.equal(documentRef.byId.get("admin-reconstruction-status").textContent, "Resumable calculation");
    assert.doesNotMatch(documentRef.byId.get("admin-reconstruction-progress").className, /stale/u);
    assert.match(reconstructionText(documentRef), /4 of 8 tracked accounts/u);
    assert.match(reconstructionText(documentRef), /21 checkpoint steps saved in current runs/u);
    assert.doesNotMatch(reconstructionText(documentRef), /42 checkpoint steps/u);
    assert.doesNotMatch(reconstructionText(documentRef), /Refresh failed/u);
    assert.ok(reconstructionText(documentRef).includes(formatReportingTime(recovered.reconstruction.observedAt)));
  });
});

test("an independent allowance-preview failure does not mark a successful overview stale", async () => {
  const overview = await fixture("admin-overview-valid.json");
  overview.reconstruction = await fixture("admin-reconstruction-valid.json");
  const requests = [];
  await withAdminPage(async (path) => {
    requests.push(path);
    return path === "/api/v1/admin/overview" ? response(overview) : unavailableResponse();
  }, async (documentRef) => {
    await waitFor(() => documentRef.byId.get("admin-community-status").textContent === "Preview unavailable"
      && documentRef.byId.get("growth-status").textContent === "History unavailable");
    assert.deepEqual(requests, [
      "/api/v1/admin/overview",
      "/api/v1/admin/community/allowance-preview",
      "/api/v1/admin/metrics/history",
    ]);
    assert.equal(documentRef.byId.get("service-state").textContent, "production · operational");
    assert.equal(documentRef.byId.get("operator-attention-badge").textContent, "No action indicated");
    assert.equal(documentRef.byId.get("operator-attention-badge").className,
      "admin-source-badge admin-source-available");
    assert.equal(documentRef.byId.get("notice").hidden, true);
    assert.equal(documentRef.byId.get("last-refresh").textContent, formatReportingTime(overview.generatedAt));
    assert.equal(documentRef.title, "TiboTattle operations");
    assert.equal(documentRef.byId.get("admin-reconstruction-status").textContent, "Resumable calculation");
    assert.match(reconstructionText(documentRef), /3 of 8 tracked accounts/u);
    assert.equal(documentRef.byId.get("admin-reconstruction-progress").hidden, false);
  });
});

test("reconstruction shows checkpoint acquisition separately from daily publication without new requests", async () => {
  const overview = await fixture("admin-overview-valid.json");
  overview.reconstruction = await fixture("admin-reconstruction-valid.json");
  const requests = [];
  await withAdminPage(async (path) => {
    requests.push(path);
    return path === "/api/v1/admin/overview" ? response(overview) : unavailableResponse();
  }, async (documentRef) => {
    await waitFor(() => documentRef.byId.get("growth-status").textContent === "History unavailable");
    const text = reconstructionText(documentRef);
    assert.match(text, /Daily publication waits for account calculations/u);
    assert.match(text, /Acquired checkpoints are saved calculation inputs, not ready allowance estimates/u);
    assert.match(text, /Record lookup Complete/u);
    assert.match(text, /3 of 8 tracked accounts/u);
    assert.match(text, /Preparing 1 · scanning 2 · finalizing 1 · source, window or method changed 1/u);
    assert.match(text, /42 checkpoint steps saved in current runs/u);
    assert.ok(text.includes(`Latest cached result: ${formatReportingTime(overview.reconstruction.calculations.newestResultAt)} (may be outdated)`));
    assert.doesNotMatch(text, /Lookup position/u);
    assert.match(text, /Daily publication Updating/u);
    assert.match(text, /5 pending days across all history/u);
    assert.match(text, /Last 366 days: 10 published · 7 with price data \(may be partial\)/u);
    assert.match(text, /maintenance lock held/u);
    assert.doesNotMatch(text, /maintenance running/u);
    assert.match(text, /no time estimate is available/u);
    assert.doesNotMatch(text, /\d+%|ETA/u);
    const meters = descendantNodes(documentRef.byId.get("admin-reconstruction-details"))
      .filter((node) => node.tag === "progress");
    assert.equal(meters.length, 1);
    assert.equal(meters[0].getAttribute("max"), "8");
    assert.equal(meters[0].getAttribute("value"), "3");
    assert.equal(meters[0].getAttribute("aria-label"), "Account checkpoint acquisition");
    assert.equal(meters[0].getAttribute("aria-valuetext"), "3 of 8 tracked accounts have acquired checkpoints");
    assert.equal(meters[0].getAttribute("aria-describedby"), "admin-reconstruction-explanation");
    assert.deepEqual(requests, [
      "/api/v1/admin/overview", "/api/v1/admin/community/allowance-preview", "/api/v1/admin/metrics/history",
    ]);
  });
});

test("unavailable, legacy missing and malformed reconstruction stay isolated from a valid overview", async () => {
  for (const kind of ["unavailable", "missing", "malformed"]) {
    const overview = await fixture("admin-overview-valid.json");
    if (kind === "unavailable") overview.reconstruction = {
      schemaVersion: "admin-reconstruction-progress-v0.1", status: "unavailable",
      observedAt: "2026-09-06T12:00:00.000Z", mode: "unknown",
    };
    if (kind === "malformed") {
      overview.reconstruction = await fixture("admin-reconstruction-valid.json");
      overview.reconstruction.calculations.completedAccounts = 100;
    }
    await withAdminPage(async (path) => path === "/api/v1/admin/overview"
      ? response(overview) : unavailableResponse(), async (documentRef) => {
      await waitFor(() => documentRef.byId.get("growth-status").textContent === "History unavailable");
      assert.equal(documentRef.byId.get("service-state").textContent, "production · operational", kind);
      assert.equal(documentRef.byId.get("notice").hidden, true, kind);
      assert.equal(documentRef.byId.get("admin-reconstruction-status").textContent, "Progress unavailable", kind);
      assert.match(reconstructionText(documentRef), /Missing progress does not mean there is no work remaining/u, kind);
      assert.doesNotMatch(reconstructionText(documentRef), /0 tracked|0 pending|0 published/u, kind);
      assert.equal(descendantNodes(documentRef.byId.get("admin-reconstruction-details"))
        .some((node) => node.tag === "progress"), false, kind);
    });
  }
});

test("paused and bounded reconstruction qualifies account and daily counts", async () => {
  const overview = await fixture("admin-overview-valid.json");
  overview.reconstruction = await fixture("admin-reconstruction-valid.json");
  overview.reconstruction.mode = "paused";
  overview.reconstruction.lookup.complete = false;
  overview.reconstruction.lookup.lastRecordId = 600;
  overview.reconstruction.calculations.bounded = true;
  overview.reconstruction.maintenance.running = false;
  overview.reconstruction.publication.pendingDaysBounded = true;
  await withAdminPage(async (path) => path === "/api/v1/admin/overview"
    ? response(overview) : unavailableResponse(), async (documentRef) => {
    await waitFor(() => documentRef.byId.get("growth-status").textContent === "History unavailable");
    assert.equal(documentRef.byId.get("admin-reconstruction-status").textContent, "Paused");
    assert.match(reconstructionText(documentRef), /Record lookup In progress/u);
    assert.match(reconstructionText(documentRef), /Lookup position: 600 \/ 1,200\. Positions may have gaps; not a processed-record count/u);
    assert.match(reconstructionText(documentRef), /3 of 8 shown tracked accounts/u);
    assert.match(reconstructionText(documentRef), /At least 8 tracked accounts; the meter covers only those shown, not overall completion/u);
    assert.match(reconstructionText(documentRef), /At least 5 pending days/u);
    assert.match(reconstructionText(documentRef), /Paused · maintenance idle/u);
  });
});

test("zero tracked reconstruction accounts show recorded zeros without an indeterminate completion meter", async () => {
  const overview = await fixture("admin-overview-valid.json");
  overview.reconstruction = await fixture("admin-reconstruction-valid.json");
  for (const key of ["trackedAccounts", "completedAccounts", "preparingAccounts", "scanningAccounts", "finalizingAccounts", "sourceChangedAccounts", "checkpointsWritten"]) {
    overview.reconstruction.calculations[key] = 0;
  }
  overview.reconstruction.calculations.newestResultAt = null;
  overview.reconstruction.maintenance = { running: false, lastRunAt: null, leaseExpiresAt: null };
  overview.reconstruction.publication = {
    state: "unknown", pendingDays: 0, pendingDaysBounded: false, publishedDays: 0,
    pricedDays: 0, latestPublishedAt: null,
  };
  await withAdminPage(async (path) => path === "/api/v1/admin/overview"
    ? response(overview) : unavailableResponse(), async (documentRef) => {
    await waitFor(() => documentRef.byId.get("growth-status").textContent === "History unavailable");
    assert.match(reconstructionText(documentRef), /0 of 0 tracked accounts/u);
    assert.match(reconstructionText(documentRef), /0 pending days across all history/u);
    assert.match(reconstructionText(documentRef), /Last 366 days: 0 published/u);
    assert.match(reconstructionText(documentRef), /State unknown/u);
    assert.match(reconstructionText(documentRef), /Latest cached result: not recorded/u);
    assert.match(reconstructionText(documentRef), /last run not recorded · latest publication not recorded/u);
    assert.equal(descendantNodes(documentRef.byId.get("admin-reconstruction-details"))
      .some((node) => node.tag === "progress"), false);
  });
});

test("admin tables preserve row order, text rendering, and empty states", async () => {
  const overview = await fixture("admin-overview-valid.json");
  overview.errors.groups[0].routeClass = "<route-class>";
  overview.audit.push({
    action: "set_collection_controls",
    outcome: "failure",
    details: {
      code: "ADMIN_ACTION_CONFLICT",
      expectedRevision: 6,
      revision: 7,
    },
    createdAt: "2026-08-02T11:30:00.000Z",
  });
  overview.audit.push({
    action: "set_collection_controls",
    outcome: "failure",
    createdAt: "2026-08-02T11:15:00.000Z",
  });
  overview.audit[0].details = {
    code: "MAINTENANCE_INCOMPLETE",
    lifecycleComplete: true,
    quarantineReconciliationComplete: false,
    expiredIdentityHandoffsPurged: 0,
    expiredIdentityHandoffPurgeComplete: true,
    aggregateRebuildComplete: true,
    publicationEnabled: true,
    message: "<details>",
  };
  const emptyOverview = {
    ...overview,
    snapshots: [],
    ingress: null,
    distribution: {
      ...overview.distribution,
      cloudflare: {
        status: "unavailable",
        reasonCode: "ANALYTICS_UNAVAILABLE",
        sampled: null,
        bounded: null,
        window: null,
        activeSourceAddresses: null,
        preflight: null,
        sparkleChecks: null,
        sparkleDownloads: null,
        currentVersion: null,
        currentVersionSourceAddresses: null,
        observedVersions: [],
        observedVersionsBounded: false,
      },
      github: {
        ...overview.distribution.github,
        status: "unavailable",
        reasonCode: "GITHUB_UNAVAILABLE",
        release: null,
        summary: null,
        releases: [],
        releasesBounded: false,
        history: {
          firstObservedAt: null,
          previousObservedAt: null,
          latestObservedAt: null,
          dmgDownloadsSincePrevious: null,
          counterRegressions: 0,
        },
      },
    },
    errors: { ...overview.errors, groups: [], recentDiagnostics: [] },
    audit: [],
  };
  const githubUnavailableOverview = {
    ...overview,
    distribution: {
      ...overview.distribution,
      github: {
        ...overview.distribution.github,
        status: "unavailable",
        reasonCode: "GITHUB_UNAVAILABLE",
        release: null,
        summary: null,
        releases: [],
        releasesBounded: false,
        history: {
          firstObservedAt: null,
          previousObservedAt: null,
          latestObservedAt: null,
          dmgDownloadsSincePrevious: null,
          counterRegressions: 0,
        },
      },
    },
  };
  const alertOverview = {
    ...overview,
    collection: {
      state: "contained",
      revision: overview.collection.revision + 1,
      enrollment: false,
      uploadRegistration: false,
      processing: false,
      publication: false,
    },
  };
  // The admin host authenticates from the Cloudflare Access JWT and sends the
  // x-usage-monitor-admin CSRF header, so load() no longer pre-fetches a session
  // token — each load is a single /api/v1/admin/overview request.
  const responses = [
    overview,
    githubUnavailableOverview,
    emptyOverview,
    alertOverview,
  ];
  let fetchCount = 0;
  const documentRef = fakeDocument();
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.document = documentRef;
  globalThis.fetch = async () => response(responses[fetchCount++]);
  globalThis.window = { innerHeight: 844, innerWidth: 390 };

  try {
    const moduleUrl = new URL("../public/admin.js", import.meta.url);
    moduleUrl.search = `?admin-site-test=${Date.now()}`;
    await import(moduleUrl.href);
    await waitFor(() => documentRef.byId.get("last-refresh").textContent !== "Not loaded");

    const errorGroup = overview.errors.groups[0];
    assert.deepEqual(tableTexts(documentRef, "error-groups"), [[
      "<route-class>",
      errorGroup.errorCode,
      String(errorGroup.status),
      `${errorGroup.occurrences} (${errorGroup.ratePerDay}/day)`,
      formatReportingTime(errorGroup.latestAt),
    ]]);
    assert.equal(documentRef.byId.get("error-groups").children[0].children[0].innerHTML, "");

    const snapshot = overview.snapshots[0];
    assert.deepEqual(tableTexts(documentRef, "snapshot-rows"), [[
      snapshot.snapshotId,
      `${snapshot.weekStart} → ${snapshot.weekEnd}`,
      snapshot.releaseState,
      formatReportingTime(snapshot.releasedAt),
    ]]);

    assert.deepEqual(tableTexts(documentRef, "distribution-version-rows"), [
      ["0.1.12", "66%", "19", "64"],
      ["0.1.11", "17%", "5", "9"],
    ]);
    assert.deepEqual(
      metricTexts(documentRef, "distribution-counts"),
      [
        ["Active-install proxy", "19", "29 distinct source addresses in 7 days"],
        ["App preflight call-ins", "22", "16 addresses · 78 requests/7d"],
        ["Sparkle update checks", "14", "13 addresses · 40 checks/7d"],
        ["Sparkle artifact fetches", "3", "3 addresses · 3 fetches/7d"],
        ["Current-version reach", "18", "v0.1.12 · 19 addresses/7d"],
        ["GitHub DMG downloads", "110", "2 releases · 2 DMG assets · all time"],
        ["GitHub DMG downloads since prior snapshot", "6", `${formatReportingTime("2026-08-16T12:00:00.000Z")} → ${formatReportingTime("2026-08-17T12:00:00.000Z")}`],
      ],
    );
    assert.deepEqual(tableTexts(documentRef, "github-release-rows"), [
      ["v0.1.12", "Stable", "88", "80%", formatReportingTime("2026-08-15T18:00:00.000Z")],
      ["v0.1.11", "Stable", "22", "20%", formatReportingTime("2026-08-01T18:00:00.000Z")],
    ]);

    assert.deepEqual(
      metricTexts(documentRef, "counts").at(-1),
      ["Upload safety registrations", "110", "110 recent · 0 due"],
    );
    for (const id of ["counts", "quarantine-counts", "distribution-counts"]) {
      for (const card of documentRef.byId.get(id).children) {
        assertInfoHint(card.children[0], card.children[0].children[0].textContent);
        assert.equal(card.children.length, 4, `${id} card is missing recent history`);
        assert.match(card.children[3].className, /admin-sparkline-shell/u);
      }
    }
    const narrowHint = documentRef.byId.get("counts").children[0].children[0]
      .children[1];
    const [narrowTrigger, narrowTooltip] = narrowHint.children;
    narrowTrigger.rect = { bottom: 418, left: 370, top: 400 };
    narrowTooltip.offsetHeight = 100;
    narrowTooltip.offsetWidth = 260;
    narrowTrigger.listeners.get("focus")();
    assert.deepEqual(narrowTooltip.style, { left: "118px", top: "426px" });
    assert.equal(
      documentRef.byId.get("operator-attention-badge").textContent,
      "No action indicated",
    );
    assert.deepEqual(
      documentRef.byId.get("operator-attention").children[0].children[1].children
        .map((node) => node.textContent),
      [
        "No current action is indicated by this snapshot",
        "Collection is operational, no reconciliation or rebuild work is due, first-party activity evidence is available, and no sampled 5xx event was retained in the last 24 hours.",
      ],
    );
    assert.equal(
      documentRef.byId.get("quarantine-status-badge").textContent,
      "Healthy · settling",
    );
    assert.deepEqual(
      metricTexts(documentRef, "quarantine-counts"),
      [
        ["Recent registrations", "110", "normal 60-minute safety window"],
        ["Due and referenced", "0", "valid objects; temporary markers should clear"],
        ["Due and unreferenced", "0", "orphan candidates scheduled for safe deletion"],
      ],
    );
    assert.deepEqual(
      statusTexts(documentRef, "quarantine-status").slice(0, 7),
      [
        ["Pending registrations: ", "110"],
        ["Oldest registration: ", formatReportingTime(overview.quarantine.oldestRegisteredAt)],
        ["Newest registration: ", formatReportingTime(overview.quarantine.newestRegisteredAt)],
        ["Next registration becomes due: ", formatReportingTime(overview.quarantine.nextEligibleAt)],
        ["Eligible cutoff now: ", formatReportingTime(overview.quarantine.cutoffAt)],
        ["Last reconciliation: ", formatReportingTime(overview.reconciliation.lastCompletedAt)],
        ["Last pass cutoff: ", formatReportingTime(overview.reconciliation.cutoffAt)],
      ],
    );
    for (const line of documentRef.byId.get("quarantine-status").children) {
      const labelNode = line.children[0].children[0];
      assertInfoHint(labelNode, labelNode.children[0].textContent);
    }
    for (const id of ["distribution-source-status", "ingress-status", "lifecycle-status"]) {
      for (const line of documentRef.byId.get(id).children) {
        const labelNode = line.children[0].children[0];
        assertInfoHint(labelNode, labelNode.children[0].textContent);
      }
    }

    const diagnostic = overview.errors.recentDiagnostics[0];
    assert.deepEqual(tableTexts(documentRef, "recent-diagnostic-rows"), [[
      diagnostic.requestId,
      diagnostic.routeClass,
      diagnostic.errorCode,
      String(diagnostic.status),
      formatReportingTime(diagnostic.occurredAt),
    ]]);

    const ingress = overview.ingress;
    assert.deepEqual(
      statusTexts(documentRef, "ingress-status"),
      [
        ["Active leases: ", `${ingress.activeLeases} of ${ingress.maximumConcurrent}`],
        ["Available start tokens: ", `${ingress.availableStartTokens} of ${ingress.burst}`],
        ["Concurrency denials: ", String(ingress.concurrencyDenials)],
        ["Start-rate denials: ", String(ingress.startRateDenials)],
        ["Last denied: ", formatReportingTime(ingress.lastDeniedAt)],
      ],
    );
    assert.deepEqual(
      statusTexts(documentRef, "lifecycle-status").slice(3, 8),
      [
        ["Latest accepted upload: ", formatReportingTime(overview.counts.contributions.latestAcceptedAt)],
        ["Weekly rebuild queue: ", String(overview.pendingHistoricalRebuilds)],
        ["Daily rebuild queue: ", String(overview.dailyPublication.pendingRebuilds)],
        ["Latest daily evidence: ", overview.dailyPublication.latestEvidenceDay],
        ["Latest daily publication: ", formatReportingTime(overview.dailyPublication.latestReleasedAt)],
      ],
    );

    const auditRows = documentRef.byId.get("audit-rows").children;
    assert.equal(auditRows.length, 3);
    const maintenanceRow = auditRows[0];
    assertInfoHint(maintenanceRow.children[0].children[0], "Maintenance pass");
    assert.equal(maintenanceRow.children[0].getAttribute("data-label"), "Action");
    assert.equal(maintenanceRow.children[1].children[0].children[0].textContent, "Follow-up needed");
    assert.equal(maintenanceRow.children[1].getAttribute("data-label"), "Result");
    assert.equal(maintenanceRow.children[1].children[0].children[1].children[1].textContent.includes("bounded maintenance"), true);
    assert.equal(
      maintenanceRow.children[2].children[0].textContent,
      "The pass ran, but upload-object reconciliation still has eligible work remaining. Another bounded pass may finish it.",
    );
    assert.equal(maintenanceRow.children[2].children[0].textContent.includes("{"), false);
    assert.equal(maintenanceRow.children[2].getAttribute("data-label"), "What happened");
    const maintenanceDetails = maintenanceRow.children[2].children[1];
    assert.equal(maintenanceDetails.tag, "details");
    assert.equal(maintenanceDetails.children[0].textContent, "Technical fields (10)");
    const detailList = maintenanceDetails.children[1];
    const detailValues = detailList.children.filter((node) => node.tag === "dd");
    assert.equal(detailValues.at(-1).textContent, "<details>");
    assert.equal(detailValues.at(-1).innerHTML, "");
    const detailLabels = detailList.children.filter((node) => node.tag === "dt");
    for (const label of detailLabels) {
      assertInfoHint(label.children[0], label.children[0].children[0].textContent);
    }
    assert.equal(
      maintenanceRow.children[3].children[0].textContent,
      formatReportingTime(overview.audit[0].createdAt),
    );
    assert.equal(
      maintenanceRow.children[3].children[0].getAttribute("datetime"),
      overview.audit[0].createdAt,
    );

    const controlsRow = auditRows[1];
    assertInfoHint(controlsRow.children[0].children[0], "Collection controls");
    assert.equal(controlsRow.children[1].children[0].children[0].textContent, "Failed");
    assert.equal(
      controlsRow.children[2].children[0].textContent,
      "The change was not applied because the dashboard used an older control revision. Refresh the page before trying again.",
    );
    assert.equal(
      controlsRow.children[2].children[1].children[0].textContent,
      "Technical fields (5)",
    );
    const noDetailsRow = auditRows[2];
    assert.equal(noDetailsRow.children[1].children[0].children[0].textContent, "Failed");
    assert.equal(
      noDetailsRow.children[2].children[0].textContent,
      "The collection-control change failed before it produced a usable result.",
    );
    assert.equal(documentRef.byId.get("snapshot-empty").hidden, true);
    assert.equal(documentRef.byId.get("error-empty").hidden, true);
    assert.equal(documentRef.byId.get("recent-diagnostic-empty").hidden, true);
    assert.equal(documentRef.byId.get("audit-empty").hidden, true);

    await documentRef.byId.get("refresh").listeners.get("click")();
    assert.equal(fetchCount, 2);
    assert.equal(
      documentRef.byId.get("distribution-status").textContent,
      "Activity available · GitHub unavailable",
    );
    assert.deepEqual(
      metricTexts(documentRef, "distribution-counts").at(-2),
      [
        "GitHub DMG downloads",
        "—",
        "unavailable from GitHub; activity counts are unaffected",
      ],
    );
    assert.equal(
      documentRef.byId.get("operator-attention-badge").textContent,
      "Review · 1",
    );
    assert.equal(
      statusTexts(documentRef, "distribution-source-status").some((line) =>
        line[0] === "GitHub releases: " && line[1] === "unavailable"),
      true,
    );

    await documentRef.byId.get("refresh").listeners.get("click")();
    assert.equal(fetchCount, 3);
    assert.deepEqual(tableTexts(documentRef, "error-groups"), []);
    assert.deepEqual(tableTexts(documentRef, "snapshot-rows"), []);
    assert.deepEqual(tableTexts(documentRef, "audit-rows"), []);
    assert.deepEqual(tableTexts(documentRef, "recent-diagnostic-rows"), []);
    assert.deepEqual(tableTexts(documentRef, "distribution-version-rows"), []);
    assert.equal(documentRef.byId.get("snapshot-empty").hidden, false);
    assert.equal(documentRef.byId.get("error-empty").hidden, false);
    assert.equal(documentRef.byId.get("recent-diagnostic-empty").hidden, false);
    assert.equal(documentRef.byId.get("distribution-version-empty").hidden, false);
    assert.equal(documentRef.byId.get("audit-empty").hidden, false);
    assert.equal(
      documentRef.byId.get("distribution-status").textContent,
      "Activity evidence unavailable",
    );
    assert.equal(
      documentRef.byId.get("operator-attention-badge").textContent,
      "Review · 2",
    );
    assert.deepEqual(
      documentRef.byId.get("operator-attention").children[0].children[1].children
        .map((node) => node.textContent),
      [
        "Operational evidence is incomplete",
        "Upload protection status and first-party app activity analytics could not be refreshed.",
      ],
    );
    assert.deepEqual(
      statusTexts(documentRef, "ingress-status"),
      [[
        "Upload ingress budget: ",
        "unavailable — the budget binding is not configured or unreachable",
      ]],
    );

    await documentRef.byId.get("refresh").listeners.get("click")();
    assert.equal(fetchCount, 4);
    assert.equal(
      documentRef.byId.get("operator-attention-badge").textContent,
      "Action required · 1",
    );
    assert.deepEqual(
      documentRef.byId.get("operator-attention").children[0].children[1].children
        .map((node) => node.textContent),
      [
        "Collection is contained",
        "enrollment, upload registration, processing, publication are disabled.",
      ],
    );
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("the owner dashboard keeps the merge trial private and separate from the public graph", async () => {
  const [source, html] = await Promise.all([
    readFile(new URL("../public/admin.js", import.meta.url), "utf8"),
    readFile(new URL("../public/admin.html", import.meta.url), "utf8"),
  ]);
  assert.match(
    source,
    /request\(\n      "\/api\/v1\/admin\/community\/allowance-preview",/u,
  );
  assert.match(source, /projectAdminAllowancePreview/u);
  assert.doesNotMatch(source, /PublicCommunityClient/u);
  assert.doesNotMatch(source, /renderCommunityAllowanceSection/u);
  assert.match(html, /data-allowance-mode="combined"[^>]*>Combined</u);
  assert.match(html, /data-allowance-mode="plans"[^>]*>By plan</u);
  assert.match(html, /data-allowance-mode="models"[^>]*>By model</u);
  assert.match(html, /class="community-allowance">[\s\S]*id="admin-reconstruction-progress"[\s\S]*id="admin-community-allowance-result"/u);
  assert.match(html, /id="admin-reconstruction-progress" aria-labelledby="admin-reconstruction-title"/u);
  assert.match(html, /id="admin-reconstruction-status" role="status"/u);
  assert.doesNotMatch(html, /same published community graph/u);
});

async function withAllowancePage(preview, check) {
  const overview = await fixture("admin-overview-valid.json");
  const requests = [];
  await withAdminPage(async (path, options) => {
    assert.equal(options?.method ?? "GET", "GET", "allowance UI interactions must remain read-only");
    requests.push(path);
    if (path === "/api/v1/admin/overview") return response(overview);
    if (path === "/api/v1/admin/community/allowance-preview") return response(preview);
    assert.equal(path, "/api/v1/admin/metrics/history", "never call a public or unapproved endpoint");
    return unavailableResponse();
  }, async (documentRef) => {
    await waitFor(() => documentRef.byId.get("admin-community-status").textContent === "Admin preview available"
      && documentRef.byId.get("growth-status").textContent === "History unavailable");
    await check(documentRef);
    assert.deepEqual(requests, [
      "/api/v1/admin/overview",
      "/api/v1/admin/community/allowance-preview",
      "/api/v1/admin/metrics/history",
    ]);
  });
}

function selectAllowanceControl(documentRef, id, selector) {
  const group = documentRef.byId.get(id);
  const button = group.querySelector(selector);
  assert.ok(button, `control exists: ${selector}`);
  group.listeners.get("click")({ target: button });
  return button;
}

function allowanceNodes(documentRef, selector) {
  return documentRef.byId.get("admin-community-allowance-result").querySelectorAll(selector);
}

test("admin refresh preserves the exact allowance DOM on transport failures and replaces it on recovery", async () => {
  const overview = await fixture("admin-overview-valid.json");
  const preview = createAdminAllowancePreviewPayload();
  let nextPreview = async () => response(preview);
  let previewRequests = 0;
  await withAdminPage(async (path, options) => {
    assert.equal(options.method ?? "GET", "GET");
    if (path === "/api/v1/admin/overview") return response(overview);
    if (path === "/api/v1/admin/community/allowance-preview") {
      previewRequests += 1;
      return nextPreview();
    }
    assert.equal(path, "/api/v1/admin/metrics/history");
    return unavailableResponse();
  }, async documentRef => {
    const badge = documentRef.byId.get("admin-community-status");
    await waitFor(() => badge.textContent === "Admin preview available");
    selectAllowanceControl(documentRef, "admin-community-mode-controls", 'button[data-allowance-mode="plans"]');
    const container = documentRef.byId.get("admin-community-allowance-result");
    const plan = container.querySelector('button[data-allowance-plan="prolite"]');
    container.listeners.get("click")({ target: plan });
    const focused = documentRef.activeElement;
    const graph = container.querySelector('svg[role="img"]');
    const children = [...container.children];
    const text = descendantNodes(container).map(node => node.textContent).join(" ");
    let expectedRequests = 1;
    for (const failure of [
      async () => { throw new TypeError("fixture-private-transport-detail"); },
      async () => unavailableResponse(),
      async () => ({ ok: false, status: 503, json: async () => ({ error: { code: "BACKEND_STORAGE_UNAVAILABLE" } }) }),
      async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError("fixture-proxy-html"); } }),
      async () => ({ ok: false, status: 504, json: async () => null }),
    ]) {
      nextPreview = failure;
      await documentRef.byId.get("refresh").listeners.get("click")();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(previewRequests, ++expectedRequests);
      assert.equal(badge.textContent, "Admin preview available");
      assert.equal(container.querySelector('svg[role="img"]'), graph);
      assert.deepEqual(container.children, children);
      assert.equal(documentRef.activeElement, focused);
      assert.equal(focused.getAttribute("aria-pressed"), "true");
      assert.equal(descendantNodes(container).map(node => node.textContent).join(" "), text);
      assert.doesNotMatch(text, /last good|updating|fixture-private-transport-detail|fixture-proxy-html/iu);
    }
    const recovered = structuredClone(preview);
    recovered.days.at(-1).byPlanType.pro.centralUsd += 10;
    nextPreview = async () => response(recovered);
    await documentRef.byId.get("refresh").listeners.get("click")();
    await waitFor(() => container.querySelector('svg[role="img"]') !== graph);
    assert.equal(badge.textContent, "Admin preview available");
    assert.equal(container.querySelector('button[data-allowance-plan="prolite"]').getAttribute("aria-pressed"), "true");
    assert.equal(container.querySelector(".allowance-summary-value").textContent, "$2,129");
  });
});

test("admin refresh removes allowance graphs on authoritative refusals, unavailable states and malformed payloads", async () => {
  const overview = await fixture("admin-overview-valid.json");
  const preview = createAdminAllowancePreviewPayload();
  let nextPreview = async () => response(preview);
  await withAdminPage(async path => {
    if (path === "/api/v1/admin/overview") return response(overview);
    if (path === "/api/v1/admin/community/allowance-preview") return nextPreview();
    assert.equal(path, "/api/v1/admin/metrics/history");
    return unavailableResponse();
  }, async documentRef => {
    const badge = documentRef.byId.get("admin-community-status");
    const container = documentRef.byId.get("admin-community-allowance-result");
    const refresh = async () => {
      await documentRef.byId.get("refresh").listeners.get("click")();
      await new Promise(resolve => setImmediate(resolve));
    };
    await waitFor(() => badge.textContent === "Admin preview available");
    const errorResponse = (status, code) => async () => ({
      ok: false, status, json: async () => ({ error: { code, httpStatus: 503 } }),
    });
    for (const refusal of [
      errorResponse(401, "AUTH_REQUIRED"),
      errorResponse(403, "INTERNAL_ERROR"),
      errorResponse(404, "NOT_FOUND"),
      errorResponse(503, "ADMIN_ALLOWANCE_CACHE_UNAVAILABLE"),
      errorResponse(503, "PUBLICATION_DISABLED"),
      errorResponse(503, "ADMIN_NOT_CONFIGURED"),
      errorResponse(503, "UNREVIEWED_SERVER_REFUSAL"),
      async () => response({ status: "updating" }),
      async () => response({ status: "unavailable" }),
      async () => response({ ...preview, days: "malformed" }),
      async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("fixture-malformed-payload"); } }),
    ]) {
      assert.equal(badge.textContent, "Admin preview available");
      assert.equal(container.querySelectorAll('svg[role="img"]').length, 1);
      nextPreview = refusal;
      await refresh();
      assert.equal(badge.textContent, "Preview unavailable");
      assert.equal(container.querySelectorAll('svg[role="img"]').length, 0);
      nextPreview = async () => unavailableResponse();
      await refresh();
      assert.equal(badge.textContent, "Preview unavailable", "a later transport failure cannot resurrect invalidated data");
      nextPreview = async () => response(preview);
      await refresh();
    }
  });
});

test("overview access refusal clears the allowance graph and a delayed older preview cannot restore it", async () => {
  const overview = await fixture("admin-overview-valid.json");
  const preview = createAdminAllowancePreviewPayload();
  let nextOverview = async () => response(overview);
  let nextPreview = async () => response(preview);
  let resolveOlderPreview;
  await withAdminPage(async path => {
    if (path === "/api/v1/admin/overview") return nextOverview();
    if (path === "/api/v1/admin/community/allowance-preview") return nextPreview();
    assert.equal(path, "/api/v1/admin/metrics/history");
    return unavailableResponse();
  }, async documentRef => {
    const badge = documentRef.byId.get("admin-community-status");
    const container = documentRef.byId.get("admin-community-allowance-result");
    await waitFor(() => badge.textContent === "Admin preview available");
    const graph = container.querySelector('svg[role="img"]');
    nextOverview = async () => unavailableResponse();
    await documentRef.byId.get("refresh").listeners.get("click")();
    assert.equal(container.querySelector('svg[role="img"]'), graph, "temporary overview failures preserve the graph too");
    nextOverview = async () => response(overview);
    nextPreview = () => new Promise(resolve => { resolveOlderPreview = resolve; });
    await documentRef.byId.get("refresh").listeners.get("click")();
    await waitFor(() => typeof resolveOlderPreview === "function");
    nextOverview = async () => ({ ok: false, status: 403, json: async () => ({ error: { code: "ADMIN_REQUIRED" } }) });
    await documentRef.byId.get("refresh").listeners.get("click")();
    assert.equal(badge.textContent, "Preview unavailable");
    assert.equal(container.querySelectorAll('svg[role="img"]').length, 0);
    resolveOlderPreview(response(preview));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(badge.textContent, "Preview unavailable");
    assert.equal(container.querySelectorAll('svg[role="img"]').length, 0);
  });
});

test("rendered plan cards keep normalized headlines and show correctly rounded actual-plan weeks", async () => {
  await withAllowancePage(createAdminAllowancePreviewPayload(), async (documentRef) => {
    selectAllowanceControl(documentRef, "admin-community-mode-controls", 'button[data-allowance-mode="plans"]');
    const cards = allowanceNodes(documentRef, ".admin-allowance-plan-summary");
    assert.equal(cards.length, 3);
    assert.deepEqual(cards.map((card) => card.querySelector("h3").textContent), ["Pro 20×", "Pro 5×", "Plus"]);
    assert.deepEqual(cards.map((card) => card.querySelector(".allowance-summary-value").textContent), ["$2,119", "$1,918", "$1,900"]);
    assert.deepEqual(cards.map((card) => card.querySelector(".allowance-plan-value").textContent), [
      "This plan: $2,119/week at API prices",
      "This plan: $479/week at API prices",
      "This plan: $95/week at API prices",
    ]);
    assert.equal(allowanceNodes(documentRef, ".allowance-summary-caption")[0].textContent,
      "API-equivalent USD / Pro 20× week");
    assert.match(descendantNodes(cards[1]).map((node) => node.textContent).join(" "), /1 account · 2 fits/u);

    const container = documentRef.byId.get("admin-community-allowance-result");
    const legend = container.querySelector('button[data-allowance-plan="prolite"]');
    container.listeners.get("click")({ target: legend.children[1] });
    const focused = container.querySelector('button[data-allowance-plan="prolite"]');
    assert.equal(focused.getAttribute("aria-pressed"), "true");
    assert.equal(documentRef.activeElement, focused);
    assert.equal(allowanceNodes(documentRef, ".allowance-plan-value").length, 3);
  });
});

test("a plan without qualifying evidence retains its unavailable card and has no fabricated actual value", async () => {
  const preview = createAdminAllowancePreviewPayload();
  for (const day of preview.days) {
    day.byPlanType.plus = { fitCount: 0, participantCount: 0, centralUsd: null, band80Usd: null };
  }
  await withAllowancePage(preview, async (documentRef) => {
    selectAllowanceControl(documentRef, "admin-community-mode-controls", 'button[data-allowance-mode="plans"]');
    const plus = allowanceNodes(documentRef, ".admin-allowance-plan-summary").at(-1);
    assert.equal(plus.querySelector("h3").textContent, "Plus");
    assert.equal(plus.querySelector(".allowance-summary-value").textContent, "—");
    assert.equal(plus.querySelector(".allowance-plan-value"), null);
    const text = descendantNodes(plus).map((node) => node.textContent).join(" ");
    assert.match(text, /No qualifying fits/u);
    assert.doesNotMatch(text, /This plan:|\$0/u);
  });
});

test("rendered model cards, icons and native legend buttons share order and preserve focus and dropdown state", async () => {
  await withAllowancePage(createAdminAllowancePreviewPayload(), async (documentRef) => {
    selectAllowanceControl(documentRef, "admin-community-mode-controls", 'button[data-allowance-mode="models"]');
    selectAllowanceControl(documentRef, "admin-community-range-controls", 'button[data-range-days="all"]');
    const ids = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"];
    const themes = ["astra", "sol", "terra", "luna", "classic"];
    const cards = allowanceNodes(documentRef, ".admin-allowance-plan-summary");
    assert.deepEqual(cards.map((card) => card.querySelector("h3").textContent), [
      "GPT-6 Astra", "GPT-5.6 Sol", "GPT-5.6 Terra", "GPT-5.6 Luna", "GPT-5.5",
    ]);
    cards.forEach((card, index) => {
      assert.equal(card.classList.contains(`allowance-model-${themes[index]}`), true);
      assert.equal(card.querySelector(".allowance-model-icon").getAttribute("aria-hidden"), "true");
      assert.equal(card.querySelector(".admin-allowance-value"), null, "cards do not inherit the large combined headline");
    });
    const container = documentRef.byId.get("admin-community-allowance-result");
    const buttons = container.querySelectorAll("button[data-allowance-model-focus]");
    assert.deepEqual(buttons.map((button) => button.dataset.allowanceModelFocus), ids);
    assert.ok(buttons.every((button) => button.type === "button" && button.getAttribute("aria-pressed") === "false" && !button.disabled));
    buttons.forEach((button, index) => {
      assert.equal(button.children[0].classList.contains(`allowance-model-${themes[index]}`), true);
    });
    const axes = container.querySelectorAll(".chart-axis-label").map((node) => [node.textContent, node.getAttribute("x"), node.getAttribute("y")]);
    container.listeners.get("click")({ target: buttons[0].children[1] });
    let focused = container.querySelector('button[data-allowance-model-focus="gpt-6-astra"]');
    assert.equal(focused.getAttribute("aria-pressed"), "true");
    assert.equal(documentRef.activeElement, focused);
    assert.equal(container.querySelector(".admin-allowance-model-filter select").value, "observed");
    assert.deepEqual(container.querySelectorAll(".chart-axis-label").map((node) => [node.textContent, node.getAttribute("x"), node.getAttribute("y")]), axes);
    assert.equal(container.querySelectorAll(".admin-allowance-dot").length, 10);
    assert.equal(container.querySelectorAll(".admin-allowance-plan-summary").length, 5);
    container.listeners.get("click")({ target: focused });
    focused = container.querySelector('button[data-allowance-model-focus="gpt-6-astra"]');
    assert.equal(focused.getAttribute("aria-pressed"), "false");
    assert.equal(documentRef.activeElement, focused);
    assert.equal(container.querySelectorAll(".admin-allowance-dot").length, 290);

    const dropdown = container.querySelector(".admin-allowance-model-filter select");
    dropdown.value = "all";
    dropdown.listeners.get("change")();
    assert.equal(container.querySelector(".admin-allowance-model-filter select").value, "all");
    assert.equal(documentRef.activeElement, container.querySelector(".admin-allowance-model-filter select"));
    const unavailable = container.querySelector('button[data-allowance-model-focus="gpt-5.4-mini"]');
    assert.equal(unavailable.disabled, true);
    assert.equal(unavailable.getAttribute("aria-pressed"), "false");
    assert.equal(unavailable.title, "No qualifying fits in this range");
    assert.equal(container.querySelectorAll(".admin-allowance-plan-summary").length, 39);
    const specific = container.querySelector(".admin-allowance-model-filter select");
    specific.value = "gpt-5.4-mini";
    specific.listeners.get("change")();
    assert.equal(container.querySelectorAll(".admin-allowance-dot").length, 0);
    assert.equal(container.querySelectorAll(".admin-allowance-plan-summary").length, 1);
    assert.match(descendantNodes(container).map((node) => node.textContent).join(" "), /No qualifying fits in this range/u);
  });
});

test("the chart has one tab stop and keyboard inspection reaches every point hidden by dense marker thinning", async () => {
  const preview = createAdminAllowancePreviewPayload();
  await withAllowancePage(preview, async (documentRef) => {
    selectAllowanceControl(documentRef, "admin-community-range-controls", 'button[data-range-days="all"]');
    const svg = allowanceNodes(documentRef, 'svg[role="img"]')[0];
    const dots = svg.querySelectorAll(".admin-allowance-dot");
    const inspection = allowanceNodes(documentRef, ".admin-allowance-inspection")[0];
    assert.equal(svg.getAttribute("tabindex"), "0");
    assert.equal(dots.length, 70);
    assert.ok(dots.every((dot) => dot.getAttribute("tabindex") === "-1"));
    assert.equal(dots.filter((dot) => dot.getAttribute("data-permanent-marker") === "true").length, 2);
    assert.equal(inspection.getAttribute("aria-live"), "polite");
    let prevented = 0;
    const key = (value) => svg.listeners.get("keydown")({
      key: value, target: documentRef.activeElement ?? svg, preventDefault: () => { prevented += 1; },
    });
    key("Home");
    for (const [index, dot] of dots.entries()) {
      if (index > 0) key("ArrowRight");
      assert.equal(documentRef.activeElement, dot, `day ${index + 1} remains inspectable`);
      assert.equal(inspection.textContent, dot.getAttribute("aria-label"));
      assert.ok(inspection.textContent.includes(preview.days[index].day));
    }
    assert.equal(prevented, 70);
    key("ArrowDown");
    assert.equal(documentRef.activeElement, dots.at(-1), "inspection clamps at the last fitted point");
    key("Home");
    key("ArrowUp");
    assert.equal(documentRef.activeElement, dots[0], "inspection clamps at the first fitted point");
    key("End");
    key("ArrowLeft");
    assert.equal(documentRef.activeElement, dots.at(-2));
    assert.equal(dots.at(-2).getAttribute("data-permanent-marker"), "false");
    const priorPrevented = prevented;
    key("PageDown");
    assert.equal(prevented, priorPrevented, "unrelated keyboard controls keep their default behavior");
    dots[1].listeners.get("pointerenter")();
    assert.equal(inspection.textContent, dots[1].getAttribute("aria-label"));
    dots[2].listeners.get("click")();
    assert.equal(inspection.textContent, dots[2].getAttribute("aria-label"));
  });
});

test("rendered admin charts size their coordinate system to the container instead of shrinking desktop labels", async () => {
  await withAllowancePage(createAdminAllowancePreviewPayload(), async (documentRef) => {
    const container = documentRef.byId.get("admin-community-allowance-result");
    for (const [availableWidth, expectedWidth, mode] of [[350, 320, "plans"], [250, 280, "models"], [1_400, 960, "combined"]]) {
      container.rect.width = availableWidth;
      selectAllowanceControl(documentRef, "admin-community-mode-controls", `button[data-allowance-mode="${mode}"]`);
      assert.equal(container.querySelector('svg[role="img"]').getAttribute("viewBox"), `0 0 ${expectedWidth} 300`);
      assert.ok(container.querySelectorAll(".chart-axis-label").length > 0);
    }
  });
});
