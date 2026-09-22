import { createValidatedSnapshotStore } from "./platform/index.js";

export const AUTHORITATIVE_DASHBOARD_SNAPSHOT_SCHEMA_VERSION =
  "local-authoritative-dashboard-snapshot-v1";
export const MAXIMUM_AUTHORITATIVE_DASHBOARD_SNAPSHOT_BYTES =
  16 * 1024 * 1024;

const COMPANION_SCHEMA_VERSION = "local-companion-v0.1";
// Keep this closed list aligned with buildLocalCompanionSnapshot's public
// top-level projection. HTML reports are served by dedicated loopback routes;
// they are not part of the retained dashboard snapshot.
const EXPECTED_SNAPSHOT_KEYS = Object.freeze([
  "schemaVersion",
  "mode",
  "generatedAt",
  "overview",
  "gradient",
  "weekly",
  "quality",
]);
const TYPED_TOOL_HISTORY_WARNING =
  "Usage accounting is complete, but typed tool history is partial. Tool totals are withheld rather than reported as zero.";
const TOOL_CLASS_KEYS = Object.freeze([
  "apply_patch",
  "local_shell",
  "other",
  "subagent",
  "tool_gateway",
]);

function canonicalInstant(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return new Date(value).toISOString() === value ? value : null;
}

function exactToolValues(value, expected) {
  const counts = value?.counts;
  return value?.total === expected
    && counts && typeof counts === "object" && !Array.isArray(counts)
    && TOOL_CLASS_KEYS.every((key) => counts[key] === expected)
    && Object.keys(counts).every((key) => TOOL_CLASS_KEYS.includes(key));
}

function typedToolGap(snapshot) {
  const overview = snapshot?.overview;
  const accounting = overview?.accounting;
  const history = overview?.timeline?.history;
  const declared = history?.status === "partial"
    && [undefined, "typed_tool_history_partial"].includes(history.reason)
    && Array.isArray(overview?.warnings)
    && overview.warnings.includes(TYPED_TOOL_HISTORY_WARNING);
  if (!declared) return null;
  const safelyWithheld = overview?.activity?.toolEvents === null
    && overview?.tools?.status === "unavailable"
    && overview.tools.reason === "typed_tool_history_partial"
    && exactToolValues(overview.tools, null)
    && accounting?.toolClasses?.status === "unavailable"
    && accounting.toolClasses.reason === "typed_tool_history_partial"
    && exactToolValues(accounting.toolClasses, null);
  // v0.1.16 used numeric zero placeholders beside the explicit withholding
  // warning. Accept that trusted in-process shape only so it can be
  // canonicalized before persistence; a retained receipt never contains or
  // re-publishes those zeroes.
  const legacyZeroPlaceholders = overview?.activity?.toolEvents === 0
    && [undefined, "unavailable"].includes(overview?.tools?.status)
    && [undefined, "typed_tool_history_partial"].includes(
      overview?.tools?.reason,
    )
    && exactToolValues(overview?.tools, 0)
    && [undefined, "unavailable"].includes(accounting?.toolClasses?.status)
    && [undefined, "typed_tool_history_partial"].includes(
      accounting?.toolClasses?.reason,
    )
    && exactToolValues(accounting?.toolClasses, 0);
  return safelyWithheld || legacyZeroPlaceholders
    ? { safelyWithheld, legacyZeroPlaceholders }
    : null;
}

function snapshotForPersistence(snapshot) {
  const gap = typedToolGap(snapshot);
  if (gap?.legacyZeroPlaceholders !== true) return snapshot;
  const canonical = structuredClone(snapshot);
  const withheld = {
    status: "unavailable",
    reason: "typed_tool_history_partial",
    total: null,
    counts: Object.fromEntries(TOOL_CLASS_KEYS.map((key) => [key, null])),
  };
  canonical.overview.timeline.history.reason = "typed_tool_history_partial";
  canonical.overview.activity.toolEvents = null;
  canonical.overview.tools = structuredClone(withheld);
  canonical.overview.accounting.toolClasses = structuredClone(withheld);
  return canonical;
}

/**
 * The only snapshots eligible for persistence. A complete, generation-bound
 * unified publication may legitimately contain zero usage; the attestation
 * fields distinguish that true empty state from the zero placeholders a
 * failed/partial projection produces.
 */
export function isAuthoritativeDashboardSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return false;
  }
  if (Object.keys(snapshot).sort().join("\0")
      !== [...EXPECTED_SNAPSHOT_KEYS].sort().join("\0")
      || snapshot.schemaVersion !== COMPANION_SCHEMA_VERSION
      || snapshot.mode !== "real_local_evidence"
      || canonicalInstant(snapshot.generatedAt) === null) {
    return false;
  }
  const overview = snapshot.overview;
  const accounting = overview?.accounting;
  const projection = accounting?.projection;
  const history = overview?.timeline?.history;
  const historyCoverage = accounting?.historyCoverage;
  const generation = accounting?.generation;
  const fingerprint = accounting?.generationFingerprint;
  const generationPresent = (
    (Number.isSafeInteger(generation) && generation >= 1)
    || (typeof generation === "string" && generation.length > 0)
  );
  const toolGap = typedToolGap(snapshot);
  const timelineAuthoritative = history?.status === "complete"
    || (history?.status === "partial"
      && toolGap !== null);
  return overview && typeof overview === "object" && !Array.isArray(overview)
    && accounting && typeof accounting === "object"
    && projection?.status === "available"
    && projection.reason === null
    && projection.terminal === false
    && accounting.sourceMode === "unified"
    && accounting.generationMatched === true
    && generationPresent
    && typeof fingerprint === "string"
    && fingerprint.length > 0
    && accounting.sourceCoverageStatus === "complete"
    && accounting.accountingCacheStatus === "available"
    && timelineAuthoritative
    && historyCoverage?.status === "complete"
    && historyCoverage.phase === "complete";
}

/** Read a previously persisted authoritative projection, or null. */
export async function readAuthoritativeDashboardSnapshot({ snapshotFile } = {}) {
  return createValidatedSnapshotStore({
    snapshotFile,
    schemaVersion: AUTHORITATIVE_DASHBOARD_SNAPSHOT_SCHEMA_VERSION,
    validate: isAuthoritativeDashboardSnapshot,
    maximumBytes: MAXIMUM_AUTHORITATIVE_DASHBOARD_SNAPSHOT_BYTES,
  }).read();
}

/** Atomically replace the last good projection with a complete candidate. */
export async function writeAuthoritativeDashboardSnapshot({
  snapshotFile,
  snapshot,
  now = () => Date.now(),
} = {}) {
  if (!isAuthoritativeDashboardSnapshot(snapshot)) return false;
  return createValidatedSnapshotStore({
    snapshotFile,
    schemaVersion: AUTHORITATIVE_DASHBOARD_SNAPSHOT_SCHEMA_VERSION,
    validate: isAuthoritativeDashboardSnapshot,
    maximumBytes: MAXIMUM_AUTHORITATIVE_DASHBOARD_SNAPSHOT_BYTES,
    now,
  }).write(snapshotForPersistence(snapshot));
}
