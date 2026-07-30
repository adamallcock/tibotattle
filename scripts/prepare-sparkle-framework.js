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
  inspectPinnedSparkleFramework,
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
  return join(await realpath(parent), basename(output));
}

async function downloadArchive(destination) {
  const response = await fetch(SPARKLE_ARCHIVE_URL, {
    headers: {
      "User-Agent": "UsageMonitor-Sparkle-Dependency-Preparation/1",
    },
    redirect: "follow",
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
}

async function main(argv) {
  const output = await parseArguments(argv);
  let existing = false;
  try {
    await lstat(output);
    existing = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing) {
    const inspection = await inspectPinnedSparkleFramework(output);
    if (await digest(join(
      REPOSITORY_ROOT,
      "third_party_licenses",
      `sparkle-${SPARKLE_VERSION}.txt`,
    )) !== SPARKLE_LICENSE_SHA256) {
      fail("Sparkle license notice does not match the pinned release");
    }
    console.log(`Sparkle ${inspection.version}: verified and reused`);
    console.log(`Output: ${output}`);
    console.log(`Framework SHA-256: ${inspection.sha256}`);
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
    const extracted = spawnSync("/usr/bin/tar", [
      "-xJf",
      archive,
      "-C",
      extraction,
      "./Sparkle.framework",
      "./LICENSE",
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
    if (await digest(join(extraction, "LICENSE"))
        !== SPARKLE_UPSTREAM_LICENSE_SHA256
      || await digest(join(
        REPOSITORY_ROOT,
        "third_party_licenses",
        `sparkle-${SPARKLE_VERSION}.txt`,
      )) !== SPARKLE_LICENSE_SHA256) {
      fail("Sparkle license notice does not match the pinned release");
    }
    const framework = join(extraction, "Sparkle.framework");
    const inspection = await inspectPinnedSparkleFramework(framework);
    await rename(framework, output);
    console.log(`Sparkle ${inspection.version}: prepared`);
    console.log(`Output: ${output}`);
    console.log(`Framework SHA-256: ${inspection.sha256}`);
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
