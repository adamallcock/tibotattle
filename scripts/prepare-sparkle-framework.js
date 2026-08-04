#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SPARKLE_ARCHIVE_SHA256,
  SPARKLE_ARCHIVE_URL,
  SPARKLE_LICENSE_SHA256,
  SPARKLE_UPSTREAM_LICENSE_SHA256,
  SPARKLE_VERSION,
  SPARKLE_TOOL_FILES,
  SPARKLE_TOOLS_DIRECTORY_NAME,
  inspectPinnedSparkleFramework,
  inspectPinnedSparkleTools,
} from "./macos-updater-core.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");

function fail(message) {
  throw new Error(message);
}

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--output") {
    fail("--output /absolute/path/Sparkle.framework is required");
  }
  const output = resolve(argv[1]);
  if (basename(output) !== "Sparkle.framework") {
    fail("Output must end in Sparkle.framework");
  }
  const parent = dirname(output);
  await mkdir(parent, { recursive: true, mode: 0o755 });
  const parentPath = await realpath(parent);
  return Object.freeze({
    output: join(parentPath, basename(output)),
    toolsOutput: join(parentPath, SPARKLE_TOOLS_DIRECTORY_NAME),
  });
}

async function downloadArchive(destination) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(SPARKLE_ARCHIVE_URL, {
      headers: {
        "User-Agent": "UsageMonitor-Sparkle-Dependency-Preparation/1",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      fail(`Sparkle download failed with HTTP ${response.status}`);
    }
    const maximumBytes = 32 * 1024 * 1024;
    const advertisedBytes = Number(response.headers.get("content-length"));
    if (Number.isFinite(advertisedBytes)
        && (advertisedBytes < 1 || advertisedBytes > maximumBytes)) {
      fail("Sparkle download has an unsafe advertised size");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1 || bytes.length > maximumBytes) {
      fail("Sparkle download has an unsafe size");
    }
    if (createHash("sha256").update(bytes).digest("hex")
        !== SPARKLE_ARCHIVE_SHA256) {
      fail("Downloaded Sparkle archive failed its pinned SHA-256 check");
    }
    await writeFile(destination, bytes, { flag: "wx", mode: 0o400 });
  } catch (error) {
    if (error?.name === "AbortError") {
      fail("Sparkle download timed out after 120 seconds");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function main(argv) {
  const { output, toolsOutput } = await parseArguments(argv);
  const repositoryLicense = join(
    REPOSITORY_ROOT,
    "third_party_licenses",
    `sparkle-${SPARKLE_VERSION}.txt`,
  );
  if (await digest(repositoryLicense) !== SPARKLE_LICENSE_SHA256) {
    fail("Sparkle license notice does not match the pinned release");
  }

  let frameworkReady = false;
  try {
    await lstat(output);
    frameworkReady = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (frameworkReady) {
    await inspectPinnedSparkleFramework(output);
  }

  let toolsReady = false;
  try {
    await lstat(toolsOutput);
    toolsReady = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (toolsReady) {
    await inspectPinnedSparkleTools(toolsOutput);
  }

  if (frameworkReady && toolsReady) {
    const framework = await inspectPinnedSparkleFramework(output);
    const tools = await inspectPinnedSparkleTools(toolsOutput);
    console.log(`Sparkle ${framework.version}: verified and reused`);
    console.log(`Framework: ${output}`);
    console.log(`Framework SHA-256: ${framework.sha256}`);
    console.log(`Tools: ${tools.path}`);
    for (const tool of tools.tools) {
      console.log(`${tool.name} SHA-256: ${tool.sha256}`);
    }
    console.log(`Archive SHA-256: ${SPARKLE_ARCHIVE_SHA256}`);
    return;
  }

  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "usage-monitor-sparkle-"),
  );
  try {
    const archive = join(temporaryRoot, `Sparkle-${SPARKLE_VERSION}.tar.xz`);
    const extraction = join(temporaryRoot, "extracted");
    await mkdir(extraction, { mode: 0o700 });
    await downloadArchive(archive);
    const members = [];
    if (!frameworkReady) {
      members.push("./Sparkle.framework", "./LICENSE");
    }
    if (!toolsReady) {
      members.push(
        ...Object.values(SPARKLE_TOOL_FILES).map((tool) => tool.archivePath),
      );
    }
    const extracted = spawnSync("/usr/bin/tar", [
      "-xJf",
      archive,
      "-C",
      extraction,
      ...members,
    ], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      timeout: 120_000,
    });
    if (extracted.error || extracted.status !== 0) {
      fail(
        `Sparkle extraction failed: ${
          extracted.error?.message || extracted.stderr || "unknown failure"
        }`,
      );
    }

    if (!frameworkReady) {
      if (await digest(join(extraction, "LICENSE"))
          !== SPARKLE_UPSTREAM_LICENSE_SHA256) {
        fail("Sparkle upstream license notice does not match the pinned release");
      }
      const framework = join(extraction, "Sparkle.framework");
      const inspection = await inspectPinnedSparkleFramework(framework);
      await rename(framework, output);
      console.log(`Sparkle ${inspection.version}: framework prepared`);
      console.log(`Framework: ${output}`);
      console.log(`Framework SHA-256: ${inspection.sha256}`);
    }

    if (!toolsReady) {
      const toolsStage = join(temporaryRoot, SPARKLE_TOOLS_DIRECTORY_NAME);
      await mkdir(toolsStage, { mode: 0o700 });
      for (const [name, tool] of Object.entries(SPARKLE_TOOL_FILES)) {
        await rename(
          join(extraction, tool.archivePath.slice(2)),
          join(toolsStage, name),
        );
      }
      const inspection = await inspectPinnedSparkleTools(toolsStage);
      await rename(toolsStage, toolsOutput);
      console.log(`Sparkle ${inspection.version}: appcast tools prepared`);
      console.log(`Tools: ${toolsOutput}`);
      for (const tool of inspection.tools) {
        console.log(`${tool.name} SHA-256: ${tool.sha256}`);
      }
    }

    console.log(`Archive SHA-256: ${SPARKLE_ARCHIVE_SHA256}`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`prepare-sparkle-framework: ${error.message}`);
    process.exitCode = 1;
  });
}
