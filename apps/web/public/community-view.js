// The community aggregate view. This is the only dashboard surface that needs
// no local companion, so it is the one surface the public website can show
// honestly. Both entry points render it from this single module: the in-app
// dashboard (app.js) and the public site (community.js).

import { normalizeCommunitySnapshot } from "./data-client.js";
import {
  compact,
  createDomHelpers,
  formatAge,
  formatLocal,
} from "./ui-format.js";

export const COMMUNITY_METRIC_LABELS = Object.freeze({
  usageEvents: "Usage events",
  inputUncachedTokens: "Input uncached",
  inputCacheReadTokens: "Cache read",
  inputCacheWriteTokens: "Cache write",
  outputTextTokens: "Output text",
  outputReasoningTokens: "Reasoning output",
  outputCombinedTokens: "Combined output",
  toolUnits: "Tool units",
});

/**
 * Fixed, non-speculative copy for every state the community contract can be
 * in. A state that carries no released figures must say so plainly rather than
 * leaving an empty panel that reads like a loading spinner that never ends.
 */
export const COMMUNITY_SNAPSHOT_STATE_COPY = Object.freeze({
  service_unavailable:
    "The central service is unavailable. This is separate from whether a weekly snapshot exists.",
  development_unsafe:
    "Live cumulative community totals are development-only and are not displayed.",
  unsupported_schema:
    "The service returned an unsupported community-snapshot contract. No values were displayed.",
  not_yet_published: "No stable weekly snapshot is available yet.",
  withdrawn:
    "This weekly revision was withdrawn for privacy or quality reasons. A replacement revision may be pending.",
  suppressed:
    "This week did not pass the fixed privacy release policy. We do not disclose why or how close the cohort was.",
});

const PENDING_CONTRACT_ROWS = Object.freeze([
  Object.freeze(["Released snapshot", "Not loaded"]),
  Object.freeze(["Cohort limit estimate", "Not in current contract"]),
  Object.freeze(["Matched quota coverage", "Not in current contract"]),
  Object.freeze(["Change confidence", "Not in current contract"]),
]);

/**
 * Renders one community snapshot payload.
 *
 * `detail` is optional: the public site shows the same provenance disclosure
 * the dashboard does, but a caller without that container still gets the
 * headline table and the honest empty states.
 */
export function renderCommunitySnapshot({
  documentRef,
  container,
  detail = null,
  payload,
  now = Date.now(),
}) {
  const { clear, node } = createDomHelpers(documentRef);
  clear(container);
  if (detail) clear(detail);
  const snapshot = normalizeCommunitySnapshot(payload);

  if (snapshot.state === "service_unavailable") {
    container.append(
      node("p", "", COMMUNITY_SNAPSHOT_STATE_COPY.service_unavailable),
    );
    if (!detail) return snapshot.state;
    const quality = node("dl", "snapshot-quality-grid");
    for (const [term, value] of PENDING_CONTRACT_ROWS) {
      const item = node("div");
      item.append(node("dt", "", term), node("dd", "", value));
      quality.append(item);
    }
    detail.append(quality);
    detail.append(node(
      "p",
      "snapshot-disclosure",
      "No community capacity or change claim is inferred from aggregate activity alone. The next contract must publish replay exclusions, matched quota coverage, uncertainty, and cohort support together.",
    ));
    return snapshot.state;
  }

  if (Object.hasOwn(COMMUNITY_SNAPSHOT_STATE_COPY, snapshot.state)) {
    container.append(
      node("p", "", COMMUNITY_SNAPSHOT_STATE_COPY[snapshot.state]),
    );
    return snapshot.state;
  }

  const heading = node("div", "snapshot-heading");
  heading.append(node(
    "strong",
    "",
    `${formatLocal(snapshot.period.startAt, { dateOnly: true })} – ${
      formatLocal(snapshot.period.endAt, { dateOnly: true })
    }`,
  ));
  container.append(heading);
  // The one sentence a reader needs to know what these numbers are and are
  // not. The mechanism that produces them lives in the disclosure below.
  container.append(node(
    "p",
    "snapshot-disclosure",
    `Activity totals for the week above, from people who chose to contribute. A figure appears only when at least ${
      compact(snapshot.minimumIndependentParticipants)
    } different participants used that provider and model, and every figure is rounded down — so this is not everyone's usage, not an average, and not a cost.`,
  ));
  if (snapshot.state === "published_partial") {
    container.append(node(
      "p",
      "snapshot-partial",
      "Some metrics were not released because their independent support was insufficient.",
    ));
  }

  if (detail) {
    const quality = node("dl", "snapshot-quality-grid");
    for (
      const [term, value] of [
        ["Contract", snapshot.schemaVersion],
        ["Released model cells", compact(snapshot.cells.length)],
        [
          "Minimum support",
          `≥${compact(snapshot.minimumIndependentParticipants)} participants per cell`,
        ],
        ["Ingestion cutoff", formatLocal(snapshot.ingestionCutoffAt)],
        ["Released", formatLocal(snapshot.releasedAt)],
        [
          "Snapshot age",
          formatAge(Math.max(0, (now - Date.parse(snapshot.releasedAt)) / 1_000)),
        ],
        [
          "Coverage state",
          snapshot.state === "published_partial"
            ? "Partially released"
            : "All contracted cells released",
        ],
      ]
    ) {
      const item = node("div");
      item.append(node("dt", "", term), node("dd", "", value));
      quality.append(item);
    }
    detail.append(quality);
    detail.append(node(
      "p",
      "snapshot-disclosure",
      `Each value is clipped per participant, independently support-gated at ${
        compact(snapshot.minimumIndependentParticipants)
      } or more participants, and rounded down. A sealed revision is never rewritten; deletion creates a replacement revision.`,
    ));
    detail.append(node(
      "p",
      "snapshot-disclosure",
      "This release currently reports privacy-safe activity totals. Cohort weekly-limit estimates, matched quota coverage, replay exclusions, and change confidence require the next community contract before they can be shown honestly.",
    ));
  }

  const wrap = node("div", "table-wrap snapshot-table");
  const table = documentRef.createElement("table");
  const caption = node(
    "caption",
    "sr-only",
    "Privacy-safe delayed weekly community metrics",
  );
  const thead = documentRef.createElement("thead");
  const header = documentRef.createElement("tr");
  for (
    const label of [
      "Provider / model",
      ...Object.values(COMMUNITY_METRIC_LABELS),
    ]
  ) {
    const th = documentRef.createElement("th");
    th.scope = "col";
    th.textContent = label;
    header.append(th);
  }
  thead.append(header);
  const tbody = documentRef.createElement("tbody");
  for (const cell of snapshot.cells) {
    const row = documentRef.createElement("tr");
    const identity = documentRef.createElement("th");
    identity.scope = "row";
    identity.textContent = `${cell.provider} · ${
      cell.planType === "unknown"
        ? "plan unknown"
        : cell.planType + (cell.planVariant !== "unknown" ? " " + cell.planVariant : "")
    } · ${cell.modelId}`;
    row.append(identity);
    for (const metricName of Object.keys(COMMUNITY_METRIC_LABELS)) {
      const td = documentRef.createElement("td");
      const metric = cell.metrics[metricName];
      td.textContent = metric.status === "released"
        ? compact(metric.value)
        : "Not released";
      if (metric.status !== "released") td.className = "suppressed-value";
      row.append(td);
    }
    tbody.append(row);
  }
  table.append(caption, thead, tbody);
  wrap.append(table);
  container.append(wrap);
  return snapshot.state;
}
