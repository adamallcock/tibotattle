import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { createUsageExplainerService } from "./application/index.js";
import {
  createUsageExplainerSelectorCodec,
} from "./reporting/index.js";
import {
  defaultLocalUnifiedIndexSecretPath,
  localDigest,
  openLocalUnifiedIndex,
  readExistingDeviceSalt,
  readUnifiedIndexGenerationDescriptor,
} from "./local-unified-index.js";
import { readLocalWorkUsageSnapshot } from "./local-work-usage-source.js";
import {
  defaultLocalCompanionStateRoot,
  localCompanionStatePaths,
} from "./local-installation-diagnostics.js";

const ALLOWANCE_SOURCE_LIMIT = 25;

function fixedErrorCode(error, fallback) {
  return typeof error?.code === "string" && /^[a-z][a-z0-9_]{0,99}$/u.test(error.code)
    ? error.code
    : fallback;
}

export function defaultLocalUsageExplainerPaths({
  environment = process.env,
  homeDirectory = homedir(),
  platform = process.platform,
  fileExists = existsSync,
} = {}) {
  if (typeof fileExists !== "function") {
    throw new TypeError("fileExists must be a function");
  }
  const legacyRoot = defaultLocalCompanionStateRoot({
    environment,
    homeDirectory,
    platform,
  });
  let candidates;
  if (platform === "darwin") {
    const applicationSupport = join(homeDirectory, "Library", "Application Support");
    candidates = [
      ["electron_production", join(applicationSupport, "TiboTattle", "companion-state")],
      ["native_production", join(applicationSupport, "Usage Monitor")],
      ["legacy_cli", legacyRoot],
    ];
  } else if (platform === "win32") {
    const roaming = environment.APPDATA
      ?? join(homeDirectory, "AppData", "Roaming");
    candidates = [
      ["electron_production", join(roaming, "TiboTattle", "companion-state")],
      ["legacy_cli", legacyRoot],
    ];
  } else {
    const configuration = environment.XDG_CONFIG_HOME
      ?? join(homeDirectory, ".config");
    candidates = [
      ["electron_production", join(configuration, "TiboTattle", "companion-state")],
      ["legacy_cli", legacyRoot],
    ];
  }
  const selected = environment.USAGE_MONITOR_STATE_ROOT === undefined
    ? candidates.find(([, root]) => (
      fileExists(localCompanionStatePaths(root).unifiedIndexFile)
    )) ?? candidates[0]
    : ["environment_override", environment.USAGE_MONITOR_STATE_ROOT];
  const [sourceKind, stateRoot] = selected;
  const state = localCompanionStatePaths(stateRoot);
  return Object.freeze({
    sourceKind,
    indexFile: state.unifiedIndexFile,
    secretFile: state.unifiedIndexSecretFile,
    codexHome: environment.CODEX_HOME ?? join(homeDirectory, ".codex"),
  });
}

export function readLocalUsageExplainerHealth({ indexFile } = {}) {
  let database;
  try {
    database = openLocalUnifiedIndex(indexFile, { readOnly: true });
    database.exec("BEGIN");
    const generation = readUnifiedIndexGenerationDescriptor(database);
    if (generation === null || !["complete", "partial"].includes(generation.status)) {
      return {
        status: "unavailable",
        errorCode: "usage_explainer_index_unavailable",
        generation,
      };
    }
    return { status: "available", errorCode: null, generation };
  } catch (error) {
    return {
      status: "unavailable",
      errorCode: fixedErrorCode(error, "usage_explainer_index_unavailable"),
      generation: null,
    };
  } finally {
    database?.close();
  }
}

const ALLOWANCE_MOVEMENT_QUERY = `
  WITH eligible AS (
    SELECT q.id, q.observed_at_ms, q.provider, q.plan_type, q.limit_id,
           q.used_percent, q.resets_at_ms, q.duration_mins
    FROM quota_occurrence q
    JOIN generation_source gs ON gs.generation_id = ?
      AND gs.source_local = q.source_local
      AND gs.source_ordinal = q.source_ordinal
      AND q.source_offset >= 0
      AND q.source_offset <= gs.scanned_bytes
      AND gs.status IN ('skipped', 'touched', 'resumed', 'rescanned', 'complete')
      AND gs.diagnostics_complete = 1
    WHERE q.admission = 'admitted'
      AND q.observed_at_ms >= ?
      AND q.observed_at_ms < ?
  ), ranked AS (
    SELECT *,
      ROW_NUMBER() OVER (
        PARTITION BY provider, COALESCE(plan_type, ''), limit_id,
          duration_mins, COALESCE(resets_at_ms, -1)
        ORDER BY observed_at_ms, id
      ) AS first_rank,
      ROW_NUMBER() OVER (
        PARTITION BY provider, COALESCE(plan_type, ''), limit_id,
          duration_mins, COALESCE(resets_at_ms, -1)
        ORDER BY observed_at_ms DESC, id DESC
      ) AS last_rank
    FROM eligible
  ), collapsed AS (
    SELECT provider, COALESCE(plan_type, 'unknown') AS plan_type, limit_id,
           duration_mins, resets_at_ms,
           MIN(observed_at_ms) AS first_observed_at_ms,
           MAX(observed_at_ms) AS last_observed_at_ms,
           MAX(CASE WHEN first_rank = 1 THEN used_percent END) AS first_used_percent,
           MAX(CASE WHEN last_rank = 1 THEN used_percent END) AS last_used_percent,
           COUNT(*) AS observation_count
    FROM ranked
    GROUP BY provider, COALESCE(plan_type, ''), limit_id,
             duration_mins, COALESCE(resets_at_ms, -1)
  ), classified AS (
    SELECT *, CASE
      WHEN resets_at_ms IS NULL THEN 3
      WHEN observation_count < 2 THEN 4
      WHEN last_used_percent >= first_used_percent THEN 1
      ELSE 2
    END AS movement_status_rank
    FROM collapsed
  )
  SELECT *,
    COUNT(*) OVER () AS total_count,
    SUM(CASE WHEN movement_status_rank = 1 THEN 1 ELSE 0 END)
      OVER () AS observed_count,
    SUM(CASE WHEN movement_status_rank = 2 THEN 1 ELSE 0 END)
      OVER () AS non_monotonic_count,
    SUM(CASE WHEN movement_status_rank = 3 THEN 1 ELSE 0 END)
      OVER () AS reset_identity_missing_count,
    SUM(CASE WHEN movement_status_rank = 4 THEN 1 ELSE 0 END)
      OVER () AS single_observation_count
  FROM classified
  ORDER BY movement_status_rank,
           CASE WHEN movement_status_rank = 1
             THEN ABS(last_used_percent - first_used_percent)
             ELSE NULL
           END DESC,
           last_observed_at_ms DESC,
           provider, plan_type, limit_id,
           duration_mins, COALESCE(resets_at_ms, -1)
  LIMIT ? OFFSET ?`;

export function projectLocalAllowanceMovementRows(rows) {
  if (!Array.isArray(rows) || rows.length > ALLOWANCE_SOURCE_LIMIT) {
    throw new TypeError("allowance movement rows are invalid");
  }
  return rows.map((row) => {
    const first = Number(row.first_used_percent);
    const last = Number(row.last_used_percent);
    const observations = Number(row.observation_count);
    const resetKnown = row.resets_at_ms !== null;
    const monotonic = last >= first;
    return {
      provider: row.provider,
      planType: row.plan_type,
      limitId: row.limit_id,
      durationMins: Number(row.duration_mins),
      resetsAtMs: resetKnown ? Number(row.resets_at_ms) : null,
      firstObservedAtMs: Number(row.first_observed_at_ms),
      lastObservedAtMs: Number(row.last_observed_at_ms),
      firstUsedPercent: first,
      lastUsedPercent: last,
      movementPercentagePoints: resetKnown && monotonic && observations > 1
        ? Number((last - first).toFixed(3))
        : null,
      observationCount: observations,
      movementStatus: !resetKnown
        ? "reset_identity_missing"
        : observations < 2
          ? "single_observation"
          : monotonic
            ? "observed"
            : "non_monotonic",
    };
  });
}

export function readLocalAllowanceMovement({
  indexFile,
  fromMs,
  toMs,
  offset = 0,
  limit = ALLOWANCE_SOURCE_LIMIT,
} = {}) {
  if (
    typeof indexFile !== "string"
    || indexFile.length < 1
    || !Number.isSafeInteger(fromMs)
    || fromMs < 0
    || !Number.isSafeInteger(toMs)
    || toMs < fromMs
    || !Number.isSafeInteger(offset)
    || offset < 0
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > ALLOWANCE_SOURCE_LIMIT
  ) {
    throw new TypeError("allowance movement input is invalid");
  }
  let database;
  try {
    database = openLocalUnifiedIndex(indexFile, { readOnly: true });
    database.exec("BEGIN");
    const generation = readUnifiedIndexGenerationDescriptor(database);
    if (generation === null || !["complete", "partial"].includes(generation.status)) {
      return {
        status: "unavailable",
        errorCode: "usage_explainer_index_unavailable",
        generation,
        windows: [],
        truncated: false,
        rowCount: 0,
        observedMovementCount: 0,
        resetIdentityMissingCount: 0,
        singleObservationCount: 0,
        nonMonotonicCount: 0,
        nextOffset: null,
      };
    }
    const rows = database.prepare(ALLOWANCE_MOVEMENT_QUERY).all(
      generation.id,
      fromMs,
      toMs,
      limit,
      offset,
    );
    const rowCount = rows.length === 0 ? 0 : Number(rows[0].total_count);
    const observedMovementCount = rows.length === 0
      ? 0
      : Number(rows[0].observed_count);
    const resetIdentityMissingCount = rows.length === 0
      ? 0
      : Number(rows[0].reset_identity_missing_count);
    const singleObservationCount = rows.length === 0
      ? 0
      : Number(rows[0].single_observation_count);
    const nonMonotonicCount = rows.length === 0
      ? 0
      : Number(rows[0].non_monotonic_count);
    const nextOffset = offset + rows.length < rowCount
      ? offset + rows.length
      : null;
    return {
      status: "available",
      errorCode: null,
      generation,
      windows: projectLocalAllowanceMovementRows(rows),
      truncated: nextOffset !== null,
      rowCount,
      observedMovementCount,
      resetIdentityMissingCount,
      singleObservationCount,
      nonMonotonicCount,
      nextOffset,
    };
  } catch (error) {
    return {
      status: "unavailable",
      errorCode: fixedErrorCode(error, "usage_explainer_allowance_unavailable"),
      generation: null,
      windows: [],
      truncated: false,
      rowCount: 0,
      observedMovementCount: 0,
      resetIdentityMissingCount: 0,
      singleObservationCount: 0,
      nonMonotonicCount: 0,
      nextOffset: null,
    };
  } finally {
    database?.close();
  }
}

export function createLocalUsageExplainer({
  environment = process.env,
  homeDirectory = homedir(),
  indexFile = null,
  secretFile = null,
  codexHome = null,
  clock = Date.now,
  readHealth = readLocalUsageExplainerHealth,
  readWorkUsage = readLocalWorkUsageSnapshot,
  readAllowance = readLocalAllowanceMovement,
} = {}) {
  const defaults = indexFile === null
    ? defaultLocalUsageExplainerPaths({ environment, homeDirectory })
    : null;
  const selectedIndex = resolve(indexFile ?? defaults.indexFile);
  const selectedSecret = resolve(
    secretFile ?? (indexFile === null
      ? defaults.secretFile
      : defaultLocalUnifiedIndexSecretPath(selectedIndex)),
  );
  const selectedCodexHome = resolve(
    codexHome
      ?? defaults?.codexHome
      ?? environment.CODEX_HOME
      ?? join(homeDirectory, ".codex"),
  );
  const sourceKind = indexFile === null ? defaults.sourceKind : "explicit_index";
  let codecPromise = null;
  return createUsageExplainerService({
    clock,
    readHealth: async () => ({
      ...await readHealth({ indexFile: selectedIndex }),
      sourceKind,
    }),
    readWorkUsage: ({ fromMs, toMs }) => readWorkUsage({
      indexFile: selectedIndex,
      secretFile: selectedSecret,
      codexHome: selectedCodexHome,
      fromMs,
      toMs,
    }),
    readAllowance: ({ fromMs, toMs, offset, limit }) => readAllowance({
      indexFile: selectedIndex,
      fromMs,
      toMs,
      offset,
      limit,
    }),
    loadSelectorCodec: () => {
      codecPromise ??= readExistingDeviceSalt(selectedSecret).then((salt) => (
        createUsageExplainerSelectorCodec({
          digest: (subject) => localDigest(
            salt,
            "usage-explainer",
            subject,
          ).toString("hex"),
        })
      ));
      return codecPromise;
    },
  });
}
