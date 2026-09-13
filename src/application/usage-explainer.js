import {
  USAGE_EXPLAINER_MAX_RESPONSE_BYTES,
  USAGE_EXPLAINER_MAX_ROWS,
  USAGE_EXPLAINER_PLANS,
  USAGE_EXPLAINER_SCHEMA_VERSION,
  assessUsageExplanationCoverage,
  projectUsageExplanation,
  parseUsageExplainerCursor,
  unavailableUsageExplanation,
  usageExplanationCatalog,
  usageExplanationBounds,
  validateUsageExplanationFixedBounds,
  validateUsageExplanationRequest,
} from "../reporting/index.js";

export {
  USAGE_EXPLAINER_SCHEMA_VERSION,
  usageExplanationCatalog,
};

const EVIDENCE_KEYS = new Set(["schemaVersion", "selector"]);

function explanationError(code) {
  return Object.assign(new Error(code), { code });
}

function serializedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function fitUsageExplanationEnvelope(
  envelope,
  maximumBytes = USAGE_EXPLAINER_MAX_RESPONSE_BYTES,
  cursorForOffset = null,
) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("maximumBytes must be a positive safe integer");
  }
  const items = Array.isArray(envelope.items) ? [...envelope.items] : null;
  if (items !== null) {
    const originalItemCount = items.length;
    while (true) {
      const bounded = { ...envelope, items };
      if (envelope.page !== undefined) {
        const nextOffset = envelope.page.offset + items.length;
        const hasMore = nextOffset < envelope.page.totalItems;
        bounded.page = {
          ...envelope.page,
          returnedItems: items.length,
        };
        bounded.nextCursor = hasMore && items.length > 0
          ? cursorForOffset?.(nextOffset) ?? null
          : null;
        bounded.truncated = envelope.truncated
          || hasMore
          || items.length < originalItemCount;
      } else if (items.length < originalItemCount) {
        bounded.truncated = true;
      }
      if (serializedBytes(bounded) <= maximumBytes) {
        if (envelope.page !== undefined && originalItemCount > 0 && items.length === 0) {
          break;
        }
        return bounded;
      }
      if (items.length === 0) break;
      items.pop();
    }
  }
  if (serializedBytes(envelope) <= maximumBytes) return envelope;
  throw explanationError("usage_explainer_response_too_large");
}

function validateEvidenceRequest(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).some((key) => !EVIDENCE_KEYS.has(key))
    || value.schemaVersion !== USAGE_EXPLAINER_SCHEMA_VERSION
    || typeof value.selector !== "string"
    || value.selector.length < 1
    || value.selector.length > 240
  ) {
    throw explanationError("usage_explainer_evidence_invalid");
  }
  return Object.freeze({ ...value });
}

function availableGeneration(health) {
  const generation = health?.generation;
  return health?.status === "available"
    && generation !== null
    && typeof generation === "object"
    && ["complete", "partial"].includes(generation.status)
    && typeof generation.fingerprint === "string"
    && generation.fingerprint.length > 0;
}

function sourceAvailable(source) {
  return source?.status === "available"
    && source.generation !== null
    && typeof source.generation === "object"
    && typeof source.generation.fingerprint === "string";
}

function sourceMatchesGeneration(source, fingerprint) {
  return sourceAvailable(source) && source.generation.fingerprint === fingerprint;
}

function fixedErrorCode(error, fallback) {
  return typeof error?.code === "string" && /^[a-z][a-z0-9_]{0,99}$/u.test(error.code)
    ? error.code
    : fallback;
}

export function createUsageExplainerService({
  readHealth,
  readWorkUsage,
  readAllowance,
  loadSelectorCodec,
  clock = Date.now,
  maximumResponseBytes = USAGE_EXPLAINER_MAX_RESPONSE_BYTES,
} = {}) {
  for (const [name, implementation] of [
    ["readHealth", readHealth],
    ["readWorkUsage", readWorkUsage],
    ["readAllowance", readAllowance],
    ["loadSelectorCodec", loadSelectorCodec],
  ]) {
    if (typeof implementation !== "function") {
      throw new TypeError(`${name} must be a function`);
    }
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  async function build(request, bounds, { pageOffset = 0, cursor = null } = {}) {
    let health;
    try {
      health = await readHealth();
    } catch (error) {
      return {
        output: unavailableUsageExplanation(
          request,
          bounds,
          fixedErrorCode(error, "usage_explainer_unavailable"),
        ),
        evidence: new Map(),
        codec: null,
      };
    }
    if (!availableGeneration(health)) {
      return {
        output: unavailableUsageExplanation(
          request,
          bounds,
          health?.errorCode ?? "usage_explainer_index_unavailable",
          { health },
        ),
        evidence: new Map(),
        codec: null,
      };
    }
    if (request.plan === "data_health") {
      const projected = projectUsageExplanation({
        request,
        bounds,
        health,
        selectorFor: null,
      });
      return { output: projected.envelope, evidence: projected.evidence, codec: null };
    }

    const coverage = assessUsageExplanationCoverage({
      request,
      bounds,
      generation: health.generation,
    });
    if (coverage.status === "unavailable") {
      return {
        output: unavailableUsageExplanation(
          request,
          bounds,
          coverage.errorCode ?? "usage_explainer_window_uncovered",
          { health },
        ),
        evidence: new Map(),
        codec: null,
      };
    }

    const fingerprint = health.generation.fingerprint;
    let current;
    let previous = null;
    let previousBounds = null;
    let allowance = null;
    let codec = null;
    try {
      codec = USAGE_EXPLAINER_PLANS[request.plan].evidence
        ? await loadSelectorCodec()
        : null;
      if (cursor !== null) {
        codec.verifyCursor(cursor, {
          plan: request.plan,
          period: request.period,
          limit: request.limit,
          generationFingerprint: fingerprint,
        });
      }
      if (request.plan === "allowance_movement") {
        allowance = await readAllowance({
          ...bounds,
          offset: pageOffset,
          limit: request.limit,
        });
        if (allowance?.status !== "available") {
          return {
            output: unavailableUsageExplanation(
              request,
              bounds,
              allowance?.errorCode ?? "usage_explainer_allowance_unavailable",
              { health },
            ),
            evidence: new Map(),
            codec: null,
          };
        }
      } else {
        current = await readWorkUsage(bounds);
        if (!sourceAvailable(current)) {
          return {
            output: unavailableUsageExplanation(
              request,
              bounds,
              current?.errorCode ?? `usage_explainer_work_${current?.status ?? "unavailable"}`,
              { current, health },
            ),
            evidence: new Map(),
            codec: null,
          };
        }
        if (request.plan === "period_drivers") {
          const duration = bounds.toMs - bounds.fromMs;
          previousBounds = {
            fromMs: Math.max(0, bounds.fromMs - duration),
            toMs: bounds.fromMs,
          };
          previous = await readWorkUsage(previousBounds);
          if (!sourceAvailable(previous)) {
            return {
              output: unavailableUsageExplanation(
                request,
                bounds,
                previous?.errorCode ?? "usage_explainer_previous_window_unavailable",
                { current, health },
              ),
              evidence: new Map(),
              codec: null,
            };
          }
          if (
            current.metadata?.status !== "available"
            || previous.metadata?.status !== "available"
          ) {
            return {
              output: unavailableUsageExplanation(
                request,
                bounds,
                "usage_explainer_project_attribution_incomplete",
                {
                  current,
                  health,
                  limitations: [
                    "Period drivers require complete project attribution in both equal windows.",
                  ],
                },
              ),
              evidence: new Map(),
              codec: null,
            };
          }
        }
      }
      if (
        (current && !sourceMatchesGeneration(current, fingerprint))
        || (previous && !sourceMatchesGeneration(previous, fingerprint))
        || (allowance && allowance.generation?.fingerprint !== fingerprint)
      ) {
        return {
          output: unavailableUsageExplanation(
            request,
            bounds,
            "usage_explainer_generation_changed",
            { current, health },
          ),
          evidence: new Map(),
          codec: null,
        };
      }
      const projected = projectUsageExplanation({
        request,
        bounds,
        previousBounds,
        current,
        previous,
        allowance,
        health,
        selectorFor: codec?.create ?? null,
        offset: pageOffset,
      });
      return {
        output: projected.envelope,
        evidence: projected.evidence,
        codec,
        cursorForOffset: USAGE_EXPLAINER_PLANS[request.plan].pageable !== true
          ? null
          : (offset) => (
          codec.createCursor({
            plan: request.plan,
            period: request.period,
            fromMs: bounds.fromMs,
            toMs: bounds.toMs,
            generationFingerprint: fingerprint,
            limit: request.limit,
            offset,
          })
          ),
      };
    } catch (error) {
      return {
        output: unavailableUsageExplanation(
          request,
          bounds,
          fixedErrorCode(error, "usage_explainer_unavailable"),
          { current, health },
        ),
        evidence: new Map(),
        codec: null,
      };
    }
  }

  return Object.freeze({
    async query(input) {
      const request = validateUsageExplanationRequest(input);
      const nowMs = clock();
      const cursor = request.cursor === null
        ? null
        : parseUsageExplainerCursor(request.cursor);
      if (cursor !== null && (
        cursor.plan !== request.plan
        || cursor.period !== request.period
        || cursor.limit !== request.limit
      )) {
        throw explanationError("usage_explainer_cursor_invalid");
      }
      let bounds;
      if (cursor === null) {
        bounds = usageExplanationBounds(request, nowMs);
      } else {
        try {
          bounds = validateUsageExplanationFixedBounds(request, cursor, nowMs);
        } catch {
          throw explanationError("usage_explainer_cursor_invalid");
        }
      }
      const result = await build(request, bounds, {
        pageOffset: cursor?.offset ?? 0,
        cursor,
      });
      return fitUsageExplanationEnvelope(
        result.output,
        maximumResponseBytes,
        result.cursorForOffset,
      );
    },

    async evidence(input) {
      const request = validateEvidenceRequest(input);
      let codec;
      let selector;
      try {
        codec = await loadSelectorCodec();
        selector = codec.parse(request.selector);
      } catch (error) {
        throw explanationError(
          error?.code === "usage_explainer_selector_invalid"
            ? error.code
            : "usage_explainer_evidence_invalid",
        );
      }
      const nowMs = clock();
      const query = validateUsageExplanationRequest({
        schemaVersion: USAGE_EXPLAINER_SCHEMA_VERSION,
        plan: selector.plan,
        period: selector.period,
        limit: 1,
      });
      const bounds = validateUsageExplanationFixedBounds(query, selector, nowMs);
      let health;
      try {
        health = await readHealth();
      } catch {
        return fitUsageExplanationEnvelope(
          unavailableUsageExplanation(query, bounds, "usage_explainer_selector_stale"),
          maximumResponseBytes,
        );
      }
      if (!availableGeneration(health)
          || codec.generationTag(health.generation.fingerprint) !== selector.generationTag) {
        return fitUsageExplanationEnvelope(
          unavailableUsageExplanation(query, bounds, "usage_explainer_selector_stale"),
          maximumResponseBytes,
        );
      }
      const result = await build(query, bounds, { pageOffset: selector.rank - 1 });
      if (result.output.status !== "available") {
        return fitUsageExplanationEnvelope(result.output, maximumResponseBytes);
      }
      const selected = result.evidence.get(request.selector);
      if (selected === undefined) {
        return fitUsageExplanationEnvelope(
          unavailableUsageExplanation(query, bounds, "usage_explainer_selector_stale"),
          maximumResponseBytes,
        );
      }
      const output = {
        schemaVersion: USAGE_EXPLAINER_SCHEMA_VERSION,
        status: "available",
        plan: query.plan,
        selector: request.selector,
        fromMs: bounds.fromMs,
        toMs: bounds.toMs,
        coverage: result.output.coverage,
        evidence: selected,
        limitations: result.output.limitations,
        prohibitedClaims: [...USAGE_EXPLAINER_PLANS[query.plan].prohibitedClaims],
        truncated: false,
      };
      return fitUsageExplanationEnvelope(output, maximumResponseBytes);
    },
  });
}
