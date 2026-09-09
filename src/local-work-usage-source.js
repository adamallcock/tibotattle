import { createHash } from "node:crypto";
import { APP_PRICE_REGISTRY_MANIFEST } from "@app-usagemonitor/accounting";
import { lstat } from "node:fs/promises";
import { setImmediate as yieldTurn } from "node:timers/promises";
import {
  openLocalUnifiedIndex,
  readUnifiedIndexGenerationDescriptor,
  readExistingDeviceSalt,
  defaultLocalUnifiedIndexSecretPath,
  localDigest,
  sourceLocal,
  iterateUnifiedWorkUsageFacts,
} from "./local-unified-index.js";
import { localCodexLogScanner } from "./local-node-runtime.js";
import { extractRolloutWorkContexts } from "./local-unified-index-extract.js";
import { withStableRolloutSource } from "./rollout-source-snapshot.js";
import {
  createWorkUsageProjectResolver,
  readCodexLocalThreadMetadata,
  readCodexLocalThreadAncestry,
} from "./platform/index.js";
import {
  createWorkUsageAccumulator,
  workUsageError,
} from "./reporting/index.js";
import { usageProjection } from "./local-companion-usage-model.js";
import { createAccountingPricer } from "./replay-safe-accounting-cache.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function components(row) {
  return {
    input_uncached_tokens: row.tokens_in_uncached,
    input_cache_read_tokens: row.tokens_in_cache_read,
    input_cache_write_tokens: row.tokens_in_cache_write,
    output_text_tokens: row.tokens_out_text,
    output_reasoning_tokens: row.tokens_out_reasoning,
    output_combined_tokens: row.tokens_out_combined,
  };
}
function atContext(contexts, offset) {
  if (!contexts || !Number.isSafeInteger(offset)) return null;
  let low = 0;
  let high = contexts.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (contexts[mid].offset <= offset) low = mid + 1;
    else high = mid;
  }
  return low ? contexts[low - 1].project : null;
}

const MAX_WORK_CELLS = 50_000;
function scopeKey(row) {
  return `scope-${createHash("sha256")
    .update(
      JSON.stringify([
        row.status,
        row.scope_local ? Buffer.from(row.scope_local).toString("hex") : null,
        row.reason,
        row.plan_type,
      ]),
    )
    .digest("hex")}`;
}

/** Prepare location metadata once; consume already priced canonical facts. */
export async function prepareWorkUsageCollector({
  database,
  generation,
  indexFile,
  codexHome,
  secretFile = null,
  nowMs = Date.now(),
  signal = null,
  intervals = null,
  maximumCells = MAX_WORK_CELLS,
}) {
  if (!generation || !["complete", "partial"].includes(generation.status))
    throw workUsageError("work_usage_unavailable");
  if (
    !Number.isSafeInteger(maximumCells) ||
    maximumCells < 1 ||
    maximumCells > MAX_WORK_CELLS
  )
    throw workUsageError("work_usage_capacity_exceeded");
  const periods = intervals ?? [
    { id: "24h", fromMs: Math.max(0, nowMs - 86_400_000), toMs: nowMs },
    { id: "7d", fromMs: Math.max(0, nowMs - 7 * 86_400_000), toMs: nowMs },
    { id: "30d", fromMs: Math.max(0, nowMs - 30 * 86_400_000), toMs: nowMs },
    { id: "all", fromMs: 0, toMs: nowMs },
  ];
  const fromMs = Math.min(...periods.map((p) => p.fromMs));
  const toMs = Math.max(...periods.map((p) => p.toMs));
  const scopeRows = database
    .prepare(
      `SELECT id, status, scope_local, reason, plan_type FROM account_scope ORDER BY id LIMIT 25001`,
    )
    .all();
  if (scopeRows.length > 25_000)
    throw workUsageError("work_usage_capacity_exceeded");
  const scopeStates = new Map(
    scopeRows.map((row) => [
      row.id,
      {
        id: scopeKey(row),
        status: row.status,
        threadLookup: {},
        threads: {},
        periods: new Map(),
      },
    ]),
  );
  const sources = database
    .prepare(
      `SELECT DISTINCT u.source_local, u.source_ordinal,
    c.scanned_bytes, c.size_bytes, c.quarantine_code, c.source_identity_token, c.source_state_token
    FROM usage_event u LEFT JOIN source_cursor c ON c.source_local=u.source_local
    WHERE observed_at_ms >= ? AND observed_at_ms < ? LIMIT 25001`,
    )
    .all(fromMs, toMs);
  if (sources.length > 25_000)
    throw workUsageError("work_usage_capacity_exceeded");
  const expected = new Map(
    sources
      .filter((s) => s.source_local)
      .map((s) => [Buffer.from(s.source_local).toString("hex"), s]),
  );
  const contexts = new Map();
  const quotaOnlyBySource = new Map();
  const projects = {};
  const worktrees = {};
  let inspectedSources = 0;
  let contextCount = 0;
  let metadataAvailable = true;
  let discoveryFingerprint = null;
  let deviceSalt = null;
  try {
    const salt = await readExistingDeviceSalt(
      secretFile ?? defaultLocalUnifiedIndexSecretPath(indexFile),
    );
    deviceSalt = salt;
    const resolveProject = createWorkUsageProjectResolver({
      digest: (kind, value) =>
        localDigest(salt, `work-usage-${kind}`, value).toString("hex"),
    });
    const infos = await localCodexLogScanner.discoverCodexRolloutInfos({
      codexHome,
      startAt: "1970-01-01T00:00:00.000Z",
      signal,
    });
    discoveryFingerprint =
      localCodexLogScanner.codexRolloutDiscoveryReceipt(infos).fingerprint;
    for (const info of infos) {
      signal?.throwIfAborted();
      const key = sourceLocal(
        salt,
        info.sourceIdentity ?? info.rolloutKey,
      ).toString("hex");
      const source = expected.get(key);
      if (
        !source ||
        source.quarantine_code != null ||
        !Number.isSafeInteger(source.scanned_bytes) ||
        source.scanned_bytes > info.size
      )
        continue;
      const identity = [info.dev, info.ino, info.birthtimeMs]
        .map(Number)
        .join(":");
      const state = [info.mtimeMs, info.ctimeMs].map(Number).join(":");
      if (source.source_identity_token !== identity) continue;
      let indexedInfo = info;
      if (info.compressed === true || info.path.endsWith(".jsonl.zst")) {
        if (source.source_state_token !== state) continue;
      } else {
        const indexedState = source.source_state_token?.split(":").map(Number);
        if (
          !indexedState ||
          indexedState.length !== 2 ||
          !indexedState.every(Number.isFinite) ||
          !Number.isSafeInteger(source.size_bytes) ||
          source.size_bytes < source.scanned_bytes ||
          source.size_bytes > info.size
        )
          continue;
        // Reuse the canonical reader's append-only contract at the indexed
        // physical boundary; read only the already indexed logical prefix.
        // Replacement, truncation and same-size edits still fail closed.
        indexedInfo = {
          ...info,
          size: source.size_bytes,
          mtimeMs: indexedState[0],
          ctimeMs: indexedState[1],
        };
      }
      const segments = [];
      const quotaOnlyOffsets = new Set();
      try {
        await withStableRolloutSource(indexedInfo, async (handle) =>
          extractRolloutWorkContexts(handle, {
            end: source.scanned_bytes,
            signal,
            onQuotaOnly: ({ offset }) => {
              if (++contextCount > 250_000)
                throw workUsageError("work_usage_capacity_exceeded");
              quotaOnlyOffsets.add(offset);
            },
            onContext: async ({ offset, cwd }) => {
              if (++contextCount > 250_000)
                throw workUsageError("work_usage_capacity_exceeded");
              const project = await resolveProject(cwd);
              segments.push({ offset, project });
              if (project) {
                projects[project.project] = {
                  name: project.projectName,
                  method: project.method,
                };
                worktrees[project.worktree] = { name: project.worktreeName };
              }
            },
          }),
        );
        contexts.set(`${key}:${source.source_ordinal}`, segments);
        quotaOnlyBySource.set(
          `${key}:${source.source_ordinal}`,
          quotaOnlyOffsets,
        );
        inspectedSources += 1;
      } catch (error) {
        if (error?.code === "work_usage_capacity_exceeded" || signal?.aborted)
          throw error;
      }
    }
  } catch (error) {
    if (error?.code === "work_usage_capacity_exceeded" || signal?.aborted)
      throw error;
    metadataAvailable = false;
  }

  let threadCount = 0;
  const cellKeys = new Set();
  function add(row, priced) {
    signal?.throwIfAborted();
    const active = periods.filter(
      (p) => row.observed_at_ms >= p.fromMs && row.observed_at_ms < p.toMs,
    );
    if (active.length === 0) return;
    const state = scopeStates.get(row.account_scope_id);
    if (!state) throw workUsageError("work_usage_scope_unavailable");
    const rowComponents = components(row);
    const sourceKey = row.source_local
      ? `${Buffer.from(row.source_local).toString("hex")}:${row.source_ordinal}`
      : null;
    const statusOnly =
      row.quota_observation_id !== null &&
      Object.values(rowComponents).every((value) => value === null) &&
      quotaOnlyBySource.get(sourceKey)?.has(row.source_offset);
    const thread = `t-${state.id.slice(-16)}-${Buffer.from(row.session_local).toString("hex")}`;
    const project = atContext(contexts.get(sourceKey), row.source_offset);
    if (!statusOnly) {
      if (!state.threads[thread] && ++threadCount > 25_000)
        throw workUsageError("work_usage_capacity_exceeded");
      const uuid = UUID.test(row.session_uuid ?? "")
        ? row.session_uuid.toLowerCase()
        : null;
      if (uuid) state.threadLookup[uuid] = thread;
      state.threads[thread] = { uuid };
    }
    for (const period of active) {
      let bucket = state.periods.get(period.id);
      if (!bucket) {
        bucket = {
          accumulator: createWorkUsageAccumulator({ maximumCells }),
          models: new Set(),
          events: 0,
          excludedAllowanceUpdates: 0,
        };
        state.periods.set(period.id, bucket);
      }
      bucket.events += 1;
      if (statusOnly) {
        bucket.excludedAllowanceUpdates += 1;
        continue;
      }
      const key = JSON.stringify([
        state.id,
        period.id,
        thread,
        project?.project,
        project?.worktree,
        row.model_id,
      ]);
      if (!cellKeys.has(key)) {
        if (cellKeys.size >= maximumCells)
          throw workUsageError("work_usage_capacity_exceeded");
        cellKeys.add(key);
      }
      bucket.accumulator.add({
        thread,
        project: project?.project,
        worktree: project?.worktree,
        model: row.model_id,
        at: row.observed_at_ms,
        components: rowComponents,
        partial:
          row.parser_version.includes("partial") ||
          !generation.usageProvenanceComplete,
        price: {
          amount: priced?.apiPriceEquivalentUsdExact ?? null,
          status: priced?.pricingCoverageStatus ?? "unpriced",
        },
      });
      bucket.models.add(row.model_id);
      if (bucket.models.size > 1000)
        throw workUsageError("work_usage_capacity_exceeded");
    }
  }
  async function finish() {
    const ids = [
      ...new Set(
        [...scopeStates.values()].flatMap((state) =>
          Object.values(state.threads)
            .map((t) => t.uuid)
            .filter(Boolean),
        ),
      ),
    ];
    const ancestry = await readCodexLocalThreadAncestry(codexHome, ids);
    for (const state of scopeStates.values()) {
      const { threads, threadLookup, id: selectedScope } = state;
      const threadFamilies = {};
      for (const [id, record] of Object.entries(threads)) {
        const root = ancestry.get(record.uuid);
        if (!root || root === record.uuid) {
          threadFamilies[id] = id;
          continue;
        }
        if (!threadLookup[root] && !deviceSalt) {
          threadFamilies[id] = id;
          continue;
        }
        const family =
          threadLookup[root] ??
          (deviceSalt
            ? `t-${selectedScope.slice(-16)}-family-${localDigest(deviceSalt, "work-family", root).toString("hex")}`
            : id);
        threadFamilies[id] = family;
        if (!threads[family] && ++threadCount > 25_000)
          throw workUsageError("work_usage_capacity_exceeded");
        threads[family] ??= { uuid: root };
        threadLookup[root] ??= family;
        threadFamilies[family] = family;
      }
      for (const length of [8, 12, 16, 36, 100]) {
        const counts = new Map();
        for (const [id, record] of Object.entries(threads)) {
          const suffix = (record.uuid ?? id).slice(-length);
          counts.set(suffix, (counts.get(suffix) ?? 0) + 1);
        }
        for (const [id, record] of Object.entries(threads)) {
          const suffix = (record.uuid ?? id).slice(-length);
          if (!record.shortId && counts.get(suffix) === 1)
            record.shortId = suffix;
        }
      }

      state.threadFamilies = threadFamilies;
    }
    // Separate clones and folders may share a basename. Disambiguate against
    // the whole snapshot so the label remains stable across pages and filters.
    for (const records of [projects, worktrees]) {
      const names = new Map();
      for (const record of Object.values(records))
        names.set(record.name, (names.get(record.name) ?? 0) + 1);
      for (const [id, record] of Object.entries(records))
        if (names.get(record.name) > 1) record.shortId = id.slice(-12);
    }

    const common = {
      pricing: {
        basis: "event_time",
        fingerprint: createHash("sha256")
          .update(JSON.stringify(APP_PRICE_REGISTRY_MANIFEST))
          .digest("hex"),
      },
      metadata: {
        method: "last_observed_location",
        usageClassification: "verified-quota-status-v2",
        resolverVersion: "work-location-v2",
        discoveryFingerprint,
        observationDigest: createHash("sha256")
          .update(
            JSON.stringify(
              [...contexts].map(([key, values]) => [
                key,
                values.map((v) => [
                  v.offset,
                  v.project?.project,
                  v.project?.worktree,
                ]),
              ]),
            ),
          )
          .digest("hex"),
        observedAt: Date.now(),
        status:
          metadataAvailable && inspectedSources === expected.size
            ? "available"
            : "partial",
        inspectedSources,
        indexedSources: expected.size,
        retained: false,
      },
    };
    const output = { status: "available", asOfMs: nowMs, periods: {} };
    for (const period of periods) {
      const states = [...scopeStates.values()].filter((state) =>
        state.periods.has(period.id),
      );
      const scopes = states.map((state) => ({
        id: state.id,
        status: state.status,
        events: state.periods.get(period.id).events,
      }));
      const snapshots = {};
      for (const state of states) {
        const bucket = state.periods.get(period.id);
        const excludedAllowanceUpdates = bucket.excludedAllowanceUpdates;
        snapshots[state.id] = {
          status: "available",
          generation,
          scope: state.id,
          scopes,
          fromMs: period.fromMs,
          toMs: period.toMs,
          cells: bucket.accumulator.finish(),
          models: [...bucket.models].sort(),
          threadLookup: state.threadLookup,
          threadFamilies: state.threadFamilies,
          display: { projects, worktrees, threads: state.threads },
          pricing: common.pricing,
          metadata: { ...common.metadata, excludedAllowanceUpdates },
        };
      }
      // An empty interval still has a selectable, empty snapshot.
      if (states.length === 0)
        snapshots["scope-0"] = {
          status: "available",
          generation,
          scope: "scope-0",
          scopes,
          cells: [],
          models: [],
          threadLookup: {},
          threadFamilies: {},
          display: { projects: {}, worktrees: {}, threads: {} },
          pricing: {
            basis: "event_time",
            fingerprint: createHash("sha256")
              .update(JSON.stringify(APP_PRICE_REGISTRY_MANIFEST))
              .digest("hex"),
          },
          metadata: {
            status: metadataAvailable ? "available" : "partial",
            retained: false,
          },
        };
      output.periods[period.id] = {
        fromMs: period.fromMs,
        toMs: period.toMs,
        scopes,
        snapshots,
      };
    }
    return output;
  }
  return { add, finish };
}

/** Compatibility reader for explicit intervals; production shares the companion pass. */
export async function readLocalWorkUsageSnapshot({
  indexFile,
  codexHome,
  fromMs,
  toMs,
  scope,
  secretFile = null,
  signal = null,
} = {}) {
  if (
    !Number.isSafeInteger(fromMs) ||
    fromMs < 0 ||
    !Number.isSafeInteger(toMs) ||
    toMs < fromMs
  )
    throw workUsageError("local_unified_index_work_query_invalid");
  let database;
  try {
    database = openLocalUnifiedIndex(indexFile, { readOnly: true });
  } catch {
    try {
      await lstat(indexFile);
      return { status: "unavailable" };
    } catch (error) {
      return { status: error.code === "ENOENT" ? "missing" : "unavailable" };
    }
  }
  try {
    database.exec("BEGIN");
    const generation = readUnifiedIndexGenerationDescriptor(database);
    if (!generation || !["complete", "partial"].includes(generation.status))
      return { status: "unavailable" };
    const collector = await prepareWorkUsageCollector({
      database,
      generation,
      indexFile,
      codexHome,
      secretFile,
      signal,
      nowMs: toMs,
      intervals: [{ id: "custom", fromMs, toMs }],
    });
    const pricer = createAccountingPricer();
    let count = 0;
    for (const scopeRow of database
      .prepare("SELECT id FROM account_scope ORDER BY id")
      .all()) {
      for (const row of iterateUnifiedWorkUsageFacts(database, {
        fromMs,
        toMs,
        accountScopeId: scopeRow.id,
      })) {
        signal?.throwIfAborted();
        const priced = usageProjection(
          {
            observedAt: new Date(row.observed_at_ms).toISOString(),
            model: row.model_id,
            components: components(row),
            totalInputContextTokens: row.total_input_context,
            tierSemantics: {
              codexSpeedMode: row.codex_speed_mode,
              apiServiceTier: row.api_service_tier,
            },
          },
          "unknown",
          pricer,
        );
        collector.add(row, priced);
        if (++count % 2000 === 0) await yieldTurn();
      }
    }
    const period = (await collector.finish()).periods.custom;
    const selected =
      scope ??
      period.scopes.find((s) => s.status === "unavailable")?.id ??
      period.scopes[0]?.id ??
      "scope-0";
    if (!period.snapshots[selected])
      throw workUsageError("work_usage_scope_unavailable");
    return period.snapshots[selected];
  } finally {
    database.close();
  }
}

export async function enrichWorkUsageRows({ result, rows, codexHome }) {
  const ids = rows
    .filter((r) => r.kind === "thread")
    .map((r) => result.display.threads[r.id]?.uuid)
    .filter(Boolean);
  const names = await readCodexLocalThreadMetadata(codexHome, ids, {
    allowTitleFallback: true,
  });
  const display = {};
  for (const row of rows) {
    if (row.kind === "thread") {
      const uuid = result.display.threads[row.id]?.uuid;
      display[row.id] = {
        name: names.get(uuid)?.name ?? names.get(uuid)?.nickname ?? null,
        thread: uuid
          ? (names.get(uuid) ?? {
              id: uuid,
              name: null,
              nickname: null,
              parent: null,
            })
          : null,
        shortId: result.display.threads[row.id]?.shortId ?? row.id.slice(-10),
        codexUrl: uuid ? `codex://threads/${uuid}` : null,
      };
    } else
      display[row.id] =
        result.display[row.kind === "project" ? "projects" : "worktrees"][
          row.id
        ] ?? {};
  }
  return display;
}
