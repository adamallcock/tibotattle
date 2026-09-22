#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = "tibotattle-offline-crash-doctor-v2";
const MAX_DIRECTORY_ENTRIES = 5000;
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_REPORTS = 10;
const MAX_CANDIDATES = 40;
const APP_NAME = /^tibotattle(?: dev)?(?: helper(?: \([^)]{1,30}\))?)?$/iu;
const REPORT_NAME = /^tibotattle(?: dev)?(?: helper)?[-_. ]/iu;
const SAFE_SYMBOL = /^[A-Za-z_$][A-Za-z0-9_$:<>+~-]{0,119}$/u;
const SAFE_EXCEPTION = /^(?:EXC_[A-Z_]{1,40}|SIG[A-Z]{1,20})$/u;
const SAFE_TERMINATION = /^[A-Z][A-Z0-9_]{0,39}$/u;
const SAFE_CODE = /^(?:0x[0-9a-fA-F]{1,16}|[0-9]{1,16})$/u;
const CAPTURE_SCHEMA = "tibotattle-electron-crash-capture-v1";
const DIAGNOSTIC_SCHEMA = "local-diagnostic-note-v0.1";
const MAX_DIAGNOSTIC_LOG_BYTES = 256 * 1024;
const MAX_DIAGNOSTIC_NOTES = 40;
const MAX_PRIVATE_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_PRIVATE_DUMP_BYTES = 16 * 1024 * 1024;
const MAX_PRIVATE_DUMPS = 4;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIAGNOSTIC_SURFACES = new Set([
  "automatic_contribution", "community_results", "contribution_connect",
  "contribution_prepare", "contribution_send", "device_credential_reset",
  "hosted_identity", "hosted_privacy", "local_refresh", "local_startup",
  "participant_deletion",
]);
const DIAGNOSTIC_CODE = /^(?:[A-Z][A-Z0-9_]{1,63}|[a-z][a-z0-9_]{1,63})$/u;
const DIAGNOSTIC_REFERENCE = /^TT-[0-9A-HJKMNP-TV-Z]{6}$/u;
const VERSION = /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]{1,20})?$/u;
const OS_VERSION = /^macOS [0-9]+(?:\.[0-9]+){0,2}$/u;

function safeValue(value, pattern) {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function safeCode(value) {
  return safeValue(typeof value === "number" && Number.isSafeInteger(value)
    ? String(value) : value, SAFE_CODE);
}

function isOwnedRegularFile(stat, uid) {
  return stat.isFile() && stat.nlink === 1 && (uid === null || stat.uid === uid);
}

async function readOwnedBytes(path, uid, maximumBytes, { ownerOnly = false } = {}) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!isOwnedRegularFile(stat, uid) || stat.size > maximumBytes
      || (ownerOnly && (stat.mode & 0o077) !== 0)) return null;
    const buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    return length > maximumBytes ? null : buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

async function readOwnedFile(path, uid, maximumBytes, options) {
  const bytes = await readOwnedBytes(path, uid, maximumBytes, options);
  return bytes === null ? null : bytes.toString("utf8");
}

async function listOwnedDirectory(path, uid) {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || (uid !== null && stat.uid !== uid)) return { status: "unavailable", names: [] };
    const names = await readdir(path);
    if (names.length > MAX_DIRECTORY_ENTRIES) return { status: "too_many_entries", names: [] };
    return { status: "available", names };
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "missing" : "unavailable", names: [] };
  }
}

async function isOwnedDirectory(path, uid) {
  try {
    const stat = await lstat(path);
    return stat.isDirectory() && (uid === null || stat.uid === uid);
  } catch { return false; }
}

function safeFrames(frames, limit = 5) {
  if (!Array.isArray(frames)) return [];
  return frames.slice(0, limit).map((frame) => safeValue(frame?.symbol, SAFE_SYMBOL) ?? "unavailable");
}

function processKind(name) {
  if (typeof name !== "string" || !APP_NAME.test(name)) return null;
  if (/\bDev\b/iu.test(name)) return "development_app";
  if (/\bHelper\b/iu.test(name)) return "helper";
  return "app";
}

function matchesChannel(kind, channel) {
  return kind !== null && (channel === "all"
    || (channel === "dev" ? kind === "development_app" : kind !== "development_app"));
}

function hasMatchingAppHeader(content, extension, channel) {
  try {
    let name = null;
    if (extension === ".ips") {
      const newline = content.indexOf("\n");
      if (newline < 0) return false;
      name = JSON.parse(content.slice(0, newline))?.app_name;
    } else if (extension === ".crash") {
      name = content.match(/^Process:\s*(TiboTattle(?: Dev)?(?: Helper(?: \([^\n)]{1,30}\))?)?)(?:\s|\[)/mu)?.[1];
    }
    return matchesChannel(processKind(name), channel);
  } catch { return false; }
}

function profilesForChannel(channel) {
  return channel === "all" ? ["stable", "dev"] : [channel];
}

function userDataPath(homeDirectory, profile) {
  return join(homeDirectory, "Library", "Application Support",
    profile === "dev" ? "TiboTattle Dev" : "TiboTattle");
}

export function parseAppleCrashReport(content, extension, { verbose = false } = {}) {
  try {
    if (extension === ".ips") {
      const newline = content.indexOf("\n");
      const metadata = newline < 0 ? {} : JSON.parse(content.slice(0, newline));
      const body = JSON.parse(newline < 0 ? content : content.slice(newline + 1));
      const name = body?.procName ?? metadata?.app_name;
      const kind = processKind(name);
      if (kind === null) return null;
      const threads = Array.isArray(body?.threads) ? body.threads : [];
      const selected = Number.isSafeInteger(body?.faultingThread)
        ? threads[body.faultingThread] : threads.find((thread) => thread?.triggered === true);
      return {
        processKind: kind,
        exceptionType: safeValue(body?.exception?.type, SAFE_EXCEPTION),
        terminationNamespace: safeValue(body?.termination?.namespace, SAFE_TERMINATION),
        terminationCode: safeCode(body?.termination?.code),
        topFrames: safeFrames(selected?.frames, verbose ? 20 : 5),
        ...(verbose ? {
          reportFormat: "ips",
          appVersion: safeValue(body?.bundleInfo?.CFBundleShortVersionString, VERSION),
          osVersion: safeValue(body?.osVersion?.train, OS_VERSION),
          crashedThreadIndex: Number.isSafeInteger(body?.faultingThread)
            && body.faultingThread >= 0 && body.faultingThread < threads.length
            ? body.faultingThread : null,
        } : {}),
      };
    }
    if (extension === ".crash") {
      const name = content.match(/^Process:\s*(TiboTattle(?: Dev)?(?: Helper(?: \([^\n)]{1,30}\))?)?)(?:\s|\[)/mu)?.[1];
      const kind = processKind(name);
      if (kind === null) return null;
      const exception = content.match(/^Exception Type:\s*(EXC_[A-Z_]+|SIG[A-Z]+)/mu)?.[1];
      const termination = content.match(/^Termination Reason:\s*Namespace ([A-Z0-9_]+), Code (0x[0-9a-fA-F]+|[0-9]+)/mu);
      const thread = content.match(/^(?:Triggered by Thread|Crashed Thread):\s*(\d+)/mu)?.[1];
      const section = thread === undefined ? null
        : content.match(new RegExp(`^Thread ${thread} Crashed:\\s*\\n((?:[^\\n]*\\n){0,20})`, "mu"))?.[1];
      const lines = section?.split("\n").filter((line) => /^\s*\d+\s/u.test(line)).slice(0, verbose ? 20 : 5) ?? [];
      return {
        processKind: kind,
        exceptionType: safeValue(exception, SAFE_EXCEPTION),
        terminationNamespace: safeValue(termination?.[1], SAFE_TERMINATION),
        terminationCode: safeCode(termination?.[2]),
        topFrames: lines.map((line) => safeValue(
          line.match(/^\s*\d+\s+.+?\s+0x[0-9a-fA-F]+\s+([^\s]+)(?:\s+\+\s+\d+)?\s*$/u)?.[1],
          SAFE_SYMBOL,
        ) ?? "unavailable"),
        ...(verbose ? {
          reportFormat: "crash",
          appVersion: safeValue(content.match(/^Version:\s*([^\s]+)/mu)?.[1], VERSION),
          osVersion: safeValue(content.match(/^OS Version:\s*(macOS [0-9.]+)/mu)?.[1], OS_VERSION),
          crashedThreadIndex: thread !== undefined && Number.isSafeInteger(Number(thread))
            ? Number(thread) : null,
        } : {}),
      };
    }
  } catch {
    // Malformed and changing Apple schemas are reported as unreadable, without
    // propagating source text or native parse errors.
  }
  return null;
}

function parseDiagnosticNote(line) {
  try {
    const value = JSON.parse(line);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => ![
      "schemaVersion", "recordedAt", "reference", "surface", "code",
      "requestId", "step", "detail", "measurements",
    ].includes(key)) || ![
      "schemaVersion", "recordedAt", "reference", "surface", "code", "requestId",
    ].every((key) => Object.hasOwn(value, key))) return null;
    if (value.schemaVersion !== DIAGNOSTIC_SCHEMA
      || typeof value.recordedAt !== "string"
      || Number.isNaN(Date.parse(value.recordedAt))
      || new Date(value.recordedAt).toISOString() !== value.recordedAt
      || !DIAGNOSTIC_REFERENCE.test(value.reference)
      || !DIAGNOSTIC_SURFACES.has(value.surface)
      || !DIAGNOSTIC_CODE.test(value.code)
      || typeof value.requestId !== "string"
      || (value.step !== undefined && !DIAGNOSTIC_CODE.test(value.step))
      || (value.detail !== undefined && !DIAGNOSTIC_CODE.test(value.detail))) return null;
    const note = {
      recordedAt: value.recordedAt,
      reference: value.reference,
      surface: value.surface,
      code: value.code,
      ...(value.step === undefined ? {} : { step: value.step }),
      ...(value.detail === undefined ? {} : { detail: value.detail }),
    };
    if (value.measurements !== undefined) {
      const measurements = value.measurements;
      if (measurements === null || typeof measurements !== "object" || Array.isArray(measurements)
        || Reflect.ownKeys(measurements).length !== 3
        || Reflect.ownKeys(measurements).some((key) => ![
          "baselineRssMib", "observedRssMib", "ceilingRssMib",
        ].includes(key))) return null;
      for (const [key, number] of Object.entries(measurements)) {
        if (number !== null && (!Number.isSafeInteger(number) || number < 0 || number > 1_000_000)) return null;
        note[key] = number;
      }
    }
    return note;
  } catch { return null; }
}

async function inspectDiagnosticNotes(homeDirectory, uid, profile, now, hours) {
  const root = join(userDataPath(homeDirectory, profile), "companion-state");
  const notes = [];
  let invalidLines = 0;
  let availableGenerations = 0;
  for (const filename of ["diagnostics-v0.1.log.previous", "diagnostics-v0.1.log"]) {
    try {
      const content = await readOwnedFile(join(root, filename), uid,
        MAX_DIAGNOSTIC_LOG_BYTES, { ownerOnly: true });
      if (content === null) { invalidLines += 1; continue; }
      availableGenerations += 1;
      for (const line of content.split("\n")) {
        if (line.length === 0) continue;
        const note = parseDiagnosticNote(line);
        if (note === null) { invalidLines += 1; continue; }
        const recorded = Date.parse(note.recordedAt);
        if (recorded >= now - hours * 3_600_000 && recorded <= now + 60_000) notes.push(note);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") invalidLines += 1;
    }
  }
  notes.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  return {
    profile,
    status: availableGenerations > 0 ? "available" : "missing_or_unavailable",
    notes: notes.slice(0, MAX_DIAGNOSTIC_NOTES),
    mayHaveMore: notes.length > MAX_DIAGNOSTIC_NOTES,
    invalidLines,
  };
}

async function inspectCapture(homeDirectory, uid, profile) {
  const userData = userDataPath(homeDirectory, profile);
  const preference = join(userData, "desktop-settings", "crash-capture-v1.json");
  let capturePreference = "missing";
  try {
    const raw = await readOwnedFile(preference, uid, 512);
    if (raw === null) capturePreference = "unavailable";
    else {
      try {
        const parsed = JSON.parse(raw);
        capturePreference = parsed !== null && typeof parsed === "object"
          && !Array.isArray(parsed) && Object.getPrototypeOf(parsed) === Object.prototype
          && parsed.schemaVersion === CAPTURE_SCHEMA
          && Reflect.ownKeys(parsed).length === 2 && typeof parsed.enabled === "boolean"
          ? parsed.enabled ? "enabled_preference" : "disabled_preference" : "invalid";
      } catch { capturePreference = "invalid"; }
    }
  } catch (error) {
    capturePreference = error?.code === "ENOENT" ? "missing" : "unavailable";
  }
  const crashpad = join(userData, "Crashpad");
  const counts = {};
  for (const location of ["pending", "completed"]) {
    const listing = await listOwnedDirectory(join(crashpad, location), uid);
    if (listing.status !== "available") { counts[location] = { status: listing.status, count: null }; continue; }
    let count = 0;
    for (const name of listing.names) {
      if (!/^[A-Za-z0-9_-]{1,100}\.dmp$/u.test(name)) continue;
      try {
        const stat = await lstat(join(crashpad, location, name));
        if (isOwnedRegularFile(stat, uid)) count += 1;
      } catch { /* A file may disappear while the app or OS handles it. */ }
    }
    counts[location] = { status: "available", count };
  }
  return { capturePreference, crashpad: counts };
}

async function scanAppleReports({ homeDirectory, uid, hours, channel, now, verbose, retainBytes = false }) {
  const reportDirectory = join(homeDirectory, "Library", "Logs", "DiagnosticReports");
  const listing = await listOwnedDirectory(reportDirectory, uid);
  const candidates = [];
  let skippedLargeReports = 0;
  if (listing.status === "available") {
    for (const name of listing.names) {
      if (!REPORT_NAME.test(name) || !/\.(?:ips|crash)$/iu.test(name)
        || (channel === "stable" && /^tibotattle dev[-_. ]/iu.test(name))
        || (channel === "dev" && !/^tibotattle dev[-_. ]/iu.test(name))) continue;
      const path = join(reportDirectory, name);
      try {
        const stat = await lstat(path);
        if (isOwnedRegularFile(stat, uid)
          && stat.mtimeMs <= now + 60_000 && stat.mtimeMs >= now - hours * 3_600_000) {
          if (stat.size > MAX_REPORT_BYTES) skippedLargeReports += 1;
          else candidates.push({ path, mtimeMs: stat.mtimeMs,
            extension: name.toLowerCase().endsWith(".ips") ? ".ips" : ".crash" });
        }
      } catch { /* A report may be rotated while we inspect it. */ }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const reports = [];
  const sources = [];
  let unreadableCount = 0;
  let unparsedSources = 0;
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    if (reports.length === MAX_REPORTS) break;
    try {
      const bytes = await readOwnedBytes(candidate.path, uid, MAX_REPORT_BYTES);
      const parsed = bytes === null ? null
        : parseAppleCrashReport(bytes.toString("utf8"), candidate.extension, { verbose });
      if (parsed === null) {
        unreadableCount += 1;
        if (retainBytes && bytes !== null && sources.length < MAX_REPORTS
          && hasMatchingAppHeader(bytes.toString("utf8"), candidate.extension, channel)) {
          sources.push({ extension: candidate.extension, bytes, unparsed: true });
          unparsedSources += 1;
        }
        continue;
      }
      if (!matchesChannel(parsed.processKind, channel)) continue;
      reports.push({ reportModifiedAt: new Date(candidate.mtimeMs).toISOString(), ...parsed });
      if (retainBytes && sources.length < MAX_REPORTS) {
        sources.push({ extension: candidate.extension, bytes, unparsed: false });
      }
    } catch { unreadableCount += 1; }
  }
  return {
    appleReports: { status: listing.status, matches: reports, unreadableCount,
      candidateFiles: candidates.length, skippedLargeReports,
      mayHaveMore: candidates.length > MAX_CANDIDATES || reports.length === MAX_REPORTS },
    sources,
    unparsedSources,
  };
}

export async function diagnoseDesktopCrash({
  homeDirectory = homedir(),
  platform = process.platform,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  hours = 168,
  channel = "stable",
  verbose = false,
  now = Date.now(),
} = {}) {
  if (platform !== "darwin") return { schemaVersion: SCHEMA_VERSION, status: "unsupported_platform" };
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 720) throw new TypeError("invalid lookback hours");
  if (!["stable", "dev", "all"].includes(channel)) throw new TypeError("invalid channel");
  if (typeof verbose !== "boolean") throw new TypeError("invalid verbose mode");
  const { appleReports } = await scanAppleReports({
    homeDirectory, uid, hours, channel, now, verbose,
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    status: "ok",
    lookbackHours: hours,
    channel,
    mode: verbose ? "verbose" : "summary",
    appleReports,
    localCapture: await Promise.all(profilesForChannel(channel)
      .map(async (profile) => ({ profile, ...await inspectCapture(homeDirectory, uid, profile) }))),
    ...(verbose ? { diagnosticNotes: await Promise.all(profilesForChannel(channel)
      .map((profile) => inspectDiagnosticNotes(homeDirectory, uid, profile, now, hours))) } : {}),
    note: "Read-only local summary. No app launch, network request, or raw report upload. A stored preference does not prove capture was active at crash time. Absence of a report does not rule out a crash.",
  };
}

async function writePrivateFile(directory, filename, bytes) {
  const handle = await open(join(directory, filename),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  return { name: filename, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
}

function assertPrivateDestination(directory) {
  if (typeof directory !== "string" || !isAbsolute(directory)
    || directory.includes("\0") || directory.length > 4096
    || [".", ".."].includes(basename(directory))
    || !/^[A-Za-z0-9._ -]{1,100}$/u.test(basename(directory))) {
    throw new TypeError("private destination is invalid");
  }
  const selected = resolve(directory);
  const withinRepository = relative(REPOSITORY_ROOT, selected);
  if (selected === REPOSITORY_ROOT
    || (withinRepository !== ".." && !withinRepository.startsWith(`..${sep}`)
      && !isAbsolute(withinRepository))) {
    throw new TypeError("private destination is invalid");
  }
  return { selected, parent: dirname(selected) };
}

/** Explicit local-only export of original evidence. Never included in the doctor JSON. */
export async function exportPrivateCrashEvidence({
  directory,
  homeDirectory = homedir(),
  platform = process.platform,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  hours = 168,
  channel = "stable",
  includeDumps = false,
  now = Date.now(),
} = {}) {
  if (platform !== "darwin" || !Number.isSafeInteger(hours) || hours < 1 || hours > 720
    || !["stable", "dev", "all"].includes(channel) || typeof includeDumps !== "boolean") {
    throw new TypeError("private export options are invalid");
  }
  const { selected, parent } = assertPrivateDestination(directory);
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || (uid !== null && parentStat.uid !== uid)
    || (parentStat.mode & 0o022) !== 0) {
    throw new TypeError("private destination parent is unsafe");
  }
  // Collect from fixed app-owned locations before creating the destination.
  // Raw bytes remain in process memory until an explicit export is requested.
  const sources = [];
  const scanned = await scanAppleReports({
    homeDirectory, uid, hours, channel, now, verbose: false, retainBytes: true,
  });
  scanned.sources.forEach((source, index) => sources.push({
    name: `apple-report-${String(index + 1).padStart(2, "0")}${source.extension}`,
    bytes: source.bytes,
    unparsed: source.unparsed,
  }));
  let skippedFiles = scanned.appleReports.skippedLargeReports
    + scanned.appleReports.unreadableCount - scanned.unparsedSources;
  for (const profile of profilesForChannel(channel)) {
    const userData = userDataPath(homeDirectory, profile);
    const state = join(userData, "companion-state");
    if (!(await isOwnedDirectory(userData, uid)) || !(await isOwnedDirectory(state, uid))) {
      skippedFiles += 2;
      continue;
    }
    for (const [generation, filename] of [
      ["previous", "diagnostics-v0.1.log.previous"],
      ["current", "diagnostics-v0.1.log"],
    ]) {
      try {
        const bytes = await readOwnedBytes(join(state, filename), uid,
          MAX_DIAGNOSTIC_LOG_BYTES, { ownerOnly: true });
        if (bytes === null) skippedFiles += 1;
        else sources.push({ name: `companion-${profile}-${generation}.log`, bytes });
      } catch (error) { if (error?.code !== "ENOENT") skippedFiles += 1; }
    }
  }
  let collectedDumps = 0;
  if (includeDumps) {
    for (const profile of profilesForChannel(channel)) {
      const userData = userDataPath(homeDirectory, profile);
      const crashpad = join(userData, "Crashpad");
      if (!(await isOwnedDirectory(userData, uid)) || !(await isOwnedDirectory(crashpad, uid))) {
        continue;
      }
      for (const location of ["pending", "completed"]) {
        const listing = await listOwnedDirectory(join(crashpad, location), uid);
        if (listing.status !== "available") continue;
        const entries = [];
        for (const name of listing.names) {
          if (!/^[A-Za-z0-9_-]{1,100}\.dmp$/u.test(name)) continue;
          const path = join(crashpad, location, name);
          try {
            const stat = await lstat(path);
            if (isOwnedRegularFile(stat, uid)
              && stat.mtimeMs >= now - hours * 3_600_000 && stat.mtimeMs <= now + 60_000) {
              entries.push({ path, mtimeMs: stat.mtimeMs });
            }
          } catch { skippedFiles += 1; }
        }
        entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
        for (const entry of entries) {
          if (collectedDumps >= MAX_PRIVATE_DUMPS) { skippedFiles += 1; continue; }
          try {
            const bytes = await readOwnedBytes(entry.path, uid,
              MAX_PRIVATE_DUMP_BYTES, { ownerOnly: true });
            if (bytes === null) { skippedFiles += 1; continue; }
            collectedDumps += 1;
            sources.push({ name: `crashpad-${profile}-${location}-${String(collectedDumps).padStart(2, "0")}.dmp`, bytes });
          } catch { skippedFiles += 1; }
        }
      }
    }
  }
  const selectedSources = [];
  let totalBytes = 0;
  for (const source of sources) {
    if (totalBytes + source.bytes.length > MAX_PRIVATE_BUNDLE_BYTES) { skippedFiles += 1; continue; }
    totalBytes += source.bytes.length;
    selectedSources.push(source);
  }
  const includedDumps = selectedSources.filter((source) => source.name.endsWith(".dmp")).length;
  const unparsedReportsIncluded = selectedSources.filter((source) => source.unparsed === true).length;
  await mkdir(selected, { mode: 0o700 }); // exact no-clobber destination
  try {
    const files = [];
    for (const source of selectedSources) {
      files.push(await writePrivateFile(selected, source.name, source.bytes));
    }
    const manifest = Buffer.from(`${JSON.stringify({
      schemaVersion: "tibotattle-private-crash-evidence-v1",
      createdAt: new Date(now).toISOString(),
      channel, lookbackHours: hours, includesCrashpadDumps: includeDumps,
      unparsedReportsIncluded,
      skippedFiles, files,
    }, null, 2)}\n`);
    await writePrivateFile(selected, "manifest.json", manifest);
    const handle = await open(selected, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
    return { status: "created", includedFiles: files.length,
      includedDumps, unparsedReportsIncluded,
      skippedFiles, totalBytes };
  } catch (error) {
    await rm(selected, { recursive: true, force: true });
    throw error;
  }
}

export function renderDesktopCrashDiagnosis(result) {
  if (result.status === "unsupported_platform") return "This crash doctor currently supports macOS only.\n";
  const lines = [
    "TiboTattle offline crash doctor",
    `Apple crash reports: ${result.appleReports.status}; channel: ${result.channel}; summaries shown: ${result.appleReports.matches.length}${result.appleReports.mayHaveMore ? " (more may exist)" : ""}`,
  ];
  result.appleReports.matches.forEach((report, index) => {
    lines.push(`Report ${index + 1} (file modified ${report.reportModifiedAt}; ${report.processKind})`);
    lines.push(`  Exception type: ${report.exceptionType ?? "unavailable"}`);
    lines.push(`  Termination: ${report.terminationNamespace ?? "unavailable"} / ${report.terminationCode ?? "unavailable"}`);
    lines.push(`  Crashed thread top frames: ${report.topFrames.length ? report.topFrames.join(", ") : "unavailable"}`);
    if (result.mode === "verbose") {
      lines.push(`  Format: ${report.reportFormat}; app version: ${report.appVersion ?? "unavailable"}; OS: ${report.osVersion ?? "unavailable"}; crashed thread: ${report.crashedThreadIndex ?? "unavailable"}`);
    }
  });
  lines.push(`Candidate report files: ${result.appleReports.candidateFiles}`);
  lines.push(`Reports not summarized: ${result.appleReports.unreadableCount}`);
  lines.push(`Oversized reports skipped: ${result.appleReports.skippedLargeReports}`);
  for (const capture of result.localCapture) {
    lines.push(`Local crash capture preference (${capture.profile}): ${capture.capturePreference}`);
    for (const name of ["pending", "completed"]) {
      const item = capture.crashpad[name];
      lines.push(`Local Crashpad ${name} (${capture.profile}): ${item.status}${item.count === null ? "" : ` (${item.count} dump(s))`}`);
    }
  }
  if (result.mode === "verbose") {
    for (const log of result.diagnosticNotes) {
      lines.push(`Companion diagnostics (${log.profile}): ${log.status}; notes shown: ${log.notes.length}${log.mayHaveMore ? " (more may exist)" : ""}; invalid or inaccessible lines: ${log.invalidLines}`);
      for (const note of log.notes) {
        const memory = note.baselineRssMib === undefined ? ""
          : ` rss_mib=${note.baselineRssMib ?? "unknown"}/${note.observedRssMib ?? "unknown"}/${note.ceilingRssMib ?? "unknown"}`;
        lines.push(`  ${note.recordedAt} ${note.reference} ${note.surface} ${note.code}${note.step === undefined ? "" : ` step=${note.step}`}${note.detail === undefined ? "" : ` detail=${note.detail}`}${memory}`);
      }
    }
  }
  lines.push(result.note);
  return `${lines.join("\n")}\n`;
}

function parseArguments(argv) {
  let hours = 168;
  let json = false;
  let channel = "stable";
  let verbose = false;
  let exportPrivate = null;
  let includeDumps = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--json" && !json) json = true;
    else if (argv[index] === "--verbose" && !verbose) verbose = true;
    else if (argv[index] === "--export-private" && exportPrivate === null
      && index + 1 < argv.length) exportPrivate = argv[++index];
    else if (argv[index] === "--include-dumps" && !includeDumps) includeDumps = true;
    else if (argv[index] === "--channel" && ["stable", "dev", "all"].includes(argv[index + 1])) {
      channel = argv[++index];
    } else if (argv[index] === "--hours" && index + 1 < argv.length
      && /^(?:[1-9]|[1-9][0-9]{1,2})$/u.test(argv[index + 1])) {
      hours = Number(argv[++index]);
      if (hours > 720) throw new TypeError("invalid arguments");
    } else throw new TypeError("invalid arguments");
  }
  if (includeDumps && exportPrivate === null) throw new TypeError("invalid arguments");
  return { hours, json, channel, verbose, exportPrivate, includeDumps };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await diagnoseDesktopCrash(options);
    const privateEvidence = options.exportPrivate === null ? null
      : await exportPrivateCrashEvidence({ ...options, directory: options.exportPrivate });
    process.stdout.write(options.json
      ? `${JSON.stringify(privateEvidence === null ? result : { ...result, privateEvidence }, null, 2)}\n`
      : `${renderDesktopCrashDiagnosis(result)}${privateEvidence === null ? ""
        : `Private evidence created at the requested destination (${privateEvidence.includedFiles} file(s), ${privateEvidence.includedDumps} dump(s), ${privateEvidence.skippedFiles} skipped). Review it privately; do not post the raw files in a public issue.\n`}`);
  } catch {
    process.stderr.write("Crash doctor could not complete. Use --hours 1..720, --channel stable|dev|all, optional --verbose or --json, and optional --export-private ABSOLUTE_DIRECTORY [--include-dumps].\n");
    process.exitCode = 1;
  }
}
