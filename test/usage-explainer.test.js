import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createUsageExplainerService,
  fitUsageExplanationEnvelope,
} from "../src/application/index.js";
import {
  USAGE_EXPLAINER_MAX_RESPONSE_BYTES,
  USAGE_EXPLAINER_FRESHNESS_MS,
  USAGE_EXPLAINER_PLANS,
  USAGE_EXPLAINER_SCHEMA_VERSION,
  createUsageExplainerSelectorCodec,
  assessUsageExplanationCoverage,
  parseUsageExplainerCursor,
  usageExplanationCatalog,
  validateUsageExplanationRequest,
} from "../src/reporting/index.js";
import {
  projectLocalAllowanceMovementRows,
} from "../src/local-usage-explainer.js";

const NOW = Date.parse("2027-01-15T12:00:00.000Z");
const DAY = 86_400_000;
const GENERATION = Object.freeze({
  id: 7,
  fingerprint: `generation-v2-${"a".repeat(64)}`,
  status: "complete",
  completedAtMs: NOW - 1_000,
  parserVersion: "synthetic-parser-v1",
  contractVersion: "usage-event-v0.2",
  usageEvents: 5,
  quotaOccurrences: 3,
  toolFacts: 2,
  discoveryComplete: true,
  diagnosticsComplete: true,
  usageProvenanceComplete: true,
  quotaProvenanceComplete: true,
  toolProvenanceComplete: true,
  sourceOrderComplete: true,
  coveredStartMs: NOW - 30 * DAY,
  coveredEndMs: NOW - 1_000,
  discoveredSourceCount: 2,
  indexedSourceCount: 2,
  skippedSourceCount: 0,
});

function digest(subject) {
  return createHash("sha256").update(`synthetic\0${subject}`).digest("hex");
}

function components({ uncached = 0, cached = 0, output = 0, reasoning = 0 } = {}) {
  return {
    input_uncached_tokens: uncached,
    input_cache_read_tokens: cached,
    input_cache_write_tokens: 0,
    output_text_tokens: output,
    output_reasoning_tokens: reasoning,
    output_combined_tokens: null,
  };
}

function cell({
  thread,
  project,
  model,
  at,
  values,
  cost,
}) {
  const tokens = Object.values(values).filter(Number.isSafeInteger)
    .reduce((sum, value) => sum + value, 0);
  return {
    id: `${thread}:${project}:${model}`,
    kind: "cell",
    tokens,
    events: 1,
    incompleteEvents: 0,
    unknownEvents: 0,
    assumedEvents: 0,
    lastAt: at,
    costUsdExact: cost,
    unpricedEvents: cost === null ? 1 : 0,
    partialPriceEvents: 0,
    components: values,
    threads: [thread],
    projects: [project],
    worktrees: [`worktree-${project}`],
    models: [model],
  };
}

function snapshot({ previous = false } = {}) {
  const start = previous ? NOW - 14 * DAY : NOW - 7 * DAY;
  const end = previous ? NOW - 7 * DAY : NOW;
  const cells = previous
    ? [
      cell({
        thread: "private-thread-primary",
        project: "private-project-one",
        model: "gpt-5.6-sol",
        at: end - 2_000,
        values: components({ uncached: 50, cached: 40, output: 10 }),
        cost: "0.25",
      }),
      cell({
        thread: "private-thread-two",
        project: "private-project-two",
        model: "gpt-5.6-luna",
        at: end - 1_000,
        values: components({ uncached: 150, cached: 40, output: 10 }),
        cost: null,
      }),
    ]
    : [
      cell({
        thread: "private-thread-primary",
        project: "private-project-one",
        model: "gpt-5.6-sol",
        at: end - 3_000,
        values: components({ uncached: 100, cached: 200, output: 20, reasoning: 10 }),
        cost: "1.25",
      }),
      cell({
        thread: "private-thread-child",
        project: "private-project-one",
        model: "gpt-5.6-sol",
        at: end - 2_000,
        values: components({ uncached: 50, cached: 50, output: 5, reasoning: 5 }),
        cost: "0.25",
      }),
      cell({
        thread: "private-thread-two",
        project: "private-project-two",
        model: "gpt-5.6-luna",
        at: end - 1_000,
        values: components({ uncached: 100, output: 10 }),
        cost: "0.50",
      }),
    ];
  return {
    status: "available",
    generation: GENERATION,
    scope: "private-scope",
    scopes: [{ id: "private-scope", status: "available", events: cells.length }],
    fromMs: start,
    toMs: end,
    cells,
    models: ["gpt-5.6-luna", "gpt-5.6-sol"],
    threadLookup: {},
    threadFamilies: {
      "private-thread-primary": "private-thread-primary",
      "private-thread-child": "private-thread-primary",
      "private-thread-two": "private-thread-two",
    },
    display: { projects: {}, worktrees: {}, threads: {} },
    pricing: { basis: "event_time", fingerprint: "synthetic-pricing" },
    metadata: {
      status: "available",
      inspectedSources: 2,
      indexedSources: 2,
      excludedAllowanceUpdates: 1,
    },
  };
}

function allowance() {
  return {
    status: "available",
    generation: GENERATION,
    truncated: false,
    windows: [{
      provider: "openai_codex",
      planType: "pro",
      limitId: "codex",
      durationMins: 10_080,
      resetsAtMs: NOW + DAY,
      firstObservedAtMs: NOW - 6 * DAY,
      lastObservedAtMs: NOW - 1_000,
      firstUsedPercent: 20,
      lastUsedPercent: 37,
      movementPercentagePoints: 17,
      observationCount: 3,
      movementStatus: "observed",
    }],
  };
}

function createFixtureService({
  generation = GENERATION,
  maximumResponseBytes,
  clock = () => NOW,
  readWorkUsage = async ({ toMs }) => (
    toMs === NOW ? snapshot() : snapshot({ previous: true })
  ),
} = {}) {
  let codecLoads = 0;
  const codec = createUsageExplainerSelectorCodec({ digest });
  const service = createUsageExplainerService({
    clock,
    maximumResponseBytes,
    readHealth: async () => ({
      status: "available",
      generation,
      sourceKind: "electron_production",
    }),
    readWorkUsage,
    readAllowance: async () => allowance(),
    loadSelectorCodec: async () => {
      codecLoads += 1;
      return codec;
    },
  });
  return { service, codecLoads: () => codecLoads };
}

function request(plan, overrides = {}) {
  return {
    schemaVersion: USAGE_EXPLAINER_SCHEMA_VERSION,
    plan,
    period: "7d",
    limit: 10,
    ...overrides,
  };
}

test("the initial registry is closed to the eight agreed plans", () => {
  assert.deepEqual(Object.keys(USAGE_EXPLAINER_PLANS), [
    "data_health",
    "current_usage",
    "top_work",
    "period_drivers",
    "model_effort_mix",
    "pricing_coverage",
    "parent_subworker_usage",
    "allowance_movement",
  ]);
  for (const invalid of [
    null,
    {},
    request("unknown"),
    { ...request("current_usage"), extra: true },
    request("current_usage", { period: "90d" }),
    request("period_drivers", { period: "all" }),
    request("top_work", { limit: 0 }),
    request("top_work", { limit: 26 }),
    request("current_usage", { cursor: "uec1.invalid" }),
  ]) {
    assert.throws(
      () => validateUsageExplanationRequest(invalid),
      (error) => error.code === "usage_explainer_query_invalid",
    );
  }
});

test("selectors are stable and do not contain the selected local identity", () => {
  const codec = createUsageExplainerSelectorCodec({ digest });
  const selected = codec.create({
    plan: "top_work",
    period: "7d",
    fromMs: NOW - 7 * DAY,
    toMs: NOW,
    generationFingerprint: GENERATION.fingerprint,
    entityKind: "task_family",
    entityId: "private-thread-primary",
    rank: 1,
  });
  assert.equal(selected.includes("private"), false);
  assert.deepEqual(codec.parse(selected), {
    plan: "top_work",
    period: "7d",
    fromMs: NOW - 7 * DAY,
    toMs: NOW,
    rank: 1,
    generationTag: codec.generationTag(GENERATION.fingerprint),
  });
  assert.throws(
    () => codec.parse(`${selected}x`),
    (error) => error.code === "usage_explainer_selector_invalid",
  );
});

test("the machine-readable catalog describes plans, limits, and pagination", () => {
  const catalog = usageExplanationCatalog();
  assert.equal(catalog.schemaVersion, USAGE_EXPLAINER_SCHEMA_VERSION);
  assert.equal(catalog.plans.length, 8);
  assert.equal(catalog.limits.maximumRowsPerPage, 25);
  assert.equal(catalog.limits.freshnessAfterMs, USAGE_EXPLAINER_FRESHNESS_MS);
  assert.equal(catalog.pagination.requestField, "cursor");
  assert.equal(
    catalog.plans.find((plan) => plan.id === "current_usage").pageable,
    false,
  );
  assert.deepEqual(
    catalog.plans.find((plan) => plan.id === "period_drivers").periods,
    ["24h", "7d", "30d"],
  );
});

test("freshness coverage refuses an uncovered recent window without reading usage", async () => {
  let usageReads = 0;
  const staleGeneration = {
    ...GENERATION,
    completedAtMs: NOW - 8 * DAY,
  };
  const { service } = createFixtureService({
    generation: staleGeneration,
    readWorkUsage: async () => {
      usageReads += 1;
      return snapshot();
    },
  });
  const result = await service.query(request("current_usage"));
  assert.equal(result.status, "unavailable");
  assert.equal(result.errorCode, "usage_explainer_window_uncovered");
  assert.equal(result.coverage.status, "unavailable");
  assert.equal(result.coverage.sourceKind, "electron_production");
  assert.equal(result.coverage.freshness.status, "stale");
  assert.match(result.limitations.join(" "), /zero rows would not establish zero usage/u);
  assert.equal(usageReads, 0);
});

test("a stale historical all-time result remains available but explicitly partial", async () => {
  const generation = { ...GENERATION, completedAtMs: NOW - DAY };
  const assessment = assessUsageExplanationCoverage({
    request: request("current_usage", { period: "all" }),
    bounds: { fromMs: 0, toMs: NOW },
    generation,
  });
  assert.equal(assessment.status, "partial");
  assert.equal(assessment.freshness.status, "stale");

  const { service } = createFixtureService({ generation });
  const result = await service.query(request("current_usage", { period: "all" }));
  assert.equal(result.status, "available");
  assert.equal(result.coverage.status, "partial");
  assert.match(result.limitations.join(" "), /facts stop at an earlier refresh/u);
});

test("freshness and provenance boundaries fail closed at their exact edges", async () => {
  const fresh = assessUsageExplanationCoverage({
    request: request("current_usage"),
    bounds: { fromMs: NOW - 7 * DAY, toMs: NOW },
    generation: {
      ...GENERATION,
      completedAtMs: NOW - USAGE_EXPLAINER_FRESHNESS_MS,
    },
  });
  assert.equal(fresh.status, "complete");
  assert.equal(fresh.freshness.status, "fresh");

  const stale = assessUsageExplanationCoverage({
    request: request("current_usage"),
    bounds: { fromMs: NOW - 7 * DAY, toMs: NOW },
    generation: {
      ...GENERATION,
      completedAtMs: NOW - USAGE_EXPLAINER_FRESHNESS_MS - 1,
    },
  });
  assert.equal(stale.status, "partial");
  assert.equal(stale.freshness.status, "stale");

  for (const [plan, field, errorCode] of [
    ["current_usage", "usageProvenanceComplete", "usage_explainer_usage_provenance_incomplete"],
    ["allowance_movement", "quotaProvenanceComplete", "usage_explainer_quota_provenance_incomplete"],
  ]) {
    const { service } = createFixtureService({
      generation: { ...GENERATION, [field]: false },
    });
    const result = await service.query(request(plan));
    assert.equal(result.status, "unavailable");
    assert.equal(result.errorCode, errorCode);
    assert.equal(result.coverage.provenance.complete, false);
  }
});

test("tool-only partial provenance does not invalidate complete usage evidence", async () => {
  const generation = {
    ...GENERATION,
    status: "partial",
    blockReason: "tool_provenance_incomplete",
    toolProvenanceComplete: false,
  };
  const { service } = createFixtureService({ generation });
  const usageResult = await service.query(request("current_usage"));
  assert.equal(usageResult.status, "available");
  assert.equal(usageResult.coverage.status, "complete");
  assert.equal(usageResult.coverage.provenance.kind, "usage");
  const healthResult = await service.query(request("data_health"));
  assert.equal(healthResult.status, "available");
  assert.equal(healthResult.coverage.status, "partial");
  assert.equal(healthResult.facts.blockReason, "tool_provenance_incomplete");
  assert.match(healthResult.limitations.join(" "), /own provenance gate/u);
});

test("project counts preserve incomplete attribution and period drivers fail closed", async () => {
  const partialSnapshot = (options) => ({
    ...snapshot(options),
    metadata: {
      ...snapshot(options).metadata,
      status: "partial",
    },
  });
  const { service } = createFixtureService({
    readWorkUsage: async ({ toMs }) => (
      toMs === NOW ? partialSnapshot() : partialSnapshot({ previous: true })
    ),
  });
  const top = await service.query(request("top_work"));
  assert.equal(top.status, "available");
  assert.equal(top.facts.activeProjectCount, null);
  assert.equal(top.facts.attributedProjectCount, 2);
  assert.equal(top.facts.projectAttributionStatus, "partial");
  assert.match(top.limitations.join(" "), /Project attribution is incomplete/u);

  const drivers = await service.query(request("period_drivers"));
  assert.equal(drivers.status, "unavailable");
  assert.equal(drivers.errorCode, "usage_explainer_project_attribution_incomplete");
});

test("page cursors survive separate queries and later-page evidence resolves", async () => {
  let nowMs = NOW;
  const { service } = createFixtureService({ clock: () => nowMs });
  const first = await service.query(request("top_work", { limit: 1 }));
  assert.deepEqual(first.page, {
    offset: 0,
    limit: 1,
    returnedItems: 1,
    totalItems: 2,
  });
  assert.equal(first.items[0].rank, 1);
  assert.equal(first.truncated, true);
  assert.match(first.nextCursor, /^uec1\.top_work\./u);
  assert.equal(parseUsageExplainerCursor(first.nextCursor).offset, 1);

  nowMs += DAY;
  const second = await service.query(request("top_work", {
    limit: 1,
    cursor: first.nextCursor,
  }));
  assert.equal(second.fromMs, first.fromMs);
  assert.equal(second.toMs, first.toMs);
  assert.equal(second.items[0].rank, 2);
  assert.equal(second.items[0].tokens, 110);
  assert.equal(second.nextCursor, null);
  assert.equal(second.truncated, false);

  const evidence = await service.evidence({
    schemaVersion: USAGE_EXPLAINER_SCHEMA_VERSION,
    selector: second.items[0].selector,
  });
  assert.equal(evidence.status, "available");
  assert.equal(evidence.evidence.fact.rank, 2);
  assert.equal(evidence.evidence.fact.tokens, 110);

  assert.throws(
    () => parseUsageExplainerCursor(`${first.nextCursor}x`),
    (error) => error.code === "usage_explainer_cursor_invalid",
  );
  await assert.rejects(
    service.query(request("top_work", { limit: 2, cursor: first.nextCursor })),
    (error) => error.code === "usage_explainer_cursor_invalid",
  );
});

test("forged and changed-generation page cursors fail closed", async () => {
  let generation = GENERATION;
  const codec = createUsageExplainerSelectorCodec({ digest });
  const service = createUsageExplainerService({
    clock: () => NOW,
    readHealth: async () => ({ status: "available", generation }),
    readWorkUsage: async () => snapshot(),
    readAllowance: async () => allowance(),
    loadSelectorCodec: async () => codec,
  });
  const first = await service.query(request("top_work", { limit: 1 }));
  const replacement = first.nextCursor.endsWith("0") ? "1" : "0";
  const forged = `${first.nextCursor.slice(0, -1)}${replacement}`;
  const invalid = await service.query(request("top_work", {
    limit: 1,
    cursor: forged,
  }));
  assert.equal(invalid.status, "unavailable");
  assert.equal(invalid.errorCode, "usage_explainer_cursor_invalid");

  generation = { ...GENERATION, fingerprint: `generation-v2-${"b".repeat(64)}` };
  const stale = await service.query(request("top_work", {
    limit: 1,
    cursor: first.nextCursor,
  }));
  assert.equal(stale.status, "unavailable");
  assert.equal(stale.errorCode, "usage_explainer_cursor_stale");
});

test("all eight plans return bounded content-free facts with honest grades", async () => {
  const { service, codecLoads } = createFixtureService();
  const health = await service.query(request("data_health"));
  const current = await service.query(request("current_usage"));
  assert.equal(codecLoads(), 0, "plans without evidence do not require selector identity");
  assert.equal(health.facts.usageEvents, 5);
  assert.equal(current.facts.tokens, 550);
  assert.equal(current.facts.costUsdExact, "2");

  const top = await service.query(request("top_work"));
  assert.equal(top.items.length, 2);
  assert.equal(top.items[0].tokens, 440);
  assert.equal(top.items[0].subworkerCount, 1);
  assert.match(top.items[0].selector, /^ue1\.top_work\./u);

  const drivers = await service.query(request("period_drivers"));
  assert.equal(drivers.facts.tokenChange, 250);
  assert.equal(drivers.items[0].tokenChange, 340);
  assert.equal(drivers.items[1].tokenChange, -90);

  const models = await service.query(request("model_effort_mix"));
  assert.equal(models.facts.effortCoverage, "unavailable");
  assert.equal(models.items[0].model, "gpt-5.6-sol");
  assert.equal(models.items[0].tokens, 440);

  const pricing = await service.query(request("pricing_coverage"));
  assert.equal(pricing.facts.costUsdExact, "2");
  assert.equal(pricing.items.find((item) => item.model === "gpt-5.6-luna").priceStatus, "complete");

  const delegation = await service.query(request("parent_subworker_usage"));
  assert.equal(delegation.items.length, 1);
  assert.equal(delegation.items[0].primaryTokens, 330);
  assert.equal(delegation.items[0].subworkerTokens, 110);
  assert.equal(delegation.items[0].subworkerShare, 0.25);

  const quota = await service.query(request("allowance_movement"));
  assert.equal(quota.items[0].movementPercentagePoints, 17);
  assert.equal(quota.facts.windowGroupCount, 1);
  assert.equal(quota.facts.observedMovementCount, 1);
  assert.equal(quota.facts.unresolvedWindowCount, 0);
  assert.equal(quota.facts.resetIdentityMissingCount, 0);
  assert.equal(quota.facts.singleObservationCount, 0);
  assert.equal(quota.facts.nonMonotonicCount, 0);
  assert.equal(quota.facts.observedShare, 1);
  assert.match(quota.prohibitedClaims.join(" "), /exactly caused/u);

  for (const result of [health, current, top, drivers, models, pricing, delegation, quota]) {
    const serialized = JSON.stringify(result);
    assert.ok(Buffer.byteLength(serialized) <= USAGE_EXPLAINER_MAX_RESPONSE_BYTES);
    assert.equal(serialized.includes("private-thread"), false);
    assert.equal(serialized.includes("private-project"), false);
    assert.equal(serialized.includes("private-scope"), false);
  }
});

test("evidence resolves one selected fact and preserves model conservation", async () => {
  const { service } = createFixtureService();
  const query = await service.query(request("top_work"));
  const result = await service.evidence({
    schemaVersion: USAGE_EXPLAINER_SCHEMA_VERSION,
    selector: query.items[0].selector,
  });
  assert.equal(result.status, "available");
  assert.equal(result.evidence.fact.tokens, 440);
  assert.equal(result.evidence.details.models.rows.length, 1);
  assert.equal(result.evidence.details.models.rows[0].tokens, 440);
  assert.equal(result.evidence.details.contributions[1].tokens, 110);
  assert.equal(JSON.stringify(result).includes("private-thread"), false);
});

test("every evidence plan resolves without exposing selected local identities", async () => {
  const { service } = createFixtureService();
  for (const plan of Object.values(USAGE_EXPLAINER_PLANS).filter(
    (contract) => contract.evidence,
  )) {
    const explanation = await service.query(request(plan.id));
    assert.ok(explanation.items.length > 0, plan.id);
    const result = await service.evidence({
      schemaVersion: USAGE_EXPLAINER_SCHEMA_VERSION,
      selector: explanation.items[0].selector,
    });
    assert.equal(result.status, "available", plan.id);
    const serialized = JSON.stringify(result);
    for (const canary of ["private-thread", "private-project", "private-scope"]) {
      assert.equal(serialized.includes(canary), false, `${plan.id}: ${canary}`);
    }
  }
});

test("changed generations and forged selectors fail closed", async () => {
  let generation = GENERATION;
  const codec = createUsageExplainerSelectorCodec({ digest });
  const service = createUsageExplainerService({
    clock: () => NOW,
    readHealth: async () => ({ status: "available", generation }),
    readWorkUsage: async () => snapshot(),
    readAllowance: async () => allowance(),
    loadSelectorCodec: async () => codec,
  });
  const result = await service.query(request("top_work"));
  generation = { ...GENERATION, fingerprint: `generation-v2-${"b".repeat(64)}` };
  const stale = await service.evidence({
    schemaVersion: USAGE_EXPLAINER_SCHEMA_VERSION,
    selector: result.items[0].selector,
  });
  assert.equal(stale.status, "unavailable");
  assert.equal(stale.errorCode, "usage_explainer_selector_stale");

  const forged = `${result.items[0].selector.slice(0, -1)}0`;
  const rejected = await service.evidence({
    schemaVersion: USAGE_EXPLAINER_SCHEMA_VERSION,
    selector: forged,
  });
  assert.equal(rejected.status, "unavailable");
  assert.equal(rejected.errorCode, "usage_explainer_selector_stale");
});

test("evidence lookup treats an unreadable current generation as stale", async () => {
  let healthReads = 0;
  const codec = createUsageExplainerSelectorCodec({ digest });
  const service = createUsageExplainerService({
    clock: () => NOW,
    readHealth: async () => {
      healthReads += 1;
      if (healthReads > 1) throw new Error("synthetic read failure");
      return { status: "available", generation: GENERATION };
    },
    readWorkUsage: async () => snapshot(),
    readAllowance: async () => allowance(),
    loadSelectorCodec: async () => codec,
  });
  const result = await service.query(request("top_work"));
  const evidence = await service.evidence({
    schemaVersion: USAGE_EXPLAINER_SCHEMA_VERSION,
    selector: result.items[0].selector,
  });
  assert.equal(evidence.status, "unavailable");
  assert.equal(evidence.errorCode, "usage_explainer_selector_stale");
});

test("response fitting removes whole tail rows and never exceeds its byte cap", () => {
  const envelope = {
    schemaVersion: USAGE_EXPLAINER_SCHEMA_VERSION,
    status: "available",
    items: Array.from({ length: 10 }, (_, index) => ({
      rank: index + 1,
      selector: `selector-${index}`,
      text: "x".repeat(100),
    })),
    truncated: false,
  };
  const fitted = fitUsageExplanationEnvelope(envelope, 450);
  assert.equal(fitted.truncated, true);
  assert.ok(fitted.items.length > 0 && fitted.items.length < envelope.items.length);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= 450);
  assert.throws(
    () => fitUsageExplanationEnvelope({ fixed: "x".repeat(100) }, 10),
    (error) => error.code === "usage_explainer_response_too_large",
  );
});

test("response fitting advances from the last emitted item without skipping", () => {
  const envelope = {
    schemaVersion: USAGE_EXPLAINER_SCHEMA_VERSION,
    status: "available",
    page: { offset: 10, limit: 5, returnedItems: 5, totalItems: 20 },
    items: Array.from({ length: 5 }, (_, index) => ({
      rank: 11 + index,
      text: "x".repeat(100),
    })),
    nextCursor: null,
    truncated: true,
  };
  const fitted = fitUsageExplanationEnvelope(
    envelope,
    480,
    (offset) => `cursor-${offset}`,
  );
  assert.ok(fitted.items.length > 0 && fitted.items.length < 5);
  assert.equal(fitted.page.returnedItems, fitted.items.length);
  assert.equal(fitted.nextCursor, `cursor-${10 + fitted.items.length}`);
  assert.equal(fitted.items.at(-1).rank + 1, 10 + fitted.items.length + 1);
});

test("response fitting fails instead of stranding an oversized page item", () => {
  const envelope = {
    schemaVersion: USAGE_EXPLAINER_SCHEMA_VERSION,
    status: "available",
    page: { offset: 0, limit: 1, returnedItems: 1, totalItems: 2 },
    items: [{ rank: 1, text: "x".repeat(1_000) }],
    nextCursor: null,
    truncated: true,
  };
  assert.throws(
    () => fitUsageExplanationEnvelope(envelope, 300, (offset) => `cursor-${offset}`),
    (error) => error.code === "usage_explainer_response_too_large",
  );
});

test("missing evidence returns a typed unavailable result rather than an invented zero", async () => {
  const codec = createUsageExplainerSelectorCodec({ digest });
  const service = createUsageExplainerService({
    clock: () => NOW,
    readHealth: async () => ({
      status: "unavailable",
      errorCode: "local_unified_index_unavailable",
      generation: null,
      sourceKind: "legacy_cli",
    }),
    readWorkUsage: async () => ({ status: "missing" }),
    readAllowance: async () => ({ status: "unavailable" }),
    loadSelectorCodec: async () => codec,
  });
  const result = await service.query(request("current_usage"));
  assert.equal(result.status, "unavailable");
  assert.equal(result.coverage.sourceKind, "legacy_cli");
  assert.equal(result.facts, null);
  assert.deepEqual(result.items, []);
});

test("allowance row projection preserves incompatible and incomplete movement", () => {
  const base = {
    provider: "openai_codex",
    plan_type: "pro",
    limit_id: "codex",
    duration_mins: 10_080,
    resets_at_ms: NOW + DAY,
    first_observed_at_ms: NOW - DAY,
    last_observed_at_ms: NOW,
    first_used_percent: 10,
    last_used_percent: 25,
    observation_count: 2,
  };
  const rows = projectLocalAllowanceMovementRows([
    base,
    { ...base, resets_at_ms: null },
    { ...base, observation_count: 1 },
    { ...base, first_used_percent: 30, last_used_percent: 20 },
  ]);
  assert.equal(rows[0].movementPercentagePoints, 15);
  assert.equal(rows[0].movementStatus, "observed");
  assert.equal(rows[1].movementPercentagePoints, null);
  assert.equal(rows[1].movementStatus, "reset_identity_missing");
  assert.equal(rows[2].movementStatus, "single_observation");
  assert.equal(rows[3].movementStatus, "non_monotonic");
});
