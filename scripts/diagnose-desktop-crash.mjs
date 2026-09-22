#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = "tibotattle-offline-crash-doctor-v1";
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

async function readOwnedFile(path, uid, maximumBytes) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!isOwnedRegularFile(stat, uid) || stat.size > maximumBytes) return null;
    const buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    return length > maximumBytes ? null : buffer.subarray(0, length).toString("utf8");
  } finally {
    await handle.close();
  }
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

function safeFrames(frames) {
  if (!Array.isArray(frames)) return [];
  return frames.slice(0, 5).map((frame) => safeValue(frame?.symbol, SAFE_SYMBOL) ?? "unavailable");
}

function processKind(name) {
  if (typeof name !== "string" || !APP_NAME.test(name)) return null;
  if (/\bDev\b/iu.test(name)) return "development_app";
  if (/\bHelper\b/iu.test(name)) return "helper";
  return "app";
}

export function parseAppleCrashReport(content, extension) {
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
        topFrames: safeFrames(selected?.frames),
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
      const lines = section?.split("\n").filter((line) => /^\s*\d+\s/u.test(line)).slice(0, 5) ?? [];
      return {
        processKind: kind,
        exceptionType: safeValue(exception, SAFE_EXCEPTION),
        terminationNamespace: safeValue(termination?.[1], SAFE_TERMINATION),
        terminationCode: safeCode(termination?.[2]),
        topFrames: lines.map((line) => safeValue(
          line.match(/^\s*\d+\s+.+?\s+0x[0-9a-fA-F]+\s+([^\s]+)(?:\s+\+\s+\d+)?\s*$/u)?.[1],
          SAFE_SYMBOL,
        ) ?? "unavailable"),
      };
    }
  } catch {
    // Malformed and changing Apple schemas are reported as unreadable, without
    // propagating source text or native parse errors.
  }
  return null;
}

async function inspectCapture(homeDirectory, uid, profile) {
  const userData = join(homeDirectory, "Library", "Application Support",
    profile === "dev" ? "TiboTattle Dev" : "TiboTattle");
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

export async function diagnoseDesktopCrash({
  homeDirectory = homedir(),
  platform = process.platform,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  hours = 168,
  channel = "stable",
  now = Date.now(),
} = {}) {
  if (platform !== "darwin") return { schemaVersion: SCHEMA_VERSION, status: "unsupported_platform" };
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 720) throw new TypeError("invalid lookback hours");
  if (!["stable", "dev", "all"].includes(channel)) throw new TypeError("invalid channel");
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
  let unreadableCount = 0;
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    if (reports.length === MAX_REPORTS) break;
    try {
      const content = await readOwnedFile(candidate.path, uid, MAX_REPORT_BYTES);
      const parsed = content === null ? null : parseAppleCrashReport(content, candidate.extension);
      if (parsed === null) { unreadableCount += 1; continue; }
      if ((channel === "stable" && parsed.processKind === "development_app")
        || (channel === "dev" && parsed.processKind !== "development_app")) continue;
      reports.push({ reportModifiedAt: new Date(candidate.mtimeMs).toISOString(), ...parsed });
    } catch { unreadableCount += 1; }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    status: "ok",
    lookbackHours: hours,
    channel,
    appleReports: { status: listing.status, matches: reports, unreadableCount,
      candidateFiles: candidates.length, skippedLargeReports,
      mayHaveMore: candidates.length > MAX_CANDIDATES || reports.length === MAX_REPORTS },
    localCapture: await Promise.all((channel === "all" ? ["stable", "dev"] : [channel])
      .map(async (profile) => ({ profile, ...await inspectCapture(homeDirectory, uid, profile) }))),
    note: "Read-only local summary. No app launch, network request, or raw report upload. A stored preference does not prove capture was active at crash time. Absence of a report does not rule out a crash.",
  };
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
  lines.push(result.note);
  return `${lines.join("\n")}\n`;
}

function parseArguments(argv) {
  let hours = 168;
  let json = false;
  let channel = "stable";
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--json" && !json) json = true;
    else if (argv[index] === "--channel" && ["stable", "dev", "all"].includes(argv[index + 1])) {
      channel = argv[++index];
    } else if (argv[index] === "--hours" && index + 1 < argv.length
      && /^(?:[1-9]|[1-9][0-9]{1,2})$/u.test(argv[index + 1])) {
      hours = Number(argv[++index]);
      if (hours > 720) throw new TypeError("invalid arguments");
    } else throw new TypeError("invalid arguments");
  }
  return { hours, json, channel };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await diagnoseDesktopCrash(options);
    process.stdout.write(options.json
      ? `${JSON.stringify(result, null, 2)}\n` : renderDesktopCrashDiagnosis(result));
  } catch {
    process.stderr.write("Crash doctor could not complete. Use --hours 1..720, --channel stable|dev|all, and optional --json.\n");
    process.exitCode = 1;
  }
}
