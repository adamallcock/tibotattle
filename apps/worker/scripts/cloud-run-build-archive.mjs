#!/usr/bin/env node

/**
 * Create the exact gzipped tar source archive used by the private Cloud Run
 * build. The archived tree comes only from cloud-run-build-context.mjs, whose
 * allowlist and source digest are checked before files are read here.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(WORKER_ROOT, "../..");
const CONTEXT_CHECK = resolve(WORKER_ROOT, "scripts/cloud-run-build-context.mjs");
const SOURCE_BUILD_SUBMIT = resolve(WORKER_ROOT, "scripts/cloud-run-source-build-submit.mjs");
const PUBLIC_WEB_ASSETS = resolve(REPOSITORY_ROOT, "apps/web/public");
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_FILE_COUNT = 100_000;
const SOURCE_DIGEST_MARKER = "apps/worker/cloud-run/source-content-digest.txt";
const BUILD_CONFIG_MEMBER = "apps/worker/cloud-run/cloudbuild.yaml";

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function writeString(header, value, offset, length) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) fail("CLOUD_RUN_ARCHIVE_PATH_TOO_LONG");
  bytes.copy(header, offset);
}

function writeOctal(header, value, offset, length) {
  const rendered = value.toString(8).padStart(length - 1, "0");
  if (rendered.length > length - 1) fail("CLOUD_RUN_ARCHIVE_FIELD_TOO_LARGE");
  writeString(header, rendered, offset, length);
  header[offset + length - 1] = 0;
}

function splitUstarPath(path) {
  const bytes = Buffer.byteLength(path, "utf8");
  if (bytes <= 100) return { name: path, prefix: "" };
  const segments = path.split("/");
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const prefix = segments.slice(0, index).join("/");
    const name = segments.slice(index).join("/");
    if (Buffer.byteLength(prefix, "utf8") <= 155
        && Buffer.byteLength(name, "utf8") <= 100) {
      return { name, prefix };
    }
  }
  fail("CLOUD_RUN_ARCHIVE_PATH_TOO_LONG");
}

function makeTarHeader(path, stat, size) {
  const { name, prefix } = splitUstarPath(path);
  const header = Buffer.alloc(512);
  writeString(header, name, 0, 100);
  writeOctal(header, stat.mode & 0o7777, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, size, 124, 12);
  writeOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, "ustar\0", 257, 6);
  writeString(header, "00", 263, 2);
  writeString(header, prefix, 345, 155);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const rendered = checksum.toString(8).padStart(6, "0");
  writeString(header, rendered, 148, 6);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

async function collectContextFiles(contextRoot, relativePath = "") {
  const directory = join(contextRoot, relativePath);
  const names = (await readdir(directory)).sort();
  const files = [];
  for (const name of names) {
    const member = relativePath === "" ? name : join(relativePath, name);
    const path = join(contextRoot, member);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) fail("CLOUD_RUN_ARCHIVE_CONTEXT_UNSAFE");
    if (stat.isDirectory()) {
      files.push(...await collectContextFiles(contextRoot, member));
    } else if (stat.isFile() && stat.nlink === 1 && stat.size <= MAX_FILE_BYTES) {
      files.push({ path, member, stat });
    } else {
      fail("CLOUD_RUN_ARCHIVE_CONTEXT_UNSAFE");
    }
    if (files.length > MAX_FILE_COUNT) fail("CLOUD_RUN_ARCHIVE_TOO_MANY_FILES");
  }
  return files;
}

async function createTar(contextRoot) {
  const files = await collectContextFiles(contextRoot);
  files.sort((left, right) => left.member.localeCompare(right.member));
  const blocks = [];
  const sourceHash = createHash("sha256");
  let cloudBuildConfigBytes = null;
  let uncompressedBytes = 1024;
  for (const file of files) {
    let handle;
    let bytes;
    try {
      handle = await open(file.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const openedStat = await handle.stat();
      if (!openedStat.isFile() || openedStat.nlink !== 1
          || openedStat.dev !== file.stat.dev || openedStat.ino !== file.stat.ino
          || openedStat.size !== file.stat.size || openedStat.size > MAX_FILE_BYTES) {
        fail("CLOUD_RUN_ARCHIVE_CONTEXT_CHANGED");
      }
      bytes = await handle.readFile();
    } catch (error) {
      if (error?.code === "CLOUD_RUN_ARCHIVE_CONTEXT_CHANGED") throw error;
      fail("CLOUD_RUN_ARCHIVE_CONTEXT_CHANGED");
    } finally {
      await handle?.close().catch(() => {});
    }
    if (bytes.length !== file.stat.size) fail("CLOUD_RUN_ARCHIVE_CONTEXT_CHANGED");
    const member = file.member.split(sep).join("/");
    if (member === BUILD_CONFIG_MEMBER) cloudBuildConfigBytes = Buffer.from(bytes);
    if (member !== SOURCE_DIGEST_MARKER) {
      sourceHash.update(member);
      sourceHash.update(Buffer.from([0]));
      sourceHash.update(bytes);
    }
    blocks.push(makeTarHeader(member, file.stat, bytes.length));
    blocks.push(bytes);
    const padding = (512 - (bytes.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
    uncompressedBytes += 512 + bytes.length + padding;
    if (uncompressedBytes > MAX_ARCHIVE_BYTES) fail("CLOUD_RUN_ARCHIVE_TOO_LARGE");
  }
  if (cloudBuildConfigBytes === null) fail("CLOUD_RUN_ARCHIVE_BUILD_CONFIG_MISSING");
  blocks.push(Buffer.alloc(1024));
  const cloudBuildConfigSha256 =
    createHash("sha256").update(cloudBuildConfigBytes).digest("hex");
  return {
    bytes: gzipSync(Buffer.concat(blocks), { level: 9, mtime: 0 }),
    fileCount: files.length,
    sourceContentDigest: sourceHash.digest("hex"),
    cloudBuildConfigBytes,
    cloudBuildConfigSha256,
  };
}

function parseContextReceipt(stdout) {
  let receipt;
  try {
    receipt = JSON.parse(stdout);
  } catch {
    fail("CLOUD_RUN_ARCHIVE_CONTEXT_RECEIPT_INVALID");
  }
  if (receipt?.status !== "ok" || receipt?.mode !== "create"
      || !/^[a-f0-9]{64}$/u.test(receipt?.sourceContentDigest ?? "")) {
    fail("CLOUD_RUN_ARCHIVE_CONTEXT_RECEIPT_INVALID");
  }
  return receipt;
}

/** Return a reproducible tar.gz buffer whose context digest was checked. */
export async function createCloudRunBuildArchive({
  spawn = spawnSync,
} = {}) {
  const scratch = await mkdtemp(join(tmpdir(), "tibotattle-cloud-run-source-"));
  const contextRoot = join(scratch, "context");
  try {
    const created = spawn(process.execPath, [
      CONTEXT_CHECK,
      `--output=${contextRoot}`,
      `--assets=${PUBLIC_WEB_ASSETS}`,
    ], {
      cwd: WORKER_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    if (created.status !== 0) fail("CLOUD_RUN_ARCHIVE_CONTEXT_CREATE_FAILED");
    const receipt = parseContextReceipt(created.stdout);
    const marker = (await readFile(join(contextRoot, SOURCE_DIGEST_MARKER), "utf8"))
      .trim();
    if (marker !== receipt.sourceContentDigest) fail("CLOUD_RUN_ARCHIVE_CONTEXT_DIGEST_MISMATCH");
    const archive = await createTar(contextRoot);
    if (archive.sourceContentDigest !== receipt.sourceContentDigest) {
      fail("CLOUD_RUN_ARCHIVE_SOURCE_CONTENT_DIGEST_MISMATCH");
    }
    if (archive.bytes.length === 0 || archive.bytes.length > MAX_ARCHIVE_BYTES) {
      fail("CLOUD_RUN_ARCHIVE_TOO_LARGE");
    }
    const archiveSha256 = createHash("sha256").update(archive.bytes).digest("hex");
    return Object.freeze({
      bytes: archive.bytes,
      fileCount: archive.fileCount,
      sourceContentDigest: receipt.sourceContentDigest,
      sourceArchiveSha256: archiveSha256,
      cloudBuildConfigBytes: archive.cloudBuildConfigBytes,
      cloudBuildConfigSha256: archive.cloudBuildConfigSha256,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * CLI for producing the archive that must be uploaded and submitted unchanged.
 * GCS upload uses a create-only generation precondition; the returned object
 * name is deterministic and tied to both the validated context and archive.
 * The local Cloud Build config sidecar is copied from the exact tar member;
 * the source-only submit helper checks it before calling the regional REST API.
 */
export async function writeCloudRunBuildArchive({ outputPath } = {}) {
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    fail("CLOUD_RUN_ARCHIVE_OUTPUT_REQUIRED");
  }
  const output = resolve(outputPath);
  const archive = await createCloudRunBuildArchive();
  const buildConfigPath = output + ".cloudbuild.yaml";
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, archive.bytes, { flag: "wx", mode: 0o600 });
  await writeFile(buildConfigPath, archive.cloudBuildConfigBytes, { flag: "wx", mode: 0o600 });
  const sourceObject =
    `source/cloud-run-host-${archive.sourceContentDigest}-${archive.sourceArchiveSha256}.tar.gz`;
  const sourceUri = `gs://tibotattle-gcs-test-build-20260922/${sourceObject}`;
  return Object.freeze({
    status: "ok",
    mode: "create",
    output,
    fileCount: archive.fileCount,
    sourceContentDigest: archive.sourceContentDigest,
    sourceArchiveSha256: archive.sourceArchiveSha256,
    buildConfigPath,
    buildConfigSha256: archive.cloudBuildConfigSha256,
    suggestedSourceBucket: "tibotattle-gcs-test-build-20260922",
    suggestedSourceObject: sourceObject,
    uploadArgs: Object.freeze([
      "gcloud", "storage", "cp", output, sourceUri,
      "--project=tibotattle", "--if-generation-match=0",
    ]),
    generationReadbackArgs: Object.freeze([
      "gcloud", "storage", "objects", "describe", sourceUri,
      "--project=tibotattle", "--format=value(generation)",
    ]),
    sourceBuildSubmitArgs: Object.freeze([
      process.execPath,
      SOURCE_BUILD_SUBMIT,
      "--archive=" + output,
      "--archive-sha256=" + archive.sourceArchiveSha256,
      "--source-digest=" + archive.sourceContentDigest,
      "--source-bucket=tibotattle-gcs-test-build-20260922",
      "--source-object=" + sourceObject,
      "--source-generation=<storage-object-generation-readback>",
      "--build-config=" + buildConfigPath,
      "--build-config-sha256=" + archive.cloudBuildConfigSha256,
    ]),
    buildDescribeArgsTemplate: Object.freeze([
      "gcloud", "builds", "describe", "<BUILD_ID_FROM_SUBMIT>",
      "--project=tibotattle", "--region=us-east1", "--format=json",
    ]),
    gateArgumentContract: Object.freeze([
      "--project=tibotattle",
      "--region=us-east1",
      "--service=tibotattle-test-app",
      "--image=us-east1-docker.pkg.dev/tibotattle/tibotattle-test/tibotattle-host@sha256:<results.images[0].digest>",
      `--source-digest=${archive.sourceContentDigest}`,
      `--source-archive=${output}`,
      `--source-archive-sha256=${archive.sourceArchiveSha256}`,
      "--source-bucket=tibotattle-gcs-test-build-20260922",
      `--source-object=${sourceObject}`,
      "--source-generation=<storage-object-generation-readback>",
      "--build-id=<build-id-returned-by-submit>",
    ]),
  });
}

function parseArgs(argv) {
  let outputPath = "";
  for (const argument of argv) {
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator < 3
        || argument.slice(0, separator) !== "--output" || outputPath !== "") {
      fail("CLOUD_RUN_ARCHIVE_ARGUMENT_INVALID");
    }
    outputPath = argument.slice(separator + 1);
  }
  if (outputPath.length === 0) fail("CLOUD_RUN_ARCHIVE_OUTPUT_REQUIRED");
  return { outputPath };
}

async function main() {
  try {
    const result = await writeCloudRunBuildArchive(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      status: "error",
      code: typeof error?.code === "string" ? error.code : "CLOUD_RUN_ARCHIVE_FAILED",
    }));
    process.exitCode = 1;
  }
}

if (process.argv[1]
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
