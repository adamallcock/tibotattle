import { addUsdStrings } from "@app-usagemonitor/accounting";

import {
  WORK_USAGE_COMPONENTS,
  queryWorkUsageSnapshot,
  workUsageError,
} from "./work-usage.js";

export const USAGE_EXPLAINER_SCHEMA_VERSION = "local-usage-explainer-v1";
export const USAGE_EXPLAINER_MAX_RESPONSE_BYTES = 16 * 1024;
export const USAGE_EXPLAINER_MAX_ROWS = 25;
export const USAGE_EXPLAINER_FRESHNESS_MS = 30 * 60 * 1_000;

const plans = {
  data_health: {
    question: "Is the local evidence current and complete enough to interpret?",
    answerGrades: ["exact"],
    evidence: false,
    pageable: false,
    prohibitedClaims: [
      "missing or partial evidence is zero usage",
      "a readable source is an installed-artifact or provider-authoritative receipt",
    ],
  },
  current_usage: {
    question: "How much recorded usage is in the selected window?",
    answerGrades: ["exact", "configured_estimate"],
    evidence: false,
    pageable: false,
    prohibitedClaims: [
      "recorded tokens equal provider allowance movement",
      "API-price-equivalent valuation is subscription billing",
    ],
  },
  top_work: {
    question: "Which task families account for the most recorded usage?",
    answerGrades: ["exact", "deterministic"],
    evidence: true,
    pageable: true,
    prohibitedClaims: [
      "a large task family is wasteful or low quality",
      "a task label or content can be reconstructed from its selector",
    ],
  },
  period_drivers: {
    question: "Which project groups arithmetically explain the change from the previous equal window?",
    answerGrades: ["exact", "deterministic"],
    evidence: true,
    pageable: true,
    prohibitedClaims: [
      "an arithmetic contributor caused the change",
      "a larger period total means worse productivity",
    ],
  },
  model_effort_mix: {
    question: "Which recorded models account for the selected window?",
    answerGrades: ["exact"],
    evidence: true,
    pageable: true,
    prohibitedClaims: [
      "usage establishes model quality",
      "missing effort or service-tier evidence is a default setting",
    ],
  },
  pricing_coverage: {
    question: "How much usage has an event-time API-price-equivalent valuation?",
    answerGrades: ["exact", "configured_estimate"],
    evidence: true,
    pageable: true,
    prohibitedClaims: [
      "API-price-equivalent valuation is a provider charge or subscription debit",
      "unpriced usage has zero value",
    ],
  },
  parent_subworker_usage: {
    question: "How is recorded usage divided between primary tasks and their subworkers?",
    answerGrades: ["exact", "deterministic"],
    evidence: true,
    pageable: true,
    prohibitedClaims: [
      "subworker usage was unnecessary or duplicated work",
      "usage alone establishes whether delegation improved the outcome",
    ],
  },
  allowance_movement: {
    question: "What compatible provider allowance movements were observed in the selected window?",
    answerGrades: ["exact"],
    evidence: true,
    pageable: true,
    prohibitedClaims: [
      "local task usage exactly caused an allowance movement",
      "incompatible reset identities or plan eras can be combined",
    ],
  },
};

export const USAGE_EXPLAINER_PLANS = Object.freeze(
  Object.fromEntries(
    Object.entries(plans).map(([id, contract]) => [
      id,
      Object.freeze({
        id,
        ...contract,
        answerGrades: Object.freeze([...contract.answerGrades]),
        prohibitedClaims: Object.freeze([...contract.prohibitedClaims]),
      }),
    ]),
  ),
);

const PERIODS = Object.freeze({
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  all: null,
});
const REQUEST_KEYS = new Set(["schemaVersion", "plan", "period", "limit", "cursor"]);
const SELECTOR_PATTERN = /^ue1\.([a-z_]{1,40})\.(24h|7d|30d|all)\.([0-9a-z]+)\.([0-9a-z]+)\.([0-9a-z]+)\.([0-9a-f]{16})\.([0-9a-f]{32})$/u;
const CURSOR_PATTERN = /^uec1\.([a-z_]{1,40})\.(24h|7d|30d|all)\.([0-9a-z]+)\.([0-9a-z]+)\.([0-9a-z]+)\.([0-9a-z]+)\.([0-9a-f]{16})\.([0-9a-f]{32})$/u;

function explanationError(code) {
  return Object.assign(new Error(code), { code });
}

function parseBase36(value, { minimum = 0 } = {}) {
  const parsed = Number.parseInt(value, 36);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < minimum
    || parsed.toString(36) !== value
  ) {
    throw explanationError("usage_explainer_cursor_invalid");
  }
  return parsed;
}

export function parseUsageExplainerCursor(value) {
  if (typeof value !== "string" || value.length > 300) {
    throw explanationError("usage_explainer_cursor_invalid");
  }
  const match = CURSOR_PATTERN.exec(value);
  if (match === null || !Object.hasOwn(USAGE_EXPLAINER_PLANS, match[1])) {
    throw explanationError("usage_explainer_cursor_invalid");
  }
  const fromMs = parseBase36(match[3]);
  const toMs = parseBase36(match[4]);
  const limit = parseBase36(match[5], { minimum: 1 });
  const offset = parseBase36(match[6], { minimum: 1 });
  if (toMs < fromMs || limit > USAGE_EXPLAINER_MAX_ROWS) {
    throw explanationError("usage_explainer_cursor_invalid");
  }
  return Object.freeze({
    value,
    plan: match[1],
    period: match[2],
    fromMs,
    toMs,
    limit,
    offset,
    generationTag: match[7],
    signature: match[8],
  });
}

export function createUsageExplainerSelectorCodec({ digest } = {}) {
  if (typeof digest !== "function") {
    throw new TypeError("digest must be a function");
  }
  const derive = (subject) => {
    const value = digest(subject);
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
      throw new TypeError("digest must return 64 lowercase hexadecimal characters");
    }
    return value;
  };
  const generationTag = (fingerprint) => {
    if (typeof fingerprint !== "string" || fingerprint.length < 1 || fingerprint.length > 200) {
      throw explanationError("usage_explainer_selector_invalid");
    }
    return derive(`generation\0${fingerprint}`).slice(0, 16);
  };
  return Object.freeze({
    generationTag,
    create({
      plan,
      period,
      fromMs,
      toMs,
      generationFingerprint,
      entityKind,
      entityId,
      rank,
    }) {
      if (
        !Object.hasOwn(USAGE_EXPLAINER_PLANS, plan)
        || !Object.hasOwn(PERIODS, period)
        || !Number.isSafeInteger(fromMs)
        || fromMs < 0
        || !Number.isSafeInteger(toMs)
        || toMs < fromMs
        || typeof entityKind !== "string"
        || !/^[a-z_]{1,40}$/u.test(entityKind)
        || typeof entityId !== "string"
        || entityId.length < 1
        || entityId.length > 4_096
        || !Number.isSafeInteger(rank)
        || rank < 1
      ) {
        throw explanationError("usage_explainer_selector_invalid");
      }
      const tag = generationTag(generationFingerprint);
      const entity = derive(JSON.stringify([
        plan,
        period,
        fromMs,
        toMs,
        generationFingerprint,
        entityKind,
        entityId,
        rank,
      ])).slice(0, 32);
      return `ue1.${plan}.${period}.${fromMs.toString(36)}.${toMs.toString(36)}.${rank.toString(36)}.${tag}.${entity}`;
    },
    parse(value) {
      if (typeof value !== "string" || value.length > 240) {
        throw explanationError("usage_explainer_selector_invalid");
      }
      const match = SELECTOR_PATTERN.exec(value);
      if (match === null || !Object.hasOwn(USAGE_EXPLAINER_PLANS, match[1])) {
        throw explanationError("usage_explainer_selector_invalid");
      }
      const fromMs = Number.parseInt(match[3], 36);
      const toMs = Number.parseInt(match[4], 36);
      const rank = Number.parseInt(match[5], 36);
      if (
        !Number.isSafeInteger(fromMs)
        || fromMs < 0
        || fromMs.toString(36) !== match[3]
        || !Number.isSafeInteger(toMs)
        || toMs < fromMs
        || toMs.toString(36) !== match[4]
        || !Number.isSafeInteger(rank)
        || rank < 1
        || rank.toString(36) !== match[5]
      ) {
        throw explanationError("usage_explainer_selector_invalid");
      }
      return Object.freeze({
        plan: match[1],
        period: match[2],
        fromMs,
        toMs,
        rank,
        generationTag: match[6],
      });
    },
    createCursor({
      plan,
      period,
      fromMs,
      toMs,
      generationFingerprint,
      limit,
      offset,
    }) {
      if (
        !Object.hasOwn(USAGE_EXPLAINER_PLANS, plan)
        || USAGE_EXPLAINER_PLANS[plan].pageable !== true
        || !Object.hasOwn(PERIODS, period)
        || !Number.isSafeInteger(fromMs)
        || fromMs < 0
        || !Number.isSafeInteger(toMs)
        || toMs < fromMs
        || !Number.isSafeInteger(limit)
        || limit < 1
        || limit > USAGE_EXPLAINER_MAX_ROWS
        || !Number.isSafeInteger(offset)
        || offset < 1
      ) {
        throw explanationError("usage_explainer_cursor_invalid");
      }
      const tag = generationTag(generationFingerprint);
      const signature = derive(`cursor\0${JSON.stringify([
        plan,
        period,
        fromMs,
        toMs,
        generationFingerprint,
        limit,
        offset,
      ])}`).slice(0, 32);
      return `uec1.${plan}.${period}.${fromMs.toString(36)}.${toMs.toString(36)}.${limit.toString(36)}.${offset.toString(36)}.${tag}.${signature}`;
    },
    verifyCursor(value, {
      plan,
      period,
      limit,
      generationFingerprint,
    }) {
      const cursor = typeof value === "string"
        ? parseUsageExplainerCursor(value)
        : value;
      if (
        cursor === null
        || typeof cursor !== "object"
        || cursor.plan !== plan
        || cursor.period !== period
        || cursor.limit !== limit
      ) {
        throw explanationError("usage_explainer_cursor_invalid");
      }
      if (cursor.generationTag !== generationTag(generationFingerprint)) {
        throw explanationError("usage_explainer_cursor_stale");
      }
      const expected = derive(`cursor\0${JSON.stringify([
        cursor.plan,
        cursor.period,
        cursor.fromMs,
        cursor.toMs,
        generationFingerprint,
        cursor.limit,
        cursor.offset,
      ])}`).slice(0, 32);
      if (cursor.signature !== expected) {
        throw explanationError("usage_explainer_cursor_invalid");
      }
      return cursor;
    },
  });
}

export function validateUsageExplanationRequest(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).some((key) => !REQUEST_KEYS.has(key))
    || value.schemaVersion !== USAGE_EXPLAINER_SCHEMA_VERSION
    || !Object.hasOwn(USAGE_EXPLAINER_PLANS, value.plan)
  ) {
    throw explanationError("usage_explainer_query_invalid");
  }
  const request = {
    period: "7d",
    limit: 10,
    cursor: null,
    ...value,
  };
  if (
    !Object.hasOwn(PERIODS, request.period)
    || !Number.isSafeInteger(request.limit)
    || request.limit < 1
    || request.limit > USAGE_EXPLAINER_MAX_ROWS
    || (request.cursor !== null
      && (typeof request.cursor !== "string"
        || request.cursor.length < 1
        || request.cursor.length > 300
        || USAGE_EXPLAINER_PLANS[request.plan].pageable !== true))
    || (request.plan === "period_drivers" && request.period === "all")
  ) {
    throw explanationError("usage_explainer_query_invalid");
  }
  return Object.freeze(request);
}

export function usageExplanationCatalog() {
  return {
    schemaVersion: USAGE_EXPLAINER_SCHEMA_VERSION,
    status: "available",
    periods: Object.keys(PERIODS),
    defaults: { period: "7d", limit: 10 },
    limits: {
      maximumRowsPerPage: USAGE_EXPLAINER_MAX_ROWS,
      maximumResponseBytes: USAGE_EXPLAINER_MAX_RESPONSE_BYTES,
      freshnessAfterMs: USAGE_EXPLAINER_FRESHNESS_MS,
    },
    pagination: {
      requestField: "cursor",
      responseField: "nextCursor",
      binding: ["generation", "plan", "period", "window", "limit"],
    },
    plans: Object.values(USAGE_EXPLAINER_PLANS).map((contract) => ({
      id: contract.id,
      question: contract.question,
      answerGrades: [...contract.answerGrades],
      evidence: contract.evidence,
      pageable: contract.pageable,
      periods: Object.keys(PERIODS).filter(
        (period) => contract.id !== "period_drivers" || period !== "all",
      ),
      prohibitedClaims: [...contract.prohibitedClaims],
    })),
  };
}

export function usageExplanationBounds(request, nowMs) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw explanationError("usage_explainer_clock_invalid");
  }
  const duration = PERIODS[request.period];
  return Object.freeze({
    fromMs: duration === null ? 0 : Math.max(0, nowMs - duration),
    toMs: nowMs,
  });
}

export function validateUsageExplanationFixedBounds(request, bounds, nowMs) {
  if (
    bounds === null
    || typeof bounds !== "object"
    || !Number.isSafeInteger(bounds.fromMs)
    || bounds.fromMs < 0
    || !Number.isSafeInteger(bounds.toMs)
    || bounds.toMs < bounds.fromMs
    || bounds.toMs > nowMs + 60_000
  ) {
    throw explanationError("usage_explainer_selector_invalid");
  }
  const duration = PERIODS[request.period];
  if (
    (duration === null && bounds.fromMs !== 0)
    || (duration !== null && bounds.toMs - bounds.fromMs !== duration)
  ) {
    throw explanationError("usage_explainer_selector_invalid");
  }
  return Object.freeze({ fromMs: bounds.fromMs, toMs: bounds.toMs });
}

function known(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function addKnown(left, right) {
  if (!known(right)) return left;
  const result = (left ?? 0) + right;
  if (!known(result)) throw workUsageError("work_usage_overflow");
  return result;
}

function exactDelta(current, previous) {
  return known(current) && known(previous) ? current - previous : null;
}

function componentRecord(source = {}) {
  return Object.fromEntries(
    WORK_USAGE_COMPONENTS.map((key) => [key, known(source[key]) ? source[key] : null]),
  );
}

function componentDelta(current = {}, previous = {}) {
  return Object.fromEntries(
    WORK_USAGE_COMPONENTS.map((key) => [
      key,
      exactDelta(current[key], previous[key]),
    ]),
  );
}

function usageFacts(row) {
  return {
    tokens: known(row?.tokens) ? row.tokens : null,
    events: known(row?.events) ? row.events : 0,
    incompleteEvents: known(row?.incompleteEvents) ? row.incompleteEvents : 0,
    unknownEvents: known(row?.unknownEvents) ? row.unknownEvents : 0,
    assumedEvents: known(row?.assumedEvents) ? row.assumedEvents : 0,
    components: componentRecord(row?.components),
    costUsdExact: typeof row?.costUsdExact === "string" ? row.costUsdExact : null,
    priceStatus: ["complete", "partial", "unpriced"].includes(row?.priceStatus)
      ? row.priceStatus
      : "unpriced",
    unpricedEvents: known(row?.unpricedEvents) ? row.unpricedEvents : 0,
    partialPriceEvents: known(row?.partialPriceEvents) ? row.partialPriceEvents : 0,
  };
}

function querySnapshot(snapshot, grouping, pageSize, offset = 0) {
  return queryWorkUsageSnapshot(snapshot, {
    grouping,
    sort: "tokens",
    offset,
    pageSize,
  });
}

function modelDetails(row) {
  const values = Array.isArray(row?.modelBreakdown) ? row.modelBreakdown : [];
  return {
    rows: values.slice(0, 10).map((model) => ({
      model: model.id,
      share: typeof model.share === "number" ? model.share : null,
      ...usageFacts(model),
    })),
    truncated: values.length > 10,
  };
}

function contributionDetails(row) {
  return (Array.isArray(row?.contributions) ? row.contributions : []).map((part) => ({
    kind: part.id,
    share: typeof part.share === "number" ? part.share : null,
    ...usageFacts(part),
  }));
}

function emptyModel(model) {
  return {
    model,
    tokens: null,
    events: 0,
    incompleteEvents: 0,
    unknownEvents: 0,
    assumedEvents: 0,
    costUsdExact: null,
    unpricedEvents: 0,
    partialPriceEvents: 0,
    components: Object.fromEntries(WORK_USAGE_COMPONENTS.map((key) => [key, null])),
  };
}

function summarizeModels(snapshot) {
  const rows = new Map();
  for (const cell of snapshot.cells ?? []) {
    const model = cell.models?.[0] ?? "unknown";
    const row = rows.get(model) ?? emptyModel(model);
    for (const field of [
      "tokens",
      "events",
      "incompleteEvents",
      "unknownEvents",
      "assumedEvents",
      "unpricedEvents",
      "partialPriceEvents",
    ]) {
      row[field] = addKnown(row[field], cell[field]);
    }
    for (const key of WORK_USAGE_COMPONENTS) {
      row.components[key] = addKnown(row.components[key], cell.components?.[key]);
    }
    if (typeof cell.costUsdExact === "string") {
      row.costUsdExact = addUsdStrings(row.costUsdExact ?? "0", cell.costUsdExact);
    }
    rows.set(model, row);
  }
  const totalTokens = [...rows.values()].reduce(
    (sum, row) => addKnown(sum, row.tokens),
    null,
  );
  return [...rows.values()]
    .map((row) => ({
      ...row,
      share: known(row.tokens) && totalTokens ? row.tokens / totalTokens : null,
      priceStatus: row.costUsdExact === null
        ? "unpriced"
        : row.unpricedEvents || row.partialPriceEvents || row.incompleteEvents
          ? "partial"
          : "complete",
    }))
    .sort((left, right) => (right.tokens ?? -1) - (left.tokens ?? -1)
      || left.model.localeCompare(right.model));
}

function requiredProvenance(plan, generation) {
  if (plan === "data_health") return { kind: "all", complete: null };
  if (plan === "allowance_movement") {
    return {
      kind: "quota",
      complete: generation?.quotaProvenanceComplete === true,
    };
  }
  return {
    kind: "usage",
    complete: generation?.usageProvenanceComplete === true,
  };
}

export function assessUsageExplanationCoverage({ request, bounds, generation }) {
  const completedAtMs = known(generation?.completedAtMs)
    ? generation.completedAtMs
    : null;
  const ageMs = completedAtMs === null
    ? null
    : Math.max(0, bounds.toMs - completedAtMs);
  const freshnessStatus = ageMs === null
    ? "unavailable"
    : ageMs <= USAGE_EXPLAINER_FRESHNESS_MS ? "fresh" : "stale";
  const provenance = requiredProvenance(request.plan, generation);
  let status = "complete";
  let errorCode = null;
  if (completedAtMs === null
      || (request.period !== "all" && completedAtMs < bounds.fromMs)) {
    status = "unavailable";
    errorCode = "usage_explainer_window_uncovered";
  } else if (freshnessStatus !== "fresh") {
    status = "partial";
  }
  if (provenance.complete === false) {
    status = "unavailable";
    errorCode = provenance.kind === "quota"
      ? "usage_explainer_quota_provenance_incomplete"
      : "usage_explainer_usage_provenance_incomplete";
  } else if (status === "complete" && (
    generation?.discoveryComplete !== true
    || generation?.diagnosticsComplete !== true
  )) {
    status = "partial";
  }
  if (request.plan === "data_health" && generation?.status !== "complete") {
    status = status === "unavailable" ? status : "partial";
  }
  const limitations = [];
  if (status === "unavailable" && errorCode === "usage_explainer_window_uncovered") {
    limitations.push(
      "The committed index was not refreshed during the requested window; zero rows would not establish zero usage.",
    );
  } else if (freshnessStatus === "stale") {
    limitations.push(
      "The committed index is stale, so facts stop at an earlier refresh and do not cover the complete requested window.",
    );
  }
  if (provenance.complete === false) {
    limitations.push(
      `${provenance.kind === "quota" ? "Quota" : "Usage"} provenance is incomplete for this generation.`,
    );
  }
  if (generation?.discoveryComplete !== true) {
    limitations.push("Source discovery is incomplete for this generation.");
  }
  if (generation?.diagnosticsComplete !== true) {
    limitations.push("Source diagnostics are incomplete for this generation.");
  }
  if (request.plan === "data_health" && generation?.status !== "complete") {
    const reason = typeof generation?.blockReason === "string"
      ? ` (${generation.blockReason})`
      : "";
    limitations.push(
      `The index generation is ${generation?.status ?? "unavailable"}${reason}; each evidence plan must still pass its own provenance gate.`,
    );
  }
  return Object.freeze({
    status,
    errorCode,
    freshness: Object.freeze({
      status: freshnessStatus,
      ageMs,
      staleAfterMs: USAGE_EXPLAINER_FRESHNESS_MS,
    }),
    provenance: Object.freeze(provenance),
    limitations: Object.freeze(limitations),
  });
}

function coverageRecord({ current, health, bounds, request }) {
  const generation = health?.generation ?? current?.generation ?? null;
  const assessment = assessUsageExplanationCoverage({
    request,
    bounds,
    generation,
  });
  return {
    status: assessment.status,
    errorCode: assessment.errorCode,
    sourceKind: health?.sourceKind ?? null,
    freshness: assessment.freshness,
    provenance: assessment.provenance,
    publication: generation === null ? null : {
      fingerprint: generation.fingerprint,
      status: generation.status,
      completedAtMs: generation.completedAtMs,
    },
    requestedWindow: { ...bounds, status: assessment.status },
    indexedHistory: generation === null ? null : {
      fromMs: generation.coveredStartMs,
      toMs: generation.coveredEndMs,
      discoveredSourceCount: generation.discoveredSourceCount,
      indexedSourceCount: generation.indexedSourceCount,
      skippedSourceCount: generation.skippedSourceCount,
    },
    measurements: generation === null ? null : {
      usageProvenanceComplete: generation.usageProvenanceComplete,
      quotaProvenanceComplete: generation.quotaProvenanceComplete,
      toolProvenanceComplete: generation.toolProvenanceComplete,
      sourceOrderComplete: generation.sourceOrderComplete,
    },
    metadata: current?.metadata === undefined ? null : {
      status: current.metadata.status,
      inspectedSources: current.metadata.inspectedSources ?? null,
      indexedSources: current.metadata.indexedSources ?? null,
      excludedAllowanceUpdates: current.metadata.excludedAllowanceUpdates ?? 0,
    },
    limitations: [...assessment.limitations],
  };
}

function rawItem(entityKind, entityId, summary, details) {
  return { entityKind, entityId, summary, details };
}

function materializeItems(rawItems, context) {
  const items = [];
  const evidence = new Map();
  for (const [index, raw] of rawItems.entries()) {
    const rank = context.offset + index + 1;
    const selector = context.selectorFor({
      plan: context.request.plan,
      period: context.request.period,
      fromMs: context.bounds.fromMs,
      toMs: context.bounds.toMs,
      generationFingerprint: context.generationFingerprint,
      entityKind: raw.entityKind,
      entityId: raw.entityId,
      rank,
    });
    const item = { rank, selector, ...raw.summary };
    items.push(item);
    evidence.set(selector, {
      kind: raw.entityKind,
      fact: item,
      details: raw.details,
    });
  }
  return { items, evidence };
}

function planTopWork(context) {
  const report = querySnapshot(
    context.current,
    "thread",
    context.request.limit,
    context.offset,
  );
  const rawItems = report.rows.map((row) => rawItem(
    "task_family",
    row.id,
    {
      tokens: row.tokens,
      share: row.share,
      events: row.events,
      subworkerCount: row.subworkerCount ?? 0,
      lastObservedAtMs: row.lastAt,
      costUsdExact: row.costUsdExact,
      priceStatus: row.priceStatus,
    },
    {
      usage: usageFacts(row),
      models: modelDetails(row),
      contributions: contributionDetails(row),
    },
  ));
  return {
    facts: {
      ...usageFacts(report.totals),
      taskFamilyCount: report.rowCount,
      activeProjectCount: context.current.metadata?.status === "available"
        ? report.totals.activeProjects
        : null,
      attributedProjectCount: report.totals.activeProjects,
      projectAttributionStatus: context.current.metadata?.status ?? "unavailable",
    },
    totalItems: report.rowCount,
    limitations: context.current.metadata?.status === "available"
      ? []
      : [
        "Project attribution is incomplete; attributedProjectCount includes only project groups supported by available metadata.",
      ],
    ...materializeItems(rawItems, context),
  };
}

function planPeriodDrivers(context) {
  const pageSize = Math.max(
    1,
    context.current.cells?.length ?? 0,
    context.previous.cells?.length ?? 0,
  );
  const current = querySnapshot(context.current, "project", pageSize);
  const previous = querySnapshot(context.previous, "project", pageSize);
  const priorRows = new Map(previous.rows.map((row) => [row.id, row]));
  const currentRows = new Map(current.rows.map((row) => [row.id, row]));
  const ids = new Set([...currentRows.keys(), ...priorRows.keys()]);
  const netChange = exactDelta(current.totals.tokens, previous.totals.tokens);
  const candidates = [...ids].map((id) => {
    const now = currentRows.get(id);
    const before = priorRows.get(id);
    const change = exactDelta(now?.tokens ?? 0, before?.tokens ?? 0);
    return { id, now, before, change };
  }).sort((left, right) => Math.abs(right.change ?? 0) - Math.abs(left.change ?? 0)
    || left.id.localeCompare(right.id));
  const rawItems = candidates
    .slice(context.offset, context.offset + context.request.limit)
    .map((candidate) => rawItem(
      "project_group",
      candidate.id,
      {
        currentTokens: candidate.now?.tokens ?? 0,
        previousTokens: candidate.before?.tokens ?? 0,
        tokenChange: candidate.change,
        shareOfNetChange: netChange ? candidate.change / netChange : null,
      },
      {
        current: usageFacts(candidate.now),
        previous: usageFacts(candidate.before),
        componentChange: componentDelta(
          candidate.now?.components,
          candidate.before?.components,
        ),
      },
    ));
  return {
    facts: {
      current: usageFacts(current.totals),
      previous: usageFacts(previous.totals),
      tokenChange: netChange,
      currentWindow: { ...context.bounds },
      previousWindow: { ...context.previousBounds },
      driverCount: candidates.length,
    },
    totalItems: candidates.length,
    ...materializeItems(rawItems, context),
  };
}

function planModelMix(context) {
  const models = summarizeModels(context.current);
  const rawItems = models
    .slice(context.offset, context.offset + context.request.limit)
    .map((row) => rawItem(
      "model",
      row.model,
      {
        model: row.model,
        tokens: row.tokens,
        share: row.share,
        events: row.events,
        costUsdExact: row.costUsdExact,
        priceStatus: row.priceStatus,
      },
      { usage: usageFacts(row) },
    ));
  return {
    facts: {
      modelCount: models.length,
      effortCoverage: "unavailable",
      serviceTierCoverage: "unavailable",
    },
    totalItems: models.length,
    limitations: [
      "The current work-usage facade exposes model identity but not a complete effort or service-tier grouping.",
    ],
    ...materializeItems(rawItems, context),
  };
}

function planPricingCoverage(context) {
  const total = querySnapshot(context.current, "project", 1).totals;
  const models = summarizeModels(context.current);
  const rawItems = models
    .slice(context.offset, context.offset + context.request.limit)
    .map((row) => rawItem(
      "model_pricing",
      row.model,
      {
        model: row.model,
        events: row.events,
        costUsdExact: row.costUsdExact,
        priceStatus: row.priceStatus,
        unpricedEvents: row.unpricedEvents,
        partialPriceEvents: row.partialPriceEvents,
      },
      { usage: usageFacts(row) },
    ));
  return {
    facts: {
      events: total.events,
      costUsdExact: total.costUsdExact,
      priceStatus: total.priceStatus,
      unpricedEvents: total.unpricedEvents,
      partialPriceEvents: total.partialPriceEvents,
      incompleteEvents: total.incompleteEvents,
      pricingBasis: context.current.pricing?.basis ?? null,
      pricingFingerprint: context.current.pricing?.fingerprint ?? null,
    },
    totalItems: models.length,
    ...materializeItems(rawItems, context),
  };
}

function planParentSubworker(context) {
  const candidateLimit = 100;
  const report = querySnapshot(context.current, "thread", candidateLimit);
  const candidates = report.rows.filter((row) => (row.subworkerCount ?? 0) > 0);
  const rawItems = candidates
    .slice(context.offset, context.offset + context.request.limit)
    .map((row) => {
      const contributions = contributionDetails(row);
      const primary = contributions.find((part) => part.kind === "primary");
      const subworkers = contributions.find((part) => part.kind === "subworkers");
      return rawItem(
        "task_family",
        row.id,
        {
          tokens: row.tokens,
          events: row.events,
          subworkerCount: row.subworkerCount,
          primaryTokens: primary?.tokens ?? null,
          subworkerTokens: subworkers?.tokens ?? null,
          subworkerShare: subworkers?.share ?? null,
        },
        {
          usage: usageFacts(row),
          contributions,
          models: modelDetails(row),
        },
      );
    });
  return {
    facts: {
      taskFamilyCount: report.rowCount,
      familiesWithObservedSubworkersInCandidateSet: candidates.length,
      candidateLimit,
      candidateSetTruncated: report.rowCount > candidateLimit,
    },
    totalItems: candidates.length,
    sourceTruncated: report.rowCount > candidateLimit,
    limitations: report.rowCount > candidateLimit
      ? ["Subworker discovery is bounded to the 100 largest recorded task families."]
      : [],
    ...materializeItems(rawItems, context),
  };
}

function planAllowanceMovement(context) {
  const rows = context.allowance?.windows ?? [];
  const rawItems = rows.map((row) => rawItem(
    "allowance_window",
    JSON.stringify([
      row.provider,
      row.planType,
      row.limitId,
      row.durationMins,
      row.resetsAtMs,
    ]),
    { ...row },
    {
      observationRange: {
        firstObservedAtMs: row.firstObservedAtMs,
        lastObservedAtMs: row.lastObservedAtMs,
        observationCount: row.observationCount,
      },
      compatibilityKey: {
        provider: row.provider,
        planType: row.planType,
        limitId: row.limitId,
        durationMins: row.durationMins,
        resetsAtMs: row.resetsAtMs,
      },
    },
  ));
  const windowGroupCount = context.allowance?.rowCount ?? rows.length;
  const observedMovementCount = context.allowance?.observedMovementCount
    ?? rows.filter((row) => row.movementStatus === "observed").length;
  const resetIdentityMissingCount = context.allowance?.resetIdentityMissingCount
    ?? rows.filter((row) => row.movementStatus === "reset_identity_missing").length;
  const singleObservationCount = context.allowance?.singleObservationCount
    ?? rows.filter((row) => row.movementStatus === "single_observation").length;
  const nonMonotonicCount = context.allowance?.nonMonotonicCount
    ?? rows.filter((row) => row.movementStatus === "non_monotonic").length;
  return {
    facts: {
      windowGroupCount,
      observedMovementCount,
      unresolvedWindowCount: windowGroupCount - observedMovementCount,
      resetIdentityMissingCount,
      singleObservationCount,
      nonMonotonicCount,
      observedShare: windowGroupCount === 0
        ? null
        : observedMovementCount / windowGroupCount,
    },
    totalItems: windowGroupCount,
    ...materializeItems(rawItems, context),
  };
}

export function projectUsageExplanation({
  request,
  bounds,
  previousBounds = null,
  current = null,
  previous = null,
  allowance = null,
  health,
  selectorFor,
  offset = 0,
}) {
  const contract = USAGE_EXPLAINER_PLANS[request.plan];
  const generation = health?.generation ?? current?.generation ?? null;
  const context = {
    request,
    bounds,
    previousBounds,
    current,
    previous,
    allowance,
    selectorFor,
    offset,
    generationFingerprint: generation?.fingerprint ?? "unavailable",
  };
  let projected;
  if (request.plan === "data_health") {
    projected = {
      facts: generation === null ? null : {
        status: generation.status,
        blockReason: generation.blockReason ?? null,
        completedAtMs: generation.completedAtMs,
        parserVersion: generation.parserVersion,
        contractVersion: generation.contractVersion,
        usageEvents: generation.usageEvents,
        quotaOccurrences: generation.quotaOccurrences,
        toolFacts: generation.toolFacts,
        discoveryComplete: generation.discoveryComplete,
        diagnosticsComplete: generation.diagnosticsComplete,
      },
      items: [],
      evidence: new Map(),
      totalItems: 0,
    };
  } else if (request.plan === "current_usage") {
    projected = {
      facts: usageFacts(querySnapshot(current, "project", 1).totals),
      items: [],
      evidence: new Map(),
      totalItems: 0,
    };
  } else if (request.plan === "top_work") {
    projected = planTopWork(context);
  } else if (request.plan === "period_drivers") {
    projected = planPeriodDrivers(context);
  } else if (request.plan === "model_effort_mix") {
    projected = planModelMix(context);
  } else if (request.plan === "pricing_coverage") {
    projected = planPricingCoverage(context);
  } else if (request.plan === "parent_subworker_usage") {
    projected = planParentSubworker(context);
  } else {
    projected = planAllowanceMovement(context);
  }
  const coverage = coverageRecord({ current, health, bounds, request });
  const limitations = [
    ...coverage.limitations,
    ...(projected.limitations ?? []),
    ...(request.plan === "allowance_movement"
      ? ["Allowance movement and local usage are separate observations; this result does not allocate percentage points to tasks."]
      : []),
  ];
  const pageable = contract.pageable === true;
  const totalItems = projected.totalItems ?? 0;
  const nextOffset = pageable
    && projected.items.length > 0
    && offset + projected.items.length < totalItems
    ? offset + projected.items.length
    : null;
  return {
    envelope: {
      schemaVersion: USAGE_EXPLAINER_SCHEMA_VERSION,
      status: "available",
      plan: request.plan,
      question: contract.question,
      answerGrades: [...contract.answerGrades],
      fromMs: bounds.fromMs,
      toMs: bounds.toMs,
      coverage,
      facts: projected.facts,
      items: projected.items,
      limitations,
      prohibitedClaims: [...contract.prohibitedClaims],
      ...(pageable ? {
        page: {
          offset,
          limit: request.limit,
          returnedItems: projected.items.length,
          totalItems,
        },
        nextCursor: null,
      } : {}),
      truncated: projected.sourceTruncated === true || nextOffset !== null,
    },
    evidence: projected.evidence,
    nextOffset,
  };
}

export function unavailableUsageExplanation(
  request,
  bounds,
  errorCode,
  { current = null, health = null, limitations = [] } = {},
) {
  const coverage = health === null
    ? null
    : coverageRecord({ current, health, bounds, request });
  return {
    schemaVersion: USAGE_EXPLAINER_SCHEMA_VERSION,
    status: "unavailable",
    plan: request.plan,
    fromMs: bounds.fromMs,
    toMs: bounds.toMs,
    errorCode: typeof errorCode === "string" && errorCode.length <= 100
      ? errorCode
      : "usage_explainer_unavailable",
    ...(coverage === null ? {} : { coverage }),
    facts: null,
    items: [],
    limitations: [
      ...new Set([
        ...(coverage?.limitations ?? []),
        ...limitations,
        "No interpretation should be made until the required local evidence is available.",
      ]),
    ],
    prohibitedClaims: [...USAGE_EXPLAINER_PLANS[request.plan].prohibitedClaims],
    truncated: false,
  };
}
