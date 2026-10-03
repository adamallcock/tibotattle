/** Local synthetic diagnostics only. Persisted caps are reservations, not inspector heap caps. */
import { startAllocationProfile, validateAllocationArtifact } from "./analytics-refresh-allocation-profile.mjs";
import { startNumericMemory, validateNumericMemoryReceipt } from "./analytics-refresh-memory-profile.mjs";
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
export const EXTENDED_PROFILE_LIMITS = Object.freeze({ cpuBytes: 1024 * 1024, allocationBytes: 768 * 1024,
  memoryBytes: 64 * 1024, phaseBytes: 8 * 1024, phaseRows: 256, contextIntervalMs: 2500, checkpointMemoryIntervalMs: 20 });
export const PROFILE_WORK_PHASES = Object.freeze({ unknown: 0, modules: 1, read: 2, compute: 3, write: 4,
  prepare: 5, scalar: 6, model: 7, deserialize: 8, serialize: 9, workEnd: 10, captureOverhead: 11,
  captureEnd: 12, cache: 13, community: 14, lock: 15, state: 16, close: 17 });
const SUMMARY_KEYS = ["startedAt", "stopRequestedAt", "stoppedAt", "drainedAt", "threadId", "elapsedMs", "durationOvershootMs", "reason", "coverage", "error", "profileBytes", "profileSha256", "gc", "startInspectorMs", "stopAndPersistMs", "identity", "scope"];
const exactKeys = (value, keys) => value !== null && typeof value === "object"
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const fault = (code) => Object.assign(new Error(code), { code });
function privateDirectory(path) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()
      || (info.mode & 0o077) !== 0 || realpathSync(path) !== path) throw fault("WORKER_PROFILE_PATH_INVALID");
}
function save(path, value, limit = path.endsWith("manifest.json") ? MIB / 2 : 4096) {
  privateDirectory(dirname(path));
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data) > limit) throw fault("WORKER_PROFILE_METADATA_LIMIT");
  writeFileSync(path, data, { flag: "wx", mode: 0o600 });
}
function persistCaptureArtifact(directory, filename, value, limit) {
  privateDirectory(directory);
  const data = JSON.stringify(value);
  const bytes = Buffer.byteLength(data);
  if (bytes > limit) throw fault("WORKER_PROFILE_OUTPUT_LIMIT");
  writeFileSync(join(directory, filename), data, { flag: "wx", mode: 0o600 });
  return { bytes, sha256: createHash("sha256").update(data).digest("hex"), error: null };
}
function validateCaptureExtension(value, entry, directory, summary) {
  if (!exactKeys(value, ["allocationRequested", "memoryRequested", "allocation", "memory", "phases", "allocationStartInspectorMs", "allocationStopAndSanitizeMs"])
      || ![value.allocationStartInspectorMs, value.allocationStopAndSanitizeMs].every((number) => typeof number === "number" && Number.isFinite(number) && number >= 0)
      || value.allocationRequested !== entry.modes.allocation || value.memoryRequested !== entry.modes.memory) throw fault("WORKER_PROFILE_CAPTURE_INVALID");
  const validateFile = (descriptor, filename, limit, validate) => {
    if (!exactKeys(descriptor, ["bytes", "sha256", "error"])
        || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0 || descriptor.bytes > limit
        || !(descriptor.error === null || ["ALLOCATION_PROFILE_CAPTURE_FAILED", "MEMORY_PROFILE_CAPTURE_FAILED", "PHASE_PROFILE_TRUNCATED", "PHASE_PROFILE_CAPTURE_FAILED"].includes(descriptor.error))) throw fault("WORKER_PROFILE_CAPTURE_INVALID");
    if (descriptor.sha256 === null) {
      if (descriptor.bytes !== 0 || descriptor.error === null) throw fault("WORKER_PROFILE_CAPTURE_INVALID");
      return;
    }
    if (!/^[a-f0-9]{64}$/u.test(descriptor.sha256) || descriptor.bytes < 1) throw fault("WORKER_PROFILE_CAPTURE_INVALID");
    const path = join(directory, filename), info = lstatSync(path), data = readFileSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid()
        || (info.mode & 0o777) !== 0o600 || info.size !== descriptor.bytes
        || createHash("sha256").update(data).digest("hex") !== descriptor.sha256) throw fault("WORKER_PROFILE_CAPTURE_INVALID");
    validate(JSON.parse(data.toString("utf8")));
  };
  if (value.allocationRequested) validateFile(value.allocation, "allocation.json", EXTENDED_PROFILE_LIMITS.allocationBytes, validateAllocationArtifact);
  else if (value.allocation !== null) throw fault("WORKER_PROFILE_CAPTURE_INVALID");
  if (value.memoryRequested) validateFile(value.memory, "memory.json", EXTENDED_PROFILE_LIMITS.memoryBytes, (receipt) => {
    validateNumericMemoryReceipt(receipt);
    if ((receipt.sampling.errors > 0 && value.memory.error === null) || receipt.isolateId !== entry.id || receipt.role !== (entry.role === "main" ? "main" : "worker")) throw fault("WORKER_PROFILE_CAPTURE_INVALID");
  });
  else if (value.memory !== null) throw fault("WORKER_PROFILE_CAPTURE_INVALID");
  validateFile(value.phases, "phases.json", EXTENDED_PROFILE_LIMITS.phaseBytes, (receipt) => {
    if (!exactKeys(receipt, ["schemaVersion", "phaseIdsAreWorkContext", "memoryReasonIdsAreSeparate", "phases", "truncated", "contextIntervalMs", "checkpointMemoryIntervalMs", "coalescedChanges", "completeTemporalCoverage", "contextIsNotExclusiveDuration", "epochRollbackCount", "wallClockRollbacksClamped", "cadenceClock"])
        || receipt.schemaVersion !== "local-work-phases-v1" || receipt.phaseIdsAreWorkContext !== true
        || receipt.cadenceClock !== "monotonic"
        || receipt.contextIntervalMs !== EXTENDED_PROFILE_LIMITS.contextIntervalMs
        || receipt.checkpointMemoryIntervalMs !== EXTENDED_PROFILE_LIMITS.checkpointMemoryIntervalMs
        || !Number.isSafeInteger(receipt.coalescedChanges) || receipt.coalescedChanges < 0
        || !Number.isSafeInteger(receipt.epochRollbackCount) || receipt.epochRollbackCount < 0 || receipt.wallClockRollbacksClamped !== true
        || receipt.completeTemporalCoverage !== false || receipt.contextIsNotExclusiveDuration !== true
        || receipt.memoryReasonIdsAreSeparate !== true || typeof receipt.truncated !== "boolean"
        || !Array.isArray(receipt.phases) || receipt.phases.length > EXTENDED_PROFILE_LIMITS.phaseRows) throw fault("WORKER_PROFILE_CAPTURE_INVALID");
    let previous = 0;
    for (const row of receipt.phases) {
      if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0]) || row[0] < previous
          || !Number.isInteger(row[1]) || row[1] < 0 || row[1] > 17) throw fault("WORKER_PROFILE_CAPTURE_INVALID");
      previous = row[0];
    }
    if (summary.coverage === "complete") {
      const workEnd = receipt.phases.findLastIndex((row) => row[1] === PROFILE_WORK_PHASES.workEnd);
      const overhead = receipt.phases.findLastIndex((row) => row[1] === PROFILE_WORK_PHASES.captureOverhead);
      const end = receipt.phases.findLastIndex((row) => row[1] === PROFILE_WORK_PHASES.captureEnd);
      if (workEnd < 0 || overhead <= workEnd || end <= overhead) throw fault("WORKER_PROFILE_CAPTURE_INVALID");
    }
    if (receipt.truncated && value.phases.error === null) throw fault("WORKER_PROFILE_CAPTURE_INVALID");
  });
  return [value.allocation, value.memory, value.phases].every((descriptor) => descriptor === null || descriptor.error === null);
}
export function readWorkerProfileSettings(env = {}, { target = null } = {}) {
  const keys = Object.keys(env).filter((key) => key.startsWith(PREFIX));
  if (keys.length === 0) return null;
  if (target !== null || env.CLOUD_RUN_JOB) throw fault("WORKER_PROFILE_FORBIDDEN");
  if (keys.some((key) => ![`${PREFIX}DIR`, `${PREFIX}SOURCE`, `${PREFIX}ALLOCATION`, `${PREFIX}MEMORY`].includes(key))
      || !isAbsolute(env[`${PREFIX}DIR`] ?? "") || !/^[a-f0-9]{40}$/u.test(env[`${PREFIX}SOURCE`] ?? "")) {
    throw fault("WORKER_PROFILE_SETTINGS_INVALID");
  }
  if ([`${PREFIX}ALLOCATION`, `${PREFIX}MEMORY`].some((key) => Object.hasOwn(env, key) && env[key] !== "1")) throw fault("WORKER_PROFILE_SETTINGS_INVALID");
  return { ...(env[`${PREFIX}ALLOCATION`] === "1" ? { allocation: true } : {}),
    ...(env[`${PREFIX}MEMORY`] === "1" ? { memory: true } : {}), directory: env[`${PREFIX}DIR`], source: env[`${PREFIX}SOURCE`] };
}
export function createWorkerProfileCoordinator(settings, { workerUrl, mainUrl = null, runId = randomUUID() } = {}) {
  if (settings === null) return null;
  if (!/^[a-f0-9]{40}$/u.test(settings.source) || !/^[a-zA-Z0-9-]{1,64}$/u.test(runId)) throw fault("WORKER_PROFILE_SETTINGS_INVALID");
  privateDirectory(dirname(settings.directory));
  mkdirSync(settings.directory, { mode: 0o700 }); // exact newly owned directory; never reuse/clobber
  privateDirectory(settings.directory);
  const bundleBytes = readFileSync(workerUrl);
  const bundleModules = analyticsRefreshBundleModules(bundleBytes.toString("utf8")).slice(0, 4096);
  const binding = { source: settings.source, sourceBinding: "caller-declared; independently verify checkout and build receipt", workerBundleSha256: createHash("sha256")
    .update(bundleBytes).digest("hex"), runId };
  const modes = { allocation: settings.allocation === true, memory: settings.memory === true };
  const extended = modes.allocation || modes.memory;
  let mainModules = [], mainBytes = null;
  if (extended && mainUrl !== null) {
    mainBytes = readFileSync(mainUrl);
    binding.mainBundleSha256 = createHash("sha256").update(mainBytes).digest("hex");
    mainModules = analyticsRefreshBundleModules(mainBytes.toString("utf8")).slice(0, 4096);
  }
  if (extended) binding.modes = { cpu: true, ...modes };
  const entries = [];
  const exits = new Map();
  let skipped = 0;
  let finalized = false;
  save(join(settings.directory, "binding.json"), binding);
  return {
    grant(role, parentId = null, attempt = 0) {
      if (!(["owner", "model-block"].includes(role) || (extended && role === "main" && mainUrl !== null)) || !Number.isSafeInteger(attempt) || attempt < 0
          || !(parentId === null || (Number.isSafeInteger(parentId) && parentId >= 0 && parentId < entries.length))) { skipped += 1; return null; }
      if (finalized || entries.length >= WORKER_PROFILE_LIMITS.captures) { skipped += 1; return null; }
      const id = entries.length;
      const directory = join(settings.directory, `isolate-${String(id).padStart(3, "0")}`);
      try { mkdirSync(directory, { mode: 0o700 }); } catch { skipped += 1; return null; }
      const entry = { id, role, parentId, attempt, directory, ...(extended ? { modes } : {}) };
      entries.push(entry);
      return { ...entry, binding, bundleUrl: role === "main" ? mainUrl.href : workerUrl.href,
        bundleModules: role === "main" ? mainModules : bundleModules, ...WORKER_PROFILE_LIMITS,
        ...(extended ? { profileBytes: EXTENDED_PROFILE_LIMITS.cpuBytes } : {}) };
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
          if (!exactKeys(summary, entry.modes ? [...SUMMARY_KEYS, "extension"] : SUMMARY_KEYS) || !exactKeys(summary.identity, ["id", "role", "parentId", "attempt"])
              || !exactKeys(summary.gc, ["count", "ms"])
              || !["complete", "incomplete"].includes(summary.coverage)
              || !["complete", "duration-limit", "work-failed", "work-exit", "start-failed"].includes(summary.reason)
              || !(summary.error === null || ["WORKER_PROFILE_OUTPUT_LIMIT", "WORKER_PROFILE_CAPTURE_FAILED", "WORKER_PROFILE_START_FAILED", "WORKER_PROFILE_EXTENSION_FAILED"].includes(summary.error))
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
                || profileInfo.size > (entry.modes ? EXTENDED_PROFILE_LIMITS.cpuBytes : WORKER_PROFILE_LIMITS.profileBytes) || profileInfo.size !== summary.profileBytes
                || profileInfo.uid !== process.getuid() || (profileInfo.mode & 0o777) !== 0o600
                || createHash("sha256").update(readFileSync(profilePath)).digest("hex") !== summary.profileSha256) {
              throw fault("WORKER_PROFILE_CAPTURE_INVALID");
            }
          }
          if (entry.modes && !validateCaptureExtension(summary.extension, entry, directory, summary) && summary.coverage === "complete") throw fault("WORKER_PROFILE_CAPTURE_INVALID");
          return { ...entry, termination: exits.get(entry.id) ?? null, ...summary };
        } catch { return { ...entry, termination: exits.get(entry.id) ?? null, coverage: "incomplete", error: "WORKER_PROFILE_CAPTURE_MISSING_OR_INVALID" }; }
      });
      save(join(settings.directory, "manifest.json"), { binding, analyticsRunId, limits: WORKER_PROFILE_LIMITS, captures, skipped,
        completeCoverage: captures.length > 0 && skipped === 0 && captures.every((entry) => entry.coverage === "complete" && (entry.role === "main" || entry.termination !== null)),
        limitations: ["local synthetic only", "cooperative duration; inspector allocation not capped",
          "profiled peaks include inspector overhead", "process CPU is not isolate CPU",
          ...(extended ? ["sampled allocation weights are not retained heap", "memory sampling can miss synchronous highs",
            "work-phase context is separate from sampling reason", "independent peak values must not be summed"] : [])] },
        extended ? MIB - 4096 : MIB / 2);
    },
  };
}
/** Runtime profiler faults never replace the computation's outcome. */
export function startWorkerProfile(config, { createSession = () => new Session(),
  observerFactory = (callback) => new PerformanceObserver(callback), now = () => performance.now(),
  epochNow = () => Date.now(), memoryFactory = startNumericMemory } = {}) {
  if (config === null || config === undefined) return null;
  const extended = config.modes !== undefined;
  let allocation = null, numericMemory = null;
  const phases = []; let phaseTruncated = false, coalescedChanges = 0;
  const seenContexts = new Set();
  let lastContext = null, lastContextAt = -Infinity, lastMemoryAt = -Infinity, lastEpoch = 0, epochRollbackCount = 0;
  const phase = (id) => {
    if (!extended || finished || !Number.isInteger(id) || id < 0 || id > 17) return;
    const cadenceMs = now();
    const observedEpoch = epochNow();
    if (observedEpoch < lastEpoch) epochRollbackCount += 1;
    const timestamp = Math.max(observedEpoch, lastEpoch); lastEpoch = timestamp;
    const boundary = [PROFILE_WORK_PHASES.workEnd, PROFILE_WORK_PHASES.captureOverhead, PROFILE_WORK_PHASES.captureEnd].includes(id);
    if (lastContext !== id) {
      if (boundary || !seenContexts.has(id) || cadenceMs - lastContextAt >= EXTENDED_PROFILE_LIMITS.contextIntervalMs) {
        if (phases.length >= EXTENDED_PROFILE_LIMITS.phaseRows) { phases.splice(1, 1); phaseTruncated = true; }
        phases.push([timestamp, id]); lastContextAt = cadenceMs;
      } else coalescedChanges += 1;
      seenContexts.add(id); lastContext = id;
    }
    if (boundary || cadenceMs - lastMemoryAt >= EXTENDED_PROFILE_LIMITS.checkpointMemoryIntervalMs) {
      lastMemoryAt = cadenceMs;
      try { numericMemory?.sample(id === PROFILE_WORK_PHASES.captureOverhead ? 3 : 5); } catch { /* receipt exposes faults */ }
    }
  };
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
    if (["complete", "work-failed", "work-exit"].includes(reason)) phase(PROFILE_WORK_PHASES.workEnd);
    finished = true;
    clearTimeout(timer);
    const stopped = now();
    const stopRequestedAt = new Date().toISOString();
    let stoppedAt = null;
    let bytes = 0;
    let profileSha256 = null;
    const overheadStarted = now();
    const extension = extended ? { allocationRequested: config.modes?.allocation === true,
      memoryRequested: config.modes?.memory === true, allocation: null, memory: null, phases: null, allocationStartInspectorMs: 0, allocationStopAndSanitizeMs: 0 } : null;
    if (extended) {
      // Preserve work-end before inspector materializes its response, then label capture overhead.
      finished = false; phase(PROFILE_WORK_PHASES.captureOverhead); finished = true;
      if (config.modes?.allocation === true) {
        try {
          const value = allocation?.finish();
          extension.allocationStartInspectorMs = value?.startInspectorMs ?? 0;
          extension.allocationStopAndSanitizeMs = value?.stopAndSanitizeMs ?? 0;
          extension.allocation = value?.artifact ? persistCaptureArtifact(config.directory, "allocation.json", value.artifact, EXTENDED_PROFILE_LIMITS.allocationBytes)
            : { bytes: 0, sha256: null, error: "ALLOCATION_PROFILE_CAPTURE_FAILED" };
          if (value?.error) extension.allocation.error = "ALLOCATION_PROFILE_CAPTURE_FAILED";
        } catch { extension.allocation = { bytes: 0, sha256: null, error: "ALLOCATION_PROFILE_CAPTURE_FAILED" }; }
      }
    }
    try {
      if (observer) collect(observer.takeRecords());
      observer?.disconnect();
      if (session && running) {
        running = false;
        const { profile } = post("Profiler.stop");
        stoppedAt = new Date().toISOString();
        if (error !== null) throw fault("WORKER_PROFILE_CAPTURE_FAILED");
        try { numericMemory?.sample(3); } catch {}
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
    if (extended) {
      finished = false; phase(PROFILE_WORK_PHASES.captureEnd); finished = true;
      if (config.modes?.memory === true) {
        try {
          const value = validateNumericMemoryReceipt(numericMemory.finish());
          extension.memory = persistCaptureArtifact(config.directory, "memory.json", value, EXTENDED_PROFILE_LIMITS.memoryBytes);
          if (value.sampling.errors > 0) extension.memory.error = "MEMORY_PROFILE_CAPTURE_FAILED";
        } catch { extension.memory = { bytes: 0, sha256: null, error: "MEMORY_PROFILE_CAPTURE_FAILED" }; }
      }
      try {
        extension.phases = persistCaptureArtifact(config.directory, "phases.json", { schemaVersion: "local-work-phases-v1",
          phaseIdsAreWorkContext: true, memoryReasonIdsAreSeparate: true, phases, truncated: phaseTruncated,
          contextIntervalMs: EXTENDED_PROFILE_LIMITS.contextIntervalMs, checkpointMemoryIntervalMs: EXTENDED_PROFILE_LIMITS.checkpointMemoryIntervalMs,
          coalescedChanges, completeTemporalCoverage: false, contextIsNotExclusiveDuration: true, epochRollbackCount, wallClockRollbacksClamped: true, cadenceClock: "monotonic" }, EXTENDED_PROFILE_LIMITS.phaseBytes);
        if (phaseTruncated) extension.phases.error = "PHASE_PROFILE_TRUNCATED";
      } catch { extension.phases = { bytes: 0, sha256: null, error: "PHASE_PROFILE_CAPTURE_FAILED" }; }
      if ([extension.allocation, extension.memory, extension.phases].some((entry) => entry?.error)) error ??= "WORKER_PROFILE_EXTENSION_FAILED";
    }
    const elapsedMs = stopped - started;
    try { save(join(config.directory, "summary.json"), { startedAt, stopRequestedAt, stoppedAt, drainedAt: new Date().toISOString(), threadId,
      elapsedMs, durationOvershootMs: Math.max(0, elapsedMs - config.durationMs), reason,
      coverage: error === null && reason === "complete" && elapsedMs <= config.durationMs ? "complete" : "incomplete", error,
      ...(extended ? { extension } : {}), profileBytes: profileSha256 === null ? 0 : bytes, profileSha256, gc, startInspectorMs, stopAndPersistMs: now() - overheadStarted,
      identity: { id: config.id, parentId: config.parentId, role: config.role, attempt: config.attempt },
      scope: "isolate CPU samples and GC; no per-isolate process CPU/RSS claim" }); } catch {}
  };
  try {
    if (!Number.isSafeInteger(config.id) || config.id < 0 || config.id >= 256
        || !["owner", "model-block", "main"].includes(config.role)
        || !(config.parentId === null || (Number.isSafeInteger(config.parentId) && config.parentId >= 0))
        || !Number.isSafeInteger(config.attempt) || config.attempt < 0
        || !Number.isSafeInteger(config.profileBytes) || config.profileBytes < 1 || config.profileBytes > WORKER_PROFILE_LIMITS.profileBytes
        || !Number.isSafeInteger(config.durationMs) || config.durationMs < 1 || config.durationMs > WORKER_PROFILE_LIMITS.durationMs
        || config.sampleUs !== WORKER_PROFILE_LIMITS.sampleUs) throw fault("WORKER_PROFILE_SETTINGS_INVALID");
    if (extended && (!exactKeys(config.modes, ["allocation", "memory"])
        || typeof config.modes.allocation !== "boolean" || typeof config.modes.memory !== "boolean"
        || !(config.modes.allocation || config.modes.memory) || config.profileBytes !== EXTENDED_PROFILE_LIMITS.cpuBytes)) throw fault("WORKER_PROFILE_SETTINGS_INVALID");
    privateDirectory(config.directory);
    if (extended && config.modes.memory) numericMemory = memoryFactory({ enabled: true,
      isolateId: config.id, role: config.role === "main" ? "main" : "worker", maxBytes: EXTENDED_PROFILE_LIMITS.memoryBytes });
    phase(PROFILE_WORK_PHASES.captureOverhead);
    const initStarted = now();
    session = createSession(); session.connect();
    post("Profiler.enable"); post("Profiler.setSamplingInterval", { interval: config.sampleUs }); post("Profiler.start"); running = true;
    startInspectorMs = now() - initStarted;
    if (extended && config.modes.allocation) allocation = startAllocationProfile({ enabled: true, post,
      bundles: new Map([[config.bundleUrl, config.bundleModules ?? []]]), now });
    phase(PROFILE_WORK_PHASES.modules);
    observer = observerFactory((list) => collect(list.getEntries())); observer.observe({ entryTypes: ["gc"] });
    timer = setTimeout(() => finish("duration-limit"), config.durationMs); timer.unref?.();
  } catch { error = "WORKER_PROFILE_START_FAILED"; finish("start-failed"); }
  return extended ? { finish, checkpoint: phase } : { finish };
}
