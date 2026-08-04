// The community aggregate view. It needs no local companion, so the public
// website can show it honestly. The local app and public site render it from
// this single module.

import { normalizeCommunitySnapshot } from "./community-data.js";
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
    "Community activity is temporarily unavailable. This does not tell us whether a weekly snapshot exists.",
  development_unsafe:
    "Live cumulative totals have not passed privacy review, so they are not displayed.",
  unsupported_schema:
    "This community snapshot cannot be displayed safely with this version of TiboTattle.",
  not_yet_published: "No stable weekly snapshot is available yet.",
  withdrawn:
    "This weekly revision was withdrawn for privacy or quality reasons. A replacement revision may be pending.",
  suppressed:
    "This week did not pass the privacy checks required for publication. We do not disclose why or how close the cohort was.",
});

const PENDING_CONTRACT_ROWS = Object.freeze([
  Object.freeze(["Weekly snapshot", "Waiting for service"]),
  Object.freeze(["Seven-day estimate", "Not available"]),
  Object.freeze(["Matched quota coverage", "Not available"]),
  Object.freeze(["Confidence range", "Not available"]),
]);

/**
 * The current weekly contract publishes activity cells, not allowance
 * evidence. Keep that distinction as a separate rendered state so a future
 * contract cannot accidentally turn a token total into a quota claim.
 */
export const COMMUNITY_ESTIMATE_STATE_COPY = Object.freeze({
  service_unavailable: Object.freeze({
    label: "Unavailable",
    hero: "Unavailable right now",
    body: "The community service is temporarily unavailable, so there’s no estimate to show.",
  }),
  development_unsafe: Object.freeze({
    label: "Unavailable",
    hero: "No public estimate",
    body: "There’s no privacy-reviewed community estimate to show right now.",
  }),
  unsupported_schema: Object.freeze({
    label: "Unavailable",
    hero: "Estimate update required",
    body: "This estimate needs an update before it can be shown safely.",
  }),
  not_yet_published: Object.freeze({
    label: "Collecting evidence",
    hero: "Collecting matched evidence",
    body: "The community estimate isn’t ready yet. Matched quota coverage and uncertainty are still being collected.",
  }),
  withdrawn: Object.freeze({
    label: "Not published",
    hero: "This week was withdrawn",
    body: "This week’s estimate was withdrawn after privacy or quality review.",
  }),
  suppressed: Object.freeze({
    label: "Not published",
    hero: "Not published this week",
    body: "This week’s estimate is not published because the evidence did not pass the required privacy checks.",
  }),
  activity_only: Object.freeze({
    label: "Activity only",
    hero: "Activity released; estimate pending",
    body: "This week’s community activity is available, but it does not support an allowance estimate yet.",
  }),
});

function estimateState(snapshot) {
  return Object.hasOwn(COMMUNITY_ESTIMATE_STATE_COPY, snapshot.state)
    ? snapshot.state
    : "activity_only";
}

/**
 * Render the named public estimate gate without deriving a number from the
 * current activity-only contract. The optional nodes are public-site-only;
 * the in-app dashboard keeps its existing activity snapshot surface.
 */
export function renderCommunityEstimate({
  documentRef,
  container = null,
  hero = null,
  stateNode = null,
  stateNodes = [],
  snapshot,
}) {
  const { clear, node } = createDomHelpers(documentRef);
  const state = estimateState(snapshot);
  const copy = COMMUNITY_ESTIMATE_STATE_COPY[state];
  if (container) {
    clear(container);
    container.append(node("p", "estimate-status-copy", copy.body));
  }
  if (hero) hero.textContent = copy.hero;
  for (const item of [stateNode, ...stateNodes]) {
    if (!item) continue;
    item.textContent = copy.label;
    item.className = "evidence-chip neutral";
  }
  return state;
}

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
  estimateContainer = null,
  estimateHero = null,
  estimateState = null,
  estimateStates = [],
  payload,
  now = Date.now(),
}) {
  const { clear, node } = createDomHelpers(documentRef);
  clear(container);
  if (detail) clear(detail);
  const snapshot = normalizeCommunitySnapshot(payload);
  renderCommunityEstimate({
    documentRef,
    container: estimateContainer,
    hero: estimateHero,
    stateNode: estimateState,
    stateNodes: estimateStates,
    snapshot,
  });

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
      "A community estimate needs matched quota coverage, replay checks, uncertainty, and enough independent contributors. Activity totals alone are never used as an estimate.",
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
        ["Data format", snapshot.schemaVersion],
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
      "This snapshot reports privacy-safe activity totals only. A community estimate also needs matched quota coverage, replay checks, uncertainty, and confidence.",
    ));
  }

  // A release can contain many provider/model cells. The public landing view
  // stays a readable weekly snapshot; the complete activity breakdown remains
  // available on demand without masquerading as a personal dashboard.
  const breakdown = node("details", "journey-disclosure snapshot-breakdown");
  const summary = node("summary");
  summary.append(node(
    "span",
    "",
    `View detailed activity by provider and model (${compact(snapshot.cells.length)} cells)`,
  ));
  breakdown.append(summary);
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
  breakdown.append(wrap);
  container.append(breakdown);
  return snapshot.state;
}
