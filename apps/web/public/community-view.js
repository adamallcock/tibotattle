// The community aggregate view. It needs no local companion, so the public
// website can show it honestly. The local app and public site render it from
// this single module.

import {
  normalizeCommunityDailySeries,
  normalizeCommunitySnapshot,
} from "./community-data.js";
import {
  compact,
  createDomHelpers,
  formatAge,
  formatLocal,
} from "./ui-format.js";
import { translate } from "./localization.js";

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

const COMMUNITY_SNAPSHOT_STATE_KEYS = Object.freeze({
  service_unavailable: "community.state.serviceUnavailable",
  development_unsafe: "community.state.developmentUnsafe",
  unsupported_schema: "community.state.unsupportedSchema",
  not_yet_published: "community.state.notYetPublished",
  withdrawn: "community.state.withdrawn",
  suppressed: "community.state.suppressed",
});

const COMMUNITY_METRIC_MESSAGE_KEYS = Object.freeze({
  usageEvents: "community.metric.usageEvents",
  inputUncachedTokens: "community.metric.inputUncached",
  inputCacheReadTokens: "community.metric.cacheRead",
  inputCacheWriteTokens: "community.metric.cacheWrite",
  outputTextTokens: "community.metric.outputText",
  outputReasoningTokens: "community.metric.reasoningOutput",
  outputCombinedTokens: "community.metric.combinedOutput",
  toolUnits: "community.metric.toolUnits",
});

/**
 * Fixed copy for the day-partitioned series states. Same policy as the
 * weekly snapshot copy above: no degraded state may leave an empty panel.
 */
export const COMMUNITY_DAILY_STATE_COPY = Object.freeze({
  service_unavailable:
    "Daily community activity is temporarily unavailable. This does not tell us whether any day has been published.",
  unsupported_schema:
    "The daily community series cannot be displayed safely with this version of TiboTattle.",
  none_published:
    "No daily community activity has been published for the year window yet.",
});

const COMMUNITY_DAILY_STATE_KEYS = Object.freeze({
  service_unavailable: "community.daily.state.serviceUnavailable",
  unsupported_schema: "community.daily.state.unsupportedSchema",
  none_published: "community.daily.state.nonePublished",
});

const COMMUNITY_DAILY_COLUMN_KEYS = Object.freeze([
  "community.daily.day",
  "community.metric.usageEvents",
  "community.daily.quotaObservations",
  "community.daily.contributingDevices",
  "community.metric.combinedOutput",
  "community.daily.revision",
  "community.released",
]);

/**
 * Renders the day-partitioned community series: the latest published
 * revision per day inside the requested year window. Revision freshness is
 * first-class — every row carries its revision and release time, and the
 * headline names the latest published day's revision and age — because a day
 * here is never sealed: late contributions replace it with a new revision.
 */
export function renderCommunityDailySeries({
  documentRef,
  container,
  stateNode = null,
  payload,
  now = Date.now(),
}) {
  const { clear, node } = createDomHelpers(documentRef);
  const locale = documentRef?.documentElement?.lang ?? "en-US";
  const t = (key, values = {}) => translate(key, values, locale);
  clear(container);
  const series = normalizeCommunityDailySeries(payload);
  if (stateNode) {
    stateNode.textContent = series.state === "published"
      ? t("community.daily.seriesAvailable")
      : t("community.daily.seriesUnavailable");
    stateNode.className = series.state === "published"
      ? "evidence-chip"
      : "evidence-chip neutral";
  }
  if (series.state !== "published") {
    container.append(node("p", "", t(COMMUNITY_DAILY_STATE_KEYS[series.state])));
    return series.state;
  }

  const latest = series.days[series.days.length - 1];
  const quality = node("dl", "snapshot-quality-grid");
  for (const [term, value] of [
    [t("community.daily.latestDay"), formatLocal(latest.day, { dateOnly: true })],
    [t("community.daily.revision"), `r${latest.revision}`],
    [t("community.released"), formatLocal(latest.releasedAt)],
    [
      t("community.daily.revisionAge"),
      formatAge(Math.max(0, (now - Date.parse(latest.releasedAt)) / 1_000)),
    ],
    [t("community.daily.publishedDays"), compact(series.days.length)],
  ]) {
    const item = node("div");
    item.append(node("dt", "", term), node("dd", "", value));
    quality.append(item);
  }
  container.append(quality);
  container.append(node(
    "p",
    "snapshot-disclosure",
    t("community.daily.recomputeNote"),
  ));

  const breakdown = node("details", "journey-disclosure snapshot-breakdown");
  const summary = node("summary");
  summary.append(node(
    "span",
    "",
    t("community.daily.detailedDays", { count: compact(series.days.length) }),
  ));
  breakdown.append(summary);
  const wrap = node("div", "table-wrap snapshot-table");
  const table = documentRef.createElement("table");
  const caption = node("caption", "sr-only", t("community.daily.metricsCaption"));
  const thead = documentRef.createElement("thead");
  const header = documentRef.createElement("tr");
  for (const key of COMMUNITY_DAILY_COLUMN_KEYS) {
    const th = documentRef.createElement("th");
    th.scope = "col";
    th.textContent = t(key);
    header.append(th);
  }
  thead.append(header);
  const tbody = documentRef.createElement("tbody");
  // Most recent day first: freshness is what a reader scans for.
  for (const day of [...series.days].reverse()) {
    const row = documentRef.createElement("tr");
    const identity = documentRef.createElement("th");
    identity.scope = "row";
    identity.setAttribute("data-i18n-skip", "");
    identity.textContent = day.day;
    row.append(identity);
    for (const value of [
      compact(day.totals.usageEvents),
      compact(day.totals.quotaObservations),
      compact(day.totals.contributingDevices),
      compact(day.totals.outputCombinedTokens),
      `r${day.revision}`,
      formatLocal(day.releasedAt),
    ]) {
      const td = documentRef.createElement("td");
      td.textContent = value;
      row.append(td);
    }
    tbody.append(row);
  }
  table.append(caption, thead, tbody);
  wrap.append(table);
  breakdown.append(wrap);
  container.append(breakdown);
  return series.state;
}

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

// Preserve the exported English copy above as a stable, non-localized
// contract for callers and tests. Rendering always goes through these keys so
// that the public first-visit estimate state changes language with the rest of
// the page instead of leaving a misleading English-only status behind.
const COMMUNITY_ESTIMATE_STATE_KEYS = Object.freeze({
  service_unavailable: Object.freeze({
    label: "community.estimate.serviceUnavailable.label",
    hero: "community.estimate.serviceUnavailable.hero",
    body: "community.estimate.serviceUnavailable.body",
  }),
  development_unsafe: Object.freeze({
    label: "community.estimate.developmentUnsafe.label",
    hero: "community.estimate.developmentUnsafe.hero",
    body: "community.estimate.developmentUnsafe.body",
  }),
  unsupported_schema: Object.freeze({
    label: "community.estimate.unsupportedSchema.label",
    hero: "community.estimate.unsupportedSchema.hero",
    body: "community.estimate.unsupportedSchema.body",
  }),
  not_yet_published: Object.freeze({
    label: "community.estimate.notYetPublished.label",
    hero: "community.estimate.notYetPublished.hero",
    body: "community.estimate.notYetPublished.body",
  }),
  withdrawn: Object.freeze({
    label: "community.estimate.withdrawn.label",
    hero: "community.estimate.withdrawn.hero",
    body: "community.estimate.withdrawn.body",
  }),
  suppressed: Object.freeze({
    label: "community.estimate.suppressed.label",
    hero: "community.estimate.suppressed.hero",
    body: "community.estimate.suppressed.body",
  }),
  activity_only: Object.freeze({
    label: "community.estimate.activityOnly.label",
    hero: "community.estimate.activityOnly.hero",
    body: "community.estimate.activityOnly.body",
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
  const localizedKeys = COMMUNITY_ESTIMATE_STATE_KEYS[state];
  const locale = documentRef?.documentElement?.lang ?? "en-US";
  const t = (key) => translate(key, {}, locale);
  if (container) {
    clear(container);
    container.append(node(
      "p",
      "estimate-status-copy",
      localizedKeys ? t(localizedKeys.body) : copy.body,
    ));
  }
  if (hero) hero.textContent = localizedKeys ? t(localizedKeys.hero) : copy.hero;
  for (const item of [stateNode, ...stateNodes]) {
    if (!item) continue;
    item.textContent = localizedKeys ? t(localizedKeys.label) : copy.label;
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
  const locale = documentRef?.documentElement?.lang ?? "en-US";
  const t = (key, values = {}) => translate(key, values, locale);
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
      node("p", "", t("community.state.serviceUnavailable")),
    );
    if (!detail) return snapshot.state;
    const quality = node("dl", "snapshot-quality-grid");
    for (const [term, value] of [
      [t("community.pending.releasedSnapshot"), t("community.pending.notLoaded")],
      [t("community.pending.cohortLimit"), t("community.pending.notInContract")],
      [t("community.pending.matchedQuota"), t("community.pending.notInContract")],
      [t("community.pending.changeConfidence"), t("community.pending.notInContract")],
    ]) {
      const item = node("div");
      item.append(node("dt", "", term), node("dd", "", value));
      quality.append(item);
    }
    detail.append(quality);
    detail.append(node(
      "p",
      "snapshot-disclosure",
      t("community.noCapacityClaim"),
    ));
    return snapshot.state;
  }

  if (Object.hasOwn(COMMUNITY_SNAPSHOT_STATE_COPY, snapshot.state)) {
    container.append(
      node("p", "", t(COMMUNITY_SNAPSHOT_STATE_KEYS[snapshot.state])),
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
  const providerAccountCohort = snapshot.participantCohort === "provider_account";
  const weeklyActivityKey = providerAccountCohort
    ? "community.providerAccountWeeklyActivity"
    : "community.weeklyActivity";
  const partialMetricsKey = providerAccountCohort
    ? "community.providerAccountPartialMetrics"
    : "community.partialMetrics";
  const supportKey = providerAccountCohort
    ? "community.providerAccountsPerCell"
    : "community.participantsPerCell";
  const releaseMechanicsKey = providerAccountCohort
    ? "community.providerAccountReleaseMechanics"
    : "community.releaseMechanics";
  // The one sentence a reader needs to know what these numbers are and are
  // not. The mechanism that produces them lives in the disclosure below.
  container.append(node(
    "p",
    "snapshot-disclosure",
    t(weeklyActivityKey, {
      count: compact(snapshot.minimumParticipants),
    }),
  ));
  if (snapshot.state === "published_partial") {
    container.append(node(
      "p",
      "snapshot-partial",
      t(partialMetricsKey),
    ));
  }

  if (detail) {
    const quality = node("dl", "snapshot-quality-grid");
    for (
      const [term, value] of [
        [t("community.contract"), snapshot.schemaVersion],
        [t("community.releasedModelCells"), compact(snapshot.cells.length)],
        [
          t("community.minimumSupport"),
          t(supportKey, {
            count: compact(snapshot.minimumParticipants),
          }),
        ],
        [t("community.ingestionCutoff"), formatLocal(snapshot.ingestionCutoffAt)],
        [t("community.released"), formatLocal(snapshot.releasedAt)],
        [
          t("community.snapshotAge"),
          formatAge(Math.max(0, (now - Date.parse(snapshot.releasedAt)) / 1_000)),
        ],
        [
          t("community.coverageState"),
          snapshot.state === "published_partial"
            ? t("community.partiallyReleased")
            : t("community.allContractedCells"),
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
      t(releaseMechanicsKey, {
        count: compact(snapshot.minimumParticipants),
      }),
    ));
    detail.append(node(
      "p",
      "snapshot-disclosure",
      t("community.currentReleaseScope"),
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
    t("community.detailedActivity", { count: compact(snapshot.cells.length) }),
  ));
  breakdown.append(summary);
  const wrap = node("div", "table-wrap snapshot-table");
  const table = documentRef.createElement("table");
  const caption = node(
    "caption",
    "sr-only",
    t("community.metricsCaption"),
  );
  const thead = documentRef.createElement("thead");
  const header = documentRef.createElement("tr");
  for (
    const label of [
      t("community.providerModel"),
      ...Object.keys(COMMUNITY_METRIC_LABELS).map((metricName) =>
        t(COMMUNITY_METRIC_MESSAGE_KEYS[metricName])),
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
    // Provider/model identifiers are source data, not product copy. Keep
    // them outside the exact-text localization bridge even if a future value
    // happens to equal a translated UI label.
    identity.setAttribute("data-i18n-skip", "");
    identity.textContent = [
      cell.provider,
      cell.planType === "unknown"
        ? t("community.planUnknown")
        : cell.planType + (cell.planVariant !== "unknown" ? " " + cell.planVariant : ""),
      cell.modelId,
    ].join(" · ");
    row.append(identity);
    for (const metricName of Object.keys(COMMUNITY_METRIC_LABELS)) {
      const td = documentRef.createElement("td");
      const metric = cell.metrics[metricName];
      td.textContent = metric.status === "released"
        ? compact(metric.value)
        : t("community.notReleased");
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
