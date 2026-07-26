#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  lstatSync,
  readFileSync,
} from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NETWORK_AUDIT_PRELOAD = fileURLToPath(
  new URL("./local-review-network-audit-preload.cjs", import.meta.url),
);
const NETWORK_AUDIT_SCHEMA =
  "usage-monitor-local-review-network-attempt-process-v0.1";
const NETWORK_AUDIT_INSTRUMENTATION = "node-api-interposition-v0.1";
const NETWORK_AUDIT_COVERAGE = Object.freeze({
  tcpClient: true,
  tcpServer: true,
  tls: true,
  dnsCallback: true,
  dnsPromise: true,
  http1: true,
  http2: true,
  udp: true,
  fetch: true,
  webSocket: true,
  eventSource: true,
  quic: false,
  nativeSyscalls: false,
  nonNodeChildProcesses: false,
});
const NATIVE_NETWORK_AUDIT_SCHEMA =
  "usage-monitor-native-network-attempt-process-v0.1";
const NATIVE_NETWORK_AUDIT_INSTRUMENTATION =
  "macos-dyld-libc-interposition-v0.1";
const NATIVE_NETWORK_AUDIT_CATEGORIES = Object.freeze([
  "accept",
  "bind",
  "connect",
  "getaddrinfo",
  "gethostbyname",
  "gethostbyname2",
  "getnameinfo",
  "listen",
  "recv",
  "recvfrom",
  "recvmsg",
  "send",
  "sendmsg",
  "sendto",
  "socketInet",
  "socketInet6",
]);
const NATIVE_NETWORK_AUDIT_COVERAGE = Object.freeze({
  ipSocketLibc: true,
  dnsLibc: true,
  directSyscallInstruction: false,
  quicFramework: false,
  nonNodeChildProcesses: false,
});

function fail(message) {
  throw new Error(message);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function usage(input, output, cached, reasoning) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

function fixtureLines() {
  const total = usage(100, 20, 40, 8);
  return [
    JSON.stringify({
      timestamp: "2026-07-24T12:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "PRIVATE_SESSION_CANARY",
        cwd: "/private/path/canary",
        source: "user",
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:00:00.001Z",
      type: "turn_context",
      payload: {
        model: "gpt-5.6-sol",
        user_prompt: "PRIVATE_PROMPT_CANARY",
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:00:00.002Z",
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_settings: { service_tier: "priority" },
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-24T12:02:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: total,
          last_token_usage: total,
          prompt: "PRIVATE_PROMPT_CANARY",
        },
        rate_limits: {
          limit_id: "codex",
          plan_type: "pro",
          primary: {
            used_percent: 12,
            window_minutes: 300,
            resets_at: 1784912400,
          },
          secondary: {
            used_percent: 6,
            window_minutes: 10080,
            resets_at: 1785430800,
          },
        },
      },
    }),
  ];
}

function runArtifact({
  launcher,
  args,
  home,
  temporaryDirectory,
  denyNetwork,
  auditFile,
  nativeAuditFile = null,
  nativeAuditLibrary = null,
  directRuntime = false,
}) {
  const artifactRoot = dirname(dirname(launcher));
  const runtimeCommand = directRuntime
    ? join(artifactRoot, "runtime", "bin", "node")
    : launcher;
  const runtimeArgs = directRuntime
    ? [join(artifactRoot, "local-review", "cli.js"), ...args]
    : args;
  if (Boolean(nativeAuditFile) !== Boolean(nativeAuditLibrary)) {
    fail("Native audit file and library must be configured together");
  }
  const command = denyNetwork ? "/usr/bin/sandbox-exec" : runtimeCommand;
  const commandArgs = denyNetwork
    ? [
        "-p",
        "(version 1) (allow default) (deny network*)",
        ...(nativeAuditLibrary
          ? [
            "/usr/bin/env",
            `DYLD_INSERT_LIBRARIES=${nativeAuditLibrary}`,
            `USAGE_MONITOR_NATIVE_NETWORK_AUDIT_FILE=${nativeAuditFile}`,
          ]
          : []),
        runtimeCommand,
        ...runtimeArgs,
      ]
    : runtimeArgs;
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    env: {
      HOME: home,
      TMPDIR: temporaryDirectory,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      NODE_OPTIONS: `--require=${NETWORK_AUDIT_PRELOAD}`,
      USAGE_MONITOR_NETWORK_AUDIT_FILE: auditFile,
      ...(nativeAuditLibrary && !denyNetwork
        ? {
          DYLD_INSERT_LIBRARIES: nativeAuditLibrary,
          USAGE_MONITOR_NATIVE_NETWORK_AUDIT_FILE: nativeAuditFile,
        }
        : {}),
    },
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const audit = readNetworkAuditReceipt(auditFile);
  const nativeAudit = nativeAuditFile
    ? readNativeNetworkAuditReceipt(nativeAuditFile)
    : null;
  if (result.status !== 0) {
    fail(
      `Artifact command failed (${args[0]}): ${result.stderr || result.stdout}`,
    );
  }
  if (audit.totalAttempts !== 0) {
    fail(
      `Artifact command attempted a JavaScript networking API (${args[0]}): `
      + Object.keys(audit.byCategory).join(", "),
    );
  }
  if (nativeAudit && nativeAudit.totalAttempts !== 0) {
    fail(
      `Artifact command attempted a native libc networking API (${args[0]}): `
      + Object.entries(nativeAudit.byCategory)
        .filter(([, count]) => count > 0)
        .map(([category]) => category)
        .join(", "),
    );
  }
  return { stdout: result.stdout, audit, nativeAudit };
}

function readNetworkAuditReceipt(path) {
  let metadata;
  let value;
  try {
    metadata = lstatSync(path);
    if (metadata.size > 32 * 1024) {
      fail("Artifact network audit receipt exceeded its fixed size limit");
    }
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`Artifact process did not produce a valid network audit receipt: ${error.message}`);
  }
  if (!metadata.isFile()
      || metadata.isSymbolicLink()
      || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
    fail("Artifact network audit receipt was not an owner-only regular file");
  }
  if (value?.schemaVersion !== NETWORK_AUDIT_SCHEMA
      || value?.instrumentation !== NETWORK_AUDIT_INSTRUMENTATION
      || !Number.isSafeInteger(value?.totalAttempts)
      || value.totalAttempts < 0
      || value?.truncated !== false
      || value?.maximumRecordedAttempts !== 128
      || value?.byCategory === null
      || typeof value?.byCategory !== "object"
      || Array.isArray(value.byCategory)) {
    fail("Artifact network audit receipt did not match its closed process contract");
  }
  const categoryTotal = Object.entries(value.byCategory).reduce(
    (sum, [category, count]) => {
      if (!/^[a-z][a-z0-9.]*$/u.test(category)
          || !Number.isSafeInteger(count)
          || count <= 0) {
        fail("Artifact network audit receipt contained an invalid category count");
      }
      return sum + count;
    },
    0,
  );
  if (Object.keys(value.byCategory).length > 32) {
    fail("Artifact network audit receipt contained too many categories");
  }
  if (categoryTotal !== value.totalAttempts) {
    fail("Artifact network audit receipt category counts did not match its total");
  }
  const coverageKeys = Object.keys(NETWORK_AUDIT_COVERAGE);
  if (value?.coverage === null
      || typeof value?.coverage !== "object"
      || Array.isArray(value.coverage)
      || Object.keys(value.coverage).sort().join("\n")
        !== [...coverageKeys].sort().join("\n")
      || coverageKeys.some(
        (key) => value.coverage[key] !== NETWORK_AUDIT_COVERAGE[key],
      )) {
    fail("Artifact network audit receipt coverage did not match the smoke contract");
  }
  return value;
}

function readNativeNetworkAuditReceipt(path) {
  let metadata;
  let value;
  try {
    metadata = lstatSync(path);
    if (metadata.size > 32 * 1024) {
      fail("Native network audit receipt exceeded its fixed size limit");
    }
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`Artifact process did not produce a valid native audit receipt: ${error.message}`);
  }
  if (!metadata.isFile()
      || metadata.isSymbolicLink()
      || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
    fail("Native network audit receipt was not an owner-only regular file");
  }
  if (value?.schemaVersion !== NATIVE_NETWORK_AUDIT_SCHEMA
      || value?.instrumentation !== NATIVE_NETWORK_AUDIT_INSTRUMENTATION
      || !Number.isSafeInteger(value?.totalAttempts)
      || value.totalAttempts < 0
      || value?.byCategory === null
      || typeof value?.byCategory !== "object"
      || Array.isArray(value.byCategory)
      || Object.keys(value.byCategory).sort().join("\n")
        !== [...NATIVE_NETWORK_AUDIT_CATEGORIES].sort().join("\n")) {
    fail("Native network audit receipt did not match its closed process contract");
  }
  const categoryTotal = NATIVE_NETWORK_AUDIT_CATEGORIES.reduce(
    (sum, category) => {
      const count = value.byCategory[category];
      if (!Number.isSafeInteger(count) || count < 0) {
        fail("Native network audit receipt contained an invalid category count");
      }
      return sum + count;
    },
    0,
  );
  if (categoryTotal !== value.totalAttempts) {
    fail("Native network audit receipt category counts did not match its total");
  }
  const coverageKeys = Object.keys(NATIVE_NETWORK_AUDIT_COVERAGE);
  if (value?.coverage === null
      || typeof value?.coverage !== "object"
      || Array.isArray(value.coverage)
      || Object.keys(value.coverage).sort().join("\n")
        !== [...coverageKeys].sort().join("\n")
      || coverageKeys.some(
        (key) => value.coverage[key] !== NATIVE_NETWORK_AUDIT_COVERAGE[key],
      )) {
    fail("Native network audit receipt coverage did not match the smoke contract");
  }
  return value;
}

function confirmation(output, label) {
  const match = output.match(/^Confirmation token: ([A-Z0-9]+)$/m);
  if (!match) fail(`${label} did not return a confirmation token`);
  return match[1];
}

async function missing(path) {
  try {
    await access(path);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

async function main(argv) {
  let artifactRoot = null;
  let archive = null;
  let nativeAuditLibrary = null;
  let output = null;
  let denyNetwork = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root") {
      artifactRoot = resolve(argv[++index] ?? "");
    } else if (arg === "--archive") {
      archive = resolve(argv[++index] ?? "");
    } else if (arg === "--native-audit-library") {
      nativeAuditLibrary = resolve(argv[++index] ?? "");
    } else if (arg === "--output") {
      output = resolve(argv[++index] ?? "");
    } else if (arg === "--allow-network") {
      denyNetwork = false;
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  if (!artifactRoot || !archive || !nativeAuditLibrary || !output) {
    fail(
      "--artifact-root, --archive, --native-audit-library, and --output are required",
    );
  }
  if (dirname(artifactRoot) !== dirname(archive)
      || basename(archive) !== `${basename(artifactRoot)}.tar`) {
    fail("--archive must be the artifact root's sibling deterministic tar");
  }
  const archiveMetadata = lstatSync(archive);
  if (!archiveMetadata.isFile()
      || archiveMetadata.isSymbolicLink()
      || archiveMetadata.size <= 0
      || archiveMetadata.size > 512 * 1024 * 1024) {
    fail("--archive must be a bounded regular file");
  }
  const nativeAuditMetadata = lstatSync(nativeAuditLibrary);
  if (!nativeAuditMetadata.isFile()
      || nativeAuditMetadata.isSymbolicLink()
      || nativeAuditMetadata.size <= 0
      || nativeAuditMetadata.size > 4 * 1024 * 1024
      || (process.platform !== "win32" && (nativeAuditMetadata.mode & 0o077) !== 0)) {
    fail("--native-audit-library must be a bounded owner-only regular file");
  }

  const root = await realpath(await mkdtemp(join(tmpdir(), "usage-monitor-artifact-smoke-")));
  const home = join(root, "home");
  const temporaryDirectory = join(root, "tmp");
  const codexHome = join(home, ".codex");
  const sessions = join(codexHome, "sessions");
  const activityFile = join(home, "activity.jsonl");
  const secretFile = join(home, "identity", "secret");
  const bundle = join(home, "export", "bundle.json");
  const receipt = `${bundle}.privacy-receipt.json`;
  const workspace = join(home, "set-workspace");
  const exportSet = join(home, "export-set");
  const installed = join(home, "installed");
  const networkAudits = join(root, "network-audits");
  const launcher = join(artifactRoot, "bin", "usage-monitor-local");
  const canaries = [
    "PRIVATE_SESSION_CANARY",
    "PRIVATE_PROMPT_CANARY",
    "/private/path/canary",
  ];
  const commands = [];
  const audits = [];
  const nativeAudits = [];
  let auditSequence = 0;
  try {
    await mkdir(home, { mode: 0o700 });
    await chmod(home, 0o700);
    await mkdir(sessions, { recursive: true });
    await mkdir(temporaryDirectory, { recursive: true });
    await chmod(temporaryDirectory, 0o700);
    await mkdir(networkAudits, { mode: 0o700 });
    await mkdir(dirname(activityFile), { recursive: true });
    await writeFile(
      join(sessions, "rollout-2026-07-24T12-00-00-smoke.jsonl"),
      `${fixtureLines().join("\n")}\n`,
      { mode: 0o600 },
    );
    await writeFile(activityFile, "", { mode: 0o600 });

    const invoke = (activeLauncher, args, label = args[0]) => {
      auditSequence += 1;
      const sequence = String(auditSequence).padStart(3, "0");
      const result = runArtifact({
        launcher: activeLauncher,
        args,
        home,
        temporaryDirectory,
        denyNetwork,
        auditFile: join(networkAudits, `process-${sequence}.json`),
        nativeAuditFile: join(networkAudits, `native-process-${sequence}.json`),
        nativeAuditLibrary,
        directRuntime: true,
      });
      commands.push(label);
      audits.push(result.audit);
      nativeAudits.push(result.nativeAudit);
      return result.stdout;
    };

    const launcherParity = runArtifact({
      launcher,
      args: ["inspect-artifact"],
      home,
      temporaryDirectory,
      denyNetwork,
      auditFile: join(networkAudits, "launcher-parity.json"),
    });
    if (launcherParity.audit.totalAttempts !== 0) {
      fail("Artifact launcher parity process attempted a JavaScript networking API");
    }

    invoke(launcher, ["inspect-artifact"]);
    invoke(launcher, ["install", "--target", installed]);
    const installedLauncher = join(installed, "bin", "usage-monitor-local");
    invoke(installedLauncher, ["doctor", "--secret-file", secretFile]);
    invoke(installedLauncher, [
        "inspect-export",
        "--since", "2026-07-24T11:59:00.000Z",
        "--until", "2026-07-24T12:10:00.000Z",
        "--codex-home", codexHome,
        "--activity-file", activityFile,
        "--secret-file", secretFile,
    ]);
    invoke(installedLauncher, [
        "export-local",
        "--since", "2026-07-24T11:59:00.000Z",
        "--until", "2026-07-24T12:10:00.000Z",
        "--codex-home", codexHome,
        "--activity-file", activityFile,
        "--secret-file", secretFile,
        "--output", bundle,
        "--receipt", receipt,
    ]);
    invoke(
      installedLauncher,
      ["verify-bundle", "--input", bundle, "--receipt", receipt],
    );
    invoke(installedLauncher, [
        "export-set",
        "--workspace", workspace,
        "--directory", exportSet,
        "--since", "2026-07-24T11:59:00.000Z",
        "--until", "2026-07-24T12:10:00.000Z",
        "--codex-home", codexHome,
        "--activity-file", activityFile,
        "--secret-file", secretFile,
    ]);
    invoke(
      installedLauncher,
      ["verify-export-set", "--directory", exportSet],
    );
    const deletionPreflight = invoke(installedLauncher, [
        "delete-local-export",
        "--workspace", workspace,
        "--directory", exportSet,
    ], "delete-local-export-preflight");
    invoke(installedLauncher, [
        "delete-local-export",
        "--workspace", workspace,
        "--directory", exportSet,
        "--confirm-deletion", confirmation(deletionPreflight, "Deletion preflight"),
    ], "delete-local-export-confirmed");

    const bundleBytes = await readFile(bundle);
    const receiptBytes = await readFile(receipt);
    const serialized = Buffer.concat([bundleBytes, receiptBytes]).toString("utf8");
    if (canaries.some((value) => serialized.includes(value))) {
      fail("Private source canary escaped into a local export");
    }
    const uninstallPreflight = invoke(
      installedLauncher,
      ["uninstall", "--target", installed],
      "uninstall-preflight",
    );
    invoke(installedLauncher, [
        "uninstall",
        "--target", installed,
        "--confirm-uninstall", confirmation(uninstallPreflight, "Uninstall preflight"),
    ], "uninstall-confirmed");
    if (!await missing(installed)) fail("Installed target remained after uninstall");
    if (await missing(secretFile)) fail("Participant identity was removed by uninstall");

    const result = {
      schemaVersion: "usage-monitor-local-review-artifact-smoke-v0.1",
      artifact: basename(artifactRoot),
      artifactArchiveBytes: archiveMetadata.size,
      artifactArchiveSha256: await sha256File(archive),
      artifactManifestSha256: await sha256File(
        join(artifactRoot, "artifact-manifest.json"),
      ),
      nativeAuditLibrarySha256: await sha256File(nativeAuditLibrary),
      platform: `${process.platform}-${process.arch}`,
      runtime: process.version,
      denyNetwork,
      auditedProcessCount: audits.length,
      javascriptNetworkAttempts: audits.reduce(
        (sum, audit) => sum + audit.totalAttempts,
        0,
      ),
      networkAttemptTelemetry: "node_api_interposition_v0.1",
      networkAttemptCoverage: NETWORK_AUDIT_COVERAGE,
      nativeAuditedProcessCount: nativeAudits.length,
      nativeNetworkLibcAttempts: nativeAudits.reduce(
        (sum, audit) => sum + audit.totalAttempts,
        0,
      ),
      nativeAttemptTelemetry: "macos_dyld_libc_interposition_v0.1",
      nativeAttemptCoverage: NATIVE_NETWORK_AUDIT_COVERAGE,
      nativeNetworkEnforcement: denyNetwork
        ? "sandbox-exec_deny_network"
        : "not_enabled",
      directSyscallInstructionTelemetry: "not_measured",
      launcherParityVerified: true,
      commandCount: commands.length,
      commands,
      localBundleVerified: true,
      exportSetVerified: true,
      completeSetDeletionVerified: true,
      privateCanaryHits: 0,
      installVerified: true,
      uninstallVerified: true,
      participantIdentityPreserved: true,
      secureErasureClaimed: false,
      result: "passed",
    };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, stableJson(result), { mode: 0o600, flag: "wx" });
    console.log(`Artifact smoke: ${result.result}`);
    console.log(`Commands: ${result.commandCount}`);
    console.log(
      `JavaScript network API attempts: ${result.javascriptNetworkAttempts} `
      + `across ${result.auditedProcessCount} processes`,
    );
    console.log(
      `Native libc network attempts: ${result.nativeNetworkLibcAttempts} `
      + `across ${result.nativeAuditedProcessCount} processes`,
    );
    console.log(
      `Native network enforcement: ${result.nativeNetworkEnforcement}; `
      + `direct syscall instruction telemetry: `
      + result.directSyscallInstructionTelemetry,
    );
    console.log("Private canary hits: 0");
    console.log("Identity preserved after uninstall: true");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`smoke-local-review-artifact: ${error.message}`);
  process.exitCode = 1;
});
