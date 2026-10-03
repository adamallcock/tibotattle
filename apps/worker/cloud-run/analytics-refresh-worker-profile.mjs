/** Local synthetic diagnostics only. Persisted caps are reservations, not inspector heap caps. */
import { threadId } from "node:worker_threads";
import { Session } from "node:inspector";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { mkdirSync, lstatSync, realpathSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { analyticsRefreshFrameKey, analyticsRefreshBundleModules } from "./analytics-refresh-profile.mjs";

const PREFIX = "ANALYTICS_V2_LOCAL_WORKER_PROFILE_";
const MIB = 1024 * 1024;
export const WORKER_PROFILE_LIMITS = Object.freeze({ captures: 256, totalBytes: 512 * MIB,
  profileBytes: 2 * MIB - 8192, durationMs: 600_000, sampleUs: 10_000 });
const SUMMARY_KEYS = ["startedAt", "stopRequestedAt", "stoppedAt", "drainedAt", "threadId", "elapsedMs", "durationOvershootMs", "reason", "coverage", "error", "profileBytes", "profileSha256", "gc", "startInspectorMs", "stopAndPersistMs", "identity", "scope"];
const exactKeys = (value, keys) => value !== null && typeof value === "object"
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const fault = (code) => Object.assign(new Error(code), { code });
function privateDirectory(path) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()
      || (info.mode & 0o077) !== 0 || realpathSync(path) !== path) throw fault("WORKER_PROFILE_PATH_INVALID");
}
function save(path, value) {
  privateDirectory(dirname(path));
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data) > (path.endsWith("manifest.json") ? MIB / 2 : 4096)) throw fault("WORKER_PROFILE_METADATA_LIMIT");
  writeFileSync(path, data, { flag: "wx", mode: 0o600 });
}
export function readWorkerProfileSettings(env = {}, { target = null } = {}) {
  const keys = Object.keys(env).filter((key) => key.startsWith(PREFIX));
  if (keys.length === 0) return null;
  if (target !== null || env.CLOUD_RUN_JOB) throw fault("WORKER_PROFILE_FORBIDDEN");
  if (keys.some((key) => ![`${PREFIX}DIR`, `${PREFIX}SOURCE`].includes(key))
      || !isAbsolute(env[`${PREFIX}DIR`] ?? "") || !/^[a-f0-9]{40}$/u.test(env[`${PREFIX}SOURCE`] ?? "")) {
    throw fault("WORKER_PROFILE_SETTINGS_INVALID");
  }
  return { directory: env[`${PREFIX}DIR`], source: env[`${PREFIX}SOURCE`] };
}
export function createWorkerProfileCoordinator(settings, { workerUrl, runId = randomUUID() } = {}) {
  if (settings === null) return null;
  if (!/^[a-f0-9]{40}$/u.test(settings.source) || !/^[a-zA-Z0-9-]{1,64}$/u.test(runId)) throw fault("WORKER_PROFILE_SETTINGS_INVALID");
  privateDirectory(dirname(settings.directory));
  mkdirSync(settings.directory, { mode: 0o700 }); // exact newly owned directory; never reuse/clobber
  privateDirectory(settings.directory);
  const bundleBytes = readFileSync(workerUrl);
  const bundleModules = analyticsRefreshBundleModules(bundleBytes.toString("utf8")).slice(0, 4096);
  const binding = { source: settings.source, sourceBinding: "caller-declared; independently verify checkout and build receipt", workerBundleSha256: createHash("sha256")
    .update(bundleBytes).digest("hex"), runId };
  const entries = [];
  const exits = new Map();
  let skipped = 0;
  let finalized = false;
  save(join(settings.directory, "binding.json"), binding);
  return {
    grant(role, parentId = null, attempt = 0) {
      if (!["owner", "model-block"].includes(role) || !Number.isSafeInteger(attempt) || attempt < 0
          || !(parentId === null || (Number.isSafeInteger(parentId) && parentId >= 0 && parentId < entries.length))) { skipped += 1; return null; }
      if (finalized || entries.length >= WORKER_PROFILE_LIMITS.captures) { skipped += 1; return null; }
      const id = entries.length;
      const directory = join(settings.directory, `isolate-${String(id).padStart(3, "0")}`);
      try { mkdirSync(directory, { mode: 0o700 }); } catch { skipped += 1; return null; }
      const entry = { id, role, parentId, attempt, directory };
      entries.push(entry);
      return { ...entry, binding, bundleUrl: workerUrl.href, bundleModules, ...WORKER_PROFILE_LIMITS };
    },
    exited(id, code) {
      if (Number.isSafeInteger(id) && id >= 0 && id < entries.length && !exits.has(id)) {
        exits.set(id, { terminatedAt: new Date().toISOString(), exitCode: Number.isInteger(code) ? code : null });
      }
    },
    finish({ analyticsRunId = null } = {}) {
      if (analyticsRunId !== null && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(analyticsRunId)) analyticsRunId = null;
      if (finalized) return;
      finalized = true;
      const captures = entries.map(({ directory, ...entry }) => {
        try {
          privateDirectory(directory);
          const summaryPath = join(directory, "summary.json"), info = lstatSync(summaryPath);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096
              || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600) throw fault("WORKER_PROFILE_CAPTURE_INVALID");
          const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
          if (!exactKeys(summary, SUMMARY_KEYS) || !exactKeys(summary.identity, ["id", "role", "parentId", "attempt"])
              || !exactKeys(summary.gc, ["count", "ms"])
              || !["complete", "incomplete"].includes(summary.coverage)
              || !["complete", "duration-limit", "work-failed", "work-exit", "start-failed"].includes(summary.reason)
              || !(summary.error === null || ["WORKER_PROFILE_OUTPUT_LIMIT", "WORKER_PROFILE_CAPTURE_FAILED", "WORKER_PROFILE_START_FAILED"].includes(summary.error))
              || summary.scope !== "isolate CPU samples and GC; no per-isolate process CPU/RSS claim"
              || ![summary.gc.count, summary.gc.ms, summary.elapsedMs, summary.durationOvershootMs, summary.startInspectorMs, summary.stopAndPersistMs]
                .every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
              || ![summary.startedAt, summary.stopRequestedAt, summary.drainedAt]
                .every((value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)))
              || !(summary.stoppedAt === null || (typeof summary.stoppedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(summary.stoppedAt)))
              || !Number.isInteger(summary.threadId) || summary.threadId < 0
              || !Number.isSafeInteger(summary.profileBytes) || summary.profileBytes < 0
              || !(summary.profileSha256 === null || /^[a-f0-9]{64}$/u.test(summary.profileSha256))
              || summary.identity?.id !== entry.id || summary.identity?.role !== entry.role
              || summary.identity?.parentId !== entry.parentId || summary.identity?.attempt !== entry.attempt) {
            throw fault("WORKER_PROFILE_CAPTURE_INVALID");
          }
          if (summary.durationOvershootMs !== Math.max(0, summary.elapsedMs - WORKER_PROFILE_LIMITS.durationMs)
              || (summary.coverage === "complete" && (summary.profileSha256 === null
                || summary.profileBytes < 1 || summary.error !== null || summary.reason !== "complete"
                || summary.elapsedMs > WORKER_PROFILE_LIMITS.durationMs || summary.durationOvershootMs !== 0
                || summary.stoppedAt === null))) throw fault("WORKER_PROFILE_CAPTURE_INVALID");
          if (summary.profileSha256 !== null) {
            const profilePath = join(directory, "capture.cpuprofile"), profileInfo = lstatSync(profilePath);
            if (!profileInfo.isFile() || profileInfo.isSymbolicLink() || profileInfo.nlink !== 1
                || profileInfo.size > WORKER_PROFILE_LIMITS.profileBytes || profileInfo.size !== summary.profileBytes
                || profileInfo.uid !== process.getuid() || (profileInfo.mode & 0o777) !== 0o600
                || createHash("sha256").update(readFileSync(profilePath)).digest("hex") !== summary.profileSha256) {
              throw fault("WORKER_PROFILE_CAPTURE_INVALID");
            }
          }
          return { ...entry, termination: exits.get(entry.id) ?? null, ...summary };
        } catch { return { ...entry, termination: exits.get(entry.id) ?? null, coverage: "incomplete", error: "WORKER_PROFILE_CAPTURE_MISSING_OR_INVALID" }; }
      });
      save(join(settings.directory, "manifest.json"), { binding, analyticsRunId, limits: WORKER_PROFILE_LIMITS, captures, skipped,
        completeCoverage: captures.length > 0 && skipped === 0 && captures.every((entry) => entry.coverage === "complete" && entry.termination !== null),
        limitations: ["local synthetic only", "cooperative duration; inspector allocation not capped",
          "profiled peaks include inspector overhead", "process CPU is not isolate CPU"] });
    },
  };
}
/** Runtime profiler faults never replace the computation's outcome. */
export function startWorkerProfile(config, { createSession = () => new Session(),
  observerFactory = (callback) => new PerformanceObserver(callback), now = () => performance.now() } = {}) {
  if (config === null || config === undefined) return null;
  let session, observer, timer, finished = false, running = false, error = null;
  const started = now();
  const startedAt = new Date().toISOString();
  let startInspectorMs = 0;
  const gc = { count: 0, ms: 0 };
  const collect = (entries) => { for (const entry of entries) { gc.count += 1; gc.ms += entry.duration; } };
  function post(method, parameters = {}) {
    let done = false, value, failure;
    session.post(method, parameters, (err, result) => { done = true; failure = err; value = result; });
    if (!done || failure) throw fault("WORKER_PROFILE_PROTOCOL_FAILED");
    return value;
  }
  const finish = (reason = "complete") => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    const stopped = now();
    const stopRequestedAt = new Date().toISOString();
    let stoppedAt = null;
    let bytes = 0;
    let profileSha256 = null;
    const overheadStarted = now();
    try {
      if (observer) collect(observer.takeRecords());
      observer?.disconnect();
      if (session && running) {
        running = false;
        const { profile } = post("Profiler.stop");
        stoppedAt = new Date().toISOString();
        if (error !== null) throw fault("WORKER_PROFILE_CAPTURE_FAILED");
        const sanitized = { startTime: profile.startTime, endTime: profile.endTime, samples: profile.samples,
          timeDeltas: profile.timeDeltas, nodes: profile.nodes.map((node) => {
          const frame = analyticsRefreshFrameKey(node.callFrame,
            new Map([[config.bundleUrl, config.bundleModules ?? []]]));
          return { id: node.id, hitCount: node.hitCount, children: node.children, callFrame: { functionName: frame, url: "", scriptId: "0", lineNumber: 0, columnNumber: 0 } };
        }) };
        const data = JSON.stringify(sanitized);
        bytes = Buffer.byteLength(data);
        if (bytes > config.profileBytes) throw fault("WORKER_PROFILE_OUTPUT_LIMIT");
        privateDirectory(config.directory);
        writeFileSync(join(config.directory, "capture.cpuprofile"), data, { flag: "wx", mode: 0o600 });
        profileSha256 = createHash("sha256").update(data).digest("hex");
      }
    } catch (failure) { error = failure?.code === "WORKER_PROFILE_OUTPUT_LIMIT"
      ? failure.code : "WORKER_PROFILE_CAPTURE_FAILED"; }
    finally {
      try { if (session) post("Profiler.disable"); } catch {}
      try { session?.disconnect(); } catch {}
      try { observer?.disconnect(); } catch {}
    }
    const elapsedMs = stopped - started;
    try { save(join(config.directory, "summary.json"), { startedAt, stopRequestedAt, stoppedAt, drainedAt: new Date().toISOString(), threadId,
      elapsedMs, durationOvershootMs: Math.max(0, elapsedMs - config.durationMs), reason,
      coverage: error === null && reason === "complete" && elapsedMs <= config.durationMs ? "complete" : "incomplete", error,
      profileBytes: profileSha256 === null ? 0 : bytes, profileSha256, gc, startInspectorMs, stopAndPersistMs: now() - overheadStarted,
      identity: { id: config.id, parentId: config.parentId, role: config.role, attempt: config.attempt },
      scope: "isolate CPU samples and GC; no per-isolate process CPU/RSS claim" }); } catch {}
  };
  try {
    if (!Number.isSafeInteger(config.id) || config.id < 0 || config.id >= 256
        || !["owner", "model-block"].includes(config.role)
        || !(config.parentId === null || (Number.isSafeInteger(config.parentId) && config.parentId >= 0))
        || !Number.isSafeInteger(config.attempt) || config.attempt < 0
        || !Number.isSafeInteger(config.profileBytes) || config.profileBytes < 1 || config.profileBytes > WORKER_PROFILE_LIMITS.profileBytes
        || !Number.isSafeInteger(config.durationMs) || config.durationMs < 1 || config.durationMs > WORKER_PROFILE_LIMITS.durationMs
        || config.sampleUs !== WORKER_PROFILE_LIMITS.sampleUs) throw fault("WORKER_PROFILE_SETTINGS_INVALID");
    privateDirectory(config.directory);
    const initStarted = now();
    session = createSession(); session.connect();
    post("Profiler.enable"); post("Profiler.setSamplingInterval", { interval: config.sampleUs }); post("Profiler.start"); running = true;
    startInspectorMs = now() - initStarted;
    observer = observerFactory((list) => collect(list.getEntries())); observer.observe({ entryTypes: ["gc"] });
    timer = setTimeout(() => finish("duration-limit"), config.durationMs); timer.unref?.();
  } catch { error = "WORKER_PROFILE_START_FAILED"; finish("start-failed"); }
  return { finish };
}
