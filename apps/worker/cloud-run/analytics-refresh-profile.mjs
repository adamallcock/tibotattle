/**
 * analytics-refresh-profile: the refresh Job's opt-in CPU profiler (MEAS-SYNTH
 * production-tier measurement). I/O plumbing: it decides no stored value and
 * is reached only from analytics-refresh.mjs, so it is outside the kernel
 * closure (analytics-kernel-closure.mjs).
 *
 * Enabled by ANALYTICS_V2_REFRESH_PROFILE=cpu. A production target refuses
 * every ANALYTICS_V2_REFRESH_PROFILE* variable
 * (ANALYTICS_V2_REFRESH_PROFILE_FORBIDDEN, analytics-refresh.mjs
 * readAnalyticsRefreshProductionTarget); a staging target and the test targets
 * accept the mode, the sampling interval and the summary period, and only a
 * run outside Cloud Run accepts a local directory for the raw profiles.
 *
 *   ANALYTICS_V2_REFRESH_PROFILE                 "cpu" (the only mode)
 *   ANALYTICS_V2_REFRESH_PROFILE_SAMPLE_US       V8 sampling interval in
 *                                                microseconds (default 10000,
 *                                                1000..100000)
 *   ANALYTICS_V2_REFRESH_PROFILE_SUMMARY_SECONDS summary period (default 1800,
 *                                                10..86400)
 *   ANALYTICS_V2_REFRESH_PROFILE_DIR             local runs only: an absolute
 *                                                directory, outside Cloud Run,
 *                                                for one sanitized .cpuprofile
 *                                                per window
 *
 * The profiler is node:inspector's in-thread Session (Profiler.start), whose
 * protocol calls complete synchronously. Every summary period, at a refresh
 * checkpoint or on the timer, whichever comes first, it stops the profile,
 * folds it into running totals and starts the next window; at exit (success,
 * any refusal or failure, including the time guard's) and on SIGTERM (Cloud
 * Run's task timeout or a cancel) it folds the last window. Each fold writes
 * one content-free JSON line to stderr (ANALYTICS_REFRESH_PROFILE_SCHEMA):
 * the top 40 functions by self and by total time since the start, the top
 * files by self time, the window's top functions, the run phase and owner
 * progress counts, heap and resident set, GC totals by kind, CPU time and
 * event-loop utilisation. The line carries no `status` key, so the deploy
 * wrapper never takes it for the run's status line.
 *
 * Content-free: a function is named "<file>:<function>". The file is a
 * repository-relative module path: the bundle's own module markers (esbuild
 * writes "// <path>" before each module) map a bundle line to the module it
 * came from, any other file path is cut to its repository-relative or
 * node_modules-relative tail, and anything else is "(external)". A function
 * name that is not a plain identifier-like name is "(unnamed)". No absolute
 * path, no argument, no value leaves this module. The raw profile is not
 * uploaded anywhere from Cloud Run (the runtime account's only bucket write
 * is the fast-path origin's telemetry/ namespace, which the origin reads), so
 * the summary lines in Cloud Logging are the cloud record.
 */

import { Session } from "node:inspector";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { getHeapStatistics } from "node:v8";

export const ANALYTICS_REFRESH_PROFILE_SCHEMA = "analytics-refresh-profile-v1";
/** The profiler's environment (names, bounds, defaults). */
export const ANALYTICS_REFRESH_PROFILE_ENV = Object.freeze({
  mode: "ANALYTICS_V2_REFRESH_PROFILE",
  sampleUs: Object.freeze({ name: "ANALYTICS_V2_REFRESH_PROFILE_SAMPLE_US", minimum: 1_000, maximum: 100_000,
    default: 10_000 }),
  summarySeconds: Object.freeze({ name: "ANALYTICS_V2_REFRESH_PROFILE_SUMMARY_SECONDS", minimum: 10,
    maximum: 86_400, default: 1_800 }),
  directory: "ANALYTICS_V2_REFRESH_PROFILE_DIR",
});
/** Every profiler variable name starts with this (a production target refuses the prefix). */
export const ANALYTICS_REFRESH_PROFILE_PREFIX = "ANALYTICS_V2_REFRESH_PROFILE";
/** The profiler variables a staging target accepts (never the local directory). */
export const ANALYTICS_REFRESH_PROFILE_STAGING_ENV = Object.freeze([
  ANALYTICS_REFRESH_PROFILE_ENV.mode, ANALYTICS_REFRESH_PROFILE_ENV.sampleUs.name,
  ANALYTICS_REFRESH_PROFILE_ENV.summarySeconds.name,
]);
export const ANALYTICS_REFRESH_PROFILE_MODES = Object.freeze(["cpu"]);
/** How many entries each ranked list of a summary line holds. */
export const ANALYTICS_REFRESH_PROFILE_TOP = Object.freeze({ functions: 40, files: 20, window: 15 });

const DECIMAL = /^(?:0|[1-9]\d{0,9})$/u;
const FUNCTION_NAME = /^[A-Za-z_$<[][A-Za-z0-9_$.#<> [\]-]{0,119}$/u;
// V8's own pseudo-frames: (root), (program), (idle), (garbage collector).
const PSEUDO_FRAME = /^\([a-z][a-z ]{0,31}\)$/u;
const MODULE_MARKER = /^\/\/ ((?:\.\.\/|\.\/)?[A-Za-z0-9@_.+/-]{1,240}\.(?:m?js|cjs|ts|json))$/u;
const REPOSITORY_ROOTS = Object.freeze(["apps/", "packages/", "src/", "scripts/", "tools/"]);
const MIB = 1_024 * 1_024;

function fail(code, extra = {}) {
  throw Object.assign(new Error(code), { code, ...extra });
}

function boundedValue(env, entry) {
  const text = env?.[entry.name];
  if (text === undefined || text === "") return entry.default;
  if (typeof text !== "string" || !DECIMAL.test(text)) fail("ANALYTICS_V2_REFRESH_PROFILE_INVALID", { field: entry.name });
  const value = Number(text);
  if (value < entry.minimum || value > entry.maximum) {
    fail("ANALYTICS_V2_REFRESH_PROFILE_INVALID", { field: entry.name });
  }
  return value;
}

/**
 * The profiler settings, or null when no profile is requested. Refuses:
 * - ANALYTICS_V2_REFRESH_PROFILE_FORBIDDEN under a production target (any
 *   ANALYTICS_V2_REFRESH_PROFILE* variable; readAnalyticsRefreshProductionTarget
 *   refuses the same first), and a local directory under a staging target or
 *   inside a Cloud Run Job;
 * - ANALYTICS_V2_REFRESH_PROFILE_INVALID for an unknown mode, a value out of
 *   bounds, a directory that is not absolute, or a tuning variable without
 *   the mode.
 */
export function readAnalyticsRefreshProfileSettings(env = {}, { target = null } = {}) {
  const names = Object.keys(env ?? {}).filter((name) => name.startsWith(ANALYTICS_REFRESH_PROFILE_PREFIX));
  if (names.length === 0) return null;
  if (target === "production") fail("ANALYTICS_V2_REFRESH_PROFILE_FORBIDDEN", { field: names.sort()[0] });
  const spec = ANALYTICS_REFRESH_PROFILE_ENV;
  const known = new Set([spec.mode, spec.sampleUs.name, spec.summarySeconds.name, spec.directory]);
  for (const name of names.sort()) {
    if (!known.has(name)) fail("ANALYTICS_V2_REFRESH_PROFILE_INVALID", { field: name });
  }
  const mode = env[spec.mode];
  if (!ANALYTICS_REFRESH_PROFILE_MODES.includes(mode)) fail("ANALYTICS_V2_REFRESH_PROFILE_INVALID", { field: spec.mode });
  const directory = env[spec.directory];
  if (directory !== undefined) {
    if (target === "staging" || (typeof env.CLOUD_RUN_JOB === "string" && env.CLOUD_RUN_JOB.length > 0)) {
      fail("ANALYTICS_V2_REFRESH_PROFILE_FORBIDDEN", { field: spec.directory });
    }
    if (typeof directory !== "string" || !isAbsolute(directory) || directory.length > 1_024) {
      fail("ANALYTICS_V2_REFRESH_PROFILE_INVALID", { field: spec.directory });
    }
  }
  return Object.freeze({
    mode,
    sampleUs: boundedValue(env, spec.sampleUs),
    summaryMs: boundedValue(env, spec.summarySeconds) * 1_000,
    directory: directory ?? null,
  });
}

/**
 * The bundle's module map: [startLine (0-based), repository path] pairs in
 * line order, from esbuild's "// <path>" markers. `bundleDirectory` is the
 * repository directory the marker paths are relative to (the build's working
 * directory, apps/worker/cloud-run).
 */
export function analyticsRefreshBundleModules(text, bundleDirectory = "apps/worker/cloud-run") {
  const modules = [];
  if (typeof text !== "string") return modules;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = MODULE_MARKER.exec(lines[index]);
    if (match === null) continue;
    const path = repositoryPath(posix.normalize(posix.join(bundleDirectory, match[1])));
    modules.push([index, path]);
  }
  return modules;
}

/** A path cut to its node_modules- or repository-relative tail, or "(external)". */
function repositoryPath(path) {
  const modules = path.lastIndexOf("node_modules/");
  if (modules >= 0) return path.slice(modules);
  if (path.startsWith("../") || path.startsWith("/")) {
    for (const root of REPOSITORY_ROOTS) {
      const at = path.lastIndexOf(`/${root}`);
      if (at >= 0) return path.slice(at + 1);
    }
    return "(external)";
  }
  return REPOSITORY_ROOTS.some((root) => path.startsWith(root)) ? path : "(external)";
}

function moduleAt(modules, line) {
  let low = 0;
  let high = modules.length - 1;
  let found = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (modules[middle][0] <= line) {
      found = modules[middle][1];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found ?? "(bundle)";
}

/**
 * A call frame's content-free key "<file>:<function>". `bundles` maps a
 * bundle's file URL to its module map (analyticsRefreshBundleModules).
 */
export function analyticsRefreshFrameKey(callFrame, bundles = new Map()) {
  const rawName = typeof callFrame?.functionName === "string" ? callFrame.functionName : "";
  const url = typeof callFrame?.url === "string" ? callFrame.url : "";
  if (url === "" && PSEUDO_FRAME.test(rawName)) return rawName;
  // V8 names a compiled regular expression "RegExp: <pattern>"; the pattern is not echoed.
  if (url === "" && rawName.startsWith("RegExp: ")) return "(native):(regexp)";
  const name = rawName === "" ? "(anonymous)" : FUNCTION_NAME.test(rawName) ? rawName : "(unnamed)";
  let file;
  if (url === "") file = "(native)";
  else if (url.startsWith("node:")) file = /^node:[a-z0-9_/.-]{1,120}$/u.test(url) ? url : "node:(internal)";
  else if (bundles.has(url)) file = moduleAt(bundles.get(url), Number.isSafeInteger(callFrame.lineNumber)
    ? callFrame.lineNumber : -1);
  else if (url.startsWith("file://")) {
    let path = null;
    try { path = fileURLToPath(url); } catch { path = null; }
    file = path === null ? "(external)" : repositoryPath(path.split("\\").join("/"));
  } else file = "(external)";
  return `${file}:${name}`;
}

/**
 * Fold one V8 CPU profile into `totals` (self and total microseconds per
 * frame key, self per file, samples) and return the window's own self times.
 * A key's total counts each sample once, however often the key recurs on
 * its stack.
 */
export function foldAnalyticsRefreshProfile(profile, totals, bundles = new Map()) {
  const nodes = Array.isArray(profile?.nodes) ? profile.nodes : [];
  const samples = Array.isArray(profile?.samples) ? profile.samples : [];
  const deltas = Array.isArray(profile?.timeDeltas) ? profile.timeDeltas : [];
  const byId = new Map();
  const parent = new Map();
  for (const node of nodes) {
    byId.set(node.id, node);
    for (const child of Array.isArray(node.children) ? node.children : []) parent.set(child, node.id);
  }
  // Each sample lasts until the next one (DevTools' attribution); the last
  // takes the mean interval.
  const selfUs = new Map();
  let windowUs = 0;
  const meanUs = deltas.length > 1 ? deltas.slice(1).reduce((sum, value) => sum + Math.max(0, value), 0)
    / (deltas.length - 1) : 0;
  for (let index = 0; index < samples.length; index += 1) {
    const duration = index + 1 < deltas.length ? Math.max(0, deltas[index + 1]) : meanUs;
    selfUs.set(samples[index], (selfUs.get(samples[index]) ?? 0) + duration);
    windowUs += duration;
  }
  const keyOf = new Map();
  const key = (id) => {
    let value = keyOf.get(id);
    if (value === undefined) {
      value = analyticsRefreshFrameKey(byId.get(id)?.callFrame, bundles);
      keyOf.set(id, value);
    }
    return value;
  };
  const windowSelf = new Map();
  for (const [id, microseconds] of selfUs) {
    const own = key(id);
    windowSelf.set(own, (windowSelf.get(own) ?? 0) + microseconds);
    totals.self.set(own, (totals.self.get(own) ?? 0) + microseconds);
    const file = own.startsWith("(") && !own.includes(":") ? own : own.slice(0, own.lastIndexOf(":"));
    totals.files.set(file, (totals.files.get(file) ?? 0) + microseconds);
    const seen = new Set();
    for (let at = id, guard = 0; at !== undefined && guard < 10_000; at = parent.get(at), guard += 1) {
      const frame = key(at);
      if (frame === "(root)" || seen.has(frame)) continue;
      seen.add(frame);
      totals.total.set(frame, (totals.total.get(frame) ?? 0) + microseconds);
    }
  }
  totals.samples += samples.length;
  totals.profiledUs += windowUs;
  return { windowSelf, samples: samples.length, windowUs };
}

export function createAnalyticsRefreshProfileTotals() {
  return { self: new Map(), total: new Map(), files: new Map(), samples: 0, profiledUs: 0 };
}

function ranked(map, count, profiledUs) {
  return [...map].sort(([leftKey, left], [rightKey, right]) => right - left || (leftKey < rightKey ? -1 : 1))
    .slice(0, count)
    .map(([key, microseconds]) => [key, Math.round(microseconds / 1_000),
      profiledUs > 0 ? Math.round((microseconds / profiledUs) * 1_000) / 10 : 0]);
}

/** Bundle module maps for the dist entries a profile may name (read once). */
async function loadBundleModules(urls) {
  const bundles = new Map();
  for (const url of urls) {
    if (typeof url !== "string" || !url.startsWith("file://")) continue;
    try {
      const text = await readFile(fileURLToPath(url), "utf8");
      const modules = analyticsRefreshBundleModules(text);
      if (modules.length > 0) bundles.set(url, modules);
    } catch { /* an unreadable entry maps by path */ }
  }
  return bundles;
}

/** A profile with every call frame URL replaced by its content-free file (for the local raw output). */
function sanitizedProfile(profile, bundles) {
  return {
    ...profile,
    nodes: profile.nodes.map((node) => {
      const frame = analyticsRefreshFrameKey(node.callFrame, bundles);
      const split = frame.lastIndexOf(":");
      const file = split > 0 && !frame.startsWith("(") ? frame.slice(0, split) : "";
      return { ...node, callFrame: { ...node.callFrame, url: file, functionName: split > 0 ? frame.slice(split + 1)
        : frame } };
    }),
  };
}

/**
 * The profiler. `settings` from readAnalyticsRefreshProfileSettings;
 * `phase()` returns the run's phase (a closed name); `write(line)` emits
 * one summary line. Methods: start(), checkpoint(event), finish(reason).
 * Never throws out of checkpoint() or finish(): a profiler fault ends the
 * profile with a content-free `error` line and leaves the run alone.
 */
export async function createAnalyticsRefreshProfiler({ settings, phase = () => null,
  write = (line) => process.stderr.write(`${line}\n`), wallClock = Date.now, bundleUrls = [],
  createSession = () => new Session() } = {}) {
  if (settings === null || settings === undefined) return null;
  const bundles = await loadBundleModules(bundleUrls);
  const totals = createAnalyticsRefreshProfileTotals();
  const gc = new Map();
  let observer = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const kind = { 1: "minor", 2: "major", 4: "incremental", 8: "weakcb" }[entry.detail?.kind] ?? "other";
        const value = gc.get(kind) ?? { count: 0, ms: 0 };
        value.count += 1;
        value.ms += entry.duration;
        gc.set(kind, value);
      }
    });
    observer.observe({ entryTypes: ["gc"] });
  } catch { observer = null; }
  const startedAtMs = wallClock();
  const eluStart = performance.eventLoopUtilization();
  let eluWindow = eluStart;
  const cpuStart = process.cpuUsage();
  const progress = { ownersPlanned: null, ownersStarted: 0, ownersDone: 0, segments: 0, scalarSteps: 0,
    modelSteps: 0, lastKind: null };
  let session = null;
  let sequence = 0;
  let windowStartedAtMs = startedAtMs;
  let running = false;
  let failed = null;
  let timer = null;
  let peakRssBytes = 0;

  const post = (method, params) => {
    let result;
    let error = null;
    let done = false;
    session.post(method, params ?? {}, (fault, value) => { error = fault; result = value; done = true; });
    if (!done) fail("ANALYTICS_V2_REFRESH_PROFILE_ASYNC");
    if (error) fail("ANALYTICS_V2_REFRESH_PROFILE_PROTOCOL");
    return result;
  };
  const startWindow = () => {
    post("Profiler.start");
    running = true;
    windowStartedAtMs = wallClock();
  };
  const memory = () => {
    const heap = getHeapStatistics();
    const usage = process.memoryUsage();
    peakRssBytes = Math.max(peakRssBytes, usage.rss);
    const mib = (bytes) => Math.round(bytes / MIB);
    return { heapUsedMiB: mib(heap.used_heap_size), heapTotalMiB: mib(heap.total_heap_size),
      heapLimitMiB: mib(heap.heap_size_limit), rssMiB: mib(usage.rss), peakRssMiB: mib(peakRssBytes),
      externalMiB: mib(usage.external), arrayBuffersMiB: mib(usage.arrayBuffers) };
  };
  const emit = (reason, windowSelf, windowSamples, windowStartMs) => {
    const now = wallClock();
    const elu = performance.eventLoopUtilization();
    const cpu = process.cpuUsage(cpuStart);
    const elapsedMs = Math.max(1, now - startedAtMs);
    const gcTotals = { count: 0, ms: 0, byKind: {} };
    for (const [kind, value] of [...gc].sort(([left], [right]) => (left < right ? -1 : 1))) {
      gcTotals.count += value.count;
      gcTotals.ms += value.ms;
      gcTotals.byKind[kind] = { count: value.count, ms: Math.round(value.ms) };
    }
    gcTotals.ms = Math.round(gcTotals.ms);
    const line = {
      profile: ANALYTICS_REFRESH_PROFILE_SCHEMA,
      sequence,
      reason,
      phase: typeof phase() === "string" ? phase() : null,
      elapsedSeconds: Math.round(elapsedMs / 1_000),
      windowSeconds: Math.round(Math.max(0, now - windowStartMs) / 1_000),
      sampleIntervalUs: settings.sampleUs,
      samples: { window: windowSamples, total: totals.samples },
      profiledSeconds: Math.round(totals.profiledUs / 1_000_000),
      progress: { ...progress },
      memory: memory(),
      cpu: { userSeconds: Math.round(cpu.user / 1_000_000), systemSeconds: Math.round(cpu.system / 1_000_000),
        busyCores: Math.round(((cpu.user + cpu.system) / 1_000 / elapsedMs) * 100) / 100 },
      gc: gcTotals,
      eventLoop: {
        utilization: Math.round(performance.eventLoopUtilization(elu, eluWindow).utilization * 1_000) / 1_000,
        utilizationTotal: Math.round(performance.eventLoopUtilization(elu, eluStart).utilization * 1_000) / 1_000,
      },
      top: {
        self: ranked(totals.self, ANALYTICS_REFRESH_PROFILE_TOP.functions, totals.profiledUs),
        total: ranked(totals.total, ANALYTICS_REFRESH_PROFILE_TOP.functions, totals.profiledUs),
        files: ranked(totals.files, ANALYTICS_REFRESH_PROFILE_TOP.files, totals.profiledUs),
        windowSelf: ranked(windowSelf, ANALYTICS_REFRESH_PROFILE_TOP.window,
          [...windowSelf.values()].reduce((sum, value) => sum + value, 0)),
      },
      ...(failed === null ? {} : { error: failed }),
    };
    eluWindow = elu;
    sequence += 1;
    try { write(JSON.stringify(line)); } catch { /* the log is best effort */ }
  };
  const fold = async (reason, restart) => {
    if (!running) return;
    let windowSelf = new Map();
    let windowSamples = 0;
    let raw = null;
    const windowStartMs = windowStartedAtMs;
    try {
      running = false;
      const { profile } = post("Profiler.stop");
      const folded = foldAnalyticsRefreshProfile(profile, totals, bundles);
      windowSelf = folded.windowSelf;
      windowSamples = folded.samples;
      if (settings.directory !== null) raw = sanitizedProfile(profile, bundles);
      if (restart) startWindow();
    } catch (error) {
      failed = typeof error?.code === "string" && /^ANALYTICS_V2_[A-Z0-9_]+$/u.test(error.code) ? error.code
        : "ANALYTICS_V2_REFRESH_PROFILE_FAILED";
      running = false;
    }
    const at = sequence;
    emit(reason, windowSelf, windowSamples, windowStartMs);
    if (raw !== null) {
      try {
        await mkdir(settings.directory, { recursive: true, mode: 0o700 });
        await writeFile(join(settings.directory, `analytics-refresh-${String(at).padStart(3, "0")}.cpuprofile`),
          JSON.stringify(raw), { mode: 0o600 });
      } catch { /* local output is best effort */ }
    }
  };
  const due = () => running && wallClock() - windowStartedAtMs >= settings.summaryMs;
  // A synchronous fold for checkpoints inside long synchronous compute: the
  // local raw file is written asynchronously, after the line.
  const maybeFold = () => {
    if (due()) void fold("interval", true);
  };

  return Object.freeze({
    settings,
    start() {
      session = createSession();
      session.connect();
      post("Profiler.enable");
      post("Profiler.setSamplingInterval", { interval: settings.sampleUs });
      startWindow();
      timer = setInterval(maybeFold, Math.min(settings.summaryMs, 60_000));
      timer.unref?.();
    },
    checkpoint(event) {
      try {
        switch (event?.kind) {
          case "plan":
            progress.ownersPlanned = Array.isArray(event.owners) ? event.owners.length : null;
            break;
          case "owner": progress.ownersStarted += 1; break;
          case "ownerDone": progress.ownersDone += 1; break;
          case "segment": progress.segments += 1; break;
          case "scalar": progress.scalarSteps += 1; break;
          case "model": progress.modelSteps += 1; break;
          default: break;
        }
        if (typeof event?.kind === "string" && /^[a-z][a-zA-Z]{0,31}$/u.test(event.kind)) progress.lastKind = event.kind;
        maybeFold();
      } catch { /* the profile never fails the run */ }
    },
    async finish(reason = "exit") {
      if (timer !== null) clearInterval(timer);
      timer = null;
      try { await fold(reason, false); } catch { /* best effort */ }
      try { if (session !== null) post("Profiler.disable"); } catch { /* best effort */ }
      try { session?.disconnect(); } catch { /* best effort */ }
      session = null;
      try { observer?.disconnect(); } catch { /* best effort */ }
    },
    /** SIGTERM: fold the last window synchronously (the line is written before the process ends). */
    finishNow(reason = "signal") {
      if (timer !== null) clearInterval(timer);
      timer = null;
      // fold() writes its line before its first await.
      void fold(reason, false);
    },
  });
}
