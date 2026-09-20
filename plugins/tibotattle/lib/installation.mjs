import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

import {
  MINIMUM_AGENT_RELEASE_VERSION,
  REQUIRED_AGENT_PROTOCOL_VERSION,
  TiboTattlePluginError,
} from "./installed-agent.mjs";

const execFile = promisify(execFileCallback);

export const INSTALL_PLAN_SCHEMA_VERSION = "tibotattle-install-plan-v1";
export const INSTALL_RECEIPT_SCHEMA_VERSION = "tibotattle-install-receipt-v1";

const LATEST_RELEASE_API =
  "https://api.github.com/repos/adamallcock/tibotattle/releases/latest";
const CASK_SOURCE_URL =
  "https://raw.githubusercontent.com/adamallcock/homebrew-tap/main/Casks/tibotattle.rb";
const MANIFEST_NAME = "release-manifest.json";
const MANIFEST_SCHEMA = "usage-monitor-release-evidence-v1";
const REPOSITORY = "https://github.com/adamallcock/tibotattle";
const MAX_REMOTE_JSON_BYTES = 512 * 1024;
const PLAN_TTL_MS = 10 * 60 * 1000;
const MAX_RETAINED_PLANS = 16;
const CASK = "adamallcock/tap/tibotattle";
const REMOTE_TIMEOUT_MS = 15_000;

function semverTuple(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  return match === null ? null : match.slice(1).map(Number);
}

export function compareReleaseVersions(left, right) {
  const a = semverTuple(left);
  const b = semverTuple(right);
  if (a === null || b === null) {
    throw new TiboTattlePluginError(
      "tibotattle_release_version_invalid",
      "TiboTattle release metadata contains an invalid version",
    );
  }
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

async function readBoundedText(response, maximumBytes, errorCode, unavailableMessage) {
  if (!response?.ok) {
    throw new TiboTattlePluginError(errorCode, unavailableMessage);
  }
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new TiboTattlePluginError(errorCode, "TiboTattle release metadata is too large");
  }
  if (typeof response.body?.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") <= maximumBytes) return text;
    throw new TiboTattlePluginError(errorCode, "TiboTattle release metadata is too large");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel().catch(() => {});
      throw new TiboTattlePluginError(errorCode, "TiboTattle release metadata is too large");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } catch {
    throw new TiboTattlePluginError(errorCode, "TiboTattle release metadata is invalid");
  }
}

async function readBoundedJson(response, errorCode) {
  const text = await readBoundedText(
    response,
    MAX_REMOTE_JSON_BYTES,
    errorCode,
    "TiboTattle release metadata is unavailable",
  );
  try {
    return JSON.parse(text);
  } catch {
    throw new TiboTattlePluginError(errorCode, "TiboTattle release metadata is invalid");
  }
}

async function fetchMetadata(fetchImpl, url, options, errorCode, message) {
  try {
    return await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
  } catch {
    throw new TiboTattlePluginError(errorCode, message);
  }
}

export async function readLatestReleaseManifest({ fetchImpl = fetch } = {}) {
  const releaseResponse = await fetchMetadata(
    fetchImpl,
    LATEST_RELEASE_API,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "tibotattle-codex-plugin/0.1.0",
      },
      redirect: "follow",
    },
    "tibotattle_release_lookup_failed",
    "TiboTattle release metadata is unavailable",
  );
  const release = await readBoundedJson(
    releaseResponse,
    "tibotattle_release_lookup_failed",
  );
  const manifestAsset = Array.isArray(release.assets)
    ? release.assets.find((asset) => asset?.name === MANIFEST_NAME)
    : null;
  if (release.draft === true || release.prerelease === true
      || typeof manifestAsset?.browser_download_url !== "string") {
    throw new TiboTattlePluginError(
      "tibotattle_release_manifest_missing",
      "The latest stable TiboTattle release has no canonical manifest",
    );
  }
  let url;
  try {
    url = new URL(manifestAsset.browser_download_url);
  } catch {
    throw new TiboTattlePluginError(
      "tibotattle_release_manifest_invalid",
      "The TiboTattle release manifest URL is invalid",
    );
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new TiboTattlePluginError(
      "tibotattle_release_manifest_invalid",
      "The TiboTattle release manifest URL is invalid",
    );
  }
  const manifestResponse = await fetchMetadata(
    fetchImpl,
    url,
    { headers: { Accept: "application/json" }, redirect: "follow" },
    "tibotattle_release_manifest_unavailable",
    "The TiboTattle release manifest is unavailable",
  );
  const manifest = await readBoundedJson(
    manifestResponse,
    "tibotattle_release_manifest_unavailable",
  );
  if (manifest?.schemaVersion !== MANIFEST_SCHEMA
      || manifest.repository !== REPOSITORY
      || manifest.version !== release.tag_name?.replace(/^v/u, "")
      || manifest.tag !== release.tag_name
      || semverTuple(manifest.version) === null
      || !/^[0-9a-f]{40}$/u.test(manifest.commit)
      || !Array.isArray(manifest.artifacts)) {
    throw new TiboTattlePluginError(
      "tibotattle_release_manifest_invalid",
      "The TiboTattle release manifest is invalid",
    );
  }
  return manifest;
}

export async function readPublishedCask({ fetchImpl = fetch } = {}) {
  const response = await fetchMetadata(
    fetchImpl,
    CASK_SOURCE_URL,
    { redirect: "follow" },
    "tibotattle_cask_lookup_failed",
    "The published TiboTattle Homebrew cask is unavailable",
  );
  const source = await readBoundedText(
    response,
    64 * 1024,
    "tibotattle_cask_lookup_failed",
    "The published TiboTattle Homebrew cask is unavailable",
  );
  const version = /^\s*version\s+"([^"]+)"\s*$/mu.exec(source)?.[1];
  const hashes = /sha256\s+arm:\s+"([0-9a-f]{64})",\s*intel:\s+"([0-9a-f]{64})"/mu.exec(source);
  if (semverTuple(version) === null || hashes === null) {
    throw new TiboTattlePluginError(
      "tibotattle_cask_invalid",
      "The published TiboTattle Homebrew cask is invalid",
    );
  }
  return { version, sha256: { arm64: hashes[1], x64: hashes[2] } };
}

function targetForRuntime({ platform = process.platform, architecture = process.arch } = {}) {
  if (platform === "darwin" && ["arm64", "x64"].includes(architecture)) {
    return { platform: "macos", architecture, format: "dmg" };
  }
  throw new TiboTattlePluginError(
    "tibotattle_install_platform_unsupported",
    "Automatic TiboTattle installation is currently supported on macOS arm64 and x64",
  );
}

export function selectInstallArtifact(manifest, runtime = {}) {
  if (compareReleaseVersions(manifest.version, MINIMUM_AGENT_RELEASE_VERSION) < 0) {
    throw new TiboTattlePluginError(
      "tibotattle_compatible_release_unavailable",
      `The latest release (${manifest.version}) predates the required agent interface`,
    );
  }
  const target = targetForRuntime(runtime);
  const artifact = manifest.artifacts.find((entry) => (
    entry?.platform === target.platform
    && entry.architecture === target.architecture
    && entry.format === target.format
    && entry.version === manifest.version
    && entry.source?.commit === manifest.commit
    && entry.source?.repository === REPOSITORY
    && typeof entry.fileName === "string"
    && /^[0-9a-f]{64}$/u.test(entry.sha256)
    && Number.isSafeInteger(entry.bytes)
    && entry.bytes > 0
  ));
  if (artifact === undefined) {
    throw new TiboTattlePluginError(
      "tibotattle_compatible_artifact_unavailable",
      "The latest TiboTattle release has no compatible verified artifact",
    );
  }
  return artifact;
}

function verifyCask(cask, plan, architecture) {
  if (cask?.version !== plan.version
      || cask?.sha256?.[architecture] !== plan.artifactSha256) {
    throw new TiboTattlePluginError(
      "tibotattle_cask_release_mismatch",
      "The Homebrew cask does not match the confirmed TiboTattle release",
    );
  }
}

async function runBrew(args) {
  return execFile("brew", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024,
    timeout: 10 * 60 * 1000,
  });
}

export function createInstallationController({
  client,
  clock = Date.now,
  fetchManifest = readLatestReleaseManifest,
  fetchCask = readPublishedCask,
  tokenBytes = () => randomBytes(24).toString("hex"),
  brew = runBrew,
  platform = process.platform,
  architecture = process.arch,
} = {}) {
  if (client === undefined) throw new TypeError("client is required");
  const plans = new Map();

  return Object.freeze({
    async plan() {
      targetForRuntime({ platform, architecture });
      const installed = await client.status();
      const manifest = await fetchManifest();
      if (installed.compatibility === "compatible"
          && compareReleaseVersions(installed.releaseVersion, MINIMUM_AGENT_RELEASE_VERSION) >= 0
          && compareReleaseVersions(installed.releaseVersion, manifest.version) >= 0) {
        return {
          schemaVersion: INSTALL_PLAN_SCHEMA_VERSION,
          status: "not_required",
          reason: installed.releaseVersion === manifest.version
            ? "latest_compatible_installation_present"
            : "installed_release_is_newer",
          installed,
        };
      }
      const artifact = selectInstallArtifact(manifest, { platform, architecture });
      const token = tokenBytes();
      if (typeof token !== "string" || token.length < 32 || token.length > 128) {
        throw new TiboTattlePluginError(
          "tibotattle_install_plan_failed",
          "TiboTattle could not create a safe install confirmation",
        );
      }
      const expiresAtMs = clock() + PLAN_TTL_MS;
      const plan = {
        action: installed.installation === "absent" ? "install" : "upgrade",
        version: manifest.version,
        sourceCommit: manifest.commit,
        artifactFileName: artifact.fileName,
        artifactBytes: artifact.bytes,
        artifactSha256: artifact.sha256,
        target: "macos_applications",
      };
      verifyCask(await fetchCask(), plan, architecture);
      for (const [retainedToken, retained] of plans) {
        if (retained.expiresAtMs < clock()) plans.delete(retainedToken);
      }
      while (plans.size >= MAX_RETAINED_PLANS) {
        plans.delete(plans.keys().next().value);
      }
      plans.set(token, { expiresAtMs, plan });
      return {
        schemaVersion: INSTALL_PLAN_SCHEMA_VERSION,
        status: "confirmation_required",
        requiredProtocolVersion: REQUIRED_AGENT_PROTOCOL_VERSION,
        minimumReleaseVersion: MINIMUM_AGENT_RELEASE_VERSION,
        ...plan,
        confirmationToken: token,
        expiresAtMs,
      };
    },

    async install({ confirmationToken } = {}) {
      if (typeof confirmationToken !== "string" || !plans.has(confirmationToken)) {
        throw new TiboTattlePluginError(
          "tibotattle_install_confirmation_invalid",
          "The install confirmation is invalid or has already been used",
        );
      }
      const approved = plans.get(confirmationToken);
      plans.delete(confirmationToken);
      if (approved.expiresAtMs < clock()) {
        throw new TiboTattlePluginError(
          "tibotattle_install_confirmation_expired",
          "The install confirmation has expired; prepare a new plan",
        );
      }
      verifyCask(await fetchCask(), approved.plan, architecture);
      const args = approved.plan.action === "install"
        ? ["install", "--cask", CASK]
        : ["upgrade", "--cask", CASK];
      try {
        await brew(args);
      } catch {
        throw new TiboTattlePluginError(
          "tibotattle_homebrew_install_failed",
          "Homebrew could not install the confirmed TiboTattle release",
        );
      }
      const installed = await client.status();
      if (installed.compatibility !== "compatible"
          || installed.releaseVersion !== approved.plan.version) {
        throw new TiboTattlePluginError(
          "tibotattle_install_verification_failed",
          "The installed TiboTattle app does not match the confirmed release",
        );
      }
      return {
        schemaVersion: INSTALL_RECEIPT_SCHEMA_VERSION,
        status: "installed",
        action: approved.plan.action,
        version: approved.plan.version,
        sourceCommit: approved.plan.sourceCommit,
        artifactSha256: approved.plan.artifactSha256,
        protocolVersion: REQUIRED_AGENT_PROTOCOL_VERSION,
      };
    },
  });
}
