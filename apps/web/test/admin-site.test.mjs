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
      },
    },
    errors: { ...overview.errors, groups: [], recentDiagnostics: [] },
    audit: [],
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
    emptyOverview,
    alertOverview,
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

    assert.deepEqual(tableTexts(documentRef, "distribution-version-rows"), [
      ["0.1.12", "19", "64"],
      ["0.1.11", "5", "9"],
    ]);
    assert.deepEqual(
      documentRef.byId.get("distribution-counts").children.map((card) =>
        card.children.map((node) => node.textContent)),
      [
        ["Active-install proxy", "19", "29 distinct source addresses in 7 days"],
        ["App preflight call-ins", "22", "16 addresses · 78 requests/7d"],
        ["Sparkle update checks", "14", "13 addresses · 40 checks/7d"],
        ["Sparkle artifact fetches", "3", "3 addresses · 3 fetches/7d"],
        ["Current-version reach", "18", "v0.1.12 · 19 addresses/7d"],
        ["GitHub DMG downloads", "88", "v0.1.12 cumulative · 101 all release assets"],
      ],
    );

    assert.deepEqual(
      documentRef.byId.get("counts").children.at(-1).children
        .map((node) => node.textContent),
      ["Upload safety registrations", "110", "110 recent · 0 due"],
    );
    assert.equal(
      documentRef.byId.get("operator-attention-badge").textContent,
      "No action indicated",
    );
    assert.deepEqual(
      documentRef.byId.get("operator-attention").children[0].children[1].children
        .map((node) => node.textContent),
      [
        "No current action is indicated by this snapshot",
        "Collection is operational, no reconciliation or rebuild work is due, monitoring sources are available, and no sampled 5xx event was retained in the last 24 hours.",
      ],
    );
    assert.equal(
      documentRef.byId.get("quarantine-status-badge").textContent,
      "Healthy · settling",
    );
    assert.deepEqual(
      documentRef.byId.get("quarantine-counts").children.map((card) =>
        card.children.map((node) => node.textContent)),
      [
        ["Recent registrations", "110", "normal 60-minute safety window"],
        ["Due and referenced", "0", "valid objects; temporary markers should clear"],
        ["Due and unreferenced", "0", "orphan candidates scheduled for safe deletion"],
      ],
    );
    assert.deepEqual(
      documentRef.byId.get("quarantine-status").children
        .slice(0, 7)
        .map((line) => line.children.map((node) => node.textContent)),
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
    assert.deepEqual(
      documentRef.byId.get("lifecycle-status").children
        .slice(3, 8)
        .map((line) => line.children.map((node) => node.textContent)),
      [
        ["Latest accepted upload: ", formatReportingTime(overview.counts.contributions.latestAcceptedAt)],
        ["Weekly rebuild queue: ", String(overview.pendingHistoricalRebuilds)],
        ["Daily rebuild queue: ", String(overview.dailyPublication.pendingRebuilds)],
        ["Latest daily evidence: ", overview.dailyPublication.latestEvidenceDay],
        ["Latest daily publication: ", formatReportingTime(overview.dailyPublication.latestReleasedAt)],
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
    assert.equal(fetchCount, 2);
    assert.deepEqual(tableTexts(documentRef, "error-groups"), []);
    assert.deepEqual(tableTexts(documentRef, "snapshot-rows"), []);
    assert.deepEqual(tableTexts(documentRef, "audit-rows"), []);
    assert.deepEqual(tableTexts(documentRef, "recent-diagnostic-rows"), []);
    assert.deepEqual(tableTexts(documentRef, "distribution-version-rows"), []);
    assert.equal(documentRef.byId.get("snapshot-empty").hidden, false);
    assert.equal(documentRef.byId.get("error-empty").hidden, false);
    assert.equal(documentRef.byId.get("recent-diagnostic-empty").hidden, false);
    assert.equal(documentRef.byId.get("distribution-version-empty").hidden, false);
    assert.equal(documentRef.byId.get("distribution-status").textContent, "Partial evidence");
    assert.equal(
      documentRef.byId.get("operator-attention-badge").textContent,
      "Review · 1",
    );
    assert.deepEqual(
      documentRef.byId.get("operator-attention").children[0].children[1].children
        .map((node) => node.textContent),
      [
        "Monitoring evidence is incomplete",
        "upload ingress budget, Cloudflare analytics, GitHub release totals are unavailable.",
      ],
    );
    assert.deepEqual(
      documentRef.byId.get("ingress-status").children.map((line) =>
        line.children.map((node) => node.textContent)),
      [[
        "Upload ingress budget: ",
        "unavailable — the budget binding is not configured or unreachable",
      ]],
    );

    await documentRef.byId.get("refresh").listeners.get("click")();
    assert.equal(fetchCount, 3);
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
  }
});
