import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { durablePrivateJson, identityDigest, openOperation, readOperation } from "../scripts/lib/release-operation.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "release-operation-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory: join(root, "operation"), kind: "native", binding: { source: "synthetic", architecture: "arm64" } };
}

test("operation binds canonical inputs and preserves isolated durable state", async (t) => {
  const f = await fixture(t);
  assert.equal(identityDigest({ b: 2, a: { y: 1, x: 3 } }), identityDigest({ a: { x: 3, y: 1 }, b: 2 }));
  const operation = await openOperation(f);
  try {
    await operation.save({ phase: "prepared" });
    operation.record.state.phase = "not saved";
    assert.equal((await readOperation(f.directory)).state.phase, "prepared");
    assert.equal((await lstat(f.directory)).mode & 0o777, 0o700);
    for (const name of ["operation.json", "mutex.sqlite"]) assert.equal((await lstat(join(f.directory, name))).mode & 0o777, 0o600);
    assert.equal((await readFile(join(f.directory, "operation.json"), "utf8")).includes('"source":"synthetic"'), false);
  } finally { operation.close(); }
  await assert.rejects(openOperation(f), { code: "RELEASE_OPERATION_EXISTS_USE_RESUME" });
  await assert.rejects(openOperation({ ...f, resume: true, binding: { source: "changed" } }), { code: "RELEASE_OPERATION_INPUT_MISMATCH" });
  await assert.rejects(openOperation({ ...f, resume: true, kind: "production" }), { code: "RELEASE_OPERATION_INPUT_MISMATCH" });
  const resumed = await openOperation({ ...f, resume: true });
  assert.equal(resumed.record.state.phase, "prepared");
  resumed.close();
});

test("operation refuses unsafe directory, symlink journal and hardlink journal", async (t) => {
  const f = await fixture(t);
  await mkdir(f.directory, { mode: 0o755 });
  await chmod(f.directory, 0o755);
  await assert.rejects(openOperation(f), { code: "RELEASE_OPERATION_DIRECTORY_UNSAFE" });
  await chmod(f.directory, 0o700);
  const operation = await openOperation(f);
  operation.close();
  const path = join(f.directory, "operation.json");
  await link(path, join(f.root, "extra-link"));
  await assert.rejects(readOperation(f.directory), { code: "RELEASE_OPERATION_FILE_UNSAFE" });
  await rm(join(f.root, "extra-link"));
  const bytes = await readFile(path);
  await rm(path);
  const foreign = join(f.root, "foreign.json");
  await writeFile(foreign, bytes, { mode: 0o600 });
  await symlink(foreign, path);
  await assert.rejects(readOperation(f.directory), { code: "RELEASE_OPERATION_FILE_UNSAFE" });
  await assert.rejects(durablePrivateJson(path, {}), { code: "RELEASE_OPERATION_FILE_UNSAFE" });
  assert.deepEqual(await readFile(foreign), bytes);
});

test("operation rejects malformed, oversized and nonprivate records", async (t) => {
  const f = await fixture(t);
  const operation = await openOperation(f);
  operation.close();
  const path = join(f.directory, "operation.json");
  const original = await readFile(path);
  await writeFile(path, "{");
  await assert.rejects(readOperation(f.directory), { code: "RELEASE_OPERATION_INVALID" });
  await writeFile(path, original);
  await chmod(path, 0o644);
  await assert.rejects(readOperation(f.directory), { code: "RELEASE_OPERATION_FILE_UNSAFE" });
  await chmod(path, 0o600);
  await assert.rejects(durablePrivateJson(path, { payload: "x".repeat(1024 * 1024) }), { code: "RELEASE_OPERATION_TOO_LARGE" });
  assert.deepEqual(await readFile(path), original);
  await writeFile(path, "x".repeat(1024 * 1024 + 1));
  await assert.rejects(readOperation(f.directory), { code: "RELEASE_OPERATION_TOO_LARGE" });
});

test("SQLite mutex excludes another process and releases on process death without losing receipt", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const moduleURL = new URL("../scripts/lib/release-operation.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { openOperation } from ${JSON.stringify(moduleURL)};
    const operation = await openOperation(JSON.parse(process.argv[1]));
    await operation.save({ phase: "durable-before-crash" });
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1000);
  `, JSON.stringify(f)], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`mutex child failed to become ready: ${stderr}`)), 8_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("ready\n")) { clearTimeout(timeout); resolve(); } });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", () => { clearTimeout(timeout); reject(new Error(`mutex child exited before ready: ${stderr}`)); });
  });
  await assert.rejects(openOperation({ ...f, resume: true }), { code: "RELEASE_OPERATION_BUSY" });
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const resumed = await openOperation({ ...f, resume: true });
  try { assert.equal(resumed.record.state.phase, "durable-before-crash"); }
  finally { resumed.close(); }
});
