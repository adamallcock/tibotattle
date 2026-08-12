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

function renderCounts(overview) {
  const counts = overview.counts;
  const metrics = [
    ["Active participants", count(counts.participants.active, counts.participants.bounded), `${count(counts.participants.total, counts.participants.bounded)} total`],
    ["Enrolled last 24h", count(counts.participants.enrolledLast24Hours), `${count(counts.participants.enrolledLast7Days)} in the last 7 days`],
    ["Telemetry contributions", count(counts.contributions.telemetry.accepted, counts.contributions.telemetry.bounded), `${count(counts.contributions.telemetry.total, counts.contributions.telemetry.bounded)} total`],
    ["Accepted last 24h", count(counts.contributions.telemetry.acceptedLast24Hours), `${count(counts.contributions.telemetry.acceptedLast7Days)} in the last 7 days`],
    ["Stored telemetry records", count(counts.contributions.storedTelemetryRecords, counts.contributions.storedTelemetryRecordsBounded), "content-free metadata rows"],
    ["Pending quarantine", count(counts.pendingQuarantineObjects, counts.pendingQuarantineObjectsBounded), "objects awaiting reconciliation"],
  ];
  $("#counts").replaceChildren(...metrics.map(([label, value, detail]) => {
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
  $("#lifecycle-status").replaceChildren(
    ...[
      ["Retention lifecycle", `${lifecycle.state} · ${lifecycle.quarantineRetentionComplete ? "complete" : "incomplete"}`],
      ["Restore replay", lifecycle.restoreReplayComplete ? "complete" : "incomplete"],
      ["Quarantine reconciliation", `${reconciliation.state} · ${reconciliation.reconciliationComplete ? "complete" : "incomplete"}`],
      ["Historical rebuild queue", text(overview.pendingHistoricalRebuilds)],
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
  renderCounts(overview);
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
