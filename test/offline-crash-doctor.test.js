import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  diagnoseDesktopCrash,
  exportPrivateCrashEvidence,
  parseAppleCrashReport,
  renderDesktopCrashDiagnosis,
} from "../scripts/diagnose-desktop-crash.mjs";

const IPS = `${JSON.stringify({ app_name: "TiboTattle" })}\n${JSON.stringify({
  procName: "TiboTattle",
  exception: { type: "EXC_BAD_ACCESS", details: "/Users/private/account" },
  termination: { namespace: "SIGNAL", code: 11, indicator: "/Users/private/account" },
  faultingThread: 0,
  threads: [{ frames: [
    { symbol: "ElectronMain" },
    { symbol: "/Users/private/secret.js" },
    { symbol: "abort" },
  ] }],
})}`;

test("Apple IPS parser retains only closed crash fields and safe frame symbols", () => {
  assert.deepEqual(parseAppleCrashReport(IPS, ".ips"), {
    processKind: "app",
    exceptionType: "EXC_BAD_ACCESS",
    terminationNamespace: "SIGNAL",
    terminationCode: "11",
    topFrames: ["ElectronMain", "unavailable", "abort"],
  });
  assert.equal(parseAppleCrashReport(IPS.replaceAll("TiboTattle", "OtherApp"), ".ips"), null);
  assert.equal(parseAppleCrashReport("{invalid", ".ips"), null);
  const verbose = parseAppleCrashReport(IPS, ".ips", { verbose: true });
  assert.equal(verbose.reportFormat, "ips");
  assert.equal(verbose.appVersion, null);
  assert.equal(verbose.crashedThreadIndex, 0);
});

test("verbose Apple parsing expands only bounded frames and validated version fields", () => {
  const report = `${JSON.stringify({ app_name: "TiboTattle" })}\n${JSON.stringify({
    procName: "TiboTattle",
    exception: { type: "EXC_CRASH" }, termination: { namespace: "SIGNAL", code: 6 },
    bundleInfo: { CFBundleShortVersionString: "0.1.23" },
    osVersion: { train: "macOS 26.7" },
    faultingThread: 0,
    threads: [{ frames: Array.from({ length: 25 }, (_, index) => ({ symbol: `Frame${index}` })) }],
  })}`;
  assert.equal(parseAppleCrashReport(report, ".ips").topFrames.length, 5);
  const verbose = parseAppleCrashReport(report, ".ips", { verbose: true });
  assert.equal(verbose.topFrames.length, 20);
  assert.equal(verbose.topFrames.at(-1), "Frame19");
  assert.equal(verbose.appVersion, "0.1.23");
  assert.equal(verbose.osVersion, "macOS 26.7");
});

test("explicit private export copies only bounded app evidence into a new owner-only directory", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "tibotattle-private-doctor-"));
  try {
    const reports = join(homeDirectory, "Library", "Logs", "DiagnosticReports");
    const state = join(homeDirectory, "Library", "Application Support", "TiboTattle", "companion-state");
    const dumps = join(homeDirectory, "Library", "Application Support", "TiboTattle", "Crashpad", "pending");
    await Promise.all([mkdir(reports, { recursive: true }), mkdir(state, { recursive: true }),
      mkdir(dumps, { recursive: true })]);
    await writeFile(join(reports, "TiboTattle-2026-09-21.ips"), IPS);
    await writeFile(join(reports, "OtherApp-2026-09-21.ips"), IPS);
    await symlink(join(reports, "TiboTattle-2026-09-21.ips"), join(reports, "TiboTattle-link.ips"));
    await writeFile(join(state, "diagnostics-v0.1.log"), "synthetic private log\n", { mode: 0o600 });
    await writeFile(join(dumps, "synthetic.dmp"), Buffer.from("synthetic private memory"), { mode: 0o600 });
    for (let index = 1; index <= 4; index += 1) {
      await writeFile(join(dumps, `synthetic-${index}.dmp`),
        Buffer.from("synthetic private memory"), { mode: 0o600 });
    }

    const directory = join(homeDirectory, "private-evidence");
    const basic = await exportPrivateCrashEvidence({ directory, homeDirectory, platform: "darwin", hours: 1 });
    assert.deepEqual({ status: basic.status, includedFiles: basic.includedFiles, includedDumps: basic.includedDumps },
      { status: "created", includedFiles: 2, includedDumps: 0 });
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(directory, "apple-report-01.ips"))).mode & 0o777, 0o600);
    assert.equal(await readFile(join(directory, "apple-report-01.ips"), "utf8"), IPS);
    assert.equal(await readFile(join(directory, "companion-stable-current.log"), "utf8"),
      "synthetic private log\n");
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    assert.equal(manifest.includesCrashpadDumps, false);
    assert.deepEqual(manifest.files.map((file) => file.name),
      ["apple-report-01.ips", "companion-stable-current.log"]);
    assert.doesNotMatch(JSON.stringify(manifest), /private memory|\/Users\/private|TiboTattle-link/u);
    await assert.rejects(exportPrivateCrashEvidence({ directory, homeDirectory, platform: "darwin", hours: 1 }));

    const withDumps = join(homeDirectory, "private-with-dumps");
    const complete = await exportPrivateCrashEvidence({
      directory: withDumps, homeDirectory, platform: "darwin", hours: 1, includeDumps: true,
    });
    assert.equal(complete.includedDumps, 4);
    assert.ok(complete.skippedFiles >= 1);
    assert.deepEqual(await readFile(join(withDumps, "crashpad-stable-pending-01.dmp")),
      Buffer.from("synthetic private memory"));
    await assert.rejects(exportPrivateCrashEvidence({
      directory: join(process.cwd(), "private-evidence"), homeDirectory, platform: "darwin", hours: 1,
    }), /private destination is invalid/u);
    const linkedParent = join(homeDirectory, "linked-parent");
    await symlink(homeDirectory, linkedParent);
    await assert.rejects(exportPrivateCrashEvidence({
      directory: join(linkedParent, "private-evidence"), homeDirectory, platform: "darwin", hours: 1,
    }), /private destination parent is unsafe/u);
    if (process.platform === "darwin") {
      const cliDirectory = join(homeDirectory, "cli-private-evidence");
      const cli = spawnSync(process.execPath, [
        fileURLToPath(new URL("../scripts/diagnose-desktop-crash.mjs", import.meta.url)),
        "--hours", "1", "--verbose", "--json", "--export-private", cliDirectory,
      ], { env: { ...process.env, HOME: homeDirectory }, encoding: "utf8" });
      assert.equal(cli.status, 0, cli.stderr);
      const output = JSON.parse(cli.stdout);
      assert.equal(output.privateEvidence.status, "created");
      assert.equal(output.privateEvidence.includedDumps, 0);
      assert.doesNotMatch(cli.stdout, /\/Users\/private|synthetic private memory|cli-private-evidence/u);
      assert.equal(await readFile(join(cliDirectory, "apple-report-01.ips"), "utf8"), IPS);
    }
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("private export preserves a matching Apple report when its body is not yet parseable", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "tibotattle-private-doctor-"));
  try {
    const reports = join(homeDirectory, "Library", "Logs", "DiagnosticReports");
    await mkdir(reports, { recursive: true });
    const raw = `${JSON.stringify({ app_name: "TiboTattle" })}\n{new-apple-format`;
    await writeFile(join(reports, "TiboTattle-new-format.ips"), raw);
    const directory = join(homeDirectory, "private-evidence");
    const result = await exportPrivateCrashEvidence({
      directory, homeDirectory, platform: "darwin", hours: 1,
    });
    assert.equal(result.unparsedReportsIncluded, 1);
    assert.equal(result.includedFiles, 1);
    assert.equal(await readFile(join(directory, "apple-report-01.ips"), "utf8"), raw);
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    assert.equal(manifest.unparsedReportsIncluded, 1);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("private export includes the startup journal when the companion never started", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "tibotattle-private-doctor-"));
  try {
    const settings = join(homeDirectory, "Library", "Application Support", "TiboTattle",
      "desktop-settings");
    await mkdir(settings, { recursive: true, mode: 0o700 });
    const startup = `${JSON.stringify({
      schemaVersion: "tibotattle-electron-startup-diagnostic-v1",
      recordedAt: "2026-09-22T14:00:01.000Z",
      startedAt: "2026-09-22T14:00:00.000Z",
      phase: "settings",
      outcome: "failed",
      code: "electron_shell_desktop_codex_roots_invalid",
      platform: "darwin",
      architecture: "arm64",
      version: "0.1.24",
    })}\n`;
    await writeFile(join(settings, "startup-diagnostic-v1.json"), startup, { mode: 0o600 });
    const directory = join(homeDirectory, "private-evidence");
    const result = await exportPrivateCrashEvidence({
      directory, homeDirectory, platform: "darwin", hours: 1,
    });
    assert.equal(result.includedFiles, 1);
    assert.equal(await readFile(join(directory, "startup-stable.json"), "utf8"), startup);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("legacy crash parser selects crashed-thread frames without report paths", () => {
  const raw = `Process: TiboTattle [123]\nException Type: EXC_CRASH (SIGABRT)\nTermination Reason: Namespace SIGNAL, Code 6 Abort trap: 6\nTriggered by Thread: 1\nThread 0:\n0 libSystem 0x123456 Other + 1\nThread 1 Crashed:\n0 TiboTattle 0x123456 TiboStart + 12\n1 libSystem 0x123457 /Users/private/secret + 4\n\nBinary Images:\n/Users/private/account\n`;
  assert.deepEqual(parseAppleCrashReport(raw, ".crash"), {
    processKind: "app",
    exceptionType: "EXC_CRASH",
    terminationNamespace: "SIGNAL",
    terminationCode: "6",
    topFrames: ["TiboStart", "unavailable"],
  });
});

test("offline doctor reads synthetic user reports and preference, never launches app or includes raw text", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "tibotattle-offline-doctor-"));
  try {
    const reports = join(homeDirectory, "Library", "Logs", "DiagnosticReports");
    const settings = join(homeDirectory, "Library", "Application Support", "TiboTattle", "desktop-settings");
    await mkdir(reports, { recursive: true });
    await mkdir(settings, { recursive: true });
    await writeFile(join(reports, "TiboTattle-2026-09-21.ips"), IPS);
    await writeFile(join(reports, "TiboTattle-large.ips"), Buffer.alloc(4 * 1024 * 1024 + 1));
    await writeFile(join(reports, "OtherApp-2026-09-21.ips"), IPS);
    await writeFile(join(settings, "crash-capture-v1.json"),
      '{"schemaVersion":"tibotattle-electron-crash-capture-v1","enabled":true}\n');
    await writeFile(join(settings, "startup-diagnostic-v1.json"), `${JSON.stringify({
      schemaVersion: "tibotattle-electron-startup-diagnostic-v1",
      recordedAt: "2026-09-22T14:00:01.000Z",
      startedAt: "2026-09-22T14:00:00.000Z",
      phase: "native_handover",
      outcome: "failed",
      code: "secure_storage_locked",
      platform: "darwin",
      architecture: "arm64",
      version: "0.1.24",
    })}\n`, { mode: 0o600 });
    await symlink(join(reports, "TiboTattle-2026-09-21.ips"), join(reports, "TiboTattle-link.ips"));
    const result = await diagnoseDesktopCrash({
      homeDirectory, platform: "darwin", now: Date.now(), hours: 1,
    });
    assert.equal(result.appleReports.matches.length, 1);
    assert.equal(result.appleReports.candidateFiles, 1);
    assert.equal(result.appleReports.skippedLargeReports, 1);
    assert.match(result.appleReports.matches[0].reportModifiedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(result.channel, "stable");
    assert.equal(result.localCapture[0].capturePreference, "enabled_preference");
    assert.equal(result.startupDiagnostics[0].status, "available");
    assert.equal(result.startupDiagnostics[0].record.phase, "native_handover");
    const output = renderDesktopCrashDiagnosis(result);
    assert.match(output, /EXC_BAD_ACCESS/u);
    assert.match(output, /ElectronMain, unavailable, abort/u);
    assert.match(output, /failed at native_handover; code secure_storage_locked/u);
    assert.doesNotMatch(output, /private|secret|account|\.ips|TiboTattle-link/u);
    assert.doesNotMatch(JSON.stringify(result), /private|secret|account|\.ips|TiboTattle-link/u);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("stable and development app crash reports stay separate", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "tibotattle-offline-doctor-"));
  try {
    const reports = join(homeDirectory, "Library", "Logs", "DiagnosticReports");
    const devSettings = join(homeDirectory, "Library", "Application Support", "TiboTattle Dev", "desktop-settings");
    await mkdir(reports, { recursive: true });
    await mkdir(devSettings, { recursive: true });
    await writeFile(join(reports, "TiboTattle-2026-09-21.ips"), IPS);
    await writeFile(join(reports, "TiboTattle Dev-2026-09-21.ips"),
      IPS.replaceAll("TiboTattle", "TiboTattle Dev"));
    await writeFile(join(devSettings, "crash-capture-v1.json"), "{corrupt");
    const stable = await diagnoseDesktopCrash({ homeDirectory, platform: "darwin", hours: 1 });
    const dev = await diagnoseDesktopCrash({ homeDirectory, platform: "darwin", hours: 1, channel: "dev" });
    assert.deepEqual(stable.appleReports.matches.map((report) => report.processKind), ["app"]);
    assert.deepEqual(dev.appleReports.matches.map((report) => report.processKind), ["development_app"]);
    assert.equal(stable.localCapture[0].capturePreference, "missing");
    assert.equal(dev.localCapture[0].capturePreference, "invalid");
    assert.deepEqual((await diagnoseDesktopCrash({ homeDirectory, platform: "darwin", hours: 1, channel: "all" }))
      .localCapture.map((item) => item.profile), ["stable", "dev"]);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("offline doctor reports missing Apple evidence honestly", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "tibotattle-offline-doctor-"));
  try {
    const result = await diagnoseDesktopCrash({ homeDirectory, platform: "darwin" });
    assert.equal(result.appleReports.status, "missing");
    assert.deepEqual(result.appleReports.matches, []);
    assert.equal(result.localCapture[0].capturePreference, "missing");
    assert.match(renderDesktopCrashDiagnosis(result), /Absence of a report does not rule out a crash/u);
    assert.deepEqual(await diagnoseDesktopCrash({ platform: "linux" }), {
      schemaVersion: "tibotattle-offline-crash-doctor-v3", status: "unsupported_platform",
    });
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("offline doctor accepts a content-free unknown startup version", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "tibotattle-doctor-"));
  try {
    const settings = join(homeDirectory, "Library", "Application Support", "TiboTattle",
      "desktop-settings");
    await mkdir(settings, { recursive: true, mode: 0o700 });
    await writeFile(join(settings, "startup-diagnostic-v1.json"), `${JSON.stringify({
      schemaVersion: "tibotattle-electron-startup-diagnostic-v1",
      recordedAt: "2026-09-22T14:00:01.000Z",
      startedAt: "2026-09-22T14:00:00.000Z",
      phase: "runtime_paths",
      outcome: "failed",
      code: "startup_unclassified",
      platform: "darwin",
      architecture: "arm64",
      version: "unknown",
    })}\n`, { mode: 0o600 });
    const result = await diagnoseDesktopCrash({
      homeDirectory, platform: "darwin", now: Date.now(), hours: 1,
    });
    assert.equal(result.startupDiagnostics[0].status, "available");
    assert.equal(result.startupDiagnostics[0].record.version, "unknown");
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("verbose mode reads only validated companion diagnostic notes", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "tibotattle-offline-doctor-"));
  try {
    const state = join(homeDirectory, "Library", "Application Support", "TiboTattle", "companion-state");
    await mkdir(state, { recursive: true });
    const recordedAt = new Date().toISOString();
    const safe = {
      schemaVersion: "local-diagnostic-note-v0.1", recordedAt,
      reference: "TT-7QF3K2", surface: "local_refresh",
      code: "refresh_in_progress", requestId: "",
      step: "data_store", detail: "snapshot_unavailable",
      measurements: { baselineRssMib: 300, observedRssMib: 450, ceilingRssMib: 500 },
    };
    await writeFile(join(state, "diagnostics-v0.1.log"), [
      JSON.stringify(safe),
      JSON.stringify({ ...safe, code: "/Users/private/secret" }),
      JSON.stringify({ ...safe, privatePath: "/Users/private/secret" }),
      "",
    ].join("\n"), { mode: 0o600 });
    const summary = await diagnoseDesktopCrash({ homeDirectory, platform: "darwin", hours: 1 });
    assert.equal(Object.hasOwn(summary, "diagnosticNotes"), false);
    const verbose = await diagnoseDesktopCrash({ homeDirectory, platform: "darwin", hours: 1, verbose: true });
    assert.equal(verbose.mode, "verbose");
    assert.equal(verbose.diagnosticNotes[0].status, "available");
    assert.equal(verbose.diagnosticNotes[0].invalidLines, 2);
    assert.equal(verbose.diagnosticNotes[0].notes.length, 1);
    assert.equal(verbose.diagnosticNotes[0].notes[0].baselineRssMib, 300);
    const output = renderDesktopCrashDiagnosis(verbose);
    assert.match(output, /TT-7QF3K2 local_refresh refresh_in_progress/u);
    assert.match(output, /rss_mib=300\/450\/500/u);
    assert.doesNotMatch(output, /private|secret|\/Users/u);
    assert.doesNotMatch(JSON.stringify(verbose), /private|secret|\/Users/u);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});
