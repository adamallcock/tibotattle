import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Resolve through the actual Cloud SQL parent, not an unrelated hoisted glob.
const require = createRequire(import.meta.url);
const connector = createRequire(require.resolve("@google-cloud/cloud-sql-connector"));
const sql = createRequire(connector.resolve("@google-cloud/sql"));
const gax = createRequire(sql.resolve("google-gax"));
const rimrafRequire = createRequire(gax.resolve("rimraf"));
const { rimraf, rimrafSync } = gax("rimraf");
const { glob, globSync, globStream } = rimrafRequire("glob");
const globRequire = createRequire(rimrafRequire.resolve("glob"));
const { Minimatch } = globRequire("minimatch");

async function fixture(work) {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-gcp-glob-"));
  try {
    await mkdir(join(root, "nested"));
    await mkdir(join(root, "nested", "deep"));
    for (const name of ["a.tmp", ".hidden.tmp", "keep.txt", "nested/b.tmp", "nested/keep.tmp", "nested/deep/c.txt"]) {
      await writeFile(join(root, name), "synthetic");
    }
    await work(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("GCP parent resolves fixed glob and minimatch with both named deletion APIs", () => {
  assert.equal(rimrafRequire("glob/package.json").version, "14.0.3");
  assert.equal(globRequire("minimatch/package.json").version, "11.0.3");
  for (const fn of [rimraf, rimrafSync, glob, globSync, globStream, Minimatch]) {
    assert.equal(typeof fn, "function");
  }
});

for (const synchronous of [false, true]) {
  test(`GCP parent preserves ${synchronous ? "sync" : "async"} glob selection and deletion boundaries`, async () => {
    await fixture(async (root) => {
      const options = { cwd: root, dot: true, nodir: true, ignore: ["nested/keep.tmp"] };
      const selected = synchronous ? globSync("**/*.tmp", options) : await glob("**/*.tmp", options);
      assert.deepEqual(selected.sort(), [".hidden.tmp", "a.tmp", "nested/b.tmp"]);
      const removed = synchronous
        ? rimrafSync("**/*.tmp", { glob: options })
        : await rimraf("**/*.tmp", { glob: options });
      assert.equal(removed, true);
      assert.deepEqual((await readdir(root)).sort(), ["keep.txt", "nested"]);
      assert.deepEqual((await readdir(join(root, "nested"))).sort(), ["deep", "keep.tmp"]);
      assert.equal(await readFile(join(root, "nested", "deep", "c.txt"), "utf8"), "synthetic");
      assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "synthetic");
    });
  });
}

for (const stream of [false, true]) {
  test(`GCP glob ${stream ? "stream" : "promise"} cancellation stops recursive directory reads`, { timeout: 5000 }, async () => {
    await fixture(async (root) => {
      const controller = new AbortController();
      const reason = new Error("synthetic-glob-cancellation");
      let reads = 0, pending = 0, settle;
      const drained = () => {
        if (pending === 0) queueMicrotask(() => { if (pending === 0) settle?.(); });
      };
      const instrumented = {
        ...fs,
        readdir(path, options, callback) {
          reads += 1;
          pending += 1;
          fs.readdir(path, options, (error, entries) => {
            if (!controller.signal.aborted) controller.abort(reason);
            try { callback(error, entries); }
            finally { pending -= 1; drained(); }
          });
        },
      };
      const options = { cwd: root, signal: controller.signal, fs: instrumented };
      const walk = stream
        ? (async () => { for await (const _ of globStream("**/*", options)) { /* drain to refusal */ } })()
        : glob("**/*", options);
      await assert.rejects(walk, (error) => error === reason);
      await new Promise((resolve) => { settle = resolve; drained(); });
      assert.equal(reads, 1, "an aborted first directory read must not start descendant reads");
      assert.equal(await readFile(join(root, "nested", "deep", "c.txt"), "utf8"), "synthetic");
    });
  });
}

test("GCP parent refuses a pre-cancelled glob deletion without deleting files", async () => {
  await fixture(async (root) => {
    const controller = new AbortController();
    const reason = new Error("synthetic-pre-cancelled-delete");
    controller.abort(reason);
    await assert.rejects(rimraf("**/*", { glob: { cwd: root, dot: true, signal: controller.signal } }),
      (error) => error === reason);
    assert.equal(await readFile(join(root, "a.tmp"), "utf8"), "synthetic");
    assert.equal(await readFile(join(root, "nested", "deep", "c.txt"), "utf8"), "synthetic");
  });
});

test("GCP minimatch bounds preprocessing amplification and preserves ordinary parent traversal", () => {
  const amplified = Array(8).fill("**/../a/b").join("/");
  const bounded = new Minimatch(amplified, { optimizationLevel: 2, braceExpandMax: 64 });
  assert.ok(bounded.set.length > 0 && bounded.set.length <= 64);
  const ordinary = new Minimatch("**/../a/b/**/../c/d", { optimizationLevel: 2 });
  assert.equal(ordinary.set.length, 4);
  assert.equal(ordinary.match("../a/b/../c/d"), true);
  assert.equal(ordinary.match("x/a/b/y/c/d"), true);
  assert.equal(ordinary.match("x/a/b/y/c/e"), false);
});
