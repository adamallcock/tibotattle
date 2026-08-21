import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const NATIVE_WINDOWS = process.platform === "win32" && process.arch === "x64";
const NATIVE_SKIP = NATIVE_WINDOWS ? false : "native Windows x64 only";
const requireNative = createRequire(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const QUALIFICATION_BINDING_ENVIRONMENT =
  "TIBOTATTLE_WINDOWS_QUALIFICATION_BINDING_PATH";
const QUALIFICATION_BINDING_FILE = "windows_filesystem_qualification.node";
const MAXIMUM_PREPARED_ARTIFACT_BYTES = 34 * 1024 * 1024;
const CONTRIBUTION_BYTES = 1_310_720;

function qualificationBindingPath() {
  const configured = process.env[QUALIFICATION_BINDING_ENVIRONMENT];
  if (!NATIVE_WINDOWS) {
    return resolve(
      REPOSITORY_ROOT,
      "native",
      "windows-filesystem",
      "build",
      "Release",
      QUALIFICATION_BINDING_FILE,
    );
  }
  if (typeof configured !== "string"
      || !win32.isAbsolute(configured)
      || win32.basename(configured).toLowerCase()
        !== QUALIFICATION_BINDING_FILE.toLowerCase()) {
    throw new Error("WINDOWS_PREPARED_QUALIFICATION_BINDING_PATH_INVALID");
  }
  return configured;
}

function loadBinding() {
  const binding = requireNative(qualificationBindingPath());
  const required = [
    "inspectPath",
    "ensureDirectory",
    "inspectPreparedChild",
    "ensurePreparedDirectory",
    "enumeratePreparedDirectory",
    "removePreparedDirectory",
    "renamePreparedDirectory",
    "createPreparedFile",
    "readPreparedFile",
    "deletePreparedFile",
    "publishPreparedFile",
  ];
  assert.equal(
    required.every((method) => typeof binding?.[method] === "function"),
    true,
    "qualification binding must expose the prepared-artifact surface",
  );
  assert.equal(binding.preparedArtifactContractVersion, "windows-prepared-artifact-v1");
  assert.equal(binding.preparedArtifactSafe, false);
  return binding;
}

function nativeFailure(code) {
  return (error) => error?.code === `WINDOWS_FILESYSTEM_${code}`
    && error?.message === "Windows filesystem operation failed";
}

async function withPreparedRoot(run) {
  const parent = await mkdtemp(join(tmpdir(), "tibotattle-windows-prepared-"));
  const root = join(parent, `private-state-${randomUUID()}`);
  const binding = loadBinding();
  try {
    binding.ensureDirectory(root);
    const rootIdentity = binding.inspectPath(root).identity;
    await run({ binding, root, rootIdentity, parent });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function startCrashChild({ bindingPath, root, rootIdentity, stagePath }) {
  const child = spawn(process.execPath, [
    "-e",
    `
      const binding = require(process.argv[1]);
      const root = process.argv[2];
      const rootIdentity = JSON.parse(process.argv[3]);
      const stagePath = process.argv[4];
      try {
        const identity = binding.createPreparedFile(
          root,
          rootIdentity,
          stagePath,
          Buffer.alloc(${CONTRIBUTION_BYTES}, 0x5a),
        );
        process.stdout.write(JSON.stringify(identity) + "\\n");
        process.stdin.resume();
      } catch (error) {
        process.stdout.write("ERROR:" + String(error?.code || "UNKNOWN") + "\\n");
        process.exit(2);
      }
    `,
    bindingPath,
    root,
    JSON.stringify(rootIdentity),
    stagePath,
  ], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  let output = "";
  child.stdout.setEncoding("utf8");
  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill();
      rejectReady(new Error("WINDOWS_PREPARED_CRASH_CHILD_TIMEOUT"));
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("\n")) {
        clearTimeout(timer);
        resolveReady(JSON.parse(output.trim()));
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectReady(error);
    });
  });
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return { child, ready, exit };
}

function runPublishChild({ bindingPath, root, rootIdentity, stagePath, stageIdentity, targetPath }) {
  const child = spawn(process.execPath, [
    "-e",
    `
      const binding = require(process.argv[1]);
      try {
        const result = binding.publishPreparedFile(
          process.argv[2],
          JSON.parse(process.argv[3]),
          process.argv[4],
          JSON.parse(process.argv[5]),
          process.argv[6],
        );
        process.stdout.write("OK:" + JSON.stringify(result) + "\\n");
      } catch (error) {
        process.stdout.write("ERROR:" + String(error?.code || "UNKNOWN") + "\\n");
      }
    `,
    bindingPath,
    root,
    JSON.stringify(rootIdentity),
    stagePath,
    JSON.stringify(stageIdentity),
    targetPath,
  ], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  let output = "";
  child.stdout.setEncoding("utf8");
  const result = new Promise((resolveResult, rejectResult) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill();
      rejectResult(new Error("WINDOWS_PREPARED_PUBLISH_CHILD_TIMEOUT"));
    }, 15_000);
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectResult(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveResult({ code, output: output.trim() });
    });
  });
  return result;
}

test("prepared native surface handles bounded contribution publication and cleanup", {
  skip: NATIVE_SKIP,
}, async () => {
  await withPreparedRoot(async ({ binding, root, rootIdentity }) => {
    const preparedIdentity = binding.ensurePreparedDirectory(
      root,
      rootIdentity,
      "prepared\\2026-08-18",
    );
    assert.deepEqual(binding.enumeratePreparedDirectory(
      root,
      rootIdentity,
      "prepared\\2026-08-18",
      8,
    ), []);
    const bytes = Buffer.alloc(CONTRIBUTION_BYTES, 0x5a);
    const stageIdentity = binding.createPreparedFile(
      root,
      rootIdentity,
      "prepared\\2026-08-18\\stage.bin",
      bytes,
    );
    const read = binding.readPreparedFile(
      root,
      rootIdentity,
      "prepared\\2026-08-18\\stage.bin",
      CONTRIBUTION_BYTES,
    );
    assert.equal(read.data.byteLength, CONTRIBUTION_BYTES);
    assert.equal(read.data[0], 0x5a);
    assert.deepEqual(read.identity, stageIdentity);
    const published = binding.publishPreparedFile(
      root,
      rootIdentity,
      "prepared\\2026-08-18\\stage.bin",
      stageIdentity,
      "prepared\\2026-08-18\\published.bin",
    );
    assert.deepEqual(published.identity, stageIdentity);
    assert.throws(
      () => binding.publishPreparedFile(
        root,
        rootIdentity,
        "prepared\\2026-08-18\\published.bin",
        stageIdentity,
        "prepared\\2026-08-18\\published.bin",
      ),
      nativeFailure("ALREADY_EXISTS"),
    );
    const publishedRead = binding.readPreparedFile(
      root,
      rootIdentity,
      "prepared\\2026-08-18\\published.bin",
      CONTRIBUTION_BYTES,
    );
    assert.deepEqual(publishedRead.identity, stageIdentity);
    assert.deepEqual(binding.deletePreparedFile(
      root,
      rootIdentity,
      "prepared\\2026-08-18\\published.bin",
      stageIdentity,
    ).identity, stageIdentity);
    const removedDirectory = binding.removePreparedDirectory(
      root,
      rootIdentity,
      "prepared\\2026-08-18",
      preparedIdentity,
    );
    assert.deepEqual(removedDirectory.identity, preparedIdentity);
    assert.deepEqual(binding.removePreparedDirectory(
      root,
      rootIdentity,
      "prepared",
      binding.inspectPreparedChild(root, rootIdentity, "prepared").identity,
    ).removed, true);
  });
});

test("prepared native surface rejects unsafe names and size ceilings", {
  skip: NATIVE_SKIP,
}, async () => {
  await withPreparedRoot(async ({ binding, root, rootIdentity }) => {
    for (const unsafe of [
      "C:\\outside",
      "\\\\server\\share",
      "..\\escape",
      "prepared\\..\\escape",
      "CON",
      "prepared\\NUL.txt",
    ]) {
      assert.throws(
        () => binding.ensurePreparedDirectory(root, rootIdentity, unsafe),
        nativeFailure("INVALID_PATH"),
        unsafe,
      );
    }
    assert.throws(
      () => binding.createPreparedFile(
        root,
        rootIdentity,
        "prepared\\too-large.bin",
        Buffer.alloc(MAXIMUM_PREPARED_ARTIFACT_BYTES + 1),
      ),
      nativeFailure("INVALID_CONFIGURATION"),
    );
    assert.throws(
      () => binding.readPreparedFile(
        root,
        rootIdentity,
        "prepared\\missing.bin",
        MAXIMUM_PREPARED_ARTIFACT_BYTES + 1,
      ),
      nativeFailure("INVALID_CONFIGURATION"),
    );
  });
});

test("prepared native publication is recoverable after a child crash and no-clobber race", {
  skip: NATIVE_SKIP,
}, async () => {
  await withPreparedRoot(async ({ binding, root, rootIdentity }) => {
    const bindingPath = qualificationBindingPath();
    binding.ensurePreparedDirectory(root, rootIdentity, "prepared");
    const crashChild = startCrashChild({
      bindingPath,
      root,
      rootIdentity,
      stagePath: "prepared\\crash.bin",
    });
    const crashedIdentity = await crashChild.ready;
    crashChild.child.kill();
    const crashExit = await crashChild.exit;
    assert.notEqual(crashExit.code, 0);
    assert.deepEqual(binding.deletePreparedFile(
      root,
      rootIdentity,
      "prepared\\crash.bin",
      crashedIdentity,
    ).identity, crashedIdentity);

    binding.ensurePreparedDirectory(root, rootIdentity, "race");
    const first = binding.createPreparedFile(
      root,
      rootIdentity,
      "race\\first.bin",
      Buffer.from("first"),
    );
    const second = binding.createPreparedFile(
      root,
      rootIdentity,
      "race\\second.bin",
      Buffer.from("second"),
    );
    const [left, right] = await Promise.all([
      runPublishChild({
        bindingPath,
        root,
        rootIdentity,
        stagePath: "race\\first.bin",
        stageIdentity: first,
        targetPath: "race\\result.bin",
      }),
      runPublishChild({
        bindingPath,
        root,
        rootIdentity,
        stagePath: "race\\second.bin",
        stageIdentity: second,
        targetPath: "race\\result.bin",
      }),
    ]);
    const outputs = [left.output, right.output];
    assert.equal(outputs.filter((output) => output.startsWith("OK:")).length, 1);
    const errors = outputs.filter((output) => output.startsWith("ERROR:"));
    assert.equal(errors.length, 1);
    assert.equal(
      new Set([
        "ERROR:WINDOWS_FILESYSTEM_ALREADY_EXISTS",
        "ERROR:WINDOWS_FILESYSTEM_ACCESS_DENIED",
      ]).has(errors[0]),
      true,
    );
    const winner = binding.inspectPreparedChild(root, rootIdentity, "race\\result.bin");
    assert.equal(winner.isRegularFile, true);
    for (const [name, identity] of [["race\\first.bin", first], ["race\\second.bin", second]]) {
      try {
        binding.deletePreparedFile(root, rootIdentity, name, identity);
      } catch (error) {
        assert.equal(error?.code, "WINDOWS_FILESYSTEM_NOT_FOUND");
      }
    }
    binding.deletePreparedFile(root, rootIdentity, "race\\result.bin", winner.identity);
    const raceIdentity = binding.inspectPreparedChild(root, rootIdentity, "race").identity;
    binding.removePreparedDirectory(root, rootIdentity, "race", raceIdentity);
  });
});
