/** Synthetic rehearsal diagnostics only. Never include errors, paths or payloads in progress. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, join } from "node:path";

export const S9_REHEARSAL_DEADLINE_MS = 40 * 60_000;
export const S9_DIAGNOSTIC_BYTES = 256 * 1024;
export const S9_TAP_PROGRESS_PREFIX = "S9_PROGRESS ";
const PHASES = Object.freeze({
  producer: ["source_provenance", "runtime", "module_load", "corpus_validation", "migrations", "admission",
    "settle", "settle_bootstrap", "settle_delivery", "settle_daily", "settle_retirement", "settle_cache", "public_before", "oracle", "public_after", "native_probes", "source_recheck", "cleanup"],
  controller: ["input_binding", "current_d1_replay", "current_d1_acceptance", "postgres", "migrate", "sqlite",
    "importers", "refresh_first", "origin", "parity", "refresh_second", "source_recheck", "cleanup", "report"],
});

/** Build only the child controller corpus argument; the edge consumer retains its canonical GOLDEN root. */
export function s9ControllerGoldenArguments({ mode, golden, workerRoot }) {
  if (mode === "current-worker-d1-d7") {
    if (typeof workerRoot !== "string" || !isAbsolute(workerRoot) || resolve(workerRoot) !== workerRoot) {
      throw Object.assign(new Error("S9_CONTROLLER_GOLDEN_ROOT_INVALID"), { code: "S9_CONTROLLER_GOLDEN_ROOT_INVALID" });
    }
    return ["--golden", join(workerRoot, "analytics-v2-test", "golden-q1-node")];
  }
  if (mode === "historical" || mode === "current-worker-d1") {
    if (typeof golden !== "string" || golden.length === 0) {
      throw Object.assign(new Error("S9_CONTROLLER_GOLDEN_INVALID"), { code: "S9_CONTROLLER_GOLDEN_INVALID" });
    }
    return ["--golden", golden];
  }
  throw Object.assign(new Error("S9_CONTROLLER_GOLDEN_MODE_INVALID"), { code: "S9_CONTROLLER_GOLDEN_MODE_INVALID" });
}
const COUNTERS = ["iteration", "completedSteps", "scopeOrdinal", "ownerOrdinal", "dayOrdinal", "chunkOrdinal",
  "completedOwners", "completedDays", "completedChunks"];
const SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV", "SIGBUS"]);
const CHILD_CODES = new Set(["ENOENT", "EACCES", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]);

/** Fixed five-second heartbeat, immediate phase transitions, at most 1,024 small records.
 * Injected clocks/sinks are for pure tests; callers supply no payload or error object. */
export function createS9Progress(component, { now = () => performance.now(), emit = (line) => process.stderr.write(line),
  schedule = setInterval, cancel = clearInterval } = {}) {
  if (!Object.hasOwn(PHASES, component)) throw new Error("S9_PROGRESS_COMPONENT_INVALID");
  const started = now();
  let phase = null, counters = {}, emitted = 0, stopped = false;
  const tick = () => {
    if (stopped || phase === null || emitted >= 1_024) return;
    const value = { event: "s9_rehearsal_progress", component, phase,
      elapsedMs: Math.min(86_400_000, Math.max(0, Math.round(now() - started))), ...counters };
    emitted++;
    try { emit(`${JSON.stringify(value)}\n`); } catch { /* Diagnostics cannot change the qualification outcome. */ }
  };
  const timer = schedule(tick, 5_000);
  timer?.unref?.();
  return {
    phase(value) {
      if (!PHASES[component].includes(value)) throw new Error("S9_PROGRESS_PHASE_INVALID");
      phase = value; counters = {}; tick();
    },
    counts(value) {
      counters = Object.fromEntries(COUNTERS.filter((key) => Number.isSafeInteger(value?.[key])
        && value[key] >= 0 && value[key] <= 10_000_000).map((key) => [key, value[key]]));
    },
    close() { if (!stopped) { stopped = true; cancel(timer); } },
  };
}

export function validateClosedS9Progress(value) {
  const required = ["event", "component", "phase", "elapsedMs"];
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || !required.every((key) => Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !COUNTERS.includes(key))
    || value.event !== "s9_rehearsal_progress" || typeof value.component !== "string" || !Object.hasOwn(PHASES, value.component)
    || !PHASES[value.component].includes(value.phase)
    || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 86_400_000
    || COUNTERS.some((key) => Object.hasOwn(value, key) && (!Number.isSafeInteger(value[key])
      || value[key] < 0 || value[key] > 10_000_000))) return null;
  return { event: value.event, component: value.component, phase: value.phase, elapsedMs: value.elapsedMs,
    ...Object.fromEntries(COUNTERS.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]])) };
}

/** Successful cleanup first preserves this bounded closed journal as a separate sidecar. */
export function validateS9ProgressJournal(bytes, receipt) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length <= S9_DIAGNOSTIC_BYTES);
  assert.equal(receipt?.preserved, true, "the live journal completed every recorded write");
  assert.equal(bytes.length, receipt.bytes, "the exact completed-write byte count is retained");
  assert.ok(Number.isSafeInteger(receipt.records) && receipt.records >= 0 && receipt.records <= 1_024);
  const lines = bytes.length === 0 ? [] : bytes.toString("utf8").split("\n");
  if (bytes.length > 0) assert.equal(lines.pop(), "", "only complete newline-terminated records are retained");
  assert.equal(lines.length, receipt.records);
  const last = new Map();
  return lines.map((line) => {
    assert.ok(Buffer.byteLength(line) + 1 <= 1_024);
    const value = validateClosedS9Progress(JSON.parse(line));
    assert.ok(value !== null, "only the closed progress contract may be preserved");
    assert.ok(value.elapsedMs >= (last.get(value.component) ?? 0));
    last.set(value.component, value.elapsedMs);
    return value;
  });
}

/** Observe only the existing child's stderr; never launch, signal, or change its result.
 * The journal receives reserialized closed progress; publish is best-effort after each successful write. */
export function observeS9ChildProgress(child, write, publish = null) {
  const stream = child?.stderr;
  if (!stream || typeof stream.on !== "function" || typeof stream.off !== "function") {
    throw new Error("S9_PROGRESS_STREAM_INVALID");
  }
  let buffer = "", dropping = false, closed = false, failed = false;
  let records = 0, bytes = 0, queuedRecords = 0, queuedBytes = 0, rejected = 0, pending = Promise.resolve();
  const lastElapsed = new Map();
  const reject = () => { rejected = Math.min(10_000_000, rejected + 1); };
  const accept = (line) => {
    let value;
    try { value = JSON.parse(line); } catch { reject(); return; }
    const safe = validateClosedS9Progress(value);
    if (safe === null) { reject(); return; }
    const text = `${JSON.stringify(safe)}\n`, size = Buffer.byteLength(text);
    if (failed || value.elapsedMs < (lastElapsed.get(value.component) ?? 0)
      || queuedRecords >= 1_024 || queuedBytes + size > S9_DIAGNOSTIC_BYTES) { reject(); return; }
    lastElapsed.set(value.component, value.elapsedMs);
    queuedRecords++; queuedBytes += size;
    pending = pending.then(async () => {
      if (failed) { reject(); return; }
      await write(text); records++; bytes += size;
      if (typeof publish === "function") {
        try { publish(`${S9_TAP_PROGRESS_PREFIX}${text}`); } catch { /* Live visibility cannot change journal preservation. */ }
      }
    }).catch(() => { failed = true; reject(); });
  };
  const onData = (chunk) => {
    if (closed) return;
    // Reject an oversized whole chunk without retaining or parsing its contents.
    if (!(typeof chunk === "string" || Buffer.isBuffer(chunk)) || Buffer.byteLength(chunk) > 64 * 1024) {
      buffer = ""; dropping = true; reject(); return;
    }
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    for (const part of text.split(/(?<=\n)/u)) {
      if (dropping) { if (part.endsWith("\n")) dropping = false; continue; }
      if (Buffer.byteLength(buffer) + Buffer.byteLength(part) > 1_024) {
        buffer = ""; dropping = !part.endsWith("\n"); reject(); continue;
      }
      buffer += part;
      if (buffer.endsWith("\n")) { accept(buffer); buffer = ""; }
    }
  };
  stream.on("data", onData);
  return {
    async close() {
      if (!closed) { closed = true; stream.off("data", onData); if (buffer !== "") reject(); buffer = ""; }
      await pending;
      return { records, bytes, rejected, preserved: !failed };
    },
  };
}

export function boundedS9ChildOutput(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : "");
  return { bytes: Buffer.from(bytes.subarray(Math.max(0, bytes.length - S9_DIAGNOSTIC_BYTES))),
    originalBytes: bytes.length, truncated: bytes.length > S9_DIAGNOSTIC_BYTES };
}

/** Keep the actual rejected child outcome. Never propagate its raw message, command or path. */
export async function captureS9ChildCompletion(work, now = () => performance.now()) {
  const started = now();
  try {
    const value = await work();
    return { metadata: { state: "completed", exitCode: 0, signal: null, killed: false, childCode: null,
      deadlineMs: S9_REHEARSAL_DEADLINE_MS, deadlineElapsed: now() - started >= S9_REHEARSAL_DEADLINE_MS },
      stdout: boundedS9ChildOutput(value.stdout), stderr: boundedS9ChildOutput(value.stderr) };
  } catch (error) {
    return { metadata: { state: "failed", exitCode: Number.isSafeInteger(error?.code) && error.code >= 0 && error.code <= 255 ? error.code : null,
      signal: SIGNALS.has(error?.signal) ? error.signal : null, killed: error?.killed === true,
      childCode: CHILD_CODES.has(error?.code) ? error.code : "other",
      deadlineMs: S9_REHEARSAL_DEADLINE_MS, deadlineElapsed: now() - started >= S9_REHEARSAL_DEADLINE_MS },
      stdout: boundedS9ChildOutput(error?.stdout), stderr: boundedS9ChildOutput(error?.stderr) };
  }
}

export function assertS9ChildCompleted(metadata) {
  if (metadata.state !== "completed") {
    throw Object.assign(new Error("S9_REHEARSAL_CHILD_FAILED"), { code: "S9_REHEARSAL_CHILD_FAILED", diagnostic: metadata });
  }
}

/** A valid error report must reach the caller's existing exact kept-schema cleanup.
 * A missing/invalid report cannot hide the original child failure behind ENOENT. */
export async function readS9ChildReport(path, metadata, read = readFile) {
  try {
    const report = JSON.parse(await read(path, "utf8"));
    if (report === null || typeof report !== "object" || Array.isArray(report)) throw new Error("invalid");
    return report;
  } catch {
    assertS9ChildCompleted(metadata);
    throw Object.assign(new Error("S9_REHEARSAL_REPORT_INVALID"), { code: "S9_REHEARSAL_REPORT_INVALID" });
  }
}

export function ownedKeptRehearsalSchemas(report) {
  assert.equal(report.reusedSchema, false, "S9 owns only a fresh rehearsal");
  const match = /^typed_legacy_transfer_rehearsal_target_fastpath_([0-9a-f]{8})$/u.exec(report.schema);
  assert.ok(match, "the fresh target has the generated rehearsal prefix and suffix");
  const allowed = [report.schema, `typed_legacy_transfer_rehearsal_ctl_${match[1]}`];
  assert.ok(Array.isArray(report.keptSchemas) && report.keptSchemas.length <= 2
    && new Set(report.keptSchemas).size === report.keptSchemas.length
    && report.keptSchemas.every((name) => allowed.includes(name)), "only this generated target/control pair is owned");
  return report.keptSchemas;
}

/** Preserve the exact generated-pair ownership fence before entering cleanup. */
export async function withS9OwnedSchemaCleanup(report, work, cleanup) {
  const kept = ownedKeptRehearsalSchemas(report);
  try { return await work(kept); } finally { await cleanup(kept); }
}
