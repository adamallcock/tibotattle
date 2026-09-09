import { addUsdStrings } from "@app-usagemonitor/accounting";

export const WORK_USAGE_SCHEMA = "local-work-usage-v1";
export const WORK_USAGE_COMPONENTS = Object.freeze([
  "input_uncached_tokens",
  "input_cache_read_tokens",
  "input_cache_write_tokens",
  "output_text_tokens",
  "output_reasoning_tokens",
  "output_combined_tokens",
]);
const known = (n) => Number.isSafeInteger(n) && n >= 0;
export function workUsageError(code) {
  return Object.assign(new Error(code), { code });
}
function add(a, b) {
  const result = a + b;
  if (!known(result)) throw workUsageError("work_usage_overflow");
  return result;
}

/** Shared event-level representation selection; missing and zero stay distinct. */
export function projectRecordedTokenComponents(source = {}) {
  const components = Object.fromEntries(
    WORK_USAGE_COMPONENTS.map((key) => [
      key,
      known(source?.[key]) ? source[key] : null,
    ]),
  );
  const splitKnown =
    known(components.output_text_tokens) &&
    known(components.output_reasoning_tokens);
  const combinedKnown = known(components.output_combined_tokens);
  let outputKnown = splitKnown || combinedKnown;
  let conflict = false;
  if (combinedKnown) {
    if (splitKnown) {
      conflict =
        components.output_combined_tokens !==
        add(components.output_text_tokens, components.output_reasoning_tokens);
      // A contradictory representation cannot establish an authoritative total.
      if (conflict) outputKnown = false;
      components.output_combined_tokens = null;
    } else {
      components.output_text_tokens = null;
      components.output_reasoning_tokens = null;
    }
  }
  const values = Object.values(components).filter(known);
  const totalTokens = values.length ? values.reduce(add, 0) : null;
  const totalComplete =
    WORK_USAGE_COMPONENTS.slice(0, 3).every((key) => known(components[key])) &&
    outputKnown;
  return {
    components,
    totalTokens,
    totalComplete,
    breakdownComplete: splitKnown && !conflict,
    conflict,
  };
}

function empty(id, kind) {
  return {
    id,
    kind,
    tokens: null,
    events: 0,
    incompleteEvents: 0,
    unknownEvents: 0,
    lastAt: null,
    costUsdExact: null,
    unpricedEvents: 0,
    partialPriceEvents: 0,
    components: Object.fromEntries(
      WORK_USAGE_COMPONENTS.map((key) => [key, null]),
    ),
    threads: new Set(),
    projects: new Set(),
    worktrees: new Set(),
    models: new Set(),
  };
}
function merge(target, source) {
  target.events = add(target.events, source.events);
  for (const field of [
    "incompleteEvents",
    "unknownEvents",
    "unpricedEvents",
    "partialPriceEvents",
  ])
    target[field] = add(target[field], source[field]);
  if (source.tokens !== null)
    target.tokens = add(target.tokens ?? 0, source.tokens);
  if (source.costUsdExact !== null)
    target.costUsdExact = addUsdStrings(
      target.costUsdExact ?? "0",
      source.costUsdExact,
    );
  target.lastAt = Math.max(target.lastAt ?? 0, source.lastAt ?? 0);
  for (const key of WORK_USAGE_COMPONENTS)
    if (source.components[key] !== null)
      target.components[key] = add(
        target.components[key] ?? 0,
        source.components[key],
      );
  for (const field of ["threads", "projects", "worktrees", "models"])
    for (const value of source[field]) target[field].add(value);
}
function dto(row, denominator) {
  return {
    ...row,
    threads: undefined,
    projects: [...row.projects],
    worktrees: [...row.worktrees],
    models: [...row.models],
    threadCount: row.threads.size,
    share:
      row.tokens === null || !denominator ? null : row.tokens / denominator,
    priceStatus:
      row.costUsdExact === null
        ? "unpriced"
        : row.unpricedEvents || row.partialPriceEvents || row.incompleteEvents
          ? "partial"
          : "complete",
  };
}

/** Bounded content-free contribution cells. Never re-deduplicate admitted facts. */
export function createWorkUsageAccumulator({ maximumCells = 50_000 } = {}) {
  const cells = new Map();
  return {
    add(event) {
      const {
        thread,
        project = "unassigned",
        worktree = "unassigned",
        model = "unknown",
      } = event;
      if (
        typeof thread !== "string" ||
        !thread.length ||
        thread.length > 200 ||
        !known(event.at)
      )
        throw workUsageError("work_usage_fact_invalid");
      const key = JSON.stringify([thread, project, worktree, model]);
      if (!cells.has(key) && cells.size >= maximumCells)
        throw workUsageError("work_usage_capacity_exceeded");
      const row = cells.get(key) ?? empty(key, "cell");
      const tokens = projectRecordedTokenComponents(event.components);
      const price = event.price ?? {};
      const priced =
        typeof price.amount === "string" &&
        /^\d+(?:\.\d+)?$/u.test(price.amount) &&
        price.amount.length <= 100;
      merge(row, {
        tokens: tokens.totalTokens,
        events: 1,
        incompleteEvents: tokens.totalComplete && !event.partial ? 0 : 1,
        unknownEvents: tokens.totalTokens === null ? 1 : 0,
        lastAt: event.at,
        costUsdExact: priced ? price.amount : null,
        unpricedEvents: priced ? 0 : 1,
        partialPriceEvents: priced && price.status !== "fully_priced" ? 1 : 0,
        components: tokens.components,
        threads: new Set([thread]),
        projects: new Set([project]),
        worktrees: new Set([worktree]),
        models: new Set([model]),
      });
      cells.set(key, row);
    },
    finish() {
      return [...cells.values()].map((cell) => ({
        ...cell,
        threads: [...cell.threads],
        projects: [...cell.projects],
        worktrees: [...cell.worktrees],
        models: [...cell.models],
      }));
    },
  };
}
function compareExact(a, b) {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const scale = Math.max(af.length, bf.length);
  const av = BigInt(ai + af.padEnd(scale, "0"));
  const bv = BigInt(bi + bf.padEnd(scale, "0"));
  return av < bv ? -1 : av > bv ? 1 : 0;
}
export function queryWorkUsageSnapshot(snapshot, query) {
  const rows = new Map();
  const total = empty("total", "total");
  const activeThreads = new Set();
  const activeProjects = new Set();
  // A primary-thread lookup includes its family. An explicit worker lookup
  // remains scoped to that worker rather than silently selecting its siblings.
  const exactWorker = query.thread && snapshot.threadFamilies?.[query.thread] && snapshot.threadFamilies[query.thread] !== query.thread;
  const familyOf = (id) => exactWorker ? id : snapshot.threadFamilies?.[id] ?? id;
  const matches = (cell) => (!query.project || cell.projects.includes(query.project))
    && (!query.worktree || cell.worktrees.includes(query.worktree))
    && (!query.thread || familyOf(cell.threads[0]) === query.thread)
    && (!query.model || cell.models.includes(query.model));
  for (const cell of snapshot.cells) {
    if (!matches(cell)) continue;
    const id =
      query.grouping === "project"
        ? cell.projects[0]
        : query.grouping === "worktree"
          ? cell.worktrees[0]
          : familyOf(cell.threads[0]);
    const row = rows.get(id) ?? empty(id, query.grouping);
    merge(row, cell);
    rows.set(id, row);
    merge(total, cell);
    if (cell.tokens > 0) {
      for (const t of cell.threads) activeThreads.add(familyOf(t));
      for (const p of cell.projects)
        if (p !== "unassigned") activeProjects.add(p);
    }
  }
  if (total.events === 0) total.tokens = 0;
  const ordered = [...rows.values()].sort((a, b) => {
    const field =
      query.sort === "recent"
        ? "lastAt"
        : query.sort === "cost"
          ? "costUsdExact"
          : "tokens";
    if (a[field] === null && b[field] !== null) return 1;
    if (b[field] === null && a[field] !== null) return -1;
    const diff =
      field === "costUsdExact"
        ? compareExact(b[field] ?? "0", a[field] ?? "0")
        : (b[field] ?? 0) - (a[field] ?? 0);
    return diff || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  const page = ordered.slice(query.offset, query.offset + query.pageSize);
  // Only materialize model breakdowns for this page. Reuse the same cells and
  // merge/price rules, so model rows conserve the filtered thread totals.
  const modelsByThread = new Map(query.grouping === "thread" ? page.map(row => [row.id, new Map()]) : []);
  const contributions = new Map([...modelsByThread.keys()].map(id => [id, { primary: empty("primary", "contribution"), subworkers: empty("subworkers", "contribution") }]));
  if (modelsByThread.size) for (const cell of snapshot.cells) {
    const models = modelsByThread.get(familyOf(cell.threads[0]));
    if (!models || !matches(cell)) continue;
    const id = cell.models[0];
    const model = models.get(id) ?? empty(id, "model");
    merge(model, cell);
    models.set(id, model);
    const parts = contributions.get(familyOf(cell.threads[0]));
    merge(cell.threads[0] === familyOf(cell.threads[0]) ? parts.primary : parts.subworkers, cell);
  }
  return {
    totals: {
      ...dto(total, total.tokens),
      activeThreads: activeThreads.size,
      activeProjects: activeProjects.size,
    },
    rowCount: ordered.length,
    rows: page.map(row => {
      const result = dto(row, total.tokens);
      const models = modelsByThread.get(row.id);
      if (models) {
        const parts = contributions.get(row.id);
        result.subworkerCount = parts.subworkers.threads.size;
        result.contributions = [parts.primary, parts.subworkers].filter(part => part.events > 0).map(part => dto(part, row.tokens));
      }
      if (models) result.modelBreakdown = [...models.values()]
        .sort((a,b) => (b.tokens ?? -1) - (a.tokens ?? -1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(model => dto(model, row.tokens));
      return result;
    }),
    nextOffset:
      query.offset + query.pageSize < ordered.length
        ? query.offset + query.pageSize
        : null,
  };
}
