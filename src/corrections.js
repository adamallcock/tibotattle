import { createHash } from "node:crypto";
import { stableJson } from "./storage.js";

const CORRECTION_SCHEMA_VERSION = "0.1";
const CORRECTION_KIND = "derived_observation_correction";
const SAFE_IDENTIFIER = /^[a-zA-Z0-9._:-]{1,128}$/;
const SENSITIVE_KEYS = new Set([
  "sessionId",
  "rolloutId",
  "repositoryPath",
  "rawLogPath",
  "prompt",
  "response",
  "toolArguments",
  "apiKey",
  "path",
  "filePath",
  "filename",
  "cwd",
  "url",
]);

function clone(value) {
  return structuredClone(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function digestDerivedValue(value) {
  return `sha256:${sha256(stableJson(value))}`;
}

function validatePrivacy(value, path = "record") {
  if (typeof value === "string") {
    if (/sk-[a-z0-9_-]{6,}/i.test(value)
        || /raw prompt/i.test(value)
        || /\/(?:private|users|home)\//i.test(value)
        || /session-private/i.test(value)) {
      throw new Error(`Sensitive or private value is not allowed in ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validatePrivacy(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key)) throw new Error(`Sensitive or private field ${key} is not allowed in correction provenance`);
    validatePrivacy(nested, `${path}.${key}`);
  }
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function createCorrection({
  correctionId,
  supersedesId,
  reason,
  category,
  createdAt,
  methodVersions,
  originalValueDigest,
  replacementDerived,
  diagnostics,
  sourceInputCoverage,
  operatorNote = null,
  schemaVersion = CORRECTION_SCHEMA_VERSION,
} = {}) {
  if (typeof correctionId !== "string" || !SAFE_IDENTIFIER.test(correctionId)) throw new Error("correctionId must be a safe identifier");
  if (typeof supersedesId !== "string" || !SAFE_IDENTIFIER.test(supersedesId)) throw new Error("supersedesId must be a safe identifier");
  if (typeof reason !== "string" || reason.length === 0) throw new Error("reason is required");
  if (typeof category !== "string" || category.length === 0) throw new Error("category is required");
  if (!validTimestamp(createdAt)) throw new Error("createdAt must be an ISO-compatible timestamp");
  if (!methodVersions || typeof methodVersions !== "object") throw new Error("methodVersions are required");
  if (typeof originalValueDigest !== "string" || originalValueDigest.length === 0) throw new Error("originalValueDigest is required");
  if (!replacementDerived || typeof replacementDerived !== "object") throw new Error("replacementDerived is required");
  if (!diagnostics || typeof diagnostics !== "object") throw new Error("diagnostics are required");
  if (!sourceInputCoverage || typeof sourceInputCoverage !== "object") throw new Error("sourceInputCoverage is required");

  const record = {
    schemaVersion,
    kind: CORRECTION_KIND,
    correctionId,
    supersedesId,
    reason,
    category,
    createdAt: new Date(createdAt).toISOString(),
    methodVersions: clone(methodVersions),
    originalValueDigest,
    replacementDerived: clone(replacementDerived),
    diagnostics: clone(diagnostics),
    sourceInputCoverage: clone(sourceInputCoverage),
    ...(operatorNote === null ? {} : { operatorNote }),
  };
  validatePrivacy(record);
  return record;
}

export function stableCorrectionRecords(records) {
  const byId = new Map();
  for (const record of records) {
    const serialized = stableJson(record);
    const prior = byId.get(record.correctionId);
    if (prior && prior.serialized !== serialized) throw new Error(`Correction ID conflict: ${record.correctionId}`);
    if (!prior) byId.set(record.correctionId, { record: clone(record), serialized });
  }
  return [...byId.values()]
    .sort((left, right) => left.record.correctionId.localeCompare(right.record.correctionId))
    .map(({ record }) => record);
}

function observationId(record) {
  return typeof record?.observationId === "string" ? record.observationId : null;
}

export function extractObservationDerived(record) {
  if (record?.derived && typeof record.derived === "object") return clone(record.derived);
  const windows = Array.isArray(record?.windows) ? record.windows : [];
  if (windows.length === 1) {
    const local = windows[0]?.local ?? {};
    const runcost = local.runcost ?? local.apiPricing ?? {};
    return {
      aggregateTokenTotal: Number.isFinite(runcost.totalTokens) ? runcost.totalTokens : null,
      apiPricedCostUsd: Number.isFinite(runcost.totalUsd) ? runcost.totalUsd : null,
      tokenComponents: clone(runcost.components ?? {}),
      byModel: clone(runcost.byModel ?? {}),
      warnings: Object.keys(runcost.warningCounts ?? {}).sort(),
      diagnostics: clone(local.diagnostics ?? {}),
      pricingBasis: "standard_openai_api_prices_not_codex_subscription_credits",
    };
  }
  return {
    windowCount: windows.length,
    windows: windows.map((window) => {
      const runcost = window?.local?.runcost ?? window?.local?.apiPricing ?? {};
      return {
        aggregateTokenTotal: Number.isFinite(runcost.totalTokens) ? runcost.totalTokens : null,
        apiPricedCostUsd: Number.isFinite(runcost.totalUsd) ? runcost.totalUsd : null,
        warnings: Object.keys(runcost.warningCounts ?? {}).sort(),
      };
    }),
  };
}

function addError(errors, code, details = {}) {
  const candidate = { code, ...details };
  if (!errors.some((error) => stableJson(error) === stableJson(candidate))) errors.push(candidate);
}

function findCycles(correctionsById, errors) {
  const state = new Map();
  const stack = [];
  function visit(id) {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      const cycleStart = stack.indexOf(id);
      addError(errors, "correction_cycle", { correctionIds: [...stack.slice(cycleStart), id] });
      return;
    }
    state.set(id, "visiting");
    stack.push(id);
    const target = correctionsById.get(id)?.supersedesId;
    if (correctionsById.has(target)) visit(target);
    stack.pop();
    state.set(id, "done");
  }
  for (const id of correctionsById.keys()) visit(id);
}

export function resolveCorrections({ originals = [], corrections = [] } = {}) {
  const errors = [];
  const originalsById = new Map();
  for (const original of originals) {
    const id = observationId(original);
    if (!id) continue;
    originalsById.set(id, original);
  }

  const correctionsById = new Map();
  const serializedById = new Map();
  for (const record of corrections) {
    const safeCorrectionId = typeof record?.correctionId === "string" && SAFE_IDENTIFIER.test(record.correctionId)
      ? record.correctionId
      : null;
    if (record?.schemaVersion !== CORRECTION_SCHEMA_VERSION || record?.kind !== CORRECTION_KIND) {
      addError(errors, "incompatible_correction_schema", { correctionId: safeCorrectionId });
      continue;
    }
    if (safeCorrectionId === null || typeof record.supersedesId !== "string" || !SAFE_IDENTIFIER.test(record.supersedesId)) {
      addError(errors, "invalid_correction_identifier", { correctionId: safeCorrectionId });
      continue;
    }
    try {
      validatePrivacy(record);
    } catch {
      addError(errors, "correction_privacy_violation", { correctionId: safeCorrectionId });
      continue;
    }
    const serialized = stableJson(record);
    const prior = serializedById.get(record.correctionId);
    if (prior && prior !== serialized) {
      addError(errors, "correction_id_conflict", { correctionId: record.correctionId });
      continue;
    }
    if (prior) continue;
    serializedById.set(record.correctionId, serialized);
    correctionsById.set(record.correctionId, record);
  }

  for (const record of correctionsById.values()) {
    if (!originalsById.has(record.supersedesId) && !correctionsById.has(record.supersedesId)) {
      addError(errors, "missing_superseded_target", { correctionId: record.correctionId, supersedesId: record.supersedesId });
    }
  }
  findCycles(correctionsById, errors);

  const childrenByTarget = new Map();
  for (const record of correctionsById.values()) {
    const children = childrenByTarget.get(record.supersedesId) ?? [];
    children.push(record);
    childrenByTarget.set(record.supersedesId, children);
  }
  for (const [targetId, children] of childrenByTarget) {
    if (children.length > 1) addError(errors, "branching_correction_conflict", {
      supersedesId: targetId,
      correctionIds: children.map((record) => record.correctionId).sort(),
    });
  }

  const cycleIds = new Set(errors.filter((error) => error.code === "correction_cycle").flatMap((error) => error.correctionIds ?? []));
  const branchTargets = new Set(errors.filter((error) => error.code === "branching_correction_conflict").map((error) => error.supersedesId));
  const effectiveByOriginalId = {};
  const histories = {};
  const originalDerivedByOriginalId = {};

  for (const [id, original] of originalsById) {
    const originalDerived = extractObservationDerived(original);
    originalDerivedByOriginalId[id] = clone(originalDerived);
    let derived = clone(originalDerived);
    let effectiveRecordId = id;
    let targetId = id;
    const chainIds = [id];
    const history = [];
    let conflicted = false;
    const seen = new Set();

    while (childrenByTarget.has(targetId)) {
      if (branchTargets.has(targetId)) {
        conflicted = true;
        break;
      }
      const record = childrenByTarget.get(targetId)[0];
      if (seen.has(record.correctionId) || cycleIds.has(record.correctionId)) {
        conflicted = true;
        break;
      }
      seen.add(record.correctionId);
      const actualDigest = digestDerivedValue(derived);
      if (actualDigest !== record.originalValueDigest) {
        addError(errors, "original_value_digest_mismatch", {
          correctionId: record.correctionId,
          expectedDigest: record.originalValueDigest,
          actualDigest,
        });
        break;
      }
      derived = clone(record.replacementDerived);
      effectiveRecordId = record.correctionId;
      chainIds.push(record.correctionId);
      history.push({
        correctionId: record.correctionId,
        supersedesId: record.supersedesId,
        createdAt: record.createdAt,
        category: record.category,
        reason: record.reason,
        methodVersions: clone(record.methodVersions),
        diagnostics: clone(record.diagnostics),
        sourceInputCoverage: clone(record.sourceInputCoverage),
      });
      targetId = record.correctionId;
    }

    histories[id] = history;
    if (!conflicted) {
      effectiveByOriginalId[id] = {
        originalObservationId: id,
        effectiveRecordId,
        derived,
        chainIds,
      };
    }
  }

  return {
    schemaVersion: "0.3",
    kind: "effective_observation_resolution",
    effectiveByOriginalId,
    originalDerivedByOriginalId,
    histories,
    errors,
    summary: {
      originals: originalsById.size,
      correctionRecords: corrections.length,
      uniqueCompatibleCorrections: correctionsById.size,
      effectiveObservations: Object.keys(effectiveByOriginalId).length,
      conflicts: errors.filter((error) => error.code === "branching_correction_conflict").length,
      errors: errors.length,
    },
  };
}

export function renderCorrectionReport(resolution) {
  const lines = [
    "---",
    "title: Append-only Correction Resolution Report",
    "date: 2026-07-23",
    "type: report",
    "status: complete",
    "---",
    "",
    "# Append-only Correction Resolution Report",
    "",
    `Original observations: ${resolution.summary.originals}. Unique compatible corrections: ${resolution.summary.uniqueCompatibleCorrections}. Resolution errors: ${resolution.summary.errors}.`,
    "",
    "Corrections replace derived views only. Original observations and raw provider/client logs are not rewritten, and provider quota fields are not altered by the replay migration.",
    "",
    "## Original derived values",
    "",
    "```json",
    JSON.stringify(resolution.originalDerivedByOriginalId, null, 2),
    "```",
    "",
    "## Effective derived values",
    "",
    "```json",
    JSON.stringify(resolution.effectiveByOriginalId, null, 2),
    "```",
    "",
    "## Correction history",
    "",
  ];
  for (const [id, history] of Object.entries(resolution.histories)) {
    lines.push(`### ${id}`, "");
    if (history.length === 0) lines.push("- No correction.", "");
    else for (const record of history) {
      lines.push(
        `- ${record.correctionId} supersedes ${record.supersedesId}: ${record.reason}`,
        "",
        "```json",
        JSON.stringify({
          methodVersions: record.methodVersions,
          diagnostics: record.diagnostics,
          sourceInputCoverage: record.sourceInputCoverage,
        }, null, 2),
        "```",
        "",
      );
    }
  }
  if (resolution.errors.length > 0) {
    lines.push("## Resolution errors", "", "```json", JSON.stringify(resolution.errors, null, 2), "```", "");
  }
  return `${lines.join("\n")}\n`;
}

export {
  CORRECTION_KIND,
  CORRECTION_SCHEMA_VERSION,
};
