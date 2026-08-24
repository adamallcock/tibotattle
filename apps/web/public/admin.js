import {
  adminActionErrorMessage,
  adminResponseError,
  projectAdminAllowancePreview,
  projectAdminAction,
  projectAdminMetricsHistory,
  projectAdminOverview,
} from "./admin-client.js";
import { formatNumber, formatReportingTime } from "./ui-format.js";

const state = {
  csrfToken: "",
  overview: null,
  loading: false,
  refreshTimer: null,
  refreshStatusTimer: null,
  nextRefreshAt: null,
  lastSuccessfulLoadAt: null,
  retryDelayMilliseconds: 30_000,
  allowancePreview: null,
  allowanceMode: "combined",
  allowanceRangeDays: 30,
  notificationPreferences: null,
  metricsHistory: undefined,
  auditRows: [],
  auditPage: 0,
  auditSignature: null,
  diagnosticLookup: null,
  diagnosticLookupGeneration: 0,
  loadGeneration: 0,
};
const $ = (selector) => document.querySelector(selector);
const ADMIN_PAGE_CLASS = "admin-operator-page";
const AUTO_REFRESH_STORAGE_KEY = "tibotattle-admin-auto-refresh-minutes-v1";
const NOTIFICATION_STORAGE_KEY = "tibotattle-admin-notifications-v2";
const LEGACY_NOTIFICATION_STORAGE_KEY = "tibotattle-admin-notifications-v1";
const DEFAULT_AUTO_REFRESH_MINUTES = 5;
const AUTO_REFRESH_OPTIONS = new Set([0, 1, 5, 15]);
const NOTIFICATION_REPEAT_OPTIONS = new Set([0, 5, 15, 60]);
const NOTIFICATION_TOPICS = Object.freeze({
  collection: "Collection",
  maintenance: "Maintenance, storage & rebuilds",
  evidence: "Evidence sources",
  failures: "Sampled server failures",
});
const NOTIFICATION_TOPIC_IDS = Object.freeze(Object.keys(NOTIFICATION_TOPICS));
const AUDIT_PAGE_SIZE = 10;
const AUDIT_RESULT_LIMIT = 20;
const RETAINED_SERVICE_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LOCAL_DIAGNOSTIC_REFERENCE = /^TT-[0-9A-HJKMNP-TV-Z]{6}$/u;
const ADMIN_TITLE = "TiboTattle operations";
const isAdminPage = document.body?.classList?.contains(ADMIN_PAGE_CLASS) === true;
let infoHintSequence = 0;

const INFO_HINTS = Object.freeze({
  "Approved community accounts": "Approved identities that are currently active and allowed to contribute. This includes approved accounts that have not yet sent accepted data.",
  "Accounts with accepted data": "Distinct approved accounts with at least one accepted whole contribution or incremental chunk. The caption shows how many were active in the trailing 30 days.",
  "Approved last 24h": "Identities first approved during the trailing 24 hours. The caption gives the corresponding trailing seven-day count.",
  "Current incremental chunks": "Accepted incremental journal chunks that have not been superseded. The caption includes every retained chunk row, including older superseded rows.",
  "Accepted uploads last 24h": "Accepted whole contributions plus incremental chunks received during the trailing 24 hours. One account can send many uploads.",
  "Upload safety registrations": "Crash-safety markers created before uploaded objects are committed to the database. Recent markers are normal; older markers are reconciled.",
  "Recent registrations": "Upload safety markers still inside the one-hour grace period. They are expected and are not yet eligible for reconciliation.",
  "Due and referenced": "Markers older than the grace period whose uploaded objects are referenced by accepted database rows. The object is preserved and the temporary marker should clear.",
  "Due and unreferenced": "Markers older than the grace period with no accepted database row pointing to the object. These are orphan candidates scheduled for safe deletion.",
  "Pending registrations": "All upload safety markers currently waiting for their grace period or reconciliation pass.",
  "Oldest registration": "The earliest marker still waiting. Its age helps distinguish normal settling from a stalled reconciliation queue.",
  "Newest registration": "The most recently created upload safety marker.",
  "Next registration becomes due": "When the oldest recent marker will leave the grace period and become eligible for reconciliation.",
  "Eligible cutoff now": "Markers created at or before this time are old enough to be examined by reconciliation.",
  "Last reconciliation": "When the most recent upload-object reconciliation pass completed.",
  "Last pass cutoff": "The eligibility cutoff used by the most recent reconciliation pass.",
  "Registrations examined last pass": "How many eligible markers the most recent bounded reconciliation pass inspected.",
  "Referenced objects preserved": "Eligible objects confirmed as referenced by accepted data and therefore kept during the most recent pass.",
  "Orphan objects removed": "Eligible objects with no accepted-data reference that were safely deleted during the most recent pass.",
  "Reconciliation failure": "The last recorded reconciliation error code. A dash means no failure was recorded.",
  "Active-install proxy": "Distinct source IP addresses seen on first-party app update traffic in the trailing 24 hours. It is a rough activity proxy, not a count of people or devices.",
  "App preflight call-ins": "Requests to the app preflight endpoint. They show running copies checking compatibility, but retries and shared addresses prevent a user census.",
  "Sparkle update checks": "Requests for the Sparkle appcast used to discover updates. A single installation can check more than once.",
  "Sparkle artifact fetches": "Requests for update artifacts. Fetches can include retries or automated checks and do not prove a completed installation.",
  "Current-version reach": "Distinct source addresses whose update traffic identifies the current published app version.",
  "GitHub DMG downloads": "GitHub's cumulative download counter for every currently published DMG asset. It counts asset downloads, not launches, active users, or unique devices. This optional total does not affect the first-party activity estimates.",
  "GitHub DMG downloads since prior snapshot": "The non-negative change in current GitHub DMG counters since the last complete owner snapshot. It begins after the first successful sync and does not infer downloads before this dashboard started recording snapshots.",
  "Cloudflare analytics": "Whether first-party request analytics were available for this dashboard refresh.",
  "Evidence window": "The exact request-analytics time range used for the displayed activity estimates.",
  "Sampling": "Whether Cloudflare returned every matching row or a sampled estimate.",
  "Result bound": "Whether a query reached its safety row cap. A bounded result is a minimum rather than an exact total.",
  "GitHub releases": "Whether the most recent complete all-release snapshot was available. If this source is unavailable, the first-party app activity evidence above is still valid. A failed GitHub poll retains the last known good snapshot rather than showing zero downloads.",
  "GitHub snapshot": "When the most recent complete, all-release GitHub asset snapshot was recorded. GitHub exposes cumulative counters; this private dashboard stores snapshots to calculate future changes safely.",
  "GitHub sync": "The most recent owner or scheduled attempt to refresh GitHub release counters. A stale or failed source never erases the last known good totals.",
  "Counter regressions": "How many currently observed DMG assets reported a lower cumulative counter than their previous snapshot. This can happen when an asset is replaced or corrected; the dashboard never presents it as a negative download total.",
  "Latest release": "The release tag and publication time used for the download totals.",
  "Raw source addresses stored": "Whether this dashboard persists the source addresses used for distinct-address estimates. It should always say no.",
  "Upload ingress budget": "Shared admission state that protects the service from too many simultaneous or rapidly starting uploads.",
  "Active leases": "Uploads currently holding a concurrency slot, compared with the maximum simultaneous allowance.",
  "Available start tokens": "Upload starts still available in the current rate-limit bucket, compared with the bucket's full burst size.",
  "Concurrency denials": "Upload starts refused because every simultaneous-upload slot was already occupied.",
  "Start-rate denials": "Upload starts refused because the per-minute start budget was exhausted.",
  "Last denied": "When either upload admission limit most recently refused a request.",
  "Retention lifecycle": "The latest deletion-retention maintenance state and whether quarantine retention completed.",
  "Restore replay": "Whether deletion protections were replayed completely after restoring stored data.",
  "Quarantine reconciliation": "The latest upload-object housekeeping state and whether its bounded pass cleared all eligible work.",
  "Latest accepted upload": "The newest accepted whole contribution or incremental chunk received by the service.",
  "Weekly rebuild queue": "Weekly community snapshots waiting to be rebuilt from accepted evidence.",
  "Daily rebuild queue": "Daily community aggregates waiting to be rebuilt from accepted evidence.",
  "Latest daily evidence": "The newest evidence day represented by a published daily community aggregate.",
  "Latest daily publication": "When a daily community aggregate was most recently published.",
  "Last maintenance": "When the latest bounded retention, reconciliation, and publication maintenance pass ran.",
  "Failure code": "The latest lifecycle failure identifier. A dash means no failure was recorded.",
  "New sign-ups": "Community accounts created, from retained participant records over the recent 30-day history window.",
  "Web sign-ins": "Completed sign-ins on the website, counted from issued web sessions. Sign-in attempts that never completed are not retained and are not counted.",
  "Device pairings": "Pairing handshakes issued to Macs starting community upload setup.",
  "Device credentials": "Upload credentials issued to Macs that completed pairing.",
  "Upload consents": "Devices that recorded an explicit telemetry upload consent.",
  "Chunks uploaded": "Incremental contribution chunks accepted into the corpus.",
  "Records uploaded": "Usage records inside accepted chunks, summed per day.",
  "People uploading": "Distinct accounts that uploaded at least one chunk that day.",
  "DMG downloads": "Cumulative installer downloads across all GitHub releases, sampled by the distribution sync. The delta is movement since the prior day's last sample.",
  "Published band cohort": "People inside the published community allowance band (the site's “from N people”).",
  "Plan cohorts": "Distinct contributors on each Codex plan (each counted under their current plan only), and that plan's measured allowance-window value in API-price-equivalent dollars. Ratios are measured from real fits, never assumed from the nominal plan multipliers.",
});

const AUDIT_ACTIONS = Object.freeze({
  run_maintenance: Object.freeze({
    label: "Maintenance pass",
    explanation: "An owner-initiated pass that applies retention cleanup, reconciles upload objects, and rebuilds eligible community aggregates.",
  }),
  set_collection_controls: Object.freeze({
    label: "Collection controls",
    explanation: "A revision-checked change to enrollment, upload registration, processing, or publication switches.",
  }),
  sync_distribution: Object.freeze({
    label: "GitHub distribution sync",
    explanation: "A bounded, owner-initiated read of every published GitHub release that records an all-release asset snapshot.",
  }),
});

const AUDIT_FIELD_LABELS = Object.freeze({
  phase: "Phase",
  code: "Result code",
  expectedRevision: "Expected revision",
  revision: "Saved revision",
  state: "Collection state",
  reasonCode: "Reason",
  "flags.enrollment": "Enrollment",
  "flags.uploadRegistration": "Upload registration",
  "flags.processing": "Processing",
  "flags.publication": "Publication",
  lifecycleComplete: "Retention lifecycle complete",
  quarantineReconciliationComplete: "Upload reconciliation complete",
  expiredIdentityHandoffsPurged: "Expired sign-in handoffs removed",
  expiredIdentityHandoffPurgeComplete: "Sign-in handoff cleanup complete",
  expiredDeletionTombstonesPurged: "Expired deletion protections removed",
  deletionTombstonePurgeComplete: "Deletion-protection cleanup complete",
  expiredPrimaryIdentityReenrollmentCooldownsPurged: "Expired primary cooldowns removed",
  primaryIdentityReenrollmentCooldownPurgeComplete: "Primary cooldown cleanup complete",
  expiredIdentityReenrollmentCooldownsPurged: "Expired deletion-ledger cooldowns removed",
  identityReenrollmentCooldownPurgeComplete: "Deletion-ledger cooldown cleanup complete",
  aggregateRebuildComplete: "Community rebuild complete",
  publicationEnabled: "Publication enabled",
  observedAt: "Snapshot observed at",
});

const AUDIT_FIELD_HINTS = Object.freeze({
  phase: "The operation stage recorded when this audit entry was written.",
  code: "The machine-readable result from the operation. OK means every recorded check completed; MAINTENANCE_INCOMPLETE means the pass ran but bounded work remains.",
  expectedRevision: "The collection-control revision the dashboard expected before applying a change. This prevents overwriting a newer operator decision.",
  revision: "The collection-control revision saved after a successful change.",
  state: "The resulting overall collection posture derived from the four collection switches.",
  reasonCode: "The operator-selected reason stored with the collection-control change.",
  "flags.enrollment": "Whether new community accounts may be approved.",
  "flags.uploadRegistration": "Whether approved accounts may register ongoing upload capability.",
  "flags.processing": "Whether accepted uploads may be processed into usable evidence.",
  "flags.publication": "Whether eligible community aggregates may be published.",
  lifecycleComplete: "Whether the bounded retention and deletion lifecycle finished all work available in this pass.",
  quarantineReconciliationComplete: "Whether upload-object reconciliation cleared every eligible marker in this bounded pass.",
  expiredIdentityHandoffsPurged: "Number of expired temporary sign-in handoff records removed in this pass.",
  expiredIdentityHandoffPurgeComplete: "Whether no eligible expired sign-in handoffs remain after this pass.",
  expiredDeletionTombstonesPurged: "Number of expired deletion-protection records removed in this pass.",
  deletionTombstonePurgeComplete: "Whether no eligible expired deletion-protection records remain after this pass.",
  expiredPrimaryIdentityReenrollmentCooldownsPurged: "Number of expired identity re-enrollment cooldowns removed from the primary database.",
  primaryIdentityReenrollmentCooldownPurgeComplete: "Whether primary-database identity cooldown cleanup finished its eligible work.",
  expiredIdentityReenrollmentCooldownsPurged: "Number of expired identity re-enrollment cooldowns removed from the deletion ledger.",
  identityReenrollmentCooldownPurgeComplete: "Whether deletion-ledger identity cooldown cleanup finished its eligible work.",
  aggregateRebuildComplete: "Whether all queued daily and weekly community aggregate rebuilds completed in this pass.",
  publicationEnabled: "Whether community publication was enabled while this maintenance pass ran.",
  observedAt: "When the complete GitHub release snapshot was recorded.",
});

const MAINTENANCE_COMPLETION_FIELDS = Object.freeze([
  ["lifecycleComplete", "retention lifecycle"],
  ["quarantineReconciliationComplete", "upload-object reconciliation"],
  ["expiredIdentityHandoffPurgeComplete", "sign-in handoff cleanup"],
  ["deletionTombstonePurgeComplete", "deletion-protection cleanup"],
  ["primaryIdentityReenrollmentCooldownPurgeComplete", "primary identity cooldown cleanup"],
  ["identityReenrollmentCooldownPurgeComplete", "deletion-ledger cooldown cleanup"],
  ["aggregateRebuildComplete", "community aggregate rebuilds"],
]);

function text(value) {
  return value === null || value === undefined ? "—" : String(value);
}

function count(value, bounded = false) {
  return `${text(value)}${bounded ? "+" : ""}`;
}

function formatTime(value) {
  return value ? formatReportingTime(value) : "—";
}

function plainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function listPhrase(values) {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function humanizeToken(value) {
  const normalized = String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized
    ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`
    : "Unknown";
}

function positionInfoHint(trigger, tooltip) {
  const anchor = trigger.getBoundingClientRect();
  const viewportPadding = 12;
  const gap = 8;
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  const left = Math.min(
    Math.max(viewportPadding, anchor.left),
    Math.max(viewportPadding, window.innerWidth - width - viewportPadding),
  );
  const below = anchor.bottom + gap;
  const top = below + height <= window.innerHeight - viewportPadding
    ? below
    : Math.max(viewportPadding, anchor.top - height - gap);
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
}

function infoHint(label, explanation = INFO_HINTS[label]) {
  if (!explanation) return null;
  const hint = document.createElement("span");
  hint.className = "admin-info";
  const trigger = document.createElement("button");
  trigger.className = "admin-info-trigger";
  trigger.type = "button";
  trigger.textContent = "i";
  trigger.setAttribute("aria-label", `Explain ${label}`);
  const tooltip = document.createElement("span");
  tooltip.className = "admin-info-tooltip";
  tooltip.id = `admin-info-${++infoHintSequence}`;
  tooltip.setAttribute("role", "tooltip");
  tooltip.textContent = explanation;
  trigger.setAttribute("aria-describedby", tooltip.id);
  trigger.addEventListener("mouseenter", () => positionInfoHint(trigger, tooltip));
  trigger.addEventListener("focus", () => positionInfoHint(trigger, tooltip));
  hint.append(trigger, tooltip);
  return hint;
}

function labelWithInfo(label, explanation = INFO_HINTS[label]) {
  const wrapper = document.createElement("span");
  wrapper.className = "admin-label-with-info";
  const copy = document.createElement("span");
  copy.className = "admin-label-text";
  copy.textContent = label;
  wrapper.append(copy);
  const hint = infoHint(label, explanation);
  if (hint) wrapper.append(hint);
  return wrapper;
}

function auditFieldLabel(key) {
  return AUDIT_FIELD_LABELS[key] ?? humanizeToken(key.split(".").at(-1));
}

function auditFieldHint(key) {
  return AUDIT_FIELD_HINTS[key]
    ?? "An additional value retained in the audit record for troubleshooting.";
}

function formatAuditValue(key, value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") {
    if (key.startsWith("flags.")) return value ? "On" : "Off";
    if (key.endsWith("Complete")) return value ? "Complete" : "Pending";
    if (key.endsWith("Enabled")) return value ? "Enabled" : "Disabled";
    return value ? "Yes" : "No";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? formatNumber(value) : String(value);
  }
  if (typeof value === "string") {
    if (["phase", "state"].includes(key)) return humanizeToken(value);
    if (key === "reasonCode") {
      const readable = humanizeToken(value);
      return readable.toLowerCase() === value.toLowerCase()
        ? value
        : `${readable} (${value})`;
    }
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function flattenAuditDetails(details, limit = 40) {
  const record = plainRecord(details);
  if (!record) return [];
  const fields = [];
  let truncated = false;

  function visit(value, key, depth) {
    if (fields.length >= limit) {
      truncated = true;
      return;
    }
    const nested = plainRecord(value);
    if (nested && depth < 2) {
      const entries = Object.entries(nested);
      if (entries.length === 0) {
        fields.push({ key, value: "{}" });
        return;
      }
      for (const [childKey, childValue] of entries) {
        visit(childValue, key ? `${key}.${childKey}` : childKey, depth + 1);
      }
      return;
    }
    fields.push({ key, value: formatAuditValue(key, value) });
  }

  for (const [key, value] of Object.entries(record)) visit(value, key, 0);
  if (truncated) {
    fields.push({
      key: "additionalFields",
      label: "Additional fields",
      hint: "This audit entry contains more technical values than the compact dashboard displays.",
      value: `More than ${limit} fields were recorded`,
    });
  }
  return fields;
}

function auditResult(label, tone, explanation) {
  return { label, tone, explanation };
}

function maintenancePresentation(outcome, details) {
  const code = details?.code;
  if (outcome === "started") {
    return {
      result: auditResult(
        "In progress",
        "warning",
        "The maintenance request was recorded, but this entry does not contain a final result yet.",
      ),
      summary: "A maintenance pass was requested; no final outcome has been recorded.",
    };
  }
  if (outcome === "failure") {
    return {
      result: auditResult(
        "Failed",
        "failure",
        "The maintenance request failed and may require investigation before it is retried.",
      ),
      summary: code
        ? `The maintenance request failed with result code ${code}.`
        : "The maintenance request failed before it produced a usable result.",
    };
  }
  if (outcome === "success" && code === "MAINTENANCE_INCOMPLETE") {
    const remaining = MAINTENANCE_COMPLETION_FIELDS
      .filter(([key]) => details?.[key] === false)
      .map(([, label]) => label);
    return {
      result: auditResult(
        "Follow-up needed",
        "warning",
        "The request succeeded, but one or more bounded maintenance stages still had eligible work when this pass ended.",
      ),
      summary: remaining.length > 0
        ? `The pass ran, but ${listPhrase(remaining)} ${remaining.length === 1 ? "still has" : "still have"} eligible work remaining. Another bounded pass may finish it.`
        : "The pass ran, but some bounded maintenance work remained. Another pass may finish it.",
    };
  }
  if (outcome === "success") {
    return {
      result: auditResult(
        "Completed",
        "success",
        "The maintenance request finished and its recorded result does not require another bounded pass.",
      ),
      summary: code && code !== "OK"
        ? `The maintenance pass completed with result code ${code}.`
        : "The maintenance pass completed all recorded retention, reconciliation, cleanup, and publication checks.",
    };
  }
  return {
    result: auditResult(
      humanizeToken(outcome),
      "warning",
      "This is the outcome stored by the service for the maintenance request.",
    ),
    summary: `The service recorded a ${humanizeToken(outcome).toLowerCase()} maintenance outcome.`,
  };
}

function collectionControlSummary(details) {
  const parts = [];
  if (details?.revision !== undefined) {
    parts.push(`Collection controls were saved at revision ${details.revision}`);
  } else {
    parts.push("Collection controls were saved");
  }
  if (details?.state) parts.push(`the service is now ${humanizeToken(details.state).toLowerCase()}`);
  const flags = plainRecord(details?.flags);
  if (flags) {
    const flagLabels = {
      enrollment: "enrollment",
      uploadRegistration: "upload registration",
      processing: "processing",
      publication: "publication",
    };
    const enabled = Object.entries(flagLabels)
      .filter(([key]) => flags[key] === true)
      .map(([, label]) => label);
    const disabled = Object.entries(flagLabels)
      .filter(([key]) => flags[key] === false)
      .map(([, label]) => label);
    if (enabled.length > 0) parts.push(`${listPhrase(enabled)} ${enabled.length === 1 ? "is" : "are"} on`);
    if (disabled.length > 0) parts.push(`${listPhrase(disabled)} ${disabled.length === 1 ? "is" : "are"} off`);
  }
  const summary = `${parts.join("; ")}.`;
  return details?.reasonCode
    ? `${summary} Reason: ${humanizeToken(details.reasonCode)}.`
    : summary;
}

function collectionControlPresentation(outcome, details) {
  if (outcome === "started") {
    return {
      result: auditResult(
        "In progress",
        "warning",
        "The controls change was recorded, but this entry does not contain a final result yet.",
      ),
      summary: "A collection-control change was requested; no final outcome has been recorded.",
    };
  }
  if (outcome === "failure") {
    const conflict = details?.code === "ADMIN_ACTION_CONFLICT";
    return {
      result: auditResult(
        "Failed",
        "failure",
        conflict
          ? "The service rejected a stale edit so it could not overwrite a newer operator decision."
          : "The collection-control change was not applied.",
      ),
      summary: conflict
        ? "The change was not applied because the dashboard used an older control revision. Refresh the page before trying again."
        : details?.code
          ? `The collection-control change failed with result code ${details.code}.`
          : "The collection-control change failed before it produced a usable result.",
    };
  }
  if (outcome === "success") {
    return {
      result: auditResult(
        "Applied",
        "success",
        "The revision-checked collection-control change was saved successfully.",
      ),
      summary: collectionControlSummary(details),
    };
  }
  return {
    result: auditResult(
      humanizeToken(outcome),
      "warning",
      "This is the outcome stored by the service for the collection-control change.",
    ),
    summary: `The service recorded a ${humanizeToken(outcome).toLowerCase()} collection-control outcome.`,
  };
}

function auditPresentation(item) {
  const details = plainRecord(item.details);
  const action = AUDIT_ACTIONS[item.action] ?? {
    label: humanizeToken(item.action),
    explanation: "An owner control action recorded by the service.",
  };
  const presentation = item.action === "run_maintenance"
    ? maintenancePresentation(item.outcome, details)
    : item.action === "set_collection_controls"
      ? collectionControlPresentation(item.outcome, details)
      : {
          result: auditResult(
            humanizeToken(item.outcome),
            item.outcome === "failure" ? "failure" : item.outcome === "success" ? "success" : "warning",
            "This is the outcome stored by the service for this owner action.",
          ),
          summary: `${action.label} recorded a ${humanizeToken(item.outcome).toLowerCase()} outcome.`,
        };
  const fields = [
    {
      key: "storedAction",
      label: "Stored action",
      hint: "The exact machine-readable action name retained in the audit record.",
      value: text(item.action),
    },
    {
      key: "storedOutcome",
      label: "Stored outcome",
      hint: "The exact machine-readable outcome retained in the audit record.",
      value: text(item.outcome),
    },
    ...flattenAuditDetails(item.details),
  ];
  return { action, fields, ...presentation };
}

function auditDetailsNode(fields) {
  const details = document.createElement("details");
  details.className = "admin-audit-details";
  const summary = document.createElement("summary");
  summary.textContent = `Technical fields (${fields.length})`;
  const values = document.createElement("dl");
  values.className = "admin-audit-fields";
  for (const field of fields) {
    const name = document.createElement("dt");
    const label = field.label ?? auditFieldLabel(field.key);
    name.append(labelWithInfo(label, field.hint ?? auditFieldHint(field.key)));
    const value = document.createElement("dd");
    value.textContent = field.value;
    values.append(name, value);
  }
  details.append(summary, values);
  return details;
}

function auditRow(item) {
  const presentation = auditPresentation(item);
  const row = document.createElement("tr");

  const action = document.createElement("td");
  action.className = "admin-audit-action";
  action.setAttribute("data-label", "Action");
  action.append(labelWithInfo(
    presentation.action.label,
    presentation.action.explanation,
  ));

  const result = document.createElement("td");
  result.className = "admin-audit-result";
  result.setAttribute("data-label", "Result");
  const resultContent = document.createElement("span");
  resultContent.className = "admin-audit-result-content";
  const badge = document.createElement("span");
  badge.className = `admin-audit-badge admin-audit-badge-${presentation.result.tone}`;
  badge.textContent = presentation.result.label;
  resultContent.append(
    badge,
    infoHint(presentation.result.label, presentation.result.explanation),
  );
  result.append(resultContent);

  const happened = document.createElement("td");
  happened.setAttribute("data-label", "What happened");
  const summary = document.createElement("p");
  summary.className = "admin-audit-summary";
  summary.textContent = presentation.summary;
  happened.append(summary, auditDetailsNode(presentation.fields));

  const timestamp = document.createElement("td");
  timestamp.setAttribute("data-label", "Time");
  const time = document.createElement("time");
  time.className = "admin-audit-time";
  if (item.createdAt) time.setAttribute("datetime", item.createdAt);
  time.textContent = formatTime(item.createdAt);
  timestamp.append(time);

  row.append(action, result, happened, timestamp);
  return row;
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

function metricDescriptor(metric) {
  if (Array.isArray(metric)) {
    const [label, value, detail, points] = metric;
    return { label, value, detail, points };
  }
  return metric;
}

function renderMetricCards(selector, metrics) {
  $(selector).replaceChildren(...metrics.map((metric) => {
    const {
      label,
      value,
      detail,
      points,
      valueFormatter,
      historyUnavailable,
    } = metricDescriptor(metric);
    const card = document.createElement("div");
    card.className = "admin-card admin-metric";
    const name = labelWithInfo(label);
    const number = document.createElement("strong");
    number.textContent = text(value);
    const caption = document.createElement("small");
    caption.textContent = detail;
    card.append(
      name,
      number,
      caption,
      recentHistory(points, label, valueFormatter, historyUnavailable),
    );
    return card;
  }));
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const GROWTH_SCHEMA_VERSION = "admin-metrics-history-v0.2";

/**
 * A day-by-day count series with calendar gaps filled: event tables have no
 * row for a quiet day, but a sparkline that skips quiet days overstates the
 * slope. `fill` is 0 for per-day counts and "carry" for cumulative counters.
 * Exported for functional tests.
 */
export function calendarSeries(byDay, throughDay, fill) {
  return calendarPoints(byDay, throughDay, fill).map((point) => point.value);
}

export function calendarPoints(byDay, throughDay, fill) {
  if (!Array.isArray(byDay) || byDay.length === 0) return [];
  const counts = new Map(byDay.map((row) => [row.day, row.count]));
  const points = [];
  let cursor = byDay[0].day;
  let previous = 0;
  // Calendar walk in UTC, bounded to ~2 years of points as a corruption guard.
  for (let step = 0; step < 800 && cursor <= throughDay; step += 1) {
    const present = counts.get(cursor);
    const value = present === undefined
      ? (fill === "carry" ? previous : 0)
      : present;
    points.push({ at: cursor, value });
    previous = value;
    const next = new Date(`${cursor}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = next.toISOString().slice(0, 10);
  }
  return points;
}

/**
 * Pure sparkline geometry over a 120×28 viewBox: min-max normalized, flat
 * series drawn mid-band rather than dividing by zero. Fewer than two points
 * yields no geometry — a single sample is a number, not a shape. Exported for
 * functional tests.
 */
export function sparklineGeometry(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const normalized = values.map((point, index) => (
    typeof point === "number"
      ? { at: index, value: point }
      : { at: Date.parse(point.at), value: point.value }
  ));
  if (normalized.some((point) => !Number.isFinite(point.at)
      || !Number.isFinite(point.value))) return null;
  const pad = 2;
  const max = Math.max(...normalized.map((point) => point.value));
  const min = Math.min(...normalized.map((point) => point.value));
  const span = max - min || 1;
  const firstAt = normalized[0].at;
  const timeSpan = normalized.at(-1).at - firstAt || 1;
  const coordinates = normalized.map((point) => {
    const x = pad + ((point.at - firstAt) / timeSpan) * (120 - pad * 2);
    const y = 28 - pad - ((point.value - min) / span) * (28 - pad * 2);
    return { x, y };
  });
  const end = coordinates.at(-1);
  return {
    points: coordinates.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" "),
    endX: end.x.toFixed(1),
    endY: end.y.toFixed(1),
    coordinates: Object.freeze(coordinates),
  };
}

function sparkDate(value) {
  const options = value.length === 10
    ? { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }
    : {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    };
  return new Intl.DateTimeFormat(undefined, options).format(
    new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value),
  );
}

export function historyGapLabel(
  historyState,
  points,
  explicitlyUnavailable = false,
) {
  if (explicitlyUnavailable
      || (historyState === null && !Array.isArray(points))) {
    return "Recent history unavailable";
  }
  if (historyState === undefined && !Array.isArray(points)) {
    return "Recent history loading…";
  }
  if (!Array.isArray(points) || points.length < 2) {
    return points?.length === 1
      ? "1 snapshot · history starts here"
      : "Recent history not yet recorded";
  }
  return null;
}

function recentHistory(
  points,
  description,
  valueFormatter = count,
  explicitlyUnavailable = false,
) {
  const shell = document.createElement("div");
  shell.className = "admin-sparkline-shell";
  const gapLabel = historyGapLabel(
    state.metricsHistory,
    points,
    explicitlyUnavailable,
  );
  if (gapLabel !== null) {
    shell.classList?.add?.("admin-sparkline-gap");
    shell.textContent = gapLabel;
    return shell;
  }
  return sparkline(points, description, valueFormatter);
}

export function sparkline(points, description, valueFormatter = count) {
  const shell = document.createElement("div");
  shell.className = "admin-sparkline-shell admin-sparkline-interactive";
  shell.tabIndex = 0;
  shell.setAttribute("role", "figure");
  shell.setAttribute("aria-label", `${description} recent history. Use left and right arrows to inspect dates.`);
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("class", "admin-sparkline");
  svg.setAttribute("viewBox", "0 0 120 28");
  svg.setAttribute("aria-hidden", "true");
  const geometry = sparklineGeometry(points);
  if (geometry === null) return shell;
  const line = document.createElementNS(SVG_NAMESPACE, "polyline");
  line.setAttribute("class", "admin-sparkline-line");
  line.setAttribute("points", geometry.points);
  line.setAttribute("fill", "none");
  const marker = document.createElementNS(SVG_NAMESPACE, "circle");
  marker.setAttribute("class", "admin-sparkline-endpoint admin-sparkline-marker");
  marker.setAttribute("r", "2.6");
  const tooltip = document.createElement("span");
  tooltip.className = "admin-sparkline-tooltip";
  tooltip.id = `admin-sparkline-tooltip-${++infoHintSequence}`;
  tooltip.setAttribute("role", "status");
  tooltip.hidden = true;
  shell.setAttribute("aria-describedby", tooltip.id);
  let selectedIndex = points.length - 1;
  const select = (index, visible = true) => {
    selectedIndex = Math.max(0, Math.min(points.length - 1, index));
    const point = points[selectedIndex];
    const coordinate = geometry.coordinates[selectedIndex];
    marker.setAttribute("cx", coordinate.x.toFixed(1));
    marker.setAttribute("cy", coordinate.y.toFixed(1));
    tooltip.textContent = `${sparkDate(point.at)} · ${valueFormatter(point.value)}`;
    tooltip.hidden = !visible;
    shell.setAttribute("aria-label", `${description}: ${tooltip.textContent}. Use left and right arrows to inspect dates.`);
  };
  const selectFromPointer = (event) => {
    const touch = event.touches?.[0];
    const clientX = touch?.clientX ?? event.clientX;
    const rect = svg.getBoundingClientRect?.();
    if (!rect || !Number.isFinite(clientX) || rect.width <= 0) return;
    const viewX = Math.max(0, Math.min(120, ((clientX - rect.left) / rect.width) * 120));
    let nearest = 0;
    for (let index = 1; index < geometry.coordinates.length; index += 1) {
      if (Math.abs(geometry.coordinates[index].x - viewX)
          < Math.abs(geometry.coordinates[nearest].x - viewX)) nearest = index;
    }
    select(nearest);
  };
  shell.addEventListener("pointermove", selectFromPointer);
  shell.addEventListener("pointerenter", selectFromPointer);
  shell.addEventListener("pointerleave", () => { tooltip.hidden = true; });
  shell.addEventListener("touchstart", selectFromPointer, { passive: true });
  shell.addEventListener("focus", () => select(selectedIndex));
  shell.addEventListener("blur", () => { tooltip.hidden = true; });
  shell.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") select(0);
    else if (event.key === "End") select(points.length - 1);
    else select(selectedIndex + (event.key === "ArrowRight" ? 1 : -1));
  });
  select(selectedIndex, false);
  svg.append(line, marker);
  shell.append(svg, tooltip);
  return shell;
}

function deltaChip(delta, caption) {
  const chip = document.createElement("span");
  chip.className = `admin-delta ${delta > 0 ? "admin-delta-up" : "admin-delta-flat"}`;
  chip.textContent = `${delta > 0 ? "+" : ""}${count(delta)} last 24h`;
  if (caption) chip.title = caption;
  return chip;
}

function growthCard({ label, value, delta, deltaCaption, points, seriesLabel }) {
  const card = document.createElement("div");
  card.className = "admin-card admin-metric admin-growth-card";
  const name = labelWithInfo(label);
  const number = document.createElement("strong");
  number.textContent = text(value);
  const caption = document.createElement("small");
  caption.replaceChildren(deltaChip(delta, deltaCaption));
  card.append(name, number, caption, recentHistory(points, seriesLabel));
  return card;
}

function eventGrowthCard(label, series, throughDay) {
  const points = calendarPoints(series.byDay, throughDay, 0).slice(-30);
  return growthCard({
    label,
    value: count(series.total),
    delta: series.last24Hours,
    deltaCaption: `${count(series.previous24Hours)} in the prior 24h`,
    points,
    seriesLabel: `${label}, daily over the most recent ${points.length} calendar days`,
  });
}

function recentTimestampPoints(points, generatedAt, days = 30) {
  const through = Date.parse(generatedAt);
  const since = through - days * 24 * 60 * 60 * 1_000;
  return points.filter((point) => {
    const epoch = Date.parse(point.at);
    return Number.isFinite(epoch) && epoch >= since && epoch <= through;
  });
}

function gaugePoints(snapshots, key) {
  const points = (snapshots ?? []).flatMap((snapshot) => (
    typeof snapshot.metrics[key] === "number"
      ? [{ at: snapshot.capturedAt, value: snapshot.metrics[key] }]
      : []
  ));
  const generatedAt = state.metricsHistory?.generatedAt ?? points.at(-1)?.at;
  return generatedAt ? recentTimestampPoints(points, generatedAt) : points;
}

function eventHistoryPoints(name) {
  const history = state.metricsHistory;
  const series = history?.events?.[name];
  if (!history || !series) return null;
  return calendarPoints(series.byDay, history.generatedAt.slice(0, 10), 0).slice(-30);
}

function metricGaugePoints(key) {
  return state.metricsHistory
    ? gaugePoints(state.metricsHistory.gauges.snapshots, key)
    : null;
}

export function gaugeHistoryIsBounded(snapshots, boundedKey) {
  return (snapshots ?? []).some(
    (snapshot) => snapshot?.metrics?.[boundedKey] === 1,
  );
}

function metricGaugeEvidence(key, boundedKey, currentlyBounded = false) {
  const snapshots = state.metricsHistory?.gauges?.snapshots ?? [];
  return {
    points: metricGaugePoints(key),
    unavailable: currentlyBounded
      || gaugeHistoryIsBounded(snapshots, boundedKey),
  };
}

function renderGrowth(history) {
  const container = $("#growth-cards");
  const badge = $("#growth-status");
  if (!container || !badge) return;
  if (history === null) {
    badge.className = "admin-source-badge admin-source-partial";
    badge.textContent = "History unavailable";
    const unavailable = document.createElement("p");
    unavailable.className = "admin-empty";
    unavailable.textContent = "Recent metric history could not be loaded. Current service values remain above.";
    container.replaceChildren(unavailable);
    return;
  }
  const throughDay = history.generatedAt.slice(0, 10);
  const events = history.events;
  const cards = [
    eventGrowthCard("New sign-ups", events.participants, throughDay),
    eventGrowthCard("Web sign-ins", events.webSessions, throughDay),
    eventGrowthCard("Device pairings", events.devicePairings, throughDay),
    eventGrowthCard("Device credentials", events.deviceCredentials, throughDay),
    eventGrowthCard("Upload consents", events.deviceConsents, throughDay),
    eventGrowthCard("Chunks uploaded", events.uploadedChunks, throughDay),
    eventGrowthCard("Records uploaded", events.uploadedRecords, throughDay),
    eventGrowthCard("People uploading", events.uploadingParticipants, throughDay),
  ];
  if (history.downloads.available && history.downloads.byDay.length > 0) {
    const byDay = history.downloads.byDay.map((row) => ({
      day: row.day,
      count: row.cumulativeDmgDownloads,
    }));
    const points = calendarPoints(byDay, throughDay, "carry").slice(-30);
    const latest = points.at(-1)?.value ?? 0;
    const prior = points.length > 1 ? points.at(-2).value : latest;
    cards.push(growthCard({
      label: "DMG downloads",
      value: count(latest),
      delta: latest - prior,
      deltaCaption: "movement since the prior day's last sample",
      points,
      seriesLabel: `Cumulative DMG downloads since ${byDay[0].day}`,
    }));
  }
  const bandCard = growthBandCard(history.gauges.snapshots);
  if (bandCard) cards.push(bandCard);
  const cohortCard = growthPlanCohortCard(history.gauges.snapshots);
  if (cohortCard) cards.push(cohortCard);
  container.replaceChildren(...cards);
  badge.className = "admin-source-badge admin-source-available";
  badge.textContent = "History available";
}

function growthBandCard(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) return null;
  const latest = snapshots[snapshots.length - 1];
  const published = latest.metrics.bandParticipantCount;
  if (typeof published !== "number") return null;
  const dayAgoEpoch = Date.parse(latest.capturedAt) - 24 * 60 * 60 * 1_000;
  const reference = [...snapshots].reverse().find(
    (snapshot) => Date.parse(snapshot.capturedAt) <= dayAgoEpoch,
  );
  const referenceCount = reference?.metrics.bandParticipantCount;
  return growthCard({
    label: "Published band cohort",
    value: count(published),
    delta: typeof referenceCount === "number" ? published - referenceCount : 0,
    deltaCaption: typeof referenceCount === "number"
      ? `${count(referenceCount)} a day earlier`
      : "history starts after the first hourly snapshot",
    points: gaugePoints(snapshots, "bandParticipantCount"),
    seriesLabel: "Published band participant count by snapshot",
  });
}

/**
 * A dedicated per-plan card. One account legitimately spans several plan labels
 * (plan changes over time, plus records that never carried a plan stamp), so
 * each person is counted under their current plan only — never once per label.
 * Median capacity pools every fit by its own label, so a plan's window size is
 * shown even for a plan nobody is currently on. Capacity is the API-price-
 * equivalent value of one 7-day allowance window; the ratios between plans are
 * measured here, never assumed from the nominal multipliers.
 */
function growthPlanCohortCard(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) return null;
  const latest = snapshots[snapshots.length - 1].metrics;
  const plans = new Set();
  for (const key of Object.keys(latest)) {
    if (key.startsWith("cohortParticipants_")) {
      plans.add(key.slice("cohortParticipants_".length));
    }
    if (key.startsWith("cohortMedianUsd_")) {
      plans.add(key.slice("cohortMedianUsd_".length));
    }
  }
  if (plans.size === 0) return null;
  const rows = [...plans]
    .map((plan) => ({
      plan,
      people: typeof latest[`cohortParticipants_${plan}`] === "number"
        ? latest[`cohortParticipants_${plan}`]
        : 0,
      median: typeof latest[`cohortMedianUsd_${plan}`] === "number"
        ? latest[`cohortMedianUsd_${plan}`]
        : null,
    }))
    .sort((a, b) => (b.median ?? 0) - (a.median ?? 0));
  const totalPeople = rows.reduce((sum, row) => sum + row.people, 0);

  const card = document.createElement("div");
  card.className = "admin-card admin-metric admin-growth-card";
  card.append(labelWithInfo("Plan cohorts"));
  const number = document.createElement("strong");
  number.textContent = text(count(totalPeople));
  const caption = document.createElement("small");
  caption.textContent =
    `${rows.length} plan${rows.length === 1 ? "" : "s"} seen · $ = API-price-equivalent per 7-day window`;
  card.append(number, caption);

  const allCohortPoints = snapshots.flatMap((snapshot) => {
    const counts = Object.entries(snapshot.metrics)
      .filter(([key, value]) => key.startsWith("cohortParticipants_")
        && typeof value === "number")
      .map(([, value]) => value);
    return counts.length === 0
      ? []
      : [{ at: snapshot.capturedAt, value: counts.reduce((sum, value) => sum + value, 0) }];
  });
  const generatedAt = state.metricsHistory?.generatedAt
    ?? snapshots.at(-1)?.capturedAt;
  const cohortPoints = generatedAt
    ? recentTimestampPoints(allCohortPoints, generatedAt)
    : allCohortPoints;
  card.append(recentHistory(cohortPoints, "Plan cohort participants by snapshot"));

  const list = document.createElement("ul");
  list.className = "admin-plan-cohorts";
  for (const row of rows) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.className = "admin-plan-name";
    name.textContent = row.plan;
    const stat = document.createElement("span");
    stat.className = "admin-plan-stat";
    const people = `${count(row.people)} on plan`;
    stat.textContent = row.median !== null
      ? `${people} · ~$${count(row.median)}/window`
      : people;
    item.append(name, stat);
    list.append(item);
  }
  card.append(list);
  return card;
}

async function loadGrowthHistory(loadGeneration) {
  if (!isAdminPage) return;
  try {
    const history = projectAdminMetricsHistory(await request("/api/v1/admin/metrics/history"));
    if (history.schemaVersion !== GROWTH_SCHEMA_VERSION) throw new Error("unexpected metrics-history schema");
    if (!isCurrentLoadGeneration(loadGeneration, state.loadGeneration)) return;
    state.metricsHistory = history;
    renderHistoryBackedSections();
  } catch {
    if (!isCurrentLoadGeneration(loadGeneration, state.loadGeneration)) return;
    state.metricsHistory = null;
    renderHistoryBackedSections();
  }
}

function renderHistoryBackedSections() {
  renderGrowth(state.metricsHistory ?? null);
  if (!state.overview) return;
  renderCounts(state.overview);
  renderQuarantine(state.overview);
  renderDistribution(state.overview.distribution);
}

export function isCurrentLoadGeneration(requestGeneration, currentGeneration) {
  return requestGeneration === currentGeneration;
}

function renderCounts(overview) {
  const counts = overview.counts;
  const contributors = counts.contributions.contributingAccounts;
  const quarantine = overview.quarantine;
  const quarantineDue = quarantine.dueReferenced + quarantine.dueUnreferenced;
  const contributorHistory = metricGaugeEvidence(
    "contributingAccountsTotal",
    "contributingAccountsTotalBounded",
    contributors.bounded,
  );
  const pendingHistory = metricGaugeEvidence(
    "quarantinePendingObjects",
    "quarantinePendingObjectsBounded",
    quarantine.pendingObjectsBounded,
  );
  const metrics = [
    ["Approved community accounts", count(counts.participants.active, counts.participants.bounded), `${count(counts.participants.total, counts.participants.bounded)} total identities`, metricGaugePoints("participantsActive")],
    {
      label: "Accounts with accepted data",
      value: count(contributors.total, contributors.bounded),
      detail: `${count(contributors.acceptedLast30Days, contributors.bounded)} active in the last 30 days`,
      points: contributorHistory.points,
      historyUnavailable: contributorHistory.unavailable,
    },
    ["Approved last 24h", count(counts.participants.enrolledLast24Hours), `${count(counts.participants.enrolledLast7Days)} in the last 7 days`, eventHistoryPoints("participants")],
    ["Current incremental chunks", count(counts.contributions.incrementalChunks.current, counts.contributions.incrementalChunks.bounded), `${count(counts.contributions.incrementalChunks.total, counts.contributions.incrementalChunks.bounded)} journal rows`, metricGaugePoints("corpusCurrentChunks")],
    ["Accepted uploads last 24h", count(counts.contributions.acceptedLast24Hours), `${count(counts.contributions.acceptedLast7Days)} in the last 7 days`, eventHistoryPoints("acceptedUploads")],
    {
      label: "Upload safety registrations",
      value: count(quarantine.pendingObjects, quarantine.pendingObjectsBounded),
      detail: `${quarantine.withinGrace} recent · ${quarantineDue} due`,
      points: pendingHistory.points,
      historyUnavailable: pendingHistory.unavailable,
    },
  ];
  renderMetricCards("#counts", metrics);
}

function addAttentionItem(items, id, topic, level, title, detail, target, linkLabel) {
  items.push({ id, topic, level, title, detail, target, linkLabel });
}

function attentionRow({ id, topic, level, title, detail, target, linkLabel }) {
  const row = document.createElement("div");
  row.className = `admin-attention-item admin-attention-item-${level}`;
  if (id) row.setAttribute("data-alert-id", id);
  if (topic) row.setAttribute("data-alert-topic", topic);
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

function collectAttentionItems(overview) {
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
      "collection-state",
      "collection",
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
      "maintenance-failure",
      "maintenance",
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
      "storage-reconciliation-due",
      "maintenance",
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
      "rebuild-queue",
      "maintenance",
      "warning",
      `${queuedRebuilds} publication ${queuedRebuilds === 1 ? "rebuild is" : "rebuilds are"} queued`,
      `${overview.pendingHistoricalRebuilds} weekly · ${daily.pendingRebuilds} daily.`,
      "#readiness-title",
      "Review queues",
    );
  }

  const ingressUnavailable = overview.ingress === null;
  const activityEvidenceUnavailable =
    overview.distribution.cloudflare.status !== "available";
  if (ingressUnavailable || activityEvidenceUnavailable) {
    let title = "Operational evidence is incomplete";
    let detail = "Upload protection status and first-party app activity analytics could not be refreshed.";
    if (ingressUnavailable && !activityEvidenceUnavailable) {
      title = "Upload protection status is unavailable";
      detail = "The dashboard could not read the current upload admission budget.";
    } else if (!ingressUnavailable && activityEvidenceUnavailable) {
      title = "App activity evidence is unavailable";
      detail = "First-party preflight and Sparkle activity counts could not be refreshed.";
    }
    addAttentionItem(
      items,
      "evidence-availability",
      "evidence",
      "warning",
      title,
      detail,
      "#distribution-title",
      "Review evidence",
    );
  }

  const github = overview.distribution.github;
  if (github.status !== "available") {
    addAttentionItem(
      items,
      "github-availability",
      "evidence",
      "warning",
      "GitHub release evidence is unavailable",
      github.reasonCode === "GITHUB_SNAPSHOT_PENDING"
        ? "The first complete all-release snapshot has not been recorded yet."
        : `The dashboard retained no complete GitHub release snapshot (${github.reasonCode}).`,
      "#distribution-title",
      "Review distribution",
    );
  } else if (github.sync.stale || github.sync.lastFailureCode !== null) {
    addAttentionItem(
      items,
      "github-refresh",
      "evidence",
      "warning",
      "GitHub release evidence needs a refresh",
      github.sync.lastFailureCode !== null
        ? `Latest GitHub sync failed (${github.sync.lastFailureCode}); last good totals remain visible.`
        : "The last complete GitHub release snapshot is older than the normal refresh window.",
      "#distribution-title",
      "Sync releases",
    );
  }
  if (github.history.counterRegressions > 0) {
    addAttentionItem(
      items,
      "github-counter-regression",
      "evidence",
      "warning",
      `${github.history.counterRegressions} GitHub DMG ${github.history.counterRegressions === 1 ? "counter decreased" : "counters decreased"}`,
      "The affected asset may have been replaced or corrected; no negative download total is shown.",
      "#distribution-title",
      "Review releases",
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
      "sampled-server-failure",
      "failures",
      "warning",
      `${recentServerFailures.length} sampled server ${recentServerFailures.length === 1 ? "failure" : "failures"} in the last 24 hours`,
      `Latest retained event: ${formatTime(latest)}.`,
      "#errors-title",
      "Review diagnostics",
    );
  }

  return items;
}

function renderAttention(overview) {
  const items = collectAttentionItems(overview);
  const badge = $("#operator-attention-badge");
  if (items.length === 0) {
    badge.className = "admin-source-badge admin-source-available";
    badge.textContent = "No action indicated";
    $("#operator-attention").replaceChildren(attentionRow({
      level: "ok",
      title: "No current action is indicated by this snapshot",
      detail: "Collection is operational, no reconciliation or rebuild work is due, first-party activity evidence is available, and no sampled 5xx event was retained in the last 24 hours.",
      target: null,
      linkLabel: null,
    }));
    return [];
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
  return items;
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

  const historyUnavailable = metricGaugeEvidence(
    "quarantinePendingObjects",
    "quarantinePendingObjectsBounded",
    quarantine.pendingObjectsBounded,
  ).unavailable;

  renderMetricCards("#quarantine-counts", [
    {
      label: "Recent registrations",
      value: count(quarantine.withinGrace, quarantine.pendingObjectsBounded),
      detail: `normal ${quarantine.gracePeriodMinutes}-minute safety window`,
      points: metricGaugePoints("quarantineWithinGrace"),
      historyUnavailable,
    },
    {
      label: "Due and referenced",
      value: count(quarantine.dueReferenced, quarantine.pendingObjectsBounded),
      detail: "valid objects; temporary markers should clear",
      points: metricGaugePoints("quarantineDueReferenced"),
      historyUnavailable,
    },
    {
      label: "Due and unreferenced",
      value: count(quarantine.dueUnreferenced, quarantine.pendingObjectsBounded),
      detail: "orphan candidates scheduled for safe deletion",
      points: metricGaugePoints("quarantineDueUnreferenced"),
      historyUnavailable,
    },
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

function percentage(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) {
    return "—";
  }
  return `${Math.round((value / total) * 100)}%`;
}

function distributionSegmentPoints(cloudflare, key) {
  if (!Array.isArray(cloudflare.bySegment) || cloudflare.bySegment.length === 0) {
    return null;
  }
  const points = cloudflare.bySegment.flatMap((segment) => (
    typeof segment[key] === "number"
      ? [{ at: segment.endsAt, value: segment[key] }]
      : []
  ));
  return points.length > 0 ? points : null;
}

function downloadHistoryPoints({ delta = false } = {}) {
  const history = state.metricsHistory;
  if (!history?.downloads.available) return null;
  const points = history.downloads.byDay.map((row) => ({
    at: row.day,
    value: row.cumulativeDmgDownloads,
  })).slice(-30);
  if (!delta) return points;
  return points.slice(1).map((point, index) => ({
    at: point.at,
    value: Math.max(0, point.value - points[index].value),
  }));
}

function renderDistribution(distribution) {
  const cloudflare = distribution.cloudflare;
  const github = distribution.github;
  const cloudflareAvailable = cloudflare.status === "available";
  const cloudflareHistoryUnavailable = !cloudflareAvailable
    || cloudflare.sampled === true
    || cloudflare.bounded === true;
  const githubAvailable = github.status === "available";
  const badge = $("#distribution-status");
  badge.className = `admin-source-badge ${
    cloudflareAvailable && githubAvailable
      ? "admin-source-available"
      : "admin-source-partial"
  }`;
  badge.textContent = cloudflareAvailable && githubAvailable
    ? "Sources available"
    : cloudflareAvailable
      ? "Activity available · GitHub unavailable"
      : cloudflare.status === "not_configured" && github.status === "not_configured"
        ? "Setup required"
        : "Activity evidence unavailable";

  const active = cloudflare.activeSourceAddresses;
  const preflight = cloudflare.preflight;
  const checks = cloudflare.sparkleChecks;
  const downloads = cloudflare.sparkleDownloads;
  const current = cloudflare.currentVersionSourceAddresses;
  const release = github.release;
  const summary = github.summary;
  const history = github.history;
  renderMetricCards("#distribution-counts", [
    {
      label: "Active-install proxy",
      value: distributionCount(active?.last24Hours, cloudflare),
      detail: `${distributionCount(active?.last7Days, cloudflare)} distinct source addresses in 7 days`,
      points: distributionSegmentPoints(cloudflare, "activeSourceAddresses"),
      historyUnavailable: cloudflareHistoryUnavailable,
    },
    {
      label: "App preflight call-ins",
      value: distributionCount(preflight?.requests.last24Hours, cloudflare),
      detail: `${distributionCount(preflight?.sourceAddresses.last24Hours, cloudflare)} addresses · ${distributionCount(preflight?.requests.last7Days, cloudflare)} requests/7d`,
      points: distributionSegmentPoints(cloudflare, "preflightRequests"),
      historyUnavailable: cloudflareHistoryUnavailable,
    },
    {
      label: "Sparkle update checks",
      value: distributionCount(checks?.requests.last24Hours, cloudflare),
      detail: `${distributionCount(checks?.sourceAddresses.last24Hours, cloudflare)} addresses · ${distributionCount(checks?.requests.last7Days, cloudflare)} checks/7d`,
      points: distributionSegmentPoints(cloudflare, "sparkleCheckRequests"),
      historyUnavailable: cloudflareHistoryUnavailable,
    },
    {
      label: "Sparkle artifact fetches",
      value: distributionCount(downloads?.requests.last24Hours, cloudflare),
      detail: `${distributionCount(downloads?.sourceAddresses.last24Hours, cloudflare)} addresses · ${distributionCount(downloads?.requests.last7Days, cloudflare)} fetches/7d`,
      points: distributionSegmentPoints(cloudflare, "sparkleDownloadRequests"),
      historyUnavailable: cloudflareHistoryUnavailable,
    },
    {
      label: "Current-version reach",
      value: distributionCount(current?.last24Hours, cloudflare),
      detail: cloudflare.currentVersion
        ? `v${cloudflare.currentVersion} · ${distributionCount(current?.last7Days, cloudflare)} addresses/7d`
        : "current release could not be matched to traffic",
      points: distributionSegmentPoints(
        cloudflare,
        "currentVersionSourceAddresses",
      ),
      historyUnavailable: cloudflareHistoryUnavailable
        || cloudflare.currentVersion === null,
    },
    [
      "GitHub DMG downloads",
      summary ? count(summary.dmgDownloads) : "—",
      summary
        ? `${summary.releaseCount} releases · ${summary.dmgAssetCount} DMG assets · all time`
        : "unavailable from GitHub; activity counts are unaffected",
      downloadHistoryPoints(),
    ],
    [
      "GitHub DMG downloads since prior snapshot",
      history.dmgDownloadsSincePrevious === null
        ? "—"
        : count(history.dmgDownloadsSincePrevious),
      history.previousObservedAt
        ? `${formatTime(history.previousObservedAt)} → ${formatTime(history.latestObservedAt)}`
        : "available after a second complete snapshot",
      downloadHistoryPoints({ delta: true }),
    ],
  ]);

  const versions = cloudflare.observedVersions;
  const activeAddresses = active?.last7Days ?? 0;
  $("#distribution-version-rows").replaceChildren(
    ...versions.map((version) => tableRow([
      version.version,
      percentage(version.sourceAddressesLast7Days, activeAddresses),
      distributionCount(version.sourceAddressesLast7Days, cloudflare),
      distributionCount(version.requestsLast7Days, cloudflare),
    ])),
  );
  $("#distribution-version-empty").hidden = versions.length !== 0;

  const releases = github.releases;
  $("#github-release-rows").replaceChildren(
    ...releases.map((githubRelease) => tableRow([
      githubRelease.tag,
      githubRelease.prerelease ? "Prerelease" : "Stable",
      count(githubRelease.dmgDownloads),
      percentage(githubRelease.dmgDownloads, summary?.dmgDownloads ?? 0),
      formatTime(githubRelease.publishedAt),
    ])),
  );
  $("#github-release-empty").hidden = releases.length !== 0;

  $("#distribution-source-status").replaceChildren(
    statusLine(
      "Cloudflare analytics",
      cloudflare.status === "not_configured" ? "not configured" : cloudflare.status,
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
      github.status === "not_configured" ? "not configured" : github.status,
    ),
    statusLine(
      "Latest release",
      release ? `${release.tag} · ${formatTime(release.publishedAt)}` : "—",
    ),
    statusLine(
      "GitHub snapshot",
      history.latestObservedAt ? formatTime(history.latestObservedAt) : "—",
    ),
    statusLine(
      "GitHub sync",
      github.sync.lastFailureCode
        ? `failed · ${github.sync.lastFailureCode}`
        : github.sync.stale
          ? "stale"
          : github.sync.lastSuccessAt
            ? `healthy · ${formatTime(github.sync.lastSuccessAt)}`
            : "pending",
    ),
    statusLine("Counter regressions", text(history.counterRegressions)),
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
  line.className = "admin-status-line";
  const name = document.createElement("strong");
  name.append(labelWithInfo(label), document.createTextNode(": "));
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
    group.status,
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
  const summary = $("#diagnostic-retention-summary");
  if (summary) {
    summary.textContent = `${errors.sampled ? "A bounded sample" : "Retained events"} of service 5xx failures is kept for ${errors.retentionDays} days, capped at ${count(errors.capacity)} events. Retained service request IDs are UUIDs; TT-… references stay only in the reporting Mac’s local diagnostics log.`;
  }
  renderDiagnosticLookup();
}

function renderDiagnosticLookup() {
  const lookup = $("#diagnostic-lookup");
  const result = state.diagnosticLookup;
  if (result?.event) {
    lookup.textContent = `${result.event.requestId}: HTTP ${result.event.status} · ${result.event.errorCode} on ${result.event.routeClass} at ${formatTime(result.event.occurredAt)}`;
    lookup.hidden = false;
  } else if (result?.message) {
    lookup.textContent = result.message;
    lookup.hidden = false;
  } else {
    lookup.hidden = true;
  }
}

async function lookupDiagnosticReference() {
  const lookupGeneration = ++state.diagnosticLookupGeneration;
  const reference = $("#diagnostic-reference").value.trim();
  const kind = diagnosticReferenceKind(reference);
  if (kind === "local") {
    state.diagnosticLookup = {
      message: "TT-… references are local to the reporting Mac and are not uploaded here. Ask for the local diagnostics log or export from that Mac.",
    };
    renderDiagnosticLookup();
    return;
  }
  if (kind === "invalid-local") {
    state.diagnosticLookup = {
      message: "That TT reference is incomplete or malformed. A local reference looks like TT-7QF3K2 and can be checked only in the reporting Mac’s diagnostics log.",
    };
    renderDiagnosticLookup();
    return;
  }
  if (kind !== "retained") {
    state.diagnosticLookup = {
      message: "Enter the UUID service request ID shown with the 5xx response (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx).",
    };
    renderDiagnosticLookup();
    return;
  }
  state.diagnosticLookup = { message: "Looking up that exact retained service request ID…" };
  renderDiagnosticLookup();
  try {
    const overview = projectAdminOverview(await request(
      `/api/v1/admin/overview?diagnosticReference=${encodeURIComponent(reference)}`,
    ));
    if (!isCurrentLoadGeneration(
      lookupGeneration,
      state.diagnosticLookupGeneration,
    )) return;
    state.diagnosticLookup = overview.errors.lookup
      ? { event: overview.errors.lookup }
      : { message: `No retained sampled service failure matched ${reference}.` };
  } catch (error) {
    if (!isCurrentLoadGeneration(
      lookupGeneration,
      state.diagnosticLookupGeneration,
    )) return;
    state.diagnosticLookup = { message: `Lookup unavailable: ${error.message}.` };
  }
  renderDiagnosticLookup();
}

export function diagnosticReferenceKind(reference) {
  const normalized = typeof reference === "string" ? reference.trim() : "";
  if (LOCAL_DIAGNOSTIC_REFERENCE.test(normalized)) return "local";
  if (/^TT-/iu.test(normalized)) return "invalid-local";
  return RETAINED_SERVICE_REQUEST_ID.test(normalized) ? "retained" : "invalid";
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

export function auditPageWindow(rows, page, pageSize = AUDIT_PAGE_SIZE) {
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.max(0, Math.min(pageCount - 1, page));
  const start = safePage * pageSize;
  return Object.freeze({
    page: safePage,
    pageCount,
    start,
    end: Math.min(rows.length, start + pageSize),
    rows: rows.slice(start, start + pageSize),
  });
}

function auditRowsSignature(rows) {
  return rows.map((row) => (
    `${row.createdAt}:${row.action}:${row.outcome}:${JSON.stringify(row.details)}`
  )).join("|");
}

export function nextAuditPaginationState(previous, rows) {
  const signature = auditRowsSignature(rows);
  return Object.freeze({
    signature,
    page: previous.signature !== null && previous.signature !== signature
      ? 0
      : previous.page,
  });
}

function renderAuditPage() {
  const window = auditPageWindow(state.auditRows, state.auditPage);
  state.auditPage = window.page;
  $("#audit-rows").replaceChildren(...window.rows.map(auditRow));
  $("#audit-empty").hidden = state.auditRows.length !== 0;
  const pagination = $("#audit-pagination");
  if (!pagination) return;
  pagination.hidden = state.auditRows.length <= AUDIT_PAGE_SIZE;
  $("#audit-previous").disabled = window.page === 0;
  $("#audit-next").disabled = window.page >= window.pageCount - 1;
  $("#audit-page-status").textContent = state.auditRows.length === 0
    ? "No recent actions"
    : `Showing ${window.start + 1}–${window.end} of ${
      state.auditRows.length === AUDIT_RESULT_LIMIT
        ? `the latest ${AUDIT_RESULT_LIMIT}`
        : state.auditRows.length
    } recent actions`;
}

function renderAudit(rows) {
  const next = nextAuditPaginationState({
    signature: state.auditSignature,
    page: state.auditPage,
  }, rows);
  state.auditPage = next.page;
  state.auditSignature = next.signature;
  state.auditRows = rows;
  renderAuditPage();
}

function storageRead(key, fallback) {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function storageWrite(key, value) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or restrictive browser settings should never break the
    // owner dashboard. The preference simply remains session-local.
  }
}

function selectedAutoRefreshMinutes() {
  const saved = Number(storageRead(AUTO_REFRESH_STORAGE_KEY, DEFAULT_AUTO_REFRESH_MINUTES));
  return AUTO_REFRESH_OPTIONS.has(saved) ? saved : DEFAULT_AUTO_REFRESH_MINUTES;
}

function notificationDefaults() {
  return {
    enabled: false,
    repeatMinutes: 0,
    topics: [...NOTIFICATION_TOPIC_IDS],
    lastFingerprint: null,
    lastSentAt: null,
  };
}

export function projectNotificationPreferences(saved) {
  const repeatMinutes = Number(saved?.repeatMinutes);
  const topics = Array.isArray(saved?.topics)
    ? NOTIFICATION_TOPIC_IDS.filter((topic) => saved.topics.includes(topic))
    : [...NOTIFICATION_TOPIC_IDS];
  return {
    enabled: saved?.enabled === true,
    repeatMinutes: NOTIFICATION_REPEAT_OPTIONS.has(repeatMinutes)
      ? repeatMinutes
      : 0,
    topics,
    lastFingerprint: typeof saved?.lastFingerprint === "string"
      ? saved.lastFingerprint
      : null,
    lastSentAt: Number.isFinite(saved?.lastSentAt) ? saved.lastSentAt : null,
  };
}

export function resetNotificationRecurrence(preferences, changes = {}) {
  return {
    ...preferences,
    ...changes,
    lastFingerprint: null,
    lastSentAt: null,
  };
}

export function notificationPermissionStatus({
  supported,
  permission,
  enabled,
  topicCount,
  repeatMinutes,
}) {
  if (!supported) {
    return "Native notifications are unavailable in this browser. The on-page attention list still works.";
  }
  if (permission === "denied") {
    return "Blocked for this site. Allow notifications in your browser site settings, then return to this tab.";
  }
  if (enabled && topicCount === 0) return "On, but no alert topics are selected.";
  if (enabled && repeatMinutes === 0) {
    return `On for ${topicCount} selected topics · once per changed state.`;
  }
  if (enabled) return `Enabled: unresolved alerts repeat every ${repeatMinutes} minutes.`;
  return "Off.";
}

function readNotificationPreferences() {
  const current = storageRead(NOTIFICATION_STORAGE_KEY, null);
  const legacy = current === null
    ? storageRead(LEGACY_NOTIFICATION_STORAGE_KEY, notificationDefaults())
    : null;
  const saved = current ?? legacy;
  const projected = projectNotificationPreferences(saved);
  if (current === null) storageWrite(NOTIFICATION_STORAGE_KEY, projected);
  return projected;
}

function saveNotificationPreferences(preferences) {
  state.notificationPreferences = preferences;
  storageWrite(NOTIFICATION_STORAGE_KEY, preferences);
}

function notificationApi() {
  return typeof globalThis.Notification === "function"
    ? globalThis.Notification
    : null;
}

function setNotificationStatus(message) {
  const node = $("#notification-status");
  if (node) node.textContent = message;
}

function updateNotificationControls() {
  if (!isAdminPage) return;
  const preferences = state.notificationPreferences ?? readNotificationPreferences();
  state.notificationPreferences = preferences;
  const enabled = $("#browser-notifications");
  const repeat = $("#notification-repeat-minutes");
  const test = $("#notification-test");
  const api = notificationApi();
  for (const topic of document.querySelectorAll?.('input[name="notification-topic"]') ?? []) {
    topic.checked = preferences.topics.includes(topic.value);
  }
  if (!api) {
    enabled.checked = false;
    enabled.disabled = true;
    repeat.disabled = true;
    test.disabled = true;
    setNotificationStatus(notificationPermissionStatus({ supported: false }));
    return;
  }
  enabled.checked = preferences.enabled && api.permission === "granted";
  enabled.disabled = api.permission === "denied";
  repeat.value = String(preferences.repeatMinutes);
  const hasTopics = preferences.topics.length > 0;
  repeat.disabled = !enabled.checked || !hasTopics;
  test.disabled = !enabled.checked || !hasTopics;
  setNotificationStatus(notificationPermissionStatus({
    supported: true,
    permission: api.permission,
    enabled: enabled.checked,
    topicCount: preferences.topics.length,
    repeatMinutes: preferences.repeatMinutes,
  }));
}

function notificationFingerprint(items) {
  return items
    .filter((item) => item.level !== "ok")
    .map((item) => `${item.id}:${item.topic}:${item.level}:${item.title}:${item.detail}`)
    .sort()
    .join("|");
}

export function selectedNotificationAlerts(items, topics) {
  const selectedTopics = new Set(topics);
  return items.filter((item) => item.level !== "ok" && selectedTopics.has(item.topic));
}

export function notificationPreferencesAfterResolution(preferences, alerts) {
  if (alerts.length !== 0
      || (preferences.lastFingerprint === null && preferences.lastSentAt === null)) {
    return preferences;
  }
  return resetNotificationRecurrence(preferences);
}

function notifyAttention(items) {
  if (!isAdminPage) return;
  const allAlerts = items.filter((item) => item.level !== "ok");
  document.title = allAlerts.length > 0 ? `• ${ADMIN_TITLE}` : ADMIN_TITLE;
  const preferences = state.notificationPreferences ?? readNotificationPreferences();
  const alerts = selectedNotificationAlerts(allAlerts, preferences.topics);
  if (alerts.length === 0) {
    const resolved = notificationPreferencesAfterResolution(preferences, alerts);
    if (resolved !== preferences) saveNotificationPreferences(resolved);
    return;
  }
  if (!preferences.enabled) return;
  const api = notificationApi();
  if (!api || api.permission !== "granted") return;
  const fingerprint = notificationFingerprint(alerts);
  const now = Date.now();
  const repeatAfter = preferences.repeatMinutes * 60 * 1_000;
  const shouldRepeat = preferences.lastFingerprint === fingerprint
    && repeatAfter > 0
    && preferences.lastSentAt !== null
    && now - preferences.lastSentAt >= repeatAfter;
  if (preferences.lastFingerprint === fingerprint && !shouldRepeat) return;
  const titles = alerts.slice(0, 2).map((item) => item.title);
  try {
    new api(
      alerts.some((item) => item.level === "alert")
        ? "TiboTattle admin: action required"
        : "TiboTattle admin: attention needed",
      {
        body: titles.join(" · "),
        tag: "tibotattle-admin-attention",
        renotify: shouldRepeat,
      },
    );
    saveNotificationPreferences({
      ...preferences,
      lastFingerprint: fingerprint,
      lastSentAt: now,
    });
  } catch {
    setNotificationStatus("The browser could not show the configured alert.");
  }
}

function refreshStatusText() {
  if (!isAdminPage) return;
  const node = $("#auto-refresh-status");
  if (!node) return;
  const minutes = Number($("#auto-refresh-minutes").value);
  if (minutes === 0) {
    node.textContent = "Automatic refresh is off.";
    return;
  }
  if (navigator.onLine === false) {
    node.textContent = "Paused while offline.";
    return;
  }
  if (document.visibilityState === "hidden") {
    node.textContent = "Paused while this tab is hidden.";
    return;
  }
  if (state.loading) {
    node.textContent = "Refreshing…";
    return;
  }
  if (state.nextRefreshAt === null) {
    node.textContent = `Every ${minutes} minute${minutes === 1 ? "" : "s"}.`;
    return;
  }
  const seconds = Math.max(0, Math.ceil((state.nextRefreshAt - Date.now()) / 1_000));
  const minutesRemaining = Math.floor(seconds / 60);
  const secondsRemaining = seconds % 60;
  node.textContent = `Next refresh in ${minutesRemaining}:${String(secondsRemaining).padStart(2, "0")}.`;
}

function clearRefreshSchedule() {
  if (state.refreshTimer !== null) clearTimeout(state.refreshTimer);
  state.refreshTimer = null;
  state.nextRefreshAt = null;
}

function scheduleRefresh({ retry = false } = {}) {
  if (!isAdminPage) return;
  clearRefreshSchedule();
  const minutes = Number($("#auto-refresh-minutes").value);
  if (!AUTO_REFRESH_OPTIONS.has(minutes) || minutes === 0) {
    refreshStatusText();
    return;
  }
  if (navigator.onLine === false || document.visibilityState === "hidden") {
    refreshStatusText();
    return;
  }
  const interval = retry
    ? Math.min(state.retryDelayMilliseconds, minutes * 60 * 1_000)
    : minutes * 60 * 1_000;
  state.nextRefreshAt = Date.now() + interval;
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null;
    state.nextRefreshAt = null;
    if (document.visibilityState === "hidden" || navigator.onLine === false) {
      refreshStatusText();
      return;
    }
    void load({ automatic: true });
  }, interval);
  refreshStatusText();
}

const ADMIN_ALLOWANCE_DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const ADMIN_ALLOWANCE_CHART_WIDTH = 960;
const ADMIN_ALLOWANCE_CHART_HEIGHT = 300;
const ADMIN_ALLOWANCE_PLAN_STYLES = Object.freeze({
  pro: Object.freeze({ label: "Pro 20x", className: "pro" }),
  prolite: Object.freeze({ label: "Pro 5x → 20x", className: "prolite" }),
  plus: Object.freeze({ label: "Plus → 20x", className: "plus" }),
});

function adminAllowanceTickStep(span, target = 4) {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const raw = span / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const factor = normalized <= 1 ? 1
    : normalized <= 2 ? 2
      : normalized <= 2.5 ? 2.5
        : normalized <= 5 ? 5
          : 10;
  return factor * magnitude;
}

function adminAllowanceSegments(points) {
  const segments = [];
  let segment = [];
  for (const point of points) {
    const prior = segment[segment.length - 1];
    if (prior && Math.round(
      (Date.parse(`${point.day}T00:00:00.000Z`)
        - Date.parse(`${prior.day}T00:00:00.000Z`))
        / ADMIN_ALLOWANCE_DAY_MILLISECONDS,
    ) > 1) {
      segments.push(segment);
      segment = [];
    }
    segment.push(point);
  }
  if (segment.length > 0) segments.push(segment);
  return segments;
}

/**
 * Pure geometry for the admin-only merge preview. Every line shares the same
 * UTC date and Pro-20x-equivalent dollar axes, so switching views changes the
 * evidence shown rather than the meaning of the scale.
 */
export function adminAllowanceChartModel(preview, {
  mode = "combined",
  rangeDays = 30,
  width = ADMIN_ALLOWANCE_CHART_WIDTH,
  height = ADMIN_ALLOWANCE_CHART_HEIGHT,
} = {}) {
  if (!preview || !Array.isArray(preview.days) || preview.days.length === 0
      || (mode !== "combined" && mode !== "plans")) {
    return null;
  }
  const anchor = preview.days.at(-1).day;
  const cutoffMs = rangeDays === null
    ? Number.NEGATIVE_INFINITY
    : Date.parse(`${anchor}T00:00:00.000Z`)
      - (rangeDays - 1) * ADMIN_ALLOWANCE_DAY_MILLISECONDS;
  const days = preview.days.filter((day) => (
    Date.parse(`${day.day}T00:00:00.000Z`) >= cutoffMs
  ));
  if (days.length === 0) return null;
  const series = mode === "combined"
    ? [{ key: "combined", label: "Combined", className: "combined" }]
    : preview.plans.map((plan) => ({
      key: plan.planType,
      ...ADMIN_ALLOWANCE_PLAN_STYLES[plan.planType],
    }));
  const summaryFor = (day, key) => (
    key === "combined" ? day.combined : day.byPlanType[key]
  );
  let visibleValueCount = 0;
  const valueCandidates = [];
  for (const day of days) {
    for (const definition of series) {
      const summary = summaryFor(day, definition.key);
      if (summary?.centralUsd !== null && summary?.centralUsd !== undefined) {
        visibleValueCount += 1;
      }
    }
    // Keep the numerical y-axis fixed while the operator switches between
    // Combined and By plan. Otherwise the same vertical movement could appear
    // larger merely because a different series changed the automatic scale.
    if (day.combined.centralUsd !== null) {
      valueCandidates.push(day.combined.centralUsd);
      if (day.combined.band80Usd !== null) {
        valueCandidates.push(day.combined.band80Usd.upperUsd);
      }
    }
    for (const plan of preview.plans) {
      const central = day.byPlanType[plan.planType]?.centralUsd;
      if (central !== null && central !== undefined) valueCandidates.push(central);
    }
  }
  if (visibleValueCount === 0 || valueCandidates.length === 0) return null;
  const margin = { top: 16, right: 24, bottom: 34, left: 64 };
  const plot = {
    top: margin.top,
    right: width - margin.right,
    bottom: height - margin.bottom,
    left: margin.left,
  };
  const startMs = Date.parse(`${days[0].day}T00:00:00.000Z`);
  const endMs = Date.parse(`${days.at(-1).day}T00:00:00.000Z`);
  const x = (day) => {
    const atMs = Date.parse(`${day}T00:00:00.000Z`);
    return startMs === endMs
      ? plot.left + (plot.right - plot.left) / 2
      : plot.left + ((atMs - startMs) / (endMs - startMs))
        * (plot.right - plot.left);
  };
  const step = adminAllowanceTickStep(Math.max(...valueCandidates));
  const axisTop = Math.ceil(Math.max(...valueCandidates) / step) * step;
  const y = (value) => plot.bottom
    - (value / axisTop) * (plot.bottom - plot.top);
  const dollarTicks = [];
  for (let value = 0; value <= axisTop + step / 100; value += step) {
    dollarTicks.push({ value, y: y(value) });
  }
  const modeledSeries = series.map((definition) => {
    const points = days.flatMap((day) => {
      const summary = summaryFor(day, definition.key);
      if (!summary || summary.centralUsd === null) return [];
      return [{
        day: day.day,
        value: summary.centralUsd,
        fitCount: summary.fitCount,
        participantCount: summary.participantCount,
        x: x(day.day),
        y: y(summary.centralUsd),
      }];
    });
    return {
      ...definition,
      points,
      segments: adminAllowanceSegments(points),
      latest: points.at(-1) ?? null,
    };
  });
  const bandPoints = mode === "combined" ? days.flatMap((day) => {
    const band = day.combined.band80Usd;
    return band === null ? [] : [{
      day: day.day,
      x: x(day.day),
      upperY: y(band.upperUsd),
      lowerY: y(band.lowerUsd),
    }];
  }) : [];
  const bandSegments = adminAllowanceSegments(bandPoints);
  const maximumTicks = 6;
  const dayTicks = Array.from({ length: maximumTicks }, (_, index) => {
    const atMs = startMs + Math.round(
      ((endMs - startMs) * index) / (maximumTicks - 1)
      / ADMIN_ALLOWANCE_DAY_MILLISECONDS,
    ) * ADMIN_ALLOWANCE_DAY_MILLISECONDS;
    const day = new Date(atMs).toISOString().slice(0, 10);
    return { day, x: x(day) };
  }).filter((tick, index, ticks) => index === 0 || tick.day !== ticks[index - 1].day);
  return {
    width,
    height,
    plot,
    dollarTicks,
    dayTicks,
    tickLabelStyle: days.length > 45 ? "month" : "day",
    series: modeledSeries,
    bandSegments,
  };
}

function adminAllowanceSvg(tag, className = "", attributes = {}) {
  const element = document.createElementNS(SVG_NAMESPACE, tag);
  if (className) element.setAttribute("class", className);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
  return element;
}

function latestAllowanceSummary(preview, key) {
  for (const day of [...preview.days].reverse()) {
    const summary = key === "combined" ? day.combined : day.byPlanType[key];
    if (summary.centralUsd !== null) return { day: day.day, summary };
  }
  return null;
}

function allowanceUsd(value) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function appendAdminAllowanceLegend(figure, model) {
  const legend = document.createElement("p");
  legend.className = "admin-allowance-legend";
  for (const series of model.series) {
    const item = document.createElement("span");
    const swatch = document.createElement("span");
    swatch.className = `admin-allowance-swatch admin-allowance-swatch-${series.className}`;
    swatch.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = series.label;
    item.append(swatch, label);
    legend.append(item);
  }
  if (model.bandSegments.length > 0) {
    const item = document.createElement("span");
    const swatch = document.createElement("span");
    swatch.className = "admin-allowance-swatch admin-allowance-swatch-band";
    swatch.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = "Middle 80% of fitted windows";
    item.append(swatch, label);
    legend.append(item);
  }
  figure.append(legend);
}

function appendAdminAllowanceChart(container, preview) {
  const model = adminAllowanceChartModel(preview, {
    mode: state.allowanceMode,
    rangeDays: state.allowanceRangeDays,
  });
  if (model === null) {
    const empty = document.createElement("p");
    empty.className = "admin-allowance-empty";
    empty.textContent = "No qualifying fits in this range.";
    container.append(empty);
    return;
  }
  const figure = document.createElement("div");
  figure.className = "community-daily-chart community-allowance-chart";
  appendAdminAllowanceLegend(figure, model);
  const svg = adminAllowanceSvg("svg", "", {
    viewBox: `0 0 ${model.width} ${model.height}`,
    role: "img",
    "aria-label": state.allowanceMode === "combined"
      ? "Combined Pro 20x-equivalent community allowance by day"
      : "Pro 20x-equivalent community allowance by plan and day",
  });
  for (const tick of model.dollarTicks) {
    svg.append(adminAllowanceSvg("line", "chart-grid", {
      x1: model.plot.left,
      x2: model.plot.right,
      y1: tick.y,
      y2: tick.y,
    }));
    const label = adminAllowanceSvg("text", "chart-axis-label", {
      x: model.plot.left - 8,
      y: tick.y + 3,
      "text-anchor": "end",
    });
    label.textContent = allowanceUsd(tick.value);
    svg.append(label);
  }
  const tickFormatter = new Intl.DateTimeFormat(undefined, model.tickLabelStyle === "month"
    ? { timeZone: "UTC", month: "short", year: "numeric" }
    : { timeZone: "UTC", month: "short", day: "numeric" });
  for (const tick of model.dayTicks) {
    const label = adminAllowanceSvg("text", "chart-axis-label", {
      x: tick.x,
      y: model.height - 10,
      "text-anchor": "middle",
    });
    label.textContent = tickFormatter.format(new Date(`${tick.day}T00:00:00.000Z`));
    svg.append(label);
  }
  for (const band of model.bandSegments) {
    if (band.length >= 2) {
      const forward = band.map((point) => (
        `${point.x.toFixed(1)},${point.upperY.toFixed(1)}`
      ));
      const backward = [...band].reverse().map((point) => (
        `${point.x.toFixed(1)},${point.lowerY.toFixed(1)}`
      ));
      svg.append(adminAllowanceSvg("path", "admin-allowance-band-area", {
        d: `M${[...forward, ...backward].join(" L")} Z`,
      }));
    } else {
      svg.append(adminAllowanceSvg("line", "admin-allowance-band-mark", {
        x1: band[0].x,
        x2: band[0].x,
        y1: band[0].upperY,
        y2: band[0].lowerY,
      }));
    }
  }
  for (const series of model.series) {
    for (const segment of series.segments) {
      if (segment.length >= 2) {
        svg.append(adminAllowanceSvg(
          "polyline",
          `admin-allowance-line admin-allowance-line-${series.className}`,
          { points: segment.map((point) => (
            `${point.x.toFixed(1)},${point.y.toFixed(1)}`
          )).join(" ") },
        ));
      }
    }
    for (const point of series.points) {
      const dot = adminAllowanceSvg(
        "circle",
        `admin-allowance-dot admin-allowance-dot-${series.className}`,
        {
          cx: point.x,
          cy: point.y,
          r: Math.min(6, 2.4 + Math.sqrt(point.fitCount)),
          tabindex: 0,
          "aria-label": `${series.label}, ${point.day}: ${allowanceUsd(point.value)}, ${point.participantCount} accounts, ${point.fitCount} fits`,
        },
      );
      const title = adminAllowanceSvg("title");
      title.textContent = `${series.label} · ${point.day} · ${allowanceUsd(point.value)} · ${point.participantCount} accounts · ${point.fitCount} fits`;
      dot.append(title);
      svg.append(dot);
    }
  }
  figure.append(svg);
  container.append(figure);
}

function appendCombinedAllowanceSummary(container, preview) {
  const latest = latestAllowanceSummary(preview, "combined");
  if (latest === null) return;
  const summary = document.createElement("div");
  summary.className = "admin-allowance-summary";
  const value = document.createElement("p");
  value.className = "admin-allowance-value";
  value.textContent = allowanceUsd(latest.summary.centralUsd);
  const unit = document.createElement("span");
  unit.className = "admin-allowance-unit";
  unit.textContent = "per 7 days, Pro 20x equivalent";
  const meta = document.createElement("p");
  meta.className = "admin-allowance-meta";
  const evidence = document.createElement("span");
  const accounts = document.createElement("strong");
  accounts.textContent = String(latest.summary.participantCount);
  const fits = document.createElement("strong");
  fits.textContent = String(latest.summary.fitCount);
  evidence.append(
    accounts,
    document.createTextNode(" accounts · "),
    fits,
    document.createTextNode(" fits"),
  );
  const date = document.createElement("span");
  date.textContent = latest.day;
  meta.append(evidence, date);
  if (latest.summary.band80Usd !== null) {
    const range = document.createElement("span");
    range.textContent = `${allowanceUsd(latest.summary.band80Usd.lowerUsd)}–${allowanceUsd(latest.summary.band80Usd.upperUsd)} range`;
    meta.append(range);
  }
  summary.append(value, unit, meta);
  container.append(summary);
}

function appendPlanAllowanceSummaries(container, preview) {
  const list = document.createElement("div");
  list.className = "admin-allowance-plan-summaries";
  for (const plan of preview.plans) {
    const latest = latestAllowanceSummary(preview, plan.planType);
    const style = ADMIN_ALLOWANCE_PLAN_STYLES[plan.planType];
    const item = document.createElement("div");
    item.className = "admin-allowance-plan-summary";
    const label = document.createElement("span");
    label.textContent = style.label;
    const value = document.createElement("strong");
    value.textContent = latest === null ? "—" : allowanceUsd(latest.summary.centralUsd);
    const meta = document.createElement("small");
    meta.textContent = latest === null
      ? "No qualifying fits"
      : `${latest.summary.participantCount} accounts · ${latest.summary.fitCount} fits`;
    item.append(label, value, meta);
    list.append(item);
  }
  container.append(list);
}

function appendAllowanceCoverage(container, coverage) {
  const panel = document.createElement("div");
  panel.className = "admin-allowance-coverage";
  if (coverage === null) {
    panel.textContent = "Coverage summary is not available in this cached preview.";
    container.append(panel);
    return;
  }
  const funnel = document.createElement("p");
  funnel.className = "admin-allowance-coverage-funnel";
  funnel.textContent = `${count(coverage.uploadingParticipantCount)} uploading · ${count(coverage.cachedParticipantCount)} cached · ${count(coverage.recentFittedParticipantCount)} recent fitted · ${count(coverage.mergeEligibleParticipantCount)} merged`;
  const reasons = [
    [coverage.noQualifyingFitParticipantCount, "no qualifying fit yet"],
    [coverage.noRecentFitParticipantCount, "no recent fit"],
    [coverage.unsupportedPlanParticipantCount, "unknown or unsupported plan"],
  ].filter(([value]) => value > 0);
  const detail = document.createElement("p");
  detail.className = "admin-allowance-coverage-gaps";
  detail.textContent = reasons.length > 0
    ? reasons.map(([value, label]) => `${count(value)} ${label}`).join(" · ")
    : "Every uploading account contributes to the merged estimate.";
  panel.append(funnel, detail);
  container.append(panel);
}

function renderAdminAllowanceControls() {
  const modeControls = $("#admin-community-mode-controls");
  for (const button of modeControls?.querySelectorAll("button[data-allowance-mode]") ?? []) {
    const selected = button.dataset.allowanceMode === state.allowanceMode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  const rangeControls = $("#admin-community-range-controls");
  for (const button of rangeControls?.querySelectorAll("button[data-range-days]") ?? []) {
    const selected = button.dataset.rangeDays === "all"
      ? state.allowanceRangeDays === null
      : Number(button.dataset.rangeDays) === state.allowanceRangeDays;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}

function renderAdminCommunityAllowance(preview) {
  if (!isAdminPage) return;
  const container = $("#admin-community-allowance-result");
  const badge = $("#admin-community-status");
  if (!container || !badge) return;
  container.replaceChildren();
  if (preview === null) {
    badge.className = "admin-source-badge admin-source-partial";
    badge.textContent = "Preview unavailable";
    const empty = document.createElement("p");
    empty.className = "admin-allowance-empty";
    empty.textContent = "The allowance preview could not be loaded.";
    container.append(empty);
    renderAdminAllowanceControls();
    return;
  }
  badge.className = "admin-source-badge admin-source-available";
  badge.textContent = "Admin preview available";
  if (state.allowanceMode === "combined") {
    appendCombinedAllowanceSummary(container, preview);
  } else {
    appendPlanAllowanceSummaries(container, preview);
  }
  appendAllowanceCoverage(container, preview.coverage);
  appendAdminAllowanceChart(container, preview);
  renderAdminAllowanceControls();
}

async function loadAdminCommunityAllowance(loadGeneration) {
  if (!isAdminPage) return;
  let preview;
  try {
    preview = projectAdminAllowancePreview(await request(
      "/api/v1/admin/community/allowance-preview",
    ));
  } catch {
    preview = null;
  }
  if (!isCurrentLoadGeneration(loadGeneration, state.loadGeneration)) return;
  state.allowancePreview = preview;
  renderAdminCommunityAllowance(state.allowancePreview);
}

function render(overview) {
  state.overview = overview;
  const attention = renderAttention(overview);
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
  notifyAttention(attention);
}

async function load() {
  if (state.loading) return;
  const loadGeneration = ++state.loadGeneration;
  state.loading = true;
  let succeeded = false;
  $("#refresh").disabled = true;
  refreshStatusText();
  try {
    // No app session on the admin host: authentication is Cloudflare Access and
    // the owner-email pin, and CSRF is the always-sent x-usage-monitor-admin
    // header. The old /api/v1/session pre-fetch 401'd here and was the dead
    // console symptom.
    const overview = projectAdminOverview(await request("/api/v1/admin/overview"));
    state.metricsHistory = undefined;
    render(overview);
    $("#notice").hidden = true;
    state.lastSuccessfulLoadAt = Date.now();
    state.retryDelayMilliseconds = 30_000;
    succeeded = true;
    void loadAdminCommunityAllowance(loadGeneration);
    void loadGrowthHistory(loadGeneration);
  } catch (error) {
    showNotice(`Operations view unavailable: ${error.message}.`);
    state.retryDelayMilliseconds = Math.min(
      state.retryDelayMilliseconds * 2,
      5 * 60 * 1_000,
    );
  } finally {
    state.loading = false;
    $("#refresh").disabled = false;
    if (isAdminPage) scheduleRefresh({ retry: !succeeded });
  }
}

$("#refresh").addEventListener("click", () => load());
$("#diagnostic-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void lookupDiagnosticReference();
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

if (isAdminPage) {
  $("#audit-previous").addEventListener("click", () => {
    state.auditPage -= 1;
    renderAuditPage();
  });
  $("#audit-next").addEventListener("click", () => {
    state.auditPage += 1;
    renderAuditPage();
  });
  const autoRefresh = $("#auto-refresh-minutes");
  autoRefresh.value = String(selectedAutoRefreshMinutes());
  autoRefresh.addEventListener("change", () => {
    const minutes = Number(autoRefresh.value);
    const safeMinutes = AUTO_REFRESH_OPTIONS.has(minutes)
      ? minutes
      : DEFAULT_AUTO_REFRESH_MINUTES;
    autoRefresh.value = String(safeMinutes);
    storageWrite(AUTO_REFRESH_STORAGE_KEY, safeMinutes);
    scheduleRefresh();
  });
  state.refreshStatusTimer = setInterval(refreshStatusText, 1_000);

  state.notificationPreferences = readNotificationPreferences();
  updateNotificationControls();
  $("#browser-notifications").addEventListener("change", async (event) => {
    const control = event.currentTarget;
    const preferences = state.notificationPreferences ?? readNotificationPreferences();
    const api = notificationApi();
    if (!control.checked) {
      saveNotificationPreferences(resetNotificationRecurrence(preferences, {
        enabled: false,
      }));
      updateNotificationControls();
      return;
    }
    if (!api) {
      control.checked = false;
      setNotificationStatus("Native notifications are unavailable in this browser.");
      return;
    }
    const permission = api.permission === "default"
      ? await api.requestPermission()
      : api.permission;
    if (permission !== "granted") {
      control.checked = false;
      saveNotificationPreferences({ ...preferences, enabled: false });
      updateNotificationControls();
      return;
    }
    saveNotificationPreferences(resetNotificationRecurrence(preferences, {
      enabled: true,
    }));
    updateNotificationControls();
    if (state.overview) notifyAttention(collectAttentionItems(state.overview));
  });
  $("#notification-repeat-minutes").addEventListener("change", (event) => {
    const repeatMinutes = Number(event.currentTarget.value);
    const preferences = state.notificationPreferences ?? readNotificationPreferences();
    saveNotificationPreferences(resetNotificationRecurrence(preferences, {
      repeatMinutes: NOTIFICATION_REPEAT_OPTIONS.has(repeatMinutes)
        ? repeatMinutes
        : 0,
    }));
    updateNotificationControls();
  });
  for (const topic of document.querySelectorAll('input[name="notification-topic"]')) {
    topic.addEventListener("change", () => {
      const preferences = state.notificationPreferences ?? readNotificationPreferences();
      const topics = [...document.querySelectorAll('input[name="notification-topic"]')]
        .filter((input) => input.checked)
        .map((input) => input.value)
        .filter((value) => NOTIFICATION_TOPIC_IDS.includes(value));
      saveNotificationPreferences(resetNotificationRecurrence(preferences, {
        topics,
      }));
      updateNotificationControls();
    });
  }
  $("#notification-test").addEventListener("click", () => {
    const api = notificationApi();
    if (!api || api.permission !== "granted") {
      setNotificationStatus("Enable browser alerts before sending a test.");
      return;
    }
    try {
      const preferences = state.notificationPreferences ?? readNotificationPreferences();
      const labels = preferences.topics.map((topic) => NOTIFICATION_TOPICS[topic]);
      new api("TiboTattle admin notification test", {
        body: `Test only — no incident detected. Selected topics: ${labels.join(", ")}.`,
        tag: "tibotattle-admin-test",
        renotify: true,
      });
      setNotificationStatus("Test notification requested. Delivery is controlled by your browser and operating system.");
    } catch {
      setNotificationStatus("The browser could not show a test alert.");
    }
  });
  window.addEventListener("focus", updateNotificationControls);
  $("#admin-community-mode-controls").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-allowance-mode]");
    if (!button) return;
    state.allowanceMode = button.dataset.allowanceMode;
    renderAdminCommunityAllowance(state.allowancePreview);
  });
  $("#admin-community-range-controls").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-range-days]");
    if (!button) return;
    state.allowanceRangeDays = button.dataset.rangeDays === "all"
      ? null
      : Number(button.dataset.rangeDays);
    renderAdminCommunityAllowance(state.allowancePreview);
  });
  $("#sync-distribution").addEventListener("click", async () => {
    const button = $("#sync-distribution");
    button.disabled = true;
    try {
      const result = projectAdminAction(await request("/api/v1/admin/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "sync_distribution" }),
      }), "sync_distribution");
      showNotice(
        result.result.code === "GITHUB_SYNCED"
          ? "GitHub release snapshot completed and was written to the owner history."
          : `GitHub release sync: ${result.result.code}.`,
        "info",
      );
      await load();
    } catch (error) {
      showNotice(`GitHub release sync did not complete: ${adminActionErrorMessage(error)}`);
    } finally {
      button.disabled = false;
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      const minutes = Number($("#auto-refresh-minutes").value);
      const stale = state.lastSuccessfulLoadAt === null
        || Date.now() - state.lastSuccessfulLoadAt >= minutes * 60 * 1_000;
      if (minutes > 0 && stale && navigator.onLine !== false) {
        void load({ automatic: true });
      } else {
        scheduleRefresh();
      }
    } else {
      clearRefreshSchedule();
      refreshStatusText();
    }
  });
  window.addEventListener("online", () => {
    const minutes = Number($("#auto-refresh-minutes").value);
    const stale = state.lastSuccessfulLoadAt === null
      || Date.now() - state.lastSuccessfulLoadAt >= minutes * 60 * 1_000;
    if (minutes > 0 && stale && document.visibilityState !== "hidden") {
      void load({ automatic: true });
    } else {
      scheduleRefresh();
    }
  });
  window.addEventListener("offline", () => {
    clearRefreshSchedule();
    refreshStatusText();
  });
}

void load();
