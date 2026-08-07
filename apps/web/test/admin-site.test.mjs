import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { formatReportingTime } from "../public/ui-format.js";

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
    this.innerHTML = "";
    this.listeners = new Map();
    this.textContent = "";
    this.value = "";
    this.checked = false;
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = nodes;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }
}

function fakeDocument() {
  const byId = new Map([
    "notice",
    "counts",
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
    "audit-rows",
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

  return {
    byId,
    createElement(tag) {
      return new FakeNode(tag);
    },
    createTextNode(value) {
      const node = new FakeNode("#text");
      node.textContent = value;
      return node;
    },
    querySelector(selector) {
      const control = selector.match(/^input\[name="([^"]+)"\]$/u);
      if (control) return controls.get(control[1]);
      assert.match(selector, /^#[\w-]+$/u);
      const node = byId.get(selector.slice(1));
      assert.ok(node, `unexpected selector: ${selector}`);
      return node;
    },
  };
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

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for the admin view to render");
}

test("admin tables preserve row order, text rendering, and empty states", async () => {
  const overview = await fixture("admin-overview-valid.json");
  overview.errors.groups[0].routeClass = "<route-class>";
  overview.audit.push({
    action: "set_collection_controls",
    outcome: "failure",
    createdAt: "2026-08-02T11:30:00.000Z",
  });
  overview.audit[0].details = { message: "<details>" };
  const emptyOverview = {
    ...overview,
    snapshots: [],
    ingress: null,
    errors: { ...overview.errors, groups: [], recentDiagnostics: [] },
    audit: [],
  };
  const responses = [
    { csrfToken: "csrf-token" },
    overview,
    { csrfToken: "csrf-token" },
    emptyOverview,
  ];
  let fetchCount = 0;
  const documentRef = fakeDocument();
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  globalThis.document = documentRef;
  globalThis.fetch = async () => response(responses[fetchCount++]);

  try {
    const moduleUrl = new URL("../public/admin.js", import.meta.url);
    moduleUrl.search = `?admin-site-test=${Date.now()}`;
    await import(moduleUrl.href);
    await waitFor(() => documentRef.byId.get("last-refresh").textContent !== "Not loaded");

    const errorGroup = overview.errors.groups[0];
    assert.deepEqual(tableTexts(documentRef, "error-groups"), [[
      "<route-class>",
      errorGroup.errorCode,
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
      documentRef.byId.get("ingress-status").children.map((line) =>
        line.children.map((node) => node.textContent)),
      [
        ["Active leases: ", `${ingress.activeLeases} of ${ingress.maximumConcurrent}`],
        ["Available start tokens: ", `${ingress.availableStartTokens} of ${ingress.burst}`],
        ["Concurrency denials: ", String(ingress.concurrencyDenials)],
        ["Start-rate denials: ", String(ingress.startRateDenials)],
        ["Last denied: ", formatReportingTime(ingress.lastDeniedAt)],
      ],
    );

    const audit = overview.audit[0];
    assert.deepEqual(tableTexts(documentRef, "audit-rows"), [
      [
        audit.action,
        audit.outcome,
        JSON.stringify(audit.details),
        formatReportingTime(audit.createdAt),
      ],
      [
        overview.audit[1].action,
        overview.audit[1].outcome,
        "—",
        formatReportingTime(overview.audit[1].createdAt),
      ],
    ]);
    assert.equal(documentRef.byId.get("snapshot-empty").hidden, true);
    assert.equal(documentRef.byId.get("error-empty").hidden, true);
    assert.equal(documentRef.byId.get("recent-diagnostic-empty").hidden, true);

    await documentRef.byId.get("refresh").listeners.get("click")();
    assert.equal(fetchCount, 4);
    assert.deepEqual(tableTexts(documentRef, "error-groups"), []);
    assert.deepEqual(tableTexts(documentRef, "snapshot-rows"), []);
    assert.deepEqual(tableTexts(documentRef, "audit-rows"), []);
    assert.deepEqual(tableTexts(documentRef, "recent-diagnostic-rows"), []);
    assert.equal(documentRef.byId.get("snapshot-empty").hidden, false);
    assert.equal(documentRef.byId.get("error-empty").hidden, false);
    assert.equal(documentRef.byId.get("recent-diagnostic-empty").hidden, false);
    assert.deepEqual(
      documentRef.byId.get("ingress-status").children.map((line) =>
        line.children.map((node) => node.textContent)),
      [[
        "Upload ingress budget: ",
        "unavailable — the budget binding is not configured or unreachable",
      ]],
    );
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  }
});
