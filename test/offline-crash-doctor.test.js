import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  diagnoseDesktopCrash,
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
    const output = renderDesktopCrashDiagnosis(result);
    assert.match(output, /EXC_BAD_ACCESS/u);
    assert.match(output, /ElectronMain, unavailable, abort/u);
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
      schemaVersion: "tibotattle-offline-crash-doctor-v1", status: "unsupported_platform",
    });
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});
