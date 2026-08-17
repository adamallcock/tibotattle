import {
  adminActionErrorMessage,
  adminResponseError,
  projectAdminAction,
  projectAdminOverview,
} from "./admin-client.js";
import { formatReportingTime } from "./ui-format.js";

const state = { csrfToken: "", overview: null };
const $ = (selector) => document.querySelector(selector);

function text(value) {
  return value === null || value === undefined ? "—" : String(value);
}

function count(value, bounded = false) {
  return `${text(value)}${bounded ? "+" : ""}`;
}

function formatTime(value) {
  return value ? formatReportingTime(value) : "—";
}

function tableRow(values) {
  const row = document.createElement("tr");
  for (const value of values) {
    const cell = document.createElement("td");
    cell.textContent = text(value);
    row.append(cell);
  }
  return row;
}

function showNotice(message, kind = "warning") {
  const notice = $("#notice");
  notice.className = `notice notice-${kind}`;
  notice.textContent = message;
  notice.hidden = false;
}

async function request(path, init = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init.headers || {}),
      // Session-independent admin CSRF: this custom header forces a CORS
      // preflight the admin host never answers, so a cross-origin caller cannot
      // reach the API. Always sent on the same-origin admin page (no preflight).
      "x-usage-monitor-admin": "1",
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw adminResponseError(response.status, body);
  }
  return body;
}

function renderMetricCards(selector, metrics) {
  $(selector).replaceChildren(...metrics.map(([label, value, detail]) => {
    const card = document.createElement("div");
    card.className = "admin-card admin-metric";
    const name = document.createElement("span");
    name.textContent = label;
    const number = document.createElement("strong");
    number.textContent = text(value);
    const caption = document.createElement("small");
    caption.textContent = detail;
    card.append(name, number, caption);
    return card;
  }));
}

function renderCounts(overview) {
  const counts = overview.counts;
  const contributors = counts.contributions.contributingAccounts;
  const quarantine = overview.quarantine;
  const quarantineDue = quarantine.dueReferenced + quarantine.dueUnreferenced;
  const metrics = [
    ["Approved community accounts", count(counts.participants.active, counts.participants.bounded), `${count(counts.participants.total, counts.participants.bounded)} total identities`],
    ["Accounts with accepted data", count(contributors.total, contributors.bounded), `${count(contributors.acceptedLast30Days, contributors.bounded)} active in the last 30 days`],
    ["Approved last 24h", count(counts.participants.enrolledLast24Hours), `${count(counts.participants.enrolledLast7Days)} in the last 7 days`],
    ["Telemetry contributions", count(counts.contributions.telemetry.accepted, counts.contributions.telemetry.bounded), `${count(counts.contributions.telemetry.total, counts.contributions.telemetry.bounded)} total`],
    ["Current incremental chunks", count(counts.contributions.incrementalChunks.current, counts.contributions.incrementalChunks.bounded), `${count(counts.contributions.incrementalChunks.total, counts.contributions.incrementalChunks.bounded)} journal rows`],
    ["Accepted uploads last 24h", count(counts.contributions.acceptedLast24Hours), `${count(counts.contributions.acceptedLast7Days)} in the last 7 days`],
    ["Stored telemetry records", count(counts.contributions.storedTelemetryRecords, counts.contributions.storedTelemetryRecordsBounded), "content-free metadata rows"],
    ["Upload safety registrations", count(quarantine.pendingObjects, quarantine.pendingObjectsBounded), `${quarantine.withinGrace} recent · ${quarantineDue} due`],
  ];
  renderMetricCards("#counts", metrics);
}

function addAttentionItem(items, level, title, detail, target, linkLabel) {
  items.push({ level, title, detail, target, linkLabel });
}

function attentionRow({ level, title, detail, target, linkLabel }) {
  const row = document.createElement("div");
  row.className = `admin-attention-item admin-attention-item-${level}`;
  const dot = document.createElement("span");
  dot.className = "admin-attention-dot";
  dot.setAttribute?.("aria-hidden", "true");
  const copy = document.createElement("div");
  copy.className = "admin-attention-copy";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const caption = document.createElement("small");
  caption.textContent = detail;
  copy.append(heading, caption);
  row.append(dot, copy);
  if (target) {
    const link = document.createElement("a");
    link.className = "admin-attention-link";
    link.href = target;
    link.textContent = linkLabel;
    row.append(link);
  }
  return row;
}

function renderAttention(overview) {
  const items = [];
  const collection = overview.collection;
  const lifecycle = overview.lifecycle;
  const reconciliation = overview.reconciliation;
  const quarantine = overview.quarantine;
  const daily = overview.dailyPublication;
  const disabledControls = [
    ["enrollment", "enrollment"],
    ["uploadRegistration", "upload registration"],
    ["processing", "processing"],
    ["publication", "publication"],
  ].filter(([name]) => !collection[name]).map(([, label]) => label);

  if (collection.state !== "operational") {
    addAttentionItem(
      items,
      collection.state === "contained" ? "alert" : "warning",
      `Collection is ${collection.state}`,
      `${disabledControls.join(", ")} ${disabledControls.length === 1 ? "is" : "are"} disabled.`,
      "#controls-title",
      "Review controls",
    );
  }

  const maintenanceFailures = [];
  if (lifecycle.state === "failed") {
    maintenanceFailures.push(lifecycle.failureCode ?? "retention lifecycle failed");
  }
  if (reconciliation.state === "failed") {
    maintenanceFailures.push(
      reconciliation.failureCode ?? "object reconciliation failed",
    );
  }
  if (maintenanceFailures.length > 0) {
    addAttentionItem(
      items,
      "alert",
      "Maintenance failure recorded",
      maintenanceFailures.join(" · "),
      "#maintenance-title",
      "Open maintenance",
    );
  }

  const dueObjects = quarantine.dueReferenced + quarantine.dueUnreferenced;
  if (dueObjects > 0) {
    addAttentionItem(
      items,
      "warning",
      `${dueObjects} upload safety ${dueObjects === 1 ? "registration is" : "registrations are"} due`,
      `${quarantine.dueReferenced} referenced · ${quarantine.dueUnreferenced} unreferenced.`,
      "#storage-safety-title",
      "Review storage",
    );
  }

  const queuedRebuilds = overview.pendingHistoricalRebuilds
    + daily.pendingRebuilds;
  if (queuedRebuilds > 0) {
    addAttentionItem(
      items,
      "warning",
      `${queuedRebuilds} publication ${queuedRebuilds === 1 ? "rebuild is" : "rebuilds are"} queued`,
      `${overview.pendingHistoricalRebuilds} weekly · ${daily.pendingRebuilds} daily.`,
      "#readiness-title",
      "Review queues",
    );
  }

  const missingEvidence = [];
  if (overview.ingress === null) missingEvidence.push("upload ingress budget");
  if (overview.distribution.cloudflare.status !== "available") {
    missingEvidence.push("Cloudflare analytics");
  }
  if (overview.distribution.github.status !== "available") {
    missingEvidence.push("GitHub release totals");
  }
  if (missingEvidence.length > 0) {
    addAttentionItem(
      items,
      "warning",
      "Monitoring evidence is incomplete",
      `${missingEvidence.join(", ")} ${missingEvidence.length === 1 ? "is" : "are"} unavailable.`,
      "#distribution-title",
      "Review evidence",
    );
  }

  const generatedAt = Date.parse(overview.generatedAt);
  const recentServerFailures = overview.errors.recentDiagnostics.filter((event) => {
    const occurredAt = Date.parse(event.occurredAt);
    const age = generatedAt - occurredAt;
    return event.status >= 500
      && Number.isFinite(age)
      && age >= 0
      && age <= 24 * 60 * 60 * 1_000;
  });
  if (recentServerFailures.length > 0) {
    const latest = recentServerFailures
      .map((event) => event.occurredAt)
      .sort()
      .at(-1);
    addAttentionItem(
      items,
      "warning",
      `${recentServerFailures.length} sampled server ${recentServerFailures.length === 1 ? "failure" : "failures"} in the last 24 hours`,
      `Latest retained event: ${formatTime(latest)}.`,
      "#errors-title",
      "Review diagnostics",
    );
  }

  const badge = $("#operator-attention-badge");
  if (items.length === 0) {
    badge.className = "admin-source-badge admin-source-available";
    badge.textContent = "No action indicated";
    $("#operator-attention").replaceChildren(attentionRow({
      level: "ok",
      title: "No current action is indicated by this snapshot",
      detail: "Collection is operational, no reconciliation or rebuild work is due, monitoring sources are available, and no sampled 5xx event was retained in the last 24 hours.",
      target: null,
      linkLabel: null,
    }));
    return;
  }

  const alerts = items.filter((item) => item.level === "alert");
  badge.className = `admin-source-badge ${
    alerts.length > 0 ? "admin-source-alert" : "admin-source-partial"
  }`;
  badge.textContent = alerts.length > 0
    ? `Action required · ${items.length}`
    : `Review · ${items.length}`;
  items.sort((left, right) => Number(right.level === "alert")
    - Number(left.level === "alert"));
  $("#operator-attention").replaceChildren(...items.map(attentionRow));
}

function renderQuarantine(overview) {
  const quarantine = overview.quarantine;
  const reconciliation = overview.reconciliation;
  const badge = $("#quarantine-status-badge");
  if (reconciliation.state === "failed") {
    badge.className = "admin-source-badge admin-source-alert";
    badge.textContent = "Action required";
  } else if (quarantine.dueUnreferenced > 0) {
    badge.className = "admin-source-badge admin-source-partial";
    badge.textContent = "Cleanup due";
  } else if (quarantine.dueReferenced > 0
      || !reconciliation.reconciliationComplete) {
    badge.className = "admin-source-badge admin-source-partial";
    badge.textContent = "Reconciliation due";
  } else {
    badge.className = "admin-source-badge admin-source-available";
    badge.textContent = quarantine.withinGrace > 0 ? "Healthy · settling" : "Clear";
  }

  renderMetricCards("#quarantine-counts", [
    [
      "Recent registrations",
      count(quarantine.withinGrace, quarantine.pendingObjectsBounded),
      `normal ${quarantine.gracePeriodMinutes}-minute safety window`,
    ],
    [
      "Due and referenced",
      count(quarantine.dueReferenced, quarantine.pendingObjectsBounded),
      "valid objects; temporary markers should clear",
    ],
    [
      "Due and unreferenced",
      count(quarantine.dueUnreferenced, quarantine.pendingObjectsBounded),
      "orphan candidates scheduled for safe deletion",
    ],
  ]);

  $("#quarantine-status").replaceChildren(
    statusLine(
      "Pending registrations",
      count(quarantine.pendingObjects, quarantine.pendingObjectsBounded),
    ),
    statusLine("Oldest registration", formatTime(quarantine.oldestRegisteredAt)),
    statusLine("Newest registration", formatTime(quarantine.newestRegisteredAt)),
    statusLine("Next registration becomes due", formatTime(quarantine.nextEligibleAt)),
    statusLine("Eligible cutoff now", formatTime(quarantine.cutoffAt)),
    statusLine("Last reconciliation", formatTime(reconciliation.lastCompletedAt)),
    statusLine("Last pass cutoff", formatTime(reconciliation.cutoffAt)),
    statusLine("Registrations examined last pass", text(reconciliation.registrationsExamined)),
    statusLine("Referenced objects preserved", text(reconciliation.referencedObjectsPreserved)),
    statusLine("Orphan objects removed", text(reconciliation.orphanObjectsDeleted)),
    statusLine("Reconciliation failure", text(reconciliation.failureCode)),
  );
}

function distributionCount(value, cloudflare) {
  if (value === null || value === undefined) return "—";
  return `${cloudflare.sampled ? "≈" : ""}${value}${cloudflare.bounded ? "+" : ""}`;
}

function renderDistribution(distribution) {
  const cloudflare = distribution.cloudflare;
  const github = distribution.github;
  const cloudflareAvailable = cloudflare.status === "available";
  const githubAvailable = github.status === "available";
  const badge = $("#distribution-status");
  badge.className = `admin-source-badge ${
    cloudflareAvailable && githubAvailable
      ? "admin-source-available"
      : "admin-source-partial"
  }`;
  badge.textContent = cloudflareAvailable && githubAvailable
    ? "Sources available"
    : cloudflare.status === "not_configured" && github.status === "not_configured"
      ? "Setup required"
      : "Partial evidence";

  const active = cloudflare.activeSourceAddresses;
  const preflight = cloudflare.preflight;
  const checks = cloudflare.sparkleChecks;
  const downloads = cloudflare.sparkleDownloads;
  const current = cloudflare.currentVersionSourceAddresses;
  const release = github.release;
  renderMetricCards("#distribution-counts", [
    [
      "Active-install proxy",
      distributionCount(active?.last24Hours, cloudflare),
      `${distributionCount(active?.last7Days, cloudflare)} distinct source addresses in 7 days`,
    ],
    [
      "App preflight call-ins",
      distributionCount(preflight?.requests.last24Hours, cloudflare),
      `${distributionCount(preflight?.sourceAddresses.last24Hours, cloudflare)} addresses · ${distributionCount(preflight?.requests.last7Days, cloudflare)} requests/7d`,
    ],
    [
      "Sparkle update checks",
      distributionCount(checks?.requests.last24Hours, cloudflare),
      `${distributionCount(checks?.sourceAddresses.last24Hours, cloudflare)} addresses · ${distributionCount(checks?.requests.last7Days, cloudflare)} checks/7d`,
    ],
    [
      "Sparkle artifact fetches",
      distributionCount(downloads?.requests.last24Hours, cloudflare),
      `${distributionCount(downloads?.sourceAddresses.last24Hours, cloudflare)} addresses · ${distributionCount(downloads?.requests.last7Days, cloudflare)} fetches/7d`,
    ],
    [
      "Current-version reach",
      distributionCount(current?.last24Hours, cloudflare),
      cloudflare.currentVersion
        ? `v${cloudflare.currentVersion} · ${distributionCount(current?.last7Days, cloudflare)} addresses/7d`
        : "current release could not be matched to traffic",
    ],
    [
      "GitHub DMG downloads",
      release ? count(release.dmgDownloads) : "—",
      release
        ? `${release.tag} cumulative · ${count(release.allAssetDownloads)} all release assets`
        : "latest public release count unavailable",
    ],
  ]);

  const versions = cloudflare.observedVersions;
  $("#distribution-version-rows").replaceChildren(
    ...versions.map((version) => tableRow([
      version.version,
      distributionCount(version.sourceAddressesLast7Days, cloudflare),
      distributionCount(version.requestsLast7Days, cloudflare),
    ])),
  );
  $("#distribution-version-empty").hidden = versions.length !== 0;

  $("#distribution-source-status").replaceChildren(
    statusLine(
      "Cloudflare analytics",
      cloudflare.reasonCode
        ? `${cloudflare.status} · ${cloudflare.reasonCode}`
        : cloudflare.status,
    ),
    statusLine(
      "Evidence window",
      cloudflare.window
        ? `${formatTime(cloudflare.window.startsAt)} → ${formatTime(cloudflare.window.endsAt)}`
        : "—",
    ),
    statusLine(
      "Sampling",
      cloudflare.sampled === null
        ? "—"
        : cloudflare.sampled
          ? "Cloudflare returned sampled estimates"
          : "unsampled (sample interval 1)",
    ),
    statusLine(
      "Result bound",
      cloudflare.bounded === null
        ? "—"
        : cloudflare.bounded
          ? "one or more 10,000-row caps reached"
          : "no query row cap reached",
    ),
    statusLine(
      "GitHub releases",
      github.reasonCode ? `${github.status} · ${github.reasonCode}` : github.status,
    ),
    statusLine(
      "Latest release",
      release ? `${release.tag} · ${formatTime(release.publishedAt)}` : "—",
    ),
    statusLine("Raw source addresses stored", "no"),
  );
}

function renderControls(controls) {
  for (const name of ["enrollment", "uploadRegistration", "processing", "publication"]) {
    $(`input[name="${name}"]`).checked = controls[name] === true;
  }
  $("#service-state").textContent = `${controls.state}, revision ${controls.revision}`;
}

function statusLine(label, value) {
  const line = document.createElement("p");
  const name = document.createElement("strong");
  name.textContent = `${label}: `;
  line.append(name, document.createTextNode(value));
  return line;
}

function renderIngress(ingress) {
  const card = $("#ingress-status");
  if (ingress === null) {
    card.replaceChildren(statusLine(
      "Upload ingress budget",
      "unavailable — the budget binding is not configured or unreachable",
    ));
    return;
  }
  card.replaceChildren(
    statusLine("Active leases", `${ingress.activeLeases} of ${ingress.maximumConcurrent}`),
    statusLine("Available start tokens", `${ingress.availableStartTokens} of ${ingress.burst}`),
    statusLine("Concurrency denials", text(ingress.concurrencyDenials)),
    statusLine("Start-rate denials", text(ingress.startRateDenials)),
    statusLine("Last denied", formatTime(ingress.lastDeniedAt)),
  );
}

function renderErrors(errors) {
  const body = $("#error-groups");
  body.replaceChildren(...errors.groups.map((group) => tableRow([
    group.routeClass,
    group.errorCode,
    `${group.occurrences} (${group.ratePerDay}/day)`,
    formatTime(group.latestAt),
  ])));
  $("#error-empty").hidden = errors.groups.length !== 0;
  $("#recent-diagnostic-rows").replaceChildren(
    ...errors.recentDiagnostics.map((diagnostic) => tableRow([
      diagnostic.requestId,
      diagnostic.routeClass,
      diagnostic.errorCode,
      diagnostic.status,
      formatTime(diagnostic.occurredAt),
    ])),
  );
  $("#recent-diagnostic-empty").hidden = errors.recentDiagnostics.length !== 0;
  const lookup = $("#diagnostic-lookup");
  if (errors.lookup) {
    lookup.textContent = `${errors.lookup.requestId}: ${errors.lookup.errorCode} on ${errors.lookup.routeClass} at ${formatTime(errors.lookup.occurredAt)}`;
    lookup.hidden = false;
  } else if ($("#diagnostic-reference").value) {
    lookup.textContent = "No retained event matched that reference.";
    lookup.hidden = false;
  } else {
    lookup.hidden = true;
  }
}

function renderOperational(overview) {
  const lifecycle = overview.lifecycle;
  const reconciliation = overview.reconciliation;
  const daily = overview.dailyPublication;
  $("#lifecycle-status").replaceChildren(
    ...[
      ["Retention lifecycle", `${lifecycle.state} · ${lifecycle.quarantineRetentionComplete ? "complete" : "incomplete"}`],
      ["Restore replay", lifecycle.restoreReplayComplete ? "complete" : "incomplete"],
      ["Quarantine reconciliation", `${reconciliation.state} · ${reconciliation.reconciliationComplete ? "complete" : "incomplete"}`],
      ["Latest accepted upload", formatTime(overview.counts.contributions.latestAcceptedAt)],
      ["Weekly rebuild queue", text(overview.pendingHistoricalRebuilds)],
      ["Daily rebuild queue", count(daily.pendingRebuilds, daily.pendingRebuildsBounded)],
      ["Latest daily evidence", text(daily.latestEvidenceDay)],
      ["Latest daily publication", formatTime(daily.latestReleasedAt)],
      ["Last maintenance", formatTime(lifecycle.maintenanceRunAt)],
      ["Failure code", text(lifecycle.failureCode)],
    ].map(([label, value]) => statusLine(label, value)),
  );
  const rows = overview.snapshots || [];
  $("#snapshot-rows").replaceChildren(...rows.map((snapshot) => tableRow([
    snapshot.snapshotId,
    `${snapshot.weekStart} → ${snapshot.weekEnd}`,
    snapshot.releaseState,
    formatTime(snapshot.releasedAt),
  ])));
  $("#snapshot-empty").hidden = rows.length !== 0;
}

function renderAudit(rows) {
  $("#audit-rows").replaceChildren(...rows.map((item) => tableRow([
    item.action,
    item.outcome,
    JSON.stringify(item.details),
    formatTime(item.createdAt),
  ])));
}

function render(overview) {
  state.overview = overview;
  renderAttention(overview);
  renderCounts(overview);
  renderQuarantine(overview);
  renderDistribution(overview.distribution);
  renderControls(overview.collection);
  renderOperational(overview);
  renderIngress(overview.ingress);
  renderErrors(overview.errors);
  renderAudit(overview.audit);
  $("#last-refresh").textContent = formatTime(overview.generatedAt);
  $("#service-state").textContent = `${overview.service.environment} · ${overview.collection.state}`;
}

async function load() {
  $("#refresh").disabled = true;
  try {
    // No app session on the admin host: authentication is Cloudflare Access and
    // the owner-email pin, and CSRF is the always-sent x-usage-monitor-admin
    // header. The old /api/v1/session pre-fetch 401'd here and was the dead
    // console symptom.
    const reference = $("#diagnostic-reference").value.trim();
    const query = reference ? `?diagnosticReference=${encodeURIComponent(reference)}` : "";
    render(projectAdminOverview(await request(`/api/v1/admin/overview${query}`)));
    $("#notice").hidden = true;
  } catch (error) {
    showNotice(`Operations view unavailable: ${error.message}.`);
  } finally {
    $("#refresh").disabled = false;
  }
}

$("#refresh").addEventListener("click", load);
$("#diagnostic-form").addEventListener("submit", (event) => {
  event.preventDefault();
  load();
});
$("#controls-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    projectAdminAction(await request("/api/v1/admin/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "set_collection_controls",
        expectedRevision: state.overview?.collection?.revision,
        enrollment: form.get("enrollment") === "on",
        uploadRegistration: form.get("uploadRegistration") === "on",
        processing: form.get("processing") === "on",
        publication: form.get("publication") === "on",
        reasonCode: form.get("reasonCode"),
      }),
    }), "set_collection_controls");
    showNotice("Collection state saved and audited.", "info");
    await load();
  } catch (error) {
    showNotice(`Collection state was not changed: ${adminActionErrorMessage(error)}`);
  }
});
$("#run-maintenance").addEventListener("click", async () => {
  $("#run-maintenance").disabled = true;
  $("#maintenance-result").textContent = "Running bounded maintenance…";
  try {
    const result = projectAdminAction(await request("/api/v1/admin/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "run_maintenance" }),
    }), "run_maintenance");
    $("#maintenance-result").textContent = `Completed: ${result.result.code}.`;
    await load();
  } catch (error) {
    $("#maintenance-result").textContent = `Maintenance failed: ${adminActionErrorMessage(error)}`;
  } finally {
    $("#run-maintenance").disabled = false;
  }
});

load();
