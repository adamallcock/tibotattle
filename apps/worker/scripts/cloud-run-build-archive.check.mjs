import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import {
  createCloudRunBuildArchive,
  writeCloudRunBuildArchive,
} from "./cloud-run-build-archive.mjs";

function digestFromTar(bytes) {
  const hash = createHash("sha256");
  let cloudBuildConfigBytes = null;
  let maintenanceGateBytes = null;
  let publicIndexBytes = null;
  let publicAppBytes = null;
  let offset = 0;
  let count = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const decode = (field) => field.toString("utf8").replace(/\0.*$/su, "").trim();
    const name = decode(header.subarray(0, 100));
    const prefix = decode(header.subarray(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(decode(header.subarray(124, 136)), 8);
    assert.equal(Number.isSafeInteger(size) && size >= 0, true);
    const start = offset + 512;
    const content = bytes.subarray(start, start + size);
    assert.equal(content.length, size);
    if (path === "apps/worker/cloud-run/cloudbuild.yaml") {
      cloudBuildConfigBytes = Buffer.from(content);
    }
    if (path === "apps/worker/cloud-run/postgres-maintenance-gate.mjs") {
      maintenanceGateBytes = Buffer.from(content);
    }
    if (path === "apps/worker/cloud-run/assets/index.html") {
      publicIndexBytes = Buffer.from(content);
    }
    if (path === "apps/worker/cloud-run/assets/app.js") {
      publicAppBytes = Buffer.from(content);
    }
    if (path !== "apps/worker/cloud-run/source-content-digest.txt") {
      hash.update(path);
      hash.update(Buffer.from([0]));
      hash.update(content);
    }
    const padding = (512 - (size % 512)) % 512;
    offset = start + size + padding;
    count += 1;
  }
  return {
    digest: hash.digest("hex"),
    count,
    cloudBuildConfigBytes,
    maintenanceGateBytes,
    publicIndexBytes,
    publicAppBytes,
  };
}

test("archive helper proves digest from tar members and returns shell-safe argument vectors", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "cloud-run-archive-check-"));
  const hostileName = "archive ; $(touch SHOULD_NOT_RUN).tar.gz";
  const outputPath = join(scratch, hostileName);
  try {
    const receipt = await writeCloudRunBuildArchive({ outputPath });
    const archiveBytes = await readFile(outputPath);
    const tar = gunzipSync(archiveBytes);
    const members = digestFromTar(tar);
    assert.equal(receipt.status, "ok");
    assert.equal(receipt.sourceContentDigest, members.digest);
    assert.equal(receipt.fileCount, members.count);
    assert.equal(receipt.sourceArchiveSha256,
      createHash("sha256").update(archiveBytes).digest("hex"));
    assert.equal(Buffer.isBuffer(members.cloudBuildConfigBytes), true);
    const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const serverSource = readFileSync(join(workerRoot, "cloud-run/server.mjs"), "utf8");
    assert.match(serverSource,
      /from\s+["']\.\/postgres-maintenance-gate\.mjs["']/u);
    assert.deepEqual(members.maintenanceGateBytes,
      readFileSync(join(workerRoot, "cloud-run/postgres-maintenance-gate.mjs")));
    assert.deepEqual(members.publicIndexBytes,
      readFileSync(join(workerRoot, "../web/public/index.html")));
    assert.deepEqual(members.publicAppBytes,
      readFileSync(join(workerRoot, "../web/public/app.js")));
    assert.equal(receipt.buildConfigSha256,
      createHash("sha256").update(members.cloudBuildConfigBytes).digest("hex"));
    assert.equal(receipt.buildConfigPath, outputPath + ".cloudbuild.yaml");
    assert.deepEqual(await readFile(receipt.buildConfigPath), members.cloudBuildConfigBytes);
    assert.equal(receipt.uploadCommand, undefined);
    assert.equal(receipt.uploadArgs[0], "gcloud");
    assert.equal(receipt.uploadArgs[3], outputPath);
    assert.equal(receipt.uploadArgs.at(-1), "--if-generation-match=0");
    assert.equal(receipt.uploadArgs.includes(outputPath), true);
    assert.equal(receipt.generationReadbackArgs[0], "gcloud");
    assert.equal(receipt.buildSubmitArgs, undefined);
    assert.equal(receipt.sourceBuildSubmitArgs[0], process.execPath);
    assert.match(receipt.sourceBuildSubmitArgs[1], /cloud-run-source-build-submit\.mjs$/u);
    assert.equal(receipt.sourceBuildSubmitArgs.includes("--archive=" + outputPath), true);
    assert.equal(receipt.sourceBuildSubmitArgs.includes("--archive-sha256=" + receipt.sourceArchiveSha256), true);
    assert.equal(receipt.sourceBuildSubmitArgs.includes("--source-digest=" + receipt.sourceContentDigest), true);
    assert.equal(receipt.sourceBuildSubmitArgs.includes("--source-bucket=" + receipt.suggestedSourceBucket), true);
    assert.equal(receipt.sourceBuildSubmitArgs.includes("--source-object=" + receipt.suggestedSourceObject), true);
    assert.equal(receipt.sourceBuildSubmitArgs.includes("--source-generation=<storage-object-generation-readback>"), true);
    assert.equal(receipt.sourceBuildSubmitArgs.includes("--build-config=" + receipt.buildConfigPath), true);
    assert.equal(receipt.sourceBuildSubmitArgs.includes("--build-config-sha256=" + receipt.buildConfigSha256), true);
    assert.equal(receipt.gateArgumentContract.some((value) => value.startsWith("--source-generation=")), true);
    assert.equal(receipt.gateArgumentContract.some((value) => value.startsWith("--build-id=")), true);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("archive helper rejects a same-size staged source mutation after context receipt", async () => {
  const mutatingSpawn = (command, args, options) => {
    const result = spawnSync(command, args, options);
    if (result.status === 0) {
      const outputArgument = args.find((argument) => argument.startsWith("--output="));
      assert.equal(typeof outputArgument, "string");
      const context = outputArgument.slice("--output=".length);
      const path = join(context, "apps/worker/cloud-run/Dockerfile");
      const original = readFileSync(path);
      assert.equal(original.length > 0, true);
      const changed = Buffer.from(original);
      changed[0] = changed[0] === 0x58 ? 0x59 : 0x58;
      writeFileSync(path, changed);
      assert.equal(changed.length, original.length);
    }
    return result;
  };
  await assert.rejects(
    createCloudRunBuildArchive({ spawn: mutatingSpawn }),
    (error) => error.code === "CLOUD_RUN_ARCHIVE_SOURCE_CONTENT_DIGEST_MISMATCH",
  );
});
