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

  setAttribute(name, value) {
    const copy = String(value);
    this.attributes.set(name, copy);
    if (name === "id") this.id = copy;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  getBoundingClientRect() {
    return this.rect;
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
    "audit-empty",
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
      metricTexts(documentRef, "distribution-counts"),
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
      metricTexts(documentRef, "counts").at(-1),
      ["Upload safety registrations", "110", "110 recent · 0 due"],
    );
    for (const id of ["counts", "quarantine-counts", "distribution-counts"]) {
      for (const card of documentRef.byId.get(id).children) {
        assertInfoHint(card.children[0], card.children[0].children[0].textContent);
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
      metricTexts(documentRef, "distribution-counts").at(-1),
      [
        "GitHub DMG downloads",
        "—",
        "unavailable from GitHub; activity counts are unaffected",
      ],
    );
    assert.equal(
      documentRef.byId.get("operator-attention-badge").textContent,
      "No action indicated",
    );
    assert.deepEqual(
      statusTexts(documentRef, "distribution-source-status").slice(-3, -2),
      [["GitHub releases: ", "unavailable"]],
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
      "Review · 1",
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
