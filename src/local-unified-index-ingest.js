import { constants } from "node:fs";
import { copyFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  codexRolloutDiscoveryReceipt,
  discoverCodexRolloutInfos,
} from "./codex-log-scan.js";
import {
  createLineageSnapshots,
  extractRolloutUsage,
  inheritedTierSeed,
  ownObservedTier,
  rolloutContentQuarantineReason,
} from "./local-unified-index-extract.js";
import {
  createEventSink,
  createLocalUnifiedIndexCooperativeCheckpoint,
  defaultRebuildWorkerCount,
  lineageComponents,
  persistingCollector,
  rebuildLocalUnifiedIndex,
  localUnifiedIndexStageFile,
  validateLocalUnifiedIndexAttemptToken,
  sourceIdentityForInfo,
  sourceRepresentationIdentityForInfo,
  sourcePhysicalIdentityToken,
  sourcePhysicalStateToken,
  surfaceRow,
  writeCursorForOutcome,
} from "./local-unified-index-build.js";
import { createHistoryBaseSeedResolver } from "./local-unified-index-history.js";
import { withStableRolloutSource } from "./rollout-source-snapshot.js";
import {
  assertSafeLocalUnifiedIndexTarget,
  assertWindowsUnifiedIndexStagingUnavailable,
  createUnifiedIndexWriter,
  beginUnifiedIndexGeneration,
  defaultLocalUnifiedIndexPath,
  defaultLocalUnifiedIndexSecretPath,
  LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  LOCAL_UNIFIED_INDEX_SCHEMA_VERSION,
  LOCAL_UNIFIED_INDEX_SOURCE_IDENTITY_VERSION,
  LOCAL_UNIFIED_INDEX_USER_VERSION,
  openLocalUnifiedIndex,
  publishStagedUnifiedIndex,
  recoverUnifiedIndexGenerations,
  readOrCreateDeviceSalt,
  readUnifiedIndexGenerationDescriptor,
  removeAbandonedLocalUnifiedIndexStages,
  removeIfPresent,
  sessionLocal,
  snapshotLocal,
  sourceLocal,
  sourceOwnerLocal,
} from "./local-unified-index.js";

const MAXIMUM_COLD_BACKFILL_WORKERS = 10;
const MINIMUM_AUTOMATIC_PARALLEL_BACKFILL_BYTES = 1024 * 1024 * 1024;

function validCodexHomeValue(value) {
  if (typeof value === "string") return value.length > 0;
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof value.path === "string"
    && value.path.length > 0
    && (value.id === undefined || typeof value.id === "string")
    && (value.rootId === undefined || typeof value.rootId === "string");
}
export const LOCAL_UNIFIED_INDEX_DISCOVERY_LIMITS = Object.freeze({
  maximumDirectoryEntries: 500_000,
  maximumRolloutFiles: 125_000,
});

// Qualification-only diagnostics may expose one of these coarse operation
// phases.  Keep the vocabulary finite and content-free: no path, native
// message, SQL, or runtime error text crosses the boundary.
const WINDOWS_UNIFIED_INDEX_PHASE_ALLOWLIST = Object.freeze([
  "capability",
  "secret",
  "stage_prepare",
  "stage_create_or_clone",
  "session_open",
  "database_open_or_write",
  "close",
  "publish",
  "cleanup",
]);

function annotateUnifiedIndexFailure(error, phase) {
  if (process.platform !== "win32"
      || process.env.USAGE_MONITOR_WINDOWS_QUALIFICATION !== "1"
      || !WINDOWS_UNIFIED_INDEX_PHASE_ALLOWLIST.includes(phase)
      || error === null
      || (typeof error !== "object" && typeof error !== "function")) {
    return error;
  }
  try {
    // Never inspect or overwrite an existing value.  The native qualification
    // boundary reads only this own property and applies its own allowlist.
    if (!Object.hasOwn(error, "windowsUnifiedIndexStage")) {
      Object.defineProperty(error, "windowsUnifiedIndexStage", {
        configurable: false,
        enumerable: false,
        value: phase,
        writable: false,
      });
    }
  } catch {
    // Preserve the original error even when it is sealed or otherwise cannot
    // carry a non-enumerable diagnostic property.
  }
  return error;
}

// Incremental ingest: advance the live unified index by exactly the bytes the
// rollout corpus grew since the last pass.
//
// A cold rebuild reads the whole 79 GiB corpus in one run, which is fine once
// and absurd per refresh. This path resumes from per-source cursors — the
// same shape as the collector's checkpoint — so an ordinary pass reads only
// appended bytes plus whatever sources are new.
//
// Two facts make resuming SAFE rather than merely cheap:
//
//   1. Event keys are deterministic over (rollout, byte offset, observed-at),
//      so a crash between committing events and committing their cursor costs
//      one re-scan that re-inserts identical keys into `ON CONFLICT DO
//      NOTHING`. Nothing is ever double-counted.
//   2. The fork-replay boundary's ancestor snapshot sets are persisted
//      (`lineage_snapshot`, salted digests). The in-memory-only design was
//      recorded as valid strictly for one-pass rebuilds; an incremental pass
//      must answer for ancestors it is not currently scanning, and the
//      persisted sets are what answers.
//
// Memory stays bounded regardless of corpus or file size: the bounded-line
// cap governs the read, commit batches govern the write, and in-memory
// snapshot sets exist only for sources actually scanned in this pass, one
// lineage component at a time.

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function loadCursors(database) {
  const cursors = new Map();
  const hasOwnerLocal = database.prepare("PRAGMA table_info(source_cursor)")
    .all()
    .some((column) => column.name === "owner_local");
  // The cursor's ingest run names the parser version its rows were derived
  // under. A LEFT JOIN keeps a cursor loadable even if its run row is somehow
  // missing; a NULL parser_version then reads as "unknown", which classifies
  // as a forced rescan — the safe direction.
  const rows = database.prepare(`
    SELECT sc.source_local,
           ${hasOwnerLocal ? "sc.owner_local" : "NULL AS owner_local"},
           sc.source_ordinal, sc.session_local,
           sc.scanned_bytes, sc.size_bytes,
           sc.mtime_ms, sc.source_dev, sc.source_ino,
           sc.source_birthtime_ms, sc.source_ctime_ms,
           sc.source_identity_token, sc.source_state_token,
           sc.quarantine_code,
           sc.snapshots_persisted, sc.turn_context_seen,
           sc.carry_model, sc.carry_effort, sc.carry_tier_raw,
           sc.carry_tier_observed_at_ms, sc.carry_total_input,
           sc.carry_total_cached, sc.carry_total_cache_write,
           sc.carry_total_output, sc.carry_total_reasoning,
           sc.carry_total_total, cs.compacted_at_ms,
           cs.source_offset AS compaction_source_offset,
           cs.turn_context_pending,
           pv.parser_version AS parser_version
    FROM source_cursor sc
    LEFT JOIN source_boundary_state cs ON cs.source_local = sc.source_local
    LEFT JOIN ingest_run ir ON ir.id = sc.ingest_run_id
    LEFT JOIN parser_version pv ON pv.id = ir.parser_version_id`).all();
  for (const row of rows) {
    cursors.set(Buffer.from(row.source_local).toString("hex"), row);
  }
  return cursors;
}

function loadOwnerBindings(database) {
  const columns = database.prepare("PRAGMA table_info(source_cursor)").all();
  if (!columns.some((column) => column.name === "owner_local")) return null;
  const cursors = new Map();
  for (const row of database.prepare(`
    SELECT source_local, owner_local, session_local
    FROM source_cursor`).all()) {
    cursors.set(Buffer.from(row.source_local).toString("hex"), row);
  }
  return cursors;
}

function selectOwnedRolloutInfos(discoveredInfos, cursors, deviceSalt, {
  identityForInfo = sourceIdentityForInfo,
  ambiguousIdentities = [
    ...(discoveredInfos.ambiguousSourceIdentities ?? []),
    ...(discoveredInfos.ambiguousRolloutKeys ?? []),
  ],
} = {}) {
  const infos = [];
  const discoveredSourceKeys = new Set();
  const unavailableOwnerSourceKeys = new Set();
  const degradedRetainedSourceKeys = new Set();
  const configuredOwnerLocals = new Set(
    (discoveredInfos.configuredRootOwnerKeys ?? []).map((rootOwnerKey) => (
      sourceOwnerLocal(deviceSalt, rootOwnerKey).toString("hex")
    )),
  );
  const unavailableOwnerLocals = new Set(
    (discoveredInfos.unavailableRootOwnerKeys ?? []).map((rootOwnerKey) => (
      sourceOwnerLocal(deviceSalt, rootOwnerKey).toString("hex")
    )),
  );
  for (const logical of discoveredInfos) {
    const sourceHex = sourceLocal(
      deviceSalt,
      identityForInfo(logical),
    ).toString("hex");
    discoveredSourceKeys.add(sourceHex);
    const cursor = cursors.get(sourceHex);
    const remembered = cursor?.owner_local === null
        || cursor?.owner_local === undefined
      ? null
      : Buffer.from(cursor.owner_local).toString("hex");
    const candidates = Array.isArray(logical.physicalCandidates)
      ? logical.physicalCandidates
      : [logical];
    if (remembered === null) {
      infos.push(logical);
      continue;
    }
    const owned = candidates.find((candidate) => (
      typeof candidate.rootOwnerKey === "string"
      && sourceOwnerLocal(deviceSalt, candidate.rootOwnerKey).toString("hex")
        === remembered
    ));
    if (owned === undefined) {
      // A logical rollout is present only through another replica. Whether
      // the remembered root is unavailable or was removed from configuration,
      // silently rebinding would cross the persisted ownership boundary.
      unavailableOwnerSourceKeys.add(sourceHex);
      degradedRetainedSourceKeys.add(sourceHex);
      continue;
    }
    if (Number.isSafeInteger(logical.size)
        && Number.isSafeInteger(owned.size)
        && owned.size < logical.size) {
      // A compatible non-owner has advanced farther. Keep consuming the
      // remembered owner (it may independently append), but surface the held
      // tail instead of silently switching physical sources.
      degradedRetainedSourceKeys.add(sourceHex);
    }
    infos.push({
      ...owned,
      physicalCandidates: logical.physicalCandidates,
    });
  }
  for (const identity of ambiguousIdentities) {
    const sourceHex = sourceLocal(deviceSalt, identity).toString("hex");
    if (cursors.has(sourceHex)) degradedRetainedSourceKeys.add(sourceHex);
  }
  let missingRetainedSources = 0;
  for (const [sourceHex, cursor] of cursors) {
    if (discoveredSourceKeys.has(sourceHex)) continue;
    missingRetainedSources += 1;
    if (cursor.owner_local === null || cursor.owner_local === undefined) continue;
    const remembered = Buffer.from(cursor.owner_local).toString("hex");
    if (unavailableOwnerLocals.has(remembered)) {
      unavailableOwnerSourceKeys.add(sourceHex);
      degradedRetainedSourceKeys.add(sourceHex);
    } else if (!configuredOwnerLocals.has(remembered)) {
      // The physical owner was deliberately or accidentally removed from the
      // configured set. Retain LKG, but do not call a configured root down.
      degradedRetainedSourceKeys.add(sourceHex);
    }
  }
  // A discovered logical source whose remembered owner is missing is omitted
  // above and therefore also retained from the prior generation.
  missingRetainedSources += discoveredSourceKeys.size - infos.length;
  return {
    infos,
    unavailableOwnerSources: unavailableOwnerSourceKeys.size,
    missingRetainedSources,
    degradedRetainedSources: degradedRetainedSourceKeys.size,
  };
}

function coverageWithOwnership(base, cursors, ownership) {
  const fallback = base ?? {
    status: "ready",
    configuredRoots: 1,
    availableRoots: 1,
    emptyRoots: 0,
    unavailableRoots: 0,
    retainedHistory: false,
    unavailableOwnerSources: 0,
    ambiguousSources: 0,
  };
  const retainedHistory = ownership.missingRetainedSources > 0
    || ownership.degradedRetainedSources > 0
    || (fallback.status !== "ready" && cursors.size > 0);
  return Object.freeze({
    ...fallback,
    status: ownership.degradedRetainedSources > 0 && fallback.status === "ready"
      ? "partial"
      : fallback.status,
    retainedHistory,
    unavailableOwnerSources: ownership.unavailableOwnerSources,
  });
}

function carriedTotals(cursor) {
  const totals = {
    input_tokens: cursor.carry_total_input,
    cached_input_tokens: cursor.carry_total_cached,
    cache_write_input_tokens: cursor.carry_total_cache_write,
    output_tokens: cursor.carry_total_output,
    reasoning_output_tokens: cursor.carry_total_reasoning,
    total_tokens: cursor.carry_total_total,
  };
  for (const value of Object.values(totals)) {
    if (!Number.isSafeInteger(Number(value))) return null;
  }
  return Object.fromEntries(
    Object.entries(totals).map(([key, value]) => [key, Number(value)]),
  );
}

function carriedTier(cursor) {
  const observedAtMs = cursor.carry_tier_observed_at_ms;
  if (observedAtMs === null) return null;
  return {
    providerTierRaw: cursor.carry_tier_raw ?? null,
    observedAtMs: Number(observedAtMs),
  };
}

function carriedCompaction(cursor) {
  if (cursor.compacted_at_ms === null || cursor.compaction_source_offset === null) {
    return null;
  }
  const observedAtMs = Number(cursor.compacted_at_ms);
  const sourceOffset = Number(cursor.compaction_source_offset);
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0
      || !Number.isSafeInteger(sourceOffset) || sourceOffset < 0) {
    return null;
  }
  return { observedAtMs, sourceOffset };
}

function carriedTurnContextPending(cursor) {
  return Number(cursor.turn_context_pending ?? 0) === 1;
}

/**
 * Decide what this pass has to do for one source.
 *
 * - `skip`: nothing appended, cursor already current.
 * - `touch`: the v10 cursor is current but needs its deterministic physical
 *   owner binding stamped during the additive v11 migration; read no bytes.
 * - `resume`: the file grew; scan from the cursor with carried state.
 * - `rescan`: no cursor, or the file shrank (rotation/truncation), or the
 *   cursor was stamped by an older parser version (`reason:
 *   "parser_version"`) — the stored rows may be poisoned by the old
 *   derivation, so the whole file is re-derived and its old rows replaced.
 */
export function classifySource(info, cursor, expectedParserVersion = null) {
  const size = Number(info.size ?? 0);
  if (cursor === undefined) return { mode: "rescan" };
  if (expectedParserVersion !== null
      && cursor.parser_version !== expectedParserVersion) {
    return { mode: "rescan", reason: "parser_version" };
  }
  const identityMatches = sourcePhysicalIdentityToken(info) !== null
    && cursor.source_identity_token === sourcePhysicalIdentityToken(info);
  if (!identityMatches) return { mode: "rescan", reason: "identity_changed" };
  const cursorSize = Number(cursor.size_bytes);
  const scannedBytes = Number(cursor.scanned_bytes);
  if (!Number.isSafeInteger(cursorSize) || cursorSize < 0
      || !Number.isSafeInteger(scannedBytes) || scannedBytes < 0
      || scannedBytes > cursorSize
      || (cursor.quarantine_code === null && scannedBytes !== cursorSize)
      || (cursor.quarantine_code !== null && scannedBytes !== 0)) {
    return { mode: "rescan", reason: "cursor_invalid" };
  }
  if (size === cursorSize) {
    if (cursor.source_state_token === sourcePhysicalStateToken(info)) {
      return cursor.quarantine_code === null
        ? { mode: "skip" }
        : { mode: "quarantined", reason: cursor.quarantine_code };
    }
    return { mode: "rescan", reason: "same_size_changed" };
  }
  if (size > cursorSize) {
    return cursor.quarantine_code === null
      ? { mode: "resume" }
      : { mode: "rescan", reason: "quarantine_changed" };
  }
  return { mode: "rescan", reason: "shrink" };
}

/**
 * Advance the live unified index incrementally. Returns measured counts and
 * timings; `usageEvents` counts only rows actually inserted by this pass.
 */
export async function ingestLocalUnifiedIndexIncrement({
  codexHome,
  codexHomes = null,
  indexFile = defaultLocalUnifiedIndexPath(),
  secretFile = null,
  contractVersion,
  startAt = "1970-01-01T00:00:00.000Z",
  endAt = null,
  commitRows = 10_000,
  maximumLineBytes,
  coldBackfillWorkerCount = null,
  attemptToken = null,
  signal = null,
  onProgress = null,
  discoveryLimits = LOCAL_UNIFIED_INDEX_DISCOVERY_LIMITS,
  windowsProtectedStateStore = null,
  windowsFilesystemAdapter = null,
  windowsQualificationModeContext = null,
  stateRoot = null,
  resourceRoot = null,
  windowsSqliteStateSession = null,
  windowsSqliteStateSessionFactory = null,
  windowsSqliteStateStaging = null,
} = {}) {
  if (codexHome !== null && codexHome !== undefined
      && codexHomes !== null && codexHomes !== undefined) {
    throw new TypeError("codexHome and codexHomes are mutually exclusive");
  }
  if (codexHomes === null
      && (typeof codexHome !== "string" || codexHome.length < 1)) {
    throw new TypeError("codexHome or codexHomes must be configured");
  }
  if (codexHomes !== null
      && (!Array.isArray(codexHomes)
        || codexHomes.length < 1
        || codexHomes.length > 8
        || codexHomes.some((value) => !validCodexHomeValue(value)))) {
    throw new TypeError("codexHomes must contain one to eight paths");
  }
  try {
    assertWindowsUnifiedIndexStagingUnavailable({
      windowsSqliteStateStaging,
      windowsQualificationModeContext,
      windowsFilesystemAdapter,
      path: indexFile,
      stateRoot,
      resourceRoot,
    });
  } catch (error) {
    throw annotateUnifiedIndexFailure(error, "capability");
  }
  if (typeof contractVersion !== "string" || contractVersion.length < 1) {
    throw new TypeError("contractVersion must be a non-empty string");
  }
  if (coldBackfillWorkerCount !== null
      && (!Number.isSafeInteger(coldBackfillWorkerCount)
        || coldBackfillWorkerCount < 1
        || coldBackfillWorkerCount > MAXIMUM_COLD_BACKFILL_WORKERS)) {
    throw new TypeError(
      `coldBackfillWorkerCount must be null or between 1 and ${MAXIMUM_COLD_BACKFILL_WORKERS}`,
    );
  }
  validateLocalUnifiedIndexAttemptToken(attemptToken);
  const startedAt = performance.now();
  const resolvedIndexFile = resolve(indexFile);
  let liveTargetIdentity = null;
  let existingIndex = null;
  if (process.platform === "win32") {
    const targetName = basename(resolvedIndexFile.replaceAll("/", "\\"));
    try {
      liveTargetIdentity = windowsSqliteStateStaging.inspect(targetName);
      existingIndex = liveTargetIdentity;
    } catch (error) {
      if (error?.code !== "windows_sqlite_state_staging_database_missing") throw error;
    }
  } else {
    existingIndex = await assertSafeLocalUnifiedIndexTarget(resolvedIndexFile, {
      allowMissing: true,
      windowsSqliteStateSession,
      windowsQualificationModeContext,
      windowsFilesystemAdapter,
      stateRoot,
      resourceRoot,
    });
    // Recover space left by a companion that was killed before the normal
    // staged-build catch could discard its temporary index. This is
    // deliberately portable-only; Windows cleanup stays behind the native
    // protected-state staging boundary.
    await removeAbandonedLocalUnifiedIndexStages(resolvedIndexFile, {
      // The worker's token is the sole active attempt admitted by the
      // off-main parent guard. This lets cleanup distinguish an older
      // same-PID token after the age threshold while preserving this attempt
      // and all legacy/non-token names.
      activeAttemptToken: attemptToken,
    });
  }
  const discoveredInfos = await discoverCodexRolloutInfos({
    ...(codexHomes === null ? { codexHome } : { codexHomes }),
    startAt,
    endAt,
    signal,
    discoveryLimits,
  });
  const noCompletelyScannedRoots =
    (discoveredInfos.availableRootOwnerKeys?.length ?? 0) === 0;
  if ((discoveredInfos.rootCoverage?.status === "unavailable"
        || noCompletelyScannedRoots)
      && existingIndex === null) {
    throw fixedError("local_unified_index_roots_unavailable");
  }
  let deviceSalt;
  try {
    deviceSalt = await readOrCreateDeviceSalt(
      secretFile ?? defaultLocalUnifiedIndexSecretPath(resolvedIndexFile),
      {
        windowsProtectedStateStore,
        windowsQualificationModeContext,
        windowsFilesystemAdapter,
        stateRoot,
        resourceRoot,
      },
    );
  } catch (error) {
    throw annotateUnifiedIndexFailure(error, "secret");
  }
  const discovery = codexRolloutDiscoveryReceipt(discoveredInfos);
  const discoveredAt = performance.now();
  let infos = discoveredInfos;
  let rootCoverage = discoveredInfos.rootCoverage ?? null;
  const sourceBytes = discovery.discoveredSourceBytes;
  let coldRebuildReason = null;
  let retainedOwnershipBlocksColdRebuild = false;
  // The raw node:sqlite preflight is intentionally portable-only. Windows
  // must inspect/open the protected state through its qualified native
  // session, never through a path-based DatabaseSync connection.
  if (process.platform !== "win32") {
    // Inspect only the SQLite header/meta needed to identify a pre-current index.
    // The normal reader intentionally rejects old source-identity contracts;
    // this narrow preflight must detect them before a writable clone can retain
    // old rollout-key facts beside current rollout-id/snapshot facts.
    try {
    const raw = new DatabaseSync(resolvedIndexFile, {
      readOnly: true,
      timeout: 5_000,
    });
    try {
      const userVersion = Number(raw.prepare(
        "PRAGMA user_version",
      ).get()?.user_version);
      const preserveLegacyOwners = () => {
        const legacyCursors = loadOwnerBindings(raw);
        if (legacyCursors === null) return;
        const ownership = selectOwnedRolloutInfos(
          discoveredInfos,
          legacyCursors,
          deviceSalt,
          {
            identityForInfo: (info) => info.rolloutKey,
            ambiguousIdentities: discoveredInfos.ambiguousRolloutKeys ?? [],
          },
        );
        rootCoverage = coverageWithOwnership(
          discoveredInfos.rootCoverage,
          legacyCursors,
          ownership,
        );
        retainedOwnershipBlocksColdRebuild =
          ownership.degradedRetainedSources > 0;
      };
      if (userVersion < 10) {
        coldRebuildReason = "source_identity_changed";
        // Feature-branch v9 indexes already carry physical owner bindings but
        // predate immutable rollout identity. A cold rebuild is safe only when
        // every remembered owner is currently present; otherwise it would
        // discard LKG facts or silently adopt a replica under the new key.
        preserveLegacyOwners();
      } else {
        const rawSourceIdentity = raw.prepare(
          "SELECT value FROM meta WHERE key = 'source_identity_version'",
        ).get()?.value;
        if (rawSourceIdentity !== LOCAL_UNIFIED_INDEX_SOURCE_IDENTITY_VERSION) {
          // Covers a v9 file that was structurally widened by a generic
          // writable opener before ingest could perform its identity rebuild.
          coldRebuildReason = "source_identity_changed";
          preserveLegacyOwners();
        }
      }
      } finally {
        raw.close();
      }
    } catch {
      // A missing index is handled by the normal staged creation path. Other
      // unreadable files retain the existing fixed-error behavior below.
    }
  }
  if (process.platform === "win32"
      && liveTargetIdentity !== null
      && windowsSqliteStateSession === null
      && typeof windowsSqliteStateSessionFactory === "function") {
    const targetName = basename(resolvedIndexFile.replaceAll("/", "\\"));
    windowsSqliteStateSession = windowsSqliteStateSessionFactory({
      rootPath: dirname(resolvedIndexFile.replaceAll("/", "\\")),
      databaseName: targetName,
      readOnly: true,
      create: false,
      windowsQualificationModeContext,
      windowsQualificationResourceRoot: resourceRoot,
    });
  }
  // Read-only preflight avoids cloning/publishing when every current source
  // is byte-for-byte unchanged. A same-size mtime change is deliberately a
  // rescan (classifySource's conservative race policy), so this reads no
  // rollout body bytes and still catches replacement files.
  if (!signal?.aborted && coldRebuildReason === null) {
    let unchangedDatabase = null;
    try {
      unchangedDatabase = openLocalUnifiedIndex(resolvedIndexFile, {
        readOnly: true,
        windowsSqliteStateSession,
        windowsQualificationModeContext,
        windowsFilesystemAdapter,
        stateRoot,
        resourceRoot,
      });
      const schema = unchangedDatabase.prepare(
        "SELECT value FROM meta WHERE key = 'schema_version'",
      ).get()?.value;
      const userVersion = Number(
        unchangedDatabase.prepare("PRAGMA user_version").get()?.user_version,
      );
      if (schema !== LOCAL_UNIFIED_INDEX_SCHEMA_VERSION
          || ![10, LOCAL_UNIFIED_INDEX_USER_VERSION].includes(userVersion)) {
        coldRebuildReason = "legacy_schema";
      }
      const storedContract = unchangedDatabase.prepare(
        "SELECT value FROM meta WHERE key = 'contract_version'",
      ).get()?.value;
      if (coldRebuildReason === null && storedContract !== contractVersion) {
        coldRebuildReason = "contract_changed";
      }
      const storedSourceIdentity = unchangedDatabase.prepare(
        "SELECT value FROM meta WHERE key = 'source_identity_version'",
      ).get()?.value;
      if (coldRebuildReason === null
          && storedSourceIdentity !== LOCAL_UNIFIED_INDEX_SOURCE_IDENTITY_VERSION) {
        coldRebuildReason = "source_identity_changed";
      }
      const storedQuarantineFingerprint = unchangedDatabase.prepare(
        "SELECT value FROM meta WHERE key = 'rollout_quarantine_fingerprint'",
      ).get()?.value;
      const quarantineSetUnchanged = storedQuarantineFingerprint
        === discovery.quarantineFingerprint;
      let currentCursors = null;
      if (schema === LOCAL_UNIFIED_INDEX_SCHEMA_VERSION
          && [10, LOCAL_UNIFIED_INDEX_USER_VERSION].includes(userVersion)
          && storedSourceIdentity === LOCAL_UNIFIED_INDEX_SOURCE_IDENTITY_VERSION) {
        currentCursors = loadCursors(unchangedDatabase);
        const ownership = selectOwnedRolloutInfos(
          discoveredInfos,
          currentCursors,
          deviceSalt,
        );
        infos = ownership.infos;
        rootCoverage = coverageWithOwnership(
          discoveredInfos.rootCoverage,
          currentCursors,
          ownership,
        );
        retainedOwnershipBlocksColdRebuild =
          ownership.degradedRetainedSources > 0;
      }
      if (coldRebuildReason === null
          && schema === LOCAL_UNIFIED_INDEX_SCHEMA_VERSION
          && storedContract === contractVersion) {
        const cursors = currentCursors ?? loadCursors(unchangedDatabase);
        const descriptor = readUnifiedIndexGenerationDescriptor(
          unchangedDatabase,
        );
        const discoveryQuarantineKeys = new Set(discovery.quarantined.map((info) => (
          sourceLocal(
            deviceSalt,
            sourceIdentityForInfo(info),
          ).toString("hex")
        )));
        // A runtime quarantine remains an honest historical gap even if Codex
        // later rotates the damaged file away. The cursor is the durable,
        // content-free receipt for that gap; discovery-only quarantines are
        // counted by the discovery receipt instead and must not be doubled.
        const runtimeQuarantines = [...cursors.entries()]
          .filter(([sourceHex, cursor]) => (
            typeof cursor?.quarantine_code === "string"
              && !discoveryQuarantineKeys.has(sourceHex)
          ))
          .map(([sourceHex, cursor]) => ({ sourceHex, cursor }));
        const runtimeSkippedBytes = runtimeQuarantines.reduce(
          (sum, entry) => sum + Number(entry.cursor.size_bytes ?? 0),
          0,
        );
        const expectedSkippedThreads = new Set(discovery.quarantined.map((info) => (
          sessionLocal(
            deviceSalt,
            info.threadId ?? info.lineage?.sessionId ?? info.rolloutKey,
          ).toString("hex")
        )));
        for (const { cursor } of runtimeQuarantines) {
          if (cursor.session_local !== null) {
            expectedSkippedThreads.add(
              Buffer.from(cursor.session_local).toString("hex"),
            );
          }
        }
        const expectedSkippedSourceCount = discovery.skippedSourceCount
          + runtimeQuarantines.length;
        const expectedSkippedSourceBytes = discovery.skippedSourceBytes
          + runtimeSkippedBytes;
        const expectedSkippedThreadCount = expectedSkippedThreads.size;
        const expectedPartial = descriptor?.status === "partial"
          && descriptor.blockReason === "codex_rollout_sources_quarantined"
          && descriptor.skippedSourceCount === expectedSkippedSourceCount
          && descriptor.skippedSourceBytes === expectedSkippedSourceBytes
          && descriptor.skippedThreadCount === expectedSkippedThreadCount;
        const expectedToolPartial = descriptor?.status === "partial"
          && descriptor.blockReason === "tool_provenance_incomplete"
          && descriptor.skippedSourceCount === expectedSkippedSourceCount
          && descriptor.skippedSourceBytes === expectedSkippedSourceBytes
          && descriptor.skippedThreadCount === expectedSkippedThreadCount
          && descriptor.toolProvenanceComplete === false;
        // A previously published terminal partial remains a trustworthy base
        // for an incremental healing pass even when the current corpus no
        // longer has the same gap. The expected* forms above are deliberately
        // stricter: only an exact current match may take the zero-work return.
        const terminalQuarantinePartial = descriptor?.status === "partial"
          && descriptor.blockReason === "codex_rollout_sources_quarantined"
          && descriptor.skippedSourceCount > 0;
        const terminalToolPartial = descriptor?.status === "partial"
          && descriptor.blockReason === "tool_provenance_incomplete"
          && descriptor.toolProvenanceComplete === false;
        const supportedPreviousStatus = (descriptor?.status === "complete"
            && descriptor.blockReason === null)
          || terminalQuarantinePartial
          || terminalToolPartial;
        if (descriptor !== null && (
          !supportedPreviousStatus
          || descriptor.discoveryComplete !== true
          || descriptor.diagnosticsComplete !== true
          || descriptor.usageProvenanceComplete !== true
          || descriptor.sourceOrderComplete !== true
          || descriptor.quotaProvenanceComplete !== true
          || (descriptor.status === "complete"
            && descriptor.toolProvenanceComplete !== true)
        )) {
          coldRebuildReason = "incomplete_generation";
        }
        if (coldRebuildReason === null && descriptor !== null) {
          const unattestedSources = Number(unchangedDatabase.prepare(`
            SELECT (
              (SELECT COUNT(*) FROM source_cursor sc
               WHERE NOT EXISTS (
                 SELECT 1 FROM generation_source gs
                 WHERE gs.generation_id = ?
                   AND gs.source_local = sc.source_local))
              +
              (SELECT COUNT(*) FROM usage_event u
               WHERE u.source_local IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM generation_source gs
                 WHERE gs.generation_id = ?
                   AND gs.source_local = u.source_local))
              +
              (SELECT COUNT(*) FROM quota_occurrence q
               WHERE NOT EXISTS (
                 SELECT 1 FROM generation_source gs
                 WHERE gs.generation_id = ?
                   AND gs.source_local = q.source_local))
              +
              (SELECT COUNT(*) FROM usage_event u
               WHERE u.source_local IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM source_cursor sc
                 WHERE sc.source_local = u.source_local))
              +
              (SELECT COUNT(*) FROM quota_occurrence q
               WHERE NOT EXISTS (
                 SELECT 1 FROM source_cursor sc
                 WHERE sc.source_local = q.source_local))
            ) AS count`).get(
            descriptor.id,
            descriptor.id,
            descriptor.id,
          )?.count ?? 0);
          if (unattestedSources > 0) {
            coldRebuildReason = "source_attestation_incomplete";
          }
        }
        const generationAuthoritative = (descriptor?.status === "complete"
            || expectedPartial || expectedToolPartial)
          && descriptor.discoveryComplete === true
          && descriptor.diagnosticsComplete === true
          && descriptor.usageProvenanceComplete === true
          && descriptor.sourceOrderComplete === true
          && descriptor.quotaProvenanceComplete === true
          && (descriptor.status !== "complete"
            || descriptor.toolProvenanceComplete === true);
        if (coldRebuildReason === null
            && (rootCoverage?.status === "unavailable"
              || noCompletelyScannedRoots)
            && generationAuthoritative) {
          const totalBoundaryLinks = Number(
            unchangedDatabase.prepare(
              "SELECT COUNT(*) AS count FROM usage_event_boundary",
            ).get()?.count ?? 0,
          );
          return {
            status: "ingested",
            unchanged: true,
            indexFile: resolvedIndexFile,
            generation: descriptor,
            generationDescriptor: descriptor,
            sources: 0,
            sourceBytes: 0,
            skippedSourceCount: descriptor.skippedSourceCount,
            skippedSourceBytes: descriptor.skippedSourceBytes,
            skippedThreadCount: descriptor.skippedThreadCount,
            quarantineReasonCounts: Object.fromEntries(
              Object.entries(descriptor.issueCounts).map(([code, counts]) => (
                [code, counts.threadCount]
              )),
            ),
            sourcesSkipped: 0,
            sourcesTouched: 0,
            sourcesResumed: 0,
            sourcesRescanned: 0,
            sourcesReparsedForParserVersion: 0,
            usageRowsDeletedForReparse: 0,
            sourcesScanned: 0,
            bytesScanned: 0,
            insertedUsageEvents: 0,
            insertedBoundaryLinks: 0,
            totalUsageEvents: descriptor.usageEvents ?? 0,
            totalBoundaryLinks,
            quotaOccurrences: descriptor.quotaOccurrences ?? 0,
            discoveryWallMs: discoveredAt - startedAt,
            scanWallMs: 0,
            wallMs: performance.now() - startedAt,
            peakRssBytes: process.memoryUsage.rss(),
            rootCoverage,
          };
        }
        const sourceSetUnchanged = descriptor?.discoveredSourceCount
            === discovery.discoveredSourceCount
          && descriptor?.discoveredSourceBytes === sourceBytes;
        const sourceClassifications = infos.map((info) => {
          const cursor = cursors.get(
            sourceLocal(
              deviceSalt,
              sourceIdentityForInfo(info),
            ).toString("hex"),
          );
          return {
            cursor,
            classification: classifySource(
              info,
              cursor,
              LOCAL_UNIFIED_INDEX_PARSER_VERSION,
            ),
          };
        });
        const unchanged = coldRebuildReason === null
          && generationAuthoritative
          && sourceSetUnchanged
          && quarantineSetUnchanged
          && sourceClassifications.every(({ classification }) => (
            ["skip", "quarantined"].includes(classification.mode)
          ))
          && sourceClassifications.every(({ cursor }) => (
            cursor?.owner_local !== null && cursor?.owner_local !== undefined
          ));
        if (unchanged) {
          const totalBoundaryLinks = Number(
            unchangedDatabase.prepare(
              "SELECT COUNT(*) AS count FROM usage_event_boundary",
            ).get()?.count ?? 0,
          );
          return {
            status: "ingested",
            unchanged: true,
            indexFile: resolvedIndexFile,
            generation: descriptor,
            generationDescriptor: descriptor,
            sources: discovery.discoveredSourceCount,
            sourceBytes,
            skippedSourceCount: descriptor.skippedSourceCount,
            skippedSourceBytes: descriptor.skippedSourceBytes,
            skippedThreadCount: descriptor.skippedThreadCount,
            quarantineReasonCounts: Object.fromEntries(
              Object.entries(descriptor.issueCounts).map(([code, counts]) => (
                [code, counts.threadCount]
              )),
            ),
            sourcesSkipped: infos.length,
            sourcesTouched: 0,
            sourcesResumed: 0,
            sourcesRescanned: 0,
            sourcesReparsedForParserVersion: 0,
            usageRowsDeletedForReparse: 0,
            sourcesScanned: 0,
            bytesScanned: 0,
            insertedUsageEvents: 0,
            insertedBoundaryLinks: 0,
            totalUsageEvents: descriptor.usageEvents ?? 0,
            totalBoundaryLinks,
            quotaOccurrences: descriptor.quotaOccurrences ?? 0,
            discoveryWallMs: discoveredAt - startedAt,
            scanWallMs: 0,
            wallMs: performance.now() - startedAt,
            peakRssBytes: process.memoryUsage.rss(),
            rootCoverage,
          };
        }
      }
    } catch {
      // The normal staged path handles missing/legacy indexes and any cursor
      // shape mismatch. Preflight is an optimization, never a gate.
    } finally {
      unchangedDatabase?.close();
    }
  }
  if (coldRebuildReason !== null && retainedOwnershipBlocksColdRebuild) {
    // A cold rebuild starts from an empty database. If any persisted physical
    // owner is held, rebuilding would either discard its LKG facts or bind a
    // different replica. Preserve the published file and wait for the owner
    // (or an explicit user reset) instead.
    const error = fixedError("local_unified_index_roots_unavailable");
    error.rootCoverage = rootCoverage;
    throw error;
  }
  if (discoveredInfos.rootCoverage?.status === "unavailable"
      || noCompletelyScannedRoots) {
    throw fixedError("local_unified_index_roots_unavailable");
  }
  if (coldRebuildReason !== null) {
    const parallelBackfillRequested = coldBackfillWorkerCount !== null
      || sourceBytes >= MINIMUM_AUTOMATIC_PARALLEL_BACKFILL_BYTES;
    const workerCount = parallelBackfillRequested
      ? coldBackfillWorkerCount ?? defaultRebuildWorkerCount()
      : 1;
    const rebuilt = await rebuildLocalUnifiedIndex({
      ...(codexHomes === null ? { codexHome } : { codexHomes }),
      indexFile: resolvedIndexFile,
      secretFile: secretFile
        ?? defaultLocalUnifiedIndexSecretPath(resolvedIndexFile),
      startAt,
      endAt,
      contractVersion,
      workerCount,
      commitRows,
      maximumLineBytes,
      attemptToken,
      signal,
      onProgress,
      discoveryLimits,
      windowsProtectedStateStore,
      windowsFilesystemAdapter,
      windowsQualificationModeContext,
      stateRoot,
      resourceRoot,
      windowsSqliteStateSession,
      windowsSqliteStateSessionFactory,
      windowsSqliteStateStaging,
    });
    return {
      ...rebuilt,
      status: "ingested",
      unchanged: false,
      rebuilt: true,
      rebuildReason: coldRebuildReason,
      sourcesSkipped: 0,
      sourcesTouched: 0,
      sourcesResumed: 0,
      sourcesRescanned: rebuilt.sourcesScanned,
      sourcesReparsedForParserVersion: 0,
      usageRowsDeletedForReparse: 0,
      quotaOccurrenceRowsDeletedForRescan: 0,
      insertedUsageEvents: rebuilt.usageEvents,
      insertedBoundaryLinks: rebuilt.boundaryLinks ?? 0,
      totalUsageEvents: rebuilt.usageEvents,
      totalBoundaryLinks: rebuilt.boundaryLinks ?? 0,
    };
  }
  const stageFile = localUnifiedIndexStageFile(
    resolvedIndexFile,
    "incremental",
    attemptToken,
  );
  await removeIfPresent(stageFile, {
    windowsSqliteStateStaging,
    windowsQualificationModeContext,
    windowsFilesystemAdapter,
    stateRoot,
    resourceRoot,
  });
  let database = null;
  let writer = null;
  let generation = null;
  let stageSession = null;
  let diagnosticStage = "stage_prepare";
  try {
    const liveExists = process.platform === "win32"
      ? liveTargetIdentity !== null
      : await assertSafeLocalUnifiedIndexTarget(
        resolvedIndexFile,
        {
          allowMissing: true,
          windowsSqliteStateSession,
          windowsQualificationModeContext,
          windowsFilesystemAdapter,
          stateRoot,
          resourceRoot,
        },
      ) !== null;
    diagnosticStage = "stage_create_or_clone";
    if (process.platform === "win32") {
      const stageName = basename(stageFile.replaceAll("/", "\\"));
      const targetName = basename(resolvedIndexFile.replaceAll("/", "\\"));
      if (liveExists) {
        windowsSqliteStateStaging.clone(targetName, stageName);
      } else {
        windowsSqliteStateStaging.create(stageName);
      }
      if (typeof windowsSqliteStateSessionFactory !== "function") {
        throw fixedError("local_unified_index_windows_state_unqualified");
      }
      diagnosticStage = "session_open";
      stageSession = windowsSqliteStateSessionFactory({
        rootPath: dirname(stageFile.replaceAll("/", "\\")),
        databaseName: stageName,
        readOnly: false,
        create: true,
        windowsQualificationModeContext,
        windowsQualificationResourceRoot: resourceRoot,
      });
    } else if (liveExists) {
      try {
        await copyFile(
          resolvedIndexFile,
          stageFile,
          constants.COPYFILE_FICLONE ?? 0,
        );
      } catch {
        // APFS clone is the cheap path, but not every filesystem supports it.
        // A regular copy preserves the same atomic publication boundary.
        await copyFile(resolvedIndexFile, stageFile);
      }
    }
    diagnosticStage = "database_open_or_write";
    database = openLocalUnifiedIndex(stageFile, {
      readOnly: false,
      create: !liveExists,
      staging: true,
      windowsSqliteStateSession: stageSession,
      windowsQualificationModeContext,
      windowsFilesystemAdapter,
      stateRoot,
      resourceRoot,
    });
    const previousGenerationValue = database.prepare(
      "SELECT value FROM meta WHERE key = 'current_generation_id'",
    ).get()?.value;
    const previousGenerationId = previousGenerationValue === undefined
      ? null
      : Number(previousGenerationValue);
    recoverUnifiedIndexGenerations(database);
    const cursors = loadCursors(database);
    const ownership = selectOwnedRolloutInfos(
      discoveredInfos,
      cursors,
      deviceSalt,
    );
    infos = ownership.infos;
    rootCoverage = coverageWithOwnership(
      discoveredInfos.rootCoverage,
      cursors,
      ownership,
    );
    generation = beginUnifiedIndexGeneration(database, {
      contractVersion,
      discoveredSourceCount: discovery.discoveredSourceCount,
      discoveredSourceBytes: sourceBytes,
    });
    const selectLineageSnapshot = database.prepare(`
      SELECT 1 AS present FROM lineage_snapshot
      WHERE session_local = ? AND snapshot_local = ? LIMIT 1`);
    writer = createUnifiedIndexWriter(database, {
      commitRows,
      contractVersion,
      generationId: generation.generationId,
      parserVersionId: generation.parserVersionId,
      ingestRunId: generation.ingestRunId,
    });
    const accountScopeId = writer.internAccountScope({
      status: "unavailable",
      reason: "missing_account",
      planType: null,
      scopeLocal: null,
    });
    const sink = createEventSink({
      writer,
      deviceSalt,
      accountScopeId,
      generationId: generation.generationId,
      onCounts: null,
    });
    const cooperativeCheckpoint = createLocalUnifiedIndexCooperativeCheckpoint({
      signal,
      flush: () => writer.flush(),
    });
    const countSourceBoundaries = database.prepare(`
      SELECT COUNT(*) AS count
      FROM usage_event_boundary boundary
      JOIN usage_event event
        ON event.event_key = boundary.current_event_key
      WHERE event.source_local = ?`);

    const diagnostics = {
      sources: discovery.discoveredSourceCount,
      skippedSourceCount: discovery.skippedSourceCount,
      skippedSourceBytes: discovery.skippedSourceBytes,
      skippedThreadCount: discovery.skippedThreadCount,
      quarantineReasonCounts: { ...discovery.reasonCounts },
      sourcesSkipped: 0,
      sourcesTouched: 0,
      sourcesResumed: 0,
      sourcesRescanned: 0,
      sourcesReparsedForParserVersion: 0,
      usageRowsDeletedForReparse: 0,
      boundaryRowsDeletedForReparse: 0,
      usageRowsDeletedForSourceRescan: 0,
      boundaryRowsDeletedForSourceRescan: 0,
      quotaOccurrenceRowsDeletedForRescan: 0,
      sourcesScanned: 0,
      bytesScanned: 0,
      relevantLines: 0,
      malformedLines: 0,
      partialLines: 0,
      salvagedRecords: 0,
      compactionEvents: 0,
      oversizedLines: 0,
      forkReplayEventsSkipped: 0,
      unattributedForkReplayEventsSkipped: 0,
      cumulativeCounterRegressions: 0,
      lineageSnapshotLookups: 0,
      peakRetainedSnapshotKeys: 0,
    };
    function observeOutcome(outcome, {
      resuming,
      startOffset,
      retainedSnapshotKeys,
    }) {
      diagnostics[resuming ? "sourcesResumed" : "sourcesRescanned"] += 1;
      diagnostics.sourcesScanned += 1;
      diagnostics.bytesScanned += Math.max(
        0,
        Number(outcome.read.nextOffset ?? 0) - startOffset,
      );
      diagnostics.relevantLines += outcome.diagnostics.relevantLines;
      diagnostics.malformedLines += outcome.diagnostics.malformedLines;
      diagnostics.partialLines += outcome.diagnostics.partialLines;
      diagnostics.salvagedRecords += outcome.diagnostics.salvagedRecords;
      diagnostics.compactionEvents += outcome.diagnostics.compactionEvents;
      diagnostics.oversizedLines += outcome.read.oversizedLines;
      diagnostics.forkReplayEventsSkipped
        += outcome.diagnostics.forkReplayEventsSkipped;
      diagnostics.unattributedForkReplayEventsSkipped
        += outcome.diagnostics.unattributedForkReplayEventsSkipped;
      diagnostics.cumulativeCounterRegressions
        += outcome.diagnostics.cumulativeCounterRegressions;
      diagnostics.peakRetainedSnapshotKeys = Math.max(
        diagnostics.peakRetainedSnapshotKeys,
        retainedSnapshotKeys,
      );
    }

    const bySessionId = new Map();
    for (const info of infos) {
      if (!info.lineage?.sessionId) continue;
      const generations = bySessionId.get(info.lineage.sessionId) ?? [];
      generations.push(info);
      bySessionId.set(info.lineage.sessionId, generations);
    }
    const retainedCursorsBySession = new Map();
    for (const cursor of cursors.values()) {
      if (cursor.session_local === null || cursor.session_local === undefined) continue;
      const sessionHex = Buffer.from(cursor.session_local).toString("hex");
      const retained = retainedCursorsBySession.get(sessionHex);
      if (retained === undefined) retainedCursorsBySession.set(sessionHex, [cursor]);
      else retained.push(cursor);
    }
    function retainedCursorForSession(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length < 1) return undefined;
      const sessionHex = sessionLocal(deviceSalt, sessionId).toString("hex");
      const retained = retainedCursorsBySession.get(sessionHex);
      // A segmented/legacy duplicate is not a safe implicit parent. Seeding
      // from exactly one retained cursor preserves fail-closed lineage.
      return retained?.length === 1 ? retained[0] : undefined;
    }
    const sessionLocals = new Map();
    const localForSession = (sessionId) => {
      let cached = sessionLocals.get(sessionId);
      if (cached === undefined) {
        cached = sessionLocal(deviceSalt, sessionId);
        // The raw session UUID travels in v1.0 contribution records (owner
        // decision). The writer refuses anything that is not UUID-shaped, so
        // a rollout-key fallback id is never recorded.
        writer.recordSessionIdentity(cached, sessionId);
        sessionLocals.set(sessionId, cached);
      }
      return cached;
    };
    // Final carried state for sources scanned in THIS pass, keyed by session
    // id, so a child scanned after its parent seeds from the freshest values.
    const finalBySessionId = new Map();
    const sourceOrdinals = new Map();
    let nextSourceOrdinal = -1;
    for (const cursor of cursors.values()) {
      const ordinal = Number(cursor.source_ordinal);
      if (Number.isSafeInteger(ordinal) && ordinal >= 0) {
        nextSourceOrdinal = Math.max(nextSourceOrdinal, ordinal);
      }
    }
    for (const info of infos) {
      const sourceKey = sourceLocal(
        deviceSalt,
        sourceIdentityForInfo(info),
      ).toString("hex");
      const existing = cursors.get(sourceKey);
      const stored = Number(existing?.source_ordinal);
      if (Number.isSafeInteger(stored) && stored >= 0) {
        sourceOrdinals.set(info, stored);
      } else {
        // Allocate missing ordinals in deterministic discovery order. The
        // ordinal is only a local ordering token; no path is persisted.
        sourceOrdinals.set(info, ++nextSourceOrdinal);
      }
    }
    for (const info of discovery.quarantined
      .toSorted((left, right) => left.rolloutKey.localeCompare(right.rolloutKey))) {
      sourceOrdinals.set(info, ++nextSourceOrdinal);
    }
    const currentSourceKeys = new Set([...infos, ...discovery.quarantined].map((info) => (
      sourceLocal(deviceSalt, sourceIdentityForInfo(info)).toString("hex")
    )));
    const previousRetainedSource = previousGenerationId === null
      ? null
      : database.prepare(`
        SELECT source_ordinal, session_local, surface_id, status,
               discovered_size_bytes, scanned_bytes, mtime_ms,
               diagnostics_complete
        FROM generation_source
        WHERE generation_id = ? AND source_local = ?`);
    const retainedRuntimeQuarantines = [];
    for (const [sourceHex, cursor] of cursors) {
      if (currentSourceKeys.has(sourceHex) || previousRetainedSource === null) {
        continue;
      }
      const sourceKey = Buffer.from(sourceHex, "hex");
      const retained = previousRetainedSource.get(previousGenerationId, sourceKey);
      if (retained === undefined) continue;
      const runtimeQuarantine = typeof cursor.quarantine_code === "string";
      writer.copySourceDiagnostics(sourceKey, previousGenerationId);
      if (cursor.parser_version !== LOCAL_UNIFIED_INDEX_PARSER_VERSION) {
        // This source rotated away before the v8 typed-tool pass could rescan
        // it. Preserve its usage/quota facts, but permanently attest the tool
        // history gap instead of publishing a false zero.
        writer.writeSourceDiagnostics(sourceKey, {
          toolSourceHistoryUnavailable: 1,
        });
      }
      if (!runtimeQuarantine) writer.rebindToolFactsForSource(sourceKey);
      writer.writeGenerationSource({
        sourceLocal: sourceKey,
        sourceOrdinal: Number(retained.source_ordinal),
        sessionLocal: retained.session_local === null
          ? cursor.session_local
          : Buffer.from(retained.session_local),
        surfaceId: Number(retained.surface_id),
        status: runtimeQuarantine ? "failed" : "skipped",
        discoveredSizeBytes: Number(retained.discovered_size_bytes),
        scannedBytes: Number(retained.scanned_bytes),
        mtimeMs: Number(retained.mtime_ms),
        diagnosticsComplete: Number(retained.diagnostics_complete) === 1,
      });
      if (runtimeQuarantine) {
        retainedRuntimeQuarantines.push({ sourceHex, sourceKey, cursor, retained });
      }
    }

    const issueTotals = new Map();
    const issueGroups = new Map();
    const issueThreadCounts = new Map();
    const skippedThreadLocals = new Set();
    for (const info of discovery.quarantined) {
      const sessionId = info.threadId
        ?? info.lineage?.sessionId
        ?? info.rolloutKey;
      const sessionKey = localForSession(sessionId);
      const factSourceKey = sourceLocal(
        deviceSalt,
        sourceIdentityForInfo(info),
      );
      // Discovery diagnostics count physical representations. Keep their
      // failed generation rows distinct even when two filenames claim the same
      // immutable rollout id; rollback below targets the shared fact identity.
      const sourceKey = sourceLocal(
        deviceSalt,
        sourceRepresentationIdentityForInfo(info),
      );
      const surface = surfaceRow(info.lineage?.surfaceClassification);
      // This logical source may have been accepted by the previous generation
      // and become discovery-invalid only now (for example, after a divergent
      // duplicate appeared). Remove its old facts and cursor before attesting
      // the failed source so stale accounting can never survive quarantine.
      const priorCursor = cursors.get(factSourceKey.toString("hex"));
      // Cleanup must trust the identity attested by the prior cursor, not the
      // ID in the newly damaged metadata. Otherwise an in-place identity
      // mismatch can leave the former thread's replay snapshots behind (or
      // delete derived state belonging to the newly claimed thread).
      const priorSessionKey = priorCursor?.session_local === null
          || priorCursor?.session_local === undefined
        ? null
        : Buffer.from(priorCursor.session_local);
      writer.deleteSourceFacts(factSourceKey, priorSessionKey);
      sink.discardSource({ sourceLocal: factSourceKey });
      writer.writeGenerationSource({
        sourceLocal: sourceKey,
        sourceOrdinal: sourceOrdinals.get(info),
        sessionLocal: sessionKey,
        surfaceId: writer.internSurface(surface),
        status: "failed",
        discoveredSizeBytes: Number(info.size ?? 0),
        scannedBytes: 0,
        mtimeMs: Math.floor(Number(info.mtimeMs ?? 0)),
        diagnosticsComplete: true,
      });
      const totals = issueTotals.get(info.quarantineReason) ?? {
        sourceCount: 0,
        sourceBytes: 0,
      };
      totals.sourceCount += 1;
      totals.sourceBytes += Number(info.size ?? 0);
      issueTotals.set(info.quarantineReason, totals);
      const groupKey = `${sessionKey.toString("hex")}\0${info.quarantineReason}`;
      skippedThreadLocals.add(sessionKey.toString("hex"));
      const newGroup = !issueGroups.has(groupKey);
      const group = issueGroups.get(groupKey) ?? {
        groupLocal: sessionKey,
        code: info.quarantineReason,
        sourceCount: 0,
        sourceBytes: 0,
      };
      group.sourceCount += 1;
      group.sourceBytes += Number(info.size ?? 0);
      issueGroups.set(groupKey, group);
      if (newGroup) {
        issueThreadCounts.set(
          info.quarantineReason,
          (issueThreadCounts.get(info.quarantineReason) ?? 0) + 1,
        );
      }
    }
    for (const [code, totals] of issueTotals) {
      writer.writeGenerationIssue(code, {
        ...totals,
        threadCount: issueThreadCounts.get(code) ?? 0,
      });
    }
    for (const group of issueGroups.values()) {
      writer.writeGenerationIssueGroup(group.groupLocal, group.code, group);
    }

    function recordRuntimeIssue(info, code, state) {
      const totals = issueTotals.get(code) ?? { sourceCount: 0, sourceBytes: 0 };
      totals.sourceCount += 1;
      totals.sourceBytes += Number(info.size ?? 0);
      issueTotals.set(code, totals);
      const sessionHex = state.sessionLocal.toString("hex");
      const groupKey = `${sessionHex}\0${code}`;
      const newGroup = !issueGroups.has(groupKey);
      skippedThreadLocals.add(sessionHex);
      const group = issueGroups.get(groupKey) ?? {
        groupLocal: state.sessionLocal,
        code,
        sourceCount: 0,
        sourceBytes: 0,
      };
      group.sourceCount += 1;
      group.sourceBytes += Number(info.size ?? 0);
      issueGroups.set(groupKey, group);
      if (newGroup) {
        issueThreadCounts.set(code, (issueThreadCounts.get(code) ?? 0) + 1);
      }
      writer.writeGenerationIssue(code, {
        ...totals,
        threadCount: issueThreadCounts.get(code) ?? 0,
      });
      writer.writeGenerationIssueGroup(group.groupLocal, code, group);
      diagnostics.skippedSourceCount += 1;
      diagnostics.skippedSourceBytes += Number(info.size ?? 0);
      diagnostics.skippedThreadCount = skippedThreadLocals.size;
      if (newGroup) {
        diagnostics.quarantineReasonCounts[code]
          = (diagnostics.quarantineReasonCounts[code] ?? 0) + 1;
      }
    }

    const invalidRolloutIds = new Set();
    const invalidSessionIds = new Set();
    const invalidSourceLocals = new Set();
    const invalidSessionLocals = new Set();
    function dependencyUnavailable(info) {
      const baseId = info.lineage?.historyBase?.rolloutId ?? null;
      if (baseId !== null && (invalidRolloutIds.has(baseId)
          || invalidSourceLocals.has(
            sourceLocal(deviceSalt, baseId).toString("hex"),
          ))) return true;
      const parentId = info.lineage?.parentId ?? null;
      return info.lineage?.isInlineFork === true
        && parentId !== null
        && (invalidSessionIds.has(parentId)
          || invalidSessionLocals.has(
            localForSession(parentId).toString("hex"),
          ));
    }
    function markUnavailable(info) {
      if (typeof info.rolloutId === "string") {
        invalidRolloutIds.add(info.rolloutId);
        invalidSourceLocals.add(
          sourceLocal(deviceSalt, info.rolloutId).toString("hex"),
        );
      }
      if (typeof info.lineage?.sessionId === "string") {
        invalidSessionIds.add(info.lineage.sessionId);
        invalidSessionLocals.add(
          localForSession(info.lineage.sessionId).toString("hex"),
        );
      }
    }
    for (const retained of retainedRuntimeQuarantines) {
      const sessionKey = retained.cursor.session_local === null
        ? retained.retained.session_local
        : Buffer.from(retained.cursor.session_local);
      if (sessionKey === null) continue;
      const state = { sessionLocal: Buffer.from(sessionKey) };
      recordRuntimeIssue(
        { size: Number(retained.cursor.size_bytes ?? 0) },
        retained.cursor.quarantine_code,
        state,
      );
      invalidSourceLocals.add(retained.sourceHex);
      invalidSessionLocals.add(state.sessionLocal.toString("hex"));
    }

    const deleteUsageForSource = database.prepare(
      "DELETE FROM usage_event WHERE source_local = ?",
    );
    const affectedQuotaForSource = database.prepare(`
      SELECT DISTINCT canonical_observation_id AS id
      FROM quota_occurrence WHERE source_local = ?`);
    const deleteQuotaForSource = database.prepare(
      "DELETE FROM quota_occurrence WHERE source_local = ?",
    );
    const replacementQuota = database.prepare(`
      SELECT plan_type, used_percent, resets_at_ms, duration_mins
      FROM quota_occurrence WHERE canonical_observation_id = ?
      ORDER BY used_percent DESC, COALESCE(resets_at_ms, -1) DESC, id ASC
      LIMIT 1`);
    const updateCanonicalQuota = database.prepare(`
      UPDATE quota_observation SET plan_type = ?, used_percent = ?,
        resets_at_ms = ?, duration_mins = ? WHERE id = ?`);
    const deleteOrphanQuota = database.prepare(`
      DELETE FROM quota_observation WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM quota_occurrence WHERE canonical_observation_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM usage_event WHERE quota_observation_id = ?)`);
    const deleteLineageSnapshots = database.prepare(
      "DELETE FROM lineage_snapshot WHERE session_local = ?",
    );
    const deleteToolCounts = database.prepare(
      "DELETE FROM tool_class_count WHERE session_local = ?",
    );
    const deleteToolFactsForSource = database.prepare(
      "DELETE FROM tool_class_fact WHERE source_local = ?",
    );
    const resetSessions = new Set();

    function replaceSourceFacts(sourceKey, sessionKey, { parserReparse }) {
      const deletedBoundaries = Number(
        countSourceBoundaries.get(sourceKey)?.count ?? 0,
      );
      const affectedQuotaIds = affectedQuotaForSource.all(sourceKey)
        .map((row) => Number(row.id));
      const deletedUsage = Number(
        deleteUsageForSource.run(sourceKey).changes ?? 0,
      );
      diagnostics.quotaOccurrenceRowsDeletedForRescan += Number(
        deleteQuotaForSource.run(sourceKey).changes ?? 0,
      );
      deleteToolFactsForSource.run(sourceKey);
      for (const quotaId of affectedQuotaIds) {
        const replacement = replacementQuota.get(quotaId);
        if (replacement === undefined) {
          deleteOrphanQuota.run(quotaId, quotaId, quotaId);
        } else {
          updateCanonicalQuota.run(
            replacement.plan_type,
            replacement.used_percent,
            replacement.resets_at_ms,
            replacement.duration_mins,
            quotaId,
          );
        }
      }
      if (parserReparse) {
        diagnostics.sourcesReparsedForParserVersion += 1;
        diagnostics.usageRowsDeletedForReparse += deletedUsage;
        diagnostics.boundaryRowsDeletedForReparse += deletedBoundaries;
      } else {
        diagnostics.usageRowsDeletedForSourceRescan += deletedUsage;
        diagnostics.boundaryRowsDeletedForSourceRescan += deletedBoundaries;
      }
      const sessionHex = sessionKey.toString("hex");
      if (!resetSessions.has(sessionHex)) {
        resetSessions.add(sessionHex);
        deleteLineageSnapshots.run(sessionKey);
        deleteToolCounts.run(sessionKey);
      }
    }

    function quarantineSource(info, state, reason, {
      sourceDiagnostics = {},
      copyPreviousDiagnostics = false,
    } = {}) {
      writer.deleteSourceFacts(state.sourceLocal, state.sessionLocal);
      sink.discardSource(state);
      if (reason === "codex_rollout_content_invalid"
          || reason === "codex_rollout_tail_incomplete"
          || reason === "codex_rollout_lineage_invalid") {
        writeCursorForOutcome(writer, deviceSalt, info, state, {
          nextOffset: 0,
          finalModel: null,
          finalEffort: null,
          finalTierRaw: null,
          finalTierObservedAtMs: null,
          finalTotals: null,
          turnContextSeen: false,
          snapshotsPersisted: false,
          quarantineCode: reason,
        });
      }
      if (copyPreviousDiagnostics) {
        writer.copySourceDiagnostics(state.sourceLocal, previousGenerationId);
      } else {
        writer.writeSourceDiagnostics(state.sourceLocal, sourceDiagnostics);
      }
      writer.writeGenerationSource({
        sourceLocal: state.sourceLocal,
        sourceOrdinal: state.sourceOrdinal,
        sessionLocal: state.sessionLocal,
        surfaceId: state.surfaceId,
        status: "failed",
        discoveredSizeBytes: Number(info.size ?? 0),
        scannedBytes: 0,
        mtimeMs: Math.floor(Number(info.mtimeMs ?? 0)),
        diagnosticsComplete: true,
      });
      recordRuntimeIssue(info, reason, state);
      markUnavailable(info);
    }

    const components = lineageComponents(infos);
    const cursorByInfo = new Map();
    const classificationByInfo = new Map();
    const changedQuarantineRolloutIds = new Set();
    const changedQuarantineSessionIds = new Set();
    function markChangedQuarantineDependency(info) {
      if (typeof info.rolloutId === "string") {
        changedQuarantineRolloutIds.add(info.rolloutId);
      }
      if (typeof info.lineage?.sessionId === "string") {
        changedQuarantineSessionIds.add(info.lineage.sessionId);
      }
    }
    for (const info of infos) {
      const cursor = cursors.get(
        sourceLocal(deviceSalt, sourceIdentityForInfo(info)).toString("hex"),
      );
      const classification = classifySource(
        info,
        cursor,
        LOCAL_UNIFIED_INDEX_PARSER_VERSION,
      );
      cursorByInfo.set(info, cursor);
      classificationByInfo.set(info, classification);
      if (typeof cursor?.quarantine_code === "string"
          && classification.mode !== "quarantined") {
        markChangedQuarantineDependency(info);
      }
    }

    // A dependency-derived quarantine is terminal only while its damaged root
    // is unchanged. Re-scan just the unchanged lineage-invalid descendants of
    // a changed quarantined source. Components are parent-first, so one pass
    // propagates repair work through an arbitrarily deep chain. If the root is
    // still damaged, normal dependency gating atomically re-quarantines them.
    for (const component of components) {
      for (const info of component.members) {
        const cursor = cursorByInfo.get(info);
        const classification = classificationByInfo.get(info);
        if (cursor?.quarantine_code !== "codex_rollout_lineage_invalid"
            || classification.mode !== "quarantined") continue;
        const baseId = info.lineage?.historyBase?.rolloutId ?? null;
        const parentId = info.lineage?.parentId ?? null;
        const dependencyChanged = (baseId !== null
            && changedQuarantineRolloutIds.has(baseId))
          || (info.lineage?.isInlineFork === true
            && parentId !== null
            && changedQuarantineSessionIds.has(parentId));
        if (!dependencyChanged) continue;
        classificationByInfo.set(info, {
          mode: "rescan",
          reason: "dependency_quarantine_changed",
        });
        markChangedQuarantineDependency(info);
      }
    }

    const replacementReasons = new Set([
      "parser_version",
      "identity_changed",
      "cursor_invalid",
      "quarantine_changed",
      "dependency_quarantine_changed",
      "same_size_changed",
      "shrink",
    ]);
    const replacementSessionIds = new Set();
    for (const info of infos) {
      const cursor = cursorByInfo.get(info);
      const classification = classificationByInfo.get(info);
      if (cursor !== undefined && replacementReasons.has(classification.reason)) {
        replacementSessionIds.add(
          info.lineage?.sessionId ?? info.rolloutKey,
        );
      }
    }
    for (const sessionId of replacementSessionIds) {
      const sessionKey = localForSession(sessionId);
      resetSessions.add(sessionKey.toString("hex"));
      deleteLineageSnapshots.run(sessionKey);
      deleteToolCounts.run(sessionKey);
    }

    function seedForNew(info) {
      const parentId = info.lineage?.parentId;
      if (!parentId) return { seedModel: null, seedEffort: null };
      const scanned = finalBySessionId.get(parentId);
      if (scanned !== undefined) {
        return { seedModel: scanned.model, seedEffort: scanned.effort };
      }
      const parent = bySessionId.get(parentId)?.at(-1);
      const cursor = parent === undefined
        ? retainedCursorForSession(parentId)
        : cursors.get(
          sourceLocal(
            deviceSalt,
            sourceIdentityForInfo(parent),
          ).toString("hex"),
        );
      if (cursor === undefined) return { seedModel: null, seedEffort: null };
      return {
        seedModel: cursor.carry_model ?? null,
        seedEffort: cursor.carry_effort ?? null,
      };
    }

    // Lineage speed carry-forward (design: composition-aware-expected-line
    // §4). Walk the fork/parent ancestor chain nearest-first and seed the
    // child's initial tier from the first ancestor whose final tier is known —
    // this pass's freshest derived state when the ancestor was scanned here,
    // its persisted cursor otherwise. Strictly lineage-scoped: only the chain
    // named by `lineage.parentId` is ever consulted, never concurrent
    // unrelated threads — Codex `service_tier` is per-thread, and a global
    // "most recent switch anywhere" carry would mislabel the majority of Fast
    // sessions. No reachable declaration anywhere up the chain leaves the
    // seed null and the child's turns unobserved.
    const lineageTierSeeds = new Map();
    function lineageSeedTier(info) {
      const seen = new Set();
      const visited = [];
      let parentId = info.lineage?.parentId ?? null;
      let resolved = null;
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        visited.push(parentId);
        if (lineageTierSeeds.has(parentId)) {
          resolved = lineageTierSeeds.get(parentId);
          break;
        }
        const scanned = finalBySessionId.get(parentId);
        if (scanned !== undefined) {
          // Freshly scanned this pass: its final tier already folds in ITS
          // own seed, so it is the authoritative closure of the ancestor
          // chain. A null proves that chain had no declaration; walking it
          // again for every descendant would become quadratic.
          if (scanned.tier !== null && scanned.tier !== undefined) {
            resolved = inheritedTierSeed(scanned.tier);
          }
          break;
        } else {
          const parent = bySessionId.get(parentId)?.at(-1);
          const cursor = parent === undefined
            ? retainedCursorForSession(parentId)
            : cursors.get(
              sourceLocal(
                deviceSalt,
                sourceIdentityForInfo(parent),
              ).toString("hex"),
            );
          const carried = cursor === undefined ? null : carriedTier(cursor);
          if (carried !== null) {
            resolved = inheritedTierSeed(carried);
            break;
          }
        }
        parentId = bySessionId.get(parentId)?.at(-1)?.lineage?.parentId ?? null;
      }
      for (const sessionId of visited) {
        lineageTierSeeds.set(sessionId, resolved);
      }
      return resolved;
    }

    function ancestorSessionLocalsFor(info) {
      const chain = [];
      const seen = new Set();
      let parentId = info.lineage?.parentId ?? null;
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        const parent = bySessionId.get(parentId);
        if (parent === undefined
            && retainedCursorForSession(parentId) === undefined) break;
        chain.push(localForSession(parentId));
        parentId = parent?.at(-1)?.lineage?.parentId ?? null;
      }
      return chain;
    }
    const historySeeds = createHistoryBaseSeedResolver(infos, {
      maximumLineBytes,
      signal,
    });

    // Group into lineage components exactly as the rebuild does, so a fork is
    // always processed after its ancestors within one pass.
    for (const component of components) {
      const plans = component.members.map((info) => ({
        info,
        cursor: cursorByInfo.get(info),
      })).map((plan) => ({
        ...plan,
        ...classificationByInfo.get(plan.info),
      })).map((plan) => (
        plan.mode === "skip" && plan.cursor?.owner_local === null
          ? { ...plan, mode: "touch", reason: "owner_binding" }
          : plan
      )).map((plan) => (
        replacementSessionIds.has(
          plan.info.lineage?.sessionId ?? plan.info.rolloutKey,
        ) && plan.mode !== "rescan"
          ? { ...plan, mode: "rescan", reason: "session_rescan" }
          : plan
      ));
      const planBySessionId = new Map();
      const plansBySessionId = new Map();
      for (const plan of plans) {
        if (plan.info.lineage?.sessionId) {
          planBySessionId.set(plan.info.lineage.sessionId, plan);
          const sessionPlans = plansBySessionId.get(
            plan.info.lineage.sessionId,
          ) ?? [];
          sessionPlans.push(plan);
          plansBySessionId.set(plan.info.lineage.sessionId, sessionPlans);
        }
      }
      // Fork-boundary durability. A fork about to be scanned checks its
      // ancestors' persisted snapshot sets — but an ancestor scanned before
      // anything forked from it was never asked to collect one. Re-scan such
      // an ancestor once, from the start, so its set becomes durable before
      // the fork reads it. Traverse each fork plan and ancestor session at most
      // once: a repeated whole-component fixpoint becomes quadratic for a deep
      // but otherwise valid fork chain.
      const ancestryQueue = [];
      const queuedAncestryPlans = new Set();
      function enqueueForkAncestry(plan) {
        if (queuedAncestryPlans.has(plan)
            || ["skip", "touch", "quarantined"].includes(plan.mode)
            || plan.info.lineage?.isInlineFork !== true) return;
        queuedAncestryPlans.add(plan);
        ancestryQueue.push(plan);
      }
      function rescanSession(sessionId) {
        for (const plan of plansBySessionId.get(sessionId) ?? []) {
          if (plan.mode !== "rescan") {
            plan.mode = "rescan";
            plan.reason = "session_rescan";
          }
          enqueueForkAncestry(plan);
        }
      }

      // A newly discovered physical rollout is an independent delta even when
      // it shares the stable thread with older generations. Session-wide
      // propagation is required only when snapshot persistence explicitly
      // upgrades one member; parser/replacement invalidations were already
      // expanded through replacementSessionIds.
      const rescanSessions = new Set(plans
        .filter((plan) => plan.mode === "rescan"
          && ["snapshot_persistence", "session_rescan"].includes(plan.reason))
        .map((plan) => plan.info.lineage?.sessionId ?? plan.info.rolloutKey));
      for (const sessionId of rescanSessions) rescanSession(sessionId);
      for (const plan of plans) enqueueForkAncestry(plan);

      const requiredAncestorSessions = new Set();
      for (let index = 0; index < ancestryQueue.length; index += 1) {
        let parentId = ancestryQueue[index].info.lineage?.parentId ?? null;
        while (parentId && !requiredAncestorSessions.has(parentId)) {
          requiredAncestorSessions.add(parentId);
          const ancestor = planBySessionId.get(parentId);
          if (ancestor !== undefined
              && ["skip", "touch", "resume"].includes(ancestor.mode)
              && Number(ancestor.cursor?.snapshots_persisted ?? 0) !== 1) {
            ancestor.mode = "rescan";
            ancestor.reason = "snapshot_persistence";
            rescanSession(parentId);
          }
          parentId = bySessionId.get(parentId)?.at(-1)?.lineage?.parentId
            ?? null;
        }
      }
      const snapshots = createLineageSnapshots(component.members);
      try {
        for (const plan of plans) {
          if (signal?.aborted) throw fixedError("local_unified_index_aborted");
          const {
            info,
            cursor,
            mode,
            reason,
          } = plan;
          const sourceKey = sourceLocal(
            deviceSalt,
            sourceIdentityForInfo(info),
          );
          const sourceOrdinal = sourceOrdinals.get(info);
          const sessionId = info.lineage?.sessionId ?? info.rolloutKey;
          const surface = surfaceRow(info.lineage?.surfaceClassification);
          const surfaceId = writer.internSurface(surface);
          const sessionKey = localForSession(sessionId);
          const previousSource = writer.previousGenerationSource(
            sourceKey,
            previousGenerationId,
          );
          writer.writeGenerationSource({
            sourceLocal: sourceKey,
            sourceOrdinal,
            sessionLocal: sessionKey,
            surfaceId,
            status: "pending",
            discoveredSizeBytes: Number(info.size ?? 0),
            scannedBytes: Number(cursor?.scanned_bytes ?? 0),
            mtimeMs: Math.floor(Number(info.mtimeMs ?? 0)),
            diagnosticsComplete: false,
          });
          const state = {
            sessionLocal: sessionKey,
            sourceLocal: sourceKey,
            sourceId: writer.internSource(sourceKey),
            sourceOrdinal,
            surface,
            surfaceId,
          };
          if (mode === "quarantined") {
            diagnostics.sourcesSkipped += 1;
            quarantineSource(info, state, reason, {
              copyPreviousDiagnostics: true,
            });
            continue;
          }
          if (dependencyUnavailable(info)) {
            quarantineSource(
              info,
              state,
              "codex_rollout_lineage_invalid",
            );
            continue;
          }
          if (mode === "skip") {
            diagnostics.sourcesSkipped += 1;
            writer.rebindToolFactsForSource(sourceKey);
            writer.copySourceDiagnostics(sourceKey, previousGenerationId);
            writer.writeGenerationSource({
              sourceLocal: sourceKey,
              sourceOrdinal,
              sessionLocal: sessionKey,
              surfaceId,
              status: "skipped",
              discoveredSizeBytes: Number(info.size ?? 0),
              scannedBytes: Number(cursor?.scanned_bytes ?? 0),
              mtimeMs: Math.floor(Number(info.mtimeMs ?? 0)),
              diagnosticsComplete: previousSource?.diagnosticsComplete === true,
            });
            continue;
          }
          if (mode === "touch") {
            diagnostics.sourcesTouched += 1;
            writer.rebindToolFactsForSource(sourceKey);
            writeCursorForOutcome(writer, deviceSalt, info, state, {
              nextOffset: Number(cursor.scanned_bytes),
              finalModel: cursor.carry_model ?? null,
              finalEffort: cursor.carry_effort ?? null,
              finalTierRaw: cursor.carry_tier_raw ?? null,
              finalTierObservedAtMs: cursor.carry_tier_observed_at_ms === null
                ? null
                : Number(cursor.carry_tier_observed_at_ms),
              finalTotals: carriedTotals(cursor),
              finalCompactionPending: carriedCompaction(cursor),
              finalTurnContextPending: carriedTurnContextPending(cursor),
              turnContextSeen: Number(cursor.turn_context_seen) === 1,
              snapshotsPersisted: Number(cursor.snapshots_persisted) === 1,
            });
            writer.copySourceDiagnostics(sourceKey, previousGenerationId);
            writer.writeGenerationSource({
              sourceLocal: sourceKey,
              sourceOrdinal,
              sessionLocal: sessionKey,
              surfaceId,
              status: "touched",
              discoveredSizeBytes: Number(info.size ?? 0),
              scannedBytes: Number(cursor.scanned_bytes),
              mtimeMs: Math.floor(Number(info.mtimeMs ?? 0)),
              diagnosticsComplete: previousSource?.diagnosticsComplete === true,
            });
            continue;
          }
          const resuming = mode === "resume";
          if (resuming) {
            // Existing facts from the scanned prefix remain authoritative;
            // bind them to this publication before appending the new tail.
            writer.rebindToolFactsForSource(sourceKey);
          }
          if (!resuming && cursor !== undefined
              && replacementReasons.has(reason)) {
            replaceSourceFacts(sourceKey, sessionKey, {
              parserReparse: reason === "parser_version",
            });
          }
          const logicalSeed = resuming
            ? {
              seedModel: cursor.carry_model ?? null,
              seedEffort: cursor.carry_effort ?? null,
            }
            : seedForNew(info);
          const collector = snapshots.collectorFor(info);
          const historySeed = resuming
            ? null
            : await historySeeds.resolveSeed(info, {
              includeSnapshots: collector !== null,
            });
          const memoryInherited = snapshots.inheritedFor(info);
          const ancestors = info.lineage?.isInlineFork === true
            ? ancestorSessionLocalsFor(info)
            : [];
          const inherited = ancestors.length === 0
            ? memoryInherited
            : {
              has: (key) => {
                if (memoryInherited?.has(key) === true) return true;
                const digest = snapshotLocal(deviceSalt, key);
                diagnostics.lineageSnapshotLookups += 1;
                return ancestors.some((ancestor) => (
                  selectLineageSnapshot.get(ancestor, digest) !== undefined
                ));
              },
            };
          const startOffset = resuming ? Number(cursor.scanned_bytes) : 0;
          if (collector !== null && historySeed !== null
              && snapshots.replaceFor(info, historySeed.seedSnapshots)) {
            writer.clearLineageSnapshots(state.sessionLocal);
            for (const key of historySeed.seedSnapshots) {
              writer.addLineageSnapshot(
                state.sessionLocal,
                snapshotLocal(deviceSalt, key),
              );
            }
          }
          const outcome = await withStableRolloutSource(info, (source) => (
            extractRolloutUsage(source, {
            size: Number(info.size ?? 0),
            startOffset,
            isFork: info.lineage?.isInlineFork === true,
            inheritedSnapshots: info.lineage?.isInlineFork === true
              ? inherited
              : null,
            collectSnapshots: persistingCollector(
              collector,
              writer,
              deviceSalt,
              state.sessionLocal,
            ),
            seedModel: historySeed?.seedModel ?? logicalSeed.seedModel,
            seedEffort: historySeed?.seedEffort ?? logicalSeed.seedEffort,
            // A resumed segment carries its own cursor tier (own-file
            // declarations, still `rollout_thread_settings`). When the cursor
            // carries none — the file never declared, or only ever inherited —
            // the ancestor chain is consulted, exactly as a whole-file rescan
            // would, so provenance survives resume instead of degrading to
            // unobserved.
            seedTier: resuming
              ? carriedTier(cursor) ?? lineageSeedTier(info)
              : historySeed?.seedTier ?? lineageSeedTier(info),
            seedTotals: resuming
              ? carriedTotals(cursor)
              : historySeed?.seedTotals ?? null,
            seedCompactionPending: resuming ? carriedCompaction(cursor) : null,
            seedTurnContextPending: resuming
              && carriedTurnContextPending(cursor),
            seedTurnContextSeen: resuming
              && Number(cursor.turn_context_seen) === 1,
            ...(maximumLineBytes === undefined ? {} : { maximumLineBytes }),
            signal,
            onEvent: (event) => {
              sink.write(state, event);
              return cooperativeCheckpoint();
            },
            onBoundary: (event) => {
              sink.writeBoundary(state, event);
              return cooperativeCheckpoint();
            },
            onTool: (event) => {
              sink.writeTool(state, event);
              return cooperativeCheckpoint();
            },
            })
          ));
          sink.finishSource(state);
          const sourceDiagnostics = {
            ...outcome.diagnostics,
            oversizedLines: outcome.read.oversizedLines,
            ...sink.diagnosticsForSource(state),
          };
          observeOutcome(outcome, {
            resuming,
            startOffset,
            retainedSnapshotKeys: snapshots.retainedKeys,
          });
          const quarantineReason = rolloutContentQuarantineReason(outcome);
          if (quarantineReason !== null) {
            quarantineSource(info, state, quarantineReason, {
              sourceDiagnostics,
            });
            await onProgress?.({
              ...diagnostics,
              usageEvents: sink.counts.usageEvents,
            });
            continue;
          }
          if (info.lineage?.sessionId) {
            finalBySessionId.set(info.lineage.sessionId, {
              model: outcome.finalModel,
              effort: outcome.finalEffort,
              tier: outcome.finalTier,
            });
          }
          writeCursorForOutcome(writer, deviceSalt, info, state, {
            nextOffset: outcome.read.nextOffset,
            finalModel: outcome.finalModel,
            finalEffort: outcome.finalEffort,
            // Only this file's own declarations are carried in the cursor. An
            // inherited seed is re-derived from the ancestor chain on the
            // next pass, so `lineage_inherited` provenance is never laundered
            // into an own observation by a resume.
            finalTierRaw: ownObservedTier(outcome.finalTier)?.providerTierRaw ?? null,
            finalTierObservedAtMs: ownObservedTier(outcome.finalTier)?.observedAtMs ?? null,
            finalTotals: outcome.finalTotals,
            finalCompactionPending: outcome.finalCompactionPending,
            finalTurnContextPending: outcome.finalTurnContextPending,
            turnContextSeen: outcome.finalTurnContextSeen,
            // A whole-file scan makes the collected set durable; a resumed
            // tail keeps whatever durability the earlier scan established.
            snapshotsPersisted: collector !== null
              && (startOffset === 0
                || Number(cursor?.snapshots_persisted ?? 0) === 1),
          });
          writer.writeSourceDiagnostics(state.sourceLocal, sourceDiagnostics);
          writer.writeGenerationSource({
            sourceLocal: state.sourceLocal,
            sourceOrdinal: state.sourceOrdinal,
            sessionLocal: state.sessionLocal,
            surfaceId: state.surfaceId,
            status: resuming ? "resumed" : "rescanned",
            discoveredSizeBytes: Number(info.size ?? 0),
            scannedBytes: outcome.read.nextOffset,
            mtimeMs: Math.floor(Number(info.mtimeMs ?? 0)),
            diagnosticsComplete: true,
          });
          await onProgress?.({
            ...diagnostics,
            usageEvents: sink.counts.usageEvents,
          });
        }
      } finally {
        snapshots.release();
      }
    }

    const scannedAt = performance.now();
    writer.flush();
    const totalUsageEvents = Number(
      database.prepare("SELECT COUNT(*) AS events FROM usage_event").get().events,
    );
    const totalBoundaryLinks = Number(
      database.prepare("SELECT COUNT(*) AS events FROM usage_event_boundary").get().events,
    );
    const indexedSources = database.prepare(`
      SELECT COUNT(*) AS count,
             COALESCE(SUM(discovered_size_bytes), 0) AS bytes
      FROM generation_source
      WHERE generation_id = ? AND status <> 'failed'`).get(
      generation.generationId,
    );
    writer.writeMeta("source_count", discovery.discoveredSourceCount);
    writer.writeMeta("source_bytes", sourceBytes);
    writer.writeMeta("usage_events", totalUsageEvents);
    writer.writeMeta("boundary_links", totalBoundaryLinks);
    writer.writeMeta("generated_at", new Date().toISOString());
    writer.writeMeta("contract_version", contractVersion);
    writer.writeMeta(
      "source_identity_version",
      LOCAL_UNIFIED_INDEX_SOURCE_IDENTITY_VERSION,
    );
    writer.writeMeta("rollout_discovery_fingerprint", discovery.fingerprint);
    writer.writeMeta(
      "rollout_quarantine_fingerprint",
      discovery.quarantineFingerprint,
    );
    if (signal?.aborted) throw fixedError("local_unified_index_aborted");
    const totalSkippedSourceCount = [...issueTotals.values()]
      .reduce((sum, totals) => sum + totals.sourceCount, 0);
    const totalSkippedSourceBytes = [...issueTotals.values()]
      .reduce((sum, totals) => sum + totals.sourceBytes, 0);
    const generationStatus = totalSkippedSourceCount > 0
      ? "partial"
      : "complete";
    writer.writeMeta("status", generationStatus);
    writer.finalizeGeneration({
      status: generationStatus,
      blockReason: generationStatus === "partial"
        ? "codex_rollout_sources_quarantined"
        : null,
      discoveredSourceCount: discovery.discoveredSourceCount,
      discoveredSourceBytes: sourceBytes,
      indexedSourceCount: Number(indexedSources.count),
      indexedSourceBytes: Number(indexedSources.bytes),
      skippedSourceCount: totalSkippedSourceCount,
      skippedSourceBytes: totalSkippedSourceBytes,
      skippedThreadCount: skippedThreadLocals.size,
      discoveryComplete: true,
      diagnosticsComplete: true,
    });
    const generationDescriptor = readUnifiedIndexGenerationDescriptor(
      database,
      generation.generationId,
    );
    diagnosticStage = "close";
    const closed = await writer.close({
      integrityCheck: true,
      fsyncPath: process.platform === "win32" ? null : stageFile,
      windowsSqliteStateStaging,
      windowsQualificationModeContext,
      windowsFilesystemAdapter,
      stateRoot,
      resourceRoot,
    });
    writer = null;
    diagnosticStage = "publish";
    await publishStagedUnifiedIndex(stageFile, resolvedIndexFile, {
      windowsSqliteStateStaging,
      expectedTargetIdentity: liveTargetIdentity,
      windowsQualificationModeContext,
      windowsFilesystemAdapter,
      stateRoot,
      resourceRoot,
    });
    return {
      status: "ingested",
      // A staged pass has scanned and published source state. The unchanged
      // fast path returns true above; every normal staged publication must
      // expose the same explicit boolean contract as a cold rebuild.
      unchanged: false,
      indexFile: resolvedIndexFile,
      generation: generationDescriptor,
      generationDescriptor,
      ...diagnostics,
      ...sink.counts,
      // `usageEvents` above counts write attempts; a resumed pass can re-scan
      // rows it already holds and those land in `ON CONFLICT DO NOTHING`.
      // This is the number of rows this pass actually added.
      insertedUsageEvents: closed.usageRows,
      insertedBoundaryLinks: closed.boundaryRows,
      totalUsageEvents,
      totalBoundaryLinks,
      batches: closed.batches,
      discoveryWallMs: discoveredAt - startedAt,
      scanWallMs: scannedAt - discoveredAt,
      wallMs: performance.now() - startedAt,
      peakRssBytes: process.memoryUsage.rss(),
      rootCoverage,
    };
  } catch (error) {
    const annotatedError = annotateUnifiedIndexFailure(error, diagnosticStage);
    if (writer !== null) {
      try {
        writer.failGeneration(annotatedError?.code === "local_unified_index_aborted"
          ? "aborted"
          : "exception");
      } catch {
        // If the stage is already closed or storage failed, it is discarded.
      }
    }
    if (database?.isOpen) {
      try {
        database.close();
      } catch {
        // The connection may already be closed.
      }
    }
    try {
      await removeIfPresent(stageFile, {
        windowsSqliteStateStaging,
        windowsQualificationModeContext,
        windowsFilesystemAdapter,
        stateRoot,
        resourceRoot,
      });
    } catch (cleanupError) {
      throw annotateUnifiedIndexFailure(cleanupError, "cleanup");
    }
    throw annotatedError;
  }
}
