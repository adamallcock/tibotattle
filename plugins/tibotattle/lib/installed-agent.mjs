import { execFile as execFileCallback } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const REQUIRED_AGENT_PROTOCOL_VERSION = 1;
export const MINIMUM_AGENT_RELEASE_VERSION = "0.1.23";
export const PLUGIN_STATUS_SCHEMA_VERSION = "tibotattle-plugin-status-v1";

const INSTALLED_STATUS_SCHEMA_VERSION = "tibotattle-installed-agent-status-v1";
const MAX_AGENT_OUTPUT_BYTES = 64 * 1024;
const AGENT_TIMEOUT_MS = 30_000;
const MAX_VERSION_OUTPUT_BYTES = 1024;
const VERSION_TIMEOUT_MS = 5_000;

export class TiboTattlePluginError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TiboTattlePluginError";
    this.code = code;
  }
}

function defaultCandidates({ homeDirectory = homedir(), platform = process.platform } = {}) {
  if (platform !== "darwin") return [];
  return [
    { sourceKind: "macos_system", appPath: "/Applications/TiboTattle.app" },
    { sourceKind: "macos_user", appPath: join(homeDirectory, "Applications", "TiboTattle.app") },
  ];
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function versionTuple(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  return match === null ? null : match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = versionTuple(left);
  const b = versionTuple(right);
  if (a === null || b === null) return 0;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export async function readMacOSBundleVersion(appPath, { execute = execFile } = {}) {
  try {
    const { stdout } = await execute(
      "/usr/bin/plutil",
      [
        "-extract",
        "CFBundleShortVersionString",
        "raw",
        join(appPath, "Contents", "Info.plist"),
      ],
      {
        encoding: "utf8",
        maxBuffer: MAX_VERSION_OUTPUT_BYTES,
        timeout: VERSION_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    const version = typeof stdout === "string" ? stdout.trim() : "";
    if (versionTuple(version) !== null) return version;
  } catch {
    // The fixed error below deliberately omits the private application path.
  }
  throw new TiboTattlePluginError(
    "tibotattle_installation_version_unavailable",
    "An installed TiboTattle application's version could not be verified",
  );
}

export async function locateInstalledTiboTattle({
  candidates = defaultCandidates(),
  exists = pathExists,
  readVersion = readMacOSBundleVersion,
} = {}) {
  const installed = [];
  for (const candidate of candidates) {
    const executable = join(candidate.appPath, "Contents", "MacOS", "TiboTattle");
    const asar = join(candidate.appPath, "Contents", "Resources", "app.asar");
    if (await exists(executable)) {
      const agentAvailable = await exists(asar);
      installed.push({
        sourceKind: candidate.sourceKind,
        executable,
        agentScript: agentAvailable ? join(asar, "apps", "local", "server.js") : null,
        releaseVersion: await readVersion(candidate.appPath),
        candidateOrder: installed.length,
      });
    }
  }
  if (installed.length === 0) return null;
  installed.sort((left, right) => (
    compareVersions(right.releaseVersion, left.releaseVersion)
    || left.candidateOrder - right.candidateOrder
  ));
  const [{ candidateOrder: _candidateOrder, ...selected }] = installed;
  return {
    ...selected,
    detectedInstallations: installed.length,
  };
}

function childEnvironment(environment = process.env) {
  const selected = {
    ELECTRON_RUN_AS_NODE: "1",
  };
  for (const name of [
    "HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
  ]) {
    if (typeof environment[name] === "string") selected[name] = environment[name];
  }
  return selected;
}

export async function executeInstalledAgent(
  installation,
  args,
  { environment = process.env } = {},
) {
  try {
    return await execFile(
      installation.executable,
      [
        installation.agentScript,
        "--agent-protocol",
        String(REQUIRED_AGENT_PROTOCOL_VERSION),
        ...args,
      ],
      {
        encoding: "utf8",
        env: childEnvironment(environment),
        maxBuffer: MAX_AGENT_OUTPUT_BYTES,
        timeout: AGENT_TIMEOUT_MS,
        windowsHide: true,
      },
    );
  } catch (error) {
    if (typeof error?.stdout === "string" && error.stdout.trim().length > 0) {
      return { stdout: error.stdout, stderr: "", failed: true };
    }
    throw new TiboTattlePluginError(
      "tibotattle_agent_unavailable",
      "The installed TiboTattle agent interface is unavailable",
    );
  }
}

function parseAgentResult(execution) {
  const output = execution?.stdout;
  if (typeof output !== "string"
      || Buffer.byteLength(output, "utf8") > MAX_AGENT_OUTPUT_BYTES) {
    throw new TiboTattlePluginError(
      "tibotattle_agent_response_invalid",
      "TiboTattle returned an invalid agent response",
    );
  }
  const lines = output.trim().split("\n");
  if (lines.length !== 1) {
    throw new TiboTattlePluginError(
      "tibotattle_agent_response_invalid",
      "TiboTattle returned an invalid agent response",
    );
  }
  try {
    const result = JSON.parse(lines[0]);
    if (result === null || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result;
  } catch {
    throw new TiboTattlePluginError(
      "tibotattle_agent_response_invalid",
      "TiboTattle returned an invalid agent response",
    );
  }
}

function commandArgs(command, input = {}) {
  if (command === "explain-usage-plans" || command === "status") return [command];
  if (command === "explain-usage") {
    const args = [command, "--plan", input.plan];
    if (input.period !== undefined) args.push("--period", input.period);
    if (input.limit !== undefined) args.push("--limit", String(input.limit));
    if (input.cursor !== undefined) args.push("--cursor", input.cursor);
    return args;
  }
  if (command === "explain-usage-evidence") {
    return [command, "--selector", input.selector];
  }
  throw new TiboTattlePluginError(
    "tibotattle_tool_unsupported",
    "The requested TiboTattle operation is unsupported",
  );
}

export function createInstalledAgentClient({
  platform = process.platform,
  locate = locateInstalledTiboTattle,
  execute = executeInstalledAgent,
} = {}) {
  function platformUnsupported() {
    return platform !== "darwin";
  }

  async function invoke(command, input) {
    if (platformUnsupported()) {
      throw new TiboTattlePluginError(
        "tibotattle_platform_unsupported",
        "The TiboTattle installed agent interface is currently supported on macOS",
      );
    }
    const installation = await locate();
    if (installation === null) {
      throw new TiboTattlePluginError(
        "tibotattle_not_installed",
        "TiboTattle is not installed",
      );
    }
    if (installation.agentScript === null) {
      throw new TiboTattlePluginError(
        "tibotattle_agent_unavailable",
        "The selected TiboTattle installation has no agent interface",
      );
    }
    return parseAgentResult(await execute(installation, commandArgs(command, input)));
  }

  return Object.freeze({
    invoke,
    async status() {
      if (platformUnsupported()) {
        return {
          schemaVersion: PLUGIN_STATUS_SCHEMA_VERSION,
          installation: "unsupported",
          compatibility: "unsupported",
          requiredProtocolVersion: REQUIRED_AGENT_PROTOCOL_VERSION,
          minimumReleaseVersion: MINIMUM_AGENT_RELEASE_VERSION,
          errorCode: "tibotattle_platform_unsupported",
        };
      }
      const installation = await locate();
      if (installation === null) {
        return {
          schemaVersion: PLUGIN_STATUS_SCHEMA_VERSION,
          installation: "absent",
          compatibility: "unavailable",
          requiredProtocolVersion: REQUIRED_AGENT_PROTOCOL_VERSION,
          minimumReleaseVersion: MINIMUM_AGENT_RELEASE_VERSION,
        };
      }
      if (installation.agentScript === null) {
        return {
          schemaVersion: PLUGIN_STATUS_SCHEMA_VERSION,
          installation: "present",
          installationKind: installation.sourceKind,
          compatibility: "incompatible",
          requiredProtocolVersion: REQUIRED_AGENT_PROTOCOL_VERSION,
          minimumReleaseVersion: MINIMUM_AGENT_RELEASE_VERSION,
          releaseVersion: installation.releaseVersion,
          detectedInstallations: installation.detectedInstallations,
          errorCode: "tibotattle_agent_unavailable",
        };
      }
      try {
        const result = parseAgentResult(await execute(installation, ["status"]));
        if (result.schemaVersion !== INSTALLED_STATUS_SCHEMA_VERSION
            || result.protocolVersion !== REQUIRED_AGENT_PROTOCOL_VERSION) {
          throw new TiboTattlePluginError(
            "tibotattle_agent_protocol_incompatible",
            "The installed TiboTattle agent protocol is incompatible",
          );
        }
        return {
          schemaVersion: PLUGIN_STATUS_SCHEMA_VERSION,
          installation: "present",
          installationKind: installation.sourceKind,
          compatibility: "compatible",
          requiredProtocolVersion: REQUIRED_AGENT_PROTOCOL_VERSION,
          minimumReleaseVersion: MINIMUM_AGENT_RELEASE_VERSION,
          releaseVersion: result.releaseVersion,
          detectedInstallations: installation.detectedInstallations,
          dataHealth: result.dataHealth,
        };
      } catch (error) {
        return {
          schemaVersion: PLUGIN_STATUS_SCHEMA_VERSION,
          installation: "present",
          installationKind: installation.sourceKind,
          compatibility: "incompatible",
          requiredProtocolVersion: REQUIRED_AGENT_PROTOCOL_VERSION,
          minimumReleaseVersion: MINIMUM_AGENT_RELEASE_VERSION,
          releaseVersion: installation.releaseVersion,
          detectedInstallations: installation.detectedInstallations,
          errorCode: error instanceof TiboTattlePluginError
            ? error.code
            : "tibotattle_agent_unavailable",
        };
      }
    },
  });
}
