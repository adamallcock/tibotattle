#!/usr/bin/env node
import { spawnSync } from "node:child_process";
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
}) {
  const command = denyNetwork ? "/usr/bin/sandbox-exec" : launcher;
  const commandArgs = denyNetwork
    ? [
        "-p",
        "(version 1) (allow default) (deny network*)",
        launcher,
        ...args,
      ]
    : args;
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    env: {
      HOME: home,
      TMPDIR: temporaryDirectory,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    },
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(
      `Artifact command failed (${args[0]}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
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
  let output = null;
  let denyNetwork = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root") {
      artifactRoot = resolve(argv[++index] ?? "");
    } else if (arg === "--output") {
      output = resolve(argv[++index] ?? "");
    } else if (arg === "--allow-network") {
      denyNetwork = false;
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  if (!artifactRoot || !output) {
    fail("--artifact-root and --output are required");
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
  const launcher = join(artifactRoot, "bin", "usage-monitor-local");
  const canaries = [
    "PRIVATE_SESSION_CANARY",
    "PRIVATE_PROMPT_CANARY",
    "/private/path/canary",
  ];
  const commands = [];
  try {
    await mkdir(home, { mode: 0o700 });
    await chmod(home, 0o700);
    await mkdir(sessions, { recursive: true });
    await mkdir(temporaryDirectory, { recursive: true });
    await chmod(temporaryDirectory, 0o700);
    await mkdir(dirname(activityFile), { recursive: true });
    await writeFile(
      join(sessions, "rollout-2026-07-24T12-00-00-smoke.jsonl"),
      `${fixtureLines().join("\n")}\n`,
      { mode: 0o600 },
    );
    await writeFile(activityFile, "", { mode: 0o600 });

    const run = (args) => {
      const stdout = runArtifact({
        launcher,
        args,
        home,
        temporaryDirectory,
        denyNetwork,
      });
      commands.push(args[0]);
      return stdout;
    };

    run(["inspect-artifact"]);
    run(["install", "--target", installed]);
    const installedLauncher = join(installed, "bin", "usage-monitor-local");
    const originalLauncher = launcher;
    void originalLauncher;
    runArtifact({
      launcher: installedLauncher,
      args: ["doctor", "--secret-file", secretFile],
      home,
      temporaryDirectory,
      denyNetwork,
    });
    commands.push("doctor");
    runArtifact({
      launcher: installedLauncher,
      args: [
        "inspect-export",
        "--since", "2026-07-24T11:59:00.000Z",
        "--until", "2026-07-24T12:10:00.000Z",
        "--codex-home", codexHome,
        "--activity-file", activityFile,
        "--secret-file", secretFile,
      ],
      home,
      temporaryDirectory,
      denyNetwork,
    });
    commands.push("inspect-export");
    runArtifact({
      launcher: installedLauncher,
      args: [
        "export-local",
        "--since", "2026-07-24T11:59:00.000Z",
        "--until", "2026-07-24T12:10:00.000Z",
        "--codex-home", codexHome,
        "--activity-file", activityFile,
        "--secret-file", secretFile,
        "--output", bundle,
        "--receipt", receipt,
      ],
      home,
      temporaryDirectory,
      denyNetwork,
    });
    commands.push("export-local");
    runArtifact({
      launcher: installedLauncher,
      args: ["verify-bundle", "--input", bundle, "--receipt", receipt],
      home,
      temporaryDirectory,
      denyNetwork,
    });
    commands.push("verify-bundle");
    runArtifact({
      launcher: installedLauncher,
      args: [
        "export-set",
        "--workspace", workspace,
        "--directory", exportSet,
        "--since", "2026-07-24T11:59:00.000Z",
        "--until", "2026-07-24T12:10:00.000Z",
        "--codex-home", codexHome,
        "--activity-file", activityFile,
        "--secret-file", secretFile,
      ],
      home,
      temporaryDirectory,
      denyNetwork,
    });
    commands.push("export-set");
    runArtifact({
      launcher: installedLauncher,
      args: ["verify-export-set", "--directory", exportSet],
      home,
      temporaryDirectory,
      denyNetwork,
    });
    commands.push("verify-export-set");
    const deletionPreflight = runArtifact({
      launcher: installedLauncher,
      args: [
        "delete-local-export",
        "--workspace", workspace,
        "--directory", exportSet,
      ],
      home,
      temporaryDirectory,
      denyNetwork,
    });
    commands.push("delete-local-export-preflight");
    runArtifact({
      launcher: installedLauncher,
      args: [
        "delete-local-export",
        "--workspace", workspace,
        "--directory", exportSet,
        "--confirm-deletion", confirmation(deletionPreflight, "Deletion preflight"),
      ],
      home,
      temporaryDirectory,
      denyNetwork,
    });
    commands.push("delete-local-export-confirmed");

    const bundleBytes = await readFile(bundle);
    const receiptBytes = await readFile(receipt);
    const serialized = Buffer.concat([bundleBytes, receiptBytes]).toString("utf8");
    if (canaries.some((value) => serialized.includes(value))) {
      fail("Private source canary escaped into a local export");
    }
    const uninstallPreflight = runArtifact({
      launcher: installedLauncher,
      args: ["uninstall", "--target", installed],
      home,
      temporaryDirectory,
      denyNetwork,
    });
    commands.push("uninstall-preflight");
    runArtifact({
      launcher: installedLauncher,
      args: [
        "uninstall",
        "--target", installed,
        "--confirm-uninstall", confirmation(uninstallPreflight, "Uninstall preflight"),
      ],
      home,
      temporaryDirectory,
      denyNetwork,
    });
    commands.push("uninstall-confirmed");
    if (!await missing(installed)) fail("Installed target remained after uninstall");
    if (await missing(secretFile)) fail("Participant identity was removed by uninstall");

    const result = {
      schemaVersion: "usage-monitor-local-review-artifact-smoke-v0.1",
      artifact: basename(artifactRoot),
      platform: `${process.platform}-${process.arch}`,
      runtime: process.version,
      denyNetwork,
      networkAttemptTelemetry: "not_measured",
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
    await writeFile(output, stableJson(result), { mode: 0o600 });
    console.log(`Artifact smoke: ${result.result}`);
    console.log(`Commands: ${result.commandCount}`);
    console.log(`Deny network: ${result.denyNetwork}; attempt telemetry: ${result.networkAttemptTelemetry}`);
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
