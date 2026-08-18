import {
  adminActionErrorMessage,
  adminResponseError,
  projectAdminAction,
  projectAdminOverview,
} from "./admin-client.js";
import { PublicCommunityClient } from "./community-data.js";
import { renderCommunityAllowanceSection } from "./community-view.js";
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
  communityPayload: null,
  communityRangeDays: null,
  notificationPreferences: null,
};
const $ = (selector) => document.querySelector(selector);
const ADMIN_PAGE_CLASS = "admin-operator-page";
const AUTO_REFRESH_STORAGE_KEY = "tibotattle-admin-auto-refresh-minutes-v1";
const NOTIFICATION_STORAGE_KEY = "tibotattle-admin-notifications-v1";
const DEFAULT_AUTO_REFRESH_MINUTES = 5;
const AUTO_REFRESH_OPTIONS = new Set([0, 1, 5, 15]);
const NOTIFICATION_REPEAT_OPTIONS = new Set([0, 5, 15, 60]);
const ADMIN_TITLE = "TiboTattle operations";
const isAdminPage = document.body?.classList?.contains(ADMIN_PAGE_CLASS) === true;
const communityClient = new PublicCommunityClient({
  fetchImpl(path, init = {}) {
    return fetch(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
    });
  },
});
let infoHintSequence = 0;

const INFO_HINTS = Object.freeze({
  "Approved community accounts": "Approved identities that are currently active and allowed to contribute. This includes approved accounts that have not yet sent accepted data.",
  "Accounts with accepted data": "Distinct approved accounts with at least one accepted whole contribution or incremental chunk. The caption shows how many were active in the trailing 30 days.",
  "Approved last 24h": "Identities first approved during the trailing 24 hours. The caption gives the corresponding trailing seven-day count.",
  "Telemetry contributions": "Accepted whole-contribution envelopes. Current app versions normally send incremental chunks, so this can be zero while uploads are healthy.",
  "Current incremental chunks": "Accepted incremental journal chunks that have not been superseded. The caption includes every retained chunk row, including older superseded rows.",
  "Accepted uploads last 24h": "Accepted whole contributions plus incremental chunks received during the trailing 24 hours. One account can send many uploads.",
  "Stored telemetry records": "Content-free metadata rows retained by the earlier telemetry-record path. This is a row count, not a contributor count.",
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

function renderMetricCards(selector, metrics) {
  $(selector).replaceChildren(...metrics.map(([label, value, detail]) => {
    const card = document.createElement("div");
    card.className = "admin-card admin-metric";
    const name = labelWithInfo(label);
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

function percentage(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) {
    return "—";
  }
  return `${Math.round((value / total) * 100)}%`;
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
      summary ? count(summary.dmgDownloads) : "—",
      summary
        ? `${summary.releaseCount} releases · ${summary.dmgAssetCount} DMG assets · all time`
        : "unavailable from GitHub; activity counts are unaffected",
    ],
    [
      "GitHub DMG downloads since prior snapshot",
      history.dmgDownloadsSincePrevious === null
        ? "—"
        : count(history.dmgDownloadsSincePrevious),
      history.previousObservedAt
        ? `${formatTime(history.previousObservedAt)} → ${formatTime(history.latestObservedAt)}`
        : "available after a second complete snapshot",
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
  $("#audit-rows").replaceChildren(...rows.map(auditRow));
  $("#audit-empty").hidden = rows.length !== 0;
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
    lastFingerprint: null,
    lastSentAt: null,
  };
}

function readNotificationPreferences() {
  const saved = storageRead(NOTIFICATION_STORAGE_KEY, notificationDefaults());
  const repeatMinutes = Number(saved?.repeatMinutes);
  return {
    enabled: saved?.enabled === true,
    repeatMinutes: NOTIFICATION_REPEAT_OPTIONS.has(repeatMinutes)
      ? repeatMinutes
      : 0,
    lastFingerprint: typeof saved?.lastFingerprint === "string"
      ? saved.lastFingerprint
      : null,
    lastSentAt: Number.isFinite(saved?.lastSentAt) ? saved.lastSentAt : null,
  };
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
  if (!api) {
    enabled.checked = false;
    enabled.disabled = true;
    repeat.disabled = true;
    test.disabled = true;
    setNotificationStatus("This browser does not support native notifications.");
    return;
  }
  enabled.checked = preferences.enabled && api.permission === "granted";
  repeat.value = String(preferences.repeatMinutes);
  repeat.disabled = !enabled.checked;
  test.disabled = !enabled.checked;
  if (api.permission === "denied") {
    setNotificationStatus("Blocked in browser settings.");
  } else if (enabled.checked) {
    setNotificationStatus(
      preferences.repeatMinutes === 0
        ? "Enabled: once for each new attention state."
        : `Enabled: unresolved alerts repeat every ${preferences.repeatMinutes} minutes.`,
    );
  } else {
    setNotificationStatus("Off.");
  }
}

function notificationFingerprint(items) {
  return items
    .filter((item) => item.level !== "ok")
    .map((item) => `${item.level}:${item.title}:${item.detail}`)
    .sort()
    .join("|");
}

function notifyAttention(items) {
  if (!isAdminPage) return;
  const alerts = items.filter((item) => item.level !== "ok");
  document.title = alerts.length > 0 ? `• ${ADMIN_TITLE}` : ADMIN_TITLE;
  const preferences = state.notificationPreferences ?? readNotificationPreferences();
  if (!preferences.enabled || alerts.length === 0) return;
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

function renderCommunityRangeControls() {
  const controls = $("#admin-community-range-controls");
  if (!controls) return;
  for (const button of controls.querySelectorAll("button[data-range-days]")) {
    const value = button.dataset.rangeDays;
    const selected = value === "all"
      ? state.communityRangeDays === null
      : Number(value) === state.communityRangeDays;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}

function renderAdminCommunityAllowance(payload) {
  if (!isAdminPage) return;
  const container = $("#admin-community-allowance-result");
  const stateNode = $("#admin-community-allowance-state");
  if (!container || !stateNode) return;
  const result = renderCommunityAllowanceSection({
    documentRef: document,
    container,
    stateNode,
    payload,
    rangeDays: state.communityRangeDays,
  });
  const badge = $("#admin-community-status");
  const available = result === "published";
  badge.className = `admin-source-badge ${
    available ? "admin-source-available" : "admin-source-partial"
  }`;
  badge.textContent = available ? "Public graph available" : "Public graph unavailable";
  renderCommunityRangeControls();
}

async function loadAdminCommunityAllowance() {
  if (!isAdminPage) return;
  try {
    state.communityPayload = await communityClient.communityDaily();
    renderAdminCommunityAllowance(state.communityPayload);
  } catch {
    state.communityPayload = null;
    renderAdminCommunityAllowance(null);
  }
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
  state.loading = true;
  let succeeded = false;
  $("#refresh").disabled = true;
  refreshStatusText();
  try {
    // No app session on the admin host: authentication is Cloudflare Access and
    // the owner-email pin, and CSRF is the always-sent x-usage-monitor-admin
    // header. The old /api/v1/session pre-fetch 401'd here and was the dead
    // console symptom.
    const reference = $("#diagnostic-reference").value.trim();
    const query = reference ? `?diagnosticReference=${encodeURIComponent(reference)}` : "";
    render(projectAdminOverview(await request(`/api/v1/admin/overview${query}`)));
    $("#notice").hidden = true;
    state.lastSuccessfulLoadAt = Date.now();
    state.retryDelayMilliseconds = 30_000;
    succeeded = true;
    void loadAdminCommunityAllowance();
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
  void load();
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
      saveNotificationPreferences({ ...preferences, enabled: false });
      updateNotificationControls();
      return;
    }
    if (!api) {
      control.checked = false;
      setNotificationStatus("This browser does not support native notifications.");
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
    saveNotificationPreferences({ ...preferences, enabled: true });
    updateNotificationControls();
    if (state.overview) notifyAttention(collectAttentionItems(state.overview));
  });
  $("#notification-repeat-minutes").addEventListener("change", (event) => {
    const repeatMinutes = Number(event.currentTarget.value);
    const preferences = state.notificationPreferences ?? readNotificationPreferences();
    saveNotificationPreferences({
      ...preferences,
      repeatMinutes: NOTIFICATION_REPEAT_OPTIONS.has(repeatMinutes)
        ? repeatMinutes
        : 0,
    });
    updateNotificationControls();
  });
  $("#notification-test").addEventListener("click", () => {
    const api = notificationApi();
    if (!api || api.permission !== "granted") {
      setNotificationStatus("Enable browser alerts before sending a test.");
      return;
    }
    try {
      new api("TiboTattle admin test", {
        body: "Browser alerts are enabled for this private admin browser.",
        tag: "tibotattle-admin-test",
        renotify: true,
      });
      setNotificationStatus("Test alert sent.");
    } catch {
      setNotificationStatus("The browser could not show a test alert.");
    }
  });
  $("#admin-community-range-controls").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-range-days]");
    if (!button) return;
    state.communityRangeDays = button.dataset.rangeDays === "all"
      ? null
      : Number(button.dataset.rangeDays);
    renderAdminCommunityAllowance(state.communityPayload);
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
