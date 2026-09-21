import { createHash } from "node:crypto";
import { WORK_USAGE_COMPONENTS } from "../reporting/index.js";

const SCHEMA = "local-work-usage-snapshot-v1";
const PERIODS = { "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000, all: null };
const COUNTS = ["events", "incompleteEvents", "unknownEvents", "assumedEvents", "unpricedEvents", "partialPriceEvents"];
const CELL_KEYS = ["id", "kind", "tokens", ...COUNTS, "lastAt", "costUsdExact", "components", "threads", "projects", "worktrees", "models"];
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const count = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => count(value) && value <= 8_640_000_000_000_000;
const nullable = value => value === null || count(value);
const model = value => typeof value === "string" && /^[a-zA-Z0-9._:/-]{1,200}$/u.test(value);
const alias = (value, prefix) => typeof value === "string" && new RegExp(`^${prefix}-[1-9][0-9]{0,5}$`, "u").test(value);
const group = (value, prefix) => value === "unassigned" || prefix === "p" && value === "non-project" || alias(value, prefix);
// Keep the latest report per period/scope, but require its covered instant to
// match whenever the caller requests an exact shared reporting window.
const keyFor = query => hash([query.period, query.scope ?? null]);
const matchesEnd = (query, toMs) => query.endAt === undefined
  || typeof query.endAt === "string" && Date.parse(query.endAt) === toMs
    && new Date(toMs).toISOString() === query.endAt;

function validRecord(value) {
  if (!exact(value, ["key", "period", "fromMs", "toMs", "observedAt", "generation", "pricing", "cells", "threadFamilies"])
      || !digest(value.key) || !Object.hasOwn(PERIODS, value.period)
      || !timestamp(value.toMs) || !timestamp(value.fromMs)
      || value.fromMs !== (PERIODS[value.period] === null ? 0 : Math.max(0, value.toMs - PERIODS[value.period]))
      || !timestamp(value.observedAt) || !digest(value.generation) || !digest(value.pricing)
      || !Array.isArray(value.cells) || value.cells.length > 50_000
      || !value.threadFamilies || typeof value.threadFamilies !== "object" || Array.isArray(value.threadFamilies)
      || Object.keys(value.threadFamilies).length > 25_000) return false;
  const seen = new Set();
  const models = new Set();
  for (const cell of value.cells) {
    if (!exact(cell, CELL_KEYS) || !alias(cell.id, "cell") || seen.has(cell.id) || cell.kind !== "cell"
        || !nullable(cell.tokens) || !COUNTS.every(key => count(cell[key]) && cell[key] <= cell.events)
        || !(cell.lastAt === null || timestamp(cell.lastAt) && cell.lastAt >= value.fromMs && cell.lastAt < value.toMs)
        || !(cell.costUsdExact === null || typeof cell.costUsdExact === "string" && /^\d+(?:\.\d+)?$/u.test(cell.costUsdExact) && cell.costUsdExact.length <= 100)
        || !exact(cell.components, WORK_USAGE_COMPONENTS) || !WORK_USAGE_COMPONENTS.every(key => nullable(cell.components[key]))
        || !Array.isArray(cell.threads) || cell.threads.length !== 1 || !alias(cell.threads[0], "t")
        || !Array.isArray(cell.projects) || cell.projects.length !== 1 || !group(cell.projects[0], "p")
        || !Array.isArray(cell.worktrees) || cell.worktrees.length !== 1 || !group(cell.worktrees[0], "w")
        || !Array.isArray(cell.models) || cell.models.length !== 1 || !model(cell.models[0])) return false;
    seen.add(cell.id);
    models.add(cell.models[0]);
    if (models.size > 1000) return false;
  }
  return Object.entries(value.threadFamilies).every(([thread, family]) => alias(thread, "t") && alias(family, "t"));
}

// A fresh allowlist plus snapshot-local aliases: no original join handles,
// names, UUID lookup, display decorations, or source paths reach durable state.
function project(query, result) {
  if (result?.status !== "available" || result.generation?.status !== "complete"
      || result.metadata?.status !== "available" || !Array.isArray(result.cells)
      || result.cells.length > 50_000 || !matchesEnd(query, result.toMs)) return null;
  const aliases = { threads: new Map(), projects: new Map(), worktrees: new Map() };
  const rename = (kind, value) => {
    if (kind !== "threads" && value === "unassigned" || kind === "projects" && value === "non-project") return value;
    const map = aliases[kind];
    if (!map.has(value)) map.set(value, `${kind[0]}-${map.size + 1}`);
    return map.get(value);
  };
  const record = {
    key: keyFor(query), period: query.period, fromMs: result.fromMs, toMs: result.toMs,
    observedAt: result.metadata.observedAt ?? result.toMs,
    generation: hash(result.generation.fingerprint), pricing: hash(result.pricing?.fingerprint),
    cells: result.cells.map((cell, index) => ({
      id: `cell-${index + 1}`, kind: "cell", tokens: cell.tokens,
      ...Object.fromEntries(COUNTS.map(key => [key, cell[key]])),
      lastAt: cell.lastAt, costUsdExact: cell.costUsdExact,
      components: Object.fromEntries(WORK_USAGE_COMPONENTS.map(key => [key, cell.components?.[key]])),
      threads: cell.threads.map(id => rename("threads", id)),
      projects: cell.projects.map(id => rename("projects", id)),
      worktrees: cell.worktrees.map(id => rename("worktrees", id)), models: [...cell.models],
    })),
    threadFamilies: Object.fromEntries(Object.entries(result.threadFamilies ?? {})
      .map(([id, family]) => [rename("threads", id), rename("threads", family)])),
  };
  return validRecord(record) ? record : null;
}

function restore(record) {
  return {
    status: "available", fromMs: record.fromMs, toMs: record.toMs,
    generation: { fingerprint: record.generation, status: "complete" },
    scope: "saved", scopes: [], metadata: { status: "available", retained: true, observedAt: record.observedAt },
    pricing: { basis: "event_time", fingerprint: record.pricing },
    models: [...new Set(record.cells.flatMap(cell => cell.models))].sort(),
    cells: record.cells, threadFamilies: record.threadFamilies, threadLookup: {},
  };
}

export function createWorkUsageSnapshotStore({ createStore, snapshotFile, codexHome, indexFile }) {
  const source = hash([codexHome, indexFile]);
  const store = createStore({ snapshotFile, schemaVersion: SCHEMA,
    validate: value => exact(value, ["source", "entries"]) && value.source === source
      && Array.isArray(value.entries) && value.entries.length <= 4
      && new Set(value.entries.map(entry => entry.key)).size === value.entries.length
      && value.entries.every(validRecord),
  });
  let entries;
  let writing = null;
  const queued = new Map();
  async function initialize() {
    entries ??= store.read().then(receipt => receipt?.snapshot.entries ?? []);
    return entries;
  }
  return {
    async read(query) {
      const records = await initialize();
      const record = records.find(item => item.key === keyFor(query)
        && item.period === query.period && matchesEnd(query, item.toMs));
      return record ? restore(record) : null;
    },
    write(query, result) {
      let record;
      try { record = project(query, result); } catch { return Promise.resolve(false); }
      if (!record) return Promise.resolve(false);
      // Coalesce by query and cap the pending set. Slow storage must not retain
      // an unbounded queue of private live report objects or old projections.
      queued.delete(record.key);
      queued.set(record.key, record);
      while (queued.size > 4) queued.delete(queued.keys().next().value);
      writing ??= (async () => {
        let saved = false;
        try {
          while (queued.size) {
            const records = await initialize();
            const batch = [...queued.values()];
            queued.clear();
            const keys = new Set(batch.map(item => item.key));
            const next = [...records.filter(item => !keys.has(item.key)), ...batch].slice(-4);
            saved = await store.write({ source, entries: next });
            if (saved) entries = Promise.resolve(next);
          }
          return saved;
        } catch {
          queued.clear();
          return false;
        } finally {
          writing = null;
        }
      })();
      return writing;
    },
  };
}
