import {
  REVIEWED_MODEL_CATALOG,
  REVIEWED_MODEL_CATALOG_VERSION,
} from "./model-catalog.js";

// Owner-only aggregate history, not a device upload or entitlement contract.
// Strings are reviewed identities; the remaining fields are aggregate counts
// and API-price-equivalent dollars. No participant or source identifiers enter.
export const ADMIN_MODEL_HISTORY_CATALOG_VERSION = REVIEWED_MODEL_CATALOG_VERSION;
export const LEGACY_ADMIN_MODEL_HISTORY_CATALOG_VERSION = "admin-model-roster-v0.2";
export const PREVIOUS_ADMIN_MODEL_HISTORY_CATALOG_VERSION = "reviewed-model-catalog-2026-09-22.1";
export const OLDER_ADMIN_MODEL_HISTORY_CATALOG_VERSION = "reviewed-model-catalog-2026-09-03.1";
export const ADMIN_MODEL_CONFIG = Object.freeze(REVIEWED_MODEL_CATALOG
  .filter((model) => model.provider === "openai_codex")
  .map((model) => Object.freeze({
    modelId: model.id,
    label: model.label,
    allowanceTrack: model.allowanceTrack,
    pricingStatus: model.pricingStatus,
  })));

const adminHistoryLegacyIds = Object.freeze([
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5",
]);
const adminHistoryCurrentIds = Object.freeze(ADMIN_MODEL_CONFIG
  .filter((model) => model.allowanceTrack === "primary")
  .map((model) => model.modelId));
// Frozen roster for reviewed-model-catalog-2026-09-22.1.
const adminHistoryPreviousIds = Object.freeze([
  "codex-auto-review", "gpt-4-turbo-2024-04-09", "gpt-4.1", "gpt-4.1-mini",
  "gpt-4.1-nano", "gpt-4o", "gpt-4o-2024-05-13", "gpt-4o-mini", "gpt-5",
  "gpt-5-codex", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro", "gpt-5.1",
  "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.2", "gpt-5.2-codex",
  "gpt-5.2-pro", "gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano",
  "gpt-5.4-pro", "gpt-5.5", "gpt-5.5-codex", "gpt-5.5-pro", "gpt-5.6-luna",
  "gpt-5.6-sol", "gpt-5.6-sol-wm", "gpt-5.6-terra", "gpt-6-astra", "o1",
  "o1-pro", "o3", "o3-mini", "o3-pro", "o4-mini", "gpt-6-sol", "gpt-6-luna",
]);
// Frozen roster for reviewed-model-catalog-2026-09-03.1.
const adminHistoryOlderIds = Object.freeze([
  "codex-auto-review", "gpt-4-turbo-2024-04-09", "gpt-4.1", "gpt-4.1-mini",
  "gpt-4.1-nano", "gpt-4o", "gpt-4o-2024-05-13", "gpt-4o-mini", "gpt-5",
  "gpt-5-codex", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro", "gpt-5.1",
  "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.2", "gpt-5.2-codex",
  "gpt-5.2-pro", "gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano",
  "gpt-5.4-pro", "gpt-5.5", "gpt-5.5-codex", "gpt-5.5-pro", "gpt-5.6-luna",
  "gpt-5.6-sol", "gpt-5.6-sol-wm", "gpt-5.6-terra", "gpt-6-astra", "o1",
  "o1-pro", "o3", "o3-mini", "o3-pro", "o4-mini",
]);
const adminHistoryCountKeys = Object.freeze([
  "fittedParticipantCount", "unstableParticipantCount", "staleParticipantCount",
  "refusedParticipantCount", "v1ParticipantCount", "unsupportedSourceParticipantCount",
]);

function adminHistoryRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value : null;
}

function adminHistoryExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function adminHistoryCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function adminHistoryDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === value;
}

/** Closed compact wire DTO. A tuple is [reviewed model ID, dollars, accounts].
 * Missing tuples mean no identified fit only within that day's reviewed roster.
 * Old four-model rows are converted without pretending newer models were seen.
 * When the catalog changes, retain its old version/roster here before shipping.
 */
export function projectAdminModelHistoryDay(value) {
  const input = adminHistoryRecord(value);
  if (!input || !adminHistoryDay(input.day)
      || !adminHistoryCountKeys.every((key) => adminHistoryCount(input[key]))) return null;
  const counts = Object.fromEntries(adminHistoryCountKeys.map((key) => [key, input[key]]));
  if (counts.fittedParticipantCount + counts.unstableParticipantCount
      + counts.staleParticipantCount + counts.refusedParticipantCount
      !== counts.v1ParticipantCount) return null;
  let catalogVersion = input.catalogVersion;
  let values = input.values;
  if (catalogVersion === undefined) {
    if (!adminHistoryExactKeys(input, ["day", "byModel", ...adminHistoryCountKeys])) return null;
    const byModel = adminHistoryRecord(input.byModel);
    if (!byModel || !adminHistoryExactKeys(byModel, adminHistoryLegacyIds)) return null;
    values = [];
    for (const id of adminHistoryLegacyIds) {
      const summary = adminHistoryRecord(byModel[id]);
      if (!summary || !adminHistoryExactKeys(summary, ["capacityUsd", "participantCount"])
          || !adminHistoryCount(summary.participantCount)) return null;
      if (summary.capacityUsd === null) {
        if (summary.participantCount !== 0) return null;
      } else {
        values.push([id, summary.capacityUsd, summary.participantCount]);
      }
    }
    catalogVersion = LEGACY_ADMIN_MODEL_HISTORY_CATALOG_VERSION;
  } else if (!adminHistoryExactKeys(input, ["day", "catalogVersion", "values", ...adminHistoryCountKeys])) {
    return null;
  }
  const ids = catalogVersion === ADMIN_MODEL_HISTORY_CATALOG_VERSION
    ? adminHistoryCurrentIds
    : catalogVersion === PREVIOUS_ADMIN_MODEL_HISTORY_CATALOG_VERSION
      ? adminHistoryPreviousIds
      : catalogVersion === OLDER_ADMIN_MODEL_HISTORY_CATALOG_VERSION
        ? adminHistoryOlderIds
        : catalogVersion === LEGACY_ADMIN_MODEL_HISTORY_CATALOG_VERSION
          ? adminHistoryLegacyIds : null;
  if (!ids || !Array.isArray(values) || values.length > ids.length) return null;
  const allowed = new Set(ids);
  const seen = new Set();
  const projected = [];
  for (const tuple of values) {
    if (!Array.isArray(tuple) || tuple.length !== 3) return null;
    const [id, dollars, participants] = tuple;
    if (!allowed.has(id) || seen.has(id)
        || typeof dollars !== "number" || !Number.isFinite(dollars) || dollars <= 0
        || !adminHistoryCount(participants) || participants < 1
        || participants > counts.fittedParticipantCount) return null;
    seen.add(id);
    projected.push(Object.freeze([id, dollars, participants]));
  }
  projected.sort((left, right) => left[0].localeCompare(right[0], "en"));
  return Object.freeze({
    day: input.day, catalogVersion, values: Object.freeze(projected), ...counts,
  });
}

/** Presentation expansion is local, never persisted in the bounded cache. */
export function expandAdminModelHistoryDay(value) {
  const day = projectAdminModelHistoryDay(value);
  if (day === null) return null;
  const covered = new Set(day.catalogVersion === ADMIN_MODEL_HISTORY_CATALOG_VERSION
    ? adminHistoryCurrentIds
    : day.catalogVersion === PREVIOUS_ADMIN_MODEL_HISTORY_CATALOG_VERSION
      ? adminHistoryPreviousIds
      : day.catalogVersion === OLDER_ADMIN_MODEL_HISTORY_CATALOG_VERSION
        ? adminHistoryOlderIds : adminHistoryLegacyIds);
  const identified = new Map(day.values.map(([id, capacityUsd, participantCount]) => [
    id, Object.freeze({ capacityUsd, participantCount }),
  ]));
  const byModel = Object.freeze(Object.fromEntries(ADMIN_MODEL_CONFIG.map(({ modelId }) => [
    modelId,
    identified.get(modelId) ?? Object.freeze({
      capacityUsd: null,
      participantCount: covered.has(modelId) ? 0 : null,
    }),
  ])));
  return Object.freeze({ ...day, byModel });
}
