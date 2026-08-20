import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanCodexLogEvents } from "./codex-log-scan.js";
import {
  defaultLocalUnifiedIndexPath,
  openLocalUnifiedIndex,
  readUnifiedIndexGenerationDescriptor,
} from "./local-unified-index.js";
import { declaredSpeedModeAt } from "./codex-speed-baseline.js";
import {
  createIndexedCodexLogScan,
  defaultLocalAnalysisIndexSecretPath,
} from "./local-analysis-index.js";
import { createLocalUnifiedAccountingSource } from "./local-unified-accounting-source.js";
import {
  CODEX_TRANSITION_DERIVATION_CEILINGS,
  deriveCodexTransitionSeriesCooperatively,
  PARSER_VERSION,
} from "./codex-transition-miner.js";
import { validAbortSignal } from "./valid-abort-signal.js";
import {
  codexModelAllowanceTrack,
  codexModelApiPriceEquivalentApplicable,
  codexModelPricingStatus,
  OPENAI_CODEX_SPARK_MODEL_ID,
  recognizedCodexModelId,
} from "./export/index.js";
import {
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  createExportResourceGuard,
  ExportResourceLimitError,
} from "./export-resource-policy.js";
import {
  addUsdStrings,
  costWarningCodes,
  emptySpeedWeightingCrossing,
  fastModeModelFamilyKey,
  priceCodexUsageEvent,
  APP_PRICE_REGISTRY_MANIFEST,
} from "@app-usagemonitor/accounting";
import { codexPrimaryAllowanceBasis } from "./codex-primary-allowance-basis.js";
import {
  analyzeQuotaPace,
  blendedCompositionCapacityUsd,
  buildCompositionObservations,
  calibrateCompositionCapacities,
  isValidQuotaWindowDuration,
  MODEL_COMPOSITION_POLICY,
  SEVEN_DAY_WINDOW_MINUTES,
} from "@app-usagemonitor/quota-analysis";
import { TELEMETRY_PLAN_TYPES } from "@app-usagemonitor/telemetry-contract";
import {
  addComponentCosts,
  emptyComponentCosts,
  SPARK_QUOTA_LIMIT_IDS,
} from "./local-companion-usage-model.js";
import {
  defaultLocalCollectorStatePath,
  prepareLocalCollectorState,
  readLocalCollectorAccountingCache,
  writeLocalCollectorAccountingCache,
} from "./local-collector-state.js";
import { stableJson } from "./storage.js";
import {
  BOUNDED_WEEKLY_CALIBRATION_RESET_LIMIT,
  projectBoundedWeeklyCalibrationSummary,
} from "./reporting/index.js";
import { fastQuotaMultiplier } from "./application/index.js";

// v0.4 added per-model allowance-track and API-price-applicability state, and
// the combined `modelUsage` row set. v0.5 (2026-08-08) sources the weekly
// calibration transition corpus from the unified local index when one is
// present — the corpus then spans the whole indexed history rather than the
// scan window — and records that provenance in `weeklyCalibrationInput.source`
// and `.coveredAt`. A v0.4 cache's calibration was silently bounded by its
// scan window, so it is withheld and rebuilt rather than shown as full
// history.
// v0.6: quota-track identity became slot-agnostic (keyed on limitId +
// duration). A v0.5 cache derived its weekly calibration with pre-Jul-12
// history filtered out by slot, so it is withheld and rebuilt rather than
// blended with the restored corpus.
// v0.7 (2026-08-11): the weekly calibration gained the composition-aware
// per-model $/pp vector (`weeklyCalibration.composition`, NNLS over the same
// corpus — design: docs/design/composition-aware-expected-line.md). A v0.6
// cache carries no composition block and its expected line silently misreads
// model mix as deviation, so it is withheld and rebuilt rather than served
// alongside surfaces that now assume the fit can exist.
// v0.8 (2026-08-11): the scan retains Spark quota snapshots under every id in
// SPARK_QUOTA_LIMIT_IDS. A v0.7 cache matched the reserved marketing token
// ("codex-spark") only, while real captures report "codex_bengalfox", so its
// `sparkQuotaTimeline` is empty against every capture to date; it is withheld
// and rebuilt rather than served as evidence that no Spark quota history
// exists.
// v0.9 (2026-08-17): each 15-minute usage bucket retains a sparse observed and
// declared speed/model-family crossing, and the cache carries independently
// fitted unresolved-as-Standard and unresolved-as-Fast weekly capacities.
// Allowance-facing readers can therefore couple every weighted numerator to a
// denominator derived under the same scenario without replaying raw events.
// v0.10 (2026-08-17): production refreshes select the unified typed index by
// default, record the source/generation/context contract, and attach a
// separate full-history period. A v0.9 cache cannot prove which scanner or
// generation produced its totals, so it is withheld and rebuilt.
// v0.11 (2026-08-19): the retained pace forecast names its two rates
// separately and its ETA follows the wall-clock one. A v0.10 cache carries a
// single `percentagePointsPerHour` whose ETA assumed the reader never paused,
// so it is withheld and rebuilt rather than reinterpreted.
// v0.12 (2026-08-19): every `byModel` row carries its own token components and
// per-component priced cost, so the model table and the component bars are the
// two margins of one crossing that can now be read cell by cell. A v0.11 row
// holds only its totals, and the missing cells cannot be recovered by dividing
// them, so the cache is withheld and rebuilt rather than served with the
// components silently absent.
export const REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION =
  "local-replay-safe-accounting-v0.12";
const ALLOWANCE_CAPACITY_SCHEMA_VERSION =
  "codex-primary-allowance-capacity-v0.1";
const ALLOWANCE_SCENARIO_CANDIDATES = Object.freeze({
  unresolved_as_standard: "speed_lower",
  unresolved_as_fast: "speed_upper",
});

export const REPLAY_SAFE_ACCOUNTING_SOURCE_MODES = Object.freeze([
  "unified",
  "legacy",
]);

export const REPLAY_SAFE_ACCOUNTING_CONTEXT_BEHAVIORS = Object.freeze([
  "legacy_zero",
  "source_native",
]);

const DEFAULT_ACCOUNTING_CONTEXT_BEHAVIOR = "legacy_zero";
const SOURCE_DESCRIPTOR_VERSION = "local-accounting-source-descriptor-v1";
const GENERATION_TOKEN = /^[A-Za-z0-9._:-]{1,256}$/u;
const ACCOUNTING_SOURCE_ERROR_CODES = Object.freeze({
  local_unified_index_missing: "accounting_unified_index_missing",
  local_unified_index_unavailable: "accounting_unified_index_unavailable",
  local_unified_index_file_invalid: "accounting_unified_index_unavailable",
  local_unified_index_file_changed: "accounting_unified_generation_changed",
  local_unified_index_schema_invalid: "accounting_unified_index_incompatible",
  local_unified_index_compatibility_invalid: "accounting_unified_index_incompatible",
  local_unified_index_meta_invalid: "accounting_unified_index_invalid",
  local_unified_index_row_invalid: "accounting_unified_index_invalid",
  local_unified_index_accounting_coverage_incomplete:
    "accounting_unified_coverage_incomplete",
  local_unified_index_generation_mismatch:
    "accounting_unified_generation_mismatch",
  local_unified_index_read_aborted: "accounting_refresh_aborted",
  local_unified_index_callback_failed: "accounting_unified_callback_failed",
  local_unified_index_read_failed: "accounting_unified_read_failed",
});

const HISTORICAL_PRICE_EPOCH_BASIS =
  "event_time_when_registry_has_effective_evidence";

const MAX_CACHE_BYTES = 16 * 1024 * 1024;
// Standing owner rule (2026-08-08, stated after five rounds of cap-shuffling):
// NEVER introduce or retain small data-window caps. A history limit is either
// absent or extreme (365+ days), never convenience-sized — 31 and 93 were
// both wrong. The floor makes a convenience-sized window unrepresentable; the
// ceiling is a ten-year typo guard, not a data-window policy.
const MINIMUM_WINDOW_DAYS = 365;
const MAXIMUM_WINDOW_DAYS = 3_653;
const DEFAULT_WINDOW_DAYS = MINIMUM_WINDOW_DAYS;
const TIMELINE_BUCKET_MS = 15 * 60 * 1_000;
const MAX_QUOTA_TIMELINE_ROWS = 10_000;
const WEEKLY_WINDOW_MINUTES = SEVEN_DAY_WINDOW_MINUTES;
const SPARK_MODEL = OPENAI_CODEX_SPARK_MODEL_ID;
const PACE_CURRENT_MAX_AGE_MS = 30 * 60_000;
const PACE_STATUSES = new Set([
  "unavailable",
  "insufficient_observations",
  "available",
  "will_reach_reset_first",
]);
const ACCOUNT_SCOPE_ID_PATTERN = /^openai-account:v1:[A-Za-z0-9_-]{43}$/u;
const ACCOUNT_TRACK_ID_PATTERN = /^account-track:v1:[a-f0-9]{64}$/u;
const MAX_RETAINED_TRANSITION_BYTES = 320 * 1024 * 1024;
// Absolute whole-process RSS TARGET for one accounting rebuild. Raised
// 1.5 -> 2 GiB on owner directive (2026-08-11) after a live 0.1.6 incident:
// the transition-mining pass tripped at ~1.6 GB whole-process RSS on a
// companion whose baseline idles near ~800 MB, and the throw hard-failed the
// entire refresh — blanking the dashboard and flip-flopping every 5 minutes
// as the scheduler re-ran the doomed pass. This ceiling is a TARGET, not a
// hard blocker: a miss degrades to a retained-cache soft-fail rather than
// failing the refresh (see refreshReplaySafeAccountingCache and
// ACCOUNTING_BUDGET_MISS_CODES). It remains the backstop that stops the pass
// before it can OOM the process.
//
// HELD at 2 GiB on 2026-08-20, against a proposal to raise it to 6 GiB. The
// evidence for that raise — 26 consecutive
// accounting_transition_rss_limit_exceeded deferrals from 2026-08-18T19:28 on
// a 572,089-event / 128.5 GB / 4,880-source corpus — predates the rebuild's
// move into a short-lived child, and every one of those deferrals was the
// COMPANION's own ~1.9 GiB post-indexing baseline eating the budget before the
// pass began, not the pass outgrowing it. Isolation is what cures that (see
// ACCOUNTING_REBUILD_ISOLATION_MODES); the ceiling was never the binding
// constraint. Re-measured in the child against an owner-shaped corpus
// (572,000 events / 25,870 transitions / 130 weekly windows), the rebuild
// peaks at 485 MiB of RSS GROWTH over a clean baseline even with an
// effectively unbounded heap, so the effective child ceiling
// (min(this, baseline + ACCOUNTING_RSS_DELTA_BUDGET_BYTES) ~ 1.3 GiB) already
// carries ~2.7x the measured need. Raising it further would only lift the
// ceiling above the child's own V8 heap cap, which is exactly what converts an
// honest deferral into a crash — see ACCOUNTING_REBUILD_CHILD_OLD_SPACE_MIB,
// which is derived from this constant so the two cannot drift apart.
const MAX_ACCOUNTING_RSS_BYTES = Math.floor(2 * 1024 * 1024 * 1024);
// What one accounting rebuild may itself ADD to process RSS over the baseline
// captured at build start. The effective ceiling is
// min(MAX_ACCOUNTING_RSS_BYTES, baselineRss + this delta), so the delta must
// be large enough that a NORMAL baseline reaches the absolute target rather
// than capping the pass below it. The old 512 MiB delta is exactly what made
// the 2026-08-11 incident inevitable: with the ~800 MB live baseline it capped
// the build at ~1.3 GB — BELOW the 1.6 GB the pass actually needed — so the
// miss was structural, not a real leak. Raised to 1.25 GiB so a typical
// baseline lands on the absolute target (min(2 GiB, 800 MB + 1.25 GiB =
// 2.05 GiB) = 2 GiB), while MAX_ACCOUNTING_RSS_BYTES stays the absolute
// backstop against a leaking baseline.
//
// HELD at 1.25 GiB on 2026-08-20 alongside the absolute target. Since the
// rebuild moved into a child this delta is what actually BINDS: off the
// child's clean baseline the effective ceiling is baseline + 1.25 GiB ~
// 1.3 GiB, below the 2 GiB absolute. Measured need in that child is 485 MiB of
// growth at owner scale, so the delta is ~2.6x the measured climb — enough
// that a real corpus never trips it, tight enough that a regression back to
// O(corpus) residency still does.
const ACCOUNTING_RSS_DELTA_BUDGET_BYTES = Math.floor(1.25 * 1024 * 1024 * 1024);
// A memory-budget miss — whole-process RSS over the effective ceiling, the
// scan guard's own RSS trip, or the per-row retained-byte meter over budget —
// is a soft TARGET miss, not a hard failure. refreshReplaySafeAccountingCache
// catches exactly these codes, retains the last good on-disk cache untouched,
// and reports a degraded/deferred outcome instead of throwing and blanking the
// dashboard. Every OTHER accounting_* stop (input-count ceilings, source-size
// safety stops, aborts, measurement-invalid) stays hard by design.
const ACCOUNTING_BUDGET_MISS_CODES = new Set([
  "accounting_transition_rss_limit_exceeded",
  "accounting_transition_memory_budget_exceeded",
  "accounting_scan_rss_limit_exceeded",
]);
const ACCOUNTING_READER_PASSTHROUGH_CODES = new Set([
  ...Object.values(ACCOUNTING_SOURCE_ERROR_CODES),
  "accounting_refresh_aborted",
  "accounting_scan_source_bytes_limit_exceeded",
  "accounting_scan_rss_limit_exceeded",
  "accounting_transition_rss_measurement_invalid",
  "accounting_transition_rss_limit_exceeded",
  "accounting_transition_memory_budget_exceeded",
  "accounting_transition_usage_limit_exceeded",
  "accounting_transition_snapshot_limit_exceeded",
  "accounting_transition_input_limit_exceeded",
  "accounting_transition_derivation_limit_exceeded",
  "accounting_archive_rss_measurement_invalid",
  "accounting_archive_rss_limit_exceeded",
  "accounting_unified_coverage_unavailable",
  "accounting_unified_generation_unavailable",
  "accounting_unified_generation_required",
  "accounting_unified_history_unavailable",
]);
const ACCOUNTING_RSS_CHECK_INTERVAL = 2_048;
// The production rebuild runs in a short-lived child process (2026-08-19).
// The streaming corpus (#33) bounded per-batch residency, but two residuals
// still starved the in-process rebuild at real scale: the derived transition
// series legitimately accumulates across batches (~100-200 MB over multi-year
// history), and the RSS guard measures the WHOLE process — a companion that
// idles near 1.9 GiB after indexing an ~80 GB corpus reaches the 2 GiB
// absolute target with no headroom for ANY rebuild growth, so every attempt
// deferred and the cost surface stayed empty (dogfood 0.1.13, 2026-08-19:
// accounting_rebuild_deferred at 23:21:26Z and 23:39:15Z on the streamed
// code). A child starts from a clean ~60 MB baseline, the same guard polices
// the CHILD's own RSS — which is the guard's actual purpose, keeping the
// resident menu-bar app sane, now served even better because the parent never
// grows at all — and exit returns every rebuild byte to the OS instead of
// fossilizing the next attempt's baseline.
const ACCOUNTING_REBUILD_ISOLATION_MODES = Object.freeze([
  "auto",
  "subprocess",
  "in_process",
]);
const ACCOUNTING_REBUILD_CHILD_ENTRY = fileURLToPath(
  new URL("./replay-safe-accounting-rebuild-child.js", import.meta.url),
);
// V8 old-space cap for the rebuild child, DERIVED from the absolute accounting
// target so the two can never drift apart.
//
// The ordering is the whole point. The child's effective RSS ceiling is
// min(MAX_ACCOUNTING_RSS_BYTES, childBaseline + ACCOUNTING_RSS_DELTA_BUDGET_BYTES),
// which is <= MAX_ACCOUNTING_RSS_BYTES for ANY baseline; whole-process RSS in
// turn always exceeds the JS heap. Pinning the cap AT the absolute target
// therefore guarantees the RSS guard trips FIRST, and the guard's trip is a
// soft budget miss (accounting_transition_rss_limit_exceeded) that
// refreshReplaySafeAccountingCache defers with the prior cache retained and
// served. A cap BELOW the effective ceiling inverts that: V8 aborts the child
// before the guard can read, and the parent — which cannot distinguish a
// heap-cap abort from any other death — reports the opaque
// accounting_rebuild_subprocess_failed instead. Same deferral for the user,
// but the honest reason is lost, and the fail-closed path is reached by crash
// rather than by measurement. The earlier fixed 1 GiB cap sat below a ~1.3 GiB
// effective ceiling and had exactly that inversion latent in it.
//
// This is a ceiling, not a reservation: V8 grows old space on demand, so a
// larger cap costs nothing until the pass actually needs it. Measured at owner
// scale (572,000 events / 25,870 transitions / 130 weekly windows), peak RSS
// growth over a clean baseline is 362 MiB under a 512 MiB cap and 485 MiB with
// the cap effectively unbounded — a ~123 MiB lazy-GC swing, consistent with
// the 147-354 MiB swing measured in #33, and in both cases far below the
// ~1.3 GiB effective ceiling. Prompt collection therefore does not depend on
// pinning the cap under that ceiling, and a regression back to O(corpus)
// residency still stops the pass — now as a metered deferral rather than an
// out-of-memory abort.
const ACCOUNTING_REBUILD_CHILD_OLD_SPACE_MIB = Math.ceil(
  MAX_ACCOUNTING_RSS_BYTES / (1024 * 1024),
);
// SIGTERM asks the child to unwind through its own abort checks (typed abort
// envelope); a child that cannot unwind inside this grace is killed hard. The
// value only bounds teardown after an abort — never the build itself.
const ACCOUNTING_REBUILD_CHILD_KILL_GRACE_MS = 5_000;
// The stdout envelope is one small JSON line. A child that prints more than
// this is not speaking the protocol, and the read stops charging memory for
// its output at this bound.
const ACCOUNTING_REBUILD_ENVELOPE_LIMIT_BYTES = 64 * 1024;
// Transport ceiling for the result payload read-back. The durable cache gate
// stays MAX_CACHE_BYTES (enforced by the caller exactly as for an in-process
// build); this larger bound only refuses a runaway result file before the
// parent would buffer it.
const ACCOUNTING_REBUILD_RESULT_LIMIT_BYTES = 64 * 1024 * 1024;
export const REPLAY_SAFE_ACCOUNTING_REBUILD_REQUEST_VERSION =
  "replay-safe-accounting-rebuild-request-v1";
// This scanner runs inside the same process that immediately expands the
// full-history calibration corpus. Four extraction workers preserve useful
// parallelism without leaving ten V8 worker heaps resident for that second
// phase. The general analysis-index and unified-index worker policies remain
// unchanged.
const DEFAULT_ACCOUNTING_INDEX_WORKERS = 4;
const COMPACT_USAGE_RETAINED_BYTES = 256;
const COMPACT_SNAPSHOT_RETAINED_BYTES = 192;
const DEFAULT_TRANSITION_RESOURCE_LIMITS = Object.freeze({
  usageEvents: CODEX_TRANSITION_DERIVATION_CEILINGS.usageEvents,
  weeklySnapshots:
    CODEX_TRANSITION_DERIVATION_CEILINGS.rateLimitSnapshots,
  combinedInputs: CODEX_TRANSITION_DERIVATION_CEILINGS.totalInputs,
  retainedBytes: MAX_RETAINED_TRANSITION_BYTES,
});
const COMPONENT_KEYS = Object.freeze([
  "input_uncached_tokens",
  "input_cache_read_tokens",
  "input_cache_write_tokens",
  "output_text_tokens",
  "output_reasoning_tokens",
  "output_combined_tokens",
]);
const SPEEDS = new Set(["standard", "fast", "flex", "batch", "unknown"]);
const API_TIERS = new Set(["standard", "priority", "flex", "batch", "unknown"]);
const SURFACES = new Set([
  "extension_or_ide",
  "scheduled_task",
  "subagent",
  "cli_exec",
  "work",
  "workspace_agent",
  "excel",
  "voice_task",
  "unknown",
]);
const AGENT_SCOPES = new Set(["root", "subagent", "automation", "unknown"]);
const LINEAGE = new Set(["standalone", "forked", "parent_linked", "unknown"]);
const QUOTA_PLANS = new Set(TELEMETRY_PLAN_TYPES);
const QUOTA_SLOTS = new Set(["primary", "secondary"]);

function fixedError(code, name = "Error") {
  const error = new Error(code);
  error.name = name;
  error.code = code;
  return error;
}

function normalizeAccountingSourceMode(value, { defaultValue = "legacy" } = {}) {
  const selected = value ?? defaultValue;
  if (!REPLAY_SAFE_ACCOUNTING_SOURCE_MODES.includes(selected)) {
    throw new TypeError("sourceMode must be unified or legacy");
  }
  return selected;
}

function normalizeContextBehavior(value, {
  defaultValue = DEFAULT_ACCOUNTING_CONTEXT_BEHAVIOR,
} = {}) {
  const selected = value ?? defaultValue;
  if (!REPLAY_SAFE_ACCOUNTING_CONTEXT_BEHAVIORS.includes(selected)) {
    throw new TypeError("contextBehavior is invalid");
  }
  return selected;
}

function generationToken(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    return GENERATION_TOKEN.test(value) ? value : null;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const key of ["generation", "generationId", "id", "fingerprint"]) {
    if (Object.hasOwn(value, key)) {
      const token = generationToken(value[key]);
      if (token !== null) return token;
    }
  }
  return null;
}

// SQLite stores the published generation id in the TEXT-valued meta table.
// Keep generation fingerprints byte-for-byte exact, but accept the
// integer-like decimal spelling SQLite can produce for an id (for example,
// `"1.0"`) and compare it using the same canonical token as the reader's
// numeric generation descriptor.
function generationIdMetaToken(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : null;
  }
  if (typeof value !== "string" || !/^\d+(?:\.0+)?$/u.test(value)) {
    return null;
  }
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0
    ? String(numeric)
    : null;
}

function expectedGenerationIdToken(value) {
  return generationIdMetaToken(value) ?? generationToken(value);
}

function scannerGeneration(scanned) {
  return generationToken(
    scanned?.generation
      ?? scanned?.generationId
      ?? scanned?.coverage?.generation
      ?? scanned?.coverage?.generationId
      ?? scanned?.coverage?.generationFingerprint
      ?? scanned?.coverage?.fingerprint,
  );
}

function scannerGenerationTokens(scanned) {
  const values = [
    scanned?.generation,
    scanned?.generationId,
    scanned?.generationFingerprint,
    scanned?.coverage?.generation,
    scanned?.coverage?.generationId,
    scanned?.coverage?.generationFingerprint,
    scanned?.coverage?.fingerprint,
  ];
  return [...new Set(values.map(generationToken).filter((value) => value !== null))];
}

function expectedGenerationParts(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    const token = generationToken(value);
    return token === null
      ? null
      : { opaque: token, id: null, fingerprint: null };
  }
  const collect = (keys, tokenForValue = generationToken) => {
    const present = keys.filter((key) => Object.hasOwn(value, key));
    const tokens = present.map((key) => tokenForValue(value[key]));
    if (tokens.some((token) => token === null)) return null;
    const unique = [...new Set(tokens)];
    return unique.length <= 1 ? unique[0] ?? null : null;
  };
  const id = collect([
    "generation",
    "generationId",
    "currentGenerationId",
    "id",
  ], expectedGenerationIdToken);
  const fingerprint = collect([
    "fingerprint",
    "generationFingerprint",
    "currentGenerationFingerprint",
  ]);
  const hasId = [
    "generation",
    "generationId",
    "currentGenerationId",
    "id",
  ].some((key) => Object.hasOwn(value, key));
  const hasFingerprint = [
    "fingerprint",
    "generationFingerprint",
    "currentGenerationFingerprint",
  ].some((key) => Object.hasOwn(value, key));
  if ((hasId && id === null) || (hasFingerprint && fingerprint === null)
      || (!hasId && !hasFingerprint)) return null;
  return { opaque: null, id, fingerprint };
}

function expectedGenerationTokens(value) {
  const parts = expectedGenerationParts(value);
  return parts === null
    ? []
    : [...new Set([
      parts.opaque,
      parts.id,
      parts.fingerprint,
    ].filter((token) => token !== null))];
}

function generationMatchesExpected(value, observedTokens) {
  const parts = expectedGenerationParts(value);
  if (parts === null) return false;
  const observed = new Set(observedTokens);
  if (parts.opaque !== null) return observed.has(parts.opaque);
  return (parts.id === null || observed.has(parts.id))
    && (parts.fingerprint === null || observed.has(parts.fingerprint));
}

function coverageWindow(coverage) {
  const coveredAt = coverage?.coveredAt ?? coverage?.coverage ?? null;
  const startAt = canonicalInstant(coveredAt?.startAt);
  const endAt = canonicalInstant(coveredAt?.endAt);
  if (startAt === null || endAt === null || Date.parse(startAt) > Date.parse(endAt)) {
    return null;
  }
  return { startAt, endAt };
}

function boundedDescriptorText(value) {
  return typeof value === "string" && GENERATION_TOKEN.test(value)
    ? value
    : null;
}

function boundedDescriptorCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function descriptorCapability(value, key) {
  return typeof value?.[key] === "boolean" ? value[key] : null;
}

function sourceDescriptor({
  mode,
  contextBehavior,
  scanned,
  coverage,
  generation,
  generationMatched = false,
}) {
  const coveredAt = mode === "unified" ? coverageWindow(coverage) : null;
  return {
    schemaVersion: SOURCE_DESCRIPTOR_VERSION,
    mode,
    contextBehavior,
    readerVersion: boundedDescriptorText(scanned?.readerVersion),
    schemaVersionUsed: boundedDescriptorText(scanned?.schemaVersion),
    parserVersion: boundedDescriptorText(scanned?.parserVersion),
    contractVersion: boundedDescriptorText(scanned?.contractVersion),
    generation,
    generationFingerprint: boundedDescriptorText(
      scanned?.generationFingerprint
        ?? coverage?.generationFingerprint
        ?? coverage?.fingerprint,
    ),
    coverageStatus: mode === "unified"
      ? boundedDescriptorText(coverage?.status)
      : null,
    coverage: mode === "unified"
      ? {
        status: boundedDescriptorText(coverage?.status),
        generatedAt: canonicalInstant(coverage?.generatedAt) ?? null,
        coveredAt,
        sourceCount: boundedDescriptorCount(coverage?.sourceCount),
        sourceBytes: boundedDescriptorCount(coverage?.sourceBytes),
        usageEvents: boundedDescriptorCount(coverage?.usageEvents),
        quotaObservations: boundedDescriptorCount(coverage?.quotaObservations),
        quotaOccurrences: boundedDescriptorCount(coverage?.quotaOccurrences),
        admittedQuotaOccurrences: boundedDescriptorCount(
          coverage?.admittedQuotaOccurrences,
        ),
        generationProof: coverage?.generationProof === true,
      }
      : null,
    diagnosticsAvailable: mode === "unified"
      ? (typeof scanned?.diagnosticsAvailable === "boolean"
        ? scanned.diagnosticsAvailable
        : null)
      : null,
    generationMatched,
    fallbackCount: 0,
    capabilities: mode === "unified"
      ? {
        readsRawSources: descriptorCapability(
          scanned?.capabilities,
          "readsRawSources",
        ),
        deterministicCanonicalOrder: descriptorCapability(
          scanned?.capabilities,
          "deterministicCanonicalOrder",
        ),
        sourceOrderingProvenance: descriptorCapability(
          scanned?.capabilities,
          "sourceOrderingProvenance",
        ),
        sourceOffsetProvenance: descriptorCapability(
          scanned?.capabilities,
          "sourceOffsetProvenance",
        ),
        sourceScopedQuotaOccurrences: descriptorCapability(
          scanned?.capabilities,
          "sourceScopedQuotaOccurrences",
        ),
        durableDiagnostics: descriptorCapability(
          scanned?.capabilities,
          "durableDiagnostics",
        ),
        crashSafeGenerationPublication: descriptorCapability(
          scanned?.capabilities,
          "crashSafeGenerationPublication",
        ),
      }
      : null,
  };
}

function normalizeUnifiedCoverage(scanned, expectedGeneration) {
  const coverage = scanned?.coverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
    throw fixedError("accounting_unified_coverage_unavailable");
  }
  if (coverage.status !== "complete" || coverage.generationProof !== true) {
    throw fixedError("accounting_unified_coverage_incomplete");
  }
  const capabilities = scanned?.capabilities;
  if (scanned?.diagnosticsAvailable !== true
      || !capabilities
      || capabilities.readsRawSources !== false
      || capabilities.deterministicCanonicalOrder !== true
      || capabilities.sourceOrderingProvenance !== true
      || capabilities.sourceOffsetProvenance !== true
      || capabilities.sourceScopedQuotaOccurrences !== true
      || capabilities.durableDiagnostics !== true
      || capabilities.crashSafeGenerationPublication !== true) {
    throw fixedError("accounting_unified_coverage_incomplete");
  }
  const coveredAt = coverageWindow(coverage);
  if (coveredAt === null) {
    throw fixedError("accounting_unified_coverage_unavailable");
  }
  const generation = scannerGeneration(scanned);
  if (generation === null) {
    throw fixedError("accounting_unified_generation_unavailable");
  }
  const generationFingerprint = generationToken(
    scanned?.generationFingerprint
      ?? coverage?.generationFingerprint
      ?? coverage?.fingerprint,
  );
  if (generationFingerprint === null) {
    throw fixedError("accounting_unified_generation_unavailable");
  }
  const expected = expectedGenerationTokens(expectedGeneration);
  if (expectedGeneration !== null && expected.length === 0) {
    throw new TypeError("expectedGeneration is invalid");
  }
  const observed = scannerGenerationTokens(scanned);
  if (expected.length > 0
      && !generationMatchesExpected(expectedGeneration, observed)) {
    throw fixedError("accounting_unified_generation_mismatch");
  }
  return {
    coverage,
    coveredAt,
    generation,
    generationFingerprint,
  };
}

function mapUnifiedReaderError(error) {
  const code = error?.code;
  if (typeof code === "string" && !code.startsWith("local_unified_index_")) {
    if (ACCOUNTING_READER_PASSTHROUGH_CODES.has(code)) {
      return fixedError(
        code,
        error?.name === "AbortError" ? "AbortError" : "Error",
      );
    }
    return fixedError("accounting_unified_read_failed");
  }
  const mappedCode = ACCOUNTING_SOURCE_ERROR_CODES[code]
    ?? "accounting_unified_read_failed";
  const mapped = fixedError(
    mappedCode,
    error?.name === "AbortError"
      || (typeof code === "string" && code.endsWith("_aborted"))
      ? "AbortError"
      : "Error",
  );
  return mapped;
}

function historyUnavailable(
  errorCode,
  coverage = null,
  generation = null,
  generationFingerprint = null,
) {
  const coveredAt = coverage?.coveredAt ?? coverage;
  return {
    status: "unavailable",
    errorCode,
    coverage: {
      status: "unavailable",
      generatedAt: null,
      coveredAt: coveredAt?.startAt && coveredAt?.endAt
        ? {
          startAt: coveredAt.startAt,
          endAt: coveredAt.endAt,
        }
        : { startAt: null, endAt: null },
      generation,
      generationFingerprint,
    },
    generation,
    generationFingerprint,
    period: null,
  };
}

function historyProjection(value, coverage, generation, generationFingerprint) {
  return {
    status: "available",
    errorCode: null,
    coverage: {
      status: "complete",
      generatedAt: value.generatedAt,
      coveredAt: value.coveredAt,
      generation,
      generationFingerprint,
    },
    generation,
    generationFingerprint,
    period: value.period,
  };
}

// True for the RSS/byte memory-budget misses that the refresh wrapper treats
// as a soft, recoverable TARGET miss (retain the prior cache, defer the
// rebuild) rather than a hard refresh failure. Keyed on the fixed code alone,
// so it recognizes a miss no matter which of the build's guard sites raised it.
function isAccountingBudgetMiss(error) {
  return typeof error?.code === "string"
    && ACCOUNTING_BUDGET_MISS_CODES.has(error.code);
}

function accountingScanResourceError(error) {
  const code = error?.code;
  if (!(error instanceof ExportResourceLimitError)
      && (typeof code !== "string"
        || !code.startsWith("export_resource_"))) return null;
  const suffix = code.slice("export_resource_".length);
  return fixedError(`accounting_scan_${suffix}_limit_exceeded`);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = fixedError("accounting_refresh_aborted");
  error.name = "AbortError";
  throw error;
}

function transitionResourceLimits(value) {
  if (value === null || value === undefined) {
    return DEFAULT_TRANSITION_RESOURCE_LIMITS;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("transitionResourceLimits must be an object or null");
  }
  const ceilings = {
    usageEvents: CODEX_TRANSITION_DERIVATION_CEILINGS.usageEvents,
    weeklySnapshots:
      CODEX_TRANSITION_DERIVATION_CEILINGS.rateLimitSnapshots,
    combinedInputs: CODEX_TRANSITION_DERIVATION_CEILINGS.totalInputs,
    retainedBytes: MAX_RETAINED_TRANSITION_BYTES,
  };
  const allowed = new Set(Object.keys(ceilings));
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError("transitionResourceLimits contains an unknown key");
  }
  return Object.fromEntries(Object.entries(ceilings).map(([key, ceiling]) => {
    const selected = value[key] ?? ceiling;
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > ceiling) {
      throw new TypeError(
        `transitionResourceLimits.${key} must be between 1 and ${ceiling}`,
      );
    }
    return [key, selected];
  }));
}

function canonicalInstant(value) {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? value
    : null;
}

function emptyComponents() {
  return Object.fromEntries(COMPONENT_KEYS.map((key) => [key, 0]));
}

function tokenTotal(components) {
  const input = (components.input_uncached_tokens ?? 0)
    + (components.input_cache_read_tokens ?? 0)
    + (components.input_cache_write_tokens ?? 0);
  const separatedOutput = (components.output_text_tokens ?? 0)
    + (components.output_reasoning_tokens ?? 0);
  const combinedOutput = components.output_combined_tokens ?? 0;
  return input + (combinedOutput > 0 ? combinedOutput : separatedOutput);
}

function safeEnum(value, allowed) {
  return allowed.has(value) ? value : "unknown";
}

function safeModel(value) {
  return recognizedCodexModelId(value) ?? "unknown";
}

function emptyDimension(keys) {
  return Object.fromEntries([...keys].map((key) => [
    key,
    { events: 0, totalTokens: 0, apiPriceEquivalentUsd: 0 },
  ]));
}

function newPeriod(id, label, { includeSpark = true } = {}) {
  const period = {
    id,
    label,
    events: 0,
    totalTokens: 0,
    components: emptyComponents(),
    componentCosts: emptyComponentCosts(),
    apiPriceEquivalentUsd: 0,
    apiPriceEquivalentUsdExact: "0",
    priceCardIds: [],
    priceCardBreakdown: {},
    pricingCoverage: {
      fullyPricedEvents: 0,
      partiallyPricedEvents: 0,
      unpricedEvents: 0,
    },
    byModel: {},
    bySpeed: emptyDimension(SPEEDS),
    byApiServiceTier: emptyDimension(API_TIERS),
    bySurface: emptyDimension(SURFACES),
    byAgentScope: emptyDimension(AGENT_SCOPES),
    byLineage: emptyDimension(LINEAGE),
    // Observed speed mode crossed with the model's published Fast credit rate
    // family. The crossing is what lets the owner's Fast-mode preference be
    // applied at read time without rebuilding this cache.
    speedWeighting: emptySpeedWeightingCrossing(),
    // The same crossing, holding only the events the log left UNOBSERVED that
    // a timestamped Codex `service_tier` reading actually covers. Kept apart
    // from the observed crossing so a declaration can never be read back as an
    // observation.
    declaredSpeedWeighting: emptySpeedWeightingCrossing(),
  };
  if (includeSpark) {
    period.spark = newPeriod("spark", "Spark allowance", {
      includeSpark: false,
    });
  }
  return period;
}

function addComponents(target, source) {
  for (const key of COMPONENT_KEYS) {
    const value = source?.[key];
    if (Number.isSafeInteger(value) && value >= 0) target[key] += value;
  }
}

function addDimension(target, key, event) {
  const row = target[key] ?? target.unknown;
  row.events += 1;
  row.totalTokens += event.totalTokens;
  row.apiPriceEquivalentUsd += event.apiPriceEquivalentUsd;
}

const FAST_PRICE_SCALE = 1_000_000_000;

function scaledUsdString(value) {
  if (!Number.isSafeInteger(value) || value <= 0) return "0";
  const whole = Math.floor(value / FAST_PRICE_SCALE);
  const fraction = String(value % FAST_PRICE_SCALE).padStart(9, "0");
  return `${whole}.${fraction}`.replace(/\.?0+$/u, "");
}

// Exported for the unified-index companion read: one memoized unit-price plan
// per (model, context band, effective date), integer-scaled per event, falling
// back to the full pricer whenever a plan cannot be proven exact. This is the
// same pricer the replay-safe cache itself accounts with.
export function createAccountingPricer() {
  const plans = new Map();
  return (event, components) => {
    // The reviewed pricer bands by the provider-reported total input context
    // when present, and otherwise by the sum of the input token components.
    // The plan key must reproduce that rule exactly: keying the band off the
    // reported total alone silently priced every 272k+ event whose record
    // lacks the field at short-context rates.
    const reportedTotal = Number(event.totalInputContextTokens);
    const inputSum = (components.input_uncached_tokens ?? 0)
      + (components.input_cache_read_tokens ?? 0)
      + (components.input_cache_write_tokens ?? 0);
    const contextBand =
      (Number.isFinite(reportedTotal) ? reportedTotal : inputSum) >= 272_000
        ? "long"
        : "short";
    // Keep the effective date in the fast-plan key: official price cards may
    // change by date, and a later plan must never price an earlier event.
    const effectiveDate = canonicalInstant(event.timestamp)?.slice(0, 10)
      ?? "missing_timestamp";
    const key = `${event.model}\0${contextBand}\0${effectiveDate}`;
    let plan = plans.get(key);
    if (plan === undefined) {
      const templateComponents = Object.fromEntries(
        COMPONENT_KEYS.map((name) => [
          name,
          name === "output_combined_tokens" ? 0 : 1,
        ]),
      );
      const template = priceCodexUsageEvent({
        ...event,
        totalInputContextTokens:
          contextBand === "long" ? 272_000 : 0,
        components: templateComponents,
      }, {
        apiServiceTier: "standard",
        priceEpochBasis: "event_time",
      });
      // Keep only rows whose unit price is proven exact. The per-event loop
      // below falls back to the full pricer the moment an event actually USES
      // a component that has no such row, so a partially priced card — Codex
      // never prices cache writes, for example — still yields a fast plan for
      // the events that never touch the unpriced component. The previous
      // all-components gate nullified every Codex plan and silently sent the
      // entire corpus down the slow path.
      const rows = new Map(template.components
        .filter((row) => (
          typeof row.unitPriceUsd === "string"
          && /^\d+(?:\.\d{1,9})?$/u.test(row.unitPriceUsd)
        ))
        .map((row) => [row.name, row]));
      plan = ["fully_priced", "partially_priced"].includes(
        template.coverageStatus,
      ) && rows.size > 0
        ? {
          rows,
          // A fast-priced event uses only fully priced components, so the
          // template's unpriced-component warnings do not describe it. The
          // empty shape mirrors the full pricer's warnings object.
          warnings: template.coverageStatus === "fully_priced"
            ? template.warnings
            : { coverage: [], informational: [] },
          selectedPriceCardIds: template.selectedPriceCardIds,
        }
        : null;
      plans.set(key, plan);
    }
    if (plan === null) {
      return priceCodexUsageEvent({
        ...event,
        components,
      }, {
        apiServiceTier: "standard",
        priceEpochBasis: "event_time",
      });
    }
    const pricedComponents = [];
    const priceCardBreakdown = new Map();
    let totalUsdScaled = 0;
    for (const name of COMPONENT_KEYS) {
      const quantity = components[name] ?? 0;
      if (!Number.isSafeInteger(quantity) || quantity <= 0) continue;
      const template = plan.rows.get(name);
      if (!template || typeof template.unitPriceUsd !== "string") {
        return priceCodexUsageEvent({
          ...event,
          components,
        }, {
          apiServiceTier: "standard",
          priceEpochBasis: "event_time",
        });
      }
      const unitPriceScaled = Math.round(
        Number(template.unitPriceUsd) * FAST_PRICE_SCALE,
      );
      const costUsdScaled = unitPriceScaled * quantity;
      if (!Number.isSafeInteger(costUsdScaled)
          || !Number.isSafeInteger(
            totalUsdScaled + costUsdScaled,
          )) {
        return priceCodexUsageEvent({
          ...event,
          components,
        }, {
          apiServiceTier: "standard",
          priceEpochBasis: "event_time",
        });
      }
      totalUsdScaled += costUsdScaled;
      pricedComponents.push({
        name,
        pricedAs: template.pricedAs,
        quantity: String(quantity),
        unit: template.unit,
        pricingStatus: "priced",
        unitPriceUsd: template.unitPriceUsd,
        costUsd: scaledUsdString(costUsdScaled),
        priceCardId: template.priceCardId,
      });
      const card = priceCardBreakdown.get(template.priceCardId) ?? {
        priceCardId: template.priceCardId,
        events: 0,
        costUsd: "0",
      };
      card.events = 1;
      card.costUsd = addUsdStrings(card.costUsd, scaledUsdString(costUsdScaled));
      priceCardBreakdown.set(template.priceCardId, card);
    }
    return {
      totalUsd: scaledUsdString(totalUsdScaled),
      coverageStatus: "fully_priced",
      components: pricedComponents,
      selectedPriceCardIds: plan.selectedPriceCardIds,
      priceCardBreakdown: [...priceCardBreakdown.values()].sort(
        (left, right) => left.priceCardId.localeCompare(right.priceCardId),
      ),
      warnings: plan.warnings,
    };
  };
}

function eventProjection(event, price) {
  const components = emptyComponents();
  addComponents(components, event.components);
  const separatedOutput = components.output_text_tokens
    + components.output_reasoning_tokens;
  // Prefer the more informative non-overlapping split when both the split and
  // a combined alias are present. A combined-only count is preserved for
  // display, but normalized to ordinary output solely for API pricing.
  if (components.output_combined_tokens > 0 && separatedOutput > 0) {
    components.output_combined_tokens = 0;
  }
  const totalTokens = tokenTotal(components);
  if (totalTokens === 0) return null;
  const model = safeModel(event.model);
  const combinedOnly = components.output_combined_tokens > 0;
  const pricingComponents = combinedOnly
    ? {
      ...components,
      output_text_tokens: components.output_combined_tokens,
      output_combined_tokens: 0,
    }
    : components;
  let priced;
  try {
    priced = price({
      ...event,
      model,
    }, pricingComponents);
    if (combinedOnly) {
      priced = {
        ...priced,
        components: priced.components.map((row) => (
          row.name === "output_text_tokens"
            ? {
              ...row,
              name: "output_combined_tokens",
              pricedAs: "output_text_tokens",
            }
            : row
        )),
      };
    }
  } catch {
    priced = {
      totalUsd: "0",
      coverageStatus: "unpriced",
      components: [],
    };
  }
  const cost = Number(priced.totalUsd);
  return {
    timestamp: event.timestamp,
    model,
    modelPricingStatus: codexModelPricingStatus(event.model),
    modelAllowanceTrack: codexModelAllowanceTrack(event.model),
    modelApiPriceEquivalentApplicable:
      codexModelApiPriceEquivalentApplicable(event.model),
    isSpark: model === SPARK_MODEL,
    components,
    totalTokens,
    priced,
    apiPriceEquivalentUsd: Number.isFinite(cost) && cost >= 0 ? cost : 0,
    pricingCoverageStatus: ["fully_priced", "partially_priced"].includes(
      priced.coverageStatus,
    )
      ? priced.coverageStatus
      : "unpriced",
    speed: safeEnum(event.tierSemantics?.codexSpeedMode, SPEEDS),
    apiServiceTier: safeEnum(
      event.tierSemantics?.apiServiceTier,
      API_TIERS,
    ),
    surface: safeEnum(event.surfaceClassification?.surface, SURFACES),
    agentScope: safeEnum(
      event.surfaceClassification?.agentScope,
      AGENT_SCOPES,
    ),
    lineage: safeEnum(
      event.surfaceClassification?.lineageDisposition,
      LINEAGE,
    ),
  };
}

function transitionUsageProjection(event, projection) {
  const components = COMPONENT_KEYS.map((key) => (
    Number.isSafeInteger(event.components?.[key])
      && event.components[key] >= 0
      ? event.components[key]
      : 0
  ));
  const costUsd = Number(projection.priced.totalUsd);
  const multiplier = fastQuotaMultiplier(projection.model);
  const fastWeightedEquivalentUsd =
    multiplier === null ? null : costUsd * multiplier;
  const effectiveSpeed = ["standard", "fast"].includes(projection.speed)
    ? projection.speed
    : ["standard", "fast"].includes(projection.declaredSpeed)
      ? projection.declaredSpeed
      : "unknown";
  const quotaWeightedLowerUsd = effectiveSpeed === "fast"
    ? fastWeightedEquivalentUsd
    : costUsd;
  const quotaWeightedUpperUsd = effectiveSpeed === "standard"
    ? costUsd
    : fastWeightedEquivalentUsd;
  return [
    canonicalInstant(event.timestamp),
    projection.model,
    Number.isSafeInteger(event.totalInputContextTokens)
      && event.totalInputContextTokens >= 0
      ? event.totalInputContextTokens
      : 0,
    ...components,
    projection.speed,
    Number.isFinite(costUsd) ? costUsd : 0,
    projection.priced.totalUsd,
    projection.priced.coverageStatus,
    fastWeightedEquivalentUsd,
    quotaWeightedLowerUsd,
    quotaWeightedUpperUsd,
    costWarningCodes(projection.priced),
    projection.priced.warnings.coverage
      .map((warning) => warning.code)
      .sort(),
    projection.priced.selectedPriceCardIds,
    projection.priced.priceCardBreakdown ?? [],
  ];
}

function weeklyRateLimitProjection(snapshot) {
  const window = snapshot.window;
  const boundedText = (value) => (
    typeof value === "string"
      && value.length > 0
      && value.length <= 64
      ? value
      : "unknown"
  );
  return [
    canonicalInstant(snapshot.timestamp),
    Number.isFinite(snapshot.timestampMs)
      ? snapshot.timestampMs
      : Date.parse(snapshot.timestamp),
    boundedText(window.provider),
    boundedText(window.planType),
    boundedText(window.limitId),
    boundedText(window.slot),
    window.windowDurationMins,
    window.resetsAt,
    window.usedPercent,
  ];
}

function quotaTimelineProjection(
  snapshot,
  { limitId = "codex", durationMinutes = WEEKLY_WINDOW_MINUTES } = {},
) {
  const observedAt = canonicalInstant(snapshot?.timestamp);
  const window = snapshot?.window;
  // Keep only the limit family the caller asked for. The high-churn
  // codex_bengalfox family never folds into the main "codex" weekly track
  // used by the UI calibration — it is the Spark allowance's real limit id
  // and is retained on the Spark series instead.
  if (observedAt === null
      || !window
      || typeof window !== "object"
      || window.provider !== "openai_codex"
      || window.limitId !== limitId
      || !QUOTA_SLOTS.has(window.slot)
      || (durationMinutes !== null
        && window.windowDurationMins !== durationMinutes)
      || !isValidQuotaWindowDuration(window.windowDurationMins)
      || typeof window.usedPercent !== "number"
      || !Number.isFinite(window.usedPercent)
      || window.usedPercent < 0
      || window.usedPercent > 100
      || !Number.isSafeInteger(window.resetsAt)
      || window.resetsAt <= 0) {
    return null;
  }
  const resetDate = new Date(window.resetsAt * 1_000);
  if (!Number.isFinite(resetDate.getTime())) return null;
  const resetAt = resetDate.toISOString();
  const usedPercent = Number(window.usedPercent.toFixed(3));
  return {
    observedAt,
    limitId,
    slot: window.slot,
    planType: QUOTA_PLANS.has(window.planType)
      ? window.planType
      : "unknown",
    usedPercent,
    remainingPercent: Number(Math.max(0, 100 - usedPercent).toFixed(3)),
    durationMinutes: window.windowDurationMins,
    resetAt,
    accountAttribution: "historical_unattributed",
  };
}

function quotaTimelineTrackBucketKey(row) {
  const observedMs = Date.parse(row.observedAt);
  // Preserve the exact observed point. Collapsing to a 15-minute bucket can
  // erase the closest points to an exact comparison endpoint and manufacture
  // an otherwise avoidable missing-bracket status.
  return `${observedMs}:${row.limitId}:${row.durationMinutes}`;
}

// Track identity is (limitId, duration). The provider's primary/secondary
// slots are server-assigned UI roles — the weekly window flipped from
// `secondary` to `primary` around 2026-07-06 — so slot stays on the row as
// display provenance but never keys a track: keying on it split one
// continuous weekly series into two tracks at the flip.
function quotaTimelineTrackKey(row) {
  return `${row.limitId}:${row.durationMinutes}`;
}

function quotaTimelineBucketKey(row) {
  const observedMs = Date.parse(row.observedAt);
  const bucketStartMs = Math.floor(observedMs / TIMELINE_BUCKET_MS)
    * TIMELINE_BUCKET_MS;
  return `${bucketStartMs}:${quotaTimelineTrackKey(row)}`;
}

function quotaTimelineStateKey(row) {
  return [
    row.planType,
    row.usedPercent.toFixed(3),
    row.resetAt,
  ].join("\0");
}

function quotaTimelineRowTieBreak(row) {
  // Percent is zero-padded so the string compare is numeric: between two
  // same-instant readings of one track the lower displayed percentage wins.
  // Slot is deliberately LAST: it is display provenance, not identity, and
  // only breaks the tie when the state is otherwise identical so retention
  // stays order-independent.
  return [
    row.planType,
    row.usedPercent.toFixed(3).padStart(7, "0"),
    row.resetAt,
    row.slot,
  ].join("\0");
}

// Retained order must satisfy validQuotaTimeline's code-unit sortKey check on
// read. localeCompare gives punctuation variable collation weight — it orders
// "codex_bengalfox" before "codex-spark" while the code-unit check orders
// them the other way — so quota-timeline ordering always compares code units,
// never collation order.
function codeUnitCompare(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function quotaTimelineRowSort(left, right) {
  return codeUnitCompare(left.observedAt, right.observedAt)
    || codeUnitCompare(left.limitId, right.limitId)
    || codeUnitCompare(left.slot, right.slot)
    || codeUnitCompare(left.resetAt, right.resetAt)
    || codeUnitCompare(left.planType, right.planType)
    || left.usedPercent - right.usedPercent;
}

function quotaTimelineDeterministicRowSort(left, right) {
  return quotaTimelineRowSort(left, right)
    || codeUnitCompare(
      String(left.durationMinutes),
      String(right.durationMinutes),
    );
}

function retainQuotaTimeline(buckets, snapshot, options) {
  const row = quotaTimelineProjection(snapshot, options);
  if (row === null) return;
  const key = quotaTimelineTrackBucketKey(row);
  const prior = buckets.get(key);
  if (prior === undefined
      || row.observedAt > prior.observedAt
      || (row.observedAt === prior.observedAt
        && quotaTimelineRowTieBreak(row)
          < quotaTimelineRowTieBreak(prior))) {
    buckets.set(key, row);
  }
}

function addQuotaTimelineCandidate(candidates, row, transitionKeys = null) {
  const key = quotaTimelineTrackBucketKey(row);
  candidates.set(key, row);
  if (transitionKeys !== null) transitionKeys.add(key);
}

function quotaTimelineCandidates(rows) {
  const candidates = new Map();
  const transitionKeys = new Set();
  const previousByTrack = new Map();
  const bucketEdges = new Map();

  for (const row of rows) {
    const trackKey = quotaTimelineTrackKey(row);
    const previous = previousByTrack.get(trackKey);
    if (previous === undefined
        || quotaTimelineStateKey(previous) !== quotaTimelineStateKey(row)) {
      addQuotaTimelineCandidate(candidates, row, transitionKeys);
    }
    previousByTrack.set(trackKey, row);

    const bucketKey = quotaTimelineBucketKey(row);
    const edge = bucketEdges.get(bucketKey);
    if (edge === undefined) {
      bucketEdges.set(bucketKey, { first: row, last: row });
    } else {
      edge.last = row;
    }
  }

  for (const { first, last } of bucketEdges.values()) {
    addQuotaTimelineCandidate(candidates, first);
    addQuotaTimelineCandidate(candidates, last);
  }

  return { candidates, transitionKeys };
}

function selectTimeStratifiedQuotaTimelineRows(
  rows,
  maximum,
  rangeRows = rows,
) {
  if (rows.length <= maximum) return rows;
  const rangeStartMs = Date.parse(rangeRows[0].observedAt);
  const rangeEndMs = Date.parse(rangeRows.at(-1).observedAt);
  if (rangeStartMs === rangeEndMs) {
    return rows
      .slice()
      .sort(quotaTimelineDeterministicRowSort)
      .slice(0, maximum);
  }

  const spanMs = rangeEndMs - rangeStartMs;
  const groups = new Map();
  for (const row of rows) {
    const observedMs = Date.parse(row.observedAt);
    const stratum = Math.min(
      maximum - 1,
      Math.floor(((observedMs - rangeStartMs) * maximum) / spanMs),
    );
    const group = groups.get(stratum) ?? [];
    group.push(row);
    groups.set(stratum, group);
  }

  const activeGroups = [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, group]) => ({
      rows: group.sort(quotaTimelineDeterministicRowSort),
      nextIndex: 0,
    }));
  const selected = [];
  while (activeGroups.length > 0 && selected.length < maximum) {
    const nextGroups = [];
    for (const group of activeGroups) {
      if (group.nextIndex < group.rows.length) {
        selected.push(group.rows[group.nextIndex]);
        group.nextIndex += 1;
      }
      if (group.nextIndex < group.rows.length) nextGroups.push(group);
      if (selected.length >= maximum) break;
    }
    activeGroups.splice(0, activeGroups.length, ...nextGroups);
  }
  return selected;
}

// The oldest and newest observation on every track. These are pinned before
// any sampling so the retained series always reaches both ends of the covered
// window: the oldest row is what a calibration window near the start of the
// range needs to bracket against, and the newest row is the current allowance
// reading.
function quotaTimelineRangeAnchors(sortedRows) {
  const firstByTrack = new Map();
  const lastByTrack = new Map();
  for (const row of sortedRows) {
    const key = quotaTimelineTrackKey(row);
    if (!firstByTrack.has(key)) firstByTrack.set(key, row);
    lastByTrack.set(key, row);
  }
  const anchors = new Map();
  for (const row of [...firstByTrack.values(), ...lastByTrack.values()]) {
    anchors.set(quotaTimelineTrackBucketKey(row), row);
  }
  return [...anchors.values()].sort(quotaTimelineDeterministicRowSort);
}

// Time stratification alone is not enough when several tracks share the range:
// at equal timestamps one track always sorts first, so a single stratified
// pass can spend the whole budget on that track and erase the other one. Give
// every (limitId, duration) track its own stratified share and interleave
// them.
function selectTrackBalancedQuotaTimelineRows(rows, maximum, rangeRows) {
  if (rows.length <= maximum) return rows;
  const byTrack = new Map();
  for (const row of rows) {
    const key = quotaTimelineTrackKey(row);
    const group = byTrack.get(key) ?? [];
    group.push(row);
    byTrack.set(key, group);
  }
  if (byTrack.size <= 1) {
    return selectTimeStratifiedQuotaTimelineRows(rows, maximum, rangeRows);
  }
  const trackBudget = Math.ceil(maximum / byTrack.size);
  let tracks = [...byTrack.entries()]
    .sort(([left], [right]) => codeUnitCompare(left, right))
    .map(([, group]) => ({
      rows: selectTimeStratifiedQuotaTimelineRows(
        group.sort(quotaTimelineDeterministicRowSort),
        trackBudget,
        rangeRows,
      ).slice().sort(quotaTimelineDeterministicRowSort),
      nextIndex: 0,
    }));
  const selected = [];
  while (tracks.length > 0 && selected.length < maximum) {
    const nextTracks = [];
    for (const track of tracks) {
      if (selected.length < maximum && track.nextIndex < track.rows.length) {
        selected.push(track.rows[track.nextIndex]);
        track.nextIndex += 1;
      }
      if (track.nextIndex < track.rows.length) nextTracks.push(track);
    }
    tracks = nextTracks;
  }
  return selected;
}

// Fill a hard row budget from priority groups. Each group is stratified over
// time and balanced across tracks into whatever capacity is left, so a dense
// recent burst can never crowd out the earlier part of the covered window and
// the result never exceeds `maximum` — the same ceiling `validQuotaTimeline`
// enforces on read. A final pass over every candidate spends any capacity a
// short group left behind.
function retainBoundedQuotaTimelineRows(groups, maximum, rangeRows) {
  const retained = new Map();
  for (const group of [...groups, rangeRows]) {
    const capacity = maximum - retained.size;
    if (capacity <= 0) break;
    const pending = group.filter((row) => (
      !retained.has(quotaTimelineTrackBucketKey(row))
    ));
    if (pending.length === 0) continue;
    const selected = selectTrackBalancedQuotaTimelineRows(
      pending,
      capacity,
      rangeRows,
    );
    for (const row of selected) {
      if (retained.size >= maximum) break;
      retained.set(quotaTimelineTrackBucketKey(row), row);
    }
  }
  return [...retained.values()].sort(quotaTimelineDeterministicRowSort);
}

function finalizeWeeklyQuotaTimeline(buckets) {
  const rows = [...buckets.values()].sort(quotaTimelineRowSort);
  // Keep the historical path byte-for-byte/order-for-order for ordinary
  // caches. Retention only changes when the old newest-only cap would have
  // discarded the earlier covered window.
  if (rows.length <= MAX_QUOTA_TIMELINE_ROWS) return rows;

  const { candidates, transitionKeys } = quotaTimelineCandidates(rows);
  if (candidates.size <= MAX_QUOTA_TIMELINE_ROWS) {
    return [...candidates.values()].sort(quotaTimelineDeterministicRowSort);
  }

  const candidateRows = [...candidates.values()]
    .sort(quotaTimelineDeterministicRowSort);
  const transitionRows = candidateRows.filter((row) => (
    transitionKeys.has(quotaTimelineTrackBucketKey(row))
  ));
  const bucketEdgeRows = candidateRows.filter((row) => (
    !transitionKeys.has(quotaTimelineTrackBucketKey(row))
  ));
  // Retaining every state transition is not bounded: a long, busy range can
  // hold far more transitions than the cap, which is how this path used to
  // return more rows than the cache is allowed to carry. Transitions still
  // rank above plain bucket edges, but they are budgeted like everything else.
  return retainBoundedQuotaTimelineRows(
    [quotaTimelineRangeAnchors(candidateRows), transitionRows, bucketEdgeRows],
    MAX_QUOTA_TIMELINE_ROWS,
    candidateRows,
  );
}

function paceAccountTrackId(snapshot) {
  const scope = snapshot?.accountScope;
  if (scope?.status === "available"
      && (ACCOUNT_SCOPE_ID_PATTERN.test(scope.scopeId ?? "")
        || ACCOUNT_TRACK_ID_PATTERN.test(scope.scopeId ?? ""))) {
    return scope.scopeId;
  }
  // A caller that has already projected the app-server marker may supply the
  // opaque track directly. Never accept a session/source scope or an
  // arbitrary string as an account identity.
  const direct = snapshot?.accountTrackId;
  return ACCOUNT_SCOPE_ID_PATTERN.test(direct ?? "")
      || ACCOUNT_TRACK_ID_PATTERN.test(direct ?? "")
    ? direct
    : null;
}

function paceToken(value, fallback) {
  return typeof value === "string"
      && /^[a-z0-9][a-z0-9_.:-]{0,127}$/iu.test(value)
    ? value
    : fallback;
}

function weeklyPaceSnapshotProjection(snapshot) {
  const window = snapshot?.window;
  const accountTrackId = paceAccountTrackId(snapshot);
  const observedAt = canonicalInstant(
    snapshot?.observedAt ?? snapshot?.timestamp,
  );
  const receivedAt = canonicalInstant(
    snapshot?.receivedAt ?? snapshot?.timestamp,
  );
  if (accountTrackId === null
      || observedAt === null
      || receivedAt === null
      || !window
      || typeof window !== "object"
      || window.provider !== "openai_codex"
      || window.limitId !== "codex"
      || !QUOTA_SLOTS.has(window.slot)
      || window.windowDurationMins !== WEEKLY_WINDOW_MINUTES
      || !Number.isFinite(window.usedPercent)
      || window.usedPercent < 0
      || window.usedPercent > 100
      || !Number.isSafeInteger(window.resetsAt)
      || window.resetsAt <= 0
      || Date.parse(receivedAt) < Date.parse(observedAt)) {
    return null;
  }
  const resetDate = new Date(window.resetsAt * 1_000);
  if (!Number.isFinite(resetDate.getTime())) return null;
  return {
    accountTrackId,
    provider: "openai_codex",
    planType: paceToken(window.planType, "unknown"),
    // The shared quota-analysis pace contract requires a non-empty planVariant
    // track field (validateSnapshot / plainExact), so it stays on the wire even
    // though the local plan cohort is now carried by planType.
    planVariant: paceToken(
      snapshot?.planVariant ?? window.planVariant,
      "current-window",
    ),
    limitId: "codex",
    slot: window.slot,
    windowDurationMinutes: WEEKLY_WINDOW_MINUTES,
    resetsAt: resetDate.toISOString(),
    observedAt,
    receivedAt,
    usedPercent: Number(window.usedPercent.toFixed(3)),
    policyEpoch: paceToken(
      snapshot?.policyEpoch ?? window.policyEpoch,
      "current-window",
    ),
  };
}

// Slot is deliberately absent: it is a server-assigned UI role, and the
// weekly window flipped secondary -> primary around 2026-07-06. Keeping it in
// the track key excluded the pre-flip observations from the pace history of
// what is one continuous (limit, duration, reset) track.
function paceTrackKey(row, includeReset = true) {
  return [
    row.accountTrackId,
    row.provider,
    row.planType,
    row.planVariant,
    row.limitId,
    row.windowDurationMinutes,
    ...(includeReset ? [row.resetsAt] : []),
    row.policyEpoch,
  ].join("\0");
}

function paceUnavailable(row, status = "unavailable") {
  return {
    status,
    currentUsedPercent: Number(row.usedPercent.toFixed(3)),
    remainingPercent: Number(Math.max(0, 100 - row.usedPercent).toFixed(3)),
    resetsAt: row.resetsAt,
    pace: {
      activePercentagePointsPerHour: null,
      overallPercentagePointsPerHour: null,
    },
    etaAt: null,
    hoursToExhaustion: null,
    hoursToReset: Number(
      Math.max(0, Date.parse(row.resetsAt) - Date.parse(row.observedAt))
        / (60 * 60 * 1_000),
    ),
  };
}

function sanitizeWeeklyPaceForecast(result) {
  if (!result || typeof result !== "object"
      || !PACE_STATUSES.has(result.status)
      || !Number.isFinite(result.currentUsedPercent)
      || result.currentUsedPercent < 0
      || result.currentUsedPercent > 100
      || !Number.isFinite(result.remainingPercent)
      || result.remainingPercent < 0
      || result.remainingPercent > 100
      || result.remainingPercent
        !== Number(Math.max(0, 100 - result.currentUsedPercent).toFixed(3))
      || canonicalInstant(result.resetsAt) === null) {
    return null;
  }
  const activeRate = result.pace?.activePercentagePointsPerHour;
  const overallRate = result.pace?.overallPercentagePointsPerHour;
  const hoursToExhaustion = result.hoursToExhaustion;
  const hoursToReset = result.hoursToReset;
  const etaAt = result.etaAt === null ? null : canonicalInstant(result.etaAt);
  const invalidRate = (rate) => rate !== null
    && (!Number.isFinite(rate) || rate < 0 || rate > 100);
  if (invalidRate(activeRate)
      || invalidRate(overallRate)
      || (hoursToExhaustion !== null
        && (!Number.isFinite(hoursToExhaustion) || hoursToExhaustion < 0))
      || (hoursToReset !== null
        && (!Number.isFinite(hoursToReset) || hoursToReset < 0))
      || (result.etaAt !== null && etaAt === null)) {
    return null;
  }
  return {
    status: result.status,
    currentUsedPercent: Number(result.currentUsedPercent.toFixed(3)),
    remainingPercent: Number(result.remainingPercent.toFixed(3)),
    resetsAt: result.resetsAt,
    pace: {
      activePercentagePointsPerHour:
        activeRate === null ? null : Number(activeRate.toFixed(6)),
      overallPercentagePointsPerHour:
        overallRate === null ? null : Number(overallRate.toFixed(6)),
    },
    etaAt,
    hoursToExhaustion: hoursToExhaustion === null
      ? null
      : Number(hoursToExhaustion.toFixed(6)),
    hoursToReset: hoursToReset === null ? null : Number(hoursToReset.toFixed(6)),
  };
}

function projectWeeklyPaceForecast(rows, endMs) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const ordered = [...rows].sort((left, right) => (
    left.observedAt.localeCompare(right.observedAt)
    || left.receivedAt.localeCompare(right.receivedAt)
    || left.usedPercent - right.usedPercent
  ));
  const latestMs = Date.parse(ordered.at(-1).observedAt);
  const latest = ordered.filter(
    (row) => Date.parse(row.observedAt) === latestMs,
  );
  const latestAccounts = new Set(latest.map((row) => row.accountTrackId));
  if (latestAccounts.size !== 1) return null;
  const latestScope = latest[0].accountTrackId;
  const latestSlots = new Set(
    latest.filter((row) => row.accountTrackId === latestScope)
      .map((row) => row.slot),
  );
  // The provider labels either slot as valid for the seven-day limit. If both
  // are present at the same instant, follow the dashboard's primary-slot
  // preference; otherwise keep the only observed slot.
  const selectedSlot = latestSlots.has("primary")
    ? "primary"
    : latestSlots.size === 1 ? [...latestSlots][0] : null;
  if (selectedSlot === null) return null;
  const currentCandidates = latest.filter((row) => (
    row.accountTrackId === latestScope && row.slot === selectedSlot
  ));
  const currentKeys = new Set(currentCandidates.map((row) => paceTrackKey(row)));
  if (currentKeys.size !== 1) return null;
  const current = currentCandidates[0];
  if (endMs - latestMs > PACE_CURRENT_MAX_AGE_MS) {
    return sanitizeWeeklyPaceForecast(paceUnavailable(current));
  }
  const currentKey = paceTrackKey(current);
  const observations = ordered.filter((row) => (
    row.accountTrackId === latestScope
    && paceTrackKey(row) === currentKey
  ));
  try {
    const result = analyzeQuotaPace({
      currentSnapshot: current,
      observations,
    });
    return sanitizeWeeklyPaceForecast(result);
  } catch {
    return sanitizeWeeklyPaceForecast(paceUnavailable(current));
  }
}

function addSpeedWeighting(crossing, event) {
  // "fast", "standard" and "unknown" are the only observed values; anything
  // else collapses to unknown rather than being treated as Standard.
  const speed = crossing[event.speed] ? event.speed : "unknown";
  const cell = crossing[speed][fastModeModelFamilyKey(event.model)];
  cell.events += 1;
  cell.apiPriceEquivalentUsd += event.apiPriceEquivalentUsd;
}

function addDeclaredSpeedWeighting(crossing, event) {
  // Only a declaration that resolved to a real mode is recorded, and only for
  // events the log left unobserved; everything else is left unattributed.
  if (event.declaredSpeed !== "standard" && event.declaredSpeed !== "fast") {
    return;
  }
  const cell = crossing[event.declaredSpeed][fastModeModelFamilyKey(event.model)];
  cell.events += 1;
  cell.apiPriceEquivalentUsd += event.apiPriceEquivalentUsd;
}

function finalizeSpeedWeighting(crossing) {
  return Object.fromEntries(Object.entries(crossing).map(([speed, families]) => [
    speed,
    Object.fromEntries(Object.entries(families).map(([family, cell]) => [
      family,
      { ...cell, apiPriceEquivalentUsd: roundedMoney(cell.apiPriceEquivalentUsd) },
    ])),
  ]));
}

function compactSpeedWeighting(crossing) {
  // Timeline buckets overwhelmingly occupy one or two of the twelve possible
  // speed/model-family cells. Persist only those cells; readers validate the
  // allowed sparse keys and treat absence as an exact zero.
  const compact = {};
  for (const [speed, families] of Object.entries(crossing)) {
    const selected = {};
    for (const [family, cell] of Object.entries(families)) {
      if (cell.events === 0 && cell.apiPriceEquivalentUsd === 0) continue;
      selected[family] = {
        events: cell.events,
        apiPriceEquivalentUsd: roundedMoney(cell.apiPriceEquivalentUsd),
      };
    }
    if (Object.keys(selected).length > 0) compact[speed] = selected;
  }
  return compact;
}

function addEvent(period, event) {
  if (event.isSpark) {
    addEvent(period.spark, { ...event, isSpark: false });
    return;
  }
  period.events += 1;
  period.totalTokens += event.totalTokens;
  period.apiPriceEquivalentUsd += event.apiPriceEquivalentUsd;
  period.apiPriceEquivalentUsdExact = addUsdStrings(
    period.apiPriceEquivalentUsdExact,
    event.priced?.totalUsd ?? "0",
  );
  addComponents(period.components, event.components);
  addComponentCosts(period.componentCosts, event.components, event.priced);
  for (const id of event.priced?.selectedPriceCardIds ?? []) {
    if (!period.priceCardIds.includes(id)) period.priceCardIds.push(id);
  }
  for (const item of event.priced?.priceCardBreakdown ?? []) {
    const row = period.priceCardBreakdown[item.priceCardId] ?? {
      priceCardId: item.priceCardId,
      events: 0,
      costUsd: "0",
    };
    row.events += item.events ?? 0;
    row.costUsd = addUsdStrings(row.costUsd, item.costUsd ?? "0");
    period.priceCardBreakdown[item.priceCardId] = row;
  }
  const model = period.byModel[event.model] ??= {
    model: event.model,
    pricingStatus: event.modelPricingStatus,
    allowanceTrack: event.modelAllowanceTrack,
    apiPriceEquivalentApplicable: event.modelApiPriceEquivalentApplicable,
    events: 0,
    totalTokens: 0,
    apiPriceEquivalentUsd: 0,
    // The same two crossings the period keeps, kept per model as well. Without
    // them a reader can see that a model holds most of the tokens and most of
    // the money but not which component carries either, which is the one
    // question a model table is asked. Each cell accumulates the amount the
    // event was actually priced at, so a card revised mid-period is carried
    // rather than flattened to a single rate.
    components: emptyComponents(),
    componentCosts: emptyComponentCosts(),
    pricingCoverage: {
      fullyPricedEvents: 0,
      partiallyPricedEvents: 0,
      unpricedEvents: 0,
    },
  };
  model.events += 1;
  model.totalTokens += event.totalTokens;
  model.apiPriceEquivalentUsd += event.apiPriceEquivalentUsd;
  addComponents(model.components, event.components);
  addComponentCosts(model.componentCosts, event.components, event.priced);
  model.pricingCoverage[
    event.pricingCoverageStatus === "fully_priced"
      ? "fullyPricedEvents"
      : event.pricingCoverageStatus === "partially_priced"
        ? "partiallyPricedEvents"
        : "unpricedEvents"
  ] += 1;
  addDimension(period.bySpeed, event.speed, event);
  addSpeedWeighting(period.speedWeighting, event);
  addDeclaredSpeedWeighting(period.declaredSpeedWeighting, event);
  addDimension(period.byApiServiceTier, event.apiServiceTier, event);
  addDimension(period.bySurface, event.surface, event);
  addDimension(period.byAgentScope, event.agentScope, event);
  addDimension(period.byLineage, event.lineage, event);
  if (event.pricingCoverageStatus === "fully_priced") {
    period.pricingCoverage.fullyPricedEvents += 1;
  } else if (event.pricingCoverageStatus === "partially_priced") {
    period.pricingCoverage.partiallyPricedEvents += 1;
  } else {
    period.pricingCoverage.unpricedEvents += 1;
  }
}

function roundedMoney(value) {
  return Number(value.toFixed(6));
}

// The period's numeric total is a display projection of the exact decimal
// ledger, not an independently accumulated binary-float sum. Round the
// decimal string at six places with decimal half-up semantics before converting
// it to the bounded numeric projection. This keeps a large aggregation stable
// at the exact half boundary (and avoids Number#toFixed's representation
// dependent result for values such as 0.0000005).
function roundedExactMoney(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/u.test(value)) {
    return Number.NaN;
  }
  const [whole, fraction = ""] = value.split(".");
  const retainedFraction = fraction.padEnd(6, "0").slice(0, 6);
  let scaled = BigInt(`${whole}${retainedFraction}`);
  if ((fraction[6] ?? "0") >= "5") scaled += 1n;
  const integerPart = scaled / 1_000_000n;
  const fractionalPart = String(scaled % 1_000_000n).padStart(6, "0");
  const numeric = Number(`${integerPart}.${fractionalPart}`);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

function finalizeDimension(dimension) {
  return Object.fromEntries(Object.entries(dimension).map(([key, row]) => [
    key,
    {
      ...row,
      apiPriceEquivalentUsd: roundedMoney(row.apiPriceEquivalentUsd),
    },
  ]));
}

function modelUsageRowSort(left, right) {
  return right.apiPriceEquivalentUsd - left.apiPriceEquivalentUsd
    || right.totalTokens - left.totalTokens
    || left.model.localeCompare(right.model);
}

// One row per model identity across every allowance track, for surfaces that
// render a single "model usage" table. `byModel` deliberately covers only the
// primary allowance, because the period's own event/token/cost totals exclude
// the separately metered Spark track and the two must stay reconcilable. A
// renderer that wants every model on one list needs this instead, and each
// row states which track it belongs to and whether an API-price equivalent is
// a meaningful figure for it at all.
function combinedModelUsage(finalized) {
  return [
    ...finalized.byModel,
    ...(finalized.spark?.byModel ?? []),
  ].sort(modelUsageRowSort);
}

function finalizePeriod(period) {
  const priced = period.pricingCoverage.fullyPricedEvents
    + period.pricingCoverage.partiallyPricedEvents;
  const finalized = {
    ...period,
    apiPriceEquivalentUsd: roundedExactMoney(
      period.apiPriceEquivalentUsdExact,
    ),
    priceCardIds: [...period.priceCardIds].sort(),
    priceCardBreakdown: Object.values(period.priceCardBreakdown).sort(
      (left, right) => left.priceCardId.localeCompare(right.priceCardId),
    ),
    pricedEventFraction: period.events === 0
      ? null
      : Number((priced / period.events).toFixed(6)),
    componentCosts: Object.fromEntries(
      Object.entries(period.componentCosts).map(([key, row]) => [
        key,
        { ...row, costUsd: roundedMoney(row.costUsd) },
      ]),
    ),
    byModel: Object.values(period.byModel)
      .map((row) => ({
        ...row,
        apiPriceEquivalentUsd: roundedMoney(row.apiPriceEquivalentUsd),
        componentCosts: Object.fromEntries(
          Object.entries(row.componentCosts).map(([key, cost]) => [
            key,
            { ...cost, costUsd: roundedMoney(cost.costUsd) },
          ]),
        ),
      }))
      .sort(modelUsageRowSort),
    bySpeed: finalizeDimension(period.bySpeed),
    byApiServiceTier: finalizeDimension(period.byApiServiceTier),
    bySurface: finalizeDimension(period.bySurface),
    byAgentScope: finalizeDimension(period.byAgentScope),
    byLineage: finalizeDimension(period.byLineage),
    speedWeighting: finalizeSpeedWeighting(period.speedWeighting),
    declaredSpeedWeighting: finalizeSpeedWeighting(
      period.declaredSpeedWeighting,
    ),
  };
  if (period.spark) finalized.spark = finalizePeriod(period.spark);
  finalized.modelUsage = combinedModelUsage(finalized);
  return finalized;
}

// Build one constant-memory accounting total from an already indexed event
// stream. Unlike the recent replay cache, this deliberately retains no raw
// transition inputs, quota timeline, or chart buckets: its only contract is a
// content-free aggregate whose price cards are selected at each event's own
// timestamp. This is what lets the archive grow beyond the 31-day interactive
// cache without turning an old Mac's history into an unbounded heap.
export async function buildReplaySafeAccountingPeriod({
  id = "history",
  label = "Indexed history",
  startAt,
  endAt,
  scan,
  signal = null,
  declaredSpeedBaselines = [],
  rss = () => process.memoryUsage().rss,
  maximumRssBytes = MAX_ACCOUNTING_RSS_BYTES,
} = {}) {
  const canonicalStart = canonicalInstant(startAt);
  const canonicalEnd = canonicalInstant(endAt);
  if (typeof id !== "string"
      || !/^[a-z][a-z0-9_-]{0,31}$/u.test(id)
      || typeof label !== "string"
      || label.length < 1
      || label.length > 96
      || canonicalStart === null
      || canonicalEnd === null
      || Date.parse(canonicalStart) > Date.parse(canonicalEnd)
      || typeof scan !== "function"
      || !validAbortSignal(signal)
      || typeof rss !== "function"
      || !Number.isSafeInteger(maximumRssBytes)
      || maximumRssBytes < 1) {
    throw new TypeError("Replay-safe accounting period options are invalid");
  }
  const baselines = Array.isArray(declaredSpeedBaselines)
    ? declaredSpeedBaselines
    : [];
  const startMs = Date.parse(canonicalStart);
  const endMs = Date.parse(canonicalEnd);
  const period = newPeriod(id, label);
  const price = createAccountingPricer();
  let acceptedEvents = 0;
  const checkRuntimeMemory = () => {
    const currentRss = rss();
    if (!Number.isSafeInteger(currentRss) || currentRss < 0) {
      throw fixedError("accounting_archive_rss_measurement_invalid");
    }
    if (currentRss > maximumRssBytes) {
      throw fixedError("accounting_archive_rss_limit_exceeded");
    }
  };
  checkRuntimeMemory();
  await scan({
    startAt: canonicalStart,
    endAt: canonicalEnd,
    signal,
    onUsage: (rawEvent) => {
      throwIfAborted(signal);
      const observedAt = canonicalInstant(rawEvent?.timestamp);
      if (observedAt === null) return;
      const observedMs = Date.parse(observedAt);
      if (observedMs < startMs || observedMs > endMs) return;
      const event = eventProjection(rawEvent, price);
      if (event === null) return;
      event.declaredSpeed = event.speed === "unknown"
        ? declaredSpeedModeAt(baselines, observedMs) ?? "unknown"
        : "unknown";
      addEvent(period, event);
      acceptedEvents += 1;
      if (acceptedEvents % ACCOUNTING_RSS_CHECK_INTERVAL === 0) {
        checkRuntimeMemory();
      }
    },
  });
  throwIfAborted(signal);
  checkRuntimeMemory();
  return {
    generatedAt: canonicalEnd,
    coveredAt: {
      startAt: canonicalStart,
      endAt: canonicalEnd,
    },
    priceEpochBasis: HISTORICAL_PRICE_EPOCH_BASIS,
    priceRegistryVersion: APP_PRICE_REGISTRY_MANIFEST.version,
    priceRegistryObservedAt: APP_PRICE_REGISTRY_MANIFEST.observedAt,
    period: finalizePeriod(period),
  };
}

function newTimelineBucket(startMs) {
  return {
    startMs,
    usageEvents: 0,
    totalTokens: 0,
    apiPriceEquivalentUsd: 0,
    speedWeighting: emptySpeedWeightingCrossing(),
    declaredSpeedWeighting: emptySpeedWeightingCrossing(),
    components: emptyComponents(),
    pricingCoverage: {
      fullyPricedEvents: 0,
      partiallyPricedEvents: 0,
      unpricedEvents: 0,
    },
  };
}

function addTimelineEvent(buckets, event) {
  const observedMs = Date.parse(event.timestamp);
  if (!Number.isFinite(observedMs)) return;
  const startMs = Math.floor(observedMs / TIMELINE_BUCKET_MS)
    * TIMELINE_BUCKET_MS;
  const bucket = buckets.get(startMs) ?? newTimelineBucket(startMs);
  bucket.usageEvents += 1;
  bucket.totalTokens += event.totalTokens;
  bucket.apiPriceEquivalentUsd += event.apiPriceEquivalentUsd;
  addSpeedWeighting(bucket.speedWeighting, event);
  addDeclaredSpeedWeighting(bucket.declaredSpeedWeighting, event);
  addComponents(bucket.components, event.components);
  bucket.pricingCoverage[
    event.pricingCoverageStatus === "fully_priced"
      ? "fullyPricedEvents"
      : event.pricingCoverageStatus === "partially_priced"
        ? "partiallyPricedEvents"
        : "unpricedEvents"
  ] += 1;
  buckets.set(startMs, bucket);
}

function finalizeTimeline(buckets) {
  return [...buckets.values()]
    .sort((left, right) => left.startMs - right.startMs)
    .map((bucket) => ({
      startAt: new Date(bucket.startMs).toISOString(),
      endAt: new Date(bucket.startMs + TIMELINE_BUCKET_MS).toISOString(),
      usageEvents: bucket.usageEvents,
      totalTokens: bucket.totalTokens,
      apiPriceEquivalentUsd: roundedMoney(bucket.apiPriceEquivalentUsd),
      speedWeighting: compactSpeedWeighting(bucket.speedWeighting),
      declaredSpeedWeighting: compactSpeedWeighting(
        bucket.declaredSpeedWeighting,
      ),
      components: bucket.components,
      pricingCoverage: bucket.pricingCoverage,
    }));
}

function publicDiagnostics(value) {
  return {
    filesScanned: Number.isSafeInteger(value?.filesScanned)
      ? value.filesScanned
      : 0,
    forkReplayEventsExcluded: Number.isSafeInteger(value?.forkReplayEventsSkipped)
      ? value.forkReplayEventsSkipped
      : 0,
    unattributedForkReplayEventsExcluded:
      Number.isSafeInteger(value?.unattributedForkReplayEventsSkipped)
        ? value.unattributedForkReplayEventsSkipped
        : 0,
    duplicateSnapshotsExcluded:
      Number.isSafeInteger(value?.duplicateSnapshotsSkipped)
        ? value.duplicateSnapshotsSkipped
        : 0,
    contradictedLeadingSnapshotsExcluded:
      Number.isSafeInteger(value?.contradictedLeadingSnapshotsSkipped)
        ? value.contradictedLeadingSnapshotsSkipped
        : 0,
    missingLineageParents: Number.isSafeInteger(value?.lineageParentsMissing)
      ? value.lineageParentsMissing
      : 0,
  };
}

export function defaultReplaySafeAccountingCachePath(
  root = process.cwd(),
) {
  return defaultLocalCollectorStatePath(root);
}

function cooperativeYield() {
  return new Promise((resolve) => setImmediate(resolve));
}

function firstIndexAtLeast(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstIndexAbove(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

// Mirror of the transition miner's windowKey over the compact snapshot
// encoding [timestamp, timestampMs, provider, planType, limitId, slot,
// windowDurationMins, resetsAt, usedPercent]. Transitions are derived from
// consecutive snapshots WITHIN one of these groups, never across groups,
// which is what makes the batched derivation below exact. Window identity is
// slot-agnostic (v0.6), exactly like the miner's windowKey: slot is a UI
// role, so grouping on it here would split one window's rows across batches
// wherever the server-side slot flipped mid-history and silently drop the
// transition that crosses the flip.
function compactSnapshotGroupKey(row) {
  return [row[2], row[3], row[4], row[6], row[7]].join("|");
}

// The transition miner refuses more than 10,000 derived rows per call — a
// structural memory-safety ceiling owned by codex-transition-miner.js, not a
// data-window policy. A full unbounded history legitimately holds more (the
// real corpus measured 18,176 weekly transitions over its first 82 days), so
// the derivation is partitioned by reset-window group and each batch stays
// under the ceiling with headroom. Cumulative aggregations are
// difference-based over each window's own span, so deriving disjoint group
// batches against a usage slice that covers every window start in the batch
// reproduces the unbatched result exactly.
const CALIBRATION_BATCH_TRANSITION_BUDGET = 8_000;
// The transition ceiling alone is not a useful memory bound: a few quota
// changes spread across many high-volume days can still make one batch decode
// hundreds of thousands of compact usage rows at once. Partition on the
// actual contiguous usage slice too. This is a working-set bound only; every
// row remains in exactly one derivation slice (apart from the intentional
// overlap required by overlapping reset windows), so it does not shorten the
// calibration history or discard evidence.
const CALIBRATION_BATCH_USAGE_BUDGET = 50_000;

async function deriveBoundedWeeklyCalibrationSeries({
  startAt,
  endAt,
  // Exactly one usage source: the windowed path passes its resident compact
  // rows; the unified path passes a streaming corpus handle so at most one
  // batch slice of priced rows is ever resident at a time.
  rawUsageEvents = null,
  usageCorpus = null,
  rateLimitSnapshots,
  diagnostics,
  signal,
  resourceCheck,
}) {
  if ((rawUsageEvents === null) === (usageCorpus === null)) {
    throw new TypeError(
      "deriveBoundedWeeklyCalibrationSeries requires exactly one usage source",
    );
  }
  const usageEventCount = usageCorpus === null
    ? rawUsageEvents.length
    : usageCorpus.count;
  const readUsageSlice = async (low, high) => (
    low >= high
      ? []
      : usageCorpus.readSlice(low, high)
  );
  const derive = (usage, snapshots) => deriveCodexTransitionSeriesCooperatively({
    startAt,
    endAt,
    rawUsageEvents: usage,
    rateLimitSnapshots: snapshots,
    diagnostics,
    includeSnapshotIntervals: false,
    windowDurationMins: WEEKLY_WINDOW_MINUTES,
    signal,
    consumeInputs: true,
    includeNormalizedInputs: false,
    inputEncoding: "accounting_prepriced_compact_v2",
    resourceCheck,
  });

  // Group the compact snapshots exactly as the miner will, and count the
  // transitions each group will derive: within a group the miner walks
  // deduplicated snapshots in (time, percent) order and emits one transition
  // per consecutive percent change, so this count is exact, not an estimate.
  const groups = new Map();
  for (let index = 0; index < rateLimitSnapshots.length; index += 1) {
    if (index % 8_192 === 0) {
      throwIfAborted(signal);
      resourceCheck?.();
      await cooperativeYield();
    }
    const row = rateLimitSnapshots[index];
    if (!Array.isArray(row) || row.length !== 9) continue;
    const key = compactSnapshotGroupKey(row);
    let group = groups.get(key);
    if (group === undefined) {
      group = { rows: [], dedupe: new Set(), deduped: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
    const dedupeKey = `${row[0]}|${row[8]}`;
    if (!group.dedupe.has(dedupeKey)) {
      group.dedupe.add(dedupeKey);
      group.deduped.push(row);
    }
  }
  let totalTransitions = 0;
  for (const group of groups.values()) {
    const ordered = [...group.deduped].sort(
      (left, right) => left[1] - right[1] || left[8] - right[8],
    );
    let transitions = 0;
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index][8] !== ordered[index - 1][8]) transitions += 1;
    }
    const durationMins = Number(ordered[0]?.[6]);
    const resetsAt = Number(ordered[0]?.[7]);
    const windowStartMs = (resetsAt - durationMins * 60) * 1_000;
    group.transitions = transitions;
    group.sliceStartMs = Number.isFinite(windowStartMs)
      ? windowStartMs
      : Number.NEGATIVE_INFINITY;
    group.firstMs = Number(ordered[0]?.[1] ?? 0);
    group.lastMs = Number(ordered.at(-1)?.[1] ?? 0);
    totalTransitions += transitions;
  }
  throwIfAborted(signal);
  resourceCheck?.();

  if (totalTransitions <= CALIBRATION_BATCH_TRANSITION_BUDGET
      && usageEventCount <= CALIBRATION_BATCH_USAGE_BUDGET) {
    const usage = usageCorpus === null
      ? rawUsageEvents
      : await readUsageSlice(0, usageEventCount);
    const series = await derive(usage, rateLimitSnapshots);
    return {
      transitions: series.transitions,
      deduplicatedSnapshotCount: series.deduplicatedSnapshotCount,
    };
  }

  // Sort the compact usage rows once so every batch can take the contiguous
  // slice that covers its groups' windows. Rows without a parseable timestamp
  // would be dropped by the miner's own normalization, so excluding them here
  // changes nothing. The streaming corpus arrives already ordered and stamped,
  // so it supplies the timestamp list directly and each batch's rows are read
  // off the index on demand instead of being sliced out of a resident copy.
  let sortedUsage = null;
  let sortedMs;
  if (usageCorpus === null) {
    const stamped = [];
    for (let index = 0; index < rawUsageEvents.length; index += 1) {
      if (index % 8_192 === 0) {
        throwIfAborted(signal);
        resourceCheck?.();
        await cooperativeYield();
      }
      const observedMs = Date.parse(rawUsageEvents[index]?.[0]);
      if (Number.isFinite(observedMs)) stamped.push([observedMs, index]);
    }
    stamped.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    sortedUsage = stamped.map(([, index]) => rawUsageEvents[index]);
    sortedMs = stamped.map(([observedMs]) => observedMs);
    stamped.length = 0;
  } else {
    sortedMs = usageCorpus.usageMs;
  }

  const orderedGroups = [...groups.values()].sort((left, right) => (
    left.sliceStartMs - right.sliceStartMs
    || left.firstMs - right.firstMs
    || left.lastMs - right.lastMs
  ));
  const batches = [];
  let current = null;
  for (const group of orderedGroups) {
    const nextSliceStartMs = Math.min(
      current?.sliceStartMs ?? Number.POSITIVE_INFINITY,
      group.sliceStartMs,
    );
    const nextSliceEndMs = Math.max(
      current?.sliceEndMs ?? Number.NEGATIVE_INFINITY,
      group.lastMs,
    );
    const nextUsageRows = firstIndexAbove(sortedMs, nextSliceEndMs)
      - (nextSliceStartMs === Number.NEGATIVE_INFINITY
        ? 0
        : firstIndexAtLeast(sortedMs, nextSliceStartMs));
    if (current === null
        || (current.groups.length > 0
          && (current.transitions + group.transitions
              > CALIBRATION_BATCH_TRANSITION_BUDGET
            || nextUsageRows > CALIBRATION_BATCH_USAGE_BUDGET))) {
      current = {
        groups: [],
        transitions: 0,
        sliceStartMs: Number.POSITIVE_INFINITY,
        sliceEndMs: Number.NEGATIVE_INFINITY,
      };
      batches.push(current);
    }
    current.groups.push(group);
    current.transitions += group.transitions;
    current.sliceStartMs = Math.min(current.sliceStartMs, group.sliceStartMs);
    current.sliceEndMs = Math.max(current.sliceEndMs, group.lastMs);
  }

  const transitions = [];
  let deduplicatedSnapshotCount = 0;
  for (const batch of batches) {
    throwIfAborted(signal);
    resourceCheck?.();
    const low = batch.sliceStartMs === Number.NEGATIVE_INFINITY
      ? 0
      : firstIndexAtLeast(sortedMs, batch.sliceStartMs);
    const high = firstIndexAbove(sortedMs, batch.sliceEndMs);
    const usageSlice = usageCorpus === null
      ? sortedUsage.slice(low, high)
      : await readUsageSlice(low, high);
    const snapshotSlice = [];
    for (const group of batch.groups) snapshotSlice.push(...group.rows);
    const series = await derive(usageSlice, snapshotSlice);
    transitions.push(...series.transitions);
    deduplicatedSnapshotCount += series.deduplicatedSnapshotCount;
  }
  if (rawUsageEvents !== null) rawUsageEvents.length = 0;
  rateLimitSnapshots.length = 0;
  transitions.sort((left, right) => left.eventTime.localeCompare(right.eventTime)
    || left.resetIdentity.localeCompare(right.resetIdentity)
    || left.windowDurationMins - right.windowDurationMins
    || left.slot.localeCompare(right.slot));
  return { transitions, deduplicatedSnapshotCount };
}

const UNIFIED_CALIBRATION_READ_BATCH_ROWS = 20_000;
const COMPOSITION_RECENT_MIX_DAYS = 14;
const COMPOSITION_FIT_FAILURE_REASON_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;

// A bounded, machine-safe reason for a failed composition fit: the typed
// error code when one exists, the error name otherwise. Never free-form
// message text — messages can carry paths.
function compositionFitFailureReason(error) {
  const candidate = typeof error?.code === "string" && error.code.length > 0
    ? error.code
    : typeof error?.name === "string" && error.name.length > 0
      ? error.name
      : "unknown";
  return COMPOSITION_FIT_FAILURE_REASON_PATTERN.test(candidate)
    ? candidate
    : "unknown";
}

/**
 * Fit the composition-aware per-model $/pp vector from the SAME compact
 * corpus the weekly calibration derivation is about to consume. Runs BEFORE
 * `deriveBoundedWeeklyCalibrationSeries` because that call destroys its input
 * arrays; this one only reads them.
 *
 * Compact encodings (see transitionUsageProjection /
 * weeklyRateLimitProjection): usage [0]=ISO timestamp, [1]=model,
 * [10]=costUsd; snapshot [1]=timestampMs, [3]=planType,
 * [7]=resetsAt seconds, [8]=usedPercent.
 *
 * Memory: the usage corpus is folded straight into per-(grain-bin, model)
 * cost sums in ONE streaming pass — the recent-mix accumulation shares that
 * pass — so peak extra memory is O(bins), never a second O(events) corpus
 * copy (a full-history corpus of ~487k compact rows previously materialized
 * ~487k intermediate objects here and pushed the process over the accounting
 * RSS ceiling). The kernel consumes one aggregated row per (bin, model);
 * bin starts are grain-aligned, so the kernel's own `Math.floor` binning is
 * idempotent on them and its design matrix is exactly what the per-event
 * corpus produced.
 *
 * Never throws for corpus reasons: a thin or collinear corpus degrades to a
 * typed non-fitted status inside the kernel, and the caller stores whatever
 * status came back. Resource pressure and aborts DO throw — the streaming
 * loops check the signal and the RSS guard on the same
 * ACCOUNTING_RSS_CHECK_INTERVAL cadence as every other build phase.
 *
 * Exported for tests only (streaming-vs-per-event equivalence and metering
 * cadence); production callers stay on buildReplaySafeAccountingCache.
 */
export async function fitCompositionFromCompactCorpus({
  rawUsageEvents,
  weeklyRateLimitSnapshots,
  endMs,
  signal = null,
  checkRuntimeMemory = () => {},
}) {
  return fitCompositionFromCorpusStream({
    forEachUsageRow: async (consume) => {
      for (const row of rawUsageEvents) await consume(row);
    },
    weeklyRateLimitSnapshots,
    endMs,
    signal,
    checkRuntimeMemory,
  });
}

// The fold behind fitCompositionFromCompactCorpus, taking the usage corpus as
// a row visitor instead of a resident array. The unified path streams rows
// straight off the index through this — the corpus is never resident — while
// the windowed path drives it from its in-memory array; both fold in the same
// order with the same cadence, so the fit is identical either way.
async function fitCompositionFromCorpusStream({
  forEachUsageRow,
  weeklyRateLimitSnapshots,
  endMs,
  signal = null,
  checkRuntimeMemory = () => {},
}) {
  const grainMs = MODEL_COMPOSITION_POLICY.grainMs;
  const recentStartMs = endMs - COMPOSITION_RECENT_MIX_DAYS * 24 * 60 * 60 * 1_000;
  // binStartMs -> Map(model -> summed costUsd), Maps kept in first-encounter
  // order so the kernel accumulates in the same order the per-event path did
  // and the fit stays bit-identical.
  const binCosts = new Map();
  const recentMix = {};
  let processed = 0;
  await forEachUsageRow(async (row) => {
    processed += 1;
    if (processed % ACCOUNTING_RSS_CHECK_INTERVAL === 0) {
      throwIfAborted(signal);
      checkRuntimeMemory();
      await cooperativeYield();
    }
    if (!Array.isArray(row)) return;
    const observedAtMs = Date.parse(row[0]);
    const costUsd = Number(row[10]);
    if (!Number.isFinite(observedAtMs)
        || typeof row[1] !== "string"
        || !Number.isFinite(costUsd)
        || costUsd < 0) return;
    const model = row[1];
    // The kernel's own binning refuses empty model names; the recent mix
    // mirrors the historical per-event behavior and keeps them.
    if (model.length > 0) {
      const binStartMs = Math.floor(observedAtMs / grainMs) * grainMs;
      let costs = binCosts.get(binStartMs);
      if (costs === undefined) {
        costs = new Map();
        binCosts.set(binStartMs, costs);
      }
      costs.set(model, (costs.get(model) ?? 0) + costUsd);
    }
    if (observedAtMs >= recentStartMs) {
      recentMix[model] = (recentMix[model] ?? 0) + costUsd;
    }
  });
  const quotaRows = [];
  for (const row of weeklyRateLimitSnapshots) {
    processed += 1;
    if (processed % ACCOUNTING_RSS_CHECK_INTERVAL === 0) {
      throwIfAborted(signal);
      checkRuntimeMemory();
      await cooperativeYield();
    }
    if (!Array.isArray(row)) continue;
    const observedAtMs = Number(row[1]);
    const resetsAtSeconds = Number(row[7]);
    const usedPercent = Number(row[8]);
    if (!Number.isFinite(observedAtMs)
        || !Number.isFinite(resetsAtSeconds)
        || !Number.isFinite(usedPercent)) continue;
    quotaRows.push({
      observedAtMs,
      planType: typeof row[3] === "string" ? row[3] : "unknown",
      resetsAtMs: resetsAtSeconds * 1_000,
      usedPercent,
    });
  }
  // One aggregated row per (bin, model): O(bins x models), not O(events).
  const usageRows = [];
  for (const [binStartMs, costs] of binCosts) {
    for (const [model, costUsd] of costs) {
      usageRows.push({ observedAtMs: binStartMs, model, costUsd });
    }
  }
  binCosts.clear();
  const { observations, voidedBinCount, poolCount } =
    buildCompositionObservations({ usageRows, quotaRows });
  const fit = calibrateCompositionCapacities(observations);
  const blendedRecentMixUsd = fit.status === "fitted"
    ? blendedCompositionCapacityUsd(recentMix, {
      capacityUsdByModel: fit.capacityUsdByModel,
      fallbackCapacityUsd: fit.singleConstantUsd,
    })
    : null;
  return {
    status: fit.status,
    grainHours: MODEL_COMPOSITION_POLICY.grainMs / 3_600_000,
    observationCount: fit.observationCount,
    voidedBinCount,
    poolCount,
    capacityUsdByModel: fit.capacityUsdByModel,
    modelCostShares: fit.modelCostShares,
    r2: fit.r2,
    singleConstantUsd: fit.singleConstantUsd,
    singleConstantR2: fit.singleConstantR2,
    // Why a fit was ACCEPTED or REJECTED. Without this a fallback_blended
    // reaches the dashboard with no recoverable reason, and recovering it costs
    // a full re-run of the kernel against the corpus (2026-08-20). The gate at
    // model-composition.js reads these exact fields, so persisting them is what
    // makes the decision auditable after the fact.
    identification: fit.identification ?? null,
    blendedRecentMixUsd: Number.isFinite(blendedRecentMixUsd)
      ? Number(blendedRecentMixUsd.toFixed(2))
      : null,
    recentMixDays: COMPOSITION_RECENT_MIX_DAYS,
  };
}

/**
 * Cheap usability probe for the unified calibration corpus, run BEFORE the
 * scan so the scan can skip retaining its own window-bounded transition
 * inputs. The corpus itself is materialized only AFTER the scan finishes:
 * holding both the corpus and the scan's working set at once measured past
 * the accounting RSS ceiling on the real dev corpus, while sequencing them
 * keeps the peak to whichever is larger.
 */
async function probeUnifiedCalibrationCorpus(indexFile) {
  let metadata;
  try {
    metadata = await lstat(indexFile);
  } catch {
    return false;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
  let database;
  try {
    database = openLocalUnifiedIndex(indexFile, { readOnly: true });
  } catch {
    return false;
  }
  try {
    const hasUsage = database.prepare(
      "SELECT 1 AS present FROM usage_event LIMIT 1",
    ).get()?.present === 1;
    const hasWeeklyQuota = database.prepare(`
      SELECT 1 AS present FROM quota_observation
      WHERE limit_id = 'codex' AND duration_mins = ?
        AND used_percent IS NOT NULL AND resets_at_ms IS NOT NULL
      LIMIT 1`).get(WEEKLY_WINDOW_MINUTES)?.present === 1;
    return hasUsage && hasWeeklyQuota;
  } catch {
    return false;
  } finally {
    database.close();
  }
}

function sameIndexFileIdentity(before, after) {
  const canCompareIdentity = [
    before?.dev,
    before?.ino,
    after?.dev,
    after?.ino,
  ].every((value) => value !== undefined && value !== null);
  return !canCompareIdentity
    || (before.dev === after.dev && before.ino === after.ino);
}

function publishedUnifiedGenerationTokens(database) {
  const descriptor = readUnifiedIndexGenerationDescriptor(database);
  if (descriptor === null) return [];
  return [
    generationIdMetaToken(descriptor.id),
    generationToken(descriptor.fingerprint),
  ].filter((token) => token !== null);
}

/**
 * The full-history weekly-calibration corpus, opened as a streaming source
 * over the unified local index in the same compact pre-priced encoding the
 * windowed scan retains.
 *
 * This is what removes the calibration's data window: `usage_event` and
 * `quota_observation` have no lower time bound, so the corpus spans everything
 * ever indexed. The only remaining bound is the transition miner's structural
 * input ceiling (750k usage events — count-based memory safety owned by
 * codex-transition-miner.js, not a day window; it covers years of typical use
 * and 130+ days of the heaviest observed usage). When the corpus exceeds it,
 * the newest rows are retained and the returned `coveredAt` names the span
 * honestly.
 *
 * Residency: the priced compact rows are NEVER all resident at once. A full
 * corpus at the 750k ceiling measured ~635 real bytes per materialized row —
 * ~454 MB of RSS against the 256 B/row the byte meter charges — and holding
 * it was what pushed a large-corpus companion over the accounting RSS ceiling
 * on every rebuild attempt: each deferred pass restarted from scratch against
 * the same corpus and the same fossilized baseline, so the rebuild never
 * landed (live 0.1.13 incident, 2026-08-19). The open pass therefore retains
 * only a thin (observedMs, rowid) stamp per retained row (~16 bytes), and the
 * fit and the batched derivation re-read priced rows off the index on demand
 * — the fit as one streaming fold, the derivation one bounded batch slice at
 * a time — so peak corpus residency is O(batch), not O(history).
 *
 * Quota rows are collapsed to the first and last observation of each
 * unchanged (window, percent) run before retention. The miner derives a
 * transition only where the displayed percent changes between consecutive
 * observations of one window, so this collapse is transition-lossless while
 * shrinking hundreds of thousands of repeated readings to the boundaries the
 * calibration actually uses. The collapsed snapshots stay resident (they are
 * the bounded, high-value rows); only the usage corpus streams.
 *
 * Open failures degrade to `null` — the caller then fails the build closed,
 * because the pre-scan probe already promised this corpus — except aborts and
 * the build's own resource-guard errors, which propagate. The returned source
 * holds its read handle open until `finish()` (which re-verifies the
 * generation and the file identity, exactly the checks the one-shot reader
 * ran at its end) or `dispose()` on an error path.
 */
async function openUnifiedIndexCalibrationCorpus({
  indexFile,
  endMs,
  limits,
  declaredSpeedBaselines,
  signal,
  checkRuntimeMemory,
  expectedGeneration = null,
}) {
  let metadata;
  try {
    metadata = await lstat(indexFile);
  } catch {
    return null;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
  let database;
  try {
    database = openLocalUnifiedIndex(indexFile, { readOnly: true });
  } catch {
    return null;
  }
  let closed = false;
  const dispose = () => {
    if (closed) return;
    closed = true;
    try {
      database.close();
    } catch {
      // A close failure cannot make the read-only handle more open.
    }
  };
  const verifyGeneration = () => {
    if (expectedGeneration === null || expectedGeneration === undefined) return;
    const expected = expectedGenerationTokens(expectedGeneration);
    const observed = publishedUnifiedGenerationTokens(database);
    if (expected.length === 0
        || !generationMatchesExpected(expectedGeneration, observed)) {
      throw fixedError("accounting_unified_generation_mismatch");
    }
  };
  const usageGraceMs = endMs + 5 * 60_000;
  const price = createAccountingPricer();
  // Shared row-count cadence across every read this source performs (the open
  // pass and the later re-read streams continue one counter), matching the
  // one-shot reader's single `processed` counter.
  let processed = 0;
  const cadence = async () => {
    processed += 1;
    if (processed % ACCOUNTING_RSS_CHECK_INTERVAL === 0) {
      throwIfAborted(signal);
      checkRuntimeMemory();
      await cooperativeYield();
    }
  };
  const tokenValue = (value) => (
    Number.isSafeInteger(Number(value)) && Number(value) >= 0
      ? Number(value)
      : 0
  );
  // Mirrors exactly the rows the priced projection below retains, without
  // paying for pricing: eventProjection returns null only for an all-zero
  // component total, and Spark rows are excluded from the calibration corpus.
  // The discovery pass and the re-read streams share this predicate, so they
  // can never disagree about which rows the corpus contains.
  const retainedByLightFilter = (row) => {
    if (!Number.isSafeInteger(Number(row.observed_at_ms))) return false;
    const anyTokens = tokenValue(row.tokens_in_uncached) > 0
      || tokenValue(row.tokens_in_cache_read) > 0
      || tokenValue(row.tokens_in_cache_write) > 0
      || tokenValue(row.tokens_out_text) > 0
      || tokenValue(row.tokens_out_reasoning) > 0
      || tokenValue(row.tokens_out_combined) > 0;
    return anyTokens && safeModel(row.model_id) !== SPARK_MODEL;
  };
  // The priced compact projection, identical to the windowed scan's retention
  // shape. Returns null for exactly the rows retainedByLightFilter refuses.
  const projectUsageRow = (row) => {
    const observedMs = Number(row.observed_at_ms);
    if (!Number.isSafeInteger(observedMs)) return null;
    const rawEvent = {
      timestamp: new Date(observedMs).toISOString(),
      model: row.model_id,
      // NULL means "the record did not report a total"; it must stay
      // absent so the pricer bands by the summed input components exactly
      // as it does on the scan path, instead of reading NULL as zero.
      ...(row.total_input_context === null
        ? {}
        : { totalInputContextTokens: Number(row.total_input_context) }),
      components: {
        input_uncached_tokens: tokenValue(row.tokens_in_uncached),
        input_cache_read_tokens: tokenValue(row.tokens_in_cache_read),
        input_cache_write_tokens: tokenValue(row.tokens_in_cache_write),
        output_text_tokens: tokenValue(row.tokens_out_text),
        output_reasoning_tokens: tokenValue(row.tokens_out_reasoning),
        output_combined_tokens: tokenValue(row.tokens_out_combined),
      },
      tierSemantics: {
        codexSpeedMode: row.codex_speed_mode,
        apiServiceTier: row.api_service_tier,
      },
    };
    const event = eventProjection(rawEvent, price);
    // The calibration corpus mirrors the scan retention exactly: no
    // zero-token rows, and no separately metered Spark rows.
    if (event === null || event.isSpark) return null;
    event.declaredSpeed = event.speed === "unknown"
      ? declaredSpeedModeAt(declaredSpeedBaselines, observedMs) ?? "unknown"
      : "unknown";
    return transitionUsageProjection(rawEvent, event);
  };
  const USAGE_COLUMNS = `
      SELECT u.rowid AS row_id,
             u.observed_at_ms AS observed_at_ms,
             m.model_id AS model_id,
             t.codex_speed_mode AS codex_speed_mode,
             t.api_service_tier AS api_service_tier,
             u.tokens_in_uncached AS tokens_in_uncached,
             u.tokens_in_cache_read AS tokens_in_cache_read,
             u.tokens_in_cache_write AS tokens_in_cache_write,
             u.tokens_out_text AS tokens_out_text,
             u.tokens_out_reasoning AS tokens_out_reasoning,
             u.tokens_out_combined AS tokens_out_combined,
             u.total_input_context AS total_input_context
      FROM usage_event u
      JOIN model m ON m.id = u.model_id
      JOIN tier_semantics t ON t.id = u.tier_id`;
  try {
    verifyGeneration();
    const usageCount = Number(database.prepare(
      "SELECT COUNT(*) AS c FROM usage_event WHERE observed_at_ms <= ?",
    ).get(usageGraceMs)?.c ?? 0);
    if (usageCount === 0) {
      dispose();
      return null;
    }
    let retainedStartMs = null;
    if (usageCount > limits.usageEvents) {
      const cutoff = database.prepare(`
        SELECT observed_at_ms AS ms FROM usage_event
        WHERE observed_at_ms <= ?
        ORDER BY observed_at_ms DESC
        LIMIT 1 OFFSET ?`).get(usageGraceMs, limits.usageEvents - 1);
      retainedStartMs = Number(cutoff?.ms);
      if (!Number.isSafeInteger(retainedStartMs)) {
        dispose();
        return null;
      }
    }

    const usageStatement = database.prepare(`${USAGE_COLUMNS}
      WHERE u.rowid > ? AND u.observed_at_ms >= ? AND u.observed_at_ms <= ?
      ORDER BY u.rowid
      LIMIT ${UNIFIED_CALIBRATION_READ_BATCH_ROWS}`);
    // Discovery pass: thin (observedMs, rowid) stamps for the rows the corpus
    // retains, in the same rowid stream order the one-shot reader walked.
    const stampedMs = [];
    const stampedRowid = [];
    let afterRowId = -1;
    const lowerBoundMs = retainedStartMs ?? -1;
    for (;;) {
      const batch = usageStatement.all(afterRowId, lowerBoundMs, usageGraceMs);
      if (batch.length === 0) break;
      for (const row of batch) {
        await cadence();
        if (!retainedByLightFilter(row)) continue;
        stampedMs.push(Number(row.observed_at_ms));
        stampedRowid.push(Number(row.row_id));
        // Projected-bytes accounting per retained row, mirroring the windowed
        // path's reserveTransitionInput: the byte budget bounds what the
        // derivation may RETAIN, so the moment the discovered working set
        // projects past it the read refuses — it never finishes discovering a
        // corpus the final gate was always going to reject. (The retention
        // cutoff bounds the row COUNT up to timestamp ties; only this check
        // bounds bytes.)
        if (stampedMs.length * COMPACT_USAGE_RETAINED_BYTES
            > limits.retainedBytes) {
          dispose();
          return null;
        }
      }
      afterRowId = Number(batch.at(-1).row_id);
      if (batch.length < UNIFIED_CALIBRATION_READ_BATCH_ROWS) break;
    }
    if (stampedMs.length === 0) {
      dispose();
      return null;
    }
    // Retained order is (observedMs, rowid): the one-shot reader's stable
    // ms-sort over a rowid-ordered stream produced exactly this order.
    const order = stampedMs.map((_, index) => index);
    order.sort((left, right) => stampedMs[left] - stampedMs[right]
      || stampedRowid[left] - stampedRowid[right]);
    const dropped = Math.max(0, order.length - limits.usageEvents);
    const usageMs = new Array(order.length - dropped);
    const usageRowid = new Array(order.length - dropped);
    for (let index = dropped; index < order.length; index += 1) {
      usageMs[index - dropped] = stampedMs[order[index]];
      usageRowid[index - dropped] = stampedRowid[order[index]];
    }
    order.length = 0;
    stampedMs.length = 0;
    stampedRowid.length = 0;
    const retainedUsageEvents = usageMs.length;
    const firstUsageMs = usageMs[0];

    const snapshotLowerMs = retainedStartMs === null
      ? -1
      : firstUsageMs;
    const snapshotStatement = database.prepare(`
      SELECT observed_at_ms, slot, plan_type, used_percent, resets_at_ms
      FROM quota_observation
      WHERE limit_id = 'codex' AND duration_mins = ?
        AND used_percent IS NOT NULL AND resets_at_ms IS NOT NULL
        AND observed_at_ms >= ? AND observed_at_ms <= ?
      ORDER BY observed_at_ms, id`);
    const weeklyRateLimitSnapshots = [];
    let firstSnapshotMs = null;
    const groupRuns = new Map();
    // Incremental reservation for every snapshot row the collapse decides to
    // retain, mirroring reserveTransitionInput on the windowed path: bytes,
    // snapshot count, and combined count are all checked BEFORE the row is
    // materialized, so the retained corpus can never sit fully resident past
    // `limits` with the refusal still ahead of it. Once tripped, the read
    // stops consuming the snapshot stream entirely and reports the corpus
    // unusable (null -> the caller's typed
    // accounting_calibration_corpus_unavailable).
    const retainedUsageBytes =
      retainedUsageEvents * COMPACT_USAGE_RETAINED_BYTES;
    let retainedInputBudgetExceeded = false;
    const reserveSnapshotRetention = () => {
      const retainedSnapshots = weeklyRateLimitSnapshots.length + 1;
      if (retainedSnapshots > limits.weeklySnapshots
          || retainedUsageEvents + retainedSnapshots > limits.combinedInputs
          || retainedUsageBytes
            + retainedSnapshots * COMPACT_SNAPSHOT_RETAINED_BYTES
            > limits.retainedBytes) {
        retainedInputBudgetExceeded = true;
        return false;
      }
      return true;
    };
    const emit = (pending) => {
      if (!reserveSnapshotRetention()) return;
      weeklyRateLimitSnapshots.push(weeklyRateLimitProjection({
        timestamp: new Date(pending.observedMs).toISOString(),
        timestampMs: pending.observedMs,
        window: {
          provider: "openai_codex",
          planType: pending.planType,
          limitId: "codex",
          slot: pending.slot,
          windowDurationMins: WEEKLY_WINDOW_MINUTES,
          resetsAt: pending.resetsAtSec,
          usedPercent: pending.usedPercent,
        },
      }));
    };
    for (const row of snapshotStatement.iterate(
      WEEKLY_WINDOW_MINUTES,
      snapshotLowerMs,
      endMs,
    )) {
      // Stop reading the stream the moment retention refused a row: every
      // later row would either be refused too or misrepresent a corpus that
      // is already over budget as complete. (Break rather than return: the
      // handle cannot close while this statement iterator is live, and every
      // later reservation attempt fails the same monotone budget check.)
      if (retainedInputBudgetExceeded) break;
      await cadence();
      const observedMs = Number(row.observed_at_ms);
      const resetsAtSec = Math.floor(Number(row.resets_at_ms) / 1_000);
      const usedPercent = Number(row.used_percent);
      if (!Number.isSafeInteger(observedMs)
          || !Number.isSafeInteger(resetsAtSec)
          || resetsAtSec <= 0
          || !Number.isFinite(usedPercent)) continue;
      if (firstSnapshotMs === null) firstSnapshotMs = observedMs;
      const projected = {
        observedMs,
        slot: row.slot,
        planType: typeof row.plan_type === "string" && row.plan_type.length > 0
          ? row.plan_type
          : "unknown",
        usedPercent,
        resetsAtSec,
      };
      // Slot is a UI role, not identity: a run of identical displayed states
      // that crosses the server-side slot flip is still one run of the same
      // (limit, duration, reset) window.
      const groupKey = `${projected.planType}\0${resetsAtSec}`;
      const run = groupRuns.get(groupKey);
      if (run !== undefined && run.usedPercent === usedPercent) {
        // Same displayed state as the previous observation of this window:
        // remember it as the run's pending last row, emit it only when the
        // state changes or the stream ends.
        run.pending = projected;
        continue;
      }
      if (run?.pending) emit(run.pending);
      emit(projected);
      groupRuns.set(groupKey, { usedPercent, pending: null });
    }
    for (const run of groupRuns.values()) {
      if (run.pending) emit(run.pending);
    }
    if (retainedInputBudgetExceeded || weeklyRateLimitSnapshots.length === 0) {
      dispose();
      return null;
    }
    if (weeklyRateLimitSnapshots.length > limits.weeklySnapshots
        || retainedUsageEvents + weeklyRateLimitSnapshots.length
          > limits.combinedInputs
        || retainedUsageEvents * COMPACT_USAGE_RETAINED_BYTES
          + weeklyRateLimitSnapshots.length * COMPACT_SNAPSHOT_RETAINED_BYTES
          > limits.retainedBytes) {
      dispose();
      return null;
    }
    throwIfAborted(signal);
    checkRuntimeMemory();
    const coveredStartMs = firstSnapshotMs === null
      ? firstUsageMs
      : Math.min(firstUsageMs, firstSnapshotMs);
    verifyGeneration();
    let openMetadata;
    try {
      openMetadata = await lstat(indexFile);
    } catch {
      throw fixedError("accounting_unified_generation_changed");
    }
    if (!sameIndexFileIdentity(metadata, openMetadata)) {
      throw fixedError("accounting_unified_generation_changed");
    }

    // Keyset re-read over the retained (observedMs, rowid) range. The first
    // page is inclusive of the range start; continuations resume strictly
    // after the last row served. Rows the discovery pass refused are refused
    // again here by the shared predicate, so a range stream yields exactly
    // the retained rows between its bounds — verified by count below, which
    // turns any mid-build index mutation into a typed refusal instead of a
    // silently drifted corpus.
    const firstPageStatement = database.prepare(`${USAGE_COLUMNS}
      WHERE (u.observed_at_ms, u.rowid) >= (?, ?)
        AND (u.observed_at_ms, u.rowid) <= (?, ?)
      ORDER BY u.observed_at_ms, u.rowid
      LIMIT ${UNIFIED_CALIBRATION_READ_BATCH_ROWS}`);
    const nextPageStatement = database.prepare(`${USAGE_COLUMNS}
      WHERE (u.observed_at_ms, u.rowid) > (?, ?)
        AND (u.observed_at_ms, u.rowid) <= (?, ?)
      ORDER BY u.observed_at_ms, u.rowid
      LIMIT ${UNIFIED_CALIBRATION_READ_BATCH_ROWS}`);
    const streamProjectedRange = async (low, high, consume) => {
      if (closed) {
        throw fixedError("accounting_calibration_corpus_unavailable");
      }
      const endBoundMs = usageMs[high - 1];
      const endBoundRowid = usageRowid[high - 1];
      let cursorMs = usageMs[low];
      let cursorRowid = usageRowid[low];
      let statement = firstPageStatement;
      let served = 0;
      try {
        for (;;) {
          const batch = statement.all(
            cursorMs,
            cursorRowid,
            endBoundMs,
            endBoundRowid,
          );
          if (batch.length === 0) break;
          for (const row of batch) {
            await cadence();
            const projected = projectUsageRow(row);
            if (projected === null) continue;
            served += 1;
            await consume(projected);
          }
          const last = batch.at(-1);
          cursorMs = Number(last.observed_at_ms);
          cursorRowid = Number(last.row_id);
          statement = nextPageStatement;
          if (batch.length < UNIFIED_CALIBRATION_READ_BATCH_ROWS) break;
        }
      } catch (error) {
        if (error?.name === "AbortError"
            || (typeof error?.code === "string"
              && error.code.startsWith("accounting_"))) {
          throw error;
        }
        // A raw read failure after open degrades to the same typed refusal
        // the one-shot reader's caller raised, never a bare SQLite error.
        throw fixedError("accounting_calibration_corpus_unavailable");
      }
      if (served !== high - low) {
        throw fixedError("accounting_unified_generation_changed");
      }
    };
    return {
      coveredAt: {
        startAt: new Date(coveredStartMs).toISOString(),
        endAt: new Date(endMs).toISOString(),
      },
      retainedUsageEvents,
      weeklyRateLimitSnapshots,
      usageMs,
      readUsageSlice: async (low, high) => {
        if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high)
            || low < 0 || high > retainedUsageEvents || low >= high) {
          throw new TypeError("Calibration usage slice bounds are invalid");
        }
        const rows = [];
        await streamProjectedRange(low, high, (row) => rows.push(row));
        return rows;
      },
      forEachRetainedUsage: async (consume) => {
        await streamProjectedRange(0, retainedUsageEvents, consume);
      },
      finish: async () => {
        if (closed) return;
        try {
          verifyGeneration();
          let finalMetadata;
          try {
            finalMetadata = await lstat(indexFile);
          } catch {
            throw fixedError("accounting_unified_generation_changed");
          }
          if (!sameIndexFileIdentity(metadata, finalMetadata)) {
            throw fixedError("accounting_unified_generation_changed");
          }
        } finally {
          dispose();
        }
      },
      dispose,
    };
  } catch (error) {
    dispose();
    if (error?.name === "AbortError"
        || (typeof error?.code === "string"
          && error.code.startsWith("accounting_"))) {
      throw error;
    }
    return null;
  }
}

export async function buildReplaySafeAccountingCache({
  codexHome = join(homedir(), ".codex"),
  now = () => Date.now(),
  windowDays = DEFAULT_WINDOW_DAYS,
  // Direct builders historically accepted an injected raw scanner. Keep that
  // characterization seam usable, while refreshReplaySafeAccountingCache
  // selects the unified reader explicitly for production.
  scan = null,
  sourceMode = null,
  expectedGeneration = null,
  contextBehavior = DEFAULT_ACCOUNTING_CONTEXT_BEHAVIOR,
  signal = null,
  // Timestamped Codex `service_tier` readings. Each covers only the interval
  // it was actually observed over, so a reading can never reach back before it
  // happened. An absent or unreadable ledger is simply no coverage.
  declaredSpeedBaselines = [],
  // The unified local index. When present and readable, the weekly
  // calibration transition corpus is read from it — the full indexed history,
  // with no time window at all — and the scan-window corpus becomes the
  // fallback for machines that do not have the index yet.
  unifiedIndexFile = null,
  transitionResourceLimits: requestedTransitionResourceLimits = null,
  rss = () => process.memoryUsage().rss,
  maximumRssBytes = MAX_ACCOUNTING_RSS_BYTES,
} = {}) {
  if (scan === null && (sourceMode === null || sourceMode === undefined)) {
    throw fixedError("accounting_source_required");
  }
  const selectedSourceMode = normalizeAccountingSourceMode(sourceMode);
  const selectedContextBehavior = normalizeContextBehavior(contextBehavior);
  if (selectedSourceMode === "unified"
      && (expectedGeneration === null || expectedGeneration === undefined)) {
    throw fixedError("accounting_unified_generation_required");
  }
  if (expectedGeneration !== null
      && expectedGeneration !== undefined
      && expectedGenerationTokens(expectedGeneration).length === 0) {
    throw new TypeError("expectedGeneration is invalid");
  }
  const selectedUnifiedIndexFile = unifiedIndexFile
    ?? (selectedSourceMode === "unified"
      ? defaultLocalUnifiedIndexPath()
      : null);
  const effectiveScan = scan ?? (selectedSourceMode === "unified"
    ? createLocalUnifiedAccountingSource({
      indexFile: selectedUnifiedIndexFile,
      requireComplete: true,
      expectedGeneration,
      contextBehavior: selectedContextBehavior,
    })
    : scanCodexLogEvents);
  const endMs = now();
  if (!Number.isFinite(endMs)
      || !Number.isSafeInteger(windowDays)
      || windowDays < MINIMUM_WINDOW_DAYS
      || windowDays > MAXIMUM_WINDOW_DAYS
      || (unifiedIndexFile !== null
        && (typeof unifiedIndexFile !== "string" || unifiedIndexFile.length < 1))
      || typeof effectiveScan !== "function"
      || !validAbortSignal(signal)
      || typeof rss !== "function"
      || !Number.isSafeInteger(maximumRssBytes)
      || maximumRssBytes < 1) {
    throw new TypeError("Replay-safe accounting options are invalid");
  }
  const baselines = Array.isArray(declaredSpeedBaselines)
    ? declaredSpeedBaselines
    : [];
  // Budget-relative guard: the pass is charged for its OWN growth over the
  // RSS captured here at build start, so a large companion baseline no longer
  // silently spends the budget before the pass begins — and a small baseline
  // no longer grants the pass an accidental gigabyte. The absolute ceiling is
  // retained as the hard backstop, so the effective limit is whichever of
  // (baseline + delta budget, absolute ceiling) is LOWER.
  const baselineRss = rss();
  if (!Number.isSafeInteger(baselineRss) || baselineRss < 0) {
    throw fixedError("accounting_transition_rss_measurement_invalid");
  }
  const effectiveMaximumRssBytes = Math.min(
    maximumRssBytes,
    baselineRss + ACCOUNTING_RSS_DELTA_BUDGET_BYTES,
  );
  const checkRuntimeMemory = () => {
    const currentRss = rss();
    if (!Number.isSafeInteger(currentRss) || currentRss < 0) {
      throw fixedError("accounting_transition_rss_measurement_invalid");
    }
    if (currentRss > effectiveMaximumRssBytes) {
      throw fixedError("accounting_transition_rss_limit_exceeded");
    }
  };
  checkRuntimeMemory();
  // The deep-scan guard reuses the shared, frozen export resource policy, whose
  // compatibility-bound candidate ceiling caps maximumRssBytes at 1.5 GiB. The
  // accounting build's authoritative ceiling is the effective target computed
  // above (checkRuntimeMemory), so pass the guard the LOWER of the two: it can
  // only tighten the transition-path target, never contradict it. Which side
  // wins depends on the baseline and is deliberately not assumed: off the
  // rebuild child's clean baseline the accounting effective ceiling (~1.3 GiB)
  // is the lower one, while a fat in-process baseline pushes it up against the
  // export policy's 1.5 GiB. In practice the heavy growth is the post-scan
  // transition mining that checkRuntimeMemory polices at the full effective
  // target, while the scan phase stays within either bound. A scan-phase RSS
  // trip is likewise a soft budget miss (accounting_scan_rss_limit_exceeded),
  // not a hard refresh failure.
  const scanResourceGuardMaximumRssBytes = Math.min(
    effectiveMaximumRssBytes,
    DEFAULT_EXPORT_RESOURCE_LIMITS.maximumRssBytes,
  );
  const scanResourceGuard = createExportResourceGuard({
    limits: { maximumRssBytes: scanResourceGuardMaximumRssBytes },
    clock: now,
    rss,
  });
  const limits = transitionResourceLimits(
    requestedTransitionResourceLimits,
  );
  throwIfAborted(signal);
  // Whether the unified index can supply the full-history calibration corpus.
  // Probed before the scan so the scan skips retaining its own window-bounded
  // transition inputs; the corpus itself is materialized only after the scan,
  // keeping the two working sets sequential rather than resident together. A
  // missing or unusable index degrades to the windowed corpus here; it never
  // fails the build.
  const useUnifiedCalibration = selectedUnifiedIndexFile !== null
    && await probeUnifiedCalibrationCorpus(selectedUnifiedIndexFile);
  const retainWindowedCalibrationInputs = !useUnifiedCalibration;
  throwIfAborted(signal);
  const startMs = endMs - windowDays * 24 * 60 * 60 * 1_000;
  const starts = {
    "24h": endMs - 24 * 60 * 60 * 1_000,
    "7d": endMs - 7 * 24 * 60 * 60 * 1_000,
    "30d": endMs - 30 * 24 * 60 * 60 * 1_000,
    all: startMs,
  };
  const periods = new Map([
    ["24h", newPeriod("24h", "Last 24 hours")],
    ["7d", newPeriod("7d", "Last 7 days")],
    ["30d", newPeriod("30d", "Last 30 days")],
    ["all", newPeriod("all", `Cached ${windowDays}-day window`)],
  ]);
  const timeline = new Map();
  const sparkTimeline = new Map();
  const weeklyQuotaTimelineBuckets = new Map();
  const sparkQuotaTimelineBuckets = new Map();
  const weeklyPaceSnapshots = [];
  const rawUsageEvents = [];
  const weeklyRateLimitSnapshots = [];
  let retainedSparkUsageEvents = 0;
  let retainedSparkSnapshotInputs = 0;
  const price = createAccountingPricer();
  let retainedTransitionBytes = 0;
  let retainedTransitionInputs = 0;
  // When the unified index supplies the calibration corpus, the scan retains
  // no transition inputs of its own; this counter only preserves the periodic
  // RSS check cadence the reserve path would otherwise provide.
  let unretainedCalibrationInputs = 0;
  const observeUnretainedCalibrationInput = () => {
    unretainedCalibrationInputs += 1;
    if (unretainedCalibrationInputs % ACCOUNTING_RSS_CHECK_INTERVAL === 0) {
      checkRuntimeMemory();
    }
  };
  const reserveTransitionInput = (kind) => {
    const usageCount = rawUsageEvents.length + retainedSparkUsageEvents;
    const snapshotCount = weeklyRateLimitSnapshots.length
      + retainedSparkSnapshotInputs;
    const combinedCount = usageCount + snapshotCount;
    if (kind === "usage" && usageCount >= limits.usageEvents) {
      throw fixedError("accounting_transition_usage_limit_exceeded");
    }
    if (kind === "snapshot" && snapshotCount >= limits.weeklySnapshots) {
      throw fixedError("accounting_transition_snapshot_limit_exceeded");
    }
    if (combinedCount >= limits.combinedInputs) {
      throw fixedError("accounting_transition_input_limit_exceeded");
    }
    const retainedBytes = kind === "usage"
      ? COMPACT_USAGE_RETAINED_BYTES
      : COMPACT_SNAPSHOT_RETAINED_BYTES;
    if (retainedTransitionBytes + retainedBytes > limits.retainedBytes) {
      throw fixedError("accounting_transition_memory_budget_exceeded");
    }
    retainedTransitionBytes += retainedBytes;
    retainedTransitionInputs += 1;
    if (retainedTransitionInputs % ACCOUNTING_RSS_CHECK_INTERVAL === 0) {
      checkRuntimeMemory();
    }
  };
  let scanned;
  let unifiedCoverage = null;
  try {
    scanned = await effectiveScan({
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
      codexHome,
      resourceGuard: scanResourceGuard,
      signal,
      onUsage: (rawEvent) => {
        throwIfAborted(signal);
        const observedAt = canonicalInstant(rawEvent?.timestamp);
        if (observedAt === null) return;
        const observedMs = Date.parse(observedAt);
        if (observedMs < startMs || observedMs > endMs + 5 * 60_000) return;
        const event = eventProjection(rawEvent, price);
        if (event === null) return;
        // An observed tier always wins, so a declaration is only ever looked
        // up for the turns the rollout log left unobserved.
        event.declaredSpeed = event.speed === "unknown"
          ? declaredSpeedModeAt(baselines, observedMs) ?? "unknown"
          : "unknown";
        if (retainWindowedCalibrationInputs) {
          reserveTransitionInput("usage");
        } else {
          observeUnretainedCalibrationInput();
        }
        if (event.isSpark) {
          if (retainWindowedCalibrationInputs) retainedSparkUsageEvents += 1;
          for (const [id, period] of periods) {
            if (observedMs >= starts[id]) addEvent(period, event);
          }
          addTimelineEvent(sparkTimeline, event);
          return;
        }
        if (retainWindowedCalibrationInputs) {
          rawUsageEvents.push(transitionUsageProjection(rawEvent, event));
        }
        for (const [id, period] of periods) {
          if (observedMs >= starts[id]) addEvent(period, event);
        }
        addTimelineEvent(timeline, event);
      },
      onRateLimitSnapshot: (snapshot) => {
        throwIfAborted(signal);
        const window = snapshot?.window;
        const observedAt = canonicalInstant(snapshot?.timestamp);
        const observedMs = observedAt === null
          ? Number.NaN
          : Date.parse(observedAt);
        if (!Number.isFinite(observedMs)
            || observedMs < startMs
            || observedMs > endMs) return;
        // Rows keep the observed limit id: consumers filter the series with
        // SPARK_QUOTA_LIMIT_IDS.includes(row.limitId), same as the unified
        // and collector paths.
        if (SPARK_QUOTA_LIMIT_IDS.includes(window?.limitId)
            && window.provider === "openai_codex"
            && isValidQuotaWindowDuration(window.windowDurationMins)) {
          if (retainWindowedCalibrationInputs) {
            reserveTransitionInput("snapshot");
            retainedSparkSnapshotInputs += 1;
          } else {
            observeUnretainedCalibrationInput();
          }
          retainQuotaTimeline(
            sparkQuotaTimelineBuckets,
            snapshot,
            { limitId: window.limitId, durationMinutes: null },
          );
          return;
        }
        if (window?.limitId === "codex"
            && window.windowDurationMins === WEEKLY_WINDOW_MINUTES) {
          if (retainWindowedCalibrationInputs) {
            reserveTransitionInput("snapshot");
            weeklyRateLimitSnapshots.push(weeklyRateLimitProjection(snapshot));
          } else {
            observeUnretainedCalibrationInput();
          }
          retainQuotaTimeline(
            weeklyQuotaTimelineBuckets,
            snapshot,
            { limitId: "codex", durationMinutes: WEEKLY_WINDOW_MINUTES },
          );
          const paceSnapshot = weeklyPaceSnapshotProjection(snapshot);
          if (paceSnapshot !== null) weeklyPaceSnapshots.push(paceSnapshot);
        }
      },
    });
    if (selectedSourceMode === "unified") {
      unifiedCoverage = normalizeUnifiedCoverage(scanned, expectedGeneration);
    }
  } catch (error) {
    const bounded = accountingScanResourceError(error);
    if (bounded !== null) throw bounded;
    if (selectedSourceMode === "unified") {
      if (error?.name === "AbortError"
          || error?.code === "accounting_refresh_aborted") {
        const aborted = fixedError("accounting_refresh_aborted", "AbortError");
        throw aborted;
      }
      throw mapUnifiedReaderError(error) ?? error;
    }
    throw error;
  }
  throwIfAborted(signal);
  checkRuntimeMemory();
  let history = historyUnavailable(
    selectedSourceMode === "unified"
      ? "accounting_unified_history_unavailable"
      : "accounting_history_unavailable",
    unifiedCoverage?.coveredAt ?? null,
    unifiedCoverage?.generation ?? null,
    unifiedCoverage?.generationFingerprint ?? null,
  );
  if (selectedSourceMode === "unified" && unifiedCoverage !== null) {
    let historyScanned = null;
    const historyScan = async (scanOptions) => {
      historyScanned = await effectiveScan(scanOptions);
      return historyScanned;
    };
    try {
      const historyValue = await buildReplaySafeAccountingPeriod({
        id: "history",
        label: "Indexed history",
        startAt: unifiedCoverage.coveredAt.startAt,
        endAt: unifiedCoverage.coveredAt.endAt,
        scan: historyScan,
        signal,
        declaredSpeedBaselines: baselines,
        rss,
        maximumRssBytes: effectiveMaximumRssBytes,
      });
      const historyCoverage = normalizeUnifiedCoverage(
        historyScanned,
        expectedGeneration,
      );
      if (historyCoverage.generation !== unifiedCoverage.generation
          || historyCoverage.generationFingerprint
            !== unifiedCoverage.generationFingerprint
          || historyCoverage.coveredAt.startAt
            !== unifiedCoverage.coveredAt.startAt
          || historyCoverage.coveredAt.endAt
            !== unifiedCoverage.coveredAt.endAt) {
        throw fixedError("accounting_unified_generation_mismatch");
      }
      history = historyProjection(
        historyValue,
        historyCoverage,
        historyCoverage.generation,
        historyCoverage.generationFingerprint,
      );
    } catch (error) {
      if (error?.name === "AbortError"
          || error?.code === "accounting_refresh_aborted") {
        throw fixedError("accounting_refresh_aborted", "AbortError");
      }
      const mapped = mapUnifiedReaderError(error) ?? error;
      if (mapped?.code === "accounting_unified_generation_mismatch"
          || mapped?.name === "AbortError"
          || isAccountingBudgetMiss(mapped)
          || mapped?.code === "accounting_archive_rss_limit_exceeded"
          || (typeof mapped?.code === "string"
            && !mapped.code.startsWith("accounting_unified_"))) {
        throw mapped;
      }
      history = historyUnavailable(
        mapped?.code ?? "accounting_unified_history_unavailable",
        unifiedCoverage.coveredAt,
        unifiedCoverage.generation,
        unifiedCoverage.generationFingerprint,
      );
    }
  }
  let calibrationCorpus = null;
  if (useUnifiedCalibration) {
    calibrationCorpus = await openUnifiedIndexCalibrationCorpus({
      indexFile: selectedUnifiedIndexFile,
      endMs,
      limits,
      declaredSpeedBaselines: baselines,
      signal,
      checkRuntimeMemory,
      ...(selectedSourceMode === "unified"
        ? { expectedGeneration: unifiedCoverage?.generation ?? null }
        : {}),
    });
    // The probe accepted this index, so the scan retained no windowed
    // fallback corpus. If the full read then fails, the only honest outputs
    // are a typed failure or a calibration falsely labelled complete-but-
    // empty; fail closed, and the next refresh re-probes from scratch.
    if (calibrationCorpus === null) {
      throw fixedError("accounting_calibration_corpus_unavailable");
    }
  }
  let composition = null;
  let compositionFitFailure = null;
  let transitionSeries;
  const retainedUsageEvents = retainWindowedCalibrationInputs
    ? rawUsageEvents.length + retainedSparkUsageEvents
    : calibrationCorpus.retainedUsageEvents;
  const retainedWeeklySnapshots = retainWindowedCalibrationInputs
    ? weeklyRateLimitSnapshots.length + retainedSparkSnapshotInputs
    : calibrationCorpus.weeklyRateLimitSnapshots.length;
  const calibrationRetainedBytes = retainWindowedCalibrationInputs
    ? retainedTransitionBytes
    : retainedUsageEvents * COMPACT_USAGE_RETAINED_BYTES
      + retainedWeeklySnapshots * COMPACT_SNAPSHOT_RETAINED_BYTES;
  const calibrationCoveredAt = {
    startAt: retainWindowedCalibrationInputs
      ? new Date(startMs).toISOString()
      : calibrationCorpus.coveredAt.startAt,
    endAt: new Date(endMs).toISOString(),
  };
  try {
    // The composition fit reads the same compact corpus the derivation below
    // will consume, so it must run first. It is strictly optional enrichment:
    // any throw out of it (resource ceiling, abort, numerical surprise) must
    // not cost the whole build. The cache completes with `composition: null` —
    // the dashboard then falls back to the across-reset median headline — and
    // the failure is recorded on the calibration block, because a refresh that
    // dies here re-runs the same doomed pass on every scheduler tick while the
    // on-disk cache stays a rejected older artifact.
    try {
      composition = retainWindowedCalibrationInputs
        ? await fitCompositionFromCompactCorpus({
          rawUsageEvents,
          weeklyRateLimitSnapshots,
          endMs,
          signal,
          checkRuntimeMemory,
        })
        : await fitCompositionFromCorpusStream({
          forEachUsageRow: calibrationCorpus.forEachRetainedUsage,
          weeklyRateLimitSnapshots: calibrationCorpus.weeklyRateLimitSnapshots,
          endMs,
          signal,
          checkRuntimeMemory,
        });
    } catch (error) {
      compositionFitFailure = {
        status: "fit_failed",
        reason: compositionFitFailureReason(error),
      };
    }
    throwIfAborted(signal);
    checkRuntimeMemory();
    try {
      transitionSeries = await deriveBoundedWeeklyCalibrationSeries({
        startAt: calibrationCoveredAt.startAt,
        endAt: calibrationCoveredAt.endAt,
        ...(retainWindowedCalibrationInputs
          ? { rawUsageEvents }
          : {
            usageCorpus: {
              count: calibrationCorpus.retainedUsageEvents,
              usageMs: calibrationCorpus.usageMs,
              readSlice: calibrationCorpus.readUsageSlice,
            },
          }),
        rateLimitSnapshots: retainWindowedCalibrationInputs
          ? weeklyRateLimitSnapshots
          : calibrationCorpus.weeklyRateLimitSnapshots,
        // The scan diagnostics describe the windowed raw-log pass; the unified
        // corpus was fork-replay-suppressed at ingest, so its transitions do
        // not restate scan-level counts as their own.
        diagnostics: retainWindowedCalibrationInputs
          ? scanned?.diagnostics ?? {}
          : {},
        signal,
        resourceCheck: checkRuntimeMemory,
      });
    } catch (error) {
      if (error?.name === "AbortError"
          || error?.code === "transition_derivation_aborted") {
        const aborted = fixedError("accounting_refresh_aborted");
        aborted.name = "AbortError";
        throw aborted;
      }
      if ([
        "transition_derivation_input_limit_exceeded",
        "transition_derivation_row_limit_exceeded",
        "transition_derivation_work_limit_exceeded",
      ].includes(error?.code)) {
        throw fixedError("accounting_transition_derivation_limit_exceeded");
      }
      throw error;
    }
    // The streamed corpus is fully consumed; re-verify that the index the
    // slices were read off is still the generation the build is bound to, and
    // release the read handle. The one-shot reader ran the same checks at its
    // end; streaming widens the window they cover, not their meaning.
    if (calibrationCorpus !== null) await calibrationCorpus.finish();
  } catch (error) {
    calibrationCorpus?.dispose();
    throw error;
  }
  const weeklyCalibrationDataset = {
    parserVersion: PARSER_VERSION,
    scope: {
      startAt: calibrationCoveredAt.startAt,
      endAt: calibrationCoveredAt.endAt,
      snapshotIntervalsIncluded: false,
    },
    pricing: {
      basis: "standard_openai_api_prices_not_codex_subscription_credits",
    },
    summary: {
      deduplicatedRateLimitSnapshots:
        transitionSeries.deduplicatedSnapshotCount,
    },
    transitions: transitionSeries.transitions,
  };
  const weeklyCalibration = projectBoundedWeeklyCalibrationSummary(
    weeklyCalibrationDataset,
    { composition },
  );
  if (compositionFitFailure !== null) {
    // Additive v0.7 field, present only when the fit itself threw: a blank
    // composition caused by a failure must be distinguishable against a
    // corpus that simply never supported a fit — five hours of silent
    // refresh loops is what an unrecorded failure cost the last time.
    // (Comment deliberately avoids a quoted phrase after the keyword-like
    // word f-r-o-m: the release gate's ESM lexer reads that shape in
    // comments as an import specifier.)
    weeklyCalibration.compositionStatus = compositionFitFailure;
  }
  const allowanceCapacityDataset = {
    ...weeklyCalibrationDataset,
    pricing: {
      basis: "quota_weighted_api_equivalent_by_unresolved_speed_scenario",
    },
  };
  const allowanceScenarios = Object.fromEntries(
    Object.entries(ALLOWANCE_SCENARIO_CANDIDATES).map(([
      scenario,
      forcedCandidateId,
    ]) => [scenario, {
      basis: codexPrimaryAllowanceBasis(scenario),
      calibration: projectBoundedWeeklyCalibrationSummary(
        allowanceCapacityDataset,
        { forcedCandidateId },
      ),
    }]),
  );
  const allowanceCapacityByScenario = {
    schemaVersion: ALLOWANCE_CAPACITY_SCHEMA_VERSION,
    basisFamilyId:
      allowanceScenarios.unresolved_as_standard.basis.basisFamilyId,
    scenarios: allowanceScenarios,
  };
  const paceForecast = projectWeeklyPaceForecast(weeklyPaceSnapshots, endMs);
  throwIfAborted(signal);
  return {
    schemaVersion: REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION,
    generatedAt: new Date(endMs).toISOString(),
    coveredAt: {
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
    },
    bucketMinutes: TIMELINE_BUCKET_MS / 60_000,
    accountingMethod:
      "lineage_aware_cumulative_snapshot_replay_exclusion",
    priceBasis: "official_api_price_equivalent_not_subscription_allowance",
    priceEpochBasis: HISTORICAL_PRICE_EPOCH_BASIS,
    priceRegistryVersion: APP_PRICE_REGISTRY_MANIFEST.version,
    priceRegistryObservedAt: APP_PRICE_REGISTRY_MANIFEST.observedAt,
    sourceDescriptor: sourceDescriptor({
      mode: selectedSourceMode,
      contextBehavior: selectedContextBehavior,
      scanned,
      coverage: unifiedCoverage?.coverage ?? null,
      generation: unifiedCoverage?.generation ?? null,
      generationMatched: selectedSourceMode === "unified"
        && expectedGeneration !== null
        && expectedGeneration !== undefined,
    }),
    history,
    periods: [...periods.values()].map(finalizePeriod),
    timeline: finalizeTimeline(timeline),
    sparkUsageTimeline: finalizeTimeline(sparkTimeline),
    quotaTimeline: finalizeWeeklyQuotaTimeline(
      weeklyQuotaTimelineBuckets,
    ),
    sparkQuotaTimeline: finalizeWeeklyQuotaTimeline(
      sparkQuotaTimelineBuckets,
    ),
    ...(paceForecast === null
      ? {}
      : { weekly: { paceForecast } }),
    weeklyCalibration,
    allowanceCapacityByScenario,
    weeklyCalibrationInput: {
      status: "complete",
      encoding: "accounting_compact_v2",
      // Which corpus fed the calibration: the whole unified index when it is
      // present, the scan window only as the fallback. `coveredAt` states the
      // span that corpus actually reaches, so a reader can tell full history
      // from a bounded window instead of guessing.
      source: retainWindowedCalibrationInputs
        ? "windowed_scan"
        : "unified_index",
      coveredAt: calibrationCoveredAt,
      retainedUsageEvents,
      retainedWeeklySnapshots,
      estimatedRetainedBytes: calibrationRetainedBytes,
      limits,
    },
    diagnostics: publicDiagnostics(scanned?.diagnostics),
  };
}

// Everything the child may not say: an envelope whose error code fails the
// bounded pattern is treated as no envelope at all, so arbitrary child text
// can never become a refresh classification.
const SUBPROCESS_FAILURE_CODE_PATTERN = /^[a-z0-9_]{1,64}$/u;
const SUBPROCESS_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

// The child inherits almost nothing. TMPDIR is the one passthrough: inside the
// sandboxed macOS app it names the container's writable temp root, which
// SQLite may need for spill files. Deliberately absent: NODE_OPTIONS (nothing
// may override the child's pinned old-space cap or preload code into the
// rebuild), HOME (every path the child touches arrives resolved in the
// request), and PATH (the child execs nothing).
function minimalRebuildChildEnvironment() {
  const environment = {};
  if (typeof process.env.TMPDIR === "string" && process.env.TMPDIR.length > 0) {
    environment.TMPDIR = process.env.TMPDIR;
  }
  return environment;
}

function parseRebuildChildEnvelope(stdoutText) {
  const line = stdoutText.split("\n").filter((part) => part.length > 0).at(-1);
  if (line === undefined) return null;
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.status === "ok"
      && Number.isSafeInteger(value.resultBytes)
      && value.resultBytes >= 2
      && value.resultBytes <= ACCOUNTING_REBUILD_RESULT_LIMIT_BYTES
      && typeof value.resultSha256 === "string"
      && SUBPROCESS_SHA256_PATTERN.test(value.resultSha256)) {
    return { status: "ok", resultBytes: value.resultBytes, resultSha256: value.resultSha256 };
  }
  if (value.status === "error"
      && typeof value.code === "string"
      && SUBPROCESS_FAILURE_CODE_PATTERN.test(value.code)
      && ["Error", "AbortError"].includes(value.name)) {
    return { status: "error", code: value.code, name: value.name };
  }
  return null;
}

/**
 * Runs one accounting rebuild in a short-lived child of the packaged Node
 * runtime (process.execPath — the same binary serving the companion) and
 * returns the parsed cache artifact. The request already carries every input
 * resolved and serializable; the child re-verifies the unified generation and
 * index file identity itself at corpus open and finish, exactly as the
 * in-process build does, so the process boundary adds transport integrity
 * (byte count + SHA-256 over the result file, then full artifact validation
 * in the caller) rather than replacing any verification.
 *
 * Error surface, by construction:
 * - a typed build failure inside the child crosses back as the SAME fixed
 *   code the in-process build would have thrown, so the caller's existing
 *   budget-miss/passthrough classification is untouched;
 * - an abort — ours via SIGTERM on the caller's signal, or the child's own
 *   graceful abort — is always the AbortError-shaped
 *   accounting_refresh_aborted the in-process path throws;
 * - a child that dies without a well-formed envelope (OOM kill, crash, spawn
 *   failure, transport mismatch) becomes the single fixed code
 *   accounting_rebuild_subprocess_failed, which the refresh wrapper defers
 *   exactly like a memory-budget miss: the prior cache is retained and served,
 *   and the scheduler's backoff prevents a crash loop.
 */
async function buildReplaySafeAccountingCacheInSubprocess({
  request,
  signal = null,
  entry = ACCOUNTING_REBUILD_CHILD_ENTRY,
}) {
  throwIfAborted(signal);
  const workDirectory = await mkdtemp(
    join(tmpdir(), "usage-monitor-accounting-rebuild-"),
  );
  try {
    const requestFile = join(workDirectory, "rebuild-request-v1.json");
    const resultFile = join(workDirectory, "rebuild-result-v1.json");
    await writeFile(requestFile, `${JSON.stringify(request)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    const closed = await new Promise((resolveClosed) => {
      let settled = false;
      const settle = (outcome) => {
        if (settled) return;
        settled = true;
        resolveClosed(outcome);
      };
      let child;
      try {
        child = spawn(process.execPath, [
          `--max-old-space-size=${ACCOUNTING_REBUILD_CHILD_OLD_SPACE_MIB}`,
          entry,
          requestFile,
          resultFile,
        ], {
          cwd: workDirectory,
          env: minimalRebuildChildEnvironment(),
          // stdin stays piped and open for the child's whole life — its close
          // is the child's parent-death watchdog. stderr is dropped: child
          // failures classify by envelope and exit status only, so no crash
          // text (which may embed paths) can reach a surface.
          stdio: ["pipe", "pipe", "ignore"],
        });
      } catch {
        settle({ code: null, killSignal: null, stdoutText: "", protocolBroken: true });
        return;
      }
      let stdoutText = "";
      let protocolBroken = false;
      let killTimer = null;
      const onAbort = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          // Already exited; the close handler settles the outcome.
        }
        killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already exited.
          }
        }, ACCOUNTING_REBUILD_CHILD_KILL_GRACE_MS);
        killTimer.unref?.();
      };
      if (signal !== null) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (protocolBroken) return;
        stdoutText += chunk;
        if (stdoutText.length > ACCOUNTING_REBUILD_ENVELOPE_LIMIT_BYTES) {
          protocolBroken = true;
          stdoutText = "";
        }
      });
      child.once("error", () => {
        // Spawn/kill failures may arrive without a later close event; settle
        // as protocol breakage and let close (if it still fires) be ignored.
        signal?.removeEventListener?.("abort", onAbort);
        if (killTimer !== null) clearTimeout(killTimer);
        settle({ code: null, killSignal: null, stdoutText: "", protocolBroken: true });
      });
      child.once("close", (code, killSignal) => {
        signal?.removeEventListener?.("abort", onAbort);
        if (killTimer !== null) clearTimeout(killTimer);
        settle({ code, killSignal, stdoutText, protocolBroken });
      });
    });
    const envelope = closed.protocolBroken
      ? null
      : parseRebuildChildEnvelope(closed.stdoutText);
    if (envelope?.status === "ok"
        && closed.code === 0
        && closed.killSignal === null) {
      let payload;
      try {
        payload = await readFile(resultFile);
      } catch {
        throw fixedError("accounting_rebuild_subprocess_failed");
      }
      if (payload.byteLength !== envelope.resultBytes
          || createHash("sha256").update(payload).digest("hex")
            !== envelope.resultSha256) {
        throw fixedError("accounting_rebuild_subprocess_failed");
      }
      let cache;
      try {
        cache = JSON.parse(payload.toString("utf8"));
      } catch {
        throw fixedError("accounting_rebuild_subprocess_failed");
      }
      if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
        throw fixedError("accounting_rebuild_subprocess_failed");
      }
      // Mirror the in-process build's final abort gate: work that finished
      // after an abort landed is still discarded before publication.
      throwIfAborted(signal);
      return cache;
    }
    if (envelope?.status === "error") {
      if (envelope.name === "AbortError"
          || envelope.code === "accounting_refresh_aborted") {
        const aborted = fixedError("accounting_refresh_aborted");
        aborted.name = "AbortError";
        throw aborted;
      }
      throw fixedError(envelope.code);
    }
    // No usable envelope. If the caller aborted, the death is OURS (SIGTERM/
    // SIGKILL) and the honest outcome is the abort; otherwise the child died
    // on its own and the caller fails closed to the deferral path.
    throwIfAborted(signal);
    throw fixedError("accounting_rebuild_subprocess_failed");
  } finally {
    try {
      await rm(workDirectory, { recursive: true, force: true });
    } catch {
      // Cleanup failure must never mask the rebuild outcome; the directory
      // holds only this pass's private request/result pair.
    }
  }
}

export async function refreshReplaySafeAccountingCache({
  stateFile = null,
  // A JSON cache is no longer a supported durable target. Keeping this
  // explicit catch prevents a stale caller from silently writing SQLite bytes
  // to a misleading .json path.
  cacheFile = undefined,
  indexFile = null,
  indexSecretFile = null,
  scan = null,
  sourceMode = null,
  unifiedIndexFile = null,
  expectedGeneration = null,
  contextBehavior = null,
  indexWorkerCount,
  indexChunkBytes,
  // Optional, layer-local hook fired when a rebuild misses its memory budget
  // and is DEFERRED rather than failed. Receives only a bounded descriptor
  // ({ reason, retained }); its own errors never affect the refresh. The
  // deferred outcome is ALSO reported in the return value, and production wires
  // the diagnostics note off that (runner -> controller.onDegradedOutcome), so
  // this hook is a convenience for a caller that wants the signal inline
  // without inspecting the return shape.
  onAccountingRebuildDeferred = null,
  // Where the rebuild executes. "auto" (the default) runs production-shaped
  // calls — no injected scan, no injected rss meter — in a short-lived child
  // process whose clean baseline restores the guard's headroom (see the
  // isolation rationale on ACCOUNTING_REBUILD_ISOLATION_MODES above), and
  // keeps every characterization call with injected function seams on the
  // in-process build, since functions cannot cross a process boundary.
  // "in_process" forces the old execution for a caller that must observe the
  // build inside its own process; "subprocess" asserts isolation and refuses
  // un-serializable seams instead of silently degrading.
  rebuildIsolation = null,
  // Characterization seam for the child entrypoint (crash/protocol tests
  // substitute a misbehaving child). Production always uses the reviewed
  // sibling module.
  rebuildSubprocessEntry = null,
  ...options
} = {}) {
  if (cacheFile !== undefined) {
    throw new TypeError("cacheFile was retired; use stateFile");
  }
  if (onAccountingRebuildDeferred !== null
      && typeof onAccountingRebuildDeferred !== "function") {
    throw new TypeError("onAccountingRebuildDeferred must be a function or null");
  }
  const selectedRebuildIsolation = rebuildIsolation ?? "auto";
  if (!ACCOUNTING_REBUILD_ISOLATION_MODES.includes(selectedRebuildIsolation)) {
    throw new TypeError(
      "rebuildIsolation must be auto, subprocess, or in_process",
    );
  }
  if (rebuildSubprocessEntry !== null
      && (typeof rebuildSubprocessEntry !== "string"
        || !isAbsolute(rebuildSubprocessEntry))) {
    throw new TypeError(
      "rebuildSubprocessEntry must be an absolute path or null",
    );
  }
  const selectedStateFile = stateFile ?? defaultReplaySafeAccountingCachePath();
  const selectedSourceMode = normalizeAccountingSourceMode(
    sourceMode,
    { defaultValue: scan === null ? "unified" : "legacy" },
  );
  const selectedContextBehavior = normalizeContextBehavior(
    contextBehavior,
  );
  if (expectedGeneration !== null
      && expectedGeneration !== undefined
      && expectedGenerationTokens(expectedGeneration).length === 0) {
    throw new TypeError("expectedGeneration is invalid");
  }
  if (selectedSourceMode === "unified"
      && (expectedGeneration === null || expectedGeneration === undefined)) {
    throw fixedError("accounting_unified_generation_required");
  }
  const selectedUnifiedIndexFile = unifiedIndexFile
    ?? resolve(dirname(selectedStateFile), "local-unified-index-v1.sqlite");
  const selectedIndexFile = indexFile ?? resolve(
    dirname(selectedStateFile),
    "local-analysis-index-v2.sqlite",
  );
  const selectedIndexSecretFile = indexSecretFile
    ?? defaultLocalAnalysisIndexSecretPath(selectedIndexFile);
  if (typeof selectedStateFile !== "string" || selectedStateFile.length < 1
      || typeof selectedUnifiedIndexFile !== "string"
      || selectedUnifiedIndexFile.length < 1
      || typeof selectedIndexFile !== "string" || selectedIndexFile.length < 1) {
    throw new TypeError("Replay-safe SQLite state paths are invalid");
  }
  if (scan !== null && typeof scan !== "function") {
    throw new TypeError("scan must be a function or null");
  }
  const effectiveScan = scan ?? (selectedSourceMode === "unified"
    ? createLocalUnifiedAccountingSource({
      indexFile: selectedUnifiedIndexFile,
      requireComplete: true,
      expectedGeneration,
      contextBehavior: selectedContextBehavior,
    })
    : createIndexedCodexLogScan({
      indexFile: selectedIndexFile,
      secretFile: selectedIndexSecretFile,
      workerCount: indexWorkerCount ?? DEFAULT_ACCOUNTING_INDEX_WORKERS,
      ...(indexChunkBytes === undefined
        ? {}
        : { chunkBytes: indexChunkBytes }),
    }));
  // An injected scanner or rss meter is a function and cannot cross a process
  // boundary; those characterization calls stay on the in-process build under
  // "auto". Everything a production call carries is serializable, so the
  // production paths (unified reader, legacy indexed scan) are reconstructed
  // inside the child by value.
  const subprocessEligible = scan === null && !Object.hasOwn(options, "rss");
  if (selectedRebuildIsolation === "subprocess" && !subprocessEligible) {
    throw new TypeError(
      "rebuildIsolation subprocess cannot carry injected scan or rss seams",
    );
  }
  const rebuildInSubprocess = selectedRebuildIsolation === "subprocess"
    || (selectedRebuildIsolation === "auto" && subprocessEligible);
  let subprocessRequest = null;
  if (rebuildInSubprocess) {
    // Resolve and validate the request the child will replay, mirroring the
    // option validation the in-process build performs, so an invalid option
    // stays a synchronous TypeError here rather than surfacing as a child
    // failure. The clock is sampled exactly once — the same single call the
    // in-process build makes for endMs — and crosses as a number.
    const nowFunction = options.now ?? (() => Date.now());
    const selectedWindowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
    const selectedCodexHome = options.codexHome ?? join(homedir(), ".codex");
    const selectedMaximumRssBytes = options.maximumRssBytes
      ?? MAX_ACCOUNTING_RSS_BYTES;
    if (typeof nowFunction !== "function"
        || !Number.isSafeInteger(selectedWindowDays)
        || selectedWindowDays < MINIMUM_WINDOW_DAYS
        || selectedWindowDays > MAXIMUM_WINDOW_DAYS
        || typeof selectedCodexHome !== "string"
        || selectedCodexHome.length < 1
        || !validAbortSignal(options.signal ?? null)
        || !Number.isSafeInteger(selectedMaximumRssBytes)
        || selectedMaximumRssBytes < 1) {
      throw new TypeError("Replay-safe accounting options are invalid");
    }
    const nowMs = nowFunction();
    if (!Number.isFinite(nowMs)) {
      throw new TypeError("Replay-safe accounting options are invalid");
    }
    if (selectedSourceMode === "legacy") {
      const requestedWorkerCount = indexWorkerCount
        ?? DEFAULT_ACCOUNTING_INDEX_WORKERS;
      if (!Number.isSafeInteger(requestedWorkerCount)
          || requestedWorkerCount < 1
          || (indexChunkBytes !== undefined
            && !Number.isSafeInteger(indexChunkBytes))) {
        throw new TypeError("Replay-safe accounting options are invalid");
      }
    }
    // Throws the same TypeErrors the in-process build would for a malformed
    // limits object; the child then re-normalizes the identical value.
    transitionResourceLimits(options.transitionResourceLimits ?? null);
    subprocessRequest = {
      version: REPLAY_SAFE_ACCOUNTING_REBUILD_REQUEST_VERSION,
      nowMs,
      windowDays: selectedWindowDays,
      codexHome: selectedCodexHome,
      sourceMode: selectedSourceMode,
      contextBehavior: selectedContextBehavior,
      expectedGeneration: expectedGeneration ?? null,
      unifiedIndexFile: selectedSourceMode === "unified"
        ? selectedUnifiedIndexFile
        : unifiedIndexFile,
      legacyIndexFile: selectedSourceMode === "legacy"
        ? selectedIndexFile
        : null,
      legacyIndexSecretFile: selectedSourceMode === "legacy"
        ? selectedIndexSecretFile
        : null,
      legacyIndexWorkerCount: selectedSourceMode === "legacy"
        ? indexWorkerCount ?? DEFAULT_ACCOUNTING_INDEX_WORKERS
        : null,
      legacyIndexChunkBytes: selectedSourceMode === "legacy"
          && indexChunkBytes !== undefined
        ? indexChunkBytes
        : null,
      declaredSpeedBaselines: Array.isArray(options.declaredSpeedBaselines)
        ? options.declaredSpeedBaselines
        : [],
      transitionResourceLimits: options.transitionResourceLimits ?? null,
      maximumRssBytes: selectedMaximumRssBytes,
    };
  }
  // Converge legacy state before spending a potentially substantial raw-log
  // scan. A live old JSON collector or an unverified parity mismatch must
  // fail before we derive a cache that cannot be committed safely.
  await prepareLocalCollectorState({ stateFile: selectedStateFile });
  let cache;
  try {
    cache = rebuildInSubprocess
      ? await buildReplaySafeAccountingCacheInSubprocess({
        request: subprocessRequest,
        signal: options.signal ?? null,
        ...(rebuildSubprocessEntry === null
          ? {}
          : { entry: rebuildSubprocessEntry }),
      })
      : await buildReplaySafeAccountingCache({
        ...options,
        scan: effectiveScan,
        sourceMode: selectedSourceMode,
        contextBehavior: selectedContextBehavior,
        expectedGeneration,
        unifiedIndexFile: selectedSourceMode === "unified"
          ? selectedUnifiedIndexFile
          : unifiedIndexFile,
      });
  } catch (error) {
    // A child that died without a typed refusal joins the memory-budget
    // misses on the deferral path: the failure is overwhelmingly a memory
    // event (V8 heap-cap abort, OS OOM kill) and the deferral is the fail-
    // closed behavior the incident taught — retain the prior cache, back
    // off, surface the streak — never a crash loop and never a blanked
    // dashboard.
    if (!isAccountingBudgetMiss(error)
        && error?.code !== "accounting_rebuild_subprocess_failed") {
      throw error;
    }
    // The rebuild missed its memory budget. Per owner directive the budget is
    // a TARGET, never a hard dashboard-blanker: the whole refresh must NOT
    // fail and the last good on-disk cache must survive untouched. Control
    // never reaches the write below, so the prior cache is retained verbatim;
    // the fuller rebuild is DEFERRED and the recent collector pass + quota
    // card that already ran stay authoritative. This mirrors the
    // composition-fit fail-soft (composition:null -> median fallback), widened
    // from one sub-artifact to the whole accounting artifact.
    let retainedCache = null;
    try {
      const stored = await readReplaySafeAccountingCache({
        stateFile: selectedStateFile,
      });
      if (stored.status === "available") retainedCache = stored.cache;
    } catch {
      // A prior cache that cannot be read is treated as absent: the surface
      // then shows honest insufficient-evidence rather than a stale estimate,
      // and this read failure never turns the soft-fail back into a hard one.
      retainedCache = null;
    }
    const deferred = Object.freeze({
      status: "accounting_rebuild_deferred",
      reason: error.code,
      retained: retainedCache !== null,
      generatedAt: retainedCache?.generatedAt ?? null,
      coveredAt: retainedCache?.coveredAt ?? null,
    });
    if (onAccountingRebuildDeferred !== null) {
      try {
        await onAccountingRebuildDeferred({
          reason: deferred.reason,
          retained: deferred.retained,
        });
      } catch {
        // The degraded-event trail must never affect the refresh outcome.
      }
    }
    return deferred;
  }
  // Validate the complete derived artifact before publication. The write is
  // atomic, but atomicity alone would preserve a newly-created invalid cache;
  // fail closed here so a bad build leaves the prior valid state untouched.
  assertReplaySafeAccountingCache(cache);
  if (Buffer.byteLength(stableJson(cache)) > MAX_CACHE_BYTES) {
    throw fixedError("cache_invalid_size");
  }
  await writeLocalCollectorAccountingCache({ stateFile: selectedStateFile, cache });
  return cache;
}

function validWeeklyCalibrationInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.status !== "complete"
      || value.encoding !== "accounting_compact_v2"
      || !["unified_index", "windowed_scan"].includes(value.source)
      || canonicalInstant(value.coveredAt?.startAt) === null
      || canonicalInstant(value.coveredAt?.endAt) === null
      || Date.parse(value.coveredAt.startAt)
        > Date.parse(value.coveredAt.endAt)
      || !Number.isSafeInteger(value.retainedUsageEvents)
      || value.retainedUsageEvents < 0
      || !Number.isSafeInteger(value.retainedWeeklySnapshots)
      || value.retainedWeeklySnapshots < 0
      || !Number.isSafeInteger(value.estimatedRetainedBytes)
      || value.estimatedRetainedBytes < 0
      || !value.limits
      || typeof value.limits !== "object"
      || Array.isArray(value.limits)) return false;
  let limits;
  try {
    limits = transitionResourceLimits(value.limits);
  } catch {
    return false;
  }
  return value.retainedUsageEvents <= limits.usageEvents
    && value.retainedWeeklySnapshots <= limits.weeklySnapshots
    && value.retainedUsageEvents + value.retainedWeeklySnapshots
      <= limits.combinedInputs
    && value.estimatedRetainedBytes
      === value.retainedUsageEvents * COMPACT_USAGE_RETAINED_BYTES
        + value.retainedWeeklySnapshots * COMPACT_SNAPSHOT_RETAINED_BYTES
    && value.estimatedRetainedBytes <= limits.retainedBytes;
}

function validQuotaTimeline(
  value,
  coveredAt,
  { limitIds = ["codex"], durationMinutes = WEEKLY_WINDOW_MINUTES } = {},
) {
  if (!Array.isArray(value) || value.length > MAX_QUOTA_TIMELINE_ROWS) {
    return false;
  }
  const expectedKeys = [
    "accountAttribution",
    "durationMinutes",
    "limitId",
    "observedAt",
    "planType",
    "remainingPercent",
    "resetAt",
    "slot",
    "usedPercent",
  ].sort().join("\0");
  const coverageStartMs = Date.parse(coveredAt.startAt);
  const coverageEndMs = Date.parse(coveredAt.endAt);
  const seenBuckets = new Set();
  let priorSortKey = null;
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)
        || Object.keys(row).sort().join("\0") !== expectedKeys
        || canonicalInstant(row.observedAt) === null
        || canonicalInstant(row.resetAt) === null
        || !limitIds.includes(row.limitId)
        || !QUOTA_SLOTS.has(row.slot)
        || !(QUOTA_PLANS.has(row.planType) || row.planType === "unknown")
        || typeof row.usedPercent !== "number"
        || !Number.isFinite(row.usedPercent)
        || row.usedPercent < 0
        || row.usedPercent > 100
        || typeof row.remainingPercent !== "number"
        || !Number.isFinite(row.remainingPercent)
        || row.remainingPercent < 0
        || row.remainingPercent > 100
        || row.remainingPercent
          !== Number(Math.max(0, 100 - row.usedPercent).toFixed(3))
        || !isValidQuotaWindowDuration(row.durationMinutes)
        || (durationMinutes !== null && row.durationMinutes !== durationMinutes)
        || row.accountAttribution !== "historical_unattributed") {
      return false;
    }
    const observedMs = Date.parse(row.observedAt);
    if (observedMs < coverageStartMs || observedMs > coverageEndMs) {
      return false;
    }
    const bucketKey = quotaTimelineTrackBucketKey(row);
    if (seenBuckets.has(bucketKey)) return false;
    seenBuckets.add(bucketKey);
    // Percent is zero-padded so the string compare is numeric, matching the
    // writer's ascending numeric sort ("9.000" must not sort after "19.000").
    const sortKey = [
      row.observedAt,
      row.limitId,
      row.slot,
      row.resetAt,
      row.planType,
      row.usedPercent.toFixed(3).padStart(7, "0"),
    ].join("\0");
    if (priorSortKey !== null && sortKey < priorSortKey) return false;
    priorSortKey = sortKey;
  }
  return true;
}

function validRetainedPaceRate(rate) {
  return rate === null
    || (Number.isFinite(rate) && rate >= 0 && rate <= 100);
}

function validWeeklyPaceForecast(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== [
        "currentUsedPercent",
        "etaAt",
        "hoursToExhaustion",
        "hoursToReset",
        "pace",
        "remainingPercent",
        "resetsAt",
        "status",
      ].sort().join("\0")
      || !PACE_STATUSES.has(value.status)
      || !Number.isFinite(value.currentUsedPercent)
      || value.currentUsedPercent < 0
      || value.currentUsedPercent > 100
      || !Number.isFinite(value.remainingPercent)
      || value.remainingPercent < 0
      || value.remainingPercent > 100
      || value.remainingPercent
        !== Number(Math.max(0, 100 - value.currentUsedPercent).toFixed(3))
      || canonicalInstant(value.resetsAt) === null
      || !value.pace
      || typeof value.pace !== "object"
      || Array.isArray(value.pace)
      || Object.keys(value.pace).sort().join("\0")
        !== [
          "activePercentagePointsPerHour",
          "overallPercentagePointsPerHour",
        ].sort().join("\0")
      || !validRetainedPaceRate(value.pace.activePercentagePointsPerHour)
      || !validRetainedPaceRate(value.pace.overallPercentagePointsPerHour)
      || (value.etaAt !== null && canonicalInstant(value.etaAt) === null)
      || (value.hoursToExhaustion !== null
        && (!Number.isFinite(value.hoursToExhaustion)
          || value.hoursToExhaustion < 0))
      || (value.hoursToReset !== null
        && (!Number.isFinite(value.hoursToReset) || value.hoursToReset < 0))) {
    return false;
  }
  return true;
}

function validWeeklyPaceContainer(value) {
  return value !== undefined
    && value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && Object.hasOwn(value, "paceForecast")
    && validWeeklyPaceForecast(value.paceForecast);
}

function validPriceCardProvenance(row) {
  if (!Array.isArray(row?.priceCardIds)
      || row.priceCardIds.length > 32
      || !row.priceCardIds.every((id) => (
        typeof id === "string" && id.length > 0 && id.length <= 128
      ))
      || !Array.isArray(row?.priceCardBreakdown)
      || row.priceCardBreakdown.length > 32) return false;
  if (typeof row.apiPriceEquivalentUsdExact !== "string"
      || !/^\d+(?:\.\d+)?$/u.test(row.apiPriceEquivalentUsdExact)) {
    return false;
  }
  const ids = row.priceCardIds;
  if (new Set(ids).size !== ids.length || [...ids].sort().some((id, index) => id !== ids[index])) {
    return false;
  }
  let priorId = null;
  let breakdownEvents = 0;
  let breakdownCost = "0";
  for (const item of row.priceCardBreakdown) {
    if (!item || typeof item !== "object" || Array.isArray(item)
        || typeof item.priceCardId !== "string"
        || !ids.includes(item.priceCardId)
        || (priorId !== null && item.priceCardId <= priorId)
        || !Number.isSafeInteger(item.events)
        || item.events < 0
        || typeof item.costUsd !== "string"
        || !/^\d+(?:\.\d+)?$/u.test(item.costUsd)) return false;
    breakdownEvents += item.events;
    try {
      breakdownCost = addUsdStrings(breakdownCost, item.costUsd);
    } catch {
      return false;
    }
    priorId = item.priceCardId;
  }
  const coverage = row.pricingCoverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)
      || !Number.isSafeInteger(coverage.fullyPricedEvents)
      || !Number.isSafeInteger(coverage.partiallyPricedEvents)
      || !Number.isSafeInteger(coverage.unpricedEvents)
      || coverage.fullyPricedEvents < 0
      || coverage.partiallyPricedEvents < 0
      || coverage.unpricedEvents < 0
      || coverage.fullyPricedEvents
        + coverage.partiallyPricedEvents
        + coverage.unpricedEvents !== row.events
      || breakdownEvents !== coverage.fullyPricedEvents
        + coverage.partiallyPricedEvents
      || breakdownCost !== row.apiPriceEquivalentUsdExact) {
    return false;
  }
  const exactNumber = Number(row.apiPriceEquivalentUsdExact);
  const expectedRounded = roundedExactMoney(row.apiPriceEquivalentUsdExact);
  return Number.isFinite(exactNumber)
    && Number.isFinite(expectedRounded)
    && row.apiPriceEquivalentUsd === expectedRounded;
}

function validSourceDescriptor(value) {
  const expectedKeys = [
    "contextBehavior",
    "contractVersion",
    "coverageStatus",
    "coverage",
    "diagnosticsAvailable",
    "fallbackCount",
    "generation",
    "generationFingerprint",
    "generationMatched",
    "mode",
    "parserVersion",
    "readerVersion",
    "schemaVersion",
    "schemaVersionUsed",
    "capabilities",
  ].sort().join("\0");
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== expectedKeys
      || value.schemaVersion !== SOURCE_DESCRIPTOR_VERSION
      || !REPLAY_SAFE_ACCOUNTING_SOURCE_MODES.includes(value.mode)
      || !REPLAY_SAFE_ACCOUNTING_CONTEXT_BEHAVIORS.includes(
        value.contextBehavior,
      )) return false;
  const optionalText = [
    "contractVersion",
    "parserVersion",
    "readerVersion",
    "schemaVersionUsed",
  ];
  if (!optionalText.every((key) => (
    value[key] === null || boundedDescriptorText(value[key]) !== null
  ))) return false;
  if (!Number.isSafeInteger(value.fallbackCount)
      || value.fallbackCount < 0
      || typeof value.generationMatched !== "boolean") {
    return false;
  }
  if (value.mode === "unified") {
    if (value.fallbackCount !== 0
        || value.generationMatched !== true
        || generationToken(value.generationFingerprint) === null) {
      return false;
    }
    const coverage = value.coverage;
    const coverageKeys = [
      "admittedQuotaOccurrences",
      "coveredAt",
      "generatedAt",
      "generationProof",
      "quotaObservations",
      "quotaOccurrences",
      "sourceBytes",
      "sourceCount",
      "status",
      "usageEvents",
    ].sort().join("\0");
    const capabilityKeys = [
      "crashSafeGenerationPublication",
      "deterministicCanonicalOrder",
      "durableDiagnostics",
      "readsRawSources",
      "sourceOffsetProvenance",
      "sourceOrderingProvenance",
      "sourceScopedQuotaOccurrences",
    ].sort().join("\0");
    const validCoveredAt = coverage?.coveredAt === null
      || (coverage?.coveredAt
        && canonicalInstant(coverage.coveredAt.startAt) !== null
        && canonicalInstant(coverage.coveredAt.endAt) !== null
        && Date.parse(coverage.coveredAt.startAt)
          <= Date.parse(coverage.coveredAt.endAt));
    const validCount = (candidate) => (
      candidate === null
      || (Number.isSafeInteger(candidate) && candidate >= 0)
    );
    const capabilities = value.capabilities;
    if (value.generationFingerprint !== null
        && boundedDescriptorText(value.generationFingerprint) === null) {
      return false;
    }
    return value.coverageStatus === "complete"
      && value.diagnosticsAvailable === true
      && value.generationMatched === true
      && coverage
      && typeof coverage === "object"
      && !Array.isArray(coverage)
      && Object.keys(coverage).sort().join("\0") === coverageKeys
      && coverage.status === "complete"
      && (coverage.generatedAt === null
        || canonicalInstant(coverage.generatedAt) !== null)
      && validCoveredAt
      && [
        coverage.sourceCount,
        coverage.sourceBytes,
        coverage.usageEvents,
        coverage.quotaObservations,
        coverage.quotaOccurrences,
        coverage.admittedQuotaOccurrences,
      ].every(validCount)
      && coverage.generationProof === true
      && capabilities
      && typeof capabilities === "object"
      && !Array.isArray(capabilities)
      && Object.keys(capabilities).sort().join("\0") === capabilityKeys
      && capabilities.readsRawSources === false
      && capabilities.deterministicCanonicalOrder === true
      && capabilities.sourceOrderingProvenance === true
      && capabilities.sourceOffsetProvenance === true
      && capabilities.sourceScopedQuotaOccurrences === true
      && capabilities.durableDiagnostics === true
      && capabilities.crashSafeGenerationPublication === true
      && generationToken(value.generation) !== null;
  }
  return value.coverageStatus === null
    && value.generation === null
    && value.generationFingerprint === null
    && value.coverage === null
    && value.diagnosticsAvailable === null
    && value.generationMatched === false
    && value.capabilities === null;
}

function validHistoryPeriod(value) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.id === "history"
    && typeof value.label === "string"
    && value.label.length > 0
    && value.label.length <= 96
    && Number.isSafeInteger(value.events)
    && value.events >= 0
    && Number.isSafeInteger(value.totalTokens)
    && value.totalTokens >= 0
    && typeof value.apiPriceEquivalentUsd === "number"
    && Number.isFinite(value.apiPriceEquivalentUsd)
    && value.apiPriceEquivalentUsd >= 0
    && validPriceCardProvenance(value);
}

function validHistory(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !["available", "unavailable"].includes(value.status)
      || (value.errorCode !== null
        && (typeof value.errorCode !== "string"
          || !/^[a-z][a-z0-9_.-]{0,95}$/u.test(value.errorCode)))
      || !value.coverage
      || typeof value.coverage !== "object"
      || Array.isArray(value.coverage)
      || !["complete", "unavailable"].includes(value.coverage.status)
      || (value.generation !== null
        && generationToken(value.generation) === null)
      || (value.generationFingerprint !== null
        && generationToken(value.generationFingerprint) === null)
      || value.coverage.generation !== value.generation
      || value.coverage.generationFingerprint
        !== value.generationFingerprint) return false;
  const coveredAt = value.coverage.coveredAt;
  if (!coveredAt || typeof coveredAt !== "object" || Array.isArray(coveredAt)) {
    return false;
  }
  const validCoveredAt = value.coverage.status === "unavailable"
    ? ((coveredAt.startAt === null && coveredAt.endAt === null)
      || (canonicalInstant(coveredAt.startAt) !== null
        && canonicalInstant(coveredAt.endAt) !== null
        && Date.parse(coveredAt.startAt) <= Date.parse(coveredAt.endAt)))
    : canonicalInstant(coveredAt.startAt) !== null
      && canonicalInstant(coveredAt.endAt) !== null
      && Date.parse(coveredAt.startAt) <= Date.parse(coveredAt.endAt)
      && canonicalInstant(value.coverage.generatedAt) !== null;
  if (!validCoveredAt) return false;
  if (value.status === "available") {
    return value.errorCode === null
      && value.coverage.status === "complete"
      && value.generation !== null
      && validHistoryPeriod(value.period);
  }
  return value.errorCode !== null
    && value.period === null
    && value.coverage.status === "unavailable";
}

function speedWeightingTotals(value) {
  const shape = emptySpeedWeightingCrossing();
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((speed) => !Object.hasOwn(shape, speed))) {
    return null;
  }
  let events = 0;
  let apiPriceEquivalentUsd = 0;
  const bySpeed = {};
  for (const [speed, families] of Object.entries(shape)) {
    const selected = value[speed] ?? {};
    if (!selected || typeof selected !== "object" || Array.isArray(selected)
        || Object.keys(selected).some(
          (family) => !Object.hasOwn(families, family),
        )) return null;
    let speedEvents = 0;
    let speedUsd = 0;
    for (const family of Object.keys(families)) {
      const cell = selected[family];
      if (cell === undefined) continue;
      if (!cell || typeof cell !== "object" || Array.isArray(cell)
          || Object.keys(cell).sort().join(",")
            !== "apiPriceEquivalentUsd,events"
          || !Number.isSafeInteger(cell.events) || cell.events < 0
          || typeof cell.apiPriceEquivalentUsd !== "number"
          || !Number.isFinite(cell.apiPriceEquivalentUsd)
          || cell.apiPriceEquivalentUsd < 0) return null;
      speedEvents += cell.events;
      speedUsd += cell.apiPriceEquivalentUsd;
    }
    bySpeed[speed] = { events: speedEvents, usd: speedUsd };
    events += speedEvents;
    apiPriceEquivalentUsd += speedUsd;
  }
  return { events, apiPriceEquivalentUsd, bySpeed };
}

function validTimelineSpeedWeighting(row) {
  const observed = speedWeightingTotals(row?.speedWeighting);
  const declared = speedWeightingTotals(row?.declaredSpeedWeighting);
  if (observed === null || declared === null
      || observed.events !== row.usageEvents
      || Math.abs(observed.apiPriceEquivalentUsd - row.apiPriceEquivalentUsd)
        > 0.00002
      || declared.events > (observed.bySpeed.unknown?.events ?? 0)
      || declared.apiPriceEquivalentUsd
        > (observed.bySpeed.unknown?.usd ?? 0) + 0.00002) return false;
  return true;
}

function validAllowanceCalibrationSummary(value, forcedCandidateId) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schemaVersion !== "weekly-calibration-summary-v0.1"
      || !["estimated", "insufficient_evidence"].includes(value.status)
      || canonicalInstant(value.generatedAt) === null
      || value.accountAttribution?.status !== "historical_unattributed"
      || value.accountAttribution?.maySpanMultipleAccounts !== true
      || value.validation?.selectedCostBasis !== forcedCandidateId
      || !Array.isArray(value.recentResets)
      || value.recentResets.length > BOUNDED_WEEKLY_CALIBRATION_RESET_LIMIT) {
    return false;
  }
  if (value.status === "insufficient_evidence") return value.estimate === null;
  const estimate = value.estimate;
  return estimate && typeof estimate === "object" && !Array.isArray(estimate)
    && Number.isSafeInteger(estimate.qualifyingResets)
    && estimate.qualifyingResets > 0
    && Number.isFinite(estimate.medianApiPriceEquivalentUsd)
    && estimate.medianApiPriceEquivalentUsd > 0
    && Number.isFinite(estimate.plausibleRangeUsd?.lower)
    && estimate.plausibleRangeUsd.lower > 0
    && Number.isFinite(estimate.plausibleRangeUsd?.upper)
    && estimate.plausibleRangeUsd.upper >= estimate.plausibleRangeUsd.lower;
}

function validAllowanceCapacityByScenario(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schemaVersion !== ALLOWANCE_CAPACITY_SCHEMA_VERSION
      || !value.scenarios || typeof value.scenarios !== "object"
      || Array.isArray(value.scenarios)
      || Object.keys(value.scenarios).sort().join(",")
        !== Object.keys(ALLOWANCE_SCENARIO_CANDIDATES).sort().join(",")) {
    return false;
  }
  for (const [scenario, forcedCandidateId] of Object.entries(
    ALLOWANCE_SCENARIO_CANDIDATES,
  )) {
    const row = value.scenarios[scenario];
    const expectedBasis = codexPrimaryAllowanceBasis(scenario);
    if (!row || typeof row !== "object" || Array.isArray(row)
        || stableJson(row.basis) !== stableJson(expectedBasis)
        || value.basisFamilyId !== expectedBasis.basisFamilyId
        || !validAllowanceCalibrationSummary(
          row.calibration,
          forcedCandidateId,
        )) return false;
  }
  return true;
}

const COMPOSITION_CACHE_STATUSES = new Set([
  "fitted",
  "fallback_blended",
  "insufficient_observations",
]);

// The composition block a v0.7 cache carries on weeklyCalibration. `null` is
// a valid value (the reporting projection stores null for a malformed or
// absent input); a present block must be internally coherent — in particular
// a vector may exist only under the "fitted" status.
function validWeeklyCalibrationComposition(value) {
  if (value === null || value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !COMPOSITION_CACHE_STATUSES.has(value.status)) return false;
  const finiteOrNull = (candidate, minimum = Number.NEGATIVE_INFINITY) => (
    candidate === null
    || (typeof candidate === "number"
      && Number.isFinite(candidate)
      && candidate >= minimum)
  );
  if (!finiteOrNull(value.r2)
      || !finiteOrNull(value.singleConstantR2)
      || !finiteOrNull(value.singleConstantUsd, 0)
      || !finiteOrNull(value.blendedRecentMixUsd, 0)
      || !finiteOrNull(value.grainHours, 0)
      || !finiteOrNull(value.recentMixDays, 0)
      || !Number.isSafeInteger(value.observationCount)
      || value.observationCount < 0) return false;
  // The fitted mix, held to the same shape rule as the capacity vector: it is
  // the only record of a model that consumed the allowance without earning a
  // column of its own, and the dashboard names those models from it.
  const shares = value.modelCostShares;
  if (shares !== null && shares !== undefined) {
    if (typeof shares !== "object" || Array.isArray(shares)) return false;
    if (!Object.entries(shares).every(([model, share]) => (
      typeof model === "string"
      && model.length > 0
      && model.length <= 64
      && (share === null
        || (typeof share === "number"
          && Number.isFinite(share)
          && share >= 0
          && share <= 1))
    ))) return false;
  }
  const vector = value.capacityUsdByModel;
  if (vector === null) return true;
  if (value.status !== "fitted"
      || !vector || typeof vector !== "object" || Array.isArray(vector)) {
    return false;
  }
  return Object.entries(vector).every(([model, capacity]) => (
    typeof model === "string"
    && model.length > 0
    && model.length <= 64
    && (capacity === null
      || (typeof capacity === "number"
        && Number.isFinite(capacity)
        && capacity > 0))
  ));
}

// Additive v0.7 field, present only when the composition fit itself threw
// (resource ceiling, abort, numerical failure): the build completed with
// `composition: null` and this bounded record says why, so a blank
// composition caused by a failure stays distinguishable against a corpus that
// simply never supported a fit.
// Absent on caches whose fit ran to completion.
function validWeeklyCalibrationCompositionStatus(value, composition) {
  if (value === undefined) return true;
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === "reason\0status"
    && value.status === "fit_failed"
    && typeof value.reason === "string"
    && COMPOSITION_FIT_FAILURE_REASON_PATTERN.test(value.reason)
    // A failed fit can never have produced a composition block.
    && (composition === null || composition === undefined);
}

function validCache(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schemaVersion !== REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION
      || canonicalInstant(value.generatedAt) === null
      || canonicalInstant(value.coveredAt?.startAt) === null
      || canonicalInstant(value.coveredAt?.endAt) === null
      || value.accountingMethod
        !== "lineage_aware_cumulative_snapshot_replay_exclusion"
      || value.priceEpochBasis !== HISTORICAL_PRICE_EPOCH_BASIS
      // A replay-safe total is meaningful only under the exact price registry
      // that produced it. Never let an older, higher price card silently
      // survive a registry correction just because its JSON shape is valid.
      || value.priceRegistryVersion !== APP_PRICE_REGISTRY_MANIFEST.version
      || value.priceRegistryObservedAt !== APP_PRICE_REGISTRY_MANIFEST.observedAt
      || !validSourceDescriptor(value.sourceDescriptor)
      || !validHistory(value.history)
      || value.history.generation !== value.sourceDescriptor.generation
      || value.history.generationFingerprint
        !== value.sourceDescriptor.generationFingerprint
      || !Array.isArray(value.periods)
      || !Array.isArray(value.timeline)
      || !validQuotaTimeline(value.quotaTimeline, value.coveredAt)
      || !validQuotaTimeline(
        value.sparkQuotaTimeline,
        value.coveredAt,
        { limitIds: SPARK_QUOTA_LIMIT_IDS, durationMinutes: null },
      )
      || (value.weekly !== undefined && !validWeeklyPaceContainer(value.weekly))
      || !validWeeklyCalibrationInput(value.weeklyCalibrationInput)
      || !validAllowanceCapacityByScenario(
        value.allowanceCapacityByScenario,
      )
      || value.weeklyCalibration?.schemaVersion
        !== "weekly-calibration-summary-v0.1"
      || canonicalInstant(value.weeklyCalibration.generatedAt) === null
      || !["estimated", "insufficient_evidence"].includes(
        value.weeklyCalibration.status,
      )
      || value.weeklyCalibration.accountAttribution?.status
        !== "historical_unattributed"
      || value.weeklyCalibration.accountAttribution?.maySpanMultipleAccounts
        !== true
      || !Array.isArray(value.weeklyCalibration.recentResets)
      || value.weeklyCalibration.recentResets.length
        > BOUNDED_WEEKLY_CALIBRATION_RESET_LIMIT
      || !validWeeklyCalibrationComposition(
        value.weeklyCalibration.composition,
      )
      || !validWeeklyCalibrationCompositionStatus(
        value.weeklyCalibration.compositionStatus,
        value.weeklyCalibration.composition,
      )
      || value.periods.length !== 4
      || !Number.isSafeInteger(value.bucketMinutes)
      || value.bucketMinutes !== 15) return false;
  const ids = value.periods.map((row) => row?.id).sort().join(",");
  return ids === "24h,30d,7d,all"
    && value.periods.every((row) => (
      Number.isSafeInteger(row.events)
      && row.events >= 0
      && Number.isSafeInteger(row.totalTokens)
      && row.totalTokens >= 0
      && typeof row.apiPriceEquivalentUsd === "number"
      && Number.isFinite(row.apiPriceEquivalentUsd)
      && row.apiPriceEquivalentUsd >= 0
      && validPriceCardProvenance(row)
    ))
    && value.timeline.every((row) => (
      canonicalInstant(row?.startAt) !== null
      && canonicalInstant(row?.endAt) !== null
      && Number.isSafeInteger(row?.usageEvents)
      && row.usageEvents >= 0
      && Number.isSafeInteger(row?.totalTokens)
      && row.totalTokens >= 0
      && typeof row?.apiPriceEquivalentUsd === "number"
      && Number.isFinite(row.apiPriceEquivalentUsd)
      && row.apiPriceEquivalentUsd >= 0
      && validTimelineSpeedWeighting(row)
    ))
    && Array.isArray(value.sparkUsageTimeline)
    && value.sparkUsageTimeline.every((row) => (
      canonicalInstant(row?.startAt) !== null
      && canonicalInstant(row?.endAt) !== null
      && Number.isSafeInteger(row?.usageEvents)
      && row.usageEvents >= 0
      && Number.isSafeInteger(row?.totalTokens)
      && row.totalTokens >= 0
      && typeof row?.apiPriceEquivalentUsd === "number"
      && Number.isFinite(row.apiPriceEquivalentUsd)
      && row.apiPriceEquivalentUsd >= 0
      && validTimelineSpeedWeighting(row)
    ));
}

export async function readReplaySafeAccountingCache({
  stateFile = null,
  cacheFile = undefined,
  now = null,
  maximumAgeMs = null,
  sourceMode = null,
  expectedGeneration = null,
  contextBehavior = null,
} = {}) {
  if (cacheFile !== undefined) {
    throw new TypeError("cacheFile was retired; use stateFile");
  }
  const selectedStateFile = stateFile ?? defaultReplaySafeAccountingCachePath();
  if (typeof selectedStateFile !== "string" || selectedStateFile.length < 1) {
    throw new TypeError("Replay-safe SQLite state path is invalid");
  }
  if (now !== null && typeof now !== "function") {
    throw new TypeError("now must be a function or null");
  }
  if (maximumAgeMs !== null
      && (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 0)) {
    throw new TypeError("maximumAgeMs must be a non-negative safe integer or null");
  }
  if (sourceMode !== null && sourceMode !== undefined) {
    normalizeAccountingSourceMode(sourceMode);
  }
  if (sourceMode === "unified"
      && (expectedGeneration === null || expectedGeneration === undefined)) {
    throw fixedError("accounting_unified_generation_required");
  }
  if (contextBehavior !== null && contextBehavior !== undefined) {
    normalizeContextBehavior(contextBehavior);
  }
  if (expectedGeneration !== null
      && expectedGeneration !== undefined
      && expectedGenerationTokens(expectedGeneration).length === 0) {
    throw new TypeError("expectedGeneration is invalid");
  }
  let unavailableErrorCode = null;
  let parsed = null;
  try {
    await prepareLocalCollectorState({ stateFile: selectedStateFile });
    const stored = await readLocalCollectorAccountingCache({ stateFile: selectedStateFile });
    if (stored.status === "missing" || stored.cache === null) {
      unavailableErrorCode = "cache_missing";
    } else {
      parsed = stored.cache;
    }
  } catch (error) {
    unavailableErrorCode = error?.code === "local_collector_state_missing"
      ? "cache_missing"
      : "cache_unavailable";
  }
  let staleCache = null;
  if (parsed !== null && !validCache(parsed)) {
    const registryOutdated = (
      parsed?.priceRegistryVersion !== undefined
      || parsed?.priceRegistryObservedAt !== undefined
    ) && (
      parsed?.priceRegistryVersion !== APP_PRICE_REGISTRY_MANIFEST.version
      || parsed?.priceRegistryObservedAt
        !== APP_PRICE_REGISTRY_MANIFEST.observedAt
    );
    unavailableErrorCode = registryOutdated
      ? "cache_price_registry_outdated"
      : parsed?.schemaVersion !== REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION
        || parsed?.priceEpochBasis !== HISTORICAL_PRICE_EPOCH_BASIS
        ? "cache_accounting_semantics_outdated"
        : "cache_invalid";
    // The one refusal every updater walks through: prices are current but the
    // accounting semantics version changed, so the artifact fails the CURRENT
    // validator by design. Withholding it entirely is what put every
    // large-history user on a "$0.00 until the rebuild lands" surface — and
    // the rebuild can take a while at scale. The prior artifact is therefore
    // returned on a SEPARATE, explicitly stale channel: provenance names the
    // semantic version it was computed under and when, the current-cache
    // contract (`cache`) stays null so no caller can mistake it for current,
    // and consumers that choose to serve it must label it. A registry-outdated
    // cache stays fully withheld — its prices are wrong, not merely
    // differently derived — as does a structurally invalid one.
    if (unavailableErrorCode === "cache_accounting_semantics_outdated"
        && typeof parsed.schemaVersion === "string"
        && parsed.schemaVersion.length > 0
        && canonicalInstant(parsed.generatedAt) !== null
        && canonicalInstant(parsed.coveredAt?.startAt) !== null
        && canonicalInstant(parsed.coveredAt?.endAt) !== null) {
      staleCache = {
        stale: true,
        schemaVersion: parsed.schemaVersion,
        computedAt: parsed.generatedAt,
        coveredAt: {
          startAt: parsed.coveredAt.startAt,
          endAt: parsed.coveredAt.endAt,
        },
        cache: parsed,
      };
    }
    parsed = null;
  }
  if (parsed === null) {
    return {
      status: "unavailable",
      errorCode: unavailableErrorCode ?? "cache_unavailable",
      cache: null,
      ...(staleCache === null ? {} : { staleCache }),
    };
  }
  const descriptor = parsed.sourceDescriptor;
  if (sourceMode !== null
      && sourceMode !== undefined
      && descriptor.mode !== sourceMode) {
    return {
      status: "unavailable",
      errorCode: "cache_source_mode_mismatch",
      cache: null,
    };
  }
  if (contextBehavior !== null
      && contextBehavior !== undefined
      && descriptor.contextBehavior !== contextBehavior) {
    return {
      status: "unavailable",
      errorCode: "cache_context_behavior_mismatch",
      cache: null,
    };
  }
  if (expectedGeneration !== null && expectedGeneration !== undefined) {
    const expectedTokens = expectedGenerationTokens(expectedGeneration);
    const storedGenerations = [
      generationToken(descriptor.generation),
      generationToken(descriptor.generationFingerprint),
    ].filter((value) => value !== null);
    if (storedGenerations.length === 0
        || expectedTokens.length === 0
        || !generationMatchesExpected(expectedGeneration, storedGenerations)) {
      return {
        status: "unavailable",
        errorCode: "cache_generation_mismatch",
        cache: null,
      };
    }
  }
  if (now !== null) {
    const nowMs = now();
    if (!Number.isFinite(nowMs)) throw new TypeError("now must return a finite epoch timestamp");
    const coverageEndMs = Date.parse(parsed.coveredAt.endAt);
    if (coverageEndMs > nowMs) {
      return {
        status: "unavailable",
        errorCode: "cache_from_future",
        cache: null,
      };
    }
    const ageMs = Math.max(0, nowMs - coverageEndMs);
    if (maximumAgeMs !== null && ageMs > maximumAgeMs) {
      return {
        status: "stale",
        errorCode: "cache_stale",
        ageSeconds: Math.round(ageMs / 1_000),
        cache: parsed,
      };
    }
    return {
      status: "available",
      errorCode: null,
      ageSeconds: Math.round(ageMs / 1_000),
      cache: parsed,
    };
  }
  return { status: "available", errorCode: null, cache: parsed };
}

export function assertReplaySafeAccountingCache(value) {
  if (!validCache(value)) throw fixedError("cache_invalid");
  return value;
}
